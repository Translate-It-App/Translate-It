import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { build } from 'vite';
import { createBaseConfig } from '../../../../config/vite/vite.config.base.js';
import { validateBuildParity } from './build-environment.mjs';

const flags = {
  legacy: [false, false],
  sliced: [true, false],
  viewport: [true, true],
};

export function createSuccessfulReplyBoundaryPlugin() {
  const schedulerSuffix = '/src/features/page-translation/PageTranslationScheduler.js';
  const importLine = "import { sendRegularMessage, safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';";
  const callLine = "const result = await safeSendMessage(batchMessage, 'page-translation-batch');";
  const transformedModules = new Set();
  return {
    name: 'benchmark-successful-page-reply-boundary',
    enforce: 'pre',
    transform(source, id) {
      const normalizedId = id.split('?')[0].replaceAll('\\', '/');
      if (!normalizedId.endsWith(schedulerSuffix)) return null;
      if (source.split(importLine).length !== 2 || source.split(callLine).length !== 2) {
        throw new Error(`Successful-reply safeSendMessage boundary drifted in ${normalizedId}`);
      }
      if (transformedModules.has(normalizedId)) throw new Error(`Duplicate successful-reply transform for ${normalizedId}`);
      transformedModules.add(normalizedId);
      const interceptedImport = `${importLine.replace('safeSendMessage }', 'safeSendMessage as benchmarkProductionSafeSendMessage }')}
const safeSendMessage = (...args) => {
  const sourcePromise = benchmarkProductionSafeSendMessage(...args);
  const intercept = globalThis.__pageTranslationBenchmark?.interceptSchedulerBatchReply;
  return typeof intercept === 'function'
    ? intercept.call(globalThis.__pageTranslationBenchmark, args[0], sourcePromise)
    : sourcePromise;
};`;
      let transformed = source.replace(importLine, interceptedImport);
      // The call-site token is asserted above to keep this transform pinned to the production await boundary.
      if (!transformed.includes(callLine)) throw new Error(`Safe-send await site was not preserved in ${normalizedId}`);
      return { code: transformed, map: null };
    },
    assertApplied() {
      if (transformedModules.size !== 1) throw new Error(`Expected exactly one PageTranslationScheduler safeSendMessage boundary transform; found ${transformedModules.size}`);
      return [...transformedModules];
    },
  };
}

export async function buildBenchmarkExtension({ outputDir, mode = 'legacy', browser = 'chrome', workerEntry, contentEntry, runtimeBridge, replacementConfig, onBuildEnvironment, successfulReplyGate = false }) {
  if (!flags[mode]) throw new TypeError(`Unknown discovery mode: ${mode}`);
  if (browser !== 'chrome' && browser !== 'firefox') throw new TypeError(`Unknown browser: ${browser}`);
  if (typeof successfulReplyGate !== 'boolean') throw new TypeError('successfulReplyGate must be boolean.');
  if (successfulReplyGate && (browser !== 'chrome' || mode !== 'sliced' || !contentEntry)) {
    throw new TypeError('successfulReplyGate requires the opt-in sliced Chrome content-entry harness build.');
  }
  if (runtimeBridge !== undefined && (browser !== 'firefox' || mode !== 'sliced' || !validBridgeConfig(runtimeBridge))) {
    throw new TypeError('runtimeBridge requires a sliced Firefox build and absolute fixtureUrl, bindingUrl, and reportUrl plus runId and authToken.');
  }
  if (replacementConfig !== undefined && (browser !== 'firefox' || mode !== 'sliced' || !validReplacementConfig(replacementConfig))) {
    throw new TypeError('replacementConfig requires a sliced Firefox build plus runId, authToken, fixtureUrl, and expectedExtensionId.');
  }
  if (replacementConfig !== undefined && runtimeBridge !== undefined) {
    throw new TypeError('Choose either runtimeBridge or replacementConfig for a harness build, not both.');
  }
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)) {
    throw new TypeError('outputDir must be an absolute path to a fresh temporary directory.');
  }
  const outDir = resolve(outputDir);
  const repoRoot = resolve(process.cwd());
  const fromRepo = relative(repoRoot, outDir);
  if (fromRepo === '' || (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !isAbsolute(fromRepo))) {
    throw new TypeError('outputDir must be outside the repository.');
  }
  if (outDir === resolve('/') || outDir === resolve('/tmp')) {
    throw new TypeError('outputDir cannot be a filesystem or temporary-directory root.');
  }
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length) throw new Error(`outputDir must be empty; refusing to clear ${outDir}.`);
  for (const [name, entry] of Object.entries({ workerEntry, contentEntry })) {
    if (entry !== undefined && (typeof entry !== 'string' || !isAbsolute(entry))) {
      throw new TypeError(`${name} must be an absolute file path.`);
    }
  }
  if (onBuildEnvironment !== undefined && typeof onBuildEnvironment !== 'function') throw new TypeError('onBuildEnvironment must be a function when provided.');

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
  const environmentProfiles = { worker: [], content: [] };
  const bridgePlugins = runtimeBridge ? createRuntimeBridgePlugins({ runtimeBridge, workerEntry, contentEntry }) : [];
  const replacementPlugins = replacementConfig ? createReplacementPlugins({ replacementConfig, workerEntry, contentEntry }) : [];
  const firefoxSchedulerBatchPlugin = runtimeBridge?.pageTranslationE2E === true ? createFirefoxSchedulerBatchPlugin() : null;
  const successfulReplyBoundaryPlugin = successfulReplyGate ? createSuccessfulReplyBoundaryPlugin() : null;
  const environmentPlugin = role => ({
    name: `benchmark-build-environment-${role}`,
    configResolved(config) { environmentProfiles[role].push(captureBuildEnvironment(config)); },
  });
  const base = createBaseConfig(browser, { outDir, extraPlugins: [
    {
      name: 'benchmark-discovery-flags',
      transform(source, id) {
        if (!id.endsWith('/PageTranslationConstants.js')) return null;
        const [sliced, viewport] = flags[mode];
        // The production default is irrelevant here: each benchmark mode pins
        // its own discovery flags regardless of the shipped constant values.
        const patterns = [
          [/export const PAGE_TRANSLATION_SLICED_DISCOVERY = (?:true|false);/, `export const PAGE_TRANSLATION_SLICED_DISCOVERY = ${sliced};`],
          [/export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = (?:true|false);/, `export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = ${viewport};`],
        ];
        let transformed = source;
        for (const [pattern, replacement] of patterns) {
          if (!pattern.test(transformed)) throw new Error(`Expected page translation discovery flag missing in ${id}`);
          transformed = transformed.replace(pattern, replacement);
        }
        return transformed;
      },
    },
    {
      name: 'benchmark-worker-css-preload-guard',
      enforce: 'post',
      transform(source) {
        if (!source.includes('function preload(baseModule, deps, importerUrl)')) return null;
        const guarded = source.replace(
          'if (__VITE_IS_MODERN__ && deps && deps.length > 0) {',
          "if (typeof document !== 'undefined' && __VITE_IS_MODERN__ && deps && deps.length > 0) {",
        );
        if (guarded === source) throw new Error('Could not add the worker-safe Vite preload guard.');
        return guarded;
      },
    },
     ...bridgePlugins,
     ...replacementPlugins,
     ...(firefoxSchedulerBatchPlugin ? [firefoxSchedulerBatchPlugin] : []),
  ] });

  const workerOut = resolve(outDir, '.worker-build');
  const contentOut = resolve(outDir, '.content-build');
  const buildEntry = async (role, input, entryOut, codeSplitting) => build({
    ...base,
    mode: 'production',
    base: './',
    plugins: [...base.plugins, environmentPlugin(role), ...(role === 'content' && successfulReplyBoundaryPlugin ? [successfulReplyBoundaryPlugin] : [])],
    configFile: false,
    publicDir: false,
    logLevel: runtimeBridge || replacementConfig ? 'silent' : 'error',
    build: {
      ...base.build,
      outDir: entryOut,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        ...base.build.rollupOptions,
        input,
        output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', codeSplitting },
      },
    },
  });
  try {
    const workerInput = runtimeBridge ? 'virtual:page-translation-probe-worker'
      : replacementConfig ? 'virtual:page-replacement-worker'
      : workerEntry ?? resolve('src/core/background/index.js');
    const contentInput = runtimeBridge ? 'virtual:page-translation-probe-content'
      : replacementConfig ? 'virtual:page-replacement-content'
      : contentEntry ?? resolve('src/core/content-scripts/index-main.js');
    await buildEntry('worker', { worker: workerInput }, workerOut, false);
    await buildEntry('content', { 'content-entry': contentInput }, contentOut, true);
    successfulReplyBoundaryPlugin?.assertApplied();
    firefoxSchedulerBatchPlugin?.assertApplied();
    const environment = { worker: environmentProfiles.worker[0], content: environmentProfiles.content[0] };
    const parity = validateBuildParity([{ mode, status: 'passed', environment }], [mode]);
    if (environmentProfiles.worker.length !== 1 || environmentProfiles.content.length !== 1 || !parity.ok) {
      throw new Error(`Benchmark build environment verification failed: ${parity.issues.join('; ') || 'Missing or repeated resolved configuration evidence.'}`);
    }
    await cp(workerOut, outDir, { recursive: true, force: true });
    await cp(contentOut, outDir, { recursive: true, force: true });
  } catch (error) {
    if (runtimeBridge || replacementConfig) {
      // Opt-in diagnostic: the default stays redacted because build errors can
      // echo bundle source that embeds the harness token.
      if (process.env.HARNESS_BUILD_VERBOSE === '1') {
        const secret = runtimeBridge?.authToken ?? replacementConfig?.authToken;
        const message = secret ? String(error?.message ?? error).split(secret).join('[REDACTED]') : String(error?.message ?? error);
        throw new Error(`Firefox harness build failed: ${message}`);
      }
      throw new Error('Firefox harness build failed; generated configuration details were suppressed.');
    }
    throw error;
  } finally {
    await Promise.all([rm(workerOut, { recursive: true, force: true }), rm(contentOut, { recursive: true, force: true })]);
  }
  const harnessSecret = runtimeBridge?.authToken ?? replacementConfig?.authToken;
  if (harnessSecret) await assertBridgeTokenIsolation(outDir, harnessSecret);
  if (onBuildEnvironment) {
    const environment = { worker: environmentProfiles.worker[0], content: environmentProfiles.content[0] };
    try { await onBuildEnvironment(structuredClone(environment)); }
    catch (error) {
      if (runtimeBridge || replacementConfig) throw new Error('Firefox harness build failed; generated configuration details were suppressed.');
      throw error;
    }
  }
  const manifest = {
    manifest_version: 3,
    name: 'Translate-It page translation benchmark',
    version: '1.0.0',
    background: browser === 'firefox'
      ? { scripts: ['worker.js'], type: 'module' }
      : { service_worker: 'worker.js', type: 'module' },
    permissions: ['storage', 'alarms', 'tabs', 'scripting', 'notifications', 'contextMenus', 'webNavigation'],
    host_permissions: ['http://127.0.0.1/*', 'https://*/*', 'http://*/*'],
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content-loader.js'], run_at: 'document_idle' }],
    commands: {
      'SELECT-ELEMENT-COMMAND': {
        suggested_key: { default: 'Alt+A', mac: 'Alt+Shift+S' },
        description: 'Activate the Select Element mode for translation.',
      },
    },
    web_accessible_resources: [{ resources: ['content-entry.js', 'chunks/*'], matches: ['http://127.0.0.1/*'] }],
  };
  if (browser === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'page-translation-e2e-benchmark@translate-it.test',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const runtime = browser === 'firefox' ? 'browser' : 'chrome';
  await writeFile(resolve(outDir, 'content-loader.js'), `import(${runtime}.runtime.getURL('content-entry.js')).catch(error => console.error('Benchmark content entry failed', error));\n`);
  if (harnessSecret) await assertBridgeTokenIsolation(outDir, harnessSecret);
  return outDir;
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

function captureBuildEnvironment(config) {
  const define = config.define ?? {};
  const compress = config.build?.terserOptions?.compress ?? {};
  return {
    mode: config.mode,
    nodeEnv: process.env.NODE_ENV ?? null,
    browser: parseDefineString(define.__BROWSER__),
    defines: {
      browser: parseDefineString(define.__BROWSER__),
      isProduction: define.__IS_PRODUCTION__,
      isDevelopment: define.__IS_DEVELOPMENT__,
      nodeEnv: parseDefineString(define['process.env.NODE_ENV']),
    },
    build: {
      minify: config.build?.minify ?? null,
      dropConsole: compress.drop_console === true,
      dropDebugger: compress.drop_debugger === true,
      sourcemap: config.build?.sourcemap ?? null,
      cssMinify: config.build?.cssMinify ?? null,
      esbuildDrop: Array.isArray(config.esbuild?.drop) ? [...config.esbuild.drop].sort() : [],
      target: config.build?.target ?? null,
    },
  };
}

function parseDefineString(value) {
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : null; }
  catch { return null; }
}

function validBridgeConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.runId)
      || typeof config.authToken !== 'string' || !/^[a-f\d]{64,}$/i.test(config.authToken)) return false;
  const keys = ['runId', 'fixtureUrl', 'bindingUrl', 'reportUrl', 'authToken', ...(config.providerOnly === true ? ['providerOnly'] : []), ...(config.pageTranslationE2E === true ? ['pageTranslationE2E'] : [])];
  if (config.providerOnly !== undefined && typeof config.providerOnly !== 'boolean') return false;
  if (config.pageTranslationE2E !== undefined && typeof config.pageTranslationE2E !== 'boolean') return false;
  if (config.providerOnly === true && config.pageTranslationE2E === true) return false;
  const actualKeys = Object.keys(config);
  if (actualKeys.length !== keys.length || keys.some(key => !Object.hasOwn(config, key)) || actualKeys.some(key => !keys.includes(key))) return false;
  if (config.runId === config.authToken || JSON.stringify({ runId: config.runId, fixtureUrl: config.fixtureUrl }).includes(config.authToken)) return false;
  const urls = ['fixtureUrl', 'bindingUrl', 'reportUrl'].map(key => parseLoopbackUrl(config[key]));
  if (urls.some(url => !url) || urls.some(url => url.origin !== urls[0].origin)) return false;
  return urls[1].pathname === `/__benchmark/bind/${config.runId}` && urls[1].search === ''
    && urls[2].pathname === '/__benchmark/runtime' && urls[2].search === '';
}

function parseLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}

// Phase 2B page-replacement harness build. The auth token is baked into the
// private worker bundle only; the content bundle receives a token-free config
// and the background brokers every authenticated collector call.
function validReplacementConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.runId)
      || typeof config.authToken !== 'string' || !/^[a-f\d]{64,}$/i.test(config.authToken)
      || typeof config.expectedExtensionId !== 'string' || !config.expectedExtensionId) return false;
  const keys = ['runId', 'authToken', 'fixtureUrl', 'expectedExtensionId', 'expectedTabId', 'expectedDocumentId',
    ...(typeof config.staleSuccess === 'boolean' ? ['staleSuccess'] : [])];
  const actualKeys = Object.keys(config);
  if (actualKeys.length !== keys.length || keys.some(key => !Object.hasOwn(config, key)) || actualKeys.some(key => !keys.includes(key))) return false;
  // The Firefox tab and document identities are unknown at build time; null
  // means "pin once from the first authenticated real sender", never a
  // caller-supplied identity.
  if (config.expectedTabId !== null || config.expectedDocumentId !== null) return false;
  if (config.runId === config.authToken || JSON.stringify({ runId: config.runId, fixtureUrl: config.fixtureUrl, expectedExtensionId: config.expectedExtensionId }).includes(config.authToken)) return false;
  const fixtureUrl = parseLoopbackUrl(config.fixtureUrl);
  return !!fixtureUrl && fixtureUrl.pathname === '/' && fixtureUrl.search === '';
}

// The replacement extension entries auto-start from a config global, so the
// virtual modules only seed the global and await the real entry module.
function createReplacementPlugins({ replacementConfig, workerEntry, contentEntry }) {
  if (!workerEntry || !contentEntry) throw new TypeError('replacementConfig requires explicit replacement workerEntry and contentEntry paths.');
  const workerVirtual = '\0virtual:page-replacement-worker';
  const contentVirtual = '\0virtual:page-replacement-content';
  // Phase 2C: staleSuccess is opt-in; when absent the Phase 2B build is
  // byte-identical to before.
  const staleSuccess = replacementConfig.staleSuccess === true ? { staleSuccess: true } : {};
  const workerCode = `globalThis.__firefoxPageTranslationReplacementConfig = ${JSON.stringify({
    runId: replacementConfig.runId, authToken: replacementConfig.authToken, fixtureUrl: replacementConfig.fixtureUrl,
    expectedExtensionId: replacementConfig.expectedExtensionId, expectedTabId: null, expectedDocumentId: null,
    ...staleSuccess,
  })};
await import(${JSON.stringify(resolve(workerEntry))});
`;
  // Discovery flags are read from the same bundled constants the page's
  // content code observes, after the build's flag transform, so the emitted
  // evidence reflects the actual shipped values instead of build-time intent.
  const constantsEntry = resolve('src/features/page-translation/PageTranslationConstants.js');
  const contentCode = `globalThis.__firefoxPageTranslationReplacementConfig = ${JSON.stringify({
    runId: replacementConfig.runId, fixtureUrl: replacementConfig.fixtureUrl, expectedExtensionId: replacementConfig.expectedExtensionId,
    expectedTabId: null, expectedDocumentId: null,
    ...staleSuccess,
  })};
try {
  const constants = await import(${JSON.stringify(constantsEntry)});
  globalThis.__firefoxPageTranslationReplacementFlags = {
    slicedDiscoveryEnabled: constants.PAGE_TRANSLATION_SLICED_DISCOVERY === true,
    viewportFirstDiscoveryEnabled: constants.PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY === true,
  };
} catch (error) { console.error('Replacement discovery-flag evidence failed', error); }
await import(${JSON.stringify(resolve(contentEntry))});
`;
  return [{
    name: 'firefox-page-replacement-harness',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:page-replacement-worker') return workerVirtual;
      if (id === 'virtual:page-replacement-content') return contentVirtual;
      return null;
    },
    load(id) {
      if (id === workerVirtual) return workerCode;
      if (id === contentVirtual) return contentCode;
      return null;
    },
  }];
}

function createRuntimeBridgePlugins({ runtimeBridge, workerEntry, contentEntry }) {
  if (!workerEntry || !contentEntry) throw new TypeError('runtimeBridge requires explicit instrumented workerEntry and contentEntry paths.');
  const backgroundRuntime = resolve('scripts/dev/page-translation/e2e-firefox/runtime-background.mjs');
  const contentRuntime = resolve('scripts/dev/page-translation/e2e-firefox/runtime-content.mjs');
  const workerVirtual = '\0virtual:page-translation-probe-worker';
  const contentVirtual = '\0virtual:page-translation-probe-content';
  const workerCode = `import { installBackgroundProbe } from ${JSON.stringify(backgroundRuntime)};\nawait installBackgroundProbe(${JSON.stringify(runtimeBridge)}, () => import(${JSON.stringify(resolve(workerEntry))}));\n`;
  const contentCode = `import { installContentProbe } from ${JSON.stringify(contentRuntime)};\nawait installContentProbe(${JSON.stringify({ runId: runtimeBridge.runId, fixtureUrl: runtimeBridge.fixtureUrl, providerOnly: runtimeBridge.providerOnly === true, pageTranslationE2E: runtimeBridge.pageTranslationE2E === true })}, () => import(${JSON.stringify(resolve(contentEntry))}));\n`;
  return [{
    name: 'firefox-runtime-bridge',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:page-translation-probe-worker') return workerVirtual;
      if (id === 'virtual:page-translation-probe-content') return contentVirtual;
      return null;
    },
    load(id) {
      if (id === workerVirtual) return workerCode;
      if (id === contentVirtual) return contentCode;
      return null;
    },
    transform(source, id) {
      if (id.endsWith('/src/core/background/index.js')) return transformBackgroundStartup(source, id);
      if (id.endsWith('/src/core/content-scripts/index-main.js')) return transformContentStartup(source, id);
      if (id.endsWith('/src/shared/proxy/ProxyManager.js')) return transformFirefoxProviderFetch(source, id);
      if (id.endsWith('/scripts/dev/page-translation/e2e-benchmark/content-entry.mjs')) return transformProviderContentEntry(source, id);
      return null;
    },
  }];
}

function createFirefoxSchedulerBatchPlugin() {
  const schedulerSuffix = '/src/features/page-translation/PageTranslationScheduler.js';
  const importLine = "import { sendRegularMessage, safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';";
  const callLine = "const result = await safeSendMessage(batchMessage, 'page-translation-batch');";
  let transformed = false;
  return {
    name: 'firefox-page-translation-scheduler-batch-evidence',
    enforce: 'pre',
    transform(source, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith(schedulerSuffix)) return null;
      if (transformed || source.split(importLine).length !== 2 || source.split(callLine).length !== 2) {
        throw new Error(`Firefox Scheduler batch evidence boundary drifted in ${id}`);
      }
      transformed = true;
      const imported = `${importLine.replace('safeSendMessage }', 'safeSendMessage as benchmarkProductionSafeSendMessage }')}\nconst safeSendMessage = async (...args) => {
  const captured = globalThis.__pageTranslationBenchmark?.captureSchedulerBatch?.(args[0]);
  if (captured && typeof captured.then === 'function') await captured;
  else if (captured !== true) throw new Error('Firefox Scheduler batch evidence was not authenticated.');
  return benchmarkProductionSafeSendMessage(...args);
};`;
      return { code: source.replace(importLine, imported), map: null };
    },
    assertApplied() {
      if (!transformed) throw new Error('Firefox page-translation Scheduler batch evidence transform was not applied.');
    },
  };
}

function transformProviderContentEntry(source, id) {
  const site = 'window.__pageTranslationBenchmark = trace;';
  if (source.split(site).length !== 2) throw new Error(`Firefox content provider instrumentation drifted in ${id}`);
  return source.replace(site, `if (window.__firefoxProviderProbeEnabled === true) {
  trace.installProviderProbe = async (report, fixtureUrl) => {
    const { installContentProviderProbe } = await import('./provider-probe-content.mjs');
    const handler = FeatureManager.getInstance().getFeatureHandler('contentMessageHandler');
    return installContentProviderProbe({ handler, report, fixtureUrl });
  };
}
${site}`);
}

function transformFirefoxProviderFetch(source, id) {
  const site = `if (!this.isEnabled(config)) {
      this.logger.debug('Proxy disabled, using direct fetch');
      return fetch(url, options);
    }`;
  if (source.split(site).length !== 2) throw new Error(`Firefox provider fetch instrumentation drifted in ${id}`);
  return source.replace(site, `if (!this.isEnabled(config)) {
      this.logger.debug('Proxy disabled, using direct fetch');
      const directFetchPromise = fetch(url, options);
      try { globalThis.__pageTranslationBenchmark?.providerProbe?.observeDirectFetch(url, options, directFetchPromise, true); } catch { /* observer must not affect the actual native fetch */ }
      return directFetchPromise;
    }`);
}

function transformBackgroundStartup(source, id) {
  const call = `initializeBackgroundService(backgroundService, postInitializeBackgroundService, {
  shouldRetry: error => !ExtensionContextManager.isContextError(error),
})`;
  if (source.split(call).length !== 2) throw new Error(`Firefox probe startup instrumentation drifted in ${id}`);
  return source.replace(call, `(()=>{
  const startup = ${call};
  globalThis.__firefoxProbeStartup = { complete: false, success: false };
  startup.then(() => { globalThis.__firefoxProbeStartup = { complete: true, success: true }; }, () => { globalThis.__firefoxProbeStartup = { complete: true, success: false }; });
  return startup;
})()`);
}

function transformContentStartup(source, id) {
  const success = 'const initialized = await initializeContentCore(contentScriptCore);';
  const innerFailure = "scriptLogger.error('Failed to initialize ContentScriptCore instance:', error);";
  const outerFailure = "errorLogger.error('Critical initialization error:', error);";
  for (const site of [success, innerFailure, outerFailure]) {
    if (source.split(site).length !== 2) throw new Error(`Firefox probe startup instrumentation drifted in ${id}`);
  }
  return source
    .replace(success, `${success}\n      window.__firefoxProbeStartup = { complete: true, success: initialized === true };`)
    .replace(innerFailure, `window.__firefoxProbeStartup = { complete: true, success: false };\n      ${innerFailure}`)
    .replace(outerFailure, `window.__firefoxProbeStartup = { complete: true, success: false };\n    ${outerFailure}`);
}

async function assertBridgeTokenIsolation(outDir, secret) {
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await visit(resolve(directory, entry.name), relativePath));
      else files.push(relativePath);
    }
    return files;
  };
  for (const file of await visit(outDir)) {
    const content = await readFile(resolve(outDir, file), 'utf8').catch(() => '');
    if (file === 'worker.js' && !content.includes(secret)) {
      throw new Error('Runtime bridge report credential is missing from the private worker bundle.');
    }
    if (file !== 'worker.js' && content.includes(secret)) {
      throw new Error('Runtime bridge secret escaped the private worker bundle.');
    }
  }
}

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { build } from 'vite';
import { createBaseConfig } from '../../../config/vite/vite.config.base.js';

const flags = {
  legacy: [false, false],
  sliced: [true, false],
  viewport: [true, true],
};

export async function buildBenchmarkExtension({ outputDir, mode = 'legacy', browser = 'chrome', workerEntry, contentEntry, runtimeBridge }) {
  if (!flags[mode]) throw new TypeError(`Unknown discovery mode: ${mode}`);
  if (browser !== 'chrome' && browser !== 'firefox') throw new TypeError(`Unknown browser: ${browser}`);
  if (runtimeBridge !== undefined && (browser !== 'firefox' || mode !== 'sliced' || !validBridgeConfig(runtimeBridge))) {
    throw new TypeError('runtimeBridge requires a sliced Firefox build and absolute fixtureUrl, bindingUrl, and reportUrl plus runId and authToken.');
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
  const bridgePlugins = runtimeBridge ? createRuntimeBridgePlugins({ runtimeBridge, workerEntry, contentEntry }) : [];
  const base = createBaseConfig(browser, { outDir, extraPlugins: [
    {
      name: 'benchmark-discovery-flags',
      transform(source, id) {
        if (!id.endsWith('/PageTranslationConstants.js')) return null;
        const [sliced, viewport] = flags[mode];
        const patterns = [
          [/export const PAGE_TRANSLATION_SLICED_DISCOVERY = false;/, `export const PAGE_TRANSLATION_SLICED_DISCOVERY = ${sliced};`],
          [/export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = false;/, `export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = ${viewport};`],
        ];
        let transformed = source;
        for (const [pattern, replacement] of patterns) {
          if (!pattern.test(transformed)) throw new Error(`Expected default-off page translation flag missing in ${id}`);
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
  ] });

  const workerOut = resolve(outDir, '.worker-build');
  const contentOut = resolve(outDir, '.content-build');
  const buildEntry = async (input, entryOut, codeSplitting) => build({
    ...base,
    base: './',
    configFile: false,
    publicDir: false,
    logLevel: runtimeBridge ? 'silent' : 'error',
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
    await buildEntry({ worker: runtimeBridge ? 'virtual:page-translation-probe-worker' : workerEntry ?? resolve('src/core/background/index.js') }, workerOut, false);
    await buildEntry({ 'content-entry': runtimeBridge ? 'virtual:page-translation-probe-content' : contentEntry ?? resolve('src/core/content-scripts/index-main.js') }, contentOut, true);
    await cp(workerOut, outDir, { recursive: true, force: true });
    await cp(contentOut, outDir, { recursive: true, force: true });
  } catch (error) {
    if (runtimeBridge) throw new Error('Firefox runtime bridge build failed; generated configuration details were suppressed.');
    throw error;
  } finally {
    await Promise.all([rm(workerOut, { recursive: true, force: true }), rm(contentOut, { recursive: true, force: true })]);
  }
  if (runtimeBridge) await assertBridgeTokenIsolation(outDir, runtimeBridge.authToken);
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
  if (runtimeBridge) await assertBridgeTokenIsolation(outDir, runtimeBridge.authToken);
  return outDir;
}

function validBridgeConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.runId)
      || typeof config.authToken !== 'string' || !/^[a-f\d]{64,}$/i.test(config.authToken)) return false;
  const keys = ['runId', 'fixtureUrl', 'bindingUrl', 'reportUrl', 'authToken'];
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

function createRuntimeBridgePlugins({ runtimeBridge, workerEntry, contentEntry }) {
  if (!workerEntry || !contentEntry) throw new TypeError('runtimeBridge requires explicit instrumented workerEntry and contentEntry paths.');
  const backgroundRuntime = resolve('scripts/dev/page-translation-e2e-firefox/runtime-background.mjs');
  const contentRuntime = resolve('scripts/dev/page-translation-e2e-firefox/runtime-content.mjs');
  const workerVirtual = '\0virtual:page-translation-probe-worker';
  const contentVirtual = '\0virtual:page-translation-probe-content';
  const workerCode = `import { installBackgroundProbe } from ${JSON.stringify(backgroundRuntime)};\nawait installBackgroundProbe(${JSON.stringify(runtimeBridge)}, () => import(${JSON.stringify(resolve(workerEntry))}));\n`;
  const contentCode = `import { installContentProbe } from ${JSON.stringify(contentRuntime)};\nawait installContentProbe(${JSON.stringify({ runId: runtimeBridge.runId, fixtureUrl: runtimeBridge.fixtureUrl })}, () => import(${JSON.stringify(resolve(contentEntry))}));\n`;
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
      return null;
    },
  }];
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

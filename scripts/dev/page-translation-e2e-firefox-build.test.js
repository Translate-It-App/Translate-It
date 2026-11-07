import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { buildConfigs, baseConfigs, buildFailure } = vi.hoisted(() => ({ buildConfigs: [], baseConfigs: [], buildFailure: { value: null } }));

vi.mock('vite', () => ({
  build: vi.fn(async config => {
    if (buildFailure.value) throw new Error(buildFailure.value);
    buildConfigs.push(config);
    await mkdir(config.build.outDir, { recursive: true });
    const [name] = Object.keys(config.build.rollupOptions.input);
    const virtualEntry = config.build.rollupOptions.input[name];
    const virtualPlugin = config.plugins?.find(plugin => plugin.name === 'firefox-runtime-bridge');
    const bridgeSource = virtualEntry === 'virtual:page-translation-probe-worker'
      ? virtualPlugin?.load('\0virtual:page-translation-probe-worker')
      : virtualEntry === 'virtual:page-translation-probe-content'
        ? virtualPlugin?.load('\0virtual:page-translation-probe-content') : null;
    await writeFile(resolve(config.build.outDir, `${name}.js`), bridgeSource ?? `// ${name}`);
  }),
}));

vi.mock('../../config/vite/vite.config.base.js', () => ({
  createBaseConfig: vi.fn((browser, options) => {
    baseConfigs.push({ browser, options });
    return { build: { rollupOptions: {} }, plugins: options.extraPlugins };
  }),
}));

import { buildBenchmarkExtension } from './page-translation-e2e-benchmark/build.mjs';

const directories = [];
async function freshOutputDir() {
  const path = await mkdtemp(resolve(tmpdir(), 'page-translation-build-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  buildConfigs.length = 0;
  baseConfigs.length = 0;
  buildFailure.value = null;
});

describe('page translation benchmark build browser support', () => {
  it('keeps the default Chrome build output and production entrypoints', async () => {
    const outputDir = await freshOutputDir();
    const workerEntry = resolve('src/core/background/index.js');
    const contentEntry = resolve('src/core/content-scripts/index-main.js');

    await buildBenchmarkExtension({ outputDir, workerEntry, contentEntry });

    expect(baseConfigs[0].browser).toBe('chrome');
    expect(buildConfigs.map(config => config.build.rollupOptions.input)).toEqual([
      { worker: workerEntry }, { 'content-entry': contentEntry },
    ]);
    expect(JSON.parse(await readFile(resolve(outputDir, 'manifest.json'), 'utf8')).background)
      .toEqual({ service_worker: 'worker.js', type: 'module' });
    expect(await readFile(resolve(outputDir, 'content-loader.js'), 'utf8'))
      .toContain("chrome.runtime.getURL('content-entry.js')");
  });

  it('builds Firefox MV3 background, capability metadata, and browser runtime loader', async () => {
    const outputDir = await freshOutputDir();
    const workerEntry = resolve('scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs');
    const contentEntry = resolve('scripts/dev/page-translation-e2e-benchmark/content-entry.mjs');

    await buildBenchmarkExtension({ browser: 'firefox', mode: 'sliced', outputDir, workerEntry, contentEntry });

    expect(baseConfigs[0].browser).toBe('firefox');
    expect(buildConfigs.map(config => config.build.rollupOptions.input)).toEqual([
      { worker: workerEntry }, { 'content-entry': contentEntry },
    ]);
    const manifest = JSON.parse(await readFile(resolve(outputDir, 'manifest.json'), 'utf8'));
    expect(manifest.background).toEqual({ scripts: ['worker.js'], type: 'module' });
    expect(manifest.browser_specific_settings.gecko).toEqual({
      id: 'page-translation-e2e-benchmark@translate-it.test',
      strict_min_version: '142.0',
      data_collection_permissions: { required: ['none'] },
    });
    expect(await readFile(resolve(outputDir, 'content-loader.js'), 'utf8'))
      .toContain("browser.runtime.getURL('content-entry.js')");
    expect(await readFile(resolve(outputDir, 'worker.js'), 'utf8')).toBe('// worker');
    expect(await readFile(resolve(outputDir, 'content-entry.js'), 'utf8')).toBe('// content-entry');
    const constantsPath = resolve('src/features/page-translation/PageTranslationConstants.js');
    const original = await readFile(constantsPath, 'utf8');
    const transformed = baseConfigs[0].options.extraPlugins[0].transform(original, constantsPath);
    expect(transformed).toContain('PAGE_TRANSLATION_SLICED_DISCOVERY = true;');
    expect(transformed).toContain('PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = false;');
    expect(await readFile(constantsPath, 'utf8')).toBe(original);
  });

  it('transforms only the in-memory discovery flags, leaving source unchanged', async () => {
    const outputDir = await freshOutputDir();
    const constantsPath = resolve('src/features/page-translation/PageTranslationConstants.js');
    const originalFile = await readFile(constantsPath, 'utf8');

    await buildBenchmarkExtension({ outputDir, mode: 'viewport' });

    const transform = baseConfigs[0].options.extraPlugins[0].transform;
    expect(transform(originalFile, constantsPath)).toContain('PAGE_TRANSLATION_SLICED_DISCOVERY = true;');
    expect(transform(originalFile, constantsPath)).toContain('PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = true;');
    expect(await readFile(constantsPath, 'utf8')).toBe(originalFile);
  });

  it('keeps bridge report credentials in worker output and public content config secret-free', async () => {
    const outputDir = await freshOutputDir();
    const bridge = {
      runId: 'run-123', fixtureUrl: 'http://127.0.0.1:4321/fixture',
      bindingUrl: 'http://127.0.0.1:4321/__benchmark/bind/run-123',
      reportUrl: 'http://127.0.0.1:4321/__benchmark/runtime', authToken: 'a'.repeat(64),
    };
    await buildBenchmarkExtension({ browser: 'firefox', mode: 'sliced', outputDir, workerEntry: resolve('scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs'), contentEntry: resolve('scripts/dev/page-translation-e2e-benchmark/content-entry.mjs'), runtimeBridge: bridge });
    const plugin = baseConfigs[0].options.extraPlugins.find(item => item.name === 'firefox-runtime-bridge');
    const workerSource = plugin.load('\0virtual:page-translation-probe-worker');
    const contentSource = plugin.load('\0virtual:page-translation-probe-content');
    expect(workerSource).toContain(bridge.authToken);
    expect(workerSource).not.toContain('privateToken');
    expect(contentSource).toContain(bridge.fixtureUrl);
    expect(contentSource).not.toContain(bridge.authToken);
    expect(contentSource).not.toContain('privateToken');
    expect(await readFile(resolve(outputDir, 'content-loader.js'), 'utf8')).not.toContain(bridge.authToken);
    const emittedWorker = await readFile(resolve(outputDir, 'worker.js'), 'utf8');
    const emittedContent = await readFile(resolve(outputDir, 'content-entry.js'), 'utf8');
    expect(emittedWorker).toContain(bridge.authToken);
    expect(emittedContent).not.toContain(bridge.authToken);
    const backgroundPath = resolve('src/core/background/index.js');
    const backgroundOriginal = await readFile(backgroundPath, 'utf8');
    const backgroundTransformed = plugin.transform(backgroundOriginal, backgroundPath);
    expect(backgroundTransformed).toContain('const startup = initializeBackgroundService(backgroundService, postInitializeBackgroundService');
    expect(backgroundTransformed).toContain('startup.then(() => { globalThis.__firefoxProbeStartup');
    const contentPath = resolve('src/core/content-scripts/index-main.js');
    const contentOriginal = await readFile(contentPath, 'utf8');
    expect(plugin.transform(contentOriginal, contentPath)).toContain('window.__firefoxProbeStartup = { complete: true, success: initialized === true };');
    const contentEntryPath = resolve('scripts/dev/page-translation-e2e-benchmark/content-entry.mjs');
    const contentEntryOriginal = await readFile(contentEntryPath, 'utf8');
    expect(plugin.transform(contentEntryOriginal, contentEntryPath)).toContain('trace.installProviderProbe = async (report, fixtureUrl) =>');
    const proxyPath = resolve('src/shared/proxy/ProxyManager.js');
    const proxyOriginal = await readFile(proxyPath, 'utf8');
    const proxyTransformed = plugin.transform(proxyOriginal, proxyPath);
    expect(proxyTransformed).toContain('const directFetchPromise = fetch(url, options);');
    expect(proxyTransformed).toContain('observeDirectFetch(url, options, directFetchPromise, true)');
    expect(await readFile(proxyPath, 'utf8')).toBe(proxyOriginal);
    expect(await readFile(backgroundPath, 'utf8')).toBe(backgroundOriginal);
    expect(await readFile(contentPath, 'utf8')).toBe(contentOriginal);
    expect(await readFile(contentEntryPath, 'utf8')).toBe(contentEntryOriginal);
    expect(() => plugin.transform('source drift', backgroundPath)).toThrow('instrumentation drifted');
    expect(() => plugin.transform('source drift', proxyPath)).toThrow('provider fetch instrumentation drifted');
  });

  it('redacts generated credentials from build failures', async () => {
    const outputDir = await freshOutputDir();
    const secret = 'f'.repeat(64);
    buildFailure.value = `synthetic bundler detail ${secret}`;
    const buildPromise = buildBenchmarkExtension({ browser: 'firefox', mode: 'sliced', outputDir,
      workerEntry: resolve('scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs'),
      contentEntry: resolve('scripts/dev/page-translation-e2e-benchmark/content-entry.mjs'),
      runtimeBridge: { runId: 'run-safe', fixtureUrl: 'http://127.0.0.1:4321/fixture', bindingUrl: 'http://127.0.0.1:4321/__benchmark/bind/run-safe', reportUrl: 'http://127.0.0.1:4321/__benchmark/runtime', authToken: secret },
    });
    await expect(buildPromise).rejects.toThrow('generated configuration details were suppressed');
    await expect(buildPromise).rejects.not.toThrow(secret);
  });

  it('rejects unsupported browsers and preserves output directory guards', async () => {
    const outputDir = await freshOutputDir();
    await expect(buildBenchmarkExtension({ outputDir, browser: 'safari' })).rejects.toThrow('Unknown browser');
    await expect(buildBenchmarkExtension({ outputDir, browser: 'chrome', runtimeBridge: {} })).rejects.toThrow('requires a sliced Firefox build');
    await expect(buildBenchmarkExtension({ outputDir, browser: 'firefox', runtimeBridge: {
      runId: 'run-123', fixtureUrl: 'http://127.0.0.1:4321/fixture', bindingUrl: 'http://127.0.0.1:4322/__benchmark/bind/run-123',
      reportUrl: 'http://127.0.0.1:4321/__benchmark/runtime', authToken: 'a'.repeat(63),
    } })).rejects.toThrow('requires a sliced Firefox build');
    await expect(buildBenchmarkExtension({ outputDir: resolve('dist/firefox'), browser: 'firefox' }))
      .rejects.toThrow('outside the repository');
    const nonEmptyDir = await freshOutputDir();
    await writeFile(resolve(nonEmptyDir, 'keep.txt'), 'keep');
    await expect(buildBenchmarkExtension({ outputDir: nonEmptyDir, browser: 'firefox' })).rejects.toThrow('must be empty');
  });
});

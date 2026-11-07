import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { buildConfigs, baseConfigs } = vi.hoisted(() => ({ buildConfigs: [], baseConfigs: [] }));

vi.mock('vite', () => ({
  build: vi.fn(async config => {
    buildConfigs.push(config);
    await mkdir(config.build.outDir, { recursive: true });
    const [name] = Object.keys(config.build.rollupOptions.input);
    await writeFile(resolve(config.build.outDir, `${name}.js`), `// ${name}`);
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

  it('rejects unsupported browsers and preserves output directory guards', async () => {
    const outputDir = await freshOutputDir();
    await expect(buildBenchmarkExtension({ outputDir, browser: 'safari' })).rejects.toThrow('Unknown browser');
    await expect(buildBenchmarkExtension({ outputDir: resolve('dist/firefox'), browser: 'firefox' }))
      .rejects.toThrow('outside the repository');
    const nonEmptyDir = await freshOutputDir();
    await writeFile(resolve(nonEmptyDir, 'keep.txt'), 'keep');
    await expect(buildBenchmarkExtension({ outputDir: nonEmptyDir, browser: 'firefox' })).rejects.toThrow('must be empty');
  });
});

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { build } from 'vite';
import { createBaseConfig } from '../../../config/vite/vite.config.base.js';

const flags = {
  legacy: [false, false],
  sliced: [true, false],
  viewport: [true, true],
};

export async function buildBenchmarkExtension({ outputDir, mode = 'legacy', browser = 'chrome', workerEntry, contentEntry }) {
  if (!flags[mode]) throw new TypeError(`Unknown discovery mode: ${mode}`);
  if (browser !== 'chrome' && browser !== 'firefox') throw new TypeError(`Unknown browser: ${browser}`);
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
  ] });

  const workerOut = resolve(outDir, '.worker-build');
  const contentOut = resolve(outDir, '.content-build');
  const buildEntry = async (input, entryOut, codeSplitting) => build({
    ...base,
    base: './',
    configFile: false,
    publicDir: false,
    logLevel: 'error',
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
    await buildEntry({ worker: workerEntry ?? resolve('src/core/background/index.js') }, workerOut, false);
    await buildEntry({ 'content-entry': contentEntry ?? resolve('src/core/content-scripts/index-main.js') }, contentOut, true);
    await cp(workerOut, outDir, { recursive: true, force: true });
    await cp(contentOut, outDir, { recursive: true, force: true });
  } finally {
    await Promise.all([rm(workerOut, { recursive: true, force: true }), rm(contentOut, { recursive: true, force: true })]);
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
  return outDir;
}

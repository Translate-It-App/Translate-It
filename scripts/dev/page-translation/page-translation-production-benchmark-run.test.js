// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const runSource = await readFile(new URL('./production-benchmark/run.mjs', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../../../src/features/page-translation/PageTranslationBridge.js', import.meta.url), 'utf8');
const constantsSource = await readFile(new URL('../../../src/features/page-translation/PageTranslationConstants.js', import.meta.url), 'utf8');

function getDirectAliasImports(source) {
  return [...source.matchAll(/import\s+([^;]*?)\s+from\s+['"](@\/[^'"]+)['"]/g)]
    .map(([, clause, specifier]) => {
      const names = [...(clause.match(/\{([\s\S]*?)\}/)?.[1] ?? '').matchAll(/([\w$]+)(?:\s+as\s+[\w$]+)?/g)]
        .map(([, name]) => name);
      const defaultImport = clause.replace(/\{[\s\S]*?\}/, '').trim().replace(/,$/, '').trim();
      if (defaultImport) names.push('default');
      return { specifier, names };
    });
}

function getBenchmarkAliases() {
  return new Map([...runSource.matchAll(/['"](@\/[^'"]+)['"]:\s*['"]([^'"]+)['"]/g)]
    .map(([, specifier, route]) => [specifier, route]));
}

function getInlineMock(route) {
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = runSource.match(new RegExp("['\"]" + escapedRoute + "['\"]:\\s*`([^`]*)`"));
  expect(match, `inline mock source not found for ${route}`).not.toBeNull();
  return match[1];
}

function loadMockResourceTracker() {
  const match = runSource.match(/'\/mock\/resource\.js':\s*`([^`]*)`/);
  expect(match, 'ResourceTracker mock source not found in run.mjs').not.toBeNull();
  const moduleFactory = new Function(match[1].replace('export default ', 'return '));
  return moduleFactory();
}

describe('production benchmark Bridge import compatibility', () => {
  it('maps every direct Bridge and constants alias', () => {
    const aliases = getBenchmarkAliases();

    for (const { specifier } of [...getDirectAliasImports(bridgeSource), ...getDirectAliasImports(constantsSource)]) {
      expect(aliases.has(specifier), `run.mjs is missing an import-map alias for ${specifier}`).toBe(true);
    }
  });

  it('provides every imported export from each inline mock', () => {
    const aliases = getBenchmarkAliases();
    const imported = [...getDirectAliasImports(bridgeSource), ...getDirectAliasImports(constantsSource)];

    for (const { specifier, names } of imported) {
      const route = aliases.get(specifier);
      if (!route?.startsWith('/mock/')) continue;

      const mock = getInlineMock(route);
      for (const name of names) {
        const exportPattern = name === 'default'
          ? /\bexport\s+default\b/
          : new RegExp(`\\bexport\\s+(?:const|function|class)\\s+${name}\\b`);
        expect(exportPattern.test(mock), `${route} does not export ${name} required by ${specifier}`).toBe(true);
      }
    }
  });
});

describe('production benchmark ResourceTracker mock', () => {
  it('provides the timer lifecycle the production Bridge cleanup requires', () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();

    for (const method of ['trackTimeout', 'clearTimer', 'clearAllTimers', 'cleanup']) {
      expect(typeof tracker[method], `mock is missing ${method}()`).toBe('function');
    }
    expect(bridgeSource).toContain('this.clearAllTimers();');
  });

  it('clears pending timers without running them', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 5);
    tracker.clearAllTimers();
    await delay(40);

    expect(fired).toBe(0);
  });

  it('keeps completed timers out of the cleanup path', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 1);
    await delay(20);
    expect(fired).toBe(1);

    tracker.clearAllTimers();
    await delay(20);

    expect(fired).toBe(1);
  });

  it('clears a pending timer registered after a completed one', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 1);
    await delay(20);
    tracker.trackTimeout(() => { fired += 1; }, 5);
    tracker.clearAllTimers();
    await delay(40);

    expect(fired).toBe(1);
  });
});

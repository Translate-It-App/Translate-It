import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = (path) => window.eval(readFileSync(resolve(path), 'utf8'));
const fixturePath = 'scripts/dev/page-translation-prototype/fixture.js';
const harnessPath = 'scripts/dev/page-translation-prototype/benchmark.js';

beforeEach(() => {
  document.body.innerHTML = '<p id="existing">keep live content</p>';
  delete globalThis.TranslateItBenchmarkFixture;
  delete globalThis.TranslateItPageBenchmark;
  load(fixturePath);
  load(harnessPath);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 30, left: 10, right: 100, width: 90, height: 20 });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

function fakeEngine(variant = 'correct') {
  const oracle = (value) => `⟦${value}⟧`;
  const transform = (value) => variant === 'blank' ? '' : variant === 'wrong' ? `WRONG:${value}` : oracle(value);
  return {
    mockTranslate: oracle,
    createEngine({ root, mode }) {
      const originals = new Map();
      let stats = { mode, visitedNodes: 0, restoreVisitedNodes: 0, translatedNodes: 0, firstVisibleMs: 1, processingMs: 2, maxSliceMs: 1, maxRestoreSliceMs: 0 };
      const visit = (node) => {
        if (node.nodeType === 3 && node.parentElement && !node.parentElement.closest('textarea,input,.benchmark-excluded') && node.data.trim()) {
          originals.set(node, { source: node.data, translated: transform(node.data) }); node.data = transform(node.data); stats.translatedNodes += 1;
        }
        if (node.nodeType === 1) {
          for (const name of ['title', 'alt', 'placeholder']) if (variant !== 'text-only' && node.hasAttribute(name) && !node.closest('textarea,input,.benchmark-excluded')) {
            const attr = node.getAttributeNode(name); originals.set(attr, { source: attr.value, translated: transform(attr.value) }); attr.value = transform(attr.value); stats.translatedNodes += 1;
          }
          if (node.shadowRoot) for (const child of [...node.shadowRoot.childNodes]) visit(child);
        }
        for (const child of [...(node.childNodes ?? [])]) visit(child);
      };
      const translate = () => { visit(root); stats.visitedNodes = stats.translatedNodes; };
      const restore = async () => {
        let restoredNodes = 0; let preservedExternalNodes = 0; let restoreVisitedNodes = 0;
        for (const [node, { source: original, translated }] of originals) {
          restoreVisitedNodes += 1;
          const value = node.nodeType === 2 ? node.value : node.nodeValue;
          if (value !== translated) { preservedExternalNodes += 1; continue; }
          if (node.nodeType === 2) node.value = original;
          else node.nodeValue = original;
          restoredNodes += 1;
        }
        originals.clear();
        return { ...stats, restoreVisitedNodes, restoredNodes, preservedExternalNodes };
      };
      return { start: () => new Promise((resolve) => setTimeout(() => { translate(); resolve({ ...stats }); }, 25)), whenIdle: async () => ({ ...stats }), stop() {}, restore, cleanup: restore, getStats: () => ({ ...stats }) };
    },
  };
}

describe('prototype benchmark safety and reporting', () => {
  it('refuses body/default roots without changing existing page content', async () => {
    const before = document.body.innerHTML;
    expect(() => TranslateItBenchmarkFixture.create()).toThrow(/dedicated/);
    await expect(TranslateItPageBenchmark.run({ engine: fakeEngine(), samples: 1 })).rejects.toThrow(/dedicated/);
    expect(document.body.innerHTML).toBe(before);
  });

  it('requires the marked fixture container and recreates deterministic fixture sources', () => {
    const wrong = document.createElement('main');
    document.body.append(wrong);
    expect(() => TranslateItBenchmarkFixture.create({ root: wrong, branches: 0 })).toThrow(/dedicated/);
    const root = document.createElement('main');
    root.id = 'benchmark-root';
    root.dataset.benchmarkFixture = 'page-translation-prototype';
    document.body.append(root);
    const first = TranslateItBenchmarkFixture.create({ root, branches: 2, depth: 2, visibleCount: 2 });
    const sources = first.snapshot().map((row) => row.value);
    const second = TranslateItBenchmarkFixture.create({ root, branches: 2, depth: 2, visibleCount: 2 });
    expect(second.snapshot().map((row) => row.value)).toEqual(sources);
  });

  it('reports aggregate counts only, catches restoration/external ownership, and nulls unsupported measurements', async () => {
    document.body.innerHTML = '<main id="benchmark-root" data-benchmark-fixture="page-translation-prototype"></main>';
    class UnsupportedPerformanceObserver { static supportedEntryTypes = []; }
    vi.stubGlobal('PerformanceObserver', UnsupportedPerformanceObserver);
    const report = await TranslateItPageBenchmark.run({ engine: fakeEngine(), samples: 1, fixtureOptions: { branches: 2, depth: 2, visibleCount: 2 } });
    const output = JSON.stringify(report);
    expect(output).not.toMatch(/deterministic source text|external page edit|fixture branch/);
    expect(report.environment.longTaskObserverSupported).toBe(false);
    expect(report.results.viewport.taskObserver).toBeNull();
    expect(report.results.viewport.metrics.translationLongestTaskMs.median).toBeNull();
    expect(report.results.viewport.correctness.preRestoreTranslationMismatches).toBe(0);
    expect(report.results.viewport.correctness.restoreTextAttributeMismatches).toBe(0);
    expect(report.results.viewport.correctness.externalEditsPreserved).toBe(true);
    expect(report.results.viewport.correctness.excludedNodesUntouched).toBe(true);
    expect(report.results.viewport.translatedNodes).toEqual(report.results.baseline.translatedNodes);
    expect(report.results.baseline.visitedNodes).toEqual([report.results.baseline.translatedNodes[0]]);
    expect(report.results.baseline.restoreVisitedNodes[0]).toBeGreaterThan(report.results.baseline.restoredNodes[0]);
    expect(report.results.baseline.metrics.maxRestoreSliceMs.median).toBeNull();
    expect(report.results.viewport.preservedExternalNodes.every((count) => count > 0)).toBe(true);
    expect(report.results.viewport.coverageCounts.visibleAttributes).toBeGreaterThan(0);
    expect(report.results.viewport.coverageCounts.shadowTargets).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it.each(['text-only', 'blank', 'wrong'])('rejects %s translations against the exact mock oracle', async (variant) => {
    document.body.innerHTML = '<main id="benchmark-root" data-benchmark-fixture="page-translation-prototype"></main>';
    const report = await TranslateItPageBenchmark.run({ engine: fakeEngine(variant), samples: 1, fixtureOptions: { branches: 1, depth: 1, visibleCount: 1 } });
    expect(report.results.baseline.correctness.preRestoreTranslationMismatches).toBeGreaterThan(0);
    expect(report.results.viewport.correctness.preRestoreTranslationMismatches).toBeGreaterThan(0);
  });

  it('starts restore-task observation after external edits and reports task duration separately', async () => {
    document.body.innerHTML = '<main id="benchmark-root" data-benchmark-fixture="page-translation-prototype"></main>';
    const observedText = [];
    class LongTaskObserver {
      static supportedEntryTypes = ['longtask'];
      constructor() { observedText.push(document.querySelector('#fixture-visible p')?.textContent ?? null); }
      observe() {}
      takeRecords() { return [{ duration: 13 }]; }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', LongTaskObserver);
    const report = await TranslateItPageBenchmark.run({ engine: fakeEngine(), samples: 1, fixtureOptions: { branches: 1, depth: 1, visibleCount: 1 } });
    expect(observedText.filter((text) => text === 'external page edit must be preserved')).toHaveLength(4);
    expect(report.results.baseline.metrics.translationLongestTaskMs.median).toBe(13);
    expect(report.results.baseline.metrics.restoreLongestTaskMs.median).toBe(13);
    expect(report.results.baseline.taskObserver.translationCount).toEqual([1]);
    expect(report.results.baseline.taskObserver.restoreCount).toEqual([1]);
    vi.unstubAllGlobals();
  });
});

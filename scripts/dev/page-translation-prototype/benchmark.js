(() => {
  'use strict';

  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isText = (key) => key === 'text';
  const current = (node, key) => isText(key) ? node.data : node.getAttribute(key);
  const source = (row) => row.value;
  const taskObserverAvailable = () => typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
  const createTaskMeter = () => {
    if (!taskObserverAvailable()) return null;
    let count = 0;
    let longestMs = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { count += 1; longestMs = Math.max(longestMs, entry.duration); }
    });
    observer.observe({ type: 'longtask', buffered: false });
    return {
      async finish() {
        await wait(0);
        for (const entry of observer.takeRecords()) { count += 1; longestMs = Math.max(longestMs, entry.duration); }
        observer.disconnect();
        return { count, longestMs };
      },
      disconnect() { observer.disconnect(); },
    };
  };

  async function run({ engine = globalThis.TranslateItViewportPrototype, samples = 5, fixtureOptions = {} } = {}) {
    if (!engine || typeof engine.createEngine !== 'function') throw new Error('Load the standalone prototype engine before running the fixture benchmark.');
    if (!globalThis.TranslateItBenchmarkFixture) throw new Error('Load fixture.js before running the fixture benchmark.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new RangeError('samples must be 1..30');
    const root = fixtureOptions.root ?? document.querySelector('main#benchmark-root[data-benchmark-fixture="page-translation-prototype"]');
    if (!root || root.nodeType !== 1 || root.tagName !== 'MAIN' || root.id !== 'benchmark-root' || root.dataset.benchmarkFixture !== 'page-translation-prototype' || root.ownerDocument !== document || root === document.body || root === document.documentElement || !document.body.contains(root)) {
      throw new TypeError('Fixture benchmark refused: use the dedicated marked #benchmark-root on the local fixture page.');
    }
    const options = { ...fixtureOptions, root };
    const modes = ['baseline', 'viewport'];
    const results = [];
    const environment = { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, longTaskObserverSupported: taskObserverAvailable() };
    for (const mode of modes) await measure(mode, true);
    for (let i = 0; i < samples; i += 1) for (const mode of i % 2 ? [...modes].reverse() : modes) await measure(mode, false);

    const summarize = (mode) => {
      const rows = results.filter((row) => row.mode === mode);
      const metricNames = ['engineProcessingMs', 'externalWallElapsedMs', 'restoreMs', 'maxSliceMs', 'maxRestoreSliceMs', 'timeToFirstVisibleWriteMs', 'heartbeatMaxDelayMs', 'translationLongestTaskMs', 'restoreLongestTaskMs', 'memoryDeltaBytes'];
      return {
        samples: rows.length,
        metrics: Object.fromEntries(metricNames.map((name) => [name, { median: percentile(rows.map((row) => row[name]).filter(Number.isFinite), .5), p95: percentile(rows.map((row) => row[name]).filter(Number.isFinite), .95) }])),
        taskObserver: environment.longTaskObserverSupported ? { translationCount: rows.map((row) => row.translationLongTaskCount), restoreCount: rows.map((row) => row.restoreLongTaskCount) } : null,
        correctness: {
          preRestoreTranslationMismatches: rows.reduce((n, row) => n + row.preRestoreTranslationMismatches, 0),
          restoreTextAttributeMismatches: rows.reduce((n, row) => n + row.restoreMismatches, 0),
          externalEditsPreserved: rows.every((row) => row.externalEditsPreserved),
          excludedNodesUntouched: rows.every((row) => row.excludedNodesUntouched),
        },
        coverageCounts: rows.length ? rows[0].coverageCounts : null,
        visitedNodes: rows.map((row) => row.visitedNodes),
        translatedNodes: rows.map((row) => row.translatedNodes),
        restoreVisitedNodes: rows.map((row) => row.restoreVisitedNodes),
        restoredNodes: rows.map((row) => row.restoredNodes),
        preservedExternalNodes: rows.map((row) => row.preservedExternalNodes),
      };
    };
    return {
      label: 'isolated synthetic fixture; baseline is simulated synchronous full discovery, not production domtranslator',
      environment,
      definitions: {
        engineProcessingMs: 'engine getStats().processingMs: cumulative measured engine-slice execution time, excluding scheduler waits, fixture setup and restore; not exclusive CPU time',
        externalWallElapsedMs: 'start through dynamic additions and whenIdle wall elapsed time, including scheduling waits',
        maxSliceMs: 'engine slice timer only; never a browser longest-task measurement',
        translationLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser PerformanceObserver longtask duration scoped to translation' : 'unsupported; null',
        restoreLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser PerformanceObserver longtask duration scoped to restore' : 'unsupported; null',
        heartbeatMaxDelayMs: 'event-loop heartbeat delay proxy, not task duration',
        timeToFirstVisibleWriteMs: 'engine first visible DOM mutation, not paint/presentation',
        memoryDeltaBytes: 'per-sample performance.memory after cleanup minus before fixture setup; null when unsupported',
        visitedNodes: 'engine traversal visits during discovery/translation; may include repeated seed visits and is not a unique page-node count',
        restoreVisitedNodes: 'engine restoration work units: baseline walks DOM nodes; viewport iterates owned Text/Attr records',
      },
      results: { baseline: summarize('baseline'), viewport: summarize('viewport') },
      recommendation: 'synthetic fixture validates traversal and restoration only; validate separately in Firefox on a fresh real-page load before replacement decisions',
    };

    async function measure(mode, warmup) {
      const memoryBefore = performance.memory?.usedJSHeapSize ?? null;
      const fixture = globalThis.TranslateItBenchmarkFixture.create(options);
      let originals = fixture.snapshot();
      const rootAttributes = [...root.attributes].map((attribute) => [attribute.name, attribute.value]);
      const excludedText = fixture.root.querySelector('.benchmark-excluded').firstChild;
      const excludedSource = excludedText.data;
      const editable = [...fixture.root.querySelectorAll('textarea,input')].map((element) => element.value);
      const instance = engine.createEngine({ root, mode, excludedSelectors: ['.benchmark-excluded', 'textarea', 'input'] });
      let heartbeatMaxDelayMs = 0;
      let lastBeat = 0;
      let ticking = true;
      let heartbeatTimer;
      const beat = () => {
        if (!ticking) return;
        const now = performance.now();
        heartbeatMaxDelayMs = Math.max(heartbeatMaxDelayMs, Math.max(0, now - lastBeat - 10));
        lastBeat = now;
        heartbeatTimer = setTimeout(beat, 10);
      };
      let translationMeter;
      let restoreMeter;
      let dynamicTimers = [];
      try {
        await wait(0);
        lastBeat = performance.now();
        const began = performance.now();
        heartbeatTimer = setTimeout(beat, 10);
        translationMeter = createTaskMeter();
        const running = instance.start();
        dynamicTimers = [setTimeout(() => fixture.addDynamic('light'), 0), setTimeout(() => fixture.addDynamic('shadow'), 15)];
        await running;
        await wait(25);
        const idle = await instance.whenIdle();
        const externalWallElapsedMs = performance.now() - began;
        ticking = false;
        clearTimeout(heartbeatTimer);
        dynamicTimers.forEach(clearTimeout);
        const translationTasks = translationMeter ? await translationMeter.finish() : null;
        translationMeter = null;
        const stats = instance.getStats();
        originals = fixture.snapshot();
        const preRestoreTranslationMismatches = originals.reduce((count, row) => {
          const el = isText(row.key) ? row.node.parentElement : row.node;
          const translatedKind = isText(row.key) || ['title', 'alt', 'placeholder'].includes(row.key);
          let inView = false;
          if (el && translatedKind) {
            const rect = el.getBoundingClientRect();
            inView = (rect.width > 0 || rect.height > 0) && rect.bottom >= -150 && rect.top <= innerHeight + 150 && rect.right >= -150 && rect.left <= innerWidth + 150;
          }
          const eligible = el && inView && !el.closest('textarea,input,.benchmark-excluded') && source(row).trim();
          const expected = eligible ? engine.mockTranslate(source(row)) : source(row);
          return count + (current(row.node, row.key) === expected ? 0 : 1);
        }, 0);
        const excludedNodesUntouched = excludedText.data === excludedSource && editable.every((value, index) => fixture.root.querySelectorAll('textarea,input')[index].value === value) && JSON.stringify([...root.attributes].map((attribute) => [attribute.name, attribute.value])) === JSON.stringify(rootAttributes);
        const coverageCounts = {
          visibleText: fixture.visibleNodes.filter((node) => node.data !== originals.find((row) => row.node === node && row.key === 'text')?.value).length,
          visibleAttributes: originals.filter((row) => !isText(row.key) && row.node.closest('#fixture-visible') && current(row.node, row.key) !== row.value).length,
          shadowTargets: originals.filter((row) => { const el = isText(row.key) ? row.node.parentElement : row.node; return el?.getRootNode() instanceof ShadowRoot && current(row.node, row.key) !== row.value; }).length,
          totalTargetsChanged: originals.filter((row) => current(row.node, row.key) !== row.value).length,
        };
        const external = fixture.mutateExternally();
        instance.stop();
        await wait(0);
        restoreMeter = createTaskMeter();
        const restoreStart = performance.now();
        const restored = await instance.restore();
        const restoreMs = performance.now() - restoreStart;
        const restoreTasks = restoreMeter ? await restoreMeter.finish() : null;
        restoreMeter = null;
        const restoreMismatches = originals.reduce((count, row) => {
          if (row.node === external.externalText || (row.node === external.externalAttr && row.key === 'title')) return count;
          return count + (current(row.node, row.key) === row.value ? 0 : 1);
        }, 0);
        const externalEditsPreserved = external.externalText.data === 'external page edit must be preserved' && external.externalAttr.getAttribute('title') === 'external page title edit must be preserved';
        await instance.cleanup();
        const memoryAfter = performance.memory?.usedJSHeapSize ?? null;
        if (!warmup) results.push({
          mode, engineProcessingMs: stats.processingMs ?? null, externalWallElapsedMs, restoreMs,
           maxSliceMs: stats.maxSliceMs ?? idle.maxSliceMs ?? null,
           maxRestoreSliceMs: mode === 'baseline' ? null : restored.maxRestoreSliceMs ?? null,
          timeToFirstVisibleWriteMs: stats.firstVisibleMs ?? idle.firstVisibleMs ?? null,
          heartbeatMaxDelayMs,
          translationLongTaskCount: translationTasks?.count ?? null,
          translationLongestTaskMs: translationTasks?.longestMs ?? null,
          restoreLongTaskCount: restoreTasks?.count ?? null,
          restoreLongestTaskMs: restoreTasks?.longestMs ?? null,
          memoryDeltaBytes: Number.isFinite(memoryBefore) && Number.isFinite(memoryAfter) ? memoryAfter - memoryBefore : null,
          preRestoreTranslationMismatches, restoreMismatches, externalEditsPreserved, excludedNodesUntouched, coverageCounts,
          visitedNodes: stats.visitedNodes ?? null, translatedNodes: stats.translatedNodes,
          restoreVisitedNodes: restored.restoreVisitedNodes ?? null, restoredNodes: restored.restoredNodes, preservedExternalNodes: restored.preservedExternalNodes,
        });
      } finally {
        ticking = false;
        clearTimeout(heartbeatTimer);
        translationMeter?.disconnect();
        restoreMeter?.disconnect();
        await instance.cleanup();
      }
    }
  }
  globalThis.TranslateItPageBenchmark = { run };
})();

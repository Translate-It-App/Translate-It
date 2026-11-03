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
  const diffStat = (after, before, key) => Number.isFinite(after[key]) && Number.isFinite(before[key]) ? after[key] - before[key] : null;
  const eligibleVisible = (row) => {
    const el = isText(row.key) ? row.node.parentElement : row.node;
    if (!el || !(isText(row.key) || ['title', 'alt', 'placeholder'].includes(row.key)) || el.closest('textarea,input,.benchmark-excluded') || !source(row).trim()) return false;
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 || rect.height > 0) && rect.bottom >= -150 && rect.top <= innerHeight + 150 && rect.right >= -150 && rect.left <= innerWidth + 150;
  };
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

  async function run({ engine = globalThis.TranslateItViewportPrototype, samples = 5, fixtureOptions = {}, attributeNoiseBursts = 12 } = {}) {
    if (!engine || typeof engine.createEngine !== 'function') throw new Error('Load the standalone prototype engine before running the fixture benchmark.');
    if (!globalThis.TranslateItBenchmarkFixture) throw new Error('Load fixture.js before running the fixture benchmark.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new RangeError('samples must be 1..30');
    if (!Number.isInteger(attributeNoiseBursts) || attributeNoiseBursts < 1 || attributeNoiseBursts > 100) throw new RangeError('attributeNoiseBursts must be 1..100');
    const root = fixtureOptions.root ?? document.querySelector('main#benchmark-root[data-benchmark-fixture="page-translation-prototype"]');
    if (!root || root.nodeType !== 1 || root.tagName !== 'MAIN' || root.id !== 'benchmark-root' || root.dataset.benchmarkFixture !== 'page-translation-prototype' || root.ownerDocument !== document || root === document.body || root === document.documentElement || !document.body.contains(root)) {
      throw new TypeError('Fixture benchmark refused: use the dedicated marked #benchmark-root on the local fixture page.');
    }
    const options = { ...fixtureOptions, root };
    const modes = ['baseline', 'viewport'];
    const results = [];
    const environment = { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, longTaskObserverSupported: taskObserverAvailable(), fixture: { branches: options.branches ?? 2500, depth: options.depth ?? 4, visibleCount: options.visibleCount ?? 24 }, attributeNoiseBursts };
    for (const mode of modes) await measure(mode, true);
    for (let i = 0; i < samples; i += 1) for (const mode of i % 2 ? [...modes].reverse() : modes) await measure(mode, false);

    const summarize = (mode) => {
      const rows = results.filter((row) => row.mode === mode);
      const metricNames = ['engineProcessingMs', 'externalWallElapsedMs', 'restoreMs', 'maxSliceMs', 'maxRestoreSliceMs', 'timeToFirstVisibleWriteMs', 'scrollFirstVisibleWriteMs', 'initialWallElapsedMs', 'scrollWallElapsedMs', 'initialProcessingMs', 'scrollProcessingMs', 'attributeNoiseWallElapsedMs', 'attributeNoiseProcessingMs', 'attributeNoiseMutationAuditMs', 'attributeNoiseTotalProcessingMs', 'attributeNoiseMutationAuditCount', 'attributeNoiseMutationAuditFallbacks', 'heartbeatMaxDelayMs', 'initialHeartbeatMaxDelayMs', 'scrollHeartbeatMaxDelayMs', 'attributeNoiseHeartbeatMaxDelayMs', 'initialLongestTaskMs', 'scrollLongestTaskMs', 'attributeNoiseLongestTaskMs', 'translationLongestTaskMs', 'restoreLongestTaskMs', 'memoryDeltaBytes'];
      return {
        samples: rows.length,
        metrics: Object.fromEntries(metricNames.map((name) => [name, { median: percentile(rows.map((row) => row[name]).filter(Number.isFinite), .5), p95: percentile(rows.map((row) => row[name]).filter(Number.isFinite), .95) }])),
        taskObserver: environment.longTaskObserverSupported ? { initialCount: rows.map((row) => row.initialLongTaskCount), scrollCount: rows.map((row) => row.scrollLongTaskCount), attributeNoiseCount: rows.map((row) => row.attributeNoiseLongTaskCount), restoreCount: rows.map((row) => row.restoreLongTaskCount) } : null,
        correctness: {
          preRestoreTranslationMismatches: rows.reduce((n, row) => n + row.preRestoreTranslationMismatches, 0),
          restoreTextAttributeMismatches: rows.reduce((n, row) => n + row.restoreMismatches, 0),
          externalEditsPreserved: rows.every((row) => row.externalEditsPreserved),
          excludedNodesUntouched: rows.every((row) => row.excludedNodesUntouched),
        },
        coverageCounts: rows.length ? rows[0].coverageCounts : null,
        visitedNodes: rows.map((row) => row.visitedNodes),
        initialVisitedNodes: rows.map((row) => row.initialVisitedNodes),
        afterScrollVisitedNodes: rows.map((row) => row.afterScrollVisitedNodes),
        scrollVisitedNodes: rows.map((row) => row.scrollVisitedNodes),
        initialGeometryChecks: rows.map((row) => row.initialGeometryChecks),
        scrollGeometryChecks: rows.map((row) => row.scrollGeometryChecks),
        initialPrunedBranches: rows.map((row) => row.initialPrunedBranches),
        scrollPrunedBranches: rows.map((row) => row.scrollPrunedBranches),
        initialDiscoveryPasses: rows.map((row) => row.initialDiscoveryPasses),
        scrollDiscoveryPasses: rows.map((row) => row.scrollDiscoveryPasses),
        attributeNoiseVisitedNodes: rows.map((row) => row.attributeNoiseVisitedNodes),
        attributeNoiseGeometryChecks: rows.map((row) => row.attributeNoiseGeometryChecks),
        attributeNoisePrunedBranches: rows.map((row) => row.attributeNoisePrunedBranches),
        attributeNoiseDiscoveryPasses: rows.map((row) => row.attributeNoiseDiscoveryPasses),
        attributeNoiseMutationAuditMs: rows.map((row) => row.attributeNoiseMutationAuditMs),
        attributeNoiseMutationAuditCount: rows.map((row) => row.attributeNoiseMutationAuditCount),
        attributeNoiseMutationAuditFallbacks: rows.map((row) => row.attributeNoiseMutationAuditFallbacks),
        attributeNoisePeakQueueCandidateObserver: rows.map((row) => row.attributeNoisePeakQueueCandidateObserver),
        peakQueueCandidateObserver: rows.map((row) => row.peakQueueCandidateObserver),
        peakOwnedNodes: rows.map((row) => row.peakOwnedNodes),
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
        externalWallElapsedMs: 'sum of initial, scroll, and irrelevant-attribute workload wall times; includes scroll settle, mutation cadence, and scheduling waits; excludes fixture setup, oracle work, and observer finalization',
        maxSliceMs: 'engine slice timer only; never a browser longest-task measurement',
        initialLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser longtask during initial start through initial idle; excludes oracle work' : 'unsupported; null',
        scrollLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser longtask during native scroll delivery and engine follow-up through idle; excludes oracle work' : 'unsupported; null',
        attributeNoiseLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser longtask during serial irrelevant root-attribute mutations and their idle waits; excludes oracle work' : 'unsupported; null',
        attributeNoiseMutationAuditMs: 'synchronous callback CSS dependency audit time during irrelevant-attribute mutations; separate from processingMs/maxSliceMs',
        attributeNoiseTotalProcessingMs: 'attributeNoiseProcessingMs plus the separate synchronous mutationAuditMs; when audit stats are unavailable, only engine processing is known',
        attributeNoiseBursts: 'number of distinct root data-benchmark-noise values, each written then followed by an idle wait',
        translationLongestTaskMs: environment.longTaskObserverSupported ? 'maximum of initial and scroll phase longtask durations; unsupported phases are null' : 'unsupported; null',
        restoreLongestTaskMs: environment.longTaskObserverSupported ? 'largest browser PerformanceObserver longtask duration scoped to restore' : 'unsupported; null',
        heartbeatMaxDelayMs: 'event-loop heartbeat delay proxy, not task duration',
        timeToFirstVisibleWriteMs: 'engine first visible DOM mutation, not paint/presentation',
        memoryDeltaBytes: 'per-sample performance.memory after cleanup minus before fixture setup; null when unsupported',
        visitedNodes: 'engine traversal visits; may include repeated seed visits and is not a unique page-node count',
        initialVisitedNodes: 'cumulative engine visits at initial whenIdle, before the controlled scroll; discovery plus initial translation',
        scrollVisitedNodes: 'additional engine traversal visits between initial whenIdle and scroll whenIdle; geometry checks, pruned branches, and discovery passes are also reported when available',
        attributeNoiseVisitedNodes: 'additional engine traversal visits across serial idle-separated writes to the unreferenced root data-benchmark-noise attribute',
        attributeNoisePeakQueueCandidateObserver: 'largest sampled pendingJobCount, candidateCount, and observerCount during irrelevant root-attribute churn; polling may miss brief peaks',
        peakQueueCandidateObserver: 'largest sampled pendingJobCount, candidateCount, and observerCount from engine getStats() during engine phases; polling may miss brief peaks',
        peakOwnedNodes: 'largest sampled retained translated-node ownership count; intentionally grows until restore, unlike pending work backlog',
        restoreVisitedNodes: 'engine restoration work units: baseline walks DOM nodes; viewport iterates owned Text/Attr records',
      },
      results: { baseline: summarize('baseline'), viewport: summarize('viewport') },
      recommendation: 'synthetic fixture validates traversal and restoration only; validate separately in Firefox on a fresh real-page load before replacement decisions',
    };

    async function measure(mode, warmup) {
      const memoryBefore = performance.memory?.usedJSHeapSize ?? null;
      const fixture = globalThis.TranslateItBenchmarkFixture.create(options);
      fixture.addDynamic('light');
      fixture.addDynamic('shadow');
      const originals = fixture.snapshot();
      const rootAttributes = [...root.attributes].map((attribute) => [attribute.name, attribute.value]);
      const noiseOriginallyPresent = root.hasAttribute('data-benchmark-noise');
      const noiseOriginalValue = root.getAttribute('data-benchmark-noise');
      const excludedText = fixture.root.querySelector('.benchmark-excluded').firstChild;
      const excludedSource = excludedText.data;
      const editable = [...fixture.root.querySelectorAll('textarea,input')].map((element) => element.value);
      const instance = engine.createEngine({ root, mode, excludedSelectors: ['.benchmark-excluded', 'textarea', 'input'] });
      let phaseHeartbeatMaxDelayMs = 0;
      let initialHeartbeatMaxDelayMs = null;
      let scrollHeartbeatMaxDelayMs = null;
      let lastBeat = 0;
      let ticking = true;
      let heartbeatTimer;
      const beat = () => {
        if (!ticking) return;
        const now = performance.now();
        phaseHeartbeatMaxDelayMs = Math.max(phaseHeartbeatMaxDelayMs, Math.max(0, now - lastBeat - 10));
        lastBeat = now;
        heartbeatTimer = setTimeout(beat, 10);
      };
      const stopHeartbeat = () => {
        phaseHeartbeatMaxDelayMs = Math.max(phaseHeartbeatMaxDelayMs, Math.max(0, performance.now() - lastBeat - 10));
        ticking = false;
        clearTimeout(heartbeatTimer);
      };
      let initialTaskMeter;
      let scrollTaskMeter;
      let attributeNoiseTaskMeter;
      let restoreMeter;
      let sampleStats = false;
      try {
        await wait(0);
        lastBeat = performance.now();
        const began = performance.now();
        const peakQueueCandidateObserver = { pendingJobCount: 0, candidateCount: 0, observerCount: 0 };
        let peakOwnedNodes = 0;
        const attributeNoisePeakQueueCandidateObserver = { pendingJobCount: 0, candidateCount: 0, observerCount: 0 };
        let samplingAttributeNoise = false;
        sampleStats = true;
        let scrollStartedAt = null;
        let translatedBeforeScroll = 0;
        let scrollFirstVisibleWriteMs = null;
        const expectedTranslated = new Set();
        const sampleEngineStats = () => {
          if (!sampleStats) return;
          const currentStats = instance.getStats();
          for (const key of Object.keys(peakQueueCandidateObserver)) peakQueueCandidateObserver[key] = Math.max(peakQueueCandidateObserver[key], currentStats[key] ?? 0);
          peakOwnedNodes = Math.max(peakOwnedNodes, currentStats.ownedNodes ?? 0);
          if (samplingAttributeNoise) for (const key of Object.keys(attributeNoisePeakQueueCandidateObserver)) attributeNoisePeakQueueCandidateObserver[key] = Math.max(attributeNoisePeakQueueCandidateObserver[key], currentStats[key] ?? 0);
          if (scrollStartedAt !== null && scrollFirstVisibleWriteMs === null && (currentStats.translatedNodes ?? 0) > translatedBeforeScroll) scrollFirstVisibleWriteMs = performance.now() - scrollStartedAt;
          setTimeout(sampleEngineStats, 0);
        };
        sampleEngineStats();
        heartbeatTimer = setTimeout(beat, 10);
        initialTaskMeter = createTaskMeter();
        const running = instance.start();
        await running;
        const initialStats = await instance.whenIdle();
        const initialWallElapsedMs = performance.now() - began;
        stopHeartbeat();
        sampleStats = false;
        initialHeartbeatMaxDelayMs = phaseHeartbeatMaxDelayMs;
        const initialTasks = initialTaskMeter ? await initialTaskMeter.finish() : null;
        initialTaskMeter = null;
        originals.forEach((row) => { if (eligibleVisible(row)) expectedTranslated.add(row); });
        const scrollBegan = performance.now();
        sampleStats = true;
        sampleEngineStats();
        phaseHeartbeatMaxDelayMs = 0;
        lastBeat = scrollBegan;
        ticking = true;
        heartbeatTimer = setTimeout(beat, 10);
        translatedBeforeScroll = initialStats.translatedNodes ?? 0;
        scrollStartedAt = scrollBegan;
        scrollTaskMeter = createTaskMeter();
        fixture.root.querySelector('.fixture-offscreen')?.scrollIntoView({ block: 'start' });
        await wait(25);
        const afterScroll = await instance.whenIdle();
        const scrollWallElapsedMs = performance.now() - scrollBegan;
        const externalWallElapsedMs = initialWallElapsedMs + scrollWallElapsedMs;
        stopHeartbeat();
        sampleStats = false;
        scrollHeartbeatMaxDelayMs = phaseHeartbeatMaxDelayMs;
        const scrollTasks = scrollTaskMeter ? await scrollTaskMeter.finish() : null;
        scrollTaskMeter = null;
        originals.forEach((row) => { if (eligibleVisible(row)) expectedTranslated.add(row); });
        const noiseBefore = instance.getStats();
        const noiseBegan = performance.now();
        samplingAttributeNoise = true;
        sampleStats = true;
        sampleEngineStats();
        phaseHeartbeatMaxDelayMs = 0;
        lastBeat = noiseBegan;
        ticking = true;
        heartbeatTimer = setTimeout(beat, 10);
        attributeNoiseTaskMeter = createTaskMeter();
        for (let burst = 0; burst < attributeNoiseBursts; burst += 1) {
          root.setAttribute('data-benchmark-noise', `noise-${burst}`);
          await wait(0);
          await instance.whenIdle();
        }
        const afterAttributeNoise = instance.getStats();
        const attributeNoiseWallElapsedMs = performance.now() - noiseBegan;
        stopHeartbeat();
        sampleStats = false;
        samplingAttributeNoise = false;
        const attributeNoiseHeartbeatMaxDelayMs = phaseHeartbeatMaxDelayMs;
        const attributeNoiseTasks = attributeNoiseTaskMeter ? await attributeNoiseTaskMeter.finish() : null;
        attributeNoiseTaskMeter = null;
        const idle = afterScroll;
        sampleStats = false;
        const stats = instance.getStats();
        const preRestoreTranslationMismatches = originals.reduce((count, row) => {
          const eligible = expectedTranslated.has(row);
          const expected = eligible ? engine.mockTranslate(source(row)) : source(row);
          return count + (current(row.node, row.key) === expected ? 0 : 1);
        }, 0);
        const excludedNodesUntouched = excludedText.data === excludedSource && editable.every((value, index) => fixture.root.querySelectorAll('textarea,input')[index].value === value) && JSON.stringify([...root.attributes].filter((attribute) => attribute.name !== 'data-benchmark-noise').map((attribute) => [attribute.name, attribute.value])) === JSON.stringify(rootAttributes.filter(([name]) => name !== 'data-benchmark-noise')) && root.getAttribute('data-benchmark-noise') === `noise-${attributeNoiseBursts - 1}`;
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
          mode, engineProcessingMs: stats.processingMs ?? null, externalWallElapsedMs: externalWallElapsedMs + attributeNoiseWallElapsedMs, initialWallElapsedMs, scrollWallElapsedMs, scrollProcessingMs: (afterScroll.processingMs ?? 0) - (initialStats.processingMs ?? 0), initialProcessingMs: initialStats.processingMs ?? null, scrollFirstVisibleWriteMs, attributeNoiseWallElapsedMs, attributeNoiseProcessingMs: diffStat(afterAttributeNoise, noiseBefore, 'processingMs'), restoreMs,
          maxSliceMs: stats.maxSliceMs ?? idle.maxSliceMs ?? null,
           maxRestoreSliceMs: mode === 'baseline' ? null : restored.maxRestoreSliceMs ?? null,
          timeToFirstVisibleWriteMs: stats.firstVisibleMs ?? idle.firstVisibleMs ?? null,
          heartbeatMaxDelayMs: Math.max(initialHeartbeatMaxDelayMs ?? 0, scrollHeartbeatMaxDelayMs ?? 0, attributeNoiseHeartbeatMaxDelayMs), initialHeartbeatMaxDelayMs, scrollHeartbeatMaxDelayMs,
          attributeNoiseHeartbeatMaxDelayMs,
          initialLongTaskCount: initialTasks?.count ?? null,
          initialLongestTaskMs: initialTasks?.longestMs ?? null,
          scrollLongTaskCount: scrollTasks?.count ?? null,
          scrollLongestTaskMs: scrollTasks?.longestMs ?? null,
          attributeNoiseLongTaskCount: attributeNoiseTasks?.count ?? null,
          attributeNoiseLongestTaskMs: attributeNoiseTasks?.longestMs ?? null,
          translationLongestTaskMs: Number.isFinite(initialTasks?.longestMs) || Number.isFinite(scrollTasks?.longestMs) ? Math.max(initialTasks?.longestMs ?? 0, scrollTasks?.longestMs ?? 0) : null,
          restoreLongTaskCount: restoreTasks?.count ?? null,
          restoreLongestTaskMs: restoreTasks?.longestMs ?? null,
          memoryDeltaBytes: Number.isFinite(memoryBefore) && Number.isFinite(memoryAfter) ? memoryAfter - memoryBefore : null,
          preRestoreTranslationMismatches, restoreMismatches, externalEditsPreserved, excludedNodesUntouched, coverageCounts,
          visitedNodes: stats.visitedNodes ?? null, initialVisitedNodes: initialStats.visitedNodes ?? null, afterScrollVisitedNodes: afterScroll.visitedNodes ?? null,
          scrollVisitedNodes: (afterScroll.visitedNodes ?? 0) - (initialStats.visitedNodes ?? 0),
          attributeNoiseVisitedNodes: diffStat(afterAttributeNoise, noiseBefore, 'visitedNodes'),
          attributeNoiseGeometryChecks: diffStat(afterAttributeNoise, noiseBefore, 'geometryChecks'),
          attributeNoisePrunedBranches: diffStat(afterAttributeNoise, noiseBefore, 'prunedBranches'),
          attributeNoiseDiscoveryPasses: diffStat(afterAttributeNoise, noiseBefore, 'discoveryPasses'),
          attributeNoiseMutationAuditMs: diffStat(afterAttributeNoise, noiseBefore, 'mutationAuditMs'),
          attributeNoiseTotalProcessingMs: Number.isFinite(diffStat(afterAttributeNoise, noiseBefore, 'processingMs')) ? diffStat(afterAttributeNoise, noiseBefore, 'processingMs') + (Number.isFinite(diffStat(afterAttributeNoise, noiseBefore, 'mutationAuditMs')) ? diffStat(afterAttributeNoise, noiseBefore, 'mutationAuditMs') : 0) : null,
          attributeNoiseMutationAuditCount: diffStat(afterAttributeNoise, noiseBefore, 'mutationAuditCount'),
          attributeNoiseMutationAuditFallbacks: diffStat(afterAttributeNoise, noiseBefore, 'mutationAuditFallbacks'),
          attributeNoisePeakQueueCandidateObserver,
          initialGeometryChecks: initialStats.geometryChecks ?? null, scrollGeometryChecks: diffStat(afterScroll, initialStats, 'geometryChecks'),
          initialPrunedBranches: initialStats.prunedBranches ?? null, scrollPrunedBranches: diffStat(afterScroll, initialStats, 'prunedBranches'),
          initialDiscoveryPasses: initialStats.discoveryPasses ?? null, scrollDiscoveryPasses: diffStat(afterScroll, initialStats, 'discoveryPasses'),
          peakQueueCandidateObserver, peakOwnedNodes, translatedNodes: stats.translatedNodes,
          restoreVisitedNodes: restored.restoreVisitedNodes ?? null, restoredNodes: restored.restoredNodes, preservedExternalNodes: restored.preservedExternalNodes,
        });
      } finally {
        ticking = false;
        sampleStats = false;
        clearTimeout(heartbeatTimer);
        initialTaskMeter?.disconnect();
        scrollTaskMeter?.disconnect();
        attributeNoiseTaskMeter?.disconnect();
        restoreMeter?.disconnect();
        await instance.cleanup();
        if (noiseOriginallyPresent) root.setAttribute('data-benchmark-noise', noiseOriginalValue);
        else root.removeAttribute('data-benchmark-noise');
      }
    }
  }
  globalThis.TranslateItPageBenchmark = { run };
})();

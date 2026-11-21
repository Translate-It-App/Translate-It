import { CUSTOM_FIXTURE_MODEL, CUSTOM_FIXTURE_URL } from './custom-fixture.mjs';
import { GEMINI_FIXTURE_KEY, GEMINI_FIXTURE_MODEL, GEMINI_FIXTURE_URL } from './gemini-fixture.mjs';

export const SUPPORTED_SCENARIOS = Object.freeze(['small', 'dynamic-dom', 'shadow-dom', 'spa-navigation', 'early-visible', 'in-window-visible', 'late-visible', 'scroll-through']);
export const SCROLL_SCHEDULING_MODES = Object.freeze(['fluid', 'on-stop']);
export const COMPARISON_MODES = Object.freeze(['sliced', 'viewport']);
export const MODE_DISCOVERY_FLAGS = Object.freeze({
  legacy: Object.freeze({ slicedDiscoveryEnabled: false, viewportFirstDiscoveryEnabled: false }),
  sliced: Object.freeze({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }),
  viewport: Object.freeze({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: true }),
});
export const BENCH_PROVIDERS = Object.freeze(['googlev2', 'custom', 'gemini', 'edge']);

export function parseProviderLane(env = {}) {
  const pageBatchSize = env.BENCH_PAGE_BATCH_SIZE;
  const pageWorkerCap = env.BENCH_PAGE_WORKERS;
  if ((pageBatchSize === undefined) !== (pageWorkerCap === undefined)) {
    throw new TypeError('BENCH_PAGE_BATCH_SIZE and BENCH_PAGE_WORKERS must be provided together.');
  }
  if (pageBatchSize !== undefined && !['10', '25'].includes(pageBatchSize)) {
    throw new TypeError('BENCH_PAGE_BATCH_SIZE must be 10 or 25.');
  }
  if (pageWorkerCap !== undefined && !['2', '4'].includes(pageWorkerCap)) {
    throw new TypeError('BENCH_PAGE_WORKERS must be 2 or 4.');
  }
  if (env.BENCH_LANE !== undefined && !['discovery', 'provider'].includes(env.BENCH_LANE)) {
    throw new TypeError(`Unsupported BENCH_LANE: ${env.BENCH_LANE}`);
  }
  if ((env.BENCH_LANE ?? 'discovery') !== 'provider') {
    if (pageBatchSize !== undefined) throw new TypeError('Page batch overrides require BENCH_LANE=provider.');
    return null;
  }
  const provider = env.BENCH_PROVIDER;
  if (!provider || !BENCH_PROVIDERS.includes(provider)) throw new TypeError(`Provider lane requires BENCH_PROVIDER to be one of: ${BENCH_PROVIDERS.join(', ')}.`);
  if (!['edge', 'googlev2', 'custom', 'gemini'].includes(provider)) throw new TypeError(`Provider lane adapter "${provider}" is not implemented.`);
  if (!['1', '3', '5'].includes(env.BENCH_OPTIMIZATION_LEVEL)) throw new TypeError('Provider lane requires BENCH_OPTIMIZATION_LEVEL=1, 3, or 5.');
  if (env.BENCH_MODES !== undefined && env.BENCH_MODES !== '' && env.BENCH_MODES.split(',').map(value => value.trim()).some(mode => mode !== 'sliced')) {
    throw new TypeError('Provider lane requires production-default sliced discovery; use BENCH_MODES=sliced or omit BENCH_MODES.');
  }
  return Object.freeze({ lane: 'provider', provider, optimizationLevel: Number(env.BENCH_OPTIMIZATION_LEVEL), mode: 'sliced',
    ...(pageBatchSize === undefined ? {} : { pageBatchSize: Number(pageBatchSize), pageWorkerCap: Number(pageWorkerCap) }) });
}

export function shouldRunProviderPerformanceLane(providerLane, customStaleSuccess = false) {
  return !!providerLane && customStaleSuccess !== true;
}

export function providerPerformanceCommand({ provider, optimizationLevel, scenarios, scrollSchedulingMode, samples, warmups, pageBatchSize, pageWorkerCap }) {
  return `BENCH_LANE=provider BENCH_PROVIDER=${provider} BENCH_OPTIMIZATION_LEVEL=${optimizationLevel}${pageBatchSize === undefined ? '' : ` BENCH_PAGE_BATCH_SIZE=${pageBatchSize} BENCH_PAGE_WORKERS=${pageWorkerCap}`} BENCH_MODES=sliced BENCH_SCENARIOS=${scenarios.join(',')}${scenarios.includes('scroll-through') && scrollSchedulingMode ? ` BENCH_SCROLL_SCHEDULING=${scrollSchedulingMode}` : ''} BENCH_SAMPLES=${samples} BENCH_WARMUPS=${warmups} node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
}

export function providerLaneSettings(settings, { provider, optimizationLevel }) {
  return Object.freeze({ ...settings, TRANSLATION_API: provider, PROVIDER_OPTIMIZATION_LEVELS: { [provider]: optimizationLevel },
      ...(provider === 'custom' ? { CUSTOM_API_URL: CUSTOM_FIXTURE_URL, CUSTOM_API_KEY: '', CUSTOM_API_MODEL: CUSTOM_FIXTURE_MODEL,
      WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true } : {}),
      ...(provider === 'gemini' ? { GEMINI_API_URL: GEMINI_FIXTURE_URL, GEMINI_API_KEY: GEMINI_FIXTURE_KEY,
        GEMINI_MODEL: GEMINI_FIXTURE_MODEL, GEMINI_MODEL_SOURCE: 'legacy', WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true } : {}) });
}

export function pageTranslationStartMessage(provider = 'edge') {
  return { action: 'page-translate', data: { provider, targetLanguage: 'fr' } };
}

export function validateProviderRuntime({ requestedProvider, requestedOptimizationLevel, snapshot, expectedBatching, pageWorkerCap }) {
  const issues = [];
  if (snapshot?.provider !== requestedProvider) issues.push(`effective provider mismatch: expected ${requestedProvider}, got ${snapshot?.provider ?? 'unavailable'}`);
  if (snapshot?.optimizationLevel !== requestedOptimizationLevel) issues.push(`effective optimization level mismatch: expected ${requestedOptimizationLevel}, got ${snapshot?.optimizationLevel ?? 'unavailable'}`);
  const batchingExpectation = expectedBatching ?? snapshot?.expectedBatching;
  if (!snapshot?.batching || !batchingExpectation || JSON.stringify(snapshot.batching) !== JSON.stringify(batchingExpectation)) issues.push('effective provider batching configuration mismatch');
  if (!Number.isFinite(snapshot?.maxConcurrent) || snapshot.maxConcurrent < 1) issues.push('effective scheduler concurrency unavailable');
  else if (Number.isFinite(snapshot.configuredMaxConcurrent) && snapshot.maxConcurrent !== snapshot.configuredMaxConcurrent) issues.push('effective scheduler concurrency mismatch');
  if (requestedProvider === 'custom') {
    const expected = { 1: 1, 3: 2, 5: 4 }[requestedOptimizationLevel];
    if (!expected || snapshot?.batching?.characterLimit !== 5000) issues.push(`Custom characterLimit mismatch: expected 5000, got ${snapshot?.batching?.characterLimit ?? 'unavailable'}`);
    if (snapshot?.maxConcurrent !== expected) issues.push(`Custom provider limiter mismatch: expected ${expected ?? 'unsupported'}, got ${snapshot?.maxConcurrent ?? 'unavailable'}`);
  } else if (requestedProvider === 'googlev2') {
    const expected = { 1: { characterLimit: 7500, maxConcurrent: 1 }, 3: { characterLimit: 5000, maxConcurrent: 4 }, 5: { characterLimit: 3000, maxConcurrent: 8 } }[requestedOptimizationLevel];
    if (expected && pageWorkerCap !== undefined) expected.maxConcurrent = pageWorkerCap * 2;
    if (!expected || snapshot?.batching?.characterLimit !== expected.characterLimit) issues.push(`Google V2 characterLimit mismatch: expected ${expected?.characterLimit ?? 'unsupported'}, got ${snapshot?.batching?.characterLimit ?? 'unavailable'}`);
    if (snapshot?.maxConcurrent !== expected?.maxConcurrent) issues.push(`Google V2 provider limiter mismatch: expected ${expected?.maxConcurrent ?? 'unsupported'}, got ${snapshot?.maxConcurrent ?? 'unavailable'}`);
  } else if (requestedProvider === 'gemini') {
    const expected = { 1: { optimalSize: 50, characterLimit: 5000, maxConcurrent: 1 },
      3: { optimalSize: 20, characterLimit: 5000, maxConcurrent: 3 },
      5: { optimalSize: 6, characterLimit: 5000, maxConcurrent: 6 } }[requestedOptimizationLevel];
    if (!expected || snapshot?.batching?.optimalSize !== expected.optimalSize
        || snapshot?.batching?.characterLimit !== expected.characterLimit) {
      issues.push(`Gemini batching mismatch: expected ${JSON.stringify(expected ?? 'supported levels 1, 3, 5')}, got ${JSON.stringify(snapshot?.batching ?? null)}`);
    }
    if (snapshot?.maxConcurrent !== expected?.maxConcurrent) issues.push(`Gemini provider limiter mismatch: expected ${expected?.maxConcurrent ?? 'unsupported'}, got ${snapshot?.maxConcurrent ?? 'unavailable'}`);
  }
  return { ok: issues.length === 0, issues, requestedProvider, requestedOptimizationLevel, observed: snapshot ?? null, expectedBatching };
}

export function validateProviderSchedulerRuntime({ provider, optimizationLevel, providerRuntime, scheduler, pageBatchSize, pageWorkerCap }) {
  const issues = [];
  const multipliers = { 1: 2, 2: 1.5, 3: 1, 4: 0.7, 5: 0.4 };
  let expectedChunkSize = provider === 'gemini' ? ({ 1: 80, 3: 30, 5: 15 }[optimizationLevel] ?? null)
    : provider === 'custom' ? ({ 1: 50, 3: 25, 5: 10 }[optimizationLevel] ?? null)
    : Math.max(Math.floor(25 * (multipliers[optimizationLevel] ?? 1)), 5);
  const expectedMaxChars = provider === 'custom' ? 5000 : provider === 'gemini' ? 15000 : providerRuntime?.batching?.characterLimit;
  let expectedMaxConcurrentFlushes = provider === 'googlev2'
    ? Math.max(1, Math.min(4, Math.floor((providerRuntime?.maxConcurrent ?? 0) / 2)))
    : providerRuntime?.maxConcurrent;
  if (pageWorkerCap !== undefined) expectedMaxConcurrentFlushes = pageWorkerCap;
  if (pageBatchSize !== undefined) expectedChunkSize = pageBatchSize;
  const pageWorkerLimit = expectedMaxConcurrentFlushes;
  const parallelExecution = ['custom', 'gemini'].includes(provider)
    || (provider === 'googlev2' && (optimizationLevel > 1 || pageWorkerCap > 1));
  if (!scheduler || typeof scheduler !== 'object') issues.push('effective PageTranslationScheduler batch configuration unavailable');
  else {
    if (scheduler.providerRegistryId !== provider) issues.push(`scheduler provider mismatch: expected ${provider}, got ${scheduler.providerRegistryId ?? 'unavailable'}`);
    if (scheduler.chunkSize !== expectedChunkSize) issues.push(`scheduler chunkSize mismatch: expected ${expectedChunkSize}, got ${scheduler.chunkSize ?? 'unavailable'}`);
    if (!Number.isFinite(expectedMaxChars) || scheduler.maxChars !== expectedMaxChars) issues.push(`scheduler maxChars mismatch: expected ${expectedMaxChars ?? 'unavailable'}, got ${scheduler.maxChars ?? 'unavailable'}`);
    if (scheduler.parallelExecution !== parallelExecution) issues.push(`scheduler parallelExecution mismatch: expected ${parallelExecution} for ${provider}, got ${String(scheduler.parallelExecution)}`);
    if (!Number.isFinite(expectedMaxConcurrentFlushes) || scheduler.maxConcurrentFlushes !== expectedMaxConcurrentFlushes) {
      issues.push(`scheduler maxConcurrentFlushes mismatch: expected ${expectedMaxConcurrentFlushes ?? 'unavailable'}, got ${scheduler.maxConcurrentFlushes ?? 'unavailable'}`);
    }
    if (['googlev2', 'custom', 'gemini'].includes(provider) && scheduler.pageWorkerLimit !== pageWorkerLimit) issues.push(`scheduler pageWorkerLimit mismatch: expected ${pageWorkerLimit}, got ${scheduler.pageWorkerLimit ?? 'unavailable'}`);
  }
  return { ok: issues.length === 0, provider, optimizationLevel, expected: {
    providerRegistryId: provider, chunkSize: expectedChunkSize, maxChars: expectedMaxChars,
    parallelExecution,
    maxConcurrentFlushes: expectedMaxConcurrentFlushes, ...(['googlev2', 'custom', 'gemini'].includes(provider) ? { pageWorkerLimit } : {}),
  }, observed: scheduler ?? null, issues };
}

export function validateProviderNetworkCorrelation(fetchRequests, networkEvents) {
  const issues = [];
  const key = (sessionId, networkId) => `${sessionId}:${networkId}`;
  const eventsByKey = new Map();
  for (const event of networkEvents ?? []) {
    if (!event.sessionId || !event.networkId) {
      issues.push('provider Network event lacks actual sessionId or network requestId');
      continue;
    }
    const id = key(event.sessionId, event.networkId);
    if (eventsByKey.has(id)) issues.push(`duplicate provider Network request ID: ${id}`);
    else eventsByKey.set(id, event);
  }
  const seen = new Set();
  for (const request of fetchRequests ?? []) {
    const id = request.networkId && request.targetSessionId ? key(request.targetSessionId, request.networkId) : null;
    if (!id) {
      issues.push('provider Fetch request lacks correlated Network session/request ID');
      continue;
    }
    if (seen.has(id)) issues.push(`duplicate provider Fetch correlation: ${id}`);
    seen.add(id);
    if (!eventsByKey.has(id)) issues.push(`provider Fetch request has no Network request: ${id}`);
  }
  for (const id of eventsByKey.keys()) if (!seen.has(id)) issues.push(`orphan provider Network request: ${id}`);
  return { ok: issues.length === 0, issues };
}

export function providerLaneFinalization({ buildParity, cleanupErrors = [], primaryError = null }) {
  return {
    passed: buildParity?.ok === true && cleanupErrors.length === 0 && !primaryError,
    comparisonsAllowed: false,
    reason: 'Provider lane is finalized independently; Legacy qualification and comparison gates do not apply.',
  };
}

export function summarizePhysicalProviderAttempts(attempts, { expectedTimeoutAbortAttemptId = null } = {}) {
  const issues = [];
  const intervals = [];
  const seen = new Set();
  for (const attempt of attempts ?? []) {
    if (!attempt.attemptId || seen.has(attempt.attemptId)) issues.push('provider attempt IDs must be present and unique');
    seen.add(attempt.attemptId);
    const expectedTimeoutAbort = attempt.attemptId === expectedTimeoutAbortAttemptId;
    if (!Number.isFinite(attempt.status) && !(expectedTimeoutAbort && attempt.outcome === 'failed')) {
      issues.push(`provider attempt ${attempt.attemptId ?? 'unknown'} lacks correlated response status`);
    }
    if (!['finished', 'failed'].includes(attempt.outcome)) issues.push(`provider attempt ${attempt.attemptId ?? 'unknown'} lacks terminal outcome`);
    if (!attempt.networkSessionId || !attempt.networkId) issues.push(`provider attempt ${attempt.attemptId ?? 'unknown'} lacks Fetch/Network correlation`);
    if (!Number.isFinite(attempt.startedAt) || !Number.isFinite(attempt.settledAt) || attempt.settledAt < attempt.startedAt) {
      issues.push(`provider attempt ${attempt.attemptId ?? 'unknown'} lacks valid terminal settlement`);
      continue;
    }
    if (expectedTimeoutAbort && attempt.outcome !== 'failed') {
      issues.push(`expected timeout provider attempt ${attempt.attemptId} lacks terminal failed outcome`);
    } else if (attempt.outcome === 'failed' && !expectedTimeoutAbort) {
      issues.push(`provider attempt ${attempt.attemptId} failed: ${attempt.error ?? 'unknown network error'}`);
    }
    intervals.push({ at: attempt.startedAt, delta: 1 }, { at: attempt.settledAt, delta: -1 });
  }
  intervals.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peakConcurrency = 0;
  for (const interval of intervals) { active += interval.delta; peakConcurrency = Math.max(peakConcurrency, active); }
  return {
    physicalRequestCount: attempts?.length ?? 0,
    peakPhysicalConcurrency: peakConcurrency,
    attempts: (attempts ?? []).map(attempt => ({ ...attempt,
      latencyMs: Number.isFinite(attempt.startedAt) && Number.isFinite(attempt.settledAt) ? attempt.settledAt - attempt.startedAt : null })),
    issues,
    ok: issues.length === 0,
    measurement: 'Physical HTTP request lifecycle from CDP Network requestWillBeSent through loadingFinished/loadingFailed; not scheduler batches or worker limits.',
  };
}

export function summarizeLogicalProviderBatches(batches, expectedSessionId) {
  const issues = [];
  const intervals = [];
  for (const [index, batch] of (batches ?? []).entries()) {
    if (!Array.isArray(batch.targetIds) || !batch.targetIds.length) issues.push(`logical batch ${index} has no target IDs`);
    if (!batch.sessionId || batch.sessionId !== expectedSessionId) issues.push(`logical batch ${index} has incorrect Page session ownership`);
    if (!Number.isFinite(batch.at) || !Number.isFinite(batch.settledAt) || batch.settledAt < batch.at
        || !['fulfilled', 'rejected'].includes(batch.outcome)) {
      issues.push(`logical batch ${index} lacks interval/terminal settlement`);
      continue;
    }
    intervals.push({ at: batch.at, delta: 1 }, { at: batch.settledAt, delta: -1 });
  }
  intervals.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peakConcurrency = 0;
  for (const interval of intervals) { active += interval.delta; peakConcurrency = Math.max(peakConcurrency, active); }
  return { logicalBatchCount: batches?.length ?? 0, logicalBatchSizes: (batches ?? []).map(batch => batch.targetIds?.length ?? null),
    peakLogicalBatchConcurrency: peakConcurrency, batches: batches ?? [], issues, ok: issues.length === 0,
    measurement: 'Observed PageTranslationScheduler._executeBatchRequest call-to-settlement intervals; logical batches are not assumed to map 1:1 to physical HTTP requests.' };
}

export function summarizeSpaLogicalProviderBatches(intervals, observedBatches, sessionA, sessionB) {
  const issues = [];
  if (!sessionA || !sessionB || sessionA === sessionB) issues.push('SPA logical batch evidence requires distinct A/B Page session IDs');
  const actual = intervals ?? [];
  const observed = observedBatches ?? [];
  const owned = [...actual.filter(batch => batch.sessionId === sessionA), ...actual.filter(batch => batch.sessionId === sessionB)];
  if (actual.length !== owned.length) issues.push('SPA logical batch intervals include missing or unexpected Page session ownership');
  if (actual.length !== observed.length) issues.push(`SPA logical batch interval count mismatch: expected ${observed.length}, got ${actual.length}`);
  for (const sessionId of [sessionA, sessionB]) {
    const actualForSession = actual.filter(batch => batch.sessionId === sessionId);
    const observedForSession = observed.filter(batch => batch.sessionId === sessionId);
    if (actualForSession.length !== observedForSession.length) {
      issues.push(`SPA logical batch count mismatch for ${sessionId}: expected ${observedForSession.length}, got ${actualForSession.length}`);
    }
    for (let index = 0; index < Math.min(actualForSession.length, observedForSession.length); index++) {
      if (JSON.stringify(actualForSession[index].targetIds) !== JSON.stringify(observedForSession[index].targetIds)) {
        issues.push(`SPA logical batch target IDs mismatch for ${sessionId} at index ${index}`);
      }
    }
  }
  const batchesA = summarizeLogicalProviderBatches(actual.filter(batch => batch.sessionId === sessionA), sessionA);
  const batchesB = summarizeLogicalProviderBatches(actual.filter(batch => batch.sessionId === sessionB), sessionB);
  return {
    ...batchesB,
    logicalBatchCount: batchesA.logicalBatchCount + batchesB.logicalBatchCount,
    logicalBatchSizes: [...batchesA.logicalBatchSizes, ...batchesB.logicalBatchSizes],
    peakLogicalBatchConcurrency: Math.max(batchesA.peakLogicalBatchConcurrency, batchesB.peakLogicalBatchConcurrency),
    batches: [...batchesA.batches, ...batchesB.batches],
    issues: [...issues, ...batchesA.issues, ...batchesB.issues],
    ok: issues.length === 0 && batchesA.ok && batchesB.ok,
  };
}

export function scrollThroughPhases(googleV2) {
  return googleV2
    ? [['band-2', 900, 1, 0], ['band-3', 2000, 2, 0], ['revisit-band-2', 900, 1, 0], ['revisit-initial', 0, null, 0]]
    : [['burst-band-2', 900, null, 0], ['burst-band-3', 2000, null, 150], ['settled-band-3', 2000, null, 750],
      ['revisit-band-2', 900, 1, 0], ['revisit-initial', 0, null, 0]];
}

export function usesBandedProviderScroll(provider) {
  return ['googlev2', 'custom', 'gemini'].includes(provider);
}

export function validateProviderConcurrencyObservations({ provider, optimizationLevel, targetCount, logical, physical,
  pageWorkerLimit, providerLimiterCapacity }) {
  const issues = [];
  if (!Number.isFinite(pageWorkerLimit) || pageWorkerLimit < 1) issues.push('observed Page worker limit unavailable');
  if (!Number.isFinite(logical?.peakLogicalBatchConcurrency) || logical.peakLogicalBatchConcurrency < 1) issues.push('observed logical batch concurrency unavailable');
  else if (logical?.peakLogicalBatchConcurrency > pageWorkerLimit) issues.push(`observed logical batch concurrency exceeds Page worker limit: ${logical.peakLogicalBatchConcurrency}/${pageWorkerLimit}`);
  if (!Number.isFinite(providerLimiterCapacity) || providerLimiterCapacity < 1) issues.push('observed provider limiter capacity unavailable');
  if (!Number.isFinite(physical?.peakPhysicalConcurrency) || physical.peakPhysicalConcurrency < 1) issues.push('observed physical HTTP concurrency unavailable');
  else if (physical?.peakPhysicalConcurrency > providerLimiterCapacity) issues.push(`observed physical HTTP concurrency exceeds provider limiter capacity: ${physical.peakPhysicalConcurrency}/${providerLimiterCapacity}`);
  if (['googlev2', 'custom', 'gemini'].includes(provider)) {
    if (targetCount !== 1000) issues.push(`${provider} concurrency demonstration requires 1000 targets, got ${targetCount ?? 'unavailable'}`);
    const validLevel = [1, 3, 5].includes(optimizationLevel);
    if (!validLevel) issues.push(`unsupported Google V2 optimization level: ${optimizationLevel}`);
    const observedPeaks = [logical?.peakLogicalBatchConcurrency, physical?.peakPhysicalConcurrency];
    const expected = optimizationLevel === 1 ? 1 : 2;
    if (validLevel && observedPeaks.some(peak => optimizationLevel === 1 ? peak !== expected : !Number.isFinite(peak) || peak <= 1)) {
      issues.push(`${provider} observed concurrency mismatch for level ${optimizationLevel}: expected ${optimizationLevel === 1 ? 'serial peak 1' : 'overlap >1'}, got logical=${observedPeaks[0] ?? 'unavailable'}, physical=${observedPeaks[1] ?? 'unavailable'}`);
    }
  }
  return { ok: issues.length === 0, issues, observed: { targetCount, pageWorkerLimit, providerLimiterCapacity,
    peakLogicalBatchConcurrency: logical?.peakLogicalBatchConcurrency ?? null,
    peakPhysicalConcurrency: physical?.peakPhysicalConcurrency ?? null } };
}

export function observedPageWorkerLimit(scheduler) {
  return scheduler?.pageWorkerLimit ?? scheduler?.maxConcurrentFlushes ?? null;
}

export function isProviderWorkloadTrial({ networkGuardProbe = false, cancellationProbe = null, staleSuccessProbe = null, phase = '' } = {}) {
  return !networkGuardProbe && !cancellationProbe && !staleSuccessProbe && !String(phase).startsWith('non-performance-');
}

export function validateSampleCount(value) {
  if (!Number.isInteger(value) || value < 3 || value > 40) throw new TypeError('BENCH_SAMPLES must be an integer between 3 and 40.');
  return value;
}

export function validateDiscoveryFlags(mode, observed) {
  const expected = MODE_DISCOVERY_FLAGS[mode];
  const issues = expected ? Object.keys(expected).filter(key => observed?.[key] !== expected[key]) : [`unsupported discovery mode: ${mode}`];
  return { ok: issues.length === 0, expected: expected ?? null, observed: observed ?? null, issues };
}

export function parseScenarioSelection(value = 'small') {
  const scenarios = String(value).split(',').map(scenario => scenario.trim()).filter(Boolean);
  if (!scenarios.length) throw new TypeError('BENCH_SCENARIOS must select at least one fixture scenario.');
  const seen = new Set();
  for (const scenario of scenarios) {
    if (!SUPPORTED_SCENARIOS.includes(scenario)) throw new TypeError(`Unsupported BENCH_SCENARIOS entry: ${scenario}`);
    if (seen.has(scenario)) throw new TypeError(`Duplicate BENCH_SCENARIOS entry: ${scenario}`);
    seen.add(scenario);
  }
  return scenarios;
}

export function parseScrollSchedulingMode(value) {
  if (value === undefined || value === '') return null;
  if (!SCROLL_SCHEDULING_MODES.includes(value)) throw new TypeError(`Unsupported BENCH_SCROLL_SCHEDULING: ${value}`);
  return value;
}

export function settingsForScenario(settings, scenario, schedulingMode = null) {
  if (scenario !== 'scroll-through' && schedulingMode !== null) throw new TypeError('Scroll scheduling is only supported by the scroll-through scenario.');
  if (scenario === 'scroll-through' && !SCROLL_SCHEDULING_MODES.includes(schedulingMode)) throw new TypeError('scroll-through requires BENCH_SCROLL_SCHEDULING=fluid or on-stop.');
  return Object.freeze({ ...settings, WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: scenario === 'dynamic-dom' || scenario === 'shadow-dom',
    ...(scenario === 'scroll-through' ? {
      WHOLE_PAGE_LAZY_LOADING: true,
      WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: schedulingMode === 'on-stop',
    } : {}),
    ...(scenario === 'spa-navigation' ? { WHOLE_PAGE_AUTO_TRANSLATE_RULES: ['127.0.0.1/replacement'], TRANSLATION_API: 'edge', TARGET_LANGUAGE: 'fr' } : {}) });
}

export function deriveScrollAcceptanceLatency(expectedIds, viewportEntryAtById, acceptedAtById) {
  const latencyMsById = {};
  const prefetchAcceptedIds = [];
  const issues = [];
  for (const id of expectedIds ?? []) {
    const enteredAt = viewportEntryAtById?.[id];
    const acceptedAt = acceptedAtById?.[id];
    if (!Number.isFinite(enteredAt)) issues.push(`missing actual viewport entry timestamp: ${id}`);
    if (!Number.isFinite(acceptedAt)) issues.push(`missing accepted DOM-write timestamp: ${id}`);
    if (!Number.isFinite(enteredAt) || !Number.isFinite(acceptedAt)) continue;
    const latency = acceptedAt - enteredAt;
    if (latency < 0) {
      latencyMsById[id] = null;
      prefetchAcceptedIds.push(id);
    } else latencyMsById[id] = latency;
  }
  return { latencyMsById, prefetchAcceptedIds, issues };
}

export function deriveScrollAggregateMetrics(scrollBands, viewportEntryAtById, acceptedAtById, expectedAcceptedIds = null) {
  const acceptedIds = expectedAcceptedIds ?? (scrollBands ?? []).flatMap(band => band.ids);
  const acceptedIdSet = new Set(acceptedIds);
  const latency = deriveScrollAcceptanceLatency(acceptedIds, viewportEntryAtById, acceptedAtById);
  const byBand = (scrollBands ?? []).map(({ band, ids }) => {
    const measurableIds = ids.filter(id => acceptedIdSet.has(id));
    const values = measurableIds.map(id => latency.latencyMsById[id]).filter(Number.isFinite).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return {
      band, targetCount: measurableIds.length, measurableCount: values.length, prefetchCount: measurableIds.filter(id => latency.prefetchAcceptedIds.includes(id)).length,
      meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      medianMs: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null,
      maxMs: values.length ? values.at(-1) : null,
    };
  });
  const entries = acceptedIds.map(id => viewportEntryAtById?.[id]).filter(Number.isFinite);
  const accepted = acceptedIds.map(id => acceptedAtById?.[id]).filter(Number.isFinite);
  const lastViewportEntryAt = entries.length ? Math.max(...entries) : null;
  const fullAcceptanceAt = accepted.length ? Math.max(...accepted) : null;
  const completionLatencyMs = Number.isFinite(lastViewportEntryAt) && Number.isFinite(fullAcceptanceAt)
    ? fullAcceptanceAt - lastViewportEntryAt : null;
  return {
    latencyByViewportBand: byBand,
    lastViewportEntryToFullAcceptance: {
      lastViewportEntryAt, fullAcceptanceAt, latencyMs: completionLatencyMs,
      fullAcceptanceBeforeLastViewportEntry: Number.isFinite(completionLatencyMs) && completionLatencyMs < 0,
    },
  };
}

export function validateScrollThroughStages(expectedIds, stages = {}) {
  const stageNames = ['bridgeDiscoveredAtById', 'intersectionSchedulerRegisteredAtById', 'intersectionCallbackAtById', 'schedulerAdmissionAtById', 'schedulerEnqueueAtById'];
  const issues = [];
  for (const id of expectedIds ?? []) {
    const times = stageNames.map(name => stages?.[name]?.[id]);
    for (const [index, name] of stageNames.entries()) {
      if (!Number.isFinite(times[index])) issues.push(`missing ${name} stage: ${id}`);
    }
    if (times.every(Number.isFinite) && times.some((at, index) => index > 0 && at < times[index - 1])) {
      issues.push(`scroll pipeline stages are out of order: ${id}`);
    }
  }
  for (const name of stageNames) {
    issues.push(...validateExactTargetIds(name, Object.keys(stages?.[name] ?? {}), expectedIds ?? []).issues);
  }
  return { ok: issues.length === 0, issues };
}

export function validateScrollThroughObservations(expectedIds, phases, selections) {
  const issues = [];
  if (!Array.isArray(phases) || phases.length === 0) issues.push('scroll checkpoint observations unavailable');
  else phases.forEach((phase, index) => {
    if (typeof phase?.scheduler?.isScrolling !== 'boolean') issues.push(`scroll checkpoint isScrolling state unavailable: ${index}`);
  });
  if (!Array.isArray(selections) || selections.length === 0) issues.push('scheduler selection observations unavailable');
  const selectedIds = [];
  for (const [index, selection] of (selections ?? []).entries()) {
    if (!Number.isFinite(selection?.at)) issues.push(`scheduler selection timestamp unavailable: ${index}`);
    if (typeof selection?.isScrolling !== 'boolean') issues.push(`scheduler selection isScrolling state unavailable: ${index}`);
    if (!Array.isArray(selection?.targetIds) || !Array.isArray(selection?.targets)
        || JSON.stringify(selection.targetIds) !== JSON.stringify(selection.targets.map(target => target?.id))) {
      issues.push(`scheduler selection geometry does not exactly match selected target IDs: ${index}`);
      continue;
    }
    for (const target of selection.targets) {
      if (!['viewport', 'permitted-50px-buffer', 'outside-buffer'].includes(target.classification)) {
        issues.push(`missing scheduler selection-time geometry classification: ${target.id ?? 'unknown'}`);
      }
    }
    selectedIds.push(...selection.targetIds);
  }
  const observedIds = [...new Set(selectedIds)];
  issues.push(...validateExactTargetIds('scheduler selection', observedIds, expectedIds ?? []).issues);
  return { ok: issues.length === 0, issues };
}

export function validateScrollThroughEvidence({ expectedIds, expectedAcceptedIds = expectedIds, viewportEntryAtById, acceptedAtById, pipelineStages, checkpoints, selectionViewport, terminalAt, acceptedIds, duplicateAcceptedIds = [], providerRequests = [], schedulerState, restoreOriginals, expectedOriginals, cleanupErrors = [] }) {
  const issues = [];
  const stageValidation = validateScrollThroughStages(expectedIds, pipelineStages);
  issues.push(...stageValidation.issues);
  const observationValidation = validateScrollThroughObservations(expectedIds, checkpoints, selectionViewport);
  issues.push(...observationValidation.issues);
  const latency = deriveScrollAcceptanceLatency(expectedAcceptedIds, viewportEntryAtById, acceptedAtById);
  issues.push(...latency.issues);
  issues.push(...validateExactTargetIds('scroll acceptance', acceptedIds, expectedAcceptedIds ?? []).issues);
  issues.push(...validateExactTargetIds('accepted DOM-write timestamp', Object.keys(acceptedAtById ?? {}), expectedAcceptedIds ?? []).issues);
  if (duplicateAcceptedIds.length) issues.push(`redundant accepted writes: ${duplicateAcceptedIds.join(',')}`);
  const requestIds = (providerRequests ?? []).flatMap(request => request.requestViewport?.targets?.map(target => target.id).filter(Boolean) ?? []);
  issues.push(...validateExactTargetIds('physical provider request', requestIds, expectedIds ?? []).issues);
  for (const request of providerRequests ?? []) {
    for (const target of request.requestViewport?.targets ?? []) {
      if (Number.isFinite(acceptedAtById?.[target.id]) && acceptedAtById[target.id] <= request.requestViewport.at) issues.push(`target was physically re-requested after acceptance: ${target.id}`);
      if (!['viewport', 'permitted-50px-buffer', 'outside-buffer'].includes(target.classification)) issues.push(`missing physical request viewport classification: ${target.id}`);
    }
  }
  if (!Number.isFinite(terminalAt) || Object.values(acceptedAtById ?? {}).some(at => !Number.isFinite(at) || terminalAt < at)) issues.push('matching terminal is missing or precedes latest accepted write');
  if (schedulerState?.managerTranslating !== false || schedulerState?.activeFlushes !== 0
      || schedulerState?.queueIds?.length !== 0 || schedulerState?.pendingSettlementCount !== 0
      || schedulerState?.discoveryPending !== false) issues.push('scheduler/discovery work was not drained at the terminal');
  if (!Array.isArray(restoreOriginals) || JSON.stringify(restoreOriginals) !== JSON.stringify(expectedOriginals)) issues.push('Restore originals do not exactly match the fixture');
  if (cleanupErrors.length) issues.push('measurement cleanup reported errors');
  return { ok: issues.length === 0, issues, viewportEntryToAcceptedWriteLatencyMsById: latency.latencyMsById,
    prefetchAcceptedIds: latency.prefetchAcceptedIds, pipelineStageValidation: stageValidation,
    schedulerObservationValidation: observationValidation };
}

export function modeOrder(selectedModes, scenarioIndex, measuredOrdinalIndex) {
  if (!Array.isArray(selectedModes) || selectedModes.length === 0) return [];
  const offset = (scenarioIndex + measuredOrdinalIndex) % selectedModes.length;
  return [...selectedModes.slice(offset), ...selectedModes.slice(0, offset)];
}

export function validateFixtureGeometry(fixture, observed) {
  const issues = [];
  if (!fixture || !Array.isArray(fixture.targets) || !Array.isArray(fixture.visibleIds)) issues.push('fixture target/visible oracle unavailable');
  else {
    if (fixture.targets.length !== fixture.targetCount) issues.push(`fixture target count mismatch: ${fixture.targets.length}/${fixture.targetCount}`);
    const ids = fixture.targets.map(target => target.id);
    if (new Set(ids).size !== ids.length) issues.push('fixture target IDs are not unique');
    if (JSON.stringify(fixture.targetTexts) !== JSON.stringify(fixture.targets.map(target => target.source))) issues.push('fixture targetTexts do not follow canonical DOM target order');
    if (new Set(fixture.visibleIds).size !== fixture.visibleIds.length) issues.push('fixture visible IDs are not unique');
  }
  if (!observed) issues.push('actual viewport geometry unavailable');
  else {
    if (observed.viewport?.width !== fixture?.viewport?.width || observed.viewport?.height !== fixture?.viewport?.height) issues.push('actual viewport does not match fixture configuration');
    if (observed.scroll?.x !== fixture?.scroll?.x || observed.scroll?.y !== fixture?.scroll?.y) issues.push('actual scroll position does not match fixture configuration');
    if (JSON.stringify(observed.visibleIds) !== JSON.stringify(fixture?.visibleIds)) issues.push('actual visible IDs do not match fixture geometry oracle');
    if (observed.targetCount !== fixture?.targetCount) issues.push(`actual page target count mismatch: ${observed.targetCount}/${fixture?.targetCount}`);
  }
  return { ok: issues.length === 0, issues };
}

export function validateShadowInitialObservations({ fixture, observedTargets, observedGeometry }) {
  const issues = [];
  const expected = fixture?.targets ?? [];
  const observed = Array.isArray(observedTargets) ? observedTargets : [];
  issues.push(...validateExactTargetIds('observed initial source', observed.map(target => target?.[0]), expected.map(target => target.id)).issues);
  for (const [id, source] of observed) {
    const target = expected.find(item => item.id === id);
    if (target && source !== target.source) issues.push(`observed initial source mismatch: ${id}`);
  }
  const geometry = validateFixtureGeometry(fixture, observedGeometry);
  issues.push(...geometry.issues);
  return { ok: issues.length === 0, issues, geometry };
}

export function shadowInitialTranslationReadiness({ expectedIds, expectedSessionId, observedSessionId, schedulerState,
  bridgeDiscoveryDrained, admissions, enqueues, settlements, acceptedDomIds }) {
  const issues = [];
  if (typeof expectedSessionId !== 'string' || !expectedSessionId || observedSessionId !== expectedSessionId) {
    issues.push('initial translation session does not match the expected session');
  }
  if (schedulerState?.discoveryPending !== false || schedulerState?.pendingSettlementCount !== 0
      || !Array.isArray(schedulerState?.queueIds) || schedulerState.queueIds.length !== 0
      || schedulerState?.activeFlushes !== 0) issues.push('scheduler discovery or settlement work is not drained');
  if (bridgeDiscoveryDrained !== true) issues.push('Bridge discovery is not drained');
  for (const [name, ids] of [['initial admission', admissions], ['initial enqueue', enqueues], ['accepted DOM write', acceptedDomIds]]) {
    issues.push(...validateExactTargetIds(name, ids, expectedIds ?? []).issues);
  }
  if (!Array.isArray(settlements)) issues.push('initial accepted settlements unavailable');
  else {
    const settlementIds = settlements.map(item => item?.id);
    issues.push(...validateExactTargetIds('accepted settlement', settlementIds, expectedIds ?? []).issues);
    if (settlements.some(item => item?.sessionId !== expectedSessionId)) issues.push('accepted settlements do not belong to the expected session');
  }
  return { ready: issues.length === 0, issues };
}

export function validateExactTargetIds(name, observedIds, expectedIds) {
  if (!Array.isArray(observedIds)) return { ok: false, issues: [`${name} target IDs unavailable`] };
  const expected = new Set(expectedIds);
  const counts = new Map();
  const issues = [];
  for (const id of observedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (!expected.has(id)) issues.push(`unexpected ${name} target ID: ${String(id)}`);
    if (count > 1) issues.push(`duplicate ${name} target ID: ${String(id)}`);
  }
  for (const id of expected) if (!counts.has(id)) issues.push(`missing ${name} target ID: ${id}`);
  return { ok: issues.length === 0, issues };
}

export function validateSpaTerminal({ event, sessionId, targetIds, acceptedAtById, acceptedIds = Object.keys(acceptedAtById ?? {}), expectedAcceptedIds = targetIds }) {
  const message = event?.message;
  const data = message?.data?.data;
  const issues = [];
  if (message?.action !== 'page-translation-frame-lifecycle'
      || !['page-translate-complete', 'page-translate-idle'].includes(message?.data?.action)
      || data?.sessionId !== sessionId) issues.push('SPA terminal does not belong to the expected translation session');
  if (data?.translatedCount !== targetIds.length || data?.totalCount !== targetIds.length || data?.failedCount !== 0) {
    issues.push('SPA terminal does not prove full successful route completion');
  }
  const acceptedTimes = Object.values(acceptedAtById ?? {});
  if (acceptedAtById && (Object.keys(acceptedAtById).some(id => !targetIds.includes(id))
      || acceptedTimes.some(at => !Number.isFinite(at)) || !Number.isFinite(event?.performanceAt)
      || acceptedTimes.some(at => event.performanceAt < at))) {
    issues.push('SPA terminal timestamp is missing or precedes an accepted route write');
  }
  if (acceptedIds && validateExactTargetIds('terminal accepted ledger', acceptedIds, expectedAcceptedIds).issues.length) {
    issues.push('SPA terminal does not prove acceptance of every target in the session ledger');
  }
  return { ok: issues.length === 0, issues, terminalAt: event?.performanceAt ?? null, counts: {
    translatedCount: data?.translatedCount ?? null, totalCount: data?.totalCount ?? null, failedCount: data?.failedCount ?? null,
  } };
}

export function validateSpaProviderRoute({ provider, requests, expectedIds }) {
  const issues = [];
  if (provider !== 'edge') issues.push(`SPA route provider must be edge, got ${provider ?? 'unavailable'}`);
  if (!Array.isArray(requests) || !requests.length) issues.push('SPA provider request evidence is unavailable');
  const ids = [];
  for (const request of requests ?? []) {
    let url;
    try { url = new URL(request.url); } catch { /* reported below */ }
    if (request.category !== 'provider-translation' || request.method !== 'POST'
        || url?.origin !== 'https://edge.microsoft.com' || url?.pathname !== '/translate/translatetext') {
      issues.push(`SPA route request was not the local Edge fixture transport: ${request.method ?? '?'} ${request.url ?? '?'}`);
    }
    ids.push(...(request.targetIds ?? []));
  }
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const id of expectedIds) expectedCounts.set(id, (expectedCounts.get(id) ?? 0) + 1);
  for (const id of ids) actualCounts.set(id, (actualCounts.get(id) ?? 0) + 1);
  for (const [id, count] of expectedCounts) if (actualCounts.get(id) !== count) issues.push(`SPA Edge provider target count mismatch for ${id}: expected ${count}, got ${actualCounts.get(id) ?? 0}`);
  for (const id of actualCounts.keys()) if (!expectedCounts.has(id)) issues.push(`unexpected SPA Edge provider target ID: ${id}`);
  return { ok: issues.length === 0, issues, provider, targetIds: ids };
}

export function validateSpaNavigation({ cursorA, cursorB, navStartedAt, stopAt, invalidatedAt, sourceUpdatedAt, firstAcceptedAtById, terminalAt, changedIds, retainedIds, requestedIds, acceptedIds, duplicateIds, completionReady }) {
  const issues = [];
  let bPath = null;
  let sameOrigin = false;
  try { bPath = new URL(cursorB?.url).pathname; } catch { /* invalid real cursor */ }
  try { sameOrigin = new URL(cursorA?.url).origin === new URL(cursorB?.url).origin; } catch { /* invalid real cursor */ }
  if (!cursorA || !cursorB || cursorA.documentEpoch !== cursorB.documentEpoch
      || !Number.isSafeInteger(cursorA.routeRevision) || !Number.isSafeInteger(cursorB.routeRevision)
      || cursorB.routeRevision <= cursorA.routeRevision || bPath !== '/replacement' || !sameOrigin) {
    issues.push('SPA navigation did not preserve the document and advance the real route cursor to /replacement');
  }
  if (!Number.isFinite(navStartedAt) || !Number.isFinite(terminalAt) || terminalAt < navStartedAt || completionReady !== true) {
    issues.push('SPA navigation timing is unavailable or lacks a verified matching B terminal');
  }
  if (!Number.isFinite(stopAt) || !Number.isFinite(invalidatedAt) || !Number.isFinite(sourceUpdatedAt)
      || !(navStartedAt < stopAt && stopAt <= invalidatedAt && invalidatedAt < sourceUpdatedAt)) {
    issues.push('SPA navigation, production Stop/invalidation, and B-source mutation are not ordered on one document clock');
  }
  const exact = (name, actual, expected) => issues.push(...validateExactTargetIds(name, actual, expected).issues);
  exact('B accepted write', Object.keys(firstAcceptedAtById ?? {}), changedIds);
  exact('B provider request', requestedIds, changedIds);
  const changed = new Set(changedIds);
  for (const id of retainedIds) if (changed.has(id)) issues.push(`retained ID is also marked changed: ${id}`);
  for (const id of requestedIds) if (retainedIds.includes(id)) issues.push(`retained target was redundantly requested in B: ${id}`);
  for (const id of acceptedIds) if (retainedIds.includes(id)) issues.push(`retained target received a redundant B accepted write: ${id}`);
  if ((duplicateIds ?? []).length) issues.push(`duplicate B accepted writes: ${duplicateIds.join(',')}`);
  if (changedIds.some(id => !Number.isFinite(firstAcceptedAtById?.[id]) || firstAcceptedAtById[id] < sourceUpdatedAt)
      || changedIds.some(id => firstAcceptedAtById?.[id] > terminalAt)
      || !Number.isFinite(Math.min(...changedIds.map(id => firstAcceptedAtById?.[id] ?? Infinity)))) {
    issues.push('SPA navigation accepted-write timing is unavailable or not ordered before matching B terminal');
  }
  return { ok: issues.length === 0, issues, firstAcceptedAt: Math.min(...changedIds.map(id => firstAcceptedAtById?.[id] ?? Infinity)), completionAt: terminalAt,
    navigationToFirstAcceptedMs: Math.min(...changedIds.map(id => firstAcceptedAtById?.[id] ?? Infinity)) - navStartedAt,
    navigationToCompletionMs: terminalAt - navStartedAt };
}

export function validateSpaSessions({ settingsA, settingsB, autoB, sessionA, sessionB }) {
  const issues = [];
  if (!settingsA || !settingsB || JSON.stringify(settingsA) !== JSON.stringify(settingsB)
      || settingsA.targetLanguage !== 'fr' || settingsA.lazyLoading !== false
      || settingsA.translateAfterScrollStop !== false || settingsA.autoTranslateOnDOMChanges !== false
      || settingsA.provider !== 'edge' || settingsB.provider !== 'edge') {
    issues.push('Route A/B effective settings differ or do not match the SPA trial configuration');
  }
  if (autoB !== true || typeof sessionA !== 'string' || !sessionA || typeof sessionB !== 'string' || !sessionB || sessionA === sessionB) {
    issues.push('Route B was not a distinct production automatic manager session');
  }
  return { ok: issues.length === 0, issues };
}

export function validateSpaObserverRestoreOrder({ spaObserverStoppedAt, measurementObserverStoppedAt, restoreStartedAt }) {
  const issues = [];
  if (!Number.isFinite(spaObserverStoppedAt) || !Number.isFinite(measurementObserverStoppedAt)
      || !Number.isFinite(restoreStartedAt) || spaObserverStoppedAt > restoreStartedAt
      || measurementObserverStoppedAt > restoreStartedAt) {
    issues.push('SPA and measurement observers must stop before PAGE_RESTORE starts');
  }
  return { ok: issues.length === 0, issues };
}

export function mapProviderBatchIds(providerBatches, sourceToId) {
  return providerBatches.map(batch => batch.map(source => sourceToId.get(source) ?? null));
}

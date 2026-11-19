export const SUPPORTED_SCENARIOS = Object.freeze(['small', 'dynamic-dom', 'spa-navigation', 'early-visible', 'in-window-visible', 'late-visible', 'scroll-through']);
export const SCROLL_SCHEDULING_MODES = Object.freeze(['fluid', 'on-stop']);
export const COMPARISON_MODES = Object.freeze(['sliced', 'viewport']);
export const MODE_DISCOVERY_FLAGS = Object.freeze({
  legacy: Object.freeze({ slicedDiscoveryEnabled: false, viewportFirstDiscoveryEnabled: false }),
  sliced: Object.freeze({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }),
  viewport: Object.freeze({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: true }),
});

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
  return Object.freeze({ ...settings, WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: scenario === 'dynamic-dom',
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

export function deriveScrollAggregateMetrics(scrollBands, viewportEntryAtById, acceptedAtById) {
  const latency = deriveScrollAcceptanceLatency((scrollBands ?? []).flatMap(band => band.ids), viewportEntryAtById, acceptedAtById);
  const byBand = (scrollBands ?? []).map(({ band, ids }) => {
    const values = ids.map(id => latency.latencyMsById[id]).filter(Number.isFinite).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return {
      band, targetCount: ids.length, measurableCount: values.length, prefetchCount: ids.filter(id => latency.prefetchAcceptedIds.includes(id)).length,
      meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      medianMs: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null,
      maxMs: values.length ? values.at(-1) : null,
    };
  });
  const entries = Object.values(viewportEntryAtById ?? {});
  const accepted = Object.values(acceptedAtById ?? {});
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

export function validateScrollThroughEvidence({ expectedIds, viewportEntryAtById, acceptedAtById, pipelineStages, checkpoints, selectionViewport, terminalAt, acceptedIds, duplicateAcceptedIds = [], providerRequests = [], schedulerState, restoreOriginals, expectedOriginals, cleanupErrors = [] }) {
  const issues = [];
  const stageValidation = validateScrollThroughStages(expectedIds, pipelineStages);
  issues.push(...stageValidation.issues);
  const observationValidation = validateScrollThroughObservations(expectedIds, checkpoints, selectionViewport);
  issues.push(...observationValidation.issues);
  const latency = deriveScrollAcceptanceLatency(expectedIds, viewportEntryAtById, acceptedAtById);
  issues.push(...latency.issues);
  issues.push(...validateExactTargetIds('scroll acceptance', acceptedIds, expectedIds ?? []).issues);
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

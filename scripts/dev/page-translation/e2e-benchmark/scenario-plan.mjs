export const SUPPORTED_SCENARIOS = Object.freeze(['small', 'dynamic-dom', 'spa-navigation', 'early-visible', 'in-window-visible', 'late-visible']);
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

export function settingsForScenario(settings, scenario) {
  return Object.freeze({ ...settings, WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: scenario === 'dynamic-dom',
    ...(scenario === 'spa-navigation' ? { WHOLE_PAGE_AUTO_TRANSLATE_RULES: ['127.0.0.1/replacement'], TRANSLATION_API: 'edge', TARGET_LANGUAGE: 'fr' } : {}) });
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

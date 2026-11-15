export function validateTranslation({ originals, translated, requests, restored, expectedCount = originals.length, acceptedIds, admittedIds, enqueuedIds }) {
  const issues = [];
  const expected = new Map();
  const actual = new Map();
  const expectedSources = new Map();
  const requestCounts = new Map();
  for (const [id, text] of originals) {
    if (expected.has(id)) issues.push(`duplicate original target: ${id}`);
    expected.set(id, text);
    expectedSources.set(text, (expectedSources.get(text) ?? 0) + 1);
  }
  if (expected.size !== expectedCount) issues.push(`fixture target count mismatch: expected ${expectedCount}, got ${expected.size}`);
  for (const [id, text] of translated) {
    if (actual.has(id)) issues.push(`duplicate translation target: ${id}`);
    actual.set(id, text);
  }
  for (const source of requests) requestCounts.set(source, (requestCounts.get(source) ?? 0) + 1);
  for (const id of expected.keys()) if (!actual.has(id)) issues.push(`missing translation: ${id}`);
  for (const id of actual.keys()) if (!expected.has(id)) issues.push(`unexpected translation: ${id}`);
  for (const id of expected.keys()) {
    const expectedText = `\u200efixture translation: ${expected.get(id)}`;
    if (actual.has(id) && actual.get(id) !== expectedText) issues.push(`incorrect translation: ${id}`);
  }
  for (const [source, count] of requestCounts) {
    const expectedCount = expectedSources.get(source) ?? 0;
    if (!expectedCount) issues.push(`unexpected provider source: ${source}`);
    else if (count > expectedCount) issues.push(`duplicate provider source: ${source}`);
  }
  for (const [source, count] of expectedSources) {
    if ((requestCounts.get(source) ?? 0) < count) issues.push(`missing provider source: ${source}`);
  }
  for (const [id, source] of originals) if (restored.get(id) !== source) issues.push(`restore mismatch: ${id}`);
  for (const id of restored.keys()) if (!expected.has(id)) issues.push(`unexpected restored target: ${id}`);
  for (const [name, ids] of [['accepted', acceptedIds], ['admitted', admittedIds], ['enqueued', enqueuedIds]]) {
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) {
      issues.push(`${name} target IDs unavailable or invalid`);
      continue;
    }
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (!expected.has(id)) issues.push(`unexpected ${name} target: ${id}`);
      if (count > 1) issues.push(`duplicate ${name} target: ${id}`);
    }
    for (const id of expected.keys()) if (!counts.has(id)) issues.push(`missing ${name} target: ${id}`);
  }
  return { ok: issues.length === 0, issues, translatedCount: actual.size, originalCount: expected.size };
}

export function summarizeLongTasks(entries) {
  if (entries == null) return { count: null, maxDurationMs: null, blockingTimeMs: null };
  if (!Array.isArray(entries)) throw new TypeError('Long-task entries must be an array or unavailable.');
  const durations = entries.map(entry => entry?.duration);
  if (durations.some(duration => !Number.isFinite(duration) || duration < 0)) {
    throw new TypeError('Long-task durations must be finite non-negative numbers.');
  }
  return {
    count: entries.length,
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    blockingTimeMs: durations.reduce((total, duration) => total + Math.max(0, duration - 50), 0),
  };
}

export function validateWindowMembership({ scenario, visibleIds, windowCandidateIds, enumerationSteps }) {
  const issues = [];
  if (!['early-visible', 'in-window-visible', 'late-visible'].includes(scenario)) issues.push('window scenario unavailable or invalid');
  if (!Array.isArray(visibleIds) || !Array.isArray(windowCandidateIds)) issues.push('window membership data unavailable');
  if (!Number.isInteger(enumerationSteps) || enumerationSteps <= 0) issues.push('enumeration step count unavailable or invalid');
  else if (enumerationSteps > 100) issues.push(`enumeration step limit exceeded: ${enumerationSteps}`);
  if (Array.isArray(visibleIds) && visibleIds.length === 0) issues.push('visible target IDs unavailable');
  if (Array.isArray(windowCandidateIds) && windowCandidateIds.length === 0) issues.push('window candidate IDs unavailable');
  if (Array.isArray(windowCandidateIds) && Number.isInteger(enumerationSteps) && windowCandidateIds.length > enumerationSteps) {
    issues.push(`window candidate count exceeds enumeration steps: ${windowCandidateIds.length} > ${enumerationSteps}`);
  }
  if (Array.isArray(visibleIds) && new Set(visibleIds).size !== visibleIds.length) issues.push('duplicate visible target ID');
  if (Array.isArray(windowCandidateIds) && new Set(windowCandidateIds).size !== windowCandidateIds.length) issues.push('duplicate window candidate ID');

  if (Array.isArray(visibleIds) && Array.isArray(windowCandidateIds) && ['early-visible', 'in-window-visible'].includes(scenario)) {
    const candidates = new Set(windowCandidateIds);
    for (const id of visibleIds) if (!candidates.has(id)) issues.push(`visible target missing from window candidates: ${id}`);
    const firstVisible = windowCandidateIds.findIndex(id => visibleIds.includes(id));
    if (scenario === 'in-window-visible' && firstVisible >= 0 && !windowCandidateIds.slice(0, firstVisible).some(id => !visibleIds.includes(id))) {
      issues.push('in-window scenario has no offscreen candidate before visible targets');
    }
    if (scenario === 'early-visible' && firstVisible >= 0) {
      const lastVisible = windowCandidateIds.reduce((last, id, index) => visibleIds.includes(id) ? index : last, -1);
      const firstOffscreen = windowCandidateIds.findIndex(id => !visibleIds.includes(id));
      if (firstOffscreen >= 0 && lastVisible >= firstOffscreen) issues.push('early visible targets do not precede offscreen candidates');
    }
  }
  if (scenario === 'late-visible' && Array.isArray(visibleIds) && Array.isArray(windowCandidateIds)) {
    for (const id of visibleIds) if (windowCandidateIds.includes(id)) issues.push(`late visible target unexpectedly in window candidates: ${id}`);
  }
  return { ok: issues.length === 0, issues };
}

export function summarize(values, minimumP95Samples = 40) {
  const valid = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return { n: 0, p50: null, p95: null };
  return {
    n: valid.length,
    p50: valid[Math.floor((valid.length - 1) * 0.5)],
    p95: valid.length >= minimumP95Samples ? valid[Math.ceil(valid.length * 0.95) - 1] : null,
  };
}

export function summarizeIntervals(starts, ends) {
  if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length !== ends.length) {
    throw new TypeError('Interval start/end samples must be arrays of equal length.');
  }
  const intervals = starts.map((start, index) => Number.isFinite(start) && Number.isFinite(ends[index]) ? ends[index] - start : null);
  const valid = intervals.filter(Number.isFinite);
  const unavailableCount = intervals.length - valid.length;
  return {
    ...summarize(valid),
    sampleCount: intervals.length,
    unavailableCount,
    unavailableIndices: intervals.flatMap((value, index) => value === null ? [index] : []),
    unavailableReason: unavailableCount ? 'start or end timestamp is missing/non-finite; see that raw run derivedTimings for the specific unavailable measurement reason' : null,
  };
}

export function mapEdgeResponse(body) {
  if (!Array.isArray(body) || body.length === 0 || body.some(text => typeof text !== 'string' || !text.trim())) {
    throw new TypeError('Edge request body must be a non-empty array of non-empty strings.');
  }
  return body.map(text => ({ translations: [{ text: `fixture translation: ${text}` }] }));
}

export function classifyTransportRequest({ method, url }, { fixtureOrigin, extensionOrigin } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { kind: 'blocked', reason: 'invalid URL' }; }
  if (parsed.protocol === 'https:' && parsed.hostname === 'edge.microsoft.com' && parsed.pathname === '/translate/translatetext') {
    return method === 'POST' ? { kind: 'provider-translation' } : { kind: 'blocked', reason: `unexpected Edge method: ${method}` };
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'speech.platform.bing.com' && parsed.pathname === '/consumer/speech/synthesize/readaloud/voices/list') {
    return method === 'GET' ? { kind: 'startup-metadata-fixture' } : { kind: 'blocked', reason: `unexpected voice metadata method: ${method}` };
  }
  if (parsed.protocol === 'chrome-extension:' && parsed.host === 'invalid' && parsed.pathname === '/' && method === 'GET') {
    return { kind: 'invalid-extension-placeholder', reason: 'blocked non-HTTP(S) chrome-extension://invalid/ request; it is not an accessible extension asset' };
  }
  if (fixtureOrigin && parsed.origin === fixtureOrigin && parsed.protocol === 'http:' && method === 'GET') return { kind: 'local' };
  const resourceOrigin = parsed.protocol === 'chrome-extension:' ? `chrome-extension://${parsed.host}` : parsed.origin;
  if (extensionOrigin && resourceOrigin === extensionOrigin && parsed.protocol === 'chrome-extension:' && method === 'GET') return { kind: 'local' };
  return { kind: 'blocked', reason: `unexpected external URL: ${url}` };
}

export function validateRunGate(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const { legacyResults, measuredSamples, allResults, expectedModes, expectedScenarios, expectedSamples, expectedWarmups, buildParity } = input;
  const issues = [];
  const legacyRuns = Array.isArray(legacyResults) ? legacyResults : [];
  const measuredRuns = Array.isArray(measuredSamples) ? measuredSamples : [];
  const allRuns = Array.isArray(allResults) ? allResults : [];
  const failedLegacy = legacyRuns.some(run => run?.status !== 'passed');
  const failedMeasured = measuredRuns.some(run => run?.status !== 'passed');
  const failedWarmups = Array.isArray(allResults) && allResults.some(run => run?.phase === 'warmup' && run?.status !== 'passed');
  if (!Array.isArray(legacyResults) || !legacyRuns.length) issues.push('Legacy qualification evidence is missing or invalid');
  if (!Array.isArray(measuredSamples) || (expectedSamples !== 0 && !measuredRuns.length)) issues.push('measured evidence is missing or invalid');
  const validUniqueStrings = values => Array.isArray(values) && values.length > 0
    && values.every(value => typeof value === 'string' && value.trim().length > 0 && value === value.trim())
    && new Set(values).size === values.length;
  const validModes = validUniqueStrings(expectedModes)
    && expectedModes.includes('legacy')
    && expectedModes.every(mode => ['legacy', 'sliced', 'viewport'].includes(mode));
  const validScenarios = validUniqueStrings(expectedScenarios);
  const validSamples = Number.isSafeInteger(expectedSamples) && expectedSamples >= 0 && expectedSamples <= 40;
  const validWarmups = Number.isSafeInteger(expectedWarmups) && expectedWarmups >= 1 && expectedWarmups <= 3;
  if (!validModes) issues.push('Expected modes are missing or invalid');
  if (!validScenarios) issues.push('Expected scenarios are missing or invalid');
  if (!validSamples) issues.push('Expected measured sample count is missing or invalid');
  if (!validWarmups) issues.push('Expected warmup count is missing or invalid');
  if (validModes && validScenarios && validSamples && validWarmups) {
    if (!Array.isArray(allResults)) issues.push('complete warmup evidence is missing');
    const expectedLegacy = expectedScenarios.length * (expectedWarmups + expectedSamples);
    const expectedMeasured = expectedScenarios.length * expectedSamples * expectedModes.length;
    if (legacyRuns.length !== expectedLegacy) issues.push(`Legacy qualification count mismatch: expected ${expectedLegacy}, got ${legacyRuns.length}`);
    if (measuredRuns.length !== expectedMeasured) issues.push(`measured trial count mismatch: expected ${expectedMeasured}, got ${measuredRuns.length}`);
    for (const scenario of expectedScenarios) {
      const warmups = legacyRuns.filter(run => run?.scenario === scenario && run?.phase === 'warmup');
      const measuredLegacy = legacyRuns.filter(run => run?.scenario === scenario && run?.phase === 'measured');
      if (warmups.length !== expectedWarmups || measuredLegacy.length !== expectedSamples) {
        issues.push(`${scenario}: incomplete Legacy warmup or measured qualification evidence`);
      }
      for (const [phase, expectedCount, runs] of [['warmup', expectedWarmups, warmups], ['measured', expectedSamples, measuredLegacy]]) {
        const ordinals = runs.map(run => run?.ordinal);
        if (new Set(ordinals).size !== ordinals.length || ordinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > expectedCount)) {
          issues.push(`${scenario}/legacy/${phase}: duplicate or invalid ordinal evidence`);
        }
        for (let ordinal = 1; ordinal <= expectedCount; ordinal++) {
          if (!ordinals.includes(ordinal)) issues.push(`${scenario}/legacy/${phase}: missing ordinal ${ordinal}`);
        }
      }
      for (const mode of expectedModes) {
        const modeWarmups = allRuns.filter(run => run?.scenario === scenario && run?.mode === mode && run?.phase === 'warmup');
        const warmupOrdinals = modeWarmups.map(run => run?.ordinal);
        if (modeWarmups.length !== expectedWarmups) issues.push(`${scenario}/${mode}: expected ${expectedWarmups} warmups, got ${modeWarmups.length}`);
        if (new Set(warmupOrdinals).size !== warmupOrdinals.length || warmupOrdinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > expectedWarmups)) {
          issues.push(`${scenario}/${mode}: duplicate or invalid warmup ordinal evidence`);
        }
        for (let ordinal = 1; ordinal <= expectedWarmups; ordinal++) {
          if (!warmupOrdinals.includes(ordinal)) issues.push(`${scenario}/${mode}: missing warmup ordinal ${ordinal}`);
        }
        const runs = measuredRuns.filter(run => run?.scenario === scenario && run?.mode === mode && run?.phase === 'measured');
        const ordinals = runs.map(run => run?.ordinal);
        if (runs.length !== expectedSamples) issues.push(`${scenario}/${mode}: expected ${expectedSamples} measured trials, got ${runs.length}`);
        if (new Set(ordinals).size !== ordinals.length || ordinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > expectedSamples)) {
          issues.push(`${scenario}/${mode}: duplicate or invalid measured ordinal evidence`);
        }
        for (let ordinal = 1; ordinal <= expectedSamples; ordinal++) {
          if (!ordinals.includes(ordinal)) issues.push(`${scenario}/${mode}: missing measured ordinal ${ordinal}`);
        }
      }
    }
  }
  if (buildParity?.ok !== true) issues.push(...(buildParity?.issues?.length ? buildParity.issues : ['build parity evidence is missing or invalid']));
  return { comparisonsAllowed: issues.length === 0 && !failedLegacy && !failedMeasured && !failedWarmups, failedLegacy, failedMeasured, failedWarmups, complete: issues.length === 0, issues };
}

export function validatedLongTaskObservation(calibration, entries) {
  if (calibration?.supported !== true) {
    return { entries: null, unavailableReason: calibration?.reason ?? 'Long-task observer unsupported.' };
  }
  if (calibration.captured !== true || !Number.isFinite(calibration.maxDurationMs) || calibration.maxDurationMs < 50) {
    return { entries: null, unavailableReason: 'Long-task calibration did not capture an entry of at least 50 ms.' };
  }
  return { entries: Array.isArray(entries) ? entries : [], unavailableReason: null };
}

export function validateEffectiveSettings(observed, expected) {
  const fields = ['targetLanguage', 'lazyLoading', 'translateAfterScrollStop', 'autoTranslateOnDOMChanges'];
  const verified = Object.fromEntries(fields.map(field => [field, observed?.[field] === expected[field]]));
  const issues = fields.filter(field => !verified[field]).map(field => `effective ${field} mismatch: expected ${String(expected[field])}, got ${String(observed?.[field])}`);
  return { ok: issues.length === 0, verified, issues };
}

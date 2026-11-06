export function validateTranslation({ originals, translated, requests, restored, expectedCount = originals.length }) {
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
  return { ok: issues.length === 0, issues, translatedCount: actual.size, originalCount: expected.size };
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

export function validateRunGate({ legacyResults, measuredSamples }) {
  const failedLegacy = legacyResults.some(run => run.status !== 'passed');
  const failedMeasured = measuredSamples.some(run => run.status !== 'passed');
  return { comparisonsAllowed: !failedLegacy && !failedMeasured, failedLegacy, failedMeasured };
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

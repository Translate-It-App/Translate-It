export const SUPPORTED_SCENARIOS = Object.freeze(['small', 'early-visible', 'in-window-visible', 'late-visible']);
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

export function candidateModeOrder(scenarioIndex, blockIndex) {
  const first = (scenarioIndex + blockIndex) % COMPARISON_MODES.length;
  return [COMPARISON_MODES[first], COMPARISON_MODES[1 - first]];
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

export function mapProviderBatchIds(providerBatches, sourceToId) {
  return providerBatches.map(batch => batch.map(source => sourceToId.get(source) ?? null));
}

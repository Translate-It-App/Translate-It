import { describe, expect, it } from 'vitest';
import { classifyTransportRequest, mapEdgeResponse, summarize, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validateWindowMembership, validatedLongTaskObservation } from './e2e-benchmark/metrics.mjs';
import { createFixture, startupVoicesEndpoint, startupVoicesResponse, targetTexts } from './e2e-benchmark/fixture.mjs';

describe('page translation benchmark measurements', () => {
  it('maps each actual Edge request source into the provider response shape', () => {
    expect(mapEdgeResponse(['one', 'two'])).toEqual([
      { translations: [{ text: 'fixture translation: one' }] },
      { translations: [{ text: 'fixture translation: two' }] },
    ]);
    expect(() => mapEdgeResponse({ text: 'bad' })).toThrow('non-empty array');
    expect(() => mapEdgeResponse([''])).toThrow('non-empty array');
  });

  it('checks exact coverage, requests, translation values, and genuine restore results', () => {
    const args = {
      originals: [['a', 'one'], ['b', 'two']],
      translated: [['a', '\u200efixture translation: one'], ['b', '\u200efixture translation: two']],
      requests: ['one', 'two'],
      restored: new Map([['a', 'one'], ['b', 'two']]),
    };
    expect(validateTranslation(args).ok).toBe(true);
    expect(validateTranslation({ ...args, translated: args.translated.slice(0, 1) }).issues).toContain('missing translation: b');
    expect(validateTranslation({ ...args, restored: new Map([['a', 'one'], ['b', 'wrong']]) }).issues).toContain('restore mismatch: b');
    expect(validateTranslation({ ...args, requests: ['unknown'] }).issues).toContain('unexpected provider source: unknown');
    expect(validateTranslation({ ...args, translated: [...args.translated, args.translated[0]] }).issues).toContain('duplicate translation target: a');
    expect(validateTranslation({ ...args, requests: ['one'] }).issues).toContain('missing provider source: two');
    expect(validateTranslation({ ...args, requests: ['one', 'one', 'two'] }).issues).toContain('duplicate provider source: one');
  });

  it('checks observed accepted, admitted, and enqueued target IDs exactly', () => {
    const args = {
      originals: [['a', 'one'], ['b', 'two']],
      translated: [['a', '\u200efixture translation: one'], ['b', '\u200efixture translation: two']],
      requests: ['one', 'two'],
      restored: new Map([['a', 'one'], ['b', 'two']]),
      acceptedIds: ['a', 'b'], admittedIds: ['a', 'b'], enqueuedIds: ['a', 'b'],
    };
    expect(validateTranslation(args).ok).toBe(true);
    expect(validateTranslation({ ...args, acceptedIds: ['a', 'a', 'extra'] }).issues).toEqual(expect.arrayContaining([
      'duplicate accepted target: a', 'unexpected accepted target: extra', 'missing accepted target: b',
    ]));
  });

  it('summarizes long tasks and preserves unavailable observations', () => {
    expect(summarizeLongTasks(null)).toEqual({ count: null, maxDurationMs: null, blockingTimeMs: null });
    expect(summarizeLongTasks([])).toEqual({ count: 0, maxDurationMs: 0, blockingTimeMs: 0 });
    expect(summarizeLongTasks([{ duration: 40 }, { duration: 75 }, { duration: 100 }])).toEqual({ count: 3, maxDurationMs: 100, blockingTimeMs: 75 });
    expect(() => summarizeLongTasks([{ duration: Number.NaN }])).toThrow('finite non-negative numbers');
    expect(() => summarizeLongTasks([{ duration: -1 }])).toThrow('finite non-negative numbers');
  });

  it('validates actual window candidate membership for each large fixture layout', () => {
    const visibleIds = ['v1', 'v2'];
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds, windowCandidateIds: ['v1', 'v2', 'off'], enumerationSteps: 10 }).ok).toBe(true);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds, windowCandidateIds: ['off', 'v1', 'v2'], enumerationSteps: 10 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'in-window-visible', visibleIds, windowCandidateIds: ['off', 'v1', 'v2'], enumerationSteps: 100 }).ok).toBe(true);
    expect(validateWindowMembership({ scenario: 'in-window-visible', visibleIds, windowCandidateIds: ['v1', 'v2'], enumerationSteps: 101 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'late-visible', visibleIds, windowCandidateIds: ['off'], enumerationSteps: 100 }).ok).toBe(true);
    expect(validateWindowMembership({ scenario: 'late-visible', visibleIds, windowCandidateIds: ['off', 'v1'], enumerationSteps: 100 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds, windowCandidateIds: null, enumerationSteps: 1 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds: [], windowCandidateIds: ['off'], enumerationSteps: 1 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds, windowCandidateIds: [], enumerationSteps: 1 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds, windowCandidateIds: ['v1'], enumerationSteps: 0 }).ok).toBe(false);
    expect(validateWindowMembership({ scenario: 'early-visible', visibleIds: ['v1'], windowCandidateIds: ['v1', 'off'], enumerationSteps: 1 }).ok).toBe(false);
  });

  it('creates stable small and 1000-target large fixture scenarios', () => {
    const small = createFixture();
    expect(small.targetCount).toBe(12);
    expect(small.targetTexts).toEqual(targetTexts);
    const fixtures = ['early-visible', 'in-window-visible', 'late-visible'].map(scenario => createFixture(scenario));
    const identity = fixtures[0].targets.map(({ id, source }) => [id, source]).sort(([a], [b]) => a.localeCompare(b));
    for (const fixture of fixtures) {
      expect(fixture.targetCount).toBe(1000);
      expect(new Set(fixture.targetTexts).size).toBe(1000);
      expect(fixture.targets.map(({ id, source }) => [id, source]).sort(([a], [b]) => a.localeCompare(b))).toEqual(identity);
      expect(fixture.visibleIds).toEqual(fixtures[0].visibleIds);
      expect(fixture.viewport).toEqual({ width: 1280, height: 900 });
      expect(fixture.scroll).toEqual({ x: 0, y: 0 });
      expect(fixture.responseDelayMs).toBe(50);
    }
    const candidates = fixture => fixture.targets.map(target => target.id);
    const visible = fixtures[0].visibleIds;
    expect(candidates(fixtures[0]).indexOf(visible[0])).toBe(0);
    expect(candidates(fixtures[1]).slice(0, 6)).toEqual(['target-0', 'target-1', ...visible]);
    expect(candidates(fixtures[2]).slice(0, 100)).not.toContain(visible[0]);
    expect(fixtures[1].html).toContain('top:20px');
    expect(fixtures[1].html).toContain('top:2000px');
    const geometry = fixture => new Map([...fixture.html.matchAll(/<p data-bench-id="(target-\d+)" style="([^"]+)"/g)].map(([, id, style]) => [id, style]));
    const geometries = fixtures.map(geometry);
    for (const id of geometries[0].keys()) {
      expect(geometries[1].get(id)).toBe(geometries[0].get(id));
      expect(geometries[2].get(id)).toBe(geometries[0].get(id));
    }
    expect(fixtures[0].targets.map(target => target.id)).not.toEqual(fixtures[1].targets.map(target => target.id));
  });

  it('keeps insufficient percentiles unavailable instead of implying samples', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null });
    expect(summarize([9, 1, 5])).toEqual({ n: 3, p50: 5, p95: null });
    expect(summarize(Array.from({ length: 40 }, (_, i) => i + 1)).p95).toBe(38);
  });

  it('does not convert missing interval endpoints into finite zero or negative samples', () => {
    expect(summarizeIntervals([null, null, 100], [null, 250, null])).toEqual({
      n: 0, p50: null, p95: null, sampleCount: 3, unavailableCount: 3, unavailableIndices: [0, 1, 2],
      unavailableReason: 'start or end timestamp is missing/non-finite; see that raw run derivedTimings for the specific unavailable measurement reason',
    });
    expect(summarizeIntervals([100], [125])).toMatchObject({ n: 1, p50: 25, sampleCount: 1, unavailableCount: 0 });
  });

  it('fixtures only the exact startup voice metadata request and blocks nearby requests', () => {
    const voicesUrl = `https://${startupVoicesEndpoint.hostname}${startupVoicesEndpoint.pathname}?trustedclienttoken=synthetic`;
    expect(classifyTransportRequest({ method: startupVoicesEndpoint.method, url: voicesUrl }).kind).toBe('startup-metadata-fixture');
    expect(startupVoicesResponse).toEqual([]);
    expect(classifyTransportRequest({ method: 'POST', url: voicesUrl }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: `https://${startupVoicesEndpoint.hostname}${startupVoicesEndpoint.pathname}/extra?token=synthetic` }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: `https://speech.platform.bing.com/other${startupVoicesEndpoint.pathname}` }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'https://example.test/other' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'POST', url: 'http://edge.microsoft.com/translate/translatetext' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'http://127.0.0.1:1234/' }, { fixtureOrigin: 'http://127.0.0.1:1234' }).kind).toBe('local');
    expect(classifyTransportRequest({ method: 'GET', url: 'http://127.0.0.1:1234/other' }, { fixtureOrigin: 'http://127.0.0.1:4321' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'chrome-extension://fixture-id/chunks/asset.js' }, { extensionOrigin: 'chrome-extension://fixture-id' }).kind).toBe('local');
    expect(classifyTransportRequest({ method: 'GET', url: 'chrome-extension://invalid/' }, { extensionOrigin: 'chrome-extension://fixture-id' }).kind).toBe('invalid-extension-placeholder');
  });

  it('gates comparisons on every Legacy and measured correctness run', () => {
    const expected = { expectedModes: ['legacy', 'sliced'], expectedScenarios: ['small'], expectedSamples: 1, expectedWarmups: 1, buildParity: { ok: true, issues: [] } };
    const legacyResults = [
      { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'warmup', ordinal: 1 },
      { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'measured', ordinal: 1 },
    ];
    const measuredSamples = [
      { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'measured', ordinal: 1 },
      { status: 'passed', scenario: 'small', mode: 'sliced', phase: 'measured', ordinal: 1 },
    ];
    const allResults = [...legacyResults, { status: 'passed', scenario: 'small', mode: 'sliced', phase: 'warmup', ordinal: 1 }];
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples, allResults }).comparisonsAllowed).toBe(true);
    expect(validateRunGate({ ...expected, legacyResults: [{ ...legacyResults[0], status: 'failed' }, legacyResults[1]], measuredSamples, allResults }).comparisonsAllowed).toBe(false);
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples: [{ ...measuredSamples[1], status: 'failed' }, measuredSamples[0]], allResults }).comparisonsAllowed).toBe(false);
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples: measuredSamples.slice(0, 1), allResults }).issues).toContain('measured trial count mismatch: expected 2, got 1');
    expect(validateRunGate({ ...expected, legacyResults: [], measuredSamples, allResults }).comparisonsAllowed).toBe(false);
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples, allResults, buildParity: { ok: false, issues: ['content profile mismatch'] } }).comparisonsAllowed).toBe(false);
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples, allResults, buildParity: undefined }).comparisonsAllowed).toBe(false);
    expect(validateRunGate({ ...expected, legacyResults, measuredSamples, allResults: allResults.slice(0, 2) }).comparisonsAllowed).toBe(false);
  });

  it('fails closed when any expected run-plan field is missing or malformed', () => {
    const expected = { expectedModes: ['legacy'], expectedScenarios: ['small'], expectedSamples: 1, expectedWarmups: 1 };
    const evidence = {
      legacyResults: [
        { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'warmup', ordinal: 1 },
        { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'measured', ordinal: 1 },
      ],
      measuredSamples: [{ status: 'passed', scenario: 'small', mode: 'legacy', phase: 'measured', ordinal: 1 }],
      allResults: [
        { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'warmup', ordinal: 1 },
        { status: 'passed', scenario: 'small', mode: 'legacy', phase: 'measured', ordinal: 1 },
      ],
      buildParity: { ok: true, issues: [] },
    };
    for (const field of Object.keys(expected)) {
      const incomplete = { ...expected };
      delete incomplete[field];
      expect(validateRunGate({ ...evidence, ...incomplete })).toMatchObject({ comparisonsAllowed: false, complete: false });
    }
    for (const malformed of [
      { expectedModes: [] }, { expectedModes: ['legacy', 'legacy'] }, { expectedModes: 'legacy' },
      { expectedScenarios: [] }, { expectedScenarios: ['small', 'small'] }, { expectedScenarios: 12 },
      { expectedSamples: -1 }, { expectedSamples: 1.5 }, { expectedSamples: Number.MAX_SAFE_INTEGER },
      { expectedWarmups: 0 }, { expectedWarmups: 1.5 }, { expectedWarmups: null },
    ]) {
      expect(validateRunGate({ ...evidence, ...expected, ...malformed })).toMatchObject({ comparisonsAllowed: false, complete: false });
    }
    expect(validateRunGate(null)).toMatchObject({ comparisonsAllowed: false, complete: false });
  });

  it('rejects a vacuous fixture target set', () => {
    const result = validateTranslation({ originals: [], translated: [], requests: [], restored: new Map(), expectedCount: 12 });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('fixture target count mismatch: expected 12, got 0');
  });

  it('reports unsupported or unverified long-task capture as unavailable, not zero', () => {
    expect(validatedLongTaskObservation({ supported: false, reason: 'unsupported' }, [])).toEqual({ entries: null, unavailableReason: 'unsupported' });
    expect(validatedLongTaskObservation({ supported: true, captured: false, maxDurationMs: 0 }, [])).toEqual({ entries: null, unavailableReason: 'Long-task calibration did not capture an entry of at least 50 ms.' });
    expect(validatedLongTaskObservation({ supported: true, captured: true, maxDurationMs: 75 }, [])).toEqual({ entries: [], unavailableReason: null });
  });

  it('rejects missing or enabled effective fixture settings', () => {
    const expected = { targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: false };
    expect(validateEffectiveSettings(expected, expected).ok).toBe(true);
    expect(validateEffectiveSettings({ ...expected, lazyLoading: undefined }, expected).issues).toContain('effective lazyLoading mismatch: expected false, got undefined');
    expect(validateEffectiveSettings({ ...expected, autoTranslateOnDOMChanges: true }, expected).ok).toBe(false);
  });
});

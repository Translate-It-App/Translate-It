import { describe, expect, it } from 'vitest';
import { classifyTransportRequest, longTasksWithinInterval, mapEdgeResponse, summarize, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validateWindowMembership, validatedLongTaskObservation } from './e2e-benchmark/metrics.mjs';
import { createFixture, startupVoicesEndpoint, startupVoicesResponse, targetTexts } from './e2e-benchmark/fixture.mjs';
import { deriveScrollAcceptanceLatency, deriveScrollAggregateMetrics, parseScenarioSelection, settingsForScenario, validateScrollThroughEvidence, validateScrollThroughObservations, validateScrollThroughStages, validateSpaNavigation, validateSpaObserverRestoreOrder, validateSpaProviderRoute, validateSpaSessions, validateSpaTerminal } from './e2e-benchmark/scenario-plan.mjs';
import { orderedAcceptedTargetIds, validateAcceptedMutationAccounting } from './e2e-benchmark/provider-probe-content.mjs';
import { registerThenInsertCohort, trackCohortAcceptedTarget } from './e2e-benchmark/measurement-lifecycle.mjs';
import { matchesAutoTranslateRule } from '../../../src/utils/ui/exclusion.js';

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

  it('keeps dynamic DOM opt-in and leaves static fixture fields unchanged', () => {
    expect(parseScenarioSelection('small,dynamic-dom')).toEqual(['small', 'dynamic-dom']);
    const small = createFixture('small');
    const dynamic = createFixture('dynamic-dom');
    expect(small).not.toHaveProperty('dynamicCohorts');
    expect(dynamic.targetCount).toBe(12);
    expect(dynamic.targets).toEqual(small.targets);
    expect(dynamic.html).toBe(small.html);
    expect(dynamic.dynamicCohorts.map(cohort => cohort.targets)).toHaveLength(2);
    const all = [...dynamic.targets, ...dynamic.dynamicCohorts.flatMap(cohort => cohort.targets)];
    expect(new Set(all.map(target => target.id)).size).toBe(18);
    expect(new Set(all.map(target => target.source)).size).toBe(18);
    expect(dynamic.dynamicCohorts.flatMap(cohort => cohort.targets).every(target => !dynamic.html.includes(target.id))).toBe(true);
  });

  it('adds an opt-in native-history SPA fixture without changing the static fixtures', () => {
    const small = createFixture('small');
    const spa = createFixture('spa-navigation');
    expect(parseScenarioSelection()).toEqual(['small']);
    expect(parseScenarioSelection('small,dynamic-dom,spa-navigation')).toEqual(['small', 'dynamic-dom', 'spa-navigation']);
    expect(spa.targets.map(({ id, source, visible }) => ({ id, source, visible }))).toEqual(small.targets);
    expect(spa.targets.map(target => target.kind)).toEqual([...Array(6).fill('text'), ...Array(6).fill('title')]);
    expect(spa.spaChangedIds).toEqual(['target-1', 'target-5', 'target-9']);
    expect(spa.html).toContain("history.pushState({}, '', '/replacement')");
    expect(spa.html).toContain('translate-it:benchmark-spa-invalidated');
    expect(spa.html).toContain('data-bench-kind="title"');
    expect(spa.html).toContain("el.setAttribute('title', bSources[index])");
    expect(small.html).not.toContain('spa-navigation-control');
    expect(settingsForScenario({ WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false }, 'small')).toEqual({ WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false });
    expect(settingsForScenario({}, 'dynamic-dom')).toEqual({ WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: true });
    expect(settingsForScenario({}, 'spa-navigation')).toMatchObject({
      WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false,
      WHOLE_PAGE_AUTO_TRANSLATE_RULES: ['127.0.0.1/replacement'],
      TRANSLATION_API: 'edge', TARGET_LANGUAGE: 'fr',
    });
    const routeRule = settingsForScenario({}, 'spa-navigation').WHOLE_PAGE_AUTO_TRANSLATE_RULES[0];
    expect(matchesAutoTranslateRule('http://127.0.0.1:43127/replacement', routeRule)).toBe(true);
    expect(matchesAutoTranslateRule('http://127.0.0.1:43127/', routeRule)).toBe(false);
  });

  it('accepts only same-document advanced SPA cursors and consistent same-clock timings', () => {
    const input = {
      cursorA: { documentEpoch: 4, routeRevision: 2, url: 'http://127.0.0.1:1234/' },
      cursorB: { documentEpoch: 4, routeRevision: 3, url: 'http://127.0.0.1:1234/replacement' },
      navStartedAt: 100, stopAt: 105, invalidatedAt: 110, sourceUpdatedAt: 115,
      firstAcceptedAtById: { 'target-1': 120, 'target-5': 125, 'target-9': 130 }, terminalAt: 160,
      changedIds: ['target-1', 'target-5', 'target-9'], retainedIds: ['target-0'], requestedIds: ['target-1', 'target-5', 'target-9'],
      acceptedIds: ['target-1', 'target-5', 'target-9'], duplicateIds: [], completionReady: true,
    };
    expect(validateSpaNavigation(input)).toMatchObject({ ok: true, navigationToFirstAcceptedMs: 20, navigationToCompletionMs: 60 });
    expect(validateSpaNavigation({ ...input, cursorB: { ...input.cursorB, documentEpoch: 5 } }).ok).toBe(false);
    expect(validateSpaNavigation({ ...input, terminalAt: null }).ok).toBe(false);
    expect(validateSpaNavigation({ ...input, sourceUpdatedAt: 105 }).ok).toBe(false);
    expect(validateSpaNavigation({ ...input, requestedIds: [...input.requestedIds, 'target-0'], retainedIds: ['target-0'] }).ok).toBe(false);
    expect(validateSpaNavigation({ ...input, acceptedIds: [...input.acceptedIds, 'target-0'], retainedIds: ['target-0'] }).ok).toBe(false);
    expect(validateSpaNavigation({ ...input, completionReady: false }).ok).toBe(false);
  });

  it('requires identical A/B settings and a distinct automatic B owner', () => {
    const settings = { provider: 'edge', targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: false };
    expect(validateSpaSessions({ settingsA: settings, settingsB: { ...settings }, autoB: true, sessionA: 'A', sessionB: 'B' }).ok).toBe(true);
    expect(validateSpaSessions({ settingsA: settings, settingsB: { ...settings, lazyLoading: true }, autoB: true, sessionA: 'A', sessionB: 'B' }).ok).toBe(false);
    expect(validateSpaSessions({ settingsA: settings, settingsB: { ...settings, provider: 'google' }, autoB: true, sessionA: 'A', sessionB: 'B' }).ok).toBe(false);
    expect(validateSpaSessions({ settingsA: settings, settingsB: settings, autoB: false, sessionA: 'A', sessionB: 'B' }).ok).toBe(false);
    expect(validateSpaSessions({ settingsA: settings, settingsB: settings, autoB: true, sessionA: 'A', sessionB: 'A' }).ok).toBe(false);
  });

  it('requires SPA terminal counts, matching session, and timestamp after every B write', () => {
    const event = { performanceAt: 150, message: { action: 'page-translation-frame-lifecycle', data: { action: 'page-translate-complete', data: {
      sessionId: 'B', translatedCount: 12, totalCount: 12, failedCount: 0,
    } } } };
    const changedIds = ['target-1', 'target-5', 'target-9'];
    const base = { event, sessionId: 'B', targetIds: Array.from({ length: 12 }, (_, i) => `target-${i}`),
      acceptedAtById: { 'target-1': 120, 'target-5': 130, 'target-9': 149 },
      acceptedIds: changedIds, expectedAcceptedIds: changedIds };
    expect(validateSpaTerminal(base).ok).toBe(true);
    expect(validateSpaTerminal({ ...base, acceptedIds: [...changedIds, 'target-0'] }).ok).toBe(false);
    expect(validateSpaTerminal({ ...base, event: { ...event, message: { ...event.message, data: { ...event.message.data,
      data: { ...event.message.data.data, translatedCount: 11 } } } } }).ok).toBe(false);
    expect(validateSpaTerminal({ ...base, sessionId: 'A' }).ok).toBe(false);
    expect(validateSpaTerminal({ ...base, acceptedAtById: { ...base.acceptedAtById, 'target-9': 151 } }).ok).toBe(false);
    expect(validateSpaTerminal({ ...base, event: { ...event, message: { ...event.message, data: { ...event.message.data,
      data: { ...event.message.data.data, failedCount: 1 } } } } }).ok).toBe(false);
  });

  it('validates viewport-entry/write clocks, distinct provider requests, final terminal, exact Restore, and cleanup', () => {
    const ids = ['a', 'b'];
    const pipelineStages = Object.fromEntries([
      'bridgeDiscoveredAtById', 'intersectionSchedulerRegisteredAtById', 'intersectionCallbackAtById', 'schedulerAdmissionAtById', 'schedulerEnqueueAtById',
    ].map((name, index) => [name, { a: index + 1, b: index + 1 }]));
    const args = {
      expectedIds: ids, viewportEntryAtById: { a: 10, b: 20 }, acceptedAtById: { a: 15, b: 25 },
      pipelineStages,
      checkpoints: [{ scheduler: { isScrolling: true } }],
      selectionViewport: [{ at: 4, isScrolling: false, targetIds: ids, targets: ids.map(id => ({ id, classification: 'viewport' })) }],
      terminalAt: 30, acceptedIds: ids, duplicateAcceptedIds: [],
      providerRequests: [{ requestViewport: { at: 11, targets: [{ id: 'a', classification: 'permitted-50px-buffer' }, { id: 'b', classification: 'outside-buffer' }] } }],
      schedulerState: { managerTranslating: false, activeFlushes: 0, queueIds: [], pendingSettlementCount: 0, discoveryPending: false },
      restoreOriginals: [['a', 'one'], ['b', 'two']], expectedOriginals: [['a', 'one'], ['b', 'two']], cleanupErrors: [],
    };
    expect(validateScrollThroughEvidence(args).ok).toBe(true);
    const prefetch = validateScrollThroughEvidence({ ...args, acceptedAtById: { ...args.acceptedAtById, b: 19 } });
    expect(prefetch).toMatchObject({ ok: true, prefetchAcceptedIds: ['b'], viewportEntryToAcceptedWriteLatencyMsById: { a: 5, b: null } });
    expect(validateScrollThroughEvidence({ ...args, providerRequests: [...args.providerRequests, args.providerRequests[0]] }).issues).toContain('duplicate physical provider request target ID: a');
    expect(validateScrollThroughEvidence({ ...args, terminalAt: 24 }).issues).toContain('matching terminal is missing or precedes latest accepted write');
    expect(validateScrollThroughEvidence({ ...args, schedulerState: { ...args.schedulerState, queueIds: ['pending'] } }).issues).toContain('scheduler/discovery work was not drained at the terminal');
    expect(validateScrollThroughEvidence({ ...args, pipelineStages: { ...pipelineStages, intersectionCallbackAtById: { a: 2 } } }).issues).toContain('missing intersectionCallbackAtById stage: b');
    expect(validateScrollThroughEvidence({ ...args, restoreOriginals: [['a', 'wrong'], ['b', 'two']] }).issues).toContain('Restore originals do not exactly match the fixture');
    expect(validateScrollThroughEvidence({ ...args, cleanupErrors: ['observer failed'] }).ok).toBe(false);
    expect(validateScrollThroughEvidence({ ...args, checkpoints: [{ scheduler: { isScrolling: null } }] }).issues).toContain('scroll checkpoint isScrolling state unavailable: 0');
    expect(validateScrollThroughEvidence({ ...args, selectionViewport: [{ ...args.selectionViewport[0], targets: [{ id: 'a', classification: 'viewport' }] }] }).issues).toContain('scheduler selection geometry does not exactly match selected target IDs: 0');
    expect(validateScrollThroughStages(ids, { ...pipelineStages, schedulerAdmissionAtById: { a: 2, b: 2 } }).issues).toContain('scroll pipeline stages are out of order: a');
    expect(deriveScrollAcceptanceLatency(ids, { a: 10, b: 20 }, { a: 15, b: 25 })).toEqual({ latencyMsById: { a: 5, b: 5 }, prefetchAcceptedIds: [], issues: [] });
    expect(deriveScrollAcceptanceLatency(ids, { a: 10 }, { a: 9, b: 25 })).toMatchObject({
      latencyMsById: { a: null }, prefetchAcceptedIds: ['a'],
      issues: expect.arrayContaining(['missing actual viewport entry timestamp: b']),
    });
    expect(deriveScrollAggregateMetrics([
      { band: 1, ids: ['a', 'b'] }, { band: 2, ids: ['c', 'd'] },
    ], { a: 10, b: 20, c: 30, d: 40 }, { a: 12, b: 19, c: 35, d: 50 })).toEqual({
      latencyByViewportBand: [
        { band: 1, targetCount: 2, measurableCount: 1, prefetchCount: 1, meanMs: 2, medianMs: 2, maxMs: 2 },
        { band: 2, targetCount: 2, measurableCount: 2, prefetchCount: 0, meanMs: 7.5, medianMs: 7.5, maxMs: 10 },
      ],
      lastViewportEntryToFullAcceptance: {
        lastViewportEntryAt: 40, fullAcceptanceAt: 50, latencyMs: 10, fullAcceptanceBeforeLastViewportEntry: false,
      },
    });
    expect(deriveScrollAggregateMetrics([{ band: 1, ids: ['a', 'b'] }], { a: 10, b: 20 }, { a: 12, b: 19 })
      .lastViewportEntryToFullAcceptance).toMatchObject({ latencyMs: -1, fullAcceptanceBeforeLastViewportEntry: true });
    expect(validateScrollThroughObservations(ids, [{ scheduler: { isScrolling: false } }], args.selectionViewport).ok).toBe(true);
  });

  it('validates that route provider evidence is local Edge transport and observers stop before Restore', () => {
    const requests = [{ category: 'provider-translation', method: 'POST', url: 'https://edge.microsoft.com/translate/translatetext', targetIds: ['target-1'] }];
    expect(validateSpaProviderRoute({ provider: 'edge', requests, expectedIds: ['target-1'] }).ok).toBe(true);
    expect(validateSpaProviderRoute({ provider: 'google', requests, expectedIds: ['target-1'] }).ok).toBe(false);
    expect(validateSpaProviderRoute({ provider: 'edge', requests: [{ ...requests[0], url: 'https://example.com/translate' }], expectedIds: ['target-1'] }).ok).toBe(false);
    expect(validateSpaObserverRestoreOrder({ spaObserverStoppedAt: 10, measurementObserverStoppedAt: 11, restoreStartedAt: 12 }).ok).toBe(true);
    expect(validateSpaObserverRestoreOrder({ spaObserverStoppedAt: 13, measurementObserverStoppedAt: 11, restoreStartedAt: 12 }).ok).toBe(false);
  });

  it('registers the complete cohort before insertion and tracks first/all latency once', () => {
    const order = [];
    const inserted = registerThenInsertCohort({
      register: () => order.push('register'),
      now: () => { order.push('timestamp'); return 100; },
      insert: () => { order.push('insert'); return 'nodes'; },
    });
    expect(order).toEqual(['register', 'timestamp', 'insert']);
    expect(inserted).toEqual({ insertedAt: 100, result: 'nodes' });
    const cohort = { targetIds: ['a', 'b'], remainingIds: new Set(['a', 'b']), firstAcceptedAt: null, completionAt: null, acceptedAtById: {} };
    expect(trackCohortAcceptedTarget(cohort, 'a', 110)).toBe(true);
    expect(trackCohortAcceptedTarget(cohort, 'a', 115)).toBe(false);
    expect(trackCohortAcceptedTarget(cohort, 'b', 140)).toBe(true);
    expect(cohort).toMatchObject({ firstAcceptedAt: 110, completionAt: 140, acceptedAtById: { a: 110, b: 140 } });
    expect(cohort.firstAcceptedAt - inserted.insertedAt).toBe(10);
    expect(cohort.completionAt - inserted.insertedAt).toBe(40);
  });

  it('accounts dynamic provider targets exactly once and validates the persistent setting', () => {
    const expectedIds = [...Array.from({ length: 12 }, (_, index) => `target-${index}`),
      ...Array.from({ length: 6 }, (_, index) => `dynamic-${index < 3 ? 1 : 2}-${index % 3 + 1}`)];
    const result = validateAcceptedMutationAccounting({
      expectedIds, targetKinds: expectedIds.map(() => 'text'), acceptedIds: expectedIds,
      mutationIds: expectedIds, duplicateAcceptances: 0, staleWrites: 0, unattributedWrites: 0,
    });
    expect(result.ok).toBe(true);
    const base = { WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false, PROXY_ENABLED: false };
    expect(settingsForScenario(base, 'small')).toEqual(base);
    expect(settingsForScenario(base, 'dynamic-dom')).toEqual({ ...base, WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: true });
    const expected = { targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: true };
    expect(validateEffectiveSettings(expected, expected).ok).toBe(true);
    expect(validateEffectiveSettings({ ...expected, autoTranslateOnDOMChanges: false }, expected).ok).toBe(false);
    expect(validateEffectiveSettings({ ...expected, autoTranslateOnDOMChanges: false }, { ...expected, autoTranslateOnDOMChanges: false }).ok).toBe(true);
  });

  it('preserves the default Firefox provider probe target order', () => {
    const expectedIds = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    expect(orderedAcceptedTargetIds(expectedIds, new Set([...expectedIds].reverse()))).toEqual(expectedIds);
  });

  it('keeps insufficient percentiles unavailable instead of implying samples', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null });
    expect(summarize([9, 1, 5])).toEqual({ n: 3, p50: 5, p95: null });
    expect(summarize(Array.from({ length: 40 }, (_, i) => i + 1)).p95).toBe(38);
  });

  it('limits SPA long-task samples to calibrated tasks wholly inside navigation through B completion', () => {
    const tasks = [
      { startTime: 90, duration: 20 },
      { startTime: 100, duration: 10 },
      { startTime: 145, duration: 10 },
      { startTime: 150, duration: 10 },
    ];
    expect(longTasksWithinInterval(tasks, 100, 155)).toEqual([tasks[1], tasks[2]]);
    expect(longTasksWithinInterval(null, 100, 150)).toBeNull();
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

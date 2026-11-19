import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalProviderSourceAttempts, classifyTransportRequest, longTasksWithinInterval, mapEdgeResponse, mapProviderHTTPRequestSequence, measureScenarioRuns, summarize, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validateWindowMembership, validatedLongTaskObservation } from './e2e-benchmark/metrics.mjs';
import { projectRateLimitQueueItems } from './e2e-benchmark/rate-limit-queue.mjs';
import { decodeGoogleV2Request, GOOGLE_V2_DELIMITER, mapGoogleV2Response } from './e2e-benchmark/google-v2-fixture.mjs';
import { CUSTOM_FIXTURE_ENDPOINT, CUSTOM_FIXTURE_MODEL, CUSTOM_FIXTURE_URL, decodeCustomRequest, mapCustomResponse } from './e2e-benchmark/custom-fixture.mjs';
import { decodeGeminiRequest, GEMINI_FIXTURE_KEY, GEMINI_FIXTURE_MODEL, GEMINI_FIXTURE_URL, mapGeminiResponse } from './e2e-benchmark/gemini-fixture.mjs';
import { createFixture, startupVoicesEndpoint, startupVoicesResponse, targetTexts } from './e2e-benchmark/fixture.mjs';
import { deriveScrollAcceptanceLatency, deriveScrollAggregateMetrics, isProviderWorkloadTrial, observedPageWorkerLimit, pageTranslationStartMessage, parseProviderLane, parseScenarioSelection, providerLaneFinalization, providerLaneSettings, settingsForScenario, shadowInitialTranslationReadiness, summarizeLogicalProviderBatches, summarizeSpaLogicalProviderBatches, summarizePhysicalProviderAttempts, validateProviderConcurrencyObservations, validateProviderNetworkCorrelation, validateProviderRuntime, validateProviderSchedulerRuntime, validateScrollThroughEvidence, validateScrollThroughObservations, validateScrollThroughStages, validateShadowInitialObservations, validateSpaNavigation, validateSpaObserverRestoreOrder, validateSpaProviderRoute, validateSpaSessions, validateSpaTerminal, scrollThroughPhases, usesBandedProviderScroll } from './e2e-benchmark/scenario-plan.mjs';
import { orderedAcceptedTargetIds, validateAcceptedMutationAccounting } from './e2e-benchmark/provider-probe-content.mjs';
import { registerThenInsertCohort, trackCohortAcceptedTarget } from './e2e-benchmark/measurement-lifecycle.mjs';
import { matchesAutoTranslateRule } from '../../../src/utils/ui/exclusion.js';
import { registryIdToName } from '../../../src/features/translation/providers/ProviderConstants.js';
import { GoogleTranslateV2Provider } from '../../../src/features/translation/providers/GoogleTranslateV2Provider.js';
import { AIResponseParser } from '../../../src/features/translation/providers/utils/AIResponseParser.js';
import { ResponseFormat } from '../../../src/features/translation/core/ProviderConfigurations.js';
import { findSessionOwnedPendingRequest, parseResilienceProbeSelection, selectResolvedGoogleAttempt, selectResolvedCustomAttempt, shouldEnableResilienceQueueProbe, validateCustom429Evidence, validateQueueRetryEvidence, validateResilienceAccounting, validateResilienceProbeIsolation } from './e2e-benchmark/resilience-probes.mjs';

describe('page translation benchmark measurements', () => {
  it('includes the queue projector in provenance and keeps Google resilience injection Google-only 503', () => {
    const source = readFileSync('scripts/dev/page-translation/e2e-benchmark/run.mjs', 'utf8');
    expect(source).toContain("'scripts/dev/page-translation/e2e-benchmark/rate-limit-queue.mjs'");
    expect(source).toContain('const handlerLifecycle = cancellationControl?.requestLifecycle ?? requestLifecycle;');
    expect(source).toContain('handlerLifecycle.trackHandler(reservation, job)');
    const googleBranch = source.split("if (resilienceProbe && classification.provider === 'googlev2')")[1]?.split("if (custom429Protocol && classification.provider === 'custom')")[0];
    expect(googleBranch).toContain('responseCode: 503');
    expect(googleBranch).not.toMatch(/custom-429|Retry-After|retryAfterSeconds|status: 429/);
  });

  it('selects only a first Google V2 attempt after concrete AUTO source resolution and validates retry accounting', () => {
    expect(parseResilienceProbeSelection(undefined)).toEqual([]);
    expect(parseResilienceProbeSelection('googlev2-503')).toEqual(['googlev2-503']);
    expect(parseResilienceProbeSelection('custom-429')).toEqual(['custom-429']);
    expect(() => parseResilienceProbeSelection('googlev2-503,other')).toThrow();
    expect(shouldEnableResilienceQueueProbe(null)).toBe(false);
    expect(shouldEnableResilienceQueueProbe('googlev2-503')).toBe(true);
    expect(shouldEnableResilienceQueueProbe('custom-429')).toBe(true);
    expect(validateResilienceProbeIsolation({ selected: true, provider: 'googlev2', optimizationLevel: 3, modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid' })).toBe(true);
    expect(() => validateResilienceProbeIsolation({ selected: true, provider: 'googlev2', optimizationLevel: 3, modes: 'legacy', scenario: 'scroll-through', schedulingMode: 'fluid' })).toThrow();
    expect(() => validateResilienceProbeIsolation({ selected: true, provider: 'googlev2', optimizationLevel: 3, competingProbe: true })).toThrow();
    expect(validateResilienceProbeIsolation({ selected: true, probe: 'custom-429', provider: 'custom', optimizationLevel: 3, modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid' })).toBe(true);
    expect(() => validateResilienceProbeIsolation({ selected: true, probe: 'custom-429', provider: 'googlev2', optimizationLevel: 3 })).toThrow();
    const request = { networkId: 'net-1', sourceLanguage: 'en' };
    const classification = { kind: 'provider-translation', provider: 'googlev2' };
    expect(selectResolvedGoogleAttempt({ request, classification, resolver: { present: true, resolutionPending: true, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' }, failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedGoogleAttempt({ request, classification, resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'auto', effectiveTargetLanguage: 'fr' }, failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedGoogleAttempt({ request, classification, resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' }, failedCount: 0 })).toMatchObject({ selected: true, source: 'en', target: 'fr' });
    expect(selectResolvedCustomAttempt({ request, classification: { kind: 'provider-translation', provider: 'custom' }, resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' }, failedCount: 0 })).toMatchObject({ selected: true, source: 'en', target: 'fr' });
    expect(selectResolvedGoogleAttempt({ request: { ...request, sourceLanguage: 'nl' }, classification, resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' }, failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedGoogleAttempt({ request, classification, resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' }, failedCount: 1 }).selected).toBe(false);
    const failed = { attemptId: 'failed', networkId: 'network-1', logicalMessageId: 'message-1', pageSessionId: 'session-1', targetIds: ['a'], texts: ['one'], status: 503 };
    const queueEvents = [
      { name: 'queueManager.processItem.start', at: 1_000, queueItemId: 'queue-1', messageId: 'message-1', attemptNumber: 1, attemptLimit: 2, previousErrorType: null },
      { name: 'queueManager.processItem.end', at: 1_010, queueItemId: 'queue-1', messageId: 'message-1', attempts: 1, attemptLimit: 3, status: 'retrying', lastErrorType: 'SERVER_ERROR', retryTimerActive: true, retryScheduledAt: 1_010 },
      { name: 'queueManager.processItem.start', at: 2_510, queueItemId: 'queue-1', messageId: 'message-1', attemptNumber: 2, attemptLimit: 3, previousErrorType: 'SERVER_ERROR', retryScheduledAt: 1_010 },
      { name: 'queueManager.processItem.end', at: 2_520, queueItemId: 'queue-1', messageId: 'message-1', attempts: 2, attemptLimit: 3, status: 'completed', lastErrorType: 'SERVER_ERROR', retryTimerActive: false, retryScheduledAt: null },
    ];
    const queueRetryEvidence = validateQueueRetryEvidence(queueEvents, { messageId: 'message-1' });
    expect(queueRetryEvidence).toMatchObject({ ok: true, observed: { queueItemId: 'queue-1', attempts: [1, 2], attemptLimit: 3, errorType: 'SERVER_ERROR', backoffMs: 1500, finalStatus: 'completed', retryTimerActiveAtSchedule: true, retryTimerActiveAtEnd: false } });
    expect(validateQueueRetryEvidence(queueEvents, { messageId: 'wrong-message' }).ok).toBe(false);
    expect(validateQueueRetryEvidence(queueEvents.map(event => event.name.endsWith('.start') && event.at === 2_510 ? { ...event, at: 3_200 } : event), { messageId: 'message-1' }).ok).toBe(false);
    expect(validateQueueRetryEvidence(queueEvents.map(event => event.name.endsWith('.end') && event.status === 'retrying' ? { ...event, retryTimerActive: false } : event), { messageId: 'message-1' }).ok).toBe(false);
    expect(validateQueueRetryEvidence(queueEvents.map(event => event.name.endsWith('.end') && event.status === 'retrying' ? { ...event, lastErrorType: 'NETWORK_ERROR' } : event), { messageId: 'message-1' }).ok).toBe(false);
    expect(validateQueueRetryEvidence(queueEvents.map(event => event.name.endsWith('.end') ? { ...event, attemptLimit: 2 } : event), { messageId: 'message-1' }).ok).toBe(false);
    expect(validateQueueRetryEvidence(queueEvents.map(event => event.name.endsWith('.start') && event.at === 2_510 ? { ...event, queueItemId: 'other-queue-item' } : event), { messageId: 'message-1' }).ok).toBe(false);
    const rateLimitEvents = queueEvents.map(event => ({
      ...event, attemptLimit: event.name.endsWith('.start') && event.at === 1_000 ? 2 : 5,
      lastErrorType: event.name.endsWith('.end') && event.status === 'retrying' ? 'RATE_LIMIT_REACHED' : event.lastErrorType,
      previousErrorType: event.attemptNumber === 2 ? 'RATE_LIMIT_REACHED' : event.previousErrorType,
      retryAt: event.name.endsWith('.end') && event.status === 'retrying' ? 6_000 : event.retryAt,
      at: event.at === 2_510 ? 6_000 : event.at,
      retryScheduledAt: event.name.endsWith('.end') && event.status === 'retrying'
        || event.name.endsWith('.start') && event.at === 2_510 ? 1_010 : event.retryScheduledAt,
    }));
    expect(validateQueueRetryEvidence(rateLimitEvents, {
      messageId: 'message-1', expectedErrorType: 'RATE_LIMIT_REACHED', minDelayMs: 4_900,
      maxDelayMs: Number.MAX_SAFE_INTEGER, expectedAttemptLimit: 5,
    })).toMatchObject({ ok: true, observed: { attempts: [1, 2], attemptLimit: 5, errorType: 'RATE_LIMIT_REACHED', serverRetryAt: 6_000, backoffMs: 4_990 } });
    const evidence = {
      injected503: [failed],
      attempts: [failed, { ...failed, attemptId: 'retry', networkId: 'network-2', retryOf: 'failed', status: 200 }],
      unnecessaryRetransmits: [],
      siblingRequests: [{ status: 200, pageSessionId: 'session-1', targetIds: ['b'] }],
      translation: { exact: true, duplicates: 0 },
      queueRetryEvidence,
      cleanup: { ok: true },
    };
    expect(validateResilienceAccounting(evidence)).toEqual({ ok: true, issues: [] });
    expect(validateResilienceAccounting({ ...evidence, injected503: [failed, failed] }).ok).toBe(false);
    expect(validateResilienceAccounting({ ...evidence, injected503: [{ ...failed, status: 200 }] }).ok).toBe(false);
    expect(validateResilienceAccounting({ ...evidence, attempts: [failed, { ...failed, networkId: 'network-2', retryOf: 'failed', status: 200, logicalMessageId: null }] }).ok).toBe(false);
  });
  it('correlates pending limiter queue items to roots owned by the requested page session', () => {
    const queueItems = [{ messageId: 'pending-page' }, { messageId: 'pending-other' }, { messageId: 'excluded' }];
    const ownedQueueItems = queueItems.map((item, index) => ({
      ...item, sessionId: ['session-a', 'session-b', 'session-a'][index],
    }));

    expect(findSessionOwnedPendingRequest(ownedQueueItems, 'session-a', ['excluded'])).toBe(ownedQueueItems[0]);
    expect(findSessionOwnedPendingRequest([ownedQueueItems[1]], 'session-a')).toBeNull();
    expect(findSessionOwnedPendingRequest([{ messageId: 'unowned', sessionId: null }], 'session-a')).toBeNull();
  });
  it('requires complete Custom 429 cooldown, sibling, limiter queue and physical-start evidence', () => {
    const failed = { attemptId: 'failed', status: 429, retryAfterSeconds: 5, retryAfterHeader: '5', logicalMessageId: 'message-a',
      queueItemId: 'item-a', pageSessionId: 'session-a', targetIds: ['target-a'], texts: ['a'],
      physicalStartedWallMs: 800, physicalStartedMonoMs: 80, responseWallMs: 1_000, responseMonoMs: 280, queueRetryAt: 6_000 };
    const retry = { attemptId: 'retry', retryOf: 'failed', status: 200, logicalMessageId: 'message-a',
      queueItemId: 'item-a', pageSessionId: 'session-a', targetIds: ['target-a'], texts: ['a'],
      physicalStartedWallMs: 6_100, physicalStartedMonoMs: 6_100 };
    const evidence = {
      injected429: [failed], attempts: [failed, retry],
      arm: { sessionId: 'session-a', resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' } },
      roles: {
        A: { attemptId: 'failed', networkId: 'net-a', messageId: 'message-a', sessionId: 'session-a', targetIds: ['target-a'], physicalStartedWallMs: 800, physicalStartedMonoMs: 80, source: 'en', target: 'fr', fetchHeldAt429: true },
        B: { networkId: 'net-b', messageId: 'message-b', sessionId: 'session-a', targetIds: ['target-b'], physicalStartedWallMs: 900, physicalStartedMonoMs: 90, source: 'en', target: 'fr', responseReleasedWallMs: 1_200, responseReleasedMonoMs: 380, heldThroughCooldownEstablished: true },
      },
      serverRetryAt: 6_000, limiterRetryAt: 6_100, limiterRetryAtAfterSibling: 6_100,
      cooldown: { establishedWallMs: 1_100, establishedMonoMs: 380, limiterRetryAt: 6_100,
        limiterRetryAtMonoMs: 5_380, retainedAfterSiblingSuccess: true },
      sibling: { success: true, messageId: 'message-b', sessionId: 'session-a', completedWallMs: 1_500, queueSettledAt: 1_450, rootStatus: 'fulfilled' },
      pendingLimiterSibling: { messageId: 'message-p', sessionId: 'session-a', observedAtWallMs: 1_600, activeRequests: 1, capacity: 2 },
      pendingStillQueuedAfterSibling: true,
      prematurePhysicalStarts: [], queueRetryEvidence: { ok: true },
      translation: { exact: true, duplicates: 0, targetCount: 1000, sourceCount: 1000, restoreExact: true, terminal: true,
        sessionOwner: 'session-a', duplicateAcceptedIds: [], acceptedTargetCount: 1000 },
      pageSchedulerAfterRestore: { translationSessionId: null },
      concurrency: { peakPhysical: 2, peakLogical: 2 }, cleanup: { ok: true },
    };
    evidence.queueRetryEvidence = { ok: true, observed: { errorType: 'RATE_LIMIT_REACHED', attemptLimit: 5,
      attempts: [1, 2], queueItemId: 'item-a', serverRetryAt: 6_000 } };
    expect(() => JSON.stringify(evidence)).not.toThrow();
    expect(evidence.injected429[0]).not.toHaveProperty('requestRecord');
    expect(evidence.injected429[0]).not.toHaveProperty('root');
    expect(evidence.injected429[0]).not.toHaveProperty('responseBody');
    expect(validateCustom429Evidence(evidence).ok).toBe(true);
    expect(evidence.translation.sessionOwner).toBe(evidence.roles.A.sessionId);
    expect(evidence.pageSchedulerAfterRestore.translationSessionId).toBeNull();
    expect(validateCustom429Evidence({ ...evidence, prematurePhysicalStarts: [retry] }).ok).toBe(false);
    expect(validateCustom429Evidence({
      ...evidence,
      attempts: [...evidence.attempts, {
        attemptId: 'early-after-response',
        physicalStartedWallMs: failed.responseWallMs + 7.664,
        physicalStartedMonoMs: failed.responseMonoMs + 7.664,
      }],
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(['physical provider request started before the shared cooldown deadline']),
    });
    expect(validateCustom429Evidence({ ...evidence, pendingLimiterSibling: null }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, limiterRetryAt: 5_999 }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, attempts: [failed, { ...retry, queueItemId: 'wrong' }] }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, attempts: [failed, { ...retry, physicalStartedWallMs: 6_099, physicalStartedMonoMs: 5_376 }] }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, sibling: { ...evidence.sibling, completedWallMs: 6_100 } }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, roles: { ...evidence.roles, B: { ...evidence.roles.B, targetIds: ['target-a'] } } }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, roles: { ...evidence.roles, B: { ...evidence.roles.B, physicalStartedMonoMs: null } } }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, pendingStillQueuedAfterSibling: false }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, limiterRetryAtAfterSibling: 6_101 }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, serverRetryAt: 5_996 }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, concurrency: { peakPhysical: 3, peakLogical: 2 } }).ok).toBe(false);
    expect(validateCustom429Evidence({ ...evidence, translation: { ...evidence.translation, restoreExact: false } }).ok).toBe(false);
  });

  it('validates Edge and Google V2 lanes without changing legacy selection', () => {
    expect(parseProviderLane({})).toBeNull();
    expect(() => parseProviderLane({ BENCH_LANE: 'provider' })).toThrow('BENCH_PROVIDER');
    expect(() => parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'nope', BENCH_OPTIMIZATION_LEVEL: '3' })).toThrow('BENCH_PROVIDER');
    expect(() => parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'google-v2', BENCH_OPTIMIZATION_LEVEL: '3' })).toThrow('BENCH_PROVIDER');
    expect(parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'googlev2', BENCH_OPTIMIZATION_LEVEL: '3' })).toMatchObject({ provider: 'googlev2', optimizationLevel: 3 });
    expect(() => parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'edge', BENCH_OPTIMIZATION_LEVEL: '2' })).toThrow('BENCH_OPTIMIZATION_LEVEL');
    expect(() => parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'edge', BENCH_OPTIMIZATION_LEVEL: '3', BENCH_MODES: 'legacy,sliced' })).toThrow('production-default sliced');
    for (const optimizationLevel of [1, 3, 5]) {
      const lane = parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'edge', BENCH_OPTIMIZATION_LEVEL: String(optimizationLevel) });
      expect(lane).toMatchObject({ lane: 'provider', provider: 'edge', optimizationLevel, mode: 'sliced' });
      expect(providerLaneSettings({ TARGET_LANGUAGE: 'fr' }, lane)).toMatchObject({
        TARGET_LANGUAGE: 'fr', TRANSLATION_API: 'edge', PROVIDER_OPTIMIZATION_LEVELS: { edge: optimizationLevel },
      });
      expect(pageTranslationStartMessage(lane.provider)).toEqual({
        action: 'page-translate', data: { provider: 'edge', targetLanguage: 'fr' },
      });
    }
    const google = parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'googlev2', BENCH_OPTIMIZATION_LEVEL: '5' });
    expect(providerLaneSettings({ TARGET_LANGUAGE: 'fr' }, google)).toMatchObject({ TRANSLATION_API: 'googlev2', PROVIDER_OPTIMIZATION_LEVELS: { googlev2: 5 } });
    expect(pageTranslationStartMessage(google.provider).data.provider).toBe('googlev2');
    expect(pageTranslationStartMessage()).toEqual({ action: 'page-translate', data: { provider: 'edge', targetLanguage: 'fr' } });
    const custom = parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'custom', BENCH_OPTIMIZATION_LEVEL: '3' });
    expect(custom).toMatchObject({ provider: 'custom', optimizationLevel: 3, mode: 'sliced' });
    expect(providerLaneSettings({}, custom)).toMatchObject({
      TRANSLATION_API: 'custom', PROVIDER_OPTIMIZATION_LEVELS: { custom: 3 },
      CUSTOM_API_URL: CUSTOM_FIXTURE_URL, CUSTOM_API_KEY: '', CUSTOM_API_MODEL: CUSTOM_FIXTURE_MODEL,
      WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true,
    });
    const gemini = parseProviderLane({ BENCH_LANE: 'provider', BENCH_PROVIDER: 'gemini', BENCH_OPTIMIZATION_LEVEL: '3' });
    expect(providerLaneSettings({}, gemini)).toMatchObject({
      TRANSLATION_API: 'gemini', PROVIDER_OPTIMIZATION_LEVELS: { gemini: 3 },
      GEMINI_API_URL: GEMINI_FIXTURE_URL, GEMINI_API_KEY: GEMINI_FIXTURE_KEY,
      GEMINI_MODEL: GEMINI_FIXTURE_MODEL, GEMINI_MODEL_SOURCE: 'legacy', WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true,
    });
  });

  it('strictly decodes Gemini REST requests and returns reversed ID-preserving candidate text', () => {
    const expectedTexts = ['Benchmark target 1 has stable fixture content.', 'Benchmark target 2 has stable fixture content.'];
    const request = {
      method: 'POST', url: `${GEMINI_FIXTURE_URL}?key=${GEMINI_FIXTURE_KEY}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: JSON.stringify({ translations: [
          { id: '0', text: expectedTexts[0] }, { id: '1', text: expectedTexts[1] },
        ] }) }] }],
        systemInstruction: { parts: [{ text: 'Translate to French and return JSON.' }] },
        generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json', temperature: 0.1 },
      }),
    };
    const decoded = decodeGeminiRequest({ ...request, expectedTexts });
    expect(decoded).toEqual({ model: GEMINI_FIXTURE_MODEL, ids: ['0', '1'], texts: expectedTexts });
    expect(decodeGeminiRequest({ ...request, headers: { 'content-type': 'application/json' }, expectedTexts })).toEqual(decoded);
    expect(() => decodeGeminiRequest({ ...request, url: `${GEMINI_FIXTURE_URL}?key=wrong`, expectedTexts })).toThrow('key');
    expect(() => decodeGeminiRequest({ ...request, url: `${GEMINI_FIXTURE_URL}?key=${GEMINI_FIXTURE_KEY}&extra=x`, expectedTexts })).toThrow('key');
    expect(() => decodeGeminiRequest({ ...request, headers: { Authorization: 'Bearer secret' }, expectedTexts })).toThrow('Authorization');
    expect(() => decodeGeminiRequest({ ...request, headers: {}, expectedTexts })).toThrow('application/json');
    expect(() => decodeGeminiRequest({ ...request, method: 'GET', expectedTexts })).toThrow('endpoint');
    const malformedGeneration = JSON.parse(request.body);
    malformedGeneration.generationConfig.temperature = 0.2;
    expect(() => decodeGeminiRequest({ ...request, body: JSON.stringify(malformedGeneration), expectedTexts })).toThrow('payload');
    const malformedUserContent = JSON.parse(request.body);
    malformedUserContent.contents[0].parts[0].text = JSON.stringify({ translations: [{ id: '0', text: 'not a fixture source' }] });
    expect(() => decodeGeminiRequest({ ...request, body: JSON.stringify(malformedUserContent), expectedTexts })).toThrow('fixture text');
    const response = mapGeminiResponse(decoded);
    expect(response.candidates[0]).toMatchObject({ finishReason: 'STOP', content: { role: 'model' } });
    const content = response.candidates[0].content.parts[0].text;
    expect(JSON.parse(content)).toEqual([
      { id: '1', text: `fixture translation: ${expectedTexts[1]}` },
      { id: '0', text: `fixture translation: ${expectedTexts[0]}` },
    ]);
    expect(AIResponseParser.parseBatchResult(content, 2, expectedTexts, 'Gemini', ResponseFormat.JSON_ARRAY).results)
      .toEqual(expectedTexts.map(text => `fixture translation: ${text}`));
  });

  it('strictly decodes and reverses synthetic Custom requests while preserving production wire IDs', () => {
    const expectedTexts = ['Benchmark target 1 has stable fixture content.', 'Benchmark target 2 has stable fixture content.'];
    const request = {
      method: 'POST', url: CUSTOM_FIXTURE_URL,
      body: JSON.stringify({ model: CUSTOM_FIXTURE_MODEL, max_tokens: 4096, messages: [
        { role: 'system', content: 'Translate.' },
        { role: 'user', content: JSON.stringify({ translations: [
          { id: '0', text: expectedTexts[0] }, { id: '1', text: expectedTexts[1] },
        ] }) },
      ] }),
    };
    const decoded = decodeCustomRequest({ ...request, expectedTexts });
    expect(decoded).toEqual({ model: CUSTOM_FIXTURE_MODEL, ids: ['0', '1'], texts: expectedTexts });
    expect(decodeCustomRequest({ ...request, expectedTexts, headers: { 'content-type': 'application/json' } })).toEqual(decoded);
    expect(() => decodeCustomRequest({ ...request, url: `${CUSTOM_FIXTURE_URL}/extra`, expectedTexts })).toThrow('endpoint');
    expect(() => decodeCustomRequest({ ...request, method: 'GET', expectedTexts })).toThrow('endpoint');
    expect(() => decodeCustomRequest({ ...request, headers: { Authorization: 'Bearer secret' }, expectedTexts })).toThrow('Authorization');
    for (const body of ['{', JSON.stringify({ model: CUSTOM_FIXTURE_MODEL, messages: [], max_tokens: 4096 }),
      JSON.stringify({ model: CUSTOM_FIXTURE_MODEL, messages: [{ role: 'user', content: '{"translations":[{"id":"x","text":"unknown"}]}' }], max_tokens: 4096 })]) {
      expect(() => decodeCustomRequest({ ...request, body, expectedTexts })).toThrow();
    }
    const response = mapCustomResponse(decoded);
    const content = response.choices[0].message.content;
    expect(JSON.parse(content).translations).toEqual([
      { id: '1', text: `fixture translation: ${expectedTexts[1]}` },
      { id: '0', text: `fixture translation: ${expectedTexts[0]}` },
    ]);
    expect(AIResponseParser.cleanAIResponse(content, ResponseFormat.JSON_OBJECT)).toEqual({
      translations: [
        { id: '1', text: `fixture translation: ${expectedTexts[1]}` },
        { id: '0', text: `fixture translation: ${expectedTexts[0]}` },
      ],
    });
    expect(AIResponseParser.parseBatchResult(content, 2, expectedTexts, 'Custom', ResponseFormat.JSON_OBJECT).results)
      .toEqual(expectedTexts.map(text => `fixture translation: ${text}`));
  });

  it('decodes strict Google V2 form requests and creates parser-compatible single/multi-segment legacy responses', async () => {
    const url = 'https://translate.google.com/translate_a/single?sl=auto&tl=fr&dt=t';
    const encoded = new URLSearchParams({ q: `Benchmark sentence 1 has stable fixture content.${GOOGLE_V2_DELIMITER}Benchmark sentence 2 has stable fixture content.` }).toString();
    expect(decodeGoogleV2Request({ method: 'POST', url, body: encoded })).toMatchObject({
      sourceLanguage: 'auto', texts: ['Benchmark sentence 1 has stable fixture content.', 'Benchmark sentence 2 has stable fixture content.'],
    });
    const [segments, metadata, detectedLanguage] = mapGoogleV2Response(['one', 'two']);
    expect(metadata).toBeNull();
    expect(detectedLanguage).toBe('en');
    expect(segments).toEqual([
      ['fixture translation: one', 'one', null, null, 1],
      [GOOGLE_V2_DELIMITER, GOOGLE_V2_DELIMITER],
      ['fixture translation: two', 'two', null, null, 1],
    ]);
    expect(mapGoogleV2Response(['one'])[0]).toEqual([['fixture translation: one', 'one', null, null, 1]]);
    const productionProvider = new GoogleTranslateV2Provider();
    vi.spyOn(productionProvider, '_executeApiCall').mockImplementation(async options => options.extractResponse(mapGoogleV2Response(['one', 'two'])));
    const providerOptions = { providerMetadataRef: { metadata: {} } };
    await expect(productionProvider._translateChunk(['one', 'two'], 'auto', 'fr', 'page', null, 0, 2, 0, 1, providerOptions))
      .resolves.toEqual(['fixture translation: one', 'fixture translation: two']);
    expect(providerOptions.providerMetadataRef.metadata.detectedLanguage).toBe('en');
    for (const body of ['q=one&q=two', 'q=', 'q=one%ZZ', 'q=one&broken', 'q=unknown']) {
      expect(() => decodeGoogleV2Request({ method: 'POST', url, body })).toThrow();
    }
    expect(() => decodeGoogleV2Request({ method: 'GET', url, body: 'q=one' })).toThrow('endpoint or method');
    expect(() => decodeGoogleV2Request({ method: 'POST', url: 'https://translate.google.com/translate_a/single/wrong?sl=auto', body: 'q=one' })).toThrow('endpoint or method');
    expect(() => decodeGoogleV2Request({ method: 'POST', url: 'https://translate.google.com/translate_a/single?sl=auto%ZZ&tl=fr', body: 'q=one' })).toThrow('query');
    expect(() => decodeGoogleV2Request({ method: 'POST', url, body: 'q=one&extra=field' })).toThrow('exactly one');
    expect(() => decodeGoogleV2Request({ method: 'POST', url, body: 'q=Benchmark+sentence+1+has+stable+fixture+content.%0A%5B%5B---%5D%5D%0A' })).toThrow('empty or unknown');
  });

  it('validates observed provider runtime configuration rather than the requested settings echo', () => {
    expect(registryIdToName('edge')).toBe('MicrosoftEdge');
    const snapshot = { provider: 'edge', optimizationLevel: 3, batching: { maxBatchSize: 20 }, expectedBatching: { maxBatchSize: 20 }, maxConcurrent: 4, configuredMaxConcurrent: 4 };
    expect(validateProviderRuntime({ requestedProvider: 'edge', requestedOptimizationLevel: 3, snapshot }).ok).toBe(true);
    const mismatches = validateProviderRuntime({
      requestedProvider: 'edge', requestedOptimizationLevel: 5,
      snapshot: { ...snapshot, provider: 'googlev2', batching: { maxBatchSize: 10 }, maxConcurrent: null },
      expectedBatching: { maxBatchSize: 20 },
    });
    expect(mismatches.ok).toBe(false);
    expect(mismatches.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('provider mismatch'), expect.stringContaining('optimization level mismatch'),
      expect.stringContaining('batching configuration mismatch'), expect.stringContaining('scheduler concurrency'),
    ]));
  });

  it('validates effective PageTranslationScheduler batch limits against provider runtime configuration', () => {
    const providerRuntime = { batching: { characterLimit: 5000 }, maxConcurrent: 5 };
    for (const [optimizationLevel, chunkSize] of [[1, 50], [3, 25], [5, 10]]) {
      const scheduler = {
        providerRegistryId: 'edge', chunkSize, maxChars: 5000,
        parallelExecution: false, maxConcurrentFlushes: 5,
      };
      expect(validateProviderSchedulerRuntime({ provider: 'edge', optimizationLevel, providerRuntime, scheduler }).ok).toBe(true);
      expect(validateProviderSchedulerRuntime({
        provider: 'edge', optimizationLevel, providerRuntime,
        scheduler: { ...scheduler, chunkSize: chunkSize + 1, parallelExecution: true, maxConcurrentFlushes: 4 },
      }).ok).toBe(false);
    }
    expect(validateProviderSchedulerRuntime({ provider: 'edge', optimizationLevel: 3, providerRuntime, scheduler: null }).ok).toBe(false);
    for (const [optimizationLevel, characterLimit, maxConcurrent, pageWorkers, chunkSize, parallelExecution] of [
      [1, 7500, 1, 1, 50, false], [3, 5000, 4, 2, 25, true], [5, 3000, 8, 4, 10, true],
    ]) {
      const runtime = { provider: 'googlev2', optimizationLevel, batching: { characterLimit }, expectedBatching: { characterLimit }, maxConcurrent, configuredMaxConcurrent: maxConcurrent };
      expect(validateProviderRuntime({ requestedProvider: 'googlev2', requestedOptimizationLevel: optimizationLevel, snapshot: runtime }).ok).toBe(true);
      const scheduler = { providerRegistryId: 'googlev2', chunkSize, maxChars: characterLimit, parallelExecution,
        maxConcurrentFlushes: pageWorkers, pageWorkerLimit: pageWorkers };
      expect(validateProviderSchedulerRuntime({ provider: 'googlev2', optimizationLevel, providerRuntime: runtime, scheduler }).ok).toBe(true);
      expect(validateProviderSchedulerRuntime({ provider: 'googlev2', optimizationLevel, providerRuntime: runtime, scheduler: { ...scheduler, pageWorkerLimit: pageWorkers + 1 } }).ok).toBe(false);
      expect(validateProviderRuntime({ requestedProvider: 'googlev2', requestedOptimizationLevel: optimizationLevel,
        snapshot: { ...runtime, batching: { characterLimit: characterLimit - 1 } } }).ok).toBe(false);
    }
    for (const [optimizationLevel, maxConcurrent, chunkSize] of [[1, 1, 50], [3, 2, 25], [5, 4, 10]]) {
      const runtime = { provider: 'custom', optimizationLevel, batching: { characterLimit: 5000 }, expectedBatching: { characterLimit: 5000 }, maxConcurrent, configuredMaxConcurrent: maxConcurrent };
      expect(registryIdToName('custom')).toBe('Custom');
      expect(validateProviderRuntime({ requestedProvider: 'custom', requestedOptimizationLevel: optimizationLevel, snapshot: runtime }).ok).toBe(true);
      const scheduler = { providerRegistryId: 'custom', chunkSize, maxChars: 5000, parallelExecution: true,
        maxConcurrentFlushes: maxConcurrent, pageWorkerLimit: maxConcurrent };
      expect(validateProviderSchedulerRuntime({ provider: 'custom', optimizationLevel, providerRuntime: runtime, scheduler }).ok).toBe(true);
      expect(validateProviderSchedulerRuntime({ provider: 'custom', optimizationLevel, providerRuntime: runtime, scheduler: { ...scheduler, chunkSize: chunkSize + 1 } }).ok).toBe(false);
    }
    for (const [optimizationLevel, optimalSize, maxConcurrent, chunkSize] of [[1, 50, 1, 80], [3, 20, 3, 30], [5, 6, 6, 15]]) {
      const runtime = { provider: 'gemini', optimizationLevel, batching: { optimalSize, characterLimit: 5000 },
        expectedBatching: { optimalSize, characterLimit: 5000 }, maxConcurrent, configuredMaxConcurrent: maxConcurrent };
      expect(validateProviderRuntime({ requestedProvider: 'gemini', requestedOptimizationLevel: optimizationLevel, snapshot: runtime }).ok).toBe(true);
      const scheduler = { providerRegistryId: 'gemini', chunkSize, maxChars: 15000, parallelExecution: true,
        maxConcurrentFlushes: maxConcurrent, pageWorkerLimit: maxConcurrent };
      expect(validateProviderSchedulerRuntime({ provider: 'gemini', optimizationLevel, providerRuntime: runtime, scheduler }).ok).toBe(true);
      expect(validateProviderRuntime({ requestedProvider: 'gemini', requestedOptimizationLevel: optimizationLevel,
        snapshot: { ...runtime, batching: { ...runtime.batching, optimalSize: optimalSize + 1 } } }).ok).toBe(false);
      expect(validateProviderSchedulerRuntime({ provider: 'gemini', optimizationLevel, providerRuntime: runtime,
        scheduler: { ...scheduler, maxChars: 5000 } }).ok).toBe(false);
    }
  });

  it('correlates provider Fetch requests to Network records by event session and request ID', () => {
    const fetch = [{ targetSessionId: 's1', networkId: 'n1' }];
    const event = [{ sessionId: 's1', networkId: 'n1', startedAt: 1, status: 200, outcome: 'finished', settledAt: 2 }];
    expect(validateProviderNetworkCorrelation(fetch, event).ok).toBe(true);
    expect(validateProviderNetworkCorrelation(fetch, [{ ...event[0], sessionId: 's2' }]).issues).toContain('provider Fetch request has no Network request: s1:n1');
    expect(validateProviderNetworkCorrelation([...fetch, ...fetch], event).issues).toContain('duplicate provider Fetch correlation: s1:n1');
    expect(validateProviderNetworkCorrelation(fetch, [...event, ...event]).issues).toContain('duplicate provider Network request ID: s1:n1');
    expect(validateProviderNetworkCorrelation(fetch, [...event, { sessionId: 's1', networkId: 'orphan' }]).issues).toContain('orphan provider Network request: s1:orphan');
    expect(summarizePhysicalProviderAttempts([{
      attemptId: 'unsettled', networkSessionId: 's1', networkId: 'n1', startedAt: 1, settledAt: null, status: null, outcome: null,
    }]).ok).toBe(false);
  });

  it('finalizes provider results without consulting Legacy comparison qualification', () => {
    expect(providerLaneFinalization({ buildParity: { ok: true } })).toMatchObject({
      passed: true, comparisonsAllowed: false,
    });
    expect(providerLaneFinalization({ buildParity: { ok: true }, primaryError: new Error('Legacy gate failed') }).passed).toBe(false);
    expect(providerLaneFinalization({ buildParity: { ok: true }, cleanupErrors: ['cleanup'] }).passed).toBe(false);
  });

  it('passes scroll scheduling through to provider trial settings', () => {
    expect(settingsForScenario({}, 'scroll-through', 'on-stop')).toMatchObject({
      WHOLE_PAGE_LAZY_LOADING: true, WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: true,
    });
    expect(settingsForScenario({}, 'scroll-through', 'fluid')).toMatchObject({
      WHOLE_PAGE_LAZY_LOADING: true, WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: false,
    });
  });

  it('accounts for physical provider request overlap and lifecycle outcomes', () => {
    const result = summarizePhysicalProviderAttempts([
      { attemptId: 'a', networkSessionId: 's1', networkId: 'n1', startedAt: 0, settledAt: 10, status: 200, outcome: 'finished' },
      { attemptId: 'b', networkSessionId: 's1', networkId: 'n2', startedAt: 5, settledAt: 15, status: 200, outcome: 'finished' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.physicalRequestCount).toBe(2);
    expect(result.peakPhysicalConcurrency).toBe(2);
    expect(result.attempts.map(attempt => attempt.latencyMs)).toEqual([10, 10]);
    const failure = summarizePhysicalProviderAttempts([
      { attemptId: 'failed', networkSessionId: 's1', networkId: 'n3', startedAt: 1, settledAt: 8, status: 503, outcome: 'failed', error: 'net::ERR_FAILED' },
      { attemptId: 'unsettled', networkSessionId: 's1', networkId: 'n4', startedAt: 2, settledAt: null, status: null, outcome: null },
    ]);
    expect(failure.ok).toBe(false);
    expect(failure.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('failed'), expect.stringContaining('lacks valid terminal settlement'),
      expect.stringContaining('lacks correlated response status'),
    ]));
  });

  it('measures logical batch intervals separately from physical request accounting', () => {
    const batches = [
      { sessionId: 'page-1', at: 0, settledAt: 10, outcome: 'fulfilled', targetIds: ['a', 'b'] },
      { sessionId: 'page-1', at: 5, settledAt: 15, outcome: 'fulfilled', targetIds: ['c'] },
    ];
    expect(summarizeLogicalProviderBatches(batches, 'page-1')).toMatchObject({
      ok: true, logicalBatchCount: 2, logicalBatchSizes: [2, 1], peakLogicalBatchConcurrency: 2,
    });
    expect(summarizeLogicalProviderBatches([{ ...batches[0], sessionId: 'other' }], 'page-1').ok).toBe(false);
    expect(summarizePhysicalProviderAttempts([{ attemptId: 'http', networkSessionId: 'worker', networkId: 'n',
      startedAt: 1, settledAt: 2, status: 200, outcome: 'finished' }]).physicalRequestCount).toBe(1);
  });

  it('aggregates SPA provider logical intervals with terminal settlement and exact session/count ownership', () => {
    const observed = [
      { sessionId: 'A', targetIds: ['a'], at: 1 },
      { sessionId: 'B', targetIds: ['b', 'c'], at: 3 },
    ];
    const intervals = [
      { ...observed[0], settledAt: 2, outcome: 'fulfilled' },
      { ...observed[1], settledAt: 5, outcome: 'fulfilled' },
    ];
    expect(summarizeSpaLogicalProviderBatches(intervals, observed, 'A', 'B')).toMatchObject({
      ok: true, logicalBatchCount: 2, logicalBatchSizes: [1, 2], peakLogicalBatchConcurrency: 1,
    });
    expect(summarizeSpaLogicalProviderBatches([{ ...intervals[0], settledAt: undefined, outcome: undefined }, intervals[1]],
      observed, 'A', 'B').issues).toContain('logical batch 0 lacks interval/terminal settlement');
    expect(summarizeSpaLogicalProviderBatches([
      intervals[0], { ...intervals[1], sessionId: null },
    ], observed, 'A', 'B').issues).toEqual(expect.arrayContaining([
      'SPA logical batch intervals include missing or unexpected Page session ownership',
      'SPA logical batch count mismatch for B: expected 1, got 0',
    ]));
    expect(summarizeSpaLogicalProviderBatches([intervals[1]], observed, 'A', 'B').ok).toBe(false);
    expect(summarizeSpaLogicalProviderBatches([intervals[0]], observed, 'A', 'B').ok).toBe(false);
    expect(summarizeSpaLogicalProviderBatches(intervals, observed.filter(batch => batch.sessionId !== 'A'), 'A', 'B')
      .issues).toContain('SPA logical batch count mismatch for A: expected 0, got 1');
    expect(summarizeSpaLogicalProviderBatches(intervals, observed.filter(batch => batch.sessionId !== 'B'), 'A', 'B')
      .issues).toContain('SPA logical batch count mismatch for B: expected 0, got 1');
  });

  it('retains legacy discovery/Edge scrolling and selects banded acceptance for 1000-target providers', () => {
    expect(usesBandedProviderScroll('googlev2')).toBe(true);
    expect(usesBandedProviderScroll('custom')).toBe(true);
    expect(usesBandedProviderScroll('gemini')).toBe(true);
    expect(usesBandedProviderScroll('edge')).toBe(false);
    expect(usesBandedProviderScroll(undefined)).toBe(false);
    expect(scrollThroughPhases(false)).toEqual([
      ['burst-band-2', 900, null, 0], ['burst-band-3', 2000, null, 150],
      ['settled-band-3', 2000, null, 750], ['revisit-band-2', 900, 1, 0], ['revisit-initial', 0, null, 0],
    ]);
    expect(scrollThroughPhases(true).map(([label]) => label)).toEqual([
      'band-2', 'band-3', 'revisit-band-2', 'revisit-initial',
    ]);
  });

  it('validates observed Google V2 1000-target concurrency against actual worker and limiter caps', () => {
    for (const [optimizationLevel, peak] of [[1, 1], [3, 2], [5, 3]]) {
      const result = validateProviderConcurrencyObservations({
        provider: 'googlev2', optimizationLevel, targetCount: 1000,
        logical: { peakLogicalBatchConcurrency: peak }, physical: { peakPhysicalConcurrency: peak },
        pageWorkerLimit: optimizationLevel === 1 ? 1 : optimizationLevel === 3 ? 2 : 4,
        providerLimiterCapacity: optimizationLevel === 1 ? 1 : optimizationLevel === 3 ? 4 : 8,
      });
      expect(result.ok).toBe(true);
    }
    expect(validateProviderConcurrencyObservations({
      provider: 'googlev2', optimizationLevel: 3, targetCount: 1000,
      logical: { peakLogicalBatchConcurrency: 3 }, physical: { peakPhysicalConcurrency: 5 },
      pageWorkerLimit: 2, providerLimiterCapacity: 4,
    }).issues).toEqual(expect.arrayContaining([
      expect.stringContaining('exceeds Page worker limit'), expect.stringContaining('exceeds provider limiter capacity'),
    ]));
    expect(validateProviderConcurrencyObservations({
      provider: 'googlev2', optimizationLevel: 1, targetCount: 1000,
      logical: { peakLogicalBatchConcurrency: 1 }, physical: { peakPhysicalConcurrency: 2 },
      pageWorkerLimit: 1, providerLimiterCapacity: 1,
    }).ok).toBe(false);
    expect(validateProviderConcurrencyObservations({
      provider: 'googlev2', optimizationLevel: 5, targetCount: 999,
      logical: { peakLogicalBatchConcurrency: 2 }, physical: { peakPhysicalConcurrency: 2 },
      pageWorkerLimit: 4, providerLimiterCapacity: 8,
    }).ok).toBe(false);
    for (const [optimizationLevel, peak, cap] of [[1, 1, 1], [3, 2, 2], [5, 3, 4]]) {
      const physical = summarizePhysicalProviderAttempts(Array.from({ length: peak }, (_, index) => ({
        attemptId: `custom-${index}`, networkSessionId: 'custom-session', networkId: `custom-${index}`,
        startedAt: index, settledAt: peak + index, status: 200, outcome: 'finished',
      })));
      expect(validateProviderConcurrencyObservations({
        provider: 'custom', optimizationLevel, targetCount: 1000,
        logical: { peakLogicalBatchConcurrency: peak }, physical,
        pageWorkerLimit: cap, providerLimiterCapacity: cap,
      }).ok).toBe(true);
    }
    expect(validateProviderConcurrencyObservations({
      provider: 'custom', optimizationLevel: 3, targetCount: 1000,
      logical: { peakLogicalBatchConcurrency: 1 }, physical: { peakPhysicalConcurrency: 1 },
      pageWorkerLimit: 2, providerLimiterCapacity: 2,
    }).ok).toBe(false);
    for (const [optimizationLevel, peak, cap] of [[1, 1, 1], [3, 2, 3], [5, 3, 6]]) {
      const physical = summarizePhysicalProviderAttempts(Array.from({ length: peak }, (_, index) => ({
        attemptId: `gemini-${index}`, networkSessionId: 'gemini-session', networkId: `gemini-${index}`,
        startedAt: index, settledAt: peak + index, status: 200, outcome: 'finished',
      })));
      expect(validateProviderConcurrencyObservations({
        provider: 'gemini', optimizationLevel, targetCount: 1000,
        logical: { logicalBatchCount: 40, logicalBatchSizes: Array(40).fill(25), peakLogicalBatchConcurrency: peak },
        physical, pageWorkerLimit: cap, providerLimiterCapacity: cap,
      }).ok).toBe(true);
      expect(physical.physicalRequestCount).toBe(peak);
    }
  });

  it('requires observed Edge concurrency evidence for SPA workload trials without exempting probes', () => {
    const valid = { provider: 'edge', optimizationLevel: 3, targetCount: 12,
      logical: { peakLogicalBatchConcurrency: 2 }, physical: { peakPhysicalConcurrency: 2 },
      pageWorkerLimit: 4, providerLimiterCapacity: 4 };
    expect(validateProviderConcurrencyObservations(valid).ok).toBe(true);
    expect(validateProviderConcurrencyObservations({ ...valid, logical: null }).issues)
      .toContain('observed logical batch concurrency unavailable');
    expect(validateProviderConcurrencyObservations({ ...valid, physical: null }).issues)
      .toContain('observed physical HTTP concurrency unavailable');
    expect(validateProviderConcurrencyObservations({ ...valid, providerLimiterCapacity: null }).issues)
      .toContain('observed provider limiter capacity unavailable');
    expect(validateProviderConcurrencyObservations({ ...valid, pageWorkerLimit: 1 }).issues)
      .toContain('observed logical batch concurrency exceeds Page worker limit: 2/1');
    expect(isProviderWorkloadTrial({ phase: 'measured', scenario: 'spa-navigation', provider: 'edge' })).toBe(true);
    expect(isProviderWorkloadTrial({ phase: 'non-performance-network-guard-probe', networkGuardProbe: true })).toBe(false);
  });

  it('uses the observed Edge scheduler flush cap as Page limit only when the explicit worker limit is absent', () => {
    const scheduler = { maxConcurrentFlushes: 3 };
    expect(observedPageWorkerLimit(scheduler)).toBe(3);
    expect(observedPageWorkerLimit({ ...scheduler, pageWorkerLimit: 2 })).toBe(2);
    expect(observedPageWorkerLimit({})).toBeNull();
    const evidence = { provider: 'edge', optimizationLevel: 3, targetCount: 12,
      logical: { peakLogicalBatchConcurrency: 2 }, physical: { peakPhysicalConcurrency: 2 }, providerLimiterCapacity: 3 };
    expect(validateProviderConcurrencyObservations({ ...evidence, pageWorkerLimit: observedPageWorkerLimit(scheduler) }).ok).toBe(true);
    expect(validateProviderConcurrencyObservations({ ...evidence, pageWorkerLimit: observedPageWorkerLimit({}) }).issues)
      .toContain('observed Page worker limit unavailable');
  });

  it('summarizes only measured provider runs and preserves the established p95 sample threshold', () => {
    const runs = [
      { scenario: 'spa-navigation', mode: 'sliced', phase: 'warmup', value: 999 },
      ...[1, 2, 3].map(value => ({ scenario: 'spa-navigation', mode: 'sliced', phase: 'measured', value })),
    ];
    const summary = measureScenarioRuns(runs, 'spa-navigation', 'sliced', measured => ({
      n: measured.length, values: measured.map(run => run.value), p95: summarize(measured.map(run => run.value)).p95,
    }));
    expect(summary).toEqual({ n: 3, values: [1, 2, 3], p95: null });
  });

  it('skips workload concurrency validation for negative and isolated probe trials', () => {
    expect(isProviderWorkloadTrial({ phase: 'measured' })).toBe(true);
    expect(isProviderWorkloadTrial({ networkGuardProbe: true, phase: 'non-performance-network-guard-probe' })).toBe(false);
    expect(isProviderWorkloadTrial({ cancellationProbe: 'stop', phase: 'non-performance-cancellation-probe' })).toBe(false);
    expect(isProviderWorkloadTrial({ staleSuccessProbe: 'stop', phase: 'non-performance-stale-success-probe' })).toBe(false);
  });

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

  it('defines the five exact Shadow DOM targets and enables only DOM-change translation', () => {
    const small = createFixture('small');
    const shadow = createFixture('shadow-dom');
    expect(parseScenarioSelection('shadow-dom')).toEqual(['shadow-dom']);
    expect(shadow.targetCount).toBe(3);
    expect(shadow.targets.map(({ id, source, kind }) => ({ id, source, kind }))).toEqual([
      { id: 'shadow-light', source: 'Shadow fixture light DOM source.', kind: 'text' },
      { id: 'shadow-open', source: 'Shadow fixture open-root source.', kind: 'text' },
      { id: 'shadow-nested-title', source: 'Shadow fixture nested title source.', kind: 'title' },
    ]);
    expect(shadow.shadowTargets).toHaveLength(5);
    expect(new Set(shadow.shadowTargets.map(target => target.id)).size).toBe(5);
    expect(new Set(shadow.shadowTargets.map(target => target.source)).size).toBe(5);
    expect(shadow.html).toContain('SHADOW_DIRECT_TEXT_SENTINEL');
    expect(shadow.html).toContain('SHADOW_CLOSED_ROOT_SENTINEL');
    expect(shadow.html).toContain("mode:'closed'");
    expect(shadow.html).toContain("openTarget.style.direction='rtl';openTarget.style.unicodeBidi='isolate'");
    expect(small.html).not.toContain('shadow-dom');
    expect(settingsForScenario({}, 'shadow-dom')).toEqual({ WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: true });
    expect(settingsForScenario({}, 'shadow-dom')).not.toHaveProperty('WHOLE_PAGE_LAZY_LOADING');
    expect(settingsForScenario({}, 'small')).toEqual({ WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false });
  });

  it('requires exact drained initial-session accounting before Shadow DOM insertion', () => {
    const expectedIds = ['a', 'b', 'c'];
    const args = {
      expectedIds, expectedSessionId: 'session-1', observedSessionId: 'session-1',
      schedulerState: { discoveryPending: false, pendingSettlementCount: 0, queueIds: [], activeFlushes: 0 },
      bridgeDiscoveryDrained: true, admissions: expectedIds, enqueues: expectedIds,
      settlements: expectedIds.map(id => ({ id, sessionId: 'session-1' })), acceptedDomIds: expectedIds,
    };
    expect(shadowInitialTranslationReadiness(args).ready).toBe(true);
    expect(shadowInitialTranslationReadiness({ ...args, acceptedDomIds: ['a', 'b'] }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, settlements: args.settlements.slice(0, 2) }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, schedulerState: { ...args.schedulerState, discoveryPending: true } }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, bridgeDiscoveryDrained: false }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, observedSessionId: 'session-2' }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, admissions: ['a', 'a', 'c'] }).ready).toBe(false);
    expect(shadowInitialTranslationReadiness({ ...args, settlements: [...args.settlements, args.settlements[0]] }).ready).toBe(false);
  });

  it('validates observed Shadow DOM sources and measured initial geometry against fixture oracles', () => {
    const fixture = createFixture('shadow-dom');
    const observedTargets = fixture.targets.map(({ id, source }) => [id, source]);
    const observedGeometry = { targetCount: fixture.targetCount, visibleIds: fixture.visibleIds,
      viewport: fixture.viewport, scroll: fixture.scroll };
    expect(validateShadowInitialObservations({ fixture, observedTargets, observedGeometry }).ok).toBe(true);
    expect(validateShadowInitialObservations({ fixture, observedTargets: observedTargets.map(([id, source]) =>
      [id, id === 'shadow-open' ? 'wrong source' : source]), observedGeometry }).issues).toContain('observed initial source mismatch: shadow-open');
    expect(validateShadowInitialObservations({ fixture, observedTargets: observedTargets.slice(1), observedGeometry }).ok).toBe(false);
    expect(validateShadowInitialObservations({ fixture, observedTargets,
      observedGeometry: { ...observedGeometry, viewport: { width: 1024, height: 768 } } }).ok).toBe(false);
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
    const mockObserver = { observe: root => order.push(`observe:${root}`) };
    const inserted = registerThenInsertCohort({
      register: () => { order.push('register'); mockObserver.observe('fixture-root'); },
      now: () => { order.push('timestamp'); return 100; },
      insert: () => { order.push('append-host'); return 'nodes'; },
    });
    expect(order).toEqual(['register', 'observe:fixture-root', 'timestamp', 'append-host']);
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
    const googleRequest = { method: 'POST', url: 'https://translate.google.com/translate_a/single?sl=auto' };
    expect(classifyTransportRequest(googleRequest).kind).toBe('blocked');
    expect(classifyTransportRequest(googleRequest, { selectedProvider: 'edge' }).kind).toBe('blocked');
    expect(classifyTransportRequest(googleRequest, { selectedProvider: 'googlev2' })).toMatchObject({ kind: 'provider-translation', provider: 'googlev2' });
    const edgeRequest = { method: 'POST', url: 'https://edge.microsoft.com/translate/translatetext' };
    expect(classifyTransportRequest(edgeRequest).kind).toBe('provider-translation');
    expect(classifyTransportRequest(edgeRequest, { selectedProvider: 'edge' }).kind).toBe('provider-translation');
    expect(classifyTransportRequest(edgeRequest, { selectedProvider: 'googlev2' })).toMatchObject({ kind: 'blocked' });
    const customRequest = { method: 'POST', url: CUSTOM_FIXTURE_URL };
    expect(classifyTransportRequest(customRequest).kind).toBe('blocked');
    expect(classifyTransportRequest(customRequest, {}).kind).toBe('blocked');
    expect(classifyTransportRequest(customRequest, { selectedProvider: 'custom' })).toMatchObject({ kind: 'provider-translation', provider: 'custom' });
    expect(classifyTransportRequest(customRequest, { selectedProvider: 'edge' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ ...customRequest, url: `${CUSTOM_FIXTURE_URL}/extra` }, { selectedProvider: 'custom' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ ...customRequest, url: `${CUSTOM_FIXTURE_URL}?unexpected=1` }, { selectedProvider: 'custom' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ ...customRequest, method: 'GET' }, { selectedProvider: 'custom' }).kind).toBe('blocked');
    const geminiRequest = { method: 'POST', url: `${GEMINI_FIXTURE_URL}?key=${GEMINI_FIXTURE_KEY}` };
    expect(classifyTransportRequest(geminiRequest).kind).toBe('blocked');
    for (const provider of ['edge', 'googlev2', 'custom']) {
      expect(classifyTransportRequest(geminiRequest, { selectedProvider: provider }).kind).toBe('blocked');
    }
    expect(classifyTransportRequest(geminiRequest, { selectedProvider: 'gemini' }))
      .toMatchObject({ kind: 'provider-translation', provider: 'gemini' });
    expect(classifyTransportRequest({ ...geminiRequest, url: `${GEMINI_FIXTURE_URL}?key=wrong` },
      { selectedProvider: 'gemini' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ ...geminiRequest, url: `${GEMINI_FIXTURE_URL}?key=${GEMINI_FIXTURE_KEY}&extra=x` },
      { selectedProvider: 'gemini' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ ...geminiRequest, method: 'GET' }, { selectedProvider: 'gemini' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'https://translate.google.com/translate_a/single' }, { selectedProvider: 'googlev2' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'POST', url: 'https://translate.google.com/translate_a/single/extra' }, { selectedProvider: 'googlev2' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'http://127.0.0.1:1234/' }, { fixtureOrigin: 'http://127.0.0.1:1234' }).kind).toBe('local');
    expect(classifyTransportRequest({ method: 'GET', url: 'http://127.0.0.1:1234/other' }, { fixtureOrigin: 'http://127.0.0.1:4321' }).kind).toBe('blocked');
    expect(classifyTransportRequest({ method: 'GET', url: 'chrome-extension://fixture-id/chunks/asset.js' }, { extensionOrigin: 'chrome-extension://fixture-id' }).kind).toBe('local');
    expect(classifyTransportRequest({ method: 'GET', url: 'chrome-extension://invalid/' }, { extensionOrigin: 'chrome-extension://fixture-id' }).kind).toBe('invalid-extension-placeholder');
  });

  it('records fixture target IDs separately from structured parser wire IDs in HTTP sequence order', () => {
    const sourceToId = new Map([['text A', 'target-A'], ['text B', 'target-B']]);
    const attempts = [{ startedAt: 12, batchTexts: ['text B', 'text A'], batchIds: ['0', '1'], bodyBytes: 42 }];
    expect(mapProviderHTTPRequestSequence(attempts, sourceToId, 'custom')).toEqual([
      { at: 12, ids: ['target-B', 'target-A'], wireIds: ['0', '1'], bodyBytes: 42 },
    ]);
    expect(mapProviderHTTPRequestSequence(attempts, sourceToId, 'gemini')).toEqual([
      { at: 12, ids: ['target-B', 'target-A'], wireIds: ['0', '1'], bodyBytes: 42 },
    ]);
    expect(mapProviderHTTPRequestSequence(attempts, sourceToId, 'edge')).toEqual([
      { at: 12, ids: ['target-B', 'target-A'], bodyBytes: 42 },
    ]);
  });

  it('excludes only the injected failure from exact sources while retaining every physical attempt', () => {
    const sourceToId = new Map([['text A', 'target-A'], ['text B', 'target-B']]);
    const failed = { batchTexts: ['text A'], resilienceCorrelation: { logicalMessageId: 'message-A' }, resilienceInjected429: true };
    const sibling = { batchTexts: ['text B'], resilienceCorrelation: { logicalMessageId: 'message-B' } };
    const retry = { batchTexts: ['text A'], resilienceCorrelation: { logicalMessageId: 'message-A', retryOf: 'resilience-15' } };
    const unrelated = { batchTexts: ['text A'], resilienceCorrelation: { logicalMessageId: 'message-A', retryOf: 'resilience-16' } };
    const attempts = [failed, sibling, retry, unrelated];

    expect(canonicalProviderSourceAttempts(attempts)).toEqual([sibling, retry, unrelated]);
    expect(mapProviderHTTPRequestSequence(attempts, sourceToId, 'custom').map(request => request.ids))
      .toEqual([['target-A'], ['target-B'], ['target-A'], ['target-A']]);
    expect(validateResilienceAccounting({
      injected503: [{ attemptId: 'resilience-15', status: 503, logicalMessageId: 'message-A', pageSessionId: 'session-A', targetIds: ['target-A'], texts: ['text A'] }],
      attempts: [
        { attemptId: 'resilience-15', status: 503, logicalMessageId: 'message-A', pageSessionId: 'session-A', targetIds: ['target-A'], texts: ['text A'] },
        { attemptId: 'resilience-16', retryOf: 'resilience-15', status: 200, logicalMessageId: 'message-A', pageSessionId: 'session-A', targetIds: ['target-A'], texts: ['text A'] },
        { attemptId: 'resilience-17', status: 200, logicalMessageId: 'message-A', pageSessionId: 'session-A', targetIds: ['target-A'], texts: ['text A'] },
      ],
      unnecessaryRetransmits: [{ attemptId: 'resilience-17' }],
      siblingRequests: [{ status: 200 }],
      translation: { exact: true, duplicates: 0 }, cleanup: { ok: true }, queueRetryEvidence: { ok: true },
    }).ok).toBe(false);
  });

  it('projects limiter-queued request ownership from the tracked translation request', () => {
    const request = { options: { messageId: 'queued' }, context: 'page' };
    const tracker = new Map([
      ['queued', { data: { sessionId: 'session-P' }, metadata: { sessionId: 'metadata-P' } }],
      ['direct', { data: { sessionId: 'tracked-session' } }],
    ]);
    expect(projectRateLimitQueueItems({ provider: [request, {
      options: { messageId: 'direct', sessionId: 'direct-session' },
    }, { options: { messageId: 'other' } }] }, tracker)).toEqual([
      { messageId: 'queued', sessionId: 'session-P', context: 'page' },
      { messageId: 'direct', sessionId: 'direct-session', context: null },
      { messageId: 'other', sessionId: null, context: null },
    ]);
  });

  it('keeps default 12-target scroll fixture intact and enables a 1000-target provider variant in three scroll bands', () => {
    const discovery = createFixture('scroll-through');
    const large = createFixture('scroll-through', { providerLane: true });
    expect(discovery.targetCount).toBe(12);
    expect(discovery.scrollBands.map(band => band.ids.length)).toEqual([4, 4, 4]);
    expect(large.targetCount).toBe(1000);
    expect(large.scrollBands.map(band => band.ids.length)).toEqual([334, 333, 333]);
    expect(large.visibleIds).toEqual(large.scrollBands[0].ids);
    expect(large.scrollBands.flatMap(band => band.ids)).toHaveLength(1000);
    expect(new Set(large.targetTexts).size).toBe(1000);
    const tops = new Map([...large.html.matchAll(/<p data-bench-id="(target-\d+)"[^>]*style="([^"]+)"/g)]
      .map(([, id, style]) => [id, Number(style.match(/top:(\d+(?:\.\d+)?)px/)?.[1])]));
    for (const [bandIndex, scrollY] of [0, 900, 2000].entries()) {
      const band = large.scrollBands[bandIndex];
      const viewportTops = band.ids.map(id => tops.get(id) - scrollY);
      expect(viewportTops).toHaveLength(band.ids.length);
      expect(viewportTops.every(top => Number.isFinite(top) && top >= 0 && top + 1 <= large.viewport.height - 100)).toBe(true);
    }
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

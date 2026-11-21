import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalProviderSourceAttempts, classifyTransportRequest, longTasksWithinInterval, mapEdgeResponse, mapProviderHTTPRequestSequence, measureScenarioRuns, summarize, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validateWindowMembership, validatedLongTaskObservation } from './e2e-benchmark/metrics.mjs';
import { projectRateLimitQueueItems } from './e2e-benchmark/rate-limit-queue.mjs';
import { decodeGoogleV2Request, GOOGLE_V2_DELIMITER, mapGoogleV2Response } from './e2e-benchmark/google-v2-fixture.mjs';
import { CUSTOM_FIXTURE_MODEL, CUSTOM_FIXTURE_URL, decodeCustomRequest, mapCustomResponse } from './e2e-benchmark/custom-fixture.mjs';
import { decodeGeminiRequest, GEMINI_FIXTURE_KEY, GEMINI_FIXTURE_MODEL, GEMINI_FIXTURE_URL, isMappedGeminiResponse, mapGeminiResponse, mapMalformedGeminiResponse } from './e2e-benchmark/gemini-fixture.mjs';
import { createFixture, startupVoicesEndpoint, startupVoicesResponse, targetTexts } from './e2e-benchmark/fixture.mjs';
import { deriveScrollAcceptanceLatency, deriveScrollAggregateMetrics, isProviderWorkloadTrial, observedPageWorkerLimit, pageTranslationStartMessage, parseProviderLane, parseScenarioSelection, providerLaneFinalization, providerLaneSettings, settingsForScenario, shadowInitialTranslationReadiness, summarizeLogicalProviderBatches, summarizeSpaLogicalProviderBatches, summarizePhysicalProviderAttempts, validateProviderConcurrencyObservations, validateProviderNetworkCorrelation, validateProviderRuntime, validateProviderSchedulerRuntime, validateScrollThroughEvidence, validateScrollThroughObservations, validateScrollThroughStages, validateShadowInitialObservations, validateSpaNavigation, validateSpaObserverRestoreOrder, validateSpaProviderRoute, validateSpaSessions, validateSpaTerminal, scrollThroughPhases, usesBandedProviderScroll } from './e2e-benchmark/scenario-plan.mjs';
import { orderedAcceptedTargetIds, validateAcceptedMutationAccounting } from './e2e-benchmark/provider-probe-content.mjs';
import { classifyHeldFetchRelease, createCancellationLedger, createCancellationRequestLifecycle, ensureCancellationAbortObserver, installCancellationRuntimeMessageObserver } from './e2e-benchmark/cancellation-probes.mjs';
import { cleanupMeasurementBeforeResources, registerThenInsertCohort, trackCohortAcceptedTarget } from './e2e-benchmark/measurement-lifecycle.mjs';
import { createFetchRequestListener, createHandlerJobTracker, createNetworkCleanupSteps, createNetworkRequestLifecycle, decodeProviderRequest, failPausedFetch, fulfillPausedFetch, runNetworkGuardNegativeProbe } from './e2e-benchmark/network-interception.mjs';
import { matchesAutoTranslateRule } from '../../../src/utils/ui/exclusion.js';
import { registryIdToName } from '../../../src/features/translation/providers/ProviderConstants.js';
import { GoogleTranslateV2Provider } from '../../../src/features/translation/providers/GoogleTranslateV2Provider.js';
import { AIResponseParser } from '../../../src/features/translation/providers/utils/AIResponseParser.js';
import { ResponseFormat } from '../../../src/features/translation/core/ProviderConfigurations.js';
import { claimGoogleTimeoutRequest, commitGoogleTimeoutRequest, findGoogleTimeoutBatchError, findGoogleTimeoutCancelMessage, findSessionOwnedPendingRequest, isCustom400ProbeWindowRequest, parseResilienceProbeSelection, partitionBandAcceptance, requireGoogleTimeoutReservation, resilienceReproductionCommand, selectResolvedCustom400Batch, selectResolvedGoogleAttempt, selectResolvedGoogleTimeoutBatch, selectResolvedGeminiAttempt, selectResolvedCustomAttempt, shouldEnableResilienceQueueProbe, validateCustom400Evidence, validateCustom400QueueEvidence, validateCustom429Evidence, validateGeminiQueueAttemptEvidence, validateGeminiStructuredRecovery, validateGoogleTimeoutEvidence, validateGoogleTimeoutQueueEvidence, validateQueueRetryEvidence, validateResilienceAccounting, validateResilienceProbeIsolation } from './e2e-benchmark/resilience-probes.mjs';
import { finalizeGoogleV2_503Evidence } from './e2e-benchmark/resilience/googlev2-503.mjs';
import { collectCustom429Evidence } from './e2e-benchmark/resilience/custom-429.mjs';
import { collectGeminiStructuredRecoveryEvidence } from './e2e-benchmark/resilience/gemini-structured-recovery.mjs';
import { createCancellationCommandSender } from './e2e-benchmark/cancellation-runner.mjs';
import { waitForSuccessfulReplyCapture } from './e2e-benchmark/stale-success-runner.mjs';
import { validateTrialTranslation } from './e2e-benchmark/trial-validation.mjs';

describe('page translation benchmark measurements', () => {
  it('records fulfilled Fetch response metadata only after settlement and omits it on failure', async () => {
    let settle;
    let clock = 0;
    const requestRecord = {};
    const pendingSend = new Promise(resolve => { settle = resolve; });
    const fulfillment = fulfillPausedFetch({
      send: () => pendingSend, sessionId: 'session', requestId: 'request', status: 503,
      body: { error: true }, requestRecord, now: () => ++clock, response: { retryAfter: null },
    });
    expect(requestRecord.response).toBeUndefined();
    settle();
    await fulfillment;
    expect(requestRecord.response).toMatchObject({ status: 503, body: { error: true }, retryAfter: null, endedAt: 1 });

    const failedRecord = {};
    await expect(fulfillPausedFetch({
      send: async () => { throw new Error('send failed'); }, sessionId: 'session', requestId: 'request',
      status: 400, body: {}, requestRecord: failedRecord, now: () => 2,
    })).rejects.toThrow('send failed');
    expect(failedRecord.response).toBeUndefined();

    const googleSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/resilience/googlev2-503.mjs', 'utf8');
    const customSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/resilience/custom-400.mjs', 'utf8');
    expect(googleSource).not.toMatch(/response:\s*\{[^}]*endedAt\s*:/s);
    expect(customSource).not.toMatch(/response:\s*\{[^}]*endedAt\s*:/s);
  });
  it('generates the custom-400 reproduction command with the custom provider', () => {
    expect(resilienceReproductionCommand('custom-400')).toContain('BENCH_PROVIDER=custom');
    expect(resilienceReproductionCommand('googlev2-503')).toContain('BENCH_PROVIDER=googlev2');
  });

  it('records failed Fetch metadata after settlement and never records it after a rejected send', async () => {
    let settle;
    let clock = 0;
    const requestRecord = {};
    const pendingSend = new Promise(resolve => { settle = resolve; });
    const failure = failPausedFetch({
      send: () => pendingSend, sessionId: 'session', requestId: 'request', errorReason: 'Aborted',
      requestRecord, now: () => ++clock, response: { reason: 'late cancellation' },
    });
    expect(requestRecord.response).toBeUndefined();
    settle();
    await failure;
    expect(requestRecord.response).toEqual({
      failed: true, reason: 'late cancellation', endedAt: 1,
    });

    const failedRecord = {};
    await expect(failPausedFetch({
      send: async () => { throw new Error('fail send failed'); }, sessionId: 'session',
      requestId: 'request', errorReason: 'Aborted', requestRecord: failedRecord, now: () => 2,
      response: { reason: 'late cancellation' },
    })).rejects.toThrow('fail send failed');
    expect(failedRecord.response).toBeUndefined();
  });

  it('preserves late-cancelled response metadata after reservation settlement', async () => {
    let settle;
    let clock = 0;
    const requestRecord = {};
    const lifecycle = createNetworkRequestLifecycle({
      now: () => ++clock,
      sendBySession: new Map([['session', () => new Promise(resolve => { settle = resolve; })]]),
    });
    const reservation = lifecycle.reserve({ requestId: 'request', sessionId: 'session', requestRecord });
    const release = reservation.release('fail', {
      errorReason: 'Aborted', response: { failed: true, reason: 'late-A-session-cancelled' },
    });
    await Promise.resolve();
    expect(requestRecord.response).toBeUndefined();
    settle();
    await release;
    expect(requestRecord.response).toEqual({
      failed: true, reason: 'late-A-session-cancelled', endedAt: 1,
    });
  });

  it('retains completed network guard observations when a later observation fails', async () => {
    const probeResults = [];
    let fetchCalls = 0;
    const requests = [];
    await expect(runNetworkGuardNegativeProbe({
      requests, chrome: {}, pageSession: 'page', contentContext: 2, processId: 1, now: () => 1,
      evaluate: async (_chrome, _session, expression) => {
        if (expression.includes('Boolean(window.__pageTranslationBenchmark')) return true;
        fetchCalls++;
        if (fetchCalls === 2) throw new Error('second fetch failed');
        const url = expression.match(/fetch\((".*?"),/)?.[1];
        const parsedUrl = JSON.parse(url);
        requests.push({ url: parsedUrl, blocked: true, category: 'blocked' });
        return { resolved: false };
      },
      until: async read => read(),
      probeResults,
    })).rejects.toThrow('second fetch failed');
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0].passed).toBe(true);
  });

  it('evaluates both network-guard worlds before validating their observations', async () => {
    const probeResults = [];
    const worlds = [];
    const requests = [];
    await expect(runNetworkGuardNegativeProbe({
      requests, chrome: {}, pageSession: 'page', contentContext: 2, processId: 1, now: () => 1,
      evaluate: async (_chrome, _session, expression, contextId) => {
        if (expression.includes('Boolean(window.__pageTranslationBenchmark')) return true;
        const world = contextId === undefined ? 'page-main-world' : 'extension-isolated-world';
        worlds.push(world);
        const url = expression.match(/fetch\((".*?"),/)?.[1];
        requests.push({ url: JSON.parse(url), blocked: world !== 'page-main-world', category: 'blocked' });
        return { resolved: false };
      },
      until: async read => read(),
      probeResults,
    })).rejects.toThrow('Negative network probe failed to prove blocked page and content-world fetches.');
    expect(worlds).toEqual(['page-main-world', 'extension-isolated-world']);
    expect(probeResults).toHaveLength(2);
    expect(probeResults[0].passed).toBe(false);
  });

  it('runs individual cleanup steps in order and attempts every network unsubscribe after failures', async () => {
    const calls = [];
    const steps = createNetworkCleanupSteps({
      requestUnsubscribe: () => { calls.push('request'); throw new Error('request failed'); },
      eventUnsubscribe: () => calls.push('event'),
      pageEventUnsubscribe: () => calls.push('page'),
      subscriptionsBySession: new Map([
        ['one', () => { calls.push('network-one'); throw new Error('network one failed'); }],
        ['two', () => calls.push('network-two')],
      ]),
    });
    const errors = [];
    await cleanupMeasurementBeforeResources({
      state: { attempted: false, stopped: false, stopAttempts: 0 },
      stopMeasurement: async () => {}, resources: steps, cleanupErrors: errors,
    });
    expect(calls).toEqual(['request', 'event', 'page', 'network-one', 'network-two']);
    expect(errors).toEqual(['request failed', 'Network subscriptions failed to close.']);
  });

  it('selects and validates one production Google timeout without retry or sibling loss', () => {
    expect(parseResilienceProbeSelection('googlev2-timeout')).toEqual(['googlev2-timeout']);
    expect(shouldEnableResilienceQueueProbe('googlev2-timeout')).toBe(true);
    expect(validateResilienceProbeIsolation({
      selected: true, probe: 'googlev2-timeout', provider: 'googlev2', optimizationLevel: 3,
      modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid',
    })).toBe(true);
    const texts = Array.from({ length: 25 }, (_, i) => `source-${i}`);
    const targetIds = Array.from({ length: 25 }, (_, i) => `target-${i}`);
    const expectedTargetIds = Array.from({ length: 1000 }, (_, i) => `target-${i}`);
    const siblingTargets = expectedTargetIds.filter(id => !targetIds.includes(id));
    const siblingTargetGroups = Array.from({ length: 38 }, (_, i) => siblingTargets.slice(i * 25, (i + 1) * 25));
    siblingTargetGroups.push(siblingTargets.slice(950, 959), siblingTargets.slice(959, 967), siblingTargets.slice(967));
    const attempts = [
      { selected: true, networkSessionId: 'worker-a', networkId: 'net-a', logicalMessageId: 'message-a',
        targetIds, status: null, outcome: 'failed' },
      ...siblingTargetGroups.map((ids, i) => ({
        selected: false, networkSessionId: 'worker-a', networkId: `net-${i + 1}`,
        logicalMessageId: `message-${i + 1}`, targetIds: ids, status: 200, outcome: 'finished',
      })),
    ];
    const acceptedWriteIds = expectedTargetIds.filter(id => !targetIds.includes(id));
    const classification = { kind: 'provider-translation', provider: 'googlev2' };
    const resolver = { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' };
    const root = { messageId: 'message-a', sessionId: 'session-a', texts };
    const request = { networkId: 'net-a', sessionId: 'session-a', sourceLanguage: 'en', texts, targetIds };
    expect(selectResolvedGoogleTimeoutBatch({ request, classification, resolver, roots: [root], failedCount: 0 }))
      .toMatchObject({ selected: false, reason: 'initial-band-not-yet-accepted' });
    expect(selectResolvedGoogleTimeoutBatch({ request, classification, resolver, roots: [root], failedCount: 0, armed: true }))
      .toMatchObject({ selected: true, messageId: root.messageId, targetIds });
    expect(selectResolvedGoogleTimeoutBatch({ request, classification, resolver, roots: [root], failedCount: 1, armed: true }).selected).toBe(false);
    expect(selectResolvedGoogleTimeoutBatch({ request, classification, resolver, roots: [root, root], failedCount: 0, armed: true }).selected).toBe(false);
    expect(selectResolvedGoogleTimeoutBatch({ request: { ...request, texts: texts.slice(0, 24) }, classification, resolver, roots: [root], failedCount: 0, armed: true }).selected).toBe(false);
    const queueEvents = [
      { name: 'queueManager.processItem.start', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1 },
      { name: 'queueManager.processItem.end', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1, attempts: 1, status: 'failed', retryTimerActive: false },
    ];
    const timeoutTargets = [
      { kind: 'scheduler.batch', sessionId: 'session-a', targetIds, status: 'fulfilled', startedAt: 1_000, settledAt: 60_500 },
      { kind: 'scheduler.batch.error', sessionId: 'session-a', targetIds, errorName: 'Error',
        errorType: 'OPERATION_TIMEOUT', error: 'Operation timed out', wallTime: 60_500 },
    ];
    const timeout = findGoogleTimeoutBatchError(timeoutTargets, 'session-a', targetIds);
    expect(timeout).toMatchObject({ errorType: 'OPERATION_TIMEOUT', schedulerBatchStatus: 'fulfilled',
      startedAt: 1_000, settledAt: 60_500, targetIds, sessionId: 'session-a' });
    expect(findGoogleTimeoutBatchError(timeoutTargets, 'other-session', targetIds)).toBeNull();
    expect(findGoogleTimeoutBatchError([{ ...timeoutTargets[0], status: 'pending' }, timeoutTargets[1]], 'session-a', targetIds)).toBeNull();
    expect(findGoogleTimeoutBatchError([{ ...timeoutTargets[0], targetIds: targetIds.slice(1) }, timeoutTargets[1]], 'session-a', targetIds)).toBeNull();
    expect(findGoogleTimeoutBatchError([timeoutTargets[0], { ...timeoutTargets[1], errorType: 'NETWORK_ERROR' }], 'session-a', targetIds)).toBeNull();
    const evidence = {
      sessionId: 'session-a',
      heldRequest: { messageId: 'message-a', requestId: 'fetch-a', networkSessionId: 'worker-a',
        networkId: 'net-a', sessionId: 'session-a', targetIds, startedAt: 1_000,
        url: 'https://translate.google.com/translate_a/t', method: 'POST', requestBody: '{"q":"held"}' },
      timeout,
      cancel: { action: 'CANCEL_TRANSLATION', messageId: 'message-a', targetSessionId: 'session-a',
        status: 'fulfilled', response: { success: true } },
      serviceTimeout: { messageId: 'message-a', sessionId: 'session-a', sequence: 3, status: 'fulfilled',
        controllerMatched: true, controllerAbortedBefore: false, controllerAbortedAfter: true,
        response: { handled: true, success: true } },
      controller: { messageId: 'message-a', sessionId: 'session-a', sequence: 4, aborted: true },
      providerRoot: { messageId: 'message-a', status: 'rejected', operationAborted: true, settledSequence: 5 },
      physicalMatchCount: 1,
      physical: { messageId: 'message-a', sessionId: 'session-a', status: 'rejected',
        url: 'https://translate.google.com/translate_a/t', method: 'POST', requestBody: '{"q":"held"}',
        errorName: null, errorType: null, operationAborted: false, abortReasonMatched: true, abortReasonType: 'string',
        controllerAbortedAtEnd: true, settledSequence: 6 },
      classification: { userFacingType: 'OPERATION_TIMEOUT', userFacingName: 'Error',
        userFacingErrorType: 'OPERATION_TIMEOUT', internalAbortType: 'OPERATION_ABORTED', internalAbortName: null },
      queueAttemptEvidence: validateGoogleTimeoutQueueEvidence(queueEvents, { messageId: 'message-a' }),
      retries: [], failovers: [],
      attempts,
      siblingRequests: attempts.filter(item => !item.selected),
      concurrency: { peakPhysical: 2, peakLogical: 2 },
      failedTargetDOM: {
        ok: true,
        expected: targetIds.map(id => [id, id.replace('target-', 'source-'), { pageTranslated: false, hasOriginal: false }]),
        observed: targetIds.map(id => [id, id.replace('target-', 'source-'), { pageTranslated: false, hasOriginal: false }]),
      },
      cleanup: { ok: true, heldFetchSettled: true, handlersDrained: true, handlerCount: 0,
        heldFetch: { requestId: 'fetch-a', handlerSettled: true, releaseOutcome: { ok: true }, releaseClassification: 'fetch-release-command-acknowledged' },
        requestLifecycle: { ok: true }, resourceValidation: { ok: true },
        contentDrain: { pendingOperations: 0 }, workerDrain: { ledger: { pending: 0 }, providerRoots: [] } },
      translation: { targetCount: 1000, acceptedTargetCount: 975, failedTargetCount: 25,
        acceptedWriteCount: 975, acceptedUniqueCount: 975, acceptedWriteIds, expectedTargetIds,
        exact: true, restoreExact: true, failedSourcePreserved: true, failedTargetsUnmarked: true,
        terminal: true, sessionOwner: 'session-a', duplicateAcceptedIds: [] },
    };
    expect(validateGoogleTimeoutEvidence(evidence)).toEqual({ ok: true, issues: [] });
    expect(attempts).toHaveLength(42);
    expect(siblingTargetGroups.slice(-3).map(group => group.length)).toEqual([9, 8, 8]);
    expect(validateGoogleTimeoutEvidence({ ...evidence, timeout: { errorName: 'Error', errorType: 'NETWORK_ERROR', startedAt: 500, settledAt: 60_500 } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, timeout: { ...timeout, sessionId: 'other-session' } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, timeout: { ...timeout, targetIds: targetIds.slice(1) } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, timeout: { ...timeout, errorType: 'NETWORK_ERROR' } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, serviceTimeout: undefined, serviceCancel: {
      messageId: 'message-a', status: 'fulfilled', controllerMatched: true, controllerAbortedAfter: true,
    } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, retries: [{ messageId: 'message-a' }] }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, attempts: [
      ...attempts.slice(0, 2), { ...attempts[2], targetIds: [...attempts[2].targetIds, attempts[1].targetIds[0]] },
      ...attempts.slice(3),
    ] }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, attempts: attempts.slice(1) }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, attempts: attempts.map((item, index) =>
      index === 1 ? { ...item, status: 503, outcome: 'failed' } : item) }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, selectionFailures: [{ reason: 'logical-batch-correlation-not-unique' }] }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, cancel: { ...evidence.cancel, messageId: 'sibling' } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, physical: { ...evidence.physical, errorName: 'OPERATION_TIMEOUT' } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, physical: { ...evidence.physical, operationAborted: false,
      abortReasonMatched: false } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, physical: { ...evidence.physical, abortReasonMatched: false } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, providerRoot: { ...evidence.providerRoot, operationAborted: false } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, physical: { ...evidence.physical, requestBody: '{"q":"other"}' } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, physicalMatchCount: 2 }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, cleanup: { ...evidence.cleanup,
      heldFetch: { ...evidence.cleanup.heldFetch, requestId: 'different-fetch' },
    } }).ok).toBe(false);
    expect(validateGoogleTimeoutEvidence({ ...evidence, translation: {
      ...evidence.translation, acceptedWriteIds: [...evidence.translation.acceptedWriteIds.slice(1), 'target-0'],
    } }).ok).toBe(false);
    expect(validateGoogleTimeoutQueueEvidence([...queueEvents, { ...queueEvents[0], attemptNumber: 2 }], { messageId: 'message-a' }).ok).toBe(false);
  });
  it('keeps timeout execution separate from status injection and drains its held Fetch lifecycle', () => {
    const runSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs', 'utf8');
    const networkSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/network-interception.mjs', 'utf8');
    const timeoutSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/resilience/googlev2-timeout.mjs', 'utf8');
    const contentSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/content-entry.mjs', 'utf8');
    expect(runSource).toContain("if (googleTimeoutProtocol && classification.provider === 'googlev2')");
    expect(timeoutSource).toContain('return { armed: false, claimed: false, held: null, selectionFailures: [], releaseRequested: false }');
    expect(timeoutSource).toContain('failedCount: googleTimeoutProtocol.held || googleTimeoutProtocol.claimed ? 1 : 0, armed: googleTimeoutProtocol.armed');
    expect(timeoutSource).toContain('if (!claimGoogleTimeoutRequest(googleTimeoutProtocol))');
    expect(timeoutSource).toContain('commitGoogleTimeoutRequest(googleTimeoutProtocol, timeoutHold)');
    expect(timeoutSource).toContain('controllerAborted: settled.controllerAbort.sequence > settled.serviceTimeout.sequence');
    expect(timeoutSource).toContain('controllerAbortSequence: settled.controllerAbort.sequence');
    expect(runSource).toContain('if (googleTimeoutProtocol) armGoogleV2Timeout(googleTimeoutProtocol);');
    expect(timeoutSource).toContain('if (googleTimeoutProtocol.armed && resolver?.resolutionPending === false');
    expect(runSource).toContain('if (cancellationProbe || staleSuccessProbe || googleTimeoutProtocol || customCancellationProtocol || soakScenario)');
    expect(runSource).toContain('if (cancellationProbe || staleSuccessProbe || resilienceProbe || soakScenario)');
    expect(runSource).toContain('else if (googleTimeoutProtocol || customCancellationProtocol) trial.resilience.workerInstrumentation = workerInstrumentation;');
    expect(runSource).toContain('const instrumentationOwner = trial.cancellation ?? trial.staleSuccess ?? trial.resilience ?? trial.soak;');
    expect(timeoutSource).toContain('findGoogleTimeoutBatchError(contentOperations, sessionId, targetIds)');
    expect(timeoutSource).toContain('findGoogleTimeoutCancelMessage(contentOperations, root.messageId, sessionId)');
    expect(runSource).toContain('window.__pageTranslationBenchmark.cancellationSnapshot()');
    expect(timeoutSource).toContain('await captureRequestViewport(body)');
    expect(timeoutSource).toContain('requireGoogleTimeoutReservation(reservation).hold()');
    expect(runSource).toMatch(/const handlerLifecycle = cancellationControl\?\.requestLifecycle[\s\S]*?\?\? \(googleTimeoutProtocol \? requestLifecycle : null\);/);
    expect(runSource).toContain('return handlerLifecycle?.reserve({');
    expect(runSource).toContain('handlerJobTracker.track(lifecycle, reservation, job');
    expect(networkSource).toContain('lifecycle.trackHandler(reservation, job)');
    expect(timeoutSource).toContain('item.kind === \'service.handleTimeout\'');
    expect(timeoutSource).toContain('cancellationDiagnostics.workerSnapshot = snapshot ?? null');
    expect(timeoutSource).toContain('cancellationDiagnostics.contentSnapshot = content ?? null');
    expect(timeoutSource).toContain('cancellationDiagnostics.error = { name: error?.name ?? \'Error\'');
    expect(runSource).toContain('cancellationDiagnostics: googleTimeoutProtocol.held.cancellationDiagnostics ?? null');
    expect(timeoutSource).toContain('await reservation.release(\'fail\', { errorReason: \'Aborted\', reason: \'production-timeout-cancel\' })');
    expect(networkSource).toContain('lifecycle.closeAndDrain({');
    expect(runSource).toContain('heldReservation?.handlerSettled === true');
    expect(runSource).toContain('validateGoogleV2TimeoutEvidence(trial.resilience)');
    expect(runSource).not.toContain("if (resilienceProbe && classification.provider === 'googlev2')");
    expect(contentSource).toContain('errorType: error?.type ?? null');
    expect(contentSource).toContain("ledger.record('scheduler.batch.error', sessionId");
    expect(contentSource).toContain('errorType: error?.type ?? null');
    expect(contentSource).toContain("scheduler._handleBatchError = wrapped");
    const workerSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs', 'utf8');
    expect(workerSource).toContain("cancellationLedger.begin('service.handleTimeout'");
    expect(workerSource).toContain('ensureCancellationAbortObserver({');
    expect(workerSource).toContain('sequence: operation.sequence');
    expect(workerSource).toContain('?? root?.controller ?? this.translationEngine?.getAbortController?.(messageId)');
    expect(workerSource).toContain('controllerAbortedAfter: controller?.signal?.aborted ?? null');
    expect(workerSource).toContain("cancellationLedger.begin('service.cancelRequest'");
    const cancelHandler = readFileSync('src/features/translation/handlers/handleCancelTranslation.js', 'utf8');
    expect(cancelHandler).toMatch(/if \(timeout\) \{[\s\S]*?unifiedTranslationService\.handleTimeout\(/);
    const unifiedMessaging = readFileSync('src/shared/messaging/core/UnifiedMessaging.js', 'utf8');
    expect(unifiedMessaging).toContain("'page-translate-batch': 60000");
    expect(unifiedMessaging).toMatch(/action: 'CANCEL_TRANSLATION',\s*data: \{ messageId: message\.messageId, reason: 'Translation timed out', timeout: true \}/);
  });
  it('records the CANCEL_TRANSLATION message ID independently from its Page session', async () => {
    const ledger = createCancellationLedger();
    const runtime = { sendMessage: vi.fn(async () => ({ success: true })) };
    expect(installCancellationRuntimeMessageObserver(runtime, ledger).installed).toBe(true);
    await runtime.sendMessage({
      action: 'CANCEL_TRANSLATION',
      data: { messageId: 'batch-a', sessionId: 'page-a' },
    });
    expect(ledger.snapshot().operations).toMatchObject([{
      kind: 'runtime.cancel.send', sessionId: 'page-a', messageId: 'batch-a',
      targetSessionId: 'page-a', action: 'CANCEL_TRANSLATION', status: 'fulfilled',
    }]);
    await runtime.sendMessage({ action: 'CANCEL_TRANSLATION', data: { messageId: 'batch-only' } });
    const operations = ledger.snapshot().operations;
    expect(findGoogleTimeoutCancelMessage(operations, 'batch-only', 'page-a')).toMatchObject({
      messageId: 'batch-only', sessionId: 'batch-only', targetSessionId: null,
    });
    expect(findGoogleTimeoutCancelMessage(operations, 'different-batch', 'page-a')).toBeNull();
    expect(findGoogleTimeoutCancelMessage([
      { ...operations.at(-1), messageId: 'batch-only', targetSessionId: 'other-page' },
    ], 'batch-only', 'page-a')).toBeNull();
  });
  it('releases a held Fetch and drains its registered request handler during teardown', async () => {
    const lifecycle = createCancellationRequestLifecycle(async (reservation, action) => ({
      ok: true, action, requestId: reservation.requestId,
    }));
    const reservation = lifecycle.reserve({ requestId: 'fetch-timeout', sessionId: 'worker-session' });
    expect(requireGoogleTimeoutReservation(reservation)).toBe(reservation);
    expect(() => requireGoogleTimeoutReservation(null)).toThrow('requires a request-lifecycle Fetch reservation');
    expect(reservation.hold()).toBe(true);
    let handlerSettled = false;
    lifecycle.trackHandler(reservation, reservation.waitForRelease().then(() => { handlerSettled = true; }));
    const cleanup = await lifecycle.closeAndDrain({ disableFetch: async () => {}, timeoutMs: 1_000 });
    expect(cleanup).toMatchObject({
      ok: true, handlerCount: 0, reservations: [{
        requestId: 'fetch-timeout', held: true, releaseAction: 'fail',
        releaseOutcome: { ok: true }, handlerSettled: true,
      }],
    });
    expect(handlerSettled).toBe(true);
  });
  it('tracks malformed Custom admission failures and settles their reserved Fetch', async () => {
    const order = [];
    const releases = [];
    const lifecycle = createNetworkRequestLifecycle({
      now: () => 1,
      sendBySession: new Map([['worker-session', async (_method, params) => {
        releases.push(params);
      }]]),
    });
    const tracker = createHandlerJobTracker();
    const listener = createFetchRequestListener({
      guardSessions: new Set(['worker-session']), now: () => 1, requests: [],
      reserveRequest: (event, requestRecord, requestId) => {
        order.push('reserve');
        return lifecycle.reserve({ requestId, sessionId: event.sessionId, requestRecord });
      },
      onAdmission: (_event, request) => {
        order.push('admission');
        decodeProviderRequest('custom', request, ['expected source']);
      },
      handlePaused: async (_event, _record, reservation, admissionError) => {
        order.push('handler');
        try {
          if (admissionError) throw admissionError;
        } catch {
          await reservation.release('fail', { errorReason: 'BlockedByClient', reason: 'request-handler-error' });
        }
      },
      trackHandler: (reservation, job) => {
        order.push('track');
        return tracker.track(lifecycle, reservation, job, () => {});
      },
    });
    const trackedJob = listener({
      method: 'Fetch.requestPaused', sessionId: 'worker-session',
      params: { requestId: 'malformed-custom', request: {
        url: 'https://benchmark-custom.invalid/v1/chat/completions', method: 'POST', postData: '{',
      } },
    });
    expect(order).toEqual(['reserve', 'admission', 'handler', 'track']);
    expect(lifecycle.handlerCount).toBe(1);
    await trackedJob;
    const cleanup = await lifecycle.closeAndDrain({ disableFetch: async () => {}, timeoutMs: 1_000 });
    expect(releases).toEqual([{ requestId: 'malformed-custom', errorReason: 'BlockedByClient' }]);
    expect(cleanup).toMatchObject({
      ok: true, handlerCount: 0, reservations: [{
        requestId: 'malformed-custom', releaseAction: 'fail', handlerSettled: true,
      }],
    });
    expect(tracker.jobs.size).toBe(0);
  });
  it('does not fail completed or non-held Fetch reservations during teardown', async () => {
    const dispatchRelease = vi.fn(async (reservation, action) => ({
      ok: true, action, requestId: reservation.requestId,
    }));
    const lifecycle = createCancellationRequestLifecycle(dispatchRelease);
    const completed = lifecycle.reserve({ requestId: 'fetch-completed', sessionId: 'worker-session' });
    const held = lifecycle.reserve({ requestId: 'fetch-held', sessionId: 'worker-session' });
    expect(held.hold()).toBe(true);
    await completed.release('fulfill');
    lifecycle.trackHandler(completed, Promise.resolve());
    lifecycle.trackHandler(held, held.waitForRelease());
    let admittedDuringClose;
    const cleanup = await lifecycle.closeAndDrain({
      disableFetch: async () => {
        admittedDuringClose = lifecycle.reserve({ requestId: 'fetch-late', sessionId: 'worker-session' });
        expect(admittedDuringClose.hold()).toBe(false);
        lifecycle.trackHandler(admittedDuringClose, Promise.resolve());
      },
      timeoutMs: 1_000,
    });
    expect(dispatchRelease).toHaveBeenCalledTimes(3);
    expect(dispatchRelease).toHaveBeenCalledWith(held, 'fail', { reason: 'teardown' });
    expect(dispatchRelease).toHaveBeenCalledWith(completed, 'fulfill', {});
    expect(dispatchRelease).toHaveBeenCalledWith(admittedDuringClose, 'fail', { reason: 'teardown' });
    expect(cleanup).toMatchObject({
      ok: true, reservations: [
        { requestId: 'fetch-completed', held: false, releaseRequested: true, releaseAction: 'fulfill', releaseOutcome: { ok: true }, handlerSettled: true },
        { requestId: 'fetch-held', held: true, releaseRequested: true, releaseAction: 'fail', releaseOutcome: { ok: true }, handlerSettled: true },
        { requestId: 'fetch-late', held: false, releaseRequested: true, releaseAction: 'fail', releaseOutcome: { ok: true }, handlerSettled: true },
      ],
    });
  });
  it('does not fail Fetch reservations with a terminal response, including late admissions', async () => {
    const dispatchRelease = vi.fn(async (reservation, action) => ({ ok: true, action, requestId: reservation.requestId }));
    const lifecycle = createCancellationRequestLifecycle(dispatchRelease);
    const completed = lifecycle.reserve({
      requestId: 'fetch-direct-completion', sessionId: 'worker-session',
      requestRecord: { response: { status: 200 } },
    });
    const pending = lifecycle.reserve({ requestId: 'fetch-pending-record', sessionId: 'worker-session', requestRecord: {} });
    lifecycle.trackHandler(completed, Promise.resolve());
    lifecycle.trackHandler(pending, pending.waitForRelease());
    let lateCompleted;
    let latePending;
    const cleanup = await lifecycle.closeAndDrain({
      disableFetch: async () => {
        lateCompleted = lifecycle.reserve({
          requestId: 'fetch-late-completed', sessionId: 'worker-session',
          requestRecord: { response: { status: 200 } },
        });
        latePending = lifecycle.reserve({ requestId: 'fetch-late-pending', sessionId: 'worker-session', requestRecord: {} });
        lifecycle.trackHandler(lateCompleted, Promise.resolve());
        lifecycle.trackHandler(latePending, latePending.waitForRelease());
      },
      timeoutMs: 1_000,
    });
    expect(dispatchRelease).toHaveBeenCalledTimes(2);
    expect(dispatchRelease).toHaveBeenCalledWith(pending, 'fail', { reason: 'teardown' });
    expect(dispatchRelease).toHaveBeenCalledWith(latePending, 'fail', { reason: 'teardown' });
    expect(dispatchRelease).not.toHaveBeenCalledWith(completed, 'fail', expect.anything());
    expect(dispatchRelease).not.toHaveBeenCalledWith(lateCompleted, 'fail', expect.anything());
    expect(cleanup.ok).toBe(true);
  });
  it('allows only one concurrent eligible Google timeout request to claim the hold', () => {
    const protocol = { claimed: false, held: null };
    expect(claimGoogleTimeoutRequest(protocol)).toBe(true);
    expect(claimGoogleTimeoutRequest(protocol)).toBe(false);
    expect(commitGoogleTimeoutRequest(protocol, { requestId: 'held-fetch' })).toBe(true);
    expect(protocol).toMatchObject({ claimed: false, held: { requestId: 'held-fetch' } });
    expect(claimGoogleTimeoutRequest(protocol)).toBe(false);
    expect(commitGoogleTimeoutRequest(protocol, { requestId: 'second-fetch' })).toBe(false);
  });
  it('rejects an acknowledged held Fetch release without cancellation diagnostics', () => {
    expect(classifyHeldFetchRelease({
      heldRequestId: 'held-fetch', matchedRequestId: 'held-fetch',
      releaseOutcome: { ok: true, action: 'fail' },
    }).ok).toBe(false);
  });
  it('updates the exact timeout controller abort observer with the Page session before handleTimeout aborts', () => {
    const ledger = createCancellationLedger();
    const observers = new Map();
    const controller = new AbortController();
    const timeout = ledger.begin('service.handleTimeout', 'page-session', { messageId: 'batch-timeout' });
    const observer = ensureCancellationAbortObserver({
      messageId: 'batch-timeout', sessionId: 'page-session', controller, observers, ledger,
      context: 'page-translation-batch', sequence: timeout.sequence,
    });
    expect(observer).toBeTruthy();
    controller.abort();
    expect(ledger.snapshot().operations.at(-1)).toMatchObject({
      kind: 'controller.abort', messageId: 'batch-timeout', sessionId: 'page-session',
      context: 'page-translation-batch', cancelRequestSequence: timeout.sequence,
      abortedBefore: false, abortedAfter: true,
    });
  });
  it('includes the queue projector in provenance and keeps Google resilience injection Google-only 503', () => {
    const source = readFileSync('scripts/dev/page-translation/e2e-benchmark/run.mjs', 'utf8');
    expect(source).toContain("'scripts/dev/page-translation/e2e-benchmark/rate-limit-queue.mjs'");
    const trialSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs', 'utf8');
    const networkSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/network-interception.mjs', 'utf8');
    const googleSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/resilience/googlev2-503.mjs', 'utf8');
    expect(trialSource).toContain('const handlerLifecycle = cancellationControl?.requestLifecycle');
    expect(trialSource).toContain('handlerJobTracker.track(lifecycle, reservation, job');
    expect(networkSource).toContain('lifecycle.trackHandler(reservation, job)');
    expect(trialSource).toContain('? resilienceEvidence.queueRetryEvidence ?? null');
    expect(trialSource).toContain("executeGoogleV2_503({");
    expect(googleSource).toContain('status: 503');
    expect(googleSource).not.toMatch(/custom-429|Retry-After|retryAfterSeconds|status: 429/);
  });

  it('keeps interception and resilience execution at the approved module boundaries', () => {
    const base = 'scripts/dev/page-translation/e2e-benchmark';
    const network = readFileSync(`${base}/network-interception.mjs`, 'utf8');
    expect(network).toContain('createFetchRequestListener');
    expect(network).toContain('createProviderNetworkObserver');
    expect(network).toContain('decodeProviderRequest');
    expect(network).toContain('fulfillPausedFetch');
    expect(network).toContain('failPausedFetch');
    expect(network).toContain('continuePausedFetch');
    expect(network).toContain('closeNetworkRequestLifecycle');
    expect(network).toContain('runNetworkGuardNegativeProbe');

    const boundaries = [
      ['googlev2-503.mjs', 'executeGoogleV2_503'],
      ['googlev2-timeout.mjs', 'executeGoogleV2Timeout'],
      ['custom-429.mjs', 'executeCustom429Request'],
      ['custom-400.mjs', 'executeCustom400'],
      ['gemini-structured-recovery.mjs', 'executeGeminiStructuredRecovery'],
    ];
    for (const [file, executionOwner] of boundaries) {
      const source = readFileSync(`${base}/resilience/${file}`, 'utf8');
      expect(source).toContain(`function ${executionOwner}`);
      expect(source).toContain(file === 'googlev2-503.mjs' ? 'evidence.attempts.push(base)' : 'collect');
      expect(source).toMatch(/validate.*Evidence/);
      expect(source).not.toMatch(/\btrial\b/);
    }
    const runner = readFileSync(`${base}/trial-runner.mjs`, 'utf8');
    const cancellationRunner = readFileSync(`${base}/cancellation-runner.mjs`, 'utf8');
    const staleRunner = readFileSync(`${base}/stale-success-runner.mjs`, 'utf8');
    const validationRunner = readFileSync(`${base}/trial-validation.mjs`, 'utf8');
    expect(runner).toContain('runCancellationProbe({');
    expect(runner).toContain('runStaleSuccessProbe({');
    expect(runner).toContain('cleanupStaleSuccessProbe({');
    expect(runner).toContain('validateTrialTranslation');
    expect(runner).toContain('collectProviderRuntimeEvidence({');
    expect(cancellationRunner).toContain('export async function runCancellationProbe');
    expect(cancellationRunner).toContain('trial.cancellation.quiescence =');
    expect(cancellationRunner).toContain('trial.status = \'passed\'');
    expect(staleRunner).toContain('export async function runStaleSuccessProbe');
    expect(staleRunner).toContain('trial.staleSuccess.replacementOverlap =');
    expect(staleRunner).toContain('export async function cleanupStaleSuccessProbe');
    expect(staleRunner).toContain('teardownSuccessfulReplyGate({');
    expect(runner).not.toContain('trial.cancellation.quiescence =');
    expect(runner).not.toContain('trial.staleSuccess.replacementOverlap =');
    const fetchDrainAt = runner.indexOf('lifecycle: cancellationControl.requestLifecycle');
    const gateCleanupAt = runner.indexOf('cleanupStaleSuccessProbe({');
    const rawMutationDrainAt = runner.indexOf('finishSuccessfulReplyMutationCapture()');
    const bestEffortRestoreAt = runner.indexOf('Cancellation probe best-effort restore:');
    const measurementStopAt = runner.indexOf('await cleanupMeasurementBeforeResources({');
    expect(fetchDrainAt).toBeGreaterThanOrEqual(0);
    expect(fetchDrainAt).toBeGreaterThan(gateCleanupAt);
    expect(rawMutationDrainAt).toBeGreaterThan(fetchDrainAt);
    expect(bestEffortRestoreAt).toBeGreaterThan(rawMutationDrainAt);
    expect(measurementStopAt).toBeGreaterThan(bestEffortRestoreAt);
    expect(validationRunner).toContain('validateTranslation');
    expect(validationRunner).toContain('collectProviderRuntimeEvidence');
    expect(network).not.toMatch(/\btrial\b/);
    expect(runner).toContain('guardSessions, now, requests: trial.requests,');
    expect(runner).toContain('requests: trial.requests, chrome, pageSession');
    for (const owner of [
      'executeGoogleV2_503', 'executeGoogleV2Timeout', 'executeCustom429Request',
      'executeCustom400', 'executeGeminiStructuredRecovery', 'collectGoogleV2TimeoutEvidence',
      'collectCustom429Evidence', 'collectCustom400Evidence', 'collectGeminiStructuredRecoveryEvidence',
    ]) {
      expect(runner).not.toMatch(new RegExp(`${owner}\\(\\{[^}]*\\btrial\\s*(?:,|}|:)`));
    }
    expect(runner).toContain('sessionId: trial.sessionId');
    expect(runner).toContain('trial.resilience = { ...resilienceEvidence, ...timeoutEvidence };');
    expect(runner).not.toContain("if (resilienceProbe === 'googlev2-503' && classification.provider === 'googlev2') {\n          const networkId");
    expect(runner).toContain('shouldEnableResilienceQueueProbe(resilienceProbe)');
    expect(runner).toContain('shouldEnableResilienceQueueProbe,');
    expect(runner).toContain('texts: decodedProvider.texts');
    expect(runner).not.toContain('texts: decoded.texts');
  });
  it('dispatches shared probe commands and gates successful reply capture in focused runners', async () => {
    const commands = [];
    let clock = 0;
    const send = createCancellationCommandSender({
      send: async command => { commands.push(command); return { success: true }; },
      now: () => ++clock,
      record: () => {},
    });
    expect(await send('page-restore')).toEqual({ success: true });
    expect(commands).toEqual([{ action: 'page-restore' }]);
    const gate = await waitForSuccessfulReplyCapture({
      snapshot: async () => ({ gate: { captured: true } }),
      until: async read => read(),
    });
    expect(gate.gate.captured).toBe(true);
    await expect(waitForSuccessfulReplyCapture({
      snapshot: async () => ({ gate: { status: 'failed', error: 'closed' } }),
      until: async read => read(),
    })).rejects.toThrow('Successful reply gate failed before capture: closed');
    expect(validateTrialTranslation({
      originals: [['target-1', 'source']],
      translated: [['target-1', '\u200efixture translation: source']],
      requests: ['source'],
      restored: new Map([['target-1', 'source']]),
      acceptedIds: ['target-1'],
      admittedIds: ['target-1'],
      enqueuedIds: ['target-1'],
    })).toMatchObject({ ok: true, translatedCount: 1, originalCount: 1 });
  });
  it('collects only successful same-session Google 503 siblings with non-overlapping target identity', () => {
    const failed = { attemptId: 'failed', pageSessionId: 'session-a', targetIds: ['target-a'], status: 503 };
    const sameSessionSibling = { attemptId: 'sibling', pageSessionId: 'session-a', targetIds: ['target-b'], status: 200 };
    const evidence = {
      injected503: [failed],
      attempts: [
        failed,
        sameSessionSibling,
        { attemptId: 'wrong-session', pageSessionId: 'session-b', targetIds: ['target-c'], status: 200 },
        { attemptId: 'overlap', pageSessionId: 'session-a', targetIds: ['target-a', 'target-b'], status: 200 },
        { attemptId: 'empty-targets', pageSessionId: 'session-a', targetIds: [], status: 200 },
        { attemptId: 'failed-attempt', pageSessionId: 'session-a', targetIds: ['target-c'], status: 503 },
      ],
      siblingRequests: [],
    };
    finalizeGoogleV2_503Evidence(evidence);
    expect(evidence.siblingRequests).toEqual([sameSessionSibling]);
    const runner = readFileSync('scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs', 'utf8');
    const finalizeAt = runner.indexOf('finalizeGoogleV2_503Evidence(trial.resilience);');
    const validateAt = runner.indexOf("trial.resilience.validation = resilienceProbe === 'googlev2-503'");
    expect(finalizeAt).toBeGreaterThanOrEqual(0);
    expect(finalizeAt).toBeLessThan(validateAt);
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
  it('validates isolated Custom permanent-failure probes and exact partial-success evidence', () => {
    const runSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs', 'utf8');
    const probeSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/resilience/custom-400.mjs', 'utf8');
    expect(parseResilienceProbeSelection('custom-400')).toEqual(['custom-400']);
    expect(shouldEnableResilienceQueueProbe('custom-400')).toBe(true);
    expect(probeSource).toContain('requestRecord.requestViewport = await evaluate(chrome, pageSession');
    expect(runSource).toContain('translated.filter(([id]) => !custom400FailedIds.has(id))');
    expect(probeSource).toContain('const ids = item.batchTexts?.map(text =>');
    expect(probeSource).not.toContain('const ids = item.batchIds ??');
    expect(runSource).toContain("el?.hasAttribute('data-page-translated')");
    expect(runSource).toContain("el?.hasAttribute('data-has-original')");
    expect(runSource).toContain('if (custom400Protocol?.armed)');
    expect(probeSource).toContain('isCustom400ProbeWindowRequest(requestRecord, protocol.armedWallMs)');
    expect(probeSource).toContain('const consider400 = !protocol.considered;');
    expect(validateResilienceProbeIsolation({
      selected: true, probe: 'custom-400', provider: 'custom', optimizationLevel: 3,
      modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid',
    })).toBe(true);
    expect(() => validateResilienceProbeIsolation({
      selected: true, probe: 'custom-400', provider: 'custom', optimizationLevel: 3,
      modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid', competingProbe: true,
    })).toThrow();

    const texts = Array.from({ length: 25 }, (_, index) => `source-${index}`);
    const targetIds = Array.from({ length: 25 }, (_, index) => `target-${index}`);
    expect(partitionBandAcceptance(['a', 'b', 'c'], ['a', 'c'], ['b'])).toEqual({
      acceptedIds: ['a', 'c'], failedTargetIds: ['b'],
    });
    expect(partitionBandAcceptance(['a', 'b'], ['a', 'b'], ['b'])).toEqual({
      acceptedIds: ['a'], failedTargetIds: ['b'],
    });
    expect(isCustom400ProbeWindowRequest({ startedAt: 120 }, 100)).toBe(true);
    expect(isCustom400ProbeWindowRequest({ startedAt: 120 }, 130)).toBe(false);
    expect(isCustom400ProbeWindowRequest({}, 100)).toBe(false);
    const resolver = { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' };
    const request = { networkId: 'network-a', sessionId: 'session-a', texts, targetIds, physicalStartedWallMs: 200 };
    const root = { messageId: 'message-a', sessionId: 'session-a', texts };
    const classification = { kind: 'provider-translation', provider: 'custom' };
    expect(selectResolvedCustom400Batch({ request, classification, resolver, roots: [root], failedCount: 0, armedWallMs: 100 }))
      .toMatchObject({ selected: true, messageId: 'message-a', targetIds });
    expect(selectResolvedCustom400Batch({ request: { ...request, texts: texts.slice(0, 24) },
      classification, resolver, roots: [root], failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedCustom400Batch({ request, classification, resolver, roots: [root, root], failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedCustom400Batch({ request: { ...request, physicalStartedWallMs: 99 },
      classification, resolver, roots: [root], failedCount: 0, armedWallMs: 100 }).selected).toBe(false);
    expect(selectResolvedCustom400Batch({ request: { ...request, targetIds: [...targetIds.slice(1), targetIds[1]] },
      classification, resolver, roots: [root], failedCount: 0, armedWallMs: 100 }).selected).toBe(false);

    const queueEvents = [
      { name: 'queueManager.processItem.start', queueItemId: 'item-a', messageId: 'message-a', attemptNumber: 1 },
      { name: 'queueManager.processItem.end', queueItemId: 'item-a', messageId: 'message-a', attemptNumber: 1,
        attempts: 1, status: 'failed', lastErrorType: 'HTTP_ERROR', retryTimerActive: false, retryScheduledAt: null, retryAt: null },
    ];
    const queueAttemptEvidence = validateCustom400QueueEvidence(queueEvents, { messageId: 'message-a', targetIds });
    expect(queueAttemptEvidence.ok).toBe(true);
    expect(validateCustom400QueueEvidence([], { messageId: 'message-a' }).ok).toBe(false);
    expect(validateCustom400QueueEvidence([...queueEvents, queueEvents[0]], { messageId: 'message-a' }).ok).toBe(false);
    expect(validateCustom400QueueEvidence(queueEvents.map(event => event.name.endsWith('.end')
      ? { ...event, lastErrorType: 'SERVER_ERROR' } : event), { messageId: 'message-a' }).ok).toBe(false);
    expect(validateCustom400QueueEvidence(queueEvents.map(event => event.name.endsWith('.end')
      ? { ...event, retryTimerActive: true } : event), { messageId: 'message-a' }).ok).toBe(false);

    const failed = {
      attemptId: 'attempt-a', networkId: 'network-a', networkSessionId: 'network-session', status: 400, networkStatus: 400,
      networkOutcome: 'finished', errorBody: { error: { code: 400, message: 'Invalid request parameters' } },
      logicalMessageId: 'message-a', queueItemId: 'item-a', pageSessionId: 'session-a', targetIds, texts,
    };
    const evidence = {
      injected400: [failed], attempts: Array.from({ length: 40 }, (_, index) => ({
        attemptId: index === 0 ? 'attempt-a' : `attempt-${index}`,
        networkId: index === 0 ? 'network-a' : `network-${index}`,
        networkSessionId: 'network-session',
        logicalMessageId: index === 0 ? 'message-a' : `message-${index}`,
        pageSessionId: 'session-a', targetIds: index === 0 ? targetIds : [`fixture-target-${index}`],
        status: index === 0 ? 400 : 200, networkStatus: index === 0 ? 400 : 200, networkOutcome: 'finished',
      })),
      probeWindowPhysicalAttempts: Array.from({ length: 40 }, (_, index) => ({
        attemptId: index === 0 ? 'attempt-a' : `attempt-${index}`,
        networkId: index === 0 ? 'network-a' : `network-${index}`,
        networkSessionId: 'network-session',
      })),
      expectedProbeWindowPhysicalAttemptCount: 40,
      preRestorePreArmDrain: { ok: true, requestCount: 14, outstandingCount: 0, networkIds: [] },
      arm: { sessionId: 'session-a' }, selectionFailures: [],
      failedTargetDOM: {
        expected: targetIds.map((id, index) => [id, texts[index], { pageTranslated: false, hasOriginal: false }]),
        observed: targetIds.map((id, index) => [id, texts[index], { pageTranslated: false, hasOriginal: false }]),
      },
      expectedLogicalBatchCount: 40, providerPhysicalAttemptCount: 40,
      queueAttemptEvidence, unnecessaryRetransmits: [], unexpectedRecovery: [], queueRetries: [], keyFailovers: [], circuitBreakers: [],
      translation: { exact: true, targetCount: 1000, acceptedTargetCount: 975, failedTargetCount: 25,
        duplicates: 0, duplicateAcceptedIds: [], failedSourcePreserved: true, successfulTargetsAcceptedOnce: true,
        restoreExact: true, terminal: true, sessionOwner: 'session-a' },
      concurrency: { peakPhysical: 2, peakLogical: 2, effectiveProviderLimiterCapacity: 2 },
      resources: { rateLimit: { Custom: { isCircuitOpen: false } } },
      cleanup: { ok: true },
    };
    expect(validateCustom400Evidence(evidence)).toEqual({ ok: true, issues: [] });
    expect(validateCustom400Evidence({ ...evidence, injected400: [] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, attempts: [failed, { ...failed, networkId: 'network-retry' }] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, attempts: evidence.attempts.slice(1) }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence,
      probeWindowPhysicalAttempts: evidence.probeWindowPhysicalAttempts.slice(1),
    }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, attempts: evidence.attempts.map((attempt, index) =>
      index === 1 ? { ...attempt, networkOutcome: null } : attempt) }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, attempts: evidence.attempts.map((attempt, index) =>
      index === 1 ? { ...attempt, networkId: evidence.attempts[0].networkId } : attempt) }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, attempts: evidence.attempts.map((attempt, index) =>
      index === 0 ? { ...attempt, networkStatus: 200 } : attempt) }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, failedTargetDOM: {
      ...evidence.failedTargetDOM, observed: evidence.failedTargetDOM.observed.map((item, index) =>
        index === 0 ? [item[0], item[1], { pageTranslated: true, hasOriginal: true }] : item),
    } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, unexpectedRecovery: [{ networkId: 'network-retry' }] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, unnecessaryRetransmits: [{ targetIds: ['target-0'] }] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, injected400: [{ ...failed, errorBody: null }] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, translation: { ...evidence.translation, acceptedTargetCount: 1000 } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, translation: { ...evidence.translation, exact: false } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, translation: { ...evidence.translation, failedSourcePreserved: false } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, translation: { ...evidence.translation, successfulTargetsAcceptedOnce: false } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, expectedLogicalBatchCount: 41 }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, selectionFailures: [{ reason: 'bad batch' }] }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, concurrency: { ...evidence.concurrency, peakPhysical: 1, peakLogical: 1 } }).ok).toBe(true);
    expect(validateCustom400Evidence({ ...evidence, concurrency: { ...evidence.concurrency, peakPhysical: 3 } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, concurrency: { ...evidence.concurrency, peakLogical: null } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, resources: { rateLimit: { Custom: { isCircuitOpen: true } } } }).ok).toBe(false);
    expect(validateCustom400Evidence({ ...evidence, resources: { rateLimit: { Custom: {} } } }).ok).toBe(false);
  });
  it('selects and validates one isolated Gemini structured recovery with production call-purpose attribution', () => {
    expect(parseResilienceProbeSelection('gemini-structured-recovery')).toEqual(['gemini-structured-recovery']);
    expect(shouldEnableResilienceQueueProbe('gemini-structured-recovery')).toBe(true);
    expect(validateResilienceProbeIsolation({
      selected: true, probe: 'gemini-structured-recovery', provider: 'gemini', optimizationLevel: 3,
      modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid',
    })).toBe(true);
    expect(() => validateResilienceProbeIsolation({
      selected: true, probe: 'gemini-structured-recovery', provider: 'gemini', optimizationLevel: 3,
      modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid', competingProbe: true,
    })).toThrow();
    const root = { messageId: 'message-a', sessionId: 'session-a', texts: ['source-a'] };
    const request = { networkId: 'network-a', sessionId: 'session-a', texts: root.texts };
    const resolver = { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' };
    expect(selectResolvedGeminiAttempt({ request, classification: { kind: 'provider-translation', provider: 'gemini' }, resolver, roots: [root], failedCount: 0 }))
      .toMatchObject({ selected: true, messageId: 'message-a', source: 'en', target: 'fr' });
    expect(selectResolvedGeminiAttempt({ request, classification: { kind: 'provider-translation', provider: 'gemini' },
      resolver: { ...resolver, resolutionPending: true }, roots: [root], failedCount: 0 }).selected).toBe(false);
    expect(selectResolvedGeminiAttempt({ request, classification: { kind: 'provider-translation', provider: 'gemini' },
      resolver, roots: [root, root], failedCount: 0 }).selected).toBe(false);

    const malformedEnvelope = mapMalformedGeminiResponse();
    expect(malformedEnvelope.candidates[0].finishReason).toBe('STOP');
    expect(() => JSON.parse(malformedEnvelope.candidates[0].content.parts[0].text)).toThrow();
    const texts = ['source-a'];
    const identity = { attemptId: 'primary', messageId: 'message-a', sessionId: 'session-a', targetIds: ['target-a'], texts };
    const validMappedResponse = mapGeminiResponse({ ids: ['0'], texts });
    expect(isMappedGeminiResponse(validMappedResponse, { ids: ['0'], texts })).toBe(true);
    expect(isMappedGeminiResponse(malformedEnvelope, { ids: ['0'], texts })).toBe(false);
    const evidence = {
      injectedMalformed: [{ ...identity, httpStatus: 200, jsonValid: false, envelopeValid: true }],
      recovery: [{ ...identity, attemptId: 'recovery', valid: true, httpStatus: 200, networkStatus: 200,
        networkOutcome: 'finished', envelopeValid: true, outputValid: true }],
      executionCalls: [
        { callPurpose: 'PRIMARY_TRANSLATION', ...identity },
        { callPurpose: 'STRUCTURED_RECOVERY', ...identity },
      ],
      structuredRecoveryEntries: [{ callPurpose: 'STRUCTURED_RECOVERY', fullParseRecoveryRetry: true, ...identity }],
      physicalAttempts: [
        { role: 'malformed-primary', responseStatus: 200, networkStatus: 200, networkOutcome: 'finished', keyIdentity: 'synthetic-fixture' },
        { role: 'structured-recovery', responseStatus: 200, networkStatus: 200, networkOutcome: 'finished', keyIdentity: 'synthetic-fixture' },
      ],
      queueAttemptEvidence: validateGeminiQueueAttemptEvidence([
        { name: 'queueManager.processItem.start', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1 },
        { name: 'queueManager.processItem.end', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1, attempts: 1, status: 'completed', retryTimerActive: false },
      ], { messageId: 'message-a' }),
      unexpectedPhysicalAttempts: [],
      unexpectedRetransmits: [], unnecessaryRetransmits: [], queueRetries: [], keyFailovers: [], parentRecoveries: [],
      concurrency: { peakPhysical: 3, peakLogical: 3, effectiveProviderLimiterCapacity: 3 },
      translation: { exact: true, duplicates: 0, targetCount: 1000, restoreExact: true, acceptedTargetCount: 1000, duplicateAcceptedIds: [] },
      cleanup: { ok: true },
    };
    expect(validateGeminiStructuredRecovery(evidence)).toEqual({ ok: true, issues: [] });
    expect(validateGeminiQueueAttemptEvidence([], { messageId: 'message-a' }).ok).toBe(false);
    const queueAttempt = [
      { name: 'queueManager.processItem.start', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1 },
      { name: 'queueManager.processItem.end', queueItemId: 'queue-a', messageId: 'message-a', attemptNumber: 1, attempts: 1, status: 'completed', retryTimerActive: false },
    ];
    expect(validateGeminiQueueAttemptEvidence(queueAttempt, { messageId: 'message-a' }).ok).toBe(true);
    expect(validateGeminiQueueAttemptEvidence([...queueAttempt, queueAttempt[0]], { messageId: 'message-a' }).ok).toBe(false);
    expect(validateGeminiQueueAttemptEvidence(queueAttempt.map(event => event.name.endsWith('.end')
      ? { ...event, status: 'retrying', retryTimerActive: true } : event), { messageId: 'message-a' }).ok).toBe(false);
    expect(validateGeminiQueueAttemptEvidence(queueAttempt.map(event => event.name.endsWith('.end')
      ? { ...event, attempts: 2 } : event), { messageId: 'message-a' }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, queueAttemptEvidence: undefined }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, recovery: [{ ...evidence.recovery[0], valid: false }] }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, unexpectedRetransmits: [{ targetIds: ['target-a'] }] }).issues)
      .toContain('unexpected Gemini retransmissions were observed');
    expect(validateGeminiStructuredRecovery({ ...evidence, executionCalls: [...evidence.executionCalls, evidence.executionCalls[1]] }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, queueRetries: [{ attemptNumber: 2 }] }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, concurrency: { ...evidence.concurrency, peakPhysical: 4 } }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, concurrency: { ...evidence.concurrency, peakLogical: 4 } }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, concurrency: { ...evidence.concurrency, peakLogical: null } }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, concurrency: { ...evidence.concurrency, effectiveProviderLimiterCapacity: 2 } }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, concurrency: { peakPhysical: 3, peakLogical: 3 } }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, physicalAttempts: [...evidence.physicalAttempts, {
      role: 'unexpected', responseStatus: 200, networkStatus: 200, networkOutcome: 'finished', keyIdentity: 'unexpected',
    }], unexpectedPhysicalAttempts: [{ role: 'key-failover-or-unexpected-attempt' }], keyFailovers: [{ networkId: 'extra' }] }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, recovery: [{ ...evidence.recovery[0], networkOutcome: 'failed' }] }).ok).toBe(false);
    expect(validateGeminiStructuredRecovery({ ...evidence, structuredRecoveryEntries: [{ ...evidence.structuredRecoveryEntries[0], fullParseRecoveryRetry: false }] }).ok).toBe(false);
  });
  it('gates Gemini payload attribution and BaseAI payload capture behind the selected probe', () => {
    const source = readFileSync('scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs', 'utf8');
    expect(source).toMatch(/function matchGeminiProviderRoot\(body, sessionId\) \{\s*if \(!geminiStructuredRecoveryProbeEnabled\) return null;/);
    expect(source).toMatch(/enableGeminiStructuredRecoveryProbe\(\) \{\s*return installGeminiStructuredRecoveryInstrumentation\(\);/);
    const runSource = readFileSync('scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs', 'utf8');
    expect(runSource).toMatch(/if \(resilienceProbe === 'gemini-structured-recovery'\)[\s\S]*?enableGeminiStructuredRecoveryProbe\(\)/);
    expect(source).not.toMatch(/^installCallThrough\(BaseAIProvider\.prototype, '_translateBatch'/m);
    expect(source).toMatch(/\.\.\.\(geminiStructuredRecoveryProbeEnabled && \{/);
    expect(source).toContain('callPurpose: options?.callPurpose ?? null');
    expect(source).toContain('texts: matchingRoot?.texts ?? null');
    expect(source).toMatch(/const messageId = geminiStructuredRecoveryProbeEnabled/);
    expect(source).toMatch(/const matchingRoot = geminiStructuredRecoveryProbeEnabled/);
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
  it('collects Custom 429 protocol evidence from the supplied protocol', () => {
    const roles = { A: { attemptId: 'failed' }, B: { attemptId: 'sibling' } };
    const protocol = { evidence: {
      roles, serverRetryAt: 10, limiterRetryAt: 20, limiterRetryAtAfterSibling: 20,
      pendingStillQueuedAfterSibling: true, cooldownEstablishedWallMs: 15,
    } };
    const failed = { attemptId: 'failed', logicalMessageId: 'message-a', pageSessionId: 'session-a',
      targetIds: ['target-a'], responseMonoMs: 10, responseWallMs: 10 };
    const evidence = { attempts: [], injected429: [failed], cooldownObserved: {} };
    collectCustom429Evidence({
      evidence, protocol, failed, resources: { rateLimit: { Custom: { queueItems: [] } } },
      workerTrace: {}, providerAttempts: [], providerNetworkEvents: new Map(), sessionId: 'session-a',
      providerPhysicalAttempts: [], traceEvents: () => [], summarizePhysicalProviderAttempts: () => ({ peakPhysicalConcurrency: 1 }),
      validateQueueRetryEvidence: () => ({ ok: true, observed: {} }), peakLogicalConcurrency: 1,
    });
    expect(evidence.roles).toBe(roles);
    expect(evidence.serverRetryAt).toBe(10);
    expect(evidence.limiterRetryAtAfterSibling).toBe(20);
    expect(evidence.pendingStillQueuedAfterSibling).toBe(true);
    expect(evidence.cooldown).toMatchObject({ establishedWallMs: 15, limiterRetryAt: 20 });
  });
  it('collects Gemini structured-recovery evidence without a free-variable selection guard', () => {
    const evidence = { attempts: [], injectedMalformed: [] };
    collectGeminiStructuredRecoveryEvidence({
      evidence, failed: { messageId: 'message-a', texts: ['source'], targetIds: ['target-a'] },
      workerTrace: {}, traceEvents: () => [], providerAttempts: [], providerNetworkEvents: new Map(),
      sessionId: 'session-a', isMappedGeminiResponse: () => false, providerPhysicalAttempts: [],
      summarizePhysicalProviderAttempts: () => ({ peakPhysicalConcurrency: 2 }),
      validateGeminiQueueAttemptEvidence: () => ({ ok: true }), peakLogicalConcurrency: 3,
      effectiveProviderLimiterCapacity: 4,
    });
    expect(evidence).toMatchObject({
      executionCalls: [], structuredRecoveryEntries: [], physicalAttempts: [],
      unexpectedPhysicalAttempts: [], parentRecoveries: [],
      concurrency: { peakPhysical: 2, peakLogical: 3, effectiveProviderLimiterCapacity: 4 },
    });
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

  it('allows only the explicitly selected failed timeout attempt without a response status', () => {
    const timeoutAttempt = {
      attemptId: 'timeout', networkSessionId: 'worker', networkId: 'timeout-network',
      startedAt: 1, settledAt: 8, status: null, outcome: 'failed', error: 'net::ERR_ABORTED',
    };
    expect(summarizePhysicalProviderAttempts([timeoutAttempt], {
      expectedTimeoutAbortAttemptId: 'timeout',
    }).ok).toBe(true);
    expect(summarizePhysicalProviderAttempts([timeoutAttempt]).issues).toEqual(expect.arrayContaining([
      expect.stringContaining('lacks correlated response status'),
      expect.stringContaining('failed'),
    ]));
    const otherFailures = summarizePhysicalProviderAttempts([
      timeoutAttempt,
      { ...timeoutAttempt, attemptId: 'other-failed', networkId: 'other-network', status: 503 },
      { ...timeoutAttempt, attemptId: 'other-missing-status', networkId: 'missing-network', outcome: 'finished' },
    ], { expectedTimeoutAbortAttemptId: 'timeout' });
    expect(otherFailures.ok).toBe(false);
    expect(otherFailures.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('other-failed failed'),
      expect.stringContaining('other-missing-status lacks correlated response status'),
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
    expect(validateScrollThroughEvidence({ ...args, expectedAcceptedIds: ['a'], acceptedIds: ['a'],
      acceptedAtById: { a: 15 }, terminalAt: 20 }).ok).toBe(true);
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
    expect(deriveScrollAggregateMetrics([{ band: 1, ids: ['a', 'b'] }], { a: 10, b: 20 }, { a: 12 },
      ['a']).latencyByViewportBand).toEqual([
      { band: 1, targetCount: 1, measurableCount: 1, prefetchCount: 0, meanMs: 2, medianMs: 2, maxMs: 2 },
    ]);
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

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { launchChrome } from './chrome.mjs';
import { canonicalProviderSourceAttempts, longTasksWithinInterval, mapEdgeResponse, mapProviderHTTPRequestSequence, summarizeLongTasks, validateEffectiveSettings, validatedLongTaskObservation, validateWindowMembership } from './metrics.mjs';
import { GOOGLE_V2_ENDPOINT } from './google-v2-fixture.mjs';
import { CUSTOM_FIXTURE_ENDPOINT, mapCustomStaleSuccessResponse as mapCustomFixtureStaleResponse } from './custom-fixture.mjs';
import { isMappedGeminiResponse, mapMalformedGeminiResponse } from './gemini-fixture.mjs';
import { createFixture, startFixture, startupVoicesResponse } from './fixture.mjs';
import { cleanupMeasurementBeforeResources, completeTranslationMeasurement, findFinalTranslationTerminal, summarizeAcceptanceTimes } from './measurement-lifecycle.mjs';
import { deriveScrollAggregateMetrics, isProviderWorkloadTrial, mapProviderBatchIds, providerLaneSettings, pageTranslationStartMessage, summarizeLogicalProviderBatches, summarizeSpaLogicalProviderBatches, summarizePhysicalProviderAttempts, validateProviderConcurrencyObservations, validateProviderNetworkCorrelation, validateProviderRuntime, validateProviderSchedulerRuntime, observedPageWorkerLimit, settingsForScenario, shadowInitialTranslationReadiness, validateDiscoveryFlags, validateExactTargetIds, validateFixtureGeometry, validateScrollThroughEvidence, validateShadowInitialObservations, validateSpaNavigation, validateSpaObserverRestoreOrder, validateSpaProviderRoute, validateSpaSessions, validateSpaTerminal, scrollThroughPhases, usesBandedProviderScroll } from './scenario-plan.mjs';
import { classifyHeldFetchRelease, promoteRequestDiagnostics, selectCustomProviderRoot } from './cancellation-probes.mjs';
import { classifyStaleSuccessProviderOwner, createWorkerNetworkEventRouter, selectCustomPhysicalOperation, validateRawDOMMutationEvidence, validateRuntimeResources } from './successful-reply-probes.mjs';
import { isCustom400ProbeWindowRequest, partitionBandAcceptance, shouldEnableResilienceQueueProbe, validateCustom400QueueEvidence, validateGeminiQueueAttemptEvidence, validateGoogleTimeoutQueueEvidence, validateQueueRetryEvidence, validateResilienceAccounting } from './resilience-probes.mjs';
import { createProviderNetworkObserver, createNetworkRequestLifecycle, createHandlerJobTracker, createFetchRequestListener, createCustomFetchSettlement, createNetworkSessionState, registerGuardedSession, closeNetworkRequestLifecycle, createNetworkCleanupSteps, enableFetchGuard, enableProviderNetworkObservation, fulfillPausedFetch, failPausedFetch, continuePausedFetch, runNetworkGuardNegativeProbe, classifyPausedRequest, decodeProviderRequest } from './network-interception.mjs';
import { createGoogleV2_503Evidence, executeGoogleV2_503, finalizeGoogleV2_503Evidence, validateGoogleV2_503Evidence } from './resilience/googlev2-503.mjs';
import { createGoogleV2TimeoutProtocol, armGoogleV2Timeout, executeGoogleV2Timeout, collectGoogleV2TimeoutEvidence, recordGoogleTimeoutFailedTargetDOM, validateGoogleV2TimeoutEvidence } from './resilience/googlev2-timeout.mjs';
import { createCustom429Protocol, armCustom429, claimCustom429Request, executeCustom429Request, collectCustom429Evidence, validateCustom429ProbeEvidence } from './resilience/custom-429.mjs';
import { createCustom400Protocol, armCustom400, executeCustom400, collectCustom400Evidence, recordCustom400PreRestorePreArmDrain, recordCustom400FailedTargetDOM, validateCustom400ProbeEvidence } from './resilience/custom-400.mjs';
import { createCustomCancellationProtocol, awaitConcreteCustomCancellationResolver, armCustomCancellation, admitCustomCancellationRequest, executeCustomCancellation, captureCustomCancellationPreRestore, collectCustomCancellationEvidence, validateCustomCancellationProbeEvidence } from './resilience/custom-cancellation.mjs';
import { createGeminiStructuredRecoveryEvidence, executeGeminiStructuredRecovery, collectGeminiStructuredRecoveryEvidence, validateGeminiStructuredRecoveryEvidence } from './resilience/gemini-structured-recovery.mjs';
import { runCancellationProbe } from './cancellation-runner.mjs';
import { cleanupStaleSuccessProbe, runStaleSuccessProbe } from './stale-success-runner.mjs';
import { collectProviderRuntimeEvidence, validateTrialTranslation } from './trial-validation.mjs';

const now = () => Date.now();
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(read, timeoutMs = 30_000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const value = await read();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`Timed out waiting for Chrome condition (${timeoutMs}ms)`);
}
function evaluate(chrome, sessionId, expression, contextId, awaitPromise = true) {
  return chrome.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
    ...(contextId === undefined ? {} : { contextId }),
  }, sessionId).then(result => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  });
}
function recordEvent(event, record) {
  if (event.method === 'Runtime.exceptionThrown') {
    record.exceptions.push({ sessionId: event.sessionId, params: event.params });
  } else if (['Log.entryAdded', 'Runtime.consoleAPICalled'].includes(event.method)) {
    record.console.push({ method: event.method, sessionId: event.sessionId, params: event.params });
  }
}
function traceEvents(trace) {
  if (Array.isArray(trace)) return trace;
  return Array.isArray(trace?.events) ? trace.events : [];
}
function findTrace(events, name, predicate = () => true) { return events.find(event => event.name === name && predicate(event)); }
function deriveTimings(trial, workerTrace, contentTrace, contentEvents) {
  const workerEvents = traceEvents(workerTrace);
  contentEvents ??= Array.isArray(contentTrace?.events) ? contentTrace.events : [];
  const initialTargetIds = trial.fixture.targets.map(target => target.id);
  const expectedTargetIds = contentTrace?.expectedTargetIds
    ?? [...initialTargetIds, ...(trial.fixture.dynamicCohorts ?? []).flatMap(cohort => cohort.targets.map(target => target.id))];
  const acceptance = summarizeAcceptanceTimes(contentTrace?.firstAcceptedAtById, trial.fixture.visibleIds, expectedTargetIds);
  const initialAcceptance = trial.scenario === 'dynamic-dom'
    ? summarizeAcceptanceTimes(contentTrace?.firstAcceptedAtById, trial.fixture.visibleIds, initialTargetIds)
    : acceptance;
  const backgroundAdmission = findTrace(workerEvents, 'background.translationRequest.entry');
  const queueAdmission = findTrace(workerEvents, 'queueManager.enqueue');
  const providerStart = findTrace(workerEvents, 'providerRequestEngine.executeApiCall.start');
  const providerEnd = findTrace(workerEvents, 'providerRequestEngine.executeApiCall.end');
  const discoveryStart = findTrace(contentEvents, 'bridge.discovery.pending', event => event.pending === true);
  const discoveryDrained = [...contentEvents].reverse().find(event => event.name === 'bridge.discovery.pending' && event.pending === false);
  const schedulerFlush = findTrace(contentEvents, 'scheduler.flush.entry');
  const schedulerRequestEntry = findTrace(contentEvents, 'scheduler.executeBatchRequest.entry');
  return {
    translationCommand: trial.timestamps.translationCommand,
    discoveryStart: discoveryStart?.at ?? null,
    discoveryStartUnavailableReason: discoveryStart ? null : 'Bridge discovery-pending transition not observed',
    discoveryDrained: discoveryDrained?.at ?? null,
    discoveryDrainUnavailableReason: discoveryDrained ? null : 'Bridge discovery-drained transition not observed',
    firstSchedulerFlush: schedulerFlush?.at ?? null,
    schedulerFlushUnavailableReason: schedulerFlush ? null : 'Scheduler.flush entry not observed',
    schedulerRequestEntry: schedulerRequestEntry?.at ?? null,
    schedulerRequestEntryUnavailableReason: schedulerRequestEntry ? null : 'Scheduler batch-entry instrumentation was not observed',
    runtimeMessageHandoff: null,
    runtimeMessageHandoffUnavailableReason: 'No transparent runtime.sendMessage wrapper installed; not inferred from request-entry timing',
    backgroundAdmission: backgroundAdmission?.at ?? null,
    backgroundAdmissionUnavailableReason: backgroundAdmission ? null : 'UnifiedTranslationService admission wrapper not observed',
    queueAdmission: queueAdmission?.at ?? null,
    queueAdmissionUnavailableReason: queueAdmission ? null : 'QueueManager.enqueue not observed in the real execution path',
    providerRequestStart: providerStart?.at ?? null,
    providerRequestEnd: providerEnd?.at ?? null,
    providerRequestUnavailableReason: providerStart && providerEnd ? null : 'ProviderRequestEngine wrapper did not observe both boundaries',
    transportAttempts: trial.requests.filter(request => request.category === 'provider-translation').map(request => ({ startedAt: request.startedAt, endedAt: request.endedAt, bodyLength: request.bodyLength, batchSize: request.batchSize })),
    firstVisibleAcceptedWrite: contentTrace?.firstVisibleAcceptedWriteAt ?? null,
    firstAcceptedWrite: acceptance.firstAcceptedAt,
    firstAcceptedWriteUnavailableReason: acceptance.firstAcceptedAtUnavailableReason,
    visibleSetCompletion: acceptance.visibleSetCompletionAt,
    visibleSetCompletionUnavailableReason: acceptance.visibleSetCompletionUnavailableReason,
    allAcceptedWrites: acceptance.allTargetsCompletionAt,
    allAcceptedWritesUnavailableReason: acceptance.allTargetsCompletionUnavailableReason,
    initialAllAcceptedWrites: initialAcceptance.allTargetsCompletionAt,
    initialAllAcceptedWritesUnavailableReason: initialAcceptance.allTargetsCompletionUnavailableReason,
    acceptance,
    dynamicCohorts: (contentTrace?.dynamicCohorts ?? []).map(cohort => ({ ...cohort })),
    completion: trial.terminal?.receivedAt ?? null,
    restoreStart: trial.timestamps.restoreStarted,
    restoreEnd: trial.timestamps.restoreCompleted,
    cleanup: trial.timestamps.finishedAt,
    acceptedWriteCount: contentTrace?.acceptedUniqueCount ?? null,
    visibleAtStartIds: contentEvents.filter(event => event.name === 'dom.acceptedWrite' && event.visibleAtStart === true).map(event => event.id),
    visibleAtStartCount: contentEvents.filter(event => event.name === 'dom.acceptedWrite' && event.visibleAtStart === true).length,
    longTasks: contentTrace?.longTasks ?? null,
    longTaskSummary: summarizeLongTasks(contentTrace?.longTasks ?? null),
    longTaskUnavailableReason: contentTrace?.longTasks === null
      ? (contentTrace.longTasksUnavailableReason ?? 'Trace writer omitted an unavailable-reason detail')
      : null,
    workerComponents: Object.fromEntries([...new Set(workerEvents.map(event => event.name))].map(name => [name, workerEvents.filter(event => event.name === name).length])),
    contentComponents: Object.fromEntries([...new Set(contentEvents.map(event => event.name))].map(name => [name, contentEvents.filter(event => event.name === name).length])),
  };
}
function sessionIdFromStart(response) {
  return response?.responses?.find(item => item?.success)?.messageId
    ?? response?.sessionId ?? response?.messageId ?? null;
}
function lifecyclePayload(event) { return event?.data?.data ?? event?.data ?? {}; }
function isSessionEvent(event, action, sessionId) {
  const message = event?.message ?? event;
  const payload = lifecyclePayload(message);
  const eventSession = payload.sessionId ?? payload.messageId ?? message?.data?.sessionId ?? message?.sessionId;
  return message?.action === 'page-translation-frame-lifecycle'
    && message?.data?.action === action
    && eventSession === sessionId;
}
function formatCommandFailure(action, response) { return `${action} rejected: ${JSON.stringify(response)}`; }
const normalizeProviderTexts = texts => Array.isArray(texts)
  ? texts.map(item => typeof item === 'string' ? item : item?.text)
  : [];
function sameProviderTexts(left, right) {
  const a = normalizeProviderTexts(left);
  const b = normalizeProviderTexts(right);
  return a.length > 0 && a.length === b.length && a.every((text, index) => text === b[index]);
}
function mapStaleSuccessResponse(body, sessionId, sessionA, sessionB) {
  const owner = sessionId === sessionA ? 'A' : sessionId === sessionB ? 'B' : null;
  if (!owner) throw new Error(`Stale-success fixture received an unknown Page session: ${sessionId ?? 'missing'}`);
  return mapEdgeResponse(body).map(item => ({ translations: item.translations.map(translation => ({
    ...translation,
    text: `fixture translation ${owner}: ${translation.text.slice('fixture translation: '.length)}`,
  })) }));
}
function mapCustomStaleSuccessResponse(request, owner) {
  if (!Array.isArray(request?.batchIds) || request.batchIds.length !== request.batchTexts?.length) {
    throw new Error('Custom stale-success response lacks the exact request wire IDs.');
  }
  return mapCustomFixtureStaleResponse({ ids: request.batchIds, texts: request.batchTexts }, owner);
}

export async function runTrial({ mode, scenario, ordinal, globalRunOrder, phase, extensionPath, settings, providerLane, fixtureConfig = createFixture(scenario, { providerLane: usesBandedProviderScroll(providerLane?.provider) }), networkGuardProbe = false, cancellationProbe = null, staleSuccessProbe = null, resilienceProbe = null, schedulingMode = null, probeSchedulingMode = null, browserLifetime = null, soakScenario = false }) {
  const scenarioSettings = settingsForScenario(settings, fixtureConfig.scenario, schedulingMode);
  const trialSettings = providerLane ? providerLaneSettings(scenarioSettings, providerLane) : scenarioSettings;
  const trial = {
    mode, scenario: fixtureConfig.scenario, ...(providerLane ? { lane: providerLane.lane, provider: providerLane.provider, optimizationLevel: providerLane.optimizationLevel } : {}), ...(schedulingMode ? { schedulingMode } : {}),
    ...(probeSchedulingMode ? { probeConfiguration: { schedulingMode: probeSchedulingMode,
      schedulingModeSemantics: 'Metadata only; Early-visible does not enable scroll scheduler settings.' } } : {}),
    ordinal, globalRunOrder, phase, status: 'running',
    timestamps: { trialStart: now() },
    contexts: [], workerReadiness: [], contentReadiness: [], commands: [], lifecycle: [],
    console: [], exceptions: [], requests: [], rawDOM: {}, cleanupErrors: [],
    fixture: {
      scenario: fixtureConfig.scenario,
      targetCount: fixtureConfig.targetCount,
      targets: fixtureConfig.targets,
      targetTexts: fixtureConfig.targetTexts,
      dynamicCohorts: fixtureConfig.dynamicCohorts ?? [],
      shadowTargets: fixtureConfig.shadowTargets ?? [],
      visibleIds: fixtureConfig.visibleIds,
      viewport: fixtureConfig.viewport,
      scroll: fixtureConfig.scroll,
      responseDelayMs: fixtureConfig.responseDelayMs,
      scrollBands: fixtureConfig.scrollBands ?? [],
    },
    settings: trialSettings,
  };
  if (soakScenario) trial.soak = { scenario: phase, resourceSnapshot: null, instrumentationRetention: null };
  if (browserLifetime) {
    browserLifetime.evidence ??= { idleRequests: [], runs: 0 };
    if (browserLifetime.activeTrial) throw new Error('Cannot start a browser-lifetime trial before the previous trial has drained.');
    browserLifetime.evidence.runs += 1;
  }
  let chrome = browserLifetime?.chrome;
  let fixture;
  let workerSession = browserLifetime?.workerSession;
  let pageSession;
  let contentContext;
  const measurementState = { attempted: false, started: false, stopped: false, stopAttempts: 0 };
  const networkSessions = browserLifetime?.networkSessions ?? createNetworkSessionState();
  if (browserLifetime) browserLifetime.networkSessions = networkSessions;
  const guardSessions = networkSessions.guardedSessions;
  const requestGuardSessions = () => browserLifetime
    ? new Set([...guardSessions].filter(sessionId => sessionId !== browserLifetime.workerSession))
    : guardSessions;
  const sendBySession = networkSessions.sendBySession;
  const extensionOriginBySession = networkSessions.extensionOriginBySession;
  let requestUnsubscribe;
  let eventUnsubscribe;
  let pageEventUnsubscribe;
  const networkEventUnsubscribes = networkSessions.subscriptionsBySession;
  const providerNetworkEvents = new Map();
  const providerPhysicalAttempts = [];
  const resilienceEvidence = resilienceProbe ? {
    ...createGoogleV2_503Evidence(),
    ...createGeminiStructuredRecoveryEvidence(),
    injected429: [],
  } : null;
  if (resilienceEvidence) trial.resilience = resilienceEvidence;
  const googleTimeoutProtocol = resilienceProbe === 'googlev2-timeout' ? createGoogleV2TimeoutProtocol() : null;
  const custom429Protocol = resilienceProbe === 'custom-429' ? createCustom429Protocol() : null;
  const custom400Protocol = resilienceProbe === 'custom-400' ? createCustom400Protocol() : null;
  const customCancellationProtocol = resilienceProbe === 'custom-cancellation' ? createCustomCancellationProtocol() : null;
  const { release: releaseCustomPaused, failHeld: failCustomHeldFetches } = createCustomFetchSettlement({
    protocol: custom429Protocol, sendBySession, now,
  });
  let providerAttemptSequence = 0;
  const providerNetworkObserver = createProviderNetworkObserver({
    providerNetworkEvents,
    endpoints: [
      { origin: 'https://edge.microsoft.com', pathname: '/translate/translatetext' },
      GOOGLE_V2_ENDPOINT,
      CUSTOM_FIXTURE_ENDPOINT,
      { origin: 'https://benchmark-gemini.invalid', pathname: '/v1beta/models/benchmark-gemini-model:generateContent' },
    ],
  });
  const handlerJobTracker = createHandlerJobTracker();
  const requestHandlerJobs = handlerJobTracker.jobs;
  const requestLifecycle = createNetworkRequestLifecycle({ now, sendBySession });
  let staleContextDisposed = false;
  const cancellationControl = cancellationProbe || staleSuccessProbe ? {
    probe: cancellationProbe ?? 'stale-success',
    requestCountsBySession: new Map(),
    firstBatchBySession: new Map(),
    sessionIds: new Set(),
    initialSessionId: null,
    releaseAllA: false,
    replacementSessionId: null,
    releaseReplacement: false,
    heldRequests: [],
    requestLifecycle,
  } : null;
  if (cancellationProbe) trial.cancellation = {
    probe: cancellationProbe,
    commands: [],
    pausedRequests: [],
    networkEvents: [],
    barriers: [],
    domSnapshots: {},
    lifecycleProof: [],
    acceptedWriteProof: [],
    rootPromiseSettlements: [],
    observationErrors: [],
    cancellationClassification: null,
    cleanup: { heldFetches: [] },
  };
  if (staleSuccessProbe) trial.staleSuccess = {
    probe: staleSuccessProbe, commands: [], barriers: [], domSnapshots: {},
    replyGate: null, ownershipProof: null, observationErrors: [], cleanup: { heldFetches: [] },
  };
  const networkEventRouter = cancellationProbe || staleSuccessProbe
    ? createWorkerNetworkEventRouter(event => {
      const evidence = trial.cancellation ?? trial.staleSuccess;
      evidence.networkEvents ??= [];
      evidence.networkEvents.push({ sequence: evidence.networkEvents.length + 1, ...event });
    }) : null;

  const processRequestPaused = async (event, requestRecord, reservation, admissionError) => {
    const { request, requestId } = event.params;
    const networkTarget = networkEventRouter?.targetForSession(event.sessionId) ?? null;
    requestRecord.targetSessionId = event.sessionId;
    requestRecord.targetId = networkTarget?.targetId ?? null;
    const classification = classifyPausedRequest(request, {
      fixtureOrigin: new URL(trial.fixture.url).origin,
      extensionOrigin: extensionOriginBySession.get(event.sessionId),
      selectedProvider: providerLane?.provider,
    });
    const send = sendBySession.get(event.sessionId);
    const captureRequestViewport = async sources => {
      if (fixtureConfig.scenario !== 'scroll-through' || !pageSession || !contentContext) return;
      if (requestRecord.requestViewport) return;
      requestRecord.requestViewport = await evaluate(chrome, pageSession,
        `(()=>{const sources=${JSON.stringify(sources)};return {at:performance.now(),scrollY,targets:sources.map(source=>{const el=[...document.querySelectorAll('[data-bench-id]')].find(node=>node.textContent===source);if(!el)return {source,id:null,classification:'unmapped'};const r=el.getBoundingClientRect();const visible=r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;const buffered=r.bottom>-50&&r.top<innerHeight+50&&r.right>-50&&r.left<innerWidth+50;return {source,id:el.dataset.benchId,classification:visible?'viewport':buffered?'permitted-50px-buffer':'outside-buffer'}})}})()`, contentContext, false);
      };
      requestRecord.category = classification.kind;
      try {
        if (admissionError !== undefined) throw admissionError;
        if (classification.kind === 'provider-translation') {
          if (providerLane && classification.provider && classification.provider !== providerLane.provider) {
            throw new Error(`Unexpected provider endpoint for selected ${providerLane.provider} lane.`);
          }
          if (providerLane?.provider === 'googlev2' && !classification.provider) throw new Error('Unexpected non-Google endpoint for selected Google V2 lane.');
          if (providerLane?.provider === 'custom' && classification.provider !== 'custom') throw new Error('Unexpected non-Custom endpoint for selected Custom lane.');
          if (providerLane?.provider === 'gemini' && classification.provider !== 'gemini') throw new Error('Unexpected non-Gemini endpoint for selected Gemini lane.');
        if (providerLane) {
          const networkId = event.params.networkId;
          requestRecord.networkId = networkId ?? null;
          const network = networkId ? providerNetworkEvents.get(`${event.sessionId}:${networkId}`) : null;
          const attempt = {
            attemptId: `provider-http-${++providerAttemptSequence}`,
            networkId: networkId ?? null,
            networkSessionId: event.sessionId,
            startedAt: network?.startedAt ?? null,
            settledAt: null, outcome: null, status: null,
          };
          requestRecord.physicalAttemptId = attempt.attemptId;
          providerPhysicalAttempts.push(attempt);
          requestRecord.physicalAttempt = attempt;
        }
          const decodedProvider = decodeProviderRequest(classification.provider, request, fixtureConfig.targetTexts);
          let body = decodedProvider.texts;
          let responseBody = decodedProvider.responseBody;
          if (classification.provider === 'googlev2') {
            requestRecord.sourceLanguageQuery = decodedProvider.sourceLanguage;
            requestRecord.batchTexts = body;
          } else if (classification.provider === 'custom') {
            requestRecord.batchIds = decodedProvider.ids;
            requestRecord.batchTexts = body;
          if (custom400Protocol?.armed) {
            if (await executeCustom400({
              protocol: custom400Protocol, event, requestId, requestRecord, classification, texts: decodedProvider.texts,
              fixtureConfig, sessionId: trial.sessionId, sendBySession, providerNetworkEvents, chrome, workerSession, pageSession, contentContext,
              evaluate, now, sameProviderTexts,
            })) return;
          }
          if (customCancellationProtocol && await executeCustomCancellation({
            protocol: customCancellationProtocol, event, requestId, requestRecord, body, fixtureConfig,
            sessionId: trial.sessionId, providerNetworkEvents, chrome, workerSession, pageSession, contentContext,
            evaluate, until, now, reservation, sameProviderTexts,
          })) return;
          } else if (classification.provider === 'gemini') {
            requestRecord.batchIds = decodedProvider.ids;
            requestRecord.batchTexts = body;
            if (resilienceProbe === 'gemini-structured-recovery') {
            responseBody = await executeGeminiStructuredRecovery({
              event, request, requestRecord, classification, body, fixtureConfig, sessionId: trial.sessionId,
              evidence: resilienceEvidence, chrome, workerSession, evaluate, mapMalformedGeminiResponse,
            }) ?? responseBody;
          }
          }
        requestRecord.bodyLength = request.postData?.length ?? 0;
        requestRecord.bodyBytes = Buffer.byteLength(request.postData ?? '', 'utf8');
        requestRecord.batchSize = body.length;
        requestRecord.batchTexts ??= body;
        requestRecord.fixtureDelayMs = fixtureConfig.responseDelayMs;
        if (resilienceProbe === 'googlev2-503' && classification.provider === 'googlev2') {
          if (await executeGoogleV2_503({
            event, requestId, classification, requestRecord, body, fixtureConfig, sessionId: trial.sessionId,
            evidence: resilienceEvidence, providerNetworkEvents, chrome, workerSession, evaluate, now, sendBySession, sameProviderTexts,
          })) return;
        }
        if (googleTimeoutProtocol && classification.provider === 'googlev2') {
          if (await executeGoogleV2Timeout({ googleTimeoutProtocol, classification, event, requestRecord, requestId, body, fixtureConfig, sessionId: trial.sessionId, providerNetworkEvents, resilienceEvidence, chrome, workerSession, pageSession, contentContext, evaluate, captureRequestViewport, until, now, reservation, classifyHeldFetchRelease, sameProviderTexts })) return;
        }
        if (custom429Protocol && classification.provider === 'custom') {
          if (await executeCustom429Request({ custom429Protocol, classification, event, requestRecord, body, responseBody, fixtureConfig, pageSession, contentContext, evaluate, chrome, workerSession, sessionId: trial.sessionId, providerNetworkEvents, now, until, sameProviderTexts, resilienceEvidence, releaseCustomPaused })) return;
        }
        await captureRequestViewport(body);
        if (cancellationProbe || staleSuccessProbe) {
          const workerState = await evaluate(chrome, event.sessionId,
            'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
          const customRootSelection = providerLane?.provider === 'custom'
            ? selectCustomProviderRoot({
              roots: workerState?.providerRoots,
              wireIds: requestRecord.batchIds,
              texts: requestRecord.batchTexts,
            })
            : null;
          const matchingRoots = providerLane?.provider === 'custom'
            ? customRootSelection.matches
            : workerState?.providerRoots?.filter(candidate => sameProviderTexts(candidate.texts, body)) ?? [];
          const activeRoots = matchingRoots.filter(candidate => candidate.status === 'pending' && candidate.controllerAborted === false);
          const roots = customRootSelection ? customRootSelection.matches : activeRoots.length ? activeRoots : matchingRoots;
          const root = customRootSelection?.root ?? (roots.length === 1 ? roots[0] : null);
          if (staleSuccessProbe && !root) throw new Error(`Cannot map provider response to exactly one real Page root (matches=${roots.length}).`);
          const customPhysical = providerLane?.provider === 'custom' && root
            ? selectCustomPhysicalOperation({
              operations: workerState?.ledger?.operations,
              sessionId: root.sessionId, messageId: root.messageId,
              wireIds: requestRecord.batchIds, texts: requestRecord.batchTexts,
            }) : null;
          if (staleSuccessProbe && customPhysical && !customPhysical.ok) {
            throw new Error(`Custom physical operation correlation failed: ${customPhysical.issues.join('; ')}`);
          }
          const physical = workerState?.ledger?.operations?.filter(operation => operation.kind === 'provider.physical'
            && (providerLane?.provider === 'custom'
              ? operation.sessionId === root?.sessionId && operation.messageId === root?.messageId
              : sameProviderTexts(JSON.parse(operation.requestBody ?? 'null'), body))) ?? [];
          const physicalCall = customPhysical?.operation ?? (root && physical.find(operation => operation.messageId === root.messageId && operation.sessionId === root.sessionId));
          const controllerMatches = root ? workerState.controllers?.filter(candidate => candidate.messageId === root.messageId
            && candidate.sessionId === root.sessionId) ?? [] : [];
          const controller = controllerMatches.length === 1 ? controllerMatches[0] : null;
          const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id
            ?? (fixtureConfig.spaSources?.includes(text) ? `target-${fixtureConfig.spaSources.indexOf(text)}` : null));
          requestRecord.networkId = event.params.networkId ?? null;
          if (staleSuccessProbe && (!physicalCall || physical.filter(operation => operation.messageId === root.messageId
            && operation.sessionId === root.sessionId).length !== 1 || !controller || targetIds.some(id => id === null)
              || !requestId || !requestRecord.networkId || !requestRecord.targetSessionId || !requestRecord.targetId)) {
            throw new Error('Cannot fulfill provider response without exact body/root/physical/controller fixture correlation.');
          }
          requestRecord.cancellationCorrelation = root && physicalCall && controller ? {
            pageSessionId: root.sessionId,
            batchMessageId: root.messageId,
            providerRootStatus: root.status,
            physicalOperationStatus: physicalCall.status,
            controllerAborted: controller.aborted,
            targetIds,
            requestId,
            networkId: requestRecord.networkId,
            targetSessionId: requestRecord.targetSessionId,
            targetId: requestRecord.targetId,
            physicalOperationSessionId: physicalCall.sessionId,
            physicalOperationMessageId: physicalCall.messageId,
            customWireIds: providerLane?.provider === 'custom' ? [...requestRecord.batchIds] : null,
          } : null;
          if (staleSuccessProbe) {
            if (!pageSession || !contentContext) throw new Error('Cannot prove Page scheduler owner before fulfilling provider response.');
            const ownerEvidence = await evaluate(chrome, pageSession,
              `(()=>({scheduler:window.__pageTranslationBenchmark.pageSessionSnapshot(),content:window.__pageTranslationBenchmark.cancellationSnapshot()}))()`, contentContext, false);
            const acceptedStart = ownerEvidence.content?.operations?.find(operation => operation.kind === 'lifecycle.delivery'
              && operation.sessionId === root.sessionId && operation.action === 'page-translate-start' && operation.accepted === true);
            const invalidatedA = cancellationControl.initialSessionId !== null
              && ownerEvidence.content?.operations?.some(operation => operation.kind === 'session.invalidation'
                && operation.sessionId === cancellationControl.initialSessionId && operation.capturedSessionActive === false
                && operation.discoveryCancelled === true) === true;
            const ownerDecision = classifyStaleSuccessProviderOwner({
              sessionId: root.sessionId,
              initialSessionId: cancellationControl.initialSessionId,
              replacementSessionId: cancellationControl.replacementSessionId,
              trustedStartAccepted: acceptedStart !== undefined,
              currentOwnerSessionId: ownerEvidence.scheduler?.translationSessionId ?? null,
              currentOwnerContextOwned: ownerEvidence.scheduler?.sessionContextOwned === true,
              initialSessionInvalidated: invalidatedA,
            });
            requestRecord.providerOwnerEvidence = {
              pageSessionId: root.sessionId,
              batchMessageId: root.messageId,
              providerRootStatus: root.status,
              controllerAborted: controller.aborted,
              trustedStartAccepted: acceptedStart !== undefined,
              currentSchedulerSessionId: ownerEvidence.scheduler?.translationSessionId ?? null,
              currentSchedulerContextOwned: ownerEvidence.scheduler?.sessionContextOwned === true,
              aInvalidationObserved: invalidatedA,
              decision: ownerDecision,
            };
            if (!ownerDecision.ok) {
              (trial.cancellation ?? trial.staleSuccess).observationErrors.push({ requestId, issues: [ownerDecision.reason] });
              throw new Error(`Unrecognized provider owner ${root.sessionId}: ${ownerDecision.reason}`);
            }
            if (ownerDecision.lockInitialSessionId) cancellationControl.initialSessionId = ownerDecision.lockInitialSessionId;
            if (ownerDecision.lockReplacementSessionId) cancellationControl.replacementSessionId = ownerDecision.lockReplacementSessionId;
            if (ownerDecision.role === 'cancelled-A-sibling') {
              requestRecord.lateCancelledA = true;
              let abortedEvidence = { aborted: controller.aborted, rootSessionId: root.sessionId, messageId: root.messageId };
              if (!controller.aborted) {
                abortedEvidence = await until(async () => {
                  const current = await evaluate(chrome, event.sessionId,
                    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
                  const currentController = current?.controllers?.find(item => item.messageId === root.messageId
                    && item.sessionId === root.sessionId);
                  return currentController?.aborted === true
                    ? { aborted: true, rootSessionId: root.sessionId, messageId: root.messageId } : null;
                }, 5_000);
              }
              requestRecord.lateCancelledAController = abortedEvidence;
              if (!abortedEvidence?.aborted) throw new Error(`Late A provider request is not yet controller-aborted: ${root.messageId}`);
              const cancellation = reservation
                ? await reservation.release('fail', {
                  errorReason: 'Aborted', reason: 'A session invalidated before this sibling Fetch fulfilled',
                  response: { failed: true, reason: 'late-A-session-cancelled' },
                })
                : await failPausedFetch({ send, sessionId: event.sessionId, requestId, errorReason: 'Aborted', requestRecord, now,
                  response: { reason: 'late-A-session-cancelled' } });
              requestRecord.lateCancelledARelease = cancellation;
              return;
            }
            responseBody = providerLane?.provider === 'custom'
              ? mapCustomStaleSuccessResponse(requestRecord, root.sessionId === cancellationControl.initialSessionId ? 'A' : 'B')
              : mapStaleSuccessResponse(body, root.sessionId, cancellationControl.initialSessionId, cancellationControl.replacementSessionId);
          }
          const issues = [];
          if (roots.length !== 1) issues.push(`provider root match count ${roots.length}`);
          if (!physicalCall) issues.push('physical provider operation not correlated to request body/controller');
          if (!controller) issues.push('lifecycle controller not correlated to provider root');
          if (targetIds.some(id => id === null)) issues.push('provider request body includes unknown fixture source');
          requestRecord.cancellationCorrelationIssues = issues;
          if (issues.length) (trial.cancellation ?? trial.staleSuccess).observationErrors.push({ requestId, issues });

          if (root && cancellationControl) {
            const sessionId = root.sessionId;
            const ordinal = cancellationControl.requestCountsBySession.get(sessionId) ?? 0;
            cancellationControl.requestCountsBySession.set(sessionId, ordinal + 1);
            const firstBatch = cancellationControl.firstBatchBySession.get(sessionId);
            if (ordinal === 0) cancellationControl.firstBatchBySession.set(sessionId, { messageId: root.messageId, targetIds, texts: body });
            const isInitialSession = sessionId === cancellationControl.initialSessionId
              || (!cancellationControl.initialSessionId && !cancellationControl.replacementSessionId);
            const selectedMessageId = staleSuccessProbe === 'custom-stale-success' && isInitialSession
              ? (await evaluate(chrome, pageSession,
                'window.__pageTranslationBenchmark.successfulReplySnapshot()?.selectedBatch?.messageId', contentContext, false))
              : null;
            const staleASibling = staleSuccessProbe === 'custom-stale-success' && isInitialSession
              && typeof selectedMessageId === 'string' && root.messageId !== selectedMessageId;
            const shouldHold = cancellationControl.probe === 'stale-success'
              ? staleASibling || sessionId === cancellationControl.replacementSessionId && !cancellationControl.releaseReplacement
              : isInitialSession
                ? ordinal > 0 && !cancellationControl.releaseAllA
                : cancellationControl.probe === 'replacement' && sessionId !== cancellationControl.initialSessionId
                && ordinal === 0 && !cancellationControl.releaseReplacement;
            if (shouldHold && (!firstBatch || targetIds.some(id => !firstBatch.targetIds.includes(id)))
                && reservation?.hold()) {
              if (!reservation) throw new Error('Cancellation Fetch reservation was not created at request-handler entry.');
              const held = {
                requestId, networkId: requestRecord.networkId, sessionId: event.sessionId, targetId: requestRecord.targetId,
                pageSessionId: sessionId, batchMessageId: root.messageId, targetIds,
                providerRootStatusAtPause: root.status, controllerAbortedAtPause: controller?.aborted ?? null,
                ...(staleASibling ? { role: 'stale-A-sibling' } : {}),
                released: false, handlerSettled: false,
              };
              const heldControl = { ...held, reservation, record: held };
              requestRecord.paused = true;
              requestRecord.heldFetch = held;
              cancellationControl.heldRequests.push(heldControl);
              (trial.cancellation ?? trial.staleSuccess).pausedRequests ??= [];
              (trial.cancellation ?? trial.staleSuccess).pausedRequests.push(held);
              const releaseRequest = await reservation.waitForRelease();
              held.released = true;
              held.releaseAction = releaseRequest.action;
              if (held.releaseAction === 'fail') {
                held.releaseOutcome = await reservation.release('fail', releaseRequest.detail);
              } else {
                held.releaseOutcome = await reservation.release('fulfill', {
                  body: responseBody,
                  responseCode: 200,
                  responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                });
                if (held.releaseOutcome?.ok !== true) requestRecord.releaseError = held.releaseOutcome;
              }
              held.releaseCompletedAt = now();
            } else {
              await wait(fixtureConfig.responseDelayMs);
              if (reservation) await reservation.release('fulfill', { body: responseBody, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
              else {
                await fulfillPausedFetch({ send, sessionId: event.sessionId, requestId, status: 200, body: responseBody, requestRecord, now });
              }
            }
          } else {
            await wait(fixtureConfig.responseDelayMs);
            if (reservation) await reservation.release('fulfill', { body: responseBody, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
            else {
              await fulfillPausedFetch({ send, sessionId: event.sessionId, requestId, status: 200, body: responseBody, requestRecord, now });
            }
          }
        } else {
          await wait(fixtureConfig.responseDelayMs);
        if (reservation) await reservation.release('fulfill', {
          body: responseBody, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        });
        else await fulfillPausedFetch({ send, sessionId: event.sessionId, requestId, status: 200, body: responseBody, requestRecord, now });
        }
      } else if (classification.kind === 'startup-metadata-fixture') {
        if (reservation) await reservation.release('fulfill', { body: startupVoicesResponse, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
        else {
          await fulfillPausedFetch({ send, sessionId: event.sessionId, requestId, status: 200, body: startupVoicesResponse, requestRecord, now });
        }
      } else if (classification.kind === 'local') {
        if (reservation) await reservation.release('continue');
        else {
          await continuePausedFetch({ send, sessionId: event.sessionId, requestId, requestRecord, now });
        }
      } else if (classification.kind === 'invalid-extension-placeholder') {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        trial.nonHttpBlockedRequests ??= [];
        trial.nonHttpBlockedRequests.push(requestRecord);
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient' });
        else await failPausedFetch({ send, sessionId: event.sessionId, requestId, errorReason: 'BlockedByClient', requestRecord, now });
      } else {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient' });
        else await failPausedFetch({ send, sessionId: event.sessionId, requestId, errorReason: 'BlockedByClient', requestRecord, now });
      }
    } catch (error) {
      if (custom429Protocol && requestRecord.custom429Role) {
        custom429Protocol.error = error;
        custom429Protocol.evidence.events.push({ type: 'protocol-error', role: requestRecord.custom429Role, at: now(), message: error.message });
        await failCustomHeldFetches('custom-429-protocol-error');
        if (custom429Protocol.releaseStates.has(requestRecord.custom429Role)) {
          requestRecord.response ??= { failed: true, reason: 'custom-429-protocol-error', endedAt: now() };
        }
      }
      if (customCancellationProtocol && requestRecord.customCancellationHeld) {
        customCancellationProtocol.error = error;
        customCancellationProtocol.evidence.handlerError = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
      }
      requestRecord.blocked = true;
      requestRecord.error ??= error.message;
      trial.transportErrors ??= [];
      trial.transportErrors.push(error.message);
      if (!requestRecord.response) {
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient', reason: 'request-handler-error' });
        else await failPausedFetch({ send, sessionId: event.sessionId, requestId, errorReason: 'BlockedByClient', requestRecord, now }).catch(() => {});
      }
    } finally {
      if (resilienceProbe && requestRecord.resilienceCorrelation && requestRecord.response?.status === 200) {
        const attempt = resilienceEvidence.attempts.find(item => item.attemptId === requestRecord.resilienceCorrelation.attemptId);
        if (attempt) attempt.status = 200;
      }
      requestRecord.endedAt = now();
      if (requestRecord.heldFetch) requestRecord.heldFetch.handlerSettled = true;
      if (reservation && !reservation.releaseRequested) {
        requestRecord.unreleasedFetch = true;
      }
    }
  };

  const requestListener = createFetchRequestListener({
    guardSessions, now, requests: trial.requests,
    onRequest: (event, request, requestRecord) => {
      if (!custom429Protocol) return;
      claimCustom429Request({
        protocol: custom429Protocol, event, request, requestRecord, now, providerNetworkEvents, fixtureConfig,
        classify: (candidate, sessionId) => classifyPausedRequest(candidate, {
          fixtureOrigin: new URL(trial.fixture.url).origin,
          extensionOrigin: extensionOriginBySession.get(sessionId), selectedProvider: 'custom',
        }),
      });
    },
    reserveRequest: (event, requestRecord, requestId) => {
      const handlerLifecycle = cancellationControl?.requestLifecycle
        ?? (customCancellationProtocol ? requestLifecycle : null)
        ?? (googleTimeoutProtocol ? requestLifecycle : null);
      return handlerLifecycle?.reserve({
        requestId, sessionId: event.sessionId, networkId: event.params.networkId ?? null, requestRecord,
      }) ?? null;
    },
    onAdmission: (event, request, requestRecord, reservation, requestId) => {
      if (!customCancellationProtocol?.armed || !reservation) return;
      const classification = classifyPausedRequest(request, {
        fixtureOrigin: new URL(trial.fixture.url).origin,
        extensionOrigin: extensionOriginBySession.get(event.sessionId), selectedProvider: 'custom',
      });
      if (classification.kind !== 'provider-translation' || classification.provider !== 'custom') return;
      const decoded = decodeProviderRequest('custom', request, fixtureConfig.targetTexts);
      requestRecord.batchTexts = decoded.texts;
      requestRecord.batchIds = decoded.ids;
      admitCustomCancellationRequest({
        protocol: customCancellationProtocol, event, requestRecord, requestId, reservation,
        body: decoded.texts, now,
      });
    },
    handlePaused: processRequestPaused,
    trackHandler: (reservation, job) => {
      const lifecycle = cancellationControl?.requestLifecycle
        ?? (customCancellationProtocol ? requestLifecycle : null)
        ?? (googleTimeoutProtocol ? requestLifecycle : null) ?? requestLifecycle;
      return handlerJobTracker.track(lifecycle, reservation, job, error => {
        trial.transportErrors ??= [];
        trial.transportErrors.push(error?.message ?? String(error));
      });
    },
  });

  try {
    fixture = await startFixture(fixtureConfig);
    trial.fixture.url = fixture.url;
    trial.stage = 'chrome-launch';
      if (browserLifetime) {
        browserLifetime.activeTrial = trial;
        browserLifetime.requestListener = requestListener;
        browserLifetime.activeNetworkObserver = providerNetworkObserver;
        browserLifetime.activeNetworkRouter = networkEventRouter;
    }
    if (browserLifetime?.chrome) chrome = browserLifetime.chrome;
    if (!chrome) chrome = await launchChrome({
      extensionPath,
      onAttachedTarget: async ({ targetInfo, sessionId, send, onEvent }) => {
        if (targetInfo.type !== 'service_worker' || !targetInfo.url.startsWith('chrome-extension://')) return;
        const workerUrl = new URL(targetInfo.url);
        const extensionOrigin = workerUrl.protocol === 'chrome-extension:' ? `chrome-extension://${workerUrl.host}` : null;
        registerGuardedSession(networkSessions, sessionId, send, extensionOrigin);
        if (browserLifetime) browserLifetime.workerSession = sessionId;
        if (!eventUnsubscribe && (!browserLifetime || !browserLifetime.eventUnsubscribe)) {
          const unsubscribe = onEvent(event => {
            const active = browserLifetime ? browserLifetime.activeTrial : trial;
            if (active) recordEvent(event, active);
          });
          if (browserLifetime) browserLifetime.eventUnsubscribe = unsubscribe;
          else eventUnsubscribe = unsubscribe;
        }
        if (!requestUnsubscribe && (!browserLifetime || !browserLifetime.requestUnsubscribe)) {
          const unsubscribe = onEvent(event => {
            const activeListener = browserLifetime ? browserLifetime.requestListener : requestListener;
            if (activeListener) return activeListener(event);
            if (event.method === 'Fetch.requestPaused') {
              browserLifetime.evidence.idleRequests.push({ at: now(), sessionId: event.sessionId, url: event.params?.request?.url ?? null });
              return send('Fetch.failRequest', { requestId: event.params.requestId, errorReason: 'BlockedByClient' }, event.sessionId);
            }
          });
          if (browserLifetime) browserLifetime.requestUnsubscribe = unsubscribe;
          else requestUnsubscribe = unsubscribe;
        }
        if (cancellationProbe || staleSuccessProbe) {
          if (!networkEventRouter?.register(sessionId, targetInfo)) throw new Error(`Could not register Network observer target for CDP session ${sessionId}.`);
          trial.networkObserverTargets ??= {};
          trial.networkObserverTargets[sessionId] = networkEventRouter.targetForSession(sessionId);
        }
        if (browserLifetime && providerLane) {
          const routeNetworkEvent = event => {
            if (event.sessionId !== sessionId) return;
            if (browserLifetime.activeNetworkObserver) browserLifetime.activeNetworkObserver(event);
            if (browserLifetime.activeNetworkRouter) browserLifetime.activeNetworkRouter.observerForSession(sessionId)(event);
          };
          browserLifetime.workerNetworkUnsubscribes ??= new Map();
          if (!browserLifetime.workerNetworkUnsubscribes.has(sessionId)) {
            browserLifetime.workerNetworkUnsubscribes.set(sessionId, onEvent(routeNetworkEvent));
          }
          browserLifetime.workerTargetInfo = targetInfo;
          browserLifetime.workerNetworkEnabled = enableProviderNetworkObservation(send, sessionId);
          await browserLifetime.workerNetworkEnabled;
        } else if ((providerLane || cancellationProbe || staleSuccessProbe) && !browserLifetime
            && !networkEventUnsubscribes.has(sessionId)) {
          const routeNetworkEvent = event => {
            if (providerLane) providerNetworkObserver(event);
            if (cancellationProbe || staleSuccessProbe) networkEventRouter.observerForSession(sessionId)(event);
          };
          networkEventUnsubscribes.set(sessionId, onEvent(routeNetworkEvent));
          await enableProviderNetworkObservation(send, sessionId);
        }
        await enableFetchGuard(send, sessionId);
        trial.workerTargets ??= [];
        trial.workerTargets.push(targetInfo);
      },
    });
    if (!browserLifetime?.chrome) {
      if (browserLifetime) {
        browserLifetime.chrome = chrome;
      }
    }
    trial.browser = chrome.metadata;
    const testExtensionOrigin = `chrome-extension://${chrome.extensionId}`;
    workerSession = browserLifetime?.workerSession
      ?? [...extensionOriginBySession.entries()].find(([, origin]) => origin === testExtensionOrigin)?.[0];
    workerSession ??= browserLifetime?.workerSession;
    if (!workerSession) throw new Error('No pre-guarded test-extension service-worker session was recorded.');
    if (browserLifetime && !browserLifetime.workerSession) browserLifetime.workerSession = workerSession;
    if (browserLifetime) {
      registerGuardedSession(networkSessions, workerSession, chrome.send, testExtensionOrigin);
      if (providerLane) {
        networkEventRouter?.register(workerSession, browserLifetime.workerTargetInfo);
        if (!browserLifetime.workerNetworkUnsubscribes?.has(workerSession)) throw new Error('Shared worker Network observer was not retained.');
      }
    }
    await until(async () => (await chrome.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.includes(chrome.extensionId)));
    await chrome.send('Runtime.enable', {}, workerSession);
    trial.stage = 'worker-readiness';
    await until(async () => {
      const state = await evaluate(chrome, workerSession,
        `(()=>{const api=globalThis.browser??globalThis.chrome,trace=globalThis.__pageTranslationBenchmark;const b=globalThis.backgroundService,u=trace?.unifiedTranslationService;return Promise.resolve(api?.permissions?.getAll?.()??{permissions:[]}).then(p=>({initialized:!!b?.initialized,listener:!!b?.messageHandler?.isListenerActive,engine:!!b?._translationEngineInitialized&&!!b.translationEngine,unified:!!u&&u.translationEngine===b?.translationEngine&&u.backgroundService===b,traceReady:typeof trace?.snapshot==='function',permissions:p.permissions}))})()`);
      const previous = trial.workerReadiness.at(-1)?.state;
      if (JSON.stringify(previous) !== JSON.stringify(state)) trial.workerReadiness.push({ at: now(), state });
      return state.initialized && state.listener && state.engine && state.unified && state.traceReady;
    });
    const settingWrite = providerLane
      ? `globalThis.__pageTranslationBenchmark.applyBenchmarkSettings(${JSON.stringify(trialSettings)})`
      : `browser.storage.local.set(${JSON.stringify(trialSettings)})`;
    await evaluate(chrome, workerSession,
      `Promise.all([${settingWrite},browser.storage.sync.set(${JSON.stringify(trialSettings)}).catch(()=>{})])`);
    if (cancellationProbe || staleSuccessProbe || resilienceProbe || soakScenario) {
       const workerInstrumentation = await evaluate(chrome, workerSession,
        'globalThis.__pageTranslationBenchmark.enableCancellationProbe()');
      if (trial.cancellation || trial.staleSuccess) (trial.cancellation ?? trial.staleSuccess).workerInstrumentation = workerInstrumentation;
       else if (googleTimeoutProtocol || customCancellationProtocol) trial.resilience.workerInstrumentation = workerInstrumentation;
       else if (soakScenario) trial.soak.workerInstrumentation = workerInstrumentation;
      if (!workerInstrumentation?.enabled || !workerInstrumentation?.lifecycleRegistryObserved
          || workerInstrumentation.instrumentationErrors?.length) throw new Error('Worker cancellation/provider/controller instrumentation was not fully installed.');
    }
    if (shouldEnableResilienceQueueProbe(resilienceProbe)) {
      trial.resilienceQueueInstrumentation = await evaluate(chrome, workerSession,
        'globalThis.__pageTranslationBenchmark.enableResilienceQueueProbe()');
      if (!trial.resilienceQueueInstrumentation?.enabled) throw new Error('Resilience-only QueueManager attempt instrumentation was not installed.');
    }
    if (resilienceProbe === 'gemini-structured-recovery') {
      trial.geminiStructuredRecoveryInstrumentation = await evaluate(chrome, workerSession,
        'globalThis.__pageTranslationBenchmark.enableGeminiStructuredRecoveryProbe()');
      if (!trial.geminiStructuredRecoveryInstrumentation?.enabled) throw new Error('Gemini structured-recovery instrumentation was not installed.');
    }

    const targetId = browserLifetime?.pageTargetId ?? (await chrome.send('Target.createTarget', { url: 'about:blank' })).targetId;
    if (browserLifetime && !browserLifetime.pageTargetId) browserLifetime.pageTargetId = targetId;
    ({ sessionId: pageSession } = await chrome.send('Target.attachToTarget', { targetId, flatten: true }));
    if (browserLifetime?.persistentGuardSessions) guardSessions.add(pageSession);
    pageEventUnsubscribe = chrome.onEvent(event => recordEvent(event, trial));
    if (providerLane) {
      networkEventUnsubscribes.set(pageSession, chrome.onEvent(providerNetworkObserver));
      await enableProviderNetworkObservation(chrome.send, pageSession);
    }
    registerGuardedSession(networkSessions, pageSession, chrome.send, testExtensionOrigin);
    if (browserLifetime) {
      browserLifetime.requestListener = requestListener;
      browserLifetime.activeTrial = trial;
    }
    await enableFetchGuard(chrome.send, pageSession);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: fixtureConfig.viewport.width,
      height: fixtureConfig.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, pageSession);
    await chrome.send('Page.enable', {}, pageSession);
    await chrome.send('Page.navigate', { url: fixture.url }, pageSession);
    const contentContextPromise = new Promise((resolveContext, rejectContext) => {
      const timeout = setTimeout(() => rejectContext(new Error('No extension content execution context appeared')), 20_000);
      const off = chrome.onEvent(event => {
        const ctx = event.params?.context;
        if (event.method !== 'Runtime.executionContextCreated' || event.sessionId !== pageSession) return;
        trial.contexts.push({ id: ctx.id, origin: ctx.origin, name: ctx.name, auxData: ctx.auxData });
        if (ctx.origin === `chrome-extension://${chrome.extensionId}`) {
          clearTimeout(timeout);
          off();
          resolveContext(ctx.id);
        }
      });
    });
    await chrome.send('Runtime.enable', {}, pageSession);
    contentContext = await contentContextPromise;
    if (networkGuardProbe) {
      trial.stage = 'negative-network-guard-probe';
      trial.networkGuardProbe = [];
      await runNetworkGuardNegativeProbe({
        requests: trial.requests, chrome, pageSession, contentContext, evaluate, until, now, processId: process.pid,
        probeResults: trial.networkGuardProbe,
      });
      trial.status = 'passed';
      return trial;
    }
    trial.stage = 'content-readiness';
    await until(async () => {
      const state = await evaluate(chrome, pageSession,
        `(()=>{const core=window.translateItContentCore;return {marker:!!window.__pageTranslationBenchmark,initialized:!!core?.initialized,baseInitialized:!!core?.baseInitialized,listener:!!core?.messageHandler?.isListenerActive,features:window.__pageTranslationBenchmark?.featureState?.()}})()`, contentContext);
      trial.contentReadiness.push({ at: now(), state });
      return state.marker && state.initialized && state.baseInitialized && state.listener
        && state.features?.active && state.features?.handlerActive;
    });
    if (cancellationProbe || staleSuccessProbe || googleTimeoutProtocol || customCancellationProtocol || soakScenario) {
      const contentInstrumentation = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.enableCancellationProbe()', contentContext);
      const instrumentationOwner = trial.cancellation ?? trial.staleSuccess ?? trial.resilience ?? trial.soak;
      instrumentationOwner.contentInstrumentation = contentInstrumentation;
      if (!contentInstrumentation?.enabled || !contentInstrumentation?.sendMessageWrapped
          || contentInstrumentation.instrumentationErrors?.length) {
        throw new Error(`Content cancellation instrumentation incomplete: ${JSON.stringify(contentInstrumentation)}`);
      }
    }
    if (staleSuccessProbe) {
      trial.staleSuccess.contentInstrumentation = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.enableSuccessfulReplyProbe(60000)', contentContext);
      if (!trial.staleSuccess.contentInstrumentation?.enabled) throw new Error(`Successful-reply instrumentation incomplete: ${JSON.stringify(trial.staleSuccess.contentInstrumentation)}`);
    }

    trial.discoveryFlagsObserved = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.discoveryFlags', contentContext, false);
    trial.discoveryFlagsValidation = validateDiscoveryFlags(mode, trial.discoveryFlagsObserved);
    if (!trial.discoveryFlagsValidation.ok) throw new Error(trial.discoveryFlagsValidation.issues.join('; '));

    trial.scrollState = await evaluate(chrome, pageSession,
      `(()=>{window.scrollTo(${fixtureConfig.scroll.x},${fixtureConfig.scroll.y});return {x:window.scrollX,y:window.scrollY}})()`, undefined, false);
    let shadowOracle = null;
    if (fixtureConfig.scenario === 'shadow-dom') {
      shadowOracle = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.enableShadowDOMTracking(${JSON.stringify(fixtureConfig.shadowTargets)})`, contentContext);
      if (JSON.stringify(shadowOracle.targetIds) !== JSON.stringify(fixtureConfig.targets.map(target => target.id))) throw new Error('Shadow DOM initial target oracle mismatch.');
    }
    const actualGeometry = fixtureConfig.scenario === 'shadow-dom' ? {
      ...await evaluate(chrome, pageSession,
        `(()=>{const trace=window.__pageTranslationBenchmark;const ids=${JSON.stringify(fixtureConfig.targets.map(target => target.id))};const entries=ids.map(id=>[id,trace.shadowTargetById.get(id)]);const visible=entries.filter(([,el])=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}).map(([id])=>id);return {targetCount:entries.filter(([,el])=>!!el).length,visibleIds:visible,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}}})()`, contentContext, false),
    } : await evaluate(chrome, pageSession,
      `(()=>{const targets=[...document.querySelectorAll('[data-bench-id]')];const visible=targets.filter(element=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth}).map(element=>element.dataset.benchId);return {targetCount:targets.length,visibleIds:visible,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}}})()`, undefined, false);
    trial.actualGeometry = actualGeometry;
    if (fixtureConfig.scenario !== 'shadow-dom') {
      trial.fixtureGeometryValidation = validateFixtureGeometry(fixtureConfig, actualGeometry);
      if (!trial.fixtureGeometryValidation.ok) throw new Error(trial.fixtureGeometryValidation.issues.join('; '));
    }
    let originals = fixtureConfig.targets.map(target => [target.id, target.source]);
    const originalById = new Map(originals);
    if (fixtureConfig.scenario === 'shadow-dom') {
      trial.rawDOM.original = await evaluate(chrome, pageSession,
        `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;return ${JSON.stringify(fixtureConfig.targets.map(target => target.id))}.map(id=>{const el=t.get(id);return [id,el?.dataset.benchKind==='title'?el.getAttribute('title'):el?.textContent]})})()`, contentContext, false);
      trial.fixtureGeometryValidation = validateShadowInitialObservations({ fixture: fixtureConfig, observedTargets: trial.rawDOM.original, observedGeometry: actualGeometry });
      if (!trial.fixtureGeometryValidation.ok) throw new Error(trial.fixtureGeometryValidation.issues.join('; '));
      originals = trial.rawDOM.original;
      originalById.clear();
      for (const [id, source] of originals) originalById.set(id, source);
      trial.shadowDOM = await evaluate(chrome, pageSession,
        `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;const state=el=>{const s=getComputedStyle(el);return {inlineDirection:el.style.direction,inlineUnicodeBidi:el.style.unicodeBidi,computedDirection:s.direction,computedUnicodeBidi:s.unicodeBidi,markers:Object.fromEntries(['data-page-translated','data-has-original','data-dir-original-saved','data-translate-dir'].map(name=>[name,el.getAttribute(name)]))}};return {metadata:[...t].map(([id,el])=>[id,[...el.attributes].map(a=>[a.name,a.value])]),targetStates:[...t].map(([id,el])=>[id,state(el)])}})()`, contentContext);
      Object.assign(trial.shadowDOM, await evaluate(chrome, pageSession,
        `(()=>{const o=window.__shadowBenchmarkOracle;return {directText:[...o.initialRoot.childNodes].some(n=>n.nodeType===3&&n.nodeValue==='SHADOW_DIRECT_TEXT_SENTINEL'),closedText:o.closedSentinel.textContent,closedRootInaccessible:o.closedHost.shadowRoot===null}})()`));
      if (!trial.shadowDOM.directText || trial.shadowDOM.closedText !== 'SHADOW_CLOSED_ROOT_SENTINEL' || !trial.shadowDOM.closedRootInaccessible) throw new Error('Shadow DOM omission sentinels were not intact before translation.');
    } else trial.rawDOM.original = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.dataset.benchKind==='title'?el.getAttribute('title'):el.textContent])`, contentContext);
    if (fixtureConfig.scenario !== 'shadow-dom' && (trial.rawDOM.original.length !== fixtureConfig.targetCount
        || JSON.stringify(trial.rawDOM.original) !== JSON.stringify(originals))) {
      throw new Error(`Pre-translation fixture DOM does not exactly match ${fixtureConfig.targetCount} source targets.`);
    }
    if (soakScenario) {
      trial.soak.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`,
        contentContext, false);
    }
    trial.longTaskCalibration = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.calibrateLongTasks?.()??{supported:false,reason:"trace writer calibration unavailable"}', contentContext);
    await wait(50);
    trial.traceAvailable = await evaluate(chrome, pageSession,
      `typeof window.__pageTranslationBenchmark?.startMeasurement==='function'&&typeof window.__pageTranslationBenchmark?.stopMeasurement==='function'`, contentContext);
    if (!trial.traceAvailable) throw new Error('Measurement trace writer API is not ready; refusing to claim measured trial.');
    await evaluate(chrome, pageSession,
      'window.__benchEvents=[];window.addEventListener("__benchmark-runtime-event",e=>{const receivedAt=Date.now();const performanceAt=performance.now();window.__benchEvents.push({receivedAt,performanceAt,message:e.detail})});', contentContext);
    measurementState.attempted = true;
    if (fixtureConfig.scenario === 'dynamic-dom' || fixtureConfig.scenario === 'shadow-dom') {
      const expectedIds = [...fixtureConfig.targets, ...(fixtureConfig.dynamicCohorts ?? []).flatMap(cohort => cohort.targets)].map(target => target.id);
      if (fixtureConfig.scenario === 'shadow-dom') expectedIds.splice(fixtureConfig.targets.length, 0, ...fixtureConfig.shadowTargets.slice(3).map(target => target.id));
      const configured = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.setExpectedTargetIds(${JSON.stringify(expectedIds)})`, contentContext);
      if (configured !== true) throw new Error('Dynamic expected target inventory could not be configured before measurement.');
    }
    trial.measurementStart = await evaluate(chrome, pageSession,
      `window.__pageTranslationBenchmark.startMeasurement(${JSON.stringify({ scrollThrough: fixtureConfig.scenario === 'scroll-through', shadowDom: fixtureConfig.scenario === 'shadow-dom' })})`, contentContext);
    measurementState.started = true;
    if (fixtureConfig.scenario !== 'shadow-dom' && (trial.measurementStart.targetCount !== fixtureConfig.targetCount
        || JSON.stringify(trial.measurementStart.visibleIds) !== JSON.stringify(actualGeometry.visibleIds))) {
      throw new Error('MutationObserver target/visible-ID snapshot does not match actual viewport geometry.');
    }
    if (fixtureConfig.scenario === 'spa-navigation') {
      trial.spaTrackingStart = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.enableSpaNavigationTracking(${JSON.stringify({ changedIds: fixtureConfig.spaChangedIds, sources: fixtureConfig.spaSources })})`, contentContext);
      if (trial.spaTrackingStart?.identityCount !== fixtureConfig.targetCount) throw new Error('SPA target identity tracking failed to initialize.');
    }
    if (cancellationProbe) {
      trial.cancellation.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
    }
    if (customCancellationProtocol) {
      customCancellationProtocol.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
      customCancellationProtocol.initialIds = [...fixtureConfig.scrollBands[0].ids];
    }
    if (staleSuccessProbe) {
      trial.staleSuccess.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
      await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.armSuccessfulReplyProbe()', contentContext);
    }
    trial.timestamps.translationCommand = now();
    if (fixtureConfig.scenario === 'dynamic-dom' || fixtureConfig.scenario === 'shadow-dom') {
      const enabled = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.enableDynamicDOMTracking()', contentContext);
      if (enabled !== true) throw new Error('Dynamic DOM settlement instrumentation could not be installed.');
    }
    if (providerLane) {
      const enabled = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.enableProviderRuntimeProbe()', contentContext);
      if (enabled !== true) throw new Error('Provider runtime instrumentation could not be installed.');
    }
    const started = await evaluate(chrome, pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify(pageTranslationStartMessage(providerLane?.provider ?? 'edge'))})`, contentContext);
    trial.commands.push({ action: 'page-translate', sentAt: trial.timestamps.translationCommand, respondedAt: now(), response: started });
    if (!started?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE', started));
    const sessionId = sessionIdFromStart(started);
    if (!sessionId) throw new Error('Successful PAGE_TRANSLATE response omitted its session ID.');
    trial.sessionId = sessionId;
    if (fixtureConfig.scenario === 'spa-navigation') {
      await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.spaNavigation.sessionA=${JSON.stringify(sessionId)};window.__pageTranslationBenchmark.spaNavigation.cursorA=window.__pageTranslationBenchmark.spaSnapshot().cursor`, contentContext);
    }
    const managerCall = await until(async () => {
      const state = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.calls.at(-1)??null', contentContext, false);
      return state;
    });
    trial.effectiveSettingsObserved = managerCall.settings;
    trial.effectiveSettingsValidation = validateEffectiveSettings(managerCall.settings, {
      targetLanguage: 'fr', lazyLoading: trialSettings.WHOLE_PAGE_LAZY_LOADING, translateAfterScrollStop: trialSettings.WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP, autoTranslateOnDOMChanges: trialSettings.WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES,
    });
    if (!trial.effectiveSettingsValidation.ok) throw new Error(trial.effectiveSettingsValidation.issues.join('; '));
    if (fixtureConfig.scenario === 'scroll-through' && !staleSuccessProbe) {
      const initialIds = fixtureConfig.scrollBands[0].ids;
      const customCancellationResources = customCancellationProtocol
        ? await awaitConcreteCustomCancellationResolver({
          sessionId,
          readResources: () => evaluate(chrome, workerSession,
            `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false),
          until,
        })
        : null;
      trial.scrollThrough = { initialVisibleAcceptance: await until(async () => {
        const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
        return initialIds.every(id => state?.acceptedIds.includes(id)) ? state : null;
      }, 60_000), bandAcceptance: [] };
      if (googleTimeoutProtocol) armGoogleV2Timeout(googleTimeoutProtocol);
      if (custom429Protocol) {
        await armCustom429({
          protocol: custom429Protocol, resilienceEvidence, initialIds, sessionId,
          chrome, workerSession, pageSession, contentContext, evaluate, until, now,
        });
      }
      if (customCancellationProtocol) {
        armCustomCancellation({
          protocol: customCancellationProtocol, sessionId, resolver: customCancellationResources?.sourceResolvers?.[sessionId],
          initialIds, fixtureConfig, now,
        });
      }
      if (custom400Protocol) {
        await armCustom400({
          protocol: custom400Protocol, resilienceEvidence, initialIds, sessionId,
          chrome, workerSession, pageSession, contentContext, evaluate, until, now,
        });
      }
      const phases = [];
      const bandedProviderLane = usesBandedProviderScroll(providerLane?.provider);
      for (const [label, y, bandIndex, waitBeforeMs] of scrollThroughPhases(bandedProviderLane)) {
        if (waitBeforeMs) await new Promise(resolve => setTimeout(resolve, waitBeforeMs));
        const phase = await evaluate(chrome, pageSession,
          `(()=>new Promise(resolve=>{const done=()=>{requestAnimationFrame(()=>{requestAnimationFrame(()=>{const visible=[...document.querySelectorAll('[data-bench-id]')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}).map(el=>el.dataset.benchId);resolve({x:scrollX,y:scrollY,visibleIds:visible,at:performance.now(),scheduler:window.__pageTranslationBenchmark.pageSessionSnapshot()})})})};addEventListener('scroll',done,{once:true});window.scrollTo(0,${y});if(scrollY===${y})done()}))()`, contentContext);
        if (phase.y !== y) throw new Error(`Native scroll did not reach requested ${label} offset: ${phase.y}/${y}`);
        if (bandedProviderLane && bandIndex !== null) {
          const band = fixtureConfig.scrollBands[bandIndex];
          const visibleValidation = validateExactTargetIds(`${label} visible target`, phase.visibleIds, band.ids);
          if (!visibleValidation.ok) throw new Error(`Native scroll did not expose the complete ${label}: ${visibleValidation.issues.join('; ')}`);
          if (customCancellationProtocol?.held) {
            const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
            trial.scrollThrough.bandAcceptance.push({ band: band.band, targetCount: band.ids.length,
              acceptedIds: state.acceptedIds.filter(id => band.ids.includes(id)), acceptedCount: state.acceptedIds.filter(id => band.ids.includes(id)).length,
              cancelledTargetIds: customCancellationProtocol.held.targetIds });
            phases.push({ label, ...phase });
            break;
          }
          const accepted = await until(async () => {
            if (customCancellationProtocol?.held) return { cancellationHeld: true, acceptedIds: [] };
            const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
            const timeoutIds = googleTimeoutProtocol?.held?.cancellation ? new Set(googleTimeoutProtocol.held.targetIds) : new Set();
            const failedIds = new Set([...(custom400Protocol?.evidence.injected400?.[0]?.targetIds ?? []),
              ...(customCancellationProtocol?.held?.targetIds ?? []), ...timeoutIds]);
            return band.ids.every(id => failedIds.has(id) || state?.acceptedIds.includes(id)) ? state : null;
          }, googleTimeoutProtocol ? 75_000 : 30_000);
          if (accepted.cancellationHeld) {
            const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
            trial.scrollThrough.bandAcceptance.push({ band: band.band, targetCount: band.ids.length,
              acceptedIds: state.acceptedIds.filter(id => band.ids.includes(id)),
              acceptedCount: state.acceptedIds.filter(id => band.ids.includes(id)).length,
              cancelledTargetIds: customCancellationProtocol.held.targetIds });
            phases.push({ label, ...phase });
            break;
          }
          const failedIds = [
            ...(custom400Protocol?.evidence.injected400[0]?.targetIds ?? []),
            ...(customCancellationProtocol?.held?.targetIds ?? []),
            ...(googleTimeoutProtocol?.held?.cancellation ? googleTimeoutProtocol.held.targetIds : []),
          ];
          const { acceptedIds, failedTargetIds } = partitionBandAcceptance(band.ids, accepted.acceptedIds, failedIds);
          const partial = custom400Protocol || googleTimeoutProtocol;
          const checkpointAcceptedIds = partial ? acceptedIds : band.ids;
          trial.scrollThrough.bandAcceptance.push({ band: band.band, targetCount: band.ids.length,
            ...(partial ? { failedTargetIds } : {}),
            acceptedIds: checkpointAcceptedIds,
            acceptedCount: partial ? acceptedIds.length : accepted.acceptedIds.length,
            acceptedAtById: Object.fromEntries(band.ids.map(id => [id, accepted.acceptedPerformanceAtById?.[id] ?? null])) });
        }
        if (!bandedProviderLane && label === 'revisit-band-2') {
          await new Promise(resolve => setTimeout(resolve, 750));
          const band = fixtureConfig.scrollBands[1];
          const accepted = await until(async () => {
            const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
            return band.ids.every(id => state?.acceptedIds.includes(id)) ? state : null;
          }, 30_000);
          trial.scrollThrough.bandAcceptance.push({ band: band.band, targetCount: band.ids.length, acceptedIds: band.ids,
            acceptedCount: accepted.acceptedIds.length, acceptedAtById: Object.fromEntries(band.ids.map(id => [id, accepted.acceptedPerformanceAtById?.[id] ?? null])) });
        }
        phases.push({ label, ...phase });
      }
      trial.scrollThrough = { ...trial.scrollThrough, phases, method: bandedProviderLane
        ? 'window.scrollTo with native scroll events and animation-frame settling; each 1000-target provider-lane band must be visible and exactly accepted before the next native scroll; no scheduler signals or synthetic events'
        : 'window.scrollTo with native scroll events and animation-frame settling; discovery/Edge burst and settled checkpoints preserve the legacy sequence; no scheduler signals or synthetic events' };
    }

    let dynamicCohortsInserted = 0;
    const insertDynamicCohort = async index => {
      const cohort = fixtureConfig.dynamicCohorts[index];
      const inserted = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.insertDynamicCohort(${JSON.stringify(cohort)})`, contentContext);
      dynamicCohortsInserted++;
      originals.push(...cohort.targets.map(target => [target.id, target.source]));
      for (const target of cohort.targets) originalById.set(target.id, target.source);
      trial.rawDOM.original.push(...cohort.targets.map(target => [target.id, target.source]));
      (trial.dynamicCohorts ??= []).push({ id: cohort.id, targetIds: cohort.targets.map(target => target.id), insertedAt: inserted.insertedAt });
      return inserted;
    };
    const insertShadowTarget = async (id, phase) => {
      const inserted = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.insertShadowTarget(${JSON.stringify(id)},${JSON.stringify(phase)})`, contentContext);
      const target = fixtureConfig.shadowTargets.find(item => item.id === id);
      if (inserted.source !== target.source) throw new Error(`Observed dynamic Shadow DOM source mismatch: ${id}`);
      originalById.set(id, inserted.source);
      trial.rawDOM.original.push([id, inserted.source]);
      (trial.dynamicCohorts ??= []).push({ id: `shadow-${phase}`, targetIds: [id], insertedAt: inserted.insertedAt });
      trial.shadowDOM.metadata.push([id, inserted.originalAttributes]);
      trial.shadowDOM.targetStates.push([id, { ...inserted.directionState, markers: inserted.markers }]);
      dynamicCohortsInserted++;
      return inserted;
    };
    if (fixtureConfig.scenario === 'dynamic-dom') {
      if (trialSettings.WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES !== true
          || managerCall.settings?.autoTranslateOnDOMChanges !== true) throw new Error('Dynamic DOM scenario did not enable production auto-translation on DOM changes.');
      const translating = await until(async () => {
        const snapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
        return snapshot?.translationSessionId === sessionId && snapshot.managerTranslating === true ? snapshot : null;
      });
      trial.dynamicBaseSessionAtFirstInsertion = translating;
      await insertDynamicCohort(0);
    }
    if (fixtureConfig.scenario === 'shadow-dom') {
      if (managerCall.settings?.autoTranslateOnDOMChanges !== true || trialSettings.WHOLE_PAGE_LAZY_LOADING !== false) throw new Error('Shadow DOM scenario settings are not auto-DOM-only.');
      trial.shadowDOM.initialDiscoveryDrain = await until(async () => {
        const [state, accepted, contentEvents] = await Promise.all([
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false),
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.events', contentContext, false),
        ]);
        const initialIds = fixtureConfig.targets.map(target => target.id);
        const [primitiveAdmissions, schedulerEnqueues] = await Promise.all([
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.discoveryAdmissionOrder', contentContext, false),
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.schedulerEnqueueOrder', contentContext, false),
        ]);
        const transitions = accepted?.acceptedSettlementTransitions ?? [];
        const bridgeDiscoveryDrained = typeof state?.bridgeDiscoveryPending === 'boolean'
          ? state.bridgeDiscoveryPending === false && state.bridgeDiscoveryRunning === false
            && state.bridgeDiscoveryStarting === false && state.bridgeDiscoveryQueueDepth === 0 && state.bridgeDiscoveryFailed === false
          : mode === 'legacy' ? true
            : contentEvents?.some(event => event.name === 'bridge.discovery.pending' && event.pending === false
              && event.bridgePending === false && event.queueDepth === 0 && event.running === false) === true;
        const readiness = shadowInitialTranslationReadiness({ expectedIds: initialIds, expectedSessionId: sessionId,
          observedSessionId: state?.translationSessionId, schedulerState: state, bridgeDiscoveryDrained,
          admissions: primitiveAdmissions, enqueues: schedulerEnqueues, settlements: transitions,
          acceptedDomIds: accepted?.acceptedDomIds });
        trial.shadowDOM.latestInitialDrainObservation = { scheduler: state, acceptedSettlementTransitions: transitions,
          acceptedDomIds: accepted?.acceptedDomIds ?? [], bridgeDiscoveryDrained,
          bridgeEvents: contentEvents?.filter(event => event.name === 'bridge.discovery.pending') ?? [],
          primitiveAdmissions, schedulerEnqueues, readiness };
        if (!readiness.ready) return null;
        return { scheduler: state, acceptedSettlementTransitions: transitions,
          acceptedDomIds: accepted.acceptedDomIds };
      });
      await insertShadowTarget('shadow-dynamic-host', 'detached-host');
    }

    if (staleSuccessProbe) {
      await runStaleSuccessProbe({
        trial,
        fixture: { fixtureConfig, originals, originalById },
        page: { chrome, pageSession, contentContext, evaluate },
        worker: { workerSession },
        probe: { sessionId, cancellationControl, staleSuccessProbe, requestHandlerJobs },
        helpers: { now, until, isSessionEvent, formatCommandFailure, sessionIdFromStart, mapStaleSuccessResponse, mapCustomStaleSuccessResponse },
      });
      return trial;
    }

    if (cancellationProbe) {
      await runCancellationProbe({
        trial,
        fixture: { fixtureConfig, originals, originalById },
        page: { chrome, pageSession, contentContext, evaluate },
        worker: { workerSession },
        probe: { sessionId, started, cancellationControl, cancellationProbe, requestHandlerJobs },
        measurement: { measurementState },
        helpers: { now, until, isSessionEvent, formatCommandFailure, sessionIdFromStart, deriveTimings },
      });
      return trial;
    }

    if (fixtureConfig.scenario === 'spa-navigation') {
      const ids = fixtureConfig.targets.map(target => target.id);
      const changedIds = fixtureConfig.spaChangedIds;
      const retainedIds = ids.filter(id => !changedIds.includes(id));
      const routeSource = id => changedIds.includes(id) ? fixtureConfig.spaSources[Number(id.slice(7))] : originalById.get(id);
      const readSpa = () => evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.spaSnapshot()', contentContext, false);
      const readEvents = () => evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
      const translationTerminal = (list, owner, targetIds, acceptedAtById, acceptedIds, expectedAcceptedIds = targetIds) => list.find(event =>
        validateSpaTerminal({ event, sessionId: owner, targetIds, acceptedAtById, acceptedIds, expectedAcceptedIds }).ok);
      const expectedTranslation = (_id, source) => `\u200efixture translation: ${source}`;
      const completedA = await until(async () => {
        const [list, state, pageState] = await Promise.all([readEvents(), readSpa(), evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false)]);
        const terminal = translationTerminal(list, sessionId, ids, undefined, state.acceptedIds);
        const domOkay = state.dom.length === ids.length && state.dom.every(([id, text]) => text === expectedTranslation(id, originalById.get(id)));
        const acceptedOkay = ids.every(id => state.acceptedIds.includes(id));
        const idle = pageState?.translationSessionId === sessionId && pageState.managerTranslating === false
          && pageState.activeFlushes === 0 && pageState.queueIds?.length === 0 && pageState.pendingSettlementCount === 0
          && pageState.discoveryPending === false;
        trial.spaRouteAProgress = { terminalObserved: !!terminal, domOkay, acceptedOkay, idle,
          acceptedIds: state.acceptedIds, dom: state.dom, pageState };
        return terminal && domOkay && acceptedOkay && idle ? { terminal, state, pageState } : null;
      }, 60_000);
      if (completedA.state.sessionA !== sessionId || !completedA.state.cursorA) throw new Error('Route A did not expose its real production navigation cursor/session.');
      const providerARequests = trial.requests.filter(request => request.category === 'provider-translation')
        .filter(request => (request.batchTexts ?? []).every(source => fixtureConfig.targets.some(target => target.source === source)))
        .map(request => ({ ...request, targetIds: request.batchTexts.map(source => fixtureConfig.targets.find(target => target.source === source)?.id ?? null) }));
      const providerAIds = providerARequests
        .flatMap(request => request.batchTexts ?? []).map(source => fixtureConfig.targets.find(target => target.source === source)?.id ?? null);
      const providerASettings = completedA.state.managerCalls.find(call => call.isAuto === false)?.settings;
      const providerAValidation = validateExactTargetIds('route A provider request', providerAIds, ids);
      if (!providerAValidation.ok) throw new Error(providerAValidation.issues.join('; '));
      const providerARoute = validateSpaProviderRoute({ provider: providerASettings?.provider, requests: providerARequests, expectedIds: ids });
      if (!providerARoute.ok) throw new Error(providerARoute.issues.join('; '));
      trial.spaNavigation = { sessionA: sessionId, changedIds, retainedIds, routeA: completedA, cursorA: completedA.state.cursorA,
        acceptedAIds: completedA.state.acceptedIds, pendingA: completedA.pageState, providerAIds, providerAValidation, providerARoute };

      trial.spaNavigation.navStartedAt = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.beginSpaNavigation()', contentContext);
      trial.timestamps.spaNavigationStartedAt = trial.spaNavigation.navStartedAt;
      const invalidation = await until(async () => {
        const state = await readSpa();
        const event = state.events.find(item => item.name === 'spa.navigation.invalidated');
        const routeSourcesUpdated = changedIds.every(id => state.sourceValues.find(([targetId]) => targetId === id)?.[1] === fixtureConfig.spaSources[Number(id.slice(7))]);
        return event && state.sourceMutationAt > state.invalidatedAt && routeSourcesUpdated ? { state, event } : null;
      }, 20_000);
      trial.spaNavigation.invalidation = invalidation.event;
      trial.spaNavigation.sourceMutationAt = invalidation.state.sourceMutationAt;
      trial.spaNavigation.cursorB = invalidation.event.cursor;
      const bStarted = await until(async () => {
        const state = await readSpa();
        const autoEntry = state.managerCallEvents.find(event => event.isAuto === true);
        const current = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
        return autoEntry && current?.translationSessionId && current.translationSessionId !== sessionId
          ? { state, current, autoEntry, sessionB: current.translationSessionId } : null;
      }, 30_000);
      if (trial.commands.filter(command => command.action === 'page-translate').length !== 1) throw new Error('SPA route B must be started only by the production auto-rule path.');
      trial.spaNavigation.sessionB = bStarted.sessionB;
      const bAccepted = await until(async () => {
        const [list, state, pageState] = await Promise.all([readEvents(), readSpa(), evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false)]);
        const terminal = translationTerminal(list, bStarted.sessionB, ids, state.acceptedAtById,
          state.acceptedBySession[bStarted.sessionB] ?? [], changedIds);
        const translatedDom = state.dom.length === ids.length && ids.every(id => state.dom.find(([targetId]) => targetId === id)?.[1] === expectedTranslation(id, changedIds.includes(id) ? fixtureConfig.spaSources[Number(id.slice(7))] : originalById.get(id)));
        const acceptedChanged = changedIds.every(id => Number.isFinite(state.acceptedAtById[id]));
        const idle = pageState?.translationSessionId === bStarted.sessionB && pageState.managerTranslating === false
          && pageState.activeFlushes === 0 && pageState.queueIds?.length === 0 && pageState.pendingSettlementCount === 0
          && pageState.discoveryPending === false;
        return terminal && translatedDom && acceptedChanged && idle ? { terminal, state, pageState } : null;
      }, 60_000);
      const terminalAt = bAccepted.terminal.performanceAt;
      const beforeRestore = bAccepted.state;
      const logicalBatchEvidenceAtTerminal = providerLane ? await evaluate(chrome, pageSession,
        '(()=>{const trace=window.__pageTranslationBenchmark;return {intervals:structuredClone(trace.logicalBatchIntervals),schedulerBatchSessions:structuredClone(trace.schedulerBatchSessions)}})()',
        contentContext, false) : null;
      const requestedSources = trial.requests.filter(request => request.category === 'provider-translation')
        .flatMap(request => request.batchTexts ?? []).filter(source => fixtureConfig.spaSources.includes(source));
      const requestIds = requestedSources.map(source => `target-${fixtureConfig.spaSources.indexOf(source)}`);
      const providerBRequests = trial.requests.filter(request => request.category === 'provider-translation')
        .filter(request => (request.batchTexts ?? []).every(source => fixtureConfig.spaSources.includes(source)))
        .map(request => ({ ...request, targetIds: request.batchTexts.map(source => `target-${fixtureConfig.spaSources.indexOf(source)}`) }));
      const providerRequests = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
        ...request,
        targetIds: (request.batchTexts ?? []).map(source => fixtureConfig.targets.find(target => target.source === source)?.id
          ?? (fixtureConfig.spaSources.includes(source) ? `target-${fixtureConfig.spaSources.indexOf(source)}` : null)),
      }));
      const settingsCalls = beforeRestore.managerCalls;
      const settingsA = settingsCalls.find(call => call.isAuto === false)?.settings;
      const settingsB = settingsCalls.find(call => call.isAuto === true)?.settings;
      const providerRouteValidation = validateSpaProviderRoute({ provider: settingsA?.provider === 'edge' && settingsB?.provider === 'edge' ? 'edge' : null,
        requests: providerRequests, expectedIds: [...ids, ...changedIds] });
      const bEnqueues = beforeRestore.enqueues.filter(item => item.sessionId === bStarted.sessionB).map(item => item.id);
      const bAdmissions = beforeRestore.admissions.filter(item => item.sessionId === bStarted.sessionB);
      const discoveredIds = bAdmissions.map(item => item.id);
      const bBatches = beforeRestore.batches.filter(batch => batch.sessionId === bStarted.sessionB);
      const batchIds = bBatches.flatMap(batch => batch.targetIds ?? []);
      const bEntries = beforeRestore.managerCallEvents.filter(event => event.isAuto === true);
      const checkedProviderBRoute = validateSpaProviderRoute({ provider: settingsB?.provider, requests: providerBRequests, expectedIds: changedIds });
      const exactChanged = validateExactTargetIds('B accepted write', Object.keys(beforeRestore.acceptedAtById), changedIds);
      const exactBAccepted = validateExactTargetIds('B session acceptance ledger', beforeRestore.acceptedBySession[bStarted.sessionB] ?? [], changedIds);
      const exactRequests = validateExactTargetIds('B provider request', requestIds, changedIds);
      const exactBatches = validateExactTargetIds('B scheduler batch', batchIds, changedIds);
      const exactAdmissions = validateExactTargetIds('B discovery scan', discoveredIds, ids);
      const exactEnqueues = validateExactTargetIds('B scheduler enqueue', bEnqueues, changedIds);
      const cursorValidation = validateSpaNavigation({ cursorA: trial.spaNavigation.cursorA, cursorB: trial.spaNavigation.cursorB,
        navStartedAt: trial.spaNavigation.navStartedAt, stopAt: beforeRestore.stopAt, invalidatedAt: beforeRestore.invalidatedAt, sourceUpdatedAt: beforeRestore.sourceMutationAt,
        firstAcceptedAtById: beforeRestore.acceptedAtById, terminalAt,
        changedIds, retainedIds, requestedIds: requestIds, acceptedIds: beforeRestore.acceptedBySession[bStarted.sessionB] ?? [],
        duplicateIds: beforeRestore.duplicateAcceptedIds, completionReady: validateSpaTerminal({ event: bAccepted.terminal,
          sessionId: bStarted.sessionB, targetIds: ids, acceptedAtById: beforeRestore.acceptedAtById,
          acceptedIds: beforeRestore.acceptedBySession[bStarted.sessionB] ?? [], expectedAcceptedIds: changedIds }).ok });
      const sourceOrdered = beforeRestore.stopAt > trial.spaNavigation.navStartedAt
        && beforeRestore.sourceMutationAt > beforeRestore.invalidatedAt
        && bAdmissions.length > 0 && bAdmissions.every(item => item.at > beforeRestore.sourceMutationAt)
        && retainedIds.every(id => !bEnqueues.includes(id) && !requestIds.includes(id))
        && exactBAccepted.ok && retainedIds.every(id => !(beforeRestore.acceptedBySession[bStarted.sessionB] ?? []).includes(id));
      const sessionValidation = validateSpaSessions({ settingsA, settingsB,
        autoB: bEntries.length > 0 && bEntries.every(entry => entry.isAuto === true)
          && settingsCalls.filter(call => call.isAuto === true).length >= 1,
        sessionA: sessionId, sessionB: bStarted.sessionB });
      const settingsSame = sessionValidation.ok;
      const autoOnly = sessionValidation.ok;
      const issues = [...exactChanged.issues, ...exactBAccepted.issues, ...exactRequests.issues, ...exactBatches.issues, ...exactAdmissions.issues, ...exactEnqueues.issues,
        ...cursorValidation.issues, ...providerARoute.issues, ...checkedProviderBRoute.issues, ...providerRouteValidation.issues];
      if (!sourceOrdered) issues.push('B sources/admissions violate invalidation-before-discovery ordering or retained-target invariants');
      issues.push(...sessionValidation.issues);
      if (!beforeRestore.identityPreserved) issues.push('Fixture target element identity changed across same-document navigation');
      if (issues.length) throw new Error(issues.join('; '));

      trial.spaNavigation = { ...trial.spaNavigation, sessionB: bStarted.sessionB, autoEntry: bStarted.autoEntry,
        cursorB: trial.spaNavigation.cursorB, acceptedAtById: beforeRestore.acceptedAtById, BDiscoveryAdmissions: bAdmissions,
        BEnqueues: beforeRestore.enqueues.filter(item => item.sessionId === bStarted.sessionB), BBatches: bBatches,
        BProviderRequestIds: requestIds, duplicateAcceptedIds: beforeRestore.duplicateAcceptedIds,
        providerBRoute: checkedProviderBRoute, providerRouteValidation,
        completion: bAccepted.terminal, completionAt: terminalAt, finalDOM: beforeRestore.dom,
        validation: { ok: true, issues: [], exactChanged, exactRequests, exactBatches, exactAdmissions, exactEnqueues, sourceOrdered, settingsSame, autoOnly, sessionValidation, cursorValidation } };
      trial.spaNavigationTiming = { clock: 'performance.now() in the fixture document', navStartedAt: trial.spaNavigation.navStartedAt,
        firstAcceptedAt: cursorValidation.firstAcceptedAt, terminalAt, navigationToFirstAcceptedMs: cursorValidation.navigationToFirstAcceptedMs,
        navigationToCompletionMs: cursorValidation.navigationToCompletionMs, acceptedAtById: beforeRestore.acceptedAtById };
      trial.derivedTimings = { ...(trial.derivedTimings ?? {}), spaNavigation: trial.spaNavigationTiming };
      trial.rawDOM.translated = beforeRestore.dom;
      trial.terminal = bAccepted.terminal;

      trial.spaNavigation.spaObserverCleanup = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.finishSpaNavigationTracking()', contentContext);
      if (!trial.spaNavigation.spaObserverCleanup?.drained || !trial.spaNavigation.spaObserverCleanup?.disconnected) {
        throw new Error('SPA acceptance observer did not drain and disconnect before Restore.');
      }
      trial.spaNavigation.observersStoppedAt = now();
      const contentTrace = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext);
      measurementState.stopped = contentTrace?.available === true;
      measurementState.stopAttempts++;
      trial.measurementStopAttempted = true;
      trial.measurements = { content: contentTrace };
      trial.spaNavigation.measurementObserverStoppedAt = now();
      if (!contentTrace?.available) throw new Error(`SPA measurement stop failed before Restore: ${contentTrace?.reason ?? 'observer snapshot unavailable'}`);
      const calibratedLongTasks = validatedLongTaskObservation(trial.longTaskCalibration, contentTrace.longTasks);
      trial.derivedTimings.longTasks = calibratedLongTasks.entries;
      trial.spaNavigation.longTaskUnavailableReason = calibratedLongTasks.unavailableReason;
      trial.spaNavigation.observersStoppedBeforeRestore = true;

      trial.timestamps.restoreStarted = now();
      const observerRestoreOrder = validateSpaObserverRestoreOrder({ spaObserverStoppedAt: trial.spaNavigation.observersStoppedAt,
        measurementObserverStoppedAt: trial.spaNavigation.measurementObserverStoppedAt, restoreStartedAt: trial.timestamps.restoreStarted });
      if (!observerRestoreOrder.ok) throw new Error(observerRestoreOrder.issues.join('; '));
      trial.spaNavigation.observerRestoreOrder = observerRestoreOrder;
      const restoreResponse = await evaluate(chrome, pageSession,
        `chrome.runtime.sendMessage(${JSON.stringify({ action: 'page-restore' })})`, contentContext);
      trial.commands.push({ action: 'page-restore', sentAt: trial.timestamps.restoreStarted, respondedAt: now(), response: restoreResponse });
      if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE', restoreResponse));
      const restored = await until(async () => {
        const list = await readEvents();
        const done = list.find(event => isSessionEvent(event, 'page-restore-complete', bStarted.sessionB));
        if (!done) return null;
        const dom = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.dataset.benchKind==='title'?el.getAttribute('title'):el.textContent])`, contentContext, false);
        const expected = ids.map(id => [id, routeSource(id)]);
        return JSON.stringify(dom) === JSON.stringify(expected) ? { done, dom } : null;
      }, 30_000);
      trial.rawDOM.restored = restored.dom;
      trial.restoreTerminal = restored.done;
      trial.timestamps.restoreCompleted = now();
      const sourceToId = new Map([...fixtureConfig.targets.map(target => [target.source, target.id]), ...fixtureConfig.spaSources.map((source, index) => [source, `target-${index}`])]);
      const providerAttempts = trial.requests.filter(request => request.category === 'provider-translation');
      trial.providerTranslationAttempts = providerAttempts.length;
      trial.providerRequestOrder = mapProviderBatchIds(providerAttempts.map(request => request.batchTexts ?? []), sourceToId);
      trial.providerBatchSizes = providerAttempts.map(request => request.batchSize);
      trial.spaNavigation.restoreValidation = { ok: true, expected: ids.map(id => [id, routeSource(id)]), observed: restored.dom,
        retainedSourceIds: retainedIds, changedSourceIds: changedIds };
      trial.spaNavigationTiming.restoreCompletedAt = trial.timestamps.restoreCompleted;
      if (trial.requests.some(request => request.category === 'blocked')) throw new Error('Unexpected external request blocked during SPA navigation trial.');
      if (providerLane) {
        trial.spaNavigation.logicalBatchIntervalsAtTerminal = logicalBatchEvidenceAtTerminal;
        trial.providerLogicalBatches = summarizeSpaLogicalProviderBatches(
          logicalBatchEvidenceAtTerminal?.intervals, logicalBatchEvidenceAtTerminal?.schedulerBatchSessions,
          sessionId, bStarted.sessionB);
        if (!trial.providerLogicalBatches.ok) throw new Error(trial.providerLogicalBatches.issues.join('; '));
        trial.providerRuntimeObserved = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.providerRuntimeSnapshot(${JSON.stringify(providerLane.provider)},${providerLane.optimizationLevel})`, undefined, false);
        trial.providerRuntimeValidation = validateProviderRuntime({
          requestedProvider: providerLane.provider, requestedOptimizationLevel: providerLane.optimizationLevel,
          snapshot: trial.providerRuntimeObserved,
        });
        if (!trial.providerRuntimeValidation.ok) throw new Error(trial.providerRuntimeValidation.issues.join('; '));
        const pageSnapshot = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
        trial.providerSchedulerObserved = pageSnapshot?.schedulerBatchConfig ?? null;
        trial.pageWorkerLimit = observedPageWorkerLimit(trial.providerSchedulerObserved);
        trial.providerSchedulerValidation = validateProviderSchedulerRuntime({
          provider: providerLane.provider, optimizationLevel: providerLane.optimizationLevel,
          providerRuntime: trial.providerRuntimeObserved, scheduler: trial.providerSchedulerObserved,
        });
        if (!trial.providerSchedulerValidation.ok) throw new Error(trial.providerSchedulerValidation.issues.join('; '));
      }
      trial.status = 'passed';
      return trial;
    }

    const lifecycle = await completeTranslationMeasurement({
      state: measurementState,
      cleanupErrors: trial.cleanupErrors,
      awaitAcceptedTranslation: async () => {
        if (customCancellationProtocol?.held) {
          await customCancellationProtocol.claimCompletion;
          if (customCancellationProtocol.error) {
            throw new Error(customCancellationProtocol.error.message ?? String(customCancellationProtocol.error));
          }
          const stopped = await until(async () => {
            const state = await evaluate(chrome, pageSession,
              'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
            const measurement = await evaluate(chrome, pageSession,
              'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
            return Array.isArray(measurement?.acceptedIds)
              && state?.translationSessionId === sessionId && state.managerTranslating === false
              && state.activeFlushes === 0 && state.queueIds?.length === 0 && state.pendingSettlementCount === 0
              && state.discoveryPending === false
              && JSON.stringify(measurement?.acceptedIds) === JSON.stringify(customCancellationProtocol.evidence.retainedAcceptedIds)
              ? { state, measurement } : null;
          }, 15_000);
          trial.scrollThrough.finalSchedulerState = stopped.state;
          trial.terminal = { cancellationStopAcknowledged: true, sessionId };
          trial.rawDOM.translated = await evaluate(chrome, pageSession,
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          await captureCustomCancellationPreRestore({
            protocol: customCancellationProtocol, fixtureConfig, chrome, pageSession, contentContext, evaluate,
          });
          return { cancellation: true, acceptedIds: stopped.measurement.acceptedIds };
        }
        const accepted = await until(async () => {
          const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
          trial.lifecycle = events;
          const expectedCount = fixtureConfig.scenario === 'shadow-dom' ? fixtureConfig.shadowTargets.length
            : fixtureConfig.targets.length + (fixtureConfig.dynamicCohorts?.reduce((total, cohort) => total + cohort.targets.length, 0) ?? 0);
          const terminal = fixtureConfig.scenario === 'dynamic-dom' || fixtureConfig.scenario === 'shadow-dom' || fixtureConfig.scenario === 'scroll-through'
            ? findFinalTranslationTerminal(events, sessionId, expectedCount,
              resilienceProbe === 'custom-400' || resilienceProbe === 'googlev2-timeout' ? 25 : 0)
            : events.find(event => ['page-translate-complete', 'page-translate-idle'].some(action => isSessionEvent(event, action, sessionId)));
          if (terminal) trial.terminal = terminal;
          if (fixtureConfig.scenario === 'dynamic-dom' && dynamicCohortsInserted === 1) {
            const snapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
            const baseIds = fixtureConfig.targets.map(target => target.id);
            if (baseIds.every(id => snapshot.acceptedSettlementIds.includes(id) && snapshot.acceptedDomIds.includes(id))) {
              await insertDynamicCohort(1);
            }
          }
          if (fixtureConfig.scenario === 'shadow-dom' && dynamicCohortsInserted === 1) {
            const snapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
            const initialIds = fixtureConfig.targets.map(target => target.id);
            if (initialIds.every(id => snapshot.acceptedSettlementIds.includes(id) && snapshot.acceptedDomIds.includes(id))
                && snapshot.acceptedSettlementIds.includes('shadow-dynamic-host') && snapshot.acceptedDomIds.includes('shadow-dynamic-host')) {
              await insertShadowTarget('shadow-dynamic-root', 'later-root-content');
            }
          }
          if (fixtureConfig.scenario === 'dynamic-dom' && dynamicCohortsInserted !== fixtureConfig.dynamicCohorts.length) return null;
          if (fixtureConfig.scenario === 'shadow-dom' && dynamicCohortsInserted !== 2) return null;
          if (!terminal) return null;
          if (fixtureConfig.scenario === 'scroll-through') {
            const state = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
            const measurementEvidence = await evaluate(chrome, pageSession,
              'window.__pageTranslationBenchmark.viewportEntrySnapshot()', contentContext, false);
            if (state.translationSessionId !== sessionId || state.managerTranslating !== false || state.activeFlushes !== 0
                || state.queueIds?.length !== 0 || state.pendingSettlementCount !== 0 || state.discoveryPending !== false
                || Object.keys(measurementEvidence ?? {}).length !== expectedCount) return null;
            trial.scrollThrough.finalSchedulerState = state;
          }
          if (fixtureConfig.scenario === 'dynamic-dom') {
            const acceptedSnapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
            const expectedIds = [...fixtureConfig.targets, ...fixtureConfig.dynamicCohorts.flatMap(cohort => cohort.targets)].map(target => target.id);
            if (!expectedIds.every(id => acceptedSnapshot.acceptedSettlementIds.includes(id) && acceptedSnapshot.acceptedDomIds.includes(id))
                || acceptedSnapshot.cohorts.some(cohort => cohort.completionAt === null)) return null;
            const sessionState = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
            if (sessionState.translationSessionId !== sessionId || sessionState.managerTranslating !== false
                || sessionState.activeFlushes !== 0 || sessionState.queueIds?.length !== 0) return null;
          }
          if (fixtureConfig.scenario === 'shadow-dom') {
            const acceptedSnapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
            const expectedIds = fixtureConfig.shadowTargets.map(target => target.id);
            if (!expectedIds.every(id => acceptedSnapshot.acceptedSettlementIds.includes(id) && acceptedSnapshot.acceptedDomIds.includes(id))) return null;
            const acceptedStates = await evaluate(chrome, pageSession,
              `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;const state=el=>{const s=getComputedStyle(el);return {inlineDirection:el.style.direction,inlineUnicodeBidi:el.style.unicodeBidi,computedDirection:s.direction,computedUnicodeBidi:s.unicodeBidi,markers:Object.fromEntries(['data-page-translated','data-has-original','data-dir-original-saved','data-translate-dir'].map(name=>[name,el.getAttribute(name)]))}};return ${JSON.stringify(expectedIds)}.map(id=>[id,state(t.get(id))])})()`, contentContext, false);
            const baseline = new Map(trial.shadowDOM.targetStates);
            for (const [id, state] of acceptedStates) {
              const originalState = baseline.get(id);
              if (!originalState || Object.keys(originalState).filter(key => key.startsWith('inline') || key.startsWith('computed'))
                .some(key => state[key] !== originalState[key])) throw new Error(`French Shadow DOM translation unexpectedly changed direction state: ${id}`);
              const target = fixtureConfig.shadowTargets.find(item => item.id === id);
              if (target.kind === 'text' && state.markers['data-page-translated'] !== 'true') throw new Error(`Translated Shadow DOM text lacks its production marker: ${id}`);
              if (state.markers['data-page-translated'] !== null && state.markers['data-page-translated'] !== 'true') throw new Error(`Unexpected translated marker value: ${id}`);
            }
            trial.shadowDOM.acceptedTargetStates = acceptedStates;
          }
           const dom = await evaluate(chrome, pageSession,
             fixtureConfig.scenario === 'shadow-dom'
               ? `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;return ${JSON.stringify(fixtureConfig.shadowTargets.map(target => target.id))}.map(id=>{const el=t.get(id);return [id,el?.dataset.benchKind==='title'?el.getAttribute('title'):el?.textContent]})})()`
               : `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
           trial.rawDOM.translated = dom;
            const failedTargets = [
              ...(custom400Protocol?.evidence.injected400[0]?.targetIds ?? []),
              ...(googleTimeoutProtocol?.held?.cancellation ? googleTimeoutProtocol.held.targetIds : []),
            ];
            const failedIds = new Set(failedTargets);
            if (failedTargets.length) {
              const observed = await evaluate(chrome, pageSession,
                `(${JSON.stringify(failedTargets)}).map(id=>{const el=document.querySelector('[data-bench-id="'+CSS.escape(id)+'"]');return [id,el?.textContent??null,{pageTranslated:el?.hasAttribute('data-page-translated')??false,hasOriginal:el?.hasAttribute('data-has-original')??false}]})`,
                contentContext, false);
              const failedTargetDOM = {
                expected: failedTargets.map(id => [id, originalById.get(id), { pageTranslated: false, hasOriginal: false }]),
                observed,
              };
              if (custom400Protocol) recordCustom400FailedTargetDOM(custom400Protocol, failedTargetDOM);
              if (googleTimeoutProtocol) recordGoogleTimeoutFailedTargetDOM(googleTimeoutProtocol, failedTargetDOM);
            }
           const translationReady = dom.length === originals.length && dom.every(([id, value]) => {
             const source = originalById.get(id);
             if (source === undefined) return false;
             return failedIds.has(id) ? value === source : value === `\u200efixture translation: ${source}`;
           });
           if (!translationReady) return null;
           if (custom400Protocol) {
              if (!recordCustom400PreRestorePreArmDrain(custom400Protocol, trial.requests, providerNetworkEvents)) return null;
           }
           return { terminal, dom };
        }, 60_000);
        trial.timestamps.terminalObservedByHarness = now();
        return accepted;
      },
      stopMeasurement: async () => {
        trial.measurementStopAttempted = true;
        const contentTrace = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext);
        trial.measurements = { content: contentTrace };
        trial.timestamps.measurementStopped = now();
        if (!contentTrace?.available) throw new Error(`Translation measurement stop failed: ${contentTrace?.reason ?? 'no content observer snapshot'}`);
        if (contentTrace.stoppedAt > trial.timestamps.measurementStopped) throw new Error('Content measurement snapshot stop timestamp is later than its CDP return boundary.');
        return contentTrace;
      },
      sendRestore: async () => {
        trial.stage = 'restore';
        trial.timestamps.restoreStarted = now();
        const response = await evaluate(chrome, pageSession,
          `chrome.runtime.sendMessage(${JSON.stringify({ action: 'page-restore' })})`, contentContext);
        trial.commands.push({ action: 'page-restore', sentAt: trial.timestamps.restoreStarted, respondedAt: now(), response });
        return response;
      },
      awaitRestoredDOM: async () => {
        const restored = await until(async () => {
          const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
          trial.lifecycle = events;
          const done = events.find(event => isSessionEvent(event, 'page-restore-complete', sessionId));
          if (done) trial.restoreTerminal = done;
          if (!done) return null;
          const dom = await evaluate(chrome, pageSession,
            fixtureConfig.scenario === 'shadow-dom'
              ? `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;return ${JSON.stringify(fixtureConfig.shadowTargets.map(target => target.id))}.map(id=>{const el=t.get(id);return [id,el?.dataset.benchKind==='title'?el.getAttribute('title'):el?.textContent]})})()`
              : `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          trial.rawDOM.restored = dom;
          if (fixtureConfig.scenario === 'shadow-dom') {
            const restoredProof = await evaluate(chrome, pageSession,
              `(()=>{const t=window.__pageTranslationBenchmark.shadowTargetById;const state=el=>{const s=getComputedStyle(el);return {inlineDirection:el.style.direction,inlineUnicodeBidi:el.style.unicodeBidi,computedDirection:s.direction,computedUnicodeBidi:s.unicodeBidi,markers:Object.fromEntries(['data-page-translated','data-has-original','data-dir-original-saved','data-translate-dir'].map(name=>[name,el.getAttribute(name)]))}};return {metadata:[...t].map(([id,el])=>[id,[...el.attributes].map(a=>[a.name,a.value])]),targetStates:[...t].map(([id,el])=>[id,state(el)]),session:window.__pageTranslationBenchmark.pageSessionSnapshot()}})()`, contentContext, false);
            Object.assign(restoredProof, await evaluate(chrome, pageSession,
              `(()=>{const o=window.__shadowBenchmarkOracle;return {directText:[...o.initialRoot.childNodes].some(n=>n.nodeType===3&&n.nodeValue==='SHADOW_DIRECT_TEXT_SENTINEL'),closedText:o.closedSentinel.textContent,closedRootInaccessible:o.closedHost.shadowRoot===null}})()`, undefined, false));
            trial.shadowDOM.restoreProof = restoredProof;
            const originalMeta = new Map(trial.shadowDOM.metadata);
            const originalStates = new Map(trial.shadowDOM.targetStates);
            if (!restoredProof.directText || restoredProof.closedText !== trial.shadowDOM.closedText || !restoredProof.closedRootInaccessible
                || restoredProof.metadata.length !== fixtureConfig.shadowTargets.length
                || restoredProof.metadata.some(([id, attrs]) => JSON.stringify(attrs) !== JSON.stringify(originalMeta.get(id)))
                || restoredProof.targetStates.some(([id, state]) => {
                  const baseline = originalStates.get(id);
                  return !baseline || Object.keys(baseline).some(key => JSON.stringify(state[key]) !== JSON.stringify(baseline[key]));
                })
                || restoredProof.session?.managerTranslating !== false || restoredProof.session?.activeFlushes !== 0
                || restoredProof.session?.queueIds?.length !== 0 || restoredProof.session?.pendingSettlementCount !== 0
                || restoredProof.session?.bridgeSessionActive === true || restoredProof.session?.bridgeSessionOwned === true) return null;
          }
          return dom.length === originals.length
            && dom.every(([id, text]) => originalById.get(id) === text) ? { done, dom } : null;
        }, 30_000);
        return restored;
      },
    });
    const contentTrace = lifecycle.measurement;
    const successfulProviderAttempts = canonicalProviderSourceAttempts(
      trial.requests.filter(request => request.category === 'provider-translation' && !request.canonicalSourceExcluded));
    trial.measurements.content = contentTrace;
    if (fixtureConfig.scenario === 'scroll-through' && !customCancellationProtocol) {
      const partialFailedIds = custom400Protocol?.evidence.injected400[0]?.targetIds
        ?? googleTimeoutProtocol?.held?.targetIds ?? [];
      const expectedAcceptedIds = partialFailedIds.length
        ? fixtureConfig.targets.map(target => target.id).filter(id => !partialFailedIds.includes(id))
        : undefined;
      const scrollValidation = validateScrollThroughEvidence({
        expectedIds: fixtureConfig.targets.map(target => target.id),
        expectedAcceptedIds,
        viewportEntryAtById: contentTrace.viewportEntryAtById,
        acceptedAtById: contentTrace.acceptedPerformanceAtById,
        pipelineStages: contentTrace.scrollThroughStages,
        checkpoints: trial.scrollThrough.phases,
        selectionViewport: contentTrace.scrollThroughStages?.selectionViewport,
        terminalAt: trial.terminal?.performanceAt,
        acceptedIds: contentTrace.acceptedIds,
        duplicateAcceptedIds: contentTrace.duplicateAcceptedIds,
        providerRequests: canonicalProviderSourceAttempts(
          trial.requests.filter(request => request.category === 'provider-translation' && !request.canonicalSourceExcluded)),
        schedulerState: trial.scrollThrough.finalSchedulerState,
        restoreOriginals: lifecycle.restored?.dom,
        expectedOriginals: originals,
        cleanupErrors: trial.cleanupErrors,
      });
      trial.scrollThrough.validation = scrollValidation;
      trial.scrollThrough.viewportEntryToAcceptedWriteLatencyMsById = scrollValidation.viewportEntryToAcceptedWriteLatencyMsById;
      trial.scrollThrough.productionStages = contentTrace.scrollThroughStages;
      trial.scrollThrough.aggregateLatency = deriveScrollAggregateMetrics(
        fixtureConfig.scrollBands, contentTrace.viewportEntryAtById, contentTrace.acceptedPerformanceAtById,
        expectedAcceptedIds);
      if (!scrollValidation.ok) throw new Error(scrollValidation.issues.join('; '));
    }
    if (fixtureConfig.scenario === 'dynamic-dom') {
      const cohortMeasurements = contentTrace.dynamicCohorts ?? [];
      const expectedCohorts = fixtureConfig.dynamicCohorts;
      const cohortIssues = [];
      if (cohortMeasurements.length !== expectedCohorts.length) cohortIssues.push(`expected ${expectedCohorts.length} dynamic cohorts, observed ${cohortMeasurements.length}`);
      for (const expectedCohort of expectedCohorts) {
        const observed = cohortMeasurements.find(cohort => cohort.id === expectedCohort.id);
        if (!observed || observed.targetIds.length !== expectedCohort.targets.length
            || expectedCohort.targets.some(target => !observed.targetIds.includes(target.id))) cohortIssues.push(`dynamic cohort ${expectedCohort.id} target registration is incomplete`);
        else if (!Number.isFinite(observed.insertedAt) || !Number.isFinite(observed.firstAcceptedLatencyMs) || observed.firstAcceptedLatencyMs < 0
            || !Number.isFinite(observed.completionLatencyMs) || observed.completionLatencyMs < observed.firstAcceptedLatencyMs
            || Object.keys(observed.acceptedAtById).length !== expectedCohort.targets.length
            || expectedCohort.targets.some(target => !Number.isFinite(observed.acceptedAtById[target.id]) || observed.acceptedAtById[target.id] < observed.insertedAt)) {
          cohortIssues.push(`dynamic cohort ${expectedCohort.id} timing/acceptance evidence is incomplete`);
        }
      }
      trial.dynamicCohortMeasurements = cohortMeasurements;
      trial.dynamicCohortValidation = { ok: cohortIssues.length === 0, issues: cohortIssues };
      if (cohortIssues.length) throw new Error(cohortIssues.join('; '));
      const finalSnapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
      const expectedIds = [...fixtureConfig.targets, ...expectedCohorts.flatMap(cohort => cohort.targets)].map(target => target.id);
      const settlementIdsValidation = validateExactTargetIds('scheduler accepted settlement', finalSnapshot.acceptedSettlementTransitions.map(({ id }) => id), expectedIds);
      if (!settlementIdsValidation.ok) throw new Error(settlementIdsValidation.issues.join('; '));
      const settlementCounts = new Map();
      for (const { id, sessionId: owner } of finalSnapshot.acceptedSettlementTransitions) {
        settlementCounts.set(id, (settlementCounts.get(id) ?? 0) + 1);
        if (owner !== trial.sessionId) throw new Error(`Dynamic DOM acceptance ${id} was owned by session ${owner}, expected ${trial.sessionId}.`);
      }
      if (expectedIds.some(id => settlementCounts.get(id) !== 1)) throw new Error('Dynamic DOM targets were not accepted by exactly one scheduler settlement each.');
      trial.dynamicAcceptanceSettlementTransitions = finalSnapshot.acceptedSettlementTransitions;
    }
    if (fixtureConfig.scenario === 'shadow-dom') {
      if (contentTrace.shadowDom?.observerDisconnected !== true || contentTrace.shadowDom.observedRootCount !== 3
          || contentTrace.shadowDom.observedTargetCount !== 1) throw new Error('Shadow DOM measurement observers did not disconnect after observing exactly three fixture-owned open roots and the owned light-DOM target.');
      const expectedIds = fixtureConfig.shadowTargets.map(target => target.id);
      const finalSnapshot = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.dynamicSnapshot()', contentContext, false);
      const settlementValidation = validateExactTargetIds('scheduler settlement', finalSnapshot.acceptedSettlementTransitions.map(({ id }) => id), expectedIds);
      if (!settlementValidation.ok) throw new Error(settlementValidation.issues.join('; '));
      if (finalSnapshot.acceptedSettlementTransitions.some(item => item.sessionId !== trial.sessionId)
          || expectedIds.some(id => finalSnapshot.acceptedSettlementTransitions.filter(item => item.id === id).length !== 1)) {
        throw new Error('Shadow DOM accepted settlements do not have one consistent translation-session owner.');
      }
      const batches = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.schedulerBatchSessions', contentContext, false) ?? [];
      if (!batches.length || batches.some(batch => batch.sessionId !== trial.sessionId)) throw new Error('Shadow DOM scheduler batches do not share the accepted translation session.');
      trial.shadowDOM = { ...trial.shadowDOM, expectedIds, settlementTransitions: finalSnapshot.acceptedSettlementTransitions, schedulerBatches: batches };
      const initialTimes = expectedIds.slice(0, 3).map(id => contentTrace.acceptedPerformanceAtById?.[id]);
      const initialAcceptedAt = initialTimes.every(Number.isFinite) ? Math.max(...initialTimes) : null;
      const measurementStartedAt = trial.measurementStart?.startedPerformanceAt;
      const dynamicLatency = Object.fromEntries((contentTrace.dynamicCohorts ?? []).map(cohort => [cohort.targetIds[0],
        Number.isFinite(cohort.insertedAt) && Number.isFinite(cohort.firstAcceptedAt) ? cohort.firstAcceptedAt - cohort.insertedAt : null]));
      trial.shadowDOM.timing = { clock: 'performance.now() in the fixture document', measurementStartedAt, initialAcceptedAt,
        measurementToInitialAcceptanceMs: Number.isFinite(measurementStartedAt) && Number.isFinite(initialAcceptedAt) ? initialAcceptedAt - measurementStartedAt : null,
        dynamicInsertionToAcceptedWriteMsById: dynamicLatency };
      if (!Number.isFinite(trial.shadowDOM.timing.measurementToInitialAcceptanceMs)
          || expectedIds.slice(3).some(id => !Number.isFinite(dynamicLatency[id]))) throw new Error('Shadow DOM acceptance timing evidence is incomplete.');
    }
    trial.timestamps.restoreCompleted = lifecycle.restoreCompletedAt;
    const restoredLifecycle = lifecycle.restored;
    const [workerTrace, contentObservation] = await Promise.all([
      evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.snapshot()'),
      evaluate(chrome, pageSession,
         `(()=>{const trace=window.__pageTranslationBenchmark;return {events:trace.events.map(event=>({...event})),discoveryFlags:trace.discoveryFlags,admissionHookInstalled:trace.admissionHookInstalled,discoveryAdmissionOrder:trace.discoveryAdmissionOrder,schedulerEnqueueOrder:trace.schedulerEnqueueOrder,selectedBatchMembers:trace.selectedBatchMembers,schedulerBatchSessions:trace.schedulerBatchSessions,logicalBatchIntervals:trace.logicalBatchIntervals,viewportWindowObservation:trace.viewportWindowObservation}})()`, contentContext),
    ]);
    const contentEvents = contentObservation.events;
    trial.contentObservation = contentObservation;
    trial.measurements.contentEvents = contentEvents;
    trial.measurements.worker = workerTrace;
    const calibratedLongTasks = validatedLongTaskObservation(trial.longTaskCalibration, contentTrace.longTasks);
    const verifiedContentTrace = { ...contentTrace, longTasks: calibratedLongTasks.entries, longTasksUnavailableReason: calibratedLongTasks.unavailableReason };
    trial.derivedTimings = deriveTimings(trial, workerTrace, verifiedContentTrace, contentEvents);
    if (fixtureConfig.scenario === 'shadow-dom') {
      const tasks = trial.derivedTimings.longTasks;
      const terminalAt = trial.terminal?.performanceAt;
      trial.shadowDOM.longTasks = {
        measurementToTerminal: longTasksWithinInterval(tasks, trial.measurementStart?.startedPerformanceAt, terminalAt),
        dynamicInsertionToAcceptedWriteById: Object.fromEntries((contentTrace.dynamicCohorts ?? []).map(cohort => [cohort.targetIds[0],
          longTasksWithinInterval(tasks, cohort.insertedAt, cohort.firstAcceptedAt)])),
        boundary: 'Calibrated captured PerformanceObserver tasks whose complete intervals are inside the listed performance.now() bounds.',
        unavailableReason: tasks === null ? calibratedLongTasks.unavailableReason : null,
      };
    }
    const providerAttempts = trial.requests.filter(request => request.category === 'provider-translation');
    trial.providerTranslationAttempts = providerAttempts.length;
    trial.providerBatchSizes = providerAttempts.map(request => request.batchSize);
    const originalsFromDom = trial.rawDOM.original;
    const translatedFromDom = trial.rawDOM.translated;
    const providerSources = successfulProviderAttempts
      .flatMap(request => request.batchTexts ?? []);
    const expectedIds = originalsFromDom.map(([id]) => id);
    const sourceToId = new Map(originals.map(([id, source]) => [source, id]));
    if (sourceToId.size !== originals.length) throw new Error('Fixture source texts are not unique; HTTP body-to-target order cannot be proven.');
    const admissionIds = contentObservation.discoveryAdmissionOrder;
    if (contentObservation.admissionHookInstalled !== true) throw new Error('Per-session primitive-admission instrumentation was not installed.');
    const enqueuedIds = contentObservation.schedulerEnqueueOrder;
    const acceptedIds = contentTrace.acceptedIds;
    const selectedBatchIds = Array.isArray(contentObservation.selectedBatchMembers)
      ? contentObservation.selectedBatchMembers.flatMap(batch => Array.isArray(batch) ? batch : null)
      : null;
    trial.discoveryAdmissionOrder = admissionIds ?? null;
    trial.admissionStage = 'filtered DOMTranslator primitive admission, before PageTranslationScheduler.enqueue';
    trial.schedulerEnqueueOrder = enqueuedIds;
    trial.selectedBatchMembers = contentObservation.selectedBatchMembers;
    trial.acceptedDomOrder = contentEvents.filter(event => event.name === 'dom.acceptedWrite').map(event => event.id);
    trial.duplicateAcceptedWriteIds = contentTrace.duplicateAcceptedIds ?? [];
    const partialFailedIds = [
      ...(custom400Protocol?.evidence.injected400[0]?.targetIds ?? []),
      ...(customCancellationProtocol?.held?.targetIds ?? []),
      ...(googleTimeoutProtocol?.held?.cancellation ? googleTimeoutProtocol.held.targetIds : []),
    ];
    const expectedAcceptedIds = customCancellationProtocol
      ? customCancellationProtocol.evidence.retainedAcceptedIds ?? customCancellationProtocol.initialIds
      : partialFailedIds.length
      ? expectedIds.filter(id => !partialFailedIds.includes(id)) : expectedIds;
    const orderValidation = customCancellationProtocol
      ? [enqueuedIds, admissionIds, selectedBatchIds].map((observed, index) => {
        const label = ['Scheduler enqueue', 'filtered primitive admission', 'selected scheduler batch'][index];
        const required = [...customCancellationProtocol.initialIds, ...(customCancellationProtocol.held?.targetIds ?? [])];
        const unknown = (observed ?? []).filter(id => !expectedIds.includes(id));
        const duplicates = (observed ?? []).filter((id, index, ids) => ids.indexOf(id) !== index);
        const missingRequired = required.filter(id => !(observed ?? []).includes(id));
        const issues = [];
        if (!Array.isArray(observed)) issues.push(`${label} evidence is unavailable`);
        if (unknown.length) issues.push(`${label} contains unknown target IDs: ${unknown.join(',')}`);
        if (duplicates.length) issues.push(`${label} contains duplicate target IDs: ${[...new Set(duplicates)].join(',')}`);
        if (missingRequired.length) issues.push(`${label} omitted initial/held target IDs: ${missingRequired.join(',')}`);
        return { ok: issues.length === 0, issues };
      }).concat(validateExactTargetIds('accepted DOM write', acceptedIds, expectedAcceptedIds))
      : [
        validateExactTargetIds('Scheduler enqueue', enqueuedIds, expectedIds),
        validateExactTargetIds('filtered primitive admission', admissionIds, expectedIds),
        validateExactTargetIds('accepted DOM write', acceptedIds, expectedAcceptedIds),
        validateExactTargetIds('selected scheduler batch', selectedBatchIds, expectedIds),
      ];
    const orderIssues = orderValidation.flatMap(validation => validation.issues);
    if (trial.duplicateAcceptedWriteIds.length) orderIssues.push(`duplicate accepted DOM writes: ${trial.duplicateAcceptedWriteIds.join(',')}`);
    if (orderIssues.length) throw new Error(orderIssues.join('; '));

    if (mode === 'viewport' && ['early-visible', 'in-window-visible', 'late-visible'].includes(fixtureConfig.scenario)) {
      const observation = contentObservation.viewportWindowObservation;
      if (!observation) throw new Error('Viewport-first mode did not capture the active discovery window before it was cleared.');
      if (observation.enumerationSteps !== 100 || observation.candidateCount > 100) {
        throw new Error(`Viewport window did not show the real 100-step boundary: steps=${observation.enumerationSteps}, candidates=${observation.candidateCount}`);
      }
      if (observation.windowCandidateIds.some(id => typeof id !== 'string')) throw new Error('Viewport window contains candidate IDs that are not fixture targets.');
      const expectedWindowVisibleIds = fixtureConfig.scenario === 'late-visible' ? [] : actualGeometry.visibleIds;
      if (JSON.stringify(observation.visibleCandidateIds) !== JSON.stringify(expectedWindowVisibleIds)) {
        throw new Error(`Viewport window visible membership differs from actual geometry: ${JSON.stringify(observation.visibleCandidateIds)}`);
      }
      trial.windowMembership = {
        ...validateWindowMembership({
          scenario: fixtureConfig.scenario,
          visibleIds: actualGeometry.visibleIds,
          windowCandidateIds: observation.windowCandidateIds,
          enumerationSteps: observation.enumerationSteps,
        }),
        observation,
      };
      if (!trial.windowMembership.ok) throw new Error(trial.windowMembership.issues.join('; '));
    } else {
      trial.windowMembership = { ok: null, reason: mode !== 'viewport' ? 'Viewport-first discovery disabled for this mode.' : 'Small fixture does not measure the large-page window boundary.' };
    }

    trial.providerRequestOrder = mapProviderBatchIds(providerAttempts.map(request => request.batchTexts ?? []), sourceToId);
    const canonicalSourceIds = mapProviderBatchIds(canonicalProviderSourceAttempts(providerAttempts
      .filter(request => !request.canonicalSourceExcluded))
      .map(request => request.batchTexts ?? []), sourceToId).flat();
    const providerOrderValidation = customCancellationProtocol
      ? { ok: true, issues: [], reason: 'Cancellation probe intentionally stops after its held post-initial band.' }
      : validateExactTargetIds('provider request source', canonicalSourceIds, expectedIds);
    if (!providerOrderValidation.ok) throw new Error(providerOrderValidation.issues.join('; '));
    trial.providerRequestOrderValidation = providerOrderValidation;
    trial.providerHTTPRequestSequence = mapProviderHTTPRequestSequence(providerAttempts, sourceToId, providerLane?.provider);
    if (providerLane) {
      trial.providerLogicalBatches = summarizeLogicalProviderBatches(contentObservation.logicalBatchIntervals, trial.sessionId);
      if (!trial.providerLogicalBatches.ok) throw new Error(trial.providerLogicalBatches.issues.join('; '));
      if (providerLane.provider === 'custom' && resilienceProbe === 'custom-429'
          && providerAttempts.length !== trial.providerLogicalBatches.logicalBatchCount + 1) {
        throw new Error(`Custom 429 probe must observe one extra physical retry: ${providerAttempts.length}/${trial.providerLogicalBatches.logicalBatchCount + 1}`);
      }
      if (providerLane.provider === 'custom' && resilienceProbe === 'custom-400'
          && providerAttempts.length !== trial.providerLogicalBatches.logicalBatchCount) {
        throw new Error(`Custom 400 probe must observe one physical request per logical batch: ${providerAttempts.length}/${trial.providerLogicalBatches.logicalBatchCount}`);
      }
      if (providerLane.provider === 'custom' && !resilienceProbe && providerAttempts.length !== trial.providerLogicalBatches.logicalBatchCount) {
        throw new Error(`Custom physical request count must equal logical batch count (no retries/recovery): ${providerAttempts.length}/${trial.providerLogicalBatches.logicalBatchCount}`);
      }
      trial.providerHTTPAttempts = providerAttempts.map(request => ({
        attemptId: request.physicalAttemptId ?? null, targetSessionId: request.targetSessionId,
        networkId: request.networkId ?? null, startedAt: request.physicalAttempt?.startedAt ?? null,
        settledAt: request.physicalAttempt?.settledAt ?? null, outcome: request.physicalAttempt?.outcome ?? null,
        status: request.physicalAttempt?.status ?? null, latencyMs: request.physicalAttempt?.latencyMs ?? null,
        sl: request.sourceLanguageQuery ?? null,
      }));
      trial.firstAcceptedTranslationAt = contentTrace.firstAcceptedAtById
        ? Math.min(...Object.values(contentTrace.firstAcceptedAtById).filter(Number.isFinite)) : null;
      trial.totalCompletionAt = trial.terminal?.receivedAt ?? null;
    }
    const failedTargetIdsForTrial = new Set(partialFailedIds);
    const failedTextsForTrial = new Set([
      ...(custom400Protocol?.evidence.injected400[0]?.texts ?? []),
      ...(customCancellationProtocol?.held?.texts ?? []),
      ...(googleTimeoutProtocol?.held?.texts ?? []),
    ]);
    const validationOriginals = failedTargetIdsForTrial.size
      ? originalsFromDom.filter(([id]) => !failedTargetIdsForTrial.has(id)) : originalsFromDom;
    const validationTranslated = failedTargetIdsForTrial.size
      ? translatedFromDom.filter(([id]) => !failedTargetIdsForTrial.has(id)) : translatedFromDom;
    const validationRestored = failedTargetIdsForTrial.size
      ? new Map([...new Map(restoredLifecycle.dom)].filter(([id]) => !failedTargetIdsForTrial.has(id)))
      : new Map(restoredLifecycle.dom);
    trial.validation = customCancellationProtocol ? {
      ok: JSON.stringify(restoredLifecycle.dom) === JSON.stringify(originals)
        && JSON.stringify(acceptedIds) === JSON.stringify(customCancellationProtocol.evidence.retainedAcceptedIds)
        && customCancellationProtocol.initialIds.every(id => acceptedIds.includes(id)),
      issues: [],
    } : validateTrialTranslation({
      originals: validationOriginals,
      translated: validationTranslated,
      requests: failedTargetIdsForTrial.size ? providerSources.filter(text => !failedTextsForTrial.has(text)) : providerSources,
      restored: validationRestored,
      expectedCount: validationOriginals.length,
      acceptedIds: failedTargetIdsForTrial.size ? acceptedIds.filter(id => !failedTargetIdsForTrial.has(id)) : acceptedIds,
      enqueuedIds: failedTargetIdsForTrial.size ? enqueuedIds.filter(id => !failedTargetIdsForTrial.has(id)) : enqueuedIds,
      admittedIds: failedTargetIdsForTrial.size ? admissionIds.filter(id => !failedTargetIdsForTrial.has(id)) : admissionIds,
    });
    if (failedTargetIdsForTrial.size && (
      JSON.stringify(restoredLifecycle.dom) !== JSON.stringify(originals)
      || failedTargetIdsForTrial.size !== 25
      || originalsFromDom.filter(([id]) => failedTargetIdsForTrial.has(id)).length !== 25
    )) throw new Error('Resilience failed targets were not preserved/restored exactly.');
    if (!trial.validation.ok) throw new Error(trial.validation.issues.length
      ? trial.validation.issues.join('; ') : 'Custom cancellation retained-write or complete Restore check failed.');
    const unexpectedExternal = trial.requests.find(request => request.category === 'blocked');
    if (unexpectedExternal) throw new Error(`Unexpected external request blocked: ${unexpectedExternal.url}`);
    if (!providerAttempts.length) throw new Error('No actual provider translation transport attempts were observed.');
    if (providerLane) await collectProviderRuntimeEvidence({
      trial, lane: providerLane,
      page: { chrome, pageSession, contentContext, evaluate },
      worker: { workerSession }, helpers: { until },
    });
    if (googleTimeoutProtocol) {
      const timeoutEvidence = await collectGoogleV2TimeoutEvidence({
        protocol: googleTimeoutProtocol, evidence: resilienceEvidence, evaluate, chrome, workerSession, pageSession,
        contentContext, sessionId, traceEvents, workerTrace, validateGoogleTimeoutQueueEvidence,
        providerPhysicalAttempts, summarizePhysicalProviderAttempts, providerNetworkEvents, providerAttempts,
        validateRuntimeResources, fixtureConfig, acceptedIds, originals, restoredDOM: restoredLifecycle.dom,
        acceptedDomOrder: trial.acceptedDomOrder, translated: trial.rawDOM.translated,
        duplicateAcceptedWriteIds: trial.duplicateAcceptedWriteIds, terminalReceivedAt: trial.terminal?.receivedAt,
        peakLogicalConcurrency: trial.providerLogicalBatches?.peakLogicalBatchConcurrency,
        effectiveProviderLimiterCapacity: trial.providerRuntimeObserved?.limiterCapacity,
      });
      trial.resilience = { ...resilienceEvidence, ...timeoutEvidence };
    }
    if (customCancellationProtocol) {
      const [pageScheduler, contentDrain, workerDrain, metadata] = await Promise.all([
        evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
        evaluate(chrome, pageSession,
          `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, contentContext, false),
        evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false),
        evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false),
      ]);
      const terminalMessageIds = (workerDrain?.providerRoots ?? [])
        .filter(root => root.sessionId === sessionId).map(root => root.messageId);
      const resources = await evaluate(chrome, workerSession,
        `globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(terminalMessageIds)}, [${JSON.stringify(sessionId)}])`, undefined, false);
      trial.resilience = collectCustomCancellationEvidence({
        protocol: customCancellationProtocol, evidence: resilienceEvidence, resources, pageScheduler, contentDrain, workerDrain, metadata,
        originals, restoredDOM: restoredLifecycle.dom, acceptedIds, acceptedDomOrder: trial.acceptedDomOrder,
        translated: trial.rawDOM.translated, duplicateAcceptedWriteIds: trial.duplicateAcceptedWriteIds,
        workerTrace, traceEvents, providerAttempts, providerNetworkEvents,
        providerPhysicalAccounting: trial.physicalProviderAccounting,
        providerLogicalBatches: trial.providerLogicalBatches, providerRuntimeObserved: trial.providerRuntimeObserved,
        pageWorkerLimit: trial.pageWorkerLimit, validateRuntimeResources,
      });
    }
    if (resilienceProbe && !googleTimeoutProtocol && !customCancellationProtocol) {
      const terminalMessageIds = resilienceProbe === 'custom-400'
        ? [custom400Protocol.evidence.injected400[0]?.logicalMessageId].filter(id => typeof id === 'string')
        : resilienceProbe === 'custom-429'
        ? ['A', 'B'].map(role => custom429Protocol.evidence.roles?.[role]?.messageId)
          .concat(custom429Protocol.evidence.pending?.messageId).filter(id => typeof id === 'string')
        : resilienceProbe === 'gemini-structured-recovery'
          ? resilienceEvidence.injectedMalformed.map(item => item.messageId).filter(Boolean) : [];
      resilienceEvidence.terminalMessageIds = terminalMessageIds;
      const [resources, pageScheduler] = await Promise.all([
        evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(terminalMessageIds)}, [${JSON.stringify(sessionId)}])`, undefined, false),
        evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
      ]);
      const logicalByTexts = new Map();
      for (const attempt of resilienceEvidence.attempts) {
        const key = JSON.stringify(attempt.texts);
        if (!logicalByTexts.has(key)) logicalByTexts.set(key, []);
        logicalByTexts.get(key).push(attempt);
      }
      for (const attempts of logicalByTexts.values()) {
        const failedAttemptId = (resilienceProbe === 'custom-400' ? custom400Protocol.evidence.injected400[0]
          : resilienceProbe === 'custom-429' ? resilienceEvidence.injected429[0]
          : resilienceProbe === 'gemini-structured-recovery' ? resilienceEvidence.injectedMalformed[0] : resilienceEvidence.injected503[0])?.attemptId;
        if (attempts.length > 1 && attempts.some(attempt => attempt.attemptId !== failedAttemptId
            && attempt.retryOf !== failedAttemptId)) {
          resilienceEvidence.unnecessaryRetransmits.push({ texts: attempts[0].texts, attempts });
        }
      }
        const failedIds = new Set((resilienceProbe === 'custom-400' ? custom400Protocol.evidence.injected400[0]
          : resilienceProbe === 'custom-429' ? resilienceEvidence.injected429[0]
          : resilienceProbe === 'gemini-structured-recovery' ? resilienceEvidence.injectedMalformed[0] : resilienceEvidence.injected503[0])?.targetIds ?? []);
      const failedAttemptId = (resilienceProbe === 'custom-400' ? custom400Protocol.evidence.injected400[0]
        : resilienceProbe === 'custom-429' ? resilienceEvidence.injected429[0]
        : resilienceProbe === 'gemini-structured-recovery' ? resilienceEvidence.injectedMalformed[0] : resilienceEvidence.injected503[0])?.attemptId;
      for (const attempt of resilienceEvidence.attempts) {
        if (attempt.attemptId === failedAttemptId || attempt.retryOf === failedAttemptId) continue;
        const overlap = attempt.targetIds?.filter(id => failedIds.has(id)) ?? [];
        if (overlap.length) resilienceEvidence.unnecessaryRetransmits.push({ texts: attempt.texts, targetIds: overlap, attemptId: attempt.attemptId });
      }
      const translated = trial.rawDOM.translated ?? [];
      const custom400FailedIds = resilienceProbe === 'custom-400' ? failedIds : new Set();
      const expectedTranslated = fixtureConfig.targets.filter(({ id }) => !custom400FailedIds.has(id))
        .map(({ id, source }) => [id, `\u200efixture translation: ${source}`]);
      const failed = resilienceProbe === 'custom-400' ? custom400Protocol.evidence.injected400[0]
        : resilienceProbe === 'custom-429' ? resilienceEvidence.injected429[0]
        : resilienceProbe === 'gemini-structured-recovery' ? resilienceEvidence.injectedMalformed[0] : resilienceEvidence.injected503[0];
       if (resilienceProbe === 'custom-429') collectCustom429Evidence({
         evidence: resilienceEvidence, protocol: custom429Protocol, failed, resources, workerTrace, providerAttempts,
         providerNetworkEvents, sessionId, providerPhysicalAttempts, traceEvents, summarizePhysicalProviderAttempts,
         validateQueueRetryEvidence, peakLogicalConcurrency: trial.providerLogicalBatches?.peakLogicalBatchConcurrency,
       });
 if (resilienceProbe === 'custom-400') collectCustom400Evidence({
   protocol: custom400Protocol, evidence: resilienceEvidence, providerAttempts, providerNetworkEvents,
   providerPhysicalAttempts, fixtureConfig, workerTrace, traceEvents, summarizePhysicalProviderAttempts,
   validateCustom400QueueEvidence, isCustom400ProbeWindowRequest,
   expectedLogicalBatchCount: trial.providerLogicalBatches?.logicalBatchCount,
   peakLogicalConcurrency: trial.providerLogicalBatches?.peakLogicalBatchConcurrency,
   effectiveProviderLimiterCapacity: trial.providerRuntimeObserved?.limiterCapacity,
 });
 if (resilienceProbe === 'gemini-structured-recovery') collectGeminiStructuredRecoveryEvidence({
   evidence: resilienceEvidence, failed, workerTrace, traceEvents, providerAttempts, providerNetworkEvents,
   sessionId, isMappedGeminiResponse, providerPhysicalAttempts, summarizePhysicalProviderAttempts,
   validateGeminiQueueAttemptEvidence, peakLogicalConcurrency: trial.providerLogicalBatches?.peakLogicalBatchConcurrency,
   effectiveProviderLimiterCapacity: trial.providerRuntimeObserved?.limiterCapacity,
 });
const resourceValidation = validateRuntimeResources(resources, { terminalMessageIds, sessionIds: [sessionId], final: true });
      const cleanupOk = resourceValidation.ok
        && pageScheduler?.managerTranslating === false
        && pageScheduler.activeFlushes === 0 && pageScheduler.queueIds?.length === 0
        && pageScheduler.pendingSettlementCount === 0 && pageScheduler.batchTimerActive === false
        && pageScheduler.completionTimerActive === false;
      const queueRetryEvidence = resilienceProbe === 'custom-429' || resilienceProbe === 'gemini-structured-recovery'
        ? resilienceEvidence.queueRetryEvidence ?? null
        : validateQueueRetryEvidence(traceEvents(workerTrace), {
          messageId: resilienceEvidence.injected503[0]?.logicalMessageId,
        });
      const successfulTranslations = custom400FailedIds.size
        ? translated.filter(([id]) => !custom400FailedIds.has(id)) : translated;
      trial.resilience = { ...resilienceEvidence, resources, pageScheduler, queueRetryEvidence, translation: {
        exact: JSON.stringify(successfulTranslations) === JSON.stringify(expectedTranslated),
        duplicates: translated.length - new Set(translated.map(([id]) => id)).size,
        targetCount: originals.length,
        sourceCount: providerSources.length,
        restoreExact: resilienceProbe === 'custom-400'
          ? JSON.stringify(restoredLifecycle.dom) === JSON.stringify(originals) && trial.scrollThrough.validation?.ok === true
          : trial.validation.ok && restoredLifecycle.dom.length === originals.length,
        terminal: !!trial.terminal?.receivedAt,
        sessionOwner: resilienceProbe === 'custom-429'
          ? trial.scrollThrough?.finalSchedulerState?.translationSessionId ?? null : sessionId,
        duplicateAcceptedIds: trial.duplicateAcceptedWriteIds ?? [],
        acceptedTargetCount: acceptedIds?.length ?? null,
        failedTargetCount: custom400FailedIds.size,
        failedSourcePreserved: custom400FailedIds.size === 0
          || JSON.stringify(custom400Protocol.evidence.failedTargetDOM?.observed)
            === JSON.stringify(custom400Protocol.evidence.failedTargetDOM?.expected),
        successfulTargetsAcceptedOnce: custom400FailedIds.size === 0
          || acceptedIds?.length === originals.length - custom400FailedIds.size
            && new Set(acceptedIds).size === acceptedIds.length,
        expectedTargetIds: expectedTranslated.map(([id]) => id), observed: translated,
      }, cleanup: { ok: cleanupOk, runtimeResources: resourceValidation } };
      if (custom429Protocol) trial.resilience.protocol = custom429Protocol.evidence;
       if (resilienceProbe === 'googlev2-503') finalizeGoogleV2_503Evidence(trial.resilience);
       trial.resilience.validation = resilienceProbe === 'googlev2-503'
          ? validateGoogleV2_503Evidence(trial.resilience) : validateResilienceAccounting(trial.resilience);
      if (resilienceProbe === 'custom-429') {
        trial.resilience.validation = validateCustom429ProbeEvidence({
          ...trial.resilience, injected429: resilienceEvidence.injected429,
          pendingLimiterSibling: resilienceEvidence.pendingLimiterSibling,
          cooldown: resilienceEvidence.cooldown, sibling: resilienceEvidence.sibling,
          prematurePhysicalStarts: resilienceEvidence.prematurePhysicalStarts,
          serverRetryAt: resilienceEvidence.serverRetryAt, limiterRetryAt: resilienceEvidence.limiterRetryAt,
          limiterRetryAtAfterSibling: resilienceEvidence.limiterRetryAtAfterSibling,
          pendingStillQueuedAfterSibling: resilienceEvidence.pendingStillQueuedAfterSibling,
          roles: resilienceEvidence.roles, concurrency: resilienceEvidence.concurrency,
        });
      }
      if (resilienceProbe === 'custom-400') {
        trial.resilience.validation = validateCustom400ProbeEvidence(trial.resilience);
      }
      if (resilienceProbe === 'gemini-structured-recovery') {
        trial.resilience.validation = validateGeminiStructuredRecoveryEvidence(trial.resilience);
      }
      if (!trial.resilience.validation.ok) throw new Error(trial.resilience.validation.issues.join('; '));
    }
    trial.status = 'passed';
  } catch (error) {
    trial.status = 'failed';
    if (resilienceEvidence) trial.resilience = { ...resilienceEvidence, ...trial.resilience,
      ...(googleTimeoutProtocol ? { timeoutProbe: {
        selectionFailures: googleTimeoutProtocol.selectionFailures,
        failedTargetDOM: googleTimeoutProtocol.failedTargetDOM ?? null,
        heldRequest: googleTimeoutProtocol.held ? {
          messageId: googleTimeoutProtocol.held.messageId, sessionId: googleTimeoutProtocol.held.pageSessionId,
          requestId: googleTimeoutProtocol.held.requestId, networkId: googleTimeoutProtocol.held.networkId,
          targetIds: googleTimeoutProtocol.held.targetIds, texts: googleTimeoutProtocol.held.texts,
          startedAt: googleTimeoutProtocol.held.startedAt,
          cancellation: googleTimeoutProtocol.held.cancellation ?? null,
          cancellationDiagnostics: googleTimeoutProtocol.held.cancellationDiagnostics ?? null,
          fetchRelease: googleTimeoutProtocol.held.fetchRelease ?? null,
          fetchReleaseClassification: googleTimeoutProtocol.held.fetchReleaseClassification ?? null,
        } : null,
      } } : {}),
       ...(custom429Protocol ? { protocol: custom429Protocol.evidence } : {}),
       ...(customCancellationProtocol ? { customCancellation: customCancellationProtocol.evidence } : {}),
       failureStage: trial.stage ?? null };
    trial.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (custom429Protocol) {
      await failCustomHeldFetches('trial-cleanup');
      for (const [role, state] of custom429Protocol.releaseStates) {
        if (state === 'fail-failed') trial.cleanupErrors.push(`Custom 429 ${role} held Fetch could not be failed: ${custom429Protocol.roles.get(role)?.requestRecord.releaseError ?? 'unknown release error'}`);
      }
    }
    trial.stage ??= 'cleanup';
    if (providerLane && chrome) {
      try {
        await until(() => providerPhysicalAttempts.every(attempt => {
          const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
          return network?.outcome === 'finished' || network?.outcome === 'failed';
        }) ? true : null, 5_000);
      } catch (error) {
        trial.cleanupErrors.push(`Provider Network observers did not drain: ${error.message}`);
      }
      const providerNetworkRecords = [...providerNetworkEvents.values()];
      trial.providerNetworkCorrelation = validateProviderNetworkCorrelation(
        trial.requests.filter(request => request.category === 'provider-translation'),
        providerNetworkRecords,
      );
      if (!trial.providerNetworkCorrelation.ok) {
        trial.cleanupErrors.push(...trial.providerNetworkCorrelation.issues);
        trial.status = 'failed';
      }
      for (const attempt of providerPhysicalAttempts) {
        const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
        if (network) Object.assign(attempt, {
          startedAt: network.startedAt, settledAt: network.settledAt ?? null,
          outcome: network.outcome ?? null, status: network.status ?? null, error: network.error ?? null,
        });
      }
      if (resilienceProbe === 'googlev2-503') finalizeGoogleV2_503Evidence(trial.resilience ?? resilienceEvidence);
       trial.physicalProviderAccounting = summarizePhysicalProviderAttempts(providerPhysicalAttempts, {
          expectedTimeoutAbortAttemptId: googleTimeoutProtocol?.held?.attemptId
            ?? customCancellationProtocol?.held?.requestRecord?.physicalAttempt?.attemptId ?? null,
        });
       const staleSuccessCancellationIds = staleSuccessProbe && providerLane?.provider === 'custom'
         ? [...new Set(trial.requests.filter(request => request.category === 'provider-translation'
           && request.lateCancelledAClassification?.ok === true
           && request.lateCancelledAClassification.classification !== 'fetch-release-command-acknowledged')
           .map(request => request.validatedCancellationAttemptId).filter(Boolean))]
         : [];
       if (staleSuccessCancellationIds.length) {
         trial.physicalProviderAccounting.expectedCancellationAttemptIds = staleSuccessCancellationIds;
         trial.physicalProviderAccounting.issues = trial.physicalProviderAccounting.issues.filter(issue =>
           !staleSuccessCancellationIds.some(attemptId => issue.startsWith(`provider attempt ${attemptId} lacks correlated response status`)
             || issue.startsWith(`provider attempt ${attemptId} failed:`)));
         trial.physicalProviderAccounting.ok = trial.physicalProviderAccounting.issues.length === 0;
       }
       if (customCancellationProtocol) {
         const cancelledAttemptIds = new Set((trial.resilience?.attempts ?? [])
           .filter(attempt => attempt.correlation?.physicalStatus === 'rejected'
             && attempt.correlation?.providerRootErrorType === 'USER_CANCELLED'
             && attempt.correlation?.controllerAborted === true)
           .map(attempt => attempt.attemptId));
         trial.physicalProviderAccounting.expectedCancellationAttemptIds = [...cancelledAttemptIds];
         trial.physicalProviderAccounting.issues = trial.physicalProviderAccounting.issues.filter(issue =>
           ![...cancelledAttemptIds].some(attemptId => issue.startsWith(`provider attempt ${attemptId} lacks correlated response status`)
             || issue.startsWith(`provider attempt ${attemptId} failed:`)));
         trial.physicalProviderAccounting.ok = trial.physicalProviderAccounting.issues.length === 0;
       }
      trial.physicalProviderAccounting.logicalBatchNote = 'Physical HTTP requests are distinct from scheduler logical batches and worker concurrency limits.';
      if (providerLane && isProviderWorkloadTrial({ networkGuardProbe, cancellationProbe, staleSuccessProbe, phase })) {
        trial.providerConcurrencyValidation = validateProviderConcurrencyObservations({
          provider: providerLane.provider, optimizationLevel: providerLane.optimizationLevel,
          targetCount: fixtureConfig.targetCount, logical: trial.providerLogicalBatches,
          physical: trial.physicalProviderAccounting,
          pageWorkerLimit: trial.pageWorkerLimit ?? trial.providerSchedulerObserved?.pageWorkerLimit,
          providerLimiterCapacity: trial.providerRuntimeObserved?.limiterCapacity,
        });
        if (!trial.providerConcurrencyValidation.ok) {
          trial.cleanupErrors.push(...trial.providerConcurrencyValidation.issues);
          trial.status = 'failed';
        }
      }
      trial.providerHTTPAttempts = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
        attemptId: request.physicalAttempt?.attemptId ?? null, targetSessionId: request.targetSessionId,
        networkId: request.networkId ?? null, startedAt: request.physicalAttempt?.startedAt ?? null,
        settledAt: request.physicalAttempt?.settledAt ?? null, outcome: request.physicalAttempt?.outcome ?? null,
        status: request.physicalAttempt?.status ?? null,
        latencyMs: Number.isFinite(request.physicalAttempt?.startedAt) && Number.isFinite(request.physicalAttempt?.settledAt)
          ? request.physicalAttempt.settledAt - request.physicalAttempt.startedAt : null,
        sl: request.sourceLanguageQuery ?? null,
      }));
      if (!trial.physicalProviderAccounting.ok) {
        trial.cleanupErrors.push(...trial.physicalProviderAccounting.issues);
        trial.status = 'failed';
      }
    }
    if (staleSuccessProbe && chrome && pageSession && contentContext) {
      staleContextDisposed = await cleanupStaleSuccessProbe({
        trial,
        page: { chrome, pageSession, contentContext, evaluate },
        helpers: { now, until, isSessionEvent },
        cleanup: { staleContextDisposed },
      });
    }
    if ((custom429Protocol || googleTimeoutProtocol || customCancellationProtocol) && !cancellationControl) {
      try {
        const requestCleanup = await closeNetworkRequestLifecycle({
          lifecycle: requestLifecycle, guardedSessions: requestGuardSessions(), chrome,
        });
        if (!cancellationControl) {
          try { await until(() => requestHandlerJobs.size === 0 ? true : null, 8_000); }
          catch (error) { trial.cleanupErrors.push(`Tracked Fetch request handlers did not drain before Chrome close: ${error.message}`); }
        }
        if (custom429Protocol) custom429Protocol.evidence.cleanup = { requestLifecycle: requestCleanup };
        if (googleTimeoutProtocol && trial.resilience) {
          const heldReservation = requestCleanup.reservations.find(item => item.requestId === googleTimeoutProtocol.held?.requestId);
          const handlersDrained = requestCleanup.ok && requestHandlerJobs.size === 0 && requestCleanup.handlerCount === 0
            && heldReservation?.handlerSettled === true && !trial.cleanupErrors.some(error => error.includes('Tracked Fetch request handlers did not drain'));
          trial.resilience.cleanup = {
            ...trial.resilience.cleanup, ok: trial.resilience.cleanup?.ok === true && handlersDrained,
            heldFetchSettled: !!heldReservation?.releaseOutcome,
            handlersDrained, handlerCount: requestCleanup.handlerCount,
            requestLifecycle: requestCleanup,
            heldFetch: heldReservation ?? null,
            resourceValidation: trial.resilience.cleanup?.resourceValidation ?? { ok: false, issues: ['final resource validation unavailable'] },
          };
          trial.resilience.requestLifecycleCleanup = requestCleanup;
          trial.resilience.validation = validateGoogleV2TimeoutEvidence(trial.resilience);
          if (!trial.resilience.validation.ok) {
            trial.status = 'failed';
            trial.error ??= { name: 'GoogleTimeoutProbeValidationError', message: trial.resilience.validation.issues.join('; ') };
          }
        }
        if (customCancellationProtocol && trial.resilience) {
          trial.resilience.concurrency = {
            peakPhysical: trial.physicalProviderAccounting?.peakPhysicalConcurrency ?? null,
            peakLogical: trial.providerLogicalBatches?.peakLogicalBatchConcurrency ?? null,
            providerLimiterCapacity: trial.providerRuntimeObserved?.limiterCapacity ?? null,
            pageWorkerLimit: trial.pageWorkerLimit ?? null,
          };
          const heldReservation = requestCleanup.reservations.find(item => item.requestId === customCancellationProtocol.held?.requestId);
          const handlersDrained = requestCleanup.ok && requestHandlerJobs.size === 0
            && requestCleanup.handlerCount === 0 && heldReservation?.handlerSettled === true;
          trial.resilience.cleanup = {
            ...trial.resilience.cleanup, ok: handlersDrained && trial.resilience.cleanup?.resourceValidation?.ok === true
              && trial.resilience.cleanup?.contentDrain?.pendingOperations === 0
              && trial.resilience.cleanup?.workerDrain?.ledger?.pending === 0
              && !trial.resilience.cleanup?.workerDrain?.providerRoots?.some(root => root.status === 'pending'),
             handlersDrained, handlerCount: requestCleanup.handlerCount,
             finalDrainAt: requestCleanup.drainInterval?.completedAt ?? null,
            requestLifecycle: requestCleanup, heldFetch: heldReservation ?? null,
          };
          trial.resilience.validation = validateCustomCancellationProbeEvidence(trial.resilience);
          if (!trial.resilience.validation.ok) {
            trial.status = 'failed';
            trial.error ??= { name: 'CustomCancellationProbeValidationError', message: trial.resilience.validation.issues.join('; ') };
          }
        }
        trial.cleanupErrors.push(...requestCleanup.errors.map(error =>
          `${googleTimeoutProtocol ? 'Google timeout' : customCancellationProtocol ? 'Custom cancellation' : 'Custom 429'} request cleanup: ${error}`));
      } catch (error) {
        if (custom429Protocol) custom429Protocol.evidence.cleanup = { requestLifecycle: { ok: false, errors: [error?.message ?? String(error)] } };
        if (googleTimeoutProtocol && trial.resilience) {
          trial.resilience.cleanup = { ...trial.resilience.cleanup, ok: false, heldFetchSettled: false, handlersDrained: false,
            requestLifecycle: { ok: false, errors: [error?.message ?? String(error)] } };
          trial.resilience.validation = validateGoogleV2TimeoutEvidence(trial.resilience);
        }
        if (customCancellationProtocol && trial.resilience) {
          trial.resilience.cleanup = { ...trial.resilience.cleanup, ok: false,
            requestLifecycle: { ok: false, errors: [error?.message ?? String(error)] } };
          trial.resilience.validation = validateCustomCancellationProbeEvidence(trial.resilience);
          trial.status = 'failed';
          trial.error ??= { name: 'CustomCancellationProbeValidationError', message: trial.resilience.validation.issues.join('; ') };
        }
        trial.cleanupErrors.push(`${googleTimeoutProtocol ? 'Google timeout' : customCancellationProtocol ? 'Custom cancellation' : 'Custom 429'} request cleanup failed: ${error?.message ?? String(error)}`);
      }
    }
    if (cancellationControl) {
      try {
        const requestCleanup = await closeNetworkRequestLifecycle({
          lifecycle: cancellationControl.requestLifecycle, guardedSessions: requestGuardSessions(), chrome,
        });
        const evidence = trial.cancellation ?? trial.staleSuccess;
        evidence.cleanup.requestLifecycle = requestCleanup;
        evidence.cleanup.heldFetches = requestCleanup.reservations;
        trial.cleanupErrors.push(...requestCleanup.errors.map(error => `Cancellation request cleanup: ${error}`));
        try { await until(() => requestHandlerJobs.size === 0 ? true : null, 8_000); }
        catch (error) { trial.cleanupErrors.push(`Tracked Fetch request callbacks did not drain before Chrome close: ${error.message}`); }
        if (staleSuccessProbe && !staleContextDisposed && chrome && workerSession && pageSession && contentContext) {
          try {
            const messageIdA = trial.staleSuccess.replyGate?.snapshot?.capturedMessage?.messageId ?? null;
            const messageIdB = trial.staleSuccess.bActiveAtARelease?.heldRequest?.batchMessageId ?? null;
            const terminalMessageIds = [messageIdA, messageIdB].filter(Boolean);
            const sessionIds = [trial.staleSuccess.sessionA, trial.staleSuccess.sessionB].filter(Boolean);
            if (trial.staleSuccess.rawMutationCaptureStarted && !messageIdA) {
              trial.cleanupErrors.push('A request ID is unavailable for final runtime resource drain.');
            }
            const [contentDrain, workerDrain, replyProbeSnapshot, runtimeDrain] = await until(async () => {
              const [content, worker, probe, resources] = await Promise.all([
                evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.cancellationSnapshot()', contentContext, false),
                evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false),
                evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false),
                evaluate(chrome, workerSession,
                  `globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(terminalMessageIds)},${JSON.stringify(sessionIds)})`, undefined, false),
              ]);
              const runtimeValidation = trial.staleSuccess.rawMutationCaptureStarted
                ? validateRuntimeResources(resources, { terminalMessageIds, sessionIds, final: true })
                : { ok: true, issues: [] };
              return content?.pendingOperations === 0 && worker?.ledger?.pending === 0
                && !worker?.providerRoots?.some(root => root.status === 'pending')
                && (!probe || (probe.wrappersRestored === true && (!probe.gate || probe.gate.pending === false)))
                && (!trial.staleSuccess.rawMutationCaptureStarted || runtimeValidation.ok)
                && requestHandlerJobs.size === 0
                ? [content, worker, probe, { resources, validation: runtimeValidation }] : null;
            }, 8_000);
            trial.staleSuccess.cleanup.promiseDrain = {
              content: contentDrain, worker: workerDrain, replyProbeSnapshot,
              gate: replyProbeSnapshot?.gate ?? null, runtime: runtimeDrain, ok: true,
            };
            if (replyProbeSnapshot?.gate && ['timed-out', 'failed'].includes(replyProbeSnapshot.gate.status)) {
              trial.cleanupErrors.push(`Successful reply gate ended in ${replyProbeSnapshot.gate.status}: ${replyProbeSnapshot.gate.error ?? 'no error detail'}`);
            }
            if (trial.staleSuccess.rawMutationCaptureStarted && !trial.staleSuccess.rawMutationEvidence) {
              const evidence = await evaluate(chrome, pageSession,
                'window.__pageTranslationBenchmark.finishSuccessfulReplyMutationCapture()', contentContext);
              const validation = validateRawDOMMutationEvidence({ evidence, targets: trial.fixture.targets, mode: staleSuccessProbe });
              trial.staleSuccess.rawMutationEvidence = evidence;
              trial.staleSuccess.rawMutationValidation = validation;
              trial.staleSuccess.rawMutationCaptureComplete = true;
              trial.staleSuccess.finalResourceDrain = runtimeDrain;
              if (!validation.ok) trial.cleanupErrors.push(`Stale-success teardown raw DOM evidence failed: ${validation.issues.join('; ')}`);
            } else {
              await evaluate(chrome, pageSession,
                'window.__pageTranslationBenchmark.closeSuccessfulReplyMutationObserver()', contentContext);
            }
          } catch (error) {
            trial.staleSuccess.cleanup.promiseDrain = { ok: false, error: error.message };
            trial.cleanupErrors.push(`Stale-success content/worker promises did not drain: ${error.message}`);
          }
        } else if (staleSuccessProbe && staleContextDisposed) {
          trial.cleanupErrors.push('Raw DOM/gate drain unavailable because the unsafe live context was disposed before gate release.');
        }
        const diagnostics = cancellationProbe
          ? promoteRequestDiagnostics(trial)
          : { ok: evidence.observationErrors.length === 0 && (trial.transportErrors?.length ?? 0) === 0,
            observationErrors: evidence.observationErrors, transportErrors: trial.transportErrors ?? [] };
        evidence.cleanup.diagnosticGate = diagnostics;
        if (!diagnostics.ok) trial.cleanupErrors.push('Stale-success request/transport diagnostics were incomplete.');
      } catch (error) {
        const message = `Cancellation request cleanup helper failed: ${error?.message ?? String(error)}`;
        (trial.cancellation ?? trial.staleSuccess).cleanup.requestLifecycle = { ok: false, errors: [message], closing: cancellationControl.requestLifecycle.closing };
        trial.cleanupErrors.push(message);
      }
      if (cancellationProbe && !trial.cancellation.restoreTerminal && trial.cancellation.sessionA && chrome && pageSession && contentContext) {
        try {
          const owner = trial.cancellation.sessionB ?? trial.cancellation.sessionA;
          const response = await evaluate(chrome, pageSession,
            `chrome.runtime.sendMessage(${JSON.stringify({ action: 'page-restore' })})`, contentContext);
          trial.cancellation.cleanup.restoreAttempt = { response, sessionId: owner };
          if (response?.success) {
            await until(async () => {
              const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
              const terminal = events.find(event => isSessionEvent(event, 'page-restore-complete', owner));
              return terminal ? (trial.cancellation.cleanup.restoreTerminal = terminal) : null;
            }, 10_000);
          }
        } catch (error) {
          trial.cleanupErrors.push(`Cancellation probe best-effort restore: ${error.message}`);
        }
      }
    }
    if (staleSuccessProbe && !staleContextDisposed && chrome && pageSession && contentContext
        && trial.staleSuccess.rawMutationCaptureStarted && !trial.staleSuccess.rawMutationEvidence) {
      try {
        const evidence = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.finishSuccessfulReplyMutationCapture()', contentContext);
        const validation = validateRawDOMMutationEvidence({ evidence, targets: trial.fixture.targets, mode: staleSuccessProbe });
        trial.staleSuccess.rawMutationEvidence = evidence;
        trial.staleSuccess.rawMutationValidation = validation;
        trial.cleanupErrors.push('Raw DOM observer stopped without proof that all content/worker continuations drained.');
        if (!validation.ok) trial.cleanupErrors.push(`Stale-success teardown raw DOM evidence failed: ${validation.issues.join('; ')}`);
      } catch (error) { trial.cleanupErrors.push(`Stale-success raw DOM evidence could not drain: ${error.message}`); }
    }
    if (soakScenario && chrome && workerSession && pageSession && contentContext && trial.sessionId) {
      try {
        const existingFetchLifecycle = trial.resilience?.cleanup?.requestLifecycle
          ?? trial.staleSuccess?.cleanup?.requestLifecycle
          ?? trial.cancellation?.cleanup?.requestLifecycle
          ?? null;
        if (!existingFetchLifecycle) {
          const requestCleanup = await closeNetworkRequestLifecycle({
            lifecycle: requestLifecycle, guardedSessions: requestGuardSessions(), chrome,
          });
          trial.soak.fetchLifecycle = requestCleanup;
          if (!requestCleanup.ok) trial.cleanupErrors.push(...requestCleanup.errors.map(error => `Soak Fetch cleanup: ${error}`));
        } else trial.soak.fetchLifecycle = existingFetchLifecycle;
        await until(() => requestHandlerJobs.size === 0 ? true : null, 8_000);
        const sessionIds = [...new Set([
          trial.sessionId,
          trial.staleSuccess?.sessionA,
          trial.staleSuccess?.sessionB,
        ].filter(id => typeof id === 'string' && id.length))];
        const [workerDrain, contentDrain, pageScheduler, logicalBatchIntervals, restoredDOMMetadata] = await Promise.all([
          evaluate(chrome, workerSession,
            'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false),
          evaluate(chrome, pageSession,
            'window.__pageTranslationBenchmark.cancellationSnapshot()', contentContext, false),
          evaluate(chrome, pageSession,
            'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
          evaluate(chrome, pageSession,
            'structuredClone(window.__pageTranslationBenchmark.logicalBatchIntervals)', contentContext, false),
          evaluate(chrome, pageSession,
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`,
            contentContext, false),
        ]);
        const sortMetadata = metadata => Array.isArray(metadata) ? metadata.map(item => ({
          ...item,
          attributes: [...(item.attributes ?? [])].sort(([a], [b]) => a.localeCompare(b)),
        })) : null;
        const failedBoundaryChecks = [];
        const metadataExact = JSON.stringify(sortMetadata(trial.soak.initialDOMMetadata))
          === JSON.stringify(sortMetadata(restoredDOMMetadata));
        if (!metadataExact) failedBoundaryChecks.push('Restore did not recover exact target metadata.');
        const terminalMessageIds = workerDrain.providerRoots
          .filter(root => sessionIds.includes(root.sessionId)).map(root => root.messageId).filter(Boolean);
        const resources = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(terminalMessageIds)},${JSON.stringify(sessionIds)})`,
          undefined, false);
        const validation = validateRuntimeResources(resources, {
          terminalMessageIds, sessionIds, final: true,
        });
        failedBoundaryChecks.push(...[
          contentDrain?.pendingOperations !== 0 && 'content promises remain active',
          workerDrain?.ledger?.pending !== 0 && 'worker ledger promises remain active',
          workerDrain?.providerRoots?.some(root => root.status === 'pending') && 'provider roots remain active',
          pageScheduler?.managerTranslating !== false && 'Page scheduler still reports an active translation',
          pageScheduler?.activeFlushes !== 0 && 'Page scheduler flushes remain active',
          pageScheduler?.queueIds?.length !== 0 && 'Page scheduler queue is not empty',
          pageScheduler?.pendingSettlementCount !== 0 && 'Page scheduler settlements remain pending',
          pageScheduler?.batchTimerActive !== false && 'Page scheduler batch timer remains active',
          pageScheduler?.completionTimerActive !== false && 'Page scheduler completion timer remains active',
          requestHandlerJobs.size !== 0 && 'Fetch handler promises remain active',
          !validation.ok && validation.issues.join('; '),
        ].filter(Boolean));
        const releaseEvidence = [];
        for (const sessionId of sessionIds) {
          releaseEvidence.push(await evaluate(chrome, workerSession,
            `globalThis.__pageTranslationBenchmark.releaseCancellationSession(${JSON.stringify(sessionId)})`, undefined, false));
        }
        const finalRetained = releaseEvidence.at(-1)?.retained;
        const retainedReferences = (finalRetained?.roots ?? 0) + (finalRetained?.controllers ?? 0)
          + (finalRetained?.abortObservers ?? 0);
        if (retainedReferences) failedBoundaryChecks.push(`settled instrumentation still retains ${retainedReferences} worker references`);
        const ownedBatches = Array.isArray(logicalBatchIntervals)
          ? logicalBatchIntervals.filter(batch => sessionIds.includes(batch.sessionId)) : [];
        const batchEvents = ownedBatches.flatMap(batch => [
          { at: batch.at, delta: 1 },
          { at: batch.settledAt, delta: -1 },
        ]).filter(event => Number.isFinite(event.at)).sort((a, b) => a.at - b.at || a.delta - b.delta);
        let activeBatches = 0;
        let peakLogicalConcurrency = 0;
        for (const event of batchEvents) {
          activeBatches += event.delta;
          peakLogicalConcurrency = Math.max(peakLogicalConcurrency, activeBatches);
        }
        if (ownedBatches.some(batch => !Number.isFinite(batch.settledAt) || !['fulfilled', 'rejected'].includes(batch.outcome))) {
          failedBoundaryChecks.push('one or more logical scheduler batches lack terminal intervals');
        }
        const count = value => Array.isArray(value) ? value.length : Number.isFinite(value) ? value : null;
        const sum = object => object && Object.values(object).every(Number.isFinite)
          ? Object.values(object).reduce((total, value) => total + value, 0) : null;
        const activeQueue = resources.queue
          ? sum(resources.queue.depths) + Object.values(resources.queue.processing ?? {}).filter(Boolean).length
            + (resources.queue.retryTimeoutCount ?? 0) : null;
        const activeRate = resources.rateLimit
          ? Object.values(resources.rateLimit).reduce((total, state) =>
            total + (state.activeRequests ?? 0) + (state.queuedRequests ?? 0) + (state.isProcessingQueue ? 1 : 0), 0) : null;
        const activeResolvers = resources.sourceResolvers
          ? Object.values(resources.sourceResolvers).filter(state => state?.present !== false).length : null;
        const activeScheduler = pageScheduler ? (pageScheduler.queueIds?.length ?? 0)
          + (pageScheduler.activeFlushes ?? 0) + (pageScheduler.pendingSettlementCount ?? 0)
          + Number(pageScheduler.managerTranslating === true)
          + Number(pageScheduler.batchTimerActive === true)
          + Number(pageScheduler.completionTimerActive === true) : null;
        const fetchReservations = cancellationControl?.requestLifecycle?.reservations ?? requestLifecycle.reservations;
        const activeFetchReservations = fetchReservations.filter(item => item.handlerSettled !== true
          || item.releaseRequested && item.releaseOutcome === null).length;
        const activePromises = (contentDrain?.pendingOperations ?? 0) + (workerDrain?.ledger?.pending ?? 0)
          + workerDrain.providerRoots.filter(root => root.status === 'pending').length;
        const activeLease = resources.lease
          ? (resources.lease.activeOperationCount ?? 0) + Number(resources.lease.timerActive === true) : null;
        const history = {
          roots: workerDrain.providerRoots.length,
          operations: workerDrain.ledger?.operations?.length ?? null,
          fetchReservations: fetchReservations.length,
          schedulerBatches: ownedBatches.length,
        };
        trial.soak = {
          ...trial.soak,
          sessionIds,
          workerDrain,
          contentDrain,
          pageScheduler,
          restoredDOMMetadata,
          metadataExact,
          runtimeResources: resources,
          resourceValidation: validation,
          logicalBatchIntervals: ownedBatches,
          logicalBatchCount: ownedBatches.length,
          peakLogicalConcurrency,
          instrumentationRetention: releaseEvidence,
          resourceSnapshot: {
            'QueueManager': { active: activeQueue, history: history.operations },
            'RateLimitManager': { active: activeRate, history: history.operations },
            'source resolver': { active: activeResolvers, history: sessionIds.length },
            'lifecycle registry': { active: count(resources.lifecycle?.activeIds), history: history.operations },
            'scheduler': { active: activeScheduler, history: history.schedulerBatches },
            'active promises': { active: activePromises, history: history.roots + history.operations },
            'Fetch reservations': { active: activeFetchReservations, history: history.fetchReservations },
            'handlers': { active: requestHandlerJobs.size, history: fetchReservations.length },
            'background operation leases': { active: activeLease, history: history.operations },
          },
        };
        if (failedBoundaryChecks.length) {
          trial.soak.cleanupError = failedBoundaryChecks.join('; ');
          trial.cleanupErrors.push(`Soak per-scenario resource drain failed: ${trial.soak.cleanupError}`);
        }
      } catch (error) {
        trial.soak.cleanupError = error.message;
        trial.cleanupErrors.push(`Soak per-scenario resource drain failed: ${error.message}`);
      }
    } else if (soakScenario) {
      const error = 'Soak per-scenario drain lacked the Chrome, worker, page, content, or Page session context.';
      trial.soak.cleanupError = error;
      trial.cleanupErrors.push(error);
    }
    const cleanups = [
       ...createNetworkCleanupSteps({
         requestUnsubscribe: browserLifetime ? null : requestUnsubscribe,
         eventUnsubscribe: browserLifetime ? null : eventUnsubscribe,
         pageEventUnsubscribe, subscriptionsBySession: networkEventUnsubscribes,
       }),
        async () => {
          if (browserLifetime && pageSession) {
            if (guardSessions.has(pageSession)) {
              await chrome.send('Fetch.disable', {}, pageSession);
              guardSessions.delete(pageSession);
            }
            await chrome.send('Target.detachFromTarget', { sessionId: pageSession });
         } else if (chrome) {
           await chrome.close();
           trial.chromeStderr = chrome.metadata.stderr ?? null;
         }
       },
      async () => {
        if (fixture?.server.listening) await new Promise((resolveClose, reject) => {
          fixture.server.close(error => error ? reject(error) : resolveClose());
          fixture.server.closeAllConnections?.();
        });
      },
    ];
    await cleanupMeasurementBeforeResources({
      state: measurementState,
      stopMeasurement: () => evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext),
      resources: cleanups,
      cleanupErrors: trial.cleanupErrors,
    });
    if (browserLifetime && browserLifetime.activeTrial === trial) {
      browserLifetime.requestListener = null;
      browserLifetime.activeNetworkObserver = null;
      browserLifetime.activeNetworkRouter = null;
      browserLifetime.activeTrial = null;
    }
    if (cancellationProbe) {
      const diagnostics = promoteRequestDiagnostics(trial);
      trial.cancellation.cleanup.finalDiagnosticGate = diagnostics;
    }
    trial.measurementLifecycle = { ...measurementState };
    if (trial.cleanupErrors.length) trial.status = 'failed';
    trial.timestamps.finishedAt = now();
    if (trial.derivedTimings) trial.derivedTimings.cleanup = trial.timestamps.finishedAt;
  }
  return trial;
}

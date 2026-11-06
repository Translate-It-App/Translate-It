import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { buildBenchmarkExtension } from './build.mjs';
import { launchChrome } from './chrome.mjs';
import { writeBenchmarkArtifact } from './artifact-writer.mjs';
import { classifyTransportRequest, mapEdgeResponse, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validatedLongTaskObservation, validateWindowMembership } from './metrics.mjs';
import { createFixture, startFixture, startupVoicesResponse } from './fixture.mjs';
import { cleanupMeasurementBeforeResources, completeTranslationMeasurement, summarizeAcceptanceTimes } from './measurement-lifecycle.mjs';
import { candidateModeOrder, mapProviderBatchIds, parseScenarioSelection, validateDiscoveryFlags, validateExactTargetIds, validateFixtureGeometry, validateSampleCount } from './scenario-plan.mjs';
import { classifyHeldFetchRelease, createCancellationRequestLifecycle, parseCancellationProbeSelection, promoteRequestDiagnostics, validateActiveReplacementCheckpoint, validateCancellationQuiescence, validateCancellationSetup, validateMatchedCancellation, validatePostInvalidationEvidence, validateReplacementOwnership, validateSingleHeldRequest } from './cancellation-probes.mjs';

const root = process.cwd();
const cancellationProbes = parseCancellationProbeSelection(process.env.BENCH_CANCELLATION_PROBES);
const requestedModes = [...new Set((process.env.BENCH_MODES ?? (cancellationProbes.length ? 'sliced' : 'legacy,sliced,viewport')).split(',').map(value => value.trim()).filter(Boolean))];
if (cancellationProbes.length && (requestedModes.length !== 1 || requestedModes[0] !== 'sliced')) {
  throw new TypeError('Cancellation probes require BENCH_MODES=sliced only.');
}
if (cancellationProbes.length && process.env.BENCH_SCENARIOS && process.env.BENCH_SCENARIOS !== 'early-visible') {
  throw new TypeError('Cancellation probes require BENCH_SCENARIOS=early-visible.');
}
const modes = cancellationProbes.length ? ['sliced'] : ['legacy', ...requestedModes.filter(mode => mode !== 'legacy')];
const scenarios = cancellationProbes.length ? ['early-visible'] : parseScenarioSelection(process.env.BENCH_SCENARIOS ?? 'small');
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
const warmups = Number(process.env.BENCH_WARMUPS ?? 1);
const defaultArtifact = `/tmp/opencode/page-translation-e2e-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.json`;
const artifactPath = resolve(process.env.BENCH_OUTPUT ?? defaultArtifact);
const sourcePaths = [
  'src/core/background/index.js',
  'src/core/content-scripts/index-main.js',
  'src/features/page-translation/PageTranslationManager.js',
  'src/features/page-translation/PageTranslationScheduler.js',
  'src/features/page-translation/PageTranslationBridge.js',
  'src/features/page-translation/PageTranslationConstants.js',
  'src/features/translation/providers/MicrosoftEdgeProvider.js',
  'src/core/services/translation/UnifiedTranslationService.js',
  'scripts/dev/page-translation-e2e-benchmark/run.mjs',
  'scripts/dev/page-translation-e2e-benchmark/fixture.mjs',
  'scripts/dev/page-translation-e2e-benchmark/metrics.mjs',
  'scripts/dev/page-translation-e2e-benchmark/build.mjs',
  'scripts/dev/page-translation-e2e-benchmark/chrome.mjs',
  'scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs',
  'scripts/dev/page-translation-e2e-benchmark/content-entry.mjs',
  'scripts/dev/page-translation-e2e-benchmark/trace.mjs',
  'scripts/dev/page-translation-e2e-benchmark/measurement-lifecycle.mjs',
  'scripts/dev/page-translation-e2e-benchmark/artifact-writer.mjs',
  'scripts/dev/page-translation-e2e-benchmark/scenario-plan.mjs',
  'scripts/dev/page-translation-e2e-benchmark/cancellation-probes.mjs',
  'scripts/dev/page-translation-e2e-runtime.test.js',
  'scripts/dev/page-translation-e2e-measurement.test.js',
  'scripts/dev/page-translation-e2e-large-page.test.js',
  'scripts/dev/page-translation-e2e-artifact-writer.test.js',
  'scripts/dev/page-translation-e2e-cancellation.test.js',
];
const settings = Object.freeze({
  WHOLE_PAGE_LAZY_LOADING: false,
  WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: false,
  WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false,
  PROXY_ENABLED: false,
});

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
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
async function hashFile(path) { return createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'); }
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
  const acceptance = summarizeAcceptanceTimes(contentTrace?.firstAcceptedAtById, trial.fixture.visibleIds, trial.fixture.targets.map(target => target.id));
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
    acceptance,
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
function measureMode(runs) {
  const intervals = (start, end) => summarizeIntervals(runs.map(start), runs.map(end));
  const times = {
    commandToFirstVisibleWrite: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.firstVisibleAcceptedWrite),
    commandToVisibleCompletion: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.visibleSetCompletion),
    commandToAllWrites: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.allAcceptedWrites),
    commandToCompletion: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.completion),
    commandToDiscoveryDrain: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.discoveryDrained),
    commandToFirstFlush: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.firstSchedulerFlush),
    commandToBatchEntry: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.schedulerRequestEntry),
    commandToBackgroundAdmission: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.backgroundAdmission),
    restoreDuration: intervals(run => run.derivedTimings?.restoreStart, run => run.derivedTimings?.restoreEnd),
  };
  const taskEntries = runs.map(run => run.derivedTimings?.longTasks);
  const longTaskSummary = taskEntries.some(entries => entries === null || entries === undefined)
    ? { ...summarizeLongTasks(null), unavailableReason: 'One or more trials lacked calibrated long-task observations.' }
    : { ...summarizeLongTasks(taskEntries.flat()), unavailableReason: null };
  return {
    n: runs.length,
    times,
    providerAttemptCounts: runs.map(run => run.providerTranslationAttempts),
    providerBatchSizes: runs.map(run => run.providerBatchSizes),
    startupMetadataFixtureCount: runs.map(run => run.requests.filter(request => request.category === 'startup-metadata-fixture').length),
    longTaskSamples: runs.map(run => run.derivedTimings?.longTasks ?? null),
    longTaskSummary,
    longTaskCalibration: runs.map(run => run.longTaskCalibration ?? { supported: false, reason: 'calibration was not run' }),
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

const harness = {
  command: 'node scripts/dev/page-translation-e2e-benchmark/run.mjs',
  artifactPath,
  provenance: {},
  settings,
  scenarios: scenarios.map(scenario => {
    const fixture = createFixture(scenario);
    return { scenario, targetCount: fixture.targetCount, visibleIds: fixture.visibleIds, viewport: fixture.viewport, scroll: fixture.scroll, responseDelayMs: fixture.responseDelayMs };
  }),
  fixtureWarmupSemantics: 'Each trial starts a fresh Chrome process/profile; warmups are discarded cold-profile runs, not persistent-process/JIT warmups.',
  requestedModes: modes,
  warmups,
  measuredSamples: samples,
  startedAt: now(),
  builds: [],
  results: [],
  cleanupErrors: [],
  nonPerformanceProbes: {
    cancellationStaleResponse: {
      status: 'not-run',
      reason: 'Not implemented in this bounded pass; it needs a separate held-Fetch cancellation trial. No cancellation stale-write claim is made.',
    },
    ...(cancellationProbes.length ? { cancellation: { requested: cancellationProbes, cases: [] } } : {}),
  },
  networkGuardScope: 'Fetch request-stage guard is installed before the test extension service worker resumes and before the top-level fixture page navigates. It covers that worker and the page target, including its isolated content world; iframe targets and Chrome process/component-extension telemetry are outside the measured scope.',
  limitations: {
    runtimeMessageHandoff: 'Not observed with a transparent runtime.sendMessage call-through; scheduler request entry and background admission remain separately timestamped.',
    performanceScope: 'Small fixture is 12 static targets. Large fixtures use a four-target visible window with three DOM/visual orders; results remain exploratory. The 800ms initial batch timer and 1000-item queue emergency bound can mask priority benefits.',
    heapLeak: 'Not measured; no heap-leak claim.',
  },
  status: 'running',
};
let primaryError;
const buildDirs = [];

async function writeArtifact() {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeBenchmarkArtifact(artifactPath, harness);
}

async function compileMode(mode) {
  const outputDir = await mkdtemp(resolve(tmpdir(), `page-translation-${mode}-`));
  buildDirs.push(outputDir);
  const built = { mode, outputDir, startedAt: now() };
  try {
    const result = await buildBenchmarkExtension({
      outputDir,
      mode,
      workerEntry: resolve(root, 'scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs'),
      contentEntry: resolve(root, 'scripts/dev/page-translation-e2e-benchmark/content-entry.mjs'),
    });
    built.outputDir = result;
    built.status = 'passed';
  } catch (error) {
    built.status = 'failed';
    built.error = error.message;
    throw error;
  } finally {
    built.completedAt = now();
    harness.builds.push(built);
  }
  return built.outputDir;
}

async function runTrial({ mode, scenario, ordinal, globalRunOrder, phase, extensionPath, fixtureConfig = createFixture(scenario), networkGuardProbe = false, cancellationProbe = null }) {
  const trial = {
    mode, scenario: fixtureConfig.scenario, ordinal, globalRunOrder, phase, status: 'running',
    timestamps: { trialStart: now() },
    contexts: [], workerReadiness: [], contentReadiness: [], commands: [], lifecycle: [],
    console: [], exceptions: [], requests: [], rawDOM: {}, cleanupErrors: [],
    fixture: {
      scenario: fixtureConfig.scenario,
      targetCount: fixtureConfig.targetCount,
      targets: fixtureConfig.targets,
      targetTexts: fixtureConfig.targetTexts,
      visibleIds: fixtureConfig.visibleIds,
      viewport: fixtureConfig.viewport,
      scroll: fixtureConfig.scroll,
      responseDelayMs: fixtureConfig.responseDelayMs,
    },
    settings,
  };
  let chrome;
  let fixture;
  let workerSession;
  let pageSession;
  let contentContext;
  const measurementState = { attempted: false, started: false, stopped: false, stopAttempts: 0 };
  const guardSessions = new Set();
  const sendBySession = new Map();
  const extensionOriginBySession = new Map();
  let requestUnsubscribe;
  let eventUnsubscribe;
  let pageEventUnsubscribe;
  let networkEventUnsubscribe;
  const requestHandlerJobs = new Set();
  const cancellationControl = cancellationProbe ? {
    probe: cancellationProbe,
    requestCountsBySession: new Map(),
    firstBatchBySession: new Map(),
    sessionIds: new Set(),
    releaseAllA: false,
    replacementSessionId: null,
    releaseReplacement: false,
    heldRequests: [],
    requestLifecycle: createCancellationRequestLifecycle(async (reservation, action, detail) => {
      const send = sendBySession.get(reservation.sessionId);
      if (!send) throw new Error(`No CDP session remains for held Fetch ${reservation.requestId}.`);
      if (action === 'continue') {
        await send('Fetch.continueRequest', { requestId: reservation.requestId }, reservation.sessionId);
        reservation.requestRecord.response = { continued: true, endedAt: now(), releasedDuringCleanup: detail?.reason === 'teardown' };
      } else if (action === 'fail') {
        await send('Fetch.failRequest', { requestId: reservation.requestId, errorReason: detail?.errorReason ?? 'Aborted' }, reservation.sessionId);
      } else if (action === 'fulfill') {
        const bodyString = JSON.stringify(detail?.body);
        await send('Fetch.fulfillRequest', {
          requestId: reservation.requestId, responseCode: detail?.responseCode ?? 200,
          responseHeaders: detail?.responseHeaders ?? [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(bodyString).toString('base64'),
        }, reservation.sessionId);
        reservation.requestRecord.response = { status: detail?.responseCode ?? 200, body: detail?.body, endedAt: now(), releasedAfterPause: reservation.held };
      } else {
        throw new TypeError(`Unsupported Fetch release action: ${action}`);
      }
      return { ok: true, action, requestId: reservation.requestId };
    }),
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

  const processRequestPaused = async (event, requestRecord, reservation) => {
    const { request, requestId } = event.params;
    const classification = classifyTransportRequest(request, {
      fixtureOrigin: new URL(trial.fixture.url).origin,
      extensionOrigin: extensionOriginBySession.get(event.sessionId),
    });
    const send = sendBySession.get(event.sessionId);
    requestRecord.category = classification.kind;
    try {
      if (classification.kind === 'provider-translation') {
        const body = JSON.parse(request.postData ?? 'null');
        const responseBody = mapEdgeResponse(body);
        requestRecord.bodyLength = request.postData?.length ?? 0;
        requestRecord.bodyBytes = Buffer.byteLength(request.postData ?? '', 'utf8');
        requestRecord.batchSize = body.length;
        requestRecord.batchTexts = body;
        requestRecord.fixtureDelayMs = fixtureConfig.responseDelayMs;
        if (cancellationProbe) {
          const workerState = await evaluate(chrome, event.sessionId,
            'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
          const matchingRoots = workerState?.providerRoots?.filter(candidate => sameProviderTexts(candidate.texts, body)) ?? [];
          const activeRoots = matchingRoots.filter(candidate => candidate.status === 'pending' && candidate.controllerAborted === false);
          const roots = activeRoots.length ? activeRoots : matchingRoots;
          const physical = workerState?.ledger?.operations?.filter(operation => operation.kind === 'provider.physical'
            && sameProviderTexts(JSON.parse(operation.requestBody ?? 'null'), body)) ?? [];
          const root = roots.length === 1 ? roots[0] : null;
          const physicalCall = root && physical.find(operation => operation.messageId === root.messageId && operation.sessionId === root.sessionId);
          const controller = root && workerState.controllers?.find(candidate => candidate.messageId === root.messageId && candidate.sessionId === root.sessionId);
          const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
          requestRecord.networkId = event.params.networkId ?? null;
          requestRecord.cancellationCorrelation = root && physicalCall && controller ? {
            pageSessionId: root.sessionId,
            batchMessageId: root.messageId,
            providerRootStatus: root.status,
            physicalOperationStatus: physicalCall.status,
            controllerAborted: controller.aborted,
            targetIds,
            requestId,
            networkId: requestRecord.networkId,
          } : null;
          const issues = [];
          if (roots.length !== 1) issues.push(`provider root match count ${roots.length}`);
          if (!physicalCall) issues.push('physical provider operation not correlated to request body/controller');
          if (!controller) issues.push('lifecycle controller not correlated to provider root');
          if (targetIds.some(id => id === null)) issues.push('provider request body includes unknown fixture source');
          requestRecord.cancellationCorrelationIssues = issues;
          if (issues.length) trial.cancellation.observationErrors.push({ requestId, issues });

          if (root && cancellationControl) {
            const sessionId = root.sessionId;
            const ordinal = cancellationControl.requestCountsBySession.get(sessionId) ?? 0;
            cancellationControl.requestCountsBySession.set(sessionId, ordinal + 1);
            const firstBatch = cancellationControl.firstBatchBySession.get(sessionId);
            if (ordinal === 0) cancellationControl.firstBatchBySession.set(sessionId, { messageId: root.messageId, targetIds, texts: body });
            const isInitialSession = sessionId === cancellationControl.initialSessionId
              || (!cancellationControl.initialSessionId && !cancellationControl.replacementSessionId);
            const shouldHold = isInitialSession
              ? ordinal > 0 && !cancellationControl.releaseAllA
              : cancellationControl.probe === 'replacement' && sessionId !== cancellationControl.initialSessionId
                && ordinal === 0 && !cancellationControl.releaseReplacement;
            if (shouldHold && (!firstBatch || targetIds.some(id => !firstBatch.targetIds.includes(id)))
                && reservation?.hold()) {
              if (!reservation) throw new Error('Cancellation Fetch reservation was not created at request-handler entry.');
              const held = {
                requestId, networkId: requestRecord.networkId, sessionId: event.sessionId,
                pageSessionId: sessionId, batchMessageId: root.messageId, targetIds,
                providerRootStatusAtPause: root.status, controllerAbortedAtPause: controller?.aborted ?? null,
                released: false, handlerSettled: false,
              };
              const heldControl = { ...held, reservation, record: held };
              requestRecord.paused = true;
              requestRecord.heldFetch = held;
              cancellationControl.heldRequests.push(heldControl);
              trial.cancellation.pausedRequests.push(held);
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
                const bodyString = JSON.stringify(responseBody);
                await send('Fetch.fulfillRequest', {
                  requestId, responseCode: 200,
                  responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                  body: Buffer.from(bodyString).toString('base64'),
                }, event.sessionId);
                requestRecord.response = { status: 200, body: responseBody, endedAt: now() };
              }
            }
          } else {
            await wait(fixtureConfig.responseDelayMs);
            if (reservation) await reservation.release('fulfill', { body: responseBody, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
            else {
              const bodyString = JSON.stringify(responseBody);
              await send('Fetch.fulfillRequest', {
                requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                body: Buffer.from(bodyString).toString('base64'),
              }, event.sessionId);
              requestRecord.response = { status: 200, body: responseBody, endedAt: now() };
            }
          }
        } else {
          await wait(fixtureConfig.responseDelayMs);
        const bodyString = JSON.stringify(responseBody);
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(bodyString).toString('base64'),
        }, event.sessionId);
        requestRecord.response = { status: 200, body: responseBody, endedAt: now() };
        }
      } else if (classification.kind === 'startup-metadata-fixture') {
        if (reservation) await reservation.release('fulfill', { body: startupVoicesResponse, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
        else {
          await send('Fetch.fulfillRequest', {
            requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify(startupVoicesResponse)).toString('base64'),
          }, event.sessionId);
          requestRecord.response = { status: 200, body: startupVoicesResponse, endedAt: now() };
        }
      } else if (classification.kind === 'local') {
        if (reservation) await reservation.release('continue');
        else {
          await send('Fetch.continueRequest', { requestId }, event.sessionId);
          requestRecord.response = { continued: true, endedAt: now() };
        }
      } else if (classification.kind === 'invalid-extension-placeholder') {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        trial.nonHttpBlockedRequests ??= [];
        trial.nonHttpBlockedRequests.push(requestRecord);
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient' });
        else await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      } else {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient' });
        else await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      }
    } catch (error) {
      requestRecord.blocked = true;
      requestRecord.error ??= error.message;
      trial.transportErrors ??= [];
      trial.transportErrors.push(error.message);
      if (!requestRecord.response) {
        if (reservation) await reservation.release('fail', { errorReason: 'BlockedByClient', reason: 'request-handler-error' });
        else await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId).catch(() => {});
      }
    } finally {
      requestRecord.endedAt = now();
      if (requestRecord.heldFetch) requestRecord.heldFetch.handlerSettled = true;
      if (reservation && !reservation.releaseRequested) {
        requestRecord.unreleasedFetch = true;
      }
    }
  };

  const requestListener = event => {
    if (event.method !== 'Fetch.requestPaused' || !guardSessions.has(event.sessionId)) return;
    const { request, requestId } = event.params;
    const requestRecord = {
      startedAt: now(), url: request.url, method: request.method,
      postData: request.postData ?? null,
      initiator: request.initiator ?? null,
    };
    trial.requests.push(requestRecord);
    const reservation = cancellationControl?.requestLifecycle.reserve({
      requestId,
      sessionId: event.sessionId,
      networkId: event.params.networkId ?? null,
      requestRecord,
    }) ?? null;
    const job = processRequestPaused(event, requestRecord, reservation);
    if (reservation) {
      const trackedJob = cancellationControl.requestLifecycle.trackHandler(reservation, job);
      requestHandlerJobs.add(trackedJob);
      trackedJob.then(
        () => requestHandlerJobs.delete(trackedJob),
        error => {
          requestHandlerJobs.delete(trackedJob);
          trial.transportErrors ??= [];
          trial.transportErrors.push(error?.message ?? String(error));
        },
      );
      return trackedJob;
    }
    return job;
  };

  try {
    fixture = await startFixture(fixtureConfig);
    trial.fixture.url = fixture.url;
    trial.stage = 'chrome-launch';
    chrome = await launchChrome({
      extensionPath,
      onAttachedTarget: async ({ targetInfo, sessionId, send, onEvent }) => {
        if (targetInfo.type !== 'service_worker' || !targetInfo.url.startsWith('chrome-extension://')) return;
        const workerUrl = new URL(targetInfo.url);
        const extensionOrigin = workerUrl.protocol === 'chrome-extension:' ? `chrome-extension://${workerUrl.host}` : null;
        guardSessions.add(sessionId);
        sendBySession.set(sessionId, send);
        extensionOriginBySession.set(sessionId, extensionOrigin);
        if (!eventUnsubscribe) eventUnsubscribe = onEvent(event => recordEvent(event, trial));
        if (!requestUnsubscribe) requestUnsubscribe = onEvent(requestListener);
        if (cancellationProbe) {
          if (!networkEventUnsubscribe) networkEventUnsubscribe = onEvent(event => {
            if (event.sessionId !== sessionId || !event.method?.startsWith('Network.')) return;
            if (event.method === 'Network.requestWillBeSent' || event.method === 'Network.loadingFailed' || event.method === 'Network.loadingFinished') {
              trial.cancellation.networkEvents.push({ sequence: trial.cancellation.networkEvents.length + 1, method: event.method, params: event.params });
            }
          });
          await send('Network.enable', {}, sessionId);
        }
        await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
        trial.workerTargets ??= [];
        trial.workerTargets.push(targetInfo);
      },
    });
    trial.browser = chrome.metadata;
    const testExtensionOrigin = `chrome-extension://${chrome.extensionId}`;
    workerSession = [...extensionOriginBySession.entries()].find(([, origin]) => origin === testExtensionOrigin)?.[0];
    if (!workerSession) throw new Error('No pre-guarded test-extension service-worker session was recorded.');
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
    await evaluate(chrome, workerSession,
      `Promise.all([browser.storage.local.set(${JSON.stringify(settings)}),browser.storage.sync.set(${JSON.stringify(settings)}).catch(()=>{})])`);
    if (cancellationProbe) {
      trial.cancellation.workerInstrumentation = await evaluate(chrome, workerSession,
        'globalThis.__pageTranslationBenchmark.enableCancellationProbe()');
      if (!trial.cancellation.workerInstrumentation?.enabled || !trial.cancellation.workerInstrumentation?.lifecycleRegistryObserved
          || trial.cancellation.workerInstrumentation.instrumentationErrors?.length) {
        throw new Error('Worker cancellation/provider/controller instrumentation was not fully installed.');
      }
    }

    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: pageSession } = await chrome.send('Target.attachToTarget', { targetId, flatten: true }));
    pageEventUnsubscribe = chrome.onEvent(event => recordEvent(event, trial));
    guardSessions.add(pageSession);
    sendBySession.set(pageSession, chrome.send);
    extensionOriginBySession.set(pageSession, testExtensionOrigin);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, pageSession);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: fixtureConfig.viewport.width,
      height: fixtureConfig.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, pageSession);
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
    await chrome.send('Page.enable', {}, pageSession);
    await chrome.send('Page.navigate', { url: fixture.url }, pageSession);
    contentContext = await contentContextPromise;
    if (networkGuardProbe) {
      trial.stage = 'negative-network-guard-probe';
      await until(() => evaluate(chrome, pageSession,
        'Boolean(window.__pageTranslationBenchmark?.entry)', contentContext, false).catch(() => false));
      const probeResults = [];
      for (const [world, contextId] of [['page-main-world', undefined], ['extension-isolated-world', contentContext]]) {
        const url = `https://unexpected-${process.pid}-${now()}-${world}.example.test/blocked`;
        const fetch = await evaluate(chrome, pageSession,
          `fetch(${JSON.stringify(url)}, { cache: 'no-store' }).then(()=>({resolved:true}),error=>({resolved:false,name:error.name,message:error.message}))`,
          contextId, true);
        const request = await until(async () => trial.requests.find(candidate => candidate.url === url));
        probeResults.push({ world, url, fetch, request, passed: request.blocked === true && request.category === 'blocked' && fetch.resolved === false });
      }
      trial.networkGuardProbe = probeResults;
      if (probeResults.length !== 2 || probeResults.some(result => !result.passed)) throw new Error('Negative network probe failed to prove blocked page and content-world fetches.');
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
    if (cancellationProbe) {
      trial.cancellation.contentInstrumentation = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.enableCancellationProbe()', contentContext);
      if (!trial.cancellation.contentInstrumentation?.enabled || !trial.cancellation.contentInstrumentation?.sendMessageWrapped
          || trial.cancellation.contentInstrumentation.instrumentationErrors?.length) {
        throw new Error(`Content cancellation instrumentation incomplete: ${JSON.stringify(trial.cancellation.contentInstrumentation)}`);
      }
    }

    trial.discoveryFlagsObserved = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.discoveryFlags', contentContext, false);
    trial.discoveryFlagsValidation = validateDiscoveryFlags(mode, trial.discoveryFlagsObserved);
    if (!trial.discoveryFlagsValidation.ok) throw new Error(trial.discoveryFlagsValidation.issues.join('; '));

    trial.scrollState = await evaluate(chrome, pageSession,
      `(()=>{window.scrollTo(${fixtureConfig.scroll.x},${fixtureConfig.scroll.y});return {x:window.scrollX,y:window.scrollY}})()`, undefined, false);
    const actualGeometry = await evaluate(chrome, pageSession,
      `(()=>{const targets=[...document.querySelectorAll('[data-bench-id]')];const visible=targets.filter(element=>{const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth}).map(element=>element.dataset.benchId);return {targetCount:targets.length,visibleIds:visible,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}}})()`, undefined, false);
    trial.actualGeometry = actualGeometry;
    trial.fixtureGeometryValidation = validateFixtureGeometry(fixtureConfig, actualGeometry);
    if (!trial.fixtureGeometryValidation.ok) throw new Error(trial.fixtureGeometryValidation.issues.join('; '));
    const originals = fixtureConfig.targets.map(target => [target.id, target.source]);
    const originalById = new Map(originals);
    trial.rawDOM.original = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext);
    if (trial.rawDOM.original.length !== fixtureConfig.targetCount
        || JSON.stringify(trial.rawDOM.original) !== JSON.stringify(originals)) {
      throw new Error(`Pre-translation fixture DOM does not exactly match ${fixtureConfig.targetCount} source targets.`);
    }
    trial.longTaskCalibration = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.calibrateLongTasks?.()??{supported:false,reason:"trace writer calibration unavailable"}', contentContext);
    await wait(50);
    trial.traceAvailable = await evaluate(chrome, pageSession,
      `typeof window.__pageTranslationBenchmark?.startMeasurement==='function'&&typeof window.__pageTranslationBenchmark?.stopMeasurement==='function'`, contentContext);
    if (!trial.traceAvailable) throw new Error('Measurement trace writer API is not ready; refusing to claim measured trial.');
    await evaluate(chrome, pageSession,
      'window.__benchEvents=[];window.addEventListener("__benchmark-runtime-event",e=>{const receivedAt=Date.now();window.__benchEvents.push({receivedAt,message:e.detail})});', contentContext);
    measurementState.attempted = true;
    trial.measurementStart = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.startMeasurement()', contentContext);
    measurementState.started = true;
    if (trial.measurementStart.targetCount !== fixtureConfig.targetCount
        || JSON.stringify(trial.measurementStart.visibleIds) !== JSON.stringify(actualGeometry.visibleIds)) {
      throw new Error('MutationObserver target/visible-ID snapshot does not match actual viewport geometry.');
    }
    if (cancellationProbe) {
      trial.cancellation.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
    }
    trial.timestamps.translationCommand = now();
    const started = await evaluate(chrome, pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify({ action: 'page-translate', data: { provider: 'edge', targetLanguage: 'fr' } })})`, contentContext);
    trial.commands.push({ action: 'page-translate', sentAt: trial.timestamps.translationCommand, respondedAt: now(), response: started });
    if (!started?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE', started));
    const sessionId = sessionIdFromStart(started);
    if (!sessionId) throw new Error('Successful PAGE_TRANSLATE response omitted its session ID.');
    trial.sessionId = sessionId;
    const managerCall = await until(async () => {
      const state = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.calls.at(-1)??null', contentContext, false);
      return state;
    });
    trial.effectiveSettingsObserved = managerCall.settings;
    trial.effectiveSettingsValidation = validateEffectiveSettings(managerCall.settings, {
      targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: false,
    });
    if (!trial.effectiveSettingsValidation.ok) throw new Error(trial.effectiveSettingsValidation.issues.join('; '));

    if (cancellationProbe) {
      const sourceToId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
      const expectedIds = fixtureConfig.targets.map(target => target.id);
      cancellationControl.initialSessionId = sessionId;
      const snapshotDom = async name => {
        const dom = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
        const metadata = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
        const translatedIds = dom.filter(([id, text]) => text === `\u200efixture translation: ${originalById.get(id)}`).map(([id]) => id);
        const snapshot = { sequence: Object.keys(trial.cancellation.domSnapshots).length + 1, dom, metadata, translatedIds };
        trial.cancellation.domSnapshots[name] = snapshot;
        return snapshot;
      };
      const contentSnapshot = async owner => {
        const snapshot = await evaluate(chrome, pageSession,
          `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, contentContext, false);
        if (snapshot.instrumentationErrors?.length) {
          throw new Error(`Content cancellation ownership/promise instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
        }
        return snapshot;
      };
      const workerSnapshot = async owner => {
        const snapshot = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, undefined, false);
        if (snapshot.instrumentationErrors?.length) {
          throw new Error(`Worker cancellation/provider instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
        }
        return snapshot;
      };
      const eventSnapshot = async () => {
        trial.lifecycle = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
        return trial.lifecycle;
      };
      const sendCommand = async (action, data) => {
        const command = { action, ...(data === undefined ? {} : { data }) };
        const sentAt = now();
        const response = await evaluate(chrome, pageSession,
          `chrome.runtime.sendMessage(${JSON.stringify(command)})`, contentContext);
        const record = { sequence: trial.cancellation.commands.length + 1, action, sentAt, respondedAt: now(), response };
        trial.cancellation.commands.push(record);
        trial.commands.push(record);
        return response;
      };
      const waitHeldForSession = owner => until(() => cancellationControl.heldRequests
        .filter(request => request.pageSessionId === owner && !request.released)
        .map(request => request.record).find(Boolean) ?? null, 30_000);
      const releaseHeld = async (held, action = 'fulfill', failReason = null) => {
        const control = cancellationControl.heldRequests.find(item => item.record === held);
        if (!control) throw new Error(`Held Fetch ${held?.requestId ?? 'unknown'} is not owned by this trial.`);
        held.releaseAction = action;
        if (failReason) held.failReason = failReason;
        const requestRecord = trial.requests.find(request => request.heldFetch === held);
        const detail = action === 'fulfill'
          ? { body: mapEdgeResponse(requestRecord?.batchTexts ?? []), responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] }
          : { errorReason: failReason ?? 'Aborted' };
        await control.reservation.release(action, detail);
        await until(() => held.handlerSettled && held.releaseOutcome ? held : null, 10_000);
        held.networkCanceled = trial.cancellation.networkEvents.some(event => event.method === 'Network.loadingFailed'
          && event.params?.requestId === held.networkId && event.params?.canceled === true);
        return held;
      };
      const validateDomState = (snapshot, translatedIds, stage, { restored = false } = {}) => {
        const translated = new Set(translatedIds);
        const issues = [];
        if (snapshot.dom.length !== fixtureConfig.targetCount) issues.push(`${stage}: DOM target count ${snapshot.dom.length}`);
        const baselineMetadata = new Map(trial.cancellation.initialDOMMetadata.map(item => [item.id, item]));
        for (const actual of snapshot.metadata) {
          const baseline = baselineMetadata.get(actual.id);
          if (!baseline || actual.tagName !== baseline.tagName) {
            issues.push(`${stage}: target element identity/metadata unavailable for ${actual.id}`);
            continue;
          }
          const expectedAttributes = new Map(baseline.attributes);
          if (!restored && translated.has(actual.id)) expectedAttributes.set('data-page-translated', 'true');
          const actualAttributes = new Map(actual.attributes);
          if (JSON.stringify([...actualAttributes].sort(([a], [b]) => a.localeCompare(b)))
              !== JSON.stringify([...expectedAttributes].sort(([a], [b]) => a.localeCompare(b)))) {
            issues.push(`${stage}: target attributes differ from expected translated/original state for ${actual.id}`);
          }
        }
        for (const [id, text] of snapshot.dom) {
          const source = originalById.get(id);
          const expectedText = translated.has(id) ? `\u200efixture translation: ${source}` : source;
          if (source === undefined || text !== expectedText) issues.push(`${stage}: unexpected DOM value for ${id}`);
        }
        return { ok: issues.length === 0, issues };
      };
      const eventForSession = async (action, owner) => until(async () => {
        const events = await eventSnapshot();
        const found = events.find(event => isSessionEvent(event, action, owner));
        return found ? { found, events } : null;
      }, 45_000);
      const targetIdsForTexts = texts => texts.map(text => sourceToId.get(text) ?? null);

      const sessionIdA = sessionId;
      if (!started?.success || !sessionIdA) throw new Error('Successful cancellation-probe start omitted the real session ID.');
      trial.sessionId = sessionIdA;
      trial.cancellation.sessionA = sessionIdA;
      await eventForSession('page-translate-start', sessionIdA);

      const heldA = await waitHeldForSession(sessionIdA);
      const firstBatch = cancellationControl.firstBatchBySession.get(sessionIdA);
      if (!firstBatch) throw new Error('No first provider batch was mapped to the real session A.');
      const firstBatchIds = targetIdsForTexts(firstBatch.texts);
      const heldBatchIds = heldA.targetIds;
      if (firstBatchIds.some(id => id === null)) throw new Error('First physical provider batch contains unmapped source text.');
      await until(async () => {
        const dom = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
        return firstBatchIds.every(id => dom.some(([actualId, text]) => actualId === id && text === `\u200efixture translation: ${originalById.get(id)}`))
          ? dom : null;
      }, 30_000);
      const beforeCancel = await snapshotDom('before-cancel');
      const contentBefore = await contentSnapshot(sessionIdA);
      const workerBefore = await workerSnapshot(sessionIdA);
      const acceptedBefore = contentBefore.mutationSnapshot?.acceptedIds ?? [];
      const setupValidation = validateCancellationSetup({
        sessionId: sessionIdA,
        firstBatchIds,
        acceptedIds: acceptedBefore,
        heldBatchIds,
        heldControllerAborted: heldA.controllerAbortedAtPause,
        heldProviderRootStatus: heldA.providerRootStatusAtPause,
      });
      trial.cancellation.setup = {
        firstBatchMessageId: firstBatch.messageId,
        firstBatchIds,
        heldRequest: { ...heldA },
        acceptedIdsBeforeCancel: acceptedBefore,
        workerSnapshotBeforeCancel: workerBefore,
        validation: setupValidation,
      };
      if (!setupValidation.ok) throw new Error(`Cancellation setup gate failed: ${setupValidation.issues.join('; ')}`);
      if (firstBatchIds.length !== 25 || new Set(firstBatchIds).size !== 25) throw new Error('First completed provider batch must be exactly 25 distinct target IDs.');
      if (new Set(acceptedBefore).size !== 25 || firstBatchIds.some(id => !acceptedBefore.includes(id))
          || acceptedBefore.some(id => !firstBatchIds.includes(id))) {
        throw new Error('Actual accepted DOM ownership before cancellation is not exactly the first physical batch.');
      }
      const preCancelDomValidation = validateDomState(beforeCancel, firstBatchIds, 'before-cancel');
      trial.cancellation.preCancelDomValidation = preCancelDomValidation;
      if (!preCancelDomValidation.ok) throw new Error(preCancelDomValidation.issues.join('; '));

      let stopEmission = null;
      let postRetirementDom;
      if (cancellationProbe === 'restore') {
        const liveContent = await contentSnapshot(sessionIdA);
        const liveWorker = await workerSnapshot(sessionIdA);
        const liveRoot = liveWorker.providerRoots.find(root => root.messageId === heldA.batchMessageId);
        const liveController = liveWorker.controllers.find(controller => controller.messageId === heldA.batchMessageId);
        const trustedStart = liveContent.operations.find(operation => operation.kind === 'lifecycle.delivery'
          && operation.sessionId === sessionIdA && operation.action === 'page-translate-start'
          && operation.accepted === true);
        const activeRestoreValidation = validateActiveReplacementCheckpoint({
          sessionId: sessionIdA,
          activeManagerSessionId: liveContent.activeManagerSessionId,
          capturedSessionActive: liveContent.capturedSessionActive,
          currentBridgeOwnsSession: liveContent.currentBridgeOwnsSession,
          schedulerSessionContextOwned: liveContent.schedulerSessionContextOwned,
          trustedStart,
          providerRoot: liveRoot,
          controller: liveController,
        });
        const liveRestoreDOM = await snapshotDom('before-active-restore');
        trial.cancellation.restorePrecondition = {
          content: liveContent,
          worker: liveWorker,
          heldProviderRoot: liveRoot,
          heldController: liveController,
          trustedCoordinatorStart: trustedStart ?? null,
          ownershipValidation: activeRestoreValidation,
          dom: liveRestoreDOM,
        };
        if (!activeRestoreValidation.ok || liveContent.discoveryCancelled !== false) {
          throw new Error('B Restore precondition failed: A must still be the active trusted owner with its held provider/controller pending.');
        }
        const liveDOMValidation = validateDomState(liveRestoreDOM, firstBatchIds, 'before-active-restore');
        if (!liveDOMValidation.ok) throw new Error(liveDOMValidation.issues.join('; '));
        const restoreResponse = await sendCommand('page-restore');
        if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE while A active', restoreResponse));
        trial.cancellation.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdA)).found;
        const restored = await snapshotDom('after-restore');
        trial.rawDOM.translated = liveRestoreDOM.dom;
        trial.rawDOM.restored = restored.dom;
        postRetirementDom = restored;
        const restoredValidation = validateDomState(restored, [], 'after-restore', { restored: true });
        trial.cancellation.restoreDomValidation = restoredValidation;
        if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
      } else {
        const stopResponse = await sendCommand('page-translate-stop-auto');
        if (!stopResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE_STOP_AUTO', stopResponse));
        const stopTerminal = await eventForSession('page-auto-restore-complete', sessionIdA);
        trial.cancellation.stopTerminal = stopTerminal.found;
        const contentAfterStop = await contentSnapshot(sessionIdA);
        trial.cancellation.stopSnapshot = contentAfterStop;
        stopEmission = contentAfterStop.operations.filter(operation => operation.kind === 'lifecycle.emission'
          && operation.sessionId === sessionIdA && operation.action === 'page-auto-restore-complete').at(-1);
        if (!stopEmission) throw new Error('Stop did not emit a session-matched PAGE_AUTO_RESTORE_COMPLETE lifecycle.');
        const postStop = await snapshotDom('after-stop');
        const postStopValidation = validateDomState(postStop, firstBatchIds, 'after-stop');
        trial.cancellation.postStopDomValidation = postStopValidation;
        if (!postStopValidation.ok) throw new Error(postStopValidation.issues.join('; '));
        postRetirementDom = postStop;
        trial.rawDOM.translated = postStop.dom;
      }
      const invalidation = await until(async () => {
        const state = await contentSnapshot(sessionIdA);
        const event = state.operations.filter(operation => operation.kind === 'session.invalidation'
          && operation.sessionId === sessionIdA && operation.capturedSessionActive === false
          && operation.discoveryCancelled === true).at(-1);
        return event ? { event, state } : null;
      }, 15_000);
      trial.cancellation.invalidationBoundary = invalidation.event;
      const invalidationSequence = invalidation.event.sequence;

      let sessionIdB = null;
      let heldB = null;
      let workerAtBStart = null;
      if (cancellationProbe === 'replacement') {
        cancellationControl.replacementSessionId = null;
        const replacementResponse = await sendCommand('page-translate', {
          provider: 'edge', targetLanguage: 'fr', isAuto: true, preserveAcceptedTranslations: true,
        });
        if (!replacementResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE replacement', replacementResponse));
        sessionIdB = sessionIdFromStart(replacementResponse);
        if (!sessionIdB || sessionIdB === sessionIdA) throw new Error('Replacement session must have a real, distinct B session ID.');
        cancellationControl.replacementSessionId = sessionIdB;
        trial.cancellation.sessionB = sessionIdB;
        await eventForSession('page-translate-start', sessionIdB);
        const managerEvents = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.events.filter(event=>event.name==="manager.translatePage.entry")', contentContext, false);
        const replacementCall = managerEvents.at(-1);
        if (replacementCall?.isAuto !== true) throw new Error('Replacement B was not observed entering translatePage as isAuto=true.');
        const managerCallB = await until(async () => evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.calls.find(call=>call.messageId===' + JSON.stringify(sessionIdB) + ')??null', contentContext, false), 15_000);
        const effectiveSettingsB = validateEffectiveSettings(managerCallB.settings, {
          targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: false,
        });
        trial.cancellation.effectiveSettingsB = { observed: managerCallB.settings, validation: effectiveSettingsB };
        if (!effectiveSettingsB.ok) throw new Error(`Replacement B changed effective fixture settings: ${effectiveSettingsB.issues.join('; ')}`);
        heldB = await waitHeldForSession(sessionIdB);
        const heldBRequestsBeforeRelease = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB && !item.record.released);
        const singleHeldBValidation = validateSingleHeldRequest(heldBRequestsBeforeRelease.map(item => item.record), sessionIdB);
        trial.cancellation.singleHeldBValidation = singleHeldBValidation;
        if (!singleHeldBValidation.ok) throw new Error(singleHeldBValidation.issues.join('; '));
        workerAtBStart = await workerSnapshot(sessionIdA);
        trial.cancellation.workerAtBStart = workerAtBStart;
        const trustedBStart = (await contentSnapshot(sessionIdB)).operations.find(operation => operation.kind === 'lifecycle.delivery'
          && operation.sessionId === sessionIdB && operation.action === 'page-translate-start' && operation.accepted === true);
        if (!trustedBStart) throw new Error('Main-frame coordinator did not positively accept B PAGE_TRANSLATE_START ownership.');
        trial.cancellation.trustedBStart = trustedBStart;
        const bFirstBatch = cancellationControl.firstBatchBySession.get(sessionIdB);
        if (!bFirstBatch) throw new Error('Replacement B did not issue a mapped real provider request.');
        if (heldB.controllerAbortedAtPause !== false || heldB.providerRootStatusAtPause !== 'pending') {
          throw new Error('Replacement B held provider request was not active and pending before A release.');
        }
        if (heldB.targetIds.some(id => firstBatchIds.includes(id))) {
          throw new Error('Replacement B first physical request unexpectedly re-enqueued A-retained targets.');
        }
        trial.cancellation.replacementFirstBatch = { messageId: bFirstBatch.messageId, targetIds: heldB.targetIds, heldRequest: heldB };
      }

      // Real cancellation request from the scheduler is asynchronous; release only after command/restore/B state is observed.
      if (cancellationProbe === 'replacement') {
        const currentBContent = await contentSnapshot(sessionIdB);
        const currentBWorker = await workerSnapshot(sessionIdB);
        const currentBRoot = currentBWorker.providerRoots.find(root => root.messageId === heldB.batchMessageId);
        const currentBController = currentBWorker.controllers.find(controller => controller.messageId === heldB.batchMessageId);
        const currentBTrustedStart = trial.cancellation.trustedBStart;
        const activeBValidation = validateActiveReplacementCheckpoint({
          sessionId: sessionIdB,
          activeManagerSessionId: currentBContent.activeManagerSessionId,
          capturedSessionActive: currentBContent.capturedSessionActive,
          currentBridgeOwnsSession: currentBContent.currentBridgeOwnsSession,
          schedulerSessionContextOwned: currentBContent.schedulerSessionContextOwned,
          trustedStart: currentBTrustedStart,
          providerRoot: currentBRoot,
          controller: currentBController,
        });
        const currentBCheckpoint = {
          content: currentBContent,
          worker: currentBWorker,
          providerRoot: currentBRoot,
          controller: currentBController,
          trustedStart: currentBTrustedStart,
          validation: activeBValidation,
        };
        const currentBDOM = await snapshotDom('replacement-B-active-before-A-release');
        const currentBAcceptedIds = currentBContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
          && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
        const currentBDOMValidation = validateDomState(currentBDOM, [...new Set([...firstBatchIds, ...currentBAcceptedIds])], 'replacement-B-active-before-A-release');
        currentBCheckpoint.dom = currentBDOM;
        currentBCheckpoint.acceptedIds = currentBAcceptedIds;
        currentBCheckpoint.domValidation = currentBDOMValidation;
        trial.cancellation.bActiveAtARelease = currentBCheckpoint;
        if (!activeBValidation.ok || !currentBDOMValidation.ok) {
          throw new Error('B replacement ownership/provider request was not active at A release.');
        }
      }
      cancellationControl.releaseAllA = true;
      const heldARequests = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdA).map(item => item.record);
      const singleHeldAValidation = validateSingleHeldRequest(heldARequests, sessionIdA);
      trial.cancellation.singleHeldAValidation = singleHeldAValidation;
      if (!singleHeldAValidation.ok) throw new Error(singleHeldAValidation.issues.join('; '));
      for (const held of heldARequests) await releaseHeld(held, 'fulfill');

      const quiescentA = await until(async () => {
        const content = await contentSnapshot(sessionIdA);
        const worker = await workerSnapshot(sessionIdA);
        const roots = worker.providerRoots ?? [];
        const physical = worker.ledger.operations.filter(operation => operation.kind === 'provider.physical');
        const allPausedSettled = heldARequests.every(request => request.handlerSettled && !!request.releaseOutcome);
        const state = {
          content, worker,
          providerRootSettled: roots.length > 0 && roots.every(operation => operation.status !== 'pending'),
          physicalSettled: physical.length > 0 && physical.every(operation => operation.status !== 'pending'),
          allPausedSettled,
        };
        if (content.capturedSessionActive !== false || content.discoveryCancelled !== true
            || content.pendingOperations !== 0 || worker.ledger.pending !== 0
            || !state.providerRootSettled || !state.physicalSettled || !allPausedSettled) return null;
        return state;
      }, 45_000);
      const contentAfterQuiescence = await contentSnapshot(sessionIdA);
      if (contentAfterQuiescence.mutationSnapshot?.duplicateAcceptedIds?.length) {
        throw new Error(`Duplicate accepted DOM writes were observed before A quiescence: ${contentAfterQuiescence.mutationSnapshot.duplicateAcceptedIds.join(',')}`);
      }
      const heldRoot = quiescentA.worker.providerRoots.find(rootCall => rootCall.messageId === heldA.batchMessageId);
      const heldController = quiescentA.worker.controllers.find(controller => controller.messageId === heldA.batchMessageId);
      const cancelServiceCall = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'service.cancelRequest'
        && operation.messageId === heldA.batchMessageId);
      const heldPhysical = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'provider.physical'
        && operation.messageId === heldA.batchMessageId && operation.sessionId === sessionIdA);
      const heldRootSettled = heldRoot && heldRoot.status !== 'pending';
      const controllerAbort = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'controller.abort'
        && operation.messageId === heldA.batchMessageId && operation.sessionId === sessionIdA);
      const matchedCancellation = validateMatchedCancellation({
        sessionId: sessionIdA, messageId: heldA.batchMessageId,
        serviceCall: cancelServiceCall, abortEvent: controllerAbort, controller: heldController,
      });
      const cancelTargetMatched = matchedCancellation.ok;
      const abortAfterCancelBegin = Number.isInteger(controllerAbort?.sequence)
        && Number.isInteger(cancelServiceCall?.sequence) && controllerAbort.sequence > cancelServiceCall.sequence;
      const heldFetchClassifications = heldARequests.map(request => {
        const classification = classifyHeldFetchRelease({
          heldRequestId: request.requestId,
          matchedRequestId: request.requestId,
          releaseOutcome: request.releaseOutcome,
          networkCanceled: request.networkCanceled,
          controllerAborted: heldController?.aborted === true && controllerAbort?.sequence > cancelServiceCall?.sequence,
          cancelTargetMatched: cancelTargetMatched && abortAfterCancelBegin,
          providerRootStatus: heldRoot?.status,
          physicalStatus: heldPhysical?.status,
          physicalControllerAborted: heldPhysical?.controllerAbortedAtEnd,
          controllerAbortSequence: controllerAbort?.sequence,
          providerRootSettledSequence: heldRoot?.settledSequence,
          physicalSettledSequence: heldPhysical?.settledSequence,
        });
        request.releaseClassification = classification;
        const heldControl = cancellationControl.heldRequests.find(item => item.record === request);
        heldControl?.reservation.classifyRelease(classification);
        return classification;
      });
      const postAbortInterceptionError = heldARequests.every((request, index) => request.handlerSettled && heldFetchClassifications[index]?.ok);
      const cancelAck = contentAfterQuiescence.operations.some(operation => operation.kind === 'runtime.cancel.send'
        && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
        && operation.response?.success === true);
      const quiescenceValidation = validateCancellationQuiescence({
        sessionId: sessionIdA,
        capturedSessionActive: quiescentA.content.capturedSessionActive,
        discoveryCancelled: quiescentA.content.discoveryCancelled,
        controllerAborted: heldController?.aborted === true,
        pendingOperations: quiescentA.content.pendingOperations + quiescentA.worker.ledger.pending,
        heldRequestReleased: postAbortInterceptionError,
        providerRootSettled: heldRootSettled && heldPhysical?.status !== 'pending',
        cancelAcknowledged: cancelAck && cancelServiceCall?.status === 'fulfilled'
          && cancelTargetMatched && abortAfterCancelBegin,
        cancelTargetSessionId: cancelServiceCall?.sessionId,
      });
      trial.cancellation.quiescence = {
        worker: quiescentA.worker,
        content: quiescentA.content,
        heldRequestReleaseOutcomes: heldARequests.map(request => ({ requestId: request.requestId, networkId: request.networkId, ...request.releaseOutcome })),
        matchedProviderRoot: heldRoot,
        matchedPhysicalRequest: heldPhysical,
        matchedAbortEvent: controllerAbort,
        abortAfterCancelBegin,
        matchedController: heldController,
        matchedServiceCancel: cancelServiceCall,
        matchedCancellationValidation: matchedCancellation,
        postAbortFetchClassification: heldARequests.map(request => ({
          requestId: request.requestId, networkId: request.networkId,
          releaseOutcome: request.releaseOutcome, networkCanceled: request.networkCanceled,
          ...request.releaseClassification,
        })),
        validation: quiescenceValidation,
      };
      trial.cancellation.lifecycleProof = contentAfterQuiescence.operations.filter(operation => operation.kind.startsWith('lifecycle.'));
      trial.cancellation.rootPromiseSettlements = quiescentA.worker.ledger.operations.filter(operation => ['provider.root', 'provider.physical'].includes(operation.kind));
      trial.cancellation.networkProof = heldARequests.map(request => ({
        requestId: request.requestId, networkId: request.networkId,
        releaseOutcome: request.releaseOutcome,
        events: trial.cancellation.networkEvents.filter(event => event.params?.requestId === request.networkId),
      }));
      if (!quiescenceValidation.ok) throw new Error(`Cancellation quiescence gate failed: ${quiescenceValidation.issues.join('; ')}`);

      const contentAfterAReleaseAll = await contentSnapshot(undefined);
      const acceptedBAtARelease = contentAfterAReleaseAll?.operations
        .filter(operation => operation.kind === 'scheduler.settlement' && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true)
        .map(operation => operation.id) ?? [];
      const afterRelease = await snapshotDom('after-A-release');
      const retainedAfterRelease = cancellationProbe === 'restore' ? []
        : cancellationProbe === 'replacement' ? [...new Set([...firstBatchIds, ...acceptedBAtARelease])]
          : firstBatchIds;
      const afterReleaseValidation = validateDomState(afterRelease, retainedAfterRelease, 'after-A-release');
      trial.cancellation.afterReleaseDomValidation = afterReleaseValidation;
      if (cancellationProbe === 'replacement') trial.cancellation.bAcceptedAtARelease = acceptedBAtARelease;
      if (!afterReleaseValidation.ok) throw new Error(afterReleaseValidation.issues.join('; '));
      const settledAEvents = contentAfterAReleaseAll.operations.filter(operation => operation.sessionId === sessionIdA);
      const acceptedAfterStop = settledAEvents.filter(operation => operation.kind === 'scheduler.settlement'
        && operation.outcome === 'accepted' && operation.changed === true && operation.sequence > invalidationSequence);
      const invalidationEvidence = validatePostInvalidationEvidence({
        sessionId: sessionIdA,
        invalidationSequence,
        operations: contentAfterAReleaseAll.operations,
        duplicateAcceptedIds: contentAfterAReleaseAll.mutationSnapshot?.duplicateAcceptedIds ?? [],
        allowedMutationOwners: cancellationProbe === 'replacement' ? [sessionIdB] : [],
      });
      const emissionsAfterStop = settledAEvents.filter(operation => operation.kind === 'lifecycle.emission'
        && operation.sequence > invalidationSequence
        && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action));
      trial.cancellation.acceptedWriteProof = {
        beforeStopAcceptedIds: acceptedBefore,
        afterStopAcceptedSettlementIds: acceptedAfterStop.map(operation => operation.id),
        invalidationSequence,
        invalidationEvidence,
        observedDuplicateAcceptedIds: contentAfterAReleaseAll.mutationSnapshot?.duplicateAcceptedIds ?? [],
        postStopAProgressOrCompletionEmissions: emissionsAfterStop,
        noNewAcceptedWrites: invalidationEvidence.ok && acceptedAfterStop.length === 0 && emissionsAfterStop.length === 0
          && (cancellationProbe === 'replacement' || JSON.stringify(afterRelease.dom) === JSON.stringify(postRetirementDom.dom)),
      };
      if (!trial.cancellation.acceptedWriteProof.noNewAcceptedWrites) throw new Error('Retired A produced a post-invalidation write/emission, unattributed mutation or duplicate accepted write.');

      if (cancellationProbe === 'replacement') {
        const aRoot = workerAtBStart?.providerRoots?.find(rootCall => rootCall.messageId === heldA.batchMessageId);
        trial.cancellation.cancellationClassification = aRoot?.status === 'pending'
          ? 'A provider root remained pending at B start and settled after A release; overlapping ownership was observed.'
          : 'A provider root settled before B remained active; this proves restart isolation, not a stale successful result competing with B.';
        const deliveries = contentAfterQuiescence.operations.filter(operation => operation.kind === 'lifecycle.delivery'
          && operation.sessionId === sessionIdA && operation.sequence > 0);
        const bStartSequence = trial.cancellation.trustedBStart?.sequence;
        const lateDeliveryIssues = deliveries.filter(operation => operation.sequence > (bStartSequence ?? Number.MAX_SAFE_INTEGER)
          && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action)
          && (operation.accepted !== false || operation.result?.reason !== 'stale-session'));
        trial.cancellation.lateADeliveryProof = { bStartSequence: bStartSequence ?? null, deliveriesAfterBStart: deliveries.filter(operation => operation.sequence > (bStartSequence ?? Number.MAX_SAFE_INTEGER)), issues: lateDeliveryIssues };
        if (lateDeliveryIssues.length) throw new Error('Main-frame coordinator accepted a late A lifecycle event after B ownership began.');

        cancellationControl.releaseReplacement = true;
        const heldBRequests = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB).map(item => item.record);
        for (const held of heldBRequests) await releaseHeld(held, 'fulfill');
        const terminalB = await eventForSession('page-translate-complete', sessionIdB);
        trial.cancellation.terminalB = terminalB.found;
        const translatedB = await snapshotDom('after-B-complete');
        trial.rawDOM.translated = translatedB.dom;
        const translatedValidation = validateDomState(translatedB, expectedIds, 'after-B-complete');
        if (!translatedValidation.ok) throw new Error(translatedValidation.issues.join('; '));
        const allContent = await contentSnapshot(undefined);
        const acceptedAIds = allContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
          && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
        const acceptedBIds = allContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
          && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
        const finalDuplicateAcceptedIds = allContent.mutationSnapshot?.duplicateAcceptedIds ?? [];
        trial.cancellation.finalDuplicateAcceptedIds = finalDuplicateAcceptedIds;
        if (finalDuplicateAcceptedIds.length) throw new Error(`Duplicate accepted DOM writes were observed: ${finalDuplicateAcceptedIds.join(',')}`);
        const ownershipValidation = validateReplacementOwnership({
          acceptedAIds, acceptedBIds, finalTranslatedIds: translatedB.translatedIds, expectedIds,
        });
        trial.cancellation.replacementOwnership = { acceptedAIds, acceptedBIds, finalTranslatedIds: translatedB.translatedIds, validation: ownershipValidation };
        if (!ownershipValidation.ok) throw new Error(`Replacement ownership gate failed: ${ownershipValidation.issues.join('; ')}`);
        const restoreResponse = await sendCommand('page-restore');
        if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after replacement', restoreResponse));
        trial.cancellation.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdB)).found;
        const restored = await snapshotDom('after-B-restore');
        trial.rawDOM.restored = restored.dom;
        const restoredValidation = validateDomState(restored, [], 'after-B-restore', { restored: true });
        if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
      }

      const stopOnlyAfterRelease = cancellationProbe === 'stop'
        ? await snapshotDom('stop-only-before-harness-cleanup')
        : null;
      if (cancellationProbe === 'stop') {
        trial.rawDOM.translated = postRetirementDom.dom;
        const status = validateDomState(stopOnlyAfterRelease, firstBatchIds, 'stop-only-before-harness-cleanup');
        if (!status.ok) throw new Error(status.issues.join('; '));
      }
      if (!trial.rawDOM.translated) trial.rawDOM.translated = postRetirementDom.dom;
      if (cancellationProbe === 'stop') {
        const restoreResponse = await sendCommand('page-restore');
        if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE cleanup', restoreResponse));
        trial.cancellation.cleanup.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdA)).found;
        const restored = await snapshotDom('cleanup-restored');
        trial.rawDOM.restored = restored.dom;
        const restoredValidation = validateDomState(restored, [], 'cleanup-restored', { restored: true });
        if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
      }
      trial.measurementStopAttempted = true;
      const contentTrace = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext);
      measurementState.stopped = true;
      measurementState.stopAttempts++;
      trial.measurements = { content: contentTrace };
      trial.timestamps.measurementStopped = now();
      if (!contentTrace?.available) throw new Error(`Cancellation measurement stop failed: ${contentTrace?.reason ?? 'observer snapshot unavailable'}`);
      trial.rawDOM.original = originals;
      trial.derivedTimings = deriveTimings(trial, null, contentTrace, []);
      trial.providerTranslationAttempts = trial.requests.filter(request => request.category === 'provider-translation').length;
      trial.providerBatchSizes = trial.requests.filter(request => request.category === 'provider-translation').map(request => request.batchSize);
      trial.cancellation.cleanup.pendingHeldFetches = cancellationControl.heldRequests.filter(item => !item.record.handlerSettled).length;
      if (trial.cancellation.cleanup.pendingHeldFetches) throw new Error('Cancellation probe ended with a held Fetch request unsettled.');
      if (trial.requests.some(request => request.category === 'blocked')) throw new Error('Unexpected external request blocked during cancellation probe.');
      trial.status = 'passed';
      return trial;
    }

    const lifecycle = await completeTranslationMeasurement({
      state: measurementState,
      cleanupErrors: trial.cleanupErrors,
      awaitAcceptedTranslation: async () => {
        const accepted = await until(async () => {
          const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
          trial.lifecycle = events;
          const terminal = events.find(event => ['page-translate-complete', 'page-translate-idle'].some(action => isSessionEvent(event, action, sessionId)));
          if (terminal) trial.terminal = terminal;
          if (!terminal) return null;
          const dom = await evaluate(chrome, pageSession,
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          trial.rawDOM.translated = dom;
          return dom.length === fixtureConfig.targetCount && dom.every(([id, value]) => {
            const source = originalById.get(id);
            return source !== undefined && value === `\u200efixture translation: ${source}`;
          }) ? { terminal, dom } : null;
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
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          trial.rawDOM.restored = dom;
          return dom.length === fixtureConfig.targetCount
            && dom.every(([id, text]) => originalById.get(id) === text) ? { done, dom } : null;
        }, 30_000);
        return restored;
      },
    });
    const contentTrace = lifecycle.measurement;
    trial.measurements.content = contentTrace;
    trial.timestamps.restoreCompleted = lifecycle.restoreCompletedAt;
    const restoredLifecycle = lifecycle.restored;
    const [workerTrace, contentObservation] = await Promise.all([
      evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.snapshot()'),
      evaluate(chrome, pageSession,
        `(()=>{const trace=window.__pageTranslationBenchmark;return {events:trace.events.map(event=>({...event})),discoveryFlags:trace.discoveryFlags,admissionHookInstalled:trace.admissionHookInstalled,discoveryAdmissionOrder:trace.discoveryAdmissionOrder,schedulerEnqueueOrder:trace.schedulerEnqueueOrder,selectedBatchMembers:trace.selectedBatchMembers,viewportWindowObservation:trace.viewportWindowObservation}})()`, contentContext),
    ]);
    const contentEvents = contentObservation.events;
    trial.contentObservation = contentObservation;
    trial.measurements.contentEvents = contentEvents;
    trial.measurements.worker = workerTrace;
    const calibratedLongTasks = validatedLongTaskObservation(trial.longTaskCalibration, contentTrace.longTasks);
    const verifiedContentTrace = { ...contentTrace, longTasks: calibratedLongTasks.entries, longTasksUnavailableReason: calibratedLongTasks.unavailableReason };
    trial.derivedTimings = deriveTimings(trial, workerTrace, verifiedContentTrace, contentEvents);
    const providerAttempts = trial.requests.filter(request => request.category === 'provider-translation');
    trial.providerTranslationAttempts = providerAttempts.length;
    trial.providerBatchSizes = providerAttempts.map(request => request.batchSize);
    const originalsFromDom = trial.rawDOM.original;
    const translatedFromDom = trial.rawDOM.translated;
    const providerSources = providerAttempts.flatMap(request => request.batchTexts ?? []);
    const expectedIds = originalsFromDom.map(([id]) => id);
    const sourceToId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
    if (sourceToId.size !== fixtureConfig.targetCount) throw new Error('Fixture source texts are not unique; HTTP body-to-target order cannot be proven.');
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
    const orderValidation = [
      validateExactTargetIds('Scheduler enqueue', enqueuedIds, expectedIds),
      validateExactTargetIds('filtered primitive admission', admissionIds, expectedIds),
      validateExactTargetIds('accepted DOM write', acceptedIds, expectedIds),
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
    const providerRequestIds = trial.providerRequestOrder.flat();
    const providerOrderValidation = validateExactTargetIds('provider request source', providerRequestIds, expectedIds);
    if (!providerOrderValidation.ok) throw new Error(providerOrderValidation.issues.join('; '));
    trial.providerRequestOrderValidation = providerOrderValidation;
    trial.providerHTTPRequestSequence = providerAttempts.map(request => ({ at: request.startedAt, ids: (request.batchTexts ?? []).map(source => sourceToId.get(source) ?? null), bodyBytes: request.bodyBytes }));
    trial.validation = validateTranslation({
      originals: originalsFromDom,
      translated: translatedFromDom,
      requests: providerSources,
      restored: new Map(restoredLifecycle.dom),
      expectedCount: fixtureConfig.targetCount,
      acceptedIds,
      enqueuedIds,
      admittedIds: admissionIds,
    });
    if (!trial.validation.ok) throw new Error(trial.validation.issues.join('; '));
    const unexpectedExternal = trial.requests.find(request => request.category === 'blocked');
    if (unexpectedExternal) throw new Error(`Unexpected external request blocked: ${unexpectedExternal.url}`);
    if (!providerAttempts.length) throw new Error('No actual provider translation transport attempts were observed.');
    trial.status = 'passed';
  } catch (error) {
    trial.status = 'failed';
    trial.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    trial.stage ??= 'cleanup';
    if (cancellationControl) {
      try {
        const requestCleanup = await cancellationControl.requestLifecycle.closeAndDrain({
        timeoutMs: 8_000,
        disableFetch: async () => {
          if (!chrome || !guardSessions.size) throw new Error('Fetch target sessions unavailable while closing request admission.');
          const results = await Promise.allSettled([...guardSessions].map(sessionId => chrome.send('Fetch.disable', {}, sessionId)));
          const failures = results.flatMap((result, index) => result.status === 'rejected'
            ? [`${[...guardSessions][index]}: ${result.reason?.message ?? String(result.reason)}`] : []);
          if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), `Fetch.disable failed for ${failures.length} target(s).`);
        },
        });
        trial.cancellation.cleanup.requestLifecycle = requestCleanup;
        trial.cancellation.cleanup.heldFetches = requestCleanup.reservations;
        trial.cleanupErrors.push(...requestCleanup.errors.map(error => `Cancellation request cleanup: ${error}`));
        try { await until(() => requestHandlerJobs.size === 0 ? true : null, 8_000); }
        catch (error) { trial.cleanupErrors.push(`Tracked Fetch request callbacks did not drain before Chrome close: ${error.message}`); }
        const diagnostics = promoteRequestDiagnostics(trial);
        trial.cancellation.cleanup.diagnosticGate = diagnostics;
      } catch (error) {
        const message = `Cancellation request cleanup helper failed: ${error?.message ?? String(error)}`;
        trial.cancellation.cleanup.requestLifecycle = { ok: false, errors: [message], closing: cancellationControl.requestLifecycle.closing };
        trial.cleanupErrors.push(message);
      }
      if (!trial.cancellation.restoreTerminal && trial.cancellation.sessionA && chrome && pageSession && contentContext) {
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
    const cleanups = [
      async () => requestUnsubscribe?.(),
      async () => eventUnsubscribe?.(),
      async () => pageEventUnsubscribe?.(),
      async () => networkEventUnsubscribe?.(),
      async () => { if (chrome) { const instance = chrome; await instance.close(); trial.chromeStderr = instance.metadata.stderr ?? null; } },
      async () => { if (fixture?.server.listening) await new Promise((resolveClose, reject) => fixture.server.close(error => error ? reject(error) : resolveClose())); },
    ];
    await cleanupMeasurementBeforeResources({
      state: measurementState,
      stopMeasurement: () => evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext),
      resources: cleanups,
      cleanupErrors: trial.cleanupErrors,
    });
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

async function runNetworkGuardNegativeProbe(extensionPath, mode = 'legacy') {
  const probeArtifactPath = `${artifactPath.replace(/\.json$/i, '')}-network-guard-probe.json`;
  const run = await runTrial({ mode, scenario: 'small', ordinal: 1, globalRunOrder: ++globalRunOrder, phase: 'non-performance-network-guard-probe', extensionPath, fixtureConfig: createFixture('small'), networkGuardProbe: true });
  const blockedRequests = run.networkGuardProbe?.map(result => ({ world: result.world, url: result.url, method: result.request.method, blocked: result.request.blocked, reason: result.request.error })) ?? [];
  const probe = {
    command: 'runTrial legacy negative network guard probe (non-performance; excluded from aggregates)',
    status: run.status,
    expected: { worlds: ['page-main-world', 'extension-isolated-world'], result: 'request intercepted and blocked before network access' },
    blockedRequests,
    run,
    artifactPath: probeArtifactPath,
  };
  await mkdir(dirname(probeArtifactPath), { recursive: true });
  await writeFile(probeArtifactPath, JSON.stringify(probe, null, 2));
  harness.nonPerformanceProbes.networkGuard = { artifactPath: probeArtifactPath, status: probe.status, blockedRequests };
  if (probe.status !== 'passed') throw new Error(`Negative network guard probe failed; see ${probeArtifactPath}`);
}

let globalRunOrder = 0;
async function runRecordedTrial(options) {
  const run = await runTrial({ ...options, globalRunOrder: ++globalRunOrder });
  harness.results.push(run);
  if (run.browser?.browserVersion) harness.provenance.browserVersion = run.browser.browserVersion;
  if (run.status !== 'passed') throw new Error(`${run.mode}/${run.scenario} ${run.phase} ${run.ordinal} failed: ${run.error?.message ?? run.cleanupErrors.join('; ')}`);
  return run;
}

try {
  if (!requestedModes.length || requestedModes.some(mode => !['legacy', 'sliced', 'viewport'].includes(mode))) throw new TypeError(`Unsupported BENCH_MODES: ${requestedModes.join(',')}`);
  if (!cancellationProbes.length) {
    validateSampleCount(samples);
    if (!Number.isInteger(warmups) || warmups < 1 || warmups > 3) throw new TypeError('BENCH_WARMUPS must be 1, 2, or 3.');
  }
  harness.provenance = {
    gitSha: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    workingTree: git('status', '--short'),
    trackedChanges: { unstaged: git('diff', '--name-only'), staged: git('diff', '--cached', '--name-only') },
    browserVersion: null,
    fileSha256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(path)]))),
  };
  if (cancellationProbes.length) {
    harness.command = `BENCH_CANCELLATION_PROBES=${cancellationProbes.join(',')} BENCH_MODES=sliced node scripts/dev/page-translation-e2e-benchmark/run.mjs`;
    harness.warmups = 0;
    harness.measuredSamples = 0;
    harness.cancellationExecutionPlan = { mode: 'sliced', scenario: 'early-visible', trialCount: cancellationProbes.length, warmups: 0, performanceSamples: 0, performanceAggregation: false };
    harness.comparisonOrdering = 'Dedicated Sliced-only cancellation probes; no performance aggregation or mode comparison is performed.';
    const slicedOutput = await compileMode('sliced');
    await runNetworkGuardNegativeProbe(slicedOutput, 'sliced');
    for (const [index, probe] of cancellationProbes.entries()) {
      const caseRecord = { probe, ordinal: index + 1, status: 'running', resultIndex: harness.results.length };
      harness.nonPerformanceProbes.cancellation.cases.push(caseRecord);
      try {
        const trial = await runRecordedTrial({
          mode: 'sliced', scenario: 'early-visible', ordinal: index + 1,
          phase: 'cancellation-probe', extensionPath: slicedOutput,
          fixtureConfig: createFixture('early-visible'), cancellationProbe: probe,
        });
        caseRecord.status = trial.status;
        caseRecord.sessionA = trial.cancellation?.sessionA ?? null;
        caseRecord.sessionB = trial.cancellation?.sessionB ?? null;
      } catch (error) {
        caseRecord.status = 'failed';
        caseRecord.error = error.message;
        throw error;
      }
    }
    harness.cancellationGate = { passed: harness.nonPerformanceProbes.cancellation.cases.every(item => item.status === 'passed') };
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Not run for cancellation probes.' };
    harness.nonPerformanceProbes.cancellationStaleResponse = {
      status: 'not-proven',
      reason: 'The probes use real controller cancellation and held Fetch requests, but do not fabricate a successful late provider response. Per-case Fetch release outcome and provider-root/physical-promise settlement classify whether the stale-success guard was exercised.',
    };
    harness.status = harness.cancellationGate.passed ? 'passed' : 'failed';
  } else {
    harness.comparisonOrdering = 'All per-scenario Legacy qualification runs complete before candidates. Candidate warmups and each measured ordinal rotate sliced/viewport order by scenario index plus ordinal; this retains a Legacy-first ordering bias.';
    const scenarioPlans = scenarios.map((scenario, index) => ({ scenario, index, fixture: createFixture(scenario) }));
    const legacyOutput = await compileMode('legacy');
    const legacyRuns = [];
    harness.scenarioSummaries = {};
    for (const plan of scenarioPlans) {
      const measuredRuns = [];
      for (let ordinal = 1; ordinal <= warmups; ordinal++) {
        const run = await runRecordedTrial({ mode: 'legacy', scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: legacyOutput, fixtureConfig: plan.fixture });
        legacyRuns.push(run);
      }
      for (let ordinal = 1; ordinal <= samples; ordinal++) {
        const run = await runRecordedTrial({ mode: 'legacy', scenario: plan.scenario, ordinal, phase: 'measured', extensionPath: legacyOutput, fixtureConfig: plan.fixture });
        legacyRuns.push(run);
        measuredRuns.push(run);
      }
      harness.scenarioSummaries[plan.scenario] = { legacy: measureMode(measuredRuns) };
    }
    harness.comparisonGate = validateRunGate({ legacyResults: legacyRuns, measuredSamples: legacyRuns.filter(run => run.phase === 'measured') });
    if (!harness.comparisonGate.comparisonsAllowed) throw new Error('Candidate comparisons gated: a Legacy scenario did not pass every warmup and measured run.');
    await runNetworkGuardNegativeProbe(legacyOutput);

    const candidateModes = modes.filter(mode => mode !== 'legacy');
    const candidateOutputs = new Map();
    for (const mode of candidateModes) {
      candidateOutputs.set(mode, await compileMode(mode));
    }
    for (const plan of scenarioPlans) {
      for (const mode of candidateModeOrder(plan.index, 0).filter(candidate => candidateModes.includes(candidate))) {
        for (let ordinal = 1; ordinal <= warmups; ordinal++) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: candidateOutputs.get(mode), fixtureConfig: plan.fixture });
        }
      }
    }
    for (const plan of scenarioPlans) {
      for (let ordinal = 1; ordinal <= samples; ordinal++) {
        for (const mode of candidateModeOrder(plan.index, ordinal - 1).filter(candidate => candidateModes.includes(candidate))) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'measured', extensionPath: candidateOutputs.get(mode), fixtureConfig: plan.fixture });
        }
      }
    }

    harness.comparisons = {};
    for (const plan of scenarioPlans) {
      for (const mode of candidateModes) {
        const measuredRuns = harness.results.filter(run => run.scenario === plan.scenario && run.mode === mode && run.phase === 'measured');
        const summary = measureMode(measuredRuns);
        harness.scenarioSummaries[plan.scenario][mode] = summary;
        const baseline = harness.scenarioSummaries[plan.scenario].legacy.times;
        harness.comparisons[plan.scenario] ??= {};
        harness.comparisons[plan.scenario][mode] = Object.fromEntries(Object.keys(summary.times).map(metric => {
          const baselineP50 = baseline[metric]?.p50;
          const modeP50 = summary.times[metric]?.p50;
          return [metric, { baselineP50: baselineP50 ?? null, modeP50: modeP50 ?? null, delta: Number.isFinite(baselineP50) && Number.isFinite(modeP50) ? modeP50 - baselineP50 : null }];
        }));
      }
    }
    const legacy = harness.results.filter(run => run.mode === 'legacy');
    const measured = harness.results.filter(run => run.phase === 'measured');
    harness.comparisonGate = validateRunGate({ legacyResults: legacy, measuredSamples: measured });
    harness.status = harness.results.every(run => run.status === 'passed') ? 'passed' : 'failed';
  }
} catch (error) {
  primaryError = error;
  harness.status = 'failed';
  harness.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  await Promise.all(buildDirs.map(async directory => {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { harness.cleanupErrors.push(`Build ${directory}: ${error.message}`); }
  }));
  if (harness.cleanupErrors.length) harness.status = 'failed';
  harness.primaryError = primaryError?.message ?? null;
  harness.comparisonGate ??= validateRunGate({
    legacyResults: harness.results.filter(run => run.mode === 'legacy'),
    measuredSamples: harness.results.filter(run => run.phase === 'measured'),
  });
  harness.finishedAt = now();
  await writeArtifact();
}
process.stdout.write(`${JSON.stringify({ status: harness.status, artifactPath, runs: harness.results.length, error: harness.error?.message })}\n`);
if (harness.status !== 'passed') process.exitCode = 1;

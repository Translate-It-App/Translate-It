import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { buildBenchmarkExtension } from './build.mjs';
import { validateBuildParity } from './build-environment.mjs';
import { launchChrome } from './chrome.mjs';
import { writeBenchmarkArtifact } from './artifact-writer.mjs';
import { classifyTransportRequest, mapEdgeResponse, summarizeIntervals, summarizeLongTasks, validateEffectiveSettings, validateRunGate, validateTranslation, validatedLongTaskObservation, validateWindowMembership } from './metrics.mjs';
import { createFixture, startFixture, startupVoicesResponse } from './fixture.mjs';
import { cleanupMeasurementBeforeResources, completeTranslationMeasurement, summarizeAcceptanceTimes } from './measurement-lifecycle.mjs';
import { modeOrder, mapProviderBatchIds, parseScenarioSelection, validateDiscoveryFlags, validateExactTargetIds, validateFixtureGeometry, validateSampleCount } from './scenario-plan.mjs';
import { classifyHeldFetchRelease, createCancellationRequestLifecycle, parseCancellationProbeSelection, promoteRequestDiagnostics, validateActiveReplacementCheckpoint, validateCancellationQuiescence, validateCancellationSetup, validateMatchedCancellation, validatePostInvalidationEvidence, validateReplacementOwnership, validateSingleHeldRequest } from './cancellation-probes.mjs';
import { classifyStaleSuccessProviderOwner, createWorkerNetworkEventRouter, parseSuccessfulReplyProbeSelection, resolveCleanupSessionEvidence, teardownSuccessfulReplyGate, validateCleanupInvalidation, validateRawDOMMutationEvidence, validateReplacementDiscoverySnapshot, validateReplacementStability, validateRuntimeResources, validateSuccessfulReplyCapture, validateStaleSuccessEvidence, validateWorkerNetworkCompletion } from './successful-reply-probes.mjs';

const root = process.cwd();
const cancellationProbes = parseCancellationProbeSelection(process.env.BENCH_CANCELLATION_PROBES);
const staleSuccessProbes = parseSuccessfulReplyProbeSelection(process.env.BENCH_STALE_SUCCESS_PROBES);
if (cancellationProbes.length && staleSuccessProbes.length) throw new TypeError('Cancellation and stale-success probes must run separately.');
const isolatedProbes = cancellationProbes.length ? cancellationProbes : staleSuccessProbes;
const requestedModes = [...new Set((process.env.BENCH_MODES ?? (isolatedProbes.length ? 'sliced' : 'legacy,sliced,viewport')).split(',').map(value => value.trim()).filter(Boolean))];
if (isolatedProbes.length && (requestedModes.length !== 1 || requestedModes[0] !== 'sliced')) {
  throw new TypeError('Cancellation and stale-success probes require BENCH_MODES=sliced only.');
}
if (isolatedProbes.length && process.env.BENCH_SCENARIOS && process.env.BENCH_SCENARIOS !== 'early-visible') {
  throw new TypeError('Cancellation and stale-success probes require BENCH_SCENARIOS=early-visible.');
}
const modes = isolatedProbes.length ? ['sliced'] : ['legacy', ...requestedModes.filter(mode => mode !== 'legacy')];
const scenarios = isolatedProbes.length ? ['early-visible'] : parseScenarioSelection(process.env.BENCH_SCENARIOS ?? 'small');
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
  'scripts/dev/page-translation/e2e-benchmark/run.mjs',
  'scripts/dev/page-translation/e2e-benchmark/fixture.mjs',
  'scripts/dev/page-translation/e2e-benchmark/metrics.mjs',
  'scripts/dev/page-translation/e2e-benchmark/build.mjs',
  'scripts/dev/page-translation/e2e-benchmark/build-environment.mjs',
  'scripts/dev/page-translation/e2e-benchmark/chrome.mjs',
  'scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs',
  'scripts/dev/page-translation/e2e-benchmark/content-entry.mjs',
  'scripts/dev/page-translation/e2e-benchmark/trace.mjs',
  'scripts/dev/page-translation/e2e-benchmark/measurement-lifecycle.mjs',
  'scripts/dev/page-translation/e2e-benchmark/artifact-writer.mjs',
  'scripts/dev/page-translation/e2e-benchmark/scenario-plan.mjs',
  'scripts/dev/page-translation/e2e-benchmark/cancellation-probes.mjs',
  'scripts/dev/page-translation/e2e-benchmark/successful-reply-probes.mjs',
  'scripts/dev/page-translation/e2e-benchmark/successful-reply-gate.mjs',
  'scripts/dev/page-translation/page-translation-e2e-runtime.test.js',
  'scripts/dev/page-translation/page-translation-e2e-measurement.test.js',
  'scripts/dev/page-translation/page-translation-e2e-large-page.test.js',
  'scripts/dev/page-translation/page-translation-e2e-artifact-writer.test.js',
  'scripts/dev/page-translation/page-translation-e2e-cancellation.test.js',
  'scripts/dev/page-translation/page-translation-e2e-stale-success.test.js',
  'scripts/dev/page-translation/page-translation-e2e-scheduler-stale-success.test.js',
  'scripts/dev/page-translation/page-translation-e2e-successful-reply-gate.test.js',
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
function mapStaleSuccessResponse(body, sessionId, sessionA, sessionB) {
  const owner = sessionId === sessionA ? 'A' : sessionId === sessionB ? 'B' : null;
  if (!owner) throw new Error(`Stale-success fixture received an unknown Page session: ${sessionId ?? 'missing'}`);
  return mapEdgeResponse(body).map(item => ({ translations: item.translations.map(translation => ({
    ...translation,
    text: `fixture translation ${owner}: ${translation.text.slice('fixture translation: '.length)}`,
  })) }));
}

const harness = {
  command: 'node scripts/dev/page-translation/e2e-benchmark/run.mjs',
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
  plannedMeasuredOrder: [],
  cleanupErrors: [],
  nonPerformanceProbes: {
    cancellationStaleResponse: {
      status: 'not-run',
      reason: 'Not implemented in this bounded pass; it needs a separate held-Fetch cancellation trial. No cancellation stale-write claim is made.',
    },
    ...(cancellationProbes.length ? { cancellation: { requested: cancellationProbes, cases: [] } } : {}),
    ...(staleSuccessProbes.length ? { successfulStaleReply: { requested: staleSuccessProbes, cases: [] } } : {}),
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

async function compileMode(mode, { successfulReplyGate = false } = {}) {
  const outputDir = await mkdtemp(resolve(tmpdir(), `page-translation-${mode}-`));
  buildDirs.push(outputDir);
  const built = { mode, outputDir, startedAt: now(), successfulReplyGate };
  try {
    const result = await buildBenchmarkExtension({
      outputDir,
      mode,
      workerEntry: resolve(root, 'scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs'),
      contentEntry: resolve(root, 'scripts/dev/page-translation/e2e-benchmark/content-entry.mjs'),
      successfulReplyGate,
      onBuildEnvironment: environment => { built.environment = environment; },
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

function validateHarnessBuildParity() {
  const parity = validateBuildParity(harness.builds, modes);
  harness.buildParity = parity;
  if (!parity.ok) throw new Error(`Build parity gate failed: ${parity.issues.join('; ')}`);
  return parity;
}

async function runTrial({ mode, scenario, ordinal, globalRunOrder, phase, extensionPath, fixtureConfig = createFixture(scenario), networkGuardProbe = false, cancellationProbe = null, staleSuccessProbe = null }) {
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
  const networkEventUnsubscribes = new Map();
  const requestHandlerJobs = new Set();
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

  const processRequestPaused = async (event, requestRecord, reservation) => {
    const { request, requestId } = event.params;
    const networkTarget = networkEventRouter?.targetForSession(event.sessionId) ?? null;
    requestRecord.targetSessionId = event.sessionId;
    requestRecord.targetId = networkTarget?.targetId ?? null;
    const classification = classifyTransportRequest(request, {
      fixtureOrigin: new URL(trial.fixture.url).origin,
      extensionOrigin: extensionOriginBySession.get(event.sessionId),
    });
    const send = sendBySession.get(event.sessionId);
    requestRecord.category = classification.kind;
    try {
      if (classification.kind === 'provider-translation') {
        const body = JSON.parse(request.postData ?? 'null');
        let responseBody = mapEdgeResponse(body);
        requestRecord.bodyLength = request.postData?.length ?? 0;
        requestRecord.bodyBytes = Buffer.byteLength(request.postData ?? '', 'utf8');
        requestRecord.batchSize = body.length;
        requestRecord.batchTexts = body;
        requestRecord.fixtureDelayMs = fixtureConfig.responseDelayMs;
        if (cancellationProbe || staleSuccessProbe) {
          const workerState = await evaluate(chrome, event.sessionId,
            'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
          const matchingRoots = workerState?.providerRoots?.filter(candidate => sameProviderTexts(candidate.texts, body)) ?? [];
          const activeRoots = matchingRoots.filter(candidate => candidate.status === 'pending' && candidate.controllerAborted === false);
          const roots = activeRoots.length ? activeRoots : matchingRoots;
          const physical = workerState?.ledger?.operations?.filter(operation => operation.kind === 'provider.physical'
            && sameProviderTexts(JSON.parse(operation.requestBody ?? 'null'), body)) ?? [];
          const root = roots.length === 1 ? roots[0] : null;
          if (staleSuccessProbe && !root) throw new Error(`Cannot map provider response to exactly one real Page root (matches=${roots.length}).`);
          const physicalCall = root && physical.find(operation => operation.messageId === root.messageId && operation.sessionId === root.sessionId);
          const controller = root && workerState.controllers?.find(candidate => candidate.messageId === root.messageId && candidate.sessionId === root.sessionId);
          const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
          if (staleSuccessProbe && (!physicalCall || !controller || targetIds.some(id => id === null))) {
            throw new Error('Cannot fulfill provider response without exact body/root/physical/controller fixture correlation.');
          }
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
            targetSessionId: requestRecord.targetSessionId,
            targetId: requestRecord.targetId,
          } : null;
          if (staleSuccessProbe) {
            if (!pageSession || !contentContext) throw new Error('Cannot prove Page scheduler owner before fulfilling provider response.');
            const ownerEvidence = await evaluate(chrome, pageSession,
              `(()=>({scheduler:window.__pageTranslationBenchmark.pageSessionSnapshot(),content:window.__pageTranslationBenchmark.cancellationSnapshot()}))()`, contentContext, false);
            const acceptedStart = ownerEvidence.content?.operations?.find(operation => operation.kind === 'lifecycle.delivery'
              && operation.sessionId === root.sessionId && operation.action === 'page-translate-start' && operation.accepted === true);
            const currentOwnerMatches = ownerEvidence.scheduler?.translationSessionId === root.sessionId
              && ownerEvidence.scheduler?.sessionContextOwned === true;
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
                ? await reservation.release('fail', { errorReason: 'Aborted', reason: 'A session invalidated before this sibling Fetch fulfilled' })
                : await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, event.sessionId);
              requestRecord.lateCancelledARelease = cancellation;
              requestRecord.response = { failed: true, reason: 'late-A-session-cancelled', endedAt: now() };
              return;
            }
            responseBody = mapStaleSuccessResponse(body, root.sessionId, cancellationControl.initialSessionId, cancellationControl.replacementSessionId);
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
            const shouldHold = cancellationControl.probe === 'stale-success'
              ? sessionId === cancellationControl.replacementSessionId && !cancellationControl.releaseReplacement
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
        if (cancellationProbe || staleSuccessProbe) {
          if (!networkEventRouter?.register(sessionId, targetInfo)) throw new Error(`Could not register Network observer target for CDP session ${sessionId}.`);
          trial.networkObserverTargets ??= {};
          trial.networkObserverTargets[sessionId] = networkEventRouter.targetForSession(sessionId);
          if (!networkEventUnsubscribes.has(sessionId)) {
            const unsubscribe = onEvent(networkEventRouter.observerForSession(sessionId));
            networkEventUnsubscribes.set(sessionId, unsubscribe);
          }
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
    if (cancellationProbe || staleSuccessProbe) {
      const workerInstrumentation = await evaluate(chrome, workerSession,
        'globalThis.__pageTranslationBenchmark.enableCancellationProbe()');
      (trial.cancellation ?? trial.staleSuccess).workerInstrumentation = workerInstrumentation;
      if (!workerInstrumentation?.enabled || !workerInstrumentation?.lifecycleRegistryObserved
          || workerInstrumentation.instrumentationErrors?.length) throw new Error('Worker cancellation/provider/controller instrumentation was not fully installed.');
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
    if (cancellationProbe || staleSuccessProbe) {
      const contentInstrumentation = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.enableCancellationProbe()', contentContext);
      (trial.cancellation ?? trial.staleSuccess).contentInstrumentation = contentInstrumentation;
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
    if (staleSuccessProbe) {
      trial.staleSuccess.initialDOMMetadata = await evaluate(chrome, pageSession,
        `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
      await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.armSuccessfulReplyProbe()', contentContext);
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

    if (staleSuccessProbe) {
      const expectedIds = fixtureConfig.targets.map(target => target.id);
      const sourceToId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
      const snapshotContent = async owner => {
        const snapshot = await evaluate(chrome, pageSession,
          `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, contentContext, false);
        if (snapshot?.instrumentationErrors?.length) throw new Error(`Content ownership instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
        return snapshot;
      };
      const snapshotWorker = async (owner, messageIds = [], sessionIds = []) => {
        const snapshot = await evaluate(chrome, workerSession,
          `(()=>({probe:globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)}),resources:globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(messageIds)},${JSON.stringify(sessionIds)})}))()`, undefined, false);
        if (snapshot?.probe?.instrumentationErrors?.length) throw new Error(`Worker ownership instrumentation failed: ${snapshot.probe.instrumentationErrors.join('; ')}`);
        return snapshot;
      };
      const snapshotDom = async label => {
        const dom = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
        const metadata = await evaluate(chrome, pageSession,
          `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
        const value = { at: now(), dom, metadata };
        trial.staleSuccess.domSnapshots[label] = value;
        return value;
      };
      const captureReplyProbeSnapshot = async label => {
        const snapshot = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
        trial.staleSuccess.replyGate.probeSnapshots ??= [];
        trial.staleSuccess.replyGate.probeSnapshots.push({ label, at: now(), snapshot });
        return snapshot;
      };
      const sendCommand = async (action, data) => {
        const command = { action, ...(data === undefined ? {} : { data }) };
        const sentAt = now();
        const response = await evaluate(chrome, pageSession,
          `chrome.runtime.sendMessage(${JSON.stringify(command)})`, contentContext);
        const value = { action, sentAt, respondedAt: now(), response };
        trial.staleSuccess.commands.push(value);
        trial.commands.push(value);
        return response;
      };
      const eventForSession = async (actions, owner) => until(async () => {
        const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
        trial.lifecycle = events;
        const event = events.find(item => actions.some(action => isSessionEvent(item, action, owner)));
        return event ?? null;
      }, 45_000);
      const acceptedLifecycle = async (action, owner) => until(async () => {
        const content = await snapshotContent(owner);
        return content.operations.find(operation => operation.kind === 'lifecycle.delivery'
          && operation.sessionId === owner && operation.action === action && operation.accepted === true) ?? null;
      }, 15_000);
      const pollGate = async () => until(async () => {
        const snapshot = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
        if (['failed', 'timed-out', 'closed'].includes(snapshot?.gate?.status)) {
          throw new Error(`Successful reply gate failed before capture: ${snapshot.gate.error ?? snapshot.gate.status}`);
        }
        return snapshot?.gate?.captured ? snapshot : null;
      }, 45_000);

      const sessionIdA = sessionId;
      trial.staleSuccess.sessionA = sessionIdA;
      const startA = await acceptedLifecycle('page-translate-start', sessionIdA);
      let causalOrder = 0;
      const captured = await pollGate();
      if (cancellationControl.initialSessionId !== sessionIdA) throw new Error('A provider request owner did not match the trusted PAGE_TRANSLATE session ID.');
      const selected = captured.selectedBatch;
      const capturedMessage = captured.capturedMessage;
      if (selected?.members?.some(member => !sourceToId.has(member.text))) throw new Error('Selected A batch contains unknown fixture text.');
      const captureValidation = validateSuccessfulReplyCapture({
        expectedSessionId: sessionIdA,
        selectedBatch: selected,
        capturedMessage,
        gateSnapshot: captured.gate,
      });
      trial.staleSuccess.replyGate = { snapshot: captured, validation: captureValidation, startLifecycle: startA };
      if (!captureValidation.ok) throw new Error(`Successful reply capture gate failed: ${captureValidation.issues.join('; ')}`);

      const firstBatchIds = selected.members.map(member => sourceToId.get(member.text));
      if (new Set(firstBatchIds).size !== firstBatchIds.length || firstBatchIds.length !== 25) {
        throw new Error(`First captured A batch must contain 25 unique fixture IDs; observed ${firstBatchIds.length}.`);
      }
      const workerAtCapture = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
      const rootA = workerAtCapture.probe.providerRoots.find(root => root.messageId === capturedMessage.messageId && root.sessionId === sessionIdA);
      const physicalA = workerAtCapture.probe.ledger.operations.find(operation => operation.kind === 'provider.physical'
        && operation.messageId === capturedMessage.messageId && operation.sessionId === sessionIdA);
      const requestA = trial.requests.find(request => request.category === 'provider-translation'
        && JSON.stringify(request.batchTexts) === JSON.stringify(selected.members.map(member => member.text)));
      if (!requestA || requestA.response?.status !== 200 || rootA?.status !== 'fulfilled' || physicalA?.status !== 'fulfilled') {
        throw new Error('A source transport/provider root/physical request did not positively fulfill before its successful runtime reply was gated.');
      }
      if (!requestA.targetSessionId || !requestA.targetId || !requestA.networkId) {
        throw new Error('A Fetch request lacks exact Network CDP session/target/networkId correlation.');
      }
      const networkCompletion = await until(() => {
        const matching = (trial.staleSuccess.networkEvents ?? []).filter(event => event.sessionId === requestA.targetSessionId
          && event.targetId === requestA.targetId && event.params?.requestId === requestA.networkId);
        if (!matching.some(event => ['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method))) return null;
        return validateWorkerNetworkCompletion({
          events: trial.staleSuccess.networkEvents,
          networkId: requestA.networkId,
          sessionId: requestA.targetSessionId,
          targetId: requestA.targetId,
        });
      }, 15_000);
      if (!networkCompletion.ok) throw new Error(`A Fetch Network completion proof failed: ${networkCompletion.issues.join('; ')}`);
      trial.staleSuccess.sourceSuccess = {
        request: requestA, providerRoot: rootA, physical: physicalA,
        networkSessionId: requestA.targetSessionId, networkTargetId: requestA.targetId,
        networkEvents: networkCompletion.matchedEvents, networkValidation: networkCompletion,
        worker: workerAtCapture,
      };

      const domBeforeInvalidation = await snapshotDom('before-invalidation');
      const acceptedBeforeInvalidation = (await snapshotContent(sessionIdA)).operations.filter(operation => operation.kind === 'scheduler.settlement'
        && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true);
      if (acceptedBeforeInvalidation.length || domBeforeInvalidation.dom.some(([id, text]) => text !== originalById.get(id))) {
        throw new Error('A acquired accepted translations before its first successful reply was invalidated; B cannot be required to translate all fixture targets.');
      }
      await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.beginSuccessfulReplyMutationCapture()', contentContext);
      trial.staleSuccess.rawMutationCaptureStarted = true;
      const invalidationCommand = staleSuccessProbe === 'restore'
        ? await sendCommand('page-restore')
        : await sendCommand('page-translate-stop-auto');
      const expectedTerminalAction = staleSuccessProbe === 'restore' ? 'page-restore-complete' : 'page-auto-restore-complete';
      if (!invalidationCommand?.success) throw new Error(formatCommandFailure(expectedTerminalAction, invalidationCommand));
      const terminalEvent = await eventForSession([expectedTerminalAction], sessionIdA);
      const invalidated = await until(async () => {
        const state = await snapshotContent(sessionIdA);
        const event = state.operations.find(operation => operation.kind === 'session.invalidation'
          && operation.sessionId === sessionIdA && operation.capturedSessionActive === false && operation.discoveryCancelled === true);
        return event ? { event, state } : null;
      }, 20_000);
      const invalidationSequence = invalidated.event.sequence;
      const invalidationOrder = ++causalOrder;
      const expectedDomAfterInvalidation = staleSuccessProbe === 'restore'
        ? fixtureConfig.targets.map(target => [target.id, target.source])
        : domBeforeInvalidation.dom;
      const afterInvalidation = await snapshotDom('after-invalidation-before-A-release');
      if (JSON.stringify(afterInvalidation.dom) !== JSON.stringify(expectedDomAfterInvalidation)) {
        throw new Error(`${staleSuccessProbe} changed DOM before the late A reply was released.`);
      }
      trial.staleSuccess.invalidation = { command: invalidationCommand, terminalEvent, event: invalidated.event, sequence: invalidationSequence, order: invalidationOrder, dom: afterInvalidation };

      const validateSourceDom = (snapshot, label) => {
        const issues = [];
        if (snapshot.dom.length !== fixtureConfig.targetCount) issues.push(`${label}: target count differs`);
        for (const [id, text] of snapshot.dom) if (originalById.get(id) !== text) issues.push(`${label}: ${id} is not original source text`);
        const initialAttributes = new Map(trial.staleSuccess.initialDOMMetadata.map(item => [item.id, item.attributes]));
        for (const target of snapshot.metadata) {
          const original = initialAttributes.get(target.id);
          if (!original || JSON.stringify([...target.attributes].sort(([a], [b]) => a.localeCompare(b)))
              !== JSON.stringify([...original].sort(([a], [b]) => a.localeCompare(b)))) issues.push(`${label}: ${target.id} attributes differ from source`);
        }
        return { ok: issues.length === 0, issues };
      };
      const schedulerStateEquals = (left, right) => left && right
        && ['translationSessionId', 'isTranslated', 'translatedCount', 'failedCount', 'totalTasks', 'activeFlushes',
          'sessionContextOwned', 'pendingSettlementCount', 'batchTimerActive', 'completionTimerActive', 'discoveryPending',
          'bridgeSessionOwned', 'bridgeSessionActive', 'bridgeDiscoveryPending', 'bridgeDiscoveryRunning', 'bridgeDiscoveryStarting',
          'bridgeDiscoveryQueueDepth', 'bridgeDiscoveryCancelled', 'bridgeDiscoveryFailed'].every(key => left[key] === right[key])
        && JSON.stringify(left.queueIds) === JSON.stringify(right.queueIds)
        && JSON.stringify(left.activeBatchIds) === JSON.stringify(right.activeBatchIds);
      const releaseAndProveA = async ({ replacement = null } = {}) => {
        const releaseOrder = ++causalOrder;
        const didRelease = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.releaseSuccessfulReplyProbe()', contentContext);
        if (didRelease !== true) throw new Error('Successful reply gate refused explicit release.');
        const aAfterRelease = await until(async () => {
          const probe = await evaluate(chrome, pageSession,
            'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
          const attempt = {
            observedAt: now(),
            replyProbeSnapshot: probe ?? null,
            gate: probe?.gate ?? null,
            selectedBatch: probe?.selectedBatch ?? null,
            capturedMessage: probe?.capturedMessage ?? null,
            staleGuard: probe?.staleGuard ?? null,
            guards: probe?.guards ?? [],
            guardDiagnostics: probe?.guardDiagnostics ?? [],
            guardInstallations: probe?.guardInstallations ?? [],
            instrumentationErrors: probe?.instrumentationErrors ?? [],
          };
          trial.staleSuccess.replyGate.afterReleaseAttempt = attempt;
          const content = await snapshotContent(sessionIdA);
          const allContent = await snapshotContent(undefined);
          const targetBatchSettled = allContent.operations.some(operation => operation.kind === 'scheduler.batch'
            && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
            && JSON.stringify(operation.targetIds) === JSON.stringify(firstBatchIds));
          attempt.events = probe?.events ?? [];
          attempt.schedulerBatchSettled = targetBatchSettled;
          attempt.contentPendingOperations = content.pendingOperations ?? null;
          return probe?.gate?.settled && probe.gate.deliveryIdentity?.responseIdentityPreserved === true
            && content.pendingOperations === 0 && targetBatchSettled
            ? { probe, content, allContent } : null;
        }, 30_000);
        const gate = aAfterRelease.probe.gate;
        const gateWithOrder = { ...gate, releaseOrder };
        const guard = aAfterRelease.probe.staleGuard;
        const allOperations = aAfterRelease.allContent.operations;
        const aAccepted = allOperations.filter(operation => operation.kind === 'scheduler.settlement'
          && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true
          && operation.sequence > invalidationSequence).map(operation => operation.id);
        const postInvalidation = validatePostInvalidationEvidence({
          sessionId: sessionIdA, invalidationSequence, operations: allOperations,
          duplicateAcceptedIds: aAfterRelease.content.mutationSnapshot?.duplicateAcceptedIds ?? [],
          allowedMutationOwners: replacement ? [replacement.sessionId] : [],
        });
        const domAfterAReply = await snapshotDom('after-A-reply-while-B-pending');
        const unexpectedTexts = domAfterAReply.dom.filter(([id, text]) => text !== originalById.get(id)
          && !(replacement && text.startsWith('\u200efixture translation B: ')));
        const lateLifecycle = allOperations.filter(operation => operation.sessionId === sessionIdA
          && operation.sequence > invalidationSequence
          && ['lifecycle.emission', 'lifecycle.delivery'].includes(operation.kind)
          && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action));
        const acceptedLateLifecycle = lateLifecycle.filter(operation => operation.kind !== 'lifecycle.delivery' || operation.accepted !== false);
        const batchSettlements = allOperations.filter(operation => operation.kind === 'scheduler.batch'
          && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
          && JSON.stringify(operation.targetIds) === JSON.stringify(firstBatchIds));
        const issues = [];
        if (!batchSettlements.length) issues.push('A scheduler batch did not fulfill after its stale ownership guard');
        if (!postInvalidation.ok) issues.push(...postInvalidation.issues);
        if (unexpectedTexts.length) issues.push(`A/non-B translated values appeared after reply release: ${unexpectedTexts.map(([id]) => id).join(',')}`);
        if (acceptedLateLifecycle.length) issues.push('A emitted or delivered progress/completion lifecycle after invalidation');
        if (aAccepted.length) issues.push(`A accepted IDs after invalidation: ${aAccepted.join(',')}`);

        let bEvidence = null;
        let bStillPending = false;
        let bStable = true;
        let bAttribution = null;
        if (replacement) {
          // Take the worker snapshot BEFORE the content-side snapshot/send log so the send log is never older than the worker evidence.
          const workerAfter = await snapshotWorker(replacement.sessionId, [capturedMessage.messageId, replacement.messageId], [sessionIdA, replacement.sessionId]);
          const [schedulerAfter, probeSnapshot] = await Promise.all([
            evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
            evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false),
          ]);
          const rootAfter = workerAfter.probe.providerRoots.find(root => root.messageId === replacement.messageId && root.sessionId === replacement.sessionId);
          const controllerAfter = workerAfter.probe.controllers.find(controller => controller.messageId === replacement.messageId && controller.sessionId === replacement.sessionId);
          const sentByB = (probeSnapshot?.sentPageBatches ?? [])
            .filter(entry => entry?.sessionId === replacement.sessionId && typeof entry?.messageId === 'string')
            .map(entry => entry.messageId);
          const allowedConcurrentMessageIds = [...new Set(sentByB)].filter(id => id !== replacement.messageId);
          const stability = validateReplacementStability({
            schedulerBefore: replacement.scheduler, schedulerAfter: schedulerAfter,
            resourcesBefore: replacement.worker.resources, resourcesAfter: workerAfter.resources,
            providerRootAfter: rootAfter, controllerAfter, heldRequest: replacement.held,
            sessionId: replacement.sessionId, messageId: replacement.messageId,
            terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, replacement.sessionId],
            allowedConcurrentMessageIds,
          });
          bStable = stability.ownership;
          bStillPending = stability.pending;
          if (!stability.ok) issues.push(...stability.issues);
          if (!bStable) issues.push('B session ownership, provider request, or resource state is invalid during A reply release');
          bEvidence = { scheduler: schedulerAfter, worker: workerAfter, root: rootAfter, controller: controllerAfter, stability };
          bAttribution = { allowedConcurrentMessageIds, sentPageBatches: probeSnapshot?.sentPageBatches ?? [] };
        }
        const gateReleasedAt = aAfterRelease.probe.events.find(event => event.name === 'gate' && event.event?.type === 'released')?.at ?? null;
        const gateForValidation = { ...gateWithOrder, releasedAt: gateReleasedAt };
        const proof = validateStaleSuccessEvidence({
          gate: gateForValidation,
          invalidation: { confirmed: invalidationSequence > 0, order: invalidationOrder },
          guard, batch: { ...capturedMessage, sessionId: sessionIdA },
          acceptedAIds: aAccepted, acceptedBIds: [], expectedIds: [], domValues: [], lateLifecycle: acceptedLateLifecycle,
          bStillPending, schedulerBatchSettled: batchSettlements.length > 0,
          postInvalidationOk: postInvalidation.ok, domNoUnexpectedWrites: unexpectedTexts.length === 0,
          bStateStable: bStable, requireBPending: !!replacement,
        });
        issues.push(...proof.issues);
        proof.issues = [...new Set(issues)];
        proof.ok = proof.issues.length === 0;
        return {
          probe: aAfterRelease.probe, gate: gateForValidation, guard, operations: allOperations,
          acceptedAIds: aAccepted, postInvalidation, lateLifecycle, batchSettlements,
          domAfterAReply, bEvidence, bAttribution, bStillPending, bStable, validation: proof,
        };
      };

      if (staleSuccessProbe !== 'replacement') {
        const schedulerBeforeRelease = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
        const beforeDrain = await until(async () => {
          const worker = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
          const validation = validateRuntimeResources(worker.resources, {
            terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
          });
          return worker.probe.ledger.pending === 0 && !worker.probe.providerRoots.some(root => root.status === 'pending') && validation.ok
            ? { worker, validation } : null;
        }, 15_000);
        const workerBeforeRelease = beforeDrain.worker;
        const resourceValidation = beforeDrain.validation;
        const aProof = await releaseAndProveA();
        const schedulerAfterRelease = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
        const afterDrain = await until(async () => {
          const worker = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
          const validation = validateRuntimeResources(worker.resources, {
            terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
          });
          return worker.probe.ledger.pending === 0 && !worker.probe.providerRoots.some(root => root.status === 'pending') && validation.ok
            ? { worker, validation } : null;
        }, 15_000);
        const workerAfterRelease = afterDrain.worker;
        const afterResources = afterDrain.validation;
        const sourceDomValidation = validateSourceDom(aProof.domAfterAReply, `${staleSuccessProbe}-after-A-reply`);
        if (!schedulerStateEquals(schedulerBeforeRelease, schedulerAfterRelease)) aProof.validation.issues.push('Stop/Restore scheduler state changed when stale A reply settled');
        aProof.validation.issues.push(...resourceValidation.issues, ...afterResources.issues, ...sourceDomValidation.issues);
        aProof.validation.ok = aProof.validation.issues.length === 0;
        trial.staleSuccess.replyGate = { ...trial.staleSuccess.replyGate, afterRelease: aProof.probe, releaseOrder: aProof.gate.releaseOrder };
        trial.staleSuccess.ownershipProof = {
          ...aProof, guardDiagnostics: aProof.probe.guardDiagnostics,
          bridgeGuard: { observed: false, reason: 'No direct Bridge guard instrumentation is installed; only the exact scheduler ownership guard is claimed.' },
          schedulerBeforeRelease, schedulerAfterRelease,
          workerBeforeRelease, workerAfterRelease,
          resourceValidationBefore: resourceValidation, resourceValidationAfter: afterResources,
          sourceDOMValidation: sourceDomValidation,
        };
        if (!aProof.validation.ok) throw new Error(`${staleSuccessProbe} stale-reply proof failed: ${aProof.validation.issues.join('; ')}`);
        if (staleSuccessProbe === 'stop') {
          const cleanupRestore = await sendCommand('page-restore');
          if (!cleanupRestore?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after stop-only stale-success proof', cleanupRestore));
          trial.staleSuccess.restoreTerminal = await eventForSession(['page-restore-complete'], sessionIdA);
        }
        const noBFinalDrain = await until(async () => {
          const [content, worker] = await Promise.all([
            snapshotContent(undefined),
            snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]),
          ]);
          const validation = validateRuntimeResources(worker.resources, {
            terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
          });
          return content.pendingOperations === 0 && worker.probe.ledger.pending === 0
            && !worker.probe.providerRoots.some(root => root.status === 'pending')
            && requestHandlerJobs.size === 0 && validation.ok
            ? { content, worker, validation } : null;
        }, 15_000);
        const restored = await snapshotDom(`${staleSuccessProbe}-final-source`);
        const finalSourceValidation = validateSourceDom(restored, `${staleSuccessProbe}-final-source`);
        if (!finalSourceValidation.ok) throw new Error(finalSourceValidation.issues.join('; '));
        if (staleSuccessProbe === 'restore') trial.staleSuccess.restoreTerminal = terminalEvent;
        trial.staleSuccess.finalOwnership = { acceptedAIds: aProof.acceptedAIds, acceptedBIds: [], finalDOM: restored, validation: finalSourceValidation };
        trial.rawDOM.original = originals;
        trial.rawDOM.translated = domBeforeInvalidation.dom;
        trial.rawDOM.restored = restored.dom;
        trial.staleSuccess.finalResources = { before: workerBeforeRelease.resources, after: noBFinalDrain.worker.resources, validation: noBFinalDrain.validation };
        trial.staleSuccess.networkProof = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
          batchSize: request.batchSize, batchTexts: request.batchTexts, response: request.response,
          correlation: request.cancellationCorrelation, correlationIssues: request.cancellationCorrelationIssues,
        }));
        trial.status = 'passed';
        return trial;
      }

      cancellationControl.replacementSessionId = null;
      await evaluate(chrome, pageSession, "window.__pageTranslationBenchmark.translationPrefix='fixture translation B:'", contentContext);
      const startBResponse = await sendCommand('page-translate', {
        provider: 'edge', targetLanguage: 'fr', isAuto: true, preserveAcceptedTranslations: true,
      });
      if (!startBResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE replacement B', startBResponse));
      const sessionIdB = sessionIdFromStart(startBResponse);
      if (!sessionIdB || sessionIdB === sessionIdA) throw new Error('Replacement B must have a trusted distinct session ID.');
      trial.staleSuccess.sessionB = sessionIdB;
      const startB = await acceptedLifecycle('page-translate-start', sessionIdB);
      await captureReplyProbeSnapshot('trusted-B-start');
      const managerEvents = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.events.filter(event=>event.name==="manager.translatePage.entry")', contentContext, false);
      if (managerEvents.at(-1)?.isAuto !== true) throw new Error('Replacement B did not use the normal auto/preserve start path.');
      const heldBLock = await until(() => {
        const held = cancellationControl.heldRequests
          .filter(item => item.pageSessionId === sessionIdB && !item.record.released).map(item => item.record)[0] ?? null;
        return held && cancellationControl.replacementSessionId === sessionIdB
          ? { held, lockedSessionId: cancellationControl.replacementSessionId, lockedAt: now() }
          : null;
      }, 45_000);
      const heldB = heldBLock.held;
      if (cancellationControl.replacementSessionId !== sessionIdB || heldB.pageSessionId !== sessionIdB) {
        throw new Error('B held Fetch did not match the exact trusted replacement session ID.');
      }
      trial.staleSuccess.replacementOwnerLock = {
        sessionId: heldBLock.lockedSessionId,
        observedAt: heldBLock.lockedAt,
        assignmentEvidence: 'first matching provider root was correlated to accepted B lifecycle and current B scheduler before Fetch was held',
        heldFetch: { requestId: heldB.requestId, networkId: heldB.networkId, targetSessionId: heldB.sessionId, targetId: heldB.targetId },
      };
      await captureReplyProbeSnapshot('B-first-provider-fetch-held');
      const workerAtB = await snapshotWorker(sessionIdB, [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]);
      const rootB = workerAtB.probe.providerRoots.find(root => root.messageId === heldB.batchMessageId && root.sessionId === sessionIdB);
      const controllerB = workerAtB.probe.controllers.find(controller => controller.messageId === heldB.batchMessageId && controller.sessionId === sessionIdB);
      const trustedBStart = await acceptedLifecycle('page-translate-start', sessionIdB);
      if (!heldB || heldB.controllerAbortedAtPause !== false || heldB.providerRootStatusAtPause !== 'pending'
          || rootB?.status !== 'pending' || controllerB?.aborted !== false || !trustedBStart) {
        throw new Error('B was not a distinct trusted active owner with its first real physical provider request held.');
      }
      const bFirstBatchIds = heldB.targetIds;
      if (!Array.isArray(bFirstBatchIds) || bFirstBatchIds.length !== 25 || new Set(bFirstBatchIds).size !== 25
          || bFirstBatchIds.some(id => !expectedIds.includes(id))) {
        throw new Error('B first physical request is not 25 distinct known fixture IDs.');
      }
      const overlapAIds = bFirstBatchIds.filter(id => firstBatchIds.includes(id));
      if (!overlapAIds.length) throw new Error('B first batch did not overlap any unaccepted A target, so it cannot challenge stale-write interference.');
      trial.staleSuccess.replacementOverlap = { aFirstBatchIds: firstBatchIds, bFirstBatchIds, overlapIds: overlapAIds };
      const bDiscoveryWait = trial.staleSuccess.bDiscoveryWait = { observations: [] };
      const bDiscoveryCheckpoint = await until(async () => {
        const [scheduler, content] = await Promise.all([
          evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
          snapshotContent(sessionIdB),
        ]);
        const validation = validateReplacementDiscoverySnapshot({
          snapshot: scheduler,
          sessionId: sessionIdB,
          targetCount: fixtureConfig.targetCount,
          firstBatchSize: bFirstBatchIds.length,
          settlementOperations: content.operations,
        });
        const observation = { at: now(), scheduler, validation };
        if (bDiscoveryWait.observations.length < 64) bDiscoveryWait.observations.push(observation);
        else bDiscoveryWait.observations[bDiscoveryWait.observations.length - 1] = observation;
        return validation.ok ? { scheduler, content, validation } : null;
      }, 20_000);
      trial.staleSuccess.bDiscoveryCheckpoint = bDiscoveryCheckpoint;
      const bAttributedMessageIds = async () => {
        const snapshot = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
        return [...new Set((snapshot?.sentPageBatches ?? [])
          .filter(entry => entry?.sessionId === sessionIdB && typeof entry?.messageId === 'string')
          .map(entry => entry.messageId))];
      };
      const bContentBeforeRelease = await snapshotContent(sessionIdB);
      const bSchedulerBeforeRelease = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
      const bResourcesBeforeRelease = workerAtB.resources;
      const bAllowedIds = (await bAttributedMessageIds()).filter(id => id !== heldB.batchMessageId);
      const bResourceValidation = validateRuntimeResources(bResourcesBeforeRelease, {
        activeMessageId: heldB.batchMessageId, terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, sessionIdB],
        additionalAllowedMessageIds: bAllowedIds,
      });
      const bLeaseHeld = bResourcesBeforeRelease.lease?.activeOperationIds?.includes(heldB.batchMessageId) === true;
      const bTrackedRequest = bResourcesBeforeRelease.service?.requests?.find(request => request.messageId === heldB.batchMessageId) ?? null;
      trial.staleSuccess.bLeaseDiagnostic = {
        fetchSessionId: heldB.sessionId,
        pageSessionId: heldB.pageSessionId,
        fetchTargetId: heldB.targetId,
        fetchNetworkId: heldB.networkId,
        providerMessageId: heldB.batchMessageId,
        serviceRequest: bTrackedRequest,
        leaseSnapshot: bResourcesBeforeRelease.lease ?? null,
        exactMessageIdHeld: bLeaseHeld,
        allowedConcurrentMessageIds: bAllowedIds,
      };
      const aGateBeforeRelease = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
      if (aGateBeforeRelease?.gate?.status !== 'captured' || aGateBeforeRelease.gate.settled || !aGateBeforeRelease.gate.pending) {
        throw new Error('A genuine successful reply was not still held before B ownership was established.');
      }
      if (!bLeaseHeld || !bResourceValidation.ok) {
        throw new Error(`B runtime resource proof failed for exact provider message ${heldB.batchMessageId}: ${bResourceValidation.issues.join('; ') || `active lease IDs=${JSON.stringify(bResourcesBeforeRelease.lease?.activeOperationIds ?? null)}`}`);
      }
      await captureReplyProbeSnapshot('B-lease-validated-before-A-release');
      const workerImmediatelyBeforeRelease = await snapshotWorker(sessionIdB,
        [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]);
      const rootImmediatelyBeforeRelease = workerImmediatelyBeforeRelease.probe.providerRoots.find(root => root.messageId === heldB.batchMessageId && root.sessionId === sessionIdB);
      const controllerImmediatelyBeforeRelease = workerImmediatelyBeforeRelease.probe.controllers.find(controller => controller.messageId === heldB.batchMessageId && controller.sessionId === sessionIdB);
      const schedulerImmediatelyBeforeRelease = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
      const bAllowedIdsNow = (await bAttributedMessageIds()).filter(id => id !== heldB.batchMessageId);
      const resourcesImmediatelyBeforeRelease = validateRuntimeResources(workerImmediatelyBeforeRelease.resources, {
        activeMessageId: heldB.batchMessageId, terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, sessionIdB],
        additionalAllowedMessageIds: bAllowedIdsNow,
      });
      const bSchedulerCurrentAtRelease = schedulerImmediatelyBeforeRelease?.translationSessionId === sessionIdB
        && schedulerImmediatelyBeforeRelease?.isTranslated === true
        && schedulerImmediatelyBeforeRelease?.sessionContextOwned === true
        && Number.isFinite(schedulerImmediatelyBeforeRelease?.translatedCount)
        && Number.isFinite(schedulerImmediatelyBeforeRelease?.failedCount)
        && Number.isFinite(schedulerImmediatelyBeforeRelease?.totalTasks)
        && Number.isFinite(schedulerImmediatelyBeforeRelease?.activeFlushes)
        && Number.isInteger(schedulerImmediatelyBeforeRelease?.pendingSettlementCount)
        && typeof schedulerImmediatelyBeforeRelease?.batchTimerActive === 'boolean'
        && typeof schedulerImmediatelyBeforeRelease?.completionTimerActive === 'boolean'
        && Array.isArray(schedulerImmediatelyBeforeRelease?.queueIds)
        && Array.isArray(schedulerImmediatelyBeforeRelease?.activeBatchIds);
      await captureReplyProbeSnapshot('immediately-before-A-release');
      trial.staleSuccess.bImmediatelyBeforeARelease = {
        root: rootImmediatelyBeforeRelease,
        controller: controllerImmediatelyBeforeRelease,
        schedulerAtFirstSnapshot: bSchedulerBeforeRelease,
        schedulerImmediatelyBeforeRelease,
        resourcesImmediatelyBeforeRelease: workerImmediatelyBeforeRelease.resources,
        resourcesValidation: resourcesImmediatelyBeforeRelease,
        allowedConcurrentMessageIds: bAllowedIdsNow,
        schedulerOwnedAndInspectable: bSchedulerCurrentAtRelease,
      };
      if (rootImmediatelyBeforeRelease?.status !== 'pending' || controllerImmediatelyBeforeRelease?.aborted !== false
          || !bSchedulerCurrentAtRelease || !resourcesImmediatelyBeforeRelease.ok) {
        throw new Error(`B owner/resource snapshot invalid immediately before A release: ${JSON.stringify({ rootStatus: rootImmediatelyBeforeRelease?.status ?? null, controllerAborted: controllerImmediatelyBeforeRelease?.aborted ?? null, schedulerOwnedAndInspectable: bSchedulerCurrentAtRelease, issues: resourcesImmediatelyBeforeRelease.issues })}`);
      }
      trial.staleSuccess.bActiveAtARelease = {
        start: startB,
        heldRequest: heldB,
        root: rootB,
        controller: controllerB,
        trustedStart: trustedBStart,
        schedulerAtFirstSnapshot: bSchedulerBeforeRelease,
        scheduler: schedulerImmediatelyBeforeRelease,
        content: bContentBeforeRelease,
        resourcesAtFirstSnapshot: bResourcesBeforeRelease,
        resourceValidationAtFirstSnapshot: bResourceValidation,
        immediatelyBeforeRelease: {
          root: rootImmediatelyBeforeRelease,
          controller: controllerImmediatelyBeforeRelease,
          scheduler: schedulerImmediatelyBeforeRelease,
          resources: workerImmediatelyBeforeRelease.resources,
          resourceValidation: resourcesImmediatelyBeforeRelease,
        },
      };
      const aProof = await releaseAndProveA({
        replacement: { sessionId: sessionIdB, held: heldB, messageId: heldB.batchMessageId, worker: workerImmediatelyBeforeRelease, scheduler: schedulerImmediatelyBeforeRelease },
      });
      trial.staleSuccess.replyGate = { ...trial.staleSuccess.replyGate, afterRelease: aProof.probe, releaseOrder: aProof.gate.releaseOrder };
      trial.staleSuccess.ownershipProof = {
        ...aProof,
        guardDiagnostics: aProof.probe.guardDiagnostics,
        bridgeGuard: { observed: false, reason: 'No direct Bridge guard instrumentation is installed; only the exact scheduler ownership guard is claimed.' },
        sourceRootA: rootA, physicalA,
      };
      if (!aProof.validation.ok) throw new Error(`Stale successful reply ownership gate failed: ${aProof.validation.issues.join('; ')}`);

      const heldControl = cancellationControl.heldRequests.find(item => item.record === heldB);
      if (!heldControl) throw new Error('B held Fetch is not owned by trial cleanup lifecycle.');
      cancellationControl.releaseReplacement = true;
      for (const control of cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB && !item.record.released)) {
        const request = trial.requests.find(item => item.heldFetch === control.record);
        await control.reservation.release('fulfill', {
          body: mapStaleSuccessResponse(request.batchTexts, sessionIdB, sessionIdA, sessionIdB),
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        });
        control.record.released = true;
      }
      await eventForSession(['page-translate-complete', 'page-translate-idle'], sessionIdB);
      const bTerminal = await until(async () => {
        const content = await snapshotContent(sessionIdB);
        const accepted = content.operations.filter(operation => operation.kind === 'scheduler.settlement'
          && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
        return accepted.length === expectedIds.length ? { content, accepted } : null;
      }, 60_000);
      const finalDom = await snapshotDom('after-B-complete');
      const expectedTranslated = new Map(fixtureConfig.targets.map(target => [target.id, `\u200efixture translation B: ${target.source}`]));
      const domIssues = finalDom.dom.flatMap(([id, text]) => expectedTranslated.get(id) === text ? [] : [`${id} did not contain B-prefixed text`]);
      const acceptedCounts = new Map();
      for (const id of bTerminal.accepted) acceptedCounts.set(id, (acceptedCounts.get(id) ?? 0) + 1);
      const bIssues = expectedIds.filter(id => acceptedCounts.get(id) !== 1).map(id => `${id} accepted ${acceptedCounts.get(id) ?? 0} times by B`);
      const aAfterB = bTerminal.content.operations.filter(operation => operation.kind === 'scheduler.settlement'
        && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
      if (domIssues.length || bIssues.length || aAfterB.length || finalDom.dom.length !== fixtureConfig.targetCount) {
        throw new Error(`Final A/B ownership invalid: ${[...domIssues, ...bIssues, ...aAfterB.map(id => `A accepted ${id}`)].join('; ')}`);
      }
      trial.staleSuccess.finalOwnership = {
        acceptedAIds: aAfterB,
        acceptedBIds: bTerminal.accepted,
        finalDOM: finalDom,
        validation: { ok: true, issues: [] },
      };
      const restoreResponse = await sendCommand('page-restore');
      if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after stale-success B', restoreResponse));
      trial.staleSuccess.restoreTerminal = await eventForSession(['page-restore-complete'], sessionIdB);
      const restored = await snapshotDom('after-B-restore');
      const restoreIssues = restored.dom.flatMap(([id, text]) => originalById.get(id) === text ? [] : [`${id} was not restored to its source`]);
      const initialAttributes = new Map(trial.staleSuccess.initialDOMMetadata.map(target => [target.id, target.attributes]));
      for (const target of restored.metadata) {
        if (JSON.stringify([...target.attributes].sort(([a], [b]) => a.localeCompare(b)))
            !== JSON.stringify([...(initialAttributes.get(target.id) ?? [])].sort(([a], [b]) => a.localeCompare(b)))) {
          restoreIssues.push(`${target.id} attributes were not restored exactly`);
        }
      }
      const finalDrain = await until(async () => {
        const [worker, content] = await Promise.all([
          snapshotWorker(sessionIdB, [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]),
          snapshotContent(undefined),
        ]);
        const validation = validateRuntimeResources(worker.resources, {
          terminalMessageIds: [capturedMessage.messageId, heldB.batchMessageId], sessionIds: [sessionIdA, sessionIdB], final: true,
        });
        return worker.probe.ledger.pending === 0 && content.pendingOperations === 0
          && !worker.probe.providerRoots.some(root => root.status === 'pending')
          && requestHandlerJobs.size === 0 && validation.ok
          ? { worker, content, validation } : null;
      }, 15_000);
      const workerFinal = finalDrain.worker;
      const runtimeResources = finalDrain.validation;
      const resourceIssues = runtimeResources.issues;
      if (restored.dom.length !== fixtureConfig.targetCount || restoreIssues.length) {
        throw new Error(`Final Restore failed: ${restoreIssues.join('; ')}`);
      }
      trial.staleSuccess.finalResources = { worker: workerFinal, validation: { ok: resourceIssues.length === 0, issues: resourceIssues } };
      if (resourceIssues.length) throw new Error(`Runtime resources did not drain: ${resourceIssues.join('; ')}`);
      trial.rawDOM.original = originals;
      trial.rawDOM.translated = finalDom.dom;
      trial.rawDOM.restored = restored.dom;
      trial.staleSuccess.networkProof = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
        batchSize: request.batchSize, batchTexts: request.batchTexts, response: request.response,
        correlation: request.cancellationCorrelation, correlationIssues: request.cancellationCorrelationIssues,
      }));
      const failedProviderResponse = trial.requests.find(request => request.category === 'provider-translation'
        && !request.lateCancelledA && request.response?.status !== 200);
      if (failedProviderResponse) throw new Error('A or B provider request did not receive a fixture HTTP 200 response.');
      if (trial.staleSuccess.observationErrors.length) throw new Error(`Stale-success instrumentation had errors: ${JSON.stringify(trial.staleSuccess.observationErrors)}`);
      if (trial.requests.some(request => request.category === 'blocked')) throw new Error('Unexpected external request blocked during stale-success probe.');
      trial.staleSuccess.cleanup.pendingFetches = cancellationControl.heldRequests.filter(item => !item.record.handlerSettled).length;
      if (trial.staleSuccess.cleanup.pendingFetches) throw new Error('Stale-success probe ended with pending held Fetch handlers.');
      trial.status = 'passed';
      return trial;
    }

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
          && event.sessionId === held.sessionId && event.targetId === held.targetId
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
        events: trial.cancellation.networkEvents.filter(event => event.sessionId === request.sessionId
          && event.targetId === request.targetId && event.params?.requestId === request.networkId),
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
    if (staleSuccessProbe && chrome && pageSession && contentContext) {
      const sendCleanupCommand = async (action, reason) => {
        const sentAt = now();
        const message = { action };
        const response = await evaluate(chrome, pageSession,
          `chrome.runtime.sendMessage(${JSON.stringify(message)})`, contentContext);
        const command = { action, reason: reason ?? null, sentAt, respondedAt: now(), response };
        trial.staleSuccess.cleanup.commands ??= [];
        trial.staleSuccess.cleanup.commands.push(command);
        return response;
      };
      const readReplyProbeSnapshot = async () => {
        try {
          const snapshot = await evaluate(chrome, pageSession,
            'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
          return snapshot && typeof snapshot === 'object' && Object.prototype.hasOwnProperty.call(snapshot, 'gate')
            ? { available: true, snapshot }
            : { available: false, snapshot: null, error: 'probe returned no snapshot object' };
        } catch (error) { return { available: false, snapshot: null, error: error.message }; }
      };
      const capturedAId = async () => {
        const probe = trial.staleSuccess.sessionA || trial.sessionId
          ? null : await readReplyProbeSnapshot();
        const evidence = resolveCleanupSessionEvidence({
          knownSessionId: trial.staleSuccess.sessionA ?? trial.sessionId ?? null,
          snapshotAvailable: probe?.available,
          replySnapshot: probe?.snapshot,
          pageStartAttempted: !!trial.timestamps.translationCommand,
        });
        if (!evidence.ok) throw new Error(`${evidence.issues.join('; ')}${probe?.error ? ` (${probe.error})` : ''}`);
        return evidence.sessionId;
      };
      const confirmedAInvalidation = async () => {
        let sessionIdA;
        try { sessionIdA = await capturedAId(); }
        catch (error) { return { ok: false, event: null, issues: [error.message] }; }
        if (!sessionIdA) return { ok: true, event: null, issues: [], noGatePendingProof: true };
        const read = async () => {
          const state = await evaluate(chrome, pageSession,
            `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionIdA)})`, contentContext, false);
          return validateCleanupInvalidation({ sessionId: sessionIdA, operations: state?.operations });
        };
        try { return await until(async () => { const result = await read(); return result.ok ? result : null; }, 3_000); }
        catch { return read().catch(error => ({ ok: false, event: null, issues: [error.message] })); }
      };

      const cleanupAId = await capturedAId().catch(error => {
        trial.cleanupErrors.push(`Stale-success cleanup session evidence unavailable: ${error.message}`);
        return null;
      });
      const owner = trial.staleSuccess.sessionB ?? cleanupAId;
      const teardown = await teardownSuccessfulReplyGate({
        preferStopFirst: trial.status !== 'passed' && !!cleanupAId,
        restoreNeeded: !!cleanupAId && !trial.staleSuccess.restoreTerminal,
        stop: () => sendCleanupCommand('page-translate-stop-auto', 'harness-invalidation-cleanup'),
        restore: async () => {
          if (!owner) return { success: false, terminalObserved: false };
          const response = await sendCleanupCommand('page-restore', 'harness-cleanup');
          trial.staleSuccess.cleanup.restoreAttempt = { response, sessionId: owner };
          if (!response?.success) return { success: false, terminalObserved: false };
          const terminal = await until(async () => {
            const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
            return events.find(event => isSessionEvent(event, 'page-restore-complete', owner)) ?? null;
          }, 5_000);
          trial.staleSuccess.restoreTerminal = terminal;
          return { success: true, terminalObserved: !!terminal };
        },
        confirmInvalidation: confirmedAInvalidation,
        openGate: async () => {
          trial.staleSuccess.cleanup.replyProbeSnapshotBeforeClose = await evaluate(chrome, pageSession,
            'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
          trial.staleSuccess.cleanup.gateClosed = await evaluate(chrome, pageSession,
            `window.__pageTranslationBenchmark.closeSuccessfulReplyProbe('harness-cleanup')`, contentContext);
          trial.staleSuccess.cleanup.contentProbeClosed = trial.staleSuccess.cleanup.gateClosed;
        },
        disposeContext: async () => {
          if (!chrome) throw new Error('Chrome context is unavailable for fail-closed disposal');
          await chrome.close();
          trial.chromeStderr = chrome.metadata.stderr ?? null;
          staleContextDisposed = true;
          trial.staleSuccess.cleanup.contextDisposedBeforeGateOpen = true;
        },
      });
      trial.staleSuccess.cleanup.gateDisposition = teardown;
      trial.cleanupErrors.push(...teardown.errors.map(error => `Stale-success cleanup: ${error}`));
      if (!teardown.safeToOpen) {
        trial.cleanupErrors.push('Reply gate was not opened: Chrome context was disposed because A invalidation could not be confirmed.');
        if (trial.staleSuccess.rawMutationCaptureStarted && !trial.staleSuccess.rawMutationEvidence) {
          trial.cleanupErrors.push('Raw DOM mutation evidence could not be drained before unsafe-context disposal.');
        }
      }
    }
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
            if (trial.staleSuccess.rawMutationCaptureStarted && !messageIdA) throw new Error('A request ID is unavailable for final runtime resource drain.');
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
    const cleanups = [
      async () => requestUnsubscribe?.(),
      async () => eventUnsubscribe?.(),
      async () => pageEventUnsubscribe?.(),
      async () => { await Promise.all([...networkEventUnsubscribes.values()].map(unsubscribe => unsubscribe())); },
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
  if (!isolatedProbes.length) {
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
    harness.command = `BENCH_CANCELLATION_PROBES=${cancellationProbes.join(',')} BENCH_MODES=sliced node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
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
  } else if (staleSuccessProbes.length) {
    harness.command = `BENCH_STALE_SUCCESS_PROBES=${staleSuccessProbes.join(',')} BENCH_MODES=sliced BENCH_SCENARIOS=early-visible node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
    harness.warmups = 0;
    harness.measuredSamples = 0;
    harness.successfulReplyExecutionPlan = {
      mode: 'sliced', scenario: 'early-visible', cases: staleSuccessProbes.length,
      warmups: 0, performanceSamples: 0, performanceAggregation: false,
      perCase: 'A genuine successful safeSendMessage result is gated after production send/timeout/cancellation checks; B first HTTP request remains held while A reply is released.',
    };
    harness.comparisonOrdering = 'Dedicated Sliced-only successful stale-reply correctness probes; no performance aggregation or mode comparison is performed.';
    const slicedOutput = await compileMode('sliced');
    await runNetworkGuardNegativeProbe(slicedOutput, 'sliced');
    const staleSuccessOutput = await compileMode('sliced', { successfulReplyGate: true });
    for (const [index, probe] of staleSuccessProbes.entries()) {
      const caseRecord = { probe, ordinal: index + 1, status: 'running', resultIndex: harness.results.length };
      harness.nonPerformanceProbes.successfulStaleReply.cases.push(caseRecord);
      try {
        const trial = await runRecordedTrial({
          mode: 'sliced', scenario: 'early-visible', ordinal: index + 1,
          phase: 'successful-stale-reply-probe', extensionPath: staleSuccessOutput,
          fixtureConfig: createFixture('early-visible'), staleSuccessProbe: probe,
        });
        caseRecord.status = trial.status;
        caseRecord.sessionA = trial.staleSuccess?.sessionA ?? null;
        caseRecord.sessionB = trial.staleSuccess?.sessionB ?? null;
      } catch (error) {
        caseRecord.status = 'failed';
        caseRecord.error = error.message;
        throw error;
      }
    }
    harness.successfulStaleReplyGate = {
      passed: harness.nonPerformanceProbes.successfulStaleReply.cases.every(item => item.status === 'passed'),
      cases: harness.nonPerformanceProbes.successfulStaleReply.cases,
    };
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Not run for successful stale-reply probes.' };
    harness.status = harness.successfulStaleReplyGate.passed ? 'passed' : 'failed';
  } else {
    harness.comparisonOrdering = 'Legacy warmups qualify first. Every selected mode then receives complete discarded warmups before measured rounds; measured mode order is a deterministic cyclic rotation of all selected modes by scenario index plus zero-based measured ordinal.';
    const scenarioPlans = scenarios.map((scenario, index) => ({ scenario, index, fixture: createFixture(scenario) }));
    const legacyOutput = await compileMode('legacy');
    const legacyRuns = [];
    harness.scenarioSummaries = {};
    for (const plan of scenarioPlans) {
      for (let ordinal = 1; ordinal <= warmups; ordinal++) {
        const run = await runRecordedTrial({ mode: 'legacy', scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: legacyOutput, fixtureConfig: plan.fixture });
        legacyRuns.push(run);
      }
    }
    const qualificationParity = validateBuildParity(harness.builds, ['legacy']);
    harness.legacyQualificationGate = validateRunGate({
      legacyResults: legacyRuns,
      measuredSamples: [],
      allResults: harness.results,
      expectedModes: ['legacy'], expectedScenarios: scenarios, expectedSamples: 0, expectedWarmups: warmups,
      buildParity: qualificationParity,
    });
    if (!harness.legacyQualificationGate.comparisonsAllowed) throw new Error(`Legacy qualification failed: ${harness.legacyQualificationGate.issues.join('; ')}`);

    const modeOutputs = new Map([['legacy', legacyOutput]]);
    for (const mode of modes) if (mode !== 'legacy') modeOutputs.set(mode, await compileMode(mode));
    validateHarnessBuildParity();
    await runNetworkGuardNegativeProbe(legacyOutput);

    const candidateModes = modes.filter(mode => mode !== 'legacy');
    for (const plan of scenarioPlans) {
      for (const mode of modes) {
        if (mode === 'legacy') continue;
        for (let ordinal = 1; ordinal <= warmups; ordinal++) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: modeOutputs.get(mode), fixtureConfig: plan.fixture });
        }
      }
    }
    for (const plan of scenarioPlans) {
      for (let ordinal = 1; ordinal <= samples; ordinal++) {
        const order = modeOrder(modes, plan.index, ordinal - 1);
        harness.plannedMeasuredOrder.push({ scenario: plan.scenario, ordinal, modes: order });
        for (const mode of order) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'measured', extensionPath: modeOutputs.get(mode), fixtureConfig: plan.fixture });
        }
      }
    }

    const legacy = harness.results.filter(run => run.mode === 'legacy');
    const measured = harness.results.filter(run => run.phase === 'measured');
    harness.comparisonGate = validateRunGate({
      legacyResults: legacy, measuredSamples: measured,
      allResults: harness.results,
      expectedModes: modes, expectedScenarios: scenarios, expectedSamples: samples, expectedWarmups: warmups,
      buildParity: harness.buildParity,
    });
    if (!harness.comparisonGate.comparisonsAllowed) throw new Error(`Comparisons gated: ${harness.comparisonGate.issues.join('; ')}`);
    harness.scenarioSummaries = {};
    harness.comparisons = {};
    for (const plan of scenarioPlans) {
      harness.scenarioSummaries[plan.scenario] = {};
      for (const mode of modes) {
        const measuredRuns = harness.results.filter(run => run.scenario === plan.scenario && run.mode === mode && run.phase === 'measured');
        harness.scenarioSummaries[plan.scenario][mode] = measureMode(measuredRuns);
      }
      for (const mode of candidateModes) {
        const summary = harness.scenarioSummaries[plan.scenario][mode];
        const baseline = harness.scenarioSummaries[plan.scenario].legacy.times;
        harness.comparisons[plan.scenario] ??= {};
        harness.comparisons[plan.scenario][mode] = Object.fromEntries(Object.keys(summary.times).map(metric => {
          const baselineP50 = baseline[metric]?.p50;
          const modeP50 = summary.times[metric]?.p50;
          return [metric, { baselineP50: baselineP50 ?? null, modeP50: modeP50 ?? null, delta: Number.isFinite(baselineP50) && Number.isFinite(modeP50) ? modeP50 - baselineP50 : null }];
        }));
      }
    }
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
  if (!isolatedProbes.length) {
    let finalBuildParity = harness.buildParity;
    try { finalBuildParity = validateBuildParity(harness.builds, modes); }
    catch (error) { finalBuildParity = { ok: false, issues: [error.message] }; }
    harness.buildParity = finalBuildParity;
    if (!harness.legacyQualificationGate) {
      const qualificationParity = validateBuildParity(harness.builds, ['legacy']);
      harness.legacyQualificationGate = validateRunGate({
        legacyResults: harness.results.filter(run => run.mode === 'legacy'), measuredSamples: [],
        allResults: harness.results,
        expectedModes: ['legacy'], expectedScenarios: scenarios, expectedSamples: 0, expectedWarmups: warmups,
        buildParity: qualificationParity,
      });
    }
    harness.comparisonGate = validateRunGate({
      legacyResults: harness.results.filter(run => run.mode === 'legacy'),
      measuredSamples: harness.results.filter(run => run.phase === 'measured'),
      allResults: harness.results,
      expectedModes: modes, expectedScenarios: scenarios, expectedSamples: samples, expectedWarmups: warmups,
      buildParity: finalBuildParity,
    });
    if (harness.cleanupErrors.length) {
      harness.comparisonGate.comparisonsAllowed = false;
      harness.comparisonGate.issues.push('build cleanup failed');
    }
    if (primaryError) {
      harness.comparisonGate.comparisonsAllowed = false;
      harness.comparisonGate.issues.push(`benchmark execution failed: ${primaryError.message}`);
    }
    if (!harness.comparisonGate.comparisonsAllowed) {
      delete harness.comparisons;
      delete harness.scenarioSummaries;
    }
  }
  harness.finishedAt = now();
  await writeArtifact();
}
process.stdout.write(`${JSON.stringify({ status: harness.status, artifactPath, runs: harness.results.length, error: harness.error?.message })}\n`);
if (harness.status !== 'passed') process.exitCode = 1;

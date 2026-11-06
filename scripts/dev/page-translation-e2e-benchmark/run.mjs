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

const root = process.cwd();
const requestedModes = [...new Set((process.env.BENCH_MODES ?? 'legacy,sliced,viewport').split(',').map(value => value.trim()).filter(Boolean))];
const modes = ['legacy', ...requestedModes.filter(mode => mode !== 'legacy')];
const scenarios = parseScenarioSelection(process.env.BENCH_SCENARIOS ?? 'small');
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
  'scripts/dev/page-translation-e2e-runtime.test.js',
  'scripts/dev/page-translation-e2e-measurement.test.js',
  'scripts/dev/page-translation-e2e-large-page.test.js',
  'scripts/dev/page-translation-e2e-artifact-writer.test.js',
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

async function runTrial({ mode, scenario, ordinal, globalRunOrder, phase, extensionPath, fixtureConfig = createFixture(scenario), networkGuardProbe = false }) {
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

  const requestListener = async event => {
    if (event.method !== 'Fetch.requestPaused' || !guardSessions.has(event.sessionId)) return;
    const { request, requestId } = event.params;
    const requestRecord = {
      startedAt: now(), url: request.url, method: request.method,
      postData: request.postData ?? null,
      initiator: request.initiator ?? null,
    };
    trial.requests.push(requestRecord);
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
        await wait(fixtureConfig.responseDelayMs);
        const bodyString = JSON.stringify(responseBody);
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(bodyString).toString('base64'),
        }, event.sessionId);
        requestRecord.response = { status: 200, body: responseBody, endedAt: now() };
      } else if (classification.kind === 'startup-metadata-fixture') {
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(startupVoicesResponse)).toString('base64'),
        }, event.sessionId);
        requestRecord.response = { status: 200, body: startupVoicesResponse, endedAt: now() };
      } else if (classification.kind === 'local') {
        await send('Fetch.continueRequest', { requestId }, event.sessionId);
        requestRecord.response = { continued: true, endedAt: now() };
      } else if (classification.kind === 'invalid-extension-placeholder') {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        trial.nonHttpBlockedRequests ??= [];
        trial.nonHttpBlockedRequests.push(requestRecord);
        await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      } else {
        requestRecord.blocked = true;
        requestRecord.error = classification.reason;
        await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      }
    } catch (error) {
      requestRecord.blocked = true;
      requestRecord.error ??= error.message;
      trial.transportErrors ??= [];
      trial.transportErrors.push(error.message);
      if (!requestRecord.response) await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId).catch(() => {});
    } finally {
      requestRecord.endedAt = now();
    }
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
    const cleanups = [
      async () => requestUnsubscribe?.(),
      async () => eventUnsubscribe?.(),
      async () => pageEventUnsubscribe?.(),
      async () => { if (chrome) { const instance = chrome; await instance.close(); trial.chromeStderr = instance.metadata.stderr ?? null; } },
      async () => { if (fixture?.server.listening) await new Promise((resolveClose, reject) => fixture.server.close(error => error ? reject(error) : resolveClose())); },
    ];
    await cleanupMeasurementBeforeResources({
      state: measurementState,
      stopMeasurement: () => evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext),
      resources: cleanups,
      cleanupErrors: trial.cleanupErrors,
    });
    trial.measurementLifecycle = { ...measurementState };
    if (trial.cleanupErrors.length) trial.status = 'failed';
    trial.timestamps.finishedAt = now();
    if (trial.derivedTimings) trial.derivedTimings.cleanup = trial.timestamps.finishedAt;
  }
  return trial;
}

async function runNetworkGuardNegativeProbe(extensionPath) {
  const probeArtifactPath = `${artifactPath.replace(/\.json$/i, '')}-network-guard-probe.json`;
  const run = await runTrial({ mode: 'legacy', scenario: 'small', ordinal: 1, globalRunOrder: ++globalRunOrder, phase: 'non-performance-network-guard-probe', extensionPath, fixtureConfig: createFixture('small'), networkGuardProbe: true });
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
  validateSampleCount(samples);
  if (!Number.isInteger(warmups) || warmups < 1 || warmups > 3) throw new TypeError('BENCH_WARMUPS must be 1, 2, or 3.');
  harness.provenance = {
    gitSha: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    workingTree: git('status', '--short'),
    trackedChanges: { unstaged: git('diff', '--name-only'), staged: git('diff', '--cached', '--name-only') },
    browserVersion: null,
    fileSha256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(path)]))),
  };
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

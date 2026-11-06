import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { buildBenchmarkExtension } from './build.mjs';
import { launchChrome } from './chrome.mjs';
import { classifyTransportRequest, mapEdgeResponse, summarizeIntervals, validateEffectiveSettings, validateRunGate, validateTranslation, validatedLongTaskObservation } from './metrics.mjs';
import { startFixture, startupVoicesResponse, targetTexts } from './fixture.mjs';
import { cleanupMeasurementBeforeResources, completeTranslationMeasurement } from './measurement-lifecycle.mjs';

const root = process.cwd();
const requestedModes = (process.env.BENCH_MODES ?? 'legacy,sliced,viewport').split(',').map(value => value.trim()).filter(Boolean);
const modes = ['legacy', ...requestedModes.filter(mode => mode !== 'legacy')];
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
  'scripts/dev/page-translation-e2e-runtime.test.js',
  'scripts/dev/page-translation-e2e-measurement.test.js',
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
  const mutations = contentTrace?.mutations ?? [];
  const acceptedWrites = mutations.filter(mutation => mutation.acceptedWrite);
  const backgroundAdmission = findTrace(workerEvents, 'background.translationRequest.entry');
  const queueAdmission = findTrace(workerEvents, 'queueManager.enqueue');
  const providerStart = findTrace(workerEvents, 'providerRequestEngine.executeApiCall.start');
  const providerEnd = findTrace(workerEvents, 'providerRequestEngine.executeApiCall.end');
  const discoveryStart = findTrace(contentEvents, 'bridge.discovery.pending', event => event.pending === true);
  const discoveryDrained = [...contentEvents].reverse().find(event => event.name === 'bridge.discovery.pending' && event.pending === false);
  const schedulerFlush = findTrace(contentEvents, 'scheduler.flush.entry');
  const firstWrite = acceptedWrites.find(write => write.visibleAtStart) ?? acceptedWrites[0];
  return {
    translationCommand: trial.timestamps.translationCommand,
    discoveryStart: discoveryStart?.at ?? null,
    discoveryStartUnavailableReason: discoveryStart ? null : 'Bridge discovery-pending transition not observed',
    discoveryDrained: discoveryDrained?.at ?? null,
    discoveryDrainUnavailableReason: discoveryDrained ? null : 'Bridge discovery-drained transition not observed',
    firstSchedulerFlush: schedulerFlush?.at ?? null,
    schedulerFlushUnavailableReason: schedulerFlush ? null : 'Scheduler.flush entry not observed',
    schedulerRequestEntry: findTrace(contentEvents, 'scheduler.executeBatchRequest.entry')?.at ?? null,
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
    firstAcceptedWrite: firstWrite?.at ?? null,
    firstAcceptedWriteUnavailableReason: firstWrite ? null : 'No accepted DOM mutation was captured',
    allAcceptedWrites: acceptedWrites.length === targetTexts.length ? Math.max(...acceptedWrites.map(write => write.at)) : null,
    allAcceptedWritesUnavailableReason: acceptedWrites.length === targetTexts.length ? null : `MutationObserver captured ${acceptedWrites.length} accepted target writes; expected ${targetTexts.length}`,
    completion: trial.terminal?.receivedAt ?? null,
    restoreStart: trial.timestamps.restoreStarted,
    restoreEnd: trial.timestamps.restoreCompleted,
    cleanup: trial.timestamps.finishedAt,
    acceptedWriteCount: contentTrace?.acceptedUniqueCount ?? null,
    visibleAtStartIds: contentEvents.filter(event => event.name === 'dom.acceptedWrite' && event.visibleAtStart === true).map(event => event.id),
    visibleAtStartCount: contentEvents.filter(event => event.name === 'dom.acceptedWrite' && event.visibleAtStart === true).length,
    longTasks: contentTrace?.longTasks ?? null,
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
    commandToAllWrites: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.allAcceptedWrites),
    commandToCompletion: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.completion),
    restoreDuration: intervals(run => run.derivedTimings?.restoreStart, run => run.derivedTimings?.restoreEnd),
  };
  return {
    n: runs.length,
    times,
    providerAttemptCounts: runs.map(run => run.providerTranslationAttempts),
    providerBatchSizes: runs.map(run => run.providerBatchSizes),
    startupMetadataFixtureCount: runs.map(run => run.requests.filter(request => request.category === 'startup-metadata-fixture').length),
    longTaskSamples: runs.map(run => run.derivedTimings?.longTasks ?? null),
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
  fixture: { targetCount: targetTexts.length, targetTexts },
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
    performanceScope: 'Fixture has 12 short static targets and does not isolate the viewport-first benefit on offscreen-heavy pages.',
    heapLeak: 'Not measured; no heap-leak claim.',
  },
  status: 'running',
};
let primaryError;
const buildDirs = [];

async function writeArtifact() {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(harness, null, 2));
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

async function runTrial({ mode, ordinal, phase, extensionPath, networkGuardProbe = false }) {
  const trial = {
    mode, ordinal, phase, status: 'running',
    timestamps: { trialStart: now() },
    contexts: [], workerReadiness: [], contentReadiness: [], commands: [], lifecycle: [],
    console: [], exceptions: [], requests: [], rawDOM: {}, cleanupErrors: [],
    fixture: { targetCount: targetTexts.length, targetTexts },
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
        requestRecord.fixtureDelayMs = 50;
        await wait(50);
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
    fixture = await startFixture();
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

    const originals = targetTexts.map((text, index) => [`target-${index}`, text]);
    trial.rawDOM.original = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext);
    if (trial.rawDOM.original.length !== targetTexts.length
        || JSON.stringify(trial.rawDOM.original) !== JSON.stringify(originals)) {
      throw new Error('Pre-translation fixture DOM does not exactly match the 12 source targets.');
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
          const dom = await evaluate(chrome, pageSession,
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          trial.rawDOM.translated = dom;
          return terminal && dom.length === targetTexts.length && dom.every(([id, value]) => {
            const source = originals.find(([expectedId]) => expectedId === id)?.[1];
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
          const dom = await evaluate(chrome, pageSession,
            `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
          trial.rawDOM.restored = dom;
          return done && dom.length === targetTexts.length
            && dom.every(([id, text]) => originals.find(([expectedId]) => expectedId === id)?.[1] === text) ? { done, dom } : null;
        }, 30_000);
        return restored;
      },
    });
    const contentTrace = lifecycle.measurement;
    trial.measurements.content = contentTrace;
    trial.timestamps.restoreCompleted = lifecycle.restoreCompletedAt;
    const restoredLifecycle = lifecycle.restored;
    const [workerTrace, contentEvents] = await Promise.all([
      evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.snapshot()'),
      evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.events.map(event=>({...event}))', contentContext),
    ]);
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
    trial.validation = validateTranslation({ originals: originalsFromDom, translated: translatedFromDom, requests: providerSources, restored: new Map(restoredLifecycle.dom), expectedCount: targetTexts.length });
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
  const run = await runTrial({ mode: 'legacy', ordinal: 1, phase: 'non-performance-network-guard-probe', extensionPath, networkGuardProbe: true });
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

try {
  if (!requestedModes.length || requestedModes.some(mode => !['legacy', 'sliced', 'viewport'].includes(mode))) throw new TypeError(`Unsupported BENCH_MODES: ${requestedModes.join(',')}`);
  if (!Number.isInteger(samples) || samples < 3 || samples > 5) throw new TypeError('BENCH_SAMPLES must be 3, 4, or 5.');
  if (!Number.isInteger(warmups) || warmups < 1 || warmups > 3) throw new TypeError('BENCH_WARMUPS must be 1, 2, or 3.');
  harness.provenance = {
    gitSha: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    workingTree: git('status', '--short'),
    trackedChanges: { unstaged: git('diff', '--name-only'), staged: git('diff', '--cached', '--name-only') },
    browserVersion: null,
    fileSha256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(path)]))),
  };
  for (const mode of modes) {
    const extensionPath = await compileMode(mode);
    const modeRuns = [];
    for (let index = 1; index <= warmups; index++) {
      const run = await runTrial({ mode, ordinal: index, phase: 'warmup', extensionPath });
      modeRuns.push(run);
      harness.results.push(run);
      if (run.browser?.browserVersion) harness.provenance.browserVersion = run.browser.browserVersion;
      if (run.status !== 'passed') throw new Error(`${mode} warmup ${index} failed: ${run.error?.message ?? run.cleanupErrors.join('; ')}`);
    }
    for (let index = 1; index <= samples; index++) {
      const run = await runTrial({ mode, ordinal: index, phase: 'measured', extensionPath });
      modeRuns.push(run);
      harness.results.push(run);
      if (run.status !== 'passed') throw new Error(`${mode} measured sample ${index} failed: ${run.error?.message ?? run.cleanupErrors.join('; ')}`);
    }
    harness.modeSummaries ??= {};
    harness.modeSummaries[mode] = measureMode(modeRuns.filter(run => run.phase === 'measured'));
    if (mode === 'legacy' && modes.length > 1) {
      harness.comparisonGate = validateRunGate({ legacyResults: modeRuns, measuredSamples: modeRuns.filter(run => run.phase === 'measured') });
      if (!harness.comparisonGate.comparisonsAllowed) throw new Error('Sliced/viewport comparisons gated: Legacy warmup or measured correctness failed.');
    }
    if (mode === 'legacy') await runNetworkGuardNegativeProbe(extensionPath);
    if (mode !== 'legacy') {
      const baseline = harness.modeSummaries.legacy.times;
      const current = harness.modeSummaries[mode].times;
      harness.comparisons ??= {};
      harness.comparisons[mode] = Object.fromEntries(Object.keys(current).map(metric => {
        const baselineP50 = baseline[metric]?.p50;
        const modeP50 = current[metric]?.p50;
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

import { PROVIDER_ONLY_DEADLINE_MS } from './runtime-constants.mjs';
import { PAGE_TRANSLATION_STOP_DEADLINE_MS } from './runtime-constants.mjs';
import { MessageActions } from '../../../../src/shared/messaging/core/MessageActions.js';

const ACTION = '__PAGE_TRANSLATION_RUNTIME_PROBE_V1';
const PROVIDER_ACTION = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
const VERSION = 1;
const DEADLINE_MS = 15_000;
const FLAGS = { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false };

export async function installContentProbe(config, importEntry) {
  if (location.href !== config.fixtureUrl || window !== window.top) return;
  let nonce;
  let runtimeReadyAccepted = false;
  let pageTranslateSent = false;
  let pageStopMode = false;
  try {
    const hello = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'hello' });
    if (!validResponse(hello, 'challenge', config.runId) || typeof hello.nonce !== 'string' || !/^[a-f\d]{64}$/i.test(hello.nonce)) throw coded('HANDSHAKE_FAILED');
    nonce = hello.nonce;
    window.__firefoxProviderProbeEnabled = true;
    try { await withDeadline(importEntry(), DEADLINE_MS, 'IMPORT_FAILED'); }
    catch { throw coded('IMPORT_FAILED'); }
    const benchmarkTrace = window.__pageTranslationBenchmark;
    if (benchmarkTrace) benchmarkTrace.pageTranslationE2E = config.pageTranslationE2E === true;
    const loaded = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'loaded', nonce, entry: 'src/core/content-scripts/index-main.js' });
    expect(loaded, 'loaded-ack', config.runId, nonce);
    const checks = await waitContentReady();
    if (!checks) throw coded('READINESS_TIMEOUT');
    const trace = window.__pageTranslationBenchmark;
    pageStopMode = config.pageTranslationE2E === true && window.__firefoxPageTranslationStopMode === true;
    const flags = trace?.discoveryFlags;
    if (JSON.stringify(flags) !== JSON.stringify(FLAGS)) throw coded('DISCOVERY_FLAGS_MISMATCH');
    const response = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'ready', nonce, checks, flags });
    expect(response, 'ready-ack', config.runId, nonce);
    const confirmed = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'ack-received', nonce, ack: 'ready-ack' });
    expect(confirmed, 'confirmed', config.runId, nonce);
    const receipt = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'content-ready', nonce, checks, flags, ackReceived: true });
    if (!validReceipt(receipt, config.runId, nonce)) throw coded('PROTOCOL_REJECTED');
    runtimeReadyAccepted = true;
    if (config.providerOnly === true) {
      await invokeProviderOnly(config, nonce, trace);
      return;
    }
    if (pageStopMode) {
      const setup = trace?.enableCancellationProbe?.();
      if (setup?.enabled !== true || setup.instrumentationErrors?.length) throw coded('PROTOCOL_ERROR');
    }
    await armProviderProbe(config, nonce, trace, () => {
      if (pageTranslateSent) return false;
      pageTranslateSent = true;
      return true;
    }, pageStopMode);
  } catch (error) {
    if (config.providerOnly === true && runtimeReadyAccepted) return;
    if (pageStopMode && runtimeReadyAccepted) {
      const code = ['TIMEOUT', 'TEARDOWN'].includes(error?.message) ? error.message : 'PROTOCOL_ERROR';
      await sendProvider(config, nonce, { type: 'event', event: 'error', evidence: { code } }).catch(() => {});
      return;
    }
    const code = nonce && ERROR_CODES.has(error?.message) ? error.message : 'HANDSHAKE_FAILED';
    await notifyError(config.runId, code, nonce).catch(() => {});
  }
}

async function invokeProviderOnly(config, nonce, trace) {
  if (location.href !== config.fixtureUrl || window !== window.top) throw coded('PROTOCOL_REJECTED');
  const texts = [...document.querySelectorAll('[data-bench-id]')].map(element => element.textContent);
  if (texts.length !== 12 || texts.some((text, index) => text !== `Benchmark sentence ${index + 1} has stable fixture content.`)) throw coded('PROTOCOL_REJECTED');
  const response = await sendProvider(config, nonce, { type: 'arm', observersInstalled: true });
  if (!validProviderResponse(response, 'armed-ack', config.runId, nonce, ['start', 'stop'])) throw coded('PROTOCOL_ERROR');
  if (response.decision !== 'start' || location.href !== config.fixtureUrl || window !== window.top) return;
  let completion;
  try {
    completion = await withDeadline(sendProvider(config, nonce, { type: 'invoke', texts, sessionId: `${config.runId}-provider-session`, messageId: `${config.runId}-provider-message` }), PROVIDER_ONLY_DEADLINE_MS, 'TIMEOUT');
  } catch (error) {
    const code = PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR';
    if (!error?.reported) await sendProvider(config, nonce, { type: 'event', event: 'error', evidence: { code } }).catch(() => {});
    await sendProvider(config, nonce, { type: 'stop', code: PROVIDER_CODES.has(error?.message) ? error.message : 'TEARDOWN' }).catch(() => {});
    throw error;
  }
  if (!exact(completion, ['action', 'v', 'runId', 'type', 'nonce']) || completion.action !== PROVIDER_ACTION || completion.v !== VERSION
      || completion.runId !== config.runId || completion.type !== 'provider-complete' || completion.nonce !== nonce) throw coded('PROTOCOL_ERROR');
}

const ERROR_CODES = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);
const PROVIDER_CODES = new Set(['INTERCEPTION_UNSUPPORTED', 'BODY_UNSUPPORTED', 'INVALID_BODY', 'PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'COMPLETED']);

async function armProviderProbe(config, nonce, trace, claimPageTranslate, pageStopMode = false) {
  const sendEvent = (event, evidence) => sendProvider(config, nonce, { type: 'event', event, evidence });
  let observer;
  try { observer = await trace?.installProviderProbe?.(sendEvent, config.fixtureUrl); }
  catch { observer = null; }
  if (!observer?.installed) {
    await sendEvent('error', { code: 'PROTOCOL_ERROR' }).catch(() => {});
    return;
  }
  try {
    const response = await sendProvider(config, nonce, { type: 'arm', observersInstalled: observer.installed === true });
    if (!validProviderResponse(response, 'armed-ack', config.runId, nonce, ['start', 'stop'])) {
      await sendEvent('error', { code: 'PROTOCOL_ERROR' }).catch(() => {});
      observer.disconnect?.();
      return;
    }
    if (response.decision === 'stop' || location.href !== config.fixtureUrl || window !== window.top || !claimPageTranslate()) { observer.disconnect?.(); return; }
    if (pageStopMode) trace.pageTranslationStartReporter = async () => true;
    let productionRequest;
    try {
      productionRequest = globalThis.browser.runtime.sendMessage({ action: 'page-translate', context: 'content', data: { provider: 'edge', targetLanguage: 'fr', ...(pageStopMode ? { isAuto: true } : {}) } });
    } catch {
      await sendEvent('error', { code: 'PROTOCOL_ERROR' }).catch(() => {});
      return;
    }
    if (pageStopMode) {
      await runPageTranslationStopScenario({ config, nonce, trace, sendEvent, productionRequest, observer });
      return;
    }
    void withDeadline(Promise.resolve(productionRequest), DEADLINE_MS, 'TIMEOUT')
      .catch(error => sendEvent('error', { code: PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR' }).catch(() => {}));
  } catch (error) {
    await sendEvent('error', { code: PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR' }).catch(() => {});
    observer.disconnect?.();
  }
}

async function runPageTranslationStopScenario({ config, nonce, trace, sendEvent, productionRequest, observer }) {
  void Promise.resolve(productionRequest).catch(() => {});
  let stage = 'accepted-batch';
  const elements = [...document.querySelectorAll('[data-bench-id]')];
  const baseline = new Map(elements.map(element => [element.dataset.benchId, {
    text: element.textContent, titlePresent: element.hasAttribute('title'), title: element.getAttribute('title'),
  }]));
  const touchedAfterStop = new Set();
  let stopStarted = false;
  const targetId = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node?.parentElement)
    ?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
  const mutationObserver = new MutationObserver(records => {
    if (!stopStarted) return;
    for (const record of records) {
      const id = targetId(record.target);
      if (id) touchedAfterStop.add(id);
      for (const node of record.addedNodes ?? []) {
        const addedId = targetId(node);
        if (addedId) touchedAfterStop.add(addedId);
      }
    }
  });
  mutationObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  const controls = createPageStopControlInbox(config, nonce);
  const ledger = trace.cancellationLedger;
  if (!ledger || typeof ledger.record !== 'function') throw coded('PROTOCOL_ERROR');
  const accepted = new Map(); const sentBatches = new Set();
  let cancellationObservation;
  const drainWaiters = new Set();
  const notifyDrainWaiters = () => {
    for (const resolve of [...drainWaiters]) resolve();
  };
  let resolveAcceptedBatch; let rejectAcceptedBatch;
  const acceptedBatchReady = new Promise((resolve, reject) => { resolveAcceptedBatch = resolve; rejectAcceptedBatch = reject; });
  const originalRecord = ledger.record.bind(ledger);
  const maybeReportAcceptedBatch = () => {
    if (sentBatches.size) return;
    for (const batch of trace.schedulerRequests ?? []) {
      if (batch.sessionId !== trace.pageStopSessionId || !batch.targetIds.every(id => accepted.get(`${batch.sessionId}:${id}`) === true)) continue;
      const evidence = { messageId: batch.messageId, sessionId: batch.sessionId, targetIds: [...batch.targetIds], acceptedTargetIds: [...batch.targetIds] };
      sentBatches.add(batch.messageId);
      void sendEvent('scheduler-batch-accepted', evidence).then(receipt => {
        if (receipt?.type !== 'accepted') throw coded('PROTOCOL_ERROR');
        trace.pageStopAcceptedBatch = evidence;
        resolveAcceptedBatch(evidence);
      }).catch(error => rejectAcceptedBatch(coded(PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR')));
      break;
    }
  };
  ledger.record = (kind, sessionId, detail = {}) => {
    const event = originalRecord(kind, sessionId, detail);
    if (kind === 'scheduler.settlement' && detail?.outcome === 'accepted' && detail?.changed === true && typeof detail.id === 'string') {
      accepted.set(`${sessionId}:${detail.id}`, true);
      trace.pageStopSessionId = sessionId;
      maybeReportAcceptedBatch();
    }
    notifyDrainWaiters();
    return event;
  };
  const originalSettle = ledger.settle.bind(ledger);
  ledger.settle = (operation, status, detail = {}) => {
    const result = originalSettle(operation, status, detail);
    notifyDrainWaiters();
    return result;
  };

  try {
    const deadline = Date.now() + PAGE_TRANSLATION_STOP_DEADLINE_MS;
    const batch = await withDeadline(acceptedBatchReady, Math.max(1, deadline - Date.now()), 'TIMEOUT');
    const pendingTargetIds = elements.map(element => element.dataset.benchId).filter(id => !batch.targetIds.includes(id));
    stage = 'stop-control';
    const stopControl = await withDeadline(controls.wait('stop-auto'), Math.max(1, deadline - Date.now()), 'TIMEOUT');
    const secondBatchAtStop = trace.schedulerRequests.find(item => item.sessionId === batch.sessionId && item.messageId !== batch.messageId);
    if (!secondBatchAtStop || stopControl.message.sessionId !== batch.sessionId
        || stopControl.message.firstBatchMessageId !== batch.messageId || stopControl.message.secondBatchMessageId !== secondBatchAtStop.messageId) throw coded('PROTOCOL_ERROR');
    mutationObserver.takeRecords(); stopStarted = true;
    stage = 'production-stop';
    const stop = await observeProductionStop(ledger, batch.sessionId, deadline, () => globalThis.browser.runtime.sendMessage({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO, data: { sessionId: batch.sessionId },
    }));
    cancellationObservation = stop.observation;
    const stopResult = stop.result;
    const stopResponse = Array.isArray(stopResult?.responses) && stopResult.responses.length === 1 ? stopResult.responses[0] : null;
    const immediateDOM = await captureStopDOM(elements, baseline, batch.targetIds, pendingTargetIds);
    if (stopResult?.success !== true || !stopResponse?.success || stopResponse.sessionId !== batch.sessionId
        || stopResponse.isTranslated !== true || stopResponse.isAutoTranslating !== false
        || stopResponse.translatedCount !== batch.targetIds.length || !immediateDOM.acceptedDOMRetained || !immediateDOM.pendingDOMUnchanged) {
      throw coded('PROTOCOL_ERROR');
    }
    stage = 'cancellation-ack';
    const cancellationCommands = await cancellationObservation.promise;
    const commandEvidence = {
      sessionId: batch.sessionId, firstBatchMessageId: batch.messageId, firstBatchTargetIds: batch.targetIds,
      acceptedTargetIds: batch.targetIds, pendingTargetIds,
      stopSuccess: true, stopSessionId: stopResponse.sessionId, translatedCount: stopResponse.translatedCount,
      isTranslated: stopResponse.isTranslated, isAutoTranslating: stopResponse.isAutoTranslating,
      acceptedDOMRetained: immediateDOM.acceptedDOMRetained, pendingDOMUnchanged: immediateDOM.pendingDOMUnchanged,
      acceptedStateHash: immediateDOM.acceptedStateHash, pendingStateHash: immediateDOM.pendingStateHash,
    };
    stage = 'stop-command-report';
    const receipt = await sendEvent('stop-auto-command', commandEvidence);
    if (receipt?.type !== 'accepted') throw coded('PROTOCOL_ERROR');
    stopControl.finish({ accepted: true, sessionId: batch.sessionId });
    stage = 'snapshot-control';
    const captureControl = await withDeadline(controls.wait('capture'), Math.max(1, deadline - Date.now()), 'TIMEOUT');
    if (captureControl.message.sessionId !== batch.sessionId || captureControl.message.firstBatchMessageId !== batch.messageId
        || captureControl.message.secondBatchMessageId !== secondBatchAtStop.messageId) throw coded('PROTOCOL_ERROR');

    stage = 'content-drain';
    const contentState = await waitForContentStopDrain(trace, batch.sessionId, drainWaiters, deadline);
    const finalDOM = await captureStopDOM(elements, baseline, batch.targetIds, pendingTargetIds);
    const records = mutationObserver.takeRecords();
    for (const record of records) {
      const id = targetId(record.target);
      if (id) touchedAfterStop.add(id);
      for (const node of record.addedNodes ?? []) { const addedId = targetId(node); if (addedId) touchedAfterStop.add(addedId); }
    }
    const postStopMutationTargetIds = [...touchedAfterStop].sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    if (finalDOM.acceptedStateHash !== immediateDOM.acceptedStateHash || finalDOM.pendingStateHash !== immediateDOM.pendingStateHash
        || !finalDOM.acceptedDOMRetained || !finalDOM.pendingDOMUnchanged || postStopMutationTargetIds.some(id => pendingTargetIds.includes(id))) {
      throw coded('PROTOCOL_ERROR');
    }
    const secondBatch = trace.schedulerRequests.find(item => item.sessionId === batch.sessionId && item.messageId !== batch.messageId);
    if (!secondBatch) throw coded('PROTOCOL_ERROR');
    stage = 'final-report';
    const finalReceipt = await sendEvent('stop-auto-final', {
      sessionId: batch.sessionId, firstBatchMessageId: batch.messageId, firstBatchTargetIds: batch.targetIds,
      secondBatchMessageId: secondBatch.messageId, secondBatchTargetIds: secondBatch.targetIds,
      acceptedTargetIds: batch.targetIds, pendingTargetIds, acceptedDOMRetained: finalDOM.acceptedDOMRetained,
      pendingDOMUnchanged: finalDOM.pendingDOMUnchanged, acceptedStateHash: finalDOM.acceptedStateHash, pendingStateHash: finalDOM.pendingStateHash,
       postStopMutationTargetIds, cancellationRequests: cancellationCommands, contentState,
    });
    if (finalReceipt?.type !== 'accepted') throw coded('PROTOCOL_ERROR');
    captureControl.finish({ accepted: true, sessionId: batch.sessionId });
    controls.close();
    ledger.record = originalRecord; ledger.settle = originalSettle;
    mutationObserver.disconnect(); observer.disconnect?.();
  } catch (error) {
    const code = ['TIMEOUT', 'TEARDOWN'].includes(error?.code ?? error?.message) ? (error?.code ?? error.message) : 'PROTOCOL_ERROR';
    cancellationObservation?.dispose();
    await sendEvent('stop-auto-diagnostic', { stage, code }).catch(() => {});
    throw error;
  } finally {
    cancellationObservation?.dispose();
    controls.close();
    ledger.record = originalRecord; ledger.settle = originalSettle;
    mutationObserver.disconnect(); observer.disconnect?.();
  }
}

function createPageStopControlInbox(config, nonce) {
  const browser = globalThis.browser;
  const expectedOrigin = new URL(browser.runtime.getURL('')).origin;
  const waiters = new Map(); const queued = new Map(); let closed = false;
  const allowedTypes = new Set(['stop-auto', 'capture']);
  const listener = (message, sender) => {
    if (message?.action !== '__PAGE_TRANSLATION_STOP_CONTROL_V1') return false;
    if (closed || !exact(message, ['action', 'v', 'runId', 'nonce', 'type', 'sessionId', 'firstBatchMessageId', 'secondBatchMessageId'])
        || message.v !== VERSION || message.runId !== config.runId || message.nonce !== nonce || !allowedTypes.has(message.type)
        || location.href !== config.fixtureUrl || window !== window.top || sender?.id !== browser.runtime.id
        || (sender.url && (() => { try { return new URL(sender.url).origin !== expectedOrigin; } catch { return true; } })())
        || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const control = { message, finish: value => resolve(value) };
    const waiter = waiters.get(message.type);
    if (waiter) { waiters.delete(message.type); waiter(control); }
    else if (!queued.has(message.type)) queued.set(message.type, control);
    else return false;
    return response;
  };
  browser.runtime.onMessage.addListener(listener);
  return {
    wait(type) {
      if (queued.has(type)) { const control = queued.get(type); queued.delete(type); return Promise.resolve(control); }
      if (closed || waiters.has(type)) return Promise.reject(coded('PROTOCOL_ERROR'));
      return new Promise(resolve => waiters.set(type, resolve));
    },
    close() {
      if (closed) return;
      closed = true;
      browser.runtime.onMessage.removeListener?.(listener);
      waiters.clear(); queued.clear();
    },
  };
}

async function captureStopDOM(elements, baseline, acceptedIds, pendingIds) {
  const acceptedState = []; const pendingState = [];
  let acceptedDOMRetained = true; let pendingDOMUnchanged = true;
  for (const element of elements) {
    const id = element.dataset.benchId; const original = baseline.get(id);
    const isTitle = element.dataset.benchKind === 'title';
    const current = isTitle ? element.getAttribute('title') : element.textContent;
    const originalValue = isTitle ? original.title : original.text;
    const translated = `\u200efixture translation: ${originalValue ?? ''}`;
    if (acceptedIds.includes(id)) {
      const retained = current === translated;
      acceptedDOMRetained &&= retained;
      acceptedState.push([id, current]);
    } else if (pendingIds.includes(id)) {
      const unchanged = current === originalValue && element.hasAttribute('title') === original.titlePresent;
      pendingDOMUnchanged &&= unchanged;
      pendingState.push([id, current, element.hasAttribute('title')]);
    }
  }
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { acceptedDOMRetained, pendingDOMUnchanged, acceptedStateHash: await hash(acceptedState), pendingStateHash: await hash(pendingState) };
}

function readStopContentState(trace, sessionId) {
  const cancellation = trace.cancellationSnapshot?.(sessionId); const scheduler = trace.pageSessionSnapshot?.();
  if (!cancellation || !scheduler) return null;
  return {
    capturedSessionActive: cancellation.capturedSessionActive,
    discoveryCancelled: cancellation.discoveryCancelled,
    currentBridgeOwnsSession: cancellation.currentBridgeOwnsSession,
    schedulerSessionContextOwned: cancellation.schedulerSessionContextOwned,
    pendingOperations: cancellation.pendingOperations,
    translationSessionId: scheduler.translationSessionId,
    activeFlushes: scheduler.activeFlushes,
    queueIds: scheduler.queueIds,
    activeBatchIds: scheduler.activeBatchIds,
    pendingSettlementCount: scheduler.pendingSettlementCount,
    bridgeSessionActive: scheduler.bridgeSessionActive,
    bridgeDiscoveryPending: scheduler.bridgeDiscoveryPending,
    bridgeDiscoveryRunning: scheduler.bridgeDiscoveryRunning,
    bridgeDiscoveryStarting: scheduler.bridgeDiscoveryStarting,
    bridgeDiscoveryQueueDepth: scheduler.bridgeDiscoveryQueueDepth,
    bridgeDiscoveryCancelled: scheduler.bridgeDiscoveryCancelled,
    bridgeDiscoveryFailed: scheduler.bridgeDiscoveryFailed,
  };
}

function stopContentIsDrained(state, sessionId) {
  return state?.capturedSessionActive === false && state.discoveryCancelled === true
    && state.schedulerSessionContextOwned === false && state.pendingOperations === 0
    && state.translationSessionId === sessionId && state.activeFlushes === 0
    && state.queueIds?.length === 0 && state.activeBatchIds?.length === 0 && state.pendingSettlementCount === 0
    && state.bridgeSessionActive === false && state.bridgeDiscoveryPending === false
    && state.bridgeDiscoveryRunning === false && state.bridgeDiscoveryStarting === false
    && state.bridgeDiscoveryQueueDepth === 0 && state.bridgeDiscoveryCancelled === true && state.bridgeDiscoveryFailed === false;
}

async function waitForContentStopDrain(trace, sessionId, waiters, deadline) {
  const initial = readStopContentState(trace, sessionId);
  if (stopContentIsDrained(initial, sessionId)) return initial;
  return await withDeadline(new Promise((resolve, reject) => {
    let timer;
    const check = () => {
      const current = readStopContentState(trace, sessionId);
      if (!stopContentIsDrained(current, sessionId)) return;
      waiters.delete(check); clearTimeout(timer); resolve(current);
    };
    const remaining = Math.max(1, deadline - Date.now());
    timer = setTimeout(() => { waiters.delete(check); reject(coded('TIMEOUT')); }, remaining);
    timer.unref?.();
    waiters.add(check);
    check();
  }), Math.max(1, deadline - Date.now()), 'TIMEOUT');
}

export function observeCancellationCommands(ledger, sessionId, deadline) {
  const required = ['CANCEL_TRANSLATION', 'CANCEL_SESSION'];
  let dispose;
  const promise = new Promise((resolve, reject) => {
    let timer;
    let finished = false;
    const operations = new Set();
    const restore = () => {
      clearTimeout(timer);
      ledger.begin = originalBegin; ledger.settle = originalSettle;
      runtime.sendMessage = originalSendMessage;
    };
    const finish = callback => value => {
      if (finished) return;
      finished = true;
      restore();
      callback(value);
    };
    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);
    const finishIfReady = () => {
      if (finished) return;
      const current = [...operations].filter(item => item.sessionId === sessionId && required.includes(item.action));
      if (required.every(action => current.some(item => item.action === action && item.status !== 'pending'))) {
        resolveOnce(required.map(action => {
          const item = current.find(candidate => candidate.action === action);
          return { action, sessionId, status: item.status, responseSuccess: item.response?.success !== false && item.response != null,
            cancelAll: action === 'CANCEL_TRANSLATION' ? item.cancelAll : null,
            context: action === 'CANCEL_TRANSLATION' ? item.context : null };
        }));
      }
    };
    const originalBegin = ledger.begin;
    const originalSettle = ledger.settle;
    const runtime = globalThis.browser.runtime;
    const originalSendMessage = runtime.sendMessage;
    let activeCancellationData = null;
    runtime.sendMessage = function (message, ...args) {
      if (message?.action !== 'CANCEL_TRANSLATION' && message?.action !== 'CANCEL_SESSION') return originalSendMessage.call(this, message, ...args);
      activeCancellationData = message.data ?? {};
      try { return originalSendMessage.call(this, message, ...args); }
      finally { activeCancellationData = null; }
    };
    ledger.begin = (kind, owner, detail = {}) => {
      const operation = originalBegin.call(ledger, kind, owner, detail);
      if (kind === 'runtime.cancel.send' || kind === 'runtime.cancelSession.send') {
        Object.assign(operation, { cancelAll: activeCancellationData?.cancelAll ?? null, context: activeCancellationData?.context ?? null });
        operations.add(operation);
      }
      finishIfReady();
      return operation;
    };
    ledger.settle = (operation, status, detail = {}) => {
      const result = originalSettle.call(ledger, operation, status, detail);
      finishIfReady();
      return result;
    };
    timer = setTimeout(() => {
      rejectOnce(coded('TIMEOUT'));
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    dispose = () => resolveOnce(null);
    finishIfReady();
  });
  // The scenario may abort before it gets to consume this observation.
  void promise.catch(() => {});
  return { promise, dispose: () => dispose?.() };
}

export async function observeProductionStop(ledger, sessionId, deadline, sendStop) {
  const observation = observeCancellationCommands(ledger, sessionId, deadline + 1);
  try {
    const result = await withDeadline(sendStop(), Math.max(1, deadline - Date.now()), 'TIMEOUT');
    return { result, observation };
  } catch (error) {
    observation.dispose();
    throw error;
  }
}

function sendProvider(config, nonce, data) {
  const message = data.type === 'event'
    ? { action: PROVIDER_ACTION, v: VERSION, runId: config.runId, type: 'event', nonce, event: data.event, evidence: data.evidence }
    : data.type === 'invoke'
      ? { action: PROVIDER_ACTION, v: VERSION, runId: config.runId, type: 'invoke', nonce, texts: data.texts, sessionId: data.sessionId, messageId: data.messageId }
      : data.type === 'stop'
        ? { action: PROVIDER_ACTION, v: VERSION, runId: config.runId, type: 'stop', nonce, code: data.code }
      : { action: PROVIDER_ACTION, v: VERSION, runId: config.runId, type: data.type, nonce, observersInstalled: data.observersInstalled };
  const timeout = data.type === 'invoke' ? PROVIDER_ONLY_DEADLINE_MS
    : data.type === 'event' && ['scheduler-batch-accepted', 'stop-auto-command'].includes(data.event) ? PAGE_TRANSLATION_STOP_DEADLINE_MS : 3000;
  return send(message, timeout).then(response => {
    if (validProviderError(response, config.runId, nonce)) throw Object.assign(coded(response.code), { reported: true });
    if (data.type === 'event') {
      const decisions = data.event === 'translated' ? ['restore', 'stop'] : [];
      if (!validProviderResponse(response, 'accepted', config.runId, nonce, decisions)) throw coded('PROTOCOL_ERROR');
    }
    if (data.type === 'invoke') {
      if (!validProviderResponse(response, 'provider-complete', config.runId, nonce)) throw coded('PROTOCOL_ERROR');
    } else if (data.type === 'stop') {
      if (!validProviderResponse(response, 'accepted', config.runId, nonce)) throw coded('PROTOCOL_ERROR');
    } else if (data.type !== 'event' && !validProviderResponse(response, 'armed-ack', config.runId, nonce, ['start', 'stop'])) throw coded('PROTOCOL_ERROR');
    return response;
  });
}

function validProviderResponse(value, type, runId, nonce, decisions = []) {
  const keys = decisions.length ? ['action', 'v', 'runId', 'type', 'nonce', 'decision'] : ['action', 'v', 'runId', 'type', 'nonce'];
  return exact(value, keys) && value.action === PROVIDER_ACTION
    && value.v === VERSION && value.runId === runId && value.type === type && value.nonce === nonce
    && (!decisions.length || decisions.includes(value.decision));
}

function validProviderError(value, runId, nonce) {
  return exact(value, ['action', 'v', 'runId', 'type', 'nonce', 'code']) && value.action === PROVIDER_ACTION
    && value.v === VERSION && value.runId === runId && value.type === 'error' && value.nonce === nonce && PROVIDER_CODES.has(value.code);
}

async function waitContentReady() {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const core = window.translateItContentCore;
    const startup = window.__firefoxProbeStartup;
    const trace = window.__pageTranslationBenchmark;
    const state = core?.initialized === true && typeof trace?.featureState === 'function' ? trace.featureState() : null;
    const checks = {
      coreInitialized: core?.initialized === true,
      listenerActive: state?.listenerActive === true,
      featureManagerInitialized: state?.initialized === true,
      handlerActive: state?.active === true,
      handlerIsActive: state?.handlerIsActive === true,
    };
    if (startup?.complete && startup.success === false) throw coded('STARTUP_FAILED');
    if (startup?.complete === true && startup.success === true && Object.values(checks).every(Boolean)) return checks;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

export function send(message, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const longOperation = message.type === 'invoke' || message.type === 'event' && ['scheduler-batch-accepted', 'stop-auto-command'].includes(message.event);
    const timer = setTimeout(() => reject(coded(longOperation ? 'TIMEOUT' : 'READINESS_TIMEOUT')), timeoutMs);
    Promise.resolve(globalThis.browser.runtime.sendMessage(message)).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
function expect(value, type, runId, nonce) {
  if (validErrorResponse(value, runId, nonce)) throw coded(value.code);
  if (!validResponse(value, type, runId, nonce)) throw coded('PROTOCOL_REJECTED');
}
function validResponse(value, type, runId, nonce) {
  return exact(value, ['action', 'v', 'runId', 'type', 'nonce']) && value.action === ACTION && value.v === VERSION && value.runId === runId
    && value.type === type && (nonce === undefined ? typeof value.nonce === 'string' : value.nonce === nonce);
}
function validReceipt(value, runId, nonce) {
  const keys = nonce === undefined ? ['action', 'v', 'runId', 'type'] : ['action', 'v', 'runId', 'type', 'nonce'];
  return exact(value, keys) && value.action === ACTION && value.v === VERSION && value.runId === runId && value.type === 'accepted'
    && (nonce === undefined || value.nonce === nonce);
}
function validErrorResponse(value, runId, nonce) {
  const common = ['action', 'v', 'runId', 'type', 'code'];
  const expectsNonce = nonce !== undefined;
  const keys = expectsNonce ? [...common, 'nonce'] : common;
  return exact(value, keys) && value.action === ACTION && value.v === VERSION && value.runId === runId && value.type === 'error'
    && ERROR_CODES.has(value.code) && (!expectsNonce || value.nonce === nonce);
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && actual.every(key => keys.includes(key));
}
function coded(code) { return Object.assign(new Error(code), { code }); }
function withDeadline(promise, ms, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(coded(code)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function notifyError(runId, code, nonce) {
  const receipt = await send({ action: ACTION, v: VERSION, runId, type: 'error', ...(nonce ? { nonce } : {}), code });
  if (!validReceipt(receipt, runId, nonce)) throw coded('PROTOCOL_REJECTED');
}

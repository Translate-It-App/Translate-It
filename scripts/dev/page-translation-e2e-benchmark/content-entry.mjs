import { PageTranslationManager } from '../../../src/features/page-translation/PageTranslationManager.js';
import { FeatureManager } from '../../../src/core/managers/content/FeatureManager.js';
import { PageTranslationScheduler } from '../../../src/features/page-translation/PageTranslationScheduler.js';
import { PageTranslationBridge } from '../../../src/features/page-translation/PageTranslationBridge.js';
import { MainFrameCoordinator } from '../../../src/core/content-scripts/main/MainFrameCoordinator.js';
import { PAGE_TRANSLATION_SLICED_DISCOVERY, PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY } from '../../../src/features/page-translation/PageTranslationConstants.js';
import { captureViewportWindow, installCallThrough, installPrimitiveAdmissionObserver } from './trace.mjs';
import { drainAndDisconnectMeasurementObservers, groupMutationRecords, isDuplicateAcceptedMutation, trackAcceptedTarget } from './measurement-lifecycle.mjs';
import { createCancellationLedger, installCancellationRuntimeMessageObserver, installTrustedLifecycleObserver, sessionIdForTranslationContext } from './cancellation-probes.mjs';
import { createRawDOMMutationEvidence, installSuccessfulReplyProbe } from './successful-reply-probes.mjs';
import { wrapPageTranslationStart } from './page-translation-start-probe.mjs';

let successfulReplyMutationObserver = null;
let successfulReplyMutationEvidence = null;

const trace = {
  entry: 'src/core/content-scripts/index-main.js',
  calls: [],
  restores: [],
  events: [],
  bridgeSession: null,
  discoveryAdmissionOrder: null,
  schedulerEnqueueOrder: [],
  selectedBatchMembers: [],
  schedulerRequests: [],
  pageTranslationE2E: false,
  pageTranslationStartReporter: null,
  viewportWindowObservation: null,
  admissionHookInstalled: false,
  discoveryFlags: {
    slicedDiscoveryEnabled: PAGE_TRANSLATION_SLICED_DISCOVERY,
    viewportFirstDiscoveryEnabled: PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY,
  },
  translationPrefix: 'fixture translation:',
  cancellationLedger: null,
  cancellationSessions: new Map(),
  cancellationSessionOwners: new WeakMap(),
  cancellationContextOwners: new Map(),
  cancellationAcceptedTransitions: new Map(),
  cancellationInstrumentationErrors: [],
  successfulReplyProbe: null,
  enableSuccessfulReplyProbe(timeoutMs = 10_000) {
    if (this.successfulReplyProbe) return { enabled: true, reused: true };
    if (typeof PageTranslationScheduler.prototype?._executeBatchRequest !== 'function'
        || typeof PageTranslationScheduler.prototype?._ownsFlushSession !== 'function') {
      return { enabled: false, reason: 'Production PageTranslationScheduler prototype methods are unavailable' };
    }
    try {
      this.successfulReplyProbe = installSuccessfulReplyProbe({ scheduler: PageTranslationScheduler.prototype, timeoutMs });
      successfulReplyMutationEvidence = createRawDOMMutationEvidence();
      successfulReplyMutationObserver = new MutationObserver(records => successfulReplyMutationEvidence.capture(records, {
        targetIdForNode: benchmarkTargetId,
      }));
      if (!document.body) throw new Error('Fixture body is unavailable for raw DOM observation');
      successfulReplyMutationObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      return { enabled: true };
    } catch (error) {
      successfulReplyMutationObserver?.disconnect();
      successfulReplyMutationObserver = null;
      this.successfulReplyProbe?.close('mutation-observer-install-failed');
      this.successfulReplyProbe = null;
      return { enabled: false, reason: error.message };
    }
  },
  interceptSchedulerBatchReply(message, originalPromise) {
    if (message?.action === 'page-translate-batch' && typeof message.messageId === 'string') {
      const targetIds = this.selectedBatchMembers.at(-1);
      if (Array.isArray(targetIds) && targetIds.length) this.schedulerRequests.push({
        messageId: message.messageId,
        sessionId: message.data?.sessionId ?? null,
        targetIds: [...targetIds],
      });
    }
    return this.successfulReplyProbe?.interceptSchedulerBatchReply(message, originalPromise) ?? originalPromise;
  },
  captureSchedulerBatch(message) {
    const targetIds = this.selectedBatchMembers.at(-1);
    if (message?.action !== 'page-translate-batch' || typeof message.messageId !== 'string'
        || typeof message.data?.sessionId !== 'string' || !Array.isArray(targetIds) || !targetIds.length
        || targetIds.some(id => !/^target-(?:[0-9]|1[01])$/.test(id))
        || this.schedulerRequests.some(item => item.messageId === message.messageId)) {
      this.schedulerBatchError = true;
      return false;
    }
    const evidence = { messageId: message.messageId, sessionId: message.data.sessionId, targetIds: [...targetIds] };
    this.schedulerRequests.push(evidence);
    const reported = this.schedulerBatchReporter?.(evidence);
    if (!reported || typeof reported.then !== 'function') {
      this.schedulerBatchError = true;
      return false;
    }
    return reported.catch(error => { this.schedulerBatchError = true; throw error; });
  },
  beginSuccessfulReplyMutationCapture() {
    if (!successfulReplyMutationObserver || !successfulReplyMutationEvidence) throw new Error('Raw fixture mutation observer is unavailable');
    successfulReplyMutationObserver.takeRecords();
    successfulReplyMutationEvidence.begin();
  },
  finishSuccessfulReplyMutationCapture() {
    if (!successfulReplyMutationObserver || !successfulReplyMutationEvidence) return { available: false, active: false, transitions: [], errors: ['Raw fixture mutation observer is unavailable'] };
    const evidence = successfulReplyMutationEvidence.finish(successfulReplyMutationObserver.takeRecords(), { targetIdForNode: benchmarkTargetId });
    successfulReplyMutationObserver.disconnect();
    successfulReplyMutationObserver = null;
    return evidence;
  },
  closeSuccessfulReplyMutationObserver() {
    successfulReplyMutationObserver?.disconnect();
    successfulReplyMutationObserver = null;
  },
  armSuccessfulReplyProbe() { this.successfulReplyProbe?.arm(); },
  releaseSuccessfulReplyProbe() { return this.successfulReplyProbe?.release() ?? false; },
  closeSuccessfulReplyProbe(reason) {
    return this.successfulReplyProbe?.close(reason) ?? false;
  },
  successfulReplySnapshot() { return this.successfulReplyProbe?.snapshot() ?? null; },
  pageSessionSnapshot() {
    const manager = FeatureManager.getInstance().getFeatureHandler('pageTranslation');
    const scheduler = manager?.scheduler;
    if (!scheduler) return null;
    const bridgeSession = manager.bridge?.session ?? null;
    const discovery = bridgeSession?.discovery ?? null;
    return {
      translationSessionId: scheduler.translationSessionId ?? null,
      isTranslated: scheduler.isTranslated === true,
      translatedCount: scheduler.translatedCount ?? null,
      failedCount: scheduler.failedCount ?? null,
      totalTasks: scheduler.totalTasks ?? null,
      activeFlushes: scheduler.activeFlushes ?? null,
      discoveryPending: typeof scheduler.discoveryPending === 'boolean' ? scheduler.discoveryPending : null,
      queueIds: Array.isArray(scheduler.queue) ? scheduler.queue.map(item => item?.id ?? null) : null,
      activeBatchIds: scheduler.activeBatches instanceof Set
        ? [...scheduler.activeBatches].flatMap(batch => batch.items?.map(item => item?.id ?? null) ?? []) : null,
      pendingSettlementCount: scheduler.pendingSettlements instanceof Set ? scheduler.pendingSettlements.size : null,
      batchTimerActive: scheduler.batchTimer !== undefined ? scheduler.batchTimer !== null : null,
      completionTimerActive: scheduler._completionTimer !== undefined ? scheduler._completionTimer !== null : null,
      sessionContextOwned: !!scheduler.sessionContext && scheduler.sessionContext === bridgeSession?.context,
      bridgeSessionOwned: !!bridgeSession && scheduler.sessionContext === bridgeSession.context,
      bridgeSessionActive: typeof bridgeSession?.active === 'boolean' ? bridgeSession.active : null,
      bridgeDiscoveryPending: typeof discovery?.pending === 'boolean' ? discovery.pending : null,
      bridgeDiscoveryRunning: typeof discovery?.running === 'boolean' ? discovery.running : null,
      bridgeDiscoveryStarting: typeof discovery?.starting === 'boolean' ? discovery.starting : null,
      bridgeDiscoveryQueueDepth: Array.isArray(discovery?.queue) && Number.isInteger(discovery.head)
        ? Math.max(0, discovery.queue.length - discovery.head) : null,
      bridgeDiscoveryCancelled: typeof discovery?.cancelled === 'boolean' ? discovery.cancelled : null,
      bridgeDiscoveryFailed: typeof discovery?.failed === 'boolean' ? discovery.failed : null,
    };
  },
  enableCancellationProbe() {
    if (this.cancellationLedger) return { enabled: true, reused: true };
    const ledger = this.cancellationLedger = createCancellationLedger();
    const manager = () => FeatureManager.getInstance().getFeatureHandler('pageTranslation');
    const currentSessionId = () => manager()?.scheduler?.translationSessionId ?? null;
    const observePromise = (kind, sessionId, result, detail = {}, detailOnSettlement = () => ({}), expectPromise = false) => {
      if (!result || typeof result.then !== 'function') {
        ledger.record(expectPromise ? 'instrumentation.promise-unavailable' : kind, sessionId, {
          ...detail, operation: kind, status: 'synchronous',
        });
        if (expectPromise) this.cancellationInstrumentationErrors.push(`${kind} returned a non-Promise result.`);
        return result;
      }
      const operation = ledger.begin(kind, sessionId, detail);
      result.then(
        value => ledger.settle(operation, 'fulfilled', { response: value, ...detailOnSettlement(value) }),
        error => ledger.settle(operation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error) }),
      );
      return result;
    };
    const scheduler = PageTranslationScheduler.prototype;
    for (const method of ['flush']) {
      if (typeof scheduler[method] !== 'function' || scheduler[method].__cancellationObserved) continue;
      const original = scheduler[method];
      const wrapped = function (...args) {
        const owner = this.translationSessionId;
        return observePromise(`scheduler.${method}`, owner, original.apply(this, args), { sessionContextOwned: !!this.sessionContext }, undefined, true);
      };
      wrapped.__cancellationObserved = true;
      scheduler[method] = wrapped;
    }
    if (typeof scheduler._executeBatchRequest === 'function' && !scheduler._executeBatchRequest.__cancellationObserved) {
      const original = scheduler._executeBatchRequest;
      const wrapped = function (batch, config, context, sessionId, ...rest) {
        const ids = Array.isArray(batch) ? batch.map(item => benchmarkTargetId(item?.node)) : [];
        return observePromise('scheduler.batch', sessionId, original.call(this, batch, config, context, sessionId, ...rest), { targetIds: ids }, undefined, true);
      };
      wrapped.__cancellationObserved = true;
      scheduler._executeBatchRequest = wrapped;
    }
    if (typeof scheduler._createSettlement === 'function' && !scheduler._createSettlement.__cancellationObserved) {
      const original = scheduler._createSettlement;
      const wrapped = function (item, ...args) {
        const settlement = original.call(this, item, ...args);
        const owner = sessionIdForTranslationContext(trace.cancellationContextOwners, item?.context);
        const id = benchmarkTargetId(item?.node);
        if (owner === null) trace.cancellationInstrumentationErrors.push(`No captured origin session for settlement ${id ?? 'unknown-target'}`);
        const settle = settlement.settle;
        settlement.settle = function (outcome) {
          const before = settlement.state;
          const result = settle.call(this, outcome);
          const transition = ledger.record('scheduler.settlement', owner, {
            id, outcome, before, changed: result === true,
            transition: result === true ? 'changed' : 'ignored', originContextCaptured: owner !== null,
          });
          if (result === true && outcome === 'accepted' && id && owner !== null) {
            trace.cancellationAcceptedTransitions.set(id, { sessionId: owner, sequence: transition.sequence });
          }
          return result;
        };
        return settlement;
      };
      wrapped.__cancellationObserved = true;
      scheduler._createSettlement = wrapped;
    }

    const bridgeTranslate = PageTranslationBridge.prototype.translate;
    if (typeof bridgeTranslate === 'function' && !bridgeTranslate.__cancellationObserved) {
      const wrapped = function (...args) {
        const session = this.session;
        const owner = currentSessionId();
        if (session && owner) {
          trace.cancellationSessions.set(owner, session);
          trace.cancellationSessionOwners.set(session, owner);
          if (session.context) trace.cancellationContextOwners.set(session.context, owner);
          const nodesTranslator = session.domTranslator?.nodesTranslator;
          if (nodesTranslator && !nodesTranslator.translateNodeContent?.__cancellationObserved) {
            const originalNodeTranslate = nodesTranslator.translateNodeContent;
            if (typeof originalNodeTranslate === 'function') {
              const observedNodeTranslate = function (node, ...nodeArgs) {
                const id = benchmarkTargetId(node);
                const sourceAtStart = node?.nodeValue ?? node?.value ?? null;
                return observePromise('node.continuation', owner,
                  originalNodeTranslate.call(this, node, ...nodeArgs),
                  { id, sourceAtStart, sessionContextOwned: session.context === manager()?.scheduler?.sessionContext },
                  () => ({ actualDomValueAtSettlement: node?.nodeValue ?? node?.value ?? null }), true);
              };
              observedNodeTranslate.__cancellationObserved = true;
              nodesTranslator.translateNodeContent = observedNodeTranslate;
            }
          }
        }
        const result = bridgeTranslate.apply(this, args);
        return observePromise('bridge.discovery', owner, result, { capturedSession: !!session });
      };
      wrapped.__cancellationObserved = true;
      PageTranslationBridge.prototype.translate = wrapped;
    }

    for (const method of ['stopPersistence', 'cleanup']) {
      const original = PageTranslationBridge.prototype[method];
      if (typeof original !== 'function' || original.__cancellationObserved) continue;
      const wrapped = function (...args) {
        const session = this.session;
        const owner = session ? trace.cancellationSessionOwners.get(session) ?? null : null;
        const result = original.apply(this, args);
        if (session && owner === null) trace.cancellationInstrumentationErrors.push(`No captured origin session for Bridge.${method}`);
        else if (session) ledger.record('session.invalidation', owner, {
          method, capturedSessionActive: session.active,
          discoveryCancelled: session.discovery?.cancelled ?? null,
          bridgeStillOwnsCapturedSession: this.session === session,
        });
        return result;
      };
      wrapped.__cancellationObserved = true;
      PageTranslationBridge.prototype[method] = wrapped;
    }

    const publish = PageTranslationManager.prototype._publishLifecycle;
    if (typeof publish === 'function' && !publish.__cancellationObserved) {
      const wrapped = function (action, data = {}, sessionId = null) {
        ledger.record('lifecycle.emission', sessionId ?? data?.sessionId ?? data?.messageId ?? null, { action, data });
        return publish.call(this, action, data, sessionId);
      };
      wrapped.__cancellationObserved = true;
      PageTranslationManager.prototype._publishLifecycle = wrapped;
    }

    const lifecycleHandler = MainFrameCoordinator.prototype.handleTrustedPageLifecycle;
    if (typeof lifecycleHandler === 'function' && !lifecycleHandler.__cancellationObserved) {
      const installed = installTrustedLifecycleObserver(MainFrameCoordinator.prototype, 'handleTrustedPageLifecycle', event => {
        ledger.record('lifecycle.delivery', event.sessionId, { action: event.action, accepted: event.accepted, result: event.result });
      });
      if (!installed) this.cancellationInstrumentationErrors.push('Could not install trusted lifecycle observer.');
      else MainFrameCoordinator.prototype.handleTrustedPageLifecycle.__cancellationObserved = true;
    }

    const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
    const sendMessageObserver = installCancellationRuntimeMessageObserver(runtime, ledger,
      message => this.cancellationInstrumentationErrors.push(message));
    const sendMessageWrapped = sendMessageObserver.installed;
    if (!sendMessageWrapped) this.cancellationInstrumentationErrors.push(`runtime.sendMessage wrapper failed: ${sendMessageObserver.reason ?? 'assignment was not retained'}`);

    this.drainCancellationMutations = () => {
      if (!measurement) return null;
      const records = measurement.observer.takeRecords();
      if (records.length) measurement.processMutations(records);
      return {
        recordCount: measurement.observerState.recordCount,
        acceptedIds: [...measurement.acceptedIds],
        duplicateAcceptedIds: [...measurement.duplicateAcceptedIds],
        mutations: measurement.mutations.map(mutation => ({ ...mutation })),
      };
    };
    this.cancellationSnapshot = sessionId => {
      const session = this.cancellationSessions.get(sessionId);
      const activeManager = manager();
      const selectedOperations = ledger.snapshot(sessionId);
      const latestB = activeManager?.scheduler?.translationSessionId ?? null;
      return {
        sessionId,
        activeManagerSessionId: latestB,
        capturedSessionActive: session?.active ?? null,
        discoveryCancelled: session?.discovery?.cancelled ?? null,
        currentBridgeOwnsSession: activeManager?.bridge?.session === session,
        schedulerSessionContextOwned: !!session && activeManager?.scheduler?.sessionContext === session.context,
        pendingOperations: selectedOperations.pending,
        operations: selectedOperations.operations,
        instrumentationErrors: [...this.cancellationInstrumentationErrors],
        mutationSnapshot: this.drainCancellationMutations?.(),
      };
    };
    return { enabled: true, sendMessageWrapped, instrumentationErrors: [...this.cancellationInstrumentationErrors] };
  },
  record(name, detail = {}) { this.events.push({ name, at: Date.now(), ...detail }); },
  featureState() {
    const core = window.translateItContentCore;
    const manager = FeatureManager.getInstance();
    const messageHandler = manager.getFeatureHandler('contentMessageHandler');
    return {
      initialized: manager.initialized,
      active: manager.isFeatureActive('contentMessageHandler'),
      handlerActive: !!messageHandler?.isActive,
      handlerIsActive: messageHandler?.isActive === true,
      listenerActive: core?.messageHandler?.isListenerActive === true,
    };
  },
};
const originalTranslate = PageTranslationManager.prototype.translatePage;
PageTranslationManager.prototype.translatePage = wrapPageTranslationStart(originalTranslate, {
  isProbeStart: options => trace.pageTranslationE2E === true && options?.provider === 'edge' && options?.targetLanguage === 'fr',
  report: evidence => trace.pageTranslationStartReporter?.(evidence) ?? Promise.reject(new Error('Authenticated page-translation start reporter is unavailable.')),
  onStart(_manager, args, at) {
    const options = args[0] ?? {};
    trace.record('manager.translatePage.entry', {
      at,
      isAuto: options.isAuto === true,
      targetLanguage: options.targetLanguage ?? null,
    });
  },
  onSettled(manager, args, at, endedAt) {
    const options = args[0] ?? {};
    trace.calls.push({ at, endedAt, settings: {
      targetLanguage: manager.settings?.targetLanguage ?? options.targetLanguage ?? null,
      lazyLoading: manager.settings?.lazyLoading ?? null,
      translateAfterScrollStop: manager.settings?.translateAfterScrollStop ?? null,
      autoTranslateOnDOMChanges: manager.settings?.autoTranslateOnDOMChanges ?? null,
    }, messageId: manager.translationMessageId, totalTasks: manager.scheduler?.totalTasks });
  },
});

const benchmarkTargetId = node => {
  const element = node?.nodeType === Node.ELEMENT_NODE
    ? node
    : node?.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node?.parentElement;
  return element?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
};

const observedAdmissionNodes = new WeakSet();
const originalRestore = PageTranslationManager.prototype.restorePage;
PageTranslationManager.prototype.restorePage = function(...args) {
  const at = Date.now();
  trace.record('manager.restorePage.entry', { manual: args[0]?.manual ?? null });
  const append = () => trace.restores.push({ at, endedAt: Date.now(), settings: { targetLanguage: this.settings?.targetLanguage ?? null } });
  let result;
  try { result = originalRestore.apply(this, args); } catch (error) { append(); throw error; }
  if (result && typeof result.then === 'function') result.then(append, append);
  else append();
  return result;
};

installCallThrough(PageTranslationScheduler.prototype, 'enqueue', function (args) {
  const [text, , score, node] = args;
  const id = benchmarkTargetId(node);
  trace.schedulerEnqueueOrder.push(id);
  trace.record('scheduler.enqueue', { id, score: Number(score) || 0, textLength: typeof text === 'string' ? text.length : null });
});
installCallThrough(PageTranslationScheduler.prototype, 'flush', function () {
  trace.record('scheduler.flush.entry', { queueLength: this.queue?.length ?? null, activeFlushes: this.activeFlushes ?? null, batchTimerPending: this.batchTimer != null });
});
installCallThrough(PageTranslationScheduler.prototype, '_executeBatchRequest', function ([batch]) {
  const targetIds = Array.isArray(batch) ? batch.map(item => benchmarkTargetId(item?.node)) : null;
  trace.selectedBatchMembers.push(targetIds);
  trace.record('scheduler.executeBatchRequest.entry', { itemCount: Array.isArray(batch) ? batch.length : null, targetIds });
});
installCallThrough(PageTranslationBridge.prototype, 'translate', function () {
  trace.bridgeSession = this.session;
  trace.discoveryAdmissionOrder = [];
  trace.viewportWindowObservation = null;
  const session = this.session;
  const nodesTranslator = session?.domTranslator?.nodesTranslator;
  if (nodesTranslator && !observedAdmissionNodes.has(nodesTranslator)) {
    const installed = installPrimitiveAdmissionObserver(session, function ([node]) {
      const id = benchmarkTargetId(node);
      trace.discoveryAdmissionOrder.push(id);
      trace.record('primitive.admission', { id, stage: 'after-DOMTranslator-filter-before-PageTranslationScheduler-enqueue' });
      const activeSession = trace.bridgeSession;
      if (activeSession?.viewportFirstDiscoveryEnabled && !trace.viewportWindowObservation) {
        trace.viewportWindowObservation = captureViewportWindow(activeSession, benchmarkTargetId);
        if (trace.viewportWindowObservation) trace.record('viewport.window.admission.observed', {
          phaseAtAdmission: trace.viewportWindowObservation.phaseAtAdmission,
          enumerationSteps: trace.viewportWindowObservation.enumerationSteps,
          candidateCount: trace.viewportWindowObservation.candidateCount,
        });
      }
    });
    if (installed) observedAdmissionNodes.add(nodesTranslator);
    trace.admissionHookInstalled = installed;
  }
  trace.record('bridge.translate.entry', { viewportWindowEnabled: session?.viewportFirstDiscoveryEnabled === true, admissionHookInstalled: trace.admissionHookInstalled });
});
installCallThrough(PageTranslationBridge.prototype, 'restore', function () { trace.record('bridge.restore.entry'); });
installCallThrough(PageTranslationBridge.prototype, 'initialize', function (args) {
  const callbacks = args[3];
  if (typeof callbacks?.onDiscoveryStateChange !== 'function' || callbacks.onDiscoveryStateChange.__benchmarkWrapped) return;
  const original = callbacks.onDiscoveryStateChange;
  const wrapped = function (...callbackArgs) {
    trace.record('bridge.discovery.pending', { pending: callbackArgs[0] === true });
    return original.apply(this, callbackArgs);
  };
  wrapped.__benchmarkWrapped = true;
  callbacks.onDiscoveryStateChange = wrapped;
});

let measurement = null;
const visible = element => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
};
trace.startMeasurement = () => {
  const targets = [...document.querySelectorAll('[data-bench-id]')].map(element => ({
    id: element.dataset.benchId, source: element.textContent, visibleAtStart: visible(element), element,
  }));
  const targetByElement = new WeakMap(targets.map(target => [target.element, target]));
  const targetById = new Map(targets.map(target => [target.id, target]));
  const acceptedIds = new Set();
  const duplicateAcceptedIds = new Set();
  const mutations = [];
  const observerState = { recordCount: 0 };
  const firstAcceptedAtById = {};
  const visibleIds = new Set(targets.filter(target => target.visibleAtStart).map(target => target.id));
  let firstVisibleAcceptedWriteAt = null;
  const completionTimes = { visible: null, all: null };
  const processMutations = records => {
    observerState.recordCount += records.length;
    const groups = groupMutationRecords(records, record => {
      const element = (record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement)?.closest('[data-bench-id]');
      return targetByElement.get(element)?.id;
    });
    for (const group of groups) {
      const target = targetById.get(group.key);
      const expectedText = `\u200e${trace.translationPrefix} ${target.source}`;
      const acceptedWrite = target.element.textContent === expectedText;
      const duplicateAcceptedWrite = isDuplicateAcceptedMutation({
        wasAlreadyAccepted: acceptedIds.has(target.id), expectedText,
        resultingText: target.element.textContent, records: group.records,
      });
      mutations.push({ at: Date.now(), id: target.id, recordCount: group.records.length, types: [...new Set(group.records.map(record => record.type))], acceptedWrite, duplicateAcceptedWrite });
      if (trace.cancellationLedger && acceptedWrite) {
        const ownership = trace.cancellationAcceptedTransitions.get(target.id);
        trace.cancellationLedger.record('dom.acceptedMutation', ownership?.sessionId ?? null, {
          id: target.id,
          originTransitionSequence: ownership?.sequence ?? null,
          originTransitionCaptured: ownership !== undefined,
          duplicateAcceptedWrite,
        });
      }
      if (!acceptedWrite) {
        acceptedIds.delete(target.id);
        continue;
      }
      if (duplicateAcceptedWrite) {
        duplicateAcceptedIds.add(target.id);
        trace.record('dom.duplicateAcceptedWrite', { id: target.id });
      }
      if (acceptedIds.has(target.id)) {
        continue;
      }
      const acceptedAt = Date.now();
      const firstObservation = trackAcceptedTarget({
        id: target.id, at: acceptedAt, acceptedIds, firstAcceptedAtById,
        visibleIds: [...visibleIds], targetCount: targets.length, completionTimes,
      });
      if (firstObservation) trace.record('dom.acceptedWrite', { id: target.id, at: acceptedAt, visibleAtStart: target.visibleAtStart });
      if (target.visibleAtStart && firstVisibleAcceptedWriteAt === null) {
        firstVisibleAcceptedWriteAt = acceptedAt;
        trace.record('dom.firstVisibleAcceptedWrite', { id: target.id, at: acceptedAt });
      }
    }
  };
  const longTasks = [];
  const observer = new MutationObserver(processMutations);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  let longTaskObserver = null;
  let longTasksUnavailableReason = null;
  if (!globalThis.PerformanceObserver || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    longTasksUnavailableReason = 'PerformanceObserver longtask entries unsupported';
  } else {
    try {
      longTaskObserver = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch (error) { longTasksUnavailableReason = error.message; longTaskObserver = null; }
  }
  measurement = { startedAt: Date.now(), targets, acceptedIds, duplicateAcceptedIds, mutations, observerState, firstAcceptedAtById, visibleIds, completionTimes, observer, processMutations, longTaskObserver, longTasks, longTasksUnavailableReason, firstVisible: () => firstVisibleAcceptedWriteAt };
  trace.record('measurement.start', { targetCount: targets.length });
  return {
    startedAt: measurement.startedAt,
    targetCount: targets.length,
    visibleIds: targets.filter(target => target.visibleAtStart).map(target => target.id),
    longTasksSupported: !!longTaskObserver,
    longTasksUnavailableReason,
  };
};
trace.stopMeasurement = () => {
  if (!measurement) return { available: false, reason: 'measurement not started' };
  const current = measurement;
  try {
    drainAndDisconnectMeasurementObservers({
      mutationObserver: current.observer,
      processMutations: current.processMutations,
      longTaskObserver: current.longTaskObserver,
      processLongTasks: entries => current.longTasks.push(...entries.map(entry => ({ startTime: entry.startTime, duration: entry.duration }))),
    });
  } finally {
    measurement = null;
  }
  trace.record('measurement.stop');
  return {
    available: true, startedAt: current.startedAt, stoppedAt: Date.now(), targetCount: current.targets.length,
    acceptedUniqueCount: current.acceptedIds.size, acceptedIds: [...current.acceptedIds], duplicateAcceptedIds: [...current.duplicateAcceptedIds],
    firstAcceptedAtById: current.firstAcceptedAtById,
    visibleIds: [...current.visibleIds], visibleSetCompletionAt: current.completionTimes.visible,
    allTargetsCompletionAt: current.completionTimes.all,
    observerRecordCount: current.observerState.recordCount,
    firstVisibleAcceptedWriteAt: current.firstVisible(), mutations: current.mutations,
    longTasks: current.longTaskObserver ? current.longTasks : null,
    longTasksUnavailableReason: current.longTasksUnavailableReason,
  };
};
trace.calibrateLongTasks = async () => {
  if (!globalThis.PerformanceObserver || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    return { supported: false, captured: false, count: null, maxDurationMs: null, entries: null, reason: 'PerformanceObserver longtask entries unsupported' };
  }
  const entries = [];
  let observer;
  try {
    observer = new PerformanceObserver(list => entries.push(...list.getEntries().map(entry => ({ duration: entry.duration }))));
    observer.observe({ type: 'longtask', buffered: false });
    await new Promise(resolve => setTimeout(() => {
      const deadline = performance.now() + 75;
      while (performance.now() < deadline) { /* Isolated long-task observer calibration, before translation measurement. */ }
      resolve();
    }, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    entries.push(...observer.takeRecords().map(entry => ({ duration: entry.duration })));
    observer.disconnect();
    const maxDurationMs = entries.length ? Math.max(...entries.map(entry => entry.duration)) : 0;
    return { supported: true, captured: entries.some(entry => entry.duration >= 50), count: entries.length, maxDurationMs, entries };
  } catch (error) {
    observer?.disconnect();
    return { supported: false, captured: false, count: null, maxDurationMs: null, entries: null, reason: error.message };
  }
};

// Load the real content-script graph before exposing a thin runtime control channel.
await import('../../../src/core/content-scripts/index-main.js');

globalThis.chrome.runtime.onMessage.addListener(message => {
  if (message?.action === 'page-translation-frame-lifecycle') {
    trace.record('content.lifecycle', { action: message.action, at: Date.now(), sessionId: message?.data?.sessionId ?? null });
    window.dispatchEvent(new CustomEvent('__benchmark-runtime-event', { detail: message }));
  } else if (typeof message?.action === 'string' && message.action.startsWith('PAGE_TRANSLATE')) {
    trace.record('content.runtimeMessage', { action: message.action, sessionId: message?.data?.sessionId ?? null });
    window.dispatchEvent(new CustomEvent('__benchmark-runtime-event', { detail: message }));
  }
});
window.__pageTranslationBenchmark = trace;

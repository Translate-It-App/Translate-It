import { PageTranslationManager } from '../../../../src/features/page-translation/PageTranslationManager.js';
import { FeatureManager } from '../../../../src/core/managers/content/FeatureManager.js';
import { PageTranslationScheduler } from '../../../../src/features/page-translation/PageTranslationScheduler.js';
import { PageTranslationBridge } from '../../../../src/features/page-translation/PageTranslationBridge.js';
import { MainFrameCoordinator } from '../../../../src/core/content-scripts/main/MainFrameCoordinator.js';
import { PAGE_TRANSLATION_SLICED_DISCOVERY, PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY } from '../../../../src/features/page-translation/PageTranslationConstants.js';
import { captureViewportWindow, installCallThrough, installPrimitiveAdmissionObserver } from './trace.mjs';
import { drainAndDisconnectMeasurementObservers, groupMutationRecords, isDuplicateAcceptedMutation, registerThenInsertCohort, trackAcceptedTarget, trackCohortAcceptedTarget } from './measurement-lifecycle.mjs';
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
  spaNavigation: null,
  discoveryAdmissionOrder: null,
  schedulerEnqueueOrder: [],
  selectedBatchMembers: [],
  schedulerBatchSessions: [],
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
    const validTargetId = id => /^target-(?:[0-9]|1[01])$/.test(id)
      || (this.dynamicDOMEnabled === true && (/^dynamic-[12]-[1-3]$/.test(id) || this.shadowManifest?.has(id)));
    if (message?.action !== 'page-translate-batch' || typeof message.messageId !== 'string'
        || typeof message.data?.sessionId !== 'string' || !Array.isArray(targetIds) || !targetIds.length
        || targetIds.some(id => !validTargetId(id))
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
      managerTranslating: manager.isTranslating === true,
      isTranslated: scheduler.isTranslated === true,
      translatedCount: scheduler.translatedCount ?? null,
      failedCount: scheduler.failedCount ?? null,
      totalTasks: scheduler.totalTasks ?? null,
      activeFlushes: scheduler.activeFlushes ?? null,
      ...(trace.scrollThroughStages ? { isScrolling: scheduler.isScrolling } : {}),
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
  viewportEntrySnapshot() { return measurement ? { ...measurement.viewportEntryAtById } : null; },
  schedulerSelectionSnapshot() { return trace.scrollThroughStages ? structuredClone(trace.scrollThroughStages.selectionViewport) : null; },
  measurementSnapshot() { return measurement ? { acceptedIds: [...measurement.acceptedIds], acceptedPerformanceAtById: { ...measurement.acceptedPerformanceAtById }, viewportEntryAtById: { ...measurement.viewportEntryAtById } } : null; },
  enableSpaNavigationTracking({ changedIds, sources }) {
    if (this.spaNavigation) throw new Error('SPA navigation tracking may only be enabled once.');
    const elements = new Map([...document.querySelectorAll('[data-bench-id]')].map(element => [element.dataset.benchId, element]));
    if (!Array.isArray(changedIds) || changedIds.length !== 3 || changedIds.some(id => !elements.has(id))
        || !Array.isArray(sources) || sources.length !== elements.size) throw new Error('Invalid SPA fixture target oracle.');
    const targetSource = (id, element = elements.get(id)) => element?.dataset.benchKind === 'title' ? element.getAttribute('title') : element?.textContent;
    const idsByElement = new Map([...elements].map(([id, element]) => [element, id]));
    this.spaNavigation = {
      elements, idsByElement, changedIds: [...changedIds], sources: [...sources], originalSources: new Map([...elements].map(([id, element]) => [id, targetSource(id, element)])),
      identity: new Map(elements), navStartedAt: null, invalidatedAt: null, sourceMutationAt: null, stopAt: null,
      admissions: [], enqueues: [], batches: [], acceptedAtById: {}, acceptedBySession: {}, duplicateAcceptedIds: [], terminalAt: null,
    };
    const observe = records => {
      const state = this.spaNavigation;
      for (const record of records) {
        const target = record.target;
        if (!target || ![Node.ELEMENT_NODE, Node.ATTRIBUTE_NODE, Node.TEXT_NODE].includes(target.nodeType)) continue;
        const candidate = (target.nodeType === Node.ELEMENT_NODE ? target : target.nodeType === Node.ATTRIBUTE_NODE ? target.ownerElement : target.parentElement)?.closest('[data-bench-id]');
        const id = state.idsByElement.get(candidate);
        if (!id) continue;
        const element = state.elements.get(id);
        const owner = FeatureManager.getInstance().getFeatureHandler('pageTranslation')?.scheduler?.translationSessionId ?? null;
        if (!state.sessionB && state.navStartedAt !== null && owner && owner !== state.sessionA) state.sessionB = owner;
        const source = state.changedIds.includes(id) && owner === state.sessionB
          ? state.sources[Number(id.slice(7))] : state.originalSources.get(id);
        const translatedValue = `\u200e${this.translationPrefix} ${source}`;
        const resultingValue = element?.dataset.benchKind === 'title' ? element.getAttribute('title') : element.textContent;
        if (resultingValue !== translatedValue) continue;
        if (!owner) continue;
        const accepted = state.acceptedBySession[owner] ??= new Set();
        accepted.add(id);
        if (state.changedIds.includes(id) && owner !== state.sessionA) {
          if (!state.sessionB && owner !== state.sessionA) state.sessionB = owner;
          if (owner !== state.sessionB) continue;
          if (Object.hasOwn(state.acceptedAtById, id)) state.duplicateAcceptedIds.push(id);
          else state.acceptedAtById[id] = performance.now();
        }
      }
    };
    this.spaNavigation.observerCallback = observe;
    this.spaNavigation.observer = new MutationObserver(observe);
    this.spaNavigation.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
    return { targetIds: [...elements.keys()], changedIds: [...changedIds], identityCount: elements.size };
  },
  beginSpaNavigation() {
    if (!this.spaNavigation || this.spaNavigation.navStartedAt !== null) throw new Error('SPA navigation tracking is not ready.');
    const state = this.spaNavigation;
    state.navStartedAt = performance.now();
    document.getElementById('spa-navigation-control')?.click();
    return state.navStartedAt;
  },
  spaSnapshot() {
    const state = this.spaNavigation;
    if (!state) return null;
    const manager = FeatureManager.getInstance().getFeatureHandler('pageTranslation');
    const scheduler = manager?.scheduler;
    const pendingMeasurementMutations = measurement?.observer?.takeRecords() ?? [];
    if (pendingMeasurementMutations.length) measurement.processMutations(pendingMeasurementMutations);
    const pendingMutations = state.observer.takeRecords();
    if (pendingMutations.length) state.observerCallback(pendingMutations);
    const currentId = scheduler?.translationSessionId ?? null;
    const targetValue = element => element.dataset.benchKind === 'title' ? element.getAttribute('title') : element.textContent;
    const featureManager = FeatureManager.getInstance();
    return {
      changedIds: state.changedIds, originalSources: [...state.originalSources], navStartedAt: state.navStartedAt,
      invalidatedAt: state.invalidatedAt, sourceMutationAt: state.sourceMutationAt, stopAt: state.stopAt, cursorB: state.cursor,
      cursorA: state.cursorA ?? null, sessionA: state.sessionA, sessionB: state.sessionB, admissions: state.admissions, enqueues: state.enqueues,
      batches: state.batches,
      acceptedAtById: state.acceptedAtById, duplicateAcceptedIds: state.duplicateAcceptedIds,
      cursor: featureManager.navigationCursor ?? state.cursor ?? null,
      managerCallEvents: this.events.filter(event => event.name === 'manager.translatePage.entry'),
      managerCalls: this.calls,
      schedulerRequests: this.schedulerRequests,
      identityPreserved: [...state.elements].every(([id, element]) => document.querySelector(`[data-bench-id="${id}"]`) === element),
      currentSessionId: currentId,
      session: scheduler ? { managerTranslating: manager.isTranslating === true, activeFlushes: scheduler.activeFlushes ?? null,
        queueIds: scheduler.queue?.map(item => item?.id ?? null) ?? null, discoveryPending: scheduler.discoveryPending ?? null } : null,
      dom: [...state.elements].map(([id, element]) => [id, targetValue(element)]),
      sourceValues: [...state.elements].map(([id, element]) => [id, element.dataset.benchRouteSource ?? targetValue(element)]),
      acceptedIds: [...(state.acceptedBySession[state.sessionA] ?? [])],
      acceptedBySession: Object.fromEntries(Object.entries(state.acceptedBySession).map(([owner, accepted]) => [owner, [...accepted]])),
      events: this.events.filter(event => event.name.startsWith('spa.')),
    };
  },
  finishSpaNavigationTracking() {
    const state = this.spaNavigation;
    if (!state?.observer) return { drained: false, reason: 'SPA observer unavailable' };
    const records = state.observer.takeRecords();
    if (records.length) state.observerCallback(records);
    state.observer.disconnect();
    return { drained: state.observer.takeRecords().length === 0, disconnected: true, finalAcceptedAtById: state.acceptedAtById };
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
      sessionId: _manager.scheduler?.translationSessionId ?? null,
      targetLanguage: options.targetLanguage ?? null,
    });
  },
  onSettled(manager, args, at, endedAt) {
    const options = args[0] ?? {};
    trace.calls.push({ at, endedAt, isAuto: options.isAuto === true, sessionId: manager.scheduler?.translationSessionId ?? null, settings: {
      provider: manager.settings?.translationApi ?? null,
      targetLanguage: manager.settings?.targetLanguage ?? options.targetLanguage ?? null,
      lazyLoading: manager.settings?.lazyLoading ?? null,
      translateAfterScrollStop: manager.settings?.translateAfterScrollStop ?? null,
      autoTranslateOnDOMChanges: manager.settings?.autoTranslateOnDOMChanges ?? null,
    }, messageId: manager.translationMessageId, totalTasks: manager.scheduler?.totalTasks });
  },
});

const originalUrlCheck = FeatureManager.prototype.checkForUrlChange;
if (typeof originalUrlCheck === 'function') {
  FeatureManager.prototype.checkForUrlChange = function (...args) {
    const result = originalUrlCheck.apply(this, args);
    if (document.documentElement?.dataset?.benchSpaScenario === 'true' && location.pathname === '/replacement' && args[0]?.navigationCursor) {
      const cursor = args[0]?.navigationCursor ?? null;
      const state = trace.spaNavigation;
      if (state && state.invalidatedAt === null) {
        state.invalidatedAt = performance.now();
        state.cursor = cursor;
      }
      trace.record('spa.navigation.invalidated', { cursor, performanceAt: state?.invalidatedAt ?? performance.now() });
      document.dispatchEvent(new CustomEvent('translate-it:benchmark-spa-invalidated', { detail: { cursor } }));
      if (state && state.sourceMutationAt === null) state.sourceMutationAt = performance.now();
    }
    return result;
  };
}

const benchmarkTargetId = node => {
  const element = node?.nodeType === Node.ELEMENT_NODE
    ? node
    : node?.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node?.parentElement;
  return trace.benchmarkIdsByElement?.get(element) ?? element?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
};

const recordScrollStage = (name, id) => {
  const stages = trace.scrollThroughStages;
  if (!stages || !stages.expectedIds.includes(id)) return;
  stages[name][id] ??= performance.now();
};

const scrollSelectionTarget = node => {
  const id = benchmarkTargetId(node);
  const element = node?.nodeType === Node.ELEMENT_NODE ? node
    : node?.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node?.parentElement;
  const rect = element?.getBoundingClientRect?.();
  if (!id || !rect) return { id, classification: 'unavailable' };
  const visible = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  const buffered = rect.bottom > -50 && rect.top < innerHeight + 50 && rect.right > -50 && rect.left < innerWidth + 50;
  return { id, classification: visible ? 'viewport' : buffered ? 'permitted-50px-buffer' : 'outside-buffer' };
};

const installScrollThroughIntersectionObserver = session => {
  const scheduler = session?.intersectionScheduler;
  const originalAdd = scheduler?.add;
  if (!scheduler || typeof originalAdd !== 'function' || originalAdd.__scrollThroughObserved) return false;
  const observedAdd = function (node, callback) {
    const id = benchmarkTargetId(node);
    recordScrollStage('bridgeDiscoveredAtById', id);
    recordScrollStage('intersectionSchedulerRegisteredAtById', id);
    const observedCallback = function (...args) {
      recordScrollStage('intersectionCallbackAtById', id);
      return callback.apply(this, args);
    };
    return originalAdd.call(this, node, observedCallback);
  };
  observedAdd.__scrollThroughObserved = true;
  scheduler.add = observedAdd;
  return true;
};

const observedAdmissionNodes = new WeakSet();
const originalStopAutoTranslation = PageTranslationManager.prototype.stopAutoTranslation;
if (typeof originalStopAutoTranslation === 'function') {
  PageTranslationManager.prototype.stopAutoTranslation = function (...args) {
    const state = trace.spaNavigation;
    if (state && state.navStartedAt !== null && state.stopAt === null) {
      state.stopAt = performance.now();
      trace.record('spa.navigation.stop', { performanceAt: state.stopAt, cancellationReason: args[0]?.cancellationReason ?? null });
    }
    return originalStopAutoTranslation.apply(this, args);
  };
}
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

trace.acceptedSettlementIds = new Set();
trace.acceptedSettlementTransitions = [];
trace.enableDynamicDOMTracking = () => {
  if (trace.dynamicDOMEnabled === true) return true;
  const originalCreateSettlement = PageTranslationScheduler.prototype._createSettlement;
  if (typeof originalCreateSettlement !== 'function') return false;
  trace.discoveryAdmissionOrder = [];
  const observedCreateSettlement = function (...args) {
    const ownerSessionId = this.translationSessionId ?? null;
    const settlement = originalCreateSettlement.apply(this, args);
    const id = benchmarkTargetId(args[0]?.node);
    const settle = settlement?.settle;
    if (typeof settle === 'function') settlement.settle = function (outcome) {
      const result = settle.call(this, outcome);
      if (result === true && outcome === 'accepted' && id) {
        trace.acceptedSettlementIds.add(id);
        trace.acceptedSettlementTransitions.push({ id, sessionId: ownerSessionId, at: performance.now() });
      }
      return result;
    };
    return settlement;
  };
  observedCreateSettlement.__benchmarkAcceptedObserved = true;
  PageTranslationScheduler.prototype._createSettlement = observedCreateSettlement;
  trace.dynamicDOMEnabled = true;
  return true;
};

installCallThrough(PageTranslationScheduler.prototype, 'enqueue', function (args) {
  const [text, , score, node] = args;
  const id = benchmarkTargetId(node);
  recordScrollStage('schedulerEnqueueAtById', id);
  trace.schedulerEnqueueOrder.push(id);
  if (trace.spaNavigation && trace.spaNavigation.invalidatedAt !== null) trace.spaNavigation.enqueues.push({ id, at: performance.now(), sessionId: this.translationSessionId ?? null });
  trace.record('scheduler.enqueue', { id, score: Number(score) || 0, textLength: typeof text === 'string' ? text.length : null });
});
installCallThrough(PageTranslationScheduler.prototype, 'flush', function () {
  trace.record('scheduler.flush.entry', { queueLength: this.queue?.length ?? null, activeFlushes: this.activeFlushes ?? null, batchTimerPending: this.batchTimer != null });
});
installCallThrough(PageTranslationScheduler.prototype, '_executeBatchRequest', function ([batch]) {
  const targetIds = Array.isArray(batch) ? batch.map(item => benchmarkTargetId(item?.node)) : null;
  trace.selectedBatchMembers.push(targetIds);
  trace.schedulerBatchSessions.push({ sessionId: this.translationSessionId ?? null, targetIds });
  if (trace.scrollThroughStages) trace.scrollThroughStages.selectionViewport.push({
    at: performance.now(), isScrolling: this.isScrolling,
    targetIds, targets: Array.isArray(batch) ? batch.map(item => scrollSelectionTarget(item?.node)) : null,
  });
  if (trace.spaNavigation && trace.spaNavigation.invalidatedAt !== null) trace.spaNavigation.batches.push({ sessionId: this.translationSessionId ?? null, targetIds, at: performance.now() });
  trace.record('scheduler.executeBatchRequest.entry', { itemCount: Array.isArray(batch) ? batch.length : null, targetIds });
});
installCallThrough(PageTranslationBridge.prototype, 'translate', function () {
  trace.bridgeSession = this.session;
  const spaManager = FeatureManager.getInstance().getFeatureHandler('pageTranslation');
  const spaSessionId = spaManager?.scheduler?.translationSessionId ?? null;
  if (trace.spaNavigation && trace.spaNavigation.navStartedAt !== null && spaSessionId && spaSessionId !== trace.spaNavigation.sessionA) trace.spaNavigation.sessionB = spaSessionId;
  if (trace.dynamicDOMEnabled !== true) trace.discoveryAdmissionOrder = [];
  trace.viewportWindowObservation = null;
  const session = this.session;
  if (trace.scrollThroughStages) installScrollThroughIntersectionObserver(session);
  const nodesTranslator = session?.domTranslator?.nodesTranslator;
  if (nodesTranslator && !observedAdmissionNodes.has(nodesTranslator)) {
    const installed = installPrimitiveAdmissionObserver(session, function ([node]) {
      const id = benchmarkTargetId(node);
      recordScrollStage('schedulerAdmissionAtById', id);
      trace.discoveryAdmissionOrder.push(id);
      if (trace.spaNavigation && trace.spaNavigation.invalidatedAt !== null) trace.spaNavigation.admissions.push({ id, at: performance.now(), sessionId: FeatureManager.getInstance().getFeatureHandler('pageTranslation')?.scheduler?.translationSessionId ?? null });
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
    const discovery = trace.bridgeSession?.discovery;
    const queueDepth = Array.isArray(discovery?.queue) && Number.isInteger(discovery.head)
      ? Math.max(0, discovery.queue.length - discovery.head) : null;
    trace.record('bridge.discovery.pending', { pending: callbackArgs[0] === true,
      bridgePending: typeof discovery?.pending === 'boolean' ? discovery.pending : null, queueDepth,
      running: typeof discovery?.running === 'boolean' ? discovery.running : null });
    return original.apply(this, callbackArgs);
  };
  wrapped.__benchmarkWrapped = true;
  callbacks.onDiscoveryStateChange = wrapped;
});

let measurement = null;
let configuredExpectedTargetIds = null;
const visible = element => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
};
trace.startMeasurement = ({ scrollThrough = false, shadowDom = false } = {}) => {
  const shadowElements = shadowDom ? [...trace.shadowTargetById.values()] : null;
  const targets = (shadowElements ?? [...document.querySelectorAll('[data-bench-id]')]).map(element => ({
    id: element.dataset.benchId, source: element.textContent, visibleAtStart: visible(element), element,
  }));
  if (shadowDom) for (const target of targets) {
    const manifest = trace.shadowManifest.get(target.id);
    target.source = manifest.source;
    target.kind = manifest.kind;
  }
  const initialTargetIds = targets.map(target => target.id);
  trace.scrollThroughStages = scrollThrough ? {
    expectedIds: [...initialTargetIds],
    bridgeDiscoveredAtById: {},
    intersectionSchedulerRegisteredAtById: {},
    intersectionCallbackAtById: {},
    schedulerAdmissionAtById: {},
    schedulerEnqueueAtById: {},
    selectionViewport: [],
  } : null;
  const expectedTargetIds = configuredExpectedTargetIds ?? initialTargetIds;
  const dynamicTargetTracking = configuredExpectedTargetIds !== null;
  if (initialTargetIds.some(id => !expectedTargetIds.includes(id))) throw new Error('Expected target inventory does not include every initial fixture target.');
  const initialRemainingIds = dynamicTargetTracking ? new Set(initialTargetIds) : null;
  const expectedRemainingIds = dynamicTargetTracking ? new Set(expectedTargetIds) : null;
  const targetByElement = new WeakMap(targets.map(target => [target.element, target]));
  const targetById = new Map(targets.map(target => [target.id, target]));
  const acceptedIds = new Set();
  const duplicateAcceptedIds = new Set();
  const mutations = [];
  const observerState = { recordCount: 0 };
  const firstAcceptedAtById = {};
  const acceptedPerformanceAtById = {};
  const viewportEntryAtById = {};
  let viewportObserver = null;
  const visibleIds = new Set(targets.filter(target => target.visibleAtStart).map(target => target.id));
  const visibleRemainingIds = dynamicTargetTracking ? new Set(visibleIds) : null;
  let firstVisibleAcceptedWriteAt = null;
  const completionTimes = dynamicTargetTracking
    ? { visible: null, initialAll: null, all: null, visibleMaxAcceptedAt: null, initialMaxAcceptedAt: null, allMaxAcceptedAt: null }
    : { visible: null, all: null };
  const dynamicCohorts = new Map();
  const dynamicCohortByTargetId = new Map();
  const processMutations = records => {
    observerState.recordCount += records.length;
    const groups = groupMutationRecords(records, record => {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target
        : record.target.nodeType === Node.ATTRIBUTE_NODE ? record.target.ownerElement : record.target.parentElement;
      return targetByElement.get(element)?.id ?? targetByElement.get(element?.closest?.('[data-bench-id]'))?.id;
    });
    for (const group of groups) {
      const target = targetById.get(group.key);
      const expectedText = `\u200e${trace.translationPrefix} ${target.source}`;
      const resultingValue = target.kind === 'title' ? target.element.getAttribute('title') : target.element.textContent;
      const acceptedWrite = resultingValue === expectedText;
      const duplicateAcceptedWrite = isDuplicateAcceptedMutation({
        wasAlreadyAccepted: acceptedIds.has(target.id), expectedText,
        resultingText: resultingValue, records: group.records,
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
        visibleIds: [...visibleIds], targetCount: targets.length,
        ...(dynamicTargetTracking ? { visibleRemainingIds, initialRemainingIds, expectedRemainingIds } : {}), completionTimes,
      });
      const acceptedPerformanceAt = performance.now();
      acceptedPerformanceAtById[target.id] ??= acceptedPerformanceAt;
      const cohort = dynamicCohortByTargetId.get(target.id);
      if (cohort) trackCohortAcceptedTarget(cohort, target.id, acceptedPerformanceAt);
      if (firstObservation) trace.record('dom.acceptedWrite', { id: target.id, at: acceptedAt, visibleAtStart: target.visibleAtStart });
      if (target.visibleAtStart && firstVisibleAcceptedWriteAt === null) {
        firstVisibleAcceptedWriteAt = acceptedAt;
        trace.record('dom.firstVisibleAcceptedWrite', { id: target.id, at: acceptedAt });
      }
    }
  };
  const longTasks = [];
  const observer = new MutationObserver(processMutations);
  const observedRoots = new Set(shadowDom ? trace.shadowRoots : []);
  const observedTargets = new Set();
  if (shadowDom) {
    for (const root of observedRoots) observer.observe(root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
    const lightTarget = trace.shadowTargetById.get('shadow-light');
    observer.observe(lightTarget, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
    observedTargets.add(lightTarget);
  } else observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  if (scrollThrough) {
    viewportObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !measurement?.targetByElement.has(entry.target)) continue;
        const id = measurement.targetByElement.get(entry.target).id;
        viewportEntryAtById[id] ??= entry.time;
      }
    }, { root: null, rootMargin: '0px' });
    for (const target of targets) viewportObserver.observe(target.element);
  }
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
  measurement = { startedAt: Date.now(), startedPerformanceAt: performance.now(), scrollThrough, shadowDom, observedRoots, observedTargets, targets, initialTargetIds, expectedTargetIds, targetByElement, targetById, acceptedIds, duplicateAcceptedIds, mutations, observerState, firstAcceptedAtById, acceptedPerformanceAtById, viewportEntryAtById, viewportObserver, visibleIds, completionTimes, dynamicCohorts, dynamicCohortByTargetId, observer, processMutations, longTaskObserver, longTasks, longTasksUnavailableReason, firstVisible: () => firstVisibleAcceptedWriteAt };
  trace.record('measurement.start', { targetCount: targets.length });
  return {
    startedAt: measurement.startedAt, startedPerformanceAt: measurement.startedPerformanceAt,
    targetCount: targets.length,
    visibleIds: targets.filter(target => target.visibleAtStart).map(target => target.id),
    longTasksSupported: !!longTaskObserver,
    longTasksUnavailableReason,
    ...(scrollThrough ? { viewportEntryAtById: { ...viewportEntryAtById } } : {}),
  };
};
trace.setExpectedTargetIds = ids => {
  if (measurement || !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) {
    throw new Error('Expected target IDs must be configured once, before measurement, as a unique string list.');
  }
  configuredExpectedTargetIds = [...ids];
  return true;
};
trace.enableShadowDOMTracking = targets => {
  if (trace.shadowManifest || measurement || !Array.isArray(targets) || targets.length !== 5) throw new Error('Shadow DOM target oracle must be installed once before measurement.');
  trace.shadowManifest = new Map(targets.map(target => [target.id, target]));
  const initialRoot = document.getElementById('shadow-initial-host')?.shadowRoot;
  const nestedRoot = initialRoot?.querySelector('#shadow-nested-host')?.shadowRoot;
  const initialElements = new Map([['shadow-light', document.querySelector('[data-bench-id="shadow-light"]')],
    ['shadow-open', initialRoot?.querySelector('[data-bench-id="shadow-open"]')],
    ['shadow-nested-title', nestedRoot?.querySelector('[data-bench-id="shadow-nested-title"]')]]);
  trace.shadowTargetById = new Map(targets.slice(0, 3).map(target => {
    const element = initialElements.get(target.id);
    if (!element) throw new Error(`Initial Shadow DOM target is unavailable: ${target.id}`);
    return [target.id, element];
  }));
  trace.shadowRoots = new Set([initialRoot, nestedRoot]);
  if (trace.shadowRoots.has(null)) throw new Error('Fixture-owned initial open ShadowRoots are unavailable.');
  trace.benchmarkIdsByElement = new WeakMap([...trace.shadowTargetById].map(([id, element]) => [element, id]));
  return { targetIds: [...trace.shadowTargetById.keys()] };
};
trace.insertShadowTarget = (id, phase) => {
  const target = trace.shadowManifest?.get(id);
  if (!target || !measurement?.shadowDom || measurement.targetById.has(id)) throw new Error(`Invalid Shadow DOM dynamic target: ${id}`);
  let element;
  let originalState;
  let originalAttributes;
  let originalValue;
  let insertedRoot;
  const item = { ...target, element: null, visibleAtStart: false };
  const cohort = { id: `shadow-${phase}`, targetIds: [id], remainingIds: new Set([id]), insertedAt: null, firstAcceptedAt: null, completionAt: null, acceptedAtById: {} };
  const inserted = registerThenInsertCohort({
    register: () => {
      element = document.createElement('p');
      element.dataset.benchId = id;
      element.dataset.benchKind = target.kind;
      element.style.direction = 'rtl';
      element.style.unicodeBidi = 'isolate';
      element.textContent = target.source;
      originalValue = target.kind === 'title' ? element.getAttribute('title') : element.textContent;
      if (phase === 'detached-host') {
        const host = document.createElement('div');
        insertedRoot = host.attachShadow({ mode: 'open' });
        measurement.shadowInsertedHost = host;
        measurement.shadowInsertedRoot = insertedRoot;
        measurement.observedRoots.add(insertedRoot);
        measurement.observer.observe(insertedRoot, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
      } else insertedRoot = measurement.shadowInsertedRoot;
      trace.benchmarkIdsByElement.set(element, id);
      trace.shadowTargetById.set(id, element);
      item.element = element;
      measurement.targets.push(item);
      measurement.targetByElement.set(element, item);
      measurement.targetById.set(id, item);
      measurement.dynamicCohortByTargetId.set(id, cohort);
      measurement.dynamicCohorts.set(cohort.id, cohort);
      originalAttributes = [...element.attributes].map(attribute => [attribute.name, attribute.value]);
      const style = getComputedStyle(element);
      originalState = { inlineDirection: element.style.direction, inlineUnicodeBidi: element.style.unicodeBidi,
        computedDirection: style.direction, computedUnicodeBidi: style.unicodeBidi,
        markers: Object.fromEntries(['data-page-translated', 'data-has-original', 'data-dir-original-saved', 'data-translate-dir']
          .map(name => [name, element.getAttribute(name)])) };
      if (phase === 'detached-host') insertedRoot.append(element);
    },
    now: () => performance.now(),
    insert: () => {
      if (phase === 'detached-host') {
        (document.querySelector('main') ?? document.body).append(measurement.shadowInsertedHost);
      } else {
        if (!measurement.shadowInsertedRoot?.isConnected) throw new Error('Inserted open ShadowRoot is not connected.');
        measurement.shadowInsertedRoot.append(element);
      }
    },
  });
  cohort.insertedAt = inserted.insertedAt;
  return { id, insertedAt: cohort.insertedAt, source: originalValue,
    originalAttributes, directionState: originalState && Object.fromEntries(Object.entries(originalState).filter(([key]) => ['inlineDirection', 'inlineUnicodeBidi'].includes(key))),
    markers: originalState?.markers };
};
trace.insertDynamicCohort = cohort => {
  if (trace.dynamicDOMEnabled !== true || !measurement || !Array.isArray(cohort?.targets) || typeof cohort.id !== 'string') throw new Error('Dynamic cohort registration requires enabled dynamic tracking, an active measurement and cohort targets.');
  if (measurement.dynamicCohorts.has(cohort.id)) throw new Error(`Dynamic cohort already inserted: ${cohort.id}`);
  const targetIds = cohort.targets.map(target => target.id);
  if (!targetIds.length || new Set(targetIds).size !== targetIds.length
      || cohort.targets.some(target => typeof target.id !== 'string' || typeof target.source !== 'string'
        || measurement.targetById.has(target.id))) throw new Error(`Dynamic cohort has invalid or duplicate target IDs: ${cohort.id}`);
  const prepared = cohort.targets.map(target => ({ ...target, visibleAtStart: false, element: null }));
  const cohortTiming = { id: cohort.id, targetIds, remainingIds: new Set(targetIds), insertedAt: null, firstAcceptedAt: null, completionAt: null, acceptedAtById: {} };
  // Register both observer and provider ledgers before making nodes discoverable to production.
  const insertion = registerThenInsertCohort({
    register: () => {
      const registeredElements = trace.registerProviderTargets?.(prepared.map(({ id, source }) => ({ id, source })));
      for (const [index, target] of prepared.entries()) {
        const element = registeredElements?.[index] ?? document.createElement('p');
        element.dataset.benchId = target.id;
        element.textContent = target.source;
        target.element = element;
        measurement.targets.push(target);
        measurement.targetByElement.set(element, target);
        measurement.targetById.set(target.id, target);
        measurement.dynamicCohortByTargetId.set(target.id, cohortTiming);
      }
      measurement.dynamicCohorts.set(cohort.id, cohortTiming);
    },
    now: () => performance.now(),
    insert: () => {
      const parent = document.querySelector('main') ?? document.body;
      for (const target of prepared) parent.append(target.element);
    },
  });
  cohortTiming.insertedAt = insertion.insertedAt;
  trace.record('dynamic.cohort.inserted', { id: cohort.id, insertedAt: cohortTiming.insertedAt, targetIds });
  return { id: cohort.id, insertedAt: cohortTiming.insertedAt, targetIds };
};
trace.dynamicSnapshot = () => ({
  acceptedSettlementIds: [...trace.acceptedSettlementIds],
  acceptedSettlementTransitions: trace.acceptedSettlementTransitions.map(transition => ({ ...transition })),
  acceptedDomIds: measurement ? [...measurement.acceptedIds] : [],
  cohorts: measurement ? [...measurement.dynamicCohorts.values()].map(cohort => ({
    id: cohort.id, targetIds: [...cohort.targetIds], insertedAt: cohort.insertedAt,
    firstAcceptedAt: cohort.firstAcceptedAt, completionAt: cohort.completionAt,
    acceptedAtById: { ...cohort.acceptedAtById },
  })) : [],
});
trace.stopMeasurement = () => {
  if (!measurement) return { available: false, reason: 'measurement not started' };
  const current = measurement;
  let observersDisconnected = false;
  try {
    current.viewportObserver?.disconnect();
    drainAndDisconnectMeasurementObservers({
      mutationObserver: current.observer,
      processMutations: current.processMutations,
      longTaskObserver: current.longTaskObserver,
      processLongTasks: entries => current.longTasks.push(...entries.map(entry => ({ startTime: entry.startTime, duration: entry.duration }))),
    });
    observersDisconnected = true;
  } finally {
    measurement = null;
  }
  trace.record('measurement.stop');
  return {
    available: true, startedAt: current.startedAt, startedPerformanceAt: current.startedPerformanceAt, stoppedAt: Date.now(), targetCount: current.targets.length,
    shadowDom: current.shadowDom ? { observedRootCount: current.observedRoots.size, observedTargetCount: current.observedTargets.size, observerDisconnected: observersDisconnected } : undefined,
    acceptedUniqueCount: current.acceptedIds.size, acceptedIds: [...current.acceptedIds], duplicateAcceptedIds: [...current.duplicateAcceptedIds],
    firstAcceptedAtById: current.firstAcceptedAtById,
    ...(current.scrollThrough ? {
      acceptedPerformanceAtById: current.acceptedPerformanceAtById,
      viewportEntryAtById: current.viewportEntryAtById,
    } : {}),
    ...(current.shadowDom ? { acceptedPerformanceAtById: current.acceptedPerformanceAtById } : {}),
    scrollThroughStages: trace.scrollThroughStages ? structuredClone(trace.scrollThroughStages) : null,
    expectedTargetIds: [...current.expectedTargetIds],
    initialTargetIds: [...current.initialTargetIds],
    visibleIds: [...current.visibleIds], visibleSetCompletionAt: current.completionTimes.visible,
    initialTargetsCompletionAt: current.completionTimes.initialAll,
    allTargetsCompletionAt: current.completionTimes.all,
    observerRecordCount: current.observerState.recordCount,
    firstVisibleAcceptedWriteAt: current.firstVisible(), mutations: current.mutations,
    longTasks: current.longTaskObserver ? current.longTasks : null,
    longTasksUnavailableReason: current.longTasksUnavailableReason,
    dynamicCohorts: [...current.dynamicCohorts.values()].map(cohort => ({
      id: cohort.id, targetIds: [...cohort.targetIds], insertedAt: cohort.insertedAt,
      firstAcceptedAt: cohort.firstAcceptedAt, completionAt: cohort.completionAt,
      firstAcceptedLatencyMs: cohort.firstAcceptedAt === null ? null : cohort.firstAcceptedAt - cohort.insertedAt,
      completionLatencyMs: cohort.completionAt === null ? null : cohort.completionAt - cohort.insertedAt,
      acceptedAtById: { ...cohort.acceptedAtById },
    })),
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
await import('../../../../src/core/content-scripts/index-main.js');

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

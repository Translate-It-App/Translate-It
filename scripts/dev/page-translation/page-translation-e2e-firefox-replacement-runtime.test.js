import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { MessageActions } from '../../../src/shared/messaging/core/MessageActions.js';
import { createReplacementCollector } from './e2e-firefox/runtime-replacement-collector.mjs';
import { replacementContentEventAction, replacementInvalidatedDomEvent, replacementProtocol } from './e2e-firefox/runtime-replacement-protocol.mjs';
import { createReplacementBackgroundAdapter, installReplacementWorkerObservers, seedReplacementAutoSettings } from './e2e-firefox/runtime-replacement-background.mjs';
import { createReplacementContentRuntime } from './e2e-firefox/runtime-replacement-content.mjs';

const base = { runId: 'replacement-adapter-test', authToken: 'b'.repeat(64), expectedExtensionId: 'replacement@test', expectedTabId: 9 };
const targets = (start, end) => Array.from({ length: end - start }, (_, i) => `target-${start + i}`);
const active = [];

function fakeRuntime({ config, senderUrl, senderOrigin = () => new URL(senderUrl()).origin, fixtureTabUrl = null }) {
  const listeners = new Set(); let externalHandler = null;
  const browserApi = { runtime: {
    id: config.expectedExtensionId,
    onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    async sendMessage(message) {
      const external = await externalHandler?.(message);
      if (external !== undefined) return external;
      for (const listener of [...listeners]) {
        const result = listener(message, { id: config.expectedExtensionId, tab: { id: config.expectedTabId }, tabId: config.expectedTabId,
          frameId: 0, url: senderUrl(), origin: senderOrigin(), documentId: config.actualDocumentId });
        if (result !== false && result !== undefined) return await result;
      }
      return undefined;
    },
  },
  // Browser-provided tab evidence: the bootstrap tab pin is anchored to a live
  // tab of this extension serving the fixture origin.
  tabs: { async query() { return fixtureTabUrl === null ? [] : [{ id: config.expectedTabId, url: fixtureTabUrl }]; } } };
  return { browserApi, listeners, setExternalHandler: handler => { externalHandler = handler; } };
}

async function realAdapter(runId, { beforeReport = async () => {}, senderOrigin, fixtureTabUrl = null } = {}) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const config = { ...base, runId, authToken: 'c'.repeat(64), fixtureUrl, expectedDocumentId: null, actualDocumentId: 'actual-document-id' };
  const collector = createReplacementCollector(config); collector.attach(server);
  let actualUrl = fixtureUrl;
  const runtime = fakeRuntime({ config, senderUrl: () => actualUrl, senderOrigin: senderOrigin ?? (() => new URL(actualUrl).origin),
    fixtureTabUrl: fixtureTabUrl ?? fixtureUrl });
  const storage = { set: vi.fn(async () => {}) };
  const transmissions = []; const rejectedTransmissions = [];
  // The real global fetch is captured here: a worker observer replaces the
  // global one later, and collector reports must still reach the collector.
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { const report = JSON.parse(options.body); transmissions.push(report); await beforeReport(report.event); }
    const response = await realFetch(url, options);
    if (!response.ok) rejectedTransmissions.push({ status: response.status, body: await response.clone().text() });
    return response;
  };
  const background = createReplacementBackgroundAdapter(config, { browserApi: { ...runtime.browserApi, storage: { local: storage } }, storage, fetchImpl });
  await background.initialize();
  active.push({ server, collector, background });
  return { config, routes: collector.routes, collector, background, runtime, transmissions, rejectedTransmissions,
    setUrl: value => { actualUrl = value; } };
}

afterEach(async () => {
  await Promise.all(active.splice(0).map(async ({ server, collector, background }) => {
    background.close(); await collector.drain(); await new Promise(resolve => server.close(resolve));
  }));
});

describe('Firefox Phase 2 browser-observation adapters', () => {
  it('seeds only the exact fixture route rules using the production matcher', async () => {
    const storage = { set: vi.fn(async () => {}) };
    const seeded = await seedReplacementAutoSettings({ fixtureUrl: 'http://127.0.0.1:45671/', storage });
    expect(seeded.rules).toEqual(['127.0.0.1/', '127.0.0.1/replacement']);
    // Production takes the provider and target language from extension settings,
    // so the harness seeds exactly those plus the two auto-rule keys.
    expect(storage.set).toHaveBeenCalledExactlyOnceWith({
      WHOLE_PAGE_AUTO_TRANSLATE_RULES: seeded.rules, WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: true,
      TRANSLATION_API: 'edge', TARGET_LANGUAGE: 'fr', PROVIDER_OPTIMIZATION_LEVELS: { edge: 5 },
    });
  });

  it('pins a bootstrap document from the actual A sender once and only advances to B on observed cursor evidence', async () => {
    const adapter = await realAdapter('sender-bootstrap', { senderOrigin: () => null }); const a = adapter.routes.A; const b = adapter.routes.B;
    const send = (event, evidence) => adapter.runtime.browserApi.runtime.sendMessage({ action: replacementProtocol.contentEventAction,
      v: replacementProtocol.version, runId: adapter.config.runId, event, evidence });
    await send('session-start', { owner: 'A', sessionId: 'session-A', currentUrl: a, isAuto: true, autoTranslateOnDomChanges: true,
      preserveAcceptedTranslations: false, cursor: null });
    expect(adapter.background.snapshot().pinnedSender).toMatchObject({ documentId: 'actual-document-id', origin: null });
    const otherDocument = await adapter.runtime.listeners.values().next().value({ action: replacementProtocol.contentEventAction,
      v: replacementProtocol.version, runId: adapter.config.runId, event: 'scheduler-batch', evidence: {
        owner: 'A', sessionId: 'session-A', messageId: 'bad-document', targetIds: ['target-0'],
      } }, { id: adapter.config.expectedExtensionId, tab: { id: adapter.config.expectedTabId }, frameId: 0,
      url: a, origin: new URL(a).origin, documentId: 'other-document' });
    expect(otherDocument).toMatchObject({ accepted: false });
    expect(otherDocument.reason).toContain('sender-not-pinned');
    await send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-first', targetIds: targets(0, 6) });
    await send('provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-first', invocationId: 'inv-a', targetIds: targets(0, 6) });
    await send('physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-first', invocationId: 'inv-a', attemptId: 'attempt-a', targetIds: targets(0, 6) });
    await send('physical-settled', { sessionId: 'session-A', messageId: 'a-first', attemptId: 'attempt-a', outcome: 'fulfilled', code: null, cleanup: false });
    await send('provider-root-settled', { sessionId: 'session-A', messageId: 'a-first', status: 'fulfilled', code: null,
      cleanup: false, operationAborted: false, cancellationReason: null });
    await send('accepted-A', { sessionId: 'session-A', messageId: 'a-first', targetIds: targets(0, 6) });
    await send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', targetIds: targets(6, 12) });
    await send('provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId: 'inv-held', targetIds: targets(6, 12) });
    await send('physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId: 'inv-held', attemptId: 'attempt-held', targetIds: targets(6, 12) });
    await adapter.background.getControl('navigate-to-b');
    expect(adapter.background.snapshot().currentRoute).toBe(a);
    // Firefox keeps the committed document URL as the sender URL across a
    // same-document route change, so the sender identity does not change.
    await send('spa-navigation', { fromUrl: a, toUrl: b, cursor: { documentEpoch: 2, routeRevision: 4, url: b } });
    await send('stop-ack', { sessionId: 'session-A', navigationCursor: { documentEpoch: 2, routeRevision: 4, url: b }, success: true,
      cancellationReason: 'operation-abort', resultSessionId: 'session-A', isAutoTranslating: false });
    await adapter.background.reportFromWorker('controller-abort', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-held', aborted: true, cause: 'spa-navigation' });
    await adapter.background.reportFromWorker('physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-held', outcome: 'cancelled', code: 'AbortError', cleanup: false });
    await adapter.background.reportFromWorker('provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'rejected', code: null,
      cleanup: false, operationAborted: true, cancellationReason: 'operation-abort' });
    expect(adapter.collector.snapshot().reports.at(-1).evidence.sender.url).toBe(a);
    expect(adapter.collector.snapshot().reports.every(report => report.evidence.sender.origin === null)).toBe(true);
  });

  it('fails closed for an untyped root rejection without native operation-cancellation facts', async () => {
    const adapter = await realAdapter('untyped-root-failure'); const a = adapter.routes.A;
    const send = (event, evidence) => adapter.runtime.browserApi.runtime.sendMessage({ action: replacementContentEventAction,
      v: replacementProtocol.version, runId: adapter.config.runId, event, evidence });
    await send('session-start', { owner: 'A', sessionId: 'session-A', currentUrl: a, isAuto: true, autoTranslateOnDomChanges: true,
      preserveAcceptedTranslations: false, cursor: null });
    await send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'batch-A', targetIds: targets(0, 6) });
    const proxyManager = { isEnabled: () => false, fetch(url, options) { return globalThis.fetch(url, options); } };
    const ProviderRequestEngine = { executeApiCall(_provider, options) { return proxyManager.fetch(options.url, options.fetchOptions); } };
    class FakeBaseProvider { async translate(texts, _source, _target, options) {
      await ProviderRequestEngine.executeApiCall(this, { ...options,
        url: 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=fr',
        fetchOptions: { method: 'POST', body: JSON.stringify(texts), signal: options.abortController.signal } });
      throw new Error('unclassified');
    } }
    const observers = installReplacementWorkerObservers({ background: adapter.background, BaseProvider: FakeBaseProvider,
      ProviderRequestEngine, proxyManager, globalObject: { fetch: async () => ({ status: 200 }) } });
    try {
      await expect(new FakeBaseProvider().translate(['source'], 'en', 'fr', { sessionId: 'session-A', messageId: 'batch-A',
        abortController: new AbortController(), url: 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=fr',
        fetchOptions: {} })).rejects.toThrow('unclassified');
      await vi.waitFor(() => expect(adapter.collector.snapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' }));
      expect(observers.snapshot().roots[0]).toMatchObject({ executeBound: true, fetchObserved: true });
    } finally { observers.dispose(); }
  });

  it('observes synchronous production invalidation, buffers abort telemetry, and reconciles real collector B Stop/final DOM', async () => {
    const { releaseNavReport, runtime, content, workerObservers } = await runReplacementIntegration();
    try {
      await vi.waitFor(() => expect(runtime.collector.snapshot().reports.some(report => report.event === 'cleanup'),
        JSON.stringify({ content: content.snapshot(), worker: workerObservers.snapshot(), background: runtime.background.snapshot(),
          rejectedTransmissions: runtime.rejectedTransmissions, transmissions: runtime.transmissions,
          collector: runtime.collector.snapshot() })).toBe(true), { timeout: 20_000 });
      expect(runtime.collector.snapshot().reports.find(report => report.event === 'stop-B').evidence).toMatchObject({ sessionId: 'session-B',
        resultSessionId: 'session-B', success: true, isAutoTranslating: false, bridgeActive: false, schedulerActive: false, discoveryActive: false,
        observerRelease: { expected: 1, released: 1, failed: 0 } });
      const final = await content.captureFinal();
      expect(final.sessionId).toBe('session-B'); expect(final.postInvalidationAWrites).toEqual([]);
      expect(runtime.collector.snapshot().proofComplete).toBe(true);
      expect(content.dispose()).toMatchObject({ observersDisposed: true, productionStopB: { sessionId: 'session-B' }, finalDOMReported: true });
      expect(workerObservers.dispose()).toMatchObject({ workerObserversDisposed: true, operationSnapshot: expect.any(Object) });
    } finally {
      releaseNavReport(); content.dispose(); workerObservers.dispose();
    }
  }, 30_000);

  it('does not report cleanup when the live session observer release probe is incomplete', async () => {
    const { runtime, content, workerObservers, releaseNavReport } = await runReplacementIntegration({ releaseSkipped: true });
    try {
      await vi.waitFor(() => expect(content.snapshot().lastError).toBeTruthy(), { timeout: 20_000 });
      expect(content.snapshot().cleanup).toBeNull();
      expect(runtime.transmissions.some(report => ['stop-B', 'cleanup'].includes(report.event))).toBe(false);
    } finally {
      releaseNavReport(); content.dispose(); workerObservers.dispose();
    }
  }, 30_000);
});

async function runReplacementIntegration({ releaseSkipped = false } = {}) {
  let releaseNavReport; let navReportStartedResolve;
    const navReportGate = new Promise(resolve => { releaseNavReport = resolve; });
    const navReportStarted = new Promise(resolve => { navReportStartedResolve = resolve; });
    const runtime = await realAdapter('complete-adapter-observation', { beforeReport: async event => {
      if (event === 'spa-navigation') { navReportStartedResolve(); await navReportGate; }
    } });
    let batchOrdinal = 0; let featureCheckCalls = 0; let productionStopCalls = 0; let heldController;
    const elements = Array.from({ length: 12 }, (_, index) => ({ nodeType: 1,
      dataset: { benchId: `target-${index}`, benchKind: index < 6 ? 'text' : 'title' }, textContent: index < 6 ? `source-${index}` : '',
      title: index < 6 ? null : `source-${index}`, closest() { return this; },
      getAttribute(name) { return name === 'title' ? this.title : null; }, hasAttribute(name) { return name === 'title' && this.title !== null; },
      setAttribute(name, value) { if (name === 'title') this.title = value; } }));
    const documentRef = { body: {}, querySelectorAll: () => elements }; const windowRef = { location: { href: runtime.routes.A } };
    const mutationObservers = [];
    class FakeMutationObserver { constructor(callback) { this.callback = callback; mutationObservers.push(this); } observe() {} disconnect() {} takeRecords() { return []; } }
    class FakeBridge {
      constructor() {
        this.session = { active: true, discovery: { pending: false, running: false, starting: false, queue: [], head: 0 },
          persistentTranslator: { observedNodesStorage: new Map([['subtree', { released: false, disconnect() { this.released = true; } }]]) } };
      }
      async initialize(_settings, _translate, _context, callbacks) {
        this.session.active = true;
        if (windowRef.location.href === runtime.routes.B) for (let index = 0; index < 6; index++) callbacks.onRetainedTranslation();
      }
    }
    const bridge = new FakeBridge();
    class FakeScheduler {
      constructor() { this.isTranslated = false; this.activeFlushes = 0; this.queue = []; this.activeBatches = new Set(); this.pendingSettlements = new Set(); }
      async _executeBatchRequest(batch, _config, _context, sessionId) {
        const messageId = `batch-${++batchOrdinal}`;
        return runtime.runtime.browserApi.runtime.sendMessage({ action: MessageActions.PAGE_TRANSLATE_BATCH, messageId,
          context: 'page-translation-batch', data: { sessionId, text: JSON.stringify(batch.map(item => ({ id: item.id, text: item.text }))) } });
      }
      _createSettlement(item) { return { settle: outcome => { item.outcome = outcome; return true; } }; }
    }
    const manager = new class FakePageManager {
      constructor() { this.settings = { autoTranslateOnDOMChanges: true }; this.bridge = bridge; this.scheduler = new FakeScheduler();
        this.isAutoTranslating = false; this.isTranslating = false; this.translationMessageId = null; this.acceptedLifecycleSessionId = null; }
      async translatePage(options = {}) {
        this.isAutoTranslating = true; this.isTranslating = true; this.scheduler.isTranslated = true; this.bridge.session.active = true;
        this.translationMessageId = windowRef.location.href === runtime.routes.A ? 'session-A' : 'session-B';
        this.acceptedLifecycleSessionId = this.translationMessageId;
        if (options.preserveAcceptedTranslations) await this.bridge.initialize({}, () => {}, null, { onRetainedTranslation() {} });
        return { success: true, messageId: this.translationMessageId };
      }
      async stopAutoTranslation({ cancellationReason } = {}) {
        productionStopCalls++;
        const sessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;
        this.isAutoTranslating = false; this.isTranslating = false; this.scheduler.isTranslated = false;
        this.scheduler.activeFlushes = 0; this.scheduler.queue.length = 0; this.scheduler.activeBatches.clear(); this.scheduler.pendingSettlements.clear();
        this.bridge.session.active = false;
        if (cancellationReason === 'operation-abort') heldController?.abort();
        else {
          // Production teardown releases the live session observers here.
          if (!releaseSkipped) for (const observer of this.bridge.session.persistentTranslator.observedNodesStorage.values()) observer.disconnect();
          this.translationMessageId = null; this.acceptedLifecycleSessionId = null;
        }
        return { success: true, sessionId, isAutoTranslating: false };
      }
    }();
    class FakeFeatureManager {
      constructor() { this._lastDetectedUrl = runtime.routes.A; }
      getFeatureHandler() { return manager; }
      static getInstance() { return fakeFeatureManager; }
      async checkForUrlChange() {
        featureCheckCalls++;
        await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
        return manager.translatePage({ isAuto: true, preserveAcceptedTranslations: true });
      }
    }
    const fakeFeatureManager = new FakeFeatureManager(); const fixtureEvents = [];
    windowRef.dispatchEvent = event => {
      fixtureEvents.push(event.type); expect(event.type).toBe(replacementInvalidatedDomEvent); expect(productionStopCalls).toBe(1);
      const mutations = [];
      for (let index = 6; index < 12; index++) {
        const element = elements[index]; const oldValue = element.title; element.setAttribute('title', `source-B-${index}`);
        mutations.push({ type: 'attributes', attributeName: 'title', oldValue, target: { nodeType: 2, ownerElement: element } });
      }
      mutationObservers[0]?.callback(mutations); return true;
    };
    // Production leaves the extension proxy disabled, so the Edge request
    // leaves through the global fetch. The observer watches exactly that seam,
    // so the fake network must be reached through it too.
    const fakeNetwork = async (_url, options = {}) => {
      const text = JSON.parse(options.body ?? '[]')[0];
      if (text === 'held-A') return new Promise((_resolve, reject) => options.signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('native fetch aborted'), { name: 'AbortError' })), { once: true }));
      return { status: 200 };
    };
    const proxyManager = { isEnabled: () => false, fetch(url, options) { return globalThis.fetch(url, options); } };
    const ProviderRequestEngine = { async executeApiCall(_provider, options) {
      expect(Object.hasOwn(options, 'messageId')).toBe(false); // Production executeRequest omits it.
      try { return await proxyManager.fetch(options.url, options.fetchOptions); }
      catch (error) {
        if (options.abortController.signal.aborted) throw Object.assign(new Error('Provider request operation abort'), {
          operationAborted: true, cancellationReason: 'operation-abort', cause: error,
        });
        throw error;
      }
    } };
    class FakeBaseProvider { translate(texts, _source, _target, options) {
      const { messageId: _omittedByExecuteRequest, ...executeOptions } = options;
      return ProviderRequestEngine.executeApiCall(this, { ...executeOptions, url: 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=fr',
        fetchOptions: { method: 'POST', body: JSON.stringify(texts), signal: options.abortController.signal } });
    } }
    const workerObservers = installReplacementWorkerObservers({ background: runtime.background, BaseProvider: FakeBaseProvider,
      ProviderRequestEngine, proxyManager, globalObject: { fetch: fakeNetwork } });
    runtime.runtime.setExternalHandler(async message => {
      if (message.action !== MessageActions.PAGE_TRANSLATE_STOP_AUTO) return undefined;
      const response = await manager.stopAutoTranslation();
      return { success: response.success, responses: [response], frames: [{ frameId: 0, success: true }] };
    });
    const content = createReplacementContentRuntime(runtime.config, { browserApi: runtime.runtime.browserApi, PageTranslationManager: manager.constructor,
      PageTranslationScheduler: FakeScheduler, PageTranslationBridge: FakeBridge, FeatureManager: FakeFeatureManager, documentRef, windowRef,
      MutationObserverClass: FakeMutationObserver, CustomEventClass: class { constructor(type) { this.type = type; } } });
    try {
      await content.install(); await manager.translatePage({ isAuto: true });
      const scheduler = manager.scheduler;
      const firstItems = targets(0, 6).map((id, index) => ({ id: `first-${index}`, text: `source-${index}`, node: elements[index] }));
      await scheduler._executeBatchRequest(firstItems, {}, null, 'session-A');
      await new FakeBaseProvider().translate(firstItems.map(item => item.text), 'en', 'fr', { messageId: 'batch-1', sessionId: 'session-A', abortController: new AbortController() });
      firstItems.forEach((item, index) => { elements[index].textContent = `translated-A-${index}`; scheduler._createSettlement(item).settle('accepted'); });
      await vi.waitFor(() => expect(runtime.collector.snapshot().reports.some(report => report.event === 'accepted-A')).toBe(true));
      const heldItems = targets(6, 12).map((id, index) => ({ id: `held-${index}`, text: `source-${index + 6}`, node: elements[index + 6] }));
      await scheduler._executeBatchRequest(heldItems, {}, null, 'session-A');
      heldController = new AbortController();
      const heldResult = new FakeBaseProvider().translate(['held-A'], 'en', 'fr', { messageId: 'batch-2', sessionId: 'session-A', abortController: heldController }).catch(error => error);
      await vi.waitFor(() => expect(runtime.collector.snapshot().reports.some(report => report.event === 'physical-start' && report.evidence.messageId === 'batch-2')).toBe(true));

      await runtime.background.getControl('navigate-to-b');
      // Firefox keeps the committed document URL as the sender URL across a
      // same-document route change, so the sender identity does not change.
      windowRef.location.href = runtime.routes.B;
      const cursor = { documentEpoch: 6, routeRevision: 4, url: runtime.routes.B };
      const featurePromise = FeatureManagerCall(content, FakeFeatureManager, { navigationCursor: cursor });
      // The navigation report is held in flight, so the abort telemetry has to
      // stay buffered while the navigation is not admitted yet.
      await navReportStarted;
      expect(featureCheckCalls).toBe(1); expect(fixtureEvents).toEqual([replacementInvalidatedDomEvent]);
      expect(heldController.signal.aborted).toBe(true);
      expect((await heldResult).operationAborted).toBe(true);
      const reportsBeforeNavAck = runtime.collector.snapshot().reports;
      expect(reportsBeforeNavAck.some(report => report.event === 'spa-navigation')).toBe(false);
      expect(reportsBeforeNavAck.some(report => report.event === 'stop-ack')).toBe(false);
      expect(reportsBeforeNavAck.some(report => report.event === 'controller-abort')).toBe(false);

      releaseNavReport();
      await featurePromise;
      await vi.waitFor(() => expect(runtime.collector.snapshot().reports.some(report => report.event === 'controller-abort' && report.evidence.messageId === 'batch-2')).toBe(true));
      await vi.waitFor(() => expect(runtime.collector.snapshot().reports.some(report => report.event === 'provider-root-settled' && report.evidence.messageId === 'batch-2')).toBe(true));
      expect(runtime.collector.snapshot().reports.find(report => report.event === 'physical-settled' && report.evidence.messageId === 'batch-2').evidence)
        .toMatchObject({ outcome: 'cancelled', code: 'AbortError' });
      expect(runtime.collector.snapshot().reports.find(report => report.event === 'provider-root-settled' && report.evidence.messageId === 'batch-2').evidence)
        .toMatchObject({ status: 'rejected', code: null, operationAborted: true, cancellationReason: 'operation-abort' });
      const bItems = targets(6, 12).map((id, index) => ({ id: `b-${index}`, text: elements[index + 6].title, node: elements[index + 6] }));
      await scheduler._executeBatchRequest(bItems, {}, null, 'session-B');
      await new FakeBaseProvider().translate(bItems.map(item => item.text), 'en', 'fr', { messageId: 'batch-3', sessionId: 'session-B', abortController: new AbortController() });
      bItems.forEach((item, index) => {
        const element = elements[index + 6]; const oldValue = element.title; element.setAttribute('title', `translated-B-${index}`);
        mutationObservers[0]?.callback([{ type: 'attributes', attributeName: 'title', oldValue, target: { nodeType: 2, ownerElement: element } }]);
        scheduler._createSettlement(item).settle('accepted');
      });
      manager.isTranslating = false;
      return { runtime, content, workerObservers, releaseNavReport };
    } catch (error) {
      try { content.dispose(); } catch { /* Original failure takes precedence. */ }
      try { workerObservers.dispose(); } catch { /* Original failure takes precedence. */ }
      throw error;
    }
}

async function FeatureManagerCall(_content, FeatureManagerClass, args) {
  return FeatureManagerClass.prototype.checkForUrlChange.call(FeatureManagerClass.getInstance(), args);
}

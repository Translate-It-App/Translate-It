import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { MessageActions } from '../../../src/shared/messaging/core/MessageActions.js';
import { createReplacementCollector } from './e2e-firefox/runtime-replacement-collector.mjs';
import { createStaleCollector } from './e2e-firefox/runtime-stale-collector.mjs';
import { replacementInvalidatedDomEvent } from './e2e-firefox/runtime-replacement-protocol.mjs';
import { createReplacementBackgroundAdapter, installReplacementWorkerObservers } from './e2e-firefox/runtime-replacement-background.mjs';
import { createReplacementContentRuntime } from './e2e-firefox/runtime-replacement-content.mjs';

const base = { runId: 'stale-runtime-test', authToken: 'b'.repeat(64), expectedExtensionId: 'stale@test', expectedTabId: 9 };
const targets = (start, end) => Array.from({ length: end - start }, (_, i) => `target-${start + i}`);
const active = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Resolves 'pending' while the observed promise is unsettled after 40 ms.
const pendingRace = promise => Promise.race([promise.then(() => 'settled', () => 'rejected'), wait(40).then(() => 'pending')]);

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

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
  }, tabs: { async query() { return fixtureTabUrl === null ? [] : [{ id: config.expectedTabId, url: fixtureTabUrl }]; } } };
  return { browserApi, listeners, setExternalHandler: handler => { externalHandler = handler; } };
}

async function staleAdapter(runId, { staleSuccess = true, staleReplyTimeoutMs, staleCollector = true } = {}) {  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const config = { ...base, runId, authToken: 'c'.repeat(64), fixtureUrl, expectedDocumentId: null, actualDocumentId: 'actual-document-id' };
  if (staleSuccess) config.staleSuccess = true;
  if (staleReplyTimeoutMs !== undefined) config.staleReplyTimeoutMs = staleReplyTimeoutMs;
  const collector = (staleCollector ? createStaleCollector : createReplacementCollector)(config); collector.attach(server);
  let actualUrl = fixtureUrl;
  const runtime = fakeRuntime({ config, senderUrl: () => actualUrl, fixtureTabUrl: fixtureUrl });
  const storage = { set: vi.fn(async () => {}) };
  const transmissions = []; const rejectedTransmissions = [];
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') transmissions.push(JSON.parse(options.body));
    const response = await realFetch(url, options);
    if (!response.ok) rejectedTransmissions.push({ status: response.status, body: await response.clone().text() });
    return response;
  };
  const background = createReplacementBackgroundAdapter(config, { browserApi: { ...runtime.browserApi, storage: { local: storage } }, storage, fetchImpl });
  await background.initialize();
  active.push({ server, collector, background });
  return { config, routes: collector.routes, collector, background, runtime, transmissions, rejectedTransmissions };
}

afterEach(async () => {
  await Promise.all(active.splice(0).map(async ({ server, collector, background, workerObservers }) => {
    try { workerObservers?.dispose(); } catch { /* Teardown cannot mask the test outcome. */ }
    background.close(); await collector.drain(); await new Promise(resolve => server.close(resolve));
  }));
});

/**
 * Real stale collector + real background/content adapters against the
 * production-shaped fakes of the Phase 2B runtime harness. Drives session A's
 * first provider batch to 'accepted-A' so the stale barrier has its anchor,
 * and wires the fake background worker replies plus the release gate for the
 * stale batch's content-side reply.
 */
async function acceptedAHarness(adapter) {
  const routes = adapter.routes; const browserApi = adapter.runtime.browserApi;
  const elements = Array.from({ length: 12 }, (_, index) => ({ nodeType: 1,
    dataset: { benchId: `target-${index}`, benchKind: index < 6 ? 'text' : 'title' }, textContent: index < 6 ? `source-${index}` : '',
    title: index < 6 ? null : `source-${index}`, closest() { return this; },
    getAttribute(name) { return name === 'title' ? this.title : null; }, hasAttribute(name) { return name === 'title' && this.title !== null; },
    setAttribute(name, value) { if (name === 'title') this.title = value; } }));
  const documentRef = { body: {}, querySelectorAll: () => elements }; const windowRef = { location: { href: routes.A } };
  const mutationObservers = [];
  class FakeMutationObserver { constructor(callback) { this.callback = callback; mutationObservers.push(this); } observe() {} disconnect() {} takeRecords() { return []; } }
  let batchOrdinal = 0; let featureCheckCalls = 0; let productionStopCalls = 0;
  // The fake Scheduler mirrors production _executeBatchRequest: after the send
  // resolves it re-validates session ownership, and a no-longer-owned flush is
  // discarded with _resolveItem(item, item.text, 'cancelled') semantics.
  class FakeScheduler {
    constructor() { this.isTranslated = false; this.activeFlushes = 0; this.queue = []; this.activeBatches = new Set();
      this.pendingSettlements = new Set(); this.translationSessionId = null; this.sessionContext = null; this.lastDiscardReply = undefined; }
    _ownsFlushSession(sessionId, context) {
      return this.isTranslated && this.translationSessionId === sessionId && this.sessionContext === context;
    }
    async _executeBatchRequest(batch, _config, context, sessionId) {
      const messageId = `batch-${++batchOrdinal}`;
      const reply = await browserApi.runtime.sendMessage({ action: MessageActions.PAGE_TRANSLATE_BATCH, messageId,
        context: 'page-translation-batch', data: { sessionId, text: JSON.stringify(batch.map(item => ({ id: item.id, text: item.text }))) } });
      if (!this._ownsFlushSession(sessionId, context)) {
        this.lastDiscardReply = reply;
        batch.forEach(item => this._createSettlement(item, item.text).settle('cancelled'));
        return;
      }
      return reply;
    }
    _createSettlement(item, text) { return { settle: outcome => { item.outcome = outcome; return true; } }; }
  }
  class FakeBridge {
    constructor() { this.session = { active: true, discovery: { pending: false, running: false, starting: false, queue: [], head: 0 },
      persistentTranslator: { observedNodesStorage: new Map([['subtree', { released: false, disconnect() { this.released = true; } }]]) } }; }
    async initialize(_settings, _translate, _context, callbacks) {
      this.session.active = true;
      if (windowRef.location.href === routes.B) for (let index = 0; index < 6; index++) callbacks.onRetainedTranslation();
    }
  }
  const bridge = new FakeBridge();
  const manager = new class FakePageManager {
    constructor() { this.settings = { autoTranslateOnDOMChanges: true }; this.bridge = bridge; this.scheduler = new FakeScheduler();
      this.isAutoTranslating = false; this.isTranslating = false; this.translationMessageId = null; this.acceptedLifecycleSessionId = null; }
    async translatePage(options = {}) {
      this.isAutoTranslating = true; this.isTranslating = true; this.scheduler.isTranslated = true; this.bridge.session.active = true;
      this.translationMessageId = windowRef.location.href === routes.A ? 'session-A' : 'session-B';
      this.acceptedLifecycleSessionId = this.translationMessageId;
      this.scheduler.translationSessionId = this.translationMessageId; this.scheduler.sessionContext = null;
      if (options.preserveAcceptedTranslations) await this.bridge.initialize({}, () => {}, null, { onRetainedTranslation() {} });
      return { success: true, messageId: this.translationMessageId };
    }
    async stopAutoTranslation({ cancellationReason } = {}) {
      productionStopCalls++;
      const sessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;
      this.isAutoTranslating = false; this.isTranslating = false; this.scheduler.isTranslated = false;
      this.scheduler.activeFlushes = 0; this.scheduler.queue.length = 0; this.scheduler.activeBatches.clear(); this.scheduler.pendingSettlements.clear();
      this.bridge.session.active = false;
      if (cancellationReason !== 'operation-abort') {
        // Production teardown releases the live session observers here.
        for (const observer of this.bridge.session.persistentTranslator.observedNodesStorage.values()) observer.disconnect();
        this.translationMessageId = null; this.acceptedLifecycleSessionId = null;
      }
      return { success: true, sessionId, isAutoTranslating: false };
    }
  }();
  class FakeFeatureManager {
    constructor() { this._lastDetectedUrl = routes.A; }
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
  // The stale batch's genuine success reply answers through the fake
  // background-worker seam; an optional gate keeps it in flight while the
  // test admits the Provider settlement evidence first.
  const batchReplies = new Map(); let batch2Gate = null; let releaseBatch2Reply = null;
  const openBatch2Gate = () => { batch2Gate = new Promise(resolve => { releaseBatch2Reply = resolve; }); };
  adapter.runtime.setExternalHandler(async message => {
    if (message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO) {
      const response = await manager.stopAutoTranslation();
      return { success: response.success, responses: [response], frames: [{ frameId: 0, success: true }] };
    }
    if (message.action !== MessageActions.PAGE_TRANSLATE_BATCH) return undefined;
    if (message.messageId === 'batch-2' && batch2Gate) await batch2Gate;
    return batchReplies.get(message.messageId);
  });
  const proxyManager = { isEnabled: () => false, fetch(url, options) { return globalThis.fetch(url, options); } };
  const ProviderRequestEngine = { async executeApiCall(_provider, options) {
    expect(Object.hasOwn(options, 'messageId')).toBe(false); // Production executeRequest omits it.
    try { return await proxyManager.fetch(options.url, options.fetchOptions); }
    catch (error) {
      if (options.abortController.signal.aborted) throw Object.assign(new Error('Provider request operation abort'),
        { operationAborted: true, cancellationReason: 'operation-abort', cause: error });
      throw error;
    }
  } };
  class FakeBaseProvider { translate(texts, _source, _target, options) {
    const { messageId: _omittedByExecuteRequest, ...executeOptions } = options;
    return ProviderRequestEngine.executeApiCall(this, { ...executeOptions, url: 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=fr',
      fetchOptions: { method: 'POST', body: JSON.stringify(texts), signal: options.abortController.signal } });
  } }
  const workerObservers = installReplacementWorkerObservers({ background: adapter.background, BaseProvider: FakeBaseProvider,
    ProviderRequestEngine, proxyManager, globalObject: { fetch: async () => ({ status: 200 }) } });
  active[active.length - 1].workerObservers = workerObservers;
  const content = createReplacementContentRuntime(adapter.config, { browserApi, PageTranslationManager: manager.constructor,
    PageTranslationScheduler: FakeScheduler, PageTranslationBridge: FakeBridge, FeatureManager: FakeFeatureManager, documentRef, windowRef,
    MutationObserverClass: FakeMutationObserver, CustomEventClass: class { constructor(type) { this.type = type; } } });
  await content.install(); await manager.translatePage({ isAuto: true });
  const scheduler = manager.scheduler;
  const firstItems = targets(0, 6).map((id, index) => ({ id: `first-${index}`, text: `source-${index}`, node: elements[index] }));
  batchReplies.set('batch-1', { success: true, translatedText: JSON.stringify(targets(0, 6).map(i => `translated-A-${i}`)) });
  await scheduler._executeBatchRequest(firstItems, {}, null, 'session-A');
  await new FakeBaseProvider().translate(firstItems.map(item => item.text), 'en', 'fr',
    { messageId: 'batch-1', sessionId: 'session-A', abortController: new AbortController() });
  await vi.waitFor(() => expect(adapter.collector.snapshot().reports.some(report => report.event === 'provider-root-settled'
    && report.evidence.messageId === 'batch-1')).toBe(true), { timeout: 10_000 });
  firstItems.forEach((item, index) => { elements[index].textContent = `translated-A-${index}`; scheduler._createSettlement(item, `translated-A-${index}`).settle('accepted'); });
  await vi.waitFor(() => expect(adapter.collector.snapshot().reports.some(report => report.event === 'accepted-A')).toBe(true), { timeout: 10_000 });
  return { adapter, content, manager, scheduler, elements, batchReplies, windowRef, mutationObservers, FakeBaseProvider,
    firstItems, openBatch2Gate, releaseBatch2Reply: () => releaseBatch2Reply?.(),
    navigate: navigation => FakeFeatureManager.prototype.checkForUrlChange.call(fakeFeatureManager, navigation) };
}

// Sends the stale batch with its reply gated in flight, admits the genuine
// Provider success evidence, then delivers the reply so the barrier captures it.
async function holdStaleBatch(harness, { translatedItems } = {}) {
  const { adapter, scheduler, elements, batchReplies, FakeBaseProvider } = harness;
  const heldItems = targets(6, 12).map((id, index) => ({ id: `held-${index}`, text: `source-${index + 6}`, node: elements[index + 6] }));
  const providerTexts = heldItems.map((_, index) => `held-${index}`);
  const batch2Reply = { success: true,
    translatedText: JSON.stringify(translatedItems ?? heldItems.map((item, index) => ({ id: item.id, t: providerTexts[index] }))) };
  batchReplies.set('batch-2', batch2Reply);
  harness.openBatch2Gate();
  const stalePromise = scheduler._executeBatchRequest(heldItems, {}, null, 'session-A');
  await vi.waitFor(() => expect(adapter.collector.snapshot().reports.some(report => report.event === 'scheduler-batch'
    && report.evidence.messageId === 'batch-2')).toBe(true), { timeout: 10_000 });
  const providerOutcome = await new FakeBaseProvider().translate(heldItems.map(item => item.text), 'en', 'fr',
    { messageId: 'batch-2', sessionId: 'session-A', abortController: new AbortController() }).then(() => 'fulfilled', error => error);
  expect(providerOutcome).toBe('fulfilled');
  await vi.waitFor(() => expect(adapter.collector.snapshot().reports.some(report => report.event === 'provider-root-settled'
    && report.evidence.messageId === 'batch-2' && report.evidence.status === 'fulfilled')).toBe(true), { timeout: 10_000 });
  harness.releaseBatch2Reply();
  await vi.waitFor(() => expect(adapter.collector.snapshot().reports.some(report => report.event === 'stale-reply-held')).toBe(true), { timeout: 10_000 });
  return { heldItems, providerTexts, batch2Reply, stalePromise };
}

describe('Firefox Phase 2C stale-success delivery barrier', () => {
  it('holds only the stale success reply, releases it unchanged after the broker grant, and reports the production rejection', async () => {
    const adapter = await staleAdapter('stale-e2e');
    const harness = await acceptedAHarness(adapter);
    try {
      const { heldItems, providerTexts, batch2Reply, stalePromise } = await holdStaleBatch(harness);
      const reports = () => adapter.collector.snapshot().reports;
      const held = reports().find(report => report.event === 'stale-reply-held');
      const { sender, ...heldEvidence } = held.evidence;
      expect(heldEvidence).toEqual({ sessionId: 'session-A', messageId: 'batch-2', targetIds: targets(6, 12), replyItemCount: 6,
        replyHash: await sha256Hex(JSON.stringify(providerTexts)) });
      // The reply text itself is never reported, only its count and hash.
      expect(JSON.stringify(held.evidence)).not.toContain('held-');
      // The Scheduler's promise stays pending while the barrier holds the reply.
      expect(await pendingRace(stalePromise)).toBe('pending');
      const holdIndex = reports().findIndex(report => report.event === 'stale-reply-held');

      // Trusted SPA navigation A→B while the reply is held.
      await adapter.background.getControl('navigate-to-b');
      harness.windowRef.location.href = adapter.routes.B;
      await harness.navigate({ navigationCursor: { documentEpoch: 6, routeRevision: 4, url: adapter.routes.B } });
      await vi.waitFor(() => expect(reports().some(report => report.event === 'stop-ack')).toBe(true), { timeout: 10_000 });
      expect(reports().findIndex(report => report.event === 'spa-navigation')).toBeGreaterThan(holdIndex);

      // B starts, its provider batch completes, and its reply is not held.
      const bItems = targets(6, 12).map((id, index) => ({ id: `b-${index}`, text: harness.elements[index + 6].title, node: harness.elements[index + 6] }));
      const batch3Reply = { success: true, translatedText: JSON.stringify(bItems.map((item, index) => ({ id: item.id, t: `translated-B-${index}` }))) };
      harness.batchReplies.set('batch-3', batch3Reply);
      const bPromise = harness.scheduler._executeBatchRequest(bItems, {}, null, 'session-B');
      expect(await bPromise).toBe(batch3Reply);
      expect(await pendingRace(stalePromise)).toBe('pending');
      await new harness.FakeBaseProvider().translate(bItems.map(item => item.text), 'en', 'fr',
        { messageId: 'batch-3', sessionId: 'session-B', abortController: new AbortController() });
      await vi.waitFor(() => expect(reports().some(report => report.event === 'provider-root-settled'
        && report.evidence.messageId === 'batch-3')).toBe(true), { timeout: 10_000 });
      bItems.forEach((item, index) => {
        const element = harness.elements[index + 6]; const oldValue = element.title; element.setAttribute('title', `translated-B-${index}`);
        harness.mutationObservers[0]?.callback([{ type: 'attributes', attributeName: 'title', oldValue, target: { nodeType: 2, ownerElement: element } }]);
        harness.scheduler._createSettlement(item, `translated-B-${index}`).settle('accepted');
      });
      await vi.waitFor(() => expect(reports().some(report => report.event === 'accepted-B')).toBe(true), { timeout: 10_000 });

      // The release grant exists only now; the barrier answers it.
      expect(adapter.collector.snapshot().releaseStaleAuthorized).toBe(true);
      await stalePromise;
      expect(reports().some(report => report.event === 'stale-reply-released' && report.evidence.messageId === 'batch-2')).toBe(true);
      // The released value is the identical reply object the background produced.
      expect(harness.scheduler.lastDiscardReply).toBe(batch2Reply);
      // Production's ownership check discarded the stale batch: every item is
      // settled 'cancelled' with its original source text, never provider text.
      expect(heldItems.every(item => item.outcome === 'cancelled')).toBe(true);
      expect(heldItems.map(item => item.text)).toEqual(providerTexts.map((_, index) => `source-${index + 6}`));
      await vi.waitFor(() => expect(reports().filter(report => report.event === 'stale-batch-rejected')).toHaveLength(1), { timeout: 10_000 });
      const { sender: rejectedSender, ...rejectedEvidence } = reports().find(report => report.event === 'stale-batch-rejected').evidence;
      expect(rejectedEvidence)
        .toEqual({ sessionId: 'session-A', messageId: 'batch-2', targetIds: targets(6, 12), outcome: 'cancelled' });
      expect(harness.content.snapshot().lastError).toBeNull();

      // The full stale proof still completes after the released reply is discarded.
      harness.manager.isTranslating = false;
      await vi.waitFor(() => expect(reports().some(report => report.event === 'cleanup')).toBe(true), { timeout: 20_000 });
      const final = await harness.content.captureFinal();
      expect(final.sessionId).toBe('session-B'); expect(final.postInvalidationAWrites).toEqual([]);
      expect(adapter.collector.snapshot().proofComplete).toBe(true);
    } finally { /* afterEach releases the worker observers and the collector. */ }
  }, 30_000);

  it('never holds a non-successful stale reply', async () => {
    const adapter = await staleAdapter('stale-non-success');
    const harness = await acceptedAHarness(adapter);
    const failedReply = { success: false, error: 'Batch translation failed' };
    harness.batchReplies.set('batch-2', failedReply);
    const heldItems = targets(6, 12).map((id, index) => ({ id: `held-${index}`, text: `source-${index + 6}`, node: harness.elements[index + 6] }));
    const stalePromise = harness.scheduler._executeBatchRequest(heldItems, {}, null, 'session-A');
    expect(await stalePromise).toBe(failedReply);
    expect(adapter.collector.snapshot().reports.some(report => report.event.startsWith('stale-'))).toBe(false);
    expect(harness.content.snapshot().lastError).toBeNull();
  });

  it('holds only the stale batch and never a later B batch reply', async () => {
    const adapter = await staleAdapter('stale-b-not-held', { staleReplyTimeoutMs: 300 });
    const harness = await acceptedAHarness(adapter);
    const { heldItems, stalePromise } = await holdStaleBatch(harness);
    expect(await pendingRace(stalePromise)).toBe('pending');
    // A route change without the trusted cursor: B work must pass straight through.
    harness.windowRef.location.href = adapter.routes.B;
    await harness.manager.translatePage({ isAuto: true });
    const batch3Reply = { success: true, translatedText: '[]' };
    harness.batchReplies.set('batch-3', batch3Reply);
    const bItems = targets(0, 6).map((id, index) => ({ id: `b-${index}`, text: `translated-A-${index}`, node: harness.elements[index] }));
    const bPromise = harness.scheduler._executeBatchRequest(bItems, {}, null, 'session-B');
    expect(await bPromise).toBe(batch3Reply);
    expect(await pendingRace(stalePromise)).toBe('pending');
    expect(adapter.collector.snapshot().reports.some(report => report.event === 'stale-reply-held' && report.evidence.messageId === 'batch-3')).toBe(false);
    expect(heldItems.every(item => item.outcome === undefined)).toBe(true);
  });

  it('fails closed through the adapter error path when the release grant never arrives', async () => {
    const adapter = await staleAdapter('stale-deadline', { staleReplyTimeoutMs: 100 });
    const harness = await acceptedAHarness(adapter);
    const { stalePromise } = await holdStaleBatch(harness);
    await expect(stalePromise).rejects.toThrow('Timed out waiting for the stale-reply release grant.');
    expect(harness.content.snapshot().lastError).toBe('TIMEOUT');
    const reports = adapter.collector.snapshot().reports;
    expect(reports.some(report => report.event === 'error' && report.evidence.code === 'TIMEOUT')).toBe(true);
    expect(reports.some(report => ['stale-reply-released', 'stale-batch-rejected'].includes(report.event))).toBe(false);
  });

  it('holds nothing in Phase 2B mode', async () => {
    const adapter = await staleAdapter('stale-phase2b', { staleSuccess: false, staleCollector: false });
    const harness = await acceptedAHarness(adapter);
    const heldItems = targets(6, 12).map((id, index) => ({ id: `held-${index}`, text: `source-${index + 6}`, node: harness.elements[index + 6] }));
    const batch2Reply = { success: true, translatedText: JSON.stringify(heldItems.map((item, index) => ({ id: item.id, t: `held-${index}` }))) };
    harness.batchReplies.set('batch-2', batch2Reply);
    const stalePromise = harness.scheduler._executeBatchRequest(heldItems, {}, null, 'session-A');
    expect(await stalePromise).toBe(batch2Reply);
    expect(adapter.collector.snapshot().reports.some(report => report.event.startsWith('stale-'))).toBe(false);
    expect(harness.content.snapshot().lastError).toBeNull();
  });
});

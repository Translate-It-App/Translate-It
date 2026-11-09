import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { exactKeys, getBackgroundReadinessChecks, installBackgroundProbe, validateProbeEnvelope, validateSender } from './page-translation-e2e-firefox/runtime-background.mjs';
import { installContentProbe, observeProductionStop, send as sendRuntimeMessage } from './page-translation-e2e-firefox/runtime-content.mjs';
import { PAGE_TRANSLATION_STOP_DEADLINE_MS, PROVIDER_ONLY_DEADLINE_MS } from './page-translation-e2e-firefox/runtime-constants.mjs';
import { installContentProviderProbe, validateAcceptedMutationAccounting } from './page-translation-e2e-benchmark/provider-probe-content.mjs';
import { wrapPageTranslationStart } from './page-translation-e2e-benchmark/page-translation-start-probe.mjs';
import { createPageTranslationFixture, targetTexts } from './page-translation-e2e-benchmark/fixture.mjs';

const config = {
  runId: 'run-123', fixtureUrl: 'http://127.0.0.1:4321/fixture',
  bindingUrl: 'http://127.0.0.1:4321/__benchmark/bind/run-123',
  reportUrl: 'http://127.0.0.1:4321/__benchmark/runtime',
  authToken: 'c'.repeat(64), privateToken: 'build-private-token'.padEnd(64, 'a'),
};
const checks = { coreInitialized: true, listenerActive: true, featureManagerInitialized: true, handlerActive: true, handlerIsActive: true };
const flags = { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.translateItContentCore;
  delete window.__pageTranslationBenchmark;
  delete window.__firefoxProbeStartup;
  delete globalThis.backgroundService;
  delete globalThis.unifiedTranslationService;
  delete globalThis.__pageTranslationBenchmark;
  delete globalThis.__firefoxProbeStartup;
  delete globalThis.__firefoxPageTranslationStopMode;
});

function setup({ permission = true, edgePermission = true, proxyEnabled = false, importFails = false, bindingTabCount = 1, holdReadyReport = false, fixtureUrl = config.fixtureUrl, providerOnly = false, pageTranslationE2E = false, invokeProviderOnly = vi.fn(async () => []) } = {}) {
  let onMessage;
  let onCommitted;
  const bridgeConfig = { ...config, fixtureUrl, ...(providerOnly ? { providerOnly: true } : {}), ...(pageTranslationE2E ? { pageTranslationE2E: true } : {}) };
  let currentUrl = bridgeConfig.bindingUrl;
  const reports = [];
  let releaseReadyReport;
  const stopControls = [];
  const stopControlRequests = [];
  const stopControlEvents = new EventEmitter();
  const browser = {
    runtime: {
      id: 'extension-id', getURL: () => 'moz-extension://extension-id/',
      onMessage: { addListener(listener) { onMessage = listener; }, hasListener: () => true },
    },
    permissions: { contains: vi.fn(async ({ origins }) => origins[0].startsWith('https://') ? edgePermission : permission) },
    storage: { local: { set: vi.fn(async () => {}) } },
    tabs: {
      query: vi.fn(async () => Array.from({ length: bindingTabCount }, (_, index) => ({ id: 7 + index, url: bridgeConfig.bindingUrl }))),
      get: vi.fn(async () => ({ id: 7, url: currentUrl })),
      sendMessage: vi.fn(async (tabId, message) => { stopControls.push({ tabId, message }); stopControlEvents.emit('message', message); return { accepted: true, sessionId: message.sessionId }; }),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener(listener) { onCommitted = listener; } },
      getFrame: vi.fn(async () => ({ url: currentUrl, documentId: 'doc-1' })),
    },
  };
  vi.stubGlobal('browser', browser);
  vi.stubGlobal('backgroundService', { initialized: true, _translationEngineInitialized: true, translationEngine: {}, messageHandler: { isListenerActive: true } });
  vi.stubGlobal('unifiedTranslationService', { translationEngine: globalThis.backgroundService.translationEngine, backgroundService: globalThis.backgroundService });
  vi.stubGlobal('__pageTranslationBenchmark', { unifiedTranslationService: globalThis.unifiedTranslationService });
  vi.stubGlobal('__firefoxProbeStartup', { complete: true, success: true });
  const providerProbe = { arm: vi.fn(), stop: vi.fn(), proxyDisabled: () => !proxyEnabled };
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (String(_url).includes('/__benchmark/control/')) {
      const phase = String(_url).endsWith('/stop-auto') ? 'stop' : 'capture';
      stopControlRequests.push(phase);
      stopControlEvents.emit('poll', phase);
      return { ok: true, json: async () => ({ v: 1, runId: config.runId, decision: phase === 'stop' ? 'stop' : 'capture',
        sessionId: 'session-stop', firstBatchMessageId: 'batch-first', secondBatchMessageId: 'batch-second' }) };
    }
    const payload = JSON.parse(options.body);
    reports.push({ payload, headers: options.headers });
    if (holdReadyReport && payload.realm === 'background' && payload.phase === 'ready') {
      await new Promise(resolve => { releaseReadyReport = resolve; });
    }
    return { ok: true, json: async () => payload.op
      ? { v: 1, runId: payload.runId, op: payload.op, opSeq: payload.opSeq, accepted: true,
        ...(payload.event === 'armed' ? { decision: 'start' } : payload.event === 'translated' ? { decision: 'restore' } : {}) }
      : { v: 1, runId: payload.runId, seq: payload.seq, accepted: true } };
  }));
  const importEntry = vi.fn(async () => {
    if (importFails) throw new Error('do not expose raw error');
    globalThis.__pageTranslationBenchmark = { ...globalThis.__pageTranslationBenchmark, providerProbe, providerProbeInstalled: true, invokeProviderOnly,
      enableCancellationProbe: vi.fn(() => ({ enabled: true, instrumentationErrors: [] })),
      cancellationSnapshot: vi.fn(() => ({ ledger: { operations: [] }, providerRoots: [] })),
      resourceSnapshot: vi.fn(() => null) };
  });
  const sender = { id: browser.runtime.id, tab: { id: 7 }, frameId: 0, url: bridgeConfig.fixtureUrl, origin: new URL(bridgeConfig.fixtureUrl).origin, documentId: 'doc-1' };
  return {
    browser, reports, sender, importEntry, bridgeConfig, providerProbe, invokeProviderOnly, stopControls, stopControlRequests,
    waitForStopControl: type => waitForHarnessEvent(stopControlEvents, 'message', value => value.type === type, stopControls.map(item => item.message)),
    waitForStopPoll: phase => waitForHarnessEvent(stopControlEvents, 'poll', value => value === phase, stopControlRequests),
    async start() {
      await installBackgroundProbe(bridgeConfig, importEntry);
      await vi.waitFor(() => expect(reports.some(item => ['ready', 'error'].includes(item.payload.phase))).toBe(true), { timeout: 1000 });
      if (reports.some(item => item.payload.phase === 'ready')) {
        currentUrl = bridgeConfig.fixtureUrl;
        onCommitted({ frameId: 0, tabId: 7, url: bridgeConfig.fixtureUrl, documentId: 'doc-1' });
      }
    },
    commit: details => onCommitted(details),
    message: (...args) => onMessage(...args),
    releaseReady: () => releaseReadyReport?.(),
    setUrl(url) { currentUrl = url; },
  };
}

function waitForHarnessEvent(emitter, name, predicate, prior = []) {
  const found = prior.find(predicate);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise(resolve => {
    const listener = value => {
      if (!predicate(value)) return;
      emitter.removeListener(name, listener);
      resolve(value);
    };
    emitter.on(name, listener);
  });
}

async function completeProviderOnlyHandshake(bridge) {
  await bridge.start();
  const hello = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
  const nonce = hello.nonce;
  const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce };
  await bridge.message({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, bridge.sender);
  await bridge.message({ ...base, type: 'ready', checks, flags }, bridge.sender);
  await bridge.message({ ...base, type: 'ack-received', ack: 'ready-ack' }, bridge.sender);
  await bridge.message({ ...base, type: 'content-ready', checks, flags, ackReceived: true }, bridge.sender);
  return nonce;
}

describe('Firefox runtime bridge protocol', () => {
  it('disposes the scenario Stop observation promptly when production Stop rejects', async () => {
    const originalSendMessage = vi.fn();
    const originalBegin = vi.fn();
    const originalSettle = vi.fn();
    const ledger = { begin: originalBegin, settle: originalSettle };
    vi.stubGlobal('browser', { runtime: { sendMessage: originalSendMessage } });
    await expect(observeProductionStop(ledger, 'session', Date.now() + 10_000, () => Promise.reject(new Error('stop rejected'))))
      .rejects.toThrow('stop rejected');
    expect(ledger.begin).toBe(originalBegin);
    expect(ledger.settle).toBe(originalSettle);
    expect(globalThis.browser.runtime.sendMessage).toBe(originalSendMessage);
  });

  it('restores scenario Stop observation wrappers on production Stop timeout before observation timeout', async () => {
    vi.useFakeTimers();
    const originalSendMessage = vi.fn();
    const ledger = { begin: vi.fn(), settle: vi.fn() };
    vi.stubGlobal('browser', { runtime: { sendMessage: originalSendMessage } });
    const originalBegin = ledger.begin;
    const originalSettle = ledger.settle;
    const stop = observeProductionStop(ledger, 'session', Date.now() + 25, () => new Promise(() => {}));
    const result = expect(stop).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(ledger.begin).toBe(originalBegin);
    expect(ledger.settle).toBe(originalSettle);
    expect(globalThis.browser.runtime.sendMessage).toBe(originalSendMessage);
  });

  it('reports the actual PageTranslationManager start result once and waits for its authenticated receipt', async () => {
    const result = { success: true, messageId: 'page-translate-session-1' };
    const original = vi.fn(async () => result);
    const reportStarted = deferred();
    let releaseReport;
    const evidence = [];
    const bridge = setup({ pageTranslationE2E: true });
    const nonce = await completeProviderOnlyHandshake(bridge);
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    const manager = { translatePage: original };
    manager.translatePage = wrapPageTranslationStart(original, {
      isProbeStart: options => options?.provider === 'edge' && options?.targetLanguage === 'fr',
      report: async item => {
        evidence.push(item);
        const receipt = await bridge.message({ action, v: 1, runId: config.runId, type: 'event', nonce, event: 'command-result', evidence: item }, bridge.sender);
        reportStarted.resolve(receipt);
        await new Promise(resolve => { releaseReport = resolve; });
        return receipt;
      },
    });
    const pending = manager.translatePage({ provider: 'edge', targetLanguage: 'fr' });
    await expect(reportStarted.promise).resolves.toMatchObject({ type: 'accepted', nonce });
    expect(original).toHaveBeenCalledOnce();
    expect(evidence).toEqual([{ success: true, sessionId: result.messageId, code: null }]);
    expect(bridge.reports.at(-1).payload).toMatchObject({ event: 'command-result', evidence: evidence[0] });
    releaseReport({ accepted: true });
    await expect(pending).resolves.toBe(result);
    await expect(manager.translatePage({ provider: 'edge', targetLanguage: 'fr' })).resolves.toBe(result);
    expect(evidence).toHaveLength(1);

    const failedEvidence = [];
    const failedOriginal = vi.fn(async () => ({ success: false, reason: 'private detail' }));
    const failed = wrapPageTranslationStart(failedOriginal, {
      isProbeStart: options => options?.provider === 'edge' && options?.targetLanguage === 'fr',
      report: item => { failedEvidence.push(item); return Promise.resolve({ accepted: true }); },
    });
    await expect(failed({ provider: 'edge', targetLanguage: 'fr' })).resolves.toMatchObject({ success: false });
    expect(failedEvidence).toEqual([{ success: false, sessionId: null, code: 'PROTOCOL_ERROR' }]);
    expect(JSON.stringify(failedEvidence)).not.toContain('private detail');
  });

  it('validates exact protocol envelopes and browser-provided sender identity', () => {
    const browser = { runtime: { id: 'extension-id' } };
    const envelope = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' };
    expect(validateProbeEnvelope(envelope, config.runId, 'hello', [])).toBe(true);
    expect(validateProbeEnvelope({ ...envelope, extra: true }, config.runId, 'hello', [])).toBe(false);
    expect(validateProbeEnvelope({ ...envelope, runId: 'wrong' }, config.runId, 'hello', [])).toBe(false);
    expect(exactKeys({ 'coreInitialized,featureManagerInitialized,handlerActive,handlerIsActive,listenerActive': true }, Object.keys(checks))).toBe(false);
    expect(validateSender({ id: browser.runtime.id, tab: { id: 7 }, frameId: 0, url: config.fixtureUrl }, browser, 7, config.fixtureUrl, 1)).toBe(true);
    for (const sender of [
      { id: 'wrong', tab: { id: 7 }, frameId: 0, url: config.fixtureUrl },
      { id: browser.runtime.id, tab: { id: 8 }, frameId: 0, url: config.fixtureUrl },
      { id: browser.runtime.id, tab: { id: 7 }, frameId: 1, url: config.fixtureUrl },
      { id: browser.runtime.id, tab: { id: 7 }, frameId: 0, url: 'http://127.0.0.1/elsewhere' },
    ]) expect(validateSender(sender, browser, 7, config.fixtureUrl, 1)).toBe(false);
  });

  it('completes the sequential native-message handshake and reports only validated evidence', async () => {
    const bridge = setup();
    await bridge.start();
    const { sender } = bridge;
    const invoke = (...args) => bridge.message(...args);
    expect(await invoke({ action: 'unrelated' }, sender)).toBe(false);
    const challenge = await invoke({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, sender);
    expect(challenge.type).toBe('challenge');
    expect((await invoke({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, sender)).type).toBe('error');
    const nonce = challenge.nonce;
    const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce };
    expect(await invoke({ ...base, runId: 'wrong', type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, sender)).toBe(false);
    expect((await invoke({ ...base, nonce: 'wrong', type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, sender)).code).toBe('PROTOCOL_REJECTED');
    expect((await invoke({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, sender)).type).toBe('loaded-ack');
    expect((await invoke({ ...base, type: 'ready', checks, flags }, sender)).type).toBe('ready-ack');
    expect((await invoke({ ...base, type: 'ack-received', ack: 'ready-ack' }, sender)).type).toBe('confirmed');
    expect((await invoke({ ...base, type: 'content-ready', checks, flags, ackReceived: true }, sender)).type).toBe('accepted');
    expect(bridge.reports.map(item => [item.payload.realm, item.payload.phase])).toEqual([
      ['background', 'bootstrap'], ['background', 'loaded'], ['background', 'ready'], ['content', 'loaded'], ['content', 'ready'],
    ]);
    expect(bridge.reports.map(item => item.payload.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(bridge.reports.at(-1).payload.evidence.ackReceived).toBe(true);
    expect(bridge.reports[0].payload.evidence.extensionOrigin).toBe('moz-extension://extension-id');
    expect(bridge.reports[0].headers.Authorization).toBe(`Bearer ${config.authToken}`);
    expect(JSON.stringify(bridge.reports)).not.toContain(config.privateToken);
  });

  it('arms the operation only after startup readiness, direct-permission, proxy, and observer gates', async () => {
    const bridge = setup();
    await bridge.start();
    const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    const nonce = challenge.nonce;
    const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce };
    await bridge.message({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, bridge.sender);
    await bridge.message({ ...base, type: 'ready', checks, flags }, bridge.sender);
    await bridge.message({ ...base, type: 'ack-received', ack: 'ready-ack' }, bridge.sender);
    await bridge.message({ ...base, type: 'content-ready', checks, flags, ackReceived: true }, bridge.sender);
    const arm = await bridge.message({ action: '__PAGE_TRANSLATION_PROVIDER_PROBE_V1', v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    expect(arm).toMatchObject({ type: 'armed-ack', nonce, decision: 'start' });
    expect(bridge.providerProbe.arm).toHaveBeenCalledOnce();
    expect(bridge.reports.at(-1).payload).toMatchObject({
      op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: { navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true },
    });
    const translated = await bridge.message({ action: '__PAGE_TRANSLATION_PROVIDER_PROBE_V1', v: 1, runId: config.runId,
      type: 'event', nonce, event: 'translated', evidence: {
        sessionId: 'session-1', acceptedTargetIds: Array.from({ length: 12 }, (_, index) => `target-${index}`), acceptedCount: 12,
        duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
      } }, bridge.sender);
    expect(translated).toMatchObject({ type: 'accepted', nonce, decision: 'restore' });
    expect(bridge.reports.at(-1).payload).toMatchObject({ op: 'edge-fr-page-once', opSeq: 2, event: 'translated' });
  });

  it('accepts safe authenticated Scheduler batch identities only in the Phase-1 runtime lane', async () => {
    const bridge = setup({ pageTranslationE2E: true });
    const nonce = await completeProviderOnlyHandshake(bridge);
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    const evidence = { messageId: 'scheduler-message-1', sessionId: 'session-1', targetIds: ['target-0', 'target-1'] };
    expect(await bridge.message({ action, v: 1, runId: config.runId, type: 'event', nonce, event: 'scheduler-batch', evidence }, bridge.sender)).toMatchObject({ type: 'accepted', nonce });
    expect(bridge.reports.at(-1).payload).toMatchObject({ event: 'scheduler-batch', evidence });
    expect(JSON.stringify(bridge.reports.at(-1))).not.toContain(targetTexts[0]);
    expect(bridge.browser.storage.local.set).toHaveBeenCalledWith({ PROVIDER_OPTIMIZATION_LEVELS: { edge: 5 } });
  });

  it('dispatches the authenticated provider-only invoke through the bound worker wrapper only after arm/start', async () => {
    const invokeProviderOnly = vi.fn(async () => ['actual provider result']);
    const bridge = setup({ providerOnly: true, invokeProviderOnly });
    const nonce = await completeProviderOnlyHandshake(bridge);
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    const valid = { action, v: 1, runId: config.runId, type: 'invoke', nonce, texts: targetTexts,
      sessionId: `${config.runId}-provider-session`, messageId: `${config.runId}-provider-message` };

    expect((await bridge.message(valid, bridge.sender)).code).toBe('PROTOCOL_ERROR');
    expect((await bridge.message(valid, { ...bridge.sender, tab: { id: 8 } })).code).toBe('SENDER_REJECTED');
    expect((await bridge.message({ ...valid, nonce: 'wrong-nonce' }, bridge.sender)).code).toBe('PROTOCOL_ERROR');
    const arm = await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    expect(arm).toMatchObject({ type: 'armed-ack', decision: 'start' });
    expect((await bridge.message({ ...valid, sessionId: 'wrong-session' }, bridge.sender)).code).toBe('PROTOCOL_ERROR');
    expect((await bridge.message({ ...valid, messageId: 'wrong-message' }, bridge.sender)).code).toBe('PROTOCOL_ERROR');
    expect(invokeProviderOnly).not.toHaveBeenCalled();

    expect(await bridge.message(valid, bridge.sender)).toMatchObject({ type: 'provider-complete', nonce });
    expect(invokeProviderOnly).toHaveBeenCalledOnce();
    expect(invokeProviderOnly).toHaveBeenCalledWith(targetTexts, { sessionId: valid.sessionId, messageId: valid.messageId });
    expect(bridge.reports.map(report => report.payload.phase).filter(Boolean)).toEqual(['bootstrap', 'loaded', 'ready', 'loaded', 'ready']);
    expect(bridge.reports.some(report => report.payload.phase === 'error')).toBe(false);
  });

  it('authenticates Stop Auto batch and command gates against the pinned sender, nonce, and owned session', async () => {
    vi.stubGlobal('__firefoxPageTranslationStopMode', true);
    const bridge = setup({ pageTranslationE2E: true });
    const nonce = await completeProviderOnlyHandshake(bridge);
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    const sendEvent = (event, evidence, sender = bridge.sender, eventNonce = nonce) => bridge.message({
      action, v: 1, runId: config.runId, type: 'event', nonce: eventNonce, event, evidence,
    }, sender);
    const first = { messageId: 'batch-first', sessionId: 'session-stop', targetIds: Array.from({ length: 6 }, (_, index) => `target-${index}`) };
    const second = { messageId: 'batch-second', sessionId: 'session-stop', targetIds: Array.from({ length: 6 }, (_, index) => `target-${index + 6}`) };
    await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    expect(await sendEvent('scheduler-batch', first)).toMatchObject({ type: 'accepted', nonce });
    expect(await sendEvent('scheduler-batch', second)).toMatchObject({ type: 'accepted', nonce });
    const acceptedBatch = { ...first, acceptedTargetIds: [...first.targetIds] };
    expect((await sendEvent('scheduler-batch-accepted', acceptedBatch, bridge.sender, 'wrong-nonce')).code).toBe('PROTOCOL_ERROR');
    expect((await sendEvent('scheduler-batch-accepted', acceptedBatch, { ...bridge.sender, tab: { id: 99 } })).code).toBe('SENDER_REJECTED');
    expect((await sendEvent('scheduler-batch-accepted', { ...acceptedBatch, sessionId: 'other-session' })).code).toBe('PROTOCOL_ERROR');
    expect(await sendEvent('scheduler-batch-accepted', acceptedBatch)).toMatchObject({ type: 'accepted', nonce });

    const stopCommand = {
      sessionId: 'session-stop', firstBatchMessageId: first.messageId, firstBatchTargetIds: first.targetIds,
      acceptedTargetIds: first.targetIds, pendingTargetIds: second.targetIds, stopSuccess: true, stopSessionId: 'session-stop',
      translatedCount: 6, isTranslated: true, isAutoTranslating: false, acceptedDOMRetained: true, pendingDOMUnchanged: true,
      acceptedStateHash: 'ab'.repeat(32), pendingStateHash: 'cd'.repeat(32),
    };
    expect((await sendEvent('stop-auto-command', { ...stopCommand, stopSuccess: false })).code).toBe('PROTOCOL_ERROR');
    expect(await sendEvent('stop-auto-command', stopCommand)).toMatchObject({ type: 'accepted', nonce });
    const operationEvents = bridge.reports.filter(report => report.payload.op).map(report => report.payload.event);
    expect(operationEvents).toEqual(['armed', 'scheduler-batch', 'scheduler-batch', 'scheduler-batch-accepted', 'stop-auto-command']);
    expect(bridge.reports.some(report => report.payload.phase === 'error')).toBe(false);
  });

  it('reports provider-only invocation failures through the provider operation lane, not the ready handshake', async () => {
    const invokeProviderOnly = vi.fn(async () => { throw Object.assign(new Error('private provider detail'), { code: 'TIMEOUT' }); });
    const bridge = setup({ providerOnly: true, invokeProviderOnly });
    const nonce = await completeProviderOnlyHandshake(bridge);
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    const response = await bridge.message({ action, v: 1, runId: config.runId, type: 'invoke', nonce, texts: targetTexts,
      sessionId: `${config.runId}-provider-session`, messageId: `${config.runId}-provider-message` }, bridge.sender);
    expect(response).toMatchObject({ type: 'error', code: 'TIMEOUT' });
    expect(bridge.reports.at(-1).payload).toMatchObject({ op: 'edge-fr-page-once', event: 'error', evidence: { code: 'TIMEOUT' } });
    expect(bridge.reports.some(report => report.payload.phase === 'error')).toBe(false);
    expect(JSON.stringify(bridge.reports)).not.toContain('private provider detail');
  });

  it('keeps provider settlement telemetry live while Stop Auto waits on a separate authenticated control channel', async () => {
    const bridge = setup({ pageTranslationE2E: true });
    vi.stubGlobal('__firefoxPageTranslationStopMode', true);
    const nonce = await completeProviderOnlyHandshake(bridge);
    globalThis.__pageTranslationBenchmark.cancellationSnapshot.mockReturnValue({
      ledger: { operations: [{ kind: 'provider.root', messageId: 'batch-second', sessionId: 'session-stop', status: 'rejected',
        operationAborted: true, controllerAbortedAtEnd: true, resultSuccess: null, settledSequence: 4 }] },
      providerRoots: [
        { messageId: 'batch-first', sessionId: 'session-stop', status: 'fulfilled', controllerAborted: false, settledSequence: 1 },
        { messageId: 'batch-second', sessionId: 'session-stop', status: 'rejected', controllerAborted: true, settledSequence: 3 },
      ],
    });
    const action = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
    const send = (event, evidence, sender = bridge.sender, eventNonce = nonce) => bridge.message({
      action, v: 1, runId: config.runId, type: 'event', nonce: eventNonce, event, evidence,
    }, sender);
    const reportOperation = (event, evidence) => globalThis.__firefoxProviderProbeRuntime.report(event, evidence);
    const first = { messageId: 'batch-first', sessionId: 'session-stop', targetIds: Array.from({ length: 6 }, (_, i) => `target-${i}`) };
    const second = { messageId: 'batch-second', sessionId: 'session-stop', targetIds: Array.from({ length: 6 }, (_, i) => `target-${i + 6}`) };
    await bridge.message({ action, v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
    await send('scheduler-batch', first);
    await send('scheduler-batch', second);
    const accepted = { ...first, acceptedTargetIds: [...first.targetIds] };
    const stopControlMessage = bridge.waitForStopControl('stop-auto');
    const stopPoll = bridge.waitForStopPoll('stop');
    expect((await send('scheduler-batch-accepted', accepted, bridge.sender, 'wrong')).code).toBe('PROTOCOL_ERROR');
    expect((await send('scheduler-batch-accepted', accepted, { ...bridge.sender, tab: { id: 99 } })).code).toBe('SENDER_REJECTED');
    expect((await send('scheduler-batch-accepted', { ...accepted, sessionId: 'wrong-session' })).code).toBe('PROTOCOL_ERROR');
    expect(await send('scheduler-batch-accepted', accepted)).toMatchObject({ type: 'accepted', nonce });
    expect(await stopPoll).toBe('stop');
    expect(await stopControlMessage).toMatchObject({ type: 'stop-auto', sessionId: 'session-stop' });

    const firstInvocation = { invocationId: 'invocation-first', sessionId: 'session-stop', messageId: first.messageId,
      provider: 'edge', itemCount: 6, sourceIndexes: [0, 1, 2, 3, 4, 5] };
    const secondInvocation = { invocationId: 'invocation-second', sessionId: 'session-stop', messageId: second.messageId,
      provider: 'edge', itemCount: 6, sourceIndexes: [6, 7, 8, 9, 10, 11] };
    await reportOperation('provider-invoked', firstInvocation); await reportOperation('provider-invoked', secondInvocation);
    const physical = (attemptId, invocation) => ({ attemptId, invocationId: invocation.invocationId, sessionId: invocation.sessionId,
      messageId: invocation.messageId, provider: 'edge', method: 'POST', url: 'https://edge.microsoft.com/translate/translatetext?to=fr&isEnterpriseClient=false',
      bodyBytes: 100, bodyHash: 'ab'.repeat(32), sourceIndexes: invocation.sourceIndexes });
    const firstPhysical = physical('attempt-first', firstInvocation); const secondPhysical = physical('attempt-second', secondInvocation);
    await reportOperation('physical-start', firstPhysical); await reportOperation('physical-start', secondPhysical);
    await reportOperation('physical-settled', { attemptId: firstPhysical.attemptId, sessionId: 'session-stop', outcome: 'fulfilled', status: 200, code: null });
    await reportOperation('parser-success', { invocationId: firstInvocation.invocationId, sessionId: 'session-stop', sourceIndexes: firstInvocation.sourceIndexes, resultsMatch: true });
    await reportOperation('provider-settled', { invocationId: firstInvocation.invocationId, sessionId: 'session-stop', outcome: 'fulfilled', code: null });
    await reportOperation('physical-settled', { attemptId: secondPhysical.attemptId, sessionId: 'session-stop', outcome: 'cancelled', status: null, code: 'ABORTED' });
    await reportOperation('provider-settled', { invocationId: secondInvocation.invocationId, sessionId: 'session-stop', outcome: 'rejected', code: 'PROTOCOL_ERROR' });

    const command = {
      sessionId: 'session-stop', firstBatchMessageId: first.messageId, firstBatchTargetIds: first.targetIds,
      acceptedTargetIds: first.targetIds, pendingTargetIds: second.targetIds, stopSuccess: true,
      stopSessionId: 'session-stop', translatedCount: 6, isTranslated: true, isAutoTranslating: false,
      acceptedDOMRetained: true, pendingDOMUnchanged: true, acceptedStateHash: 'ab'.repeat(32), pendingStateHash: 'cd'.repeat(32),
    };
    expect((await send('stop-auto-command', { ...command, sessionId: 'wrong-session' })).code).toBe('PROTOCOL_ERROR');
    const captureControlMessage = bridge.waitForStopControl('capture');
    const capturePoll = bridge.waitForStopPoll('capture');
    expect(await send('stop-auto-command', command)).toMatchObject({ type: 'accepted', nonce });
    expect(await capturePoll).toBe('capture');
    expect(await captureControlMessage).toMatchObject({ type: 'capture', sessionId: 'session-stop' });

    const contentState = { capturedSessionActive: false, discoveryCancelled: true, currentBridgeOwnsSession: true,
      schedulerSessionContextOwned: false, pendingOperations: 0, translationSessionId: 'session-stop', activeFlushes: 0,
      queueIds: [], activeBatchIds: [], pendingSettlementCount: 0, bridgeSessionActive: false, bridgeDiscoveryPending: false,
      bridgeDiscoveryRunning: false, bridgeDiscoveryStarting: false, bridgeDiscoveryQueueDepth: 0,
      bridgeDiscoveryCancelled: true, bridgeDiscoveryFailed: false };
    const final = { sessionId: 'session-stop', firstBatchMessageId: first.messageId, firstBatchTargetIds: first.targetIds,
      secondBatchMessageId: second.messageId, secondBatchTargetIds: second.targetIds, acceptedTargetIds: first.targetIds,
      pendingTargetIds: second.targetIds, acceptedDOMRetained: true, pendingDOMUnchanged: true,
      acceptedStateHash: command.acceptedStateHash, pendingStateHash: command.pendingStateHash,
      postStopMutationTargetIds: [], cancellationRequests: [
        { action: 'CANCEL_TRANSLATION', sessionId: 'session-stop', status: 'fulfilled', responseSuccess: true, cancelAll: true, context: 'page-translation-batch' },
        { action: 'CANCEL_SESSION', sessionId: 'session-stop', status: 'fulfilled', responseSuccess: true, cancelAll: null, context: null },
      ], contentState };
    expect(await send('stop-auto-final', final)).toMatchObject({ type: 'accepted', nonce });
    const events = bridge.reports.filter(report => report.payload.op).map(report => report.payload.event);
    expect(events).toContain('physical-settled');
    expect(events).toContain('provider-settled');
    expect(events.at(-1)).toBe('stop-auto-final');
    expect(bridge.reports.some(report => report.payload.phase === 'error')).toBe(false);
  });

  it('keeps ordinary runtime messaging at three seconds and uses the shared ten-second provider-only deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(() => new Promise(() => {})) } });
    expect(PROVIDER_ONLY_DEADLINE_MS).toBe(10_000);
    const handshake = sendRuntimeMessage({ type: 'hello' });
    let handshakeSettled = false;
    handshake.then(() => { handshakeSettled = true; }, () => { handshakeSettled = true; });
    const handshakeFailure = expect(handshake).rejects.toMatchObject({ message: 'READINESS_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(handshakeSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await handshakeFailure;

    const invocation = sendRuntimeMessage({ type: 'invoke' }, PROVIDER_ONLY_DEADLINE_MS);
    let invocationSettled = false;
    invocation.then(() => { invocationSettled = true; }, () => { invocationSettled = true; });
    const invocationFailure = expect(invocation).rejects.toMatchObject({ message: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(PROVIDER_ONLY_DEADLINE_MS - 1);
    expect(invocationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await invocationFailure;
  });

  it('reports pre-physical Edge permission, proxy, and observer gate failures as protocol blockers', async () => {
    for (const options of [{ edgePermission: false }, { proxyEnabled: true }]) {
      const bridge = setup(options);
      await bridge.start();
      const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
      const nonce = challenge.nonce;
      const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce };
      await bridge.message({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, bridge.sender);
      await bridge.message({ ...base, type: 'ready', checks, flags }, bridge.sender);
      await bridge.message({ ...base, type: 'ack-received', ack: 'ready-ack' }, bridge.sender);
      await bridge.message({ ...base, type: 'content-ready', checks, flags, ackReceived: true }, bridge.sender);
      const arm = await bridge.message({ action: '__PAGE_TRANSLATION_PROVIDER_PROBE_V1', v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: true }, bridge.sender);
      expect(arm).toMatchObject({ type: 'armed-ack', decision: 'stop' });
      expect(bridge.reports.at(-1).payload).toMatchObject({ event: 'error', evidence: { code: 'PROTOCOL_ERROR' } });
      expect(bridge.reports.some(item => item.payload.event === 'physical-start')).toBe(false);
    }
    const bridge = setup();
    await bridge.start();
    const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    const nonce = challenge.nonce;
    const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce };
    await bridge.message({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, bridge.sender);
    await bridge.message({ ...base, type: 'ready', checks, flags }, bridge.sender);
    await bridge.message({ ...base, type: 'ack-received', ack: 'ready-ack' }, bridge.sender);
    await bridge.message({ ...base, type: 'content-ready', checks, flags, ackReceived: true }, bridge.sender);
    const arm = await bridge.message({ action: '__PAGE_TRANSLATION_PROVIDER_PROBE_V1', v: 1, runId: config.runId, type: 'arm', nonce, observersInstalled: false }, bridge.sender);
    expect(arm).toMatchObject({ type: 'armed-ack', decision: 'stop' });
    expect(bridge.reports.at(-1).payload).toMatchObject({ event: 'error', evidence: { code: 'PROTOCOL_ERROR' } });
  });

  it('pins the pre-existing unique binding tab without depending on a later binding commit', async () => {
    const bridge = setup();
    await bridge.start();
    expect(bridge.browser.tabs.query).toHaveBeenCalledOnce();
    expect(bridge.browser.tabs.query).toHaveBeenCalledWith({});
    expect(bridge.reports.map(item => item.payload.phase)).toEqual(['bootstrap', 'loaded', 'ready']);
    expect(bridge.reports[0].payload.evidence.tabId).toBe(7);
  });

  it('admits the fixture navigation before releasing collector readiness while waiting for its receipt', async () => {
    const bridge = setup({ holdReadyReport: true });
    await bridge.start();
    bridge.releaseReady();
    const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    expect(challenge.type).toBe('challenge');
    expect(bridge.reports.find(item => item.payload.phase === 'ready').payload.evidence.checks.startupComplete).toBe(true);
  });

  it('rejects a second top-frame commit and reports navigation invalidation', async () => {
    const bridge = setup();
    await bridge.start();
    bridge.commit({ frameId: 0, tabId: 7, url: config.fixtureUrl, documentId: 'doc-1' });
    const result = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    expect(result.code).toBe('NAVIGATION_INVALID');
    expect(bridge.reports.at(-1).payload).toMatchObject({ realm: 'background', phase: 'error', evidence: { code: 'NAVIGATION_INVALID' } });
  });

  it('records correlated startup failures as content terminal reports, not background failures', async () => {
    const bridge = setup();
    await bridge.start();
    const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    const base = { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, nonce: challenge.nonce };
    await bridge.message({ ...base, type: 'loaded', entry: 'src/core/content-scripts/index-main.js' }, bridge.sender);
    expect((await bridge.message({ ...base, type: 'error', code: 'STARTUP_FAILED' }, bridge.sender)).type).toBe('accepted');
    expect(bridge.reports.at(-1).payload).toMatchObject({ realm: 'content', phase: 'error', evidence: { code: 'STARTUP_FAILED' } });
  });

  it('reports pre-challenge transport failure with the fixed handshake error code', async () => {
    const bridge = setup();
    await bridge.start();
    const response = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'error', code: 'HANDSHAKE_FAILED' }, bridge.sender);
    expect(response.type).toBe('accepted');
    expect(bridge.reports.at(-1).payload).toMatchObject({ realm: 'content', phase: 'error', evidence: { code: 'HANDSHAKE_FAILED' } });
  });

  it('revalidates navigation invalidation that occurs during asynchronous frame lookup', async () => {
    const bridge = setup();
    await bridge.start();
    let resolveFrame;
    bridge.browser.webNavigation.getFrame.mockImplementationOnce(() => new Promise(resolve => { resolveFrame = resolve; }));
    const pending = bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    await vi.waitFor(() => expect(resolveFrame).toBeTypeOf('function'));
    bridge.commit({ frameId: 0, tabId: 7, url: 'http://127.0.0.1:4321/changed' });
    resolveFrame({ url: config.fixtureUrl, documentId: 'doc-1' });
    const result = await pending;
    expect(result.code).toBe('NAVIGATION_INVALID');
    expect(bridge.reports.at(-1).payload.evidence.code).toBe('NAVIGATION_INVALID');
  });

  it.each([0, 2])('reports BINDING_FAILED when the initial binding query returns %i tabs', async count => {
    const bridge = setup({ bindingTabCount: count });
    await bridge.start();
    expect(bridge.importEntry).not.toHaveBeenCalled();
    expect(bridge.reports.at(-1).payload).toMatchObject({ realm: 'background', phase: 'error', evidence: { code: 'BINDING_FAILED' } });
  });

  it('requires the actual LifecycleManager message handler to remain active', () => {
    globalThis.backgroundService = { initialized: true, _translationEngineInitialized: true, translationEngine: {}, messageHandler: { isListenerActive: false } };
    globalThis.unifiedTranslationService = { translationEngine: globalThis.backgroundService.translationEngine, backgroundService: globalThis.backgroundService };
    globalThis.__pageTranslationBenchmark = { unifiedTranslationService: globalThis.unifiedTranslationService };
    globalThis.__firefoxProbeStartup = { complete: true, success: true };
    const result = getBackgroundReadinessChecks();
    expect(result.messageListenerActive).toBe(false);
    expect(Object.values(result).every(Boolean)).toBe(false);
  });

  it('reports exactly-once text and title acceptance, then restores original markup, attributes, and metadata', async () => {
    vi.useFakeTimers();
    const fixture = createPageTranslationFixture();
    document.body.replaceChildren(...fixture.targets.map(target => {
      const element = document.createElement('p');
      element.dataset.benchId = target.id;
      element.dataset.benchKind = target.kind;
      if (target.kind === 'text') element.textContent = target.source;
      else element.title = target.source;
      return element;
    }));
    const actualNodes = [...document.querySelectorAll('[data-bench-id]')];
    const schedulerNodes = actualNodes.map((element, index) => index < 6 ? element.firstChild : element.getAttributeNode('title'));
    const snapshots = actualNodes.map(element => ({ text: element.textContent, markup: element.innerHTML, title: element.getAttribute('title') }));
    const translatedGate = deferred();
    const restoredGate = deferred();
    const events = [];
    const manager = {
      isTranslating: false,
      translationMessageId: 'session-1',
      acceptedLifecycleSessionId: 'session-1',
      scheduler: {
        translationSessionId: 'session-1', activeFlushes: 0, queue: [],
        _createSettlement() {
          let pending = true;
          return { settle() { if (!pending) return false; pending = false; return true; } };
        },
      },
      async restorePage() {
        for (const [index, element] of actualNodes.entries()) {
          if (index < 6) element.textContent = targetTexts[index];
          else element.title = targetTexts[index];
        }
        return { success: true, sessionId: 'session-1' };
      },
    };
    const handler = {
      pageTranslationManager: manager,
      handlers: new Map([['page-translate', async () => ({ success: true, messageId: 'session-1' })]]),
      setPageTranslationManager(value) { this.pageTranslationManager = value; },
    };
    const report = async (event, evidence) => {
      events.push({ event, evidence });
      if (event === 'translated') translatedGate.resolve(evidence);
      if (event === 'restored') restoredGate.resolve(evidence);
      return event === 'translated' ? { decision: 'restore' } : undefined;
    };
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(message => {
      expect(message).toEqual({ action: 'page-restore', context: 'content', data: {} });
      return manager.restorePage();
    }) } });
    const probe = installContentProviderProbe({ handler, report, fixtureUrl: location.href });
    expect(probe.installed).toBe(true);
    const commandResult = await handler.handlers.get('page-translate')({ action: 'page-translate', context: 'content', data: { provider: 'edge', targetLanguage: 'fr' } });
    expect(commandResult).toMatchObject({ success: true, messageId: 'session-1' });
    expect(events.at(-1)).toMatchObject({ event: 'command-result', evidence: { success: true, sessionId: 'session-1', code: null } });
    for (const [index, node] of schedulerNodes.entries()) {
      const settlement = manager.scheduler._createSettlement({ node });
      settlement.settle('accepted');
      if (index < 6) node.nodeValue = `\u200efixture translation: ${targetTexts[index]}`;
      else node.ownerElement.title = `\u200efixture translation: ${targetTexts[index]}`;
    }
    await vi.advanceTimersByTimeAsync(150);
    const translatedEvidence = await translatedGate.promise;
    expect(events.find(item => item.event === 'translated').evidence).toMatchObject({
      sessionId: 'session-1', acceptedCount: 12, duplicateAcceptances: 0, staleWrites: 0,
      domMatches: true, sessionOwned: true, quiescent: true,
      acceptedMutationCounts: { text: 6, title: 6 }, unattributedWrites: 0,
    });
    expect(translatedEvidence.acceptedCount).toBe(12);
    const restoredEvidence = await restoredGate.promise;
    expect(restoredEvidence).toEqual({
      sessionId: 'session-1', commandSuccess: true, domMatchesOriginal: true, metadataRestored: true, restoreObserved: true,
    });
    expect(actualNodes.map(element => ({ text: element.textContent, markup: element.innerHTML, title: element.getAttribute('title') }))).toEqual(snapshots);
    expect(schedulerNodes).toHaveLength(12);
    expect(events.some(item => item.event === 'error')).toBe(false);
  });

  it('rejects missing, duplicate, and unattributed text/title mutation accounting', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    const kinds = [...Array(6).fill('text'), ...Array(6).fill('title')];
    const valid = { targetKinds: kinds, acceptedIds: ids, mutationIds: ids, duplicateAcceptances: 0, staleWrites: 0, unattributedWrites: 0 };
    expect(validateAcceptedMutationAccounting(valid)).toEqual({ ok: true, counts: { text: 6, title: 6 } });
    expect(validateAcceptedMutationAccounting({ ...valid, mutationIds: ids.slice(1) }).ok).toBe(false);
    expect(validateAcceptedMutationAccounting({ ...valid, mutationIds: [...ids, ids[6]], duplicateAcceptances: 1 }).ok).toBe(false);
    expect(validateAcceptedMutationAccounting({ ...valid, unattributedWrites: 1 }).ok).toBe(false);
  });

  it('rejects a real restore that leaves a translation marker on the owned root', async () => {
    document.body.replaceChildren(...targetTexts.map((text, index) => {
      const element = document.createElement('p');
      element.dataset.benchId = `target-${index}`;
      element.textContent = text;
      return element;
    }));
    const nodes = [...document.querySelectorAll('[data-bench-id]')];
    const manager = {
      isTranslating: false, translationMessageId: 'session-marker', acceptedLifecycleSessionId: 'session-marker',
      scheduler: { translationSessionId: 'session-marker', activeFlushes: 0, queue: [], _createSettlement() { return { settle: () => true }; } },
      async restorePage() {
        for (const [index, node] of nodes.entries()) node.textContent = targetTexts[index];
        document.documentElement.setAttribute('data-page-translated', 'leftover');
        return { success: true, sessionId: 'session-marker' };
      },
    };
    const eventsReport = [];
    const handler = { pageTranslationManager: manager, handlers: new Map([['page-translate', async () => ({ success: true, messageId: 'session-marker' })]]), setPageTranslationManager(value) { this.pageTranslationManager = value; } };
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(message => {
      expect(message.action).toBe('page-restore');
      return manager.restorePage();
    }) } });
    const probe = installContentProviderProbe({ handler, fixtureUrl: location.href, report: async (event, evidence) => {
      eventsReport.push({ event, evidence });
      return event === 'translated' ? { decision: 'restore' } : undefined;
    } });
    expect(probe.installed).toBe(true);
    for (const [index, node] of nodes.entries()) {
      manager.scheduler._createSettlement({ node }).settle('accepted');
      node.textContent = `\u200efixture translation: ${targetTexts[index]}`;
    }
    await vi.waitFor(() => expect(eventsReport.some(item => item.event === 'error')).toBe(true), { timeout: 1000 });
    expect(eventsReport.some(item => item.event === 'restored')).toBe(false);
    expect(eventsReport.at(-1)).toEqual({ event: 'error', evidence: { code: 'PROTOCOL_ERROR' } });
  });

  it.each([undefined, null, {}])('does not treat an absent or malformed command success value (%s) as translated', async value => {
    document.body.replaceChildren(...targetTexts.map((text, index) => {
      const element = document.createElement('p'); element.dataset.benchId = `target-${index}`; element.textContent = text; return element;
    }));
    const manager = { scheduler: { _createSettlement() { return { settle: () => true }; } }, restorePage: async () => ({ success: true }) };
    const events = [];
    const handler = { pageTranslationManager: manager, handlers: new Map([['page-translate', async () => value]]), setPageTranslationManager(candidate) { this.pageTranslationManager = candidate; } };
    const probe = installContentProviderProbe({ handler, fixtureUrl: location.href, report: async (event, evidence) => { events.push({ event, evidence }); return null; } });
    expect(probe.installed).toBe(true);
    await handler.handlers.get('page-translate')({ context: 'content', data: { provider: 'edge', targetLanguage: 'fr' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ event: 'command-result', evidence: { success: false, sessionId: null, code: 'PROTOCOL_ERROR' } });
    probe.disconnect();
  });

  it('detects repeated accepted text mutations within one observer delivery', async () => {
    document.body.replaceChildren(...targetTexts.map((text, index) => {
      const element = document.createElement('p'); element.dataset.benchId = `target-${index}`; element.textContent = text; return element;
    }));
    const nodes = [...document.querySelectorAll('[data-bench-id]')];
    const manager = {
      isTranslating: false, translationMessageId: 'session-duplicate', acceptedLifecycleSessionId: 'session-duplicate',
      scheduler: { translationSessionId: 'session-duplicate', activeFlushes: 0, queue: [], _createSettlement() { return { settle: () => true }; } },
      restorePage: async () => ({ success: true, sessionId: 'session-duplicate' }),
    };
    const events = [];
    const handler = { pageTranslationManager: manager, handlers: new Map([['page-translate', async () => ({ success: true, messageId: 'session-duplicate' })]]), setPageTranslationManager(candidate) { this.pageTranslationManager = candidate; } };
    const probe = installContentProviderProbe({ handler, fixtureUrl: location.href, report: async (event, evidence) => { events.push({ event, evidence }); return null; } });
    for (const [index, node] of nodes.entries()) {
      manager.scheduler._createSettlement({ node }).settle('accepted');
      node.textContent = `\u200efixture translation: ${targetTexts[index]}`;
    }
    nodes[0].firstChild.nodeValue = `\u200efixture translation: ${targetTexts[0]}`;
    nodes[0].firstChild.nodeValue = `\u200efixture translation: ${targetTexts[0]}`;
    await vi.waitFor(() => expect(events.some(item => item.event === 'error')).toBe(true));
    expect(events.find(item => item.event === 'translated')).toBeUndefined();
    probe.disconnect();
  });

  it('fails closed on permission denial and import failure without forwarding raw error details', async () => {
    const denied = setup({ permission: false });
    await denied.start().catch(() => {});
    expect(denied.reports.at(-1).payload).toMatchObject({ realm: 'background', phase: 'error', evidence: { code: 'PERMISSION_DENIED' } });

    const failed = setup({ importFails: true });
    await failed.start().catch(() => {});
    expect(failed.reports.at(-1).payload).toMatchObject({ realm: 'background', phase: 'error', evidence: { code: 'IMPORT_FAILED' } });
    expect(JSON.stringify(failed.reports)).not.toContain('do not expose raw error');
  });

  it('rejects changed document identity and mismatched discovery flags', async () => {
    const bridge = setup();
    await bridge.start();
    const challenge = await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'hello' }, bridge.sender);
    bridge.browser.webNavigation.getFrame.mockResolvedValue({ url: config.fixtureUrl, documentId: 'changed-doc' });
    expect((await bridge.message({ action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'loaded', nonce: challenge.nonce, entry: 'src/core/content-scripts/index-main.js' }, bridge.sender)).code).toBe('NAVIGATION_INVALID');
    expect(flags.viewportFirstDiscoveryEnabled).toBe(false);
    expect(checks.coreInitialized).toBe(true);
  });

  it('loads content only after challenge, confirms real readiness, then acknowledges final evidence', async () => {
    const messages = [];
    const fixtureUrl = location.href;
    const nonce = 'a'.repeat(64);
    const responses = ['challenge', 'loaded-ack', 'ready-ack', 'confirmed', 'accepted'];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      if (message.action === '__PAGE_TRANSLATION_PROVIDER_PROBE_V1') return { action: message.action, v: 1, runId: config.runId, type: 'armed-ack', nonce, decision: 'start' };
      const type = responses.shift();
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.nonce ? { nonce: message.nonce } : type !== 'accepted' ? { nonce } : {}) };
    }) } });
    const importEntry = vi.fn(async () => {
      window.translateItContentCore = { initialized: true };
      window.__firefoxProbeStartup = { complete: true, success: true };
      window.__pageTranslationBenchmark = {
        featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
        installProviderProbe: async () => ({ installed: true }),
        discoveryFlags: flags,
      };
    });

    await installContentProbe({ runId: config.runId, fixtureUrl }, importEntry);

    expect(importEntry).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.action === '__PAGE_TRANSLATION_RUNTIME_PROBE_V1').map(message => message.type)).toEqual(['hello', 'loaded', 'ready', 'ack-received', 'content-ready']);
    expect(messages.find(message => message.action === '__PAGE_TRANSLATION_PROVIDER_PROBE_V1')).toMatchObject({ type: 'arm', observersInstalled: true });
    expect(messages.filter(message => message.action === 'page-translate')).toEqual([{
      action: 'page-translate', context: 'content', data: { provider: 'edge', targetLanguage: 'fr' },
    }]);
    expect(messages.find(message => message.action === '__PAGE_TRANSLATION_RUNTIME_PROBE_V1' && message.type === 'content-ready')).toMatchObject({ checks, flags, ackReceived: true });
  });

  it('does not send the production translation command when the authenticated arm gate returns stop', async () => {
    const messages = [];
    const disconnected = vi.fn();
    const nonce = 'b'.repeat(64);
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      if (message.action === '__PAGE_TRANSLATION_PROVIDER_PROBE_V1') return { action: message.action, v: 1, runId: config.runId, type: 'armed-ack', nonce, decision: 'stop' };
      const type = { hello: 'challenge', loaded: 'loaded-ack', ready: 'ready-ack', 'ack-received': 'confirmed', 'content-ready': 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.nonce ? { nonce: message.nonce } : { nonce }) };
    }) } });
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {
      window.translateItContentCore = { initialized: true };
      window.__firefoxProbeStartup = { complete: true, success: true };
      window.__pageTranslationBenchmark = {
        featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
        installProviderProbe: async () => ({ installed: true, disconnect: disconnected }),
        discoveryFlags: flags,
      };
    });
    expect(messages.some(message => message.action === 'page-translate')).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('does not treat a completed module import as readiness and reports bounded timeout', async () => {
    vi.useFakeTimers();
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const type = { hello: 'challenge', loaded: 'loaded-ack', error: 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.type !== 'error' ? { nonce: 'b'.repeat(64) } : {}) };
    }) } });
    const pending = installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {});
    await vi.advanceTimersByTimeAsync(15_100);
    await pending;
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'READINESS_TIMEOUT' });
  });

  it('does not confuse active content features with the core message listener', async () => {
    vi.useFakeTimers();
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const type = { hello: 'challenge', loaded: 'loaded-ack', error: 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.type !== 'error' ? { nonce: 'd'.repeat(64) } : {}) };
    }) } });
    const pending = installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {
      window.translateItContentCore = { initialized: true, messageHandler: { isListenerActive: false } };
      window.__firefoxProbeStartup = { complete: true, success: true };
      window.__pageTranslationBenchmark = {
        featureState: () => ({ initialized: true, active: true, listenerActive: false, handlerActive: true, handlerIsActive: true }),
        discoveryFlags: flags,
      };
    });
    await vi.advanceTimersByTimeAsync(15_100);
    await pending;
    expect(messages.some(message => message.type === 'ready')).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'READINESS_TIMEOUT', nonce: 'd'.repeat(64) });
  });

  it('rejects wrong acknowledgements and discovery flags without reporting content ready', async () => {
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const type = { hello: 'challenge', loaded: 'loaded-ack', ready: 'wrong-ack', error: 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, nonce: 'c'.repeat(64) };
    }) } });
    window.translateItContentCore = { initialized: true };
    window.__firefoxProbeStartup = { complete: true, success: true };
    window.__pageTranslationBenchmark = {
      featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
      discoveryFlags: flags,
    };
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {});
    expect(messages.map(message => message.type)).toEqual(['hello', 'loaded', 'ready', 'error']);
    expect(messages.at(-1).code).toBe('PROTOCOL_REJECTED');
    expect(messages.some(message => message.type === 'content-ready')).toBe(false);
  });

  it('reports startup failure after loaded with the challenge nonce and separates import failure', async () => {
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const type = { hello: 'challenge', loaded: 'loaded-ack', error: 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.type !== 'error' ? { nonce: 'e'.repeat(64) } : {}) };
    }) } });
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {
      window.__firefoxProbeStartup = { complete: true, success: false };
    });
    expect(messages.map(message => message.type)).toEqual(['hello', 'loaded', 'error']);
    expect(messages.at(-1)).toMatchObject({ code: 'STARTUP_FAILED', nonce: 'e'.repeat(64) });

    messages.length = 0;
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => { throw new Error('raw import failure'); });
    expect(messages.map(message => message.type)).toEqual(['hello', 'error']);
    expect(messages.at(-1)).toMatchObject({ code: 'IMPORT_FAILED', nonce: 'e'.repeat(64) });
    expect(JSON.stringify(messages)).not.toContain('raw import failure');
  });

  it('rejects mismatched challenge and final receipt envelopes', async () => {
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      if (message.type === 'hello') return { action: 'wrong-action', v: 1, runId: config.runId, type: 'challenge', nonce: 'a'.repeat(64) };
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type: 'accepted' };
    }) } });
    const importEntry = vi.fn();
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, importEntry);
    expect(importEntry).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'HANDSHAKE_FAILED' });

    messages.length = 0;
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const responsesByRequest = { hello: 'challenge', loaded: 'loaded-ack', ready: 'ready-ack', 'ack-received': 'confirmed', 'content-ready': 'accepted', error: 'accepted' };
      const type = responsesByRequest[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.type === 'content-ready' ? {} : message.nonce ? { nonce: message.nonce } : type !== 'accepted' ? { nonce: 'a'.repeat(64) } : {}) };
    }) } });
    window.translateItContentCore = { initialized: true };
    window.__firefoxProbeStartup = { complete: true, success: true };
    window.__pageTranslationBenchmark = { featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }), discoveryFlags: flags };
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {});
    expect(messages.at(-2).type).toBe('content-ready');
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'PROTOCOL_REJECTED', nonce: 'a'.repeat(64) });
  });

  it('composes real background/content routines and records one correlated late final-receipt rejection', async () => {
    const bridge = setup({ fixtureUrl: location.href });
    await bridge.start();
    const messages = [];
    let lateWrongNonce;
    let lateWrongSender;
    bridge.browser.runtime.sendMessage = vi.fn(async message => {
      messages.push(message);
      const result = await bridge.message(message, bridge.sender);
      if (message.type !== 'content-ready') return result;
      const correlatedError = { action: message.action, v: message.v, runId: message.runId, type: 'error', code: 'PROTOCOL_REJECTED', nonce: message.nonce };
      lateWrongNonce = await bridge.message({ ...correlatedError, nonce: 'wrong-nonce' }, bridge.sender);
      lateWrongSender = await bridge.message(correlatedError, { ...bridge.sender, id: 'wrong-extension' });
      expect(bridge.reports).toHaveLength(5);
      return { ...result, nonce: 'wrong-final-receipt-nonce' };
    });

    await installContentProbe(bridge.bridgeConfig, async () => {
      window.translateItContentCore = { initialized: true, messageHandler: { isListenerActive: true } };
      window.__firefoxProbeStartup = { complete: true, success: true };
      window.__pageTranslationBenchmark = {
        featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
        installProviderProbe: async () => ({ installed: true }),
        discoveryFlags: flags,
      };
    });

    expect(lateWrongNonce.type).toBe('error');
    expect(lateWrongSender.code).toBe('SENDER_REJECTED');
    expect(messages.filter(message => message.action === '__PAGE_TRANSLATION_RUNTIME_PROBE_V1').map(message => message.type)).toEqual(['hello', 'loaded', 'ready', 'ack-received', 'content-ready', 'error']);
    expect(messages.findLast(message => message.action === '__PAGE_TRANSLATION_RUNTIME_PROBE_V1')).toMatchObject({ type: 'error', code: 'PROTOCOL_REJECTED' });
    expect(bridge.reports.filter(item => Number.isSafeInteger(item.payload.seq)).map(item => [item.payload.seq, item.payload.realm, item.payload.phase, item.payload.evidence.code ?? null])).toEqual([
      [1, 'background', 'bootstrap', null], [2, 'background', 'loaded', null], [3, 'background', 'ready', null],
      [4, 'content', 'loaded', null], [5, 'content', 'ready', null], [6, 'content', 'error', 'PROTOCOL_REJECTED'],
    ]);
    expect(bridge.reports.some(item => item.payload.op === 'edge-fr-page-once' && item.payload.event === 'armed')).toBe(false);

    const duplicate = await bridge.message(messages.findLast(message => message.type === 'error' && message.action === '__PAGE_TRANSLATION_RUNTIME_PROBE_V1'), bridge.sender);
    expect(duplicate.type).toBe('error');
    expect(bridge.reports).toHaveLength(6);
  });

  it('reports a sliced-discovery mismatch as a bounded error, never ready evidence', async () => {
    const messages = [];
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async message => {
      messages.push(message);
      const type = { hello: 'challenge', loaded: 'loaded-ack', error: 'accepted' }[message.type];
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.type !== 'error' ? { nonce: 'f'.repeat(64) } : {}) };
    }) } });
    window.translateItContentCore = { initialized: true };
    window.__firefoxProbeStartup = { complete: true, success: true };
    window.__pageTranslationBenchmark = {
      featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
      discoveryFlags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: true },
    };
    await installContentProbe({ runId: config.runId, fixtureUrl: location.href }, async () => {});
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'DISCOVERY_FLAGS_MISMATCH' });
    expect(messages.some(message => message.type === 'content-ready')).toBe(false);
  });
});

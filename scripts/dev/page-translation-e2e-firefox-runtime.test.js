import { afterEach, describe, expect, it, vi } from 'vitest';
import { exactKeys, getBackgroundReadinessChecks, installBackgroundProbe, validateProbeEnvelope, validateSender } from './page-translation-e2e-firefox/runtime-background.mjs';
import { installContentProbe } from './page-translation-e2e-firefox/runtime-content.mjs';

const config = {
  runId: 'run-123', fixtureUrl: 'http://127.0.0.1:4321/fixture',
  bindingUrl: 'http://127.0.0.1:4321/__benchmark/bind/run-123',
  reportUrl: 'http://127.0.0.1:4321/__benchmark/runtime',
  authToken: 'c'.repeat(64), privateToken: 'build-private-token'.padEnd(64, 'a'),
};
const checks = { coreInitialized: true, listenerActive: true, featureManagerInitialized: true, handlerActive: true, handlerIsActive: true };
const flags = { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false };

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
});

function setup({ permission = true, importFails = false, bindingTabCount = 1, holdReadyReport = false, fixtureUrl = config.fixtureUrl } = {}) {
  let onMessage;
  let onCommitted;
  const bridgeConfig = { ...config, fixtureUrl };
  let currentUrl = bridgeConfig.bindingUrl;
  const reports = [];
  let releaseReadyReport;
  const browser = {
    runtime: {
      id: 'extension-id', getURL: () => 'moz-extension://extension-id/',
      onMessage: { addListener(listener) { onMessage = listener; }, hasListener: () => true },
    },
    permissions: { contains: vi.fn(async () => permission) },
    tabs: {
      query: vi.fn(async () => Array.from({ length: bindingTabCount }, (_, index) => ({ id: 7 + index, url: bridgeConfig.bindingUrl }))),
      get: vi.fn(async () => ({ id: 7, url: currentUrl })),
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
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const payload = JSON.parse(options.body);
    reports.push({ payload, headers: options.headers });
    if (holdReadyReport && payload.realm === 'background' && payload.phase === 'ready') {
      await new Promise(resolve => { releaseReadyReport = resolve; });
    }
    return { ok: true, json: async () => ({ v: 1, runId: payload.runId, seq: payload.seq, accepted: true }) };
  }));
  const importEntry = vi.fn(async () => {
    if (importFails) throw new Error('do not expose raw error');
  });
  const sender = { id: browser.runtime.id, tab: { id: 7 }, frameId: 0, url: bridgeConfig.fixtureUrl, origin: new URL(bridgeConfig.fixtureUrl).origin, documentId: 'doc-1' };
  return {
      browser, reports, sender, importEntry, bridgeConfig,
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

describe('Firefox runtime bridge protocol', () => {
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
      const type = responses.shift();
      return { action: '__PAGE_TRANSLATION_RUNTIME_PROBE_V1', v: 1, runId: config.runId, type, ...(message.nonce ? { nonce: message.nonce } : type !== 'accepted' ? { nonce } : {}) };
    }) } });
    const importEntry = vi.fn(async () => {
      window.translateItContentCore = { initialized: true };
      window.__firefoxProbeStartup = { complete: true, success: true };
      window.__pageTranslationBenchmark = {
        featureState: () => ({ initialized: true, active: true, listenerActive: true, handlerActive: true, handlerIsActive: true }),
        discoveryFlags: flags,
      };
    });

    await installContentProbe({ runId: config.runId, fixtureUrl }, importEntry);

    expect(importEntry).toHaveBeenCalledOnce();
    expect(messages.map(message => message.type)).toEqual(['hello', 'loaded', 'ready', 'ack-received', 'content-ready']);
    expect(messages.at(-1)).toMatchObject({ checks, flags, ackReceived: true });
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
        discoveryFlags: flags,
      };
    });

    expect(lateWrongNonce.type).toBe('error');
    expect(lateWrongSender.code).toBe('SENDER_REJECTED');
    expect(messages.map(message => message.type)).toEqual(['hello', 'loaded', 'ready', 'ack-received', 'content-ready', 'error']);
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'PROTOCOL_REJECTED' });
    expect(bridge.reports.map(item => [item.payload.seq, item.payload.realm, item.payload.phase, item.payload.evidence.code ?? null])).toEqual([
      [1, 'background', 'bootstrap', null], [2, 'background', 'loaded', null], [3, 'background', 'ready', null],
      [4, 'content', 'loaded', null], [5, 'content', 'ready', null], [6, 'content', 'error', 'PROTOCOL_REJECTED'],
    ]);

    const duplicate = await bridge.message(messages.at(-1), bridge.sender);
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

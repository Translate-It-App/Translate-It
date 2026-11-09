import { proxyManager } from '../../../src/shared/proxy/ProxyManager.js';
import { createEdgeProviderProbe } from '../page-translation-e2e-benchmark/provider-probe.mjs';
import { PROVIDER_ONLY_DEADLINE_MS } from './runtime-constants.mjs';

const ACTION = '__PAGE_TRANSLATION_RUNTIME_PROBE_V1';
const PROVIDER_ACTION = '__PAGE_TRANSLATION_PROVIDER_PROBE_V1';
const VERSION = 1;
const DEADLINE_MS = 15_000;
const REPORT_TIMEOUT_MS = 3_000;
const ERRORS = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);
const PROVIDER_CODES = new Set(['INTERCEPTION_UNSUPPORTED', 'BODY_UNSUPPORTED', 'INVALID_BODY', 'PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'COMPLETED']);

export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && actual.every(key => keys.includes(key));
}

export function validateProbeEnvelope(message, runId, type, keys) {
  return exactKeys(message, ['action', 'v', 'runId', 'type', ...keys])
    && message.action === ACTION && message.v === VERSION && message.runId === runId && message.type === type;
}

export function validateSender(sender, browser, tabId, fixtureUrl, navigationGeneration, expectedGeneration = 1) {
  if (sender?.id !== browser.runtime.id || sender?.tab?.id !== tabId || sender?.frameId !== 0 || sender?.url !== fixtureUrl || navigationGeneration !== expectedGeneration) return false;
  const origin = new URL(fixtureUrl).origin;
  if (sender.origin !== undefined && sender.origin !== null && sender.origin !== origin) return false;
  return true;
}

export async function installBackgroundProbe(config, importEntry) {
  const { browser } = globalThis;
  if (!browser?.runtime?.onMessage || !config?.authToken) return;
  const state = {
    phase: 'bootstrap', tabId: null, generation: 0, nonce: randomToken(), seq: 0, reporting: Promise.resolve(), startupEntryImported: false,
      provider: { seq: 0, reporting: Promise.resolve(), armed: false, terminal: false, errorReported: false, stopping: false, invocations: new Set(), attempts: new Map() },
  };
  const extensionUrl = new URL(browser.runtime.getURL(''));
  if (extensionUrl.protocol !== 'moz-extension:' || !extensionUrl.host) return;
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  const onCommitted = details => {
    if (details.frameId !== 0) return;
    if (details.tabId === state.tabId && details.url === config.fixtureUrl && state.generation === 0 && ['ready-pending', 'ready'].includes(state.phase)) {
      state.generation = 1;
      state.documentId = details.documentId ?? null;
      return;
    }
    if (details.tabId === state.tabId) state.invalidNavigation = true;
  };
  browser.webNavigation.onCommitted.addListener(onCommitted);
  browser.tabs.onRemoved?.addListener(tabId => {
    if (tabId === state.tabId) state.tabRemoved = true;
  });
  const listener = (message, sender) => {
    if (message?.action === PROVIDER_ACTION) {
      const isInvoke = message.type === 'invoke';
      return withDeadline(onProviderProbeMessage(message, sender, config, browser, state), isInvoke ? PROVIDER_ONLY_DEADLINE_MS : REPORT_TIMEOUT_MS, isInvoke ? 'TIMEOUT' : 'PROTOCOL_ERROR')
        .catch(async error => {
          const code = isInvoke && state.provider.armed && error?.message === 'TIMEOUT' ? 'TIMEOUT' : 'PROTOCOL_ERROR';
          if (isInvoke && state.provider.armed && !state.provider.errorReported) {
            await reportProviderOperation(config, state, 'error', { code });
            state.provider.terminal = true;
          }
          return providerResponse(config, state, 'error', { code });
        });
    }
    if (message?.action !== ACTION) return false;
    return withDeadline(onProbeMessage(message, sender, config, browser, state), REPORT_TIMEOUT_MS)
      .catch(() => failRuntime(config, state, 'HANDSHAKE_FAILED').then(() => protocolError(config, state, message, 'HANDSHAKE_FAILED')));
  };
  browser.runtime.onMessage.addListener(listener);
  void pinInitialBindingTab(config, browser, state, extensionOrigin, importEntry);
}

async function pinInitialBindingTab(config, browser, state, extensionOrigin, importEntry) {
  try {
    const tabs = await withDeadline(browser.tabs.query({}), REPORT_TIMEOUT_MS, 'BINDING_FAILED');
    const matches = Array.isArray(tabs) ? tabs.filter(tab => tab?.url === config.bindingUrl) : [];
    if (state.phase !== 'bootstrap' || matches.length !== 1 || !Number.isSafeInteger(matches[0]?.id)) throw codeError('BINDING_FAILED');
    state.tabId = matches[0].id;
    state.startupStarted = true;
    void beginBackground(config, browser, state, extensionOrigin, importEntry);
  } catch (error) {
    await failRuntime(config, state, error?.message === 'BINDING_FAILED' ? 'BINDING_FAILED' : 'BINDING_FAILED');
  }
}

async function beginBackground(config, browser, state, extensionOrigin, importEntry) {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const tab = await browser.tabs.get(state.tabId);
    if (tab.url !== config.bindingUrl || state.invalidNavigation || state.tabRemoved) throw codeError('BINDING_FAILED');
    const permissions = await browser.permissions.contains({ origins: ['http://127.0.0.1/*'] });
    if (!permissions) throw codeError('PERMISSION_DENIED');
    await report(config, state, 'background', 'bootstrap', { extensionId: browser.runtime.id, extensionOrigin, tabId: state.tabId });
    globalThis.__firefoxProviderProbeEnabled = true;
    globalThis.__firefoxProviderProbeRuntime = {
      createEdgeProviderProbe,
      proxyManager,
      report: (event, evidence) => reportProviderOperation(config, state, event, evidence),
    };
    if (config.pageTranslationE2E === true) {
      await browser.storage.local.set({ PROVIDER_OPTIMIZATION_LEVELS: { edge: 5 } });
    }
    try { await withDeadline(importEntry(), Math.max(1, deadline - Date.now()), 'READINESS_TIMEOUT'); state.startupEntryImported = true; }
    catch (error) { throw error?.message === 'READINESS_TIMEOUT' ? error : codeError('IMPORT_FAILED'); }
    await report(config, state, 'background', 'loaded', { entry: 'src/core/background/index.js' });
    let checks;
    while (Date.now() < deadline) {
      checks = getBackgroundReadinessChecks();
      if (Object.values(checks).every(Boolean)) break;
      if (globalThis.__firefoxProbeStartup?.complete && !globalThis.__firefoxProbeStartup.success) throw codeError('STARTUP_FAILED');
      await sleep(50);
    }
    if (!checks || !Object.values(checks).every(Boolean)) throw codeError('READINESS_TIMEOUT');
    state.phase = 'ready-pending';
    await report(config, state, 'background', 'ready', { checks, hostPermission: true });
    if (state.phase === 'ready-pending') state.phase = 'ready';
  } catch (error) {
    await failRuntime(config, state, ERRORS.has(error?.message) ? error.message : 'STARTUP_FAILED');
  }
}

function providerResponse(config, state, type, detail = {}) {
  const nonce = state.handshakeStarted && detail.nonce === undefined ? { nonce: state.nonce } : {};
  return { action: PROVIDER_ACTION, v: VERSION, runId: config.runId, type, ...nonce, ...detail };
}

async function reportProviderOperation(config, state, event, evidence) {
  const provider = state.provider;
  if (event === 'error' && provider.errorReported) return false;
  const admittedSettlement = event === 'physical-settled' && provider.attempts.has(evidence?.attemptId) && !provider.attempts.get(evidence.attemptId);
  const admittedProviderSettlement = event === 'provider-settled' && provider.invocations.has(evidence?.invocationId);
  const admittedFailure = event === 'command-result' && evidence?.success === false && provider.armed;
  if (provider.seq >= 65 || provider.terminal && event !== 'error' && !admittedSettlement && !admittedProviderSettlement && !admittedFailure
      || provider.stopping && event !== 'error' && !admittedSettlement && !admittedProviderSettlement && !admittedFailure) return false;
  const opSeq = ++provider.seq;
  if (event === 'provider-invoked') provider.invocations.add(evidence.invocationId);
  if (event === 'error') provider.errorReported = true;
  if (event === 'physical-start') provider.attempts.set(evidence.attemptId, false);
  if (event === 'physical-settled') provider.attempts.set(evidence.attemptId, true);
  const payload = { v: VERSION, runId: config.runId, op: 'edge-fr-page-once', opSeq, event, evidence };
  let acceptedReceipt;
  provider.reporting = provider.reporting.then(async () => {
    const response = await fetch(config.reportUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    const receipt = await response.json();
    const gated = event === 'armed' || event === 'translated';
    const keys = gated ? ['v', 'runId', 'op', 'opSeq', 'accepted', 'decision'] : ['v', 'runId', 'op', 'opSeq', 'accepted'];
    const decisions = event === 'armed' ? ['start', 'stop'] : ['restore', 'stop'];
    if (!response.ok || !exactKeys(receipt, keys) || receipt.v !== VERSION || receipt.runId !== config.runId
        || receipt.op !== 'edge-fr-page-once' || receipt.opSeq !== opSeq || receipt.accepted !== true
        || (gated && !decisions.includes(receipt.decision))) throw codeError('REPORT_FAILED');
    acceptedReceipt = receipt;
  }).catch(() => { throw codeError('REPORT_FAILED'); });
  return provider.reporting.then(() => {
    if (event === 'error') provider.terminal = true;
    return acceptedReceipt;
  }, () => null);
}

async function providerOperationFailure(config, state, code) {
  const accepted = await reportProviderOperation(config, state, 'error', { code });
  return accepted
    ? providerResponse(config, state, 'accepted', { nonce: state.nonce })
    : providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
}

async function onProviderProbeMessage(message, sender, config, browser, state) {
  const arm = message?.type === 'arm';
  const stop = message?.type === 'stop';
  const event = message?.type === 'event';
  const keys = arm ? ['action', 'v', 'runId', 'type', 'nonce', 'observersInstalled']
    : stop ? ['action', 'v', 'runId', 'type', 'nonce', 'code']
      : event ? ['action', 'v', 'runId', 'type', 'nonce', 'event', 'evidence']
        : message?.type === 'invoke' ? ['action', 'v', 'runId', 'type', 'nonce', 'texts', 'sessionId', 'messageId'] : [];
  if (!keys.length || !exactKeys(message, keys) || message.action !== PROVIDER_ACTION || message.v !== VERSION
      || message.runId !== config.runId || !state.handshakeStarted || message.nonce !== state.nonce) {
    return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
  }
  if (!validateSender(sender, browser, state.tabId, config.fixtureUrl, state.generation) || !sameSender(state.sender, senderEvidence(sender))) {
    return providerResponse(config, state, 'error', { code: 'SENDER_REJECTED' });
  }
  if (!await validateCurrentContext(browser, config, state, sender, 'complete') || state.phase !== 'complete') {
    return arm ? rejectProviderArm(config, state, 'PROTOCOL_ERROR') : providerOperationFailure(config, state, 'PROTOCOL_ERROR');
  }
  if (arm) {
    if (state.provider.armed) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
     if (message.observersInstalled !== true) return rejectProviderArm(config, state, 'PROTOCOL_ERROR');
    const hasPermission = await browser.permissions.contains({ origins: ['https://edge.microsoft.com/*'] });
    if (!await providerContextIsCurrent(sender, browser, config, state)) return rejectProviderArm(config, state, 'PROTOCOL_ERROR');
    const providerProbe = globalThis.__pageTranslationBenchmark?.providerProbe;
     if (!hasPermission || globalThis.__pageTranslationBenchmark?.providerProbeInstalled !== true || providerProbe?.proxyDisabled?.() !== true) {
       return rejectProviderArm(config, state, 'PROTOCOL_ERROR');
    }
    providerProbe.arm();
    const evidence = { sender: senderEvidence(sender), navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true };
    const receipt = await reportProviderOperation(config, state, 'armed', evidence);
    if (!receipt) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
    if (receipt.decision === 'stop') {
      state.provider.stopping = true;
      providerProbe.stop();
      return providerResponse(config, state, 'armed-ack', { nonce: state.nonce, decision: 'stop' });
    }
    const permissionAfterGate = await browser.permissions.contains({ origins: ['https://edge.microsoft.com/*'] });
    if (receipt.decision !== 'start' || !permissionAfterGate || !await providerContextIsCurrent(sender, browser, config, state)
        || globalThis.__pageTranslationBenchmark?.providerProbe !== providerProbe || providerProbe.proxyDisabled?.() !== true) {
      return rejectProviderArm(config, state, 'PROTOCOL_ERROR');
    }
    state.provider.armed = true;
    return providerResponse(config, state, 'armed-ack', { nonce: state.nonce, decision: 'start' });
  }
  if (stop) {
    if (!PROVIDER_CODES.has(message.code)) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
    state.provider.stopping = true;
    globalThis.__pageTranslationBenchmark?.providerProbe?.abortProviderOnly?.();
    globalThis.__pageTranslationBenchmark?.providerProbe?.stop?.();
    return providerResponse(config, state, 'accepted', { nonce: state.nonce });
  }
  if (message.type === 'invoke') {
      if (config.providerOnly !== true || !state.provider.armed || state.provider.terminal || state.provider.invocations.size
          || !exactKeys(message, ['action', 'v', 'runId', 'type', 'nonce', 'texts', 'sessionId', 'messageId'])
          || !Array.isArray(message.texts) || message.texts.length !== 12
          || message.texts.some((text, index) => text !== `Benchmark sentence ${index + 1} has stable fixture content.`)
          || message.sessionId !== `${config.runId}-provider-session` || message.messageId !== `${config.runId}-provider-message`) {
        return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
      }
      const providerProbe = globalThis.__pageTranslationBenchmark?.providerProbe;
      try {
        await globalThis.__pageTranslationBenchmark.invokeProviderOnly(message.texts, { sessionId: message.sessionId, messageId: message.messageId });
        providerProbe.stop();
        state.provider.terminal = true;
        return providerResponse(config, state, 'provider-complete', { nonce: state.nonce });
      } catch (error) {
        const code = ['TIMEOUT', 'TEARDOWN', 'INVALID_BODY', 'PROTOCOL_ERROR'].includes(error?.code) ? error.code : 'PROTOCOL_ERROR';
        await reportProviderOperation(config, state, 'error', { code });
        state.provider.terminal = true;
        return providerResponse(config, state, 'error', { code });
      }
  }
  if (event && message.event === 'error') {
    if (!exactKeys(message.evidence, ['code']) || !PROVIDER_CODES.has(message.evidence.code)) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
    const accepted = await reportProviderOperation(config, state, 'error', message.evidence);
    state.provider.terminal = true;
    return accepted ? providerResponse(config, state, 'accepted', { nonce: state.nonce }) : providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
  }
  if (event && message.event === 'scheduler-batch') {
    if (config.pageTranslationE2E !== true || !state.provider.armed || state.provider.terminal) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
    const accepted = await reportProviderOperation(config, state, 'scheduler-batch', message.evidence);
    return accepted ? providerResponse(config, state, 'accepted', { nonce: state.nonce }) : providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
  }
  if (!event || !state.provider.armed || state.provider.terminal || !['command-result', 'translated', 'restored'].includes(message.event)) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
  const accepted = await reportProviderOperation(config, state, message.event, message.evidence);
  if (!accepted) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
  if (message.event === 'translated') {
    if (!['restore', 'stop'].includes(accepted.decision)) return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
    if (accepted.decision === 'stop') {
      state.provider.stopping = true;
      globalThis.__pageTranslationBenchmark?.providerProbe?.stop?.();
    }
    if (accepted.decision === 'restore' && !await providerContextIsCurrent(sender, browser, config, state)) {
      await reportProviderOperation(config, state, 'error', { code: 'PROTOCOL_ERROR' });
      state.provider.terminal = true;
      state.provider.stopping = true;
      return providerResponse(config, state, 'accepted', { nonce: state.nonce, decision: 'stop' });
    }
    return providerResponse(config, state, 'accepted', { nonce: state.nonce, decision: accepted.decision });
  }
   if (!await providerContextIsCurrent(sender, browser, config, state)) {
     await reportProviderOperation(config, state, 'error', { code: 'PROTOCOL_ERROR' });
     state.provider.terminal = true;
     state.provider.stopping = true;
     globalThis.__pageTranslationBenchmark?.providerProbe?.stop?.();
     return providerResponse(config, state, 'error', { code: 'PROTOCOL_ERROR' });
   }
   if (message.event === 'restored') state.provider.terminal = true;
  return providerResponse(config, state, 'accepted', { nonce: state.nonce });
}

async function providerContextIsCurrent(sender, browser, config, state) {
  return state.phase === 'complete' && validateSender(sender, browser, state.tabId, config.fixtureUrl, state.generation)
    && sameSender(state.sender, senderEvidence(sender))
    && await validateCurrentContext(browser, config, state, sender, 'complete');
}

async function rejectProviderArm(config, state, code) {
  await providerOperationFailure(config, state, code);
  state.provider.stopping = true;
  globalThis.__pageTranslationBenchmark?.providerProbe?.stop?.();
  return providerResponse(config, state, 'armed-ack', { nonce: state.nonce, decision: 'stop' });
}

async function failRuntime(config, state, code, realm = 'background') {
  if (state.phase === 'failed') return false;
  if (state.phase === 'complete') {
    if (realm !== 'content' || state.lateContentErrorReported || state.seq >= 6) return false;
    state.lateContentErrorReported = true;
  }
  state.phase = 'failed';
  if (!ERRORS.has(code)) code = 'PROTOCOL_REJECTED';
  try { await report(config, state, realm, 'error', { code }); return true; }
  catch { return false; }
}

export function getBackgroundReadinessChecks() {
  const service = globalThis.backgroundService;
  const engine = service?.translationEngine;
  const unified = globalThis.__pageTranslationBenchmark?.unifiedTranslationService ?? globalThis.unifiedTranslationService;
  return {
    lifecycleInitialized: service?.initialized === true,
    translationEngineInitialized: service?._translationEngineInitialized === true,
    enginePresent: !!engine,
    unifiedEngineMatches: !!engine && unified?.translationEngine === engine,
    unifiedServiceMatches: !!service && unified?.backgroundService === service,
    messageListenerActive: service?.messageHandler?.isListenerActive === true,
    startupComplete: globalThis.__firefoxProbeStartup?.complete === true && globalThis.__firefoxProbeStartup?.success === true,
  };
}

async function onProbeMessage(message, sender, config, browser, state) {
  if (message?.action !== ACTION) return false;
  const error = code => protocolError(config, state, message, code);
  const expectedKeys = message.type === 'hello' ? ['action', 'v', 'runId', 'type']
    : message.type === 'loaded' ? ['action', 'v', 'runId', 'type', 'nonce', 'entry']
      : message.type === 'ready' ? ['action', 'v', 'runId', 'type', 'nonce', 'checks', 'flags']
        : message.type === 'ack-received' ? ['action', 'v', 'runId', 'type', 'nonce', 'ack']
          : message.type === 'content-ready' ? ['action', 'v', 'runId', 'type', 'nonce', 'checks', 'flags', 'ackReceived']
            : message.type === 'error' ? (message.nonce === undefined ? ['action', 'v', 'runId', 'type', 'code'] : ['action', 'v', 'runId', 'type', 'nonce', 'code']) : [];
  if (!expectedKeys.length || !validateProbeEnvelope(message, config.runId, message.type, expectedKeys.filter(key => !['action', 'v', 'runId', 'type'].includes(key)))) return false;
  if (!validateSender(sender, browser, state.tabId, config.fixtureUrl, state.generation)) return response(config, 'error', { code: 'SENDER_REJECTED' });
  if (state.invalidNavigation || state.tabRemoved) {
    await failRuntime(config, state, 'NAVIGATION_INVALID');
    return error('NAVIGATION_INVALID');
  }
  const expectedPhase = state.phase;
  const preChallengeError = message.type === 'error' && !state.handshakeStarted && message.nonce === undefined;
  if (preChallengeError && message.code !== 'HANDSHAKE_FAILED') return error('PROTOCOL_REJECTED');
  if (message.type === 'hello' && (!['ready', 'ready-pending'].includes(expectedPhase) || state.handshakeStarted)) return error('HANDSHAKE_FAILED');
  if (message.type !== 'hello' && !preChallengeError && (message.nonce !== state.nonce || !state.handshakeStarted)) return error('PROTOCOL_REJECTED');
  if (message.type === 'loaded' && expectedPhase !== 'challenge') return error('PROTOCOL_REJECTED');
  if (message.type === 'ready' && expectedPhase !== 'loaded') return error('PROTOCOL_REJECTED');
  if (message.type === 'ack-received' && expectedPhase !== 'ready-ack') return error('PROTOCOL_REJECTED');
  if (message.type === 'content-ready' && expectedPhase !== 'confirmed') return error('PROTOCOL_REJECTED');
  if (message.type === 'error' && !ERRORS.has(message.code)) return error('PROTOCOL_REJECTED');
  if (message.type === 'hello') state.phase = 'checking-hello';
  else state.phase = `checking-${message.type}`;
  const reservedPhase = state.phase;
  if (!await validateCurrentContext(browser, config, state, sender, reservedPhase)) {
    await failRuntime(config, state, 'NAVIGATION_INVALID');
    return error('NAVIGATION_INVALID');
  }
  state.phase = expectedPhase;
  if (message.type === 'error') {
    const reported = await failRuntime(config, state, message.code, 'content');
    return reported
      ? response(config, 'accepted', { ...(message.nonce === state.nonce ? { nonce: state.nonce } : {}) })
      : error('REPORT_FAILED');
  }
  if (message.type === 'hello') {
    state.handshakeStarted = true;
    state.sender = senderEvidence(sender);
    state.phase = 'challenge';
    return response(config, 'challenge', { nonce: state.nonce });
  }
  if (message.type !== 'hello' && !sameSender(state.sender, senderEvidence(sender))) return error('SENDER_REJECTED');
  if (message.type === 'loaded' && state.phase === 'challenge' && message.entry === 'src/core/content-scripts/index-main.js') {
    state.phase = 'reporting-loaded';
    await report(config, state, 'content', 'loaded', { entry: message.entry, sender: senderEvidence(sender), navigationGeneration: 1 });
    if (!await validateCurrentContext(browser, config, state, sender, 'reporting-loaded') || !sameSender(state.sender, senderEvidence(sender))) {
      await failRuntime(config, state, 'NAVIGATION_INVALID');
      return error('NAVIGATION_INVALID');
    }
    state.phase = 'loaded';
    return response(config, 'loaded-ack', { nonce: state.nonce });
  }
  if (message.type === 'ready' && state.phase === 'loaded') {
    const checks = getBackgroundReadinessChecks();
    if (!Object.values(checks).every(Boolean) || !validContentReadiness(message)) return error('STARTUP_FAILED');
    state.phase = 'ready-ack';
    return response(config, 'ready-ack', { nonce: state.nonce });
  }
  if (message.type === 'ack-received' && state.phase === 'ready-ack') {
    if (message.ack !== 'ready-ack') return error('PROTOCOL_REJECTED');
    state.phase = 'confirmed';
    return response(config, 'confirmed', { nonce: state.nonce });
  }
  if (message.type === 'content-ready' && state.phase === 'confirmed' && message.ackReceived === true) {
    if (!validContentReadiness(message)) return error('PROTOCOL_REJECTED');
    state.phase = 'reporting-content-ready';
    await report(config, state, 'content', 'ready', { checks: message.checks, flags: message.flags, sender: senderEvidence(sender), navigationGeneration: 1, ackReceived: true });
    if (!await validateCurrentContext(browser, config, state, sender, 'reporting-content-ready') || !sameSender(state.sender, senderEvidence(sender))) {
      await failRuntime(config, state, 'NAVIGATION_INVALID');
      return error('NAVIGATION_INVALID');
    }
    state.phase = 'complete';
    return response(config, 'accepted', { nonce: state.nonce });
  }
  return error('PROTOCOL_REJECTED');
}

async function validateCurrentContext(browser, config, state, sender, phase) {
  const [frame, tab] = await Promise.all([
    withDeadline(browser.webNavigation.getFrame({ tabId: state.tabId, frameId: 0 }), REPORT_TIMEOUT_MS),
    withDeadline(browser.tabs.get(state.tabId), REPORT_TIMEOUT_MS),
  ]);
  const documents = [state.documentId, frame?.documentId, sender.documentId].filter(value => typeof value === 'string' && value.length > 0);
  return state.phase === phase && !state.invalidNavigation && !state.tabRemoved && state.generation === 1
    && tab?.url === config.fixtureUrl && frame?.url === config.fixtureUrl && new Set(documents).size <= 1;
}

function response(config, type, data = {}) { return { action: ACTION, v: VERSION, runId: config.runId, type, ...data }; }
function protocolError(config, state, message, code) {
  const nonce = state.handshakeStarted && message?.nonce === state.nonce ? state.nonce : undefined;
  return response(config, 'error', { code, ...(nonce ? { nonce } : {}) });
}
function validContentReadiness(message) {
  return exactKeys(message.checks, ['coreInitialized', 'listenerActive', 'featureManagerInitialized', 'handlerActive', 'handlerIsActive'])
    && Object.values(message.checks).every(value => value === true)
    && exactKeys(message.flags, ['slicedDiscoveryEnabled', 'viewportFirstDiscoveryEnabled'])
    && message.flags.slicedDiscoveryEnabled === true && message.flags.viewportFirstDiscoveryEnabled === false;
}

function senderEvidence(sender) {
  return { id: sender.id, tabId: sender.tab.id, frameId: sender.frameId, url: sender.url, origin: sender.origin ?? null, documentId: sender.documentId ?? null };
}

function sameSender(left, right) {
  return exactKeys(left, ['id', 'tabId', 'frameId', 'url', 'origin', 'documentId'])
    && Object.keys(left).every(key => left[key] === right[key]);
}

async function report(config, state, realm, phase, evidence) {
  if (state.seq >= 6) throw codeError('REPORT_FAILED');
  const seq = ++state.seq;
  const payload = { v: VERSION, runId: config.runId, seq, realm, phase, evidence };
  state.reporting = state.reporting.then(async () => {
    const response = await fetch(config.reportUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    const receipt = await response.json();
    if (!response.ok || !exactKeys(receipt, ['v', 'runId', 'seq', 'accepted']) || receipt.v !== VERSION || receipt.runId !== config.runId || receipt.seq !== seq || receipt.accepted !== true) throw codeError('REPORT_FAILED');
  }).catch(() => { throw codeError('REPORT_FAILED'); });
  return state.reporting;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function codeError(code) { return Object.assign(new Error(code), { code }); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function withDeadline(promise, ms, code = 'HANDSHAKE_FAILED') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(codeError(code)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

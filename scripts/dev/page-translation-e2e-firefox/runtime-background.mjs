const ACTION = '__PAGE_TRANSLATION_RUNTIME_PROBE_V1';
const VERSION = 1;
const DEADLINE_MS = 15_000;
const REPORT_TIMEOUT_MS = 3_000;
const ERRORS = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);

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
  const state = { phase: 'bootstrap', tabId: null, generation: 0, nonce: randomToken(), seq: 0, reporting: Promise.resolve(), startupEntryImported: false };
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

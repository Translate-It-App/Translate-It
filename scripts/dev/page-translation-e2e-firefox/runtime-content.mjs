import { PROVIDER_ONLY_DEADLINE_MS } from './runtime-constants.mjs';

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
  try {
    const hello = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'hello' });
    if (!validResponse(hello, 'challenge', config.runId) || typeof hello.nonce !== 'string' || !/^[a-f\d]{64}$/i.test(hello.nonce)) throw coded('HANDSHAKE_FAILED');
    nonce = hello.nonce;
    window.__firefoxProviderProbeEnabled = true;
    try { await withDeadline(importEntry(), DEADLINE_MS, 'IMPORT_FAILED'); }
    catch { throw coded('IMPORT_FAILED'); }
    const loaded = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'loaded', nonce, entry: 'src/core/content-scripts/index-main.js' });
    expect(loaded, 'loaded-ack', config.runId, nonce);
    const checks = await waitContentReady();
    if (!checks) throw coded('READINESS_TIMEOUT');
    const trace = window.__pageTranslationBenchmark;
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
    await armProviderProbe(config, nonce, trace, () => {
      if (pageTranslateSent) return false;
      pageTranslateSent = true;
      return true;
    });
  } catch (error) {
    if (config.providerOnly === true && runtimeReadyAccepted) return;
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

async function armProviderProbe(config, nonce, trace, claimPageTranslate) {
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
    let productionRequest;
    try {
      productionRequest = globalThis.browser.runtime.sendMessage({ action: 'page-translate', context: 'content', data: { provider: 'edge', targetLanguage: 'fr' } });
    } catch {
      await sendEvent('error', { code: 'PROTOCOL_ERROR' }).catch(() => {});
      return;
    }
    void withDeadline(Promise.resolve(productionRequest), DEADLINE_MS, 'TIMEOUT')
      .catch(error => sendEvent('error', { code: PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR' }).catch(() => {}));
  } catch (error) {
    await sendEvent('error', { code: PROVIDER_CODES.has(error?.message) ? error.message : 'PROTOCOL_ERROR' }).catch(() => {});
    observer.disconnect?.();
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
  return send(message, data.type === 'invoke' ? PROVIDER_ONLY_DEADLINE_MS : 3000).then(response => {
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
    const timer = setTimeout(() => reject(coded(message.type === 'invoke' ? 'TIMEOUT' : 'READINESS_TIMEOUT')), timeoutMs);
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

const ACTION = '__PAGE_TRANSLATION_RUNTIME_PROBE_V1';
const VERSION = 1;
const DEADLINE_MS = 15_000;
const FLAGS = { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false };

export async function installContentProbe(config, importEntry) {
  if (location.href !== config.fixtureUrl || window !== window.top) return;
  let nonce;
  try {
    const hello = await send({ action: ACTION, v: VERSION, runId: config.runId, type: 'hello' });
    if (!validResponse(hello, 'challenge', config.runId) || typeof hello.nonce !== 'string' || !/^[a-f\d]{64}$/i.test(hello.nonce)) throw coded('HANDSHAKE_FAILED');
    nonce = hello.nonce;
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
  } catch (error) {
    const code = nonce && ERROR_CODES.has(error?.message) ? error.message : 'HANDSHAKE_FAILED';
    await notifyError(config.runId, code, nonce).catch(() => {});
  }
}

const ERROR_CODES = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);

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

function send(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(coded('READINESS_TIMEOUT')), 3000);
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

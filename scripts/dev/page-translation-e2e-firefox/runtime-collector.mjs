import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const LIMIT = 16 * 1024;
const phases = ['bootstrap', 'loaded', 'ready'];
const errorCodes = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const checks = value => exact(value, ['lifecycleInitialized', 'translationEngineInitialized', 'enginePresent', 'unifiedEngineMatches', 'unifiedServiceMatches', 'messageListenerActive', 'startupComplete']) && Object.values(value).every(item => item === true);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

function validOrigin(value) {
  if (typeof value !== 'string' || !/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === 'moz-extension:' && value === `moz-extension://${parsed.host}`;
}

function validateConfig({ runId, authToken, expectedExtensionId }) {
  if (typeof runId !== 'string' || !runId || typeof authToken !== 'string' || !/^[\da-f]{64,}$/i.test(authToken) || typeof expectedExtensionId !== 'string' || !expectedExtensionId) throw new TypeError('Invalid runtime bridge configuration');
}

function createCollector(options, fixtureUrl) {
  validateConfig(options);
  const { runId, authToken, expectedExtensionId } = options;
  const token = Buffer.from(authToken);
  let bindingOpen = true, admissionOpen = true, failed = false, pinnedOrigin, pinnedTab, pinnedSender;
  let seq = 0, accepted = 0;
  const reports = [], rejectionCounts = { unauthorized: 0, originOrType: 0, route: 0, malformed: 0, protocol: 0, bodyLimit: 0 };
  const reject = code => { rejectionCounts[code] = Math.min(1000, rejectionCounts[code] + 1); };
  const stages = { background: [], content: [] };
  const pending = new Set(), waiters = new Set();
  const failWaiters = error => { for (const waiter of waiters) waiter.reject(error); };
  const notify = () => {
    for (const waiter of waiters) {
      const report = reports.find(item => item.realm === waiter.realm && item.phase === waiter.phase);
      if (report) waiter.resolve(structuredClone(report));
    }
  };
  const terminal = code => {
    if (failed) return;
    failed = true; failureCode = code;
    failWaiters(new Error('Firefox runtime collector reached terminal failure'));
  };

  function sender(value) {
    return exact(value, ['id', 'tabId', 'frameId', 'url', 'origin', 'documentId']) && value.id === expectedExtensionId && value.tabId === pinnedTab && value.frameId === 0 && value.url === fixtureUrl && (value.origin === null || value.origin === new URL(fixtureUrl).origin) && (value.documentId === null || (typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= 256));
  }
  function valid(report) {
    if (!exact(report, ['v', 'runId', 'seq', 'realm', 'phase', 'evidence']) || report.v !== 1 || report.runId !== runId || report.seq !== seq + 1 || report.seq > 8 || accepted >= 8 || !['background', 'content'].includes(report.realm)) return false;
    const { realm, phase, evidence } = report;
    if (phase === 'error') return exact(evidence, ['code']) && errorCodes.has(evidence.code);
    const expectedStageIndex = realm === 'background' ? phases.indexOf(phase) : phases.indexOf(phase) - 1;
    if (!phases.includes(phase) || stages[realm].length !== expectedStageIndex) return false;
    if (realm === 'background') {
      if (phase === 'bootstrap') return exact(evidence, ['extensionId', 'extensionOrigin', 'tabId']) && evidence.extensionId === expectedExtensionId && validOrigin(evidence.extensionOrigin) && nonnegative(evidence.tabId);
      if (phase === 'loaded') return exact(evidence, ['entry']) && evidence.entry === 'src/core/background/index.js';
      return exact(evidence, ['checks', 'hostPermission']) && checks(evidence.checks) && evidence.hostPermission === true && stages.background.length === 2;
    }
    if (!stages.background.includes('ready')) return false;
    if (phase === 'loaded') return exact(evidence, ['entry', 'sender', 'navigationGeneration']) && evidence.entry === 'src/core/content-scripts/index-main.js' && sender(evidence.sender) && evidence.navigationGeneration === 1;
    const contentChecks = ['coreInitialized', 'listenerActive', 'featureManagerInitialized', 'handlerActive', 'handlerIsActive'];
    return exact(evidence, ['checks', 'flags', 'sender', 'navigationGeneration', 'ackReceived']) && exact(evidence.checks, contentChecks) && Object.values(evidence.checks).every(value => value === true) && exact(evidence.flags, ['slicedDiscoveryEnabled', 'viewportFirstDiscoveryEnabled']) && evidence.flags.slicedDiscoveryEnabled === true && evidence.flags.viewportFirstDiscoveryEnabled === false && sender(evidence.sender) && Object.keys(evidence.sender).every(key => evidence.sender[key] === pinnedSender?.[key]) && evidence.navigationGeneration === 1 && evidence.ackReceived === true && stages.content.includes('loaded');
  }

  async function handle(request, response, requestUrl) {
    const path = requestUrl.pathname;
    if (request.headers.host !== new URL(fixtureUrl).host) { reject('route'); response.writeHead(404).end(); return true; }
    if (path === `/__benchmark/bind/${encodeURIComponent(runId)}` && request.method === 'GET' && !requestUrl.search && bindingOpen) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>Benchmark runtime binding</title>'); return true;
    }
    if (path !== '/__benchmark/runtime') return false;
    if (!admissionOpen || failed || request.method !== 'POST' || requestUrl.search || requestUrl.username || requestUrl.password) { reject('route'); response.writeHead(failed || !admissionOpen ? 503 : 404).end(); return true; }
    const auth = request.headers.authorization ?? '';
    const supplied = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) { reject('unauthorized'); response.writeHead(401).end(); response.once('finish', () => request.destroy()); return true; }
    const done = new Promise(resolve => {
      let chunks = [], bytes = 0, ended = false;
      const timer = setTimeout(() => { finish(null); request.destroy(); }, 3000);
      const finish = data => { if (ended) return; ended = true; clearTimeout(timer); pending.delete(cancel); request.off('data', onData); request.off('end', onEnd); request.off('aborted', onAbort); request.off('close', onClose); request.off('error', onAbort); resolve(data); };
      const cancel = () => finish(null);
      const onData = chunk => { bytes += chunk.length; if (bytes > LIMIT) { finish(null); request.resume(); } else chunks.push(chunk); };
      const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
      const onAbort = () => finish(null);
      const onClose = () => { if (!request.complete) finish(null); };
      pending.add(cancel);
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('aborted', onAbort);
      request.once('close', onClose);
      request.once('error', onAbort);
    });
    const body = await done;
    if (!admissionOpen || failed) { reject('route'); if (!response.destroyed) response.writeHead(503).end(); return true; }
    if (body === null) { reject('bodyLimit'); if (!response.destroyed) { response.writeHead(413).end(); response.once('finish', () => request.destroy()); } return true; }
    let report;
    try { report = JSON.parse(body); } catch { reject('malformed'); terminal('PROTOCOL_REJECTED'); response.writeHead(400).end(); return true; }
    const origin = request.headers.origin;
    const firstBootstrap = report?.realm === 'background' && report?.phase === 'bootstrap' && pinnedOrigin === undefined;
    const firstError = report?.phase === 'error' && pinnedOrigin === undefined;
    if (request.headers['content-type']?.toLowerCase() !== 'application/json' || (origin !== undefined && (firstBootstrap ? origin !== report.evidence?.extensionOrigin : firstError ? !validOrigin(origin) : !validOrigin(origin) || origin !== pinnedOrigin))) {
      reject('originOrType'); response.writeHead(403).end(); return true;
    }
    if (!valid(report)) {
      reject('protocol');
      if (report && report.runId === runId) terminal('PROTOCOL_REJECTED');
      response.writeHead(400).end(); return true;
    }
    if (report.realm === 'background' && report.phase === 'bootstrap') { pinnedOrigin = report.evidence.extensionOrigin; pinnedTab = report.evidence.tabId; }
    if (report.realm === 'content' && report.phase === 'loaded') pinnedSender = structuredClone(report.evidence.sender);
    if (origin !== undefined && pinnedOrigin === undefined) pinnedOrigin = origin;
    seq = report.seq; accepted++; reports.push(structuredClone(report));
    if (report.phase === 'error') terminal(report.evidence.code);
    else stages[report.realm].push(report.phase);
    notify();
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ v: 1, runId, seq, accepted: true }));
    return true;
  }

  const bridge = {
    get bindingUrl() { return `${fixtureUrl}__benchmark/bind/${encodeURIComponent(runId)}`; },
    get reportUrl() { return `${fixtureUrl}__benchmark/runtime`; },
    snapshot() { return Object.freeze({ reports: structuredClone(reports), failure: failed ? { code: failureCode } : null, rejections: { ...rejectionCounts }, background: [...stages.background], content: [...stages.content], accepted }); },
    closeAdmission() {
      admissionOpen = false; bindingOpen = false;
      for (const cancel of pending) cancel();
      failWaiters(new Error('Firefox runtime collector admission is closed'));
    },
    async waitFor(realm, phase, { timeoutMs = 3000 } = {}) {
      if (!stages[realm] || !phases.includes(phase)) throw new TypeError('Unknown runtime stage');
      if (failed) throw new Error('Firefox runtime collector reached terminal failure');
      if (!admissionOpen) throw new Error('Firefox runtime collector admission is closed');
      const current = reports.find(item => item.realm === realm && item.phase === phase);
      if (current) return structuredClone(current);
      return await new Promise((resolve, rejectPromise) => {
        const waiter = { realm, phase, resolve: value => { clearTimeout(timer); waiters.delete(waiter); resolve(value); }, reject: error => { clearTimeout(timer); waiters.delete(waiter); rejectPromise(error); } };
        const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for ${realm}:${phase}`)), timeoutMs);
        waiters.add(waiter);
      });
    },
    async drain({ timeoutMs = 1000 } = {}) {
      bridge.closeAdmission();
      const server = bridge.server;
      if (!server) return pending.size === 0;
      server.closeAllConnections?.();
      for (const socket of bridge.sockets ?? []) socket.destroy();
      if (!server.listening) return pending.size === 0;
      let timer;
      return await Promise.race([new Promise(resolve => server.close(() => { clearTimeout(timer); resolve(true); })), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    },
    async _handle(...args) {
      try { return await handle(...args); }
      catch { terminal('PROTOCOL_REJECTED'); throw new Error('Firefox runtime collector request failed'); }
    },
    _attach(server, sockets) { bridge.server = server; bridge.sockets = sockets; },
  };
  let failureCode = null;
  return bridge;
}

export function createRuntimeCollector(options, fixtureUrl) { return createCollector(options, fixtureUrl); }
export function validateRuntimeBridgeConfig(options) { validateConfig(options); }

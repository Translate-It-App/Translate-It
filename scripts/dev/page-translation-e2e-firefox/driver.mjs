import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyTransportRequest } from '../page-translation-e2e-benchmark/metrics.mjs';
import { blockRuntimeBridgePrerequisite, capability, classifyObservedRealm, classifyRequestAction, isolationSnapshot, notTested, requiredCapabilities, retainExecutedCapability, runtimeProbeGate } from './capabilities.mjs';

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const privateHeaderName = /authorization|cookie|token|secret|password/i;
const runtimeBridgeErrorCodes = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);
export function sanitizePrivate(value, secrets = []) {
  if (typeof value === 'string') return secrets.flatMap(secret => privateVariants(secret)).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => sanitizePrivate(item, secrets));
  if (!value || typeof value !== 'object') return value;
  const isSensitiveHeader = typeof value.name === 'string' && privateHeaderName.test(value.name);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = privateHeaderName.test(key) || (isSensitiveHeader && key === 'value')
      ? '[REDACTED]'
      : sanitizePrivate(item, secrets);
  }
  return result;
}

function privateVariants(secret) {
  if (typeof secret !== 'string' || !secret.length) return [];
  return [...new Set([secret, encodeURIComponent(secret), encodeURI(secret)])];
}

function containsPrivateSecret(value, secrets) {
  return secrets.flatMap(secret => privateVariants(secret)).some(secret => value.includes(secret));
}

function sanitizeError(error, secrets = []) {
  const safe = new Error(sanitizePrivate(error?.message ?? String(error), secrets));
  if (error?.code !== undefined) safe.code = error.code;
  if (error?.method !== undefined) safe.method = error.method;
  return safe;
}

export function validateRuntimeBridgeReport(report, { runId, sequence, realm, phase, extensionId, fixtureUrl, tabId, priorSender = null }) {
  if (!report || typeof report !== 'object' || report.v !== 1 || report.runId !== runId || report.seq !== sequence || report.realm !== realm || report.phase !== phase || !report.evidence || typeof report.evidence !== 'object') {
    throw new Error(`Runtime bridge report rejected: invalid v/run/sequence/realm/phase envelope for ${realm}.${phase}.`);
  }
  const evidence = report.evidence;
  if (realm === 'background' && phase === 'bootstrap') {
    const canonicalOrigin = typeof evidence.extensionOrigin === 'string' && /^moz-extension:\/\/[^/?#]+$/.test(evidence.extensionOrigin);
    if (evidence.extensionId !== extensionId || !canonicalOrigin || !Number.isSafeInteger(evidence.tabId)) throw new Error('Runtime bridge background bootstrap evidence is invalid.');
    return { v: 1, runId, seq: sequence, realm, phase, evidence: { extensionId, extensionOrigin: evidence.extensionOrigin, tabId: evidence.tabId } };
  }
  if (realm === 'background' && phase === 'loaded') {
    if (evidence.entry !== 'src/core/background/index.js') throw new Error('Runtime bridge background entry marker mismatch.');
    return { v: 1, runId, seq: sequence, realm, phase, evidence: { entry: evidence.entry } };
  }
  if (realm === 'background' && phase === 'ready') {
    const requiredChecks = ['lifecycleInitialized', 'translationEngineInitialized', 'enginePresent', 'unifiedEngineMatches', 'unifiedServiceMatches', 'messageListenerActive', 'startupComplete'];
    const checks = Object.fromEntries(requiredChecks.map(name => [name, evidence.checks?.[name] === true]));
    if (requiredChecks.some(name => checks[name] !== true) || evidence.hostPermission !== true) throw new Error('Runtime bridge background readiness checks or host permission failed.');
    return { v: 1, runId, seq: sequence, realm, phase, evidence: { checks, hostPermission: true } };
  }
  if (realm === 'content' && phase === 'loaded') {
    const sender = normalizeSender(evidence.sender, { extensionId, fixtureUrl, tabId, priorSender });
    if (evidence.entry !== 'src/core/content-scripts/index-main.js' || evidence.navigationGeneration !== 1) throw new Error('Runtime bridge content entry/navigation evidence mismatch.');
    return { v: 1, runId, seq: sequence, realm, phase, evidence: { entry: evidence.entry, sender, navigationGeneration: 1 } };
  }
  if (realm === 'content' && phase === 'ready') {
    const sender = normalizeSender(evidence.sender, { extensionId, fixtureUrl, tabId, priorSender });
    const requiredChecks = ['coreInitialized', 'listenerActive', 'featureManagerInitialized', 'handlerActive', 'handlerIsActive'];
    const checks = Object.fromEntries(requiredChecks.map(name => [name, evidence.checks?.[name] === true]));
    const flags = evidence.flags;
    if (requiredChecks.some(name => !checks[name]) || flags?.slicedDiscoveryEnabled !== true || flags?.viewportFirstDiscoveryEnabled !== false || evidence.navigationGeneration !== 1 || evidence.ackReceived !== true) {
      throw new Error('Runtime bridge content readiness, discovery flags, navigation generation, or acknowledgment failed.');
    }
    return { v: 1, runId, seq: sequence, realm, phase, evidence: { checks, flags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }, sender, navigationGeneration: 1, ackReceived: true } };
  }
  throw new Error(`Unexpected runtime bridge report phase: ${realm}.${phase}.`);
}

export function validateRuntimeBridgeErrorReport(report, { runId, sequence }) {
  if (!report || typeof report !== 'object' || report.v !== 1 || report.runId !== runId || report.seq !== sequence
      || !['background', 'content'].includes(report.realm) || report.phase !== 'error'
      || !report.evidence || typeof report.evidence !== 'object' || Object.keys(report.evidence).sort().join(',') !== 'code'
      || !runtimeBridgeErrorCodes.has(report.evidence.code)) {
    throw new Error('Runtime bridge terminal error report is invalid.');
  }
  return { v: 1, runId, seq: sequence, realm: report.realm, phase: 'error', evidence: { code: report.evidence.code } };
}

function normalizeSender(sender, { extensionId, fixtureUrl, tabId, priorSender }) {
  const validOrigin = sender?.origin === null || sender?.origin === new URL(fixtureUrl).origin;
  const exactSenderKeys = ['id', 'tabId', 'frameId', 'url', 'origin', 'documentId'].sort().join(',');
  if (!sender || Object.keys(sender).sort().join(',') !== exactSenderKeys || sender.id !== extensionId || sender.tabId !== tabId || sender.frameId !== 0 || sender.url !== fixtureUrl || !validOrigin
      || (sender.documentId != null && (typeof sender.documentId !== 'string' || sender.documentId.length === 0))) {
    throw new Error('Runtime bridge content sender is not the pinned extension top frame at the fixture URL.');
  }
  const normalized = { id: sender.id, tabId: sender.tabId, frameId: 0, url: sender.url, origin: sender.origin, documentId: sender.documentId ?? null };
  if (priorSender && (normalized.id !== priorSender.id || normalized.tabId !== priorSender.tabId || normalized.frameId !== priorSender.frameId
      || normalized.url !== priorSender.url || normalized.origin !== priorSender.origin
      || normalized.documentId !== priorSender.documentId)) {
    throw new Error('Runtime bridge content sender identity changed between loaded and ready reports.');
  }
  return normalized;
}

export function validateRuntimeBridgeSnapshot(snapshot, expectedReports, contract) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.failure != null || !Array.isArray(snapshot.reports) || snapshot.reports.length !== expectedReports.length) {
    throw new Error(`Runtime bridge collector snapshot is incomplete or terminally failed: ${snapshot?.failure?.code ?? 'invalid snapshot'}.`);
  }
  const rejected = Object.values(snapshot.rejections ?? {});
  if (rejected.some(count => !Number.isSafeInteger(count) || count < 0) || rejected.some(count => count > 0)) throw new Error('Runtime bridge collector recorded rejected reports.');
  for (let index = 0; index < expectedReports.length; index++) {
    const actual = snapshot.reports[index]; const expected = expectedReports[index];
    const priorSender = index === 4 ? expectedReports[3].evidence.sender : null;
    const validated = validateRuntimeBridgeReport(actual, { ...contract, sequence: index + 1, realm: expected.realm, phase: expected.phase, priorSender });
    if (JSON.stringify(validated) !== JSON.stringify(expected)) {
      throw new Error(`Runtime bridge snapshot order/identity mismatch at report ${index + 1}.`);
    }
  }
  return { failure: null, reports: expectedReports, rejections: Object.fromEntries(Object.entries(snapshot.rejections ?? {})) };
}

export async function reconcileFinalRuntimeBridge({ bridge, expectedReports, contract, capabilities, artifact, secrets = [], timeoutMs = 4000 }) {
  let snapshot;
  try {
    snapshot = await withTimeout(Promise.resolve(bridge.snapshot()), timeoutMs, 'final runtime bridge collector snapshot');
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Final runtime bridge collector snapshot is missing or invalid.');
  }
  catch (error) {
    const reason = sanitizePrivate(`Final runtime bridge snapshot failed: ${error.message}`, secrets);
    const finalSnapshot = { status: 'FAILED', reason };
    capabilities.runtimeBridge = { ...(capabilities.runtimeBridge ?? {}), status: 'FAILED', reason: capabilities.runtimeBridge?.reason ?? reason, snapshot: finalSnapshot };
    artifact.runtimeBridge = { ...(artifact.runtimeBridge ?? {}), finalCollectorSnapshot: finalSnapshot, snapshot: finalSnapshot };
    return { ok: false, reason };
  }

  const safeSnapshot = sanitizePrivate(snapshot, secrets);
  const reports = snapshot?.reports;
  let terminalError = null; let validationError = null;
  if (!Array.isArray(reports) || reports.length < expectedReports.length || reports.length > expectedReports.length + 1) {
    validationError = 'Final runtime bridge report count differs from the accepted proof.';
  } else {
    for (let index = 0; index < expectedReports.length; index++) {
      try {
        const expected = expectedReports[index];
        const priorSender = index === 4 ? expectedReports[3].evidence.sender : null;
        const validated = validateRuntimeBridgeReport(reports[index], { ...contract, sequence: index + 1, realm: expected.realm, phase: expected.phase, priorSender });
        if (JSON.stringify(validated) !== JSON.stringify(expected)) throw new Error('Final report differs from previously accepted evidence.');
      } catch (error) { validationError = `Final runtime bridge report ${index + 1} is invalid: ${error.message}`; break; }
    }
    if (!validationError && reports.length === expectedReports.length + 1) {
      try { terminalError = validateRuntimeBridgeErrorReport(reports.at(-1), { runId: contract.runId, sequence: expectedReports.length + 1 }); }
      catch (error) { validationError = `Late final runtime bridge report is invalid: ${error.message}`; }
    }
  }
  const rejected = Object.values(snapshot?.rejections ?? {});
  if (!validationError && (rejected.some(count => !Number.isSafeInteger(count) || count < 0) || rejected.some(count => count > 0))) validationError = 'Final runtime bridge collector recorded rejected reports.';
  if (!validationError && snapshot?.accepted != null && snapshot.accepted !== reports.length) validationError = 'Final runtime bridge accepted count does not match its reports.';
  if (!validationError && terminalError && snapshot.failure?.code !== terminalError.evidence.code) validationError = 'Final runtime bridge failure does not match its authenticated terminal error report.';
  if (!validationError && snapshot.failure && !terminalError) validationError = `Final runtime bridge collector failed without a valid authenticated error report (${snapshot.failure.code ?? 'unknown'}).`;
  if (!validationError && expectedReports.length !== 5) validationError = 'The authenticated runtime bridge did not complete all five required reports.';

  if (terminalError) applyRuntimeBridgeReportedError(capabilities, terminalError, `final collector report ${terminalError.seq}`);
  else if (validationError && capabilities.runtimeBridge?.status !== 'FAILED') capabilities.runtimeBridge = capability('FAILED', { reason: sanitizePrivate(validationError, secrets) });
  else if (!validationError && capabilities.runtimeBridge?.status !== 'FAILED') capabilities.runtimeBridge = capability('SUPPORTED', { reportCount: reports.length, source: 'authenticated-runtime-bridge' });

  const finalEvidence = { reports: safeSnapshot.reports ?? [], failure: safeSnapshot.failure ?? null, rejections: safeSnapshot.rejections ?? {} };
  capabilities.runtimeBridge = { ...capabilities.runtimeBridge, snapshot: finalEvidence };
  artifact.runtimeBridge = { ...(artifact.runtimeBridge ?? {}), finalCollectorSnapshot: finalEvidence, snapshot: finalEvidence };
  return { ok: !validationError && !terminalError, error: terminalError, reason: validationError ?? (terminalError ? `Authenticated runtime bridge ${terminalError.evidence.code}` : null), snapshot: finalEvidence };
}

export async function recordUnattemptedRuntimeBridge({ bridge, capabilities, artifact, secrets = [], timeoutMs = 3000 }) {
  let snapshot;
  try { snapshot = await withTimeout(Promise.resolve(bridge.snapshot()), timeoutMs, 'unattempted runtime bridge snapshot'); }
  catch (error) {
    const reason = sanitizePrivate(`Runtime bridge prerequisite was not reached and its snapshot failed: ${error.message}`, secrets);
    if (capabilities.runtimeBridge?.status === 'NOT_TESTED') capabilities.runtimeBridge = capability('FAILED', { reason });
    artifact.runtimeBridge = { ...(artifact.runtimeBridge ?? {}), attempted: false, snapshot: { status: 'FAILED', reason } };
    return { clean: false, reason };
  }
  const counts = Object.values(snapshot?.rejections ?? {});
  const hasEvidence = !Array.isArray(snapshot?.reports) || snapshot.reports.length > 0 || snapshot.failure != null
    || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 0);
  const safeSnapshot = sanitizePrivate(snapshot, secrets);
  artifact.runtimeBridge = { ...(artifact.runtimeBridge ?? {}), attempted: false, snapshot: safeSnapshot };
  if (hasEvidence && capabilities.runtimeBridge?.status === 'NOT_TESTED') {
    const reason = 'Authenticated runtime reports or collector failures appeared before the extension-install prerequisite completed.';
    capabilities.runtimeBridge = capability('FAILED', { reason });
    return { clean: false, reason };
  }
  return { clean: true, reason: null };
}

export function applyRuntimeBridgeFailure(capabilities, phase, reason, secrets = []) {
  const failed = message => capability('FAILED', { reason: sanitizePrivate(message, secrets) });
  capabilities.runtimeBridge = failed(reason);
  if (phase === 'install') capabilities.extensionInstall = failed(reason);
  if (phase === 'background.loaded') capabilities.backgroundLoaded = failed(reason);
  if (phase === 'background.ready') capabilities.backgroundReadiness = failed(reason);
  if (phase === 'content.loaded') capabilities.contentLoaded = failed(reason);
  if (phase === 'content.ready') {
    capabilities.contentReadiness = failed(reason);
    capabilities.discoveryFlags = retainExecutedCapability(capabilities.discoveryFlags, 'Content discovery flags were not validated because the ready report was missing/invalid.');
    capabilities.runtimeHandshake = retainExecutedCapability(capabilities.runtimeHandshake, 'Content runtime handshake was not validated because the ready report was missing/invalid.');
  }
  return capabilities;
}

export function applyRuntimeBridgeReportedError(capabilities, report, reason) {
  capabilities.runtimeBridge = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from ${report.realm}: ${reason}`, errorCode: report.evidence.code, errorRealm: report.realm });
  if (report.evidence.code === 'PERMISSION_DENIED') capabilities.hostPermissions = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from ${report.realm}.` });
  if (report.evidence.code === 'DISCOVERY_FLAGS_MISMATCH') capabilities.discoveryFlags = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from ${report.realm}.` });
  if (report.evidence.code === 'IMPORT_FAILED') {
    if (report.realm === 'background') capabilities.backgroundLoaded = capability('FAILED', { reason: 'Authenticated IMPORT_FAILED report from background.' });
    else capabilities.contentLoaded = capability('FAILED', { reason: 'Authenticated IMPORT_FAILED report from content.' });
  }
  if (['STARTUP_FAILED', 'READINESS_TIMEOUT'].includes(report.evidence.code)) {
    if (report.realm === 'background') capabilities.backgroundReadiness = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from background.` });
    else capabilities.contentReadiness = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from content.` });
  }
  if (['HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED'].includes(report.evidence.code)) capabilities.runtimeHandshake = capability('FAILED', { reason: `Authenticated ${report.evidence.code} report from ${report.realm}.` });
  if (report.evidence.code === 'NAVIGATION_INVALID') capabilities.contentReadiness = capability('FAILED', { reason: 'Authenticated NAVIGATION_INVALID report from runtime bridge.' });
  return capabilities;
}

export async function runRuntimeBridgeSequence({ bidi, bridge, context, bindingUrl, fixtureUrl, runId, extensionId, installExtension, timeoutMs = 15000, onReport = () => {} }) {
  if (!bridge || typeof bridge.waitFor !== 'function' || typeof bridge.snapshot !== 'function') throw new Error('Fixture runtime bridge API is unavailable.');
  const origin = new URL(fixtureUrl).origin;
  const binding = new URL(bindingUrl);
  const report = new URL(bridge.reportUrl);
  if (binding.origin !== origin || report.origin !== origin || binding.protocol !== 'http:' || report.protocol !== 'http:'
      || binding.username || binding.password || report.username || report.password || binding.hash || report.hash) {
    throw new Error('Fixture runtime-bridge endpoints are not valid inert loopback URLs.');
  }
  let bindingNavigation;
  try { bindingNavigation = await bidi.command('browsingContext.navigate', { context, url: bindingUrl, wait: 'complete' }); }
  catch (error) { error.runtimeBridgePhase = 'binding'; throw error; }
  if (bindingNavigation.result?.url !== bindingUrl) { const error = new Error('Binding page navigation did not remain on the exact inert binding URL.'); error.runtimeBridgePhase = 'binding'; throw error; }
  let installed;
  try { installed = await installExtension(); }
  catch (error) { error.runtimeBridgePhase = 'install'; throw error; }
  if (installed !== extensionId) { const error = new Error('Installed Firefox extension ID does not match the pinned Gecko ID.'); error.runtimeBridgePhase = 'install'; throw error; }
  const reports = []; let sequence = 1; let backgroundTabId; let contentSender = null;
  const accept = async (realm, phase) => {
    let validated;
    try {
      const received = await withTimeout(bridge.waitFor(realm, phase, { timeoutMs }), timeoutMs + 1000, `runtime bridge ${realm}.${phase}`);
      validated = validateRuntimeBridgeReport(received, {
        runId, sequence, realm, phase, extensionId, fixtureUrl, tabId: backgroundTabId, priorSender: contentSender,
      });
    } catch (error) {
      try {
        const failedSnapshot = await withTimeout(Promise.resolve(bridge.snapshot()), 1000, 'runtime bridge terminal error snapshot');
        const terminalReport = failedSnapshot.reports?.find(report => report.phase === 'error');
        if (terminalReport) {
          error.runtimeBridgeReport = validateRuntimeBridgeErrorReport(terminalReport, { runId, sequence });
          error.message = `Authenticated runtime bridge terminal error ${error.runtimeBridgeReport.evidence.code}`;
        }
        else if (failedSnapshot.failure?.code) error.message = `Runtime bridge terminal failure ${failedSnapshot.failure.code}`;
      } catch { /* Preserve the original timeout/protocol failure. */ }
      error.runtimeBridgePhase = `${realm}.${phase}`; throw error;
    }
    sequence++; reports.push(validated); onReport(validated);
    if (realm === 'background' && phase === 'bootstrap') backgroundTabId = validated.evidence.tabId;
    if (realm === 'content' && phase === 'loaded') contentSender = validated.evidence.sender;
    return validated;
  };
  const bootstrap = await accept('background', 'bootstrap');
  await accept('background', 'loaded');
  const readyBackground = await accept('background', 'ready');
  let navigation;
  try { navigation = await bidi.command('browsingContext.navigate', { context, url: fixtureUrl, wait: 'complete' }); }
  catch (error) { error.runtimeBridgePhase = 'fixture-navigation'; throw error; }
  if (navigation.result?.url !== fixtureUrl) { const error = new Error('The pinned BiDi tab did not navigate to the exact local fixture URL.'); error.runtimeBridgePhase = 'fixture-navigation'; throw error; }
  const loadedContent = await accept('content', 'loaded');
  const readyContent = await accept('content', 'ready');
  let collector;
  try { collector = await withTimeout(Promise.resolve(bridge.snapshot()), timeoutMs, 'runtime bridge collector snapshot'); }
  catch (error) { error.runtimeBridgePhase = 'snapshot'; throw error; }
  let snapshot;
  try { snapshot = validateRuntimeBridgeSnapshot(collector, reports, { runId, extensionId, fixtureUrl, tabId: backgroundTabId }); }
  catch (error) { error.runtimeBridgePhase = 'snapshot'; throw error; }
  return {
    reports, snapshot, tabId: bootstrap.evidence.tabId, extensionOrigin: bootstrap.evidence.extensionOrigin,
    backgroundReady: readyBackground.evidence, contentLoaded: loadedContent.evidence, contentReady: readyContent.evidence,
  };
}

export class BiDi {
  constructor(socket, timeoutMs = 5000, { secretValues = [] } = {}) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.secretValues = secretValues; this.nextId = 0; this.pending = new Map(); this.events = []; this.handlers = new Set(); this.protocolError = null; this.journal = []; this.expectingIdleDisconnect = false;
    this.tasks = new Set();
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { this.failProtocol(new Error('Malformed BiDi JSON message.')); return; }
      message = sanitizePrivate(message, this.secretValues);
      if (message === null || typeof message !== 'object' || Array.isArray(message)) { this.failProtocol(new Error('Malformed BiDi envelope: expected an object.')); return; }
      if (message.id != null) {
        if (!Number.isSafeInteger(message.id) || !['success', 'error'].includes(message.type)) { this.failProtocol(new Error('Malformed BiDi response envelope.')); return; }
        const pending = this.pending.get(message.id);
        if (!pending) { this.failProtocol(new Error(`BiDi response has unknown or mismatched id ${message.id}.`)); return; }
        if (message.type === 'success' && (!message.result || typeof message.result !== 'object' || Array.isArray(message.result))) { this.failProtocol(new Error(`BiDi success response for ${pending.method} has no object result.`)); return; }
        if (message.type === 'error' && (typeof message.error !== 'string' || typeof message.message !== 'string')) { this.failProtocol(new Error(`Malformed BiDi error response for ${pending.method}.`)); return; }
        this.pending.delete(message.id);
        if (message.type === 'error') { const error = new Error(`${message.error}: ${message.message}`); error.code = message.error; error.method = pending.method; this.journal.push({ direction: 'response', method: pending.method, id: message.id, at: Date.now(), error: { code: error.code, message: error.message } }); pending.reject(error); }
        else { this.journal.push({ direction: 'response', method: pending.method, id: message.id, at: Date.now(), response: message }); pending.resolve(message); }
      } else {
        if (message.type !== 'event' || typeof message.method !== 'string' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) { this.failProtocol(new Error('Malformed BiDi event envelope.')); return; }
        this.events.push(message);
        for (const handler of this.handlers) {
          const task = Promise.resolve().then(() => handler(message));
          this.tasks.add(task); task.catch(error => { this.failProtocol(sanitizeError(error, this.secretValues)); }).finally(() => this.tasks.delete(task));
        }
      }
    });
    socket.addEventListener('close', event => {
      this.closed = new Error(`BiDi disconnected (${event.code})`);
      if (!this.closing && !(this.expectingIdleDisconnect && this.pending.size === 0 && this.tasks.size === 0)) this.failProtocol(this.closed);
      for (const item of this.pending.values()) item.reject(this.closed); this.pending.clear();
    });
    socket.addEventListener('error', () => {
      this.closed = new Error('BiDi websocket error');
      if (!this.closing && !(this.expectingIdleDisconnect && this.pending.size === 0 && this.tasks.size === 0)) this.failProtocol(this.closed);
      for (const item of this.pending.values()) item.reject(this.closed); this.pending.clear();
    });
  }
  failProtocol(error) {
    if (!this.protocolError) {
      this.protocolError = error;
      this.journal.push({ direction: 'transport-error', at: Date.now(), error: sanitizePrivate({ code: error.code ?? null, method: error.method ?? null, message: error.message }, this.secretValues) });
    }
    for (const item of this.pending.values()) item.reject(this.protocolError);
    this.pending.clear();
  }
  command(method, params = {}) {
    if (this.closed || this.protocolError) return Promise.reject(this.closed ?? this.protocolError);
    const id = ++this.nextId;
    const command = { id, method, params, at: Date.now() };
    this.journal.push(sanitizePrivate({ direction: 'command', ...command }, this.secretValues));
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, params });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.delete(id); reject(error); }
    }), this.timeoutMs, method).catch(error => {
      error.method ??= method;
      error.message = sanitizePrivate(error.message, this.secretValues);
      this.journal.push({ direction: 'failure', method, id, at: Date.now(), error: { code: error.code ?? null, message: error.message } });
      if (/timed out/.test(error.message)) this.failProtocol(error);
      throw error;
    }).finally(() => this.pending.delete(id));
  }
  onEvent(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  markExpectedIdleDisconnect() {
    if (this.pending.size || this.tasks.size) throw new Error('Cannot expect BiDi disconnect while commands or event handlers are outstanding.');
    this.expectingIdleDisconnect = true;
  }
  async drain() { await withTimeout(Promise.all([...this.tasks]), this.timeoutMs, 'BiDi event handlers'); if (this.protocolError) throw this.protocolError; }
  close() { this.closing = true; for (const item of this.pending.values()) item.reject(new Error('BiDi closed')); this.pending.clear(); this.socket.close(); }
}

export function classifyProtocolFailure(error) {
  return ['unknown command', 'unsupported operation'].includes(error?.code)
    ? capability('UNSUPPORTED', { reason: error.message, protocolCode: error.code, command: error.method ?? null })
    : capability('FAILED', { reason: error?.message ?? String(error), protocolCode: error?.code ?? null, command: error?.method ?? null });
}

export function latestRealmObservations(observations) {
  const latestByRealm = new Map();
  for (const observation of observations) latestByRealm.set(observation.realm, observation);
  return [...latestByRealm.values()];
}

export function createRequestDispatcher({ bidi, fixtureOrigin, runtimeReportUrl = null, maxInFlight = 128 }) {
  const requests = []; const errors = []; const jobs = new Set(); let accepting = true; let droppedRecords = 0; let droppedErrors = 0;
  const recordError = error => { if (errors.length < 64) errors.push(error); else droppedErrors++; };
  const actionFor = async (message, terminal = false) => {
    if (message.method !== 'network.beforeRequestSent') return;
    const params = message.params ?? {}; const request = params.request ?? {};
    const classified = request.url === runtimeReportUrl
      ? request.method === 'POST' ? { kind: 'runtime-bridge-report' } : { kind: 'blocked', reason: `unexpected runtime collector method: ${request.method}` }
      : classifyTransportRequest({ method: request.method, url: request.url }, { fixtureOrigin });
    const event = { requestId: request.request, url: request.url, method: request.method, isBlocked: params.isBlocked === true, classification: classified, action: null };
    if (requests.length < 512) requests.push(event);
    else { droppedRecords++; recordError(new Error('Request event evidence limit reached; refusing additional HTTP(S) work.')); }
    const scheme = (() => { try { return new URL(request.url).protocol; } catch { return null; } })();
    if (!request.request) {
      event.action = 'missing-request-id'; recordError(new Error(`BiDi request event has no request id: ${request.url ?? '<missing URL>'}`)); return;
    }
    if (!params.isBlocked) {
      if (scheme !== 'http:' && scheme !== 'https:') { event.action = 'ignored-non-network-scheme'; return; }
      event.action = 'unblocked-unobservable';
      recordError(new Error(`HTTP(S) request was not paused with an ID: ${request.url}`));
      return;
    }
    if (terminal) {
      event.action = 'fail-terminal-request';
      try { event.commandResponse = await bidi.command('network.failRequest', { request: request.request }); }
      catch (error) { event.commandError = error.message; recordError(error); }
      recordError(new Error(`HTTP(S) request arrived after request admission closed: ${request.url}`));
      return;
    }
    const action = classifyRequestAction(classified.kind);
    try {
      if (action === 'continue-local') {
        event.action = 'continue-local'; event.commandResponse = await bidi.command('network.continueRequest', { request: request.request }); return;
      }
      if (action === 'continue-runtime-report') {
        event.action = 'continue-exact-runtime-report'; event.commandResponse = await bidi.command('network.continueRequest', { request: request.request }); return;
      }
      if (action === 'provide-known-empty-voices') {
        event.action = 'fixture-voices'; event.commandResponse = await bidi.command('network.provideResponse', { request: request.request, statusCode: 200, headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }], body: { type: 'base64', value: Buffer.from('[]').toString('base64') } }); return;
      }
      event.action = classified.kind === 'provider-translation' ? 'deny-provider-before-verified-context' : 'fail-unexpected';
      event.commandResponse = await bidi.command('network.failRequest', { request: request.request });
      if (classified.kind === 'provider-translation') recordError(new Error('Edge provider request occurred before both instrumented runtime realms were verified.'));
    } catch (error) { event.commandError = error.message; recordError(error); }
  };
  const onEvent = message => {
    if (message.method !== 'network.beforeRequestSent') return Promise.resolve();
    if (requests.length >= 512) { droppedRecords++; recordError(new Error('Request handler admission stopped at the evidence limit.')); return Promise.resolve(); }
    if (jobs.size >= maxInFlight) {
      const request = message.params?.request ?? {};
      const classified = classifyTransportRequest({ method: request.method, url: request.url }, { fixtureOrigin });
      requests.push({ requestId: request.request, url: request.url, method: request.method, isBlocked: message.params?.isBlocked === true, classification: classified, action: 'fail-closed-overflow' });
      recordError(new Error(`Request handler admission limit reached (${maxInFlight}); request remains blocked.`));
      return Promise.resolve();
    }
    const terminal = !accepting;
    if (terminal) recordError(new Error('Request event arrived after dispatcher admission closed.'));
    const job = Promise.resolve().then(() => actionFor(message, terminal));
    jobs.add(job);
    return job.catch(error => { recordError(error); }).finally(() => jobs.delete(job));
  };
  return {
    requests, errors, onEvent, get droppedRecords() { return droppedRecords; }, get droppedErrors() { return droppedErrors; },
    closeAdmission() { accepting = false; },
    async drain(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (jobs.size) {
        if (Date.now() >= deadline) { recordError(new Error(`Request-handler drain timed out with ${jobs.size} outstanding job(s).`)); return false; }
        await withTimeout(Promise.all([...jobs]), Math.max(1, deadline - Date.now()), 'request-handler drain').catch(error => { recordError(error); });
      }
      return jobs.size === 0;
    },
  };
}

async function waitForBiDi(endpoint, process, timeoutMs, secretValues = []) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end && process.exitCode === null && process.signalCode === null) {
    try {
      const socket = new WebSocket(endpoint);
      try { await withTimeout(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }), 500, 'Firefox BiDi websocket'); }
      catch (error) { socket.close(); throw error; }
       return new BiDi(socket, Math.min(timeoutMs, 7000), { secretValues });
    } catch (error) { lastError = error; await delay(100); }
  }
  throw new Error(`Firefox BiDi startup failed: ${lastError?.message ?? `process exited ${process.exitCode}`}`);
}

export async function runFirefoxProbe({ buildBenchmarkExtension, workerEntry, contentEntry, artifact, checkIsolation = verifyIsolation, startFixtureOverride, createFixtureOverride }) {
  const root = await mkdtemp(resolve(tmpdir(), 'translate-it-firefox-cap-'));
  const profile = resolve(root, 'profile'); const bundle = resolve(root, 'extension');
  const records = []; const errors = []; const cleanupErrors = []; const capabilities = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('Blocked by an earlier capability gate.')]));
  const runId = artifact.runId ?? randomBytes(16).toString('hex'); const authToken = randomBytes(32).toString('hex'); const privateSecrets = [authToken];
  const expectedExtensionId = 'page-translation-e2e-benchmark@translate-it.test';
  let fixture; let bridge; let bidi; let browser; let extensionId = null; let fixtureOrigin = null; let runtimeReportUrl; let aborted = false; let dispatcher; let interceptReady = false; let runtimeBridgeAttempted = false;
  const bridgeAcceptedReports = []; let bridgeContract = null;
  const abort = signal => {
    aborted = true;
    errors.push(`Probe interrupted by ${signal}.`);
    bidi?.close();
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) { try { process.kill(-browser.pid, 'SIGTERM'); } catch { /* Cleanup records any remaining process. */ } }
  };
  const onSigterm = () => abort('SIGTERM'); const onSigint = () => abort('SIGINT');
  const deadline = setTimeout(() => abort('probe deadline exceeded'), 180_000);
  process.once('SIGTERM', onSigterm); process.once('SIGINT', onSigint);
  try {
    const network = await checkIsolation();
    records.push({ kind: 'network-isolation', ...network });
    capabilities.isolation = network.ok ? capability('SUPPORTED', { evidence: network }) : capability('FAILED', { evidence: network, reason: 'Loopback-only namespace verification failed.' });
    if (!network.ok) throw new Error('Network isolation verification failed; Firefox was not started.');
    const { startFixture: defaultStartFixture, createFixture: defaultCreateFixture } = await import('../page-translation-e2e-benchmark/fixture.mjs');
    const fixtureData = (createFixtureOverride ?? defaultCreateFixture)('small');
    fixture = await (startFixtureOverride ?? defaultStartFixture)(fixtureData, { runtimeBridge: { runId, authToken, expectedExtensionId } });
    bridge = fixture.bridge;
    fixtureOrigin = new URL(fixture.url).origin;
    artifact.fixture = { url: fixture.url, scope: 'loopback-only small capability fixture' };
    capabilities.fixture = capability('SUPPORTED', { url: fixture.url, targetCount: fixtureData.targetCount });
    if (!bridge || typeof bridge.waitFor !== 'function' || typeof bridge.snapshot !== 'function' || typeof bridge.closeAdmission !== 'function' || typeof bridge.drain !== 'function') {
      capabilities.runtimeBridge = capability('FAILED', { reason: 'Fixture did not expose the required authenticated runtime bridge API.' });
      throw new Error('Fixture did not expose the required authenticated runtime bridge API.');
    }
    const bindingUrl = bridge.bindingUrl; runtimeReportUrl = bridge.reportUrl;
    for (const endpoint of [bindingUrl, runtimeReportUrl]) {
      const parsed = new URL(endpoint);
      if (parsed.origin !== fixtureOrigin || parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.hash || containsPrivateSecret(endpoint, privateSecrets)) {
        capabilities.runtimeBridge = capability('FAILED', { reason: 'Runtime bridge endpoint escaped loopback or exposed its private token.' });
        throw new Error('Runtime bridge endpoint escaped the loopback fixture origin or exposed its private token.');
      }
    }
    try {
      await buildBenchmarkExtension({
        outputDir: bundle, mode: 'sliced', browser: 'firefox', workerEntry, contentEntry,
        runtimeBridge: { runId, fixtureUrl: fixture.url, bindingUrl, reportUrl: runtimeReportUrl, authToken },
      });
    } catch (error) {
      capabilities.runtimeBridge = capability('FAILED', { reason: sanitizePrivate(`Authenticated runtime bridge build failed: ${error.message}`, privateSecrets) });
      throw error;
    }
    if (aborted) throw new Error('Probe aborted before browser launch.');
    await mkdir(profile);
    browser = spawn('/usr/bin/firefox', ['--no-remote', '--headless', '--profile', profile, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let startupOutput = ''; let endpoint = null;
    browser.stderr.on('data', data => {
      startupOutput += data.toString();
      const match = startupOutput.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
      if (match) endpoint = `${match[1]}/session`;
    });
    let browserSpawnError = null;
    browser.once('error', error => { browserSpawnError = error; errors.push(`Firefox spawn: ${error.message}`); });
    const startupDeadline = Date.now() + 15000;
    while (!endpoint && !browserSpawnError && Date.now() < startupDeadline && browser.exitCode === null && browser.signalCode === null) await delay(50);
    if (!endpoint) throw new Error(browserSpawnError ? `Firefox spawn failed: ${browserSpawnError.message}` : `Firefox did not announce a BiDi websocket endpoint: ${startupOutput}`);
    bidi = await waitForBiDi(endpoint, browser, 15000, privateSecrets);
    const session = await bidi.command('session.new', { capabilities: { alwaysMatch: { webSocketUrl: true } } });
    artifact.session = session.result;
    capabilities.bidiSession = capability('SUPPORTED', { sessionId: session.result?.sessionId ?? null, browserVersion: session.result?.capabilities?.browserVersion ?? null });
    capabilities.protocol = capability('SUPPORTED', { websocket: endpoint, sessionId: session.result?.sessionId ?? null });
    records.push({ kind: 'session.new', result: session.result });
    dispatcher = createRequestDispatcher({ bidi, fixtureOrigin, runtimeReportUrl });
    bidi.onEvent(dispatcher.onEvent);
    await bidi.command('session.subscribe', { events: ['network.beforeRequestSent'] });
    records.push({ kind: 'session.subscribe', events: ['network.beforeRequestSent'] });
    const intercept = await bidi.command('network.addIntercept', { phases: ['beforeRequestSent'] });
    records.push({ kind: 'network.addIntercept', result: intercept.result });
    interceptReady = !!intercept.result?.intercept;
    capabilities.interceptionSetup = interceptReady ? capability('SUPPORTED', { intercept: intercept.result.intercept, subscribedEvents: ['network.beforeRequestSent'] }) : capability('FAILED', { reason: 'network.addIntercept returned no intercept identifier.' });
    if (!interceptReady) throw new Error('BiDi interception setup acknowledgment missing intercept ID.');
    const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
    if (manifest.background?.scripts?.[0] !== 'worker.js' || manifest.browser_specific_settings?.gecko?.id !== expectedExtensionId) throw new Error('Firefox MV3 module-worker manifest or pinned Gecko ID missing.');
    const { result: created } = await bidi.command('browsingContext.create', { type: 'tab' });
    let runtimeBridgeProof;
    try {
        runtimeBridgeProof = await runRuntimeBridgeSequence({
        bidi, bridge, context: created.context, bindingUrl, fixtureUrl: fixture.url, runId, extensionId: expectedExtensionId,
        installExtension: async () => {
          const installed = await bidi.command('webExtension.install', { extensionData: { type: 'path', path: bundle } });
          extensionId = installed.result?.extension ?? installed.result?.extensionId ?? null;
          records.push({ kind: 'webExtension.install', result: installed.result });
          capabilities.extensionInstall = extensionId === expectedExtensionId
            ? capability('SUPPORTED', { extensionId, manifestWorker: manifest.background.scripts[0], geckoId: manifest.browser_specific_settings.gecko.id })
            : capability('FAILED', { reason: 'Firefox installed extension ID differs from the pinned manifest Gecko ID.' });
          runtimeBridgeAttempted = extensionId === expectedExtensionId;
          return extensionId;
        },
        onReport(report) {
          bridgeAcceptedReports.push(report);
          bridgeContract ??= { runId, extensionId: expectedExtensionId, fixtureUrl: fixture.url };
          if (report.realm === 'background' && report.phase === 'bootstrap') bridgeContract.tabId = report.evidence.tabId;
          records.push({ kind: 'runtime-bridge-report', report });
          if (report.realm === 'background' && report.phase === 'loaded') capabilities.backgroundLoaded = capability('SUPPORTED', { entry: report.evidence.entry, source: 'authenticated-runtime-bridge' });
          if (report.realm === 'background' && report.phase === 'ready') {
            capabilities.backgroundReadiness = capability('SUPPORTED', { checks: report.evidence.checks, source: 'authenticated-runtime-bridge' });
            capabilities.hostPermissions = capability('SUPPORTED', { hostPermission: report.evidence.hostPermission, source: 'authenticated-runtime-bridge' });
          }
          if (report.realm === 'content' && report.phase === 'loaded') capabilities.contentLoaded = capability('SUPPORTED', { entry: report.evidence.entry, source: 'authenticated-runtime-bridge' });
          if (report.realm === 'content' && report.phase === 'ready') {
            capabilities.contentReadiness = capability('SUPPORTED', { checks: report.evidence.checks, source: 'authenticated-runtime-bridge' });
            capabilities.discoveryFlags = capability('SUPPORTED', { flags: report.evidence.flags, source: 'authenticated-runtime-bridge' });
            capabilities.runtimeHandshake = capability('SUPPORTED', { ackReceived: report.evidence.ackReceived, source: 'authenticated-runtime-bridge' });
          }
        },
      });
    } catch (error) {
      const phase = error.runtimeBridgePhase ?? 'bootstrap';
      let failureReason = error.message;
      try {
        const collector = await withTimeout(Promise.resolve(bridge.snapshot()), 3000, 'runtime bridge failed-stage snapshot');
        if (collector.failure?.code) failureReason = `Runtime bridge terminal failure: ${collector.failure.code}`;
      } catch { /* The bridge failure itself remains the primary evidence. */ }
      if (phase === 'install' && !runtimeBridgeAttempted) {
        capabilities.runtimeBridge = retainExecutedCapability(capabilities.runtimeBridge, 'Extension installation prerequisite failed; no runtime report was attempted.');
        if (!error.method && capabilities.extensionInstall.status === 'NOT_TESTED') capabilities.extensionInstall = capability('FAILED', { reason: sanitizePrivate(failureReason, privateSecrets) });
      } else applyRuntimeBridgeFailure(capabilities, phase, failureReason, privateSecrets);
      if (error.runtimeBridgeReport) applyRuntimeBridgeReportedError(capabilities, error.runtimeBridgeReport, failureReason);
      capabilities.runtimeBridge.phase = phase;
      if (error.method || error.code === 'unknown command' || error.code === 'unsupported operation') throw error;
      errors.push(sanitizePrivate(error.stack ?? String(error), privateSecrets));
      throw error;
    }
    capabilities.runtimeBridge = capability('SUPPORTED', { reportCount: runtimeBridgeProof.reports.length, snapshot: runtimeBridgeProof.snapshot, source: 'authenticated-runtime-bridge' });
    artifact.runtimeBridge = sanitizePrivate({ runId, tabId: runtimeBridgeProof.tabId, extensionOrigin: runtimeBridgeProof.extensionOrigin, reports: runtimeBridgeProof.reports, snapshot: runtimeBridgeProof.snapshot }, privateSecrets);
    const expected = fixtureData.targetTexts[0];
    const deadline = Date.now() + 10000; const observations = []; const attemptsByRealm = new Map(); let pageRealm = null; let dom = null; let polls = 0;
    while (Date.now() < deadline) {
      polls++;
      const result = await bidi.command('script.getRealms', {});
      if (!Array.isArray(result.result.realms)) throw new Error('script.getRealms returned no realms array.');
      for (const realm of result.result.realms) {
        if (typeof realm.realm !== 'string' || typeof realm.type !== 'string') throw new Error('script.getRealms returned an invalid realm record.');
        const inspectable = realm.context === created.context || realm.type === 'worker' || realm.origin?.startsWith('moz-extension://');
        const attempts = attemptsByRealm.get(realm.realm) ?? 0;
        if (!inspectable || attempts >= 3) continue;
        attemptsByRealm.set(realm.realm, attempts + 1);
        const evaluated = await bidi.command('script.evaluate', { expression: '(()=>{const x=globalThis.__pageTranslationBenchmark;if(x){const f=x.featureState?.();return JSON.stringify({entry:x.entry??null,startedAt:x.startedAt??null,flags:x.discoveryFlags??null,ready:x.entry==="src/core/background/index.js"?!!x.unifiedTranslationService?.translationEngine&&x.trace?.snapshot?.().scope==="worker":f?.initialized===true&&f?.active===true&&f?.handlerActive===true})}if(typeof document!=="undefined"&&document.body)return JSON.stringify({fixture:true,title:document.title,text:document.querySelector("[data-bench-id=target-0]")?.textContent??null});return null})()', target: { realm: realm.realm }, awaitPromise: true });
        const remoteResult = evaluated.result?.result;
        if (!remoteResult || typeof remoteResult !== 'object') throw new Error(`script.evaluate returned an invalid result for realm ${realm.realm}.`);
        const base = { realm: realm.realm, type: realm.type, context: realm.context ?? null, origin: realm.origin ?? null };
        if (remoteResult.type === 'exception') observations.push({ ...base, evaluationError: remoteResult.exceptionDetails?.text ?? 'JavaScript exception in realm evaluation.' });
        else if (remoteResult.type === 'string') observations.push({ ...base, value: remoteResult.value });
        else if (remoteResult.type === 'null') observations.push({ ...base, value: null });
        else throw new Error(`script.evaluate returned unknown result type for realm ${realm.realm}: ${String(remoteResult.type)}`);
      }
      const values = latestRealmObservations(observations.flatMap(item => { try { return item.value ? [{ ...item, value: JSON.parse(item.value) }] : []; } catch (error) { return [{ ...item, evaluationError: `Invalid marker JSON: ${error.message}` }]; } }));
      pageRealm = values.findLast(item => item.context === created.context && item.type === 'window' && item.value?.fixture);
      dom = pageRealm?.value;
      const backgroundReady = values.some(item => item.value?.entry === 'src/core/background/index.js' && item.value.ready === true);
      const contentReady = values.some(item => item.value?.entry === 'src/core/content-scripts/index-main.js' && item.value.ready === true
        && JSON.stringify(item.value.flags) === JSON.stringify({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }));
      if (backgroundReady && contentReady && dom?.text === expected) break;
      await delay(250);
    }
    records.push({ kind: 'realm-observations', observations, polls });
    await bidi.drain();
    if (!(await dispatcher.drain(5000))) throw dispatcher.errors[0];
    const values = latestRealmObservations(observations.flatMap(item => { try { return item.value ? [{ ...item, value: JSON.parse(item.value) }] : []; } catch (error) { return [{ ...item, evaluationError: `Invalid marker JSON: ${error.message}` }]; } }));
    const findEntry = entry => values.find(item => item.value?.entry === entry);
    const bgMarker = findEntry('src/core/background/index.js');
    const ctMarker = findEntry('src/core/content-scripts/index-main.js');
    const bgAccessible = bgMarker ?? values.find(item => item.type === 'worker' || item.origin?.startsWith('moz-extension://'));
    const fixtureWindows = values.filter(item => item.context === created.context && item.type === 'window');
    const ctAccessible = ctMarker ?? (fixtureWindows.length > 1 ? fixtureWindows.find(item => item !== pageRealm) : null);
    const classify = (candidate, entry, flags) => classifyObservedRealm({ expectedEntry: entry, expectedFlags: flags, observation: candidate ? { realmExposed: true, entryMatched: candidate.value?.entry === entry, ready: candidate.value?.ready === true, flags: candidate.value?.flags, evaluationError: candidate.evaluationError, realm: candidate.realm, origin: candidate.origin } : { realmExposed: false, reason: 'No matching extension instrumentation entry was exposed by BiDi.' } });
    capabilities.backgroundInspection = bgAccessible ? capability('SUPPORTED', { realm: bgAccessible.realm, origin: bgAccessible.origin, type: bgAccessible.type }) : capability('UNSUPPORTED', { reason: 'Firefox BiDi did not expose a background/addon realm after bounded polling.', evidence: observations });
    capabilities.contentInspection = ctAccessible ? capability('SUPPORTED', { realm: ctAccessible.realm, origin: ctAccessible.origin, type: ctAccessible.type }) : capability('UNSUPPORTED', { reason: 'Firefox BiDi did not expose a content addon-world realm after bounded polling.', evidence: observations });
    capabilities.backgroundReadiness = bgAccessible ? classify(bgAccessible, 'src/core/background/index.js') : retainExecutedCapability(capabilities.backgroundReadiness, 'Background execution/readiness cannot be evaluated because its real realm is inaccessible.');
    capabilities.contentReadiness = ctAccessible ? classify(ctAccessible, 'src/core/content-scripts/index-main.js') : retainExecutedCapability(capabilities.contentReadiness, 'Content execution/readiness cannot be evaluated because its real addon world is inaccessible.');
    capabilities.discoveryFlags = ctAccessible ? classifyObservedRealm({ expectedEntry: 'src/core/content-scripts/index-main.js', expectedFlags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }, observation: { realmExposed: true, entryMatched: ctAccessible.value?.entry === 'src/core/content-scripts/index-main.js', ready: ctAccessible.value?.ready === true, flags: ctAccessible.value?.flags, evaluationError: ctAccessible.evaluationError, realm: ctAccessible.realm } }) : retainExecutedCapability(capabilities.discoveryFlags, 'Content runtime realm was not inspectable.');
    capabilities.fixture = dom?.text === expected ? capability('SUPPORTED', { url: fixture.url, targetCount: fixtureData.targetCount, observedFirstTarget: dom.text }) : capability('FAILED', { reason: `Fixture DOM did not expose exact expected first target: ${String(dom?.text)}` });
    capabilities.interceptionSetup = interceptReady ? capability('SUPPORTED', { interceptId: intercept.result.intercept, subscribedEvents: ['network.beforeRequestSent'] }) : capability('FAILED', { reason: 'Intercept setup missing.' });
    capabilities.interceptionDispatch = notTested('Awaiting a blocked fixture request and fail-closed native page fetch.');
    const deferredReason = 'Deferred: this bounded probe does not implement the real provider-response and held-cancellation lifecycle scenario.';
    capabilities.backgroundProviderInterception = notTested(deferredReason);
    capabilities.providerRequestBody = notTested(deferredReason);
    capabilities.providerResponse = notTested(deferredReason);
    capabilities.backgroundNegativeFetch = notTested('Background realm unavailable.');
    capabilities.contentNegativeFetch = notTested('Content realm unavailable.');
    capabilities.pageNegativeFetch = notTested('Page fetch probe not yet executed.');
    for (const name of ['heldRequestAbort', 'rootSettlement', 'physicalSettlement', 'heldResponseRelease', 'staleDeliveryCheck', 'nostaleDOM']) capabilities[name] = notTested(deferredReason);
    if (pageRealm && dom?.text === expected) {
      const negative = await bidi.command('script.evaluate', { expression: 'fetch("https://example.invalid/page-translation-firefox-probe").then(()=>"resolved",e=>JSON.stringify({rejected:true,name:e.name}))', target: { realm: pageRealm.realm }, awaitPromise: true });
      const result = negative.result?.result?.value;
      const request = dispatcher.requests.find(item => item.url?.startsWith('https://example.invalid/'));
      capabilities.pageNegativeFetch = typeof result === 'string' && JSON.parse(result).rejected === true && request?.isBlocked === true && request.action === 'fail-unexpected' && request.commandResponse?.type === 'success'
        ? capability('SUPPORTED', { result: JSON.parse(result), requestObserved: true, request })
        : capability('FAILED', { reason: 'Native page fetch did not produce an observed, intercepted and failed request followed by rejection.', result, request: request ?? null });
    }
    const fixtureRequest = dispatcher.requests.find(item => item.url === fixture.url);
    if (fixtureRequest?.isBlocked === true && fixtureRequest.action === 'continue-local' && fixtureRequest.commandResponse?.type === 'success'
        && capabilities.pageNegativeFetch.status === 'SUPPORTED') {
      capabilities.interceptionDispatch = capability('SUPPORTED', { fixtureRequest, pageExternalRequest: capabilities.pageNegativeFetch.request });
    } else {
      capabilities.interceptionDispatch = capability('FAILED', { reason: 'Both observed local continuation and native external-request failure were not confirmed.', fixtureRequest: fixtureRequest ?? null, pageNegativeFetch: capabilities.pageNegativeFetch });
    }
    const probeRealmFetch = async (name, candidate) => {
      if (!candidate) return notTested(`Actual ${name} realm is inaccessible.`);
      const url = `https://example.invalid/page-translation-firefox-${name}`;
      const evaluated = await bidi.command('script.evaluate', { expression: `fetch(${JSON.stringify(url)}).then(()=>JSON.stringify({resolved:true}),e=>JSON.stringify({rejected:true,name:e.name}))`, target: { realm: candidate.realm }, awaitPromise: true });
      const value = evaluated.result?.result?.value;
      const request = dispatcher.requests.find(item => item.url === url);
      let outcome;
      try { outcome = JSON.parse(value); } catch { outcome = null; }
      return outcome?.rejected === true && request?.isBlocked === true && request.action === 'fail-unexpected' && request.commandResponse?.type === 'success'
        ? capability('SUPPORTED', { outcome, request })
        : capability('FAILED', { reason: 'Native fetch was not observed and failed by the BiDi dispatcher.', outcome, request: request ?? null });
    };
    const runtimeGatesReady = runtimeProbeGate(capabilities);
    if (runtimeGatesReady) {
      capabilities.backgroundNegativeFetch = await probeRealmFetch('background', bgMarker);
      capabilities.contentNegativeFetch = await probeRealmFetch('content', ctMarker);
    } else {
      const reason = 'Deferred: both actual extension realms, readiness checks, and exact sliced-discovery flags must pass first.';
      capabilities.backgroundNegativeFetch = retainExecutedCapability(capabilities.backgroundNegativeFetch, reason);
      capabilities.contentNegativeFetch = retainExecutedCapability(capabilities.contentNegativeFetch, reason);
      capabilities.backgroundProviderInterception = notTested(deferredReason);
    }
    capabilities.cleanup = notTested('Cleanup completion is recorded in the finally path.');
    artifact.runtimeEvidence = { observations, requests: dispatcher.requests };
  } catch (error) {
    errors.push(sanitizePrivate(error.stack ?? String(error), privateSecrets));
    if (capabilities.isolation.status === 'NOT_TESTED') capabilities.isolation = capability('FAILED', { reason: `Could not verify required network isolation: ${error.message}` });
    if (!fixture && capabilities.fixture.status === 'NOT_TESTED' && capabilities.isolation.status === 'SUPPORTED') capabilities.fixture = capability('FAILED', { reason: sanitizePrivate(error.message, privateSecrets) });
    const transportFailure = !!error.method || error === bidi?.protocolError || error === bidi?.closed || (!!browser && !bidi);
    const protocolClassification = transportFailure ? classifyProtocolFailure(error) : null;
    if (protocolClassification) capabilities.protocol = protocolClassification;
    if (error.method === 'session.subscribe' || error.method === 'network.addIntercept') {
      blockRuntimeBridgePrerequisite(capabilities, 'interceptionSetup', protocolClassification?.status ?? 'FAILED', error.message, { bridgeAttempted: runtimeBridgeAttempted });
    } else if (error.method === 'webExtension.install' || (error.runtimeBridgePhase === 'install' && !runtimeBridgeAttempted)) {
      blockRuntimeBridgePrerequisite(capabilities, 'extensionInstall', protocolClassification?.status ?? 'FAILED', sanitizePrivate(error.message, privateSecrets), { bridgeAttempted: runtimeBridgeAttempted });
    } else if (protocolClassification?.status === 'UNSUPPORTED' && !runtimeBridgeAttempted) {
      capabilities.runtimeBridge = retainExecutedCapability(capabilities.runtimeBridge, 'BiDi runtime bridge prerequisite command is unsupported; no authenticated runtime report was attempted.');
    } else if (error.runtimeBridgePhase && capabilities.runtimeBridge.status === 'NOT_TESTED') {
      applyRuntimeBridgeFailure(capabilities, error.runtimeBridgePhase, error.message, privateSecrets);
    } else if (runtimeBridgeAttempted && capabilities.runtimeBridge.status === 'NOT_TESTED') {
      applyRuntimeBridgeFailure(capabilities, error.runtimeBridgePhase ?? 'runtime', error.message, privateSecrets);
    }
    if (capabilities.protocol.status === 'UNSUPPORTED') {
      if (['session.subscribe', 'network.addIntercept'].includes(error.method)) capabilities.interceptionSetup = capability('UNSUPPORTED', { reason: error.message, command: error.method });
      if (error.method === 'webExtension.install') capabilities.extensionInstall = capability('UNSUPPORTED', { reason: error.message, command: error.method });
      if (error.method === 'script.getRealms') {
        capabilities.backgroundInspection = capability('UNSUPPORTED', { reason: error.message, command: error.method });
        capabilities.contentInspection = capability('UNSUPPORTED', { reason: error.message, command: error.method });
        capabilities.backgroundReadiness = retainExecutedCapability(capabilities.backgroundReadiness, 'BiDi realm inspection command unsupported.');
        capabilities.contentReadiness = retainExecutedCapability(capabilities.contentReadiness, 'BiDi realm inspection command unsupported.');
        capabilities.discoveryFlags = retainExecutedCapability(capabilities.discoveryFlags, 'BiDi realm inspection command unsupported.');
      }
    }
    if (bridge?.snapshot && !artifact.runtimeBridge) {
      try { artifact.runtimeBridgeFailureSnapshot = sanitizePrivate(await withTimeout(Promise.resolve(bridge.snapshot()), 3000, 'runtime bridge failure snapshot'), privateSecrets); }
      catch (snapshotError) { errors.push(sanitizePrivate(`Runtime bridge failure snapshot failed: ${snapshotError.message}`, privateSecrets)); }
    }
  } finally {
    clearTimeout(deadline);
    try { if (bridge?.closeAdmission) await withTimeout(Promise.resolve(bridge.closeAdmission()), 3000, 'runtime bridge close admission'); }
    catch (error) { cleanupErrors.push(`Runtime bridge admission close: ${sanitizePrivate(error.message, privateSecrets)}`); }
    dispatcher?.closeAdmission();
    if (browser?.pid) {
      try {
        if (browser.exitCode === null && browser.signalCode === null) {
          try { bidi?.markExpectedIdleDisconnect(); } catch (error) { cleanupErrors.push(`BiDi was not idle before browser shutdown: ${error.message}`); }
          process.kill(-browser.pid, 'SIGTERM');
          try { await waitForChildExit(browser, 3000, 'Firefox shutdown'); }
          catch { process.kill(-browser.pid, 'SIGKILL'); await waitForChildExit(browser, 3000, 'Firefox forced shutdown'); }
        }
        await assertProcessGroupGone(browser.pid);
      }
      catch (error) { cleanupErrors.push(`Firefox cleanup: ${error.message}`); }
    }
    try {
      if (dispatcher && !(await dispatcher.drain(5000))) cleanupErrors.push('Request-handler drain timed out.');
      await bidi?.drain();
    } catch (error) { cleanupErrors.push(`Request handler drain: ${error.message}`); }
    try {
      if (bridge?.drain) {
        const drained = await withTimeout(Promise.resolve(bridge.drain({ timeoutMs: 3000 })), 3500, 'runtime bridge drain');
        if (drained === false || drained?.timedOut === true || drained?.ok === false || drained?.errors?.length) cleanupErrors.push('Runtime bridge did not drain cleanly.');
      }
    } catch (error) { cleanupErrors.push(`Runtime bridge drain: ${sanitizePrivate(error.message, privateSecrets)}`); }
    if (bridge && runtimeBridgeAttempted) {
      const contract = bridgeContract ?? { runId, extensionId: expectedExtensionId, fixtureUrl: fixture?.url, tabId: undefined };
      const reconciliation = await reconcileFinalRuntimeBridge({ bridge, expectedReports: bridgeAcceptedReports, contract, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000 });
      if (!reconciliation.ok) errors.push(sanitizePrivate(`Final runtime bridge reconciliation failed: ${reconciliation.reason ?? 'collector evidence mismatch'}`, privateSecrets));
    } else if (bridge) {
      const snapshot = await recordUnattemptedRuntimeBridge({ bridge, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000 });
      if (!snapshot.clean) errors.push(sanitizePrivate(snapshot.reason, privateSecrets));
    }
    try { bidi?.close(); } catch (error) { cleanupErrors.push(`BiDi close: ${error.message}`); }
    try { if (dispatcher && !(await dispatcher.drain(1000))) cleanupErrors.push('Request handlers remained after BiDi disconnect.'); }
    catch (error) { cleanupErrors.push(`Post-disconnect request drain: ${error.message}`); }
    if (dispatcher?.errors.length) {
      const messages = dispatcher.errors.map(error => sanitizePrivate(error.message ?? String(error), privateSecrets));
      errors.push(...messages);
      capabilities.protocol = capability('FAILED', { reason: 'Request dispatcher reported a dropped, late, unexpected, or failed HTTP(S) request.', errors: messages });
      capabilities.interceptionDispatch = capability('FAILED', { reason: 'Request dispatch errors occurred.', errors: messages });
    }
    try { if (fixture?.server?.listening) await withTimeout(new Promise((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve())), 5000, 'fixture server close'); } catch (error) { cleanupErrors.push(`Fixture cleanup: ${error.message}`); }
    await rm(root, { recursive: true, force: true }).catch(error => cleanupErrors.push(`Temporary cleanup: ${error.message}`));
    process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigint);
    capabilities.cleanup = cleanupErrors.length ? capability('FAILED', { errors: [...cleanupErrors] }) : capability('SUPPORTED', { browserExited: !browser || browser.exitCode !== null || browser.signalCode !== null, exitCode: browser?.exitCode ?? null, signalCode: browser?.signalCode ?? null, fixtureClosed: !fixture || !fixture.server.listening, tempRemoved: true });
    const safeCapabilities = sanitizePrivate(capabilities, privateSecrets);
    Object.assign(capabilities, safeCapabilities);
    artifact.capabilities = safeCapabilities; artifact.events = sanitizePrivate(records, privateSecrets); artifact.errors = sanitizePrivate(errors, privateSecrets);
    artifact.requests = sanitizePrivate(dispatcher?.requests ?? [], privateSecrets);
    artifact.requestDispatcher = { maxInFlight: 128, maxRecordedRequests: 512, maxRecordedErrors: 64, droppedRecords: dispatcher?.droppedRecords ?? 0, droppedErrors: dispatcher?.droppedErrors ?? 0, errors: dispatcher?.errors.map(error => error.message ?? String(error)) ?? [] };
    artifact.protocolEvents = bidi?.events ?? [];
    artifact.networkRequests = artifact.requests;
    artifact.protocolJournal = bidi?.journal ?? [];
    artifact.limitations = ['Real provider request-body/response and held-request cancellation/stale-delivery scenarios are explicitly deferred and not implemented in this bounded probe.', 'Background/content negative fetches only run when both actual realms, readiness, and exact sliced-discovery flags pass.', 'When a runtime gate is inaccessible, dependent checks remain NOT_TESTED.', 'No mock provider, fetch substitute, URL rewrite, or fabricated runtime result was used.', 'This is a small capability probe, not the full 1000-target E2E matrix.'];
    for (const key of Object.keys(artifact)) artifact[key] = sanitizePrivate(artifact[key], privateSecrets);
  }
  return capabilities;
}

async function waitForChildExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let onExit;
  const exit = new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
  try { await withTimeout(exit, timeoutMs, label); }
  finally { child.off('exit', onExit); }
}

async function assertProcessGroupGone(groupId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(-groupId, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (attempt === 0) process.kill(-groupId, 'SIGKILL');
    await delay(100);
  }
  throw new Error(`Firefox process group ${groupId} still exists after SIGKILL.`);
}

export async function verifyIsolation() {
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }); let stdout = ''; let stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const [interfaces, routes, routes6] = await Promise.all([
    run('ip', ['-brief', 'address']), run('ip', ['route', 'show']), run('ip', ['-6', 'route', 'show']),
  ]);
  return { ...isolationSnapshot({ interfaces: interfaces.stdout, routes: routes.stdout, routes6: routes6.stdout }), ok: interfaces.code === 0 && routes.code === 0 && routes6.code === 0 && isolationSnapshot({ interfaces: interfaces.stdout, routes: routes.stdout, routes6: routes6.stdout }).ok };
}

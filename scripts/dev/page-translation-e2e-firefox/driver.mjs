import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyTransportRequest, mapEdgeResponse } from '../page-translation-e2e-benchmark/metrics.mjs';
import { PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES } from './runtime-constants.mjs';
import { compareRestoreDOMSnapshots } from './restore-dom-diagnostics.mjs';
import { createEdgeLoopbackCertificates, edgeProxyFirefoxPrefs, importEdgeLoopbackCa, startEdgeLoopbackProxy } from './loopback-edge-proxy.mjs';
import { createReplacementCollector } from './runtime-replacement-collector.mjs';
import { createStaleCollector } from './runtime-stale-collector.mjs';
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

function bodyJournalSummary(body) {
  if (!body || typeof body !== 'object' || typeof body.value !== 'string' || !['string', 'base64'].includes(body.type)) return { redacted: true, available: false };
  let bytes;
  try { bytes = body.type === 'base64' ? Buffer.from(body.value, 'base64') : Buffer.from(body.value, 'utf8'); }
  catch { return { redacted: true, available: false, type: body.type }; }
  return { redacted: true, type: body.type, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function journalCommand(method, command, secrets) {
  const safe = sanitizePrivate(command, secrets);
  safe.direction = 'command';
  if (method === 'network.provideResponse' && safe.params?.body) safe.params.body = bodyJournalSummary(command.params.body);
  return safe;
}

function journalResponse(method, message, secrets) {
  const safe = sanitizePrivate(message, secrets);
  if (method === 'network.getData' && message.type === 'success') safe.result = bodyJournalSummary(message.result);
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

export async function reconcileFinalRuntimeBridge({ bridge, expectedReports, contract, capabilities, artifact, secrets = [], timeoutMs = 4000, drainSucceeded = true }) {
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
  if (!validationError && !drainSucceeded) validationError = 'Runtime bridge producers/collector did not drain before the final snapshot.';

  if (terminalError) applyRuntimeBridgeReportedError(capabilities, terminalError, `final collector report ${terminalError.seq}`);
  else if (validationError && capabilities.runtimeBridge?.status !== 'FAILED') capabilities.runtimeBridge = capability('FAILED', { reason: sanitizePrivate(validationError, secrets) });
  else if (!validationError && capabilities.runtimeBridge?.status !== 'FAILED') capabilities.runtimeBridge = capability('SUPPORTED', { reportCount: reports.length, source: 'authenticated-runtime-bridge' });

  const finalEvidence = { reports: safeSnapshot.reports ?? [], failure: safeSnapshot.failure ?? null, rejections: safeSnapshot.rejections ?? {} };
  capabilities.runtimeBridge = { ...capabilities.runtimeBridge, snapshot: finalEvidence };
  artifact.runtimeBridge = { ...(artifact.runtimeBridge ?? {}), finalCollectorSnapshot: finalEvidence, snapshot: finalEvidence };
  return { ok: !validationError && !terminalError, error: terminalError, reason: validationError ?? (terminalError ? `Authenticated runtime bridge ${terminalError.evidence.code}` : null), snapshot: finalEvidence };
}

export async function recordUnattemptedRuntimeBridge({ bridge, capabilities, artifact, secrets = [], timeoutMs = 3000, drainSucceeded = true }) {
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
    || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 0) || !drainSucceeded;
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
        else { this.journal.push({ direction: 'response', method: pending.method, id: message.id, at: Date.now(), response: journalResponse(pending.method, message, this.secretValues) }); pending.resolve(message); }
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
    this.journal.push(journalCommand(method, { ...command }, this.secretValues));
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

const providerStopCodes = new Set(['INTERCEPTION_UNSUPPORTED', 'BODY_UNSUPPORTED', 'INVALID_BODY', 'PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'COMPLETED']);
const providerDiagnosticCodes = new Set([...providerStopCodes, 'ABORTED', 'NETWORK_ERROR', 'HTTP_ERROR', 'FETCH_ERROR']);
const operationEvents = new Set(['armed', 'scheduler-batch', 'scheduler-batch-accepted', 'stop-auto-command', 'stop-auto-final', 'stop-auto-diagnostic', 'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled', 'command-result', 'translated', 'restored', 'error']);
const operationName = 'edge-fr-page-once';
const operationExact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validEdgePageTranslateUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'edge.microsoft.com' || parsed.pathname !== '/translate/translatetext'
        || parsed.port || parsed.username || parsed.password || parsed.hash) return false;
    const allowed = new Set(['to', 'from', 'isEnterpriseClient']);
    for (const key of parsed.searchParams.keys()) if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) return false;
    return parsed.searchParams.get('to') === 'fr' && parsed.searchParams.get('isEnterpriseClient') === 'false'
      && (!parsed.searchParams.has('from') || (parsed.searchParams.get('from') !== '' && parsed.searchParams.get('from').length <= 32));
  } catch { return false; }
}

function isEdgeProviderCandidate(value) {
  try { const parsed = new URL(value); return parsed.hostname === 'edge.microsoft.com'; }
  catch { return false; }
}

export function decodeEdgeRequestBody(data, { maxBytes = 65536 } = {}) {
  if (!data || typeof data !== 'object' || !['string', 'base64'].includes(data.type) || typeof data.value !== 'string') throw new TypeError('Edge request body data type unavailable.');
  let bytes;
  if (data.type === 'string') bytes = Buffer.from(data.value, 'utf8');
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.value)) throw new TypeError('Edge request body base64 is malformed.');
    bytes = Buffer.from(data.value, 'base64');
    if (bytes.toString('base64') !== data.value) throw new TypeError('Edge request body base64 is non-canonical.');
  }
  if (bytes.length === 0 || bytes.length > maxBytes) throw new TypeError(`Edge request body size is invalid: ${bytes.length}.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TypeError('Edge request body is not valid UTF-8.'); }
  let body;
  try { body = JSON.parse(text); } catch { throw new TypeError('Edge request body is not valid JSON.'); }
  if (!Array.isArray(body) || body.length === 0 || body.some(item => typeof item !== 'string' || !item.trim()) || new Set(body).size !== body.length) {
    throw new TypeError('Edge request body must be a non-empty array of unique non-empty strings.');
  }
  return { bytes, body };
}

export function validateProviderOperationReport(report, { runId, event, opSeq, extensionId, fixtureUrl, tabId, priorSender = null }) {
  if (!operationExact(report, ['v', 'runId', 'op', 'opSeq', 'event', 'evidence']) || report.v !== 1 || report.runId !== runId
      || report.op !== operationName || report.event !== event || !Number.isSafeInteger(report.opSeq) || report.opSeq <= 0
      || (opSeq !== undefined && report.opSeq !== opSeq) || !operationEvents.has(event) || !operationExact(report.evidence, Object.keys(report.evidence ?? {}))) {
    throw new Error(`Provider operation report envelope invalid for ${String(event)}.`);
  }
  const evidence = report.evidence;
  if (event === 'armed') {
    if (!operationExact(evidence, ['sender', 'navigationGeneration', 'edgeHostPermission', 'proxyDisabled', 'observersInstalled']) || evidence.navigationGeneration !== 1
        || evidence.edgeHostPermission !== true || evidence.proxyDisabled !== true || evidence.observersInstalled !== true) throw new Error('Provider probe arm checks failed.');
    if (extensionId && fixtureUrl && !normalizeSender(evidence.sender, { extensionId, fixtureUrl, tabId, priorSender })) throw new Error('Provider arm sender is invalid.');
  } else if (event === 'provider-invoked') {
    if (!operationExact(evidence, ['invocationId', 'sessionId', 'messageId', 'provider', 'itemCount', 'sourceIndexes']) || !safeId(evidence.invocationId)
        || !safeId(evidence.sessionId) || (evidence.messageId !== null && !safeId(evidence.messageId)) || evidence.provider !== 'edge'
         || evidence.itemCount !== evidence.sourceIndexes?.length || !indexesSubset012(evidence.sourceIndexes)) throw new Error('Provider invocation evidence is invalid.');
  } else if (event === 'scheduler-batch') {
    if (!operationExact(evidence, ['messageId', 'sessionId', 'targetIds']) || !safeId(evidence.messageId) || !safeId(evidence.sessionId)
        || !Array.isArray(evidence.targetIds) || !evidence.targetIds.length || evidence.targetIds.length > 12
        || evidence.targetIds.some(id => !/^target-(?:[0-9]|1[01])$/.test(id)) || new Set(evidence.targetIds).size !== evidence.targetIds.length) {
      throw new Error('Authenticated Scheduler batch evidence is invalid.');
    }
  } else if (event === 'scheduler-batch-accepted') {
    if (!operationExact(evidence, ['messageId', 'sessionId', 'targetIds', 'acceptedTargetIds']) || !safeId(evidence.messageId)
        || !safeId(evidence.sessionId) || !targetIdsSubset(evidence.targetIds) || !sameStrings(evidence.targetIds, evidence.acceptedTargetIds)) {
      throw new Error('Accepted Scheduler batch evidence is invalid.');
    }
  } else if (event === 'stop-auto-command') {
    if (!operationExact(evidence, ['sessionId', 'firstBatchMessageId', 'firstBatchTargetIds', 'acceptedTargetIds', 'pendingTargetIds',
      'stopSuccess', 'stopSessionId', 'translatedCount', 'isTranslated', 'isAutoTranslating', 'acceptedDOMRetained', 'pendingDOMUnchanged', 'acceptedStateHash', 'pendingStateHash'])
        || !safeId(evidence.sessionId) || !safeId(evidence.firstBatchMessageId) || evidence.stopSuccess !== true
        || evidence.stopSessionId !== evidence.sessionId || !Number.isInteger(evidence.translatedCount)
        || !targetIdsSubset(evidence.firstBatchTargetIds) || !sameStrings(evidence.firstBatchTargetIds, evidence.acceptedTargetIds)
        || !targetIdsSubset(evidence.pendingTargetIds) || !disjointStrings(evidence.acceptedTargetIds, evidence.pendingTargetIds)
        || !allTargetIds(evidence.acceptedTargetIds, evidence.pendingTargetIds) || evidence.translatedCount !== evidence.acceptedTargetIds.length
        || evidence.isTranslated !== true || evidence.isAutoTranslating !== false || evidence.acceptedDOMRetained !== true
        || evidence.pendingDOMUnchanged !== true || !isSha256(evidence.acceptedStateHash) || !isSha256(evidence.pendingStateHash)) {
      throw new Error('Production Stop Auto acknowledgment or retained DOM evidence is invalid.');
    }
  } else if (event === 'stop-auto-final') {
    if (!operationExact(evidence, ['sessionId', 'firstBatchMessageId', 'firstBatchTargetIds', 'secondBatchMessageId', 'secondBatchTargetIds',
      'acceptedTargetIds', 'pendingTargetIds', 'acceptedDOMRetained', 'pendingDOMUnchanged', 'acceptedStateHash', 'pendingStateHash', 'postStopMutationTargetIds', 'cancellationRequests', 'contentState', 'worker'])
        || !safeId(evidence.sessionId) || !safeId(evidence.firstBatchMessageId) || !safeId(evidence.secondBatchMessageId)
        || evidence.firstBatchMessageId === evidence.secondBatchMessageId || !targetIdsSubset(evidence.firstBatchTargetIds)
        || !sameStrings(evidence.firstBatchTargetIds, evidence.acceptedTargetIds) || !sameStrings(evidence.secondBatchTargetIds, evidence.pendingTargetIds)
        || !disjointStrings(evidence.acceptedTargetIds, evidence.pendingTargetIds) || !allTargetIds(evidence.acceptedTargetIds, evidence.pendingTargetIds)
        || evidence.acceptedDOMRetained !== true || evidence.pendingDOMUnchanged !== true || !isSha256(evidence.acceptedStateHash)
        || !isSha256(evidence.pendingStateHash) || !Array.isArray(evidence.postStopMutationTargetIds) || evidence.postStopMutationTargetIds.length !== 0
        || !validateStopContentState(evidence.contentState, evidence.sessionId)
        || !validateStopCancellationRequests(evidence.cancellationRequests, evidence.sessionId)
        || !validateStopWorkerEvidence(evidence.worker, evidence.sessionId, evidence.firstBatchMessageId, evidence.secondBatchMessageId)) {
      throw new Error('Final Stop Auto cancellation, settlement, DOM, or resource evidence is invalid.');
    }
  } else if (event === 'stop-auto-diagnostic') {
    if (!operationExact(evidence, ['stage', 'code']) || !PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES.includes(evidence.stage)
        || !['PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN'].includes(evidence.code)) throw new Error('Stop Auto phase diagnostic is invalid.');
  } else if (event === 'physical-start') {
    if (!operationExact(evidence, ['attemptId', 'invocationId', 'sessionId', 'messageId', 'provider', 'method', 'url', 'bodyBytes', 'bodyHash', 'sourceIndexes'])
        || !safeId(evidence.attemptId) || !safeId(evidence.invocationId) || !safeId(evidence.sessionId) || (evidence.messageId !== null && !safeId(evidence.messageId))
        || evidence.provider !== 'edge' || evidence.method !== 'POST' || !validEdgePageTranslateUrl(evidence.url)
        || !Number.isSafeInteger(evidence.bodyBytes) || evidence.bodyBytes < 1 || evidence.bodyBytes > 65536
        || !/^[a-f\d]{64}$/i.test(evidence.bodyHash) || !indexesSubset012(evidence.sourceIndexes)) throw new Error('Native Edge physical-start evidence is invalid.');
  } else if (event === 'physical-settled') {
    if (!operationExact(evidence, ['attemptId', 'sessionId', 'outcome', 'status', 'code']) || !safeId(evidence.attemptId) || !safeId(evidence.sessionId)
        || !['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome) || (evidence.status !== null && !Number.isInteger(evidence.status))
        || (evidence.code !== null && !['ABORTED', 'NETWORK_ERROR', 'HTTP_ERROR', 'FETCH_ERROR'].includes(evidence.code))) throw new Error('Native Edge physical-settled evidence is invalid.');
  } else if (event === 'parser-success') {
    if (!operationExact(evidence, ['invocationId', 'sessionId', 'sourceIndexes', 'resultsMatch']) || !safeId(evidence.invocationId) || !safeId(evidence.sessionId)
        || !indexesSubset012(evidence.sourceIndexes) || evidence.resultsMatch !== true) throw new Error('Edge parser-success evidence is invalid.');
  } else if (event === 'provider-settled') {
    if (!operationExact(evidence, ['invocationId', 'sessionId', 'outcome', 'code']) || !safeId(evidence.invocationId) || !safeId(evidence.sessionId)
        || !['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome)
        || (evidence.outcome === 'fulfilled' ? evidence.code !== null : !providerDiagnosticCodes.has(evidence.code))) throw new Error('Provider settlement evidence is invalid.');
  } else if (event === 'command-result') {
    if (!operationExact(evidence, ['success', 'sessionId', 'code']) || typeof evidence.success !== 'boolean'
        || (evidence.sessionId !== null && !safeId(evidence.sessionId)) || (evidence.code !== null && !providerStopCodes.has(evidence.code))
        || (evidence.success && (!safeId(evidence.sessionId) || evidence.code !== null))) throw new Error('Production page-translate command result is invalid.');
  } else if (event === 'translated') {
    const hasMutationAccounting = Object.hasOwn(evidence, 'acceptedMutationCounts') || Object.hasOwn(evidence, 'unattributedWrites');
    const translatedKeys = ['sessionId', 'acceptedTargetIds', 'acceptedCount', 'duplicateAcceptances', 'staleWrites', 'domMatches', 'sessionOwned', 'quiescent', ...(hasMutationAccounting ? ['acceptedMutationCounts', 'unattributedWrites'] : [])];
    const mutationAccountingValid = !hasMutationAccounting || (operationExact(evidence.acceptedMutationCounts, ['text', 'title'])
      && Number.isSafeInteger(evidence.acceptedMutationCounts.text) && evidence.acceptedMutationCounts.text >= 0
      && Number.isSafeInteger(evidence.acceptedMutationCounts.title) && evidence.acceptedMutationCounts.title >= 0
      && evidence.acceptedMutationCounts.text + evidence.acceptedMutationCounts.title === 12 && evidence.unattributedWrites === 0);
    if (!operationExact(evidence, translatedKeys)
        || !safeId(evidence.sessionId) || !targetIds012(evidence.acceptedTargetIds) || evidence.acceptedCount !== 12 || evidence.duplicateAcceptances !== 0
        || evidence.staleWrites !== 0 || evidence.domMatches !== true || evidence.sessionOwned !== true || evidence.quiescent !== true || !mutationAccountingValid) throw new Error('Real translated DOM acceptance evidence is invalid.');
  } else if (event === 'restored') {
    if (!operationExact(evidence, ['sessionId', 'commandSuccess', 'domMatchesOriginal', 'metadataRestored', 'restoreObserved']) || !safeId(evidence.sessionId)
        || evidence.commandSuccess !== true || evidence.domMatchesOriginal !== true || evidence.metadataRestored !== true || evidence.restoreObserved !== true) throw new Error('Real page-restore evidence is invalid.');
  } else if (event === 'error') {
    if (!operationExact(evidence, ['code']) || !providerStopCodes.has(evidence.code)) throw new Error('Provider operation error code is invalid.');
  }
  return { v: 1, runId, op: operationName, opSeq: report.opSeq, event, evidence: { ...evidence } };
}

/**
 * Phase 2B final-DOM verification. Ownership and the served text are derived
 * from the observed Scheduler evidence, never from an assumed fixture split:
 * targets production accepted under session A keep A's translation, and the
 * targets B accepted carry B's translation of the mutated B source. Production
 * may render a leading U+200E marker, so either representation is accepted
 * but the convention must be consistent across all 12 targets.
 */
export function classifyReplacementFinalDom({ finalDOM, targetTexts, sourcesB, retainedTargetIds = null, acceptedTargetIds = null }) {
  if (!finalDOM || !Array.isArray(finalDOM.targets) || !Array.isArray(targetTexts) || targetTexts.length !== 12
      || !Array.isArray(sourcesB) || sourcesB.length !== 12) return { ok: false, reason: 'invalid-input' };
  const retained = new Set(retainedTargetIds ?? []);
  const accepted = new Set(acceptedTargetIds ?? []);
  const mismatches = [];
  const covered = new Set(finalDOM.targets.map(target => target?.targetId));
  let markerStyle = null;
  for (let index = 0; index < 12; index++) {
    const targetId = `target-${index}`;
    if (!covered.has(targetId)) { mismatches.push({ targetId, reason: 'missing' }); continue; }
    const observed = finalDOM.targets.find(target => target.targetId === targetId);
    const expectedState = retained.has(targetId) ? 'retained' : accepted.has(targetId) ? 'accepted' : null;
    if (expectedState === null) { mismatches.push({ targetId, reason: 'unclassified' }); continue; }
    if (observed.owner !== 'B' || observed.state !== expectedState) {
      mismatches.push({ targetId, reason: 'ownership', owner: observed.owner, state: observed.state, expectedState }); continue;
    }
    const source = expectedState === 'retained' ? targetTexts[index] : sourcesB[index];
    const value = `fixture translation: ${source}`;
    const candidates = [value, `\u200e${value}`].map(entry => createHash('sha256').update(entry).digest('hex'));
    if (!candidates.includes(observed.hash)) { mismatches.push({ targetId, reason: 'hash' }); continue; }
    const style = candidates.indexOf(observed.hash);
    if (markerStyle === null) markerStyle = style;
    else if (markerStyle !== style) mismatches.push({ targetId, reason: 'marker-convention' });
  }
  return { ok: mismatches.length === 0, mismatches, markerStyle };
}

/**
 * Phase 2B proxy-vs-Scheduler correlation: exactly three admitted provider
 * requests, one per observed Scheduler batch, with the expected source-index
 * window derived from that batch's own target membership (A targets map to
 * the A source manifest, B targets to the B source manifest), and the expected
 * statuses released / aborted / released. The Phase 2C Stale-Success mode
 * passes its own expectedStatuses (all released — an aborted request there is
 * a scenario failure, never stale success).
 */
export function classifyReplacementProxyRequests({ requests, expectedWindows = null, expectedStatuses = ['released', 'aborted', 'released'] }) {
  const statuses = Array.isArray(expectedStatuses) && expectedStatuses.length === 3 && expectedStatuses.every(status => typeof status === 'string')
    ? expectedStatuses : null;
  if (!Array.isArray(requests) || requests.length !== 3) return { ok: false, reason: 'shape', statuses: (requests ?? []).map(request => request?.status) };
  if (!statuses) return { ok: false, reason: 'statuses', statuses: requests.map(request => request?.status) };
  if (!Array.isArray(expectedWindows) || expectedWindows.length !== 3 || expectedWindows.some(window => !Array.isArray(window) || !window.length)) {
    return { ok: false, reason: 'windows', statuses: requests.map(request => request?.status) };
  }
  const expectedStatusList = statuses;
  const windows = requests.map(request => request?.sourceIndexes);
  const coverage = new Set(requests.flatMap(request => request?.sourceIndexes ?? []));
  const expectedCoverage = new Set(expectedWindows.flat());
  const matches = requests.every((request, index) => request?.method === 'POST' && request.host === 'edge.microsoft.com'
    && request.sni === 'edge.microsoft.com' && /^[a-f\d]{64}$/i.test(request.bodyHash ?? '')
    && Array.isArray(windows[index]) && windows[index].length === expectedWindows[index].length
    && [...windows[index]].sort((a, b) => a - b).every((value, position) => value === [...expectedWindows[index]].sort((a, b) => a - b)[position])
    && request.status === expectedStatusList[index])
    && coverage.size === expectedCoverage.size
    && [...coverage].every(value => expectedCoverage.has(value))
    && new Set(requests.map(request => request?.requestId)).size === 3;
  return matches ? { ok: true, windows } : { ok: false, reason: 'requests', windows, statuses: requests.map(request => request?.status) };
}

/**
 * Phase 2C stale-reply evidence: the held reply's item count must match the
 * stale batch's target membership and its hash must equal the sha256 of
 * JSON.stringify of the expected oracle translations for those targets —
 * `fixture translation: ${targetTexts[index]}` — accepting either the plain
 * or the uniformly U+200E-prefixed convention (the single hash covers the
 * whole batch, so a mixed convention can never pass).
 */
export function classifyStaleReplyHash({ targetIds, targetTexts, replyItemCount, replyHash }) {
  if (!Array.isArray(targetIds) || !targetIds.length || !targetIds.every(id => typeof id === 'string' && /^target-(?:[0-9]|1[01])$/.test(id))
      || new Set(targetIds).size !== targetIds.length
      || !Array.isArray(targetTexts) || targetTexts.length !== 12
      || replyItemCount !== targetIds.length
      || typeof replyHash !== 'string' || !/^[a-f\d]{64}$/i.test(replyHash)) return { ok: false, reason: 'shape' };
  const candidates = [false, true].map(marker => {
    const texts = targetIds.map(id => {
      const value = `fixture translation: ${targetTexts[Number(id.slice('target-'.length))]}`;
      return marker ? `\u200e${value}` : value;
    });
    return createHash('sha256').update(JSON.stringify(texts)).digest('hex');
  });
  const style = candidates.findIndex(candidate => candidate.toLowerCase() === replyHash.toLowerCase());
  return style >= 0 ? { ok: true, markerStyle: style } : { ok: false, reason: 'reply-hash', markerStyle: null };
}

/**
 * Phase 2C hold window: the collector rejects a stale-reply release later than
 * this (the production PAGE_TRANSLATE_BATCH reply timeout is 8000 ms, so a
 * release beyond this bound would be a timeout, not the ownership check).
 */
export const STALE_SUCCESS_HOLD_WINDOW_MS = 6000;

/**
 * Map observed Scheduler target membership to the proxy's source-index window:
 * A targets use their A source manifest, B targets use the B source manifest.
 */
export function replacementSourceIndexes(targetIds, owner, bManifestOffset = 12) {
  if (!Array.isArray(targetIds) || !targetIds.length) return null;
  return targetIds.map(id => {
    const index = Number(String(id).slice('target-'.length));
    if (!Number.isInteger(index) || index < 0 || index > 11) return null;
    return owner === 'B' ? bManifestOffset + index : index;
  });
}

function targetIdsSubset(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 12
    && value.every(id => typeof id === 'string' && /^target-(?:[0-9]|1[01])$/.test(id)) && new Set(value).size === value.length;
}
function sameStrings(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }
function disjointStrings(left, right) { return Array.isArray(left) && Array.isArray(right) && left.every(value => !right.includes(value)); }
function allTargetIds(left, right) { return [...(left ?? []), ...(right ?? [])].length === 12 && new Set([...(left ?? []), ...(right ?? [])]).size === 12 && Array.from({ length: 12 }, (_, index) => `target-${index}`).every(id => [...left, ...right].includes(id)); }
function isSha256(value) { return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value); }
function validateStopCancellationRequests(value, sessionId) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const cancel = value.find(item => item.action === 'CANCEL_TRANSLATION'); const session = value.find(item => item.action === 'CANCEL_SESSION');
  return !!cancel && !!session && [cancel, session].every(item => operationExact(item, ['action', 'sessionId', 'status', 'responseSuccess', 'cancelAll', 'context'])
    && item.sessionId === sessionId && item.status === 'fulfilled' && item.responseSuccess === true)
    && cancel.cancelAll === true && cancel.context === 'page-translation-batch' && session.cancelAll === null && session.context === null;
}
function validateStopContentState(value, sessionId) {
  return operationExact(value, ['capturedSessionActive', 'discoveryCancelled', 'currentBridgeOwnsSession', 'schedulerSessionContextOwned', 'pendingOperations',
    'translationSessionId', 'activeFlushes', 'queueIds', 'activeBatchIds', 'pendingSettlementCount', 'bridgeSessionActive',
    'bridgeDiscoveryPending', 'bridgeDiscoveryRunning', 'bridgeDiscoveryStarting', 'bridgeDiscoveryQueueDepth', 'bridgeDiscoveryCancelled', 'bridgeDiscoveryFailed'])
    && value.capturedSessionActive === false && value.discoveryCancelled === true && value.schedulerSessionContextOwned === false
    && value.pendingOperations === 0 && value.translationSessionId === sessionId && value.activeFlushes === 0
    && Array.isArray(value.queueIds) && value.queueIds.length === 0 && Array.isArray(value.activeBatchIds) && value.activeBatchIds.length === 0
    && value.pendingSettlementCount === 0 && value.bridgeSessionActive === false
    && value.bridgeDiscoveryPending === false && value.bridgeDiscoveryRunning === false && value.bridgeDiscoveryStarting === false
    && value.bridgeDiscoveryQueueDepth === 0 && value.bridgeDiscoveryCancelled === true && value.bridgeDiscoveryFailed === false;
}
function validateStopWorkerEvidence(value, sessionId, firstMessageId, secondMessageId) {
  if (!operationExact(value, ['providerRoots', 'cancelRequest', 'controllerAbort', 'physical', 'resources']) || !Array.isArray(value.providerRoots) || value.providerRoots.length !== 2) return false;
  const first = value.providerRoots.find(item => item.messageId === firstMessageId); const second = value.providerRoots.find(item => item.messageId === secondMessageId);
  const cancel = value.cancelRequest; const abort = value.controllerAbort; const physical = value.physical; const resources = value.resources;
  return !!first && !!second && [first, second].every(item => operationExact(item, ['messageId', 'sessionId', 'status', 'resultSuccess', 'operationAborted', 'controllerAborted', 'controllerAbortedAtEnd', 'settledSequence']) && item.sessionId === sessionId && Number.isSafeInteger(item.settledSequence))
    && first.status === 'fulfilled' && first.resultSuccess === true
    && ((second.status === 'rejected' && (second.operationAborted === true || second.controllerAbortedAtEnd === true))
      || (second.status === 'fulfilled' && second.resultSuccess === false && second.controllerAbortedAtEnd === true))
    && second.controllerAborted === true
    && operationExact(cancel, ['messageId', 'sessionId', 'status', 'controllerMatched', 'controllerAbortedBefore', 'controllerAbortedAfter', 'responseSuccess'])
    && cancel.messageId === secondMessageId && cancel.sessionId === sessionId && cancel.status === 'fulfilled' && cancel.controllerMatched === true
    && cancel.controllerAbortedBefore === false && cancel.controllerAbortedAfter === true && cancel.responseSuccess === true
    && operationExact(abort, ['messageId', 'sessionId', 'sequence', 'cancelRequestSequence', 'abortedBefore', 'abortedAfter', 'context'])
    && abort.messageId === secondMessageId && abort.sessionId === sessionId && Number.isSafeInteger(abort.sequence)
    && Number.isSafeInteger(abort.cancelRequestSequence) && abort.sequence > abort.cancelRequestSequence
     && abort.context === 'page-translation-batch' && abort.abortedBefore === false && abort.abortedAfter === true && second.settledSequence > abort.sequence
     && operationExact(physical, ['messageId', 'sessionId', 'status', 'operationAborted', 'controllerAbortedAtEnd', 'settledSequence'])
     && physical.messageId === secondMessageId && physical.sessionId === sessionId && physical.status === 'rejected'
     && Number.isSafeInteger(physical.settledSequence) && physical.settledSequence > abort.sequence
    && operationExact(resources, ['available', 'activeLifecycleIds', 'activeRequestIds', 'requests', 'sourceResolverPresent', 'queueEmpty', 'rateLimitIdle', 'leaseActiveCount', 'leaseTimerActive'])
    && resources.available === true && Array.isArray(resources.activeLifecycleIds) && resources.activeLifecycleIds.every(id => id !== firstMessageId && id !== secondMessageId)
    && Array.isArray(resources.activeRequestIds) && resources.activeRequestIds.every(id => id !== firstMessageId && id !== secondMessageId)
    && Array.isArray(resources.requests) && resources.requests.length === 2
    && resources.requests.every(item => operationExact(item, ['messageId', 'status', 'operationOwned']) && [firstMessageId, secondMessageId].includes(item.messageId) && item.operationOwned === false && !['pending', 'processing', 'streaming'].includes(item.status))
    && resources.sourceResolverPresent === false && resources.queueEmpty === true && resources.rateLimitIdle === true && resources.leaseActiveCount === 0 && resources.leaseTimerActive === false;
}

export function validateProviderReleaseReceipt(receipt) {
  if (!operationExact(receipt, ['decision']) || !['start', 'stop'].includes(receipt.decision)) throw new Error('Provider release receipt must explicitly decide start or stop.');
  return receipt.decision;
}

export function validateProviderOperationSnapshot(snapshot, { runId, extensionId, fixtureUrl, tabId, sender = null }) {
  const baseSnapshotKeys = ['op', 'released', 'restoreDecision', 'stopped', 'stopCode', 'reports', 'rejections', 'failure'];
  const phase2Keys = [...baseSnapshotKeys, 'stopAutoDecision', 'stopAutoSnapshotDecision'];
  const snapshotEnvelope = operationExact(snapshot, baseSnapshotKeys)
    || operationExact(snapshot, [...baseSnapshotKeys, 'lastRejection'])
      && (snapshot.lastRejection === null || sanitizeProviderLastRejection(snapshot.lastRejection, []) !== null)
    || operationExact(snapshot, phase2Keys)
    || operationExact(snapshot, [...phase2Keys, 'lastRejection'])
      && (snapshot.lastRejection === null || sanitizeProviderLastRejection(snapshot.lastRejection, []) !== null);
  if (!snapshotEnvelope
      || snapshot.op !== operationName || typeof snapshot.released !== 'boolean' || typeof snapshot.stopped !== 'boolean'
      || !Array.isArray(snapshot.reports) || snapshot.reports.length > 64
      || (snapshot.restoreDecision !== null && !['restore', 'stop'].includes(snapshot.restoreDecision))
      || (Object.hasOwn(snapshot, 'stopAutoDecision') && snapshot.stopAutoDecision !== null && !['stop', 'deny'].includes(snapshot.stopAutoDecision))
      || (Object.hasOwn(snapshot, 'stopAutoSnapshotDecision') && snapshot.stopAutoSnapshotDecision !== null && !['capture', 'deny'].includes(snapshot.stopAutoSnapshotDecision))
      || (snapshot.stopCode !== null && !providerStopCodes.has(snapshot.stopCode))) throw new Error('Provider operation snapshot envelope invalid.');
  if (snapshot.failure !== null && (!operationExact(snapshot.failure, ['code']) || !providerStopCodes.has(snapshot.failure.code))) throw new Error('Provider operation snapshot failure is invalid.');
  if (!operationExact(snapshot.rejections, ['originOrType', 'protocol']) || Object.values(snapshot.rejections).some(count => !Number.isSafeInteger(count) || count < 0 || count > 0)) throw new Error('Provider operation collector recorded rejected telemetry.');
  const reports = snapshot.reports.map((report, index) => validateProviderOperationReport(report, {
    runId, event: report?.event, opSeq: index + 1, extensionId, fixtureUrl, tabId,
    priorSender: report?.event === 'armed' ? sender : null,
  }));
  const seenEvents = new Set();
  for (const report of reports) {
    if (seenEvents.has(report.event) && !['scheduler-batch', 'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled', 'stop-auto-diagnostic'].includes(report.event)) throw new Error(`Provider operation duplicated ${report.event}.`);
    seenEvents.add(report.event);
  }
  const evidence = event => reports.find(report => report.event === event)?.evidence;
  const invocations = reports.filter(report => report.event === 'provider-invoked').map(report => report.evidence);
  const invocationById = new Map(invocations.map(report => [report.invocationId, report]));
  if (invocationById.size !== invocations.length || new Set(invocations.map(report => report.sessionId)).size > 1) throw new Error('Provider invocation identity/session is duplicated or changed.');
  const physicals = reports.filter(report => report.event === 'physical-start').map(report => report.evidence);
  const settlements = reports.filter(report => report.event === 'physical-settled').map(report => report.evidence);
  const physicalById = new Map(physicals.map(report => [report.attemptId, report]));
  if (physicalById.size !== physicals.length) throw new Error('Provider operation duplicated a physical attempt ID.');
  const settledIds = new Set();
  for (const report of physicals) {
    const invocation = invocationById.get(report.invocationId);
    if (!invocation || report.sessionId !== invocation.sessionId || report.messageId !== invocation.messageId
        || JSON.stringify(report.sourceIndexes) !== JSON.stringify(invocation.sourceIndexes)) throw new Error('Provider physical-start is not correlated to provider-invoked.');
  }
  for (const report of settlements) {
    const physical = physicalById.get(report.attemptId);
    if (!physical || settledIds.has(report.attemptId) || report.sessionId !== physical.sessionId) throw new Error('Provider physical-settled is not correlated to a unique physical-start.');
    settledIds.add(report.attemptId);
  }
  for (const report of reports.filter(item => item.event === 'provider-settled').map(item => item.evidence)) {
    const invocation = invocationById.get(report.invocationId);
    if (!invocation || report.sessionId !== invocation.sessionId) throw new Error('Provider settlement does not match an authenticated invocation.');
  }
  const parsers = reports.filter(report => report.event === 'parser-success').map(report => report.evidence);
  const commands = reports.filter(report => report.event === 'command-result').map(report => report.evidence);
  const parserByInvocation = new Map(parsers.map(report => [report.invocationId, report]));
  if (parserByInvocation.size !== parsers.length) throw new Error('Provider invocation has duplicate parser-success reports.');
  const globalCoverage = new Map();
  for (const [invocationId, parser] of parserByInvocation) {
    const invocation = invocationById.get(invocationId);
    if (!invocation || parser.sessionId !== invocation.sessionId || JSON.stringify(parser.sourceIndexes) !== JSON.stringify(invocation.sourceIndexes)) throw new Error('Parser-success does not match its logical invocation.');
    const covered = new Map();
    for (const physical of physicals.filter(item => item.invocationId === invocationId)) {
      const settled = settlements.find(item => item.attemptId === physical.attemptId);
      if (!settled) throw new Error('Parser-success has an unsettled native attempt.');
      if (settled.outcome === 'fulfilled') {
        if (settled.status !== 200 || settled.code !== null) throw new Error('Fulfilled native provider attempt did not consume HTTP 200.');
        for (const index of physical.sourceIndexes) covered.set(index, (covered.get(index) ?? 0) + 1);
      }
    }
    if (invocation.sourceIndexes.some(index => covered.get(index) !== 1)) throw new Error('Parser-success lacks exact-once fulfilled source coverage.');
    for (const index of parser.sourceIndexes) globalCoverage.set(index, (globalCoverage.get(index) ?? 0) + 1);
  }
  if (commands.some(command => command.sessionId !== null && invocations.some(invocation => command.sessionId !== invocation.sessionId))) throw new Error('Production command-result does not match provider session.');
  const command = commands.at(-1); const translated = evidence('translated'); const restored = evidence('restored');
  if (translated && (invocations.length === 0 || parserByInvocation.size !== invocations.length || !command?.success
      || !indexes012([...globalCoverage.keys()].sort((a, b) => a - b)) || translated.sessionId !== invocations[0].sessionId)) throw new Error('Translated DOM acceptance lacks complete parser and command success evidence.');
  if (restored && (!translated || restored.sessionId !== translated.sessionId)) throw new Error('Restore report does not match the translated session.');
  return { op: snapshot.op, released: snapshot.released, restoreDecision: snapshot.restoreDecision,
    stopAutoDecision: snapshot.stopAutoDecision ?? null, stopAutoSnapshotDecision: snapshot.stopAutoSnapshotDecision ?? null,
    stopped: snapshot.stopped, stopCode: snapshot.stopCode, reports, failure: snapshot.failure };
}

export function validatePageTranslationStopOperation(snapshot) {
  if (!snapshot?.stopped || snapshot.stopCode !== 'COMPLETED' || snapshot.failure
      || snapshot.stopAutoDecision !== 'stop' || snapshot.stopAutoSnapshotDecision !== 'capture') throw new Error('Stop Auto operation did not complete both authenticated gates.');
  const reports = snapshot.reports;
  const events = name => reports.filter(report => report.event === name);
  const batches = events('scheduler-batch'); const accepted = events('scheduler-batch-accepted');
  const invocations = events('provider-invoked'); const starts = events('physical-start'); const settlements = events('physical-settled');
  const parsers = events('parser-success'); const providerSettlements = events('provider-settled');
  const commands = events('stop-auto-command'); const finals = events('stop-auto-final');
  if (batches.length !== 2 || accepted.length !== 1 || invocations.length !== 2 || starts.length !== 2 || settlements.length !== 2
      || parsers.length !== 1 || providerSettlements.length !== 2 || commands.length !== 1 || finals.length !== 1) {
    throw new Error('Stop Auto operation omitted exact two-batch provider, physical, acceptance, or cancellation evidence.');
  }
  const final = finals[0].evidence; const command = commands[0].evidence; const acceptedBatch = accepted[0].evidence;
  const byMessage = new Map(invocations.map(report => [report.evidence.messageId, report.evidence]));
  const first = byMessage.get(final.firstBatchMessageId); const second = byMessage.get(final.secondBatchMessageId);
  if (!first || !second || first.sessionId !== final.sessionId || second.sessionId !== final.sessionId
      || !sameStrings(first.sourceIndexes.map(index => `target-${index}`), final.firstBatchTargetIds)
      || !sameStrings(second.sourceIndexes.map(index => `target-${index}`), final.secondBatchTargetIds)) throw new Error('Stop Auto scheduler batches do not match the actual provider invocation identities.');
  if (acceptedBatch.messageId !== first.messageId || acceptedBatch.sessionId !== final.sessionId
      || !sameStrings(acceptedBatch.targetIds, acceptedBatch.acceptedTargetIds)
      || !sameStrings(acceptedBatch.targetIds, final.acceptedTargetIds)) throw new Error('Stop Auto did not preserve the exact accepted first Scheduler batch.');
  const firstStart = starts.find(report => report.evidence.invocationId === first.invocationId)?.evidence;
  const secondStart = starts.find(report => report.evidence.invocationId === second.invocationId)?.evidence;
  const firstSettlement = firstStart && settlements.find(report => report.evidence.attemptId === firstStart.attemptId)?.evidence;
  const secondSettlement = secondStart && settlements.find(report => report.evidence.attemptId === secondStart.attemptId)?.evidence;
  if (!firstStart || !secondStart || firstSettlement?.outcome !== 'fulfilled' || firstSettlement.status !== 200 || firstSettlement.code !== null
      || !['rejected', 'cancelled'].includes(secondSettlement?.outcome) || !['ABORTED', 'NETWORK_ERROR', 'FETCH_ERROR'].includes(secondSettlement.code) || secondSettlement.status !== null) {
    throw new Error('Stop Auto did not correlate one fulfilled first physical batch and one actually aborted held batch.');
  }
  const firstRoot = providerSettlements.find(report => report.evidence.invocationId === first.invocationId)?.evidence;
  const secondRoot = providerSettlements.find(report => report.evidence.invocationId === second.invocationId)?.evidence;
  if (firstRoot?.outcome !== 'fulfilled' || firstRoot.code !== null || !['rejected', 'cancelled'].includes(secondRoot?.outcome)
      || !providerDiagnosticCodes.has(secondRoot?.code)) throw new Error('Provider roots did not settle as first fulfilled and held second cancelled.');
  if (parsers[0].evidence.invocationId !== first.invocationId || parsers[0].evidence.resultsMatch !== true
      || JSON.stringify(parsers[0].evidence.sourceIndexes) !== JSON.stringify(first.sourceIndexes)) throw new Error('Only the fulfilled first batch may have parser-success evidence.');
  if (command.stopSuccess !== true || command.stopSessionId !== final.sessionId || command.translatedCount !== final.acceptedTargetIds.length
      || command.isTranslated !== true || command.isAutoTranslating !== false || !command.acceptedDOMRetained || !command.pendingDOMUnchanged
      || final.acceptedDOMRetained !== true || final.pendingDOMUnchanged !== true || final.postStopMutationTargetIds.length !== 0
      || !validateStopCancellationRequests(final.cancellationRequests, final.sessionId)
      || !validateStopContentState(final.contentState, final.sessionId)
      || !validateStopWorkerEvidence(final.worker, final.sessionId, final.firstBatchMessageId, final.secondBatchMessageId)) {
    throw new Error('Production Stop Auto did not retain accepted DOM without pending writes.');
  }
  return { sessionId: final.sessionId, firstBatch: first, secondBatch: second, firstPhysical: firstSettlement, heldPhysical: secondSettlement, final };
}

export async function reconcileFinalPageTranslationStop({ bridge, state, contract, capabilities, artifact, secrets = [], timeoutMs = 3000 }) {
  let rawSnapshot = null;
  try {
    rawSnapshot = await withTimeout(Promise.resolve(bridge.operationSnapshot()), timeoutMs, 'final Stop Auto operation snapshot');
    const snapshot = validateProviderOperationSnapshot(rawSnapshot, contract);
    const proof = validatePageTranslationStopOperation(snapshot);
    if (!state?.stopAutoComplete || state.stopAutoProof?.sessionId !== proof.sessionId
        || state.stopAutoProof.firstBatchMessageId !== proof.firstBatch.messageId
        || state.stopAutoProof.secondBatchMessageId !== proof.secondBatch.messageId) throw new Error('Driver and authenticated collector Stop Auto proofs differ.');
    artifact.providerOperation = { attempted: true, stopAuto: true, snapshot };
    capabilities.providerOperation = capability('SUPPORTED', { source: 'authenticated-production-stop-auto-loopback-cancellation', sessionId: proof.sessionId, reportCount: snapshot.reports.length });
    return { ok: true, proof, snapshot };
  } catch (error) {
    const reason = sanitizePrivate(`Final Stop Auto reconciliation failed: ${error.message}`, secrets);
    capabilities.pageTranslationStopProof = capability('FAILED', { reason });
    capabilities.providerOperation = capability('FAILED', { reason });
    artifact.providerOperation = { attempted: true, stopAuto: true, status: 'FAILED', reason,
      finalSnapshot: boundedProviderSnapshotDiagnostic(rawSnapshot, secrets, contract) };
    return { ok: false, reason };
  }
}

export async function reconcileFinalProviderOperation({ bridge, state, contract, capabilities, artifact, secrets = [], timeoutMs = 3000 }) {
  let snapshot; let rawSnapshot = null;
  try {
    rawSnapshot = await withTimeout(Promise.resolve(bridge.operationSnapshot()), timeoutMs, 'final provider operation snapshot');
    snapshot = rawSnapshot;
    snapshot = validateProviderOperationSnapshot(snapshot, contract);
  } catch (error) {
    const reason = sanitizePrivate(`Final provider operation snapshot failed: ${error.message}`, secrets);
    capabilities.providerOperation = capability('FAILED', { reason });
    if (state?.attempted && capabilities.providerPhysicalRequest?.status === 'NOT_TESTED') capabilities.providerPhysicalRequest = capability('FAILED', { reason });
    artifact.providerOperation = { status: 'FAILED', reason, finalSnapshot: boundedProviderSnapshotDiagnostic(rawSnapshot, secrets, contract) };
    return { ok: false, reason };
  }
  if (!state?.attempted) {
    capabilities.providerOperation = retainExecutedCapability(capabilities.providerOperation, 'Provider operation was not released because a prerequisite failed.');
    artifact.providerOperation = sanitizePrivate({ attempted: false, snapshot }, secrets);
    return { ok: capabilities.providerOperation.status === 'NOT_TESTED', snapshot };
  }

  if (state.providerOnly === true) {
    const event = name => snapshot.reports.filter(report => report.event === name);
    const physical = event('physical-start'); const settled = event('physical-settled');
    const invocations = event('provider-invoked'); const parsers = event('parser-success'); const providers = event('provider-settled');
    const proofOk = snapshot.stopped && snapshot.stopCode === 'COMPLETED' && !snapshot.failure
      && invocations.length === 1 && physical.length === 1 && settled.length === 1 && parsers.length === 1 && providers.length === 1
      && settled[0].evidence.attemptId === physical[0].evidence.attemptId && settled[0].evidence.outcome === 'fulfilled'
      && settled[0].evidence.status === 200 && settled[0].evidence.code === null
      && parsers[0].evidence.resultsMatch === true && providers[0].evidence.outcome === 'fulfilled'
      && invocations[0].evidence.sessionId === physical[0].evidence.sessionId && parsers[0].evidence.sessionId === invocations[0].evidence.sessionId
      && providers[0].evidence.sessionId === invocations[0].evidence.sessionId
      && state.proxyCorrelation?.ok === true;
    if (!proofOk) {
      const reason = 'Provider-only final proof lacks an exact proxy/native correlation, fulfilled HTTP 200, parser success, or fulfilled provider settlement.';
      capabilities.providerOperation = capability('FAILED', { reason });
      artifact.providerOperation = { attempted: true, status: 'FAILED', reason, finalSnapshot: snapshot };
      return { ok: false, reason, snapshot };
    }
    capabilities.providerOperation = capability('SUPPORTED', { source: 'authenticated-provider-only-loopback-tls-proxy', physicalStatus: 200, parserSuccess: true, providerSettled: true });
    capabilities.domAcceptance = notTested('Provider-only prototype does not exercise page translation or inspect DOM acceptance.');
    capabilities.providerRestore = notTested('Provider-only prototype does not exercise Stop/Restore.');
    artifact.providerOperation = { attempted: true, snapshot };
    return { ok: true, snapshot };
  }

  let reason = null;
  if (!snapshot.released || !snapshot.stopped || (state.stopCode && snapshot.stopCode !== state.stopCode)) reason = 'Provider operation release/stop state differs from the driver lifecycle.';
  if (state.receiptDecision === 'stop' && (!snapshot.stopped || !providerStopCodes.has(snapshot.stopCode))) reason ??= 'Authenticated stop release receipt has no recognized final stop code.';
  const reportError = snapshot.reports.find(report => report.event === 'error');
  if (snapshot.failure && (!reportError || reportError.evidence.code !== snapshot.failure.code)) reason ??= 'Operation failure snapshot has no matching authenticated error report.';
  const byEvent = event => snapshot.reports.find(report => report.event === event)?.evidence;
  const physicals = snapshot.reports.filter(report => report.event === 'physical-start').map(report => report.evidence);
  const settlements = snapshot.reports.filter(report => report.event === 'physical-settled').map(report => report.evidence);
  const invocations = snapshot.reports.filter(report => report.event === 'provider-invoked').map(report => report.evidence);
  const parsers = snapshot.reports.filter(report => report.event === 'parser-success').map(report => report.evidence);
  const physical = physicals[0];
  const parser = byEvent('parser-success'); const command = byEvent('command-result'); const translated = byEvent('translated'); const restored = byEvent('restored');
  if (snapshot.stopCode === 'COMPLETED') {
    const requiredEvents = ['armed', 'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'command-result', 'translated', 'restored'];
    if (requiredEvents.some(event => !byEvent(event)) || snapshot.failure || snapshot.restoreDecision !== 'restore'
        || settlements.length !== physicals.length || physicals.some(item => !settlements.some(settled => settled.attemptId === item.attemptId))
        || parsers.length !== invocations.length || invocations.length === 0
        || parser?.resultsMatch !== true || command?.success !== true || translated?.domMatches !== true || restored?.restoreObserved !== true) reason ??= 'Provider operation omitted required native consumption, DOM, or restore proof.';
    const providerSettlements = snapshot.reports.filter(report => report.event === 'provider-settled').map(report => report.evidence);
    if (providerSettlements.some(item => item.outcome !== 'fulfilled')) reason ??= 'Provider settlement did not fulfill.';
    const requiresBiDiProviderInterception = capabilities.loopbackTlsProxy?.status !== 'SUPPORTED';
    const requiredProviderCapabilities = [
      'providerPhysicalRequest', ...(requiresBiDiProviderInterception ? ['backgroundProviderInterception', 'providerDataCollector'] : []),
      'providerRequestBody', 'providerResponse', 'providerConsumption', 'domAcceptance', 'providerRestore',
    ];
    if (requiredProviderCapabilities.some(name => capabilities[name]?.status !== 'SUPPORTED')) {
      reason ??= 'A required provider physical/interception/body/response/consumption/DOM/restore capability was not supported.';
    }
  }
  if (reportError) applyProviderOperationError(capabilities, reportError.evidence.code);
  const protocolFailure = reportError?.evidence.code === 'PROTOCOL_ERROR' || snapshot.failure?.code === 'PROTOCOL_ERROR';
  if (protocolFailure) {
    reason ??= 'Authenticated provider operation reported a protocol failure.';
    capabilities.providerOperation = capability('FAILED', { reason });
  }
  else if (!reason && snapshot.stopCode === 'INTERCEPTION_UNSUPPORTED' && physical && capabilities.providerPhysicalRequest.status === 'SUPPORTED' && capabilities.backgroundProviderInterception.status === 'UNSUPPORTED') capabilities.providerOperation = capability('UNSUPPORTED', { reason: 'Native provider request was proven but a matching BiDi interception was unavailable.' });
  else if (!reason && snapshot.stopCode === 'BODY_UNSUPPORTED' && physical && capabilities.providerPhysicalRequest.status === 'SUPPORTED' && capabilities.backgroundProviderInterception.status === 'SUPPORTED' && capabilities.providerRequestBody.status === 'UNSUPPORTED') capabilities.providerOperation = capability('UNSUPPORTED', { reason: 'The intercepted native request body was unavailable.' });
  else if (reason || snapshot.stopCode !== 'COMPLETED') capabilities.providerOperation = capability('FAILED', { reason: reason ?? `Provider operation stopped with ${snapshot.stopCode ?? 'no stop code'}.` });
  else capabilities.providerOperation = capability('SUPPORTED', { stopCode: 'COMPLETED', reportCount: snapshot.reports.length });
  if (reason && capabilities.providerPhysicalRequest.status === 'NOT_TESTED') capabilities.providerPhysicalRequest = capability('FAILED', { reason });
  const safeSnapshot = sanitizePrivate(snapshot, secrets);
  artifact.providerOperation = { attempted: true, snapshot: safeSnapshot };
  if (reportError) artifact.providerOperation.error = { code: reportError.evidence.code };
  return { ok: !reason && ['SUPPORTED', 'UNSUPPORTED'].includes(capabilities.providerOperation.status), reason, snapshot: safeSnapshot };
}

function boundedProviderSnapshotDiagnostic(snapshot, secrets, contract) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { available: false, valueType: snapshot === null ? 'null' : typeof snapshot };
  const reportCount = Array.isArray(snapshot.reports) && Number.isSafeInteger(snapshot.reports.length) ? snapshot.reports.length : null;
  const reports = Array.isArray(snapshot.reports) ? snapshot.reports.slice(0, 64).flatMap(report => {
    try {
      return [validateProviderOperationReport(report, {
        ...contract, event: report?.event, opSeq: report?.opSeq,
        extensionId: contract?.extensionId, fixtureUrl: contract?.fixtureUrl, tabId: contract?.tabId,
      })];
    } catch { return []; }
  }) : [];
  const diagnosticRejections = snapshot.rejections && typeof snapshot.rejections === 'object' ? {
    originOrType: Number.isSafeInteger(snapshot.rejections.originOrType) && snapshot.rejections.originOrType >= 0 && snapshot.rejections.originOrType <= 1000 ? snapshot.rejections.originOrType : null,
    protocol: Number.isSafeInteger(snapshot.rejections.protocol) && snapshot.rejections.protocol >= 0 && snapshot.rejections.protocol <= 1000 ? snapshot.rejections.protocol : null,
  } : null;
  const lastRejection = sanitizeProviderLastRejection(snapshot.lastRejection, secrets);
  const diagnostic = sanitizePrivate({
    available: true, op: snapshot.op === operationName ? operationName : null,
    released: typeof snapshot.released === 'boolean' ? snapshot.released : null,
    restoreDecision: snapshot.restoreDecision === null || ['restore', 'stop'].includes(snapshot.restoreDecision) ? snapshot.restoreDecision : null,
    stopped: typeof snapshot.stopped === 'boolean' ? snapshot.stopped : null,
    stopCode: snapshot.stopCode === null || providerStopCodes.has(snapshot.stopCode) ? snapshot.stopCode : null,
    rejections: diagnosticRejections,
    failure: snapshot.failure === null ? null : snapshot.failure && typeof snapshot.failure === 'object'
      ? { code: providerStopCodes.has(snapshot.failure.code) ? snapshot.failure.code : null } : null,
    ...(lastRejection ? { lastRejection } : {}),
    reportCount,
    reports,
  }, secrets);
  if (Buffer.byteLength(JSON.stringify(diagnostic)) <= 65536) return diagnostic;
  const bounded = { ...diagnostic, reports: [], reportsTruncated: true };
  if (Buffer.byteLength(JSON.stringify(bounded)) <= 65536) return bounded;
  return { available: true, op: operationName, released: null, restoreDecision: null, stopped: null, stopCode: null,
    rejections: null, failure: null, reportCount: null, reports: [], reportsTruncated: true };
}

function sanitizeProviderLastRejection(value, secrets) {
  if (value == null) return null;
  const keys = ['event', 'opSeq', 'reason', 'released', 'armed', 'stopped', 'sessionMatchesAdmitted', 'invocationKnown', 'attemptKnown', 'codeKnown', 'code', 'success', 'outcome'];
  const hasStopStage = Object.hasOwn(value, 'stopStage');
  if (!(operationExact(value, keys) || hasStopStage && operationExact(value, [...keys, 'stopStage'])) || (!operationEvents.has(value.event) && value.event !== 'unknown')
      || (value.opSeq !== null && (!Number.isSafeInteger(value.opSeq) || value.opSeq < 0 || value.opSeq > 65))
      || !['ENVELOPE_INVALID', 'SEQUENCE_INVALID', 'LIMIT_EXCEEDED', 'OPERATION_FAILED', 'EVENT_INVALID'].includes(value.reason)
      || ['released', 'armed', 'stopped', 'sessionMatchesAdmitted', 'codeKnown'].some(key => typeof value[key] !== 'boolean')
      || ['invocationKnown', 'attemptKnown'].some(key => value[key] !== null && typeof value[key] !== 'boolean')
      || (value.code !== null && !providerDiagnosticCodes.has(value.code))
      || (hasStopStage && value.stopStage !== null && !PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES.includes(value.stopStage))
      || (value.success !== null && typeof value.success !== 'boolean')
      || (value.outcome !== null && !['fulfilled', 'rejected', 'cancelled'].includes(value.outcome))) return null;
  return sanitizePrivate(Object.fromEntries([...keys, ...(hasStopStage ? ['stopStage'] : [])].map(key => [key, value[key]])), secrets);
}

function applyProviderOperationError(capabilities, code) {
  if (code === 'INTERCEPTION_UNSUPPORTED') capabilities.backgroundProviderInterception = capability('UNSUPPORTED', { reason: 'Authenticated operation reports that matching BiDi interception is unavailable.' });
  if (code === 'BODY_UNSUPPORTED') capabilities.providerRequestBody = capability('UNSUPPORTED', { reason: 'Authenticated operation reports request body collection is unavailable.' });
  if (code === 'INVALID_BODY') capabilities.providerRequestBody = capability('FAILED', { reason: 'Authenticated operation rejected the Edge request body.' });
  if (code === 'PROTOCOL_ERROR') capabilities.providerOperation = capability('FAILED', { reason: 'Authenticated provider operation protocol error.' });
  if (code === 'TIMEOUT' && capabilities.providerPhysicalRequest.status === 'NOT_TESTED') capabilities.providerPhysicalRequest = capability('FAILED', { reason: 'Authenticated provider operation timed out before native physical proof.' });
}

export function validateEdgeProviderCorrelation(invocation, physical, request) {
  if (!invocation || !physical || !request || !validEdgePageTranslateUrl(physical.url) || !validEdgePageTranslateUrl(request.url)
      || request.isBlocked !== true || request.method !== 'POST' || request.url !== physical.url
      || (request.redirectCount != null && request.redirectCount !== 0)
      || physical.method !== 'POST' || physical.invocationId !== invocation.invocationId || physical.sessionId !== invocation.sessionId
      || physical.messageId !== invocation.messageId || request.method !== physical.method) {
    throw new Error('Native Edge attempt and paused BiDi request identity do not match.');
  }
  if (Number.isSafeInteger(request.bodySize) && request.bodySize > 0 && request.bodySize !== physical.bodyBytes) throw new Error('BiDi and native Edge body byte counts differ.');
  return true;
}

export function validateEdgeBodyAgainstNative(decoded, physical, fixtureTexts) {
  if (!Array.isArray(fixtureTexts) || fixtureTexts.length !== 12 || new Set(fixtureTexts).size !== 12) throw new TypeError('Provider fixture source oracle must contain twelve unique target texts.');
  const bodyHash = createHash('sha256').update(decoded.bytes).digest('hex');
  const indexByText = new Map(fixtureTexts.map((text, index) => [text, index]));
  const sourceIndexes = decoded.body.map(text => indexByText.get(text));
  if (decoded.bytes.length !== physical.bodyBytes || bodyHash !== physical.bodyHash.toLowerCase()
      || sourceIndexes.some(index => index === undefined) || new Set(sourceIndexes).size !== sourceIndexes.length
      || JSON.stringify(sourceIndexes) !== JSON.stringify(physical.sourceIndexes)) throw new Error('Native Edge request body differs from authenticated physical evidence or known fixture targets.');
  return { body: decoded.body, sourceIndexes, bodyBytes: decoded.bytes.length, bodyHash };
}

export async function setupProviderDataCollector(bidi, capabilities) {
  try {
    const response = await bidi.command('network.addDataCollector', { collectorType: 'blob', dataTypes: ['request'], maxEncodedDataSize: 65536 });
    const collectorId = response.result?.collector ?? null;
    capabilities.providerDataCollector = collectorId
      ? capability('SUPPORTED', { collectorType: 'blob', dataTypes: ['request'], maxEncodedDataSize: 65536 })
      : capability('UNSUPPORTED', { reason: 'network.addDataCollector returned no collector ID; the native provider path remains enabled.' });
    return collectorId;
  } catch (error) {
    if (bidi.protocolError) throw error;
    const unsupported = ['unknown command', 'unsupported operation', 'no such network data', 'no-such-network-data'].includes(error.code);
    capabilities.providerDataCollector = capability(unsupported ? 'UNSUPPORTED' : 'FAILED', { reason: sanitizePrivate(`BiDi request data collector setup failed: ${error.code ?? error.message}`) });
    return null;
  }
}

export async function removeProviderNetworkControls({ bidi, collectorId, interceptId, secrets = [], timeoutMs = 3000 }) {
  const errors = [];
  if (collectorId) {
    try { await withTimeout(bidi.command('network.removeDataCollector', { collector: collectorId }), timeoutMs, 'remove network data collector'); }
    catch (error) { errors.push(sanitizePrivate(`Request data collector removal failed: ${error.message}`, secrets)); }
  }
  if (interceptId) {
    try { await withTimeout(bidi.command('network.removeIntercept', { intercept: interceptId }), timeoutMs, 'remove network intercept'); }
    catch (error) { errors.push(sanitizePrivate(`BiDi intercept removal failed: ${error.message}`, secrets)); }
  }
  return { ok: errors.length === 0, errors };
}

export async function runEdgeFrenchProviderProbe({ bridge, bidi, dispatcher, collectorId, fixtureTexts, runId, extensionId, fixtureUrl, tabId, startupSender = null, capabilities, timeoutMs = 12000, loopbackProxy = null, providerOnly = false, stopAutoMode = false }) {
  if (!Array.isArray(fixtureTexts) || fixtureTexts.length !== 12 || new Set(fixtureTexts).size !== 12 || fixtureTexts.some(text => typeof text !== 'string' || !text.trim())) throw new TypeError('Provider fixture source oracle must contain twelve unique target texts.');
  const state = { attempted: false, released: false, receiptDecision: null, stopped: false, stopCode: null, providerOnly, stopAutoMode, proxyCorrelation: null, providerInvocation: null, stopAutoProof: null, stopAutoComplete: false, stopAutoDiagnostics: [], schedulerBatchAccepted: null, stopAutoCommand: null, reports: [], cursor: 0, pendingReports: [], invocations: new Map(), schedulerBatches: new Map(), attempts: new Map(), parsers: new Map(), providerSettlements: new Map(), successfulCoverage: new Map(), invocation: null, armed: null, physical: null, physicalStarts: [], requests: [], bodyProofs: [], settlements: [], request: null, bodyProof: null, physicalSettlement: null, parser: null, command: null, translated: null, restored: null, error: null, contract: { runId, extensionId, fixtureUrl, tabId } };
  let operationDeadline = 0;
  const candidateBuffer = [];
  const seenRequestIds = new Set();
  const failHeld = async (event, reason) => {
    if (event?.action === 'provider-held') await dispatcher.failProviderRequest(event, reason);
  };
  let failPendingRequests = async () => {};
  const stop = async code => {
    if (state.stopped) return;
    try { await failPendingRequests(`provider-operation-${code.toLowerCase()}`); }
    catch (error) { state.error ??= sanitizePrivate(`Could not fail every held provider request: ${error.message}`, [runId]); }
    state.stopCode = code;
    try { await bridge.stopProviderProbe(code); state.stopped = true; }
    catch (error) { state.error ??= sanitizePrivate(`Could not stop provider operation: ${error.message}`, [runId]); }
  };
  const collectSnapshot = () => {
    const snapshot = bridge.operationSnapshot();
    if (!snapshot || !Array.isArray(snapshot.reports) || snapshot.reports.length > 64) throw new Error('Provider operation snapshot is invalid while collecting reports.');
    return snapshot;
  };
  const wait = async (expected, predicate = () => true) => {
    const events = Array.isArray(expected) ? expected : [expected];
    const server = bridge.server;
    while (Date.now() < operationDeadline) {
      let wake;
      let listener;
      let timer;
      if (server?.on && server?.removeListener) {
        wake = new Promise(resolve => {
          listener = () => resolve();
          server.on('runtime-provider-operation', listener);
          timer = setTimeout(resolve, Math.max(1, operationDeadline - Date.now()));
        });
      }
      try {
        const snapshot = collectSnapshot();
        const raw = snapshot.reports.find(item => item?.opSeq === state.cursor + 1);
        if (raw) {
          const report = validateProviderOperationReport(raw, {
            ...state.contract, event: raw?.event, opSeq: raw?.opSeq, extensionId, fixtureUrl, tabId,
            priorSender: raw?.event === 'armed' ? startupSender : null,
          });
          state.cursor = report.opSeq;
          state.reports.push(report);
          if (providerOnly && report.event === 'provider-invoked') state.providerInvocation = { stage: 'provider-invoked', code: null };
          if (providerOnly && report.event === 'error' && state.receiptDecision === 'start'
              && state.reports.some(item => item.event === 'armed') && !state.reports.some(item => item.event === 'provider-invoked')) {
            state.providerInvocation = { stage: 'provider-only-invoke', code: providerStopCodes.has(report.evidence.code) ? report.evidence.code : 'PROTOCOL_ERROR' };
          }
          if (stopAutoMode && report.event === 'stop-auto-command') state.stopAutoCommand = report.evidence;
          if (stopAutoMode && report.event === 'stop-auto-final') state.stopAutoProof = report.evidence;
          if (stopAutoMode && report.event === 'stop-auto-diagnostic') state.stopAutoDiagnostics.push(report.evidence);
          state.pendingReports.push(report);
        }
        const index = state.pendingReports.findIndex(report => events.includes(report.event) && predicate(report));
        if (index >= 0) return state.pendingReports.splice(index, 1)[0];
        if (raw) continue;
        if (snapshot.reports.some(item => item?.opSeq > state.cursor)) throw new Error(`Provider operation opSeq gap after ${state.cursor}.`);
        if (server?.on && server?.removeListener) await wake;
        else {
          try { await withTimeout(bridge.waitForOperation(events[0], { timeoutMs: Math.max(1, operationDeadline - Date.now()) }), Math.max(1, operationDeadline - Date.now()), `provider operation ${events.join('|')}`); }
          catch (error) { if (Date.now() >= operationDeadline) throw error; }
          await delay(5);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (listener) server.removeListener('runtime-provider-operation', listener);
      }
    }
    throw Object.assign(new Error(`Timed out waiting for provider operation ${events.join('|')}`), { code: 'timeout' });
  };
  const markFailure = (name, reason) => { capabilities[name] = capability('FAILED', { reason }); };
  const markLaterNotTested = reason => {
    for (const name of ['providerResponse', 'providerConsumption', 'domAcceptance', 'providerRestore']) capabilities[name] = retainExecutedCapability(capabilities[name], reason);
  };
  const recordAttemptOutcome = (physical, outcome) => {
    state.attempts.set(physical.attemptId, { physical, ...outcome });
    state.physical = { evidence: physical };
    state.physicalStarts.push(physical);
    if (outcome.request) state.request = outcome.request;
    if (outcome.request) state.requests.push(outcome.request);
    if (outcome.bodyProof) state.bodyProof = outcome.bodyProof;
    if (outcome.bodyProof) state.bodyProofs.push(outcome.bodyProof);
    if (outcome.settlement) state.settlements.push(outcome.settlement);
    if (outcome.settlement) state.physicalSettlement = { evidence: outcome.settlement };
  };
  const candidateMatches = (candidate, physical) => candidate.request.url === physical.url && candidate.request.method === physical.method
    && candidate.bodyProof.bodyBytes === physical.bodyBytes && candidate.bodyProof.bodyHash === physical.bodyHash.toLowerCase()
    && JSON.stringify(candidate.bodyProof.sourceIndexes) === JSON.stringify(physical.sourceIndexes);
  const failCachedCandidates = async reason => {
    for (const candidate of candidateBuffer.splice(0)) await failHeld(candidate.request, reason);
    const pending = await dispatcher.failPendingProviderRequests?.(reason) ?? [];
    if (pending.some(result => !result.ok)) throw new Error('One or more held provider requests could not be failed.');
  };
  failPendingRequests = failCachedCandidates;
    const acquireCandidate = async physical => {
    if (loopbackProxy) {
      const held = loopbackProxy.waitForRequest
        ? await loopbackProxy.waitForRequest({ match: request => new URL(request.url, 'https://edge.microsoft.com').toString() === physical.url && request.method === physical.method
          && request.bodyBytes === physical.bodyBytes && request.bodyHash === physical.bodyHash.toLowerCase()
          && request.sni === 'edge.microsoft.com' && request.host === 'edge.microsoft.com'
          && JSON.stringify(request.sourceIndexes) === JSON.stringify(physical.sourceIndexes),
        timeoutMs: Math.max(1, operationDeadline - Date.now()) })
        : await withTimeout(loopbackProxy.pending, Math.max(1, operationDeadline - Date.now()), 'loopback TLS Edge request');
      const request = held.request ?? held;
      const url = new URL(request.url, 'https://edge.microsoft.com').toString();
      const bodyProof = { bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: request.sourceIndexes };
      if (url !== physical.url || request.method !== physical.method || bodyProof.bodyBytes !== physical.bodyBytes
          || bodyProof.bodyHash !== physical.bodyHash.toLowerCase() || request.sni !== 'edge.microsoft.com' || request.host !== 'edge.microsoft.com'
          || JSON.stringify(bodyProof.sourceIndexes) !== JSON.stringify(physical.sourceIndexes)) {
        held.reject(); throw Object.assign(new Error('Loopback TLS request did not match exact authenticated native request bytes and indexes.'), { code: 'INVALID_BODY' });
      }
      state.proxyCorrelation ??= [];
      state.proxyCorrelation.push({ ok: true, requestId: request.requestId ?? null, bodyBytes: bodyProof.bodyBytes, bodyHash: bodyProof.bodyHash, sourceIndexes: bodyProof.sourceIndexes, url, method: request.method });
      return { request: { url, method: request.method, requestId: request.requestId ?? 'loopback-tls-request', isBlocked: true, bodySize: request.bodyBytes, action: 'loopback-tls-held', sourceIndexes: request.sourceIndexes, bodyHash: request.bodyHash, held }, bodyProof };
    }
    while (Date.now() < operationDeadline) {
      const cachedIndex = candidateBuffer.findIndex(candidate => candidateMatches(candidate, physical));
      if (cachedIndex >= 0) return candidateBuffer.splice(cachedIndex, 1)[0];
      const remaining = Math.max(1, operationDeadline - Date.now());
      let request;
      try {
        request = await dispatcher.waitForProviderRequest(event => event.classification?.kind === 'provider-translation' && event.method === 'POST'
          && (!collectorId ? event.url === physical.url && event.bodySize === physical.bodyBytes : true),
          { timeoutMs: Math.max(1, Math.min(2000, remaining - Math.min(500, remaining / 4))) });
      } catch (error) {
        if (Date.now() >= operationDeadline || /^Timed out waiting for intercepted Edge request/.test(error.message)) error.code = 'timeout';
        throw error;
      }
      if (!request.isBlocked || request.observedAt < state.releasedAt) {
        await failHeld(request, 'provider-request-outside-release-window');
        throw new Error(request.isBlocked ? 'Edge request predates provider release.' : 'Edge candidate was not paused by BiDi.');
      }
      if (seenRequestIds.has(request.requestId)) throw new Error('BiDi repeated a provider request ID.');
      seenRequestIds.add(request.requestId);
      if (!validEdgePageTranslateUrl(request.url) || request.redirectCount !== 0 && request.redirectCount != null) {
        await failHeld(request, 'invalid-edge-candidate');
        throw new Error('Observed Edge candidate did not match the fixed Edge/fr endpoint contract.');
      }
      if (!collectorId) {
        await failHeld(request, 'request-body-unavailable');
        capabilities.backgroundProviderInterception = capability('SUPPORTED', { requestId: request.requestId, attemptId: physical.attemptId, url: request.url, method: request.method });
        capabilities.providerRequestBody = capability('UNSUPPORTED', { reason: capabilities.providerDataCollector.reason ?? 'BiDi request body collector unavailable.' });
        throw Object.assign(new Error('Intercepted native request body is unavailable.'), { code: 'BODY_UNSUPPORTED' });
      }
      let bodyProof;
      try {
        const collected = await bidi.command('network.getData', { request: request.requestId, dataType: 'request', collector: collectorId });
        const decoded = decodeEdgeRequestBody(collected.result);
        const indexByText = new Map(fixtureTexts.map((text, index) => [text, index]));
        const sourceIndexes = decoded.body.map(text => indexByText.get(text));
        if (sourceIndexes.some(index => index === undefined) || new Set(sourceIndexes).size !== sourceIndexes.length) throw new Error('Collected Edge body contains unknown or duplicate fixture source text.');
        bodyProof = { body: decoded.body, sourceIndexes, bodyBytes: decoded.bytes.length, bodyHash: createHash('sha256').update(decoded.bytes).digest('hex') };
      } catch (error) {
        const unsupported = ['no such network data', 'no-such-network-data', 'unknown command', 'unsupported operation'].includes(error.code);
        capabilities.providerRequestBody = capability(unsupported ? 'UNSUPPORTED' : 'FAILED', { reason: sanitizePrivate(error.message) });
        if (unsupported && request.url === physical.url && request.bodySize === physical.bodyBytes) capabilities.backgroundProviderInterception = capability('SUPPORTED', { requestId: request.requestId, attemptId: physical.attemptId, url: request.url, method: request.method });
        if (unsupported) capabilities.providerDataCollector = capability('UNSUPPORTED', { reason: `BiDi request body retrieval unavailable: ${error.code}.` });
        await failHeld(request, 'request-body-unavailable');
        throw Object.assign(error, { code: unsupported ? 'BODY_UNSUPPORTED' : 'INVALID_BODY' });
      }
      const candidate = { request, bodyProof };
      if (candidateMatches(candidate, physical)) return candidate;
      if (candidateBuffer.length >= 16) {
        await failHeld(request, 'provider-candidate-buffer-limit');
        throw new Error('Provider request candidate buffer limit reached.');
      }
      candidateBuffer.push(candidate);
    }
    throw Object.assign(new Error('Timed out waiting for a BiDi body matching an authenticated native attempt.'), { code: 'timeout' });
  };
  const servicePhysical = async physical => {
    const owner = state.invocations.get(physical.invocationId);
    if (!owner || owner.sessionId !== physical.sessionId || owner.messageId !== physical.messageId || JSON.stringify(owner.sourceIndexes) !== JSON.stringify(physical.sourceIndexes)) {
      const reason = 'Authenticated native physical-start is not correlated to its logical invocation/session/source indexes.';
      markFailure('providerPhysicalRequest', reason);
      try {
        const held = await dispatcher.waitForProviderRequest(event => event.classification?.kind === 'provider-translation' && event.url === physical.url, { timeoutMs: Math.max(1, Math.min(500, operationDeadline - Date.now())) });
        await failHeld(held, 'native-invocation-mismatch');
      } catch { /* A missing request is already captured as physical identity failure. */ }
      await stop('PROTOCOL_ERROR');
      try {
        const settlement = await wait('physical-settled');
        if (settlement.evidence.attemptId === physical.attemptId) recordAttemptOutcome(physical, { settlement: settlement.evidence, diagOnly: true });
      } catch { /* Preserve the authenticated identity failure. */ }
      return { failed: true };
    }
    capabilities.providerPhysicalRequest = capability('SUPPORTED', { attemptId: physical.attemptId, invocationId: owner.invocationId, sessionId: owner.sessionId, method: physical.method, url: physical.url, bodyBytes: physical.bodyBytes, bodyHash: physical.bodyHash, sourceIndexes: physical.sourceIndexes });
    let candidate;
    try { candidate = await acquireCandidate(physical); }
    catch (error) {
      const hadUnmatchedCandidates = candidateBuffer.length > 0;
      if (error.code === 'BODY_UNSUPPORTED') {
        capabilities.backgroundProviderInterception = retainExecutedCapability(capabilities.backgroundProviderInterception, 'An exact endpoint/size-matched request was paused, but its body was unavailable.');
        markLaterNotTested('The actual provider request body was unavailable.');
        await stop('BODY_UNSUPPORTED');
      } else if (error.code === 'timeout' && !hadUnmatchedCandidates) {
        capabilities.backgroundProviderInterception = capability('UNSUPPORTED', { reason: 'Native provider physical-start was authenticated, but no matching BiDi request/body arrived within the bounded operation window.' });
        markLaterNotTested('The native physical POST was not paired with matching BiDi request/body evidence.');
        await stop('INTERCEPTION_UNSUPPORTED');
      } else {
        capabilities.backgroundProviderInterception = capability('FAILED', { reason: error.message });
        markLaterNotTested('The observed provider request could not be safely correlated to its native attempt.');
        await stop(providerStopCodes.has(error.code) ? error.code : 'PROTOCOL_ERROR');
      }
      if (candidateBuffer.length) await failCachedCandidates('unmatched-provider-candidate-at-terminal-attempt');
      const settlement = await wait('physical-settled');
      if (settlement.evidence.attemptId === physical.attemptId) recordAttemptOutcome(physical, { settlement: settlement.evidence, diagOnly: true });
      return { failed: error.code !== 'timeout' && error.code !== 'BODY_UNSUPPORTED' || hadUnmatchedCandidates, unsupported: error.code === 'BODY_UNSUPPORTED' || error.code === 'timeout' && !hadUnmatchedCandidates };
    }
    const { request, bodyProof } = candidate;
    try { validateEdgeProviderCorrelation(owner, physical, request); }
    catch (error) {
      capabilities.backgroundProviderInterception = loopbackProxy
        ? notTested('BiDi interception is outside the provider-only TLS proxy lane.')
        : capability('FAILED', { reason: error.message, requestId: request.requestId });
      markLaterNotTested('Observed transport request identity did not match the native physical POST.');
      await failHeld(request, 'native-bidi-correlation-failed'); await stop('PROTOCOL_ERROR');
      const settlement = await wait('physical-settled');
      if (settlement.evidence.attemptId === physical.attemptId) recordAttemptOutcome(physical, { request, settlement: settlement.evidence, diagOnly: true });
      return { failed: true };
    }
    capabilities.backgroundProviderInterception = loopbackProxy
      ? notTested('The actual Edge TLS request was admitted by the loopback proxy, not BiDi interception.')
      : capability('SUPPORTED', { requestId: request.requestId, attemptId: physical.attemptId, url: request.url, method: request.method });
    if (!candidateMatches(candidate, physical)) throw new Error('Transport candidate does not match authenticated native request bytes/hash/source indexes.');
    capabilities.providerRequestBody = capability('SUPPORTED', { bodyBytes: bodyProof.bodyBytes, bodyHash: bodyProof.bodyHash, sourceIndexes: bodyProof.sourceIndexes });
    if (stopAutoMode && state.attempts.size > 0) {
      const firstAttempt = [...state.attempts.values()].find(item => item.successful === true);
      const firstInvocation = firstAttempt && state.invocations.get(firstAttempt.physical.invocationId);
      if (!firstAttempt || !firstInvocation || firstAttempt.physical.sessionId !== owner.sessionId
          || firstInvocation.messageId === owner.messageId) throw new Error('Held request is not a subsequent batch in the first live session.');
      if (!state.parsers.has(firstInvocation.invocationId)) {
        const firstParser = await wait('parser-success', report => report.evidence.invocationId === firstInvocation.invocationId);
        if (firstParser.evidence.resultsMatch !== true || firstParser.evidence.sessionId !== owner.sessionId
            || JSON.stringify(firstParser.evidence.sourceIndexes) !== JSON.stringify(firstInvocation.sourceIndexes)) throw new Error('First provider batch parser result did not match its session and scheduler membership.');
        state.parsers.set(firstInvocation.invocationId, firstParser);
        for (const index of firstInvocation.sourceIndexes) state.successfulCoverage.set(index, firstInvocation.invocationId);
      }
      if (!state.providerSettlements.has(firstInvocation.invocationId)) {
        const firstSettlement = await wait('provider-settled', report => report.evidence.invocationId === firstInvocation.invocationId);
        if (firstSettlement.evidence.outcome !== 'fulfilled' || firstSettlement.evidence.sessionId !== owner.sessionId) throw new Error('First provider root batch did not fulfill before Stop Auto.');
        state.providerSettlements.set(firstInvocation.invocationId, firstSettlement);
      }
       let acceptedBatch = state.schedulerBatchAccepted;
       if (!acceptedBatch) acceptedBatch = await wait('scheduler-batch-accepted');
       state.schedulerBatchAccepted = acceptedBatch;
      const acceptedBatchReport = state.reports.find(report => report.event === 'scheduler-batch-accepted');
      const heldPhysicalReport = state.reports.find(report => report.event === 'physical-start' && report.evidence.attemptId === physical.attemptId);
      const firstBatch = state.schedulerBatches.get(firstInvocation.messageId);
      const expectedFirstIds = firstAttempt.physical.sourceIndexes.map(index => `target-${index}`);
      if (!acceptedBatchReport || !heldPhysicalReport || acceptedBatchReport.opSeq >= heldPhysicalReport.opSeq
          || !firstBatch || acceptedBatch.messageId !== firstInvocation.messageId || acceptedBatch.sessionId !== owner.sessionId
          || JSON.stringify(acceptedBatch.targetIds) !== JSON.stringify(expectedFirstIds)
          || JSON.stringify(acceptedBatch.acceptedTargetIds) !== JSON.stringify(expectedFirstIds)) throw new Error('Stop Auto gate did not follow the fully accepted first actual Scheduler batch.');

      const secondBatch = state.schedulerBatches.get(owner.messageId);
      if (!secondBatch || secondBatch.sessionId !== owner.sessionId
          || JSON.stringify(secondBatch.targetIds.map(id => Number(id.slice(7)))) !== JSON.stringify(physical.sourceIndexes)) throw new Error('Held physical request did not match the second actual Scheduler batch.');
      const decision = bridge.decideStopAuto('stop');
      if (decision !== 'stop') throw new Error('Authenticated Stop Auto gate did not release the real production stop command.');
      const stopCommand = await wait('stop-auto-command');
      state.stopAutoCommand = stopCommand.evidence;
      const stoppedSocket = await loopbackProxy.waitForStatus(request.requestId, 'aborted', { timeoutMs: Math.max(1, operationDeadline - Date.now()) });
      if (stoppedSocket.status !== 'aborted' || stoppedSocket.requestId !== request.requestId) throw new Error('Held loopback TLS socket did not abort after production Stop Auto.');

      const physicalSettlement = await wait('physical-settled', report => report.evidence.attemptId === physical.attemptId);
      const settlementEvidence = physicalSettlement.evidence;
      if (!['rejected', 'cancelled'].includes(settlementEvidence.outcome) || !['ABORTED', 'NETWORK_ERROR', 'FETCH_ERROR'].includes(settlementEvidence.code)
          || settlementEvidence.status !== null || settlementEvidence.sessionId !== owner.sessionId) throw new Error('Held Edge physical attempt did not settle as the real abort.');
      recordAttemptOutcome(physical, { request, bodyProof, settlement: settlementEvidence, successful: false, cancelledByStop: true });
      const providerSettlement = await wait('provider-settled', report => report.evidence.invocationId === owner.invocationId);
      if (!['rejected', 'cancelled'].includes(providerSettlement.evidence.outcome) || providerSettlement.evidence.sessionId !== owner.sessionId) throw new Error('Held provider root promise did not settle after Stop Auto.');
      state.providerSettlements.set(owner.invocationId, providerSettlement);

      const captureDecision = bridge.decideStopAutoSnapshot('capture');
      if (captureDecision !== 'capture') throw new Error('Authenticated final Stop Auto capture gate was not released.');
      const final = await wait('stop-auto-final');
      state.stopAutoProof = { ...final.evidence, stopCommand: state.stopAutoCommand };
      const expectedPending = targetIds012(Array.from({ length: 12 }, (_, index) => `target-${index}`))
        ? Array.from({ length: 12 }, (_, index) => `target-${index}`).filter(id => !expectedFirstIds.includes(id)) : [];
      if (final.evidence.sessionId !== owner.sessionId || final.evidence.secondBatchMessageId !== owner.messageId
          || JSON.stringify(final.evidence.firstBatchTargetIds) !== JSON.stringify(expectedFirstIds)
          || JSON.stringify(final.evidence.secondBatchTargetIds) !== JSON.stringify(physical.sourceIndexes.map(index => `target-${index}`))
          || JSON.stringify(final.evidence.pendingTargetIds) !== JSON.stringify(expectedPending)) throw new Error('Authenticated final Stop Auto proof did not preserve exact batch/session ownership.');
      state.stopAutoComplete = true;
      state.stopCode = 'COMPLETED';
      capabilities.heldRequestAbort = capability('SUPPORTED', { requestId: request.requestId, physicalAttemptId: physical.attemptId, status: 'aborted' });
      capabilities.physicalSettlement = capability('SUPPORTED', { attemptId: physical.attemptId, outcome: settlementEvidence.outcome, code: settlementEvidence.code, status: settlementEvidence.status });
      capabilities.rootSettlement = capability('SUPPORTED', { sessionId: owner.sessionId, messageId: owner.messageId, outcome: providerSettlement.evidence.outcome });
      capabilities.nostaleDOM = capability('SUPPORTED', { acceptedTargetIds: final.evidence.acceptedTargetIds, pendingTargetIds: final.evidence.pendingTargetIds, postStopMutationCount: 0 });
      capabilities.pageTranslationStopProof = capability('SUPPORTED', { sessionId: owner.sessionId, firstBatchMessageId: firstInvocation.messageId, heldBatchMessageId: owner.messageId, cancellationAcknowledged: true });
      capabilities.providerOperation = capability('SUPPORTED', { source: 'real-page-stop-auto-loopback-provider-cancellation', sessionId: owner.sessionId, batches: 2 });
      await stop('COMPLETED');
      return { failed: false, cancelled: true };
    }
    if (loopbackProxy) {
      const responseBody = JSON.stringify(mapEdgeResponse(bodyProof.sourceIndexes.map(index => fixtureTexts[index])));
      await request.held.release(responseBody);
      request.action = 'loopback-tls-response'; request.requestResolved = true;
      capabilities.providerResponse = capability('SUPPORTED', { statusCode: 200, responseBodyBytes: Buffer.byteLength(responseBody), source: 'loopback-tls-proxy' });
      const settlement = await wait('physical-settled');
      if (settlement.evidence.attemptId !== physical.attemptId || settlement.evidence.outcome !== 'fulfilled' || settlement.evidence.status !== 200 || settlement.evidence.code !== null) throw new Error('Native settlement did not fulfill the loopback TLS 200 response.');
      recordAttemptOutcome(physical, { request, bodyProof, settlement: settlement.evidence, successful: true });
      return { failed: false };
    }
    let provided;
    const responseBody = JSON.stringify(mapEdgeResponse(bodyProof.body));
    try {
      provided = await bidi.command('network.provideResponse', {
        request: request.requestId, statusCode: 200, reasonPhrase: 'OK',
        headers: [{ name: 'Content-Type', value: { type: 'string', value: 'application/json' } }],
        body: { type: 'string', value: responseBody },
      });
      if (provided?.type !== 'success' || !provided.result || typeof provided.result !== 'object' || Array.isArray(provided.result)) throw new Error('BiDi did not acknowledge the controlled provider response.');
    } catch (error) {
      const unsupported = ['unknown command', 'unsupported operation'].includes(error.code);
      capabilities.providerResponse = capability(unsupported ? 'UNSUPPORTED' : 'FAILED', { reason: sanitizePrivate(error.message) });
      markLaterNotTested('The actual Edge response was not successfully provided to the paused native request.');
      await failHeld(request, 'provider-response-failed'); await stop('PROTOCOL_ERROR');
      const settlement = await wait('physical-settled');
      if (settlement.evidence.attemptId === physical.attemptId) recordAttemptOutcome(physical, { request, bodyProof, settlement: settlement.evidence, diagOnly: true });
      return { unsupported, failed: !unsupported };
    }
    request.action = 'provider-response-synthetic'; request.commandResponse = provided; request.requestResolved = true;
    capabilities.providerResponse = capability('SUPPORTED', { requestId: request.requestId, statusCode: 200, responseBodyBytes: Buffer.byteLength(responseBody) });
    const settlement = await wait('physical-settled');
    if (settlement.evidence.attemptId !== physical.attemptId || settlement.evidence.sessionId !== owner.sessionId) throw new Error('Native settlement does not match the intercepted attempt/session.');
    recordAttemptOutcome(physical, { request, bodyProof, settlement: settlement.evidence, successful: settlement.evidence.outcome === 'fulfilled' && settlement.evidence.status === 200 && settlement.evidence.code === null });
    return { failed: false };
  };

  try {
    const initial = validateProviderOperationSnapshot(bridge.operationSnapshot(), { runId, extensionId, fixtureUrl, tabId });
    const prearmed = initial.reports.length === 1 && initial.reports[0].event === 'armed';
    if ((!prearmed && initial.reports.length !== 0) || initial.released || initial.stopped || initial.failure) throw new Error('Provider operation snapshot was not idle or waiting at the authenticated arm gate.');
    state.attempted = true;
    if (prearmed) { state.cursor = initial.reports[0].opSeq; state.armed = initial.reports[0]; state.reports.push(initial.reports[0]); }
    state.releasedAt = Date.now();
    operationDeadline = state.releasedAt + timeoutMs;
    state.receiptDecision = validateProviderReleaseReceipt(await bridge.releaseProviderProbe());
    state.released = true;
    state.armed ??= await wait('armed');
    const armedSnapshot = collectSnapshot();
    if (!armedSnapshot.released || armedSnapshot.reports[0]?.event !== 'armed') throw new Error('Provider release receipt was not followed by an authenticated armed report.');
    if (state.receiptDecision === 'stop') {
      if (!armedSnapshot.stopped || !providerStopCodes.has(armedSnapshot.stopCode)) throw new Error('Stop release receipt omitted the authenticated provider stop state.');
      state.stopped = true; state.stopCode = armedSnapshot.stopCode;
      const reason = `Authenticated provider arm stopped before a native physical POST (${state.stopCode}); this is not physical or interception proof.`;
      capabilities.providerPhysicalRequest = capability('FAILED', { reason });
      capabilities.backgroundProviderInterception = retainExecutedCapability(capabilities.backgroundProviderInterception, reason);
      capabilities.providerRequestBody = retainExecutedCapability(capabilities.providerRequestBody, reason);
      capabilities.providerOperation = capability('FAILED', { reason });
      markLaterNotTested('Authenticated arm decision selected stop; no native Edge request was initiated.');
      return state;
    }
    if (armedSnapshot.stopped || armedSnapshot.stopCode !== null || armedSnapshot.failure) throw new Error('Start receipt was contradicted by an authenticated stopped/failed operation snapshot.');
    let nativeStarted = false;
    let terminalFailure = null;
    const providerWorkComplete = () => state.invocations.size > 0
      && state.parsers.size === state.invocations.size && state.providerSettlements.size === state.invocations.size
      && [...state.attempts.values()].every(attempt => attempt.settlement)
      && state.successfulCoverage.size === 12 && indexes012([...state.successfulCoverage.keys()].sort((a, b) => a - b));
    const providerProofComplete = () => providerWorkComplete() && (providerOnly || (state.command?.evidence.success === true
      && state.invocation?.evidence.sessionId === state.command.evidence.sessionId));
    const stopAutoProofComplete = () => stopAutoMode && state.stopAutoComplete;
    while (!(stopAutoMode ? stopAutoProofComplete() : providerProofComplete()) && !terminalFailure) {
      let report;
      try { report = await wait(['scheduler-batch', 'scheduler-batch-accepted', 'provider-invoked', 'physical-start', 'parser-success', 'provider-settled', 'command-result', 'error']); }
      catch (error) {
        if (!nativeStarted) markFailure('providerPhysicalRequest', `No authenticated native physical POST was observed during the production command: ${error.message}`);
        else capabilities.providerConsumption = capability('FAILED', { reason: `Native provider operation did not reach exact source coverage: ${error.message}` });
        markLaterNotTested('Provider operation did not complete its native request/parser proof.');
        await stop(error.code === 'timeout' ? 'TIMEOUT' : 'PROTOCOL_ERROR');
        return state;
      }
      if (report.event === 'error') {
        terminalFailure = report.evidence.code;
        applyProviderOperationError(capabilities, terminalFailure);
        if (terminalFailure === 'PROTOCOL_ERROR' && capabilities.providerOperation) capabilities.providerOperation = capability('FAILED', { reason: 'Authenticated provider operation protocol failure.' });
        markLaterNotTested(`Authenticated provider operation stopped with ${terminalFailure}.`);
        await stop(terminalFailure);
      } else if (report.event === 'scheduler-batch') {
        const evidence = report.evidence;
        if (state.schedulerBatches.has(evidence.messageId)
            || [...state.schedulerBatches.values()].some(batch => batch.targetIds.some(id => evidence.targetIds.includes(id)))) {
          throw new Error('Scheduler batch message or target membership was duplicated.');
        }
        state.schedulerBatches.set(evidence.messageId, evidence);
        const invocation = [...state.invocations.values()].find(item => item.messageId === evidence.messageId);
        if (invocation && (invocation.sessionId !== evidence.sessionId
            || JSON.stringify(invocation.sourceIndexes) !== JSON.stringify(evidence.targetIds.map(id => Number(id.slice(7)))))) {
          throw new Error('Scheduler batch did not match its Background provider invocation.');
        }
      } else if (report.event === 'scheduler-batch-accepted') {
        if (!stopAutoMode || state.schedulerBatchAccepted) throw new Error('Unexpected or duplicate accepted Scheduler batch in Stop Auto mode.');
        state.schedulerBatchAccepted = report.evidence;
      } else if (report.event === 'stop-auto-command') {
        if (!stopAutoMode || state.stopAutoCommand) throw new Error('Unexpected or duplicate production Stop Auto command evidence.');
        state.stopAutoCommand = report.evidence;
      } else if (report.event === 'stop-auto-final') {
        if (!stopAutoMode || state.stopAutoProof) throw new Error('Unexpected or duplicate final Stop Auto evidence.');
        state.stopAutoProof = report.evidence;
      } else if (report.event === 'provider-invoked') {
        const invocation = report.evidence;
        if (state.invocations.size >= 12 || state.invocations.has(invocation.invocationId)
            || (state.invocation && invocation.sessionId !== state.invocation.evidence.sessionId)
            || (state.command?.evidence.sessionId && invocation.sessionId !== state.command.evidence.sessionId)) throw new Error('Provider logical invocation exceeded bounds or changed the acknowledged page session.');
        const schedulerBatch = state.schedulerBatches.get(invocation.messageId);
        if (schedulerBatch && (schedulerBatch.sessionId !== invocation.sessionId
            || JSON.stringify(schedulerBatch.targetIds.map(id => Number(id.slice(7)))) !== JSON.stringify(invocation.sourceIndexes))) {
          throw new Error('Background provider invocation did not match its authenticated Scheduler batch.');
        }
        state.invocations.set(invocation.invocationId, invocation);
        state.invocation ??= report;
      } else if (report.event === 'physical-start') {
        nativeStarted = true;
        const physical = report.evidence;
        state.physical = report;
        const result = await servicePhysical(physical);
        if (result.failed || result.unsupported) { terminalFailure = state.stopCode ?? (result.unsupported ? 'INTERCEPTION_UNSUPPORTED' : 'PROTOCOL_ERROR'); break; }
      } else if (report.event === 'parser-success') {
        const invocation = state.invocations.get(report.evidence.invocationId);
        const attempts = [...state.attempts.values()].filter(item => item.physical.invocationId === report.evidence.invocationId);
        const successful = new Map();
        for (const attempt of attempts) if (attempt.successful) for (const index of attempt.physical.sourceIndexes) successful.set(index, (successful.get(index) ?? 0) + 1);
        if (!invocation || report.evidence.sessionId !== invocation.sessionId
            || JSON.stringify(report.evidence.sourceIndexes) !== JSON.stringify(invocation.sourceIndexes)
            || !invocation.sourceIndexes.every(index => successful.get(index) === 1)) throw new Error('Parser success lacks exact-once fulfilled HTTP 200 coverage for its logical invocation.');
        if (invocation.sourceIndexes.some(index => state.successfulCoverage.has(index))) throw new Error('Successful logical batches overlap source coverage.');
        for (const index of invocation.sourceIndexes) state.successfulCoverage.set(index, report.evidence.invocationId);
        state.parsers.set(report.evidence.invocationId, report);
        state.parser = report;
      } else if (report.event === 'provider-settled') {
        if (report.evidence.outcome !== 'fulfilled' || !state.parsers.has(report.evidence.invocationId)) {
          terminalFailure = report.evidence.code ?? 'TEARDOWN';
          capabilities.providerConsumption = capability('FAILED', { reason: 'A logical provider invocation did not fulfill after parser validation.' });
          markLaterNotTested('A logical provider invocation failed.');
          await stop(terminalFailure);
        } else {
          const invocation = state.invocations.get(report.evidence.invocationId);
          if (!invocation || report.evidence.sessionId !== invocation.sessionId || state.providerSettlements.has(report.evidence.invocationId)) throw new Error('Provider settlement duplicated or mismatched a logical invocation.');
          state.providerSettlements.set(report.evidence.invocationId, report);
        }
      } else if (report.event === 'command-result') {
        if (state.command) throw new Error('Production page-translate emitted a duplicate or contradictory command acknowledgment.');
        state.command = report;
        if (!report.evidence.success) {
          if (!nativeStarted) markFailure('providerPhysicalRequest', 'Production page-translate command failed before a native physical request.');
          else capabilities.providerConsumption = capability('FAILED', { reason: 'Production page-translate command failed after native attempts.' });
          markLaterNotTested('Production command did not succeed.');
          await stop(report.evidence.code ?? 'TEARDOWN');
          terminalFailure = report.evidence.code ?? 'TEARDOWN';
        } else if (state.invocation && report.evidence.sessionId !== state.invocation.evidence.sessionId) {
          if (providerWorkComplete()) capabilities.providerConsumption = capability('SUPPORTED', { sessionId: state.invocation.evidence.sessionId, sourceIndexes: [...state.successfulCoverage.keys()].sort((a, b) => a - b), attempts: state.attempts.size, invocations: state.invocations.size });
          capabilities.domAcceptance = capability('FAILED', { reason: 'Production command success belongs to a different session than the fulfilled provider work.' });
          throw new Error('Production page-translate command success belongs to a different session.');
        }
      }
    }
    if (terminalFailure) return state;
    if (stopAutoMode) {
      if (!state.stopAutoComplete || !state.stopAutoProof) throw new Error('Authenticated Stop Auto cancellation proof did not complete.');
      return state;
    }
    if (!providerProofComplete()) throw new Error('Provider acknowledgment did not complete independent parser, settlement, and exact-once source proof.');
    if (candidateBuffer.length || dispatcher.requests?.some(event => event.classification?.kind === 'provider-translation' && event.isBlocked && !event.requestResolved)) {
      await failCachedCandidates('unmatched-provider-request-at-provider-completion');
      throw new Error('Provider work completed while unmatched paused Edge candidates remained.');
    }
    capabilities.providerConsumption = capability('SUPPORTED', { sessionId: state.invocation.evidence.sessionId, sourceIndexes: [...state.successfulCoverage.keys()].sort((a, b) => a - b), attempts: state.attempts.size, invocations: state.invocations.size });
    if (providerOnly) {
      state.stopCode = 'COMPLETED';
      await stop('COMPLETED');
      capabilities.providerOperation = capability('SUPPORTED', { source: 'authenticated-provider-only-proxy-operation', sessionId: state.invocation.evidence.sessionId, physicalStatus: 200, parserSuccess: true, providerSettled: true });
      capabilities.domAcceptance = notTested('Provider-only TLS proxy prototype does not issue page-translate or inspect DOM acceptance.');
      capabilities.providerRestore = notTested('Provider-only TLS proxy prototype does not enter Stop/Restore scenarios.');
      return state;
    }
    const sessionId = state.invocation.evidence.sessionId;
    try {
      state.translated = await wait('translated');
      if (state.translated.evidence.sessionId !== sessionId) throw new Error('Translated DOM evidence belongs to a different session.');
      capabilities.domAcceptance = capability('SUPPORTED', { sessionId, acceptedTargetIds: state.translated.evidence.acceptedTargetIds, acceptedCount: 12, duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true });
    } catch (error) {
      capabilities.domAcceptance = capability('FAILED', { reason: error.message });
      markLaterNotTested('Translated DOM acceptance/session ownership was not proven.');
      await stop(error.code === 'timeout' ? 'TIMEOUT' : 'PROTOCOL_ERROR'); return state;
    }
    try {
      const decision = await bridge.decideRestore('restore');
      if (decision !== 'restore') throw new Error('Runtime bridge rejected the sole post-success restore decision.');
      state.restored = await wait('restored');
      if (state.restored.evidence.sessionId !== sessionId) throw new Error('Restore evidence belongs to a different session.');
      capabilities.providerRestore = capability('SUPPORTED', { sessionId, commandSuccess: true, domMatchesOriginal: true, metadataRestored: true, restoreObserved: true });
      await stop('COMPLETED');
    } catch (error) {
      capabilities.providerRestore = capability('FAILED', { reason: error.message });
      await stop(error.code === 'timeout' ? 'TIMEOUT' : 'PROTOCOL_ERROR');
    }
  } catch (error) {
    state.error = sanitizePrivate(error.message ?? String(error));
    if (capabilities.providerPhysicalRequest.status === 'NOT_TESTED') capabilities.providerPhysicalRequest = capability('FAILED', { reason: `Released provider operation did not produce a validated native physical POST: ${state.error}` });
    for (const name of ['backgroundProviderInterception', 'providerRequestBody', 'providerResponse', 'providerConsumption', 'domAcceptance', 'providerRestore']) {
      capabilities[name] = retainExecutedCapability(capabilities[name], `Provider probe stopped before ${name}: ${state.error}`);
    }
    await stop(error.code === 'timeout' ? 'TIMEOUT' : 'PROTOCOL_ERROR');
  }
  return state;
}

export function providerProbeArtifact(state) {
  const request = state?.request;
  return {
    attempted: state?.attempted === true, released: state?.released === true, receiptDecision: state?.receiptDecision ?? null, stopped: state?.stopped === true, stopCode: state?.stopCode ?? null,
    invocation: state?.invocation?.evidence ?? null,
    physicalStart: state?.physical?.evidence ?? null,
    request: request ? { requestId: request.requestId, url: request.url, method: request.method, bodySize: request.bodySize, isBlocked: request.isBlocked, action: request.action, commandError: request.commandError ?? null } : null,
    requestBody: state?.bodyProof ? { bodyBytes: state.bodyProof.bodyBytes, bodyHash: state.bodyProof.bodyHash, sourceIndexes: state.bodyProof.sourceIndexes } : null,
    physicalSettlement: state?.physicalSettlement?.evidence ?? state?.physicalSettlement ?? null,
    physicalAttempts: [...(state?.attempts?.values?.() ?? [])].map(item => ({
      physicalStart: item.physical, requestId: item.request?.requestId ?? null,
      requestBody: item.bodyProof ? { bodyBytes: item.bodyProof.bodyBytes, bodyHash: item.bodyProof.bodyHash, sourceIndexes: item.bodyProof.sourceIndexes } : null,
      settlement: item.settlement ?? null, successful: item.successful === true, diagnosticOnly: item.diagOnly === true,
    })),
    parser: state?.parser?.evidence ?? null, command: state?.command?.evidence ?? null,
    translated: state?.translated?.evidence ?? null, restored: state?.restored?.evidence ?? null,
    operationReports: state?.reports ?? [], error: state?.error ?? null,
  };
}

export function providerProbeRequiresImmediateTeardown(state, capabilities) {
  return state?.attempted === true && (state.stopCode !== 'COMPLETED'
    || ['providerPhysicalRequest', 'providerConsumption', 'domAcceptance', 'providerRestore'].some(name => capabilities[name]?.status !== 'SUPPORTED'));
}

function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
const indexes012 = value => Array.isArray(value) && value.length === 12 && value.every((item, index) => item === index);
const indexesSubset012 = value => Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every(item => Number.isInteger(item) && item >= 0 && item < 12) && new Set(value).size === value.length;
const targetIds012 = value => Array.isArray(value) && value.length === 12 && value.every((id, index) => id === `target-${index}`);

export function latestRealmObservations(observations) {
  const latestByRealm = new Map();
  for (const observation of observations) latestByRealm.set(observation.realm, observation);
  return [...latestByRealm.values()];
}

export function createRequestDispatcher({ bidi, fixtureOrigin, runtimeReportUrl = null, onProviderRequest = () => {}, maxInFlight = 128 }) {
  const requests = []; const errors = []; const jobs = new Set(); let accepting = true; let droppedRecords = 0; let droppedErrors = 0;
  const providerQueue = []; const providerWaiters = [];
  const recordError = error => { if (errors.length < 64) errors.push(error); else droppedErrors++; };
  const publishProviderRequest = event => {
    const waiting = providerWaiters.findIndex(waiter => waiter.predicate(event));
    if (waiting >= 0) {
      const [waiter] = providerWaiters.splice(waiting, 1); clearTimeout(waiter.timer); waiter.resolve(event); return;
    }
    if (providerQueue.length >= 16) { recordError(new Error('Provider intercept request buffer limit reached; request remains blocked.')); return; }
    providerQueue.push(event);
  };
  const actionFor = async (message, terminal = false) => {
    if (message.method !== 'network.beforeRequestSent') return;
    const params = message.params ?? {}; const request = params.request ?? {};
    const classified = request.url === runtimeReportUrl
      ? request.method === 'POST' ? { kind: 'runtime-bridge-report' } : { kind: 'blocked', reason: `unexpected runtime collector method: ${request.method}` }
      : isEdgeProviderCandidate(request.url) ? { kind: 'provider-translation' }
        : classifyTransportRequest({ method: request.method, url: request.url }, { fixtureOrigin });
    const event = { requestId: request.request, url: request.url, method: request.method, bodySize: request.bodySize ?? null, context: params.context ?? null, redirectCount: params.redirectCount ?? null, observedAt: Date.now(), isBlocked: params.isBlocked === true, requestResolved: false, classification: classified, action: null };
    if (requests.length < 512) requests.push(event);
    else { droppedRecords++; recordError(new Error('Request event evidence limit reached; refusing additional HTTP(S) work.')); }
    const scheme = (() => { try { return new URL(request.url).protocol; } catch { return null; } })();
    if (!request.request) {
      event.action = 'missing-request-id'; recordError(new Error(`BiDi request event has no request id: ${request.url ?? '<missing URL>'}`)); return;
    }
    if (classified.kind === 'provider-translation' && !terminal) {
      event.action = params.isBlocked ? 'provider-held' : 'provider-unpaused';
      publishProviderRequest(event);
      try { await onProviderRequest(event); } catch (error) { recordError(error); }
      return;
    }
    if (!params.isBlocked) {
      if (scheme !== 'http:' && scheme !== 'https:') { event.action = 'ignored-non-network-scheme'; return; }
      event.action = 'unblocked-unobservable';
      recordError(new Error(`HTTP(S) request was not paused with an ID: ${request.url}`));
      return;
    }
    if (terminal) {
      event.action = 'fail-terminal-request';
      try { event.commandResponse = await bidi.command('network.failRequest', { request: request.request }); event.requestResolved = event.commandResponse?.type === 'success'; }
      catch (error) { event.commandError = error.message; recordError(error); }
      recordError(new Error(`HTTP(S) request arrived after request admission closed: ${request.url}`));
      return;
    }
    const action = classifyRequestAction(classified.kind);
    try {
      if (action === 'continue-local') {
        event.action = 'continue-local'; event.commandResponse = await bidi.command('network.continueRequest', { request: request.request }); event.requestResolved = event.commandResponse?.type === 'success'; return;
      }
      if (action === 'continue-runtime-report') {
        event.action = 'continue-exact-runtime-report'; event.commandResponse = await bidi.command('network.continueRequest', { request: request.request }); event.requestResolved = event.commandResponse?.type === 'success'; return;
      }
      if (action === 'provide-known-empty-voices') {
        event.action = 'fixture-voices'; event.commandResponse = await bidi.command('network.provideResponse', { request: request.request, statusCode: 200, headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }], body: { type: 'base64', value: Buffer.from('[]').toString('base64') } }); event.requestResolved = event.commandResponse?.type === 'success'; return;
      }
      event.action = classified.kind === 'provider-translation' ? 'deny-provider-before-verified-context' : 'fail-unexpected';
      event.commandResponse = await bidi.command('network.failRequest', { request: request.request });
      event.requestResolved = event.commandResponse?.type === 'success';
      if (classified.kind === 'provider-translation') recordError(new Error('Edge provider request occurred before both instrumented runtime realms were verified.'));
    } catch (error) { event.commandError = error.message; recordError(error); }
  };
  const onEvent = message => {
    if (message.method !== 'network.beforeRequestSent') return Promise.resolve();
    if (requests.length >= 512) { droppedRecords++; recordError(new Error('Request handler admission stopped at the evidence limit.')); return Promise.resolve(); }
    if (jobs.size >= maxInFlight) {
      const request = message.params?.request ?? {};
      const classified = classifyTransportRequest({ method: request.method, url: request.url }, { fixtureOrigin });
      requests.push({ requestId: request.request, url: request.url, method: request.method, bodySize: request.bodySize ?? null, context: message.params?.context ?? null, redirectCount: message.params?.redirectCount ?? null, observedAt: Date.now(), isBlocked: message.params?.isBlocked === true, requestResolved: false, classification: classified, action: 'fail-closed-overflow' });
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
    waitForProviderRequest(predicate = () => true, { timeoutMs = 10000 } = {}) {
      const index = providerQueue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(providerQueue.splice(index, 1)[0]);
      if (!accepting) return Promise.reject(new Error('BiDi request admission closed before an Edge candidate arrived.'));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = providerWaiters.indexOf(waiter);
          if (waiterIndex >= 0) providerWaiters.splice(waiterIndex, 1);
          reject(new Error(`Timed out waiting for intercepted Edge request; queued ${providerQueue.length} candidate(s).`));
        }, timeoutMs);
        providerWaiters.push(waiter);
      });
    },
    async failProviderRequest(event, reason) {
      if (!event || !event.isBlocked || !event.requestId || event.requestResolved) return { ok: false, reason: 'Request was not held by BiDi or was already resolved.' };
      try {
        event.commandResponse = await bidi.command('network.failRequest', { request: event.requestId });
        event.requestResolved = event.commandResponse?.type === 'success';
        if (event.requestResolved) event.action = 'fail-provider-controlled';
        event.stopReason = reason;
        return { ok: event.commandResponse?.type === 'success', response: event.commandResponse };
      } catch (error) { event.commandError = error.message; recordError(error); return { ok: false, error: error.message }; }
    },
    async failPendingProviderRequests(reason) {
      const pending = requests.filter(event => event.isBlocked && event.requestId && !event.requestResolved); providerQueue.length = 0;
      const results = await Promise.all(pending.map(event => this.failProviderRequest(event, reason)));
      return results;
    },
    closeAdmission() {
      accepting = false;
      for (const waiter of providerWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error('BiDi request admission closed.')); }
      providerWaiters.length = 0;
    },
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

async function snapshotFixtureDOM(bidi, context, fixtureTargets) {
  const expected = fixtureTargets.map(target => {
    const text = target.kind === 'text' ? target.source : '';
    const markup = text;
    const title = target.kind === 'title' ? target.source : null;
    const safeField = value => ({ size: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
    return {
      id: target.id, kind: target.kind, text: safeField(text), markup: safeField(markup),
      title: { present: title !== null, ...(title === null ? safeField('') : safeField(title)) },
    };
  });
  const expression = `(()=>{const expected=${JSON.stringify(expected)};const encoder=new TextEncoder();const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');const size=value=>encoder.encode(value).length;return Promise.all(expected.map(async item=>{const element=[...document.querySelectorAll('[data-bench-id]')].find(node=>node.dataset.benchId===item.id);const text=element?.textContent??'';const markup=element?.innerHTML??'';const titlePresent=!!element?.hasAttribute('title');const title=element?.getAttribute('title')??'';const textHash=await hash(text);const markupHash=await hash(markup);const titleHash=await hash(title);return{id:item.id,kind:item.kind,text:{size:size(text),sha256:textHash,matchesExpected:!!element&&size(text)===item.text.size&&textHash===item.text.sha256},markup:{size:size(markup),sha256:markupHash,matchesExpected:!!element&&size(markup)===item.markup.size&&markupHash===item.markup.sha256},title:{present:titlePresent,size:size(title),sha256:titleHash,matchesExpected:!!element&&titlePresent===item.title.present&&size(title)===item.title.size&&titleHash===item.title.sha256}}})).then(targets=>JSON.stringify({htmlClass:{present:document.documentElement.hasAttribute('class'),value:document.documentElement.hasAttribute('class')?document.documentElement.getAttribute('class'):null},targets}))})()`;
  const result = await bidi.command('script.evaluate', { expression, target: { context }, awaitPromise: true });
  const remote = result.result?.result;
  if (remote?.type !== 'string' || typeof remote.value !== 'string') throw new Error('Restore DOM diagnostic evaluation did not return safe JSON.');
  return JSON.parse(remote.value);
}

export async function runFirefoxProbe({ buildBenchmarkExtension, workerEntry, contentEntry, artifact, checkIsolation = verifyIsolation, startFixtureOverride, createFixtureOverride, loopbackTlsProxy = false, pageTranslationE2E = false, pageTranslationStopE2E = false, pageTranslationReplacementE2E = false, pageTranslationStaleSuccessE2E = false }) {
  const staleMode = pageTranslationStaleSuccessE2E === true;
  const root = await mkdtemp(resolve(tmpdir(), 'translate-it-firefox-cap-'));
  const profile = resolve(root, 'profile'); const bundle = resolve(root, 'extension');
  const records = []; const errors = []; const cleanupErrors = []; const capabilities = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('Blocked by an earlier capability gate.')]));
  const runId = artifact.runId ?? randomBytes(16).toString('hex'); const authToken = randomBytes(32).toString('hex'); const privateSecrets = [authToken];
  const expectedExtensionId = 'page-translation-e2e-benchmark@translate-it.test';
  let fixture; let bridge; let bidi; let browser; let edgeProxy; let extensionId = null; let fixtureOrigin = null; let runtimeReportUrl; let requestDataCollectorId = null; let interceptId = null; let providerOperationState = null; let runtimeBridgeProof; let restoreDOMBaseline = null; let aborted = false; let dispatcher; let interceptReady = false; let runtimeBridgeAttempted = false; let bridgeDrainSucceeded = true;
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
    if (loopbackTlsProxy) artifact.loopbackTlsProxy = { mode: pageTranslationReplacementE2E ? 'page-translation-replacement' : staleMode ? 'page-translation-stale-success' : pageTranslationStopE2E ? 'page-translation-stop-auto' : pageTranslationE2E ? 'page-translation-e2e' : 'provider-only', status: 'SETTING_UP', isolationVerified: true, deniedRequests: [] };
    const { startFixture: defaultStartFixture, createFixture: defaultCreateFixture } = await import('../page-translation-e2e-benchmark/fixture.mjs');
    const fixtureModule = await import('../page-translation-e2e-benchmark/fixture.mjs');
    const fixtureData = pageTranslationReplacementE2E || staleMode
      ? fixtureModule.createPageTranslationReplacementFixture()
      : pageTranslationE2E
        ? fixtureModule.createPageTranslationFixture()
        : (createFixtureOverride ?? defaultCreateFixture)('small');
    // Phase 2B/2C: the replacement/stale collector instance is created after
    // listen() with the bound port; the fixture routes its report/control
    // paths to it.
    fixture = await (startFixtureOverride ?? defaultStartFixture)(fixtureData, pageTranslationReplacementE2E || staleMode
      ? { replacementCollector: url => staleMode
        ? createStaleCollector({ runId, authToken, expectedExtensionId, expectedTabId: null, expectedDocumentId: null, fixtureUrl: url })
        : createReplacementCollector({ runId, authToken, expectedExtensionId, expectedTabId: null, expectedDocumentId: null, fixtureUrl: url }) }
      : { runtimeBridge: { runId, authToken, expectedExtensionId, ...(pageTranslationE2E ? { schedulerBatchRequired: true } : {}) } });
    fixtureOrigin = new URL(fixture.url).origin;
    bridge = pageTranslationReplacementE2E || staleMode ? null : fixture.bridge;
    let bindingUrl = null;
    let replacementCollector = null;
    if (pageTranslationReplacementE2E || staleMode) {
      replacementCollector = fixture.replacementCollector;
      if (!replacementCollector || typeof replacementCollector.waitFor !== 'function' || typeof replacementCollector.snapshot !== 'function'
          || typeof replacementCollector.closeAdmission !== 'function' || typeof replacementCollector.drain !== 'function'
          || typeof replacementCollector.controlUrl !== 'function') {
        capabilities.runtimeBridge = capability('FAILED', { reason: 'Fixture did not expose the required authenticated replacement collector API.' });
        throw new Error('Fixture did not expose the required authenticated replacement collector API.');
      }
      runtimeReportUrl = replacementCollector.reportUrl;
      const reportOrigin = new URL(runtimeReportUrl);
      if (reportOrigin.origin !== fixtureOrigin || reportOrigin.protocol !== 'http:') {
        capabilities.runtimeBridge = capability('FAILED', { reason: 'Replacement collector endpoint escaped the loopback fixture origin.' });
        throw new Error('Replacement collector endpoint escaped the loopback fixture origin.');
      }
      artifact.fixture = { url: fixture.url, scope: staleMode ? 'trusted page-replacement stale-success A/B fixture' : 'trusted page-replacement A/B fixture' };
    } else {
      if (!bridge || typeof bridge.waitFor !== 'function' || typeof bridge.snapshot !== 'function' || typeof bridge.closeAdmission !== 'function' || typeof bridge.drain !== 'function') {
        capabilities.runtimeBridge = capability('FAILED', { reason: 'Fixture did not expose the required authenticated runtime bridge API.' });
        throw new Error('Fixture did not expose the required authenticated runtime bridge API.');
      }
      bindingUrl = bridge.bindingUrl; runtimeReportUrl = bridge.reportUrl;
      for (const endpoint of [bindingUrl, runtimeReportUrl]) {
        const parsed = new URL(endpoint);
        if (parsed.origin !== fixtureOrigin || parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.hash || containsPrivateSecret(endpoint, privateSecrets)) {
          capabilities.runtimeBridge = capability('FAILED', { reason: 'Runtime bridge endpoint escaped loopback or exposed its private token.' });
          throw new Error('Runtime bridge endpoint escaped the loopback fixture origin or exposed its private token.');
        }
      }
      artifact.fixture = { url: fixture.url, scope: 'loopback-only small capability fixture' };
    }
    capabilities.fixture = capability('SUPPORTED', { url: fixture.url, targetCount: fixtureData.targetCount });
    try {
      if (pageTranslationReplacementE2E || staleMode) {
        await buildBenchmarkExtension({
          outputDir: bundle, mode: 'sliced', browser: 'firefox', workerEntry, contentEntry,
          replacementConfig: { runId, authToken, fixtureUrl: fixture.url, expectedExtensionId, expectedTabId: null, expectedDocumentId: null, ...(staleMode ? { staleSuccess: true } : {}) },
        });
      } else {
        await buildBenchmarkExtension({
          outputDir: bundle, mode: 'sliced', browser: 'firefox', workerEntry, contentEntry,
          runtimeBridge: { runId, fixtureUrl: fixture.url, bindingUrl, reportUrl: runtimeReportUrl, authToken, ...(loopbackTlsProxy && !pageTranslationE2E ? { providerOnly: true } : {}), ...(pageTranslationE2E ? { pageTranslationE2E: true } : {}) },
        });
      }
    } catch (error) {
      capabilities.runtimeBridge = capability('FAILED', { reason: sanitizePrivate(`Authenticated harness build failed: ${error.message}`, privateSecrets) });
      throw error;
    }
    if (aborted) throw new Error('Probe aborted before browser launch.');
    await mkdir(profile);
    if (loopbackTlsProxy) {
      const cert = await createEdgeLoopbackCertificates(resolve(root, 'tls'));
      const nss = await importEdgeLoopbackCa(profile, cert.caCert);
      const caFingerprint = createHash('sha256').update(await readFile(cert.caCert)).digest('hex');
      edgeProxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts: pageTranslationReplacementE2E || staleMode
        ? [...fixtureData.targetTexts, ...fixtureData.sourceManifests.B]
        : fixtureData.targetTexts, responseFor: texts => mapEdgeResponse(texts) });
      await writeFile(resolve(profile, 'user.js'), edgeProxyFirefoxPrefs(edgeProxy.port), { mode: 0o600 });
      artifact.loopbackTlsProxy = { mode: pageTranslationReplacementE2E ? 'page-translation-replacement' : staleMode ? 'page-translation-stale-success' : pageTranslationStopE2E ? 'page-translation-stop-auto' : pageTranslationE2E ? 'page-translation-e2e' : 'provider-only', status: 'READY', bindAddress: '127.0.0.1', proxyPort: edgeProxy.port, tlsPort: edgeProxy.tlsPort,
        certificateVerification: cert.verification, caConstraints: cert.caConstraints, leafConstraints: cert.leafConstraints, caFingerprint, trust: nss.trust, nssListing: nss.listing,
        profilePrefs: 'manual HTTPS proxy; explicit localhost bypass; localhost hijacking disabled', deniedRequests: [] };
    }
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
    interceptId = intercept.result?.intercept ?? null;
    capabilities.interceptionSetup = interceptReady ? capability('SUPPORTED', { intercept: intercept.result.intercept, subscribedEvents: ['network.beforeRequestSent'], edgeTransport: loopbackTlsProxy ? 'separate-loopback-tls-proxy' : null }) : capability('FAILED', { reason: 'network.addIntercept returned no intercept identifier.' });
    if (!interceptReady) throw new Error('network.addIntercept acknowledgment missing intercept ID.');
    if (!loopbackTlsProxy) requestDataCollectorId = await setupProviderDataCollector(bidi, capabilities);
    if (!capabilities.providerDataCollector.status) capabilities.providerDataCollector = notTested('BiDi request collector setup was not attempted.');
    const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
    if (manifest.background?.scripts?.[0] !== 'worker.js' || manifest.browser_specific_settings?.gecko?.id !== expectedExtensionId) throw new Error('Firefox MV3 module-worker manifest or pinned Gecko ID missing.');
    const { result: created } = await bidi.command('browsingContext.create', { type: 'tab' });
    if (pageTranslationReplacementE2E || staleMode) {
      // Capture the browser console so a content-side failure is reported as
      // evidence instead of a generic readiness timeout.
      const consoleEntries = [];
      let realmEvidence = null;
      const realmProbes = [];
      bidi.onEvent(message => {
        if (message?.method !== 'log.entryAdded') return Promise.resolve();
        if (consoleEntries.length < 64) consoleEntries.push({ level: message.params?.level ?? null, text: String(message.params?.text ?? '').slice(0, 500) });
        return Promise.resolve();
      });
      await bidi.command('session.subscribe', { events: ['log.entryAdded'] });
      records.push({ kind: 'session.subscribe', events: ['log.entryAdded'] });
      let contentRealm = null;
      try {
        // Phase 2B/2C lane: trusted SPA-navigation replacement A→B inside one
        // live tab. The replacement/stale collector (fixture-side), the BiDi
        // session, and the 24-source TLS proxy oracle are already armed; this
        // sequence only drives production behavior and asserts the collector's
        // evidence. In Phase 2C (staleMode) the second A batch is RELEASED as a
        // genuine success and its reply is held by the content barrier.
        const collector = replacementCollector;
        // Collector.waitFor only returns the first stored match, so repeated
        // events (session-start A/B, scheduler-batch A1/A2/B) poll by count.
        const seen = new Map();
        const awaitEvent = async (event, timeoutMs) => {
          const target = (seen.get(event) ?? 0) + 1;
          const end = Date.now() + timeoutMs;
          for (;;) {
            const reports = (collector.snapshot().reports ?? []).filter(report => report?.event === event);
            if (reports.length >= target) { seen.set(event, target); return structuredClone(reports[target - 1]); }
            if (Date.now() >= end) throw new Error(`Timed out waiting for replacement event ${event} occurrence #${target}.`);
            await delay(50);
          }
        };
        // Settlement evidence must be matched by identity, never by arrival
        // order: the first A batch settles successfully before navigation, so an
        // occurrence counter would accept the wrong settlement.
        const awaitEventWhere = async (event, predicate, timeoutMs, label) => {
          const end = Date.now() + timeoutMs;
          for (;;) {
            const reports = (collector.snapshot().reports ?? []).filter(report => report?.event === event && predicate(report.evidence) === true);
            if (reports.length) return structuredClone(reports[0]);
            if (Date.now() >= end) throw new Error(`Timed out waiting for replacement event ${event} matching ${label}.`);
            await delay(50);
          }
        };
        const installed = await bidi.command('webExtension.install', { extensionData: { type: 'path', path: bundle } });
        extensionId = installed.result?.extension ?? installed.result?.extensionId ?? null;
        records.push({ kind: 'webExtension.install', result: installed.result });
        capabilities.extensionInstall = extensionId === expectedExtensionId
          ? capability('SUPPORTED', { extensionId, manifestWorker: manifest.background.scripts[0], geckoId: manifest.browser_specific_settings.gecko.id })
          : capability('FAILED', { reason: 'Firefox installed extension ID differs from the pinned manifest Gecko ID.' });
        if (extensionId !== expectedExtensionId) throw new Error('Firefox extension ID mismatch in replacement lane.');
        await bidi.command('browsingContext.navigate', { context: created.context, url: fixture.url, wait: 'none' });
        records.push({ kind: 'replacement-navigate-a', url: fixture.url });

        // The authenticated collector stream is the readiness proof: session A
        // can only be reported by the installed content adapter through the
        // production background bridge. WebDriver cannot evaluate scripts in an
        // extension realm, and a content-script sandbox is invisible to the
        // page, so DOM markers are only read after that proof.
        const listAllRealms = async () => (await bidi.command('script.getRealms', {})).result?.realms ?? [];
        const findPageRealm = async (timeoutMs) => {
          const end = Date.now() + timeoutMs;
          for (;;) {
            const realms = await listAllRealms();
            if (!realmEvidence) realmEvidence = realms.map(realm => ({ realm: realm.realm, type: realm.type ?? null, origin: realm.origin ?? null, context: realm.context ?? null }));
            for (const realm of realms) {
              if (typeof realm?.origin !== 'string' || realm.origin !== fixtureOrigin) continue;
              try {
                const result = await bidi.command('script.evaluate', {
                  expression: 'JSON.stringify({ ready: document.documentElement?.getAttribute("data-translate-it-replacement-content-ready") === "1", error: document.documentElement?.getAttribute("data-translate-it-replacement-error") ?? null, attrs: Array.from(document.documentElement?.attributes ?? []).map(attribute => attribute.name).filter(name => name.startsWith("data-translate-it")).sort(), url: location.href, hasContent: typeof document.querySelector === "function" })',
                  target: { realm: realm.realm }, awaitPromise: true });
                const remote = result?.result?.result;
                const state = typeof remote?.value === 'string' ? JSON.parse(remote.value) : null;
                realmProbes.push({ realm: realm.realm, context: realm.context ?? null, state });
                if (state?.ready === true) return realm.realm;
                if (state?.error) throw new Error(`Replacement content entry failed: ${state.error}`);
              } catch (error) {
                if (String(error?.message ?? '').startsWith('Replacement content entry failed:')) throw error;
                realmProbes.push({ realm: realm.realm, context: realm.context ?? null, error: String(error?.message ?? error).slice(0, 200) });
              }
            }
            if (Date.now() >= end || aborted) return null;
            await delay(100);
          }
        };
        const sessionStartA = await awaitEvent('session-start', 30_000);
        records.push({ kind: 'replacement-event', event: 'session-start', owner: sessionStartA.evidence?.owner ?? null });
        if (sessionStartA.evidence?.owner !== 'A') throw new Error('The first production session was not session A.');
        const sessionIdA = sessionStartA.evidence?.sessionId ?? null;
        contentRealm = await findPageRealm(30_000);
        capabilities.contentReadiness = contentRealm
          ? capability('SUPPORTED', { realm: contentRealm, source: 'authenticated-replacement-adapter' })
          : capability('FAILED', { reason: 'Content replacement adapter did not install in the fixture page realm.' });
        if (!contentRealm) throw new Error('Replacement content readiness marker was never observed.');
        const readinessResult = await bidi.command('script.evaluate', {
          expression: 'JSON.stringify({ backgroundReady: document.documentElement?.getAttribute("data-translate-it-replacement-background-ready") === "1", contentReady: document.documentElement?.getAttribute("data-translate-it-replacement-content-ready") === "1", flags: document.documentElement?.getAttribute("data-translate-it-replacement-flags") ?? null, route: location.origin + location.pathname, targets: document.querySelectorAll("[data-bench-id]").length, titles: document.querySelectorAll("[data-bench-kind=title]").length, control: Boolean(document.getElementById("page-translation-replacement-control")) })',
          target: { realm: contentRealm }, awaitPromise: true });
        let pageReadiness = null;
        try { pageReadiness = JSON.parse(readinessResult?.result?.result?.value ?? 'null'); } catch { pageReadiness = null; }
        capabilities.backgroundReadiness = pageReadiness?.backgroundReady === true
          ? capability('SUPPORTED', { source: 'authenticated-replacement-adapter', marker: 'data-translate-it-replacement-background-ready' })
          : capability('FAILED', { reason: 'Background replacement adapter never acknowledged the seeded handshake.' });
        if (pageReadiness?.backgroundReady !== true) throw new Error('Replacement background readiness marker was never observed.');
        let flagsObserved = null;
        try { flagsObserved = JSON.parse(pageReadiness?.flags ?? 'null'); } catch { flagsObserved = null; }
        flagsObserved = flagsObserved && flagsObserved.slicedDiscoveryEnabled === true && flagsObserved.viewportFirstDiscoveryEnabled === false
          ? flagsObserved : null;
        capabilities.discoveryFlags = flagsObserved
          ? capability('SUPPORTED', { flags: flagsObserved, source: 'replacement-harness-bundled-constants' })
          : capability('FAILED', { reason: 'Discovery markers were not observed in the bundled constants module.' });
        if (!flagsObserved) throw new Error('Discovery flag evidence was unavailable in the bundle.');
        const routeAValid = pageReadiness?.route === fixture.url && pageReadiness?.targets === 12 && pageReadiness?.titles === 6 && pageReadiness?.control === true;
        if (!routeAValid) {
          capabilities.fixture = capability('FAILED', { reason: 'Fixture A page did not present the expected replacement targets/control.' });
          throw new Error('Fixture A page evidence invalid.');
        }
        capabilities.runtimeBridge = capability('SUPPORTED', { runId, source: 'authenticated-replacement-collector', lane: staleMode ? 'page-translation-stale-success' : 'page-translation-replacement' });

        const batchA1 = await awaitEventWhere('scheduler-batch', evidence => evidence?.owner === 'A', 20_000, 'the first A scheduler batch');
        records.push({ kind: 'replacement-event', event: 'scheduler-batch', owner: 'A', targets: batchA1.evidence?.targetIds ?? null });
        await awaitEventWhere('provider-invoked', evidence => evidence?.messageId === batchA1.evidence?.messageId, 10_000, 'the first A provider invocation');
        await awaitEventWhere('physical-start', evidence => evidence?.messageId === batchA1.evidence?.messageId, 10_000, 'the first A physical attempt');
        capabilities.providerPhysicalRequest = capability('SUPPORTED', { source: 'authenticated-replacement-collector' });

        const windowA1 = replacementSourceIndexes(batchA1.evidence?.targetIds, 'A');
        if (!windowA1) throw new Error('The first A batch did not expose usable target membership.');
        const requestA1 = await edgeProxy.waitForRequest({ match: request => request.method === 'POST'
          && JSON.stringify(request.sourceIndexes) === JSON.stringify(windowA1), timeoutMs: 15_000 });
        capabilities.providerRequestBody = capability('SUPPORTED', { requestId: requestA1.requestId, bodyHash: requestA1.bodyHash, bodyBytes: requestA1.bodyBytes });
        await requestA1.release(undefined);
        capabilities.providerResponse = capability('SUPPORTED', { requestId: requestA1.requestId, status: requestA1.status === 'released' ? 'released' : 'unknown' });
        await edgeProxy.waitForStatus(requestA1.requestId, 'released', { timeoutMs: 5_000 });
        const acceptedA = await awaitEvent('accepted-A', 20_000);
        records.push({ kind: 'replacement-event', event: 'accepted-A', targets: acceptedA.evidence?.targetIds ?? null });

        const batchA2 = await awaitEventWhere('scheduler-batch', evidence => evidence?.owner === 'A' && evidence?.messageId !== batchA1.evidence?.messageId, 20_000, staleMode ? 'the stale second A scheduler batch' : 'the held second A scheduler batch');
        records.push({ kind: 'replacement-event', event: 'scheduler-batch', owner: 'A', targets: batchA2.evidence?.targetIds ?? null });
        const physicalA2 = await awaitEventWhere('physical-start', evidence => evidence?.messageId === batchA2.evidence?.messageId, 10_000, staleMode ? 'the stale A physical attempt' : 'the held A physical attempt');
        const staleAttemptId = physicalA2.evidence?.attemptId ?? null;
        const staleMessageId = batchA2.evidence?.messageId ?? null;
        let staleRequestStatus = null;
        const windowA2 = replacementSourceIndexes(batchA2.evidence?.targetIds, 'A');
        if (!windowA2) throw new Error(staleMode ? 'The stale A batch did not expose usable target membership.' : 'The held A batch did not expose usable target membership.');
        const requestA2 = await edgeProxy.waitForRequest({ match: request => request.method === 'POST'
          && JSON.stringify(request.sourceIndexes) === JSON.stringify(windowA2), timeoutMs: 15_000 });
        if (!staleMode) {
          // Do NOT release requestA2: it must still be held when the trusted SPA
          // navigation triggers production cancellation of the A session.
        } else {
          // Phase 2C: the stale batch's genuine success is RELEASED — a
          // fulfilled provider request, never an abort — and the content-side
          // reply barrier holds it before the navigation. The settled status
          // comes from the proxy's fresh snapshot, not the claim snapshot.
          await requestA2.release(undefined);
          staleRequestStatus = (await edgeProxy.waitForStatus(requestA2.requestId, 'released', { timeoutMs: 5_000 }))?.status ?? null;
        }
        if (staleMode) {
          // The stale reply must be held BEFORE the navigation: the collector
          // admits 'stale-reply-held' only pre-navigation, and the proxy
          // status already proves the A2 request was a fulfilled success, not
          // an abort.
          const heldReply = await awaitEventWhere('stale-reply-held', evidence => evidence?.messageId === staleMessageId, 15_000, 'the held stale successful reply');
          const replyCheck = classifyStaleReplyHash({ targetIds: heldReply.evidence?.targetIds, targetTexts: fixtureData.targetTexts,
            replyItemCount: heldReply.evidence?.replyItemCount, replyHash: heldReply.evidence?.replyHash });
          capabilities.staleSuccessfulReply = capability(replyCheck.ok && staleRequestStatus === 'released' ? 'SUPPORTED' : 'FAILED', {
            requestId: requestA2.requestId, proxyStatus: staleRequestStatus, messageId: staleMessageId,
            replyItemCount: heldReply.evidence?.replyItemCount ?? null, targetCount: batchA2.evidence?.targetIds?.length ?? null,
            markerStyle: replyCheck.markerStyle ?? null, reason: replyCheck.ok ? null : replyCheck.reason });
          if (!replyCheck.ok) throw new Error(`Stale successful-delivery evidence was invalid: ${replyCheck.reason ?? 'reply-hash mismatch'}.`);
          if (staleRequestStatus !== 'released') throw new Error('The stale A2 request was not a released fulfilled provider request.');
          const staleAttempt = (collector.snapshot().attempts ?? []).find(item => item.attemptId === staleAttemptId) ?? null;
          capabilities.physicalSettlement = staleAttempt?.settled === true && staleAttempt?.outcome === 'fulfilled' && staleAttempt?.code === null
            ? capability('SUPPORTED', { attemptId: staleAttemptId, outcome: 'fulfilled', requestId: requestA2.requestId, source: 'genuine-provider-success' })
            : capability('FAILED', { reason: 'The stale batch physical attempt did not settle as a clean fulfilled success.', attemptId: staleAttemptId, outcome: staleAttempt?.outcome ?? null, code: staleAttempt?.code ?? null });
          capabilities.rootSettlement = staleAttempt?.rootSettled === true && staleAttempt?.rootStatus === 'fulfilled' && staleAttempt?.rootCode === null
            ? capability('SUPPORTED', { rootSettled: true, status: 'fulfilled', requestId: requestA2.requestId, operationAborted: staleAttempt?.rootOperationAborted === true })
            : capability('FAILED', { reason: 'The stale batch Provider root did not settle as a clean fulfilled success.', attemptId: staleAttemptId, status: staleAttempt?.rootStatus ?? null, code: staleAttempt?.rootCode ?? null });
          if (capabilities.physicalSettlement.status !== 'SUPPORTED' || capabilities.rootSettlement.status !== 'SUPPORTED') {
            throw new Error('The stale batch did not settle as a genuine fulfilled Provider success.');
          }
          records.push({ kind: 'replacement-event', event: 'stale-reply-held', messageId: staleMessageId, targets: heldReply.evidence?.targetIds ?? null, replyItemCount: heldReply.evidence?.replyItemCount ?? null });
        }
        const readiness = collector.snapshot().navigationReadiness;
        if (!readiness?.ready) {
          capabilities.replacementSessionOwnership = capability('FAILED', { reason: 'Navigation readiness unmet.', readiness });
          throw new Error(`Replacement navigation readiness was never armed: ${JSON.stringify(readiness)}`);
        }
        const navigateResponse = await fetch(replacementCollector.controlUrl('navigate-to-b'), {
          headers: { authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(5_000),
        });
        if (navigateResponse.status !== 200) throw new Error(`Navigate-to-b control failed: HTTP ${navigateResponse.status}`);
        records.push({ kind: 'replacement-control', control: 'navigate-to-b', status: navigateResponse.status });
        await bidi.command('script.evaluate', {
          expression: 'document.getElementById("page-translation-replacement-control").click(); undefined;',
          target: { realm: contentRealm }, awaitPromise: true });
        records.push({ kind: 'replacement-click', control: 'page-translation-replacement-control' });
        const spaNavigation = await awaitEvent('spa-navigation', 15_000);
        await awaitEventWhere('stop-ack', evidence => evidence?.sessionId === sessionIdA, 15_000, 'the navigation Stop acknowledgement for session A');
        let controllerAbortEvidence = null;
        if (!staleMode) {
          await edgeProxy.waitForStatus(requestA2.requestId, 'aborted', { timeoutMs: 10_000 });
          capabilities.heldRequestAbort = capability('SUPPORTED', { requestId: requestA2.requestId, status: 'aborted', reason: 'client-aborted' });
          const controllerAbort = await awaitEventWhere('controller-abort', evidence => evidence?.attemptId === staleAttemptId, 15_000, 'the controller abort of the held A attempt');
          controllerAbortEvidence = controllerAbort.evidence ?? null;
          const physicalSettlement = await awaitEventWhere('physical-settled', evidence => evidence?.attemptId === staleAttemptId, 15_000, 'the physical settlement of the held A attempt');
          if (physicalSettlement.evidence?.outcome === 'fulfilled') throw new Error('The held A physical request settled successfully instead of aborting.');
          capabilities.physicalSettlement = capability('SUPPORTED', { heldRequestId: requestA2.requestId, attemptId: staleAttemptId, outcome: physicalSettlement.evidence?.outcome ?? null, code: physicalSettlement.evidence?.code ?? null });
          const rootSettlement = await awaitEventWhere('provider-root-settled', evidence => evidence?.messageId === staleMessageId && evidence?.sessionId === sessionIdA, 15_000, 'the Provider-root settlement of the held A attempt');
          if (rootSettlement.evidence?.status === 'fulfilled') throw new Error('The held A Provider root fulfilled instead of settling as cancelled.');
          capabilities.rootSettlement = capability('SUPPORTED', { rootSettled: true, heldRequestId: requestA2.requestId, status: rootSettlement.evidence?.status ?? null, code: rootSettlement.evidence?.code ?? null, operationAborted: rootSettlement.evidence?.operationAborted === true });
        }
        records.push({ kind: 'replacement-event', event: 'spa-navigation-completed', from: spaNavigation.evidence?.fromUrl ?? null, controllerAbort: controllerAbortEvidence });

        const sessionStartB = await awaitEventWhere('session-start', evidence => evidence?.owner === 'B', 15_000, 'the replacement session B start');
        records.push({ kind: 'replacement-event', event: 'session-start', owner: 'B', targets: sessionStartB.evidence?.sessionId ?? null });
        const sessionIdB = sessionStartB.evidence?.sessionId ?? null;
        if (!sessionIdA || !sessionIdB || sessionIdA === sessionIdB) throw new Error('Production replacement did not admit a distinct session B.');
        const retainedA = await awaitEventWhere('retained-A', evidence => evidence?.sessionId === sessionIdB, 15_000, 'the retained A ownership evidence');
        const batchB = await awaitEventWhere('scheduler-batch', evidence => evidence?.owner === 'B', 15_000, 'the B scheduler batch');
        records.push({ kind: 'replacement-event', event: 'scheduler-batch', owner: 'B', targets: batchB.evidence?.targetIds ?? null });
        const windowB = replacementSourceIndexes(batchB.evidence?.targetIds, 'B');
        if (!windowB) throw new Error('The B batch did not expose usable target membership.');
        const requestB = await edgeProxy.waitForRequest({ match: request => request.method === 'POST'
          && JSON.stringify(request.sourceIndexes) === JSON.stringify(windowB), timeoutMs: 15_000 });
        await requestB.release(undefined);
        await edgeProxy.waitForStatus(requestB.requestId, 'released', { timeoutMs: 5_000 });
        const acceptedB = await awaitEventWhere('accepted-B', evidence => evidence?.sessionId === sessionIdB, 20_000, 'the accepted B ownership evidence');
        if (staleMode) {
          // The held reply is released only by the brokered production flow:
          // the content polls the background's release-stale broker, the
          // background asks the collector's release-stale control, and the
          // collector grants it only after the hold and accepted-B are
          // admitted. The driver never fabricates the release itself.
          const releasedReply = await awaitEventWhere('stale-reply-released', evidence => evidence?.sessionId === sessionIdA && evidence?.messageId === staleMessageId, 20_000, 'the brokered stale release');
          const staleRejected = await awaitEventWhere('stale-batch-rejected', evidence => evidence?.sessionId === sessionIdA && evidence?.messageId === staleMessageId && evidence?.outcome === 'cancelled', 20_000, 'the Scheduler stale rejection');
          const staleHold = collector.snapshot().staleHold ?? null;
          const heldWithinWindow = staleHold?.held === true && staleHold?.released === true
            && Number.isSafeInteger(staleHold?.elapsedMs) && staleHold.elapsedMs >= 0 && staleHold.elapsedMs <= STALE_SUCCESS_HOLD_WINDOW_MS;
          capabilities.staleReplyHeld = capability(heldWithinWindow ? 'SUPPORTED' : 'FAILED', {
            heldAt: staleHold?.heldAt ?? null, releasedAt: staleHold?.releasedAt ?? null, elapsedMs: staleHold?.elapsedMs ?? null,
            holdWindowMs: STALE_SUCCESS_HOLD_WINDOW_MS, releasedReplySeq: releasedReply.seq ?? null });
          if (!heldWithinWindow) throw new Error(`The stale hold was not released within the ${STALE_SUCCESS_HOLD_WINDOW_MS} ms ownership-check window.`);
          capabilities.staleSchedulerRejection = capability(staleRejected.evidence?.outcome === 'cancelled' ? 'SUPPORTED' : 'FAILED', {
            messageId: staleMessageId, sessionId: sessionIdA, outcome: staleRejected.evidence?.outcome ?? null,
            targetIds: staleRejected.evidence?.targetIds ?? null, releasedReplySeq: releasedReply.seq ?? null });
          if (capabilities.staleSchedulerRejection.status !== 'SUPPORTED') throw new Error('Production did not report the Scheduler rejection of the released stale reply.');
          records.push({ kind: 'replacement-event', event: 'stale-release-and-rejection', messageId: staleMessageId, elapsedMs: staleHold.elapsedMs });
        }
        await awaitEventWhere('stop-B', evidence => evidence?.sessionId === sessionIdB, 20_000, 'the production B Stop evidence');
        capabilities.replacementSessionOwnership = capability('SUPPORTED', {
          sessionIdA, sessionIdB, distinctSessions: sessionIdA !== sessionIdB,
          batchMessageIds: [batchA1.evidence?.messageId ?? null, batchA2.evidence?.messageId ?? null, batchB.evidence?.messageId ?? null],
          batchSessionIds: [batchA1.evidence?.sessionId ?? null, batchA2.evidence?.sessionId ?? null, batchB.evidence?.sessionId ?? null],
          retainedTargetIds: retainedA.evidence?.targetIds ?? null, acceptedBTargetIds: acceptedB.evidence?.targetIds ?? null });
        await awaitEvent('cleanup', 20_000);

        const proxyEvidence = [...(edgeProxy.requests ?? [])];
        // Phase 2C: exactly three provider requests, ALL released — an aborted
        // request is not stale success, and a retry would surface as a fourth
        // request, so both must fail this classification.
        const correlation = classifyReplacementProxyRequests({ requests: proxyEvidence, expectedWindows: [windowA1, windowA2, windowB],
          expectedStatuses: staleMode ? ['released', 'released', 'released'] : undefined });
        capabilities.loopbackTlsProxy = capability(correlation.ok ? 'SUPPORTED' : 'FAILED', {
          requestCount: proxyEvidence.length, statuses: proxyEvidence.map(item => item.status),
          sourceIndexes: [...new Set(proxyEvidence.flatMap(item => item.sourceIndexes ?? []))].sort((a, b) => a - b),
        });
        capabilities.schedulerBatchCorrelation = capability(correlation.ok ? 'SUPPORTED' : 'FAILED', {
          requestCount: proxyEvidence.length, windows: correlation.windows ?? null, statuses: proxyEvidence.map(item => item.status) });
        if (!correlation.ok) throw new Error(`Replacement proxy correlation failed: ${correlation.reason ?? 'mismatch'}`);
        const finalDomReport = await awaitEvent('final-dom', 60_000);
        if (staleMode && (finalDomReport.evidence?.postInvalidationAWrites ?? []).length !== 0) {
          throw new Error('Post-invalidation session-A writes were observed after the stale rejection.');
        }
        const classification = classifyReplacementFinalDom({ finalDOM: finalDomReport.evidence, targetTexts: fixtureData.targetTexts,
          sourcesB: fixtureData.sourceManifests.B, retainedTargetIds: acceptedA.evidence?.targetIds ?? null,
          acceptedTargetIds: acceptedB.evidence?.targetIds ?? null });
        capabilities.replacementDomOwnership = capability(classification.ok ? 'SUPPORTED' : 'FAILED', {
          capturedTargets: finalDomReport.evidence?.targets?.length ?? null, mismatches: classification.mismatches ?? null, markerStyle: classification.markerStyle ?? null });
        if (!classification.ok) throw new Error('Final replacement DOM ownership/hash evidence was invalid.');
        if (staleMode) {
          const staleHold = collector.snapshot().staleHold ?? {};
          artifact.pageTranslationStaleSuccess = {
            scenario: 'trusted-spa-navigation-stale-successful-delivery-rejection',
            batches: { A1: { ...batchA1.evidence }, A2: { ...batchA2.evidence }, B: { ...batchB.evidence } },
            staleReply: {
              sessionId: sessionIdA, messageId: staleMessageId, targetIds: [...(batchA2.evidence?.targetIds ?? [])],
              replyItemCount: capabilities.staleSuccessfulReply.replyItemCount, replyHashMarkerStyle: capabilities.staleSuccessfulReply.markerStyle,
              proxyStatus: staleRequestStatus,
            },
            staleHold: { heldAt: staleHold.heldAt ?? null, releasedAt: staleHold.releasedAt ?? null, elapsedMs: staleHold.elapsedMs ?? null, holdWindowMs: STALE_SUCCESS_HOLD_WINDOW_MS },
            proxyRequests: proxyEvidence.map(request => ({ requestId: request.requestId, method: request.method, url: request.url, host: request.host, sni: request.sni,
              bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: [...request.sourceIndexes], status: request.status, responseStatus: request.responseStatus })),
            statuses: proxyEvidence.map(request => request.status), runId,
            finalDomTargets: (finalDomReport.evidence?.targets ?? []).map(target => ({ targetId: target.targetId, owner: target.owner, state: target.state, hash: target.hash })),
            postInvalidationAWrites: finalDomReport.evidence?.postInvalidationAWrites ?? [],
            limitations: ['No controller abort is used: the stale batch settles as a genuine fulfilled Provider success and production must reject the released reply at its Scheduler ownership check.',
              'Stale-reply evidence records only ids, counts and hashes; no reply payload is stored.'],
          };
          artifact.loopbackTlsProxy = {
            ...artifact.loopbackTlsProxy, mode: 'page-translation-stale-success', status: 'STALE_SUCCESS_REQUESTS_CORRELATED',
            requests: proxyEvidence.map(request => ({ requestId: request.requestId, method: request.method, url: request.url, sni: request.sni, host: request.host,
              bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: [...request.sourceIndexes], status: request.status, responseStatus: request.responseStatus })),
            deniedRequests: edgeProxy.deniedRequests ?? [],
          };
        } else {
          artifact.pageTranslationReplacement = {
            scenario: 'trusted-spa-navigation-replacement-retained-A-retranslate-B',
            batches: { A1: { ...batchA1.evidence }, A2: { ...batchA2.evidence }, B: { ...batchB.evidence } },
            proxyRequests: proxyEvidence.map(request => ({ requestId: request.requestId, method: request.method, url: request.url, host: request.host, sni: request.sni,
              bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: [...request.sourceIndexes], status: request.status, responseStatus: request.responseStatus })),
            statuses: proxyEvidence.map(request => request.status), runId,
            finalDomTargets: (finalDomReport.evidence?.targets ?? []).map(target => ({ targetId: target.targetId, owner: target.owner, state: target.state, hash: target.hash })),
            limitations: ['No Stale-Success scenario is implemented or tested; no separated released A success after replacement abort.'],
          };
          artifact.loopbackTlsProxy = {
            ...artifact.loopbackTlsProxy, mode: 'page-translation-replacement', status: 'REPLACEMENT_REQUESTS_CORRELATED',
            requests: proxyEvidence.map(request => ({ requestId: request.requestId, method: request.method, url: request.url, sni: request.sni, host: request.host,
              bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: [...request.sourceIndexes], status: request.status, responseStatus: request.responseStatus })),
            deniedRequests: edgeProxy.deniedRequests ?? [],
          };
        }
        replacementCollector.closeAdmission();
        const drainedCollector = await replacementCollector.drain();
        capabilities.cleanup = capability(drainedCollector ? 'SUPPORTED' : 'FAILED', { collectedRequests: proxyEvidence.length });
        await bidi.command('browsingContext.close', { context: created.context });
        return capabilities;
      } catch (error) {
        errors.push(sanitizePrivate(error.stack ?? String(error), privateSecrets));
        if (contentRealm) {
          try {
            const probed = await bidi.command('script.evaluate', {
              expression: 'document.documentElement?.getAttribute("data-translate-it-replacement-error") ?? null',
              target: { realm: contentRealm }, awaitPromise: true });
            const reason = probed?.result?.result?.value;
            if (typeof reason === 'string' && reason) errors.push(`Replacement content failure: ${reason}`);
          } catch { /* The page realm may be gone. */ }
        }
        if (consoleEntries.length) records.push({ kind: 'replacement-browser-console', entries: sanitizePrivate(consoleEntries, privateSecrets) });
        if (realmEvidence) records.push({ kind: 'replacement-realms', realms: sanitizePrivate(realmEvidence, privateSecrets) });
        if (realmProbes.length) records.push({ kind: 'replacement-realm-probes', probes: sanitizePrivate(realmProbes.slice(-12), privateSecrets) });
        if (replacementCollector) {
          const collected = replacementCollector.snapshot();
          records.push({ kind: 'replacement-collector-evidence', failure: collected.failure ?? null, sequence: collected.sequence ?? null,
            failLog: sanitizePrivate(collected.failLog ?? [], privateSecrets),
            postLog: sanitizePrivate(collected.postLog ?? [], privateSecrets),
            timeline: sanitizePrivate(collected.timeline ?? [], privateSecrets),
            rejections: sanitizePrivate((collected.rejections ?? []).map(rejection => ({ event: rejection.event, seq: rejection.seq,
              owner: rejection.evidence?.owner ?? null, sessionId: rejection.evidence?.sessionId ?? null, messageId: rejection.evidence?.messageId ?? null })), privateSecrets),
            reports: sanitizePrivate((collected.reports ?? []).map(report => ({ seq: report.seq, event: report.event,
              owner: report.evidence?.owner ?? null, sessionId: report.evidence?.sessionId ?? null, messageId: report.evidence?.messageId ?? null,
              attemptId: report.evidence?.attemptId ?? null, code: report.evidence?.code ?? null, outcome: report.evidence?.outcome ?? null })), privateSecrets) });
        }
        // The content adapter runs in the content-script realm, so its own
        // snapshot is only reachable through the DOM markers it writes.
        try {
          const probe = await bidi.command('script.evaluate', {
            expression: 'document.documentElement?.getAttribute("data-translate-it-replacement-url-change-log") ?? null',
            target: { realm: contentRealm }, awaitPromise: true });
          const raw = probe?.result?.result?.value;
          if (raw) records.push({ kind: 'replacement-url-change-log', log: sanitizePrivate(JSON.parse(raw), privateSecrets) });
        } catch { /* The page realm may be gone. */ }
        capabilities.replacementSessionOwnership = capability('FAILED', { reason: sanitizePrivate(error.message, privateSecrets) });
        throw error;
      }
    }
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
    if (pageTranslationE2E && !pageTranslationStopE2E) {
      try { restoreDOMBaseline = await snapshotFixtureDOM(bidi, created.context, fixtureData.targets); }
      catch { /* Keep the primary translation/restore outcome; record diagnostic unavailability without the script or page data. */ }
    }
    providerOperationState = await runEdgeFrenchProviderProbe({
      bridge, bidi, dispatcher, collectorId: requestDataCollectorId, fixtureTexts: fixtureData.targetTexts,
      runId, extensionId: expectedExtensionId, fixtureUrl: fixture.url, tabId: runtimeBridgeProof.tabId,
      startupSender: runtimeBridgeProof.contentReady.sender, loopbackProxy: edgeProxy, providerOnly: loopbackTlsProxy && !pageTranslationE2E,
      stopAutoMode: pageTranslationStopE2E,
      capabilities, timeoutMs: pageTranslationStopE2E ? 30_000 : 12_000,
    });
    artifact.providerProbe = sanitizePrivate(providerProbeArtifact(providerOperationState), privateSecrets);
    if (pageTranslationE2E && !pageTranslationStopE2E) {
      let restoreDOMFinal = null;
      try { restoreDOMFinal = await snapshotFixtureDOM(bidi, created.context, fixtureData.targets); }
      catch { /* The safe diagnostic record below notes unavailable final evidence. */ }
      artifact.restoreDOMDiagnostics = restoreDOMBaseline && restoreDOMFinal
        ? compareRestoreDOMSnapshots(restoreDOMBaseline, restoreDOMFinal)
        : { available: false, reason: 'DOM_DIAGNOSTIC_UNAVAILABLE', baselineCaptured: !!restoreDOMBaseline, finalCaptured: !!restoreDOMFinal };
    }
    if (pageTranslationStopE2E) {
      const batches = [...providerOperationState.schedulerBatches.values()];
      const correlated = providerOperationState.stopAutoProof;
      const proxyRequests = edgeProxy.requests ?? [];
      const physicalByMessage = new Map(providerOperationState.physicalStarts.map(item => [item.messageId, item]));
      const requestMembershipValid = proxyRequests.length === 2 && batches.length === 2
        && proxyRequests.every(request => request.method === 'POST' && request.host === 'edge.microsoft.com'
          && request.sni === 'edge.microsoft.com' && /^[a-f\d]{64}$/i.test(request.bodyHash)
          && Array.isArray(request.sourceIndexes) && request.sourceIndexes.length > 0
          && providerOperationState.physicalStarts.some(physical => physical.method === request.method && physical.bodyBytes === request.bodyBytes
            && physical.bodyHash.toLowerCase() === request.bodyHash.toLowerCase()
            && JSON.stringify(physical.sourceIndexes) === JSON.stringify(request.sourceIndexes)
            && new URL(physical.url).pathname === new URL(request.url, 'https://edge.microsoft.com').pathname))
        && new Set(proxyRequests.flatMap(request => request.sourceIndexes)).size === 12
        && correlated?.worker != null && !!physicalByMessage.get(correlated.firstBatchMessageId) && !!physicalByMessage.get(correlated.secondBatchMessageId)
        && proxyRequests.some(request => request.status === 'released') && proxyRequests.some(request => request.status === 'aborted');
      capabilities.loopbackTlsProxy = capability(requestMembershipValid ? 'SUPPORTED' : 'FAILED', {
        requestCount: proxyRequests.length, statuses: proxyRequests.map(request => request.status),
        sourceIndexes: [...new Set(proxyRequests.flatMap(request => request.sourceIndexes ?? []))].sort((a, b) => a - b),
      });
      capabilities.schedulerBatchCorrelation = capability(requestMembershipValid ? 'SUPPORTED' : 'FAILED', {
        batchCount: batches.length, acceptedBatchMessageId: correlated?.firstBatchMessageId ?? null,
        cancelledBatchMessageId: correlated?.secondBatchMessageId ?? null,
      });
      artifact.loopbackTlsProxy = { ...artifact.loopbackTlsProxy, mode: 'page-translation-stop-auto', status: requestMembershipValid ? 'STOPPED_AFTER_SECOND_REQUEST_ABORT' : 'STOP_PROOF_INVALID',
        requests: proxyRequests.map(request => ({ requestId: request.requestId, method: request.method, url: request.url, sni: request.sni, host: request.host,
          bodyBytes: request.bodyBytes, bodyHash: request.bodyHash, sourceIndexes: request.sourceIndexes, status: request.status, responseStatus: request.responseStatus })),
        deniedRequests: edgeProxy.deniedRequests ?? [] };
      artifact.pageTranslationStopAuto = correlated ? {
        scenario: 'two-real-edge-batches-stop-auto-aborts-held-second', sessionId: correlated.sessionId,
        firstBatchMessageId: correlated.firstBatchMessageId, secondBatchMessageId: correlated.secondBatchMessageId,
        acceptedTargetIds: correlated.acceptedTargetIds, pendingTargetIds: correlated.pendingTargetIds,
        stopCommand: correlated.stopCommand, finalEvidence: correlated,
        diagnostics: providerOperationState.stopAutoDiagnostics,
        status: requestMembershipValid && capabilities.pageTranslationStopProof?.status === 'SUPPORTED' ? 'SUPPORTED' : 'FAILED',
        limitations: ['No Replacement or Stale-Success scenario is implemented or tested.'],
      } : { status: 'FAILED', reason: 'Authenticated Stop Auto final evidence unavailable.', diagnostics: providerOperationState.stopAutoDiagnostics };
      return capabilities;
    }
    if (loopbackTlsProxy && !pageTranslationE2E) {
      const invocationDiagnostic = providerOperationState?.providerInvocation;
      artifact.loopbackTlsProxy = { ...artifact.loopbackTlsProxy, status: edgeProxy.request ? 'REQUEST_COMPLETED' : 'REQUEST_MISSING',
        providerInvocation: invocationDiagnostic && ['provider-only-invoke', 'provider-invoked'].includes(invocationDiagnostic.stage)
          ? { stage: invocationDiagnostic.stage, code: invocationDiagnostic.code ?? null }
          : { stage: 'NO_PROVIDER_INVOCATION', code: null },
        profilePrefsStatus: 'written-to-fresh-profile-user.js', connect: edgeProxy.request ? { authority: 'edge.microsoft.com:443', status: 200, boundAddress: '127.0.0.1' } : null,
        tls: edgeProxy.request ? { sni: edgeProxy.request.sni, host: edgeProxy.request.host, validation: edgeProxy.request.sni === 'edge.microsoft.com' && edgeProxy.request.host === 'edge.microsoft.com' ? 'passed' : 'failed' } : null,
        request: edgeProxy.request ? { method: 'POST', url: `https://edge.microsoft.com${edgeProxy.request.url}`, bodyBytes: edgeProxy.request.bodyBytes,
          bodyHash: edgeProxy.request.bodyHash, sourceIndexes: edgeProxy.request.sourceIndexes, sni: edgeProxy.request.sni, host: edgeProxy.request.host, validation: 'accepted' } : null,
        responseStatus: providerOperationState?.physicalSettlement?.evidence?.status ?? null, deniedRequests: edgeProxy.deniedRequests ?? [] };
      return capabilities;
    }
    if (pageTranslationE2E) {
      const batchCorrelations = [...providerOperationState.invocations.values()].map(invocation => {
        const batch = providerOperationState.schedulerBatches.get(invocation.messageId);
        const indexes = batch?.targetIds.map(id => Number(id.slice(7)));
        return { invocationId: invocation.invocationId, messageId: invocation.messageId, sessionId: invocation.sessionId,
          sourceIndexes: invocation.sourceIndexes, schedulerTargetIds: batch?.targetIds ?? [],
          matched: !!batch && batch.sessionId === invocation.sessionId && JSON.stringify(indexes) === JSON.stringify(invocation.sourceIndexes) };
      });
      const schedulerCorrelationOk = batchCorrelations.length === 2
        && providerOperationState.schedulerBatches.size === 2 && batchCorrelations.every(item => item.matched)
        && new Set(batchCorrelations.flatMap(item => item.sourceIndexes)).size === 12;
      const proxyRequests = edgeProxy.requests ?? [];
      const proxyRequestSetOk = proxyRequests.length === 2
        && proxyRequests.every(request => request.method === 'POST' && request.host === 'edge.microsoft.com'
          && Array.isArray(request.sourceIndexes) && request.sourceIndexes.length > 0)
        && new Set(proxyRequests.flatMap(request => request.sourceIndexes)).size === 12;
      if (!schedulerCorrelationOk || !proxyRequestSetOk) capabilities.providerConsumption = capability('FAILED', {
        reason: 'Scheduler/provider correlation or exact two-request proxy batch coverage failed.', batches: batchCorrelations,
      });
      capabilities.loopbackTlsProxy = capability(proxyRequestSetOk ? 'SUPPORTED' : 'FAILED', {
        requestCount: proxyRequests.length, sourceIndexes: [...new Set(proxyRequests.flatMap(request => request.sourceIndexes ?? []))].sort((a, b) => a - b),
      });
      capabilities.schedulerBatchCorrelation = capability(schedulerCorrelationOk ? 'SUPPORTED' : 'FAILED', { batchCount: batchCorrelations.length, batches: batchCorrelations });
      artifact.loopbackTlsProxy = { ...artifact.loopbackTlsProxy, status: proxyRequestSetOk ? 'REQUESTS_COMPLETED' : 'REQUEST_SET_INVALID', requests: providerOperationState.proxyCorrelation ?? [], deniedRequests: edgeProxy.deniedRequests ?? [] };
      artifact.pageTranslationE2E = {
        scenario: 'start-sliced-discovery-scheduler-edge-bridge-restore',
        targetKinds: fixtureData.targets.map(({ id, kind }) => ({ id, kind })),
        schedulerBatches: batchCorrelations,
        status: schedulerCorrelationOk && proxyRequestSetOk && capabilities.providerRestore?.status === 'SUPPORTED' ? 'SUPPORTED' : 'FAILED',
        lifecycle: { started: true, translated: !!providerOperationState.translated, restored: !!providerOperationState.restored },
        limitations: ['Stop/cancellation/replacement scenarios NOT TESTED'],
      };
      return capabilities;
    }
    if (providerProbeRequiresImmediateTeardown(providerOperationState, capabilities)) {
      const reason = `Optional realm and negative-fetch probes were not run because the provider lane stopped at ${providerOperationState.stopCode ?? 'an incomplete proof'}; producer teardown starts immediately.`;
      for (const name of ['backgroundInspection', 'contentInspection', 'backgroundNegativeFetch', 'contentNegativeFetch', 'pageNegativeFetch', 'interceptionDispatch']) {
        capabilities[name] = retainExecutedCapability(capabilities[name], reason);
      }
      records.push({ kind: 'optional-probes-skipped', reason });
      artifact.runtimeEvidence = { observations: [], requests: dispatcher.requests, optionalProbeGate: { status: 'NOT_TESTED', reason } };
      return capabilities;
    }
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
    capabilities.backgroundNegativeFetch = notTested('Background realm unavailable.');
    capabilities.contentNegativeFetch = notTested('Content realm unavailable.');
    capabilities.pageNegativeFetch = notTested('Page fetch probe not yet executed.');
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
    if (bridge && providerOperationState?.attempted && !providerOperationState.stopped) {
      try { await withTimeout(Promise.resolve(bridge.stopProviderProbe('TEARDOWN')), 3000, 'provider operation stop during teardown'); providerOperationState.stopCode = 'TEARDOWN'; providerOperationState.stopped = true; }
      catch (error) { cleanupErrors.push(`Provider operation teardown stop: ${sanitizePrivate(error.message, privateSecrets)}`); }
    }
    if (edgeProxy) {
      try {
        await edgeProxy.close();
        const drained = await withTimeout(edgeProxy.drain(), 3000, 'loopback TLS proxy drain');
        if (!drained) cleanupErrors.push('Loopback TLS proxy sockets did not drain.');
        if (artifact.loopbackTlsProxy) artifact.loopbackTlsProxy.cleanup = { closed: true, drained, socketsClosed: true };
      } catch (error) { cleanupErrors.push(`Loopback TLS proxy cleanup: ${sanitizePrivate(error.message, privateSecrets)}`); }
    }
    dispatcher?.closeAdmission();
    try {
      const failedPending = await withTimeout(dispatcher?.failPendingProviderRequests?.('TEARDOWN') ?? Promise.resolve([]), 3000, 'fail held Edge requests');
      if (failedPending.some(result => !result.ok)) cleanupErrors.push('One or more paused Edge requests could not be failed during cleanup.');
    } catch (error) { cleanupErrors.push(`Held Edge request cleanup: ${sanitizePrivate(error.message, privateSecrets)}`); }
    try { if (dispatcher && !(await dispatcher.drain(3000))) cleanupErrors.push('Request handlers did not drain before interception removal.'); }
    catch (error) { cleanupErrors.push(`Pre-removal request-handler drain: ${sanitizePrivate(error.message, privateSecrets)}`); }
    try { if (bridge?.closeAdmission) await withTimeout(Promise.resolve(bridge.closeAdmission()), 3000, 'runtime bridge close admission'); }
    catch (error) { cleanupErrors.push(`Runtime bridge admission close: ${sanitizePrivate(error.message, privateSecrets)}`); }
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
    if (!browser?.pid) {
      const networkCleanup = await removeProviderNetworkControls({ bidi, collectorId: requestDataCollectorId, interceptId, secrets: privateSecrets, timeoutMs: 3000 });
      cleanupErrors.push(...networkCleanup.errors);
    }
    try {
      if (dispatcher && !(await dispatcher.drain(5000))) cleanupErrors.push('Request-handler drain timed out.');
      await bidi?.drain();
    } catch (error) { cleanupErrors.push(`Request handler drain: ${error.message}`); }
    try {
      if (bridge?.drain) {
        const drained = await withTimeout(Promise.resolve(bridge.drain({ timeoutMs: 3000 })), 3500, 'runtime bridge drain');
        bridgeDrainSucceeded = !(drained === false || drained?.timedOut === true || drained?.ok === false || drained?.errors?.length);
        if (!bridgeDrainSucceeded) cleanupErrors.push('Runtime bridge did not drain cleanly.');
      }
    } catch (error) { bridgeDrainSucceeded = false; cleanupErrors.push(`Runtime bridge drain: ${sanitizePrivate(error.message, privateSecrets)}`); }
    if (fixture?.server?.listening) {
      try { await withTimeout(new Promise((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve())), 5000, 'fixture server close'); }
      catch (error) { bridgeDrainSucceeded = false; cleanupErrors.push(`Fixture cleanup: ${error.message}`); }
    }
    if (bridge?.drain && !bridgeDrainSucceeded && !fixture?.server?.listening) {
      try {
        const finalDrain = await withTimeout(Promise.resolve(bridge.drain({ timeoutMs: 3000 })), 3500, 'final runtime bridge drain');
        bridgeDrainSucceeded = !(finalDrain === false || finalDrain?.timedOut === true || finalDrain?.ok === false || finalDrain?.errors?.length);
        if (!bridgeDrainSucceeded) cleanupErrors.push('Final runtime bridge drain failed.');
      } catch (error) { cleanupErrors.push(`Final runtime bridge drain: ${sanitizePrivate(error.message, privateSecrets)}`); }
    }
    if (bridge && runtimeBridgeAttempted) {
      const contract = bridgeContract ?? { runId, extensionId: expectedExtensionId, fixtureUrl: fixture?.url, tabId: undefined };
      const reconciliation = await reconcileFinalRuntimeBridge({ bridge, expectedReports: bridgeAcceptedReports, contract, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000, drainSucceeded: bridgeDrainSucceeded });
      if (!reconciliation.ok) errors.push(sanitizePrivate(`Final runtime bridge reconciliation failed: ${reconciliation.reason ?? 'collector evidence mismatch'}`, privateSecrets));
    } else if (bridge) {
      const snapshot = await recordUnattemptedRuntimeBridge({ bridge, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000, drainSucceeded: bridgeDrainSucceeded });
      if (!snapshot.clean) errors.push(sanitizePrivate(snapshot.reason, privateSecrets));
    }
    if (bridge && providerOperationState) {
      const operationResult = pageTranslationStopE2E
        ? await reconcileFinalPageTranslationStop({ bridge, state: providerOperationState, contract: { runId, extensionId: expectedExtensionId, fixtureUrl: fixture?.url, tabId: runtimeBridgeProof?.tabId ?? bridgeContract?.tabId }, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000 })
        : await reconcileFinalProviderOperation({ bridge, state: providerOperationState, contract: { runId, extensionId: expectedExtensionId, fixtureUrl: fixture?.url, tabId: runtimeBridgeProof?.tabId ?? bridgeContract?.tabId }, capabilities, artifact, secrets: privateSecrets, timeoutMs: 3000 });
      if (!operationResult.ok) errors.push(sanitizePrivate(`Final provider operation reconciliation failed: ${operationResult.reason ?? 'operation evidence mismatch'}`, privateSecrets));
      if (pageTranslationStopE2E && artifact.pageTranslationStopAuto) artifact.pageTranslationStopAuto.status = operationResult.ok ? 'SUPPORTED' : 'FAILED';
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
    if (loopbackTlsProxy && artifact.loopbackTlsProxy && !artifact.loopbackTlsProxy.providerInvocation) {
      artifact.loopbackTlsProxy.providerInvocation = { stage: 'NO_PROVIDER_INVOCATION', code: null };
    }
    await rm(root, { recursive: true, force: true }).catch(error => cleanupErrors.push(`Temporary cleanup: ${error.message}`));
    process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigint);
    capabilities.cleanup = cleanupErrors.length ? capability('FAILED', { errors: [...cleanupErrors] }) : capability('SUPPORTED', { browserExited: !browser || browser.exitCode !== null || browser.signalCode !== null, exitCode: browser?.exitCode ?? null, signalCode: browser?.signalCode ?? null, fixtureClosed: !fixture || !fixture.server.listening, tempRemoved: true });
    if (pageTranslationE2E && !pageTranslationStopE2E) {
      const gates = ['loopbackTlsProxy', 'schedulerBatchCorrelation', 'providerPhysicalRequest', 'providerRequestBody', 'providerResponse', 'providerOperation', 'providerConsumption', 'domAcceptance', 'providerRestore', 'cleanup'];
      const passed = gates.every(name => capabilities[name]?.status === 'SUPPORTED');
      capabilities.pageTranslationProof = capability(passed ? 'SUPPORTED' : 'FAILED', {
        start: runtimeBridgeProof?.reports?.some(report => report.realm === 'content' && report.phase === 'ready') === true,
        translated: providerOperationState?.translated != null,
        restored: providerOperationState?.restored != null,
        gates: Object.fromEntries(gates.map(name => [name, capabilities[name]?.status ?? 'NOT_TESTED'])),
      });
      if (artifact.pageTranslationE2E) artifact.pageTranslationE2E.status = passed ? 'SUPPORTED' : 'FAILED';
    }
    if (pageTranslationStopE2E) {
      const gates = ['loopbackTlsProxy', 'schedulerBatchCorrelation', 'providerPhysicalRequest', 'providerRequestBody', 'providerResponse',
        'providerOperation', 'heldRequestAbort', 'physicalSettlement', 'rootSettlement', 'nostaleDOM', 'cleanup'];
      const passed = gates.every(name => capabilities[name]?.status === 'SUPPORTED');
      capabilities.pageTranslationStopProof = capability(passed ? 'SUPPORTED' : 'FAILED', {
        gates: Object.fromEntries(gates.map(name => [name, capabilities[name]?.status ?? 'NOT_TESTED'])),
      });
      if (artifact.pageTranslationStopAuto) artifact.pageTranslationStopAuto.status = passed ? 'SUPPORTED' : 'FAILED';
    }
    if (pageTranslationReplacementE2E) {
      const gates = ['loopbackTlsProxy', 'schedulerBatchCorrelation', 'providerPhysicalRequest', 'providerRequestBody', 'providerResponse',
        'heldRequestAbort', 'physicalSettlement', 'rootSettlement', 'replacementSessionOwnership', 'replacementDomOwnership', 'cleanup'];
      const passed = gates.every(name => capabilities[name]?.status === 'SUPPORTED');
      capabilities.replacementProof = capability(passed ? 'SUPPORTED' : 'FAILED', {
        gates: Object.fromEntries(gates.map(name => [name, capabilities[name]?.status ?? 'NOT_TESTED'])),
      });
      if (artifact.pageTranslationReplacement) artifact.pageTranslationReplacement.status = passed ? 'SUPPORTED' : 'FAILED';
    }
    if (pageTranslationStaleSuccessE2E) {
      const gates = ['loopbackTlsProxy', 'schedulerBatchCorrelation', 'providerPhysicalRequest', 'providerRequestBody', 'providerResponse',
        'physicalSettlement', 'rootSettlement', 'replacementSessionOwnership', 'replacementDomOwnership',
        'staleSuccessfulReply', 'staleReplyHeld', 'staleSchedulerRejection', 'cleanup'];
      const passed = gates.every(name => capabilities[name]?.status === 'SUPPORTED');
      capabilities.staleSuccessProof = capability(passed ? 'SUPPORTED' : 'FAILED', {
        gates: Object.fromEntries(gates.map(name => [name, capabilities[name]?.status ?? 'NOT_TESTED'])),
      });
      if (artifact.pageTranslationStaleSuccess) artifact.pageTranslationStaleSuccess.status = passed ? 'SUPPORTED' : 'FAILED';
    }
    const safeCapabilities = sanitizePrivate(capabilities, privateSecrets);
    Object.assign(capabilities, safeCapabilities);
    artifact.capabilities = safeCapabilities; artifact.events = sanitizePrivate(records, privateSecrets); artifact.errors = sanitizePrivate(errors, privateSecrets);
    artifact.requests = sanitizePrivate(dispatcher?.requests ?? [], privateSecrets);
    artifact.requestDispatcher = { maxInFlight: 128, maxRecordedRequests: 512, maxRecordedErrors: 64, droppedRecords: dispatcher?.droppedRecords ?? 0, droppedErrors: dispatcher?.droppedErrors ?? 0, errors: dispatcher?.errors.map(error => error.message ?? String(error)) ?? [] };
    artifact.protocolEvents = bidi?.events ?? [];
    artifact.networkRequests = artifact.requests;
    artifact.protocolJournal = bidi?.journal ?? [];
    artifact.limitations = [pageTranslationReplacementE2E
      ? 'Only production trusted SPA-navigation replacement A→B is exercised; the Stale-Success delivery-barrier scenario remains NOT_TESTED and no released A success is delivered after replacement.'
      : pageTranslationStaleSuccessE2E
        ? 'Only production trusted SPA-navigation Stale-Success rejection is exercised; the held A reply is released only by the brokered production flow and no controller abort exists.'
        : pageTranslationStopE2E ? 'Only production Stop Auto cancellation of one held subsequent provider batch is exercised; Replacement and Stale-Success scenarios remain NOT_TESTED.' : 'Provider cancellation and stale-delivery lifecycle scenarios remain NOT_TESTED.', 'Background/content negative fetches only run when both actual realms, readiness, and exact discovery flags pass.', 'When a runtime gate is inaccessible, dependent checks remain NOT_TESTED.', 'No mock provider, fetch substitute, URL rewrite, forced abort, or fabricated runtime result was used.', 'This is a bounded capability probe, not the full 1000-target E2E matrix.'];
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

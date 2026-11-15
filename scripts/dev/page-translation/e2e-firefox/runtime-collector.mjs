import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES } from './runtime-constants.mjs';

const LIMIT = 16 * 1024;
const phases = ['bootstrap', 'loaded', 'ready'];
const errorCodes = new Set(['IMPORT_FAILED', 'STARTUP_FAILED', 'READINESS_TIMEOUT', 'HANDSHAKE_FAILED', 'SENDER_REJECTED', 'PROTOCOL_REJECTED', 'NAVIGATION_INVALID', 'REPORT_FAILED', 'PERMISSION_DENIED', 'BINDING_FAILED', 'DISCOVERY_FLAGS_MISMATCH']);
const providerStopCodes = new Set(['INTERCEPTION_UNSUPPORTED', 'BODY_UNSUPPORTED', 'INVALID_BODY', 'PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'COMPLETED']);
const providerDiagnosticCodes = new Set([...providerStopCodes, 'ABORTED', 'NETWORK_ERROR', 'HTTP_ERROR', 'FETCH_ERROR']);
const providerEventNames = new Set(['armed', 'scheduler-batch', 'scheduler-batch-accepted', 'stop-auto-command', 'stop-auto-final', 'stop-auto-diagnostic', 'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled', 'command-result', 'translated', 'restored', 'error']);
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
  const schedulerBatchRequired = options.schedulerBatchRequired === true;
  const token = Buffer.from(authToken);
  let bindingOpen = true, admissionOpen = true, failed = false, pinnedOrigin, pinnedTab, pinnedSender;
  let seq = 0, accepted = 0;
  const reports = [], rejectionCounts = { unauthorized: 0, originOrType: 0, route: 0, malformed: 0, protocol: 0, bodyLimit: 0 };
  const reject = code => { rejectionCounts[code] = Math.min(1000, rejectionCounts[code] + 1); };
  const stages = { background: [], content: [] };
  const operation = { released: false, startDecision: null, restoreDecision: null, stopAutoDecision: null, stopAutoSnapshotDecision: null, stopped: false, stopCode: null, failure: null, seq: 0, reports: [], rejections: { originOrType: 0, protocol: 0 }, waiters: new Set(), decisionWaiters: new Set(), invocations: new Map(), schedulerBatches: new Map(), attempts: new Map(), coverage: new Set(), terminal: false };
  const pending = new Set(), waiters = new Set();
  const failWaiters = error => { for (const waiter of waiters) waiter.reject(error); };
  const notifyOperationChange = () => { bridge.server?.emit?.('runtime-provider-operation'); };
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
    notifyOperationChange();
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
    const controlPrefix = `/__benchmark/control/${encodeURIComponent(runId)}/`;
    if (path.startsWith(controlPrefix)) {
      const gate = path.slice(controlPrefix.length);
      if (!['stop-auto', 'stop-auto-snapshot'].includes(gate) || request.method !== 'GET' || requestUrl.search) {
        reject('route'); response.writeHead(404).end(); return true;
      }
      if (!admissionOpen || failed || request.headers.host !== new URL(fixtureUrl).host) {
        reject('route'); response.writeHead(503).end(); return true;
      }
      const auth = request.headers.authorization ?? '';
      const supplied = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
        reject('unauthorized'); response.writeHead(401).end(); return true;
      }
      const accepted = gate === 'stop-auto' ? operation.schedulerBatchAccepted : operation.stopAutoCommand;
      if (!operation.released || !accepted || operation.failure || operation.stopped) {
        response.writeHead(503).end(); return true;
      }
      const outcome = await waitForDecision(gate === 'stop-auto' ? 'stopAuto' : 'stopAutoSnapshot', 2200, null, true);
      if (outcome === null) { response.writeHead(204, { 'cache-control': 'no-store', connection: 'close' }).end(); return true; }
      const currentDecision = gate === 'stop-auto' ? operation.stopAutoDecision : operation.stopAutoSnapshotDecision;
      if (outcome !== (gate === 'stop-auto' ? 'stop' : 'capture') || currentDecision !== outcome
          || !operation.stopControlTarget || !admissionOpen || operation.failure || operation.stopped) {
        response.writeHead(503).end(); return true;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }).end(JSON.stringify({
        v: 1, runId, decision: outcome, sessionId: operation.stopControlTarget.sessionId,
        firstBatchMessageId: operation.stopControlTarget.firstBatchMessageId,
        secondBatchMessageId: operation.stopControlTarget.secondBatchMessageId,
      }));
      return true;
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
    if (report?.op !== undefined) {
      if (request.headers['content-type']?.toLowerCase() !== 'application/json'
          || (origin !== undefined && (!validOrigin(origin) || origin !== pinnedOrigin))) {
        operation.rejections.originOrType = Math.min(1000, operation.rejections.originOrType + 1);
        response.writeHead(403).end(); return true;
      }
      const acceptedReport = acceptProviderOperation(report);
      if (!acceptedReport) {
        operation.rejections.protocol = Math.min(1000, operation.rejections.protocol + 1);
        if (report?.runId === runId && report?.op === 'edge-fr-page-once') {
          operation.lastRejection = providerRejectionDiagnostic(report);
          failOperation('PROTOCOL_ERROR');
        }
        response.writeHead(failed || operation.failure ? 503 : 400).end(); return true;
      }
      let decision = report.event === 'armed'
        ? await waitForDecision('start', 2500, 'stop')
        : report.event === 'translated' ? await waitForDecision('restore', 2500, 'stop') : undefined;
      if (!admissionOpen || failed || operation.failure || operation.stopped) {
        if (report.event === 'armed' || report.event === 'translated') {
          decision = 'stop';
          operation.stopped = true;
          operation.stopCode ??= failed ? 'PROTOCOL_ERROR' : 'TEARDOWN';
          const gate = report.event === 'armed' ? 'start' : 'restore';
          if (!(gate === 'start' ? operation.startDecision : operation.restoreDecision)) decideOperation(gate, 'stop');
          notifyOperationChange();
        }
        else if (!isAdmittedPostStopEvent(report)) {
          reject('route'); if (!response.destroyed) response.writeHead(503).end(); return true;
        }
      }
      if (decision === 'stop' && !providerStopCodes.has(operation.stopCode)) {
        failOperation('PROTOCOL_ERROR');
        response.writeHead(503).end(); return true;
      }
      const gated = report.event === 'armed' || report.event === 'translated';
      const receipt = { v: 1, runId, op: 'edge-fr-page-once', opSeq: report.opSeq, accepted: true, ...(decision ? { decision } : {}) };
      if (gated && !decision) {
        failOperation('PROTOCOL_ERROR'); response.writeHead(503).end(); return true;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(receipt));
      if (report.event === 'stop-auto-final') { operation.stopped = true; operation.stopCode = 'COMPLETED'; notifyOperationChange(); }
      return true;
    }
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

  function acceptProviderOperation(report) {
    const terminalEvent = report?.event === 'error';
    if (!exact(report, ['v', 'runId', 'op', 'opSeq', 'event', 'evidence']) || report.v !== 1
        || report.runId !== runId || report.op !== 'edge-fr-page-once' || report.opSeq !== operation.seq + 1
        || report.opSeq > 65 || operation.reports.length >= 64 + (terminalEvent ? 1 : 0)
        || (operation.failure && !terminalEvent && !isAdmittedPostStopEvent(report))) return false;
    if (!validProviderEvent(report.event, report.evidence)) return false;
    operation.seq = report.opSeq;
    const copied = structuredClone(report);
    operation.reports.push(copied);
    if (report.event === 'armed') operation.armedSender = structuredClone(report.evidence.sender);
    if (report.event === 'scheduler-batch') operation.schedulerBatches.set(report.evidence.messageId, structuredClone(report.evidence));
    if (report.event === 'scheduler-batch-accepted') operation.schedulerBatchAccepted = structuredClone(report.evidence);
    if (report.event === 'stop-auto-command') operation.stopAutoCommand = structuredClone(report.evidence);
    if (report.event === 'provider-invoked') operation.invocations.set(report.evidence.invocationId, { ...structuredClone(report.evidence), attempts: new Set() });
    if (report.event === 'physical-start') {
      const attempt = { settled: false, invocationId: report.evidence.invocationId, sessionId: report.evidence.sessionId, sourceIndexes: [...report.evidence.sourceIndexes] };
      operation.attempts.set(report.evidence.attemptId, attempt);
      operation.invocations.get(report.evidence.invocationId)?.attempts.add(report.evidence.attemptId);
    }
    if (report.event === 'physical-settled') Object.assign(operation.attempts.get(report.evidence.attemptId), {
      settled: true, outcome: report.evidence.outcome, status: report.evidence.status, code: report.evidence.code,
    });
    if (report.event === 'parser-success') for (const index of report.evidence.sourceIndexes) operation.coverage.add(index);
    if (report.event === 'provider-settled') operation.invocations.get(report.evidence.invocationId).settled = true;
    if (report.event === 'error') failOperation(report.evidence.code);
    notifyOperation(report.event, copied);
    notifyOperationChange();
    return true;
  }

  function providerRejectionDiagnostic(report) {
    const envelopeValid = exact(report, ['v', 'runId', 'op', 'opSeq', 'event', 'evidence'])
      && report.v === 1 && report.runId === runId && report.op === 'edge-fr-page-once';
    const reason = !envelopeValid ? 'ENVELOPE_INVALID'
      : report.opSeq !== operation.seq + 1 || !Number.isSafeInteger(report.opSeq) ? 'SEQUENCE_INVALID'
        : report.opSeq > 65 || operation.reports.length >= 64 + (report.event === 'error' ? 1 : 0) ? 'LIMIT_EXCEEDED'
          : operation.failure ? 'OPERATION_FAILED' : 'EVENT_INVALID';
    const evidence = report?.evidence && typeof report.evidence === 'object' && !Array.isArray(report.evidence) ? report.evidence : {};
    const invocationId = typeof evidence.invocationId === 'string' ? evidence.invocationId : null;
    const attemptId = typeof evidence.attemptId === 'string' ? evidence.attemptId : null;
    const sessionId = typeof evidence.sessionId === 'string' ? evidence.sessionId : null;
    const knownCode = providerDiagnosticCodes.has(evidence.code) ? evidence.code : null;
    const knownOutcome = ['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome) ? evidence.outcome : null;
    return {
      event: providerEventNames.has(report?.event) ? report.event : 'unknown',
      opSeq: Number.isSafeInteger(report?.opSeq) && report.opSeq >= 0 && report.opSeq <= 65 ? report.opSeq : null,
      reason,
      released: operation.released,
      armed: !!operation.armedSender,
      stopped: operation.stopped,
      sessionMatchesAdmitted: sessionId !== null
        && ([...operation.invocations.values()].some(item => item.sessionId === sessionId)
          || [...operation.attempts.values()].some(item => item.sessionId === sessionId)),
      invocationKnown: invocationId === null ? null : operation.invocations.has(invocationId),
      attemptKnown: attemptId === null ? null : operation.attempts.has(attemptId),
      codeKnown: knownCode !== null,
      code: knownCode,
      success: typeof evidence.success === 'boolean' ? evidence.success : null,
      outcome: knownOutcome,
      stopStage: report?.event === 'stop-auto-final' ? stopFinalFailureStage(evidence) : null,
    };
  }

  function stopFinalFailureStage(evidence) {
    const keys = ['sessionId', 'firstBatchMessageId', 'firstBatchTargetIds', 'secondBatchMessageId', 'secondBatchTargetIds',
      'acceptedTargetIds', 'pendingTargetIds', 'acceptedDOMRetained', 'pendingDOMUnchanged', 'acceptedStateHash', 'pendingStateHash',
      'postStopMutationTargetIds', 'cancellationRequests', 'contentState', 'worker'];
    if (!exact(evidence, keys)) return 'final-content-evidence';
    const command = operation.stopAutoCommand;
    if (!command || evidence.sessionId !== command.sessionId || evidence.firstBatchMessageId !== command.firstBatchMessageId
        || !sameTargetIds(evidence.firstBatchTargetIds, command.firstBatchTargetIds)
        || !sameTargetIds(evidence.acceptedTargetIds, command.acceptedTargetIds)
        || !sameTargetIds(evidence.secondBatchTargetIds, evidence.pendingTargetIds)) return 'final-batch-correlation';
    if (evidence.acceptedDOMRetained !== true || evidence.pendingDOMUnchanged !== true
        || evidence.acceptedStateHash !== command.acceptedStateHash || evidence.pendingStateHash !== command.pendingStateHash
        || !Array.isArray(evidence.postStopMutationTargetIds) || evidence.postStopMutationTargetIds.length) return 'final-content-evidence';
    if (!validStopCancellationRequests(evidence.cancellationRequests, evidence.sessionId)) return 'final-cancellation-ack';
    if (!validStopContentState(evidence.contentState, evidence.sessionId)) return 'content-drain';
    const worker = evidence.worker;
    if (!exact(worker, ['providerRoots', 'cancelRequest', 'controllerAbort', 'physical', 'resources']) || !Array.isArray(worker.providerRoots)
        || worker.providerRoots.length !== 2 || !worker.providerRoots.every(root => ['fulfilled', 'rejected'].includes(root?.status)
          && Number.isSafeInteger(root?.settledSequence))) return 'worker-root-settlement';
    if (!worker.cancelRequest || worker.cancelRequest.status !== 'fulfilled' || worker.cancelRequest.responseSuccess !== true) return 'worker-cancel-request';
    if (!worker.controllerAbort || !Number.isSafeInteger(worker.controllerAbort.sequence)) return 'worker-controller-abort';
    if (!worker.physical) return 'worker-physical-missing';
    if (worker.physical.status !== 'rejected') return 'worker-physical-status';
    if (!Number.isSafeInteger(worker.physical.settledSequence)) return 'worker-physical-sequence';
    if (worker.physical.settledSequence <= worker.controllerAbort.sequence) return 'worker-physical-order';
    if (!worker.resources || worker.resources.available !== true || worker.resources.queueEmpty !== true
        || worker.resources.rateLimitIdle !== true || worker.resources.leaseActiveCount !== 0) return 'worker-resource-drain';
    return 'final-worker-evidence';
  }

  function isAdmittedPostStopEvent(report) {
    const evidence = report?.evidence;
    if (report?.event === 'error') return operation.reports.some(item => item.opSeq === report.opSeq && item.event === report.event);
    if (report?.event === 'physical-settled') return operation.attempts.has(evidence?.attemptId);
    if (report?.event === 'provider-settled') return operation.invocations.has(evidence?.invocationId);
    return report?.event === 'command-result' && evidence?.success === false && operation.released && !!operation.armedSender
      && (!operation.reports.some(item => item.event === 'command-result') || operation.reports.some(item => item.opSeq === report.opSeq && item.event === report.event));
  }

  function validProviderEvent(event, evidence) {
    if (!providerEventNames.has(event) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    if (event === 'armed') {
      return operation.reports.length === 0 && !operation.stopped && stages.background.includes('ready') && stages.content.includes('ready')
        && exact(evidence, ['sender', 'navigationGeneration', 'edgeHostPermission', 'proxyDisabled', 'observersInstalled'])
        && sender(evidence.sender) && evidence.navigationGeneration === 1 && evidence.edgeHostPermission === true
        && evidence.proxyDisabled === true && evidence.observersInstalled === true;
    }
    if (event === 'error') return !operation.terminal && !operation.stopped && exact(evidence, ['code']) && providerStopCodes.has(evidence.code);
    if (event === 'stop-auto-diagnostic') return operation.reports.filter(report => report.event === event).length < 8
      && exact(evidence, ['stage', 'code'])
      && PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES.includes(evidence.stage) && ['PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN'].includes(evidence.code);
    const admittedSettlement = event === 'physical-settled' && operation.attempts.has(evidence.attemptId) && !operation.attempts.get(evidence.attemptId)?.settled;
    const admittedProviderSettlement = event === 'provider-settled' && operation.invocations.has(evidence.invocationId) && !operation.invocations.get(evidence.invocationId).settled;
    const admittedCommandFailure = event === 'command-result' && evidence?.success === false && operation.released && !!operation.armedSender
      && !operation.reports.some(report => report.event === 'command-result');
    if (!operation.armedSender || (operation.terminal && !admittedSettlement && !admittedProviderSettlement && !admittedCommandFailure)) return false;
    if (operation.stopped && !admittedSettlement && !admittedProviderSettlement && !admittedCommandFailure) return false;
    if (event === 'provider-invoked') {
      const priorCommand = operation.reports.find(report => report.event === 'command-result')?.evidence;
      return operation.released && operation.invocations.size < 12 && !operation.invocations.has(evidence.invocationId) && exact(evidence, ['invocationId', 'sessionId', 'messageId', 'provider', 'itemCount', 'sourceIndexes'])
        && boundedString(evidence.invocationId) && boundedString(evidence.sessionId) && (evidence.messageId === null || boundedString(evidence.messageId))
        && evidence.provider === 'edge' && evidence.itemCount === evidence.sourceIndexes?.length && validIndexes(evidence.sourceIndexes)
         && (!operation.invocations.size || [...operation.invocations.values()][0].sessionId === evidence.sessionId)
         && (!schedulerBatchRequired || (typeof evidence.messageId === 'string'
           && (!operation.schedulerBatches.has(evidence.messageId) || sameSchedulerBatch(operation.schedulerBatches.get(evidence.messageId), evidence))))
         && (!priorCommand || (priorCommand.success === true && priorCommand.sessionId === evidence.sessionId));
    }
    if (event === 'scheduler-batch') {
      if (!schedulerBatchRequired || operation.schedulerBatches.size >= 12 || !exact(evidence, ['messageId', 'sessionId', 'targetIds'])
          || !boundedString(evidence.messageId) || !boundedString(evidence.sessionId) || !isTargetIdsSubset(evidence.targetIds)
          || operation.schedulerBatches.has(evidence.messageId)) return false;
      const indexes = evidence.targetIds.map(id => Number(id.slice(7)));
      const claimed = [...operation.schedulerBatches.values()].flatMap(batch => batch.targetIds.map(id => Number(id.slice(7))));
      if (indexes.some(index => claimed.includes(index))) return false;
      const invocation = [...operation.invocations.values()].find(item => item.messageId === evidence.messageId);
      return !invocation || sameSchedulerBatch(evidence, invocation);
    }
    if (event === 'scheduler-batch-accepted') {
      const batch = operation.schedulerBatches.get(evidence?.messageId);
      return schedulerBatchRequired && operation.released && !operation.schedulerBatchAccepted
        && exact(evidence, ['messageId', 'sessionId', 'targetIds', 'acceptedTargetIds'])
        && boundedString(evidence.messageId) && boundedString(evidence.sessionId) && isTargetIdsSubset(evidence.targetIds)
        && sameTargetIds(evidence.targetIds, evidence.acceptedTargetIds) && !!batch && batch.sessionId === evidence.sessionId
        && sameTargetIds(batch.targetIds, evidence.targetIds);
    }
    if (event === 'stop-auto-command') {
      const acceptedBatch = operation.schedulerBatchAccepted;
      return schedulerBatchRequired && operation.stopAutoDecision === 'stop' && !operation.stopAutoCommand
        && exact(evidence, ['sessionId', 'firstBatchMessageId', 'firstBatchTargetIds', 'acceptedTargetIds', 'pendingTargetIds',
          'stopSuccess', 'stopSessionId', 'translatedCount', 'isTranslated', 'isAutoTranslating', 'acceptedDOMRetained', 'pendingDOMUnchanged', 'acceptedStateHash', 'pendingStateHash'])
        && boundedString(evidence.sessionId) && evidence.sessionId === acceptedBatch?.sessionId
        && evidence.firstBatchMessageId === acceptedBatch?.messageId && sameTargetIds(evidence.firstBatchTargetIds, acceptedBatch?.targetIds)
        && sameTargetIds(evidence.acceptedTargetIds, acceptedBatch?.targetIds)
        && isTargetIdsSubset(evidence.pendingTargetIds) && disjointTargets(evidence.acceptedTargetIds, evidence.pendingTargetIds)
        && allTargets(evidence.acceptedTargetIds, evidence.pendingTargetIds)
        && evidence.stopSuccess === true && evidence.stopSessionId === evidence.sessionId
        && evidence.translatedCount === evidence.acceptedTargetIds.length && evidence.isTranslated === true && evidence.isAutoTranslating === false
        && evidence.acceptedDOMRetained === true && evidence.pendingDOMUnchanged === true
        && validHash(evidence.acceptedStateHash) && validHash(evidence.pendingStateHash);
    }
    if (event === 'stop-auto-final') {
      const command = operation.stopAutoCommand;
      return schedulerBatchRequired && operation.stopAutoSnapshotDecision === 'capture' && !operation.stopped
        && exact(evidence, ['sessionId', 'firstBatchMessageId', 'firstBatchTargetIds', 'secondBatchMessageId', 'secondBatchTargetIds',
          'acceptedTargetIds', 'pendingTargetIds', 'acceptedDOMRetained', 'pendingDOMUnchanged', 'acceptedStateHash', 'pendingStateHash',
          'postStopMutationTargetIds', 'cancellationRequests', 'contentState', 'worker'])
        && evidence.sessionId === command?.sessionId && evidence.firstBatchMessageId === command?.firstBatchMessageId
        && sameTargetIds(evidence.firstBatchTargetIds, command?.firstBatchTargetIds)
        && boundedString(evidence.secondBatchMessageId) && evidence.secondBatchMessageId !== evidence.firstBatchMessageId
        && isTargetIdsSubset(evidence.secondBatchTargetIds) && sameTargetIds(evidence.pendingTargetIds, evidence.secondBatchTargetIds)
        && sameTargetIds(evidence.acceptedTargetIds, command?.acceptedTargetIds)
        && allTargets(evidence.acceptedTargetIds, evidence.pendingTargetIds)
        && evidence.acceptedDOMRetained === true && evidence.pendingDOMUnchanged === true
        && evidence.acceptedStateHash === command?.acceptedStateHash && evidence.pendingStateHash === command?.pendingStateHash
        && Array.isArray(evidence.postStopMutationTargetIds) && evidence.postStopMutationTargetIds.length === 0
        && validStopContentState(evidence.contentState, evidence.sessionId)
        && validStopCancellationRequests(evidence.cancellationRequests, evidence.sessionId)
        && validStopWorkerEvidence(evidence.worker, evidence.sessionId, evidence.firstBatchMessageId, evidence.secondBatchMessageId);
    }
    if (event === 'physical-start') {
      const invocation = operation.invocations.get(evidence.invocationId);
      if (!invocation || !exact(evidence, ['attemptId', 'invocationId', 'sessionId', 'messageId', 'provider', 'method', 'url', 'bodyBytes', 'bodyHash', 'sourceIndexes'])) return false;
       return operation.attempts.size < 36 && !operation.attempts.has(evidence.attemptId) && boundedString(evidence.attemptId) && evidence.invocationId === invocation.invocationId
        && evidence.sessionId === invocation.sessionId && evidence.messageId === invocation.messageId && evidence.provider === 'edge'
        && evidence.method === 'POST' && validEdgeUrl(evidence.url) && Number.isSafeInteger(evidence.bodyBytes) && evidence.bodyBytes > 0
         && /^[a-f\d]{64}$/i.test(evidence.bodyHash) && validIndexes(evidence.sourceIndexes) && sameIndexes(evidence.sourceIndexes, invocation.sourceIndexes);
    }
    if (event === 'physical-settled') {
      const attempt = operation.attempts.get(evidence.attemptId);
      return exact(evidence, ['attemptId', 'sessionId', 'outcome', 'status', 'code']) && !!attempt && !attempt.settled
        && evidence.sessionId === attempt.sessionId && ['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome)
        && (evidence.status === null || Number.isInteger(evidence.status))
        && (evidence.code === null || ['ABORTED', 'NETWORK_ERROR', 'HTTP_ERROR', 'FETCH_ERROR'].includes(evidence.code));
    }
    if (event === 'parser-success') {
      const invocation = operation.invocations.get(evidence.invocationId);
      const attempts = [...(invocation?.attempts ?? [])].map(id => operation.attempts.get(id));
      return exact(evidence, ['invocationId', 'sessionId', 'sourceIndexes', 'resultsMatch']) && !!invocation
        && attempts.length > 0 && attempts.every(attempt => attempt?.settled) && attempts.some(attempt => attempt.outcome === 'fulfilled')
        && invocation.sessionId === evidence.sessionId && sameIndexes(evidence.sourceIndexes, invocation.sourceIndexes) && evidence.resultsMatch === true
        && evidence.sourceIndexes.every(index => !operation.coverage.has(index));
    }
    if (event === 'provider-settled') {
      const invocation = operation.invocations.get(evidence.invocationId);
      const attempts = [...(invocation?.attempts ?? [])].map(id => operation.attempts.get(id));
      return exact(evidence, ['invocationId', 'sessionId', 'outcome', 'code']) && !!invocation
        && invocation.sessionId === evidence.sessionId && ['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome)
        && attempts.every(attempt => attempt?.settled)
        && (evidence.outcome === 'fulfilled' ? evidence.code === null : providerDiagnosticCodes.has(evidence.code)) && !invocation.settled
        && (evidence.outcome !== 'fulfilled' || operation.reports.some(report => report.event === 'parser-success' && report.evidence.invocationId === evidence.invocationId));
    }
    if (event === 'command-result') {
      return exact(evidence, ['success', 'sessionId', 'code']) && typeof evidence.success === 'boolean'
        && (evidence.sessionId === null || boundedString(evidence.sessionId))
        && (!operation.invocations.size || evidence.sessionId === null || evidence.sessionId === [...operation.invocations.values()][0].sessionId)
        && (evidence.code === null || providerStopCodes.has(evidence.code))
        && (!evidence.success || (operation.released && evidence.sessionId !== null && evidence.code === null
          && (!operation.invocations.size || evidence.sessionId === [...operation.invocations.values()][0].sessionId)))
        && !operation.reports.some(report => report.event === 'command-result');
    }
    if (event === 'translated') {
      const hasMutationAccounting = Object.hasOwn(evidence, 'acceptedMutationCounts') || Object.hasOwn(evidence, 'unattributedWrites');
      const mutationAccountingValid = !hasMutationAccounting || (exact(evidence.acceptedMutationCounts, ['text', 'title'])
        && nonnegative(evidence.acceptedMutationCounts.text) && nonnegative(evidence.acceptedMutationCounts.title)
        && evidence.acceptedMutationCounts.text + evidence.acceptedMutationCounts.title === 12
        && evidence.unattributedWrites === 0);
      return exact(evidence, ['sessionId', 'acceptedTargetIds', 'acceptedCount', 'duplicateAcceptances', 'staleWrites', 'domMatches', 'sessionOwned', 'quiescent', ...(hasMutationAccounting ? ['acceptedMutationCounts', 'unattributedWrites'] : [])])
        && operation.invocations.size > 0 && evidence.sessionId === [...operation.invocations.values()][0].sessionId && isTargetIds(evidence.acceptedTargetIds) && evidence.acceptedCount === 12
        && operation.coverage.size === 12 && [...operation.invocations.values()].every(invocation => invocation.settled)
        && (!schedulerBatchRequired || (hasMutationAccounting && evidence.acceptedMutationCounts.text === 6 && evidence.acceptedMutationCounts.title === 6))
        && mutationAccountingValid
         && (!schedulerBatchRequired || (operation.schedulerBatches.size === operation.invocations.size
           && [...operation.invocations.values()].every(invocation => operation.schedulerBatches.has(invocation.messageId))))
        && evidence.duplicateAcceptances === 0 && evidence.staleWrites === 0 && evidence.domMatches === true && evidence.sessionOwned === true && evidence.quiescent === true
        && operation.reports.some(report => report.event === 'command-result' && report.evidence.success === true && report.evidence.sessionId === evidence.sessionId)
        && !operation.reports.some(report => report.event === 'translated');
    }
    if (event === 'restored') {
      return exact(evidence, ['sessionId', 'commandSuccess', 'domMatchesOriginal', 'metadataRestored', 'restoreObserved'])
        && operation.invocations.size > 0 && evidence.sessionId === [...operation.invocations.values()][0].sessionId && evidence.commandSuccess === true && evidence.domMatchesOriginal === true
        && operation.coverage.size === 12 && evidence.metadataRestored === true && evidence.restoreObserved === true && operation.restoreDecision === 'restore'
        && operation.reports.some(report => report.event === 'translated') && !operation.reports.some(report => report.event === 'restored');
    }
    return false;
  }

  function notifyOperation(event, report) {
    for (const waiter of [...operation.waiters]) {
      if (waiter.event === event) {
        operation.waiters.delete(waiter);
        waiter.resolve(report);
      }
    }
  }
  function failOperationWaiters(error) { for (const waiter of operation.waiters) waiter.reject(error); }
  function failOperation(code) {
    if (operation.failure) return;
    operation.failure = { code };
    operation.terminal = true;
    operation.stopped = true;
    operation.stopCode ??= code;
    decideOperation('start', 'stop');
    decideOperation('restore', 'stop');
    failOperationWaiters(new Error('Firefox provider operation reached terminal failure'));
    notifyOperationChange();
  }

  function decideOperation(gate, decision) {
    const property = { start: 'startDecision', restore: 'restoreDecision', stopAuto: 'stopAutoDecision', stopAutoSnapshot: 'stopAutoSnapshotDecision' }[gate];
    if (!property) throw new TypeError('Unknown provider operation decision gate.');
    operation[property] = decision;
    for (const waiter of [...operation.decisionWaiters]) {
      if (waiter.gate !== gate) continue;
      operation.decisionWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(decision);
    }
    notifyOperationChange();
  }

  function waitForDecision(gate, timeoutMs, fallback, polling = false) {
    const property = { start: 'startDecision', restore: 'restoreDecision', stopAuto: 'stopAutoDecision', stopAutoSnapshot: 'stopAutoSnapshotDecision' }[gate];
    if (!property) throw new TypeError('Unknown provider operation decision gate.');
    const existing = operation[property];
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const waiter = { gate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        operation.decisionWaiters.delete(waiter);
        if (polling) { resolve(null); return; }
        operation.stopped = true; operation.stopCode ??= 'TIMEOUT';
        if (gate === 'stopAuto' || gate === 'stopAutoSnapshot') operation.failure ??= { code: 'TIMEOUT' };
        decideOperation(gate, fallback);
      }, timeoutMs);
      operation.decisionWaiters.add(waiter);
    });
  }

  function providerOperationSnapshot() {
    return structuredClone({
      op: 'edge-fr-page-once', released: operation.released, restoreDecision: operation.restoreDecision,
      stopAutoDecision: operation.stopAutoDecision, stopAutoSnapshotDecision: operation.stopAutoSnapshotDecision,
      stopped: operation.stopped, stopCode: operation.stopCode, reports: operation.reports,
      rejections: { ...operation.rejections }, failure: operation.failure,
      lastRejection: operation.lastRejection ?? null,
    });
  }

  const bridge = {
    get bindingUrl() { return `${fixtureUrl}__benchmark/bind/${encodeURIComponent(runId)}`; },
    get reportUrl() { return `${fixtureUrl}__benchmark/runtime`; },
    snapshot() { return Object.freeze({ reports: structuredClone(reports), failure: failed ? { code: failureCode } : null, rejections: { ...rejectionCounts }, background: [...stages.background], content: [...stages.content], accepted, operation: providerOperationSnapshot() }); },
    operationSnapshot() { return providerOperationSnapshot(); },
    releaseProviderProbe() {
      if (operation.released) throw new Error('Provider operation release is one-use.');
      if (accepted !== 5
          || !['bootstrap', 'loaded', 'ready'].every((phase, index) => stages.background[index] === phase)
          || !['loaded', 'ready'].every((phase, index) => stages.content[index] === phase)) throw new Error('Provider operation is not releasable until the five startup reports are accepted.');
      if (failed || !admissionOpen || operation.failure || operation.stopped) {
        operation.released = true;
        operation.stopped = true;
        operation.stopCode ??= operation.failure?.code ?? 'TEARDOWN';
        decideOperation('start', 'stop');
        notifyOperationChange();
        return { decision: 'stop' };
      }
      operation.released = true;
      decideOperation('start', 'start');
      notifyOperationChange();
      return { decision: 'start' };
    },
    async waitForOperation(event, { timeoutMs = 3000 } = {}) {
      if (!providerEventNames.has(event)) throw new TypeError('Unknown provider operation event.');
      const current = operation.reports.find(report => report.event === event);
      if (current) return structuredClone(current);
      if (operation.failure) throw new Error('Firefox provider operation reached terminal failure');
      if (!admissionOpen) throw new Error('Firefox runtime collector admission is closed');
      return await new Promise((resolve, rejectPromise) => {
        const waiter = {
          event,
          resolve: report => { clearTimeout(timer); operation.waiters.delete(waiter); resolve(structuredClone(report)); },
          reject: error => { clearTimeout(timer); operation.waiters.delete(waiter); rejectPromise(error); },
        };
        const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for provider operation ${event}`)), timeoutMs);
        operation.waiters.add(waiter);
      });
    },
    decideRestore(decision) {
      if (!admissionOpen || failed || operation.failure || operation.stopped || !['restore', 'stop'].includes(decision)
          || operation.restoreDecision !== null || !operation.reports.some(report => report.event === 'translated')) throw new Error('Provider operation restore decision is invalid or already settled.');
      decideOperation('restore', decision);
      if (decision === 'stop') { operation.stopped = true; operation.stopCode = 'COMPLETED'; }
      notifyOperationChange();
      return decision;
    },
    decideStopAuto(decision) {
      if (!admissionOpen || failed || operation.failure || operation.stopped || decision !== 'stop'
          || !operation.released || operation.stopAutoDecision !== null || !operation.schedulerBatchAccepted) {
        throw new Error('Provider operation Stop Auto decision is invalid or already settled.');
      }
      const accepted = operation.schedulerBatchAccepted;
      const firstBatch = operation.schedulerBatches.get(accepted.messageId);
      const others = [...operation.schedulerBatches.values()].filter(batch => batch.messageId !== accepted.messageId);
      const secondBatch = others.length === 1 ? others[0] : null;
      const secondInvocation = secondBatch && [...operation.invocations.values()].find(item => item.messageId === secondBatch.messageId);
      const secondStarted = secondInvocation && operation.reports.some(report => report.event === 'physical-start'
        && report.evidence.invocationId === secondInvocation.invocationId && report.evidence.sessionId === accepted.sessionId);
      if (!firstBatch || !secondBatch || !secondInvocation || !secondStarted || secondBatch.sessionId !== accepted.sessionId
          || !sameTargetIds(firstBatch.targetIds, accepted.targetIds)) {
        throw new Error('Stop Auto decision requires an accepted first batch and an already-started exact subsequent batch.');
      }
      operation.stopControlTarget = { sessionId: accepted.sessionId, firstBatchMessageId: firstBatch.messageId, secondBatchMessageId: secondBatch.messageId };
      decideOperation('stopAuto', decision);
      return decision;
    },
    decideStopAutoSnapshot(decision) {
      if (!admissionOpen || failed || operation.failure || operation.stopped || decision !== 'capture'
          || operation.stopAutoDecision !== 'stop' || operation.stopAutoSnapshotDecision !== null || !operation.stopAutoCommand) {
        throw new Error('Provider operation Stop Auto snapshot decision is invalid or already settled.');
      }
      const target = operation.stopControlTarget;
      const heldInvocation = [...operation.invocations.values()].find(item => item.messageId === target?.secondBatchMessageId);
      const attempts = [...(heldInvocation?.attempts ?? [])].map(id => operation.attempts.get(id));
      const cancelledPhysical = attempts.length === 1 && attempts[0]?.settled === true
        && ['cancelled', 'rejected'].includes(attempts[0].outcome) && attempts[0].status === null
        && ['ABORTED', 'NETWORK_ERROR', 'FETCH_ERROR'].includes(attempts[0].code);
      const providerSettled = operation.reports.some(report => report.event === 'provider-settled'
        && report.evidence.invocationId === heldInvocation?.invocationId && ['rejected', 'cancelled'].includes(report.evidence.outcome));
      if (!target || !cancelledPhysical || !providerSettled) throw new Error('Stop Auto final capture requires held physical and Provider settlement reports.');
      decideOperation('stopAutoSnapshot', decision);
      return decision;
    },
    stopProviderProbe(reasonCode) {
      if (!providerStopCodes.has(reasonCode)) throw new TypeError('Unknown provider operation stop code.');
      if (operation.stopped) return false;
      operation.stopped = true;
      operation.stopCode = reasonCode;
      if (!operation.startDecision) decideOperation('start', 'stop');
      if (!operation.restoreDecision) decideOperation('restore', 'stop');
      notifyOperationChange();
      return true;
    },
    closeAdmission() {
      admissionOpen = false; bindingOpen = false;
      operation.stopped = true;
      operation.stopCode ??= 'TEARDOWN';
      if (!operation.startDecision) decideOperation('start', 'stop');
      if (!operation.restoreDecision) decideOperation('restore', 'stop');
      if (!operation.stopAutoDecision) decideOperation('stopAuto', 'deny');
      if (!operation.stopAutoSnapshotDecision) decideOperation('stopAutoSnapshot', 'deny');
      notifyOperationChange();
      for (const cancel of pending) cancel();
      failWaiters(new Error('Firefox runtime collector admission is closed'));
      failOperationWaiters(new Error('Firefox runtime collector admission is closed'));
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

function boundedString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function validIndexes(value) { return Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every(item => Number.isInteger(item) && item >= 0 && item < 12) && new Set(value).size === value.length; }
function sameIndexes(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]); }
function sameTargetIds(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((id, index) => id === right[index]); }
function disjointTargets(left, right) { return Array.isArray(left) && Array.isArray(right) && !left.some(id => right.includes(id)); }
function allTargets(left, right) {
  const ids = [...(left ?? []), ...(right ?? [])];
  return ids.length === 12 && new Set(ids).size === 12 && ids.every((id, index) => /^target-(?:[0-9]|1[01])$/.test(id))
    && Array.from({ length: 12 }, (_, index) => `target-${index}`).every(id => ids.includes(id));
}
function validHash(value) { return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value); }
function validStopCancellationRequests(value, sessionId) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const translate = value.find(item => item.action === 'CANCEL_TRANSLATION');
  const session = value.find(item => item.action === 'CANCEL_SESSION');
  return !!translate && !!session && [translate, session].every(item => exact(item,
    ['action', 'sessionId', 'status', 'responseSuccess', 'cancelAll', 'context'])
      && item.sessionId === sessionId && item.status === 'fulfilled' && item.responseSuccess === true)
    && translate.cancelAll === true && translate.context === 'page-translation-batch'
    && session.cancelAll === null && session.context === null;
}
function validStopContentState(value, sessionId) {
  return exact(value, ['capturedSessionActive', 'discoveryCancelled', 'currentBridgeOwnsSession', 'schedulerSessionContextOwned', 'pendingOperations',
    'translationSessionId', 'activeFlushes', 'queueIds', 'activeBatchIds', 'pendingSettlementCount', 'bridgeSessionActive',
    'bridgeDiscoveryPending', 'bridgeDiscoveryRunning', 'bridgeDiscoveryStarting', 'bridgeDiscoveryQueueDepth', 'bridgeDiscoveryCancelled', 'bridgeDiscoveryFailed'])
    && value.capturedSessionActive === false && value.discoveryCancelled === true && value.schedulerSessionContextOwned === false
    && value.pendingOperations === 0 && value.translationSessionId === sessionId && value.activeFlushes === 0
    && Array.isArray(value.queueIds) && value.queueIds.length === 0 && Array.isArray(value.activeBatchIds) && value.activeBatchIds.length === 0
    && value.pendingSettlementCount === 0 && value.bridgeSessionActive === false
    && value.bridgeDiscoveryPending === false && value.bridgeDiscoveryRunning === false && value.bridgeDiscoveryStarting === false
    && value.bridgeDiscoveryQueueDepth === 0 && value.bridgeDiscoveryCancelled === true && value.bridgeDiscoveryFailed === false;
}
function validStopWorkerEvidence(value, sessionId, firstMessageId, secondMessageId) {
  if (!exact(value, ['providerRoots', 'cancelRequest', 'controllerAbort', 'physical', 'resources'])
      || !Array.isArray(value.providerRoots) || value.providerRoots.length !== 2) return false;
  const roots = value.providerRoots;
  const first = roots.find(item => item.messageId === firstMessageId);
  const second = roots.find(item => item.messageId === secondMessageId);
  const cancel = value.cancelRequest; const abort = value.controllerAbort; const physical = value.physical; const resources = value.resources;
  return !!first && !!second
    && [first, second].every(item => exact(item, ['messageId', 'sessionId', 'status', 'resultSuccess', 'operationAborted', 'controllerAborted', 'controllerAbortedAtEnd', 'settledSequence']) && item.sessionId === sessionId && Number.isSafeInteger(item.settledSequence))
    && first.status === 'fulfilled' && first.resultSuccess === true
    && ((second.status === 'rejected' && (second.operationAborted === true || second.controllerAbortedAtEnd === true))
      || (second.status === 'fulfilled' && second.resultSuccess === false && second.controllerAbortedAtEnd === true))
    && second.controllerAborted === true
    && exact(cancel, ['messageId', 'sessionId', 'status', 'controllerMatched', 'controllerAbortedBefore', 'controllerAbortedAfter', 'responseSuccess'])
    && cancel.messageId === secondMessageId && cancel.sessionId === sessionId && cancel.status === 'fulfilled'
    && cancel.controllerMatched === true && cancel.controllerAbortedBefore === false && cancel.controllerAbortedAfter === true && cancel.responseSuccess === true
    && exact(abort, ['messageId', 'sessionId', 'sequence', 'cancelRequestSequence', 'abortedBefore', 'abortedAfter', 'context'])
    && abort.messageId === secondMessageId && abort.sessionId === sessionId && Number.isSafeInteger(abort.sequence)
    && Number.isSafeInteger(abort.cancelRequestSequence) && abort.sequence > abort.cancelRequestSequence
    && abort.context === 'page-translation-batch' && abort.abortedBefore === false && abort.abortedAfter === true && second.settledSequence > abort.sequence
    && exact(physical, ['messageId', 'sessionId', 'status', 'operationAborted', 'controllerAbortedAtEnd', 'settledSequence'])
     && physical.messageId === secondMessageId && physical.sessionId === sessionId && physical.status === 'rejected'
     && Number.isSafeInteger(physical.settledSequence)
     && physical.settledSequence > abort.sequence
    && exact(resources, ['available', 'activeLifecycleIds', 'activeRequestIds', 'requests', 'sourceResolverPresent', 'queueEmpty', 'rateLimitIdle', 'leaseActiveCount', 'leaseTimerActive'])
    && resources.available === true && Array.isArray(resources.activeLifecycleIds) && resources.activeLifecycleIds.every(id => id !== firstMessageId && id !== secondMessageId)
    && Array.isArray(resources.activeRequestIds) && resources.activeRequestIds.every(id => id !== firstMessageId && id !== secondMessageId)
    && Array.isArray(resources.requests) && resources.requests.length === 2
    && resources.requests.every(item => exact(item, ['messageId', 'status', 'operationOwned']) && [firstMessageId, secondMessageId].includes(item.messageId) && item.operationOwned === false && !['pending', 'processing', 'streaming'].includes(item.status))
    && resources.sourceResolverPresent === false && resources.queueEmpty === true && resources.rateLimitIdle === true
    && resources.leaseActiveCount === 0 && resources.leaseTimerActive === false;
}
function isTargetIdsSubset(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 12
    && value.every(id => typeof id === 'string' && /^target-(?:[0-9]|1[01])$/.test(id)) && new Set(value).size === value.length;
}
function sameSchedulerBatch(batch, invocation) {
  return batch.sessionId === invocation.sessionId && Array.isArray(batch.targetIds)
    && sameIndexes(batch.targetIds.map(id => Number(id.slice(7))), invocation.sourceIndexes);
}
function isTargetIds(value) { return Array.isArray(value) && value.length === 12 && value.every((id, index) => id === `target-${index}`); }
function validEdgeUrl(value) {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.protocol === 'https:' && url.hostname === 'edge.microsoft.com' && url.port === ''
      && url.pathname === '/translate/translatetext' && url.searchParams.get('isEnterpriseClient') === 'false'
      && url.searchParams.get('to') === 'fr' && keys.every(key => ['isEnterpriseClient', 'to', 'from'].includes(key))
      && keys.filter(key => key === 'isEnterpriseClient').length === 1 && keys.filter(key => key === 'to').length === 1
      && keys.filter(key => key === 'from').length <= 1 && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

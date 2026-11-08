import { createSuccessfulReplyGate } from './successful-reply-gate.mjs';

export const successfulReplyProbeNames = Object.freeze(['replacement', 'stop', 'restore']);
const PAGE_TRANSLATE_BATCH_WIRE_ACTION = 'page-translate-batch';
const WORKER_NETWORK_EVENT_METHODS = new Set([
  'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed',
]);

function safeNetworkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, pathname: url.pathname };
  } catch { return null; }
}

function safeNetworkParams(method, params = {}) {
  const safe = { requestId: params.requestId ?? null, timestamp: Number.isFinite(params.timestamp) ? params.timestamp : null };
  if (method === 'Network.requestWillBeSent') {
    safe.loaderId = params.loaderId ?? null;
    safe.type = params.type ?? null;
    safe.request = {
      url: safeNetworkUrl(params.request?.url),
      method: params.request?.method ?? null,
    };
    return safe;
  }
  if (method === 'Network.responseReceived') {
    safe.type = params.type ?? null;
    safe.response = {
      url: safeNetworkUrl(params.response?.url),
      status: Number.isFinite(params.response?.status) ? params.response.status : null,
      mimeType: params.response?.mimeType ?? null,
    };
    return safe;
  }
  if (method === 'Network.loadingFinished') {
    safe.encodedDataLength = Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null;
    return safe;
  }
  safe.type = params.type ?? null;
  safe.errorText = params.errorText ?? null;
  safe.canceled = params.canceled === true;
  return safe;
}

export function createWorkerNetworkEventRouter(onEvent = () => {}) {
  const targetsBySession = new Map();
  return {
    register(sessionId, targetInfo) {
      if (typeof sessionId !== 'string' || !sessionId || typeof targetInfo?.targetId !== 'string' || !targetInfo.targetId) return false;
      targetsBySession.set(sessionId, {
        targetId: targetInfo.targetId,
        targetType: targetInfo.type ?? null,
        targetUrl: targetInfo.url ?? null,
      });
      return true;
    },
    targetForSession(sessionId) { return targetsBySession.get(sessionId) ?? null; },
    observerForSession(sessionId) {
      return event => event?.sessionId === sessionId ? this.route(event) : false;
    },
    route(event) {
      const target = targetsBySession.get(event?.sessionId);
      if (!target || !WORKER_NETWORK_EVENT_METHODS.has(event?.method)) return false;
      const record = {
        sessionId: event.sessionId,
        ...target,
        method: event.method,
        params: safeNetworkParams(event.method, event.params),
      };
      onEvent(record);
      return true;
    },
    snapshot() { return Object.fromEntries([...targetsBySession].map(([sessionId, target]) => [sessionId, { ...target }])); },
  };
}

export function validateWorkerNetworkCompletion({ events, networkId, sessionId, targetId }) {
  const issues = [];
  if (typeof networkId !== 'string' || !networkId || typeof sessionId !== 'string' || !sessionId
      || typeof targetId !== 'string' || !targetId || !Array.isArray(events)) {
    return { ok: false, issues: ['Fetch Network correlation identity or event evidence is unavailable'], matchedEvents: [] };
  }
  const matching = events.filter(event => event.sessionId === sessionId && event.targetId === targetId
    && event.params?.requestId === networkId);
  const started = matching.some(event => event.method === 'Network.requestWillBeSent');
  const response = matching.find(event => event.method === 'Network.responseReceived');
  const finished = matching.some(event => event.method === 'Network.loadingFinished');
  const failed = matching.find(event => event.method === 'Network.loadingFailed');
  if (!started) issues.push('matching Network.requestWillBeSent was not observed for the Fetch target session');
  if (!response) issues.push('matching Network.responseReceived was not observed for the Fetch target session');
  else if (response.params?.response?.status !== 200) issues.push(`matching Network response status was ${response.params?.response?.status ?? 'unavailable'}, not 200`);
  if (!finished) issues.push('matching Network.loadingFinished was not observed for the Fetch target session');
  if (failed) issues.push('matching Network.loadingFailed was observed');
  return { ok: issues.length === 0, issues, matchedEvents: matching };
}

export function classifyStaleSuccessProviderOwner({ sessionId, initialSessionId = null, replacementSessionId = null, trustedStartAccepted, currentOwnerSessionId, currentOwnerContextOwned, initialSessionInvalidated }) {
  const trustedCurrentOwner = trustedStartAccepted === true
    && currentOwnerSessionId === sessionId && currentOwnerContextOwned === true;
  if (!initialSessionId) {
    return trustedCurrentOwner
      ? { ok: true, role: 'initial-A', lockInitialSessionId: sessionId }
      : { ok: false, role: 'unknown', reason: 'first provider response has no trusted current Page owner' };
  }
  if (sessionId === initialSessionId) {
    if (initialSessionInvalidated === true) return { ok: true, role: 'cancelled-A-sibling', waitForControllerAbort: true };
    return trustedCurrentOwner
      ? { ok: true, role: 'initial-A' }
      : { ok: false, role: 'unknown', reason: 'A response is not owned by current A scheduler session' };
  }
  if (replacementSessionId && sessionId === replacementSessionId) {
    return trustedCurrentOwner
      ? { ok: true, role: 'replacement-B' }
      : { ok: false, role: 'unknown', reason: 'locked B provider response is not owned by current trusted B scheduler session' };
  }
  if (replacementSessionId) return { ok: false, role: 'unknown', reason: `provider session ${sessionId} differs from locked B ${replacementSessionId}` };
  return initialSessionInvalidated === true && trustedCurrentOwner
    ? { ok: true, role: 'replacement-B', lockReplacementSessionId: sessionId }
    : { ok: false, role: 'unknown', reason: `provider session ${sessionId} has no trusted post-invalidation replacement owner` };
}

function nodeText(node) {
  if (!node) return '';
  if (typeof node.nodeValue === 'string') return node.nodeValue;
  return typeof node.textContent === 'string' ? node.textContent : '';
}

export function createRawDOMMutationEvidence() {
  let active = false;
  let sequence = 0;
  let transitions = [];
  let errors = [];

  return {
    begin() {
      transitions = [];
      errors = [];
      sequence = 0;
      active = true;
    },
    capture(records, { targetIdForNode } = {}) {
      if (!active || !records || typeof targetIdForNode !== 'function') return;
      const entries = Array.from(records);
      for (let index = 0; index < entries.length; index++) {
        const record = entries[index];
        const id = targetIdForNode(record.target);
        const changedFixtureTarget = [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])]
          .some(node => targetIdForNode(node) !== null);
        if (record.type === 'childList') {
          if (id === null) {
            if (changedFixtureTarget) errors.push({ sequence: ++sequence, reason: 'fixture target inserted/removed outside its owned target' });
            continue;
          }
          const oldValues = [...record.removedNodes].map(nodeText);
          const newValues = [...record.addedNodes].map(nodeText);
          if (!oldValues.length && !newValues.length) {
            errors.push({ sequence: ++sequence, id, reason: 'fixture childList mutation has no readable added/removed nodes' });
            continue;
          }
          transitions.push({ sequence: ++sequence, id, type: record.type, oldValues, newValues });
          continue;
        }
        if (record.type === 'characterData') {
          if (id === null) continue;
          const next = entries.slice(index + 1).find(candidate => candidate.type === 'characterData' && candidate.target === record.target);
          const newValue = next ? next.oldValue : record.target?.nodeValue;
          if (typeof record.oldValue !== 'string' || typeof newValue !== 'string') {
            errors.push({ sequence: ++sequence, id, reason: 'characterData mutation old/new value unavailable' });
            continue;
          }
          transitions.push({ sequence: ++sequence, id, type: record.type, oldValues: [record.oldValue], newValues: [newValue] });
          continue;
        }
        if (id !== null) errors.push({ sequence: ++sequence, id, reason: `unsupported fixture mutation type: ${record.type}` });
      }
    },
    finish(records = [], options = {}) {
      this.capture(records, options);
      active = false;
      return this.snapshot();
    },
    snapshot() {
      return { available: true, active, transitions: transitions.map(item => ({ ...item, oldValues: [...item.oldValues], newValues: [...item.newValues] })), errors: errors.map(item => ({ ...item })) };
    },
  };
}

export function validateRawDOMMutationEvidence({ evidence, targets, mode }) {
  const issues = [];
  if (evidence?.available !== true || evidence?.active !== false || !Array.isArray(evidence?.transitions) || !Array.isArray(evidence?.errors)) {
    issues.push('raw DOM mutation evidence was not drained or is unavailable');
    return { ok: false, issues, evidence };
  }
  if (evidence.errors.length) issues.push(...evidence.errors.map(item => `raw DOM capture failed: ${item.reason}`));
  const sourceById = new Map((Array.isArray(targets) ? targets : []).map(target => [target.id, target.source]));
  for (const transition of evidence.transitions) {
    const source = sourceById.get(transition.id);
    if (typeof source !== 'string') {
      issues.push(`raw DOM transition has unknown target: ${transition.id ?? 'missing'}`);
      continue;
    }
    for (const value of [...transition.oldValues, ...transition.newValues]) {
      if (value === source) continue;
      if (mode === 'replacement' && value === `\u200efixture translation B: ${source}`) continue;
      issues.push(`unexpected raw DOM value for ${transition.id}: ${value}`);
    }
  }
  return { ok: issues.length === 0, issues, evidence };
}

export function validateCleanupInvalidation({ sessionId, operations }) {
  const event = Array.isArray(operations) ? operations.find(operation => operation.kind === 'session.invalidation'
    && operation.sessionId === sessionId && operation.capturedSessionActive === false && operation.discoveryCancelled === true) : null;
  return {
    ok: typeof sessionId === 'string' && sessionId.length > 0 && !!event,
    event: event ?? null,
    issues: event ? [] : [`No actual inactive/discovery-cancelled session invalidation was observed for ${sessionId ?? 'missing session'}`],
  };
}

export function resolveCleanupSessionEvidence({ knownSessionId = null, snapshotAvailable, replySnapshot, pageStartAttempted = false }) {
  if (typeof knownSessionId === 'string' && knownSessionId.length) return { ok: true, sessionId: knownSessionId, noGatePending: false, issues: [] };
  if (snapshotAvailable !== true || !replySnapshot || typeof replySnapshot !== 'object'
      || !Object.prototype.hasOwnProperty.call(replySnapshot, 'gate')) {
    return { ok: false, sessionId: null, noGatePending: false, issues: ['successful-reply snapshot unavailable while A session ID is unknown'] };
  }
  const gate = replySnapshot.gate;
  const gateSessionId = gate?.descriptor?.sessionId;
  if (typeof gateSessionId === 'string' && gateSessionId.length) {
    return { ok: true, sessionId: gateSessionId, noGatePending: false, issues: [] };
  }
  if (gate === null && pageStartAttempted !== true) return { ok: true, sessionId: null, noGatePending: true, issues: [] };
  return { ok: false, sessionId: null, noGatePending: false, issues: ['A session/gate ownership is ambiguous; refusing to open the reply gate'] };
}

export function gateCleanupDisposition({ restoreInvalidation, stopInvalidation, contextReachable = true }) {
  if (restoreInvalidation?.ok) return { safeToOpen: true, path: 'confirmed-restore-invalidation' };
  if (stopInvalidation?.ok) return { safeToOpen: true, path: 'confirmed-stop-fallback' };
  return {
    safeToOpen: false,
    path: contextReachable ? 'dispose-context-before-gate-open' : 'context-already-unreachable',
  };
}

export async function teardownSuccessfulReplyGate({ preferStopFirst = false, restoreNeeded = true, stop, restore, confirmInvalidation, openGate, disposeContext }) {
  const errors = [];
  let stopInvalidation = null;
  let restoreInvalidation = null;
  let restoreResult = null;
  const stopAndConfirm = async () => {
    try {
      const response = await stop?.();
      if (response?.success !== true) errors.push('production Stop was not acknowledged');
    } catch (error) { errors.push(`production Stop failed: ${error?.message ?? String(error)}`); }
    try { stopInvalidation = await confirmInvalidation?.(); }
    catch (error) { stopInvalidation = { ok: false, issues: [error?.message ?? String(error)] }; }
    return stopInvalidation;
  };

  if (preferStopFirst) await stopAndConfirm();
  if (restoreNeeded) {
    try { restoreResult = await restore?.(); }
    catch (error) { restoreResult = { success: false, error: error?.message ?? String(error) }; }
    if (restoreResult?.success !== true) errors.push('production Restore was not acknowledged');
    else if (restoreResult?.terminalObserved !== true) errors.push('production Restore terminal event was not observed');
    try { restoreInvalidation = await confirmInvalidation?.(); }
    catch (error) { restoreInvalidation = { ok: false, issues: [error?.message ?? String(error)] }; }
  } else if (!preferStopFirst) {
    try { restoreInvalidation = await confirmInvalidation?.(); }
    catch (error) { restoreInvalidation = { ok: false, issues: [error?.message ?? String(error)] }; }
  }

  if (!restoreInvalidation?.ok && !stopInvalidation?.ok) await stopAndConfirm();
  let disposition = gateCleanupDisposition({ restoreInvalidation, stopInvalidation, contextReachable: true });
  if (disposition.safeToOpen) {
    try { await openGate?.(); }
    catch (error) {
      errors.push(`reply gate open failed after invalidation: ${error?.message ?? String(error)}`);
      disposition = { safeToOpen: false, path: 'dispose-context-after-gate-open-failure' };
      try {
        if (typeof disposeContext !== 'function') throw new Error('context disposer is unavailable');
        await disposeContext?.();
      } catch (disposeError) { errors.push(`context disposal after gate-open failure failed: ${disposeError?.message ?? String(disposeError)}`); }
    }
  } else {
    try { await disposeContext?.(); }
    catch (error) { errors.push(`Chrome context disposal failed: ${error?.message ?? String(error)}`); }
  }
  return {
    ...disposition,
    restoreResult,
    restoreInvalidation,
    stopInvalidation,
    errors,
  };
}

export function parseSuccessfulReplyProbeSelection(value) {
  if (value == null || value.trim() === '') return [];
  const probes = value.split(',').map(name => name.trim()).filter(Boolean);
  if (new Set(probes).size !== probes.length) throw new TypeError('Duplicate successful-reply probe name.');
  const unsupported = probes.filter(name => !successfulReplyProbeNames.includes(name));
  if (unsupported.length) throw new TypeError(`Unsupported successful-reply probes: ${unsupported.join(',')}`);
  return probes;
}

function batchMembers(batch) {
  return Array.isArray(batch) ? batch.map(item => ({ id: item?.id ?? null, text: item?.text ?? null })) : null;
}

function messageMembers(message) {
  try {
    const members = JSON.parse(message?.data?.text);
    return Array.isArray(members) ? members.map(item => ({ id: item?.id ?? item?.i ?? null, text: item?.text ?? item?.t ?? null })) : null;
  } catch { return null; }
}

export function validateSuccessfulReplyCapture({ expectedSessionId, selectedBatch, capturedMessage, gateSnapshot }) {
  const issues = [];
  if (!expectedSessionId || selectedBatch?.sessionId !== expectedSessionId) issues.push('captured scheduler batch is not owned by the expected Page session');
  if (selectedBatch?.ownerSessionId !== expectedSessionId || selectedBatch?.contextOwned !== true) issues.push('captured batch did not belong to current scheduler session/context at admission');
  if (!capturedMessage || capturedMessage.action !== PAGE_TRANSLATE_BATCH_WIRE_ACTION) issues.push('no exact PAGE_TRANSLATE_BATCH wire message was captured');
  if (!capturedMessage?.messageId || capturedMessage.messageId !== gateSnapshot?.descriptor?.messageId) issues.push('gate is not bound to the captured batch messageId');
  if (gateSnapshot?.descriptor?.action !== 'PAGE_TRANSLATE_BATCH') issues.push('gate descriptor is not scoped to the symbolic Page batch action');
  if (capturedMessage?.sessionId !== expectedSessionId || gateSnapshot?.descriptor?.sessionId !== expectedSessionId) issues.push('gate or message sessionId does not match the expected Page session');
  if (!Array.isArray(selectedBatch?.members) || !selectedBatch.members.length) issues.push('selected scheduler batch members are unavailable');
  if (JSON.stringify(selectedBatch?.members) !== JSON.stringify(capturedMessage?.members)) issues.push('captured message body differs from exact selected scheduler batch IDs/text');
  if (gateSnapshot?.captured !== true || gateSnapshot?.status !== 'captured') issues.push('gate did not positively capture a successful reply');
  if (gateSnapshot?.success !== true) issues.push('captured source outcome was not a genuine success');
  if (gateSnapshot?.error !== null) issues.push('gate reports an error');
  if (gateSnapshot?.sourceOutcome?.settled !== true || gateSnapshot?.sourceOutcome?.success !== true) issues.push('original runtime reply outcome was not observed as successful');
  if (gateSnapshot?.released === true) issues.push('successful reply was released before invalidation');
  return { ok: issues.length === 0, issues };
}

export function validateStaleSuccessEvidence({ gate, invalidation, guard, batch, acceptedAIds, acceptedBIds, expectedIds, domValues, bStillPending, lateLifecycle = [], schedulerBatchSettled = false, postInvalidationOk = false, domNoUnexpectedWrites = false, bStateStable = false, requireBPending = true }) {
  const issues = [];
  if (gate?.status !== 'released' || gate?.captured !== true || gate?.released !== true || gate?.settled !== true
      || gate?.success !== true || gate?.error !== null) issues.push('held genuine successful reply did not release successfully');
  const capturedSequence = gate?.events?.find(event => event.type === 'captured')?.sequence;
  const releasedSequence = gate?.events?.find(event => event.type === 'released')?.sequence;
  const settledSequence = gate?.events?.find(event => event.type === 'settled')?.sequence;
  if (!Number.isInteger(capturedSequence) || !Number.isInteger(releasedSequence) || !Number.isInteger(settledSequence)
      || releasedSequence <= capturedSequence || settledSequence <= releasedSequence) issues.push('gate capture/release/settlement event order is missing or invalid');
  if (gate?.deliveryIdentity?.responseIdentityPreserved !== true) issues.push('original successful reply identity was not preserved at delivery');
  if (!invalidation?.confirmed) issues.push('A invalidation was not positively observed before release');
  if (!Number.isInteger(invalidation?.order) || !Number.isInteger(gate?.releaseOrder)
      || gate.releaseOrder <= invalidation.order) issues.push('A reply release is not causally ordered after observed invalidation');
  if (guard?.observed !== true || guard?.ownsSession !== false || guard?.afterRelease !== true
      || guard?.sessionId !== batch?.sessionId || guard?.messageId !== batch?.messageId) {
    issues.push('no exact-session/message attributable call-through _ownsFlushSession(false) occurred after gate release');
  }
  if (!batch?.sessionId || !batch?.messageId || batch.sessionId !== gate?.descriptor?.sessionId || batch.messageId !== gate?.descriptor?.messageId) issues.push('stale reply and guard evidence do not identify the same exact A batch');
  if (acceptedAIds?.length) issues.push(`A accepted settlements occurred after invalidation: ${acceptedAIds.join(',')}`);
  if (!Array.isArray(lateLifecycle) || lateLifecycle.length) issues.push('A emitted or delivered lifecycle after invalidation');
  if (schedulerBatchSettled !== true) issues.push('A scheduler batch did not fulfill after its stale ownership guard');
  if (postInvalidationOk !== true) issues.push('post-invalidation settlement/DOM ownership evidence is incomplete or invalid');
  if (domNoUnexpectedWrites !== true) issues.push('post-release DOM contains an unexpected A/unowned value');
  if (requireBPending && bStateStable !== true) issues.push('B session counters, queue, context, controller, or runtime resources drifted');
  if (requireBPending && !bStillPending) issues.push('replacement B was not still pending when A reply was released');
  if (expectedIds?.length && (!Array.isArray(acceptedBIds) || acceptedBIds.length !== expectedIds.length
      || new Set(acceptedBIds).size !== expectedIds.length || expectedIds.some(id => !acceptedBIds.includes(id)))) {
    issues.push('B did not accept every expected target exactly once');
  }
  if (expectedIds?.length && (!Array.isArray(domValues) || domValues.length !== expectedIds.length
      || expectedIds.some(id => domValues.filter(([actualId]) => actualId === id).length !== 1))) {
    issues.push('final DOM does not contain each expected target exactly once');
  }
  return { ok: issues.length === 0, issues };
}

export function validateRuntimeResources(snapshot, { activeMessageId = null, terminalMessageIds = [], sessionIds = [], final = false } = {}) {
  const issues = [];
  if (snapshot?.available !== true) issues.push('runtime resource APIs are missing or unavailable');
  const lifecycleIds = snapshot?.lifecycle?.activeIds;
  const serviceActiveIds = snapshot?.service?.activeRequestIds;
  const requestStates = snapshot?.service?.requests;
  const queue = snapshot?.queue;
  const rateLimit = snapshot?.rateLimit;
  const lease = snapshot?.lease;
  const resolvers = snapshot?.sourceResolvers;
  if (!Array.isArray(lifecycleIds)) issues.push('lifecycle active-ID snapshot is missing');
  if (!Array.isArray(serviceActiveIds)) issues.push('request-tracker active-ID snapshot is missing');
  if (!Array.isArray(requestStates)) issues.push('request/operation ownership snapshot is missing');
  if (!queue || !queue.depths || !queue.processing || !Object.keys(queue.depths).length
      || !Object.keys(queue.processing).length || !Number.isInteger(queue.retryTimeoutCount)) issues.push('QueueManager queue/processing/retry snapshot is missing');
  else {
    if (Object.values(queue.depths).some(value => !Number.isInteger(value) || value < 0)) issues.push('QueueManager depth values are unavailable');
    if (Object.values(queue.processing).some(value => typeof value !== 'boolean')) issues.push('QueueManager processing flags are unavailable');
  }
  if (!rateLimit || typeof rateLimit !== 'object' || !Object.keys(rateLimit).length || Object.values(rateLimit).some(state => !Number.isInteger(state.activeRequests)
      || !Number.isInteger(state.queuedRequests) || typeof state.isProcessingQueue !== 'boolean')) issues.push('RateLimitManager active/queued snapshot is missing');
  if (!lease || !Array.isArray(lease.activeOperationIds) || !Number.isInteger(lease.activeOperationCount)
      || typeof lease.timerActive !== 'boolean') issues.push('BackgroundOperationLease snapshot is missing');
  else if ((lease.activeOperationCount > 0) !== (lease.activeOperationIds.length > 0)) issues.push('BackgroundOperationLease ID/count accounting is inconsistent');
  if (!resolvers || typeof resolvers !== 'object' || sessionIds.some(id => !Object.prototype.hasOwnProperty.call(resolvers, id))) {
    issues.push('session AUTO-resolution snapshot is missing');
  }
  if (!requestStates) return { ok: false, issues };

  if (activeMessageId) {
    if (!lifecycleIds?.includes(activeMessageId) || !serviceActiveIds?.includes(activeMessageId)) issues.push('expected active request is not registered in both lifecycle and service tracker');
    if (lifecycleIds?.some(id => id !== activeMessageId) || serviceActiveIds?.some(id => id !== activeMessageId)) issues.push('unrelated active lifecycle/service request exists during isolated probe');
    if (!lease?.activeOperationIds?.includes(activeMessageId)) issues.push(`BackgroundOperationLease does not hold the exact active request ID ${activeMessageId}`);
    const request = requestStates.find(item => item.messageId === activeMessageId);
    if (!request || !['pending', 'processing', 'streaming'].includes(request.status) || request.operationOwned !== true) {
      issues.push('expected active request status/operation ownership is unavailable');
    }
  }
  for (const messageId of terminalMessageIds) {
    const request = requestStates.find(item => item.messageId === messageId);
    if (!request || !['completed', 'failed', 'cancelled', 'timeout'].includes(request.status) || request.operationOwned !== false) {
      issues.push(`terminal request/operation cleanup is unavailable for ${messageId}`);
    }
    if (lifecycleIds?.includes(messageId) || serviceActiveIds?.includes(messageId)) issues.push(`terminal request remains active: ${messageId}`);
  }
  if (final) {
    if (lifecycleIds?.length || serviceActiveIds?.length) issues.push('active lifecycle/service requests remain after cleanup');
    if (queue && (Object.values(queue.depths).some(value => value !== 0)
        || Object.values(queue.processing).some(Boolean) || queue.retryTimeoutCount !== 0)) issues.push('QueueManager retains queued, processing, or retry work');
    if (rateLimit && Object.values(rateLimit).some(state => state.activeRequests !== 0 || state.queuedRequests !== 0 || state.isProcessingQueue)) {
      issues.push('RateLimitManager retains active, queued, or processing work');
    }
    if (lease && (lease.activeOperationIds.length !== 0 || lease.activeOperationCount !== 0 || lease.timerActive)) issues.push('background operation lease remains active');
    for (const id of sessionIds) if (resolvers?.[id]?.present !== false) issues.push(`AUTO source resolver remains for ${id}`);
  }
  return { ok: issues.length === 0, issues };
}

export function validateReplacementStability({ schedulerBefore, schedulerAfter, resourcesBefore, resourcesAfter, providerRootAfter, controllerAfter, heldRequest, sessionId, messageId, terminalMessageIds = [], sessionIds = [] }) {
  const issues = [];
  const schedulerFields = ['translationSessionId', 'isTranslated', 'translatedCount', 'failedCount', 'totalTasks', 'activeFlushes',
    'sessionContextOwned', 'pendingSettlementCount', 'batchTimerActive', 'completionTimerActive', 'discoveryPending',
    'bridgeSessionOwned', 'bridgeSessionActive', 'bridgeDiscoveryPending', 'bridgeDiscoveryRunning',
    'bridgeDiscoveryStarting', 'bridgeDiscoveryQueueDepth', 'bridgeDiscoveryCancelled', 'bridgeDiscoveryFailed'];
  if (!schedulerBefore || !schedulerAfter || schedulerFields.some(key => schedulerBefore[key] === null || schedulerBefore[key] === undefined
      || schedulerAfter[key] === null || schedulerAfter[key] === undefined)
      || !Array.isArray(schedulerBefore?.queueIds) || !Array.isArray(schedulerAfter?.queueIds)
      || !Array.isArray(schedulerBefore?.activeBatchIds) || !Array.isArray(schedulerAfter?.activeBatchIds)) issues.push('B scheduler snapshot fields are unavailable');
  else if (schedulerFields.some(key => schedulerBefore[key] !== schedulerAfter[key])
      || JSON.stringify(schedulerBefore.queueIds) !== JSON.stringify(schedulerAfter.queueIds)
      || JSON.stringify(schedulerBefore.activeBatchIds) !== JSON.stringify(schedulerAfter.activeBatchIds)) {
    issues.push('B scheduler counters, queue, active batches, context, or timers changed');
  }
  const beforeValidation = validateRuntimeResources(resourcesBefore, {
    activeMessageId: messageId, terminalMessageIds, sessionIds,
  });
  const afterValidation = validateRuntimeResources(resourcesAfter, {
    activeMessageId: messageId, terminalMessageIds, sessionIds,
  });
  issues.push(...beforeValidation.issues.map(issue => `before A release: ${issue}`), ...afterValidation.issues.map(issue => `after A release: ${issue}`));
  for (const key of ['lifecycle', 'queue', 'rateLimit', 'lease', 'sourceResolvers', 'service']) {
    if (JSON.stringify(resourcesBefore?.[key]) !== JSON.stringify(resourcesAfter?.[key])) issues.push(`B/worker ${key} snapshot changed during A reply release`);
  }
  if (heldRequest?.pageSessionId !== sessionId || heldRequest?.batchMessageId !== messageId
      || heldRequest?.released !== false || heldRequest?.handlerSettled !== false) issues.push('B held Fetch is not still pending for the exact locked session/message');
  if (providerRootAfter?.sessionId !== sessionId || providerRootAfter?.messageId !== messageId || providerRootAfter?.status !== 'pending') {
    issues.push('B provider root is not still pending for the exact locked session/message');
  }
  if (controllerAfter?.sessionId !== sessionId || controllerAfter?.messageId !== messageId || controllerAfter?.aborted !== false) {
    issues.push('B controller is not still active for the exact locked session/message');
  }
  return { ok: issues.length === 0, issues, resourceValidationBefore: beforeValidation, resourceValidationAfter: afterValidation };
}

export function validateReplacementDiscoverySnapshot({ snapshot, sessionId, targetCount, firstBatchSize, settlementOperations = [] }) {
  const issues = [];
  if (!snapshot || snapshot.translationSessionId !== sessionId || snapshot.isTranslated !== true
      || snapshot.sessionContextOwned !== true || snapshot.bridgeSessionOwned !== true || snapshot.bridgeSessionActive !== true) {
    issues.push('B scheduler/Bridge is not the exact active session owner');
  }
  if (snapshot?.discoveryPending !== false || snapshot?.bridgeDiscoveryPending !== false
      || snapshot?.bridgeDiscoveryRunning !== false || snapshot?.bridgeDiscoveryStarting !== false
      || snapshot?.bridgeDiscoveryQueueDepth !== 0 || snapshot?.bridgeDiscoveryCancelled !== false
      || snapshot?.bridgeDiscoveryFailed !== false) issues.push('B Bridge/Scheduler discovery is not fully drained');
  if (!Number.isInteger(snapshot?.totalTasks) || snapshot.totalTasks !== targetCount) issues.push(`B discovery admitted ${snapshot?.totalTasks ?? 'unknown'} of ${targetCount} expected targets`);
  if (!Array.isArray(snapshot?.queueIds) || snapshot.queueIds.length !== targetCount - firstBatchSize) issues.push('B scheduler queue does not contain exactly the undispatched target remainder');
  if (!Array.isArray(snapshot?.activeBatchIds) || snapshot.activeBatchIds.length !== firstBatchSize) issues.push('B active batch accounting does not match the held first batch size');
  if (!Number.isInteger(snapshot?.pendingSettlementCount) || snapshot.pendingSettlementCount !== 0) issues.push('B has pre-provider pending settlement records while its first response is held');
  if (snapshot?.translatedCount !== 0 || snapshot?.failedCount !== 0) issues.push('B settled work before the held first provider response');
  const earlySettlements = settlementOperations.filter(operation => operation.kind === 'scheduler.settlement'
    && operation.sessionId === sessionId && ['accepted', 'failed', 'stale', 'cancelled'].includes(operation.outcome) && operation.changed === true);
  if (earlySettlements.length) issues.push(`B has ${earlySettlements.length} settlements before the stale A response is released`);
  return { ok: issues.length === 0, issues, admittedTaskCount: snapshot?.totalTasks ?? null, queuedCount: snapshot?.queueIds?.length ?? null, activeBatchCount: snapshot?.activeBatchIds?.length ?? null };
}

/** Installs reversible call-through probes before the Page start command. */
export function installSuccessfulReplyProbe({ runtime, scheduler, gateFactory = createSuccessfulReplyGate, timeoutMs = 10_000 }) {
  if (runtime !== undefined && runtime !== null && typeof runtime.sendMessage !== 'function') throw new TypeError('runtime.sendMessage is unavailable');
  if (typeof scheduler?._executeBatchRequest !== 'function' || typeof scheduler?._ownsFlushSession !== 'function') {
    throw new TypeError('Page scheduler ownership methods are unavailable');
  }

  const originalSendMessage = runtime?.sendMessage;
  const originalSendDescriptor = runtime ? Object.getOwnPropertyDescriptor(runtime, 'sendMessage') : null;
  const originalExecuteBatch = scheduler._executeBatchRequest;
  const originalExecuteDescriptor = Object.getOwnPropertyDescriptor(scheduler, '_executeBatchRequest');
  const requireTrackedSelectedBatch = scheduler?.constructor?.prototype === scheduler;
  const byContext = new Map();
  const executionStack = [];
  const inFlightExecutions = new Set();
  const instanceGuardRecords = new Map();
  const events = [];
  const guards = [];
  const guardDiagnostics = [];
  const instrumentationErrors = [];
  let armed = false;
  let closed = false;
  let selectedBatch = null;
  let capturedMessage = null;
  let sourceOutcome = null;
  let sourceResponse;
  let sourceError;
  let deliveryIdentity = null;
  let gate = null;
  let interceptedReplyPromise = null;
  let wrappersRestored = false;
  let restoreAfterReplyScheduled = false;

  const record = (name, data = {}) => {
    const event = { name, at: Date.now(), ...data };
    events.push(event);
    return event;
  };

  const restoreProperty = (target, key, wrapper, descriptor) => {
    if (target?.[key] !== wrapper) return false;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
    return true;
  };

  const restoreWrappers = () => {
    if (wrappersRestored) return;
    if (runtime) restoreProperty(runtime, 'sendMessage', sendMessage, originalSendDescriptor);
    restoreProperty(scheduler, '_executeBatchRequest', executeBatch, originalExecuteDescriptor);
    for (const [instance, guard] of instanceGuardRecords) restoreProperty(instance, '_ownsFlushSession', guard.wrapper, guard.descriptor);
    wrappersRestored = true;
    instanceGuardRecords.clear();
    byContext.clear();
    inFlightExecutions.clear();
    record('probe-wrappers-restored');
  };

  const installInstanceGuard = (instance, execution) => {
    if (instanceGuardRecords.has(instance)) return;
    const descriptor = Object.getOwnPropertyDescriptor(instance, '_ownsFlushSession');
    if (descriptor && descriptor.configurable === false) throw new Error('Live scheduler _ownsFlushSession property is not configurable');
    const original = instance._ownsFlushSession;
    if (typeof original !== 'function') throw new TypeError('Live scheduler _ownsFlushSession method is unavailable');
    const wrapped = function (sessionId, sessionContext, ...args) {
      const gateSnapshot = gate?.snapshot?.() ?? null;
      const mappedExecution = sessionContext === null || sessionContext === undefined ? null : byContext.get(sessionContext);
      const matchingInFlight = [...inFlightExecutions].filter(candidate => candidate.sessionId === sessionId
        && candidate.flushContext === sessionContext);
      const exactSelectedExecution = matchingInFlight.length === 1 && matchingInFlight[0] === execution
        && execution === selectedBatch && (!requireTrackedSelectedBatch || execution.batchTrackedAtEntry);
      const diagnostic = {
        observed: true,
        source: 'live-scheduler-instance',
        sessionId,
        messageId: exactSelectedExecution ? execution.messageId : null,
        selectedMessageId: execution.messageId ?? null,
        selectedSessionId: execution.sessionId,
        contextMapLookupMatched: mappedExecution === execution,
        contextMatchesSelected: sessionContext === execution.flushContext,
        executionStackContainsSelected: executionStack.includes(execution),
        inFlightExecutionCount: matchingInFlight.length,
        selectedExecutionInFlight: matchingInFlight.includes(execution),
        exactSelectedExecution,
        selectedBatchTrackedAtEntry: execution.batchTrackedAtEntry,
        trackedBatchRequired: requireTrackedSelectedBatch,
        ownMethodRetained: this._ownsFlushSession === wrapped,
        receiverIsInstalledInstance: this === instance,
        receiverConstructorName: this?.constructor?.name ?? null,
        currentOwnerSessionId: this.translationSessionId ?? null,
        currentOwnerContextMatches: this.sessionContext === execution.flushContext,
        ownsSession: null,
        afterRelease: gateSnapshot?.released === true,
        gateStatus: gateSnapshot?.status ?? null,
        at: Date.now(),
      };
      guardDiagnostics.push(diagnostic);
      record('scheduler-ownership-check', diagnostic);
      let ownsSession;
      try { ownsSession = original.call(this, sessionId, sessionContext, ...args); }
      catch (error) {
        diagnostic.threw = true;
        diagnostic.errorName = error?.name ?? 'Error';
        record('scheduler-ownership-result', diagnostic);
        throw error;
      }
      diagnostic.ownsSession = ownsSession === true;
      record('scheduler-ownership-result', diagnostic);
      if (exactSelectedExecution && mappedExecution === execution && diagnostic.afterRelease
          && execution.messageId && execution.messageId === capturedMessage?.messageId
          && sessionId === capturedMessage?.sessionId && ownsSession === false) {
        guards.push({
          observed: true,
          sessionId,
          messageId: execution.messageId,
          ownsSession: false,
          afterRelease: true,
          at: diagnostic.at,
          source: 'live-scheduler-instance',
          inFlightExecutionCount: matchingInFlight.length,
          contextMapLookupMatched: true,
          selectedBatchTrackedAtEntry: execution.batchTrackedAtEntry,
        });
      }
      return ownsSession;
    };
    Object.defineProperty(instance, '_ownsFlushSession', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: wrapped,
    });
    if (instance._ownsFlushSession !== wrapped) throw new Error('Live scheduler guard wrapper was not retained');
    instanceGuardRecords.set(instance, {
      wrapper: wrapped,
      descriptor,
      execution,
      originalMethodName: original.name ?? null,
      originalMethodSource: Function.prototype.toString.call(original).slice(0, 500),
      prototypeMethodName: Object.getPrototypeOf(instance)?._ownsFlushSession?.name ?? null,
      instanceConstructorName: instance?.constructor?.name ?? null,
    });
    record('live-scheduler-guard-installed', {
      selectedSessionId: execution.sessionId,
      contextType: typeof execution.flushContext,
      hadOwnGuard: !!descriptor,
    });
  };

  const executeBatch = function (batch, config, flushContext, sessionId, ...rest) {
    const members = batchMembers(batch);
    const activeBatch = this.activeBatches instanceof Set
      ? [...this.activeBatches].find(candidate => JSON.stringify(candidate.items?.map(item => item?.id ?? null))
        === JSON.stringify(members?.map(item => item.id)))
      : null;
    const execution = {
      sessionId,
      ownerSessionId: this.translationSessionId ?? null,
      contextOwned: this.sessionContext === flushContext,
      flushContext,
      members,
      batchTrackedAtEntry: !!activeBatch,
      messageId: null,
    };
    if (armed && !selectedBatch && execution.ownerSessionId === sessionId && execution.contextOwned) {
      selectedBatch = execution;
      if (flushContext !== null && flushContext !== undefined) byContext.set(flushContext, execution);
      try { installInstanceGuard(this, execution); }
      catch (error) {
        instrumentationErrors.push(error?.message ?? String(error));
        record('live-scheduler-guard-install-failed', { message: instrumentationErrors.at(-1), sessionId });
        throw error;
      }
      record('scheduler-execution-selected', {
        sessionId, ownerSessionId: execution.ownerSessionId, contextOwned: execution.contextOwned,
        contextType: typeof flushContext, members, batchTrackedAtEntry: execution.batchTrackedAtEntry,
      });
    }
    executionStack.push(execution);
    inFlightExecutions.add(execution);
    let result;
    try { result = originalExecuteBatch.call(this, batch, config, flushContext, sessionId, ...rest); }
    catch (error) {
      inFlightExecutions.delete(execution);
      executionStack.pop();
      throw error;
    }
    executionStack.pop();
    if (result && typeof result.then === 'function') {
      result.then(() => inFlightExecutions.delete(execution), () => inFlightExecutions.delete(execution));
    } else inFlightExecutions.delete(execution);
    return result;
  };

  const interceptSchedulerBatchReply = (message, originalPromise) => {
    const execution = executionStack.at(-1);
    const isTarget = armed && !closed && !gate && execution && execution === selectedBatch && message?.action === PAGE_TRANSLATE_BATCH_WIRE_ACTION
      && message?.data?.sessionId === execution.sessionId && typeof message?.messageId === 'string';
    if (!isTarget) return originalPromise;

    const captured = {
      action: message.action,
      messageId: message.messageId,
      sessionId: message.data.sessionId,
      members: messageMembers(message),
    };
    execution.messageId = captured.messageId;
    capturedMessage = captured;
    record('batch-message-selected', { ...captured });
    gate = gateFactory({
      sessionId: captured.sessionId,
      messageId: captured.messageId,
      timeoutMs,
      onEvent: event => record('gate', { event }),
    });
    Promise.resolve(originalPromise).then(
      value => { sourceResponse = value; sourceOutcome = { settled: true, success: value?.success === true, hasError: value?.hasError === true }; },
      error => { sourceError = error; sourceOutcome = { settled: true, rejected: true, errorName: error?.name ?? 'Error' }; },
    );
    // The gate descriptor names the symbolic action; production serializes its constant as lowercase on the wire.
    const intercepted = gate.intercept({ ...message, action: 'PAGE_TRANSLATE_BATCH' }, originalPromise);
    interceptedReplyPromise = intercepted;
    Promise.resolve(intercepted).then(
      value => {
        deliveryIdentity = { responseIdentityPreserved: value === sourceResponse };
        record('reply-settled', { sessionId: captured.sessionId, messageId: captured.messageId, success: value?.success === true, hasError: value?.hasError === true, ...deliveryIdentity });
      },
      error => {
        deliveryIdentity = { errorIdentityPreserved: error === sourceError };
        record('reply-settled', { sessionId: captured.sessionId, messageId: captured.messageId, rejected: true, errorName: error?.name ?? 'Error', ...deliveryIdentity });
      },
    );
    return intercepted;
  };

  const sendMessage = runtime ? function (message, ...args) {
    return interceptSchedulerBatchReply(message, originalSendMessage.call(this, message, ...args));
  } : null;

  if (runtime) runtime.sendMessage = sendMessage;
  scheduler._executeBatchRequest = executeBatch;
  if ((runtime && runtime.sendMessage !== sendMessage) || scheduler._executeBatchRequest !== executeBatch) {
    if (runtime) restoreProperty(runtime, 'sendMessage', sendMessage, originalSendDescriptor);
    restoreProperty(scheduler, '_executeBatchRequest', executeBatch, originalExecuteDescriptor);
    for (const [instance, guard] of instanceGuardRecords) restoreProperty(instance, '_ownsFlushSession', guard.wrapper, guard.descriptor);
    throw new Error('Successful-reply call-through probe wrappers were not retained');
  }

  return {
    arm() { if (closed) throw new Error('Successful-reply probe is closed'); armed = true; },
    interceptSchedulerBatchReply,
    release() { return gate?.release?.() ?? false; },
    close(reason = 'probe-cleanup') {
      if (closed) return false;
      closed = true;
      if (gate) gate.close(reason);
      if (gate?.snapshot?.().pending === true && interceptedReplyPromise) {
        if (!restoreAfterReplyScheduled) {
          restoreAfterReplyScheduled = true;
          Promise.resolve(interceptedReplyPromise).then(restoreWrappers, restoreWrappers);
        }
      } else {
        restoreWrappers();
      }
      return true;
    },
    snapshot() {
      const gateSnapshot = gate?.snapshot?.() ?? null;
      const matchingGuard = guards.find(item => item.sessionId === gateSnapshot?.descriptor?.sessionId
        && item.messageId === gateSnapshot?.descriptor?.messageId && item.observed === true
        && item.ownsSession === false && item.afterRelease);
      return {
        armed,
        closed,
        wrappersRestored,
        selectedBatch: selectedBatch ? {
          sessionId: selectedBatch.sessionId,
          ownerSessionId: selectedBatch.ownerSessionId,
          contextOwned: selectedBatch.contextOwned,
          batchTrackedAtEntry: selectedBatch.batchTrackedAtEntry,
          members: selectedBatch.members,
          messageId: selectedBatch.messageId,
        } : null,
        capturedMessage,
        gate: gateSnapshot ? {
          ...gateSnapshot,
          success: sourceOutcome?.success === true && sourceOutcome?.hasError !== true,
          sourceOutcome,
          deliveryIdentity,
        } : null,
        sourceOutcome,
        guards: guards.map(item => ({ ...item })),
        guardDiagnostics: guardDiagnostics.map(item => ({ ...item })),
        guardInstallations: [...instanceGuardRecords].map(([instance, installed]) => ({
          selectedSessionId: installed.execution.sessionId,
          selectedMessageId: installed.execution.messageId,
          ownPropertyBeforeInstall: !!installed.descriptor,
          originalMethodName: installed.originalMethodName,
          originalMethodSource: installed.originalMethodSource,
          prototypeMethodName: installed.prototypeMethodName,
          instanceConstructorName: installed.instanceConstructorName,
          ownWrapperRetained: instance._ownsFlushSession === installed.wrapper,
          currentMethodName: instance._ownsFlushSession?.name ?? null,
        })),
        instrumentationErrors: [...instrumentationErrors],
        staleGuard: matchingGuard ?? null,
        events: [...events],
      };
    },
  };
}

export const cancellationProbeNames = Object.freeze(['stop', 'restore', 'replacement']);

export function sessionIdForTranslationContext(contextOwners, context) {
  return contextOwners?.get(context) ?? null;
}

export function parseCancellationProbeSelection(value) {
  if (value == null || value.trim() === '') return [];
  const probes = value.split(',').map(name => name.trim()).filter(Boolean);
  if (new Set(probes).size !== probes.length) throw new TypeError('Duplicate cancellation probe name.');
  const unsupported = probes.filter(name => !cancellationProbeNames.includes(name));
  if (unsupported.length) throw new TypeError(`Unsupported cancellation probes: ${unsupported.join(',')}`);
  return probes;
}

export function createCancellationLedger() {
  let sequence = 0;
  const operations = [];
  return {
    operations,
    begin(kind, sessionId, detail = {}) {
      const operation = { sequence: ++sequence, kind, sessionId, status: 'pending', ...detail };
      operations.push(operation);
      return operation;
    },
    settle(operation, status, detail = {}) {
      if (!operation || operation.status !== 'pending') return false;
      Object.assign(operation, detail, { status, settledSequence: ++sequence });
      return true;
    },
    record(kind, sessionId, detail = {}) {
      const event = { sequence: ++sequence, kind, sessionId, ...detail };
      operations.push(event);
      return event;
    },
    snapshot(sessionId) {
      const selected = operations.filter(operation => sessionId === undefined || operation.sessionId === sessionId);
      return {
        sequence,
        operations: selected.map(operation => ({ ...operation })),
        pending: selected.filter(operation => operation.status === 'pending').length,
      };
    },
  };
}

export function installTrustedLifecycleObserver(target, method, observe) {
  const original = target?.[method];
  if (typeof original !== 'function') return false;
  const wrapped = function (...args) {
    const result = original.apply(this, args);
    const event = args[0] ?? {};
    const data = event.data ?? {};
    observe({
      action: event.action ?? null,
      sessionId: data.sessionId ?? null,
      accepted: result?.success === true && result?.ignored !== true,
      result,
    });
    return result;
  };
  target[method] = wrapped;
  return target[method] === wrapped;
}

export function promoteRequestDiagnostics(trial) {
  const observationErrors = Array.isArray(trial?.cancellation?.observationErrors) ? trial.cancellation.observationErrors : [];
  const transportErrors = Array.isArray(trial?.transportErrors) ? trial.transportErrors : [];
  if (!observationErrors.length && !transportErrors.length) return { ok: true, observationErrors, transportErrors };
  const diagnostics = { observationErrors: observationErrors.map(item => ({ ...item })), transportErrors: [...transportErrors] };
  if (trial.cancellation) trial.cancellation.diagnosticFailures = diagnostics;
  trial.status = 'failed';
  trial.error ??= { name: 'RequestHandlerDiagnosticsError', message: 'Request-handler diagnostics failed.' };
  if (!trial.error.cancellationDiagnostics) {
    trial.error.message = `${trial.error.message ?? 'Request-handler diagnostics failed.'} Observation errors: ${observationErrors.length}; transport errors: ${transportErrors.length}.`;
  }
  trial.error.cancellationDiagnostics = diagnostics;
  return { ok: false, ...diagnostics };
}

export function trackRequiredCancellationPromise(ledger, kind, sessionId, promise, detail = {}, onUnsupported = () => {}, operation = null) {
  const trackedOperation = operation ?? ledger.begin(kind, sessionId, detail);
  if (!promise || typeof promise.then !== 'function') {
    ledger.settle(trackedOperation, 'unsupported-non-promise', { returnedType: promise === null ? 'null' : typeof promise });
    onUnsupported(`${kind} expected a Promise result.`);
    return { supported: false, operation: trackedOperation };
  }
  promise.then(
    response => ledger.settle(trackedOperation, 'fulfilled', { response }),
    error => ledger.settle(trackedOperation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error) }),
  );
  return { supported: true, operation: trackedOperation };
}

export function installCancellationRuntimeMessageObserver(runtime, ledger, onUnsupported = () => {}) {
  const original = runtime?.sendMessage;
  if (typeof original !== 'function') return { installed: false, reason: 'runtime.sendMessage unavailable' };
  const wrapped = function (message, ...args) {
    const action = message?.action;
    const data = message?.data?.data ?? message?.data ?? {};
    const lifecycleAction = action === 'page-translation-frame-lifecycle' ? message?.data?.action ?? null : null;
    const sessionId = data?.sessionId ?? data?.messageId ?? null;
    const isLifecycle = action === 'page-translation-frame-lifecycle';
    const isCancellation = action === 'CANCEL_TRANSLATION' || action === 'CANCEL_SESSION';
    if (!isLifecycle && !isCancellation) return original.call(this, message, ...args);
    const kind = isLifecycle ? 'runtime.lifecycle.send'
      : action === 'CANCEL_TRANSLATION' ? 'runtime.cancel.send' : 'runtime.cancelSession.send';
    const detail = { action: lifecycleAction ?? action };
    const operation = ledger.begin(kind, sessionId, detail);
    let result;
    try { result = original.call(this, message, ...args); }
    catch (error) {
      ledger.settle(operation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error) });
      throw error;
    }
    trackRequiredCancellationPromise(ledger, kind, sessionId, result, detail, onUnsupported, operation);
    return result;
  };
  try { runtime.sendMessage = wrapped; }
  catch (error) { return { installed: false, reason: error?.message ?? String(error) }; }
  return { installed: runtime.sendMessage === wrapped };
}

export function createCancellationRequestLifecycle(dispatchRelease) {
  const reservations = new Map();
  const handlerJobs = new Map();
  let nextId = 0;
  let closing = false;

  function reserve({ requestId, sessionId, networkId = null, requestRecord = null }) {
    const id = ++nextId;
    let resolveRelease;
    const releaseGate = new Promise(resolve => { resolveRelease = resolve; });
    const record = {
      id, requestId, sessionId, networkId, requestRecord,
      held: false, releaseRequested: false, releaseAction: null,
      releaseOutcome: null, releasePromise: null, handlerSettled: false,
      handlerError: null, releaseClassification: null, releaseGate,
      hold() {
        if (closing || record.releaseRequested) return false;
        record.held = true;
        return true;
      },
      waitForRelease: () => releaseGate,
      release(action, detail = {}) {
        if (record.releasePromise) return record.releasePromise;
        record.releaseRequested = true;
        record.releaseAction = action;
        resolveRelease({ action, detail });
        record.releasePromise = Promise.resolve().then(() => dispatchRelease(record, action, detail)).then(
          outcome => {
            record.releaseOutcome = outcome ?? { ok: true, action };
            return record.releaseOutcome;
          },
          error => {
            record.releaseOutcome = { ok: false, action, errorName: error?.name ?? 'Error', error: error?.message ?? String(error) };
            return record.releaseOutcome;
          },
        );
        return record.releasePromise;
      },
      classifyRelease(classification) {
        if (classification?.ok !== true) return false;
        record.releaseClassification = classification.classification;
        return true;
      },
    };
    reservations.set(id, record);
    if (closing) void record.release('fail', { reason: 'admitted-during-cleanup' });
    return record;
  }

  function trackHandler(record, promise) {
    const jobId = record?.id ?? ++nextId;
    const job = Promise.resolve(promise);
    handlerJobs.set(jobId, { jobId, requestId: record?.requestId ?? null, job });
    if (record) record.handlerPromise = job;
    job.then(
      () => { handlerJobs.delete(jobId); if (record) record.handlerSettled = true; },
      error => {
        handlerJobs.delete(jobId);
        if (record) {
          record.handlerSettled = true;
          record.handlerError = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
        }
      },
    );
    return job;
  }

  async function closeAndDrain({ disableFetch, timeoutMs = 5_000 } = {}) {
    closing = true;
    const errors = [];
    let timedOut = false;
    let deadlineTimer;
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimeout(() => { timedOut = true; resolve({ timedOut: true }); }, timeoutMs);
      deadlineTimer.unref?.();
    });
    const withinDeadline = promise => Promise.race([
      Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
      deadline,
    ]);

    // Close admission before settling the known requests. Later admissions observe `closing`
    // and self-release; Fetch.disable's acknowledgement is the event-stream barrier.
    const initialReleases = [...reservations.values()].map(record => record.release('fail', { reason: 'teardown' }));
    if (disableFetch) {
      const disabled = await withinDeadline(Promise.resolve().then(disableFetch));
      if (disabled?.timedOut) errors.push(`Fetch.disable timed out after ${timeoutMs}ms.`);
      else if (disabled?.error) errors.push(`Fetch.disable failed: ${disabled.error.message}`);
    }

    while (handlerJobs.size && !timedOut) {
      const settled = await Promise.race([
        Promise.race([...handlerJobs.values()].map(entry => entry.job.then(() => true, () => true))),
        deadline,
      ]);
      if (settled?.timedOut) timedOut = true;
    }
    if (handlerJobs.size) {
      errors.push(`Request handlers did not drain before deadline: ${[...handlerJobs.values()].map(entry => entry.requestId ?? entry.jobId).join(',')}`);
    }

    const allReleases = [...reservations.values()].map(record => record.releasePromise ?? record.release('fail', { reason: 'teardown-after-admission' }));
    const releaseResult = await withinDeadline(Promise.all([...initialReleases, ...allReleases]));
    if (releaseResult?.timedOut) errors.push(`Fetch release commands did not settle before deadline: ${[...reservations.values()].filter(record => record.releaseOutcome === null).map(record => record.requestId).join(',')}`);
    else if (releaseResult?.error) errors.push(`Fetch release tracking failed: ${releaseResult.error.message}`);

    for (const record of reservations.values()) {
      if (!record.releaseOutcome) errors.push(`Fetch ${record.requestId} release outcome unavailable`);
      else if (record.releaseOutcome.ok !== true && !record.releaseClassification) errors.push(`Fetch ${record.requestId} teardown release failed: ${record.releaseOutcome.error ?? record.releaseOutcome.action}`);
      if (!record.handlerSettled) errors.push(`Fetch ${record.requestId} handler did not settle`);
      if (record.handlerError) errors.push(`Fetch ${record.requestId} handler failed: ${record.handlerError.message}`);
    }
    clearTimeout(deadlineTimer);
    return {
      ok: errors.length === 0,
      closing,
      handlerCount: handlerJobs.size,
      reservationCount: reservations.size,
      reservations: [...reservations.values()].map(record => ({
        requestId: record.requestId, sessionId: record.sessionId, networkId: record.networkId,
        held: record.held, releaseAction: record.releaseAction, releaseOutcome: record.releaseOutcome,
        releaseClassification: record.releaseClassification,
        handlerSettled: record.handlerSettled, handlerError: record.handlerError,
      })),
      errors,
    };
  }

  return {
    reserve,
    trackHandler,
    closeAndDrain,
    get closing() { return closing; },
    get handlerCount() { return handlerJobs.size; },
    get reservations() { return [...reservations.values()]; },
  };
}

export function validateCancellationSetup({ sessionId, firstBatchIds, acceptedIds, heldBatchIds, heldControllerAborted, heldProviderRootStatus }) {
  const issues = [];
  if (typeof sessionId !== 'string' || !sessionId) issues.push('real translation session ID unavailable');
  if (!Array.isArray(firstBatchIds) || firstBatchIds.length !== 25 || new Set(firstBatchIds).size !== 25) {
    issues.push('first physical batch must contain 25 unique target IDs');
  }
  if (!Array.isArray(acceptedIds) || new Set(acceptedIds).size !== acceptedIds.length
      || !Array.isArray(firstBatchIds) || firstBatchIds.some(id => !acceptedIds.includes(id))) {
    issues.push('all first-batch targets must be uniquely accepted before cancellation');
  }
  if (!Array.isArray(heldBatchIds) || heldBatchIds.length === 0
      || !Array.isArray(firstBatchIds) || !heldBatchIds.some(id => !firstBatchIds.includes(id))) {
    issues.push('held physical request must map to a different scheduler batch');
  }
  if (heldControllerAborted !== false) issues.push('matched held-request controller was already aborted or unavailable');
  if (heldProviderRootStatus !== 'pending') issues.push('matched provider root promise was not pending at the hold barrier');
  return { ok: issues.length === 0, issues };
}

export function validateSingleHeldRequest(requests, sessionId) {
  const issues = [];
  if (!Array.isArray(requests) || requests.length !== 1) issues.push(`expected exactly one held request for ${sessionId}, got ${Array.isArray(requests) ? requests.length : 'unavailable'}`);
  const request = Array.isArray(requests) && requests.length === 1 ? requests[0] : null;
  if (request && (request.pageSessionId !== sessionId || typeof request.requestId !== 'string'
      || typeof request.batchMessageId !== 'string' || !Array.isArray(request.targetIds))) {
    issues.push(`held request is not fully correlated to ${sessionId}`);
  }
  return { ok: issues.length === 0, issues, request };
}

export function validateCancellationQuiescence({
  sessionId, capturedSessionActive, discoveryCancelled, controllerAborted,
  pendingOperations, heldRequestReleased, providerRootSettled, cancelAcknowledged, cancelTargetSessionId = sessionId,
}) {
  const issues = [];
  if (typeof sessionId !== 'string' || !sessionId) issues.push('retired session ID unavailable');
  if (capturedSessionActive !== false) issues.push('captured session is still active or unavailable');
  if (discoveryCancelled !== true) issues.push('captured discovery is not cancelled');
  if (controllerAborted !== true) issues.push('matched provider controller abort was not observed');
  if (pendingOperations !== 0) issues.push(`producer operations remain unsettled: ${pendingOperations}`);
  if (heldRequestReleased !== true) issues.push('held Fetch request was not released and settled');
  if (providerRootSettled !== true) issues.push('provider root promise remains unsettled');
  if (cancelAcknowledged !== true) issues.push('production cancellation acknowledgement unavailable');
  if (cancelTargetSessionId !== sessionId) issues.push('cancellation targeted a different session');
  return { ok: issues.length === 0, issues };
}

export function validateMatchedCancellation({ sessionId, messageId, serviceCall, abortEvent, controller }) {
  const issues = [];
  if (serviceCall?.status !== 'fulfilled' || serviceCall.response?.handled !== true || serviceCall.response?.success !== true) {
    issues.push('service cancellation did not return a successful handled response');
  }
  if (serviceCall?.sessionId !== sessionId || serviceCall?.messageId !== messageId) issues.push('service cancellation matched a different session or batch message');
  if (serviceCall?.controllerMatched !== true || serviceCall.controllerAbortedBefore !== false || serviceCall.controllerAbortedAfter !== true) {
    issues.push('service cancellation did not abort the previously live matched controller');
  }
  if (abortEvent?.sessionId !== sessionId || abortEvent?.messageId !== messageId
      || !Number.isInteger(serviceCall?.sequence) || !Number.isInteger(abortEvent?.sequence)
      || abortEvent.sequence <= serviceCall.sequence) {
    issues.push('controller abort was not observed after the matching service cancellation began');
  }
  if (controller?.messageId !== messageId || controller?.sessionId !== sessionId || controller?.aborted !== true) {
    issues.push('matched lifecycle controller is not observed aborted');
  }
  return { ok: issues.length === 0, issues };
}

export function validateActiveReplacementCheckpoint({
  sessionId, activeManagerSessionId, capturedSessionActive, currentBridgeOwnsSession,
  schedulerSessionContextOwned, trustedStart, providerRoot, controller,
}) {
  const issues = [];
  if (!sessionId || activeManagerSessionId !== sessionId || capturedSessionActive !== true
      || currentBridgeOwnsSession !== true || schedulerSessionContextOwned !== true) {
    issues.push('replacement bridge/scheduler does not currently own the active session');
  }
  if (trustedStart?.sessionId !== sessionId || trustedStart?.action !== 'page-translate-start'
      || trustedStart?.accepted !== true) issues.push('trusted coordinator did not accept this session START');
  if (providerRoot?.sessionId !== sessionId || providerRoot?.status !== 'pending') issues.push('current session provider root is not pending');
  if (controller?.sessionId !== sessionId || controller?.messageId !== providerRoot?.messageId || controller?.aborted !== false) {
    issues.push('current session provider controller is missing, mismatched, or already aborted');
  }
  return { ok: issues.length === 0, issues };
}

export function validatePostInvalidationEvidence({ sessionId, invalidationSequence, operations, duplicateAcceptedIds = [], allowedMutationOwners = [] }) {
  const issues = [];
  if (typeof sessionId !== 'string' || !sessionId) issues.push('invalidated session ID unavailable');
  if (!Number.isInteger(invalidationSequence)) issues.push('actual session invalidation sequence unavailable');
  if (!Array.isArray(operations)) issues.push('origin-scoped operation ledger unavailable');
  const events = Array.isArray(operations) ? operations : [];
  const lateAcceptedSettlements = events.filter(operation => operation.kind === 'scheduler.settlement'
    && operation.sessionId === sessionId && operation.outcome === 'accepted'
    && operation.changed === true && operation.sequence > invalidationSequence);
  const lateOwnedMutations = events.filter(operation => operation.kind === 'dom.acceptedMutation'
    && operation.sequence > invalidationSequence);
  const allowedOwners = new Set(allowedMutationOwners);
  const invalidMutations = lateOwnedMutations.filter(operation => !operation.originTransitionCaptured
    || operation.sessionId === sessionId
    || !allowedOwners.has(operation.sessionId));
  if (lateAcceptedSettlements.length) issues.push(`invalidated session has accepted settlements after invalidation: ${lateAcceptedSettlements.map(operation => operation.id).join(',')}`);
  if (invalidMutations.length) issues.push(`post-invalidation DOM mutations lack allowed session ownership: ${invalidMutations.map(operation => `${operation.sessionId ?? 'unknown'}:${operation.id}`).join(',')}`);
  if (duplicateAcceptedIds.length) issues.push(`duplicate accepted DOM mutations observed: ${duplicateAcceptedIds.join(',')}`);
  return {
    ok: issues.length === 0,
    issues,
    lateAcceptedSettlements,
    lateOwnedMutations,
    invalidMutations,
    lateNodeContinuations: events.filter(operation => operation.kind === 'node.continuation'
      && operation.sessionId === sessionId && operation.settledSequence > invalidationSequence),
  };
}

export function classifyHeldFetchRelease({
  heldRequestId, matchedRequestId, releaseOutcome, networkCanceled,
  controllerAborted, cancelTargetMatched, providerRootStatus, physicalStatus,
  physicalControllerAborted, controllerAbortSequence, providerRootSettledSequence,
  physicalSettledSequence,
}) {
  if (releaseOutcome?.ok === true) return { ok: true, classification: 'fetch-release-command-acknowledged', issues: [] };
  const issues = [];
  if (releaseOutcome?.error !== 'Invalid InterceptionId.') {
    issues.push(`unrecognized CDP release error: ${releaseOutcome?.error ?? 'missing raw error'}`);
  }
  if (!heldRequestId || matchedRequestId !== heldRequestId) issues.push('CDP release error is not correlated to the held Fetch request ID');
  if (controllerAborted !== true || cancelTargetMatched !== true) issues.push('production cancellation did not abort the matched request controller');
  if (providerRootStatus !== 'rejected' || physicalStatus !== 'rejected') issues.push('provider root and physical request did not both reject after cancellation');
  if (physicalControllerAborted !== true) issues.push('physical provider request did not observe the aborted controller');
  if (!Number.isInteger(controllerAbortSequence)
      || !Number.isInteger(providerRootSettledSequence) || providerRootSettledSequence <= controllerAbortSequence
      || !Number.isInteger(physicalSettledSequence) || physicalSettledSequence <= controllerAbortSequence) {
    issues.push('provider promises did not settle after the observed controller abort');
  }
  if (issues.length) return { ok: false, classification: 'unclassified-cdp-release-error', issues };
  return {
    ok: true,
    classification: networkCanceled
      ? 'network-loadingFailed-canceled-with-provider-settlement'
      : 'invalid-fetch-id-after-matched-abort-and-provider-root-plus-physical-rejection',
    issues: [],
  };
}

export function validateReplacementOwnership({ acceptedAIds, acceptedBIds, finalTranslatedIds, expectedIds }) {
  const issues = [];
  const aValues = Array.isArray(acceptedAIds) ? acceptedAIds : [];
  const bValues = Array.isArray(acceptedBIds) ? acceptedBIds : [];
  const a = new Set(aValues);
  const b = new Set(bValues);
  const final = new Set(finalTranslatedIds ?? []);
  const expected = new Set(expectedIds ?? []);
  if (!a.size || !b.size || !expected.size) issues.push('replacement ownership evidence is empty');
  if (aValues.length !== a.size) issues.push('duplicate successful A acceptance events');
  if (bValues.length !== b.size) issues.push('duplicate successful B acceptance events');
  if (aValues.length !== 25 || bValues.length !== 975) issues.push('successful acceptance event counts must be A=25 and B=975');
  for (const id of a) if (b.has(id)) issues.push(`replacement wrote an A-retained target: ${id}`);
  for (const id of expected) if (!a.has(id) && !b.has(id)) issues.push(`replacement omitted target ownership: ${id}`);
  for (const id of expected) if (!final.has(id)) issues.push(`replacement final DOM misses target: ${id}`);
  for (const id of final) if (!expected.has(id)) issues.push(`replacement final DOM has unexpected target: ${id}`);
  if (a.size !== 25 || b.size !== 975 || final.size !== 1000) issues.push('replacement target counts must be A=25, B=975, final=1000');
  return { ok: issues.length === 0, issues };
}

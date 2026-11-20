import { selectResolvedCustomCancellationBatch, validateCustomCancellationEvidence } from '../resilience-probes.mjs';
import { classifyHeldFetchRelease as classifyReleaseEvidence, validatePostInvalidationEvidence } from '../cancellation-probes.mjs';

const readPageDOM = (chrome, pageSession, contentContext, evaluate) => evaluate(chrome, pageSession,
  `(()=>({dom:Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent]),metadata:Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))}))()`,
  contentContext, false);

function validateRetainedDOM(snapshot, fixtureConfig, initialIds, baselineMetadata) {
  const retained = new Set(initialIds);
  const sources = new Map(fixtureConfig.targets.map(target => [target.id, target.source]));
  const baseline = new Map((baselineMetadata ?? []).map(item => [item.id, item]));
  const issues = [];
  if (snapshot?.dom?.length !== fixtureConfig.targetCount || snapshot?.metadata?.length !== fixtureConfig.targetCount) {
    issues.push('DOM target inventory changed before Restore');
  }
  for (const [id, text] of snapshot?.dom ?? []) {
    const source = sources.get(id);
    if (source === undefined || text !== (retained.has(id) ? `\u200efixture translation: ${source}` : source)) {
      issues.push(`target ${id} did not retain its expected pre-Restore text`);
    }
  }
  for (const actual of snapshot?.metadata ?? []) {
    if (!baseline.has(actual.id) || !retained.has(actual.id)
        && JSON.stringify(actual) !== JSON.stringify(baseline.get(actual.id))) {
      issues.push(`noninitial target ${actual.id} metadata changed before Restore`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export async function captureCustomCancellationPreRestore({ protocol, fixtureConfig, chrome, pageSession, contentContext, evaluate }) {
  protocol.evidence.preRestoreDOM = await readPageDOM(chrome, pageSession, contentContext, evaluate);
  protocol.evidence.preRestoreValidation = validateRetainedDOM(
    protocol.evidence.preRestoreDOM, fixtureConfig, protocol.initialIds, protocol.initialDOMMetadata,
  );
  if (!protocol.evidence.preRestoreValidation.ok) throw new Error(protocol.evidence.preRestoreValidation.issues.join('; '));
}

export function createCustomCancellationProtocol() {
  return { armed: false, claimed: false, held: null, attempts: [], selectionFailures: [], unexpectedConcurrentRequests: [],
    admissions: [], admissionTail: Promise.resolve(), evidence: { attempts: [], admissions: [] } };
}

export function armCustomCancellation({ protocol, sessionId, resolver, initialIds, fixtureConfig, now }) {
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) throw new Error('Custom cancellation requires concrete AUTO resolution.');
  protocol.armed = true;
  protocol.initialTargetIds = new Set(initialIds);
  protocol.armedWallMs = now();
  protocol.sessionId = sessionId;
  protocol.fixtureTargetBySource = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
  protocol.evidence.arm = { sessionId, resolver, initialTargetIds: [...initialIds], armedWallMs: protocol.armedWallMs };
}

export function admitCustomCancellationRequest({ protocol, event, requestRecord, requestId, reservation, body, now }) {
  if (!protocol?.armed || !reservation || !reservation.hold()) return null;
  let releaseTurn;
  let turnReleased = false;
  const previousTurn = protocol.admissionTail;
  protocol.admissionTail = new Promise(resolve => { releaseTurn = resolve; });
  const admission = {
    requestId, networkId: event.params.networkId ?? null, networkSessionId: event.sessionId,
    order: protocol.admissions.length + 1, admittedAt: now(), decision: 'pending',
    targetIds: body.map(text => protocol.fixtureTargetBySource?.get(text) ?? null),
    previousTurn,
    releaseTurn() {
      if (turnReleased) return;
      turnReleased = true;
      releaseTurn();
    },
  };
  protocol.admissions.push(admission);
  requestRecord.customCancellationAdmission = admission;
  return admission;
}

export async function awaitCustomCancellationNetwork(admission, providerNetworkEvents, until) {
  const key = `${admission.networkSessionId}:${admission.networkId}`;
  const existing = admission.networkId && providerNetworkEvents.get(key);
  if (Number.isFinite(existing?.wallTime)) return existing;
  const network = await until(() => {
    const observed = admission.networkId && providerNetworkEvents.get(key);
    return Number.isFinite(observed?.wallTime) ? observed : null;
  }, 10_000);
  if (!Number.isFinite(network?.wallTime)) {
    admission.decision = 'correlation-timeout';
    throw new Error(`Custom cancellation admission ${admission.requestId} lacks bounded Network correlation.`);
  }
  return network;
}

export function classifyCustomCancellationTiming(timestamp, invalidation) {
  const startedAt = invalidation?.invalidationCallStartedAt;
  const completedAt = invalidation?.invalidationCallCompletedAt;
  if (!Number.isFinite(timestamp) || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)
      || completedAt < startedAt) return null;
  return timestamp < startedAt ? 'before' : timestamp > completedAt ? 'after' : 'indeterminate';
}

function recordAdmissionInvalidationTiming(protocol, admission) {
  const invalidation = protocol.evidence.cancellation?.invalidation;
  admission.invalidationTime = Number.isFinite(invalidation?.wallTime) ? invalidation.wallTime
    : Number.isFinite(invalidation?.at) ? invalidation.at : null;
  admission.invalidationBoundary = {
    invalidationCallStartedAt: invalidation?.invalidationCallStartedAt,
    invalidationCallCompletedAt: invalidation?.invalidationCallCompletedAt,
  };
  admission.relativeToInvalidation = classifyCustomCancellationTiming(admission.admittedAt, invalidation);
  admission.networkRelativeToInvalidation = classifyCustomCancellationTiming(admission.startedWallMs, invalidation);
}

export async function waitCustomCancellationAdmissionTurn(protocol, admission) {
  await admission.previousTurn;
  if (protocol.error) {
    admission.decision = 'failed-closed';
    throw new Error(protocol.error.message ?? 'Earlier Custom cancellation admission failed.');
  }
}

export async function executeCustomCancellation({ protocol, requestId, requestRecord, body, fixtureConfig,
  sessionId, providerNetworkEvents, chrome, workerSession, pageSession, contentContext, evaluate, until, now,
  reservation, sameProviderTexts }) {
  if (!protocol?.armed) return false;
  const admission = requestRecord.customCancellationAdmission;
  if (!admission) return false;
  try {
    await waitCustomCancellationAdmissionTurn(protocol, admission);
    const { networkId, networkSessionId } = admission;
    const network = await awaitCustomCancellationNetwork(admission, providerNetworkEvents, until);
    if (!networkId || !Number.isFinite(network?.wallTime)) {
      admission.decision = 'correlation-timeout';
      throw new Error(`Custom cancellation admission ${requestId} lacks bounded Network correlation.`);
    }
    if (network.wallTime < protocol.armedWallMs) {
      admission.decision = 'ineligible-before-arm';
      return false;
    }
    admission.decision = protocol.held || protocol.claimed ? 'held-sibling' : 'initiator';
    admission.correlatedAt = now();
    admission.startedWallMs = network.wallTime;
    if (protocol.held || protocol.claimed) {
      const targetIds = admission.targetIds;
      const sibling = { requestId, networkId, networkSessionId, targetIds, startedWallMs: network.wallTime,
        admissionOrder: admission.order };
      protocol.unexpectedConcurrentRequests.push(sibling);
      if (!reservation) throw new Error('Concurrent Custom Fetch lacks request-lifecycle reservation.');
      await protocol.cancellationEstablished;
      if (protocol.productionCancellationEstablished !== true) {
        admission.decision = 'failed-closed';
        throw new Error('Concurrent Custom Fetch was not released without positive production cancellation evidence.');
      }
      recordAdmissionInvalidationTiming(protocol, admission);
    const siblingRelease = await reservation.release('fail', {
      errorReason: 'Aborted', reason: 'custom-cancellation-single-fetch-claim',
    });
    if (siblingRelease?.ok !== true && siblingRelease?.error !== 'Invalid InterceptionId.') {
      protocol.error ??= { name: 'FetchReleaseError', message: siblingRelease?.error ?? 'Concurrent Fetch release was unacknowledged.' };
      throw new Error(protocol.error.message);
    }
    sibling.releaseOutcome = siblingRelease;
    sibling.cancelledByProductionStop = siblingRelease?.error === 'Invalid InterceptionId.';
    if (sibling.cancelledByProductionStop) {
      await until(async () => {
        const state = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false);
        const roots = (state?.providerRoots ?? []).filter(item => item.sessionId === sessionId
          && sameProviderTexts(item.texts, body));
        const root = roots.length === 1 ? roots[0] : null;
        const physical = (state?.ledger?.operations ?? []).filter(item => item.kind === 'provider.physical'
          && item.sessionId === sessionId && item.messageId === root?.messageId
          && item.url === requestRecord.url && item.method === requestRecord.method
          && item.requestBody === requestRecord.postData);
        const controller = (state?.controllers ?? []).find(item => item.sessionId === sessionId
          && item.messageId === root?.messageId);
        const rootOperation = (state?.ledger?.operations ?? []).find(item => item.kind === 'provider.root'
          && item.sessionId === sessionId && item.messageId === root?.messageId);
        const networkEnd = providerNetworkEvents.get(`${networkSessionId}:${networkId}`);
        const physicalAbortMatched = physical.length === 1 && physical[0].abortReasonMatched === true
          && ((physical[0].errorType == null && physical[0].error == null && physical[0].errorName == null)
            || (physical[0].errorType === 'USER_CANCELLED'
              && (physical[0].error == null || /abort|cancel/i.test(physical[0].error))));
        return networkEnd?.outcome === 'failed' && root?.status === 'rejected'
          && /abort|cancel/i.test(networkEnd.error ?? '')
          && rootOperation?.errorType === 'USER_CANCELLED' && roots.length === 1
          && physical.length === 1 && physical[0].status === 'rejected'
          && physical[0].controllerAbortedAtEnd === true && physicalAbortMatched
          && controller?.aborted === true
          ? true : null;
      }, 10_000);
      sibling.releaseClassification = { ok: true, classification: 'network-cancellation-after-production-stop', issues: [] };
      reservation.classifyRelease(sibling.releaseClassification);
    }
    admission.decision = 'cancelled-sibling';
    return true;
  }
  protocol.claimed = true;
  let completeClaim;
  protocol.claimCompletion = new Promise(resolve => { completeClaim = resolve; });
  protocol.cancellationEstablished = new Promise(resolve => { protocol.resolveCancellation = resolve; });
  try {
  const networkId = admission.networkId;
  const networkSessionId = admission.networkSessionId;
  const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const [resources, snapshot] = await Promise.all([
    evaluate(chrome, workerSession,
      `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false),
    evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false),
  ]);
  const resolver = resources?.sourceResolvers?.[sessionId];
  const roots = (snapshot?.providerRoots ?? []).filter(root => root.sessionId === sessionId && sameProviderTexts(root.texts, body));
  const selection = selectResolvedCustomCancellationBatch({
    request: { networkId, sessionId, physicalStartedWallMs: network.wallTime, texts: body, targetIds },
    classification: { kind: 'provider-translation', provider: 'custom' }, resolver, roots,
    expectedTargetIds: fixtureConfig.targets.map(target => target.id),
    initialTargetIds: [...protocol.initialTargetIds], armedWallMs: protocol.armedWallMs,
  });
  if (!selection.selected) {
    protocol.selectionFailures.push({ networkId, reason: selection.reason, targetIds });
    throw new Error(`Custom cancellation failed closed on eligible post-arm request: ${selection.reason}`);
  }
  const root = roots.length === 1 ? roots[0] : null;
  const controllers = (snapshot?.controllers ?? []).filter(item => item.sessionId === sessionId && item.messageId === root?.messageId);
  const ledger = snapshot?.ledger?.operations ?? [];
  const physicalMatches = ledger.filter(item => item.kind === 'provider.physical' && item.sessionId === sessionId
    && item.messageId === root?.messageId && item.url === requestRecord.url
    && item.method === requestRecord.method && item.requestBody === requestRecord.postData);
  const controller = controllers.length === 1 ? controllers[0] : null;
  const physical = physicalMatches.length === 1 ? physicalMatches[0] : null;
  if (!root || root.status !== 'pending' || !controller || controller.aborted !== false
      || !physical) {
    throw new Error('Custom cancellation failed closed: exact pending root, physical request, controller, and Fetch reservation required.');
  }
  const attempt = { attemptId: requestRecord.physicalAttemptId ?? `custom-cancel-${protocol.attempts.length + 1}`,
    networkId, networkSessionId, pageSessionId: sessionId, logicalMessageId: root.messageId,
    targetIds, texts: [...body], startedWallMs: network.wallTime, selected: true };
  protocol.attempts.push(attempt);
  protocol.evidence.attempts.push(attempt);
  requestRecord.cancellationCorrelation = { pageSessionId: sessionId, batchMessageId: root.messageId, targetIds,
    requestId, networkId, targetSessionId: networkSessionId, providerRootStatus: root.status,
    physicalOperationStatus: physical.status, controllerAborted: controller.aborted };
  protocol.held = { requestId, networkId, networkSessionId, attemptId: requestRecord.physicalAttemptId ?? null,
    messageId: root.messageId, pageSessionId: sessionId,
    targetIds, texts: [...body], method: requestRecord.method, url: requestRecord.url, requestBody: requestRecord.postData,
    physicalStartedWallMs: network.wallTime, physicalStartedMonoMs: network.startedAt };
  requestRecord.customCancellationHeld = { requestId, messageId: root.messageId, pageSessionId: sessionId, targetIds };
  requestRecord.paused = true;
  const checkpoint = await until(async () => {
    const state = await evaluate(chrome, workerSession,
      `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false);
    const liveRoot = state?.providerRoots?.find(item => item.messageId === root.messageId && item.sessionId === sessionId);
    const liveController = state?.controllers?.find(item => item.messageId === root.messageId && item.sessionId === sessionId);
    return liveRoot?.status === 'pending' && liveController?.aborted === false
      ? { snapshot: state, root: liveRoot, controller: liveController } : null;
  }, 10_000);
  protocol.evidence.pendingCheckpoint = { positive: true, requestId, providerRootStatus: checkpoint.root.status,
    controllerAborted: checkpoint.controller.aborted };
  const beforeStop = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
  if (!Array.isArray(beforeStop?.acceptedIds)) throw new Error('Custom cancellation lacks a valid pre-Stop accepted-ID snapshot.');
  const retainedBefore = beforeStop.acceptedIds;
  if (retainedBefore.length !== protocol.initialTargetIds.size
      || [...protocol.initialTargetIds].some(id => !retainedBefore.includes(id))) {
    throw new Error('Custom cancellation requires one complete initial accepted band before Stop.');
  }
  protocol.evidence.retainedAcceptedIds = retainedBefore;
  protocol.evidence.beforeStopDOM = await readPageDOM(chrome, pageSession, contentContext, evaluate);
  protocol.evidence.beforeStopValidation = validateRetainedDOM(
    protocol.evidence.beforeStopDOM, fixtureConfig, [...protocol.initialTargetIds], protocol.initialDOMMetadata,
  );
  if (!protocol.evidence.beforeStopValidation.ok) throw new Error(protocol.evidence.beforeStopValidation.issues.join('; '));
  const stopSentAt = now();
  const stop = await evaluate(chrome, pageSession,
    `chrome.runtime.sendMessage(${JSON.stringify({ action: 'page-translate-stop-auto' })})`, contentContext);
  protocol.evidence.cancellation = { stop: { action: 'page-translate-stop-auto', status: 'fulfilled', sentAt: stopSentAt, respondedAt: now(), response: stop } };
  if (stop?.success !== true) throw new Error('Production page-translate-stop-auto did not acknowledge Custom cancellation.');
  const cancelled = await until(async () => {
    const [worker, content] = await Promise.all([
      evaluate(chrome, workerSession,
        `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false),
      evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, contentContext, false),
    ]);
    const operations = worker?.ledger?.operations ?? [];
    const serviceCall = operations.find(item => item.kind === 'service.cancelRequest'
      && item.sessionId === sessionId && item.messageId === root.messageId);
    const abortEvent = operations.find(item => item.kind === 'controller.abort' && item.sessionId === sessionId && item.messageId === root.messageId);
    const invalidation = content?.operations?.find(item => item.kind === 'session.invalidation' && item.sessionId === sessionId);
    const cancelMessage = (content?.operations ?? []).find(item => item.kind === 'runtime.cancel.send'
      && item.action === 'CANCEL_TRANSLATION' && item.targetSessionId === sessionId
      && item.status === 'fulfilled' && item.response?.success === true);
    const liveController = worker?.controllers?.find(item => item.sessionId === sessionId && item.messageId === root.messageId);
    return serviceCall && abortEvent && invalidation && cancelMessage && liveController?.aborted === true
      ? { worker, content, serviceCall, abortEvent, invalidation, cancelMessage, controller: liveController } : null;
  }, 15_000);
  protocol.evidence.cancellation.invalidation = cancelled.invalidation;
  protocol.productionCancellationEstablished = true;
  protocol.cancellationEstablishedTime = now();
  for (const item of protocol.admissions) recordAdmissionInvalidationTiming(protocol, item);
  admission.decision = 'production-cancellation-established';
  protocol.resolveCancellation?.();
  protocol.evidence.cancellation.cancelMessage = cancelled.cancelMessage;
  protocol.evidence.cancellation.serviceCall = cancelled.serviceCall;
  protocol.evidence.cancellation.abortEvent = cancelled.abortEvent;
  protocol.evidence.cancellation.controller = cancelled.controller;
  const afterStop = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.measurementSnapshot()', contentContext, false);
  if (!Array.isArray(afterStop?.acceptedIds)) throw new Error('Custom cancellation lacks a valid post-Stop accepted-ID snapshot.');
  protocol.evidence.cancellation.acceptedIdsAfterStop = afterStop.acceptedIds;
  if (JSON.stringify(protocol.evidence.cancellation.acceptedIdsAfterStop) !== JSON.stringify(retainedBefore)) {
    throw new Error('Custom cancelled session accepted additional targets or changed retained translations after Stop.');
  }
  protocol.evidence.afterStopDOM = await readPageDOM(chrome, pageSession, contentContext, evaluate);
  if (JSON.stringify(protocol.evidence.afterStopDOM) !== JSON.stringify(protocol.evidence.beforeStopDOM)) {
    throw new Error('Cancelled-session DOM or metadata changed after Stop and before Restore.');
  }
  protocol.evidence.cancellation.duplicateAcceptedWriteIds =
    cancelled.content?.mutationSnapshot?.duplicateAcceptedIds ?? [];
  const release = await reservation.release('fail', { errorReason: 'Aborted', reason: 'production-custom-user-cancellation' });
  protocol.held.fetchRelease = release;
  const settled = await until(async () => {
    const state = await evaluate(chrome, workerSession,
      `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false);
    const operations = state?.ledger?.operations ?? [];
    const providerRoot = operations.find(item => item.kind === 'provider.root' && item.messageId === root.messageId && item.sessionId === sessionId);
    const physicalMatches = operations.filter(item => item.kind === 'provider.physical' && item.messageId === root.messageId
      && item.sessionId === sessionId && item.url === requestRecord.url && item.method === requestRecord.method
      && item.requestBody === requestRecord.postData);
    const physical = physicalMatches.length === 1 ? physicalMatches[0] : null;
    return providerRoot?.status === 'rejected' && physical?.status === 'rejected'
      ? { providerRoot, physical, physicalMatchCount: physicalMatches.length } : null;
  }, 15_000);
  protocol.evidence.cancellation.providerRoot = settled.providerRoot;
  protocol.evidence.cancellation.physical = settled.physical;
  protocol.evidence.cancellation.physicalMatchCount = settled.physicalMatchCount;
  const netEnd = await until(() => {
    const observed = providerNetworkEvents.get(`${networkSessionId}:${networkId}`);
    return observed?.outcome ? observed : null;
  }, 10_000);
  protocol.evidence.releaseClassification = classifyReleaseEvidence({
    heldRequestId: requestId, matchedRequestId: requestId, releaseOutcome: release,
    networkCanceled: netEnd.outcome === 'failed' && /abort|cancel/i.test(netEnd.error ?? ''),
    controllerAborted: cancelled.controller.aborted === true, cancelTargetMatched: cancelled.serviceCall.messageId === root.messageId,
    providerRootStatus: settled.providerRoot.status, physicalStatus: settled.physical.status,
    physicalControllerAborted: settled.physical.controllerAbortedAtEnd,
    controllerAbortSequence: cancelled.abortEvent.sequence,
    providerRootSettledSequence: settled.providerRoot.settledSequence,
    physicalSettledSequence: settled.physical.settledSequence,
  });
  reservation.classifyRelease(protocol.evidence.releaseClassification);
  if (!protocol.evidence.releaseClassification.ok) throw new Error(protocol.evidence.releaseClassification.issues.join('; '));
  protocol.evidence.cancellation.network = netEnd;
  protocol.claimed = false;
  completeClaim();
  admission.decision = 'initiator-complete';
  return true;
  } catch (error) {
    protocol.error ??= { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
    protocol.claimed = false;
    completeClaim?.();
    protocol.resolveCancellation?.();
    throw error;
  }
  } catch (error) {
    protocol.error ??= { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
    if (admission.decision === 'pending') admission.decision = 'failed-closed';
    protocol.resolveCancellation?.();
    throw error;
  } finally {
    admission.releaseTurn();
  }
}

export function validateCustomCancellationProbeEvidence(evidence) {
  return validateCustomCancellationEvidence(evidence);
}

export function collectCustomCancellationEvidence({
  protocol, evidence, resources, pageScheduler, contentDrain, workerDrain, metadata,
  originals, restoredDOM, acceptedIds, acceptedDomOrder, translated, duplicateAcceptedWriteIds,
  workerTrace, traceEvents, providerAttempts, providerNetworkEvents, providerPhysicalAccounting,
  providerLogicalBatches, providerRuntimeObserved, pageWorkerLimit, validateRuntimeResources,
}) {
  const held = protocol.held;
  if (!held) {
    evidence.admissions = (protocol.admissions ?? []).map(item =>
      Object.fromEntries(Object.entries(item).filter(([key]) => !['previousTurn', 'releaseTurn'].includes(key))));
    evidence.attempts = [];
    evidence.heldRequest = null;
    evidence.arm = protocol.evidence.arm ?? null;
    evidence.cancellation = protocol.evidence.cancellation ?? null;
    evidence.handlerError = protocol.evidence.handlerError ?? protocol.error ?? null;
    evidence.selectionFailures = protocol.selectionFailures ?? [];
    evidence.unexpectedConcurrentRequests = protocol.unexpectedConcurrentRequests ?? [];
    evidence.cleanup = { ok: false, contentDrain, workerDrain, pageScheduler,
      resourceValidation: { ok: false, issues: ['held request/terminal evidence unavailable'] } };
    evidence.validation = validateCustomCancellationEvidence(evidence);
    return evidence;
  }
  const operations = contentDrain?.operations ?? [];
  const invalidation = operations.find(item => item.kind === 'session.invalidation' && item.sessionId === held.pageSessionId);
  const postInvalidation = validatePostInvalidationEvidence({
    sessionId: held.pageSessionId, invalidationSequence: invalidation?.sequence, operations,
    duplicateAcceptedIds: duplicateAcceptedWriteIds ?? [],
  });
  const workerOperations = workerDrain?.ledger?.operations ?? [];
  const roots = workerDrain?.providerRoots?.filter(root => root.sessionId === held.pageSessionId) ?? [];
  const attempts = providerAttempts.map(request => {
    const networkSessionId = request.targetSessionId ?? null;
    const networkId = request.networkId ?? null;
    const network = providerNetworkEvents.get(`${networkSessionId}:${networkId}`);
    const rootsForBody = roots.filter(root => JSON.stringify(root.texts) === JSON.stringify(request.batchTexts ?? []));
    const root = rootsForBody.length === 1 ? rootsForBody[0] : null;
    const rootOperation = workerOperations.find(item => item.kind === 'provider.root'
      && item.sessionId === root?.sessionId && item.messageId === root?.messageId);
    const physicalMatches = workerOperations.filter(item => item.kind === 'provider.physical'
      && item.sessionId === root?.sessionId && item.messageId === root?.messageId
      && item.url === request.url && item.method === request.method && item.requestBody === request.postData);
    const controllers = workerDrain?.controllers?.filter(item => item.sessionId === root?.sessionId
      && item.messageId === root?.messageId) ?? [];
    const isSibling = protocol.unexpectedConcurrentRequests?.some(sibling =>
      sibling.networkId === networkId && sibling.networkSessionId === networkSessionId) === true;
    const targetIds = (request.batchTexts ?? []).map(text => protocol.fixtureTargetBySource?.get(text) ?? null);
    return {
      attemptId: request.physicalAttemptId ?? null, networkId, networkSessionId,
      pageSessionId: root?.sessionId ?? null, logicalMessageId: root?.messageId ?? null,
      targetIds, texts: [...(request.batchTexts ?? [])],
      startedWallMs: network?.wallTime ?? null, status: network?.status ?? null,
      outcome: network?.outcome ?? null, networkError: network?.error ?? null,
      selected: request.networkId === held.networkId && request.targetSessionId === held.networkSessionId,
      correlation: {
        rootMatchCount: rootsForBody.length, physicalMatchCount: physicalMatches.length,
        controllerMatchCount: controllers.length, providerRootStatus: root?.status ?? null,
        providerRootErrorType: rootOperation?.errorType ?? null,
        physicalStatus: physicalMatches.length === 1 ? physicalMatches[0].status : null,
        physicalErrorType: physicalMatches.length === 1 ? physicalMatches[0].errorType : null,
        physicalError: physicalMatches.length === 1 ? physicalMatches[0].error : null,
        physicalErrorName: physicalMatches.length === 1 ? physicalMatches[0].errorName : null,
        physicalAbortReasonMatched: physicalMatches.length === 1 ? physicalMatches[0].abortReasonMatched : null,
        physicalOperationAborted: physicalMatches.length === 1 ? physicalMatches[0].operationAborted : null,
        physicalControllerAbortedAtEnd: physicalMatches.length === 1 ? physicalMatches[0].controllerAbortedAtEnd : null,
        controllerAborted: controllers.length === 1 ? controllers[0].aborted : null,
      },
      sibling: isSibling,
    };
  });
  const stopAt = protocol.evidence.cancellation?.stop?.sentAt;
  const postStopAttempts = attempts.filter(attempt => Number.isFinite(attempt.startedWallMs)
    && Number.isFinite(stopAt) && attempt.startedWallMs > stopAt);
  const retries = traceEvents(workerTrace).filter(item => roots.some(root => root.messageId === item.messageId)
    && item.name === 'queueManager.processItem.start' && item.attemptNumber > 1);
  const heldQueueEvents = traceEvents(workerTrace).filter(item => item.messageId === held.messageId
    && ['queueManager.processItem.start', 'queueManager.processItem.end'].includes(item.name));
  const queueStart = heldQueueEvents.find(item => item.name.endsWith('.start'));
  const queueEnd = heldQueueEvents.find(item => item.name.endsWith('.end'));
  const queueStarts = heldQueueEvents.filter(item => item.name.endsWith('.start'));
  const queueEnds = heldQueueEvents.filter(item => item.name.endsWith('.end'));
  const heldRootOperation = workerOperations.find(item => item.kind === 'provider.root'
    && item.sessionId === held.pageSessionId && item.messageId === held.messageId);
  const queueAttemptEvidence = {
    ok: queueStarts.length === 1 && queueEnds.length === 1
      && !!queueStart?.queueItemId && queueStart.queueItemId === queueEnd?.queueItemId
      && queueStart.attemptNumber === 1 && queueEnd.attempts === 1
      && queueEnd.status === 'failed' && heldRootOperation?.errorType === 'USER_CANCELLED'
      && queueEnd.retryTimerActive === false,
    rootErrorType: heldRootOperation?.errorType ?? null,
    queueStartCount: queueStarts.length, queueEndCount: queueEnds.length, queueEnd,
    issues: [],
  };
  if (!queueAttemptEvidence.ok) queueAttemptEvidence.issues.push('QueueManager did not settle the held Custom batch once without retry alongside its USER_CANCELLED provider root.');
  const allPhysical = attempts.filter(attempt => attempt.pageSessionId === held.pageSessionId);
  const postStopRequests = providerAttempts.filter(request => {
    const network = providerNetworkEvents.get(`${request.targetSessionId}:${request.networkId}`);
    return Number.isFinite(network?.wallTime) && Number.isFinite(stopAt) && network.wallTime > stopAt;
  });
  const unexpectedPhysicalAttempts = [
    ...postStopAttempts,
    ...postStopRequests.map(request => ({ networkId: request.networkId ?? null,
      networkSessionId: request.targetSessionId ?? null, reason: 'physical Custom Fetch started after production Stop' })),
  ];
  const retainedIds = protocol.evidence.retainedAcceptedIds ?? protocol.initialIds ?? [];
  const translatedInitial = (translated ?? []).filter(([id]) => retainedIds.includes(id));
  const expectedInitial = originals.filter(([id]) => retainedIds.includes(id))
    .map(([id, source]) => [id, `\u200efixture translation: ${source}`]);
  const retainedExact = JSON.stringify(translatedInitial) === JSON.stringify(expectedInitial);
  const expectedIds = originals.map(([id]) => id);
  const duplicateIds = protocol.evidence.cancellation?.duplicateAcceptedWriteIds ?? duplicateAcceptedWriteIds ?? [];
  const rootIds = new Set(roots.map(root => root.messageId));
  const rootRetriesOrFailovers = providerAttempts.filter(request => {
    const attempt = attempts.find(item => item.attemptId === request.physicalAttemptId);
    return attempt?.logicalMessageId === held.messageId
      && !(request.networkId === held.networkId && request.targetSessionId === held.networkSessionId);
  });
  const unnecessaryRetransmits = providerAttempts.filter(request =>
    !(request.networkId === held.networkId && request.targetSessionId === held.networkSessionId)
    && JSON.stringify(request.batchTexts ?? []) === JSON.stringify(held.texts));
  evidence.attempts = attempts;
  evidence.admissions = (protocol.admissions ?? []).map(item =>
    Object.fromEntries(Object.entries(item).filter(([key]) => !['previousTurn', 'releaseTurn'].includes(key))));
  evidence.arm = protocol.evidence.arm;
  evidence.heldRequest = { requestId: held.requestId, networkId: held.networkId,
    networkSessionId: held.networkSessionId, attemptId: held.attemptId, pageSessionId: held.pageSessionId,
    messageId: held.messageId, targetIds: held.targetIds, texts: held.texts,
    method: held.method, url: held.url, requestBody: held.requestBody };
  evidence.pendingCheckpoint = protocol.evidence.pendingCheckpoint;
  evidence.cancellation = protocol.evidence.cancellation ?? {};
  evidence.retainedAcceptedIds = protocol.evidence.retainedAcceptedIds;
  evidence.releaseClassification = protocol.evidence.releaseClassification ?? null;
  evidence.handlerError = protocol.evidence.handlerError ?? protocol.error ?? null;
  evidence.postInvalidation = {
    ...postInvalidation,
  };
  evidence.duplicateAcceptedWriteIds = duplicateIds;
  evidence.queueAttemptEvidence = queueAttemptEvidence;
  evidence.retries = retries;
  evidence.failovers = rootRetriesOrFailovers;
  evidence.unnecessaryRetransmits = unnecessaryRetransmits;
  evidence.recovery = unnecessaryRetransmits;
  evidence.unexpectedPhysicalAttempts = unexpectedPhysicalAttempts;
  evidence.allSessionRoots = roots;
  evidence.allSessionPhysicalAttempts = allPhysical;
  evidence.allSessionControllers = (workerDrain?.controllers ?? [])
    .filter(controller => controller.sessionId === held.pageSessionId);
  evidence.snapshots = {
    beforeStop: protocol.evidence.beforeStopDOM ?? null,
    afterStop: protocol.evidence.afterStopDOM ?? null,
    preRestore: protocol.evidence.preRestoreDOM ?? null,
    restored: { dom: restoredDOM ?? null, metadata: metadata ?? null },
  };
  evidence.metadataBaseline = protocol.initialDOMMetadata;
  evidence.targetMapping = [...(protocol.fixtureTargetBySource ?? new Map()).entries()]
    .map(([source, id]) => ({ source, id }));
  evidence.resources = resources;
  evidence.translation = {
    exact: retainedExact && protocol.evidence.preRestoreValidation?.ok === true,
    targetCount: originals.length, acceptedTargetCount: acceptedIds?.length ?? null,
    acceptedTargetIds: acceptedIds ?? [], acceptedWriteCount: acceptedDomOrder?.length ?? null,
    duplicates: duplicateIds.length,
    acceptedSessionActivity: postInvalidation.lateAcceptedSettlements.length,
    restoreExact: JSON.stringify(restoredDOM) === JSON.stringify(originals),
    metadataExact: JSON.stringify(metadata) === JSON.stringify(protocol.initialDOMMetadata)
      && protocol.evidence.preRestoreValidation?.ok === true,
    expectedTargetIds: expectedIds,
  };
  evidence.cleanup = {
    ok: false, contentDrain, workerDrain, pageScheduler,
    resourceValidation: validateRuntimeResources(resources, {
      terminalMessageIds: [...rootIds], sessionIds: [held.pageSessionId], final: true,
    }),
  };
  evidence.concurrency = {
    peakPhysical: providerPhysicalAccounting?.peakPhysicalConcurrency ?? null,
    peakLogical: providerLogicalBatches?.peakLogicalBatchConcurrency ?? null,
    providerLimiterCapacity: providerRuntimeObserved?.limiterCapacity ?? null,
    pageWorkerLimit: pageWorkerLimit ?? null,
  };
  return evidence;
}

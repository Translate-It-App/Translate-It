import { createCancellationCommandSender } from './cancellation-runner.mjs';
import { validatePostInvalidationEvidence } from './cancellation-probes.mjs';
import { resolveCleanupSessionEvidence, teardownSuccessfulReplyGate, validateCleanupInvalidation, validateReplacementDiscoverySnapshot, validateReplacementStability, validateRuntimeResources, validateStaleSuccessEvidence, validateSuccessfulReplyCapture, validateWorkerNetworkCompletion } from './successful-reply-probes.mjs';

export async function waitForSuccessfulReplyCapture({ snapshot, until }) {
  return until(async () => {
    const state = await snapshot();
    if (['failed', 'timed-out', 'closed'].includes(state?.gate?.status)) {
      throw new Error(`Successful reply gate failed before capture: ${state.gate.error ?? state.gate.status}`);
    }
    return state?.gate?.captured ? state : null;
  }, 45_000);
}

export async function runStaleSuccessProbe({ trial, fixture, page, worker, probe, helpers }) {
  const { fixtureConfig, originals, originalById } = fixture;
  const { chrome, pageSession, contentContext, evaluate } = page;
  const { workerSession } = worker;
  const { sessionId, cancellationControl, staleSuccessProbe, requestHandlerJobs } = probe;
  const { now, until, isSessionEvent, formatCommandFailure, sessionIdFromStart, mapStaleSuccessResponse } = helpers;
  const expectedIds = fixtureConfig.targets.map(target => target.id);
  const sourceToId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
  const snapshotContent = async owner => {
    const snapshot = await evaluate(chrome, pageSession,
      `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, contentContext, false);
    if (snapshot?.instrumentationErrors?.length) throw new Error(`Content ownership instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
    return snapshot;
  };
  const snapshotWorker = async (owner, messageIds = [], sessionIds = []) => {
    const snapshot = await evaluate(chrome, workerSession,
      `(()=>({probe:globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)}),resources:globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(messageIds)},${JSON.stringify(sessionIds)})}))()`, undefined, false);
    if (snapshot?.probe?.instrumentationErrors?.length) throw new Error(`Worker ownership instrumentation failed: ${snapshot.probe.instrumentationErrors.join('; ')}`);
    return snapshot;
  };
  const snapshotDom = async label => {
    const dom = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.dataset.benchKind==='title'?el.getAttribute('title'):el.textContent])`, contentContext, false);
    const metadata = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
    const value = { at: now(), dom, metadata };
    trial.staleSuccess.domSnapshots[label] = value;
    return value;
  };
  const captureReplyProbeSnapshot = async label => {
    const snapshot = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
    trial.staleSuccess.replyGate.probeSnapshots ??= [];
    trial.staleSuccess.replyGate.probeSnapshots.push({ label, at: now(), snapshot });
    return snapshot;
  };
  const sendCommand = createCancellationCommandSender({
    now,
    send: command => evaluate(chrome, pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify(command)})`, contentContext),
    record: value => {
      trial.staleSuccess.commands.push(value);
      trial.commands.push(value);
    },
  });
  const eventForSession = async (actions, owner) => until(async () => {
    const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
    trial.lifecycle = events;
    const event = events.find(item => actions.some(action => isSessionEvent(item, action, owner)));
    return event ?? null;
  }, 45_000);
  const acceptedLifecycle = async (action, owner) => until(async () => {
    const content = await snapshotContent(owner);
    return content.operations.find(operation => operation.kind === 'lifecycle.delivery'
      && operation.sessionId === owner && operation.action === action && operation.accepted === true) ?? null;
  }, 15_000);
  const pollGate = () => waitForSuccessfulReplyCapture({
    snapshot: () => evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false),
    until,
  });

  const sessionIdA = sessionId;
  trial.staleSuccess.sessionA = sessionIdA;
  const startA = await acceptedLifecycle('page-translate-start', sessionIdA);
  let causalOrder = 0;
  const captured = await pollGate();
  if (cancellationControl.initialSessionId !== sessionIdA) throw new Error('A provider request owner did not match the trusted PAGE_TRANSLATE session ID.');
  const selected = captured.selectedBatch;
  const capturedMessage = captured.capturedMessage;
  if (selected?.members?.some(member => !sourceToId.has(member.text))) throw new Error('Selected A batch contains unknown fixture text.');
  const captureValidation = validateSuccessfulReplyCapture({
    expectedSessionId: sessionIdA,
    selectedBatch: selected,
    capturedMessage,
    gateSnapshot: captured.gate,
  });
  trial.staleSuccess.replyGate = { snapshot: captured, validation: captureValidation, startLifecycle: startA };
  if (!captureValidation.ok) throw new Error(`Successful reply capture gate failed: ${captureValidation.issues.join('; ')}`);

  const firstBatchIds = selected.members.map(member => sourceToId.get(member.text));
  if (new Set(firstBatchIds).size !== firstBatchIds.length || firstBatchIds.length !== 25) {
    throw new Error(`First captured A batch must contain 25 unique fixture IDs; observed ${firstBatchIds.length}.`);
  }
  const workerAtCapture = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
  const rootA = workerAtCapture.probe.providerRoots.find(root => root.messageId === capturedMessage.messageId && root.sessionId === sessionIdA);
  const physicalA = workerAtCapture.probe.ledger.operations.find(operation => operation.kind === 'provider.physical'
    && operation.messageId === capturedMessage.messageId && operation.sessionId === sessionIdA);
  const requestA = trial.requests.find(request => request.category === 'provider-translation'
    && JSON.stringify(request.batchTexts) === JSON.stringify(selected.members.map(member => member.text)));
  if (!requestA || requestA.response?.status !== 200 || rootA?.status !== 'fulfilled' || physicalA?.status !== 'fulfilled') {
    throw new Error('A source transport/provider root/physical request did not positively fulfill before its successful runtime reply was gated.');
  }
  if (!requestA.targetSessionId || !requestA.targetId || !requestA.networkId) {
    throw new Error('A Fetch request lacks exact Network CDP session/target/networkId correlation.');
  }
  const networkCompletion = await until(() => {
    const matching = (trial.staleSuccess.networkEvents ?? []).filter(event => event.sessionId === requestA.targetSessionId
      && event.targetId === requestA.targetId && event.params?.requestId === requestA.networkId);
    if (!matching.some(event => ['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method))) return null;
    return validateWorkerNetworkCompletion({
      events: trial.staleSuccess.networkEvents,
      networkId: requestA.networkId,
      sessionId: requestA.targetSessionId,
      targetId: requestA.targetId,
    });
  }, 15_000);
  if (!networkCompletion.ok) throw new Error(`A Fetch Network completion proof failed: ${networkCompletion.issues.join('; ')}`);
  trial.staleSuccess.sourceSuccess = {
    request: requestA, providerRoot: rootA, physical: physicalA,
    networkSessionId: requestA.targetSessionId, networkTargetId: requestA.targetId,
    networkEvents: networkCompletion.matchedEvents, networkValidation: networkCompletion,
    worker: workerAtCapture,
  };

  const domBeforeInvalidation = await snapshotDom('before-invalidation');
  const acceptedBeforeInvalidation = (await snapshotContent(sessionIdA)).operations.filter(operation => operation.kind === 'scheduler.settlement'
    && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true);
  if (acceptedBeforeInvalidation.length || domBeforeInvalidation.dom.some(([id, text]) => text !== originalById.get(id))) {
    throw new Error('A acquired accepted translations before its first successful reply was invalidated; B cannot be required to translate all fixture targets.');
  }
  await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.beginSuccessfulReplyMutationCapture()', contentContext);
  trial.staleSuccess.rawMutationCaptureStarted = true;
  const invalidationCommand = staleSuccessProbe === 'restore'
    ? await sendCommand('page-restore')
    : await sendCommand('page-translate-stop-auto');
  const expectedTerminalAction = staleSuccessProbe === 'restore' ? 'page-restore-complete' : 'page-auto-restore-complete';
  if (!invalidationCommand?.success) throw new Error(formatCommandFailure(expectedTerminalAction, invalidationCommand));
  const terminalEvent = await eventForSession([expectedTerminalAction], sessionIdA);
  const invalidated = await until(async () => {
    const state = await snapshotContent(sessionIdA);
    const event = state.operations.find(operation => operation.kind === 'session.invalidation'
      && operation.sessionId === sessionIdA && operation.capturedSessionActive === false && operation.discoveryCancelled === true);
    return event ? { event, state } : null;
  }, 20_000);
  const invalidationSequence = invalidated.event.sequence;
  const invalidationOrder = ++causalOrder;
  const expectedDomAfterInvalidation = staleSuccessProbe === 'restore'
    ? fixtureConfig.targets.map(target => [target.id, target.source])
    : domBeforeInvalidation.dom;
  const afterInvalidation = await snapshotDom('after-invalidation-before-A-release');
  if (JSON.stringify(afterInvalidation.dom) !== JSON.stringify(expectedDomAfterInvalidation)) {
    throw new Error(`${staleSuccessProbe} changed DOM before the late A reply was released.`);
  }
  trial.staleSuccess.invalidation = { command: invalidationCommand, terminalEvent, event: invalidated.event, sequence: invalidationSequence, order: invalidationOrder, dom: afterInvalidation };

  const validateSourceDom = (snapshot, label) => {
    const issues = [];
    if (snapshot.dom.length !== fixtureConfig.targetCount) issues.push(`${label}: target count differs`);
    for (const [id, text] of snapshot.dom) if (originalById.get(id) !== text) issues.push(`${label}: ${id} is not original source text`);
    const initialAttributes = new Map(trial.staleSuccess.initialDOMMetadata.map(item => [item.id, item.attributes]));
    for (const target of snapshot.metadata) {
      const original = initialAttributes.get(target.id);
      if (!original || JSON.stringify([...target.attributes].sort(([a], [b]) => a.localeCompare(b)))
          !== JSON.stringify([...original].sort(([a], [b]) => a.localeCompare(b)))) issues.push(`${label}: ${target.id} attributes differ from source`);
    }
    return { ok: issues.length === 0, issues };
  };
  const schedulerStateEquals = (left, right) => left && right
    && ['translationSessionId', 'isTranslated', 'translatedCount', 'failedCount', 'totalTasks', 'activeFlushes',
      'sessionContextOwned', 'pendingSettlementCount', 'batchTimerActive', 'completionTimerActive', 'discoveryPending',
      'bridgeSessionOwned', 'bridgeSessionActive', 'bridgeDiscoveryPending', 'bridgeDiscoveryRunning', 'bridgeDiscoveryStarting',
      'bridgeDiscoveryQueueDepth', 'bridgeDiscoveryCancelled', 'bridgeDiscoveryFailed'].every(key => left[key] === right[key])
    && JSON.stringify(left.queueIds) === JSON.stringify(right.queueIds)
    && JSON.stringify(left.activeBatchIds) === JSON.stringify(right.activeBatchIds);
  const releaseAndProveA = async ({ replacement = null } = {}) => {
    const releaseOrder = ++causalOrder;
    const didRelease = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.releaseSuccessfulReplyProbe()', contentContext);
    if (didRelease !== true) throw new Error('Successful reply gate refused explicit release.');
    const aAfterRelease = await until(async () => {
      const probe = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
      const attempt = {
        observedAt: now(),
        replyProbeSnapshot: probe ?? null,
        gate: probe?.gate ?? null,
        selectedBatch: probe?.selectedBatch ?? null,
        capturedMessage: probe?.capturedMessage ?? null,
        staleGuard: probe?.staleGuard ?? null,
        guards: probe?.guards ?? [],
        guardDiagnostics: probe?.guardDiagnostics ?? [],
        guardInstallations: probe?.guardInstallations ?? [],
        instrumentationErrors: probe?.instrumentationErrors ?? [],
      };
      trial.staleSuccess.replyGate.afterReleaseAttempt = attempt;
      const content = await snapshotContent(sessionIdA);
      const allContent = await snapshotContent(undefined);
      const targetBatchSettled = allContent.operations.some(operation => operation.kind === 'scheduler.batch'
        && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
        && JSON.stringify(operation.targetIds) === JSON.stringify(firstBatchIds));
      attempt.events = probe?.events ?? [];
      attempt.schedulerBatchSettled = targetBatchSettled;
      attempt.contentPendingOperations = content.pendingOperations ?? null;
      return probe?.gate?.settled && probe.gate.deliveryIdentity?.responseIdentityPreserved === true
        && content.pendingOperations === 0 && targetBatchSettled
        ? { probe, content, allContent } : null;
    }, 30_000);
    const gate = aAfterRelease.probe.gate;
    const gateWithOrder = { ...gate, releaseOrder };
    const guard = aAfterRelease.probe.staleGuard;
    const allOperations = aAfterRelease.allContent.operations;
    const aAccepted = allOperations.filter(operation => operation.kind === 'scheduler.settlement'
      && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true
      && operation.sequence > invalidationSequence).map(operation => operation.id);
    const postInvalidation = validatePostInvalidationEvidence({
      sessionId: sessionIdA, invalidationSequence, operations: allOperations,
      duplicateAcceptedIds: aAfterRelease.content.mutationSnapshot?.duplicateAcceptedIds ?? [],
      allowedMutationOwners: replacement ? [replacement.sessionId] : [],
    });
    const domAfterAReply = await snapshotDom('after-A-reply-while-B-pending');
    const unexpectedTexts = domAfterAReply.dom.filter(([id, text]) => text !== originalById.get(id)
      && !(replacement && text.startsWith('\u200efixture translation B: ')));
    const lateLifecycle = allOperations.filter(operation => operation.sessionId === sessionIdA
      && operation.sequence > invalidationSequence
      && ['lifecycle.emission', 'lifecycle.delivery'].includes(operation.kind)
      && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action));
    const acceptedLateLifecycle = lateLifecycle.filter(operation => operation.kind !== 'lifecycle.delivery' || operation.accepted !== false);
    const batchSettlements = allOperations.filter(operation => operation.kind === 'scheduler.batch'
      && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
      && JSON.stringify(operation.targetIds) === JSON.stringify(firstBatchIds));
    const issues = [];
    if (!batchSettlements.length) issues.push('A scheduler batch did not fulfill after its stale ownership guard');
    if (!postInvalidation.ok) issues.push(...postInvalidation.issues);
    if (unexpectedTexts.length) issues.push(`A/non-B translated values appeared after reply release: ${unexpectedTexts.map(([id]) => id).join(',')}`);
    if (acceptedLateLifecycle.length) issues.push('A emitted or delivered progress/completion lifecycle after invalidation');
    if (aAccepted.length) issues.push(`A accepted IDs after invalidation: ${aAccepted.join(',')}`);

    let bEvidence = null;
    let bStillPending = false;
    let bStable = true;
    let bAttribution = null;
    if (replacement) {
      // Take the worker snapshot BEFORE the content-side snapshot/send log so the send log is never older than the worker evidence.
      const workerAfter = await snapshotWorker(replacement.sessionId, [capturedMessage.messageId, replacement.messageId], [sessionIdA, replacement.sessionId]);
      const [schedulerAfter, probeSnapshot] = await Promise.all([
        evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
        evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false),
      ]);
      const rootAfter = workerAfter.probe.providerRoots.find(root => root.messageId === replacement.messageId && root.sessionId === replacement.sessionId);
      const controllerAfter = workerAfter.probe.controllers.find(controller => controller.messageId === replacement.messageId && controller.sessionId === replacement.sessionId);
      const sentByB = (probeSnapshot?.sentPageBatches ?? [])
        .filter(entry => entry?.sessionId === replacement.sessionId && typeof entry?.messageId === 'string')
        .map(entry => entry.messageId);
      const allowedConcurrentMessageIds = [...new Set(sentByB)].filter(id => id !== replacement.messageId);
      const stability = validateReplacementStability({
        schedulerBefore: replacement.scheduler, schedulerAfter: schedulerAfter,
        resourcesBefore: replacement.worker.resources, resourcesAfter: workerAfter.resources,
        providerRootAfter: rootAfter, controllerAfter, heldRequest: replacement.held,
        sessionId: replacement.sessionId, messageId: replacement.messageId,
        terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, replacement.sessionId],
        allowedConcurrentMessageIds,
      });
      bStable = stability.ownership;
      bStillPending = stability.pending;
      if (!stability.ok) issues.push(...stability.issues);
      if (!bStable) issues.push('B session ownership, provider request, or resource state is invalid during A reply release');
      bEvidence = { scheduler: schedulerAfter, worker: workerAfter, root: rootAfter, controller: controllerAfter, stability };
      bAttribution = { allowedConcurrentMessageIds, sentPageBatches: probeSnapshot?.sentPageBatches ?? [] };
    }
    const gateReleasedAt = aAfterRelease.probe.events.find(event => event.name === 'gate' && event.event?.type === 'released')?.at ?? null;
    const gateForValidation = { ...gateWithOrder, releasedAt: gateReleasedAt };
    const proof = validateStaleSuccessEvidence({
      gate: gateForValidation,
      invalidation: { confirmed: invalidationSequence > 0, order: invalidationOrder },
      guard, batch: { ...capturedMessage, sessionId: sessionIdA },
      acceptedAIds: aAccepted, acceptedBIds: [], expectedIds: [], domValues: [], lateLifecycle: acceptedLateLifecycle,
      bStillPending, schedulerBatchSettled: batchSettlements.length > 0,
      postInvalidationOk: postInvalidation.ok, domNoUnexpectedWrites: unexpectedTexts.length === 0,
      bStateStable: bStable, requireBPending: !!replacement,
    });
    issues.push(...proof.issues);
    proof.issues = [...new Set(issues)];
    proof.ok = proof.issues.length === 0;
    return {
      probe: aAfterRelease.probe, gate: gateForValidation, guard, operations: allOperations,
      acceptedAIds: aAccepted, postInvalidation, lateLifecycle, batchSettlements,
      domAfterAReply, bEvidence, bAttribution, bStillPending, bStable, validation: proof,
    };
  };

  if (staleSuccessProbe !== 'replacement') {
    const schedulerBeforeRelease = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
    const beforeDrain = await until(async () => {
      const worker = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
      const validation = validateRuntimeResources(worker.resources, {
        terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
      });
      return worker.probe.ledger.pending === 0 && !worker.probe.providerRoots.some(root => root.status === 'pending') && validation.ok
        ? { worker, validation } : null;
    }, 15_000);
    const workerBeforeRelease = beforeDrain.worker;
    const resourceValidation = beforeDrain.validation;
    const aProof = await releaseAndProveA();
    const schedulerAfterRelease = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
    const afterDrain = await until(async () => {
      const worker = await snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]);
      const validation = validateRuntimeResources(worker.resources, {
        terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
      });
      return worker.probe.ledger.pending === 0 && !worker.probe.providerRoots.some(root => root.status === 'pending') && validation.ok
        ? { worker, validation } : null;
    }, 15_000);
    const workerAfterRelease = afterDrain.worker;
    const afterResources = afterDrain.validation;
    const sourceDomValidation = validateSourceDom(aProof.domAfterAReply, `${staleSuccessProbe}-after-A-reply`);
    if (!schedulerStateEquals(schedulerBeforeRelease, schedulerAfterRelease)) aProof.validation.issues.push('Stop/Restore scheduler state changed when stale A reply settled');
    aProof.validation.issues.push(...resourceValidation.issues, ...afterResources.issues, ...sourceDomValidation.issues);
    aProof.validation.ok = aProof.validation.issues.length === 0;
    trial.staleSuccess.replyGate = { ...trial.staleSuccess.replyGate, afterRelease: aProof.probe, releaseOrder: aProof.gate.releaseOrder };
    trial.staleSuccess.ownershipProof = {
      ...aProof, guardDiagnostics: aProof.probe.guardDiagnostics,
      bridgeGuard: { observed: false, reason: 'No direct Bridge guard instrumentation is installed; only the exact scheduler ownership guard is claimed.' },
      schedulerBeforeRelease, schedulerAfterRelease,
      workerBeforeRelease, workerAfterRelease,
      resourceValidationBefore: resourceValidation, resourceValidationAfter: afterResources,
      sourceDOMValidation: sourceDomValidation,
    };
    if (!aProof.validation.ok) throw new Error(`${staleSuccessProbe} stale-reply proof failed: ${aProof.validation.issues.join('; ')}`);
    if (staleSuccessProbe === 'stop') {
      const cleanupRestore = await sendCommand('page-restore');
      if (!cleanupRestore?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after stop-only stale-success proof', cleanupRestore));
      trial.staleSuccess.restoreTerminal = await eventForSession(['page-restore-complete'], sessionIdA);
    }
    const noBFinalDrain = await until(async () => {
      const [content, worker] = await Promise.all([
        snapshotContent(undefined),
        snapshotWorker(sessionIdA, [capturedMessage.messageId], [sessionIdA]),
      ]);
      const validation = validateRuntimeResources(worker.resources, {
        terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA], final: true,
      });
      return content.pendingOperations === 0 && worker.probe.ledger.pending === 0
        && !worker.probe.providerRoots.some(root => root.status === 'pending')
        && requestHandlerJobs.size === 0 && validation.ok
        ? { content, worker, validation } : null;
    }, 15_000);
    const restored = await snapshotDom(`${staleSuccessProbe}-final-source`);
    const finalSourceValidation = validateSourceDom(restored, `${staleSuccessProbe}-final-source`);
    if (!finalSourceValidation.ok) throw new Error(finalSourceValidation.issues.join('; '));
    if (staleSuccessProbe === 'restore') trial.staleSuccess.restoreTerminal = terminalEvent;
    trial.staleSuccess.finalOwnership = { acceptedAIds: aProof.acceptedAIds, acceptedBIds: [], finalDOM: restored, validation: finalSourceValidation };
    trial.rawDOM.original = originals;
    trial.rawDOM.translated = domBeforeInvalidation.dom;
    trial.rawDOM.restored = restored.dom;
    trial.staleSuccess.finalResources = { before: workerBeforeRelease.resources, after: noBFinalDrain.worker.resources, validation: noBFinalDrain.validation };
    trial.staleSuccess.networkProof = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
      batchSize: request.batchSize, batchTexts: request.batchTexts, response: request.response,
      correlation: request.cancellationCorrelation, correlationIssues: request.cancellationCorrelationIssues,
    }));
    trial.status = 'passed';
    return trial;
  }

  cancellationControl.replacementSessionId = null;
  await evaluate(chrome, pageSession, "window.__pageTranslationBenchmark.translationPrefix='fixture translation B:'", contentContext);
  const startBResponse = await sendCommand('page-translate', {
    provider: 'edge', targetLanguage: 'fr', isAuto: true, preserveAcceptedTranslations: true,
  });
  if (!startBResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE replacement B', startBResponse));
  const sessionIdB = sessionIdFromStart(startBResponse);
  if (!sessionIdB || sessionIdB === sessionIdA) throw new Error('Replacement B must have a trusted distinct session ID.');
  trial.staleSuccess.sessionB = sessionIdB;
  const startB = await acceptedLifecycle('page-translate-start', sessionIdB);
  await captureReplyProbeSnapshot('trusted-B-start');
  const managerEvents = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.events.filter(event=>event.name==="manager.translatePage.entry")', contentContext, false);
  if (managerEvents.at(-1)?.isAuto !== true) throw new Error('Replacement B did not use the normal auto/preserve start path.');
  const heldBLock = await until(() => {
    const held = cancellationControl.heldRequests
      .filter(item => item.pageSessionId === sessionIdB && !item.record.released).map(item => item.record)[0] ?? null;
    return held && cancellationControl.replacementSessionId === sessionIdB
      ? { held, lockedSessionId: cancellationControl.replacementSessionId, lockedAt: now() }
      : null;
  }, 45_000);
  const heldB = heldBLock.held;
  if (cancellationControl.replacementSessionId !== sessionIdB || heldB.pageSessionId !== sessionIdB) {
    throw new Error('B held Fetch did not match the exact trusted replacement session ID.');
  }
  trial.staleSuccess.replacementOwnerLock = {
    sessionId: heldBLock.lockedSessionId,
    observedAt: heldBLock.lockedAt,
    assignmentEvidence: 'first matching provider root was correlated to accepted B lifecycle and current B scheduler before Fetch was held',
    heldFetch: { requestId: heldB.requestId, networkId: heldB.networkId, targetSessionId: heldB.sessionId, targetId: heldB.targetId },
  };
  await captureReplyProbeSnapshot('B-first-provider-fetch-held');
  const workerAtB = await snapshotWorker(sessionIdB, [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]);
  const rootB = workerAtB.probe.providerRoots.find(root => root.messageId === heldB.batchMessageId && root.sessionId === sessionIdB);
  const controllerB = workerAtB.probe.controllers.find(controller => controller.messageId === heldB.batchMessageId && controller.sessionId === sessionIdB);
  const trustedBStart = await acceptedLifecycle('page-translate-start', sessionIdB);
  if (!heldB || heldB.controllerAbortedAtPause !== false || heldB.providerRootStatusAtPause !== 'pending'
      || rootB?.status !== 'pending' || controllerB?.aborted !== false || !trustedBStart) {
    throw new Error('B was not a distinct trusted active owner with its first real physical provider request held.');
  }
  const bFirstBatchIds = heldB.targetIds;
  if (!Array.isArray(bFirstBatchIds) || bFirstBatchIds.length !== 25 || new Set(bFirstBatchIds).size !== 25
      || bFirstBatchIds.some(id => !expectedIds.includes(id))) {
    throw new Error('B first physical request is not 25 distinct known fixture IDs.');
  }
  const overlapAIds = bFirstBatchIds.filter(id => firstBatchIds.includes(id));
  if (!overlapAIds.length) throw new Error('B first batch did not overlap any unaccepted A target, so it cannot challenge stale-write interference.');
  trial.staleSuccess.replacementOverlap = { aFirstBatchIds: firstBatchIds, bFirstBatchIds, overlapIds: overlapAIds };
  const bDiscoveryWait = trial.staleSuccess.bDiscoveryWait = { observations: [] };
  const bDiscoveryCheckpoint = await until(async () => {
    const [scheduler, content] = await Promise.all([
      evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
      snapshotContent(sessionIdB),
    ]);
    const validation = validateReplacementDiscoverySnapshot({
      snapshot: scheduler,
      sessionId: sessionIdB,
      targetCount: fixtureConfig.targetCount,
      firstBatchSize: bFirstBatchIds.length,
      settlementOperations: content.operations,
    });
    const observation = { at: now(), scheduler, validation };
    if (bDiscoveryWait.observations.length < 64) bDiscoveryWait.observations.push(observation);
    else bDiscoveryWait.observations[bDiscoveryWait.observations.length - 1] = observation;
    return validation.ok ? { scheduler, content, validation } : null;
  }, 20_000);
  trial.staleSuccess.bDiscoveryCheckpoint = bDiscoveryCheckpoint;
  const bAttributedMessageIds = async () => {
    const snapshot = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
    return [...new Set((snapshot?.sentPageBatches ?? [])
      .filter(entry => entry?.sessionId === sessionIdB && typeof entry?.messageId === 'string')
      .map(entry => entry.messageId))];
  };
  const bContentBeforeRelease = await snapshotContent(sessionIdB);
  const bSchedulerBeforeRelease = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
  const bResourcesBeforeRelease = workerAtB.resources;
  const bAllowedIds = (await bAttributedMessageIds()).filter(id => id !== heldB.batchMessageId);
  const bResourceValidation = validateRuntimeResources(bResourcesBeforeRelease, {
    activeMessageId: heldB.batchMessageId, terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, sessionIdB],
    additionalAllowedMessageIds: bAllowedIds,
  });
  const bLeaseHeld = bResourcesBeforeRelease.lease?.activeOperationIds?.includes(heldB.batchMessageId) === true;
  const bTrackedRequest = bResourcesBeforeRelease.service?.requests?.find(request => request.messageId === heldB.batchMessageId) ?? null;
  trial.staleSuccess.bLeaseDiagnostic = {
    fetchSessionId: heldB.sessionId,
    pageSessionId: heldB.pageSessionId,
    fetchTargetId: heldB.targetId,
    fetchNetworkId: heldB.networkId,
    providerMessageId: heldB.batchMessageId,
    serviceRequest: bTrackedRequest,
    leaseSnapshot: bResourcesBeforeRelease.lease ?? null,
    exactMessageIdHeld: bLeaseHeld,
    allowedConcurrentMessageIds: bAllowedIds,
  };
  const aGateBeforeRelease = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
  if (aGateBeforeRelease?.gate?.status !== 'captured' || aGateBeforeRelease.gate.settled || !aGateBeforeRelease.gate.pending) {
    throw new Error('A genuine successful reply was not still held before B ownership was established.');
  }
  if (!bLeaseHeld || !bResourceValidation.ok) {
    throw new Error(`B runtime resource proof failed for exact provider message ${heldB.batchMessageId}: ${bResourceValidation.issues.join('; ') || `active lease IDs=${JSON.stringify(bResourcesBeforeRelease.lease?.activeOperationIds ?? null)}`}`);
  }
  await captureReplyProbeSnapshot('B-lease-validated-before-A-release');
  const workerImmediatelyBeforeRelease = await snapshotWorker(sessionIdB,
    [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]);
  const rootImmediatelyBeforeRelease = workerImmediatelyBeforeRelease.probe.providerRoots.find(root => root.messageId === heldB.batchMessageId && root.sessionId === sessionIdB);
  const controllerImmediatelyBeforeRelease = workerImmediatelyBeforeRelease.probe.controllers.find(controller => controller.messageId === heldB.batchMessageId && controller.sessionId === sessionIdB);
  const schedulerImmediatelyBeforeRelease = await evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false);
  const bAllowedIdsNow = (await bAttributedMessageIds()).filter(id => id !== heldB.batchMessageId);
  const resourcesImmediatelyBeforeRelease = validateRuntimeResources(workerImmediatelyBeforeRelease.resources, {
    activeMessageId: heldB.batchMessageId, terminalMessageIds: [capturedMessage.messageId], sessionIds: [sessionIdA, sessionIdB],
    additionalAllowedMessageIds: bAllowedIdsNow,
  });
  const bSchedulerCurrentAtRelease = schedulerImmediatelyBeforeRelease?.translationSessionId === sessionIdB
    && schedulerImmediatelyBeforeRelease?.isTranslated === true
    && schedulerImmediatelyBeforeRelease?.sessionContextOwned === true
    && Number.isFinite(schedulerImmediatelyBeforeRelease?.translatedCount)
    && Number.isFinite(schedulerImmediatelyBeforeRelease?.failedCount)
    && Number.isFinite(schedulerImmediatelyBeforeRelease?.totalTasks)
    && Number.isFinite(schedulerImmediatelyBeforeRelease?.activeFlushes)
    && Number.isInteger(schedulerImmediatelyBeforeRelease?.pendingSettlementCount)
    && typeof schedulerImmediatelyBeforeRelease?.batchTimerActive === 'boolean'
    && typeof schedulerImmediatelyBeforeRelease?.completionTimerActive === 'boolean'
    && Array.isArray(schedulerImmediatelyBeforeRelease?.queueIds)
    && Array.isArray(schedulerImmediatelyBeforeRelease?.activeBatchIds);
  await captureReplyProbeSnapshot('immediately-before-A-release');
  trial.staleSuccess.bImmediatelyBeforeARelease = {
    root: rootImmediatelyBeforeRelease,
    controller: controllerImmediatelyBeforeRelease,
    schedulerAtFirstSnapshot: bSchedulerBeforeRelease,
    schedulerImmediatelyBeforeRelease,
    resourcesImmediatelyBeforeRelease: workerImmediatelyBeforeRelease.resources,
    resourcesValidation: resourcesImmediatelyBeforeRelease,
    allowedConcurrentMessageIds: bAllowedIdsNow,
    schedulerOwnedAndInspectable: bSchedulerCurrentAtRelease,
  };
  if (rootImmediatelyBeforeRelease?.status !== 'pending' || controllerImmediatelyBeforeRelease?.aborted !== false
      || !bSchedulerCurrentAtRelease || !resourcesImmediatelyBeforeRelease.ok) {
    throw new Error(`B owner/resource snapshot invalid immediately before A release: ${JSON.stringify({ rootStatus: rootImmediatelyBeforeRelease?.status ?? null, controllerAborted: controllerImmediatelyBeforeRelease?.aborted ?? null, schedulerOwnedAndInspectable: bSchedulerCurrentAtRelease, issues: resourcesImmediatelyBeforeRelease.issues })}`);
  }
  trial.staleSuccess.bActiveAtARelease = {
    start: startB,
    heldRequest: heldB,
    root: rootB,
    controller: controllerB,
    trustedStart: trustedBStart,
    schedulerAtFirstSnapshot: bSchedulerBeforeRelease,
    scheduler: schedulerImmediatelyBeforeRelease,
    content: bContentBeforeRelease,
    resourcesAtFirstSnapshot: bResourcesBeforeRelease,
    resourceValidationAtFirstSnapshot: bResourceValidation,
    immediatelyBeforeRelease: {
      root: rootImmediatelyBeforeRelease,
      controller: controllerImmediatelyBeforeRelease,
      scheduler: schedulerImmediatelyBeforeRelease,
      resources: workerImmediatelyBeforeRelease.resources,
      resourceValidation: resourcesImmediatelyBeforeRelease,
    },
  };
  const aProof = await releaseAndProveA({
    replacement: { sessionId: sessionIdB, held: heldB, messageId: heldB.batchMessageId, worker: workerImmediatelyBeforeRelease, scheduler: schedulerImmediatelyBeforeRelease },
  });
  trial.staleSuccess.replyGate = { ...trial.staleSuccess.replyGate, afterRelease: aProof.probe, releaseOrder: aProof.gate.releaseOrder };
  trial.staleSuccess.ownershipProof = {
    ...aProof,
    guardDiagnostics: aProof.probe.guardDiagnostics,
    bridgeGuard: { observed: false, reason: 'No direct Bridge guard instrumentation is installed; only the exact scheduler ownership guard is claimed.' },
    sourceRootA: rootA, physicalA,
  };
  if (!aProof.validation.ok) throw new Error(`Stale successful reply ownership gate failed: ${aProof.validation.issues.join('; ')}`);

  const heldControl = cancellationControl.heldRequests.find(item => item.record === heldB);
  if (!heldControl) throw new Error('B held Fetch is not owned by trial cleanup lifecycle.');
  cancellationControl.releaseReplacement = true;
  for (const control of cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB && !item.record.released)) {
    const request = trial.requests.find(item => item.heldFetch === control.record);
    await control.reservation.release('fulfill', {
      body: mapStaleSuccessResponse(request.batchTexts, sessionIdB, sessionIdA, sessionIdB),
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    });
    control.record.released = true;
  }
  await eventForSession(['page-translate-complete', 'page-translate-idle'], sessionIdB);
  const bTerminal = await until(async () => {
    const content = await snapshotContent(sessionIdB);
    const accepted = content.operations.filter(operation => operation.kind === 'scheduler.settlement'
      && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
    return accepted.length === expectedIds.length ? { content, accepted } : null;
  }, 60_000);
  const finalDom = await snapshotDom('after-B-complete');
  const expectedTranslated = new Map(fixtureConfig.targets.map(target => [target.id, `\u200efixture translation B: ${target.source}`]));
  const domIssues = finalDom.dom.flatMap(([id, text]) => expectedTranslated.get(id) === text ? [] : [`${id} did not contain B-prefixed text`]);
  const acceptedCounts = new Map();
  for (const id of bTerminal.accepted) acceptedCounts.set(id, (acceptedCounts.get(id) ?? 0) + 1);
  const bIssues = expectedIds.filter(id => acceptedCounts.get(id) !== 1).map(id => `${id} accepted ${acceptedCounts.get(id) ?? 0} times by B`);
  const aAfterB = bTerminal.content.operations.filter(operation => operation.kind === 'scheduler.settlement'
    && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
  if (domIssues.length || bIssues.length || aAfterB.length || finalDom.dom.length !== fixtureConfig.targetCount) {
    throw new Error(`Final A/B ownership invalid: ${[...domIssues, ...bIssues, ...aAfterB.map(id => `A accepted ${id}`)].join('; ')}`);
  }
  trial.staleSuccess.finalOwnership = {
    acceptedAIds: aAfterB,
    acceptedBIds: bTerminal.accepted,
    finalDOM: finalDom,
    validation: { ok: true, issues: [] },
  };
  const restoreResponse = await sendCommand('page-restore');
  if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after stale-success B', restoreResponse));
  trial.staleSuccess.restoreTerminal = await eventForSession(['page-restore-complete'], sessionIdB);
  const restored = await snapshotDom('after-B-restore');
  const restoreIssues = restored.dom.flatMap(([id, text]) => originalById.get(id) === text ? [] : [`${id} was not restored to its source`]);
  const initialAttributes = new Map(trial.staleSuccess.initialDOMMetadata.map(target => [target.id, target.attributes]));
  for (const target of restored.metadata) {
    if (JSON.stringify([...target.attributes].sort(([a], [b]) => a.localeCompare(b)))
        !== JSON.stringify([...(initialAttributes.get(target.id) ?? [])].sort(([a], [b]) => a.localeCompare(b)))) {
      restoreIssues.push(`${target.id} attributes were not restored exactly`);
    }
  }
  const finalDrain = await until(async () => {
    const [worker, content] = await Promise.all([
      snapshotWorker(sessionIdB, [capturedMessage.messageId, heldB.batchMessageId], [sessionIdA, sessionIdB]),
      snapshotContent(undefined),
    ]);
    const validation = validateRuntimeResources(worker.resources, {
      terminalMessageIds: [capturedMessage.messageId, heldB.batchMessageId], sessionIds: [sessionIdA, sessionIdB], final: true,
    });
    return worker.probe.ledger.pending === 0 && content.pendingOperations === 0
      && !worker.probe.providerRoots.some(root => root.status === 'pending')
      && requestHandlerJobs.size === 0 && validation.ok
      ? { worker, content, validation } : null;
  }, 15_000);
  const workerFinal = finalDrain.worker;
  const runtimeResources = finalDrain.validation;
  const resourceIssues = runtimeResources.issues;
  if (restored.dom.length !== fixtureConfig.targetCount || restoreIssues.length) {
    throw new Error(`Final Restore failed: ${restoreIssues.join('; ')}`);
  }
  trial.staleSuccess.finalResources = { worker: workerFinal, validation: { ok: resourceIssues.length === 0, issues: resourceIssues } };
  if (resourceIssues.length) throw new Error(`Runtime resources did not drain: ${resourceIssues.join('; ')}`);
  trial.rawDOM.original = originals;
  trial.rawDOM.translated = finalDom.dom;
  trial.rawDOM.restored = restored.dom;
  trial.staleSuccess.networkProof = trial.requests.filter(request => request.category === 'provider-translation').map(request => ({
    batchSize: request.batchSize, batchTexts: request.batchTexts, response: request.response,
    correlation: request.cancellationCorrelation, correlationIssues: request.cancellationCorrelationIssues,
  }));
  const failedProviderResponse = trial.requests.find(request => request.category === 'provider-translation'
    && !request.lateCancelledA && request.response?.status !== 200);
  if (failedProviderResponse) throw new Error('A or B provider request did not receive a fixture HTTP 200 response.');
  if (trial.staleSuccess.observationErrors.length) throw new Error(`Stale-success instrumentation had errors: ${JSON.stringify(trial.staleSuccess.observationErrors)}`);
  if (trial.requests.some(request => request.category === 'blocked')) throw new Error('Unexpected external request blocked during stale-success probe.');
  trial.staleSuccess.cleanup.pendingFetches = cancellationControl.heldRequests.filter(item => !item.record.handlerSettled).length;
  if (trial.staleSuccess.cleanup.pendingFetches) throw new Error('Stale-success probe ended with pending held Fetch handlers.');
  trial.status = 'passed';
  return trial;

}

export async function cleanupStaleSuccessProbe({ trial, page, helpers, cleanup }) {
  const { chrome, pageSession, contentContext, evaluate } = page;
  const { now, until, isSessionEvent } = helpers;
  let { staleContextDisposed } = cleanup;

  const sendCleanupCommand = async (action, reason) => {
    const sentAt = now();
    const message = { action };
    const response = await evaluate(chrome, pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify(message)})`, contentContext);
    const command = { action, reason: reason ?? null, sentAt, respondedAt: now(), response };
    trial.staleSuccess.cleanup.commands ??= [];
    trial.staleSuccess.cleanup.commands.push(command);
    return response;
  };
  const readReplyProbeSnapshot = async () => {
    try {
      const snapshot = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
      return snapshot && typeof snapshot === 'object' && Object.prototype.hasOwnProperty.call(snapshot, 'gate')
        ? { available: true, snapshot }
        : { available: false, snapshot: null, error: 'probe returned no snapshot object' };
    } catch (error) { return { available: false, snapshot: null, error: error.message }; }
  };
  const capturedAId = async () => {
    const probe = trial.staleSuccess.sessionA || trial.sessionId
      ? null : await readReplyProbeSnapshot();
    const evidence = resolveCleanupSessionEvidence({
      knownSessionId: trial.staleSuccess.sessionA ?? trial.sessionId ?? null,
      snapshotAvailable: probe?.available,
      replySnapshot: probe?.snapshot,
      pageStartAttempted: !!trial.timestamps.translationCommand,
    });
    if (!evidence.ok) throw new Error(`${evidence.issues.join('; ')}${probe?.error ? ` (${probe.error})` : ''}`);
    return evidence.sessionId;
  };
  const confirmedAInvalidation = async () => {
    let sessionIdA;
    try { sessionIdA = await capturedAId(); }
    catch (error) { return { ok: false, event: null, issues: [error.message] }; }
    if (!sessionIdA) return { ok: true, event: null, issues: [], noGatePendingProof: true };
    const read = async () => {
      const state = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionIdA)})`, contentContext, false);
      return validateCleanupInvalidation({ sessionId: sessionIdA, operations: state?.operations });
    };
    try { return await until(async () => { const result = await read(); return result.ok ? result : null; }, 3_000); }
    catch { return read().catch(error => ({ ok: false, event: null, issues: [error.message] })); }
  };

  const cleanupAId = await capturedAId().catch(error => {
    trial.cleanupErrors.push(`Stale-success cleanup session evidence unavailable: ${error.message}`);
    return null;
  });
  const owner = trial.staleSuccess.sessionB ?? cleanupAId;
  const teardown = await teardownSuccessfulReplyGate({
    preferStopFirst: trial.status !== 'passed' && !!cleanupAId,
    restoreNeeded: !!cleanupAId && !trial.staleSuccess.restoreTerminal,
    stop: () => sendCleanupCommand('page-translate-stop-auto', 'harness-invalidation-cleanup'),
    restore: async () => {
      if (!owner) return { success: false, terminalObserved: false };
      const response = await sendCleanupCommand('page-restore', 'harness-cleanup');
      trial.staleSuccess.cleanup.restoreAttempt = { response, sessionId: owner };
      if (!response?.success) return { success: false, terminalObserved: false };
      const terminal = await until(async () => {
        const events = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
        return events.find(event => isSessionEvent(event, 'page-restore-complete', owner)) ?? null;
      }, 5_000);
      trial.staleSuccess.restoreTerminal = terminal;
      return { success: true, terminalObserved: !!terminal };
    },
    confirmInvalidation: confirmedAInvalidation,
    openGate: async () => {
      trial.staleSuccess.cleanup.replyProbeSnapshotBeforeClose = await evaluate(chrome, pageSession,
        'window.__pageTranslationBenchmark.successfulReplySnapshot()', contentContext, false);
      trial.staleSuccess.cleanup.gateClosed = await evaluate(chrome, pageSession,
        `window.__pageTranslationBenchmark.closeSuccessfulReplyProbe('harness-cleanup')`, contentContext);
      trial.staleSuccess.cleanup.contentProbeClosed = trial.staleSuccess.cleanup.gateClosed;
    },
    disposeContext: async () => {
      if (!chrome) throw new Error('Chrome context is unavailable for fail-closed disposal');
      await chrome.close();
      trial.chromeStderr = chrome.metadata.stderr ?? null;
      staleContextDisposed = true;
      trial.staleSuccess.cleanup.contextDisposedBeforeGateOpen = true;
    },
  });
  trial.staleSuccess.cleanup.gateDisposition = teardown;
  trial.cleanupErrors.push(...teardown.errors.map(error => `Stale-success cleanup: ${error}`));
  if (!teardown.safeToOpen) {
    trial.cleanupErrors.push('Reply gate was not opened: Chrome context was disposed because A invalidation could not be confirmed.');
    if (trial.staleSuccess.rawMutationCaptureStarted && !trial.staleSuccess.rawMutationEvidence) {
      trial.cleanupErrors.push('Raw DOM mutation evidence could not be drained before unsafe-context disposal.');
    }
  }
    
  return staleContextDisposed;
}

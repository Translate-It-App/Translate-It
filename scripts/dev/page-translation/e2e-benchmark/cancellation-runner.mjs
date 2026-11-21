import { mapEdgeResponse, validateEffectiveSettings } from './metrics.mjs';
import { classifyHeldFetchRelease, validateActiveReplacementCheckpoint, validateCancellationQuiescence, validateCancellationSetup, validateMatchedCancellation, validatePostInvalidationEvidence, validateReplacementOwnership, validateSingleHeldRequest } from './cancellation-probes.mjs';

export function createCancellationCommandSender({ send, now, record }) {
  return async (action, data) => {
    const command = { action, ...(data === undefined ? {} : { data }) };
    const sentAt = now();
    const response = await send(command);
    record({ action, sentAt, respondedAt: now(), response });
    return response;
  };
}

export async function runCancellationProbe({ trial, fixture, page, worker, probe, measurement, helpers }) {
  const { fixtureConfig, originals, originalById } = fixture;
  const { chrome, pageSession, contentContext, evaluate } = page;
  const { workerSession } = worker;
  const { sessionId, started, cancellationControl, cancellationProbe } = probe;
  const { measurementState } = measurement;
  const { now, until, isSessionEvent, formatCommandFailure, sessionIdFromStart, deriveTimings } = helpers;
  const sourceToId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
  const expectedIds = fixtureConfig.targets.map(target => target.id);
  cancellationControl.initialSessionId = sessionId;
  const snapshotDom = async name => {
    const dom = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
    const metadata = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>({id:el.dataset.benchId,tagName:el.tagName,attributes:[...el.attributes].map(attribute=>[attribute.name,attribute.value])}))`, contentContext, false);
    const translatedIds = dom.filter(([id, text]) => text === `\u200efixture translation: ${originalById.get(id)}`).map(([id]) => id);
    const snapshot = { sequence: Object.keys(trial.cancellation.domSnapshots).length + 1, dom, metadata, translatedIds };
    trial.cancellation.domSnapshots[name] = snapshot;
    return snapshot;
  };
  const contentSnapshot = async owner => {
    const snapshot = await evaluate(chrome, pageSession,
      `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, contentContext, false);
    if (snapshot.instrumentationErrors?.length) {
      throw new Error(`Content cancellation ownership/promise instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
    }
    return snapshot;
  };
  const workerSnapshot = async owner => {
    const snapshot = await evaluate(chrome, workerSession,
      `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(owner)})`, undefined, false);
    if (snapshot.instrumentationErrors?.length) {
      throw new Error(`Worker cancellation/provider instrumentation failed: ${snapshot.instrumentationErrors.join('; ')}`);
    }
    return snapshot;
  };
  const eventSnapshot = async () => {
    trial.lifecycle = await evaluate(chrome, pageSession, 'window.__benchEvents??[]', contentContext, false);
    return trial.lifecycle;
  };
  let commandSequence = 0;
  const sendCommand = createCancellationCommandSender({
    now,
    send: command => evaluate(chrome, pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify(command)})`, contentContext),
    record: value => {
      const record = { sequence: ++commandSequence, ...value };
      trial.cancellation.commands.push(record);
      trial.commands.push(record);
    },
  });
  const waitHeldForSession = owner => until(() => cancellationControl.heldRequests
    .filter(request => request.pageSessionId === owner && !request.released)
    .map(request => request.record).find(Boolean) ?? null, 30_000);
  const releaseHeld = async (held, action = 'fulfill', failReason = null) => {
    const control = cancellationControl.heldRequests.find(item => item.record === held);
    if (!control) throw new Error(`Held Fetch ${held?.requestId ?? 'unknown'} is not owned by this trial.`);
    held.releaseAction = action;
    if (failReason) held.failReason = failReason;
    const requestRecord = trial.requests.find(request => request.heldFetch === held);
    const detail = action === 'fulfill'
      ? { body: mapEdgeResponse(requestRecord?.batchTexts ?? []), responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] }
      : { errorReason: failReason ?? 'Aborted' };
    await control.reservation.release(action, detail);
    await until(() => held.handlerSettled && held.releaseOutcome ? held : null, 10_000);
    held.networkCanceled = trial.cancellation.networkEvents.some(event => event.method === 'Network.loadingFailed'
      && event.sessionId === held.sessionId && event.targetId === held.targetId
      && event.params?.requestId === held.networkId && event.params?.canceled === true);
    return held;
  };
  const validateDomState = (snapshot, translatedIds, stage, { restored = false } = {}) => {
    const translated = new Set(translatedIds);
    const issues = [];
    if (snapshot.dom.length !== fixtureConfig.targetCount) issues.push(`${stage}: DOM target count ${snapshot.dom.length}`);
    const baselineMetadata = new Map(trial.cancellation.initialDOMMetadata.map(item => [item.id, item]));
    for (const actual of snapshot.metadata) {
      const baseline = baselineMetadata.get(actual.id);
      if (!baseline || actual.tagName !== baseline.tagName) {
        issues.push(`${stage}: target element identity/metadata unavailable for ${actual.id}`);
        continue;
      }
      const expectedAttributes = new Map(baseline.attributes);
      if (!restored && translated.has(actual.id)) expectedAttributes.set('data-page-translated', 'true');
      const actualAttributes = new Map(actual.attributes);
      if (JSON.stringify([...actualAttributes].sort(([a], [b]) => a.localeCompare(b)))
          !== JSON.stringify([...expectedAttributes].sort(([a], [b]) => a.localeCompare(b)))) {
        issues.push(`${stage}: target attributes differ from expected translated/original state for ${actual.id}`);
      }
    }
    for (const [id, text] of snapshot.dom) {
      const source = originalById.get(id);
      const expectedText = translated.has(id) ? `\u200efixture translation: ${source}` : source;
      if (source === undefined || text !== expectedText) issues.push(`${stage}: unexpected DOM value for ${id}`);
    }
    return { ok: issues.length === 0, issues };
  };
  const eventForSession = async (action, owner) => until(async () => {
    const events = await eventSnapshot();
    const found = events.find(event => isSessionEvent(event, action, owner));
    return found ? { found, events } : null;
  }, 45_000);
  const targetIdsForTexts = texts => texts.map(text => sourceToId.get(text) ?? null);

  const sessionIdA = sessionId;
  if (!started?.success || !sessionIdA) throw new Error('Successful cancellation-probe start omitted the real session ID.');
  trial.sessionId = sessionIdA;
  trial.cancellation.sessionA = sessionIdA;
  await eventForSession('page-translate-start', sessionIdA);

  const heldA = await waitHeldForSession(sessionIdA);
  const firstBatch = cancellationControl.firstBatchBySession.get(sessionIdA);
  if (!firstBatch) throw new Error('No first provider batch was mapped to the real session A.');
  const firstBatchIds = targetIdsForTexts(firstBatch.texts);
  const heldBatchIds = heldA.targetIds;
  if (firstBatchIds.some(id => id === null)) throw new Error('First physical provider batch contains unmapped source text.');
  await until(async () => {
    const dom = await evaluate(chrome, pageSession,
      `Array.from(document.querySelectorAll('[data-bench-id]')).map(el=>[el.dataset.benchId,el.textContent])`, contentContext, false);
    return firstBatchIds.every(id => dom.some(([actualId, text]) => actualId === id && text === `\u200efixture translation: ${originalById.get(id)}`))
      ? dom : null;
  }, 30_000);
  const beforeCancel = await snapshotDom('before-cancel');
  const contentBefore = await contentSnapshot(sessionIdA);
  const workerBefore = await workerSnapshot(sessionIdA);
  const acceptedBefore = contentBefore.mutationSnapshot?.acceptedIds ?? [];
  const setupValidation = validateCancellationSetup({
    sessionId: sessionIdA,
    firstBatchIds,
    acceptedIds: acceptedBefore,
    heldBatchIds,
    heldControllerAborted: heldA.controllerAbortedAtPause,
    heldProviderRootStatus: heldA.providerRootStatusAtPause,
  });
  trial.cancellation.setup = {
    firstBatchMessageId: firstBatch.messageId,
    firstBatchIds,
    heldRequest: { ...heldA },
    acceptedIdsBeforeCancel: acceptedBefore,
    workerSnapshotBeforeCancel: workerBefore,
    validation: setupValidation,
  };
  if (!setupValidation.ok) throw new Error(`Cancellation setup gate failed: ${setupValidation.issues.join('; ')}`);
  if (firstBatchIds.length !== 25 || new Set(firstBatchIds).size !== 25) throw new Error('First completed provider batch must be exactly 25 distinct target IDs.');
  if (new Set(acceptedBefore).size !== 25 || firstBatchIds.some(id => !acceptedBefore.includes(id))
      || acceptedBefore.some(id => !firstBatchIds.includes(id))) {
    throw new Error('Actual accepted DOM ownership before cancellation is not exactly the first physical batch.');
  }
  const preCancelDomValidation = validateDomState(beforeCancel, firstBatchIds, 'before-cancel');
  trial.cancellation.preCancelDomValidation = preCancelDomValidation;
  if (!preCancelDomValidation.ok) throw new Error(preCancelDomValidation.issues.join('; '));

  let stopEmission = null;
  let postRetirementDom;
  if (cancellationProbe === 'restore') {
    const liveContent = await contentSnapshot(sessionIdA);
    const liveWorker = await workerSnapshot(sessionIdA);
    const liveRoot = liveWorker.providerRoots.find(root => root.messageId === heldA.batchMessageId);
    const liveController = liveWorker.controllers.find(controller => controller.messageId === heldA.batchMessageId);
    const trustedStart = liveContent.operations.find(operation => operation.kind === 'lifecycle.delivery'
      && operation.sessionId === sessionIdA && operation.action === 'page-translate-start'
      && operation.accepted === true);
    const activeRestoreValidation = validateActiveReplacementCheckpoint({
      sessionId: sessionIdA,
      activeManagerSessionId: liveContent.activeManagerSessionId,
      capturedSessionActive: liveContent.capturedSessionActive,
      currentBridgeOwnsSession: liveContent.currentBridgeOwnsSession,
      schedulerSessionContextOwned: liveContent.schedulerSessionContextOwned,
      trustedStart,
      providerRoot: liveRoot,
      controller: liveController,
    });
    const liveRestoreDOM = await snapshotDom('before-active-restore');
    trial.cancellation.restorePrecondition = {
      content: liveContent,
      worker: liveWorker,
      heldProviderRoot: liveRoot,
      heldController: liveController,
      trustedCoordinatorStart: trustedStart ?? null,
      ownershipValidation: activeRestoreValidation,
      dom: liveRestoreDOM,
    };
    if (!activeRestoreValidation.ok || liveContent.discoveryCancelled !== false) {
      throw new Error('B Restore precondition failed: A must still be the active trusted owner with its held provider/controller pending.');
    }
    const liveDOMValidation = validateDomState(liveRestoreDOM, firstBatchIds, 'before-active-restore');
    if (!liveDOMValidation.ok) throw new Error(liveDOMValidation.issues.join('; '));
    const restoreResponse = await sendCommand('page-restore');
    if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE while A active', restoreResponse));
    trial.cancellation.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdA)).found;
    const restored = await snapshotDom('after-restore');
    trial.rawDOM.translated = liveRestoreDOM.dom;
    trial.rawDOM.restored = restored.dom;
    postRetirementDom = restored;
    const restoredValidation = validateDomState(restored, [], 'after-restore', { restored: true });
    trial.cancellation.restoreDomValidation = restoredValidation;
    if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
  } else {
    const stopResponse = await sendCommand('page-translate-stop-auto');
    if (!stopResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE_STOP_AUTO', stopResponse));
    const stopTerminal = await eventForSession('page-auto-restore-complete', sessionIdA);
    trial.cancellation.stopTerminal = stopTerminal.found;
    const contentAfterStop = await contentSnapshot(sessionIdA);
    trial.cancellation.stopSnapshot = contentAfterStop;
    stopEmission = contentAfterStop.operations.filter(operation => operation.kind === 'lifecycle.emission'
      && operation.sessionId === sessionIdA && operation.action === 'page-auto-restore-complete').at(-1);
    if (!stopEmission) throw new Error('Stop did not emit a session-matched PAGE_AUTO_RESTORE_COMPLETE lifecycle.');
    const postStop = await snapshotDom('after-stop');
    const postStopValidation = validateDomState(postStop, firstBatchIds, 'after-stop');
    trial.cancellation.postStopDomValidation = postStopValidation;
    if (!postStopValidation.ok) throw new Error(postStopValidation.issues.join('; '));
    postRetirementDom = postStop;
    trial.rawDOM.translated = postStop.dom;
  }
  const invalidation = await until(async () => {
    const state = await contentSnapshot(sessionIdA);
    const event = state.operations.filter(operation => operation.kind === 'session.invalidation'
      && operation.sessionId === sessionIdA && operation.capturedSessionActive === false
      && operation.discoveryCancelled === true).at(-1);
    return event ? { event, state } : null;
  }, 15_000);
  trial.cancellation.invalidationBoundary = invalidation.event;
  const invalidationSequence = invalidation.event.sequence;

  let sessionIdB = null;
  let heldB = null;
  let workerAtBStart = null;
  if (cancellationProbe === 'replacement') {
    cancellationControl.replacementSessionId = null;
    const replacementResponse = await sendCommand('page-translate', {
      provider: 'edge', targetLanguage: 'fr', isAuto: true, preserveAcceptedTranslations: true,
    });
    if (!replacementResponse?.success) throw new Error(formatCommandFailure('PAGE_TRANSLATE replacement', replacementResponse));
    sessionIdB = sessionIdFromStart(replacementResponse);
    if (!sessionIdB || sessionIdB === sessionIdA) throw new Error('Replacement session must have a real, distinct B session ID.');
    cancellationControl.replacementSessionId = sessionIdB;
    trial.cancellation.sessionB = sessionIdB;
    await eventForSession('page-translate-start', sessionIdB);
    const managerEvents = await evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.events.filter(event=>event.name==="manager.translatePage.entry")', contentContext, false);
    const replacementCall = managerEvents.at(-1);
    if (replacementCall?.isAuto !== true) throw new Error('Replacement B was not observed entering translatePage as isAuto=true.');
    const managerCallB = await until(async () => evaluate(chrome, pageSession,
      'window.__pageTranslationBenchmark.calls.find(call=>call.messageId===' + JSON.stringify(sessionIdB) + ')??null', contentContext, false), 15_000);
    const effectiveSettingsB = validateEffectiveSettings(managerCallB.settings, {
      targetLanguage: 'fr', lazyLoading: false, translateAfterScrollStop: false, autoTranslateOnDOMChanges: false,
    });
    trial.cancellation.effectiveSettingsB = { observed: managerCallB.settings, validation: effectiveSettingsB };
    if (!effectiveSettingsB.ok) throw new Error(`Replacement B changed effective fixture settings: ${effectiveSettingsB.issues.join('; ')}`);
    heldB = await waitHeldForSession(sessionIdB);
    const heldBRequestsBeforeRelease = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB && !item.record.released);
    const singleHeldBValidation = validateSingleHeldRequest(heldBRequestsBeforeRelease.map(item => item.record), sessionIdB);
    trial.cancellation.singleHeldBValidation = singleHeldBValidation;
    if (!singleHeldBValidation.ok) throw new Error(singleHeldBValidation.issues.join('; '));
    workerAtBStart = await workerSnapshot(sessionIdA);
    trial.cancellation.workerAtBStart = workerAtBStart;
    const trustedBStart = (await contentSnapshot(sessionIdB)).operations.find(operation => operation.kind === 'lifecycle.delivery'
      && operation.sessionId === sessionIdB && operation.action === 'page-translate-start' && operation.accepted === true);
    if (!trustedBStart) throw new Error('Main-frame coordinator did not positively accept B PAGE_TRANSLATE_START ownership.');
    trial.cancellation.trustedBStart = trustedBStart;
    const bFirstBatch = cancellationControl.firstBatchBySession.get(sessionIdB);
    if (!bFirstBatch) throw new Error('Replacement B did not issue a mapped real provider request.');
    if (heldB.controllerAbortedAtPause !== false || heldB.providerRootStatusAtPause !== 'pending') {
      throw new Error('Replacement B held provider request was not active and pending before A release.');
    }
    if (heldB.targetIds.some(id => firstBatchIds.includes(id))) {
      throw new Error('Replacement B first physical request unexpectedly re-enqueued A-retained targets.');
    }
    trial.cancellation.replacementFirstBatch = { messageId: bFirstBatch.messageId, targetIds: heldB.targetIds, heldRequest: heldB };
  }

  // Real cancellation request from the scheduler is asynchronous; release only after command/restore/B state is observed.
  if (cancellationProbe === 'replacement') {
    const currentBContent = await contentSnapshot(sessionIdB);
    const currentBWorker = await workerSnapshot(sessionIdB);
    const currentBRoot = currentBWorker.providerRoots.find(root => root.messageId === heldB.batchMessageId);
    const currentBController = currentBWorker.controllers.find(controller => controller.messageId === heldB.batchMessageId);
    const currentBTrustedStart = trial.cancellation.trustedBStart;
    const activeBValidation = validateActiveReplacementCheckpoint({
      sessionId: sessionIdB,
      activeManagerSessionId: currentBContent.activeManagerSessionId,
      capturedSessionActive: currentBContent.capturedSessionActive,
      currentBridgeOwnsSession: currentBContent.currentBridgeOwnsSession,
      schedulerSessionContextOwned: currentBContent.schedulerSessionContextOwned,
      trustedStart: currentBTrustedStart,
      providerRoot: currentBRoot,
      controller: currentBController,
    });
    const currentBCheckpoint = {
      content: currentBContent,
      worker: currentBWorker,
      providerRoot: currentBRoot,
      controller: currentBController,
      trustedStart: currentBTrustedStart,
      validation: activeBValidation,
    };
    const currentBDOM = await snapshotDom('replacement-B-active-before-A-release');
    const currentBAcceptedIds = currentBContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
      && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
    const currentBDOMValidation = validateDomState(currentBDOM, [...new Set([...firstBatchIds, ...currentBAcceptedIds])], 'replacement-B-active-before-A-release');
    currentBCheckpoint.dom = currentBDOM;
    currentBCheckpoint.acceptedIds = currentBAcceptedIds;
    currentBCheckpoint.domValidation = currentBDOMValidation;
    trial.cancellation.bActiveAtARelease = currentBCheckpoint;
    if (!activeBValidation.ok || !currentBDOMValidation.ok) {
      throw new Error('B replacement ownership/provider request was not active at A release.');
    }
  }
  cancellationControl.releaseAllA = true;
  const heldARequests = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdA).map(item => item.record);
  const singleHeldAValidation = validateSingleHeldRequest(heldARequests, sessionIdA);
  trial.cancellation.singleHeldAValidation = singleHeldAValidation;
  if (!singleHeldAValidation.ok) throw new Error(singleHeldAValidation.issues.join('; '));
  for (const held of heldARequests) await releaseHeld(held, 'fulfill');

  const quiescentA = await until(async () => {
    const content = await contentSnapshot(sessionIdA);
    const worker = await workerSnapshot(sessionIdA);
    const roots = worker.providerRoots ?? [];
    const physical = worker.ledger.operations.filter(operation => operation.kind === 'provider.physical');
    const allPausedSettled = heldARequests.every(request => request.handlerSettled && !!request.releaseOutcome);
    const state = {
      content, worker,
      providerRootSettled: roots.length > 0 && roots.every(operation => operation.status !== 'pending'),
      physicalSettled: physical.length > 0 && physical.every(operation => operation.status !== 'pending'),
      allPausedSettled,
    };
    if (content.capturedSessionActive !== false || content.discoveryCancelled !== true
        || content.pendingOperations !== 0 || worker.ledger.pending !== 0
        || !state.providerRootSettled || !state.physicalSettled || !allPausedSettled) return null;
    return state;
  }, 45_000);
  const contentAfterQuiescence = await contentSnapshot(sessionIdA);
  if (contentAfterQuiescence.mutationSnapshot?.duplicateAcceptedIds?.length) {
    throw new Error(`Duplicate accepted DOM writes were observed before A quiescence: ${contentAfterQuiescence.mutationSnapshot.duplicateAcceptedIds.join(',')}`);
  }
  const heldRoot = quiescentA.worker.providerRoots.find(rootCall => rootCall.messageId === heldA.batchMessageId);
  const heldController = quiescentA.worker.controllers.find(controller => controller.messageId === heldA.batchMessageId);
  const cancelServiceCall = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'service.cancelRequest'
    && operation.messageId === heldA.batchMessageId);
  const heldPhysical = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'provider.physical'
    && operation.messageId === heldA.batchMessageId && operation.sessionId === sessionIdA);
  const heldRootSettled = heldRoot && heldRoot.status !== 'pending';
  const controllerAbort = quiescentA.worker.ledger.operations.find(operation => operation.kind === 'controller.abort'
    && operation.messageId === heldA.batchMessageId && operation.sessionId === sessionIdA);
  const matchedCancellation = validateMatchedCancellation({
    sessionId: sessionIdA, messageId: heldA.batchMessageId,
    serviceCall: cancelServiceCall, abortEvent: controllerAbort, controller: heldController,
  });
  const cancelTargetMatched = matchedCancellation.ok;
  const abortAfterCancelBegin = Number.isInteger(controllerAbort?.sequence)
    && Number.isInteger(cancelServiceCall?.sequence) && controllerAbort.sequence > cancelServiceCall.sequence;
  const heldFetchClassifications = heldARequests.map(request => {
    const classification = classifyHeldFetchRelease({
      heldRequestId: request.requestId,
      matchedRequestId: request.requestId,
      releaseOutcome: request.releaseOutcome,
      networkCanceled: request.networkCanceled,
      controllerAborted: heldController?.aborted === true && controllerAbort?.sequence > cancelServiceCall?.sequence,
      cancelTargetMatched: cancelTargetMatched && abortAfterCancelBegin,
      providerRootStatus: heldRoot?.status,
      physicalStatus: heldPhysical?.status,
      physicalControllerAborted: heldPhysical?.controllerAbortedAtEnd,
      controllerAbortSequence: controllerAbort?.sequence,
      providerRootSettledSequence: heldRoot?.settledSequence,
      physicalSettledSequence: heldPhysical?.settledSequence,
    });
    request.releaseClassification = classification;
    const heldControl = cancellationControl.heldRequests.find(item => item.record === request);
    heldControl?.reservation.classifyRelease(classification);
    return classification;
  });
  const postAbortInterceptionError = heldARequests.every((request, index) => request.handlerSettled && heldFetchClassifications[index]?.ok);
  const cancelAck = contentAfterQuiescence.operations.some(operation => operation.kind === 'runtime.cancel.send'
    && operation.sessionId === sessionIdA && operation.status === 'fulfilled'
    && operation.response?.success === true);
  const quiescenceValidation = validateCancellationQuiescence({
    sessionId: sessionIdA,
    capturedSessionActive: quiescentA.content.capturedSessionActive,
    discoveryCancelled: quiescentA.content.discoveryCancelled,
    controllerAborted: heldController?.aborted === true,
    pendingOperations: quiescentA.content.pendingOperations + quiescentA.worker.ledger.pending,
    heldRequestReleased: postAbortInterceptionError,
    providerRootSettled: heldRootSettled && heldPhysical?.status !== 'pending',
    cancelAcknowledged: cancelAck && cancelServiceCall?.status === 'fulfilled'
      && cancelTargetMatched && abortAfterCancelBegin,
    cancelTargetSessionId: cancelServiceCall?.sessionId,
  });
  trial.cancellation.quiescence = {
    worker: quiescentA.worker,
    content: quiescentA.content,
    heldRequestReleaseOutcomes: heldARequests.map(request => ({ requestId: request.requestId, networkId: request.networkId, ...request.releaseOutcome })),
    matchedProviderRoot: heldRoot,
    matchedPhysicalRequest: heldPhysical,
    matchedAbortEvent: controllerAbort,
    abortAfterCancelBegin,
    matchedController: heldController,
    matchedServiceCancel: cancelServiceCall,
    matchedCancellationValidation: matchedCancellation,
    postAbortFetchClassification: heldARequests.map(request => ({
      requestId: request.requestId, networkId: request.networkId,
      releaseOutcome: request.releaseOutcome, networkCanceled: request.networkCanceled,
      ...request.releaseClassification,
    })),
    validation: quiescenceValidation,
  };
  trial.cancellation.lifecycleProof = contentAfterQuiescence.operations.filter(operation => operation.kind.startsWith('lifecycle.'));
  trial.cancellation.rootPromiseSettlements = quiescentA.worker.ledger.operations.filter(operation => ['provider.root', 'provider.physical'].includes(operation.kind));
  trial.cancellation.networkProof = heldARequests.map(request => ({
    requestId: request.requestId, networkId: request.networkId,
    releaseOutcome: request.releaseOutcome,
    events: trial.cancellation.networkEvents.filter(event => event.sessionId === request.sessionId
      && event.targetId === request.targetId && event.params?.requestId === request.networkId),
  }));
  if (!quiescenceValidation.ok) throw new Error(`Cancellation quiescence gate failed: ${quiescenceValidation.issues.join('; ')}`);

  const contentAfterAReleaseAll = await contentSnapshot(undefined);
  const acceptedBAtARelease = contentAfterAReleaseAll?.operations
    .filter(operation => operation.kind === 'scheduler.settlement' && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true)
    .map(operation => operation.id) ?? [];
  const afterRelease = await snapshotDom('after-A-release');
  const retainedAfterRelease = cancellationProbe === 'restore' ? []
    : cancellationProbe === 'replacement' ? [...new Set([...firstBatchIds, ...acceptedBAtARelease])]
      : firstBatchIds;
  const afterReleaseValidation = validateDomState(afterRelease, retainedAfterRelease, 'after-A-release');
  trial.cancellation.afterReleaseDomValidation = afterReleaseValidation;
  if (cancellationProbe === 'replacement') trial.cancellation.bAcceptedAtARelease = acceptedBAtARelease;
  if (!afterReleaseValidation.ok) throw new Error(afterReleaseValidation.issues.join('; '));
  const settledAEvents = contentAfterAReleaseAll.operations.filter(operation => operation.sessionId === sessionIdA);
  const acceptedAfterStop = settledAEvents.filter(operation => operation.kind === 'scheduler.settlement'
    && operation.outcome === 'accepted' && operation.changed === true && operation.sequence > invalidationSequence);
  const invalidationEvidence = validatePostInvalidationEvidence({
    sessionId: sessionIdA,
    invalidationSequence,
    operations: contentAfterAReleaseAll.operations,
    duplicateAcceptedIds: contentAfterAReleaseAll.mutationSnapshot?.duplicateAcceptedIds ?? [],
    allowedMutationOwners: cancellationProbe === 'replacement' ? [sessionIdB] : [],
  });
  const emissionsAfterStop = settledAEvents.filter(operation => operation.kind === 'lifecycle.emission'
    && operation.sequence > invalidationSequence
    && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action));
  trial.cancellation.acceptedWriteProof = {
    beforeStopAcceptedIds: acceptedBefore,
    afterStopAcceptedSettlementIds: acceptedAfterStop.map(operation => operation.id),
    invalidationSequence,
    invalidationEvidence,
    observedDuplicateAcceptedIds: contentAfterAReleaseAll.mutationSnapshot?.duplicateAcceptedIds ?? [],
    postStopAProgressOrCompletionEmissions: emissionsAfterStop,
    noNewAcceptedWrites: invalidationEvidence.ok && acceptedAfterStop.length === 0 && emissionsAfterStop.length === 0
      && (cancellationProbe === 'replacement' || JSON.stringify(afterRelease.dom) === JSON.stringify(postRetirementDom.dom)),
  };
  if (!trial.cancellation.acceptedWriteProof.noNewAcceptedWrites) throw new Error('Retired A produced a post-invalidation write/emission, unattributed mutation or duplicate accepted write.');

  if (cancellationProbe === 'replacement') {
    const aRoot = workerAtBStart?.providerRoots?.find(rootCall => rootCall.messageId === heldA.batchMessageId);
    trial.cancellation.cancellationClassification = aRoot?.status === 'pending'
      ? 'A provider root remained pending at B start and settled after A release; overlapping ownership was observed.'
      : 'A provider root settled before B remained active; this proves restart isolation, not a stale successful result competing with B.';
    const deliveries = contentAfterQuiescence.operations.filter(operation => operation.kind === 'lifecycle.delivery'
      && operation.sessionId === sessionIdA && operation.sequence > 0);
    const bStartSequence = trial.cancellation.trustedBStart?.sequence;
    const lateDeliveryIssues = deliveries.filter(operation => operation.sequence > (bStartSequence ?? Number.MAX_SAFE_INTEGER)
      && ['page-translate-progress', 'page-translate-complete', 'page-translate-idle'].includes(operation.action)
      && (operation.accepted !== false || operation.result?.reason !== 'stale-session'));
    trial.cancellation.lateADeliveryProof = { bStartSequence: bStartSequence ?? null, deliveriesAfterBStart: deliveries.filter(operation => operation.sequence > (bStartSequence ?? Number.MAX_SAFE_INTEGER)), issues: lateDeliveryIssues };
    if (lateDeliveryIssues.length) throw new Error('Main-frame coordinator accepted a late A lifecycle event after B ownership began.');

    cancellationControl.releaseReplacement = true;
    const heldBRequests = cancellationControl.heldRequests.filter(item => item.pageSessionId === sessionIdB).map(item => item.record);
    for (const held of heldBRequests) await releaseHeld(held, 'fulfill');
    const terminalB = await eventForSession('page-translate-complete', sessionIdB);
    trial.cancellation.terminalB = terminalB.found;
    const translatedB = await snapshotDom('after-B-complete');
    trial.rawDOM.translated = translatedB.dom;
    const translatedValidation = validateDomState(translatedB, expectedIds, 'after-B-complete');
    if (!translatedValidation.ok) throw new Error(translatedValidation.issues.join('; '));
    const allContent = await contentSnapshot(undefined);
    const acceptedAIds = allContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
      && operation.sessionId === sessionIdA && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
    const acceptedBIds = allContent.operations.filter(operation => operation.kind === 'scheduler.settlement'
      && operation.sessionId === sessionIdB && operation.outcome === 'accepted' && operation.changed === true).map(operation => operation.id);
    const finalDuplicateAcceptedIds = allContent.mutationSnapshot?.duplicateAcceptedIds ?? [];
    trial.cancellation.finalDuplicateAcceptedIds = finalDuplicateAcceptedIds;
    if (finalDuplicateAcceptedIds.length) throw new Error(`Duplicate accepted DOM writes were observed: ${finalDuplicateAcceptedIds.join(',')}`);
    const ownershipValidation = validateReplacementOwnership({
      acceptedAIds, acceptedBIds, finalTranslatedIds: translatedB.translatedIds, expectedIds,
    });
    trial.cancellation.replacementOwnership = { acceptedAIds, acceptedBIds, finalTranslatedIds: translatedB.translatedIds, validation: ownershipValidation };
    if (!ownershipValidation.ok) throw new Error(`Replacement ownership gate failed: ${ownershipValidation.issues.join('; ')}`);
    const restoreResponse = await sendCommand('page-restore');
    if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE after replacement', restoreResponse));
    trial.cancellation.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdB)).found;
    const restored = await snapshotDom('after-B-restore');
    trial.rawDOM.restored = restored.dom;
    const restoredValidation = validateDomState(restored, [], 'after-B-restore', { restored: true });
    if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
  }

  const stopOnlyAfterRelease = cancellationProbe === 'stop'
    ? await snapshotDom('stop-only-before-harness-cleanup')
    : null;
  if (cancellationProbe === 'stop') {
    trial.rawDOM.translated = postRetirementDom.dom;
    const status = validateDomState(stopOnlyAfterRelease, firstBatchIds, 'stop-only-before-harness-cleanup');
    if (!status.ok) throw new Error(status.issues.join('; '));
  }
  if (!trial.rawDOM.translated) trial.rawDOM.translated = postRetirementDom.dom;
  if (cancellationProbe === 'stop') {
    const restoreResponse = await sendCommand('page-restore');
    if (!restoreResponse?.success) throw new Error(formatCommandFailure('PAGE_RESTORE cleanup', restoreResponse));
    trial.cancellation.cleanup.restoreTerminal = (await eventForSession('page-restore-complete', sessionIdA)).found;
    const restored = await snapshotDom('cleanup-restored');
    trial.rawDOM.restored = restored.dom;
    const restoredValidation = validateDomState(restored, [], 'cleanup-restored', { restored: true });
    if (!restoredValidation.ok) throw new Error(restoredValidation.issues.join('; '));
  }
  trial.measurementStopAttempted = true;
  const contentTrace = await evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.stopMeasurement()', contentContext);
  measurementState.stopped = true;
  measurementState.stopAttempts++;
  trial.measurements = { content: contentTrace };
  trial.timestamps.measurementStopped = now();
  if (!contentTrace?.available) throw new Error(`Cancellation measurement stop failed: ${contentTrace?.reason ?? 'observer snapshot unavailable'}`);
  trial.rawDOM.original = originals;
  trial.derivedTimings = deriveTimings(trial, null, contentTrace, []);
  trial.providerTranslationAttempts = trial.requests.filter(request => request.category === 'provider-translation').length;
  trial.providerBatchSizes = trial.requests.filter(request => request.category === 'provider-translation').map(request => request.batchSize);
  trial.cancellation.cleanup.pendingHeldFetches = cancellationControl.heldRequests.filter(item => !item.record.handlerSettled).length;
  if (trial.cancellation.cleanup.pendingHeldFetches) throw new Error('Cancellation probe ended with a held Fetch request unsettled.');
  if (trial.requests.some(request => request.category === 'blocked')) throw new Error('Unexpected external request blocked during cancellation probe.');
  trial.status = 'passed';
  return trial;

}

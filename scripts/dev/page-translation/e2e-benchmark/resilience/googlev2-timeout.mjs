import { claimGoogleTimeoutRequest, commitGoogleTimeoutRequest, findGoogleTimeoutBatchError, findGoogleTimeoutCancelMessage, findGoogleTimeoutControllerAbort, GOOGLE_TIMEOUT_OBSERVATION_TIMEOUT_MS, requireGoogleTimeoutReservation, selectResolvedGoogleTimeoutBatch, validateGoogleTimeoutEvidence } from '../resilience-probes.mjs';
export function createGoogleV2TimeoutProtocol() {
  return { armed: false, claimed: false, held: null, selectionFailures: [], releaseRequested: false };
}

export function armGoogleV2Timeout(protocol) {
  protocol.armed = true;
}

export function recordGoogleTimeoutFailedTargetDOM(protocol, evidence) {
  protocol.failedTargetDOM = evidence;
}

export async function executeGoogleV2Timeout({ googleTimeoutProtocol, classification, event, requestRecord, requestId, body, fixtureConfig, sessionId, providerNetworkEvents, resilienceEvidence, chrome, workerSession, pageSession, contentContext, evaluate, captureRequestViewport, until, now, reservation, classifyHeldFetchRelease, sameProviderTexts }) {
if (googleTimeoutProtocol && classification.provider === 'googlev2') {
  const networkId = event.params.networkId ?? null;
  const resources = sessionId ? await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.resourceSnapshot([],[${JSON.stringify(sessionId)}])`, undefined, false) : null;
  const resolver = resources?.sourceResolvers?.[sessionId];
  const roots = await evaluate(chrome, workerSession,
    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
  const logicalRoots = (roots?.providerRoots ?? []).filter(root => root.sessionId === sessionId
    && sameProviderTexts(root.texts, body));
  const uniqueRoots = [...new Map(logicalRoots.map(root => [root.messageId, root])).values()];
  const root = uniqueRoots.length === 1 ? uniqueRoots[0] : null;
  const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const selection = selectResolvedGoogleTimeoutBatch({
    request: { networkId, sessionId, sourceLanguage: requestRecord.sourceLanguageQuery, texts: body, targetIds },
    classification, resolver, roots: roots?.providerRoots ?? [],
    failedCount: googleTimeoutProtocol.held || googleTimeoutProtocol.claimed ? 1 : 0, armed: googleTimeoutProtocol.armed,
  });
  const physical = providerNetworkEvents.get(`${event.sessionId}:${networkId}`);
  requestRecord.googleTimeoutCorrelation = {
    networkId, sessionId, messageId: root?.messageId ?? null,
    targetIds, texts: body, source: resolver?.effectiveSourceLanguage ?? null,
    target: resolver?.effectiveTargetLanguage ?? null, selection,
  };
  const attempt = {
    attemptId: requestRecord.physicalAttemptId ?? `googlev2-timeout-${resilienceEvidence.attempts.length + 1}`,
    networkId, networkSessionId: event.sessionId, pageSessionId: sessionId,
    logicalMessageId: root?.messageId ?? null, targetIds, texts: body,
    status: null, outcome: null, selected: selection.selected,
  };
  resilienceEvidence.attempts.push(attempt);
  if (selection.selected) {
    if (!claimGoogleTimeoutRequest(googleTimeoutProtocol)) {
      throw new Error('A Google timeout Fetch request was already claimed or held.');
    }
    if (!root || !requireGoogleTimeoutReservation(reservation).hold()) {
      throw new Error('Could not hold the uniquely correlated Google timeout Fetch request.');
    }
    const timeoutHold = {
      ...attempt,
      networkId, networkSessionId: event.sessionId, requestId,
      pageSessionId: sessionId, messageId: root.messageId, targetIds,
      texts: body, startedAt: requestRecord.startedAt,
      physicalStartedWallMs: physical?.wallTime ?? null,
      reservation, requestRecord,
    };
    if (!commitGoogleTimeoutRequest(googleTimeoutProtocol, timeoutHold)) {
      throw new Error('Could not commit the Google timeout Fetch request claim.');
    }
    await captureRequestViewport(body);
    requestRecord.heldFetch = { requestId, messageId: root.messageId, sessionId, handlerSettled: false };
    const cancellationDiagnostics = timeoutHold.cancellationDiagnostics = {
      startedAt: now(), workerSnapshot: null, contentSnapshot: null, lastObservedAt: null, samples: 0,
    };
    let cancellation;
    try {
      cancellation = await until(async () => {
        if (reservation.releaseRequested) return { teardown: true };
        const snapshot = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false);
        cancellationDiagnostics.workerSnapshot = snapshot ?? null;
        const operations = snapshot?.ledger?.operations ?? [];
        const content = await evaluate(chrome, pageSession,
          'window.__pageTranslationBenchmark.cancellationSnapshot()', contentContext, false);
        cancellationDiagnostics.contentSnapshot = content ?? null;
        cancellationDiagnostics.lastObservedAt = now();
        cancellationDiagnostics.samples++;
        const contentOperations = content?.operations ?? [];
        const controllerAbort = findGoogleTimeoutControllerAbort(operations, root.messageId, sessionId);
        const controllerState = snapshot?.controllers?.find(item => item.messageId === root.messageId);
        const timedOut = findGoogleTimeoutBatchError(contentOperations, sessionId, targetIds);
        const cancelMessage = findGoogleTimeoutCancelMessage(contentOperations, root.messageId, sessionId);
        const transportCancelMessages = contentOperations.filter(item => item.kind === 'runtime.cancel.send'
          && item.action === 'CANCEL_TRANSLATION' && item.messageId === root.messageId);
        if (!controllerAbort || controllerState?.aborted !== true || !timedOut || cancelMessage || transportCancelMessages.length) return null;
        return { snapshot, content, controllerAbort, controllerState, timedOut, transportCancelMessages };
      }, GOOGLE_TIMEOUT_OBSERVATION_TIMEOUT_MS);
    } catch (error) {
      cancellationDiagnostics.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
      cancellationDiagnostics.elapsedMs = now() - cancellationDiagnostics.startedAt;
      throw error;
    }
    if (cancellation.teardown) return true;
    timeoutHold.cancellation = {
      controllerAbort: cancellation.controllerAbort,
      controllerState: cancellation.controllerState,
      timedOut: cancellation.timedOut,
      transportCancelMessages: cancellation.transportCancelMessages,
    };
    timeoutHold.fetchRelease = await reservation.release('fail', { errorReason: 'Aborted', reason: 'background-timeout' });
    const settled = await until(async () => {
      const snapshot = await evaluate(chrome, workerSession,
        `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false);
      const ledger = snapshot?.ledger?.operations ?? [];
      const providerRoot = ledger.find(item => item.kind === 'provider.root' && item.messageId === root.messageId);
      const physicalMatches = ledger.filter(item => item.kind === 'provider.physical'
        && item.sessionId === sessionId && item.messageId === root.messageId
        && item.url === requestRecord.url && item.method === requestRecord.method
        && item.requestBody === requestRecord.postData);
      const physical = physicalMatches.length === 1 ? physicalMatches[0] : null;
      const controllerAbort = findGoogleTimeoutControllerAbort(ledger, root.messageId, sessionId);
      return providerRoot?.status === 'rejected' && physical?.status === 'rejected'
        && providerRoot?.operationAborted === true
        && physical?.controllerAbortedAtEnd === true
        && (physical?.operationAborted === true || physical?.abortReasonMatched === true)
        && controllerAbort && !ledger.some(item => item.kind === 'service.handleTimeout' && item.messageId === root.messageId)
        ? { providerRoot, physical, physicalMatchCount: physicalMatches.length, controllerAbort } : null;
    }, 10_000);
    timeoutHold.cancellation.providerRoot = settled.providerRoot;
    timeoutHold.cancellation.physical = settled.physical;
    timeoutHold.cancellation.controllerAbort = settled.controllerAbort;
    timeoutHold.cancellation.physicalMatchCount = settled.physicalMatchCount;
    const networkOutcome = providerNetworkEvents.get(`${event.sessionId}:${networkId}`);
    const releaseClassification = classifyHeldFetchRelease({
      heldRequestId: requestId, matchedRequestId: requestId,
      releaseOutcome: timeoutHold.fetchRelease,
      networkCanceled: networkOutcome?.outcome === 'failed' && /abort|cancel/i.test(networkOutcome?.error ?? ''),
      controllerAborted: settled.controllerAbort.abortedAfter === true && settled.controllerAbort.abortedBefore === false,
      cancelTargetMatched: settled.controllerAbort.messageId === root.messageId,
      providerRootStatus: settled.providerRoot.status, physicalStatus: settled.physical.status,
      physicalControllerAborted: settled.physical.controllerAbortedAtEnd,
      controllerAbortSequence: settled.controllerAbort.sequence,
      providerRootSettledSequence: settled.providerRoot.settledSequence,
      physicalSettledSequence: settled.physical.settledSequence,
    });
    timeoutHold.fetchReleaseClassification = releaseClassification;
    if (!timeoutHold.reservation.classifyRelease(releaseClassification)) {
      throw new Error(`Timed-out Fetch release could not be classified: ${releaseClassification.issues.join('; ')}`);
    }
    return true;
  }
  if (googleTimeoutProtocol.armed && resolver?.resolutionPending === false && resolver.effectiveSourceLanguage !== 'auto'
      && body.length === 25 && selection.reason !== 'not-first-google-physical-attempt') {
    googleTimeoutProtocol.selectionFailures.push({ networkId, reason: selection.reason, targetIds });
  }
}
  return false;
}

export async function collectGoogleV2TimeoutEvidence({ protocol, evidence, evaluate, chrome, workerSession, pageSession, contentContext, sessionId, traceEvents, workerTrace, validateGoogleTimeoutQueueEvidence, providerPhysicalAttempts, summarizePhysicalProviderAttempts, providerNetworkEvents, providerAttempts, validateRuntimeResources, fixtureConfig, acceptedIds, originals, restoredDOM, acceptedDomOrder, translated, duplicateAcceptedWriteIds, terminalReceivedAt, peakLogicalConcurrency, effectiveProviderLimiterCapacity }) {
  const googleTimeoutProtocol = protocol;
  const resilienceEvidence = evidence;
if (googleTimeoutProtocol) {
     const hold = googleTimeoutProtocol.held;
      if (!hold?.messageId || !hold.cancellation) throw new Error('Google timeout did not observe its typed background deadline and matching controller abort.');
     const terminalMessageIds = [hold.messageId];
     resilienceEvidence.terminalMessageIds = terminalMessageIds;
     const [resources, pageScheduler, contentDrain, workerDrain] = await Promise.all([
       evaluate(chrome, workerSession,
         `globalThis.__pageTranslationBenchmark.resourceSnapshot(${JSON.stringify(terminalMessageIds)}, [${JSON.stringify(sessionId)}])`, undefined, false),
       evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
       evaluate(chrome, pageSession,
         `window.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, contentContext, false),
       evaluate(chrome, workerSession,
         `globalThis.__pageTranslationBenchmark.cancellationSnapshot(${JSON.stringify(sessionId)})`, undefined, false),
     ]);
     const workerEvents = traceEvents(workerTrace);
     const queueAttemptEvidence = validateGoogleTimeoutQueueEvidence(workerEvents, { messageId: hold.messageId });
     const queueEvents = queueAttemptEvidence.observed.starts.concat(queueAttemptEvidence.observed.ends);
     const timeout = hold.cancellation.timedOut;
      const controller = { ...hold.cancellation.controllerAbort, ...hold.cancellation.controllerState };
     const physical = hold.cancellation.physical;
     const providerRoot = hold.cancellation.providerRoot;
     const failedTargetDOM = {
       ok: JSON.stringify(googleTimeoutProtocol.failedTargetDOM?.observed) === JSON.stringify(googleTimeoutProtocol.failedTargetDOM?.expected),
       expected: googleTimeoutProtocol.failedTargetDOM?.expected ?? null,
       observed: googleTimeoutProtocol.failedTargetDOM?.observed ?? null,
     };
     const failedIds = new Set(hold.targetIds);
      const acceptedWrites = acceptedDomOrder ?? [];
      const observedTranslations = translated ?? [];
      const successfulTranslations = observedTranslations.filter(([id]) => !failedIds.has(id));
     const expectedTranslated = fixtureConfig.targets.filter(target => !failedIds.has(target.id))
       .map(({ id, source }) => [id, `\u200efixture translation: ${source}`]);
     const physicalSummary = summarizePhysicalProviderAttempts(providerPhysicalAttempts.map(attempt => {
       const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
       return { ...attempt, startedAt: network?.startedAt ?? null, settledAt: network?.settledAt ?? null,
         status: network?.status ?? null, outcome: network?.outcome ?? null };
     }), { expectedTimeoutAbortAttemptId: hold.attemptId });
     for (const attempt of resilienceEvidence.attempts) {
       const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
       attempt.status = network?.status ?? null;
       attempt.outcome = network?.outcome ?? null;
     }
     resilienceEvidence.unnecessaryRetransmits = resilienceEvidence.attempts
       .filter(attempt => attempt.attemptId !== hold.attemptId
         && attempt.targetIds?.some(id => failedIds.has(id)));
     resilienceEvidence.siblingRequests = resilienceEvidence.attempts.filter(attempt => attempt.attemptId !== hold.attemptId);
     const resourceValidation = validateRuntimeResources(resources, { terminalMessageIds, sessionIds: [sessionId], final: true });
     const cleanupOk = resourceValidation.ok && contentDrain?.pendingOperations === 0
       && workerDrain?.ledger?.pending === 0 && !workerDrain?.providerRoots?.some(root => root.status === 'pending')
       && pageScheduler?.managerTranslating === false
       && pageScheduler.activeFlushes === 0 && pageScheduler.queueIds?.length === 0
       && pageScheduler.pendingSettlementCount === 0 && pageScheduler.batchTimerActive === false
       && pageScheduler.completionTimerActive === false;
      return {
        sessionId, selectionFailures: googleTimeoutProtocol.selectionFailures,
       heldRequest: {
         messageId: hold.messageId, sessionId: hold.pageSessionId, requestId: hold.requestId,
         networkSessionId: hold.networkSessionId, networkId: hold.networkId,
         targetIds: hold.targetIds, texts: hold.texts,
         url: hold.requestRecord.url, method: hold.requestRecord.method, requestBody: hold.requestRecord.postData,
         startedAt: hold.startedAt,
       },
        timeout, controllerAbort: hold.cancellation.controllerAbort, transportCancelMessages: hold.cancellation.transportCancelMessages,
        controller, providerRoot, physical,
       physicalMatchCount: hold.cancellation.physicalMatchCount,
       classification: {
         userFacingType: timeout.errorType, userFacingName: timeout.errorName,
          internalAbortType: providerRoot?.operationAborted === true
            ? 'OPERATION_ABORTED' : physical?.errorType ?? physical?.errorName ?? null,
         internalAbortName: physical?.errorName ?? null,
         userFacingErrorType: timeout.errorType,
       },
       queueEvents, queueAttemptEvidence,
       retries: workerEvents.filter(event => event.messageId === hold.messageId
         && event.name === 'queueManager.processItem.start' && event.attemptNumber > 1),
       failovers: providerAttempts.filter(request => request.networkId !== hold.networkId
         && JSON.stringify(request.batchTexts) === JSON.stringify(hold.texts)),
       concurrency: {
         peakPhysical: physicalSummary.peakPhysicalConcurrency,
          peakLogical: peakLogicalConcurrency ?? null,
          effectiveProviderLimiterCapacity: effectiveProviderLimiterCapacity ?? null,
       },
       failedTargetDOM,
       resources, pageScheduler,
       translation: {
         exact: JSON.stringify(successfulTranslations) === JSON.stringify(expectedTranslated),
         targetCount: originals.length, acceptedTargetCount: acceptedIds.length, failedTargetCount: failedIds.size,
         acceptedWriteCount: acceptedWrites.length, acceptedUniqueCount: new Set(acceptedWrites).size,
         acceptedWriteIds: acceptedWrites,
         expectedTargetIds: originals.map(([id]) => id),
          duplicateAcceptedIds: duplicateAcceptedWriteIds ?? [],
         failedTargetsUnmarked: failedTargetDOM.ok,
         failedSourcePreserved: failedTargetDOM.ok,
          restoreExact: JSON.stringify(restoredDOM) === JSON.stringify(originals),
          terminal: !!terminalReceivedAt, sessionOwner: sessionId,
       },
       cleanup: {
         ok: cleanupOk, heldFetchSettled: false, handlersDrained: false,
         contentDrain, workerDrain, resourceValidation,
       },
     };
    }
    return null;

}

export function validateGoogleV2TimeoutEvidence(evidence) {
  return validateGoogleTimeoutEvidence(evidence);
}

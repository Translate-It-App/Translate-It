import { selectResolvedGeminiAttempt, validateGeminiStructuredRecovery } from '../resilience-probes.mjs';
import { GEMINI_FIXTURE_KEY } from '../gemini-fixture.mjs';

export function createGeminiStructuredRecoveryEvidence() {
  return { injectedMalformed: [], recovery: [], attempts: [] };
}

export async function executeGeminiStructuredRecovery({
  event, request, requestRecord, classification, body, fixtureConfig, sessionId, evidence,
  chrome, workerSession, evaluate, mapMalformedGeminiResponse,
}) {
  const resources = sessionId ? await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false) : null;
  const roots = await evaluate(chrome, workerSession,
    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
  const resolver = resources?.sourceResolvers?.[sessionId];
  const selected = selectResolvedGeminiAttempt({
    request: { networkId: event.params.networkId ?? null, sessionId, texts: body },
    classification, resolver, roots: roots?.providerRoots ?? [], failedCount: evidence.injectedMalformed.length,
  });
  const matchingRoots = (roots?.providerRoots ?? []).filter(item => item.sessionId === sessionId
    && JSON.stringify(item.texts) === JSON.stringify(body));
  const root = matchingRoots.length === 1 ? matchingRoots[0] : null;
  const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const attempt = {
    attemptId: `gemini-structured-${evidence.attempts.length + 1}`,
    networkId: event.params.networkId ?? null, sessionId,
    messageId: root?.messageId ?? null, texts: body, targetIds,
    keyIdentity: (() => { try { return new URL(request.url).searchParams.get('key') === GEMINI_FIXTURE_KEY ? 'synthetic-fixture' : 'unexpected'; } catch { return 'unexpected'; } })(),
    selection: selected, source: resolver?.effectiveSourceLanguage ?? null,
    target: resolver?.effectiveTargetLanguage ?? null,
  };
  evidence.attempts.push(attempt);
  requestRecord.geminiStructuredRecovery = attempt;
  if (selected.selected) {
    if (evidence.injectedMalformed.length) throw new Error('Gemini structured-recovery probe selected more than one malformed primary.');
    const malformed = { ...attempt, httpStatus: 200, jsonValid: false, envelopeValid: true };
    evidence.injectedMalformed.push(malformed);
    requestRecord.geminiMalformedPrimary = malformed;
    requestRecord.canonicalSourceExcluded = true;
    return mapMalformedGeminiResponse();
  }
  if (evidence.injectedMalformed.length
      && attempt.messageId === evidence.injectedMalformed[0].messageId
      && JSON.stringify(targetIds) === JSON.stringify(evidence.injectedMalformed[0].targetIds)) {
    attempt.retryOf = evidence.injectedMalformed[0].attemptId;
    evidence.recovery.push({ ...attempt, valid: true });
  }
  return null;
}

export function collectGeminiStructuredRecoveryEvidence({ evidence, failed, workerTrace, traceEvents, providerAttempts, providerNetworkEvents, sessionId, isMappedGeminiResponse, providerPhysicalAttempts, summarizePhysicalProviderAttempts, validateGeminiQueueAttemptEvidence, peakLogicalConcurrency, effectiveProviderLimiterCapacity }) {
  const resilienceEvidence = evidence;
        const workerEvents = traceEvents(workerTrace);
       const affectedMessageId = failed?.messageId;
       resilienceEvidence.queueAttemptEvidence = validateGeminiQueueAttemptEvidence(workerEvents, { messageId: affectedMessageId });
       resilienceEvidence.executionCalls = workerEvents
         .filter(event => event.name === 'providerRequestEngine.executeApiCall.start'
           && event.sessionId === sessionId && event.messageId === affectedMessageId)
         .map(({ callPurpose, messageId, sessionId: callSessionId, texts }) => ({
           callPurpose, messageId, sessionId: callSessionId, texts,
         }));
       resilienceEvidence.structuredRecoveryEntries = workerEvents
         .filter(event => event.name === 'baseAIProvider.translateBatch.entry'
           && event.callPurpose === 'STRUCTURED_RECOVERY' && event.messageId === affectedMessageId
           && event.sessionId === sessionId)
         .map(({ callPurpose, fullParseRecoveryRetry, messageId, sessionId: callSessionId, texts }) => ({
           callPurpose, fullParseRecoveryRetry, messageId, sessionId: callSessionId, texts,
         }));
       const matchingRequests = providerAttempts.filter(item => JSON.stringify(item.batchTexts) === JSON.stringify(failed?.texts));
       const malformedRequest = matchingRequests.find(item => item.geminiMalformedPrimary);
       const recoveryRequest = matchingRequests.find(item => item !== malformedRequest
         && item.geminiStructuredRecovery && item.geminiStructuredRecovery.selection.selected === false);
       const affectedRootRequests = providerAttempts.filter(item =>
         item.geminiStructuredRecovery?.messageId === affectedMessageId);
       const describePhysical = (requestRecord, role) => {
         const network = providerNetworkEvents.get(`${requestRecord.targetSessionId}:${requestRecord.networkId}`);
         return {
           role, networkId: requestRecord.networkId ?? null, messageId: affectedMessageId,
           sessionId: requestRecord.geminiStructuredRecovery?.sessionId ?? null,
           responseStatus: requestRecord.response?.status ?? null,
           networkStatus: network?.status ?? null, networkOutcome: network?.outcome ?? null,
           keyIdentity: requestRecord.geminiStructuredRecovery?.keyIdentity ?? 'unknown',
         };
       };
       if (malformedRequest) {
         failed.requestId = malformedRequest.networkId;
         failed.httpStatus = malformedRequest.response?.status ?? null;
         failed.envelopeValid = malformedRequest.response?.body?.candidates?.length === 1
           && malformedRequest.response.body.candidates[0]?.finishReason === 'STOP'
           && malformedRequest.response.body.candidates[0]?.content?.role === 'model';
       }
       if (recoveryRequest) {
         const purpose = resilienceEvidence.executionCalls.find(call => call.callPurpose === 'STRUCTURED_RECOVERY'
           && call.messageId === affectedMessageId);
         const network = providerNetworkEvents.get(`${recoveryRequest.targetSessionId}:${recoveryRequest.networkId}`);
         const outputValid = isMappedGeminiResponse(recoveryRequest.response?.body, {
           ids: recoveryRequest.batchIds ?? [], texts: failed.texts,
         });
         resilienceEvidence.recovery = purpose ? [{
           ...recoveryRequest.geminiStructuredRecovery,
           valid: recoveryRequest.response?.status === 200 && network?.status === 200
             && network?.outcome === 'finished' && outputValid,
           httpStatus: recoveryRequest.response?.status ?? null,
           networkStatus: network?.status ?? null, networkOutcome: network?.outcome ?? null,
           envelopeValid: outputValid, outputValid,
           messageId: purpose.messageId, sessionId: purpose.sessionId,
           texts: failed.texts, targetIds: failed.targetIds,
         }] : [];
       }
       resilienceEvidence.physicalAttempts = [
         ...(malformedRequest ? [describePhysical(malformedRequest, 'malformed-primary')] : []),
         ...(recoveryRequest ? [describePhysical(recoveryRequest, 'structured-recovery')] : []),
       ];
       const expectedPhysical = new Set([malformedRequest, recoveryRequest].filter(Boolean));
       const unexpectedPhysical = [...new Set([...affectedRootRequests, ...matchingRequests])]
         .filter(item => !expectedPhysical.has(item));
       resilienceEvidence.unexpectedPhysicalAttempts = unexpectedPhysical
         .map(item => describePhysical(item, 'unexpected'));
       resilienceEvidence.unexpectedRetransmits = matchingRequests.length === 2
         && affectedRootRequests.length === 2 ? [] : [...new Set([...affectedRootRequests, ...matchingRequests])].map(item =>
           describePhysical(item, expectedPhysical.has(item) ? 'unexpected-count' : 'unexpected'));
       resilienceEvidence.queueRetries = workerEvents.filter(event =>
         event.messageId === affectedMessageId && event.name === 'queueManager.processItem.start'
         && event.attemptNumber > 1);
       resilienceEvidence.keyFailovers = [...new Set([...affectedRootRequests, ...matchingRequests])]
         .filter(item => item.geminiStructuredRecovery?.keyIdentity !== 'synthetic-fixture'
           || !expectedPhysical.has(item))
         .map(item => describePhysical(item, 'key-failover-or-unexpected-attempt'));
       resilienceEvidence.parentRecoveries = resilienceEvidence.executionCalls.filter(call =>
         call.callPurpose === 'PARENT_RECOVERY');
       const physicalSummary = summarizePhysicalProviderAttempts(providerPhysicalAttempts.map(attempt => {
         const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
         return { ...attempt, startedAt: network?.startedAt ?? null, settledAt: network?.settledAt ?? null,
           status: network?.status ?? null, outcome: network?.outcome ?? null };
       }));
        resilienceEvidence.concurrency = {
          peakPhysical: physicalSummary.peakPhysicalConcurrency,
           peakLogical: peakLogicalConcurrency ?? null,
           effectiveProviderLimiterCapacity: effectiveProviderLimiterCapacity ?? null,
        };

}

export function validateGeminiStructuredRecoveryEvidence(evidence) {
  return validateGeminiStructuredRecovery(evidence);
}

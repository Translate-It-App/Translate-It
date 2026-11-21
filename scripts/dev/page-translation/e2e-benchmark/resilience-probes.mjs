export function parseResilienceProbeSelection(value) {
  if (!value) return [];
  const selections = value.split(',').map(item => item.trim()).filter(Boolean);
  if (selections.length !== 1 || !['googlev2-503', 'googlev2-timeout', 'custom-429', 'custom-400', 'custom-cancellation', 'gemini-structured-recovery'].includes(selections[0])) {
    throw new TypeError('BENCH_RESILIENCE_PROBES supports only googlev2-503, googlev2-timeout, custom-429, custom-400, custom-cancellation, or gemini-structured-recovery.');
  }
  return selections;
}

export function shouldEnableResilienceQueueProbe(probe) {
  return probe === 'googlev2-503' || probe === 'googlev2-timeout' || probe === 'custom-429' || probe === 'custom-400' || probe === 'custom-cancellation' || probe === 'gemini-structured-recovery';
}

export function resilienceReproductionCommand(probe) {
  const custom = probe === 'custom-429' || probe === 'custom-400' || probe === 'custom-cancellation';
  const provider = probe === 'gemini-structured-recovery' ? 'gemini' : custom ? 'custom' : 'googlev2';
  return `BENCH_RESILIENCE_PROBES=${probe} BENCH_LANE=provider BENCH_PROVIDER=${provider} BENCH_OPTIMIZATION_LEVEL=3 BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
}

export function validateResilienceProbeIsolation({ selected, probe, provider, optimizationLevel, modes, scenario, schedulingMode, competingProbe }) {
  if (!selected) return true;
  const custom = probe === 'custom-429' || probe === 'custom-400' || probe === 'custom-cancellation';
  const gemini = probe === 'gemini-structured-recovery';
  const selectedProvider = gemini ? 'gemini' : custom ? 'custom' : 'googlev2';
  if (competingProbe || provider !== selectedProvider || optimizationLevel !== 3
      || modes !== undefined && modes !== 'sliced'
      || scenario !== undefined && scenario !== 'scroll-through'
      || schedulingMode !== undefined && schedulingMode !== 'fluid') {
    throw new TypeError(`${gemini ? 'Gemini structured recovery' : custom ? 'Custom 429' : probe === 'googlev2-timeout' ? 'Google V2 timeout' : 'Google V2 503'} resilience probe requires an isolated ${gemini ? 'Gemini' : custom ? 'Custom' : 'Google V2'} Level 3 Sliced/scroll-through/Fluid run.`);
  }
  return true;
}

export function selectResolvedGeminiAttempt({ request, classification, resolver, failedCount, roots = [] }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'gemini'
      || failedCount !== 0 || !request?.networkId) return { selected: false, reason: 'not-first-gemini-physical-attempt' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  const matching = roots.filter(root => root.sessionId === request.sessionId
    && JSON.stringify(root.texts) === JSON.stringify(request.texts));
  if (matching.length !== 1) return { selected: false, reason: 'logical-batch-correlation-not-unique' };
  return { selected: true, source: resolver.effectiveSourceLanguage,
    target: resolver.effectiveTargetLanguage, messageId: matching[0].messageId };
}

export function validateGeminiQueueAttemptEvidence(events, { messageId } = {}) {
  const matched = (events ?? []).filter(event => event.messageId === messageId
    && ['queueManager.processItem.start', 'queueManager.processItem.end'].includes(event.name));
  const starts = matched.filter(event => event.name.endsWith('.start'));
  const ends = matched.filter(event => event.name.endsWith('.end'));
  const start = starts[0];
  const end = ends[0];
  const issues = [];
  if (!messageId || starts.length !== 1 || ends.length !== 1) {
    issues.push('expected exactly one QueueManager start and settlement for the affected Gemini message');
  }
  if (!start?.queueItemId || start.queueItemId !== end?.queueItemId
      || start?.messageId !== messageId || end?.messageId !== messageId) {
    issues.push('QueueManager attempt did not retain one nonempty queue item and message ID');
  }
  if (start?.attemptNumber !== 1 || end?.attemptNumber !== 1 || end?.attempts !== 1) {
    issues.push('QueueManager Gemini attempt was not exactly attempt 1');
  }
  if (end?.status !== 'completed' || end?.retryTimerActive !== false) {
    issues.push('QueueManager Gemini attempt did not complete without an active retry timer');
  }
  return {
    ok: issues.length === 0,
    issues,
    observed: { messageId: messageId ?? null, queueItemId: start?.queueItemId ?? null,
      starts, ends },
  };
}

export function validateGeminiStructuredRecovery(evidence) {
  const issues = [];
  const malformed = evidence.injectedMalformed?.[0];
  const recovery = evidence.recovery?.[0];
  if (evidence.injectedMalformed?.length !== 1 || malformed?.httpStatus !== 200
      || malformed?.jsonValid !== false || malformed?.envelopeValid !== true) {
    issues.push('expected exactly one malformed model answer in a valid HTTP 200 Gemini envelope');
  }
  if (evidence.recovery?.length !== 1 || recovery?.valid !== true) issues.push('expected exactly one valid structured recovery request');
  if (recovery?.httpStatus !== 200 || recovery?.networkStatus !== 200 || recovery?.networkOutcome !== 'finished'
      || recovery?.envelopeValid !== true || recovery?.outputValid !== true) {
    issues.push('structured recovery did not produce one successful physical HTTP response with valid Gemini envelope/output');
  }
  if (!malformed?.messageId || malformed.messageId !== recovery?.messageId
      || malformed.sessionId !== recovery?.sessionId
      || JSON.stringify(malformed.targetIds) !== JSON.stringify(recovery.targetIds)
      || JSON.stringify(malformed.texts) !== JSON.stringify(recovery.texts)) {
    issues.push('structured recovery changed logical message, session, or target identity');
  }
  const calls = evidence.executionCalls ?? [];
  const primary = calls.filter(call => call.callPurpose === 'PRIMARY_TRANSLATION');
  const structured = calls.filter(call => call.callPurpose === 'STRUCTURED_RECOVERY');
  if (calls.some(call => !['PRIMARY_TRANSLATION', 'STRUCTURED_RECOVERY'].includes(call.callPurpose))) issues.push('unexpected provider execution purpose was observed');
  if (primary.length !== 1 || structured.length !== 1
      || primary[0]?.messageId !== malformed?.messageId || structured[0]?.messageId !== malformed?.messageId
      || primary[0]?.sessionId !== malformed?.sessionId || structured[0]?.sessionId !== malformed?.sessionId
      || JSON.stringify(primary[0]?.texts) !== JSON.stringify(malformed?.texts)
      || JSON.stringify(structured[0]?.texts) !== JSON.stringify(malformed?.texts)) {
    issues.push('production execution attribution does not prove one primary and one same-batch structured recovery call');
  }
  const recoveryEntries = evidence.structuredRecoveryEntries ?? [];
  if (recoveryEntries.length !== 1 || recoveryEntries[0]?.callPurpose !== 'STRUCTURED_RECOVERY'
      || recoveryEntries[0]?.fullParseRecoveryRetry !== true
      || recoveryEntries[0]?.messageId !== malformed?.messageId
      || recoveryEntries[0]?.sessionId !== malformed?.sessionId
      || JSON.stringify(recoveryEntries[0]?.texts) !== JSON.stringify(malformed?.texts)) {
    issues.push('BaseAIProvider did not prove exactly one FULL_STRUCTURED_RETRY entry for the affected batch');
  }
  const physical = evidence.physicalAttempts ?? [];
  if (physical.length !== 2 || physical.filter(attempt => attempt.role === 'malformed-primary').length !== 1
      || physical.filter(attempt => attempt.role === 'structured-recovery').length !== 1
      || physical.some(attempt => attempt.responseStatus !== 200 || attempt.networkStatus !== 200
        || attempt.networkOutcome !== 'finished' || attempt.keyIdentity !== 'synthetic-fixture')) {
    issues.push('expected exactly two successful same-batch physical requests using the synthetic Gemini fixture key');
  }
  if (evidence.unexpectedPhysicalAttempts?.length) issues.push('unexpected affected-root physical provider attempts were observed');
  if (evidence.unexpectedRetransmits?.length) issues.push('unexpected Gemini retransmissions were observed');
  if (evidence.unnecessaryRetransmits?.length) issues.push('unaffected Gemini batches were retransmitted');
  if (evidence.queueRetries?.length || evidence.keyFailovers?.length || evidence.parentRecoveries?.length) issues.push('QueueManager retry, key failover, or parent recovery was observed');
  if (evidence.queueAttemptEvidence?.ok !== true) {
    issues.push(...(evidence.queueAttemptEvidence?.issues ?? ['QueueManager single-attempt evidence is unavailable']));
  }
  if (!Number.isFinite(evidence.concurrency?.peakPhysical) || evidence.concurrency.peakPhysical > 3) {
    issues.push('Gemini physical concurrency exceeded three or is unavailable');
  }
  if (!Number.isFinite(evidence.concurrency?.peakLogical) || evidence.concurrency.peakLogical > 3) {
    issues.push('Gemini logical batch concurrency exceeded three or is unavailable');
  }
  if (evidence.concurrency?.effectiveProviderLimiterCapacity !== 3) {
    issues.push('Gemini effective provider limiter capacity was not observed as exactly three');
  }
  if (evidence.translation?.exact !== true || evidence.translation?.duplicates !== 0
      || evidence.translation?.targetCount !== 1000 || evidence.translation?.restoreExact !== true
      || evidence.translation?.acceptedTargetCount !== 1000 || evidence.translation?.duplicateAcceptedIds?.length) {
    issues.push('exact 1000-target translation, unique acceptance, or Restore evidence failed');
  }
  if (evidence.cleanup?.ok !== true) issues.push('runtime resources did not settle cleanly');
  return { ok: issues.length === 0, issues };
}

export function selectResolvedCustomAttempt({ request, classification, resolver, failedCount }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'custom'
      || failedCount !== 0 || !request?.networkId) return { selected: false, reason: 'not-first-custom-physical-attempt' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  return { selected: true, source: resolver.effectiveSourceLanguage, target: resolver.effectiveTargetLanguage };
}

export function selectResolvedCustom400Batch({ request, classification, resolver, roots = [], failedCount, initialTargetIds = [], armedWallMs }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'custom'
      || failedCount !== 0 || !request?.networkId) return { selected: false, reason: 'not-first-custom-400-batch' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  if (!Number.isFinite(request.physicalStartedWallMs) || !Number.isFinite(armedWallMs)
      || request.physicalStartedWallMs < armedWallMs) return { selected: false, reason: 'request-did-not-start-after-arm' };
  const matching = roots.filter(root => root.sessionId === request.sessionId
    && JSON.stringify(root.texts) === JSON.stringify(request.texts));
  if (request.texts?.length !== 25 || matching.length !== 1 || !matching[0]?.messageId
      || matching[0]?.sessionId !== request.sessionId) {
    return { selected: false, reason: 'batch-size-or-logical-correlation-not-unique' };
  }
  const targetIds = request.targetIds;
  if (!Array.isArray(targetIds) || targetIds.length !== 25 || targetIds.some(id => typeof id !== 'string')
      || new Set(targetIds).size !== 25 || targetIds.some(id => initialTargetIds.includes(id))) {
    return { selected: false, reason: 'batch-targets-invalid-or-initial' };
  }
  return { selected: true, source: resolver.effectiveSourceLanguage,
    target: resolver.effectiveTargetLanguage, messageId: matching[0].messageId,
    sessionId: matching[0].sessionId, targetIds: [...targetIds], texts: [...request.texts] };
}

export function selectResolvedCustomCancellationBatch({ request, classification, resolver, roots = [],
  expectedTargetIds = [], initialTargetIds = [], armedWallMs }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'custom'
      || !request?.networkId) return { selected: false, reason: 'not-custom-physical-request' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  if (!Number.isFinite(request.physicalStartedWallMs) || !Number.isFinite(armedWallMs)
      || request.physicalStartedWallMs < armedWallMs) return { selected: false, reason: 'request-did-not-start-after-arm' };
  const matching = roots.filter(root => root.sessionId === request.sessionId
    && JSON.stringify(root.texts) === JSON.stringify(request.texts));
  const targetIds = request.targetIds;
  if (request.texts?.length !== 25 || matching.length !== 1 || !matching[0]?.messageId
      || matching[0].sessionId !== request.sessionId
      || !Array.isArray(targetIds) || targetIds.length !== 25
      || targetIds.some(id => typeof id !== 'string' || !expectedTargetIds.includes(id))
      || new Set(targetIds).size !== 25 || targetIds.some(id => initialTargetIds.includes(id))) {
    return { selected: false, reason: 'batch-owner-or-target-correlation-invalid' };
  }
  return { selected: true, messageId: matching[0].messageId, sessionId: matching[0].sessionId,
    targetIds: [...targetIds], texts: [...request.texts] };
}

export function isCustom400ProbeWindowRequest(request, armedWallMs) {
  return Number.isFinite(request?.startedAt) && Number.isFinite(armedWallMs) && request.startedAt >= armedWallMs;
}

export function validateCustom400QueueEvidence(events, { messageId, targetIds } = {}) {
  const matched = (events ?? []).filter(event => event.messageId === messageId
    && ['queueManager.processItem.start', 'queueManager.processItem.end'].includes(event.name));
  const starts = matched.filter(event => event.name.endsWith('.start'));
  const ends = matched.filter(event => event.name.endsWith('.end'));
  const start = starts[0];
  const end = ends[0];
  const issues = [];
  if (!messageId || starts.length !== 1 || ends.length !== 1) issues.push('expected exactly one QueueManager start and terminal settlement for the affected Custom 400 message');
  if (!start?.queueItemId || start.queueItemId !== end?.queueItemId
      || start?.messageId !== messageId || end?.messageId !== messageId) issues.push('QueueManager attempt did not retain one queue item and message ID');
  if (start?.attemptNumber !== 1 || end?.attemptNumber !== 1 || end?.attempts !== 1) issues.push('QueueManager Custom 400 attempt was not exactly attempt 1');
  if (end?.status !== 'failed' || end?.lastErrorType !== 'HTTP_ERROR'
      || end?.retryTimerActive !== false) issues.push('QueueManager did not terminally fail the HTTP error without retry');
  if (start?.previousErrorType != null || start?.retryScheduledAt != null
      || end?.retryScheduledAt != null || end?.retryAt != null) issues.push('QueueManager retry scheduling evidence was present');
  return { ok: issues.length === 0, issues, observed: {
    messageId: messageId ?? null, queueItemId: start?.queueItemId ?? null, starts, ends,
    attempts: starts.map(event => event.attemptNumber), errorType: end?.lastErrorType ?? null,
    finalStatus: end?.status ?? null, retryTimerActive: end?.retryTimerActive ?? null,
    targetIds: Array.isArray(targetIds) ? [...targetIds] : null,
  } };
}

export function partitionBandAcceptance(bandIds, acceptedIds, failedTargetIds = []) {
  const accepted = new Set(acceptedIds);
  const failed = new Set(failedTargetIds);
  return {
    acceptedIds: bandIds.filter(id => accepted.has(id) && !failed.has(id)),
    failedTargetIds: bandIds.filter(id => failed.has(id)),
  };
}

export function validateCustom400Evidence(evidence) {
  const issues = [];
  const failed = evidence.injected400?.[0];
  if (evidence.injected400?.length !== 1 || failed?.status !== 400
      || failed?.errorBody?.error?.code !== 400
      || failed?.errorBody?.error?.message !== 'Invalid request parameters'
      || failed.networkStatus !== 400 || failed.networkOutcome !== 'finished'
      || !failed.networkId) issues.push('expected exactly one physical HTTP 400 with the canonical error response');
  if (evidence.selectionFailures?.length) issues.push('first eligible post-arm Custom batch failed closed instead of selecting an exact 25-target batch');
  if (evidence.preRestorePreArmDrain?.ok !== true || evidence.preRestorePreArmDrain?.outstandingCount !== 0) {
    issues.push('pre-arm provider requests were not proven drained before Restore');
  }
  if (!failed?.logicalMessageId || !failed?.queueItemId || !failed?.pageSessionId
      || failed.pageSessionId !== evidence.arm?.sessionId
      || !Array.isArray(failed.targetIds) || failed.targetIds.length !== 25
      || new Set(failed.targetIds).size !== 25
      || failed.texts?.length !== 25) issues.push('injected failure lacks unique 25-target message/session/queue correlation');
  if (evidence.expectedLogicalBatchCount !== evidence.providerPhysicalAttemptCount
      || evidence.attempts?.length !== evidence.expectedProbeWindowPhysicalAttemptCount
      || evidence.probeWindowPhysicalAttempts?.length !== evidence.expectedProbeWindowPhysicalAttemptCount
      || evidence.attempts?.filter(item => item.logicalMessageId === failed?.logicalMessageId).length !== 1) issues.push('physical provider attempts do not match logical batches or affected message was retransmitted');
  const attemptIds = new Set();
  const networkIds = new Set();
  const attempts = evidence.attempts ?? [];
  const expectedNetworkAttempts = new Map((evidence.probeWindowPhysicalAttempts ?? [])
    .map(item => [`${item.networkSessionId}:${item.networkId}`, item.attemptId]));
  const expectedNetworkIdentities = new Set(expectedNetworkAttempts.keys());
  const observedNetworkIdentities = new Set();
  const observedAttemptByNetwork = new Map();
  for (const attempt of evidence.attempts ?? []) {
    if (!attempt.attemptId || !attempt.networkId || !attempt.logicalMessageId || !attempt.pageSessionId
        || !attempt.networkSessionId
        || attempt.pageSessionId !== evidence.arm?.sessionId || attemptIds.has(attempt.attemptId)
        || networkIds.has(attempt.networkId)
        || !Array.isArray(attempt.targetIds) || !attempt.targetIds.length
        || attempt.targetIds.some(id => typeof id !== 'string')
        || ![200, 400].includes(attempt.status) || attempt.status !== attempt.networkStatus
        || attempt.networkOutcome !== 'finished') {
      issues.push('Custom physical attempt ledger has a missing identity, fixture target, or valid HTTP/network outcome');
      break;
    }
    attemptIds.add(attempt.attemptId);
    networkIds.add(attempt.networkId);
    const networkIdentity = `${attempt.networkSessionId}:${attempt.networkId}`;
    observedNetworkIdentities.add(networkIdentity);
    observedAttemptByNetwork.set(networkIdentity, attempt.attemptId);
  }
  if (expectedNetworkIdentities.size !== evidence.expectedProbeWindowPhysicalAttemptCount
      || observedNetworkIdentities.size !== expectedNetworkIdentities.size
      || [...expectedNetworkIdentities].some(id => !observedNetworkIdentities.has(id)
        || observedAttemptByNetwork.get(id) !== expectedNetworkAttempts.get(id))) {
    issues.push('armed Custom attempt ledger does not match the independently counted probe-window physical attempts');
  }
  const failedAttempts = attempts.filter(attempt => attempt.status === 400);
  if (failedAttempts.length !== 1 || failedAttempts[0]?.networkId !== failed?.networkId
      || failedAttempts[0]?.networkSessionId !== failed?.networkSessionId
      || failedAttempts[0]?.logicalMessageId !== failed?.logicalMessageId
      || failedAttempts[0]?.pageSessionId !== failed?.pageSessionId
      || JSON.stringify(failedAttempts[0]?.targetIds) !== JSON.stringify(failed?.targetIds)
      || attempts.some(attempt => attempt !== failedAttempts[0] && (attempt.status !== 200 || attempt.networkOutcome !== 'finished'))) {
    issues.push('Custom attempt ledger must contain exactly the injected HTTP 400 and only successful HTTP 200 siblings');
  }
  if (evidence.unnecessaryRetransmits?.length || evidence.unexpectedRecovery?.length
      || evidence.queueRetries?.length || evidence.keyFailovers?.length || evidence.circuitBreakers?.length) {
    issues.push('retransmission, recovery, retry, key failover, or circuit breaker was observed');
  }
  if (evidence.queueAttemptEvidence?.ok !== true) issues.push(...(evidence.queueAttemptEvidence?.issues ?? ['QueueManager terminal failure evidence is unavailable']));
  const translation = evidence.translation ?? {};
  const dom = evidence.failedTargetDOM;
  if (!Array.isArray(dom?.expected) || !Array.isArray(dom?.observed)
      || JSON.stringify(dom.expected) !== JSON.stringify(dom.observed)
      || dom.expected.length !== 25
      || dom.observed.some(item => !Array.isArray(item) || item[2]?.pageTranslated !== false || item[2]?.hasOriginal !== false)) {
    issues.push('failed target pre-Restore DOM text or translation-marker evidence is missing or incorrect');
  }
  if (translation.exact !== true || translation.targetCount !== 1000
      || translation.acceptedTargetCount !== 975 || translation.failedTargetCount !== 25
      || translation.duplicates !== 0 || translation.duplicateAcceptedIds?.length
      || translation.failedSourcePreserved !== true || translation.successfulTargetsAcceptedOnce !== true
      || translation.restoreExact !== true || translation.terminal !== true
      || translation.sessionOwner !== failed?.pageSessionId) {
    issues.push('Custom 400 partial-success accounting, failed-source preservation, terminal, session, or Restore evidence failed');
  }
  if (!Number.isFinite(evidence.concurrency?.peakPhysical) || evidence.concurrency.peakPhysical > 2
      || !Number.isFinite(evidence.concurrency?.peakLogical) || evidence.concurrency.peakLogical > 2
      || evidence.concurrency?.effectiveProviderLimiterCapacity !== 2) issues.push('Custom Level 3 concurrency exceeded two or lacks exact limiter-capacity evidence');
  if (evidence.resources?.rateLimit?.Custom?.isCircuitOpen !== false) issues.push('Custom provider circuit-breaker state is open or unavailable');
  if (evidence.cleanup?.ok !== true) issues.push('runtime resources did not settle cleanly');
  return { ok: issues.length === 0, issues };
}

export function findSessionOwnedPendingRequest(queueItems, sessionId, excludedMessageIds = []) {
  return (queueItems ?? []).find(item => item.messageId && item.sessionId === sessionId
    && !excludedMessageIds.includes(item.messageId)) ?? null;
}

export function validateCustomCancellationEvidence(input) {
  const issues = [];
  try {
  const evidence = input ?? {};
  const held = evidence.heldRequest ?? {};
  const cancellation = evidence.cancellation ?? {};
  const providerRoot = cancellation.providerRoot ?? {};
  const physical = cancellation.physical ?? {};
  const translation = evidence.translation ?? {};
  const expected = new Set(translation.expectedTargetIds ?? []);
  const targetMapping = new Map((evidence.targetMapping ?? []).map(item => [item.source, item.id]));
  const stopAt = cancellation.stop?.sentAt;
  const arraysPresent = ['retries', 'failovers', 'recovery', 'duplicateAcceptedWriteIds',
    'unexpectedPhysicalAttempts', 'unnecessaryRetransmits']
    .every(key => Array.isArray(evidence[key]));
  if (!arraysPresent) issues.push('retry, failover, recovery, and duplicate-write accounting evidence is incomplete');
  if (!Array.isArray(evidence.targetMapping) || targetMapping.size !== evidence.targetMapping.length
      || new Set(evidence.targetMapping.map(item => item.id)).size !== evidence.targetMapping.length
      || [...expected].some(id => !evidence.targetMapping.some(item => item.id === id))) {
    issues.push('fixture target/source mapping is incomplete or non-unique');
  }
  if (!Number.isFinite(stopAt) || stopAt <= 0
      || !Number.isFinite(cancellation.stop?.respondedAt) || cancellation.stop.respondedAt < stopAt) {
    issues.push('production Stop lacks a valid timestamp and ordered acknowledgement');
  }
  const physicalAbortMatched = value => value?.abortReasonMatched === true
    && ((value.errorType == null && value.error == null && value.errorName == null)
      || (value.errorType === 'USER_CANCELLED' && (value.error == null || /abort|cancel/i.test(value.error))));
  const statusNullAbortMatched = attempt => attempt?.status === null
    && attempt.outcome === 'failed' && /abort|cancel/i.test(attempt.networkError ?? '')
    && attempt.correlation?.physicalStatus === 'rejected'
    && attempt.correlation?.providerRootErrorType === 'USER_CANCELLED'
    && attempt.correlation?.controllerAborted === true
    && attempt.correlation?.physicalControllerAbortedAtEnd === true
    && physicalAbortMatched({ errorType: attempt.correlation?.physicalErrorType,
      error: attempt.correlation?.physicalError, errorName: attempt.correlation?.physicalErrorName,
      abortReasonMatched: attempt.correlation?.physicalAbortReasonMatched });
  const cancellationTerminalMatched = attempt => statusNullAbortMatched(attempt)
    && attempt.correlation?.providerRootStatus === 'rejected';
  const successfulTerminalMatched = attempt => attempt?.outcome === 'finished'
    && attempt.status === 200 && attempt.networkError == null
    && attempt.correlation?.providerRootStatus === 'fulfilled'
    && attempt.correlation?.providerRootErrorType == null
    && attempt.correlation?.physicalStatus === 'fulfilled'
    && attempt.correlation?.physicalControllerAbortedAtEnd === false
    && attempt.correlation?.controllerAborted === false
    && attempt.correlation?.physicalErrorType == null
    && attempt.correlation?.physicalError == null
    && attempt.correlation?.physicalErrorName == null;
  const terminalStateMatched = attempt => successfulTerminalMatched(attempt)
    || cancellationTerminalMatched(attempt);
  const invalidAttempt = attempt => !attempt.attemptId || !attempt.networkId || !attempt.networkSessionId
    || !attempt.pageSessionId || attempt.pageSessionId !== held.pageSessionId || !attempt.logicalMessageId
    || !Array.isArray(attempt.targetIds) || !attempt.targetIds.length
    || attempt.targetIds.length !== attempt.texts?.length || !Array.isArray(attempt.texts)
    || attempt.targetIds.some(id => typeof id !== 'string' || !expected.has(id))
    || attempt.texts.some((text, index) => targetMapping.get(text) !== attempt.targetIds[index])
    || new Set(attempt.targetIds).size !== attempt.targetIds.length
    || attempt.correlation?.rootMatchCount !== 1 || attempt.correlation?.physicalMatchCount !== 1
    || attempt.correlation?.controllerMatchCount !== 1 || !attempt.startedWallMs || !attempt.outcome
    || attempt.startedWallMs <= 0 || Number.isFinite(stopAt) && attempt.startedWallMs > stopAt
    || (attempt.selected || ['rejected', null].includes(attempt.correlation?.physicalStatus))
      && (attempt.correlation?.providerRootErrorType !== 'USER_CANCELLED'
        || attempt.correlation?.controllerAborted !== true
        || attempt.correlation?.physicalControllerAbortedAtEnd !== true
        || !physicalAbortMatched({ errorType: attempt.correlation?.physicalErrorType,
          error: attempt.correlation?.physicalError, errorName: attempt.correlation?.physicalErrorName,
          abortReasonMatched: attempt.correlation?.physicalAbortReasonMatched })
        || attempt.outcome !== 'failed' || !/abort|cancel/i.test(attempt.networkError ?? ''))
    || (attempt.selected && !['rejected', null].includes(attempt.correlation?.physicalStatus))
    || (!attempt.selected && !['fulfilled', 'rejected', null].includes(attempt.correlation?.physicalStatus))
    || (attempt.status === null && !statusNullAbortMatched(attempt));
  if (evidence.arm?.sessionId !== held?.pageSessionId || !Number.isFinite(evidence.arm?.armedWallMs)
      || evidence.arm?.resolver?.resolutionPending !== false
      || !evidence.arm?.resolver?.effectiveSourceLanguage || evidence.arm.resolver.effectiveSourceLanguage === 'auto'
      || !evidence.arm?.resolver?.effectiveTargetLanguage) issues.push('initial band and concrete AUTO resolution were not proven before arming');
  if (!held?.requestId || !held.networkId || !held.networkSessionId || !held.attemptId || !held.messageId
      || held.pageSessionId !== evidence.arm?.sessionId || held.method !== 'POST'
      || held.targetIds?.length !== 25 || new Set(held.targetIds).size !== 25
      || held.targetIds.some(id => !expected.has(id))) issues.push('held Custom Fetch lacks exact session, physical, logical, and unique fixture-target correlation');
  if (evidence.pendingCheckpoint?.positive !== true
      || evidence.pendingCheckpoint?.requestId !== held?.requestId
      || evidence.pendingCheckpoint?.controllerAborted !== false
      || evidence.pendingCheckpoint?.providerRootStatus !== 'pending') issues.push('pending checkpoint did not observe the held request with a live controller and pending root');
  if (cancellation.stop?.action !== 'page-translate-stop-auto' || cancellation.stop.status !== 'fulfilled'
      || cancellation.stop.response?.success !== true
      || cancellation?.invalidation?.sessionId !== held?.pageSessionId
      || cancellation?.invalidation?.capturedSessionActive !== false
      || cancellation?.invalidation?.discoveryCancelled !== true) issues.push('real stop-auto command did not acknowledge and invalidate the held Page session');
  if (cancellation.cancelMessage?.kind !== 'runtime.cancel.send'
      || cancellation.cancelMessage.action !== 'CANCEL_TRANSLATION'
      || ![null, held.messageId].includes(cancellation.cancelMessage.messageId)
      || cancellation.cancelMessage.sessionId !== held.pageSessionId
      || cancellation.cancelMessage.targetSessionId !== held.pageSessionId
      || cancellation.cancelMessage.status !== 'fulfilled'
      || cancellation.cancelMessage.response?.success !== true) {
    issues.push('content runtime cancellation acknowledgement did not target the held batch and Page session');
  }
  if (cancellation.serviceCall?.status !== 'fulfilled' || cancellation.serviceCall.messageId !== held?.messageId
      || cancellation.serviceCall.sessionId !== held?.pageSessionId
      || cancellation.serviceCall.response?.handled !== true || cancellation.serviceCall.response?.success !== true
      || cancellation.serviceCall.controllerMatched !== true
      || cancellation.serviceCall.controllerAbortedBefore !== false
      || cancellation.serviceCall.controllerAbortedAfter !== true
      || cancellation.abortEvent?.messageId !== held?.messageId
      || cancellation.abortEvent.sessionId !== held?.pageSessionId
       || cancellation.abortEvent.sequence <= cancellation.serviceCall.sequence) issues.push('production cancellation did not abort the exact live provider controller');
  if (cancellation.controller?.messageId !== held?.messageId
      || cancellation.controller?.sessionId !== held?.pageSessionId
      || cancellation.controller?.aborted !== true) {
    issues.push('cancelled provider controller evidence does not match the held Page session and logical root');
  }
  if (providerRoot.messageId !== held.messageId || providerRoot.sessionId !== held.pageSessionId
      || providerRoot.status !== 'rejected'
      || physical.messageId !== held.messageId || physical.status !== 'rejected'
      || physical.sessionId !== held.pageSessionId
      || cancellation.physicalMatchCount !== 1 || cancellation.physical.controllerAbortedAtEnd !== true
      || physical.url !== held.url || physical.method !== held.method
      || physical.requestBody !== held.requestBody
      || providerRoot.settledSequence <= cancellation.abortEvent?.sequence
      || physical.settledSequence <= cancellation.abortEvent?.sequence
      || providerRoot.errorType !== 'USER_CANCELLED'
      || !physicalAbortMatched(physical)
      || cancellation.network?.sessionId !== held.networkSessionId
      || cancellation.network?.networkId !== held.networkId
      || cancellation.network?.outcome !== 'failed'
      || !/abort|cancel/i.test(cancellation.network?.error ?? '')) {
    issues.push('provider root and exactly one physical Custom request did not settle as USER_CANCELLED after a matched network abort');
  }
  if (evidence.attempts?.filter(item => item.selected).length !== 1
      || evidence.unexpectedPhysicalAttempts.length || evidence.unnecessaryRetransmits.length
      || evidence.retries?.length || evidence.failovers?.length || evidence.recovery?.length) {
    issues.push('unexpected selected requests, cancelled-session activity, retries, recovery, or failovers were observed');
  }
  const selectedAttempt = evidence.attempts?.find(item => item.selected);
  if (selectedAttempt?.attemptId !== held?.attemptId || selectedAttempt?.networkId !== held?.networkId
      || selectedAttempt?.networkSessionId !== held?.networkSessionId
      || selectedAttempt?.pageSessionId !== held?.pageSessionId
      || selectedAttempt?.logicalMessageId !== held?.messageId
      || JSON.stringify(selectedAttempt?.targetIds) !== JSON.stringify(held?.targetIds)
      || (cancellation.network?.status ?? null) !== selectedAttempt?.status
      || cancellation.network?.outcome !== selectedAttempt?.outcome
      || cancellation.network?.error !== selectedAttempt?.networkError) {
    issues.push('selected physical attempt does not match held Fetch, Page session, logical root, and target identity');
  }
  const attempts = evidence.attempts ?? [];
  const attemptIds = new Set();
  const physicalIds = new Set();
  const rootIds = new Set();
  if (!Array.isArray(evidence.attempts) || attempts.some(invalidAttempt)) {
    issues.push('one or more Custom physical requests lack unique actual session/root/physical/controller correlation');
  }
  for (const attempt of attempts) {
    const physicalId = `${attempt.networkSessionId}:${attempt.networkId}`;
    if (attemptIds.has(attempt.attemptId) || physicalIds.has(physicalId) || rootIds.has(attempt.logicalMessageId)) {
      issues.push('provider attempt, physical request, or logical root identity is duplicated');
      break;
    }
    attemptIds.add(attempt.attemptId);
    physicalIds.add(physicalId);
    rootIds.add(attempt.logicalMessageId);
  }
  if (attempts.some(attempt => !terminalStateMatched(attempt))) {
    issues.push('raw Network status/outcome does not match the cancelled provider root and physical terminal state');
  }
  if (!Array.isArray(evidence.allSessionRoots) || !evidence.allSessionRoots.length
      || evidence.allSessionRoots.some(root => root.sessionId !== held?.pageSessionId || root.status === 'pending')
      || new Set(evidence.allSessionRoots.map(root => root.messageId)).size !== evidence.allSessionRoots.length
      || evidence.allSessionRoots.length !== attempts.length
       || evidence.allSessionRoots.some(root => !rootIds.has(root.messageId)
         || root.status !== attempts.find(attempt => attempt.logicalMessageId === root.messageId)?.correlation?.providerRootStatus)
      || !Array.isArray(evidence.allSessionPhysicalAttempts)
      || evidence.allSessionPhysicalAttempts.length !== attempts.length
      || new Set(evidence.allSessionPhysicalAttempts.map(item => `${item.networkSessionId}:${item.networkId}`)).size
        !== evidence.allSessionPhysicalAttempts.length
       || evidence.allSessionPhysicalAttempts.some(item => item.pageSessionId !== held?.pageSessionId
         || !physicalIds.has(`${item.networkSessionId}:${item.networkId}`)
         || (() => {
           const attempt = attempts.find(candidate => candidate.networkSessionId === item.networkSessionId
             && candidate.networkId === item.networkId);
           return attempt?.attemptId !== item.attemptId || item.outcome !== attempt?.outcome
              || item.status !== attempt?.status || !terminalStateMatched(attempt);
         })())) {
    issues.push('not all cancelled-session logical roots and physical requests have final settlement evidence');
  }
  if (!Array.isArray(evidence.allSessionControllers)
      || evidence.allSessionControllers.length !== attempts.length
       || new Set(evidence.allSessionControllers.map(item => item.messageId)).size !== attempts.length
       || evidence.allSessionControllers.some(item => item.sessionId !== held?.pageSessionId
         || !rootIds.has(item.messageId)
          || attempts.find(attempt => attempt.logicalMessageId === item.messageId)?.correlation?.controllerAborted !== item.aborted)) {
    issues.push('not all cancelled-session provider controllers have unique final accounting');
  }
   if (evidence.postInvalidation?.ok !== true || evidence.postInvalidation.lateAcceptedSettlements?.length
       || evidence.postInvalidation.invalidMutations?.length || evidence.postInvalidation.lateOwnedMutations?.length
      || evidence.duplicateAcceptedWriteIds?.length || translation.duplicates !== 0) issues.push('post-invalidation accepted writes or duplicate writes were observed');
  const initialIds = evidence.arm?.initialTargetIds ?? [];
  const retainedIds = evidence.retainedAcceptedIds ?? [];
  if (new Set(retainedIds).size !== retainedIds.length
      || retainedIds.some(id => !expected.has(id))
      || translation.exact !== true || translation.targetCount !== 1000
      || translation.acceptedTargetCount !== retainedIds.length
      || translation.acceptedTargetIds?.length !== retainedIds.length
      || JSON.stringify(translation.acceptedTargetIds) !== JSON.stringify(retainedIds)
      || initialIds.some(id => !retainedIds.includes(id))
      || JSON.stringify(cancellation.acceptedIdsAfterStop) !== JSON.stringify(retainedIds)
      || translation.restoreExact !== true || translation.metadataExact !== true
      || translation.acceptedSessionActivity !== 0 || translation.acceptedWriteCount !== retainedIds.length) {
    issues.push('retained translations changed or final translation/Restore metadata was not exact');
  }
  if (evidence.queueAttemptEvidence?.ok !== true || evidence.cleanup?.ok !== true
      || evidence.cleanup?.handlersDrained !== true || evidence.cleanup?.handlerCount !== 0
      || evidence.cleanup?.requestLifecycle?.ok !== true
      || evidence.cleanup?.resourceValidation?.ok !== true
      || evidence.cleanup?.pageScheduler?.managerTranslating !== false
      || evidence.cleanup?.pageScheduler?.activeFlushes !== 0
      || evidence.cleanup?.pageScheduler?.queueIds?.length !== 0
      || evidence.cleanup?.pageScheduler?.pendingSettlementCount !== 0
      || evidence.cleanup?.pageScheduler?.batchTimerActive !== false
      || evidence.cleanup?.pageScheduler?.completionTimerActive !== false
      || evidence.resources?.sourceResolvers?.[held?.pageSessionId]?.present !== false
      || evidence.cleanup?.contentDrain?.pendingOperations !== 0
      || evidence.cleanup?.workerDrain?.ledger?.pending !== 0
      || !Array.isArray(evidence.cleanup?.workerDrain?.providerRoots)
      || !Array.isArray(evidence.cleanup?.workerDrain?.controllers)
      || evidence.cleanup?.workerDrain?.providerRoots?.some(root => root.status === 'pending')
      || evidence.cleanup?.workerDrain?.controllers?.some(controller => controller.sessionId === held?.pageSessionId
        && controller.messageId === held.messageId && controller.aborted !== true)) {
    issues.push('queue, runtime resources, promise roots, or Fetch handlers did not drain');
  }
  if (evidence.queueAttemptEvidence?.queueStartCount !== 1
      || evidence.queueAttemptEvidence?.queueEndCount !== 1) {
    issues.push('held logical root lacks exactly one observed QueueManager start and end event');
  }
  const reservations = evidence.cleanup?.requestLifecycle?.reservations;
  const cancellationReleaseClassifications = new Set([
    'network-loadingFailed-canceled-with-provider-settlement',
    'invalid-fetch-id-after-matched-abort-and-provider-root-plus-physical-rejection',
    'network-cancellation-after-production-stop',
  ]);
  if (!Array.isArray(reservations) || attempts.some(attempt => {
    const matches = reservations.filter(item => item.sessionId === attempt.networkSessionId
      && item.networkId === attempt.networkId);
    return matches.length !== 1 || matches[0].handlerSettled !== true
      || !(matches[0].releaseOutcome?.ok === true
        || matches[0].releaseOutcome?.error === 'Invalid InterceptionId.'
          && cancellationReleaseClassifications.has(matches[0].releaseClassification));
  })) {
    issues.push('provider attempts do not map one-to-one to settled, classified Fetch reservations');
  }
  const lifecycle = evidence.cleanup?.requestLifecycle;
  const drain = lifecycle?.drainInterval;
  const admissions = evidence.admissions ?? [];
  const invalidation = cancellation.invalidation ?? {};
  const classifyBoundary = timestamp => !Number.isFinite(timestamp)
    ? null : timestamp < invalidation.invalidationCallStartedAt ? 'before'
      : timestamp > invalidation.invalidationCallCompletedAt ? 'after' : 'indeterminate';
  const reservationForAdmission = admission => reservations?.filter(item => item.requestId === admission.requestId) ?? [];
  if (!Array.isArray(evidence.admissions) || !Array.isArray(reservations)
      || new Set(admissions.map(item => item.requestId)).size !== admissions.length
      || admissions.some(item => {
        const matched = reservationForAdmission(item);
        return !item.requestId || !Number.isInteger(item.order) || !item.decision || item.decision === 'pending'
          || matched.length !== 1 || item.networkId !== matched[0]?.networkId
          || item.networkSessionId !== matched[0]?.sessionId
          || matched[0]?.handlerSettled !== true || matched[0]?.handlerError != null
          || !(matched[0]?.releaseOutcome?.ok === true
            || matched[0]?.releaseOutcome?.error === 'Invalid InterceptionId.'
              && cancellationReleaseClassifications.has(matched[0]?.releaseClassification))
          || !['before', 'after', 'indeterminate'].includes(item.relativeToInvalidation)
          || item.relativeToInvalidation !== classifyBoundary(item.admittedAt)
          || item.networkRelativeToInvalidation !== classifyBoundary(item.startedWallMs);
      })
      || attempts.some(attempt => {
        if (attempt.startedWallMs < evidence.arm?.armedWallMs) return false;
        const matchingReservation = reservations.filter(item => item.sessionId === attempt.networkSessionId
          && item.networkId === attempt.networkId);
        return matchingReservation.length !== 1
          || admissions.filter(item => item.requestId === matchingReservation[0]?.requestId).length !== 1;
      })) {
    issues.push('Custom Fetch admission decisions do not map one-to-one to settled, classified lifecycle reservations with valid invalidation timing');
  }
  if (!Number.isFinite(invalidation.invalidationCallStartedAt)
      || !Number.isFinite(invalidation.invalidationCallCompletedAt)
      || invalidation.invalidationCallCompletedAt < invalidation.invalidationCallStartedAt) {
    issues.push('session invalidation lacks a valid benchmark call timing envelope');
  }
  if (!evidence.cleanup?.handlersDrained || evidence.cleanup?.handlerCount !== 0
      || lifecycle?.closing !== true || lifecycle?.ok !== true
      || lifecycle?.reservationCount !== reservations?.length
      || !Number.isFinite(drain?.startedAt) || !Number.isFinite(drain?.completedAt)
      || drain.startedAt < stopAt || drain.completedAt < drain.startedAt
      || !Number.isFinite(evidence.cleanup?.finalDrainAt) || evidence.cleanup.finalDrainAt < drain.completedAt
      || !Array.isArray(reservations) || new Set(reservations.map(item => item.requestId)).size !== reservations.length
      || reservations.some(item => item.releaseRequested !== true || item.handlerSettled !== true
        || item.handlerError != null
        || !(item.releaseOutcome?.ok === true
          || item.releaseOutcome?.error === 'Invalid InterceptionId.'
            && cancellationReleaseClassifications.has(item.releaseClassification)))) {
    issues.push('post-Stop request accounting is not complete through final Fetch handler drainage');
  }
   if (['beforeStop', 'afterStop', 'preRestore', 'restored'].some(key =>
     evidence.snapshots?.[key]?.dom?.length !== translation.targetCount
       || evidence.snapshots[key].metadata?.length !== translation.targetCount)) {
    issues.push('raw before-Stop, after-Stop, pre-Restore, and restored DOM/metadata snapshots are incomplete');
   }
   const validDOM = (snapshot, translatedIds) => Array.isArray(snapshot?.dom)
     && JSON.stringify(snapshot.dom) === JSON.stringify((evidence.targetMapping ?? []).map(({ id, source }) =>
       [id, translatedIds.has(id) ? `\u200efixture translation: ${source}` : source]));
   const retained = new Set(evidence.retainedAcceptedIds ?? []);
  const baselineMetadata = evidence.metadataBaseline;
   if (!validDOM(evidence.snapshots?.beforeStop, retained)
       || !validDOM(evidence.snapshots?.afterStop, retained)
       || !validDOM(evidence.snapshots?.preRestore, retained)
       || !validDOM(evidence.snapshots?.restored, new Set())
       || !Array.isArray(baselineMetadata)
        || JSON.stringify(evidence.snapshots?.restored?.metadata) !== JSON.stringify(baselineMetadata)
        || ['beforeStop', 'afterStop', 'preRestore'].some(key => {
          const metadata = evidence.snapshots?.[key]?.metadata;
          const byId = new Map((metadata ?? []).map(item => [item.id, item]));
          return byId.size !== translation.targetCount
            || (baselineMetadata ?? []).some(base => !retained.has(base.id)
              && JSON.stringify(byId.get(base.id)) !== JSON.stringify(base));
        })) {
     issues.push('raw DOM or metadata snapshots do not match fixture and source baselines');
   }
   const rawRoots = evidence.cleanup?.workerDrain?.providerRoots;
   const rawControllers = evidence.cleanup?.workerDrain?.controllers;
    if (Array.isArray(rawRoots) && (rawRoots.length !== attempts.length
        || new Set(rawRoots.map(root => root.messageId)).size !== rawRoots.length
        || rawRoots.some(root => {
          const attempt = attempts.find(candidate => candidate.logicalMessageId === root.messageId);
          return root.sessionId !== held?.pageSessionId || !attempt
            || root.status !== attempt.correlation?.providerRootStatus;
        })))
      issues.push('worker-drain provider roots do not match the cancelled-session attempt ledger');
    if (Array.isArray(rawControllers) && (rawControllers.length !== attempts.length
        || new Set(rawControllers.map(controller => controller.messageId)).size !== rawControllers.length
        || rawControllers.some(controller => controller.sessionId !== held?.pageSessionId
          || !attempts.some(attempt => attempt.logicalMessageId === controller.messageId
            && attempt.correlation?.controllerAborted === controller.aborted))))
     issues.push('worker-drain controllers do not match the cancelled-session attempt ledger');
  if (!Number.isFinite(evidence.concurrency?.peakPhysical) || evidence.concurrency.peakPhysical > 2
      || !Number.isFinite(evidence.concurrency?.peakLogical) || evidence.concurrency.peakLogical > 2
      || evidence.concurrency?.providerLimiterCapacity !== 2
      || evidence.concurrency?.pageWorkerLimit !== 2) issues.push('Custom Level 3 physical/logical concurrency exceeded or lacked the existing limit of two');
  if (evidence.releaseClassification?.ok !== true) issues.push('held Fetch release failure was not positively classified after matching cancellation');
  if (evidence.handlerError) issues.push(`held Fetch handler failed: ${evidence.handlerError.message}`);
  return { ok: issues.length === 0, issues };
  } catch (error) {
    return { ok: false, issues: [...issues, `invalid or incomplete cancellation evidence: ${error?.message ?? String(error)}`] };
  }
}

export function validateCustom429Evidence(evidence) {
  const clockPrecisionToleranceMs = 3;
  const issues = [];
  const failed = evidence.injected429?.[0];
  const a = evidence.roles?.A;
  const b = evidence.roles?.B;
  const pending = evidence.pendingLimiterSibling;
  const cooldown = evidence.cooldown;
  const armedResolver = evidence.arm?.resolver;
  if (evidence.injected429?.length !== 1 || failed?.status !== 429 || failed?.retryAfterSeconds !== 5
      || failed?.retryAfterHeader !== '5') issues.push('expected exactly one HTTP 429 with Retry-After: 5');
  const retry = evidence.attempts?.filter(attempt => attempt.retryOf === failed?.attemptId) ?? [];
  if (retry.length !== 1 || retry[0]?.status !== 200) issues.push('injected attempt lacks exactly one successful physical retry');
  if (!failed?.logicalMessageId || retry[0]?.logicalMessageId !== failed?.logicalMessageId
      || !failed?.queueItemId || retry[0]?.queueItemId !== failed.queueItemId
      || failed.pageSessionId !== retry[0]?.pageSessionId
      || JSON.stringify(failed.targetIds) !== JSON.stringify(retry[0]?.targetIds)
      || JSON.stringify(failed.texts) !== JSON.stringify(retry[0]?.texts)) {
    issues.push('retry did not retain the failed QueueManager item, message, Page session and target identity');
  }
  if (!a?.networkId || !b?.networkId || a.networkId === b.networkId
      || !a.messageId || !b.messageId || a.messageId === b.messageId
      || failed?.attemptId !== a?.attemptId || failed?.logicalMessageId !== a?.messageId
      || JSON.stringify(failed?.targetIds) !== JSON.stringify(a?.targetIds)
      || a.sessionId !== b.sessionId || a.sessionId !== failed?.pageSessionId
      || evidence.arm?.sessionId !== failed?.pageSessionId
      || !armedResolver?.present || armedResolver.resolutionPending !== false
      || !armedResolver.effectiveSourceLanguage || armedResolver.effectiveSourceLanguage === 'auto'
      || !armedResolver.effectiveTargetLanguage
      || a.source !== armedResolver.effectiveSourceLanguage || b.source !== armedResolver.effectiveSourceLanguage
      || a.target !== armedResolver.effectiveTargetLanguage || b.target !== armedResolver.effectiveTargetLanguage
      || !Array.isArray(a.targetIds) || !a.targetIds.length || !Array.isArray(b.targetIds) || !b.targetIds.length
      || a.targetIds.some(id => b.targetIds.includes(id))
      || a.fetchHeldAt429 !== true || b.heldThroughCooldownEstablished !== true) issues.push('A/B did not overlap with distinct same-session roots and disjoint target IDs');
  if (evidence.unnecessaryRetransmits?.length) issues.push('unnecessary Custom provider retransmissions were observed');
  if (!Number.isFinite(a?.physicalStartedWallMs) || !Number.isFinite(b?.physicalStartedWallMs)
      || !Number.isFinite(a?.physicalStartedMonoMs) || !Number.isFinite(b?.physicalStartedMonoMs)
      || !Number.isFinite(failed?.responseWallMs) || !Number.isFinite(failed?.responseMonoMs)
      || !(a?.physicalStartedWallMs < failed?.responseWallMs)
      || !(a?.physicalStartedMonoMs < failed?.responseMonoMs)
      || !(b?.physicalStartedWallMs < failed?.responseWallMs)
      || !Number.isFinite(b?.responseReleasedWallMs)
      || !(b.responseReleasedWallMs > cooldown?.establishedWallMs)
      || !(b?.physicalStartedMonoMs < b?.responseReleasedMonoMs)) {
    issues.push('A/B physical overlap lacks correlated wall/monotonic clock anchors');
  }
  if (!Number.isFinite(evidence.serverRetryAt) || !Number.isFinite(evidence.limiterRetryAt)
      || !Number.isFinite(failed?.responseWallMs)
      || evidence.serverRetryAt + clockPrecisionToleranceMs < failed.responseWallMs + 5000
      || evidence.limiterRetryAt < evidence.serverRetryAt
      || !Number.isFinite(cooldown?.establishedWallMs)
      || cooldown.establishedWallMs > evidence.limiterRetryAt
      || cooldown.establishedWallMs < failed?.responseWallMs
      || !Number.isFinite(cooldown?.establishedMonoMs)
      || !Number.isFinite(cooldown?.limiterRetryAtMonoMs)
      || cooldown.establishedMonoMs < failed?.responseMonoMs
      || cooldown.limiterRetryAtMonoMs < cooldown.establishedMonoMs
      || evidence.serverRetryAt !== failed?.queueRetryAt
      || evidence.limiterRetryAt !== cooldown?.limiterRetryAt) issues.push('server and limiter Retry-After deadlines are missing, inconsistent, or too short');
  if (cooldown?.retainedAfterSiblingSuccess !== true
      || evidence.limiterRetryAtAfterSibling !== evidence.limiterRetryAt) issues.push('successful sibling changed or cleared the shared limiter deadline');
  if (!evidence.sibling?.success || evidence.sibling.messageId !== b?.messageId
      || evidence.sibling.sessionId !== b?.sessionId
      || !(evidence.sibling.completedWallMs > cooldown?.establishedWallMs)
      || !(evidence.sibling.completedWallMs < evidence.limiterRetryAt)
      || !(evidence.sibling.queueSettledAt > cooldown?.establishedWallMs)
      || !(evidence.sibling.queueSettledAt < evidence.limiterRetryAt)
      || evidence.sibling.rootStatus !== 'fulfilled') {
    issues.push('B did not complete Network and successful worker settlement inside the established cooldown');
  }
  if (!pending?.messageId || pending.messageId === a?.messageId || pending.messageId === b?.messageId
      || pending.sessionId !== failed?.pageSessionId
      || !Number.isFinite(pending.observedAtWallMs) || pending.observedAtWallMs < cooldown?.establishedWallMs
      || pending.observedAtWallMs <= evidence.sibling?.completedWallMs
      || pending.observedAtWallMs >= evidence.limiterRetryAt
      || !Number.isFinite(pending.activeRequests) || !Number.isFinite(pending.capacity)
      || pending.activeRequests >= pending.capacity
      || evidence.pendingStillQueuedAfterSibling !== true) issues.push('pending limiter request P lacks same-session identity or spare-capacity evidence');
  const prematurePhysicalStarts = evidence.attempts?.filter(attempt =>
    attempt.attemptId !== failed?.attemptId
    && Number.isFinite(attempt.physicalStartedMonoMs)
    && attempt.physicalStartedMonoMs >= failed?.responseMonoMs
    && attempt.physicalStartedMonoMs < cooldown?.limiterRetryAtMonoMs) ?? [];
  if (evidence.prematurePhysicalStarts?.length || prematurePhysicalStarts.length) {
    issues.push('physical provider request started before the shared cooldown deadline');
  }
  if (!Number.isFinite(retry[0]?.physicalStartedWallMs) || !Number.isFinite(retry[0]?.physicalStartedMonoMs)
      || retry[0].physicalStartedMonoMs + clockPrecisionToleranceMs < cooldown?.limiterRetryAtMonoMs) {
    issues.push('retry physical request started before the limiter deadline or lacks correlated wall/monotonic clocks');
  }
  if (evidence.attempts?.some(attempt => !Number.isFinite(attempt.physicalStartedWallMs)
      || !Number.isFinite(attempt.physicalStartedMonoMs))) issues.push('physical start lacks correlated Network wall/monotonic clocks');
  if (evidence.queueRetryEvidence?.observed?.errorType !== 'RATE_LIMIT_REACHED'
      || evidence.queueRetryEvidence?.observed?.attemptLimit !== 5
      || evidence.queueRetryEvidence?.observed?.attempts?.[0] !== 1
      || evidence.queueRetryEvidence?.observed?.attempts?.[1] !== 2
      || evidence.queueRetryEvidence?.observed?.queueItemId !== failed?.queueItemId
      || evidence.queueRetryEvidence?.observed?.serverRetryAt !== evidence.serverRetryAt) {
    issues.push('QueueManager did not prove one RATE_LIMIT_REACHED retry with attempt limit 5');
  }
  if (evidence.queueRetryEvidence?.ok !== true) issues.push(...(evidence.queueRetryEvidence?.issues ?? ['QueueManager retry evidence is unavailable']));
  if (evidence.translation?.exact !== true || evidence.translation?.duplicates !== 0
      || evidence.translation?.targetCount !== 1000 || evidence.translation?.restoreExact !== true
      || evidence.translation?.sourceCount !== 1000 || evidence.translation?.terminal !== true
      || evidence.translation?.sessionOwner !== failed?.pageSessionId
      || evidence.translation?.duplicateAcceptedIds?.length
      || evidence.translation?.acceptedTargetCount !== 1000) issues.push('exact source/target count, accepted DOM uniqueness, session owner, terminal or Restore evidence failed');
  if (!Number.isFinite(evidence.concurrency?.peakPhysical) || evidence.concurrency.peakPhysical > 2
      || !Number.isFinite(evidence.concurrency?.peakLogical) || evidence.concurrency.peakLogical > 2) {
    issues.push('logical or physical concurrency exceeded two or lacks evidence');
  }
  if (evidence.cleanup?.ok !== true) issues.push('runtime resources did not settle cleanly');
  return { ok: issues.length === 0, issues };
}

export function selectResolvedGoogleAttempt({ request, classification, resolver, failedCount }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'googlev2'
      || failedCount !== 0 || !request?.networkId) return { selected: false, reason: 'not-first-google-physical-attempt' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  if (request.sourceLanguage && request.sourceLanguage !== resolver.effectiveSourceLanguage) {
    return { selected: false, reason: 'request-source-does-not-match-resolved-page-source' };
  }
  return { selected: true, source: resolver.effectiveSourceLanguage, target: resolver.effectiveTargetLanguage };
}

export function selectResolvedGoogleTimeoutBatch({ request, classification, resolver, roots = [], failedCount, armed = false }) {
  if (!armed) return { selected: false, reason: 'initial-band-not-yet-accepted' };
  const selected = selectResolvedGoogleAttempt({ request, classification, resolver, failedCount });
  if (!selected.selected) return selected;
  const matches = roots.filter(root => root.sessionId === request.sessionId
    && typeof root.messageId === 'string' && root.messageId
    && Array.isArray(root.texts) && JSON.stringify(root.texts) === JSON.stringify(request.texts));
  const targetIds = request.targetIds;
  if (request.texts?.length !== 25 || matches.length !== 1
      || !Array.isArray(targetIds) || targetIds.length !== 25
      || targetIds.some(id => typeof id !== 'string') || new Set(targetIds).size !== 25) {
    return { selected: false, reason: 'batch-size-or-logical-correlation-not-unique' };
  }
  return { ...selected, selected: true, messageId: matches[0].messageId,
    sessionId: matches[0].sessionId, targetIds: [...targetIds], texts: [...request.texts] };
}

export function requireGoogleTimeoutReservation(reservation) {
  if (typeof reservation?.hold !== 'function' || typeof reservation.waitForRelease !== 'function'
      || typeof reservation.release !== 'function') {
    throw new Error('Google timeout probe requires a request-lifecycle Fetch reservation.');
  }
  return reservation;
}

export function claimGoogleTimeoutRequest(protocol) {
  if (!protocol || protocol.claimed || protocol.held) return false;
  protocol.claimed = true;
  return true;
}

export function commitGoogleTimeoutRequest(protocol, hold) {
  if (!protocol?.claimed || protocol.held || !hold) return false;
  protocol.held = hold;
  protocol.claimed = false;
  return true;
}

export function findGoogleTimeoutCancelMessage(operations, messageId, sessionId) {
  return (operations ?? []).find(item => item.kind === 'runtime.cancel.send'
    && item.action === 'CANCEL_TRANSLATION' && item.messageId === messageId
    && (item.targetSessionId == null || item.targetSessionId === sessionId)
    && item.status === 'fulfilled' && item.response?.success === true) ?? null;
}

export function findGoogleTimeoutBatchError(operations, sessionId, targetIds) {
  const matchesTargets = item => JSON.stringify(item?.targetIds) === JSON.stringify(targetIds);
  const batches = (operations ?? []).filter(item => item.kind === 'scheduler.batch'
    && item.sessionId === sessionId && matchesTargets(item));
  const errors = (operations ?? []).filter(item => item.kind === 'scheduler.batch.error'
    && item.sessionId === sessionId && matchesTargets(item) && item.errorType === 'OPERATION_TIMEOUT');
  if (batches.length !== 1 || errors.length !== 1) return null;
  const [batch] = batches;
  const [error] = errors;
  if (batch.status !== 'fulfilled' || !Number.isFinite(batch.settledAt)) return null;
  return {
    ...error,
    startedAt: batch.startedAt,
    settledAt: error.wallTime,
    schedulerBatchStatus: batch.status,
    schedulerBatchSettledAt: batch.settledAt ?? null,
  };
}

export function validateGoogleTimeoutEvidence(evidence) {
  const issues = [];
  const held = evidence.heldRequest;
  const timedOut = evidence.timeout;
  const cancel = evidence.cancel;
  const serviceTimeout = evidence.serviceTimeout;
  const queue = evidence.queueAttemptEvidence;
  const attempts = evidence.attempts ?? [];
  const translation = evidence.translation ?? {};
  const expectedTargets = new Set(translation.expectedTargetIds ?? []);
  const elapsed = timedOut?.settledAt - timedOut?.startedAt;
  if (!held?.messageId || held?.sessionId !== evidence.sessionId || held?.method !== 'POST'
      || typeof held?.url !== 'string' || !held.url || typeof held?.requestBody !== 'string'
      || held?.targetIds?.length !== 25 || new Set(held?.targetIds ?? []).size !== 25) {
    issues.push('held Google request lacks one session-owned 25-target provider message');
  }
  if (timedOut?.errorType !== 'OPERATION_TIMEOUT' || timedOut?.sessionId !== evidence.sessionId
      || JSON.stringify(timedOut?.targetIds) !== JSON.stringify(held?.targetIds)
      || timedOut?.schedulerBatchStatus !== 'fulfilled'
      || !Number.isFinite(timedOut?.schedulerBatchSettledAt)
      || timedOut.schedulerBatchSettledAt < timedOut.settledAt
      || !Number.isFinite(elapsed) || elapsed < 59_000 || elapsed > 65_000
      || !Number.isFinite(held?.startedAt) || timedOut.startedAt > held.startedAt) {
    issues.push('affected batch did not surface production OPERATION_TIMEOUT after approximately 60 seconds');
  }
  if (cancel?.action !== 'CANCEL_TRANSLATION' || cancel?.messageId !== held?.messageId
      || cancel?.targetSessionId && cancel.targetSessionId !== evidence.sessionId
      || cancel?.status !== 'fulfilled' || cancel?.response?.success !== true
      || serviceTimeout?.messageId !== held?.messageId || serviceTimeout?.sessionId !== evidence.sessionId
      || serviceTimeout?.status !== 'fulfilled' || serviceTimeout?.controllerMatched !== true
      || serviceTimeout?.controllerAbortedBefore !== false || serviceTimeout?.controllerAbortedAfter !== true
      || serviceTimeout?.response?.handled !== true || serviceTimeout?.response?.success !== true) {
    issues.push('real cancellation did not acknowledge the exact affected message and Page session');
  }
  if (evidence.controller?.messageId !== held?.messageId || evidence.controller?.sessionId !== evidence.sessionId
      || evidence.controller?.sequence <= serviceTimeout?.sequence || evidence.controller?.aborted !== true) {
    issues.push('matching provider request controller abort was not observed after timeout');
  }
  if (evidence.providerRoot?.messageId !== held?.messageId || evidence.providerRoot?.status !== 'rejected'
      || evidence.providerRoot?.operationAborted !== true
      || evidence.providerRoot?.settledSequence <= evidence.controller?.sequence
      || evidence.physicalMatchCount !== 1
      || evidence.physical?.messageId !== held?.messageId || evidence.physical?.status !== 'rejected'
        || evidence.physical?.sessionId !== held?.sessionId
        || evidence.physical?.url !== held?.url || evidence.physical?.method !== held?.method
        || evidence.physical?.requestBody !== held?.requestBody
        || evidence.physical?.controllerAbortedAtEnd !== true
        || evidence.physical?.settledSequence <= evidence.controller?.sequence
        || !(evidence.physical?.operationAborted === true || evidence.physical?.abortReasonMatched === true)
        || evidence.physical.errorType === 'OPERATION_TIMEOUT') {
    issues.push('provider root and physical request did not settle after the matching abort');
  }
  if (evidence.classification?.userFacingType !== 'OPERATION_TIMEOUT'
      || evidence.classification?.userFacingName !== timedOut?.errorName
      || evidence.classification?.userFacingErrorType !== 'OPERATION_TIMEOUT'
      || evidence.classification?.internalAbortType !== 'OPERATION_ABORTED'
      || evidence.classification?.internalAbortName !== (evidence.physical?.errorName ?? null)) {
    issues.push('user-facing timeout and internal provider abort are not distinctly classified');
  }
  if (queue?.ok !== true) issues.push(...(queue?.issues ?? ['QueueManager single-attempt timeout evidence unavailable']));
  if (evidence.retries?.length || evidence.failovers?.length) issues.push('retry or provider failover was observed');
  if (evidence.unnecessaryRetransmits?.length) issues.push('affected timeout targets were retransmitted in another physical request');
  if (evidence.selectionFailures?.length) issues.push('eligible complete Google batch failed strict timeout selection');
  const selectedAttempts = attempts.filter(item => item.selected === true);
  const siblingAttempts = attempts.filter(item => item.selected !== true);
  const attemptIdentities = attempts.map(item => `${item.networkSessionId}:${item.networkId}`);
  const siblingAttemptIdentities = siblingAttempts.map(item => `${item.networkSessionId}:${item.networkId}`).sort();
  const siblingEvidenceIdentities = (evidence.siblingRequests ?? []).map(item => `${item.networkSessionId}:${item.networkId}`).sort();
  const physicalTargetCounts = new Map();
  for (const attempt of attempts) {
    if (!Array.isArray(attempt.targetIds) || !attempt.targetIds.length || attempt.targetIds.length > 25
        || new Set(attempt.targetIds).size !== attempt.targetIds.length
        || attempt.targetIds.some(id => typeof id !== 'string' || !expectedTargets.has(id))) {
      issues.push('physical Google attempt has invalid, duplicate, or out-of-fixture target IDs');
    }
    for (const id of attempt.targetIds ?? []) physicalTargetCounts.set(id, (physicalTargetCounts.get(id) ?? 0) + 1);
  }
  const duplicatePhysicalTargets = [...physicalTargetCounts].filter(([, count]) => count !== 1).map(([id]) => id);
  const missingPhysicalTargets = [...expectedTargets].filter(id => physicalTargetCounts.get(id) !== 1);
  if (expectedTargets.size !== 1000 || missingPhysicalTargets.length || duplicatePhysicalTargets.length) {
    issues.push('physical Google attempts do not cover every expected target exactly once');
  }
  if (!attempts.length || selectedAttempts.length !== 1
       || selectedAttempts[0]?.networkId !== held?.networkId
       || selectedAttempts[0]?.networkSessionId !== held?.networkSessionId
       || selectedAttempts[0]?.logicalMessageId !== held?.messageId
       || JSON.stringify(selectedAttempts[0]?.targetIds) !== JSON.stringify(held?.targetIds)
       || selectedAttempts[0]?.targetIds?.length !== 25
       || selectedAttempts[0]?.outcome !== 'failed'
       || siblingAttempts.some(item => item.outcome !== 'finished' || item.status !== 200)
       || evidence.siblingRequests?.length !== siblingAttempts.length
       || JSON.stringify(siblingEvidenceIdentities) !== JSON.stringify(siblingAttemptIdentities)
       || new Set((evidence.siblingRequests ?? []).map(item => `${item.networkSessionId}:${item.networkId}`)).size !== siblingAttempts.length
       || (evidence.siblingRequests ?? []).some(item => item.outcome !== 'finished' || item.status !== 200)
       || attemptIdentities.some(identity => identity.endsWith(':null') || identity.startsWith('null:'))
       || new Set(attemptIdentities).size !== attempts.length) {
    issues.push('expected exactly one selected held request and successful, uniquely correlated siblings');
  }
  if (evidence.concurrency?.peakPhysical > 2 || evidence.concurrency?.peakLogical > 2
      || !Number.isFinite(evidence.concurrency?.peakPhysical) || !Number.isFinite(evidence.concurrency?.peakLogical)) {
    issues.push('logical or physical concurrency exceeded two or is unavailable');
  }
  const expectedAccepted = [...expectedTargets].filter(id => !held?.targetIds?.includes(id));
  const observedAccepted = new Set(translation.acceptedWriteIds ?? []);
  const failedDOMIds = evidence.failedTargetDOM?.expected?.map(item => item?.[0]) ?? [];
  if (translation.targetCount !== 1000 || translation.acceptedTargetCount !== 975
      || translation.failedTargetCount !== 25 || translation.exact !== true
      || translation.restoreExact !== true || translation.failedSourcePreserved !== true
      || translation.failedTargetsUnmarked !== true || translation.acceptedWriteCount !== 975
      || translation.acceptedUniqueCount !== 975 || evidence.failedTargetDOM?.ok !== true
      || translation.terminal !== true || translation.sessionOwner !== evidence.sessionId
      || translation.duplicateAcceptedIds?.length
      || !Array.isArray(translation.acceptedWriteIds) || translation.acceptedWriteIds.length !== 975
      || translation.acceptedWriteIds.some(id => held?.targetIds?.includes(id))
      || new Set(translation.acceptedWriteIds).size !== 975
      || expectedTargets.size !== 1000 || expectedAccepted.length !== 975
      || expectedAccepted.some(id => !observedAccepted.has(id))
      || [...observedAccepted].some(id => !expectedTargets.has(id))
      || JSON.stringify(failedDOMIds) !== JSON.stringify(held?.targetIds)) {
    issues.push('Google timeout did not produce exact 975 accepted / 25 unchanged partial accounting and Restore');
  }
  if (evidence.cleanup?.ok !== true || evidence.cleanup?.heldFetchSettled !== true
      || evidence.cleanup?.handlersDrained !== true || evidence.cleanup?.handlerCount !== 0
      || evidence.cleanup?.heldFetch?.requestId !== held?.requestId
      || evidence.cleanup?.heldFetch?.handlerSettled !== true
      || !evidence.cleanup?.heldFetch?.releaseOutcome
      || !evidence.cleanup?.heldFetch?.releaseClassification
      || evidence.cleanup?.requestLifecycle?.ok !== true
      || evidence.cleanup?.resourceValidation?.ok !== true
      || evidence.cleanup?.contentDrain?.pendingOperations !== 0
      || evidence.cleanup?.workerDrain?.ledger?.pending !== 0
      || evidence.cleanup?.workerDrain?.providerRoots?.some(root => root.status === 'pending')) {
    issues.push('runtime resources or held Fetch handlers did not settle cleanly');
  }
  return { ok: issues.length === 0, issues };
}

export function validateGoogleTimeoutQueueEvidence(events, { messageId } = {}) {
  const matched = (events ?? []).filter(event => event.messageId === messageId
    && ['queueManager.processItem.start', 'queueManager.processItem.end'].includes(event.name));
  const starts = matched.filter(event => event.name.endsWith('.start'));
  const ends = matched.filter(event => event.name.endsWith('.end'));
  const start = starts[0];
  const end = ends[0];
  const issues = [];
  if (!messageId || starts.length !== 1 || ends.length !== 1) issues.push('expected exactly one QueueManager start and settlement for the affected timeout message');
  if (!start?.queueItemId || start.queueItemId !== end?.queueItemId || start.messageId !== messageId || end.messageId !== messageId) {
    issues.push('QueueManager timeout attempt did not retain one queue item and message ID');
  }
  if (start?.attemptNumber !== 1 || end?.attemptNumber !== 1 || end?.attempts !== 1
      || end?.status !== 'failed' || end?.retryTimerActive !== false) {
    issues.push('QueueManager timeout was not one terminal attempt without retry');
  }
  return { ok: issues.length === 0, issues, observed: { messageId: messageId ?? null, starts, ends } };
}

export function validateResilienceAccounting(evidence) {
  const issues = [];
  if (evidence.injected503?.length !== 1) issues.push('expected exactly one injected HTTP 503');
  const failed = evidence.injected503?.[0];
  if (failed?.status !== 503) issues.push('selected physical attempt did not receive HTTP 503');
  const retries = evidence.attempts?.filter(attempt => attempt.retryOf === failed?.attemptId) ?? [];
  const retry = retries[0];
  if (!failed || retries.length !== 1 || retry?.status !== 200) issues.push('injected attempt lacks exactly one successful physical retry');
  if (failed && retry && (failed.pageSessionId !== retry.pageSessionId
      || failed.targetIds?.join('\0') !== retry.targetIds?.join('\0')
      || failed.texts?.join('\0') !== retry.texts?.join('\0')
      || failed.logicalMessageId !== retry.logicalMessageId
      || failed.networkId === retry.networkId)) {
    issues.push('retry does not match failed logical targets and Page session');
  }
  if (!failed?.logicalMessageId || !retry?.logicalMessageId) issues.push('logical QueueManager message correlation is ambiguous');
  if (evidence.unnecessaryRetransmits?.length) issues.push('unnecessary sibling retransmits were observed');
  if (!evidence.siblingRequests?.some(attempt => attempt.status === 200)) issues.push('no independent sibling request was proven to proceed successfully');
  if (evidence.translation?.exact !== true || evidence.translation?.duplicates !== 0) issues.push('final translation is incomplete or duplicated');
  if (evidence.queueRetryEvidence?.ok !== true) issues.push(...(evidence.queueRetryEvidence?.issues ?? ['QueueManager retry ownership evidence is unavailable']));
  if (evidence.cleanup?.ok !== true) issues.push('runtime resources did not settle cleanly');
  return { ok: issues.length === 0, issues };
}

export function validateQueueRetryEvidence(events, { messageId, expectedErrorType = 'SERVER_ERROR', minDelayMs = 950, maxDelayMs = 2050, expectedAttemptLimit = 3 } = {}) {
  const issues = [];
  const matched = events.filter(event => event.messageId === messageId
    && ['queueManager.processItem.start', 'queueManager.processItem.end'].includes(event.name));
  const starts = matched.filter(event => event.name.endsWith('.start'));
  const ends = matched.filter(event => event.name.endsWith('.end'));
  if (!messageId || starts.length !== 2 || ends.length !== 2) {
    issues.push(`expected two QueueManager starts and settlements for ${messageId ?? 'missing messageId'}`);
  }
  const firstStart = starts[0];
  const retryStart = starts[1];
  const firstEnd = ends[0];
  const retryEnd = ends[1];
  const sameItem = firstStart?.queueItemId && firstStart.queueItemId === retryStart?.queueItemId
    && firstStart.queueItemId === firstEnd?.queueItemId && firstStart.queueItemId === retryEnd?.queueItemId;
  if (!sameItem) issues.push('QueueManager attempts did not retain one queue item ID');
  if (starts.some(event => event.messageId !== messageId) || ends.some(event => event.messageId !== messageId)) {
    issues.push('QueueManager message ID differs from the failed provider root');
  }
  if (firstStart?.attemptNumber !== 1 || retryStart?.attemptNumber !== 2
      || firstEnd?.attempts !== 1 || retryEnd?.attempts !== 2) {
    issues.push('QueueManager attempt sequence was not exactly 1 then 2');
  }
  if (retryStart?.attemptLimit !== expectedAttemptLimit || firstEnd?.attemptLimit !== expectedAttemptLimit || retryEnd?.attemptLimit !== expectedAttemptLimit) {
    issues.push(`QueueManager ${expectedErrorType} attempt limit was not observed as ${expectedAttemptLimit}`);
  }
  if (firstEnd?.status !== 'retrying' || firstEnd?.lastErrorType !== expectedErrorType
      || firstEnd?.retryTimerActive !== true || !Number.isFinite(firstEnd?.retryScheduledAt)) {
    issues.push('first QueueManager settlement did not schedule a SERVER_ERROR retry timer');
  }
  if (retryStart?.previousErrorType !== expectedErrorType
      || retryStart?.retryScheduledAt !== firstEnd?.retryScheduledAt) {
    issues.push('retry start was not linked to the SERVER_ERROR schedule');
  }
  if (retryEnd?.status !== 'completed' || retryEnd?.retryTimerActive !== false) {
    issues.push('retry QueueManager settlement did not complete and clear its timer');
  }
  const backoffMs = retryStart?.at - firstEnd?.retryScheduledAt;
  if (!Number.isFinite(backoffMs) || backoffMs < minDelayMs || backoffMs > maxDelayMs) {
    issues.push(`observed QueueManager retry delay is outside ${minDelayMs}-${maxDelayMs}ms`);
  }
  return {
    ok: issues.length === 0,
    issues,
    observed: { messageId, queueItemId: sameItem ? firstStart.queueItemId : null,
      attempts: starts.map(event => event.attemptNumber), attemptLimit: firstEnd?.attemptLimit ?? null,
      firstStatus: firstEnd?.status ?? null, errorType: firstEnd?.lastErrorType ?? null,
      serverRetryAt: firstEnd?.retryAt ?? null,
      retryScheduledAt: firstEnd?.retryScheduledAt ?? null, retryStartedAt: retryStart?.at ?? null,
      backoffMs: Number.isFinite(backoffMs) ? backoffMs : null,
      finalStatus: retryEnd?.status ?? null, retryTimerActiveAtSchedule: firstEnd?.retryTimerActive ?? null,
      retryTimerActiveAtEnd: retryEnd?.retryTimerActive ?? null, events: matched },
  };
}

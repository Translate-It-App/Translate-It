export function parseResilienceProbeSelection(value) {
  if (!value) return [];
  const selections = value.split(',').map(item => item.trim()).filter(Boolean);
  if (selections.length !== 1 || !['googlev2-503', 'custom-429', 'custom-400', 'gemini-structured-recovery'].includes(selections[0])) {
    throw new TypeError('BENCH_RESILIENCE_PROBES supports only googlev2-503, custom-429, custom-400, or gemini-structured-recovery.');
  }
  return selections;
}

export function shouldEnableResilienceQueueProbe(probe) {
  return probe === 'googlev2-503' || probe === 'custom-429' || probe === 'custom-400' || probe === 'gemini-structured-recovery';
}

export function validateResilienceProbeIsolation({ selected, probe, provider, optimizationLevel, modes, scenario, schedulingMode, competingProbe }) {
  if (!selected) return true;
  const custom = probe === 'custom-429' || probe === 'custom-400';
  const gemini = probe === 'gemini-structured-recovery';
  const selectedProvider = gemini ? 'gemini' : custom ? 'custom' : 'googlev2';
  if (competingProbe || provider !== selectedProvider || optimizationLevel !== 3
      || modes !== undefined && modes !== 'sliced'
      || scenario !== undefined && scenario !== 'scroll-through'
      || schedulingMode !== undefined && schedulingMode !== 'fluid') {
    throw new TypeError(`${gemini ? 'Gemini structured recovery' : custom ? 'Custom 429' : 'Google V2 503'} resilience probe requires an isolated ${gemini ? 'Gemini' : custom ? 'Custom' : 'Google V2'} Level 3 Sliced/scroll-through/Fluid run.`);
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

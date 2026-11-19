export function parseResilienceProbeSelection(value) {
  if (!value) return [];
  const selections = value.split(',').map(item => item.trim()).filter(Boolean);
  if (selections.length !== 1 || !['googlev2-503', 'custom-429'].includes(selections[0])) {
    throw new TypeError('BENCH_RESILIENCE_PROBES supports only googlev2-503 or custom-429.');
  }
  return selections;
}

export function shouldEnableResilienceQueueProbe(probe) {
  return probe === 'googlev2-503' || probe === 'custom-429';
}

export function validateResilienceProbeIsolation({ selected, probe, provider, optimizationLevel, modes, scenario, schedulingMode, competingProbe }) {
  if (!selected) return true;
  const custom = probe === 'custom-429';
  const selectedProvider = custom ? 'custom' : 'googlev2';
  if (competingProbe || provider !== selectedProvider || optimizationLevel !== 3
      || modes !== undefined && modes !== 'sliced'
      || scenario !== undefined && scenario !== 'scroll-through'
      || schedulingMode !== undefined && schedulingMode !== 'fluid') {
    throw new TypeError(`${custom ? 'Custom 429' : 'Google V2 503'} resilience probe requires an isolated ${custom ? 'Custom' : 'Google V2'} Level 3 Sliced/scroll-through/Fluid run.`);
  }
  return true;
}

export function selectResolvedCustomAttempt({ request, classification, resolver, failedCount }) {
  if (classification?.kind !== 'provider-translation' || classification.provider !== 'custom'
      || failedCount !== 0 || !request?.networkId) return { selected: false, reason: 'not-first-custom-physical-attempt' };
  if (!resolver?.present || resolver.resolutionPending !== false
      || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
      || !resolver.effectiveTargetLanguage) return { selected: false, reason: 'source-not-concretely-resolved' };
  return { selected: true, source: resolver.effectiveSourceLanguage, target: resolver.effectiveTargetLanguage };
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

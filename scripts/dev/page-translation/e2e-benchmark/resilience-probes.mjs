export function parseResilienceProbeSelection(value) {
  if (!value) return [];
  const selections = value.split(',').map(item => item.trim()).filter(Boolean);
  if (selections.length !== 1 || selections[0] !== 'googlev2-503') {
    throw new TypeError('BENCH_RESILIENCE_PROBES supports only googlev2-503.');
  }
  return selections;
}

export function shouldEnableResilienceQueueProbe(probe) {
  return probe === 'googlev2-503';
}

export function validateResilienceProbeIsolation({ selected, provider, optimizationLevel, modes, scenario, schedulingMode, competingProbe }) {
  if (!selected) return true;
  if (competingProbe || provider !== 'googlev2' || optimizationLevel !== 3
      || modes !== undefined && modes !== 'sliced'
      || scenario !== undefined && scenario !== 'scroll-through'
      || schedulingMode !== undefined && schedulingMode !== 'fluid') {
    throw new TypeError('Google V2 503 resilience probe requires an isolated Google V2 Level 3 Sliced/scroll-through/Fluid run.');
  }
  return true;
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

export function validateQueueRetryEvidence(events, { messageId, expectedErrorType = 'SERVER_ERROR', minDelayMs = 950, maxDelayMs = 2050 } = {}) {
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
  if (retryStart?.attemptLimit !== 3 || firstEnd?.attemptLimit !== 3 || retryEnd?.attemptLimit !== 3) {
    issues.push('QueueManager SERVER_ERROR attempt limit was not observed as 3');
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
      retryScheduledAt: firstEnd?.retryScheduledAt ?? null, retryStartedAt: retryStart?.at ?? null,
      backoffMs: Number.isFinite(backoffMs) ? backoffMs : null,
      finalStatus: retryEnd?.status ?? null, retryTimerActiveAtSchedule: firstEnd?.retryTimerActive ?? null,
      retryTimerActiveAtEnd: retryEnd?.retryTimerActive ?? null, events: matched },
  };
}

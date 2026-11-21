import { decodeCustomRequest } from '../custom-fixture.mjs';
import { findSessionOwnedPendingRequest, validateCustom429Evidence } from '../resilience-probes.mjs';

export function createCustom429Protocol() {
  return { armed: false, roles: new Map(), releaseStates: new Map(), error: null, evidence: { events: [] } };
}

export async function armCustom429({ protocol, resilienceEvidence, initialIds, sessionId, chrome, workerSession, pageSession, contentContext, evaluate, until, now }) {
  const armed = await until(async () => {
    const [resources, pageState] = await Promise.all([
      evaluate(chrome, workerSession,
        `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false),
      evaluate(chrome, pageSession, 'window.__pageTranslationBenchmark.pageSessionSnapshot()', contentContext, false),
    ]);
    const resolver = resources?.sourceResolvers?.[sessionId];
    if (!resolver?.present || resolver.resolutionPending !== false
        || !resolver.effectiveSourceLanguage || resolver.effectiveSourceLanguage === 'auto'
        || !resolver.effectiveTargetLanguage || pageState?.translationSessionId !== sessionId) return null;
    return { resolver, pageState };
  }, 60_000);
  protocol.armed = true;
  protocol.armedWallMs = now();
  protocol.initialTargetIds = new Set(initialIds);
  protocol.evidence.armed = {
    atWallMs: protocol.armedWallMs, sessionId, resolver: armed.resolver,
    pageTranslationSessionId: armed.pageState.translationSessionId, initialAcceptedTargetIds: initialIds,
  };
  resilienceEvidence.arm = protocol.evidence.armed;
}

export function claimCustom429Request({ protocol, event, request, requestRecord, now, providerNetworkEvents, fixtureConfig, classify }) {
  if (!protocol?.armed || protocol.roles.size >= 2 || !event.params.networkId) return;
  const classification = classify(request, event.sessionId);
  if (classification.kind !== 'provider-translation' || classification.provider !== 'custom') return;
  try {
    const network = providerNetworkEvents.get(`${event.sessionId}:${event.params.networkId}`);
    if (!Number.isFinite(network?.wallTime) || network.wallTime < protocol.armedWallMs) return;
    const decoded = decodeCustomRequest({
      method: request.method, url: request.url, body: request.postData ?? '',
      headers: request.headers ?? {}, expectedTexts: fixtureConfig.targetTexts,
    });
    const targetIds = decoded.texts.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
    const claimedIds = new Set([...protocol.roles.values()].flatMap(role => role.targetIds));
    if (!targetIds.every(Boolean) || targetIds.some(id => protocol.initialTargetIds.has(id))
        || targetIds.some(id => claimedIds.has(id))) return;
    const role = protocol.roles.size === 0 ? 'A' : 'B';
    protocol.roles.set(role, { event, requestRecord, networkId: event.params.networkId, targetIds, texts: decoded.texts });
    requestRecord.custom429Role = role;
    protocol.evidence.events.push({ type: 'claimed', role, at: now(), networkId: event.params.networkId, targetIds });
  } catch (error) {
    protocol.evidence.events.push({ type: 'claim-rejected', at: now(), reason: error.message });
  }
}

export async function executeCustom429Request({ custom429Protocol, classification, event, requestRecord, body, responseBody, fixtureConfig, pageSession, contentContext, evaluate, chrome, workerSession, sessionId, providerNetworkEvents, now, until, sameProviderTexts, resilienceEvidence, releaseCustomPaused }) {
if (custom429Protocol && classification.provider === 'custom') {
  if (requestRecord.custom429Role && fixtureConfig.scenario === 'scroll-through' && pageSession && contentContext) {
    const requestViewport = await evaluate(chrome, pageSession,
      `(()=>{const sources=${JSON.stringify(body)};return {at:performance.now(),scrollY,targets:sources.map(source=>{const el=[...document.querySelectorAll('[data-bench-id]')].find(node=>node.textContent===source);if(!el)return {source,id:null,classification:'unmapped'};const r=el.getBoundingClientRect();const visible=r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;const buffered=r.bottom>-50&&r.top<innerHeight+50&&r.right>-50&&r.left<innerWidth+50;return {source,id:el.dataset.benchId,classification:visible?'viewport':buffered?'permitted-50px-buffer':'outside-buffer'}})}})()`, contentContext, false);
    requestRecord.requestViewport = requestViewport;
  }
  const networkId = event.params.networkId ?? null;
  const resources = await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false);
  const resolver = resources?.sourceResolvers?.[sessionId];
  const roots = await evaluate(chrome, workerSession,
    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
  const matchingRoots = (roots?.providerRoots ?? []).filter(root => root.sessionId === sessionId
    && sameProviderTexts(root.texts, body));
  const logicalRoots = [...new Map(matchingRoots.map(root => [root.messageId, root])).values()];
  const root = logicalRoots.length === 1 ? logicalRoots[0] : null;
  const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const base = { attemptId: `resilience-${resilienceEvidence.attempts.length + 1}`, networkId,
    pageSessionId: sessionId, logicalMessageId: root?.messageId ?? null, texts: body, targetIds,
    physicalStartedWallMs: providerNetworkEvents.get(`${event.sessionId}:${networkId}`)?.wallTime ?? null,
    physicalStartedMonoMs: providerNetworkEvents.get(`${event.sessionId}:${networkId}`)?.startedAt ?? null,
    source: resolver?.effectiveSourceLanguage ?? null, target: resolver?.effectiveTargetLanguage ?? null };
  const failed = resilienceEvidence.injected429[0];
  if (failed && sameProviderTexts(failed.texts, body)) base.retryOf = failed.attemptId;
  resilienceEvidence.attempts.push(base);
  requestRecord.resilienceCorrelation = { ...base, resolver, matchingRootCount: logicalRoots.length };
  const role = requestRecord.custom429Role;
  if (!role) {
    if (requestRecord.response?.status === 200) base.status = 200;
  } else {
    const claim = custom429Protocol.roles.get(role);
    claim.correlation = { ...base, root, resolver, responseBody, requestRecord };
    const matchingClaims = ['A', 'B'].map(name => custom429Protocol.roles.get(name));
    if (matchingClaims.every(item => item?.correlation)) {
      const [a, b] = matchingClaims;
      const distinct = a.networkId !== b.networkId && a.event.sessionId === b.event.sessionId
        && a.correlation.root?.messageId && b.correlation.root?.messageId
        && a.correlation.root.messageId !== b.correlation.root.messageId
        && a.targetIds.every(id => !b.targetIds.includes(id));
      const resolved = [a, b].every(item => item.correlation.resolver?.present
        && item.correlation.resolver.resolutionPending === false
        && item.correlation.resolver.effectiveSourceLanguage
        && item.correlation.resolver.effectiveSourceLanguage !== 'auto'
        && item.correlation.resolver.effectiveTargetLanguage);
      if (!distinct || !resolved) throw new Error('Custom 429 roles A/B lack distinct same-session physical/root/target/AUTO correlation.');
      custom429Protocol.evidence.roles = {
        A: { attemptId: a.correlation.attemptId, networkId: a.networkId, messageId: a.correlation.root.messageId,
          sessionId: a.correlation.root.sessionId, targetIds: a.targetIds, physicalStartedWallMs: a.correlation.physicalStartedWallMs,
          physicalStartedMonoMs: a.correlation.physicalStartedMonoMs,
          source: a.correlation.resolver.effectiveSourceLanguage, target: a.correlation.resolver.effectiveTargetLanguage,
          fetchHeldAt429: true },
        B: { attemptId: b.correlation.attemptId, networkId: b.networkId, messageId: b.correlation.root.messageId,
          sessionId: b.correlation.root.sessionId, targetIds: b.targetIds, physicalStartedWallMs: b.correlation.physicalStartedWallMs,
          physicalStartedMonoMs: b.correlation.physicalStartedMonoMs,
          source: b.correlation.resolver.effectiveSourceLanguage, target: b.correlation.resolver.effectiveTargetLanguage,
          heldThroughCooldownEstablished: true },
      };
      custom429Protocol.evidence.events.push({ type: 'roles-correlated', at: now() });
    }
    await until(() => {
      if (custom429Protocol.error) throw custom429Protocol.error;
      return custom429Protocol.roles.get('A')?.correlation && custom429Protocol.roles.get('B')?.correlation;
    }, 10_000);
    if (role === 'A') {
      const a = custom429Protocol.roles.get('A');
      const failure = {
        attemptId: a.correlation.attemptId, networkId: a.networkId,
        pageSessionId: a.correlation.root.sessionId, logicalMessageId: a.correlation.root.messageId,
        texts: [...a.correlation.texts], targetIds: [...a.targetIds],
        physicalStartedWallMs: a.correlation.physicalStartedWallMs,
        physicalStartedMonoMs: a.correlation.physicalStartedMonoMs,
        source: a.correlation.resolver.effectiveSourceLanguage,
        target: a.correlation.resolver.effectiveTargetLanguage,
        status: 429, retryAfterSeconds: 5,
      };
      resilienceEvidence.injected429.push(failure);
      a.requestRecord.resilienceInjected429 = failure;
      await releaseCustomPaused('A', 429, { error: { code: 429, message: 'Benchmark injected rate limit' } },
        [{ name: 'Content-Type', value: 'application/json' }, { name: 'Retry-After', value: '5' }]);
      failure.retryAfterHeader = a.requestRecord.response?.retryAfter ?? null;
      const responseNetwork = await until(() => {
        const network = providerNetworkEvents.get(`${a.event.sessionId}:${a.networkId}`);
        return network?.status === 429 && Number.isFinite(network.responseWallTime)
          ? network : null;
      }, 10_000);
      failure.responseWallMs = responseNetwork.responseWallTime;
      failure.responseMonoMs = responseNetwork.responseAtMonoMs;
      custom429Protocol.evidence.responseWallMs = failure.responseWallMs;
      const cooldown = await until(async () => {
        const [snapshot, trace] = await Promise.all([
          evaluate(chrome, workerSession,
            `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false),
          evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.snapshot()', undefined, false),
        ]);
        const itemEnd = trace?.events?.find(item => item.name === 'queueManager.processItem.end'
          && item.messageId === a.correlation.root.messageId && item.status === 'retrying'
          && item.lastErrorType === 'RATE_LIMIT_REACHED');
        const rate = snapshot?.rateLimit?.Custom;
        return itemEnd && Number.isFinite(itemEnd.retryAt) && Number.isFinite(rate?.retryAt)
          ? { itemEnd, rate } : null;
      }, 10_000);
      custom429Protocol.evidence.serverRetryAt = cooldown.itemEnd.retryAt;
      custom429Protocol.evidence.limiterRetryAt = cooldown.rate.retryAt;
      custom429Protocol.evidence.cooldownEstablishedWallMs = cooldown.itemEnd.at;
      custom429Protocol.evidence.cooldownCapacity = {
        activeRequests: cooldown.rate.activeRequests, capacity: cooldown.rate.capacity,
        observedAtWallMs: cooldown.rate.now,
      };
      failure.queueRetryAt = cooldown.itemEnd.retryAt;
      failure.queueItemId = cooldown.itemEnd.queueItemId;
      const b = custom429Protocol.roles.get('B');
      custom429Protocol.evidence.roles.B.responseReleasedWallMs = now();
      custom429Protocol.evidence.roles.B.responseReleasedMonoMs =
        b.correlation.physicalStartedMonoMs + custom429Protocol.evidence.roles.B.responseReleasedWallMs
          - b.correlation.physicalStartedWallMs;
      await releaseCustomPaused('B', 200, b.correlation.responseBody);
      const limiterDeadline = cooldown.rate.retryAt;
      const sibling = await until(async () => {
        const [network, snapshot, state] = await Promise.all([
          Promise.resolve(providerNetworkEvents.get(`${b.event.sessionId}:${b.networkId}`)),
          evaluate(chrome, workerSession,
            `globalThis.__pageTranslationBenchmark.cancellationSnapshot()`, undefined, false),
          evaluate(chrome, workerSession, 'globalThis.__pageTranslationBenchmark.snapshot()', undefined, false),
        ]);
        const end = state?.events?.find(item => item.name === 'queueManager.processItem.end'
          && item.messageId === b.correlation.root.messageId && item.status === 'completed');
        const rootState = state?.events?.length && (await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.cancellationSnapshot()`, undefined, false))
          ?.providerRoots?.find(item => item.messageId === b.correlation.root.messageId);
        if (network?.status === 200 && network.outcome === 'finished' && end && rootState?.status === 'fulfilled') {
          const completedWallMs = network.wallTime + network.settledAt - network.startedAt;
          if (completedWallMs >= limiterDeadline) throw new Error('Custom 429 B settled at or after unchanged limiter deadline.');
          return { network, end, rootState, completedWallMs };
        }
        return null;
      }, 10_000);
      custom429Protocol.evidence.sibling = {
        success: true, messageId: b.correlation.root.messageId, sessionId,
        networkId: b.networkId, completedWallMs: sibling.completedWallMs,
        queueSettledAt: sibling.end.at, rootStatus: sibling.rootState.status,
      };
      const after = await until(async () => {
        const snapshot = await evaluate(chrome, workerSession,
          `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false);
        const rate = snapshot?.rateLimit?.Custom;
        const pending = findSessionOwnedPendingRequest(rate?.queueItems, sessionId,
          [a.correlation.root.messageId, b.correlation.root.messageId]);
        if (!pending || !Number.isFinite(rate?.retryAt) || rate.retryAt !== limiterDeadline
            || !(rate.activeRequests < rate.capacity) || !(rate.now < limiterDeadline)) return null;
        return { rate, pending };
      }, 10_000);
      custom429Protocol.evidence.pending = { ...after.pending, observedAtWallMs: after.rate.now,
        activeRequests: after.rate.activeRequests, capacity: after.rate.capacity };
      custom429Protocol.evidence.pendingObservedBeforeDeadline = after.rate.now < limiterDeadline;
      custom429Protocol.evidence.limiterRetryAtAfterSibling = after.rate.retryAt;
      custom429Protocol.evidence.pendingStillQueuedAfterSibling = !!after.rate.queueItems?.some(item =>
        item.messageId === after.pending.messageId && item.sessionId === sessionId);
      custom429Protocol.evidence.events.push({ type: 'B-settled', at: now() });
      resilienceEvidence.cooldownObserved = custom429Protocol.evidence;
      resilienceEvidence.pendingLimiterSibling = custom429Protocol.evidence.pending;
      resilienceEvidence.siblingObserved = custom429Protocol.evidence.sibling;
    }
    base.status = role === 'A' ? 429 : 200;
    return true;
  }
}
  return false;
}

export function collectCustom429Evidence({ evidence, protocol, failed, resources, workerTrace, providerAttempts, providerNetworkEvents, sessionId, providerPhysicalAttempts, traceEvents, summarizePhysicalProviderAttempts, validateQueueRetryEvidence, peakLogicalConcurrency }) {
  const resilienceEvidence = evidence;
  const failedTargetIds = new Set(failed?.targetIds ?? []);
  const resilienceProbe = 'custom-429';
if (resilienceProbe === 'custom-429') {
       for (const attempt of resilienceEvidence.attempts) {
         const request = providerAttempts.find(item => item.resilienceCorrelation?.attemptId === attempt.attemptId);
         const physical = request?.physicalAttempt;
         if (physical && Number.isFinite(physical.startedAt) && Number.isFinite(physical.settledAt)) {
           const network = providerNetworkEvents.get(`${request.targetSessionId}:${request.networkId}`);
           attempt.physicalEndedWallMs = Number.isFinite(network?.wallTime)
             ? network.wallTime + physical.settledAt - physical.startedAt : null;
         }
         const queueEvents = traceEvents(workerTrace).filter(event => event.messageId === attempt.logicalMessageId
           && event.name === 'queueManager.processItem.start');
         attempt.queueItemId = queueEvents.find(event => event.attemptNumber === (attempt.retryOf ? 2 : 1))?.queueItemId ?? null;
       }
     }
     resilienceEvidence.siblingRequests = resilienceEvidence.attempts.filter(attempt => attempt.status === 200
       && attempt.pageSessionId === failed?.pageSessionId
       && attempt.targetIds?.length && attempt.targetIds.every(id => !failedTargetIds.has(id)));
     const resourceRate = resources?.rateLimit?.Custom;
     if (resilienceProbe === 'custom-429') {
       const itemEvent = traceEvents(workerTrace).find(event => event.messageId === failed?.logicalMessageId
         && event.name === 'queueManager.processItem.end' && event.status === 'retrying');
       const itemId = itemEvent?.queueItemId ?? null;
       failed.queueItemId = itemId;
       failed.queueRetryAt = itemEvent?.retryAt ?? null;
       for (const attempt of resilienceEvidence.attempts) {
         const start = traceEvents(workerTrace).find(event => event.messageId === failed?.logicalMessageId
           && event.name === 'queueManager.processItem.start' && event.attemptNumber === 2);
         if (attempt.retryOf === failed?.attemptId) {
           attempt.queueItemId = start?.queueItemId ?? itemId;
           attempt.physicalStartedWallMs ??= null;
         }
       }
       const customQueueEvidence = validateQueueRetryEvidence(traceEvents(workerTrace), {
         messageId: failed?.logicalMessageId, expectedErrorType: 'RATE_LIMIT_REACHED',
         minDelayMs: 4900, maxDelayMs: Number.MAX_SAFE_INTEGER, expectedAttemptLimit: 5,
       });
       resilienceEvidence.queueRetryEvidence = customQueueEvidence;
       resilienceEvidence.pendingLimiterSibling ??= resourceRate?.queueItems?.find(item =>
         item.messageId !== failed?.logicalMessageId && item.sessionId === sessionId) ?? null;
       resilienceEvidence.cooldown = {
         establishedWallMs: itemEvent?.at ?? null,
         establishedMonoMs: Number.isFinite(failed?.responseMonoMs) && Number.isFinite(itemEvent?.at)
           ? failed.responseMonoMs + itemEvent.at - failed.responseWallMs : null,
         limiterRetryAt: resilienceEvidence.cooldownObserved?.limiterRetryAt ?? null,
         limiterRetryAtMonoMs: Number.isFinite(failed?.responseMonoMs)
           && Number.isFinite(resilienceEvidence.cooldownObserved?.limiterRetryAt)
           ? failed.responseMonoMs + resilienceEvidence.cooldownObserved.limiterRetryAt - failed.responseWallMs : null,
         retainedAfterSiblingSuccess: resilienceEvidence.cooldownObserved?.limiterRetryAtAfterSibling
           === resilienceEvidence.cooldownObserved?.limiterRetryAt,
       };
       const sibling = resilienceEvidence.siblingRequests.find(attempt => attempt.physicalEndedWallMs != null);
       resilienceEvidence.sibling = resilienceEvidence.siblingObserved
         ?? (sibling ? { success: true, completedWallMs: sibling.physicalEndedWallMs, attemptId: sibling.attemptId } : null);
       const retryAttempt = resilienceEvidence.attempts.find(attempt => attempt.retryOf === failed?.attemptId);
       if (retryAttempt) retryAttempt.physicalStartedWallMs ??= null;
       resilienceEvidence.prematurePhysicalStarts = resilienceEvidence.attempts.filter(attempt =>
         Number.isFinite(attempt.physicalStartedMonoMs)
         && attempt.physicalStartedMonoMs >= failed.responseMonoMs
         && attempt.physicalStartedMonoMs < resilienceEvidence.cooldown.limiterRetryAtMonoMs
         && attempt.attemptId !== failed?.attemptId);
       resilienceEvidence.pendingLimiterSibling ??= resourceRate?.queueItems?.find(item =>
         item.messageId !== failed?.logicalMessageId && item.sessionId === sessionId) ?? null;
        resilienceEvidence.roles = protocol.evidence.roles;
        resilienceEvidence.serverRetryAt = protocol.evidence.serverRetryAt;
        resilienceEvidence.limiterRetryAt = protocol.evidence.limiterRetryAt;
        resilienceEvidence.limiterRetryAtAfterSibling = protocol.evidence.limiterRetryAtAfterSibling;
        resilienceEvidence.pendingStillQueuedAfterSibling = protocol.evidence.pendingStillQueuedAfterSibling;
        resilienceEvidence.cooldown.establishedWallMs = protocol.evidence.cooldownEstablishedWallMs;
        resilienceEvidence.cooldown.limiterRetryAt = protocol.evidence.limiterRetryAt;
       const physicalSummary = summarizePhysicalProviderAttempts(providerPhysicalAttempts.map(attempt => {
         const network = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
         return { ...attempt, startedAt: network?.startedAt ?? null, settledAt: network?.settledAt ?? null,
           status: network?.status ?? null, outcome: network?.outcome ?? null };
       }));
       resilienceEvidence.concurrency = {
         peakPhysical: physicalSummary.peakPhysicalConcurrency,
          peakLogical: peakLogicalConcurrency ?? null,
       };
     }

}

export function validateCustom429ProbeEvidence(evidence) {
  return validateCustom429Evidence(evidence);
}

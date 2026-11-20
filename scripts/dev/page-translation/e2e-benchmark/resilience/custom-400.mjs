import { isCustom400ProbeWindowRequest, selectResolvedCustom400Batch, validateCustom400Evidence } from '../resilience-probes.mjs';
import { fulfillPausedFetch } from '../network-interception.mjs';

export function createCustom400Protocol() {
  return {
    armed: false, considered: false, injected: false, initialTargetIds: [],
    evidence: { injected400: [], attempts: [], selectionFailures: [], unexpectedRecovery: [], queueRetries: [], keyFailovers: [], circuitBreakers: [] },
  };
}

export function recordCustom400PreRestorePreArmDrain(protocol, requests, providerNetworkEvents) {
  const preArmRequests = requests.filter(request => request.category === 'provider-translation'
    && request.startedAt < protocol.armedWallMs);
  const outstanding = preArmRequests.filter(request => {
    const network = providerNetworkEvents.get(`${request.targetSessionId}:${request.networkId}`);
    return !Number.isFinite(request.endedAt) || !['finished', 'failed'].includes(network?.outcome);
  });
  if (outstanding.length) return false;
  protocol.evidence.preRestorePreArmDrain = {
    ok: true, requestCount: preArmRequests.length, outstandingCount: 0,
    networkIds: preArmRequests.map(request => request.networkId ?? null),
  };
  return true;
}

export function recordCustom400FailedTargetDOM(protocol, evidence) {
  protocol.evidence.failedTargetDOM = evidence;
}

export async function armCustom400({ protocol, resilienceEvidence, initialIds, sessionId, chrome, workerSession, pageSession, contentContext, evaluate, until, now }) {
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
  protocol.initialTargetIds = [...initialIds];
  resilienceEvidence.arm = {
    atWallMs: now(), sessionId, resolver: armed.resolver,
    pageTranslationSessionId: armed.pageState.translationSessionId, initialAcceptedTargetIds: initialIds,
  };
  protocol.evidence.arm = resilienceEvidence.arm;
}

export async function executeCustom400({
  protocol, event, requestId, requestRecord, classification, texts, fixtureConfig, sessionId, sendBySession,
  providerNetworkEvents, chrome, workerSession, pageSession, contentContext, evaluate, now, sameProviderTexts,
}) {
  if (!protocol?.armed || !isCustom400ProbeWindowRequest(requestRecord, protocol.armedWallMs)) return false;
  const consider400 = !protocol.considered;
  if (consider400) protocol.considered = true;
  const networkId = event.params.networkId ?? null;
  const startedWallMs = providerNetworkEvents.get(`${event.sessionId}:${networkId}`)?.wallTime ?? null;
  const resources = await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.resourceSnapshot([], [${JSON.stringify(sessionId)}])`, undefined, false);
  const snapshot = await evaluate(chrome, workerSession,
    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
  const resolver = resources?.sourceResolvers?.[sessionId];
  const targetIds = texts.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const selection = consider400 ? selectResolvedCustom400Batch({
    request: {
      networkId, sessionId, texts, targetIds,
      physicalStartedWallMs: Number.isFinite(startedWallMs) ? startedWallMs : requestRecord.startedAt,
    },
    classification, resolver, roots: snapshot?.providerRoots ?? [],
    failedCount: protocol.injected ? 1 : 0, initialTargetIds: protocol.initialTargetIds,
    armedWallMs: protocol.armedWallMs,
  }) : { selected: false, reason: 'request-started-before-arm' };
  if (consider400 && !selection.selected) protocol.evidence.selectionFailures.push({
    reason: selection.reason, networkId, targetIds, texts,
  });
  const roots = (snapshot?.providerRoots ?? []).filter(root => root.sessionId === sessionId
    && sameProviderTexts(root.texts, texts));
  const root = roots.length === 1 ? roots[0] : null;
  const attempt = {
    attemptId: `custom-400-${protocol.evidence.attempts.length + 1}`,
    networkId, networkSessionId: event.sessionId, logicalMessageId: root?.messageId ?? null,
    pageSessionId: sessionId, targetIds, texts, status: 200,
  };
  protocol.evidence.attempts.push(attempt);
  if (!selection.selected) return false;
  protocol.injected = true;
  attempt.status = 400;
  const failure = {
    ...attempt, status: 400, selectedAt: now(),
    errorBody: { error: { code: 400, message: 'Invalid request parameters' } },
    source: selection.source, target: selection.target,
  };
  protocol.evidence.injected400.push(failure);
  requestRecord.custom400Failure = failure;
  if (fixtureConfig.scenario === 'scroll-through' && pageSession && contentContext) {
    requestRecord.requestViewport = await evaluate(chrome, pageSession,
      `(()=>{const sources=${JSON.stringify(texts)};return {at:performance.now(),scrollY,targets:sources.map(source=>{const el=[...document.querySelectorAll('[data-bench-id]')].find(node=>node.textContent===source);if(!el)return {source,id:null,classification:'unmapped'};const r=el.getBoundingClientRect();const visible=r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;const buffered=r.bottom>-50&&r.top<innerHeight+50&&r.right>-50&&r.left<innerWidth+50;return {source,id:el.dataset.benchId,classification:visible?'viewport':buffered?'permitted-50px-buffer':'outside-buffer'}})}})()`,
      contentContext, false);
  }
  await fulfillPausedFetch({
    send: sendBySession.get(event.sessionId), sessionId: event.sessionId, requestId, status: 400,
    headers: [{ name: 'Content-Type', value: 'application/json' }], body: failure.errorBody,
    requestRecord, now, response: {},
  });
  return true;
}

export function collectCustom400Evidence({ protocol, evidence, providerAttempts, providerNetworkEvents, providerPhysicalAttempts, fixtureConfig, workerTrace, traceEvents, summarizePhysicalProviderAttempts, validateCustom400QueueEvidence, isCustom400ProbeWindowRequest, expectedLogicalBatchCount, peakLogicalConcurrency, effectiveProviderLimiterCapacity }) {
  const custom400Protocol = protocol;
  const resilienceEvidence = evidence;
  const resilienceProbe = 'custom-400';
if (resilienceProbe === 'custom-400') {
       const workerEvents = traceEvents(workerTrace);
       const failed = custom400Protocol.evidence.injected400[0];
       const request = providerAttempts.find(item => item.networkId === failed?.networkId);
       const network = request ? providerNetworkEvents.get(`${request.targetSessionId}:${request.networkId}`) : null;
       if (failed) {
         failed.networkStatus = network?.status ?? null;
         failed.networkOutcome = network?.outcome ?? null;
         failed.queueItemId = workerEvents.find(event => event.messageId === failed.logicalMessageId
           && event.name === 'queueManager.processItem.start')?.queueItemId ?? null;
       }
       resilienceEvidence.injected400 = custom400Protocol.evidence.injected400;
       resilienceEvidence.selectionFailures = custom400Protocol.evidence.selectionFailures;
       const sourceToFixtureId = new Map(fixtureConfig.targets.map(target => [target.source, target.id]));
       const probeWindowPhysicalAttempts = providerAttempts.flatMap(attempt =>
         isCustom400ProbeWindowRequest(attempt, custom400Protocol.armedWallMs)
           ? [{ attemptId: attempt.physicalAttemptId ?? null, networkId: attempt.networkId ?? null,
             networkSessionId: attempt.targetSessionId ?? null }]
           : []);
       resilienceEvidence.attempts = custom400Protocol.evidence.attempts.map(item => {
         const request = providerAttempts.find(attempt => attempt.networkId === item.networkId
           && attempt.targetSessionId === item.networkSessionId);
         const networkAttempt = providerNetworkEvents.get(`${item.networkSessionId}:${item.networkId}`) ?? {};
         const targetIds = (item.texts ?? []).map(text => sourceToFixtureId.get(text) ?? null);
         return {
           ...item, attemptId: request?.physicalAttemptId ?? null,
           networkId: item.networkId ?? null, pageSessionId: item.pageSessionId ?? null,
           targetIds, status: networkAttempt.status ?? null, networkStatus: networkAttempt.status ?? null,
           networkOutcome: networkAttempt.outcome ?? null,
         };
       });
       resilienceEvidence.probeWindowPhysicalAttempts = probeWindowPhysicalAttempts;
       resilienceEvidence.expectedProbeWindowPhysicalAttemptCount = probeWindowPhysicalAttempts.length;
       resilienceEvidence.preRestorePreArmDrain = custom400Protocol.evidence.preRestorePreArmDrain;
       resilienceEvidence.failedTargetDOM = custom400Protocol.evidence.failedTargetDOM;
        resilienceEvidence.expectedLogicalBatchCount = expectedLogicalBatchCount ?? null;
       resilienceEvidence.providerPhysicalAttemptCount = providerAttempts.length;
       resilienceEvidence.queueAttemptEvidence = validateCustom400QueueEvidence(workerEvents, {
         messageId: failed?.logicalMessageId, targetIds: failed?.targetIds,
       });
       resilienceEvidence.queueRetries = workerEvents.filter(event => event.messageId === failed?.logicalMessageId
         && event.name === 'queueManager.processItem.start' && event.attemptNumber > 1);
       resilienceEvidence.keyFailovers = providerAttempts.filter(item => item.networkId !== failed?.networkId
         && JSON.stringify(item.batchTexts) === JSON.stringify(failed?.texts));
       resilienceEvidence.unexpectedRecovery = resilienceEvidence.attempts.filter(item =>
         item.logicalMessageId === failed?.logicalMessageId && item.networkId !== failed?.networkId);
       const failedIds = new Set(failed?.targetIds ?? []);
       resilienceEvidence.unnecessaryRetransmits = providerAttempts.flatMap(item => {
         if (item.networkId === failed?.networkId) return [];
         const ids = item.batchTexts?.map(text =>
           fixtureConfig.targets.find(target => target.source === text)?.id ?? null) ?? [];
         const overlap = ids.filter(id => failedIds.has(id));
         return overlap.length ? [{ networkId: item.networkId ?? null, targetIds: overlap }] : [];
       });
       resilienceEvidence.circuitBreakers = workerEvents.filter(event => event.messageId === failed?.logicalMessageId
         && /circuit.?breaker/i.test(event.name ?? ''));
       const physicalSummary = summarizePhysicalProviderAttempts(providerPhysicalAttempts.map(attempt => {
         const attemptNetwork = providerNetworkEvents.get(`${attempt.networkSessionId}:${attempt.networkId}`);
         return { ...attempt, startedAt: attemptNetwork?.startedAt ?? null, settledAt: attemptNetwork?.settledAt ?? null,
           status: attemptNetwork?.status ?? null, outcome: attemptNetwork?.outcome ?? null };
       }));
       resilienceEvidence.concurrency = {
         peakPhysical: physicalSummary.peakPhysicalConcurrency,
          peakLogical: peakLogicalConcurrency ?? null,
          effectiveProviderLimiterCapacity: effectiveProviderLimiterCapacity ?? null,
       };
     }

}

export function validateCustom400ProbeEvidence(evidence) {
  return validateCustom400Evidence(evidence);
}

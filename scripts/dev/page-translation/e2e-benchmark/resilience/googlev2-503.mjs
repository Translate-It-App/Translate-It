import { selectResolvedGoogleAttempt, validateResilienceAccounting } from '../resilience-probes.mjs';
import { fulfillPausedFetch } from '../network-interception.mjs';

export function createGoogleV2_503Evidence() {
  return { injected503: [], attempts: [], unnecessaryRetransmits: [], siblingRequests: [] };
}

export async function executeGoogleV2_503({
  event, requestId, classification, requestRecord, body, fixtureConfig, sessionId,
  evidence, providerNetworkEvents, chrome, workerSession, evaluate, now, sendBySession, sameProviderTexts,
}) {
  const networkId = event.params.networkId ?? null;
  const network = networkId ? providerNetworkEvents.get(`${event.sessionId}:${networkId}`) : null;
  const resources = sessionId ? await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.resourceSnapshot([],[${JSON.stringify(sessionId)}])`, undefined, false) : null;
  const resolver = resources?.sourceResolvers?.[sessionId];
  const roots = await evaluate(chrome, workerSession,
    'globalThis.__pageTranslationBenchmark.cancellationSnapshot()', undefined, false);
  const matchingRoots = (roots?.providerRoots ?? []).filter(root => root.sessionId === sessionId
    && sameProviderTexts(root.texts, body));
  const logicalRoots = [...new Map(matchingRoots.map(root => [root.messageId, root])).values()];
  const root = logicalRoots.length === 1 ? logicalRoots[0] : null;
  const selection = selectResolvedGoogleAttempt({
    request: { networkId, sourceLanguage: requestRecord.sourceLanguageQuery },
    classification, resolver, failedCount: evidence.injected503.length,
  });
  const targetIds = body.map(text => fixtureConfig.targets.find(target => target.source === text)?.id ?? null);
  const base = {
    attemptId: `resilience-${evidence.attempts.length + 1}`, networkId, pageSessionId: sessionId,
    logicalMessageId: root?.messageId ?? null, texts: body, targetIds, physicalStartedWallMs: network?.wallTime ?? null,
    source: resolver?.effectiveSourceLanguage ?? null, sourceLanguageQuery: requestRecord.sourceLanguageQuery ?? null,
    target: resolver?.effectiveTargetLanguage ?? null,
  };
  if (evidence.injected503.length && sameProviderTexts(evidence.injected503[0].texts, body)) base.retryOf = evidence.injected503[0].attemptId;
  evidence.attempts.push(base);
  requestRecord.resilienceCorrelation = { ...base, resolver, matchingRootCount: logicalRoots.length, selection };
  if (!selection.selected) return false;
  if (!root || !targetIds.length || targetIds.some(id => id === null)) throw new Error('Resolved Google request lacks unique QueueManager/logical target correlation.');
  const failure = { ...base, status: 503, selectedAt: now() };
  base.status = failure.status;
  evidence.injected503.push(failure);
  requestRecord.resilienceInjected503 = failure;
  await fulfillPausedFetch({
    send: sendBySession.get(event.sessionId), sessionId: event.sessionId, requestId, status: 503,
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: { error: { code: 503, message: 'Benchmark injected transient failure' } },
    requestRecord, now, response: { retryAfter: null },
  });
  return true;
}

export function validateGoogleV2_503Evidence(evidence) {
  return validateResilienceAccounting(evidence);
}

export function finalizeGoogleV2_503Evidence(evidence) {
  const failed = evidence.injected503[0];
  const failedTargetIds = new Set(failed?.targetIds ?? []);
  evidence.siblingRequests = failed ? evidence.attempts.filter(attempt =>
    attempt.status === 200
    && attempt.pageSessionId === failed.pageSessionId
    && attempt.targetIds?.length > 0
    && attempt.targetIds.every(id => !failedTargetIds.has(id))) : [];
}

import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { replacementErrorCodes, replacementEventSchemas, replacementProtocol } from './runtime-replacement-protocol.mjs';
import { exact, id, targetIds, same, disjoint, sameCursor, validCursor, canonicalRoutes } from './runtime-replacement-collector.mjs';

/**
 * Phase 2C (Stale-Success) report/control protocol. Same envelope, sender
 * pinning and A/B routes as the Phase 2B collector; this is a mode-specific
 * collector, not a generalization of it. The scenario is a genuinely
 * successful second Provider batch for session A whose content-side reply the
 * harness holds across a trusted SPA navigation A→B; production's Scheduler
 * must then reject the released reply at its session-ownership check.
 *
 * Differences from Phase 2B: the stale batch's physical and Provider-root
 * settlement MUST be a clean success (fulfilled, no code, not aborted); the
 * reply must be held before the navigation and released only after B accepted
 * the page; the production rejection (`stale-batch-rejected`, outcome
 * 'cancelled') must follow the release. No controller-abort is expected and
 * any abort evidence is rejected. The production reply timeout is 8000 ms, so
 * a release observed more than HOLD_WINDOW_MS (6000 ms) after the hold is
 * rejected to guarantee the ownership check, not a timeout, is what fails.
 * `release-stale` grants the harness release only once the hold and B's
 * acceptance are admitted and the rejection report is still outstanding.
 */
const OPERATION = replacementProtocol.operation;
const VERSION = replacementProtocol.version;
const REPORT_PATH = replacementProtocol.reportPath;
const CONTROL_PREFIX = replacementProtocol.controlPaths.navigateToB.slice(0, replacementProtocol.controlPaths.navigateToB.lastIndexOf('/') + 1);
const MAX_BODY = 16 * 1024;
const MAX_REPORTS = 64;
const MAX_FINAL_TARGETS = 12;
const OWNERS = new Set(['A', 'B']);
// A events that the navigation itself settles; they are reported from the
// current document at B and must not be treated as new A work. The stale
// reply/rejection observations are the post-navigation A outcome by design.
const POST_NAVIGATION_A_EVENTS = new Set(['stop-ack', 'stale-reply-released', 'stale-batch-rejected']);
const CONTROLS = new Set(['navigate-to-b', 'capture-final', 'release-stale']);
// The production PAGE_TRANSLATE_BATCH timeout is 8000 ms; releases later than
// this bound would be observed by the Scheduler as a timeout instead.
const HOLD_WINDOW_MS = 6000;
const ERROR_CODES = new Set(replacementErrorCodes);
const EXPECTED_TARGETS = Array.from({ length: MAX_FINAL_TARGETS }, (_, index) => `target-${index}`);

export function createStaleCollector({ runId, authToken, expectedExtensionId, expectedTabId, expectedDocumentId, fixtureUrl }) {
  if (!id(runId) || typeof authToken !== 'string' || !/^[a-f\d]{64,}$/i.test(authToken)
      || typeof expectedExtensionId !== 'string' || !expectedExtensionId
      || (expectedTabId !== null && (!Number.isSafeInteger(expectedTabId) || expectedTabId < 0))
      || expectedDocumentId === undefined || (expectedDocumentId !== null
        && (typeof expectedDocumentId !== 'string' || !expectedDocumentId || expectedDocumentId.length > 256))) throw new TypeError('Invalid stale collector configuration.');
  const routes = canonicalRoutes(fixtureUrl); const token = Buffer.from(authToken);
  const reports = []; const sessions = new Map(); const batches = new Map(); const invocations = new Map(); const attempts = new Map();
  const waiters = new Map(); const inFlight = new Set(); const bodyRequests = new Set();
  let sequence = 0, pinnedSender = null, pinnedTabId = expectedTabId, pinnedDocumentId = expectedDocumentId, pinnedExtensionOrigin = null, currentRoute = routes.A;
  let navigateAuthorized = false, navigation = null, captureAuthorized = false, releaseStaleAuthorized = false;
  let finalDOM = null, firstABatchId = null, closed = false, failure = null, attached = false;
  let staleHold = null, releasedAdmitted = false, staleRejectedAdmitted = false;
  const rejections = [];
  const postLog = [];
  const failLog = [];
  const timeline = [];
  const note = entry => { timeline.push({ n: timeline.length, ...entry }); };

  function rejectWaiters(error) {
    for (const list of waiters.values()) for (const waiter of list) { clearTimeout(waiter.timer); waiter.reject(error); }
    waiters.clear();
  }
  function fail(response, status, code, terminal = false) {
    if (terminal && !failure) { failure = { code }; rejectWaiters(new Error('Stale collector reached terminal failure.')); }
    failLog.push({ status, code, terminal });
    note({ kind: 'fail', status, code, terminal, failure: failure?.code ?? null });
    if (!response.headersSent && !response.destroyed) response.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }).end(JSON.stringify({ v: VERSION, runId, error: code }));
  }
  function senderValid(sender, expectedUrl, { allowBootstrap = false } = {}) {
    // Firefox may not expose MessageSender.documentId for runtime messages; a
    // null document is an accepted absence and is never fabricated. Identity is
    // pinned by extension, tab, top frame, origin and exact route instead.
    if (!exact(sender, ['id', 'tabId', 'frameId', 'url', 'origin', 'documentId']) || sender.id !== expectedExtensionId
        || (pinnedTabId !== null && sender.tabId !== pinnedTabId) || sender.frameId !== 0
        || (sender.origin !== null && sender.origin !== routes.origin)
        || (sender.documentId !== null && (typeof sender.documentId !== 'string' || !sender.documentId || sender.documentId.length > 256))) return false;
    // Once a sender is pinned, every later report must match it exactly.
    if (pinnedSender) {
      return sender.url === pinnedSender.url && sender.id === pinnedSender.id && sender.tabId === pinnedSender.tabId
        && sender.frameId === pinnedSender.frameId && sender.origin === pinnedSender.origin
        && sender.documentId === pinnedSender.documentId;
    }
    if (!allowBootstrap || expectedUrl !== routes.A) return false;
    if (pinnedDocumentId !== null && sender.documentId !== pinnedDocumentId) return false;
    return sender.url === expectedUrl;
  }
  function eventOwner(event, evidence) {
    if (evidence.owner) return evidence.owner;
    if (event === 'accepted-A') return 'A';
    if (['stop-ack', 'physical-settled', 'provider-root-settled', 'stale-reply-held', 'stale-reply-released', 'stale-batch-rejected'].includes(event)) {
      return [...sessions].find(([, session]) => session.sessionId === evidence.sessionId)?.[0] ?? null;
    }
    return 'B';
  }
  function batchesFor(owner) { return [...batches.values()].filter(item => item.owner === owner); }
  function attemptsFor(messageId) { return [...attempts.values()].filter(item => item.messageId === messageId); }
  function firstAccepted() { return reports.find(item => item.event === 'accepted-A')?.evidence ?? null; }
  function staleBatch() {
    const held = batchesFor('A').filter(item => item.messageId !== firstABatchId);
    return held.length === 1 ? held[0] : null;
  }
  function validSenderForEvent(event, evidence) {
    // The sender URL is the committed document URL, which a same-document
    // route change does not alter; the route comes from the evidence instead.
    if (event === 'spa-navigation') return senderValid(evidence.sender, routes.B);
    if (event === 'session-start') return senderValid(evidence.sender, currentRoute,
      { allowBootstrap: !pinnedSender && evidence.owner === 'A' });
    const owner = eventOwner(event, evidence);
    return senderValid(evidence.sender, currentRoute) && (owner !== 'A' || !navigation || POST_NAVIGATION_A_EVENTS.has(event));
  }

  function validate(report) {
    if (!exact(report, ['v', 'runId', 'seq', 'operation', 'event', 'evidence']) || report.v !== VERSION || report.runId !== runId
        || report.seq !== sequence + 1 || report.operation !== OPERATION || !Object.hasOwn(replacementEventSchemas, report.event)
        || !exact(report.evidence, [...replacementEventSchemas[report.event], 'sender']) || reports.length >= MAX_REPORTS) return false;
    const e = report.evidence;
    if (!validSenderForEvent(report.event, e)) return false;
    const cleanupSeen = reports.some(item => item.event === 'cleanup');
    const stopBSeen = reports.some(item => item.event === 'stop-B');
    if (report.event === 'error') return ERROR_CODES.has(e.code);
    if (cleanupSeen && report.event !== 'final-dom') return false;
    if (stopBSeen && !['cleanup', 'final-dom'].includes(report.event)) return false;
    if (finalDOM) return false;

    if (report.event === 'session-start') {
      if (!OWNERS.has(e.owner) || !id(e.sessionId) || sessions.has(e.owner) || [...sessions.values()].some(s => s.sessionId === e.sessionId)
          || e.currentUrl !== currentRoute || typeof e.isAuto !== 'boolean' || e.isAuto !== true
          || typeof e.autoTranslateOnDomChanges !== 'boolean' || e.autoTranslateOnDomChanges !== true) return false;
      if (e.owner === 'A') return sessions.size === 0 && currentRoute === routes.A && e.currentUrl === routes.A
        && e.preserveAcceptedTranslations === false && (e.cursor === null || validCursor(e.cursor, routes.A));
      return !!navigation && navigateAuthorized && sessions.size === 1 && e.currentUrl === routes.B
        && e.preserveAcceptedTranslations === true && exact(e.cursor, ['documentEpoch', 'routeRevision', 'url'])
        && sameCursor(e.cursor, navigation.cursor);
    }

    if (report.event === 'spa-navigation') {
      if (navigation || !navigateAuthorized || currentRoute !== routes.A || e.fromUrl !== routes.A || e.toUrl !== routes.B
          || !validCursor(e.cursor, routes.B)) return false;
      const prior = sessions.get('A')?.cursor;
      return !!sessions.has('A') && (!prior || (e.cursor.documentEpoch === prior.documentEpoch && e.cursor.routeRevision > prior.routeRevision));
    }
    if (report.event === 'cleanup') return e.activeOperations === 0 && e.pendingRequests === 0 && Array.isArray(e.cleanupCancelledAttemptIds)
      && e.cleanupCancelledAttemptIds.length === 0 && cleanupReady() && !cleanupSeen;
    if (report.event === 'final-dom') return validateFinalDOM(e);
    if (report.event === 'stop-B') {
      const sessionB = sessions.get('B')?.sessionId;
      const release = e.observerRelease;
      if (!exact(release, ['expected', 'released', 'failed'])
          || ![release.expected, release.released, release.failed].every(count => Number.isSafeInteger(count) && count >= 0)
          || release.expected < 1 || release.released !== release.expected || release.failed !== 0) return false;
      return !!sessionB && reports.some(item => item.event === 'accepted-B') && !stopBSeen
        && e.sessionId === sessionB && e.success === true && e.resultSessionId === sessionB && e.isAutoTranslating === false
        && e.bridgeActive === false && e.schedulerActive === false && e.discoveryActive === false && operationQuiescent();
    }

    const owner = eventOwner(report.event, e); const session = sessions.get(owner);
    if (!session || e.sessionId !== session.sessionId) return false;
    if (report.event === 'scheduler-batch') {
      if (navigation && owner === 'A') return false;
      if (owner === 'B' && !navigation) return false;
      if (!validBatch(e, owner)) return false;
      // Session B only ever translates the targets session A did not accept.
      if (owner === 'B') {
        const acceptedA = firstAccepted();
        if (!acceptedA) return false;
        const pending = EXPECTED_TARGETS.filter(target => !acceptedA.targetIds.includes(target));
        if (e.targetIds.length !== pending.length || !same([...e.targetIds].sort(), [...pending].sort())) return false;
      }
      return true;
    }
    if (report.event === 'provider-invoked') {
      const batch = batches.get(e.messageId);
      return (!navigation || owner !== 'A') && !!batch && batch.owner === owner && batch.sessionId === e.sessionId
        && same(batch.targetIds, e.targetIds) && id(e.invocationId) && !invocations.has(e.invocationId) && !invocations.has(e.messageId);
    }
    if (report.event === 'physical-start') {
      const invocation = invocations.get(e.messageId);
      return (!navigation || owner !== 'A') && !!invocation && invocation.owner === owner && invocation.sessionId === e.sessionId
        && invocation.invocationId === e.invocationId && same(invocation.targetIds, e.targetIds) && id(e.attemptId)
        && !attempts.has(e.attemptId) && attemptsFor(e.messageId).length === 0;
    }
    if (report.event === 'accepted-A') {
      const batch = batches.get(e.messageId);
      return !navigation && owner === 'A' && e.messageId === firstABatchId && !!batch && batch.owner === 'A' && batch.sessionId === e.sessionId
        && same(batch.targetIds, e.targetIds) && !firstAccepted()
        && attemptsFor(e.messageId).some(item => item.settled && item.outcome === 'fulfilled')
        && attemptsFor(e.messageId).some(item => item.rootSettled && item.rootStatus === 'fulfilled');
    }
    if (report.event === 'stop-ack') return owner === 'A' && !!navigation && e.success === true
      && e.cancellationReason === 'operation-abort' && e.resultSessionId === sessions.get('A')?.sessionId && e.isAutoTranslating === false
      && sameCursor(e.navigationCursor, navigation.cursor) && !reports.some(item => item.event === 'stop-ack');
    // No controller abort exists in the Stale-Success scenario; abort evidence
    // contradicts the required clean success and is rejected.
    if (report.event === 'controller-abort') return false;
    if (report.event === 'physical-settled') {
      const attempt = attempts.get(e.attemptId);
      // Every attempt in this scenario settles as a clean success, including
      // the stale batch: this is a genuine Provider success, not a cancellation.
      return !!attempt && attempt.messageId === e.messageId && attempt.sessionId === e.sessionId
        && attempt.owner === owner && !attempt.settled && e.cleanup === false
        && e.outcome === 'fulfilled' && e.code === null;
    }
    if (report.event === 'provider-root-settled') {
      const attempt = attemptsFor(e.messageId).find(item => item.sessionId === e.sessionId && item.owner === owner);
      return !!attempt && attempt.settled && !attempt.rootSettled && e.cleanup === false
        && e.status === 'fulfilled' && e.code === null
        && e.operationAborted === false && e.cancellationReason === null;
    }
    if (report.event === 'retained-A') return owner === 'B' && !!navigation && e.sourceSessionId === sessions.get('A')?.sessionId
      && same(e.targetIds, firstAccepted()?.targetIds) && !reports.some(item => item.event === 'retained-A');
    if (report.event === 'accepted-B') {
      const batch = batches.get(e.messageId); const retained = reports.find(item => item.event === 'retained-A')?.evidence.targetIds ?? [];
      return owner === 'B' && !!navigation && !!batch && batch.owner === 'B' && batch.sessionId === e.sessionId
        && same(batch.targetIds, e.targetIds) && e.source === 'provider' && disjoint(e.targetIds, retained)
        && attemptsFor(e.messageId).some(item => item.settled && item.outcome === 'fulfilled' && item.rootSettled)
        && !reports.some(item => item.event === 'accepted-B');
    }
    if (report.event === 'stale-reply-held') {
      const stale = staleBatch(); const sessionA = sessions.get('A');
      return !navigation && !staleHold && !!stale && !!sessionA && e.sessionId === sessionA.sessionId
        && e.messageId === stale.messageId && targetIds(e.targetIds) && same(e.targetIds, stale.targetIds)
        && Number.isSafeInteger(e.replyItemCount) && e.replyItemCount === e.targetIds.length && e.replyItemCount >= 1
        && /^[a-f0-9]{64}$/.test(e.replyHash)
        && attemptsFor(stale.messageId).some(item => item.settled && item.outcome === 'fulfilled' && item.rootSettled && item.rootStatus === 'fulfilled');
    }
    if (report.event === 'stale-reply-released') {
      const stale = staleBatch(); const sessionA = sessions.get('A');
      return !!staleHold && !releasedAdmitted && !!stale && !!sessionA && e.sessionId === sessionA.sessionId
        && e.messageId === stale.messageId && reports.some(item => item.event === 'accepted-B')
        && Date.now() - staleHold.heldAt <= HOLD_WINDOW_MS;
    }
    if (report.event === 'stale-batch-rejected') {
      const stale = staleBatch(); const sessionA = sessions.get('A');
      return releasedAdmitted && !staleRejectedAdmitted && !!stale && !!sessionA && e.sessionId === sessionA.sessionId
        && e.messageId === stale.messageId && targetIds(e.targetIds) && same(e.targetIds, stale.targetIds)
        && e.outcome === 'cancelled';
    }
    return false;
  }

  function validBatch(e, owner) {
    return OWNERS.has(owner) && id(e.messageId) && targetIds(e.targetIds) && !batches.has(e.messageId)
      && ![...batches.values()].some(item => item.owner === owner && item.targetIds.some(target => e.targetIds.includes(target)));
  }
  function validateFinalDOM(e) {
    const sessionB = sessions.get('B'); const accepted = reports.find(item => item.event === 'accepted-B')?.evidence;
    const retained = reports.find(item => item.event === 'retained-A')?.evidence;
    const acceptedA = firstAccepted();
    if (!captureAuthorized || finalDOM || !sessionB || e.sessionId !== sessionB.sessionId || !accepted || !retained || !acceptedA
        || !Array.isArray(e.targets) || e.targets.length !== MAX_FINAL_TARGETS || !Array.isArray(e.postInvalidationAWrites)
        || e.postInvalidationAWrites.length !== 0) return false;
    const ids = e.targets.map(item => item?.targetId);
    if (!targetIds(ids) || ids.length !== MAX_FINAL_TARGETS || !new Set(ids).size) return false;
    if (!EXPECTED_TARGETS.every(target => ids.includes(target))) return false;
    for (const target of e.targets) {
      if (!exact(target, ['targetId', 'owner', 'state', 'hash']) || !['A', 'B'].includes(target.owner)
          || !['retained', 'accepted'].includes(target.state) || !/^[a-f\d]{64}$/i.test(target.hash)) return false;
      const isRetained = acceptedA.targetIds.includes(target.targetId);
      if (isRetained ? target.owner !== 'B' || target.state !== 'retained' : target.owner !== 'B' || target.state !== 'accepted') return false;
      if (!isRetained && !accepted.targetIds.includes(target.targetId)) return false;
    }
    return same([...acceptedA.targetIds].sort(), [...retained.targetIds].sort())
      && same([...EXPECTED_TARGETS.filter(id2 => !acceptedA.targetIds.includes(id2))].sort(), [...accepted.targetIds].sort());
  }

  function record(report) {
    if (!validate(report)) return false;
    const e = structuredClone(report.evidence);
    if (report.event === 'session-start' && e.owner === 'A') {
      pinnedSender = structuredClone(e.sender);
      pinnedTabId ??= e.sender.tabId;
      pinnedDocumentId ??= e.sender.documentId;
    }
    sequence = report.seq;
    if (report.event === 'session-start') sessions.set(e.owner, { sessionId: e.sessionId, cursor: e.cursor });
    if (report.event === 'scheduler-batch') {
      batches.set(e.messageId, { owner: e.owner, sessionId: e.sessionId, messageId: e.messageId, targetIds: e.targetIds });
      if (e.owner === 'A' && firstABatchId === null) firstABatchId = e.messageId;
    }
    if (report.event === 'provider-invoked') invocations.set(e.messageId, { owner: e.owner, sessionId: e.sessionId, messageId: e.messageId, invocationId: e.invocationId, targetIds: e.targetIds });
    if (report.event === 'physical-start') attempts.set(e.attemptId, { attemptId: e.attemptId, owner: e.owner, sessionId: e.sessionId, messageId: e.messageId, invocationId: e.invocationId,
      targetIds: e.targetIds, settled: false, rootSettled: false });
    if (report.event === 'physical-settled') Object.assign(attempts.get(e.attemptId), { settled: true, outcome: e.outcome, code: e.code });
    if (report.event === 'provider-root-settled') Object.assign(attemptsFor(e.messageId).find(item => item.sessionId === e.sessionId), {
      rootSettled: true, rootStatus: e.status, rootCode: e.code, rootOperationAborted: e.operationAborted, rootCancellationReason: e.cancellationReason,
    });
    if (report.event === 'spa-navigation') { navigation = structuredClone(e); currentRoute = routes.B; }
    if (report.event === 'final-dom') finalDOM = structuredClone(e);
    if (report.event === 'stale-reply-held') staleHold = { heldAt: Date.now() };
    if (report.event === 'stale-reply-released') { staleHold.releasedAt = Date.now(); releasedAdmitted = true; }
    if (report.event === 'stale-batch-rejected') staleRejectedAdmitted = true;
    reports.push(structuredClone(report));
    if (report.event === 'error') { failure = { code: e.code }; rejectWaiters(new Error('Stale collector reached terminal failure.')); }
    const list = waiters.get(report.event);
    if (list) { waiters.delete(report.event); for (const waiter of list) { clearTimeout(waiter.timer); waiter.resolve(structuredClone(report)); } }
    return true;
  }

  function authorize(request) {
    const value = request.headers.authorization ?? ''; const supplied = Buffer.from(value.startsWith('Bearer ') ? value.slice(7) : '');
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  }
  async function handle(request, response) {
    const url = new URL(request.url, routes.origin);
    if (request.headers.host !== new URL(routes.origin).host || url.origin !== routes.origin || url.search || url.hash || url.username || url.password) {
      fail(response, 404, 'ROUTE_REJECTED'); return true;
    }
    const control = url.pathname.startsWith(CONTROL_PREFIX) ? url.pathname.slice(CONTROL_PREFIX.length) : null;
    if (url.pathname !== REPORT_PATH && control === null) return false;
    if (closed || failure) {
      if (request.method === 'POST' && url.pathname === REPORT_PATH) {
        const pending = await readBody(request, response);
        let parsed = null;
        try { parsed = JSON.parse(pending); } catch { /* The body is not a report. */ }
        note({ kind: 'post-late', event: parsed?.event ?? null, seq: parsed?.seq ?? null, failure: failure?.code ?? null, closed });
      }
      fail(response, 503, closed ? 'ADMISSION_CLOSED' : 'PROTOCOL_REJECTED'); return true;
    }
    if (!authorize(request)) { fail(response, 401, 'UNAUTHORIZED'); return true; }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let parsed;
      try { parsed = new URL(origin); } catch { fail(response, 403, 'ORIGIN_REJECTED'); return true; }
      if (parsed.protocol !== 'moz-extension:' || !parsed.host || origin !== `${parsed.protocol}//${parsed.host}`
          || (pinnedExtensionOrigin && origin !== pinnedExtensionOrigin)) { fail(response, 403, 'ORIGIN_REJECTED'); return true; }
      pinnedExtensionOrigin ??= origin;
    }
    if (request.method === 'POST' && url.pathname === REPORT_PATH) {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers['content-type'] ?? ''))) { fail(response, 415, 'BODY_INVALID'); return true; }
      const body = await readBody(request, response);
      if (body === OVERSIZED) return true;
      if (body === null) { fail(response, 413, 'BODY_INVALID'); return true; }
      let report;
      try { report = JSON.parse(body); } catch { fail(response, 400, 'BODY_INVALID', true); return true; }
      note({ kind: 'post', event: report.event, seq: report.seq, failure: failure?.code ?? null, closed });
      // A body may have finished after close/failure; never admit it past that transition.
      if (closed || failure) {
        rejections.push({ event: report.event, seq: report.seq, reason: closed ? 'closed' : 'prior-failure', failure });
        fail(response, 503, closed ? 'ADMISSION_CLOSED' : 'PROTOCOL_REJECTED');
        return true;
      }
      if (!record(report)) {
        rejections.push({ event: report.event, seq: report.seq, reason: 'invalid-evidence',
          evidence: structuredClone(report.evidence),
          senderUrl: report.evidence?.sender?.url ?? null, currentRoute, navigateAuthorized, navigation: navigation?.cursor ?? null,
          sessions: Object.fromEntries([...sessions].map(([owner, value]) => [owner, value.sessionId])) });
        fail(response, 400, 'PROTOCOL_REJECTED', true);
        return true;
      }
      postLog.push({ event: report.event, seq: report.seq, admitted: true });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ v: VERSION, runId, seq: report.seq, accepted: true }));
      return true;
    }
    if (request.method !== 'GET' || request.url !== `${CONTROL_PREFIX}${control}`) { fail(response, 404, 'ROUTE_REJECTED'); return true; }
    if (!CONTROLS.has(control)) { fail(response, 404, 'ROUTE_REJECTED'); return true; }
    if (control === 'navigate-to-b') {
      if (navigateAuthorized || !navigationReady().ready) { fail(response, 409, 'PROTOCOL_REJECTED'); return true; }
      navigateAuthorized = true;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ v: VERSION, runId, type: 'navigate-to-b', url: routes.B }));
      return true;
    }
    if (control === 'release-stale') {
      if (releaseStaleAuthorized || !releaseStaleReady()) { fail(response, 409, 'PROTOCOL_REJECTED'); return true; }
      releaseStaleAuthorized = true;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ v: VERSION, runId, type: 'release-stale' }));
      return true;
    }
    if (captureAuthorized || !captureReady()) { fail(response, 409, 'PROTOCOL_REJECTED'); return true; }
    captureAuthorized = true;
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ v: VERSION, runId, type: 'capture-final' }));
    return true;
  }
  function navigationReady() {
    const first = firstAccepted(); const aBatches = batchesFor('A');
    const stale = aBatches.length === 2 ? aBatches.find(item => item.messageId !== firstABatchId) : null;
    const staleInvocationCount = stale ? [...invocations.values()].filter(item => item.owner === 'A' && item.messageId === stale.messageId).length : 0;
    const staleAttempts = stale ? attemptsFor(stale.messageId) : [];
    const staleFulfilled = staleAttempts.length === 1 && staleAttempts[0].settled && staleAttempts[0].outcome === 'fulfilled'
      && staleAttempts[0].code === null && staleAttempts[0].rootSettled && staleAttempts[0].rootStatus === 'fulfilled' && staleAttempts[0].rootCode === null;
    const firstSettled = attemptsFor(first?.messageId).some(item => item.settled && item.outcome === 'fulfilled');
    const firstRootSettled = attemptsFor(first?.messageId).some(item => item.rootSettled && item.rootStatus === 'fulfilled' && item.rootCode === null);
    // The same snapshot shape as the Phase 2B collector: the readiness object
    // carries the flag plus the observed reasons, so the driver and the
    // artifact report one shape.
    return { ready: sessions.has('A') && !!first && aBatches.length === 2 && !!stale && staleInvocationCount === 1
        && staleFulfilled && firstSettled && firstRootSettled,
      aSession: sessions.has('A'), firstAccepted: !!first, aBatchCount: aBatches.length,
      staleInvocationCount, staleFulfilled, firstPhysicalSettled: firstSettled, firstProviderRootFulfilled: firstRootSettled };
  }
  function releaseStaleReady() {
    return !!staleHold && !releasedAdmitted && !staleRejectedAdmitted && reports.some(item => item.event === 'accepted-B');
  }
  function captureReady() {
    return !!navigation && sessions.has('B') && reports.some(item => item.event === 'stop-ack')
      && reports.some(item => item.event === 'retained-A') && reports.some(item => item.event === 'accepted-B')
      && reports.some(item => item.event === 'stop-B' && item.evidence.sessionId === sessions.get('B')?.sessionId)
      && reports.some(item => item.event === 'cleanup' && item.evidence.activeOperations === 0 && item.evidence.pendingRequests === 0)
      && !!staleHold && releasedAdmitted && staleRejectedAdmitted && cleanupReady();
  }
  function cleanupReady() {
    return reports.some(item => item.event === 'stop-B') && operationQuiescent();
  }
  function operationQuiescent() {
    const acceptedA = firstAccepted(); const acceptedB = reports.find(item => item.event === 'accepted-B')?.evidence;
    const retained = reports.find(item => item.event === 'retained-A')?.evidence;
    const aBatches = batchesFor('A'); const bBatches = batchesFor('B'); const stale = staleBatch();
    if (!navigation || !acceptedA || !acceptedB || !retained || !sessions.has('A') || !sessions.has('B')
        || !reports.some(item => item.event === 'stop-ack') || aBatches.length !== 2 || bBatches.length !== 1
        || !same(acceptedA.targetIds, retained.targetIds) || !stale || !releasedAdmitted || !staleRejectedAdmitted) return false;
    const allTargets = [...acceptedA.targetIds, ...stale.targetIds];
    if (allTargets.length !== MAX_FINAL_TARGETS || new Set(allTargets).size !== MAX_FINAL_TARGETS) return false;
    for (const batch of [...aBatches, ...bBatches]) {
      const invocation = invocations.get(batch.messageId); const batchAttempts = attemptsFor(batch.messageId);
      if (!invocation || invocation.owner !== batch.owner || invocation.sessionId !== batch.sessionId
          || !same(invocation.targetIds, batch.targetIds) || batchAttempts.length !== 1) return false;
      const attempt = batchAttempts[0];
      if (attempt.owner !== batch.owner || attempt.sessionId !== batch.sessionId || !same(attempt.targetIds, batch.targetIds)
          || !attempt.settled || !attempt.rootSettled || attempt.outcome !== 'fulfilled' || attempt.code !== null
          || attempt.rootStatus !== 'fulfilled' || attempt.rootCode !== null
          || attempt.rootOperationAborted !== false || attempt.rootCancellationReason !== null) return false;
    }
    return [...attempts.values()].length === 3;
  }
  const OVERSIZED = Symbol('oversized-body');
  function readBody(request, response) {
    return new Promise(resolve => {
      const chunks = []; let bytes = 0; let finished = false; let timer;
      const finish = value => {
        if (finished) return;
        finished = true; clearTimeout(timer); bodyRequests.delete(controlRequest); resolve(value);
      };
      const controlRequest = { abort: () => { if (!request.destroyed) request.destroy(); finish(null); } };
      bodyRequests.add(controlRequest);
      timer = setTimeout(() => { controlRequest.abort(); }, 3000); timer.unref?.();
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          if (!response.headersSent) response.writeHead(413, { 'cache-control': 'no-store', connection: 'close' }).end(JSON.stringify({ v: VERSION, runId, error: 'BODY_INVALID' }));
          controlRequest.abort(); finish(OVERSIZED);
        } else chunks.push(chunk);
      });
      request.once('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      request.once('aborted', () => finish(null)); request.once('error', () => finish(null));
    });
  }
  function track(task) {
    inFlight.add(task);
    task.then(() => inFlight.delete(task), () => inFlight.delete(task));
  }
  async function drain({ timeoutMs = 1000 } = {}) {
    closeAdmission();
    const end = Date.now() + timeoutMs;
    while (inFlight.size && Date.now() < end) {
      await Promise.race([Promise.allSettled([...inFlight]), new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, end - Date.now()))))]);
    }
    return inFlight.size === 0 && bodyRequests.size === 0;
  }
  function closeAdmission() {
    if (closed) return;
    closed = true;
    for (const body of [...bodyRequests]) body.abort();
    rejectWaiters(new Error('Stale collector admission is closed.'));
  }

  return {
    operation: OPERATION, version: VERSION, routes: Object.freeze({ ...routes }), reportUrl: `${routes.origin}${REPORT_PATH}`,
    controlUrl(type) { if (!CONTROLS.has(type)) throw new TypeError('Unknown fixed stale control.'); return `${routes.origin}${CONTROL_PREFIX}${type}`; },
    attach(server) {
      if (!server?.on || attached) throw new TypeError('Collector must attach to one HTTP server exactly once.');
      attached = true;
      const listener = (request, response) => {
        const task = Promise.resolve(handle(request, response)).catch(() => { fail(response, 400, 'PROTOCOL_REJECTED', true); });
        track(task);
      };
      server.on('request', listener);
      return () => server.off('request', listener);
    },
    async handle(request, response) { const task = Promise.resolve(handle(request, response)); track(task); return await task; },
    waitFor(event, { timeoutMs = 3000 } = {}) {
      if (!Object.hasOwn(replacementEventSchemas, event) || !Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new TypeError('Invalid stale event wait.'));
      const prior = reports.find(item => item.event === event);
      if (prior) return Promise.resolve(structuredClone(prior));
      if (closed || failure) return Promise.reject(new Error('Stale collector is closed or terminally failed.'));
      return new Promise((resolve, reject) => {
        const list = waiters.get(event) ?? []; const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.get(event) ?? []; const filtered = current.filter(item => item !== waiter);
          if (filtered.length) waiters.set(event, filtered); else waiters.delete(event);
          reject(new Error(`Timed out waiting for stale event ${event}.`));
        }, timeoutMs);
        waiter.timer.unref?.(); list.push(waiter); waiters.set(event, list);
      });
    },
    snapshot() { return structuredClone({ operation: OPERATION, version: VERSION, runId, accepted: reports.length, sequence, reports,
      sessions: Object.fromEntries([...sessions].map(([owner, value]) => [owner, value.sessionId])),
      batches: [...batches.values()].map(batch => ({ ...batch })), attempts: [...attempts.values()].map(attempt => ({ ...attempt })),
      failure, currentRoute, pinnedSender, pinnedTabId, pinnedDocumentId, navigationReadiness: navigationReady(),
      navigateAuthorized, navigation, captureAuthorized, releaseStaleAuthorized, finalDOM,
      staleHold: staleHold === null ? { held: false, heldAt: null, released: false, releasedAt: null, elapsedMs: null }
        : { held: true, heldAt: staleHold.heldAt, released: releasedAdmitted, releasedAt: staleHold.releasedAt ?? null,
            elapsedMs: (staleHold.releasedAt ?? Date.now()) - staleHold.heldAt },
      proofComplete: finalDOM !== null && !failure, routes, rejections, failLog, postLog, timeline }); },
    closeAdmission,
    drain,
  };
}

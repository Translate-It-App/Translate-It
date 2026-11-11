import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createReplacementCollector } from './page-translation-e2e-firefox/runtime-replacement-collector.mjs';
import { createStaleCollector } from './page-translation-e2e-firefox/runtime-stale-collector.mjs';
import { replacementEventSchemas, replacementProtocol } from './page-translation-e2e-firefox/runtime-replacement-protocol.mjs';

const base = { runId: 'stale-test', authToken: 'a'.repeat(64), expectedExtensionId: 'extension@test', expectedTabId: 7, expectedDocumentId: 'doc-7' };
const active = [];
async function setup(overrides = {}) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const collector = createStaleCollector({ ...base, ...overrides, fixtureUrl }); collector.attach(server); active.push({ server, collector });
  return { server, collector, routes: collector.routes };
}
async function setupReplacement(overrides = {}) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const collector = createReplacementCollector({ ...base, ...overrides, fixtureUrl }); collector.attach(server); active.push({ server, collector });
  return { server, collector, routes: collector.routes };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(active.splice(0).map(async ({ server, collector }) => { await collector.drain(); await new Promise(resolve => server.close(resolve)); }));
});

const targetRange = (start, end) => Array.from({ length: end - start }, (_, i) => `target-${start + i}`);
const acceptedIds = targetRange(0, 6);
const pendingIds = targetRange(6, 12);
const replyHash = 'ab'.repeat(32);
function sender(url, changes = {}) { return { id: base.expectedExtensionId, tabId: 7, frameId: 0, url, origin: new URL(url).origin, documentId: 'doc-7', ...changes }; }
function reporter(value) {
  let seq = 0; const url = value.routes.A;
  return {
    // Firefox reports the committed document URL, which a same-document route
    // change does not alter, so the sender URL stays the A route.
    at() {},
    async send(event, fields, senderChanges = {}) {
      const response = await fetch(value.collector.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${base.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, runId: base.runId, seq: ++seq, operation: replacementProtocol.operation, event, evidence: { ...fields, sender: sender(url, senderChanges) } }) });
      return response;
    },
  };
}
async function control(value, type) { return fetch(value.collector.controlUrl(type), { headers: { authorization: `Bearer ${base.authToken}` } }); }
const cursor = (value, revision = 8) => ({ documentEpoch: 4, routeRevision: revision, url: value.routes.B });

async function submit(send, event, evidence, expected = 200) {
  const response = await send.send(event, evidence);
  expect(response.status, `${event}: ${response.status >= 400 ? await response.text() : ''}`).toBe(expected);
  return response;
}
const sessionStartA = value => ({ owner: 'A', sessionId: 'session-A', currentUrl: value.routes.A, isAuto: true,
  autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null });
const stopAck = navigationCursor => ({ sessionId: 'session-A', navigationCursor, success: true,
  cancellationReason: 'operation-abort', resultSessionId: 'session-A', isAutoTranslating: false });
function finalTargets() {
  return Array.from({ length: 12 }, (_, i) => ({ targetId: `target-${i}`, owner: 'B', state: i < 6 ? 'retained' : 'accepted', hash: `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32) }));
}

async function firstAcceptedA(send) {
  await submit(send, 'session-start', sessionStartA(send.value));
  await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', targetIds: acceptedIds });
  await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', invocationId: 'invoke-a-accepted', targetIds: acceptedIds });
  await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', invocationId: 'invoke-a-accepted', attemptId: 'attempt-a-accepted', targetIds: acceptedIds });
  await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-accepted', attemptId: 'attempt-a-accepted', outcome: 'fulfilled', code: null, cleanup: false });
  await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-accepted', status: 'fulfilled', code: null, cleanup: false, operationAborted: false, cancellationReason: null });
  await submit(send, 'accepted-A', { sessionId: 'session-A', messageId: 'a-accepted', targetIds: acceptedIds });
}
async function startStaleBatch(send, { attemptId = 'attempt-a-held', invocationId = 'invoke-a-held' } = {}) {
  await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds });
  await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId, targetIds: pendingIds });
  await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId, attemptId, targetIds: pendingIds });
}
// The stale batch is a genuine Provider success: the harness holds only the
// content-side reply, the request itself settles fulfilled before the hold.
async function holdStale(send, held = { sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds, replyItemCount: 6, replyHash }) {
  await startStaleBatch(send);
  await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'fulfilled', code: null, cleanup: false });
  await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'fulfilled', code: null, cleanup: false, operationAborted: false, cancellationReason: null });
  if (held) await submit(send, 'stale-reply-held', held);
}
async function navigateAndAcceptB(value, send, { navCursor = cursor(value) } = {}) {
  const authorization = await control(value, 'navigate-to-b');
  expect(authorization.status, `${authorization.status >= 400 ? await authorization.text() : ''}`).toBe(200);
  await submit(send, 'spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: navCursor });
  await submit(send, 'stop-ack', stopAck(navCursor));
  await submit(send, 'session-start', { owner: 'B', sessionId: 'session-B', currentUrl: value.routes.B, isAuto: true,
    autoTranslateOnDomChanges: true, preserveAcceptedTranslations: true, cursor: { ...navCursor } });
  await submit(send, 'retained-A', { sessionId: 'session-B', sourceSessionId: 'session-A', targetIds: acceptedIds });
  await submit(send, 'scheduler-batch', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', targetIds: pendingIds });
  await submit(send, 'provider-invoked', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'invoke-b', targetIds: pendingIds });
  await submit(send, 'physical-start', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'invoke-b', attemptId: 'attempt-b', targetIds: pendingIds });
  await submit(send, 'physical-settled', { sessionId: 'session-B', messageId: 'b-batch', attemptId: 'attempt-b', outcome: 'fulfilled', code: null, cleanup: false });
  await submit(send, 'provider-root-settled', { sessionId: 'session-B', messageId: 'b-batch', status: 'fulfilled', code: null, cleanup: false, operationAborted: false, cancellationReason: null });
  await submit(send, 'accepted-B', { sessionId: 'session-B', messageId: 'b-batch', targetIds: pendingIds, source: 'provider' });
  return navCursor;
}
async function finishScenario(value) {
  const send = reporter(value); send.value = value;
  await firstAcceptedA(send);
  await holdStale(send);
  // The release grant is refused until B owns the page.
  expect((await control(value, 'release-stale')).status).toBe(409);
  const navCursor = await navigateAndAcceptB(value, send);
  const grant = await control(value, 'release-stale');
  expect(grant.status).toBe(200);
  await expect(grant.json()).resolves.toMatchObject({ v: 1, runId: base.runId, type: 'release-stale' });
  await submit(send, 'stale-reply-released', { sessionId: 'session-A', messageId: 'a-held' });
  await submit(send, 'stale-batch-rejected', { sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds, outcome: 'cancelled' });
  await submit(send, 'stop-B', { sessionId: 'session-B', success: true, resultSessionId: 'session-B', isAutoTranslating: false,
    bridgeActive: false, schedulerActive: false, discoveryActive: false, observerRelease: { expected: 1, released: 1, failed: 0 } });
  await submit(send, 'cleanup', { activeOperations: 0, pendingRequests: 0, cleanupCancelledAttemptIds: [] });
  return { send, navCursor };
}

describe('Phase 2C stale-success protocol collector', () => {
  it('exports the stale schemas, control path, and completes the held-success scenario with proofComplete', async () => {
    expect(replacementProtocol.controlPaths).toMatchObject({ releaseStale: '/__page-translation-replacement/control/release-stale' });
    expect(Object.keys(replacementEventSchemas)).toEqual(expect.arrayContaining(['stale-reply-held', 'stale-reply-released', 'stale-batch-rejected']));
    const value = await setup(); const { send } = await finishScenario(value);
    expect(value.collector.controlUrl('release-stale')).toBe(`${value.routes.origin}/__page-translation-replacement/control/release-stale`);
    expect(() => value.collector.controlUrl('nope')).toThrow();
    const capture = await control(value, 'capture-final'); expect(capture.status).toBe(200);
    await submit(send, 'final-dom', { sessionId: 'session-B', targets: finalTargets(), postInvalidationAWrites: [] });
    const snapshot = value.collector.snapshot();
    expect(snapshot).toMatchObject({ proofComplete: true, failure: null, currentRoute: value.routes.B, releaseStaleAuthorized: true,
      sessions: { A: 'session-A', B: 'session-B' }, finalDOM: { sessionId: 'session-B', postInvalidationAWrites: [] } });
    expect(snapshot.staleHold).toMatchObject({ held: true, released: true });
    expect(snapshot.staleHold.elapsedMs).toBeLessThanOrEqual(6000);
    expect(snapshot.reports.every(report => Number.isSafeInteger(report.seq) && typeof report.event === 'string' && report.evidence)).toBe(true);
    // A granted release is never granted twice.
    expect((await control(value, 'release-stale')).status).toBe(409);
  });

  it('rejects a stale batch that settles cancelled or aborted instead of fulfilled', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await startStaleBatch(send);
    expect((await send.send('physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'cancelled', code: 'AbortError', cleanup: false })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });

    const abortedRoot = await setup(); const abortedSend = reporter(abortedRoot); abortedSend.value = abortedRoot;
    await firstAcceptedA(abortedSend);
    await startStaleBatch(abortedSend);
    await submit(abortedSend, 'physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'fulfilled', code: null, cleanup: false });
    expect((await abortedSend.send('provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'rejected', code: null,
      cleanup: false, operationAborted: true, cancellationReason: 'operation-abort' })).status).toBe(400);
    expect(abortedRoot.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });
  });

  it('rejects stale-reply-held admitted after the navigation (the reply did not survive the replacement)', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await startStaleBatch(send);
    await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'fulfilled', code: null, cleanup: false });
    await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'fulfilled', code: null, cleanup: false, operationAborted: false, cancellationReason: null });
    await navigateAndAcceptB(value, send, { navCursor: cursor(value) });
    expect((await send.send('stale-reply-held', { sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds, replyItemCount: 6, replyHash })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });
  });

  it('rejects stale-reply-released before accepted-B and stale-batch-rejected with a non-cancelled outcome', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await holdStale(send);
    await control(value, 'navigate-to-b');
    const navCursor = cursor(value);
    await submit(send, 'spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: navCursor });
    await submit(send, 'stop-ack', stopAck(navCursor));
    await submit(send, 'session-start', { owner: 'B', sessionId: 'session-B', currentUrl: value.routes.B, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: true, cursor: { ...navCursor } });
    // B has not accepted the page yet: the release must not be admitted.
    expect((await send.send('stale-reply-released', { sessionId: 'session-A', messageId: 'a-held' })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });

    const outcome = await setup(); const outcomeSend = reporter(outcome); outcomeSend.value = outcome;
    await finishScenarioLite(outcome, outcomeSend);
    expect((await outcomeSend.send('stale-batch-rejected', { sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds, outcome: 'fulfilled' })).status).toBe(400);
    expect(outcome.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });
  });

  it.each([
    ['replyItemCount below the batch size', { replyItemCount: 5, replyHash }],
    ['replyItemCount not matching the batch size', { replyItemCount: 7, replyHash }],
    ['a non-hex reply hash', { replyItemCount: 6, replyHash: `${'z'.repeat(30)}${'0'.repeat(34)}`.slice(0, 64) }],
    ['an uppercase reply hash', { replyItemCount: 6, replyHash: 'AB'.repeat(32) }],
    ['a truncated reply hash', { replyItemCount: 6, replyHash: 'ab'.repeat(31) }],
  ])('rejects a stale reply held with %s', async (_label, fields) => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await startStaleBatch(send);
    await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'fulfilled', code: null, cleanup: false });
    await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'fulfilled', code: null, cleanup: false, operationAborted: false, cancellationReason: null });
    expect((await send.send('stale-reply-held', { sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds, ...fields })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });
  });

  it('refuses the release-stale grant before B is accepted and never grants partially', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await holdStale(send);
    expect((await control(value, 'release-stale')).status).toBe(409);
    expect(value.collector.snapshot()).toMatchObject({ releaseStaleAuthorized: false, failure: null });
    await control(value, 'navigate-to-b');
    expect((await control(value, 'release-stale')).status).toBe(409);
    expect(value.collector.snapshot()).toMatchObject({ releaseStaleAuthorized: false, failure: null });
  });

  it('rejects a release more than 6000 ms after the hold (the production 8000 ms timeout bound)', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    await holdStale(send);
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6100);
      await navigateAndAcceptB(value, send, { navCursor: cursor(value) });
      expect((await control(value, 'release-stale')).status).toBe(200);
      expect((await send.send('stale-reply-released', { sessionId: 'session-A', messageId: 'a-held' })).status).toBe(400);
      expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false, releaseStaleAuthorized: true });
    } finally { vi.useRealTimers(); }
  });

  it('a terminal error report sets the failure and proofComplete stays false', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await submit(send, 'session-start', sessionStartA(value));
    await submit(send, 'error', { code: 'PROVIDER_ERROR' });
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROVIDER_ERROR' }, proofComplete: false });
    expect((await control(value, 'navigate-to-b')).status).toBe(503);
  });

  it.each([
    ['unknown control route', async value => ({ status: (await fetch(`${value.routes.origin}/__page-translation-replacement/control/unknown`, { headers: { authorization: `Bearer ${base.authToken}` } })).status })],
    ['unknown query-bearing route', async value => ({ status: (await fetch(`${value.collector.controlUrl('release-stale')}?x=1`, { headers: { authorization: `Bearer ${base.authToken}` } })).status })],
  ])('rejects %s', async (_label, request, expected = 404) => {
    const value = await setup();
    expect((await request(value)).status).toBe(expected);
  });

  it('rejects unauthenticated requests', async () => {
    const value = await setup();
    expect((await fetch(value.collector.reportUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(value.collector.controlUrl('release-stale'))).status).toBe(401);
  });

  it('rejects wrong-origin requests', async () => {
    const value = await setup();
    expect((await fetch(value.collector.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${base.authToken}`, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(value.collector.controlUrl('release-stale'), { headers: { authorization: `Bearer ${base.authToken}`, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('the Phase 2B collector is unaffected: it still rejects stale-reply-held and unknown controls', async () => {
    const value = await setupReplacement(); const send = reporter(value); send.value = value;
    await submit(send, 'session-start', sessionStartA(value));
    expect(Object.keys(replacementEventSchemas)).toContain('stale-reply-held');
    expect((await send.send('stale-reply-held', { sessionId: 'session-A', messageId: 'a-held', targetIds: ['target-0'], replyItemCount: 1, replyHash })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false, currentRoute: value.routes.A });
    expect(() => value.collector.controlUrl('release-stale')).toThrow();
  });

  // Full happy path minus the release/rejection pair, used by the outcome test.
  async function finishScenarioLite(value, send) {
    await firstAcceptedA(send);
    await holdStale(send);
    await navigateAndAcceptB(value, send);
    const grant = await control(value, 'release-stale'); expect(grant.status).toBe(200);
    await submit(send, 'stale-reply-released', { sessionId: 'session-A', messageId: 'a-held' });
  }
});

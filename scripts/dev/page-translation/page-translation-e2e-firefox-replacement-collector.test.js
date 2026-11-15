import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { Buffer } from 'node:buffer';
import { createReplacementCollector } from './e2e-firefox/runtime-replacement-collector.mjs';
import { replacementCancellationReasons, replacementEventSchemas, replacementProtocol } from './e2e-firefox/runtime-replacement-protocol.mjs';

const base = { runId: 'replacement-test', authToken: 'a'.repeat(64), expectedExtensionId: 'extension@test', expectedTabId: 7, expectedDocumentId: 'doc-7' };
const active = [];
async function setup(overrides = {}) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const collector = createReplacementCollector({ ...base, ...overrides, fixtureUrl }); collector.attach(server); active.push({ server, collector });
  return { server, collector, routes: collector.routes };
}
afterEach(async () => {
  await Promise.all(active.splice(0).map(async ({ server, collector }) => { await collector.drain(); await new Promise(resolve => server.close(resolve)); }));
});

const targetRange = (start, end) => Array.from({ length: end - start }, (_, i) => `target-${start + i}`);
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

async function firstAcceptedA(send, initialCursor = null, root = { status: 'fulfilled', code: null }) {
  const ids = targetRange(0, 6);
  await submit(send, 'session-start', { owner: 'A', sessionId: 'session-A', currentUrl: send.value.routes.A, isAuto: true,
    autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: initialCursor });
  await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', targetIds: ids });
  await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', invocationId: 'invoke-a-accepted', targetIds: ids });
  await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-accepted', invocationId: 'invoke-a-accepted', attemptId: 'attempt-a-accepted', targetIds: ids });
  await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-accepted', attemptId: 'attempt-a-accepted', outcome: 'fulfilled', code: null, cleanup: false });
  await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-accepted', status: root.status, code: root.code,
    cleanup: false, operationAborted: false, cancellationReason: null });
  await submit(send, 'accepted-A', { sessionId: 'session-A', messageId: 'a-accepted', targetIds: ids });
}

async function navigateWithHeld(value, send, { initialCursor = null, root } = {}) {
  send.value = value;
  await firstAcceptedA(send, initialCursor, root);
  const pendingIds = targetRange(6, 12);
  await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', targetIds: pendingIds });
  await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId: 'invoke-a-held', targetIds: pendingIds });
  await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'a-held', invocationId: 'invoke-a-held', attemptId: 'attempt-a-held', targetIds: pendingIds });
  const authorization = await control(value, 'navigate-to-b');
  if (authorization.status !== 200) return { pendingIds, authorization };
  send.at(value.routes.B);
  const navCursor = cursor(value);
  await submit(send, 'spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: navCursor });
  return { navCursor, pendingIds, authorization };
}

// This is protocol-shaped test input, not browser/runtime evidence.
async function finishScenario(value, options = {}) {
  const send = reporter(value); send.value = value;
  const { navCursor, pendingIds } = await navigateWithHeld(value, send);
  await submit(send, 'stop-ack', stopAck(navCursor));
  await submit(send, 'session-start', { owner: 'B', sessionId: 'session-B', currentUrl: value.routes.B, isAuto: true,
    autoTranslateOnDomChanges: true, preserveAcceptedTranslations: true,
    cursor: { url: navCursor.url, routeRevision: navCursor.routeRevision, documentEpoch: navCursor.documentEpoch } });
  await submit(send, 'controller-abort', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', aborted: true, cause: 'spa-navigation' });
  await submit(send, 'physical-settled', { sessionId: 'session-A', messageId: 'a-held', attemptId: 'attempt-a-held', outcome: 'cancelled', code: 'AbortError', cleanup: false });
  if (!options.omitHeldRoot) await submit(send, 'provider-root-settled', { sessionId: 'session-A', messageId: 'a-held', status: 'rejected', code: null,
    cleanup: false, operationAborted: true, cancellationReason: 'operation-abort' });
  await submit(send, 'retained-A', { sessionId: 'session-B', sourceSessionId: 'session-A', targetIds: targetRange(0, 6) });
  await submit(send, 'scheduler-batch', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', targetIds: pendingIds });
  await submit(send, 'provider-invoked', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'invoke-b', targetIds: pendingIds });
  await submit(send, 'physical-start', { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'invoke-b', attemptId: 'attempt-b', targetIds: pendingIds });
  await submit(send, 'physical-settled', { sessionId: 'session-B', messageId: 'b-batch', attemptId: 'attempt-b', outcome: 'fulfilled', code: null, cleanup: false });
  await submit(send, 'provider-root-settled', { sessionId: 'session-B', messageId: 'b-batch', status: 'fulfilled', code: null,
    cleanup: false, operationAborted: false, cancellationReason: null });
  await submit(send, 'accepted-B', { sessionId: 'session-B', messageId: 'b-batch', targetIds: pendingIds, source: 'provider' });
  if (options.beforeStopB) await options.beforeStopB(value, send);
  if (!options.omitStopB) await submit(send, 'stop-B', { sessionId: 'session-B', success: true, resultSessionId: 'session-B', isAutoTranslating: false,
    bridgeActive: false, schedulerActive: false, discoveryActive: false, observerRelease: { expected: 1, released: 1, failed: 0 } },
    options.stopBExpected ?? 200);
  if (options.beforeCleanup) await options.beforeCleanup(value, send);
  const cleanupReport = await send.send('cleanup', { activeOperations: 0, pendingRequests: 0, cleanupCancelledAttemptIds: [] });
  expect(cleanupReport.status, JSON.stringify(value.collector.snapshot())).toBe(options.cleanupExpected ?? 200);
  return { send, navCursor, pendingIds };
}
const stopAck = (navigationCursor, overrides = {}) => ({ sessionId: 'session-A', navigationCursor, success: true,
  cancellationReason: 'operation-abort', resultSessionId: 'session-A', isAutoTranslating: false, ...overrides });
function finalTargets() {
  return Array.from({ length: 12 }, (_, i) => ({ targetId: `target-${i}`, owner: 'B', state: i < 6 ? 'retained' : 'accepted', hash: `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32) }));
}

describe('Phase 2B replacement protocol collector', () => {
  it('exports exact schemas and completes A-to-B only after authenticated navigation and final DOM', async () => {
    const value = await setup(); const { send, navCursor } = await finishScenario(value);
    expect(replacementProtocol).toMatchObject({ operation: 'firefox-page-replacement', version: 1,
      controlPaths: { navigateToB: '/__page-translation-replacement/control/navigate-to-b', captureFinal: '/__page-translation-replacement/control/capture-final' } });
    expect(Object.keys(replacementEventSchemas)).toContain('stop-B');
    expect(replacementCancellationReasons).toEqual(['operation-abort']);
    const capture = await control(value, 'capture-final'); expect(capture.status).toBe(200);
    await submit(send, 'final-dom', { sessionId: 'session-B', targets: finalTargets(), postInvalidationAWrites: [] });
    expect(value.collector.snapshot()).toMatchObject({ currentRoute: value.routes.B, navigation: { cursor: navCursor }, proofComplete: true,
      finalDOM: { sessionId: 'session-B', postInvalidationAWrites: [] }, sessions: { A: 'session-A', B: 'session-B' }, failure: null });
    const detached = value.collector.snapshot(); detached.finalDOM.targets[0].hash = '00'.repeat(32);
    expect(value.collector.snapshot().finalDOM.targets[0].hash).not.toBe('00'.repeat(32));
  });

  it('keeps authorization separate from observed navigation and rejects invalid cursors/routes through transition', async () => {
    const value = await setup(); const send = reporter(value); send.value = value; await firstAcceptedA(send);
    const ids = targetRange(6, 12);
    await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    expect((await control(value, 'navigate-to-b')).status).toBe(200);
    expect(value.collector.snapshot().currentRoute).toBe(value.routes.A);
    send.at(value.routes.B);
    expect((await send.send('spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: { ...cursor(value), url: value.routes.A } })).status).toBe(400);
    expect(value.collector.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });

    const transition = await setup(); const transitionSend = reporter(transition); transitionSend.value = transition;
    await firstAcceptedA(transitionSend);
    await submit(transitionSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(transitionSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(transitionSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    // Without the control authorization the observed navigation is not
    // admitted; the sender URL no longer carries the route.
    expect((await transitionSend.send('spa-navigation', { fromUrl: transition.routes.A, toUrl: transition.routes.B, cursor: cursor(transition) })).status).toBe(400);
    expect(transition.collector.snapshot().currentRoute).toBe(transition.routes.A);

    const staleCursor = await setup(); const staleSend = reporter(staleCursor); staleSend.value = staleCursor;
    const initial = { documentEpoch: 4, routeRevision: 7, url: staleCursor.routes.A };
    await firstAcceptedA(staleSend, initial);
    await submit(staleSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(staleSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(staleSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    await control(staleCursor, 'navigate-to-b'); staleSend.at(staleCursor.routes.B);
    expect((await staleSend.send('spa-navigation', { fromUrl: staleCursor.routes.A, toUrl: staleCursor.routes.B, cursor: cursor(staleCursor, 7) })).status).toBe(400);
    expect(staleCursor.collector.snapshot().currentRoute).toBe(staleCursor.routes.A);

    const zeroEpoch = await setup(); const zeroSend = reporter(zeroEpoch); zeroSend.value = zeroEpoch;
    await firstAcceptedA(zeroSend);
    await submit(zeroSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(zeroSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(zeroSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'attempt', targetIds: ids });
    await control(zeroEpoch, 'navigate-to-b'); zeroSend.at(zeroEpoch.routes.B);
    expect((await zeroSend.send('spa-navigation', { fromUrl: zeroEpoch.routes.A, toUrl: zeroEpoch.routes.B,
      cursor: { documentEpoch: 0, routeRevision: 9, url: zeroEpoch.routes.B } })).status).toBe(400);
  });

  it.each([
    ['frame', { frameId: 2 }], ['wrong tab', { tabId: 8 }], ['wrong document', { documentId: 'new-doc' }],
    ['third route', { url: 'http://127.0.0.1:1234/other' }],
  ])('rejects wrong initial sender %s', async (_label, changes) => {
    const value = await setup(); const bad = sender(value.routes.A, changes);
    const response = await fetch(value.collector.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${base.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, runId: base.runId, seq: 1, operation: replacementProtocol.operation, event: 'session-start', evidence: {
        owner: 'A', sessionId: 'A', currentUrl: value.routes.A, isAuto: true, autoTranslateOnDomChanges: true,
        preserveAcceptedTranslations: false, cursor: null, sender: bad,
      } }) });
    expect(response.status).toBe(400); expect(value.collector.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
  });

  it('pins an unknown bootstrap document once from the first real A sender', async () => {
    const value = await setup({ expectedDocumentId: null }); const send = reporter(value); send.value = value;
    const session = { owner: 'A', sessionId: 'session-A', currentUrl: value.routes.A, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null };
    expect((await send.send('session-start', session, { documentId: 'actual-document' })).status).toBe(200);
    expect((await send.send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'batch-A', targetIds: ['target-0'] },
      { documentId: 'replacement-document' })).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ sessions: { A: 'session-A' }, failure: { code: 'PROTOCOL_REJECTED' } });
  });

  it('requires auto settings and exact observed navigation cursor for B without manufacturing A cursor', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send);
    const ids = targetRange(6, 12);
    await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    await control(value, 'navigate-to-b'); send.at(value.routes.B);
    const navCursor = cursor(value); await submit(send, 'spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: navCursor });
    const wrong = await send.send('session-start', { owner: 'B', sessionId: 'B', currentUrl: value.routes.B, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: navCursor });
    expect(wrong.status).toBe(400);

    const other = await setup(); const otherSend = reporter(other); otherSend.value = other; await firstAcceptedA(otherSend);
    await submit(otherSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(otherSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(otherSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    await control(other, 'navigate-to-b'); otherSend.at(other.routes.B); const actual = cursor(other);
    await submit(otherSend, 'spa-navigation', { fromUrl: other.routes.A, toUrl: other.routes.B, cursor: actual });
    await submit(otherSend, 'session-start', { owner: 'B', sessionId: 'B', currentUrl: other.routes.B, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: true, cursor: actual });
  });

  it('gates navigation on the pending second A request and correlates Stop ack to navigation cursor', async () => {
    const value = await setup(); const send = reporter(value); send.value = value; await firstAcceptedA(send);
    expect((await control(value, 'navigate-to-b')).status).toBe(409);
    const ids = targetRange(6, 12);
    await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    expect((await control(value, 'navigate-to-b')).status).toBe(200);
    send.at(value.routes.B); const navCursor = cursor(value); await submit(send, 'spa-navigation', { fromUrl: value.routes.A, toUrl: value.routes.B, cursor: navCursor });
    expect((await send.send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'late', targetIds: ['target-12'] })).status).toBe(400);

    const correlated = await setup(); const correlatedSend = reporter(correlated); correlatedSend.value = correlated;
    await firstAcceptedA(correlatedSend);
    await submit(correlatedSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(correlatedSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(correlatedSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'held-attempt', targetIds: ids });
    await control(correlated, 'navigate-to-b'); correlatedSend.at(correlated.routes.B); const observed = cursor(correlated);
    await submit(correlatedSend, 'spa-navigation', { fromUrl: correlated.routes.A, toUrl: correlated.routes.B, cursor: observed });
    expect((await correlatedSend.send('stop-ack', stopAck(cursor(correlated, 9)))).status).toBe(400);
  });

  it.each([
    ['wrong cancellation reason', { cancellationReason: 'user-stop' }],
    ['wrong result session', { resultSessionId: 'other-session' }],
    ['still auto translating', { isAutoTranslating: true }],
  ])('rejects Stop ack with %s', async (_label, invalidFields) => {
    const value = await setup(); const send = reporter(value);
    const { navCursor } = await navigateWithHeld(value, send);
    expect((await send.send('stop-ack', stopAck(navCursor, invalidFields))).status).toBe(400);
  });

  it('does not authorize navigation or completion when the accepted A Provider-root rejected', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await firstAcceptedA(send, null, { status: 'rejected', code: 'NETWORK_ERROR' });
    const ids = targetRange(6, 12);
    await submit(send, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(send, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(send, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'attempt', targetIds: ids });
    expect((await control(value, 'navigate-to-b')).status).toBe(409);
    expect((await control(value, 'capture-final')).status).toBe(409);
    expect(value.collector.snapshot()).toMatchObject({ navigation: null, proofComplete: false, failure: null });
  });

  it('allows A settlement after B registration, preserves native codes, and rejects cleanup-induced abort', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    await finishScenario(value);
    expect(value.collector.snapshot().failure).toBeNull();
    const physical = value.collector.snapshot().reports.find(item => item.event === 'physical-settled' && item.evidence.messageId === 'a-held');
    const root = value.collector.snapshot().reports.find(item => item.event === 'provider-root-settled' && item.evidence.messageId === 'a-held');
    expect(physical.evidence).toMatchObject({ outcome: 'cancelled', code: 'AbortError', cleanup: false });
    expect(root.evidence).toMatchObject({ status: 'rejected', code: null, cleanup: false,
      operationAborted: true, cancellationReason: 'operation-abort' });

    const bad = await setup(); const badSend = reporter(bad); badSend.value = bad; await firstAcceptedA(badSend);
    const ids = targetRange(6, 12);
    await submit(badSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'held', targetIds: ids });
    await submit(badSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', targetIds: ids });
    await submit(badSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'held', invocationId: 'invoke', attemptId: 'attempt', targetIds: ids });
    await control(bad, 'navigate-to-b'); badSend.at(bad.routes.B); const navCursor = cursor(bad);
    await submit(badSend, 'spa-navigation', { fromUrl: bad.routes.A, toUrl: bad.routes.B, cursor: navCursor });
    await submit(badSend, 'stop-ack', stopAck(navCursor));
    await submit(badSend, 'controller-abort', { sessionId: 'session-A', messageId: 'held', attemptId: 'attempt', aborted: true, cause: 'spa-navigation' });
    expect((await badSend.send('physical-settled', { sessionId: 'session-A', messageId: 'held', attemptId: 'attempt', outcome: 'cancelled', code: 'ABORTED', cleanup: true })).status).toBe(400);
  });

  it('requires 12 unique B-owned final targets, retained/fresh distinction, hashes, and zero post-invalidation A writes', async () => {
    const value = await setup(); const { send } = await finishScenario(value);
    expect((await control(value, 'capture-final')).status).toBe(200);
    const invalid = finalTargets(); invalid[6] = { ...invalid[6], owner: 'A' };
    expect((await send.send('final-dom', { sessionId: 'session-B', targets: invalid, postInvalidationAWrites: [] })).status).toBe(400);
    expect(value.collector.snapshot().proofComplete).toBe(false);

    const good = await setup(); const { send: goodSend } = await finishScenario(good);
    await control(good, 'capture-final');
    expect((await goodSend.send('final-dom', { sessionId: 'session-B', targets: finalTargets(), postInvalidationAWrites: ['target-11'] })).status).toBe(400);
    expect(good.collector.snapshot().proofComplete).toBe(false);
  });

  it('refuses cleanup with a missing A root or an unstarted admitted batch', async () => {
    const missingRoot = await setup();
    await finishScenario(missingRoot, { omitHeldRoot: true, stopBExpected: 400, cleanupExpected: 503 });
    expect(missingRoot.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' }, captureAuthorized: false });
    expect((await control(missingRoot, 'capture-final')).status).toBe(503);

    const missingAttempt = await setup();
    await finishScenario(missingAttempt, { cleanupExpected: 503, stopBExpected: 400, beforeStopB: async (_value, send) => {
      await submit(send, 'scheduler-batch', { owner: 'B', sessionId: 'session-B', messageId: 'unstarted-batch', targetIds: ['target-0'] });
    } });
    expect(missingAttempt.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' }, captureAuthorized: false });

    const missingStopB = await setup();
    await finishScenario(missingStopB, { omitStopB: true, cleanupExpected: 400 });
    expect(missingStopB.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' }, captureAuthorized: false });
  });

  it('requires native Provider-root cancellation facts and a clean production Stop-B fence', async () => {
    const value = await setup();
    await finishScenario(value, { omitStopB: true, cleanupExpected: 503, beforeStopB: async (_value, send) => {
      expect((await send.send('stop-B', { sessionId: 'session-B', success: true, resultSessionId: 'session-B', isAutoTranslating: false,
        bridgeActive: false, schedulerActive: true, discoveryActive: false })).status).toBe(400);
    } });
    expect(value.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' } });

    const bootstrap = await setup({ expectedDocumentId: null }); const bootstrapSend = reporter(bootstrap); bootstrapSend.value = bootstrap;
    const start = { owner: 'A', sessionId: 'session-A', currentUrl: bootstrap.routes.A, isAuto: true, autoTranslateOnDomChanges: true,
      preserveAcceptedTranslations: false, cursor: null };
    expect((await bootstrapSend.send('session-start', start, { documentId: 'actual-doc' })).status).toBe(200);
    expect((await bootstrapSend.send('scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'batch', targetIds: ['target-0'] },
      { documentId: 'other-doc' })).status).toBe(400);
    expect(bootstrap.collector.snapshot()).toMatchObject({ sessions: { A: 'session-A' }, failure: { code: 'PROTOCOL_REJECTED' } });
  });

  it('rejects stop-B with an incomplete or failing observer-release probe', async () => {
    const failing = await setup();
    await finishScenario(failing, { omitStopB: true, cleanupExpected: 503, beforeStopB: async (_value, send) => {
      expect((await send.send('stop-B', { sessionId: 'session-B', success: true, resultSessionId: 'session-B', isAutoTranslating: false,
        bridgeActive: false, schedulerActive: false, discoveryActive: false,
        observerRelease: { expected: 1, released: 1, failed: 1 } })).status).toBe(400);
    } });
    expect(failing.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' } });

    const skipped = await setup();
    await finishScenario(skipped, { omitStopB: true, cleanupExpected: 503, beforeStopB: async (_value, send) => {
      expect((await send.send('stop-B', { sessionId: 'session-B', success: true, resultSessionId: 'session-B', isAutoTranslating: false,
        bridgeActive: false, schedulerActive: false, discoveryActive: false,
        observerRelease: { expected: 0, released: 0, failed: 0 } })).status).toBe(400);
    } });
    expect(skipped.collector.snapshot()).toMatchObject({ proofComplete: false, failure: { code: 'PROTOCOL_REJECTED' } });
  });

  it.each(['scheduler-batch', 'provider-invoked', 'physical-start'])('rejects %s work after the cleanup fence', async event => {
    const value = await setup(); const { send } = await finishScenario(value);
    const fields = event === 'scheduler-batch'
      ? { owner: 'B', sessionId: 'session-B', messageId: 'late-batch', targetIds: ['target-0'] }
      : event === 'provider-invoked'
        ? { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'late-invocation', targetIds: targetRange(6, 12) }
        : { owner: 'B', sessionId: 'session-B', messageId: 'b-batch', invocationId: 'invoke-b', attemptId: 'late-attempt', targetIds: targetRange(6, 12) };
    expect((await send.send(event, fields)).status).toBe(400);
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, proofComplete: false });
  });

  it('clears proofComplete when a terminal error arrives after final DOM', async () => {
    const value = await setup(); const { send } = await finishScenario(value);
    expect((await control(value, 'capture-final')).status).toBe(200);
    await submit(send, 'final-dom', { sessionId: 'session-B', targets: finalTargets(), postInvalidationAWrites: [] });
    expect(value.collector.snapshot().proofComplete).toBe(true);
    await submit(send, 'error', { code: 'DOM_MISMATCH' });
    expect(value.collector.snapshot()).toMatchObject({ failure: { code: 'DOM_MISMATCH' }, proofComplete: false, finalDOM: { sessionId: 'session-B' } });
  });

  it('rejects replay, out-of-order/cross-session reports, malformed evidence and bounded body overflow', async () => {
    const value = await setup(); const send = reporter(value); send.value = value;
    expect((await send.send('scheduler-batch', { owner: 'A', sessionId: 'A', messageId: 'x', targetIds: ['target-0'] })).status).toBe(400);
    expect(value.collector.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
    const replay = await setup(); const replaySend = reporter(replay); replaySend.value = replay;
    await submit(replaySend, 'session-start', { owner: 'A', sessionId: 'session-A', currentUrl: replay.routes.A, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null });
    expect((await replaySend.send('session-start', { owner: 'A', sessionId: 'session-A', currentUrl: replay.routes.A, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null })).status).toBe(400);
    const duplicate = await setup(); const duplicateSend = reporter(duplicate); duplicateSend.value = duplicate;
    await submit(duplicateSend, 'session-start', { owner: 'A', sessionId: 'session-A', currentUrl: duplicate.routes.A, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null });
    const batch = { owner: 'A', sessionId: 'session-A', messageId: 'same-batch', targetIds: ['target-0'] };
    await submit(duplicateSend, 'scheduler-batch', batch);
    expect((await duplicateSend.send('scheduler-batch', batch)).status).toBe(400);
    const wrongSession = await setup(); const wrongSessionSend = reporter(wrongSession); wrongSessionSend.value = wrongSession;
    await submit(wrongSessionSend, 'session-start', { owner: 'A', sessionId: 'session-A', currentUrl: wrongSession.routes.A, isAuto: true,
      autoTranslateOnDomChanges: true, preserveAcceptedTranslations: false, cursor: null });
    await submit(wrongSessionSend, 'scheduler-batch', { owner: 'A', sessionId: 'session-A', messageId: 'batch', targetIds: ['target-0'] });
    await submit(wrongSessionSend, 'provider-invoked', { owner: 'A', sessionId: 'session-A', messageId: 'batch', invocationId: 'invoke', targetIds: ['target-0'] });
    await submit(wrongSessionSend, 'physical-start', { owner: 'A', sessionId: 'session-A', messageId: 'batch', invocationId: 'invoke', attemptId: 'attempt', targetIds: ['target-0'] });
    expect((await wrongSessionSend.send('physical-settled', { sessionId: 'cross-session', messageId: 'batch', attemptId: 'attempt', outcome: 'fulfilled', code: null, cleanup: false })).status).toBe(400);
    const oversized = await setup();
    expect((await fetch(oversized.collector.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${base.authToken}`, 'content-type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1) })).status).toBe(413);
  });

  it('drain destroys and awaits an incomplete body, and failure rejects waiters promptly', async () => {
    const value = await setup(); const waiter = value.collector.waitFor('accepted-B', { timeoutMs: 10_000 });
    const waiterRejected = expect(waiter).rejects.toThrow('closed');
    const socket = connect(value.server.address().port, '127.0.0.1'); socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`POST ${replacementProtocol.reportPath} HTTP/1.1\r\nHost: 127.0.0.1:${value.server.address().port}\r\nAuthorization: Bearer ${base.authToken}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{`);
    await new Promise(resolve => setTimeout(resolve, 5));
    const closed = new Promise(resolve => socket.once('close', resolve));
    expect(await value.collector.drain({ timeoutMs: 1000 })).toBe(true);
    await closed; await waiterRejected;
    expect(socket.destroyed).toBe(true);
  });

  it('does not accept a report whose body completes after another report terminally fails the protocol', async () => {
    const value = await setup();
    const waiting = value.collector.waitFor('accepted-B', { timeoutMs: 10_000 });
    const waitFailed = expect(waiting).rejects.toThrow('terminal failure');
    const socket = connect(value.server.address().port, '127.0.0.1'); socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    let rawResponse = '';
    socket.on('data', chunk => { rawResponse += chunk.toString(); });
    const body = JSON.stringify({ v: 1, runId: base.runId, seq: 1, operation: replacementProtocol.operation, event: 'session-start', evidence: {
      owner: 'A', sessionId: 'late-session', currentUrl: value.routes.A, isAuto: true, autoTranslateOnDomChanges: true,
      preserveAcceptedTranslations: false, cursor: null, sender: sender(value.routes.A),
    } });
    const split = Math.floor(body.length / 2);
    const receivedFirstPart = new Promise(resolve => value.server.once('request', request => {
      if (request.url !== replacementProtocol.reportPath) return;
      request.once('data', resolve);
    }));
    socket.write(`POST ${replacementProtocol.reportPath} HTTP/1.1\r\nHost: 127.0.0.1:${value.server.address().port}\r\nAuthorization: Bearer ${base.authToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, split)}`);
    await receivedFirstPart;
    const invalid = await fetch(value.collector.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${base.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, runId: base.runId, seq: 1, operation: replacementProtocol.operation, event: 'scheduler-batch', evidence: {
        owner: 'A', sessionId: 'missing', messageId: 'missing', targetIds: ['target-0'], sender: sender(value.routes.A),
      } }) });
    expect(invalid.status).toBe(400);
    await waitFailed;
    socket.write(body.slice(split));
    await new Promise(resolve => socket.once('end', resolve));
    expect(rawResponse).toMatch(/^HTTP\/1\.1 503/m);
    expect(value.collector.snapshot()).toMatchObject({ accepted: 0, failure: { code: 'PROTOCOL_REJECTED' }, sessions: {} });
  });
});

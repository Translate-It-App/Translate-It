import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createFixture, startFixture } from './page-translation-e2e-benchmark/fixture.mjs';
import { createHash } from 'node:crypto';
import { createEdgeProviderProbe } from './page-translation-e2e-benchmark/provider-probe.mjs';
import { mapEdgeResponse } from './page-translation-e2e-benchmark/metrics.mjs';
import { targetTexts } from './page-translation-e2e-benchmark/fixture.mjs';

const authToken = 'ab'.repeat(32);
const runId = 'edge-provider-probe-test';
const expectedExtensionId = 'probe@example.test';
const origin = 'moz-extension://01234567-89ab-cdef-0123-456789abcdef';
const opened = [];
async function create() {
  const fixture = await startFixture(createFixture(), { runtimeBridge: { authToken, runId, expectedExtensionId } });
  opened.push(fixture);
  return fixture;
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map(async ({ bridge, server }) => {
    bridge.closeAdmission();
    await new Promise(resolve => server.close(resolve));
  }));
});

async function post(fixture, payload) {
  return fetch(fixture.bridge.reportUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json', origin },
    body: JSON.stringify(payload),
  });
}

async function completeStartup(fixture) {
  const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
  const bgChecks = Object.fromEntries(['lifecycleInitialized', 'translationEngineInitialized', 'enginePresent', 'unifiedEngineMatches', 'unifiedServiceMatches', 'messageListenerActive', 'startupComplete'].map(key => [key, true]));
  const startup = [
    ['background', 'bootstrap', { extensionId: expectedExtensionId, extensionOrigin: origin, tabId: 9 }],
    ['background', 'loaded', { entry: 'src/core/background/index.js' }],
    ['background', 'ready', { checks: bgChecks, hostPermission: true }],
    ['content', 'loaded', { entry: 'src/core/content-scripts/index-main.js', sender, navigationGeneration: 1 }],
    ['content', 'ready', { checks: { coreInitialized: true, listenerActive: true, featureManagerInitialized: true, handlerActive: true, handlerIsActive: true }, flags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }, sender, navigationGeneration: 1, ackReceived: true }],
  ];
  for (const [index, [realm, phase, evidence]] of startup.entries()) {
    const response = await post(fixture, { v: 1, runId, seq: index + 1, realm, phase, evidence });
    expect(response.status).toBe(200);
  }
}

const indices = Array.from({ length: 12 }, (_, index) => index);
const invocation = { invocationId: 'invocation-1', sessionId: 'session-1', messageId: 'message-1', provider: 'edge', itemCount: 12, sourceIndexes: indices };
const edgeUrl = 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=fr';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for actual Edge provider observations');
}

describe('Firefox Edge provider operation collector', () => {
  it('observes but does not replace the actual PRE/native request promise or Edge parser result', async () => {
    const reports = [];
    const execution = deferred();
    const nativeRequest = deferred();
    let probe;
    let proxyRequest;
    const proxyManager = {
      isEnabled: config => config?.enabled === true,
      fetch(url, options, requestConfig) {
        probe.observeDirectFetch(url, options, nativeRequest.promise, !this.isEnabled(requestConfig));
        return nativeRequest.promise;
      },
    };
    const ProviderRequestEngine = { executeApiCall(provider, options) { return proxyManager.fetch(options.url, options.fetchOptions, { enabled: false }); } };
    const Edge = class { _translateChunk(...args) {
      proxyRequest = ProviderRequestEngine.executeApiCall(this, { url: edgeUrl, fetchOptions: { method: 'POST', body: JSON.stringify(targetTexts) }, sessionId: args[9]?.sessionId });
      return execution.promise;
    } };
    const unifiedTranslationService = { handleTranslationRequest(message) {
      expect(message).toMatchObject({ action: 'page-translate', context: 'content', data: { provider: 'edge', targetLanguage: 'fr' } });
      return new Edge()._translateChunk(targetTexts, null, 'fr', 'page', null, 0, 12, 0, 1, { sessionId: 'session-1', messageId: 'message-1' });
    } };
    probe = createEdgeProviderProbe(async (event, evidence) => { reports.push({ event, evidence }); });
    expect(probe.install({ MicrosoftEdgeProvider: Edge, unifiedTranslationService, ProviderRequestEngine, proxyManager })).toBe(true);
    expect(probe.proxyDisabled()).toBe(true);
    probe.arm();
    const originalPromise = unifiedTranslationService.handleTranslationRequest({ action: 'page-translate', context: 'content', messageId: 'message-1', data: { provider: 'edge', targetLanguage: 'fr', sessionId: 'session-1' } });
    expect(originalPromise).toBe(execution.promise);
    expect(proxyRequest).toBe(nativeRequest.promise);
    const body = JSON.stringify(targetTexts);
    nativeRequest.resolve({ status: 200 });
    await waitUntil(() => reports.some(report => report.event === 'physical-settled'));
    execution.resolve(mapEdgeResponse(targetTexts).map(item => item.translations[0].text));
    await originalPromise;
    await waitUntil(() => reports.some(report => report.event === 'physical-settled') && reports.some(report => report.event === 'parser-success'));

    expect(reports.map(report => report.event)).toEqual(expect.arrayContaining([
      'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled',
    ]));
    const physical = reports.find(report => report.event === 'physical-start').evidence;
    expect(physical).toMatchObject({
      attemptId: 'edge-fr-attempt-1', invocationId: 'edge-fr-invocation-1', sessionId: 'session-1', messageId: 'message-1',
      provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: Buffer.byteLength(body),
      bodyHash: createHash('sha256').update(body).digest('hex'), sourceIndexes: indices,
    });
    expect(reports.find(report => report.event === 'parser-success').evidence.resultsMatch).toBe(true);
    expect(reports.some(report => report.event === 'command-result')).toBe(false);
    expect(JSON.stringify(reports)).not.toContain(targetTexts[0]);
  });

  it('runs the provider-only entry through the real Edge chunk/request instrumentation', async () => {
    const reports = [];
    let probe;
    const proxyManager = {
      isEnabled: config => config?.enabled === true,
      fetch(url, options, requestConfig) {
        const response = Promise.resolve({ status: 200 });
        probe.observeDirectFetch(url, options, response, !this.isEnabled(requestConfig));
        return response;
      },
    };
    const ProviderRequestEngine = { executeApiCall(provider, options) { return proxyManager.fetch(options.url, options.fetchOptions, { enabled: false }); } };
    const Edge = class { _translateChunk(texts, ...args) {
      return ProviderRequestEngine.executeApiCall(this, {
        url: edgeUrl, fetchOptions: { method: 'POST', body: JSON.stringify(texts) }, sessionId: args[8]?.sessionId,
      }).then(() => mapEdgeResponse(texts).map(item => item.translations[0].text));
    } };
    probe = createEdgeProviderProbe(async (event, evidence) => { reports.push({ event, evidence }); });
    expect(probe.install({ MicrosoftEdgeProvider: Edge, ProviderRequestEngine, proxyManager })).toBe(true);
    probe.arm();

    await expect(probe.invokeProviderOnly(Edge, targetTexts, { sessionId: 'provider-only-session', messageId: 'provider-only-message' }))
      .resolves.toEqual(mapEdgeResponse(targetTexts).map(item => item.translations[0].text));
    expect(reports.map(report => report.event)).toEqual([
      'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled',
    ]);
    expect(reports[1].evidence).toMatchObject({ sessionId: 'provider-only-session', messageId: 'provider-only-message', method: 'POST', url: edgeUrl });
    expect(reports.at(-1).evidence).toMatchObject({ outcome: 'fulfilled', code: null });
    probe.stop();
  });

  it('keeps immediate native/provider settlements causally ordered through the real collector', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let opSeq = 0;
    const report = async (event, evidence) => {
      const response = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++opSeq, event, evidence });
      expect(response.status, `${event}: ${JSON.stringify(fixture.bridge.operationSnapshot())}`).toBe(200);
      return response.json();
    };
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    await report('armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true });
    const nativePromise = Promise.resolve({ status: 200 });
    const proxyManager = {
      isEnabled: config => config?.enabled === true,
      fetch(url, options, requestConfig) {
        probe.observeDirectFetch(url, options, nativePromise, !this.isEnabled(requestConfig));
        return nativePromise;
      },
    };
    const ProviderRequestEngine = { executeApiCall(provider, options) { return proxyManager.fetch(options.url, options.fetchOptions, { enabled: false }); } };
    const Edge = class { _translateChunk(...args) {
      ProviderRequestEngine.executeApiCall(this, { url: edgeUrl, fetchOptions: { method: 'POST', body: JSON.stringify(targetTexts) }, sessionId: args[9]?.sessionId });
      return Promise.resolve(mapEdgeResponse(targetTexts).map(item => item.translations[0].text));
    } };
    const probe = createEdgeProviderProbe(report);
    expect(probe.install({ MicrosoftEdgeProvider: Edge, ProviderRequestEngine, proxyManager })).toBe(true);
    probe.arm();
    await new Edge()._translateChunk(targetTexts, null, 'fr', 'page', null, 0, 12, 0, 1, { sessionId: 'session-1', messageId: 'message-1' });
    await fixture.bridge.waitForOperation('provider-settled');
    const events = fixture.bridge.operationSnapshot().reports.map(item => item.event);
    expect(events).toEqual(['armed', 'provider-invoked', 'physical-start', 'physical-settled', 'parser-success', 'provider-settled']);
    expect(fixture.bridge.operationSnapshot().failure).toBeNull();
  });

  it('correlates overlapping disjoint provider invocations to their own native bodies and parser results', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let opSeq = 0;
    const report = async (event, evidence) => {
      const response = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++opSeq, event, evidence });
      expect(response.status, `${event}: ${JSON.stringify(fixture.bridge.operationSnapshot())}`).toBe(200);
      return response.json();
    };
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    await report('armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true });
    const pending = new Map();
    const proxyManager = {
      isEnabled: config => config?.enabled === true,
      fetch(url, options, requestConfig) {
        const request = deferred();
        const requestIndexes = options.body.match(/Benchmark sentence (\d+)/g).map(value => Number(/(\d+)/.exec(value)[1]) - 1);
        pending.set(requestIndexes.join(','), request);
        probe.observeDirectFetch(url, options, request.promise, !this.isEnabled(requestConfig));
        return request.promise;
      },
    };
    const ProviderRequestEngine = { executeApiCall(provider, options) { return proxyManager.fetch(options.url, options.fetchOptions, { enabled: false }); } };
    const Edge = class { _translateChunk(texts, ...args) {
      return Promise.resolve().then(() => ProviderRequestEngine.executeApiCall(this, {
        url: edgeUrl, fetchOptions: { method: 'POST', body: JSON.stringify(texts) }, sessionId: args[8]?.sessionId,
      })).then(() => mapEdgeResponse(texts).map(item => item.translations[0].text));
    } };
    const probe = createEdgeProviderProbe(report);
    expect(probe.install({ MicrosoftEdgeProvider: Edge, ProviderRequestEngine, proxyManager })).toBe(true);
    probe.arm();
    const firstSource = targetTexts.slice(0, 6);
    const secondSource = targetTexts.slice(6);
    const context = { sessionId: 'overlap-session', messageId: 'overlap-message' };
    const firstResult = new Edge()._translateChunk(firstSource, null, 'fr', 'page', null, 0, 12, 0, 1, context);
    const secondResult = new Edge()._translateChunk(secondSource, null, 'fr', 'page', null, 0, 12, 1, 2, context);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    expect([...pending.keys()]).toEqual(['0,1,2,3,4,5', '6,7,8,9,10,11']);
    pending.get('6,7,8,9,10,11').resolve({ status: 200 });
    pending.get('0,1,2,3,4,5').resolve({ status: 200 });
    const [firstValue, secondValue] = await Promise.all([firstResult, secondResult]);
    expect(firstValue).toEqual(mapEdgeResponse(firstSource).map(item => item.translations[0].text));
    expect(secondValue).toEqual(mapEdgeResponse(secondSource).map(item => item.translations[0].text));
    await vi.waitFor(() => expect(fixture.bridge.operationSnapshot().reports.filter(item => item.event === 'parser-success')).toHaveLength(2));
    const snapshot = fixture.bridge.operationSnapshot();
    const invoked = snapshot.reports.filter(item => item.event === 'provider-invoked');
    const physical = snapshot.reports.filter(item => item.event === 'physical-start');
    const parsed = snapshot.reports.filter(item => item.event === 'parser-success');
    expect(invoked.map(item => item.evidence.sourceIndexes)).toEqual([indices.slice(0, 6), indices.slice(6)]);
    const sourcesByInvocation = Object.fromEntries(invoked.map(item => [item.evidence.invocationId, item.evidence.sourceIndexes]));
    expect(physical).toHaveLength(2);
    expect(parsed).toHaveLength(2);
    for (const reportItem of [...physical, ...parsed]) expect(reportItem.evidence.sourceIndexes).toEqual(sourcesByInvocation[reportItem.evidence.invocationId]);
    const hashesBySources = new Map([
      [indices.slice(0, 6).join(','), createHash('sha256').update(JSON.stringify(firstSource)).digest('hex')],
      [indices.slice(6).join(','), createHash('sha256').update(JSON.stringify(secondSource)).digest('hex')],
    ]);
    for (const reportItem of physical) expect(reportItem.evidence.bodyHash).toBe(hashesBySources.get(reportItem.evidence.sourceIndexes.join(',')));
    expect(snapshot.failure).toBeNull();
    expect((await report('command-result', { success: true, sessionId: 'overlap-session', code: null })).accepted).toBe(true);
  });

  it('accepts the sequenced native request lifecycle and exposes immutable first-match wait semantics', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    const physicalStarted = () => ({
      attemptId: 'attempt-1', invocationId: invocation.invocationId, sessionId: invocation.sessionId, messageId: invocation.messageId,
      provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 256, bodyHash: 'a'.repeat(64), sourceIndexes: indices,
    });
    const evidence = [
      ['armed', { sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true }],
      ['provider-invoked', invocation],
      ['physical-start', physicalStarted()],
      ['physical-start', { ...physicalStarted(), attemptId: 'attempt-2' }],
      ['physical-settled', { attemptId: 'attempt-1', sessionId: 'session-1', outcome: 'rejected', status: null, code: 'NETWORK_ERROR' }],
      ['physical-settled', { attemptId: 'attempt-2', sessionId: 'session-1', outcome: 'fulfilled', status: 200, code: null }],
      ['parser-success', { invocationId: 'invocation-1', sessionId: 'session-1', sourceIndexes: indices, resultsMatch: true }],
      ['provider-settled', { invocationId: 'invocation-1', sessionId: 'session-1', outcome: 'fulfilled', code: null }],
      ['command-result', { success: true, sessionId: 'session-1', code: null }],
      ['translated', { sessionId: 'session-1', acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12, duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true }],
    ];
    const reports = [];
    expect(fixture.bridge.releaseProviderProbe()).toEqual({ decision: 'start' });
    for (const [index, [event, reportEvidence]] of evidence.entries()) {
      const payload = { v: 1, runId, op: 'edge-fr-page-once', opSeq: index + 1, event, evidence: reportEvidence };
      const posting = post(fixture, payload);
      if (event === 'translated') {
        await fixture.bridge.waitForOperation('translated');
        expect(fixture.bridge.decideRestore('restore')).toBe('restore');
      }
      const response = await posting;
      expect(response.status, `operation event ${event}: ${JSON.stringify(fixture.bridge.operationSnapshot())}`).toBe(200);
      const receipt = await response.json();
      expect(receipt).toMatchObject({ v: 1, runId, op: 'edge-fr-page-once', opSeq: index + 1, accepted: true });
      if (event === 'armed') expect(receipt.decision).toBe('start');
      if (event === 'translated') expect(receipt.decision).toBe('restore');
      reports.push(payload);
    }
    expect(() => fixture.bridge.releaseProviderProbe()).toThrow('one-use');
    const first = await fixture.bridge.waitForOperation('physical-start');
    const secondWait = await fixture.bridge.waitForOperation('physical-start');
    expect(first.evidence.attemptId).toBe('attempt-1');
    expect(secondWait.evidence.attemptId).toBe('attempt-1');
    expect((await fixture.bridge.waitForOperation('physical-settled')).evidence.attemptId).toBe('attempt-1');
    expect((await fixture.bridge.waitForOperation('physical-settled')).evidence.attemptId).toBe('attempt-1');
    first.evidence.attemptId = 'mutated';
    expect((await fixture.bridge.waitForOperation('physical-start')).evidence.attemptId).toBe('attempt-1');
    expect(fixture.bridge.operationSnapshot().reports).toHaveLength(10);
    const restored = { sessionId: 'session-1', commandSuccess: true, domMatchesOriginal: true, metadataRestored: true, restoreObserved: true };
    expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 11, event: 'restored', evidence: restored })).status).toBe(200);
    await expect(fixture.bridge.waitForOperation('restored')).resolves.toMatchObject({ evidence: restored });
    expect(fixture.bridge.operationSnapshot().reports.map(item => item.opSeq)).toEqual([...Array.from({ length: 11 }, (_, index) => index + 1)]);
    expect(fixture.bridge.snapshot().reports).toHaveLength(5);
    expect(reports[0].event).toBe('armed');
  });

  it('accepts PAGE_TRANSLATE success acknowledgements before provider work but gates translation on complete parser coverage', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let opSeq = 0;
    const send = (event, evidence) => post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++opSeq, event, evidence });
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    expect((await send('armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true })).status).toBe(200);
    expect((await send('command-result', { success: true, sessionId: 'ack-session', code: null })).status).toBe(200);
    expect((await send('provider-invoked', { invocationId: 'late-invocation', sessionId: 'ack-session', messageId: 'ack-session', provider: 'edge', itemCount: 12, sourceIndexes: indices })).status).toBe(200);
    const attempt = { attemptId: 'late-attempt', invocationId: 'late-invocation', sessionId: 'ack-session', messageId: 'ack-session', provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 256, bodyHash: 'f'.repeat(64), sourceIndexes: indices };
    expect((await send('physical-start', attempt)).status).toBe(200);
    expect((await send('physical-settled', { attemptId: attempt.attemptId, sessionId: 'ack-session', outcome: 'fulfilled', status: 200, code: null })).status).toBe(200);
    expect((await send('parser-success', { invocationId: 'late-invocation', sessionId: 'ack-session', sourceIndexes: indices, resultsMatch: true })).status).toBe(200);
    expect((await send('provider-settled', { invocationId: 'late-invocation', sessionId: 'ack-session', outcome: 'fulfilled', code: null })).status).toBe(200);
    const translated = send('translated', {
      sessionId: 'ack-session', acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12,
      duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
    });
    await fixture.bridge.waitForOperation('translated');
    fixture.bridge.decideRestore('stop');
    expect((await translated).status).toBe(200);
    expect(fixture.bridge.operationSnapshot().failure).toBeNull();
  });

  it('allows a success acknowledgement during transport but rejects final translation without all source coverage', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let opSeq = 0;
    const send = (event, evidence) => post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++opSeq, event, evidence });
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    expect((await send('armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true })).status).toBe(200);
    expect((await send('provider-invoked', { invocationId: 'pending-invocation', sessionId: 'pending-session', messageId: null, provider: 'edge', itemCount: 6, sourceIndexes: indices.slice(0, 6) })).status).toBe(200);
    const attempt = { attemptId: 'pending-attempt', invocationId: 'pending-invocation', sessionId: 'pending-session', messageId: null, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: 'e'.repeat(64), sourceIndexes: indices.slice(0, 6) };
    expect((await send('physical-start', attempt)).status).toBe(200);
    expect((await send('command-result', { success: true, sessionId: 'pending-session', code: null })).status).toBe(200);
    expect(fixture.bridge.operationSnapshot().reports.some(report => report.event === 'physical-settled')).toBe(false);
    expect((await send('translated', {
      sessionId: 'pending-session', acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12,
      duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
    })).status).toBe(503);
    expect(fixture.bridge.operationSnapshot()).toMatchObject({ failure: { code: 'PROTOCOL_ERROR' }, reports: expect.not.arrayContaining([expect.objectContaining({ event: 'translated' })]) });
  });

  it('rejects overlapping successful parser coverage even after an early start acknowledgement', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let opSeq = 0;
    const send = async (event, evidence) => post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++opSeq, event, evidence });
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    expect((await send('armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true })).status).toBe(200);
    expect((await send('command-result', { success: true, sessionId: 'overlap-session', code: null })).status).toBe(200);
    for (const [batch, sourceIndexes] of [[0, [0, 1, 2, 3, 4, 5]], [1, [5, 6, 7, 8, 9, 10]]]) {
      const invocationId = `overlap-${batch}`;
      const attemptId = `overlap-attempt-${batch}`;
      expect((await send('provider-invoked', { invocationId, sessionId: 'overlap-session', messageId: null, provider: 'edge', itemCount: 6, sourceIndexes })).status).toBe(200);
      expect((await send('physical-start', { attemptId, invocationId, sessionId: 'overlap-session', messageId: null, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: `${batch ? 'b' : 'a'}`.repeat(64), sourceIndexes })).status).toBe(200);
      expect((await send('physical-settled', { attemptId, sessionId: 'overlap-session', outcome: 'fulfilled', status: 200, code: null })).status).toBe(200);
      const parser = await send('parser-success', { invocationId, sessionId: 'overlap-session', sourceIndexes, resultsMatch: true });
      if (batch === 0) {
        expect(parser.status).toBe(200);
        expect((await send('provider-settled', { invocationId, sessionId: 'overlap-session', outcome: 'fulfilled', code: null })).status).toBe(200);
      } else {
        expect(parser.status).toBe(503);
      }
    }
    expect((await send('translated', {
      sessionId: 'overlap-session', acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12,
      duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
    })).status).toBe(503);
    expect(fixture.bridge.operationSnapshot().reports.filter(report => report.event === 'translated')).toHaveLength(0);
    expect(fixture.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });
  });

  it('rejects mismatched, duplicate, contradictory, or malformed PAGE_TRANSLATE success acknowledgements', async () => {
    for (const invalid of ['mismatched-session', 'duplicate', 'contradictory', 'null-session', 'failure-code']) {
      const fixture = await create();
      await completeStartup(fixture);
      fixture.bridge.releaseProviderProbe();
      const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
      expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true } })).status).toBe(200);
      const firstAck = invalid === 'null-session' ? { success: true, sessionId: null, code: null }
        : invalid === 'failure-code' ? { success: true, sessionId: 'ack-session', code: 'PROTOCOL_ERROR' }
          : { success: true, sessionId: 'ack-session', code: null };
      const firstResponse = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 2, event: 'command-result', evidence: firstAck });
      if (invalid === 'null-session' || invalid === 'failure-code') {
        expect(firstResponse.status).toBe(503);
      } else {
        expect(firstResponse.status).toBe(200);
        const second = invalid === 'mismatched-session'
          ? { v: 1, runId, op: 'edge-fr-page-once', opSeq: 3, event: 'provider-invoked', evidence: { invocationId: 'wrong-session-invocation', sessionId: 'other-session', messageId: null, provider: 'edge', itemCount: 6, sourceIndexes: indices.slice(0, 6) } }
          : { v: 1, runId, op: 'edge-fr-page-once', opSeq: 3, event: 'command-result', evidence: invalid === 'duplicate' ? firstAck : { success: false, sessionId: 'ack-session', code: 'PROTOCOL_ERROR' } };
        expect((await post(fixture, second)).status).toBe(503);
      }
      expect(fixture.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });
    }
  });

  it('holds the authenticated arm receipt until the Node-only start gate is released', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    const armed = { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: {
      sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' },
      navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true,
    } };
    let responseReceived = false;
    const pendingReceipt = post(fixture, armed).then(async response => {
      responseReceived = true;
      return { status: response.status, body: await response.json() };
    });
    await fixture.bridge.waitForOperation('armed');
    expect(responseReceived).toBe(false);
    expect(fixture.bridge.releaseProviderProbe()).toEqual({ decision: 'start' });
    expect(await pendingReceipt).toEqual({ status: 200, body: { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, accepted: true, decision: 'start' } });
  });

  it('revokes a pending restore decision when teardown closes admission before its receipt is emitted', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    const physical = { attemptId: 'attempt-close', invocationId: 'invocation-close', sessionId: 'session-close', messageId: null, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: 'd'.repeat(64), sourceIndexes: indices };
    const beforeTranslated = [
      ['armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true }],
      ['provider-invoked', { invocationId: 'invocation-close', sessionId: 'session-close', messageId: null, provider: 'edge', itemCount: 12, sourceIndexes: indices }],
      ['physical-start', physical],
      ['physical-settled', { attemptId: physical.attemptId, sessionId: physical.sessionId, outcome: 'fulfilled', status: 200, code: null }],
      ['parser-success', { invocationId: physical.invocationId, sessionId: physical.sessionId, sourceIndexes: indices, resultsMatch: true }],
      ['provider-settled', { invocationId: physical.invocationId, sessionId: physical.sessionId, outcome: 'fulfilled', code: null }],
      ['command-result', { success: true, sessionId: physical.sessionId, code: null }],
    ];
    for (const [index, [event, evidence]] of beforeTranslated.entries()) {
      const response = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: index + 1, event, evidence });
      expect(response.status).toBe(200);
    }
    const translatedPayload = { v: 1, runId, op: 'edge-fr-page-once', opSeq: beforeTranslated.length + 1, event: 'translated', evidence: {
      sessionId: physical.sessionId, acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12,
      duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
    } };
    const receiptPending = post(fixture, translatedPayload);
    await fixture.bridge.waitForOperation('translated');
    fixture.bridge.decideRestore('restore');
    fixture.bridge.closeAdmission();
    expect((await receiptPending).status).toBe(200);
    expect((await (await receiptPending).json()).decision).toBe('stop');
    expect(fixture.bridge.operationSnapshot()).toMatchObject({ restoreDecision: 'restore', stopped: true, stopCode: 'TEARDOWN' });
    expect(() => fixture.bridge.decideRestore('stop')).toThrow('invalid or already settled');
  });

  it('rejects invalid operation auth/schema/order terminally and rejects operation waiters', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    const pending = fixture.bridge.waitForOperation('armed').then(value => ({ value }), error => ({ error }));
    const invalid = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'provider-invoked', evidence: invocation });
    expect(invalid.status).toBe(503);
    expect((await pending).error.message).toContain('terminal failure');
    expect(fixture.bridge.operationSnapshot()).toMatchObject({ failure: { code: 'PROTOCOL_ERROR' }, reports: [] });
    const unauthenticated = await fetch(fixture.bridge.reportUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthenticated.status).toBe(401);
  });

  it('retains only bounded telemetry rejection metadata without leaking rejected input', async () => {
    const invalidEvent = await create();
    await completeStartup(invalidEvent);
    const eventPayload = {
      v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'provider-invoked',
      evidence: {
        invocationId: 'private-invocation-id', sessionId: 'private-session-id', provider: 'edge', itemCount: 1, sourceIndexes: [99],
        privateSource: 'PRIVATE-SOURCE-DO-NOT-LEAK', authorization: 'AUTH-SECRET-DO-NOT-LEAK',
      },
    };
    expect((await post(invalidEvent, eventPayload)).status).toBe(503);
    const snapshot = invalidEvent.bridge.operationSnapshot();
    expect(snapshot).toMatchObject({
      failure: { code: 'PROTOCOL_ERROR' },
      lastRejection: {
        event: 'provider-invoked', opSeq: 1, reason: 'EVENT_INVALID', released: false, armed: false, stopped: false,
        sessionMatchesAdmitted: false, invocationKnown: false, attemptKnown: null,
        codeKnown: false, code: null, success: null, outcome: null,
      },
    });
    expect(snapshot.rejections.protocol).toBe(1);
    snapshot.lastRejection.event = 'mutated';
    expect(invalidEvent.bridge.operationSnapshot().lastRejection.event).toBe('provider-invoked');
    expect(JSON.stringify(invalidEvent.bridge.operationSnapshot())).not.toContain('private-invocation-id');
    expect(JSON.stringify(invalidEvent.bridge.operationSnapshot())).not.toContain('private-session-id');
    expect(JSON.stringify(invalidEvent.bridge.operationSnapshot())).not.toContain('PRIVATE-SOURCE-DO-NOT-LEAK');
    expect(JSON.stringify(invalidEvent.bridge.operationSnapshot())).not.toContain('AUTH-SECRET-DO-NOT-LEAK');
    expect(invalidEvent.bridge.snapshot()).toMatchObject({ failure: null, rejections: { protocol: 0 }, accepted: 5 });

    const invalidEnvelope = await create();
    await completeStartup(invalidEnvelope);
    expect((await post(invalidEnvelope, { ...eventPayload, v: 2 })).status).toBe(503);
    expect(invalidEnvelope.bridge.operationSnapshot().lastRejection).toMatchObject({
      event: 'provider-invoked', opSeq: 1, reason: 'ENVELOPE_INVALID',
    });
  });

  it('preserves early production failures and native-kernel rejection as operation diagnostics without requiring parser success', async () => {
    const early = await create();
    await completeStartup(early);
    expect(early.bridge.releaseProviderProbe()).toEqual({ decision: 'start' });
    const earlyArmed = { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: { sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: early.url, origin: null, documentId: 'doc-9' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true } };
    expect((await post(early, earlyArmed)).status).toBe(200);
    const earlyResult = { v: 1, runId, op: 'edge-fr-page-once', opSeq: 2, event: 'command-result', evidence: { success: false, sessionId: null, code: 'PROTOCOL_ERROR' } };
    expect((await post(early, earlyResult)).status).toBe(200);
    expect(early.bridge.operationSnapshot()).toMatchObject({ failure: null, reports: [earlyArmed, earlyResult] });

    const rejected = await create();
    await completeStartup(rejected);
    expect(rejected.bridge.releaseProviderProbe()).toEqual({ decision: 'start' });
    const attempt = { attemptId: 'attempt-rejected', invocationId: invocation.invocationId, sessionId: invocation.sessionId, messageId: invocation.messageId, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: 'c'.repeat(64), sourceIndexes: indices };
    const sequence = [
      ['armed', { sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: rejected.url, origin: null, documentId: 'doc-9' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true }],
      ['provider-invoked', invocation],
      ['physical-start', attempt],
      ['physical-settled', { attemptId: attempt.attemptId, sessionId: invocation.sessionId, outcome: 'rejected', status: null, code: 'NETWORK_ERROR' }],
      ['provider-settled', { invocationId: invocation.invocationId, sessionId: invocation.sessionId, outcome: 'rejected', code: 'PROTOCOL_ERROR' }],
      ['command-result', { success: false, sessionId: invocation.sessionId, code: 'PROTOCOL_ERROR' }],
    ];
    for (const [index, [event, evidence]] of sequence.entries()) {
      const result = await post(rejected, { v: 1, runId, op: 'edge-fr-page-once', opSeq: index + 1, event, evidence });
      expect(result.status).toBe(200);
      const receipt = await result.json();
      if (event === 'armed') expect(receipt.decision).toBe('start');
    }
    expect(rejected.bridge.operationSnapshot().failure).toBeNull();
    expect(rejected.bridge.operationSnapshot().reports.map(report => report.event)).toEqual([
      'armed', 'provider-invoked', 'physical-start', 'physical-settled', 'provider-settled', 'command-result',
    ]);
  });

  it('limits post-stop operation traffic to a pending physical settlement and validates fixed stop codes', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    const events = [
      ['armed', { sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true }],
      ['provider-invoked', invocation],
      ['physical-start', { attemptId: 'attempt-1', invocationId: 'invocation-1', sessionId: 'session-1', messageId: 'message-1', provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 3, bodyHash: 'b'.repeat(64), sourceIndexes: indices }],
    ];
    expect(fixture.bridge.releaseProviderProbe()).toEqual({ decision: 'start' });
    for (const [index, [event, opEvidence]] of events.entries()) {
      expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: index + 1, event, evidence: opEvidence })).status).toBe(200);
    }
    expect(() => fixture.bridge.stopProviderProbe('bogus')).toThrow('Unknown provider operation stop code');
    expect(fixture.bridge.stopProviderProbe('TIMEOUT')).toBe(true);
    expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 4, event: 'physical-settled', evidence: { attemptId: 'attempt-1', sessionId: 'session-1', outcome: 'fulfilled', status: 200, code: null } })).status).toBe(200);
    expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 5, event: 'provider-settled', evidence: { invocationId: 'invocation-1', sessionId: 'session-1', outcome: 'rejected', code: 'PROTOCOL_ERROR' } })).status).toBe(200);
    expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 6, event: 'command-result', evidence: { success: false, sessionId: 'session-1', code: 'PROTOCOL_ERROR' } })).status).toBe(200);
    expect((await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 7, event: 'physical-start', evidence: { ...events[2][1], attemptId: 'attempt-2' } })).status).toBe(503);
    expect(fixture.bridge.operationSnapshot().reports).toHaveLength(6);
    expect(fixture.bridge.operationSnapshot().rejections.protocol).toBe(1);
    expect(fixture.bridge.snapshot().rejections.protocol).toBe(0);
  });

  it('accepts exactly one released-and-armed post-stop early command failure without provider invocation', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
    const armed = post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: {
      sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true,
    } });
    await fixture.bridge.waitForOperation('armed');
    expect((await armed).status).toBe(200);
    expect(fixture.bridge.stopProviderProbe('TIMEOUT')).toBe(true);
    const failed = { v: 1, runId, op: 'edge-fr-page-once', opSeq: 2, event: 'command-result', evidence: { success: false, sessionId: null, code: 'PROTOCOL_ERROR' } };
    expect((await post(fixture, failed)).status).toBe(200);
    expect(fixture.bridge.operationSnapshot()).toMatchObject({ failure: null, stopped: true, rejections: { protocol: 0 } });
    expect(fixture.bridge.snapshot().rejections.protocol).toBe(0);
    expect((await post(fixture, { ...failed, opSeq: 3 })).status).toBe(503);
    expect(fixture.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });

    const unarmed = await create();
    await completeStartup(unarmed);
    unarmed.bridge.releaseProviderProbe();
    expect((await post(unarmed, { ...failed, runId, opSeq: 1 })).status).toBe(503);
    expect(unarmed.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });

    const successClaim = await create();
    await completeStartup(successClaim);
    successClaim.bridge.releaseProviderProbe();
    const successArmed = post(successClaim, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: {
      sender: { ...sender, url: successClaim.url }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true,
    } });
    await successClaim.bridge.waitForOperation('armed');
    await successArmed;
    successClaim.bridge.stopProviderProbe('TIMEOUT');
    expect((await post(successClaim, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 2, event: 'command-result', evidence: { success: true, sessionId: null, code: null } })).status).toBe(503);
    expect(successClaim.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });
  });

  it('emits payload-free server notifications when provider operation state changes', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    const events = [];
    const listener = (...args) => events.push(args);
    fixture.server.on('runtime-provider-operation', listener);
    try {
      fixture.bridge.releaseProviderProbe();
      const sender = { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' };
      const armed = post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: {
        sender, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true,
      } });
      await fixture.bridge.waitForOperation('armed');
      expect((await armed).status).toBe(200);
      expect(fixture.bridge.stopProviderProbe('TIMEOUT')).toBe(true);
      fixture.bridge.closeAdmission();
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every(args => args.length === 0)).toBe(true);
    } finally {
      fixture.server.removeListener('runtime-provider-operation', listener);
    }
  });

  it('accepts successful disjoint logical subsets only when they cover the fixed fixture exactly once', async () => {
    const fixture = await create();
    await completeStartup(fixture);
    fixture.bridge.releaseProviderProbe();
    let seq = 0;
    const report = async (event, evidence) => {
      const response = await post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++seq, event, evidence });
      expect(response.status, `${event}: ${JSON.stringify(fixture.bridge.operationSnapshot())}`).toBe(200);
      return response;
    };
    await report('armed', { sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true });
    for (const [batch, sourceIndexes] of [[0, [0, 1, 2, 3, 4, 5]], [1, [6, 7, 8, 9, 10, 11]]]) {
      const invocationId = `subset-${batch}`;
      const attemptId = `subset-attempt-${batch}`;
      const sessionId = 'session-subsets';
      const messageId = 'message-subsets';
      await report('provider-invoked', { invocationId, sessionId, messageId, provider: 'edge', itemCount: 6, sourceIndexes });
      await report('physical-start', { attemptId, invocationId, sessionId, messageId, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: `${batch ? 'd' : 'c'}`.repeat(64), sourceIndexes });
      await report('physical-settled', { attemptId, sessionId, outcome: 'fulfilled', status: 200, code: null });
      await report('parser-success', { invocationId, sessionId, sourceIndexes, resultsMatch: true });
      await report('provider-settled', { invocationId, sessionId, outcome: 'fulfilled', code: null });
    }
    await report('command-result', { success: true, sessionId: 'session-subsets', code: null });
    expect(fixture.bridge.operationSnapshot()).toMatchObject({ failure: null });
    expect(fixture.bridge.operationSnapshot().reports.filter(item => item.event === 'parser-success')).toHaveLength(2);
  });

  it('rejects unknown or duplicate subsets, cross-session attempts, unknown settlements, and incomplete success', async () => {
    for (const invalid of ['unknown-index', 'duplicate-index', 'wrong-session', 'wrong-attempt', 'incomplete']) {
      const fixture = await create();
      await completeStartup(fixture);
      fixture.bridge.releaseProviderProbe();
      let seq = 0;
      const send = async (event, evidence) => post(fixture, { v: 1, runId, op: 'edge-fr-page-once', opSeq: ++seq, event, evidence });
      expect((await send('armed', { sender: { id: expectedExtensionId, tabId: 9, frameId: 0, url: fixture.url, origin: null, documentId: 'doc-9' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true })).status).toBe(200);
      const indexes = invalid === 'unknown-index' ? [0, 1, 2, 3, 4, 12] : invalid === 'duplicate-index' ? [0, 1, 2, 3, 4, 4] : [0, 1, 2, 3, 4, 5];
      const invocationId = 'invalid-invocation';
      const sessionId = 'invalid-session';
      const invoke = await send('provider-invoked', { invocationId, sessionId, messageId: null, provider: 'edge', itemCount: indexes.length, sourceIndexes: indexes });
      if (invalid === 'unknown-index' || invalid === 'duplicate-index') {
        expect(invoke.status).toBe(503);
        expect(fixture.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });
        continue;
      }
      expect(invoke.status).toBe(200);
      const attemptId = 'valid-attempt';
      const physical = { attemptId, invocationId, sessionId: invalid === 'wrong-session' ? 'other-session' : sessionId, messageId: null, provider: 'edge', method: 'POST', url: edgeUrl, bodyBytes: 128, bodyHash: 'e'.repeat(64), sourceIndexes: indexes };
      if (invalid === 'wrong-session') {
        expect((await send('physical-start', physical)).status).toBe(503);
      } else {
        expect((await send('physical-start', physical)).status).toBe(200);
        if (invalid === 'wrong-attempt') {
          expect((await send('physical-settled', { attemptId: 'unknown-attempt', sessionId, outcome: 'fulfilled', status: 200, code: null })).status).toBe(503);
        } else {
          expect((await send('command-result', { success: true, sessionId, code: null })).status).toBe(200);
          expect((await send('translated', {
            sessionId, acceptedTargetIds: indices.map(index => `target-${index}`), acceptedCount: 12,
            duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true,
          })).status).toBe(503);
        }
      }
      expect(fixture.bridge.operationSnapshot().failure).toEqual({ code: 'PROTOCOL_ERROR' });
    }
  });
});

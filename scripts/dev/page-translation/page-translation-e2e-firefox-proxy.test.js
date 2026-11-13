import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEdgeLoopbackCertificates, edgeProxyFirefoxPrefs, importEdgeLoopbackCa, startEdgeLoopbackProxy, validateEdgeProxyRequest } from './e2e-firefox/loopback-edge-proxy.mjs';

const fixtureTexts = Array.from({ length: 12 }, (_, i) => `Benchmark sentence ${i + 1} has stable fixture content.`);
const request = (overrides = {}) => ({
  method: 'POST', url: '/translate/translatetext?isEnterpriseClient=false&from=en&to=fr',
  headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(fixtureTexts)), fixtureTexts, ...overrides,
});
const batchJson = texts => JSON.stringify(texts);
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function responseText(socket) {
  return new Promise(resolveResponse => {
    let response = '';
    socket.on('data', chunk => { response += chunk.toString('latin1'); });
    socket.once('end', () => resolveResponse(response));
    socket.once('close', () => resolveResponse(response));
  });
}
function sendBatch(socket, texts, { url = '/translate/translatetext?isEnterpriseClient=false&from=en&to=fr', host = 'edge.microsoft.com' } = {}) {
  const body = batchJson(texts);
  const response = responseText(socket);
  socket.write(`POST ${url} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  return response;
}
async function openTunnel(port, caCert, hostHeader = 'edge.microsoft.com:443') {
  const raw = tcpConnect(port, '127.0.0.1');
  const connectResponse = await new Promise((resolveConnect, reject) => {
    raw.once('error', reject);
    raw.once('connect', () => { raw.write(`CONNECT edge.microsoft.com:443 HTTP/1.1\r\nHost: ${hostHeader}\r\n\r\n`); raw.once('data', data => resolveConnect(data.toString('latin1'))); });
  });
  if (!connectResponse.startsWith('HTTP/1.1 200 Connection Established')) throw new Error('Expected the strict allowed Edge CONNECT to be accepted.');
  const secure = tlsConnect({ socket: raw, servername: 'edge.microsoft.com', ca: await readFile(caCert), rejectUnauthorized: true });
  await new Promise((resolveSecure, reject) => { secure.once('secureConnect', resolveSecure); secure.once('error', reject); });
  return secure;
}

describe('loopback Edge TLS proxy guards', () => {
  it('generates a verifiable edge.microsoft.com certificate and keeps proxy prefs profile-scoped', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-cert-'));
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      const profile = resolve(root, 'profile'); await mkdir(profile);
      const imported = await importEdgeLoopbackCa(profile, cert.caCert);
      expect(cert.verification).toContain('OK');
      expect(imported).toMatchObject({ trust: 'C,,' });
      expect(imported.listing).toContain('Translate-It E2E Loopback CA');
      expect(await readFile(cert.leafCert, 'utf8')).toContain('BEGIN CERTIFICATE');
      expect(edgeProxyFirefoxPrefs(44321)).toContain('network.proxy.allow_hijacking_localhost", false');
      expect(edgeProxyFirefoxPrefs(44321)).toContain('network.proxy.ssl_port", 44321');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits only the exact single fixture request and rejects malformed, oversized, repeated, and non-Edge requests', () => {
    expect(validateEdgeProxyRequest(request()).ok).toBe(true);
    for (const bad of [
      request({ method: 'GET' }),
      request({ url: '/other?to=fr&isEnterpriseClient=false' }),
      request({ url: '/translate/translatetext?to=fr&to=fr&isEnterpriseClient=false' }),
      request({ headers: { host: 'other.example', 'content-type': 'application/json' } }),
      request({ headers: { host: 'edge.microsoft.com', 'content-type': 'text/plain' } }),
      request({ body: Buffer.alloc(65537) }),
      request({ body: Buffer.from('{') }),
      request({ seen: true }),
      request({ body: Buffer.from(JSON.stringify([...fixtureTexts].reverse())) }),
    ]) expect(validateEdgeProxyRequest(bad).ok).toBe(false);
  });

  it('binds proxy routing to literal loopback listeners and never resolves or connects to the Edge host', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-bind-'));
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      await expect(startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({}), host: '0.0.0.0' }))
        .rejects.toThrow(/Invalid loopback Edge proxy configuration/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an unexpected CONNECT without success and closes a held valid TLS request during teardown', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-held-'));
    let proxy; let socket;
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({ translations: [] }) });
      const connectResponse = await new Promise((resolveConnect, reject) => {
        socket = tcpConnect(proxy.port, '127.0.0.1', () => socket.write('CONNECT other.example:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n'));
        socket.once('error', reject);
        socket.once('data', data => resolveConnect(data.toString('latin1')));
      });
      expect(connectResponse).toMatch(/^HTTP\/1\.1 403/);
      expect(connectResponse).not.toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.deniedRequests[0]).toMatchObject({ requestLine: 'CONNECT other.example:443 HTTP/1.1', authority: 'other.example:443', host: 'other.example:443' });
      socket.destroy();

      const extraTarget = tcpConnect(proxy.port, '127.0.0.1');
      const extraResponse = await new Promise((resolveResponse, reject) => {
        extraTarget.once('error', reject);
        extraTarget.once('connect', () => { extraTarget.write('CONNECT edge.microsoft.com:444 HTTP/1.1\r\nHost: edge.microsoft.com:444\r\n\r\n'); extraTarget.once('data', data => resolveResponse(data.toString('latin1'))); });
      });
      expect(extraResponse).toMatch(/^HTTP\/1\.1 403/);
      extraTarget.destroy();

      const invalid = await openTunnel(proxy.port, cert.caCert);
      const deniedHttp = new Promise(resolveResponse => {
        let response = '';
        invalid.on('data', chunk => { response += chunk.toString('latin1'); });
        invalid.on('end', () => resolveResponse(response));
        invalid.on('close', () => resolveResponse(response));
      });
      invalid.write('POST /unrelated HTTP/1.1\r\nHost: edge.microsoft.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]');
      const deniedResponse = await deniedHttp;
      expect(deniedResponse, JSON.stringify(proxy.deniedRequests)).toMatch(/^HTTP\/1\.1 400/);
      expect(deniedResponse).not.toMatch(/^HTTP\/1\.1 200/);

      const secure = await openTunnel(proxy.port, cert.caCert, 'edge.microsoft.com');
      secure.write(`POST /translate/translatetext?isEnterpriseClient=false&from=en&to=fr HTTP/1.1\r\nHost: edge.microsoft.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON.stringify(fixtureTexts))}\r\nConnection: close\r\n\r\n${JSON.stringify(fixtureTexts)}`);
      const held = await proxy.pending;
      expect(held.request.sni).toBe('edge.microsoft.com');
      expect(held.request.bodyHash).toMatch(/^[a-f\d]{64}$/);
      let heldResponse = '';
      secure.on('data', chunk => { heldResponse += chunk.toString('latin1'); });
      const closed = new Promise(resolveClose => secure.once('close', resolveClose));
      await proxy.close();
      await closed;
      expect(heldResponse).not.toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.deniedRequests).toContainEqual(expect.objectContaining({ stage: 'http', reason: 'url-not-allowed', status: 400 }));
      expect(await proxy.drain()).toBe(true);
    } finally {
      socket?.destroy();
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('claims concurrent subset requests independently, correlates hashes/indexes, and releases out of order', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-ledger-'));
    let proxy; const clients = [];
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: texts => ({ translations: texts }) });
      const firstIndexes = [0, 2]; const secondIndexes = [5, 7, 10];
      const firstTexts = firstIndexes.map(index => fixtureTexts[index]);
      const secondTexts = secondIndexes.map(index => fixtureTexts[index]);
      const firstWaiter = proxy.waitForRequest({ match: item => JSON.stringify(item.sourceIndexes) === JSON.stringify(firstIndexes), timeoutMs: 5000 });
      const secondWaiter = proxy.waitForRequest({ match: item => JSON.stringify(item.sourceIndexes) === JSON.stringify(secondIndexes), timeoutMs: 5000 });
      const firstClient = await openTunnel(proxy.port, cert.caCert); clients.push(firstClient);
      const firstResponse = sendBatch(firstClient, firstTexts);
      const secondClient = await openTunnel(proxy.port, cert.caCert); clients.push(secondClient);
      const secondResponse = sendBatch(secondClient, secondTexts);
      const [first, second] = await Promise.all([firstWaiter, secondWaiter]);

      expect(first).toMatchObject({ requestId: expect.stringMatching(/^edge-request-/), method: 'POST', sourceIndexes: firstIndexes,
        bodyBytes: Buffer.byteLength(batchJson(firstTexts)), bodyHash: createHashForTest(firstTexts), sni: 'edge.microsoft.com', host: 'edge.microsoft.com' });
      expect(second).toMatchObject({ requestId: expect.stringMatching(/^edge-request-/), method: 'POST', sourceIndexes: secondIndexes,
        bodyBytes: Buffer.byteLength(batchJson(secondTexts)), bodyHash: createHashForTest(secondTexts) });
      expect(first.body).toBeUndefined();
      expect(JSON.stringify(proxy.requests)).not.toContain(firstTexts[0]);
      expect(JSON.stringify(proxy.requests)).not.toContain(secondTexts[0]);

      await second.release(JSON.stringify({ accepted: 'second' }));
      expect(await secondResponse).toMatch(/^HTTP\/1\.1 200/);
      await first.release(JSON.stringify({ accepted: 'first' }));
      expect(await firstResponse).toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.requests.map(item => item.sourceIndexes)).toEqual([firstIndexes, secondIndexes]);
      await proxy.close();
      expect(await proxy.drain()).toBe(true);
    } finally {
      clients.forEach(client => client.destroy());
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown, duplicate, overlapping, pending-hold overflow, and request-count overflow', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-limits-'));
    let proxy; const clients = [];
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({ ok: true }) });
      const badClient = await openTunnel(proxy.port, cert.caCert); clients.push(badClient);
      expect(await sendBatch(badClient, ['unknown source'])).toMatch(/^HTTP\/1\.1 400/);
      const duplicateClient = await openTunnel(proxy.port, cert.caCert); clients.push(duplicateClient);
      expect(await sendBatch(duplicateClient, [fixtureTexts[0], fixtureTexts[0]])).toMatch(/^HTTP\/1\.1 400/);

      const firstClient = await openTunnel(proxy.port, cert.caCert); clients.push(firstClient);
      const firstPending = proxy.waitForRequest({ match: item => item.sourceIndexes.includes(0), timeoutMs: 5000 });
      const firstResponse = sendBatch(firstClient, [fixtureTexts[0], fixtureTexts[1]]);
      const first = await firstPending;
      const overlapClient = await openTunnel(proxy.port, cert.caCert); clients.push(overlapClient);
      expect(await sendBatch(overlapClient, [fixtureTexts[1], fixtureTexts[2]])).toMatch(/^HTTP\/1\.1 409/);
      expect(proxy.deniedRequests).toContainEqual(expect.objectContaining({ reason: 'overlapping-source', status: 409 }));
      first.reject(); expect(await firstResponse).toMatch(/^HTTP\/1\.1 502/);
      await proxy.close();
      expect(await proxy.drain()).toBe(true);
    } finally {
      clients.forEach(client => client.destroy());
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }

    const limitedRoot = await mkdtemp(resolve(tmpdir(), 'edge-loopback-pending-limit-'));
    let limited; const limitedClients = [];
    try {
      const cert = await createEdgeLoopbackCertificates(limitedRoot);
      limited = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({ ok: true }) });
      const batches = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]];
      const waiters = batches.map(indexes => limited.waitForRequest({ match: item => JSON.stringify(item.sourceIndexes) === JSON.stringify(indexes), timeoutMs: 5000 }));
      for (const indexes of batches) {
        const client = await openTunnel(limited.port, cert.caCert); limitedClients.push(client);
        sendBatch(client, indexes.map(index => fixtureTexts[index]));
      }
      await Promise.all(waiters);
      const overflow = await openTunnel(limited.port, cert.caCert); limitedClients.push(overflow);
      expect(await sendBatch(overflow, [fixtureTexts[0]])).toMatch(/^HTTP\/1\.1 429/);
      expect(limited.deniedRequests).toContainEqual(expect.objectContaining({ reason: 'pending-hold-limit', status: 429 }));
      await limited.close();
      expect(await limited.drain()).toBe(true);
    } finally {
      limitedClients.forEach(client => client.destroy());
      await limited?.close();
      await rm(limitedRoot, { recursive: true, force: true });
    }

    const requestLimitRoot = await mkdtemp(resolve(tmpdir(), 'edge-loopback-request-limit-'));
    let requestLimited; const requestClients = [];
    try {
      const cert = await createEdgeLoopbackCertificates(requestLimitRoot);
      requestLimited = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({ ok: true }) });
      const firstClient = await openTunnel(requestLimited.port, cert.caCert); requestClients.push(firstClient);
      const firstResponse = sendBatch(firstClient, [fixtureTexts[0]]);
      const first = await requestLimited.pending;
      first.reject(); await firstResponse;
      for (let i = 1; i < 13; i++) {
        const client = await openTunnel(requestLimited.port, cert.caCert); requestClients.push(client);
        const response = await sendBatch(client, [fixtureTexts[0]]);
        if (i === 12) expect(response).toMatch(/^HTTP\/1\.1 429/);
      }
      expect(requestLimited.deniedRequests).toContainEqual(expect.objectContaining({ reason: 'request-limit', status: 429 }));
      await requestLimited.close();
      expect(await requestLimited.drain()).toBe(true);
    } finally {
      requestClients.forEach(client => client.destroy());
      await requestLimited?.close();
      await rm(requestLimitRoot, { recursive: true, force: true });
    }
  });

  it('bounds request wait and hold timeouts and observes client aborts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-timeouts-'));
    let proxy; let client;
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: () => ({ ok: true }), holdTimeoutMs: 30 });
      await expect(proxy.waitForRequest({ match: () => true, timeoutMs: 10 })).rejects.toThrow(/Timed out waiting/);
      client = await openTunnel(proxy.port, cert.caCert);
      const response = sendBatch(client, [fixtureTexts[0]]);
      await proxy.pending;
      expect(await response).toMatch(/^HTTP\/1\.1 504/);
      expect(proxy.requests[0]).toMatchObject({ status: 'timeout', responseStatus: 504, reason: 'hold-timeout' });

      const abortClient = await openTunnel(proxy.port, cert.caCert); client = abortClient;
      const pending = proxy.waitForRequest({ match: item => item.sourceIndexes[0] === 1, timeoutMs: 1000 });
      sendBatch(abortClient, [fixtureTexts[1]]);
      const aborted = await pending;
      const abortedStatus = proxy.waitForStatus(aborted.requestId, 'aborted', { timeoutMs: 1000 });
      abortClient.destroy();
      await new Promise(resolveClose => abortClient.once('close', resolveClose));
      expect(await abortedStatus).toMatchObject({ status: 'aborted', reason: 'client-aborted' });
      await proxy.close();
      expect(await proxy.drain()).toBe(true);
      await expect(aborted.release('{}')).rejects.toThrow(/no longer releasable/);
    } finally {
      client?.destroy();
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the one-shot pending API and closes all concurrent holds on teardown', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-close-'));
    let proxy; const clients = [];
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, responseFor: texts => ({ count: texts.length }) });
      const first = await openTunnel(proxy.port, cert.caCert); clients.push(first);
      const firstResponse = sendBatch(first, [fixtureTexts[11]]);
      const legacy = await proxy.pending;
      expect(legacy.request).toBe(proxy.request);
      expect(legacy.request.requestId).toBe('edge-request-1');
      expect(await legacy.release(JSON.stringify({ ok: true }))).toBe(true);
      expect(await firstResponse).toMatch(/^HTTP\/1\.1 200/);

      const a = await openTunnel(proxy.port, cert.caCert); clients.push(a);
      const b = await openTunnel(proxy.port, cert.caCert); clients.push(b);
      const waitA = proxy.waitForRequest({ match: item => item.sourceIndexes[0] === 0, timeoutMs: 5000 });
      const waitB = proxy.waitForRequest({ match: item => item.sourceIndexes[0] === 1, timeoutMs: 5000 });
      const responseA = sendBatch(a, [fixtureTexts[0]]);
      const responseB = sendBatch(b, [fixtureTexts[1]]);
      const [holdA, holdB] = await Promise.all([waitA, waitB]);
      const closedA = responseA.then(value => value);
      const closedB = responseB.then(value => value);
      await proxy.close();
      const closeResponses = await Promise.all([closedA, closedB]);
      expect(closeResponses.every(reply => /^HTTP\/1\.1 502/.test(reply)), JSON.stringify(closeResponses)).toBe(true);
      expect(await proxy.drain()).toBe(true);
      await expect(holdA.release('{}')).rejects.toThrow(/no longer releasable/);
      await expect(holdB.release('{}')).rejects.toThrow(/no longer releasable/);
      expect(proxy.requests.map(item => item.status)).toEqual(['released', 'rejected', 'rejected']);
    } finally {
      clients.forEach(client => client.destroy());
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not release HTTP 200 when the client aborts during asynchronous response generation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-release-abort-'));
    let proxy; let client;
    const responseStarted = deferred(); const generatedResponse = deferred();
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts,
        responseFor: () => { responseStarted.resolve(); return generatedResponse.promise; } });
      client = await openTunnel(proxy.port, cert.caCert);
      const clientResponse = sendBatch(client, [fixtureTexts[0]]);
      const hold = await proxy.pending;
      const release = hold.release();
      const releaseRejected = expect(release).rejects.toThrow(/no longer releasable/);
      await responseStarted.promise;
      const aborted = proxy.waitForStatus(hold.request.requestId, 'aborted', { timeoutMs: 2000 });
      client.destroy();
      await aborted;
      generatedResponse.resolve({ late: 'must not be sent' });
      await releaseRejected;
      const wire = await clientResponse;
      expect(wire).not.toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.requests[0]).toMatchObject({ status: 'aborted', reason: 'client-aborted' });
      expect(await proxy.drain()).toBe(true);
    } finally {
      client?.destroy();
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not release HTTP 200 when the hold timeout wins during response generation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-release-timeout-'));
    let proxy; let client;
    const responseStarted = deferred(); const generatedResponse = deferred();
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts, holdTimeoutMs: 200,
        responseFor: () => { responseStarted.resolve(); return generatedResponse.promise; } });
      client = await openTunnel(proxy.port, cert.caCert);
      const clientResponse = sendBatch(client, [fixtureTexts[1]]);
      const hold = await proxy.pending;
      const release = hold.release();
      const releaseRejected = expect(release).rejects.toThrow(/no longer releasable/);
      await responseStarted.promise;
      const timedOut = await proxy.waitForStatus(hold.request.requestId, 'timeout', { timeoutMs: 2000 });
      expect(timedOut.responseStatus).toBe(504);
      generatedResponse.resolve({ late: 'must not be sent' });
      await releaseRejected;
      const wire = await clientResponse;
      expect(wire).toMatch(/^HTTP\/1\.1 504/);
      expect(wire).not.toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.requests[0]).toMatchObject({ status: 'timeout', responseStatus: 504, reason: 'hold-timeout' });
      expect(await proxy.drain()).toBe(true);
    } finally {
      client?.destroy();
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not release HTTP 200 when close wins during asynchronous response generation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'edge-loopback-release-close-'));
    let proxy; let client;
    const responseStarted = deferred(); const generatedResponse = deferred();
    try {
      const cert = await createEdgeLoopbackCertificates(root);
      proxy = await startEdgeLoopbackProxy({ tlsCert: cert.leafCert, tlsKey: cert.leafKey, fixtureTexts,
        responseFor: () => { responseStarted.resolve(); return generatedResponse.promise; } });
      client = await openTunnel(proxy.port, cert.caCert);
      const clientResponse = sendBatch(client, [fixtureTexts[2]]);
      const hold = await proxy.pending;
      const release = hold.release();
      const releaseRejected = expect(release).rejects.toThrow(/no longer releasable/);
      await responseStarted.promise;
      await proxy.close();
      expect(proxy.requests[0]).toMatchObject({ status: 'rejected', responseStatus: 502, reason: 'proxy-closed' });
      generatedResponse.resolve({ late: 'must not be sent' });
      await releaseRejected;
      const wire = await clientResponse;
      expect(wire).toMatch(/^HTTP\/1\.1 502/);
      expect(wire).not.toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.requests[0]).toMatchObject({ status: 'rejected', responseStatus: 502, reason: 'proxy-closed' });
      expect(await proxy.drain()).toBe(true);
    } finally {
      client?.destroy();
      await proxy?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createHashForTest(texts) {
  return createHash('sha256').update(Buffer.from(batchJson(texts))).digest('hex');
}

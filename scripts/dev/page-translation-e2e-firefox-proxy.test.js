import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { createEdgeLoopbackCertificates, edgeProxyFirefoxPrefs, importEdgeLoopbackCa, startEdgeLoopbackProxy, validateEdgeProxyRequest } from './page-translation-e2e-firefox/loopback-edge-proxy.mjs';

const fixtureTexts = Array.from({ length: 12 }, (_, i) => `Benchmark sentence ${i + 1} has stable fixture content.`);
const request = (overrides = {}) => ({
  method: 'POST', url: '/translate/translatetext?isEnterpriseClient=false&from=en&to=fr',
  headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(fixtureTexts)), fixtureTexts, ...overrides,
});
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
});

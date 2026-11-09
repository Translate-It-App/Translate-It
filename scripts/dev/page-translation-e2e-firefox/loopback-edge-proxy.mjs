import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HOST = 'edge.microsoft.com';
const PATH = '/translate/translatetext';
const MAX_BODY = 65536;
const EXPECTED_QUERY = new Set(['from', 'to', 'isEnterpriseClient']);

function command(file, args, { input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${file} failed (${code}): ${stderr}`)));
    if (input !== undefined) { child.stdin.end(input); }
  });
}

export async function createEdgeLoopbackCertificates(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const caKey = resolve(root, 'edge-ca.key'); const caCert = resolve(root, 'edge-ca.pem');
  const leafKey = resolve(root, 'edge-leaf.key'); const leafCsr = resolve(root, 'edge-leaf.csr');
  const leafCert = resolve(root, 'edge-leaf.pem'); const ext = resolve(root, 'edge-leaf.ext');
  const serial = resolve(root, 'edge-ca.srl');
  const caExt = resolve(root, 'edge-ca.ext');
  await writeFile(caExt, 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n', { mode: 0o600 });
  await command('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-sha256', '-subj', '/CN=Translate-It E2E Loopback CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', caCert]);
  await command('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${HOST}`, '-keyout', leafKey, '-out', leafCsr]);
  await writeFile(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:edge.microsoft.com\n', { mode: 0o600 });
  await command('/usr/bin/openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-sha256', '-extfile', ext, '-out', leafCert]);
  const verification = await command('/usr/bin/openssl', ['verify', '-CAfile', caCert, '-purpose', 'sslserver', '-verify_hostname', HOST, leafCert]);
  if (!verification.includes('OK')) throw new Error('OpenSSL did not verify the loopback leaf chain and hostname.');
  const caDetails = await command('/usr/bin/openssl', ['x509', '-in', caCert, '-noout', '-text']);
  const leafDetails = await command('/usr/bin/openssl', ['x509', '-in', leafCert, '-noout', '-text']);
  if (!/CA:TRUE/.test(caDetails) || !/Certificate Sign/.test(caDetails) || !/CA:FALSE/.test(leafDetails)
      || !/DNS:edge\.microsoft\.com/.test(leafDetails) || !/TLS Web Server Authentication/.test(leafDetails)) {
    throw new Error('Generated CA/leaf constraints, SAN, or serverAuth purpose were not verified.');
  }
  return { caCert, caKey, leafCert, leafKey, verification: verification.trim(), caConstraints: 'critical CA:TRUE; keyCertSign', leafConstraints: 'critical CA:FALSE; SAN=edge.microsoft.com; serverAuth' };
}

export async function importEdgeLoopbackCa(profile, caCert) {
  await command('/usr/bin/certutil', ['-N', '-d', `sql:${profile}`, '--empty-password']);
  await command('/usr/bin/certutil', ['-A', '-d', `sql:${profile}`, '-n', 'Translate-It E2E Loopback CA', '-t', 'C,,', '-i', caCert]);
  const listing = await command('/usr/bin/certutil', ['-L', '-d', `sql:${profile}`]);
  if (!listing.includes('Translate-It E2E Loopback CA') || !listing.includes('C,,')) throw new Error('Ephemeral profile NSS database did not retain the scoped CA trust.');
  return { listing: listing.trim(), trust: 'C,,', profile };
}

export function edgeProxyFirefoxPrefs(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid loopback proxy port.');
  return [
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    `user_pref("network.proxy.ssl_port", ${port});`,
    'user_pref("network.proxy.no_proxies_on", "127.0.0.1, localhost, ::1");',
    'user_pref("network.proxy.allow_hijacking_localhost", false);',
  ].join('\n') + '\n';
}

export function validateEdgeProxyRequest({ method, url, headers, body, fixtureTexts, seen = false }) {
  if (seen) return { ok: false, reason: 'repeated-request' };
  let parsed;
  try { parsed = new URL(url, `https://${HOST}`); } catch { return { ok: false, reason: 'invalid-url' }; }
  const keys = [...parsed.searchParams.keys()];
  if (parsed.hostname !== HOST || parsed.port || parsed.pathname !== PATH || parsed.hash || parsed.username || parsed.password
      || keys.some(key => !EXPECTED_QUERY.has(key)) || new Set(keys).size !== keys.length
      || parsed.searchParams.get('isEnterpriseClient') !== 'false' || parsed.searchParams.get('to') !== 'fr'
      || (parsed.searchParams.has('from') && (!parsed.searchParams.get('from') || parsed.searchParams.get('from').length > 32))) return { ok: false, reason: 'url-not-allowed' };
  if (method !== 'POST' || headers.host !== HOST
      || !/^application\/json(?:\s*;|\s*$)/i.test(String(headers['content-type'] ?? ''))) return { ok: false, reason: 'headers-not-allowed' };
  if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_BODY) return { ok: false, reason: 'body-size' };
  let texts;
  try { texts = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { ok: false, reason: 'invalid-json' }; }
  if (!Array.isArray(texts) || texts.length !== fixtureTexts.length || texts.some((value, i) => typeof value !== 'string' || !value.trim() || value !== fixtureTexts[i])
      || new Set(texts).size !== texts.length) return { ok: false, reason: 'body-mismatch' };
  return { ok: true, bodyBytes: body.length, bodyHash: createHash('sha256').update(body).digest('hex'), sourceIndexes: texts.map((_, index) => index) };
}

export async function startEdgeLoopbackProxy({ tlsCert, tlsKey, fixtureTexts, responseFor, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1' || !Array.isArray(fixtureTexts) || fixtureTexts.length !== 12 || typeof responseFor !== 'function') throw new TypeError('Invalid loopback Edge proxy configuration.');
  let accepted = null; let held = null; let resolvePending; let rejectPending; let closed = false;
  const sockets = new Set();
  const deniedRequests = [];
  const pending = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
  pending.catch(() => {});
  const https = await import('node:https');
  const tlsListener = https.createServer({ key: await readFile(tlsKey), cert: await readFile(tlsCert), minVersion: 'TLSv1.2' }, (req, res) => {
    const chunks = []; let bytes = 0; let rejected = false;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BODY) { rejected = true; res.writeHead(413).end(); req.destroy(); } else chunks.push(chunk); });
    req.on('end', async () => {
      if (rejected || closed) return;
      const body = Buffer.concat(chunks);
      const validation = validateEdgeProxyRequest({ method: req.method, url: req.url, headers: req.headers, body, fixtureTexts, seen: accepted !== null });
      if (!validation.ok) { deniedRequests.push({ stage: 'http', reason: validation.reason, status: 400 }); res.writeHead(400).end(); return; }
      const request = { ...validation, method: req.method, url: req.url, sni: req.socket.servername, host: req.headers.host };
      if (request.sni !== HOST) { deniedRequests.push({ stage: 'sni', reason: 'sni-not-allowed', status: 400 }); res.writeHead(400).end(); return; }
      accepted = request;
      held = { socket: req.socket, response: res };
      resolvePending({ request, release: async body => {
        if (closed || res.destroyed || res.headersSent) throw new Error('Pending proxy request is no longer releasable.');
        const responseBody = body === undefined ? JSON.stringify(await responseFor(fixtureTexts)) : body;
        if (typeof responseBody !== 'string' || responseBody.length > MAX_BODY) throw new TypeError('Invalid bounded proxy response body.');
        const bytes = Buffer.from(responseBody);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, connection: 'close' });
        res.end(bytes);
      }, reject: () => { if (!res.headersSent && !res.destroyed) res.writeHead(502).end(); req.socket.destroy(); } });
    });
  });
  tlsListener.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  tlsListener.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { tlsListener.once('error', reject); tlsListener.listen(0, host, resolve); });
  const tlsPort = tlsListener.address().port;
  const proxy = createTcpServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let buffer = ''; let decided = false;
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    socket.on('data', data => {
      if (decided) return;
      buffer += data.toString('latin1');
      if (buffer.length > 8192) {
        decided = true; deniedRequests.push({ stage: 'connect', reason: 'header-limit', status: 400, requestLine: '[invalid]', authority: '[invalid]', host: '[invalid]' });
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
      }
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      decided = true; clearTimeout(timer);
      const lines = buffer.slice(0, end).split('\r\n');
      const match = /^CONNECT ([A-Za-z0-9.:_-]{1,255}) HTTP\/1\.1$/.exec(lines[0] ?? '');
      const authority = match?.[1] ?? null;
      const hosts = lines.slice(1).filter(value => /^host:/i.test(value)).map(value => value.slice(value.indexOf(':') + 1).trim());
      const hostHeader = hosts.length === 1 ? hosts[0] : null;
      if (lines[0] !== `CONNECT ${HOST}:443 HTTP/1.1` || hosts.length !== 1
          || ![`${HOST}:443`, HOST].includes(hostHeader) || buffer.length !== end + 4) {
        deniedRequests.push({ stage: 'connect', reason: 'authority-not-allowed', status: 403,
          requestLine: match ? lines[0] : '[invalid]', authority: authority ?? '[invalid]', host: hostHeader && /^[A-Za-z0-9.:_-]{1,255}$/.test(hostHeader) ? hostHeader : '[invalid]' });
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      void import('node:net').then(({ connect }) => {
        const tunnel = connect(tlsPort, host, () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
        socket.pipe(tunnel); tunnel.pipe(socket);
        const finish = () => { socket.destroy(); tunnel.destroy(); };
        socket.once('error', finish); tunnel.once('error', finish); socket.once('close', () => tunnel.destroy()); tunnel.once('close', () => socket.destroy());
      });
    });
    socket.once('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, host, resolve); });
  const close = async () => {
    if (closed) return;
    closed = true;
    const destroySockets = () => { for (const socket of sockets) socket.destroy(); };
    if (held && !held.response.headersSent && !held.response.destroyed) {
      const timer = setTimeout(destroySockets, 250); timer.unref();
      held.response.writeHead(502, { connection: 'close', 'content-length': 0 });
      held.response.end(() => { clearTimeout(timer); destroySockets(); });
    } else destroySockets();
    rejectPending(new Error('Loopback Edge proxy closed.'));
    for (const server of [proxy, tlsListener]) if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  return { port: proxy.address().port, tlsPort, pending, close, drain: async () => {
    if (held && !held.response.headersSent && !held.response.destroyed) {
      held.response.writeHead(502, { connection: 'close', 'content-length': 0 }); held.response.end(() => held.socket.destroy());
    }
    for (const socket of sockets) if (socket !== held?.socket) socket.destroy();
    await Promise.all([proxy, tlsListener].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    return sockets.size === 0;
  }, get request() { return accepted; }, get deniedRequests() { return [...deniedRequests]; } };
}

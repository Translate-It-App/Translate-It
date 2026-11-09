import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HOST = 'edge.microsoft.com';
const PATH = '/translate/translatetext';
const MAX_BODY = 65536;
const EXPECTED_QUERY = new Set(['from', 'to', 'isEnterpriseClient']);
const MAX_REQUESTS = 12;
const MAX_PENDING_HOLDS = 4;
const MAX_REQUEST_WAIT_MS = 15_000;
const HOLD_TIMEOUT_MS = 15_000;

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
  if (!Array.isArray(texts) || !texts.length || texts.length > fixtureTexts.length
      || texts.some(value => typeof value !== 'string' || !value.trim()) || new Set(texts).size !== texts.length) return { ok: false, reason: 'body-mismatch' };
  const sourceIndexes = texts.map(text => fixtureTexts.indexOf(text));
  if (sourceIndexes.some(index => index < 0) || sourceIndexes.some((index, position) => position > 0 && index <= sourceIndexes[position - 1])) return { ok: false, reason: 'body-mismatch' };
  return { ok: true, bodyBytes: body.length, bodyHash: createHash('sha256').update(body).digest('hex'), sourceIndexes };
}

export async function startEdgeLoopbackProxy({ tlsCert, tlsKey, fixtureTexts, responseFor, host = '127.0.0.1', holdTimeoutMs = HOLD_TIMEOUT_MS }) {
  if (host !== '127.0.0.1' || !Array.isArray(fixtureTexts) || fixtureTexts.length !== 12
      || fixtureTexts.some(text => typeof text !== 'string' || !text.trim()) || new Set(fixtureTexts).size !== fixtureTexts.length
      || typeof responseFor !== 'function' || !Number.isFinite(holdTimeoutMs) || holdTimeoutMs < 1 || holdTimeoutMs > HOLD_TIMEOUT_MS) throw new TypeError('Invalid loopback Edge proxy configuration.');
  let accepted = null; let resolvePending; let rejectPending; let closed = false; let closePromise = null;
  let requestNumber = 0; const acceptedIndexes = new Set();
  const sockets = new Set();
  const socketClosed = new WeakMap();
  const watchedSockets = new WeakSet();
  const abortWatchedSockets = new WeakSet();
  const trackSocket = socket => {
    sockets.add(socket);
    if (!watchedSockets.has(socket)) {
      watchedSockets.add(socket);
      socketClosed.set(socket, new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); })));
    }
  };
  const closeSockets = async () => {
    const active = [...sockets];
    const closedEvents = active.map(socket => socketClosed.get(socket));
    const secure = active.filter(socket => socket.encrypted === true);
    for (const socket of secure) if (!socket.destroyed) socket.end();
    let timer;
    await Promise.race([Promise.all(secure.map(socket => socketClosed.get(socket))), new Promise(resolve => { timer = setTimeout(resolve, 250); timer.unref(); })]);
    clearTimeout(timer);
    for (const socket of active) if (!socket.encrypted && !socket.destroyed) socket.end();
    await Promise.race([Promise.all(closedEvents), new Promise(resolve => { timer = setTimeout(resolve, 250); timer.unref(); })]);
    clearTimeout(timer);
    for (const socket of active) if (!socket.destroyed) socket.destroy();
    await Promise.all(closedEvents);
  };
  const deniedRequests = [];
  const records = [];
  const holds = new Map();
  const unclaimed = [];
  const waiters = [];
  const statusWaiters = [];
  const pending = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
  pending.catch(() => {});
  const snapshot = record => {
    const { requestId, method, url, sni, host: requestHost, bodyBytes, bodyHash, sourceIndexes, status, responseStatus, reason } = record;
    return { requestId, method, url, sni, host: requestHost, bodyBytes, bodyHash, sourceIndexes: [...sourceIndexes], status, responseStatus, ...(reason ? { reason } : {}) };
  };
  const expireWaiter = waiter => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
  };
  const notifyStatus = record => {
    for (const waiter of [...statusWaiters]) if (waiter.requestId === record.requestId && waiter.status === record.status) {
      clearTimeout(waiter.timer);
      statusWaiters.splice(statusWaiters.indexOf(waiter), 1);
      waiter.resolve(snapshot(record));
    }
  };
  const safeHandle = hold => ({
    release: async body => {
      const ownedAndWritable = () => !closed && hold.status === 'held' && holds.get(hold.record.requestId) === hold
        && !hold.response.destroyed && !hold.response.writableEnded && hold.response.writable
        && !hold.socket.destroyed && hold.socket.writable;
      if (!ownedAndWritable()) throw new Error('Loopback proxy request is no longer releasable.');
      const responseBody = body === undefined ? JSON.stringify(await responseFor(hold.record.sourceIndexes.map(index => fixtureTexts[index]))) : body;
      if (!ownedAndWritable()) throw new Error('Loopback proxy request is no longer releasable.');
      if (typeof responseBody !== 'string' || Buffer.byteLength(responseBody) > MAX_BODY) {
        settleHold(hold, 'rejected', 502, 'invalid-response-size');
        throw new TypeError('Invalid bounded proxy response body.');
      }
      if (!settleHold(hold, 'released', 200)) throw new Error('Loopback proxy request is no longer releasable.');
      hold.response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(responseBody), connection: 'close' });
      hold.response.end(responseBody);
      return true;
    },
    reject: () => settleHold(hold, 'rejected', 502, 'caller-rejected'),
  });
  const apiRequest = hold => ({ ...snapshot(hold.record), ...safeHandle(hold) });
  const claimHold = (hold, waiter) => {
    expireWaiter(waiter);
    hold.claimed = true;
    waiter.resolve(apiRequest(hold));
  };
  const settleHold = (hold, status, responseStatus = null, reason = null) => {
    if (!hold || hold.status !== 'held') return false;
    hold.status = status;
    hold.record.status = status;
    hold.record.responseStatus = responseStatus;
    if (reason) hold.record.reason = reason;
    notifyStatus(hold.record);
    clearTimeout(hold.timer);
    holds.delete(hold.record.requestId);
    const queuedIndex = unclaimed.indexOf(hold);
    if (queuedIndex >= 0) unclaimed.splice(queuedIndex, 1);
    if (status !== 'released' && !hold.response.destroyed && !hold.response.headersSent) {
      hold.response.writeHead(responseStatus ?? 502, { connection: 'close', 'content-length': 0 });
      const socket = hold.socket;
      hold.closeFlushed = new Promise(resolve => hold.response.end(resolve));
      hold.closeFlushed = hold.closeFlushed.then(() => { if (!socket.destroyed) socket.end(); });
    } else if (status !== 'released') hold.socket.destroy();
    return true;
  };
  const deny = (res, reason, status = 400) => {
    deniedRequests.push({ stage: 'http', reason, status });
    res.writeHead(status, { connection: 'close' }).end();
  };
  const dispatchWaiter = hold => {
    for (const waiter of [...waiters]) {
      let matches = false;
      try { matches = waiter.match(snapshot(hold.record)) === true; } catch { /* Leave the request available to another matcher. */ }
      if (matches) { claimHold(hold, waiter); return; }
    }
    unclaimed.push(hold);
  };
  const makeHold = (req, res, record) => {
    const hold = { record, response: res, socket: req.socket, status: 'held', claimed: false, timer: null };
    record.status = 'held';
    holds.set(record.requestId, hold);
    hold.timer = setTimeout(() => settleHold(hold, 'timeout', 504, 'hold-timeout'), holdTimeoutMs);
    hold.timer.unref();
    req.once('aborted', () => settleHold(hold, 'aborted', null, 'client-aborted'));
    if (!watchedSockets.has(req.socket)) trackSocket(req.socket);
    if (!abortWatchedSockets.has(req.socket)) {
      abortWatchedSockets.add(req.socket);
      req.socket.once('close', () => {
        for (const active of [...holds.values()]) if (active.socket === req.socket) settleHold(active, 'aborted', null, 'client-aborted');
      });
    }
    res.once('close', () => {
      if (res.writableFinished) return;
      if (hold.status === 'held') settleHold(hold, 'aborted', null, 'client-aborted');
      else if (hold.status === 'released') { hold.status = 'aborted'; record.status = 'aborted'; record.reason = 'client-aborted'; notifyStatus(record); }
    });
    return hold;
  };
  const https = await import('node:https');
  const tlsListener = https.createServer({ key: await readFile(tlsKey), cert: await readFile(tlsCert), minVersion: 'TLSv1.2' }, (req, res) => {
    requestNumber++;
    if (closed) { deny(res, 'proxy-closed', 503); req.resume(); return; }
    if (requestNumber > MAX_REQUESTS) { deny(res, 'request-limit', 429); req.resume(); return; }
    const chunks = []; let bytes = 0; let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY) { rejected = true; deny(res, 'body-size', 413); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      if (rejected || closed) return;
      const body = Buffer.concat(chunks);
      const validation = validateEdgeProxyRequest({ method: req.method, url: req.url, headers: req.headers, body, fixtureTexts });
      if (!validation.ok) { deny(res, validation.reason); return; }
      if (req.socket.servername !== HOST) { deny(res, 'sni-not-allowed'); return; }
      if (holds.size >= MAX_PENDING_HOLDS) { deny(res, 'pending-hold-limit', 429); return; }
      if ([...validation.sourceIndexes].some(index => acceptedIndexes.has(index))) { deny(res, 'overlapping-source', 409); return; }
      for (const index of validation.sourceIndexes) acceptedIndexes.add(index);
      const requestId = `edge-request-${requestNumber}`;
      const record = { requestId, method: req.method, url: req.url, sni: req.socket.servername, host: req.headers.host,
        bodyBytes: validation.bodyBytes, bodyHash: validation.bodyHash, sourceIndexes: validation.sourceIndexes, status: 'received', responseStatus: null };
      records.push(record);
      const hold = makeHold(req, res, record);
      if (!accepted) {
        accepted = snapshot(record);
        resolvePending({ request: accepted, ...safeHandle(hold) });
      }
      dispatchWaiter(hold);
    });
  });
  tlsListener.on('connection', trackSocket);
  tlsListener.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { tlsListener.once('error', reject); tlsListener.listen(0, host, resolve); });
  const tlsPort = tlsListener.address().port;
  const proxy = createTcpServer(socket => {
    trackSocket(socket);
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
  const waitForRequest = ({ match, timeoutMs = MAX_REQUEST_WAIT_MS } = {}) => {
    if (typeof match !== 'function') return Promise.reject(new TypeError('waitForRequest requires a match predicate.'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new TypeError('waitForRequest timeout must be positive and finite.'));
    const boundedTimeout = Math.min(timeoutMs, MAX_REQUEST_WAIT_MS);
    const existing = unclaimed.findIndex(hold => {
      try { return hold.status === 'held' && match(snapshot(hold.record)) === true; } catch { return false; }
    });
    if (existing >= 0) {
      const [hold] = unclaimed.splice(existing, 1);
      hold.claimed = true;
      return Promise.resolve(apiRequest(hold));
    }
    if (closed) return Promise.reject(new Error('Loopback Edge proxy is closed.'));
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { expireWaiter(waiter); reject(new Error('Timed out waiting for a loopback Edge request.')); }, boundedTimeout);
      waiter.timer.unref();
      waiters.push(waiter);
    });
  };
  const waitForStatus = (requestId, status, { timeoutMs = MAX_REQUEST_WAIT_MS } = {}) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new TypeError('Status wait timeout must be positive and finite.'));
    const record = records.find(item => item.requestId === requestId);
    if (record?.status === status) return Promise.resolve(snapshot(record));
    if (closed) return Promise.reject(new Error('Loopback Edge proxy is closed.'));
    return new Promise((resolve, reject) => {
      const waiter = { requestId, status, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { statusWaiters.splice(statusWaiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for proxy request ${status}.`)); }, Math.min(timeoutMs, MAX_REQUEST_WAIT_MS));
      waiter.timer.unref(); statusWaiters.push(waiter);
    });
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    rejectPending(new Error('Loopback Edge proxy closed.'));
    for (const waiter of [...waiters]) { expireWaiter(waiter); waiter.reject(new Error('Loopback Edge proxy closed.')); }
    for (const waiter of [...statusWaiters]) { clearTimeout(waiter.timer); statusWaiters.splice(statusWaiters.indexOf(waiter), 1); waiter.reject(new Error('Loopback Edge proxy closed.')); }
    const finishing = [...holds.values()].map(hold => {
      settleHold(hold, 'rejected', 502, 'proxy-closed');
      return hold.closeFlushed ?? Promise.resolve();
    });
    closePromise = (async () => {
      let timer;
      await Promise.race([Promise.all(finishing), new Promise(resolve => { timer = setTimeout(resolve, 300); timer.unref(); })]);
      clearTimeout(timer);
      const forcedClose = new Promise(resolve => { timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); resolve(); }, 300); timer.unref(); });
      await Promise.race([closeSockets(), forcedClose]);
      clearTimeout(timer);
      await Promise.all([proxy, tlsListener].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    })();
    return closePromise;
  };
  return {
    port: proxy.address().port, tlsPort, pending, waitForRequest, waitForStatus, close,
    drain: async () => { await close(); return sockets.size === 0 && holds.size === 0 && !proxy.listening && !tlsListener.listening; },
    get request() { return accepted; }, get requests() { return records.map(snapshot); }, get deniedRequests() { return [...deniedRequests]; },
  };
}

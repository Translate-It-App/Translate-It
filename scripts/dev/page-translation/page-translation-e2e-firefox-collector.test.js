import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { createFixture, startFixture } from './e2e-benchmark/fixture.mjs';

const open = [];
const config = { runId: 'collector-test', authToken: 'a'.repeat(64), expectedExtensionId: 'extension-id' };
async function fixture(bridge = config) { const value = await startFixture(createFixture(), bridge ? { runtimeBridge: bridge } : {}); open.push(value); return value; }
afterEach(async () => { await Promise.all(open.splice(0).map(async value => { value.bridge?.closeAdmission(); await new Promise(resolve => value.server.close(resolve)); })); });

async function post(value, report, options = {}) {
  const method = options.method ?? 'POST';
  return fetch(value.bridge.reportUrl, { method, headers: { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json', ...(options.origin === undefined ? {} : { origin: options.origin }) }, ...(method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(report) }), redirect: 'manual' });
}
function reports() {
  const sender = { id: config.expectedExtensionId, tabId: 4, frameId: 0, url: 'FIXTURE_URL', origin: null, documentId: 'document-1' };
  const bgChecks = Object.fromEntries(['lifecycleInitialized', 'translationEngineInitialized', 'enginePresent', 'unifiedEngineMatches', 'unifiedServiceMatches', 'messageListenerActive', 'startupComplete'].map(key => [key, true]));
  return [
    ['background', 'bootstrap', { extensionId: config.expectedExtensionId, extensionOrigin: 'moz-extension://01234567-89ab-cdef-0123-456789abcdef', tabId: 4 }],
    ['background', 'loaded', { entry: 'src/core/background/index.js' }],
    ['background', 'ready', { checks: bgChecks, hostPermission: true }],
    ['content', 'loaded', { entry: 'src/core/content-scripts/index-main.js', sender, navigationGeneration: 1 }],
    ['content', 'ready', { checks: { coreInitialized: true, listenerActive: true, featureManagerInitialized: true, handlerActive: true, handlerIsActive: true }, flags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }, sender, navigationGeneration: 1, ackReceived: true }],
  ];
}

describe('Firefox runtime collector', () => {
  it('accepts and snapshots the bounded ordered runtime handshake', async () => {
    const value = await fixture();
    expect((await fetch(value.bridge.bindingUrl)).status).toBe(200);
    for (const [index, [realm, phase, evidence]] of reports().entries()) {
      const report = { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence: JSON.parse(JSON.stringify(evidence, (_key, item) => item === 'FIXTURE_URL' ? value.url : item)) };
      const response = await post(value, report, { origin: 'moz-extension://01234567-89ab-cdef-0123-456789abcdef' });
      expect(response.status, `report index ${index}: ${JSON.stringify(value.bridge.snapshot())}`).toBe(200);
      expect(await response.json()).toEqual({ v: 1, runId: config.runId, seq: index + 1, accepted: true });
    }
    const waiters = await Promise.all([value.bridge.waitFor('content', 'ready'), value.bridge.waitFor('background', 'loaded')]);
    expect(waiters.map(report => report.phase)).toEqual(['ready', 'loaded']);
    expect(value.bridge.snapshot()).toMatchObject({ background: ['bootstrap', 'loaded', 'ready'], content: ['loaded', 'ready'], accepted: 5, failure: null, reports: expect.arrayContaining([expect.objectContaining({ runId: config.runId })]) });
  });

  it('rejects unauthenticated, wrong-origin, wrong-method, cross-run, and extra-field reports without state changes', async () => {
    const value = await fixture();
    const good = { v: 1, runId: config.runId, seq: 1, realm: 'background', phase: 'bootstrap', evidence: reports()[0][2] };
    expect((await fetch(value.bridge.reportUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) })).status).toBe(401);
    expect((await post(value, good, { origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await post(value, good, { method: 'GET' })).status).toBe(404);
    expect((await post(value, { ...good, runId: 'another-run' })).status).toBe(400);
    expect(value.bridge.snapshot().failure).toBeNull();
    expect((await post(value, { ...good, extra: true })).status).toBe(400);
    expect(value.bridge.snapshot()).toMatchObject({ accepted: 0, background: [], content: [], reports: [], failure: { code: 'PROTOCOL_REJECTED' }, rejections: { unauthorized: 1, originOrType: 1, route: 1, malformed: 0, protocol: 2, bodyLimit: 0 } });
  });

  it('latches an authenticated sequence/protocol failure and makes waiters fail', async () => {
    const value = await fixture();
    const first = { v: 1, runId: config.runId, seq: 2, realm: 'background', phase: 'bootstrap', evidence: reports()[0][2] };
    expect((await post(value, first)).status).toBe(400);
    await expect(value.bridge.waitFor('background', 'ready', { timeoutMs: 20 })).rejects.toThrow('terminal failure');
    expect(value.bridge.snapshot()).toMatchObject({ failure: { code: 'PROTOCOL_REJECTED' }, accepted: 0 });
  });

  it('bounds stage waiters without mutating state and rejects them immediately on close', async () => {
    const value = await fixture();
    await expect(value.bridge.waitFor('background', 'ready', { timeoutMs: 5 })).rejects.toThrow('Timed out');
    expect(value.bridge.snapshot()).toMatchObject({ accepted: 0, failure: null });
    const pending = value.bridge.waitFor('content', 'ready');
    value.bridge.closeAdmission();
    await expect(pending).rejects.toThrow('admission is closed');
  });

  it('returns independent report copies to every waiter and subsequent lookup', async () => {
    const value = await fixture();
    const report = { v: 1, runId: config.runId, seq: 1, realm: 'background', phase: 'bootstrap', evidence: reports()[0][2] };
    const first = value.bridge.waitFor('background', 'bootstrap');
    const second = value.bridge.waitFor('background', 'bootstrap');
    expect((await post(value, report)).status).toBe(200);
    const [one, two] = await Promise.all([first, second]);
    one.phase = 'ready'; one.evidence.extensionId = 'mutated';
    expect(two.phase).toBe('bootstrap');
    expect(two.evidence.extensionId).toBe(config.expectedExtensionId);
    const immediate = await value.bridge.waitFor('background', 'bootstrap');
    immediate.phase = 'ready'; immediate.evidence.extensionId = 'mutated-immediate';
    expect(await value.bridge.waitFor('background', 'bootstrap')).toEqual(report);
    expect(value.bridge.snapshot().reports[0]).toEqual(report);
    expect(two).toEqual(report);
    await expect(value.bridge.waitFor('background', 'ready', { timeoutMs: 5 })).rejects.toThrow('Timed out');
  });

  it('rejects replay, duplicate phases, malformed JSON, false readiness, and flag mismatches terminally', async () => {
    const value = await fixture();
    const bootstrap = { v: 1, runId: config.runId, seq: 1, realm: 'background', phase: 'bootstrap', evidence: reports()[0][2] };
    expect((await post(value, bootstrap)).status).toBe(200);
    expect((await post(value, { ...bootstrap, seq: 2 })).status).toBe(400);
    expect(value.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
    expect((await post(value, { ...bootstrap, seq: 3 })).status).toBe(503);

    const malformed = await fixture();
    expect((await post(malformed, null, { raw: '{' })).status).toBe(400);
    expect(malformed.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });

    const falseReady = await fixture();
    for (const [index, [realm, phase, evidence]] of reports().slice(0, 2).entries()) expect((await post(falseReady, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence })).status).toBe(200);
    const evidence = reports()[2][2]; evidence.checks.startupComplete = false;
    expect((await post(falseReady, { v: 1, runId: config.runId, seq: 3, realm: 'background', phase: 'ready', evidence })).status).toBe(400);
    expect(falseReady.bridge.snapshot().reports).toHaveLength(2);
    expect(falseReady.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
  });

  it('rejects combined-key schemas for background and content readiness', async () => {
    const value = await fixture();
    const setup = reports().slice(0, 2);
    for (const [index, [realm, phase, evidence]] of setup.entries()) expect((await post(value, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence })).status).toBe(200);
    const bg = reports()[2][2];
    const bgKeys = Object.keys(bg.checks).sort().join(',');
    bg.checks = { [bgKeys]: true };
    expect((await post(value, { v: 1, runId: config.runId, seq: 3, realm: 'background', phase: 'ready', evidence: bg })).status).toBe(400);
    expect(value.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });

    const content = await fixture();
    const setupReports = reports().slice(0, 4);
    for (const [index, [realm, phase, evidence]] of setupReports.entries()) {
      const normalized = JSON.parse(JSON.stringify(evidence, (_key, item) => item === 'FIXTURE_URL' ? content.url : item));
      expect((await post(content, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence: normalized })).status).toBe(200);
    }
    const ready = JSON.parse(JSON.stringify(reports()[4][2], (_key, item) => item === 'FIXTURE_URL' ? content.url : item));
    const contentKeys = Object.keys(ready.checks).sort().join(',');
    ready.checks = { [contentKeys]: true };
    expect((await post(content, { v: 1, runId: config.runId, seq: 5, realm: 'content', phase: 'ready', evidence: ready })).status).toBe(400);
    expect(content.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
  });

  it('accepts omitted Origin but rejects null/web/incorrect extension Origin without pinning or failing', async () => {
    const value = await fixture();
    const bootstrap = { v: 1, runId: config.runId, seq: 1, realm: 'background', phase: 'bootstrap', evidence: reports()[0][2] };
    for (const origin of ['null', 'https://example.invalid', 'moz-extension://ffffffff-ffff-ffff-ffff-ffffffffffff']) expect((await post(value, bootstrap, { origin })).status).toBe(403);
    expect(value.bridge.snapshot()).toMatchObject({ accepted: 0, failure: null });
    expect((await post(value, bootstrap, { origin: bootstrap.evidence.extensionOrigin })).status).toBe(200);
    expect(value.bridge.snapshot().failure).toBeNull();
  });

  it('accepts terminal startup errors and rejects an invalid content sender', async () => {
    const failed = await fixture();
    const error = { v: 1, runId: config.runId, seq: 1, realm: 'background', phase: 'error', evidence: { code: 'IMPORT_FAILED' } };
    expect((await post(failed, error)).status).toBe(200);
    expect(failed.bridge.snapshot()).toMatchObject({ failure: { code: 'IMPORT_FAILED' }, reports: [error] });

    const value = await fixture();
    const background = reports().slice(0, 3);
    for (const [index, [realm, phase, evidence]] of background.entries()) expect((await post(value, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence })).status).toBe(200);
    const badSender = { ...reports()[3][2], sender: { ...reports()[3][2].sender, tabId: 99 } };
    expect((await post(value, { v: 1, runId: config.runId, seq: 4, realm: 'content', phase: 'loaded', evidence: badSender })).status).toBe(400);
    expect(value.bridge.snapshot().failure).toEqual({ code: 'PROTOCOL_REJECTED' });
  });

  it('pins the complete content sender identity from loaded through ready', async () => {
    const value = await fixture();
    const setup = reports().slice(0, 4);
    for (const [index, [realm, phase, evidence]] of setup.entries()) {
      const normalized = JSON.parse(JSON.stringify(evidence, (_key, item) => item === 'FIXTURE_URL' ? value.url : item));
      expect((await post(value, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence: normalized })).status).toBe(200);
    }
    const ready = JSON.parse(JSON.stringify(reports()[4][2], (_key, item) => item === 'FIXTURE_URL' ? value.url : item));
    ready.sender.documentId = 'different-document';
    expect((await post(value, { v: 1, runId: config.runId, seq: 5, realm: 'content', phase: 'ready', evidence: ready })).status).toBe(400);
    expect(value.bridge.snapshot()).toMatchObject({ accepted: 4, failure: { code: 'PROTOCOL_REJECTED' } });
  });

  it.each([
    ['frame', sender => ({ ...sender, frameId: 1 })],
    ['origin', sender => ({ ...sender, origin: 'https://attacker.invalid' })],
    ['extra sender field', sender => ({ ...sender, unexpected: true })],
  ])('rejects content sender with invalid %s', async (_label, mutate) => {
    const value = await fixture();
    for (const [index, [realm, phase, evidence]] of reports().slice(0, 3).entries()) expect((await post(value, { v: 1, runId: config.runId, seq: index + 1, realm, phase, evidence })).status).toBe(200);
    const evidence = JSON.parse(JSON.stringify(reports()[3][2], (_key, item) => item === 'FIXTURE_URL' ? value.url : item));
    evidence.sender = mutate(evidence.sender);
    expect((await post(value, { v: 1, runId: config.runId, seq: 4, realm: 'content', phase: 'loaded', evidence })).status).toBe(400);
    expect(value.bridge.snapshot()).toMatchObject({ accepted: 3, failure: { code: 'PROTOCOL_REJECTED' } });
  });

  it('rejects oversized request bodies and closes collector admission', async () => {
    const value = await fixture();
    const response = await fetch(value.bridge.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1) });
    expect(response.status).toBe(413);
    value.bridge.closeAdmission();
    expect((await post(value, { v: 1 })).status).toBe(503);
    expect(value.bridge.snapshot().rejections.bodyLimit).toBe(1);
  });

  it('bounds partial-body connections during drain', async () => {
    const value = await fixture();
    const port = value.server.address().port;
    const raw = connect(port, '127.0.0.1');
    raw.on('error', () => {});
    await new Promise(resolve => raw.once('connect', resolve));
    raw.write(`POST /__benchmark/runtime HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${config.authToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    expect(await value.bridge.drain({ timeoutMs: 500 })).toBe(true);
    raw.destroy();
    expect(value.bridge.snapshot().accepted).toBe(0);
  });

  it('drains a connection held in an incomplete request header', async () => {
    const value = await fixture();
    const port = value.server.address().port;
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`POST /__benchmark/runtime HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    expect(await value.bridge.drain({ timeoutMs: 500 })).toBe(true);
    await new Promise(resolve => socket.once('close', resolve));
    expect(socket.destroyed).toBe(true);
  });

  it('enforces an absolute bridge-connection deadline for partial headers', async () => {
    const value = await fixture();
    const port = value.server.address().port;
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    const closed = new Promise(resolve => socket.once('close', resolve));
    const started = Date.now();
    socket.write('POST /__benchmark/runtime HTTP/1.1\r\nHost:');
    await closed;
    expect(Date.now() - started).toBeLessThan(3500);
    expect(value.bridge.snapshot().accepted).toBe(0);
  });

  it('closes the listener when bridge validation fails before returning a fixture', async () => {
    const countServers = () => process._getActiveHandles().filter(handle => handle.constructor?.name === 'Server').length;
    const before = countServers();
    await expect(startFixture(createFixture(), { runtimeBridge: { runId: 'invalid', authToken: 'short', expectedExtensionId: 'id' } })).rejects.toThrow('Invalid runtime bridge configuration');
    await new Promise(resolve => setImmediate(resolve));
    expect(countServers()).toBe(before);
  });

  it('terminates an authenticated request whose body stalls past the absolute deadline', async () => {
    const value = await fixture();
    const port = value.server.address().port;
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    const closed = new Promise(resolve => socket.once('close', resolve));
    const started = Date.now();
    socket.write(`POST /__benchmark/runtime HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${config.authToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    await closed;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(value.bridge.snapshot().accepted).toBe(0);
  });

  it('rejects non-canonical host, wrong paths, query strings, and unauthenticated OPTIONS without CORS', async () => {
    const value = await fixture();
    expect((await fetch(value.bridge.reportUrl, { method: 'OPTIONS' })).status).toBe(404);
    const socket = connect(value.server.address().port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    const hostResponse = new Promise(resolve => { let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); });
    socket.end(`GET /__benchmark/runtime HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n`);
    expect((await hostResponse).split(' ')[1]).toBe('404');
    expect((await fetch(`${value.bridge.reportUrl}?extra=1`, { method: 'POST', headers: { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${value.url}__benchmark/not-runtime`, { method: 'POST' })).status).toBe(404);
    expect(value.bridge.snapshot()).not.toHaveProperty('authToken');
    expect(JSON.stringify(value.bridge.snapshot())).not.toContain(config.authToken);
  });

  it('keeps default Chrome fixture responses unchanged and supports bounded drain', async () => {
    const value = await fixture(null);
    expect(value).not.toHaveProperty('bridge');
    expect((await fetch(value.url)).status).toBe(200);
    expect((await fetch(`${value.url}__benchmark/runtime`, { method: 'POST' })).status).toBe(404);
    value.server.closeAllConnections?.();
    await new Promise(resolve => value.server.close(resolve));
  });
});

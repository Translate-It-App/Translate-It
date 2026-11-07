import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTransportRequest } from './page-translation-e2e-benchmark/metrics.mjs';
import { BiDi, classifyProtocolFailure, createRequestDispatcher, latestRealmObservations, runFirefoxProbe } from './page-translation-e2e-firefox/driver.mjs';
import { launchIsolatedWorker } from './page-translation-e2e-firefox/launcher.mjs';
import { writeBenchmarkArtifact } from './page-translation-e2e-benchmark/artifact-writer.mjs';
import {
  capability, classifyObservedRealm, classifyRequestAction, isolationSnapshot, notTested,
  requiredCapabilities, retainExecutedCapability, runtimeProbeGate, summarizeCapabilities,
} from './page-translation-e2e-firefox/capabilities.mjs';

function fakeSocket() {
  const listeners = new Map(); const sent = [];
  return {
    sent,
    addEventListener(name, listener) { listeners.set(name, listener); },
    send(data) { sent.push(JSON.parse(data)); }, close() {},
    message(value) { listeners.get('message')({ data: typeof value === 'string' ? value : JSON.stringify(value) }); },
    disconnect() { listeners.get('close')({ code: 1006 }); },
  };
}
const allSupported = () => Object.fromEntries(requiredCapabilities.map(name => [name, capability('SUPPORTED')]));

describe('Firefox capability gates', () => {
  it('requires a complete flat map and never treats NOT_TESTED as successful', () => {
    expect(summarizeCapabilities({}).status).toBe('FAILED');
    const pending = allSupported(); pending.pageNegativeFetch = notTested('gated');
    expect(summarizeCapabilities(pending).status).toBe('UNSUPPORTED');
    pending.backgroundReadiness = capability('FAILED');
    expect(summarizeCapabilities(pending).status).toBe('FAILED');
    expect(summarizeCapabilities(allSupported()).status).toBe('SUPPORTED');
  });

  it('rejects exposed-but-broken realms and exact discovery-flag mismatches', () => {
    expect(classifyObservedRealm({ observation: { realmExposed: false }, expectedEntry: 'x' }).status).toBe('UNSUPPORTED');
    expect(classifyObservedRealm({ observation: { realmExposed: true, evaluationError: 'denied' }, expectedEntry: 'x' }).status).toBe('FAILED');
    expect(classifyObservedRealm({ observation: { realmExposed: true, entryMatched: false }, expectedEntry: 'x' }).status).toBe('FAILED');
    expect(classifyObservedRealm({ observation: { realmExposed: true, entryMatched: true, ready: false }, expectedEntry: 'x' }).status).toBe('FAILED');
    expect(classifyObservedRealm({ observation: { realmExposed: true, entryMatched: true, ready: true, flags: { slicedDiscoveryEnabled: false } }, expectedEntry: 'x', expectedFlags: { slicedDiscoveryEnabled: true } }).status).toBe('FAILED');
  });

  it('gates extension actions on both ready realms and exact flags without replacing failed results', () => {
    const caps = { backgroundInspection: capability('SUPPORTED'), backgroundReadiness: capability('SUPPORTED'), contentInspection: capability('SUPPORTED'), contentReadiness: capability('SUPPORTED'), discoveryFlags: capability('SUPPORTED') };
    expect(runtimeProbeGate(caps)).toBe(true);
    caps.contentReadiness = capability('FAILED');
    expect(runtimeProbeGate(caps)).toBe(false);
    const alreadyFailed = capability('FAILED', { reason: 'executed probe failure' });
    expect(retainExecutedCapability(alreadyFailed, 'gate closed')).toBe(alreadyFailed);
    expect(retainExecutedCapability(null, 'gate closed').status).toBe('NOT_TESTED');
  });

  it('deduplicates repeated readiness observations by realm before identifying addon worlds', () => {
    const observations = latestRealmObservations([
      { realm: 'page', context: 'target', type: 'window', value: { fixture: true } },
      { realm: 'page', context: 'target', type: 'window', value: { fixture: true } },
    ]);
    expect(observations).toHaveLength(1);
    expect(observations.filter(item => item.context === 'target' && item.type === 'window')).toHaveLength(1);
  });

  it('requires exactly loopback and no IPv4 or IPv6 route', () => {
    const base = { interfaces: 'lo UNKNOWN 127.0.0.1/8 ::1/128', routes: '', routes6: '' };
    expect(isolationSnapshot(base).ok).toBe(true);
    expect(isolationSnapshot({ ...base, interfaces: '' }).ok).toBe(false);
    expect(isolationSnapshot({ ...base, interfaces: `${base.interfaces}\nether UP 10.0.0.2/24` }).ok).toBe(false);
    expect(isolationSnapshot({ ...base, routes: 'default via 10.0.0.1' }).ok).toBe(false);
    expect(isolationSnapshot({ ...base, routes6: 'default via fe80::1' }).ok).toBe(false);
  });

  it('fails closed for unknown requests and only permits fixture/known voices', () => {
    expect(classifyRequestAction('local')).toBe('continue-local');
    expect(classifyRequestAction('startup-metadata-fixture')).toBe('provide-known-empty-voices');
    expect(classifyRequestAction('provider-translation')).toBe('fail-closed');
    expect(classifyRequestAction('blocked')).toBe('fail-closed');
    expect(classifyTransportRequest({ method: 'GET', url: 'http://127.0.0.1:4123/' }, { fixtureOrigin: 'http://127.0.0.1:4123' }).kind).toBe('local');
    expect(classifyTransportRequest({ method: 'GET', url: 'https://example.invalid/' }).kind).toBe('blocked');
  });

  it('blocks Firefox launch and build when namespace verification fails', async () => {
    const artifact = {}; let built = false;
    const result = await runFirefoxProbe({ artifact, checkIsolation: async () => ({ ok: false, interfaces: 'eth0 UP', routes: 'default', routes6: '' }), buildBenchmarkExtension: async () => { built = true; } });
    expect(built).toBe(false);
    expect(result.isolation.status).toBe('FAILED');
    expect(result.bidiSession.status).toBe('NOT_TESTED');
  });

  it('preserves failed build setup and closes the already-started local fixture', async () => {
    const artifact = {};
    const result = await runFirefoxProbe({
      artifact,
      checkIsolation: async () => ({ ok: true, interfaces: 'lo UNKNOWN 127.0.0.1/8 ::1/128', routes: '', routes6: '' }),
      buildBenchmarkExtension: async () => { throw new Error('intentional isolated builder failure'); },
    });
    expect(result.protocol.status).toBe('FAILED');
    expect(artifact.fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(result.cleanup.status).toBe('SUPPORTED');
  });
});

describe('Firefox BiDi transport', () => {
  it('correlates out-of-order replies and preserves events in the journal', async () => {
    const socket = fakeSocket(); const bidi = new BiDi(socket, 100);
    const first = bidi.command('session.new'); const second = bidi.command('network.addIntercept');
    socket.message({ type: 'event', method: 'network.beforeRequestSent', params: { request: { url: 'https://example.invalid/' } } });
    socket.message({ type: 'success', id: socket.sent[1].id, result: { intercept: 'i' } });
    socket.message({ type: 'success', id: socket.sent[0].id, result: { sessionId: 's' } });
    await expect(second).resolves.toMatchObject({ result: { intercept: 'i' } });
    await expect(first).resolves.toMatchObject({ result: { sessionId: 's' } });
    expect(bidi.events[0].method).toBe('network.beforeRequestSent');
    expect(bidi.journal.map(item => item.direction)).toEqual(['command', 'command', 'response', 'response']);
  });

  it('fails pending commands on malformed JSON, protocol errors, disconnect, and timeout', async () => {
    const malformedSocket = fakeSocket(); const malformed = new BiDi(malformedSocket, 100);
    const malformedPending = malformed.command('x'); malformedSocket.message('{');
    await expect(malformedPending).rejects.toThrow('Malformed BiDi JSON');

    const errorSocket = fakeSocket(); const errorBidi = new BiDi(errorSocket, 100);
    const protocolError = errorBidi.command('x'); errorSocket.message({ type: 'error', id: 1, error: 'unknown command', message: 'nope' });
    await expect(protocolError).rejects.toThrow('unknown command');

    const closedSocket = fakeSocket(); const closed = new BiDi(closedSocket, 100);
    const disconnected = closed.command('x'); closedSocket.disconnect();
    await expect(disconnected).rejects.toThrow('BiDi disconnected');

    const timeout = new BiDi(fakeSocket(), 10);
    await expect(timeout.command('never replies')).rejects.toThrow('timed out');
    expect(timeout.pending.size).toBe(0);
  });

  it('drains event handlers and propagates rejected handler work', async () => {
    const socket = fakeSocket(); const bidi = new BiDi(socket, 100);
    bidi.onEvent(async () => { throw new Error('request release failed'); });
    socket.message({ type: 'event', method: 'network.beforeRequestSent', params: {} });
    await expect(bidi.drain()).rejects.toThrow('request release failed');
  });

  it('allows only an explicitly idle teardown disconnect; active disconnect remains fatal', async () => {
    const idleSocket = fakeSocket(); const idle = new BiDi(idleSocket, 100);
    idle.markExpectedIdleDisconnect(); idleSocket.disconnect();
    await expect(idle.drain()).resolves.toBeUndefined();
    expect(idle.protocolError).toBeNull();

    const activeSocket = fakeSocket(); const active = new BiDi(activeSocket, 100);
    const command = active.command('network.continueRequest'); activeSocket.disconnect();
    await expect(command).rejects.toThrow('BiDi disconnected');
    await expect(active.drain()).rejects.toThrow('BiDi disconnected');
  });

  it('fails a held-request release when its protocol command rejects', async () => {
    const socket = fakeSocket(); const bidi = new BiDi(socket, 100);
    const release = bidi.command('network.continueRequest', { request: 'held' });
    socket.message({ type: 'error', id: 1, error: 'invalid argument', message: 'unknown request' });
    await expect(release).rejects.toThrow('invalid argument');
  });

  it.each([
    ['null envelope', 'null', 'Malformed BiDi envelope'],
    ['wrong response type', { type: 'event', id: 1, params: {} }, 'Malformed BiDi response envelope'],
    ['wrong response id', { type: 'success', id: 99, result: {} }, 'unknown or mismatched id'],
    ['missing result', { type: 'success', id: 1 }, 'no object result'],
  ])('latches fatal malformed protocol: %s', async (_label, response, expected) => {
    const socket = fakeSocket(); const bidi = new BiDi(socket, 100);
    const pending = bidi.command('script.getRealms'); socket.message(response);
    await expect(pending).rejects.toThrow(expected);
    expect(bidi.journal.some(item => item.direction === 'transport-error')).toBe(true);
    await expect(bidi.command('next')).rejects.toThrow(expected);
  });

  it('classifies only narrow BiDi unsupported codes as unsupported, not transport errors', () => {
    expect(classifyProtocolFailure(Object.assign(new Error('unavailable'), { code: 'unknown command', method: 'script.getRealms' })).status).toBe('UNSUPPORTED');
    expect(classifyProtocolFailure(Object.assign(new Error('late'), { code: 'timeout', method: 'script.evaluate' })).status).toBe('FAILED');
    expect(classifyProtocolFailure(new Error('Malformed BiDi JSON')).status).toBe('FAILED');
  });
});

describe('Firefox request dispatcher', () => {
  const event = (url, request, isBlocked = true, method = 'GET') => ({ method: 'network.beforeRequestSent', params: { isBlocked, request: { url, request, method } } });

  it('routes only local fixture and known voices, and fails unknown external HTTP(S)', async () => {
    const commands = [];
    const dispatcher = createRequestDispatcher({ fixtureOrigin: 'http://127.0.0.1:4567', bidi: { command: async (name, params) => { commands.push({ name, params }); return { type: 'success', result: {} }; } } });
    await dispatcher.onEvent(event('http://127.0.0.1:4567/', 'local'));
    await dispatcher.onEvent(event('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list', 'voices'));
    await dispatcher.onEvent(event('https://outside.invalid/resource', 'outside'));
    await dispatcher.onEvent(event('data:image/svg+xml,abc', 'data', false));
    expect(commands.map(item => item.name)).toEqual(['network.continueRequest', 'network.provideResponse', 'network.failRequest']);
    expect(dispatcher.requests.map(item => item.action)).toEqual(['continue-local', 'fixture-voices', 'fail-unexpected', 'ignored-non-network-scheme']);
    expect(dispatcher.errors).toHaveLength(0);
  });

  it('closes admission, fails late blocked HTTP(S), bounds excess handlers, and reports release failures', async () => {
    let releaseFirst; const commands = [];
    const dispatcher = createRequestDispatcher({ fixtureOrigin: 'http://127.0.0.1:4567', maxInFlight: 1, bidi: { command: (name, params) => {
      commands.push({ name, params });
      if (params.request === 'first') return new Promise(resolve => { releaseFirst = resolve; });
      if (params.request === 'late') return Promise.reject(new Error('network.failRequest release failed'));
      return Promise.resolve({ type: 'success', result: {} });
    } } });
    const first = dispatcher.onEvent(event('http://127.0.0.1:4567/', 'first'));
    await Promise.resolve();
    await dispatcher.onEvent(event('https://outside.invalid/overflow', 'overflow'));
    releaseFirst({ type: 'success', result: {} }); await first;
    dispatcher.closeAdmission();
    await dispatcher.onEvent(event('https://outside.invalid/late', 'late'));
    expect(await dispatcher.drain(100)).toBe(true);
    expect(commands.map(item => [item.name, item.params.request])).toEqual([
      ['network.continueRequest', 'first'], ['network.failRequest', 'late'],
    ]);
    expect(dispatcher.requests.map(item => item.action)).toEqual(['continue-local', 'fail-closed-overflow', 'fail-terminal-request']);
    expect(dispatcher.errors.map(error => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('admission limit reached'), expect.stringContaining('admission closed'), expect.stringContaining('release failed'),
    ]));
  });

  it('marks bounded handler-drain timeout as fatal', async () => {
    const dispatcher = createRequestDispatcher({ fixtureOrigin: 'http://127.0.0.1:4567', bidi: { command: () => new Promise(() => {}) } });
    dispatcher.onEvent(event('http://127.0.0.1:4567/', 'stuck'));
    await Promise.resolve(); dispatcher.closeAdmission();
    expect(await dispatcher.drain(5)).toBe(false);
    expect(dispatcher.errors.at(-1).message).toMatch(/timed out/);
  });
});

describe('isolated launcher completion', () => {
  function fakeChild() {
    const child = new EventEmitter(); child.pid = 42; child.kills = [];
    child.kill = signal => child.kills.push(signal);
    return child;
  }

  it('writes a current failure artifact on async spawn error despite stale prior output', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'ff-launch-error-'));
    try {
      const child = fakeChild(); const artifactPath = resolve(directory, 'result.json');
      await writeBenchmarkArtifact(artifactPath, { runId: 'old', status: 'SUPPORTED' });
      const result = launchIsolatedWorker({ command: 'unshare', args: [], env: {}, artifactPath, runId: 'new', spawnProcess: () => { queueMicrotask(() => { child.emit('error', new Error('ENOENT')); child.emit('close', -2, null); }); return child; }, writeFailure: async reason => writeBenchmarkArtifact(artifactPath, { runId: 'new', status: 'FAILED', reason }) });
      await expect(result).resolves.toBe(1);
      expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({ runId: 'new', status: 'FAILED' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects stale successful artifacts and validates current exit/status agreement', async () => {
    const child = fakeChild(); let failure;
    const staleResult = launchIsolatedWorker({ command: 'unshare', args: [], env: {}, artifactPath: '/tmp/result.json', runId: 'new', spawnProcess: () => { queueMicrotask(() => child.emit('close', 0, null)); return child; }, readArtifact: async () => JSON.stringify({ runId: 'old', status: 'SUPPORTED' }), writeFailure: async reason => { failure = reason; } });
    await expect(staleResult).resolves.toBe(1);
    expect(failure).toMatch(/another run/);

    const unsupportedChild = fakeChild();
    const unsupported = launchIsolatedWorker({ command: 'unshare', args: [], env: {}, artifactPath: '/tmp/result.json', runId: 'same', spawnProcess: () => { queueMicrotask(() => unsupportedChild.emit('close', 2, null)); return unsupportedChild; }, readArtifact: async () => JSON.stringify({ runId: 'same', status: 'UNSUPPORTED' }), writeFailure: async () => {} });
    await expect(unsupported).resolves.toBe(2);
  });

  it('forces an outer deadline and records nonzero failure when a child never closes', async () => {
    const child = fakeChild(); const signals = []; let failure;
    const result = launchIsolatedWorker({ command: 'unshare', args: [], env: {}, artifactPath: '/tmp/result.json', runId: 'timeout', timeoutMs: 5, killGraceMs: 5, finalGraceMs: 5, spawnProcess: () => child, processRef: { kill: (_pid, signal) => signals.push(signal) }, writeFailure: async reason => { failure = reason; } });
    await expect(result).resolves.toBe(1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(failure).toMatch(/bounded deadline/);
  });
});

describe('Firefox failure artifacts', () => {
  it('atomically replaces stale artifact data with current run evidence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'ff-cap-artifact-test-'));
    try {
      const path = resolve(directory, 'result.json');
      await writeBenchmarkArtifact(path, { runId: 'old', status: 'SUPPORTED' });
      await writeBenchmarkArtifact(path, { runId: 'new', status: 'FAILED', reason: 'setup' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ runId: 'new', status: 'FAILED' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

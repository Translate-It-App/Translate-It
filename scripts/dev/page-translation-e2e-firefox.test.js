import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTransportRequest } from './page-translation-e2e-benchmark/metrics.mjs';
import { BiDi, applyRuntimeBridgeFailure, applyRuntimeBridgeReportedError, classifyProtocolFailure, createRequestDispatcher, latestRealmObservations, reconcileFinalRuntimeBridge, recordUnattemptedRuntimeBridge, runFirefoxProbe, runRuntimeBridgeSequence, validateRuntimeBridgeErrorReport, validateRuntimeBridgeReport, validateRuntimeBridgeSnapshot } from './page-translation-e2e-firefox/driver.mjs';
import { launchIsolatedWorker } from './page-translation-e2e-firefox/launcher.mjs';
import { writeBenchmarkArtifact } from './page-translation-e2e-benchmark/artifact-writer.mjs';
import {
  blockRuntimeBridgePrerequisite, capability, classifyObservedRealm, classifyRequestAction, isolationSnapshot, notTested,
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

function runtimeReports({ runId = 'run-123', extensionId = 'probe@test', tabId = 17, fixtureUrl = 'http://127.0.0.1:4567/' } = {}) {
  const sender = { id: extensionId, tabId, frameId: 0, url: fixtureUrl, origin: new URL(fixtureUrl).origin, documentId: 'doc-1' };
  const bgChecks = Object.fromEntries(['lifecycleInitialized', 'translationEngineInitialized', 'enginePresent', 'unifiedEngineMatches', 'unifiedServiceMatches', 'messageListenerActive', 'startupComplete'].map(key => [key, true]));
  const contentChecks = Object.fromEntries(['coreInitialized', 'listenerActive', 'featureManagerInitialized', 'handlerActive', 'handlerIsActive'].map(key => [key, true]));
  const reports = [
    { v: 1, runId, seq: 1, realm: 'background', phase: 'bootstrap', evidence: { extensionId, extensionOrigin: 'moz-extension://123e4567-e89b-12d3-a456-426614174000', tabId } },
    { v: 1, runId, seq: 2, realm: 'background', phase: 'loaded', evidence: { entry: 'src/core/background/index.js' } },
    { v: 1, runId, seq: 3, realm: 'background', phase: 'ready', evidence: { checks: bgChecks, hostPermission: true } },
    { v: 1, runId, seq: 4, realm: 'content', phase: 'loaded', evidence: { entry: 'src/core/content-scripts/index-main.js', sender, navigationGeneration: 1 } },
    { v: 1, runId, seq: 5, realm: 'content', phase: 'ready', evidence: { checks: contentChecks, flags: { slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false }, sender, navigationGeneration: 1, ackReceived: true } },
  ];
  return { runId, extensionId, tabId, fixtureUrl, reports };
}

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

  it('accepts the exact five-stage authenticated runtime report contract and rejects malformed or out-of-order evidence', () => {
    const contract = runtimeReports();
    const accepted = contract.reports.map((report, index) => validateRuntimeBridgeReport(report, {
      runId: contract.runId, sequence: index + 1, realm: report.realm, phase: report.phase,
      extensionId: contract.extensionId, fixtureUrl: contract.fixtureUrl, tabId: contract.tabId,
      priorSender: index === 4 ? contract.reports[3].evidence.sender : null,
    }));
    expect(accepted).toHaveLength(5);
    expect(accepted[4].evidence.flags).toEqual({ slicedDiscoveryEnabled: true, viewportFirstDiscoveryEnabled: false });
    expect(() => validateRuntimeBridgeReport({ ...contract.reports[0], runId: 'different' }, {
      runId: contract.runId, sequence: 1, realm: 'background', phase: 'bootstrap', extensionId: contract.extensionId,
    })).toThrow(/invalid v\/run/);
    const badFlags = { ...contract.reports[4], evidence: { ...contract.reports[4].evidence, flags: { slicedDiscoveryEnabled: true } } };
    expect(() => validateRuntimeBridgeReport(badFlags, {
      runId: contract.runId, sequence: 5, realm: 'content', phase: 'ready', extensionId: contract.extensionId,
      fixtureUrl: contract.fixtureUrl, tabId: contract.tabId, priorSender: contract.reports[3].evidence.sender,
    })).toThrow(/content readiness/);
    expect(() => validateRuntimeBridgeSnapshot({ failure: { code: 'READINESS_TIMEOUT' }, reports: [] }, accepted)).toThrow(/terminally failed/);
    expect(() => validateRuntimeBridgeSnapshot({ failure: null, reports: accepted.slice(0, 4), rejections: {} }, accepted)).toThrow(/incomplete/);
  });

  it.each([
    ['background startup check', 2, report => { report.evidence.checks.startupComplete = false; }],
    ['host permission', 2, report => { report.evidence.hostPermission = false; }],
    ['content sender tab', 3, report => { report.evidence.sender.tabId += 1; }],
    ['content sender frame', 3, report => { report.evidence.sender.frameId = 1; }],
    ['content readiness acknowledgment', 4, report => { report.evidence.ackReceived = false; }],
    ['unexpected content entry', 3, report => { report.evidence.entry = 'other.js'; }],
  ])('fails closed on invalid %s evidence', (_name, index, mutate) => {
    const contract = runtimeReports(); const report = structuredClone(contract.reports[index]); mutate(report);
    expect(() => validateRuntimeBridgeReport(report, {
      runId: contract.runId, sequence: index + 1, realm: report.realm, phase: report.phase,
      extensionId: contract.extensionId, fixtureUrl: contract.fixtureUrl, tabId: contract.tabId,
      priorSender: index === 4 ? contract.reports[3].evidence.sender : null,
    })).toThrow();
  });

  it('uses navigation generation when both optional document ids are absent and rejects a document-id downgrade', () => {
    const contract = runtimeReports();
    const loaded = contract.reports[3];
    loaded.evidence.sender.documentId = null;
    const ready = contract.reports[4];
    ready.evidence.sender.documentId = null;
    expect(() => validateRuntimeBridgeReport(ready, {
      runId: contract.runId, sequence: 5, realm: 'content', phase: 'ready', extensionId: contract.extensionId,
      fixtureUrl: contract.fixtureUrl, tabId: contract.tabId, priorSender: loaded.evidence.sender,
    })).not.toThrow();
    ready.evidence.sender = { ...ready.evidence.sender, documentId: 'document-id-available' };
    expect(() => validateRuntimeBridgeReport(ready, {
      runId: contract.runId, sequence: 5, realm: 'content', phase: 'ready', extensionId: contract.extensionId,
      fixtureUrl: contract.fixtureUrl, tabId: contract.tabId, priorSender: loaded.evidence.sender,
    })).toThrow(/sender identity changed/);
  });

  it('rejects an untrusted content sender origin or extra sender fields', () => {
    const contract = runtimeReports(); const report = structuredClone(contract.reports[3]);
    report.evidence.sender.origin = 'https://evil.invalid';
    expect(() => validateRuntimeBridgeReport(report, {
      runId: contract.runId, sequence: 4, realm: 'content', phase: 'loaded', extensionId: contract.extensionId,
      fixtureUrl: contract.fixtureUrl, tabId: contract.tabId,
    })).toThrow(/pinned extension top frame/);
    report.evidence.sender.origin = null; report.evidence.sender.extra = 'unexpected';
    expect(() => validateRuntimeBridgeReport(report, {
      runId: contract.runId, sequence: 4, realm: 'content', phase: 'loaded', extensionId: contract.extensionId,
      fixtureUrl: contract.fixtureUrl, tabId: contract.tabId,
    })).toThrow(/pinned extension top frame/);
  });

  it('does not mark absent authenticated bridge stages supported and retains failed stages', () => {
    const caps = {}; applyRuntimeBridgeFailure(caps, 'content.ready', 'flags mismatch');
    expect(caps.runtimeBridge.status).toBe('FAILED');
    expect(caps.contentReadiness.status).toBe('FAILED');
    expect(caps.discoveryFlags.status).toBe('NOT_TESTED');
    expect(caps.runtimeHandshake.status).toBe('NOT_TESTED');
    expect(caps.backgroundLoaded).toBeUndefined();
  });

  it('maps only authenticated collector error reports to their concrete failed gates', () => {
    const collectorError = validateRuntimeBridgeErrorReport({ v: 1, runId: 'run-123', seq: 1, realm: 'background', phase: 'error', evidence: { code: 'PERMISSION_DENIED' } }, { runId: 'run-123', sequence: 1 });
    const caps = {};
    applyRuntimeBridgeReportedError(caps, collectorError, 'collector terminal code');
    expect(caps.runtimeBridge.status).toBe('FAILED');
    expect(caps.hostPermissions.status).toBe('FAILED');
    expect(caps.backgroundReadiness).toBeUndefined();
    const flagsMismatch = validateRuntimeBridgeErrorReport({ v: 1, runId: 'run-123', seq: 1, realm: 'content', phase: 'error', evidence: { code: 'DISCOVERY_FLAGS_MISMATCH' } }, { runId: 'run-123', sequence: 1 });
    applyRuntimeBridgeReportedError(caps, flagsMismatch, 'collector terminal code');
    expect(caps.discoveryFlags.status).toBe('FAILED');
    const startupError = validateRuntimeBridgeErrorReport({ v: 1, runId: 'run-123', seq: 1, realm: 'background', phase: 'error', evidence: { code: 'STARTUP_FAILED' } }, { runId: 'run-123', sequence: 1 });
    applyRuntimeBridgeReportedError(caps, startupError, 'collector terminal code');
    expect(caps.backgroundReadiness.status).toBe('FAILED');
    expect(() => validateRuntimeBridgeErrorReport({ v: 1, runId: 'run-123', seq: 1, realm: 'background', phase: 'error', evidence: { code: 'permission denied' } }, { runId: 'run-123', sequence: 1 })).toThrow(/invalid/);
  });

  it('does not let authenticated bridge readiness override BiDi realm inspection gates', () => {
    const caps = {
      backgroundInspection: capability('UNSUPPORTED'), backgroundReadiness: capability('SUPPORTED', { source: 'authenticated-runtime-bridge' }),
      contentInspection: capability('UNSUPPORTED'), contentReadiness: capability('SUPPORTED', { source: 'authenticated-runtime-bridge' }),
      discoveryFlags: capability('SUPPORTED', { source: 'authenticated-runtime-bridge' }),
    };
    expect(runtimeProbeGate(caps)).toBe(false);
  });

  it.each(['interceptionSetup', 'extensionInstall'])('keeps bridge-dependent states NOT_TESTED when %s is unsupported before any runtime attempt', name => {
    const capabilities = Object.fromEntries(requiredCapabilities.map(key => [key, notTested('not reached')]));
    capabilities.protocol = capability('UNSUPPORTED', { reason: 'unknown command' });
    blockRuntimeBridgePrerequisite(capabilities, name, 'UNSUPPORTED', 'unsupported command');
    expect(capabilities[name].status).toBe('UNSUPPORTED');
    expect(capabilities.runtimeBridge.status).toBe('NOT_TESTED');
    expect(capabilities.backgroundLoaded.status).toBe('NOT_TESTED');
    expect(capabilities.contentLoaded.status).toBe('NOT_TESTED');
    expect(summarizeCapabilities(capabilities).status).toBe('UNSUPPORTED');
  });

  it('keeps the bridge NOT_TESTED with a clean collector snapshot when an earlier prerequisite was unsupported', async () => {
    const capabilities = Object.fromEntries(requiredCapabilities.map(key => [key, notTested('not reached')]));
    capabilities.protocol = capability('UNSUPPORTED');
    blockRuntimeBridgePrerequisite(capabilities, 'interceptionSetup', 'UNSUPPORTED', 'interception command unsupported');
    const artifact = {};
    const result = await recordUnattemptedRuntimeBridge({ bridge: { snapshot: () => ({ reports: [], failure: null, rejections: { protocol: 0 } }) }, capabilities, artifact });
    expect(result.clean).toBe(true);
    expect(capabilities.runtimeBridge.status).toBe('NOT_TESTED');
    expect(artifact.runtimeBridge).toMatchObject({ attempted: false, snapshot: { reports: [], failure: null } });
    expect(summarizeCapabilities(capabilities).status).toBe('UNSUPPORTED');
  });

  it('keeps a real authenticated runtime-stage failure FAILED instead of downgrading it to unsupported', () => {
    const capabilities = Object.fromEntries(requiredCapabilities.map(key => [key, notTested('not reached')]));
    capabilities.protocol = capability('SUPPORTED');
    applyRuntimeBridgeFailure(capabilities, 'background.ready', 'startup check failed');
    expect(capabilities.runtimeBridge.status).toBe('FAILED');
    expect(capabilities.backgroundReadiness.status).toBe('FAILED');
    expect(summarizeCapabilities(capabilities).status).toBe('FAILED');
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
    const { startFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    const result = await runFirefoxProbe({
      artifact,
      createFixtureOverride: createFixture,
      startFixtureOverride: async fixture => {
        const running = await startFixture(fixture);
        running.bridge = {
          bindingUrl: `${running.url}__benchmark/bind/run`, reportUrl: `${running.url}__benchmark/runtime`,
          waitFor: async () => { throw new Error('not reached'); }, snapshot: () => ({ reports: [], failure: null, rejections: {} }),
          closeAdmission() {}, drain: async () => true,
        };
        return running;
      },
      checkIsolation: async () => ({ ok: true, interfaces: 'lo UNKNOWN 127.0.0.1/8 ::1/128', routes: '', routes6: '' }),
      buildBenchmarkExtension: async () => { throw new Error('intentional isolated builder failure'); },
    });
    expect(result.protocol.status).toBe('NOT_TESTED');
    expect(artifact.fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(result.runtimeBridge.status).toBe('FAILED');
    expect(result.cleanup.status).toBe('SUPPORTED');
  });

  it('keeps the generated runtime auth token out of the artifact and passes it only to trusted fixture/build inputs', async () => {
    const artifact = { runId: 'private-run' };
    const { startFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    let fixtureBridgeConfig; let buildOptions; let activeBridge; let fixtureServer;
    const result = await runFirefoxProbe({
      artifact, createFixtureOverride: createFixture,
      startFixtureOverride: async (fixtureData, { runtimeBridge }) => {
        fixtureBridgeConfig = runtimeBridge;
        const running = await startFixture(fixtureData, { runtimeBridge });
        activeBridge = running.bridge;
        fixtureServer = running.server;
        return running;
      },
      checkIsolation: async () => ({ ok: true, interfaces: 'lo UNKNOWN 127.0.0.1/8 ::1/128', routes: '', routes6: '' }),
      buildBenchmarkExtension: async options => {
        buildOptions = options;
        expect(options).toMatchObject({ browser: 'firefox', mode: 'sliced' });
        expect(options.runtimeBridge.runId).toBe(fixtureBridgeConfig.runId);
        expect(options.runtimeBridge.fixtureUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(options.runtimeBridge.bindingUrl).toBe(activeBridge.bindingUrl);
        expect(options.runtimeBridge.reportUrl).toBe(activeBridge.reportUrl);
        expect(options.runtimeBridge.authToken).toMatch(/^[\da-f]{64}$/);
        throw new Error(`simulated builder failure ${options.runtimeBridge.authToken}`);
      },
    });
    expect(fixtureBridgeConfig.runId).toBe('private-run');
    expect(fixtureBridgeConfig.authToken).toMatch(/^[\da-f]{64}$/);
    expect(buildOptions.runtimeBridge.authToken).toBe(fixtureBridgeConfig.authToken);
    expect(fixtureBridgeConfig.authToken).not.toBe(fixtureBridgeConfig.runId);
    expect(JSON.stringify({ artifact, result })).not.toContain(fixtureBridgeConfig.authToken);
    expect(result.runtimeBridge.status).toBe('FAILED');
    expect(result.cleanup.status).toBe('SUPPORTED');
    expect(fixtureServer.listening).toBe(false);
    expect(activeBridge.snapshot()).toMatchObject({ failure: null, accepted: 0 });
    await expect(activeBridge.waitFor('background', 'bootstrap')).rejects.toThrow(/admission is closed/);
  });

  it('rejects a runtime bridge endpoint containing the private token without exposing it in error evidence', async () => {
    const artifact = { runId: 'private-url-run' };
    const { startFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    let token; let built = false;
    const result = await runFirefoxProbe({
      artifact, createFixtureOverride: createFixture,
      startFixtureOverride: async (fixtureData, { runtimeBridge }) => {
        token = runtimeBridge.authToken;
        const running = await startFixture(fixtureData);
        running.bridge = {
          bindingUrl: `${running.url}__benchmark/bind/private-url-run`,
          reportUrl: `${running.url}__benchmark/runtime?auth=${encodeURIComponent(token)}`,
          waitFor: async () => { throw new Error('not reached'); }, snapshot: () => ({ reports: [], failure: null, rejections: {} }),
          closeAdmission() {}, drain: async () => true,
        };
        return running;
      },
      checkIsolation: async () => ({ ok: true, interfaces: 'lo UNKNOWN 127.0.0.1/8 ::1/128', routes: '', routes6: '' }),
      buildBenchmarkExtension: async () => { built = true; },
    });
    expect(built).toBe(false);
    expect(result.runtimeBridge.status).toBe('FAILED');
    expect(JSON.stringify({ artifact, result })).not.toContain(token);
  });
});

describe('Firefox authenticated runtime bridge sequence', () => {
  it('binds the real driver context, installs only after binding, waits reports in order, then loads the fixture', async () => {
    const contract = runtimeReports(); const calls = [];
    const bindingUrl = 'http://127.0.0.1:4567/__benchmark/bind/run-123';
    const reportUrl = 'http://127.0.0.1:4567/__benchmark/runtime';
    let reportIndex = 0;
    const bidi = { command: async (method, params) => {
      calls.push({ method, params });
      return { type: 'success', result: method === 'browsingContext.navigate' ? { url: params.url, navigation: `nav-${calls.length}` } : {} };
    } };
    const bridge = {
      bindingUrl, reportUrl,
      async waitFor(realm, phase) {
        const report = contract.reports[reportIndex++];
        expect([report.realm, report.phase]).toEqual([realm, phase]);
        return report;
      },
      snapshot() { return { reports: contract.reports, failure: null, rejections: { unauthorized: 0, protocol: 0 } }; },
    };
    const proof = await runRuntimeBridgeSequence({
      bidi, bridge, context: 'tab-context', bindingUrl, fixtureUrl: contract.fixtureUrl,
      runId: contract.runId, extensionId: contract.extensionId, installExtension: async () => { calls.push({ method: 'webExtension.install' }); return contract.extensionId; },
    });
    expect(calls.map(item => item.method)).toEqual([
      'browsingContext.navigate', 'webExtension.install', 'browsingContext.navigate',
    ]);
    expect(calls[0].params.url).toBe(bindingUrl);
    expect(calls[2].params).toMatchObject({ context: 'tab-context', url: contract.fixtureUrl });
    expect(proof.reports).toHaveLength(5);
    expect(proof.snapshot.rejections).toEqual({ unauthorized: 0, protocol: 0 });
    expect(proof.contentReady.ackReceived).toBe(true);
  });

  it('fails closed on bad report order, missing evidence, and unexpected collector rejection', async () => {
    const contract = runtimeReports();
    const bidi = { command: async (_method, params) => ({ type: 'success', result: { url: params.url } }) };
    const bridge = {
      bindingUrl: 'http://127.0.0.1:4567/__benchmark/bind/run-123',
      reportUrl: 'http://127.0.0.1:4567/__benchmark/runtime',
      waitFor: async () => contract.reports[1], snapshot: () => ({ reports: [], failure: null, rejections: {} }),
    };
    await expect(runRuntimeBridgeSequence({ bidi, bridge, context: 't', bindingUrl: bridge.bindingUrl, fixtureUrl: contract.fixtureUrl, runId: contract.runId, extensionId: contract.extensionId, installExtension: async () => contract.extensionId })).rejects.toThrow(/invalid v\/run/);
    expect(() => validateRuntimeBridgeSnapshot({ reports: contract.reports, failure: null, rejections: { protocol: 1 } }, contract.reports, contract)).toThrow(/rejected reports/);
  });

  it('reconciles a late authenticated collector error after an initially successful five-report proof', async () => {
    const { startFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    const runId = 'late-error-run'; const extensionId = 'probe@test'; const tabId = 91; const authToken = 'ab'.repeat(32);
    const fixture = await startFixture(createFixture('small'), { runtimeBridge: { runId, authToken, expectedExtensionId: extensionId } });
    try {
      const contract = runtimeReports({ runId, extensionId, tabId, fixtureUrl: fixture.url });
      const post = async report => {
        const response = await fetch(fixture.bridge.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' }, body: JSON.stringify(report) });
        expect(response.status).toBe(200);
        return response.json();
      };
      const bidi = { command: async (_method, params) => {
        if (params.url === fixture.url) { await post(contract.reports[3]); await post(contract.reports[4]); }
        return { type: 'success', result: { url: params.url } };
      } };
      const proof = await runRuntimeBridgeSequence({
        bidi, bridge: fixture.bridge, context: 'tab-context', bindingUrl: fixture.bridge.bindingUrl, fixtureUrl: fixture.url,
        runId, extensionId, installExtension: async () => {
          await post(contract.reports[0]); await post(contract.reports[1]); await post(contract.reports[2]);
          return extensionId;
        },
      });
      expect(proof.reports).toHaveLength(5);
      expect((await post({ v: 1, runId, seq: 6, realm: 'background', phase: 'error', evidence: { code: 'STARTUP_FAILED' } })).accepted).toBe(true);
      fixture.bridge.closeAdmission(); await fixture.bridge.drain({ timeoutMs: 3000 });
      const capabilities = {
        runtimeBridge: capability('SUPPORTED'), backgroundLoaded: capability('SUPPORTED'), contentLoaded: capability('SUPPORTED'),
        backgroundReadiness: capability('SUPPORTED'), contentReadiness: capability('SUPPORTED'), hostPermissions: capability('SUPPORTED'),
        discoveryFlags: capability('SUPPORTED'), runtimeHandshake: capability('SUPPORTED'),
      };
      const artifact = { runtimeBridge: { reports: proof.reports, snapshot: proof.snapshot }, errors: [] };
      const final = await reconcileFinalRuntimeBridge({
        bridge: fixture.bridge, expectedReports: proof.reports,
        contract: { runId, extensionId, fixtureUrl: fixture.url, tabId }, capabilities, artifact,
      });
      expect(final.ok).toBe(false);
      expect(capabilities.runtimeBridge.status).toBe('FAILED');
      expect(capabilities.backgroundReadiness.status).toBe('FAILED');
      expect(capabilities.backgroundLoaded.status).toBe('SUPPORTED');
      expect(artifact.runtimeBridge.snapshot.failure).toMatchObject({ code: 'STARTUP_FAILED' });
      expect(artifact.runtimeBridge.snapshot.reports).toHaveLength(6);
      expect(fixture.server.listening).toBe(false);
    } finally {
      fixture.bridge.closeAdmission(); await fixture.bridge.drain({ timeoutMs: 3000 });
    }
  });

  it.each([
    ['throwing', () => { throw new Error('collector unavailable'); }],
    ['null', () => null],
    ['undefined', () => undefined],
    ['array', () => []],
    ['primitive', () => 7],
  ])('replaces an initially clean bridge artifact when the final collector snapshot is %s', async (_label, snapshot) => {
    const caps = { runtimeBridge: capability('SUPPORTED', { snapshot: { failure: null, reports: ['clean'] } }) };
    const artifact = { runtimeBridge: { snapshot: { failure: null, reports: ['clean'] } } };
    const result = await reconcileFinalRuntimeBridge({
      bridge: { snapshot },
      expectedReports: [], contract: { runId: 'r', extensionId: 'id', fixtureUrl: 'http://127.0.0.1/', tabId: 1 },
      capabilities: caps, artifact,
    });
    expect(result.ok).toBe(false);
    expect(caps.runtimeBridge.status).toBe('FAILED');
    expect(artifact.runtimeBridge.snapshot).toMatchObject({ status: 'FAILED' });
    expect(artifact.runtimeBridge.snapshot.reports).toBeUndefined();
  });

  it('fails final reconciliation when the real collector rejects a duplicate authenticated report', async () => {
    const { startFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    const runId = 'duplicate-report-run'; const extensionId = 'probe@test'; const tabId = 92; const authToken = 'cd'.repeat(32);
    const fixture = await startFixture(createFixture('small'), { runtimeBridge: { runId, authToken, expectedExtensionId: extensionId } });
    try {
      const contract = runtimeReports({ runId, extensionId, tabId, fixtureUrl: fixture.url });
      const post = async report => fetch(fixture.bridge.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' }, body: JSON.stringify(report) });
      const bidi = { command: async (_method, params) => {
        if (params.url === fixture.url) { await post(contract.reports[3]); await post(contract.reports[4]); }
        return { type: 'success', result: { url: params.url } };
      } };
      const proof = await runRuntimeBridgeSequence({
        bidi, bridge: fixture.bridge, context: 'tab-context', bindingUrl: fixture.bridge.bindingUrl, fixtureUrl: fixture.url,
        runId, extensionId, installExtension: async () => {
          await post(contract.reports[0]); await post(contract.reports[1]); await post(contract.reports[2]);
          return extensionId;
        },
      });
      expect((await post(contract.reports[4])).status).toBe(400);
      fixture.bridge.closeAdmission(); await fixture.bridge.drain({ timeoutMs: 3000 });
      const capabilities = { runtimeBridge: capability('SUPPORTED'), contentLoaded: capability('SUPPORTED'), contentReadiness: capability('SUPPORTED') };
      const artifact = { runtimeBridge: { reports: proof.reports, snapshot: proof.snapshot } };
      const final = await reconcileFinalRuntimeBridge({ bridge: fixture.bridge, expectedReports: proof.reports, contract: { runId, extensionId, fixtureUrl: fixture.url, tabId }, capabilities, artifact });
      expect(final.ok).toBe(false);
      expect(capabilities.runtimeBridge.status).toBe('FAILED');
      expect(capabilities.contentLoaded.status).toBe('SUPPORTED');
      expect(artifact.runtimeBridge.snapshot.rejections.protocol).toBe(1);
      expect(artifact.runtimeBridge.snapshot.failure).toMatchObject({ code: 'PROTOCOL_REJECTED' });
    } finally {
      fixture.bridge.closeAdmission(); await fixture.bridge.drain({ timeoutMs: 3000 });
    }
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

  it('allows only the exact runtime collector POST destination', async () => {
    const commands = []; const reportUrl = 'http://127.0.0.1:4567/__benchmark/runtime';
    const dispatcher = createRequestDispatcher({ fixtureOrigin: 'http://127.0.0.1:4567', runtimeReportUrl: reportUrl, bidi: { command: async (name, params) => { commands.push({ name, params }); return { type: 'success', result: {} }; } } });
    await dispatcher.onEvent(event(reportUrl, 'report', true, 'POST'));
    await dispatcher.onEvent(event(reportUrl, 'get-report', true, 'GET'));
    await dispatcher.onEvent(event('http://127.0.0.1:4567/__benchmark/other', 'other', true, 'POST'));
    expect(commands.map(item => [item.name, item.params.request])).toEqual([
      ['network.continueRequest', 'report'], ['network.failRequest', 'get-report'], ['network.failRequest', 'other'],
    ]);
    expect(dispatcher.requests[0].action).toBe('continue-exact-runtime-report');
    expect(dispatcher.requests.slice(1).every(item => item.action === 'fail-unexpected')).toBe(true);
    expect(dispatcher.errors).toHaveLength(0);
  });

  it('preserves the actual HTTP request while redacting private BiDi journal and event copies', async () => {
    const token = 'private-token-value'; const socket = fakeSocket(); const bidi = new BiDi(socket, 100, { secretValues: [token] }); const delivered = [];
    bidi.onEvent(message => delivered.push(message));
    const outgoing = bidi.command('network.send', { headers: [{ name: 'Authorization', value: { type: 'string', value: `Bearer ${token}` } }], body: token });
    expect(JSON.stringify(socket.sent[0])).toContain(token);
    socket.message({ type: 'success', id: socket.sent[0].id, result: {} }); await outgoing;
    socket.message({ type: 'event', method: 'network.beforeRequestSent', params: { request: { url: `http://127.0.0.1/?v=${encodeURIComponent(token)}`, headers: [{ name: 'Authorization', value: { type: 'string', value: `Bearer ${token}` } }, { name: 'Cookie', value: { type: 'string', value: token } }] } } });
    await bidi.drain();
    const saved = JSON.stringify({ events: bidi.events, delivered, journal: bidi.journal });
    expect(saved).not.toContain(token);
    expect(saved).toContain('[REDACTED]');
  });

  it('redacts private tokens echoed by malformed JSON before recording protocol errors', () => {
    const token = '0123456789abcdef'.repeat(4); const prefix = token.slice(0, 10); const socket = fakeSocket(); const bidi = new BiDi(socket, 100, { secretValues: [token] });
    socket.message(`{"truncated":"${token}`);
    const artifact = { errors: [bidi.protocolError.message], protocolJournal: bidi.journal, protocolEvents: bidi.events };
    const saved = JSON.stringify(artifact);
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(prefix);
    expect(bidi.protocolError.message).toBe('Malformed BiDi JSON message.');
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

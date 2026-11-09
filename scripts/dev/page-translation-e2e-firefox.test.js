import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTransportRequest, mapEdgeResponse } from './page-translation-e2e-benchmark/metrics.mjs';
import { BiDi, applyRuntimeBridgeFailure, applyRuntimeBridgeReportedError, classifyProtocolFailure, createRequestDispatcher, decodeEdgeRequestBody, latestRealmObservations, providerProbeArtifact, providerProbeRequiresImmediateTeardown, reconcileFinalProviderOperation, reconcileFinalRuntimeBridge, recordUnattemptedRuntimeBridge, removeProviderNetworkControls, runEdgeFrenchProviderProbe, runFirefoxProbe, runRuntimeBridgeSequence, setupProviderDataCollector, validateEdgeBodyAgainstNative, validateEdgeProviderCorrelation, validateProviderOperationSnapshot, validateProviderReleaseReceipt, validateRuntimeBridgeErrorReport, validateRuntimeBridgeReport, validateRuntimeBridgeSnapshot, validEdgePageTranslateUrl } from './page-translation-e2e-firefox/driver.mjs';
import { launchIsolatedWorker } from './page-translation-e2e-firefox/launcher.mjs';
import { compareRestoreDOMSnapshots } from './page-translation-e2e-firefox/restore-dom-diagnostics.mjs';
import { writeBenchmarkArtifact } from './page-translation-e2e-benchmark/artifact-writer.mjs';
import {
  blockRuntimeBridgePrerequisite, capability, classifyObservedRealm, classifyRequestAction, isolationSnapshot, notTested,
  requiredCapabilities, retainExecutedCapability, runtimeProbeGate, summarizeCapabilities,
  summarizeCapabilitySet,
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

function providerHarness(options = {}) {
  const fixture = providerReports(options);
  if (options.physicalOutcome) {
    fixture.reports[3].evidence.outcome = options.physicalOutcome;
    fixture.reports[3].evidence.status = options.physicalOutcome === 'fulfilled' ? 200 : null;
    fixture.reports[3].evidence.code = options.physicalOutcome === 'fulfilled' ? null : 'NETWORK_ERROR';
  }
  if (options.badTranslated) fixture.reports[7].evidence.duplicateAcceptances = 1;
  if (options.commandSuccess === false) fixture.reports[6].evidence.success = false;
  if (options.commandSession) fixture.reports[6].evidence.sessionId = options.commandSession;
  if (options.translatedSession) fixture.reports[7].evidence.sessionId = options.translatedSession;
  if (options.physicalSession) fixture.reports[2].evidence.sessionId = options.physicalSession;
  const observedReports = []; const calls = []; let released = false; let stopped = false; let stopCode = null; let restoreDecision = null;
  const dispatcher = createRequestDispatcher({ fixtureOrigin: new URL(fixture.fixtureUrl).origin, bidi: { command: (...args) => fakeBidi.command(...args) } });
  const requestEvent = {
    method: 'network.beforeRequestSent',
    params: { context: 'some-context', isBlocked: options.requestBlocked !== false, request: { request: 'bidi-request-1', url: options.requestUrl ?? fixture.url, method: options.requestMethod ?? 'POST', bodySize: options.bodySize ?? fixture.bytes.length } },
  };
  const requestEvents = options.requestEvents ?? [requestEvent];
  const fakeBidi = {
    async command(method, params) {
      calls.push({ method, params });
      if (method === 'network.getData') {
        if (options.bodyError) throw Object.assign(new Error(options.bodyError.message), { code: options.bodyError.code, method });
        return { type: 'success', id: 1, result: options.bodyByRequest?.[params.request] ?? options.bodyData ?? { type: 'string', value: options.bodyText ?? fixture.bodyText } };
      }
      if (method === 'network.provideResponse' && options.responseError) throw Object.assign(new Error(options.responseError.message), { code: options.responseError.code, method });
      return { type: 'success', id: calls.length, result: {} };
    },
  };
  const reports = Object.fromEntries(fixture.reports.map(report => [report.event, report]));
  if (options.restoreFailure) delete reports.restored;
  const operationServer = new EventEmitter();
  const queuedOperationReports = [];
  const waitForQueuedOperation = (event, { timeoutMs = 3000 } = {}) => {
    const current = queuedOperationReports.find(report => report.event === event);
    if (current) return Promise.resolve(structuredClone(current));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { operationServer.removeListener('runtime-provider-operation', listener); clearTimeout(timer); };
      const listener = () => {
        const report = queuedOperationReports.find(item => item.event === event);
        if (!report) return;
        cleanup(); resolve(structuredClone(report));
      };
      timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error(`Timed out waiting for ${event}`), { code: 'timeout' })); }, timeoutMs);
      operationServer.on('runtime-provider-operation', listener);
      listener();
    });
  };
  const queueOperationReports = reportsToQueue => {
    queuedOperationReports.push(...reportsToQueue.map(report => structuredClone(report)));
    operationServer.emit('runtime-provider-operation');
  };
  const bridge = {
    server: operationServer,
    operationSnapshot() {
      let available = options.manualOperationQueue ? queuedOperationReports : options.operationReports ?? fixture.reports;
      if (options.omitEvent) available = available.slice(0, available.findIndex(report => report.event === options.omitEvent));
      if (!options.manualOperationQueue && (options.emitRequest === false || options.physicalOutcome === 'rejected')) {
        const parserIndex = available.findIndex(report => report.event === 'parser-success');
        if (parserIndex >= 0) available = available.slice(0, parserIndex);
      }
      if (options.restoreFailure) available = available.filter(report => report.event !== 'restored');
      const queued = released ? available.map((report, index) => ({ ...report, opSeq: index + 1 }))
        .filter(report => options.releaseDecision !== 'stop' || report.event === 'armed') : [];
      return { op: 'edge-fr-page-once', released, restoreDecision, stopped, stopCode, reports: queued, rejections: { originOrType: 0, protocol: 0 }, failure: options.operationFailure ?? null };
    },
    async releaseProviderProbe() {
      released = true;
      if (options.releaseDecision === 'stop') { stopped = true; stopCode = options.stopCode ?? 'INTERCEPTION_UNSUPPORTED'; }
      else if (options.manualOperationQueue) queueOperationReports([fixture.reports.find(report => report.event === 'armed')]);
      else if (options.emitRequest !== false) queueMicrotask(() => { for (const event of requestEvents) void dispatcher.onEvent(event); });
      if (!options.manualOperationQueue) queueMicrotask(() => operationServer.emit('runtime-provider-operation'));
      return { decision: options.releaseDecision ?? 'start' };
    },
    async waitForOperation(event) {
      if (options.manualOperationQueue) return waitForQueuedOperation(event);
      const report = options.omitEvent === event ? null : reports[event];
      if (!report) throw Object.assign(new Error(`Timed out waiting for ${event}`), { code: 'timeout' });
      if (options.badReportEvent === event) return options.badReport;
      return report;
    },
    async decideRestore(decision) { restoreDecision = decision; return decision; },
    async stopProviderProbe(code) { stopped = true; stopCode = code; return true; },
  };
  const capabilities = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('not reached')]));
  return { ...fixture, dispatcher, fakeBidi, bridge, calls, capabilities, queueOperationReports,
    async queueProviderRequests(events) { await Promise.all(events.map(event => dispatcher.onEvent(event))); },
    get observedReports() { return observedReports; }, get stopCode() { return stopCode; }, get restoreDecision() { return restoreDecision; } };
}

function providerReports({ runId = 'provider-run', extensionId = 'probe@test', tabId = 17, fixtureUrl = 'http://127.0.0.1:4567/', texts } = {}) {
  const sourceTexts = texts ?? Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
  const bodyText = JSON.stringify(sourceTexts); const bytes = Buffer.from(bodyText); const url = 'https://edge.microsoft.com/translate/translatetext?to=fr&isEnterpriseClient=false';
  const invocation = { invocationId: 'invocation-1', sessionId: 'message-1', messageId: 'message-1', provider: 'edge', itemCount: 12, sourceIndexes: Array.from({ length: 12 }, (_, index) => index) };
  const physical = { attemptId: 'attempt-1', invocationId: invocation.invocationId, sessionId: invocation.sessionId, messageId: invocation.messageId, provider: 'edge', method: 'POST', url, bodyBytes: bytes.length, bodyHash: createHash('sha256').update(bytes).digest('hex'), sourceIndexes: invocation.sourceIndexes };
  const reports = [
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 1, event: 'armed', evidence: { sender: { id: extensionId, tabId, frameId: 0, url: fixtureUrl, origin: new URL(fixtureUrl).origin, documentId: 'doc-1' }, navigationGeneration: 1, edgeHostPermission: true, proxyDisabled: true, observersInstalled: true } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 2, event: 'provider-invoked', evidence: invocation },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 3, event: 'physical-start', evidence: physical },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 4, event: 'physical-settled', evidence: { attemptId: physical.attemptId, sessionId: invocation.sessionId, outcome: 'fulfilled', status: 200, code: null } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 5, event: 'parser-success', evidence: { invocationId: invocation.invocationId, sessionId: invocation.sessionId, sourceIndexes: invocation.sourceIndexes, resultsMatch: true } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 6, event: 'provider-settled', evidence: { invocationId: invocation.invocationId, sessionId: invocation.sessionId, outcome: 'fulfilled', code: null } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 7, event: 'command-result', evidence: { success: true, sessionId: invocation.sessionId, code: null } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 8, event: 'translated', evidence: { sessionId: invocation.sessionId, acceptedTargetIds: Array.from({ length: 12 }, (_, index) => `target-${index}`), acceptedCount: 12, duplicateAcceptances: 0, staleWrites: 0, domMatches: true, sessionOwned: true, quiescent: true } },
    { v: 1, runId, op: 'edge-fr-page-once', opSeq: 9, event: 'restored', evidence: { sessionId: invocation.sessionId, commandSuccess: true, domMatchesOriginal: true, metadataRestored: true, restoreObserved: true } },
  ];
  return { runId, extensionId, tabId, fixtureUrl, url, bodyText, bytes, invocation, physical, reports, texts: sourceTexts };
}

function subsetOperationSnapshot(fixture, duplicateSuccessfulBatch = false) {
  const all = Array.from({ length: 12 }, (_, index) => index);
  const first = all.slice(0, 6); const second = all.slice(6);
  const invocation = (id, indexes) => ({ invocationId: id, sessionId: fixture.invocation.sessionId, messageId: `message-${id}`, provider: 'edge', itemCount: indexes.length, sourceIndexes: indexes });
  const invocations = [invocation('chunk-a', first), invocation('chunk-b', second)];
  const events = [fixture.reports[0]];
  invocations.forEach(item => events.push({ event: 'scheduler-batch', evidence: {
    messageId: item.messageId, sessionId: item.sessionId, targetIds: item.sourceIndexes.map(index => `target-${index}`),
  } }));
  invocations.forEach(evidence => events.push({ event: 'provider-invoked', evidence }));
  const attempts = [
    { attemptId: 'failed-first', invocationId: 'chunk-a', indexes: first, outcome: 'rejected' },
    { attemptId: 'retry-a', invocationId: 'chunk-a', indexes: first, outcome: 'fulfilled' },
    { attemptId: 'chunk-b-attempt', invocationId: 'chunk-b', indexes: second, outcome: 'fulfilled' },
  ];
  if (duplicateSuccessfulBatch) attempts.push({ attemptId: 'duplicate-a', invocationId: 'chunk-a', indexes: first, outcome: 'fulfilled' });
  for (const attempt of attempts) {
    const owner = invocations.find(item => item.invocationId === attempt.invocationId);
    const evidence = { ...fixture.physical, attemptId: attempt.attemptId, invocationId: owner.invocationId, messageId: owner.messageId, sourceIndexes: attempt.indexes };
    events.push({ event: 'physical-start', evidence });
    events.push({ event: 'physical-settled', evidence: { attemptId: attempt.attemptId, sessionId: owner.sessionId, outcome: attempt.outcome, status: attempt.outcome === 'fulfilled' ? 200 : null, code: attempt.outcome === 'fulfilled' ? null : 'NETWORK_ERROR' } });
  }
  for (const item of invocations) events.push({ event: 'parser-success', evidence: { invocationId: item.invocationId, sessionId: item.sessionId, sourceIndexes: item.sourceIndexes, resultsMatch: true } });
  events.push(...fixture.reports.slice(6));
  const reports = events.map((item, index) => ({ v: 1, runId: fixture.runId, op: 'edge-fr-page-once', opSeq: index + 1, event: item.event, evidence: item.evidence }));
  return { op: 'edge-fr-page-once', released: true, restoreDecision: 'restore', stopped: true, stopCode: 'COMPLETED', reports, rejections: { originOrType: 0, protocol: 0 }, failure: null };
}

function providerBatchScenario(fixture) {
  const textsByIndexes = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]].map(indices => indices.map(index => fixture.texts[index]));
  const invocations = textsByIndexes.map((texts, index) => ({ invocationId: `batch-${index}`, sessionId: fixture.invocation.sessionId, messageId: `batch-message-${index}`, provider: 'edge', itemCount: texts.length, sourceIndexes: texts.map(text => fixture.texts.indexOf(text)) }));
  const url = fixture.url;
  const batches = textsByIndexes.map((texts, index) => {
    const body = JSON.stringify(texts); const bytes = Buffer.from(body); const attemptId = `batch-attempt-${index}`;
    return { texts, body, bytes, attemptId, physical: { ...fixture.physical, attemptId, invocationId: invocations[index].invocationId, messageId: invocations[index].messageId, bodyBytes: bytes.length, bodyHash: createHash('sha256').update(bytes).digest('hex'), sourceIndexes: invocations[index].sourceIndexes } };
  });
  const events = [fixture.reports[0]];
  invocations.forEach(item => events.push({ event: 'scheduler-batch', evidence: {
    messageId: item.messageId, sessionId: item.sessionId, targetIds: item.sourceIndexes.map(index => `target-${index}`),
  } }));
  invocations.forEach(evidence => events.push({ event: 'provider-invoked', evidence }));
  batches.forEach(({ physical }) => events.push({ event: 'physical-start', evidence: physical }));
  batches.forEach(({ attemptId, physical }) => events.push({ event: 'physical-settled', evidence: { attemptId, sessionId: physical.sessionId, outcome: 'fulfilled', status: 200, code: null } }));
  invocations.forEach(item => events.push({ event: 'parser-success', evidence: { invocationId: item.invocationId, sessionId: item.sessionId, sourceIndexes: item.sourceIndexes, resultsMatch: true } }));
  invocations.forEach(item => events.push({ event: 'provider-settled', evidence: { invocationId: item.invocationId, sessionId: item.sessionId, outcome: 'fulfilled', code: null } }));
  events.push(...fixture.reports.slice(6));
  const reports = events.map((item, index) => ({ v: 1, runId: fixture.runId, op: 'edge-fr-page-once', opSeq: index + 1, event: item.event, evidence: item.evidence }));
  const requestEvents = batches.map(({ physical }, index) => ({ method: 'network.beforeRequestSent', params: { context: 'context', isBlocked: true, request: { request: `request-${index}`, url, method: 'POST', bodySize: physical.bodyBytes } } }));
  return { reports, batches, requestEvents };
}

function watchManualSnapshotProgress(bridge) {
  const originalSnapshot = bridge.operationSnapshot.bind(bridge);
  const changes = new EventEmitter();
  const readsBySequence = new Map();
  bridge.operationSnapshot = () => {
    const snapshot = originalSnapshot();
    for (const report of snapshot.reports) readsBySequence.set(report.opSeq, (readsBySequence.get(report.opSeq) ?? 0) + 1);
    changes.emit('snapshot');
    return snapshot;
  };
  return {
    nextSequence: () => originalSnapshot().reports.length + 1,
    waitUntilReadCount(sequence, count = 2) {
      if ((readsBySequence.get(sequence) ?? 0) >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => { changes.removeListener('snapshot', check); clearTimeout(timer); };
        const check = () => {
          if ((readsBySequence.get(sequence) ?? 0) < count) return;
          cleanup(); resolve();
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for operation snapshot opSeq ${sequence} to be consumed.`)); }, 3000);
        changes.on('snapshot', check);
        check();
      });
    },
  };
}

function placeCommandAcknowledgment(reports, eventIndex, { sessionId, success = true } = {}) {
  sessionId ??= reports.find(report => report.event === 'provider-invoked')?.evidence.sessionId ?? 'session-1';
  const events = reports.map(report => ({ event: report.event, evidence: report.evidence })).filter(report => report.event !== 'command-result');
  events.splice(eventIndex, 0, { event: 'command-result', evidence: { success, sessionId: success ? sessionId : null, code: success ? null : 'PROTOCOL_ERROR' } });
  return events.map((report, index) => ({ v: 1, runId: reports[0].runId, op: 'edge-fr-page-once', opSeq: index + 1, event: report.event, evidence: report.evidence }));
}

function providerRetryScenario(fixture) {
  const indexes = Array.from({ length: 12 }, (_, index) => index);
  const invocation = { invocationId: 'retry-invocation', sessionId: fixture.invocation.sessionId, messageId: 'retry-message', provider: 'edge', itemCount: 12, sourceIndexes: indexes };
  const body = JSON.stringify(fixture.texts); const bytes = Buffer.from(body);
  const physical = attemptId => ({ ...fixture.physical, attemptId, invocationId: invocation.invocationId, messageId: invocation.messageId, bodyBytes: bytes.length, bodyHash: createHash('sha256').update(bytes).digest('hex'), sourceIndexes: indexes });
  const first = physical('retry-failed'); const second = physical('retry-success');
  const events = [
    fixture.reports[0],
    { event: 'provider-invoked', evidence: invocation },
    { event: 'physical-start', evidence: first }, { event: 'physical-start', evidence: second },
    { event: 'physical-settled', evidence: { attemptId: first.attemptId, sessionId: invocation.sessionId, outcome: 'rejected', status: null, code: 'NETWORK_ERROR' } },
    { event: 'physical-settled', evidence: { attemptId: second.attemptId, sessionId: invocation.sessionId, outcome: 'fulfilled', status: 200, code: null } },
    { event: 'parser-success', evidence: { invocationId: invocation.invocationId, sessionId: invocation.sessionId, sourceIndexes: indexes, resultsMatch: true } },
    { event: 'provider-settled', evidence: { invocationId: invocation.invocationId, sessionId: invocation.sessionId, outcome: 'fulfilled', code: null } },
    ...fixture.reports.slice(6),
  ];
  const reports = events.map((item, index) => ({ v: 1, runId: fixture.runId, op: 'edge-fr-page-once', opSeq: index + 1, event: item.event, evidence: item.evidence }));
  const requestEvents = [0, 1].map(index => ({ method: 'network.beforeRequestSent', params: { context: 'context', isBlocked: true, request: { request: `retry-request-${index}`, url: fixture.url, method: 'POST', bodySize: bytes.length } } }));
  return { reports, requestEvents, bodyByRequest: Object.fromEntries([0, 1].map(index => [`retry-request-${index}`, { type: 'string', value: body }])) };
}

describe('Firefox capability gates', () => {
  it('compares safe Restore DOM evidence without equating an absent class to an empty class', () => {
    const targets = Array.from({ length: 12 }, (_, index) => ({
      id: `target-${index}`, kind: index < 6 ? 'text' : 'title',
      text: { size: index < 6 ? 8 : 0, sha256: 'a'.repeat(64), matchesExpected: true },
      markup: { size: index < 6 ? 8 : 0, sha256: 'b'.repeat(64), matchesExpected: true },
      title: { present: index >= 6, size: index >= 6 ? 8 : 0, sha256: 'c'.repeat(64), matchesExpected: true },
    }));
    const baseline = { htmlClass: { present: false, value: null }, targets };
    const final = structuredClone(baseline);
    final.htmlClass = { present: true, value: '' };
    final.targets[0].text = { ...final.targets[0].text, sha256: 'd'.repeat(64), matchesExpected: false };
    final.targets[6].title = { ...final.targets[6].title, sha256: 'e'.repeat(64), matchesExpected: false };
    const evidence = compareRestoreDOMSnapshots(baseline, final);
    expect(evidence.htmlClass).toMatchObject({ baseline: { present: false, value: null }, final: { present: true, value: '' }, equal: false });
    expect(evidence.targets[0].text).toMatchObject({ unchanged: false, restored: false });
    expect(evidence.targets[6].title).toMatchObject({ unchanged: false, restored: false });
    expect(evidence.matchesOriginal).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain('Benchmark sentence');
  });

  it('summarizes only explicit Phase-1 requirements without promoting Phase-2 NOT_TESTED fields', () => {
    const capabilities = { isolation: capability('SUPPORTED'), restore: capability('SUPPORTED'), cancellation: notTested('Phase 2') };
    expect(summarizeCapabilitySet(capabilities, ['isolation', 'restore'])).toMatchObject({ status: 'SUPPORTED' });
    expect(summarizeCapabilitySet(capabilities, ['isolation', 'restore', 'cancellation']).status).toBe('UNSUPPORTED');
    capabilities.restore = capability('FAILED');
    expect(summarizeCapabilitySet(capabilities, ['isolation', 'restore']).status).toBe('FAILED');
  });

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

  it('keeps native request/response body bytes out of the BiDi journal while returning getData to the driver', async () => {
    const socket = fakeSocket(); const bidi = new BiDi(socket, 100); const sourceText = 'Benchmark sentence 1 has stable fixture content.';
    const bodyRead = bidi.command('network.getData', { request: 'request-1', dataType: 'request', collector: 'collector-1' });
    socket.message({ type: 'success', id: socket.sent[0].id, result: { type: 'string', value: sourceText } });
    await expect(bodyRead).resolves.toMatchObject({ result: { value: sourceText } });
    const bodyWritten = bidi.command('network.provideResponse', { request: 'request-1', body: { type: 'string', value: sourceText } });
    expect(JSON.stringify(socket.sent[1])).toContain(sourceText);
    socket.message({ type: 'success', id: socket.sent[1].id, result: {} }); await bodyWritten;
    const journal = JSON.stringify(bidi.journal);
    expect(journal).not.toContain(sourceText);
    expect(journal).toContain('byteLength');
    expect(journal).toContain('sha256');
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

describe('Firefox native Edge fr operation', () => {
  it('accepts an authenticated armed report queued before release and releases exactly once', async () => {
    const harness = providerHarness(); harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const snapshot = harness.bridge.operationSnapshot.bind(harness.bridge); let releaseCalls = 0;
    harness.bridge.operationSnapshot = () => {
      const result = snapshot();
      if (!result.released) result.reports = [harness.reports.find(report => report.event === 'armed')];
      return result;
    };
    const release = harness.bridge.releaseProviderProbe.bind(harness.bridge);
    harness.bridge.releaseProviderProbe = async () => { releaseCalls++; return release(); };
    // This checks admission ordering, not a 30 ms wall-clock performance budget.
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 1000 });
    expect(releaseCalls).toBe(1);
    expect(state.armed.event).toBe('armed');
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
  });

  it('records an early production command failure without inventing a provider session or physical request', async () => {
    const harness = providerHarness(); let released = false;
    const snapshot = harness.bridge.operationSnapshot.bind(harness.bridge);
    harness.bridge.operationSnapshot = () => {
      const result = snapshot();
      if (released) { result.released = true; result.reports = [
        harness.reports.find(report => report.event === 'armed'),
        { ...harness.reports.find(report => report.event === 'command-result'), opSeq: 2, evidence: { success: false, sessionId: null, code: 'PROTOCOL_ERROR' } },
      ]; }
      return result;
    };
    harness.bridge.releaseProviderProbe = async () => { released = true; return { decision: 'start' }; };
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 30 });
    expect(state.command.evidence).toMatchObject({ success: false, sessionId: null });
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(harness.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(state.invocation).toBeNull();
  });

  it('validates the out-of-band start/stop receipt without adding a decision to the armed report', () => {
    expect(validateProviderReleaseReceipt({ decision: 'start' })).toBe('start');
    expect(validateProviderReleaseReceipt({ decision: 'stop' })).toBe('stop');
    expect(() => validateProviderReleaseReceipt(true)).toThrow(/receipt/);
    expect(() => validateProviderReleaseReceipt({ decision: 'start', opSeq: 1 })).toThrow(/receipt/);
    const armed = providerReports().reports[0];
    expect(armed.evidence).not.toHaveProperty('decision');
  });

  it('honors a stop receipt and never attempts a native provider request', async () => {
    const harness = providerHarness({ releaseDecision: 'stop', stopCode: 'INTERCEPTION_UNSUPPORTED' });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 30 });
    expect(state.receiptDecision).toBe('stop');
    expect(state.reports.map(report => report.event), JSON.stringify({ state, snapshot: harness.bridge.operationSnapshot() })).toEqual(['armed']);
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(harness.capabilities.backgroundProviderInterception.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(harness.calls).toHaveLength(0);
  });

  it('validates the fixed endpoint and actual body/hash/source-index correlation', () => {
    const harness = providerHarness();
    expect(validEdgePageTranslateUrl(harness.url)).toBe(true);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com:444/translate/translatetext?to=fr&isEnterpriseClient=false')).toBe(false);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com/translate/translatetext?to=fr&to=fr&isEnterpriseClient=false')).toBe(false);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com/translate/translatetext?to=fr&isEnterpriseClient=false&extra=1')).toBe(false);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com/translate/translatetext?to=fr&isEnterpriseClient=true')).toBe(false);
    const decoded = decodeEdgeRequestBody({ type: 'base64', value: harness.bytes.toString('base64') });
    expect(validateEdgeProviderCorrelation(harness.invocation, harness.physical, { requestId: 'b', url: harness.url, method: 'POST', isBlocked: true, bodySize: harness.bytes.length })).toBe(true);
    expect(validateEdgeBodyAgainstNative(decoded, harness.physical, harness.texts).sourceIndexes).toEqual(harness.invocation.sourceIndexes);
    expect(() => validateEdgeBodyAgainstNative(decodeEdgeRequestBody({ type: 'string', value: JSON.stringify(['unknown']) }), harness.physical, harness.texts)).toThrow(/differs/);
    expect(() => decodeEdgeRequestBody({ type: 'string', value: JSON.stringify([harness.texts[0], harness.texts[0]]) })).toThrow(/unique/);
  });

  it('records the actual request-body collector command while allowing a real native attempt if unsupported', async () => {
    const caps = {};
    await expect(setupProviderDataCollector({ command: async (method, params) => {
      expect(method).toBe('network.addDataCollector');
      expect(params).toEqual({ collectorType: 'blob', dataTypes: ['request'], maxEncodedDataSize: 65536 });
      throw Object.assign(new Error('missing'), { code: 'unknown command' });
    } }, caps)).resolves.toBeNull();
    expect(caps.providerDataCollector.status).toBe('UNSUPPORTED');
  });

  it('removes the native request collector and global interception in bounded cleanup order', async () => {
    const calls = [];
    const cleanup = await removeProviderNetworkControls({ bidi: { command: async (method, params) => { calls.push({ method, params }); return { type: 'success', result: {} }; } }, collectorId: 'collector-id', interceptId: 'intercept-id', timeoutMs: 100 });
    expect(cleanup.ok).toBe(true);
    expect(calls).toEqual([
      { method: 'network.removeDataCollector', params: { collector: 'collector-id' } },
      { method: 'network.removeIntercept', params: { intercept: 'intercept-id' } },
    ]);
    const failed = await removeProviderNetworkControls({ bidi: { command: async () => { throw new Error('remove failed'); } }, collectorId: 'collector-id', interceptId: 'intercept-id', timeoutMs: 100 });
    expect(failed.ok).toBe(false);
    expect(failed.errors).toHaveLength(2);
  });

  it('consumes one native Edge POST through a real controlled BiDi response and all production success evidence', async () => {
    const harness = providerHarness(); harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const state = await runEdgeFrenchProviderProbe({
      bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector-1', fixtureTexts: harness.texts,
      runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 30,
    });
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(harness.capabilities.backgroundProviderInterception.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRequestBody.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerResponse.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(harness.capabilities.domAcceptance.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
    expect(harness.restoreDecision).toBe('restore');
    expect(state.stopCode).toBe('COMPLETED');
    expect(JSON.parse(harness.calls.find(call => call.method === 'network.provideResponse').params.body.value)).toEqual(mapEdgeResponse(harness.texts));
    expect(JSON.stringify(providerProbeArtifact(state))).not.toContain(harness.bodyText);
    const reconciled = await reconcileFinalProviderOperation({ bridge: harness.bridge, state, contract: { runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId }, capabilities: harness.capabilities, artifact: {} });
    expect(reconciled.ok).toBe(true);
    expect(harness.capabilities.providerOperation.status).toBe('SUPPORTED');
  });

  it('fails physical proof when no authenticated native POST starts', async () => {
    const harness = providerHarness({ omitEvent: 'physical-start' });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 5 });
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(harness.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(state.stopCode).toBe('TIMEOUT');
  });

  it('supports physical proof but leaves all later stages untested without a matching BiDi event', async () => {
    const harness = providerHarness({ emitRequest: false, physicalOutcome: 'rejected' });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 250 });
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(harness.capabilities.backgroundProviderInterception.status).toBe('UNSUPPORTED');
    expect(harness.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(state.physicalSettlement.evidence.code).toBe('NETWORK_ERROR');
    const final = await reconcileFinalProviderOperation({ bridge: harness.bridge, state, contract: { runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId }, capabilities: harness.capabilities, artifact: {} });
    expect(final.ok).toBe(true);
    expect(harness.capabilities.providerOperation.status).toBe('UNSUPPORTED');
  });

  it('fails interception for a visible unpaused or identity-mismatched Edge request', async () => {
    const unpaused = providerHarness({ requestBlocked: false });
    const unpausedState = await runEdgeFrenchProviderProbe({ bridge: unpaused.bridge, bidi: unpaused.fakeBidi, dispatcher: unpaused.dispatcher, collectorId: 'collector', fixtureTexts: unpaused.texts, runId: unpaused.runId, extensionId: unpaused.extensionId, fixtureUrl: unpaused.fixtureUrl, tabId: unpaused.tabId, capabilities: unpaused.capabilities, timeoutMs: 100 });
    expect(unpaused.capabilities.backgroundProviderInterception.status).toBe('FAILED');
    expect(unpaused.calls.some(call => call.method === 'network.continueRequest')).toBe(false);
    expect(unpausedState.stopCode).toBe('PROTOCOL_ERROR');

    const mismatched = providerHarness({ requestUrl: `${providerHarness().url}&from=en` });
    const mismatchState = await runEdgeFrenchProviderProbe({ bridge: mismatched.bridge, bidi: mismatched.fakeBidi, dispatcher: mismatched.dispatcher, collectorId: 'collector', fixtureTexts: mismatched.texts, runId: mismatched.runId, extensionId: mismatched.extensionId, fixtureUrl: mismatched.fixtureUrl, tabId: mismatched.tabId, capabilities: mismatched.capabilities, timeoutMs: 30 });
    expect(mismatched.capabilities.backgroundProviderInterception.status).toBe('FAILED');
    expect(mismatched.calls.find(call => call.method === 'network.failRequest')).toBeDefined();
    expect(mismatchState.stopCode).toBe('PROTOCOL_ERROR');
  });

  it('classifies request body unavailable only after interception, and rejects bad body/response', async () => {
    const unavailable = providerHarness();
    const unavailableState = await runEdgeFrenchProviderProbe({ bridge: unavailable.bridge, bidi: unavailable.fakeBidi, dispatcher: unavailable.dispatcher, collectorId: null, fixtureTexts: unavailable.texts, runId: unavailable.runId, extensionId: unavailable.extensionId, fixtureUrl: unavailable.fixtureUrl, tabId: unavailable.tabId, capabilities: unavailable.capabilities, timeoutMs: 30 });
    expect(unavailable.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(unavailable.capabilities.backgroundProviderInterception.status).toBe('SUPPORTED');
    expect(unavailable.capabilities.providerRequestBody.status).toBe('UNSUPPORTED');
    expect(unavailableState.stopCode).toBe('BODY_UNSUPPORTED');

    const badBody = providerHarness({ bodyText: JSON.stringify(['wrong source']) });
    const badBodyState = await runEdgeFrenchProviderProbe({ bridge: badBody.bridge, bidi: badBody.fakeBidi, dispatcher: badBody.dispatcher, collectorId: 'collector', fixtureTexts: badBody.texts, runId: badBody.runId, extensionId: badBody.extensionId, fixtureUrl: badBody.fixtureUrl, tabId: badBody.tabId, capabilities: badBody.capabilities, timeoutMs: 30 });
    expect(badBody.capabilities.providerRequestBody.status).toBe('FAILED');
    expect(badBody.calls.some(call => call.method === 'network.provideResponse')).toBe(false);
    expect(badBodyState.stopCode).toBe('INVALID_BODY');

    const responseError = providerHarness({ responseError: { code: 'invalid argument', message: 'rejected response' } });
    const responseState = await runEdgeFrenchProviderProbe({ bridge: responseError.bridge, bidi: responseError.fakeBidi, dispatcher: responseError.dispatcher, collectorId: 'collector', fixtureTexts: responseError.texts, runId: responseError.runId, extensionId: responseError.extensionId, fixtureUrl: responseError.fixtureUrl, tabId: responseError.tabId, capabilities: responseError.capabilities, timeoutMs: 30 });
    expect(responseError.capabilities.providerResponse.status).toBe('FAILED');
    expect(responseState.stopCode).toBe('PROTOCOL_ERROR');
  });

  it('does not infer native consumption from response acknowledgment and gates restore on all DOM evidence', async () => {
    const rejected = providerHarness({ physicalOutcome: 'rejected' });
    const rejectedState = await runEdgeFrenchProviderProbe({ bridge: rejected.bridge, bidi: rejected.fakeBidi, dispatcher: rejected.dispatcher, collectorId: 'collector', fixtureTexts: rejected.texts, runId: rejected.runId, extensionId: rejected.extensionId, fixtureUrl: rejected.fixtureUrl, tabId: rejected.tabId, capabilities: rejected.capabilities, timeoutMs: 250 });
    expect(rejected.capabilities.providerResponse.status).toBe('SUPPORTED');
    expect(rejected.capabilities.providerConsumption.status).toBe('FAILED');
    expect(rejected.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(rejected.restoreDecision).toBeNull();
    expect(rejectedState.stopCode).toBe('TIMEOUT');

    const duplicateDOM = providerHarness({ badTranslated: true });
    const duplicateState = await runEdgeFrenchProviderProbe({ bridge: duplicateDOM.bridge, bidi: duplicateDOM.fakeBidi, dispatcher: duplicateDOM.dispatcher, collectorId: 'collector', fixtureTexts: duplicateDOM.texts, runId: duplicateDOM.runId, extensionId: duplicateDOM.extensionId, fixtureUrl: duplicateDOM.fixtureUrl, tabId: duplicateDOM.tabId, capabilities: duplicateDOM.capabilities, timeoutMs: 30 });
    expect(duplicateDOM.capabilities.domAcceptance.status).toBe('FAILED');
    expect(duplicateDOM.restoreDecision).toBeNull();
    expect(duplicateState.stopCode).toBe('PROTOCOL_ERROR');
  });

  it('reports actual restore failure and final operation evidence without a false completed status', async () => {
    const restore = providerHarness({ restoreFailure: true });
    const state = await runEdgeFrenchProviderProbe({ bridge: restore.bridge, bidi: restore.fakeBidi, dispatcher: restore.dispatcher, collectorId: 'collector', fixtureTexts: restore.texts, runId: restore.runId, extensionId: restore.extensionId, fixtureUrl: restore.fixtureUrl, tabId: restore.tabId, capabilities: restore.capabilities, timeoutMs: 30 });
    expect(restore.restoreDecision).toBe('restore');
    expect(restore.capabilities.providerRestore.status).toBe('FAILED');
    expect(state.stopCode).toBe('TIMEOUT');
    const final = await reconcileFinalProviderOperation({ bridge: restore.bridge, state, contract: { runId: restore.runId, extensionId: restore.extensionId, fixtureUrl: restore.fixtureUrl, tabId: restore.tabId }, capabilities: restore.capabilities, artifact: {} });
    expect(final.ok).toBe(false);
    expect(restore.capabilities.providerOperation.status).toBe('FAILED');
  });
});

describe('Firefox native Edge provider probe', () => {
  it('routes a stopped unsupported native lane directly to finally teardown instead of optional realm polling', () => {
    const caps = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('not reached')]));
    caps.providerPhysicalRequest = capability('SUPPORTED');
    caps.backgroundProviderInterception = capability('UNSUPPORTED', { reason: 'No matching BiDi POST.' });
    expect(providerProbeRequiresImmediateTeardown({ attempted: true, stopped: true, stopCode: 'INTERCEPTION_UNSUPPORTED' }, caps)).toBe(true);
    expect(providerProbeRequiresImmediateTeardown({ attempted: false, stopped: false, stopCode: null }, caps)).toBe(false);
    expect(providerProbeRequiresImmediateTeardown({ attempted: true, stopped: true, stopCode: 'COMPLETED' }, allSupported())).toBe(false);
  });

  it('ends optional BiDi probes at an unsupported/failed provider boundary and continues only after complete restore', () => {
    const supported = Object.fromEntries(requiredCapabilities.map(name => [name, capability('SUPPORTED')]));
    expect(providerProbeRequiresImmediateTeardown({ attempted: true, stopCode: 'INTERCEPTION_UNSUPPORTED' }, supported)).toBe(true);
    expect(providerProbeRequiresImmediateTeardown({ attempted: true, stopCode: 'COMPLETED' }, supported)).toBe(false);
    supported.providerRestore = notTested('not restored');
    expect(providerProbeRequiresImmediateTeardown({ attempted: true, stopCode: 'COMPLETED' }, supported)).toBe(true);
    expect(providerProbeRequiresImmediateTeardown({ attempted: false, stopCode: null }, supported)).toBe(false);
  });

  it('correlates bounded source subsets and lets failed physical attempts remain diagnostics, not coverage', () => {
    const fixture = providerReports();
    const contract = { runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId };
    expect(validateProviderOperationSnapshot(subsetOperationSnapshot(fixture), contract).reports).toHaveLength(16);
    expect(() => validateProviderOperationSnapshot(subsetOperationSnapshot(fixture, true), contract)).toThrow(/exact-once/);
  });

  it('rejects translated acceptance when the actual production start result is absent', () => {
    const fixture = providerReports();
    const reports = fixture.reports.filter(report => report.event !== 'command-result')
      .map((report, index) => ({ ...report, opSeq: index + 1 }));
    const snapshot = { op: 'edge-fr-page-once', released: true, restoreDecision: 'restore', stopped: true,
      stopCode: 'COMPLETED', reports, rejections: { originOrType: 0, protocol: 0 }, failure: null };
    expect(() => validateProviderOperationSnapshot(snapshot, {
      runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId,
    })).toThrow(/command success evidence/);
  });

  it('services two independently queued six-source batches through distinct native bodies before restore', async () => {
    const fixture = providerReports({ texts: Array.from({ length: 12 }, (_, index) => `Source ${String(index).padStart(2, '0')} has stable fixture content.`) });
    const scenario = providerBatchScenario(fixture);
    expect(scenario.batches[0].bytes.length).toBe(scenario.batches[1].bytes.length);
    expect(scenario.batches[0].physical.bodyHash).not.toBe(scenario.batches[1].physical.bodyHash);
    const harness = providerHarness({
      texts: fixture.texts,
      operationReports: scenario.reports,
      requestEvents: [...scenario.requestEvents].reverse(),
      bodyByRequest: Object.fromEntries(scenario.batches.map((batch, index) => [`request-${index}`, { type: 'string', value: batch.body }])),
    });
    harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(harness.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(harness.capabilities.domAcceptance.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
    expect(harness.calls.filter(call => call.method === 'network.getData').map(call => call.params.request)).toEqual(['request-1', 'request-0']);
    expect(harness.calls.filter(call => call.method === 'network.provideResponse').map(call => call.params.request)).toEqual(['request-0', 'request-1']);
    expect(state.successfulCoverage.size).toBe(12);
    expect(state.invocations.size).toBe(2);
    expect(state.schedulerBatches.size).toBe(2);
    expect([...state.schedulerBatches.values()].map(batch => batch.targetIds)).toEqual([
      Array.from({ length: 6 }, (_, index) => `target-${index}`),
      Array.from({ length: 6 }, (_, index) => `target-${index + 6}`),
    ]);
  });

  it('provides the deterministic mixed text/title fixture without changing Provider-only fixture sources', async () => {
    const { createPageTranslationFixture, createFixture } = await import('./page-translation-e2e-benchmark/fixture.mjs');
    const page = createPageTranslationFixture();
    expect(page.targets.map(target => target.kind)).toEqual([...Array(6).fill('text'), ...Array(6).fill('title')]);
    expect(page.targets.map(target => target.id)).toEqual(Array.from({ length: 12 }, (_, index) => `target-${index}`));
    expect(page.targetTexts).toEqual(createFixture('small').targetTexts);
    expect(page.html).toContain('data-bench-kind="title" title="Benchmark sentence 7 has stable fixture content."');
  });

  it('treats a successful command acknowledgment before provider work as a start signal, not completion', async () => {
    const fixture = providerReports({ texts: Array.from({ length: 12 }, (_, index) => `Source ${String(index).padStart(2, '0')} has stable fixture content.`) });
    const scenario = providerBatchScenario(fixture);
    const harness = providerHarness({
      texts: fixture.texts, operationReports: placeCommandAcknowledgment(scenario.reports, 1),
      requestEvents: [...scenario.requestEvents].reverse(),
      bodyByRequest: Object.fromEntries(scenario.batches.map((batch, index) => [`request-${index}`, { type: 'string', value: batch.body }])),
    });
    harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const observedBeforeNativeService = [];
    const command = harness.fakeBidi.command.bind(harness.fakeBidi);
    harness.fakeBidi.command = async (method, params) => {
      if (method === 'network.getData' || method === 'network.provideResponse') observedBeforeNativeService.push(harness.capabilities.providerConsumption.status);
      return command(method, params);
    };
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(observedBeforeNativeService).toEqual(['NOT_TESTED', 'NOT_TESTED', 'NOT_TESTED', 'NOT_TESTED']);
    expect(harness.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(harness.capabilities.domAcceptance.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
    expect(state.successfulCoverage.size).toBe(12);
    expect(harness.restoreDecision).toBe('restore');
  });

  it('keeps an acknowledgment arriving during physical work separate from provider completion', async () => {
    const fixture = providerReports({ texts: Array.from({ length: 12 }, (_, index) => `Source ${String(index).padStart(2, '0')} has stable fixture content.`) });
    const scenario = providerBatchScenario(fixture);
    const harness = providerHarness({
      texts: fixture.texts, operationReports: placeCommandAcknowledgment(scenario.reports, 5),
      requestEvents: [...scenario.requestEvents].reverse(),
      bodyByRequest: Object.fromEntries(scenario.batches.map((batch, index) => [`request-${index}`, { type: 'string', value: batch.body }])),
    });
    harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(harness.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
    expect(state.providerSettlements.size).toBe(2);
    expect(state.successfulCoverage.size).toBe(12);
  });

  it('proves the start acknowledgment stays pending through each independently released six-source batch', async () => {
    const fixture = providerReports({ texts: Array.from({ length: 12 }, (_, index) => `Source ${String(index).padStart(2, '0')} has stable fixture content.`) });
    const scenario = providerBatchScenario(fixture);
    const harness = providerHarness({
      texts: fixture.texts, manualOperationQueue: true,
      bodyByRequest: Object.fromEntries(scenario.batches.map((batch, index) => [`request-${index}`, { type: 'string', value: batch.body }])),
    });
    harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const progress = watchManualSnapshotProgress(harness.bridge);
    const candidateWaits = new EventEmitter();
    let candidateWaitCount = 0;
    const waitForProviderRequest = harness.dispatcher.waitForProviderRequest.bind(harness.dispatcher);
    harness.dispatcher.waitForProviderRequest = (...args) => {
      candidateWaitCount++;
      candidateWaits.emit('waiting');
      return waitForProviderRequest(...args);
    };
    const provided = new Map(scenario.batches.map((_batch, index) => [
      `request-${index}`, (() => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; })(),
    ]));
    const originalBidiCommand = harness.fakeBidi.command.bind(harness.fakeBidi);
    harness.fakeBidi.command = async (method, params) => {
      const result = await originalBidiCommand(method, params);
      if (method === 'network.provideResponse') provided.get(params.request)?.resolve(params);
      return result;
    };
    const restoreCalled = (() => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; })();
    const originalDecideRestore = harness.bridge.decideRestore.bind(harness.bridge);
    harness.bridge.decideRestore = async decision => {
      const result = await originalDecideRestore(decision);
      restoreCalled.resolve(decision);
      return result;
    };
    let finished = false;
    const probe = runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 1500 })
      .finally(() => { finished = true; });
    await progress.waitUntilReadCount(1);

    const commandAck = fixture.reports.find(report => report.event === 'command-result');
    let ackSeq = progress.nextSequence();
    harness.queueOperationReports([commandAck]);
    await progress.waitUntilReadCount(ackSeq);
    expect(finished).toBe(false);
    expect(harness.capabilities.providerConsumption.status).toBe('NOT_TESTED');
    expect(harness.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    expect(harness.restoreDecision).toBeNull();
    expect(harness.calls.some(call => ['network.getData', 'network.provideResponse'].includes(call.method))).toBe(false);

    const invocations = scenario.reports.filter(report => report.event === 'provider-invoked');
    const physicalStarts = scenario.reports.filter(report => report.event === 'physical-start');
    const settlements = scenario.reports.filter(report => report.event === 'physical-settled');
    const parsers = scenario.reports.filter(report => report.event === 'parser-success');
    const providerSettlements = scenario.reports.filter(report => report.event === 'provider-settled');
    const queueAndConsume = async reports => {
      const firstSeq = progress.nextSequence();
      harness.queueOperationReports(reports);
      await progress.waitUntilReadCount(firstSeq + reports.length - 1);
    };
    const waitForCandidateWaitCount = count => {
      if (candidateWaitCount >= count) return Promise.resolve();
      return new Promise(resolve => {
        const listener = () => {
          if (candidateWaitCount < count) return;
          candidateWaits.removeListener('waiting', listener); resolve();
        };
        candidateWaits.on('waiting', listener);
        listener();
      });
    };
    const firstIndexes = scenario.batches[0].physical.sourceIndexes;
    await queueAndConsume([invocations.find(report => report.evidence.sourceIndexes.join(',') === firstIndexes.join(','))]);
    harness.queueOperationReports([physicalStarts.find(report => report.evidence.sourceIndexes.join(',') === firstIndexes.join(','))]);
    await waitForCandidateWaitCount(1);
    expect(finished).toBe(false);
    expect(harness.capabilities.providerConsumption.status).toBe('NOT_TESTED');
    expect(harness.restoreDecision).toBeNull();
    await harness.queueProviderRequests([scenario.requestEvents[0]]);
    const firstResponse = await provided.get('request-0').promise;
    expect(JSON.parse(firstResponse.body.value)).toEqual(mapEdgeResponse(scenario.batches[0].texts));
    for (const report of [
      settlements.find(report => report.evidence.attemptId === scenario.batches[0].attemptId),
      parsers.find(report => report.evidence.sourceIndexes.join(',') === firstIndexes.join(',')),
      providerSettlements.find(report => report.evidence.invocationId === invocations.find(item => item.evidence.sourceIndexes.join(',') === firstIndexes.join(',')).evidence.invocationId),
    ]) await queueAndConsume([report]);
    expect(finished).toBe(false);
    expect(harness.capabilities.providerConsumption.status).toBe('NOT_TESTED');
    expect(harness.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    const firstCoverage = harness.bridge.operationSnapshot().reports.filter(report => report.event === 'parser-success');
    expect(firstCoverage.map(report => report.evidence.sourceIndexes)).toEqual([firstIndexes]);
    expect(harness.restoreDecision).toBeNull();

    const secondIndexes = scenario.batches[1].physical.sourceIndexes;
    await queueAndConsume([invocations.find(report => report.evidence.sourceIndexes.join(',') === secondIndexes.join(','))]);
    harness.queueOperationReports([physicalStarts.find(report => report.evidence.sourceIndexes.join(',') === secondIndexes.join(','))]);
    await waitForCandidateWaitCount(2);
    await harness.queueProviderRequests([scenario.requestEvents[1]]);
    const secondResponse = await provided.get('request-1').promise;
    expect(JSON.parse(secondResponse.body.value)).toEqual(mapEdgeResponse(scenario.batches[1].texts));
    for (const report of [
      settlements.find(report => report.evidence.attemptId === scenario.batches[1].attemptId),
      parsers.find(report => report.evidence.sourceIndexes.join(',') === secondIndexes.join(',')),
      providerSettlements.find(report => report.evidence.invocationId === invocations.find(item => item.evidence.sourceIndexes.join(',') === secondIndexes.join(',')).evidence.invocationId),
    ]) await queueAndConsume([report]);
    expect(finished).toBe(false);
    expect(harness.capabilities.providerConsumption.status, JSON.stringify({ snapshot: harness.bridge.operationSnapshot(), calls: harness.calls, caps: harness.capabilities })).toBe('SUPPORTED');
    expect(harness.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    expect(harness.restoreDecision).toBeNull();
    const fullCoverage = harness.bridge.operationSnapshot().reports.filter(report => report.event === 'parser-success').flatMap(report => report.evidence.sourceIndexes);
    expect([...fullCoverage].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index));

    const translated = fixture.reports.find(report => report.event === 'translated');
    const translatedSeq = progress.nextSequence();
    harness.queueOperationReports([translated]);
    await progress.waitUntilReadCount(translatedSeq);
    expect(await restoreCalled.promise).toBe('restore');
    expect(finished).toBe(false);
    expect(harness.capabilities.domAcceptance.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    expect(harness.bridge.operationSnapshot().reports.some(report => report.event === 'restored')).toBe(false);

    harness.queueOperationReports([fixture.reports.find(report => report.event === 'restored')]);
    const state = await probe;
    expect(state.successfulCoverage.size).toBe(12);
    expect(harness.capabilities.providerRestore.status).toBe('SUPPORTED');
    expect(harness.calls.filter(call => call.method === 'network.provideResponse')).toHaveLength(2);
    expect(harness.restoreDecision).toBe('restore');
  });

  it('keeps an acknowledgment-only run FAILED with later evidence NOT_TESTED at its deadline', async () => {
    const harness = providerHarness({ manualOperationQueue: true });
    const progress = watchManualSnapshotProgress(harness.bridge);
    let finished = false;
    const probe = runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 150 })
      .finally(() => { finished = true; });
    await progress.waitUntilReadCount(1);
    harness.queueOperationReports([harness.reports.find(report => report.event === 'command-result')]);
    await progress.waitUntilReadCount(2);
    expect(finished).toBe(false);
    expect(harness.restoreDecision).toBeNull();
    const state = await probe;
    expect(state.stopCode).toBe('TIMEOUT');
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(harness.capabilities.providerConsumption.status).toBe('NOT_TESTED');
    expect(harness.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    expect(harness.calls.some(call => ['network.getData', 'network.provideResponse'].includes(call.method))).toBe(false);
    expect(harness.restoreDecision).toBeNull();
  });

  it('keeps authenticated rejected native physical proof unsupported without matching BiDi and leaves later phases NOT_TESTED', async () => {
    const fixture = providerReports();
    const harness = providerHarness({ manualOperationQueue: true });
    const progress = watchManualSnapshotProgress(harness.bridge);
    const candidateWait = new EventEmitter();
    let waitingForCandidate = false;
    const originalWait = harness.dispatcher.waitForProviderRequest.bind(harness.dispatcher);
    harness.dispatcher.waitForProviderRequest = (...args) => {
      waitingForCandidate = true;
      candidateWait.emit('waiting');
      return originalWait(...args);
    };
    const waitForCandidate = () => {
      if (waitingForCandidate) return Promise.resolve();
      return new Promise(resolve => {
        const listener = () => {
          if (!waitingForCandidate) return;
          candidateWait.removeListener('waiting', listener); resolve();
        };
        candidateWait.on('waiting', listener);
        listener();
      });
    };
    let finished = false;
    const probe = runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 180 })
      .finally(() => { finished = true; });
    await progress.waitUntilReadCount(1);
    harness.queueOperationReports([fixture.reports.find(report => report.event === 'command-result')]);
    await progress.waitUntilReadCount(2);
    harness.queueOperationReports([fixture.reports.find(report => report.event === 'provider-invoked')]);
    const invocationSeq = progress.nextSequence() - 1;
    await progress.waitUntilReadCount(invocationSeq);
    const physical = fixture.reports.find(report => report.event === 'physical-start');
    harness.queueOperationReports([physical]);
    await waitForCandidate();
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(finished).toBe(false);
    harness.queueOperationReports([{
      ...fixture.reports.find(report => report.event === 'physical-settled'),
      evidence: { attemptId: physical.evidence.attemptId, sessionId: physical.evidence.sessionId, outcome: 'rejected', status: null, code: 'NETWORK_ERROR' },
    }]);
    const state = await probe;
    expect(state.stopCode).toBe('INTERCEPTION_UNSUPPORTED');
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(harness.capabilities.backgroundProviderInterception.status).toBe('UNSUPPORTED');
    expect(harness.capabilities.providerConsumption.status).toBe('NOT_TESTED');
    expect(harness.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(harness.capabilities.providerRestore.status).toBe('NOT_TESTED');
    expect(state.attempts.get(physical.evidence.attemptId).settlement).toMatchObject({ outcome: 'rejected', code: 'NETWORK_ERROR' });
    expect(harness.calls.some(call => ['network.getData', 'network.provideResponse'].includes(call.method))).toBe(false);
    expect(harness.restoreDecision).toBeNull();
  });

  it('rejects an early acknowledgment bound to a different future provider session before providing a response', async () => {
    const fixture = providerReports(); const scenario = providerBatchScenario(fixture);
    const reports = placeCommandAcknowledgment(scenario.reports, 1, { sessionId: 'wrong-session' });
    const harness = providerHarness({ operationReports: reports, requestEvents: scenario.requestEvents, bodyByRequest: Object.fromEntries(scenario.batches.map((batch, index) => [`request-${index}`, { type: 'string', value: batch.body }])) });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(state.stopCode).toBe('PROTOCOL_ERROR');
    expect(harness.calls.some(call => call.method === 'network.provideResponse')).toBe(false);
    expect(harness.restoreDecision).toBeNull();
  });

  it.each([
    ['duplicate success', [{ success: true, sessionId: 'session-1', code: null }, { success: true, sessionId: 'session-1', code: null }]],
    ['contradictory result', [{ success: true, sessionId: 'session-1', code: null }, { success: false, sessionId: null, code: 'PROTOCOL_ERROR' }]],
  ])('fails a %s acknowledgment sequence without restoring', async (_label, acknowledgments) => {
    const fixture = providerReports(); const events = [fixture.reports[0], ...acknowledgments.map(evidence => ({ event: 'command-result', evidence }))];
    const operationReports = events.map((report, index) => ({ v: 1, runId: fixture.runId, op: 'edge-fr-page-once', opSeq: index + 1, event: report.event, evidence: report.evidence }));
    const harness = providerHarness({ operationReports, emitRequest: false });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(state.stopCode).toBe('PROTOCOL_ERROR');
    expect(harness.restoreDecision).toBeNull();
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('FAILED');
  });

  it('keeps a rejected first physical retry diagnostic-only when a later fulfilled attempt covers the invocation', async () => {
    const fixture = providerReports(); const scenario = providerRetryScenario(fixture);
    const harness = providerHarness({ operationReports: scenario.reports, requestEvents: scenario.requestEvents, bodyByRequest: scenario.bodyByRequest });
    harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 500 });
    expect(harness.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(state.attempts.get('retry-failed').settlement.outcome).toBe('rejected');
    expect(state.attempts.get('retry-success').successful).toBe(true);
    expect(state.successfulCoverage.size).toBe(12);
  });

  it('keeps authenticated protocol errors FAILED instead of downgrading them to unsupported interception', async () => {
    const fixture = providerReports(); const reports = fixture.reports.slice(0, 4);
    reports.push({ v: 1, runId: fixture.runId, op: 'edge-fr-page-once', opSeq: 5, event: 'error', evidence: { code: 'PROTOCOL_ERROR' } });
    const caps = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('not reached')]));
    caps.providerPhysicalRequest = capability('SUPPORTED');
    caps.backgroundProviderInterception = capability('UNSUPPORTED', { reason: 'No BiDi request.' });
    const state = { attempted: true, stopCode: 'INTERCEPTION_UNSUPPORTED' };
    const bridge = { operationSnapshot: () => ({ op: 'edge-fr-page-once', released: true, restoreDecision: null, stopped: true, stopCode: 'INTERCEPTION_UNSUPPORTED', reports, rejections: { originOrType: 0, protocol: 0 }, failure: { code: 'PROTOCOL_ERROR' } }) };
    const result = await reconcileFinalProviderOperation({ bridge, state, contract: { runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId }, capabilities: caps, artifact: {} });
    expect(result.ok).toBe(false);
    expect(caps.providerOperation.status).toBe('FAILED');
  });

  it('retains bounded, sanitized final telemetry rejection evidence while keeping the operation failed', async () => {
    const fixture = providerReports();
    const reports = fixture.reports;
    const lastRejection = {
      event: 'command-result', opSeq: 9, reason: 'EVENT_INVALID', released: true, armed: true, stopped: false,
      sessionMatchesAdmitted: true, invocationKnown: true, attemptKnown: false, codeKnown: true,
      code: 'PROTOCOL_ERROR', success: null, outcome: null,
    };
    const rawSnapshot = {
      op: 'edge-fr-page-once', released: true, restoreDecision: 'restore', stopped: true, stopCode: 'COMPLETED',
      reports, rejections: { originOrType: 0, protocol: 1 }, failure: null, lastRejection,
    };
    const bridge = { operationSnapshot: () => rawSnapshot };
    const caps = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('not reached')]));
    const artifact = {};
    const result = await reconcileFinalProviderOperation({ bridge, state: { attempted: true, stopCode: 'COMPLETED' }, contract: { runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId }, capabilities: caps, artifact });
    expect(result.ok).toBe(false);
    expect(caps.providerOperation.status).toBe('FAILED');
    expect(artifact.providerOperation.finalSnapshot).toMatchObject({ available: true, rejections: { protocol: 1 }, lastRejection: { event: 'command-result', opSeq: 9, reason: 'EVENT_INVALID', released: true, armed: true, stopped: false, sessionMatchesAdmitted: true, invocationKnown: true, attemptKnown: false, codeKnown: true, code: 'PROTOCOL_ERROR' } });
    expect(JSON.stringify(artifact.providerOperation.finalSnapshot)).not.toContain(fixture.bodyText);

    const oversized = { ...rawSnapshot, op: 'o'.repeat(70000), untrustedMetadata: 'credential-source', reports: Array.from({ length: 64 }, (_, index) => ({ ...reports[0], opSeq: index + 1, evidence: { unexpectedPayload: 'x'.repeat(2048) } })) };
    const boundedArtifact = {};
    await reconcileFinalProviderOperation({ bridge: { operationSnapshot: () => oversized }, state: { attempted: true, stopCode: 'COMPLETED' }, contract: { runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId }, capabilities: caps, artifact: boundedArtifact });
    expect(Buffer.byteLength(JSON.stringify(boundedArtifact.providerOperation.finalSnapshot))).toBeLessThanOrEqual(65536);
    expect(boundedArtifact.providerOperation.finalSnapshot.rejections.protocol).toBe(1);
    expect(boundedArtifact.providerOperation.finalSnapshot.op).toBeNull();
    expect(JSON.stringify(boundedArtifact.providerOperation.finalSnapshot)).not.toContain('credential-source');
    expect(JSON.stringify(boundedArtifact.providerOperation.finalSnapshot)).not.toContain('unexpectedPayload');
  });

  it('validates only the Edge fr endpoint and hashes bounded request bytes against fixture indexes', () => {
    const fixture = providerReports();
    expect(validEdgePageTranslateUrl(fixture.url)).toBe(true);
    expect(validEdgePageTranslateUrl(`${fixture.url}&from=en`)).toBe(true);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com:444/translate/translatetext?to=fr&isEnterpriseClient=false')).toBe(false);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com/translate/translatetext?to=fr&to=fr&isEnterpriseClient=false')).toBe(false);
    expect(validEdgePageTranslateUrl('https://edge.microsoft.com/translate/translatetext?to=de&isEnterpriseClient=false')).toBe(false);
    const decoded = decodeEdgeRequestBody({ type: 'base64', value: fixture.bytes.toString('base64') });
    expect(validateEdgeBodyAgainstNative(decoded, fixture.physical, fixture.texts).sourceIndexes).toEqual(fixture.invocation.sourceIndexes);
    expect(() => decodeEdgeRequestBody({ type: 'base64', value: 'bad base64!' })).toThrow(/base64/);
    expect(() => decodeEdgeRequestBody({ type: 'string', value: JSON.stringify([fixture.texts[0], fixture.texts[0]]) })).toThrow(/unique/);
    expect(() => validateEdgeProviderCorrelation(fixture.invocation, fixture.physical, { requestId: 'request', url: fixture.url, method: 'POST', isBlocked: false })).toThrow(/identity/);
  });

  it('sets up the documented request-body collector but continues when the API is unsupported', async () => {
    const setup = {}; let request;
    await expect(setupProviderDataCollector({ command: async (method, params) => {
      request = { method, params }; throw Object.assign(new Error('missing BiDi method'), { code: 'unknown command' });
    } }, setup)).resolves.toBeNull();
    expect(request).toEqual({ method: 'network.addDataCollector', params: { collectorType: 'blob', dataTypes: ['request'], maxEncodedDataSize: 65536 } });
    expect(setup.providerDataCollector.status).toBe('UNSUPPORTED');
  });

  it('proves actual native request, interception, response consumption, DOM acceptance, and restore', async () => {
    const harness = providerHarness(); harness.capabilities.providerDataCollector = capability('SUPPORTED');
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector-1', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 30 });
    for (const name of ['providerPhysicalRequest', 'backgroundProviderInterception', 'providerRequestBody', 'providerResponse', 'providerConsumption', 'domAcceptance', 'providerRestore']) expect(harness.capabilities[name].status).toBe('SUPPORTED');
    expect(harness.restoreDecision).toBe('restore'); expect(state.stopCode).toBe('COMPLETED');
    const response = harness.calls.find(call => call.method === 'network.provideResponse');
    expect(response.params).toMatchObject({ statusCode: 200, reasonPhrase: 'OK', body: { type: 'string' } });
    expect(JSON.parse(response.params.body.value)).toEqual(mapEdgeResponse(harness.texts));
    expect(JSON.stringify(providerProbeArtifact(state))).not.toContain(harness.bodyText);
    const final = await reconcileFinalProviderOperation({ bridge: harness.bridge, state, contract: { runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId }, capabilities: harness.capabilities, artifact: {} });
    expect(final.ok).toBe(true); expect(harness.capabilities.providerOperation.status).toBe('SUPPORTED');
  });

  it('accepts final Provider proof through the loopback proxy without requiring BiDi body collection', async () => {
    const fixture = providerReports();
    const capabilities = Object.fromEntries(requiredCapabilities.map(name => [name, notTested('not reached')]));
    for (const name of ['loopbackTlsProxy', 'providerPhysicalRequest', 'providerRequestBody', 'providerResponse', 'providerConsumption', 'domAcceptance', 'providerRestore']) {
      capabilities[name] = capability('SUPPORTED');
    }
    const bridge = { operationSnapshot: () => ({ op: 'edge-fr-page-once', released: true, restoreDecision: 'restore', stopped: true,
      stopCode: 'COMPLETED', reports: fixture.reports, rejections: { originOrType: 0, protocol: 0 }, failure: null }) };

    const result = await reconcileFinalProviderOperation({
      bridge, state: { attempted: true, providerOnly: false, receiptDecision: 'start', stopCode: 'COMPLETED' },
      contract: { runId: fixture.runId, extensionId: fixture.extensionId, fixtureUrl: fixture.fixtureUrl, tabId: fixture.tabId },
      capabilities, artifact: {},
    });

    expect(result.ok).toBe(true);
    expect(capabilities.providerOperation.status).toBe('SUPPORTED');
    expect(capabilities.backgroundProviderInterception.status).toBe('NOT_TESTED');
    expect(capabilities.providerDataCollector.status).toBe('NOT_TESTED');
  });

  it('fails physical proof with no native start and preserves native proof when BiDi cannot see the request', async () => {
    const noNative = providerHarness({ omitEvent: 'physical-start' });
    const failed = await runEdgeFrenchProviderProbe({ bridge: noNative.bridge, bidi: noNative.fakeBidi, dispatcher: noNative.dispatcher, collectorId: 'collector', fixtureTexts: noNative.texts, runId: noNative.runId, extensionId: noNative.extensionId, fixtureUrl: noNative.fixtureUrl, tabId: noNative.tabId, capabilities: noNative.capabilities, timeoutMs: 5 });
    expect(noNative.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(noNative.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(failed.stopCode).toBe('TIMEOUT');

    const noBiDi = providerHarness({ emitRequest: false, physicalOutcome: 'rejected' });
    const unsupported = await runEdgeFrenchProviderProbe({ bridge: noBiDi.bridge, bidi: noBiDi.fakeBidi, dispatcher: noBiDi.dispatcher, collectorId: 'collector', fixtureTexts: noBiDi.texts, runId: noBiDi.runId, extensionId: noBiDi.extensionId, fixtureUrl: noBiDi.fixtureUrl, tabId: noBiDi.tabId, capabilities: noBiDi.capabilities, timeoutMs: 250 });
    expect(noBiDi.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(noBiDi.capabilities.backgroundProviderInterception.status).toBe('UNSUPPORTED');
    expect(noBiDi.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(unsupported.physicalSettlement.evidence.code).toBe('NETWORK_ERROR');
  });

  it('fails visible unpaused, wrong-identity, invalid-body, and failed-response paths closed', async () => {
    const unpaused = providerHarness({ requestBlocked: false });
    const unpausedState = await runEdgeFrenchProviderProbe({ bridge: unpaused.bridge, bidi: unpaused.fakeBidi, dispatcher: unpaused.dispatcher, collectorId: 'collector', fixtureTexts: unpaused.texts, runId: unpaused.runId, extensionId: unpaused.extensionId, fixtureUrl: unpaused.fixtureUrl, tabId: unpaused.tabId, capabilities: unpaused.capabilities, timeoutMs: 30 });
    expect(unpaused.capabilities.backgroundProviderInterception.status).toBe('FAILED');
    expect(unpaused.calls.some(call => call.method === 'network.continueRequest')).toBe(false);
    expect(unpausedState.stopCode).toBe('PROTOCOL_ERROR');

    const wrongIdentity = providerHarness({ requestUrl: `${providerHarness().url}&from=en` });
    const identityState = await runEdgeFrenchProviderProbe({ bridge: wrongIdentity.bridge, bidi: wrongIdentity.fakeBidi, dispatcher: wrongIdentity.dispatcher, collectorId: 'collector', fixtureTexts: wrongIdentity.texts, runId: wrongIdentity.runId, extensionId: wrongIdentity.extensionId, fixtureUrl: wrongIdentity.fixtureUrl, tabId: wrongIdentity.tabId, capabilities: wrongIdentity.capabilities, timeoutMs: 30 });
    expect(wrongIdentity.capabilities.backgroundProviderInterception.status).toBe('FAILED');
    expect(wrongIdentity.calls.some(call => call.method === 'network.failRequest')).toBe(true);
    expect(identityState.stopCode).toBe('PROTOCOL_ERROR');

    const bodyBad = providerHarness({ bodyText: JSON.stringify(['invented source']) });
    const bodyState = await runEdgeFrenchProviderProbe({ bridge: bodyBad.bridge, bidi: bodyBad.fakeBidi, dispatcher: bodyBad.dispatcher, collectorId: 'collector', fixtureTexts: bodyBad.texts, runId: bodyBad.runId, extensionId: bodyBad.extensionId, fixtureUrl: bodyBad.fixtureUrl, tabId: bodyBad.tabId, capabilities: bodyBad.capabilities, timeoutMs: 30 });
    expect(bodyBad.capabilities.providerRequestBody.status).toBe('FAILED');
    expect(bodyBad.calls.some(call => call.method === 'network.provideResponse')).toBe(false);
    expect(bodyState.stopCode).toBe('INVALID_BODY');

    const responseBad = providerHarness({ responseError: { code: 'invalid argument', message: 'response rejected' } });
    const responseState = await runEdgeFrenchProviderProbe({ bridge: responseBad.bridge, bidi: responseBad.fakeBidi, dispatcher: responseBad.dispatcher, collectorId: 'collector', fixtureTexts: responseBad.texts, runId: responseBad.runId, extensionId: responseBad.extensionId, fixtureUrl: responseBad.fixtureUrl, tabId: responseBad.tabId, capabilities: responseBad.capabilities, timeoutMs: 30 });
    expect(responseBad.capabilities.providerResponse.status).toBe('FAILED');
    expect(responseState.stopCode).toBe('PROTOCOL_ERROR');
  });

  it('marks body unsupported only after an intercepted native request and never infers consumption from ACK alone', async () => {
    const bodyMissing = providerHarness();
    const missingState = await runEdgeFrenchProviderProbe({ bridge: bodyMissing.bridge, bidi: bodyMissing.fakeBidi, dispatcher: bodyMissing.dispatcher, collectorId: null, fixtureTexts: bodyMissing.texts, runId: bodyMissing.runId, extensionId: bodyMissing.extensionId, fixtureUrl: bodyMissing.fixtureUrl, tabId: bodyMissing.tabId, capabilities: bodyMissing.capabilities, timeoutMs: 30 });
    expect(bodyMissing.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(bodyMissing.capabilities.backgroundProviderInterception.status).toBe('SUPPORTED');
    expect(bodyMissing.capabilities.providerRequestBody.status).toBe('UNSUPPORTED');
    expect(missingState.stopCode).toBe('BODY_UNSUPPORTED');

    const notConsumed = providerHarness({ physicalOutcome: 'rejected' });
    const notConsumedState = await runEdgeFrenchProviderProbe({ bridge: notConsumed.bridge, bidi: notConsumed.fakeBidi, dispatcher: notConsumed.dispatcher, collectorId: 'collector', fixtureTexts: notConsumed.texts, runId: notConsumed.runId, extensionId: notConsumed.extensionId, fixtureUrl: notConsumed.fixtureUrl, tabId: notConsumed.tabId, capabilities: notConsumed.capabilities, timeoutMs: 250 });
    expect(notConsumed.capabilities.providerResponse.status).toBe('SUPPORTED');
    expect(notConsumed.capabilities.providerConsumption.status).toBe('FAILED');
    expect(notConsumed.capabilities.domAcceptance.status).toBe('NOT_TESTED');
    expect(notConsumedState.stopCode).toBe('TIMEOUT');
  });

  it('classifies no-such-network-data as body UNSUPPORTED only after the exact request was intercepted', async () => {
    const harness = providerHarness({ bodyError: { code: 'no such network data', message: 'body absent' } });
    const state = await runEdgeFrenchProviderProbe({ bridge: harness.bridge, bidi: harness.fakeBidi, dispatcher: harness.dispatcher, collectorId: 'collector', fixtureTexts: harness.texts, runId: harness.runId, extensionId: harness.extensionId, fixtureUrl: harness.fixtureUrl, tabId: harness.tabId, capabilities: harness.capabilities, timeoutMs: 30 });
    expect(harness.capabilities.providerPhysicalRequest.status).toBe('SUPPORTED');
    expect(harness.capabilities.backgroundProviderInterception.status).toBe('SUPPORTED');
    expect(harness.capabilities.providerRequestBody.status).toBe('UNSUPPORTED');
    expect(harness.calls.find(call => call.method === 'network.failRequest')).toBeDefined();
    expect(state.stopCode).toBe('BODY_UNSUPPORTED');
  });

  it('rejects a native physical session mismatch and a production command response from the wrong session', async () => {
    const physicalMismatch = providerHarness({ physicalSession: 'other-session' });
    const physicalState = await runEdgeFrenchProviderProbe({ bridge: physicalMismatch.bridge, bidi: physicalMismatch.fakeBidi, dispatcher: physicalMismatch.dispatcher, collectorId: 'collector', fixtureTexts: physicalMismatch.texts, runId: physicalMismatch.runId, extensionId: physicalMismatch.extensionId, fixtureUrl: physicalMismatch.fixtureUrl, tabId: physicalMismatch.tabId, capabilities: physicalMismatch.capabilities, timeoutMs: 30 });
    expect(physicalMismatch.capabilities.providerPhysicalRequest.status).toBe('FAILED');
    expect(physicalMismatch.capabilities.providerRequestBody.status).toBe('NOT_TESTED');
    expect(physicalState.stopCode).toBe('PROTOCOL_ERROR');

    const commandMismatch = providerHarness({ commandSession: 'other-session' });
    const commandState = await runEdgeFrenchProviderProbe({ bridge: commandMismatch.bridge, bidi: commandMismatch.fakeBidi, dispatcher: commandMismatch.dispatcher, collectorId: 'collector', fixtureTexts: commandMismatch.texts, runId: commandMismatch.runId, extensionId: commandMismatch.extensionId, fixtureUrl: commandMismatch.fixtureUrl, tabId: commandMismatch.tabId, capabilities: commandMismatch.capabilities, timeoutMs: 30 });
    expect(commandMismatch.capabilities.providerConsumption.status).toBe('SUPPORTED');
    expect(commandMismatch.capabilities.domAcceptance.status).toBe('FAILED');
    expect(commandMismatch.restoreDecision).toBeNull();
    expect(commandState.stopCode).toBe('PROTOCOL_ERROR');
  });

  it('does not restore after duplicate/stale DOM evidence and retains an actual restore failure', async () => {
    const duplicate = providerHarness({ badTranslated: true });
    const duplicateState = await runEdgeFrenchProviderProbe({ bridge: duplicate.bridge, bidi: duplicate.fakeBidi, dispatcher: duplicate.dispatcher, collectorId: 'collector', fixtureTexts: duplicate.texts, runId: duplicate.runId, extensionId: duplicate.extensionId, fixtureUrl: duplicate.fixtureUrl, tabId: duplicate.tabId, capabilities: duplicate.capabilities, timeoutMs: 30 });
    expect(duplicate.capabilities.domAcceptance.status).toBe('FAILED');
    expect(duplicate.restoreDecision).toBeNull();
    expect(duplicateState.stopCode).toBe('PROTOCOL_ERROR');

    const restore = providerHarness({ restoreFailure: true });
    const restoreState = await runEdgeFrenchProviderProbe({ bridge: restore.bridge, bidi: restore.fakeBidi, dispatcher: restore.dispatcher, collectorId: 'collector', fixtureTexts: restore.texts, runId: restore.runId, extensionId: restore.extensionId, fixtureUrl: restore.fixtureUrl, tabId: restore.tabId, capabilities: restore.capabilities, timeoutMs: 30 });
    expect(restore.restoreDecision).toBe('restore');
    expect(restore.capabilities.providerRestore.status).toBe('FAILED');
    expect(restoreState.stopCode).toBe('TIMEOUT');
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

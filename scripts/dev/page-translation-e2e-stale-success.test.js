// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSuccessfulReplyGate } from './page-translation-e2e-benchmark/successful-reply-gate.mjs';
import { createSuccessfulReplyBoundaryPlugin } from './page-translation-e2e-benchmark/build.mjs';
import {
  createRawDOMMutationEvidence,
  createWorkerNetworkEventRouter,
  classifyStaleSuccessProviderOwner,
  gateCleanupDisposition,
  installSuccessfulReplyProbe,
  parseSuccessfulReplyProbeSelection,
  resolveCleanupSessionEvidence,
  validateReplacementDiscoverySnapshot,
  validateCleanupInvalidation,
  validateReplacementStability,
  validateRawDOMMutationEvidence,
  validateRuntimeResources,
  validateWorkerNetworkCompletion,
  validateStaleSuccessEvidence,
  validateSuccessfulReplyCapture,
  teardownSuccessfulReplyGate,
} from './page-translation-e2e-benchmark/successful-reply-probes.mjs';

const schedulerBoundary = vi.hoisted(() => {
  const runtime = { sendMessage: vi.fn() };
  return {
    runtime,
    safeSendMessage: vi.fn((...args) => runtime.sendMessage(...args)),
    sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
  };
});

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { ...schedulerBoundary.runtime, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: { local: { get: vi.fn(), set: vi.fn() }, sync: { get: vi.fn(), set: vi.fn() } },
  },
}));
vi.mock('@/core/extensionContext.js', () => ({
  default: { safeSendMessage: vi.fn(), isValidSync: vi.fn(() => true), isContextError: vi.fn(() => false), handleContextError: vi.fn() },
}));
vi.mock('@/features/translation/core/ProviderConfigurations.js', () => ({ getProviderConfiguration: vi.fn(() => ({})) }));
vi.mock('@/features/page-translation/utils/PageTranslationQueueFilter.js', () => ({ PageTranslationQueueFilter: { process: vi.fn() } }));
vi.mock('@/features/page-translation/utils/PageTranslationFluidFilter.js', () => ({ PageTranslationFluidFilter: { process: vi.fn() } }));
vi.mock('@/features/page-translation/PageTranslationHelper.js', () => ({
  PageTranslationHelper: { shouldTranslate: vi.fn(() => true), getNearestSemanticContainer: vi.fn(() => null) },
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), init: vi.fn(), debugLazy: vi.fn() })),
}));
vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({ isFatalError: vi.fn(() => false), matchErrorToType: vi.fn(() => 'UNKNOWN') }));
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: schedulerBoundary.safeSendMessage,
  sendRegularMessage: schedulerBoundary.sendRegularMessage,
}));
vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'en'),
  getWholePageMaxCharsAsync: vi.fn(async () => 50_000),
  getWholePageAiMaxCharsAsync: vi.fn(async () => 50_000),
}));

import { PageTranslationScheduler } from '@/features/page-translation/PageTranslationScheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('successful stale Page reply probe', () => {
  it('parses only explicit isolated stale-success cases', () => {
    expect(parseSuccessfulReplyProbeSelection()).toEqual([]);
    expect(parseSuccessfulReplyProbeSelection('replacement,stop,restore')).toEqual(['replacement', 'stop', 'restore']);
    expect(() => parseSuccessfulReplyProbeSelection('stop,stop')).toThrow('Duplicate');
    expect(() => parseSuccessfulReplyProbeSelection('unknown')).toThrow('Unsupported');
  });

  it('transforms only the exact opt-in Page safeSendMessage await boundary and fails on source drift', () => {
    const plugin = createSuccessfulReplyBoundaryPlugin();
    const schedulerId = '/repo/src/features/page-translation/PageTranslationScheduler.js';
    const source = [
      "import { sendRegularMessage, safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';",
      "const result = await safeSendMessage(batchMessage, 'page-translation-batch');",
    ].join('\n');
    expect(plugin.transform(source, '/repo/src/other/Worker.js')).toBeNull();
    const transformed = plugin.transform(source, schedulerId);
    expect(transformed.code).toContain('safeSendMessage as benchmarkProductionSafeSendMessage');
    expect(transformed.code).toContain('intercept.call(globalThis.__pageTranslationBenchmark, args[0], sourcePromise)');
    expect(transformed.code).toContain("const result = await safeSendMessage(batchMessage, 'page-translation-batch');");
    expect(plugin.assertApplied()).toEqual([schedulerId]);

    const drifted = createSuccessfulReplyBoundaryPlugin();
    expect(() => drifted.transform(source.replace('safeSendMessage(batchMessage', 'sendMessage(batchMessage'), schedulerId))
      .toThrow('boundary drifted');
    expect(() => createSuccessfulReplyBoundaryPlugin().assertApplied()).toThrow('found 0');
  });

  it('pins the opt-in build shim to the actual safeSendMessage import and awaited Page batch call', () => {
    const plugin = createSuccessfulReplyBoundaryPlugin();
    const schedulerId = '/repo/src/features/page-translation/PageTranslationScheduler.js';
    const source = [
      "import { sendRegularMessage, safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';",
      "const result = await safeSendMessage(batchMessage, 'page-translation-batch');",
    ].join('\n');
    expect(plugin.transform(source, '/repo/src/other/Worker.js')).toBeNull();
    const transformed = plugin.transform(source, schedulerId);
    expect(transformed.code).toContain('safeSendMessage as benchmarkProductionSafeSendMessage');
    expect(transformed.code).toContain('intercept.call(globalThis.__pageTranslationBenchmark, args[0], sourcePromise)');
    expect(transformed.code).toContain("const result = await safeSendMessage(batchMessage, 'page-translation-batch');");
    expect(plugin.assertApplied()).toEqual([schedulerId]);

    const drifted = createSuccessfulReplyBoundaryPlugin();
    expect(() => drifted.transform(source.replace('safeSendMessage(batchMessage', 'sendMessage(batchMessage'), schedulerId))
      .toThrow('boundary drifted');
    expect(() => createSuccessfulReplyBoundaryPlugin().assertApplied()).toThrow('found 0');
  });

  it('holds only the first exact successful Page reply and observes the real stale ownership guard', async () => {
    const source = deferred();
    const captured = deferred();
    const calls = [];
    const runtime = {
      sendMessage(message, callback) {
        calls.push({ receiver: this, message, callback });
        return source.promise;
      },
    };
    const originalSend = runtime.sendMessage;
    const context = Symbol('scheduler-session-A');
    const scheduler = {
      translationSessionId: 'session-A',
      sessionContext: context,
      _executeBatchRequest(batch, config, flushContext, sessionId) {
        const message = {
          action: 'page-translate-batch', messageId: 'batch-A',
          data: { sessionId, text: JSON.stringify(batch) },
        };
        return runtime.sendMessage(message, 'callback-arg').then(response => ({ response, owns: this._ownsFlushSession(sessionId, flushContext) }));
      },
      _ownsFlushSession() { return false; },
    };
    const probe = installSuccessfulReplyProbe({
      runtime, scheduler, timeoutMs: 1_000,
      gateFactory: options => {
        return createSuccessfulReplyGate({ ...options, onEvent: event => {
          options.onEvent(event);
          if (event.type === 'captured') captured.resolve();
        } });
      },
    });
    probe.arm();
    const messageBatch = [{ id: 'target-1', text: 'source text' }];
    const promise = scheduler._executeBatchRequest(messageBatch, {}, context, 'session-A');
    const response = { success: true, translatedText: 'genuine source response' };
    source.resolve(response);
    await captured.promise;
    const preRelease = probe.snapshot();
    expect(preRelease.gate).toMatchObject({ status: 'captured', captured: true, released: false, settled: false, pending: true });
    const capture = validateSuccessfulReplyCapture({
      expectedSessionId: 'session-A', selectedBatch: preRelease.selectedBatch,
      capturedMessage: preRelease.capturedMessage, gateSnapshot: preRelease.gate,
    });
    expect(capture).toMatchObject({ ok: true, issues: [] });
    expect(probe.release()).toBe(true);
    const result = await promise;
    expect(result).toEqual({ response, owns: false });
    expect(result.response).toBe(response);
    expect(calls).toEqual([{ receiver: runtime, message: expect.objectContaining({ messageId: 'batch-A' }), callback: 'callback-arg' }]);
    const afterRelease = probe.snapshot();
    expect(afterRelease.staleGuard).toMatchObject({ sessionId: 'session-A', messageId: 'batch-A', ownsSession: false, afterRelease: true });
    expect(afterRelease.guardDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      sessionId: 'session-A', messageId: 'batch-A', contextMapLookupMatched: true,
      executionStackContainsSelected: false, inFlightExecutionCount: 1, exactSelectedExecution: true,
    })]));
    expect(afterRelease.guardInstallations).toEqual(expect.arrayContaining([expect.objectContaining({
      selectedSessionId: 'session-A', ownWrapperRetained: true, currentMethodName: 'wrapped',
    })]));
    expect(afterRelease.gate).toMatchObject({ status: 'released', released: true, settled: true, pending: false, success: true });
    probe.close();
    expect(runtime.sendMessage).toBe(originalSend);
    expect(scheduler._ownsFlushSession()).toBe(false);
  });

  it('preserves a successful reply but exposes missing live guard calls instead of fabricating stale evidence', async () => {
    const source = deferred();
    const captured = deferred();
    const runtime = { sendMessage: vi.fn(() => source.promise) };
    const context = Symbol('selected-context');
    const scheduler = {
      translationSessionId: 'A', sessionContext: context,
      _executeBatchRequest(batch, _config, flushContext, sessionId) {
        return runtime.sendMessage({
          action: 'page-translate-batch', messageId: 'batch-without-guard',
          data: { sessionId, text: JSON.stringify(batch) },
        });
      },
      _ownsFlushSession() { throw new Error('original guard was not expected to run'); },
    };
    const probe = installSuccessfulReplyProbe({
      runtime, scheduler,
      gateFactory: options => createSuccessfulReplyGate({
        ...options,
        onEvent: event => { options.onEvent(event); if (event.type === 'captured') captured.resolve(); },
      }),
    });
    probe.arm();
    const execution = scheduler._executeBatchRequest([{ id: 'target-1', text: 'source' }], {}, context, 'A');
    source.resolve({ success: true, translatedText: 'original-response' });
    await captured.promise;
    expect(probe.release()).toBe(true);
    await expect(execution).resolves.toMatchObject({ success: true, translatedText: 'original-response' });
    const snapshot = probe.snapshot();
    expect(snapshot.guardDiagnostics).toEqual([]);
    expect(snapshot.staleGuard).toBeNull();
    expect(validateStaleSuccessEvidence({
      gate: { ...snapshot.gate, releaseOrder: 2 },
      invalidation: { confirmed: true, order: 1 },
      batch: { sessionId: 'A', messageId: 'batch-without-guard' },
      guard: snapshot.staleGuard,
      acceptedAIds: [], expectedIds: [], acceptedBIds: [], domValues: [],
      schedulerBatchSettled: true, postInvalidationOk: true, domNoUnexpectedWrites: true, bStateStable: true,
    }).ok).toBe(false);
    probe.close();
  });

  it('installs on the scheduler prototype before construction and captures the real Symbol-owned batch', async () => {
    const source = deferred();
    const captured = deferred();
    schedulerBoundary.runtime.sendMessage.mockReturnValue(source.promise);
    let safeSendSucceeded = false;
    let probe;
    schedulerBoundary.safeSendMessage.mockImplementation((message, ...args) => {
      const safeSendPromise = schedulerBoundary.runtime.sendMessage(message, ...args).then(response => {
        safeSendSucceeded = true;
        return response;
      });
      return probe.interceptSchedulerBatchReply(message, safeSendPromise);
    });
    const originalPrototypeExecute = PageTranslationScheduler.prototype._executeBatchRequest;
    const originalPrototypeGuard = PageTranslationScheduler.prototype._ownsFlushSession;
    probe = installSuccessfulReplyProbe({
      scheduler: PageTranslationScheduler.prototype,
      gateFactory: options => createSuccessfulReplyGate({
        ...options,
        onEvent: event => { options.onEvent(event); if (event.type === 'captured') captured.resolve(); },
      }),
    });
    probe.arm();
    const scheduler = new PageTranslationScheduler();
    const contextA = Symbol('real-page-session-context');
    scheduler.setTranslationState(true, 'real-session-A', contextA);
    const item = { id: 'target-real', text: 'source', settled: false, resolve: vi.fn() };
    scheduler._trackBatch([item]);
    const execution = scheduler._executeBatchRequest([item], { providerRegistryId: 'google', targetLanguage: 'en' }, contextA, 'real-session-A');
    source.resolve({ success: true, translatedText: JSON.stringify([{ id: item.id, text: 'translated' }]) });
    await captured.promise;
    expect(safeSendSucceeded).toBe(true);
    const capture = probe.snapshot();
    expect(capture.selectedBatch).toMatchObject({ ownerSessionId: 'real-session-A', contextOwned: true });
    expect(capture.capturedMessage.members).toEqual([{ id: item.id, text: item.text }]);
    scheduler.stop();
    expect(probe.release()).toBe(true);
    await execution;
    expect(probe.snapshot().staleGuard).toMatchObject({ sessionId: 'real-session-A', ownsSession: false, afterRelease: true });
    expect(probe.snapshot().guardDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      sessionId: 'real-session-A', messageId: capture.capturedMessage.messageId,
      contextMapLookupMatched: true, selectedBatchTrackedAtEntry: true, exactSelectedExecution: true,
    })]));
    expect(probe.snapshot().guardInstallations).toEqual(expect.arrayContaining([expect.objectContaining({
      selectedSessionId: 'real-session-A', ownPropertyBeforeInstall: false, ownWrapperRetained: true,
    })]));
    expect(item.resolve.mock.calls[0][0].state).toBe('cancelled');
    probe.close();
    expect(Object.hasOwn(scheduler, '_ownsFlushSession')).toBe(false);
    expect(PageTranslationScheduler.prototype._executeBatchRequest).toBe(originalPrototypeExecute);
    expect(PageTranslationScheduler.prototype._ownsFlushSession).toBe(originalPrototypeGuard);
  });

  it('fails closed when release, exact ownership guard, batch settlement, or B-isolation evidence is absent', () => {
    const gate = {
      descriptor: { sessionId: 'A', messageId: 'm-A' }, status: 'released', captured: true, released: true,
      settled: true, success: true, error: null, releaseOrder: 3,
      events: [{ type: 'captured', sequence: 1 }, { type: 'released', sequence: 2 }, { type: 'settled', sequence: 3 }],
      deliveryIdentity: { responseIdentityPreserved: true },
    };
    const batch = { sessionId: 'A', messageId: 'm-A' };
    const valid = {
      gate, invalidation: { confirmed: true, order: 2 },
      guard: { observed: true, sessionId: 'A', messageId: 'm-A', ownsSession: false, afterRelease: true }, batch,
      acceptedAIds: [], acceptedBIds: [], expectedIds: [], domValues: [], bStillPending: true,
      schedulerBatchSettled: true, postInvalidationOk: true, domNoUnexpectedWrites: true, bStateStable: true,
    };
    expect(validateStaleSuccessEvidence(valid)).toMatchObject({ ok: true, issues: [] });
    expect(validateStaleSuccessEvidence({ ...valid, guard: null }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, bStillPending: false }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, acceptedAIds: ['target-1'] }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, lateLifecycle: [{ action: 'page-translate-complete' }] }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, batch: { ...batch, messageId: 'other' } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, gate: { ...gate, releaseOrder: 2 } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, gate: { ...gate, error: 'timeout' } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, gate: { ...gate, deliveryIdentity: { responseIdentityPreserved: false } } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, guard: { ...valid.guard, messageId: 'wrong' } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, invalidation: { confirmed: true, order: 4 } }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, schedulerBatchSettled: false }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, postInvalidationOk: false }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, domNoUnexpectedWrites: false }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...valid, bStateStable: false }).ok).toBe(false);
    const full = { ...valid, expectedIds: ['target-1', 'target-2'], acceptedBIds: ['target-1', 'target-2'], domValues: [['target-1', 'B'], ['target-2', 'B']] };
    expect(validateStaleSuccessEvidence(full).ok).toBe(true);
    expect(validateStaleSuccessEvidence({ ...full, acceptedBIds: ['target-1', 'target-1'] }).ok).toBe(false);
    expect(validateStaleSuccessEvidence({ ...full, domValues: [['target-1', 'B']] }).ok).toBe(false);
  });

  it('fails closed when any actual runtime resource snapshot is unavailable or leaked', () => {
    const valid = {
      available: true,
      lifecycle: { activeIds: ['batch-B'] },
      service: {
        activeRequestIds: ['batch-B'],
        requests: [
          { messageId: 'batch-A', status: 'completed', operationOwned: false },
          { messageId: 'batch-B', status: 'pending', operationOwned: true },
        ],
      },
      sourceResolvers: { A: { present: false }, B: { present: true } },
      queue: { depths: { edge: 0 }, processing: { edge: true }, retryTimeoutCount: 0 },
      rateLimit: { edge: { activeRequests: 1, queuedRequests: 0, isProcessingQueue: true } },
      lease: { activeOperationIds: ['batch-B'], activeOperationCount: 1, timerActive: true },
    };
    expect(validateRuntimeResources(valid, { activeMessageId: 'batch-B', terminalMessageIds: ['batch-A'], sessionIds: ['A', 'B'] }).ok).toBe(true);
    expect(validateRuntimeResources({ ...valid, queue: null }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    expect(validateRuntimeResources({ ...valid, rateLimit: null }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    expect(validateRuntimeResources({ ...valid, lifecycle: { activeIds: null } }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    expect(validateRuntimeResources({ ...valid, lease: null }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    expect(validateRuntimeResources({ ...valid, lease: { ...valid.lease, activeOperationCount: 0 } }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    expect(validateRuntimeResources({ ...valid, lease: { activeOperationIds: [], activeOperationCount: 0, timerActive: false } }, { activeMessageId: 'batch-B' }).ok).toBe(false);
    const drained = {
      ...valid,
      available: true,
      lifecycle: { activeIds: [] },
      service: { activeRequestIds: [], requests: [
        { messageId: 'batch-A', status: 'completed', operationOwned: false },
        { messageId: 'batch-B', status: 'completed', operationOwned: false },
      ] },
      sourceResolvers: { A: { present: false }, B: { present: false } },
      queue: { depths: { edge: 0 }, processing: { edge: false }, retryTimeoutCount: 0 },
      rateLimit: { edge: { activeRequests: 0, queuedRequests: 0, isProcessingQueue: false } },
      lease: { activeOperationIds: [], activeOperationCount: 0, timerActive: false },
    };
    expect(validateRuntimeResources(drained, { terminalMessageIds: ['batch-A', 'batch-B'], sessionIds: ['A', 'B'], final: true }).ok).toBe(true);
    expect(validateRuntimeResources({ ...drained, queue: null }, { terminalMessageIds: ['batch-A', 'batch-B'], sessionIds: ['A', 'B'], final: true }).ok).toBe(false);
  });

  it('routes Network events from a later test worker without borrowing the first worker session', () => {
    const recorded = [];
    const router = createWorkerNetworkEventRouter(event => recorded.push(event));
    const listeners = new Map();
    const attachWorker = (sessionId, targetId) => {
      expect(router.register(sessionId, { type: 'service_worker', targetId, url: `chrome-extension://${targetId}/worker.js` })).toBe(true);
      listeners.set(sessionId, router.observerForSession(sessionId));
    };
    const dispatch = event => [...listeners.values()].forEach(listener => listener(event));
    attachWorker('worker-first-unrelated', 'target-first');
    const reusedRequestId = 'network-request-1';
    dispatch({ sessionId: 'worker-first-unrelated', method: 'Network.loadingFinished', params: { requestId: reusedRequestId } });

    attachWorker('worker-actual-test', 'target-test');
    dispatch({ sessionId: 'worker-first-unrelated', method: 'Network.requestWillBeSent', params: { requestId: reusedRequestId } });
    dispatch({ sessionId: 'worker-actual-test', method: 'Network.requestWillBeSent', params: { requestId: reusedRequestId } });
    dispatch({ sessionId: 'worker-actual-test', method: 'Network.responseReceived', params: { requestId: reusedRequestId, response: { status: 200 } } });
    dispatch({ sessionId: 'worker-actual-test', method: 'Network.loadingFinished', params: { requestId: 'wrong-request' } });
    dispatch({ sessionId: 'worker-actual-test', method: 'Network.loadingFinished', params: { requestId: reusedRequestId } });

    const actual = validateWorkerNetworkCompletion({
      events: recorded, networkId: reusedRequestId, sessionId: 'worker-actual-test', targetId: 'target-test',
    });
    expect(actual).toMatchObject({ ok: true, issues: [] });
    expect(actual.matchedEvents).toHaveLength(3);
    expect(actual.matchedEvents.every(event => event.sessionId === 'worker-actual-test' && event.targetId === 'target-test')).toBe(true);
    expect(validateWorkerNetworkCompletion({
      events: recorded, networkId: reusedRequestId, sessionId: 'worker-first-unrelated', targetId: 'target-first',
    }).ok).toBe(false);
    expect(recorded.some(event => event.sessionId === 'worker-actual-test' && event.method === 'Network.loadingFinished'
      && event.params.requestId === 'wrong-request')).toBe(true);
  });

  it('distinguishes late A sibling roots from the exact trusted replacement B owner', () => {
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'A', trustedStartAccepted: true, currentOwnerSessionId: 'A', currentOwnerContextOwned: true,
    })).toMatchObject({ ok: true, role: 'initial-A', lockInitialSessionId: 'A' });
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'A', initialSessionId: 'A', replacementSessionId: null,
      initialSessionInvalidated: true, trustedStartAccepted: false, currentOwnerSessionId: 'B', currentOwnerContextOwned: true,
    })).toMatchObject({ ok: true, role: 'cancelled-A-sibling', waitForControllerAbort: true });
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'B', initialSessionId: 'A', replacementSessionId: null,
      initialSessionInvalidated: true, trustedStartAccepted: true, currentOwnerSessionId: 'B', currentOwnerContextOwned: true,
    })).toMatchObject({ ok: true, role: 'replacement-B', lockReplacementSessionId: 'B' });
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'B', initialSessionId: 'A', replacementSessionId: 'B',
      initialSessionInvalidated: true, trustedStartAccepted: true, currentOwnerSessionId: 'B', currentOwnerContextOwned: true,
    })).toMatchObject({ ok: true, role: 'replacement-B' });
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'C', initialSessionId: 'A', replacementSessionId: 'B',
      initialSessionInvalidated: true, trustedStartAccepted: true, currentOwnerSessionId: 'C', currentOwnerContextOwned: true,
    }).ok).toBe(false);
    expect(classifyStaleSuccessProviderOwner({
      sessionId: 'B', initialSessionId: 'A', replacementSessionId: null,
      initialSessionInvalidated: false, trustedStartAccepted: true, currentOwnerSessionId: 'B', currentOwnerContextOwned: true,
    }).ok).toBe(false);
  });

  it('rejects B counter, queue, lifecycle, controller, and held-request drift across A release', () => {
    const scheduler = {
      translationSessionId: 'B', isTranslated: true, translatedCount: 0, failedCount: 0,
      totalTasks: 1000, activeFlushes: 1, sessionContextOwned: true,
      discoveryPending: false, bridgeSessionOwned: true, bridgeSessionActive: true,
      bridgeDiscoveryPending: false, bridgeDiscoveryRunning: false, bridgeDiscoveryStarting: false,
      bridgeDiscoveryQueueDepth: 0, bridgeDiscoveryCancelled: false, bridgeDiscoveryFailed: false,
      pendingSettlementCount: 25, batchTimerActive: false, completionTimerActive: true,
      queueIds: [], activeBatchIds: Array.from({ length: 25 }, (_, i) => `b-${i}`),
    };
    const resources = {
      available: true,
      lifecycle: { activeIds: ['batch-B'] },
      service: { activeRequestIds: ['batch-B'], requests: [
        { messageId: 'batch-A', status: 'completed', operationOwned: false },
        { messageId: 'batch-B', status: 'processing', operationOwned: true },
      ] },
      sourceResolvers: { A: { present: false }, B: { present: true } },
      queue: { depths: { edge: 0 }, processing: { edge: true }, retryTimeoutCount: 0 },
      rateLimit: { edge: { activeRequests: 1, queuedRequests: 0, isProcessingQueue: true } },
      lease: { activeOperationIds: ['batch-B'], activeOperationCount: 1, timerActive: true },
    };
    const valid = {
      schedulerBefore: scheduler, schedulerAfter: structuredClone(scheduler),
      resourcesBefore: resources, resourcesAfter: structuredClone(resources),
      providerRootAfter: { sessionId: 'B', messageId: 'batch-B', status: 'pending' },
      controllerAfter: { sessionId: 'B', messageId: 'batch-B', aborted: false },
      heldRequest: { pageSessionId: 'B', batchMessageId: 'batch-B', released: false, handlerSettled: false },
      sessionId: 'B', messageId: 'batch-B', terminalMessageIds: ['batch-A'], sessionIds: ['A', 'B'],
    };
    expect(validateReplacementStability(valid)).toMatchObject({ ok: true, issues: [] });
    expect(validateReplacementStability({ ...valid, schedulerAfter: { ...scheduler, translatedCount: 1 } }).ok).toBe(false);
    expect(validateReplacementStability({ ...valid, resourcesAfter: { ...valid.resourcesAfter, lifecycle: { activeIds: [] } } }).ok).toBe(false);
    expect(validateReplacementStability({ ...valid, resourcesAfter: { ...valid.resourcesAfter, queue: { ...resources.queue, depths: { edge: 1 } } } }).ok).toBe(false);
    expect(validateReplacementStability({ ...valid, controllerAfter: { ...valid.controllerAfter, aborted: true } }).ok).toBe(false);
    expect(validateReplacementStability({ ...valid, heldRequest: { ...valid.heldRequest, released: true } }).ok).toBe(false);
  });

  it('waits for read-only B discovery completion before treating its counters and queue as a release baseline', () => {
    const ready = {
      translationSessionId: 'B', isTranslated: true, sessionContextOwned: true, bridgeSessionOwned: true, bridgeSessionActive: true,
      discoveryPending: false, bridgeDiscoveryPending: false, bridgeDiscoveryRunning: false, bridgeDiscoveryStarting: false,
      bridgeDiscoveryQueueDepth: 0, bridgeDiscoveryCancelled: false, bridgeDiscoveryFailed: false,
      totalTasks: 1000, queueIds: Array.from({ length: 975 }, (_, i) => `queued-${i}`),
      activeBatchIds: Array.from({ length: 25 }, (_, i) => `active-${i}`), pendingSettlementCount: 0,
      translatedCount: 0, failedCount: 0,
    };
    expect(validateReplacementDiscoverySnapshot({ snapshot: ready, sessionId: 'B', targetCount: 1000, firstBatchSize: 25 }).ok).toBe(true);
    expect(validateReplacementDiscoverySnapshot({ snapshot: { ...ready, discoveryPending: true }, sessionId: 'B', targetCount: 1000, firstBatchSize: 25 }).ok).toBe(false);
    expect(validateReplacementDiscoverySnapshot({ snapshot: { ...ready, discoveryPending: null }, sessionId: 'B', targetCount: 1000, firstBatchSize: 25 }).ok).toBe(false);
    expect(validateReplacementDiscoverySnapshot({ snapshot: { ...ready, totalTasks: 722, queueIds: ready.queueIds.slice(0, 697) }, sessionId: 'B', targetCount: 1000, firstBatchSize: 25 }).ok).toBe(false);
    expect(validateReplacementDiscoverySnapshot({
      snapshot: ready, sessionId: 'B', targetCount: 1000, firstBatchSize: 25,
      settlementOperations: [{ kind: 'scheduler.settlement', sessionId: 'B', outcome: 'accepted', changed: true }],
    }).ok).toBe(false);
  });

  it('accepts attributed B writes and explicit Restore while rejecting transient A/unowned values in one observer batch', () => {
    const ledger = createRawDOMMutationEvidence();
    const paragraph = { nodeType: 1, dataset: { benchId: 'target-1' } };
    const text = value => ({ nodeType: 3, nodeValue: value, textContent: value, parentElement: paragraph });
    const targetIdForNode = node => node === paragraph || node?.parentElement === paragraph ? 'target-1' : null;
    const source = 'source text';
    const translatedB = '\u200efixture translation B: source text';
    ledger.begin();
    ledger.capture([{ type: 'childList', target: paragraph, removedNodes: [text(source)], addedNodes: [text(translatedB)] }], { targetIdForNode });
    expect(ledger.snapshot().active).toBe(true);
    // A later delivery after final-resource drainage still belongs to this capture window.
    ledger.capture([{ type: 'childList', target: paragraph, removedNodes: [text(translatedB)], addedNodes: [text(source)] }], { targetIdForNode });
    const restored = ledger.finish([], { targetIdForNode });
    expect(validateRawDOMMutationEvidence({ evidence: restored, targets: [{ id: 'target-1', source }], mode: 'replacement' }).ok).toBe(true);

    ledger.begin();
    const character = { nodeType: 3, nodeValue: source, parentElement: paragraph };
    const transientA = '\u200efixture translation A: source text';
    ledger.capture([
      { type: 'characterData', target: character, oldValue: source },
      { type: 'characterData', target: character, oldValue: transientA },
    ], { targetIdForNode });
    const revertedA = ledger.finish([], { targetIdForNode });
    expect(validateRawDOMMutationEvidence({ evidence: revertedA, targets: [{ id: 'target-1', source }], mode: 'replacement' }).ok).toBe(false);

    ledger.begin();
    ledger.capture([
      { type: 'childList', target: paragraph, removedNodes: [text(source)], addedNodes: [text('unowned temporary text')] },
      { type: 'childList', target: paragraph, removedNodes: [text('unowned temporary text')], addedNodes: [text(source)] },
    ], { targetIdForNode });
    const revertedUnknown = ledger.finish([], { targetIdForNode });
    expect(validateRawDOMMutationEvidence({ evidence: revertedUnknown, targets: [{ id: 'target-1', source }], mode: 'stop' }).ok).toBe(false);
  });

  it('opens cleanup only with observed production invalidation evidence, not command acknowledgement alone', () => {
    const actual = { kind: 'session.invalidation', sessionId: 'A', capturedSessionActive: false, discoveryCancelled: true };
    expect(validateCleanupInvalidation({ sessionId: 'A', operations: [actual] })).toMatchObject({ ok: true, event: actual });
    expect(validateCleanupInvalidation({ sessionId: 'A', operations: [] }).ok).toBe(false);
    expect(validateCleanupInvalidation({ sessionId: 'A', operations: [{ ...actual, capturedSessionActive: true }] }).ok).toBe(false);
    expect(validateCleanupInvalidation({ sessionId: 'B', operations: [actual] }).ok).toBe(false);
    expect(gateCleanupDisposition({ restoreInvalidation: { ok: true }, stopInvalidation: { ok: false } }))
      .toMatchObject({ safeToOpen: true, path: 'confirmed-restore-invalidation' });
    expect(gateCleanupDisposition({ restoreInvalidation: { ok: false }, stopInvalidation: { ok: true } }))
      .toMatchObject({ safeToOpen: true, path: 'confirmed-stop-fallback' });
    expect(gateCleanupDisposition({ restoreInvalidation: { ok: false }, stopInvalidation: { ok: false }, contextReachable: true }))
      .toMatchObject({ safeToOpen: false, path: 'dispose-context-before-gate-open' });
  });

  it('fails closed on unavailable reply snapshots before A session ID is known', () => {
    expect(resolveCleanupSessionEvidence({ snapshotAvailable: false, replySnapshot: null, pageStartAttempted: true }).ok).toBe(false);
    expect(resolveCleanupSessionEvidence({ snapshotAvailable: true, replySnapshot: { gate: null }, pageStartAttempted: true }).ok).toBe(false);
    expect(resolveCleanupSessionEvidence({ snapshotAvailable: true, replySnapshot: { gate: null }, pageStartAttempted: false }))
      .toMatchObject({ ok: true, sessionId: null, noGatePending: true });
    expect(resolveCleanupSessionEvidence({ snapshotAvailable: true, replySnapshot: { gate: { descriptor: { sessionId: 'A' }, pending: true } }, pageStartAttempted: true }))
      .toMatchObject({ ok: true, sessionId: 'A', noGatePending: false });
  });

  it('never opens a held reply after failed Restore/Stop while A remains active, but uses a confirmed Stop fallback', async () => {
    const blockedEvents = [];
    const failedClosed = await teardownSuccessfulReplyGate({
      preferStopFirst: true,
      stop: async () => { blockedEvents.push('stop'); return { success: false }; },
      restore: async () => { blockedEvents.push('restore'); return { success: false }; },
      confirmInvalidation: async () => ({ ok: false, issues: ['A still active'] }),
      openGate: async () => blockedEvents.push('open'),
      disposeContext: async () => blockedEvents.push('dispose'),
    });
    expect(failedClosed.safeToOpen).toBe(false);
    expect(failedClosed.path).toBe('dispose-context-before-gate-open');
    expect(blockedEvents).toEqual(['stop', 'restore', 'stop', 'dispose']);

    const fallbackEvents = [];
    let stopCount = 0;
    const fallback = await teardownSuccessfulReplyGate({
      restore: async () => { fallbackEvents.push('restore'); return { success: false }; },
      confirmInvalidation: async () => ({ ok: stopCount > 0, issues: stopCount ? [] : ['A still active'] }),
      stop: async () => { stopCount++; fallbackEvents.push('stop'); return { success: true }; },
      openGate: async () => fallbackEvents.push('open'),
      disposeContext: async () => fallbackEvents.push('dispose'),
    });
    expect(fallback.safeToOpen).toBe(true);
    expect(fallback.path).toBe('confirmed-stop-fallback');
    expect(fallbackEvents).toEqual(['restore', 'stop', 'open']);

    const openFailure = [];
    const failedOpen = await teardownSuccessfulReplyGate({
      restoreNeeded: false,
      confirmInvalidation: async () => ({ ok: true, event: { sessionId: 'A' } }),
      openGate: async () => { openFailure.push('open'); throw new Error('content context lost'); },
      disposeContext: async () => openFailure.push('dispose'),
    });
    expect(failedOpen.safeToOpen).toBe(false);
    expect(openFailure).toEqual(['open', 'dispose']);
  });

  it('disposes instead of opening when the gate snapshot is unavailable before A ID is known', async () => {
    const events = [];
    const missingSnapshot = resolveCleanupSessionEvidence({ snapshotAvailable: false, replySnapshot: null, pageStartAttempted: true });
    expect(missingSnapshot.ok).toBe(false);
    const result = await teardownSuccessfulReplyGate({
      restoreNeeded: false,
      stop: async () => { events.push('stop'); return { success: false }; },
      confirmInvalidation: async () => ({ ok: false, issues: missingSnapshot.issues }),
      openGate: async () => events.push('open'),
      disposeContext: async () => events.push('dispose'),
    });
    expect(result.safeToOpen).toBe(false);
    expect(events).not.toContain('open');
    expect(events.at(-1)).toBe('dispose');
  });

  it('opens a pending reply unchanged during teardown without cancelling its source promise', async () => {
    const source = deferred();
    const runtime = { sendMessage(message) { return source.promise; } };
    const context = {};
    const scheduler = {
      translationSessionId: 'A',
      sessionContext: context,
      _executeBatchRequest(batch, config, context, sessionId) {
        return runtime.sendMessage({ action: 'page-translate-batch', messageId: 'batch-cleanup', data: { sessionId, text: JSON.stringify(batch) } });
      },
      _ownsFlushSession() { return false; },
    };
    const originalSend = runtime.sendMessage;
    const originalExecute = scheduler._executeBatchRequest;
    const originalOwns = scheduler._ownsFlushSession;
    const probe = installSuccessfulReplyProbe({ runtime, scheduler, timeoutMs: 1_000 });
    probe.arm();
    const pending = scheduler._executeBatchRequest([{ id: 'target-1', text: 'source' }], {}, context, 'A');
    expect(probe.snapshot().gate.status).toBe('pending');
    probe.close('teardown');
    expect(probe.snapshot().gate).toMatchObject({ status: 'closed', pending: true, settled: false });
    expect(probe.snapshot().wrappersRestored).toBe(false);
    expect(runtime.sendMessage).not.toBe(originalSend);
    const response = { success: true, translatedText: 'source response' };
    source.resolve(response);
    await expect(pending).resolves.toBe(response);
    await Promise.resolve();
    expect(probe.snapshot().gate).toMatchObject({ status: 'closed', pending: false, settled: true });
    expect(probe.snapshot().wrappersRestored).toBe(true);
    expect(runtime.sendMessage).toBe(originalSend);
    expect(scheduler._executeBatchRequest).toBe(originalExecute);
    expect(scheduler._ownsFlushSession).toBe(originalOwns);
  });

  it('restores only its own wrappers and forwards unmatched/non-success outcomes unchanged', async () => {
    const rejected = new Error('native response rejection');
    const source = deferred();
    const runtime = { sendMessage: function (message) { return source.promise; } };
    const originalSend = runtime.sendMessage;
    const scheduler = {
      _executeBatchRequest(batch, config, context, sessionId) {
        return runtime.sendMessage({ action: 'OTHER_ACTION', messageId: 'other', data: { sessionId } });
      },
      _ownsFlushSession() { return true; },
    };
    const originalExecute = scheduler._executeBatchRequest;
    const probe = installSuccessfulReplyProbe({ runtime, scheduler, timeoutMs: 1_000 });
    probe.arm();
    const pending = scheduler._executeBatchRequest([], {}, {}, 'A');
    expect(probe.snapshot().gate).toBeNull();
    expect(probe.snapshot().guardDiagnostics).toEqual([]);
    source.reject(rejected);
    await expect(pending).rejects.toBe(rejected);
    runtime.sendMessage = function laterOwner() {};
    probe.close('test-cleanup');
    expect(runtime.sendMessage.name).toBe('laterOwner');
    expect(scheduler._executeBatchRequest).toBe(originalExecute);
    expect(originalSend).not.toBe(runtime.sendMessage);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagingBoundary = vi.hoisted(() => {
  const runtime = { sendMessage: vi.fn() };
  return {
    runtime,
    safeSendMessage: vi.fn((...args) => runtime.sendMessage(...args)),
    sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
  };
});

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
  },
}));
vi.mock('@/core/extensionContext.js', () => {
  const contextManager = {
    safeSendMessage: vi.fn(),
    isValidSync: vi.fn(() => true),
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  };
  return { default: contextManager, ExtensionContextManager: contextManager, isExtensionContextValid: vi.fn(() => true), isContextError: vi.fn(() => false) };
});
vi.mock('@/features/translation/core/ProviderConfigurations.js', () => ({ getProviderConfiguration: vi.fn(() => ({})) }));
vi.mock('@/features/page-translation/utils/PageTranslationQueueFilter.js', () => ({ PageTranslationQueueFilter: { process: vi.fn() } }));
vi.mock('@/features/page-translation/utils/PageTranslationFluidFilter.js', () => ({ PageTranslationFluidFilter: { process: vi.fn() } }));
vi.mock('@/features/page-translation/PageTranslationHelper.js', () => ({
  PageTranslationHelper: { shouldTranslate: vi.fn(() => true), getNearestSemanticContainer: vi.fn(() => null) },
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), init: vi.fn(), debugLazy: vi.fn() })),
}));
vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({
  isFatalError: vi.fn(() => false),
  matchErrorToType: vi.fn(() => 'UNKNOWN'),
}));
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: messagingBoundary.safeSendMessage,
  sendRegularMessage: messagingBoundary.sendRegularMessage,
}));
vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'en'),
  getWholePageMaxCharsAsync: vi.fn(async () => 50_000),
  getWholePageAiMaxCharsAsync: vi.fn(async () => 50_000),
}));

import { PageTranslationScheduler } from '@/features/page-translation/PageTranslationScheduler.js';
import { createSuccessfulReplyGate } from './page-translation-e2e-benchmark/successful-reply-gate.mjs';
import { installSuccessfulReplyProbe } from './page-translation-e2e-benchmark/successful-reply-probes.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('PageTranslationScheduler stale successful reply guard', () => {
  let scheduler;
  let probe;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    messagingBoundary.runtime.sendMessage = vi.fn();
    messagingBoundary.safeSendMessage.mockImplementation((...args) => messagingBoundary.runtime.sendMessage(...args));
    messagingBoundary.sendRegularMessage.mockResolvedValue({ success: true });
    scheduler = new PageTranslationScheduler();
  });

  afterEach(() => {
    probe?.close('test-cleanup');
    probe = null;
    scheduler?.stop();
    scheduler?.reset();
    vi.useRealTimers();
  });

  it.each(['stop', 'reset', 'replacement'])('discards a captured stale success after %s without altering the current owner', async invalidation => {
    const sessionA = 'session-A';
    const contextA = Symbol('A-context');
    const captured = deferred();
    const sourceReply = deferred();
    const lifecycle = vi.fn();
    messagingBoundary.runtime.sendMessage.mockReturnValue(sourceReply.promise);
    const originalRuntimeSendMessage = messagingBoundary.runtime.sendMessage;
    scheduler = new PageTranslationScheduler({ onLifecycleEvent: lifecycle });
    scheduler.setTranslationState(true, sessionA, contextA);
    const ownsFlush = vi.spyOn(scheduler, '_ownsFlushSession');
    probe = installSuccessfulReplyProbe({
      runtime: messagingBoundary.runtime,
      scheduler,
      gateFactory: options => createSuccessfulReplyGate({
        ...options,
        onEvent: event => {
          options.onEvent(event);
          if (event.type === 'captured') captured.resolve();
        },
      }),
    });
    probe.arm();

    const itemA = { id: 'a-1', text: 'source A', settled: false, resolve: vi.fn() };
    const execution = scheduler._executeBatchRequest([itemA], {
      providerRegistryId: 'google',
      targetLanguage: 'en',
    }, contextA, sessionA);
    sourceReply.resolve({
      success: true,
      translatedText: JSON.stringify([{ id: 'a-1', text: 'translated A' }]),
    });
    await captured.promise;

    const beforeInvalidate = probe.snapshot();
    expect(beforeInvalidate.selectedBatch).toMatchObject({
      sessionId: sessionA,
      ownerSessionId: sessionA,
      contextOwned: true,
    });
    expect(beforeInvalidate.capturedMessage).toMatchObject({
      action: 'page-translate-batch',
      sessionId: sessionA,
    });
    const staleOperation = beforeInvalidate.selectedBatch.messageId;
    expect(beforeInvalidate.gate).toMatchObject({ captured: true, released: false, descriptor: { messageId: staleOperation } });

    if (invalidation === 'reset') {
      scheduler.reset();
    } else {
      scheduler.stop();
      let bTask;
      if (invalidation === 'replacement') {
        const contextB = Symbol('B-context');
        scheduler.setTranslationState(true, 'session-B', contextB);
        scheduler.translatedCount = 3;
        scheduler.failedCount = 2;
        bTask = scheduler.enqueue('source B', contextB);
        expect(scheduler.queue).toHaveLength(1);
        expect(scheduler.sessionContext).toBe(contextB);
        expect(scheduler.translationSessionId).toBe('session-B');
        expect(scheduler.totalTasks).toBe(1);
      }
      if (invalidation === 'replacement') expect(bTask).toBeInstanceOf(Promise);
    }

    expect(probe.release()).toBe(true);
    await execution;

    const afterRelease = probe.snapshot();
    expect(afterRelease.staleGuard).toMatchObject({
      sessionId: sessionA,
      messageId: staleOperation,
      ownsSession: false,
      afterRelease: true,
    });
    expect(ownsFlush).toHaveBeenCalledWith(sessionA, contextA);
    expect(ownsFlush.mock.results.at(-1).value).toBe(false);
    expect(itemA.resolve).toHaveBeenCalledTimes(1);
    const settlementA = itemA.resolve.mock.calls[0][0];
    expect(settlementA.state).toBe('cancelled');
    expect(scheduler.translatedCount).toBe(invalidation === 'replacement' ? 3 : 0);
    expect(lifecycle.mock.calls.filter(([, data]) => data?.sessionId === sessionA)).toHaveLength(0);
    expect(originalRuntimeSendMessage).toHaveBeenCalledTimes(1);

    if (invalidation === 'replacement') {
      expect(typeof scheduler.sessionContext).toBe('symbol');
      expect(scheduler.translationSessionId).toBe('session-B');
      expect(scheduler.queue).toHaveLength(1);
      expect(scheduler.failedCount).toBe(2);
      expect(scheduler.totalTasks).toBe(1);
    }
  });

  it('delivers a genuine reply to the active real owner without claiming Bridge acceptance', async () => {
    const sessionA = 'active-session';
    const contextA = Symbol('active-context');
    const captured = deferred();
    const sourceReply = deferred();
    messagingBoundary.runtime.sendMessage.mockReturnValue(sourceReply.promise);
    scheduler.setTranslationState(true, sessionA, contextA);
    const ownsFlush = vi.spyOn(scheduler, '_ownsFlushSession');
    probe = installSuccessfulReplyProbe({
      runtime: messagingBoundary.runtime,
      scheduler,
      gateFactory: options => createSuccessfulReplyGate({
        ...options,
        onEvent: event => {
          options.onEvent(event);
          if (event.type === 'captured') captured.resolve();
        },
      }),
    });
    probe.arm();

    const item = { id: 'active-1', text: 'source', settled: false, resolve: vi.fn() };
    const execution = scheduler._executeBatchRequest([item], { providerRegistryId: 'google', targetLanguage: 'en' }, contextA, sessionA);
    sourceReply.resolve({ success: true, translatedText: JSON.stringify([{ id: 'active-1', text: 'translated' }]) });
    await captured.promise;
    expect(probe.release()).toBe(true);
    await execution;

    expect(ownsFlush).toHaveBeenCalledWith(sessionA, contextA);
    expect(ownsFlush.mock.results.at(-1).value).toBe(true);
    const settlement = item.resolve.mock.calls[0][0];
    expect(settlement.state).toBe('pending');
    expect(scheduler.translatedCount).toBe(0);
    expect(settlement.settle('accepted')).toBe(true);
    expect(scheduler.translatedCount).toBe(1);
  });
});

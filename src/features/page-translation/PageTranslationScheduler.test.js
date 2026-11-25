import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. Mock webextension-polyfill FIRST
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
  }
}));

// 2. Mock ExtensionContextManager BEFORE other imports
vi.mock('@/core/extensionContext.js', () => {
  const Mock = {
    safeSendMessage: vi.fn(),
    isValidSync: vi.fn(() => true),
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  };
  return {
    default: Mock,
    ExtensionContextManager: Mock,
    isExtensionContextValid: vi.fn(() => true),
    isContextError: vi.fn(() => false)
  };
});

import { PageTranslationScheduler } from './PageTranslationScheduler.js';
import { PageTranslationHelper } from './PageTranslationHelper.js';
import { isFatalError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { PageTranslationQueueFilter } from './utils/PageTranslationQueueFilter.js';
import { PageTranslationFluidFilter } from './utils/PageTranslationFluidFilter.js';
import { safeSendMessage, sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons, MessageFormat } from '@/shared/messaging/core/MessagingCore.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { AUTO_DETECT_VALUE } from '@/shared/constants/core.js';

// 3. Mock other dependencies
vi.mock('./utils/PageTranslationQueueFilter.js', () => ({
  PageTranslationQueueFilter: { process: vi.fn() }
}));

vi.mock('./utils/PageTranslationFluidFilter.js', () => ({
  PageTranslationFluidFilter: { process: vi.fn() }
}));

vi.mock('./PageTranslationHelper.js', () => ({
  PageTranslationHelper: {
    shouldTranslate: vi.fn(() => true),
    getNearestSemanticContainer: vi.fn(() => null),
    isInViewportWithMargin: vi.fn(() => true),
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    init: vi.fn(),
    debugLazy: vi.fn()
  }))
}));

vi.mock('@/shared/error-management/ErrorMatcher.js');

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: vi.fn(() => Promise.resolve({ success: true })),
  sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'fa'),
  getWholePageAiMaxCharsAsync: vi.fn(async () => 100000)
}));

describe('PageTranslationScheduler', () => {
  let scheduler;
  let onFatalError;

  const getSettlement = (resolver) => resolver.mock.calls.at(-1)[0];
  const expectSettlement = (resolver, text) => {
    expect(getSettlement(resolver)).toEqual(expect.objectContaining({
      __pageTranslationSettlement: true,
      text,
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock behavior for ErrorMatcher
    matchErrorToType.mockImplementation((err) => {
      if (err?.type) return err.type;
      if (err?.errorType) return err.errorType;
      return 'UNKNOWN';
    });
    isFatalError.mockImplementation((errorOrType) => {
      const type = typeof errorOrType === 'string' ? errorOrType : errorOrType?.type;
      return type === 'EXTENSION_CONTEXT_INVALIDATED'
        || (typeof errorOrType === 'object' && [401, 402, 403, 404].includes(errorOrType?.statusCode));
    });

    onFatalError = vi.fn();
    scheduler = new PageTranslationScheduler({ onFatalError });
    scheduler.setTranslationState(true, 'test-session-123', { pageTitle: 'Test Page' });
    vi.spyOn(pageEventBus, 'emit');
    
    // Default mock behavior for filters
    const defaultResult = {
      batchItems: [],
      remainingItems: [],
      hasVisibleEligibleItems: false,
      purgedCount: 0,
      ejectedItems: []
    };
    PageTranslationQueueFilter.process.mockReturnValue({ ...defaultResult });
    PageTranslationFluidFilter.process.mockReturnValue({ ...defaultResult });
    PageTranslationHelper.isInViewportWithMargin.mockReturnValue(true);
  });

  afterEach(() => {
    scheduler.stop();
    scheduler.reset();
  });

  it('flushes the complete admitted batch once after discovery drains and preserves Page AUTO', async () => {
    scheduler.setSettings({
      lazyLoading: false,
      autoTranslateOnDOMChanges: false,
      translateAfterScrollStop: false,
    });
    const items = ['one', 'two', 'three'].map((text, index) => ({
      id: `initial-${index}`,
      text,
      enqueuedAt: performance.now(),
      isHighPriority: false,
      resolve: vi.fn(),
    }));
    scheduler.queue.push(...items);
    scheduler.batchTimer = setTimeout(() => {}, 800);
    scheduler.batchTimerDelay = 800;
    scheduler._batchTimerDeadline = performance.now() + 800;
    vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
      providerRegistryId: 'google',
      targetLanguage: 'en',
      chunkSize: 10,
      maxChars: 1000,
      parallelExecution: false,
      lazyLoading: false,
    });
    PageTranslationFluidFilter.process.mockImplementation(queue => ({
      batchItems: [...queue],
      remainingItems: [],
    }));
    safeSendMessage.mockImplementation(async message => {
      const requestItems = JSON.parse(message.data.text);
      return {
        success: true,
        translatedText: JSON.stringify(requestItems.map(({ id, text }) => ({ id, text: `translated:${text}` }))),
      };
    });

    expect(scheduler.releaseFirstBatchAfterDiscovery('test-session-123', scheduler.sessionContext)).toBe(true);
    expect(scheduler.batchTimer).toBeNull();
    await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledOnce());
    const message = safeSendMessage.mock.calls[0][0];
    const sentItems = JSON.parse(message.data.text);
    expect(sentItems).toEqual(items.map(({ id, text }) => ({ id, text })));
    expect(message.data.sourceLanguage).toBe(AUTO_DETECT_VALUE);
    expect(scheduler.releaseFirstBatchAfterDiscovery('test-session-123', scheduler.sessionContext)).toBe(false);
    expect(safeSendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { lazyLoading: true },
    { autoTranslateOnDOMChanges: true },
    { translateAfterScrollStop: true },
  ])('does not release the first batch for ineligible settings %o', (settings) => {
    scheduler.setSettings({
      lazyLoading: false,
      autoTranslateOnDOMChanges: false,
      translateAfterScrollStop: false,
      ...settings,
    });
    scheduler.queue.push({ text: 'initial work' });
    scheduler.batchTimer = setTimeout(() => {}, 800);
    scheduler.batchTimerDelay = 800;
    scheduler._batchTimerDeadline = performance.now() + 800;
    const timer = scheduler.batchTimer;
    const flush = vi.spyOn(scheduler, 'flush').mockResolvedValue();

    expect(scheduler.releaseFirstBatchAfterDiscovery('test-session-123', scheduler.sessionContext)).toBe(false);
    expect(scheduler.batchTimer).toBe(timer);
    expect(flush).not.toHaveBeenCalled();
  });

  it('uses DeepSeek Level 3 concurrency while retaining the AI page batch size', async () => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi: 'deepseek', targetLanguage: 'en' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config.chunkSize).toBe(30);
      expect(scheduler.settings.maxConcurrentFlushes).toBe(3);
    } finally {
      optimization.mockRestore();
    }
  });

  it('uses OpenAI Level 3 concurrency while retaining the AI page batch size', async () => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi: 'openai', targetLanguage: 'en' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config.chunkSize).toBe(30);
      expect(scheduler.settings.maxConcurrentFlushes).toBe(3);
    } finally {
      optimization.mockRestore();
    }
  });

  it.each(['google', 'googlev2'])('uses Google Level 3 workers while retaining its page batch and character limits (%s)', async translationApi => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi, targetLanguage: 'en' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config).toMatchObject({ chunkSize: 25, maxChars: 5000 });
      expect(scheduler.settings.maxConcurrentFlushes).toBe(3);
    } finally {
      optimization.mockRestore();
    }
  });

  it('uses the Yandex Level 3 worker curve with its existing Page batch and character limits', async () => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi: 'yandex', targetLanguage: 'fa' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config).toMatchObject({ chunkSize: 25, maxChars: 10000 });
      expect(scheduler.settings.maxConcurrentFlushes).toBe(3);
    } finally {
      optimization.mockRestore();
    }
  });

  it('uses three Edge Level 3 workers while retaining its page batch and character limits', async () => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi: 'edge', targetLanguage: 'en' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config).toMatchObject({ chunkSize: 25, maxChars: 5000 });
      expect(scheduler.settings.maxConcurrentFlushes).toBe(3);
    } finally {
      optimization.mockRestore();
    }
  });

  it.each([['webai', 4], ['openrouter', 3], ['requesty', 3]])('uses %s Level 3 concurrency while retaining the AI page batch size', async (translationApi, expectedConcurrency) => {
    const configModule = await import('@/shared/config/config.js');
    const optimization = vi.spyOn(configModule, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
    scheduler.setSettings({ translationApi, targetLanguage: 'en' });

    try {
      const config = await scheduler._getBatchConfig();

      expect(config.chunkSize).toBe(30);
      expect(scheduler.settings.maxConcurrentFlushes).toBe(expectedConcurrency);
    } finally {
      optimization.mockRestore();
    }
  });

  it.each([false, true])('uses filter visibility eligibility (%s) without rechecking item geometry', async hasVisibleEligibleItems => {
    const item = { id: 'visibility-item', text: 'item', resolve: vi.fn() };
    scheduler.queue = [item];
    scheduler.setSettings({ lazyLoading: true });
    vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ lazyLoading: true });
    PageTranslationFluidFilter.process.mockReturnValue({
      batchItems: [], remainingItems: [item], hasVisibleEligibleItems,
    });

    await scheduler.flush();

    expect(PageTranslationHelper.isInViewportWithMargin).not.toHaveBeenCalled();
    expect(scheduler.isWaitingForVisibility).toBe(!hasVisibleEligibleItems);
    expect(scheduler.isVisibilityRetryTimer).toBe(!hasVisibleEligibleItems);
  });

  it('logs aggregate dispatch diagnostics without source text', async () => {
    const item = { id: 'item-1', text: 'private source text', enqueuedAt: performance.now(), resolve: vi.fn(), score: 1 };
    scheduler.queue.push(item);
    PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [item], remainingItems: [] });
    vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
      providerRegistryId: 'google', targetLanguage: 'fa', chunkSize: 8, maxChars: 500, parallelExecution: false
    });
    safeSendMessage.mockResolvedValue({ success: true, translatedText: '["translated"]' });
    const capturedLogs = [];
    scheduler.logger.debugLazy.mockImplementation(factory => capturedLogs.push(factory()));

    await scheduler.flush();

    const [message, serializedDetails] = capturedLogs.at(-1);
    const details = JSON.parse(serializedDetails);
    expect(message).toContain('dispatch');
    expect(serializedDetails).not.toContain('\n');
    expect(details).toMatchObject({
      sessionId: 'test-session-123', totalQueued: 1, selectedItemCount: 1,
      originalChars: 19, chunkSize: 8, maxChars: 500, concurrencyLimit: 1,
      activeWorkersAtDispatch: 1, messageId: expect.any(String),
      preparationDurationMs: expect.any(Number), enqueueToDispatchMs: expect.any(Number),
    });
    expect(details.messageId).toBe(safeSendMessage.mock.calls[0][0].messageId);
    expect(details.batchId).toBeDefined();
    expect(JSON.stringify(details)).not.toContain('private source text');
  });

  describe('adaptive AI batch deferral', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      scheduler.isFirstBatch = false;
      scheduler.setSettings({ translateAfterScrollStop: false, maxConcurrentFlushes: 1 });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'openai', targetLanguage: 'en', chunkSize: 10, maxChars: 1000,
        parallelExecution: true, isAI: true, lazyLoading: false,
      });
      safeSendMessage.mockImplementation(async message => {
        const items = JSON.parse(message.data.text);
        return { success: true, translatedText: JSON.stringify(items.map(({ id }) => ({ id, text: 'translated' }))) };
      });
      scheduler.setDiscoveryPending(true, scheduler.sessionContext);
    });

    afterEach(() => vi.useRealTimers());

    const queueItems = count => Array.from({ length: count }, (_, index) => ({
      id: `adaptive-${index}`, text: `item-${index}`, enqueuedAt: performance.now(),
      isHighPriority: false, matchesTargetScript: true, resolve: vi.fn(),
    }));
    const select = (count, reasons = { viewport: 'insufficient_eligible_items' }) => {
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        config.diagnostics.stopReason = 'insufficient_eligible_items';
        config.diagnostics.stoppingReasons = reasons;
        return { batchItems: queue.slice(0, count), remainingItems: queue.slice(count) };
      });
    };

    it.each([1, 2, 3])('defers %i eligible items without holding a worker slot', async count => {
      scheduler.queue = queueItems(count);
      const originalQueue = scheduler.queue;
      select(count);

      await scheduler.flush();

      expect(scheduler.queue).toBe(originalQueue);
      expect(scheduler.activeFlushes).toBe(0);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(scheduler.batchTimer).not.toBeNull();
      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('releases early when discovery completes and re-filters the unchanged queue', async () => {
      scheduler.queue = queueItems(2);
      select(2);
      await scheduler.flush();
      select(2);

      scheduler.setDiscoveryPending(false, scheduler.sessionContext);
      await vi.runAllTimersAsync();

      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
    });

    it('does not extend the original deadline when more small items arrive', async () => {
      scheduler.queue = queueItems(1);
      select(1);
      await scheduler.flush();
      await vi.advanceTimersByTimeAsync(200);

      scheduler.queue.push(...queueItems(2));
      select(3);
      scheduler._scheduleFlush(1);
      await Promise.resolve();
      expect(scheduler.activeFlushes).toBe(0);
      await vi.advanceTimersByTimeAsync(49);
      expect(safeSendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not defer batches limited by script or character boundaries', async () => {
      for (const reason of ['script_boundary', 'character_limit']) {
        scheduler.queue = queueItems(2);
        select(2, { viewport: reason });
        await scheduler.flush();
      }
      expect(safeSendMessage).toHaveBeenCalledTimes(2);
    });

    it('dispatches sufficient batches, exact character limits, and non-AI/On-Stop work immediately', async () => {
      scheduler.queue = queueItems(4);
      select(4);
      await scheduler.flush();
      expect(safeSendMessage).toHaveBeenCalledTimes(1);

      scheduler.isFirstBatch = false;
      scheduler.queue = queueItems(1);
      scheduler.queue[0].text = '12345';
      scheduler._getBatchConfig.mockResolvedValueOnce({
        providerRegistryId: 'openai', targetLanguage: 'en', chunkSize: 10, maxChars: 5,
        parallelExecution: true, isAI: true, lazyLoading: false,
      });
      select(1);
      await scheduler.flush();
      expect(safeSendMessage).toHaveBeenCalledTimes(2);

      scheduler.queue = queueItems(1);
      scheduler._getBatchConfig.mockResolvedValueOnce({
        providerRegistryId: 'custom', targetLanguage: 'en', chunkSize: 10, maxChars: 1000,
        parallelExecution: true, isAI: false, lazyLoading: false,
      });
      select(1);
      await scheduler.flush();
      expect(safeSendMessage).toHaveBeenCalledTimes(3);

      scheduler.setSettings({ translateAfterScrollStop: true });
      scheduler.queue = queueItems(1);
      PageTranslationQueueFilter.process.mockImplementation(queue => ({
        batchItems: queue,
        remainingItems: [],
        purgedCount: 0,
        ejectedItems: [],
      }));
      scheduler._getBatchConfig.mockResolvedValueOnce({
        providerRegistryId: 'openai', targetLanguage: 'en', chunkSize: 10, maxChars: 1000,
        parallelExecution: true, isAI: true, lazyLoading: false,
      });
      select(1);
      await scheduler.flush();
      expect(safeSendMessage).toHaveBeenCalledTimes(4);
    });

    it('keeps discovery deferral bounded by the original deadline', async () => {
      scheduler.queue = queueItems(1);
      select(1);
      await scheduler.flush();
      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      expect(scheduler.adaptiveBatchDeadline).toBeNull();
    });

    it('keeps the first AI batch on its original 800ms deadline', async () => {
      scheduler.isFirstBatch = true;
      scheduler.setSettings({ chunkSize: 10, priorityThreshold: 1, scrollStopDelay: 600 });
      select(1);
      void scheduler.enqueue('first item', scheduler.sessionContext, 1);

      await vi.advanceTimersByTimeAsync(799);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(scheduler.adaptiveBatchDeadline).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('releases immediately on a fourth eligible enqueue, once and without duplicate IDs', async () => {
      scheduler.queue = queueItems(3);
      select(Number.MAX_SAFE_INTEGER);
      await scheduler.flush();
      expect(scheduler.activeFlushes).toBe(0);

      void scheduler.enqueue('fourth item', scheduler.sessionContext, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      const items = JSON.parse(safeSendMessage.mock.calls[0][0].data.text);
      expect(items).toHaveLength(4);
      expect(new Set(items.map(item => item.id)).size).toBe(4);
      expect(scheduler.releaseFirstBatchAfterDiscovery(
        scheduler.translationSessionId,
        scheduler.sessionContext
      )).toBe(false);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('coalesces burst enqueues into one eligibility recheck at the arrival threshold', async () => {
      scheduler.queue = queueItems(1);
      select(Number.MAX_SAFE_INTEGER);
      await scheduler.flush();
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);

      void scheduler.enqueue('second item', scheduler.sessionContext, 0);
      void scheduler.enqueue('third item', scheduler.sessionContext, 0);
      await Promise.resolve();
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);

      void scheduler.enqueue('fourth item', scheduler.sessionContext, 0);
      void scheduler.enqueue('fifth item', scheduler.sessionContext, 0);
      void scheduler.enqueue('sixth item', scheduler.sessionContext, 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      const items = JSON.parse(safeSendMessage.mock.calls[0][0].data.text);
      expect(items).toHaveLength(6);
      expect(new Set(items.map(item => item.id)).size).toBe(6);
    });

    it('re-filters visibility before dispatch and waits for the existing visibility retry', async () => {
      scheduler.queue = queueItems(1);
      let visible = true;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        config.diagnostics.stopReason = 'insufficient_eligible_items';
        config.diagnostics.stoppingReasons = { viewport: 'insufficient_eligible_items' };
        return visible
          ? { batchItems: queue.slice(0, 1), remainingItems: queue.slice(1), hasVisibleEligibleItems: true }
          : { batchItems: [], remainingItems: queue, hasVisibleEligibleItems: false };
      });
      scheduler._getBatchConfig.mockResolvedValue({
        providerRegistryId: 'openai', targetLanguage: 'en', chunkSize: 10, maxChars: 1000,
        parallelExecution: true, isAI: true, lazyLoading: true,
      });
      await scheduler.flush();
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);
      visible = false;
      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(scheduler.adaptiveBatchDeadline).toBeNull();
      expect(scheduler.isAdaptiveBatchTimer).toBe(false);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
      visible = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(3);
      expect(scheduler.adaptiveBatchDeadline).toBeNull();
      expect(scheduler.isAdaptiveBatchTimer).toBe(false);
      expect(scheduler.isWaitingForVisibility).toBe(false);
    });

    it.each(['stop', 'reset', 'replace-session'])(
      '%s prevents a stale adaptive callback from dispatching or touching replacement work', async action => {
        scheduler.queue = queueItems(1);
        select(1);
        await scheduler.flush();
        const replacementQueue = queueItems(1);
        if (action === 'stop') {
          scheduler.stop();
          scheduler.setTranslationState(true, 'replacement-session', { pageTitle: 'replacement' });
        } else if (action === 'reset') {
          scheduler.reset();
          scheduler.setTranslationState(true, 'replacement-session', { pageTitle: 'replacement' });
        } else {
          scheduler.setTranslationState(true, 'replacement-session', { pageTitle: 'replacement' });
        }
        scheduler.queue = replacementQueue;

        await vi.advanceTimersByTimeAsync(250);

        expect(safeSendMessage).not.toHaveBeenCalled();
        expect(scheduler.queue).toBe(replacementQueue);
      }
    );

    it('preserves another worker slot and keeps one adaptive timer across repeated flushes', async () => {
      scheduler.setSettings({ maxConcurrentFlushes: 2 });
      scheduler.activeFlushes = 1;
      scheduler.queue = queueItems(2);
      select(2);

      await scheduler.flush();
      expect(scheduler.activeFlushes).toBe(1);
      const timersDuringWait = vi.getTimerCount();
      await scheduler.flush();
      expect(scheduler.activeFlushes).toBe(1);
      expect(vi.getTimerCount()).toBe(timersDuringWait);

      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      const items = JSON.parse(safeSendMessage.mock.calls[0][0].data.text);
      expect(new Set(items.map(item => item.id)).size).toBe(items.length);
      expect(scheduler.activeFlushes).toBe(1);
      scheduler.activeFlushes = 0;
    });

    it('retries after the fixed deadline when concurrency is full', async () => {
      scheduler.queue = queueItems(1);
      select(1);
      await scheduler.flush();
      scheduler.activeFlushes = 1;

      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(scheduler.isAdaptiveBatchTimer).toBe(true);

      scheduler.activeFlushes = 0;
      await vi.advanceTimersByTimeAsync(300);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps the original adaptive timer while enqueues retry against full worker capacity', async () => {
      scheduler.queue = queueItems(1);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        config.diagnostics.stopReason = 'insufficient_eligible_items';
        config.diagnostics.stoppingReasons = { viewport: 'insufficient_eligible_items' };
        return { batchItems: queue, remainingItems: [] };
      });
      await scheduler.flush();
      const fixedDeadline = scheduler.adaptiveBatchDeadline;
      const originalTimer = scheduler.batchTimer;
      scheduler.activeFlushes = 1;

      void scheduler.enqueue('second item', scheduler.sessionContext, 0);
      await Promise.resolve();
      expect(scheduler.batchTimer).toBe(originalTimer);
      void scheduler.enqueue('third item', scheduler.sessionContext, 0);
      await Promise.resolve();
      expect(scheduler.batchTimer).toBe(originalTimer);
      expect(scheduler.batchTimerDelay).toBe(250);

      await vi.advanceTimersByTimeAsync(250);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(scheduler.adaptiveBatchDeadline).toBe(fixedDeadline);
      expect(scheduler.batchTimer).not.toBe(originalTimer);
      expect(scheduler.batchTimerDelay).toBe(300);

      scheduler.activeFlushes = 0;
      await vi.advanceTimersByTimeAsync(300);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      const items = JSON.parse(safeSendMessage.mock.calls[0][0].data.text);
      expect(items).toHaveLength(3);
    });
  });

  it('counts retained nodes once per callback and reaches idle without a provider request', async () => {
    vi.useFakeTimers();
    try {
      scheduler.setSettings({ autoTranslateOnDOMChanges: true });
      scheduler.recordRetainedTranslation(scheduler.sessionContext);
      scheduler.recordRetainedTranslation(Symbol('old-context'));
      expect(scheduler.totalTasks).toBe(1);
      expect(scheduler.translatedCount).toBe(1);
      expect(scheduler.failedCount).toBe(0);
      expect(scheduler.pendingSettlements.size).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.objectContaining({
        translatedCount: 1, totalCount: 1, failedCount: 0, isAutoTranslating: true,
      }));
      expect(safeSendMessage).not.toHaveBeenCalled();
      scheduler.stop();
      scheduler.recordRetainedTranslation(scheduler.sessionContext);
      expect(scheduler.totalTasks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('first-batch timer ownership', () => {
    let handoffs;
    let scheduleEvents;
    let flushCalls;
    let taskPromises;

    const configureTimedQueue = ({ translateAfterScrollStop = false, chunkSize = 250, lazyLoading = false } = {}) => {
      scheduler.setSettings({
        translationApi: 'google', targetLanguage: 'en', lazyLoading,
        translateAfterScrollStop, scrollStopDelay: 600, poolDelay: 150,
        priorityThreshold: 1, chunkSize, maxConcurrentFlushes: 1,
      });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize,
        maxChars: 1_000_000, parallelExecution: false, lazyLoading,
      });
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => ({
        batchItems: queue.slice(0, config.chunkSize),
        remainingItems: queue.slice(config.chunkSize),
      }));
      PageTranslationQueueFilter.process.mockImplementation((queue, config) => ({
        batchItems: queue.slice(0, config.chunkSize),
        remainingItems: queue.slice(config.chunkSize),
        purgedCount: 0,
        ejectedItems: [],
      }));

      handoffs = [];
      scheduleEvents = [];
      flushCalls = [];
      taskPromises = [];
      safeSendMessage.mockImplementation(async message => {
        const items = JSON.parse(message.data.text);
        handoffs.push({ at: Date.now(), ids: items.map(item => item.id), texts: items.map(item => item.text) });
        return {
          success: true,
          translatedText: JSON.stringify(items.map(item => ({ id: item.id, text: `translated:${item.text}` }))),
        };
      });

      const originalSchedule = scheduler._scheduleFlush.bind(scheduler);
      vi.spyOn(scheduler, '_scheduleFlush').mockImplementation(score => {
        const previousTimer = scheduler.batchTimer;
        originalSchedule(score);
        if (scheduler.batchTimer && scheduler.batchTimer !== previousTimer) {
          scheduleEvents.push({ at: Date.now(), delay: scheduler.batchTimerDelay, timer: scheduler.batchTimer });
        }
      });
      const originalFlush = scheduler.flush.bind(scheduler);
      vi.spyOn(scheduler, 'flush').mockImplementation((...args) => {
        flushCalls.push(Date.now());
        return originalFlush(...args);
      });
    };

    const enqueueTimed = (text, score = 1) => {
      const promise = scheduler.enqueue(text, scheduler.sessionContext, score, null)
        .then(settlement => settlement?.settle?.('accepted'));
      taskPromises.push(promise);
      return promise;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    afterEach(async () => {
      scheduler.stop();
      await Promise.allSettled(taskPromises);
      vi.useRealTimers();
    });

    it.each([false, true])('keeps a single first high-priority item at 800ms (on-stop=%s)', async onStop => {
      configureTimedQueue({ translateAfterScrollStop: onStop });
      scheduler.isScrolling = onStop;
      const promise = enqueueTimed('single-high', 1);
      const firstTimer = scheduler.batchTimer;

      await vi.advanceTimersByTimeAsync(799);
      expect(handoffs).toEqual([]);
      expect(scheduler.batchTimer).toBe(firstTimer);
      await vi.advanceTimersByTimeAsync(1);
      await promise;

      expect(flushCalls).toEqual([800]);
      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[800, ['single-high']]]);
    });

    it.each([false, true])('does not rearm for high arrivals at 0/200/400/600/799ms (on-stop=%s)', async onStop => {
      configureTimedQueue({ translateAfterScrollStop: onStop });
      scheduler.isScrolling = onStop;
      enqueueTimed('high-0', 1);
      const firstTimer = scheduler.batchTimer;
      for (const at of [200, 400, 600, 799]) {
        await vi.advanceTimersByTimeAsync(at - Date.now());
        enqueueTimed(`high-${at}`, 1);
        expect(scheduler.batchTimer).toBe(firstTimer);
      }

      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(taskPromises);

      expect(scheduleEvents).toHaveLength(1);
      expect(flushCalls[0]).toBe(800);
      expect(handoffs.map(({ at, texts }) => [at, texts.length])).toEqual([[800, 5]]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(handoffs).toHaveLength(1);
    });

    it.each([false, true])('does not let mixed high/low arrivals reset first-batch time (on-stop=%s)', async onStop => {
      configureTimedQueue({ translateAfterScrollStop: onStop });
      scheduler.isScrolling = onStop;
      enqueueTimed('high-0', 1);
      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('low-200', 0);
      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('high-400', 1);
      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('low-600', 0);

      await vi.advanceTimersByTimeAsync(199);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(taskPromises);

      expect(scheduleEvents).toHaveLength(1);
      expect(flushCalls[0]).toBe(800);
      expect(handoffs[0].texts).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(500);
      expect(handoffs).toHaveLength(1);
    });

    it.each([false, true])('preserves the same-turn five-item first-batch deadline (on-stop=%s)', async onStop => {
      configureTimedQueue({ translateAfterScrollStop: onStop });
      scheduler.isScrolling = onStop;
      for (let index = 0; index < 5; index++) enqueueTimed(`burst-${index}`, 1);

      await vi.advanceTimersByTimeAsync(799);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(taskPromises);

      expect(scheduleEvents).toHaveLength(1);
      expect(flushCalls[0]).toBe(800);
      expect(handoffs[0].texts).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1000);
      expect(handoffs).toHaveLength(1);
    });

    it('flushes the first eight items at the anchored deadline during a continuous stream', async () => {
      configureTimedQueue();
      enqueueTimed('stream-0', 1);
      for (const at of Array.from({ length: 19 }, (_, index) => (index + 1) * 100)) {
        await vi.advanceTimersByTimeAsync(at - Date.now());
        if (at === 800) {
          expect(handoffs.map(({ at: flushAt, texts }) => [flushAt, texts.length])).toEqual([[800, 8]]);
        }
        enqueueTimed(`stream-${at}`, 1);
      }

      expect(handoffs.map(({ at, texts }) => [at, texts.length])).toEqual([[800, 8]]);
      await vi.advanceTimersByTimeAsync(249);
      expect(handoffs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(taskPromises);

      expect(handoffs.map(({ at, texts }) => [at, texts.length])).toEqual([[800, 8], [2150, 12]]);
      const handoffIds = handoffs.flatMap(({ ids }) => ids);
      expect(handoffIds).toHaveLength(20);
      expect(new Set(handoffIds).size).toBe(20);
      expect(scheduleEvents.map(({ at }) => at)).toEqual([0, 800, ...Array.from({ length: 11 }, (_, index) => 900 + index * 100)]);
    });

    it.each([
      [false, 600, 250, 1250],
      [true, 150, 150, 1150],
    ])('rearms an existing later-batch low-priority timer (on-stop=%s)', async (onStop, lowDelay, highDelay, expectedFlush) => {
      configureTimedQueue({ translateAfterScrollStop: onStop });
      const first = enqueueTimed('first-batch', 1);
      await vi.advanceTimersByTimeAsync(800);
      await first;
      expect(flushCalls).toEqual([800]);

      await vi.advanceTimersByTimeAsync(100);
      enqueueTimed('later-low', 0);
      await vi.advanceTimersByTimeAsync(100);
      const laterHigh = enqueueTimed('later-high', 1);
      expect(scheduleEvents.map(({ at, delay }) => [at, delay])).toEqual([
        [0, 800], [900, lowDelay], [1000, highDelay],
      ]);

      await vi.advanceTimersByTimeAsync(expectedFlush - Date.now() - 1);
      expect(handoffs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await laterHigh;
      await Promise.all(taskPromises);

      expect(flushCalls).toEqual([800, expectedFlush]);
      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([
        [800, ['first-batch']], [expectedFlush, ['later-low', 'later-high']],
      ]);
    });

    it('flushes On-Stop immediately on scroll stop after scroll-start cancelled the first timer', async () => {
      configureTimedQueue({ translateAfterScrollStop: true });
      enqueueTimed('before-scroll', 1);
      await vi.advanceTimersByTimeAsync(50);
      scheduler.signalScrollStart();
      await vi.advanceTimersByTimeAsync(50);
      enqueueTimed('during-scroll', 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(handoffs).toEqual([]);

      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduleEvents.map(({ at, delay }) => [at, delay])).toEqual([[0, 800], [100, 800]]);
      expect(flushCalls).toEqual([200]);
      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[200, ['before-scroll', 'during-scroll']]]);
    });

    it('holds later On-Stop arrivals while scrolling and flushes them at scroll stop', async () => {
      configureTimedQueue({ translateAfterScrollStop: true });
      const first = enqueueTimed('first-visible', 1);
      await vi.advanceTimersByTimeAsync(800);
      await first;
      expect(flushCalls).toEqual([800]);

      scheduler.signalScrollStart();
      await vi.advanceTimersByTimeAsync(50);
      const later = enqueueTimed('after-first-batch', 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(handoffs).toHaveLength(1);
      expect(scheduleEvents).toHaveLength(1);

      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      await later;

      expect(flushCalls).toEqual([800, 1850]);
      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([
        [800, ['first-visible']], [1850, ['after-first-batch']],
      ]);
    });

    it('retries visibility on a low-frequency timer until the queued item becomes eligible', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item.node || item.textNode || item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      const task = enqueueTimed('lazy-item');

      await vi.advanceTimersByTimeAsync(800);
      expect(handoffs).toEqual([]);
      expect(scheduler.batchTimer).not.toBeNull();
      expect(scheduler.isVisibilityRetryTimer).toBe(true);

      visible = true;
      await vi.advanceTimersByTimeAsync(999);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await task;

      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[1800, ['lazy-item']]]);
      expect(flushCalls).toEqual([800, 1800]);
      expect(scheduler.batchTimer).toBeNull();
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps polling blocked items without provider requests and can recover later', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item.node || item.textNode || item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      const task = enqueueTimed('still-lazy');

      await vi.advanceTimersByTimeAsync(800 + 1000 + 2000);
      expect(handoffs).toEqual([]);
      expect(safeSendMessage).not.toHaveBeenCalled();
      expect(flushCalls).toEqual([800, 1800, 3800]);
      expect(scheduler.queue).toHaveLength(1);

      visible = true;
      await vi.advanceTimersByTimeAsync(3000);
      await task;
      expect(handoffs.map(({ at }) => at)).toEqual([6800]);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.batchTimer).toBeNull();
    });

    it('backs off stable blocked checks from one to two to three seconds and caps there', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      enqueueTimed('stable-blocked');

      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler._visibilityRetryDeadline).toBe(1800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(flushCalls).toEqual([800, 1800]);
      expect(scheduler._visibilityRetryDeadline).toBe(3800);
      await vi.advanceTimersByTimeAsync(2000);
      expect(flushCalls).toEqual([800, 1800, 3800]);
      expect(scheduler._visibilityRetryDeadline).toBe(6800);
      await vi.advanceTimersByTimeAsync(3000);
      expect(flushCalls).toEqual([800, 1800, 3800, 6800]);
      expect(scheduler._visibilityRetryDeadline).toBe(9800);
      scheduler.stop();
    });

    it('grows visibility intervals only after discovery finishes and another stable idle check', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      scheduler.setDiscoveryPending(true, scheduler.sessionContext);
      enqueueTimed('discovery-blocked');

      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler._visibilityRetryDeadline).toBe(1800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(3800);

      scheduler.setDiscoveryPending(false, scheduler.sessionContext);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(4800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(2000);
      expect(scheduler._visibilityRetryDeadline).toBe(6800);
      scheduler.stop();
    });

    it('holds backoff while Fluid scrolling continues and restarts at one second after stop', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('scrolling-blocked');
      scheduler.signalScrollStart();

      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler._visibilityRetryDeadline).toBe(1800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);

      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(2000);
      expect(scheduler._visibilityRetryDeadline).toBe(4800);
      scheduler.stop();
    });

    it('resets to the first retry interval when one item recovers and another remains blocked', async () => {
      configureTimedQueue({ lazyLoading: true, chunkSize: 1 });
      scheduler.isFirstBatch = false;
      const visibleItems = new Set();
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(item => visibleItems.has(item.text));
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return {
          batchItems,
          remainingItems: queue.filter(item => !batchSet.has(item)),
          hasVisibleEligibleItems: selected.length > 0,
        };
      });
      vi.spyOn(scheduler, '_executeBatchRequest').mockImplementation(async items => {
        items.forEach(item => scheduler._resolveItem(item, `translated:${item.text}`, 'accepted'));
      });
      const recoveredTask = enqueueTimed('first-recovers');
      enqueueTimed('still-blocked');
      await scheduler.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(3000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(scheduler._visibilityRetryDeadline).toBe(6000);
      expect(scheduler._visibilityRetryDelay).toBe(3000);

      visibleItems.add('first-recovers');
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);
      await recoveredTask;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(scheduler.translatedCount).toBe(1);
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler.queue.map(({ text }) => text)).toEqual(['still-blocked']);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(5);
      expect(scheduler.activeFlushes).toBe(0);
      expect(scheduler.isWaitingForVisibility).toBe(true);
      expect(scheduler._visibilityRetryDeadline).toBe(7001);
      scheduler.stop();
    });

    it('resets backoff on viewport activity without reading geometry or postponing a retry', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('activity-reset');
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(3800);
      const filterCalls = PageTranslationFluidFilter.process.mock.calls.length;

      await vi.advanceTimersByTimeAsync(200);
      scheduler.signalViewportActivity();
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(3000);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(filterCalls);
      await vi.advanceTimersByTimeAsync(999);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(filterCalls);
      await vi.advanceTimersByTimeAsync(1);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(filterCalls + 1);
      scheduler.stop();
    });

    it('resets backoff for new arrivals and accelerates without postponing the retry', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('arrival-reset');
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(3800);

      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('arrival-during-backoff');
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);
      scheduler.stop();
    });

    it('bounds low-priority arrival acceleration and never postpones an earlier retry deadline', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.setSettings({ scrollStopDelay: 5000 });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      enqueueTimed('long-delay-base', 0);
      await vi.advanceTimersByTimeAsync(800);
      scheduler.isFirstBatch = false;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(scheduler._visibilityRetryDelay).toBe(3000);
      expect(scheduler._visibilityRetryDeadline).toBe(6800);

      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('accelerates-to-one-second', 0);
      expect(scheduler._visibilityRetryDeadline).toBe(5000);
      await vi.advanceTimersByTimeAsync(500);
      enqueueTimed('earlier-deadline-retained', 0);
      expect(scheduler._visibilityRetryDeadline).toBe(5000);
      await vi.advanceTimersByTimeAsync(200);
      enqueueTimed('continuous-arrival', 0);
      expect(scheduler._visibilityRetryDeadline).toBe(5000);

      visible = true;
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all(taskPromises);
      expect(flushCalls.at(-1)).toBe(5000);
      expect(handoffs.length).toBeGreaterThan(0);
      scheduler.stop();
    });

    it('does not increase visibility backoff while another provider worker is active', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 2;
      scheduler.activeFlushes = 1;
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('busy-blocked');
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.activeFlushes).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);
      scheduler.activeFlushes = 0;
      scheduler.stop();
    });

    it('keeps a delayed blocked config from restoring backoff after viewport activity', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('activity-during-config');
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      let resolveConfig;
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => { resolveConfig = resolve; }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(resolveConfig).toBeTypeOf('function');

      scheduler.signalViewportActivity();
      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      scheduler._getBatchConfig.mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(4800);
      scheduler.stop();
    });

    it('invalidates a previous stable check when an arrival occurs during delayed config', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('arrival-before-config');
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(2000);
      let resolveConfig;
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => { resolveConfig = resolve; }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(resolveConfig).toBeTypeOf('function');

      enqueueTimed('arrival-during-config');
      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      scheduler._getBatchConfig.mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(4600);
      scheduler.stop();
    });

    it('deduplicates unchanged visibility-idle events and re-emits when progress or queued work changes', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item.node || item.textNode || item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      const visibilityIdles = () => pageEventBus.emit.mock.calls
        .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_IDLE)
        .map(([, payload]) => payload);
      const first = enqueueTimed('blocked-progress');

      await vi.advanceTimersByTimeAsync(1300);
      expect(visibilityIdles()).toHaveLength(1);
      scheduler.failedCount++;
      await vi.advanceTimersByTimeAsync(2000);
      expect(visibilityIdles()).toHaveLength(2);
      expect(visibilityIdles()[1]).toMatchObject({ failedCount: 1, totalCount: 1 });

      visible = true;
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      expect(scheduler.queue).toHaveLength(0);

      visible = false;
      const next = enqueueTimed('new-blocked-work');
      await vi.advanceTimersByTimeAsync(1200);
      expect(visibilityIdles()).toHaveLength(3);
      expect(visibilityIdles()[2]).toMatchObject({ totalCount: 2 });
      scheduler.stop();
      await next;
    });

    it('emits an initial visibility-idle event for a replacement session', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      const visibilityIdleCount = () => pageEventBus.emit.mock.calls
        .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_IDLE).length;

      enqueueTimed('first-session-blocked');
      await vi.advanceTimersByTimeAsync(1300);
      expect(visibilityIdleCount()).toBe(1);

      scheduler.stop();
      scheduler.setTranslationState(true, 'replacement-session', { replacement: true });
      enqueueTimed('replacement-session-blocked');
      await vi.advanceTimersByTimeAsync(1300);
      expect(visibilityIdleCount()).toBe(2);
    });

    it('keeps a visibility retry bounded when a newly enqueued item arrives', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item.node || item.textNode || item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      enqueueTimed('blocked');
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);

      visible = true;
      const later = enqueueTimed('new-arrival');
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      await vi.advanceTimersByTimeAsync(799);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await later;

      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[1600, ['blocked', 'new-arrival']]]);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('coalesces emergency-queue arrivals without postponing the visibility recheck deadline', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      for (let index = 0; index < 1000; index++) enqueueTimed(`emergency-${index}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(flushCalls).toEqual([0]);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);

      for (const at of [100, 200, 300, 400, 500, 600, 700, 800, 900, 999]) {
        await vi.advanceTimersByTimeAsync(at - Date.now());
        enqueueTimed(`arrival-${at}`, at % 200 === 0 ? 0 : 1);
      }
      expect(scheduler.batchTimer).not.toBeNull();
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(flushCalls).toEqual([0, 900]);
      const acceleratedDeadline = scheduler._visibilityRetryDeadline;
      for (const at of [1000, 1100, 1200, 1300, 1400, 1500, 1600]) {
        await vi.advanceTimersByTimeAsync(at - Date.now());
        enqueueTimed(`arrival-${at}`);
        expect(scheduler._visibilityRetryDeadline).toBe(acceleratedDeadline);
      }
      await vi.advanceTimersByTimeAsync(acceleratedDeadline - Date.now());
      expect(flushCalls.at(-1)).toBe(acceleratedDeadline);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(3);
      expect(scheduler._visibilityRetryDeadline).toBe(acceleratedDeadline + 1000);

      scheduler.stop();
    });

    it('rechecks immediately on scroll stop while visibility retry is pending', async () => {
      configureTimedQueue({ lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      const task = enqueueTimed('scroll-wakeup');
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      visible = true;
      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      await task;
      expect(flushCalls).toEqual([800, 800]);
      expect(handoffs.map(({ texts }) => texts)).toEqual([['scroll-wakeup']]);
    });

    it('keeps the first automatic interval after a blocked immediate scroll-stop check', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('scroll-stop-still-blocked');
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler._visibilityRetryDelay).toBe(2000);

      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler._visibilityRetryDeadline).toBe(2800);
      scheduler.stop();
    });

    it('lets later high-priority eligible arrivals accelerate a blocked retry without rearming it', async () => {
      configureTimedQueue({ lazyLoading: true });
      const visibleItems = new Set();
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(item => visibleItems.has(item.text));
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0 };
      });
      const first = enqueueTimed('initial');
      visibleItems.add('initial');
      await vi.advanceTimersByTimeAsync(800);
      await first;

      const blocked = enqueueTimed('blocked-later', 0);
      await vi.advanceTimersByTimeAsync(600);
      expect(scheduler.isWaitingForVisibility).toBe(true);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);

      const arrival = enqueueTimed('newly-visible-high', 1);
      visibleItems.add('newly-visible-high');
      const dueAt = scheduler._visibilityRetryDeadline;
      expect(dueAt).toBe(1650);
      await vi.advanceTimersByTimeAsync(249);
      expect(handoffs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await arrival;
      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[800, ['initial']], [1650, ['newly-visible-high']]]);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(3);
      scheduler.stop();
      await blocked;
    });

    it('lets the first blocked config worker invalidate all slower concurrent selectors', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 3;
      scheduler._clearBatchTimer();
      scheduler.queue.push({ text: 'config-race', score: 0, isHighPriority: false, resolve: vi.fn() });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      const configs = [];
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => configs.push(resolve)));
      const workers = [scheduler.flush(), scheduler.flush(), scheduler.flush()];
      expect(configs).toHaveLength(3);
      const config = {
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250,
        maxChars: 1_000_000, parallelExecution: false, lazyLoading: true,
      };

      configs[0](config);
      await workers[0];
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);
      configs[1](config);
      configs[2](config);
      await Promise.all(workers.slice(1));

      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);
      expect(scheduler.isWaitingForVisibility).toBe(true);
      scheduler.stop();
    });

    it('preserves visibility-recheck permission across concurrency saturation', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 1;
      const task = enqueueTimed('saturated-recheck');
      PageTranslationFluidFilter.process.mockReturnValue({
        batchItems: [], remainingItems: [...scheduler.queue], hasVisibleEligibleItems: false,
      });
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.isWaitingForVisibility).toBe(true);

      scheduler.activeFlushes = 1;
      await vi.advanceTimersByTimeAsync(1000);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler.batchTimerDelay).toBe(300);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(1);

      scheduler.activeFlushes = 0;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [...queue], remainingItems: [], hasVisibleEligibleItems: true,
      }));
      await vi.advanceTimersByTimeAsync(300);
      await task;
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('converts a pending normal timer to visibility recovery without extending its deadline', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 2;
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      let resolveConfig;
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => { resolveConfig = resolve; }));
      const first = enqueueTimed('delayed-worker');
      scheduler._clearBatchTimer();
      const worker = scheduler.flush();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(100);
      const second = enqueueTimed('concurrent-arrival');
      const originalTimer = scheduler.batchTimer;
      expect(scheduler._batchTimerDeadline).toBe(900);
      await vi.advanceTimersByTimeAsync(100);
      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      scheduler._getBatchConfig.mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      await worker;
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler.batchTimer).not.toBe(originalTimer);
      expect(scheduler._visibilityRetryDeadline).toBe(900);

      visible = true;
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(0);
      expect(handoffs.map(({ at }) => at)).toEqual([900]);
      expect(scheduler.batchTimer).toBeNull();
      await Promise.all([first, second]);
      scheduler.stop();
    });

    it.each([
      { mode: 'non-lazy fluid', translateAfterScrollStop: false, lazyLoading: false },
      { mode: 'on-stop', translateAfterScrollStop: true, lazyLoading: true },
    ])('does not convert a pending normal timer for $mode scheduling', ({ translateAfterScrollStop, lazyLoading }) => {
      configureTimedQueue({ translateAfterScrollStop, lazyLoading });
      scheduler.queue.push({ text: 'pending', score: 1, isHighPriority: true, resolve: vi.fn() });
      scheduler._scheduleFlush(1);
      const timer = scheduler.batchTimer;
      const deadline = scheduler._batchTimerDeadline;

      scheduler._scheduleVisibilityRetry(scheduler.translationSessionId, scheduler.sessionContext);

      expect(scheduler.batchTimer).toBe(timer);
      expect(scheduler._batchTimerDeadline).toBe(deadline);
      expect(scheduler.isVisibilityRetryTimer).toBe(false);
    });

    it('converts a pending concurrency retry to visibility recovery without extending it', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 1;
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      let resolveConfig;
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => { resolveConfig = resolve; }));
      const task = enqueueTimed('delayed-concurrency-worker');
      scheduler._clearBatchTimer();
      const worker = scheduler.flush();
      await Promise.resolve();
      await scheduler.flush();
      expect(scheduler._batchTimerDeadline).toBe(300);

      await vi.advanceTimersByTimeAsync(100);
      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      scheduler._getBatchConfig.mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      await worker;
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler._visibilityRetryDeadline).toBe(300);

      visible = true;
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(handoffs.map(({ at }) => at)).toEqual([300]);
      expect(scheduler.batchTimer).toBeNull();
      await task;
      scheduler.stop();
    });

    it('rearms an expired concurrency timer while config is pending, then recovers at that deadline', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 1;
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const batchItems = visible ? queue.slice(0, config.chunkSize) : [];
        return { batchItems, remainingItems: queue.slice(batchItems.length), hasVisibleEligibleItems: visible };
      });
      let resolveConfig;
      scheduler._getBatchConfig.mockImplementation(() => new Promise(resolve => { resolveConfig = resolve; }));
      const task = enqueueTimed('pending-config-recovery');
      scheduler._clearBatchTimer();
      const worker = scheduler.flush();
      await Promise.resolve();
      await scheduler.flush();
      const firstConcurrencyTimer = scheduler.batchTimer;
      expect(scheduler._batchTimerDeadline).toBe(300);

      await vi.advanceTimersByTimeAsync(300);
      expect(scheduler.batchTimer).not.toBe(firstConcurrencyTimer);
      expect(scheduler._batchTimerDeadline).toBe(600);

      await vi.advanceTimersByTimeAsync(100);
      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      scheduler._getBatchConfig.mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250, maxChars: 1_000_000, parallelExecution: false, lazyLoading: true });
      await worker;
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler._visibilityRetryDeadline).toBe(600);

      visible = true;
      await vi.advanceTimersByTimeAsync(200);
      await task;
      expect(handoffs.map(({ at }) => at)).toEqual([600]);
      expect(scheduler.batchTimer).toBeNull();
      scheduler.stop();
    });

    it('releases an expired timer handle before an early-returning flush', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.queue.push({ text: 'will-be-cleared', score: 1, isHighPriority: true, resolve: vi.fn() });
      scheduler._scheduleFlush(1);
      const expiredTimer = scheduler.batchTimer;
      scheduler.queue = [];
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.batchTimer).toBeNull();

      scheduler.queue.push({ text: 'blocked', score: 0, isHighPriority: false, resolve: vi.fn() });
      scheduler.isWaitingForVisibility = true;
      scheduler._scheduleVisibilityRetry(scheduler.translationSessionId, scheduler.sessionContext);
      expect(scheduler.batchTimer).not.toBe(expiredTimer);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler._visibilityRetryDeadline).toBe(1800);
    });

    it('stops a provider worker loop when its parallel sibling classifies the remaining queue as blocked', async () => {
      configureTimedQueue({ lazyLoading: true });
      scheduler.settings.maxConcurrentFlushes = 2;
      scheduler._clearBatchTimer();
      scheduler.queue = [
        { id: 'eligible', text: 'eligible', score: 1, isHighPriority: true, resolve: vi.fn() },
        { id: 'blocked', text: 'blocked', score: 0, isHighPriority: false, resolve: vi.fn() },
      ];
      scheduler._getBatchConfig.mockResolvedValue({
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 1,
        maxChars: 1_000_000, parallelExecution: true, lazyLoading: true,
      });
      let finishProvider;
      safeSendMessage.mockImplementation(() => new Promise(resolve => { finishProvider = resolve; }));
      PageTranslationFluidFilter.process.mockImplementation(queue => queue[0].text === 'eligible'
        ? { batchItems: [queue[0]], remainingItems: queue.slice(1), hasVisibleEligibleItems: true }
        : { batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false });

      const worker = scheduler.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(finishProvider).toBeTypeOf('function');
      expect(scheduler.isWaitingForVisibility).toBe(true);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
      finishProvider({ success: true, translatedText: JSON.stringify([{ id: 'eligible', text: 'translated' }]) });
      await vi.advanceTimersByTimeAsync(0);
      await worker;
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(2);
      scheduler.stop();
    });

    it('uses a fresh visibility revision for each provider worker selection', async () => {
      configureTimedQueue({ lazyLoading: true, chunkSize: 1 });
      scheduler.settings.maxConcurrentFlushes = 2;
      const visibleItems = new Set(['initial']);
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(item => visibleItems.has(item.id));
      PageTranslationFluidFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return {
          batchItems,
          remainingItems: queue.filter(item => !batchSet.has(item)),
          hasVisibleEligibleItems: selected.length > 0,
        };
      });
      scheduler._getBatchConfig.mockResolvedValue({
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 1,
        maxChars: 1_000_000, parallelExecution: true, lazyLoading: true,
      });
      const providerRequests = [];
      safeSendMessage.mockImplementation(message => new Promise(resolve => {
        const items = JSON.parse(message.data.text);
        providerRequests.push({
          ids: items.map(item => item.id),
          resolve: () => resolve({
            success: true,
            translatedText: JSON.stringify(items.map(item => ({ id: item.id, text: `translated:${item.text}` }))),
          }),
        });
      }));
      scheduler.queue = ['initial', 'recovered', 'after-recovery'].map(id => ({
        id, text: id, score: 1, isHighPriority: true, resolve: vi.fn(),
      }));

      const initialWorker = scheduler.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(providerRequests.map(({ ids }) => ids)).toEqual([['initial']]);
      expect(scheduler.isWaitingForVisibility).toBe(true);

      visibleItems.add('recovered');
      visibleItems.add('after-recovery');
      await vi.advanceTimersByTimeAsync(1000);
      expect(providerRequests.map(({ ids }) => ids)).toEqual([['initial'], ['recovered']]);
      expect(scheduler.activeFlushes).toBe(2);
      expect(scheduler.isWaitingForVisibility).toBe(false);
      expect(scheduler.queue.map(({ id }) => id)).toEqual(['after-recovery']);

      providerRequests[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(providerRequests.map(({ ids }) => ids)).toEqual([['initial'], ['recovered'], ['after-recovery']]);
      expect(scheduler.activeFlushes).toBe(2);

      providerRequests[1].resolve();
      providerRequests[2].resolve();
      await vi.advanceTimersByTimeAsync(0);
      await initialWorker;
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.activeFlushes).toBe(0);
      expect(providerRequests.flatMap(({ ids }) => ids)).toEqual(['initial', 'recovered', 'after-recovery']);
      scheduler.stop();
    });

    it('ignores pending config completion after stop, reset, or direct session replacement', async () => {
      configureTimedQueue({ lazyLoading: true });
      for (const lifecycle of ['stop', 'reset', 'replace']) {
        if (!scheduler.isTranslated) scheduler.setTranslationState(true, `session-${lifecycle}`, { lifecycle });
        scheduler._clearBatchTimer();
        scheduler.activeFlushes = 0;
        scheduler.queue = [];
        PageTranslationFluidFilter.process.mockClear();
        scheduler.queue.push({ text: `stale-${lifecycle}`, score: 0, isHighPriority: false, resolve: vi.fn() });
        let resolveConfig;
        scheduler._getBatchConfig.mockImplementationOnce(() => new Promise(resolve => { resolveConfig = resolve; }));
        const worker = scheduler.flush();
        if (lifecycle === 'stop') scheduler.stop();
        else if (lifecycle === 'reset') scheduler.reset();
        else scheduler.setTranslationState(true, 'replacement-session', { replacement: true });
        const activeFlushesAfterLifecycle = scheduler.activeFlushes;
        resolveConfig({
          providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250,
          maxChars: 1_000_000, parallelExecution: false, lazyLoading: true,
        });
        await worker;
        expect(PageTranslationFluidFilter.process).not.toHaveBeenCalled();
        expect(scheduler.activeFlushes).toBe(activeFlushesAfterLifecycle);
        expect(scheduler.batchTimer).toBeNull();
      }
    });

    it('does not poll an empty batch when lazy loading is disabled', async () => {
      configureTimedQueue({ lazyLoading: false });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('non-lazy-empty');

      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.queue).toHaveLength(1);
      expect(scheduler.isWaitingForVisibility).toBe(false);
      expect(scheduler.batchTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      expect(flushCalls).toEqual([800]);
      expect(safeSendMessage).not.toHaveBeenCalled();
    });

    it('cancels On-Stop visibility retries during scrolling and rechecks at scroll stop', async () => {
      configureTimedQueue({ translateAfterScrollStop: true, lazyLoading: true });
      let visible = false;
      PageTranslationHelper.isInViewportWithMargin.mockImplementation(() => visible);
      PageTranslationQueueFilter.process.mockImplementation((queue, config) => {
        const selected = queue.filter(item => PageTranslationHelper.isInViewportWithMargin(item.node || item.textNode || item, 0));
        const batchItems = selected.slice(0, config.chunkSize);
        const batchSet = new Set(batchItems);
        return { batchItems, remainingItems: queue.filter(item => !batchSet.has(item)), hasVisibleEligibleItems: selected.length > 0, purgedCount: 0, ejectedItems: [] };
      });
      const task = enqueueTimed('on-stop-lazy');
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);

      scheduler.signalScrollStart();
      expect(scheduler.batchTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      expect(flushCalls).toEqual([800]);

      visible = true;
      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      await task;
      expect(flushCalls).toEqual([800, 2300]);
      expect(handoffs.map(({ texts }) => texts)).toEqual([['on-stop-lazy']]);
    });

    it('starts a fresh On-Stop visibility interval after a cancelled retry and delayed scroll stop', async () => {
      configureTimedQueue({ translateAfterScrollStop: true, lazyLoading: true });
      PageTranslationQueueFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      const task = enqueueTimed('on-stop-delayed-wake');
      await vi.advanceTimersByTimeAsync(800);
      expect(PageTranslationQueueFilter.process).toHaveBeenCalledTimes(1);

      scheduler.signalScrollStart();
      expect(scheduler.batchTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      scheduler.signalScrollStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(flushCalls).toEqual([800, 2300]);
      expect(PageTranslationQueueFilter.process).toHaveBeenCalledTimes(2);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler.batchTimerDelay).toBe(1000);

      await vi.advanceTimersByTimeAsync(999);
      expect(PageTranslationQueueFilter.process).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(flushCalls).toEqual([800, 2300, 3300]);
      expect(PageTranslationQueueFilter.process).toHaveBeenCalledTimes(3);
      scheduler.stop();
      await task;
    });

    it('invalidates pending visibility retries on stop and session replacement', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      enqueueTimed('old-session-item');
      await vi.advanceTimersByTimeAsync(800);
      const staleRetry = scheduler.batchTimer;
      expect(scheduler.isVisibilityRetryTimer).toBe(true);

      scheduler.stop();
      scheduler.setTranslationState(true, 'replacement-session', { replacement: true });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [...queue], remainingItems: [],
      }));
      const replacement = enqueueTimed('replacement-item');
      const replacementTimer = scheduler.batchTimer;
      expect(replacementTimer).not.toBe(staleRetry);
      await vi.advanceTimersByTimeAsync(800);
      await replacement;
      expect(handoffs.map(({ texts }) => texts)).toEqual([['replacement-item']]);
    });

    it('clears blocked visibility retry state on reset', async () => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      const task = enqueueTimed('reset-blocked-item');
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      scheduler.reset();
      await task;

      expect(scheduler.batchTimer).toBeNull();
      expect(scheduler._visibilityRetryDeadline).toBeNull();
      const filterCalls = PageTranslationFluidFilter.process.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(filterCalls);
    });

    it.each(['stop', 'reset', 'replacement'])('invalidates a scheduled blocked retry on %s and allows fresh replacement work', async lifecycle => {
      configureTimedQueue({ lazyLoading: true });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [], remainingItems: [...queue], hasVisibleEligibleItems: false,
      }));
      const oldTask = enqueueTimed(`old-${lifecycle}`);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
      const staleDeadline = scheduler._visibilityRetryDeadline;
      const oldFilterCount = PageTranslationFluidFilter.process.mock.calls.length;
      expect(scheduler.isVisibilityRetryTimer).toBe(true);
      expect(scheduler._visibilityRetryDelay).toBe(3000);

      if (lifecycle === 'stop') scheduler.stop();
      else if (lifecycle === 'reset') scheduler.reset();
      else scheduler.setTranslationState(true, 'direct-replacement', { replacement: true });
      expect(scheduler.batchTimer).toBeNull();
      expect(scheduler._visibilityRetryDeadline).toBeNull();
      expect(scheduler._visibilityRetryDelay).toBe(1000);
      expect(scheduler.isWaitingForVisibility).toBe(false);
      if (!scheduler.isTranslated) scheduler.setTranslationState(true, `fresh-${lifecycle}`, { fresh: true });

      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [...queue], remainingItems: [], hasVisibleEligibleItems: true,
      }));
      const freshTask = enqueueTimed(`fresh-${lifecycle}`);
      const replacementTimer = scheduler.batchTimer;
      expect(replacementTimer).not.toBeNull();
      await vi.advanceTimersByTimeAsync(Math.max(0, staleDeadline - performance.now()));
      await Promise.all([oldTask, freshTask]);
      expect(scheduler.batchTimer).toBeNull();
      expect(PageTranslationFluidFilter.process).toHaveBeenCalledTimes(oldFilterCount + 1);
      expect(handoffs.at(-1).texts).toContain(`fresh-${lifecycle}`);
    });

    it('keeps flush invocation at 800ms distinct from the 200ms batch-config handoff delay', async () => {
      configureTimedQueue();
      const config = {
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 250,
        maxChars: 1_000_000, parallelExecution: false, lazyLoading: false,
      };
      scheduler._getBatchConfig.mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(config), 200);
      }));
      const task = enqueueTimed('config-delay', 1);

      await vi.advanceTimersByTimeAsync(800);
      expect(flushCalls).toEqual([800]);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(199);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await task;

      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[1000, ['config-delay']]]);
    });

    it('flushes high-priority capacity immediately at 250 items', async () => {
      configureTimedQueue({ chunkSize: 250 });
      for (let index = 0; index < 250; index++) enqueueTimed(`capacity-${index}`, 1);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(taskPromises);

      expect(flushCalls).toEqual([0]);
      expect(handoffs.map(({ at, texts }) => [at, texts.length])).toEqual([[0, 250]]);
      expect(scheduleEvents).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(handoffs).toHaveLength(1);
    });

    it('emergency-flushes 1000 low-priority items immediately with a 250-item first batch', async () => {
      configureTimedQueue({ chunkSize: 250 });
      let releaseBatch;
      safeSendMessage.mockImplementation(async message => {
        const items = JSON.parse(message.data.text);
        handoffs.push({ at: Date.now(), ids: items.map(item => item.id), texts: items.map(item => item.text) });
        return new Promise(resolve => {
          releaseBatch = () => resolve({
            success: true,
            translatedText: JSON.stringify(items.map(item => ({ id: item.id, text: `translated:${item.text}` }))),
          });
        });
      });
      for (let index = 0; index < 1000; index++) enqueueTimed(`emergency-${index}`, 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(flushCalls[0]).toBe(0);
      expect(handoffs[0]).toMatchObject({ at: 0 });
      expect(handoffs[0].texts).toHaveLength(250);
      scheduler.stop();
      releaseBatch();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled(taskPromises);
    });

    it('does not reschedule while an earlier real transport owns the concurrency slot', async () => {
      configureTimedQueue({ chunkSize: 1, maxConcurrentFlushes: 1 });
      let releaseFirst;
      let activeTransports = 0;
      let maxActiveTransports = 0;
      safeSendMessage.mockImplementation(async message => {
        const items = JSON.parse(message.data.text);
        activeTransports++;
        maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
        handoffs.push({ at: Date.now(), ids: items.map(item => item.id), texts: items.map(item => item.text) });
        if (!releaseFirst) {
          return new Promise(resolve => {
            releaseFirst = () => {
              activeTransports--;
              resolve({
                success: true,
                translatedText: JSON.stringify(items.map(item => ({ id: item.id, text: `translated:${item.text}` }))),
              });
            };
          });
        }
        activeTransports--;
        return {
          success: true,
          translatedText: JSON.stringify(items.map(item => ({ id: item.id, text: `translated:${item.text}` }))),
        };
      });
      enqueueTimed('active-low', 0);
      await vi.advanceTimersByTimeAsync(800);
      expect(handoffs.map(({ at }) => at)).toEqual([800]);

      await vi.advanceTimersByTimeAsync(100);
      enqueueTimed('queued-high', 1);
      expect(scheduleEvents.map(({ at, delay }) => [at, delay])).toEqual([[0, 800]]);
      expect(scheduler.activeFlushes).toBe(1);
      expect(scheduler.batchTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(taskPromises);

      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([
        [800, ['active-low']], [1000, ['queued-high']],
      ]);
      expect(maxActiveTransports).toBe(1);
      expect(scheduleEvents.map(({ at, delay }) => [at, delay])).toEqual([[0, 800]]);
    });

    it('reset/replacement cancels the old deadline and starts a fresh first-batch timer', async () => {
      configureTimedQueue();
      enqueueTimed('old-session', 1);
      await vi.advanceTimersByTimeAsync(200);
      scheduler.reset();
      scheduler.setTranslationState(true, 'replacement-session', { replacement: true });
      const replacement = enqueueTimed('replacement', 1);
      expect(scheduleEvents.map(({ at, delay }) => [at, delay])).toEqual([[0, 800], [200, 800]]);
      await vi.advanceTimersByTimeAsync(799);
      expect(handoffs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await replacement;

      expect(handoffs.map(({ at, texts }) => [at, texts])).toEqual([[1000, ['replacement']]]);
    });

    it('stop cancels a pending first-batch timer without handoff', async () => {
      configureTimedQueue();
      enqueueTimed('stopped', 1);
      await vi.advanceTimersByTimeAsync(200);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(handoffs).toEqual([]);
      expect(scheduler.batchTimer).toBeNull();
    });
  });

  describe('bounded independent Page batches', () => {
    it.each(['deepl', 'yandex', 'google', 'googlev2', 'edge'].flatMap(provider => [1, 2, 3, 4, 5].flatMap(level => [false, true].map(translateAfterScrollStop => [provider, level, translateAfterScrollStop]))))('uses the effective %s worker cap at level %i in %s mode', async (provider, level, translateAfterScrollStop) => {
      const config = await import('@/shared/config/config.js');
      const providerConfigurations = await import('@/features/translation/core/ProviderConfigurations.js');
      const optimization = vi.spyOn(config, 'getProviderOptimizationLevelAsync').mockResolvedValue(level);
      scheduler.setSettings({ translationApi: provider, targetLanguage: 'ja', translateAfterScrollStop });
      try {
        const batchConfig = await scheduler._getBatchConfig();
        const providerName = provider === 'deepl' ? 'DeepLTranslate'
          : provider === 'yandex' ? 'YandexTranslate'
          : provider === 'google' ? 'GoogleTranslate'
            : provider === 'googlev2' ? 'GoogleTranslateV2' : 'MicrosoftEdge';
        const effectiveProviderLimit = providerConfigurations.getProviderConfiguration(providerName, level).rateLimit.maxConcurrent;
        const expectedWorkerCap = Math.max(1, Math.min(4, Math.floor(effectiveProviderLimit / 2)));
        expect(batchConfig.parallelExecution).toBe(expectedWorkerCap > 1);
        expect(scheduler.settings.maxConcurrentFlushes).toBe(expectedWorkerCap);
        if (provider === 'google') expect(scheduler.settings.maxConcurrentFlushes).toBe([1, 1, 3, 3, 4][level - 1]);
        if (provider === 'googlev2') expect(scheduler.settings.maxConcurrentFlushes).toBe([1, 1, 3, 3, 4][level - 1]);
        if (provider === 'yandex') expect(scheduler.settings.maxConcurrentFlushes).toBe([1, 1, 3, 3, 4][level - 1]);
        if (provider === 'deepl') expect(scheduler.settings.maxConcurrentFlushes).toBe([1, 1, 2, 4, 4][level - 1]);
        if (provider === 'edge') expect(scheduler.settings.maxConcurrentFlushes).toBe([1, 1, 3, 4, 4][level - 1]);
      } finally {
        optimization.mockRestore();
      }
    });

    it('dispatches up to the DeepL, Yandex, Google Classic, Google V2, and Edge worker caps in Fluid and On-Stop', async () => {
      vi.useFakeTimers();
      const config = await import('@/shared/config/config.js');
      const providerConfigurations = await import('@/features/translation/core/ProviderConfigurations.js');
      const optimization = vi.spyOn(config, 'getProviderOptimizationLevelAsync').mockResolvedValue(1);

      const exerciseDispatch = async (provider, translateAfterScrollStop, expectedMaximum) => {
        scheduler.reset();
        safeSendMessage.mockClear();
        scheduler.setTranslationState(true, `${provider}-${translateAfterScrollStop}`, { pageTitle: 'Test Page' });
        scheduler.setSettings({
          translationApi: provider,
          targetLanguage: 'ja',
          translateAfterScrollStop,
          lazyLoading: false,
        });
        const items = Array.from({ length: 6 }, (_, index) => ({
          id: `${provider}-${translateAfterScrollStop}-${index}`,
          text: `source ${index}`,
          resolve: vi.fn(),
        }));
        scheduler.queue = items;
        const filter = translateAfterScrollStop ? PageTranslationQueueFilter : PageTranslationFluidFilter;
        filter.process.mockImplementation(queue => ({
          batchItems: queue.slice(0, 1),
          remainingItems: queue.slice(1),
        }));

        let active = 0;
        let maximum = 0;
        const releases = [];
        safeSendMessage.mockImplementation(message => {
          expect(message.data.provider).toBe(provider);
          const batch = JSON.parse(message.data.text);
          maximum = Math.max(maximum, ++active);
          return new Promise(resolve => {
            let released = false;
            releases.push(() => {
              if (released) return;
              released = true;
              active--;
              resolve({
                success: true,
                translatedText: JSON.stringify(batch.map(item => ({ ...item, text: `translated:${item.text}` }))),
              });
            });
          });
        });

        const flushCalls = [];
        const flush = scheduler.flush.bind(scheduler);
        const flushSpy = vi.spyOn(scheduler, 'flush').mockImplementation((...args) => {
          const pending = flush(...args);
          flushCalls.push(pending);
          return pending;
        });
        const pump = async () => {
          await vi.dynamicImportSettled();
          await vi.advanceTimersByTimeAsync(0);
        };
        const waitForDispatches = async count => {
          for (let turn = 0; turn < 40 && safeSendMessage.mock.calls.length < count; turn++) await pump();
          expect(safeSendMessage).toHaveBeenCalledTimes(count);
        };

        try {
          const initialFlush = scheduler.flush();
          await waitForDispatches(expectedMaximum);
          expect(active).toBe(expectedMaximum);
          for (let count = expectedMaximum + 1; count <= items.length; count++) {
            releases[count - expectedMaximum - 1]();
            await waitForDispatches(count);
            expect(active).toBe(expectedMaximum);
          }
          releases.slice(items.length - expectedMaximum).forEach(release => release());
          for (let turn = 0; turn < 40 && scheduler.activeFlushes !== 0; turn++) await pump();
          await Promise.all([initialFlush, ...flushCalls]);
          expect(maximum).toBe(expectedMaximum);
          expect(active).toBe(0);
          expect(scheduler.activeFlushes).toBe(0);
          expect(items.every(item => item.resolve.mock.calls.length === 1)).toBe(true);
        } finally {
          releases.forEach(release => release());
          flushSpy.mockRestore();
        }
      };

      try {
        for (const level of [1, 2, 3, 4, 5]) {
          optimization.mockResolvedValue(level);
          const maxConcurrent = providerConfigurations.getProviderConfiguration('GoogleTranslateV2', level).rateLimit.maxConcurrent;
          const workerCap = Math.max(1, Math.min(4, Math.floor(maxConcurrent / 2)));
          await exerciseDispatch('googlev2', false, workerCap);
          await exerciseDispatch('googlev2', true, workerCap);
          const deeplMaxConcurrent = providerConfigurations.getProviderConfiguration('DeepLTranslate', level).rateLimit.maxConcurrent;
          const deeplWorkerCap = Math.max(1, Math.min(4, Math.floor(deeplMaxConcurrent / 2)));
          expect(deeplMaxConcurrent).toBe([2, 3, 5, 8, 10][level - 1]);
          expect(deeplWorkerCap).toBe([1, 1, 2, 4, 4][level - 1]);
          await exerciseDispatch('deepl', false, deeplWorkerCap);
          await exerciseDispatch('deepl', true, deeplWorkerCap);
          const googleMaxConcurrent = providerConfigurations.getProviderConfiguration('GoogleTranslate', level).rateLimit.maxConcurrent;
          const googleWorkerCap = Math.max(1, Math.min(4, Math.floor(googleMaxConcurrent / 2)));
          await exerciseDispatch('google', false, googleWorkerCap);
          await exerciseDispatch('google', true, googleWorkerCap);
          const yandexMaxConcurrent = providerConfigurations.getProviderConfiguration('YandexTranslate', level).rateLimit.maxConcurrent;
          const yandexWorkerCap = Math.max(1, Math.min(4, Math.floor(yandexMaxConcurrent / 2)));
          expect(yandexWorkerCap).toBe([1, 1, 3, 3, 4][level - 1]);
          await exerciseDispatch('yandex', false, yandexWorkerCap);
          await exerciseDispatch('yandex', true, yandexWorkerCap);
          const edgeMaxConcurrent = providerConfigurations.getProviderConfiguration('MicrosoftEdge', level).rateLimit.maxConcurrent;
          const edgeWorkerCap = Math.max(1, Math.min(4, Math.floor(edgeMaxConcurrent / 2)));
          await exerciseDispatch('edge', false, edgeWorkerCap);
          await exerciseDispatch('edge', true, edgeWorkerCap);
        }
      } finally {
        optimization.mockRestore();
        vi.useRealTimers();
      }
    });

    it.each([[3, 25, 3], [5, 10, 4]])('enables Custom workers at level %i without changing its existing batch size', async (level, chunkSize, limit) => {
      const config = await import('@/shared/config/config.js');
      const optimization = vi.spyOn(config, 'getProviderOptimizationLevelAsync').mockResolvedValue(level);
      scheduler.setSettings({ translationApi: 'custom', targetLanguage: 'ja' });
      try {
        const batchConfig = await scheduler._getBatchConfig();
        expect(batchConfig.parallelExecution).toBe(true);
        expect(batchConfig.chunkSize).toBe(chunkSize);
        expect(scheduler.settings.maxConcurrentFlushes).toBe(limit);
      } finally {
        optimization.mockRestore();
      }
    });

    it('enables Mock parallel workers in both queue modes without changing its batch config', async () => {
      const config = await import('@/shared/config/config.js');
      const optimization = vi.spyOn(config, 'getProviderOptimizationLevelAsync').mockResolvedValue(3);
      scheduler.setSettings({ translationApi: 'mock', targetLanguage: 'ja' });
      try {
        const batchConfig = await scheduler._getBatchConfig();
        expect(batchConfig).toMatchObject({
          parallelExecution: true,
          isAI: false,
          chunkSize: 25,
          maxChars: 2000,
        });
        expect(scheduler.settings.maxConcurrentFlushes).toBe(5);

        for (const translateAfterScrollStop of [false, true]) {
          scheduler.reset();
          scheduler.setTranslationState(true, `mock-${translateAfterScrollStop}`, { pageTitle: 'Test Page' });
          scheduler.setSettings({
            translationApi: 'mock',
            targetLanguage: 'ja',
            translateAfterScrollStop,
            lazyLoading: false,
          });
          const items = Array.from({ length: 5 }, (_, index) => ({
            id: `mock-item-${translateAfterScrollStop}-${index}`,
            text: `source ${index}`,
            resolve: vi.fn(),
          }));
          scheduler.queue = items;
          const filter = translateAfterScrollStop ? PageTranslationQueueFilter : PageTranslationFluidFilter;
          filter.process.mockImplementation(queue => ({
            batchItems: queue.slice(0, 1),
            remainingItems: queue.slice(1),
          }));

          const releases = [];
          const initialDispatchCount = safeSendMessage.mock.calls.length;
          let dispatchAll;
          const allDispatched = new Promise(resolve => { dispatchAll = resolve; });
          safeSendMessage.mockImplementation(message => {
            const request = new Promise(resolve => releases.push(() => resolve({
              success: true,
              translatedText: JSON.stringify(JSON.parse(message.data.text).map(item => ({
                ...item,
                text: `translated:${item.text}`,
              }))),
            })));
            expect(message.data.provider).toBe('mock');
            expect(message.data.sourceLanguage).toBe('auto');
            if (releases.length === 5) dispatchAll();
            return request;
          });

          const flushCalls = [];
          const flush = scheduler.flush.bind(scheduler);
          const flushSpy = vi.spyOn(scheduler, 'flush').mockImplementation((...args) => {
            const pending = flush(...args);
            flushCalls.push(pending);
            return pending;
          });
          try {
            const initialFlush = scheduler.flush();
            await allDispatched;
            expect(safeSendMessage).toHaveBeenCalledTimes(initialDispatchCount + 5);
            expect(scheduler.activeFlushes).toBe(5);
            releases.forEach(release => release());
            await Promise.all([initialFlush, ...flushCalls]);
            expect(scheduler.activeFlushes).toBe(0);
            expect(items.every(item => item.resolve.mock.calls.length === 1)).toBe(true);
          } finally {
            flushSpy.mockRestore();
          }
        }
      } finally {
        optimization.mockRestore();
      }
    });

    const configureBatches = (limit) => {
      vi.spyOn(scheduler, '_getBatchConfig').mockImplementation(async () => {
        scheduler.settings.maxConcurrentFlushes = limit;
        return { providerRegistryId: 'custom', targetLanguage: 'ja', parallelExecution: true };
      });
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: queue.slice(0, 2), remainingItems: queue.slice(2),
      }));
    };

    it.each([1, 2, 4])('fills %i workers from one flush and never exceeds its limit', async (limit) => {
      vi.useFakeTimers();
      try {
        configureBatches(limit);
        let active = 0;
        let maxActive = 0;
        safeSendMessage.mockImplementation(async (message) => {
          maxActive = Math.max(maxActive, ++active);
          const items = JSON.parse(message.data.text);
          await new Promise(resolve => setTimeout(resolve, 20));
          active--;
          return { success: true, translatedText: JSON.stringify(items.map(item => ({ ...item, text: `translated:${item.text}` }))) };
        });
        const promises = Array.from({ length: 12 }, (_, index) => scheduler.enqueue(`source ${index}`));
        const flush = scheduler.flush();
        await vi.runAllTimersAsync();
        await flush;
        const settlements = await Promise.all(promises);
        expect(maxActive).toBe(limit);
        expect(active).toBe(0);
        expect(safeSendMessage).toHaveBeenCalledTimes(6);
        expect(settlements.map(result => result.text)).toEqual(Array.from({ length: 12 }, (_, index) => `translated:source ${index}`));
        settlements.forEach(result => result.settle('accepted'));
        expect(scheduler.translatedCount).toBe(12);
        expect(scheduler.activeFlushes).toBe(0);
      } finally {
        scheduler.stop();
        vi.useRealTimers();
      }
    });

    it('maps reversed result IDs and preserves valid siblings when one result is missing', async () => {
      const batch = [
        { id: 'a', text: 'A', resolve: vi.fn() },
        { id: 'b', text: 'B', resolve: vi.fn() },
        { id: 'c', text: 'C', resolve: vi.fn() },
      ];
      safeSendMessage.mockResolvedValue({ success: true, translatedText: JSON.stringify([
        { id: 'c', text: 'translated C' }, { id: 'a', text: 'translated A' },
      ]) });
      await scheduler._executeBatchRequest(batch, { providerRegistryId: 'custom' }, scheduler.sessionContext, scheduler.translationSessionId);
      expectSettlement(batch[0].resolve, 'translated A');
      expectSettlement(batch[2].resolve, 'translated C');
      expect(getSettlement(batch[1].resolve).state).toBe('failed');
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('maps independent Page batches by stable item IDs when they complete out of order', async () => {
      const pending = new Map();
      safeSendMessage.mockImplementation(message => new Promise(resolve => {
        const items = JSON.parse(message.data.text);
        pending.set(items[0].id, () => resolve({
          success: true,
          translatedText: JSON.stringify(items.map(item => ({ ...item, text: `translated:${item.text}` }))),
        }));
      }));
      const first = { id: 'first', text: 'First', resolve: vi.fn() };
      const second = { id: 'second', text: 'Second', resolve: vi.fn() };
      const firstRequest = scheduler._executeBatchRequest(
        [first], { providerRegistryId: 'edge' }, scheduler.sessionContext, scheduler.translationSessionId
      );
      const secondRequest = scheduler._executeBatchRequest(
        [second], { providerRegistryId: 'edge' }, scheduler.sessionContext, scheduler.translationSessionId
      );

      pending.get('second')();
      await secondRequest;
      pending.get('first')();
      await firstRequest;

      expectSettlement(first.resolve, 'translated:First');
      expectSettlement(second.resolve, 'translated:Second');
      expect(getSettlement(first.resolve).state).toBe('pending');
      expect(getSettlement(second.resolve).state).toBe('pending');
      expect(safeSendMessage).toHaveBeenCalledTimes(2);
    });

    it.each([
      '[{"id":"a","text":"wrong"},{"id":"a","text":"duplicate"}]',
      '[{"id":"unknown","text":"wrong"}]',
      '{"unexpected":"object"}',
      'not JSON',
    ])('fails invalid identity or JSON without applying or retrying it: %s', async (response) => {
      const item = { id: 'a', text: 'original', resolve: vi.fn() };
      safeSendMessage.mockResolvedValue({ success: true, translatedText: response });
      await scheduler._executeBatchRequest([item], { providerRegistryId: 'custom' }, scheduler.sessionContext, scheduler.translationSessionId);
      expectSettlement(item.resolve, 'original');
      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(safeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('assigns separate identities to repeated text without dropping distinct nodes', async () => {
      const promises = [
        scheduler.enqueue('same text', null, 1, document.createTextNode('same text')),
        scheduler.enqueue('same text', null, 1, document.createTextNode('same text')),
      ];
      expect(new Set(scheduler.queue.map(item => item.id)).size).toBe(2);
      expect(scheduler.totalTasks).toBe(2);
      scheduler.stop();
      const settlements = await Promise.all(promises);
      expect(settlements.every(result => result.state === 'cancelled')).toBe(true);
    });

    it('rejects a delayed success from a different session even with a null context', async () => {
      scheduler.setTranslationState(true, 'old', null);
      let release;
      safeSendMessage.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const item = { id: 'old-item', text: 'original', resolve: vi.fn() };
      const pending = scheduler._executeBatchRequest([item], { providerRegistryId: 'custom' }, null, 'old');
      scheduler.setTranslationState(true, 'new', null);
      release({ success: true, translatedText: '[{"id":"old-item","text":"stale"}]' });
      await pending;
      expectSettlement(item.resolve, 'original');
      expect(getSettlement(item.resolve).state).toBe('cancelled');
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
    });
  });

  describe('Initialization & State', () => {
    it('holds completion while discovery is pending and rechecks when discovery drains', async () => {
      vi.useFakeTimers();
      try {
        const onLifecycleEvent = vi.fn();
        const context = {};
        const discovered = new PageTranslationScheduler({ onLifecycleEvent });
        discovered.setTranslationState(true, 'discovery-session', context);
        discovered.totalTasks = 1;
        discovered.translatedCount = 1;
        discovered.setDiscoveryPending(true, context);
        discovered._checkCompletion();
        await vi.advanceTimersByTimeAsync(500);
        expect(onLifecycleEvent).not.toHaveBeenCalled();

        expect(discovered.setDiscoveryPending(false, {})).toBe(false);
        expect(discovered.discoveryPending).toBe(true);
        expect(discovered.setDiscoveryPending(false, context)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(onLifecycleEvent).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_COMPLETE, expect.objectContaining({
          totalCount: 1,
          translatedCount: 1,
        }));
        discovered.reset();
      } finally {
        vi.useRealTimers();
      }
    });

    it('suppresses visibility idle while discovery is pending and clears the gate on stop/reset', async () => {
      vi.useFakeTimers();
      try {
        const onLifecycleEvent = vi.fn();
        const context = {};
        const discovered = new PageTranslationScheduler({ onLifecycleEvent });
        discovered.setTranslationState(true, 'visibility-session', context);
        discovered.isWaitingForVisibility = true;
        discovered.setDiscoveryPending(true, context);
        discovered._checkCompletion();
        await vi.advanceTimersByTimeAsync(500);
        expect(onLifecycleEvent).not.toHaveBeenCalled();

        discovered.stop();
        expect(discovered.discoveryPending).toBe(false);
        discovered.setTranslationState(true, 'replacement-session', context);
        discovered.setDiscoveryPending(true, context);
        discovered.reset();
        expect(discovered.discoveryPending).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not complete when a provider finishes between discovery slices', async () => {
      vi.useFakeTimers();
      try {
        const onLifecycleEvent = vi.fn();
        const context = {};
        const discovered = new PageTranslationScheduler({ onLifecycleEvent });
        discovered.setTranslationState(true, 'provider-session', context);
        discovered.setSettings({ autoTranslateOnDOMChanges: false });
        discovered.setDiscoveryPending(true, context);
        const item = { id: 'discovered-item', text: 'source', score: 1, resolve: vi.fn() };
        discovered.queue.push(item);
        discovered.totalTasks = 1;
        PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [item], remainingItems: [] });
        vi.spyOn(discovered, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
        safeSendMessage.mockResolvedValue({ success: true, translatedText: '["translated"]' });

        await discovered.flush();
        getSettlement(item.resolve).settle('accepted');
        await vi.advanceTimersByTimeAsync(500);
        expect(onLifecycleEvent).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_COMPLETE, expect.anything());

        discovered.setDiscoveryPending(false, context);
        await vi.advanceTimersByTimeAsync(500);
        expect(onLifecycleEvent).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_COMPLETE, expect.objectContaining({ totalCount: 1 }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses trusted lifecycle callback instead of aggregate PageEventBus transport', () => {
      const onLifecycleEvent = vi.fn();
      const directScheduler = new PageTranslationScheduler({ onLifecycleEvent });
      directScheduler.setTranslationState(true, 'direct-session', {});
      directScheduler.totalTasks = 3;
      directScheduler.translatedCount = 2;

      directScheduler._reportProgress(true);

      expect(onLifecycleEvent).toHaveBeenCalledWith(
        MessageActions.PAGE_TRANSLATE_PROGRESS,
        expect.objectContaining({ translatedCount: 2, totalCount: 3, sessionId: 'direct-session' })
      );
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(
        MessageActions.PAGE_TRANSLATE_PROGRESS,
        expect.anything()
      );
      directScheduler.reset();
    });

    it('attaches scheduler-owned identity to progress, complete, and idle lifecycle events', () => {
      const onLifecycleEvent = vi.fn();
      const directScheduler = new PageTranslationScheduler({ onLifecycleEvent });
      directScheduler.setTranslationState(true, 'direct-session', {});

      for (const action of [
        MessageActions.PAGE_TRANSLATE_PROGRESS,
        MessageActions.PAGE_TRANSLATE_COMPLETE,
        MessageActions.PAGE_TRANSLATE_IDLE,
      ]) {
        directScheduler._emitLifecycle(action, {});
      }

      expect(onLifecycleEvent.mock.calls).toEqual(expect.arrayContaining([
        [MessageActions.PAGE_TRANSLATE_PROGRESS, { sessionId: 'direct-session' }],
        [MessageActions.PAGE_TRANSLATE_COMPLETE, { sessionId: 'direct-session' }],
        [MessageActions.PAGE_TRANSLATE_IDLE, { sessionId: 'direct-session' }],
      ]));
      directScheduler.reset();
    });

    it('should initialize with correct default state', () => {
      expect(scheduler.isTranslated).toBe(true);
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.translationSessionId).toBe('test-session-123');
    });

    it('should reset state correctly', () => {
      scheduler.translatedCount = 10;
      scheduler.totalTasks = 20;
      scheduler.lastNonFatalError = { message: 'stale failure', type: 'RATE_LIMIT_REACHED' };
      scheduler.reset();
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.totalTasks).toBe(0);
      expect(scheduler.isTranslated).toBe(false);
      expect(scheduler.lastNonFatalError).toBeNull();
    });

    it('clears retained non-fatal error when a new session starts', () => {
      scheduler.lastNonFatalError = { message: 'stale failure', type: 'RATE_LIMIT_REACHED' };

      scheduler.setTranslationState(true, 'new-session', { pageTitle: 'New Page' });

      expect(scheduler.lastNonFatalError).toBeNull();
    });
  });

  describe('Queue Management', () => {
    it('should track high priority items correctly', () => {
      scheduler.enqueue('Normal priority', null, 0.5);
      expect(scheduler.highPriorityCount).toBe(0);
      
      scheduler.enqueue('High priority', null, 2); // score 2 > threshold 1
      expect(scheduler.highPriorityCount).toBe(1);
    });
  });

  describe('Cancellation Provenance', () => {
    const getCancelMessage = () => sendRegularMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === MessageActions.CANCEL_TRANSLATION);

    it('uses internal provenance for default stop', () => {
      sendRegularMessage.mockClear();

      scheduler.stop();

      expect(getCancelMessage()).toMatchObject({
        action: MessageActions.CANCEL_TRANSLATION,
        data: {
          cancelAll: true,
          context: 'page-translation-batch',
          sessionId: 'test-session-123',
          reason: 'operation-abort',
        },
      });
    });

    it('preserves explicit user provenance', () => {
      sendRegularMessage.mockClear();

      scheduler.stop('cancelled', ActionReasons.USER_STOPPED_PAGE_TRANSLATION);

      expect(getCancelMessage()?.data.reason).toBe(ActionReasons.USER_STOPPED_PAGE_TRANSLATION);
    });

    it('uses internal provenance for outer infrastructure failure', () => {
      const item = { text: 'Infrastructure failure', resolve: vi.fn(), score: 1 };
      const error = Object.assign(new Error('infrastructure failure'), { type: 'NETWORK_ERROR' });
      const sessionContext = scheduler.sessionContext;
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      sendRegularMessage.mockClear();

      expect(scheduler._handleOuterFlushFailure(error, 'test-session-123', sessionContext)).toBe(true);
      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.failedCount).toBe(1);
      expect(getCancelMessage()?.data.reason).toBe('operation-abort');
      expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
        error,
        errorType: 'NETWORK_ERROR',
        sessionId: 'test-session-123',
        sessionContext,
        context: 'page-translation-scheduler',
      }));
      expect(onFatalError).toHaveBeenCalledOnce();
    });

    it.each([
      'API_KEY_MISSING', 'API_KEY_INVALID', 'API_CONFIG_INVALID',
      'CIRCUIT_BREAKER_OPEN', 'EXTENSION_CONTEXT_INVALIDATED',
    ])('uses the real matcher to immediately escalate canonical %s despite legacy SERVER_ERROR', async canonicalType => {
      const matcher = await vi.importActual('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockImplementation(matcher.isFatalError);
      matchErrorToType.mockImplementation(matcher.matchErrorToType);
      const error = Object.assign(new Error(canonicalType), { type: canonicalType });

      await scheduler._handleBatchError(error, [{ text: canonicalType, resolve: vi.fn() }], 'SERVER_ERROR');

      expect(scheduler.fatalErrorOccurred).toBe(true);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      expect(onFatalError).toHaveBeenCalledOnce();
    });

    it('uses internal provenance for context invalidation', () => {
      const item = { text: 'Context failure', resolve: vi.fn(), score: 1 };
      const error = Object.assign(new Error('context invalidated'), { type: 'EXTENSION_CONTEXT_INVALIDATED' });
      const sessionContext = scheduler.sessionContext;
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      ExtensionContextManager.isContextError.mockReturnValueOnce(true);
      sendRegularMessage.mockClear();

      expect(scheduler._handleOuterFlushFailure(error, 'test-session-123', sessionContext)).toBe(true);
      expect(getSettlement(item.resolve).state).toBe('cancelled');
      expect(scheduler.failedCount).toBe(0);
      expect(getCancelMessage()?.data.reason).toBe('operation-abort');
      expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
        error,
        errorType: 'EXTENSION_CONTEXT_INVALIDATED',
        sessionId: 'test-session-123',
        sessionContext,
        context: 'page-translation-scheduler',
      }));
      expect(onFatalError).toHaveBeenCalledOnce();
    });

    it('does not call fatal callback for a stale outer flush', () => {
      const sessionContext = scheduler.sessionContext;

      expect(scheduler._handleOuterFlushFailure(
        new Error('stale failure'),
        'stale-session',
        sessionContext
      )).toBe(false);

      expect(onFatalError).not.toHaveBeenCalled();
    });

    it('uses internal provenance for reset session replacement', () => {
      sendRegularMessage.mockClear();

      scheduler.reset();

      expect(getCancelMessage()?.data).toMatchObject({
        sessionId: 'test-session-123',
        reason: 'operation-abort',
      });
      expect(scheduler.translationSessionId).toBeNull();
    });

    it('does not send remote cancellation without an active session', () => {
      scheduler.isTranslated = false;
      scheduler.translationSessionId = null;
      sendRegularMessage.mockClear();

      scheduler.stop();

      expect(sendRegularMessage).not.toHaveBeenCalled();
    });
  });

  describe('Batch Execution (Fluid Mode)', () => {
    const transientError = (type = 'NETWORK_ERROR') => Object.assign(new Error(type), { type });
    const outcome = (error, index) => scheduler._handleBatchError(error, [{
      id: `batch-${index}`, text: `item-${index}`, resolve: vi.fn(),
    }], error.type);

    it.each([1, 2])('keeps %i eligible network/server batch failures soft, then resets after success', async failureCount => {
      for (let index = 0; index < failureCount; index++) {
        await outcome(transientError(index % 2 ? 'SERVER_ERROR' : 'NETWORK_ERROR'), index);
      }
      expect(scheduler.fatalErrorOccurred).toBe(false);
      expect(onFatalError).not.toHaveBeenCalled();

      safeSendMessage.mockResolvedValue({ success: true, translatedText: '["same"]' });
      const successfulItem = { text: 'same', resolve: vi.fn() };
      await scheduler._executeBatchRequest([successfulItem], { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      expect(getSettlement(successfulItem.resolve).text).toBe('same');

      await outcome(transientError('NETWORK_ERROR'), 3);
      await outcome(transientError('SERVER_ERROR'), 4);
      await outcome(transientError('NETWORK_ERROR'), 5);
      expect(scheduler.fatalErrorOccurred).toBe(true);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it('escalates on the third failed batch, not on the number of failed items, and stops dispatch', async () => {
      scheduler.settings.maxConcurrentFlushes = 1;
      const items = Array.from({ length: 6 }, (_, index) => ({ text: `item-${index}`, resolve: vi.fn(), score: 1 }));
      scheduler.queue.push(...items);
      scheduler.totalTasks = items.length;
      let selectedBatches = 0;
      PageTranslationFluidFilter.process.mockImplementation(queue => {
        const batchSize = selectedBatches++ === 0 ? 3 : 1;
        return { batchItems: queue.slice(0, batchSize), remainingItems: queue.slice(batchSize) };
      });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({ success: false, error: 'offline', errorType: 'NETWORK_ERROR' });

      await scheduler.flush();

      expect(safeSendMessage).toHaveBeenCalledTimes(3);
      expect(scheduler.failedCount).toBe(5);
      expect(scheduler.fatalErrorOccurred).toBe(true);
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(items[5].resolve).not.toHaveBeenCalled();
    });

    it('uses completion order for concurrent AI workers when an older success follows two failures', async () => {
      vi.useFakeTimers();
      try {
        scheduler.settings.maxConcurrentFlushes = 4;
        const items = Array.from({ length: 4 }, (_, index) => ({ id: `worker-${index}`, text: `source-${index}`, resolve: vi.fn(), score: 1 }));
        scheduler.queue.push(...items);
        scheduler.totalTasks = items.length;
        PageTranslationFluidFilter.process.mockImplementation(queue => ({ batchItems: queue.slice(0, 1), remainingItems: queue.slice(1) }));
        vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'custom', targetLanguage: 'ja', parallelExecution: true });
        const responses = Array.from({ length: 4 }, () => {
          let resolve;
          return { promise: new Promise(done => { resolve = done; }), resolve };
        });
        safeSendMessage.mockImplementation(() => responses[safeSendMessage.mock.calls.length - 1].promise);

        const flush = scheduler.flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(safeSendMessage).toHaveBeenCalledTimes(4);

        responses[1].resolve({ success: false, error: 'temporary', errorType: 'NETWORK_ERROR' });
        await vi.advanceTimersByTimeAsync(0);
        responses[2].resolve({ success: false, error: 'temporary', errorType: 'SERVER_ERROR' });
        await vi.advanceTimersByTimeAsync(0);
        responses[0].resolve({ success: true, translatedText: '[{"id":"worker-0","text":"translated-0"}]' });
        await vi.advanceTimersByTimeAsync(0);
        responses[3].resolve({ success: false, error: 'temporary', errorType: 'NETWORK_ERROR' });
        await vi.advanceTimersByTimeAsync(0);
        await flush;
        await vi.runAllTimersAsync();

        expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
        expect(scheduler.fatalErrorOccurred).toBe(false);
        expect(onFatalError).not.toHaveBeenCalled();
        expect(getSettlement(items[0].resolve).text).toBe('translated-0');
        expect(items.slice(1).map(item => getSettlement(item.resolve).state)).toEqual(['failed', 'failed', 'failed']);
        getSettlement(items[0].resolve).settle('accepted');
        expect(scheduler.translatedCount).toBe(1);
        expect(scheduler.failedCount).toBe(3);
        expect(items.map(item => item.resolve).every(resolve => resolve.mock.calls.length === 1)).toBe(true);
      } finally {
        scheduler.stop();
        vi.useRealTimers();
      }
    });

    it('escalates once at three concurrent failed workers and ignores late sibling outcomes', async () => {
      vi.useFakeTimers();
      try {
        scheduler.settings.maxConcurrentFlushes = 5;
        const items = Array.from({ length: 5 }, (_, index) => ({ id: `fatal-worker-${index}`, text: `source-${index}`, resolve: vi.fn(), score: 1 }));
        scheduler.queue.push(...items);
        scheduler.totalTasks = items.length;
        PageTranslationFluidFilter.process.mockImplementation(queue => ({ batchItems: queue.slice(0, 1), remainingItems: queue.slice(1) }));
        vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'custom', targetLanguage: 'ja', parallelExecution: true });
        const requests = Array.from({ length: 5 }, () => {
          let resolve;
          let reject;
          const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
          return { promise, resolve, reject };
        });
        safeSendMessage.mockImplementation(() => requests[safeSendMessage.mock.calls.length - 1].promise);
        onFatalError.mockImplementation(() => scheduler.stop());

        const flush = scheduler.flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(safeSendMessage).toHaveBeenCalledTimes(5);
        for (const index of [1, 2, 0]) {
          requests[index].resolve({ success: false, error: 'offline', errorType: 'NETWORK_ERROR' });
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(scheduler.fatalErrorOccurred).toBe(true);
        expect(onFatalError).toHaveBeenCalledOnce();

        requests[3].resolve({ success: true, translatedText: '["too-late"]' });
        requests[4].reject(new Error('late transport rejection'));
        await vi.advanceTimersByTimeAsync(0);
        await flush;
        await vi.runAllTimersAsync();

        expect(onFatalError).toHaveBeenCalledOnce();
        expect(items.map(item => item.resolve.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
        expect(getSettlement(items[3].resolve).state).toBe('cancelled');
        expect(getSettlement(items[4].resolve).state).toBe('cancelled');
        expect(scheduler.translatedCount).toBe(0);
      } finally {
        scheduler.stop();
        vi.useRealTimers();
      }
    });

    it('counts a batch outcome once and ignores noneligible soft failures for the streak', async () => {
      const batch = [{ text: 'retry', resolve: vi.fn() }];
      const first = transientError();
      await scheduler._handleBatchError(first, batch, 'NETWORK_ERROR');
      await scheduler._handleBatchError(first, batch, 'NETWORK_ERROR');
      await outcome(Object.assign(new Error('rate limited'), { type: 'RATE_LIMIT_REACHED' }), 2);
      await outcome(transientError('SERVER_ERROR'), 3);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(2);
      expect(scheduler.fatalErrorOccurred).toBe(false);
      expect(pageEventBus.emit.mock.calls.filter(([event]) => event === 'page-translation-internal-error')).toHaveLength(3);
    });

    it('does not reset the streak when translated DOM acceptance is pending', async () => {
      await outcome(transientError(), 1);
      const item = { text: 'source', resolve: vi.fn() };
      safeSendMessage.mockResolvedValue({ success: true, translatedText: '["translated"]' });
      await scheduler._executeBatchRequest([item], { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      expect(getSettlement(item.resolve).state).toBe('pending');
      await outcome(transientError('SERVER_ERROR'), 2);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(getSettlement(item.resolve).state).toBe('pending');
      expect(getSettlement(item.resolve).settle('accepted')).toBe(true);
      expect(scheduler.translatedCount).toBe(1);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
    });

    it('does not reset the streak for malformed successful responses', async () => {
      await outcome(transientError(), 1);
      safeSendMessage.mockResolvedValue({ success: true, translatedText: 'not-json' });
      const item = { text: 'original', resolve: vi.fn() };

      await scheduler._executeBatchRequest([item], { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);

      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(getSettlement(item.resolve).state).toBe('failed');
    });

    it('resets the streak for a valid all-skipped provider response', async () => {
      await outcome(transientError(), 1);
      safeSendMessage.mockResolvedValue({ success: true, translatedText: '[{"text":"original","isSkipped":true}]' });
      const item = { text: 'original', resolve: vi.fn() };

      await scheduler._executeBatchRequest([item], { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);

      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      expect(getSettlement(item.resolve).state).toBe('failed');
    });

    it('does not let a duplicate successful batch outcome reset a later streak', async () => {
      await outcome(transientError(), 1);
      const item = { text: 'same', resolve: vi.fn() };
      const batch = [item];
      safeSendMessage.mockResolvedValue({ success: true, translatedText: '["translated"]' });
      await scheduler._executeBatchRequest(batch, { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);
      await outcome(transientError('SERVER_ERROR'), 2);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);

      await scheduler._executeBatchRequest(batch, { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);

      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(item.resolve).toHaveBeenCalledTimes(1);
    });

    it.each(['success', 'error'])('ignores stale %s after replacement without changing the new session streak', async lateOutcome => {
      let resolveOld;
      let rejectOld;
      safeSendMessage.mockImplementationOnce(() => new Promise((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      }));
      const oldItem = { text: 'old', resolve: vi.fn() };
      const oldSessionId = scheduler.translationSessionId;
      const oldContext = scheduler.sessionContext;
      const oldRequest = scheduler._executeBatchRequest([oldItem], { providerRegistryId: 'google' }, oldContext, oldSessionId);

      scheduler.setTranslationState(true, 'replacement-session', { replacement: true });
      await outcome(transientError(), 20);
      const failedCount = scheduler.failedCount;
      const notificationCount = onFatalError.mock.calls.length;
      if (lateOutcome === 'success') resolveOld({ success: true, translatedText: '["stale"]' });
      else rejectOld(transientError('NETWORK_ERROR'));
      await oldRequest;

      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(scheduler.failedCount).toBe(failedCount);
      expect(onFatalError).toHaveBeenCalledTimes(notificationCount);
      expect(getSettlement(oldItem.resolve).state).toBe('cancelled');
    });

    it('does not let a stopped request reset the next session streak when it succeeds late', async () => {
      let resolveOld;
      safeSendMessage.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
      const oldItem = { text: 'old', resolve: vi.fn() };
      const oldRequest = scheduler._executeBatchRequest([oldItem], { providerRegistryId: 'google' }, scheduler.sessionContext, scheduler.translationSessionId);

      scheduler.stop();
      scheduler.setTranslationState(true, 'after-stop', { replacement: true });
      await outcome(transientError(), 30);
      resolveOld({ success: true, translatedText: '["stale"]' });
      await oldRequest;

      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(getSettlement(oldItem.resolve).state).toBe('cancelled');
    });

    it('resets the streak on replacement, stop, and reset but not redundant state updates', async () => {
      await outcome(transientError(), 1);
      const originalContext = scheduler.sessionContext;
      scheduler.setTranslationState(true, 'test-session-123', originalContext);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      scheduler.setTranslationState(true, 'replacement', {});
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      await outcome(transientError(), 2);
      scheduler.stop();
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      scheduler.setTranslationState(true, 'after-stop', {});
      await outcome(transientError(), 3);
      scheduler.reset();
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
    });

    it('keeps eligible failures soft through the threshold when fatality is explicitly false', async () => {
      isFatalError.mockReturnValue(false);
      await outcome(Object.assign(transientError(), { isFatal: false }), 1);
      await outcome(Object.assign(transientError('SERVER_ERROR'), { isFatal: false }), 2);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(2);
      expect(scheduler.fatalErrorOccurred).toBe(false);
    });

    it.each([
      ['explicit fatal', Object.assign(transientError(), { isFatal: true })],
      ['fatal HTTP status', Object.assign(transientError('SERVER_ERROR'), { statusCode: 403 })],
      ['canonical fatal classification', Object.assign(transientError('SERVER_ERROR'), { canonicalFatal: true })],
      ['context error', Object.assign(transientError(), { contextFailure: true })],
    ])('lets %s classification take precedence over transient streak rules', async (_label, error) => {
      isFatalError.mockImplementation(candidate => candidate?.statusCode === 403 || candidate?.canonicalFatal === true);
      ExtensionContextManager.isContextError.mockImplementation(candidate => candidate?.contextFailure === true);

      await outcome(error, 1);

      expect(scheduler.fatalErrorOccurred).toBe(true);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(0);
      expect(onFatalError).toHaveBeenCalledOnce();
    });

    it('defers success accounting until settlement acceptance', async () => {
      const mockItem = { text: 'Hello', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['سلام'])
      });

      await scheduler.flush();

      const settlement = getSettlement(mockItem.resolve);
      expect(settlement.state).toBe('pending');
      expect(scheduler.translatedCount).toBe(0);
      settlement.settle('stale');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(1);
    });

    it('cancels pending settlements without manufacturing failure counts', async () => {
      const mockItem = { text: 'Hello', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['سلام'])
      });

      await scheduler.flush();

      const settlement = getSettlement(mockItem.resolve);
      scheduler.stop();
      expect(settlement.state).toBe('cancelled');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(0);
      expect(settlement.settle('accepted')).toBe(false);
    });

    it('emits completion once after stale settlement', async () => {
      vi.useFakeTimers();
      try {
        const emitSpy = vi.spyOn(pageEventBus, 'emit');
        const mockItem = { text: 'Hello', resolve: vi.fn(), score: 1 };
        scheduler.queue.push(mockItem);
        scheduler.totalTasks = 1;
        PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
        vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
        safeSendMessage.mockResolvedValue({
          success: true,
          translatedText: JSON.stringify(['سلام'])
        });

        await scheduler.flush();
        getSettlement(mockItem.resolve).settle('stale');
        await vi.advanceTimersByTimeAsync(600);

        expect(emitSpy.mock.calls.filter(([event]) => event === MessageActions.PAGE_TRANSLATE_COMPLETE))
          .toHaveLength(1);
        emitSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('continues after a non-fatal batch failure and completes once', async () => {
      const failedItem = { text: 'Failed', resolve: vi.fn(), score: 1 };
      const translatedItem = { text: 'Translated', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(failedItem, translatedItem);
      scheduler.totalTasks = 2;

      PageTranslationFluidFilter.process
        .mockReturnValueOnce({ batchItems: [failedItem], remainingItems: [translatedItem] })
        .mockReturnValueOnce({ batchItems: [translatedItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage
        .mockResolvedValueOnce({ success: false, error: 'Temporary provider failure', errorType: 'UNKNOWN' })
        .mockResolvedValueOnce({ success: true, translatedText: JSON.stringify(['translated']) });
      const emitSpy = vi.spyOn(pageEventBus, 'emit');

      await scheduler.flush();

      expect(safeSendMessage).toHaveBeenCalledTimes(2);
      expect(scheduler.fatalErrorOccurred).toBe(false);
      expectSettlement(failedItem.resolve, 'Failed');
      expectSettlement(translatedItem.resolve, 'translated');
      getSettlement(failedItem.resolve).settle('failed');
      getSettlement(translatedItem.resolve).settle('accepted');
      await new Promise(resolve => setTimeout(resolve, 600));

      expect(scheduler.failedCount).toBe(1);
      expect(scheduler.translatedCount).toBe(1);
      const completion = emitSpy.mock.calls.find(([event]) => event === MessageActions.PAGE_TRANSLATE_COMPLETE)?.[1];
      expect(completion).toMatchObject({ translatedCount: 1, failedCount: 1 });
      expect(completion).not.toHaveProperty('errorDetails');
      emitSpy.mockRestore();
    });

    it.each([1, 2])('emits the latest eligible transient cause for zero-result completion after %i failed batches', async failureCount => {
      vi.useFakeTimers();
      try {
        const emitSpy = vi.spyOn(pageEventBus, 'emit');
        scheduler.totalTasks = failureCount;
        for (let index = 0; index < failureCount; index++) {
          const type = index % 2 ? 'SERVER_ERROR' : 'NETWORK_ERROR';
          await scheduler._handleBatchError(
            transientError(type),
            [{ text: `failed-${index}`, resolve: vi.fn() }],
            type
          );
        }

        scheduler._checkCompletion();
        await vi.runAllTimersAsync();

        const completion = emitSpy.mock.calls.find(([event]) => event === MessageActions.PAGE_TRANSLATE_COMPLETE)?.[1];
        expect(completion).toMatchObject({
          translatedCount: 0,
          failedCount: failureCount,
          errorDetails: {
            message: failureCount === 1 ? 'NETWORK_ERROR' : 'SERVER_ERROR',
            type: failureCount === 1 ? 'NETWORK_ERROR' : 'SERVER_ERROR',
          },
        });
        expect(completion.errorDetails).not.toHaveProperty('statusCode');
        expect(scheduler.translatedCount).toBe(0);
        emitSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains retryable HTTP metadata for zero-result completion', async () => {
      vi.useFakeTimers();
      try {
        const item = { text: 'HTTP failure', resolve: vi.fn(), score: 1 };
        scheduler.queue.push(item);
        scheduler.totalTasks = 1;
        PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [item], remainingItems: [] });
        vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
        safeSendMessage.mockResolvedValue({
          success: false,
          error: 'Conflict',
          errorType: ErrorTypes.HTTP_ERROR,
          errorDetails: {
            message: 'Conflict',
            type: ErrorTypes.HTTP_ERROR,
            statusCode: 409,
          },
        });

        await scheduler.flush();
        await vi.runAllTimersAsync();

        const completion = pageEventBus.emit.mock.calls
          .find(([event]) => event === MessageActions.PAGE_TRANSLATE_COMPLETE)?.[1];
        expect(completion?.errorDetails).toEqual({
          message: 'Conflict',
          type: ErrorTypes.HTTP_ERROR,
          statusCode: 409,
        });
        expect(scheduler.fatalErrorOccurred).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should process a successful batch translation', async () => {
      const mockItem = { text: 'Hello', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      
      PageTranslationFluidFilter.process.mockReturnValue({
        batchItems: [mockItem],
        remainingItems: [],
        purgedCount: 0,
        ejectedItems: []
      });

      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa'
      });

      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['سلام'])
      });

      await scheduler.flush();

      expect(safeSendMessage).toHaveBeenCalled();
       expectSettlement(mockItem.resolve, 'سلام');
       getSettlement(mockItem.resolve).settle('accepted');
       expect(scheduler.translatedCount).toBe(1);
    });

    it.each(['', '   ', '\n\t'])('should preserve original and count blank result as failed: %j', async (blankText) => {
      const mockItem = { text: 'Original', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify([blankText])
      });

      await scheduler.flush();

       expectSettlement(mockItem.resolve, 'Original');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(1);
    });

    it('should preserve original and count null result as failed', async () => {
      const mockItem = { text: 'Original', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify([null])
      });

      await scheduler.flush();

       expectSettlement(mockItem.resolve, 'Original');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(1);
    });

    it('should continue valid siblings around a blank result', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      const itemC = { text: 'C', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(itemA, itemB, itemC);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [itemA, itemB, itemC], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['A2', '', 'C2'])
      });

      await scheduler.flush();

       expectSettlement(itemA.resolve, 'A2');
       expectSettlement(itemB.resolve, 'B');
       expectSettlement(itemC.resolve, 'C2');
       getSettlement(itemA.resolve).settle('accepted');
       getSettlement(itemC.resolve).settle('accepted');
      expect(scheduler.translatedCount).toBe(2);
      expect(scheduler.failedCount).toBe(1);
    });

    it('should complete all-blank batches through failed accounting', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(itemA, itemB);
      scheduler.totalTasks = 2;

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [itemA, itemB], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['', '   '])
      });

      await scheduler.flush();

       expectSettlement(itemA.resolve, 'A');
       expectSettlement(itemB.resolve, 'B');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(2);
      expect(scheduler.translatedCount + scheduler.failedCount).toBe(scheduler.totalTasks);
      expect(scheduler.activeFlushes).toBe(0);
      expect(scheduler.queue).toHaveLength(0);
    });

    it('should count blank and explicit skipped results once each', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(itemA, itemB);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [itemA, itemB], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['', { text: 'B', isSkipped: true }])
      });

      await scheduler.flush();

      expect(itemA.resolve).toHaveBeenCalledTimes(1);
       expectSettlement(itemA.resolve, 'A');
      expect(itemB.resolve).toHaveBeenCalledTimes(1);
       expectSettlement(itemB.resolve, 'B');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(2);
    });

    it('should honor isSkipped items in a mixed partial result', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      const itemC = { text: 'C', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(itemA, itemB, itemC);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [itemA, itemB, itemC], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['A2', { text: 'B', isSkipped: true }, 'C2'])
      });

      await scheduler.flush();

       expectSettlement(itemA.resolve, 'A2');
       expectSettlement(itemB.resolve, 'B');
       expectSettlement(itemC.resolve, 'C2');
       getSettlement(itemA.resolve).settle('accepted');
       getSettlement(itemC.resolve).settle('accepted');
      expect(scheduler.translatedCount).toBe(2);
      expect(scheduler.failedCount).toBe(1);
    });

    it('should preserve originals without counting translated when all items are skipped', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(itemA, itemB);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [itemA, itemB], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify([{ text: 'A', isSkipped: true }, { text: 'B', isSkipped: true }])
      });

      await scheduler.flush();

       expectSettlement(itemA.resolve, 'A');
       expectSettlement(itemB.resolve, 'B');
      expect(scheduler.translatedCount).toBe(0);
      expect(scheduler.failedCount).toBe(2);
    });

    it('should not treat identity translations as skipped', async () => {
      const mockItem = { text: 'URL', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['URL'])
      });

      await scheduler.flush();

       expectSettlement(mockItem.resolve, 'URL');
       getSettlement(mockItem.resolve).settle('accepted');
       expect(scheduler.translatedCount).toBe(1);
      expect(scheduler.failedCount).toBe(0);
    });

    it('keeps a terminal server batch failure soft and falls back to original text', async () => {
      const mockItem = { text: 'Failed Text', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      safeSendMessage.mockResolvedValue({
        success: false,
        error: 'Rate limit',
        errorType: 'SERVER_ERROR'
      });
      const emitSpy = vi.spyOn(pageEventBus, 'emit');

      await scheduler.flush();

       expectSettlement(mockItem.resolve, 'Failed Text');
      expect(scheduler.translatedCount).toBe(0);
      const internalError = emitSpy.mock.calls.find(([event]) => event === 'page-translation-internal-error')?.[1];
      expect(internalError.error.type).toBe('SERVER_ERROR');
      expect(internalError.errorType).toBe('SERVER_ERROR');
      expect(internalError.isFatal).toBe(false);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(1);
      expect(onFatalError).not.toHaveBeenCalled();
      emitSpy.mockRestore();
    });

    it('does not treat DeepL HTTP 529 rate limits as session-fatal', async () => {
      const mockItem = { text: 'Rate limited Text', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);

      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'deepl', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: false,
        error: 'Too Many Requests',
        errorType: 'RATE_LIMIT_REACHED',
        errorDetails: {
          message: 'Too Many Requests',
          type: 'RATE_LIMIT_REACHED',
          statusCode: 529,
        },
      });
      const emitSpy = vi.spyOn(pageEventBus, 'emit');

      await scheduler.flush();

      expectSettlement(mockItem.resolve, 'Rate limited Text');
      const internalError = emitSpy.mock.calls.find(([event]) => event === 'page-translation-internal-error')?.[1];
      expect(internalError.error).toMatchObject({ type: 'RATE_LIMIT_REACHED', statusCode: 529 });
      expect(internalError.errorType).toBe('RATE_LIMIT_REACHED');
      expect(internalError.isFatal).toBe(false);
      expect(scheduler.fatalErrorOccurred).toBe(false);
      expect(onFatalError).not.toHaveBeenCalled();
      emitSpy.mockRestore();
    });

    it.each([
      [400, false],
      [404, true],
      [422, false],
      [409, false],
      [500, false],
    ])('passes structured HTTP %s to fatality evaluation', async (statusCode, expectedFatal) => {
      const mockItem = { text: 'HTTP failure', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: false,
        error: 'HTTP failure',
        errorType: 'HTTP_ERROR',
        errorDetails: {
          message: 'HTTP failure',
          type: 'HTTP_ERROR',
          statusCode,
        },
      });

      await scheduler.flush();

      expect(isFatalError).toHaveBeenCalledWith(expect.objectContaining({
        type: 'HTTP_ERROR',
        statusCode,
      }));
      expect(scheduler.fatalErrorOccurred).toBe(expectedFatal);
      expect(onFatalError).toHaveBeenCalledTimes(expectedFatal ? 1 : 0);
      expectSettlement(mockItem.resolve, 'HTTP failure');
    });

    it('reconstructs canonical Page batch error identity from transport DTO', async () => {
      const mockItem = { text: 'Failed Text', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      const errorDetails = {
        message: 'Provider failed',
        type: 'PROVIDER_ERROR',
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        context: 'page-batch',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        translationOutcome: { partial: true },
        cause: 'private',
        arbitrary: { ignored: true }
      };
      safeSendMessage.mockResolvedValue({
        success: false,
        translatedText: JSON.stringify([{ text: 'Failed Text' }]),
        hasError: true,
        error: 'Provider failed',
        errorType: 'SERVER_ERROR',
        errorDetails,
        isFatal: false
      });
      const emitSpy = vi.spyOn(pageEventBus, 'emit');

      await scheduler.flush();

      const internalError = emitSpy.mock.calls.find(([event]) => event === 'page-translation-internal-error')?.[1];
      expect(internalError.error).toMatchObject({
        message: 'Provider failed',
        type: 'PROVIDER_ERROR',
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        context: 'page-batch',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        translationOutcome: { partial: true }
      });
      expect(internalError.error).not.toHaveProperty('cause');
      expect(internalError.error).not.toHaveProperty('arbitrary');
      expect(internalError.errorType).toBe('SERVER_ERROR');
      expect(internalError.isFatal).toBe(false);
      expect(scheduler.fatalErrorOccurred).toBe(false);
       expectSettlement(mockItem.resolve, 'Failed Text');
      emitSpy.mockRestore();
    });
  });

  describe('Batch Execution (On Stop Mode)', () => {
    it('should use QueueFilter when translateAfterScrollStop is enabled', async () => {
      scheduler.settings.translateAfterScrollStop = true;
      const mockItem = { text: 'Queue', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      
      PageTranslationQueueFilter.process.mockReturnValue({
        batchItems: [mockItem],
        remainingItems: []
      });

      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['صف'])
      });

      await scheduler.flush();

      expect(PageTranslationQueueFilter.process).toHaveBeenCalled();
       expectSettlement(mockItem.resolve, 'صف');
    });
  });

  describe('Fault Tolerance & Integrity', () => {
    it('escalates immediately when the internal error callback throws infrastructure failure', async () => {
      const item = { text: 'Callback failure', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [item], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      safeSendMessage.mockResolvedValue({ success: false, error: 'offline', errorType: 'UNKNOWN' });
      scheduler.onInternalError = vi.fn(() => { throw new Error('internal callback invariant failed'); });

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.fatalErrorOccurred).toBe(true);
      expect(onFatalError).toHaveBeenCalledOnce();
      expect(scheduler.activeFlushes).toBe(0);
    });

    it('should stop and mark fatal error', async () => {
      const mockItem = { text: 'Fatal', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });
      
      safeSendMessage.mockResolvedValue({
        success: false,
        error: 'Fatal',
        isFatal: true,
        errorType: 'EXTENSION_CONTEXT_INVALIDATED'
      });

      await scheduler.flush();

      expect(scheduler.fatalErrorOccurred).toBe(true);
       expectSettlement(mockItem.resolve, 'Fatal');
    });

    it('should discard and resolve original if context changes during request', async () => {
      const initialContext = { id: 'ctx1' };
      scheduler.setTranslationState(true, 'tid', initialContext);

      const mockItem = { text: 'Old Context', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(mockItem);
      
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: [mockItem], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({ providerRegistryId: 'google', targetLanguage: 'fa' });

      safeSendMessage.mockImplementation(async () => {
        scheduler.sessionContext = { id: 'ctx2' };
        return { success: true, translatedText: JSON.stringify(['جدید']) };
      });

      await scheduler.flush();

       expectSettlement(mockItem.resolve, 'Old Context');
      expect(scheduler.translatedCount).toBe(0);
    });

    it('settles queued items and escalates once when batch config fails', async () => {
      const item = { text: 'Config failure', resolve: vi.fn(), score: 1 };
      const error = new Error('config unavailable');
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      vi.spyOn(scheduler, '_getBatchConfig').mockRejectedValueOnce(error);

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.isTranslated).toBe(false);
      expect(scheduler.activeFlushes).toBe(0);
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_COMPLETE, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('cancels owned items silently when batch config loses context', async () => {
      const item = { text: 'Context failure', resolve: vi.fn(), score: 1 };
      const error = Object.assign(new Error('context invalidated'), { type: 'EXTENSION_CONTEXT_INVALIDATED' });
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      ExtensionContextManager.isContextError.mockReturnValueOnce(true);
      vi.spyOn(scheduler, '_getBatchConfig').mockRejectedValueOnce(error);

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('cancelled');
      expect(scheduler.failedCount).toBe(0);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['fluid', false, PageTranslationFluidFilter],
      ['queue', true, PageTranslationQueueFilter],
    ])('settles items when %s filter throws', async (_name, translateAfterScrollStop, filter) => {
      const item = { text: 'Filter failure', resolve: vi.fn(), score: 1 };
      const error = new Error('filter invariant failed');
      scheduler.settings.translateAfterScrollStop = translateAfterScrollStop;
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      filter.process.mockImplementationOnce(() => { throw error; });

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.activeFlushes).toBe(0);
    });

    it('settles items when a filter returns malformed ownership data', async () => {
      const item = { text: 'Malformed result', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      PageTranslationFluidFilter.process.mockReturnValueOnce({ batchItems: [item] });

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.queue).toHaveLength(0);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it('settles a batch after it leaves queue ownership and execution fails outside its handler', async () => {
      const item = { text: 'Owned batch', resolve: vi.fn(), score: 1 };
      const error = new Error('batch boundary failure');
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      PageTranslationFluidFilter.process.mockReturnValueOnce({ batchItems: [item], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      vi.spyOn(scheduler, '_executeBatchRequest').mockRejectedValueOnce(error);

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.activeBatches.size).toBe(0);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it('settles a batch when MessageFormat fails before batch error handling', async () => {
      const item = { text: 'Message failure', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(item);
      scheduler.totalTasks = 1;
      PageTranslationFluidFilter.process.mockReturnValueOnce({ batchItems: [item], remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      vi.spyOn(MessageFormat, 'create').mockImplementationOnce(() => {
        throw new Error('message construction failure');
      });

      await scheduler.flush();

      expect(getSettlement(item.resolve).state).toBe('failed');
      expect(scheduler.activeBatches.size).toBe(0);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it('preserves partial accounting during outer failure', async () => {
      const item = { text: 'Remaining work', resolve: vi.fn(), score: 1 };
      scheduler.translatedCount = 2;
      scheduler.failedCount = 1;
      scheduler.totalTasks = 4;
      scheduler.queue.push(item);
      vi.spyOn(scheduler, '_getBatchConfig').mockRejectedValueOnce(new Error('infrastructure failure'));

      await scheduler.flush();

      expect(scheduler.translatedCount).toBe(2);
      expect(scheduler.failedCount).toBe(2);
      expect(scheduler.totalTasks).toBe(4);
      expect(getSettlement(item.resolve).state).toBe('failed');
    });

    it('terminates concurrent session flushes with one fatal escalation', async () => {
      const itemA = { text: 'A', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B', resolve: vi.fn(), score: 1 };
      let releaseSecond;
      const secondRequest = new Promise(resolve => { releaseSecond = resolve; });
      scheduler.settings.maxConcurrentFlushes = 2;
      scheduler.queue.push(itemA, itemB);
      scheduler.totalTasks = 2;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      vi.spyOn(scheduler, '_executeBatchRequest')
        .mockRejectedValueOnce(new Error('shared infrastructure failure'))
        .mockImplementationOnce(() => secondRequest);

      const firstFlush = scheduler.flush();
      const secondFlush = scheduler.flush();
      await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1));

      expect(getSettlement(itemA.resolve).state).toBe('failed');
      expect(getSettlement(itemB.resolve).state).toBe('failed');
      expect(scheduler.activeFlushes).toBe(0);
      releaseSecond({});
      await Promise.all([firstFlush, secondFlush]);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    });

    it('does not let an old flush touch a newer session after config resolves', async () => {
      const oldItem = { text: 'Old', resolve: vi.fn(), score: 1 };
      let resolveConfig;
      const config = new Promise(resolve => { resolveConfig = resolve; });
      scheduler.queue.push(oldItem);
      scheduler.totalTasks = 1;
      vi.spyOn(scheduler, '_getBatchConfig').mockReturnValueOnce(config);
      const filterSpy = vi.spyOn(PageTranslationFluidFilter, 'process');

      const oldFlush = scheduler.flush();
      await vi.waitFor(() => expect(scheduler._getBatchConfig).toHaveBeenCalled());

      scheduler.stop();
      scheduler.setTranslationState(true, 'new-session', { session: 'new' });
      const newItem = { text: 'New', resolve: vi.fn(), score: 1 };
      scheduler.queue.push(newItem);
      scheduler.totalTasks = 1;

      resolveConfig({ providerRegistryId: 'google', targetLanguage: 'fa' });
      await oldFlush;

      expect(filterSpy).not.toHaveBeenCalled();
      expect(scheduler.queue).toEqual([newItem]);
      expect(newItem.resolve).not.toHaveBeenCalled();
      expect(scheduler.activeFlushes).toBe(0);
      expect(onFatalError).not.toHaveBeenCalled();
    });

    it('settles stale batch failure without poisoning newer session state', async () => {
      const oldItem = { text: 'Old', resolve: vi.fn(), score: 1 };
      const newItem = { text: 'New', resolve: vi.fn(), score: 1 };
      let rejectOld;
      let resolveNew;
      const oldRequest = new Promise((_resolve, reject) => { rejectOld = reject; });
      const newRequest = new Promise(resolve => { resolveNew = resolve; });
      const newContext = { session: 'new' };
      scheduler.queue.push(oldItem);
      scheduler.totalTasks = 1;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      safeSendMessage
        .mockImplementationOnce(() => oldRequest)
        .mockImplementationOnce(() => newRequest);

      const oldFlush = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(1));

      scheduler.stop();
      scheduler.setTranslationState(true, 'new-session', newContext);
      scheduler.queue.push(newItem);
      scheduler.totalTasks = 1;
      const newFlush = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(2));

      const queueBeforeStaleFailure = [...scheduler.queue];
      const activeBatchesBeforeStaleFailure = scheduler.activeBatches.size;
      const failedCountBeforeStaleFailure = scheduler.failedCount;
      const transientFailuresBeforeStaleFailure = scheduler.consecutiveTransientBatchFailures;
      rejectOld(new Error('stale Session A failure'));
      await oldFlush;

      expect(getSettlement(oldItem.resolve).state).toBe('cancelled');
      expect(scheduler.fatalErrorOccurred).toBe(false);
      expect(onFatalError).not.toHaveBeenCalled();
      expect(pageEventBus.emit.mock.calls.some(([event]) => event === 'page-translation-internal-error')).toBe(false);
      expect(scheduler.translationSessionId).toBe('new-session');
      expect(scheduler.sessionContext).toBe(newContext);
      expect(scheduler.queue).toEqual(queueBeforeStaleFailure);
      expect(scheduler.activeBatches.size).toBe(activeBatchesBeforeStaleFailure);
      expect(scheduler.failedCount).toBe(failedCountBeforeStaleFailure);
      expect(scheduler.consecutiveTransientBatchFailures).toBe(transientFailuresBeforeStaleFailure);
      expect(newItem.resolve).not.toHaveBeenCalled();

      resolveNew({ success: true, translatedText: JSON.stringify(['new']) });
      await newFlush;
    });

    it('does not let a stopped flush decrement a newer session counter', async () => {
      const oldResponse = {};
      const newResponse = {};
      let resolveOld;
      let resolveNew;
      const oldRequest = new Promise(resolve => { resolveOld = resolve; });
      const newRequest = new Promise(resolve => { resolveNew = resolve; });
      const oldItem = { text: 'Old', resolve: vi.fn(), score: 1 };
      const newItem = { text: 'New', resolve: vi.fn(), score: 1 };

      scheduler.queue.push(oldItem);
      scheduler.totalTasks = 1;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      safeSendMessage
        .mockImplementationOnce(() => oldRequest)
        .mockImplementationOnce(() => newRequest);

      const oldFlush = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(1));
      expect(scheduler.activeFlushes).toBe(1);
      const completionSpy = vi.spyOn(scheduler, '_checkCompletion');

      scheduler.stop();
      scheduler.setTranslationState(true, 'new-session', { session: 'new' });
      scheduler.queue.push(newItem);
      scheduler.totalTasks = 1;

      const newFlush = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(2));
      expect(scheduler.activeFlushes).toBe(1);

      resolveOld(oldResponse);
      await oldFlush;
      expect(scheduler.activeFlushes).toBe(1);
      expect(completionSpy).not.toHaveBeenCalled();
      expect(newItem.resolve).not.toHaveBeenCalled();

      resolveNew(newResponse);
      await newFlush;
      expect(scheduler.activeFlushes).toBe(0);
    });

    it('keeps independent batch results attached to their own items when completion reverses', async () => {
      const itemA = { text: 'A1', resolve: vi.fn(), score: 1 };
      const itemB = { text: 'B1', resolve: vi.fn(), score: 1 };
      const resolveA = {};
      const resolveB = {};
      const responseA = new Promise(resolve => { resolveA.resolve = resolve; });
      const responseB = new Promise(resolve => { resolveB.resolve = resolve; });

      scheduler.settings.maxConcurrentFlushes = 2;
      scheduler.queue.push(itemA, itemB);
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      safeSendMessage
        .mockImplementationOnce(() => responseA)
        .mockImplementationOnce(() => responseB);

      const flushA = scheduler.flush();
      const flushB = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(2));

      resolveB.resolve({ success: true, translatedText: JSON.stringify(['TB1']) });
      await flushB;
      expectSettlement(itemB.resolve, 'TB1');
      expect(itemA.resolve).not.toHaveBeenCalled();

      resolveA.resolve({ success: true, translatedText: JSON.stringify(['TA1']) });
      await flushA;
      expectSettlement(itemA.resolve, 'TA1');
    });

    it('applies same-batch positional results to corresponding scheduler items', async () => {
      const items = [
        { text: 'A', resolve: vi.fn(), score: 1 },
        { text: 'B', resolve: vi.fn(), score: 1 },
        { text: 'C', resolve: vi.fn(), score: 1 },
      ];
      scheduler.queue.push(...items);
      PageTranslationFluidFilter.process.mockReturnValue({ batchItems: items, remainingItems: [] });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      safeSendMessage.mockResolvedValue({
        success: true,
        translatedText: JSON.stringify(['TA', 'TC', 'TB']),
      });

      await scheduler.flush();

      expectSettlement(items[0].resolve, 'TA');
      expectSettlement(items[1].resolve, 'TC');
      expectSettlement(items[2].resolve, 'TB');
    });

    it('ignores multiple stopped flush finalizers while preserving current-session accounting', async () => {
      const oldRequests = [];
      const resolveOld = [];
      const rejectOld = [];
      const newResponse = {};
      let resolveNew;
      const newRequest = new Promise(resolve => { resolveNew = resolve; });
      const oldItems = [
        { text: 'Old A', resolve: vi.fn(), score: 1 },
        { text: 'Old B', resolve: vi.fn(), score: 1 },
      ];
      const newItem = { text: 'New', resolve: vi.fn(), score: 1 };

      oldItems.forEach(item => scheduler.queue.push(item));
      scheduler.totalTasks = oldItems.length;
      scheduler.settings.maxConcurrentFlushes = 2;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      oldItems.forEach(() => {
        oldRequests.push(new Promise((resolve, reject) => {
          resolveOld.push(resolve);
          rejectOld.push(reject);
        }));
      });
      safeSendMessage
        .mockImplementationOnce(() => oldRequests[0])
        .mockImplementationOnce(() => oldRequests[1])
        .mockImplementationOnce(() => newRequest);

      const oldFlushes = [scheduler.flush(), scheduler.flush()];
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(2));
      expect(scheduler.activeFlushes).toBe(2);

      scheduler.stop();
      scheduler.setTranslationState(true, 'new-session', { session: 'new' });
      scheduler.queue.push(newItem);
      scheduler.totalTasks = 1;
      const newFlush = scheduler.flush();
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(3));
      expect(scheduler.activeFlushes).toBe(1);

      resolveOld[0]({});
      rejectOld[1](new Error('old-session failure'));
      await Promise.all(oldFlushes);
      expect(scheduler.activeFlushes).toBe(1);

      resolveNew(newResponse);
      await newFlush;
      expect(scheduler.activeFlushes).toBe(0);
    });

    it('decrements active flushes for current-session success and failure', async () => {
      const requests = [];
      const resolvers = [];
      const items = [
        { text: 'A', resolve: vi.fn(), score: 1 },
        { text: 'B', resolve: vi.fn(), score: 1 },
      ];

      items.forEach(item => scheduler.queue.push(item));
      scheduler.totalTasks = items.length;
      scheduler.settings.maxConcurrentFlushes = 2;
      PageTranslationFluidFilter.process.mockImplementation(queue => ({
        batchItems: [queue[0]],
        remainingItems: queue.slice(1),
      }));
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google',
        targetLanguage: 'fa',
      });
      items.forEach(() => {
        requests.push(new Promise((resolve, reject) => resolvers.push({ resolve, reject })));
      });
      safeSendMessage
        .mockImplementationOnce(() => requests[0])
        .mockImplementationOnce(() => requests[1]);

      const flushes = [scheduler.flush(), scheduler.flush()];
      await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledTimes(2));
      expect(scheduler.activeFlushes).toBe(2);

      resolvers[0].resolve({});
      await flushes[0];
      expect(scheduler.activeFlushes).toBe(1);

      resolvers[1].reject(new Error('current-session failure'));
      await flushes[1];
      expect(scheduler.activeFlushes).toBe(0);
    });
  });
});

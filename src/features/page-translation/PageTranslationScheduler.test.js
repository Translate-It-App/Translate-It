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
import { isFatalError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { PageTranslationQueueFilter } from './utils/PageTranslationQueueFilter.js';
import { PageTranslationFluidFilter } from './utils/PageTranslationFluidFilter.js';
import { safeSendMessage, sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons, MessageFormat } from '@/shared/messaging/core/MessagingCore.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import ExtensionContextManager from '@/core/extensionContext.js';

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
    getNearestSemanticContainer: vi.fn(() => null)
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
  getTargetLanguageAsync: vi.fn(async () => 'fa')
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
      purgedCount: 0,
      ejectedItems: []
    };
    PageTranslationQueueFilter.process.mockReturnValue({ ...defaultResult });
    PageTranslationFluidFilter.process.mockReturnValue({ ...defaultResult });
  });

  afterEach(() => {
    scheduler.stop();
    scheduler.reset();
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

    const configureTimedQueue = ({ translateAfterScrollStop = false, chunkSize = 250 } = {}) => {
      scheduler.setSettings({
        translationApi: 'google', targetLanguage: 'en', lazyLoading: false,
        translateAfterScrollStop, scrollStopDelay: 600, poolDelay: 150,
        priorityThreshold: 1, chunkSize, maxConcurrentFlushes: 1,
      });
      vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue({
        providerRegistryId: 'google', targetLanguage: 'en', chunkSize,
        maxChars: 1_000_000, parallelExecution: false, lazyLoading: false,
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

  describe('bounded independent AI batches', () => {
    it.each([[3, 25, 2], [5, 10, 4]])('enables Custom workers at level %i without changing its existing batch size', async (level, chunkSize, limit) => {
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

    it('emits latest non-fatal structured cause for zero-result completion', async () => {
      vi.useFakeTimers();
      try {
        const emitSpy = vi.spyOn(pageEventBus, 'emit');
        const firstItem = { text: 'First', resolve: vi.fn(), score: 1 };
        const lastItem = { text: 'Last', resolve: vi.fn(), score: 1 };
        scheduler.totalTasks = 2;

        await scheduler._handleBatchError(
          Object.assign(new Error('Too many requests'), {
            type: ErrorTypes.RATE_LIMIT_REACHED,
            statusCode: 429,
          }),
          [firstItem],
          ErrorTypes.RATE_LIMIT_REACHED
        );
        await scheduler._handleBatchError(
          Object.assign(new Error('Model overloaded'), {
            type: ErrorTypes.MODEL_OVERLOADED,
          }),
          [lastItem],
          ErrorTypes.MODEL_OVERLOADED
        );

        scheduler._checkCompletion();
        await vi.runAllTimersAsync();

        const completion = emitSpy.mock.calls.find(([event]) => event === MessageActions.PAGE_TRANSLATE_COMPLETE)?.[1];
        expect(completion).toMatchObject({
          translatedCount: 0,
          failedCount: 2,
          errorDetails: {
            message: 'Model overloaded',
            type: ErrorTypes.MODEL_OVERLOADED,
          },
        });
        expect(completion.errorDetails).not.toHaveProperty('statusCode');
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

    it('should handle batch errors and fallback to original text', async () => {
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
      expect(internalError.isFatal).toBe(true);
      expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ type: 'SERVER_ERROR' }),
        errorType: 'SERVER_ERROR',
        sessionId: 'test-session-123',
        sessionContext: { pageTitle: 'Test Page' },
        context: 'page-translation-batch',
      }));
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
      expect(internalError.isFatal).toBe(true);
      expect(scheduler.fatalErrorOccurred).toBe(true);
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

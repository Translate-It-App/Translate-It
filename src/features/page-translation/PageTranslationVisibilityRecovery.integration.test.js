import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debugLazy: vi.fn() })),
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: vi.fn(),
  sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'en'),
  getWholePageMaxCharsAsync: vi.fn(async () => 1_000_000),
  getWholePageAiMaxCharsAsync: vi.fn(async () => 1_000_000),
}));

import { PageTranslationScheduler } from './PageTranslationScheduler.js';
import { PageTranslationScrollTracker } from './utils/PageTranslationScrollTracker.js';

describe('Page translation visibility recovery integration', () => {
  let scheduler;
  let tracker;
  let element;
  let rect;
  let dispatched;
  let dispatchTimes;
  let config;

  const enqueue = (text, score = 0) => scheduler.enqueue(text, scheduler.sessionContext, score, element);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    tracker = null;
    document.body.replaceChildren();
    element = document.createElement('p');
    element.textContent = 'Content waiting for translation';
    document.body.append(element);
    rect = { top: 2_000, left: 10, right: 100, bottom: 2_020, width: 90, height: 20 };
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }));
    scheduler = new PageTranslationScheduler();
    scheduler.setSettings({ lazyLoading: true, translateAfterScrollStop: false, scrollStopDelay: 1000, chunkSize: 2000, maxConcurrentFlushes: 1 });
    scheduler.setTranslationState(true, 'visibility-recovery', {});
    config = {
      providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 2000,
      maxChars: 1_000_000, parallelExecution: false, lazyLoading: true,
    };
    vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue(config);
    dispatched = [];
    dispatchTimes = [];
    vi.spyOn(scheduler, '_executeBatchRequest').mockImplementation(async items => {
      dispatched.push(...items.map(item => item.id));
      dispatchTimes.push(Date.now());
      items.forEach(item => scheduler._resolveItem(item, `translated:${item.text}`, 'accepted'));
    });
  });

  afterEach(() => {
    tracker?.destroy();
    scheduler?.stop();
    scheduler?.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('rechecks fresh geometry at the existing retry after a large blocked queue and enqueue burst', async () => {
    scheduler.isFirstBatch = false;
    const tasks = Array.from({ length: 1000 }, (_, index) => enqueue(`Content waiting for translation ${index}`));
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.queue).toHaveLength(1000);
    expect(scheduler.isWaitingForVisibility).toBe(true);
    expect(scheduler.isVisibilityRetryTimer).toBe(true);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1000);
    expect(dispatched).toEqual([]);

    for (let index = 0; index < 10; index++) enqueue(`Content waiting for translation burst ${index}`);
    await Promise.resolve();
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1000);

    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatched).toEqual([]);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1000);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(tasks);

    expect(dispatched).toHaveLength(1010);
    expect(new Set(dispatched).size).toBe(1010);
    expect(scheduler.queue).toHaveLength(0);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2010);
  });

  it('uses fresh geometry at the capped idle retry without any viewport activity signal', async () => {
    scheduler.isFirstBatch = false;
    const task = enqueue('Content becoming visible during stable idle');
    await scheduler.flush();
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(scheduler._visibilityRetryDeadline).toBe(1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    expect(scheduler._visibilityRetryDeadline).toBe(3000);

    await vi.advanceTimersByTimeAsync(2000);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(3);
    expect(scheduler._visibilityRetryDeadline).toBe(6000);
    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };

    await vi.advanceTimersByTimeAsync(2999);
    expect(dispatched).toEqual([]);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await task;

    expect(dispatchTimes).toEqual([6000]);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(4);
    expect(scheduler._visibilityRetryDelay).toBe(1000);
  });

  it('resets the idle interval on viewport activity without an immediate geometry read', async () => {
    scheduler.isFirstBatch = false;
    const task = enqueue('Content becoming visible after activity');
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler._visibilityRetryDeadline).toBe(3000);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };
    scheduler.signalViewportActivity();
    expect(scheduler._visibilityRetryDeadline).toBe(2500);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchTimes).toEqual([2500]);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(3);
    await task;
  });

  it('wires nested scroll and resize activity to an accelerated, non-postponable retry', async () => {
    scheduler.isFirstBatch = false;
    const task = enqueue('Content becoming visible after tracked activity');
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler._visibilityRetryDeadline).toBe(3000);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);

    tracker = new PageTranslationScrollTracker(
      () => scheduler.signalScrollStop(),
      () => scheduler.signalScrollStart(),
      () => scheduler.signalViewportActivity(),
    );
    tracker.start(5000);
    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };
    await vi.advanceTimersByTimeAsync(500);
    const nested = document.createElement('span');
    element.append(nested);
    nested.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(scheduler._visibilityRetryDeadline).toBe(2500);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 19; index++) {
      await vi.advanceTimersByTimeAsync(50);
      window.dispatchEvent(new Event('resize'));
      expect(scheduler._visibilityRetryDeadline).toBe(2500);
      expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    }

    await vi.advanceTimersByTimeAsync(49);
    expect(scheduler._visibilityRetryDeadline).toBe(2500);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchTimes).toEqual([2500]);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(3);
    await task;
  });

  it('rechecks immediately on scroll stop and cancels the pending retry', async () => {
    const task = enqueue('Content waiting for translation after scroll');
    await vi.advanceTimersByTimeAsync(800);

    expect(scheduler.isWaitingForVisibility).toBe(true);
    expect(scheduler.isVisibilityRetryTimer).toBe(true);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);

    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };
    scheduler.signalScrollStop();
    await vi.advanceTimersByTimeAsync(0);
    await task;

    expect(dispatched).toHaveLength(1);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    expect(scheduler.batchTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatched).toHaveLength(1);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });

  it('fills all available worker slots with distinct newly visible batches before any response', async () => {
    scheduler.setSettings({ maxConcurrentFlushes: 3 });
    config = { ...config, chunkSize: 1, parallelExecution: true };
    scheduler._getBatchConfig.mockResolvedValue(config);
    const requests = [];
    vi.spyOn(scheduler, '_executeBatchRequest').mockImplementation(items => new Promise(resolve => {
      requests.push({ items, resolve });
      dispatched.push(...items.map(item => item.id));
    }));
    const tasks = Array.from({ length: 3 }, (_, index) => enqueue(`Content waiting for parallel recovery ${index}`));
    await vi.advanceTimersByTimeAsync(800);

    expect(scheduler.isWaitingForVisibility).toBe(true);
    expect(requests).toHaveLength(0);

    rect = { top: 10, left: 10, right: 100, bottom: 30, width: 90, height: 20 };
    scheduler.signalScrollStop();
    await vi.advanceTimersByTimeAsync(0);

    expect(requests).toHaveLength(3);
    expect(requests.every(({ items }) => items.length === 1)).toBe(true);
    const handedOffIds = requests.flatMap(({ items }) => items.map(item => item.id));
    expect(new Set(handedOffIds).size).toBe(3);
    expect(scheduler.activeFlushes).toBe(3);

    requests.forEach(({ items, resolve }) => {
      items.forEach(item => scheduler._resolveItem(item, `translated:${item.text}`, 'accepted'));
      resolve();
    });
    await Promise.all(tasks);
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatched).toHaveLength(3);
    expect(new Set(dispatched).size).toBe(3);
    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.activeFlushes).toBe(0);
    expect(scheduler.batchTimer).toBeNull();
  });
});

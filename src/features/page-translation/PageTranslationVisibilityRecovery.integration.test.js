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

describe('Page translation visibility recovery integration', () => {
  let scheduler;
  let element;
  let rect;
  let dispatched;
  let config;

  const enqueue = (text, score = 0) => scheduler.enqueue(text, scheduler.sessionContext, score, element);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    document.body.replaceChildren();
    element = document.createElement('p');
    element.textContent = 'Content waiting for translation';
    document.body.append(element);
    rect = { top: 2_000, left: 10, right: 100, bottom: 2_020, width: 90, height: 20 };
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }));
    scheduler = new PageTranslationScheduler();
    scheduler.setSettings({ lazyLoading: true, scrollStopDelay: 1000, chunkSize: 2000, maxConcurrentFlushes: 1 });
    scheduler.setTranslationState(true, 'visibility-recovery', {});
    config = {
      providerRegistryId: 'google', targetLanguage: 'en', chunkSize: 2000,
      maxChars: 1_000_000, parallelExecution: false, lazyLoading: true,
    };
    vi.spyOn(scheduler, '_getBatchConfig').mockResolvedValue(config);
    dispatched = [];
    vi.spyOn(scheduler, '_executeBatchRequest').mockImplementation(async items => {
      dispatched.push(...items.map(item => item.id));
      items.forEach(item => scheduler._resolveItem(item, `translated:${item.text}`, 'accepted'));
    });
  });

  afterEach(() => {
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

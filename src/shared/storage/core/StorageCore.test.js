import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, isReactive } from 'vue';
import { StorageCore } from './StorageCore.js';
import { isContextError } from '@/core/contextCore.js';

// Mock Dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    operation: vi.fn()
  })
}));

vi.mock('@/core/extensionContext.js', () => {
  const mock = {
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn(),
    isValidSync: vi.fn().mockReturnValue(true),
  };
  return {
    default: mock,
    isContextError: mock.isContextError,
    handleContextError: mock.handleContextError,
    isValidSync: mock.isValidSync,
  };
});

function createDeferred() {
  let resolve;
  const promise = new Promise(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function queueDeferredRead(firstRead, retryResult) {
  const started = createDeferred();
  browser.storage.local.get.mockReset();
  browser.storage.local.get
    .mockImplementationOnce(() => {
      started.resolve();
      return firstRead.promise;
    })
    .mockResolvedValueOnce(retryResult);
  return started;
}

function getStorageChangeListener() {
  const calls = browser.storage.onChanged.addListener.mock.calls;
  return calls[calls.length - 1][0];
}

describe('StorageCore CRUD Operations', () => {
  let storage;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Use the global browser mock from setup.js
    browser.storage.local.get.mockResolvedValue({});
    storage = new StorageCore();
    await storage._readyPromise;
  });

  it('get should return values from storage and update cache', async () => {
    browser.storage.local.get.mockResolvedValue({ theme: 'dark' });
    
    const result = await storage.get('theme');
    
    expect(result).toEqual({ theme: 'dark' });
    expect(browser.storage.local.get).toHaveBeenCalledWith(['theme']);
    expect(storage.cache.get('theme')).toBe('dark');
  });

  it('get should use cache on subsequent calls', async () => {
    browser.storage.local.get.mockResolvedValue({ theme: 'dark' });
    
    // First call - hits storage
    await storage.get('theme');
    
    // Second call - should hit cache
    const result = await storage.get('theme');
    
    expect(result).toEqual({ theme: 'dark' });
    // 1 (init) + 1 (first get) = 2
    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
  });

  it('set should store data and update cache', async () => {
    await storage.set({ theme: 'light' });
    
    expect(browser.storage.local.set).toHaveBeenCalledWith({ theme: 'light' });
    expect(storage.cache.get('theme')).toBe('light');
  });

  it('remove should delete from storage and cache', async () => {
    storage.cache.set('key', 'value');
    await storage.remove('key');
    
    expect(browser.storage.local.remove).toHaveBeenCalledWith(['key']);
    expect(storage.cache.has('key')).toBe(false);
  });
});

describe('StorageCore set plain-data conversion', () => {
  let storage;

  beforeEach(async () => {
    vi.clearAllMocks();
    browser.storage.local.get.mockResolvedValue({});
    storage = new StorageCore();
    await storage._readyPromise;
  });

  it('converts nested objects and arrays to detached plain values', async () => {
    const input = { nested: { count: 1, list: [1, { label: 'x' }] } };

    await storage.set(input);

    const written = browser.storage.local.set.mock.calls[0][0];
    expect(written).toEqual({ nested: { count: 1, list: [1, { label: 'x' }] } });
    expect(written.nested).not.toBe(input.nested);
    expect(written.nested.list).not.toBe(input.nested.list);
  });

  it('strips Vue reactive proxies before reaching browser storage', async () => {
    const proxy = reactive({ theme: 'dark', nested: { list: [1, 2] } });

    await storage.set(proxy);

    const written = browser.storage.local.set.mock.calls[0][0];
    expect(written).toEqual({ theme: 'dark', nested: { list: [1, 2] } });
    expect(isReactive(written)).toBe(false);
    expect(isReactive(written.nested)).toBe(false);
  });
});

describe('StorageCore cache expiration', () => {
  let storage;

  beforeEach(async () => {
    vi.clearAllMocks();
    browser.storage.local.get.mockResolvedValue({});
    storage = new StorageCore();
    await storage._readyPromise;
  });

  it('uses defaults and reports misses for expired synchronous cache entries', () => {
    storage.cache.set('expired', 'stale');
    storage.cache.expiryTimes.set('expired', Date.now() - 1);

    expect(storage.getCached('expired', 'fallback')).toBe('fallback');
    expect(storage.hasCached('expired')).toBe(false);
  });

  it('preserves valid falsy cached values and defaults on synchronous reads', () => {
    for (const [key, value] of Object.entries({ falseValue: false, zero: 0, empty: '', nullValue: null })) {
      storage.cache.set(key, value);
    }

    expect(storage.getCached('falseValue', true)).toBe(false);
    expect(storage.hasCached('falseValue')).toBe(true);
    expect(storage.getCached('zero', 1)).toBe(0);
    expect(storage.getCached('empty', 'fallback')).toBe('');
    expect(storage.getCached('nullValue', 'fallback')).toBeNull();
    expect(storage.getCached('missing', 'fallback')).toBe('fallback');
  });

  it('reads expired keys from storage while retaining valid cached values', async () => {
    browser.storage.local.get.mockResolvedValue({ expired: 'fresh' });
    storage.cache.set('expired', 'stale');
    storage.cache.expiryTimes.set('expired', Date.now() - 1);
    storage.cache.set('cachedFalse', false);

    await expect(storage.get({ expired: 'fallback', cachedFalse: true })).resolves.toEqual({
      expired: 'fresh',
      cachedFalse: false
    });
    expect(browser.storage.local.get).toHaveBeenCalledWith(['expired']);
  });

  it('returns supplied defaults when expired keys are missing from storage', async () => {
    browser.storage.local.get.mockResolvedValue({});
    storage.cache.set('expired', 'stale');
    storage.cache.expiryTimes.set('expired', Date.now() - 1);

    await expect(storage.get({ expired: 'fallback' })).resolves.toEqual({ expired: 'fallback' });
    expect(browser.storage.local.get).toHaveBeenCalledWith(['expired']);
  });

  it('treats an entry expiring between validation and get as a cache miss', async () => {
    browser.storage.local.get.mockResolvedValue({ theme: 'fresh' });
    storage.cache.set('theme', 'stale');
    const originalGet = storage.cache.get.bind(storage.cache);
    const cacheGet = vi.spyOn(storage.cache, 'get').mockImplementationOnce(key => {
      storage.cache.expiryTimes.set(key, Date.now() - 1);
      return originalGet(key);
    });

    await expect(storage.get({ theme: 'fallback' })).resolves.toEqual({ theme: 'fresh' });
    expect(browser.storage.local.get).toHaveBeenCalledWith(['theme']);
    cacheGet.mockRestore();
  });
});

describe('StorageCore Synchronization', () => {
  let storage;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Add missing onChanged mock
    if (!browser.storage.onChanged) {
      browser.storage.onChanged = {
        addListener: vi.fn(),
        removeListener: vi.fn()
      };
    }
    storage = new StorageCore();
    await storage._readyPromise;
  });

  it('should update cache and emit events when browser storage changes externally', async () => {
    const changeCallback = vi.fn();
    storage.on('change:theme', changeCallback);
    
    // Find the listener registered with browser.storage.onChanged
    const onCall = browser.storage.onChanged.addListener.mock.calls.find(call => call[1] === 'change' || true);
    const listener = onCall[0];
    
    // Simulate external change
    listener({ 
      theme: { newValue: 'dark', oldValue: 'light' } 
    }, 'local');
    
    expect(storage.cache.get('theme')).toBe('dark');
    expect(changeCallback).toHaveBeenCalledWith({ newValue: 'dark', oldValue: 'light' });
  });

  it('retries a read when onChanged advances the cache revision', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { theme: 'B' });
    const readPromise = storage.get('theme', false);

    await started.promise;
    getStorageChangeListener()({
      theme: { newValue: 'B', oldValue: 'A' }
    }, 'local');
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({ theme: 'B' });
    expect(storage.cache.get('theme')).toBe('B');
    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a removed key from a stale read', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, {});
    const readPromise = storage.get('theme', false);

    await started.promise;
    getStorageChangeListener()({
      theme: { newValue: undefined, oldValue: 'A' }
    }, 'local');
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({});
    expect(storage.cache.has('theme')).toBe(false);
  });

  it('retries getFresh when storage changes during the read', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { theme: 'B' });
    const readPromise = storage.getFresh('theme');

    await started.promise;
    getStorageChangeListener()({
      theme: { newValue: 'B', oldValue: 'A' }
    }, 'local');
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({ theme: 'B' });
    expect(storage.cache.get('theme')).toBe('B');
  });

  it('rebuilds partial cached results after a revision change', async () => {
    storage.cache.set('cached', 'old-cached');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { uncached: 'new-uncached' });
    const readPromise = storage.get({ cached: 'fallback', uncached: 'fallback' });

    await started.promise;
    getStorageChangeListener()({
      cached: { newValue: 'new-cached', oldValue: 'old-cached' }
    }, 'local');
    firstRead.resolve({ uncached: 'old-uncached' });

    await expect(readPromise).resolves.toEqual({
      cached: 'new-cached',
      uncached: 'new-uncached'
    });
    expect(storage.cache.get('cached')).toBe('new-cached');
    expect(storage.cache.get('uncached')).toBe('new-uncached');
    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
  });

  it('retries a bulk read after a storage change', async () => {
    storage.cache.set('first', 'A');
    storage.cache.set('second', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { first: 'B' });
    const readPromise = storage.get(null);

    await started.promise;
    getStorageChangeListener()({
      first: { newValue: 'B', oldValue: 'A' },
      second: { newValue: undefined, oldValue: 'A' }
    }, 'local');
    firstRead.resolve({ first: 'A', second: 'A' });

    await expect(readPromise).resolves.toEqual({ first: 'B' });
    expect(storage.cache.get('first')).toBe('B');
    expect(storage.cache.has('second')).toBe(false);
  });

  it('does not retry independent overlapping reads without a mutation', async () => {
    const firstRead = createDeferred();
    const secondRead = createDeferred();
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const initialRevision = storage._cacheRevision;

    browser.storage.local.get.mockReset();
    browser.storage.local.get
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return firstRead.promise;
      })
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return secondRead.promise;
      });

    const firstPromise = storage.get('first', false);
    await firstStarted.promise;
    const secondPromise = storage.get('second', false);
    await secondStarted.promise;

    firstRead.resolve({ first: 'A' });
    secondRead.resolve({ second: 'B' });

    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
      { first: 'A' },
      { second: 'B' }
    ]);
    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
    expect(storage._cacheRevision).toBe(initialRevision);
    expect(storage.cache.get('first')).toBe('A');
    expect(storage.cache.get('second')).toBe('B');
  });

  it('retries after a successful set invalidates a pending read', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { theme: 'B' });
    browser.storage.local.set.mockReset().mockResolvedValue(undefined);
    const readPromise = storage.get('theme', false);

    await started.promise;
    await storage.set({ theme: 'B' });
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({ theme: 'B' });
    expect(storage.cache.get('theme')).toBe('B');
  });

  it('retries after a successful remove invalidates a pending read', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, {});
    browser.storage.local.remove.mockReset().mockResolvedValue(undefined);
    const readPromise = storage.get('theme', false);

    await started.promise;
    await storage.remove('theme');
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({});
    expect(storage.cache.has('theme')).toBe(false);
  });

  it('retries after a successful clear invalidates a pending bulk read', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, {});
    browser.storage.local.clear.mockReset().mockResolvedValue(undefined);
    const readPromise = storage.get(null);

    await started.promise;
    await storage.clear();
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({});
    expect(storage.cache.has('theme')).toBe(false);
  });

  it('retries after explicit cache invalidation', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, { theme: 'B' });
    const readPromise = storage.get('theme', false);

    await started.promise;
    storage.invalidateCache('theme');
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({ theme: 'B' });
    expect(storage.cache.get('theme')).toBe('B');
  });

  it('retries after explicitly clearing the cache', async () => {
    storage.cache.set('theme', 'A');
    const firstRead = createDeferred();
    const started = queueDeferredRead(firstRead, {});
    const readPromise = storage.get(null);

    await started.promise;
    storage.clearCache();
    firstRead.resolve({ theme: 'A' });

    await expect(readPromise).resolves.toEqual({});
    expect(storage.cache.has('theme')).toBe(false);
  });
});

describe('StorageCore initialization failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.storage.local.get.mockReset();
    browser.storage.local.get.mockResolvedValue({});
    isContextError.mockReturnValue(false);
  });

  it('uses intentional memory fallback when storage API is unavailable', async () => {
    const storageLocal = browser.storage.local;
    browser.storage.local = undefined;

    try {
      const storage = new StorageCore();
      await storage._readyPromise;

      expect(storage._useInMemoryStorage).toBe(true);
      expect(storage._isReady).toBe(true);

      await storage.set({ theme: 'light' });
      await expect(storage.get('theme')).resolves.toEqual({ theme: 'light' });
    } finally {
      browser.storage.local = storageLocal;
    }
  });

  it('propagates ordinary probe failures without entering memory mode', async () => {
    const probeError = new Error('temporary storage failure');
    browser.storage.local.get.mockRejectedValueOnce(probeError);
    const storage = new StorageCore();

    await expect(storage._readyPromise).rejects.toThrow('temporary storage failure');
    expect(storage._useInMemoryStorage).toBe(false);
    expect(storage._isReady).toBe(false);
  });

  it('retries a context-error probe and initializes normally after recovery', async () => {
    const contextError = new Error('Extension context invalidated');
    isContextError.mockImplementation(error => error === contextError);
    browser.storage.local.get
      .mockRejectedValueOnce(contextError)
      .mockResolvedValueOnce({});
    const storage = new StorageCore();

    await expect(storage._readyPromise).resolves.toBeUndefined();

    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
    expect(storage._useInMemoryStorage).toBe(false);
    expect(storage._isReady).toBe(true);
  });
});

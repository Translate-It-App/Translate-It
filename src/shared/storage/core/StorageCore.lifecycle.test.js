import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageCore } from './StorageCore.js';
import { isContextError } from '@/core/contextCore.js';

// Genuine permanent-context contract (the global setup mock replaces it with a
// stub, so re-import the real matcher to prove the guard message matches it).
const { isContextError: realIsContextError } = await vi.importActual('@/core/contextCore.js');

const mockHandleContextError = vi.hoisted(() => vi.fn());
vi.mock('@/core/contextErrorHandler.js', () => ({
  handleContextError: mockHandleContextError,
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), operation: vi.fn() }),
}));
vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class {
    trackResource() {}
    trackCache() {}
    addEventListener(target, event, handler) {
      if (typeof target?.addListener === 'function') {
        target.addListener(handler);
      }
    }
    cleanup() {}
    destroy() {}
  },
}));
vi.mock('@/core/memory/SmartCache.js', () => ({
  default: class { constructor() { this.isDestroyed=false; } has() {return false} hasValid() {return false} get(){} set(){} delete(){} clear(){} destroy(){this.isDestroyed=true} },
}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
  return { promise, resolve, reject };
}

describe('StorageCore lifecycle behavioral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Route StorageCore's contract checks through the genuine matcher for this
    // suite (a plain stub would prove nothing about message recognition).
    isContextError.mockImplementation(realIsContextError);
    if (!globalThis.browser) globalThis.browser = { storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } };
    if (!globalThis.browser.storage) globalThis.browser.storage = { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } };
    if (!globalThis.browser.storage.local) globalThis.browser.storage.local = { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() };
    if (!globalThis.browser.storage.onChanged) globalThis.browser.storage.onChanged = { addListener: vi.fn(), removeListener: vi.fn() };
    if (!globalThis.browser.storage.local.get) globalThis.browser.storage.local.get = vi.fn();
    if (!globalThis.browser.storage.onChanged.addListener) globalThis.browser.storage.onChanged.addListener = vi.fn();
    if (!globalThis.browser.storage.onChanged.removeListener) globalThis.browser.storage.onChanged.removeListener = vi.fn();
    globalThis.browser.storage.local.get.mockReset();
    globalThis.browser.storage.local.set.mockReset().mockResolvedValue();
    globalThis.browser.storage.local.remove.mockReset().mockResolvedValue();
    globalThis.browser.storage.local.clear.mockReset().mockResolvedValue();
    globalThis.browser.storage.onChanged.addListener.mockReset();
    globalThis.browser.storage.onChanged.removeListener.mockReset();
    global.browser = globalThis.browser;
  });

  it('shares probe, rejects both, releases promise, retries and installs listener once', async () => {
    const probeDeferred = deferred();
    const probeError = new Error('probe fail');
    globalThis.browser.storage.local.get.mockImplementationOnce(() => probeDeferred.promise);

    const storage = new StorageCore();
    // two concurrent callers while probe pending
    const caller1 = storage.get('a').catch(e=>e);
    const caller2 = storage.get('b').catch(e=>e);
    expect(globalThis.browser.storage.local.get).toHaveBeenCalled();
    // probe should be first call
    expect(globalThis.browser.storage.local.get.mock.calls[0][0]).toEqual(["__storage_test__"]);

    probeDeferred.reject(probeError);
    const r1 = await caller1;
    const r2 = await caller2;
    expect(r1).toBe(probeError);
    expect(r2).toBe(probeError);
    expect(storage._readyPromise).toBeNull();
    expect(storage._isReady).toBe(false);

    // backend recovers
    globalThis.browser.storage.local.get.mockResolvedValue({});
    globalThis.browser.storage.onChanged.addListener.mockClear();
    const result = await storage.get('a');
    expect(result).toBeDefined();
    expect(storage._isReady).toBe(true);
    expect(globalThis.browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    await storage.get('b');
    expect(globalThis.browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it('does not become ready until a required change listener is installed', async () => {
    const listenerError = new Error('listener unavailable');
    let registeredListener;
    globalThis.browser.storage.local.get.mockResolvedValue({});
    globalThis.browser.storage.onChanged.addListener
      .mockImplementationOnce(() => { throw listenerError; })
      .mockImplementation(listener => { registeredListener = listener; });

    const storage = new StorageCore();
    await expect(storage.get('a')).rejects.toBe(listenerError);
    expect(storage._isReady).toBe(false);
    expect(storage._changeListener).toBeNull();

    const onChange = vi.fn();
    storage.on('change', onChange);
    await storage.get('a');

    expect(storage._isReady).toBe(true);
    expect(globalThis.browser.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
    registeredListener({ a: { oldValue: 1, newValue: 2 } }, 'local');
    expect(onChange).toHaveBeenCalledWith({ key: 'a', oldValue: 1, newValue: 2 });
  });

  describe('runtime-loss guard', () => {
    const simulateRuntimeLoss = () => {
      const savedStorage = globalThis.browser.storage;
      delete globalThis.browser.storage;
      return () => { globalThis.browser.storage = savedStorage; };
    };

    it('still falls back to in-memory when the storage API is absent at startup', async () => {
      const restore = simulateRuntimeLoss();
      try {
        const storage = new StorageCore();
        await storage._readyPromise;
        expect(storage._useInMemoryStorage).toBe(true);
        expect(storage._isReady).toBe(true);

        await storage.set({ theme: 'dark' });
        await expect(storage.get('theme')).resolves.toEqual({ theme: 'dark' });
      } finally {
        restore();
      }
    });

    it('matches the explicit guard message against the permanent-context contract only', () => {
      expect(realIsContextError(
        new Error('Runtime API unavailable: browser.storage.local is missing')
      )).toBe(true);
      // The generic TypeError text this guard replaces must never match.
      expect(realIsContextError(
        new TypeError("Cannot read properties of undefined (reading 'local')")
      )).toBe(false);
    });

    it('rejects browser-backed reads with an explicit context error after runtime loss', async () => {
      const storage = new StorageCore();
      await storage._readyPromise;
      expect(storage._useInMemoryStorage).toBe(false);

      const restore = simulateRuntimeLoss();
      try {
        const error = await storage.get('a').catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error.message).toContain('Runtime API unavailable');
        expect(realIsContextError(error)).toBe(true);
        expect(mockHandleContextError).toHaveBeenCalledWith(error, 'storage-core-get');
        // No silent fork into a second storage universe.
        expect(storage._useInMemoryStorage).toBe(false);
      } finally {
        restore();
      }
    });

    it('rejects browser-backed writes with an explicit context error after runtime loss', async () => {
      const storage = new StorageCore();
      await storage._readyPromise;
      expect(storage._useInMemoryStorage).toBe(false);

      const restore = simulateRuntimeLoss();
      try {
        const error = await storage.set({ a: 1 }).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error.message).toContain('Runtime API unavailable');
        expect(realIsContextError(error)).toBe(true);
        expect(mockHandleContextError).toHaveBeenCalledWith(error, 'storage-core-set');
        expect(storage._useInMemoryStorage).toBe(false);
      } finally {
        restore();
      }
    });

    it('guards remove and clear on the same runtime-loss path', async () => {
      const storage = new StorageCore();
      await storage._readyPromise;
      expect(storage._useInMemoryStorage).toBe(false);

      const restore = simulateRuntimeLoss();
      try {
        await expect(storage.remove('a')).rejects.toThrow('Runtime API unavailable');
        await expect(storage.clear()).rejects.toThrow('Runtime API unavailable');
        expect(mockHandleContextError).toHaveBeenCalledWith(expect.any(Error), 'storage-core-remove');
        expect(mockHandleContextError).toHaveBeenCalledWith(expect.any(Error), 'storage-core-clear');
        expect(storage._useInMemoryStorage).toBe(false);
      } finally {
        restore();
      }
    });
  });
});

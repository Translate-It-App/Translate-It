import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: () => ({ handle: vi.fn() })
  }
}));

import { MainFeatureLoader } from './MainFeatureLoader.js';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createLoader = (loadFeature) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const contentScriptCore = { loadFeature };
  const loader = new MainFeatureLoader(contentScriptCore, async () => logger);
  return { loader, logger };
};

describe('MainFeatureLoader in-flight-only cache', () => {
  it('dedupes concurrent loads: shares one promise, delegates once', async () => {
    const activation = deferred();
    const loadFeature = vi.fn().mockReturnValue(activation.promise);
    const { loader } = createLoader(loadFeature);

    const first = loader.loadFeature('windowsManager', 'INTERACTIVE');
    const second = loader.loadFeature('windowsManager', 'INTERACTIVE');

    expect(loader.featureLoadPromises.has('windowsManager')).toBe(true);

    activation.resolve();
    expect(await first).toBe(await second);
    await flushPromises();

    expect(loadFeature).toHaveBeenCalledTimes(1);
    expect(loader.featureLoadPromises.has('windowsManager')).toBe(false);
  });

  it('removes the cache entry after a successful load', async () => {
    const { loader } = createLoader(vi.fn().mockResolvedValue({}));

    await loader.loadFeature('textSelection', 'CRITICAL');

    expect(loader.featureLoadPromises.has('textSelection')).toBe(false);
  });

  it('delegates again on a second call after success (no permanent cache)', async () => {
    const loadFeature = vi.fn().mockResolvedValue({});
    const { loader } = createLoader(loadFeature);

    await loader.loadFeature('mouseHover', 'CRITICAL');
    await loader.loadFeature('mouseHover', 'CRITICAL');

    expect(loadFeature).toHaveBeenCalledTimes(2);
  });

  it('preserves swallowed-error behavior and clears the entry on failure', async () => {
    const loadFeature = vi.fn().mockRejectedValue(new Error('boom'));
    const { loader, logger } = createLoader(loadFeature);

    const result = await loader.loadFeature('screenCapture', 'INTERACTIVE');

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(loader.featureLoadPromises.has('screenCapture')).toBe(false);
  });

  it('retries after a failed attempt: second call delegates again', async () => {
    const loadFeature = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce({});
    const { loader } = createLoader(loadFeature);

    await loader.loadFeature('screenCapture', 'INTERACTIVE');
    await loader.loadFeature('screenCapture', 'INTERACTIVE');

    expect(loadFeature).toHaveBeenCalledTimes(2);
    expect(loader.featureLoadPromises.has('screenCapture')).toBe(false);
  });

  it('clears the entry on a null/undefined result and retries on a later call', async () => {
    const loadFeature = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({});
    const { loader } = createLoader(loadFeature);

    await loader.loadFeature('selectElement', 'INTERACTIVE');
    expect(loader.featureLoadPromises.has('selectElement')).toBe(false);

    await loader.loadFeature('selectElement', 'INTERACTIVE');
    expect(loadFeature).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale finalizer delete a newer in-flight entry', async () => {
    const oldActivation = deferred();
    const loadFeature = vi.fn().mockReturnValue(oldActivation.promise);
    const { loader } = createLoader(loadFeature);

    const oldPromise = loader.loadFeature('shortcut', 'CRITICAL');

    const newerActivation = deferred();
    const newerPromise = newerActivation.promise;
    loader.featureLoadPromises.set('shortcut', newerPromise);

    oldActivation.resolve();
    await flushPromises();

    expect(loader.featureLoadPromises.get('shortcut')).toBe(newerPromise);
    expect(newerPromise).not.toBe(oldPromise);
  });

  it('staged startup: overlapping loads for one feature share a single activation', async () => {
    const activation = deferred();
    const loadFeature = vi.fn().mockReturnValue(activation.promise);
    const { loader } = createLoader(loadFeature);

    // Mirrors bootstrap: explicit extensionContext load followed by the staged
    // CRITICAL batch touching the same feature while it is still in flight.
    const explicit = loader.loadFeature('extensionContext', 'CRITICAL');
    const staged = loader.loadFeature('extensionContext', 'CRITICAL');

    expect(loader.featureLoadPromises.has('extensionContext')).toBe(true);

    activation.resolve();
    expect(await staged).toBe(await explicit);
    await flushPromises();

    expect(loadFeature).toHaveBeenCalledTimes(1);
    expect(loader.featureLoadPromises.has('extensionContext')).toBe(false);
  });
});

describe('MainFeatureLoader startup scheduling', () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  };

  const makeDelegatingCore = (impl) => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      logger,
      loader: new MainFeatureLoader({ loadFeature: impl }, async () => logger)
    };
  };

  let idleCallbacks;
  let originalRequestIdleCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    idleCallbacks = [];
    originalRequestIdleCallback = window.requestIdleCallback;
    window.requestIdleCallback = vi.fn(cb => { idleCallbacks.push(cb); });
  });

  afterEach(() => {
    if (originalRequestIdleCallback === undefined) {
      delete window.requestIdleCallback;
    } else {
      window.requestIdleCallback = originalRequestIdleCallback;
    }
    vi.useRealTimers();
  });

  it('is idempotent: second call schedules no duplicate work', async () => {
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await loader.startIntelligentLoading();
    await loader.startIntelligentLoading();
    await flushMicrotasks();

    // CRITICAL and immediate Vue delegated once despite two starts.
    expect(delegated).toHaveBeenCalledWith('messaging');
    expect(delegated).toHaveBeenCalledWith('extensionContext');
    expect(delegated).toHaveBeenCalledWith('vue');
    expect(delegated).toHaveBeenCalledTimes(3);

    // Exactly one ESSENTIAL timeout + no fallbacks (requestIdleCallback present).
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    // Exactly one idle registration per Lazy/On-demand stage.
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(2);

    // ESSENTIAL still not delegated at t=0.
    expect(delegated).not.toHaveBeenCalledWith('contentMessageHandler');
  });

  it('starts Vue only after CRITICAL completes without waiting for Vue to finish', async () => {
    let resolveCritical;
    const criticalGate = new Promise(resolve => { resolveCritical = resolve; });
    let resolveVue;
    const vueGate = new Promise(resolve => { resolveVue = resolve; });
    const delegated = vi.fn(featureName => {
      if (featureName === 'extensionContext') return criticalGate;
      if (featureName === 'vue') return vueGate;
      return Promise.resolve({});
    });
    const { loader } = makeDelegatingCore(delegated);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const started = loader.startIntelligentLoading();
    await flushMicrotasks();

    // Vue and ESSENTIAL scheduling both wait for CRITICAL.
    expect(delegated).not.toHaveBeenCalledWith('vue');
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    resolveCritical();
    await started;
    await flushMicrotasks();

    // Vue starts after CRITICAL but does not block startup while still pending.
    expect(delegated).toHaveBeenCalledWith('vue');
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(idleCallbacks).toHaveLength(2);
    resolveVue();
  });

  it('ESSENTIAL delegates at exactly the 400ms outer delay (no double-delay)', async () => {
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    expect(delegated).not.toHaveBeenCalledWith('contentMessageHandler');

    await vi.advanceTimersByTimeAsync(399);
    expect(delegated).not.toHaveBeenCalledWith('contentMessageHandler');

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('contentMessageHandler');
    expect(delegated).toHaveBeenCalledTimes(4);
  });

  it('Vue delegates at startup while other LAZY_UI features wait for idle', async () => {
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('vue');
    expect(delegated).not.toHaveBeenCalledWith('textSelection');
    expect(delegated).not.toHaveBeenCalledWith('mouseHover');
    expect(idleCallbacks).toHaveLength(2);

    idleCallbacks[0]();
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('textSelection');
    expect(delegated).toHaveBeenCalledWith('mouseHover');
  });

  it('ON_DEMAND idle callback delegates immediately (no extra 4000ms)', async () => {
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    idleCallbacks[1]();
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('shortcut');
    expect(delegated).toHaveBeenCalledWith('textFieldIcon');
  });

  it('fallback without requestIdleCallback uses outer delays, delegation immediate on fire', async () => {
    delete window.requestIdleCallback;
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('vue');
    expect(delegated).not.toHaveBeenCalledWith('textSelection');

    await vi.advanceTimersByTimeAsync(2500);
    await flushMicrotasks();
    expect(delegated).toHaveBeenCalledWith('textSelection');
    expect(delegated).toHaveBeenCalledWith('mouseHover');

    expect(delegated).not.toHaveBeenCalledWith('shortcut');
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    expect(delegated).toHaveBeenCalledWith('shortcut');
    expect(delegated).toHaveBeenCalledWith('textFieldIcon');
  });

  it('direct loadFeature schedules nothing: delegating without timer advance is end-to-end', async () => {
    const delegated = vi.fn().mockResolvedValue({});
    const { loader } = makeDelegatingCore(delegated);

    await loader.loadFeature('contentMessageHandler', 'ESSENTIAL');
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('contentMessageHandler');
    expect(delegated).toHaveBeenCalledTimes(1);
  });

  it('error isolation: one failed feature does not block siblings or later stages', async () => {
    const delegated = vi.fn().mockImplementation(featureName => {
      if (featureName === 'extensionContext') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    const { loader, logger } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    // extensionContext failure swallowed, messaging sibling still loaded.
    expect(logger.warn).toHaveBeenCalled();
    expect(delegated).toHaveBeenCalledWith('messaging');

    // Later stages still schedule and run.
    idleCallbacks[0]();
    idleCallbacks[1]();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('contentMessageHandler');
    expect(delegated).toHaveBeenCalledWith('vue');
    expect(delegated).toHaveBeenCalledWith('shortcut');
  });

  it('Vue failure does not prevent critical or unrelated lazy features', async () => {
    const delegated = vi.fn().mockImplementation(featureName => {
      if (featureName === 'vue') return Promise.reject(new Error('Vue failed'));
      return Promise.resolve({});
    });
    const { loader } = makeDelegatingCore(delegated);

    await loader.startIntelligentLoading();
    await flushMicrotasks();

    expect(delegated).toHaveBeenCalledWith('messaging');
    expect(delegated).toHaveBeenCalledWith('extensionContext');
    expect(delegated).not.toHaveBeenCalledWith('textSelection');

    idleCallbacks[0]();
    await flushMicrotasks();
    expect(delegated).toHaveBeenCalledWith('textSelection');
    expect(delegated).toHaveBeenCalledWith('mouseHover');
  });
});

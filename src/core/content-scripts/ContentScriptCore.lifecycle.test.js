import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const m = {
    check: vi.fn().mockResolvedValue(false),
    aggregatorCtor: vi.fn(),
    coordinatorCtor: vi.fn(),
    loaderCtor: vi.fn(),
    loadFeature: vi.fn().mockResolvedValue({}),
    startIntelligent: vi.fn(),
    interactionInit: vi.fn().mockResolvedValue(undefined),
    installRelay: vi.fn(),
    fmInit: vi.fn(async () => { m.fmInitialized = true; }),
    fmInitialized: false,
    policyCbs: new Set(),
    requestedFeatures: new Set(),
  };
  m.onPolicyChanged = vi.fn((cb) => {
    m.policyCbs.add(cb);
    return () => m.policyCbs.delete(cb);
  });
  return m;
});

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { getURL: (path) => `moz-extension://test/${path}` } },
}));

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: mocks.check,
}));

vi.mock('@/core/tabPermissions.js', () => ({
  checkContentScriptAccess: () => ({ isAccessible: true }),
}));
vi.mock('@/shared/managers/SettingsManager.js', () => ({
  default: {
    initialize: vi.fn().mockResolvedValue(undefined),
    warmup: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
    isExtensionEnabled: vi.fn().mockReturnValue(true),
  },
}));
vi.mock('@/shared/logging/DebugModeBridge.js', () => ({
  debugModeBridge: { initialize: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS: { CONTENT: 'content' } }));
vi.mock('@/core/extensionContext.js', () => ({ default: { isValidSync: () => true } }));
vi.mock('@/shared/messaging/core/MessageHandler.js', () => ({
  createMessageHandler: () => ({ isListenerActive: false, listen: vi.fn(), registerHandler: vi.fn() }),
}));
vi.mock('@/shared/error-management/windowErrorHandlers.js', () => ({
  setupWindowErrorHandlers: vi.fn(),
}));
vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  initializeContentScriptIntegration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./main/MainFrameAggregator.js', () => ({
  MainFrameAggregator: class {
    constructor(...args) {
      mocks.aggregatorCtor(...args);
      this.getGlobalPageTranslationStatus = vi.fn();
    }
  },
}));
vi.mock('./main/MainFrameCoordinator.js', () => ({
  MainFrameCoordinator: class {
    constructor(...args) {
      mocks.coordinatorCtor(...args);
    }
  },
}));
vi.mock('./main/MainFeatureLoader.js', () => ({
  MainFeatureLoader: class {
    constructor(...args) {
      mocks.loaderCtor(...args);
    }
    loadFeature(...args) {
      return mocks.loadFeature(...args);
    }
    startIntelligentLoading(...args) {
      return mocks.startIntelligent(...args);
    }
  },
}));
vi.mock('./InteractionCoordinator.js', () => ({
  interactionCoordinator: { initialize: mocks.interactionInit },
}));
vi.mock('@/features/windows/managers/crossframe/TextSelectionWindowRelay.js', () => ({
  installTextSelectionWindowRelay: mocks.installRelay,
}));
vi.mock('@/core/managers/content/FeatureManager.js', () => ({
  FeatureManager: {
    getInstance: () => ({
      get initialized() { return mocks.fmInitialized; },
      set initialized(v) { mocks.fmInitialized = v; },
      initialize: mocks.fmInit,
      onPolicyChanged: mocks.onPolicyChanged,
      requestedFeatures: mocks.requestedFeatures,
      getFeatureHandler: vi.fn(),
      isFeatureActive: vi.fn(),
    }),
  },
}));
vi.mock('@/utils/ui/exclusion.js', () => ({ matchesAutoTranslateRule: vi.fn().mockReturnValue(false) }));
vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  ExclusionChecker: { getInstance: () => ({ initialize: vi.fn().mockResolvedValue(undefined), isFeatureAllowed: vi.fn().mockResolvedValue(true) }) },
}));
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({ sendRegularMessage: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@/shared/messaging/core/MessageActions.js', () => ({ MessageActions: {} }));

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('ContentScriptCore lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.check.mockResolvedValue(false);
    mocks.requestedFeatures.clear();
    mocks.policyCbs.clear();
    mocks.fmInitialized = false;
    mocks.loadFeature.mockResolvedValue({});
    mocks.interactionInit.mockResolvedValue(undefined);
    mocks.fmInit.mockImplementation(async () => { mocks.fmInitialized = true; });
    delete window.getGlobalPageTranslationStatus;
    delete window.translateItContentScriptLoaded;
    delete window._translateItBootstrapPromise;
    window.translateItContentScriptInitializing = false;
    window.translateItContentCore = undefined;
    window.translateItContentScriptCore = undefined;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://example.com/', protocol: 'https:', host: 'example.com' },
    });
    document.documentElement.classList.remove('translate-it-ui-frame');
    globalThis.browser = { runtime: { getURL: (p) => `moz-extension://test/${p}` } };
    window.browser = globalThis.browser;
    delete globalThis.chrome;
  });

  it('C1 concurrent ensureAllowedRuntime dedupes composition constructors', async () => {
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    // ensure clean counts
    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();

    const p1 = core.ensureAllowedRuntime();
    const p2 = core.ensureAllowedRuntime();
    // both share same inner promise (wrapped)
    expect(core._allowedRuntimePromise).toBeTruthy();
    const inner = core._allowedRuntimePromise;
    // p1/p2 are outer async wrappers, but inner should be same
    await Promise.all([p1, p2]);

    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    // owned refs present
    expect(core._mainFrameAggregator).toBeTruthy();
    expect(core._mainFrameCoordinator).toBeTruthy();
    expect(core._mainFeatureLoader).toBeTruthy();
    // ensure p1/p2 both resolved true
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    expect(inner).toBeTruthy();
  });

  it('C2 pre-bootstrap failure clears promise and retries', async () => {
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    mocks.check.mockRejectedValueOnce(new Error('pre-bootstrap fail'));
    await expect(core.ensureAllowedRuntime()).rejects.toThrow('pre-bootstrap fail');
    expect(core._allowedRuntimePromise).toBeNull();
    expect(core._allowedRuntimeStarted).toBe(false);

    mocks.check.mockResolvedValue(false);
    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();

    await expect(core.ensureAllowedRuntime()).resolves.toBe(true);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
  });

  it('C2b bootstrap failure after composition start does not duplicate permanent objects', async () => {
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();
    mocks.loadFeature.mockClear();

    // First attempt: fail at loadFeature('extensionContext') after constructors
    mocks.loadFeature.mockRejectedValueOnce(new Error('bootstrap fail'));

    await expect(core.ensureAllowedRuntime()).rejects.toThrow('bootstrap fail');
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(core._allowedRuntimePromise).toBeNull();
    // constructors were called once even though bootstrap failed
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    // owned refs retained (aggregator/coordinator/loader) — not duplicated on retry
    const aggBefore = core._mainFrameAggregator;
    const coordBefore = core._mainFrameCoordinator;
    const loaderBefore = core._mainFeatureLoader;
    expect(aggBefore).toBeTruthy();
    expect(coordBefore).toBeTruthy();
    expect(loaderBefore).toBeTruthy();

    mocks.loadFeature.mockResolvedValue({});
    await expect(core.ensureAllowedRuntime()).resolves.toBe(true);

    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    // No duplicate construction on retry
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    expect(core._mainFrameAggregator).toBe(aggBefore);
    expect(core._mainFrameCoordinator).toBe(coordBefore);
    expect(core._mainFeatureLoader).toBe(loaderBefore);
  });

  it('C4 initializeCritical waits for allowed-runtime barrier', async () => {
    mocks.check.mockResolvedValue(false);
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    const barrier = deferred();
    mocks.loadFeature.mockImplementation((name) => {
      if (name === 'extensionContext') return barrier.promise;
      return Promise.resolve({});
    });

    const initPromise = core.initializeCritical();
    // should be pending while barrier blocked
    let settled = false;
    initPromise.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(core._allowedRuntimeStarted).toBe(false);

    barrier.resolve({});
    await expect(initPromise).resolves.toBe(true);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core.initialized).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
  });

  it('C5 initializeCritical with exclusion=true keeps minimal core only', async () => {
    mocks.check.mockResolvedValue(true);
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();
    mocks.loadFeature.mockClear();
    mocks.startIntelligent.mockClear();

    await expect(core.initializeCritical()).resolves.toBe(true);

    expect(core.initialized).toBe(true);
    expect(mocks.fmInit).toHaveBeenCalled();
    expect(mocks.onPolicyChanged).toHaveBeenCalled();
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(mocks.aggregatorCtor).not.toHaveBeenCalled();
    expect(mocks.coordinatorCtor).not.toHaveBeenCalled();
    expect(mocks.loaderCtor).not.toHaveBeenCalled();
    expect(mocks.startIntelligent).not.toHaveBeenCalled();
    expect(mocks.loadFeature).not.toHaveBeenCalledWith('vue');
  });

  it('C6 excluded then policy callback triggers allowed runtime without requestedFeatures', async () => {
    mocks.check.mockResolvedValue(true);
    mocks.requestedFeatures.clear();
    expect(mocks.requestedFeatures.size).toBe(0);

    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    await expect(core.initializeCritical()).resolves.toBe(true);
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(mocks.policyCbs.size).toBe(1);
    const cb = Array.from(mocks.policyCbs)[0];

    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();
    mocks.check.mockResolvedValue(false);

    // Trigger via actual policy callback, not direct reconcile
    cb('url-change');
    await vi.waitFor(() => expect(core._allowedRuntimeStarted).toBe(true));

    expect(core._allowedRuntimePromise).toBeNull();
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    // requestedFeatures was not required as trigger, but loader may populate later
    // at least not required to be non-empty before
  });

  it('M1 initial allowed failure is retryable via initializeCritical', async () => {
    mocks.check.mockResolvedValue(false);
    const { ContentScriptCore } = await import('./ContentScriptCore.js');
    const core = new ContentScriptCore();
    await core.initializeBase();

    mocks.aggregatorCtor.mockClear();
    mocks.coordinatorCtor.mockClear();
    mocks.loaderCtor.mockClear();
    mocks.loadFeature.mockClear();

    // Force failure after permanent composition (loadFeature)
    mocks.loadFeature.mockRejectedValueOnce(new Error('initial bootstrap fail'));

    await expect(core.initializeCritical()).resolves.toBe(false);
    expect(core.initialized).toBe(false);
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(core._criticalInitializationPromise).toBeNull();
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    const aggBefore = core._mainFrameAggregator;
    const coordBefore = core._mainFrameCoordinator;
    const loaderBefore = core._mainFeatureLoader;
    expect(aggBefore).toBeTruthy();

    mocks.loadFeature.mockResolvedValue({});

    await expect(core.initializeCritical()).resolves.toBe(true);
    expect(core.initialized).toBe(true);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    // No duplicate permanent objects on retry
    expect(mocks.aggregatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.coordinatorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.loaderCtor).toHaveBeenCalledTimes(1);
    expect(core._mainFrameAggregator).toBe(aggBefore);
    expect(core._mainFrameCoordinator).toBe(coordBefore);
    expect(core._mainFeatureLoader).toBe(loaderBefore);
  });
});

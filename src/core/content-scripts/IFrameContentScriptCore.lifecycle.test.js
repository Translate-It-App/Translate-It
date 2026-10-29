import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const m = {
    check: vi.fn().mockResolvedValue(false),
    fmInit: vi.fn(async () => { m.fmInitialized = true; }),
    fmInitialized: false,
    policyCbs: new Set(),
    requestedFeatures: new Set(),
    interactionInit: vi.fn().mockResolvedValue(undefined),
    getRelay: vi.fn(),
    loadFeature: vi.fn().mockResolvedValue({}),
    frameReady: vi.fn().mockResolvedValue({ success: true }),
    injectStyles: vi.fn(),
  };
  m.onPolicyChanged = vi.fn((cb) => {
    m.policyCbs.add(cb);
    return () => m.policyCbs.delete(cb);
  });
  return m;
});

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { getURL: (p) => `moz-extension://test/${p}`, sendMessage: mocks.frameReady } },
}));

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: mocks.check,
}));
vi.mock('@/core/tabPermissions.js', () => ({
  checkContentScriptAccess: () => ({ isAccessible: true }),
}));
vi.mock('@/shared/managers/SettingsManager.js', () => ({
  default: { initialize: vi.fn().mockResolvedValue(undefined), warmup: vi.fn(), get: vi.fn(), isExtensionEnabled: vi.fn().mockReturnValue(true) },
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
  createMessageHandler: () => ({ isListenerActive: false, listen: vi.fn(), registerHandler: vi.fn(), stopListening: vi.fn() }),
}));
vi.mock('@/shared/error-management/windowErrorHandlers.js', () => ({
  setupWindowErrorHandlers: vi.fn(),
}));
vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  initializeContentScriptIntegration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: { SELECT_ELEMENT_FRAME_READY: 'selectElementFrameReady' },
}));
vi.mock('./InteractionCoordinator.js', () => ({
  interactionCoordinator: { initialize: mocks.interactionInit },
}));
vi.mock('@/features/windows/managers/crossframe/TextSelectionWindowRelay.js', () => ({
  getTextSelectionWindowRelay: mocks.getRelay,
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
vi.mock('./chunks/lazy-features.js', () => ({
  loadFeatureOnDemand: (...args) => mocks.loadFeature(...args),
}));

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('IFrameContentScriptCore lifecycle', () => {
  let addEventListenerSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.check.mockResolvedValue(false);
    mocks.requestedFeatures.clear();
    mocks.policyCbs.clear();
    mocks.fmInitialized = false;
    mocks.loadFeature.mockResolvedValue({});
    mocks.interactionInit.mockResolvedValue(undefined);
    mocks.frameReady.mockResolvedValue({ success: true });
    mocks.getRelay.mockReturnValue({});
    mocks.fmInit.mockImplementation(async () => { mocks.fmInitialized = true; });
    delete window.getGlobalPageTranslationStatus;
    delete window.translateItContentScriptLoaded;
    delete window._translateItBootstrapPromise;
    window.translateItContentScriptInitializing = false;
    window.translateItContentCore = undefined;
    window.translateItContentScriptCore = undefined;
    document.getElementById('translate-it-main-dom-styles')?.remove();
    document.getElementById('translate-it-select-mode-styles')?.remove();
    document.getElementById('website-highlight-token')?.remove();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://example.com/frame.html', protocol: 'https:', host: 'example.com' },
    });
    document.documentElement.classList.remove('translate-it-ui-frame');
    globalThis.browser = { runtime: { getURL: (p) => `moz-extension://test/${p}`, sendMessage: mocks.frameReady } };
    window.browser = globalThis.browser;
    globalThis.chrome = { runtime: { sendMessage: mocks.frameReady } };
    mocks.injectStyles = vi.fn();
    // spy on addEventListener for iframe message listener
    if (addEventListenerSpy) addEventListenerSpy.mockRestore();
    addEventListenerSpy = vi.spyOn(window, 'addEventListener');
  });

  it('I1 excluded initialization minimal core', async () => {
    mocks.check.mockResolvedValue(true);
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();

    await expect(core.initializeCritical()).resolves.toBe(true);

    expect(core.initialized).toBe(true);
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(mocks.loadFeature).not.toHaveBeenCalled();
    expect(mocks.frameReady).not.toHaveBeenCalled();
    // no iframe message listener for excluded
    const messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(0);
  });

  it('I2 allowed initialization waits for lite features and FRAME_READY', async () => {
    mocks.check.mockResolvedValue(false);
    const barrier = deferred();
    mocks.getRelay.mockImplementation(() => ({}));
    // Make loadFeature for 'contentMessageHandler' block to test readiness
    mocks.loadFeature.mockImplementation((name) => {
      if (name === 'contentMessageHandler') return barrier.promise;
      return Promise.resolve({});
    });

    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();

    const initPromise = core.initializeCritical();
    // should be pending while contentMessageHandler blocked
    let settled = false;
    initPromise.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(mocks.frameReady).not.toHaveBeenCalled();

    barrier.resolve({});
    await expect(initPromise).resolves.toBe(true);

    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    // Lite features: messaging, extensionContext, contentMessageHandler, mouseHover
    expect(mocks.loadFeature).toHaveBeenCalledWith('messaging');
    expect(mocks.loadFeature).toHaveBeenCalledWith('extensionContext');
    expect(mocks.loadFeature).toHaveBeenCalledWith('contentMessageHandler');
    expect(mocks.loadFeature).toHaveBeenCalledWith('mouseHover');
    // FRAME_READY sent after
    expect(mocks.frameReady).toHaveBeenCalledWith({ action: 'selectElementFrameReady', data: {} });
    expect(mocks.frameReady.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.loadFeature.mock.invocationCallOrder[2]);
    // message listener installed once
    const messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(1);
  });

  it('I3 concurrent ensureAllowedRuntime dedupes styles/listener/runtime', async () => {
    mocks.check.mockResolvedValue(false);
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();
    const injectStyles = vi.spyOn(core, 'injectStyles');
    const pageStyles = document.createElement('style');
    pageStyles.id = 'website-highlight-token';
    pageStyles.textContent = ':root { --translate-highlight-color: rgb(1, 2, 3); }';
    document.head.appendChild(pageStyles);

    const p1 = core.ensureAllowedRuntime();
    const p2 = core.ensureAllowedRuntime();

    expect(core._allowedRuntimePromise).toBeTruthy();
    const results = await Promise.all([p1, p2]);

    expect(results).toEqual([true, true]);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(injectStyles).not.toHaveBeenCalled();
    expect(document.getElementById('translate-it-main-dom-styles')).toBeNull();
    expect(getComputedStyle(document.documentElement).getPropertyValue('--translate-highlight-color').trim()).toBe('rgb(1,2,3)');
    // loadFeature called once per lite feature, not duplicated
    const lite = ['messaging', 'extensionContext', 'contentMessageHandler', 'mouseHover'];
    for (const f of lite) {
      const count = mocks.loadFeature.mock.calls.filter(([name]) => name === f).length;
      expect(count).toBe(1);
    }
    // injectMainDOMStyles called once (via core method, we can check via spy)
    // message listener once
    const messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(1);
    expect(mocks.frameReady).toHaveBeenCalledTimes(1);
  });

  it('injects only supplied feature styles and deduplicates their stylesheet ID', async () => {
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();
    const injectStyles = vi.spyOn(core, 'injectStyles');
    const css = 'html[data-translate-it-select-mode="true"] body .translate-it-element-highlighted { outline: 3px solid #ff8800 !important; }';

    core.injectMainDOMStyles();
    expect(injectStyles).not.toHaveBeenCalled();
    core.injectMainDOMStyles(css, 'translate-it-select-mode-styles');
    core.injectMainDOMStyles(css, 'translate-it-select-mode-styles');

    expect(injectStyles).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#translate-it-select-mode-styles')).toHaveLength(1);
    expect(document.getElementById('translate-it-select-mode-styles').textContent).toBe(css);
  });

  it('I4 retry after failure does not duplicate iframe message listener', async () => {
    mocks.check.mockResolvedValue(false);
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();
    const injectStyles = vi.spyOn(core, 'injectStyles');

    // First attempt fails at loadFeature (before listener)
    mocks.loadFeature.mockRejectedValueOnce(new Error('iframe bootstrap fail'));

    await expect(core.ensureAllowedRuntime()).rejects.toThrow('iframe bootstrap fail');
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(injectStyles).not.toHaveBeenCalled();
    // No FRAME_READY on failure
    expect(mocks.frameReady).not.toHaveBeenCalled();
    // Listener not yet set (failed before)
    let messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(0);

    mocks.loadFeature.mockResolvedValue({});
    await expect(core.ensureAllowedRuntime()).resolves.toBe(true);

    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(injectStyles).not.toHaveBeenCalled();
    expect(mocks.frameReady).toHaveBeenCalledTimes(1);
    messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(1);

    // Second concurrent after success should not duplicate
    const p1 = core.ensureAllowedRuntime();
    const p2 = core.ensureAllowedRuntime();
    await Promise.all([p1, p2]);
    messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(1);
    expect(mocks.frameReady).toHaveBeenCalledTimes(1);
  });

  it('I5 initial allowed failure is retryable via initializeCritical', async () => {
    mocks.check.mockResolvedValue(false);
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const core = new IFrameContentScriptCore();
    await core.initializeBase();

    mocks.loadFeature.mockRejectedValueOnce(new Error('initial iframe fail'));

    await expect(core.initializeCritical()).resolves.toBe(false);
    expect(core.initialized).toBe(false);
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(core._criticalInitializationPromise).toBeNull();
    expect(mocks.frameReady).not.toHaveBeenCalled();
    let messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(0);

    mocks.loadFeature.mockResolvedValue({});

    await expect(core.initializeCritical()).resolves.toBe(true);
    expect(core.initialized).toBe(true);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(core._allowedRuntimePromise).toBeNull();
    expect(mocks.frameReady).toHaveBeenCalledTimes(1);
    messageCalls = addEventListenerSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(messageCalls.length).toBe(1);
  });
});

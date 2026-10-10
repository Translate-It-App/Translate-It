import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/config.js', async (importOriginal) => {
  const config = await importOriginal();
  const getters = [
    'getWholePageRootMarginAsync', 'getModeProvidersAsync', 'getTranslationApiAsync',
    'getTargetLanguageAsync', 'getWholePageLazyLoadingAsync',
    'getWholePageAutoTranslateOnDOMChangesAsync', 'getWholePageExcludedSelectorsAsync',
    'getWholePageAttributesToTranslateAsync', 'getWholePageShowOriginalOnHoverAsync',
    'getWholePageTranslateAfterScrollStopAsync', 'getWholePageScrollStopDelayAsync',
    'getWholePageTokenWarningHiddenAsync', 'getAIContextTranslationEnabledAsync',
    'getWholePageUseTranslationFontAsync',
  ];
  return { ...config, ...Object.fromEntries(getters.map(key => [key, vi.fn()])) };
});

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: vi.fn().mockReturnValue({ displayName: 'Google', consumesTokens: false })
}));

// 1. Mock webextension-polyfill FIRST
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { 
      sendMessage: vi.fn(), 
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() } 
    },
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

// 3. Mock internal components
vi.mock('./PageTranslationHelper.js', () => ({
  PageTranslationHelper: {
    isSuitableForTranslation: vi.fn(() => true),
    deepCleanDOM: vi.fn(),
    isSuitableForElement: vi.fn(() => true)
  }
}));

  vi.mock('./PageTranslationScheduler.js', () => ({
    PageTranslationScheduler: class {
      constructor({ onFatalError, onLifecycleEvent, onInternalError } = {}) {
        this.onFatalError = onFatalError;
        this.onLifecycleEvent = onLifecycleEvent;
        this.onInternalError = onInternalError;
        this.reset = vi.fn();
        this.setSettings = vi.fn();
        this.setTranslationState = vi.fn();
        this.enqueue = vi.fn();
        this.recordRetainedTranslation = vi.fn(() => {
          this.totalTasks++;
          this.translatedCount++;
        });
        this.translatedCount = 0;
        this.translationSessionId = null;
        this.sessionContext = null;
        this.signalScrollStop = vi.fn();
        this.signalScrollStart = vi.fn();
      }
    }
  }));

vi.mock('./PageTranslationBridge.js', () => ({
  PageTranslationBridge: class {
    constructor() {
      this.initialize = vi.fn().mockResolvedValue(undefined);
      this.translate = vi.fn();
      this.restore = vi.fn();
      this.cleanup = vi.fn();
      this.stopPersistence = vi.fn();
    }
  }
}));

vi.mock('./utils/PageTranslationScrollTracker.js', () => ({
  PageTranslationScrollTracker: class {
    constructor() {
      this.start = vi.fn();
      this.stop = vi.fn();
      this.destroy = vi.fn();
      this.notifyActivity = vi.fn();
    }
  }
}));

vi.mock('./utils/PageTranslationSettingsLoader.js', () => ({
  PageTranslationSettingsLoader: {
    load: vi.fn().mockResolvedValue({
      targetLanguage: 'fa',
      translationApi: 'google',
      showOriginalOnHover: true,
      autoTranslateOnDOMChanges: false
    })
  }
}));

vi.mock('./utils/PageTranslationEventManager.js', () => ({
  PageTranslationEventManager: class {
    constructor() {
      this.initialize = vi.fn();
      this.destroy = vi.fn();
    }
  }
}));

// 4. Mock UI & Messaging components
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('@/shared/toast/ToastIntegration.js', () => ({
  ToastIntegration: class {
    constructor() {
      this.initialize = vi.fn().mockResolvedValue(undefined);
      this.shutdown = vi.fn();
    }
  }
}));

vi.mock('@/core/managers/core/NotificationManager.js', () => ({
  default: class {
    constructor() {
      this.show = vi.fn();
    }
  }
}));

vi.mock('@/shared/error-management/ErrorHandler.js');

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}));

vi.mock('@/utils/i18n/i18n.js', () => ({
  getTranslationString: vi.fn().mockResolvedValue('Translated String')
}));

vi.mock('@/shared/utils/warning-manager.js', () => ({
  shouldShowProviderWarning: vi.fn().mockResolvedValue(false)
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewManager.js', () => ({
  hoverPreviewManager: {
    initialize: vi.fn(),
    destroy: vi.fn()
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: mockLoggerWarn,
    info: vi.fn(),
    init: vi.fn(),
    debugLazy: vi.fn()
  }))
}));

const mockStorageManagerSet = vi.hoisted(() => vi.fn());
const mockStorageManagerOn = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockSpaLoadFeature = vi.hoisted(() => vi.fn());
const mockSpaSettingsManager = vi.hoisted(() => ({ get: vi.fn(), isExtensionEnabled: vi.fn() }));

vi.mock('@/shared/managers/SettingsManager.js', () => ({ default: mockSpaSettingsManager }));
vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: mockSpaLoadFeature }));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    set: mockStorageManagerSet,
    get: vi.fn(),
    on: mockStorageManagerOn,
    off: vi.fn(),
  }
}));

// Mock window.location
vi.stubGlobal('location', {
  ...window.location,
  href: 'https://example.com'
});

import { PageTranslationManager } from './PageTranslationManager.js';
import { PageTranslationHelper } from './PageTranslationHelper.js';
import { PageTranslationSettingsLoader } from './utils/PageTranslationSettingsLoader.js';
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingCore.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

describe('PageTranslationManager', () => {
  let manager;

  const createDeferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageManagerSet.mockResolvedValue(true);
    // Ensure helper returns true by default for all tests
    PageTranslationHelper.isSuitableForTranslation.mockReturnValue(true);
    
    manager = new PageTranslationManager();
    // Setup standard DOM elements
    document.head.innerHTML = '';
    document.body.innerHTML = '<div>Original Content</div>';
  });

  afterEach(async () => {
    await manager.cleanup();
    PageTranslationSettingsLoader.load.mockResolvedValue({
      targetLanguage: 'fa', translationApi: 'google', showOriginalOnHover: true,
      autoTranslateOnDOMChanges: false,
    });
  });

  describe('Activation', () => {
    it('should activate and load settings', async () => {
      const success = await manager.activate();
      expect(success).toBe(true);
      expect(manager.isActive).toBe(true);
      expect(manager.settings).toBeDefined();
      expect(manager.eventManager.initialize).toHaveBeenCalledOnce();
    });

    it('removes navigation listeners on deactivation and reinstalls them on activation', async () => {
      await manager.activate();
      await manager.deactivate();
      expect(manager.eventManager.destroy).toHaveBeenCalledOnce();

      await manager.activate();
      expect(manager.eventManager.initialize).toHaveBeenCalledTimes(2);
    });
  });

  describe('Translation Lifecycle', () => {
    const acceptedSettings = {
      translationApi: 'custom', targetLanguage: 'fa', lazyLoading: false,
      showOriginalOnHover: false, autoTranslateOnDOMChanges: true,
      tokenWarningHidden: true, usesGlobalProvider: false, isExplicitProvider: false,
    };

    const useActualSettingsLoader = async (modeProviders = {}) => {
      const config = await import('@/config.js');
      const { PageTranslationSettingsLoader: ActualLoader } = await vi.importActual('./utils/PageTranslationSettingsLoader.js');
      const values = {
        getWholePageRootMarginAsync: 150, getModeProvidersAsync: modeProviders,
        getTranslationApiAsync: 'google', getTargetLanguageAsync: 'fa',
        getWholePageLazyLoadingAsync: false, getWholePageAutoTranslateOnDOMChangesAsync: true,
        getWholePageExcludedSelectorsAsync: [], getWholePageAttributesToTranslateAsync: [],
        getWholePageShowOriginalOnHoverAsync: false, getWholePageTranslateAfterScrollStopAsync: false,
        getWholePageScrollStopDelayAsync: 500, getWholePageTokenWarningHiddenAsync: true,
        getAIContextTranslationEnabledAsync: true, getWholePageUseTranslationFontAsync: false,
      };
      for (const [key, value] of Object.entries(values)) config[key].mockResolvedValue(value);
      PageTranslationSettingsLoader.load.mockImplementation(options => ActualLoader.load(options));
      const { PageTranslationEventManager: ActualEvents } = await vi.importActual('./utils/PageTranslationEventManager.js');
      manager.eventManager = new ActualEvents(manager);
      return { config, handlers: new Map(mockStorageManagerOn.mock.calls) };
    };

    it('retains accepted originals when another real route supersedes pending settings', async () => {
      const previousLocation = window.location;
      vi.unstubAllGlobals();
      const originalUrl = window.location.href;
      const { PageTranslationBridge: ActualBridge } = await vi.importActual('./PageTranslationBridge.js');
      manager.bridge = new ActualBridge();
      PageTranslationSettingsLoader.load.mockResolvedValue(acceptedSettings);
      const requests = [];
      manager.scheduler.enqueue.mockImplementation(text => new Promise(resolve => requests.push({ text, resolve })));
      const accepted = text => ({
        __pageTranslationSettlement: true, text, state: 'pending',
        settle(outcome) { this.state = outcome; },
      });
      try {
        document.body.innerHTML = '<nav>Shared original route A source</nav>';
        await manager.translatePage({ isAuto: true });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        requests[0].resolve(accepted('Shared translated navigation'));
        await vi.waitFor(() => expect(document.querySelector('nav').textContent).toContain('Shared translated navigation'));
        const routeBSettings = createDeferred();
        PageTranslationSettingsLoader.load.mockImplementationOnce(() => routeBSettings.promise);
        await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
        window.history.replaceState({}, '', '/route-b');
        const routeB = manager.translatePage({ isAuto: true, preserveAcceptedTranslations: true });
        await vi.waitFor(() => expect(PageTranslationSettingsLoader.load).toHaveBeenCalledTimes(2));
        const routeBController = manager.abortController;
        await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
        window.history.replaceState({}, '', '/route-c');
        const routeC = await manager.translatePage({ isAuto: true, preserveAcceptedTranslations: true });
        expect(routeC.success).toBe(true);
        expect(routeBController.signal.aborted).toBe(true);
        expect(manager.scheduler.recordRetainedTranslation).toHaveBeenCalledOnce();
        expect(requests).toHaveLength(1);
        routeBSettings.resolve({ ...acceptedSettings, translationApi: 'google' });
        expect((await routeB).success).toBe(false);
        expect(manager.settings.translationApi).toBe('custom');
        await manager.restorePage({ manual: true });
        expect(document.querySelector('nav').textContent).toBe('Shared original route A source');
      } finally {
        window.history.replaceState({}, '', originalUrl);
        vi.stubGlobal('location', previousLocation);
        PageTranslationSettingsLoader.load.mockResolvedValue({
          targetLanguage: 'fa', translationApi: 'google', showOriginalOnHover: true,
          autoTranslateOnDOMChanges: false,
        });
      }
    });

    it.each(['unchanged', 'edited'])('restores only owned %s text during pending route initialization', async kind => {
      const previousLocation = window.location;
      vi.unstubAllGlobals();
      const originalUrl = window.location.href;
      const { PageTranslationBridge: ActualBridge } = await vi.importActual('./PageTranslationBridge.js');
      manager.bridge = new ActualBridge();
      PageTranslationSettingsLoader.load.mockResolvedValue(acceptedSettings);
      manager.scheduler.enqueue.mockResolvedValue({
        __pageTranslationSettlement: true, text: 'Accepted translation', state: 'pending',
        settle(outcome) { this.state = outcome; },
      });
      try {
        document.body.innerHTML = '<p>Original source</p>';
        await manager.translatePage({ isAuto: true });
        await vi.waitFor(() => expect(document.querySelector('p').textContent).toContain('Accepted translation'));
        const pendingSettings = createDeferred();
        PageTranslationSettingsLoader.load.mockImplementationOnce(() => pendingSettings.promise);
        await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
        window.history.replaceState({}, '', '/pending-restored-route');
        const attempt = manager.translatePage({ isAuto: true, preserveAcceptedTranslations: true });
        await vi.waitFor(() => expect(PageTranslationSettingsLoader.load).toHaveBeenCalledTimes(2));
        if (kind === 'edited') document.querySelector('p').firstChild.nodeValue = 'Current route host edit';
        await manager.restorePage({ manual: true });
        expect(document.querySelector('p').textContent).toBe(kind === 'edited' ? 'Current route host edit' : 'Original source');
        pendingSettings.resolve(acceptedSettings);
        expect((await attempt).success).toBe(false);
        expect(manager.bridge.session).toBeNull();
        expect(manager.userRestoredOverride).toBe(true);
      } finally {
        window.history.replaceState({}, '', originalUrl);
        vi.stubGlobal('location', previousLocation);
      }
    });

    it('rejects a pending global-dependent load after the global provider changes', async () => {
      manager.settings = acceptedSettings;
      const { config, handlers } = await useActualSettingsLoader();
      const optionalFont = createDeferred();
      config.getWholePageUseTranslationFontAsync.mockImplementation(() => optionalFont.promise);
      const attempt = manager.translatePage({ isAuto: true });
      await vi.waitFor(() => expect(config.getWholePageUseTranslationFontAsync).toHaveBeenCalledOnce());
      const controller = manager.abortController;
      config.getTranslationApiAsync.mockResolvedValue('gemini');
      handlers.get('change:TRANSLATION_API')({ oldValue: 'google', newValue: 'gemini' });
      expect(controller.signal.aborted).toBe(true);
      expect(manager.translationSettingsRevision).toBe(1);
      optionalFont.resolve(false);
      expect((await attempt).success).toBe(false);
      expect(manager.bridge.initialize).not.toHaveBeenCalled();
      expect(pageEventBus.emit.mock.calls.some(([action]) => action === MessageActions.PAGE_TRANSLATE_START)).toBe(false);
    });

    it.each(['TRANSLATION_API', 'MODE_PROVIDERS'])(
      'keeps a pending explicit provider when unrelated %s changes', async key => {
        const { config, handlers } = await useActualSettingsLoader();
        const optionalFont = createDeferred();
        config.getWholePageUseTranslationFontAsync.mockImplementation(() => optionalFont.promise);
        const attempt = manager.translatePage({ isAuto: true, provider: 'custom' });
        await vi.waitFor(() => expect(config.getWholePageUseTranslationFontAsync).toHaveBeenCalledOnce());
        const controller = manager.abortController;
        handlers.get(`change:${key}`)(key === 'TRANSLATION_API'
          ? { oldValue: 'google', newValue: 'gemini' }
          : { oldValue: {}, newValue: { [config.TranslationMode.Page]: 'gemini' } });
        expect(controller.signal.aborted).toBe(false);
        expect(manager.translationSettingsRevision).toBe(0);
        optionalFont.resolve(false);
        expect((await attempt).success).toBe(true);
        expect(manager.settings).toMatchObject({ translationApi: 'custom', isExplicitProvider: true });
      }
    );

    it('keeps an accepted explicit provider when the Page default changes', async () => {
      const { config, handlers } = await useActualSettingsLoader();
      await manager.translatePage({ isAuto: true, provider: 'custom' });
      const controller = manager.abortController;
      handlers.get('change:MODE_PROVIDERS')({ oldValue: {}, newValue: { [config.TranslationMode.Page]: 'gemini' } });
      expect(controller.signal.aborted).toBe(false);
      expect(manager.isAutoTranslating).toBe(true);
      expect(manager.settings.translationApi).toBe('custom');
    });

    it('keeps explicit provider precedence while resolving a feature conflict before settings load', async () => {
      const { config, handlers } = await useActualSettingsLoader();
      const conflict = createDeferred();
      manager.featureManager = { resolveFeatureConflict: vi.fn(() => conflict.promise) };
      const attempt = manager.translatePage({ isAuto: true, provider: 'custom' });
      expect(manager.featureManager.resolveFeatureConflict).toHaveBeenCalledOnce();
      expect(PageTranslationSettingsLoader.load).not.toHaveBeenCalled();
      handlers.get('change:TRANSLATION_API')({ oldValue: 'google', newValue: 'gemini' });
      handlers.get('change:MODE_PROVIDERS')({ oldValue: {}, newValue: { [config.TranslationMode.Page]: 'gemini' } });
      expect(manager.translationSettingsRevision).toBe(0);
      conflict.resolve();
      expect((await attempt).success).toBe(true);
      expect(manager.settings.translationApi).toBe('custom');
    });

    it.each(['stop', 'restore', 'cancel', 'internal stop'])(
      'does not restart after %s during the first feature conflict wait', async action => {
        const conflict = createDeferred();
        manager.featureManager = { resolveFeatureConflict: vi.fn(() => conflict.promise) };
        const attempt = manager.translatePage({ isAuto: true });
        const controller = manager.abortController;
        if (action === 'restore') await manager.restorePage({ manual: true });
        else if (action === 'cancel') manager.cancelTranslation({ manual: true });
        else await manager.stopAutoTranslation(action === 'internal stop' ? { cancellationReason: 'operation-abort' } : {});
        conflict.resolve();
        expect((await attempt).success).toBe(false);
        expect(PageTranslationSettingsLoader.load).not.toHaveBeenCalled();
        expect(pageEventBus.emit.mock.calls.some(([event]) => event === MessageActions.PAGE_TRANSLATE_START)).toBe(false);
        expect(manager.userRestoredOverride).toBe(action !== 'internal stop');
        expect(manager.pendingSettingsAttempt).toBeNull();
        expect(controller.signal.aborted).toBe(true);
      }
    );

    it('leaves a fresh accepted session intact when a cancelled first feature conflict wait resolves', async () => {
      const conflict = createDeferred();
      manager.featureManager = {
        resolveFeatureConflict: vi.fn().mockImplementationOnce(() => conflict.promise).mockResolvedValue(undefined),
      };
      const obsolete = manager.translatePage({ isAuto: true });
      await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
      const fresh = await manager.translatePage({ isAuto: true });
      expect(fresh.success).toBe(true);
      const freshController = manager.abortController;
      const freshContext = manager.sessionContext;
      conflict.resolve();
      expect((await obsolete).success).toBe(false);
      expect(manager.abortController).toBe(freshController);
      expect(manager.sessionContext).toBe(freshContext);
      expect(manager.translationMessageId).toBe(fresh.messageId);
      expect(manager.isTranslating).toBe(true);
      expect(PageTranslationSettingsLoader.load).toHaveBeenCalledOnce();
      expect(pageEventBus.emit.mock.calls.filter(([event]) => event === MessageActions.PAGE_TRANSLATE_START)).toHaveLength(1);
    });

    it('releases preparation ownership when the first feature conflict wait rejects', async () => {
      const error = new Error('Feature conflict failed');
      manager.featureManager = { resolveFeatureConflict: vi.fn().mockRejectedValue(error) };
      await expect(manager.translatePage({ isAuto: true })).rejects.toThrow(error);
      expect(manager.pendingSettingsAttempt).toBeNull();
      expect(manager.abortController).toBeNull();
      expect(manager.isTranslating).toBe(false);
      expect(PageTranslationSettingsLoader.load).not.toHaveBeenCalled();
      expect(pageEventBus.emit.mock.calls.some(([event]) => event === MessageActions.PAGE_TRANSLATE_START)).toBe(false);
    });

    it('shares the FeatureManager-owned page handler with the real lazy loader', async () => {
      const { FeatureManager } = await vi.importActual('@/core/managers/content/FeatureManager.js');
      const lazyFeatures = await vi.importActual('@/core/content-scripts/chunks/lazy-features.js');
      const owner = FeatureManager.getInstance();
      owner.initialized = true;
      owner.exclusionChecker.isFeatureAllowed = vi.fn().mockResolvedValue(true);
      const handler = await owner.loadFeatureHandler('pageTranslation');
      owner.featureHandlers.set('pageTranslation', handler);
      owner.activeFeatures.add('pageTranslation');
      try {
        expect(handler.featureManager).toBe(owner);
        expect(await lazyFeatures.loadFeature('pageTranslation')).toBe(handler);
        expect(owner.getFeatureHandler('pageTranslation')).toBe(handler);
      } finally {
        owner.featureHandlers.delete('pageTranslation');
        owner.activeFeatures.delete('pageTranslation');
        lazyFeatures.notifyFeatureDeactivated('pageTranslation');
        await handler.cleanup();
      }
    });

    it.each(['delayed notification', 'same-URL history update', 'history round trip', 'reordered history round trip', 'repeated history round trip', 'admission history round trip', 'next SPA route'])(
      'continues route B after %s without resending accepted nodes', async (navigation) => {
      const previousLocation = window.location;
      vi.unstubAllGlobals();
      const { FeatureManager } = await vi.importActual('@/core/managers/content/FeatureManager.js');
      const { PageTranslationBridge: RealBridge } = await vi.importActual('./PageTranslationBridge.js');
      const { PageTranslationEventManager: RealEvents } = await vi.importActual('./utils/PageTranslationEventManager.js');
      const { default: browser } = await import('webextension-polyfill');
      const owner = FeatureManager.getInstance();
      const oldUrl = window.location.href;
      const settings = {
        translationApi: 'custom', targetLanguage: 'fa', lazyLoading: false,
        showOriginalOnHover: false, autoTranslateOnDOMChanges: true,
        tokenWarningHidden: true,
      };
      PageTranslationSettingsLoader.load.mockResolvedValue(settings);
      manager.featureManager = owner;
      manager.bridge = new RealBridge();
      manager.eventManager = new RealEvents(manager);
      owner.featureHandlers.set('pageTranslation', manager);
      owner.activeFeatures.add('pageTranslation');
      owner._lastDetectedUrl = oldUrl;
      owner.navigationCursor = null;
      owner.reevaluateFeatures = vi.fn().mockResolvedValue(undefined);
      owner.exclusionChecker.isFeatureAllowed = vi.fn().mockResolvedValue(true);
      mockSpaSettingsManager.isExtensionEnabled.mockReturnValue(true);
      mockSpaSettingsManager.get.mockImplementation((key, fallback) => {
        if (key === 'WHOLE_PAGE_AUTO_TRANSLATE_RULES') return [`${window.location.hostname}/*`];
        return fallback;
      });
      mockSpaLoadFeature.mockResolvedValue(manager);
      manager.scheduler.totalTasks = 0;
      manager.scheduler.reset.mockImplementation(() => {
        manager.scheduler.totalTasks = 0;
        manager.scheduler.translatedCount = 0;
      });
      const pending = [];
      manager.scheduler.enqueue.mockImplementation((text, context, _score, node) => new Promise(resolve => {
        manager.scheduler.totalTasks++;
        pending.push({ text, context, node, resolve });
      }));
      const starts = vi.fn();
      let producerCursor = { documentEpoch: 1, routeRevision: 0, url: oldUrl };
      sendRegularMessage.mockImplementation(async (message) => {
        if (message.action === MessageActions.PAGE_TRANSLATE) {
          starts();
          return manager.translatePage({ ...message.data, navigationCursor: producerCursor });
        }
        return { success: true };
      });
      browser.runtime.id = 'test-extension';
      try {
        await manager.activate();
        document.body.innerHTML = '<p id="accepted">Accepted route B source</p><p id="pending">Pending route B source</p>';
        window.history.replaceState({}, '', new URL('/route-b', oldUrl).href);
        producerCursor = { ...producerCursor, url: window.location.href };
        await owner.checkForUrlChange();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(manager.isAutoTranslating).toBe(true);
        const result = (text) => ({
          __pageTranslationSettlement: true, text, state: 'pending',
          settle(outcome) { this.state = outcome; },
        });
        pending[0].resolve(result('Accepted route B translation'));
        await vi.waitFor(() => expect(document.getElementById('accepted').textContent).toContain('Accepted route B translation'));
        if (navigation === 'same-URL history update') window.history.replaceState({}, '', window.location.href);
        if (navigation === 'next SPA route') window.history.replaceState({}, '', '/route-c');
        if (navigation.endsWith('history round trip')) {
          const route = window.location.href;
          window.history.pushState({}, '', '/intermediate-route');
          window.history.replaceState({}, '', route);
        }

        const roundTrip = navigation.endsWith('history round trip');
        const reordered = navigation === 'reordered history round trip';
        const repeated = navigation === 'repeated history round trip';
        const admissionOnly = navigation === 'admission history round trip';
        const restarts = roundTrip || navigation === 'next SPA route';
        const controller = manager.abortController;
        const navigationUrl = roundTrip
          ? new URL('/intermediate-route', oldUrl).href : window.location.href;
        const capturedCursor = { documentEpoch: 1, routeRevision: restarts ? 1 : 0, url: navigationUrl };
        producerCursor = { ...capturedCursor, routeRevision: roundTrip ? 2 : capturedCursor.routeRevision, url: window.location.href };
        if (reordered) {
          manager.eventManager.navigationListener({
            action: MessageActions.SPA_NAVIGATION, data: { navigationCursor: producerCursor },
          }, { id: browser.runtime.id });
          expect(controller.signal.aborted).toBe(true);
        }
        const event = { action: MessageActions.SPA_NAVIGATION, data: { navigationCursor: capturedCursor } };
        if (admissionOnly) {
          await sendRegularMessage({ action: MessageActions.PAGE_TRANSLATE, data: { isAuto: true, preserveAcceptedTranslations: true } });
          const admittedController = manager.abortController;
          const admittedSession = manager.translationMessageId;
          expect((await manager.translatePage({
            isAuto: true, navigationCursor: { documentEpoch: 1, routeRevision: 0, url: window.location.href },
          })).success).toBe(false);
          expect(manager.abortController).toBe(admittedController);
          expect(manager.translationMessageId).toBe(admittedSession);
          expect(admittedController.signal.aborted).toBe(false);
        } else manager.eventManager.navigationListener(event, { id: browser.runtime.id });
        expect(controller.signal.aborted).toBe(restarts);
        await vi.waitFor(() => expect(manager.isAutoTranslating).toBe(true));
        await vi.waitFor(() => expect(pending).toHaveLength(restarts ? 3 : 2));
        expect(controller.signal.aborted).toBe(restarts);
        expect(starts).toHaveBeenCalledTimes(restarts ? 2 : 1);
        expect(manager.scheduler.recordRetainedTranslation).toHaveBeenCalledTimes(restarts ? 1 : 0);
        expect(pending.filter(item => item.text === 'Accepted route B source')).toHaveLength(1);
        expect(pending.some(item => item.text.includes('Accepted route B translation'))).toBe(false);
        if (reordered) {
          const freshController = manager.abortController;
          await Promise.resolve();
          await owner.checkForUrlChange({ navigationCursor: capturedCursor });
          manager.eventManager.navigationListener(event, { id: browser.runtime.id });
          expect(freshController.signal.aborted).toBe(false);
          expect(starts).toHaveBeenCalledTimes(2);
          expect(pending).toHaveLength(3);
        }
        if (repeated) {
          const heldRequest = pending.at(-1);
          const heldController = manager.abortController;
          const route = window.location.href;
          window.history.pushState({}, '', navigationUrl);
          window.history.replaceState({}, '', route);
          producerCursor = { documentEpoch: 1, routeRevision: 4, url: route };
          manager.eventManager.navigationListener({
            action: MessageActions.SPA_NAVIGATION, data: { navigationCursor: { ...producerCursor, routeRevision: 3, url: navigationUrl } },
          }, { id: browser.runtime.id });
          manager.eventManager.navigationListener({
            action: MessageActions.SPA_NAVIGATION, data: { navigationCursor: producerCursor },
          }, { id: browser.runtime.id });
          manager.eventManager.navigationListener({
            action: MessageActions.SPA_NAVIGATION, data: { navigationCursor: { ...producerCursor, routeRevision: 2 } },
          }, { id: browser.runtime.id });
          expect(heldController.signal.aborted).toBe(true);
          await vi.waitFor(() => expect(pending).toHaveLength(4));
          expect(starts).toHaveBeenCalledTimes(3);
          expect(manager.scheduler.recordRetainedTranslation).toHaveBeenCalledTimes(2);
          expect(pending.some(item => item.text.includes('Accepted route B translation'))).toBe(false);
          const obsolete = result('Obsolete second round-trip translation');
          heldRequest.resolve(obsolete);
          await vi.waitFor(() => expect(obsolete.state).toBe('cancelled'));
          expect(document.body.textContent).not.toContain('Obsolete');
        }
        const fresh = result('Fresh route B translation');
        const currentRequest = pending.at(-1);
        currentRequest.resolve(fresh);
        await vi.waitFor(() => expect(fresh.state).toBe('accepted'));
        if (restarts) {
          const old = result('Obsolete route B translation');
          pending[1].resolve(old);
          await vi.waitFor(() => expect(old.state).toBe('cancelled'));
        }
        expect(document.body.textContent).not.toContain('Obsolete');

        const later = document.createElement('p');
        later.textContent = 'Delayed route B source';
        const requestCount = pending.length;
        document.body.appendChild(later);
        await vi.waitFor(() => expect(pending).toHaveLength(requestCount + 1));
        pending.at(-1).resolve(result('Delayed route B translation'));
        await vi.waitFor(() => expect(later.textContent).toContain('Delayed route B translation'));
        await manager.restorePage({ manual: true });
        expect(document.getElementById('accepted').textContent).toBe('Accepted route B source');
        expect(document.getElementById('pending').textContent).toBe('Pending route B source');
        expect(later.textContent).toBe('Delayed route B source');
      } finally {
        window.history.replaceState({}, '', oldUrl);
        vi.stubGlobal('location', previousLocation);
        owner.featureHandlers.delete('pageTranslation');
        owner.activeFeatures.delete('pageTranslation');
        PageTranslationSettingsLoader.load.mockResolvedValue({
          targetLanguage: 'fa', translationApi: 'google', showOriginalOnHover: true,
          autoTranslateOnDOMChanges: false,
        });
        sendRegularMessage.mockResolvedValue({ success: true });
      }
      }
    );

    it.each([null, {}, { documentEpoch: 0, routeRevision: 0, url: 'x' }, {
      documentEpoch: 1, routeRevision: 0, url: 'https://different-document.example/',
    }])('rejects malformed or non-live Page command cursor %o before destructive preparation', async navigationCursor => {
      manager.currentUrl = 'https://previous.example/';
      await expect(manager.translatePage({ navigationCursor })).resolves.toEqual({ success: false, reason: ActionReasons.SILENT_ERROR });
      expect(manager.currentUrl).toBe('https://previous.example/');
      expect(manager.bridge.cleanup).not.toHaveBeenCalled();
      expect(PageTranslationSettingsLoader.load).not.toHaveBeenCalled();
    });

    it('rejects a Page command when producer persistence is unavailable', async () => {
      expect((await manager.translatePage({ navigationUnavailable: true })).success).toBe(false);
      expect(PageTranslationSettingsLoader.load).not.toHaveBeenCalled();
      expect(manager.bridge.initialize).not.toHaveBeenCalled();
    });

    it('stops older active work without auto-restart when Page admission persistence becomes unavailable', async () => {
      await manager.translatePage();
      const controller = manager.abortController;
      expect((await manager.translatePage({ navigationUnavailable: true })).success).toBe(false);
      expect(controller.signal.aborted).toBe(true);
      expect(manager.isTranslating).toBe(false);
      expect(manager.isAutoTranslating).toBe(false);
      expect(manager.userRestoredOverride).toBe(false);
      expect(PageTranslationSettingsLoader.load).toHaveBeenCalledOnce();
    });

    it('publishes aggregate lifecycle through trusted runtime transport', async () => {
      const data = { translatedCount: 2, totalCount: 3, frameUrl: 'fake' };

      await manager._broadcastEvent(MessageActions.PAGE_TRANSLATE_PROGRESS, data);

      expect(sendRegularMessage).toHaveBeenCalledWith({
        action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
        data: {
          action: MessageActions.PAGE_TRANSLATE_PROGRESS,
          data,
        },
        context: 'page-translation-frame-lifecycle',
      }, { silent: true });
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_PROGRESS, data);
    });

    it('publishes non-fatal scheduler errors through trusted lifecycle transport', () => {
      const error = Object.assign(new Error('provider failure'), { type: ErrorTypes.MODEL_MISSING });

      manager.scheduler.onInternalError({
        error,
        errorType: ErrorTypes.MODEL_MISSING,
        isFatal: false,
      });

      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
        data: expect.objectContaining({
          action: MessageActions.PAGE_TRANSLATE_ERROR,
          data: expect.objectContaining({ isFatal: false }),
        }),
      }), { silent: true });
    });

    it('should start translation successfully', async () => {
      await manager.activate();
      const result = await manager.translatePage();

      expect(result.success).toBe(true);
      expect(manager.isTranslating).toBe(true);
      expect(manager.bridge.initialize).toHaveBeenCalled();
      expect(manager.bridge.translate).toHaveBeenCalledWith(document.body);
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.any(Object));
      const startData = pageEventBus.emit.mock.calls.find(([action]) => action === MessageActions.PAGE_TRANSLATE_START)[1];
      expect(startData).toMatchObject({
        messageId: result.messageId,
        sessionId: result.messageId,
      });
      
      // Check for layout fix injection
      expect(document.getElementById('ti-translation-layout-fix')).not.toBeNull();
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(true);
    });

    it.each([
      { isAuto: true, preserveAcceptedTranslations: true },
      { isAuto: false, preserveAcceptedTranslations: true },
      { isAuto: true, preserveAcceptedTranslations: false },
    ])('keeps only the stopped Bridge restore owner for %j', async (options) => {
      await manager.activate();
      manager.currentUrl = 'https://old.example/';
      const previousController = new AbortController();
      manager.abortController = previousController;
      const snapshot = {
        nodeStorage: new WeakMap(), document,
        translationApi: 'google', targetLanguage: 'fa', settingsRevision: 0,
      };
      manager.bridge.session = {
        ...snapshot, nodesTranslator: { nodeStorage: snapshot.nodeStorage },
        root: document.documentElement, controller: previousController, context: Symbol('old'),
      };
      manager.bridge.cleanup.mockImplementation(() => { manager.bridge.session = null; });

      await manager.translatePage(options);

      const bridgeOptions = manager.bridge.initialize.mock.calls[0][3];
      expect(previousController.signal.aborted).toBe(true);
      const preserve = options.isAuto && options.preserveAcceptedTranslations;
      expect(bridgeOptions.preserveAcceptedTranslations).toBe(preserve);
      expect(manager.bridge.stopPersistence).toHaveBeenCalledTimes(preserve ? 1 : 0);
      expect(manager.bridge.cleanup).toHaveBeenCalledTimes(preserve ? 0 : 1);
      expect(manager.bridge.session?.nodesTranslator.nodeStorage).toBe(preserve ? snapshot.nodeStorage : undefined);
      expect(manager.abortController).not.toBe(previousController);
      expect(manager.sessionContext).not.toBe(manager.bridge.session?.context);
    });

    it('handles matching scheduler fatal callback once', () => {
      const sessionContext = Symbol('session-context');
      manager.isTranslating = true;
      manager.translationMessageId = 'session-b';
      manager.sessionContext = sessionContext;
      manager.scheduler.translationSessionId = 'session-b';
      const handleFatalError = vi.spyOn(manager, '_handleFatalError').mockImplementation(() => {});

      expect(manager.scheduler.onFatalError({
        error: new Error('fatal'),
        errorType: ErrorTypes.SERVER_ERROR,
        sessionId: 'session-b',
        sessionContext,
        context: 'page-translation-batch',
      })).toBe(true);

      expect(handleFatalError).toHaveBeenCalledOnce();
      expect(handleFatalError).toHaveBeenCalledWith(expect.any(Error), ErrorTypes.SERVER_ERROR, undefined, 'session-b');
    });

    it('ignores stale scheduler fatal callback from an older session', () => {
      const currentContext = Symbol('current-context');
      manager.isTranslating = true;
      manager.translationMessageId = 'session-b';
      manager.sessionContext = currentContext;
      manager.scheduler.translationSessionId = 'session-b';
      const handleFatalError = vi.spyOn(manager, '_handleFatalError').mockImplementation(() => {});

      expect(manager.scheduler.onFatalError({
        error: new Error('stale fatal'),
        errorType: ErrorTypes.SERVER_ERROR,
        sessionId: 'session-a',
        sessionContext: Symbol('stale-context'),
        context: 'page-translation-scheduler',
      })).toBe(false);

      expect(handleFatalError).not.toHaveBeenCalled();
      expect(manager.isTranslating).toBe(true);
      expect(manager.translationMessageId).toBe('session-b');
    });

    it('requires matching session context and accepted scheduler identity', () => {
      const currentContext = Symbol('current-context');
      manager.isTranslating = true;
      manager.translationMessageId = 'session-b';
      manager.sessionContext = currentContext;
      const handleFatalError = vi.spyOn(manager, '_handleFatalError').mockImplementation(() => {});

      expect(manager.scheduler.onFatalError({
        error: new Error('wrong context'),
        errorType: ErrorTypes.SERVER_ERROR,
        sessionId: 'session-b',
        sessionContext: Symbol('wrong-context'),
      })).toBe(false);

      expect(manager.scheduler.onFatalError({
        error: new Error('pre-start'),
        errorType: ErrorTypes.SERVER_ERROR,
        sessionId: 'session-b',
        sessionContext: currentContext,
      })).toBe(false);

      expect(handleFatalError).not.toHaveBeenCalled();
    });

    it('resolves Select Element conflict before Whole Page admission', async () => {
      const resolveFeatureConflict = vi.fn().mockResolvedValue(undefined);
      manager = new PageTranslationManager({ featureManager: { resolveFeatureConflict } });
      await manager.activate();

      await manager.translatePage();

      expect(resolveFeatureConflict).toHaveBeenCalledWith('pageTranslation');
      expect(resolveFeatureConflict.mock.invocationCallOrder[0]).toBeLessThan(
        pageEventBus.emit.mock.invocationCallOrder.find((callOrder, index) => (
          pageEventBus.emit.mock.calls[index][0] === MessageActions.PAGE_TRANSLATE_START
            ? callOrder
            : false
        ))
      );
    });

    it('propagates trusted conflict failures through translatePage error handling', async () => {
      const error = Object.assign(new Error('Select Element teardown failed'), { type: ErrorTypes.API_ERROR });
      manager = new PageTranslationManager({
        featureManager: { resolveFeatureConflict: vi.fn().mockRejectedValue(error) },
      });
      await manager.activate();

      await expect(manager.translatePage()).rejects.toBe(error);
    });

    it('should not translate if already translating', async () => {
      manager.currentUrl = window.location.href; // Prevent reset due to URL mismatch
      manager.isTranslating = true;
      const result = await manager.translatePage();
      expect(result.success).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should not translate if page is not suitable', async () => {
      manager.currentUrl = window.location.href;
      PageTranslationHelper.isSuitableForTranslation.mockReturnValue(false);
      const result = await manager.translatePage();
      expect(result.success).toBe(false);
    });

    it('should restore page correctly', async () => {
      await manager.activate();
      const { messageId } = await manager.translatePage();
      manager.scheduler.setTranslationState.mockClear();
      
      const result = await manager.restorePage({ manual: true });
      
      expect(result.success).toBe(true);
      expect(manager.isTranslated).toBe(false);
      expect(manager.bridge.restore).toHaveBeenCalled();
      expect(PageTranslationHelper.deepCleanDOM).toHaveBeenCalled();
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        ActionReasons.USER_STOPPED_PAGE_TRANSLATION
      );
      
      // Check layout fix removal
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(false);
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId: messageId })
      );
      expect(manager.acceptedLifecycleSessionId).toBeNull();
    });

    it('should stop auto-translation without full restore', async () => {
      manager.isAutoTranslating = true;
      manager.isTranslating = true;
      manager.translationMessageId = 'stop-session';
      manager.acceptedLifecycleSessionId = 'stop-session';
      manager.abortController = new AbortController();
      const controller = manager.abortController;
      manager.sessionContext = Symbol('stop-context');
      manager.scheduler.translatedCount = 2;
      
      const result = await manager.stopAutoTranslation();
      
      expect(result.success).toBe(true);
      expect(manager.isAutoTranslating).toBe(false);
      expect(manager.userRestoredOverride).toBe(true);
      expect(manager.bridge.stopPersistence).toHaveBeenCalled();
      expect(manager.bridge.restore).not.toHaveBeenCalled();
      expect(manager.bridge.cleanup).not.toHaveBeenCalled();
      expect(manager.isTranslated).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(manager.abortController).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        ActionReasons.USER_STOPPED_PAGE_TRANSLATION
      );
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
        data: expect.objectContaining({
          action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
          data: expect.objectContaining({
            isAutoTranslating: false,
            sessionId: 'stop-session',
          }),
        }),
      }), { silent: true });
      expect(manager.acceptedLifecycleSessionId).toBe('stop-session');

      await manager.restorePage();
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId: 'stop-session' })
      );
    });

    it.each(['accepted-stop-session', 'pending-start-session'])(
      'cleans the accepted language-resolution session on stop while current ID is %s', async currentId => {
        manager.isAutoTranslating = true;
        manager.isTranslating = true;
        manager.translationMessageId = currentId;
        manager.acceptedLifecycleSessionId = 'accepted-stop-session';
        manager.abortController = new AbortController();

        await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });

        expect(sendRegularMessage).toHaveBeenCalledWith({
          action: MessageActions.CANCEL_SESSION, data: { sessionId: 'accepted-stop-session' },
        });
        expect(manager.translationMessageId).toBe(currentId === 'accepted-stop-session' ? null : currentId);
        expect(manager.acceptedLifecycleSessionId).toBe('accepted-stop-session');
        expect(manager.bridge.restore).not.toHaveBeenCalled();
      }
    );

    it.each(['TARGET_LANGUAGE', 'CUSTOM_API_MODEL'])(
      'invalidates a non-auto lazy idle session on %s change, preserving completed nodes', async (key) => {
        const { PageTranslationBridge: RealBridge } = await vi.importActual('./PageTranslationBridge.js');
        const { PageTranslationEventManager: RealEvents } = await vi.importActual('./utils/PageTranslationEventManager.js');
        const previousIntersectionObserver = globalThis.IntersectionObserver;
        let observer;
        globalThis.IntersectionObserver = class {
          constructor(callback) {
            this.callback = callback;
            this.observe = vi.fn();
            this.unobserve = vi.fn();
            this.disconnect = vi.fn();
            observer = this;
          }
        };
        try {
          manager.bridge = new RealBridge();
          manager.settings = {
            translationApi: 'custom', targetLanguage: 'ja', lazyLoading: true,
            showOriginalOnHover: false, autoTranslateOnDOMChanges: false,
          };
          manager.eventManager = new RealEvents(manager);
          document.body.innerHTML = '<p id="completed">Completed source</p><p id="pending">Pending source</p><p id="lazy">Lazy source</p>';
          const pending = [];
          await manager.bridge.initialize(manager.settings, (text) => new Promise(resolve => pending.push({ text, resolve })));
          manager.bridge.translate(document.body);
          const completedElement = document.getElementById('completed');
          const pendingElement = document.getElementById('pending');
          observer.callback([
            { target: completedElement, isIntersecting: true },
            { target: pendingElement, isIntersecting: true },
          ], observer);
          await vi.waitFor(() => expect(pending).toHaveLength(2));
          const createSettlement = (text) => ({
            __pageTranslationSettlement: true, text, state: 'pending',
            settle(outcome) { this.state = outcome; },
          });
          pending.find(item => item.text === 'Completed source').resolve(createSettlement('Completed translation'));
          await vi.waitFor(() => expect(completedElement.textContent).toContain('Completed translation'));

          manager.scheduler.isTranslated = true;
          manager.scheduler.translatedCount = 1;
          manager.isTranslating = false;
          manager.isAutoTranslating = false;
          const callback = mockStorageManagerOn.mock.calls.find(call => call[0] === 'change')[1];
          callback({ key, oldValue: 'old-test-value', newValue: 'new-test-value' });

          expect(manager.bridge.session.active).toBe(false);
          expect(observer.disconnect).toHaveBeenCalledOnce();
          expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(false, undefined, undefined, 'operation-abort');
          pending.find(item => item.text === 'Pending source').resolve(createSettlement('Obsolete translation'));
          await Promise.resolve();
          await Promise.resolve();
          expect(pendingElement.textContent).toBe('Pending source');
          expect(completedElement.textContent).toContain('Completed translation');
          expect(document.getElementById('lazy').textContent).toBe('Lazy source');
          manager.bridge.translate(document.body);
          expect(pending).toHaveLength(2);
          expect(manager.isTranslated).toBe(true);
        } finally {
          if (previousIntersectionObserver) globalThis.IntersectionObserver = previousIntersectionObserver;
          else delete globalThis.IntersectionObserver;
        }
      }
    );

    it.each(['scheduler', 'bridge'])('stops idle translation owned only by %s', async (owner) => {
      manager.isTranslating = false;
      manager.isAutoTranslating = false;
      manager.scheduler.isTranslated = owner === 'scheduler';
      manager.bridge.session = { active: owner === 'bridge' };

      expect((await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' })).success).toBe(true);
      expect(manager.bridge.stopPersistence).toHaveBeenCalledOnce();
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(false, undefined, undefined, 'operation-abort');
    });

    it('updates completion state through trusted scheduler callback', () => {
      manager.isTranslating = true;
      manager.isTranslated = false;

      manager.scheduler.onLifecycleEvent(MessageActions.PAGE_TRANSLATE_COMPLETE, {
        sessionId: 'scheduler-session',
        translatedCount: 2,
        totalCount: 2,
        failedCount: 0,
      });

      expect(manager.isTranslating).toBe(false);
      expect(manager.isTranslated).toBe(true);
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: MessageActions.PAGE_TRANSLATE_COMPLETE,
          data: expect.objectContaining({ sessionId: 'scheduler-session' }),
        }),
      }), { silent: true });
    });

    it('preserves auto mode while trusted scheduler idle clears active translation', () => {
      manager.isTranslating = true;
      manager.isTranslated = false;
      manager.isAutoTranslating = true;

      manager.scheduler.onLifecycleEvent(MessageActions.PAGE_TRANSLATE_IDLE, {
        sessionId: 'scheduler-session',
        translatedCount: 2,
        totalCount: 2,
        failedCount: 0,
        isAutoTranslating: true,
      });

      expect(manager.isTranslating).toBe(false);
      expect(manager.isTranslated).toBe(true);
      expect(manager.isAutoTranslating).toBe(true);
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: MessageActions.PAGE_TRANSLATE_IDLE,
          data: expect.objectContaining({ sessionId: 'scheduler-session' }),
        }),
      }), { silent: true });
    });

    it('should link bridge callback to scheduler enqueue', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      await manager.translatePage();
      
      // Get the callback passed to bridge.initialize
      const initCall = manager.bridge.initialize.mock.calls[0];
      const callback = initCall[1];
      
      const mockNode = document.createElement('div');
      await callback('Hello', { id: 'ctx' }, 1, mockNode);
      
      expect(manager.scheduler.enqueue).toHaveBeenCalledWith('Hello', { id: 'ctx' }, 1, mockNode);
    });

    it('settles silently when bridge initialization fails after START', async () => {
      const error = Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT });
      manager.bridge.initialize.mockRejectedValueOnce(error);

      await manager.activate();
      const result = await manager.translatePage();

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.isTranslating).toBe(false);
      expect(manager.isAutoTranslating).toBe(false);
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        'operation-abort'
      );
      expect(manager.scrollTracker.stop).toHaveBeenCalled();
      expect(manager.bridge.stopPersistence).toHaveBeenCalled();
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.objectContaining({
        translatedCount: 0,
        failedCount: 0,
        totalCount: 0,
        isTranslated: false,
        isTranslating: false,
        isAutoTranslating: false
      }));
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.anything());
      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
    });

    it('does not emit IDLE for silent failure before START', async () => {
      await manager.activate();
      PageTranslationSettingsLoader.load.mockRejectedValueOnce(
        Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT })
      );
      const result = await manager.translatePage();

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.isTranslating).toBe(false);
      expect(manager.abortController).toBeNull();
      expect(manager.translationMessageId).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(false);
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(sendRegularMessage.mock.calls.some(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toBe(false);
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('cleans provisional resources on non-silent settings failure', async () => {
      const error = Object.assign(new Error('settings failure'), { type: ErrorTypes.API_ERROR });
      await manager.activate();
      PageTranslationSettingsLoader.load.mockRejectedValueOnce(error);

      await expect(manager.translatePage()).rejects.toBe(error);

      expect(manager.abortController).toBeNull();
      expect(manager.translationMessageId).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(false);
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(sendRegularMessage.mock.calls.some(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toBe(false);
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.objectContaining({
        error: error.message,
      }));
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('does not leak a prior START into a later pre-START silent failure', async () => {
      await manager.activate();
      await manager.translatePage();
      manager.isTranslating = false;
      manager.isTranslated = true;

      PageTranslationSettingsLoader.load.mockRejectedValueOnce(
        Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT })
      );
      const emittedBeforeSecondAttempt = pageEventBus.emit.mock.calls.length;

      const result = await manager.translatePage({ isAuto: true });
      const secondAttemptEvents = pageEventBus.emit.mock.calls.slice(emittedBeforeSecondAttempt);

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(secondAttemptEvents).not.toContainEqual([MessageActions.PAGE_TRANSLATE_START, expect.anything()]);
      expect(secondAttemptEvents).not.toContainEqual([MessageActions.PAGE_TRANSLATE_IDLE, expect.anything()]);
      expect(manager.isTranslating).toBe(false);
    });

    it('settles silently when bridge translation fails after initialization', async () => {
      const error = Object.assign(new Error('context lost'), { type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED });
      manager.bridge.translate.mockImplementationOnce(() => { throw error; });

      await manager.activate();
      const result = await manager.translatePage();

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.isTranslating).toBe(false);
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        'operation-abort'
      );
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.objectContaining({
        translatedCount: 0,
        isTranslated: false
      }));
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.anything());
    });

    it('preserves partial counts and DOM state during silent settlement', async () => {
      manager.scheduler.translatedCount = 2;
      manager.scheduler.failedCount = 1;
      manager.scheduler.totalTasks = 3;
      manager.bridge.translate.mockImplementationOnce(() => {
        throw Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT });
      });

      await manager.activate();
      const result = await manager.translatePage();

      expect(result.reason).toBe('silent_error');
      expect(manager.isTranslated).toBe(true);
      expect(manager.bridge.restore).not.toHaveBeenCalled();
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.objectContaining({
        translatedCount: 2,
        failedCount: 1,
        totalCount: 3,
        isTranslated: true,
        isTranslating: false,
        isAutoTranslating: false
      }));

      const sessionId = manager.acceptedLifecycleSessionId;
      await manager.restorePage();
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId })
      );
      expect(manager.acceptedLifecycleSessionId).toBeNull();
    });

    it('settles non-lazy zero-work translation without error presentation', async () => {
      manager.scheduler.totalTasks = 0;

      await manager.activate();
      const result = await manager.translatePage();

      expect(result.success).toBe(true);
      expect(manager.isTranslating).toBe(false);
      expect(manager.isTranslated).toBe(false);
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.objectContaining({
        translatedCount: 0,
        failedCount: 0,
        totalCount: 0,
        isTranslated: false
      }));
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.anything());
      expect(manager.acceptedLifecycleSessionId).toBe(result.messageId);

      await manager.restorePage();
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId: result.messageId })
      );
      expect(manager.acceptedLifecycleSessionId).toBeNull();
    });

    it('keeps non-silent setup failures on the existing error path', async () => {
      const error = Object.assign(new Error('provider failure'), { type: ErrorTypes.API_ERROR });
      manager.bridge.initialize.mockRejectedValueOnce(error);

      await manager.activate();
      await expect(manager.translatePage()).rejects.toBe(error);

      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.objectContaining({
        error: error.message
      }));
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('keeps explicit cancellation on restore lifecycle', async () => {
      await manager.activate();
      const { messageId } = await manager.translatePage();

      manager.cancelTranslation();

      expect(manager.bridge.restore).toHaveBeenCalled();
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        ActionReasons.USER_STOPPED_PAGE_TRANSLATION
      );
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_TRANSLATE_CANCELLED,
        expect.objectContaining({ sessionId: messageId })
      );
      await vi.waitFor(() => expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId: messageId })
      ));
    });

    it('sends CANCEL_SESSION for admitted session restore', async () => {
      const sessionId = 'admitted-session';
      manager.translationMessageId = sessionId;
      manager.scheduler.translationSessionId = sessionId;
      sendRegularMessage.mockClear();

      await manager.restorePage();

      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toEqual([
        [expect.objectContaining({
          action: MessageActions.CANCEL_SESSION,
          data: { sessionId },
        })]
      ]);
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        'operation-abort'
      );
    });

    it('replaces a silently settled lifecycle identity without clearing the replacement during stale restore completion', async () => {
      manager.scheduler.totalTasks = 0;
      await manager.activate();
      const first = await manager.translatePage();
      const restoring = manager.restorePage();
      const second = await manager.translatePage();

      await restoring;

      expect(manager.acceptedLifecycleSessionId).toBe(second.messageId);
      expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.objectContaining({ sessionId: first.messageId })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle fatal errors by stopping translation and presenting safely', async () => {
      const error = new Error('Fatal failure');
      Object.assign(error, {
        type: ErrorTypes.API_ERROR,
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        cause: 'private',
        arbitrary: { ignored: true }
      });
      manager.isTranslating = true;
      manager.isAutoTranslating = true;
      manager._handleFatalError(error, ErrorTypes.API_ERROR);
      
      expect(manager.isTranslating).toBe(false);
      expect(manager.isAutoTranslating).toBe(false);
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(
        false,
        undefined,
        undefined,
        'operation-abort'
      );
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_PROGRESS, expect.objectContaining({ status: 'idle' }));
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.objectContaining({
        error: 'Fatal failure',
         errorType: ErrorTypes.API_ERROR,
        isFatal: true,
        errorDetails: expect.objectContaining({
          message: 'Fatal failure',
           type: ErrorTypes.API_ERROR,
          originalType: 'HTTP_ERROR',
          statusCode: 503,
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM'
        })
      }));
      const errorEvent = pageEventBus.emit.mock.calls.find(([action]) => action === MessageActions.PAGE_TRANSLATE_ERROR)[1];
      expect(errorEvent.errorDetails).not.toHaveProperty('cause');
      expect(errorEvent.errorDetails).not.toHaveProperty('arbitrary');

      await vi.waitFor(
        () => expect(ErrorHandler.getInstance().handle).toHaveBeenCalledTimes(1),
        { timeout: 5000 }
      );
      const handledError = ErrorHandler.getInstance().handle.mock.calls[0][0];
      expect(handledError.message).not.toContain('Fatal failure');
      expect(handledError.message).not.toContain('private');
      expect(ErrorHandler.getInstance().handle.mock.calls[0][1]).toMatchObject({
        type: ErrorTypes.API_ERROR,
        context: 'page-translation-fatal',
        showToast: true,
      });
    });

    it('preserves translated state and publishes committed count after fatal partial termination', async () => {
      manager.scheduler.translatedCount = 1;
      manager.isTranslating = true;
      const error = Object.assign(new Error('Fatal failure'), {
        type: ErrorTypes.NETWORK_ERROR,
      });

      manager._handleFatalError(error, ErrorTypes.NETWORK_ERROR);

      expect(manager.isTranslated).toBe(true);
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.objectContaining({
        translatedCount: 1,
        isFatal: true,
      }));
    });

    it('does not present cancellation or context fatal errors', async () => {
      manager._handleFatalError(Object.assign(new Error('cancelled'), {
        type: ErrorTypes.USER_CANCELLED,
      }), ErrorTypes.USER_CANCELLED);
      manager._handleFatalError(Object.assign(new Error('context lost'), {
        type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
      }), ErrorTypes.EXTENSION_CONTEXT_INVALIDATED);

      await Promise.resolve();
      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
    });

    it('preserves local restore failure behavior outside translation presentation', async () => {
      const error = new Error('local restore failure');
      manager.translationMessageId = 'restore-session';
      manager.acceptedLifecycleSessionId = 'restore-session';
      manager.scheduler.translationSessionId = 'restore-session';
      manager.bridge.restore.mockImplementationOnce(() => { throw error; });

      await expect(manager.restorePage()).rejects.toBe(error);
      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
      expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_RESTORE_ERROR, expect.objectContaining({
        error: error.message,
        errorDetails: expect.objectContaining({ message: error.message }),
        sessionId: 'restore-session',
      }));
      expect(manager.acceptedLifecycleSessionId).toBe('restore-session');

      await manager.restorePage();
      expect(manager.acceptedLifecycleSessionId).toBeNull();
    });
  });

  describe('Session Context', () => {
    it('should create a unique session context for each translation', async () => {
      manager.currentUrl = window.location.href;
      const res1 = await manager.translatePage();
      expect(res1.success).toBe(true);
      const ctx1 = manager.sessionContext;
      
      manager.isTranslating = false; // Manually reset for test
      manager.isTranslated = false;
      
      const res2 = await manager.translatePage();
      expect(res2.success).toBe(true);
      const ctx2 = manager.sessionContext;
      
      expect(ctx1).not.toBeNull();
      expect(ctx2).not.toBeNull();
      expect(ctx1).not.toBe(ctx2);
    });
  });

  describe('Auto Translation Rules Override', () => {
    it('should set userRestoredOverride to true on manual restore', async () => {
      await manager.activate();
      expect(manager.userRestoredOverride).toBe(false);
      await manager.restorePage({ manual: true });
      expect(manager.userRestoredOverride).toBe(true);
    });

    it('should not set userRestoredOverride to true on non-manual/internal restore', async () => {
      await manager.activate();
      expect(manager.userRestoredOverride).toBe(false);
      await manager.restorePage();
      expect(manager.userRestoredOverride).toBe(false);

      await manager.restorePage({ manual: false });
      expect(manager.userRestoredOverride).toBe(false);
    });

    it('should reset userRestoredOverride when URL changes', async () => {
      await manager.activate();
      manager.userRestoredOverride = true;
      manager.currentUrl = 'https://old.com';
      
      // Simulate URL change trigger via translatePage
      vi.stubGlobal('location', { href: 'https://new.com' });
      await manager.translatePage();
      expect(manager.userRestoredOverride).toBe(false);
    });

    it('should add URL to autoStartCancelledUrls when token warning is declined on auto-start', async () => {
      const { findProviderById } = await import('@/features/translation/providers/ProviderManifest.js');
      findProviderById.mockReturnValueOnce({ displayName: 'AI Provider', consumesTokens: true });

      // Mock _confirmTokenUsage to return false (user cancelled)
      manager._confirmTokenUsage = vi.fn().mockResolvedValue(false);

      await manager.activate();
      manager.currentUrl = window.location.href;

      const result = await manager.translatePage({ isAuto: true });
      expect(result.success).toBe(false);
      expect(manager.autoStartCancelledUrls.has(window.location.href)).toBe(true);
      expect(manager.abortController).toBeNull();
      expect(manager.translationMessageId).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(false);
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(sendRegularMessage.mock.calls.some(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toBe(false);
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('should not add URL to autoStartCancelledUrls when token warning is declined on manual start', async () => {
      const { findProviderById } = await import('@/features/translation/providers/ProviderManifest.js');
      findProviderById.mockReturnValueOnce({ displayName: 'AI Provider', consumesTokens: true });

      // Mock _confirmTokenUsage to return false (user cancelled)
      manager._confirmTokenUsage = vi.fn().mockResolvedValue(false);

      await manager.activate();
      manager.currentUrl = window.location.href;

      const result = await manager.translatePage({ isAuto: false });
      expect(result.success).toBe(false);
      expect(manager.autoStartCancelledUrls.has(window.location.href)).toBe(false);
    });

    it('settles token-warning setup rejection instead of hanging', async () => {
      const { findProviderById } = await import('@/features/translation/providers/ProviderManifest.js');
      const { getTranslationString } = await import('@/utils/i18n/i18n.js');
      const error = new Error('localization setup failed');
      findProviderById.mockReturnValueOnce({ displayName: 'AI Provider', consumesTokens: true });
      getTranslationString.mockRejectedValueOnce(error);

      await manager.activate();
      await expect(manager.translatePage()).rejects.toBe(error);

      expect(manager.abortController).toBeNull();
      expect(manager.translationMessageId).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('preserves accepted same-URL auto state when new admission fails', async () => {
      const previousContext = Symbol('previous-session');
      const previousController = new AbortController();
      await manager.activate();
      manager.currentUrl = window.location.href;
      manager.isTranslated = true;
      manager.isAutoTranslating = true;
      manager.abortController = previousController;
      manager.translationMessageId = 'previous-message';
      manager.sessionContext = previousContext;
      manager.scheduler.translatedCount = 4;
      manager.scheduler.failedCount = 1;
      manager.scheduler.totalTasks = 5;
      manager.scheduler.translationSessionId = 'previous-session';
      manager.scheduler.sessionContext = previousContext;
      manager.bridge.session = { active: true };
      manager._injectLayoutFix();
      manager.scheduler.reset.mockClear();
      manager.bridge.cleanup.mockClear();
      PageTranslationSettingsLoader.load.mockRejectedValueOnce(
        Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT })
      );

      const result = await manager.translatePage({ isAuto: true });

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.isTranslated).toBe(true);
      expect(manager.isTranslating).toBe(false);
      expect(manager.isAutoTranslating).toBe(true);
      expect(manager.scheduler.reset).not.toHaveBeenCalled();
      expect(manager.scheduler.translatedCount).toBe(4);
      expect(manager.scheduler.failedCount).toBe(1);
      expect(manager.scheduler.totalTasks).toBe(5);
      expect(manager.scheduler.translationSessionId).toBe('previous-session');
      expect(manager.scheduler.sessionContext).toBe(previousContext);
      expect(manager.bridge.cleanup).not.toHaveBeenCalled();
      expect(manager.bridge.session).toEqual({ active: true });
      expect(manager.abortController).toBe(previousController);
      expect(manager.translationMessageId).toBe('previous-message');
      expect(manager.sessionContext).toBe(previousContext);
      expect(document.documentElement.classList.contains('ti-translation-active')).toBe(true);
      expect(document.getElementById('ti-translation-layout-fix')).not.toBeNull();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_IDLE, expect.anything());
    });

    it('resets scheduler only after START admission', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      manager.scheduler.reset.mockClear();
      pageEventBus.emit.mockClear();

      const result = await manager.translatePage();
      const startCall = pageEventBus.emit.mock.invocationCallOrder.find((callOrder, index) => (
        pageEventBus.emit.mock.calls[index][0] === MessageActions.PAGE_TRANSLATE_START
          ? callOrder
          : false
      ));

      expect(result.success).toBe(true);
      expect(startCall).toBeDefined();
      expect(manager.scheduler.reset).toHaveBeenCalledOnce();
      expect(manager.scheduler.reset.mock.invocationCallOrder[0]).toBeGreaterThan(startCall);
    });

    it('does not admit a settings continuation after cancellation', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      const settings = createDeferred();
      PageTranslationSettingsLoader.load.mockImplementationOnce(() => settings.promise);
      const pending = manager.translatePage();

      await vi.waitFor(() => expect(manager.abortController).not.toBeNull());
      const provisionalMessageId = manager.translationMessageId;
      expect(provisionalMessageId).not.toBe(manager.scheduler.translationSessionId);
      manager.cancelTranslation();
      settings.resolve({
        translationApi: 'google',
        targetLanguage: 'fa',
        lazyLoading: false,
        autoTranslateOnDOMChanges: false,
        showOriginalOnHover: true,
        tokenWarningHidden: true,
      });

      const result = await pending;

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.bridge.initialize).not.toHaveBeenCalled();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(sendRegularMessage.mock.calls.some(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toBe(false);
      await vi.waitFor(() => expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.any(Object)
      ));
    });

    it('does not admit pending settings after stopping obsolete translation', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      const pendingSettings = createDeferred();
      PageTranslationSettingsLoader.load.mockImplementationOnce(() => pendingSettings.promise);
      const pending = manager.translatePage();
      await vi.waitFor(() => expect(manager.abortController).not.toBeNull());
      const controller = manager.abortController;

      await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
      expect(controller.signal.aborted).toBe(true);
      expect(manager.sessionContext).toBeNull();
      expect(manager.bridge.stopPersistence).toHaveBeenCalled();
      expect(manager.scheduler.setTranslationState).toHaveBeenCalledWith(false, undefined, undefined, 'operation-abort');
      pendingSettings.resolve({ translationApi: 'custom', targetLanguage: 'ja' });

      expect(await pending).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.bridge.initialize).not.toHaveBeenCalled();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
    });

    it('does not restart translation after stopped bridge initialization completes', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      const pendingBridge = createDeferred();
      manager.bridge.initialize.mockImplementationOnce(() => pendingBridge.promise);
      const pending = manager.translatePage();
      await vi.waitFor(() => expect(manager.bridge.initialize).toHaveBeenCalled());

      await manager.stopAutoTranslation({ cancellationReason: 'operation-abort' });
      pendingBridge.resolve();

      expect(await pending).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.bridge.translate).not.toHaveBeenCalled();
      expect(manager.isTranslating).toBe(false);
      expect(manager.isAutoTranslating).toBe(false);
    });

    it('does not admit a token confirmation after cancellation', async () => {
      const { findProviderById } = await import('@/features/translation/providers/ProviderManifest.js');
      const confirmation = createDeferred();
      findProviderById.mockReturnValueOnce({ displayName: 'AI Provider', consumesTokens: true });
      await manager.activate();
      manager.currentUrl = window.location.href;
      manager._confirmTokenUsage = vi.fn(() => confirmation.promise);
      const pending = manager.translatePage();

      await vi.waitFor(() => expect(manager._confirmTokenUsage).toHaveBeenCalled());
      manager.cancelTranslation();
      confirmation.resolve(true);

      const result = await pending;

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.bridge.initialize).not.toHaveBeenCalled();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
      expect(sendRegularMessage.mock.calls.some(([message]) => (
        message.action === MessageActions.CANCEL_SESSION
      ))).toBe(false);
      await vi.waitFor(() => expect(pageEventBus.emit).toHaveBeenCalledWith(
        MessageActions.PAGE_RESTORE_COMPLETE,
        expect.any(Object)
      ));
    });

    it('does not admit a settings continuation after navigation', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      const settings = createDeferred();
      PageTranslationSettingsLoader.load.mockImplementationOnce(() => settings.promise);
      const pending = manager.translatePage();

      await vi.waitFor(() => expect(manager.abortController).not.toBeNull());
      vi.stubGlobal('location', { ...window.location, href: 'https://new.example.com' });
      settings.resolve({
        translationApi: 'google',
        targetLanguage: 'fa',
        lazyLoading: false,
        autoTranslateOnDOMChanges: false,
        showOriginalOnHover: true,
        tokenWarningHidden: true,
      });

      const result = await pending;

      expect(result).toEqual({ success: false, reason: 'silent_error' });
      expect(manager.abortController).toBeNull();
      expect(manager.translationMessageId).toBeNull();
      expect(manager.sessionContext).toBeNull();
      expect(document.getElementById('ti-translation-layout-fix')).toBeNull();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_START, expect.anything());
    });

    it('admits a clean second attempt after pre-START failure', async () => {
      await manager.activate();
      manager.currentUrl = window.location.href;
      PageTranslationSettingsLoader.load.mockRejectedValueOnce(
        Object.assign(new Error('context lost'), { type: ErrorTypes.CONTEXT })
      );
      await manager.translatePage();

      pageEventBus.emit.mockClear();
      PageTranslationSettingsLoader.load.mockResolvedValueOnce({
        translationApi: 'google',
        targetLanguage: 'fa',
        lazyLoading: false,
        autoTranslateOnDOMChanges: false,
        showOriginalOnHover: true,
        tokenWarningHidden: true,
      });

      const result = await manager.translatePage();

      expect(result.success).toBe(true);
      expect(pageEventBus.emit.mock.calls.filter(([action]) => (
        action === MessageActions.PAGE_TRANSLATE_START
      ))).toHaveLength(1);
      expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_ERROR, expect.anything());
    });

    it('should support comma and newline parsing for auto translate rules', () => {
      const parseRules = (v) => v.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
      const input = "example.com\n  google.com,   github.com  \n,apple.com";
      const result = parseRules(input);
      expect(result).toEqual(['example.com', 'google.com', 'github.com', 'apple.com']);
    });
  });

  describe('Token warning persistence', () => {
    const collectUnhandledRejections = () => {
      const failures = [];
      const onUnhandled = (reason) => failures.push(reason);
      process.on('unhandledRejection', onUnhandled);
      return {
        failures,
        release: () => process.off('unhandledRejection', onUnhandled),
      };
    };

    const showTokenWarning = async (alreadyShown = 0) => {
      manager.settings = { tokenWarningHidden: false };
      const pending = manager._confirmTokenUsage('gemini', 'Gemini');
      await vi.waitFor(() => expect(
        manager.notificationManager.show.mock.calls.length
      ).toBeGreaterThan(alreadyShown));
      const options = manager.notificationManager.show.mock.calls.at(-1)[3];
      return { pending, actions: options.actions };
    };

    const settleRejections = async () => {
      await vi.waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it('confirm+dontShowAgain resolves true and persists best-effort', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        const { pending, actions } = await showTokenWarning();
        actions[0].onClick(true);

        await expect(pending).resolves.toBe(true);
        expect(mockStorageManagerSet).toHaveBeenCalledWith({ WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true });
        expect(failures).toHaveLength(0);
      } finally {
        release();
      }
    });

    it('confirm+dontShowAgain handles persistence rejection without blocking the flow', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        mockStorageManagerSet.mockRejectedValueOnce(new Error('storage failed'));
        const { pending, actions } = await showTokenWarning();
        actions[0].onClick(true);

        // Dismiss/resolve and continue behavior exactly as today.
        await expect(pending).resolves.toBe(true);
        expect(mockStorageManagerSet).toHaveBeenCalledWith({ WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true });
        await settleRejections();
        expect(mockLoggerWarn).toHaveBeenCalled();
        expect(failures).toHaveLength(0);
      } finally {
        release();
      }
    });

    it('cancel+dontShowAgain handles persistence rejection without blocking the flow', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        mockStorageManagerSet.mockRejectedValueOnce(new Error('storage failed'));
        const { pending, actions } = await showTokenWarning();
        actions[1].onClick(true);

        await expect(pending).resolves.toBe(false);
        expect(mockStorageManagerSet).toHaveBeenCalledWith({ WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true });
        await settleRejections();
        expect(mockLoggerWarn).toHaveBeenCalled();
        expect(failures).toHaveLength(0);
      } finally {
        release();
      }
    });

    it('confirm without dontShowAgain skips persistence', async () => {
      const { pending, actions } = await showTokenWarning();
      actions[0].onClick(false);

      await expect(pending).resolves.toBe(true);
      expect(mockStorageManagerSet).not.toHaveBeenCalled();
    });

    it('subsequent warning flow stays usable after a rejected write', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        mockStorageManagerSet.mockRejectedValueOnce(new Error('storage failed'));
        const first = await showTokenWarning();
        first.actions[0].onClick(true);
        await expect(first.pending).resolves.toBe(true);
        await settleRejections();

        // Next warning still shows and its persist is attempted again.
        const shownBefore = manager.notificationManager.show.mock.calls.length;
        const second = await showTokenWarning(shownBefore);
        second.actions[0].onClick(true);
        await expect(second.pending).resolves.toBe(true);
        expect(mockStorageManagerSet).toHaveBeenCalledTimes(2);
        expect(mockStorageManagerSet).toHaveBeenNthCalledWith(2, { WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true });
        expect(failures).toHaveLength(0);
      } finally {
        release();
      }
    });
  });
});

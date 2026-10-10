// src/core/content-scripts/ContentScriptCore.js
// Main Frame Content Script Core - Includes Vue and full feature set

import { BaseContentScriptCore } from './BaseContentScriptCore.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

export function ContentScriptCore() {
  // Inherit from Base Core
  const core = BaseContentScriptCore();

  // Add Main-frame specific properties
  core.vueLoaded = false;
  core.featuresLoaded = false;

  const originalInitializeMessaging = core.initializeMessaging;
  
  // Extend messaging to include core handlers
  core.initializeMessaging = async function() {
    await originalInitializeMessaging.call(this);
    if (this.messageHandler) {
      await this.registerCoreHandlers();
    }
  };

  core.registerCoreHandlers = async function() {
    this.messageHandler.registerHandler('contentScriptReady', async () => {
      return { ready: true, vueLoaded: this.vueLoaded, featuresLoaded: this.featuresLoaded };
    });

    this.messageHandler.registerHandler('loadVueApp', async () => {
      await this.loadVueApp();
      return { success: true };
    });

    this.messageHandler.registerHandler('loadFeatures', async () => {
      await this.loadFeatures();
      return { success: true };
    });

    this.messageHandler.registerHandler(MessageActions.SPA_NAVIGATION, async (message) => {
      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      const featureManager = FeatureManager.getInstance();
      await featureManager.initialize();
      await featureManager.checkForUrlChange({
        navigationCursor: message?.data?.navigationCursor,
        navigationUnavailable: message?.data?.navigationUnavailable,
      });
      return { success: true };
    });
  };

  // Allowed-runtime idempotent state (Phase B) — owned permanent composition
  core._allowedRuntimeStarted = false;
  core._allowedRuntimePromise = null;
  core._mainFrameAggregator = null;
  core._mainFrameCoordinator = null;
  core._mainFeatureLoader = null;

  core.reconcileAllowedRuntime = async function() {
    const { checkUrlExclusionAsync } = await import('@/features/exclusion/utils/exclusion-utils.js');
    const isExcluded = await checkUrlExclusionAsync(window.location.href);
    if (isExcluded) return false;
    return await this.ensureAllowedRuntime();
  };

  core.ensureAllowedRuntime = async function() {
    if (this._allowedRuntimeStarted) return true;
    if (this._allowedRuntimePromise) return this._allowedRuntimePromise;

    const bootstrap = (async () => {
      const { checkUrlExclusionAsync } = await import('@/features/exclusion/utils/exclusion-utils.js');
      if (await checkUrlExclusionAsync(window.location.href)) {
        return false;
      }

      if (this._allowedRuntimeStarted) return true;
      // Guard hard exclusions that must never start allowed runtime
      if (window.location.protocol.endsWith('-extension:') ||
          window.location.href.startsWith((typeof browser !== 'undefined' && browser.runtime?.getURL) ? browser.runtime.getURL('') : 'chrome-extension://') ||
          document.documentElement.classList.contains('translate-it-ui-frame')) {
        return false;
      }

      // Ensure minimal FeatureManager is ready before composing allowed runtime
      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      const fm = FeatureManager.getInstance();
      if (!fm.initialized) {
        await fm.initialize();
      }

      const [{ MainFrameAggregator }, { MainFrameCoordinator }, { MainFeatureLoader }, { MessageActions }] = await Promise.all([
        import('./main/MainFrameAggregator.js'),
        import('./main/MainFrameCoordinator.js'),
        import('./main/MainFeatureLoader.js'),
        import('@/shared/messaging/core/MessageActions.js')
      ]);

      let aggregator = this._mainFrameAggregator;
      if (!aggregator) {
        aggregator = new MainFrameAggregator(MessageActions);
        this._mainFrameAggregator = aggregator;
        window.getGlobalPageTranslationStatus = aggregator.getGlobalPageTranslationStatus;
      } else {
        window.getGlobalPageTranslationStatus = window.getGlobalPageTranslationStatus || aggregator.getGlobalPageTranslationStatus;
      }

      const initializeLogger = async (sub = 'Main') => {
        try {
          const [{ getScopedLogger }, { LOG_COMPONENTS }] = await Promise.all([
            import('@/shared/logging/logger.js'),
            import('@/shared/logging/logConstants.js')
          ]);
          return getScopedLogger(LOG_COMPONENTS.CONTENT, sub);
        } catch {
          return { debug: () => {}, info: console.log, warn: console.warn, error: console.error };
        }
      };

      let featureLoader = this._mainFeatureLoader;
      if (!featureLoader) {
        featureLoader = new MainFeatureLoader(this, initializeLogger);
        this._mainFeatureLoader = featureLoader;
      }

      if (!this._mainFrameCoordinator) {
        this._mainFrameCoordinator = new MainFrameCoordinator(aggregator, MessageActions, this);
      }

      await featureLoader.loadFeature('extensionContext', 'CRITICAL');
      try {
        const { interactionCoordinator } = await import('./InteractionCoordinator.js');
        await interactionCoordinator.initialize();
      } catch { /* empty */ }

      try {
        const { installTextSelectionWindowRelay } = await import('@/features/windows/managers/crossframe/TextSelectionWindowRelay.js');
        installTextSelectionWindowRelay(this);
      } catch { /* empty */ }

      featureLoader.startIntelligentLoading();

      // Store for later idempotency checks
      this._mainFeatureLoader = featureLoader;

      // Auto-translation check runs only once per allowed-runtime bootstrap
      (async () => {
        const autoLogger = await initializeLogger('AutoTranslate');
        try {
          const { default: settingsManager } = await import('@/shared/managers/SettingsManager.js');
          await settingsManager.initialize();
          if (settingsManager.isExtensionEnabled() && settingsManager.get('WHOLE_PAGE_TRANSLATION_ENABLED', true)) {
            const autoRules = settingsManager.get('WHOLE_PAGE_AUTO_TRANSLATE_RULES', []);
            if (autoRules.length > 0) {
              const { matchesAutoTranslateRule } = await import('@/utils/ui/exclusion.js');
              const currentUrl = window.location.href;
              const isMatch = autoRules.some(rule => matchesAutoTranslateRule(currentUrl, rule));
              if (isMatch) {
                const { ExclusionChecker } = await import('@/features/exclusion/core/ExclusionChecker.js');
                const exclusionChecker = ExclusionChecker.getInstance();
                await exclusionChecker.initialize();
                const isAllowed = await exclusionChecker.isFeatureAllowed('pageTranslation');
                if (isAllowed) {
                  await featureLoader.loadFeature('contentMessageHandler', 'ESSENTIAL');
                  const { FeatureManager: FM2 } = await import('@/core/managers/content/FeatureManager.js');
                  const fm2 = FM2.getInstance();
                  const cmh = fm2.getFeatureHandler('contentMessageHandler');
                  if (!fm2.isFeatureActive('contentMessageHandler') || !cmh?.isActive) throw new Error('ContentMessageHandler not ready');
                  await featureLoader.loadFeature('pageTranslation', 'INTERACTIVE');
                  const manager = fm2.getFeatureHandler('pageTranslation');
                  if (manager && !manager.isActive) await manager.activate();
                  if (manager && !manager.userRestoredOverride && !manager.autoStartCancelledUrls?.has(currentUrl)) {
                    const { sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
                    const { MessageActions: MA } = await import('@/shared/messaging/core/MessageActions.js');
                    const response = await sendRegularMessage({ action: MA.PAGE_TRANSLATE, data: { isAuto: true } }, { returnFailureResponse: true });
                    if (response?.success === false) {
                      autoLogger.debug('SPA auto page translation command rejected', response);
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          autoLogger.error('Failed to run auto page translation check:', error);
        }
      })();

      this._allowedRuntimeStarted = true;
      return true;
    })();

    const wrapped = bootstrap.finally(() => {
      if (this._allowedRuntimePromise === wrapped) this._allowedRuntimePromise = null;
    });
    this._allowedRuntimePromise = wrapped;
    return wrapped;
  };

  /**
   * CRITICAL: Initialize method for Main Frame
   */
  core.initializeCritical = async function() {
    if (this.initialized) return true;
    if (this._criticalInitializationPromise) return this._criticalInitializationPromise;

    const initialization = (async () => {
      const success = await this.initializeBase();
      if (!success) return false;

      // Pre-warm settings and DebugMode (Main frame specific)
      const { default: SettingsManager } = await import('@/shared/managers/SettingsManager.js');
      await SettingsManager.initialize();
      void SettingsManager.warmup();

      const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js');
      await debugModeBridge.initialize();

      // Minimal lifecycle: ensure FeatureManager exists and policy hook is registered
      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      const fm = FeatureManager.getInstance();
      if (!fm.initialized) {
        await fm.initialize();
      }
      if (!this._policyHookUnsubscribe) {
        this._policyHookUnsubscribe = fm.onPolicyChanged(() => {
          void this.reconcileAllowedRuntime().catch(() => {});
        });
      }

      await this.reconcileAllowedRuntime();
      this.initialized = true;
      return true;
    })().catch(() => false);
    this._criticalInitializationPromise = initialization;
    return initialization.finally(() => {
      if (this._criticalInitializationPromise === initialization) {
        this._criticalInitializationPromise = null;
      }
    });
  };

  // --- VUE LOADING (Heavy) ---
  core.loadVueApp = async function() {
    if (this.vueLoaded) return;
    try {
      const { loadVueApp } = await import('./chunks/lazy-vue-app.js');
      await loadVueApp(this);
      this.vueLoaded = true;
      this.dispatchEvent(new CustomEvent('vue-loaded'));
    } catch {
      // Fallback
      const { initializeLegacyHandlers } = await import('./legacy-handlers.js');
      await initializeLegacyHandlers(this);
    }
  };

  core.loadFeatures = async function() {
    if (this.featuresLoaded) return;
    try {
      const { loadCoreFeatures } = await import('./chunks/lazy-features.js');
      await loadCoreFeatures();
      
      // We don't mark as fully loaded here to allow other features 
      // to continue loading on-demand via InteractionCoordinator
      this.featuresLoaded = true;
      this.dispatchEvent(new CustomEvent('features-loaded'));
    } catch {
      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      await FeatureManager.getInstance().initialize();
    }
  };

  core.loadFeature = async function(featureName) {
    const { loadFeatureOnDemand } = await import('./chunks/lazy-features.js');
    return await loadFeatureOnDemand(featureName);
  };

  core.injectMainDOMStyles = function(css, id = 'translate-it-main-dom-styles') {
    this.injectStyles(css, id);
  };

  // Compatibility
  core.initialize = core.initializeCritical;

  return core;
}

export default ContentScriptCore;

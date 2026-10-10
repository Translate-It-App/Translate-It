// src/core/content-scripts/IFrameContentScriptCore.js
// Lite infrastructure for iframe content scripts - No Vue/UI bloat

import { BaseContentScriptCore } from './BaseContentScriptCore.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

/**
 * IFrameContentScriptCore - Specialized lite version for subframes.
 */
export function IFrameContentScriptCore() {
  const core = BaseContentScriptCore();

  core.registerCoreHandlers = function() {
    if (!this.messageHandler) return;

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

  core._allowedRuntimeStarted = false;
  core._allowedRuntimePromise = null;

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
      // Already filtered tiny/extension frames by entry hard guards
      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      const fm = FeatureManager.getInstance();
      if (!fm.initialized) await fm.initialize();

      await this.injectMainDOMStyles();

      try {
        const { interactionCoordinator } = await import('./InteractionCoordinator.js');
        await interactionCoordinator.initialize();
      } catch { /* empty */ }

      try {
        const { getTextSelectionWindowRelay } = await import('@/features/windows/managers/crossframe/TextSelectionWindowRelay.js');
        getTextSelectionWindowRelay();
      } catch { /* empty */ }

      const LITE_FEATURES = ['messaging', 'extensionContext', 'contentMessageHandler', 'mouseHover'];
      for (const feature of LITE_FEATURES) {
        await this.loadFeature(feature);
      }

      if (!this._iframeMessageListenersSetup) {
        this._iframeMessageListenersSetup = true;
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'translateit-activate-click-listeners') {
            const handleInternalClick = () => {
              try {
                window.top.postMessage({ type: 'TRANSLATE_IT_IFRAME_CLICK_DETECTED', source: 'translate-it-iframe' }, '*');
              } catch { /* empty */ }
              window.removeEventListener('click', handleInternalClick, { capture: true });
            };
            window.addEventListener('click', handleInternalClick, { capture: true, once: true, passive: true });
          }
        });
      }

      // FRAME_READY must be after allowed runtime readiness
      try {
        const { MessageActions } = await import('@/shared/messaging/core/MessageActions.js');
        const browserAPI = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));
        if (browserAPI?.runtime?.sendMessage) {
          void browserAPI.runtime.sendMessage({ action: MessageActions.SELECT_ELEMENT_FRAME_READY, data: {} }).catch(() => {});
        }
      } catch { /* empty */ }

      this._allowedRuntimeStarted = true;
      return true;
    })();

    const wrapped = bootstrap.finally(() => {
      if (this._allowedRuntimePromise === wrapped) this._allowedRuntimePromise = null;
      if (!this._allowedRuntimeStarted) {
        // keep promise cleared so next call retries
      }
    });
    this._allowedRuntimePromise = wrapped;
    return wrapped;
  };

  // Iframe specific initialization
  core.initializeCritical = async function() {
    if (this.initialized) return true;
    if (this._criticalInitializationPromise) return this._criticalInitializationPromise;

    const initialization = (async () => {
      const success = await this.initializeBase();
      if (!success) return false;

      this.registerCoreHandlers();

      const { default: SettingsManager } = await import('@/shared/managers/SettingsManager.js');
      await SettingsManager.initialize();
      void SettingsManager.warmup();

      const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
      const fm = FeatureManager.getInstance();
      if (!fm.initialized) await fm.initialize();
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

  core.loadFeature = async function(featureName) {
    // Dynamically load feature only when requested
    const { loadFeatureOnDemand } = await import('./chunks/lazy-features.js');
    return await loadFeatureOnDemand(featureName);
  };

  core.injectMainDOMStyles = function(css, id = 'translate-it-main-dom-styles') {
    if (css && id) {
      this.injectStyles(css, id);
      return;
    }
    
    // Fallback for default lite styles
    const liteCss = `
      :root { --translate-highlight-color: #ff8800; }
      .translate-it-element-highlighted { outline: 3px solid var(--translate-highlight-color) !important; }
    `;
    this.injectStyles(liteCss, 'translate-it-main-dom-styles');
  };

  // Compatibility
  core.initialize = core.initializeCritical;
  core.vueLoaded = false;

  return core;
}

export default IFrameContentScriptCore;

// src/core/content-scripts/IFrameContentScriptCore.js
// Lite infrastructure for iframe content scripts - No Vue/UI bloat

import { BaseContentScriptCore } from './BaseContentScriptCore.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

/**
 * State source for Select Element in a frame that cannot load the full
 * ContentMessageHandler. window.selectElementManagerInstance is set by
 * SelectElementManager's constructor. `active` mirrors the manager's real
 * isActive flag, but is NOT proof that cleanup finished: the manager clears
 * isActive BEFORE its cleanup work completes, so a manager's presence alone
 * means Select Element state may still exist in the frame.
 */
function getIframeSelectElementState() {
  const manager = typeof window !== 'undefined' ? window.selectElementManagerInstance : null;
  const active = typeof manager?.isSelectElementActive === 'function'
    ? manager.isSelectElementActive() === true
    : manager?.isActive === true;
  return { active, hasManager: !!manager };
}

/**
 * Minimal Select Element responders for frames that cannot load the full
 * ContentMessageHandler (e.g. excluded frames). Truthful and fail-closed:
 * only a frame with NO Select Element manager is provably free of Select
 * Element state and answers with a definitive negative confirmation (and a
 * no-op cleanup ack), discharging Background provisional cleanup ownership.
 * A frame that still has a manager keeps that ownership: the manager clears
 * its active flag before cleanup completes, so it never confirms cleanup.
 */
export function createSelectElementFallbackResponders() {
  return {
    handleActivateSelectElementMode: async () => {
      const { hasManager } = getIframeSelectElementState();
      if (hasManager) {
        return { success: false, activated: true, error: 'Select Element state may still exist in this frame' };
      }
      return { success: false, activated: false, error: 'Select Element feature not available in this frame' };
    },

    handleDeactivateSelectElementMode: async () => {
      const { hasManager } = getIframeSelectElementState();
      if (hasManager) {
        return { success: false, cleanupCompleted: false, activated: true, error: 'Select Element state may still exist in this frame' };
      }
      return { success: true, cleanupCompleted: true, activated: false };
    },

    handleGetSelectElementFrameState: async () => {
      const { hasManager } = getIframeSelectElementState();
      // Read-only: the fallback adopts no epoch and no generation. A frame
      // with a manager is never reported definitively inactive.
      return {
        active: hasManager,
        activationEpoch: null,
        activationGeneration: null,
        hasManager,
      };
    },
  };
}

/**
 * Install the fallback responders on the frame's existing message handler.
 * Never overwrites a handler owned by the real ContentMessageHandler: an
 * action that already has an owner is skipped, so the sanctioned hand-off to
 * the real handler stays intact. Returns the installed action map.
 */
export function installSelectElementFallbackHandlers(messageHandler) {
  if (!messageHandler || typeof messageHandler.registerHandler !== 'function') {
    return new Map();
  }

  const responders = createSelectElementFallbackResponders();
  const installed = new Map();
  const actions = [
    [MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, responders.handleActivateSelectElementMode],
    [MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, responders.handleDeactivateSelectElementMode],
    [MessageActions.GET_SELECT_ELEMENT_FRAME_STATE, responders.handleGetSelectElementFrameState],
  ];

  for (const [action, responder] of actions) {
    if (typeof messageHandler.getHandlerForMessage === 'function' && messageHandler.getHandlerForMessage(action)) {
      continue;
    }
    messageHandler.registerHandler(action, responder);
    installed.set(action, responder);
  }
  return installed;
}

/**
 * IFrameContentScriptCore - Specialized lite version for subframes.
 */
export function IFrameContentScriptCore() {
  const core = BaseContentScriptCore();

  core.registerCoreHandlers = function() {
    if (!this.messageHandler) return;

    // No frame is ever silent: excluded frames without the full content
    // handler still answer Select Element activation/cleanup probes.
    installSelectElementFallbackHandlers(this.messageHandler);

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
    }
  };

  // Compatibility
  core.initialize = core.initializeCritical;
  core.vueLoaded = false;

  return core;
}

export default IFrameContentScriptCore;

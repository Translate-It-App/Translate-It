// src/core/content-scripts/chunks/lazy-features.js
// Lazy-loaded features with on-demand loading

import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import ExtensionContextManager from '@/core/extensionContext.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT, 'LazyFeatures');

// Feature registry
const loadedFeatures = new Map();
const loadingPromises = new Map();

// Feature manager instance
let featureManager = null;
let featuresInitialized = false;

// Ensure global featureManager is available
window.featureManager = window.featureManager || null;

// Core features that must be available immediately
const CORE_FEATURES = new Set([
  'contentMessageHandler'
]);

/**
 * Notify that a feature has been deactivated to clear it from cache
 */
export function notifyFeatureDeactivated(featureName) {
  if (loadedFeatures.has(featureName)) {
    loadedFeatures.delete(featureName);
    logger.debug(`Removed feature from cache: ${featureName}`);
  }
  if (loadingPromises.has(featureName)) {
    loadingPromises.delete(featureName);
  }
}

/**
 * Returns a loaded feature instance if it exists
 */
export function getFeatureInstance(featureName) {
  if (loadedFeatures.has(featureName)) return loadedFeatures.get(featureName);
  if (featureManager) {
    const handler = featureManager.getFeatureHandler(featureName);
    if (handler) return handler;
  }
  return null;
}

/**
 * Load a feature lazily. Delegates to FeatureManager for logical activation.
 */
export async function loadFeature(featureName, force = false) {
  // Check if already loaded
  if (loadedFeatures.has(featureName)) return loadedFeatures.get(featureName);

  // Check if currently loading
  if (loadingPromises.has(featureName)) return await loadingPromises.get(featureName);

  // Validate extension context
  if (!ExtensionContextManager.isValidSync()) {
    ExtensionContextManager.handleContextError('Extension context invalid before feature load', `LazyFeatures:${featureName}`);
    return null;
  }

  const loadPromise = (async () => {
    try {
      logger.debug(`Loading feature via FeatureManager: ${featureName}${force ? ' (forced)' : ''}`);

      if (!featureManager) {
        const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
        featureManager = FeatureManager.getInstance();
        window.featureManager = featureManager;
      }

      // Delegate to FeatureManager for logical activation and permission checking
      const handler = await featureManager.requestFeatureActivation(featureName, force);

      if (!handler) {
        logger.debug(`Feature ${featureName} activation returned no handler (likely blocked by exclusion)`);
        return null;
      }

      // Handle specific return types for backward compatibility with existing consumers
      let instance = handler;
      if (featureName === 'windowsManager' && typeof handler.getWindowsManager === 'function') {
        instance = handler.getWindowsManager();
      } else if (featureName === 'textSelection' && handler.selectionManager) {
        instance = handler.selectionManager;
      } else if (featureName === 'textFieldIcon' && typeof handler.getManager === 'function') {
        instance = handler.getManager();
      }

      if (instance) {
        if (featureManager && typeof featureManager.isFeatureActive === 'function' && !featureManager.isFeatureActive(featureName)) {
          if (featureName === 'contentMessageHandler') {
            // Infrastructure feature may be active via handler registration even if not tracked as activeFeatures in some paths
            // Allow caching if handler exists
            if (!featureManager.getFeatureHandler(featureName)) {
              logger.debug(`Feature ${featureName} not active after load, skipping cache`);
              return null;
            }
          } else {
            logger.debug(`Feature ${featureName} not active after load, skipping cache`);
            return null;
          }
        }
        loadedFeatures.set(featureName, instance);
        logger.debug(`Feature instance cached: ${featureName}`);
      }
      
      return instance;
    } catch (error) {
      logger.error(`Failed to load feature ${featureName}:`, error);
      throw error;
    } finally {
      if (loadingPromises.get(featureName) === loadPromise) {
        loadingPromises.delete(featureName);
      }
    }
  })();

  loadingPromises.set(featureName, loadPromise);
  return await loadPromise;
}

export async function loadCoreFeatures() {
  try {
    const { default: SettingsManager } = await import('@/shared/managers/SettingsManager.js');
    await SettingsManager.initialize();
    const loadPromises = Array.from(CORE_FEATURES).map(feature => loadFeatureOnDemand(feature));
    await Promise.all(loadPromises);
    await initializeAndActivateFeatures();
  } catch (error) {
    logger.error('Error in loadCoreFeatures:', error);
  }
}

async function initializeAndActivateFeatures() {
  if (!featureManager) {
    const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
    featureManager = FeatureManager.getInstance();
    window.featureManager = featureManager;
  }
  if (!featuresInitialized) {
    for (const featureName of CORE_FEATURES) {
      if (featureName === 'vue') continue;
      try {
        await loadFeature(featureName);
      } catch { /* ignore */ }
    }
    featuresInitialized = true;
  }
}

export async function loadFeatureOnDemand(featureName) {
  const FEATURE_MAPPING = {
    textSelection: async () => await loadFeature('textSelection'),
    contentMessageHandler: async () => await loadFeature('contentMessageHandler'),
    windowsManager: async () => await loadFeature('windowsManager'),
    selectElement: async () => await loadFeature('selectElement'),
    pageTranslation: async () => await loadFeature('pageTranslation'),
    screenCapture: async () => await loadFeature('screenCapture'),
    shortcut: async () => await loadFeature('shortcut'),
    textFieldIcon: async () => await loadFeature('textFieldIcon'),
    mouseHover: async () => await loadFeature('mouseHover'),
    vue: async () => {
      if (window.translateItContentCore?.loadVueApp) {
        await window.translateItContentCore.loadVueApp();
        return window.translateItContentCore.vueLoaded;
      }
      return null;
    }
  };
  return FEATURE_MAPPING[featureName] ? await FEATURE_MAPPING[featureName]() : null;
}

export function getFeature(featureName) { return loadedFeatures.get(featureName); }
export function isFeatureLoaded(featureName) { return loadedFeatures.has(featureName); }
export function getFeatureManager() { return featureManager; }
export function areFeaturesLoaded() { return featuresInitialized; }

export async function activateFeature(featureName) {
  if (!featureManager) {
    const { FeatureManager } = await import('@/core/managers/content/FeatureManager.js');
    featureManager = FeatureManager.getInstance();
  }
  try { 
    await featureManager.requestFeatureActivation(featureName);
  } catch { /* ignore */ }
}

export function cleanupFeatures() {
  if (featureManager) {
    featureManager.cleanup();
    featureManager = null;
    featuresInitialized = false;
    delete window.translateItFeatureManager;
  }
}

export default {
  loadFeature,
  getFeatureManager,
  areFeaturesLoaded,
  activateFeature,
  cleanupFeatures
};

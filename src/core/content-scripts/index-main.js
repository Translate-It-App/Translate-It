// Main Content script entry point - Top Frame only
// Manages the complete Vue application, features, and UI.
import { installLiveBenchmarkMetadataBridge } from '@/features/element-selection/utils/liveBenchmarkMetadataBridge.js';

// --- CRITICAL PRE-INITIALIZATION ---
// Create placeholder objects for core infrastructure to prevent messaging errors
// during the asynchronous boot process.
if (!window.translateItContentCore) {
  window.translateItContentCore = { initialized: false, vueLoaded: false };
}
if (!window.translateItContentScriptCore) {
  window.translateItContentScriptCore = window.translateItContentCore;
}

// Global reference for the core instance
let contentScriptCore = null;
installLiveBenchmarkMetadataBridge();

// Logging state
let getScopedLogger = null;
let LOG_COMPONENTS = null;

/**
 * Lazy load logging dependencies and get a scoped logger.
 * @param {string} subComponent - Name of the sub-component.
 */
async function initializeLogger(subComponent = 'Main') {
  try {
    if (!getScopedLogger || !LOG_COMPONENTS) {
      const [{ getScopedLogger: scopedLogger }, { LOG_COMPONENTS: logComponents }] = await Promise.all([
        import('@/shared/logging/logger.js'),
        import('@/shared/logging/logConstants.js')
      ]);
      getScopedLogger = scopedLogger;
      LOG_COMPONENTS = logComponents;
    }
    return getScopedLogger(LOG_COMPONENTS.CONTENT, subComponent);
  } catch {
    // Fallback logger if loading fails
    return {
      debug: () => {},
      info: (...args) => console.log(`[Content.${subComponent}]`, ...args),
      warn: (...args) => console.warn(`[Content.${subComponent}]`, ...args),
      error: (...args) => console.error(`[Content.${subComponent}]`, ...args)
    };
  }
}

// Initialize the content script with ultra-minimal footprint
(async () => {
  // 1. FAST FAIL: Only run in the top frame for this script
  if (window !== window.top) {
    return;
  }

  try {
    // 2. LAZY LOAD CORE UTILS & POLYFILL
    const [
      { default: browser },
      { setupTrustedTypesCompatibility }
    ] = await Promise.all([
      import('webextension-polyfill'),
      import('@/shared/vue/vue-utils.js')
    ]);

    window.browser = browser;
    setupTrustedTypesCompatibility();

    // 3. SELF-DETECTION: Never run content script inside our own UI frames (hard guard)
    const isExtensionFrame = window.location.protocol.endsWith('-extension:') || 
                             (browser.runtime?.getURL && window.location.href.startsWith(browser.runtime.getURL(''))) ||
                             document.documentElement.classList.contains('translate-it-ui-frame');
    
    if (isExtensionFrame) {
      return;
    }

    const scriptLogger = await initializeLogger('Main');

    if (process.env.NODE_ENV === 'development') {
      scriptLogger.debug('Initializing main frame content script (Modular mode)');
    }
    scriptLogger.info('Main frame initialized');

    // 4. MINIMAL CORE BOOTSTRAP — always alive, even when policy-excluded
    try {
      const { ContentScriptCore } = await import('./ContentScriptCore.js');
      contentScriptCore = new ContentScriptCore();
      
      // Update global references with the real instance
      window.translateItContentCore = contentScriptCore;
      window.translateItContentScriptCore = contentScriptCore;
      
      const { initializeContentCore } = await import('./contentStartup.js');
      const initialized = await initializeContentCore(contentScriptCore);
      
      if (initialized) {
        // Minimal core ready — allowed-runtime will be reconciled via FeatureManager policy hook
        // (ContentScriptCore.initializeCritical registers onPolicyChanged → reconcileAllowedRuntime)
        if (process.env.NODE_ENV === 'development') {
          scriptLogger.info('Main frame minimal core initialized (Modular mode)');
        }
      }
    } catch (error) {
      scriptLogger.error('Failed to initialize ContentScriptCore instance:', error);
    }
  } catch (error) {
    const errorLogger = await initializeLogger();
    errorLogger.error('Critical initialization error:', error);
  }
})();

// Export for debugging purposes
window.translateItContentScriptCore = contentScriptCore;

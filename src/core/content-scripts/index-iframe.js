// Lite Content script entry point - Iframe/Proxy only
// Ultra-minimal footprint for third-party or same-origin iframes.

// --- CRITICAL PRE-INITIALIZATION ---
if (!window.translateItContentCore) {
  window.translateItContentCore = { initialized: false, vueLoaded: false };
}
if (!window.translateItContentScriptCore) {
  window.translateItContentScriptCore = window.translateItContentCore;
}

(async () => {
  // 1. FAST FAIL: Never run in the top frame
  if (window === window.top) return;

  // 2. SMART FILTER: tiny iframes (ads, trackers, captcha widgets) get a
  //    messaging-only core: they must answer Select Element frame probes so
  //    the background can settle cleanup ownership, but load no features.
  // The size is sampled once at load. A tiny frame that grows later
  // stays messaging-only until its document reloads or navigates.
  const MIN_FRAME_SIZE = 80;
  const isTinyFrame = window.innerWidth > 0 && window.innerHeight > 0 && 
                      (window.innerWidth < MIN_FRAME_SIZE || window.innerHeight < MIN_FRAME_SIZE);

  // 3. PREVENT RE-INJECTION
  if (window.translateItContentScriptLoaded) return;

  try {
    // 4. LAZY LOAD POLYFILL & UTILS
    const [
      { default: browser },
      { setupTrustedTypesCompatibility }
    ] = await Promise.all([
      import('webextension-polyfill'),
      import('@/shared/vue/vue-utils.js')
    ]);

    window.browser = browser;
    setupTrustedTypesCompatibility();

    // 5. EXTENSION FRAME CHECK (hard guard)
    const isExtensionFrame = window.location.protocol.endsWith('-extension:') || 
                             (browser.runtime?.getURL && window.location.href.startsWith(browser.runtime.getURL('')));
    if (isExtensionFrame) return;

    // 6. MINIMAL CORE BOOTSTRAP — always alive, even when policy-excluded
    const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
    const contentScriptCore = new IFrameContentScriptCore({ tinyFrame: isTinyFrame });
    window.translateItContentCore = contentScriptCore;
    window.translateItContentScriptCore = contentScriptCore;
    
    const { initializeContentCore } = await import('./contentStartup.js');
    const initialized = await initializeContentCore(contentScriptCore);

    if (initialized) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[IFrame] Lite minimal core initialized', window.location.href);
      }
      // Allowed-runtime (styles, LITE features, listeners, FRAME_READY) will be
      // started via IFrameContentScriptCore.reconcileAllowedRuntime() triggered by
      // FeatureManager policy hook — no heavy work here.
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[IFrame] Init error:', error);
    }
  }
})();



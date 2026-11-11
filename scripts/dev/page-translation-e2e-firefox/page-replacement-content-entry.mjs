import { PageTranslationManager } from '../../../src/features/page-translation/PageTranslationManager.js';
import { PageTranslationScheduler } from '../../../src/features/page-translation/PageTranslationScheduler.js';
import { PageTranslationBridge } from '../../../src/features/page-translation/PageTranslationBridge.js';
import { FeatureManager } from '../../../src/core/managers/content/FeatureManager.js';
import { createReplacementContentRuntime } from './runtime-replacement-content.mjs';

/**
 * Phase 2 browser-observation content entry. The harness Vite build injects
 * globalThis.__firefoxPageTranslationReplacementConfig (token-free; the
 * background brokers every authenticated call). The entry waits for background
 * storage seeding, installs observers, then imports the actual production
 * content entry. It does not dispatch a Page command or navigate. After
 * cleanup, a bounded watcher polls for the runner's capture-final grant and
 * reports the final A-retained/B-accepted DOM through the background.
 *
 * The browser API is taken from the ambient extension global, exactly as the
 * Phase 1/2A content probes do, so the harness never bundles a second
 * WebExtension polyfill into the page realm.
 */
export async function startPageReplacementContent(config = globalThis.__firefoxPageTranslationReplacementConfig) {
  if (!config) throw new Error('Page replacement content config was not injected by the harness build.');
  const browser = globalThis.browser;
  const root = document.documentElement;
  try {
    const adapter = createReplacementContentRuntime(config, { browserApi: browser, PageTranslationManager,
      PageTranslationScheduler, PageTranslationBridge, FeatureManager });
    // install() completes only after the background answered the seeded status
    // handshake, so the two markers below carry independent background and
    // content readiness to the page realm. WebDriver cannot evaluate scripts in
    // an extension realm, and a content-script sandbox is invisible to the
    // page, so readiness travels through the shared DOM instead.
    await adapter.install({ waitForSeed: true });
    if (root) {
      root.setAttribute('data-translate-it-replacement-background-ready', '1');
      root.setAttribute('data-translate-it-replacement-content-ready', '1');
      root.setAttribute('data-translate-it-replacement-flags', JSON.stringify(globalThis.__firefoxPageTranslationReplacementFlags ?? {}));
    }
    globalThis.__firefoxPageTranslationReplacementContent = adapter;
    await import('../../../src/core/content-scripts/index-main.js');
    if (config === globalThis.__firefoxPageTranslationReplacementConfig) startCaptureFinalWatcher(adapter);
    return adapter;
  } catch (error) {
    // Surface the real reason to the page realm so the runner can report it
    // instead of a generic readiness timeout.
    const message = String(error?.message ?? error).slice(0, 300);
    try { root?.setAttribute('data-translate-it-replacement-error', message); } catch { /* The document may be gone. */ }
    console.error('Phase 2B replacement content entry failed', error);
    throw error;
  }
}

// Bounded final-DOM reporting loop: the driver never reaches into the page
// realm, so the entry itself keeps offering capture-final until either the
// runner grants it (via the background broker) or the context is torn down.
function startCaptureFinalWatcher(adapter, { pollMs = 100 } = {}) {
  void (async () => {
    for (;;) {
      const snapshot = adapter.snapshot();
      if (snapshot.disposed || snapshot.lastError?.length) return;
      if (snapshot.cleanup?.reported && !snapshot.finalDOMReported) {
        try { await adapter.captureFinal({ timeoutMs: 60_000 }); return; }
        catch { /* Grant may not be ready yet; retry until the deadline. */ }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  })();
}

if (globalThis.__firefoxPageTranslationReplacementConfig) await startPageReplacementContent();

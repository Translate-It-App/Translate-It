import { BaseProvider } from '../../../../src/features/translation/providers/BaseProvider.js';
import { ProviderRequestEngine } from '../../../../src/features/translation/providers/utils/ProviderRequestEngine.js';
import { proxyManager } from '../../../../src/shared/proxy/ProxyManager.js';
import { createReplacementBackgroundAdapter, installReplacementWorkerObservers } from './runtime-replacement-background.mjs';

/**
 * Phase 2 browser-observation worker entry. The harness Vite build either
 * imports this module after injecting globalThis.__firefoxPageTranslationReplacementConfig
 * (virtual replacement entry) or invokes the exported start directly.
 * Required config: runId, authToken, fixtureUrl, expectedExtensionId,
 * expectedTabId (a safe integer, or null to pin the bootstrap tab from the
 * first real A sender), expectedDocumentId (null until the first real A
 * sender if not known at worker bootstrap). The adapter seeds the two actual
 * storage settings before importing/initializing production background services.
 */
export async function startPageReplacementWorker(config = globalThis.__firefoxPageTranslationReplacementConfig) {
  if (!config) throw new Error('Page replacement worker config was not injected by the future opt-in build.');
  const background = createReplacementBackgroundAdapter(config);
  await background.initialize();
  const observers = installReplacementWorkerObservers({ background, BaseProvider, ProviderRequestEngine, proxyManager });
  globalThis.__firefoxPageTranslationReplacement = background;
  globalThis.__firefoxPageTranslationReplacementWorkerObservers = observers;
  await import('../../../../src/core/background/index.js');
  return { background, observers };
}

if (globalThis.__firefoxPageTranslationReplacementConfig) await startPageReplacementWorker();

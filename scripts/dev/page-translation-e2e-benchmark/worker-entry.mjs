import '../../../src/core/background/index.js';
import { unifiedTranslationService } from '../../../src/core/services/translation/UnifiedTranslationService.js';
import { QueueManager } from '../../../src/features/translation/core/QueueManager.js';
import { RateLimitManager } from '../../../src/features/translation/core/RateLimitManager.js';
import { ProviderRequestEngine } from '../../../src/features/translation/providers/utils/ProviderRequestEngine.js';
import { MicrosoftEdgeProvider } from '../../../src/features/translation/providers/MicrosoftEdgeProvider.js';
import { makeTrace, installCallThrough, installTimedCallThrough } from './trace.mjs';

const trace = makeTrace('worker');
installCallThrough(unifiedTranslationService, 'handleTranslationRequest', function ([message]) {
  trace.record('background.translationRequest.entry', {
    action: message?.action ?? null,
    context: message?.context ?? null,
    sessionId: message?.data?.sessionId ?? null,
  });
});
installCallThrough(QueueManager.prototype, 'enqueue', function (args) {
  const [providerName, , priority, context] = args;
  trace.record('queueManager.enqueue', { providerName, priority, context });
});
installCallThrough(QueueManager.prototype, '_processItem', function ([item]) {
  trace.record('queueManager.processItem', { providerName: item?.providerName ?? null, context: item?.context ?? null });
});
installCallThrough(RateLimitManager.prototype, 'executeWithRateLimit', function (args) {
  const [providerName, , context, priority] = args;
  trace.record('rateLimitManager.executeWithRateLimit', { providerName, context, priority });
});
installTimedCallThrough(ProviderRequestEngine, 'executeApiCall', ([provider, options]) => {
  const startedAt = Date.now();
  trace.record('providerRequestEngine.executeApiCall.start', {
    providerName: provider?.providerName ?? provider?.name ?? null,
    method: options?.fetchOptions?.method ?? null,
    urlOrigin: (() => { try { return new URL(options?.url).origin; } catch { return null; } })(),
    bodyBytes: typeof options?.fetchOptions?.body === 'string' ? new TextEncoder().encode(options.fetchOptions.body).length : null,
  });
  return { startedAt };
}, (token, error) => {
  trace.record('providerRequestEngine.executeApiCall.end', { startedAt: token?.startedAt ?? null, failed: !!error, errorName: error?.name ?? null });
});
installTimedCallThrough(MicrosoftEdgeProvider.prototype, '_translateChunk', ([texts, , , , , , , chunkIndex, totalChunks]) => {
  const startedAt = Date.now();
  trace.record('microsoftEdgeProvider.translateChunk.start', { itemCount: Array.isArray(texts) ? texts.length : null, chunkIndex, totalChunks });
  return { startedAt };
}, (token, error) => {
  trace.record('microsoftEdgeProvider.translateChunk.end', { startedAt: token?.startedAt ?? null, failed: !!error, errorName: error?.name ?? null });
});

const marker = {
  startedAt: Date.now(),
  entry: 'src/core/background/index.js',
  unifiedTranslationService,
  trace,
  snapshot: () => trace.snapshot(),
};
globalThis.__pageTranslationBenchmark = marker;

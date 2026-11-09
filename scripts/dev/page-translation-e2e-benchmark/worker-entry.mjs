import '../../../src/core/background/index.js';
import { unifiedTranslationService } from '../../../src/core/services/translation/UnifiedTranslationService.js';
import { backgroundOperationLease } from '../../../src/core/services/translation/BackgroundOperationLease.js';
import { QueueManager, queueManager } from '../../../src/features/translation/core/QueueManager.js';
import { RateLimitManager, rateLimitManager } from '../../../src/features/translation/core/RateLimitManager.js';
import { ProviderRequestEngine } from '../../../src/features/translation/providers/utils/ProviderRequestEngine.js';
import { BaseProvider } from '../../../src/features/translation/providers/BaseProvider.js';
import { MicrosoftEdgeProvider } from '../../../src/features/translation/providers/MicrosoftEdgeProvider.js';
import { makeTrace, installCallThrough, installTimedCallThrough } from './trace.mjs';
import { createCancellationLedger, matchProviderPhysicalRoot } from './cancellation-probes.mjs';
import { observeControllerAbort } from '../page-translation-e2e-firefox/controller-abort-observer.mjs';

const trace = makeTrace('worker');
const cancellationLedger = createCancellationLedger();
const providerRoots = [];
const lifecycleControllers = new Map();
const controllerAbortObservers = new Map();
const cancellationInstrumentationErrors = [];
let cancellationProbeEnabled = false;
let cancellationInstrumentationReady = false;
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
    ...(cancellationProbeEnabled ? { sessionId: options?.sessionId ?? null } : {}),
  });
  const controllerMatch = options?.abortController
    ? [...lifecycleControllers.entries()].find(([, entry]) => entry.controller === options.abortController
      || entry.controller?.signal === options.abortController.signal)
    : null;
  const rootMessageId = controllerMatch?.[0] ?? matchProviderPhysicalRoot({
    url: options?.url,
    body: options?.fetchOptions?.body,
    sessionId: options?.sessionId,
    roots: providerRoots,
  });
  const operation = cancellationProbeEnabled
    ? cancellationLedger.begin('provider.physical', options?.sessionId ?? null, {
      messageId: rootMessageId,
      url: options?.url ?? null,
      method: options?.fetchOptions?.method ?? null,
      requestBody: typeof options?.fetchOptions?.body === 'string' ? options.fetchOptions.body : null,
      controllerAbortedAtStart: options?.abortController?.signal?.aborted ?? null,
    })
    : null;
  return { startedAt, operation, abortController: options?.abortController ?? null };
}, (token, error) => {
  trace.record('providerRequestEngine.executeApiCall.end', { startedAt: token?.startedAt ?? null, failed: !!error, errorName: error?.name ?? null });
  if (token?.operation) cancellationLedger.settle(token.operation, error ? 'rejected' : 'fulfilled', {
    errorName: error?.name ?? null,
    error: error?.message ?? null,
    operationAborted: error?.operationAborted === true,
    controllerAbortedAtEnd: token.abortController?.signal?.aborted ?? null,
  });
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
  enableCancellationProbe() {
    cancellationProbeEnabled = true;
    if (!cancellationInstrumentationReady) {
      cancellationInstrumentationReady = true;
      const originalTranslate = BaseProvider.prototype.translate;
      BaseProvider.prototype.translate = function (text, sourceLanguage, targetLanguage, options = {}) {
        const texts = Array.isArray(text) ? text.map(item => typeof item === 'string' ? item : item?.text) : [text];
        const operation = cancellationLedger.begin('provider.root', options?.sessionId ?? null, {
          messageId: options?.messageId ?? null,
          texts,
          controllerAbortedAtStart: options?.abortController?.signal?.aborted ?? null,
        });
        const root = { operation, messageId: options?.messageId ?? null, sessionId: options?.sessionId ?? null, controller: options?.abortController ?? null };
        providerRoots.push(root);
        let result;
        try { result = originalTranslate.call(this, text, sourceLanguage, targetLanguage, options); }
        catch (error) {
          cancellationLedger.settle(operation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error) });
          throw error;
        }
        if (!result || typeof result.then !== 'function') {
          cancellationInstrumentationErrors.push(`provider.translate for ${options?.messageId ?? 'unknown-message'} returned a non-Promise.`);
          cancellationLedger.record('instrumentation.promise-unavailable', options?.sessionId ?? null, {
            operation: 'provider.root', messageId: options?.messageId ?? null,
          });
          return result;
        }
        result.then(
          value => cancellationLedger.settle(operation, 'fulfilled', { resultSuccess: value?.success !== false, controllerAbortedAtEnd: options?.abortController?.signal?.aborted ?? null }),
          error => cancellationLedger.settle(operation, 'rejected', { errorName: error?.name ?? null, error: error?.message ?? null, operationAborted: error?.operationAborted === true, controllerAbortedAtEnd: options?.abortController?.signal?.aborted ?? null }),
        );
        return result;
      };

      const registry = unifiedTranslationService.translationEngine?.lifecycleRegistry;
      if (registry && typeof registry.registerRequest === 'function') {
        const originalRegister = registry.registerRequest;
        registry.registerRequest = function (messageId, ...args) {
          const controller = originalRegister.call(this, messageId, ...args);
          if (controller) {
            const context = args[1] ?? null;
            lifecycleControllers.set(messageId, { controller, context });
            const owner = providerRoots.find(root => root.messageId === messageId);
            const abortObserver = observeControllerAbort(controller, { messageId, sessionId: owner?.sessionId ?? null, context: null }, evidence => {
              cancellationLedger.record('controller.abort', evidence.sessionId, evidence);
            });
            if (abortObserver) controllerAbortObservers.set(messageId, abortObserver);
            else cancellationInstrumentationErrors.push(`Could not instrument AbortController.abort for ${messageId}.`);
            cancellationLedger.record('controller.register', providerRoots.find(root => root.messageId === messageId)?.sessionId ?? null, {
              messageId, context, alreadyAborted: controller.signal.aborted,
            });
          }
          return controller;
        };
      }

      const service = unifiedTranslationService;
      const originalCancelRequest = service.cancelRequest;
      if (typeof originalCancelRequest === 'function') {
        service.cancelRequest = function (messageId, ...args) {
          const root = [...providerRoots].reverse().find(candidate => candidate.messageId === messageId);
          const controller = lifecycleControllers.get(messageId)?.controller ?? this.translationEngine?.getAbortController?.(messageId) ?? null;
          const operation = cancellationLedger.begin('service.cancelRequest', root?.sessionId ?? null, {
            messageId, controllerMatched: !!controller, controllerAbortedBefore: controller?.signal?.aborted ?? null,
          });
          let abortObserver = controllerAbortObservers.get(messageId);
          if (!abortObserver && controller) {
            abortObserver = observeControllerAbort(controller, { messageId, sessionId: root?.sessionId ?? null }, evidence => {
              cancellationLedger.record('controller.abort', evidence.sessionId, evidence);
            });
            if (abortObserver) controllerAbortObservers.set(messageId, abortObserver);
          }
          abortObserver?.setOwner({ messageId, sessionId: root?.sessionId ?? null,
            context: globalThis.__firefoxPageTranslationStopMode === true ? 'page-translation-batch' : null,
            cancelRequestSequence: operation.sequence });
          let result;
          try { result = originalCancelRequest.call(this, messageId, ...args); }
          catch (error) {
            cancellationLedger.settle(operation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error) });
            throw error;
          }
          if (!result || typeof result.then !== 'function') {
            cancellationInstrumentationErrors.push(`UnifiedTranslationService.cancelRequest for ${messageId} returned a non-Promise.`);
            cancellationLedger.settle(operation, 'unsupported-non-promise', { controllerAbortedAfter: controller?.signal?.aborted ?? null });
            return result;
          }
          result.then(
            value => cancellationLedger.settle(operation, 'fulfilled', { response: value, controllerAbortedAfter: controller?.signal?.aborted ?? null }),
            error => cancellationLedger.settle(operation, 'rejected', { errorName: error?.name ?? 'Error', error: error?.message ?? String(error), controllerAbortedAfter: controller?.signal?.aborted ?? null }),
          );
          return result;
        };
      }
    }
    return {
      enabled: true,
      lifecycleRegistryObserved: !!unifiedTranslationService.translationEngine?.lifecycleRegistry,
      instrumentationErrors: [...cancellationInstrumentationErrors],
    };
  },
  cancellationSnapshot(sessionId) {
    const roots = providerRoots.filter(root => sessionId === undefined || root.sessionId === sessionId);
    return {
      sessionId,
      ledger: cancellationLedger.snapshot(sessionId),
      instrumentationErrors: [...cancellationInstrumentationErrors],
      providerRoots: roots.map(root => ({ messageId: root.messageId, sessionId: root.sessionId, texts: root.operation.texts, status: root.operation.status, controllerAborted: root.controller?.signal?.aborted ?? null, errorName: root.operation.errorName ?? null, error: root.operation.error ?? null, settledSequence: root.operation.settledSequence ?? null })),
      controllers: [...lifecycleControllers.entries()].map(([messageId, entry]) => ({
        messageId, context: entry.context, aborted: entry.controller.signal.aborted,
        sessionId: providerRoots.find(root => root.messageId === messageId)?.sessionId ?? null,
      })).filter(entry => sessionId === undefined || entry.sessionId === sessionId),
    };
  },
  resourceSnapshot(messageIds = [], sessionIds = []) {
    const engine = unifiedTranslationService.translationEngine;
    const registry = engine?.lifecycleRegistry;
    const tracker = unifiedTranslationService.requestTracker;
    const queueAvailable = queueManager?.queues instanceof Map && queueManager?.processing instanceof Map
      && queueManager?.retryTimeouts instanceof Map;
    const rateAvailable = rateLimitManager?.providerStates instanceof Map;
    const resolvers = unifiedTranslationService.modeCoordinator?.pageSourceResolvers;
    const leaseStatus = backgroundOperationLease.getStatus();
    const lease = leaseStatus ? {
      activeOperationIds: leaseStatus.activeOperationIds,
      activeOperationCount: leaseStatus.activeOperationCount,
      timerActive: leaseStatus.timerActive,
    } : null;
    return {
      available: !!registry && registry.activeTranslations instanceof Map && tracker?.requests instanceof Map
        && queueAvailable && rateAvailable && resolvers instanceof Map && !!lease,
      lifecycle: {
        activeIds: registry?.activeTranslations instanceof Map ? [...registry.activeTranslations.keys()] : null,
      },
      service: {
        activeRequestIds: tracker?.requests instanceof Map
          ? [...tracker.requests.values()].filter(request => ['pending', 'processing', 'streaming'].includes(request.status)).map(request => request.messageId)
          : null,
        requests: tracker?.requests instanceof Map
          ? messageIds.map(messageId => {
            const request = tracker.requests.get(messageId);
            return { messageId, status: request?.status ?? null, operationOwned: !!request && unifiedTranslationService._getOperation(request) !== null };
          }) : null,
      },
      sourceResolvers: resolvers instanceof Map
        ? Object.fromEntries(sessionIds.map(sessionId => {
          const state = resolvers.get(sessionId);
          return [sessionId, state ? {
            present: true,
            effectiveSourceLanguage: state.effectiveSourceLanguage ?? null,
            effectiveTargetLanguage: state.effectiveTargetLanguage ?? null,
            status: state.status ?? null,
          } : { present: false }];
        })) : null,
      queue: queueAvailable ? {
        depths: Object.fromEntries([...queueManager.queues].map(([provider, queue]) => [provider, Array.isArray(queue) ? queue.length : null])),
        processing: Object.fromEntries([...queueManager.processing]),
        retryTimeoutCount: queueManager.retryTimeouts.size,
      } : null,
      rateLimit: rateAvailable
        ? Object.fromEntries([...rateLimitManager.providerStates].map(([provider, state]) => [provider, {
          activeRequests: state.activeRequests ?? null,
          queuedRequests: state.queues && typeof state.queues === 'object'
            ? Object.values(state.queues).reduce((count, queue) => count + (Array.isArray(queue) ? queue.length : 0), 0)
            : null,
          isProcessingQueue: state.isProcessingQueue ?? null,
        }]))
        : null,
      lease,
    };
  },
  snapshot: () => trace.snapshot(),
};
if (globalThis.__firefoxProviderProbeEnabled === true) {
  const providerProbeRuntime = globalThis.__firefoxProviderProbeRuntime;
  if (providerProbeRuntime) {
    const providerProbe = providerProbeRuntime.createEdgeProviderProbe(providerProbeRuntime.report);
    marker.providerProbe = providerProbe;
    marker.invokeProviderOnly = (texts, ids) => providerProbe.invokeProviderOnly(MicrosoftEdgeProvider, texts, ids);
    marker.providerProbeInstalled = providerProbe.install({ MicrosoftEdgeProvider, unifiedTranslationService, ProviderRequestEngine, proxyManager: providerProbeRuntime.proxyManager });
  }
}
globalThis.__pageTranslationBenchmark = marker;

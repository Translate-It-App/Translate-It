/**
 * Unified Mode Coordinator - Manages mode-specific translation behaviors
 * Coordinates between the Unified Service and the Translation Engine for different UI modes.
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { TranslationMode } from '@/shared/config/config.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageFormat } from '@/shared/messaging/core/MessagingCore.js';
import { RequestStatus } from './TranslationRequestTracker.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { AUTO_DETECT_VALUE } from '@/shared/constants/core.js';
import { TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS } from '@/shared/constants/translation.js';
import { appendTranslationDiagnostic } from '@/features/translation/ir/TranslationOperation.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'UnifiedModeCoordinator');

function createBatchAbortError(signal) {
  const error = new Error('Batch translation aborted');
  error.name = 'AbortError';
  if (['user-cancelled', 'user_cancelled'].includes(signal?.reason)) {
    error.type = ErrorTypes.USER_CANCELLED;
  } else {
    error.operationAborted = true;
    error.cancellationReason = typeof signal?.reason === 'string' && signal.reason && signal.reason !== 'timeout'
      ? signal.reason : 'operation-abort';
  }
  return error;
}

export class UnifiedModeCoordinator {
  constructor() {
    // sessionId -> per-session semantic-pair resolution state for Page 'auto' batches.
    // Exactly one batch owns resolution per session; concurrent batches await it.
    // Entries are cleared on session terminal lifecycle (complete/cancel/error).
    this.pageSourceResolvers = new Map();
  }

  /**
   * Process a translation request based on its mode.
   * 
   * @param {object} request - The request record from Tracker
   * @param {object} deps - { translationEngine, backgroundService }
   */
  async processRequest(request, { translationEngine, executionContext }) {
    const { mode } = request;
    request.status = RequestStatus.PROCESSING;
    request.data.priority = await this._resolvePriority(mode);

    switch (mode) {
      case TranslationMode.Field:
        return await this.processFieldTranslation(request, { translationEngine, executionContext });
      case TranslationMode.Page:
        return await this.processPageTranslation(request, { translationEngine, executionContext });
      case TranslationMode.PDF:
        return await this.processPdfTranslation(request, { translationEngine, executionContext });
      case TranslationMode.Subtitle:
        return await this.processSubtitleTranslation(request, { translationEngine, executionContext });
      case TranslationMode.Select_Element:
        return await this.processSelectElementTranslation(request, { translationEngine, executionContext });
      default:
        return await this.processStandardTranslation(request, { translationEngine, executionContext });
    }
  }

  /**
   * Resolve translation priority based on UI mode.
   * @private
   */
  async _resolvePriority(mode) {
    const { TranslationPriority } = await import('@/features/translation/core/RateLimitManager.js');
    
    // Mapping priorities to modes
    const highPriorityModes = new Set([
      TranslationMode.Field, TranslationMode.Selection, TranslationMode.Dictionary_Translation,
      TranslationMode.Popup_Translate, TranslationMode.Sidepanel_Translate, TranslationMode.Mobile_Translate,
    ]);
    
    if (highPriorityModes.has(mode)) {
      return TranslationPriority.HIGH;
    }
    
    if ([TranslationMode.Page, TranslationMode.Select_Element, TranslationMode.PDF].includes(mode)) {
      return TranslationPriority.LOW;
    }

    return TranslationPriority.NORMAL;
  }

  /**
   * Specialized handler for Whole Page Translation (Batch processing).
   * Now simplified to delegate orchestration to ProviderCoordinator.
   */
  async processPageTranslation(request, deps) {
    const { data } = request;
    
    // Explicitly check for missing text to match legacy error message
    if (!data.text) {
      throw new Error('No text provided for translation');
    }

    const items = typeof data.text === 'string' ? JSON.parse(data.text) : data.text;
    
    const result = await this._processGenericBatch(request, deps, {
      mode: TranslationMode.Page,
      items,
      useRawItems: false, // Page mode expects array of strings for traditional providers
      transformOutput: (results) => ({
        success: true,
        translatedText: JSON.stringify(results),
        actualCharCount: results.reduce((sum, r) => sum + (r.text?.length || 0), 0),
        originalCharCount: items.reduce((sum, i) => sum + (i.text?.length || i.length || 0), 0),
        error: null
      }),
      handleError: async (error, items) => {
        const { isFatalError, matchErrorToType } = await import('@/shared/error-management/ErrorMatcher.js');
        const errorType = error?.type || matchErrorToType(error);
        const classificationError = error && typeof error === 'object'
          ? { type: errorType, statusCode: error.statusCode }
          : errorType;
        const fallbackResults = items.map(item => ({ text: item.text || item }));
        return {
          success: false,
          translatedText: JSON.stringify(fallbackResults),
          actualCharCount: 0,
          originalCharCount: items.reduce((sum, i) => sum + (i.text?.length || i.length || 0), 0),
          hasError: true,
          error: error.message,
          errorDetails: MessageFormat.serializeTranslationError(error, { type: errorType }),
          errorType,
          isFatal: isFatalError(classificationError)
        };
      }
    });

    return result;
  }

  /**
   * Handler for Text Field (Input) translations.
   */
  async processFieldTranslation(request, { translationEngine, executionContext }) {
    const messageForEngine = {
      action: MessageActions.TRANSLATE,
      messageId: request.messageId,
      context: request.context || 'content', 
      data: { ...request.data, mode: TranslationMode.Field, enableDictionary: false }
    };
    return executionContext
      ? await translationEngine.handleTranslateMessage(messageForEngine, request.sender, executionContext)
      : await translationEngine.handleTranslateMessage(messageForEngine, request.sender);
  }

  /**
   * Handler for Select Element translations.
   */
  async processSelectElementTranslation(request, { translationEngine, executionContext }) {
    const enhancedData = {
      ...request.data,
      enableDictionary: false,
      options: { ...request.data.options, forceStreaming: true, enableDictionary: false }
    };
    const message = {
      action: MessageActions.TRANSLATE,
      messageId: request.messageId,
      context: request.context || 'content', 
      data: enhancedData
    };
    return executionContext
      ? await translationEngine.handleTranslateMessage(message, request.sender, executionContext)
      : await translationEngine.handleTranslateMessage(message, request.sender);
  }

  /**
   * Handler for PDF translation batches.
   */
  async processPdfTranslation(request, { translationEngine, executionContext }) {
    const enhancedData = {
      ...request.data,
      mode: TranslationMode.PDF,
      enableDictionary: false,
      options: {
        ...request.data.options,
        rawJsonPayload: true,
        pdfTranslation: true,
        enableDictionary: false
      }
    };

    const message = {
      action: MessageActions.TRANSLATE,
      messageId: request.messageId,
      context: request.context || 'pdf-translation',
      data: enhancedData
    };
    return executionContext
      ? await translationEngine.handleTranslateMessage(message, request.sender, executionContext)
      : await translationEngine.handleTranslateMessage(message, request.sender);
  }

  /**
   * Default handler for standard translations (Selection, Popup, etc.).
   */
  async processStandardTranslation(request, { translationEngine, executionContext }) {
    const message = {
      action: MessageActions.TRANSLATE,
      messageId: request.messageId,
      context: request.context || 'content',
      data: request.data
    };
    return executionContext
      ? await translationEngine.handleTranslateMessage(message, request.sender, executionContext)
      : await translationEngine.handleTranslateMessage(message, request.sender);
  }

  /**
   * Specialized handler for Subtitle Translation (Batch processing).
   * Similar to Page translation but optimized for Subtitle cues.
   */
  async processSubtitleTranslation(request, deps) {
    return await this._processGenericBatch(request, deps, {
      mode: TranslationMode.Subtitle,
      items: request.data.items,
      useRawItems: true, // Subtitles need IDs and context for AI providers
      transformOutput: (results, totalChars) => ({
        success: true,
        results, // SubtitleCoordinator expects 'results'
        actualCharCount: totalChars,
        originalCharCount: totalChars
      })
    });
  }

  /**
   * Acquire the semantic-pair resolution slot for a Page 'auto' batch session.
   *
   * Concurrency contract:
   *   - No pair yet and no pending resolution -> this batch becomes the
   *     owner and is the ONLY one allowed to invoke the provider with 'auto'.
   *   - Semantic pair already resolved -> return it directly.
   *   - Resolution in flight        -> return the promise to await instead of
   *     issuing a duplicate 'auto' provider call.
   *
   * @param {string} sessionId - Page translation session identifier
   * @returns {object} { state|null, isOwner, effectiveSourceLanguage, effectiveTargetLanguage|resolutionPromise }
   * @private
   */
  _acquirePageSourceResolution(sessionId) {
    let state = this.pageSourceResolvers.get(sessionId);

    if (!state) {
      state = {
        effectiveSourceLanguage: null,
        effectiveTargetLanguage: null,
        resolutionPromise: null,
        _resolveSource: null,
        _rejectSource: null
      };
      this.pageSourceResolvers.set(sessionId, state);
    }

    if (state.effectiveSourceLanguage && state.effectiveTargetLanguage) {
      return {
        effectiveSourceLanguage: state.effectiveSourceLanguage,
        effectiveTargetLanguage: state.effectiveTargetLanguage
      };
    }
    if (state.resolutionPromise) {
      return { state, resolutionPromise: state.resolutionPromise };
    }

    state.resolutionPromise = new Promise((resolve, reject) => {
      state._resolveSource = resolve;
      state._rejectSource = reject;
    });
    // Swallow unobserved rejections (owner cleared before any waiter joined);
    // awaiting consumers still observe the rejection via their own subscription.
    state.resolutionPromise.catch(() => {});
    return { state, isOwner: true };
  }

  /**
   * Owner batch finalizes the session pair from the effective languages carried
   * by its own ProviderCoordinator response. A clear that already
   * removed the session (cancellation/restore) prevents a late owner success
   * from repopulating the lock.
   *
   * @param {string} sessionId
   * @param {object} resolution - The { state } tuple handed to the owner
   * @param {object} response - ProviderCoordinator response with effective pair
   * @private
   */
  _finalizePageSourceResolution(sessionId, resolution, response) {
    if (!resolution?.state) return;
    const state = resolution.state;

    // Late owner completion after a clear must not recreate removed state.
    if (this.pageSourceResolvers.get(sessionId) !== state) return;

    const effectiveSourceLanguage = response?.sourceLanguage;
    const effectiveTargetLanguage = response?.targetLanguage;
    const hasConcretePair = typeof effectiveSourceLanguage === 'string'
      && effectiveSourceLanguage.trim() !== ''
      && effectiveSourceLanguage !== AUTO_DETECT_VALUE
      && typeof effectiveTargetLanguage === 'string'
      && effectiveTargetLanguage.trim() !== ''
      && effectiveTargetLanguage !== AUTO_DETECT_VALUE;

    if (hasConcretePair) {
      state.effectiveSourceLanguage = effectiveSourceLanguage;
      state.effectiveTargetLanguage = effectiveTargetLanguage;
      if (state._resolveSource) {
        state._resolveSource({ effectiveSourceLanguage, effectiveTargetLanguage });
      }
    } else {
      // Success without a concrete pair consumes this batch; a waiting batch becomes the next owner.
      state.resolutionPromise = null;
      if (state._resolveSource) state._resolveSource(null);
    }

    state._resolveSource = null;
    state._rejectSource = null;
  }

  /**
   * Owner batch failed: reject all waiters, clear the slot, and allow a fresh
   * resolution attempt by the next batch. Preserves underlying batch failure
   * semantics (the error propagates to concurrent waiters as a rejection).
   *
   * @param {string} sessionId
   * @param {object} resolution - The { state , isOwner } tuple returned to the owner
   * @param {*} error - The failure that terminated the owner batch
   * @private
   */
  _failPageSourceResolution(sessionId, resolution, error) {
    if (!resolution?.state) return;
    const state = resolution.state;
    if (this.pageSourceResolvers.get(sessionId) !== state) return;

    this.pageSourceResolvers.delete(sessionId);
    if (state._rejectSource) state._rejectSource(error);
    state._resolveSource = null;
    state._rejectSource = null;
  }

  /**
   * Force-clear a session's source-resolution state (terminal lifecycle).
   * Pending waiters are released so they never hang on a promise that will
   * never resolve. Safe to call from completion, cancellation, and error paths.
   *
   * @param {string} sessionId
   */
  clearPageSourceLanguage(sessionId) {
    if (!sessionId) return;
    const state = this.pageSourceResolvers.get(sessionId);
    if (!state) return;

    this.pageSourceResolvers.delete(sessionId);
    if (state._rejectSource) {
      const error = new Error(`Page translation session ended: ${sessionId}`);
      error.type = ErrorTypes.USER_CANCELLED;
      state._rejectSource(error);
    }
    state._resolveSource = null;
    state._rejectSource = null;
  }

  /**
   * Generic handler for batch translation operations (Page, Subtitle).
   * Implements common logic for lifecycle management, character counting, and provider coordination.
   * 
   * @private
   */
  async _processGenericBatch(request, { translationEngine, executionContext }, options) {
    const { messageId, data } = request;
    const { provider, priority, promptTemplate, instruction } = data;
    const { mode, items, transformOutput, handleError, useRawItems = false } = options;
    
    const sourceLanguage = data.sourceLanguage || data.sourceLang || 'auto';
    let targetLanguage = data.targetLanguage || data.targetLang;

    // Validate that items is an array.
    if (!items || !Array.isArray(items)) {
      throw new Error(`No items provided for ${mode} translation`);
    }

    // Empty batches are valid terminal successes and require no runtime resources.
    if (items.length === 0) {
      if (transformOutput) return transformOutput([], 0);
      return { success: true, results: [], actualCharCount: 0, originalCharCount: 0 };
    }
    
    const totalOriginalChars = items.reduce((sum, item) => {
      const text = typeof item === 'string' ? item : (item.text || '');
      return sum + (text?.length || 0);
    }, 0);

    const sampleText = (items[0]?.text || items[0] || '').substring(0, 100);
    const abortController = translationEngine.lifecycleRegistry.registerRequest(messageId, sampleText, mode.toLowerCase());
    if (!abortController) {
      const cancellationReason = translationEngine.lifecycleRegistry.getCancellationReason?.(messageId)
        || 'operation-abort';
      const isUserCancellation = cancellationReason === 'user-cancelled';
      return {
        success: false,
        cancelled: true,
        error: isUserCancellation
          ? { type: ErrorTypes.USER_CANCELLED, message: 'Translation cancelled before execution' }
          : {
              operationAborted: true,
              cancellationReason,
              message: 'Translation operation aborted before execution',
            }
      };
    }

    const providerInstance = await translationEngine.getProvider(provider);
    if (!providerInstance) throw new Error(`Provider '${provider}' initialization failed`);

    let timeoutId;
    let onAbort;
    let sessionId = null;
    let sourceResolution = null;

    try {
      sessionId = request.sessionId || data.sessionId || messageId;
      if (abortController.signal.aborted) throw createBatchAbortError(abortController.signal);

      // One deadline covers source-resolution waiting and the provider call, including handoffs.
      const BATCH_TIMEOUT_MS = TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS;
      const terminalPromise = new Promise((_, reject) => {
        onAbort = () => {
          clearTimeout(timeoutId);
          reject(createBatchAbortError(abortController.signal));
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(`Batch translation timed out after ${BATCH_TIMEOUT_MS}ms`);
          timeoutError.type = ErrorTypes.TRANSLATION_TIMEOUT;
          appendTranslationDiagnostic(executionContext, {
            type: 'BATCH_TIMEOUT',
            stage: 'mode-coordinator',
            reason: timeoutError.message,
            code: timeoutError.type,
          });
          reject(timeoutError);
          abortController.abort('timeout');
        }, BATCH_TIMEOUT_MS);
      });

      // Per-session semantic-pair resolution for auto-detected Page batches.
      // Concurrency-safe: only the ownership batch issues a provider call with
      // 'auto'; concurrent batches await the session's resolution instead of
      // launching duplicate 'auto' requests (which surfaced transient detections
      // like 'it'/'sv' failing sibling batches mid-session). The authoritative
      // pair is taken from the request's own ProviderCoordinator response.
      let effectiveSourceLanguage = sourceLanguage;

      if (mode === TranslationMode.Page && sourceLanguage === AUTO_DETECT_VALUE) {
        while (true) {
          if (abortController.signal.aborted) throw createBatchAbortError(abortController.signal);
          sourceResolution = this._acquirePageSourceResolution(sessionId);
          if (sourceResolution.isOwner) break;
          const resolvedPair = sourceResolution.effectiveSourceLanguage
            ? sourceResolution
            : await Promise.race([sourceResolution.resolutionPromise, terminalPromise]);
          if (sourceResolution.state && this.pageSourceResolvers.get(sessionId) !== sourceResolution.state) {
            const error = new Error(`Page translation session ended: ${sessionId}`);
            error.type = ErrorTypes.USER_CANCELLED;
            throw error;
          }
          if (resolvedPair) {
            effectiveSourceLanguage = resolvedPair.effectiveSourceLanguage;
            targetLanguage = resolvedPair.effectiveTargetLanguage;
            break;
          }
          // Each handoff consumes one successful batch, never re-sends the former owner.
        }
      }

      logger.debug(`[UnifiedCoordinator] ${mode} batch source: ${effectiveSourceLanguage}`);

      // A Page waiter/established batch has a canonical session-resolved pair.
      // Pass languagePairResolved so ProviderCoordinator skips the semantic
      // swap/detection that the session owner already performed. The owner (and
      // every non-Page batch, e.g. Subtitle per-batch AUTO) stays unresolved.
      const languagePairResolved = mode === TranslationMode.Page
        && sourceLanguage === AUTO_DETECT_VALUE
        && sourceResolution !== null
        && sourceResolution.isOwner !== true;

      // Determine what to pass to the provider
      const translationPayload = useRawItems 
        ? items 
        : items.map(item => (typeof item === 'string' ? item : item.text) || '');

      if (abortController.signal.aborted) throw createBatchAbortError(abortController.signal);
      const response = await Promise.race([
        providerInstance.translate(translationPayload, effectiveSourceLanguage, targetLanguage, {
          mode,
          abortController,
          messageId,
          sessionId,
          priority,
          promptTemplate,
            instruction,
            rawJsonPayload: true,
            executionContext,
            // Page batches have no conversation-history dependency; the shared AI limiter owns HTTP capacity.
            ...(mode === TranslationMode.Page && providerInstance.constructor.isAI && { parallelExecution: true }),
            ...(languagePairResolved && { languagePairResolved: true }),
        }),
        terminalPromise
      ]);

      // Resolution owner finalizes the session pair from the effective
      // source/target returned by ProviderCoordinator.
      if (sourceResolution?.isOwner) {
        this._finalizePageSourceResolution(sessionId, sourceResolution, response);
        sourceResolution = null;
      }

      const translatedSegments = (response && typeof response === 'object' && response.translatedText !== undefined) 
        ? response.translatedText 
        : response;

      const resultsArray = Array.isArray(translatedSegments) ? translatedSegments : [translatedSegments];
      
      const finalResults = items.map((item, idx) => {
        const translated = resultsArray[idx];
        const isMissingResult = translated === undefined;
        const translatedText = !isMissingResult
          ? (typeof translated === 'object' ? translated.text : translated)
          : (typeof item === 'string' ? item : item.text);

        if (typeof item === 'string') {
          return { text: translatedText, ...(isMissingResult ? { isSkipped: true } : {}) };
        }

        // Results carry an explicit unresolved marker so
        // downstream consumers never mistake the source fallback for real output.
        return { ...item, text: translatedText, ...(isMissingResult ? { isSkipped: true } : {}) };
      });

      if (transformOutput) {
        return transformOutput(finalResults, totalOriginalChars);
      }

      return {
        success: true,
        results: finalResults,
        actualCharCount: totalOriginalChars,
        originalCharCount: totalOriginalChars
      };
    } catch (error) {
      // Resolution owner batch failed: reject concurrent waiters and clear the
      // session slot so a later batch may establish a fresh resolver.
      if (sourceResolution?.isOwner) {
        this._failPageSourceResolution(sessionId, sourceResolution, error);
      }
      if (error?.operationAborted === true) {
        logger.debug(`[UnifiedCoordinator] ${mode} batch stopped: operation abort`);
        return {
          success: false,
          suppressed: true,
          messageId
        };
      }
      if (handleError) {
        return await handleError(error, items);
      }
      logger.error(`[UnifiedCoordinator] ${mode} batch failed:`, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (onAbort) abortController.signal.removeEventListener('abort', onAbort);
      translationEngine.lifecycleRegistry.unregisterRequest(messageId);
    }
  }
}

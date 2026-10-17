// src/managers/content/windows/translation/TranslationHandler.js

import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { WindowsConfig } from "../core/WindowsConfig.js";
import { generateTranslationMessageId } from "@/utils/messaging/messageId.js";
import { TranslationMode } from "@/shared/config/config.js";
import { ProviderRegistryIds } from "@/features/translation/providers/ProviderConstants.js";
import { settingsManager } from '@/shared/managers/SettingsManager.js';
import { AUTO_DETECT_VALUE } from "@/shared/constants/core.js";
import { MessageActions } from "@/shared/messaging/core/MessageActions.js";
import { reconstructTranslationError, isStructuredTranslationError } from "@/shared/messaging/core/MessagingCore.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import ExtensionContextManager from "@/core/extensionContext.js";
import { registerTranslation, sendUnifiedTranslation } from "@/shared/messaging/core/ContentScriptIntegration.js";
import { WindowsManagerEvents } from "@/core/PageEventBus.js";

/**
 * Handles translation requests and responses for WindowsManager
 */
export class TranslationHandler {
  constructor() {
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'TranslationHandler');
    this.activeRequests = new Map();
  }

  /**
   * Get the provider that would be used for a given text
   * @param {string} selectedText 
   * @param {object} options 
   * @returns {string}
   */
  getEffectiveProvider(selectedText, options = {}) {
    const settings = {
      TRANSLATION_API: settingsManager.get('TRANSLATION_API', ProviderRegistryIds.GOOGLE_V2),
      MODE_PROVIDERS: settingsManager.get('MODE_PROVIDERS', {}),
      ENABLE_DICTIONARY: settingsManager.get('ENABLE_DICTIONARY', true)
    };

    let translationMode = options.mode || TranslationMode.Selection;
    let modeSpecificProvider = settings.MODE_PROVIDERS?.[translationMode];

    return options.provider || modeSpecificProvider || settings.TRANSLATION_API || ProviderRegistryIds.GOOGLE_V2;
  }

  /**
   * Perform translation request
   */
  async performTranslation(selectedText, options = {}) {
    const { isCurrent, ...translationOptions } = options;
    // 1. Character Limit Validation
    const selectionMaxChars = settingsManager.get('SELECTION_MAX_CHARS', 5000);
    if (selectedText && selectedText.length > selectionMaxChars) {
      this.logger.debug(`Text too long for selection translation: ${selectedText.length} > ${selectionMaxChars}`);
      const error = new Error(`Text too long (${selectedText.length.toLocaleString()} chars). Max allowed for selection is ${selectionMaxChars.toLocaleString()} chars.`);
      error.type = ErrorTypes.TEXT_TOO_LONG;
      
      // Throw the error so the caller (WindowsManager) can catch it and show it in the UI
      throw error;
    }

    let settings;

    settings = {
        SOURCE_LANGUAGE: settingsManager.get('SOURCE_LANGUAGE', 'auto'),
        TARGET_LANGUAGE: settingsManager.get('TARGET_LANGUAGE', 'fa'),
        TRANSLATION_API: settingsManager.get('TRANSLATION_API', ProviderRegistryIds.GOOGLE_V2),
        MODE_PROVIDERS: settingsManager.get('MODE_PROVIDERS', {}),
        ENABLE_DICTIONARY: settingsManager.get('ENABLE_DICTIONARY', true)
      };

      // Determine translation mode
      let translationMode = options.mode || TranslationMode.Selection;
      let modeSpecificProvider = settings.MODE_PROVIDERS?.[translationMode];
      
      const finalProvider = options.provider || modeSpecificProvider || settings.TRANSLATION_API || ProviderRegistryIds.GOOGLE_V2;
      const isExplicitProvider = !!options.provider;

      // Generate unique messageId
      const messageId = generateTranslationMessageId('content');
      this.logger.debug(`Generated messageId: ${messageId}`);

      const isAIContextEnabled = settingsManager.get('AI_CONTEXT_TRANSLATION_ENABLED', true);

      // Prepare payload
      const payload = {
        text: selectedText,
        from: AUTO_DETECT_VALUE,
        to: settings.TARGET_LANGUAGE || 'fa',
        provider: finalProvider,
        isExplicitProvider: isExplicitProvider,
        messageId: messageId,
        mode: translationMode,
        contextMetadata: isAIContextEnabled ? { pageTitle: document.title } : null,
        options: translationOptions
      };

      this.logger.debug("Sending translation request", payload);

      // Track accumulated streaming results
      const accumulatedResults = new Map();
      const windowId = options.windowId;
      const isRequestCurrent = () => !isCurrent || isCurrent();
      let requestFinished = false;
      const requestInfo = { cancelled: false, settled: false };

      // Register for streaming and result updates via Unified System
      const resultPromise = new Promise((resolve, reject) => {
        registerTranslation(messageId, {
          onStreamUpdate: (data) => {
            if (requestFinished || !isRequestCurrent() || !this.activeRequests.has(messageId)) return;
            if (data.data) {
              const batchText = Array.isArray(data.data) ? data.data.join('') : String(data.data);
              
              // Store by batch index to handle ordering and duplicates correctly
              const index = typeof data.batchIndex === 'number' ? data.batchIndex : accumulatedResults.size;
              accumulatedResults.set(index, batchText);
              
              const partialText = Array.from(accumulatedResults.keys())
                .sort((a, b) => a - b)
                .map(i => accumulatedResults.get(i))
                .join('');
              
              // Progressive UI update for streaming
              if (windowId) {
                WindowsManagerEvents.updateWindow(windowId, {
                  translatedText: partialText,
                  initialTranslatedText: partialText,
                  isStreaming: true,
                  isLoading: false,
                  initialSize: 'normal',
                  frameId: ExtensionContextManager.isContentScript() ? null : options.frameId // Pass frameId if available
                });
              }
            }
          },
          onStreamEnd: (data) => {
            if (requestFinished || !isRequestCurrent() || !this.activeRequests.has(messageId)) return;
            if (!data.success) {
              requestFinished = true;
              const errorSource = isStructuredTranslationError(data?.errorDetails)
                ? data.errorDetails
                : (data.error || 'Streaming failed');
              reject(reconstructTranslationError(errorSource));
              return;
            }
            
            // Reconstruct final text from all batches in order
            const sortedIndices = Array.from(accumulatedResults.keys()).sort((a, b) => a - b);
            const finalText = sortedIndices.map(i => accumulatedResults.get(i)).join('');

            // Resolve with accumulated text
            requestFinished = true;
            resolve({
              translatedText: finalText,
              sourceLanguage: data.sourceLanguage || data.detectedSourceLanguage,
              targetLanguage: data.targetLanguage,
              provider: data.provider,
              mode: data.mode,
              success: true
            });
          },
          onTranslationResult: (data) => {
            if (requestFinished || !isRequestCurrent() || !this.activeRequests.has(messageId)) return;
            // Handle result (direct or final streaming result)
            // If we have translatedText, we can resolve even if marked as streaming (fallback for coordinator results)
            if (data.success && (data.translatedText || !data.streaming)) {
              requestFinished = true;
              resolve(data);
            } else if (!data.success) {
              requestFinished = true;
              const errorSource = isStructuredTranslationError(data?.errorDetails)
                ? data.errorDetails
                : (data.error || 'Translation failed');
              reject(reconstructTranslationError(errorSource));
            }
          },
          onError: (error) => {
            if (requestFinished || !isRequestCurrent() || !this.activeRequests.has(messageId)) return;
            requestFinished = true;
            reject(error);
          }
        });

        // Set safety timeout for the coordination phase
        const timeout = setTimeout(() => {
          if (this.activeRequests.has(messageId)) {
            requestInfo.settled = true;
            const timeoutError = new Error('Translation timeout');
            timeoutError.type = ErrorTypes.TRANSLATION_TIMEOUT;
            import("@/shared/messaging/core/ContentScriptIntegration.js").then(m => {
              m.cancelTranslation(messageId, 'Translation timed out', true);
            }).catch(() => {});
            this._cleanupRequest(messageId);
            reject(timeoutError);
          }
        }, WindowsConfig.TIMEOUTS.TRANSLATION_TIMEOUT);

        Object.assign(requestInfo, { resolve, reject, timeout, startTime: Date.now() });
        this.activeRequests.set(messageId, requestInfo);
      });

      // CRITICAL: Attach a silent catch handler to avoid "Uncaught (in promise)" 
      // when timeout occurs while coordination is still pending.
      resultPromise.catch(err => {
        this.logger.debug("resultPromise rejected before await:", err.message);
      });

      try {
        // Send via unified translation system
        const response = await sendUnifiedTranslation({
          action: MessageActions.TRANSLATE,
          context: 'content',
          messageId: messageId,
          data: {
            text: payload.text,
            provider: payload.provider,
            isExplicitProvider: payload.isExplicitProvider,
            sourceLanguage: payload.from,
            targetLanguage: payload.to,
            mode: payload.mode,
            contextMetadata: payload.contextMetadata,
            options: payload.options
          }
        });

        this.logger.debug("sendUnifiedTranslation response:", response);

        if (!isRequestCurrent() || requestInfo.cancelled) {
          this._cleanupRequest(messageId);
          return { cancelled: true };
        }
        if (!this.activeRequests.has(messageId)) {
          if (!requestInfo.settled) return { cancelled: true };
          const settledResult = await resultPromise;
          return {
            ...settledResult,
            provider: settledResult.provider || payload.provider,
            mode: settledResult.mode || payload.mode,
          };
        }

        // If it's already finished (direct result), return it
        if (response && response.success && response.translatedText && !response.streaming) {
          requestFinished = true;
          this.logger.operation("Translation completed successfully (direct result)");
          this._cleanupRequest(messageId);
          return {
            translatedText: response.translatedText,
            sourceLanguage: response.sourceLanguage || response.detectedSourceLanguage || payload.from,
            targetLanguage: response.targetLanguage || payload.to,
            provider: response.provider || payload.provider,
            mode: response.mode || payload.mode
          };
        }

        // Wait for streaming completion or final result message
        const finalResult = await resultPromise;
        this.logger.operation("Translation completed successfully (unified)");
        this._cleanupRequest(messageId);
        
        return {
          ...finalResult,
          provider: finalResult.provider || payload.provider,
          mode: finalResult.mode || payload.mode
        };

      } catch (error) {
        this.logger.info("Translation process failed:", error.message);
        this._cleanupRequest(messageId);
        throw error;
      }
  }

  /**
   * Helper to clean up an active request
   * @private
   */
  _cleanupRequest(messageId) {
    const request = this.activeRequests.get(messageId);
    if (request) {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      this.activeRequests.delete(messageId);
      this.logger.debug(`Cleaned up request: ${messageId}`);
    }
  }

  /**
   * Cancel active translation request
   */
  cancelTranslation(messageId, reason = 'User cancelled') {
    const request = this.activeRequests.get(messageId);
    if (!request) return;

    this._cleanupRequest(messageId);
    request.cancelled = true;
    
    // Notify unified system to cancel
    import("@/shared/messaging/core/ContentScriptIntegration.js").then(m => {
      m.cancelTranslation(messageId, reason);
    }).catch(() => {});

    request.resolve({ cancelled: true });
    this.logger.debug('Translation cancelled', { messageId });
  }

  /**
   * Handle translation result from central message handler
   * Fallback for direct result updates if unified stream fails
   */
  handleTranslationResult(message) {
    const { messageId } = message;
    const request = this.activeRequests.get(messageId);

    if (!request) return false;

    const errorSource = isStructuredTranslationError(message.data?.errorDetails)
      ? message.data.errorDetails
      : message.data?.error;

    if (errorSource) {
      request.settled = true;
      request.reject(reconstructTranslationError(errorSource));
      this._cleanupRequest(messageId);
      return true;
    } else if (message.data?.translatedText) {
      request.settled = true;
      request.resolve({
        translatedText: message.data.translatedText,
        sourceLanguage: message.data.sourceLanguage || message.data.detectedSourceLanguage,
        targetLanguage: message.data.targetLanguage,
        provider: message.data.provider,
        mode: message.data.mode
      });
      this._cleanupRequest(messageId);
      return true;
    }
    return false;
  }

  /**
   * Cancel all active translations
   */
  cancelAllTranslations() {
    for (const [messageId] of this.activeRequests) {
      this.cancelTranslation(messageId, 'lifecycle-cleanup');
    }
    this.logger.debug('All translations cancelled');
  }

  /**
   * Get active request count
   */
  getActiveRequestCount() {
    return this.activeRequests.size;
  }

  /**
   * Get request info
   */
  getRequestInfo(messageId) {
    const request = this.activeRequests.get(messageId);
    if (!request) return null;

    return {
      messageId,
      startTime: request.startTime,
      duration: Date.now() - request.startTime
    };
  }

  /**
   * Get all active requests info
   */
  getAllRequestsInfo() {
    return Array.from(this.activeRequests.keys()).map(messageId => 
      this.getRequestInfo(messageId)
    );
  }

  /**
   * Cleanup handler
   */
  cleanup() {
    this.cancelAllTranslations();
    this.activeRequests.clear();
    this.logger.debug('TranslationHandler cleanup completed');
  }
}

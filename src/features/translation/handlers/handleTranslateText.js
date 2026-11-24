import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { MessageFormat, isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { CONFIG } from '@/shared/config/config.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'handleTranslateText');

const errorHandler = new ErrorHandler();

/**
 * Handles the 'TRANSLATE_TEXT' message action from Vue components.
 * This is used by popup, sidepanel, and content components.
 * Uses Promise pattern for Firefox MV3 compatibility.
 * @param {Object} message - The message object.
 * @param {Object} sender - The sender object.
 * @returns {Promise<Object>} - Returns Promise with translation result.
 */
export async function handleTranslateText(message, sender) {
  try {
    logger.debug('[Handler:TRANSLATE_TEXT] Processing Vue translation request:', message.data);
    
    const backgroundService = globalThis.backgroundService;
    if (!backgroundService || !backgroundService.translationEngine) {
      throw new Error("Background service or translation engine not initialized.");
    }
    
    const { text, from, to, provider } = message.data || {};
    
    if (typeof text === 'string' && text.trim() === '') {
      const error = new Error('Text is required for translation');
      error.type = ErrorTypes.TEXT_EMPTY;
      throw error;
    }

    if (!text) {
      throw new Error('Text is required for translation');
    }
    
    // Format request for UnifiedTranslationService.handleTranslationRequest
    const translationRequest = {
      action: MessageActions.TRANSLATE,
      messageId: message.messageId || `vue-${Date.now()}`,
      context: message.source || message.context || "vue-component",
      data: {
        text,
        provider: provider || CONFIG.TRANSLATION_API,
        sourceLanguage: from || 'auto',
        targetLanguage: to || 'fa',
        mode: message.data.mode || 'simple',
        options: {}
      }
    };
    
    // Use the unified translation service's handleTranslationRequest method
    const result = await unifiedTranslationService.handleTranslationRequest(translationRequest, sender);
    
    logger.debug(`[TRANSLATE_TEXT] Translation result:`, result);
    
    if (result.success) {
      const response = {
        success: true,
        translation: result.translatedText,
        provider: result.provider,
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage
      };
      logger.debug(`[TRANSLATE_TEXT] Returning successful response:`, response);
      return response;
    } else {
      const errorMessage = result.error?.message || 'Translation failed';
      const hasCanonicalDetails = isStructuredTranslationError(result.errorDetails);
      const canonicalSource = hasCanonicalDetails ? result.errorDetails : result.error ?? errorMessage;
      const response = {
        success: false,
        error: errorMessage,
        errorDetails: MessageFormat.serializeTranslationError(
          canonicalSource,
          hasCanonicalDetails ? {} : { message: errorMessage }
        )
      };
      logger.debug(`[TRANSLATE_TEXT] Returning error response:`, response);
      return response;
    }
    
  } catch (error) {
    logger.error('[Handler:TRANSLATE_TEXT] Error:', error);
    errorHandler.handle(error, {
      type: ErrorTypes.TRANSLATION,
      context: "handleTranslateText",
      messageData: message
    });
    
    const errorMessage = error.message || 'Translation failed';
    const errorResponse = {
      success: false,
      error: errorMessage,
      errorDetails: MessageFormat.serializeTranslationError(error, { message: errorMessage })
    };
    logger.error(`[TRANSLATE_TEXT] Returning catch error response:`, error);
    return errorResponse;
  }
}

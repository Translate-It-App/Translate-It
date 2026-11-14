
import browser from 'webextension-polyfill';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import {
  isValidSync,
  isContextError,
  isPermanentContextInvalidation,
} from '@/core/contextCore.js';
import { handleContextError } from '@/core/contextErrorHandler.js';
import { unifiedTranslationCoordinator } from './UnifiedTranslationCoordinator.js';
import { streamingTimeoutManager } from './StreamingTimeoutManager.js';
import {
  isCancellationError,
  isDeterministicClientHttpError,
  isFatalError,
  isProviderRequestSizeError,
  matchErrorToType,
  isSilentError,
} from '@/shared/error-management/ErrorMatcher.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { isRestrictedUrl } from '@/core/tabPermissions.js';
import { reconstructTranslationError, isStructuredTranslationError } from './MessagingCore.js';
import {
  LIVE_DUBBING_ACTION_TIMEOUTS,
  LIVE_DUBBING_ACTIONS,
} from '@/features/live-dubbing/constants.js';

const logger = getScopedLogger(LOG_COMPONENTS.MESSAGING, 'UnifiedMessaging');

// Operation timeout mapping
const OPERATION_TIMEOUTS = {
  'GET_SETTINGS': 3000,
  'SET_SETTINGS': 3000,
  'GET_SELECT_ELEMENT_STATE': 2000,
  'SET_SELECT_ELEMENT_STATE': 2000,
  'SHOW_NOTIFICATION': 2000,
  'DISMISS_NOTIFICATION': 2000,
  'OPEN_SIDEPANEL': 3000,
  'GET_SERVICE_STATUS': 2000,
  'GET_BACKGROUND_STATUS': 2000,
  'PING': 1000,
  'GET_INFO': 2000,
  'GET_HISTORY': 3000,
  'CLEAR_HISTORY': 3000,
  'ADD_TO_HISTORY': 2000,
  'ACTIVATE_SELECT_ELEMENT_MODE': 3000,
  'DEACTIVATE_SELECT_ELEMENT_MODE': 2000,
  'GET_SELECTED_TEXT': 2000,
  'CANCEL_TRANSLATION': 2000,
  'TRANSLATE': 60000,
  'TRANSLATE_SELECTION': 45000,
  'TRANSLATE_PAGE': 60000,
  'TRANSLATE_TEXT': 45000,
  'page-translate-batch': 60000,
  'FETCH_TRANSLATION': 10000,
  'PROCESS_SELECTED_ELEMENT': 8000,
  'TEST_PROVIDER': 8000,
  'TEST_PROVIDER_CONNECTION': 8000,
  // Custom Test Connection backstop only: the background handler enforces
  // its own shorter probe deadline (CUSTOM_CONNECTION_PROBE_DEADLINE_MS),
  // so this timeout must stay safely above it and only fires if the handler
  // itself stalls. Do not lower it near or below the probe deadline.
  'TEST_CUSTOM_CONNECTION': 120000,
  'VALIDATE_API_KEY': 6000,
  'GOOGLE_TTS_SPEAK': 20000,
  'TTS_SPEAK': 20000,
  'GOOGLE_TTS_PAUSE': 3000,
  'GOOGLE_TTS_RESUME': 3000,
  'TTS_STOP': 3000,
  'GOOGLE_TTS_GET_STATUS': 2000,
  'PLAY_OFFSCREEN_AUDIO': 15000,
  'SCREEN_CAPTURE': 25000,
  'START_SCREEN_CAPTURE': 20000,
  'CAPTURE_FULL_SCREEN': 25000,
  'START_CAPTURE_SELECTION': 15000,
  'PROCESS_IMAGE_OCR': 30000,
  'OCR_PROCESS': 30000,
  'PROCESS_SCREEN_CAPTURE': 20000,
  'START_AREA_CAPTURE': 15000,
  'START_SCREEN_AREA_SELECTION': 10000,
  'CAPTURE_SCREEN_AREA': 30000,
  ...LIVE_DUBBING_ACTION_TIMEOUTS,
  'DEFAULT': 8000
};

function getTimeoutForAction(action, context = null) {
  if (action === 'TRANSLATE' && (context === 'select-element' || context === 'pdf-translation' || context === 'pdf-viewer' || (typeof context === 'object' && context !== null && (context.mode === 'select_element' || context.mode === 'pdf-translation')))) {
    return 300000; 
  }
  
  // Higher timeout for generic translations to allow for AI model latency and queuing
  if (action === 'TRANSLATE' || action === 'TRANSLATE_SELECTION' || action === 'TRANSLATE_TEXT') {
    return 180000;
  }

  return (action && OPERATION_TIMEOUTS[action]) || OPERATION_TIMEOUTS.DEFAULT || 8000;
}

function createTimeout(ms, action) {
  let timeoutId;
  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new Error(`Operation '${action || 'unknown'}' timed out after ${ms}ms`);
      timeoutError.type = ErrorTypes.OPERATION_TIMEOUT;

      reject(timeoutError);
    }, ms);
  });

  return {
    promise,
    clear: () => clearTimeout(timeoutId)
  };
}

function getFailureMessage(response, responseError) {
  if (responseError && typeof responseError === 'object') {
    if (typeof responseError.message === 'string') return responseError.message;

    return responseError.error
      || responseError.statusText
      || responseError.reason
      || response.message
      || response.statusText
      || 'Unknown technical error';
  }

  return responseError
    || response.message
    || response.statusText
    || 'Unknown technical error';
}

// Live-dubbing UI actions whose structured failure context (ownership,
// cleanup/lease, retryability, authoritative descriptor, safe error identity)
// must survive the messaging boundary so a reopened or failed UI can
// recover instead of resetting to clean idle. providerDiagnostic is excluded
// by design (see below).
const LIVE_DUBBING_UI_ACTIONS = new Set([
  LIVE_DUBBING_ACTIONS.START,
  LIVE_DUBBING_ACTIONS.START_ALIAS,
  LIVE_DUBBING_ACTIONS.STOP,
  LIVE_DUBBING_ACTIONS.STOP_ALIAS,
  LIVE_DUBBING_ACTIONS.GET_STATUS,
  LIVE_DUBBING_ACTIONS.GET_STATUS_ALIAS,
]);

// Scalar-only descriptor fields. Anything outside this allowlist (media,
// bootstrap, stream IDs, transcripts, raw payloads) never crosses on failure.
const LIVE_DUBBING_STATUS_FIELDS = [
  'sessionId',
  'tabId',
  'providerId',
  'targetLanguage',
  'status',
  'startedAt',
  'lastError',
  'eventSequence',
];

function copyLiveDubbingRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let copied = null;
  for (const field of fields) {
    let fieldValue;
    try {
      fieldValue = value[field];
    } catch {
      continue;
    }
    const type = typeof fieldValue;
    if (fieldValue === null || fieldValue === undefined) {
      copied = copied || {};
      copied[field] = null;
    } else if (type === 'string' || type === 'number' || type === 'boolean') {
      copied = copied || {};
      copied[field] = fieldValue;
    }
  }
  return copied;
}

function attachLiveDubbingFailureContext(error, action, response) {
  if (!LIVE_DUBBING_UI_ACTIONS.has(action)) return;
  try {
    const data = { success: false };
    if (typeof response.error === 'string') data.error = response.error;
    for (const flag of ['retryable', 'cleanupPending', 'busy', 'stopped', 'pending', 'idempotent', 'ignored']) {
      if (typeof response[flag] === 'boolean') data[flag] = response[flag];
    }
    if (typeof response.reason === 'string') data.reason = response.reason;
    if (typeof response.available === 'boolean') data.available = response.available;
    const status = copyLiveDubbingRecord(response.status, LIVE_DUBBING_STATUS_FIELDS);
    if (status) data.status = status;
    const current = copyLiveDubbingRecord(response.current, LIVE_DUBBING_STATUS_FIELDS);
    if (current) data.current = current;
    // providerDiagnostic is intentionally never forwarded: its code and
    // terminalCategory fields are open provider vocabulary with no closed
    // canonical token enum, so no value check can distinguish a legitimate
    // code from a secret-shaped string. The popup keys all guidance off the
    // authoritative descriptor (lastError code + providerId) and never reads
    // this field, so omitting it loses nothing and closes the exfiltration
    // surface entirely.
    error.data = data;
  } catch {
    // Sanitization must never break messaging; the base error still throws.
  }
}

function reconstructResponseError(response) {
  const responseError = response.error;
  const canonicalError = isStructuredTranslationError(response.errorDetails)
    ? response.errorDetails
    : responseError;
  const message = getFailureMessage(response, canonicalError);
  const attachTargetTabId = (error) => {
    if (Number.isInteger(response?.targetTabId)) {
      error.targetTabId = response.targetTabId;
    }
    return error;
  };

  if (!canonicalError || typeof canonicalError !== 'object') {
    return attachTargetTabId(reconstructTranslationError(message));
  }

  const reconstructed = reconstructTranslationError({
    message,
    type: canonicalError.type,
    originalType: canonicalError.originalType,
    statusCode: canonicalError.statusCode,
    context: canonicalError.context,
    providerName: canonicalError.providerName,
    providerId: canonicalError.providerId,
    code: canonicalError.code,
    errorCode: canonicalError.errorCode,
    operationAborted: canonicalError.operationAborted,
    cancellationReason: canonicalError.cancellationReason,
    translationOutcome: canonicalError.translationOutcome
  });
  attachTargetTabId(reconstructed);
  return reconstructed;
}

function getLifecycleTerminalError(messageId) {
  const state = streamingTimeoutManager.getOperationState(messageId);
  if (state?.isCancelled) {
    const cancelError = new Error(ErrorTypes.USER_CANCELLED);
    cancelError.type = ErrorTypes.USER_CANCELLED;
    return cancelError;
  }

  if (state?.hasTimedOut) {
    const timeoutError = new Error(ErrorTypes.TRANSLATION_TIMEOUT);
    timeoutError.type = ErrorTypes.TRANSLATION_TIMEOUT;
    return timeoutError;
  }

  return null;
}

export async function sendMessage(message, options = {}) {
  const { forceRegular = false } = options;
  if (!message) return null;

  if (!forceRegular && isTranslationAction(message.action)) {
    try {
      return await unifiedTranslationCoordinator.coordinateTranslation(message, options);
    } catch (error) {
      const hasAuthoritativeTimeout = error?.type === ErrorTypes.TRANSLATION_TIMEOUT
        || error?.type === ErrorTypes.OPERATION_TIMEOUT;
      if (error?.operationAborted === true && !hasAuthoritativeTimeout) throw error;

      const errorType = hasAuthoritativeTimeout ? error.type : matchErrorToType(error);
      if (isFatalError(error)) throw error;
      if (isCancellationError(error)) throw error;
      if ([
        ErrorTypes.SERVER_ERROR,
        ErrorTypes.CIRCUIT_BREAKER_OPEN,
        ErrorTypes.RATE_LIMIT_REACHED,
      ].includes(errorType)) {
        throw error;
      }

      const isDeterministicRequestFailure = [
        ErrorTypes.TEXT_EMPTY,
        ErrorTypes.TEXT_TOO_LONG,
      ].includes(errorType)
        || isDeterministicClientHttpError(error)
        || isProviderRequestSizeError(error);
      if (isDeterministicRequestFailure) throw error;
      
      const isTimeout = errorType === ErrorTypes.TRANSLATION_TIMEOUT
        || errorType === ErrorTypes.OPERATION_TIMEOUT;
      const isFallbackMessage = typeof message.messageId === 'string'
        && (message.messageId.startsWith('fb-') || message.messageId.startsWith('fallback-'));
      if (isTimeout && message.messageId && !isFallbackMessage) {
        try {
          const checkResponse = await browser.runtime.sendMessage({
            action: 'CHECK_TRANSLATION_STATUS',
            data: { messageId: message.messageId }
          });
          if (checkResponse && checkResponse.completed) return checkResponse.results;
        } catch { /* ignore */ }
      }

      const fallbackMessage = {
        ...message,
        messageId: `fb-${Math.random().toString(36).substr(2, 6)}`
      };

      return await sendRegularMessage(fallbackMessage, options);
    }
  }

  return await sendRegularMessage(message, options);
}

export async function sendRegularMessage(message, options = {}) {
  if (!message) return null;
  const {
    timeout: customTimeout,
    silent = false,
    returnFailureResponse = false,
  } = options;
  const actionTimeout = customTimeout || getTimeoutForAction(message.action, message.context || message.data);

  try {
    if (!isValidSync()) {
      const contextError = new Error('Extension context invalidated');
      contextError.type = 'EXTENSION_CONTEXT_INVALIDATED';
      throw contextError;
    }

    if (message.messageId && streamingTimeoutManager.shouldContinue(message.messageId) === false) {
      const lifecycleError = getLifecycleTerminalError(message.messageId);
      if (lifecycleError) throw lifecycleError;
    }

    const sendPromise = browser.runtime.sendMessage(message);
    const { promise: timeoutPromise, clear: clearTimeoutTimer } = createTimeout(actionTimeout, message.action);

    let cancellationInterval;
    const cancellationPromise = new Promise((_, reject) => {
      cancellationInterval = setInterval(() => {
        if (message.messageId && streamingTimeoutManager.shouldContinue(message.messageId) === false) {
          const lifecycleError = getLifecycleTerminalError(message.messageId);
          if (lifecycleError) {
            if (cancellationInterval) clearInterval(cancellationInterval);
            reject(lifecycleError);
          }
        }
      }, 50);
    });

    let response;
    try {
      response = await Promise.race([sendPromise, cancellationPromise, timeoutPromise]);
    } finally {
      clearTimeoutTimer();
      if (cancellationInterval) clearInterval(cancellationInterval);
    }

    if (!response) {
      throw new Error(`No response for ${message.action || 'unknown'}`);
    }

    if (response && response.success === false) {
      if (response.isRestrictedPage || (response.tabUrl && isRestrictedUrl(response.tabUrl))) {
        return response;
      }

      if (returnFailureResponse && response.isTransportFailure !== true) return response;

      const reconstructed = reconstructResponseError(response);
      attachLiveDubbingFailureContext(reconstructed, message.action, response);
      throw reconstructed;
    }

    return response;
  } catch (error) {
    const errorType = matchErrorToType(error);

    if (errorType === ErrorTypes.OPERATION_TIMEOUT && message.messageId && isTranslationAction(message.action)) {
      void browser.runtime.sendMessage({
        action: 'CANCEL_TRANSLATION',
        data: { messageId: message.messageId, reason: 'Translation timed out', timeout: true }
      }).catch(() => {});
    }

    if (!silent) {
      const errorMsg = (error && typeof error.message === 'string') ? error.message : 'No message';
      logger.debug(`Message error: ${message.action} (${errorType}) - ${errorMsg}`);
    }

    if (isSilentError(errorType)) throw error;
    
    if (isContextError(error)) {
      handleContextError(error, `UnifiedMessaging.${message.action}`);
      const permanentlyInvalidated = isPermanentContextInvalidation(error);
      
      return { 
        success: false, 
        error: `Context error: ${error.message || error}`,
        isContextInvalidated: permanentlyInvalidated,
      };
    }

    throw error;
  }
}

function isTranslationAction(action) {
  return ['TRANSLATE', 'TRANSLATE_SELECTION', 'TRANSLATE_TEXT', 'TRANSLATE_PAGE'].includes(action);
}

export default { sendMessage, sendRegularMessage };
/**
 * Safe wrapper for sendMessage that checks context validity before sending.
 * @param {Object} message - Message to send
 * @param {Object|string} options - Sending options or context string
 * @param {string} context - Context name for error reporting
 * @returns {Promise<any>}
 */
export async function safeSendMessage(message, options = {}, context = "messaging") {
  const actualOptions = typeof options === 'string' ? {} : options;
  const actualContext = typeof options === 'string' ? options : context;

  if (!isValidSync()) {
    handleContextError(new Error('Extension context invalidated'), `safeSendMessage-${actualContext}`);
    return null;
  }

  try {
    return await sendMessage(message, actualOptions);
  } catch (error) {
    if (isContextError(error)) {
      handleContextError(error, `safeSendMessage-${actualContext}`);
      return null;
    }
    throw error;
  }
}

// useTranslationError.js
// Centralized translation error management composable

import { ref, computed, onUnmounted } from 'vue'
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js'
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js'
import ExtensionContextManager from '@/core/extensionContext.js'
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js'
import { openOptionsPage } from '@/core/helpers.js'
import { getErrorDisplayStrategy, processErrorMessage, shouldShowRetry, shouldShowSettings } from '@/shared/error-management/ErrorDisplayStrategies.js'
import { isCancellationError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js'
import { mapCanonicalTranslationError } from '@/shared/error-management/PublicTranslationErrorPolicy.js'
import { PublicTranslationErrorActions } from '@/shared/error-management/PublicTranslationError.js'
import { createLegacyDisplayError } from '@/shared/error-management/PublicTranslationErrorAdapter.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

// Lazy logger to avoid TDZ ReferenceErrors when bundled
const logger = new Proxy({}, {
  get(target, prop) {
    const instance = getScopedLogger(LOG_COMPONENTS.UI, 'useTranslationError');
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

/**
 * useTranslationError - Composable for localized translation error handling
 * 
 * @param {string} context - Translation context ('popup', 'sidepanel', 'content', 'selection')
 * @returns {Object} Error management interface
 */
export function useTranslationError(context = 'unknown') {
  // Error state
  const currentError = ref(null)
  const errorMessage = ref('')
  const errorType = ref('')
  const canRetry = ref(false)
  const canOpenSettings = ref(false)
  const errorTimestamp = ref(null)
  
  // Error handling
  const { handleTranslationError, getErrorForDisplay, isRetryableError } = useErrorHandler()
  const errorHandler = ErrorHandler.getInstance()
  
  // UI error listener for real-time error updates
  let unsubscribeListener = null
  
  // Computed properties
  const hasError = computed(() => Boolean(currentError.value && errorMessage.value))
  const errorDisplayLevel = computed(() => {
    if (!errorType.value) return 'detailed'
    const strategy = getErrorDisplayStrategy(context, errorType.value)
    return strategy.errorLevel
  })
  
  const processedErrorMessage = computed(() => {
    if (!errorMessage.value) return ''
    return processErrorMessage(errorMessage.value, errorDisplayLevel.value, context)
  })
  
  /**
   * Handle a translation error
   * @param {Error|string} error - The error to handle
   * @param {Object} options - Additional options
   */
  const handleError = async (error, options = {}) => {
    if (!error) {
      clearError()
      return
    }

    // Identify and ignore user cancellation errors
    const errorTypeValue = matchErrorToType(error)
    if (isCancellationError(error)) {
      logger.debug(`[${context}] Silently ignoring user cancellation error`);
      return;
    }
    
    try {
      logger.debug(`[${context}] Handling translation error:`, error)
      
      const isContextError = ExtensionContextManager.isContextError(error)
      const isLocalValidationError = [ErrorTypes.TEXT_EMPTY, ErrorTypes.TEXT_TOO_LONG].includes(errorTypeValue)
      const usePublicBoundary = !isContextError && !isLocalValidationError
      let displayError = error
      let errorInfo
      let publicError = null

      if (usePublicBoundary) {
        publicError = mapCanonicalTranslationError(error)
        displayError = await createLegacyDisplayError(error, publicError)
        if (!displayError) return

        errorInfo = {
          message: displayError.message,
          timestamp: Date.now()
        }
      } else {
        // Preserve context and local input-validation behavior outside the
        // ordinary translation public boundary.
        errorInfo = await getErrorForDisplay(error, context)
      }

      const strategy = getErrorDisplayStrategy(context, errorTypeValue)
      
      // Update error state
      currentError.value = error
      errorMessage.value = errorInfo.message
      errorType.value = errorTypeValue
      errorTimestamp.value = errorInfo.timestamp
      canRetry.value = publicError
        ? publicError.action === PublicTranslationErrorActions.RETRY
        : shouldShowRetry(errorTypeValue, strategy)
      canOpenSettings.value = publicError
        ? publicError.action === PublicTranslationErrorActions.OPEN_SETTINGS
        : shouldShowSettings(errorTypeValue, strategy)
      
      // Handle error with appropriate strategy
      const enhancedOptions = {
        showToast: strategy.showToast,
        showInUI: strategy.showInUI,
        errorLevel: strategy.errorLevel,
        component: 'translation',
        ...options
      }
      
      await handleTranslationError(displayError, context, {
        ...enhancedOptions,
        ...(usePublicBoundary && { type: errorTypeValue })
      })
      
      logger.debug(`[${context}] Error handled with strategy:`, strategy)
      
    } catch (handlerError) {
      logger.error(`[${context}] Failed to handle translation error:`, handlerError)
      
      // Fallback error state
      currentError.value = error
      errorMessage.value = 'An error occurred during translation'
      errorType.value = 'UNKNOWN'
      errorTimestamp.value = Date.now()
      canRetry.value = true
      canOpenSettings.value = false
    }
  }
  
  /**
   * Clear current error state
   */
  const clearError = () => {
    currentError.value = null
    errorMessage.value = ''
    errorType.value = ''
    errorTimestamp.value = null
    canRetry.value = false
    canOpenSettings.value = false
    
    logger.debug(`[${context}] Error state cleared`)
  }
  
  /**
   * Check if an error is retryable
   * @param {Error|string} error - Error to check
   * @returns {boolean} True if retryable
   */
  const isErrorRetryable = (error) => {
    return isRetryableError(error)
  }
  
  /**
   * Get retry callback for current error
   * @param {Function} retryFunction - Function to call for retry
   * @returns {Function} Retry callback
   */
  const getRetryCallback = (retryFunction) => {
    return async () => {
      if (!canRetry.value || !retryFunction) {
        logger.warn(`[${context}] Retry attempted but not available`)
        return
      }
      
      try {
        logger.info(`[${context}] Retrying after error: ${errorType.value}`)
        clearError() // Clear error before retry
        await retryFunction()
      } catch (retryError) {
        logger.error(`[${context}] Retry failed:`, retryError)
        await handleError(retryError)
      }
    }
  }
  
  /**
   * Get settings callback for current error
   * @returns {Function} Settings callback
   */
  const getSettingsCallback = () => {
    return () => {
      if (!canOpenSettings.value) {
        logger.warn(`[${context}] Settings attempted but not available`)
        return
      }
      
      try {
        logger.info(`[${context}] Opening settings for error: ${errorType.value}`)
        // Open the extension options page via the supported runtime message path.
        // Guard against unhandled promise rejections without leaking error details.
        openOptionsPage().catch((settingsError) => {
          logger.error(`[${context}] Failed to open settings:`, settingsError)
        })
      } catch (settingsError) {
        logger.error(`[${context}] Failed to open settings:`, settingsError)
      }
    }
  }
  
  /**
   * Setup UI error listener for real-time error updates
   */
  const setupErrorListener = () => {
    if (unsubscribeListener) return // Already setup
    
    const listener = (errorData) => {
      // Only handle errors for our context
      if (errorData.context && !errorData.context.includes(context)) {
        return
      }

      logger.debug(`[${context}] Received UI error update:`, errorData)

      const hasPublicEcho = typeof errorData.canRetry === 'boolean'
      const publicError = hasPublicEcho
        ? mapCanonicalTranslationError({ type: errorData.type })
        : null

      // Update error state from listener
      currentError.value = errorData
      errorMessage.value = errorData.message
      errorType.value = errorData.type
      errorTimestamp.value = errorData.timestamp

      const strategy = getErrorDisplayStrategy(context, errorData.type)
      canRetry.value = hasPublicEcho
        ? errorData.canRetry
        : shouldShowRetry(errorData.type, strategy)
      canOpenSettings.value = hasPublicEcho
        ? publicError.action === PublicTranslationErrorActions.OPEN_SETTINGS
        : shouldShowSettings(errorData.type, strategy)
    }
    
    unsubscribeListener = errorHandler.addUIErrorListener(listener)
    logger.debug(`[${context}] Error listener setup`)
  }
  
  /**
   * Cleanup error listener
   */
  const cleanupErrorListener = () => {
    if (unsubscribeListener) {
      unsubscribeListener()
      unsubscribeListener = null
      logger.debug(`[${context}] Error listener cleaned up`)
    }
  }
  
  // Setup listener on creation
  setupErrorListener()
  
  // Cleanup on unmount
  onUnmounted(() => {
    cleanupErrorListener()
  })
  
  return {
    // Error state
    currentError,
    errorMessage: processedErrorMessage,
    errorType,
    hasError,
    canRetry,
    canOpenSettings,
    errorTimestamp,
    
    // Methods
    handleError,
    clearError,
    isErrorRetryable,
    getRetryCallback,
    getSettingsCallback,
    
    // Utils
    setupErrorListener,
    cleanupErrorListener
  }
}

// Unified translation composable for both popup and sidepanel
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useSettingsStore } from "@/features/settings/stores/settings.js";
import { useTranslationStore } from "@/features/translation/stores/translation.js";
import { useBrowserAPI } from "@/composables/core/useBrowserAPI.js";
import { useTranslationError } from "@/features/translation/composables/useTranslationError.js";
import { generateMessageId } from "@/utils/messaging/messageId.js";
import { isSingleWordOrShortPhrase } from "@/shared/utils/text/textAnalysis.js";
import { CONFIG, TranslationMode } from "@/shared/config/config.js";
import { MessageActions } from "@/shared/messaging/core/MessageActions.js";
import { MessagingContexts, reconstructTranslationError, isStructuredTranslationError } from "@/shared/messaging/core/MessagingCore.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import browser from "webextension-polyfill";
import { 
  getSourceLanguageAsync, 
  getTargetLanguageAsync
} from "@/shared/config/config.js";
import { AUTO_DETECT_VALUE, DEFAULT_TARGET_LANGUAGE } from "@/shared/constants/core.js";
import { utilsFactory } from "@/utils/UtilsFactory.js";
import { registerTranslation, handleMessage as routeMessage } from "@/shared/messaging/core/ContentScriptIntegration.js";
import { sendMessage as sendUnifiedMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { translationUiSessionState } from '@/features/translation/storage/TranslationUiSessionState.js';

// Lazy logger to avoid TDZ ReferenceErrors when bundled
const logger = new Proxy({}, {
  get(target, prop) {
    const instance = getScopedLogger(LOG_COMPONENTS.UI, 'useUnifiedTranslation');
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

function resolveFailureError(payload) {
  if (isStructuredTranslationError(payload?.errorDetails)) {
    return reconstructTranslationError(payload.errorDetails);
  }
  if (payload?.error !== undefined && payload?.error !== null) {
    return reconstructTranslationError(payload.error);
  }
  return new Error('Translation failed');
}

/**
 * useUnifiedTranslation - Unified composable for translation features
 */
export function useUnifiedTranslation(context = 'popup', { provider = null } = {}) {
  // Validate context
  const validContexts = ['popup', 'sidepanel'];
  if (!validContexts.includes(context)) {
    throw new Error(`Invalid context: ${context}. Must be one of: ${validContexts.join(', ')}`);
  }

  // --- State ---
  const sourceText = ref("");
  const translatedText = ref("");
  const sourceLanguage = ref(AUTO_DETECT_VALUE);
  const targetLanguage = ref(DEFAULT_TARGET_LANGUAGE);
  const isTranslating = ref(false);
  const isStreaming = ref(false);
  
  // Computed lastTranslation that proxies the store to ensure all instances are in sync immediately
  const lastTranslation = computed({
    get: () => {
      const ct = translationStore.currentTranslation;
      if (!ct) return null;
      return {
        source: ct.sourceText,
        target: ct.translatedText,
        sourceLanguage: ct.sourceLanguage,
        targetLanguage: ct.targetLanguage,
        provider: ct.provider,
        mode: ct.mode, // Added mode for UI logic
        timestamp: ct.timestamp
      };
    },
    set: (val) => {
      if (!val) {
        translationStore.currentTranslation = null;
        return;
      }
      translationStore.currentTranslation = {
        sourceText: val.source,
        translatedText: val.target,
        sourceLanguage: val.sourceLanguage,
        targetLanguage: val.targetLanguage,
        provider: val.provider,
        mode: val.mode, // Added mode for persistence
        timestamp: val.timestamp
      };
    }
  });

  const actualSourceLanguage = ref(AUTO_DETECT_VALUE);
  const actualTargetLanguage = ref(DEFAULT_TARGET_LANGUAGE);
  
  const pendingRequests = ref(new Set());
  const loadingStartTime = ref(null);
  const currentMessageId = ref(null);
  const activeRequestSource = ref(null);
  const lastSyncedTimestamp = ref(0);
  let sessionRevision = 0;
  let sessionReady = false;
  let sessionResultEligible = false;
  let expectedProgrammaticSource = null;
  const MINIMUM_LOADING_DURATION = 100;

  /**
   * Cancels the currently active translation request.
   */
  const cancelTranslation = async () => {
    if (!isTranslating.value || !currentMessageId.value) return;

    logger.info(`[${context}] Cancelling translation: ${currentMessageId.value}`);
    
    try {
      await sendUnifiedMessage({
        action: MessageActions.CANCEL_TRANSLATION,
        data: { messageId: currentMessageId.value }
      });

      // Cleanup state immediately for better UX
      isTranslating.value = false;
      isStreaming.value = false;
      currentMessageId.value = null;
      activeRequestSource.value = null;
      loadingStartTime.value = null;
      sessionResultEligible = false;
      void persistSessionState();
    } catch (error) {
      logger.error(`[${context}] Failed to cancel translation:`, error);
    }
  };

  // --- Stores & Composables ---
  const settingsStore = useSettingsStore();
  const translationStore = useTranslationStore();
  const browserAPI = context === 'popup' ? useBrowserAPI() : null;
  const errorManager = useTranslationError(context);

  // --- Computed Properties ---
  const hasTranslation = computed(() => Boolean(translatedText.value?.trim()));
  const canTranslate = computed(
    () => Boolean(sourceText.value?.trim()) && !isTranslating.value
  );

  const getSessionProvider = () => provider?.value || null;

  const createSessionSnapshot = () => {
    const draftSource = sourceText.value || '';
    const translation = lastTranslation.value;
    const canRestoreCompletedTranslation = sessionResultEligible
      && !isTranslating.value
      && !isStreaming.value
      && translation?.source === draftSource;

    return {
      draftSource,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      provider: getSessionProvider(),
      revision: ++sessionRevision,
      completedTranslation: canRestoreCompletedTranslation ? {
        source: translation.source,
        displayTranslatedText: translatedText.value,
        translationTarget: translation.target,
        sourceLanguage: translation.sourceLanguage,
        targetLanguage: translation.targetLanguage,
        provider: translation.provider,
        actualSourceLanguage: actualSourceLanguage.value,
        actualTargetLanguage: actualTargetLanguage.value,
        mode: translation.mode,
        timestamp: translation.timestamp,
      } : null,
    };
  };

  const persistSessionState = () => {
    if (!sessionReady) return Promise.resolve(false);
    if (!sourceText.value) return clearSessionState();
    return translationUiSessionState.save(context, createSessionSnapshot());
  };

  const clearSessionState = () => {
    sessionResultEligible = false;
    sessionRevision += 1;
    return translationUiSessionState.clear(context, sessionRevision);
  };

  const initializeSessionState = async () => {
    await resetLanguagesToDefaults();

    const snapshot = await translationUiSessionState.load(context);
    if (!snapshot || typeof snapshot.draftSource !== 'string') {
      sessionReady = true;
      return false;
    }

    sessionRevision = Math.max(sessionRevision, Number(snapshot.revision) || 0);
    sourceText.value = snapshot.draftSource;
    if (context !== 'popup') {
      sourceLanguage.value = snapshot.sourceLanguage || sourceLanguage.value;
      targetLanguage.value = snapshot.targetLanguage || targetLanguage.value;
    }
    if (provider && snapshot.provider) provider.value = snapshot.provider;

    const completed = snapshot.completedTranslation;
    if (completed?.source === snapshot.draftSource) {
      translatedText.value = completed.displayTranslatedText || '';
      actualSourceLanguage.value = completed.actualSourceLanguage || completed.sourceLanguage || sourceLanguage.value;
      actualTargetLanguage.value = completed.actualTargetLanguage || completed.targetLanguage || targetLanguage.value;
      lastSyncedTimestamp.value = completed.timestamp || 0;
      lastTranslation.value = {
        source: completed.source,
        target: completed.translationTarget,
        sourceLanguage: completed.sourceLanguage,
        targetLanguage: completed.targetLanguage,
        provider: completed.provider,
        mode: completed.mode,
        timestamp: completed.timestamp,
      };
      sessionResultEligible = true;
    } else {
      translatedText.value = '';
      lastTranslation.value = null;
    }

    sessionReady = true;
    return true;
  };

  /**
   * Returns the actual language detected by the provider/service during the last translation.
   * This is used to bypass redundant language detection in TTS.
   */
  const detectedSourceLanguage = computed(() => lastTranslation.value?.sourceLanguage || AUTO_DETECT_VALUE);

  // --- Language Management ---
  const resetLanguagesToDefaults = async () => {
    try {
      const { findLanguageCode } = await utilsFactory.getI18nUtils();
      const [savedSource, savedTarget] = await Promise.all([
        getSourceLanguageAsync(),
        getTargetLanguageAsync()
      ]);
      sourceLanguage.value = await findLanguageCode(savedSource) || AUTO_DETECT_VALUE;
      
      const targetLang = await findLanguageCode(savedTarget) || DEFAULT_TARGET_LANGUAGE;
      targetLanguage.value = targetLang;
      // Also sync store if it's the first time
      if (!translationStore.uiTargetLanguage) {
        translationStore.uiTargetLanguage = targetLang;
      }
      
      logger.debug(`[${context}] Languages (re)set to defaults:`, { source: sourceLanguage.value, target: targetLanguage.value });
    } catch (error) {
      logger.info(`[${context}] Failed to reset languages:`, error);
      // Fallback to hardcoded defaults in case of storage error
      sourceLanguage.value = AUTO_DETECT_VALUE;
      targetLanguage.value = DEFAULT_TARGET_LANGUAGE;
    }
  };

  // Watch for local targetLanguage changes to update store
  watch(targetLanguage, (newVal) => {
    if (newVal) {
      translationStore.uiTargetLanguage = newVal;
      // Also update actual language to reflect user's choice when manual selection changes
      actualTargetLanguage.value = newVal;
    }
    void persistSessionState();
  });

  // Watch for local sourceLanguage changes
  watch(sourceLanguage, (newVal) => {
    if (newVal) {
      actualSourceLanguage.value = newVal;
    }
    void persistSessionState();
  });

  // Reset lastTranslation when source text changes to ensure fresh detection for TTS
  // We keep translatedText as-is to prevent immediate UI clearing (better UX)
  watch(sourceText, (newVal, oldVal) => {
    if (newVal !== oldVal) {
      const isExpectedProgrammaticChange = newVal === expectedProgrammaticSource;
      expectedProgrammaticSource = null;
      if (isExpectedProgrammaticChange) {
        void persistSessionState();
        return;
      }
      // Don't clear if this change came from a store sync (source matches store)
      const ct = translationStore.currentTranslation;
      if (ct && ct.sourceText === newVal && ct.timestamp === lastSyncedTimestamp.value) {
        return;
      }
      lastTranslation.value = null;
      sessionResultEligible = false;
    }
    if (!newVal) {
      void clearSessionState();
      return;
    }
    void persistSessionState();
  });

  if (provider) {
    watch(provider, () => {
      void persistSessionState();
    });
  }

  // Watch for store changes to update local targetLanguage (for cross-component sync)
  watch(() => translationStore.uiTargetLanguage, (newVal) => {
    if (newVal && newVal !== targetLanguage.value) {
      targetLanguage.value = newVal;
    }
  });

  // --- Translation Logic ---
  const getTranslationMode = (text) => {
    const baseMode = context === 'popup' ? TranslationMode.Popup_Translate : TranslationMode.Sidepanel_Translate;
    const isDictionaryCandidate = isSingleWordOrShortPhrase(text);
    
    if (settingsStore.settings.ENABLE_DICTIONARY && isDictionaryCandidate) {
      return TranslationMode.Dictionary_Translation;
    }
    
    return baseMode;
  };

  const createTranslationRequest = (sourceLang, targetLang, messageId, overrideProvider = null) => {
    const currentProvider = overrideProvider || settingsStore.settings.TRANSLATION_API || CONFIG.TRANSLATION_API;
    const mode = getTranslationMode(sourceText.value);

    return {
      action: MessageActions.TRANSLATE,
      messageId: messageId,
      context: context,
      timestamp: Date.now(),
      data: {
        text: sourceText.value,
        provider: currentProvider,
        sourceLanguage: sourceLang || sourceLanguage.value,
        targetLanguage: targetLang || targetLanguage.value,
        mode: mode,
        isExplicitProvider: true,
        options: {}
      }
    };
  };

  const handleTranslationSuccess = (resultData, requestSource) => {
    if (requestSource !== sourceText.value) {
      logger.debug(`[${context}] Ignoring stale translation result for changed source text`);
      return false;
    }

    translatedText.value = resultData.translatedText;
    errorManager.clearError();
    
    // Update actual languages used for TTS and labels
    if (resultData.sourceLanguage) actualSourceLanguage.value = resultData.sourceLanguage;
    if (resultData.targetLanguage) actualTargetLanguage.value = resultData.targetLanguage;

    // Update last translation metadata
    // Setting this will automatically sync with translationStore via the computed property
    const timestamp = resultData.timestamp || Date.now();
    lastSyncedTimestamp.value = timestamp;
    
    lastTranslation.value = {
      source: resultData.originalText || sourceText.value,
      target: resultData.translatedText,
      provider: resultData.provider,
      mode: resultData.mode, // Capture mode from response
      timestamp: timestamp,
      sourceLanguage: resultData.sourceLanguage,
      targetLanguage: resultData.targetLanguage
    };

    // If same language translation, show appropriate message
    if (resultData.translatedText === null && resultData.sourceLanguage === resultData.targetLanguage) {
      const originalText = resultData.originalText || sourceText.value;
      translatedText.value = originalText;
      logger.debug(`[${context}] Same language detected - showing original text: "${originalText}"`);
    }

    logger.debug(`[${context}] Translation updated successfully - final translatedText: "${translatedText.value}"`);
    sessionResultEligible = true;
    return true;
  };

  const handleTranslationError = (error, messageId = null) => {
    errorManager.handleError(error);
    translatedText.value = "";
    lastTranslation.value = null;
    lastSyncedTimestamp.value = 0;
    sessionResultEligible = false;
    
    if (messageId && context === 'sidepanel') {
      pendingRequests.value.delete(messageId);
    }
    
    logger.debug(`[${context}] Translation error:`, error?.message || error);
    void persistSessionState();
  };

  const ensureMinimumLoadingDuration = async () => {
    if (context === 'sidepanel' && loadingStartTime.value) {
      const elapsed = Date.now() - loadingStartTime.value;
      const remaining = Math.max(0, MINIMUM_LOADING_DURATION - elapsed);
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
      }
      loadingStartTime.value = null;
    }
  };

  const triggerTranslation = async (sourceLang = null, targetLang = null, overrideProvider = null) => {
    if (!canTranslate.value) return false;

    // 1. Early Character Limit Validation
    const charLimit = context === 'popup' 
      ? settingsStore.settings.POPUP_MAX_CHARS 
      : settingsStore.settings.SIDEPANEL_MAX_CHARS;
    
    if (sourceText.value.length > charLimit) {
      const error = new Error(`Text too long (${sourceText.value.length.toLocaleString()} chars). Max allowed is ${charLimit.toLocaleString()} chars.`);
      error.type = ErrorTypes.TEXT_TOO_LONG;
      handleTranslationError(error);
      return false;
    }

    isTranslating.value = true;
    isStreaming.value = false;
    sessionResultEligible = false;
    if (context === 'sidepanel') {
      loadingStartTime.value = Date.now();
    }
    errorManager.clearError();
    translatedText.value = "";

    if (context === 'sidepanel') await nextTick();

    try {
      const messageId = generateMessageId(context);
      currentMessageId.value = messageId;
      activeRequestSource.value = sourceText.value;
      void persistSessionState();

      // Track accumulated streaming results
      const accumulatedResults = new Map();

      // Register for streaming updates
      registerTranslation(messageId, {
        onStreamUpdate: (data) => {
          if (activeRequestSource.value !== sourceText.value) return;
          if (data.data) {
            const batchText = Array.isArray(data.data) ? data.data.join('') : String(data.data);
            
            // Store by batch index to handle ordering correctly
            const index = typeof data.batchIndex === 'number' ? data.batchIndex : accumulatedResults.size;
            accumulatedResults.set(index, batchText);
            
            const partialText = Array.from(accumulatedResults.keys())
              .sort((a, b) => a - b)
              .map(i => accumulatedResults.get(i))
              .join('');
            
            // Update UI progressively
            translatedText.value = partialText;
            isStreaming.value = true;
            
            logger.debug(`[${context}] Streaming progress updated:`, { length: partialText.length });
          }
        },
        onStreamEnd: (data) => {
          if (data.success) {
            isStreaming.value = false;
          }
        },
        onTranslationResult: (data) => {
          if (data.success) {
            isStreaming.value = false;
          }
        },
        onError: (error) => {
          isStreaming.value = false;
          logger.error(`[${context}] Streaming error for message ${messageId}:`, error);
        }
      });

      const requestData = createTranslationRequest(sourceLang, targetLang, messageId, overrideProvider);
      
      logger.debug(`[${context}] Translation request:`, requestData.data);

      if (context === 'sidepanel') {
        pendingRequests.value.add(messageId);
      }

      const timeoutOptions = context === 'sidepanel' ? { totalTimeout: 20000, retries: 1 } : {};
      
      const response = await sendUnifiedMessage(requestData, timeoutOptions);

      logger.debug(`[${context}] Response received:`, response);

      if (response && (response.result || response.data || response.translatedText !== undefined)) {
        let resultData = response.result || response.data || response;
        logger.debug(`[${context}] Processing direct response - resultData:`, resultData);

        if (resultData.success === false && (resultData.error || resultData.errorDetails)) {
          handleTranslationError(resolveFailureError(resultData), messageId);
        } else if (resultData.success === true && resultData.translatedText !== undefined) {
          handleTranslationSuccess(resultData, activeRequestSource.value);
          if (context === 'sidepanel') {
            pendingRequests.value.delete(messageId);
            await ensureMinimumLoadingDuration();
          }
        }
        isTranslating.value = false;
        isStreaming.value = false;
        currentMessageId.value = null;
        activeRequestSource.value = null;
        void persistSessionState();
        logger.debug(`[${context}] Direct response processed successfully`);
        return true;
      } else if (response && response.success === false && (response.error || response.errorDetails)) {
        handleTranslationError(resolveFailureError(response), messageId);
        isTranslating.value = false;
        isStreaming.value = false;
        currentMessageId.value = null;
        activeRequestSource.value = null;
        void persistSessionState();
        return false;
      } else {
        logger.warn(`[${context}] No valid response received`, response);
        isTranslating.value = false;
        isStreaming.value = false;
        currentMessageId.value = null;
        activeRequestSource.value = null;
        void persistSessionState();
        return false;
      }

    } catch (error) {
      const { matchErrorToType } = await import('@/shared/error-management/ErrorMatcher.js');
      const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
      
      const errorType = matchErrorToType(error);

      if (errorType === ErrorTypes.USER_CANCELLED) {
        logger.debug(`[${context}] Translation request was cancelled by user.`);
      } else {
        logger.error(`[${context}] Failed to send/process translation request: ${error.message}`);
        handleTranslationError(error);
      }
      
      isTranslating.value = false;
      isStreaming.value = false;
      currentMessageId.value = null;
      activeRequestSource.value = null;
      await ensureMinimumLoadingDuration();
      void persistSessionState();
      return false;
    }
  };

  // --- Public Methods ---
  const clearTranslation = async () => {
    await clearSessionState();
    sourceText.value = "";
    translatedText.value = "";
    errorManager.clearError();
    lastTranslation.value = null;
    lastSyncedTimestamp.value = 0;
    await resetLanguagesToDefaults();
  };

  const revertTranslation = () => {
    const translation = lastTranslation.value;
    if (!translation) return null;

    const revertedSource = translation.target || '';
    expectedProgrammaticSource = revertedSource;
    sourceText.value = revertedSource;
    translatedText.value = translation.source || '';
    sourceLanguage.value = translation.targetLanguage || sourceLanguage.value;
    targetLanguage.value = translation.sourceLanguage || targetLanguage.value;
    actualSourceLanguage.value = translation.targetLanguage || actualSourceLanguage.value;
    actualTargetLanguage.value = translation.sourceLanguage || actualTargetLanguage.value;

    const timestamp = Date.now();
    lastSyncedTimestamp.value = timestamp;
    lastTranslation.value = {
      source: sourceText.value,
      target: translatedText.value,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      provider: translation.provider,
      mode: translation.mode,
      timestamp,
    };
    sessionResultEligible = true;
    void persistSessionState();

    return {
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
    };
  };

  // --- Lifecycle & Watchers ---
  watch(() => translationStore.currentTranslation, async (newTranslation) => {
    if (newTranslation && newTranslation.timestamp !== lastSyncedTimestamp.value) {
      const { findLanguageCode } = await utilsFactory.getI18nUtils();
      lastSyncedTimestamp.value = newTranslation.timestamp || 0;
      sourceText.value = newTranslation.sourceText || '';
      translatedText.value = newTranslation.translatedText || '';
      sourceLanguage.value = await findLanguageCode(newTranslation.sourceLanguage) || AUTO_DETECT_VALUE;
      targetLanguage.value = await findLanguageCode(newTranslation.targetLanguage) || DEFAULT_TARGET_LANGUAGE;
      errorManager.clearError();
      sessionResultEligible = sourceText.value === newTranslation.sourceText;
      void persistSessionState();
    }
  }, { deep: true });

  let messageListener = null;

  onMounted(async () => {
    messageListener = (message, sender) => {
      // Route through ContentScriptIntegration for streaming and unified handling
      const handledByIntegration = routeMessage(message, sender);
      if (handledByIntegration) {
        return;
      }

      // 1. Handle TTS status updates to capture detected language from background
      // Only update the local UI state for display, do NOT pollute lastTranslation
      if (message.action === MessageActions.TTS_LANG_DETECTED) {
        if (message.detectedSourceLanguage) {
          logger.debug(`[${context}] Captured language from TTS: ${message.detectedSourceLanguage}`);
          
          // Only update actualSourceLanguage for immediate UI feedback (labels)
          // We don't touch lastTranslation here to avoid polluting translation metadata
          actualSourceLanguage.value = message.detectedSourceLanguage;
        }
        return;
      }

      // 2. Handle Translation Results (Fallback/Direct)
      if (context === 'popup') {
        logger.debug(`[${context}] Message listener triggered - isTranslating: ${isTranslating.value}`);
        if (message.messageId && message.messageId !== currentMessageId.value) return;
        let resultData = message.result || message.data || (message.translatedText ? message : null);

        if (resultData && (resultData.translatedText !== undefined || resultData.success === false || resultData.success === true)) {
          if (resultData.success === false && (resultData.error || resultData.errorDetails)) {
            handleTranslationError(resolveFailureError(resultData));
          } else if (resultData.success === true && resultData.translatedText !== undefined) {
            handleTranslationSuccess(resultData, activeRequestSource.value);
          } else {
            handleTranslationError("Unexpected response format");
          }
          isTranslating.value = false;
          isStreaming.value = false;
          currentMessageId.value = null;
          activeRequestSource.value = null;
          void persistSessionState();
        }
      } else if (context === 'sidepanel') {
        if (message.action !== MessageActions.TRANSLATION_RESULT_UPDATE || (message.context && message.context !== MessagingContexts.SIDEPANEL)) {
          return;
        }
        const messageId = message.messageId;
        if (messageId && !pendingRequests.value.has(messageId)) return;
        if (messageId) pendingRequests.value.delete(messageId);

        nextTick(async () => {
          await ensureMinimumLoadingDuration();
          isTranslating.value = false;
          isStreaming.value = false;
          if (message.data.success === false && (message.data.error || message.data.errorDetails)) {
            handleTranslationError(resolveFailureError(message.data));
          } else if (message.data.success === true && message.data.translatedText !== undefined) {
            handleTranslationSuccess(message.data, activeRequestSource.value);
          } else {
            handleTranslationError("Unexpected response format in sidepanel");
          }
          currentMessageId.value = null;
          activeRequestSource.value = null;
          void persistSessionState();
        });
      }
    };

    const messageTarget = context === 'popup' && browserAPI ? browserAPI.onMessage : browser.runtime.onMessage;
    messageTarget.addListener(messageListener);
  });

  onUnmounted(() => {
    if (messageListener) {
      try {
        const messageTarget = context === 'popup' && browserAPI ? browserAPI.onMessage : browser.runtime.onMessage;
        messageTarget.removeListener(messageListener);
      } catch (err) {
        logger.warn(`[${context}] Failed to remove message listener:`, err);
      }
    }
    if (context === 'sidepanel') {
      pendingRequests.value.clear();
    }
  });

  return {
    // State
    sourceText,
    translatedText,
    sourceLanguage,
    targetLanguage,
    isTranslating,
    isStreaming,
    hasTranslation,
    canTranslate,
    detectedSourceLanguage,
    actualSourceLanguage,
    actualTargetLanguage,
    lastTranslation,
    // Error management
    translationError: errorManager.errorMessage,
    errorType: errorManager.errorType,
    hasError: errorManager.hasError,
    canRetry: errorManager.canRetry,
    canOpenSettings: errorManager.canOpenSettings,
    // Methods
    triggerTranslation,
    cancelTranslation,
    clearTranslation,
    revertTranslation,
    initializeSessionState,
    getRetryCallback: errorManager.getRetryCallback,
    getSettingsCallback: errorManager.getSettingsCallback,
    // Context
    context
  };
}

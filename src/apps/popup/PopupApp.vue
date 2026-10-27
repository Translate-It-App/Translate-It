<template>
  <div class="popup-wrapper">
    <!-- Initial Loading State -->
    <template v-if="isLoading">
      <div class="popup-container">
        <div class="loading-container">
          <LoadingSpinner size="sm" />
          <span class="loading-text">{{ loadingText }}</span>
        </div>
      </div>
    </template>
    
    <!-- Error State Display -->
    <template v-else-if="hasError">
      <div class="popup-container">
        <div class="error-container">
          <div class="error-icon">
            ⚠️
          </div>
          <h2>{{ t('popup_load_error_title') || 'Failed to Load Popup' }}</h2>
          <p class="error-message">
            {{ displayErrorMessage }}
          </p>
          <button
            class="retry-button"
            @click="retryLoading"
          >
            {{ t('retry_button') || 'Retry' }}
          </button>
        </div>
      </div>
    </template>
    
    <!-- Main Popup Content -->
    <template v-else>
      <div class="popup-content-container">
        <!-- Sticky Header: Contains Toolbar and Language/Provider Selectors -->
        <div class="sticky-header">
          <PopupHeader
            :target-language="targetLanguage"
            :provider="currentProvider"
          >
            <PopupViewSwitcher
              v-if="isLiveDubbingSupported"
              :model-value="activeView"
              :show-live-dubbing="isLiveDubbingSupported"
              @update:model-value="handleActiveViewChange"
            />
          </PopupHeader>
        </div>

        <!-- Both panels stay mounted so their local state and listeners survive view switches. -->
        <div
          class="popup-view-stage"
        >
          <div
            class="popup-view-panel popup-view-panel--translate"
            :class="activeView === 'translate' ? 'is-active' : 'is-inactive'"
            :aria-hidden="activeView !== 'translate'"
            :inert="activeView !== 'translate' ? '' : undefined"
          >
            <TranslationView
              ref="translationFormRef"
              :source-language="sourceLanguage"
              :target-language="targetLanguage"
              :current-provider="currentProvider"
              :translation="translation"
              :live-dubbing-busy="isLiveDubbingBusy"
              :is-ready="isReady"
              :source-is-saved-default="sourceIsSavedDefault"
              :target-is-saved-default="targetIsSavedDefault"
              :show-clear-button="showClearButton"
              :source-default-title="sourceDefaultTitle"
              :target-default-title="targetDefaultTitle"
              :last-keyword="lastKeyword"
              @translate="handleTranslate"
              @cancel="handleCancel"
              @clear="handleClearFields"
              @set-default-source="handleSetDefaultSource"
              @set-default-target="handleSetDefaultTarget"
              @can-translate-change="canTranslateFromForm = $event"
              @update:source-language="sourceLanguage = $event"
              @update:target-language="targetLanguage = $event"
              @update:current-provider="currentProvider = $event"
            />
          </div>
          <div
            v-if="isLiveDubbingSupported"
            class="popup-view-panel popup-view-panel--live-dubbing"
            :class="activeView === 'live-dubbing' ? 'is-active' : 'is-inactive'"
            :aria-hidden="activeView !== 'live-dubbing'"
            :inert="activeView !== 'live-dubbing' ? '' : undefined"
          >
            <LiveDubbingView
              :target-language="liveDubbingTargetLanguage"
              :target-language-pending="isLiveDubbingTargetLanguagePending"
              :provider-id="liveDubbingProvider"
              @busy-change="isLiveDubbingBusy = $event"
              @update:target-language="handleLiveDubbingTargetLanguageChange"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import './PopupApp.scss'
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useMessaging } from '@/shared/messaging/composables/useMessaging.js'
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js'
import LoadingSpinner from '@/components/base/LoadingSpinner.vue'
import PopupHeader from '@/components/popup/PopupHeader.vue'
import PopupViewSwitcher from '@/components/popup/PopupViewSwitcher.vue'
import TranslationView from '@/components/popup/TranslationView.vue'
import LiveDubbingView from '@/components/popup/LiveDubbingView.vue'
import browser from 'webextension-polyfill'
import { utilsFactory } from '@/utils/UtilsFactory.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useTTSGlobal } from '@/features/tts/core/TTSGlobalManager.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js'
import { useUnifiedTranslation } from '@/features/translation/composables/useUnifiedTranslation.js';
import { useLanguageDefaults } from '@/features/settings/composables/useLanguageDefaults.js'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingConstants.js';
import { matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { useGlobalFont } from '@/composables/shared/useFont.js';
import { CONFIG } from '@/shared/config/config.js';
import { getCanonicalCode } from '@/shared/config/languageConstants.js'

// --- Initialization & Setup ---
const logger = getScopedLogger(LOG_COMPONENTS.UI, 'PopupApp')
const POPUP_CLEAR_EVENT_SOURCE = 'popup-clear-button'

// Resource tracker for automatic cleanup of timeouts and listeners
const tracker = useResourceTracker('popup-app')

// Global font management
const { applyGlobalCSSVariables } = useGlobalFont()

/**
 * Preload languages on startup in parallel with other initialization tasks
 * to ensure LanguageSelector has cached values immediately
 */
const usePreloadLanguages = async () => {
  const { preloadLanguages } = await import('@/composables/shared/useLanguages.js')
  return preloadLanguages()
}

// Stores & Composables
const settingsStore = useSettingsStore()
const { sendMessage } = useMessaging(MessageContexts.POPUP)
const { handleError } = useErrorHandler()
const { t } = useUnifiedI18n()
const currentProvider = ref('')
const translation = useUnifiedTranslation('popup', { provider: currentProvider });
const {
  sourceLanguage,
  targetLanguage,
  clearTranslation,
  lastTranslation
} = translation;
const lastKeyword = computed(() => lastTranslation.value?.source ?? '');
const {
  savedSourceLanguage,
  savedTargetLanguage,
  isReady,
  setSourceLanguageAsDefault,
  setTargetLanguageAsDefault
} = useLanguageDefaults()
const sourceIsSavedDefault = computed(() => getCanonicalCode(sourceLanguage.value) === getCanonicalCode(savedSourceLanguage.value))
const targetIsSavedDefault = computed(() => getCanonicalCode(targetLanguage.value) === getCanonicalCode(savedTargetLanguage.value))
const showClearButton = computed(() => (
  translation.sourceText.value !== ''
  || translation.translatedText.value !== ''
  || !sourceIsSavedDefault.value
  || !targetIsSavedDefault.value
))
const sourceDefaultTitle = computed(() => t('popup_set_source_language_default_title', 'Set current source language as default'))
const targetDefaultTitle = computed(() => t('popup_set_target_language_default_title', 'Set current target language as default'))

// TTS Global Manager for cross-context lifecycle management
const ttsGlobal = useTTSGlobal({ 
  type: 'popup', 
  name: 'PopupApp'
})

// --- Reactive State ---
const isLoading = ref(true)
const loadingText = ref('Initializing...')
const hasError = ref(false)
const errorMessage = ref('')
const errorType = ref(null)
const canTranslateFromForm = ref(false)
const isLiveDubbingBusy = ref(false)
const liveDubbingTargetLanguage = ref(CONFIG.LIVE_DUBBING_TARGET_LANGUAGE)
const isLiveDubbingTargetLanguagePending = ref(false)
// Active popup view: 'translate' (default) or 'live-dubbing'.
const activeView = ref('translate')
let activeViewPersistenceTail = Promise.resolve()
const isLiveDubbingSupported = typeof __BROWSER__ !== 'undefined' && __BROWSER__ === 'chrome'
const liveDubbingProvider = computed(() => (
  ['gemini', 'openai'].includes(settingsStore.settings?.LIVE_DUBBING_PROVIDER)
    ? settingsStore.settings.LIVE_DUBBING_PROVIDER
    : 'gemini'
))

const isValidActiveView = (value) => value === 'translate'
  || (value === 'live-dubbing' && isLiveDubbingSupported)

const restoreActiveView = () => {
  const persistedView = settingsStore.settings?.POPUP_ACTIVE_VIEW
  activeView.value = isValidActiveView(persistedView) ? persistedView : 'translate'
}

const restoreLiveDubbingTargetLanguage = () => {
  const persistedLanguage = settingsStore.settings?.LIVE_DUBBING_TARGET_LANGUAGE
  liveDubbingTargetLanguage.value = typeof persistedLanguage === 'string' && persistedLanguage
    ? persistedLanguage
    : CONFIG.LIVE_DUBBING_TARGET_LANGUAGE
}

const persistActiveView = (value) => {
  activeViewPersistenceTail = activeViewPersistenceTail
    .then(() => settingsStore.updateSettingAndPersist('POPUP_ACTIVE_VIEW', value))
    .catch((error) => logger.warn('[PopupApp] Failed to persist active view:', error))
}

/** Apply supported switcher changes immediately and persist them opportunistically. */
const handleActiveViewChange = (value) => {
  if (!isValidActiveView(value) || activeView.value === value) return

  activeView.value = value
  persistActiveView(value)
}

/** Persist Live Dubbing's target without changing the Translation target. */
const handleLiveDubbingTargetLanguageChange = async (value) => {
  if (isLiveDubbingTargetLanguagePending.value) return

  const previousValue = liveDubbingTargetLanguage.value
  liveDubbingTargetLanguage.value = value
  isLiveDubbingTargetLanguagePending.value = true

  try {
    await settingsStore.updateSettingAndPersist('LIVE_DUBBING_TARGET_LANGUAGE', value)
  } catch (error) {
    liveDubbingTargetLanguage.value = previousValue
    settingsStore.updateSettingLocally('LIVE_DUBBING_TARGET_LANGUAGE', previousValue)
    logger.warn('[PopupApp] Failed to persist live dubbing target language:', error)
  } finally {
    isLiveDubbingTargetLanguagePending.value = false
  }
}

// Reactive error message display with i18n support
const displayErrorMessage = computed(() => {
  if (!errorType.value) return errorMessage.value;
  const key = errorType.value.startsWith('ERRORS_') ? errorType.value : `ERRORS_${errorType.value}`;
  const translated = t(key);
  return (translated && translated !== key) ? translated : errorMessage.value;
});

// Refs for child component communication
const translationFormRef = ref(null)
let isUnmounted = false

// --- Event Handlers ---

/**
 * Handle translation requests emitted from ProviderSelector
 * @param {Object} data - Contains the provider ID to use
 */
const handleTranslate = (data) => {
  const activeForm = translationFormRef.value;
  if (activeForm && typeof activeForm.triggerTranslation === 'function') {
    // Pass the specific provider if available in the event data
    const providerId = data?.provider || currentProvider.value;
    activeForm.triggerTranslation(providerId);
  }
}

/**
 * Handle cancellation requests emitted from ProviderSelector
 */
const handleCancel = () => {
  const activeForm = translationFormRef.value;
  if (activeForm && typeof activeForm.cancelTranslation === 'function') {
    activeForm.cancelTranslation();
  }
}

/**
 * Handle clear fields request
 */
const handleClearFields = async () => {
  logger.debug('Clearing fields via minimized button');
  const activeElement = document.activeElement;
  await clearTranslation();
  
  // Also dispatch global event if other components rely on it
  const event = new CustomEvent('clear-storage', {
    detail: { source: POPUP_CLEAR_EVENT_SOURCE }
  });
  document.dispatchEvent(event);

  if (
    !isUnmounted
    && activeView.value === 'translate'
    && (
      document.activeElement === activeElement
      || (activeElement?.matches('.ti-btn-min-clear') && document.activeElement === document.body)
    )
  ) {
    translationFormRef.value?.focusSourceInput?.();
  }
}

const handleSetDefaultSource = async () => {
  try {
    await setSourceLanguageAsDefault(sourceLanguage.value)
  } catch (error) {
    await handleError(error, 'popup-set-source-default')
  }
}

const handleSetDefaultTarget = async () => {
  try {
    await setTargetLanguageAsDefault(targetLanguage.value)
  } catch (error) {
    await handleError(error, 'popup-set-target-default')
  }
}

/**
 * Lazy-loaded theme application to reduce initial bundle size
 */
const applyThemeLazy = async (theme) => {
  const { applyTheme } = await utilsFactory.getUIUtils();
  return applyTheme(theme);
};

/**
 * Main initialization sequence for the popup
 */
const initialize = async () => {
  try {
    // Step 1: Set localized loading text
    loadingText.value = t('popup_loading') || 'Loading Popup...'

    // Step 2: Load settings and preload languages in parallel with timeout safety
    await Promise.race([
      Promise.all([
        settingsStore.loadSettings(),
        usePreloadLanguages()
      ]),
      new Promise((_, reject) =>
        tracker.trackTimeout(() => reject(new Error('Settings loading timeout')), 10000)
      )
    ])

    // Restore only after settings have loaded so the initial rendered view never flickers.
    restoreActiveView()
    restoreLiveDubbingTargetLanguage()

    // Step 3: Apply global font variables
    applyGlobalCSSVariables()

    // Step 4: Apply user's theme preference
    const settings = settingsStore.settings
    await applyThemeLazy(settings.THEME)
    
    // Step 4: Initialize session provider from global settings
    if (!currentProvider.value) {
      currentProvider.value = settings.TRANSLATION_API
    }
    await translation.initializeSessionState()

    // Step 5: Global Event Listeners (e.g., clearing fields from other components)
    tracker.addEventListener(document, 'clear-storage', async (event) => {
      if (event.detail?.source === POPUP_CLEAR_EVENT_SOURCE) return;
      await clearTranslation();
    })

    logger.debug('[PopupApp] Popup initialized successfully')

  } catch (error) {
    const isSilent = await handleError(error, 'popup-initialization')
    if (!isSilent) {
      hasError.value = true
      errorMessage.value = error.message || 'Unknown error occurred'
      
      // Attempt to identify error type for better UI feedback
      errorType.value = matchErrorToType(error)
    }
  } finally {
    isLoading.value = false
  }
}

// --- Lifecycle Hooks ---

onMounted(() => {
  /**
   * Register with TTS Global Manager. 
   * This ensures that if the popup closes, any ongoing TTS is stopped.
   */
  ttsGlobal.register(async () => {
    try {
      await sendMessage({ 
        action: MessageActions.TTS_STOP, 
        data: { 
          source: 'popup-cleanup',
          stopOnlyIfOwner: true
        } 
      })
    } catch (error) {
      logger.error('[PopupApp] Failed to stop TTS during cleanup:', error)
    }
  })

  /**
   * Establish a port connection to the background script.
   * Disconnection of this port is the most reliable way to detect popup closure.
   */
  try {
    const port = browser.runtime.connect({ name: 'popup-lifecycle' })
    
    port.postMessage({ action: 'POPUP_OPENED', data: { timestamp: Date.now() } })
    
    window.__popupPort = port
  } catch (error) {
    logger.error('[PopupApp] Failed to establish lifecycle port:', error)
  }
  
  // Start the initialization sequence
  initialize()
})

onUnmounted(() => {
  isUnmounted = true
  logger.debug('[PopupApp] Popup unmounting - cleaning up resources')
  
  // Explicitly disconnect lifecycle port
  if (window.__popupPort) {
    try { window.__popupPort.disconnect() } catch {
      // Ignore disconnect errors as the port might already be closed
    }
    delete window.__popupPort
  }
  
  // Unregister from TTS manager
  ttsGlobal.unregister()
})

/**
 * Handle manual retry attempt on failure
 */
const retryLoading = () => {
  logger.debug('🔄 Retry button clicked! Retrying popup initialization...')
  hasError.value = false
  errorMessage.value = ''
  isLoading.value = true
  
  // Reset settings store state before retrying
  if (settingsStore.$reset) {
    settingsStore.$reset()
  }
  
  tracker.trackTimeout(() => { initialize() }, 100)
}
</script>

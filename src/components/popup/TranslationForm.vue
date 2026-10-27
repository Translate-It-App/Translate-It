<template>
  <form
    class="ti-translation-form"
    @submit.prevent="handleTranslate"
  >
    <!-- Source Input Field -->
    <TranslationInputField
      ref="sourceInputRef"
      v-model="sourceText"
      :placeholder="t('popup_source_text_placeholder') || 'اینجا بنویسید'"
      :language="actualSourceLanguage"
      :detected-source-language="actualSourceLanguage"
      :last-translation="lastTranslation"
      :rows="2"
      :tabindex="1"
      :copy-title="t('popup_copy_source_title_icon') || 'کپی'"
      :copy-alt="t('popup_copy_source_alt_icon') || 'Copy'"
      :tts-title="t('popup_voice_source_title_icon') || 'خواندن متن مبدا'"
      :tts-alt="t('popup_voice_source_alt_icon') || 'Voice Source'"
      :paste-title="t('popup_paste_source_title_icon') || 'چسباندن'"
      :paste-alt="t('popup_paste_source_alt_icon') || 'Paste'"
      :auto-translate-on-paste="settingsStore.settings.AUTO_TRANSLATE_ON_PASTE"
      @translate="handleTranslate"
      @input="handleSourceInput"
      @keydown="handleKeydown"
    />

    <!-- Translation Display -->
    <TranslationDisplay
      :content="translatedText"
      :language="actualTargetLanguage"
      :target-language="actualTargetLanguage"
      :last-translation="lastTranslation"
      :is-loading="isTranslating"
      :is-streaming="isStreaming"
      :error="translationError"
      :error-type="errorType"
      :can-retry="canRetry"
      :can-open-settings="canOpenSettings"
      :on-retry="retryTranslation"
      :on-open-settings="openSettings"
      :placeholder="t('popup_target_text_placeholder') || 'Translation result will appear here'"
      :copy-title="t('popup_copy_target_title_icon') || 'کپی نتیجه'"
      :copy-alt="t('popup_copy_target_alt_icon') || 'Copy Result'"
      :tts-title="t('popup_voice_target_title_icon') || 'خواندن متن مقصد'"
      :tts-alt="t('popup_voice_target_alt_icon') || 'Voice Target'"
      mode="popup"
      :enable-markdown="true"
      :show-fade-in-animation="true"
    />
  </form>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import TranslationInputField from '@/components/shared/TranslationInputField.vue'
import TranslationDisplay from '@/components/shared/TranslationDisplay.vue'

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';

// Import adjacent SCSS
import './TranslationForm.scss';

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'PopupTranslationForm');
const POPUP_CLEAR_EVENT_SOURCE = 'popup-clear-button'

// Resource tracker for memory management
const tracker = useResourceTracker('popup-translation-form');

// Props
const props = defineProps({
  sourceLanguage: {
    type: String,
    required: true
  },
  targetLanguage: {
    type: String,
    required: true
  },
  provider: {
    type: String,
    default: ''
  },
  translation: {
    type: Object,
    required: true
  }
})

// Emits
const emit = defineEmits(['can-translate-change'])

// Stores
const settingsStore = useSettingsStore()

const { handleError } = useErrorHandler()
const { t } = useUnifiedI18n()


// Refs
const sourceInputRef = ref(null)

// State from composables
const {
  sourceText,
  translatedText,
  isTranslating,
  isStreaming,
  translationError,
  errorType,
  canTranslate,
  canRetry,
  canOpenSettings,
  actualSourceLanguage,
  actualTargetLanguage,
  lastTranslation,
  triggerTranslation,
  getRetryCallback,
  getSettingsCallback,
  cancelTranslation,
  clearTranslation,
  revertTranslation: revertCurrentTranslation
} = props.translation

const retryTranslation = getRetryCallback(() => triggerTranslation(
  props.sourceLanguage,
  props.targetLanguage,
  props.provider
))
const openSettings = getSettingsCallback()

// Watch canTranslate and emit changes to parent
watch(canTranslate, (newValue) => {
  emit('can-translate-change', newValue)
}, { immediate: true })

// Watch for source text changes
watch(sourceText, (newValue, oldValue) => {
  if (oldValue !== undefined && newValue !== oldValue) {
    logger.debug("📝 Source text changed:", { length: newValue?.length || 0, preview: newValue?.substring(0, 50) + "..." });
  }
}, { deep: true })

// Methods
const handleSourceInput = (_event) => {
  // Handled by TranslationInputField component
}

const handleKeydown = (_event) => {
  // Handled by TranslationInputField component
}
/**
 * Main translation handler
 * @param {string} [manualProvider] - Optional provider ID to override props.provider
 */
const handleTranslate = async (manualProvider) => {
  logger.debug("Translation button clicked", { manualProvider });
  
  if (!canTranslate.value) {
    logger.debug("Translation skipped - input is empty or invalid");
    return;
  }
  
  try {
    logger.debug("Starting translation process...");
    
    // Use manualProvider if provided, otherwise fallback to props.provider
    const effectiveProvider = (typeof manualProvider === 'string' && manualProvider) ? manualProvider : props.provider;
    
    // Get current language values from props
    const sourceLanguage = props.sourceLanguage;
    const targetLanguage = props.targetLanguage;
    
    logger.debug("Languages:", sourceLanguage, "→", targetLanguage);
    
    // Use composable translation function with determined provider
    logger.debug("Triggering translation...", { provider: effectiveProvider });
    const success = await triggerTranslation(sourceLanguage, targetLanguage, effectiveProvider)    
    
    if (success) {
      logger.info("Translation completed successfully");
    } else {
      logger.debug("Translation failed (handled internally)");
    }

  } catch (error) {
    logger.error("Translation failed:", error);
    await handleError(error, 'popup-translation')
  }
}

const clearStorage = (event) => {
  if (event?.detail?.source === POPUP_CLEAR_EVENT_SOURCE) return;
  clearTranslation()
  lastTranslation.value = null
}

const revertTranslation = () => {
  revertCurrentTranslation()
}


// Event listeners
onMounted(async () => {
  logger.debug("Component mounting...");
  
  // Listen for global events from header component
  tracker.addEventListener(document, 'clear-storage', clearStorage)
  tracker.addEventListener(document, 'revert-translation', revertTranslation)
  tracker.addEventListener(document, 'languages-swapped', () => {
    // Note: We only swap languages, not text content
    // Text content should remain in their respective fields
  })
  
})

// Expose methods and state to parent
defineExpose({
  triggerTranslation: handleTranslate,
  cancelTranslation,
  clearFields: clearStorage,
  focusSourceInput: () => sourceInputRef.value?.focusTextarea(),
  isTranslating
})
</script>

<template>
  <section class="options-tab-content appearance-tab">
    <div class="settings-container">
      <h2>{{ t('appearance_section_title') || 'Appearance' }}</h2>
      
      <!-- Font Settings -->
      <BaseFieldset 
        id="FIELDSET_FONT_SETTINGS"
        :legend="t('font_settings_title') || 'Font Settings'"
      >
        <p class="setting-description">
          {{ t('font_settings_description') || 'Customize the font and size for translation display' }}
        </p>
        <div class="font-selector-wrapper">
          <FontSelector
            ref="fontSelectorRef"
            :font-family="fontFamily"
            :display-font-family="savedFontFamily"
            :font-size="fontSize"
            :target-language="targetLanguage"
            @update:font-family="fontFamily = $event"
            @update:font-size="fontSize = $event"
          >
            <template #after-font-family>
              <div
                id="SELECT_ELEMENT_USE_TRANSLATION_FONT"
                class="ti-translation-font-toggle"
              >
                <span>{{ t('select_element_use_translation_font_label') || 'Use translation font in Select Element' }}</span>
                <BaseToggle v-model="selectElementUseTranslationFont" />
              </div>
              <div
                id="WHOLE_PAGE_USE_TRANSLATION_FONT"
                class="ti-translation-font-toggle"
              >
                <span>{{ t('whole_page_use_translation_font_label') || 'Use translation font in Page Translation' }}</span>
                <BaseToggle v-model="wholePageUseTranslationFont" />
              </div>
              <div
                id="LIVE_DUBBING_USE_TRANSLATION_FONT"
                class="ti-translation-font-toggle"
              >
                <span>{{ t('live_dubbing_use_translation_font_label') || 'Use translation font in Dubbing Subtitles' }}</span>
                <BaseToggle v-model="liveDubbingUseTranslationFont" />
              </div>
            </template>
          </FontSelector>
        </div>
      </BaseFieldset>
      
      <!-- Validation errors -->
      <div
        v-if="validationError"
        class="validation-error"
      >
        {{ validationError }}
      </div>
    </div>
  </section>
</template>

<script setup>
import './AppearanceTab.scss'
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { storageManager } from '@/shared/storage/core/StorageCore.js'
import { CONFIG } from '@/shared/config/config.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useTabSettings } from '../composables/useTabSettings.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { useHighlightManager } from '../composables/useHighlightManager.js'
import { onMounted, onUnmounted } from 'vue'

// Components
import BaseFieldset from '@/components/base/BaseFieldset.vue'
import FontSelector from '@/components/feature/FontSelector.vue'
import BaseToggle from '@/components/base/BaseToggle.vue'

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'AppearanceTab')
const settingsStore = useSettingsStore()
const { highlightElement } = useHighlightManager()
const { t } = useUnifiedI18n()
const { createSetting } = useTabSettings(settingsStore, logger)

// Refs
const fontSelectorRef = ref(null)
const validationError = ref('')

// --- Settings ---

const fontFamily = createSetting('TRANSLATION_FONT_FAMILY', CONFIG.TRANSLATION_FONT_FAMILY, {
  onChanged: () => validateFonts()
})
const savedFontFamily = ref(CONFIG.TRANSLATION_FONT_FAMILY)
let savedFontReadId = 0
let isUnmounted = false

const refreshSavedFontFamily = async () => {
  const readId = ++savedFontReadId
  try {
    const savedSettings = await storageManager.getFresh('TRANSLATION_FONT_FAMILY')
    if (!isUnmounted && readId === savedFontReadId) {
      savedFontFamily.value = savedSettings?.TRANSLATION_FONT_FAMILY ?? CONFIG.TRANSLATION_FONT_FAMILY
    }
  } catch (error) {
    logger.warn('Failed to refresh saved translation font:', error)
  }
}

const handleSavedFontSet = () => { void refreshSavedFontFamily() }

const handleSavedFontChange = () => { void refreshSavedFontFamily() }

const fontSize = createSetting('TRANSLATION_FONT_SIZE', '14', {
  onChanged: () => validateFonts()
})

const selectElementUseTranslationFont = createSetting('SELECT_ELEMENT_USE_TRANSLATION_FONT', false)
const wholePageUseTranslationFont = createSetting('WHOLE_PAGE_USE_TRANSLATION_FONT', false)
const liveDubbingUseTranslationFont = createSetting('LIVE_DUBBING_USE_TRANSLATION_FONT', false)

// Get target language for font preview
const targetLanguage = computed(() => settingsStore.settings?.TARGET_LANGUAGE || 'en')

// Validation logic
const validateFonts = () => {
  if (fontSelectorRef.value?.validate) {
    const isValid = fontSelectorRef.value.validate()
    validationError.value = isValid ? '' : (t('font_validation_failed') || 'Font settings validation failed')
  }
}

// --- Validation Feedback ---

const handleValidationFeedback = (e) => {
  const { field } = e.detail || {};
  if (field === 'font_settings') {
    highlightElement('FIELDSET_FONT_SETTINGS');
    validateFonts(); // Explicitly trigger error message display
  }
};

onMounted(() => {
  isUnmounted = false
  storageManager.on('set:TRANSLATION_FONT_FAMILY', handleSavedFontSet)
  storageManager.on('change:TRANSLATION_FONT_FAMILY', handleSavedFontChange)
  refreshSavedFontFamily()
  window.addEventListener('options-trigger-validation-feedback', handleValidationFeedback);
})

onUnmounted(() => {
  isUnmounted = true
  savedFontReadId++
  storageManager.off('set:TRANSLATION_FONT_FAMILY', handleSavedFontSet)
  storageManager.off('change:TRANSLATION_FONT_FAMILY', handleSavedFontChange)
  window.removeEventListener('options-trigger-validation-feedback', handleValidationFeedback);
})
</script>

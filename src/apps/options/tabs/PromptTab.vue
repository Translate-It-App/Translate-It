<template>
  <section class="options-tab-content prompt-tab">
    <div class="settings-container">
      <h2>{{ t('prompt_section_title') || 'Prompt Template' }}</h2>
      
      <div class="setting-group prompt-template-group vertical">
        <div
          id="PROMPT_SELECTOR_SECTION"
          class="prompt-selector-container"
        >
          <label
            for="prompt-type-select"
            class="setting-label"
          >{{ t('prompt_select_label') || 'Select Prompt to Edit' }}</label>
          <select
            id="prompt-type-select"
            v-model="currentPromptKey"
            class="prompt-type-select"
          >
            <optgroup :label="t('prompt_group_basic') || 'Basic (User Templates)'">
              <option
                v-for="p in basicPrompts"
                :key="p.key"
                :value="p.key"
              >
                {{ t(p.labelKey) || p.key }}
              </option>
            </optgroup>
            <optgroup :label="t('prompt_group_advanced') || 'Advanced (System Base Wrappers)'">
              <option
                v-for="p in advancedPrompts"
                :key="p.key"
                :value="p.key"
              >
                {{ t(p.labelKey) || p.key }}
              </option>
            </optgroup>
          </select>
        </div>

        <div class="prompt-type-help-text">
          {{ t(currentPromptMetadata.descKey) || currentPromptMetadata.descKey }}
        </div>

        <div
          v-if="hasRiskWarning"
          class="prompt-risk-banner"
        >
          <div class="banner-title">
            <span class="icon">⚠️</span>
            <span>{{ t('prompt_risk_warning_title') || 'Advanced Formatting Warning' }}</span>
          </div>
          <div class="banner-content">
            {{ t('prompt_risk_warning_' + currentPromptMetadata.risk.toLowerCase()) || t('prompt_risk_warning_medium') }}
          </div>
        </div>

        <div class="prompt-label-with-button">
          <span class="setting-label">
            {{ t(currentPromptMetadata.labelKey) || currentPromptMetadata.labelKey }}
          </span>
          <button
            type="button"
            class="button-inline"
            @click="resetPrompt"
          >
            {{ t('prompt_reset_button') || 'Reset' }}
          </button>
        </div>
        
        <BaseTextarea
          :id="currentPromptKey"
          v-model="activeTemplateValue"
          :placeholder="t('prompt_template_placeholder') || 'Enter your prompt template here. Use keywords like $_{SOURCE}, $_{TARGET}, and $_{TEXT}.'"
          :rows="10"
          class="prompt-template-input"
          dir="ltr"
        />

        <!-- Validation error -->
        <div
          v-if="validationError"
          class="validation-error"
        >
          {{ validationError }}
        </div>

        <div class="prompt-template-help">
          <p>{{ t('prompt_template_help') || 'You must use the following keywords in your prompt template:' }}</p>
          <ul>
            <li>
              <div class="keyword-box">
                <code dir="ltr">${_SOURCE}</code>
                <span class="lang-name">{{ sourceLanguageName }}</span>
              </div>
              <div class="keyword-desc">
                {{ t('prompt_source_help') || 'Source language.' }}
              </div>
            </li>
            <li>
              <div class="keyword-box">
                <code dir="ltr">${_TARGET}</code>
                <span class="lang-name">{{ targetLanguageName }}</span>
              </div>
              <div class="keyword-desc">
                {{ t('prompt_target_help') || 'Target language.' }}
              </div>
            </li>
            <li>
              <div class="keyword-box">
                <code dir="ltr">${_TEXT}</code>
              </div>
              <div class="keyword-desc">
                {{ t('prompt_text_help') || 'Text to be translated.' }}
              </div>
            </li>
          </ul>
        </div>

        <!-- Preview Prompts Section -->
        <div
          v-if="currentPromptMetadata.previewSupport"
          id="PROMPT_PREVIEW_SECTION"
          class="prompt-preview-section"
        >
          <button
            id="PROMPT_PREVIEW_BUTTON"
            type="button"
            class="prompt-preview-button-action"
            @click="refreshPreview"
          >
            <span class="button-icon">🔍</span>
            <span>{{ t('prompt_preview_button') || 'Preview Generated Prompts' }}</span>
          </button>

          <div
            v-if="showPreview"
            class="prompt-preview-content"
          >
            <div
              v-if="loadingExamples"
              class="loading-indicator"
            >
              <div class="spinner" />
              <span>{{ t('prompt_preview_loading') || 'Generating prompts...' }}</span>
            </div>

            <template v-else>
              <div class="preview-note">
                ℹ️ {{ t('prompt_preview_note') || 'These examples show how your template is used in different translation modes' }}
              </div>

              <div
                v-for="example in promptExamples"
                :key="example.mode"
                class="prompt-example-card"
              >
                <div class="example-header">
                  <span class="example-mode">{{ example.mode }}</span>
                  <span class="example-desc">{{ example.description }}</span>
                </div>
                <pre
                  class="example-prompt"
                  dir="ltr"
                >{{ example.prompt }}</pre>
              </div>
            </template>
          </div>
        </div>
        <div
          v-else-if="!currentPromptMetadata.previewSupport && currentPromptKey !== 'PROMPT_TEMPLATE'"
          class="preview-disabled-note"
        >
          ℹ️ {{ t('prompt_preview_disabled_advanced') || 'Preview is currently only available for Basic user templates.' }}
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import './PromptTab.scss'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useTabSettings } from '../composables/useTabSettings.js'
import { useValidation } from '@/core/validation.js'
import { CONFIG } from '@/shared/config/config.js'
import { useHighlightManager } from '../composables/useHighlightManager.js'
import { usePromptPreview } from '../composables/usePromptPreview.js'
import { PROMPT_REGISTRY, PromptCategory, PromptRisk } from '@/shared/config/PromptRegistry.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

// Components
import BaseTextarea from '@/components/base/BaseTextarea.vue'

const settingsStore = useSettingsStore()
const { t } = useUnifiedI18n()
const logger = getScopedLogger(LOG_COMPONENTS.OPTIONS, 'PromptTab')
const { createSetting } = useTabSettings(settingsStore, logger)
const { validatePromptTemplate: validate, getFirstError, getFirstErrorTranslated, clearErrors } = useValidation()
const { highlightElement } = useHighlightManager()
const { promptExamples, loadingExamples, generateExamples } = usePromptPreview(logger)

// Prompt Classification from Registry
const editablePrompts = Object.values(PROMPT_REGISTRY).filter(p => p.editable)
const basicPrompts = editablePrompts.filter(p => p.category === PromptCategory.USER)
const advancedPrompts = editablePrompts.filter(p => p.category === PromptCategory.SYSTEM)

// Prompt editor selection (Options-page UI state, persisted via settings store).
// Normalized in the getter without side-effects: only editable registry entries
// are effective; stale/invalid persisted values fall back to PROMPT_TEMPLATE.
const selectedPromptKeySetting = createSetting('PROMPT_EDITOR_SELECTED_KEY', CONFIG.PROMPT_EDITOR_SELECTED_KEY || 'PROMPT_TEMPLATE')
const currentPromptKey = computed({
  get: () => {
    const stored = selectedPromptKeySetting.value
    return PROMPT_REGISTRY[stored]?.editable === true ? stored : 'PROMPT_TEMPLATE'
  },
  set: (val) => {
    if (PROMPT_REGISTRY[val]?.editable === true) {
      selectedPromptKeySetting.value = val
    }
  }
})

// Pre-create settings for all editable prompts to ensure reactivity
const promptSettings = {}
editablePrompts.forEach(p => {
  promptSettings[p.key] = createSetting(p.key, CONFIG[p.key])
})

// Metadata for current selection with safety fallback
const currentPromptMetadata = computed(() => PROMPT_REGISTRY[currentPromptKey.value] || PROMPT_REGISTRY.PROMPT_TEMPLATE)
const isAdvancedPrompt = computed(() => currentPromptMetadata.value?.category === PromptCategory.SYSTEM)
const hasRiskWarning = computed(() => currentPromptMetadata.value?.risk && currentPromptMetadata.value?.risk !== PromptRisk.SAFE)

// Validation State
const validationErrorKey = ref('')
const validationError = computed(() => validationErrorKey.value ? getFirstErrorTranslated('promptTemplate', t) : '')

// Computed property for the active textarea binding with safety fallback
const activeTemplateValue = computed({
  get: () => promptSettings[currentPromptKey.value]?.value || '',
  set: (val) => {
    if (promptSettings[currentPromptKey.value]) {
      promptSettings[currentPromptKey.value].value = val
    }
  }
})

// Watch for prompt type switch to clear validation state
watch(currentPromptKey, async () => {
  validationErrorKey.value = ''
  clearErrors()
  
  if (isAdvancedPrompt.value) {
    // Clear stale previews when switching to advanced prompts
    showPreview.value = false
    promptExamples.value = []
  } else if (showPreview.value) {
    await refreshExamples()
  }
})

// Language names for help text
const sourceLanguageName = computed(() => settingsStore.settings?.SOURCE_LANGUAGE || 'Auto')
const targetLanguageName = computed(() => settingsStore.settings?.TARGET_LANGUAGE || 'English')

// Preview State
const showPreview = ref(false)

// Helper to trigger example generation with current UI state
const refreshExamples = async () => {
  await generateExamples({
    template: activeTemplateValue.value,
    templateKey: currentPromptKey.value,
    isAuto: currentPromptKey.value === 'PROMPT_TEMPLATE_AUTO',
    sourceLang: settingsStore.settings?.SOURCE_LANGUAGE,
    targetLang: settingsStore.settings?.TARGET_LANGUAGE,
    t
  })
}

// Refresh preview section
const refreshPreview = async () => {
  showPreview.value = true
  // Perform validation and (re)generate examples
  await validatePrompt()
  await refreshExamples()
}

// Validation feedback listener
const handleValidationFeedback = (e) => {
  const { field, promptKey } = e.detail || {};
  
  if (field === 'prompt' || promptKey) {
    // Switch to specific prompt if provided, otherwise stick to current
    if (promptKey && PROMPT_REGISTRY[promptKey]?.editable === true) {
      currentPromptKey.value = promptKey;
    }

    // Explicitly trigger validation feedback display
    validatePrompt(true);
    
    // Focus and highlight logic
    setTimeout(() => {
      highlightElement(currentPromptKey.value);
    }, 400);
  }
};

// Save feedback listener
const handleSettingsSaved = () => {
  validationErrorKey.value = ''
  clearErrors()
}

onMounted(() => {
  window.addEventListener('options-trigger-validation-feedback', handleValidationFeedback);
  window.addEventListener('options-settings-saved', handleSettingsSaved);
})

onUnmounted(() => {
  window.removeEventListener('options-trigger-validation-feedback', handleValidationFeedback);
  window.removeEventListener('options-settings-saved', handleSettingsSaved);
})

// Validation function
const validatePrompt = async (showFeedback = false) => {
  clearErrors()
  const isValid = await validate(activeTemplateValue.value, currentPromptKey.value)
  
  if (!isValid && showFeedback) {
    validationErrorKey.value = getFirstError('promptTemplate') || ''
  } else if (isValid) {
    validationErrorKey.value = ''
  }
  
  return isValid
}

// Reset prompt to default
const resetPrompt = async () => {
  validationErrorKey.value = ''
  clearErrors()

  const defaultTemplate = CONFIG[currentPromptKey.value]
  activeTemplateValue.value = defaultTemplate
  
  if (showPreview.value && !isAdvancedPrompt.value) {
    await validatePrompt()
    await refreshExamples()
  }

  // Add highlight effect
  const textarea = document.querySelector('.prompt-template-input textarea')
  if (textarea) {
    textarea.classList.add('highlight-on-reset')
    setTimeout(() => {
      textarea.classList.remove('highlight-on-reset')
    }, 800)
  }
}

// Watch for UI language changes to refresh localized labels in examples
watch(() => settingsStore.settings?.APPLICATION_LOCALIZE, async (newVal, oldVal) => {
  if (newVal && oldVal && newVal !== oldVal && showPreview.value && !loadingExamples.value) {
    await refreshExamples()
  }
})
</script>

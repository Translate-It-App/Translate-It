<template>
  <div class="gemini-settings">
    <h3>{{ t('gemini_api_settings_title') || 'Gemini API Settings' }}</h3>
    <div class="setting-group api-key-info">
      <span class="setting-description">
        {{ t('gemini_api_key_info') || 'You can get your Gemini API key from' }}
      </span>
      <a
        class="api-link"
        href="https://aistudio.google.com/app/apikey"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('gemini_api_key_link') || 'Get Your Free API Key' }}
      </a>
    </div>
    <ApiKeyInput
      id="GEMINI_API_KEY"
      v-model="geminiApiKey"
      :label="t('custom_api_settings_api_key_label') || 'API Keys'"
      :placeholder="t('gemini_api_key_placeholder') || 'Enter your API keys (one per line)'"
      :provider-id="ProviderRegistryIds.GEMINI"
      :testing="testingKeys"
      :test-result="testResult"
      @test="testKeys"
    />
    <div class="setting-group vertical">
      <label>{{ t('PROVIDER_MODEL_LABEL') || 'Model' }}</label>
      <BaseSelect
        v-model="geminiModel"
        :options="geminiModelOptions"
        class="model-select"
        :style="rtlSelectStyle"
      />
    </div>
    <div
      v-if="selectedModelOption === 'custom'"
      class="setting-group vertical"
    >
      <label>{{ t('gemini_api_settings_api_url_label') || 'API URL' }}</label>
      <BaseInput
        id="GEMINI_API_URL"
        v-model="geminiApiUrl"
        :placeholder="t('gemini_api_url_placeholder') || 'Enter custom API URL'"
        class="api-url-input"
        dir="ltr"
      />
      <p class="setting-description">
        {{ t('gemini_custom_api_url_info') || 'Enter the complete API URL including the model name' }}
      </p>
    </div>
    <div class="setting-group vertical">
      <label>{{ t('gemini_thinking_mode_label') || 'Thinking Mode' }}</label>
      <BaseSelect
        v-model="geminiThinkingMode"
        :options="geminiThinkingModeOptions"
        class="thinking-mode-select"
        :style="rtlSelectStyle"
      />
      <p class="setting-description">
        {{ t('gemini_thinking_mode_description') || 'Provider Default uses provider behavior. Minimal is applied only when the selected model supports it.' }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import "./GeminiApiSettings.scss"
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { CONFIG } from '@/shared/config/config.js'
import BaseInput from '@/components/base/BaseInput.vue'
import BaseSelect from '@/components/base/BaseSelect.vue'
import ApiKeyInput from './ApiKeyInput.vue'
import { useRTLSelect } from '@/composables/ui/useRTLSelect.js'
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import { presentProviderSettingsError } from '@/features/settings/presentation/ProviderSettingsErrorPresenter.js'

const { t } = useI18n()
const { rtlSelectStyle } = useRTLSelect()

const settingsStore = useSettingsStore()

const geminiApiKey = computed({
  get: () => settingsStore.settings?.GEMINI_API_KEY || '',
  set: (value) => settingsStore.updateSettingLocally('GEMINI_API_KEY', value)
})

const geminiApiUrl = computed({
  get: () => settingsStore.settings?.GEMINI_API_URL || CONFIG.GEMINI_API_URL,
  set: (value) => settingsStore.updateSettingLocally('GEMINI_API_URL', value)
})

// Track dropdown selection separately from stored value
const selectedModelOption = ref(CONFIG.GEMINI_MODEL)

// Initialize selectedModelOption based on current stored value
const initializeModelSelection = () => {
  const currentModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL;
  // If currentModel is 'custom' or not in predefined options, set to 'custom'
  const isPredefined = geminiModelOptions.value.some(option => option.value === currentModel && option.value !== 'custom');
  selectedModelOption.value = (currentModel === 'custom' || !isPredefined) ? 'custom' : currentModel;
}

const geminiModel = computed({
  get: () => selectedModelOption.value,
  set: (value) => {
    selectedModelOption.value = value;
    // Always save the selected value, including 'custom'
    settingsStore.updateSettingLocally('GEMINI_MODEL', value)
  }
})

const geminiThinkingMode = computed({
  get: () => settingsStore.settings?.GEMINI_THINKING_MODE || 'default',
  set: (value) => settingsStore.updateSettingLocally('GEMINI_THINKING_MODE', value)
})

const geminiThinkingModeOptions = computed(() => [
  { value: 'default', label: t('gemini_thinking_mode_default') || 'Provider Default' },
  { value: 'minimal', label: t('gemini_thinking_mode_minimal') || 'Minimal' }
])

// Get model options from settingsStore to maintain consistency with migrations
const geminiModelOptions = computed(() => {
  const models = settingsStore.settings?.GEMINI_MODELS || CONFIG.GEMINI_MODELS || []
  return models.map(model => ({
    value: model.value,
    label: model.name || model.value
  }))
})

// Test keys functionality
const testingKeys = ref(false)
const testResult = ref(null)

const testKeys = async (providerId) => {
  testingKeys.value = true
  testResult.value = null

  try {
    // Test keys directly from textbox value, passing current URL and Model context
    const result = await ApiKeyManager.testKeysDirect(
      geminiApiKey.value, 
      providerId,
      {
        apiUrl: geminiApiUrl.value,
        apiModel: geminiModel.value
      }
    )

    // Store messageKey and params for reactive translation in ApiKeyInput
    testResult.value = {
      allInvalid: result.allInvalid,
      messageKey: result.messageKey,
      params: result.params,
      reorderedString: result.reorderedString
    }

    // Update the local value with the reordered keys
    if (!result.allInvalid && result.reorderedString) {
      settingsStore.updateSettingLocally('GEMINI_API_KEY', result.reorderedString)
    }
  } catch (error) {
    testResult.value = {
      allInvalid: true,
      ...presentProviderSettingsError(error)
    }
  } finally {
    testingKeys.value = false
  }
}

// Initialize model selection on mount
onMounted(() => {
  initializeModelSelection()
})
</script>

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
      <label for="gemini-model-select">{{ t('PROVIDER_MODEL_LABEL') || 'Model' }}</label>
      <BaseSelect
        id="gemini-model-select"
        v-model="geminiModel"
        :options="geminiModelOptions"
        class="model-select"
        :style="rtlSelectStyle"
      />
      <small
        class="model-discovery-status model-discovery-status-warning"
        :class="{ 'model-discovery-status--absent': !savedModelWarningMessage }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{{ savedModelWarningMessage }}</small>
    </div>
    <div class="setting-group vertical">
      <label for="gemini-thinking-mode-select">{{ t('gemini_thinking_mode_label') || 'Thinking Mode' }}</label>
      <BaseSelect
        id="gemini-thinking-mode-select"
        v-model="geminiThinkingMode"
        :options="geminiThinkingModeOptions"
        class="thinking-mode-select"
        :aria-describedby="thinkingModeDescriptionIds"
        :style="rtlSelectStyle"
      />
      <p
        id="gemini-thinking-mode-description"
        class="setting-description"
      >
        {{ t('gemini_thinking_mode_description') || 'Provider Default uses provider behavior. Minimal is applied only when the selected model supports it.' }}
      </p>
      <p
        v-if="showGemmaThinkingGuidance"
        id="gemini-gemma-thinking-guidance"
        class="setting-description"
      >
        {{ t('gemini_gemma_minimal_thinking_guidance') || 'For this Gemma model, Minimal disables thinking and usually provides faster translations with lower token usage.' }}
      </p>
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
      <small
        class="model-discovery-status model-discovery-status-live"
        :class="{ 'model-discovery-status--absent': !discoveryStatusMessage }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{{ discoveryStatusMessage }}</small>
      <template v-if="modelDiscoverySucceeded && discoveredModels.length > 0">
        <small class="model-discovery-status">{{ t('gemini_catalog_official_info') || 'Catalog selection uses Google\'s official Gemini API.' }}</small>
        <ModelCatalogPicker
          v-model="catalogModelSelection"
          :models="discoveredModels"
        />
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import "./GeminiApiSettings.scss"
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { CONFIG } from '@/shared/config/config.js'
import BaseInput from '@/components/base/BaseInput.vue'
import BaseSelect from '@/components/base/BaseSelect.vue'
import ModelCatalogPicker from '@/components/feature/api-settings/ModelCatalogPicker.vue'
import ApiKeyInput from './ApiKeyInput.vue'
import { useRTLSelect } from '@/composables/ui/useRTLSelect.js'
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import { presentProviderSettingsError } from '@/features/settings/presentation/ProviderSettingsErrorPresenter.js'
import {
  fetchGeminiModels,
  getCachedGeminiModels,
  MissingGeminiKeyError,
} from '@/features/translation/providers/GeminiModelDiscovery.js'
import { isOfficialGeminiEndpoint } from '@/features/translation/providers/modelDiscoveryEndpoints.js'
import { GEMINI_MODELS_SUPPORTING_MINIMAL_THINKING } from '@/features/translation/providers/geminiModelCapabilities.js'

const { t } = useI18n()
const { rtlSelectStyle } = useRTLSelect()

const settingsStore = useSettingsStore()

const geminiApiKey = computed({
  get: () => settingsStore.settings?.GEMINI_API_KEY || '',
  set: (value) => settingsStore.updateSettingLocally('GEMINI_API_KEY', value)
})

const geminiApiUrl = computed({
  get: () => settingsStore.settings?.GEMINI_API_URL || CONFIG.GEMINI_API_URL,
  set: (value) => {
    selectionInteraction++
    settingsStore.updateSettingLocally('GEMINI_API_URL', value)
    updateGeminiSourceLocally('custom')
  }
})

const selectedModelOption = ref(CONFIG.GEMINI_MODEL)
const discoveredModels = ref([])
const modelDiscoveryLoading = ref(false)
const modelDiscoveryFailed = ref(false)
const modelDiscoverySucceeded = ref(false)
const hasGeminiKey = computed(() => ApiKeyManager.parseKeys(geminiApiKey.value).length > 0)
// Discovery must never contact Google for a custom endpoint; the shared
// predicate treats an empty/absent stored URL as the official default.
const storedGeminiEndpoint = computed(() => settingsStore.settings?.GEMINI_API_URL || '')
const usesOfficialGeminiEndpoint = computed(() => isOfficialGeminiEndpoint(storedGeminiEndpoint.value))
const showGemmaThinkingGuidance = computed(() => (
  GEMINI_MODELS_SUPPORTING_MINIMAL_THINKING.includes(selectedModelOption.value)
  && (settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE) === 'catalog'
  && usesOfficialGeminiEndpoint.value
))
const thinkingModeDescriptionIds = computed(() => showGemmaThinkingGuidance.value
  ? 'gemini-thinking-mode-description gemini-gemma-thinking-guidance'
  : 'gemini-thinking-mode-description')
let discoveryRequestId = 0
let discoveryTimer
let activeController
let selectionInteraction = 0
let lastObservedModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL
let lastObservedSource = settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE
let lastObservedUrl = settingsStore.settings?.GEMINI_API_URL || CONFIG.GEMINI_API_URL
let externalSelectionInteraction = -1
let externalSelectionModel
let localModelUpdate = false
const updateModelLocally = (value) => {
  localModelUpdate = true
  settingsStore.updateSettingLocally('GEMINI_MODEL', value)
  localModelUpdate = false
}
const updateGeminiSourceLocally = (value) => {
  localModelUpdate = true
  settingsStore.updateSettingLocally('GEMINI_MODEL_SOURCE', value)
  localModelUpdate = false
}

const geminiModelOptions = computed(() => {
  const curated = (CONFIG.GEMINI_MODELS || []).filter(model => model.value !== 'custom')
  const options = curated.map(model => ({ value: model.value, label: model.name || model.value }))
  const savedModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL
  const catalogModel = discoveredModels.value.find(model => model.value === savedModel)
  if (savedModel && savedModel !== 'custom' && !options.some(option => option.value === savedModel)) {
    options.push({
      value: savedModel,
      label: catalogModel ? catalogModel.name : `${savedModel} — ${t('gemini_saved_model_label') || 'Saved model'}`,
      legacy: !catalogModel,
    })
  }
  const custom = (CONFIG.GEMINI_MODELS || []).find(model => model.value === 'custom')
  options.push({ value: 'custom', label: custom?.name || 'Custom Model' })
  return options
})

const savedModelNotAdvertised = computed(() => {
  const savedModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL
  return modelDiscoverySucceeded.value
    && Boolean(savedModel)
    && savedModel !== 'custom'
    && !discoveredModels.value.some(model => model.value === savedModel)
})

// Persistent live-region copy: the DOM element stays mounted and only this
// resolved message changes, so screen readers announce real transitions instead
// of conditional mounts.
const savedModelWarningMessage = computed(() => (
  savedModelNotAdvertised.value
    ? (t('gemini_model_not_listed') || 'Saved model was not listed by Gemini.')
    : ''
))

const discoveryStatusMessage = computed(() => {
  if (!usesOfficialGeminiEndpoint.value) {
    return t('gemini_custom_endpoint_info') || 'Using a custom API URL — Google\'s model catalog is not loaded.'
  }
  if (!hasGeminiKey.value) {
    return t('gemini_models_missing_key') || 'Add an API key to discover available models.'
  }
  if (modelDiscoveryLoading.value) {
    return t('gemini_models_loading') || 'Loading model catalog…'
  }
  if (modelDiscoveryFailed.value) {
    return t('gemini_models_discovery_failed') || 'Could not load Gemini models.'
  }
  if (modelDiscoverySucceeded.value && discoveredModels.value.length === 0) {
    return t('gemini_models_empty') || 'No models were returned by Gemini.'
  }
  return ''
})

// Initialize selectedModelOption based on current stored value
const initializeModelSelection = () => {
  const currentModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL;
  const isPredefined = (CONFIG.GEMINI_MODELS || []).some(option => option.value === currentModel && option.value !== 'custom');
  const isSavedCatalogModel = (settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE) === 'catalog'
    && currentModel !== 'custom'
  selectedModelOption.value = isPredefined || isSavedCatalogModel ? currentModel : 'custom';
}

watch(
  () => [
    settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL,
    settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE,
    settingsStore.settings?.GEMINI_API_URL || CONFIG.GEMINI_API_URL,
  ],
  ([model, source, url]) => {
    const modelOrSourceChanged = model !== lastObservedModel || source !== lastObservedSource
    if (!modelOrSourceChanged && url === lastObservedUrl) return
    lastObservedModel = model
    lastObservedSource = source
    lastObservedUrl = url
    if (!modelOrSourceChanged) return
    if (localModelUpdate) return
    selectionInteraction++
    externalSelectionInteraction = selectionInteraction
    externalSelectionModel = model
    const isCurated = (CONFIG.GEMINI_MODELS || []).some(option => option.value === model && option.value !== 'custom')
    const isCatalog = source === 'catalog' && model !== 'custom'
    selectedModelOption.value = isCurated || isCatalog ? model : 'custom'
  },
  { flush: 'sync' }
)

const geminiModel = computed({
  get: () => selectedModelOption.value,
  set: (value) => {
    selectionInteraction++
    lastObservedModel = value
    selectedModelOption.value = value;
    updateModelLocally(value)
    // Persist only explicit source intent so legacy/custom URL pairs survive upgrades without migrations.
    const isCurated = (CONFIG.GEMINI_MODELS || []).some(model => model.value === value && model.value !== 'custom')
    const isCatalog = discoveredModels.value.some(model => model.value === value)
    updateGeminiSourceLocally(value === 'custom' ? 'custom' : isCurated ? 'curated' : isCatalog ? 'catalog' : 'legacy')
  }
})

const syncSavedSelection = (requestId, key, selectionAtStart) => {
  if (requestId !== discoveryRequestId
    || key !== geminiApiKey.value
    || settingsStore.isSettingDirty('GEMINI_MODEL')
    || (selectionAtStart !== selectionInteraction
      && (externalSelectionInteraction !== selectionInteraction
        || externalSelectionModel !== (settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL)))
    || selectedModelOption.value !== 'custom'
    || (settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE) !== 'catalog') return
  const savedModel = settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL
  if (discoveredModels.value.some(model => model.value === savedModel)) {
    selectedModelOption.value = savedModel
  }
}

const discoverModels = async (apiKey) => {
  const requestId = ++discoveryRequestId
  const key = typeof apiKey === 'string' ? apiKey : ''
  const selectionAtStart = selectionInteraction
  activeController?.abort()
  activeController = null
  if (!ApiKeyManager.parseKeys(key).length) {
    discoveredModels.value = []
    modelDiscoveryLoading.value = false
    modelDiscoveryFailed.value = false
    modelDiscoverySucceeded.value = false
    return
  }
  // Guard before the cache getter: a warm official cache must never leak into a
  // custom-endpoint configuration, and the official host must not be contacted.
  if (!usesOfficialGeminiEndpoint.value) {
    discoveredModels.value = []
    modelDiscoveryLoading.value = false
    modelDiscoveryFailed.value = false
    modelDiscoverySucceeded.value = false
    return
  }
  const cached = getCachedGeminiModels(key)
  modelDiscoveryFailed.value = false
  if (cached !== null) {
    discoveredModels.value = cached
    modelDiscoverySucceeded.value = true
    modelDiscoveryLoading.value = false
    syncSavedSelection(requestId, key, selectionAtStart)
    return
  }
  const controller = new AbortController()
  activeController = controller
  modelDiscoveryLoading.value = true
  try {
    const models = await fetchGeminiModels({ apiKey: key, signal: controller.signal })
    if (requestId !== discoveryRequestId || key !== geminiApiKey.value || !usesOfficialGeminiEndpoint.value) return
    discoveredModels.value = models
    modelDiscoverySucceeded.value = true
    modelDiscoveryFailed.value = false
    syncSavedSelection(requestId, key, selectionAtStart)
  } catch (error) {
    if (requestId !== discoveryRequestId || key !== geminiApiKey.value || !usesOfficialGeminiEndpoint.value) return
    if (error instanceof MissingGeminiKeyError) {
      modelDiscoverySucceeded.value = false
      modelDiscoveryFailed.value = false
      return
    }
    modelDiscoverySucceeded.value = false
    modelDiscoveryFailed.value = true
  } finally {
    if (requestId === discoveryRequestId && key === geminiApiKey.value) modelDiscoveryLoading.value = false
  }
}

const catalogModelSelection = computed({
  get: () => {
    return settingsStore.settings?.GEMINI_MODEL || CONFIG.GEMINI_MODEL
  },
  set: (value) => {
    if (!value) return
    selectionInteraction++
    lastObservedModel = value
    selectedModelOption.value = value
    updateModelLocally(value)
    updateGeminiSourceLocally('catalog')
  }
})

const scheduleDiscovery = (apiKey) => {
  clearTimeout(discoveryTimer)
  discoveryRequestId++
  activeController?.abort()
  activeController = null
  discoveredModels.value = []
  modelDiscoverySucceeded.value = false
  modelDiscoveryFailed.value = false
  const requestId = ++discoveryRequestId
  if (!ApiKeyManager.parseKeys(apiKey).length || !usesOfficialGeminiEndpoint.value) {
    modelDiscoveryLoading.value = false
    return
  }
  modelDiscoveryLoading.value = true
  discoveryTimer = setTimeout(() => {
    if (requestId === discoveryRequestId) discoverModels(apiKey)
  }, 400)
}

watch(geminiApiKey, (apiKey) => {
  scheduleDiscovery(apiKey)
}, { flush: 'sync' })

watch(storedGeminiEndpoint, () => {
  scheduleDiscovery(geminiApiKey.value)
}, { flush: 'sync' })

onBeforeUnmount(() => {
  clearTimeout(discoveryTimer)
  discoveryRequestId++
  activeController?.abort()
  activeController = null
})

const geminiThinkingMode = computed({
  get: () => settingsStore.settings?.GEMINI_THINKING_MODE || 'default',
  set: (value) => settingsStore.updateSettingLocally('GEMINI_THINKING_MODE', value)
})

const geminiThinkingModeOptions = computed(() => [
  { value: 'default', label: t('gemini_thinking_mode_default') || 'Provider Default' },
  { value: 'minimal', label: t('gemini_thinking_mode_minimal') || 'Minimal' }
])

// Test Keys must validate against the same endpoint family translation uses: an
// explicitly selected catalog model translates via the official Gemini endpoint
// only while the stored endpoint is official, so a custom URL stays authoritative
// for validation. Curated/custom/legacy selections keep the stored URL. Read-only:
// never writes settings.
const geminiTestApiUrl = computed(() => {
  const model = selectedModelOption.value
  const source = settingsStore.settings?.GEMINI_MODEL_SOURCE || CONFIG.GEMINI_MODEL_SOURCE
  const isCurated = (CONFIG.GEMINI_MODELS || []).some(option => option.value === model && option.value !== 'custom')
  if (usesOfficialGeminiEndpoint.value && source === 'catalog' && model && model !== 'custom' && !isCurated) {
    return `${CONFIG.GEMINI_API_URL.split('/models/')[0]}/models`
  }
  return geminiApiUrl.value
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
        apiUrl: geminiTestApiUrl.value,
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
  discoverModels(geminiApiKey.value)
})
</script>

<style scoped>
/* Empty persistent live regions stay mounted (a11y tree) but leave no layout gap. */
.model-discovery-status--absent {
  position: absolute;
}
</style>

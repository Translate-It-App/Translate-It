<template>
  <div class="cheaperinference-settings">
    <h3>{{ t('cheaperinference_api_settings_title') || 'Cheaper Inference API Settings' }}</h3>
    <div class="setting-group vertical api-key-info">
      <p class="setting-description">
        {{ t('cheaperinference_api_key_info') || 'Get your Cheaper Inference API key from' }}
      </p>
      <a
        class="api-link"
        href="https://cheaperinference.com"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('cheaperinference_api_key_link') || 'Get Cheaper Inference API Key' }}
      </a>
    </div>
    <ApiKeyInput
      id="CHEAPERINFERENCE_API_KEY"
      v-model="cheaperinferenceApiKey"
      :label="t('custom_api_settings_api_key_label') || 'API Keys'"
      :placeholder="t('cheaperinference_api_key_placeholder') || 'Enter your API keys (one per line)'"
      :provider-id="ProviderRegistryIds.CHEAPERINFERENCE"
      :testing="testingKeys"
      :test-result="testResult"
      @test="testKeys"
    />
    <div class="setting-group vertical">
      <label for="cheaperinference-model-select">{{ t('PROVIDER_MODEL_LABEL') || 'Model' }}</label>
      <BaseSelect
        id="cheaperinference-model-select"
        v-model="cheaperinferenceApiModel"
        :options="cheaperinferenceApiModelOptions"
        class="model-select"
        :style="rtlSelectStyle"
      />
      <div
        class="model-discovery-status-live"
        :class="{ 'ti-sr-only': !savedModelNotAdvertised }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <small
          v-if="savedModelNotAdvertised"
          class="model-discovery-status"
        >{{ t('cheaperinference_model_not_listed') || 'Saved model was not listed by CheaperInference.' }}</small>
      </div>
    </div>
    <div
      v-if="selectedModelOption === 'custom'"
      class="setting-group vertical"
    >
      <label>{{ t('cheaperinference_custom_model_label') || 'Custom Model Name' }}</label>
      <BaseInput
        v-model="cheaperinferenceCustomModel"
        :placeholder="t('cheaperinference_custom_model_placeholder') || 'Enter custom model name (e.g., model-name)'"
        dir="ltr"
      />
    </div>
    <div class="setting-group vertical">
      <div
        class="model-discovery-status-live"
        :class="{ 'ti-sr-only': !catalogStatusVisible }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <small
          v-if="modelDiscoveryLoading"
          class="model-discovery-status"
        >{{ t('cheaperinference_models_loading') || 'Loading model catalog…' }}</small>
        <small
          v-else-if="modelDiscoveryFailed"
          class="model-discovery-status"
        >{{ t('cheaperinference_models_discovery_failed') || 'Could not load Cheaper Inference models.' }}</small>
        <small
          v-else-if="modelDiscoverySucceeded && discoveredModels.length === 0"
          class="model-discovery-status"
        >{{ t('cheaperinference_models_empty') || 'No models were returned by CheaperInference.' }}</small>
      </div>
      <template v-if="modelDiscoverySucceeded && discoveredModels.length > 0">
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
import "./CheaperInferenceApiSettings.scss"
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
  fetchCheaperInferenceModels,
  getCachedCheaperInferenceModels,
} from '@/features/translation/providers/CheaperInferenceModelDiscovery.js'

const { t } = useI18n()
const { rtlSelectStyle } = useRTLSelect()

const settingsStore = useSettingsStore()

const cheaperinferenceApiKey = computed({
  get: () => settingsStore.settings?.CHEAPERINFERENCE_API_KEY || '',
  set: (value) => settingsStore.updateSettingLocally('CHEAPERINFERENCE_API_KEY', value)
})

const selectedModelOption = ref(CONFIG.CHEAPERINFERENCE_API_MODEL)
const discoveredModels = ref([])
const modelDiscoveryLoading = ref(false)
const modelDiscoveryFailed = ref(false)
const modelDiscoverySucceeded = ref(false)
const customModelVisible = ref(false)
let discoveryRequestId = 0
let discoveryTimer
let activeController
let selectionInteraction = 0
let lastObservedModel = settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
let externalSelectionInteraction = -1
let externalSelectionModel
let localModelUpdate = false
const updateModelLocally = (value) => {
  localModelUpdate = true
  settingsStore.updateSettingLocally('CHEAPERINFERENCE_API_MODEL', value)
  localModelUpdate = false
}

const cheaperinferenceApiModelOptions = computed(() => {
  const curated = (CONFIG.CHEAPERINFERENCE_MODELS || []).filter(model => model.value !== 'custom')
  const options = curated.map(model => ({ value: model.value, label: model.name || model.value }))
  const savedModel = settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
  const catalogModel = discoveredModels.value.find(model => model.value === savedModel)
  if (savedModel && savedModel !== 'custom' && !options.some(option => option.value === savedModel)) {
    options.push({
      value: savedModel,
      label: catalogModel ? catalogModel.name : `${savedModel} — ${t('cheaperinference_saved_model_label') || 'Saved model'}`,
      legacy: !catalogModel,
    })
  }
  const custom = (CONFIG.CHEAPERINFERENCE_MODELS || []).find(model => model.value === 'custom')
  options.push({ value: 'custom', label: custom?.name || 'Custom Model' })
  return options
})

const savedModelNotAdvertised = computed(() => {
  const savedModel = settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
  return modelDiscoverySucceeded.value
    && Boolean(savedModel)
    && savedModel !== 'custom'
    && !discoveredModels.value.some(model => model.value === savedModel)
})

// Persistent live region is only placed in flow while it carries a message.
const catalogStatusVisible = computed(() => modelDiscoveryLoading.value
  || modelDiscoveryFailed.value
  || (modelDiscoverySucceeded.value && discoveredModels.value.length === 0))

// Initialize selectedModelOption based on current stored value
const initializeModelSelection = () => {
  const currentModel = settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL;
  const isPredefined = (CONFIG.CHEAPERINFERENCE_MODELS || []).some(option => option.value === currentModel && option.value !== 'custom');
  selectedModelOption.value = isPredefined ? currentModel : 'custom';
  customModelVisible.value = !isPredefined
}

watch(() => settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL, (model) => {
  if (model === lastObservedModel) return
  lastObservedModel = model
  if (localModelUpdate) return
  selectionInteraction++
  externalSelectionInteraction = selectionInteraction
  externalSelectionModel = model
  const isKnown = (CONFIG.CHEAPERINFERENCE_MODELS || []).some(option => option.value === model && option.value !== 'custom')
    || discoveredModels.value.some(option => option.value === model)
  selectedModelOption.value = isKnown ? model : 'custom'
  customModelVisible.value = !isKnown
}, { flush: 'sync' })

const syncSavedSelection = (requestId, key, selectionAtStart) => {
  const savedModel = settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
  const isCurrentExternalSelection = selectionAtStart !== selectionInteraction
    && externalSelectionInteraction === selectionInteraction
    && externalSelectionModel === savedModel
  if (requestId !== discoveryRequestId
    || key !== cheaperinferenceApiKey.value
    || settingsStore.isSettingDirty('CHEAPERINFERENCE_API_MODEL')
    || (selectionAtStart !== selectionInteraction && !isCurrentExternalSelection)
    || selectedModelOption.value !== 'custom') return
  const isPredefined = (CONFIG.CHEAPERINFERENCE_MODELS || []).some(model => model.value === savedModel && model.value !== 'custom')
    || discoveredModels.value.some(model => model.value === savedModel)
  if (isPredefined) {
    selectedModelOption.value = savedModel
    customModelVisible.value = false
  }
}

const discoverModels = async (apiKey, selectionAtStart = selectionInteraction) => {
  const requestId = ++discoveryRequestId
  const key = typeof apiKey === 'string' ? apiKey : ''
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  modelDiscoveryFailed.value = false
  const cached = getCachedCheaperInferenceModels(key)
  if (cached !== null) {
    discoveredModels.value = cached
    modelDiscoverySucceeded.value = true
    modelDiscoveryLoading.value = false
    syncSavedSelection(requestId, key, selectionAtStart)
    return
  }
  modelDiscoveryLoading.value = true
  try {
    const models = await fetchCheaperInferenceModels({ apiKey: key, signal: controller.signal })
    if (requestId !== discoveryRequestId || key !== cheaperinferenceApiKey.value) return
    discoveredModels.value = models
    modelDiscoverySucceeded.value = true
    modelDiscoveryFailed.value = false
    syncSavedSelection(requestId, key, selectionAtStart)
  } catch {
    if (requestId !== discoveryRequestId || key !== cheaperinferenceApiKey.value) return
    modelDiscoverySucceeded.value = false
    modelDiscoveryFailed.value = true
  } finally {
    if (requestId === discoveryRequestId && key === cheaperinferenceApiKey.value) modelDiscoveryLoading.value = false
  }
}

const catalogModelSelection = computed({
  get: () => {
    return settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
  },
  set: (value) => {
    if (!value) return
    selectionInteraction++
    selectedModelOption.value = value
    customModelVisible.value = false
    updateModelLocally(value)
  }
})

watch(cheaperinferenceApiKey, (apiKey) => {
  clearTimeout(discoveryTimer)
  discoveryRequestId++
  activeController?.abort()
  activeController = null
  discoveredModels.value = []
  modelDiscoverySucceeded.value = false
  modelDiscoveryFailed.value = false
  modelDiscoveryLoading.value = false
  const requestId = ++discoveryRequestId
  const scheduledSelection = selectionInteraction
  discoveryTimer = setTimeout(() => {
    if (requestId === discoveryRequestId) discoverModels(apiKey, scheduledSelection)
  }, 400)
}, { flush: 'sync' })

onBeforeUnmount(() => {
  clearTimeout(discoveryTimer)
  discoveryRequestId++
  activeController?.abort()
  activeController = null
})

const cheaperinferenceApiModel = computed({
  get: () => selectedModelOption.value,
  set: (value) => {
    selectionInteraction++
    const wasCustom = selectedModelOption.value === 'custom'
    customModelVisible.value = value === 'custom' && wasCustom ? customModelVisible.value : false
    selectedModelOption.value = value;
    if (value !== 'custom') {
      updateModelLocally(value)
    }
    // If 'custom' is selected, wait for user input in custom field
  }
})

const cheaperinferenceCustomModel = computed({
  get: () => selectedModelOption.value === 'custom' && customModelVisible.value
    ? settingsStore.settings?.CHEAPERINFERENCE_API_MODEL || CONFIG.CHEAPERINFERENCE_API_MODEL
    : '',
  set: (value) => {
    selectionInteraction++
    customModelVisible.value = true
    updateModelLocally(value)
  }
})

// Test keys functionality
const testingKeys = ref(false)
const testResult = ref(null)

const testKeys = async (providerId) => {
  if (!cheaperinferenceApiKey.value.trim()) return

  testingKeys.value = true
  testResult.value = null

  try {
    // Test keys directly from textbox value, passing current Model context
    const result = await ApiKeyManager.testKeysDirect(
      cheaperinferenceApiKey.value, 
      providerId,
      {
        apiModel: cheaperinferenceApiModel.value === 'custom' ? cheaperinferenceCustomModel.value : cheaperinferenceApiModel.value
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
      settingsStore.updateSettingLocally('CHEAPERINFERENCE_API_KEY', result.reorderedString)
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
  discoverModels(cheaperinferenceApiKey.value)
})
</script>

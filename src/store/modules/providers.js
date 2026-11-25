import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { PROVIDER_REGISTRY, PROVIDER_CATEGORIES } from '@/core/provider-registry.js'
import { CONFIG } from '@/shared/config/config.js'

export const useProvidersStore = defineStore('providers', () => {
  // State
  const selectedProvider = ref(CONFIG.TRANSLATION_API)
  
  // Generate available providers from central registry
  const availableProviders = ref(
    PROVIDER_REGISTRY.map(provider => ({
      id: provider.id,
      name: provider.name,
      type: provider.category === PROVIDER_CATEGORIES.AI ? 'ai' : 'free',
      enabled: !provider.needsApiKey // Free providers enabled by default
    }))
  )
  const apiKeys = ref({})
  
  // Getters
  const enabledProviders = computed(() => 
    availableProviders.value.filter(p => p.enabled)
  )
  
  const freeProviders = computed(() => 
    availableProviders.value.filter(p => p.type === 'free')
  )
  
  const aiProviders = computed(() => 
    availableProviders.value.filter(p => p.type === 'ai')
  )
  
  const currentProvider = computed(() => 
    availableProviders.value.find(p => p.id === selectedProvider.value)
  )
  
  // Actions
  const setProvider = (providerId) => {
    const provider = availableProviders.value.find(p => p.id === providerId)
    if (provider && provider.enabled) {
      selectedProvider.value = providerId
    }
  }
  
  const enableProvider = (providerId, enabled = true) => {
    const provider = availableProviders.value.find(p => p.id === providerId)
    if (provider) {
      provider.enabled = enabled
    }
  }
  
  const setApiKey = (providerId, apiKey) => {
    apiKeys.value[providerId] = apiKey
  }
  
  const getApiKey = (providerId) => {
    return apiKeys.value[providerId] || ''
  }
  
  const hasApiKey = (providerId) => {
    return Boolean(apiKeys.value[providerId])
  }
  
  return {
    // State
    selectedProvider,
    availableProviders,
    apiKeys,
    
    // Getters
    enabledProviders,
    freeProviders,
    aiProviders,
    currentProvider,
    
    // Actions
    setProvider,
    enableProvider,
    setApiKey,
    getApiKey,
    hasApiKey
  }
})

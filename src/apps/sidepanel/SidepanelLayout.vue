<template>
  <div
    class="sidepanel-container"
  >
    <!-- Side Toolbar -->
    <SidepanelToolbar 
      v-model:current-provider="globalProvider"
      :is-history-visible="isHistoryVisible"
      @history-toggle="handleHistoryToggle"
      @clear-fields="handleClearFields"
    />

    <!-- Content area -->
    <div class="content-area">
      <!-- Main Content -->
      <SidepanelMainContent
        ref="mainContentRef"
        v-model:provider="manualProvider"
      />

      <!-- History Panel -->
      <SidepanelHistory 
        v-model:is-visible="isHistoryVisible"
        @close="handleHistoryClose"
        @select-history-item="handleHistoryItemSelect"
      />
    </div>

    <!-- Main View Area -->
  </div>
</template>

<script setup>
import './SidepanelLayout.scss'
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { useTranslationStore } from '@/features/translation/stores/translation.js';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useHistory } from '@/features/history/composables/useHistory.js';
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js';
import SidepanelHistory from './components/SidepanelHistory.vue';
import SidepanelMainContent from './components/SidepanelMainContent.vue';
import SidepanelToolbar from './components/SidepanelToolbar.vue';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import browser from 'webextension-polyfill';

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'SidepanelLayout');


// Get stores and composables to sync state
const settingsStore = useSettingsStore()
const { closeHistoryPanel, openHistoryPanel, setHistoryPanelOpen } = useHistory()
const translationStore = useTranslationStore()
useErrorHandler()

// Template refs
const mainContentRef = ref(null);

// Shared state between components
const isHistoryVisible = ref(false)
const globalProvider = ref('')
const manualProvider = ref('')
let pendingHistoryIntentKey = null
let isStorageListenerRegistered = false
let isComponentMounted = true

const consumePendingHistoryIntent = async () => {
  try {
    const session = browser.storage?.session
    if (!isComponentMounted || !session || !pendingHistoryIntentKey) return
    const stored = await session.get(pendingHistoryIntentKey)
    if (stored?.[pendingHistoryIntentKey]?.action !== 'open-history') return
    await session.remove(pendingHistoryIntentKey)
    isHistoryVisible.value = true
    openHistoryPanel()
  } catch (error) {
    logger.warn('[SidepanelLayout] Could not consume pending history intent:', error)
  }
}

const handleStorageChanged = (changes, areaName) => {
  if (areaName === 'session' && changes?.[pendingHistoryIntentKey]?.newValue?.action === 'open-history') {
    void consumePendingHistoryIntent()
  }
}

// Ensure history panel is closed on mount and initialize providers
onMounted(async () => {
  isHistoryVisible.value = false
  setHistoryPanelOpen(false)

  // Wait for settings to load if not already initialized
  if (!settingsStore.isInitialized) {
    await settingsStore.loadSettings()
  }

  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (isComponentMounted && activeTab?.windowId != null) {
      pendingHistoryIntentKey = `__translateItSidepanelPendingIntent:${activeTab.windowId}`
      if (browser.storage?.onChanged?.addListener) {
        browser.storage.onChanged.addListener(handleStorageChanged)
        isStorageListenerRegistered = true
      }
    }
  } catch (error) {
    logger.warn('[SidepanelLayout] Could not determine the side panel window:', error)
  }

  await consumePendingHistoryIntent()

  // Initialize providers from settings
  const defaultProvider = settingsStore.settings.TRANSLATION_API || 'googlev2'
  
  if (!globalProvider.value) {
    globalProvider.value = defaultProvider
  }
  
  if (!manualProvider.value) {
    manualProvider.value = defaultProvider
    logger.debug('[SidepanelLayout] Initialized manual translation provider:', manualProvider.value)
  }

  await mainContentRef.value?.initializeSessionState?.()
})

// Watch for settings changes to keep global provider in sync
watch(() => settingsStore.settings.TRANSLATION_API, (newVal) => {
  if (newVal && newVal !== globalProvider.value) {
    globalProvider.value = newVal
    logger.debug('[SidepanelLayout] Global provider synced with settings change:', newVal)
  }
})

// Sync manual provider whenever global provider changes
watch(globalProvider, (newVal) => {
  if (newVal && newVal !== manualProvider.value) {
    manualProvider.value = newVal
    logger.debug('[SidepanelLayout] Manual provider synced with global change:', newVal)
  }
})

// States
const handleHistoryToggle = (visible) => {
  // Only toggle if the value is actually changing
  if (isHistoryVisible.value !== visible) {
    isHistoryVisible.value = visible
    setHistoryPanelOpen(visible)

    if (visible) {
      openHistoryPanel()
    } else {
      closeHistoryPanel()
    }
  }
}

// Handle history panel close
const handleHistoryClose = () => {
  isHistoryVisible.value = false
  setHistoryPanelOpen(false) // Sync with composable state
  closeHistoryPanel()
}

// Watch for changes in isHistoryVisible and sync with composable
watch(isHistoryVisible, (newVal, oldVal) => {
  if (newVal !== oldVal) {
    setHistoryPanelOpen(newVal)
  }
})

// Handle clear fields event from toolbar
const handleClearFields = () => {
  if (mainContentRef.value && typeof mainContentRef.value.clearFields === 'function') {
    mainContentRef.value.clearFields();
  }
}

// Handle history item selection
const handleHistoryItemSelect = (historyData) => {
  // Update translation store with the selected history item
  translationStore.currentTranslation = {
    sourceText: historyData.sourceText,
    translatedText: historyData.translatedText,
    sourceLanguage: historyData.sourceLanguage,
    targetLanguage: historyData.targetLanguage,
    timestamp: Date.now()
  }

  // Close history panel after selection
  isHistoryVisible.value = false
  closeHistoryPanel()
}




// Lifecycle management
onMounted(() => {
  logger.debug('[SidepanelLayout] Component initialized')
})

onUnmounted(() => {
  isComponentMounted = false
  if (isStorageListenerRegistered) {
    browser.storage?.onChanged?.removeListener?.(handleStorageChanged)
    isStorageListenerRegistered = false
  }
})
</script>

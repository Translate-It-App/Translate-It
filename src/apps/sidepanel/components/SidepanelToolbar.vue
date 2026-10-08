<template>
  <div class="side-toolbar">
    <div class="toolbar-group">
      <button
        v-if="isSelectElementEnabled"
        id="selectElementBtn"
        class="toolbar-button"
        :title="!isSelectElementSupported ? (t('provider_does_not_support_bulk') || 'این سرویس از حالت انتخاب پشتیبانی نمی‌کند') : t('SIDEPANEL_SELECT_ELEMENT_TOOLTIP')"
        :disabled="isActivating || !isSelectElementSupported"
        :class="{ 'ti-active': isSelectModeActive }"
        @click="handleSelectElement"
        @keydown.enter.prevent="handleSelectElement"
        @keydown.space.prevent="handleSelectElement"
      >
        <img
          :src="selectIcon"
          alt="Select Element"
          class="toolbar-icon"
        >
      </button>
      <button
        v-if="isSelectElementEnabled"
        id="revertActionBtn"
        class="toolbar-button"
        :title="t('SIDEPANEL_REVERT_TOOLTIP')"
        @click="handleRevertAction"
        @keydown.enter.prevent="handleRevertAction"
        @keydown.space.prevent="handleRevertAction"
      >
        <img
          :src="revertIcon"
          alt="Revert"
          class="toolbar-icon"
        >
      </button>

      <!-- Mouse Hover Button -->
      <button
        class="toolbar-button"
        :class="{ 'ti-active': isMouseHoverEnabled }"
        :title="isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس')"
        @click="toggleMouseHover"
        @keydown.enter.prevent="toggleMouseHover"
        @keydown.space.prevent="toggleMouseHover"
      >
        <img
          :src="mouseHoverIcon"
          alt="Mouse Hover"
          class="toolbar-icon"
        >
      </button>

      <!-- Page Translation Button -->
      <div 
        v-if="isWholePageEnabled"
        class="toolbar-page-translation"
      >
        <PageTranslationButton 
          compact 
          :target-language="translationStore.uiTargetLanguage"
          :disabled="!isPageTranslationSupported"
        />
      </div>

      <!-- Screen Capture Button -->
      <button
        v-if="isScreenCaptureEnabled"
        id="screenCaptureBtn"
        class="toolbar-button"
        :title="t('SIDEPANEL_SCREEN_CAPTURE_TOOLTIP')"
        @click="handleScreenCapture"
        @keydown.enter.prevent="handleScreenCapture"
        @keydown.space.prevent="handleScreenCapture"
      >
        <img
          :src="captureIcon"
          alt="Screen Capture"
          class="toolbar-icon"
        >
      </button>

      <div class="toolbar-separator" />

      <ProviderSelector
        v-model="currentProviderLocal"
        mode="icon-only"
        :is-global="true"
        only-configured
        @provider-change="handleProviderChange"
      />
      <button
        id="historyBtn"
        class="toolbar-button"
        :title="t('SIDEPANEL_HISTORY_TOOLTIP')"
        :class="{ 'ti-active': isHistoryVisible }"
        @click="handleHistoryClick"
        @keydown.enter.prevent="handleHistoryClick"
        @keydown.space.prevent="handleHistoryClick"
      >
        <img
          src="@/icons/ui/history.svg"
          alt="History"
          class="toolbar-icon"
        >
      </button>
    </div>
    <div class="toolbar-group-bottom">
      <button
        id="pdfBtn"
        class="toolbar-button"
        :title="t('pdf_app_title') || 'PDF Translator'"
        @click="handlePdfClick"
        @keydown.enter.prevent="handlePdfClick"
        @keydown.space.prevent="handlePdfClick"
      >
        <img
          :src="pdfIcon"
          alt="PDF Translator"
          class="toolbar-icon"
        >
      </button>

      <button
        id="subtitleBtn"
        class="toolbar-button"
        :title="t('popup_subtitle_title_icon') || 'ترجمه زیرنویس'"
        @click="handleSubtitleClick"
        @keydown.enter.prevent="handleSubtitleClick"
        @keydown.space.prevent="handleSubtitleClick"
      >
        <img
          :src="subtitleIcon"
          alt=""
          aria-hidden="true"
          class="toolbar-icon"
        >
      </button>

      <button
        id="settingsBtn"
        class="toolbar-button"
        :title="t('SIDEPANEL_SETTINGS_TITLE_ICON')"
        @click="handleSettingsClick"
        @keydown.enter.prevent="handleSettingsClick"
        @keydown.space.prevent="handleSettingsClick"
      >
        <img
          :src="settingsIcon"
          alt="Settings"
          class="toolbar-icon"
        >
      </button>
    </div>
  </div>
</template>

<script setup>
import './SidepanelToolbar.scss'
import { computed } from 'vue';
import { useSelectElementTranslation, useSidepanelActions } from '@/features/translation/composables/useTranslationModes.js';
import { useMouseHoverToggle } from '@/features/mouse-hover/composables/useMouseHoverToggle.js';
import { useTranslationStore } from '@/features/translation/stores/translation.js';
import { useUI } from '@/composables/ui/useUI.js';
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { TranslationMode } from '@/shared/config/config.js';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { sendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { openExtensionApp } from '@/core/ExtensionAppLauncher.js';
import browser from 'webextension-polyfill';

// Icon URLs will be loaded at runtime

// Lazy logger to avoid initialization order issues
let _logger;
const getLogger = () => {
  if (!_logger) {
  _logger = getScopedLogger(LOG_COMPONENTS.UI, 'SidepanelToolbar');
  }
  return _logger;
};

import ProviderSelector from '@/components/shared/ProviderSelector.vue';
import PageTranslationButton from '@/features/page-translation/components/PageTranslationButton.vue';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const props = defineProps({
  isHistoryVisible: {
    type: Boolean,
    default: false
  },
  currentProvider: {
    type: String,
    default: ''
  }
})

// Emits
const emit = defineEmits(['historyToggle', 'update:currentProvider'])

// State
const currentProviderLocal = computed({
  get: () => props.currentProvider,
  set: (value) => emit('update:currentProvider', value)
})

// Resource tracker for automatic cleanup

// Stores
const settingsStore = useSettingsStore();
const translationStore = useTranslationStore();

// Composables
const { t } = useUnifiedI18n()
const { showVisualFeedback } = useUI()
const { isSelectModeActive, activateSelectMode, deactivateSelectMode, isActivating } = useSelectElementTranslation()
const { isMouseHoverEnabled, toggleMouseHover } = useMouseHoverToggle()
const { revertTranslation } = useSidepanelActions()
const { handleError } = useErrorHandler()

// Computed
const isExtensionEnabledGlobal = computed(() => {
  return settingsStore.settings?.EXTENSION_ENABLED ?? true
})

/**
 * Gets the effective provider for a specific mode, accounting for synchronization
 */
const getEffectiveProvider = (mode) => {
  const syncKey = mode === TranslationMode.Page ? 'page' : 'element'
  if (translationStore.ephemeralSync[syncKey] && translationStore.selectedProvider) {
    return translationStore.selectedProvider
  }
  
  // Fallback to mode-specific settings or global provider
  return settingsStore.settings?.MODE_PROVIDERS?.[mode] || 
         props.currentProvider || 
         settingsStore.settings.TRANSLATION_API || 
         'googlev2'
}

/**
 * Checks if the provider for a specific mode supports bulk operations
 */
const supportsBulk = (mode) => {
  const providerId = getEffectiveProvider(mode)
  const provider = findProviderById(providerId)
  return provider?.features?.includes('bulk') ?? true
}

const isSelectElementSupported = computed(() => supportsBulk(TranslationMode.Select_Element))
const isPageTranslationSupported = computed(() => supportsBulk(TranslationMode.Page))

const isSelectElementEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.TRANSLATE_WITH_SELECT_ELEMENT ?? true)
})

const isWholePageEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.WHOLE_PAGE_TRANSLATION_ENABLED ?? true)
})

const isScreenCaptureEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.ENABLE_SCREEN_CAPTURE ?? true)
})

// Icon URLs using runtime.getURL
const selectIcon = browser.runtime.getURL('icons/ui/select.png')
const revertIcon = browser.runtime.getURL('icons/ui/revert.png')
const mouseHoverIcon = browser.runtime.getURL('icons/ui/mouse-hover.png')
const settingsIcon = browser.runtime.getURL('icons/ui/settings.png')
const captureIcon = browser.runtime.getURL('icons/ui/capture.svg')
const subtitleIcon = browser.runtime.getURL('icons/ui/subtitle.svg')
const pdfIcon = browser.runtime.getURL('icons/ui/pdf_viewer/pdf.png')

const handleSelectElement = async () => {
  if (!isSelectElementSupported.value) return

  getLogger().debug('Select Element button clicked! Mode:', isSelectModeActive.value ? 'Deactivating' : 'Activating')

  try {
    // Send request and wait for confirmation from background/content script
    if (isSelectModeActive.value) {
      getLogger().debug('🔄 Deactivating select element mode...')
      const result = await deactivateSelectMode()
      if (result) {
        getLogger().debug('Select element mode deactivated successfully')
        // composable will update shared state; UI follows isSelectModeActive
        showVisualFeedback(document.getElementById('selectElementBtn'), 'success')
      } else {
        getLogger().debug('Select element mode deactivation failed')
        showVisualFeedback(document.getElementById('selectElementBtn'), 'error')
      }
    } else {
      getLogger().debug('Activating select element mode...')
      
      // Resolve provider based on hierarchy:
      // 1. If Sync is ON, use UI's active provider
      // 2. If Sync is OFF, use setting from MODE_PROVIDERS (if not null)
      // 3. Fallback to UI's active provider (legacy behavior)
      let effectiveProvider;
      if (translationStore.ephemeralSync.element && translationStore.selectedProvider) {
        effectiveProvider = translationStore.selectedProvider;
      } else {
        const modeKey = TranslationMode.Select_Element;
        const settingProvider = settingsStore.settings?.MODE_PROVIDERS?.[modeKey];
        effectiveProvider = settingProvider || props.currentProvider;
      }

      const result = await activateSelectMode({ 
        targetLanguage: translationStore.uiTargetLanguage,
        provider: effectiveProvider
      })
      if (result) {
        getLogger().debug('Select element mode activated successfully', { provider: effectiveProvider })
        // composable will update shared state; UI follows isSelectModeActive
        showVisualFeedback(document.getElementById('selectElementBtn'), 'success')
      } else {
        getLogger().debug('Select element mode activation failed')
        showVisualFeedback(document.getElementById('selectElementBtn'), 'error')
      }
    }
  } catch (error) {
    getLogger().error('Select element mode error:', error)
    showVisualFeedback(document.getElementById('selectElementBtn'), 'error')
    await handleError(error, 'SidepanelToolbar-selectElement')
  }
}

const handleRevertAction = async () => {
  getLogger().debug('Revert Action button clicked!')

  try {
    getLogger().debug('[SidepanelToolbar] Executing revert action using composable')

    // Use composable method which handles all error scenarios
    const success = await revertTranslation()

    if (success) {
      getLogger().debug('[SidepanelToolbar] Revert successful')
      showVisualFeedback(document.getElementById('revertActionBtn'), 'success')
    } else {
      getLogger().debug('[SidepanelToolbar] Revert failed or was blocked')
      showVisualFeedback(document.getElementById('revertActionBtn'), 'error')
    }

  } catch (error) {
    getLogger().error('[SidepanelToolbar] Unexpected error in handleRevertAction:', error)
    showVisualFeedback(document.getElementById('revertActionBtn'), 'error')
  }
}

const handleScreenCapture = async () => {
  getLogger().debug('Screen Capture button clicked!')
  try {
    await sendMessage({ action: MessageActions.START_SCREEN_CAPTURE })
    showVisualFeedback(document.getElementById('screenCaptureBtn'), 'success')
  } catch (error) {
    getLogger().error('Screen Capture error:', error)
    showVisualFeedback(document.getElementById('screenCaptureBtn'), 'error')
    await handleError(error, 'SidepanelToolbar-screenCapture')
  }
}

const handleProviderChange = (provider) => {
  getLogger().debug('🔧 Provider changed in sidepanel toolbar to:', provider)
}

const handleHistoryClick = () => {
  emit('historyToggle', !props.isHistoryVisible)
  showVisualFeedback(document.getElementById('historyBtn'), 'success', 300)
}

const handleSettingsClick = async () => {
  getLogger().debug('⚙️ Settings button clicked!')
  try {
    await browser.runtime.openOptionsPage();
    getLogger().debug('Options page opened successfully')
    showVisualFeedback(document.getElementById('settingsBtn'), 'success')
  } catch (error) {
    getLogger().error('Failed to open options page:', error)
    await handleError(error, 'SidepanelToolbar-openSettings')
    showVisualFeedback(document.getElementById('settingsBtn'), 'error')
  }
};

const launchAppWithFeedback = async (appName, buttonId, errorContext) => {
  const button = document.getElementById(buttonId);
  try {
    await openExtensionApp(appName);
    showVisualFeedback(button, 'success');
  } catch (error) {
    getLogger().error(`Failed to launch ${appName} app:`, error);
    await handleError(error, errorContext);
    showVisualFeedback(button, 'error');
  }
};

const handleSubtitleClick = async () => {
  getLogger().debug('Subtitle Translator button clicked!')
  await launchAppWithFeedback('subtitle', 'subtitleBtn', 'SidepanelToolbar-openSubtitle')
};

const handlePdfClick = async () => {
  getLogger().debug('PDF Translator button clicked!')
  await launchAppWithFeedback('pdf', 'pdfBtn', 'SidepanelToolbar-openPdf')
};
</script>

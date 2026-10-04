<template>
  <div class="ti-header-toolbar">
    <div class="ti-header-left">
      <!-- 1. Translate Page (Leftmost, compact icon-only) -->
      <PageTranslationButton
        v-if="isWholePageEnabled"
        :compact="true"
        :target-language="targetLanguage"
        :disabled="!isPageTranslationSupported"
        :show-auto-translate-toggle="true"
        status-badge-position="corner"
        class="ti-page-translate-btn"
      />

      <slot />
    </div>

    <div class="ti-header-actions">
      <!-- DOM order = visual left-to-right order within the right group.
        The flex container is right-aligned via margin-inline-start: auto,
        so the FIRST listed item ends up leftmost and the LAST rightmost.
        Visual right-to-left reading becomes:
        Sidepanel → Select → Revert? → OCR → Mouse Hover → Settings → More -->

      <!-- 2. More menu: Subtitle, PDF always visible; Mouse Hover,
      Screen Capture, Sidepanel as narrow-only duplicates (see SCSS);
      then a separator and the site-scope action as the FINAL item at
      every viewport width. -->
      <ToolbarMenu
        placement="end"
        force-popover
        class="ti-btn-more-menu"
      >
        <template #trigger="{ triggerAttrs, triggerRef, onToggle }">
          <button
            v-bind="triggerAttrs"
            :ref="(el) => triggerRef(el)"
            type="button"
            class="ti-toolbar-button ti-btn-more"
            :aria-label="t('popup_more_actions_title', 'More actions')"
            :title="t('popup_more_actions_title', 'More actions')"
            @click="onToggle"
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </template>
        <template #default="{ close }">
          <button
            type="button"
            role="menuitem"
            class="ti-header-menu-item"
            @click="close(); handleOpenExtensionApp('subtitle')"
          >
            <img
              :src="menuIcon('subtitle.png')"
              alt=""
              aria-hidden="true"
            >
            <span>{{ t('popup_subtitle_title_icon') || 'Subtitle' }}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="ti-header-menu-item"
            @click="close(); handleOpenExtensionApp('pdf')"
          >
            <img
              :src="menuIcon('pdf_viewer/pdf.png')"
              alt=""
              aria-hidden="true"
            >
            <span>{{ t('pdf_app_title') || 'PDF' }}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="ti-header-menu-item"
            @click="close(); handleOpenHistoryInSidePanel()"
          >
            <MaskIcon
              :src="menuIcon('history.svg')"
              :size="18"
            />
            <span>{{ t('SIDEPANEL_HISTORY_TOOLTIP', 'Translation History') }}</span>
          </button>
          <!-- Narrow-width duplicates: hidden at normal widths via
          ti-header-menu-item--narrow-only / --very-narrow-only (see
          PopupHeader.scss breakpoint ownership). They keep Mouse Hover,
          Screen Capture and Sidepanel reachable when their direct buttons
          are CSS-hidden at narrow widths. -->
          <button
            type="button"
            role="menuitem"
            class="ti-header-menu-item ti-header-menu-item--very-narrow-only"
            :class="{ 'is-active': isMouseHoverEnabled }"
            @click="close(); toggleMouseHover()"
          >
            <MaskIcon
              :src="menuIcon('mouse-hover.png')"
              :size="18"
            />
            <span>{{ isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس') }}</span>
          </button>
          <button
            v-if="isScreenCaptureEnabled"
            type="button"
            role="menuitem"
            class="ti-header-menu-item ti-header-menu-item--narrow-only"
            @click="close(); handleScreenCapture()"
          >
            <MaskIcon
              :src="menuIcon('capture.svg')"
              :size="18"
            />
            <span>{{ t('popup_screen_capture_title_icon') || 'تصویربرداری از صفحه' }}</span>
          </button>
          <button
            v-if="!IsMobile"
            type="button"
            role="menuitem"
            class="ti-header-menu-item ti-header-menu-item--narrow-only"
            @click="close(); handleOpenSidePanelNative($event)"
          >
            <MaskIcon
              :src="menuIcon('side-panel.png')"
              :size="18"
            />
            <span>{{ t('popup_open_side_panel_title') || 'باز کردن در پنل کناری' }}</span>
          </button>
          <!-- Grouping: feature actions above, site-scope action below.
          Sits AFTER the responsive duplicates so the site action is the
          final menu action (and this divider its immediate predecessor)
          at every viewport width. -->
          <div
            class="ti-header-menu-separator"
            role="separator"
          />
          <button
            type="button"
            role="menuitem"
            class="ti-header-menu-item"
            @click="close(); handleExcludeToggle()"
          >
            <!-- Decorative exclusion-state indicator (CSS-driven, no
            glyph/asset, non-interactive). Reads CURRENT state: neutral
            outline while the site is enabled, accent fill + CSS check
            while excluded. The label below always describes the ACTION. -->
            <span
              class="ti-header-menu-site-indicator"
              :class="{ 'is-excluded': !isExtensionEnabled }"
              aria-hidden="true"
            />
            <span>{{ isExtensionEnabled ? (t('popup_exclude_disable_label', 'Disable on this site')) : (t('popup_exclude_enable_label', 'Enable on this site')) }}</span>
          </button>
        </template>
      </ToolbarMenu>

      <!-- 3. Settings (pure-black glyph → mask) -->
      <IconButton
        icon="settings.png"
        :alt="t('popup_settings_alt_icon') || 'Settings'"
        :title="t('popup_settings_title_icon') || 'تنظیمات'"
        type="toolbar"
        :mask="true"
        class="ti-btn-settings"
        @click="handleOpenSettings"
      />

      <!-- 4. Mouse Hover (direct action; More duplicate for very-narrow widths) -->
      <IconButton
        icon="mouse-hover.png"
        :alt="isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس')"
        :title="isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس')"
        type="toolbar"
        :mask="true"
        :active="isMouseHoverEnabled"
        class="ti-btn-mouse-hover ti-header-toolbar-button--narrow-hide"
        @click="toggleMouseHover"
      />

      <!-- 5. Screen Capture / OCR (direct action; More duplicate for narrow widths) -->
      <IconButton
        v-if="isScreenCaptureEnabled"
        icon="capture.svg"
        :alt="t('popup_screen_capture_alt_icon') || 'Screen Capture'"
        :title="t('popup_screen_capture_title_icon') || 'تصویربرداری از صفحه'"
        type="toolbar"
        :mask="true"
        class="ti-btn-capture ti-header-toolbar-button--narrow-hide"
        @click="handleScreenCapture"
      />

      <!-- 6. Select Element action + Revert badge: Select is an ordinary
           header button; a small circular Revert badge is absolutely
           anchored over its lower-right corner (no shared hover — each
           control keeps its own emphasis). -->
      <div
        v-if="isSelectElementEnabled"
        class="ti-select-action"
      >
        <button
          type="button"
          class="ti-toolbar-button ti-btn-select"
          :class="{ 'ti-active': isSelectModeActive }"
          :title="selectElementTitle"
          :aria-label="t('popup_select_element_alt_icon') || 'Select Element'"
          :disabled="!isSelectElementSupported"
          :aria-pressed="isSelectModeActive"
          @click="handleSelectElement"
        >
          <MaskIcon
            :src="menuIcon('select.png')"
            :size="22"
            class="ti-toolbar-icon"
          />
        </button>
        <button
          type="button"
          class="ti-btn-revert-badge"
          :title="t('popup_revert_title_icon', 'Revert')"
          :aria-label="t('popup_revert_alt_icon', 'Revert')"
          @click="handleRevert"
        >
          <span
            class="ti-revert-badge-surface"
            aria-hidden="true"
          >
            <MaskIcon
              :src="menuIcon('revert.png')"
              :size="12"
            />
          </span>
        </button>
      </div>

      <!-- 7. Open Sidepanel (rightmost; native listener attached on mount; More duplicate for narrow widths) -->
      <IconButton
        v-if="!IsMobile"
        ref="sidePanelButton"
        icon="side-panel.png"
        :alt="t('popup_open_side_panel_title') || 'Open in side panel'"
        :title="t('popup_open_side_panel_title') || 'باز کردن در پنل کناری'"
        type="toolbar"
        :mask="true"
        class="ti-btn-sidepanel ti-header-toolbar-button--narrow-hide"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSelectElementTranslation } from '@/features/translation/composables/useTranslationModes.js'
import { useMouseHoverToggle } from '@/features/mouse-hover/composables/useMouseHoverToggle.js'
import { useMessaging } from '@/shared/messaging/composables/useMessaging.js'
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useTranslationStore } from '@/features/translation/stores/translation.js'
import { TranslationMode } from '@/shared/config/config.js'
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js'
import browser from 'webextension-polyfill'
import IconButton from '@/components/shared/IconButton.vue'
import MaskIcon from '@/components/shared/MaskIcon.vue'
import ToolbarMenu from '@/components/base/ToolbarMenu/ToolbarMenu.vue'
import ExtensionContextManager from '@/core/extensionContext.js'
import PageTranslationButton from '@/features/page-translation/components/PageTranslationButton.vue'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js'
import { MessageContexts } from '@/shared/messaging/core/MessagingCore.js'
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { getBrowserInfoSync } from '@/utils/browser/compatibility.js'
import { openExtensionApp } from '@/core/ExtensionAppLauncher.js'
import { useResourceTracker } from '@/composables/core/useResourceTracker.js'

// Import adjacent SCSS
import './PopupHeader.scss';

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'PopupHeader');

// Resource tracker for memory management
const tracker = useResourceTracker('popup-header');

// Props
const props = defineProps({
  targetLanguage: {
    type: String,
    default: null
  },
  provider: {
    type: String,
    default: ''
  }
})

// Refs
const sidePanelButton = ref(null)
let activeTabForSidePanel = null

// Stores
const settingsStore = useSettingsStore()
const translationStore = useTranslationStore()

// Composables
const {
  isSelectModeActive,
  toggleSelectElement
} = useSelectElementTranslation()
const { isMouseHoverEnabled, toggleMouseHover } = useMouseHoverToggle()
const { handleError } = useErrorHandler()
const { sendMessage } = useMessaging(MessageContexts.POPUP)
const { t } = useUnifiedI18n()

// State
const isExtensionEnabled = ref(true) // نشان‌دهنده فعال بودن افزونه در صفحه فعلی

/**
 * Resolve a popup menu icon via the extension URL helper.
 * @param {string} name - Icon file path relative to `icons/ui/`
 * @returns {string} Resolved icon URL
 */
const menuIcon = (name) => ExtensionContextManager.safeGetURL(`icons/ui/${name}`)

// Computed
const IsMobile = computed(() => {
  return getBrowserInfoSync().isMobile
})

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

/**
 * Support-aware tooltip for the Select Element main button (title only).
 * The accessible name is always the stable action label (see template),
 * independent of support state.
 */
const selectElementTitle = computed(() => !isSelectElementSupported.value
  ? t(
    'provider_does_not_support_bulk',
    'This provider does not support page/element translation'
  )
  : t(
    'popup_select_element_title_icon',
    'Select Element mode'
  ))

const isSelectElementEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.TRANSLATE_WITH_SELECT_ELEMENT ?? true)
})

const isScreenCaptureEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.ENABLE_SCREEN_CAPTURE ?? true)
})

const isWholePageEnabled = computed(() => {
  return isExtensionEnabledGlobal.value && (settingsStore.settings?.WHOLE_PAGE_TRANSLATION_ENABLED ?? true)
})

// Methods
const handleOpenExtensionApp = async (appName) => {
  const result = await openExtensionApp(appName)

  if (result?.success) {
    window.close()
  }
}

const handleSelectElement = async () => {
  if (!isSelectElementSupported.value) return

  logger.debug('Select Element button clicked!')
  
  try {
    const effectiveProvider = getEffectiveProvider(TranslationMode.Select_Element)

    const success = await toggleSelectElement({ 
      targetLanguage: props.targetLanguage,
      provider: effectiveProvider
    })
    if (success) {
      window.close()
    }
  } catch (error) {
    await handleError(error, 'PopupHeader-selectElement')
  }
}

const handleScreenCapture = async () => {
  logger.debug('Screen Capture button clicked!')
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (activeTab?.id) {
      await sendMessage({
        action: MessageActions.START_SCREEN_CAPTURE,
        data: { tabId: activeTab.id }
      })
      window.close()
    }
  } catch (error) {
    await handleError(error, 'PopupHeader-screenCapture')
  }
}

const handleRevert = async () => {
  try {
    const response = await sendMessage({
      action: MessageActions.REVERT_SELECT_ELEMENT_MODE,
      context: MessageContexts.POPUP,
      messageId: `popup-revert-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
      timestamp: Date.now()
    })

    if (!response?.success && !response?.isRestrictedPage) {
      const errorMsg = response?.error || response?.message || 'Unknown error'
      await handleError(new Error(`Revert failed: ${errorMsg}`), { context: 'popup-header-revert-failed', isSilent: true })
    }
  } catch (error) {
    await handleError(error, { context: 'PopupHeader-revert', isSilent: true })
  }
}

const handleOpenSettings = async () => {
  try {
    await browser.runtime.openOptionsPage()
    window.close()
  } catch (error) {
    await handleError(error, 'PopupHeader-openSettings')
  }
}

const handleExcludeToggle = async () => {
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (activeTab) {
      // Menu-button semantics (no v-model pre-flip like the old checkbox):
      // currently enabled -> exclude it; currently excluded -> re-include it.
      const exclude = isExtensionEnabled.value
      const response = await sendMessage({
        action: MessageActions.Set_Exclude_Current_Page,
        data: { exclude: exclude, url: activeTab.url },
      })
      // Local-state-on-success only: reflect the server's excluded state,
      // never optimistically flip before the background confirms.
      if (response?.success) {
        isExtensionEnabled.value = !(response?.excluded || false)
      }
    }
  } catch (error) {
    await handleError(error, 'PopupHeader-excludeToggle')
  }
}

// Initialize exclude status
onMounted(async () => {
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    activeTabForSidePanel = activeTab || null
    if (activeTab) {
      const response = await sendMessage({
        action: MessageActions.IS_Current_Page_Excluded,
        data: { url: activeTab.url },
      })
      isExtensionEnabled.value = !(response?.excluded || false)
    }
    if (sidePanelButton.value && sidePanelButton.value.$el) {
      tracker.addEventListener(sidePanelButton.value.$el, 'click', handleOpenSidePanelNative, true)
    }
  } catch (error) {
    await handleError(error, 'PopupHeader-getExcludeStatus')
  }
});

onUnmounted(() => {
  if (sidePanelButton.value && sidePanelButton.value.$el) {
    sidePanelButton.value.$el.removeEventListener('click', handleOpenSidePanelNative, true)
  }
})

const handleOpenSidePanelNative = async (event) => {
  event.preventDefault()
  event.stopPropagation()
  try {
    if (browser.sidebarAction) {
      browser.sidebarAction.toggle()
    } else if (browser.sidePanel) {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (activeTab?.id) {
        await browser.sidePanel.open({ tabId: activeTab.id })
      } else {
        await browser.sidePanel.open({})
      }
    }
    window.close()
  } catch (error) {
    await handleError(error, 'PopupHeader-sidePanel')
  }
}

const handleOpenHistoryInSidePanel = async () => {
  const session = browser.storage?.session
  const activeTab = activeTabForSidePanel
  const windowId = activeTab?.windowId
  const key = windowId == null ? null : `__translateItSidepanelPendingIntent:${windowId}`

  if (browser.sidePanel && (!activeTab?.id || !key)) {
    await handleError(new Error('Active tab is unavailable; cannot open History in the Side Panel'), 'PopupHeader-sidePanelHistory')
    return
  }
  if (browser.sidebarAction && !key) {
    await handleError(new Error('Current window is unavailable; cannot open History in the Side Panel'), 'PopupHeader-sidePanelHistory')
    return
  }
  if (!browser.sidePanel && !browser.sidebarAction) {
    await handleError(new Error('Side Panel is unavailable'), 'PopupHeader-sidePanelHistory')
    return
  }

  let intentWrite = Promise.resolve()
  if (session && key) {
    try {
      intentWrite = Promise.resolve(session.set({ [key]: { action: 'open-history' } })).catch((error) => {
        logger.warn('Could not store pending side panel history intent', error)
      })
    } catch (error) {
      logger.warn('Could not store pending side panel history intent', error)
    }
  }

  let nativeOpen
  try {
    nativeOpen = Promise.resolve(browser.sidebarAction
      ? browser.sidebarAction.open()
      : browser.sidePanel.open({ tabId: activeTab.id }))
      .then(() => ({ success: true }), (error) => ({ error }))
  } catch (error) {
    nativeOpen = Promise.resolve({ error })
  }

  const [openResult] = await Promise.all([nativeOpen, intentWrite])
  if (openResult.error) {
    try {
      if (session && key) await session.remove(key)
    } catch (error) {
      logger.warn('Could not remove failed side panel history intent', error)
    }
    await handleError(openResult.error, 'PopupHeader-sidePanelHistory')
    return
  }
  window.close()
}
</script>

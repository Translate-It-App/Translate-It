<template>
  <div class="side-toolbar">
    <div class="toolbar-group">
      <!-- Select + Revert badge pair. The wrapper reserves 24px of block
           space below Select, so the badge's 24x24 target (y34..58) starts
           exactly at Select's bottom edge and never overlaps it: no
           invisible click region is taken from Select, and the target can
           never reach Mouse Hover across any group gap (14px default /
           8px compacted) nor add overflow in the scroll state
           (@max-height 500px). Sibling native buttons, never nested; ids
           and handlers unchanged. -->
      <div
        v-if="isSelectElementEnabled"
        class="toolbar-select-action"
      >
        <button
          id="selectElementBtn"
          type="button"
          class="toolbar-button"
          :title="!isSelectElementSupported ? (t('provider_does_not_support_bulk') || 'این سرویس از حالت انتخاب پشتیبانی نمی‌کند') : t('SIDEPANEL_SELECT_ELEMENT_TOOLTIP')"
          :aria-label="t('SIDEPANEL_SELECT_ELEMENT_TOOLTIP')"
          :disabled="isActivating || !isSelectElementSupported"
          :aria-pressed="isSelectModeActive"
          :class="{ 'ti-active': isSelectModeActive }"
          @click="handleSelectElement"
          @keydown.enter.prevent="handleSelectElement"
          @keydown.space.prevent="handleSelectElement"
        >
          <MaskIcon
            :src="selectIcon"
            class="toolbar-mask-icon"
            :size="22"
          />
        </button>
        <button
          id="revertActionBtn"
          type="button"
          class="toolbar-revert-badge"
          :title="t('SIDEPANEL_REVERT_TOOLTIP')"
          :aria-label="t('SIDEPANEL_REVERT_TOOLTIP')"
          @click="handleRevertAction"
        >
          <span
            class="revert-badge-surface"
            aria-hidden="true"
          >
            <MaskIcon
              :src="revertIcon"
              class="revert-badge-icon"
              :size="12"
            />
          </span>
        </button>
      </div>

      <!-- Mouse Hover Button -->
      <button
        class="toolbar-button"
        :class="{ 'ti-active': isMouseHoverEnabled }"
        :title="isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس')"
        :aria-label="isMouseHoverEnabled ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس')"
        @click="toggleMouseHover"
        @keydown.enter.prevent="toggleMouseHover"
        @keydown.space.prevent="toggleMouseHover"
      >
        <MaskIcon
          :src="mouseHoverIcon"
          class="toolbar-mask-icon"
          :size="22"
        />
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
        :aria-label="t('SIDEPANEL_SCREEN_CAPTURE_TOOLTIP')"
        @click="handleScreenCapture"
        @keydown.enter.prevent="handleScreenCapture"
        @keydown.space.prevent="handleScreenCapture"
      >
        <MaskIcon
          :src="captureIcon"
          class="toolbar-mask-icon"
          :size="22"
        />
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
        :aria-label="t('SIDEPANEL_HISTORY_TOOLTIP')"
        :class="{ 'ti-active': isHistoryVisible }"
        @click="handleHistoryClick"
        @keydown.enter.prevent="handleHistoryClick"
        @keydown.space.prevent="handleHistoryClick"
      >
        <MaskIcon
          :src="historyIcon"
          class="toolbar-mask-icon"
          :size="22"
        />
      </button>
    </div>
    <div class="toolbar-group-bottom">
      <!-- Desktop FAB visibility: first entry of the lower group, so the
           order stays FAB → PDF → Subtitle → Settings. The status comes
           from the content script only — never from settings or storage. -->
      <button
        id="fabVisibilityBtn"
        type="button"
        class="toolbar-button"
        :disabled="isFabToggleDisabled"
        :title="fabToggleTitle"
        :aria-label="fabToggleTitle"
        @click="handleFabToggle"
      >
        <!-- MaskIcon (ADR-001): currentColor glyph. Deliberately NOT given
             .toolbar-icon, whose dark-theme filter would invert a mask. -->
        <MaskIcon
          class="fab-toggle-icon"
          :src="fabToggleIcon"
          :size="22"
        />
      </button>

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
        :aria-label="t('SIDEPANEL_SETTINGS_TITLE_ICON')"
        @click="handleSettingsClick"
        @keydown.enter.prevent="handleSettingsClick"
        @keydown.space.prevent="handleSettingsClick"
      >
        <MaskIcon
          :src="settingsIcon"
          class="toolbar-mask-icon"
          :size="22"
        />
      </button>
    </div>
  </div>
</template>

<script setup>
import './SidepanelToolbar.scss'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useSelectElementTranslation, useSidepanelActions } from '@/features/translation/composables/useTranslationModes.js';
import { useMouseHoverToggle } from '@/features/mouse-hover/composables/useMouseHoverToggle.js';
import { useTranslationStore } from '@/features/translation/stores/translation.js';
import { useUI } from '@/composables/ui/useUI.js';
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { CONFIG, TranslationMode } from '@/shared/config/config.js';
import { getProviderModeValidationError } from '@/features/translation/utils/providerSelection.js';
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
import MaskIcon from '@/components/shared/MaskIcon.vue';
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
         CONFIG.TRANSLATION_API
}

/**
 * Checks if the provider for a specific mode supports bulk operations
 */
const supportsBulk = (mode) => {
  const providerId = getEffectiveProvider(mode)
  return !getProviderModeValidationError(providerId, mode, settingsStore.settings)
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
const historyIcon = browser.runtime.getURL('icons/ui/history.svg')
const subtitleIcon = browser.runtime.getURL('icons/ui/subtitle.svg')
const pdfIcon = browser.runtime.getURL('icons/ui/pdf_viewer/pdf.png')

// ── Desktop FAB visibility ─────────────────────────────────────────────────
// Toolbar-owned state only: the tab this status belongs to, whether a show /
// hide command is outstanding, and a generation token that fences every async
// read/write. Status comes from the content script alone; nothing is inferred
// from settings or storage and nothing is ever written back to them.
const FAB_STATUS = {
  VISIBLE: 'visible',
  HIDDEN: 'hidden',
  LOADING: 'loading',
  UNAVAILABLE: 'unavailable'
}
const FAB_STATUS_VALUES = Object.values(FAB_STATUS)

// Recognized content reason codes → localized explanation. Anything else
// (unknown codes, transport errors) falls back to a generic localized
// sentence: raw error text never reaches title/aria-label.
const FAB_REASON_KEYS = {
  'global-disabled': 'popup_fab_reason_disabled_by_setting',
  fullscreen: 'popup_fab_reason_fullscreen',
  'ui-absent': 'popup_fab_reason_ui_absent',
  'mobile-ui': 'popup_fab_reason_ui_absent'
}
const FAB_REASON_FALLBACKS = {
  popup_fab_reason_disabled_by_setting: 'The Desktop FAB setting hides the floating button here.',
  popup_fab_reason_fullscreen: 'The floating button is hidden while this page is fullscreen.',
  popup_fab_reason_ui_absent: 'The floating button is not available on this page.'
}

// Bounded retry for the transient `loading` a freshly shown FAB reports while
// its content UI mounts. Count-based (not wall-clock) so it can never become
// polling; only `loading` ever schedules it, never `unavailable`.
const FAB_RETRY_DELAY = 150
const FAB_RETRY_MAX = 8

const fabState = ref({ status: FAB_STATUS.LOADING, reason: '' })
const fabCommandsInFlight = reactive(new Set())
// The exact tab the current status was read from, plus the window it lives in
// (used to filter tab events from other side-panel windows).
let fabTarget = null
let fabWindowId = null
let fabGeneration = 0
let fabMounted = false
let fabRetryTimer = null
let fabRetriesLeft = FAB_RETRY_MAX
let fabRetryTargetKey = null

const fabTargetKey = (target) => target
  ? JSON.stringify([target.windowId ?? null, target.tabId, target.url ?? null])
  : null

const fabAdoptTarget = (target) => {
  const key = fabTargetKey(target)
  fabTarget = target
  if (target?.windowId != null) fabWindowId = target.windowId
  if (key !== fabRetryTargetKey) {
    fabRetryTargetKey = key
    fabRetriesLeft = FAB_RETRY_MAX
    fabCancelRetry()
  }
}

const fabIsCurrentTarget = (target) => fabTargetKey(fabTarget) === fabTargetKey(target)

const isFabToggleDisabled = computed(() => {
  const commandPending = Boolean(fabTarget && fabCommandsInFlight.has(fabTargetKey(fabTarget)))
  const statusUnavailable = fabState.value.status !== FAB_STATUS.VISIBLE
    && fabState.value.status !== FAB_STATUS.HIDDEN
  return commandPending || statusUnavailable
})

/** The enabled label names the ACTION; disabled rows explain themselves. */
const fabActionLabel = computed(() => {
  if (fabState.value.status === FAB_STATUS.VISIBLE) return t('popup_fab_hide_label', 'Hide FAB for Now')
  if (fabState.value.status === FAB_STATUS.HIDDEN) return t('popup_fab_show_label', 'Show FAB for Now')
  return ''
})

const fabExplanation = computed(() => {
  if (fabState.value.status === FAB_STATUS.LOADING) {
    return t('popup_fab_loading_reason', 'Reading the floating button’s status…')
  }
  const reasonKey = FAB_REASON_KEYS[fabState.value.reason]
  if (reasonKey) return t(reasonKey, FAB_REASON_FALLBACKS[reasonKey])
  return t(
    'popup_fab_unavailable_reason',
    'The floating button’s status is unavailable on this page.'
  )
})

const fabToggleTitle = computed(() =>
  isFabToggleDisabled.value ? fabExplanation.value : fabActionLabel.value
)

// Eye state mirrors the ACTION: the visible FAB offers "hide", the hidden one
// offers "show" (same mapping as the popup's FAB action).
const fabToggleIcon = computed(() => browser.runtime.getURL(
  fabState.value.status === FAB_STATUS.VISIBLE ? 'icons/ui/eye-hide.svg' : 'icons/ui/eye-open.svg'
))

const fabCancelRetry = () => {
  if (fabRetryTimer !== null) {
    clearTimeout(fabRetryTimer)
    fabRetryTimer = null
  }
}

const fabRetryAllowed = () => fabMounted && document.visibilityState === 'visible'

const fabScheduleRetry = (target) => {
  if (!fabRetryAllowed() || fabRetriesLeft <= 0 || fabRetryTimer !== null) return
  const targetKey = fabTargetKey(target)
  if (!targetKey || targetKey !== fabRetryTargetKey) return
  fabRetriesLeft -= 1
  fabRetryTimer = setTimeout(() => {
    fabRetryTimer = null
    if (!fabRetryAllowed() || targetKey !== fabTargetKey(fabTarget)) return
    void refreshFabStatus()
  }, FAB_RETRY_DELAY)
}

const fabMarkUnavailable = (generation, reason) => {
  if (generation !== fabGeneration) return
  fabState.value = {
    status: FAB_STATUS.UNAVAILABLE,
    reason: typeof reason === 'string' ? reason : ''
  }
}

const fabApply = (generation, target, status, reason) => {
  if (generation !== fabGeneration) return
  // A pending command owns only its target; another active tab remains usable.
  if (fabCommandsInFlight.has(fabTargetKey(target))) return
  fabState.value = { status, reason: typeof reason === 'string' ? reason : '' }
  if (status === FAB_STATUS.LOADING) {
    fabScheduleRetry(target)
  } else {
    fabCancelRetry()
  }
}

/**
 * Read the authoritative status for the active tab of the current window.
 * `keepExistingState` leaves the current row (and its reason) visible while
 * the read runs — used after a failed command so the failure stays readable.
 */
const refreshFabStatus = async ({ keepExistingState = false } = {}) => {
  if (!fabMounted) return
  const generation = ++fabGeneration
  fabCancelRetry()
  if (!keepExistingState) {
    fabState.value = { status: FAB_STATUS.LOADING, reason: '' }
  }

  let tab
  try {
    ;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
  } catch (error) {
    fabMarkUnavailable(generation, error?.message)
    return
  }
  if (generation !== fabGeneration) return
  if (!tab?.id || !tab?.url) {
    fabMarkUnavailable(generation, '')
    return
  }

  const target = { tabId: tab.id, url: tab.url, windowId: tab.windowId }
  fabAdoptTarget(target)

  let reply
  try {
    reply = await browser.tabs.sendMessage(
      target.tabId,
      { action: MessageActions.DESKTOP_FAB_GET_STATUS },
      { frameId: 0 }
    )
  } catch (error) {
    // Restricted page, missing receiver, transport failure → unavailable.
    fabMarkUnavailable(generation, error?.message)
    return
  }
  if (generation !== fabGeneration) return
  // Fail closed: success flag AND exact URL echo…
  if (reply?.success !== true || reply.url !== target.url) {
    fabMarkUnavailable(generation, '')
    return
  }
  // …then re-confirm the target is still the active tab, because a switch to
  // a different tab with the SAME url defeats the sequence token alone.
  let current
  try {
    ;[current] = await browser.tabs.query({ active: true, currentWindow: true })
  } catch (error) {
    fabMarkUnavailable(generation, error?.message)
    return
  }
  if (generation !== fabGeneration) return
  if (!current || current.id !== target.tabId || current.url !== target.url) {
    fabMarkUnavailable(generation, '')
    return
  }

  const status = FAB_STATUS_VALUES.includes(reply.status) ? reply.status : FAB_STATUS.UNAVAILABLE
  fabApply(generation, target, status, reply.reason)
}

/**
 * Show/hide the FAB for the tab the status was read from. The active tab is
 * re-queried first and must match that tab exactly, so a stale row can never
 * drive another tab; whatever the command replies, the visible status comes
 * from a fresh read — never optimistically from the reply.
 */
const handleFabToggle = async () => {
  if (isFabToggleDisabled.value || !fabMounted) return
  const target = fabTarget
  if (!target) return
  const override = fabState.value.status === FAB_STATUS.VISIBLE ? 'hide' : 'show'
  const generation = ++fabGeneration
  const commandKey = fabTargetKey(target)
  fabCancelRetry()
  // Each independent hide/show command gets a fresh bounded budget for the
  // transient `loading` its settling read may report. The shared budget is
  // otherwise only re-armed on target change, so without this repeated
  // same-target toggles would drain one budget and later operations could no
  // longer retry. Still count-based (FAB_RETRY_MAX) — never polling.
  fabRetriesLeft = FAB_RETRY_MAX
  fabCommandsInFlight.add(commandKey)
  fabState.value = { status: FAB_STATUS.LOADING, reason: '' }

  try {
    let tab
    try {
      ;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
    } catch (error) {
      fabMarkUnavailable(generation, error?.message)
      return
    }
    // A newer read (tab switch, navigation) supersedes an unsent command.
    if (generation !== fabGeneration) {
      return
    }
    if (!tab || tab.id !== target.tabId || tab.url !== target.url) {
      // Never control a tab other than the one the status came from.
      return
    }

    let result = null
    let failureReason = ''
    try {
      result = await browser.tabs.sendMessage(
        tab.id,
        {
          action: MessageActions.DESKTOP_FAB_SET_OVERRIDE,
          data: { expectedUrl: target.url, override }
        },
        { frameId: 0 }
      )
    } catch (error) {
      failureReason = error?.message || ''
    }
    const settled = result?.success === true
    if (!settled) {
      // Keep the failure readable while the authoritative re-read runs.
      fabMarkUnavailable(generation, failureReason || result?.reason || '')
    }
  } finally {
    fabCommandsInFlight.delete(commandKey)
    if (fabMounted && fabIsCurrentTarget(target)) {
      void refreshFabStatus({ keepExistingState: true })
    }
  }
}

// ── Tab / panel listeners (side panel persists between uses) ───────────────
const handleTabsActivated = (activeInfo) => {
  if (!fabMounted) return
  if (fabWindowId !== null && activeInfo?.windowId !== fabWindowId) return
  if (fabWindowId !== null && Number.isInteger(activeInfo?.tabId)) {
    const existingUrl = fabTarget?.tabId === activeInfo.tabId ? fabTarget.url : null
    fabAdoptTarget({ tabId: activeInfo.tabId, url: existingUrl, windowId: fabWindowId })
  }
  void refreshFabStatus()
}

const handleTabsUpdated = (tabId, changeInfo, tab) => {
  if (!fabMounted) return
  if (!fabTarget || tabId !== fabTarget.tabId) return
  if (fabWindowId !== null && tab && tab.windowId !== fabWindowId) return
  // Only full navigations change what the FAB means; progress/title noise
  // would otherwise turn every load into extra reads.
  const fullNavigation = typeof changeInfo?.url === 'string' || changeInfo?.status === 'complete'
  if (!fullNavigation) return
  const url = typeof changeInfo?.url === 'string' ? changeInfo.url : tab?.url
  if (typeof url === 'string' && url !== fabTarget.url) {
    fabAdoptTarget({ ...fabTarget, url })
  }
  void refreshFabStatus()
}

// SPA URL changes and hash changes do not reliably reach tabs.onUpdated.
// Registered WITHOUT a filter argument (an empty filter object is rejected
// by Firefox), so both tabId and frameId are checked in the handler.
const handleWebNavigationUpdate = (details) => {
  if (!fabMounted) return
  if (!details || details.frameId !== 0) return
  if (!fabTarget || details.tabId !== fabTarget.tabId) return
  if (fabWindowId !== null && details.windowId != null && details.windowId !== fabWindowId) return
  if (typeof details.url === 'string' && details.url !== fabTarget.url) {
    fabAdoptTarget({ ...fabTarget, url: details.url })
  }
  void refreshFabStatus()
}

const handleVisibilityChange = () => {
  if (!fabMounted) return
  if (document.visibilityState === 'visible') {
    void refreshFabStatus()
  } else {
    // Hidden panel: nobody can see the row, so the retry leash stops.
    fabCancelRetry()
  }
}

const handleWindowFocus = () => {
  if (!fabMounted) return
  if (document.visibilityState === 'visible') void refreshFabStatus()
}

onMounted(() => {
  fabMounted = true
  browser.tabs?.onActivated?.addListener?.(handleTabsActivated)
  browser.tabs?.onUpdated?.addListener?.(handleTabsUpdated)
  browser.webNavigation?.onHistoryStateUpdated?.addListener?.(handleWebNavigationUpdate)
  browser.webNavigation?.onReferenceFragmentUpdated?.addListener?.(handleWebNavigationUpdate)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('focus', handleWindowFocus)
  void refreshFabStatus()
})

onUnmounted(() => {
  fabMounted = false
  // Fences every in-flight read and the retry timer at once.
  fabGeneration += 1
  fabCancelRetry()
  browser.tabs?.onActivated?.removeListener?.(handleTabsActivated)
  browser.tabs?.onUpdated?.removeListener?.(handleTabsUpdated)
  browser.webNavigation?.onHistoryStateUpdated?.removeListener?.(handleWebNavigationUpdate)
  browser.webNavigation?.onReferenceFragmentUpdated?.removeListener?.(handleWebNavigationUpdate)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('focus', handleWindowFocus)
})

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

    if (success === null) return

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

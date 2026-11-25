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
        @open="onMoreMenuOpen"
        @close="onMoreMenuClose"
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
              :src="menuIcon('subtitle.svg')"
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
            v-if="!IsMobile"
            :disabled="!isHistoryPanelReady"
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
          <!-- Desktop FAB visibility: exactly ONE state-dependent action,
          placed above the divider so the site action stays the FINAL item.
          The label flips with the content script's authoritative status;
          while that status is unknown the row is disabled and explains
          itself via title/aria-label instead of guessing from settings. -->
          <button
            v-if="!IsMobile"
            type="button"
            role="menuitem"
            class="ti-header-menu-item ti-header-menu-item--fab"
            :disabled="isFabActionDisabled"
            :title="fabActionTitle"
            :aria-label="fabActionAriaLabel"
            @click="close(); handleFabVisibilityOverride()"
          >
            <MaskIcon
              :src="fabActionIcon"
              :size="18"
            />
            <span>{{ fabActionLabel }}</span>
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
import { CONFIG, TranslationMode } from '@/shared/config/config.js'
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
const activeTabForSidePanel = ref(null)

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

const isHistoryPanelReady = computed(() => {
  const activeTab = activeTabForSidePanel.value
  return Boolean(activeTab?.id) && activeTab?.windowId !== undefined && activeTab?.windowId !== null
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
         CONFIG.TRANSLATION_API
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
  let reportingPartialFailure = false
  try {
    const response = await sendMessage({
      action: MessageActions.REVERT_SELECT_ELEMENT_MODE,
      context: MessageContexts.POPUP,
      messageId: `popup-revert-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
      timestamp: Date.now()
    })

    if (response?.partial) {
      const details = Array.isArray(response.errors)
        ? response.errors.map((item) => {
          if (typeof item === 'string') return item
          if (!item || typeof item !== 'object') return ''
          return [item.system, item.error].filter(Boolean).join(': ')
        }).filter(Boolean).join('; ')
        : ''
      const errorMsg = details || response.message || response.error || 'Some translations could not be reverted'
      reportingPartialFailure = true
      await handleError(new Error(`Revert partially completed: ${errorMsg}`),
        'popup-header-revert-failed', {
          isSilent: true
        })
    } else if (!response?.success && !response?.isRestrictedPage) {
      const errorMsg = response?.error || response?.message || 'Unknown error'
      await handleError(new Error(`Revert failed: ${errorMsg}`), 'popup-header-revert-failed', { isSilent: true })
    }
  } catch (error) {
    if (reportingPartialFailure) return
    if (error?.isRestrictedPage) return
    await handleError(error, 'PopupHeader-revert', { isSilent: true })
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

// ── Desktop FAB per-tab visibility (More menu) ─────────────────────────────
// The content script is the ONLY authority for visible/hidden: the popup
// never infers it from settings or storage. Reads/writes go straight to the
// top frame (frameId 0) and are fenced by a request token, so a late reply
// from a previous open, a previous tab, or an unmounted popup is discarded
// instead of overwriting fresher state.
const FAB_STATUS = {
  VISIBLE: 'visible',
  HIDDEN: 'hidden',
  LOADING: 'loading',
  UNAVAILABLE: 'unavailable'
}
const FAB_STATUS_VALUES = Object.values(FAB_STATUS)

const fabState = ref({ status: FAB_STATUS.LOADING, reason: '' })
// The exact tab the current status was read from (id + URL).
let fabTarget = null
let fabRequestSeq = 0
// True from the moment a show/hide command is issued until its authoritative
// refresh starts. While set, status replies are not applied: a reply that
// predates the write would otherwise re-enable the row with a stale action.
const fabOverrideInFlight = ref(false)
let popupMounted = false
// Mirrors the More menu's open state: the settling retry only runs while the
// FAB row is actually on screen.
const isMoreMenuOpen = ref(false)

// Bounded retry budget for the transient "loading" status a freshly shown
// FAB reports while its content UI mounts. Counted, not timed out against the
// wall clock, so it can never become open-ended polling.
const FAB_SETTLING_RETRY_MS = 150
const FAB_SETTLING_MAX_ATTEMPTS = 8
let fabSettlingRetryTimer = null
let fabSettlingRetriesLeft = FAB_SETTLING_MAX_ATTEMPTS

const cancelFabSettlingRetry = () => {
  if (fabSettlingRetryTimer !== null) {
    tracker.clearTimer(fabSettlingRetryTimer)
    fabSettlingRetryTimer = null
  }
}

const scheduleFabSettlingRetry = () => {
  // Only worth retrying while someone can see the row: an in-flight reply
  // that lands after the menu closed must not re-arm the leash.
  if (!popupMounted || !isMoreMenuOpen.value) return
  if (fabSettlingRetriesLeft <= 0 || fabSettlingRetryTimer !== null) return
  fabSettlingRetriesLeft -= 1
  fabSettlingRetryTimer = tracker.trackTimeout(() => {
    fabSettlingRetryTimer = null
    if (!popupMounted || !isMoreMenuOpen.value) return
    void readFabStatus()
  }, FAB_SETTLING_RETRY_MS)
}

const isFabActionDisabled = computed(() =>
  fabOverrideInFlight.value ||
  (fabState.value.status !== FAB_STATUS.VISIBLE && fabState.value.status !== FAB_STATUS.HIDDEN)
)

const fabActionLabel = computed(() => {
  if (fabState.value.status === FAB_STATUS.VISIBLE) {
    return t('popup_fab_hide_label', 'Hide FAB for Now')
  }
  if (fabState.value.status === FAB_STATUS.HIDDEN) {
    return t('popup_fab_show_label', 'Show FAB for Now')
  }
  return t('popup_fab_unknown_label', 'Floating button')
})

/**
 * Recognized content-script reason codes → localized explanation keys.
 * Anything not listed here (including raw browser error messages) falls back
 * to a generic localized sentence: the content side's codes and transport
 * failures are internal detail and never reach title/aria-label verbatim.
 */
const FAB_REASON_KEYS = {
  'global-disabled': 'popup_fab_reason_disabled_by_setting',
  'fullscreen': 'popup_fab_reason_fullscreen',
  'ui-absent': 'popup_fab_reason_ui_absent',
  'mobile-ui': 'popup_fab_reason_ui_absent'
}
const FAB_REASON_FALLBACKS = {
  popup_fab_reason_disabled_by_setting: 'The Desktop FAB setting hides the floating button here.',
  popup_fab_reason_fullscreen: 'The floating button is hidden while this page is fullscreen.',
  popup_fab_reason_ui_absent: 'The floating button is not available on this page.'
}

/**
 * Localized explanation for the disabled row. Order matters: the static
 * global EXTENSION_ENABLED gate and the in-flight read are named first, then
 * a recognized content reason, then one generic localized fallback.
 */
const fabActionExplanation = computed(() => {
  if (!isExtensionEnabledGlobal.value) {
    return t(
      'popup_fab_disabled_reason',
      'The floating button is unavailable while the extension is disabled.'
    )
  }
  if (fabState.value.status === FAB_STATUS.LOADING) {
    return t('popup_fab_loading_reason', 'Reading the floating button’s status…')
  }
  const reasonKey = FAB_REASON_KEYS[fabState.value.reason]
  if (reasonKey) {
    return t(reasonKey, FAB_REASON_FALLBACKS[reasonKey])
  }
  return t(
    'popup_fab_unavailable_reason',
    'The floating button’s status is unavailable on this page.'
  )
})

const fabActionTitle = computed(() =>
  isFabActionDisabled.value ? fabActionExplanation.value : fabActionLabel.value
)

// Only the disabled row overrides its accessible name (its visible label is
// a neutral placeholder there); the enabled row keeps the visible text.
const fabActionAriaLabel = computed(() =>
  isFabActionDisabled.value ? fabActionExplanation.value : undefined
)

// Eye state mirrors the ACTION (hide the visible FAB / show the hidden one).
const fabActionIcon = computed(() =>
  menuIcon(fabState.value.status === FAB_STATUS.VISIBLE ? 'eye-hide.svg' : 'eye-open.svg')
)

const markFabUnavailable = (seq, reason) => {
  if (seq !== fabRequestSeq) return
  fabState.value = {
    status: FAB_STATUS.UNAVAILABLE,
    reason: typeof reason === 'string' ? reason : ''
  }
}

const applyFabSnapshot = (snapshot, seq) => {
  if (seq !== fabRequestSeq) return
  // A pending override owns the row: a reply issued before the write landed
  // must never re-enable it with a stale action.
  if (fabOverrideInFlight.value) return
  const status = FAB_STATUS_VALUES.includes(snapshot?.status)
    ? snapshot.status
    : FAB_STATUS.UNAVAILABLE
  fabState.value = {
    status,
    reason: typeof snapshot?.reason === 'string' ? snapshot.reason : ''
  }
  if (status === FAB_STATUS.LOADING) {
    // Transient only (e.g. a freshly shown FAB still mounting its UI):
    // retry on a short leash until it settles or the budget runs out.
    scheduleFabSettlingRetry()
  } else {
    fabSettlingRetriesLeft = FAB_SETTLING_MAX_ATTEMPTS
    cancelFabSettlingRetry()
  }
}

/**
 * Fail closed: a reply only counts when the content script reports success
 * AND echoes the exact URL of the tab the read was addressed to. Missing
 * `url`, malformed payloads, and `success:false` are all treated as no read.
 */
const isFabStatusSnapshotValid = (snapshot, target) =>
  snapshot?.success === true && snapshot.url === target.url

/**
 * Re-read the active tab AFTER an async status reply and report whether that
 * reply still addresses it. The sequence token alone cannot catch a switch to
 * a different tab with the same URL, so identity is re-checked here. Any
 * change — or a stale/failing tab query — disables the row instead of showing
 * a label for a tab the user has left. Deliberately no retry: the popup's
 * short lifecycle means the next open re-reads, so a false label never
 * survives an unanswered question.
 */
const isFabTargetStillActive = async (seq, target) => {
  let current
  try {
    ;[current] = await browser.tabs.query({ active: true, currentWindow: true })
  } catch (error) {
    markFabUnavailable(seq, error?.message)
    return false
  }
  if (seq !== fabRequestSeq) return false
  if (!current || current.id !== target.id || current.url !== target.url) {
    markFabUnavailable(seq, '')
    return false
  }
  return true
}

/** Validate a read, then confirm the target is still active before applying. */
const acceptFabStatusSnapshot = async (snapshot, seq, target) => {
  if (seq !== fabRequestSeq) return
  if (!isFabStatusSnapshotValid(snapshot, target)) {
    markFabUnavailable(seq, '')
    return
  }
  if (!(await isFabTargetStillActive(seq, target))) return
  applyFabSnapshot(snapshot, seq)
}

/** Read the authoritative FAB status for the current active tab (top frame). */
const readFabStatus = async () => {
  const seq = ++fabRequestSeq
  fabTarget = null
  fabState.value = { status: FAB_STATUS.LOADING, reason: '' }

  // Global disable is a hard gate, not a per-tab status: no query, no wire.
  if (!isExtensionEnabledGlobal.value) {
    markFabUnavailable(seq, '')
    return
  }

  let tab
  try {
    ;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
  } catch (error) {
    markFabUnavailable(seq, error?.message)
    return
  }
  if (seq !== fabRequestSeq) return
  if (!tab?.id || !tab?.url) {
    markFabUnavailable(seq, '')
    return
  }

  fabTarget = { id: tab.id, url: tab.url }
  try {
    const snapshot = await browser.tabs.sendMessage(
      tab.id,
      { action: MessageActions.DESKTOP_FAB_GET_STATUS },
      { frameId: 0 }
    )
    // Fails closed on malformed/unsuccessful replies and on an active tab
    // that moved on while the read was in flight.
    await acceptFabStatusSnapshot(snapshot, seq, fabTarget)
  } catch (error) {
    // Restricted page, missing receiver, or transport failure.
    markFabUnavailable(seq, error?.message)
  }
}

const onMoreMenuOpen = () => {
  isMoreMenuOpen.value = true
  // A fresh open supersedes any settling retry; if the read it triggers lands
  // on transient loading again, the retry is re-armed from there.
  cancelFabSettlingRetry()
  void readFabStatus()
}

const onMoreMenuClose = () => {
  isMoreMenuOpen.value = false
  // Nobody is looking: stop the retry leash. A reply still in flight cannot
  // re-arm it (scheduleFabSettlingRetry checks this flag).
  cancelFabSettlingRetry()
}

/**
 * A command abandoned BEFORE it was sent may have swallowed the read that
 * superseded it: the override owns the row until this handler ends, so that
 * read's reply was dropped. Leave exactly one fresh authoritative read behind
 * so the row cannot strand on loading. Reads still in flight for the old state
 * are discarded by the sequence this read takes.
 */
const refreshIfOverrideSuperseded = (seq) => {
  if (popupMounted && seq !== fabRequestSeq) void readFabStatus()
}

/**
 * Show/hide the FAB for the tab the status was read from. The active tab is
 * re-queried first and must match that tab exactly, so a stale row can never
 * drive another tab; the result is then re-read rather than applied
 * optimistically. While the command is outstanding the row stays disabled and
 * no status reply is applied, so reopening the menu mid-write can never show a
 * pre-write action; the write's own authoritative refresh always follows.
 */
const handleFabVisibilityOverride = async () => {
  if (isFabActionDisabled.value) return
  const target = fabTarget
  if (!target) {
    markFabUnavailable(++fabRequestSeq, '')
    return
  }
  const override = fabState.value.status === FAB_STATUS.VISIBLE ? 'hide' : 'show'
  const seq = ++fabRequestSeq
  cancelFabSettlingRetry()
  fabOverrideInFlight.value = true
  fabState.value = { status: FAB_STATUS.LOADING, reason: '' }
  let refreshAfterOverride = false

  try {
    let tab
    try {
      ;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
    } catch (error) {
      markFabUnavailable(seq, error?.message)
      refreshIfOverrideSuperseded(seq)
      return
    }
    // A newer read (menu reopen) supersedes a command not sent yet.
    if (seq !== fabRequestSeq) {
      refreshIfOverrideSuperseded(seq)
      return
    }
    if (!tab || tab.id !== target.id || tab.url !== target.url) {
      // The tab (or its URL) moved on: never control an old tab, refresh instead.
      void readFabStatus()
      return
    }

    let result
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
      markFabUnavailable(seq, error?.message)
      refreshAfterOverride = seq !== fabRequestSeq
      return
    }
    if (!result?.success) {
      markFabUnavailable(seq, result?.reason)
      refreshAfterOverride = seq !== fabRequestSeq
      return
    }

    // The write landed. Refresh the ACTIVE tab's authoritative status even if
    // a newer menu-open read already ran — its reply may predate the write.
    // readFabStatus takes a fresh sequence, so anything still in flight for
    // the old state is discarded, and its own tab/URL and mount fences apply.
    refreshAfterOverride = true
  } finally {
    fabOverrideInFlight.value = false
    if (refreshAfterOverride && popupMounted) void readFabStatus()
  }
}

// Initialize exclude status
onMounted(async () => {
  popupMounted = true
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    activeTabForSidePanel.value = activeTab || null
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
  // Fence any in-flight FAB reply: a late response must not resurrect state.
  popupMounted = false
  cancelFabSettlingRetry()
  fabRequestSeq += 1
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
  if (!isHistoryPanelReady.value) return

  const session = browser.storage?.session
  const activeTab = activeTabForSidePanel.value
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

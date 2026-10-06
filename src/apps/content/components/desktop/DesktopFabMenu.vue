<template>
  <div
    v-if="isReady && !isFullscreen"
    ref="fabContainerRef"
    class="desktop-fab-container notranslate"
    :class="[
      settingsStore.isDarkTheme ? 'theme-dark' : 'theme-light',
      side === 'right' ? 'is-right' : 'is-left',
      { 'is-positioning': isPositioning }
    ]"
    translate="no"
    :style="containerStyle"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- Revert Action (Small Badge Button) -->
    <Transition
      name="fade-scale"
      :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
    >
      <div 
        v-if="mobileStore.hasElementTranslations && (isHovered || isMenuOpen)" 
        class="fab-revert-badge"
        :title="t('desktop_fab_revert_tooltip')"
        :style="{ 'transform': getBadgeTransform(isHovered || isMenuOpen, isRevertHovered) }"
        @click.stop="handleRevert"
        @mouseenter="isRevertHovered = true"
        @mouseleave="isRevertHovered = false"
      >
        <img
          :src="IconRevert"
          :alt="t('desktop_fab_revert_tooltip')"
        >
      </div>
    </Transition>

    <!-- Menu -->
    <Transition
      name="fab-menu"
      :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
    >
      <div
        v-if="isMenuOpen"
        class="desktop-fab-menu"
      >
        <template
          v-for="(item, index) in menuItems"
          :key="item.id"
        >
          <!-- Divider -->
          <div
            v-if="index > 0"
            class="fab-menu-divider"
          />

          <div 
            class="fab-menu-item"
            :class="{ 
              'is-disabled': item.disabled,
              'is-hovered': hoveredItemIndex === index
            }"
            @click.stop="item.disabled ? null : handleMenuItemClick(item)"
            @mouseenter="hoveredItemIndex = index"
            @mouseleave="hoveredItemIndex = -1"
          >
            <div class="menu-icon-wrapper">
              <!-- Circle Progress for Page Translation -->
              <svg
                v-if="item.showProgress"
                class="fab-circle-progress"
                viewBox="0 0 32 32"
              >
                <circle
                  class="progress-bg"
                  cx="16"
                  cy="16"
                  r="14"
                  fill="none"
                  stroke-width="3"
                />
                <circle 
                  class="progress-fill" 
                  cx="16" 
                  cy="16" 
                  r="14" 
                  fill="none" 
                  stroke-width="3" 
                  stroke-dasharray="88" 
                  :stroke-dashoffset="88 - (88 * item.percent) / 100" 
                />
              </svg>

              <img 
                v-if="item.icon" 
                :src="item.icon" 
                :alt="item.label" 
                class="fab-menu-icon"
                :class="{ 'is-colored': item.id === 'translate_page' || item.id === 'translate_selection' }"
              >
            </div>
            <span class="fab-menu-item-text">
              {{ item.label }}
            </span>

            <!-- Secondary Action (Auto-Translate Star Toggle) -->
            <button
              v-if="item.secondaryAction"
              ref="scopeTrigger"
              class="fab-menu-item-secondary-btn"
              :class="{ 
                'is-active': item.secondaryAction.active,
                'is-disabled': item.secondaryAction.disabled
              }"
              :title="item.secondaryAction.title"
              :aria-label="item.secondaryAction.title"
              :aria-expanded="scopeMenuOpen"
              @click.stop="toggleScopeDisclosure"
            >
              <svg 
                viewBox="0 0 24 24" 
                width="15" 
                height="15" 
                class="secondary-action-svg"
              >
                <path 
                  :fill="item.secondaryAction.active ? 'currentColor' : 'none'" 
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
                />
              </svg>
            </button>
            <div
              v-if="item.secondaryAction && scopeMenuOpen"
              class="fab-auto-translate-scopes"
              role="group"
              :aria-label="t('auto_translate_scope_menu_label', 'Auto-translate on future visits')"
              @click.stop
              @keydown.escape.stop="onScopeGroupKeydown"
            >
              <button
                ref="firstScopeAction"
                :aria-pressed="hasPageRule"
                @click.stop="scopeActions.togglePageScope()"
              >
                <span>{{ hasPageRule ? '✓' : '' }}</span>{{ t('auto_translate_scope_this_page', 'This Page') }}
              </button>
              <button
                v-if="siteScopeAvailable"
                :aria-pressed="hasSiteRule"
                @click.stop="scopeActions.toggleSiteScope()"
              >
                <span>{{ hasSiteRule ? '✓' : '' }}</span>{{ t('auto_translate_scope_this_site', 'This Site') }}
              </button>
              <template v-if="showManageRules">
                <hr class="fab-scope-separator">
                <div class="fab-scope-note">
                  {{ t('auto_translate_scope_covered_note', 'Already covered by a broader rule') }}
                </div>
                <button
                  class="fab-scope-link"
                  @click.stop="openManageRules"
                >
                  {{ t('auto_translate_manage_rules', 'Manage Rules') }}
                </button>
              </template>
            </div>
          </div>
        </template>
      </div>
    </Transition>

    <!-- Main Button -->
    <div
      class="desktop-fab-button"
      :class="{ 
        'is-open': isMenuOpen, 
        'is-dragging': isDragging,
        'has-status': pageTranslationStatus.isActive
      }"
      :title="t('desktop_fab_tooltip')"
      :style="mainButtonStyle"
      @mousedown="startDrag"
      @touchstart.passive="startDrag"
      @click.stop="toggleMenu"
    >
      <img
        :src="IconExtension"
        :alt="t('desktop_fab_alt')"
      >

      <!-- Page Translation Status Badge (Bottom) -->
      <Transition
        name="fade-scale"
        :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
      >
        <PageTranslationStatus 
          v-if="pageTranslationStatus.isActive" 
          mode="desktop-fab" 
        />
      </Transition>

      <!-- Pending Selection Badge (Top) -->
      <Transition
        name="fade-scale"
        :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
      >
        <div 
          v-if="pendingSelection.hasSelection && (pendingSelection.mode === SelectionTranslationMode.ON_FAB_CLICK || !isTextSelectionEnabled)"
          class="fab-translate-badge"
          @click.stop="triggerTranslation"
        >
          <div class="fab-badge-pulse-glow" />
          <div class="white-dot" />
        </div>
      </Transition>
    </div>

    <!-- Settings Button -->
    <Transition
      name="fade-scale"
      :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
    >
      <div 
        v-if="isMenuOpen" 
        class="fab-settings-badge"
        :title="t('desktop_fab_settings_tooltip')"
        :style="{ 
          '--badge-bottom-offset': (isTTSActive && (isHovered || isMenuOpen) ? 'calc(-2 * var(--badge-offset))' : 'calc(-1 * var(--badge-offset))'),
          'transform': getBadgeTransform(isHovered || isMenuOpen, isSettingsHovered)
        }"
        @click.stop="handleOpenSettings"
        @mouseenter="isSettingsHovered = true"
        @mouseleave="isSettingsHovered = false"
      >
        <img
          :src="IconSettings"
          :alt="t('desktop_fab_settings_tooltip')"
        >
      </div>
    </Transition>

    <!-- TTS Button -->
    <Transition
      name="fade-scale"
      :duration="{ enter: ANIMATION_CONFIG.MENU_ENTER }"
    >
      <div 
        v-if="isTTSActive && (isHovered || isMenuOpen)" 
        class="fab-tts-badge"
        :class="{ 'is-playing': ttsState === 'playing', 'is-loading': ttsState === 'loading' }"
        :title="ttsTooltip"
        :style="{ 
          '--badge-bottom-offset': 'calc(-1 * var(--badge-offset))', 
          'transform': getBadgeTransform(isHovered || isMenuOpen, isTTSHovered)
        }"
        @click.stop="handleTTS"
        @mouseenter="isTTSHovered = true"
        @mouseleave="isTTSHovered = false"
      >
        <!-- Loading Spinner SVG -->
        <svg
          v-if="ttsState === 'loading'"
          class="fab-tts-icon ti-loading-spin"
          viewBox="0 0 24 24"
          width="16"
          height="16"
        >
          <path
            fill="currentColor"
            d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"
          />
          <path
            fill="currentColor"
            opacity="0.5"
            d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
          />
        </svg>

        <!-- Stop Icon SVG -->
        <svg
          v-else-if="ttsState === 'playing'"
          class="fab-tts-icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
        >
          <path
            fill="currentColor"
            d="M6 6h12v12H6z"
          />
        </svg>

        <!-- Idle Speaker Icon -->
        <img
          v-else
          :src="IconTTS"
          :alt="t('desktop_fab_tts_tooltip')"
          class="fab-tts-icon"
        >
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { injectStylesToShadowRoot } from '@/utils/ui/styleInjector.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { sendMessage, sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { useMobileStore } from '@/store/modules/mobile.js';
import useSettingsStore from '@/features/settings/stores/settings.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { TRANSLATION_STATUS } from '@/shared/constants/translation.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { getDesktopFabPositionAsync, TranslationMode, SelectionTranslationMode } from '@/shared/config/config.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { useTTSSmart } from '@/features/tts/composables/useTTSSmart.js';
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js';
import { useMouseHoverToggle } from '@/features/mouse-hover/composables/useMouseHoverToggle.js';
import useFabSelection from '@/apps/content/composables/useFabSelection.js';
import ExclusionChecker from '@/features/exclusion/core/ExclusionChecker.js';
import PageTranslationStatus from '@/components/shared/PageTranslationStatus.vue';
import { deviceDetector } from '@/utils/browser/compatibility.js';
import { getLanguageNameFromCode } from '@/shared/config/languageConstants.js';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { useAutoTranslateRules } from '@/features/page-translation/composables/useAutoTranslateRules.js';
import './DesktopFabMenu.scss';

import IconExtension from '@/icons/extension/extension_icon_64.svg';
import IconSelectElement from '@/icons/ui/select.png';
import IconTranslatePage from '@/icons/ui/whole-page.png';
import IconScreenCapture from '@/icons/ui/capture.svg';
import IconRevert from '@/icons/ui/revert.png';
import IconRestore from '@/icons/ui/restore.png';
import IconHourglass from '@/icons/ui/hourglass.png';
import IconSettings from '@/icons/ui/settings.png';
import IconTranslateSelection from '@/icons/ui/translate.png';
import IconMouseHover from '@/icons/ui/mouse-hover.png';
import IconTTS from '@/icons/ui/speaker.png';

const logger = getScopedLogger(LOG_COMPONENTS.DESKTOP_FAB, 'Menu');
const mobileStore = useMobileStore();
const settingsStore = useSettingsStore();
const { t } = useUnifiedI18n();
const { handleError } = useErrorHandler();
const tracker = useResourceTracker('desktop-fab-menu');
const tts = useTTSSmart();
const { isMouseHoverEnabled, toggleMouseHover } = useMouseHoverToggle();
const exclusionChecker = ExclusionChecker.getInstance();

const sendPageCommand = (message) => {
  void sendRegularMessage(message, { returnFailureResponse: true })
    .then((response) => {
      if (response?.success === false) {
        logger.debug('Page translation command rejected', response);
      }
    })
    .catch((error) => {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'desktop-fab:page-translation');
      } else {
        logger.warn('Page translation command failed:', error);
      }
    });
};

const allowedFeatures = ref({
  selectElement: true,
  pageTranslation: true,
  screenCapture: true
});

const updateAllowedFeatures = async () => {
  const status = await exclusionChecker.getFeatureStatus();
  if (status.initialized) {
    allowedFeatures.value.selectElement = status.features.selectElement?.allowed ?? true;
    allowedFeatures.value.pageTranslation = status.features.pageTranslation?.allowed ?? true;
    allowedFeatures.value.screenCapture = status.features.screenCapture?.allowed ?? true;
    logger.debug('FAB allowed features updated', allowedFeatures.value);
  }
};

const ANIMATION_CONFIG = {
  MOVE_IN: '0.4s',
  MOVE_OUT: '1.0s',
  FADE_IN: '0.2s',
  FADE_OUT: '1.0s',
  QUICK_FADE: '0.3s',
  MENU_ENTER: 400,
  SOFT_EASING: 'cubic-bezier(0.22, 1, 0.36, 1)',
  STANDARD_EASING: 'ease',
  IDLE_TIMEOUT: 500,
  LEAVE_DELAY: 400,
  OPACITY_FULL: 1
};

const fabIdleOpacity = computed(() => (settingsStore.settings?.FAB_IDLE_OPACITY ?? 20) / 100);
const fabScale = computed(() => settingsStore.settings?.FAB_SIZE || '1');

const isMenuOpen = ref(false);
const isFaded = ref(true);
const isHovered = ref(false);
const isReady = ref(false);
const isPositioning = ref(true);
const isViewportUnstable = ref(false);
const isRevertHovered = ref(false);
const isSettingsHovered = ref(false);
const isTTSHovered = ref(false);
const hoveredItemIndex = ref(-1);

// Track the specific TTS request started by this component instance
const localTTSId = ref(null);
const isLocalLoading = ref(false);
const detectedLanguage = computed(() => {
  // Only display the detected language suffix if it corresponds to the currently selected text
  if (tts.lastText.value === pendingSelection.value.text) {
    return tts.detectedLanguage.value || 'auto';
  }
  return 'auto';
});

const isFullscreen = computed(() => mobileStore.isFullscreen);
const isTextSelectionEnabled = computed(() => settingsStore.settings?.TRANSLATE_ON_TEXT_SELECTION !== false);

const fabContainerRef = ref(null);
let hoverTimerId = null;
let fadeTimerId = null;
let instabilityTimer = null;

const startFadeTimer = (forceVisible = true) => {
  if (fadeTimerId) tracker.clearTimer(fadeTimerId);
  if (forceVisible) isFaded.value = false;
  fadeTimerId = tracker.trackTimeout(() => {
    isFaded.value = true;
    fadeTimerId = null;
  }, ANIMATION_CONFIG.IDLE_TIMEOUT);
};

// Initialize FAB selection logic
const { pendingSelection, triggerTranslation } = useFabSelection({
  onSelectionPending: (detail) => {
    if (detail.mode === SelectionTranslationMode.ON_FAB_CLICK || !isTextSelectionEnabled.value) {
      startFadeTimer();
    }
  }
});

// Check if this specific instance is currently responsible for the active TTS
const isThisTTSActive = computed(() => {
  return isLocalLoading.value || (!!(localTTSId.value && tts.currentTTSId.value === localTTSId.value));
});

const ttsState = computed(() => {
  if (isThisTTSActive.value) return tts.ttsState.value;
  return 'idle';
});

const ttsTooltip = computed(() => {
  const langName = detectedLanguage.value && detectedLanguage.value !== 'auto'
    ? getLanguageNameFromCode(detectedLanguage.value)
    : '';
  
  const capitalizedLang = langName ? langName.charAt(0).toUpperCase() + langName.slice(1) : '';
  const langSuffix = capitalizedLang ? ` (${capitalizedLang})` : '';

  if (ttsState.value === 'playing') return t('desktop_fab_tts_stop_tooltip') + langSuffix;
  if (ttsState.value === 'loading') return t('window_loading_alt');
  return t('desktop_fab_tts_play_tooltip') + langSuffix;
});

const updateViewport = () => {
  if (typeof window === 'undefined') return;
  
  // Only hide FAB on scroll for actual mobile devices (where toolbars hide/show)
  if (deviceDetector.isMobile()) {
    isViewportUnstable.value = true;
  }
  
  checkBounds();
  
  if (instabilityTimer) {
    tracker.clearTimer(instabilityTimer);
    instabilityTimer = null;
  }
  
  instabilityTimer = tracker.trackTimeout(() => {
    isViewportUnstable.value = false;
    instabilityTimer = null;
  }, 250);
};

const handleMouseEnter = () => {
  if (hoverTimerId) { tracker.clearTimer(hoverTimerId); hoverTimerId = null; }
  if (fadeTimerId) { tracker.clearTimer(fadeTimerId); fadeTimerId = null; }
  isHovered.value = true;
  isFaded.value = false;

  // Reset error status when interacting with FAB
  if (pageTranslationStatus.value.isError) {
    pageEventBus.emit(MessageActions.PAGE_TRANSLATE_RESET_ERROR);
  }
};

const handleMouseLeave = () => {
  hoverTimerId = tracker.trackTimeout(() => {
    isHovered.value = false;
    isFaded.value = true;
    hoverTimerId = null;
  }, ANIMATION_CONFIG.LEAVE_DELAY);
};

/**
 * Checks if the provider for a specific mode supports bulk operations
 */
const supportsBulk = (mode) => {
  const providerId = settingsStore.getEffectiveProvider(mode);
  const provider = findProviderById(providerId);
  return provider?.features?.includes('bulk') ?? true;
};

const isSelectElementSupported = computed(() => supportsBulk(TranslationMode.Select_Element));
const isPageTranslationSupported = computed(() => supportsBulk(TranslationMode.Page));

const currentUrlStr = computed(() => typeof window !== 'undefined' ? window.location.href : '');

const {
  isAutoTranslateToggleVisible,
  isActive,
  hasPageRule,
  hasSiteRule,
  siteScopeAvailable,
  showManageRules,
  scopeActions,
  openManageRules,
} = useAutoTranslateRules({ currentUrl: currentUrlStr });
const scopeMenuOpen = ref(false);
const scopeTrigger = ref(null);
const firstScopeAction = ref(null);
const focusRefTarget = (templateRef) => {
  const target = Array.isArray(templateRef.value) ? templateRef.value[0] : templateRef.value;
  target?.focus();
};
const toggleScopeDisclosure = async () => {
  scopeMenuOpen.value = !scopeMenuOpen.value;
  if (scopeMenuOpen.value) {
    await nextTick();
    focusRefTarget(firstScopeAction);
  }
};
const onScopeGroupKeydown = () => {
  if (!scopeMenuOpen.value) return;
  scopeMenuOpen.value = false;
  focusRefTarget(scopeTrigger);
};
watch(isMenuOpen, (open) => {
  if (!open) scopeMenuOpen.value = false;
});

const menuItems = computed(() => {
  const items = [];

  // Mouse Hover Toggle
  if (settingsStore.settings?.SHOW_MOUSE_HOVER_IN_FAB !== false) {
    items.push({
      id: 'mouse_hover_toggle',
      label: isMouseHoverEnabled.value 
        ? (t('mouse_hover_disable_label') || 'غیرفعال‌سازی ترجمه با ماوس') 
        : (t('mouse_hover_enable_label') || 'فعال‌سازی ترجمه با ماوس'),
      icon: IconMouseHover,
      closeMenu: false,
      action: () => toggleMouseHover()
    });
  }

  if (pendingSelection.value.hasSelection && pendingSelection.value.mode === SelectionTranslationMode.ON_FAB_CLICK) {
    items.push({
      id: 'translate_selection',
      label: t('desktop_fab_translate_selection_label'),
      icon: IconTranslateSelection,
      closeMenu: false,
      action: () => triggerTranslation()
    });
  }

  if (allowedFeatures.value.selectElement) {
    const provider = settingsStore.getEffectiveProvider(TranslationMode.Select_Element);
    items.push({
      id: 'select_element',
      label: t('desktop_fab_select_element_label'),
      tooltip: !isSelectElementSupported.value ? (t('provider_does_not_support_bulk') || 'این سرویس از حالت انتخاب المان پشتیبانی نمی‌کند') : '',
      icon: IconSelectElement,
      disabled: !isSelectElementSupported.value,
      closeMenu: true,
      action: async () => {
        try {
          await sendMessage({ 
            action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
            data: { provider }
          });
        } catch (err) {
          if (ExtensionContextManager.isContextError(err)) {
            ExtensionContextManager.handleContextError(err, 'desktop-fab:select-element');
          } else {
            await handleError(err, { 
              context: 'desktop-fab:select-element',
              showToast: true 
            });
          }
        }
      }
    });
  }

  if (allowedFeatures.value.screenCapture) {
    items.push({
      id: 'screen_capture',
      label: t('desktop_fab_screen_capture_label'),
      icon: IconScreenCapture,
      closeMenu: true,
      action: async () => {
        try {
          await sendMessage({ 
            action: MessageActions.START_SCREEN_CAPTURE 
          });
        } catch (err) {
          if (ExtensionContextManager.isContextError(err)) {
            ExtensionContextManager.handleContextError(err, 'desktop-fab:screen-capture');
          } else {
            await handleError(err, { 
              context: 'desktop-fab:screen-capture',
              showToast: true 
            });
          }
        }
      }
    });
  }

  const status = pageTranslationStatus.value;
  const isPageTranslationAllowed = allowedFeatures.value.pageTranslation;

  const pageSecondaryAction = isAutoTranslateToggleVisible.value ? {
    active: isActive.value,
    title: t('auto_translate_scope_menu_label', 'Auto-translate on future visits'),
  } : null;

  if (status.isAuto || status.isTranslating) {
    items.push({
      id: 'page_translating_stop',
      label: t('desktop_fab_stop_auto_translating_label'),
      icon: IconHourglass,
      showProgress: status.isTranslating,
      percent: status.percent,
      closeMenu: false,
      action: () => {
        logger.info('Stopping page translation from FAB');
        sendPageCommand({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO });
      },
      secondaryAction: pageSecondaryAction
    });
  } else if (status.isCompleted) {
    items.push({
      id: 'restore_page',
      label: t('desktop_fab_restore_original_label'),
      icon: IconRestore,
      closeMenu: true,
      action: () => sendPageCommand({ action: MessageActions.PAGE_RESTORE }),
      secondaryAction: pageSecondaryAction
    });
  } else if (isPageTranslationAllowed) {
    const provider = settingsStore.getEffectiveProvider(TranslationMode.Page);
    items.push({
      id: 'translate_page',
      label: t('desktop_fab_translate_page_label'),
      tooltip: !isPageTranslationSupported.value ? (t('provider_does_not_support_bulk') || 'این سرویس از ترجمه صفحه پشتیبانی نمی‌کند') : '',
      icon: IconTranslatePage,
      disabled: !isPageTranslationSupported.value,
      closeMenu: false,
      action: () => sendPageCommand({
        action: MessageActions.PAGE_TRANSLATE,
        data: { provider },
      }),
      secondaryAction: pageSecondaryAction
    });
  }

  return items;
});

const isTTSActive = computed(() => pendingSelection.value.hasSelection || (isThisTTSActive.value && tts.isPlaying.value));

// Page Translation Status & Progress Logic
const pageTranslationStatus = computed(() => {
  const data = mobileStore.pageTranslationData;
  const isTranslating = data.status === TRANSLATION_STATUS.TRANSLATING;
  const isAuto = data.isAutoTranslating;
  
  // A page is considered "Completed" (for UI purposes) if it's fully translated, 
  // marked as completed, OR has some partial translations that can be restored.
  const isCompleted = !isTranslating && !isAuto && (
    data.isTranslated || 
    data.status === TRANSLATION_STATUS.COMPLETED || 
    (data.totalCount > 0 && data.translatedCount >= data.totalCount)
  );
  
  const isError = data.status === TRANSLATION_STATUS.ERROR;
  
  const isActive = isTranslating || isAuto || isCompleted || isError;
  const processedCount = (data.translatedCount || 0) + (data.failedCount || 0);
  const percent = data.totalCount > 0 ? Math.round((processedCount / data.totalCount) * 100) : 0;
  
  return {
    isActive,
    isTranslating,
    isAuto,
    isCompleted,
    isError,
    percent
  };
});

const verticalPos = ref(-1);
const userPreferredY = ref(null);
const side = ref('right');
const isDragging = ref(false);
const wasDragged = ref(false);
let startY = 0;
let startX = 0;

const checkBounds = () => {
  if (typeof window === 'undefined' || userPreferredY.value === null) return;
  
  // Dynamically calculate maxY based on window height and a safe margin
  // (using a slightly larger margin to account for responsive scaling)
  const maxY = window.innerHeight - 80;
  verticalPos.value = Math.max(10, Math.min(userPreferredY.value, maxY));
};

const containerStyle = computed(() => {
  let opacityValue = ANIMATION_CONFIG.OPACITY_FULL;
  let pointerEvents = 'auto';

  if (isViewportUnstable.value && !isDragging.value) {
    opacityValue = 0;
    pointerEvents = 'none';
  } else if (isFaded.value && !isHovered.value && !isMenuOpen.value && !isDragging.value) {
    opacityValue = fabIdleOpacity.value; 
  }

  const isActive = isHovered.value || isMenuOpen.value || isDragging.value;
  const moveDuration = isActive ? ANIMATION_CONFIG.MOVE_IN : ANIMATION_CONFIG.MOVE_OUT;
  const easing = ANIMATION_CONFIG.SOFT_EASING;

  // Build transition string dynamically
  let transitionStr = 'none';
  if (!isPositioning.value && !isViewportUnstable.value) {
    const opacityDuration = isMenuOpen.value ? ANIMATION_CONFIG.QUICK_FADE : (opacityValue === ANIMATION_CONFIG.OPACITY_FULL ? ANIMATION_CONFIG.FADE_IN : ANIMATION_CONFIG.FADE_OUT);
    transitionStr = `transform ${moveDuration} ${easing}, left ${moveDuration} ${easing}, right ${moveDuration} ${easing}, opacity ${opacityDuration} ${easing}`;
  }

  const style = {
    '--fab-opacity': opacityValue,
    '--fab-pointer-events': pointerEvents,
    '--fab-transition': transitionStr,
    '--fab-scale': fabScale.value
  };

  if (verticalPos.value === -1) {
    style['--fab-top'] = '50%';
    style['--fab-transform'] = 'translateY(-50%)';
  } else {
    style['--fab-top'] = `${verticalPos.value}px`;
    style['--fab-transform'] = 'none';
  }

  return style;
});

const mainButtonStyle = computed(() => {
  const isRight = side.value === 'right';
  const isActive = isHovered.value || isMenuOpen.value || isDragging.value;
  const moveDuration = isActive ? ANIMATION_CONFIG.MOVE_IN : ANIMATION_CONFIG.MOVE_OUT;
  
  const translateValue = isActive 
    ? (isRight ? 'calc(-1 * var(--fab-active-translate))' : 'var(--fab-active-translate)') 
    : '0px';

  return {
    'transform': `translateX(${translateValue})`,
    'transition': `transform ${moveDuration} ${ANIMATION_CONFIG.SOFT_EASING}, background-color 0.2s ease, box-shadow 0.3s ease`
  };
});

const getBadgeTransform = (isHoveredOrOpen, isIndividualHovered) => {
  const isRight = side.value === 'right';
  // Use CSS variables for responsive translate amount
  const translateValue = isHoveredOrOpen 
    ? (isRight ? 'calc(-1 * var(--fab-active-translate))' : 'var(--fab-active-translate)') 
    : '0px';
    
  const scale = isIndividualHovered ? 1.15 : 1;
  return `translateX(${translateValue}) scale(${scale})`;
};

const toggleMenu = () => {
  if (isDragging.value || wasDragged.value) return;
  const isOnFabClickMode = pendingSelection.value.hasSelection && pendingSelection.value.mode === SelectionTranslationMode.ON_FAB_CLICK;

  if (isOnFabClickMode) {
    logger.info('Translation triggered via Desktop FAB click');
    triggerTranslation();
    isMenuOpen.value = false;
  } else {
    isMenuOpen.value = !isMenuOpen.value;

    // Reset error when menu is opened
    if (isMenuOpen.value && pageTranslationStatus.value.isError) {
      pageEventBus.emit(MessageActions.PAGE_TRANSLATE_RESET_ERROR);
    }

    logger.debug(isMenuOpen.value ? 'Desktop FAB menu opened' : 'Desktop FAB menu closed');
  }
};
const handleMenuItemClick = async (item) => {
  logger.info('Desktop FAB menu item clicked', { id: item.id });
  if (item.closeMenu) isMenuOpen.value = false;
  if (typeof item.action === 'function') await item.action();
};

const handleOpenSettings = async () => {
  try {
    logger.info('Opening settings from Desktop FAB');
    await sendMessage({ action: MessageActions.OPEN_OPTIONS_PAGE });
    isMenuOpen.value = false;
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(err, 'desktop-fab:open-settings');
    } else {
      await handleError(err, { 
        context: 'desktop-fab:open-settings',
        showToast: true 
      });
    }
  }
};

const handleRevert = async () => {
  try {
    logger.info('Reverting translations from Desktop FAB');
    mobileStore.setHasElementTranslations(false);
    await sendMessage({ action: MessageActions.REVERT_SELECT_ELEMENT_MODE });
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(err, 'desktop-fab:revert');
    } else {
      await handleError(err, { 
        context: 'desktop-fab:revert',
        showToast: true 
      });
    }
  }
};

const handleTTS = async () => {
  if (ttsState.value === 'playing' || ttsState.value === 'loading') {
    logger.info('Stopping TTS from Desktop FAB');
    await tts.stop();
  } else if (pendingSelection.value.hasSelection) {
    logger.info('Starting TTS from Desktop FAB');
    isLocalLoading.value = true;
    try {
      // Pass 'auto' to ensure the background triggers detection on the new text
      const result = await tts.speak(pendingSelection.value.text, 'auto');
      if (result) {
        localTTSId.value = tts.currentTTSId.value;
      }
    } finally {
      isLocalLoading.value = false;
    }
  }
};

const startDrag = (e) => {
  const isMouseEvent = e.type === 'mousedown';
  if (isMouseEvent && e.button !== 0) return;
  
  if (verticalPos.value === -1) {
    const rect = fabContainerRef.value.getBoundingClientRect();
    verticalPos.value = rect.top;
  }
  
  const point = isMouseEvent ? e : e.touches[0];
  isDragging.value = false;
  startY = point.clientY - verticalPos.value;
  startX = point.clientX;
  
  if (isMouseEvent) {
    tracker.addEventListener(window, 'mousemove', onDrag);
    tracker.addEventListener(window, 'mouseup', stopDrag);
  } else {
    tracker.addEventListener(window, 'touchmove', onDrag, { passive: false });
    tracker.addEventListener(window, 'touchend', stopDrag);
  }
};

const onDrag = (e) => {
  const isMouseEvent = e.type === 'mousemove';
  const point = isMouseEvent ? e : e.touches[0];

  if (!isDragging.value) {
    const dy = point.clientY - (startY + verticalPos.value);
    const dx = point.clientX - startX;
    
    // Only start dragging if moved beyond threshold
    if (Math.abs(dy) > 5 || Math.abs(dx) > 5) {
      isDragging.value = true;
      wasDragged.value = true;
      isFaded.value = false;
      
      // Re-sync startY to current point to ensure smooth transition from threshold
      startY = point.clientY - verticalPos.value;
    }
  }

  if (isDragging.value) {
    if (!isMouseEvent && e.cancelable) e.preventDefault();

    let newY = point.clientY - startY;
    const maxY = window.innerHeight - 80;
    newY = Math.max(10, Math.min(newY, maxY));
    verticalPos.value = newY;

    const screenWidth = window.innerWidth;
    const currentSide = point.clientX > screenWidth / 2 ? 'right' : 'left';
    if (currentSide !== side.value) {
      side.value = currentSide;
    }
  }
};

const stopDrag = (e) => {
  const isMouseEvent = e && e.type === 'mouseup';
  if (isMouseEvent) {
    tracker.removeEventListener(window, 'mousemove', onDrag);
    tracker.removeEventListener(window, 'mouseup', stopDrag);
  } else {
    tracker.removeEventListener(window, 'touchmove', onDrag);
    tracker.removeEventListener(window, 'touchend', stopDrag);
  }
  
  if (isDragging.value) {
    logger.debug('Desktop FAB drag ended', { side: side.value, y: verticalPos.value });
  }

  // Use a slightly longer delay to ensure ghost clicks are swallowed
  setTimeout(async () => { 
    isDragging.value = false; 
    // Small extra delay for wasDragged to ensure toggleMenu doesn't fire
    setTimeout(() => { wasDragged.value = false; }, 150);
    
    try {
      userPreferredY.value = verticalPos.value;
      const position = { side: side.value, y: verticalPos.value };
      await storageManager.set({ DESKTOP_FAB_POSITION: position });
    } catch (err) {
      logger.info('Failed to save FAB state:', err);
    }

    // Restart fade timer after drag ends
    startFadeTimer(false);
  }, 100);
};

onMounted(async () => {
  // Inject FAB-specific styles lazily into shadow root
  try {
    const { fabUiStyles } = await import('@/core/content-scripts/chunks/lazy-styles.js');
    if (fabUiStyles && injectStylesToShadowRoot) {
      injectStylesToShadowRoot(fabUiStyles, 'vue-fab-specific-styles');
    }
  } catch (error) {
    console.warn('[DesktopFabMenu] Failed to load lazy styles:', error);
  }

  try {
    const position = await getDesktopFabPositionAsync();
    if (position) {
      if (position.y !== undefined && position.y !== -1) {
        userPreferredY.value = position.y;
        verticalPos.value = position.y;
      }
      if (position.side) side.value = position.side;
    }
    checkBounds();
    
    // Initial check for allowed features
    await updateAllowedFeatures();
    
    // Listen for settings and exclusion changes to re-evaluate allowed features
    tracker.trackResource('exclusion-sync', pageEventBus.on('FEATURE_STATUS_CHANGED', updateAllowedFeatures));
    tracker.trackResource('exclusion-re-sync', pageEventBus.on('sync-interaction-listeners', updateAllowedFeatures));
  } catch (err) {
    logger.info('Failed to load FAB state:', err);
  }

  tracker.addEventListener(window, 'resize', updateViewport);
  tracker.addEventListener(window, 'scroll', updateViewport, { passive: true });
  
  // Settle position before showing to prevent jumps
  setTimeout(() => {
    isReady.value = true;
    
    // Settling pixel position on first mount if not already set
    // We do this in a double requestAnimationFrame or nextTick to ensure the DOM is ready
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (verticalPos.value === -1 && fabContainerRef.value) {
          const rect = fabContainerRef.value.getBoundingClientRect();
          verticalPos.value = rect.top;
          userPreferredY.value = rect.top;
        }
        
        setTimeout(() => {
          isPositioning.value = false;
        }, 150);
      });
    });
  }, 100);

  startFadeTimer(false);

  const handleClickOutside = (e) => {
    if (!isMenuOpen.value) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(fabContainerRef.value)) isMenuOpen.value = false;
  };

  tracker.addEventListener(window, 'click', handleClickOutside);
});

onUnmounted(() => {
  logger.debug('[DesktopFabMenu] Unmounting - performing owner-aware TTS cleanup');
  tts.stop({ stopOnlyIfOwner: true }).catch(() => {});
});
</script>

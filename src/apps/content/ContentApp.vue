<template>
  <div
    :class="[
      'content-app-container', 
      TRANSLATION_HTML.NO_TRANSLATE_CLASS,
      settingsStore.isDarkTheme ? 'theme-dark' : 'theme-light',
      { 'capture-mode': isScreenCaptureActive || activeCapture }
    ]"
    :translate="TRANSLATION_HTML.NO_TRANSLATE_VALUE"
  >
    <template v-if="isExtensionEnabled && settingsStore.isInitialized">
      <!-- TextField Interaction Icons -->
      <TextFieldIcon
        v-for="icon in activeIcons"
        :id="icon.id"
        :key="icon.id"
        :ref="el => setIconRef(icon.id, el)"
        :position="icon.position"
        :visible="icon.visible !== false"
        :target-element="icon.targetElement"
        :attachment-mode="icon.attachmentMode || 'smart'"
        :positioning-mode="icon.positioningMode || 'absolute'"
        @click="onIconClick"
        @position-updated="onIconPositionUpdated"
      />

      <!-- WindowsManager Translation Windows -->
      <TranslationWindow
        v-for="window in translationWindows"
        :id="window.id"
        :key="window.id"
        :position="window.position"
        :selected-text="window.selectedText"
        :initial-translated-text="window.translatedText"
        :is-loading="window.isLoading"
        :is-streaming="window.isStreaming"
        :is-error="window.isError"
        :error-type="window.errorType"
        :can-retry="window.canRetry"
        :needs-settings="window.needsSettings"
        :initial-size="window.initialSize"
        :target-language="window.targetLanguage || 'auto'"
        :source-language="window.sourceLanguage || 'auto'"
        :detected-source-language="window.detectedSourceLanguage"
        :provider="window.provider"
        :translation-mode="window.mode"
        @close="onTranslationWindowClose"
        @speak="onTranslationWindowSpeak"
      />

      <!-- WindowsManager Translation Icons -->
      <TranslationIcon
        v-for="icon in translationIcons"
        :id="icon.id"
        :key="icon.id"
        :position="icon.position"
        :text="icon.text"
        @click="onTranslationIconClick"
        @close="onTranslationIconClose"
      />

      <!-- Select Element Overlays -->
      <ElementHighlightOverlay />

      <!-- Screen Capture Components -->
      <ScreenSelector 
        v-if="isScreenCaptureActive"
        @select="onScreenAreaSelected"
        @cancel="onScreenCaptureCancel"
      />

      <!-- Mobile Bottom Sheet -->
      <MobileSheet v-if="isMobileUI && isTopFrame" />

      <!-- Desktop FAB Menu -->
      <DesktopFabMenu 
        v-if="!isMobileUI && showDesktopFab && isTopFrame" 
      />

      <!-- Mobile Floating Action Button (FAB) -->
      <MobileFab
        v-if="isMobileUI && showMobileFab && !mobileStore.isOpen && !isSelectModeActive && !isFullscreen && isTopFrame"
      />

      <!-- Page Translation Original Text Tooltip -->
      <PageTranslationTooltip />

      <!-- Mouse on Hover Translation Tooltip -->
      <MouseHoverTooltip />

      <!-- Live dubbing transcript: top-frame, display-only surface. -->
      <LiveDubbingTranscript
        v-if="isTopFrame && (showTranslatedTranscript || showOriginalTranscript)"
        :show-translated-transcript="showTranslatedTranscript"
        :show-original-transcript="showOriginalTranscript"
        :font-family="liveDubbingFontFamily"
        :subtitle-size="liveDubbingSubtitleSize"
      />
    </template>

    <!-- 
      Toaster (Notification System)
      CRITICAL: Placed at the end of the template to ensure it stays on top of 
      all other siblings in the Shadow DOM stacking context (Z-index rule for siblings).
    -->
    <Toaster
      v-if="shouldShowGlobalUI"
      rich-colors
      position="bottom-right"
      expand
      :toast-options="{
        style: {
          pointerEvents: 'auto',
          cursor: 'auto',
          zIndex: 2147483647,
          unicodeBidi: 'plaintext',
          wordWrap: 'break-word',
          overflowWrap: 'break-word',
          whiteSpace: 'pre-wrap',
          overflow: 'hidden',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
        }
      }"
    />
  </div>
</template>

<script setup>
import './ContentApp.scss'
import { computed, onUnmounted, defineAsyncComponent, ref } from 'vue';
import { Toaster } from 'vue-sonner';
import { useWindowsManager } from '@/features/windows/composables/useWindowsManager.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { useMobileStore } from '@/store/modules/mobile.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';

// --- UI Components ---

// Static Imports (Critical & Immediate UI)
// These are loaded immediately to ensure responsiveness and core system integrity.
import TextFieldIcon from '@/features/text-field-interaction/components/TextFieldIcon.vue';
const ElementHighlightOverlay = defineAsyncComponent(() => import('./components/ElementHighlightOverlay.vue'));
const ScreenSelector = defineAsyncComponent(() => import('@/components/content/ScreenSelector.vue'));

// Lazy Loaded Components (Optimized Resource Usage)
// These components are loaded on-demand or based on device type to reduce the initial JS footprint.
const TranslationWindow = defineAsyncComponent(() => import('@/features/windows/components/TranslationWindow.vue'));
const TranslationIcon = defineAsyncComponent(() => import('@/features/windows/components/TranslationIcon.vue'));
const PageTranslationTooltip = defineAsyncComponent(() => import('./components/PageTranslationTooltip.vue'));
const MouseHoverTooltip = defineAsyncComponent(() => import('./components/MouseHoverTooltip.vue'));
const LiveDubbingTranscript = defineAsyncComponent(() => import('@/features/live-dubbing/components/LiveDubbingTranscript.vue'));

// Device-Specific Lazy Components
const MobileSheet = defineAsyncComponent(() => import('./components/mobile/MobileSheet.vue'));
const MobileFab = defineAsyncComponent(() => import('./components/mobile/MobileFab.vue'));
const DesktopFabMenu = defineAsyncComponent(() => import('./components/desktop/DesktopFabMenu.vue'));

import { TRANSLATION_HTML } from '@/shared/constants/translation.js';
import { CONFIG } from '@/shared/config/config.js';
import { resolveTranslationFontFamily } from '@/shared/fonts/TranslationFontResolver.js';
import { normalizeLiveDubbingSubtitleSize } from '@/features/live-dubbing/content/liveDubbingSubtitleSize.js';
import {
  getLiveDubbingTranscriptSnapshot,
  subscribeLiveDubbingTranscript,
} from '@/features/live-dubbing/content/liveDubbingTranscriptStore.js';
import { shouldShowLiveDubbingOriginalTranscript } from '@/features/live-dubbing/content/liveDubbingTranscriptPresentation.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

// Import New Composables for modular architecture
import { useContentAppLocalization } from './composables/useContentAppLocalization.js';
import { useContentAppUIState } from './composables/useContentAppUIState.js';
import { useContentAppNotifications } from './composables/useContentAppNotifications.js';
import { useContentAppTextFieldIcons } from './composables/useContentAppTextFieldIcons.js';
import { useContentAppPageTranslation } from './composables/useContentAppPageTranslation.js';
import { useContentAppLifecycle } from './composables/useContentAppLifecycle.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT_APP, 'ContentApp');

// Localization helper for template (Standard project approach)
useUnifiedI18n();

// 1. Core Stores & Resource Tracker
const settingsStore = useSettingsStore();
const mobileStore = useMobileStore();
const tracker = useResourceTracker('content-app');
const liveDubbingTranscript = ref(getLiveDubbingTranscriptSnapshot());
const unsubscribeLiveDubbingTranscript = subscribeLiveDubbingTranscript((snapshot) => {
  liveDubbingTranscript.value = snapshot;
});

const showTranslatedTranscript = computed(() =>
  settingsStore.settings?.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT === true
);
const showOriginalTranscript = computed(() =>
  shouldShowLiveDubbingOriginalTranscript(settingsStore.settings, liveDubbingTranscript.value.providerId)
);
const liveDubbingFontFamily = computed(() => {
  const settings = settingsStore.settings;
  if (settings?.LIVE_DUBBING_USE_TRANSLATION_FONT !== true) return '';

  return resolveTranslationFontFamily(
    settings.TRANSLATION_FONT_FAMILY || CONFIG.TRANSLATION_FONT_FAMILY,
    settings.LIVE_DUBBING_TARGET_LANGUAGE || CONFIG.LIVE_DUBBING_TARGET_LANGUAGE
  );
});
const liveDubbingSubtitleSize = computed(() => normalizeLiveDubbingSubtitleSize(
  settingsStore.settings?.LIVE_DUBBING_SUBTITLE_SIZE
));

// 2. Localization & RTL Management
const { toastRTL, updateToastRTL } = useContentAppLocalization(settingsStore);

// 3. UI State Management (Frame detection, Fullscreen, Mobile/Desktop mode)
const {
  isTopFrame,
  shouldShowGlobalUI,
  isSelectModeActive,
  isScreenCaptureActive,
  isFullscreen,
  isExtensionEnabled,
  showDesktopFab,
  showMobileFab,
  isMobileUI
} = useContentAppUIState(settingsStore, mobileStore, tracker);

import { watch } from 'vue';
watch(isScreenCaptureActive, (newVal) => {
  logger.info(`[ContentApp] isScreenCaptureActive changed: ${newVal}`);
});

const onScreenAreaSelected = (result) => {
  logger.info('Screen area selected', result);
  isScreenCaptureActive.value = false;
  window.isScreenCaptureActive = false;
};

const onScreenCaptureCancel = () => {
  logger.info('Screen capture cancelled');
  isScreenCaptureActive.value = false;
  window.isScreenCaptureActive = false;
};

// 4. Notifications (Toasts) Management
useContentAppNotifications({ shouldShowGlobalUI, toastRTL, tracker });

// 5. TextField Interaction Icons
const {
  activeIcons,
  setIconRef,
  onIconClick,
  onIconPositionUpdated
} = useContentAppTextFieldIcons(tracker);

// 6. WindowsManager (Translation Windows & Icons)
const {
  translationWindows,
  translationIcons,
  onTranslationIconClick,
  onTranslationWindowClose,
  onTranslationWindowSpeak,
  onTranslationIconClose,
  setupEventListeners,
  cleanupEventListeners
} = useWindowsManager();

// Initialize WindowsManager listeners
setupEventListeners();

// 7. Page Translation Sync Logic
useContentAppPageTranslation(mobileStore, tracker);

// 8. Lifecycle & Cleanup Logic
const onNavigationCleanup = () => {
  // Close all active translation windows
  if (translationWindows.value.length > 0) {
    translationWindows.value.forEach(window => {
      onTranslationWindowClose(window.id);
    });
  }
  
  // Close all active translation icons  
  if (translationIcons.value.length > 0) {
    translationIcons.value.forEach(icon => {
      onTranslationIconClose(icon.id);
    });
  }
  
  // Clear all text field icons
  activeIcons.value = [];
  
  // Reset selection mode state
  isSelectModeActive.value = false;
  
  // Dismiss all pending notifications
  const pageEventBus = window.pageEventBus;
  if (pageEventBus) {
    pageEventBus.emit('dismiss_all_notifications');
  }
};

useContentAppLifecycle({
  settingsStore,
  tracker,
  updateToastRTL,
  onNavigationCleanup
});

onUnmounted(() => {
  unsubscribeLiveDubbingTranscript();
  cleanupEventListeners();
  logger.debug('ContentApp unmounted, cleaned up WindowsManager listeners.');
});

logger.debug('ContentApp script setup executed (Modular Architecture).');
</script>

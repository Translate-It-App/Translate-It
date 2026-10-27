<template>
  <!-- Small loading window -->
  <div
    v-if="currentSize === 'small'"
    v-show="!isFullscreen && settingsReady"
    ref="windowElement"
    class="ti-window translation-window aiwc-selection-popup-host ti-loading-window"
    :class="[shellTheme, { 'visible': isVisible, 'is-dragging': isPositionDragging }]"
    :style="windowStyle"
    data-translate-ui="true"
    @mousedown="handleStartDrag"
    @touchstart="handleStartDrag"
    @click.stop
  >
    <LoadingSpinner
      size="sm"
      class="ti-loading-spinner-wrapper"
    />
  </div>

  <!-- Normal translation window -->
  <div
    v-else
    v-show="!isFullscreen && settingsReady"
    ref="windowElement"
    class="ti-window translation-window aiwc-selection-popup-host normal-window ti-host-container"
    :class="[shellTheme, { 'visible': isVisible, 'is-dragging': isPositionDragging, 'is-pinned': isPinned, 'is-docked': dockMode !== 'none', [`dock-${dockMode}`]: dockMode !== 'none' }]"
    :style="windowStyle"
    data-translate-ui="true"
    @mousedown.stop
    @click.stop
  >
    <!-- Resize handle for docked mode -->
    <div
      v-if="dockMode !== 'none'"
      class="ti-dock-resize-handle"
      @mousedown.prevent.stop="startResize"
      @touchstart.stop="startResize"
    />

    <div
      class="ti-window-header"
      @mousedown="handleStartDrag"
      @touchstart="handleStartDrag"
    >
      <TranslationWindowToolbar
        :provider="props.provider"
        :theme="shellTheme"
        :is-pinned="isPinned"
        :show-original="showOriginal"
        :is-dictionary="isDictionary"
        :tts-text="currentTTSText"
        :tts-language="currentTTSLang"
        :tts-idle-tooltip="t('window_tts_speak_translation')"
        :tts-playing-tooltip="t('window_tts_stop')"
        :detected-language-label="detectedLanguageName"
        :pin-title="isPinned ? t('window_unpin') : t('window_pin')"
        :copy-title="t('window_copy_translation')"
        :original-title="getOriginalButtonTitle"
        :close-title="t('window_close')"
        :provider-selector-is-global="false"
        :provider-selector-allow-set-default="true"
        :provider-selector-only-configured="true"
        @provider-change="handleProviderChange"
        @toggle-pin="togglePin"
        @copy="handleCopy"
        @toggle-original="toggleShowOriginal"
        @close="handleClose"
      />
    </div>

    <div
      v-if="props.historyLength > 1"
      class="ti-window-history-subheader"
      :class="`ti-window-history-subheader-${shellTheme}`"
      data-testid="translation-window-history-subheader"
      @mousedown.stop
      @touchstart.stop
      @click.stop
    >
      <div class="ti-window-history-controls">
        <IconButton
          icon="arrow-next.svg"
          type="toolbar"
          mask
          class="ti-window-history-button ti-window-history-previous"
          :title="t('window_history_previous')"
          :alt="t('window_history_previous')"
          :disabled="props.historyIndex <= 0"
          data-testid="translation-window-history-previous"
          @click="navigateHistory('previous')"
        />
        <span
          class="ti-window-history-counter"
          data-testid="translation-window-history-counter"
        >{{ props.historyIndex + 1 }} / {{ props.historyLength }}</span>
        <IconButton
          icon="arrow-next.svg"
          type="toolbar"
          mask
          class="ti-window-history-button ti-window-history-next"
          :title="t('window_history_next')"
          :alt="t('window_history_next')"
          :disabled="props.historyIndex < 0 || props.historyIndex >= props.historyLength - 1"
          data-testid="translation-window-history-next"
          @click="navigateHistory('next')"
        />
      </div>
      <span
        class="ti-window-history-divider"
        aria-hidden="true"
      />
      <span
        class="ti-window-history-provider"
        data-testid="translation-window-history-provider"
      >{{ activeHistoryProvider }}</span>
    </div>

    <div class="ti-window-body">
      <div
        class="ti-original-text-wrapper"
        :class="{ 'is-expanded': isOriginalSectionVisible }"
      >
        <!-- One coordinated collapse: the section fades (leave/enter classes)
             while the wrapper's grid row shrinks — the subtree stays mounted
             and displayed for the whole leave phase. -->
        <Transition name="ti-original-collapse">
          <div
            v-show="isOriginalSectionVisible"
            :inert="!isOriginalSectionVisible || undefined"
            class="ti-original-text-section"
          >
            <div class="ti-original-text">
              <textarea
                :id="`translation-window-source-${props.id}`"
                ref="sourceTextarea"
                v-model="sourceDraft"
                class="ti-window-source-input"
                :class="{ 'ti-window-source-overflow': sourceHasOverflow }"
                :aria-label="t('window_edit_source')"
                :lang="props.sourceLanguage !== 'auto' ? props.sourceLanguage : undefined"
                :dir="sourceDirection"
                rows="1"
                @mousedown.stop
                @touchstart.stop
                @keydown.stop="handleSourceKeydown"
                @keyup.stop
                @keypress.stop
              />
              <TTSButton
                ref="sourceTTSButton"
                class="ti-window-source-tts"
                size="sm"
                variant="secondary"
                :text="sourceDraft"
                :language="props.sourceLanguage"
                :disabled="!sourceDraft.trim()"
                :is-dictionary="false"
                :idle-tooltip="t('window_tts_speak_original')"
                :playing-tooltip="t('window_tts_stop')"
                @tts-started="handleSourceTTSStarted"
              />
            </div>
          </div>
        </Transition>
      </div>
      <TranslationDisplay
        :content="translatedText"
        :is-loading="isLoading"
        :is-streaming="props.isStreaming"
        :error="errorMessage"
        :error-type="props.errorType"
        :mode="'compact'"
        :placeholder="t('window_translation_placeholder')"
        :target-language="props.targetLanguage"
        :show-fade-in-animation="true"
        :enable-markdown="true"
        :show-toolbar="false"
        :show-copy-button="false"
        :show-tts-button="false"
        :can-retry="props.canRetry"
        :can-open-settings="props.needsSettings"
        :on-retry="handleRetry"
        :on-open-settings="handleOpenSettings"
        class="ti-window-translation-display"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, nextTick } from 'vue';
import { injectStylesToShadowRoot } from '@/utils/ui/styleInjector.js';
import { pageEventBus, WINDOWS_MANAGER_EVENTS } from '@/core/PageEventBus.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { usePositioning } from '@/composables/ui/usePositioning.js';
import { WindowsConfig } from '@/features/windows/managers/core/WindowsConfig.js';
import TranslationWindowToolbar from '@/components/shared/TranslationWindowToolbar.vue';
import TranslationDisplay from '@/components/shared/TranslationDisplay.vue';
import LoadingSpinner from '@/components/base/LoadingSpinner.vue';
import { useMessaging } from '@/shared/messaging/composables/useMessaging.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';
import { useMobileStore } from '@/store/modules/mobile.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { TranslationMode } from '@/shared/config/config.js';
import { SimpleMarkdown, ExtractionStrategy } from '@/shared/utils/text/markdown.js';
import { getLanguageNameFromCode } from '@/shared/config/languageConstants.js';
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js';
import { isLTRStrongCharacter, isRTLStrongCharacter, shouldApplyRtl } from '@/shared/utils/text/textAnalysis.js';
import { getProviderById } from '@/core/provider-registry.js';
import IconButton from '@/components/shared/IconButton.vue';
import TTSButton from '@/components/shared/TTSButton.vue';

// Import adjacent SCSS
import './TranslationWindow.scss';

// i18n
const { t } = useUnifiedI18n();

const props = defineProps({
  id: { type: String, required: true },
  position: { type: Object, default: () => ({ x: 0, y: 0 }) },
  selectedText: { type: String, default: '' },
  initialTranslatedText: { type: String, default: '' },
  theme: { type: String, default: 'light' },
  isLoading: { type: Boolean, default: false },
  isStreaming: { type: Boolean, default: false },
  isError: { type: Boolean, default: false },
  errorType: { type: String, default: null },
  canRetry: { type: Boolean, default: false },
  needsSettings: { type: Boolean, default: false },
  initialSize: { type: String, default: 'normal' }, 
  targetLanguage: { type: String, default: 'auto' }, 
  sourceLanguage: { type: String, default: 'auto' },
  historyIndex: { type: Number, default: -1 },
  historyLength: { type: Number, default: 0 },
  historyProvider: { type: String, default: '' },
  detectedSourceLanguage: { type: String, default: undefined },
  provider: { type: String, default: '' },
  translationMode: { type: String, default: null }
});

const emit = defineEmits(['close', 'speak']);
useMessaging('content');

const mobileStore = useMobileStore();
const settings = useSettingsStore();
const settingsReady = ref(false);
const logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, `TranslationWindow:${props.id}`);
const tracker = useResourceTracker(`translation-window-${props.id}`);
const systemThemeQuery = '(prefers-color-scheme: dark)';
const systemPrefersDark = ref(false);
let systemThemeMediaQuery = null;
let removeSystemThemeListener = null;

const resolveShellTheme = () => {
  if (settings.settings.THEME === 'auto') {
    return systemPrefersDark.value ? 'dark' : 'light';
  }

  return settings.settings.THEME === 'dark' ? 'dark' : 'light';
};

const shellTheme = computed(() => resolveShellTheme());
const activeHistoryProvider = computed(() => {
  const provider = props.historyProvider || props.provider;
  return getProviderById(provider)?.name || provider || '';
});

// Pinned and Docked states
const isPinned = ref(settings.getSetting('WINDOW_IS_PINNED', false));
const dockMode = ref(settings.getSetting('WINDOW_DOCK_MODE', 'none'));
const dockedWidth = ref(settings.getSetting('WINDOW_DOCKED_WIDTH', 350));

// Watch for external setting changes (e.g. from Options page)
watch(() => settings.settings.WINDOW_IS_PINNED, (newVal) => {
  if (newVal !== undefined) isPinned.value = newVal;
});
watch(() => settings.settings.WINDOW_DOCK_MODE, (newVal) => {
  if (newVal !== undefined) {
    dockMode.value = newVal;
    updateDockMode(newVal);
  }
});
watch(() => settings.settings.WINDOW_DOCKED_WIDTH, (newVal) => {
  if (newVal !== undefined) {
    dockedWidth.value = newVal;
    updateDockedWidth(newVal);
  }
});

const syncSystemTheme = (matches) => {
  systemPrefersDark.value = matches;
};

const handleSystemThemeChange = (event) => {
  const matches = typeof event?.matches === 'boolean'
    ? event.matches
    : !!systemThemeMediaQuery?.matches;

  syncSystemTheme(matches);
};

// Update WindowsState with initial values
onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    systemThemeMediaQuery = window.matchMedia(systemThemeQuery);
    syncSystemTheme(systemThemeMediaQuery.matches);

    if (typeof systemThemeMediaQuery.addEventListener === 'function') {
      systemThemeMediaQuery.addEventListener('change', handleSystemThemeChange);
      removeSystemThemeListener = () => {
        systemThemeMediaQuery?.removeEventListener('change', handleSystemThemeChange);
      };
    } else if (typeof systemThemeMediaQuery.addListener === 'function') {
      systemThemeMediaQuery.addListener(handleSystemThemeChange);
      removeSystemThemeListener = () => {
        systemThemeMediaQuery?.removeListener(handleSystemThemeChange);
      };
    }
  }

  const windowsManager = window.windowsManagerInstance;
  if (windowsManager && windowsManager.state) {
    windowsManager.state.setPinned(isPinned.value);
    windowsManager.state.setDockMode(dockMode.value);
  }
});

onUnmounted(() => {
  sourceResizeObserver?.disconnect();
  sourceResizeObserver = null;

  if (removeSystemThemeListener) {
    removeSystemThemeListener();
    removeSystemThemeListener = null;
  }

  // Never leak resize coordination state or capture listeners if unmounted
  // mid-protection (removed with matching capture semantics).
  disarmResizeCompletionProtection();
  window.__TRANSLATION_WINDOW_IS_RESIZING = false;
  window.__TRANSLATION_WINDOW_JUST_RESIZED = false;

  systemThemeMediaQuery = null;
});

// Gesture protection teardown runs before unmount, while the template ref
// still holds this window's root element (Vue nulls template refs during
// unmount, before onUnmounted hooks run).
onBeforeUnmount(() => {
  const windowsManager = window.windowsManagerInstance;
  if (windowsManager?.clickManager && windowElement.value) {
    windowsManager.clickManager.clearGestureFor(windowElement.value);
  }
});

const togglePin = () => {
  isPinned.value = !isPinned.value;
  void settings.updateSettingAndPersist('WINDOW_IS_PINNED', isPinned.value).catch(error => {
    logger.warn('Failed to persist WINDOW_IS_PINNED:', error);
  });
  
  const windowsManager = window.windowsManagerInstance;
  if (windowsManager && windowsManager.state) {
    windowsManager.state.setPinned(isPinned.value);
  }
};

// Fullscreen state from store
const isFullscreen = computed(() => mobileStore.isFullscreen);

// State
const isLoading = computed(() => {
  if (props.isStreaming && props.initialTranslatedText) return false;
  return props.isLoading || (!props.initialTranslatedText && !props.isError);
});

const isVisible = ref(false); 
const currentSize = ref(props.initialSize); 
const translatedText = computed(() => props.isError ? '' : props.initialTranslatedText);
const originalText = ref(props.selectedText);
const sourceDraft = ref(props.selectedText);
const sourceDirection = computed(() => {
  let hasStrongDirectionalCharacter = false;
  for (const character of sourceDraft.value) {
    const code = character.codePointAt(0);
    if (isRTLStrongCharacter(code) || isLTRStrongCharacter(code)) {
      hasStrongDirectionalCharacter = true;
      break;
    }
  }

  if (!hasStrongDirectionalCharacter) {
    return LanguageDetectionService.isRTL(props.sourceLanguage) ? 'rtl' : 'ltr';
  }

  return shouldApplyRtl(sourceDraft.value, 0.5) ? 'rtl' : 'ltr';
});
const sourceTextarea = ref(null);
const sourceHasOverflow = ref(false);
let sourceResizeObserver = null;
const errorMessage = computed(() => props.isError ? props.initialTranslatedText : '');

// Check if current translation is in dictionary mode
const isDictionary = computed(() => {
  if (props.translationMode === TranslationMode.Dictionary_Translation || props.translationMode === TranslationMode.LEGACY_DICTIONARY) {
    return true;
  }
  
  // Robust fallbacks
  return props.provider === 'vajehyab' || 
         (props.initialTranslatedText && props.initialTranslatedText.includes('**')) || 
         (props.initialTranslatedText && props.initialTranslatedText.startsWith('###'));
});

const detectedLanguageName = computed(() => {
  const code = props.detectedSourceLanguage;
  if (!code || code === 'auto') return '';
  const name = getLanguageNameFromCode(code);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
});

// Watch for prop changes to sync internal state
watch(() => [props.selectedText, props.historyIndex], ([newText]) => {
  originalText.value = newText;
  sourceDraft.value = newText;
});

watch(() => props.isError, (isError) => {
  if (isError) sourceDraft.value = originalText.value;
});

watch(() => props.sourceLanguage, (newLang) => {
  logger.debug('sourceLanguage prop updated:', newLang);
});

watch(() => props.targetLanguage, (newLang) => {
  logger.debug('targetLanguage prop updated:', newLang);
});

const currentTTSText = computed(() => translatedText.value || '');
const currentTTSLang = computed(() => props.targetLanguage);

const getOriginalButtonTitle = computed(() => showOriginal.value ? t('window_hide_original') : t('window_show_original'));

const handleRetry = () => {
  pageEventBus.emit('translation-window-retry', { id: props.id });
};

const handleOpenSettings = () => {
  pageEventBus.emit(WINDOWS_MANAGER_EVENTS.OPEN_SETTINGS, { section: 'languages' });
};

const handleProviderChange = (newProvider) => {
  pageEventBus.emit('translation-window-change-provider', { id: props.id, provider: newProvider });
};

const showOriginal = ref(false);
let showOriginalRevision = 0;
watch(() => settings.settings.WINDOW_SHOW_ORIGINAL, (value) => {
  if (settingsReady.value && typeof value === 'boolean') showOriginal.value = value;
});

// The original section stays mounted through the collapse transition, so the
// implicit unmount-driven TTS stop no longer fires when Original hides.
// Trigger the same owner-scoped stop (useTTSSmart's stop sends TTS_STOP with
// stopOnlyIfOwner: true for this button's own request) the moment Original
// becomes hidden — including hide-toggle, external settings, and loading.
const sourceTTSButton = ref(null);
const isOriginalSectionVisible = computed(() => showOriginal.value && !isLoading.value);
watch(isOriginalSectionVisible, (visible) => {
  if (!visible) void sourceTTSButton.value?.stop?.();
});

// The source TTS button is disabled for a blank draft, so clearing the draft
// while it speaks would leave playback running without a reachable Stop.
// Stop the source-owned request (owner-scoped: only this button's own
// request) as soon as the draft becomes blank; the translated/header TTS is
// untouched.
const stopSourceTTSWhenDraftIsBlank = () => {
  if (sourceDraft.value.trim()) return;
  void sourceTTSButton.value?.stop?.();
};
watch(sourceDraft, stopSourceTTSWhenDraftIsBlank);
// A start that lands after the draft was cleared must be stopped as well.
const handleSourceTTSStarted = () => {
  stopSourceTTSWhenDraftIsBlank();
};
const updateSourceOverflow = (textarea = sourceTextarea.value) => {
  if (textarea && sourceTextarea.value === textarea) {
    sourceHasOverflow.value = textarea.scrollHeight > textarea.clientHeight;
  }
};

watch([sourceDraft, showOriginal, isLoading], () => {
  nextTick(updateSourceOverflow);
});

watch(sourceTextarea, (textarea) => {
  sourceResizeObserver?.disconnect();
  sourceResizeObserver = null;

  if (!textarea) {
    sourceHasOverflow.value = false;
    return;
  }

  updateSourceOverflow();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (sourceTextarea.value === textarea && sourceResizeObserver === observer) {
        updateSourceOverflow(textarea);
      }
    });
    sourceResizeObserver = observer;
    observer.observe(textarea);
  }
}, { flush: 'post' });

const currentWidth = computed(() => currentSize.value === 'small' ? 28 : null);
const currentHeight = computed(() => currentSize.value === 'small' ? 28 : null);

const {
  currentPosition,
  isDragging: isPositionDragging,
  currentDockMode,
  positionStyle,
  startDrag,
  updatePosition,
  updateDockMode,
  updateDockedWidth,
  cleanup: cleanupPositioning
} = usePositioning(props.position, {
  defaultWidth: currentWidth.value || WindowsConfig.POSITIONING.POPUP_WIDTH,
  defaultHeight: currentHeight.value || WindowsConfig.POSITIONING.POPUP_HEIGHT,
  enableDragging: true,
  dockMode: dockMode.value,
  dockedWidth: dockedWidth.value
});

// Sync dockMode back to local ref if it changes (e.g. via dragging)
watch(currentDockMode, (newVal) => {
  if (newVal !== dockMode.value) {
    dockMode.value = newVal;
    void settings.updateSettingAndPersist('WINDOW_DOCK_MODE', newVal).catch(error => {
      logger.warn('Failed to persist WINDOW_DOCK_MODE:', error);
    });
    const windowsManager = window.windowsManagerInstance;
    if (windowsManager && windowsManager.state) {
      windowsManager.state.setDockMode(newVal);
    }
  }
});

watch(() => props.position, (newPos) => {
  updatePosition(newPos, {
    width: currentWidth.value || WindowsConfig.POSITIONING.POPUP_WIDTH,
    height: currentHeight.value || WindowsConfig.POSITIONING.POPUP_HEIGHT
  });
});

watch(() => props.initialSize, (newSize) => {
  currentSize.value = newSize;
  if (newSize === 'normal') {
    nextTick(() => {
      if (windowElement.value) {
        const { offsetWidth, offsetHeight } = windowElement.value;
        updatePosition(currentPosition.value, { width: offsetWidth, height: offsetHeight });
      }
    });
  } else {
    updatePosition(currentPosition.value, { width: currentWidth.value, height: currentHeight.value });
  }
});

const windowStyle = computed(() => {
  const style = { ...positionStyle.value };
  const isDocked = dockMode.value !== 'none';

  if (currentSize.value === 'small') {
    // Override for small loading spinner
    style.width = `${currentWidth.value}px`;
    style.height = `${currentHeight.value}px`;
  } else if (isDocked) {
    // Docked sidebar dimensions
    style.width = `${dockedWidth.value}px`;
    style.height = '100vh';
  } else {
    // Normal floating window
    style.width = 'auto';
    style.height = 'auto';
  }
  
  return style;
});

onMounted(async () => {
  const revisionAtLoad = showOriginalRevision;
  try {
    await settings.loadSettings?.();
  } catch (error) {
    logger.warn('Failed to load window settings:', error);
  }
  if (showOriginalRevision === revisionAtLoad && typeof settings.settings.WINDOW_SHOW_ORIGINAL === 'boolean') {
    showOriginal.value = settings.settings.WINDOW_SHOW_ORIGINAL;
  }
  settingsReady.value = true;
  // Inject Windows-specific styles lazily
  try {
    const { windowsUiStyles } = await import('@/core/content-scripts/chunks/lazy-styles.js');
    if (windowsUiStyles && injectStylesToShadowRoot) {
      injectStylesToShadowRoot(windowsUiStyles, 'vue-windows-specific-styles');
    }
  } catch (error) {
    console.warn('[TranslationWindow] Failed to load lazy styles:', error);
  }

  await nextTick();
  updateSourceOverflow();

  requestAnimationFrame(() => {
    isVisible.value = true;
  });

  // Track all resources for automatic cleanup
  tracker.trackResource('positioning', () => cleanupPositioning());
  tracker.trackResource('resize-user-select', () => {
    document.body.style.userSelect = '';
  });
});

const handleClose = () => emit('close', props.id);
const toggleShowOriginal = () => {
  showOriginalRevision += 1;
  if (showOriginal.value) document.activeElement?.blur?.();
  showOriginal.value = !showOriginal.value;
  void settings.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', showOriginal.value).catch(error => {
    logger.warn('Failed to persist WINDOW_SHOW_ORIGINAL:', error);
  });
};

const navigateHistory = (direction) => {
  pageEventBus.emit('translation-window-history-navigate', { id: props.id, direction });
};

const handleSourceKeydown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    sourceDraft.value = originalText.value;
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!sourceDraft.value.trim() || sourceDraft.value === originalText.value) return;
  pageEventBus.emit('translation-window-confirm-source', { id: props.id, text: sourceDraft.value });
};

// Resize logic for docked mode
const isResizing = ref(false);
let resizeCompletionToken = null;

// Event-scoped resize completion protection. These listeners are managed
// manually (not via ResourceTracker) so capture/bubble removal matches setup.
// The window capture listener binds protection to one click; document bubble
// cleanup runs after all dismissal consumers have read the marker.
const stopResizeCompletionClick = (event) => {
  const completionToken = resizeCompletionToken;
  if (!completionToken) return;

  if (completionToken.clickEvent && completionToken.clickEvent !== event) {
    clearResizeCompletionMarker();
    return;
  }

  completionToken.clickEvent = event;
  document.addEventListener('click', clearResizeCompletionAfterClick, { capture: false });
};
const clearResizeCompletionAfterClick = (event) => {
  if (resizeCompletionToken?.clickEvent === event) {
    clearResizeCompletionMarker();
  }
};
const clearResizeCompletionMarker = () => {
  resizeCompletionToken = null;
  window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
  window.removeEventListener('click', stopResizeCompletionClick, { capture: true });
  document.removeEventListener('click', clearResizeCompletionAfterClick, { capture: false });
  document.removeEventListener('pointerdown', clearResizeCompletionMarker, { capture: true });
};
const armResizeCompletionProtection = () => {
  window.addEventListener('click', stopResizeCompletionClick, { capture: true });
  document.addEventListener('pointerdown', clearResizeCompletionMarker, { capture: true, once: true });
};
const disarmResizeCompletionProtection = () => {
  resizeCompletionToken = null;
  window.removeEventListener('click', stopResizeCompletionClick, { capture: true });
  document.removeEventListener('click', clearResizeCompletionAfterClick, { capture: false });
  document.removeEventListener('pointerdown', clearResizeCompletionMarker, { capture: true });
};

const startResize = (event) => {
  isResizing.value = true;
  // Coordinate with outside-click dismissal (same pattern as window dragging):
  // the click generated by completing the resize must not dismiss the window,
  // even when the mouse is released outside it.
  window.__TRANSLATION_WINDOW_IS_RESIZING = true;
  const startX = event.type === 'touchstart' ? event.touches[0].clientX : event.clientX;
  const startWidth = dockedWidth.value;

  const handleResizeMove = (e) => {
    if (!isResizing.value) return;
    const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    let newWidth;
    
    if (dockMode.value === 'left') {
      newWidth = startWidth + (currentX - startX);
    } else {
      newWidth = startWidth - (currentX - startX);
    }
    
    // Bounds
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const minWidth = WindowsConfig.POSITIONING.MIN_DOCKED_WIDTH;
    const maxWidth = vw * WindowsConfig.POSITIONING.MAX_DOCKED_WIDTH_PERCENT;
    
    newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
    dockedWidth.value = newWidth;
    updateDockedWidth(newWidth);
  };

  const stopResize = (event) => {
    isResizing.value = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    if (event.type === 'touchcancel') {
      // A cancelled gesture has no completion click to suppress.
      window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      disarmResizeCompletionProtection();
    } else {
      // Suppress the dismissal triggered by the click that completes the resize;
      // the marker is cleared after that click's dispatch or by the next
      // pointerdown — whichever comes first (no timers).
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;
      resizeCompletionToken = {};
      armResizeCompletionProtection();
    }
    void settings.updateSettingAndPersist('WINDOW_DOCKED_WIDTH', dockedWidth.value).catch(error => {
      logger.warn('Failed to persist WINDOW_DOCKED_WIDTH:', error);
    });
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchmove', handleResizeMove);
    document.removeEventListener('touchend', stopResize);
    document.removeEventListener('touchcancel', stopResize);
    document.body.style.userSelect = '';
  };

  tracker.addEventListener(document, 'mousemove', handleResizeMove);
  tracker.addEventListener(document, 'mouseup', stopResize);
  tracker.addEventListener(document, 'touchmove', handleResizeMove, { passive: false });
  tracker.addEventListener(document, 'touchend', stopResize);
  tracker.addEventListener(document, 'touchcancel', stopResize);
  document.body.style.userSelect = 'none';
};

const handleCopy = async () => {
  if (!translatedText.value) return;
  try {
    const strategy = isDictionary.value ? ExtractionStrategy.CLEAN_DICT : ExtractionStrategy.FULL_TEXT;
    const textToCopy = SimpleMarkdown.getCleanTranslation(translatedText.value, strategy);
    await navigator.clipboard.writeText(textToCopy);
    logger.debug(`Text copied successfully (cleaned)`);
  } catch (error) {
    logger.error(`Failed to copy:`, error);
  }
};

const windowElement = ref(null);
const handleStartDrag = (event) => {
  window.__TRANSLATION_WINDOW_IS_DRAGGING = true;
  startDrag(event);
  
  const customStopDrag = () => {
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = true;
    tracker.trackTimeout(() => {
      window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    }, 300);
  };
  
  tracker.addEventListener(document, 'mouseup', customStopDrag, { once: true });
  tracker.addEventListener(document, 'touchend', customStopDrag, { once: true });
};
</script>

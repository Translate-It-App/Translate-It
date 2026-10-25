<template>
  <SelectionActionPill
    v-if="isVisible && !isFullscreen"
    :style="dynamicStyle"
    :class="{ 'dark': isDarkTheme }"
    :show-translate="showTranslate"
    :show-tts="showTTS"
    :translate-title="t('translateSelectedText')"
    :translate-aria-label="t('translateSelectedText')"
    :tts-title="ttsTitle"
    :tts-aria-label="ttsTitle"
    :tts-state="effectiveTTSState"
    data-translate-ui="true"
    role="toolbar"
    aria-label="Text selection tools"
    @translate="handleTranslateClick"
    @translate-pointerdown="handleTranslatePointerDown"
    @tts="handleTTSClick"
  />
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { injectStylesToShadowRoot } from '@/utils/ui/styleInjector.js';
import { usePositioning } from '@/composables/ui/usePositioning.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { useMobileStore } from '@/store/modules/mobile.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { useTTSSmart } from '@/features/tts/composables/useTTSSmart.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';
import { getLanguageNameFromCode } from '@/shared/config/languageConstants.js';
import SelectionActionPill from '@/components/shared/SelectionActionPill.vue';

const pageEventBus = window.pageEventBus;
const mobileStore = useMobileStore();
const settingsStore = useSettingsStore();
const tracker = useResourceTracker('translation-icon');

// Props
const props = defineProps({
  id: { type: String, required: true },
  position: { type: Object, required: true, default: () => ({ top: 0, left: 0 }) },
  selectionPosition: { type: Object, default: null },
  text: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
});

// Emits
const emit = defineEmits(['click', 'hover', 'focus', 'close']);

// Unified i18n helper
const { t } = useUnifiedI18n();

// TTS Composable instance
const tts = useTTSSmart();

// Visibility Configurations from Settings Store
const showTTS = computed(() => settingsStore.settings.SHOW_TTS_ICON_IN_TOOLBAR !== false);
const showTranslate = computed(() => settingsStore.settings.SHOW_TRANSLATE_ICON_IN_TOOLBAR !== false);
const isDarkTheme = computed(() => settingsStore.isDarkTheme);

// Static initial width calculation for non-reactive usePositioning init
const initialWidth = (() => {
  let count = 0;
  if (settingsStore.settings.SHOW_TRANSLATE_ICON_IN_TOOLBAR !== false) count++;
  if (settingsStore.settings.SHOW_TTS_ICON_IN_TOOLBAR !== false) count++;
  if (count === 0) return 0;
  
  const buttonSize = 28;
  const padding = 4;
  const gap = 2;
  return (count * buttonSize) + ((count - 1) * gap) + padding;
})();

// Reactive state
const isVisible = ref(false);
const isFullscreen = computed(() => mobileStore.isFullscreen);

// Local state for the TTS play action
const localTTSId = ref(null);

// Calculate exact dynamic width based on active buttons
const calculatedWidth = computed(() => {
  let count = 0;
  if (showTranslate.value) count++;
  if (showTTS.value) count++;
  
  if (count === 0) return 0;
  
  const buttonSize = 28;
  const padding = 4; // 2px left + 2px right
  const gap = 2;     // flex gap
  
  return (count * buttonSize) + ((count - 1) * gap) + padding;
});

// Initialize position using calculated initial width
const { positionStyle, cleanup: cleanupPositioning } = usePositioning(props.position, {
  defaultWidth: initialWidth,
  defaultHeight: 32,
  enableDragging: false
});

const dynamicStyle = computed(() => {
  return {
    ...positionStyle.value,
    width: `${calculatedWidth.value}px`,
    height: '32px',
  };
});

// Check if this specific toolbar is responsible for active TTS
const isThisTTSActive = computed(() => {
  if (tts.ttsState.value === 'error' && tts.lastText.value === props.text) {
    return true;
  }
  return !!(localTTSId.value && tts.currentTTSId.value === localTTSId.value);
});

// Current active TTS state for this toolbar
const effectiveTTSState = computed(() => {
  if (tts.ttsState.value === 'loading' && localTTSId.value?.startsWith('pending_')) {
    return 'loading';
  }
  if (isThisTTSActive.value) {
    return tts.ttsState.value;
  }
  return 'idle';
});

// Localized tooltip title for TTS button
const ttsTitle = computed(() => {
  const displayLang = tts.detectedLanguage.value 
    ? getLanguageNameFromCode(tts.detectedLanguage.value) 
    : '';
  const langName = displayLang 
    ? displayLang.charAt(0).toUpperCase() + displayLang.slice(1) 
    : '';
  const langSuffix = langName ? ` (${langName})` : '';

  switch (effectiveTTSState.value) {
    case 'idle':
      return (t('action_speak_text') || 'Speak text') + langSuffix;
    case 'loading':
      return t('window_loading_alt') || 'Loading...';
    case 'playing':
      return (t('action_stop_speaking') || 'Stop speaking') + langSuffix;
    case 'error':
      return tts.errorMessage.value || 'TTS error';
    default:
      return 'Text to speech';
  }
});

// Actions
const handleTranslateClick = () => {
  if (props.disabled) return;

  const clickData = { id: props.id, text: props.text, position: props.selectionPosition || props.position };
  emit('click', clickData);
};

const handleTranslatePointerDown = () => {
  if (props.disabled) return;
};

const handleTTSClick = async () => {
  if (props.disabled) return;

  if (!props.text || !props.text.trim()) {
    return;
  }

  try {
    if (effectiveTTSState.value === 'idle') {
      localTTSId.value = `pending_${Date.now()}`;
      const success = await tts.speak(props.text, 'auto');
      if (success) {
        localTTSId.value = tts.currentTTSId.value;
      } else {
        localTTSId.value = null;
      }
    } else if (effectiveTTSState.value === 'playing' || effectiveTTSState.value === 'loading') {
      const success = await tts.stop();
      if (success) {
        localTTSId.value = null;
      }
    } else if (effectiveTTSState.value === 'error') {
      localTTSId.value = `pending_retry_${Date.now()}`;
      const success = await tts.speak(props.text, 'auto');
      if (success) {
        localTTSId.value = tts.currentTTSId.value;
      } else {
        localTTSId.value = null;
      }
    }
  } catch (error) {
    console.warn('[TranslationIcon] TTS toggle error:', error);
    localTTSId.value = null;
  }
};

// Keyboard Accessibility Handlers
// Life Cycle Animations
const animateIn = () => {
  isVisible.value = true;
};

const animateOut = () => {
  isVisible.value = false;
  
  // Note: Per user preference, we do NOT stop TTS audio on click translate, 
  // but if the toolbar is dismissed (e.g. clicking outside) we want to stop it.
  // We can check if a transition is in progress globally, or just stop it 
  // if it's a true dismissal. The simplest way is to check the global state
  // to see if we're transitioning to a window.
  const isTransitioning = window.windowsManagerInstance?._isIconToWindowTransition;
  if (!isTransitioning) {
    tts.stop();
  }

  tracker.trackTimeout(() => {
    emit('close', props.id);
  }, 300);
};

const handleDismiss = () => {
  animateOut();
};

const handleDismissAll = () => {
  animateOut();
};

// Mount & Listeners Setup
onMounted(async () => {
  // Inject specific styling
  try {
    const { windowsUiStyles } = await import('@/core/content-scripts/chunks/lazy-styles.js');
    if (windowsUiStyles && injectStylesToShadowRoot) {
      injectStylesToShadowRoot(windowsUiStyles, 'vue-windows-specific-styles');
    }
  } catch (error) {
    console.warn('[TranslationIcon] Failed to load lazy styles:', error);
  }

  animateIn();
  
  // Track positioning resource cleanup
  tracker.trackResource('positioning', () => cleanupPositioning());

  // Listeners via resource tracker
  const eventName = `dismiss-icon-${props.id}`;
  tracker.addEventListener(pageEventBus, eventName, handleDismiss);
  tracker.addEventListener(pageEventBus, 'dismiss-all-icons', handleDismissAll);
});

// Explicit cleanup on unmount
onUnmounted(() => {
  // Stop TTS if it's currently active on this instance and NOT transitioning to window
  const isTransitioning = window.windowsManagerInstance?._isIconToWindowTransition;
  if (isThisTTSActive.value && !isTransitioning) {
    tts.stop();
  }
});

// Public Methods Exposure
defineExpose({
  animateIn,
  animateOut,
  handleDismiss
});
</script>

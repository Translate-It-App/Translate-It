<!-- eslint-disable vue/no-v-html -->
<template>
  <div
    ref="containerRef"
    class="ti-translation-display"
    :class="[
      {
        'has-content': hasContent,
        'is-loading': isLoading,
        'has-error': hasError,
        'compact-mode': mode === 'compact',
        'popup-mode': mode === 'popup',
        'sidepanel-mode': mode === 'sidepanel',
        'selection-mode': mode === 'selection',
        'mobile-mode': mode === 'mobile',
        'no-toolbar': !showToolbar,
        'theme-dark': settingsStore.isDarkTheme,
      },
      containerClass,
    ]"
    :style="cssVariables"
  >
    <!-- Simplified Loading State -->
    <div
      v-if="isLoading && !isStreaming"
      class="ti-loading-overlay"
    >
      <TranslationLoadingIndicator :label="t('mobile_selection_translating_label')" />
    </div>

    <!-- Main Content State -->
    <template v-else>
      <!-- Enhanced Actions Toolbar (Desktop/Standard) -->
      <ActionToolbar
        v-if="showToolbar && hasContent && mode !== 'mobile'"
        :text="content"
        :language="lastTranslation?.targetLanguage || targetLanguage"
        :mode="mode === 'sidepanel' ? 'sidepanel' : 'output'"
        :is-dictionary="isDictionary"
        class="ti-display-toolbar"
        :show-copy="showCopyButton"
        :show-paste="false"
        :show-tts="showTTSButton"
        :copy-title="copyTitle"
        :tts-title="ttsTitle"
        @text-copied="handleTextCopied"
        @tts-started="handleTTSStarted"
        @tts-stopped="handleTTSStopped"
        @tts-speaking="handleTTSSpeaking"
        @action-failed="handleActionFailed"
      />

      <!-- Content Display -->
      <div
        ref="contentRef"
        class="ti-translation-content"
        :class="[
          {
            'has-error': hasError,
            'rtl-content': textDirection?.dir === 'rtl',
          },
          contentClass,
        ]"
        :dir="textDirection?.dir || 'ltr'"
        :style="
          mode === 'mobile'
            ? { ...fontStyles, ...cssVariables }
            : { ...(fontStyles || {}), ...(cssVariables || {}) }
        "
        @click="handleContentClick"
      >
        <div
          v-if="hasError"
          class="error-message"
        >
          <div class="error-text">&#32;⚠️ {{ displayErrorMessage }}</div>
          <div
            v-if="canRetry || canOpenSettings"
            class="error-actions"
          >
            <button
              v-if="canRetry"
              type="button"
              class="error-action retry-btn"
              @click="handleRetry"
            >
              🔄 {{ t("action_retry") }}
            </button>
            <button
              v-if="canOpenSettings"
              type="button"
              class="error-action settings-btn"
              @click="handleSettings"
            >
              ⚙️ {{ t("action_settings") }}
            </button>
          </div>
        </div>

        <!-- Placeholder State -->
        <div
          v-else-if="!content"
          class="placeholder-message"
        >
          {{ placeholder }}
        </div>

        <!-- Normal Content with Markdown Support -->
        <div
          v-else
          v-html="sanitizedContent"
        />
      </div>

      <!-- Mobile Actions Row -->
      <div
        v-if="mode === 'mobile' && hasContent"
        class="ti-mobile-actions"
        @click.stop
      >
        <button
          class="mobile-action-btn secondary-action"
          :title="
            ttsStatus === 'playing'
              ? t('mobile_selection_stop_tooltip')
              : ttsTitle
          "
          @click="handleMobileSpeak"
        >
          <svg
            v-if="ttsStatus === 'playing'"
            viewBox="0 0 24 24"
            class="mobile-action-icon"
          >
            <rect
              x="6"
              y="6"
              width="12"
              height="12"
              rx="1.5"
            />
          </svg>
          <img
            v-else
            src="@/icons/ui/speaker.png"
            :alt="ttsAlt"
            class="mobile-action-icon"
          />
          <span class="mobile-action-label">
            {{
              ttsStatus === "playing"
                ? t("mobile_selection_stop_label")
                : t("mobile_selection_speak_tooltip")
            }}
          </span>
        </button>

        <button
          class="mobile-action-btn secondary-action"
          :title="copyTitle"
          @click="handleMobileCopy"
        >
          <img
            src="@/icons/ui/copy.png"
            :alt="copyAlt"
            class="mobile-action-icon"
          />
          <span class="mobile-action-label">{{
            t("mobile_selection_copy_tooltip")
          }}</span>
        </button>

        <button
          class="mobile-action-btn icon-only-action"
          :title="t('mobile_selection_history_tooltip')"
          @click="handleMobileHistory"
        >
          <img
            src="@/icons/ui/history.svg"
            :alt="t('mobile_history_button_alt')"
            class="mobile-action-icon"
          />
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
import "./TranslationDisplay.scss";
import { ref, computed, watch, onMounted } from "vue";
import { useSettingsStore } from "@/features/settings/stores/settings.js";
import { useTextDirection } from "@/composables/shared/useTextDirection.js";
import {
  SimpleMarkdown,
  ExtractionStrategy,
} from "@/shared/utils/text/markdown.js";
import { TranslationMode } from "@/shared/config/config.js";
import { renderMarkdownPreview } from "@/shared/utils/text/markdownPreview.js";
import ActionToolbar from "@/features/text-actions/components/ActionToolbar.vue";
import TranslationLoadingIndicator from "@/components/shared/TranslationLoadingIndicator.vue";
import { useFont } from "@/composables/shared/useFont.js";
import { useUnifiedI18n } from "@/composables/shared/useUnifiedI18n.js";
import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";

// Localization
const { t, locale } = useUnifiedI18n();
const settingsStore = useSettingsStore();

// Props
const props = defineProps({
  // Core content
  content: {
    type: String,
    default: "",
  },
  language: {
    type: String,
    default: "fa",
  },

  // State
  isLoading: {
    type: Boolean,
    default: false,
  },
  isStreaming: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: "",
  },
  errorType: {
    type: String,
    default: null,
  },

  // Enhanced error props
  canRetry: {
    type: Boolean,
    default: false,
  },
  canOpenSettings: {
    type: Boolean,
    default: false,
  },
  onRetry: {
    type: Function,
    default: null,
  },
  onOpenSettings: {
    type: Function,
    default: null,
  },

  // Display options
  mode: {
    type: String,
    default: "standard", // standard, compact, popup, sidepanel, selection, mobile
    validator: (value) =>
      [
        "standard",
        "compact",
        "popup",
        "sidepanel",
        "selection",
        "mobile",
      ].includes(value),
  },
  placeholder: {
    type: String,
    default: "Translation will appear here...",
  },

  // Formatting options
  enableMarkdown: {
    type: Boolean,
    default: true,
  },
  enableLabelFormatting: {
    type: Boolean,
    default: true,
  },
  maxHeight: {
    type: String,
    default: null,
  },

  // Toolbar options
  showToolbar: {
    type: Boolean,
    default: true,
  },
  showCopyButton: {
    type: Boolean,
    default: true,
  },
  showTTSButton: {
    type: Boolean,
    default: true,
  },

  // Animation
  showFadeInAnimation: {
    type: Boolean,
    default: true,
  },

  // i18n titles
  copyTitle: {
    type: String,
    default: "Copy result",
  },
  copyAlt: {
    type: String,
    default: "Copy",
  },
  ttsTitle: {
    type: String,
    default: "Play result",
  },
  ttsAlt: {
    type: String,
    default: "Play",
  },
  // Target language for TTS
  targetLanguage: {
    type: String,
    default: "fa",
  },
  lastTranslation: {
    type: Object,
    default: null,
  },
  // TTS Status for mobile toggle
  ttsStatus: {
    type: String,
    default: "idle", // idle, loading, playing, paused, error
  },

  // Enhanced popup-specific props
  containerClass: {
    type: String,
    default: "",
  },
  contentClass: {
    type: String,
    default: "",
  },
});

// Emits
const emit = defineEmits([
  "text-copied",
  "text-pasted",
  "tts-started",
  "tts-stopped",
  "tts-speaking", // backward compatibility
  "action-failed",
  "retry-requested",
  "settings-requested",
  "history-requested",
  "content-click",
]);

// Refs
const contentRef = ref(null);
const containerRef = ref(null);

// Scoped logger
const logger = getScopedLogger(LOG_COMPONENTS.UI, "TranslationDisplay");

// Computed
const hasContent = computed(
  () =>
    (props.content && props.content.trim().length > 0 && !props.isLoading) ||
    (props.isStreaming && props.content),
);
const hasError = computed(() => !!props.error && !props.isLoading);

// Check if current translation is in dictionary mode
const isDictionary = computed(() => {
  const mode = props.lastTranslation?.mode || props.mode;
  return (
    mode === TranslationMode.Dictionary_Translation ||
    mode === TranslationMode.LEGACY_DICTIONARY
  );
});

// Reactive error message display
const displayErrorMessage = computed(() => {
  if (!props.errorType) return props.error;

  // Construct translation key (standard ERRORS_ prefix)
  const key = props.errorType.startsWith("ERRORS_")
    ? props.errorType
    : `ERRORS_${props.errorType}`;
  const translated = t(key);

  // For specific technical errors, if we have a detailed message from the provider, show it
  const useRawMessage = [
    "SERVER_ERROR",
    "MODEL_OVERLOADED",
    "HTTP_ERROR",
    "TRANSLATION_ERROR",
    "API_RESPONSE_INVALID",
    "UNKNOWN",
  ].includes(props.errorType);

  if (useRawMessage && props.error && props.error !== props.errorType) {
    return props.error;
  }

  // If translation exists, return it, otherwise fallback to static error prop
  return translated && translated !== key ? translated : props.error;
});

// Safe language code detector for UI
const currentUiLang = computed(() => {
  const lang = locale.value || "en";
  return String(lang).toLowerCase();
});

// Setup centralized text direction using the composable
const { direction: detectedDir, textAlign: detectedAlign } = useTextDirection(
  computed(() => (hasError.value ? "" : props.content)),
  computed(() => (hasError.value ? currentUiLang.value : props.targetLanguage)),
);

// Final text direction for display, with special handling for error states
const textDirection = computed(() => {
  if (hasError.value) {
    return {
      dir: detectedDir.value,
      textAlign: "center", // Center align errors for better UX
    };
  }

  return {
    dir: detectedDir.value,
    textAlign: detectedAlign.value,
  };
});

// Font management with safe error handling and RTL-aware CSS variables
let fontStyles = ref({});
let cssVariables = ref({});

try {
  // Initialize useFont with target language (or UI language if there's an error)
  const { fontStyles: computedFontStyles, cssVariables: computedCssVariables } =
    useFont(
      computed(() =>
        hasError.value ? currentUiLang.value : props.targetLanguage,
      ),
      {
        enableSmartDetection: true,
        fallbackFont: "system",
        enableCSSVariables: true,
        forcedDirection: computed(() => textDirection.value.dir), // Pass detected direction
      },
    );

  fontStyles = computedFontStyles;

  // Override CSS variables to ensure proper RTL/LTR direction
  cssVariables = computed(() => {
    const vars = { ...computedCssVariables.value };
    // Ensure direction variables match our text direction
    if (textDirection.value.dir === "rtl") {
      vars["--translation-direction"] = "rtl";
      vars["--translation-text-align"] = "right";
      vars["--list-padding"] = "0 3em 0 0";
      vars["--list-text-align"] = "right";
    } else {
      vars["--translation-direction"] = "ltr";
      vars["--translation-text-align"] = "left";
      vars["--list-padding"] = "0 0 0 3em";
      vars["--list-text-align"] = "left";
    }
    return vars;
  });

  logger.debug(
    "Font management initialized successfully with RTL-aware CSS variables",
  );
} catch (error) {
  logger.warn("Font management not available, using fallback styles:", error);
  // Fallback styles when useFont fails
  fontStyles = computed(() => ({}));

  // Create fallback CSS variables with proper RTL/LTR support
  cssVariables = computed(() => {
    const dir = textDirection.value.dir;
    return {
      "--translation-direction": dir,
      "--translation-text-align": dir === "rtl" ? "right" : "left",
      "--list-padding": dir === "rtl" ? "0 2em 0 0" : "0 0 0 2em",
      "--list-text-align": dir === "rtl" ? "right" : "left",
    };
  });
}

// Sanitized content computed property
const sanitizedContent = computed(() => {
  return renderedContent.value;
});

const renderedContent = computed(() => {
  if (!props.content) {
    return "";
  }

  return renderMarkdownPreview(props.content, {
    fallbackDir: textDirection.value.dir,
    isDictionary: isDictionary.value,
    enableMarkdown: props.enableMarkdown,
  });
});

// Watchers
watch(
  () => props.content,
  () => {
    // Fade-in animation disabled as requested
  },
  { immediate: true },
);

// Action Toolbar Event Handlers
const handleTextCopied = (text) => {
  emit("text-copied", text);
};

const handleTTSStarted = (data) => {
  emit("tts-started", data);
  emit("tts-speaking", data); // backward compatibility
};

const handleTTSStopped = () => {
  emit("tts-stopped");
};

const handleTTSSpeaking = (data) => {
  emit("tts-speaking", data);
};

const handleContentClick = () => {
  emit("content-click");
};

const handleActionFailed = (error) => {
  emit("action-failed", error);
};

const handleMobileSpeak = () => {
  if (props.ttsStatus === "playing") {
    emit("tts-stopped");
  } else {
    emit("tts-started", {
      text: props.content,
      language: props.targetLanguage,
    });
  }
};

const handleMobileCopy = async () => {
  const strategy = isDictionary.value
    ? ExtractionStrategy.CLEAN_DICT
    : ExtractionStrategy.FULL_TEXT;
  const textToCopy = SimpleMarkdown.getCleanTranslation(
    props.content,
    strategy,
  );

  try {
    await navigator.clipboard.writeText(textToCopy);
    emit("text-copied", textToCopy);
  } catch (error) {
    emit("action-failed", error);
  }
};

const handleMobileHistory = () => {
  emit("history-requested");
};

// Error action handlers
const handleRetry = () => {
  if (props.onRetry) {
    props.onRetry();
  }
  emit("retry-requested");
};

const handleSettings = () => {
  if (props.onOpenSettings) {
    props.onOpenSettings();
  }
  emit("settings-requested");
};

// Setup dynamic height for different modes
onMounted(() => {
  if (props.maxHeight && contentRef.value) {
    contentRef.value.style.maxHeight = props.maxHeight;
  }
});
</script>

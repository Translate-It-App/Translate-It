<template>
  <div
    class="ti-m-dashboard-view"
    :class="{ 'is-dark': settingsStore.isDarkTheme }"
  >
    <div class="ti-m-dashboard-scroll-container">
      <!-- Translate Page Button -->
      <button
        v-if="allowedFeatures.pageTranslation"
        class="ti-m-action-btn"
        :class="{ 'is-disabled': !canOpenPageTranslation }"
        @click="translatePage"
      >
        <div class="ti-m-icon-container ti-m-icon-translate-page">
          <img
            :src="wholePageIcon"
            :alt="t('mobile_dashboard_page_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_page_label", "Page")
        }}</span>
      </button>

      <!-- Select Element Button -->
      <button
        v-if="allowedFeatures.selectElement"
        class="ti-m-action-btn"
        :class="{ 'is-disabled': !isSelectElementSupported }"
        @click="activateSelectElement"
      >
        <div class="ti-m-icon-container ti-m-icon-select-element">
          <img
            :src="selectIcon"
            :alt="t('mobile_dashboard_select_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_select_label", "Select")
        }}</span>
      </button>

      <!-- Screen Capture Button -->
      <button
        v-if="allowedFeatures.screenCapture"
        class="ti-m-action-btn"
        @click="handleScreenCapture"
      >
        <div class="ti-m-icon-container ti-m-icon-screen-capture">
          <img
            :src="captureIcon"
            :alt="t('mobile_dashboard_capture_label', 'Capture')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_capture_label", "Capture")
        }}</span>
      </button>

      <!-- Manual Translation Button -->
      <button
        class="ti-m-action-btn"
        @click="goToInputView"
      >
        <div class="ti-m-icon-container ti-m-icon-manual-input">
          <img
            :src="inputIcon"
            :alt="t('mobile_dashboard_input_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_input_label", "Input")
        }}</span>
      </button>

      <!-- History Button -->
      <button
        class="ti-m-action-btn"
        @click="goToHistoryView"
      >
        <div class="ti-m-icon-container ti-m-icon-history">
          <img
            :src="historyIcon"
            :alt="t('mobile_dashboard_history_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_history_label", "History")
        }}</span>
      </button>

      <!-- TTS Button (Dynamic) -->
      <button
        v-if="isTTSVisible"
        class="ti-m-action-btn"
        @click="handleTTS"
      >
        <div
          class="ti-m-icon-container ti-m-icon-tts"
          :class="{ 'is-playing': tts.isPlaying.value }"
        >
          <!-- Loading State (Spinning Speaker) -->
          <svg
            v-if="tts.isLoading.value"
            class="ti-toolbar-icon ti-m-tts-loader"
            viewBox="0 0 24 24"
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

          <!-- Playing State (Stop Icon) -->
          <svg
            v-else-if="tts.isPlaying.value"
            class="ti-toolbar-icon ti-m-tts-stop"
            viewBox="0 0 24 24"
          >
            <rect
              x="6"
              y="6"
              width="12"
              height="12"
              rx="1.5"
              fill="currentColor"
            />
          </svg>

          <!-- Idle State (Standard Icon) -->
          <img
            v-else
            :src="ttsIcon"
            :alt="t('mobile_selection_speak_tooltip')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          tts.isPlaying.value
            ? t("mobile_selection_stop_label")
            : t("mobile_selection_speak_tooltip")
        }}</span>
      </button>

      <!-- Revert Element Translations (Dynamic) -->
      <button
        v-if="hasElementTranslations"
        class="ti-m-action-btn"
        @click="revertTranslations"
      >
        <div class="ti-m-icon-container ti-m-icon-revert">
          <img
            :src="revertIcon"
            :alt="t('mobile_dashboard_revert_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_revert_label", "Revert")
        }}</span>
      </button>

      <!-- Settings Button -->
      <button
        class="ti-m-action-btn"
        @click="openSettings"
      >
        <div class="ti-m-icon-container ti-m-icon-settings">
          <img
            :src="settingsIcon"
            :alt="t('mobile_dashboard_settings_label')"
            class="ti-toolbar-icon"
          />
        </div>
        <span class="ti-m-action-label">{{
          t("mobile_dashboard_settings_label", "Settings")
        }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import "./DashboardView.scss";
import { ref, computed, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useUnifiedI18n } from "@/composables/shared/useUnifiedI18n.js";
import { useMobileStore } from "@/store/modules/mobile.js";
import { useSettingsStore } from "@/features/settings/stores/settings.js";
import { useErrorHandler } from "@/composables/shared/useErrorHandler.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import {
  getProviderModeValidationError,
  getProviderModeValidationMessage,
  resolveModeProvider,
} from "@/features/translation/utils/providerSelection.js";
import { MessageActions } from "@/shared/messaging/core/MessageActions.js";
import {
  sendMessage,
  sendRegularMessage,
} from "@/shared/messaging/core/UnifiedMessaging.js";
import { WINDOWS_MANAGER_EVENTS } from "@/core/PageEventBus.js";
import { SELECTION_EVENTS } from "@/features/text-selection/events/SelectionEvents.js";
import { MOBILE_CONSTANTS } from "@/shared/constants/mobile.js";
import { CONFIG, TranslationMode } from "@/shared/config/config.js";
import { useTTSSmart } from "@/features/tts/composables/useTTSSmart.js";
import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import ExclusionChecker from "@/features/exclusion/core/ExclusionChecker.js";
import ExtensionContextManager from "@/core/extensionContext.js";

import wholePageIcon from "@/icons/ui/whole-page.png";
import selectIcon from "@/icons/ui/select.png";
import captureIcon from "@/icons/ui/capture.svg";
import inputIcon from "@/icons/extension/extension_icon_128.svg";
import settingsIcon from "@/icons/ui/settings.png";
import revertIcon from "@/icons/ui/revert.png";
import historyIcon from "@/icons/ui/history.svg";
import ttsIcon from "@/icons/ui/speaker.png";

const logger = getScopedLogger(LOG_COMPONENTS.MOBILE, "DashboardView");
const mobileStore = useMobileStore();
const settingsStore = useSettingsStore();
const { hasElementTranslations } = storeToRefs(mobileStore);
const { t } = useUnifiedI18n();
const { handleError } = useErrorHandler();
const pageEventBus = window.pageEventBus;
const tts = useTTSSmart();
const exclusionChecker = ExclusionChecker.getInstance();

const sendPageCommand = (message) => {
  void sendRegularMessage(message, { returnFailureResponse: true })
    .then((response) => {
      if (response?.success === false) {
        logger.debug("Page translation command rejected", response);
      }
    })
    .catch((error) => {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(
          error,
          "mobile-dashboard:page-translation",
        );
      } else {
        logger.error("Page translation command failed:", error);
      }
    });
};

const getProviderForMode = (mode) => resolveModeProvider(
  mode,
  settingsStore.settings.MODE_PROVIDERS,
  settingsStore.settings.TRANSLATION_API,
  TranslationMode.Dictionary_Translation,
  TranslationMode.Selection,
  CONFIG.TRANSLATION_API,
);

const pageProvider = computed(() => getProviderForMode(TranslationMode.Page));
const selectElementProvider = computed(() =>
  getProviderForMode(TranslationMode.Select_Element),
);

const getModeValidationError = (providerId, mode) =>
  getProviderModeValidationError(providerId, mode, settingsStore.settings);
const checkBulkSupport = (providerId, mode) =>
  !getModeValidationError(providerId, mode);

const isPageTranslationSupported = computed(() =>
  checkBulkSupport(pageProvider.value, TranslationMode.Page),
);
const isSelectElementSupported = computed(() =>
  checkBulkSupport(selectElementProvider.value, TranslationMode.Select_Element),
);
const canOpenPageTranslation = computed(() =>
  isPageTranslationSupported.value ||
  mobileStore.pageTranslationData.isTranslating ||
  mobileStore.pageTranslationData.isAutoTranslating ||
  mobileStore.pageTranslationData.isTranslated,
);

const handleBulkNotSupported = async (error) => {
  mobileStore.closeSheet();
  await handleError(
    getProviderModeValidationMessage(error, t),
    "mobile-dashboard:bulk-check",
    {
      showToast: true,
      type: error?.type || ErrorTypes.VALIDATION,
    },
  );
};

const allowedFeatures = ref({
  selectElement: true,
  pageTranslation: true,
  screenCapture: true,
});

const updateAllowedFeatures = async () => {
  try {
    const status = await exclusionChecker.getFeatureStatus();
    if (status.initialized) {
      allowedFeatures.value.selectElement =
        status.features.selectElement?.allowed ?? true;
      allowedFeatures.value.pageTranslation =
        status.features.pageTranslation?.allowed ?? true;
      allowedFeatures.value.screenCapture =
        status.features.screenCapture?.allowed ?? true;
      logger.debug(
        "Mobile Dashboard allowed features updated",
        allowedFeatures.value,
      );
    }
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:features",
      );
    } else {
      logger.error("Update allowed features failed:", err);
    }
  }
};

const pendingSelection = ref({
  text: "",
  hasSelection: false,
});

const isTTSVisible = computed(
  () => pendingSelection.value.hasSelection || tts.isPlaying.value,
);

const translatePage = (event) => {
  try {
    const isCurrentlyTranslating =
      mobileStore.pageTranslationData.isTranslating ||
      mobileStore.pageTranslationData.isAutoTranslating ||
      mobileStore.pageTranslationData.isTranslated;

    if (isCurrentlyTranslating) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      mobileStore.navigate(MOBILE_CONSTANTS.VIEWS.PAGE_TRANSLATION);
    } else {
      const provider = pageProvider.value;
      const validationError = getModeValidationError(provider, TranslationMode.Page);
      if (validationError) {
        handleBulkNotSupported(validationError);
        return;
      }
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      logger.info("Page translation requested from Mobile Dashboard", {
        provider,
      });
      sendPageCommand({
        action: MessageActions.PAGE_TRANSLATE,
        data: { provider },
      });
      mobileStore.navigate(MOBILE_CONSTANTS.VIEWS.PAGE_TRANSLATION);

      // Respect the auto-close setting
      if (settingsStore.settings.MOBILE_PAGE_TRANSLATION_AUTO_CLOSE) {
        mobileStore.closeSheet();
      }
    }
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      // Close dashboard to make toast visible
      mobileStore.closeSheet();
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:translate-page",
      );
    } else {
      logger.error("Page translation handler failed:", err);
    }
  }
};

const activateSelectElement = async () => {
  try {
    const provider = selectElementProvider.value;
    const validationError = getModeValidationError(provider, TranslationMode.Select_Element);
    if (validationError) {
      handleBulkNotSupported(validationError);
      return;
    }
    logger.info("Select Element mode requested from Mobile Dashboard", {
      provider,
    });
    mobileStore.closeSheet();
    await sendMessage({
      action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
      data: { provider },
    });
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:select-element",
      );
    } else {
      logger.error("Select Element handler failed:", err);
    }
  }
};

const handleScreenCapture = async () => {
  try {
    logger.info("Screen Capture requested from Mobile Dashboard");
    mobileStore.closeSheet();
    await sendMessage({
      action: MessageActions.START_SCREEN_CAPTURE,
    });
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:screen-capture",
      );
    } else {
      logger.error("Screen Capture handler failed:", err);
    }
  }
};

const goToInputView = () => {
  try {
    logger.debug("Navigating to Input View");
    mobileStore.resetSelectionData();
    mobileStore.navigate(MOBILE_CONSTANTS.VIEWS.INPUT);
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:input-view",
      );
    } else {
      logger.error("Navigate to Input View failed:", err);
    }
  }
};

const goToHistoryView = () => {
  logger.debug("Navigating to History View");
  mobileStore.navigate(MOBILE_CONSTANTS.VIEWS.HISTORY);
};
const openSettings = () => {
  logger.debug("Opening Settings from Mobile Dashboard");
  pageEventBus.emit(WINDOWS_MANAGER_EVENTS.OPEN_SETTINGS);
  mobileStore.closeSheet(); // Ensure the sheet is closed when opening settings
};

const revertTranslations = () => {
  try {
    logger.info("Reverting page translations from Mobile Dashboard");
    pageEventBus.emit("revert-translations");
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(
        err,
        "mobile-dashboard:revert",
      );
    } else {
      logger.error("Revert translations handler failed:", err);
    }
  }
};

const handleTTS = async () => {
  try {
    if (tts.isPlaying.value) {
      logger.info("Stopping TTS from Mobile Dashboard");
      await tts.stop();
    } else if (pendingSelection.value.hasSelection) {
      logger.info("Starting TTS from Mobile Dashboard for selected text");
      await tts.speak(pendingSelection.value.text);
    }
  } catch (err) {
    if (ExtensionContextManager.isContextError(err)) {
      ExtensionContextManager.handleContextError(err, "mobile-dashboard:tts");
    } else {
      logger.error("TTS handler failed:", err);
    }
  }
};

const handleSelectionPending = (detail) => {
  logger.debug("Received global selection change event in Dashboard", {
    textLength: detail.text?.length,
  });
  pendingSelection.value = {
    text: detail.text,
    hasSelection: !!detail.text,
  };
};

const handleSelectionClear = () => {
  logger.debug("Received global selection clear event in Dashboard");
  pendingSelection.value = {
    text: "",
    hasSelection: false,
  };
};

onMounted(() => {
  // Check for existing native selection
  const nativeSelection = window.getSelection()?.toString().trim();

  if (nativeSelection) {
    pendingSelection.value = {
      text: nativeSelection,
      hasSelection: true,
    };
  }

  // Listen for global selection events (Coordinator Pattern)
  if (pageEventBus) {
    pageEventBus.on(
      SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE,
      handleSelectionPending,
    );
    pageEventBus.on(
      SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR,
      handleSelectionClear,
    );

    // Listen for settings and exclusion changes
    pageEventBus.on("FEATURE_STATUS_CHANGED", updateAllowedFeatures);
    pageEventBus.on("sync-interaction-listeners", updateAllowedFeatures);
  }

  // Initial check
  updateAllowedFeatures();
});

onUnmounted(() => {
  if (pageEventBus) {
    pageEventBus.off(
      SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE,
      handleSelectionPending,
    );
    pageEventBus.off(
      SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR,
      handleSelectionClear,
    );
    pageEventBus.off("FEATURE_STATUS_CHANGED", updateAllowedFeatures);
    pageEventBus.off("sync-interaction-listeners", updateAllowedFeatures);
  }
});
</script>

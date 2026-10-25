import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { WindowsConfig } from "../core/WindowsConfig.js";
import { WindowsManagerEvents } from "@/core/PageEventBus.js";
import settingsManager from "@/shared/managers/SettingsManager.js";
import {
  SelectionTranslationMode,
  TranslationMode,
} from "@/shared/config/config.js";
import ExtensionContextManager from "@/core/extensionContext.js";
import { deviceDetector } from "@/utils/browser/compatibility.js";
import ExclusionChecker from "@/features/exclusion/core/ExclusionChecker.js";
import { MOBILE_CONSTANTS } from "@/shared/constants/mobile.js";
import { getSelectionWindowErrorPresentation } from "./SelectionWindowErrorPresenter.js";

/**
 * Handles UI display logic for translation windows and icons
 */
export class DisplayManager {
  constructor(facade, dependencies) {
    this.facade = facade;
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, "DisplayManager");

    // Inject dependencies from facade
    this.state = dependencies.state;
    this.crossFrameManager = dependencies.crossFrameManager;
    this.translationHandler = dependencies.translationHandler;
    this.errorHandler = dependencies.errorHandler;
    this.clickManager = dependencies.clickManager;
    this.themeManager = dependencies.themeManager;
    this._outsideClickActivationTimer = null;
  }

  _clearOutsideClickActivationTimer() {
    if (this._outsideClickActivationTimer === null) return;

    clearTimeout(this._outsideClickActivationTimer);
    this._outsideClickActivationTimer = null;
  }

  _scheduleOutsideClickActivation() {
    this._clearOutsideClickActivationTimer();
    this._outsideClickActivationTimer = setTimeout(() => {
      this._outsideClickActivationTimer = null;

      if (
        this.state.hasActiveElements &&
        !this.state.pendingTranslationWindow
      ) {
        this.clickManager.addOutsideClickListener();

        if (this.crossFrameManager && this.crossFrameManager.isTopFrame) {
          this.crossFrameManager.messageRouter._broadcastToAllIframes({
            type: "translateit-activate-click-listeners",
            frameId: this.crossFrameManager.frameId,
            timestamp: Date.now(),
          });
        }
      }
    }, WindowsConfig.TIMEOUTS.OUTSIDE_CLICK_DELAY);
  }

  cleanup() {
    this._clearOutsideClickActivationTimer();
  }

  /**
   * Determine if we should use Mobile UI based on device detection and user preference
   */
  shouldUseMobileUI() {
    const mode = settingsManager.get(
      "MOBILE_UI_MODE",
      MOBILE_CONSTANTS.UI_MODE.AUTO,
    );
    if (mode === MOBILE_CONSTANTS.UI_MODE.MOBILE) return true;
    if (mode === MOBILE_CONSTANTS.UI_MODE.DESKTOP) return false;
    return deviceDetector.shouldEnableMobileUI();
  }

  /**
   * Show translation window or icon for selected text
   */
  async show(selectedText, position, options = {}) {
    if (!ExtensionContextManager.isValidSync()) {
      this.logger.debug("Extension context invalid, aborting show()");
      return;
    }

    if (!selectedText || !position) {
      this.logger.debug("Aborting show(): Missing text or position");
      return;
    }

    if (this.state.isProcessing) {
      return;
    }

    this.logger.info("DisplayManager.show() called", {
      text: selectedText ? selectedText.substring(0, 30) + "..." : "null",
      position,
      options,
    });

    // 1. Check for structural permissions
    const exclusionChecker = ExclusionChecker.getInstance();
    const isAllowed = await exclusionChecker.isFeatureAllowed("windowsManager");
    if (!isAllowed) {
      this.logger.debug("WindowsManager not allowed: Permission check failed");
      return;
    }

    const isExplicitAction =
      options.immediate === true ||
      options.mode === TranslationMode.ScreenCapture;

    const selectionTranslationMode =
      options.immediate || isExplicitAction ?
        SelectionTranslationMode.IMMEDIATE
      : settingsManager.get(
          "selectionTranslationMode",
          SelectionTranslationMode.ON_CLICK,
        );

    // 2. Check for interaction conditions
    if (
      selectionTranslationMode === SelectionTranslationMode.IMMEDIATE &&
      !options.immediate &&
      !isExplicitAction
    ) {
      const requireCtrl = settingsManager.get(
        "REQUIRE_CTRL_FOR_TEXT_SELECTION",
        false,
      );
      if (requireCtrl && options.ctrlPressed !== true) {
        this.logger.debug("Ctrl requirement not met for immediate translation");
        return;
      }
    }

    if (this._shouldSkipShow(selectedText)) {
      this.logger.debug("Skipping show() - same text already visible");
      return;
    }

    // Mobile specific
    if (this.shouldUseMobileUI()) {
      if (selectionTranslationMode === SelectionTranslationMode.IMMEDIATE) {
        this.logger.info(
          "Mobile + Immediate mode: showing mobile sheet immediately",
        );
        await this._showMobileSheet(selectedText, options);
        return;
      }

      if (selectionTranslationMode === SelectionTranslationMode.ON_FAB_CLICK) {
        this.logger.info("Mobile + onFabClick mode: preparing data for FAB");
        this.state.setOriginalText(selectedText);
        this.clickManager.addOutsideClickListener();
      }
    }

    const isTextSelectionEnabled = settingsManager.get(
      "TRANSLATE_ON_TEXT_SELECTION",
      true,
    );
    const isOnClickMode =
      selectionTranslationMode === SelectionTranslationMode.ON_CLICK;
    const isOnFabClickMode =
      selectionTranslationMode === SelectionTranslationMode.ON_FAB_CLICK;

    if (!isTextSelectionEnabled && !isExplicitAction) {
      this.logger.debug(
        "TRANSLATE_ON_TEXT_SELECTION is disabled, preserving for external modules",
      );
      this.state.setOriginalText(selectedText);
      await this.facade.dismiss(false, true);
      return;
    }

    const preserveSelection =
      this.facade._isIconToWindowTransition ||
      isOnClickMode ||
      isOnFabClickMode;

    // Support for updating existing window if pinned or docked
    if (
      this.state.isVisible &&
      !this.state.isIconMode &&
      (this.state.isPinned || this.state.dockMode !== "none")
    ) {
      this.logger.info("Updating existing pinned/docked window");

      if (
        this.translationHandler &&
        typeof this.translationHandler.cancelAllTranslations === "function"
      ) {
        this.translationHandler.cancelAllTranslations();
      }
      this.state.setTranslationCancelled(false);

      await this._updateExistingWindow(selectedText, options);
      return;
    }

    if (!this.facade._isIconToWindowTransition) {
      this.state.setProvider(null);
    }

    await this.facade.dismiss(false, preserveSelection);
    this.facade._isIconToWindowTransition = false;

    if (!selectedText) return;

    this.state.setProcessing(true);

    try {
      if (
        selectionTranslationMode === SelectionTranslationMode.ON_FAB_CLICK &&
        !isExplicitAction
      ) {
        this.logger.info("onFabClick mode: selection handled by external UI");
        this.state.setOriginalText(selectedText);
        this.facade._addDismissListener();
      } else if (
        selectionTranslationMode === SelectionTranslationMode.ON_CLICK
      ) {
        await this._showIcon(selectedText, position);
      } else {
        await this._showWindow(selectedText, position, options);
      }
    } finally {
      this.state.setProcessing(false);
    }
  }

  /**
   * Update existing visible window with new translation
   */
  async _updateExistingWindow(selectedText, options = {}) {
    if (!selectedText) return;

    const windowId = this.state.activeWindowId;
    if (!windowId) {
      this.logger.warn("Cannot update existing window: activeWindowId is null");
      return;
    }

    const isInitialLoadingWindow = this.state.isInitialLoadingWindow?.(windowId) === true;

    this.logger.info("Updating existing window with new text", {
      windowId,
      textLength: selectedText.length,
    });

    this.state.setOriginalText(selectedText);
    this.state.setProcessing(true);

    WindowsManagerEvents.updateWindow(windowId, {
      isLoading: true,
      isError: false,
      initialTranslatedText: "",
      selectedText,
    });

    try {
      const translationResult = await this.facade._startTranslationProcess(
        selectedText,
        windowId,
        options,
      );

      if (!translationResult || this.state.isTranslationCancelled || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(translationResult._requestId))) {
        this.logger.info("Existing window translation cancelled or null");
        return;
      }

      WindowsManagerEvents.updateWindow(windowId, {
        ...(isInitialLoadingWindow ? { initialSize: "normal" } : {}),
        isLoading: false,
        isStreaming: false,
        isError: false,
        initialTranslatedText: translationResult.translatedText,
        sourceLanguage: translationResult.sourceLanguage || "auto",
        detectedSourceLanguage: translationResult.sourceLanguage,
        targetLanguage: translationResult.targetLanguage,
        provider: translationResult.provider,
        mode: translationResult.mode,
        ...this.facade._historyUpdate(this.state.translationHistory[this.state.historyIndex]),
      });
      if (isInitialLoadingWindow) this.state.clearInitialLoadingWindow?.(windowId);

      this.state.setProvider(translationResult.provider);
    } catch (error) {
      if (this.state.isTranslationCancelled) {
        this.logger.debug("Ignoring error in cancelled translation");
        return;
      }

      this.logger.debug(
        "Update existing window translation failed:",
        error.message,
      );

      const presentation = await getSelectionWindowErrorPresentation(
        error,
        "windows-translation",
        this.errorHandler,
      );
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

      const { errorInfo } = presentation;
      const fallbackProvider = this.translationHandler.getEffectiveProvider(
        selectedText,
        { provider: this.state.provider },
      );

      WindowsManagerEvents.updateWindow(windowId, {
        ...(isInitialLoadingWindow ? { initialSize: "normal" } : {}),
        isLoading: false,
        isStreaming: false,
        isError: true,
        errorType: errorInfo.type,
        canRetry: errorInfo.canRetry,
        needsSettings: errorInfo.needsSettings,
        initialTranslatedText: errorInfo.message,
        provider: fallbackProvider,
      });
      if (isInitialLoadingWindow) this.state.clearInitialLoadingWindow?.(windowId);
    } finally {
      this.state.setProcessing(false);
    }
  }

  /**
   * Show mobile-specific bottom sheet
   */
  async _showMobileSheet(selectedText, options = {}) {
    if (!selectedText) return;

    this.logger.info("Creating mobile translation sheet", {
      textLength: selectedText.length,
      options,
    });

    this.state.setOriginalText(selectedText);
    this.state.setTranslationCancelled(false);
    this.state.setVisible(true);

    WindowsManagerEvents.showMobileSheet({
      text: selectedText,
      view: MOBILE_CONSTANTS.VIEWS.SELECTION,
      state: MOBILE_CONSTANTS.SHEET_STATE.PEEK,
      isLoading: true,
      mode: options.mode || null,
    });

    try {
      const translationResult = await this.facade._startTranslationProcess(
        selectedText,
        null,
        options,
      );

      if (!translationResult || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(translationResult._requestId))) {
        this.logger.info("Mobile translation cancelled");
        return;
      }

      WindowsManagerEvents.showMobileSheet({
        text: selectedText,
        translation: translationResult.translatedText,
        sourceLanguage: translationResult.sourceLanguage || "auto",
        targetLanguage: translationResult.targetLanguage,
        isLoading: false,
        mode: options.mode || null,
      });
    } catch (error) {
      this.logger.info(
        "Mobile translation failed (handled via UI):",
        error.message,
      );

      const presentation = await getSelectionWindowErrorPresentation(
        error,
        "mobile-translation",
        this.errorHandler,
      );
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

      const { errorInfo } = presentation;

      WindowsManagerEvents.showMobileSheet({
        text: selectedText,
        isLoading: false,
        isStreaming: false,
        isError: true,
        error: errorInfo.message,
        mode: options.mode || null,
      });
    }
  }

  /**
   * Check if we should skip showing (duplicate text)
   */
  _shouldSkipShow(selectedText) {
    if (!selectedText) return true;

    const isAlreadyVisible = this.state.isVisible || this.state.isIconMode;

    if (isAlreadyVisible && this.state.originalText === selectedText) {
      return true;
    }

    const now = Date.now();
    const dismissGracePeriod = 500;

    if (
      this.facade._lastDismissedText === selectedText &&
      now - this.facade._lastDismissTime < dismissGracePeriod
    ) {
      this.logger.debug("Skipping show() - text was dismissed very recently");
      return true;
    }

    return false;
  }

  /**
   * Show translate icon
   */
  async _showIcon(selectedText, position) {
    if (!ExtensionContextManager.isValidSync()) {
      this.logger.debug("Extension context invalid, cannot create icon");
      return;
    }

    if (!position) {
      this.logger.debug("Aborting _showIcon(): Missing position");
      return;
    }

    this.logger.debug("Creating translation icon", {
      textLength: selectedText.length,
      position: {
        x: Math.round(position.x || 0),
        y: Math.round(position.y || 0),
      },
    });

    this.state.setIconMode(true);
    this.state.setOriginalText(selectedText);

    const iconId = `translation-icon-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const positionToUse = position.finalPosition || position;

    WindowsManagerEvents.showIcon({
      id: iconId,
      text: selectedText,
      position: positionToUse,
      frameId: this.crossFrameManager.frameId,
    });

    this.state.setIconClickContext({
      text: selectedText,
      position,
      iconId,
    });

    this._clearOutsideClickActivationTimer();
    if (!this.facade._isIconToWindowTransition) {
      this._scheduleOutsideClickActivation();
    }

    this.logger.info("Translation icon created successfully", { iconId });
  }

  /**
   * Show translation window with two-phase loading
   */
  async _showWindow(selectedText, position, options = {}) {
    if (!ExtensionContextManager.isValidSync() || !selectedText) {
      this.logger.debug("Cannot show window: invalid context or empty text");
      return;
    }

    this.logger.info("Creating translation window", {
      textLength: selectedText.length,
      position,
      context: this.crossFrameManager.isTopFrame ? "main-frame" : "iframe",
      options,
    });

    const windowId = `translation-window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.state.clearTranslationHistory();
    this.state.setInitialLoadingWindow?.(windowId);

    WindowsManagerEvents.showWindow({
      id: windowId,
      selectedText,
      position,
      mode: "window",
      initialSize: "small",
      isLoading: true,
      frameId: this.crossFrameManager.frameId,
      historyIndex: this.state.historyIndex,
      historyLength: this.state.translationHistory?.length || 0,
    });

    this.state.setActiveWindowId(windowId);
    this.state.setOriginalText(selectedText);
    this.state.setTranslationCancelled(false);
    this.state.setVisible(true);

    if (!this.facade._isIconToWindowTransition) {
      this.state.setIconMode(false);
    }

    this._clearOutsideClickActivationTimer();
    this._scheduleOutsideClickActivation();

    this.logger.info("Translation window created successfully", { windowId });

    try {
      const translationResult = await this.facade._startTranslationProcess(
        selectedText,
        windowId,
        options,
      );

      if (!translationResult || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(translationResult._requestId))) {
        this.logger.info("Translation cancelled by user");
        return;
      }

      WindowsManagerEvents.updateWindow(windowId, {
        initialSize: "normal",
        isLoading: false,
        isStreaming: false,
        initialTranslatedText: translationResult.translatedText,
        sourceLanguage: translationResult.sourceLanguage || "auto",
        detectedSourceLanguage: translationResult.sourceLanguage,
        targetLanguage: translationResult.targetLanguage,
        provider: translationResult.provider,
        mode: translationResult.mode,
        ...this.facade._historyUpdate(this.state.translationHistory[this.state.historyIndex]),
      });
      this.state.clearInitialLoadingWindow?.(windowId);

      this.state.setProvider(translationResult.provider);
      this.logger.info("Window updated with translation result", { windowId });
    } catch (error) {
      this.logger.debug("Translation process failed:", error.message);

      const presentation = await getSelectionWindowErrorPresentation(
        error,
        "windows-translation",
        this.errorHandler,
      );
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

      const { errorInfo } = presentation;
      const fallbackProvider = this.translationHandler.getEffectiveProvider(
        selectedText,
        { provider: this.state.provider },
      );

      WindowsManagerEvents.updateWindow(windowId, {
        initialSize: "normal",
        isLoading: false,
        isStreaming: false,
        isError: true,
        errorType: errorInfo.type,
        canRetry: errorInfo.canRetry,
        needsSettings: errorInfo.needsSettings,
        initialTranslatedText: errorInfo.message,
        provider: fallbackProvider,
      });
      this.state.clearInitialLoadingWindow?.(windowId);
    }
  }

  /**
   * Create translation window - legacy/helper version
   */
  async _createTranslationWindow(selectedText, position) {
    try {
      this.state.setOriginalText(selectedText);
      this.state.setTranslationCancelled(false);
      this.state.setIconMode(false);
      this.state.setVisible(true);

      const windowId = `translation-window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.state.setActiveWindowId(windowId);

      const theme = await this.themeManager.getCurrentTheme();

      WindowsManagerEvents.showWindow({
        id: windowId,
        selectedText: selectedText,
        initialTranslatedText: "",
        position: position,
        theme: theme,
        isLoading: true,
      });

      const result = await this.translationHandler.performTranslation(
        selectedText,
        { windowId },
      );
      if (this.state.isTranslationCancelled) return;

      this.state.setProvider(result.provider);

      WindowsManagerEvents.showWindow({
        id: windowId,
        selectedText: selectedText,
        initialTranslatedText: result.translatedText,
        position: position,
        theme: theme,
        isLoading: false,
        targetLanguage: result.targetLanguage || "auto",
        provider: result.provider,
      });
    } catch (error) {
      if (
        this.state.isTranslationCancelled ||
        error.message === "Translation cancelled"
      ) {
        return;
      }
      await this._handleTranslationError(error, selectedText, position);
    }
  }

  /**
   * Handle translation error
   */
  async _handleTranslationError(error, selectedText, position) {
    const presentation = await getSelectionWindowErrorPresentation(
      error,
      "windows-manager-translate",
      this.errorHandler,
    );
    if (!presentation) return;

    const { displayError, errorInfo, canonicalType } = presentation;
    this.logger.info(
      `Translation error - Type: ${errorInfo.type}, Message: ${errorInfo.message}`,
    );

    const windowId = `translation-window-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.state.setActiveWindowId(windowId);

    const theme = (await this.themeManager.currentTheme) || "light";
    const fallbackProvider = this.translationHandler.getEffectiveProvider(
      selectedText,
      { provider: this.state.provider },
    );

    WindowsManagerEvents.showWindow({
      id: windowId,
      selectedText: selectedText,
      initialTranslatedText: errorInfo.message,
      position: position,
      theme: theme,
      isLoading: false,
      isStreaming: false,
      isError: true,
      errorType: errorInfo.type,
      canRetry: errorInfo.canRetry,
      needsSettings: errorInfo.needsSettings,
      provider: fallbackProvider,
    });

    await this.errorHandler.handle(displayError, {
      type: canonicalType || errorInfo.type,
      context: "windows-manager-translate",
      isSilent: true,
      showInUI: false,
    });
  }
}

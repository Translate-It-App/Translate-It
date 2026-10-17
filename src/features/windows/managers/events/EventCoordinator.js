import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import {
  WINDOWS_MANAGER_EVENTS,
  WindowsManagerEvents,
  pageEventBus,
} from "@/core/PageEventBus.js";
import { SELECTION_EVENTS } from "@/features/text-selection/events/SelectionEvents.js";
import { WindowsConfig } from "../core/WindowsConfig.js";
import { state as globalState } from "@/shared/config/config.js";
import { adjustForDirectChild } from "../crossframe/coordinateUtils.js";
import { getTextSelectionWindowRelay } from "../crossframe/TextSelectionWindowRelay.js";
import { getSelectionWindowErrorPresentation } from "../display/SelectionWindowErrorPresenter.js";

/**
 * Handles internal Vue events and cross-frame messages
 */
export class EventCoordinator {
  constructor(facade, dependencies) {
    this.facade = facade;
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, "EventCoordinator");

    // Inject dependencies from facade
    this.state = dependencies.state;
    this.crossFrameManager = dependencies.crossFrameManager;
    this.translationHandler = dependencies.translationHandler;
    this.errorHandler = dependencies.errorHandler;
    this.clickManager = dependencies.clickManager;
    this.themeManager = dependencies.themeManager;
    this.positionCalculator = dependencies.positionCalculator; // If needed
  }

  setup() {
    this.crossFrameManager.setEventHandlers({
      onOutsideClick: this._handleCrossFrameOutsideClick.bind(this),
      onWindowCreationRequest: this._handleWindowCreationRequest.bind(this),
      onWindowCreatedResponse: this._handleWindowCreatedResponse.bind(this),
    });

    if (window === window.top) {
      // The relay owns cross-frame TEXT_SELECTION_WINDOW_REQUEST routing; register
      // the top-frame sink here. Sink replacement is idempotent, so reactivation
      // never duplicates the relay's message listener. The stored reference lets
      // cleanup() release exactly this ownership.
      this._textSelectionWindowSink = (data, sourceWindow) => {
        this._handleTextSelectionWindowRequest(data, sourceWindow);
      };
      getTextSelectionWindowRelay().setSink(this._textSelectionWindowSink);
    }

    this.clickManager.setHandlers({
      onOutsideClick: this._handleOutsideClick.bind(this),
      onIconClick: this._handleIconClick.bind(this),
    });

    if (pageEventBus) {
      this.facade._iconClickHandler = (payload) => {
        this._handleIconClickFromVue(payload);
      };
      this.facade._speakRequestHandler = this._handleSpeakRequest.bind(this);
      this.facade._retryRequestHandler = this._handleRetryRequest.bind(this);
      this.facade._changeProviderRequestHandler =
        this._handleChangeProviderRequest.bind(this);
      this.facade._historyNavigateHandler = (detail) => this._handleHistoryNavigate(detail);
      this.facade._confirmSourceHandler = (detail) => this._handleConfirmSource(detail);

      pageEventBus.on(
        WINDOWS_MANAGER_EVENTS.ICON_CLICKED,
        this.facade._iconClickHandler,
      );
      pageEventBus.on(
        "translation-window-speak",
        this.facade._speakRequestHandler,
      );
      pageEventBus.on(
        "translation-window-retry",
        this.facade._retryRequestHandler,
      );
      pageEventBus.on(
        "translation-window-change-provider",
        this.facade._changeProviderRequestHandler,
      );
      pageEventBus.on("translation-window-history-navigate", this.facade._historyNavigateHandler);
      pageEventBus.on("translation-window-confirm-source", this.facade._confirmSourceHandler);

      this.facade._dismissRequestHandler = (detail) => {
        if (detail?.id && this.state.activeWindowId && detail.id !== this.state.activeWindowId) return;
        if (this.facade._isIconToWindowTransition) {
          return;
        }
        this.facade.dismiss(false);
      };

      pageEventBus.on(
        WINDOWS_MANAGER_EVENTS.DISMISS_WINDOW,
        this.facade._dismissRequestHandler,
      );
      pageEventBus.on(
        WINDOWS_MANAGER_EVENTS.DISMISS_ICON,
        this.facade._dismissRequestHandler,
      );

      this.facade._selectionTriggerHandler = (payload) => {
        this._handleSelectionTrigger(payload);
      };
      pageEventBus.on(
        SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER,
        this.facade._selectionTriggerHandler,
      );

      this.facade._selectionClearHandler = () => {
        if (this.state.isVisible || this.state.isIconMode) {
          if (this.state.isPinned) return;
          this.logger.debug('Window dismissal requested', {
            path: 'selection-clear',
            isVisible: this.state.isVisible,
            isIconMode: this.state.isIconMode,
          });
          this.facade.dismiss(false);
        }
      };
      pageEventBus.on(
        SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR,
        this.facade._selectionClearHandler,
      );

      this.facade._selectionChangeHandler = (detail) => {
        this.facade.show(detail.text, detail.position, detail.options);
      };
      pageEventBus.on(
        SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE,
        this.facade._selectionChangeHandler,
      );
    }
  }

  /**
   * Release ownership of the relay sink so no stale delivery reaches a dead
   * coordinator. Ownership-aware: a late cleanup never clears a replacement sink.
   */
  cleanup() {
    if (pageEventBus) {
      if (this.facade._iconClickHandler) {
        pageEventBus.off(
          WINDOWS_MANAGER_EVENTS.ICON_CLICKED,
          this.facade._iconClickHandler,
        );
        this.facade._iconClickHandler = null;
      }

      if (this.facade._speakRequestHandler) {
        pageEventBus.off(
          "translation-window-speak",
          this.facade._speakRequestHandler,
        );
        this.facade._speakRequestHandler = null;
      }

      if (this.facade._retryRequestHandler) {
        pageEventBus.off(
          "translation-window-retry",
          this.facade._retryRequestHandler,
        );
        this.facade._retryRequestHandler = null;
      }

      if (this.facade._changeProviderRequestHandler) {
        pageEventBus.off(
          "translation-window-change-provider",
          this.facade._changeProviderRequestHandler,
        );
        this.facade._changeProviderRequestHandler = null;
      }
      if (this.facade._historyNavigateHandler) {
        pageEventBus.off("translation-window-history-navigate", this.facade._historyNavigateHandler);
        this.facade._historyNavigateHandler = null;
      }
      if (this.facade._confirmSourceHandler) {
        pageEventBus.off("translation-window-confirm-source", this.facade._confirmSourceHandler);
        this.facade._confirmSourceHandler = null;
      }

      if (this.facade._dismissRequestHandler) {
        pageEventBus.off(
          WINDOWS_MANAGER_EVENTS.DISMISS_WINDOW,
          this.facade._dismissRequestHandler,
        );
        pageEventBus.off(
          WINDOWS_MANAGER_EVENTS.DISMISS_ICON,
          this.facade._dismissRequestHandler,
        );
        this.facade._dismissRequestHandler = null;
      }

      if (this.facade._selectionTriggerHandler) {
        pageEventBus.off(
          SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER,
          this.facade._selectionTriggerHandler,
        );
        this.facade._selectionTriggerHandler = null;
      }

      if (this.facade._selectionClearHandler) {
        pageEventBus.off(
          SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR,
          this.facade._selectionClearHandler,
        );
        this.facade._selectionClearHandler = null;
      }

      if (this.facade._selectionChangeHandler) {
        pageEventBus.off(
          SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE,
          this.facade._selectionChangeHandler,
        );
        this.facade._selectionChangeHandler = null;
      }
    }

    if (this._textSelectionWindowSink) {
      getTextSelectionWindowRelay().clearSink(this._textSelectionWindowSink);
      this._textSelectionWindowSink = null;
    }
  }

  /**
   * Handle translation trigger for pending selections
   */
  async _handleSelectionTrigger(payload) {
    const { text, position, options = {} } = payload;
    if (text && position) {
      await this.facade.show(text, position, options);
    }
  }

  /**
   * Handle TTS speak request from Vue component
   */
  async _handleSpeakRequest(detail) {
    if (!detail || !detail.text) return;

    try {
      const tts = await this.facade._ensureTTSLoaded();
      if (detail.isSpeaking) {
        await tts.speak(detail.text, detail.language || "auto");
      } else {
        await tts.stop();
      }
    } catch (error) {
      await this.errorHandler.handle(error, {
        context: "windows-tts",
        showToast: true,
      });
    }
  }

  /**
   * Handle translation retry request
   */
  async _handleRetryRequest(detail) {
    const windowId = detail.id || this.state.activeWindowId;
    if (this.state.activeWindowId && windowId !== this.state.activeWindowId) return;
    const textToTranslate = this.state.originalText;

    if (!windowId || !textToTranslate) return;

    WindowsManagerEvents.updateWindow(windowId, {
      isLoading: true,
      isError: false,
      initialTranslatedText: "",
    });

    try {
      const translationResult = await this.facade._startTranslationProcess(
        textToTranslate,
        windowId,
      );
      if (!translationResult || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(translationResult._requestId))) return;

      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false,
        isStreaming: false,
        isError: false,
        initialTranslatedText: translationResult.translatedText,
        sourceLanguage: translationResult.sourceLanguage || "auto",
        detectedSourceLanguage: translationResult.sourceLanguage,
        targetLanguage: translationResult.targetLanguage,
        mode: translationResult.mode,
        provider: translationResult.provider,
        ...(this.facade._historyUpdate?.(this.state.translationHistory?.[this.state.historyIndex]) || {}),
      });
    } catch (error) {
      const presentation = await getSelectionWindowErrorPresentation(
        error,
        "windows-translation",
        this.errorHandler,
      );
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

      const { errorInfo } = presentation;
      const fallbackProvider = this.translationHandler.getEffectiveProvider(
        textToTranslate,
        { provider: this.state.provider },
      );
      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false,
        isStreaming: false,
        isError: true,
        errorType: errorInfo.type,
        canRetry: errorInfo.canRetry,
        needsSettings: errorInfo.needsSettings,
        initialTranslatedText: errorInfo.message,
        provider: fallbackProvider,
      });
    }
  }

  /**
   * Handle provider change request
   */
  async _handleChangeProviderRequest(detail) {
    const windowId = detail.id || this.state.activeWindowId;
    if (this.state.activeWindowId && windowId !== this.state.activeWindowId) return;
    const newProvider = detail.provider;
    const textToTranslate = this.state.originalText;

    if (!windowId || !textToTranslate || !newProvider) return;

    this.state.setProvider(newProvider);
    WindowsManagerEvents.updateWindow(windowId, {
      isLoading: true,
      isError: false,
      initialTranslatedText: "",
      provider: newProvider,
    });

    try {
      const translationResult = await this.facade._startTranslationProcess(
        textToTranslate,
        windowId,
        { provider: newProvider },
      );
      if (!translationResult || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(translationResult._requestId))) return;

      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false,
        isStreaming: false,
        isError: false,
        initialTranslatedText: translationResult.translatedText,
        sourceLanguage: translationResult.sourceLanguage || "auto",
        detectedSourceLanguage: translationResult.sourceLanguage,
        targetLanguage: translationResult.targetLanguage,
        mode: translationResult.mode,
        provider: translationResult.provider,
        ...(this.facade._historyUpdate?.(this.state.translationHistory?.[this.state.historyIndex]) || {}),
      });
    } catch (error) {
      const presentation = await getSelectionWindowErrorPresentation(
        error,
        "windows-translation-retry",
        this.errorHandler,
      );
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

      const { errorInfo } = presentation;
      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false,
        isStreaming: false,
        isError: true,
        errorType: errorInfo.type,
        canRetry: errorInfo.canRetry,
        needsSettings: errorInfo.needsSettings,
        initialTranslatedText: errorInfo.message,
        provider: newProvider,
      });
    }
  }

  _handleHistoryNavigate(detail) {
    if (!detail?.id || !['previous', 'next'].includes(detail.direction)) return;
    if (this.state.activeWindowId && detail.id !== this.state.activeWindowId) return;
    this.facade._navigateTranslationHistory(detail.id, detail.direction);
  }

  async _handleConfirmSource(detail) {
    const text = detail?.text;
    const windowId = detail?.id || this.state.activeWindowId;
    if (this.state.activeWindowId && windowId !== this.state.activeWindowId) return;
    if (!windowId || typeof text !== 'string' || !text.trim()) return;
    if (text === this.state.originalText) return;
    this.state.setOriginalText(text);
    WindowsManagerEvents.updateWindow(windowId, {
      isLoading: true, isError: false, initialTranslatedText: '', selectedText: text,
    });
    try {
      const result = await this.facade._startTranslationProcess(text, windowId);
      if (!result || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(result._requestId))) return;
      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false, isStreaming: false, isError: false,
        initialTranslatedText: result.translatedText,
        sourceLanguage: result.sourceLanguage || 'auto',
        detectedSourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
        provider: result.provider,
        mode: result.mode,
        ...(this.facade._historyUpdate?.(this.state.translationHistory?.[this.state.historyIndex]) || {}),
      });
    } catch (error) {
      const presentation = await getSelectionWindowErrorPresentation(error, 'windows-translation', this.errorHandler);
      if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;
      const { errorInfo } = presentation;
      WindowsManagerEvents.updateWindow(windowId, {
        isLoading: false, isStreaming: false, isError: true,
        errorType: errorInfo.type, canRetry: errorInfo.canRetry,
        needsSettings: errorInfo.needsSettings, initialTranslatedText: errorInfo.message,
        provider: this.state.provider,
      });
    }
  }

  /**
   * Handle cross-frame outside click
   *
   * `message` is the MessageEvent (or the bare payload from direct tests)
   * whose data carries the relay payload built by MessageRouter
   * broadcastOutsideClick, including the bounded gesture identity fields
   * `pointerId` and `fromCrossDocumentGesture`. Absent fields degrade to
   * `pointerId: null / fromCrossDocumentGesture: undefined`, which never
   * suppresses.
   */
  async _handleCrossFrameOutsideClick(message) {
    if (
      window.__TRANSLATION_WINDOW_IS_DRAGGING === true ||
      window.__TRANSLATION_WINDOW_JUST_DRAGGED === true
    )
      return;
    if (window.__TRANSLATION_WINDOW_IS_RESIZING === true) return;
    // A gesture that started inside the window may complete inside an iframe:
    // the origin document may never observe the completing click, so decide
    // from the relay's bounded gesture identity, not from any ignore-next
    // fallback. Legacy managers without the resolve API keep dismissal.
    const data = message?.data ?? message ?? {};
    const decision = this.clickManager.resolveCrossFrameOutsideClick?.({
      pointerId: data?.pointerId ?? null,
      fromCrossDocumentGesture: data?.fromCrossDocumentGesture,
    });
    if (decision?.suppress === true) return;
    if (this.state.hasActiveElements) {
      this.logger.debug('Window dismissal requested', {
        path: 'cross-frame-click',
        hasActiveElements: this.state.hasActiveElements,
      });
      await this.facade.dismiss(true);
    }
  }

  /**
   * Handle outside click
   */
  async _handleOutsideClick() {
    if (this.state.shouldPreventDismissal) return;
    if (
      window.__TRANSLATION_WINDOW_IS_DRAGGING === true ||
      window.__TRANSLATION_WINDOW_JUST_DRAGGED === true ||
      window.__TRANSLATION_WINDOW_IS_RESIZING === true ||
      window.__TRANSLATION_WINDOW_JUST_RESIZED === true
    )
      return;

    let textSelectionManager = null;
    if (window.textSelectionManager) {
      textSelectionManager = window.textSelectionManager;
    } else if (window.TranslateItTextSelectionManager) {
      textSelectionManager = window.TranslateItTextSelectionManager;
    }

    if (
      textSelectionManager &&
      (textSelectionManager.isDragging ||
        textSelectionManager.justFinishedDrag ||
        textSelectionManager.preventDismissOnNextClear)
    ) {
      return;
    }

    const hasStoredMobileText =
      this.facade.displayManager.shouldUseMobileUI() && this.state.originalText;
    if (this.state.hasActiveElements || hasStoredMobileText) {
      this.logger.debug('Window dismissal requested', {
        path: 'outside-click',
        hasActiveElements: this.state.hasActiveElements,
        hasStoredMobileText: !!hasStoredMobileText,
      });
      await this.facade.dismiss(true);
    }
  }

  /**
   * Handle icon click
   */
  _handleIconClick() {
    const context = this.clickManager.handleIconClick(
      this.state.iconClickContext,
    );
    if (!context) return;

    if (globalState && typeof globalState === "object") {
      globalState.preventTextFieldIconCreation = true;
    }

    if (context.iconId) {
      WindowsManagerEvents.iconClicked({
        id: context.iconId,
        text: context.text,
        position: context.position,
      });
    }

    this.facade.dismissalManager._cleanupIcon(false);
    this.facade.displayManager._showWindow(context.text, context.position);
    this.clickManager.completeIconTransition();

    setTimeout(() => {
      if (globalState && typeof globalState === "object") {
        globalState.preventTextFieldIconCreation = false;
      }
    }, WindowsConfig.TIMEOUTS.PENDING_WINDOW_RESET);
  }

  /**
   * Handle icon click event from the Vue UI Host
   */
  async _handleIconClickFromVue(detail) {
    if (!detail || !detail.id) return;
    if (this.state.isProcessing) return;

    const now = Date.now();
    if (
      this.facade._lastProcessedClick &&
      this.facade._lastProcessedClick.id === detail.id &&
      now - this.facade._lastProcessedClick.timestamp < 500
    ) {
      return;
    }

    const { id, text, position } = detail;
    this.facade._lastProcessedClick = { id, timestamp: now };
    this.state.setProcessing(true);

    if (globalState && typeof globalState === "object") {
      globalState.preventTextFieldIconCreation = true;
    }

    this.facade._isIconToWindowTransition = true;
    const showPromise = this.facade.displayManager._showWindow(text, position);

    setTimeout(() => {
      this.state.setIconMode(false);
      WindowsManagerEvents.dismissIcon(id);
      this.facade.dismissalManager._removeDismissListener();
    }, 120);

    await showPromise;
    setTimeout(() => {
      if (globalState && typeof globalState === "object") {
        globalState.preventTextFieldIconCreation = false;
      }
      this.state.setProcessing(false);
      this.facade._isIconToWindowTransition = false;
      this.facade._lastProcessedClick = null;
    }, WindowsConfig.TIMEOUTS.PENDING_WINDOW_RESET);
  }

  /**
   * Handle window creation request from iframe
   */
  async _handleWindowCreationRequest(data) {
    if (!this.crossFrameManager.isTopFrame) return;

    try {
      let adjustedPosition = { ...data.position };
      // Note: positionCalculator logic was removed from WM but kept in sub-modules if needed
      // Here it seems we need it for iframe support

      const windowId = `translation-window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      this.state.clearTranslationHistory();
      this.state.setActiveWindowId(windowId);

      WindowsManagerEvents.showWindow({
        id: windowId,
        selectedText: data.selectedText,
        position: adjustedPosition,
        mode: "window",
      });

      this.state.setOriginalText(data.selectedText);
      this.state.setTranslationCancelled(false);
      this.state.setIconMode(false);
      this.state.setVisible(true);

      this.facade
        ._startTranslationProcess(data.selectedText, windowId)
        .then((result) => {
          if (result && (!this.facade._isCurrentTranslation || this.facade._isCurrentTranslation(result._requestId))) {
            WindowsManagerEvents.updateWindow(windowId, {
              initialSize: "normal",
              isLoading: false,
              initialTranslatedText: result.translatedText,
              sourceLanguage: result.sourceLanguage || "auto",
              detectedSourceLanguage: result.sourceLanguage,
              targetLanguage: result.targetLanguage,
              provider: result.provider,
              ...this.facade._historyUpdate?.(this.state.translationHistory?.[this.state.historyIndex]),
            });
          }
        })
        .catch(async (error) => {
          const presentation = await getSelectionWindowErrorPresentation(
            error,
            "windows-translation",
            this.errorHandler,
          );
          if (!presentation || (this.facade._isCurrentTranslation && !this.facade._isCurrentTranslation(error._requestId))) return;

          const { errorInfo } = presentation;
          WindowsManagerEvents.updateWindow(windowId, {
            initialSize: "normal",
            isLoading: false,
            isStreaming: false,
            isError: true,
            errorType: errorInfo.type,
            initialTranslatedText: errorInfo.message,
          });
        });

      this.crossFrameManager.notifyWindowCreated(data.frameId, true, windowId);
    } catch (error) {
      this.crossFrameManager.notifyWindowCreated(
        data.frameId,
        false,
        null,
        error.message,
      );
    }
  }

  /**
   * Handle window creation response for iframe
   */
  _handleWindowCreatedResponse(data) {
    if (this.crossFrameManager.isTopFrame) return;
    if (data.success) {
      this.state.setVisible(true);
      this.state.mainDocumentWindowId = data.windowId;
      this.clickManager.addOutsideClickListener();
    }
  }

  /**
   * Handle text selection window request from an iframe (single-owner sink).
   * Position is adjusted for the direct child iframe offset. When the sender is
   * not a direct child, the raw position is passed through unchanged (legacy
   * behavior preserved).
   */
  async _handleTextSelectionWindowRequest(data, sourceWindow) {
    if (!this.crossFrameManager.isTopFrame) return;

    try {
      const adjustedPosition = adjustForDirectChild(
        sourceWindow,
        data.position,
      ) ?? { ...data.position };

      await this.facade.show(data.selectedText, adjustedPosition, data.options);
    } catch (error) {
      this.logger.warn(
        "Failed to handle text selection window request from iframe:",
        error.message,
      );
    }
  }
}

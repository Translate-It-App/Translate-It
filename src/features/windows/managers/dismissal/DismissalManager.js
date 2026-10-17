import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { WindowsManagerEvents, pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import ExtensionContextManager from "@/core/extensionContext.js";
import { UI_HOST_IDS } from '@/shared/constants/ui.js';
import { TRANSLATION_HTML } from '@/shared/constants/translation.js';
import { state as globalState } from "@/shared/config/config.js";

/**
 * Handles UI dismissal, outside clicks, and selection clearing
 */
export class DismissalManager {
  constructor(facade, dependencies) {
    this.facade = facade;
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'DismissalManager');
    
    // Inject dependencies from facade
    this.state = dependencies.state;
    this.crossFrameManager = dependencies.crossFrameManager;
    this.translationHandler = dependencies.translationHandler;
    this.tts = dependencies.tts;
  }

  /**
   * Dismiss the current window/icon
   */
  async dismiss(withFadeOut = true, preserveSelection = false) {
    const now = Date.now();
    if (this.facade._lastDismissTime && (now - this.facade._lastDismissTime) < 25) {
      return;
    }
    this.facade._lastDismissTime = now;

    if (this.facade._isDismissingDueToTyping && withFadeOut) {
      return;
    }

    if (this.facade._isDismissing) {
      return;
    }

    if (this.facade._isInShiftClickOperation || window.translateItShiftClickOperation) {
      return;
    }

    this.facade._isDismissing = true;

    const dismissMode = this.state.isIconMode ? 'icon' : 'window';
    this.logger.debug('Dismissing translation UI', {
      mode: dismissMode,
      reason: this.facade._isDismissingDueToTyping ? 'user_typing' : 'user_action'
    });

    if (!preserveSelection) {
      pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR, { 
        reason: this.facade._isDismissingDueToTyping ? 'user_typing' : 'user_action',
        mode: dismissMode 
      });
    }

    let textSelectionManager = null;
    let preventDismissDueToDrag = false;
    let preventDismissDueToShiftClick = false;

    if (window.textSelectionManager) {
      textSelectionManager = window.textSelectionManager;
    } else if (window.TranslateItTextSelectionManager) {
      textSelectionManager = window.TranslateItTextSelectionManager;
    }

    if (textSelectionManager && textSelectionManager.preventDismissOnNextClear) {
      preventDismissDueToDrag = true;
      textSelectionManager.preventDismissOnNextClear = false;
    }

    if (textSelectionManager && textSelectionManager.shiftKeyPressed) {
      preventDismissDueToShiftClick = true;
      this.facade._isInShiftClickOperation = true;

      if (this.facade._shiftKeyReleaseHandler) {
        document.removeEventListener('keyup', this.facade._shiftKeyReleaseHandler, { capture: true });
      }

      this.facade._shiftKeyReleaseHandler = (event) => {
        if (event.key === 'Shift' && this.facade._isInShiftClickOperation) {
          this.facade._isInShiftClickOperation = false;
          document.removeEventListener('keyup', this.facade._shiftKeyReleaseHandler, { capture: true });
          this.facade._shiftKeyReleaseHandler = null;
        }
      };

      document.addEventListener('keyup', this.facade._shiftKeyReleaseHandler, { capture: true });
    }

    const activeElement = document.activeElement;
    const isInTextField = activeElement && activeElement.isConnected && this.facade.isTextFieldElement(activeElement);

    const hasRecentActivity = this._hasRecentSelectionActivity();
    const currentSelection = window.getSelection();
    const hasActualSelection = currentSelection && currentSelection.toString().trim().length > 0;

    const shouldClearSelection = this.state.isIconMode &&
                               ExtensionContextManager.isValidSync() &&
                               !preserveSelection &&
                               !preventDismissDueToDrag &&
                               !preventDismissDueToShiftClick &&
                               !this.facade._preserveSelectionForTyping &&
                               !this.facade._isDismissingDueToTyping &&
                               !isInTextField && 
                               (!hasRecentActivity || !hasActualSelection); 
    
    if (shouldClearSelection) {
      this._clearTextSelection();
    }

    const iconId = this.state.iconClickContext?.iconId;
    const windowId = this.state.activeWindowId;

    this._cleanupIcon(true);

    if (this.state.isVisible && !preserveSelection) {
      this.state.setVisible(false);
    }

    if (iconId) {
      this.facade._lastDismissedIcon = {
        id: iconId,
        timestamp: Date.now()
      };
      WindowsManagerEvents.dismissIcon(iconId);
    } else {
      pageEventBus.emit('windows-manager-dismiss-icon', { id: 'all' });
    }
    
    if (windowId && !preserveSelection) {
      WindowsManagerEvents.dismissWindow(windowId, withFadeOut);
    }

    if (this.facade.displayManager.shouldUseMobileUI()) {
      WindowsManagerEvents.showMobileSheet({ isOpen: false });
    }

    if (this.translationHandler && !preserveSelection) {
      this.state.setTranslationCancelled(true);
      if (typeof this.translationHandler.cancelAllTranslations === 'function') {
        this.translationHandler.cancelAllTranslations();
      }
    }

    this.facade._lastDismissedText = this.state.originalText;
    this.facade._lastDismissTime = Date.now();

    if (!preserveSelection) {
      this._resetState();
    } else {
      this._removeDismissListener();
      this.facade._isDismissingDueToTyping = false;
      this.facade._isInShiftClickOperation = false;
      if (globalState && typeof globalState === 'object') {
        globalState.preventTextFieldIconCreation = false;
      }
    }

    this.facade._isDismissing = false;
  }

  /**
   * Clean up icon
   */
  _cleanupIcon(removeListener = true) {
    this.state.clearIconClickContext();
    if (removeListener) {
      this._removeDismissListener();
    }
    this.facade._lastProcessedClick = null;
  }

  /**
   * Remove dismiss listener
   */
  _removeDismissListener() {
    if (this.facade._dismissHandler) {
      document.removeEventListener('click', this.facade._dismissHandler, { capture: false });
      this.facade._dismissHandler = null;
    }

    if (this.facade._escapeKeyHandler) {
      document.removeEventListener('keydown', this.facade._escapeKeyHandler, { capture: false });
      this.facade._escapeKeyHandler = null;
    }

    if (this.facade._shiftKeyReleaseHandler) {
      document.removeEventListener('keyup', this.facade._shiftKeyReleaseHandler, { capture: true });
      this.facade._shiftKeyReleaseHandler = null;
    }
  }

  /**
   * Reset state
   */
  _resetState() {
    this.state.reset();
    this.facade._isIconToWindowTransition = false;
    this.state._lastClickWasInsideWindow = false;
    this.facade._lastProcessedClick = null;
    this.facade._lastDismissedIcon = null;
    this.facade._isDismissingDueToTyping = false;
    this.facade._isInShiftClickOperation = false;

    if (globalState && typeof globalState === 'object') {
      globalState.preventTextFieldIconCreation = false;
    }
  }

  /**
   * Check if there's recent selection activity
   */
  _hasRecentSelectionActivity() {
    const now = Date.now();

    if (window.translateItShiftClickOperation) {
      return true;
    }

    if (window.translateItJustFinishedSelection) {
      return true;
    }

    if (window.textFieldDoubleClickHandlerInstance) {
      const handler = window.textFieldDoubleClickHandlerInstance;
      if (handler.isTypingDetectionActive && handler.isTypingDetectionActive()) {
        return true;
      }
    }

    if (window.simpleTextSelectionHandlerInstance) {
      const handler = window.simpleTextSelectionHandlerInstance;
      if (handler._isPreservationActive && handler._isPreservationActive()) {
        return true;
      }
    }

    let textSelectionManager = null;
    if (window.textSelectionManager) {
      textSelectionManager = window.textSelectionManager;
    } else if (window.TranslateItTextSelectionManager) {
      textSelectionManager = window.TranslateItTextSelectionManager;
    }

    if (textSelectionManager) {
      const recentActivityThreshold = 1000;
      const lastActivityTime = textSelectionManager.lastSelectionTime || 0;
      if (now - lastActivityTime < recentActivityThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear text selection
   */
  _clearTextSelection() {
    try {
      if (window.getSelection) {
        const selection = window.getSelection();
        if (selection && selection.removeAllRanges) {
          selection.removeAllRanges();
        }
      }
    } catch (error) {
      this.logger.warn('Failed to clear text selection', error);
    }
  }

  /**
   * Add listener to dismiss icon or window on outside clicks
   */
  _addDismissListener() {
    this._removeDismissListener();

    this.facade._dismissHandler = (event) => {
      if (!this.state.isIconMode && !this.state.isVisible) return;
      if (this.state.isPinned) return;
      if (window.__TRANSLATION_WINDOW_IS_DRAGGING === true || window.__TRANSLATION_WINDOW_JUST_DRAGGED === true) return;
      if (window.__TRANSLATION_WINDOW_IS_RESIZING === true || window.__TRANSLATION_WINDOW_JUST_RESIZED === true) return;
      if (this.facade._isInShiftClickOperation || window.translateItShiftClickOperation) return;
      if (event.button !== 0) return;

      // Skip dismissal for a click marked as the completion of a pointer
      // gesture that started inside the translation window (press inside,
      // release outside). The mark is set only by ClickManager's window
      // capture handler on that one completion click, so its presence is a
      // sufficient identity check here (no per-window context is available).
      if (event.__translateItGestureCompletion) return;

      const target = event.target;
      const vueUIHostMain = document.getElementById(UI_HOST_IDS.MAIN);
      const vueUIHostIframe = document.getElementById(UI_HOST_IDS.IFRAME);
      const vueUIHost = vueUIHostMain || vueUIHostIframe;

      const isInsideVueUIHost = vueUIHost && vueUIHost.contains(target);
      const iconElement = document.getElementById(TRANSLATION_HTML.ICON_ID);
      const isInsideLegacyIcon = iconElement && iconElement.contains(target);

      const windowElements = document.querySelectorAll(`.${TRANSLATION_HTML.WINDOW_CLASS}`);
      const isInsideLegacyWindow = Array.from(windowElements).some(element =>
        element.contains(target)
      );

      if (isInsideVueUIHost || isInsideLegacyIcon || isInsideLegacyWindow) {
        if (this.state.isVisible && !this.state.isIconMode) {
          this.state._lastClickWasInsideWindow = true;
        }
        return;
      }

      const isTextElement = target.nodeType === Node.TEXT_NODE ||
                           ['P', 'SPAN', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'LI', 'A', 'B', 'I', 'STRONG', 'EM'].includes(target.tagName);

      if (isTextElement) {
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
          return;
        }
      }

      this.dismiss();
    };

    document.addEventListener('click', this.facade._dismissHandler, { capture: false, passive: true });

    this.facade._escapeKeyHandler = (event) => {
      if (event.key === 'Escape' && (this.state.isIconMode || this.state.isVisible)) {
        this.dismiss();
      }
    };
    document.addEventListener('keydown', this.facade._escapeKeyHandler, { capture: false });
  }
}

import { ref, onMounted, onUnmounted } from "vue";

import { useMessaging } from '@/shared/messaging/composables/useMessaging.js';
import browser from 'webextension-polyfill';
import { sendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { createMessageHandler } from '@/shared/messaging/core/MessageHandler.js';
import { matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getSelectElementActivationErrorMessage } from '@/features/element-selection/utils/activationError.js';
import { ENVIRONMENTS, getActiveEnvironment } from '@/core/contextCore.js';

// Lazy logger to avoid TDZ ReferenceErrors when bundled
const logger = new Proxy({}, {
  get(target, prop) {
    const instance = getScopedLogger(LOG_COMPONENTS.UI, 'useTranslationModes');
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

// Shared reactive state for select element mode (module-level so all callers share it)
const sharedIsSelectModeActive = ref(false);
let _selectStateListenerRegistered = false;
let _selectStateHandler = null;
let _currentTabId = null;
let _currentWindowId = null;
let _tabsActivatedHandler = null;
let _selectStateSubscriberCount = 0;
let _uiMessageHandler = null;
let _selectStateGeneration = 0;
let _selectStateLifecycle = 0;
let _toggleInFlight = false;
let _pendingSelectBroadcast = null;
const _pendingTabActivations = new Map();

const _isSelectStateUiEnvironment = () => {
  const environment = getActiveEnvironment();
  return environment === ENVIRONMENTS.POPUP || environment === ENVIRONMENTS.SIDEPANEL;
};

const _requestSelectState = async (tabId, generation) => {
  try {
    const response = await sendMessage({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      context: MessageContexts.SIDEPANEL,
      timestamp: Date.now(),
      data: { tabId }
    });
    if (generation !== _selectStateGeneration || tabId !== _currentTabId) return;
    if (response?.success && Number(response.tabId) === Number(tabId)) {
      sharedIsSelectModeActive.value = !!response.active;
    }
  } catch (err) {
    logger.debug('Failed to refresh select element state:', err);
  }
};

const _registerSelectStateListener = () => {
  if (_selectStateListenerRegistered) return;
  _selectStateListenerRegistered = true;
  const lifecycle = ++_selectStateLifecycle;

  // Install the broadcast handler before starting any asynchronous snapshot request.
  _selectStateHandler = (message) => {
    if (message?.action === MessageActions.SELECT_ELEMENT_STATE_CHANGED) {
      const { tabId, active, windowId } = message.data || {};
      if (windowId != null && _currentWindowId != null && windowId !== _currentWindowId) {
        return { success: true, handled: true };
      }
      if (Number.isInteger(_currentTabId) && Number(tabId) === Number(_currentTabId)) {
        _selectStateGeneration++;
        sharedIsSelectModeActive.value = !!active;
      } else if (!Number.isInteger(_currentTabId) && Number.isInteger(tabId)) {
        _pendingSelectBroadcast = { tabId, active, windowId };
      }
      return { success: true, handled: true };
    }

    return false; // Not our message
  };

  try {
    // Create UI-specific MessageHandler instance
    if (!_uiMessageHandler) {
      _uiMessageHandler = createMessageHandler();
    }
    _uiMessageHandler.registerHandler(MessageActions.SELECT_ELEMENT_STATE_CHANGED, _selectStateHandler);

    if (!_uiMessageHandler.isListenerActive) {
      _uiMessageHandler.listen();
      logger.debug('[useTranslationModes] UI MessageHandler activated');
    }
  } catch (e) {
    logger.warn('[useSelectElementTranslation] Could not register with MessageHandler:', e);
  }

  browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (lifecycle !== _selectStateLifecycle || !_selectStateListenerRegistered || !Number.isInteger(tab?.id)) return;
    _currentWindowId = tab.windowId ?? null;
    const activation = _pendingTabActivations.get(_currentWindowId);
    _pendingTabActivations.clear();
    const targetTabId = Number.isInteger(activation?.tabId) ? activation.tabId : tab.id;
    _currentTabId = targetTabId;
    sharedIsSelectModeActive.value = false;
    if (_pendingSelectBroadcast && Number(_pendingSelectBroadcast.tabId) === Number(targetTabId) &&
        (_pendingSelectBroadcast.windowId == null || _currentWindowId == null || _pendingSelectBroadcast.windowId === _currentWindowId)) {
      sharedIsSelectModeActive.value = !!_pendingSelectBroadcast.active;
    }
    _pendingSelectBroadcast = null;
    _selectStateGeneration++;
    _requestSelectState(targetTabId, _selectStateGeneration);
  }).catch((err) => logger.warn('[useSelectElementTranslation] Failed to resolve active tab:', err));
};

const _unregisterSelectStateListener = () => {
  if (!_selectStateListenerRegistered) return;
  if (_selectStateHandler && _uiMessageHandler) {
    try {
      _uiMessageHandler.unregisterHandler(MessageActions.SELECT_ELEMENT_STATE_CHANGED);
    } catch {
      // ignore
    }
    _selectStateHandler = null;
  }
  _uiMessageHandler?.stopListening?.();
  _selectStateListenerRegistered = false;
  _selectStateLifecycle++;
  _selectStateGeneration++;
  sharedIsSelectModeActive.value = false;
  _currentTabId = null;
  _currentWindowId = null;
  _pendingSelectBroadcast = null;
  _pendingTabActivations.clear();
};

export function useSelectElementTranslation() {
  const isActivating = ref(false);
  const error = ref(null);
  let isStateSubscriber = false;

  // Use shared reactive ref so multiple components reflect same state
  const isSelectModeActive = sharedIsSelectModeActive;

  // Lifecycle-aware subscription: increment subscriber count on mount, decrement on unmount
  onMounted(() => {
    if (!_isSelectStateUiEnvironment()) return;
    isStateSubscriber = true;
    _selectStateSubscriberCount++;
    if (_selectStateSubscriberCount === 1) {
      _registerSelectStateListener();
      // Also register the tab activation listener only once
      try {
        _tabsActivatedHandler = async (activeInfo) => {
          if (!Number.isInteger(activeInfo?.tabId)) return;
          if (_currentWindowId == null) {
            if (activeInfo.windowId != null) _pendingTabActivations.set(activeInfo.windowId, activeInfo);
            return;
          }
          if (activeInfo.windowId != null && activeInfo.windowId !== _currentWindowId) return;
          _currentTabId = activeInfo.tabId;
          sharedIsSelectModeActive.value = false;
          const generation = ++_selectStateGeneration;
          _requestSelectState(activeInfo.tabId, generation);
        };
        browser.tabs.onActivated.addListener(_tabsActivatedHandler);
      } catch {
        // ignore if tabs API not available
      }
    }
  });

  // Note: ESC key handling is now managed by ShortcutManager for consistency
  // No need for separate ESC listener in sidepanel - ShortcutManager handles all ESC events

  onUnmounted(() => {
    if (!isStateSubscriber) return;
    isStateSubscriber = false;
    _selectStateSubscriberCount = Math.max(0, _selectStateSubscriberCount - 1);
    if (_selectStateSubscriberCount === 0) {
      _unregisterSelectStateListener();
      // Also unregister the tab activation listener
      try {
        if (_tabsActivatedHandler) {
          browser.tabs.onActivated.removeListener(_tabsActivatedHandler);
          _tabsActivatedHandler = null;
        }
      } catch {
        // ignore
      }
    }
  });

  const activateSelectMode = async (options = {}) => {
    isActivating.value = true;
    error.value = null;

    try {
      logger.debug('Activating select element mode', options);
      const result = await sendMessage({
        action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
        context: MessageContexts.SIDEPANEL,
        timestamp: Date.now(),
        data: { 
          active: true, 
          provider: options.provider, // اضافه کردن پرووایدر به پیام
          ...options 
        }
      });
      
      // Check if activation actually succeeded
      if (result === false || (result && result.success === false)) {
        // Handle graceful failures (e.g., restricted pages).
        // The background script now provides a user-friendly message.
        const errorMsg = (result && result.message) || "Failed to activate select element mode";
        error.value = errorMsg;
        logger.debug('Select mode activation failed:', { errorMsg, result });
        return false;
      }
      
      logger.debug('Select element mode activated');
      return true;
    } catch (err) {
      const errorMsg = await getSelectElementActivationErrorMessage();
      error.value = errorMsg;

      // Use Error Management system to determine error type and logging level
      const errorType = matchErrorToType(err);

      // Tab accessibility errors should be logged as debug, not error
      if (errorType === ErrorTypes.TAB_BROWSER_INTERNAL ||
          errorType === ErrorTypes.TAB_EXTENSION_PAGE ||
          errorType === ErrorTypes.TAB_LOCAL_FILE ||
          errorType === ErrorTypes.TAB_NOT_ACCESSIBLE ||
          errorType === ErrorTypes.TAB_RESTRICTED) {
        logger.debug('Select mode activation blocked (restricted page):', { errorType, message: err.message });
      } else {
        logger.error('Error activating select mode:', err);
      }
      return false;
    } finally {
      isActivating.value = false;
    }
  };

  const deactivateSelectMode = async () => {
    try {
      const data = { active: false };
      if (_isSelectStateUiEnvironment()) {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = activeTab?.id;
        if (!Number.isInteger(tabId)) {
          error.value = 'Could not determine active tab';
          return false;
        }
        data.tabId = tabId;
      }

      logger.debug('Deactivating select element mode');
      const result = await sendMessage({
        action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
        context: MessageContexts.SIDEPANEL,
        timestamp: Date.now(),
        data
      });

      if (result?.success === false) {
        error.value = result.error || 'Failed to deactivate select element mode';
        return false;
      }

      logger.debug('Select element mode deactivated');
      return true;
    } catch (err) {
      const errorMsg =
        err.message || "Failed to deactivate select element mode";
      error.value = errorMsg;
      logger.error('Error deactivating select mode:', err,
      );
      return false;
    }
  };

  const toggleSelectElement = async (options = {}) => {
    if (_toggleInFlight) return false;
    _toggleInFlight = true;
    const generation = ++_selectStateGeneration;
    const originalState = isSelectModeActive.value;
    // Optimistically update the UI for a smoother experience
    sharedIsSelectModeActive.value = !originalState;

    try {
      let success = false;
      if (sharedIsSelectModeActive.value) {
        // If we are activating
        success = await activateSelectMode(options);
      } else {
        // If we are deactivating
        success = await deactivateSelectMode();
      }

      // If the action failed, revert the optimistic update
      if (!success) {
        if (generation === _selectStateGeneration) sharedIsSelectModeActive.value = originalState;
        logger.debug('Select element toggle failed, reverting UI state.');
        return false;
      }
      
      return true;
    } catch (err) {
      // Revert on any unexpected errors as well
      if (generation === _selectStateGeneration) sharedIsSelectModeActive.value = originalState;
      logger.error('An unexpected error occurred during toggleSelectElement:', err);
      return false;
    } finally {
      _toggleInFlight = false;
    }
  };

  return {
    isActivating,
    isSelectModeActive,
    error,
    activateSelectMode,
    deactivateSelectMode,
    toggleSelectElement,
  };
}

export function useSidepanelActions() {
  const isProcessing = ref(false);
  const error = ref(null);

  // Use useMessaging like Popup does
  const { sendMessage: sendMessageViaMessaging } = useMessaging(MessageContexts.SIDEPANEL);

  const revertTranslation = async () => {
    isProcessing.value = true;
    error.value = null;

    try {
      logger.debug('[SidepanelActions] Executing revert action');

      // Use sendMessage (goes through background script) for proper error handling - same as Popup
      const response = await sendMessageViaMessaging({
        action: MessageActions.REVERT_SELECT_ELEMENT_MODE,
        context: MessageContexts.SIDEPANEL,
        messageId: `sidepanel-revert-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
        timestamp: Date.now()
      }, { returnFailureResponse: true });

      if (response?.isRestrictedPage) {
        // Tab is restricted - log as debug and exit gracefully
        logger.debug('Revert action blocked (restricted page):', {
          message: response.message,
          tabUrl: response.tabUrl
        });
        return null;
      }

      if (response?.success && !response.partial) {
        logger.debug(`[SidepanelActions] Revert successful: ${response.revertedCount || 0} translations reverted`);
        return true;
      }

      if (response?.partial) {
        const details = Array.isArray(response.errors)
          ? response.errors.map((item) => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return [item.system, item.error].filter(Boolean).join(': ');
          }).filter(Boolean).join('; ')
          : '';
        error.value = details
          ? `Partial Revert: ${details}`
          : `Partial Revert: ${response.message || response.error || 'Some translations could not be reverted'}`;
        logger.info('Revert partially completed:', error.value);
        return false;
      }

      const errorMsg = response?.error || response?.message || response?.errors?.join(', ') || 'Unknown error';
      error.value = `Revert failed: ${errorMsg}`;
      logger.error('Revert failed:', errorMsg);
      return false;
    } catch (err) {
      // Check if this is a restricted page error with response data
      if (err.isRestrictedPage) {
        logger.debug('Revert action blocked (restricted page):', {
          message: err.message,
          tabUrl: err.tabUrl
        });
        return null; // Exit gracefully without showing error to user
      }

      const errorMsg = err.message || "Failed to revert translation";
      error.value = errorMsg;
      logger.info('Error reverting translation:', err);
      return false;
    } finally {
      isProcessing.value = false;
    }
  };

  const stopTTS = async () => {
    try {
      logger.debug('Stopping TTS');
      await sendMessage({
        action: MessageActions.TTS_STOP,
        data: { stopOnlyIfOwner: true },
        context: MessageContexts.SIDEPANEL,
        timestamp: Date.now()
      });
    } catch (err) {
      logger.info('TTS stop failed (might not be active):', err,
      );
    }
  };

  return {
    isProcessing,
    error,
    revertTranslation,
    stopTTS,
  };
}

export function useFieldTranslation() {
  return {};
}

export function useSelectionTranslation() {
  return {};
}

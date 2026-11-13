// usePageTranslation - Vue composable for page translation UI
// Provides reactive state and actions for whole page translation

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons, MessageContexts } from '@/shared/messaging/core/MessagingCore.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import browser from 'webextension-polyfill';

import { useTranslationStore } from '@/features/translation/stores/translation.js';
import { getPageTranslationErrorPresentation } from '@/features/page-translation/utils/PageTranslationErrorPresenter.js';

/**
 * Composable for page translation UI
 * @returns {Object} Page translation state and actions
 */
export function usePageTranslation() {
  const translationStore = useTranslationStore();
  
  // State
  const isTranslating = ref(false);
  const isTranslated = ref(false);
  const isAutoTranslating = ref(false); // Persistent state (NEW)
  const translatedCount = ref(0);
  const failedCount = ref(0);
  const totalNodes = ref(0);
  const message = ref('');
  const error = ref(null);

  const progress = computed(() => {
    if (error.value && !isTranslating.value && !isAutoTranslating.value) return 0;
    if (!totalNodes.value || totalNodes.value === 0) return 0;
    const processed = translatedCount.value + failedCount.value;
    return Math.min(100, Math.round((processed / totalNodes.value) * 100));
  });

  // Event listeners
  let progressListener = null;
  let completeListener = null;
  let errorListener = null;
  let restoreCompleteListener = null;
  let autoRestoreCompleteListener = null; // Auto-restore event (NEW)
  let cancelledListener = null;
  let resetErrorListener = null;

  function applyRestrictedPageState(response) {
    const restrictedMessage = response?.message || 'Feature not available on this page';

    isTranslating.value = false;
    isTranslated.value = false;
    isAutoTranslating.value = false;
    translatedCount.value = 0;
    failedCount.value = 0;
    totalNodes.value = 0;
    error.value = null;
    message.value = restrictedMessage;
  }

  /**
   * Fetch current translation status from the active tab
   */
  async function refreshStatus() {
    try {
      const result = await sendRegularMessage({
        action: MessageActions.PAGE_TRANSLATE_GET_STATUS,
        context: MessageContexts.PAGE_TRANSLATION_UI,
      });

      if (result && result.success) {
        isTranslated.value = result.isTranslated || false;
        isTranslating.value = result.isTranslating || false;
        isAutoTranslating.value = result.isAutoTranslating || false;
        
        // Update progress if available
        if (result.translatedCount !== undefined) {
          translatedCount.value = result.translatedCount;
        }
        if (result.failedCount !== undefined) {
          failedCount.value = result.failedCount;
        }
        if (result.totalCount !== undefined) {
          totalNodes.value = result.totalCount;
        }
      } else if (result?.isRestrictedPage) {
        applyRestrictedPageState(result);
      } else {
        // Reset state if we can't get status (e.g. restricted page)
        isTranslated.value = false;
        isTranslating.value = false;
        isAutoTranslating.value = false;
      }
    } catch {
      // Content script might not be injected or ready
      isTranslated.value = false;
      isTranslating.value = false;
      isAutoTranslating.value = false;
    }
  }

  /**
   * Translate the current page
   * @param {Object} data Optional data to pass to the translation message (e.g. { isAuto: true })
   */
  async function translatePage(data = {}) {
    if (isTranslating.value) {
      return;
    }

    try {
      // Determine synced provider if any
      const syncedProvider = translationStore.ephemeralSync.page && translationStore.selectedProvider
        ? translationStore.selectedProvider
        : null;

      const result = await sendRegularMessage({
        action: MessageActions.PAGE_TRANSLATE,
        data: { 
          ...data,
          provider: syncedProvider // اضافه کردن پرووایدرِ همگام‌سازی شده
        },
        context: MessageContexts.PAGE_TRANSLATION_UI,
      }, {
        returnFailureResponse: true,
      });

      if (result?.isRestrictedPage) {
        applyRestrictedPageState(result);
        return;
      }

      if (result?.success === false) {
        if ([
          ActionReasons.USER_CANCELLED,
          ActionReasons.SILENT_ERROR,
          ActionReasons.BUSY_OR_DONE,
          ActionReasons.NOT_SUITABLE,
        ].includes(result.reason)) {
          return;
        }

        const displayError = await getPageTranslationErrorPresentation({
          error: result.error || result.message,
          errorDetails: result.errorDetails,
          errorType: result.errorType,
        });
        if (!displayError) return;

        error.value = displayError;
        message.value = `Error: ${displayError.message}`;
        return;
      }

      if (!result?.success) throw new Error(result?.reason || 'Translation failed');
    } catch (e) {
      // Preserve lifecycle state; only update presentation for real failures.
      if (e.message !== 'silent_error') {
        const displayError = await getPageTranslationErrorPresentation({ error: e });
        if (!displayError) return;

        error.value = displayError;
        message.value = `Error: ${displayError.message}`;
      }
    }
  }

  /**
   * Restore original page content
   */
  async function restorePage() {
    // We don't set isTranslating = true here to avoid showing the loading spinner 
    // during the fast restoration process.
    isAutoTranslating.value = false;
    message.value = 'Restoring original content...';
    error.value = null;

    try {
      const result = await sendRegularMessage({
        action: MessageActions.PAGE_RESTORE,
        context: MessageContexts.PAGE_TRANSLATION_UI,
      });

      if (result?.isRestrictedPage) {
        applyRestrictedPageState(result);
        return;
      }

      if (result.success) {
        isTranslated.value = false;
        isAutoTranslating.value = false;
        message.value = `Restored ${result.restoredCount} elements`;
        translatedCount.value = 0;
        failedCount.value = 0;
        totalNodes.value = 0;
      } else {
        throw new Error(result.reason || 'Restore failed');
      }
    } catch {
      error.value = 'Restore failed';
      message.value = 'Restore failed';
    }
  }

  /**
   * Stop auto-translation (persistence)
   */
  async function stopAutoTranslation() {
    try {
      const result = await sendRegularMessage({
        action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
        context: MessageContexts.PAGE_TRANSLATION_UI,
      });

      if (result?.isRestrictedPage) {
        applyRestrictedPageState(result);
        return;
      }

      if (result.success) {
        isAutoTranslating.value = false;
        isTranslating.value = false;
        // If result contains isTranslated info, use it; otherwise assume current state
        if (result.isTranslated !== undefined) {
          isTranslated.value = result.isTranslated;
        }
        // If result has translatedCount, use it to determine isTranslated
        if (result.translatedCount !== undefined) {
          isTranslated.value = result.translatedCount > 0;
          translatedCount.value = result.translatedCount;
        }
        if (result.failedCount !== undefined) {
          failedCount.value = result.failedCount;
        }
        message.value = 'Auto-translation stopped';
      }
    } catch {
      isAutoTranslating.value = false;
      isTranslating.value = false;
    }
  }

  /**
   * Cancel ongoing translation
   */
  function cancelTranslation() {
    if (isTranslating.value) {
      sendRegularMessage({
        action: MessageActions.PAGE_TRANSLATE,
        data: { cancel: true },
        context: MessageContexts.PAGE_TRANSLATION_UI,
      });
      isTranslating.value = false;
      isAutoTranslating.value = false;
      translatedCount.value = 0;
      failedCount.value = 0;
      message.value = 'Translation cancelled';
    }
  }

  /**
   * Update progress
   */
  function updateProgress(data) {
    if (data.status === 'error') {
      isTranslating.value = false;
      isAutoTranslating.value = false;
      return;
    }

    // IDLE means active processing stopped, but we might still be in Auto mode
    if (data.status === 'idle') {
      isTranslating.value = false;
    }

    if (data.translated !== undefined) {
      translatedCount.value = data.translated;
    } else if (data.translatedCount !== undefined) {
      translatedCount.value = data.translatedCount;
    }

    if (data.failed !== undefined) {
      failedCount.value = data.failed;
    } else if (data.failedCount !== undefined) {
      failedCount.value = data.failedCount;
    }

    if (data.total !== undefined) {
      totalNodes.value = data.total;
    } else if (data.totalCount !== undefined) {
      totalNodes.value = data.totalCount;
    }

    if (data.message !== undefined) {
      message.value = data.message;
    }
    
    // Update state flags if provided
    if (data.isTranslating !== undefined) {
      isTranslating.value = !!data.isTranslating;
    }
    if (data.isTranslated !== undefined) {
      isTranslated.value = !!data.isTranslated;
    }
    if (data.isAutoTranslating !== undefined) {
      isAutoTranslating.value = !!data.isAutoTranslating;
    }
  }

  /**
   * Handle translation complete
   */
  function handleComplete(data) {
    isTranslating.value = false;
    const isMainFrame = typeof window !== 'undefined' && window.self === window.top;

    // Skip empty/invalid messages - they might come from iframes or initialization
    // BUT: process if it is aggregated as it represents the whole page state
    // OR: if we are in the main frame/popup context
    if (!data.isAggregated && !isMainFrame && (!data || (data.translatedCount === 0 && data.failedCount === 0 && !data.isTranslated))) {
      // Refresh status to get accurate state from content script
      refreshStatus().catch(() => {});
      return;
    }

    // Determine isTranslated from data
    if (data.isTranslated !== undefined) {
      isTranslated.value = !!data.isTranslated;
    } else if (data.translatedCount !== undefined) {
      isTranslated.value = data.translatedCount > 0;
    } else {
      // Backward compatibility: assume translation completed
      isTranslated.value = true;
    }

    // Only update isAutoTranslating if it's explicitly provided in the message
    if (data.isAutoTranslating !== undefined) {
      isAutoTranslating.value = !!data.isAutoTranslating;
    }

    if (data.translatedCount !== undefined) translatedCount.value = data.translatedCount;
    if (data.failedCount !== undefined) failedCount.value = data.failedCount;
    if (data.totalNodes !== undefined) totalNodes.value = data.totalNodes;
    else if (data.totalCount !== undefined) totalNodes.value = data.totalCount;
  }

  /**
   * Handle translation error
   */
  async function handleError(data) {
    const displayError = await getPageTranslationErrorPresentation(data);
    if (!displayError) return;

    isTranslating.value = false;
    isAutoTranslating.value = false;

    // Apply the stopped-state counts published by the error event so the UI
    // reflects partial translations without waiting for a status refresh.
    if (data.isTranslated !== undefined) {
      isTranslated.value = !!data.isTranslated;
    } else if (data.translatedCount !== undefined) {
      isTranslated.value = data.translatedCount > 0;
    }

    if (data.translatedCount !== undefined) translatedCount.value = data.translatedCount;
    if (data.failedCount !== undefined) failedCount.value = data.failedCount;
    if (data.totalCount !== undefined) totalNodes.value = data.totalCount;

    error.value = displayError;
    message.value = `Error: ${displayError.message}`;
  }

  /**
   * Handle restore complete
   */
  function handleRestoreComplete(data) {
    isTranslating.value = false;
    isTranslated.value = false;
    isAutoTranslating.value = false;
    translatedCount.value = 0;
    failedCount.value = 0;
    totalNodes.value = 0;
    message.value = `Restore complete! ${data.restoredCount} elements restored`;
  }

  /**
   * Handle auto-restore complete (just stopped auto-translation)
   */
  function handleAutoRestoreComplete(data) {
    isAutoTranslating.value = false;
    isTranslating.value = false;
    const isMainFrame = typeof window !== 'undefined' && window.self === window.top;

    // Skip empty/invalid messages - they might come from empty frames
    // Only process messages with meaningful translation data
    // BUT: Allow if it's aggregated or from the main frame
    if (!data.isAggregated && !isMainFrame && (!data || (data.translatedCount === 0 && !data.isTranslated))) {
      // If this is an invalid message, refresh status from content script to get accurate state
      refreshStatus().catch(() => {});
      return;
    }

    // Determine if the page remains translated
    // Priority: isTranslated flag > translatedCount
    if (data.isTranslated !== undefined) {
      isTranslated.value = !!data.isTranslated;
    } else if (data.translatedCount !== undefined) {
      isTranslated.value = data.translatedCount > 0;
    }

    message.value = 'Auto-translation stopped';
  }

  /**
   * Handle translation cancelled
   */
  function handleCancelled() {
    isTranslating.value = false;
    isAutoTranslating.value = false;
    isTranslated.value = false; // Cancel usually implies restore
    message.value = 'Translation cancelled';
  }

  /**
   * Handle error reset
   */
  function handleResetError() {
    error.value = null;
    if (message.value && message.value.includes('Error:')) {
      message.value = '';
    }
  }

  // Tab change handlers for Sidepanel sync
  const handleTabChange = () => {
    refreshStatus();
  };

  const handleTabUpdate = (tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
      refreshStatus();
    }
  };

  /**
   * Handle incoming messages from other extension components (broadcasting)
   */
  const handleRuntimeMessage = (runtimeMessage) => {
    if (!runtimeMessage || !runtimeMessage.action) return;

    // We only care about page translation events
    switch (runtimeMessage.action) {
      case MessageActions.PAGE_TRANSLATE_START:
        isTranslating.value = true;
        isTranslated.value = false;
        if (runtimeMessage.data?.isAutoTranslating !== undefined) {
          isAutoTranslating.value = !!runtimeMessage.data.isAutoTranslating;
        }
        translatedCount.value = 0;
        failedCount.value = 0;
        totalNodes.value = 0;
        error.value = null;
        message.value = 'Starting translation...';
        break;
      case MessageActions.PAGE_TRANSLATE_PROGRESS:
      case MessageActions.PAGE_TRANSLATE_IDLE:
        updateProgress(runtimeMessage.data || {});
        break;
      case MessageActions.PAGE_TRANSLATE_COMPLETE:
        handleComplete(runtimeMessage.data || {});
        break;
      case MessageActions.PAGE_TRANSLATE_ERROR:
        handleError(runtimeMessage.data || {});
        break;
      case MessageActions.PAGE_RESTORE_COMPLETE:
        handleRestoreComplete(runtimeMessage.data || {});
        break;
      case MessageActions.PAGE_AUTO_RESTORE_COMPLETE:
        handleAutoRestoreComplete(runtimeMessage.data || {});
        break;
      case MessageActions.PAGE_TRANSLATE_CANCELLED:
        handleCancelled();
        break;
      case MessageActions.PAGE_TRANSLATE_RESET_ERROR:
        handleResetError();
        break;
    }
  };

  // Setup event listeners
  onMounted(() => {
    // Initial status fetch
    refreshStatus();

    // Tab awareness for sidepanel
    if (typeof browser !== 'undefined' && browser.tabs) {
      browser.tabs.onActivated.addListener(handleTabChange);
      browser.tabs.onUpdated.addListener(handleTabUpdate);
    }

    // Runtime message listener for cross-context broadcasting
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
      browser.runtime.onMessage.addListener(handleRuntimeMessage);
    }

    // Progress updates
    progressListener = (data) => updateProgress(data);
    pageEventBus.on('page-translation-progress', progressListener);

    // Translation complete
    completeListener = (data) => handleComplete(data);
    pageEventBus.on('page-translation-complete', completeListener);

    // Translation error
    errorListener = (data) => handleError(data);
    pageEventBus.on('page-translation-error', errorListener);

    // Restore complete
    restoreCompleteListener = (data) => handleRestoreComplete(data);
    pageEventBus.on('page-restore-complete', restoreCompleteListener);

    // Auto restore complete
    autoRestoreCompleteListener = (data) => handleAutoRestoreComplete(data);
    pageEventBus.on(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, autoRestoreCompleteListener);

    // Translation cancelled
    cancelledListener = () => handleCancelled();
    pageEventBus.on('page-translation-cancelled', cancelledListener);

    // Error reset
    resetErrorListener = () => handleResetError();
    pageEventBus.on(MessageActions.PAGE_TRANSLATE_RESET_ERROR, resetErrorListener);
  });

  // Cleanup event listeners
  onUnmounted(() => {
    if (typeof browser !== 'undefined' && browser.tabs) {
      browser.tabs.onActivated.removeListener(handleTabChange);
      browser.tabs.onUpdated.removeListener(handleTabUpdate);
    }

    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
      browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    }

    pageEventBus.off('page-translation-progress', progressListener);
    pageEventBus.off('page-translation-complete', completeListener);
    pageEventBus.off('page-translation-error', errorListener);
    pageEventBus.off('page-restore-complete', restoreCompleteListener);
    pageEventBus.off(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, autoRestoreCompleteListener);
    pageEventBus.off('page-translation-cancelled', cancelledListener);
    pageEventBus.off(MessageActions.PAGE_TRANSLATE_RESET_ERROR, resetErrorListener);
  });

  return {
    // State
    isTranslating,
    isTranslated,
    isAutoTranslating,
    progress,
    translatedCount,
    failedCount,
    totalNodes,
    message,
    error,

    // Actions
    translatePage,
    restorePage,
    stopAutoTranslation,
    cancelTranslation,
    refreshStatus,

    // Computed
    canTranslate: computed(() => !isTranslating.value && !isAutoTranslating.value),
    canRestore: computed(() => isTranslated.value && !isTranslating.value),
    canCancel: computed(() => isTranslating.value),
    canStopAuto: computed(() => isAutoTranslating.value),
    hasError: computed(() => error.value !== null),

    // Status
    status: computed(() => {
      if (error.value) return 'error';
      if (isTranslating.value || isAutoTranslating.value) return 'translating';
      if (isTranslated.value) return 'translated';
      return 'idle';
    }),
  };
}

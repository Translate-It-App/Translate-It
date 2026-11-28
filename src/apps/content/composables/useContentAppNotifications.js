import { onMounted, h } from 'vue';
import { toast } from 'vue-sonner';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT_APP, 'useContentAppNotifications');
const ATTEMPT_TOKEN_WARNING_ID_PREFIX = 'page-translation-token-warning-';

/**
 * Composable for managing toast notifications in the ContentApp.
 * Handles display, dismissal, duplication prevention, and RTL support.
 * 
 * @param {Object} options - Configuration options
 * @param {Object} options.shouldShowGlobalUI - Computed ref for showing UI
 * @param {Object} options.toastRTL - Ref for current RTL state
 * @param {Object} options.tracker - Resource tracker for event listeners
 * @returns {Object} Methods for notification management
 */
export function useContentAppNotifications({ shouldShowGlobalUI, toastRTL, tracker }) {
  const toastMap = {
    error: toast.error,
    warning: toast.warning,
    success: toast.success,
    info: toast.info,
    status: toast.loading,
    revert: toast,
    'select-element': toast.info,
  };

  /**
   * Initializes global notification tracking sets.
   * Ensures necessary data structures exist on the window object for cross-frame coordination.
   */
  const initializeGlobalTrackers = () => {
    // Use a global Set to prevent duplicate notifications
    if (!window.translateItShownNotifications) {
      window.translateItShownNotifications = new Set();
    }
    
    // Track dismissed notifications to prevent double dismissal
    if (!window.translateItDismissedNotifications) {
      window.translateItDismissedNotifications = new Set();
    }

    // Track checkbox states for interactive notifications
    if (!window.translateItToastStates) {
      window.translateItToastStates = new Map();
    }
  };

  /**
   * Checks if a notification is a duplicate within a recent window (1s).
   * 
   * @param {string} message - Notification message
   * @param {string} type - Notification type
   * @returns {boolean} True if it's a duplicate
   */
  const isDuplicateNotification = (message, type) => {
    const recentKeys = Array.from(window.translateItShownNotifications).filter(key => {
      const timestamp = parseInt(key.split('-').pop());
      return Date.now() - timestamp < 1000; // 1 second window
    });

    return recentKeys.some(key =>
      key.startsWith(`${message}-${type}`)
    );
  };

  /**
   * Builds the interactive description VNode containing checkboxes and action buttons.
   * This allows for complex layouts within the standard toast notification.
   * 
   * @param {Object} detail - Notification detail object
   * @returns {VNode|null} The rendered actions or null
   */
  const renderToastActions = (detail) => {
    const { id, actions, hasCheckbox, checkboxLabel } = detail;
    const children = [];

    // 1. Render Checkbox if requested (e.g., "Don't show again")
    if (hasCheckbox) {
      children.push(h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '8px',
          fontSize: '12px',
          color: '#666',
          cursor: 'pointer',
          userSelect: 'none'
        },
        onClick: (e) => {
          e.stopPropagation();
          const state = window.translateItToastStates.get(id);
          if (state) {
            state.checkboxChecked = !state.checkboxChecked;
            const checkbox = e.currentTarget.querySelector('input');
            if (checkbox) checkbox.checked = state.checkboxChecked;
          }
        }
      }, [
        h('input', {
          type: 'checkbox',
          style: { cursor: 'pointer', margin: 0 },
          onClick: (e) => e.stopPropagation(), // Prevent double toggle
          onChange: (e) => {
            const state = window.translateItToastStates.get(id);
            if (state) state.checkboxChecked = e.target.checked;
          }
        }),
        h('span', checkboxLabel)
      ]));
    }

    // 2. Render Action Buttons (Multi-action support)
    if (actions && actions.length > 0) {
      children.push(h('div', { 
        style: { 
          display: 'flex', 
          gap: '8px', 
          justifyContent: toastRTL.value ? 'flex-end' : 'flex-start'
        } 
      }, actions.map(action => h('button', {
        'data-translate-it-ignore-toast-handler': 'true',
        style: {
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          cursor: 'pointer',
          border: '1px solid #ddd',
          backgroundColor: '#fff',
          color: '#333'
        },
        onClick: (event) => {
          if (event) event.preventDefault();
          const state = window.translateItToastStates.get(id);
          const checkboxChecked = state ? state.checkboxChecked : false;
          
          if (action.handler) action.handler(checkboxChecked);
          if (action.onClick) action.onClick(checkboxChecked);
          if (action.eventName && window.pageEventBus) {
            window.pageEventBus.emit(action.eventName, { checkboxChecked });
          }
          toast.dismiss(id);
        }
      }, action.label))));
    }

    return children.length > 0 ? h('div', { style: { marginTop: '8px' } }, children) : null;
  };

  /**
   * Main handler for showing notifications.
   * Coordinates duplication check, state management, and final display logic.
   * 
   * @param {Object} detail - Notification details from the event bus
   */
  const handleShowNotification = async (detail) => {
    // Only process notifications if this frame is responsible for showing global UI
    if (!shouldShowGlobalUI.value) {
      logger.debug('Skipping notification: shouldShowGlobalUI is false');
      return;
    }

    const { id, message, type, duration, persistent } = detail;

    // Skip duplicate check for updates
    const isAttemptOwnedTokenWarning = id?.startsWith(ATTEMPT_TOKEN_WARNING_ID_PREFIX);
    if (isDuplicateNotification(message, type) && !detail.isUpdate && !isAttemptOwnedTokenWarning) {
      logger.debug('Skipping notification: Duplicate detected');
      return;
    }

    // Add to tracking set
    const notificationKey = `${message}-${type}-${Date.now()}`;
    window.translateItShownNotifications.add(notificationKey);

    // Clean up old entries (keep only last 10) to manage memory
    if (window.translateItShownNotifications.size > 10) {
      const entries = Array.from(window.translateItShownNotifications);
      entries.slice(0, -10).forEach(key => {
        window.translateItShownNotifications.delete(key);
      });
    }

    // Initialize state management for this specific toast
    window.translateItToastStates.set(id, { checkboxChecked: false });

    const toastFn = toastMap[type] || toast.info;

    // CRITICAL: Use reactive RTL value (SYNC - optimal performance)
    const detectedDirection = toastRTL.value ? 'rtl' : 'ltr';

    const toastOptions = {
      id,
      duration: persistent ? Infinity : duration,
      style: {
        direction: detectedDirection,
        textAlign: toastRTL.value ? 'right' : 'left'
      },
      // Use description slot for custom layout (checkbox + buttons)
      description: renderToastActions(detail)
    };
    
    toastFn(message, toastOptions);
  };

  /**
   * Main handler for dismissing specific notifications.
   * Ensures clean state removal for tracking and interactive data.
   * 
   * @param {Object} detail - Dismissal details containing the ID
   */
  const handleDismissNotification = (detail) => {
    logger.debug('Received dismiss_notification event:', detail);

    // Prevent double dismissal
    if (window.translateItDismissedNotifications.has(detail.id)) {
      logger.debug('Notification already dismissed, ignoring:', detail.id);
      return;
    }

    window.translateItDismissedNotifications.add(detail.id);

    // Force dismiss
    toast.dismiss(detail.id);

    // Clean up tracking sets after a delay to allow animations to finish
    setTimeout(() => {
      if (window.translateItDismissedNotifications) {
        window.translateItDismissedNotifications.delete(detail.id);
      }
      if (window.translateItToastStates) {
        window.translateItToastStates.delete(detail.id);
      }
    }, 2000);
  };

  onMounted(() => {
    initializeGlobalTrackers();
    
    const pageEventBus = window.pageEventBus;
    if (pageEventBus) {
      tracker.addEventListener(pageEventBus, 'show-notification', handleShowNotification);
      tracker.addEventListener(pageEventBus, 'dismiss_notification', handleDismissNotification);
      tracker.addEventListener(pageEventBus, 'dismiss_all_notifications', () => {
        logger.debug('Received dismiss_all_notifications event');
        toast.dismiss();
      });
    }
  });

  return {
    handleShowNotification,
    handleDismissNotification
  };
}

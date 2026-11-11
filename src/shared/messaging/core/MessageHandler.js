import browser from 'webextension-polyfill';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { MessageFormat } from './MessagingCore.js';
import { MessageActions } from './MessageActions.js';

const logger = getScopedLogger(LOG_COMPONENTS.MESSAGING, 'MessageHandler');

class MessageHandler {
  constructor() {
    this.handlers = new Map();
    this.isListenerActive = false;
    this.pendingResponses = new Map();
    this._pendingRegistrations = [];
    this._registrationTimeout = null;
    // Actions whose current handler is a fallback. A fallback is expected to
    // be replaced by the authoritative handler for the same action, so that
    // replacement is not a duplicate registration.
    this._fallbackActions = new Set();
  }

  /**
   * Register a handler for an action.
   * @param {string} action - Action name
   * @param {Function} handler - Handler function
   * @param {{ fallback?: boolean }} [options] - `fallback: true` marks this
   *   registration as a fallback that the authoritative handler for the same
   *   action replaces without the duplicate-registration warning.
   */
  registerHandler(action, handler, { fallback = false } = {}) {
    if (this.handlers.has(action)) {
      if (this._fallbackActions.has(action)) {
        logger.debug(`Handler for action '${action}' replaced by the authoritative handler.`);
      } else {
        logger.warn(`Handler for action '${action}' is already registered. Overwriting.`);
      }
    }
    this.handlers.set(action, handler);

    if (fallback) {
      this._fallbackActions.add(action);
    } else {
      this._fallbackActions.delete(action);
    }

    // Collect registrations for batched logging
    this._pendingRegistrations.push(action);

    // Schedule batched logging
    if (!this._registrationTimeout) {
      this._registrationTimeout = setTimeout(() => {
        const count = this._pendingRegistrations.length;
        if (count > 1) {
          logger.debug(`🔧 ${count} handlers registered: ${this._pendingRegistrations.join(', ')}`);
        } else {
          logger.debug(`Handler registered for action: ${this._pendingRegistrations[0]}`);
        }
        this._pendingRegistrations = [];
        this._registrationTimeout = null;
      }, 50); // Batch within 50ms
    }
  }

  unregisterHandler(action) {
    this._fallbackActions.delete(action);
    if (this.handlers.has(action)) {
      this.handlers.delete(action);
      logger.debug(`Handler for action '${action}' unregistered.`);
    }
  }

  /**
   * Get handler for specific action (backward compatibility)
   * @param {string} action - Action name
   * @returns {Function|null} Handler function or null
   */
  getHandlerForMessage(action) {
    return this.handlers.get(action) || null;
  }

  _handleMessage(message, sender, sendResponse) {
    // Allow messages with just action (for backward compatibility)
    if (!message || !message.action) {
      logger.debug('Received message without action.');
      return false;
    }

    // Normalize message format if needed
    const normalizedMessage = this._normalizeMessage(message);

    const { action, messageId } = normalizedMessage;
    const handler = this.handlers.get(action);

    if (handler) {
      let responseSent = false;
      let responseValue = undefined;
      const wrappedSendResponse = (response) => {
        if (responseSent) return;
        responseSent = true;
        responseValue = response;
        try {
          if (sendResponse) {
            sendResponse(response);
          }
        } catch (e) {
          logger.error('Error in wrapped sendResponse:', e);
        }
      };

      const result = handler(normalizedMessage, sender, wrappedSendResponse);

      if (result instanceof Promise) {
        // Return the promise itself to browser.onMessage listener (webextension-polyfill)
        // This is the standard, reliable way to handle async messaging across both Firefox and Chrome.
        return result.then(resolvedValue => {
          if (responseSent) {
            return responseValue;
          }
          return resolvedValue;
        }).catch(error => {
          logger.error(`Error in promise-based handler for ${action}:`, error);
          return MessageFormat.createErrorResponse(error, messageId);
        });
      } else if (result === true) {
        // Handler indicates it will send response asynchronously (e.g. legacy/sync handlers)
        logger.debug(`Async response handler for ${action}`);
        return true;
      } else {
        logger.debug(`Synchronous handler for ${action}. Sending response immediately.`);
        try {
          if (sendResponse && result !== undefined) {
            wrappedSendResponse(result);
          }
        } catch (error) {
          logger.error(`Failed to send synchronous response for ${action}:`, error);
        }
        return false;
      }
    } else {
      // Event-like or streaming messages that might not have a handler in all contexts
      // Don't log for these to reduce verbosity in the console
      const silentBroadcastActions = [
        MessageActions.TRANSLATION_STREAM_UPDATE, 
        MessageActions.TRANSLATION_STREAM_END, 
        MessageActions.TRANSLATION_RESULT_UPDATE,
        MessageActions.PAGE_TRANSLATE_PROGRESS,
        MessageActions.PAGE_TRANSLATE_COMPLETE,
        MessageActions.PAGE_RESTORE_COMPLETE,
      ];
      
      if (!silentBroadcastActions.includes(action)) {
        logger.debug(`No handler for: ${action}`);
      }
      // No handler, so we don't need to keep the message channel open
      // Return false to allow other listeners to handle the message
      return false;
    }
  }

  _normalizeMessage(message) {
    // If message is already in correct format, return as-is
    if (message.messageId && message.context) {
      return message;
    }

    // Create normalized message with missing fields
    return {
      ...message,
      messageId: message.messageId || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      context: message.context || 'unknown',
      timestamp: message.timestamp || Date.now()
    };
  }

  _sendResponse(messageId, response) {
    const sendResponse = this.pendingResponses.get(messageId);
    if (sendResponse) {
      try {
        sendResponse(response);
      } catch (error) {
        logger.error(`Failed to send response for messageId ${messageId}:`, error);
      }
      this.pendingResponses.delete(messageId);
    } else {
      logger.debug(`No pending response found for messageId: ${messageId}`);
    }
  }

  listen() {
    if (this.isListenerActive) {
      logger.warn('Message listener is already active.');
      return;
    }
    
    // Bind the handler to preserve 'this' context
    this._boundHandleMessage = this._handleMessage.bind(this);
    browser.runtime.onMessage.addListener(this._boundHandleMessage);
    this.isListenerActive = true;
    logger.debug('Message listener activated.');
  }

  /**
   * Remove message listener
   */
  stopListening() {
    if (!this.isListenerActive) {
      return;
    }
    
    if (this._boundHandleMessage) {
      browser.runtime.onMessage.removeListener(this._boundHandleMessage);
      this._boundHandleMessage = null;
    }
    
    this.isListenerActive = false;
    logger.debug('Message listener deactivated.');
  }
}

// Export the MessageHandler class and create context-specific instances
export { MessageHandler };

// Export context-specific instances
let _instance = null;
export const messageHandler = {
  get instance() {
    if (!_instance) {
      _instance = new MessageHandler();
    }
    return _instance;
  }
};

// Helper to create new instances for different contexts
export function createMessageHandler() {
  return new MessageHandler();
}

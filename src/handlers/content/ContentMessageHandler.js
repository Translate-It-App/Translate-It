import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageFormat, MessagingContexts, reconstructTranslationError, isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { TranslationMode } from '@/shared/config/config.js';
import browser from 'webextension-polyfill';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { revertHandler } from './RevertHandler.js';
import { applyTranslationToTextField } from '../smartTranslationIntegration.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getSelectElementActivationErrorMessage } from '@/features/element-selection/utils/activationError.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { getFieldTranslationErrorPresentation } from '@/features/text-field-interaction/utils/FieldTranslationErrorPresenter.js';
import { getPageTranslationErrorPresentation } from '@/features/page-translation/utils/PageTranslationErrorPresenter.js';
import { LIVE_DUBBING_ACTIONS } from '@/features/live-dubbing/constants.js';
import {
  acceptLiveDubbingTranscript,
  clearLiveDubbingTranscript,
  sanitizeLiveDubbingTranscriptEnvelope,
} from '@/features/live-dubbing/content/liveDubbingTranscriptStore.js';

// Singleton instance for ContentMessageHandler
let contentMessageHandlerInstance = null;

function isSelectElementGeneration(value) {
  return Number.isInteger(value) && value > 0;
}

function isSelectElementEpoch(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getSelectElementActiveState(manager) {
  if (typeof manager?.isSelectElementActive === 'function') {
    return manager.isSelectElementActive() === true;
  }
  return manager?.isActive === true;
}

export class ContentMessageHandler extends ResourceTracker {
  constructor() {
    super('content-message-handler')

    // Enforce singleton pattern
    if (contentMessageHandlerInstance) {
            // logger.trace('ContentMessageHandler singleton already exists, returning existing instance');
      return contentMessageHandlerInstance;
    }

    this.handlers = new Map();
    this.initialized = false;
    this._handlersPrepared = false;
    this._externallyRegistered = false;
    this._externalMessageHandler = null;
    this._registeredActions = new Set();
    this.isActive = false;
    this.context = MessagingContexts.CONTENT;
    this.logger = getScopedLogger(LOG_COMPONENTS.MESSAGING, 'MessageHandler');
    this.selectElementManager = null;
    // Generation is local to this content frame; tab-wide authority stays in Background.
    // Epoch separates generation ordering across background module lifetimes.
    this.acceptedSelectElementEpoch = null;
    this.retiredSelectElementEpochs = new Set();
    this.acceptedSelectElementGeneration = null;
    this.invalidatedSelectElementEpoch = null;
    this.invalidatedSelectElementGeneration = null;
    this.iFrameManager = null;
    this.pageTranslationManager = null;
    this.childFrameRetirementListenerInstalled = false;
    this.errorHandler = ErrorHandler.getInstance();

    // Track processed message IDs to prevent duplicates
    this.processedMessageIds = new Set();

    // Store singleton instance
    contentMessageHandlerInstance = this;
    this.logger.info('ContentMessageHandler singleton created');

    // CRITICAL: Protect ContentMessageHandler itself from Memory Garbage Collector
    this.trackResource('content-message-handler-core', () => {
      // logger.trace('ContentMessageHandler core cleanup called - PROTECTED (critical resource)');
      // This callback is invoked but actual cleanup is skipped due to critical protection.
      // This is the expected behavior to preserve essential messaging functionality.
    }, { isCritical: true });
  }

  setSelectElementManager(manager) {
    this.selectElementManager = manager;
  }

  _enqueueSelectElementLifecycle(operation) {
    const manager = this.selectElementManager;
    // SelectElementManager owns frame-local serialization; this method only bridges handler admission.
    if (typeof manager?.enqueueSelectElementLifecycle === 'function') {
      return manager.enqueueSelectElementLifecycle(operation);
    }
    return operation({
      activate: options => manager?.activateSelectElementMode(options),
      deactivate: options => manager?.deactivate(options),
    });
  }

  _admitSelectElementEpoch(requestedEpoch) {
    if (!isSelectElementEpoch(requestedEpoch)) {
      return { accepted: true, legacy: true };
    }

    if (this.acceptedSelectElementEpoch === null) {
      this.acceptedSelectElementEpoch = requestedEpoch;
      return { accepted: true, newEpoch: true };
    }

    if (requestedEpoch === this.acceptedSelectElementEpoch) {
      return { accepted: true };
    }

    if (this.retiredSelectElementEpochs.has(requestedEpoch)) {
      return { accepted: false, staleEpoch: true };
    }

    this.retiredSelectElementEpochs.add(this.acceptedSelectElementEpoch);
    this.acceptedSelectElementEpoch = requestedEpoch;
    this.acceptedSelectElementGeneration = null;
    this.invalidatedSelectElementEpoch = null;
    this.invalidatedSelectElementGeneration = null;
    return { accepted: true, newEpoch: true };
  }

  setScreenCaptureManager(manager) {
    this.screenCaptureManager = manager;
  }

  setIFrameManager(manager) {
    this.iFrameManager = manager;
  }

  setPageTranslationManager(manager) {
    this.pageTranslationManager = manager;
  }

  _ensureChildFrameRetirementListener() {
    if (this.childFrameRetirementListenerInstalled || window === window.top) return;

    this.addEventListener(window, 'beforeunload', () => {
      const sessionId = this.pageTranslationManager?.acceptedLifecycleSessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;

      try {
        void browser.runtime.sendMessage({
          action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
          data: {
            action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
            data: { sessionId },
          },
          context: 'page-translation-frame-retirement',
        }).catch(() => {});
      } catch {
        // Unload retirement is best effort.
      }
    });
    this.childFrameRetirementListenerInstalled = true;
  }

  initialize() {
    if (this._handlersPrepared) return;
    this.registerHandlers();
    this._handlersPrepared = true;
    this.initialized = true;
    this.logger.init('Content message handler initialized');
  }

  async activate() {
    if (this.isActive && this._externallyRegistered) {
      return true;
    }

    try {
      if (!this._handlersPrepared) {
        this.initialize();
      }

      // Get the existing message handler from ContentScriptCore
      // ContentScriptCore should be available globally or through window
      let contentScriptCore = null;

      // Try to get ContentScriptCore instance
      if (window.translateItContentCore) {
        contentScriptCore = window.translateItContentCore;
      } else {
        // Fallback: create our own message handler if ContentScriptCore is not available
        this.logger.warn('ContentScriptCore not available, creating own message handler');
        try {
          const { createMessageHandler } = await import('@/shared/messaging/core/MessageHandler.js');
          this.messageHandler = createMessageHandler();
        } catch (error) {
          this.logger.error('Failed to create message handler:', error);
          throw new Error('MessageHandler creation failed');
        }
      }

      // Use ContentScriptCore's message handler if available
      const messageHandler = contentScriptCore ? contentScriptCore.messageHandler : this.messageHandler;

      const attemptActions = new Set();
      let attemptOwnListenerStarted = false;
      try {
        // Register all handlers with the message handler
        if (messageHandler && typeof messageHandler.registerHandler === 'function') {
          for (const [action, handler] of this.handlers.entries()) {
            messageHandler.registerHandler(action, (message, sender, sendResponse) => {
              try {
                // Call handler and return result directly (preserve Promise nature)
                const result = handler.call(this, message, sender, sendResponse);
                return result;
              } catch (error) {
                this.logger.error(`Error in content handler for ${action}:`, error);
                throw error;
              }
            });
            attemptActions.add(action);
          }

          // Register DebugModeBridge handlers
          try {
            const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js');
            const debugHandlers = debugModeBridge.getHandlerMappings();
            for (const [action, handler] of Object.entries(debugHandlers)) {
              messageHandler.registerHandler(action, handler);
              attemptActions.add(action);
            }
            this.logger.info('Registered DebugModeBridge handlers');
          } catch (error) {
            this.logger.warn('Failed to register DebugModeBridge handlers:', error);
          }

          // Store reference to message handler
          this.messageHandler = messageHandler;
          this._externalMessageHandler = messageHandler;

          this.logger.info(`ContentMessageHandler registered ${this.handlers.size} handlers`);
        } else {
          throw new Error('No valid message handler available');
        }

        // Activate the message listener if we created our own
        if (!contentScriptCore && this.messageHandler && !this.messageHandler.isListenerActive) {
          this.messageHandler.listen();
          attemptOwnListenerStarted = true;
          this.logger.info('ContentMessageHandler message listener activated');
        }

        // If using ContentScriptCore's message handler, it should already be listening
        if (contentScriptCore) {
          // logger.trace('Using ContentScriptCore message listener');
        }

        // Track message handler for cleanup - CRITICAL: Must survive memory cleanup
        this.trackResource('messageHandler', () => {
          this.logger.debug('Message handler is protected from cleanup and remains active');
        }, { isCritical: true });

        for (const action of attemptActions) {
          this._registeredActions.add(action);
        }
        this._externallyRegistered = true;
        this.isActive = true;
        this.initialized = true;
        this.logger.info('ContentMessageHandler activated successfully with smart message handling');
        return true;
      } catch (error) {
        for (const action of attemptActions) {
          try {
            if (messageHandler && typeof messageHandler.unregisterHandler === 'function') {
              messageHandler.unregisterHandler(action);
            }
          } catch { /* ignore */ }
        }
        if (attemptOwnListenerStarted && this.messageHandler && typeof this.messageHandler.stopListening === 'function') {
          try { this.messageHandler.stopListening(); } catch { /* ignore */ }
        }
        this.logger.error('Failed to activate ContentMessageHandler:', error);
        this._externallyRegistered = false;
        this.isActive = false;
        // Keep handlersPrepared so retry can re-attempt external registration without rebuilding handlers
        return false;
      }
    } catch (error) {
      this.logger.error('Failed to activate ContentMessageHandler:', error);
      this._externallyRegistered = false;
      this.isActive = false;
      return false;
    }
  }

  async deactivate() {
    if (!this._handlersPrepared && !this._externallyRegistered && !this.isActive) {
      return true;
    }

    try {
      if (this._externalMessageHandler && this._registeredActions.size > 0) {
        for (const action of Array.from(this._registeredActions)) {
          try {
            if (typeof this._externalMessageHandler.unregisterHandler === 'function') {
              this._externalMessageHandler.unregisterHandler(action);
            }
          } catch { /* ignore */ }
        }
        this._registeredActions.clear();
      } else if (this.messageHandler && this._registeredActions.size > 0) {
        for (const action of Array.from(this._registeredActions)) {
          try {
            if (typeof this.messageHandler.unregisterHandler === 'function') {
              this.messageHandler.unregisterHandler(action);
            }
          } catch { /* ignore */ }
        }
        this._registeredActions.clear();
      }

      this._externallyRegistered = false;
      this.isActive = false;
      this.initialized = false;
      // Keep handlersPrepared and handler map for retryable reactivation
      this.logger.info('ContentMessageHandler deactivated successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to deactivate ContentMessageHandler:', error);
      return false;
    }
  }

  registerHandlers() {
    this.registerHandler(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, this.handleActivateSelectElementMode.bind(this));
    this.registerHandler(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, this.handleDeactivateSelectElementMode.bind(this));
    this.registerHandler(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE, this.handleGetSelectElementFrameState.bind(this));
    
    // Screen capture handlers
    this.registerHandler(MessageActions.START_SCREEN_CAPTURE, this.handleStartScreenCapture.bind(this));
    this.registerHandler(MessageActions.SCREEN_CAPTURE_OCR_RESULT, this.handleScreenCaptureResult.bind(this));
    
    this.registerHandler(MessageActions.TRANSLATION_RESULT_UPDATE, this.handleTranslationResult.bind(this));
    this.registerHandler(MessageActions.REVERT_SELECT_ELEMENT_MODE, this.handleRevertTranslation.bind(this));

    // Streaming translation handlers - delegate to ContentScriptIntegration
    this.registerHandler(MessageActions.TRANSLATION_STREAM_UPDATE, this.handleStreamUpdate.bind(this));
    this.registerHandler(MessageActions.TRANSLATION_STREAM_END, this.handleStreamEnd.bind(this));

    // IFrame support handlers (Select Element authority is via Background frame-targeted messaging)
    this.registerHandler(MessageActions.IFRAME_GET_FRAME_INFO, this.handleIFrameGetFrameInfo.bind(this));
    this.registerHandler(MessageActions.IFRAME_DETECT_TEXT_FIELDS, this.handleIFrameDetectTextFields.bind(this));
    this.registerHandler(MessageActions.IFRAME_INSERT_TEXT, this.handleIFrameInsertText.bind(this));
    this.registerHandler(MessageActions.IFRAME_SYNC_REQUEST, this.handleIFrameSyncRequest.bind(this));
    this.registerHandler(MessageActions.IFRAME_SYNC_RESPONSE, this.handleIFrameSyncResponse.bind(this));

    // Page translation handlers
    this.registerHandler(MessageActions.PAGE_TRANSLATE, this.handlePageTranslate.bind(this));
    this.registerHandler(MessageActions.PAGE_RESTORE, this.handlePageRestore.bind(this));
    this.registerHandler(MessageActions.PAGE_TRANSLATE_GET_STATUS, this.handlePageGetStatus.bind(this));
    this.registerHandler(MessageActions.PAGE_TRANSLATE_STOP_AUTO, this.handlePageStopAuto.bind(this));
    this.registerHandler(MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE, this.handlePageTranslationLifecycle.bind(this));

    // Live dubbing transcript is a display-only, session-fenced bridge. The
    // translated and original (source) transcript actions share one accept
    // path; the store routes each envelope to its buffer by kind.
    this.registerHandler(LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT, this.handleLiveDubbingStatus.bind(this));
    this.registerHandler(LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT, this.handleLiveDubbingStatus.bind(this));
    // Single kind-agnostic clear path for STOP/terminal handling.
    this.registerHandler(LIVE_DUBBING_ACTIONS.TRANSCRIPT_CLEAR, this.handleLiveDubbingClear.bind(this));
  }

  registerHandler(action, handler) {
    if (this.handlers.has(action)) {
      this.logger.warn(`Overwriting handler for action: ${action}`);
    }
    this.handlers.set(action, handler);
  }

  unregisterHandler(action) {
    if (this.handlers.has(action)) {
      this.handlers.delete(action);
      // logger.trace(`Handler unregistered for action: ${action}`);
    }
  }

  unregisterAllHandlers() {
    this.handlers.clear();
    // logger.trace('All handlers unregistered');
  }

  async handleMessage(message, sender, sendResponse) {
    this.logger.debug(`Handling message: ${message.action}`);
    const handler = this.handlers.get(message.action);
    if (handler) {
      try {
        const result = await handler(message, sender);
        try {
          if (sendResponse) sendResponse({ success: true, data: result });
        } catch (e) {
          this.logger.error(`Failed to send response for ${message.action}:`, e);
        }
        return true; // Message was handled
      } catch (error) {
        // Don't log errors that are already handled
        if (!error.alreadyHandled) {
          this.logger.error(`Error handling ${message.action}`, error);
        }
        try {
          if (sendResponse && message.action === MessageActions.ACTIVATE_SELECT_ELEMENT_MODE) {
            sendResponse({
              success: false,
              error: await getSelectElementActivationErrorMessage(),
              errorType: ErrorTypes.SELECT_ELEMENT,
            });
          } else if (sendResponse) {
            sendResponse({ success: false, error: error.message });
          }
        } catch (e) {
          this.logger.error(`Failed to send error response for ${message.action}:`, e);
        }
        return true; // Error was handled
      }
    }
    // logger.trace(`No handler for action: ${message.action}`);
    return false; // Message not handled
  }

  async handleActivateSelectElementMode(message) {
    return this._handleActivateSelectElementMode(message);
  }

  async _handleActivateSelectElementMode(message) {
    this.logger.info("ContentMessageHandler: ACTIVATE_SELECT_ELEMENT_MODE received!");

    try {
      // 1. Explicitly check if allowed NOW (in case settings changed after load)
      const { ExclusionChecker } = await import('@/features/exclusion/core/ExclusionChecker.js');
      const exclusionChecker = ExclusionChecker.getInstance();
      const isAllowed = await exclusionChecker.isFeatureAllowed('selectElement');
      
      if (!isAllowed) {
        this.logger.debug('Select Element mode activation blocked by page exclusion or settings');
        return { success: false, error: 'Feature blocked on this page' };
      }

      // 2. If SelectElementManager is not available, try to load the feature on-demand
      if (!this.selectElementManager) {
        try {
          // Import and load the selectElement feature directly
          const { loadFeature } = await import('@/core/content-scripts/chunks/lazy-features.js');
          const selectElementHandler = await loadFeature('selectElement');

          if (selectElementHandler) {
            this.setSelectElementManager(selectElementHandler);
          } else {
            // This happens if the feature is blocked by exclusion (returns null)
            this.logger.debug('Select Element mode activation blocked by page exclusion or settings');
            return { success: false, error: 'Feature blocked on this page' };
          }
        } catch (loadError) {
          this.logger.info('Failed to load SelectElement feature on-demand:', loadError);
          return { success: false, error: 'Feature failed to load' };
        }
      }

      return await this._enqueueSelectElementLifecycle(async ({ activate }) => {
        const requestedEpoch = message?.data?.activationEpoch;
        // P9: epoch-less activation cannot supersede strict epoch-owned session
        if (!isSelectElementEpoch(requestedEpoch) && this.acceptedSelectElementEpoch !== null) {
          return {
            success: false,
            activated: getSelectElementActiveState(this.selectElementManager),
            staleEpoch: true,
          };
        }
        const epochAdmission = this._admitSelectElementEpoch(requestedEpoch);
        if (!epochAdmission.accepted) {
          return {
            success: false,
            activated: getSelectElementActiveState(this.selectElementManager),
            staleEpoch: true,
          };
        }

        const requestedGeneration = message?.data?.activationGeneration;
        if (
          isSelectElementGeneration(requestedGeneration)
          && this.invalidatedSelectElementEpoch === this.acceptedSelectElementEpoch
          && this.invalidatedSelectElementGeneration !== null
          && requestedGeneration <= this.invalidatedSelectElementGeneration
        ) {
          return {
            success: false,
            activated: getSelectElementActiveState(this.selectElementManager),
            staleGeneration: true,
          };
        }
        if (
          isSelectElementGeneration(requestedGeneration)
          && this.acceptedSelectElementGeneration !== null
          && requestedGeneration < this.acceptedSelectElementGeneration
        ) {
          return {
            success: false,
            activated: getSelectElementActiveState(this.selectElementManager),
            staleGeneration: true,
          };
        }

        // Initialize if not already initialized
        if (!this.selectElementManager.isInitialized) {
          await this.selectElementManager.initialize();
        }

        // Activate Select Element mode
        const result = await activate(message.data || {});
        this.logger.info("SelectElementManager activation process completed");

        const activated = result?.isActive === true || result === true;
        if (
          activated
          && isSelectElementGeneration(requestedGeneration)
          && (
            this.acceptedSelectElementGeneration === null
            || requestedGeneration >= this.acceptedSelectElementGeneration
          )
        ) {
          this.acceptedSelectElementGeneration = requestedGeneration;
        }

        // Return success result
        const response = {
          success: activated,
          activated,
          managerId: result?.instanceId,
        };
        if (
          activated
          && isSelectElementGeneration(requestedGeneration)
          && requestedGeneration === this.acceptedSelectElementGeneration
        ) {
          response.activationGeneration = requestedGeneration;
          if (isSelectElementEpoch(requestedEpoch)) {
            response.activationEpoch = this.acceptedSelectElementEpoch;
          }
        }
        return response;
      });
      
    } catch (error) {
      this.logger.warn("ContentMessageHandler: SelectElement activation failed:", error);
      
      const errorInfo = {
        message: await getSelectElementActivationErrorMessage(),
        type: ErrorTypes.SELECT_ELEMENT,
      };

      // Log as debug for internal tracking (silence red log)
      this.logger.debug("Error details for SelectElement activation:", { error, errorInfo });
      
      return { 
        success: false, 
        error: errorInfo.message, 
        activated: false,
        errorType: errorInfo.type
      };
    }
  }

  async handleDeactivateSelectElementMode(message) {
    return this._enqueueSelectElementLifecycle(
      lifecycle => this._handleDeactivateSelectElementMode(message, lifecycle),
    );
  }

  async _handleDeactivateSelectElementMode(message, lifecycle) {
    if (this.selectElementManager) {
      const requestedEpoch = message?.data?.activationEpoch;
      const currentGenerationBefore = this.acceptedSelectElementGeneration;
      if (!isSelectElementEpoch(requestedEpoch) && this.acceptedSelectElementEpoch !== null && currentGenerationBefore !== null && getSelectElementActiveState(this.selectElementManager)) {
        return {
          success: false,
          cleanupCompleted: false,
          activated: getSelectElementActiveState(this.selectElementManager),
          staleEpoch: true,
        };
      }
      if (isSelectElementEpoch(requestedEpoch)) {
        if (
          this.acceptedSelectElementEpoch !== null
          && requestedEpoch !== this.acceptedSelectElementEpoch
        ) {
          return {
            success: false,
            cleanupCompleted: false,
            activated: getSelectElementActiveState(this.selectElementManager),
            staleEpoch: true,
          };
        }
        this.acceptedSelectElementEpoch = requestedEpoch;
      }

      const requestedGeneration = message?.data?.activationGeneration;
      const currentGeneration = this.acceptedSelectElementGeneration;
      if (isSelectElementGeneration(requestedGeneration)) {
        this.invalidatedSelectElementEpoch = this.acceptedSelectElementEpoch;
        this.invalidatedSelectElementGeneration = Math.max(
          this.invalidatedSelectElementGeneration || 0,
          requestedGeneration,
        );
      }
      if (
        currentGeneration !== null
        && (
          !isSelectElementGeneration(requestedGeneration)
          || requestedGeneration !== currentGeneration
        )
      ) {
        return {
          success: false,
          cleanupCompleted: false,
          activated: getSelectElementActiveState(this.selectElementManager),
          staleGeneration: true,
        };
      }

      // Check if this is from background (to avoid circular messaging)
      const fromBackground = message?.data?.fromBackground;
            
      // Check if this is an explicit deactivation request
      const isExplicitDeactivation = message?.data?.isExplicitDeactivation;

      // Only process deactivation if it's explicit or from non-background sources
      if (fromBackground && !isExplicitDeactivation) {
        return { success: true, activated: getSelectElementActiveState(this.selectElementManager) };
      }

      this.logger.info('DEACTIVATE_SELECT_ELEMENT_MODE received');

      try {
        // Deactivate the manager directly
        const result = await lifecycle.deactivate({ fromBackground });

        if (result?.success === true && result?.cleanupCompleted === true) {
          if (
            !isSelectElementGeneration(requestedGeneration)
            || this.acceptedSelectElementGeneration === requestedGeneration
          ) {
            this.acceptedSelectElementGeneration = null;
          }
          return {
            success: true,
            cleanupCompleted: true,
            activated: false,
            ...(isSelectElementGeneration(requestedGeneration)
              ? { activationGeneration: requestedGeneration }
              : {}),
          };
        }

        return {
          success: false,
          cleanupCompleted: false,
          activated: false,
          error: result?.error || 'Could not deactivate Select Element mode.',
        };
      } catch (error) {
        this.logger.warn("ContentMessageHandler: selectElementManager deactivation failed:", error);
        return {
          success: false,
          cleanupCompleted: false,
          activated: false,
          error: 'Could not deactivate Select Element mode.',
        };
      }
    } else {
      return {
        success: false,
        cleanupCompleted: false,
        activated: false,
        error: 'Select Element manager unavailable',
      };
    }
  }

  async handleGetSelectElementFrameState() {
    // P1: read-only, no epoch adoption, no manager mutation
    const active = getSelectElementActiveState(this.selectElementManager);
    return {
      active,
      activationEpoch: this.acceptedSelectElementEpoch,
      activationGeneration: this.acceptedSelectElementGeneration,
      hasManager: !!this.selectElementManager,
    };
  }

  async handleStartScreenCapture(message) {
    this.logger.info("ContentMessageHandler: START_SCREEN_CAPTURE received!");

    try {
      if (!this.screenCaptureManager) {
        const { loadFeature } = await import('@/core/content-scripts/chunks/lazy-features.js');
        const screenCaptureHandler = await loadFeature('screenCapture');
        if (screenCaptureHandler) {
          this.setScreenCaptureManager(screenCaptureHandler);
        } else {
          return { success: false, error: 'Screen capture feature blocked or failed to load' };
        }
      }

      return await this.screenCaptureManager.handleStartScreenCapture(message);
    } catch (error) {
      this.logger.error("Screen capture start failed:", error);
      return { success: false, error: error.message };
    }
  }

  async handleScreenCaptureResult(message) {
    this.logger.info("ContentMessageHandler: SCREEN_CAPTURE_OCR_RESULT received!");

    try {
      // Lazy load the coordinator
      const { screenCaptureCoordinator } = await import('@/features/screen-capture/services/ScreenCaptureCoordinator.js');
      await screenCaptureCoordinator.handleResult(message.data);
    } catch (error) {
      this.logger.error("Failed to handle capture result via coordinator:", error);
    }

    return { success: true };
  }

  async handleStreamUpdate(message) {
    // Delegate to ContentScriptIntegration's streaming handler
    try {
      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      return contentScriptIntegration.streamingHandler.handleMessage(message);
    } catch (error) {
      this.logger.error('Failed to delegate stream update to ContentScriptIntegration:', error);
      return false;
    }
  }

  async handleStreamEnd(message) {
    // Delegate to ContentScriptIntegration's streaming handler
    try {
      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      return contentScriptIntegration.streamingHandler.handleMessage(message);
    } catch (error) {
      this.logger.error('Failed to delegate stream end to ContentScriptIntegration:', error);
      return false;
    }
  }

  async handleTranslationResult(message) {
    const { translationMode, translatedText, originalText, options, success, error, errorDetails } = message.data;
    const toastId = options?.toastId;
    this.logger.info(`Handling translation result for mode: ${translationMode}`, {
      success,
      translatedTextLength: translatedText?.length,
      originalTextLength: originalText?.length,
      hasToastId: !!toastId,
      hasError: !!error
    });

    switch (translationMode) {
      case TranslationMode.Select_Element:
      case TranslationMode.LEGACY_SELECT_ELEMENT: // Handle both enum and legacy string for robustness
        this.logger.info('Forwarding to StreamingHandler via ContentScriptIntegration');
        try {
          const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
          return contentScriptIntegration.streamingHandler.handleMessage(message);
        } catch (error) {
          this.logger.error('Failed to delegate translation result to ContentScriptIntegration:', error);
          return false;
        }

      case TranslationMode.Field:
      case TranslationMode.LEGACY_FIELD: // Handle both enum and legacy string for robustness
      {
        this.logger.info('Processing Text Field translation result');
        
        // Check if translation failed at background level
      const failureSource = isStructuredTranslationError(errorDetails) ? errorDetails : error;
      if (success === false && failureSource) {
          // logger.trace('Text Field translation failed in background, handling error');
          
          // Dismiss status notification if exists
          if (toastId) {
            pageEventBus.emit('dismiss_notification', { id: toastId });
          }
          // Also clear any globally stored toast ID
          if (window.pendingTranslationToastId) {
            pageEventBus.emit('dismiss_notification', { id: window.pendingTranslationToastId });
            window.pendingTranslationToastId = null;
          }
          
          const presentation = await getFieldTranslationErrorPresentation(failureSource);
          if (presentation) {
            await this.errorHandler.handle(presentation.displayError, {
              context: 'text-field-translation',
              type: presentation.canonicalType || presentation.displayError.type,
              showToast: true
            });

            presentation.displayError.alreadyHandled = true;
            throw presentation.displayError;
          }

          // Preserve silent cancellation/context control flow without presenting.
          const translationError = reconstructTranslationError(failureSource);
          translationError.alreadyHandled = true;
          throw translationError;
        }
        
        // If success or no explicit error, proceed with normal flow
        this.logger.info('Forwarding result to applyTranslationToTextField');
        try {
          return await applyTranslationToTextField(translatedText, originalText, translationMode, toastId, message.messageId);
        } catch (error) {
          // Don't handle errors that are already handled
          if (error.alreadyHandled) {
            throw error;
          }
          
          // Only log if error is not already handled
          this.logger.error('Field translation failed during application:', error);
          
          // Use centralized error handling system
          const errorInfo = await this.errorHandler.getErrorForUI(error, 'text-field-application');
          
          await this.errorHandler.handle(error, {
            context: 'text-field-application',
            type: errorInfo.type,
            showToast: true
          });
          
          error.alreadyHandled = true;
          throw error;
        }
      }

      case TranslationMode.Selection:
      case TranslationMode.Dictionary_Translation:
      case TranslationMode.ScreenCapture:
        this.logger.info(`Forwarding result for ${translationMode} mode to WindowsManager`);
        if (window.windowsManagerInstance && window.windowsManagerInstance.translationHandler) {
          return window.windowsManagerInstance.translationHandler.handleTranslationResult(message);
        }
        return true;

      case TranslationMode.Page:
        // Page translation results are handled directly by PageTranslationBatcher
        // as a direct response to the batch message. We ignore broadcasts here.
        this.logger.debug('Ignoring broadcasted page translation result (already handled by Batcher)');
        return true;

      default:
        this.logger.warn(`No handler for translation result mode: ${translationMode}`);
        return false;
    }
  }

  async handleRevertTranslation() {
    this.logger.info('Handling revert translation request');

    try {
      // Use the existing revertHandler to execute revert
      const result = await revertHandler.executeRevert();
      this.logger.info('Revert completed successfully');
      return result;
    } catch (error) {
      this.logger.error('Revert failed:', error);
      return { success: false, error: error.message };
    }
  }

  async handleIFrameGetFrameInfo(/* data */) {
    this.logger.info('IFrame get frame info request');
    if (this.iFrameManager) {
      return { 
        success: true, 
        frameInfo: this.iFrameManager.getFrameInfo() 
      };
    }
    return { success: false, error: 'IFrameManager not available' };
  }

  async handleIFrameCoordinateOperation() {
    this.logger.info('IFrame coordinate operation request (Select Element removed)');
    return { success: false, error: 'Unsupported operation or manager not available' };
  }

  async handleIFrameDetectTextFields(/* data */) {
    this.logger.info('IFrame detect text fields request');
    // Basic text field detection
    const textFields = document.querySelectorAll('input[type="text"], textarea, input[type="email"], input[type="url"], input[type="search"]');
    const fieldInfo = Array.from(textFields).map(field => ({
      id: field.id || null,
      tagName: field.tagName,
      type: field.type || null,
      placeholder: field.placeholder || null,
      visible: field.offsetWidth > 0 && field.offsetHeight > 0
    }));
    return { success: true, textFields: fieldInfo };
  }

  async handleIFrameInsertText(data) {
    this.logger.info('IFrame insert text request');
    const { targetSelector, text } = data;
    try {
      const element = document.querySelector(targetSelector);
      if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
      }
      return { success: false, error: 'Target element not found or not editable' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async handleIFrameSyncRequest(/* data */) {
    this.logger.info('IFrame sync request');
    if (this.iFrameManager) {
      // Handle synchronization requests
      return { success: true, response: 'sync-acknowledged' };
    }
    return { success: false, error: 'IFrameManager not available' };
  }

  async handleIFrameSyncResponse(/* data */) {
    this.logger.info('IFrame sync response');
    // Handle sync response - could be used for coordination
    return { success: true };
  }

  async handlePageTranslate(message) {
    this.logger.info('Page translation request received');

    // Check for cancel flag
    if (message.data?.cancel) {
      if (this.pageTranslationManager) {
        this.pageTranslationManager.cancelTranslation();
        return { success: true, cancelled: true };
      }
      return { success: false, error: 'PageTranslationManager not available' };
    }

    try {
      // Ensure Vue app is loaded so mobileStore can track translation state
      if (window.translateItContentCore && !window.translateItContentCore.vueLoaded) {
        try {
          this.logger.debug('Loading Vue app for page translation state tracking...');
          // Only load Vue app if the method exists (Main frame only)
        if (typeof window.translateItContentCore?.loadVueApp === 'function') {
          await window.translateItContentCore.loadVueApp();
        } else if (process.env.NODE_ENV === 'development') {
          this.logger.debug('Skipping loadVueApp in this context (likely iframe)');
        }
          this.logger.info('Vue app loaded for page translation state tracking');
        } catch (vueError) {
          this.logger.warn('Failed to load Vue app, translation will continue without UI state sync:', vueError);
        }
      } else if (window.translateItContentCore && window.translateItContentCore.vueLoaded) {
        this.logger.debug('Vue app already loaded, ready for state tracking');
      } else {
        this.logger.warn('translateItContentCore not available, UI state sync may not work');
      }

      // Reacquire inactive instances so commands share the current navigation owner.
      if (!this.pageTranslationManager?.isActive) {
        try {
          const { loadFeature } = await import('@/core/content-scripts/chunks/lazy-features.js');
          const manager = await loadFeature('pageTranslation');

          if (manager) {
            this.setPageTranslationManager(manager);
          } else {
            throw new Error('pageTranslation feature failed to load');
          }
        } catch (loadError) {
          throw new Error(`PageTranslationManager not available: ${loadError.message}`);
        }
      }

      // Ensure manager is initialized
      let managerReady = this.pageTranslationManager.isActive;
      if (!managerReady) {
        managerReady = (await this.pageTranslationManager.activate()) === true;
      }

      if (managerReady) {
        this._ensureChildFrameRetirementListener();
      }

      // Execute page translation - PASS message.data to support options like { isAuto: true }
      const result = await this.pageTranslationManager.translatePage(message.data || {});

      // Log appropriate message based on whether this is auto-translation (async) or immediate completion
      if (result.isAutoTranslating) {
        this.logger.info('Page translation started (auto-translate mode)', {
          messageId: result.messageId,
          url: result.url
        });
      } else if (result.translatedCount !== undefined || result.totalNodes !== undefined) {
        this.logger.info('Page translation completed', {
          translatedCount: result.translatedCount,
          totalNodes: result.totalNodes
        });
      } else {
        this.logger.info('Page translation initiated', {
          messageId: result.messageId,
          url: result.url
        });
      }

      return result;

    } catch (error) {
      this.logger.error('Page translation failed:', error);

      // Use centralized error handling system
      const displayError = await getPageTranslationErrorPresentation({ error, errorType: error.type });
      const errorInfo = await this.errorHandler.getErrorForUI(displayError || error, 'page-translation');

      await this.errorHandler.handle(displayError || error, {
        type: errorInfo.type,
        context: 'page-translation',
        showToast: true
      });

      return {
        success: false,
        error: errorInfo.message,
        errorType: errorInfo.type,
        errorDetails: MessageFormat.serializeTranslationError(error),
      };
    }
  }

  async handlePageRestore() {
    this.logger.info('Page restore request received');

    if (!this.pageTranslationManager) {
      return { success: false, error: 'PageTranslationManager not available' };
    }

    try {
      const result = await this.pageTranslationManager.restorePage({ manual: true });

      this.logger.info('Page restore completed', {
        restoredCount: result.restoredCount
      });

      return result;

    } catch (error) {
      this.logger.error('Page restore failed:', error);

      // Use centralized error handling system
      const errorInfo = await this.errorHandler.getErrorForUI(error, 'page-restore');

      await this.errorHandler.handle(error, {
        type: errorInfo.type,
        context: 'page-restore',
        showToast: true
      });

      return { success: false, error: errorInfo.message, errorType: errorInfo.type };
    }
  }

  async handlePageGetStatus() {
    this.logger.debug('Page translation status request received');

    // 1. PRIORITY: If we are in the top frame, use the aggregated status from index-main
    if (window === window.top && typeof window.getGlobalPageTranslationStatus === 'function') {
      const status = window.getGlobalPageTranslationStatus();
      return { ...status, isAggregated: true };
    }

    // 2. FALLBACK: Use local manager status (for iframes or if aggregator is missing)
    if (!this.pageTranslationManager) {
      try {
        const { loadFeature } = await import('@/core/content-scripts/chunks/lazy-features.js');
        const manager = await loadFeature('pageTranslation');
        if (manager) this.setPageTranslationManager(manager);
      } catch { /* ignore and return inactive status */ }
    }

    if (!this.pageTranslationManager) {
      return { 
        success: true, 
        isActive: false, 
        isTranslating: false, 
        isTranslated: false,
        isAutoTranslating: false
      };
    }

    return {
      success: true,
      ...this.pageTranslationManager.getStatus()
    };
  }

  async handlePageStopAuto() {
    this.logger.info('Page stop auto-translation request received');

    if (!this.pageTranslationManager) {
      return { success: false, error: 'PageTranslationManager not available' };
    }

    try {
      const result = await this.pageTranslationManager.stopAutoTranslation();
      return result;
    } catch (error) {
      this.logger.error('Page stop auto failed:', error);
      return { success: false, error: error.message };
    }
  }

  async handlePageTranslationLifecycle(message) {
    if (window !== window.top) {
      return { success: false, error: 'Page lifecycle relay requires top frame' };
    }

    const coordinator = window.translateItContentCore?.mainFrameCoordinator;
    if (!coordinator?.handleTrustedPageLifecycle) {
      return { success: false, error: 'Main frame coordinator unavailable' };
    }

    return coordinator.handleTrustedPageLifecycle(message.data || {});
  }

  /**
   * Accept a transcript envelope (translated or original/source) into the
   * plain-JS store. No extra notification mechanism: the store's own
   * subscription drives the renderer, and no transcript text is logged.
   */
  handleLiveDubbingStatus(message) {
    const envelope = sanitizeLiveDubbingTranscriptEnvelope(message?.data);
    const acceptedEnvelope = envelope ? acceptLiveDubbingTranscript(envelope) : null;
    const accepted = acceptedEnvelope !== null;
    return { success: true, accepted };
  }

  /** Kind-agnostic clear: one path resets both transcript buffers. */
  handleLiveDubbingClear(message) {
    clearLiveDubbingTranscript(message?.data?.sessionId);
    return { success: true };
  }

  async cleanup() {
    if (this._externalMessageHandler && this._registeredActions.size > 0) {
      for (const action of Array.from(this._registeredActions)) {
        try {
          if (typeof this._externalMessageHandler.unregisterHandler === 'function') {
            this._externalMessageHandler.unregisterHandler(action);
          }
        } catch { /* ignore */ }
      }
      this._registeredActions.clear();
    }
    this.handlers.clear();
    this.selectElementManager = null;
    this.iFrameManager = null;
    this.pageTranslationManager = null;
    this.childFrameRetirementListenerInstalled = false;
    this._handlersPrepared = false;
    this._externallyRegistered = false;
    this._externalMessageHandler = null;
    this.isActive = false;
    this.initialized = false;

    // Use ResourceTracker cleanup for automatic resource management
    super.cleanup();

    // logger.trace('ContentMessageHandler cleanup completed');
  }

  // Static method to get singleton instance
  static getInstance(options = {}) {
    if (!contentMessageHandlerInstance) {
      contentMessageHandlerInstance = new ContentMessageHandler(options);
    }
    return contentMessageHandlerInstance;
  }

  // Method to reset singleton (for testing or cleanup)
  static resetInstance() {
    if (contentMessageHandlerInstance) {
      contentMessageHandlerInstance.cleanup();
      contentMessageHandlerInstance = null;
    }
  }

  // Static cleanup method for global reset
  static cleanupAll() {
    ContentMessageHandler.resetInstance();
  }
}

// Export default instance for backward compatibility
// Note: This uses the same singleton instance as getInstance()
export const contentMessageHandler = new Proxy({}, {
  get: function(target, prop) {
    const instance = ContentMessageHandler.getInstance();
    return instance[prop];
  },
  set: function(target, prop, value) {
    const instance = ContentMessageHandler.getInstance();
    instance[prop] = value;
    return true;
  }
});

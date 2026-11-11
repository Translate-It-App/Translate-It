// src/background/handlers/element-selection/handleActivateSelectElementMode.js
import browser from 'webextension-polyfill';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { MessageFormat, MessagingContexts } from '@/shared/messaging/core/MessagingCore.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import {
  completeActivationAttempt,
  compensateInvalidatedActivationAttempts,
  createActivationGeneration,
  getActivationEpoch,
  getActivationAttemptToken,
  getActiveSessionRevision,
  getCurrentGeneration,
  getStateForTab,
  invalidateOlderActivationAttempts,
  invalidateRetainedSessionRecovery,
  isActivationAttemptCurrent,
  isDeactivationPending,
  isRetainedSessionRecoveryCurrent,
  isStructurallyNonInjectableFrame,
  recordActivationAttemptFrames,
  retainCompatibilityFrames,
  registerParticipant,
  setStateForTab,
  settleActivationAttemptFrame,
} from './selectElementStateManager.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';
import { getSelectElementActivationErrorMessage } from '../utils/activationError.js';

const logger = getScopedLogger(LOG_COMPONENTS.ELEMENT_SELECTION, 'handleActivateSelectElementMode');

const errorHandler = new ErrorHandler();

// Unlike broad extension-context failures, these messages prove no target
// content receiver existed, so this dispatch cannot have activated the frame.
function isProvenNoSelectElementReceiver(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('receiving end does not exist')
    || message.includes('no receiving end')
    || message.includes('no receiver');
}

/**
 * Handles the 'activateSelectElementMode' message action.
 * This activates element selection mode in each reachable frame of a specific tab.
 * @param {Object} message - The message object.
 * @param {Object} sender - The sender object.
 * @param {Object} internalOptions - Optional in-memory recovery ownership checks; never sent to content.
 * @returns {Promise<Object>} - Promise that resolves with the response object.
 */
export async function handleActivateSelectElementMode(message, sender, internalOptions = {}) {
  const recoveryToken = Number.isInteger(internalOptions?.recoveryToken) ? internalOptions.recoveryToken : null;
  const expectedRevision = internalOptions?.expectedRevision;
  const expectedGeneration = internalOptions?.expectedGeneration;
  const isRecoveryActivation = recoveryToken !== null;

  const isRecoveryValidForTab = (tabId, ownActivationAttemptToken = null) => {
    if (!isRecoveryActivation) return true;
    if (!isRetainedSessionRecoveryCurrent(tabId, recoveryToken)) return false;
    if (getStateForTab(tabId).active !== false) return false;
    if (Number.isInteger(expectedRevision) && getActiveSessionRevision(tabId) !== expectedRevision) return false;
    if (ownActivationAttemptToken === null
      && expectedGeneration !== undefined
      && getCurrentGeneration(tabId) !== expectedGeneration) return false;
    const currentAttemptToken = getActivationAttemptToken(tabId);
    if (currentAttemptToken != null && currentAttemptToken !== ownActivationAttemptToken) return false;
    if (isDeactivationPending(tabId)) return false;
    return true;
  };

  logger.debug('Starting activation handler:', {
    messageData: message.data,
    senderTab: sender?.tab?.id,
    senderUrl: sender?.url
  });
  
  try {
    const { tabId } = message.data || {};
    let targetTabId = tabId || sender.tab?.id;
    
    // If no tabId available (e.g., from sidepanel), get current active tab
    if (!targetTabId) {
      logger.debug('No tab ID from sender, finding active tab...');
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) {
        targetTabId = tabs[0].id;
        logger.debug(`Found active tab: ${targetTabId}`);
      }
    }
    
    if (!targetTabId) {
      throw new Error('Could not determine target tab for element selection');
    }

    // Route every authoritative inactive request through the cleanup barrier.
    let isActivating;
    let modeForContentScript = 'normal';

    logger.debug(`Message data: ${JSON.stringify(message, null, 2)}`);

    if (typeof message.data === 'boolean') {
      isActivating = message.data;
      modeForContentScript = isActivating ? 'select' : 'normal';
    } else if (message.data && typeof message.data.active === 'boolean') {
      isActivating = message.data.active;
      modeForContentScript = isActivating ? 'select' : 'normal';
    } else if (typeof message === 'object' && message.action === MessageActions.ACTIVATE_SELECT_ELEMENT_MODE) {
      isActivating = true;
      modeForContentScript = 'select';
    } else if (typeof message === 'object' && message.action === MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE) {
      isActivating = false;
    } else {
      isActivating = false;
    }

    if (!isActivating) {
      const deactivationMessage = {
        ...message,
        data: {
          ...(message.data && typeof message.data === 'object' ? message.data : {}),
          tabId: targetTabId,
        },
      };
      const deactivationResult = await handleDeactivateSelectElementMode(deactivationMessage, sender);
      return {
        ...deactivationResult,
        activated: deactivationResult.success === true
          ? false
          : deactivationResult.activated ?? false,
      };
    }

    if (!isRecoveryActivation) {
      invalidateRetainedSessionRecovery(targetTabId);
    } else if (!isRecoveryValidForTab(targetTabId)) {
      return {
        success: false,
        message: 'Select Element recovery superseded',
        tabId: targetTabId,
        activated: false,
      };
    }

    // Check tab permissions before proceeding
    logger.debug('Checking tab access for:', targetTabId);
    const access = await tabPermissionChecker.checkTabAccess(targetTabId);
    if (isRecoveryActivation && !isRecoveryValidForTab(targetTabId)) {
      return {
        success: false,
        message: 'Select Element recovery superseded',
        tabId: targetTabId,
        activated: false,
      };
    }
    logger.debug('Tab access result:', access);
    if (!access.isAccessible) {
      logger.debug(`Attempted to activate on restricted tab ${targetTabId}: ${access.errorMessage}`);
      return {
        success: false,
        message: access.errorMessage,
        tabId: targetTabId,
        activated: false,
        isRestrictedPage: true,
        tabUrl: access.fullUrl,
      };
    }
    
    if (isDeactivationPending(targetTabId)) {
      logger.debug('Deactivation pending, attempting cleanup before fresh activation for tab', targetTabId);
      const cleanupResult = await handleDeactivateSelectElementMode({ data: { tabId: targetTabId } }, sender);
      if (!cleanupResult.success) {
        return {
          success: false,
          message: 'Select Element previous session cleanup pending',
          tabId: targetTabId,
          activated: false,
        };
      }
    }

    if (isRecoveryActivation && !isRecoveryValidForTab(targetTabId)) {
      return {
        success: false,
        message: 'Select Element recovery superseded',
        tabId: targetTabId,
        activated: false,
      };
    }

    const action = MessageActions.ACTIVATE_SELECT_ELEMENT_MODE;
    
    logger.debug(`Sending ${action} to tab ${targetTabId} with mode: ${modeForContentScript}`);
    
    const contentData = typeof message.data === 'object' && message.data !== null
      ? { ...message.data }
      : {};
    delete contentData.activate;
    if (isRecoveryActivation && !isRecoveryValidForTab(targetTabId)) {
      return {
        success: false,
        message: 'Select Element recovery superseded',
        tabId: targetTabId,
        activated: false,
      };
    }
    const activationEpoch = getActivationEpoch();
    const activationGeneration = createActivationGeneration(targetTabId);
    const activationAttemptToken = getActivationAttemptToken(targetTabId);

    try {
      const supersededAttempts = invalidateOlderActivationAttempts(targetTabId, activationGeneration);
      await compensateInvalidatedActivationAttempts(targetTabId, supersededAttempts);
      if (!isActivationAttemptCurrent(targetTabId, activationGeneration, activationAttemptToken)
        || (isRecoveryActivation && !isRecoveryValidForTab(targetTabId, activationAttemptToken))) {
        return {
          success: false,
          message: 'Select Element activation was superseded',
          tabId: targetTabId,
          activated: false,
        };
      }

      const contentMessage = MessageFormat.create(
        action,
        {
          ...contentData,
          mode: modeForContentScript,
          active: isActivating,
          activationEpoch,
          activationGeneration,
        },
        MessagingContexts.CONTENT // Context for content script
      );

      // Send activation explicitly so each reachable frame can establish its own ACK.
      const statusText = 'activated';
      let response;
      const rawFrames = browser.webNavigation?.getAllFrames
        ? await browser.webNavigation.getAllFrames({ tabId: targetTabId }).catch(() => [{ frameId: 0 }])
        : [{ frameId: 0 }];
      const frameDetails = new Map();
      for (const f of Array.isArray(rawFrames) ? rawFrames : []) {
        if (!Number.isInteger(f?.frameId) || f.frameId < 0) continue;
        // A structurally non-injectable frame (for example about:blank) can
        // never host the Select Element content script, so it can never hold
        // Select Element state and can never acknowledge cleanup. Dispatching
        // to it would create permanent provisional cleanup debt and block the
        // next activation. Filter before dispatch and ownership registration.
        if (isStructurallyNonInjectableFrame(f)) continue;
        frameDetails.set(f.frameId, f.documentId && typeof f.documentId === 'string' && f.documentId.trim() ? f.documentId : null);
      }
      if (!frameDetails.has(0)) frameDetails.set(0, null);
      const frameIds = [...frameDetails.keys()];
      if (!isActivationAttemptCurrent(targetTabId, activationGeneration, activationAttemptToken)
        || (isRecoveryActivation && !isRecoveryValidForTab(targetTabId, activationAttemptToken))) {
        return {
          success: false,
          message: 'Select Element activation was superseded',
          tabId: targetTabId,
          activated: false,
        };
      }

      const frameResults = await Promise.all(frameIds.map(async frameId => {
        try {
          const documentId = frameDetails.get(frameId) || null;
          const target = documentId ? { frameId, documentId } : { frameId };
          // Only a dispatched request can leave cleanup ownership behind.
          if (documentId) {
            recordActivationAttemptFrames(targetTabId, activationGeneration, [frameId], new Map([[frameId, documentId]]));
          } else {
            recordActivationAttemptFrames(targetTabId, activationGeneration, [frameId]);
          }
          const frameResponse = await browser.tabs.sendMessage(
            targetTabId,
            contentMessage,
            target
          );
          logger.debug(`Message sent to frame ${frameId} in tab ${targetTabId}, response:`, frameResponse);
          return { frameId, documentId, response: frameResponse };
        } catch (error) {
          if (isProvenNoSelectElementReceiver(error)) {
            settleActivationAttemptFrame(targetTabId, activationGeneration, frameId);
          }
          if (ExtensionContextManager.isContextError(error)) {
            ExtensionContextManager.handleContextError(error, `activate-select-element:tab-${targetTabId}:frame-${frameId}`);
          } else {
            logger.error(`Failed to send activation to frame ${frameId} in tab ${targetTabId}:`, error);
          }
          return { frameId, documentId: frameDetails.get(frameId) || null, error };
        }
      }));

      const hasGenerationEcho = frameResponse => (
        frameResponse
        && typeof frameResponse === 'object'
        && Object.prototype.hasOwnProperty.call(frameResponse, 'activationGeneration')
      );
      const hasEpochEcho = frameResponse => (
        frameResponse
        && typeof frameResponse === 'object'
        && Object.prototype.hasOwnProperty.call(frameResponse, 'activationEpoch')
      );
      const strictResults = frameResults.filter(({ response: frameResponse }) => (
        frameResponse?.success === true
        && frameResponse?.activated === true
        && hasGenerationEcho(frameResponse)
        && hasEpochEcho(frameResponse)
        && frameResponse?.activationGeneration === activationGeneration
        && frameResponse?.activationEpoch === activationEpoch
      ));
      const isCompatibilityResponse = frameResponse => {
        if (frameResponse === true) return true;
        if (frameResponse?.success === true && frameResponse?.activated === true) {
          const hasGen = hasGenerationEcho(frameResponse);
          const hasEpoch = hasEpochEcho(frameResponse);
          if (!hasGen) return true;
          if (hasGen && !hasEpoch && frameResponse.activationGeneration === activationGeneration) return true;
        }
        return false;
      };
      const compatibilityFrameIds = frameResults
        .filter(({ response: frameResponse }) => isCompatibilityResponse(frameResponse))
        .map(({ frameId }) => frameId);
      for (const { frameId, response: frameResponse } of frameResults) {
        if (
          frameResponse === false
          || (frameResponse?.success === false && frameResponse?.activated === false)
        ) {
          settleActivationAttemptFrame(targetTabId, activationGeneration, frameId);
        }
      }

      if (strictResults.length > 0) {
        if (!isActivationAttemptCurrent(targetTabId, activationGeneration, activationAttemptToken)
          || (isRecoveryActivation && !isRecoveryValidForTab(targetTabId, activationAttemptToken))) {
          return {
            success: false,
            message: 'Select Element activation was superseded',
            tabId: targetTabId,
            activated: false,
            response: strictResults[0].response,
          };
        }

        const registeredResults = strictResults.filter(({ frameId, documentId }) => {
          const doc = documentId || frameDetails.get(frameId) || null;
          return doc ? registerParticipant(targetTabId, frameId, activationGeneration, doc) : registerParticipant(targetTabId, frameId, activationGeneration);
        });
        for (const { frameId } of registeredResults) {
          settleActivationAttemptFrame(targetTabId, activationGeneration, frameId);
        }
        if (compatibilityFrameIds.length > 0) {
          retainCompatibilityFrames(targetTabId, activationGeneration, compatibilityFrameIds);
          for (const frameId of compatibilityFrameIds) {
            settleActivationAttemptFrame(targetTabId, activationGeneration, frameId);
          }
        }

        if (registeredResults.length > 0) {
          setStateForTab(targetTabId, true);

          logger.info(`Element selection mode activated in ${registeredResults.length} frame(s) of tab ${targetTabId}`);
        }

        return {
          success: true,
          message: `Element selection mode ${statusText}`,
          tabId: targetTabId,
          activated: true,
          response: strictResults[0].response,
        };
      }

      const compatibilityResult = frameResults.find(({ response: frameResponse }) => isCompatibilityResponse(frameResponse));
      if (compatibilityResult) {
        retainCompatibilityFrames(
          targetTabId,
          activationGeneration,
          compatibilityFrameIds,
        );
        for (const frameId of compatibilityFrameIds) {
          settleActivationAttemptFrame(targetTabId, activationGeneration, frameId);
        }
        logger.info(`Element selection mode ${statusText} in tab ${targetTabId} via compatibility response`);
        return {
          success: true,
          message: `Element selection mode ${statusText}`,
          tabId: targetTabId,
          activated: true,
          response: compatibilityResult.response,
        };
      }

      response = frameResults.find(({ response: frameResponse }) => frameResponse !== undefined)?.response;
      if (response === undefined && frameResults.some(result => result.error)) {
        const safeMessage = await getSelectElementActivationErrorMessage();
        return {
          success: false,
          message: 'Failed to communicate with tab - try refreshing the page',
          tabId: targetTabId,
          activated: false,
          error: safeMessage,
          errorType: ErrorTypes.SELECT_ELEMENT,
          errorDetails: {
            message: safeMessage,
            type: ErrorTypes.SELECT_ELEMENT,
          },
        };
      }
    
      // Check if tab communication actually succeeded
      // Handle different response types from content script
      if (response === false) {
      // A false response means content did not confirm the requested state.
      logger.debug(`Tab ${targetTabId} returned false without confirming Select Element state`, {
        tabId: targetTabId,
        url: access.fullUrl.substring(0, 80) + (access.fullUrl.length > 80 ? '...' : ''),
        isRestrictedByUrl: access.isRestricted,
        isAccessible: access.isAccessible
      });
        return {
          success: false,
          message: 'Content script did not confirm Select Element state',
          tabId: targetTabId,
          activated: false,
          isLegacyResponse: true,
          isRestrictedPage: access.isRestricted,
          tabUrl: access.fullUrl
        };
      }
    
      // Handle structured error response from content script
      if (response && response.success === false && response.error) {
      logger.debug(`Tab ${targetTabId} returned structured error`, {
        tabId: targetTabId,
        error: response.error,
        errorType: response.errorType,
        isCompatibilityIssue: response.isCompatibilityIssue,
        url: access.fullUrl.substring(0, 80) + (access.fullUrl.length > 80 ? '...' : '')
      });
      
      const safeMessage = await getSelectElementActivationErrorMessage();

        return {
          success: false,
          message: safeMessage,
          error: safeMessage,
          tabId: targetTabId,
          activated: false,
          isRestrictedPage: access.isRestricted, // Use actual permission check, not content script's guess
          isCompatibilityIssue: response.isCompatibilityIssue || false,
          errorType: response.errorType || ErrorTypes.SELECT_ELEMENT,
          errorDetails: {
            message: safeMessage,
            type: response.errorType || ErrorTypes.SELECT_ELEMENT,
          },
          tabUrl: access.fullUrl
        };
      }
    
      logger.warn(`Element selection mode communication FAILED for tab ${targetTabId}`, {
        tabId: targetTabId,
        url: access.fullUrl.substring(0, 50) + (access.fullUrl.length > 50 ? '...' : ''),
        response,
        responseType: typeof response
      });

      return {
        success: false,
        message: 'Content script did not confirm Select Element activation',
        tabId: targetTabId,
        activated: false,
        isRestrictedPage: access.isRestricted,
        tabUrl: access.fullUrl,
        response,
      };
    } finally {
      completeActivationAttempt(targetTabId, activationGeneration, activationAttemptToken);
    }
  } catch (error) {
    const isContextError = ExtensionContextManager.isContextError(error);
    if (isContextError) {
      ExtensionContextManager.handleContextError(error, 'handleActivateSelectElementMode');
    } else {
      logger.error('Exception in handleActivateSelectElementMode:', error);
    }
    
    const safeMessage = await getSelectElementActivationErrorMessage();
    const displayError = Object.assign(new Error(safeMessage), {
      type: ErrorTypes.SELECT_ELEMENT,
      cause: error,
    });
    if (!isContextError) {
      errorHandler.handle(displayError, {
        type: ErrorTypes.SELECT_ELEMENT,
        context: 'handleActivateSelectElementMode',
        messageData: message,
      });
    }

    const response = {
      success: false,
      message: safeMessage,
      error: safeMessage,
      errorType: ErrorTypes.SELECT_ELEMENT,
      errorDetails: {
        message: safeMessage,
        type: ErrorTypes.SELECT_ELEMENT,
      },
    };
    logger.debug('Returning error response:', response);
    return response;
  }
}

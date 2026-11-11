import {
  compensateInvalidatedActivationAttempts,
  getCompatibilityFrames,
  getActivationEpoch,
  getParticipants,
  getParticipantsWithDocuments,
  getProvisionalCleanupFrames,
  invalidateActivationAttempts,
  invalidateRetainedSessionRecovery,
  removeCompatibilityFrame,
  removeProvisionalCleanupFrame,
  removeParticipant,
  setStateForTab,
  queryFrameStateWithKind,
  FrameStateKind,
  isFrameDocumentLive,
  isStructurallyNonInjectableFrame,
  isNoReceiverSafeForFrame,
  invalidateJoinAuthority,
  markDeactivationPending,
  clearDeactivationPending,
} from './selectElementStateManager.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import browser from 'webextension-polyfill';
import { MessageFormat, MessagingContexts } from '@/shared/messaging/core/MessagingCore.js';
// import { generateBackgroundMessageId } from '@/utils/messaging/messageId.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.ELEMENT_SELECTION, 'handleDeactivateSelectElementMode');

/**
 * Handle deactivation for every registered frame and publish inactive state only
 * after each participant confirms cleanup or disappears.
 */
export async function handleDeactivateSelectElementMode(message, sender) {
  const tabId = sender?.tab?.id || message?.data?.tabId;

  logger.operation('handleDeactivateSelectElementMode called', {
    tabId,
    from: sender?.tab?.id ? 'content' : 'internal',
  });

  if (!tabId) {
    return { success: false, error: 'No tabId available' };
  }

  invalidateRetainedSessionRecovery(tabId);

  try {
    markDeactivationPending(tabId);
    if (typeof invalidateJoinAuthority === 'function') {
      try { invalidateJoinAuthority(tabId); } catch { /* ignore */ }
    }
    // Invalidate pending activation ACKs before checking participant state.
    const invalidatedAttempts = invalidateActivationAttempts(tabId);
    const participantSnapshot = getParticipants(tabId);
    let participantDetails = participantSnapshot;
    try {
      if (typeof getParticipantsWithDocuments === 'function') {
        const maybe = getParticipantsWithDocuments(tabId);
        if (maybe instanceof Map) participantDetails = maybe;
      }
    } catch {
      participantDetails = participantSnapshot;
    }
    const getStoredDoc = (frameId) => {
      try {
        const v = participantDetails?.get(frameId);
        if (v && typeof v === 'object' && v !== null && 'generation' in v) return v.documentId || null;
      } catch { /* ignore */ }
      return null;
    };
    const compatibilitySnapshot = getCompatibilityFrames(tabId);
    const provisionalSnapshot = getProvisionalCleanupFrames(tabId);
    const participantFrameIds = [...participantSnapshot.entries()];
    let staleGenerationDetected = false;
    const removeSnapshotParticipant = (frameId, generation) => {
      const currentGeneration = getParticipants(tabId).get(frameId);
      if (currentGeneration !== undefined && currentGeneration !== generation) {
        staleGenerationDetected = true;
      }
      return removeParticipant(tabId, frameId, generation);
    };
    const retireMissingParticipant = async (frameId, generation) => {
      const docId = getStoredDoc(frameId);
      const hasDoc = typeof docId === 'string' && docId.trim().length > 0;
      try {
        let live;
        if (typeof isFrameDocumentLive === 'function') {
          live = hasDoc ? await isFrameDocumentLive(tabId, frameId, docId) : await isFrameDocumentLive(tabId, frameId, null);
        } else {
          const frames = await browser.webNavigation.getAllFrames({ tabId });
          live = Array.isArray(frames) && frames.some(frame => frame?.frameId === frameId);
        }
        if (!live) {
          removeSnapshotParticipant(frameId, generation);
        }
      } catch {
        // Keep participant when frame existence cannot be confirmed.
      }
    };
    const isFrameLive = async (frameId, documentId = null) => {
      try {
        if (typeof isFrameDocumentLive === 'function') {
          return await isFrameDocumentLive(tabId, frameId, documentId);
        }
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        const hasDoc = typeof documentId === 'string' && documentId.trim().length > 0;
        if (hasDoc) {
          return Array.isArray(frames) && frames.some(f => f?.frameId === frameId && f?.documentId === documentId);
        }
        return Array.isArray(frames) && frames.some(frame => frame?.frameId === frameId);
      } catch {
        return true;
      }
    };

    // P1: if no reliable ownership, discover retained active Content via frame-state query
    const hasOwnedState = participantSnapshot.size > 0 || compatibilitySnapshot.size > 0 || provisionalSnapshot.length > 0 || invalidatedAttempts.length > 0;
    if (!hasOwnedState) {
      const discovered = await discoverAndCleanupRetainedFrames(tabId);
      if (discovered.status === 'unknown' || !discovered.fullyCleaned) {
        return { success: false, error: 'Could not deactivate Select Element mode.' };
      }
      setStateForTab(tabId, false);
      clearDeactivationPending(tabId);
      return { success: true, tabId, active: false };
    }

    const participantCleanup = Promise.all(participantFrameIds.map(async ([frameId, generation]) => {
      let response;
      const documentId = getStoredDoc(frameId);
      const hasDoc = typeof documentId === 'string' && documentId.trim().length > 0;
      const target = hasDoc ? { frameId, documentId } : { frameId };
      const deactivationMessage = MessageFormat.create(
          MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
          {
            mode: 'normal',
            active: false,
            fromBackground: true,
            activationEpoch: getActivationEpoch(),
            activationGeneration: generation,
            // Mark this as an explicit deactivation request
            isExplicitDeactivation: true
        },
        MessagingContexts.CONTENT
      );

      try {
        response = await browser.tabs.sendMessage(
          tabId,
          deactivationMessage,
          target
        );

        if (
          response?.success === true
          && response?.cleanupCompleted === true
          && response?.activated === false
        ) {
          removeSnapshotParticipant(frameId, generation);
        }
      } catch (error) {
        logger.warn('Failed to deactivate Select Element frame:', { tabId, frameId, error });
      }

      if (!(
        response?.success === true
        && response?.cleanupCompleted === true
        && response?.activated === false
      )) {
        await retireMissingParticipant(frameId, generation);
      }
    }));
    const compatibilityCleanup = Promise.all([...compatibilitySnapshot.entries()].map(async ([frameId, generation]) => {
      let response;
      try {
        response = await browser.tabs.sendMessage(
          tabId,
          MessageFormat.create(
            MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
            {
              mode: 'normal',
              active: false,
              fromBackground: true,
              ...(Number.isInteger(generation) ? { activationGeneration: generation } : {}),
              isExplicitDeactivation: true,
            },
            MessagingContexts.CONTENT,
          ),
          { frameId },
        );
      } catch (error) {
        logger.warn('Failed to deactivate compatibility Select Element frame:', { tabId, frameId, error });
      }

      if (
        response?.success === true
        && response?.cleanupCompleted === true
        && response?.activated === false
      ) {
        removeCompatibilityFrame(tabId, frameId);
      } else if (!(await isFrameLive(frameId))) {
        removeCompatibilityFrame(tabId, frameId);
      }
    }));
    const provisionalAttempts = [
      ...invalidatedAttempts,
      ...provisionalSnapshot.map(({ frameId, generation, documentId }) => {
        if (typeof documentId === 'string' && documentId.trim().length > 0) {
          return { generation, frameIds: [frameId], documentIds: new Map([[frameId, documentId]]) };
        }
        return { generation, frameIds: [frameId] };
      }),
    ];
    const [compensationResults] = await Promise.all([
      compensateInvalidatedActivationAttempts(tabId, provisionalAttempts),
      participantCleanup,
      compatibilityCleanup,
    ]);

    for (const result of compensationResults) {
      if (!result.settled && await isFrameLive(result.frameId, result.documentId)) {
        return {
          success: false,
          error: 'Could not deactivate Select Element mode.',
        };
      }
      if (!result.settled) {
        removeProvisionalCleanupFrame(tabId, result.frameId, result.generation);
      }
    }

    if (staleGenerationDetected) {
      return {
        success: false,
        error: 'Could not deactivate Select Element mode.',
      };
    }

    if (
      getParticipants(tabId).size > 0
      || getCompatibilityFrames(tabId).size > 0
      || getProvisionalCleanupFrames(tabId).length > 0
    ) {
      return {
        success: false,
        error: 'Could not deactivate Select Element mode.',
      };
    }

    setStateForTab(tabId, false);
    clearDeactivationPending(tabId);
    return { success: true, tabId, active: false };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

async function discoverAndCleanupRetainedFrames(tabId) {
  if (!browser.webNavigation?.getAllFrames || !browser.tabs?.sendMessage) {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false };
  }
  let frames = [];
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId });
  } catch {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false };
  }
  if (!Array.isArray(frames)) {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false };
  }
  if (frames.length === 0) return { status: 'known', discoveredCount: 0, fullyCleaned: true };
  const activeFrames = [];
  let hasUnknownLive = false;
  let discoveredCount = 0;
  for (const frame of frames) {
    const frameId = frame?.frameId;
    const documentId = frame?.documentId || null;
    if (!Number.isInteger(frameId) || frameId < 0) continue;
    discoveredCount += 1;
    if (isStructurallyNonInjectableFrame(frame)) continue;
    let kind = 'UNKNOWN';
    let state = null;
    let reason = 'transient';
    try {
      const res = await queryFrameStateWithKind(tabId, frameId, documentId);
      kind = res.kind;
      state = res.state;
      reason = res.reason || (kind === FrameStateKind.UNKNOWN ? 'transient' : null);
    } catch {
      kind = FrameStateKind.UNKNOWN;
      reason = 'transient';
    }
    if (
      kind === 'ACTIVE'
      || (typeof FrameStateKind !== 'undefined' && kind === FrameStateKind.ACTIVE)
      // A frame that owns an unconfirmed cleanup must be reconciled, not
      // skipped: its cleanup has to be retried and confirmed before the
      // background can report an inactive frame.
      || (typeof FrameStateKind !== 'undefined' && kind === FrameStateKind.CLEANUP_PENDING)
    ) {
      activeFrames.push({ frameId, documentId, state });
    } else if (kind === FrameStateKind.UNKNOWN) {
      if (reason === 'no-receiver') {
        try {
          if (await isNoReceiverSafeForFrame(frame, tabId)) continue;
        } catch {
          // treat exclusion failure as not safe -> UNKNOWN
        }
      }
      let live = true;
      try {
        if (typeof isFrameDocumentLive === 'function') {
          live = await isFrameDocumentLive(tabId, frameId, documentId);
        } else {
          const frames2 = await browser.webNavigation.getAllFrames({ tabId });
          live = Array.isArray(frames2) && frames2.some(f => f?.frameId === frameId);
        }
      } catch { live = true; }
      if (live) hasUnknownLive = true;
    }
  }
  if (hasUnknownLive) {
    return { status: 'known', discoveredCount, fullyCleaned: false, hasUnknown: true };
  }
  if (activeFrames.length === 0) return { status: 'known', discoveredCount, fullyCleaned: true };
  let allCleaned = true;
  for (const { frameId, documentId, state } of activeFrames) {
    const epoch = state.activationEpoch;
    const generation = state.activationGeneration;
    const hasValidEpoch = typeof epoch === 'string' && epoch.trim().length > 0;
    const hasValidGen = Number.isInteger(generation) && generation > 0;
    const hasDoc = typeof documentId === 'string' && documentId.trim().length > 0;
    const target = hasDoc ? { frameId, documentId } : { frameId };
    try {
      const deactivationMessage = MessageFormat.create(
        MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
        {
          mode: 'normal',
          active: false,
          fromBackground: true,
          ...(hasValidEpoch ? { activationEpoch: epoch } : {}),
          ...(hasValidGen ? { activationGeneration: generation } : {}),
          isExplicitDeactivation: true,
        },
        MessagingContexts.CONTENT
      );
      const resp = await browser.tabs.sendMessage(tabId, deactivationMessage, target);
      const cleaned = resp?.success === true && resp?.cleanupCompleted === true && resp?.activated === false;
      if (!cleaned) {
        let live = true;
        try {
          if (typeof isFrameDocumentLive === 'function') {
            live = await isFrameDocumentLive(tabId, frameId, documentId);
          } else {
            const frames2 = await browser.webNavigation.getAllFrames({ tabId });
            live = Array.isArray(frames2) && frames2.some(f => f?.frameId === frameId);
          }
        } catch { live = true; }
        if (live) allCleaned = false;
      }
    } catch {
      let live = true;
      try {
        if (typeof isFrameDocumentLive === 'function') {
          live = await isFrameDocumentLive(tabId, frameId, documentId);
        } else {
          const frames2 = await browser.webNavigation.getAllFrames({ tabId });
          live = Array.isArray(frames2) && frames2.some(f => f?.frameId === frameId);
        }
      } catch { live = true; }
      if (live) allCleaned = false;
    }
  }
  return { status: 'known', discoveredCount, fullyCleaned: allCleaned };
}

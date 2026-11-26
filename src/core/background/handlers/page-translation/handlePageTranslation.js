import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingCore.js';
import browser from 'webextension-polyfill';
import ExtensionContextManager from '@/core/extensionContext.js';
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';
import { statsManager } from '@/features/translation/core/TranslationStatsManager.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import { pageNavigationTracker } from '@/core/background/PageNavigationTracker.js';

const logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'handlePageTranslation');

// Registry to track which tabs have auto-translation active
// Map<tabId, { targetLanguage: string, settings: object }>
const autoTranslateRegistry = new Map();
const pendingFrameRetirements = new Map();
const pendingManualFrameReadiness = new Map();

function getFrameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function clearPendingManualFrameReadiness(tabId, frameId = null) {
  for (const [key, pending] of pendingManualFrameReadiness) {
    if (pending.tabId === tabId && (frameId == null || pending.frameId === frameId)) {
      pendingManualFrameReadiness.delete(key);
    }
  }
}

function resumePendingManualFrameReadiness(tabId) {
  for (const [key, pending] of pendingManualFrameReadiness) {
    if (pending.tabId !== tabId) continue;
    pendingManualFrameReadiness.delete(key);
    void (async () => {
      const childSender = { tab: { id: tabId }, frameId: pending.frameId };
      const ticket = await handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
        data: { documentToken: pending.documentToken },
      }, childSender);
      if (ticket?.success && ticket.start) {
        await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_FRAME_START,
          data: { ...ticket, documentToken: pending.documentToken },
        }, childSender);
      }
    })().catch(error => logger.debug('Deferred iframe admission failed:', error?.message));
  }
}

function scheduleFrameRetirement(tabId, frameId) {
  const key = getFrameKey(tabId, frameId);
  const previousRetirement = pendingFrameRetirements.get(key) || Promise.resolve();
  const retirement = previousRetirement
    .catch(() => {})
    .then(() => browser.tabs.sendMessage(tabId, {
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        frameId,
        action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      },
      context: 'page-translation-frame-retirement',
    }, { frameId: 0 }))
    .catch((error) => {
      logger.debug(`Could not retire frame ${frameId} in tab ${tabId}:`, error.message);
    });

  pendingFrameRetirements.set(key, retirement);
  retirement.then(() => {
    if (pendingFrameRetirements.get(key) === retirement) {
      pendingFrameRetirements.delete(key);
    }
  });

  return retirement;
}

async function waitForFrameRetirement(tabId, frameId) {
  await pendingFrameRetirements.get(getFrameKey(tabId, frameId));
}

const PAGE_TRANSLATION_FAILURE_FIELDS = [
  'reason',
  'error',
  'errorType',
  'errorDetails',
  'message',
  'isRestrictedPage',
  'tabId',
  'tabUrl',
  // The settled session of a failed request. It lets the UI reject delayed
  // lifecycle events of that session.
  'messageId',
];

function projectPageTranslationFailure(response, responses) {
  const projected = { success: false };

  for (const field of PAGE_TRANSLATION_FAILURE_FIELDS) {
    if (response[field] !== undefined) projected[field] = response[field];
  }

  return { ...projected, responses };
}

// Bounded frame command response deadline. Must stay below the outer caller
// deadline (OPERATION_TIMEOUTS.DEFAULT = 8000ms) so the background can still
// deliver an aggregated result before the caller stops waiting.
const FRAME_COMMAND_RESPONSE_TIMEOUT_MS = 6000;
const FRAME_COMMAND_RESPONSE_TIMEOUT_REASON = 'frame_command_response_timeout';
const PRE_FANOUT_COMMAND_TIMEOUT_MS = 1500;
const PRE_FANOUT_COMMAND_TIMEOUT_REASON = 'pre_fanout_command_timeout';
// UnifiedMessaging applies an 8s default outer deadline. 250ms leaves 250ms
// scheduling margin after the 1.5s preparation and 6s fallback deadlines.
const STATUS_AGGREGATE_PROBE_TIMEOUT_MS = 250;
const FRAME_AD_DOMAINS = ['doubleclick.net', 'googleads', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'advertising.com'];

function isEligibleManualFrameUrl(url) {
  return /^https?:\/\//i.test(url || '') && !FRAME_AD_DOMAINS.some(domain => url.includes(domain));
}

async function probeFrameDocument(tabId, frameId) {
  return browser.tabs.sendMessage(tabId, { action: MessageActions.PAGE_TRANSLATE_FRAME_PROBE }, { frameId });
}

/**
 * Sends a Whole Page command to a single frame with a bounded response wait.
 *
 * A response timeout is an uncertainty state only: it means the background did
 * not receive the frame's response within the deadline. It does NOT mean the
 * command was undelivered, unexecuted, or that any translation/restore/stop
 * operation failed. Late resolutions/rejections of the underlying send are
 * observed but ignored once this wrapper has settled.
 *
 * @param {number} tabId Target tab id
 * @param {Object} message Command message forwarded unchanged
 * @param {number} frameId Target frame id
 * @param {number} deadlineMs Response deadline override
 * @returns {Promise<{frameId: number, response: Object|null, isResponseTimeout: boolean}>}
 */
async function sendFrameCommandWithResponseDeadline(
  tabId,
  message,
  frameId,
  deadlineMs = FRAME_COMMAND_RESPONSE_TIMEOUT_MS,
  boundNavigation = null
) {
  let timeoutId;
  let expired = false;
  try {
    const sendPromise = (async () => {
      if (message.action === MessageActions.PAGE_TRANSLATE && !message.data?.navigationUnavailable) {
        let data;
        try {
          const navigationCursor = await pageNavigationTracker.getAdmissionCursor(tabId, frameId);
          if (boundNavigation) {
            const topCursor = await pageNavigationTracker.getAdmissionCursor(tabId, 0);
            if (!navigationCursor || !sameCursor(topCursor, boundNavigation.topCursor)
                || pageNavigationTracker.getRestartFence(tabId) !== boundNavigation.restartFence) return null;
            data = {
              navigationCursor,
              topNavigationCursor: boundNavigation.topCursor,
              restartFence: boundNavigation.restartFence,
            };
          } else {
            data = navigationCursor ? { navigationCursor } : { navigationUnavailable: true };
          }
        } catch {
          data = { navigationUnavailable: true };
        }
        message = { ...message, data: { ...message.data, ...data } };
      }
      if (expired) return null;
      return browser.tabs.sendMessage(tabId, message, { frameId });
    })();
    const response = await Promise.race([
      sendPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          expired = true;
          const timeoutError = new Error(`Frame ${frameId} command response timed out`);
          timeoutError.isResponseTimeout = true;
          reject(timeoutError);
        }, deadlineMs);
      }),
    ]);
    return { frameId, response, isResponseTimeout: false };
  } catch (error) {
    // Promise.race keeps handlers attached to the losing send promise, so late
    // rejections after a timeout settle here without becoming unhandled.
    if (error?.isResponseTimeout === true) {
      return { frameId, response: null, isResponseTimeout: true };
    }
    logger.debug(`Could not send to frame ${frameId}:`, error.message);
    return { frameId, response: null, isResponseTimeout: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sameCursor(a, b) {
  return Boolean(a && b && a.documentEpoch === b.documentEpoch
    && a.routeRevision === b.routeRevision && a.url === b.url);
}

async function withManualContinuityStatus(tabId, status) {
  try {
    return { ...status, ...(await pageNavigationTracker.getManualContinuityStatus(tabId)) };
  } catch {
    return {
      ...status,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
      manualContinuityStatusUnavailable: true,
    };
  }
}

async function revokeManualContinuity(tabId, expectedGeneration, revision) {
  let cutoffGeneration = expectedGeneration;
  try {
    if (cutoffGeneration == null) {
      cutoffGeneration = (await pageNavigationTracker.getManualContinuityStatus(tabId)).manualContinuityGeneration;
    }
    const generation = await pageNavigationTracker.revokeManualContinuity(tabId, expectedGeneration, revision);
    return { generation, cutoffGeneration };
  } catch (error) {
    return { error, cutoffGeneration };
  }
}

async function waitForManualRevocation(operation) {
  if (!operation) return null;
  let timeoutId;
  return Promise.race([
    operation,
    new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({
        error: new Error('Manual continuity revocation durability uncertain'),
      }), PRE_FANOUT_COMMAND_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

/**
 * Projects a bounded frame send result into an additive per-frame delivery
 * record. `success` reflects delivery-level acknowledgement; application
 * failures remain visible inside the acknowledged `responses` collection.
 */
function projectFrameDelivery({ frameId, response, isResponseTimeout }) {
  return {
    frameId,
    success: response !== null,
    ...(isResponseTimeout && {
      isResponseTimeout: true,
      reason: FRAME_COMMAND_RESPONSE_TIMEOUT_REASON,
    }),
  };
}

/**
 * Resolve Whole Page command preparation under one shared deadline.
 * Immediate preparation failures keep their existing error handling; only a
 * stalled preparation stage is converted to the timeout marker.
 */
async function runPreFanoutPreparation(message, sender, discoverFrames = true, onTargetResolved = null) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new Error('Whole Page command preparation timed out');
      timeoutError.isPreFanoutTimeout = true;
      reject(timeoutError);
    }, PRE_FANOUT_COMMAND_TIMEOUT_MS);
  });

  const preparationPromise = (async () => {
    const senderTab = sender?.tab;
    let targetTabId;

    if (senderTab !== undefined && senderTab !== null) {
      if (!Number.isInteger(senderTab.id)) {
        return { error: { success: false, error: 'Invalid sender tab' } };
      }
      targetTabId = senderTab.id;
    } else {
      // Extension UI callers without sender.tab retain active-tab behavior.
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) {
        return { error: { success: false, error: 'No active tab found' } };
      }
      targetTabId = tabs[0].id;
    }

    onTargetResolved?.(targetTabId);
    const access = await tabPermissionChecker.checkTabAccess(targetTabId);
    if (!access.isAccessible || !discoverFrames) {
      return { targetTabId, access };
    }

    // Get all frames in the tab to ensure we reach every part of the page (especially iframes)
    const hasWebNav = typeof browser !== 'undefined' && browser.webNavigation;
    let allFrames = hasWebNav
      ? await browser.webNavigation.getAllFrames({ tabId: targetTabId }).catch(() => [{ frameId: 0 }])
      : [{ frameId: 0 }];

    // Filter frames to skip common ad domains and non-content frames
    allFrames = allFrames.filter(frame => {
      if (frame.frameId === 0) return true;
      if (!frame.url || frame.url.startsWith('about:') || frame.url.startsWith('javascript:') || frame.url.startsWith('chrome-extension:')) return false;
      return !FRAME_AD_DOMAINS.some(domain => frame.url.includes(domain));
    });

    let navigationUnavailable = false;
    let navigationAdmissionInvalid = false;
    if (message.action === MessageActions.PAGE_TRANSLATE) {
      try { await pageNavigationTracker.seed(targetTabId, allFrames); }
      catch {
        navigationUnavailable = true;
        logger.debug('Page navigation preparation unavailable');
      }
    }
    if (message.action === MessageActions.PAGE_TRANSLATE && message.data?.restartFence) {
      try {
        const topCursor = await pageNavigationTracker.getAdmissionCursor(targetTabId, 0);
        navigationAdmissionInvalid = pageNavigationTracker.getRestartFence(targetTabId) !== message.data.restartFence
          || !sameCursor(topCursor, message.data.navigationCursor);
      } catch {
        navigationAdmissionInvalid = true;
      }
    }
    return { targetTabId, access, allFrames, navigationUnavailable, navigationAdmissionInvalid };
  })();

  try {
    return await Promise.race([preparationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Handle page translation related messages
 */
export async function handlePageTranslation(message, sender) {
  try {
    const senderTabId = sender?.tab?.id;
    if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_READY
        || message.action === MessageActions.PAGE_TRANSLATE_FRAME_START) {
      const frameId = sender?.frameId;
      const data = message.data || {};
      if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId <= 0
          || typeof data.documentToken !== 'string' || !data.documentToken) {
        return { success: false, reason: 'ineligible_frame' };
      }
      const access = await tabPermissionChecker.checkTabAccess(senderTabId);
      if (!access.isAccessible) return { success: false, reason: 'ineligible_frame' };
      const [grant, frame] = await Promise.all([
        pageNavigationTracker.getManualContinuity(senderTabId),
        browser.webNavigation.getFrame({ tabId: senderTabId, frameId }),
      ]);
      if (!grant || !frame || !isEligibleManualFrameUrl(frame.url)) {
        return { success: false, reason: 'ineligible_frame' };
      }
      const [{ documentToken: currentToken }, { documentToken: currentTopToken }, topCursor] = await Promise.all([
        probeFrameDocument(senderTabId, frameId),
        probeFrameDocument(senderTabId, 0),
        pageNavigationTracker.getAdmissionCursor(senderTabId, 0),
      ]);
      if (currentToken !== data.documentToken || !topCursor
          || currentTopToken !== grant.topDocumentToken || topCursor.documentEpoch !== grant.topDocumentEpoch) {
        return { success: false, reason: 'obsolete_navigation' };
      }
      const { checkUrlExclusionAsync } = await import('@/features/exclusion/utils/exclusion-utils.js');
      if (await checkUrlExclusionAsync(frame.url)) return { success: false, reason: 'ineligible_frame' };

      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_READY) {
        if (!grant.armed) {
          pendingManualFrameReadiness.set(`${senderTabId}:${frameId}:${data.documentToken}`, {
            tabId: senderTabId, frameId, documentToken: data.documentToken,
          });
          return { success: true, pending: true };
        }
        const admission = await pageNavigationTracker.admitManualFrame(
          senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
          currentTopToken, frame.url, data.documentToken
        );
        if (!admission) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        const isCurrent = await pageNavigationTracker.validateManualContinuity(
          senderTabId, frameId, grant.generation, grant.topDocumentEpoch, admission.cursor
        );
        if (!isCurrent) return { success: false, reason: 'obsolete_navigation' };
        return {
          success: true,
          start: admission.grant.startedDocuments?.[frameId] !== data.documentToken,
          documentToken: data.documentToken,
          manualContinuityGeneration: grant.generation,
          topDocumentEpoch: grant.topDocumentEpoch,
          navigationCursor: admission.cursor,
          provider: grant.provider,
          targetLanguage: grant.targetLanguage,
          isExplicitProvider: grant.isExplicitProvider,
        };
      }

      const { navigationCursor, manualContinuityGeneration, topDocumentEpoch } = data;
      if (manualContinuityGeneration !== grant.generation || topDocumentEpoch !== grant.topDocumentEpoch
          || !sameCursor(navigationCursor, await pageNavigationTracker.getAdmissionCursor(senderTabId, frameId))
          || !await pageNavigationTracker.validateManualContinuity(
            senderTabId, frameId, grant.generation, grant.topDocumentEpoch, navigationCursor
          )) return { success: false, reason: 'obsolete_navigation' };
      const claimed = await pageNavigationTracker.claimManualFrameStart(
        senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
        grant.topDocumentToken, navigationCursor, data.documentToken
      );
      if (!claimed) return { success: true, skipped: true, reason: 'duplicate_or_revoked_admission' };
      let sendInvoked = false;
      let timeoutId;
      try {
        const [finalAccess, liveFrame] = await Promise.all([
          tabPermissionChecker.checkTabAccess(senderTabId),
          browser.webNavigation.getFrame({ tabId: senderTabId, frameId }),
        ]);
        const { checkUrlExclusionAsync: checkCurrentUrlExcluded } = await import('@/features/exclusion/utils/exclusion-utils.js');
        if (!finalAccess.isAccessible || !isEligibleManualFrameUrl(liveFrame?.url)
            || liveFrame.url !== navigationCursor.url || await checkCurrentUrlExcluded(liveFrame.url)
            || !await pageNavigationTracker.validateManualContinuity(
              senderTabId, frameId, grant.generation, grant.topDocumentEpoch, navigationCursor
            )) return { success: false, reason: 'obsolete_navigation' };
        const [startProbe, topProbe] = await Promise.all([
          probeFrameDocument(senderTabId, frameId),
          probeFrameDocument(senderTabId, 0),
        ]);
        if (startProbe?.documentToken !== data.documentToken || topProbe?.documentToken !== grant.topDocumentToken) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        if (!pageNavigationTracker.isManualFrameStartCurrent(
          senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
          grant.topDocumentToken, navigationCursor, data.documentToken
        )) return { success: false, reason: 'obsolete_navigation' };
        const pendingDelivery = browser.tabs.sendMessage(senderTabId, {
          action: MessageActions.PAGE_TRANSLATE,
          data: {
            isAuto: false,
            hasManualContinuity: true,
            manualContinuityGeneration: grant.generation,
            topDocumentEpoch: grant.topDocumentEpoch,
            topDocumentToken: grant.topDocumentToken,
            navigationCursor,
            origin: 'manual-frame',
            documentToken: data.documentToken,
            ...(typeof grant.provider === 'string' && { provider: grant.provider }),
            ...(typeof grant.targetLanguage === 'string' && { targetLanguage: grant.targetLanguage }),
            ...(typeof grant.isExplicitProvider === 'boolean' && { isExplicitProvider: grant.isExplicitProvider }),
          },
        }, { frameId });
        sendInvoked = true;
        const delivery = pendingDelivery.then(async response => {
          await pageNavigationTracker.completeManualFrameStart(
            senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
            grant.topDocumentToken, navigationCursor, data.documentToken, response?.success === true
          ).catch(error => logger.debug('Could not persist iframe START acceptance:', error?.message));
          return { response };
        }, async error => {
          await pageNavigationTracker.completeManualFrameStart(
            senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
            grant.topDocumentToken, navigationCursor, data.documentToken, false
          ).catch(() => {});
          return { error };
        });
        const timedOut = new Promise(resolve => {
          timeoutId = setTimeout(() => resolve({ timedOut: true }), FRAME_COMMAND_RESPONSE_TIMEOUT_MS);
        });
        const result = await Promise.race([delivery, timedOut]);
        if (result.timedOut) {
          // The browser may still deliver the command. Keep the volatile claim
          // until the underlying send settles; the receiver deduplicates retries.
          return { success: false, reason: FRAME_COMMAND_RESPONSE_TIMEOUT_REASON, isTransportFailure: true };
        }
        if (result.error) return { success: false, error: result.error.message };
        return result.response;
      } finally {
        clearTimeout(timeoutId);
        if (!sendInvoked) {
          await pageNavigationTracker.completeManualFrameStart(
            senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
            grant.topDocumentToken, navigationCursor, data.documentToken, false
          ).catch(() => {});
        }
      }
    }
    let manualStopRevision = null;
    let manualStopCutoffGeneration = null;
    let manualStartRevision = null;
    let manualRevokePromise = null;
    let stopTargetTabId = senderTabId;
    const isManualStart = message.action === MessageActions.PAGE_TRANSLATE
      && message.data?.isAuto !== true && message.data?.cancel !== true;
    const isManualRevocation = message.action === MessageActions.PAGE_RESTORE
      || message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
      || message.action === MessageActions.CANCEL_TRANSLATION
      || (message.action === MessageActions.PAGE_TRANSLATE && message.data?.cancel === true);
    if (isManualStart && Number.isInteger(senderTabId)) {
      manualStartRevision = pageNavigationTracker.reserveManualContinuityStart(senderTabId);
    }
    const explicitInvalidation = [
      MessageActions.PAGE_RESTORE,
      MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      MessageActions.CANCEL_TRANSLATION,
    ].includes(message.action) || (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.cancel === true
    ) || (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.isAuto !== true
    );
    if (Number.isInteger(senderTabId) && explicitInvalidation) {
      pageNavigationTracker.revokeRestartFence(senderTabId);
      if (isManualRevocation) clearPendingManualFrameReadiness(senderTabId);
      if (isManualRevocation && !(
        message.action === MessageActions.CANCEL_TRANSLATION
        && message.data?.context === MessageContexts.PAGE_TRANSLATION_BATCH
        && message.data?.reason === 'operation-abort'
      )) {
        manualStopRevision = pageNavigationTracker.blockManualContinuity(
          senderTabId, message.data?.expectedManualContinuityGeneration ?? null
        );
        manualStopCutoffGeneration = pageNavigationTracker.getManualContinuityCutoff(senderTabId);
        manualRevokePromise = revokeManualContinuity(
          senderTabId, message.data?.expectedManualContinuityGeneration, manualStopRevision
        );
      }
    }

    if (message.action === MessageActions.PAGE_TRANSLATE_ADMIT) {
      const data = message.data || {};
      const frameId = sender?.frameId;
      if (data.origin === 'manual-stop') {
        if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId < 0
            || !Number.isSafeInteger(data.manualContinuityGeneration)) {
          return { success: false, reason: 'manual_continuity_status_unavailable' };
        }
        try {
          const status = await pageNavigationTracker.getManualContinuityStatus(senderTabId);
          return {
            success: true,
            authorized: status.manualContinuityGeneration == null
              || status.manualContinuityGeneration <= data.manualContinuityGeneration,
          };
        } catch {
          return { success: false, reason: 'manual_continuity_status_unavailable' };
        }
      }
      if (data.origin === 'manual-spa' || data.origin === 'manual-start' || data.origin === 'manual-frame') {
        if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId < 0
            || !/^https?:\/\//i.test(data.navigationCursor?.url || '')
            || (data.origin === 'manual-spa' && (typeof data.restartFence !== 'string' || !data.restartFence
              || pageNavigationTracker.getRestartFence(senderTabId) !== data.restartFence))) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        try {
          const access = await tabPermissionChecker.checkTabAccess(senderTabId);
          if (!access.isAccessible) return { success: false, reason: 'ineligible_frame' };
          const grant = await pageNavigationTracker.getManualContinuity(senderTabId);
          if (!grant || data.topDocumentToken !== grant.topDocumentToken) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          const { documentToken: currentTopToken } = await probeFrameDocument(senderTabId, 0);
          if (currentTopToken !== grant.topDocumentToken) return { success: false, reason: 'obsolete_navigation' };
          if (data.origin === 'manual-frame') {
            const frame = await browser.webNavigation.getFrame({ tabId: senderTabId, frameId });
            if (!grant?.armed || grant.documents?.[frameId] !== data.documentToken
                || !isEligibleManualFrameUrl(frame?.url)) return { success: false, reason: 'obsolete_navigation' };
            const [{ documentToken }, { checkUrlExclusionAsync }] = await Promise.all([
              probeFrameDocument(senderTabId, frameId),
              import('@/features/exclusion/utils/exclusion-utils.js'),
            ]);
            if (documentToken !== data.documentToken
                || await checkUrlExclusionAsync(frame.url)) {
              return { success: false, reason: 'obsolete_navigation' };
            }
          }
          const valid = await pageNavigationTracker.validateManualContinuity(
            senderTabId, frameId, data.manualContinuityGeneration,
            data.topDocumentEpoch, data.navigationCursor
          );
          return valid && (data.origin !== 'manual-spa'
            || pageNavigationTracker.getRestartFence(senderTabId) === data.restartFence)
            ? { success: true }
            : { success: false, reason: 'obsolete_navigation' };
        } catch {
          return { success: false, reason: 'obsolete_navigation' };
        }
      }
      if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId < 0
          || typeof data.restartFence !== 'string' || data.restartFence.length === 0
          || pageNavigationTracker.getRestartFence(senderTabId) !== data.restartFence) {
        return { success: false, reason: 'obsolete_navigation' };
      }
      try {
        const [topCursor, frameCursor] = await Promise.all([
          pageNavigationTracker.getAdmissionCursor(senderTabId, 0),
          pageNavigationTracker.getAdmissionCursor(senderTabId, frameId),
        ]);
        const success = sameCursor(topCursor, data.topNavigationCursor)
            && sameCursor(frameCursor, data.navigationCursor)
            && pageNavigationTracker.getRestartFence(senderTabId) === data.restartFence;
        return success ? { success: true } : { success: false, reason: 'obsolete_navigation' };
      } catch {
        return { success: false, reason: 'obsolete_navigation' };
      }
    }

    if (message.action === MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE) {
      const senderFrameId = sender?.frameId;
      const lifecycleAction = message.data?.action;

      if (!Number.isInteger(senderTabId) || !Number.isInteger(senderFrameId) || senderFrameId < 0) {
        return { success: false, error: 'Invalid lifecycle sender' };
      }

      if (!MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE_ACTIONS.includes(lifecycleAction)) {
        return { success: false, error: 'Unsupported page lifecycle action' };
      }

      if (lifecycleAction === MessageActions.PAGE_TRANSLATION_FRAME_RETIRED) {
        const sessionId = message.data?.data?.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { success: true, ignored: true, reason: 'missing-session' };
        }
      }

      try {
        await waitForFrameRetirement(senderTabId, senderFrameId);
        const response = await browser.tabs.sendMessage(senderTabId, {
          action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
          data: {
            frameId: senderFrameId,
            action: lifecycleAction,
            data: message.data?.data,
          },
          context: 'page-translation-frame-lifecycle-relay',
        }, { frameId: 0 });

        return response || { success: true };
      } catch (error) {
        logger.debug('Could not relay page lifecycle to top frame:', error.message);
        return { success: false, error: 'Top frame lifecycle relay failed' };
      }
    }

    const isNavigationAutoRestart = message.action === MessageActions.PAGE_TRANSLATE
      && message.data?.isAuto === true && message.data?.restartFence;
    if (message.action === MessageActions.PAGE_TRANSLATE && message.data?.isAuto
        && message.data?.preserveAcceptedTranslations && !isNavigationAutoRestart) {
      return { success: false, reason: 'obsolete_navigation' };
    }

    // Handle batch translation request via UnifiedTranslationService
    if (message.action === MessageActions.PAGE_TRANSLATE_BATCH) {
      const authorization = message.data?.manualContinuity;
      if (authorization) {
        if (!Number.isInteger(senderTabId) || !Number.isInteger(sender?.frameId)) {
          return { success: false, reason: 'manual_continuity_revoked' };
        }
        if (!(await pageNavigationTracker.validateManualContinuityBatch(
          senderTabId, sender.frameId, authorization.generation,
          authorization.topDocumentEpoch, authorization.navigationCursor
        ))) return { success: false, reason: 'manual_continuity_revoked' };
      }
      return await unifiedTranslationService.handleTranslationRequest(message, sender);
    }

    // Capture state change: Start Auto-Translation
    if (message.action === MessageActions.PAGE_TRANSLATE_COMPLETE
        && message.data?.isAutoTranslating && message.data?.translationOrigin !== 'manual') {
      if (senderTabId) {
        autoTranslateRegistry.set(senderTabId, { 
          active: true, 
          url: message.data.url,
          timestamp: Date.now()
        });
        logger.debug(`Tab ${senderTabId} added to auto-translate registry`);
      }
    }

    // Capture state change: Stop/Restore Auto-Translation
    if (message.action === MessageActions.PAGE_RESTORE_COMPLETE || message.action === MessageActions.PAGE_AUTO_RESTORE_COMPLETE) {
      if (senderTabId) {
        autoTranslateRegistry.delete(senderTabId);
        logger.debug(`Tab ${senderTabId} removed from auto-translate registry`);
      }
    }

    // Actions that are events originating from content script and need to be broadcasted
    const eventActions = [
      MessageActions.PAGE_TRANSLATE_START,
      MessageActions.PAGE_TRANSLATE_PROGRESS,
      MessageActions.PAGE_TRANSLATE_IDLE,
      MessageActions.PAGE_TRANSLATE_COMPLETE,
      MessageActions.PAGE_TRANSLATE_ERROR,
      MessageActions.PAGE_TRANSLATE_RESET_ERROR,
      MessageActions.PAGE_RESTORE_COMPLETE,
      MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      MessageActions.PAGE_RESTORE_ERROR,
      MessageActions.PAGE_TRANSLATE_CANCELLED,
    ];

    if (eventActions.includes(message.action)) {
      // Filter out empty/invalid completion messages before broadcasting
      if (message.action === MessageActions.PAGE_TRANSLATE_COMPLETE) {
        const data = message.data || {};
        // Skip completion messages with no meaningful data
        // BUT: Always allow if isAutoTranslating is false (signaling a stop)
        if (!data.translatedCount && !data.totalCount && !data.isTranslated && !data.messageId && data.isAutoTranslating !== false) {
          logger.debug('Skipping empty PAGE_TRANSLATE_COMPLETE message');
          return { success: true };
        }
      }

      // Filter out empty/invalid auto-restore complete messages
      if (message.action === MessageActions.PAGE_AUTO_RESTORE_COMPLETE) {
        const data = message.data || {};
        // Skip auto-restore messages with no translation data
        // BUT: Always allow if isAutoTranslating is false (signaling a stop)
        if (!data.translatedCount && !data.isTranslated && data.isAutoTranslating !== false) {
          logger.debug('Skipping empty PAGE_AUTO_RESTORE_COMPLETE message');
          return { success: true };
        }
      }

      // Log Page Session Summary on completion, cancellation or error
      if (message.action === MessageActions.PAGE_TRANSLATE_COMPLETE ||
          message.action === MessageActions.PAGE_TRANSLATE_CANCELLED ||
          message.action === MessageActions.PAGE_TRANSLATE_ERROR ||
          message.action === MessageActions.PAGE_RESTORE_COMPLETE) {

        // Find session ID in all possible locations - prioritization is key
        const sessionId = message.data?.sessionId ||
                         message.sessionId ||
                         message.data?.messageId ||
                         message.messageId;

        // Clear the coordinator's per-session source-resolution state on any
        // terminal page event so the resolved language never leaks to a new
        // session reusing the same identifier.
        unifiedTranslationService.clearPageSourceSession(sessionId);

        // Map action to status label
        let status = 'Complete';
        if (message.action === MessageActions.PAGE_TRANSLATE_CANCELLED) status = 'Stopped';
        else if (message.action === MessageActions.PAGE_TRANSLATE_ERROR) status = 'Error';
        else if (message.action === MessageActions.PAGE_RESTORE_COMPLETE) status = 'Page Restored';

        // Decide whether to clear based on the action type
        // We only clear on Restore or Cancel, not on "Complete" because of Lazy Loading
        const shouldClear = message.action === MessageActions.PAGE_RESTORE_COMPLETE ||
                           message.action === MessageActions.PAGE_TRANSLATE_CANCELLED;

        statsManager.printSummary(sessionId, {
          status,
          success: message.action !== MessageActions.PAGE_TRANSLATE_ERROR,
          clear: shouldClear
        });
      }

      // The originating content script's tab is the authoritative identity of
      // the event. A tab id carried by the payload is never trusted, because
      // the event is broadcast to every extension page.
      const eventData = { ...(message.data || {}) };
      if (Number.isInteger(senderTabId)) {
        eventData.tabId = senderTabId;
      } else {
        delete eventData.tabId;
      }
      browser.runtime.sendMessage({
        ...message,
        data: eventData,
      }).catch(() => {});
      return { success: true };
    }

    // Actions that should be forwarded to content scripts
    const forwardActions = [
      MessageActions.PAGE_TRANSLATE,
      MessageActions.PAGE_RESTORE,
      MessageActions.PAGE_TRANSLATE_GET_STATUS,
      MessageActions.PAGE_TRANSLATE_STOP_AUTO,
    ];

    if (!forwardActions.includes(message.action)) {
      return { success: false, error: 'Unknown page translation action' };
    }

    let preparation;
    if (message.action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
      const fastPathPreparation = await runPreFanoutPreparation(message, sender, false);
      if (!fastPathPreparation.error && fastPathPreparation.access.isAccessible) {
        const { response } = await sendFrameCommandWithResponseDeadline(
          fastPathPreparation.targetTabId,
          message,
          0,
          STATUS_AGGREGATE_PROBE_TIMEOUT_MS
        );
        if (response?.success && response.isAggregated === true) {
          logger.debug('Returning aggregated translation status from main frame');
          return withManualContinuityStatus(fastPathPreparation.targetTabId, response);
        }
      }
    }

    preparation = await runPreFanoutPreparation(message, sender, true, targetTabId => {
      stopTargetTabId = targetTabId;
      if (isManualStart && manualStartRevision == null) {
        manualStartRevision = pageNavigationTracker.reserveManualContinuityStart(targetTabId);
      }
      if (!Number.isInteger(senderTabId) && explicitInvalidation) {
        pageNavigationTracker.revokeRestartFence(targetTabId);
        if (isManualRevocation) {
          manualStopRevision = pageNavigationTracker.blockManualContinuity(
            targetTabId, message.data?.expectedManualContinuityGeneration ?? null
          );
          manualStopCutoffGeneration = pageNavigationTracker.getManualContinuityCutoff(targetTabId);
          manualRevokePromise = revokeManualContinuity(
            targetTabId, message.data?.expectedManualContinuityGeneration, manualStopRevision
          );
        }
      }
    });
    if (preparation.error) {
      const revokeResult = await waitForManualRevocation(manualRevokePromise);
      if (isManualRevocation && Number.isInteger(stopTargetTabId)) {
        await sendFrameCommandWithResponseDeadline(stopTargetTabId, {
            action: message.action === MessageActions.PAGE_RESTORE
              ? MessageActions.PAGE_RESTORE : MessageActions.PAGE_TRANSLATE_STOP_AUTO,
            data: {
              hasManualContinuity: false,
              ...((revokeResult?.generation ?? revokeResult?.cutoffGeneration ?? manualStopCutoffGeneration) != null
                && { manualContinuityGeneration: revokeResult.generation ?? revokeResult?.cutoffGeneration ?? manualStopCutoffGeneration }),
              ...(revokeResult?.error && { revocationCommitted: false }),
            },
          }, Number.isInteger(sender?.frameId) ? sender.frameId : 0);
      }
      return {
        ...preparation.error,
        ...(isManualRevocation && {
          success: false,
          reason: revokeResult?.error ? 'manual_continuity_revocation_uncertain' : preparation.error.reason,
          ...(revokeResult?.error && { error: revokeResult.error.message }),
        }),
        ...(!revokeResult?.error && revokeResult?.generation != null && {
          hasManualContinuity: false,
          manualContinuityGeneration: revokeResult.generation,
        }),
      };
    }

    const { targetTabId, access, allFrames, navigationUnavailable, navigationAdmissionInvalid } = preparation;
    if (navigationUnavailable) message = { ...message, data: { ...message.data, navigationUnavailable: true } };
    if (!access.isAccessible) {
      logger.debug(`Page translation blocked on restricted tab ${targetTabId}: ${access.errorMessage}`);
      return {
        success: false,
        message: access.errorMessage,
        isRestrictedPage: true,
        tabId: targetTabId,
        tabUrl: access.fullUrl,
      };
    }

    try {
      let boundNavigation = null;
      let manualGrant = null;
      const revocationResult = await waitForManualRevocation(manualRevokePromise);
      const revocationGeneration = revocationResult?.generation ?? null;
      const revocationError = revocationResult?.error ?? null;
      if (isManualRevocation && !revocationError && revocationGeneration == null) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      if (isManualStart && !navigationUnavailable && !navigationAdmissionInvalid) {
        try {
          const topProbe = await probeFrameDocument(targetTabId, 0).catch(() => null);
          if (typeof topProbe?.documentToken !== 'string' || !topProbe.documentToken) {
            return { success: false, reason: 'manual_continuity_top_identity_unavailable' };
          }
          manualGrant = await pageNavigationTracker.grantManualContinuity(targetTabId, manualStartRevision, {
            topDocumentToken: topProbe.documentToken,
            provider: message.data?.provider,
            targetLanguage: message.data?.targetLanguage,
            isExplicitProvider: message.data?.isExplicitProvider,
          });
        } catch (error) {
          return { success: false, reason: 'manual_continuity_not_durable', error: error.message };
        }
      }
      if (isNavigationAutoRestart) {
        const { navigationCursor: topCursor, restartFence } = message.data;
        if (navigationAdmissionInvalid || navigationUnavailable) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        boundNavigation = { topCursor, restartFence };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
        const statusResults = await Promise.all(
          allFrames.map(frame =>
            sendFrameCommandWithResponseDeadline(targetTabId, message, frame.frameId)
          )
        );
        const statusResponses = statusResults.map(({ response }) => response);
        
        // 1. Check for an aggregated response (usually from the top frame)
        // This response already contains consolidated stats from all frames
        const aggregatedResponse = statusResponses.find(r => r && r.success && r.isAggregated);
        if (aggregatedResponse) {
          logger.debug('Returning aggregated translation status from main frame');
          return withManualContinuityStatus(targetTabId, aggregatedResponse);
        }

        // Response timeouts leave status unknown. Never report
        // "No active translation found" purely because bounded sends timed
        // out; that fallback stays valid only for acknowledged responses.
        if (
          !statusResponses.some(response => response != null)
          && statusResults.some(({ isResponseTimeout }) => isResponseTimeout)
        ) {
          return withManualContinuityStatus(targetTabId, {
            success: false,
            reason: FRAME_COMMAND_RESPONSE_TIMEOUT_REASON,
            isTransportFailure: true,
          });
        }

        // 2. Fallback: Aggregate manually if no aggregated response was found
        const bestResponse = statusResponses.find(r => r && (r.isTranslating || r.isAutoTranslating || r.isTranslated)) || 
                           statusResponses.find(r => r && r.success) || 
                           { success: false, error: 'No active translation found' };
                           
        const totalCount = statusResponses.reduce((acc, r) => acc + (r?.translatedCount || 0), 0);
        const anyAutoTranslating = statusResponses.some(r => r && r.isAutoTranslating && (r.isTranslating || r.isTranslated));
        
        if (bestResponse.success) {
          bestResponse.translatedCount = totalCount;
          bestResponse.isAutoTranslating = anyAutoTranslating;
        }
        
        return withManualContinuityStatus(targetTabId, bestResponse);
      }

      // Forward TRANSLATE, RESTORE and STOP to all frames with a bounded
      // per-frame response deadline so one stalled frame cannot hang the
      // whole fan-out.
      const outboundMessage = manualGrant
        ? { ...message, data: {
          ...message.data,
          hasManualContinuity: true,
          manualContinuityGeneration: manualGrant.generation,
          topDocumentEpoch: manualGrant.topDocumentEpoch,
          topDocumentToken: manualGrant.topDocumentToken,
        } }
        : revocationGeneration != null || (isManualRevocation && revocationError)
          ? { ...message, data: {
            ...message.data,
          hasManualContinuity: false,
          manualContinuityGeneration: revocationGeneration
            ?? revocationResult?.cutoffGeneration
            ?? manualStopCutoffGeneration,
            ...(revocationError && { revocationCommitted: false }),
          } }
          : message;
      const frameResults = await Promise.all(
        allFrames.map(frame =>
          sendFrameCommandWithResponseDeadline(
            targetTabId, outboundMessage, frame.frameId, FRAME_COMMAND_RESPONSE_TIMEOUT_MS, boundNavigation
          )
        )
      );

      const responses = frameResults
        .map(({ response }) => response)
        .filter(response => response != null);
      const frames = frameResults.map(projectFrameDelivery);
      const success = responses.some(response => response.success);
      if (manualGrant && success) {
        try {
          if (await pageNavigationTracker.armManualContinuity(targetTabId, manualGrant.generation)) {
            resumePendingManualFrameReadiness(targetTabId);
          }
        } catch (error) {
          logger.warn('Failed to arm an accepted manual Page start', error);
        }
      }
      if (message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
          && responses.some(response => response.reason === 'manual_continuity_status_unavailable')) {
        return {
          success: false,
          reason: 'manual_continuity_stop_authority_uncertain',
          isTransportFailure: true,
          responses,
          frames,
          targetTabId,
        };
      }
      if (manualGrant && !manualGrant.reused && !success) {
        clearPendingManualFrameReadiness(targetTabId);
        pageNavigationTracker.blockManualContinuity(targetTabId, manualGrant.generation);
        try {
          await pageNavigationTracker.revokeManualContinuity(targetTabId, manualGrant.generation);
        } catch (error) {
          logger.warn('Failed to revoke an unaccepted manual start', error);
        }
      }
      if (revocationError) {
        return {
          success: false,
          reason: 'manual_continuity_revocation_uncertain',
          error: revocationError.message,
          revocationGeneration,
          responses,
          frames: frameResults.map(projectFrameDelivery),
          targetTabId,
        };
      }
      if (isManualRevocation && frameResults.some(({ response }) => response == null)) {
        return {
          success: false,
          reason: 'manual_continuity_stop_delivery_uncertain',
          isTransportFailure: true,
          revocationGeneration,
          hasManualContinuity: false,
          manualContinuityGeneration: revocationGeneration,
          responses,
          frames,
          targetTabId,
        };
      }

      // Every frame timed out without a single acknowledged response: return
      // an uncertainty result. For PAGE_TRANSLATE this does NOT prove the
      // command did not execute; lifecycle events remain authoritative.
      if (!responses.length && frameResults.some(({ isResponseTimeout }) => isResponseTimeout)) {
        return {
          success: false,
          reason: FRAME_COMMAND_RESPONSE_TIMEOUT_REASON,
          isTransportFailure: true,
          responses,
          frames,
          targetTabId,
        };
      }

      if (message.action !== MessageActions.PAGE_TRANSLATE || success) {
        return {
          success,
          responses,
          frames,
          targetTabId,
          ...(isManualRevocation && revocationGeneration != null && {
            hasManualContinuity: false,
            manualContinuityGeneration: revocationGeneration,
          }),
        };
      }

      const canonicalFailure = frameResults.find(({ frameId, response }) => (
        frameId === 0 && response != null
      ))?.response || frameResults.find(({ response }) => response != null)?.response;

      if (canonicalFailure) {
        return { ...projectPageTranslationFailure(canonicalFailure, responses), frames, targetTabId };
      }

      return {
        success: false,
        error: 'Content script not available',
        isTransportFailure: true,
        responses,
        frames,
        targetTabId,
      };
    } catch (sendError) {
      if (ExtensionContextManager.isContextError(sendError)) {
        ExtensionContextManager.handleContextError(sendError, 'page-translation-handler');
      } else {
        logger.warn('Error sending page translation message to content script:', sendError);
      }
      return { success: false, error: 'Content script not available' };
    }
  } catch (error) {
    if (error?.isPreFanoutTimeout === true) {
      logger.debug('Whole Page command preparation timed out');
      return {
        success: false,
        reason: PRE_FANOUT_COMMAND_TIMEOUT_REASON,
        isTransportFailure: true,
      };
    }

    logger.error('Error handling page translation message:', error);
    return { success: false, error: error.message };
  }
}

// Handle navigation events to persistent auto-translation across same-tab link clicks
if (typeof browser !== 'undefined' && browser.webNavigation) {
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) {
      clearPendingManualFrameReadiness(details.tabId, details.frameId);
      return scheduleFrameRetirement(details.tabId, details.frameId);
    }

    const tabId = details.tabId;
    clearPendingManualFrameReadiness(tabId);
    const transitionType = details.transitionType;
    const restartFence = pageNavigationTracker.mintRestartFence(tabId);

    // Check if this tab was auto-translating
    if (autoTranslateRegistry.has(tabId)) {
      // 1. If it's a RELOAD or manual TYPED entry -> STOP translation as per user requirement
      if (transitionType === 'reload' || transitionType === 'typed') {
        logger.debug(`Stopping auto-translation for tab ${tabId} due to ${transitionType}`);
        autoTranslateRegistry.delete(tabId);
        return;
      }

      // 2. If it's a LINK click or FORM_SUBMIT -> CONTINUE translation
      const allowedPersistence = ['link', 'form_submit', 'auto_bookmark', 'manual_subframe'];
      if (allowedPersistence.includes(transitionType)) {
        logger.debug(`Persisting auto-translation for tab ${tabId} on navigation (${transitionType})`);
        
        // Wait for page to load a bit before sending translate message
        void pageNavigationTracker.pending.then(() => pageNavigationTracker.getCursor(tabId, 0)).then(navigationCursor => {
          if (!navigationCursor || navigationCursor.url !== details.url) return;
          const restart = () => {
            if (pageNavigationTracker.getRestartFence(tabId) !== restartFence) return Promise.resolve(null);
            return handlePageTranslation({
              action: MessageActions.PAGE_TRANSLATE,
              data: { isAuto: true, navigationCursor, restartFence },
            }, { tab: { id: tabId } });
          };
          setTimeout(() => { void restart()
            .then(result => {
              if (result?.isTransportFailure && !result.reason) throw new Error('Content script not ready');
            })
            .catch(() => {
              // If fails (page not ready), try once more after 2 seconds.
              setTimeout(() => { void restart().catch(() => {}); }, 2000);
            }); }, 1000);
        }).catch(() => {});
      }
    }
  });

  // Cleanup on tab closure
  browser.tabs.onRemoved.addListener((tabId) => {
    clearPendingManualFrameReadiness(tabId);
    autoTranslateRegistry.delete(tabId);
    pageNavigationTracker.revokeRestartFence(tabId);
    const tabKeyPrefix = `${tabId}:`;
    for (const key of pendingFrameRetirements.keys()) {
      if (key.startsWith(tabKeyPrefix)) {
        pendingFrameRetirements.delete(key);
      }
    }
  });
}

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingCore.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingConstants.js';
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
const pendingManualStartOwners = new Map();
const pendingInitialFrameStarts = new Map();

function initialFrameLeaseKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function createInitialFrameLease(owner, frameId, documentId) {
  let resolveIdentity;
  let resolveSettlement;
  const lease = {
    owner, frameId, kind: 'initial', documentId: documentId || null, documentToken: null,
    identityResolved: false, waiters: [],
    identityPromise: new Promise(resolve => { resolveIdentity = resolve; }),
    settled: false,
    settlementPromise: new Promise(resolve => { resolveSettlement = resolve; }),
    resolveIdentity(identity) {
      if (lease.identityResolved) return;
      lease.documentId = identity?.documentId || lease.documentId;
      lease.documentToken = identity?.documentToken || null;
      lease.identityResolved = true;
      resolveIdentity();
    },
    resolveSettlement() {
      if (lease.settled) return;
      lease.settled = true;
      resolveSettlement();
    },
  };
  return lease;
}

function markInitialReservationsReady(owner) {
  if (!owner || owner.initialReservationsResolved) return;
  owner.initialReservationsResolved = true;
  owner.resolveInitialReservations();
}

async function findInitialFrameLease(tabId, frameId, documentId, documentToken) {
  const leases = pendingInitialFrameStarts.get(initialFrameLeaseKey(tabId, frameId)) || [];
  for (const lease of leases) {
    if (lease.kind !== 'initial') continue;
    await lease.identityPromise;
    if ((documentId && lease.documentId && documentId === lease.documentId)
        || (documentToken && lease.documentToken && documentToken === lease.documentToken)) {
      return lease;
    }
  }
  return null;
}

function findMatchingLiveInitialFrameLease(tabId, frameId, documentId, documentToken) {
  const leases = pendingInitialFrameStarts.get(initialFrameLeaseKey(tabId, frameId)) || [];
  return leases.find(lease => {
    if (lease.kind !== 'initial' || lease.settled) return false;
    if (documentId && lease.documentId && documentId !== lease.documentId) return false;
    if (documentToken && lease.documentToken && documentToken !== lease.documentToken) return false;
    if (documentId && lease.documentId && documentToken && lease.documentToken) return true;
    if (documentToken && lease.documentToken) return documentToken === lease.documentToken;
    return !lease.identityResolved
      || Boolean(documentId && lease.documentId && documentId === lease.documentId);
  });
}

function releaseInitialFrameLease(lease) {
  if (lease.settled) return lease.replayPromise || Promise.resolve();
  const key = initialFrameLeaseKey(lease.owner.tabId, lease.frameId);
  const leases = pendingInitialFrameStarts.get(key) || [];
  const remaining = leases.filter(candidate => candidate !== lease);
  if (remaining.length) pendingInitialFrameStarts.set(key, remaining);
  else pendingInitialFrameStarts.delete(key);
  if (!lease.identityResolved) lease.resolveIdentity(null);
  lease.resolveSettlement();
  if (lease.suppressReadinessReplay) return Promise.resolve();
  const replayTasks = [];
  for (const waiter of lease.waiters) {
    replayTasks.push((async () => {
      const grant = await pageNavigationTracker.getManualContinuity(waiter.sender.tab.id);
      const currentOwner = pendingManualStartOwners.get(waiter.sender.tab.id);
      if (waiter.owner?.invalidated || (currentOwner && currentOwner !== waiter.owner)
          || (!currentOwner && !grantMatchesManualAttempt(grant, waiter.attemptId, waiter.attemptRevision))) return;
      const ticket = await handlePageTranslation(waiter.message, waiter.sender);
      const latestGrant = await pageNavigationTracker.getManualContinuity(waiter.sender.tab.id);
      const latestOwner = pendingManualStartOwners.get(waiter.sender.tab.id);
      if (waiter.message.action === MessageActions.PAGE_TRANSLATE_FRAME_READY
          && ticket?.success && ticket.start
          && !lease.suppressReadinessReplay
          && !waiter.owner?.invalidated
          && (!latestOwner || latestOwner === waiter.owner)
          && latestGrant?.armed
          && grantMatchesManualAttempt(latestGrant, waiter.attemptId, waiter.attemptRevision)
          && ticket.manualContinuityAttemptId === waiter.attemptId
          && String(ticket.manualContinuityAttemptRevision) === String(waiter.attemptRevision)) {
        await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_FRAME_START,
          data: { ...waiter.message.data, ...ticket },
        }, waiter.sender);
      }
    })().catch(error => logger.debug('Deferred competing frame start failed:', error?.message)));
  }
  lease.replayPromise = Promise.all(replayTasks);
  return lease.replayPromise;
}

export async function revokeManualPageAuthority(tabId) {
  if (!Number.isInteger(tabId)) return false;
  pageNavigationTracker.revokeRestartFence(tabId);
  const owner = pendingManualStartOwners.get(tabId);
  if (owner) owner.invalidated = true;
  const revision = pageNavigationTracker.blockManualContinuity(tabId);
  releaseManualStartOwner(owner);
  let result = await revokeManualContinuity(tabId, null, revision);
  if (result.error) result = await revokeManualContinuity(tabId, null, revision);
  if (!result.error && result.generation != null) clearPendingManualFrameReadiness(tabId);
  return !result.error && result.generation != null;
}

function releaseManualStartOwner(owner, expectedGeneration = null) {
  if (owner && pendingManualStartOwners.get(owner.tabId) === owner
      && (expectedGeneration == null || owner.generation === expectedGeneration)) {
    markInitialReservationsReady(owner);
    pendingManualStartOwners.delete(owner.tabId);
    for (const [key, pending] of pendingManualFrameReadiness) {
      if (pending.owner === owner && !pending.registering && !pending.dispatching) {
        pendingManualFrameReadiness.delete(key);
      }
    }
    return true;
  }
  return false;
}

function getFrameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function getManualReadinessKey(tabId, frameId, documentToken, owner) {
  return `${tabId}:${frameId}:${documentToken}:${owner.attemptId}`;
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
    if (pending.dispatching) continue;
    pending.dispatching = true;
    void pageNavigationTracker.getManualContinuity(tabId).then(async grant => {
      if (pendingManualFrameReadiness.get(key) !== pending) return;
      if (!grant?.armed || !grantMatchesManualAttempt(
        grant, pending.attemptId, pending.attemptRevision,
      )
          || (pending.owner?.generation != null && grant.generation !== pending.owner.generation)) {
        pending.dispatching = false;
        if (!grant?.armed) pendingManualFrameReadiness.delete(key);
        return;
      }
      pendingManualFrameReadiness.delete(key);
      const childSender = {
        tab: { id: tabId }, frameId: pending.frameId,
        ...(pending.documentId && { documentId: pending.documentId }),
      };
      const ticket = await handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
        data: {
          documentToken: pending.documentToken,
          deferredManualAttemptId: pending.attemptId,
          deferredManualAttemptRevision: pending.attemptRevision,
          deferredManualGeneration: grant.generation,
        },
      }, childSender);
      if (!pending.suppressReplay && ticket?.success && ticket.start) {
        void handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_FRAME_START,
          data: {
            ...ticket, documentToken: pending.documentToken,
            deferredManualAttemptId: pending.attemptId,
            deferredManualAttemptRevision: pending.attemptRevision,
            deferredManualGeneration: grant.generation,
          },
        }, childSender).catch(error => logger.debug('Deferred iframe START failed:', error?.message));
      }
    }).catch(error => {
      pending.dispatching = false;
      logger.debug('Deferred iframe admission failed:', error?.message);
    });
  }
}

async function queueManualFrameReadiness(key, details) {
  const { tabId, frameId, documentToken, documentId, owner } = details;
  let pending = pendingManualFrameReadiness.get(key);
  if (!pending || (pending.owner !== owner && !pending.dispatching)) {
    pending = {
      tabId, frameId, documentToken, documentId, owner,
      attemptId: owner.attemptId, attemptRevision: owner.attemptRevision,
    };
    pendingManualFrameReadiness.set(key, pending);
  }
  if (pending.dispatching) return { success: true, pending: true };
  pending.registering = true;
  let grant;
  try {
    grant = await pageNavigationTracker.getManualContinuity(tabId);
  } catch {
    pending.registering = false;
    if (pendingManualStartOwners.get(tabId) !== pending.owner) {
      pendingManualFrameReadiness.delete(key);
    }
    return { success: false, reason: 'obsolete_navigation' };
  }
  const currentOwner = pendingManualStartOwners.get(tabId);
  const stillQueued = pendingManualFrameReadiness.get(key) === pending;
  const exactGrant = grantMatchesManualAttempt(grant, pending.attemptId, pending.attemptRevision)
    && (pending.owner?.generation == null || grant.generation === pending.owner.generation);
  const ownerIsCurrent = !currentOwner || currentOwner === pending.owner;
  pending.registering = false;
  if (!stillQueued || (!ownerIsCurrent && !(exactGrant && grant.armed))
      || (!currentOwner && !(exactGrant && grant?.armed))) {
    if (stillQueued) pendingManualFrameReadiness.delete(key);
    return { success: false, reason: 'obsolete_navigation' };
  }
  if (exactGrant && grant.armed) resumePendingManualFrameReadiness(tabId);
  return { success: true, pending: true };
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
  boundNavigation = null,
  onLateResult = null,
  targetDocumentId = null,
  absoluteDeadlineAt = null,
  dispatchGuard = null
) {
  let timeoutId;
  const responseDeadlineAt = absoluteDeadlineAt ?? (Date.now() + deadlineMs);
  let expired = Date.now() >= responseDeadlineAt;
  let dispatchedCursor = null;
  let didDispatch = false;
  try {
    const sendPromise = (async () => {
      if (message.action === MessageActions.PAGE_TRANSLATE && !message.data?.navigationUnavailable) {
        let data;
        try {
          const navigationCursor = await pageNavigationTracker.getAdmissionCursor(tabId, frameId);
          dispatchedCursor = navigationCursor;
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
       if (expired) {
         const timeoutError = new Error(`Frame ${frameId} command response timed out`);
         timeoutError.isResponseTimeout = true;
         throw timeoutError;
       }
       if (dispatchGuard && !dispatchGuard()) return null;
       didDispatch = true;
      try {
        const response = await browser.tabs.sendMessage(tabId, message, {
          frameId, ...(targetDocumentId && { documentId: targetDocumentId }),
        });
        await onLateResult?.({ response, navigationCursor: dispatchedCursor });
        return response;
      } catch (error) {
        await onLateResult?.({ error, navigationCursor: dispatchedCursor });
        throw error;
      }
    })();
    const response = await Promise.race([
      sendPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          expired = true;
          const timeoutError = new Error(`Frame ${frameId} command response timed out`);
          timeoutError.isResponseTimeout = true;
          reject(timeoutError);
        }, Math.max(0, responseDeadlineAt - Date.now()));
      }),
    ]);
    return { frameId, response, navigationCursor: dispatchedCursor, isResponseTimeout: false, wasDispatched: didDispatch };
  } catch (error) {
    // Promise.race keeps handlers attached to the losing send promise, so late
    // rejections after a timeout settle here without becoming unhandled.
    if (error?.isResponseTimeout === true) {
      return { frameId, response: null, navigationCursor: dispatchedCursor, isResponseTimeout: true, wasDispatched: didDispatch };
    }
    logger.debug(`Could not send to frame ${frameId}:`, error.message);
    return { frameId, response: null, navigationCursor: dispatchedCursor, isResponseTimeout: false, wasDispatched: didDispatch };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sameCursor(a, b) {
  return Boolean(a && b && a.documentEpoch === b.documentEpoch
    && a.routeRevision === b.routeRevision && a.url === b.url);
}

function matchesFrameAttempt(grant, frameId, data, revoked = false) {
  const prefix = revoked ? 'revoked' : '';
  const acceptedIds = grant?.[`${prefix}AcceptedAttemptIds`] ?? grant?.acceptedAttemptIds;
  const acceptedRevisions = grant?.[`${prefix}AcceptedAttemptRevisions`] ?? grant?.acceptedAttemptRevisions;
  const acceptedDocuments = grant?.[`${prefix}AcceptedDocuments`] ?? grant?.acceptedDocuments;
  const provisionalIds = grant?.[`${prefix}ProvisionalAttemptIds`] ?? grant?.provisionalAttemptIds;
  const provisionalRevisions = grant?.[`${prefix}ProvisionalAttemptRevisions`] ?? grant?.provisionalAttemptRevisions;
  const provisionalDocuments = grant?.[`${prefix}ProvisionalDocuments`] ?? grant?.provisionalDocuments;
  const attemptId = data.manualContinuityAttemptId;
  const attemptRevision = String(data.manualContinuityAttemptRevision);
  const documentToken = data.documentToken;
  return (acceptedIds?.[frameId] === attemptId
      && acceptedRevisions?.[frameId] === attemptRevision && acceptedDocuments?.[frameId] === documentToken)
    || (provisionalIds?.[frameId] === attemptId
      && provisionalRevisions?.[frameId] === attemptRevision && provisionalDocuments?.[frameId] === documentToken);
}

function matchesProvisionalFrameAttempt(grant, frameId, data, revoked = false) {
  const prefix = revoked ? 'revoked' : '';
  const ids = grant?.[`${prefix}ProvisionalAttemptIds`] ?? grant?.provisionalAttemptIds;
  const revisions = grant?.[`${prefix}ProvisionalAttemptRevisions`] ?? grant?.provisionalAttemptRevisions;
  const documents = grant?.[`${prefix}ProvisionalDocuments`] ?? grant?.provisionalDocuments;
  return ids?.[frameId] === data.manualContinuityAttemptId
    && revisions?.[frameId] === String(data.manualContinuityAttemptRevision)
    && documents?.[frameId] === data.documentToken;
}

function grantMatchesManualAttempt(grant, attemptId, attemptRevision) {
  return (grant?.attemptId === attemptId && grant?.attemptRevision === attemptRevision)
    || Object.entries(grant?.acceptedAttemptIds || {}).some(([frameId, id]) => (
      id === attemptId && grant.acceptedAttemptRevisions?.[frameId] === String(attemptRevision)
    ));
}

function hasDynamicManualAttempt(grant, tabId, attemptId, attemptRevision) {
  const acceptedAttemptCount = Object.keys(grant?.acceptedAttemptIds || {}).length;
  return acceptedAttemptCount > 0
    ? pageNavigationTracker.hasAcceptedManualAttempt(tabId, grant?.generation, attemptId, attemptRevision)
    : Boolean(grant?.armed && pageNavigationTracker.hasConfirmedManualAttempt(
      tabId, grant.generation, attemptId, attemptRevision,
    ));
}

function latestAcceptedManualAttempt(grant, tabId) {
  let latest = null;
  for (const [frameId, attemptId] of Object.entries(grant?.acceptedAttemptIds || {})) {
    const attemptRevision = Number(grant.acceptedAttemptRevisions?.[frameId]);
    if (Number.isSafeInteger(attemptRevision) && (!latest || attemptRevision > latest.attemptRevision)) {
      latest = { attemptId, attemptRevision };
    }
  }
  if (!latest && grant?.armed && typeof grant.confirmedAttemptId === 'string') {
    const attemptRevision = Number(grant.confirmedAttemptRevision);
    if (Number.isSafeInteger(attemptRevision)
        && pageNavigationTracker.hasConfirmedManualAttempt(
          tabId, grant.generation, grant.confirmedAttemptId, attemptRevision,
        )) {
      latest = { attemptId: grant.confirmedAttemptId, attemptRevision };
    }
  }
  return latest;
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
  const cutoffGeneration = expectedGeneration
    ?? (pageNavigationTracker.getManualContinuityCutoff(tabId) || null);
  const revokePromise = pageNavigationTracker.revokeManualContinuity(tabId, expectedGeneration, revision);
  try {
    const generation = await revokePromise;
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

async function settleBeforeDeadline(promise, deadlineAt) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve({ timedOut: true }), Math.max(0, deadlineAt - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve Whole Page command preparation under one shared deadline.
 * Immediate preparation failures keep their existing error handling; only a
 * stalled preparation stage is converted to the timeout marker.
 */
async function runPreFanoutPreparation(message, sender, discoverFrames = true, onTargetResolved = null) {
  let timeoutId;
  let expired = false;
  const deadlineAt = Date.now() + PRE_FANOUT_COMMAND_TIMEOUT_MS;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
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

    if (expired) return { error: { success: false, reason: PRE_FANOUT_COMMAND_TIMEOUT_REASON, isTransportFailure: true } };
    const targetResolution = onTargetResolved?.(targetTabId);
    if (targetResolution?.success === false || targetResolution?.error) {
      return { error: targetResolution };
    }
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
    return { targetTabId, access, allFrames, navigationUnavailable, navigationAdmissionInvalid, deadlineAt };
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
  let manualStartOwner = null;
  let manualGrant = null;
  try {
    const senderTabId = sender?.tab?.id;
    if (message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO && message.data?.settingsInvalidation === true) {
      const frameId = sender?.frameId;
      const generation = message.data.expectedManualContinuityGeneration;
      if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId < 0
          || !Number.isSafeInteger(generation)
          || !Number.isSafeInteger(message.data.topDocumentEpoch)
          || !Number.isSafeInteger(message.data.manualContinuityAttemptRevision)
          || typeof message.data.manualContinuityAttemptId !== 'string'
          || !message.data.manualContinuityAttemptId
          || typeof message.data.documentToken !== 'string' || !message.data.documentToken) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      const [access, grant] = await Promise.all([
        tabPermissionChecker.checkTabAccess(senderTabId),
        pageNavigationTracker.getManualContinuityForRevocation(senderTabId),
      ]);
      const retry = grant?.revoked === true;
      const grantGeneration = retry ? grant.revokedGeneration : grant?.generation;
      const topDocumentEpoch = retry ? grant.revokedTopDocumentEpoch : grant?.topDocumentEpoch;
      const topDocumentToken = retry ? grant.revokedTopDocumentToken : grant?.topDocumentToken;
      const frames = retry ? grant.revokedFrames : grant?.frames;
      if (!access.isAccessible || (!retry && !grant?.armed
          && !matchesProvisionalFrameAttempt(grant, frameId, message.data)) || grantGeneration !== generation
          || topDocumentEpoch !== message.data.topDocumentEpoch
          || !matchesFrameAttempt(grant, frameId, message.data, retry)) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      const [senderCursor, { documentToken: currentSenderToken }] = await Promise.all([
        pageNavigationTracker.getAdmissionCursor(senderTabId, frameId),
        probeFrameDocument(senderTabId, frameId),
      ]);
      if ((frameId === 0 && senderCursor?.documentEpoch !== topDocumentEpoch)
          || (frameId > 0 && senderCursor?.documentEpoch !== frames?.[frameId])
          || currentSenderToken !== message.data.documentToken) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      const { documentToken } = await probeFrameDocument(senderTabId, 0);
      const currentGrant = await pageNavigationTracker.getManualContinuityForRevocation(senderTabId);
      const currentRetry = currentGrant?.revoked === true;
      if (documentToken !== topDocumentToken
          || (currentRetry ? currentGrant.revokedGeneration : currentGrant?.generation) !== generation
          || (!currentRetry && !currentGrant?.armed
            && !matchesProvisionalFrameAttempt(currentGrant, frameId, message.data))
          || (currentRetry ? currentGrant.revokedTopDocumentEpoch : currentGrant?.topDocumentEpoch) !== message.data.topDocumentEpoch
          || !matchesFrameAttempt(currentGrant, frameId, message.data, currentRetry)
          || !pageNavigationTracker.isManualFrameAttemptCurrent(
            senderTabId, generation, frameId, message.data.manualContinuityAttemptId,
            message.data.manualContinuityAttemptRevision, message.data.documentToken, { includeRevoked: true }
          )) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
    }
    if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_READY
        || message.action === MessageActions.PAGE_TRANSLATE_FRAME_START) {
      const frameId = sender?.frameId;
      const data = message.data || {};
      if (!Number.isInteger(senderTabId) || !Number.isInteger(frameId) || frameId <= 0
          || typeof data.documentToken !== 'string' || !data.documentToken) {
        return { success: false, reason: 'ineligible_frame' };
      }
      const initialOwner = pendingManualStartOwners.get(senderTabId);
      if (initialOwner && !initialOwner.initialReservationsResolved) {
        await initialOwner.initialReservationsReady;
      }
      const access = await tabPermissionChecker.checkTabAccess(senderTabId);
      if (!access.isAccessible) return { success: false, reason: 'ineligible_frame' };
      const [grant, frame] = await Promise.all([
        pageNavigationTracker.getManualContinuity(senderTabId),
        browser.webNavigation.getFrame({ tabId: senderTabId, frameId }),
      ]);
      const deferredManualAttemptId = data.deferredManualAttemptId;
      const isDeferredReplay = typeof deferredManualAttemptId === 'string';
      if (isDeferredReplay && (!grant?.armed
          || grant.generation !== data.deferredManualGeneration
          || !grantMatchesManualAttempt(
            grant, deferredManualAttemptId, data.deferredManualAttemptRevision,
          ))) {
        return { success: false, reason: 'obsolete_navigation' };
      }
      const owner = pendingManualStartOwners.get(senderTabId);
      if (!grant && owner && frame && isEligibleManualFrameUrl(frame.url)) {
        const [{ documentToken: currentToken }, { documentToken: currentTopToken }, topCursor] = await Promise.all([
          probeFrameDocument(senderTabId, frameId),
          probeFrameDocument(senderTabId, 0),
          pageNavigationTracker.getAdmissionCursor(senderTabId, 0),
        ]);
        const { checkUrlExclusionAsync } = await import('@/features/exclusion/utils/exclusion-utils.js');
        const [currentOwner, currentGrant] = await Promise.all([
          Promise.resolve(pendingManualStartOwners.get(senderTabId)),
          pageNavigationTracker.getManualContinuity(senderTabId),
        ]);
        const grantMatchesOwner = currentGrant?.attemptId === owner.attemptId
          && currentGrant.attemptRevision === owner.attemptRevision
          && (owner.generation == null || currentGrant.generation === owner.generation);
        if (currentToken !== data.documentToken || !currentTopToken || !topCursor
            || (sender?.documentId && frame.documentId && sender.documentId !== frame.documentId)
            || await checkUrlExclusionAsync(frame.url)
            || (currentOwner && currentOwner !== owner
              && !(grantMatchesOwner && currentGrant.armed))
            || (!currentOwner && (!grantMatchesOwner || !currentGrant.armed
              || currentGrant.topDocumentToken !== currentTopToken
              || currentGrant.topDocumentEpoch !== topCursor.documentEpoch))) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        const readinessKey = getManualReadinessKey(senderTabId, frameId, data.documentToken, owner);
        return queueManualFrameReadiness(readinessKey, {
          tabId: senderTabId, frameId, documentToken: data.documentToken,
          documentId: sender?.documentId || frame.documentId,
          owner,
        });
      }
      if (!grant || !frame || !isEligibleManualFrameUrl(frame.url)) {
        return { success: false, reason: 'ineligible_frame' };
      }
      if (sender?.documentId && frame.documentId && sender.documentId !== frame.documentId) {
        return { success: false, reason: 'obsolete_navigation' };
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
      const currentGrant = await pageNavigationTracker.getManualContinuity(senderTabId);
      if (!currentGrant || currentGrant.generation !== grant.generation || currentGrant.revoked
          || currentGrant.topDocumentEpoch !== grant.topDocumentEpoch
          || currentGrant.topDocumentToken !== grant.topDocumentToken
          || (isDeferredReplay && (!currentGrant.armed
            || currentGrant.generation !== data.deferredManualGeneration
            || !grantMatchesManualAttempt(
              currentGrant, deferredManualAttemptId, data.deferredManualAttemptRevision,
            )))) {
        return { success: false, reason: 'obsolete_navigation' };
      }

      const initialLease = await findInitialFrameLease(
        senderTabId, frameId, sender?.documentId || frame.documentId, data.documentToken,
      );
      const frameLeases = pendingInitialFrameStarts.get(initialFrameLeaseKey(senderTabId, frameId));
      if (initialLease && !initialLease.settled && frameLeases?.includes(initialLease)) {
        if (initialLease.owner !== owner
            || pendingManualStartOwners.get(senderTabId) !== owner
            || owner?.invalidated
            || pageNavigationTracker.manualContinuityRevision.get(senderTabId) !== owner?.attemptRevision) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_START && owner
            && (data.manualContinuityAttemptId !== owner.attemptId
              || String(data.manualContinuityAttemptRevision) !== String(owner.attemptRevision))) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        const authorizedAttempt = message.action === MessageActions.PAGE_TRANSLATE_FRAME_START
          ? { attemptId: data.manualContinuityAttemptId, attemptRevision: data.manualContinuityAttemptRevision }
            : isDeferredReplay
              ? { attemptId: deferredManualAttemptId, attemptRevision: data.deferredManualAttemptRevision }
              : owner
                ? { attemptId: owner.attemptId, attemptRevision: owner.attemptRevision }
                : latestAcceptedManualAttempt(currentGrant, senderTabId);
        if (typeof authorizedAttempt?.attemptId !== 'string'
            || !Number.isSafeInteger(Number(authorizedAttempt.attemptRevision))) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        if (!initialLease.waiters.some(waiter => waiter.message.action === message.action
            && waiter.message.data?.documentToken === data.documentToken
            && waiter.attemptId === authorizedAttempt.attemptId
            && waiter.attemptRevision === Number(authorizedAttempt.attemptRevision)
            && waiter.owner === owner)) {
          if (initialLease.settled
              || !pendingInitialFrameStarts.get(initialFrameLeaseKey(senderTabId, frameId))?.includes(initialLease)
              || pendingManualStartOwners.get(senderTabId) !== owner
              || owner?.invalidated) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          initialLease.waiters.push({
            message, sender, owner,
            attemptId: authorizedAttempt.attemptId,
            attemptRevision: Number(authorizedAttempt.attemptRevision),
          });
        }
        return { success: true, pending: true };
      }

      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_READY) {
        if (!currentGrant.armed) {
          const currentOwner = pendingManualStartOwners.get(senderTabId);
          if (!currentOwner || currentOwner.attemptId !== currentGrant.attemptId
              || currentOwner.attemptRevision !== currentGrant.attemptRevision) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          const readinessKey = getManualReadinessKey(senderTabId, frameId, data.documentToken, currentOwner);
          return queueManualFrameReadiness(readinessKey, {
            tabId: senderTabId, frameId, documentToken: data.documentToken,
            documentId: sender?.documentId || frame.documentId, owner: currentOwner,
          });
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
        const currentAttempt = latestAcceptedManualAttempt(admission.grant, senderTabId);
        if (isDeferredReplay && (currentAttempt?.attemptId !== deferredManualAttemptId
            || currentAttempt?.attemptRevision !== data.deferredManualAttemptRevision)) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        return {
          success: true,
          start: admission.grant.startedDocuments?.[frameId] !== data.documentToken,
          documentToken: data.documentToken,
          manualContinuityGeneration: grant.generation,
          manualContinuityAttemptRevision: currentAttempt?.attemptRevision,
          manualContinuityAttemptId: currentAttempt?.attemptId,
          topDocumentEpoch: grant.topDocumentEpoch,
          navigationCursor: admission.cursor,
          provider: grant.provider,
          targetLanguage: grant.targetLanguage,
          isExplicitProvider: grant.isExplicitProvider,
        };
      }

      const { navigationCursor, manualContinuityGeneration, topDocumentEpoch } = data;
      if ((isDeferredReplay && (manualContinuityGeneration !== data.deferredManualGeneration
          || data.manualContinuityAttemptId !== deferredManualAttemptId
          || data.manualContinuityAttemptRevision !== data.deferredManualAttemptRevision))
          || manualContinuityGeneration !== grant.generation
          || !hasDynamicManualAttempt(
            grant, senderTabId, data.manualContinuityAttemptId, data.manualContinuityAttemptRevision,
          )
          || topDocumentEpoch !== grant.topDocumentEpoch
          || !sameCursor(navigationCursor, await pageNavigationTracker.getAdmissionCursor(senderTabId, frameId))
          || !await pageNavigationTracker.validateManualContinuity(
           senderTabId, frameId, grant.generation, grant.topDocumentEpoch, navigationCursor
           )) return { success: false, reason: 'obsolete_navigation' };
      const attemptId = data.manualContinuityAttemptId;
      const attemptRevision = data.manualContinuityAttemptRevision;
      const latestGrant = await pageNavigationTracker.getManualContinuity(senderTabId);
      if (!latestGrant || latestGrant.generation !== grant.generation || latestGrant.revoked
          || !hasDynamicManualAttempt(latestGrant, senderTabId, attemptId, attemptRevision)) {
        return { success: false, reason: 'obsolete_navigation' };
      }
      const currentOwner = pendingManualStartOwners.get(senderTabId);
      const documentId = sender?.documentId || frame.documentId;
      const matchingInitialLease = findMatchingLiveInitialFrameLease(
        senderTabId, frameId, documentId, data.documentToken,
      );
      if (matchingInitialLease
          && pendingInitialFrameStarts.get(initialFrameLeaseKey(senderTabId, frameId))
            ?.includes(matchingInitialLease)) {
        if (currentOwner?.invalidated) return { success: false, reason: 'obsolete_navigation' };
        const waiterOwner = currentOwner || null;
        if (!matchingInitialLease.waiters.some(waiter => waiter.message.action === message.action
            && waiter.message.data?.documentToken === data.documentToken
            && waiter.attemptId === attemptId
            && String(waiter.attemptRevision) === String(attemptRevision)
            && waiter.owner === waiterOwner)) {
          matchingInitialLease.waiters.push({
            message, sender, owner: waiterOwner, attemptId,
            attemptRevision: Number(attemptRevision),
          });
        }
        return { success: true, pending: true };
      }
      const dynamicLease = createInitialFrameLease(
        { tabId: senderTabId, attemptId, attemptRevision, generation: grant.generation },
        frameId, documentId,
      );
      dynamicLease.kind = 'dynamic';
      dynamicLease.resolveIdentity({ documentId, documentToken: data.documentToken });
      const leaseKey = initialFrameLeaseKey(senderTabId, frameId);
      const reservations = pendingInitialFrameStarts.get(leaseKey) || [];
      reservations.push(dynamicLease);
      pendingInitialFrameStarts.set(leaseKey, reservations);
      // No await between the owner check and reservation: initial starts observe this delivery.
       if (pendingManualStartOwners.get(senderTabId) !== currentOwner) {
        releaseInitialFrameLease(dynamicLease);
        return { success: false, reason: 'obsolete_navigation' };
      }
      let claimed;
      try {
        claimed = await pageNavigationTracker.claimManualFrameStart(
          senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
          grant.topDocumentToken, navigationCursor, data.documentToken, attemptId, attemptRevision
        );
      } catch (error) {
        await pageNavigationTracker.completeManualFrameStart(
          senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
          grant.topDocumentToken, navigationCursor, data.documentToken, false, attemptId, attemptRevision
        ).catch(() => {});
        releaseInitialFrameLease(dynamicLease);
        throw error;
      }
      if (!claimed) {
        releaseInitialFrameLease(dynamicLease);
        if (!hasDynamicManualAttempt(grant, senderTabId, attemptId, attemptRevision)) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        return { success: true, skipped: true, reason: 'duplicate_or_revoked_admission' };
      }
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
          grant.topDocumentToken, navigationCursor, data.documentToken, attemptId, attemptRevision
        )) return { success: false, reason: 'obsolete_navigation' };
        const pendingDelivery = browser.tabs.sendMessage(senderTabId, {
          action: MessageActions.PAGE_TRANSLATE,
          data: {
            isAuto: false,
            hasManualContinuity: true,
            manualContinuityGeneration: grant.generation,
            manualContinuityAttemptRevision: attemptRevision,
            manualContinuityAttemptId: attemptId,
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
            grant.topDocumentToken, navigationCursor, data.documentToken, response?.success === true,
            attemptId, attemptRevision
          ).catch(error => logger.debug('Could not persist iframe START acceptance:', error?.message));
          return { response };
        }, async error => {
          await pageNavigationTracker.completeManualFrameStart(
            senderTabId, frameId, grant.generation, grant.topDocumentEpoch,
            grant.topDocumentToken, navigationCursor, data.documentToken, false, attemptId, attemptRevision
          ).catch(() => {});
          return { error };
        }).finally(() => releaseInitialFrameLease(dynamicLease));
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
            grant.topDocumentToken, navigationCursor, data.documentToken, false, attemptId, attemptRevision
          ).catch(() => {});
          releaseInitialFrameLease(dynamicLease);
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
    const explicitInvalidation = [
      MessageActions.PAGE_RESTORE,
      MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      MessageActions.CANCEL_TRANSLATION,
    ].includes(message.action) || (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.cancel === true
    ) || (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.isAuto !== true
    );
    const internalBatchAbort = message.action === MessageActions.CANCEL_TRANSLATION
      && message.data?.context === MessageContexts.PAGE_TRANSLATION_BATCH
      && message.data?.reason === 'operation-abort';
    if (Number.isInteger(senderTabId) && isManualRevocation
        && Number.isSafeInteger(message.data?.expectedManualContinuityGeneration)) {
      const ownerAtAuthorizationStart = pendingManualStartOwners.get(senderTabId);
      const status = await pageNavigationTracker.getManualContinuityStatus(senderTabId).catch(() => null);
      const owner = pendingManualStartOwners.get(senderTabId);
      const currentGrant = message.data?.settingsInvalidation === true
        ? await pageNavigationTracker.getManualContinuityForRevocation(senderTabId).catch(() => null) : null;
      if ((ownerAtAuthorizationStart && owner && owner !== ownerAtAuthorizationStart)
          || (!ownerAtAuthorizationStart && owner)
          || pendingManualStartOwners.get(senderTabId) !== owner
          || (Number.isSafeInteger(message.data.expectedManualContinuityGeneration)
            && owner && owner.generation !== message.data.expectedManualContinuityGeneration)) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      if (!status || (status.manualContinuityGeneration !== message.data.expectedManualContinuityGeneration
          && !(status.hasManualContinuity === false
            && status.manualContinuityGeneration > message.data.expectedManualContinuityGeneration)
          && owner?.generation !== message.data.expectedManualContinuityGeneration)) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      const currentRetry = currentGrant?.revoked === true;
      if (message.data?.settingsInvalidation === true
          && ((currentRetry ? currentGrant.revokedGeneration : currentGrant?.generation)
              !== message.data.expectedManualContinuityGeneration
            || !matchesFrameAttempt(currentGrant, sender?.frameId, message.data, currentRetry)
            || !pageNavigationTracker.isManualFrameAttemptCurrent(
              senderTabId, message.data.expectedManualContinuityGeneration, sender?.frameId,
              message.data.manualContinuityAttemptId, message.data.manualContinuityAttemptRevision,
              message.data.documentToken, { includeRevoked: currentRetry }
            ))) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
    }
    if (Number.isInteger(senderTabId) && explicitInvalidation) {
      pageNavigationTracker.revokeRestartFence(senderTabId);
      if (isManualRevocation && !internalBatchAbort) {
        const expectedGeneration = message.data?.expectedManualContinuityGeneration;
        const owner = pendingManualStartOwners.get(senderTabId);
        const ownerAuthorized = owner && pendingManualStartOwners.get(senderTabId) === owner
          && (expectedGeneration == null || owner.generation === expectedGeneration);
        if (ownerAuthorized || (expectedGeneration == null && !owner)) {
          clearPendingManualFrameReadiness(senderTabId);
        }
        if (ownerAuthorized) owner.invalidated = true;
        releaseManualStartOwner(owner, expectedGeneration);
      }
      if (isManualRevocation && !internalBatchAbort) {
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
            || !(/^(https?:\/\/|file:\/\/)/i.test(data.navigationCursor?.url || '')
              && (!/^file:/i.test(data.navigationCursor.url)
                || (data.origin === 'manual-start' && frameId === 0)))
            || (data.origin === 'manual-spa' && (typeof data.restartFence !== 'string' || !data.restartFence
              || pageNavigationTracker.getRestartFence(senderTabId) !== data.restartFence))) {
          return { success: false, reason: 'obsolete_navigation' };
        }
        try {
          const access = await tabPermissionChecker.checkTabAccess(senderTabId);
          if (!access.isAccessible) return { success: false, reason: 'ineligible_frame' };
          const grant = await pageNavigationTracker.getManualContinuity(senderTabId);
          const startOwner = pendingManualStartOwners.get(senderTabId);
          const isPendingManualStart = data.origin === 'manual-start'
            && startOwner?.generation === grant?.generation
            && startOwner.attemptId === data.manualContinuityAttemptId
            && startOwner.attemptRevision === data.manualContinuityAttemptRevision;
          const isLegacyInitialManualStart = data.origin === 'manual-start'
            && grant?.handlerManaged !== true && !grant?.armed
            && data.manualContinuityAttemptRevision === grant?.attemptRevision
            && data.manualContinuityAttemptId === grant?.attemptId
            && pageNavigationTracker.manualContinuityRevision.get(senderTabId) === data.manualContinuityAttemptRevision;
          const validManualStart = isPendingManualStart || isLegacyInitialManualStart;
          if (!grant || data.topDocumentToken !== grant.topDocumentToken
              || (data.origin === 'manual-start' && !validManualStart)
              || (data.origin === 'manual-frame'
                && !hasDynamicManualAttempt(
                  grant, senderTabId, data.manualContinuityAttemptId, data.manualContinuityAttemptRevision,
                ))) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          const { documentToken: currentTopToken } = await probeFrameDocument(senderTabId, 0);
          if (currentTopToken !== grant.topDocumentToken
              || (frameId === 0 && data.documentToken !== currentTopToken)) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          if (data.origin === 'manual-start' && frameId > 0) {
            const [frame, { documentToken }] = await Promise.all([
              browser.webNavigation.getFrame({ tabId: senderTabId, frameId }),
              probeFrameDocument(senderTabId, frameId),
            ]);
            if (!isEligibleManualFrameUrl(frame?.url)
                || frame.url !== data.navigationCursor?.url
                || grant.frames?.[frameId] !== data.navigationCursor?.documentEpoch
                || documentToken !== data.documentToken) {
              return { success: false, reason: 'obsolete_navigation' };
            }
          }
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
          if (data.origin === 'manual-spa'
              && (grant.acceptedAttemptIds?.[frameId] !== data.manualContinuityAttemptId
                || grant.acceptedAttemptRevisions?.[frameId] !== String(data.manualContinuityAttemptRevision)
                || grant.acceptedDocuments?.[frameId] !== data.documentToken)) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          const valid = await pageNavigationTracker.validateManualContinuity(
            senderTabId, frameId, data.manualContinuityGeneration,
            data.topDocumentEpoch, data.navigationCursor
          );
          const currentGrant = await pageNavigationTracker.getManualContinuity(senderTabId);
          const ownerStillCurrent = data.origin !== 'manual-start' || isLegacyInitialManualStart
            || pendingManualStartOwners.get(senderTabId) === startOwner;
          const tupleStillCurrent = data.origin === 'manual-spa'
            ? currentGrant?.acceptedAttemptIds?.[frameId] === data.manualContinuityAttemptId
              && currentGrant?.acceptedAttemptRevisions?.[frameId] === String(data.manualContinuityAttemptRevision)
              && currentGrant?.acceptedDocuments?.[frameId] === data.documentToken
            : data.origin === 'manual-start'
              ? isLegacyInitialManualStart
                ? currentGrant?.attemptId === data.manualContinuityAttemptId
                  && currentGrant?.attemptRevision === data.manualContinuityAttemptRevision
                : isPendingManualStart
                && startOwner?.attemptId === data.manualContinuityAttemptId
                && startOwner?.attemptRevision === data.manualContinuityAttemptRevision
              : hasDynamicManualAttempt(
                currentGrant, senderTabId, data.manualContinuityAttemptId, data.manualContinuityAttemptRevision,
              );
          if (!valid || !ownerStillCurrent || !tupleStillCurrent
              || (data.origin === 'manual-spa'
                && pageNavigationTracker.getRestartFence(senderTabId) !== data.restartFence)) {
            return { success: false, reason: 'obsolete_navigation' };
          }
          if (data.admissionPhase === 'accept') {
            const accepted = await pageNavigationTracker.stageManualFrameAcceptance(
              senderTabId, grant.generation, data.manualContinuityAttemptId,
              data.manualContinuityAttemptRevision, frameId, data.documentToken, data.navigationCursor,
              isPendingManualStart ? startOwner.previousAttemptId : grant.attemptId,
              data.origin === 'manual-start', data.origin === 'manual-frame'
            );
            if (!accepted) return { success: false, reason: 'obsolete_navigation' };
            if (grant.armed) void resumePendingManualFrameReadiness(senderTabId);
          }
          return { success: true };
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
        if (!Number.isSafeInteger(authorization.attemptRevision)
            || typeof authorization.attemptId !== 'string' || !authorization.attemptId
            || typeof authorization.documentToken !== 'string' || !authorization.documentToken) {
          return { success: false, reason: 'manual_continuity_revoked' };
        }
        if (!(await pageNavigationTracker.validateManualContinuityBatch(
          senderTabId, sender.frameId, authorization.generation,
          authorization.topDocumentEpoch, authorization.navigationCursor,
          authorization.attemptRevision, authorization.attemptId, authorization.documentToken,
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
      if (isManualStart) {
        if (pendingManualStartOwners.has(targetTabId)) {
          return { success: false, reason: 'manual_start_pending' };
        }
        const attemptId = crypto.randomUUID();
        manualStartRevision = pageNavigationTracker.reserveManualContinuityStart(targetTabId, attemptId);
        let resolveInitialReservations;
        manualStartOwner = {
          tabId: targetTabId,
          generation: null,
          attemptRevision: manualStartRevision,
          attemptId,
          initialReservationsResolved: false,
          initialReservationsReady: new Promise(resolve => { resolveInitialReservations = resolve; }),
          resolveInitialReservations: () => resolveInitialReservations(),
        };
        pendingManualStartOwners.set(targetTabId, manualStartOwner);
      }
      if (!Number.isInteger(senderTabId) && explicitInvalidation) {
        pageNavigationTracker.revokeRestartFence(targetTabId);
        if (isManualRevocation && !internalBatchAbort) {
          const expectedGeneration = message.data?.expectedManualContinuityGeneration;
          const owner = pendingManualStartOwners.get(targetTabId);
          const ownerAuthorized = owner && pendingManualStartOwners.get(targetTabId) === owner
            && (expectedGeneration == null || owner.generation === expectedGeneration);
          if (ownerAuthorized || (expectedGeneration == null && !owner)) {
            clearPendingManualFrameReadiness(targetTabId);
          }
          if (ownerAuthorized) owner.invalidated = true;
          releaseManualStartOwner(owner, expectedGeneration);
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
      markInitialReservationsReady(manualStartOwner);
      if (manualStartOwner) pageNavigationTracker.cancelManualContinuityStart(manualStartOwner.tabId, manualStartOwner.attemptId);
      releaseManualStartOwner(manualStartOwner);
      const revokeResult = await waitForManualRevocation(manualRevokePromise);
      if (isManualRevocation && Number.isInteger(stopTargetTabId)) {
        await sendFrameCommandWithResponseDeadline(stopTargetTabId, {
            action: message.action === MessageActions.PAGE_RESTORE
              ? MessageActions.PAGE_RESTORE : MessageActions.PAGE_TRANSLATE_STOP_AUTO,
              data: {
                hasManualContinuity: false,
                ...(message.data?.settingsInvalidation === true && {
                  internalSettingsInvalidation: true,
                  cancellationReason: 'operation-abort',
                }),
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
    const initialLeases = new Map();
    if (isManualStart && manualStartOwner && access.isAccessible
        && !navigationUnavailable && !navigationAdmissionInvalid) {
      for (const frame of allFrames.filter(candidate => candidate.frameId > 0)) {
        const key = initialFrameLeaseKey(targetTabId, frame.frameId);
        const leases = pendingInitialFrameStarts.get(key) || [];
        const lease = createInitialFrameLease(manualStartOwner, frame.frameId, frame.documentId);
        lease.predecessors = [...leases];
        leases.push(lease);
        pendingInitialFrameStarts.set(key, leases);
        initialLeases.set(frame.frameId, lease);
      }
      markInitialReservationsReady(manualStartOwner);
      for (const frame of allFrames.filter(candidate => candidate.frameId > 0)) {
        const lease = initialLeases.get(frame.frameId);
        const probe = Promise.all([
          Promise.resolve().then(() => probeFrameDocument(targetTabId, frame.frameId)),
          Promise.resolve().then(() => browser.webNavigation.getFrame({
            tabId: targetTabId, frameId: frame.frameId,
          })),
        ]).then(([identity, liveFrame]) => ({
          ...identity,
          documentId: liveFrame?.documentId || frame.documentId,
        }));
        void settleBeforeDeadline(probe, preparation.deadlineAt).then(result => {
          const identity = result.error || result.timedOut ? null : result.value;
          lease.resolveIdentity(identity);
          if (typeof identity?.documentToken !== 'string' || !identity.documentToken) {
            releaseInitialFrameLease(lease);
          }
        });
      }
    }
    markInitialReservationsReady(manualStartOwner);
    if (navigationUnavailable) message = { ...message, data: { ...message.data, navigationUnavailable: true } };
    if (!access.isAccessible) {
      if (manualStartOwner) pageNavigationTracker.cancelManualContinuityStart(manualStartOwner.tabId, manualStartOwner.attemptId);
      releaseManualStartOwner(manualStartOwner);
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
      const revocationResult = await waitForManualRevocation(manualRevokePromise);
      const revocationGeneration = revocationResult?.generation ?? null;
      const revocationError = revocationResult?.error ?? null;
      if (isManualRevocation && !revocationError && revocationGeneration == null) {
        return { success: false, reason: 'manual_continuity_stop_superseded' };
      }
      if (isManualStart && !navigationUnavailable && !navigationAdmissionInvalid) {
        let preparationTimeout;
        try {
          const remaining = Math.max(0, preparation.deadlineAt - Date.now());
          const manualPreparation = (async () => {
            const topProbe = await probeFrameDocument(targetTabId, 0).catch(() => null);
            if (Date.now() >= preparation.deadlineAt
                || pendingManualStartOwners.get(targetTabId) !== manualStartOwner
                || typeof topProbe?.documentToken !== 'string' || !topProbe.documentToken) {
              const error = new Error(Date.now() >= preparation.deadlineAt
                ? 'Whole Page command preparation timed out' : 'Top document identity is unavailable');
              error.code = Date.now() >= preparation.deadlineAt
                ? PRE_FANOUT_COMMAND_TIMEOUT_REASON : 'top_identity_unavailable';
              error.isPreFanoutTimeout = error.code === PRE_FANOUT_COMMAND_TIMEOUT_REASON;
              throw error;
            }
            const grant = await pageNavigationTracker.grantManualContinuity(targetTabId, manualStartRevision, {
              topDocumentToken: topProbe.documentToken,
              provider: message.data?.provider,
              targetLanguage: message.data?.targetLanguage,
              isExplicitProvider: message.data?.isExplicitProvider,
              attemptId: manualStartOwner.attemptId,
              handlerManaged: true,
            });
            if (Date.now() >= preparation.deadlineAt
                || pendingManualStartOwners.get(targetTabId) !== manualStartOwner) {
              throw Object.assign(new Error('Manual continuity start superseded'), {
                isPreFanoutTimeout: Date.now() >= preparation.deadlineAt,
              });
            }
            if (grant.attemptRevision !== manualStartRevision) {
              manualStartRevision = grant.attemptRevision;
              manualStartOwner.attemptRevision = grant.attemptRevision;
              for (const pending of pendingManualFrameReadiness.values()) {
                if (pending.owner === manualStartOwner) pending.attemptRevision = grant.attemptRevision;
              }
              for (const leases of pendingInitialFrameStarts.values()) {
                for (const lease of leases) {
                  if (lease.owner !== manualStartOwner) continue;
                  for (const waiter of lease.waiters) {
                    if (waiter.owner === manualStartOwner
                        && waiter.attemptId === manualStartOwner.attemptId) {
                      waiter.attemptRevision = grant.attemptRevision;
                    }
                  }
                }
              }
            }
            if (pendingManualStartOwners.get(targetTabId) !== manualStartOwner
                || pageNavigationTracker.manualContinuityRevision.get(targetTabId) !== manualStartRevision) {
              throw new Error('Manual continuity start superseded');
            }
            manualStartOwner.generation = grant.generation;
            manualStartOwner.previousAttemptId = grant.previousAttemptId ?? grant.attemptId;
            return grant;
          })();
          manualGrant = await Promise.race([
            manualPreparation,
            new Promise((_, reject) => {
              preparationTimeout = setTimeout(() => {
                const error = new Error('Whole Page command preparation timed out');
                error.isPreFanoutTimeout = true;
                reject(error);
              }, remaining);
            }),
          ]);
        } catch (error) {
          pageNavigationTracker.cancelManualContinuityStart(targetTabId, manualStartOwner.attemptId);
          releaseManualStartOwner(manualStartOwner);
          for (const lease of initialLeases.values()) releaseInitialFrameLease(lease);
          if (error?.isPreFanoutTimeout) {
            return { success: false, reason: PRE_FANOUT_COMMAND_TIMEOUT_REASON, isTransportFailure: true };
          }
          return {
            success: false,
            reason: error.code === 'top_identity_unavailable'
              ? 'manual_continuity_top_identity_unavailable' : 'manual_continuity_not_durable',
            error: error.message,
          };
        } finally {
          clearTimeout(preparationTimeout);
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
          manualContinuityAttemptRevision: manualGrant.attemptRevision,
          manualContinuityAttemptId: manualGrant.attemptId,
        } }
          : revocationGeneration != null || (isManualRevocation && revocationError)
            ? { ...message, data: {
              ...message.data,
              internalSettingsInvalidation: message.data?.settingsInvalidation === true,
              ...(message.data?.settingsInvalidation === true && { cancellationReason: 'operation-abort' }),
          hasManualContinuity: false,
          manualContinuityGeneration: revocationGeneration
            ?? revocationResult?.cutoffGeneration
            ?? manualStopCutoffGeneration,
            ...(revocationError && { revocationCommitted: false }),
          } }
          : message;
      let confirmedAcceptance = false;
      const continuityUncertainFrames = [];
      let continuityRevocationUncertain = false;
      let frameResultsComplete = false;
      const pendingLateFrames = new Set();
      const settledFrames = new Set();
      const reconciliationPromises = new Map();
      let activeLateReconciliations = 0;
      let lateFinalizationStarted = false;
      const finalizeLateResults = async () => {
        if (!frameResultsComplete || pendingLateFrames.size !== 0
            || activeLateReconciliations !== 0 || lateFinalizationStarted) return;
        lateFinalizationStarted = true;
        if (!manualStartOwner || pendingManualStartOwners.get(targetTabId) !== manualStartOwner) return;
        if (!confirmedAcceptance && manualGrant && !manualGrant.reused
            && pageNavigationTracker.manualContinuityRevision.get(targetTabId) === manualStartRevision) {
          const blocked = pageNavigationTracker.blockManualContinuity(
            targetTabId, manualGrant.generation, manualStartRevision,
          );
          if (blocked) clearPendingManualFrameReadiness(targetTabId);
          await pageNavigationTracker.revokeManualContinuity(
            targetTabId, manualGrant.generation, blocked,
          ).catch(error => {
            continuityRevocationUncertain = true;
            logger.warn('Failed to revoke an unconfirmed manual start', error);
          });
        }
        releaseManualStartOwner(manualStartOwner);
      };
      const reconcileLateResult = async ({ response, navigationCursor }, frameId) => {
        settledFrames.add(frameId);
        activeLateReconciliations += 1;
        try {
          const lease = initialLeases.get(frameId);
          if (response?.success === false && response.reason === ActionReasons.USER_CANCELLED && lease) {
            lease.suppressReadinessReplay = true;
            for (const [key, pending] of pendingManualFrameReadiness) {
              const sameDocument = pending.documentToken === lease.documentToken
                && !(pending.documentId && lease.documentId && pending.documentId !== lease.documentId);
              if (pending.tabId === targetTabId && pending.frameId === frameId
                  && pending.owner === lease.owner
                  && pending.attemptId === lease.owner.attemptId
                  && String(pending.attemptRevision) === String(lease.owner.attemptRevision)
                  && sameDocument) {
                pending.suppressReplay = true;
                pendingManualFrameReadiness.delete(key);
              }
            }
          }
          if (!manualStartOwner || pendingManualStartOwners.get(targetTabId) !== manualStartOwner) return;
          const documentToken = response?.documentToken;
          let promoted = false;
          if (response?.success === true && typeof documentToken === 'string' && documentToken
              && manualGrant && navigationCursor
              && pageNavigationTracker.manualContinuityRevision.get(targetTabId) === manualStartRevision) {
            let promotionFailed = false;
            promoted = await pageNavigationTracker.promoteManualFrameAcceptance(
              targetTabId, manualGrant.generation, manualStartOwner.attemptId,
              manualStartOwner.attemptRevision, frameId, documentToken, navigationCursor,
              manualGrant.topDocumentToken, frameId === 0 ? navigationCursor : null,
            ).catch(error => {
              promotionFailed = true;
              logger.warn('Failed to persist manual frame acceptance', error);
              return false;
            });
            if (promotionFailed) continuityUncertainFrames.push(frameId);
            const stillOwner = pendingManualStartOwners.get(targetTabId) === manualStartOwner
              && pageNavigationTracker.manualContinuityRevision.get(targetTabId) === manualStartRevision;
            confirmedAcceptance ||= promoted && stillOwner;
            if (promoted && stillOwner && !manualGrant.reused) {
              await resumePendingManualFrameReadiness(targetTabId);
            }
          }
          if (!promoted && manualGrant) {
            await pageNavigationTracker.clearProvisionalManualFrameAcceptance(
              targetTabId, manualGrant.generation, manualStartOwner.attemptId,
              manualStartOwner.attemptRevision, frameId,
              typeof documentToken === 'string' && documentToken ? documentToken : undefined,
            ).catch(error => {
              continuityUncertainFrames.push(frameId);
              logger.warn('Failed to clear unconfirmed manual frame acceptance', error);
            });
          }
        } finally {
          activeLateReconciliations -= 1;
          pendingLateFrames.delete(frameId);
          if (initialLeases.has(frameId)) releaseInitialFrameLease(initialLeases.get(frameId));
          await finalizeLateResults();
        }
      };
      const frameResults = await Promise.all(
        allFrames.map(frame => {
          const lease = initialLeases.get(frame.frameId);
          const commandDeadlineAt = Date.now() + FRAME_COMMAND_RESPONSE_TIMEOUT_MS;
          return (async () => {
            if (lease) {
              const preflight = (async () => {
                await lease.identityPromise;
                if (!lease.documentToken || lease.settled) return false;
                await Promise.all(lease.predecessors.map(async prior => {
                  await prior.identityPromise;
                  const sameDocument = (lease.documentId && prior.documentId === lease.documentId)
                    || (lease.documentToken && prior.documentToken === lease.documentToken);
                  if (sameDocument) await prior.settlementPromise;
                }));
                if (pendingManualStartOwners.get(targetTabId) !== manualStartOwner
                    || manualStartOwner.invalidated
                    || pageNavigationTracker.manualContinuityRevision.get(targetTabId) !== manualStartRevision) {
                  return false;
                }
                const currentGrant = await pageNavigationTracker.getManualContinuity(targetTabId);
                if (!currentGrant || currentGrant.generation !== manualGrant.generation
                    || currentGrant.revoked
                    || currentGrant.topDocumentEpoch !== manualGrant.topDocumentEpoch
                    || currentGrant.topDocumentToken !== manualGrant.topDocumentToken) return false;
                const [finalAccess, liveFrame, liveIdentity, liveTopIdentity, liveTopCursor] = await Promise.all([
                  Promise.resolve().then(() => tabPermissionChecker.checkTabAccess(targetTabId)),
                  Promise.resolve().then(() => browser.webNavigation.getFrame({
                    tabId: targetTabId, frameId: frame.frameId,
                  })),
                  Promise.resolve().then(() => probeFrameDocument(targetTabId, frame.frameId)),
                  Promise.resolve().then(() => probeFrameDocument(targetTabId, 0)),
                  Promise.resolve().then(() => pageNavigationTracker.getAdmissionCursor(targetTabId, 0)),
                ]);
                return finalAccess.isAccessible && isEligibleManualFrameUrl(liveFrame?.url)
                  && liveIdentity?.documentToken === lease.documentToken
                  && (!lease.documentId || !liveFrame?.documentId || lease.documentId === liveFrame.documentId)
                  && liveTopIdentity?.documentToken === manualGrant.topDocumentToken
                  && liveTopCursor?.documentEpoch === manualGrant.topDocumentEpoch
                  && !lease.settled
                  && pendingInitialFrameStarts.get(initialFrameLeaseKey(targetTabId, frame.frameId))
                    ?.includes(lease)
                  && pendingManualStartOwners.get(targetTabId) === manualStartOwner
                  && !manualStartOwner.invalidated
                  && pageNavigationTracker.manualContinuityRevision.get(targetTabId) === manualStartRevision;
              })();
              const result = await settleBeforeDeadline(preflight, commandDeadlineAt);
              if (result.timedOut || result.error || !result.value) {
                releaseInitialFrameLease(lease);
                return {
                  frameId: frame.frameId, response: null,
                  isResponseTimeout: result.timedOut === true, wasDispatched: false,
                };
              }
            }
            const frameMessage = lease ? {
              ...outboundMessage,
              data: { ...outboundMessage.data, initialDocumentToken: lease.documentToken },
            } : outboundMessage;
            return sendFrameCommandWithResponseDeadline(
              targetTabId, frameMessage, frame.frameId, FRAME_COMMAND_RESPONSE_TIMEOUT_MS, boundNavigation,
              manualStartOwner ? result => {
                const reconciliation = reconcileLateResult(result, frame.frameId);
                reconciliationPromises.set(frame.frameId, reconciliation);
                return reconciliation;
              } : null,
              lease?.documentId,
              commandDeadlineAt,
              lease ? () => !lease.settled
                && pendingInitialFrameStarts.get(initialFrameLeaseKey(targetTabId, frame.frameId))?.includes(lease)
                && pendingManualStartOwners.get(targetTabId) === manualStartOwner
                && !manualStartOwner.invalidated
                && pageNavigationTracker.manualContinuityRevision.get(targetTabId) === manualStartRevision
                && pendingManualStartOwners.get(targetTabId)?.generation === manualStartOwner.generation
                && pageNavigationTracker.state?.manualContinuity?.[targetTabId]?.generation === manualGrant.generation
                && !pageNavigationTracker.state?.manualContinuity?.[targetTabId]?.revoked
                : null,
            ).then(result => {
              if (lease && !result.wasDispatched) releaseInitialFrameLease(lease);
              return result;
            });
          })();
        })
      );

      await Promise.allSettled(frameResults
        .filter(result => !result.isResponseTimeout && reconciliationPromises.has(result.frameId))
        .map(result => reconciliationPromises.get(result.frameId)));
      for (const result of frameResults) {
        if (result.isResponseTimeout && result.wasDispatched && !settledFrames.has(result.frameId)) {
          pendingLateFrames.add(result.frameId);
        }
      }
      if (manualGrant && manualStartOwner) {
        frameResultsComplete = true;
        if (!pendingLateFrames.size) await finalizeLateResults();
        else void finalizeLateResults();
      } else if (manualStartOwner) {
        frameResultsComplete = true;
        if (!pendingLateFrames.size) await finalizeLateResults();
        else void finalizeLateResults();
      }

      const responses = frameResults
        .map(({ response }) => response)
        .filter(response => response != null);
      const frames = frameResults.map(projectFrameDelivery);
      const success = responses.some(response => response.success);
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
      if ((continuityUncertainFrames.length || continuityRevocationUncertain) && !confirmedAcceptance) {
        return {
          success: false,
          reason: 'manual_continuity_acceptance_uncertain',
          isTransportFailure: true,
          continuityUncertainFrames: [...new Set(continuityUncertainFrames)],
          responses,
          frames,
          targetTabId,
        };
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
          ...((continuityUncertainFrames.length || continuityRevocationUncertain) && {
            continuityUncertainFrames: [...new Set(continuityUncertainFrames)],
            manualContinuityStorageUncertain: true,
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
    if (error?.isPreFanoutTimeout && manualStartOwner) {
      pageNavigationTracker.cancelManualContinuityStart(manualStartOwner.tabId, manualStartOwner.attemptId);
    }
    releaseManualStartOwner(manualStartOwner);
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
    const owner = pendingManualStartOwners.get(tabId);
    if (owner) pageNavigationTracker.cancelManualContinuityStart(tabId, owner.attemptId);
    releaseManualStartOwner(owner);
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
    const owner = pendingManualStartOwners.get(tabId);
    if (owner) pageNavigationTracker.cancelManualContinuityStart(tabId, owner.attemptId);
    releaseManualStartOwner(owner);
    clearPendingManualFrameReadiness(tabId);
    const leasePrefix = `${tabId}:`;
    for (const [key, leases] of [...pendingInitialFrameStarts]) {
      if (!key.startsWith(leasePrefix)) continue;
      for (const lease of leases) {
        lease.suppressReadinessReplay = true;
        releaseInitialFrameLease(lease);
      }
    }
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

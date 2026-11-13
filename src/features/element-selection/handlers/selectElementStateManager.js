import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessagingContexts, MessageFormat } from '@/shared/messaging/core/MessagingCore.js';
import { checkUrlExclusionAsync } from '@/features/exclusion/utils/exclusion-utils.js';
// import { tabPermissionChecker } from '@/core/tabPermissions.js';

// In-memory per-tab select element state
const selectElementStateByTab = new Map();
// A new background module instance establishes a new Select Element authority epoch.
const backgroundActivationEpoch = (() => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to the local opaque fallback.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();
// Each frame keeps its own accepted activation generation, bound to document identity.
const selectElementParticipantsByTab = new Map(); // tabId -> Map<frameId, { generation, documentId }>
 // Latest accepted generation; older frame ownership may remain during reactivation.
const currentGenerationByTab = new Map();
const nextActivationGenerationByTab = new Map();
const activationAttemptsByTab = new Map();
const currentActivationAttemptByTab = new Map();
// Legacy activation ACKs cannot establish authority but must remain cleanable.
const compatibilityFramesByTab = new Map();
// Sent activation requests without conclusive settlement remain cleanup debt.
const provisionalCleanupFramesByTab = new Map(); // tabId -> Map<frameId, Map<generation, documentId>>
let nextRetainedRecoveryToken = 1;
const retainedSessionRecoveryByTab = new Map(); // tabId -> { token, promise }
const RECONCILE_LIVENESS_TIMEOUT_MS = 350;
const RETAINED_SESSION_DISCOVERY_TIMEOUT_MS = 150;

function beginRetainedSessionRecovery(tabId) {
  if (!Number.isInteger(tabId)) return null;
  if (retainedSessionRecoveryByTab.has(tabId)) return null;
  const token = nextRetainedRecoveryToken++;
  retainedSessionRecoveryByTab.set(tabId, { token, promise: null });
  return token;
}

function getRetainedSessionRecoveryRecord(tabId) {
  return retainedSessionRecoveryByTab.get(tabId) || null;
}

function isRetainedSessionRecoveryCurrent(tabId, token) {
  return retainedSessionRecoveryByTab.get(tabId)?.token === token;
}

function setRetainedSessionRecoveryPromise(tabId, token, promise) {
  const rec = retainedSessionRecoveryByTab.get(tabId);
  if (!rec || rec.token !== token) return false;
  rec.promise = promise;
  return true;
}

function invalidateRetainedSessionRecovery(tabId) {
  if (!Number.isInteger(tabId)) return false;
  return retainedSessionRecoveryByTab.delete(tabId);
}

function clearRetainedSessionRecovery(tabId, token) {
  if (!Number.isInteger(tabId)) return false;
  const rec = retainedSessionRecoveryByTab.get(tabId);
  if (!rec) return false;
  if (rec.token !== token) return false;
  retainedSessionRecoveryByTab.delete(tabId);
  return true;
}
// Join authority revision: bumped on activation and before deactivation to prevent late join resurrection
const activeSessionRevisionByTab = new Map();
function getActiveSessionRevision(tabId) {
  return activeSessionRevisionByTab.get(tabId) || 0;
}
function bumpActiveSessionRevision(tabId) {
  const next = getActiveSessionRevision(tabId) + 1;
  activeSessionRevisionByTab.set(tabId, next);
  return next;
}
function invalidateJoinAuthority(tabId) {
  return bumpActiveSessionRevision(tabId);
}

const ownershipRevisionByTab = new Map();
let nextOwnershipRevision = 0;
function getOwnershipRevision(tabId) {
  return ownershipRevisionByTab.get(tabId) || 0;
}
function bumpOwnershipRevision(tabId) {
  if (!Number.isInteger(tabId)) return 0;
  const next = ++nextOwnershipRevision;
  ownershipRevisionByTab.set(tabId, next);
  return next;
}

// Background authority barrier: blocks new joins while deactivation remains unresolved
const selectElementDeactivationPendingByTab = new Map();
function markDeactivationPending(tabId) {
  if (!Number.isInteger(tabId)) return;
  selectElementDeactivationPendingByTab.set(tabId, true);
}
function isDeactivationPending(tabId) {
  return selectElementDeactivationPendingByTab.get(tabId) === true;
}
function clearDeactivationPending(tabId) {
  selectElementDeactivationPendingByTab.delete(tabId);
}

function isValidDocumentId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const FrameStateKind = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  // The frame has no Select Element UI activity but still owns an
  // unconfirmed cleanup, so it is neither clean nor a restorable session.
  CLEANUP_PENDING: 'CLEANUP_PENDING',
  NO_RECEIVER: 'NO_RECEIVER',
  UNKNOWN: 'UNKNOWN',
};

function isNoReceiverTransportError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('receiving end does not exist')
    || message.includes('no receiving end')
    || message.includes('no receiver');
}

function classifyFrameQueryError(error) {
  return {
    kind: FrameStateKind.UNKNOWN,
    reason: isNoReceiverTransportError(error) ? 'no-receiver' : 'transient',
  };
}

function getParticipantInfo(tabId, frameId) {
  const participants = selectElementParticipantsByTab.get(tabId);
  if (!participants) return null;
  return participants.get(frameId) || null;
}

function createActivationGeneration(tabId) {
  if (!Number.isInteger(tabId)) return null;

  // Candidate remains non-authoritative until strict frame ACK registration.
  const generation = Math.max(
    nextActivationGenerationByTab.get(tabId) || 0,
    getCurrentGeneration(tabId) || 0,
  ) + 1;
  nextActivationGenerationByTab.set(tabId, generation);
  const attempt = { generation, token: {}, provisionalFrameIds: new Set(), expectedDocumentIds: new Map() };
  let attempts = activationAttemptsByTab.get(tabId);
  if (!attempts) {
    attempts = new Map();
    activationAttemptsByTab.set(tabId, attempts);
  }
  attempts.set(generation, attempt);
  currentActivationAttemptByTab.set(tabId, attempt);
  return generation;
}

function getCurrentGeneration(tabId) {
  return currentGenerationByTab.get(tabId);
}

function getActivationEpoch() {
  return backgroundActivationEpoch;
}

function getActivationAttemptToken(tabId) {
  return currentActivationAttemptByTab.get(tabId)?.token;
}

function isActivationAttemptCurrent(tabId, generation, token) {
  const attempt = currentActivationAttemptByTab.get(tabId);
  return attempt?.generation === generation && attempt.token === token;
}

function recordActivationAttemptFrames(tabId, generation, frameIds, frameDocumentIds = null) {
  const attempt = activationAttemptsByTab.get(tabId)?.get(generation);
  if (!attempt || currentActivationAttemptByTab.get(tabId) !== attempt) return false;

  const ids = frameIds || [];
  for (const entry of ids) {
    let frameId;
    let documentId = null;
    if (entry && typeof entry === 'object' && 'frameId' in entry) {
      frameId = entry.frameId;
      documentId = entry.documentId || null;
    } else {
      frameId = entry;
      if (frameDocumentIds && frameDocumentIds instanceof Map) {
        documentId = frameDocumentIds.get(frameId) || null;
      }
    }
    if (Number.isInteger(frameId) && frameId >= 0) {
      attempt.provisionalFrameIds.add(frameId);
      if (isValidDocumentId(documentId)) {
        attempt.expectedDocumentIds.set(frameId, documentId);
      }
    }
  }
  // If frameDocumentIds provided separately, fill missing
  if (frameDocumentIds instanceof Map) {
    for (const [fid, docId] of frameDocumentIds.entries()) {
      if (attempt.provisionalFrameIds.has(fid) && isValidDocumentId(docId) && !attempt.expectedDocumentIds.has(fid)) {
        attempt.expectedDocumentIds.set(fid, docId);
      }
    }
  }
  return true;
}

function toInvalidatedAttempt(attempt) {
  const base = {
    generation: attempt.generation,
    frameIds: [...attempt.provisionalFrameIds],
  };
  if (attempt.expectedDocumentIds && attempt.expectedDocumentIds.size > 0) {
    base.documentIds = new Map(attempt.expectedDocumentIds);
  }
  return base;
}

function retainProvisionalCleanupFrame(tabId, frameId, generation, documentId = null) {
  if (!Number.isInteger(frameId) || frameId < 0 || !Number.isInteger(generation)) return;
  let frames = provisionalCleanupFramesByTab.get(tabId);
  if (!frames) {
    frames = new Map();
    provisionalCleanupFramesByTab.set(tabId, frames);
  }
  let generations = frames.get(frameId);
  if (!generations) {
    generations = new Map();
    frames.set(frameId, generations);
  }
  // generations is Map<generation, documentId>
  if (!generations.has(generation)) {
    generations.set(generation, isValidDocumentId(documentId) ? documentId : null);
    bumpOwnershipRevision(tabId);
  } else if (isValidDocumentId(documentId) && !isValidDocumentId(generations.get(generation))) {
    generations.set(generation, documentId);
    bumpOwnershipRevision(tabId);
  }
}

function retainAttemptProvisionalFrames(tabId, attempt) {
  for (const frameId of attempt.provisionalFrameIds) {
    const docId = attempt.expectedDocumentIds?.get(frameId) || null;
    retainProvisionalCleanupFrame(tabId, frameId, attempt.generation, docId);
  }
}

function settleActivationAttemptFrame(tabId, generation, frameId) {
  activationAttemptsByTab.get(tabId)?.get(generation)?.provisionalFrameIds.delete(frameId);
  activationAttemptsByTab.get(tabId)?.get(generation)?.expectedDocumentIds?.delete(frameId);
  removeProvisionalCleanupFrame(tabId, frameId, generation);
}

function getProvisionalCleanupFrames(tabId) {
  const frames = provisionalCleanupFramesByTab.get(tabId);
  if (!frames) return [];
  const out = [];
  for (const [frameId, generations] of frames.entries()) {
    for (const [generation, documentId] of generations.entries()) {
      if (isValidDocumentId(documentId)) {
        out.push({ frameId, generation, documentId });
      } else {
        out.push({ frameId, generation });
      }
    }
  }
  return out;
}

function removeProvisionalCleanupFrame(tabId, frameId, generation) {
  const frames = provisionalCleanupFramesByTab.get(tabId);
  const generations = frames?.get(frameId);
  if (!generations?.has(generation)) return false;
  generations.delete(generation);
  if (generations.size === 0) frames.delete(frameId);
  if (frames.size === 0) provisionalCleanupFramesByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
  return true;
}

function removeProvisionalCleanupFramesForFrame(tabId, frameId) {
  const frames = provisionalCleanupFramesByTab.get(tabId);
  if (!frames?.delete(frameId)) return false;
  if (frames.size === 0) provisionalCleanupFramesByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
  return true;
}

function clearProvisionalCleanupFrames(tabId) {
  if (!provisionalCleanupFramesByTab.has(tabId)) return;
  provisionalCleanupFramesByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
}

function invalidateOlderActivationAttempts(tabId, generation) {
  const attempts = activationAttemptsByTab.get(tabId);
  if (!attempts) return [];

  const invalidated = [];
  for (const [attemptGeneration, attempt] of attempts) {
    if (attemptGeneration < generation) {
      invalidated.push(toInvalidatedAttempt(attempt));
      retainAttemptProvisionalFrames(tabId, attempt);
      attempts.delete(attemptGeneration);
    }
  }
  if (attempts.size === 0) activationAttemptsByTab.delete(tabId);
  return invalidated;
}

function invalidateActivationAttempts(tabId) {
  const attempts = activationAttemptsByTab.get(tabId);
  const invalidated = attempts ? [...attempts.values()].map(attempt => {
    retainAttemptProvisionalFrames(tabId, attempt);
    return toInvalidatedAttempt(attempt);
  }) : [];
  activationAttemptsByTab.delete(tabId);
  currentActivationAttemptByTab.delete(tabId);
  return invalidated;
}

function completeActivationAttempt(tabId, generation, token) {
  const attempts = activationAttemptsByTab.get(tabId);
  const attempt = attempts?.get(generation);
  if (!attempt || attempt.token !== token) return false;

  retainAttemptProvisionalFrames(tabId, attempt);
  attempts.delete(generation);
  if (currentActivationAttemptByTab.get(tabId) === attempt) {
    currentActivationAttemptByTab.delete(tabId);
  }
  if (attempts.size === 0) activationAttemptsByTab.delete(tabId);
  return true;
}

function retainCompatibilityFrames(tabId, generation, frameIds) {
  let frames = compatibilityFramesByTab.get(tabId);
  if (!frames) {
    frames = new Map();
    compatibilityFramesByTab.set(tabId, frames);
  }
  const participants = selectElementParticipantsByTab.get(tabId);
  let didChange = false;
  for (const frameId of frameIds || []) {
    if (Number.isInteger(frameId) && frameId >= 0) {
      if (participants?.has(frameId)) continue;
      if (!frames.has(frameId) || frames.get(frameId) !== generation) didChange = true;
      frames.set(frameId, generation);
      removeProvisionalCleanupFrame(tabId, frameId, generation);
    }
  }
  if (didChange) bumpOwnershipRevision(tabId);
}

function getCompatibilityFrames(tabId) {
  return new Map(compatibilityFramesByTab.get(tabId) || []);
}

function removeCompatibilityFrame(tabId, frameId) {
  const frames = compatibilityFramesByTab.get(tabId);
  if (!frames?.delete(frameId)) return false;
  if (frames.size === 0) compatibilityFramesByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
  return true;
}

function clearCompatibilityFrames(tabId) {
  if (!compatibilityFramesByTab.has(tabId)) return;
  compatibilityFramesByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
}

function buildDocumentAwareMessageTarget(frameId, documentId) {
  if (isValidDocumentId(documentId)) {
    return { frameId, documentId };
  }
  return { frameId };
}

function isStructurallyNonInjectableFrame(frame) {
  const url = typeof frame?.url === 'string' ? frame.url.trim().toLowerCase() : '';
  if (!url) return false;

  return url.startsWith('javascript:')
    || url.startsWith('chrome://')
    || url.startsWith('chrome-extension://')
    || url.startsWith('moz-extension://')
    || url.startsWith('about:')
    || url.startsWith('edge://')
    || url.startsWith('opera://')
    || url.startsWith('vivaldi://')
    || url.startsWith('brave://');
}

async function compensateInvalidatedActivationAttempts(tabId, invalidatedAttempts = []) {
  if (!browser.tabs?.sendMessage) return [];

  const requests = new Map();
  for (const attempt of invalidatedAttempts) {
    for (const frameId of attempt.frameIds || []) {
      const docId = attempt.documentIds instanceof Map ? attempt.documentIds.get(frameId) : null;
      const key = `${frameId}:${attempt.generation}:${docId || ''}`;
      if (!requests.has(key)) {
        requests.set(key, {
          frameId,
          generation: attempt.generation,
          documentId: isValidDocumentId(docId) ? docId : null,
        });
      }
    }
  }

  return Promise.all([...requests.values()].map(async ({ frameId, generation, documentId }) => {
    try {
      const target = buildDocumentAwareMessageTarget(frameId, documentId);
      const response = await Promise.resolve().then(() => browser.tabs.sendMessage(
        tabId,
        MessageFormat.create(
          MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
          {
            mode: 'normal',
            active: false,
            fromBackground: true,
            activationEpoch: backgroundActivationEpoch,
            activationGeneration: generation,
            isExplicitDeactivation: true,
          },
          MessagingContexts.CONTENT,
        ),
        target,
      ));
      const settled = response?.success === true
        && response?.cleanupCompleted === true
        && response?.activated === false;
      if (settled) removeProvisionalCleanupFrame(tabId, frameId, generation);
      return {
        generation,
        frameId,
        documentId,
        settled,
        response,
      };
    } catch (error) {
      return { generation, frameId, documentId, settled: false, error };
    }
  }));
}

function registerParticipant(tabId, frameId, generation, documentId = null) {
  if (
    !Number.isInteger(tabId)
    || !Number.isInteger(frameId)
    || frameId < 0
    || !Number.isInteger(generation)
  ) {
    return false;
  }
  if (!isActivationAttemptCurrent(tabId, generation, getActivationAttemptToken(tabId))) {
    return false;
  }

  let participants = selectElementParticipantsByTab.get(tabId);
  const currentGeneration = getCurrentGeneration(tabId);
  if (!participants) {
    participants = new Map();
    selectElementParticipantsByTab.set(tabId, participants);
  }

  // Document-aware validation: if we have expected document for this attempt/frame, require match.
  const attempt = activationAttemptsByTab.get(tabId)?.get(generation);
  const expectedDoc = attempt?.expectedDocumentIds?.get(frameId) || null;
  if (isValidDocumentId(expectedDoc) && isValidDocumentId(documentId) && expectedDoc !== documentId) {
    return false;
  }
  const effectiveDoc = isValidDocumentId(documentId) ? documentId : (isValidDocumentId(expectedDoc) ? expectedDoc : getParticipantInfo(tabId, frameId)?.documentId || null);

  if (currentGeneration === undefined || generation > currentGeneration) {
    nextActivationGenerationByTab.set(
      tabId,
      Math.max(nextActivationGenerationByTab.get(tabId) || 0, generation),
    );
    currentGenerationByTab.set(tabId, generation);
  } else if (currentGeneration !== generation) {
    return false;
  }

  participants.set(frameId, { generation, documentId: isValidDocumentId(effectiveDoc) ? effectiveDoc : null });
  removeCompatibilityFrame(tabId, frameId);
  // A newer document must not erase cleanup debt belonging to an older document.
  removeProvisionalCleanupFrame(tabId, frameId, generation);
  bumpOwnershipRevision(tabId);
  return true;
}

function removeParticipant(tabId, frameId, generation, expectedDocumentId = null) {
  const participants = selectElementParticipantsByTab.get(tabId);
  if (!participants || !participants.has(frameId)) return false;
  const info = participants.get(frameId);
  if (
    !Number.isInteger(generation)
    || info.generation !== generation
  ) {
    return false;
  }
  // If caller supplies documentId, require it matches stored when both present
  if (isValidDocumentId(expectedDocumentId) && isValidDocumentId(info.documentId) && expectedDocumentId !== info.documentId) {
    return false;
  }
  participants.delete(frameId);
  if (participants.size === 0) selectElementParticipantsByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
  return true;
}

function getParticipants(tabId) {
  const participants = selectElementParticipantsByTab.get(tabId);
  if (!participants) return new Map();
  const out = new Map();
  for (const [frameId, info] of participants.entries()) {
    out.set(frameId, info.generation);
  }
  return out;
}

function getParticipantsWithDocuments(tabId) {
  const participants = selectElementParticipantsByTab.get(tabId);
  if (!participants) return new Map();
  return new Map(participants);
}

function clearParticipants(tabId) {
  const participants = selectElementParticipantsByTab.get(tabId);
  if (!participants || participants.size === 0) return;
  participants.clear();
  selectElementParticipantsByTab.delete(tabId);
  bumpOwnershipRevision(tabId);
}

function clearTabParticipants(tabId) {
  clearParticipants(tabId);
  currentGenerationByTab.delete(tabId);
  nextActivationGenerationByTab.delete(tabId);
  invalidateActivationAttempts(tabId);
  invalidateRetainedSessionRecovery(tabId);
  clearCompatibilityFrames(tabId);
  clearProvisionalCleanupFrames(tabId);
  clearDeactivationPending(tabId);
}

function retireFrameCleanupOwnership(tabId, frameId, documentId = null) {
  for (const attempt of activationAttemptsByTab.get(tabId)?.values() || []) {
    attempt.provisionalFrameIds.delete(frameId);
    attempt.expectedDocumentIds?.delete(frameId);
  }
  removeCompatibilityFrame(tabId, frameId);
  if (isValidDocumentId(documentId)) {
    const frames = provisionalCleanupFramesByTab.get(tabId);
    const gens = frames?.get(frameId);
    if (gens) {
      let didDelete = false;
      for (const [generation, doc] of [...gens.entries()]) {
        if (isValidDocumentId(doc) && doc !== documentId) {
          gens.delete(generation);
          didDelete = true;
        } else if (!isValidDocumentId(doc)) {
          // Conservative: keep unknown-document debt when live document is known
        }
      }
      if (gens.size === 0) frames.delete(frameId);
      if (frames?.size === 0) provisionalCleanupFramesByTab.delete(tabId);
      if (didDelete) bumpOwnershipRevision(tabId);
    }
  } else {
    removeProvisionalCleanupFramesForFrame(tabId, frameId);
  }
}

function removeParticipantForNavigation(tabId, frameId, documentId) {
  const info = getParticipantInfo(tabId, frameId);
  if (!info) return false;
  // P4: stale navigation must never remove newer document ownership.
  // If stored doc is valid and event doc is valid:
  // - stored != event => old ownership was for previous doc; removal of old doc is safe only if map still holds old doc.
  //   But map entry for frameId currently holds either old or new doc. If it holds old, stored != event means map has old, event is new doc commit -> remove old participation is desired? But new doc hasn't been registered yet, so we should remove old.
  //   If map holds new doc (ACK before commit), stored == event => keep.
  // So removal when stored != event would remove old correctly, but also would keep new correctly when equal.
  // Need to distinguish: we should remove old ownership when stored document is not the newly committed one? Actually old doc's removal is needed before new registration, but if map already has new doc, we keep.
  // In both cases stored vs event equality tells us whether map holds new doc (equal) or old doc (not equal). So:
  // stored == event => map already updated to new doc -> keep.
  // stored != event => map still holds old doc -> remove stale old doc.
  // This matches desired behavior.
  if (isValidDocumentId(info.documentId) && isValidDocumentId(documentId)) {
    if (info.documentId === documentId) {
      return false;
    }
    // stored != event => stale old doc ownership -> remove it
    const participants = selectElementParticipantsByTab.get(tabId);
    participants.delete(frameId);
    if (participants.size === 0) selectElementParticipantsByTab.delete(tabId);
    bumpOwnershipRevision(tabId);
    return true;
  }
  // Fallback when documentIds missing: use frameId removal (old behavior) but only if event is for that frame.
  // We keep bounded protection: still remove by frameId when no document awareness.
  return removeParticipant(tabId, frameId, info.generation);
}

// P1: narrow read-only frame state query with explicit result kinds
async function queryFrameSelectElementState(tabId, frameId, documentId = null) {
  const res = await queryFrameStateWithKind(tabId, frameId, documentId);
  if (res.kind === FrameStateKind.ACTIVE || res.kind === FrameStateKind.INACTIVE) return res.state;
  return null;
}

async function queryFrameStateWithKind(tabId, frameId, documentId = null) {
  if (!browser.tabs?.sendMessage || !Number.isInteger(tabId) || !Number.isInteger(frameId)) {
    return { kind: FrameStateKind.UNKNOWN, error: new Error('invalid target') };
  }
  try {
    const target = buildDocumentAwareMessageTarget(frameId, documentId);
    const resp = await browser.tabs.sendMessage(
      tabId,
      MessageFormat.create(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE, {}, MessagingContexts.CONTENT),
      target,
    );
    let state = null;
    if (resp && typeof resp === 'object' && 'active' in resp) state = resp;
    else if (resp && resp.data && typeof resp.data === 'object' && 'active' in resp.data) state = resp.data;
    if (state && typeof state === 'object' && 'active' in state) {
      if (state.cleanupUnconfirmed === true) {
        // The frame owns an unconfirmed cleanup: it is not clean even though no
        // Select Element UI activity remains, so it requires reconciliation.
        return { kind: FrameStateKind.CLEANUP_PENDING, state };
      }
      return { kind: state.active === true ? FrameStateKind.ACTIVE : FrameStateKind.INACTIVE, state };
    }
    return { kind: FrameStateKind.UNKNOWN, error: new Error('malformed state response') };
  } catch (error) {
    return { ...classifyFrameQueryError(error), error };
  }
}

async function isFrameDocumentLive(tabId, frameId, documentId = null) {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames)) return true;
    if (isValidDocumentId(documentId)) {
      return frames.some(f => f?.frameId === frameId && f?.documentId === documentId);
    }
    return frames.some(f => f?.frameId === frameId);
  } catch {
    return true;
  }
}

async function isFrameStillAliveForDebt(tabId, frameId, documentId = null) {
  // F4: when documentId exists, liveness requires exact document match
  return isFrameDocumentLive(tabId, frameId, documentId);
}

async function isFrameKnownTooSmall(tabId, frameId) {
  if (!Number.isInteger(frameId) || frameId <= 0) {
    return false;
  }
  if (typeof browser.scripting?.executeScript !== 'function') return false;

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    const dimensions = Array.isArray(results) ? results[0]?.result : results?.result;
    return Number.isFinite(dimensions?.width)
      && Number.isFinite(dimensions?.height)
      && dimensions.width > 0
      && dimensions.height > 0
      && (dimensions.width < 80 || dimensions.height < 80);
  } catch {
    return false;
  }
}

async function isNoReceiverSafeForFrame(frame, tabId) {
  if (isStructurallyNonInjectableFrame(frame)) return true;
  const url = typeof frame?.url === 'string' ? frame.url.trim() : '';
  if (url) {
    try {
      if (await checkUrlExclusionAsync(url)) return true;
    } catch {
      return false;
    }
  }
  const frameId = frame?.frameId;
  if (Number.isInteger(frameId) && frameId > 0) {
    try {
      if (await isFrameKnownTooSmall(tabId, frameId)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function discoverAndReconcileActiveFrames(tabId, { deadlineAt = null } = {}) {
  const remainingTime = () => (
    Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : null
  );
  const awaitWithinDeadline = async promise => {
    const remaining = remainingTime();
    if (remaining !== null && remaining <= 0) throw new Error('retained session discovery timeout');
    let timeoutId;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          if (remaining === null) return;
          timeoutId = setTimeout(() => reject(new Error('retained session discovery timeout')), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  if (!browser.webNavigation?.getAllFrames) {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false, activeFrames: [] };
  }
  let frames = [];
  try {
    frames = await awaitWithinDeadline(browser.webNavigation.getAllFrames({ tabId }));
  } catch {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false, activeFrames: [] };
  }
  if (!Array.isArray(frames)) {
    return { status: 'unknown', discoveredCount: 0, fullyCleaned: false, activeFrames: [] };
  }
  const results = [];
  for (const frame of frames) {
    const frameId = frame?.frameId;
    const documentId = frame?.documentId || null;
    if (!Number.isInteger(frameId) || frameId < 0) continue;
    if (isStructurallyNonInjectableFrame(frame)) continue;
    let res;
    try {
      res = await awaitWithinDeadline(queryFrameStateWithKind(tabId, frameId, isValidDocumentId(documentId) ? documentId : null));
    } catch {
      return { status: 'unknown', discoveredCount: 0, fullyCleaned: false, activeFrames: [] };
    }
    const kind = res.kind;
    const state = res.state;
    const reason = res.reason;
    if (kind === FrameStateKind.ACTIVE) {
      results.push({ frameId, documentId: isValidDocumentId(documentId) ? documentId : (state?.documentId || null), state });
    } else if (kind === FrameStateKind.CLEANUP_PENDING) {
      // The frame owns an unconfirmed cleanup: it is not an active session to
      // restore, and it is not clean either, so it requires reconciliation.
      results.push({
        frameId,
        documentId: isValidDocumentId(documentId) ? documentId : null,
        state,
        kind: FrameStateKind.CLEANUP_PENDING,
      });
    } else if (kind === FrameStateKind.UNKNOWN) {
      let safeNoReceiver = false;
      if (reason === 'no-receiver') {
        try {
          safeNoReceiver = await awaitWithinDeadline(isNoReceiverSafeForFrame(frame, tabId));
        } catch {
          return { status: 'unknown', discoveredCount: 0, fullyCleaned: false, activeFrames: [] };
        }
      }
      if (safeNoReceiver) continue;
      results.push({ frameId, documentId: isValidDocumentId(documentId) ? documentId : null, state: null, kind: FrameStateKind.UNKNOWN });
    }
  }
  const requiresReconciliation = result => (
    result.kind === FrameStateKind.UNKNOWN || result.kind === FrameStateKind.CLEANUP_PENDING
  );
  return {
    status: results.some(requiresReconciliation) ? 'unknown' : 'known',
    discoveredCount: results.length,
    fullyCleaned: results.every(result => !requiresReconciliation(result)),
    activeFrames: results.filter(result => result.kind === FrameStateKind.ACTIVE),
  };
}

async function reconcileNewFrameIfActive(tabId, frameId, documentId) {
  const capturedRevision = getActiveSessionRevision(tabId);
  const capturedGen = getCurrentGeneration(tabId);
  const state = getStateForTab(tabId);
  if (!state.active || !Number.isInteger(capturedGen)) return false;
  if (isDeactivationPending(tabId)) return false;
  if (!Number.isInteger(frameId) || frameId < 0) return false;
  // Do not re-activate if already participant for this document
  const existing = getParticipantInfo(tabId, frameId);
  if (existing && isValidDocumentId(documentId) && isValidDocumentId(existing.documentId) && existing.documentId === documentId) {
    return false;
  }
  try {
    const target = buildDocumentAwareMessageTarget(frameId, documentId);
    // A successful activation must be owned or explicitly cleaned up. Retain
    // document-scoped debt before sending so a concurrent deactivation can see it.
    retainProvisionalCleanupFrame(tabId, frameId, capturedGen, documentId);
    const contentMessage = MessageFormat.create(
      MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
      {
        mode: 'select',
        active: true,
        activationEpoch: backgroundActivationEpoch,
        activationGeneration: capturedGen,
      },
      MessagingContexts.CONTENT,
    );
    const resp = await browser.tabs.sendMessage(tabId, contentMessage, target);
    // F5: strict ACK requires BOTH generation and epoch
    const hasGen = resp && typeof resp === 'object' && 'activationGeneration' in resp;
    const hasEpoch = resp && typeof resp === 'object' && 'activationEpoch' in resp;
    const ok = resp?.success === true && resp?.activated === true && hasGen && hasEpoch
      && resp.activationGeneration === capturedGen && resp.activationEpoch === backgroundActivationEpoch;
    const activationReportedSuccess = ok
      || resp === true
      || (resp?.success === true && resp?.activated === true);
    // F2: revalidate authority before registration
    const currentGenNow = getCurrentGeneration(tabId);
    const currentRevNow = getActiveSessionRevision(tabId);
    const stillActive = getStateForTab(tabId).active === true;
    if (currentRevNow !== capturedRevision || currentGenNow !== capturedGen || !stillActive) {
      if (activationReportedSuccess) {
        const cleanupResponse = await browser.tabs.sendMessage(
          tabId,
          MessageFormat.create(
            MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
            {
              mode: 'normal',
              active: false,
              fromBackground: true,
              activationEpoch: backgroundActivationEpoch,
              activationGeneration: capturedGen,
              isExplicitDeactivation: true,
            },
            MessagingContexts.CONTENT,
          ),
          target,
        ).catch(() => null);
        if (
          cleanupResponse?.success === true
          && cleanupResponse?.cleanupCompleted === true
          && cleanupResponse?.activated === false
        ) {
          removeProvisionalCleanupFrame(tabId, frameId, capturedGen);
        }
      }
      return false;
    }
    if (ok) {
      let participants = selectElementParticipantsByTab.get(tabId);
      if (!participants) {
        participants = new Map();
        selectElementParticipantsByTab.set(tabId, participants);
      }
      participants.set(frameId, { generation: capturedGen, documentId: isValidDocumentId(documentId) ? documentId : null });
      bumpOwnershipRevision(tabId);
      removeProvisionalCleanupFrame(tabId, frameId, capturedGen);
      return true;
    }
    // F5: generation/epoch incomplete ACK -> compatibility only
    if (resp === true || (resp?.success === true && resp?.activated === true && (!hasGen || !hasEpoch))) {
      // Only retain compatibility if generation matches current or is at least provided; use capturedGen for ownership
      retainCompatibilityFrames(tabId, capturedGen, [frameId]);
      removeProvisionalCleanupFrame(tabId, frameId, capturedGen);
      return false;
    }
    removeProvisionalCleanupFrame(tabId, frameId, capturedGen);
  } catch {
    // Unknown send state remains cleanup debt until authoritative cleanup settles it.
  }
  return false;
}

async function reconcileStaleOwnershipForRead(tabId) {
  if (!Number.isInteger(tabId)) return;
  const initialState = getStateForTab(tabId);
  if (!initialState.active) return;

  const capturedRevision = getActiveSessionRevision(tabId);
  const capturedGen = getCurrentGeneration(tabId);
  const capturedOwnershipRevision = getOwnershipRevision(tabId);

  // Snapshot current ownership before async live check to avoid deleting
  // concurrent new ownership that appears after the snapshot.
  const capturedParticipants = new Map(selectElementParticipantsByTab.get(tabId) || []);
  const capturedCompat = new Map(compatibilityFramesByTab.get(tabId) || []);
  const capturedProvisional = new Map();
  for (const [fid, genMap] of provisionalCleanupFramesByTab.get(tabId) || []) {
    capturedProvisional.set(fid, new Map(genMap));
  }

  let liveFrames;
  let timeoutId;
  try {
    if (!browser.webNavigation?.getAllFrames) return;
    const framesPromise = browser.webNavigation.getAllFrames({ tabId });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error('liveness reconciliation timeout');
        err.isReconciliationTimeout = true;
        reject(err);
      }, RECONCILE_LIVENESS_TIMEOUT_MS);
    });
    liveFrames = await Promise.race([framesPromise, timeoutPromise]);
  } catch {
    return;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!Array.isArray(liveFrames)) return;

  if (getOwnershipRevision(tabId) !== capturedOwnershipRevision) return;

  const isLive = (frameId, docId) => {
    const live = liveFrames.find(f => f?.frameId === frameId);
    if (!live) return false;
    if (isValidDocumentId(docId)) {
      if (!isValidDocumentId(live.documentId)) return true;
      return live.documentId === docId;
    }
    return true;
  };

  for (const [fid, info] of capturedParticipants.entries()) {
    if (!isLive(fid, info.documentId)) {
      const current = selectElementParticipantsByTab.get(tabId)?.get(fid);
      if (current && current.generation === info.generation && current.documentId === info.documentId) {
        removeParticipant(tabId, fid, info.generation, info.documentId);
      }
    }
  }

  for (const [fid, gen] of capturedCompat.entries()) {
    if (!isLive(fid, null)) {
      const currentGen = compatibilityFramesByTab.get(tabId)?.get(fid);
      if (currentGen === gen) {
        removeCompatibilityFrame(tabId, fid);
      }
    }
  }

  for (const [fid, genMap] of capturedProvisional.entries()) {
    for (const [gen, docId] of genMap.entries()) {
      if (!isLive(fid, docId)) {
        const currentGenMap = provisionalCleanupFramesByTab.get(tabId)?.get(fid);
        if (currentGenMap && currentGenMap.get(gen) === docId) {
          removeProvisionalCleanupFrame(tabId, fid, gen);
        }
      }
    }
  }

  const hasParticipants = (selectElementParticipantsByTab.get(tabId)?.size || 0) > 0;
  const hasCompat = (compatibilityFramesByTab.get(tabId)?.size || 0) > 0;
  const hasProvisional = (() => {
    const frames = provisionalCleanupFramesByTab.get(tabId);
    if (!frames) return false;
    for (const m of frames.values()) if (m.size > 0) return true;
    return false;
  })();

  if (hasParticipants || hasCompat || hasProvisional) return;

  const currentState = getStateForTab(tabId);
  const currentRevision = getActiveSessionRevision(tabId);
  const currentGenNow = getCurrentGeneration(tabId);
  const currentHasParticipants = (selectElementParticipantsByTab.get(tabId)?.size || 0) > 0;
  const currentHasCompat = (compatibilityFramesByTab.get(tabId)?.size || 0) > 0;
  const currentHasProvisional = (() => {
    const frames = provisionalCleanupFramesByTab.get(tabId);
    if (!frames) return false;
    for (const m of frames.values()) if (m.size > 0) return true;
    return false;
  })();

  if (
    currentState.active === true &&
    currentRevision === capturedRevision &&
    currentGenNow === capturedGen &&
    !currentHasParticipants &&
    !currentHasCompat &&
    !currentHasProvisional
  ) {
    setStateForTab(tabId, false);
  }
}

function setStateForTab(tabId, active) {
  if (!tabId) return;
  const canonicalActive = active === true;
  const currentState = selectElementStateByTab.get(tabId);
  if (currentState?.active === canonicalActive) return;

  selectElementStateByTab.set(tabId, { active: canonicalActive, updatedAt: Date.now() });
  // F2: bump join authority revision on every active state transition
  bumpActiveSessionRevision(tabId);

  // Notify all parts of the extension about the state change
  (async () => {
    try {
      const message = MessageFormat.create(
        MessageActions.SELECT_ELEMENT_STATE_CHANGED,
        { tabId, active: canonicalActive },
        MessagingContexts.BACKGROUND
      );
      // Use runtime.sendMessage to broadcast to all parts of the extension (sidepanel, content scripts, etc.)
      await browser.runtime.sendMessage(message);
        } catch {
      // Ignore errors if no listeners are available
    }
  })();
}

function getStateForTab(tabId) {
  if (!tabId) return { active: false };
  const entry = selectElementStateByTab.get(tabId);
  return { active: !!(entry && entry.active), updatedAt: entry?.updatedAt };
}

function clearStateForTab(tabId) {
  if (!tabId) return;
  selectElementStateByTab.delete(tabId);
  invalidateRetainedSessionRecovery(tabId);
  clearDeactivationPending(tabId);
}

// Track last active tab so we can deactivate select-mode when the user switches
let _lastActiveTabId = null;

try {
  if (browser && browser.tabs) {
    // Keep track of tab removal
    if (browser.tabs.onRemoved) {
      browser.tabs.onRemoved.addListener((tabId) => {
        clearStateForTab(tabId);
        clearTabParticipants(tabId);
        invalidateRetainedSessionRecovery(tabId);
        if (_lastActiveTabId === tabId) _lastActiveTabId = null;
      });
    }

    // When the active tab changes, update the last active tab ID
    if (browser.tabs.onActivated) {
      browser.tabs.onActivated.addListener((activeInfo) => {
        _lastActiveTabId = activeInfo.tabId;
      });
    }

    if (browser.webNavigation?.onCommitted) {
      browser.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
        if (!Number.isInteger(tabId) || !Number.isInteger(frameId)) return;

        const isTop = frameId === 0;
        if (isTop) invalidateRetainedSessionRecovery(tabId);
        // P4: document-aware retirement
        if (isValidDocumentId(documentId)) {
          // Invalidate attempts for this tab (navigation breaks pending dispatch)
          const invalidatedAttempts = invalidateActivationAttempts(tabId);
          if (!isTop) {
            void compensateInvalidatedActivationAttempts(tabId, invalidatedAttempts);
          } else {
            // top navigation retires provisional debt without broadcast
          }
          retireFrameCleanupOwnership(tabId, frameId, documentId);
          if (isTop) {
            clearCompatibilityFrames(tabId);
            clearProvisionalCleanupFrames(tabId);
            // Clear participants whose document is not the newly committed top document.
            // If top document changed, old top participant should be retired.
            const topInfo = getParticipantInfo(tabId, 0);
            if (topInfo && isValidDocumentId(topInfo.documentId) && topInfo.documentId !== documentId) {
              removeParticipant(tabId, 0, topInfo.generation, topInfo.documentId);
            } else if (topInfo && !isValidDocumentId(topInfo.documentId)) {
              // Fallback: clear all when no doc awareness
              clearParticipants(tabId);
            } else if (!topInfo) {
              clearParticipants(tabId);
            }
            // Also clear any child participants bound to previous top document lifecycle? Keep child entries but they will be re-evaluated.
            // For strict top nav, clear all participants.
            if (getParticipants(tabId).size !== 0 && !getParticipantInfo(tabId, 0)) {
              // If top had no participant but children did, top nav still invalidates children
              if (selectElementParticipantsByTab.has(tabId)) {
                selectElementParticipantsByTab.delete(tabId);
                bumpOwnershipRevision(tabId);
              }
            }
          } else {
            const didRemove = removeParticipantForNavigation(tabId, frameId, documentId);
            // If navigation was for a document that was old and we removed stale participant, we're done.
            // If map still holds new doc equality, keep.
            void didRemove;
          }
        } else {
          // Fallback when documentId unavailable
          retireFrameCleanupOwnership(tabId, frameId);
          const invalidatedAttempts = invalidateActivationAttempts(tabId);
          if (isTop) {
            clearCompatibilityFrames(tabId);
            clearProvisionalCleanupFrames(tabId);
          } else {
            void compensateInvalidatedActivationAttempts(tabId, invalidatedAttempts);
          }
          if (isTop) {
            clearParticipants(tabId);
          } else {
            const participantGeneration = getParticipants(tabId).get(frameId);
            if (participantGeneration !== undefined) {
              removeParticipant(tabId, frameId, participantGeneration);
            }
          }
        }

        if (getParticipants(tabId).size === 0 && getStateForTab(tabId).active) {
          setStateForTab(tabId, false);
        }
      });
    }

    // Window focus changes no longer deactivate Select Element mode
  }
} catch {
  // ignore in environments without tabs/windows
}

export {
  setStateForTab,
  getStateForTab,
  clearStateForTab,
  reconcileStaleOwnershipForRead,
  RECONCILE_LIVENESS_TIMEOUT_MS,
  RETAINED_SESSION_DISCOVERY_TIMEOUT_MS,
  getOwnershipRevision,
  createActivationGeneration,
  getCurrentGeneration,
  getActivationEpoch,
  getActivationAttemptToken,
  isActivationAttemptCurrent,
  recordActivationAttemptFrames,
  invalidateOlderActivationAttempts,
  invalidateActivationAttempts,
  completeActivationAttempt,
  compensateInvalidatedActivationAttempts,
  retainCompatibilityFrames,
  getCompatibilityFrames,
  removeCompatibilityFrame,
  clearCompatibilityFrames,
  settleActivationAttemptFrame,
  getProvisionalCleanupFrames,
  removeProvisionalCleanupFrame,
  clearProvisionalCleanupFrames,
  registerParticipant,
  removeParticipant,
  getParticipants,
  getParticipantsWithDocuments,
  getParticipantInfo,
  clearParticipants,
  clearTabParticipants,
  queryFrameSelectElementState,
  queryFrameStateWithKind,
  FrameStateKind,
  isFrameDocumentLive,
  isFrameStillAliveForDebt,
  isStructurallyNonInjectableFrame,
  isNoReceiverSafeForFrame,
  isFrameKnownTooSmall,
  getActiveSessionRevision,
  invalidateJoinAuthority,
  discoverAndReconcileActiveFrames,
  reconcileNewFrameIfActive,
  isValidDocumentId,
  markDeactivationPending,
  isDeactivationPending,
  clearDeactivationPending,
  beginRetainedSessionRecovery,
  getRetainedSessionRecoveryRecord,
  isRetainedSessionRecoveryCurrent,
  setRetainedSessionRecoveryPromise,
  invalidateRetainedSessionRecovery,
  clearRetainedSessionRecovery,
};

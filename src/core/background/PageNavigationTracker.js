import browser from 'webextension-polyfill';

const STORAGE_KEY = 'pageTranslationNavigation';
const validCursor = value => Number.isSafeInteger(value?.documentEpoch) && value.documentEpoch > 0
  && Number.isSafeInteger(value.routeRevision) && value.routeRevision >= 0
  && typeof value.url === 'string' && value.url.length > 0;
const validTokenMap = value => value === undefined || (value && typeof value === 'object'
  && !Array.isArray(value) && Object.entries(value).every(([frameId, token]) => (
    /^\d+$/.test(frameId) && typeof token === 'string' && token.length > 0
  )));
const validAttemptRevisionMap = value => value === undefined || (value && typeof value === 'object'
  && !Array.isArray(value) && Object.entries(value).every(([frameId, revision]) => (
    /^\d+$/.test(frameId) && typeof revision === 'string' && /^[1-9]\d*$/.test(revision)
    && Number.isSafeInteger(Number(revision))
  )));
const validManualGrant = grant => {
  if (!Number.isSafeInteger(grant?.generation) || grant.generation < 0 || typeof grant.revoked !== 'boolean') return false;
  if (grant.attemptRevision !== undefined && (!Number.isSafeInteger(grant.attemptRevision) || grant.attemptRevision < 0)) return false;
  if (grant.attemptId !== undefined && (typeof grant.attemptId !== 'string' || !grant.attemptId)) return false;
  if ((grant.confirmedAttemptId !== undefined || grant.confirmedAttemptRevision !== undefined)
      && (typeof grant.confirmedAttemptId !== 'string' || !grant.confirmedAttemptId
        || typeof grant.confirmedAttemptRevision !== 'string'
        || !/^[1-9]\d*$/.test(grant.confirmedAttemptRevision)
        || !Number.isSafeInteger(Number(grant.confirmedAttemptRevision)))) return false;
  if (grant.revoked) {
    return validTokenMap(grant.revokedAcceptedDocuments)
      && validTokenMap(grant.revokedAcceptedAttemptIds)
      && validAttemptRevisionMap(grant.revokedAcceptedAttemptRevisions)
      && validTokenMap(grant.revokedProvisionalDocuments)
      && validTokenMap(grant.revokedProvisionalAttemptIds)
      && validAttemptRevisionMap(grant.revokedProvisionalAttemptRevisions);
  }
  return Number.isSafeInteger(grant.topDocumentEpoch) && grant.topDocumentEpoch > 0
    && (grant.topDocumentToken === undefined || (typeof grant.topDocumentToken === 'string' && grant.topDocumentToken.length > 0))
    && grant.frames && typeof grant.frames === 'object' && !Array.isArray(grant.frames)
    && Object.entries(grant.frames).every(([frameId, epoch]) => (
      /^\d+$/.test(frameId) && Number.isSafeInteger(epoch) && epoch > 0
    ))
       && validTokenMap(grant.documents) && validTokenMap(grant.startedDocuments)
        && validTokenMap(grant.acceptedDocuments)
        && validTokenMap(grant.acceptedAttemptIds) && validAttemptRevisionMap(grant.acceptedAttemptRevisions)
        && validTokenMap(grant.provisionalDocuments) && validTokenMap(grant.provisionalAttemptIds)
         && validAttemptRevisionMap(grant.provisionalAttemptRevisions);
};
const getManualAttemptRevisionHighWater = grant => [
  grant?.attemptRevision,
  grant?.confirmedAttemptRevision,
  grant?.revokedAttemptRevision,
  ...Object.values(grant?.acceptedAttemptRevisions || {}),
  ...Object.values(grant?.provisionalAttemptRevisions || {}),
  ...Object.values(grant?.revokedAcceptedAttemptRevisions || {}),
  ...Object.values(grant?.revokedProvisionalAttemptRevisions || {}),
].reduce((highest, revision) => Math.max(highest, Number(revision) || 0), 0);
const getManualStartKey = (tabId, operationId) => `${tabId}:attempt:${operationId}`;
const updateConfirmedManualAttempt = (grant, attemptId, attemptRevision) => {
  if (Number.isSafeInteger(attemptRevision)
      && (!grant.confirmedAttemptRevision || attemptRevision >= Number(grant.confirmedAttemptRevision))) {
    grant.confirmedAttemptId = attemptId;
    grant.confirmedAttemptRevision = String(attemptRevision);
  }
};

export class PageNavigationTracker {
  constructor(storage = browser.storage?.session) {
    this.storage = storage;
    this.state = null;
    this.durableState = null;
    this.dirty = false;
    this.pending = Promise.resolve();
    this.restartFences = new Map();
    this.blockedManualContinuity = new Map();
    this.manualRevocationIntents = new Map();
    this.manualContinuityRevision = new Map();
    this.manualContinuityHighWater = new Map();
    this.manualStartOperations = new Map();
    this.manualFrameStartClaims = new Set();
    this.manualStartSnapshots = new Map();
  }

  mintRestartFence(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return null;
    const fence = crypto.randomUUID();
    this.restartFences.set(tabId, fence);
    return fence;
  }

  getRestartFence(tabId) {
    return this.restartFences.get(tabId) || null;
  }

  getOrMintRestartFence(tabId) {
    return this.getRestartFence(tabId) || this.mintRestartFence(tabId);
  }

  revokeRestartFence(tabId) {
    return this.mintRestartFence(tabId);
  }

  _run(update, { rollbackManualTabId = null } = {}) {
    const operation = this.pending.then(async () => {
      if (!this.state) {
        const saved = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
        if (saved && (
          !Number.isSafeInteger(saved.nextDocumentEpoch) || saved.nextDocumentEpoch < 0
          || !saved.frames || typeof saved.frames !== 'object' || Array.isArray(saved.frames)
          || Object.entries(saved.frames).some(([key, cursor]) => (
            !/^\d+:\d+$/.test(key) || !validCursor(cursor) || cursor.documentEpoch > saved.nextDocumentEpoch
          ))
          || (saved.manualContinuity !== undefined && (!saved.manualContinuity
            || typeof saved.manualContinuity !== 'object' || Array.isArray(saved.manualContinuity)
            || Object.entries(saved.manualContinuity).some(([key, grant]) => (
              !/^\d+$/.test(key) || !validManualGrant(grant)
              || (!grant.revoked && (grant.topDocumentEpoch > saved.nextDocumentEpoch
                || Object.values(grant.frames).some(epoch => epoch > saved.nextDocumentEpoch)))
            ))))
        )) throw new Error('Invalid Page navigation storage');
        this.state = saved || { nextDocumentEpoch: 0, frames: {}, manualContinuity: {} };
        this.state.manualContinuity ||= {};
        for (const [tabId, grant] of Object.entries(this.state.manualContinuity)) {
          const revision = getManualAttemptRevisionHighWater(grant);
          this.manualContinuityHighWater.set(Number(tabId), Math.max(
            this.manualContinuityHighWater.get(Number(tabId)) ?? 0, revision,
          ));
          if (!grant.revoked && (!grant.armed || !grant.topDocumentToken
              || !Number.isSafeInteger(grant.attemptRevision) || !grant.attemptId)) {
            this.state.manualContinuity[tabId] = { generation: grant.generation + 1, revoked: true };
            this.dirty = true;
          }
        }
        this.durableState = structuredClone(this.state);
      }
      const previousManualGrant = rollbackManualTabId == null ? null
        : structuredClone(this.state.manualContinuity[rollbackManualTabId] ?? null);
      const result = await update(this.state);
      if (this.dirty) {
        try {
          await this.storage.set({ [STORAGE_KEY]: this.state });
        } catch (error) {
          if (rollbackManualTabId != null) {
            if (previousManualGrant) this.state.manualContinuity[rollbackManualTabId] = previousManualGrant;
            else delete this.state.manualContinuity[rollbackManualTabId];
          }
          throw error;
        }
        this.dirty = false;
        this.durableState = structuredClone(this.state);
      }
      return result && typeof result === 'object' ? { ...result } : result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async getManualContinuity(tabId) {
    if (!this.durableState) await this._run(() => null);
    const grant = this.durableState?.manualContinuity?.[tabId];
    const block = this.blockedManualContinuity.get(tabId);
    const isBlocked = block && (block.generation == null || block.generation === grant?.generation);
    return !isBlocked && grant && !grant.revoked ? structuredClone(grant) : null;
  }

  async getManualContinuityForRevocation(tabId) {
    if (!this.durableState) await this._run(() => null);
    const grant = this.durableState?.manualContinuity?.[tabId];
    return grant ? structuredClone(grant) : null;
  }

  async getManualContinuityStatus(tabId) {
    if (!this.durableState) await this._run(() => null);
    const grant = this.durableState?.manualContinuity?.[tabId];
    const block = this.blockedManualContinuity.get(tabId);
    return {
      hasManualContinuity: Boolean(grant && !grant.revoked),
      manualContinuityGeneration: Number.isSafeInteger(grant?.generation) ? grant.generation : null,
      manualContinuityRevocationPending: Boolean(grant && !grant.revoked && block
        && (block.generation == null || block.generation === grant.generation)),
    };
  }

  reserveManualContinuityStart(tabId, operationId = null) {
    const revision = Math.max(
      this.manualContinuityRevision.get(tabId) ?? 0,
      this.manualContinuityHighWater.get(tabId) ?? 0,
    ) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('Manual continuity revision exhausted');
    this.manualContinuityRevision.set(tabId, revision);
    this.manualContinuityHighWater.set(tabId, revision);
    this.manualStartOperations.set(tabId, {
      id: typeof operationId === 'string' ? operationId : null,
      reservedBeforeHydration: !this.state && !this.durableState,
    });
    return revision;
  }

  cancelManualContinuityStart(tabId, operationId) {
    const operation = this.manualStartOperations.get(tabId);
    const isCurrent = typeof operationId === 'string' && operation?.id === operationId;
    const currentRevision = this.manualContinuityRevision.get(tabId) ?? 0;
    if (isCurrent) {
      this.manualContinuityRevision.set(tabId, currentRevision + 1);
      this.manualStartOperations.delete(tabId);
    }
    const snapshotKey = typeof operationId === 'string' ? getManualStartKey(tabId, operationId) : null;
    const snapshot = snapshotKey && this.manualStartSnapshots.get(snapshotKey);
    if (snapshot) {
      this.manualStartSnapshots.delete(snapshotKey);
      void this._run(state => {
        const grant = state.manualContinuity[tabId];
        if (grant?.attemptId !== snapshot.attemptId) return false;
        if (snapshot.previous) state.manualContinuity[tabId] = structuredClone(snapshot.previous);
        else delete state.manualContinuity[tabId];
        this.dirty = true;
        return true;
      }).catch(() => {});
    }
    return isCurrent;
  }

  async grantManualContinuity(tabId, operationRevision = this.reserveManualContinuityStart(tabId), options = {}) {
    if (typeof options.topDocumentToken !== 'string' || !options.topDocumentToken) {
      throw new Error('Top document identity is unavailable');
    }
    const attemptId = options.attemptId || crypto.randomUUID();
    let committedRevision = operationRevision;
    return this._run(async state => {
      if (this.manualContinuityRevision.get(tabId) !== operationRevision) throw new Error('Manual continuity start superseded');
      const operation = this.manualStartOperations.get(tabId);
      if (operation?.id && operation.id !== attemptId) throw new Error('Manual continuity start superseded');
      const highWater = this.manualContinuityHighWater.get(tabId) ?? 0;
      const reservedBeforeHydration = operation?.reservedBeforeHydration === true;
      committedRevision = highWater > operationRevision
        || (reservedBeforeHydration && highWater >= operationRevision)
        ? highWater + 1 : operationRevision;
      if (!Number.isSafeInteger(committedRevision)) throw new Error('Manual continuity revision exhausted');
      this.manualContinuityRevision.set(tabId, committedRevision);
      this.manualContinuityHighWater.set(tabId, committedRevision);
      this.manualStartOperations.set(tabId, { id: attemptId, reservedBeforeHydration: false });
      const top = state.frames[`${tabId}:0`];
      if (!top) throw new Error('Top document is not admitted');
      const previous = state.manualContinuity[tabId];
      const block = this.blockedManualContinuity.get(tabId);
      if (previous && !previous.revoked && previous.armed && previous.topDocumentEpoch === top.documentEpoch
          && previous.topDocumentToken === options.topDocumentToken
          && !(block && (block.generation == null || block.generation === previous.generation))) {
        return { grant: previous, reused: true, pendingAttemptId: attemptId, previousAttemptId: previous.attemptId };
      }
      const generation = (previous?.generation || 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('Manual continuity generation exhausted');
      const frames = {};
      for (const [key, cursor] of Object.entries(state.frames)) {
        if (key.startsWith(`${tabId}:`)) frames[key.slice(`${tabId}:`.length)] = cursor.documentEpoch;
      }
      const grant = {
        generation, revoked: false, armed: false, topDocumentEpoch: top.documentEpoch, frames,
        topDocumentToken: options.topDocumentToken,
        attemptRevision: committedRevision,
        attemptId,
        ...(options.handlerManaged === true && { handlerManaged: true }),
        ...(typeof options.provider === 'string' && { provider: options.provider }),
        ...(typeof options.targetLanguage === 'string' && { targetLanguage: options.targetLanguage }),
        ...(typeof options.isExplicitProvider === 'boolean' && { isExplicitProvider: options.isExplicitProvider }),
      };
      state.manualContinuity[tabId] = grant;
      this.manualStartSnapshots.set(getManualStartKey(tabId, attemptId), {
        previous: previous ? structuredClone(previous) : null,
        attemptId,
      });
      this.dirty = true;
      return { grant, reused: false };
    }).then(async ({ grant, reused, pendingAttemptId, previousAttemptId }) => {
      const durable = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY]?.manualContinuity?.[tabId];
      if (this.manualContinuityRevision.get(tabId) !== committedRevision
          || !durable || durable.revoked || durable.generation !== grant.generation
          || durable.attemptId !== grant.attemptId) {
        this.cancelManualContinuityStart(tabId, attemptId);
        throw new Error('Manual continuity grant not durable');
      }
      this.manualStartSnapshots.delete(getManualStartKey(tabId, attemptId));
      this.blockedManualContinuity.delete(tabId);
      if (reused) return {
        ...durable,
        attemptId: pendingAttemptId,
        attemptRevision: committedRevision,
        previousAttemptId,
        reused: true,
      };
      Object.defineProperty(durable, 'reused', { value: reused });
      return durable;
    });
  }

  async armManualContinuity(tabId, generation, expectedRevision = this.manualContinuityRevision.get(tabId) ?? 0) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      if ((this.manualContinuityRevision.get(tabId) ?? 0) !== expectedRevision
          || !grant || grant.revoked || grant.generation !== generation
          || grant.topDocumentEpoch !== top?.documentEpoch
          || (block && (block.generation == null || block.generation === generation))) return false;
      if (!grant.armed) {
        grant.armed = true;
        this.dirty = true;
      }
      return true;
    });
  }

  async admitManualFrame(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, url, documentToken) {
    if (!Number.isInteger(frameId) || frameId <= 0 || typeof url !== 'string' || !url
        || typeof documentToken !== 'string' || !documentToken) return null;
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      if (!grant || grant.revoked || !grant.armed || grant.generation !== generation
          || grant.topDocumentEpoch !== topDocumentEpoch || top?.documentEpoch !== topDocumentEpoch
          || grant.topDocumentToken !== topDocumentToken
          || (block && (block.generation == null || block.generation === generation))) return null;
      const key = `${tabId}:${frameId}`;
      let cursor = state.frames[key];
      if (!cursor) {
        cursor = state.frames[key] = this._newDocument(state, url);
      } else if (grant.documents?.[frameId] && grant.documents[frameId] !== documentToken
          && grant.frames?.[frameId] === cursor.documentEpoch) {
        cursor = state.frames[key] = this._newDocument(state, url);
      } else if (cursor.url !== url) {
        cursor = this._capture(cursor, url);
      }
      const alreadyAdmitted = grant.frames[frameId] === cursor.documentEpoch
        && grant.documents?.[frameId] === documentToken;
      grant.frames[frameId] = cursor.documentEpoch;
      grant.documents ||= {};
      grant.documents[frameId] = documentToken;
      if (!alreadyAdmitted) this.dirty = true;
      return { cursor, grant, alreadyAdmitted };
    }).then(result => result && ({
      cursor: { ...result.cursor }, grant: structuredClone(result.grant), alreadyAdmitted: result.alreadyAdmitted,
    }));
  }

  async claimManualFrameStart(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken, attemptId, attemptRevision) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const frame = state.frames[`${tabId}:${frameId}`];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      const attemptAccepted = Number.isSafeInteger(attemptRevision) && (Object.entries(grant?.acceptedAttemptIds || {}).some(([acceptedFrameId, acceptedId]) => (
        acceptedId === attemptId && grant.acceptedAttemptRevisions?.[acceptedFrameId] === String(attemptRevision)
      )) || this.hasConfirmedManualAttempt(tabId, generation, attemptId, attemptRevision));
      if (!grant || grant.revoked || !grant.armed || grant.generation !== generation
          || !attemptAccepted
          || grant.topDocumentEpoch !== topDocumentEpoch || top?.documentEpoch !== topDocumentEpoch
          || grant.topDocumentToken !== topDocumentToken
          || grant.frames?.[frameId] !== frameCursor?.documentEpoch
          || grant.documents?.[frameId] !== documentToken
          || frame?.documentEpoch !== frameCursor?.documentEpoch
          || frame?.routeRevision !== frameCursor?.routeRevision || frame?.url !== frameCursor?.url
          || (block && (block.generation == null || block.generation === generation))) return false;
      const claimKey = `${tabId}:${frameId}:${generation}:${documentToken}`;
      if (grant.startedDocuments?.[frameId] === documentToken || this.manualFrameStartClaims.has(claimKey)) return false;
      this.manualFrameStartClaims.add(claimKey);
      return true;
    });
  }

  async completeManualFrameStart(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken, accepted, attemptId, attemptRevision) {
    const claimKey = `${tabId}:${frameId}:${generation}:${documentToken}`;
    try {
      return await this._run(state => {
        const grant = state.manualContinuity[tabId];
        const frame = state.frames[`${tabId}:${frameId}`];
        const top = state.frames[`${tabId}:0`];
        const block = this.blockedManualContinuity.get(tabId);
        const attemptAccepted = Number.isSafeInteger(attemptRevision) && (Object.entries(grant?.acceptedAttemptIds || {}).some(([acceptedFrameId, acceptedId]) => (
          acceptedId === attemptId && grant.acceptedAttemptRevisions?.[acceptedFrameId] === String(attemptRevision)
        )) || this.hasConfirmedManualAttempt(tabId, generation, attemptId, attemptRevision));
        const existingTargetTuple = grant?.acceptedDocuments?.[frameId] === documentToken
          && (grant.acceptedAttemptIds?.[frameId] !== attemptId
            || grant.acceptedAttemptRevisions?.[frameId] !== String(attemptRevision));
        const current = grant && !grant.revoked && grant.armed && grant.generation === generation
          && attemptAccepted
          && grant.topDocumentEpoch === topDocumentEpoch && grant.topDocumentToken === topDocumentToken
          && top?.documentEpoch === topDocumentEpoch && grant.frames?.[frameId] === frameCursor?.documentEpoch
          && grant.documents?.[frameId] === documentToken
          && frame?.documentEpoch === frameCursor?.documentEpoch
          && frame?.routeRevision === frameCursor?.routeRevision && frame?.url === frameCursor?.url
          && this.manualFrameStartClaims.has(claimKey)
          && grant.startedDocuments?.[frameId] !== documentToken
          && !existingTargetTuple
          && !(block && (block.generation == null || block.generation === generation));
        const clearMatchingProvisional = () => {
          if (grant?.provisionalAttemptIds?.[frameId] === attemptId
              && grant.provisionalAttemptRevisions?.[frameId] === String(attemptRevision)
              && grant.provisionalDocuments?.[frameId] === documentToken) {
            delete grant.provisionalDocuments[frameId];
            delete grant.provisionalAttemptIds[frameId];
            delete grant.provisionalAttemptRevisions[frameId];
            this.dirty = true;
          }
        };
        if (!accepted || !current) {
          clearMatchingProvisional();
          return false;
        }
        grant.startedDocuments ||= {};
        if (grant.startedDocuments[frameId] !== documentToken) {
          grant.startedDocuments[frameId] = documentToken;
          this.dirty = true;
        }
        if (attemptId != null && Number.isSafeInteger(attemptRevision)) {
          grant.acceptedDocuments ||= {};
          grant.acceptedAttemptIds ||= {};
          grant.acceptedAttemptRevisions ||= {};
          grant.acceptedDocuments[frameId] = documentToken;
          grant.acceptedAttemptIds[frameId] = attemptId;
          grant.acceptedAttemptRevisions[frameId] = String(attemptRevision);
          updateConfirmedManualAttempt(grant, attemptId, attemptRevision);
          this.dirty = true;
        }
        clearMatchingProvisional();
        return true;
      });
    } finally {
      this.manualFrameStartClaims.delete(claimKey);
    }
  }

  async recordManualFrameAcceptance(
    tabId, generation, attemptId, attemptRevision, frameId, documentToken, frameCursor,
    expectedActiveAttemptId = null, requireCurrentRevision = false
  ) {
    if (!Number.isInteger(frameId) || frameId < 0 || typeof documentToken !== 'string' || !documentToken) return false;
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const top = state.frames[`${tabId}:0`];
      const frame = state.frames[`${tabId}:${frameId}`];
      const sameAcceptedTuple = grant?.acceptedAttemptIds?.[frameId] === attemptId
        && grant?.acceptedAttemptRevisions?.[frameId] === String(attemptRevision)
        && grant?.acceptedDocuments?.[frameId] === documentToken;
      const activeTuple = grant?.attemptId === attemptId && grant?.attemptRevision === attemptRevision
        && (!requireCurrentRevision || this.manualContinuityRevision.get(tabId) === attemptRevision);
      const currentProvisionalTuple = grant?.attemptId === expectedActiveAttemptId
        && this.manualContinuityRevision.get(tabId) === attemptRevision;
      if (!grant || !frame || !frameCursor || grant.revoked || grant.generation !== generation
          || (!sameAcceptedTuple && !activeTuple && !currentProvisionalTuple)
          || grant.topDocumentEpoch !== top?.documentEpoch || frame?.documentEpoch !== frameCursor?.documentEpoch
          || frame?.routeRevision !== frameCursor?.routeRevision || frame?.url !== frameCursor?.url
          || (frameId === 0 && (documentToken !== grant.topDocumentToken || frame.documentEpoch !== grant.topDocumentEpoch))) return false;
      grant.frames[frameId] = frame.documentEpoch;
      grant.documents ||= {};
      grant.documents[frameId] = documentToken;
      grant.acceptedDocuments ||= {};
      grant.acceptedAttemptIds ||= {};
      grant.acceptedAttemptRevisions ||= {};
      grant.acceptedDocuments[frameId] = documentToken;
      grant.acceptedAttemptIds[frameId] = attemptId;
      grant.acceptedAttemptRevisions[frameId] = String(attemptRevision);
      updateConfirmedManualAttempt(grant, attemptId, attemptRevision);
      this.dirty = true;
      if (currentProvisionalTuple && !activeTuple) {
        grant.attemptId = attemptId;
        grant.attemptRevision = attemptRevision;
      }
      if (!grant.armed) {
        grant.armed = true;
        this.dirty = true;
      }
      return true;
    });
  }

  async stageManualFrameAcceptance(
    tabId, generation, attemptId, attemptRevision, frameId, documentToken, frameCursor,
    expectedActiveAttemptId = null, requireCurrentRevision = false, strictTuple = false
  ) {
    if (!Number.isInteger(frameId) || frameId < 0 || typeof documentToken !== 'string' || !documentToken) return false;
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const top = state.frames[`${tabId}:0`];
      const frame = state.frames[`${tabId}:${frameId}`];
      const activeTuple = grant?.attemptId === attemptId && grant?.attemptRevision === attemptRevision
        && (!requireCurrentRevision || this.manualContinuityRevision.get(tabId) === attemptRevision);
      const pendingTuple = grant?.attemptId === expectedActiveAttemptId
        && this.manualContinuityRevision.get(tabId) === attemptRevision;
      const acceptedTuple = Object.entries(grant?.acceptedAttemptIds || {}).some(([acceptedFrame, acceptedId]) => (
        acceptedId === attemptId && grant.acceptedAttemptRevisions?.[acceptedFrame] === String(attemptRevision)
      ));
      const block = this.blockedManualContinuity.get(tabId);
      const alreadyAccepted = Object.entries(grant?.acceptedAttemptIds || {}).some(([acceptedFrame, acceptedId]) => (
        acceptedId === attemptId
          && grant.acceptedAttemptRevisions?.[acceptedFrame] === String(attemptRevision)
      ));
      const confirmedSource = this.hasConfirmedManualAttempt(tabId, generation, attemptId, attemptRevision);
      if (!grant || !frame || !frameCursor || grant.revoked || grant.generation !== generation
          || (strictTuple ? (!acceptedTuple && !confirmedSource)
            : (!activeTuple && !pendingTuple && !alreadyAccepted && !confirmedSource))
          || (block && (block.generation == null || block.generation === generation))
          || grant.topDocumentEpoch !== top?.documentEpoch || frame?.documentEpoch !== frameCursor?.documentEpoch
          || frame?.routeRevision !== frameCursor?.routeRevision || frame?.url !== frameCursor?.url
          || (frameId === 0 && (documentToken !== grant.topDocumentToken || frame.documentEpoch !== grant.topDocumentEpoch))) return false;
      grant.provisionalDocuments ||= {};
      grant.provisionalAttemptIds ||= {};
      grant.provisionalAttemptRevisions ||= {};
      grant.provisionalDocuments[frameId] = documentToken;
      grant.provisionalAttemptIds[frameId] = attemptId;
      grant.provisionalAttemptRevisions[frameId] = String(attemptRevision);
      this.dirty = true;
      return true;
    });
  }

  hasAcceptedManualAttempt(tabId, generation, attemptId, attemptRevision) {
    const grants = [
      this.state?.manualContinuity?.[tabId],
      this.durableState?.manualContinuity?.[tabId],
    ];
    return grants.every(grant => grant && !grant.revoked && grant.generation === generation
      && Object.entries(grant.acceptedAttemptIds || {}).some(([frameId, acceptedId]) => (
        acceptedId === attemptId
          && grant.acceptedAttemptRevisions?.[frameId] === String(attemptRevision)
          && typeof grant.acceptedDocuments?.[frameId] === 'string'
      )));
  }

  hasConfirmedManualAttempt(tabId, generation, attemptId, attemptRevision) {
    const grants = [
      this.state?.manualContinuity?.[tabId],
      this.durableState?.manualContinuity?.[tabId],
    ];
    return grants.every(grant => grant && !grant.revoked && grant.armed && grant.generation === generation
      && Object.keys(grant.acceptedAttemptIds || {}).length === 0
      && grant.confirmedAttemptId === attemptId
      && grant.confirmedAttemptRevision === String(attemptRevision));
  }

  async promoteManualFrameAcceptance(
    tabId, generation, attemptId, attemptRevision, frameId, documentToken, frameCursor,
    topDocumentToken, boundTopCursor
  ) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const frame = state.frames[`${tabId}:${frameId}`];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      const matches = grant && frame && frameCursor && !grant.revoked && grant.generation === generation
        && !(block && (block.generation == null || block.generation === generation))
        && this.manualContinuityRevision.get(tabId) === attemptRevision
        && grant.provisionalAttemptIds?.[frameId] === attemptId
        && grant.provisionalAttemptRevisions?.[frameId] === String(attemptRevision)
        && grant.provisionalDocuments?.[frameId] === documentToken
        && grant.topDocumentEpoch === top?.documentEpoch
        && (frameId !== 0 || (documentToken === grant.topDocumentToken
          && topDocumentToken === grant.topDocumentToken && boundTopCursor
          && top?.routeRevision === boundTopCursor.routeRevision && top?.url === boundTopCursor.url))
        && frame?.documentEpoch === frameCursor?.documentEpoch
        && frame?.routeRevision === frameCursor?.routeRevision && frame?.url === frameCursor?.url;
      if (!matches) return false;
      grant.frames[frameId] = frame.documentEpoch;
      grant.documents ||= {};
      grant.documents[frameId] = documentToken;
      grant.startedDocuments ||= {};
      grant.startedDocuments[frameId] = documentToken;
      grant.acceptedDocuments ||= {};
      grant.acceptedAttemptIds ||= {};
      grant.acceptedAttemptRevisions ||= {};
      grant.acceptedDocuments[frameId] = documentToken;
      grant.acceptedAttemptIds[frameId] = attemptId;
      grant.acceptedAttemptRevisions[frameId] = String(attemptRevision);
      updateConfirmedManualAttempt(grant, attemptId, attemptRevision);
      grant.armed = true;
      for (const key of ['provisionalDocuments', 'provisionalAttemptIds', 'provisionalAttemptRevisions']) {
        delete grant[key][frameId];
      }
      this.dirty = true;
      return true;
    }, { rollbackManualTabId: tabId });
  }

  async clearProvisionalManualFrameAcceptance(tabId, generation, attemptId, attemptRevision, frameId, documentToken) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      if (!grant || grant.generation !== generation
          || grant.provisionalAttemptIds?.[frameId] !== attemptId
          || grant.provisionalAttemptRevisions?.[frameId] !== String(attemptRevision)
          || (documentToken != null && grant.provisionalDocuments?.[frameId] !== documentToken)) return false;
      delete grant.provisionalDocuments[frameId];
      delete grant.provisionalAttemptIds[frameId];
      delete grant.provisionalAttemptRevisions[frameId];
      for (const key of ['provisionalDocuments', 'provisionalAttemptIds', 'provisionalAttemptRevisions']) {
        if (Object.keys(grant[key]).length === 0) delete grant[key];
      }
      this.dirty = true;
      return true;
    });
  }

  isManualFrameAttemptCurrent(tabId, generation, frameId, attemptId, attemptRevision, documentToken, { includeRevoked = false } = {}) {
    const current = this.state?.manualContinuity?.[tabId];
    const durable = this.durableState?.manualContinuity?.[tabId];
    const currentRevoked = includeRevoked && current?.revoked;
    const tupleMatches = grant => {
      if (!grant) return false;
      const acceptedIds = grant.revoked ? grant.revokedAcceptedAttemptIds : grant.acceptedAttemptIds;
      const acceptedRevisions = grant.revoked ? grant.revokedAcceptedAttemptRevisions : grant.acceptedAttemptRevisions;
      const acceptedDocuments = grant.revoked ? grant.revokedAcceptedDocuments : grant.acceptedDocuments;
      const provisionalIds = grant.revoked ? grant.revokedProvisionalAttemptIds : grant.provisionalAttemptIds;
      const provisionalRevisions = grant.revoked ? grant.revokedProvisionalAttemptRevisions : grant.provisionalAttemptRevisions;
      const provisionalDocuments = grant.revoked ? grant.revokedProvisionalDocuments : grant.provisionalDocuments;
      const accepted = acceptedIds?.[frameId] === attemptId
        && acceptedRevisions?.[frameId] === String(attemptRevision)
        && acceptedDocuments?.[frameId] === documentToken;
      const provisional = provisionalIds?.[frameId] === attemptId
        && provisionalRevisions?.[frameId] === String(attemptRevision)
        && provisionalDocuments?.[frameId] === documentToken;
      return accepted || provisional;
    };
    const effectiveGeneration = grant => grant?.revoked ? grant.revokedGeneration : grant?.generation;
    return Boolean(current && durable
      && effectiveGeneration(current) === generation && effectiveGeneration(durable) === generation
      && (currentRevoked || (!current.revoked && !durable.revoked))
      && tupleMatches(current) && tupleMatches(durable));
  }

  isManualFrameStartCurrent(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken, attemptId, attemptRevision) {
    const currentGrant = this.state?.manualContinuity?.[tabId];
    const durableGrant = this.durableState?.manualContinuity?.[tabId];
    const currentFrame = this.state?.frames?.[`${tabId}:${frameId}`];
    const durableFrame = this.durableState?.frames?.[`${tabId}:${frameId}`];
    const top = this.state?.frames?.[`${tabId}:0`];
    const block = this.blockedManualContinuity.get(tabId);
    const hasTuple = grant => Object.entries(grant?.acceptedAttemptIds || {}).some(([acceptedFrameId, acceptedId]) => (
      acceptedId === attemptId && grant.acceptedAttemptRevisions?.[acceptedFrameId] === String(attemptRevision)
    ));
    const attemptAccepted = Number.isSafeInteger(attemptRevision)
      && (hasTuple(currentGrant) && hasTuple(durableGrant)
        || this.hasConfirmedManualAttempt(tabId, generation, attemptId, attemptRevision));
    return Boolean(currentGrant && durableGrant && !currentGrant.revoked && !durableGrant.revoked
      && currentGrant.armed && durableGrant.armed
      && currentGrant.generation === generation && durableGrant.generation === generation
      && attemptAccepted
      && currentGrant.topDocumentEpoch === topDocumentEpoch && durableGrant.topDocumentEpoch === topDocumentEpoch
      && currentGrant.topDocumentToken === topDocumentToken && durableGrant.topDocumentToken === topDocumentToken
      && top?.documentEpoch === topDocumentEpoch
      && currentGrant.frames?.[frameId] === frameCursor?.documentEpoch
      && durableGrant.frames?.[frameId] === frameCursor?.documentEpoch
      && currentGrant.documents?.[frameId] === documentToken
      && durableGrant.documents?.[frameId] === documentToken
      && currentGrant.startedDocuments?.[frameId] !== documentToken
      && durableGrant.startedDocuments?.[frameId] !== documentToken
      && currentFrame?.documentEpoch === frameCursor?.documentEpoch
      && durableFrame?.documentEpoch === frameCursor?.documentEpoch
      && currentFrame?.routeRevision === frameCursor?.routeRevision
      && durableFrame?.routeRevision === frameCursor?.routeRevision
      && currentFrame?.url === frameCursor?.url && durableFrame?.url === frameCursor?.url
      && this.manualFrameStartClaims.has(`${tabId}:${frameId}:${generation}:${documentToken}`)
      && !(block && (block.generation == null || block.generation === generation)));
  }

  blockManualContinuity(tabId, expectedGeneration = null, expectedRevision = null) {
    if (expectedRevision != null && (this.manualContinuityRevision.get(tabId) ?? 0) !== expectedRevision) {
      return false;
    }
    const previous = this.blockedManualContinuity.get(tabId);
    const revision = this.manualContinuityRevision.get(tabId) ?? 0;
    const knownGrant = this.state?.manualContinuity?.[tabId] ?? this.durableState?.manualContinuity?.[tabId];
    const cutoffGeneration = expectedGeneration
      ?? knownGrant?.generation
      ?? 0;
    if (expectedGeneration == null) {
      this.blockedManualContinuity.set(tabId, { generation: null, cutoffGeneration });
    } else if (!previous || (previous.generation != null && previous.generation <= expectedGeneration)) {
      this.blockedManualContinuity.set(tabId, { generation: expectedGeneration, cutoffGeneration });
    }
    let operationRevision;
    if (expectedGeneration != null) {
      this.manualContinuityRevision.set(tabId, revision);
      operationRevision = revision;
    } else {
      operationRevision = revision + 1;
      this.manualContinuityRevision.set(tabId, operationRevision);
    }
    const intent = {
      tabId,
      expectedGeneration,
      cutoffGeneration,
      cutoffRevision: expectedRevision ?? Math.max(
        revision, this.manualContinuityHighWater.get(tabId) ?? 0,
        getManualAttemptRevisionHighWater(knownGrant),
      ),
      cutoffCaptured: expectedGeneration != null || Boolean(this.state || this.durableState),
      operationRevision,
      committedGeneration: null,
      revokeGeneration: undefined,
    };
    this.manualRevocationIntents.set(tabId, intent);
    return intent;
  }

  getManualContinuityCutoff(tabId) {
    const block = this.blockedManualContinuity.get(tabId);
    return block?.cutoffGeneration ?? this.durableState?.manualContinuity?.[tabId]?.generation ?? 0;
  }

  async revokeManualContinuity(tabId, expectedGeneration, intent = null) {
    expectedGeneration ??= null;
    if (!intent || typeof intent !== 'object' || this.manualRevocationIntents.get(tabId) !== intent
        || intent.tabId !== tabId
        || (intent.expectedGeneration != null && intent.expectedGeneration !== expectedGeneration)) return null;
    if (intent.revokeGeneration === undefined) {
      if (expectedGeneration != null && expectedGeneration > intent.cutoffGeneration) return null;
      intent.revokeGeneration = expectedGeneration;
    } else if (intent.revokeGeneration !== expectedGeneration) {
      return null;
    }
    const revokeGeneration = intent.revokeGeneration;
    const result = await this._run(state => {
      if (this.manualRevocationIntents.get(tabId) !== intent) return null;
      const previous = state.manualContinuity[tabId];
      if (intent.expectedGeneration == null && !intent.cutoffCaptured) {
        intent.cutoffGeneration = Math.max(intent.cutoffGeneration, previous?.generation ?? 0);
        intent.cutoffRevision = Math.max(
          intent.cutoffRevision,
          getManualAttemptRevisionHighWater(previous),
        );
        intent.cutoffCaptured = true;
      }
      if (intent.committedGeneration != null && previous?.revoked === true
          && previous.generation === intent.committedGeneration) return intent.committedGeneration;
      if (revokeGeneration != null && previous?.revoked === true
          && previous.revokedGeneration === revokeGeneration) return previous.generation;
      if (revokeGeneration != null && previous?.generation !== revokeGeneration) return null;
      if (previous?.revoked === true) {
        const coversCutoff = previous.generation <= intent.cutoffGeneration
          || (Number.isSafeInteger(previous.revokedGeneration)
            && previous.revokedGeneration <= intent.cutoffGeneration);
        if (!coversCutoff) return null;
        intent.committedGeneration = previous.generation;
        return previous.generation;
      }
      if (previous && !previous.revoked
          && (previous.generation > intent.cutoffGeneration
            || (intent.expectedGeneration == null
              && Number.isSafeInteger(previous.attemptRevision)
              && previous.attemptRevision > intent.cutoffRevision))) return null;
      const generation = Math.max(previous?.generation || 0, revokeGeneration || 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('Manual continuity generation exhausted');
      state.manualContinuity[tabId] = {
        generation,
        revoked: true,
        ...(previous && !previous.revoked && {
          revokedGeneration: previous.generation,
          revokedAttemptRevision: previous.attemptRevision,
          revokedAttemptId: previous.attemptId,
          revokedTopDocumentEpoch: previous.topDocumentEpoch,
          revokedTopDocumentToken: previous.topDocumentToken,
          revokedFrames: structuredClone(previous.frames || {}),
           revokedAcceptedDocuments: structuredClone(previous.acceptedDocuments || {}),
           revokedAcceptedAttemptIds: structuredClone(previous.acceptedAttemptIds || {}),
           revokedAcceptedAttemptRevisions: structuredClone(previous.acceptedAttemptRevisions || {}),
           revokedProvisionalDocuments: structuredClone(previous.provisionalDocuments || {}),
           revokedProvisionalAttemptIds: structuredClone(previous.provisionalAttemptIds || {}),
           revokedProvisionalAttemptRevisions: structuredClone(previous.provisionalAttemptRevisions || {}),
        }),
      };
      intent.committedGeneration = generation;
      this.dirty = true;
      return generation;
    }).then(async generation => {
      const saved = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
      const grant = saved?.manualContinuity?.[tabId];
      if (generation == null) {
        return null;
      }
      if (grant?.generation !== generation || grant.revoked !== true) {
        if (!grant?.revoked && Number.isSafeInteger(grant?.attemptRevision)
            && grant.attemptRevision > intent.cutoffRevision) return null;
        throw new Error('Manual continuity revocation not durable');
      }
      return generation;
    });
    return result;
  }

  async validateManualContinuity(tabId, frameId, generation, topDocumentEpoch, frameCursor, attemptId = null) {
    const grant = await this.getManualContinuity(tabId);
    if (!grant || grant.generation !== generation || grant.topDocumentEpoch !== topDocumentEpoch
        || (attemptId != null && grant.attemptId !== attemptId)
        || grant.frames?.[frameId] !== frameCursor?.documentEpoch) return false;
    const top = await this.getAdmissionCursor(tabId, 0);
    const frame = await this.getAdmissionCursor(tabId, frameId);
    const currentGrant = await this.getManualContinuity(tabId);
    return Boolean(currentGrant?.generation === generation && currentGrant.topDocumentEpoch === topDocumentEpoch
      && (attemptId == null || currentGrant.attemptId === attemptId)
      && top?.documentEpoch === topDocumentEpoch
      && frame?.documentEpoch === frameCursor?.documentEpoch
      && frame?.routeRevision === frameCursor?.routeRevision && frame?.url === frameCursor?.url);
  }

  async validateManualContinuityBatch(
    tabId, frameId, generation, topDocumentEpoch, frameCursor, attemptRevision = null, attemptId = null, documentToken = null
  ) {
    if (!this.state || !this.durableState) await this._run(() => null);
    const grant = this.durableState?.manualContinuity?.[tabId];
    const currentGrant = this.state?.manualContinuity?.[tabId];
    const block = this.blockedManualContinuity.get(tabId);
    const top = this.state?.frames?.[`${tabId}:0`];
    const currentFrame = this.state?.frames?.[`${tabId}:${frameId}`];
    const durableFrame = this.durableState?.frames?.[`${tabId}:${frameId}`];
    return Boolean(grant && !grant.revoked && currentGrant?.generation === generation
      && grant.generation === generation && grant.topDocumentEpoch === topDocumentEpoch
      && (attemptId == null || ([
        ['acceptedAttemptIds', 'acceptedAttemptRevisions', 'acceptedDocuments'],
        ['provisionalAttemptIds', 'provisionalAttemptRevisions', 'provisionalDocuments'],
      ].some(([ids, revisions, documents]) => currentGrant[ids]?.[frameId] === attemptId
        && grant[ids]?.[frameId] === attemptId
        && currentGrant[revisions]?.[frameId] === String(attemptRevision)
        && grant[revisions]?.[frameId] === String(attemptRevision)
        && (documentToken == null || grant[documents]?.[frameId] === documentToken)
        && typeof grant[documents]?.[frameId] === 'string'
        && currentGrant[documents]?.[frameId] === grant[documents]?.[frameId])))
      && top?.documentEpoch === topDocumentEpoch && currentFrame && durableFrame
      && currentFrame.documentEpoch === frameCursor?.documentEpoch
      && durableFrame.documentEpoch === frameCursor?.documentEpoch
      && currentFrame.routeRevision === frameCursor?.routeRevision
      && durableFrame.routeRevision === frameCursor?.routeRevision
      && currentFrame.url === frameCursor?.url && durableFrame.url === frameCursor?.url
      && grant.frames?.[frameId] === frameCursor?.documentEpoch
      && !(block && (block.generation == null || block.generation === generation)));
  }

  _newDocument(state, url) {
    if (state.nextDocumentEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Page navigation epoch exhausted');
    this.dirty = true;
    return { documentEpoch: ++state.nextDocumentEpoch, routeRevision: 0, url };
  }

  _capture(cursor, url) {
    if (typeof url !== 'string' || !url) throw new Error('Missing Page frame URL');
    if (cursor.url !== url) {
      if (cursor.routeRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Page navigation revision exhausted');
      this.dirty = true;
      cursor.routeRevision++;
      cursor.url = url;
    }
    return cursor;
  }

  _retireManualFrame(state, tabId, frameId) {
    const grant = state.manualContinuity[tabId];
    if (!grant) return;
    for (const key of [
      'frames', 'documents', 'startedDocuments',
      'acceptedDocuments', 'acceptedAttemptIds', 'acceptedAttemptRevisions',
      'provisionalDocuments', 'provisionalAttemptIds', 'provisionalAttemptRevisions',
      'revokedFrames', 'revokedAcceptedDocuments', 'revokedAcceptedAttemptIds',
      'revokedAcceptedAttemptRevisions', 'revokedProvisionalDocuments',
      'revokedProvisionalAttemptIds', 'revokedProvisionalAttemptRevisions',
    ]) {
      if (Object.hasOwn(grant[key] || {}, frameId)) {
        delete grant[key][frameId];
        this.dirty = true;
      }
    }
  }

  seed(tabId, frames) {
    return this._run(state => {
      if (!Array.isArray(frames)) throw new Error('Invalid Page frame');
      for (const frame of frames) {
        if (!Number.isInteger(frame?.frameId) || frame.frameId < 0 || typeof frame.url !== 'string' || !frame.url) {
          throw new Error('Invalid Page frame');
        }
      }
      const live = new Set(frames.map(frame => `${tabId}:${frame.frameId}`));
      for (const key of Object.keys(state.frames)) {
        if (key.startsWith(`${tabId}:`) && !live.has(key)) {
          this.dirty = true;
          delete state.frames[key];
          const frameId = key.slice(`${tabId}:`.length);
          this._retireManualFrame(state, tabId, frameId);
        }
      }
      for (const frame of frames) {
        const key = `${tabId}:${frame.frameId}`;
        // Frame discovery can return a snapshot older than an already captured route.
        if (!state.frames[key]) state.frames[key] = this._newDocument(state, frame.url);
      }
    });
  }

  capture(tabId, frameId, url) {
    return this._run(state => {
      const cursor = state.frames[`${tabId}:${frameId}`];
      return cursor ? this._capture(cursor, url) : null;
    });
  }

  captureTopNavigation(tabId, url, { shouldCreate = async () => true } = {}) {
    return this._run(async state => {
      const key = `${tabId}:0`;
      if (!state.frames[key] && await shouldCreate()) state.frames[key] = this._newDocument(state, url);
      if (!state.frames[key]) return null;
      return this._capture(state.frames[key], url);
    });
  }

  getCursor(tabId, frameId) {
    return this._run(state => state.frames[`${tabId}:${frameId}`] || null);
  }

  async getAdmissionCursor(tabId, frameId) {
    const baseline = await this.getCursor(tabId, frameId);
    if (!baseline) return null;
    const frame = await browser.webNavigation.getFrame({ tabId, frameId });
    if (typeof frame?.url !== 'string' || !frame.url) throw new Error('Page frame unavailable');
    return this._run(state => {
      const current = state.frames[`${tabId}:${frameId}`];
      if (!current) return null;
      // Native captures win over a frame snapshot whose read spans a route or document change.
      if (current.documentEpoch !== baseline.documentEpoch || current.routeRevision !== baseline.routeRevision) return current;
      return this._capture(current, frame.url);
    });
  }

  committed(tabId, frameId, url) {
    return this._run(state => {
      const key = `${tabId}:${frameId}`;
      const tracked = Boolean(state.frames[key]);
      if (frameId === 0) {
        const manual = state.manualContinuity[tabId];
        if (manual && !manual.revoked) {
          state.manualContinuity[tabId] = { generation: manual.generation + 1, revoked: true };
          this.dirty = true;
        }
        for (const child of Object.keys(state.frames)) {
          if (child.startsWith(`${tabId}:`) && child !== key) {
            this.dirty = true;
            delete state.frames[child];
          }
        }
      }
      if (tracked) {
        if (typeof url !== 'string' || !url) throw new Error('Missing committed Page URL');
        state.frames[key] = this._newDocument(state, url);
        if (frameId > 0) this._retireManualFrame(state, tabId, frameId);
      } else if (frameId > 0 && typeof url === 'string' && url) {
        const grant = state.manualContinuity[tabId];
        if (grant && !grant.revoked && grant.armed) {
          state.frames[key] = this._newDocument(state, url);
        }
      }
    });
  }

  removeTab(tabId) {
    return this._run(state => {
      this.restartFences.delete(tabId);
      this.manualRevocationIntents.delete(tabId);
      for (const key of this.manualStartSnapshots.keys()) {
        if (key.startsWith(`${tabId}:`)) this.manualStartSnapshots.delete(key);
      }
      if (Object.hasOwn(state.manualContinuity, tabId)) {
        delete state.manualContinuity[tabId];
        this.dirty = true;
      }
      this.blockedManualContinuity.delete(tabId);
      this.manualContinuityRevision.delete(tabId);
      this.manualContinuityHighWater.delete(tabId);
      this.manualStartOperations.delete(tabId);
      for (const claim of this.manualFrameStartClaims) {
        if (claim.startsWith(`${tabId}:`)) this.manualFrameStartClaims.delete(claim);
      }
      let removedFrame = false;
      for (const key of Object.keys(state.frames)) {
        if (key.startsWith(`${tabId}:`)) {
          this.dirty = true;
          removedFrame = true;
          delete state.frames[key];
        }
      }
      return removedFrame;
    });
  }
}

export const pageNavigationTracker = new PageNavigationTracker();

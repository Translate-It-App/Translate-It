import browser from 'webextension-polyfill';

const STORAGE_KEY = 'pageTranslationNavigation';
const validCursor = value => Number.isSafeInteger(value?.documentEpoch) && value.documentEpoch > 0
  && Number.isSafeInteger(value.routeRevision) && value.routeRevision >= 0
  && typeof value.url === 'string' && value.url.length > 0;
const validTokenMap = value => value === undefined || (value && typeof value === 'object'
  && !Array.isArray(value) && Object.entries(value).every(([frameId, token]) => (
    /^\d+$/.test(frameId) && typeof token === 'string' && token.length > 0
  )));
const validManualGrant = grant => {
  if (!Number.isSafeInteger(grant?.generation) || grant.generation < 0 || typeof grant.revoked !== 'boolean') return false;
  if (grant.revoked) return true;
  return Number.isSafeInteger(grant.topDocumentEpoch) && grant.topDocumentEpoch > 0
    && (grant.topDocumentToken === undefined || (typeof grant.topDocumentToken === 'string' && grant.topDocumentToken.length > 0))
    && grant.frames && typeof grant.frames === 'object' && !Array.isArray(grant.frames)
    && Object.entries(grant.frames).every(([frameId, epoch]) => (
      /^\d+$/.test(frameId) && Number.isSafeInteger(epoch) && epoch > 0
    ))
    && validTokenMap(grant.documents) && validTokenMap(grant.startedDocuments);
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
    this.manualContinuityRevision = new Map();
    this.manualFrameStartClaims = new Set();
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

  _run(update) {
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
          if (!grant.revoked && !grant.topDocumentToken) {
            this.state.manualContinuity[tabId] = { generation: grant.generation + 1, revoked: true };
            this.dirty = true;
          }
        }
        this.durableState = structuredClone(this.state);
      }
      const result = await update(this.state);
      if (this.dirty) {
        await this.storage.set({ [STORAGE_KEY]: this.state });
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

  reserveManualContinuityStart(tabId) {
    const revision = (this.manualContinuityRevision.get(tabId) || 0) + 1;
    this.manualContinuityRevision.set(tabId, revision);
    return revision;
  }

  async grantManualContinuity(tabId, operationRevision = this.reserveManualContinuityStart(tabId), options = {}) {
    if (typeof options.topDocumentToken !== 'string' || !options.topDocumentToken) {
      throw new Error('Top document identity is unavailable');
    }
    return this._run(async state => {
      if (this.manualContinuityRevision.get(tabId) !== operationRevision) throw new Error('Manual continuity start superseded');
      const top = state.frames[`${tabId}:0`];
      if (!top) throw new Error('Top document is not admitted');
      const previous = state.manualContinuity[tabId];
      const block = this.blockedManualContinuity.get(tabId);
      if (previous && !previous.revoked && previous.topDocumentEpoch === top.documentEpoch
          && previous.topDocumentToken === options.topDocumentToken
          && !(block && (block.generation == null || block.generation === previous.generation))) {
        return { grant: previous, reused: true };
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
        ...(typeof options.provider === 'string' && { provider: options.provider }),
        ...(typeof options.targetLanguage === 'string' && { targetLanguage: options.targetLanguage }),
        ...(typeof options.isExplicitProvider === 'boolean' && { isExplicitProvider: options.isExplicitProvider }),
      };
      state.manualContinuity[tabId] = grant;
      this.dirty = true;
      return { grant, reused: false };
    }).then(async ({ grant, reused }) => {
      const durable = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY]?.manualContinuity?.[tabId];
      if (this.manualContinuityRevision.get(tabId) !== operationRevision
          || !durable || durable.revoked || durable.generation !== grant.generation) throw new Error('Manual continuity grant not durable');
      this.blockedManualContinuity.delete(tabId);
      Object.defineProperty(durable, 'reused', { value: reused });
      return durable;
    });
  }

  async armManualContinuity(tabId, generation) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      if (!grant || grant.revoked || grant.generation !== generation
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

  async claimManualFrameStart(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken) {
    return this._run(state => {
      const grant = state.manualContinuity[tabId];
      const frame = state.frames[`${tabId}:${frameId}`];
      const top = state.frames[`${tabId}:0`];
      const block = this.blockedManualContinuity.get(tabId);
      if (!grant || grant.revoked || !grant.armed || grant.generation !== generation
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

  async completeManualFrameStart(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken, accepted) {
    const claimKey = `${tabId}:${frameId}:${generation}:${documentToken}`;
    try {
      return await this._run(state => {
        const grant = state.manualContinuity[tabId];
        const frame = state.frames[`${tabId}:${frameId}`];
        const top = state.frames[`${tabId}:0`];
        const block = this.blockedManualContinuity.get(tabId);
        const current = grant && !grant.revoked && grant.armed && grant.generation === generation
          && grant.topDocumentEpoch === topDocumentEpoch && grant.topDocumentToken === topDocumentToken
          && top?.documentEpoch === topDocumentEpoch && grant.frames?.[frameId] === frameCursor?.documentEpoch
          && grant.documents?.[frameId] === documentToken
          && frame?.documentEpoch === frameCursor?.documentEpoch
          && frame?.routeRevision === frameCursor?.routeRevision && frame?.url === frameCursor?.url
          && this.manualFrameStartClaims.has(claimKey)
          && !(block && (block.generation == null || block.generation === generation));
        if (!accepted || !current) return false;
        grant.startedDocuments ||= {};
        if (grant.startedDocuments[frameId] !== documentToken) {
          grant.startedDocuments[frameId] = documentToken;
          this.dirty = true;
        }
        return true;
      });
    } finally {
      this.manualFrameStartClaims.delete(claimKey);
    }
  }

  isManualFrameStartCurrent(tabId, frameId, generation, topDocumentEpoch, topDocumentToken, frameCursor, documentToken) {
    const currentGrant = this.state?.manualContinuity?.[tabId];
    const durableGrant = this.durableState?.manualContinuity?.[tabId];
    const currentFrame = this.state?.frames?.[`${tabId}:${frameId}`];
    const durableFrame = this.durableState?.frames?.[`${tabId}:${frameId}`];
    const top = this.state?.frames?.[`${tabId}:0`];
    const block = this.blockedManualContinuity.get(tabId);
    return Boolean(currentGrant && durableGrant && !currentGrant.revoked && !durableGrant.revoked
      && currentGrant.armed && durableGrant.armed
      && currentGrant.generation === generation && durableGrant.generation === generation
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

  blockManualContinuity(tabId, expectedGeneration = null) {
    const previous = this.blockedManualContinuity.get(tabId);
    const revision = this.manualContinuityRevision.get(tabId) ?? 0;
    const cutoffGeneration = expectedGeneration
      ?? this.durableState?.manualContinuity?.[tabId]?.generation
      ?? 0;
    if (expectedGeneration == null) {
      this.blockedManualContinuity.set(tabId, { generation: null, cutoffGeneration });
    } else if (!previous || (previous.generation != null && previous.generation <= expectedGeneration)) {
      this.blockedManualContinuity.set(tabId, { generation: expectedGeneration, cutoffGeneration });
    }
    if (expectedGeneration != null) {
      this.manualContinuityRevision.set(tabId, revision);
      return revision;
    }
    const nextRevision = revision + 1;
    this.manualContinuityRevision.set(tabId, nextRevision);
    return nextRevision;
  }

  getManualContinuityCutoff(tabId) {
    const block = this.blockedManualContinuity.get(tabId);
    return block?.cutoffGeneration ?? this.durableState?.manualContinuity?.[tabId]?.generation ?? 0;
  }

  async revokeManualContinuity(tabId, expectedGeneration, expectedRevision = this.manualContinuityRevision.get(tabId) ?? 0) {
    const isCurrentRevision = () => (this.manualContinuityRevision.get(tabId) ?? 0) === expectedRevision;
    return this._run(state => {
      if (!isCurrentRevision()) return null;
      const previous = state.manualContinuity[tabId];
      if (expectedGeneration != null && previous?.generation !== expectedGeneration) return null;
      const generation = Math.max(previous?.generation || 0, expectedGeneration || 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('Manual continuity generation exhausted');
      state.manualContinuity[tabId] = { generation, revoked: true };
      this.dirty = true;
      return generation;
    }).then(async generation => {
      if (generation == null || !isCurrentRevision()) return null;
      const saved = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
      const grant = saved?.manualContinuity?.[tabId];
      if (!isCurrentRevision()) return null;
      if (grant?.generation !== generation || grant.revoked !== true) {
        throw new Error('Manual continuity revocation not durable');
      }
      return generation;
    });
  }

  async validateManualContinuity(tabId, frameId, generation, topDocumentEpoch, frameCursor) {
    const grant = await this.getManualContinuity(tabId);
    if (!grant || grant.generation !== generation || grant.topDocumentEpoch !== topDocumentEpoch
        || grant.frames?.[frameId] !== frameCursor?.documentEpoch) return false;
    const top = await this.getAdmissionCursor(tabId, 0);
    const frame = await this.getAdmissionCursor(tabId, frameId);
    const currentGrant = await this.getManualContinuity(tabId);
    return Boolean(currentGrant?.generation === generation && currentGrant.topDocumentEpoch === topDocumentEpoch
      && top?.documentEpoch === topDocumentEpoch
      && frame?.documentEpoch === frameCursor?.documentEpoch
      && frame?.routeRevision === frameCursor?.routeRevision && frame?.url === frameCursor?.url);
  }

  async validateManualContinuityBatch(tabId, frameId, generation, topDocumentEpoch, frameCursor) {
    if (!this.state || !this.durableState) await this._run(() => null);
    const grant = this.durableState?.manualContinuity?.[tabId];
    const currentGrant = this.state?.manualContinuity?.[tabId];
    const block = this.blockedManualContinuity.get(tabId);
    const top = this.state?.frames?.[`${tabId}:0`];
    const currentFrame = this.state?.frames?.[`${tabId}:${frameId}`];
    const durableFrame = this.durableState?.frames?.[`${tabId}:${frameId}`];
    return Boolean(grant && !grant.revoked && currentGrant?.generation === generation
      && grant.generation === generation && grant.topDocumentEpoch === topDocumentEpoch
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
          const grant = state.manualContinuity[tabId];
          if (grant && !grant.revoked) {
            delete grant.frames[frameId];
            delete grant.documents?.[frameId];
            delete grant.startedDocuments?.[frameId];
          }
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
        if (frameId > 0) {
          const grant = state.manualContinuity[tabId];
          if (grant && !grant.revoked) {
            delete grant.frames[frameId];
            delete grant.documents?.[frameId];
            delete grant.startedDocuments?.[frameId];
            this.dirty = true;
          }
        }
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
      if (Object.hasOwn(state.manualContinuity, tabId)) {
        delete state.manualContinuity[tabId];
        this.dirty = true;
      }
      this.blockedManualContinuity.delete(tabId);
      this.manualContinuityRevision.delete(tabId);
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

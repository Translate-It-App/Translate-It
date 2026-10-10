import browser from 'webextension-polyfill';

const STORAGE_KEY = 'pageTranslationNavigation';
const validCursor = value => Number.isSafeInteger(value?.documentEpoch) && value.documentEpoch > 0
  && Number.isSafeInteger(value.routeRevision) && value.routeRevision >= 0
  && typeof value.url === 'string' && value.url.length > 0;

export class PageNavigationTracker {
  constructor(storage = browser.storage?.session) {
    this.storage = storage;
    this.state = null;
    this.dirty = false;
    this.pending = Promise.resolve();
  }

  _run(update) {
    const operation = this.pending.then(async () => {
      if (!this.state) {
        const saved = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
        if (saved && (!Number.isSafeInteger(saved.nextDocumentEpoch) || saved.nextDocumentEpoch < 0
            || !saved.frames || typeof saved.frames !== 'object' || Array.isArray(saved.frames)
            || Object.entries(saved.frames).some(([key, cursor]) => (
              !/^\d+:\d+$/.test(key) || !validCursor(cursor) || cursor.documentEpoch > saved.nextDocumentEpoch
            )))) throw new Error('Invalid Page navigation storage');
        this.state = saved || { nextDocumentEpoch: 0, frames: {} };
      }
      const result = update(this.state);
      if (this.dirty) {
        await this.storage.set({ [STORAGE_KEY]: this.state });
        this.dirty = false;
      }
      return result && { ...result };
    });
    this.pending = operation.catch(() => {});
    return operation;
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
      }
    });
  }

  removeTab(tabId) {
    return this._run(state => {
      for (const key of Object.keys(state.frames)) {
        if (key.startsWith(`${tabId}:`)) {
          this.dirty = true;
          delete state.frames[key];
        }
      }
    });
  }
}

export const pageNavigationTracker = new PageNavigationTracker();

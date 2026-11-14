/**
 * MainFrameCoordinator.js
 * Handles cross-frame communication and synchronization between the main frame and iframes.
 */
import { pageEventBus } from '@/core/PageEventBus.js';
import browser from 'webextension-polyfill';
import { reconstructTranslationError, isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.IFRAME, 'MainFrameCoordinator');
const MOUSE_HOVER_TRANSLATION_ERROR = 'MOUSE_HOVER_TRANSLATION_ERROR';
const HOVER_EVENT_TYPES = new Set(['MOUSE_HOVER_TRANSLATION_READY', MOUSE_HOVER_TRANSLATION_ERROR, 'MOUSE_HOVER_HIDE_TOOLTIP']);
const HOVER_FEEDBACK_EVENTS = new Map([
  ['MOUSE_HOVER_TOOLTIP_POINTER_ENTER', 'enter'],
  ['MOUSE_HOVER_TOOLTIP_POINTER_LEAVE', 'leave'],
  ['MOUSE_HOVER_TOOLTIP_HIDDEN', 'hidden'],
]);

function normalizeHoverErrorData(type, data) {
  if (type !== MOUSE_HOVER_TRANSLATION_ERROR || !isStructuredTranslationError(data?.errorDetails)) {
    return data;
  }

  return {
    ...data,
    error: reconstructTranslationError(data.errorDetails)
  };
}

export class MainFrameCoordinator {
  constructor(aggregator, MessageActions, contentScriptCore) {
    this.aggregator = aggregator;
    this.MessageActions = MessageActions;
    this.contentScriptCore = contentScriptCore;
    this.frameSessionOwners = new Map();
    this.hoverPositionHints = new Map();
    this.pendingHoverReady = new Map();
    this.hoverTombstones = new Map();
    this.hoverOwner = null;

    if (this.contentScriptCore) {
      this.contentScriptCore.mainFrameCoordinator = this;
    }
    
    this.initialize();
  }

  /**
   * Initializes trusted runtime and unrelated iframe interaction listeners.
   */
  initialize() {
    this.setupMessageListener();
  }

  _recordFrameStart(frameId, data = {}) {
    this.aggregator.updateFrameData(frameId, {
      ...data,
      isTranslating: true,
      isTranslated: false,
      isAutoTranslating: data.isAutoTranslating === true,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      failed: 0,
      errorDetails: null,
      terminalErrorDetails: null,
      terminalCauseSequence: 0,
      status: 'translating'
    });
  }

  /**
   * Retires state for a frame whose browser document was replaced.
   * @param {number} frameId - Trusted browser subframe ID
   * @returns {{success: boolean, retired?: boolean, error?: string}}
   */
  retireFrame(frameId) {
    if (!Number.isInteger(frameId) || frameId <= 0) {
      return { success: false, error: 'Invalid frame identity' };
    }

    this.frameSessionOwners.delete(frameId);
    this.aggregator.removeFrame(frameId);
    return { success: true, retired: true };
  }

  /**
   * Sets up the global 'message' listener for unrelated iframe interactions.
   */
  setupMessageListener() {
    window.addEventListener('message', (event) => {
      const type = event.data?.type;

      if (event.data?.source === 'translate-it-iframe' && type === 'MOUSE_HOVER_POSITION_HINT') {
        this._rememberHoverPositionHint(event);
        return;
      }

      // Hover authority comes from the background runtime relay, never a page-visible message.
      if (HOVER_EVENT_TYPES.has(type) || type === 'MOUSE_HOVER_TOOLTIP_READY' || type === 'MOUSE_HOVER_TOOLTIP_ERROR') return;

      // Whole Page lifecycle now uses trusted runtime relay only.
      if (typeof type === 'string' && type.startsWith('TRANSLATE_IT_PAGE_')) {
        return;
      }

      // Process unrelated messages from our own lite-iframes.
      if (event.data?.source === 'translate-it-iframe') {
        const { data } = event.data;

        // Forward other events to the local PageEventBus
        if (type && pageEventBus) {
          if (type?.startsWith('MOUSE_HOVER_')) return;
          const eventData = normalizeHoverErrorData(type, data);

          // Special handling for positions from iframes:
          // Transform iframe-relative coordinates to top-frame coordinates
          if (eventData && eventData.position && !eventData.position._isTransformed) {
            const iframeElement = this._getIframeElement(event.source);
            if (iframeElement) {
              const rect = iframeElement.getBoundingClientRect();
              eventData.position.x += rect.left;
              eventData.position.y += rect.top;
              eventData.position._isTransformed = true; // Avoid double transformation
              
              logger.debug(`Transformed iframe position for ${type}:`, eventData.position);
            }
          }
          
          pageEventBus.emit(type, eventData);
        }
      }

      // 2. Handle specific UI/Interaction signals from iframes
      this.handleInteractionSignals(event.data);
    });
    for (const [eventType, state] of HOVER_FEEDBACK_EVENTS) {
      pageEventBus.on(eventType, detail => this._handleHoverFeedback(eventType, state, detail));
    }
    pageEventBus.on('MOUSE_HOVER_TRANSLATION_READY', detail => {
      if (detail?.frameId === 0 && this.hoverOwner) this._retireHoverOwner(this.hoverOwner);
    });
  }

  _rememberHoverPositionHint(event) {
    const hoverId = event.data?.hoverId;
    if (typeof hoverId !== 'string' || !hoverId || hoverId.length > 160 || !event.source) return;
    if (this._isHoverIdTombstoned(hoverId)) return;
    const iframe = this._getIframeElement(event.source);
    if (!iframe) return;
    this.hoverPositionHints.delete(hoverId);
    // Keep the source association until its hover lifecycle ends; READY may arrive well after translation starts.
    this.hoverPositionHints.set(hoverId, { iframe });
    while (this.hoverPositionHints.size > 32) this.hoverPositionHints.delete(this.hoverPositionHints.keys().next().value);
    const pending = this.pendingHoverReady.get(hoverId);
    if (pending) {
      this.pendingHoverReady.delete(hoverId);
      if (pending.expires >= Date.now() && !this._isHoverTombstoned(pending.frameId, hoverId)) {
        this._admitHoverReady(pending.frameId, pending.detail, this.hoverPositionHints.get(hoverId));
      }
    }
  }

  _hoverTokenKey(frameId, hoverId) {
    return `${frameId}:${hoverId}`;
  }

  _isHoverTombstoned(frameId, hoverId) {
    const key = this._hoverTokenKey(frameId, hoverId);
    if (!this.hoverTombstones.has(key)) return false;
    this.hoverTombstones.delete(key);
    this.hoverTombstones.set(key, true);
    return true;
  }

  _isHoverIdTombstoned(hoverId) {
    for (const key of this.hoverTombstones.keys()) {
      if (key.slice(key.indexOf(':') + 1) === hoverId) {
        this.hoverTombstones.delete(key);
        this.hoverTombstones.set(key, true);
        return true;
      }
    }
    return false;
  }

  _tombstoneHover(frameId, hoverId) {
    const key = this._hoverTokenKey(frameId, hoverId);
    this.hoverTombstones.delete(key);
    this.hoverTombstones.set(key, true);
    while (this.hoverTombstones.size > 32) this.hoverTombstones.delete(this.hoverTombstones.keys().next().value);
  }

  handleHoverFrameEvent({ frameId, type, detail } = {}) {
    if (!Number.isInteger(frameId) || frameId < 0 || !HOVER_EVENT_TYPES.has(type)) return { success: false, error: 'Invalid trusted hover event' };
    if (!detail || typeof detail.hoverId !== 'string' || !detail.hoverId || detail.hoverId.length > 160) return { success: false, error: 'Invalid hover identity' };
    if (frameId === 0) {
      if (type === 'MOUSE_HOVER_TRANSLATION_READY') {
        this.pendingHoverReady.clear();
      }
      pageEventBus.emit(type, { ...detail, frameId: 0 });
      return { success: true };
    }

    if (type === 'MOUSE_HOVER_HIDE_TOOLTIP' || type === MOUSE_HOVER_TRANSLATION_ERROR) {
      this._tombstoneHover(frameId, detail.hoverId);
      this.pendingHoverReady.delete(detail.hoverId);
      this.hoverPositionHints.delete(detail.hoverId);
    }

    if (type === 'MOUSE_HOVER_TRANSLATION_READY') {
      if (this._isHoverTombstoned(frameId, detail.hoverId)) return { success: true, ignored: true, reason: 'retired-hover-token' };
      if (this.hoverOwner?.frameId === frameId && this.hoverOwner.hoverId === detail.hoverId) {
        return this._admitHoverReady(frameId, detail, this.hoverOwner);
      }
      const hint = this.hoverPositionHints.get(detail.hoverId);
      const position = detail.position;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || typeof detail.translatedText !== 'string') return { success: false, error: 'Malformed hover tooltip' };
      if (hint) return this._admitHoverReady(frameId, detail, hint);
      if (this.hoverOwner?.held && (this.hoverOwner.frameId !== frameId || this.hoverOwner.hoverId !== detail.hoverId)) {
        return { success: true, ignored: true, reason: 'tooltip-held-by-other-hover' };
      }
      this.pendingHoverReady.delete(detail.hoverId);
      this.pendingHoverReady.set(detail.hoverId, { frameId, detail, expires: Date.now() + 60_000 });
      while (this.pendingHoverReady.size > 32) this.pendingHoverReady.delete(this.pendingHoverReady.keys().next().value);
      return { success: true, pending: true };
    }

    if (type === MOUSE_HOVER_TRANSLATION_ERROR) {
      if (this.hoverOwner && (this.hoverOwner.frameId !== frameId || this.hoverOwner.hoverId !== detail.hoverId)) {
        return { success: true, ignored: true, reason: 'stale-hover-owner' };
      }
      this.hoverOwner ||= { frameId, hoverId: detail.hoverId, held: false, iframe: null };
      pageEventBus.emit(type, normalizeHoverErrorData(type, { ...detail, frameId }));
      return { success: true };
    }

    const pending = this.pendingHoverReady.get(detail.hoverId);
    if (pending?.frameId === frameId) this.pendingHoverReady.delete(detail.hoverId);
    if (this.hoverOwner?.frameId !== frameId || this.hoverOwner.hoverId !== detail.hoverId) return { success: true, ignored: true, reason: 'stale-hover-owner' };
    pageEventBus.emit(type, normalizeHoverErrorData(type, { ...detail, frameId }));
    return { success: true };
  }

  _admitHoverReady(frameId, detail, hint) {
    const held = this.hoverOwner?.held;
    if (held && (this.hoverOwner.frameId !== frameId || this.hoverOwner.hoverId !== detail.hoverId)) {
      return { success: true, ignored: true, reason: 'tooltip-held-by-other-hover' };
    }
    const sameOwner = this.hoverOwner?.frameId === frameId && this.hoverOwner.hoverId === detail.hoverId;
    const positionBasis = sameOwner ? this.hoverOwner : hint;
    if (!positionBasis?.iframe) return { success: true, ignored: true, reason: 'missing-position-hint' };
    let rect;
    try {
      rect = positionBasis.iframe.getBoundingClientRect();
    } catch {
      return { success: true, ignored: true, reason: 'position-frame-unavailable' };
    }
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return { success: true, ignored: true, reason: 'position-frame-unavailable' };
    this.pendingHoverReady.clear();
    if (this.hoverOwner && !sameOwner) this._retireHoverOwner(this.hoverOwner);
    this.hoverOwner = { frameId, hoverId: detail.hoverId, held: sameOwner ? this.hoverOwner.held : false, iframe: positionBasis.iframe };
    pageEventBus.emit('MOUSE_HOVER_TRANSLATION_READY', { ...detail, position: { x: detail.position.x + rect.left, y: detail.position.y + rect.top, _isTransformed: true }, frameId });
    return { success: true };
  }

  _handleHoverFeedback(eventType, state, detail) {
    const owner = this.hoverOwner;
    if (!owner || !detail || detail.frameId !== owner.frameId || detail.hoverId !== owner.hoverId) return;
    if (state === 'enter') owner.held = true;
    if (state === 'leave') owner.held = false;
    if (state === 'hidden') {
      this._tombstoneHover(owner.frameId, owner.hoverId);
      this.pendingHoverReady.delete(owner.hoverId);
      this.hoverPositionHints.delete(owner.hoverId);
      this.hoverOwner = null;
    }
    this._sendHoverFeedback(owner, state);
  }

  _retireHoverOwner(owner) {
    if (!owner || this.hoverOwner !== owner) return;
    this._sendHoverFeedback(owner, 'hidden');
    this._tombstoneHover(owner.frameId, owner.hoverId);
    if (this.hoverOwner === owner) this.hoverOwner = null;
    this.pendingHoverReady.delete(owner.hoverId);
    this.hoverPositionHints.delete(owner.hoverId);
  }

  _sendHoverFeedback(owner, state) {
    try {
      const result = browser.runtime.sendMessage({
        action: this.MessageActions.MOUSE_HOVER_FRAME_FEEDBACK,
        data: { targetFrameId: owner.frameId, hoverId: owner.hoverId, state },
      });
      result?.catch?.(() => {});
    } catch { /* Runtime feedback is best effort after local owner validation. */ }
  }

  handleTrustedPageLifecycle({ frameId, action, data = {} } = {}) {
    if (!Number.isInteger(frameId) || frameId < 0) {
      return { success: false, error: 'Invalid frame identity' };
    }

    if (!this.MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE_ACTIONS.includes(action)) {
      return { success: false, error: 'Unsupported page lifecycle action' };
    }

    if (action === this.MessageActions.PAGE_TRANSLATION_FRAME_RETIRED) {
      const retirementSessionId = data?.sessionId;
      if (typeof retirementSessionId === 'string' && retirementSessionId.length > 0) {
        const ownedSession = this.frameSessionOwners.get(frameId);
        if (ownedSession !== retirementSessionId) {
          return { success: true, ignored: true, reason: 'stale-session' };
        }
      }
      return this.retireFrame(frameId);
    }

    const { sessionId, ...aggregateData } = data || {};
    const hasSessionId = typeof sessionId === 'string' && sessionId.length > 0;
    const ownedSession = this.frameSessionOwners.get(frameId);

    if (!this.MessageActions.PAGE_TRANSLATION_AGGREGATE_ACTIONS.includes(action)) {
      if (!hasSessionId) {
        pageEventBus.emit(action, data);
        return { success: true, aggregated: false };
      }
      if (ownedSession !== sessionId) {
        return { success: true, ignored: true, reason: 'stale-session' };
      }
      pageEventBus.emit(action, data);
      return { success: true, aggregated: false };
    }

    if (action === this.MessageActions.PAGE_TRANSLATE_START) {
      if (!hasSessionId) {
        return { success: true, ignored: true, reason: 'missing-session' };
      }
      this.frameSessionOwners.set(frameId, sessionId);
      this._recordFrameStart(frameId, aggregateData);
      this.aggregator.emitAggregateProgress(action, data);
    } else if (ownedSession !== sessionId || !hasSessionId) {
      if (action === this.MessageActions.PAGE_TRANSLATE_ERROR && !hasSessionId) {
        pageEventBus.emit(action, data);
        return { success: true, aggregated: false, ignored: true, reason: 'missing-session' };
      }
      return { success: true, ignored: true, reason: 'stale-session' };
    } else if (action === this.MessageActions.PAGE_TRANSLATE_PROGRESS) {
      this.aggregator.updateFrameData(frameId, aggregateData);
      this.aggregator.emitAggregateProgress(null, data);
    } else if (action === this.MessageActions.PAGE_TRANSLATE_COMPLETE) {
      const terminalErrorDetails = aggregateData.isFatal !== true
        && isStructuredTranslationError(aggregateData.errorDetails)
        ? aggregateData.errorDetails
        : null;
      this.aggregator.updateFrameData(frameId, {
        ...aggregateData,
        errorDetails: terminalErrorDetails,
        isTranslating: false,
        status: 'idle',
        isTranslated: true,
      });
      this.aggregator.recordTerminalCause(frameId, terminalErrorDetails);
      this.aggregator.emitAggregateProgress(action, data);
    } else if (action === this.MessageActions.PAGE_TRANSLATE_IDLE) {
      this.aggregator.updateFrameData(frameId, {
        ...aggregateData,
        isTranslating: false,
        status: 'idle',
        isTranslated: (data.translatedCount || 0) > 0,
      });
      this.aggregator.emitAggregateProgress(action, data);
    } else if (action === this.MessageActions.PAGE_AUTO_RESTORE_COMPLETE) {
      this.aggregator.updateFrameData(frameId, {
        ...aggregateData,
        isTranslating: false,
        status: 'idle',
      });
      this.aggregator.emitAggregateProgress(action, data);
    } else if (action === this.MessageActions.PAGE_RESTORE_COMPLETE) {
      this.frameSessionOwners.delete(frameId);
      this.aggregator.removeFrame(frameId);
      if (this.frameSessionOwners.size === 0) {
        this.aggregator.emitAggregateProgress(action, data);
      } else {
        this.aggregator.emitAggregateProgress();
      }
    } else if (action === this.MessageActions.PAGE_TRANSLATE_ERROR) {
      const frameProgress = this.aggregator.frameProgressMap.get(frameId) || {};
      const isNonFatal = data.isFatal === false;
      const wasTranslating = frameProgress.isTranslating === true;
      this.aggregator.updateFrameData(frameId, {
        ...aggregateData,
        ...(!isNonFatal ? { isAutoTranslating: false } : {}),
        isTranslating: isNonFatal ? wasTranslating : false,
        status: isNonFatal ? frameProgress.status || (wasTranslating ? 'translating' : 'error') : 'error',
      });
      if (frameId !== 0 || data.isFatal !== false) {
        this.aggregator.emitAggregateProgress(action, data);
      }
    }

    return { success: true, aggregated: true };
  }

  /**
   * Helper to find the <iframe> element associated with a window source.
   * @param {Window} sourceWindow - The contentWindow of the iframe.
   * @returns {HTMLIFrameElement|null}
   */
  _getIframeElement(sourceWindow) {
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        if (iframe.contentWindow === sourceWindow) {
          return iframe;
        }
      }
    } catch (error) {
      logger.warn('Failed to find iframe element for coordinate transformation', error);
    }
    return null;
  }

  /**
   * Handles interaction-specific messages like selection and clicks.
   * @param {Object} messageData - Data from the message event.
   */
  handleInteractionSignals(messageData) {
    if (!messageData) return;

    // Text selection detection (to show UI in main frame)
    if (messageData.type === 'TRANSLATE_IT_TEXT_SELECTION_DETECTED') {
      const { text } = messageData.data || {};
      if (text && this.contentScriptCore) {
        this.contentScriptCore.loadFeature('windowsManager').then(() => {
          if (process.env.NODE_ENV === 'development') {
            console.log('[MainFrameCoordinator] Showing UI for selection detected in iframe');
          }
        });
      }
    }

    // Global click detection for UI dismissal
    if (messageData.type === 'TRANSLATE_IT_IFRAME_CLICK_DETECTED') {
      if (window.windowsManagerInstance) {
        window.windowsManagerInstance.dismiss();
      }
    }
  }

}

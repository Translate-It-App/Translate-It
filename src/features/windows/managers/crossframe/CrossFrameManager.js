// src/managers/content/windows/crossframe/CrossFrameManager.js

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { FrameRegistry } from "./FrameRegistry.js";
import { MessageRouter } from "./MessageRouter.js";

// Covers common 10-point touch plus mouse/pen pointers without unbounded state.
const MAX_LOCAL_POINTERS = 16;

/**
 * Manages all cross-frame communication for WindowsManager
 */
export class CrossFrameManager {
  constructor(options = {}) {
  this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'CrossFrameManager');
    this.debugCrossFrame = options.debugCrossFrame === true;
    
    // Initialize registry and router
    this.frameRegistry = new FrameRegistry();
    this.messageRouter = new MessageRouter(this.frameRegistry);
    
    // Set debug mode
    if (this.debugCrossFrame) {
      this.frameRegistry.enableDebug();
    }
    
    // Click broadcasting state
    this._globalClickHandler = null;
    this._relayClickHandler = null;
    this._broadcastEnabled = false;
    this._relayEnabled = false;
    this._relayRequested = false;

    // Bounded per-frame pointer observation for relayed clicks: records
    // whether a local pointerdown existed for a pointerId when its click is
    // broadcast. Records are reset on a fresh pointerdown, marked resolved on
    // pointerup (kept — the click immediately follows the pointerup), deleted
    // on pointercancel, and consumed+deleted by their click. No timers; the
    // map only holds live/recent pointers.
    this._localPointers = new Map();
    this._pointerIdentityOverflow = false;
    this._pointerObservationBound = false;

    // Bind pointer observation methods once so add/remove references match.
    this._onObservedPointerDown = this._onObservedPointerDown.bind(this);
    this._onObservedPointerUp = this._onObservedPointerUp.bind(this);
    this._onObservedPointerCancel = this._onObservedPointerCancel.bind(this);

    this._setupHandlers();
  }

  /**
   * Setup message router handlers
   */
  _setupHandlers() {
    this.messageRouter.setHandlers({
      onOutsideClick: this._handleOutsideClick.bind(this),
      onWindowCreationRequest: this._handleWindowCreationRequest.bind(this),
      onWindowCreatedResponse: this._handleWindowCreatedResponse.bind(this),
      onBroadcastStateChange: this._handleBroadcastStateChange.bind(this)
    });
  }

  /**
   * Handle outside click from other frames
   */
  _handleOutsideClick(event) {
    if (this.onOutsideClick) {
      this.onOutsideClick(event);
    }
  }

  /**
   * Handle window creation request
   */
  _handleWindowCreationRequest(data, sourceWindow) {
    if (this.onWindowCreationRequest) {
      this.onWindowCreationRequest(data, sourceWindow);
    }
  }

  /**
   * Handle window creation response
   */
  _handleWindowCreatedResponse(data) {
    if (this.onWindowCreatedResponse) {
      this.onWindowCreatedResponse(data);
    }
  }

  /**
   * Handle broadcast state change
   */
  _handleBroadcastStateChange(enabled) {
    this._applyGlobalClickRelay(enabled);
  }

  /**
   * Check if a click is the completion of a pointer gesture that started
   * inside a translation window (marked by ClickManager's window capture
   * handler). The mark only ever exists on that one completion click, so its
   * presence is a sufficient check here; such a click is not an independent
   * outside click and must not be broadcast to other frames.
   */
  _isGestureCompletionClick(event) {
    return !!event?.__translateItGestureCompletion;
  }

  /**
   * Ensure per-frame pointer observation is bound (double-init guard, same
   * pattern as _broadcastEnabled).
   */
  _ensurePointerObservation() {
    if (this._pointerObservationBound) return;
    window.addEventListener('pointerdown', this._onObservedPointerDown, { capture: true });
    window.addEventListener('pointerup', this._onObservedPointerUp, { capture: true });
    window.addEventListener('pointercancel', this._onObservedPointerCancel, { capture: true });
    this._pointerObservationBound = true;
  }

  _syncPointerObservation() {
    if (this._broadcastEnabled || this._relayEnabled) {
      this._ensurePointerObservation();
    } else {
      this._removePointerObservation();
    }
  }

  /**
   * Remove pointer observation listeners and records.
   */
  _removePointerObservation() {
    if (!this._pointerObservationBound) {
      this._localPointers.clear();
      this._pointerIdentityOverflow = false;
      return;
    }
    window.removeEventListener('pointerdown', this._onObservedPointerDown, { capture: true });
    window.removeEventListener('pointerup', this._onObservedPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this._onObservedPointerCancel, { capture: true });
    this._pointerObservationBound = false;
    this._localPointers.clear();
    this._pointerIdentityOverflow = false;
  }

  _onObservedPointerDown(event) {
    if (event.pointerId == null) return;
    // Normal pointerup→click ordering means an older resolved record whose
    // click never arrived cannot be consumed by a later pointer sequence.
    for (const [pointerId, record] of this._localPointers) {
      if (record.resolved) this._localPointers.delete(pointerId);
    }
    this._localPointers.delete(event.pointerId);
    this._makeRoomForPointer();
    this._localPointers.set(event.pointerId, { resolved: false });
  }

  _makeRoomForPointer() {
    while (this._localPointers.size >= MAX_LOCAL_POINTERS) {
      let pointerIdToEvict;
      for (const [pointerId, record] of this._localPointers) {
        if (record.resolved) {
          pointerIdToEvict = pointerId;
          break;
        }
      }
      if (pointerIdToEvict === undefined) {
        pointerIdToEvict = this._localPointers.keys().next().value;
      }
      this._localPointers.delete(pointerIdToEvict);
      // Once any capacity eviction occurs, absent identities fail open until
      // observation stops; sacrifice suppression rather than risk a false match.
      this._pointerIdentityOverflow = true;
    }
  }

  _onObservedPointerUp(event) {
    // Keep the record (resolved): the click that immediately follows the
    // pointerup must still see whether a local pointerdown existed.
    const record = this._localPointers.get(event.pointerId);
    if (record) {
      record.resolved = true;
    }
  }

  _onObservedPointerCancel(event) {
    // A cancelled pointer produces no completion click for this record.
    this._localPointers.delete(event.pointerId);
  }

  /**
   * Bounded gesture identity for a broadcast/relayed click: `true` when NO
   * local pointerdown record existed for that pointerId at click time. The
   * record is consumed (deleted) after reading.
   */
  _consumeClickGestureIdentity(event) {
    const pointerId = event?.pointerId ?? null;
    const record = pointerId === null ? undefined : this._localPointers.get(pointerId);
    if (pointerId !== null) {
      this._localPointers.delete(pointerId);
    }
    return {
      pointerId,
      fromCrossDocumentGesture: record ? false : !this._pointerIdentityOverflow,
    };
  }

  /**
   * Enable global click broadcasting for this frame
   */
  enableGlobalClickBroadcast() {
    if (this._broadcastEnabled) {
      this._syncPointerObservation();
      return;
    }

    this._globalClickHandler = (e) => {
      if (this._isGestureCompletionClick(e)) return;
      this._broadcastOutsideClick(e);
    };
    document.addEventListener('click', this._globalClickHandler, { capture: true });
    this._broadcastEnabled = true;
    this._syncPointerObservation();

    this.logger.info('[CrossFrame] Global click broadcast enabled');
    this._logXF('Broadcast enabled details', {
      frameId: this.frameId,
      isTopFrame: this.isTopFrame
    });
  }

  /**
   * Disable global click broadcasting for this frame
   */
  disableGlobalClickBroadcast() {
    if (!this._broadcastEnabled) {
      this._syncPointerObservation();
      return;
    }

    if (this._globalClickHandler) {
      document.removeEventListener('click', this._globalClickHandler, { capture: true });
      this._globalClickHandler = null;
    }
    this._broadcastEnabled = false;
    this._syncPointerObservation();

    this.logger.info('[CrossFrame] Global click broadcast disabled');
    this._logXF('Broadcast disabled details', {
      frameId: this.frameId,
      isTopFrame: this.isTopFrame
    });
  }

  /**
   * Apply or remove lightweight relay click handler
   */
  _applyGlobalClickRelay(enable) {
    try {
      if (enable) {
        if (this._relayEnabled) {
          this._syncPointerObservation();
          return;
        }
        
        // Avoid duplicate broadcast if this frame already owns an active UI broadcast
        if (this._broadcastEnabled) {
          this._relayEnabled = false;
          this._syncPointerObservation();
          return;
        }
        
        this._relayClickHandler = (e) => {
          // A gesture-completion click is not an independent outside click;
          // do not relay it.
          if (this._isGestureCompletionClick(e)) return;

          // Tag the event as relay
          try { 
            Object.defineProperty(e, '__translateItRelay', { value: true, enumerable: false }); 
          } catch {
            // Ignore property definition errors
          }
          this._broadcastOutsideClick(e);
        };
        
        document.addEventListener('click', this._relayClickHandler, { capture: true });
        this._relayEnabled = true;
        this._syncPointerObservation();
        this.logger.info('[CrossFrame] Relay click enabled');
        this._logXF('Relay enabled details', {
          frameId: this.frameId,
          broadcastActive: this._broadcastEnabled
        });
      } else {
        if (!this._relayEnabled) {
          this._syncPointerObservation();
          return;
        }

        if (this._relayClickHandler) {
          document.removeEventListener('click', this._relayClickHandler, { capture: true });
          this._relayClickHandler = null;
        }
        this._relayEnabled = false;
        this._syncPointerObservation();
        this.logger.info('[CrossFrame] Relay click disabled');
        this._logXF('Relay disabled details', {
          frameId: this.frameId
        });
      }
    } catch (error) {
      this._logXF('Failed to apply relay state', { error: error?.message });
    }
  }

  /**
   * Broadcast outside click to other frames
   */
  _broadcastOutsideClick(originalEvent) {
    this.messageRouter.broadcastOutsideClick(
      originalEvent,
      this._consumeClickGestureIdentity(originalEvent),
    );
  }

  /**
   * Request global click relay across all frames
   */
  requestGlobalClickRelay(enable) {
    this._relayRequested = !!enable;
    this.messageRouter.requestBroadcastChange(enable);
  }

  /**
   * Request window creation in main document (for iframes)
   */
  requestWindowCreation(selectedText, position) {
    if (this.frameRegistry.isTopFrame) {
      this.logger.warn('requestWindowCreation called from main document');
      return;
    }
    
    this.logger.info(`[CrossFrame] Window creation requested from iframe: ${this.frameRegistry.frameId}`);
    this._logXF('Window creation request details', {
      originalPosition: position,
      frameId: this.frameRegistry.frameId,
      textLength: selectedText?.length || 0
    });
    
    this.messageRouter.requestWindowCreation(selectedText, position);
  }

  /**
   * Notify iframe that window was created
   */
  notifyWindowCreated(frameId, success, windowId = null, error = null) {
    this.messageRouter.notifyWindowCreated(frameId, success, windowId, error);
  }

  /**
   * Get iframe element by frame ID
   */
  getIframeByFrameId(frameId) {
    return this.frameRegistry.getIframeByFrameId(frameId);
  }

  /**
   * Set event handlers
   */
  setEventHandlers(handlers) {
    this.onOutsideClick = handlers.onOutsideClick;
    this.onWindowCreationRequest = handlers.onWindowCreationRequest;
    this.onWindowCreatedResponse = handlers.onWindowCreatedResponse;
  }

  /**
   * Scoped cross-frame debug logger
   */
  _logXF(message, meta) {
    if (this.debugCrossFrame) {
      try {
        this.logger.debug(`[XF] ${message}`, meta || {});
      } catch {
        // Ignore logging errors
      }
    }
  }

  /**
   * Get current frame info
   */
  getFrameInfo() {
    return {
      frameId: this.frameRegistry.frameId,
      isTopFrame: this.frameRegistry.isTopFrame,
      isMainDocument: this.frameRegistry.isMainDocument,
      broadcastEnabled: this._broadcastEnabled,
      relayEnabled: this._relayEnabled,
      relayRequested: this._relayRequested
    };
  }

  /**
   * Clean up cross-frame manager
   */
  cleanup() {
    this.logger.info('[CrossFrame] Cleaning up cross-frame manager');
    this.disableGlobalClickBroadcast();
    this._applyGlobalClickRelay(false);
    this._removePointerObservation();
    this.messageRouter.cleanup();
    this.frameRegistry.cleanup();

    // Clear handlers
    this.onOutsideClick = null;
    this.onWindowCreationRequest = null;
    this.onWindowCreatedResponse = null;

    this.logger.info('[CrossFrame] Cleanup completed');
  }

  // Getters for compatibility
  get frameId() {
    return this.frameRegistry.frameId;
  }

  get isTopFrame() {
    return this.frameRegistry.isTopFrame;
  }
}

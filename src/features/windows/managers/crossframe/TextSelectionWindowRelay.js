// src/features/windows/managers/crossframe/TextSelectionWindowRelay.js
// Single-owner relay for cross-frame TEXT_SELECTION_WINDOW_REQUEST routing.
//
// Ownership: WindowsManager and every bootstrap installs the relay at most once
// per frame, so each frame's postMessage listener receives every request exactly
// once. Leaf frames forward upward (accumulating child iframe offsets); the top
// frame hands the request to the registered sink, which owns window creation.
//
// Sink readiness: the top frame's windows feature is lazy-loaded, so a request
// can arrive before any sink is registered. The relay buffers a single request
// (the latest selection supersedes earlier ones) and owns exactly one in-flight
// activation attempt via the bootstrap-registered callback. When the attempt
// settles, setSink() flushes the buffered request; if the attempt settles
// WITHOUT a sink (excluded, context invalid, partial init), the pending request
// is dropped so a later request can retry with a fresh activation attempt.

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { WindowsConfig } from '../core/WindowsConfig.js';
import { adjustForDirectChild } from './coordinateUtils.js';

const logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'TextSelectionWindowRelay');

let relayInstance = null;

export class TextSelectionWindowRelay {
  constructor() {
    this._isTopFrame = window === window.top;
    this._sink = null;
    this._pendingRequest = null;
    this._ensureActive = null;
    this._activationPromise = null;
    this._boundHandleMessage = this._handleMessage.bind(this);
    window.addEventListener('message', this._boundHandleMessage);
    logger.debug('TextSelectionWindowRelay installed', { isTopFrame: this._isTopFrame });
  }

  static getInstance() {
    if (!relayInstance) relayInstance = new TextSelectionWindowRelay();
    return relayInstance;
  }

  /**
   * Registers the callback that ensures the windows feature is loaded when a
   * request arrives before a sink is ready (top frame only). Registered once by
   * the bootstrap; never adds a message listener.
   */
  setEnsureActive(callback) {
    this._ensureActive = callback;
  }

  /**
   * Registers the sink that owns window creation. Delivers a single buffered
   * request (if any) that arrived before this sink was ready. This flush is the
   * authoritative delivery path for an activation that is in flight: it runs
   * before the activation promise settles, so the settle-time drop check below
   * never races it.
   */
  setSink(sink) {
    this._sink = sink;
    if (sink && this._pendingRequest) {
      const pending = this._pendingRequest;
      this._pendingRequest = null;
      this._deliver(pending.data, pending.source);
    }
  }

  /**
   * Ownership-aware sink removal: only clears when the supplied sink is still
   * the registered one, so a stale cleanup never unregisters a replacement sink.
   */
  clearSink(sink) {
    if (this._sink === sink) {
      this._sink = null;
      this._pendingRequest = null;
    }
  }

  _deliver(data, source) {
    try {
      this._sink(data, source);
    } catch (error) {
      logger.warn('Text selection window sink delivery failed:', error.message);
    }
  }

  /**
   * Starts exactly one activation attempt. No-op while one is already in flight,
   * so concurrent requests never duplicate activation. Normalizes the callback
   * through Promise semantics: a synchronous throw or a rejection is consumed
   * (never escaping _handleMessage), the in-flight state always clears, and a
   * settle without a sink drops the pending request for a future retry.
   */
  _ensureActivation() {
    if (this._activationPromise) return;

    this._activationPromise = Promise.resolve()
      .then(() => (this._ensureActive ? this._ensureActive() : null))
      .catch((error) => {
        logger.warn('Windows feature activation attempt failed', error?.message);
      })
      .finally(() => {
        this._activationPromise = null;
        // Single-flight + atomic finalizer make stale cleanup impossible: a new
        // activation cannot start until this finalizer has run, and setSink()
        // flushes before this promise settles.
        if (!this._sink && this._pendingRequest) {
          this._pendingRequest = null;
        }
      });
  }

  _handleMessage(event) {
    const data = event.data;

    if (!data || typeof data !== 'object' || data.type !== WindowsConfig.CROSS_FRAME.TEXT_SELECTION_WINDOW_REQUEST) {
      return;
    }

    if (!data.selectedText || !data.position) {
      logger.warn('Invalid text selection window request', data);
      return;
    }

    if (this._isTopFrame) {
      if (this._sink) {
        this._deliver(data, event.source);
      } else {
        // Single-slot buffer: latest selection wins while the windows feature
        // activates. Cleared on delivery, destroy, or settle-without-sink.
        this._pendingRequest = { data, source: event.source };
        this._ensureActivation();
      }
      return;
    }

    const adjustedPosition = adjustForDirectChild(event.source, data.position);
    if (!adjustedPosition) {
      logger.debug('Dropping text selection window request: unmatched child iframe source');
      return;
    }

    const adjustedToolbarPosition = data.toolbarPosition
      ? adjustForDirectChild(event.source, data.toolbarPosition)
      : null;
    const forwarded = {
      ...data,
      position: adjustedPosition,
      ...(adjustedToolbarPosition ? { toolbarPosition: adjustedToolbarPosition } : {})
    };
    window.parent.postMessage(forwarded, '*');
    logger.debug('Forwarded text selection window request to parent frame');
  }

  destroy() {
    window.removeEventListener('message', this._boundHandleMessage);
    this._sink = null;
    this._pendingRequest = null;
    this._ensureActive = null;
    this._activationPromise = null;
    relayInstance = null;
  }
}

export function getTextSelectionWindowRelay() {
  return TextSelectionWindowRelay.getInstance();
}

/**
 * Bootstrap wiring for the top frame: installs the relay and registers the
 * activation callback on the canonical contentScriptCore.loadFeature path. This
 * is the lifecycle/reactivation-capable path (its lazy-feature cache is cleared
 * by notifyFeatureDeactivated), used by every feature-loading consumer
 * (MainFrameCoordinator, InteractionCoordinator).
 *
 * The callback MUST return the loadFeature result: _ensureActivation() awaits it,
 * so activation stays in-flight until windowsManager is actually loaded. Without
 * the returned promise the activation settles immediately and its finally() drops
 * the buffered request while the feature is still loading.
 */
export function installTextSelectionWindowRelay(contentScriptCore) {
  const relay = getTextSelectionWindowRelay();
  relay.setEnsureActive(() => contentScriptCore?.loadFeature?.('windowsManager') ?? null);
  return relay;
}

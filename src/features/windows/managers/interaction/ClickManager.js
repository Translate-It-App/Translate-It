// src/managers/content/windows/interaction/ClickManager.js

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { WindowsConfig } from "../core/WindowsConfig.js";
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import ElementDetectionService from '@/shared/services/ElementDetectionService.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';

// Root class of a floating translation window. Used to scope gesture
// protection to the window element itself, not the broad Vue UI host which
// also contains icons and other UI.
const WINDOW_ROOT_CLASS = 'ti-window';

// Non-enumerable marker set on the click Event that completes a pointer
// gesture which started inside a translation window (press inside, release
// outside). Local dismissal consumers read it to skip that click.
const GESTURE_COMPLETION_MARK = '__translateItGestureCompletion';

/**
 * Manages click events and outside click detection for WindowsManager
 */
export class ClickManager extends ResourceTracker {
  constructor(crossFrameManager, state) {
    super('click-manager');
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'ClickManager');
    this.crossFrameManager = crossFrameManager;
    this.state = state;

    // Event handlers
    this.onOutsideClick = null;
    this.onIconClick = null;

    // Click listener
    this.removeMouseDownListener = null;

    // Gesture protection state: armed by a pointerdown whose composed path
    // contains this window's root element; cleared on completion marking,
    // an independent click, pointercancel, or per-window teardown. No timers.
    this._armedGesture = null;

    // Bound methods
    this._handleOutsideClick = this._handleOutsideClick.bind(this);
    this._onWindowPointerDown = this._onWindowPointerDown.bind(this);
    this._onWindowPointerCancel = this._onWindowPointerCancel.bind(this);
    this._onWindowCaptureClick = this._onWindowCaptureClick.bind(this);

    // Bind gesture listeners once per manager instance on window capture
    // (window capture runs before document capture so the completing click
    // can be marked before any dismissal consumer sees it).
    this.addEventListener(window, 'pointerdown', this._onWindowPointerDown, { capture: true });
    this.addEventListener(window, 'pointercancel', this._onWindowPointerCancel, { capture: true });
    this.addEventListener(window, 'click', this._onWindowCaptureClick, { capture: true });

    // Element detection service
    this.elementDetection = ElementDetectionService;
  }

  /**
   * Set event handlers
   */
  setHandlers(handlers) {
    this.onOutsideClick = handlers.onOutsideClick;
    this.onIconClick = handlers.onIconClick;
  }

  /**
   * Add outside click listener
   */
  addOutsideClickListener() {
    // Remove existing listener first
    this.removeOutsideClickListener();

    // Add local click listener using ResourceTracker
    this.addEventListener(document, "click", this._handleOutsideClick, { capture: true });

    // Enable cross-frame broadcasting
    this.logger.debug('Enabling cross-frame click broadcasting');
    this.crossFrameManager.enableGlobalClickBroadcast();
    this.crossFrameManager.requestGlobalClickRelay(true);

    // Store removal function for cross-frame cleanup
    this.removeMouseDownListener = () => {
      // ResourceTracker will handle event listener cleanup automatically

      // Disable cross-frame broadcasting if no active elements
      if (!this.state.hasActiveElements) {
        this.crossFrameManager.disableGlobalClickBroadcast();
        this.crossFrameManager.requestGlobalClickRelay(false);
      }
    };

    this.logger.debug('Outside click listener added', {
      isTopFrame: this.crossFrameManager.isTopFrame,
      frameId: this.crossFrameManager.frameId,
      hasActiveElements: this.state.hasActiveElements
    });
  }

  /**
   * Remove outside click listener
   */
  removeOutsideClickListener() {
    if (this.removeMouseDownListener) {
      this.removeMouseDownListener();
      this.removeMouseDownListener = null;
    }

    // Also ensure we don't keep broadcasting when nothing is shown
    if (!this.state.hasActiveElements) {
      this.crossFrameManager.disableGlobalClickBroadcast();
    }

    this.logger.debug('Outside click listener removed');
  }

  /**
   * Locate the window root element (.ti-window) inside a composed event path.
   * Scoped to the window root itself, never the broad Vue UI host.
   */
  _findGestureWindowEl(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : null;
    if (!path) return null;
    for (const node of path) {
      if (node && node.nodeType === 1 &&
          typeof node.classList?.contains === 'function' &&
          node.classList.contains(WINDOW_ROOT_CLASS)) {
        return node;
      }
    }
    return null;
  }

  /**
   * Window-capture pointerdown: arm gesture protection when the press starts
   * inside this window's root. Re-arming replaces any existing armed state.
   */
  _onWindowPointerDown(event) {
    this._armedGesture = null;
    const windowEl = this._findGestureWindowEl(event);
    if (!windowEl) return;
    this._armedGesture = {
      windowEl,
      pointerId: event.pointerId,
      completed: false,
      completionEvent: null
    };
  }

  /**
   * Window-capture pointercancel: clear the arm matching the cancelled pointer.
   */
  _onWindowPointerCancel(event) {
    if (this._armedGesture && event.pointerId === this._armedGesture.pointerId) {
      this._armedGesture = null;
    }
  }

  /**
   * Window-capture click: mark the first click dispatched while armed as the
   * gesture completion (so local consumers skip dismissal); clear the arm on
   * any later, independent click. Keyboard/programmatic clicks with no armed
   * state pass through untouched.
   */
  _onWindowCaptureClick(event) {
    const armed = this._armedGesture;
    if (!armed) return;

    if (!armed.completed) {
      try {
        Object.defineProperty(event, GESTURE_COMPLETION_MARK, {
          value: armed.windowEl,
          enumerable: false
        });
      } catch {
        // Ignore property definition errors (frozen/exotic events)
      }
      armed.completed = true;
      armed.completionEvent = event;
      // Completion click identity for cross-frame duplicate-relay matching.
      // Mouse click events carry no pointerId of their own, so the armed
      // gesture's pointer is the fallback identity.
      armed.completionPointerId = event.pointerId ?? armed.pointerId;
    } else if (event !== armed.completionEvent) {
      // Independent click with a fresh pointer sequence — disarm so the next
      // dismissal decision is unguarded.
      this._armedGesture = null;
    }
  }

  /**
   * Whether a window gesture is still PENDING (armed and not yet resolved by
   * a completion click, an independent click, a pointercancel, or teardown).
   */
  isGestureProtectionActive() {
    return !!this._armedGesture && !this._armedGesture.completed;
  }

  /**
   * Decide whether an incoming cross-frame outside-click relay belongs to a
   * locally protected window gesture and must not dismiss.
   *
   * @param {Object} identity Gesture identity fields from the relay payload.
   * @param {number|null} identity.pointerId
   * @param {boolean|undefined} identity.fromCrossDocumentGesture
   * @returns {{ suppress: boolean }}
   */
  resolveCrossFrameOutsideClick({ pointerId = null, fromCrossDocumentGesture } = {}) {
    const arm = this._armedGesture;
    if (!arm) return { suppress: false };

    if (!arm.completed) {
      if (fromCrossDocumentGesture === true &&
          pointerId !== null &&
          pointerId === arm.pointerId) {
        // The relay is the completion of our still-unresolved gesture: the
        // origin document never observed the local retargeted completion
        // click, so the remote relay resolves it. Suppress once.
        this._armedGesture = null;
        return { suppress: true };
      }
      // An independent remote click (mismatching identity or unknown flag)
      // must not kill a still-pending window gesture; its own completion,
      // cancel, next pointerdown, or matching relay resolves it.
      return { suppress: false };
    }

    // Arm completed: the origin observed the local completion click.
    if (fromCrossDocumentGesture === true &&
        pointerId !== null &&
        pointerId === arm.completionPointerId) {
      // Duplicate relay of our own completion click — suppress once, then
      // clear the arm.
      this._armedGesture = null;
      return { suppress: true };
    }

    // Stale completed arm: an independent remote click must dismiss
    // immediately; the next pointerdown re-arms fresh.
    this._armedGesture = null;
    return { suppress: false };
  }

  /**
   * Clear armed gesture state if it belongs to the given window element.
   * Called on window teardown so a removed window never guards later clicks.
   */
  clearGestureFor(windowEl) {
    if (this._armedGesture && this._armedGesture.windowEl === windowEl) {
      this._armedGesture = null;
    }
  }

  /**
   * Handle outside click events
   */
  _handleOutsideClick(e) {
    // Skip dismissal for the click that completes a pointer gesture which
    // started inside this window (press inside, release outside).
    if (this._armedGesture &&
        e.__translateItGestureCompletion === this._armedGesture.windowEl) {
      this.logger.debug('Outside click ignored: gesture completion from window press');
      return;
    }

    // Prevent dismissal if the window is pinned
    if (this.state.isPinned && !this.state.isInitialLoadingWindow?.(this.state.activeWindowId)) {
      this.logger.debug('Outside click ignored: Window is pinned');
      return;
    }

    // Prevent dismissal if transitioning from icon to window
    if (this.state.shouldPreventDismissal) {
      this.logger.debug('Outside click ignored due to pending transition');
      return;
    }

    // Check for drag operations - get reference to textSelectionManager if available
    let textSelectionManager = null;
    if (window.textSelectionManager) {
      textSelectionManager = window.textSelectionManager;
    } else if (window.TranslateItTextSelectionManager) {
      textSelectionManager = window.TranslateItTextSelectionManager;
    }

    // Prevent dismissal during or after drag operations
    if (textSelectionManager &&
        (textSelectionManager.isDragging ||
         textSelectionManager.justFinishedDrag ||
         textSelectionManager.preventDismissOnNextClear)) {
      this.logger.debug('Outside click ignored during drag operation', {
        isDragging: textSelectionManager.isDragging,
        justFinishedDrag: textSelectionManager.justFinishedDrag,
        preventDismissOnNextClear: textSelectionManager.preventDismissOnNextClear
      });
      return;
    }

    // Check if we should dismiss based on click target
    const shouldDismiss = this._shouldDismissOnOutsideClick(e);

    if (shouldDismiss && this.onOutsideClick) {
      this.onOutsideClick(e);
    }
  }

  /**
   * Determine if outside click should trigger dismissal
   */
  _shouldDismissOnOutsideClick(e) {
    // Skip if currently dragging or just finished dragging a translation window
    // This prevents accidental dismissal after fast drag operations where the click
    // event might register outside the window due to cursor overshoot.
    // Resize protection is event-scoped and read-only here: the just-resized
    // marker stays set through the whole completion-click dispatch so the
    // bubble-phase consumer (DismissalManager) ignores the same click too.
    // It is cleared by the component after dispatch or on the next pointerdown.
    const isDraggingWindow =
      window.__TRANSLATION_WINDOW_IS_DRAGGING === true ||
      window.__TRANSLATION_WINDOW_JUST_DRAGGED === true;
    const isResizingWindow =
      window.__TRANSLATION_WINDOW_IS_RESIZING === true ||
      window.__TRANSLATION_WINDOW_JUST_RESIZED === true;

    if (isDraggingWindow || isResizingWindow) {
      this.logger.debug('Skipping outside click check due to active or recent window interaction', {
        isDragging: window.__TRANSLATION_WINDOW_IS_DRAGGING,
        justDragged: window.__TRANSLATION_WINDOW_JUST_DRAGGED,
        isResizing: window.__TRANSLATION_WINDOW_IS_RESIZING,
        justResized: window.__TRANSLATION_WINDOW_JUST_RESIZED
      });
      return false;
    }
    
    // Check if click is inside Vue UI Host (Shadow DOM contains both icons and windows)
    // Try both possible host IDs (main and iframe)
    const vueUIHostMain = document.getElementById(UI_HOST_IDS.MAIN);
    const vueUIHostIframe = document.getElementById(UI_HOST_IDS.IFRAME);
    const vueUIHost = vueUIHostMain || vueUIHostIframe;
    
    this.logger.debug('Outside click check:', { 
      target: e.target.tagName, 
      vueUIHostMainExists: !!vueUIHostMain,
      vueUIHostIframeExists: !!vueUIHostIframe,
      vueUIHostExists: !!vueUIHost,
      isInsideVueHost: vueUIHost && vueUIHost.contains(e.target)
    });
    
    if (vueUIHost && vueUIHost.contains(e.target)) {
      // Click is inside Vue UI Host, don't dismiss (let Vue components handle it)
      this.logger.debug('Click is inside Vue UI Host, not dismissing');
      return false;
    }
    
    // Legacy check for old-style elements (keeping for compatibility)
    const iconElement = document.getElementById(WindowsConfig.IDS.ICON);
    if (iconElement && iconElement.contains(e.target)) {
      return false;
    }

    // Use ElementDetectionService to check if click is on UI element
    if (this.elementDetection.isUIElement(e.target)) {
      this.logger.debug('Click is on UI element (detected by ElementDetectionService)', {
        elementType: this.elementDetection.getElementType(e.target)
      });
      return false;
    }
    
    // If not inside Vue UI Host or legacy elements, dismiss
    return true;
  }

  /**
   * Setup icon click handler
   */
  setupIconClickHandler(iconElement) {
    if (!iconElement) return;

    const boundIconClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      this.logger.debug('Icon click detected');
      
      if (this.onIconClick) {
        this.onIconClick(e);
      }
    };

    this.addEventListener(iconElement, "click", boundIconClick);
    
    // Return cleanup function (ResourceTracker handles automatic cleanup)
    return () => {
      // ResourceTracker automatically handles cleanup
      this.logger.debug('Icon click handler cleanup requested');
    };
  }

  /**
   * Handle icon click with transition logic
   */
  handleIconClick(iconClickContext) {
    if (!iconClickContext) return;

    const { text, position } = iconClickContext;

    // Immediately remove outside click listener to prevent interference
    this.removeOutsideClickListener();

    // Set pending flag to prevent immediate dismissal during transition
    this.state.setPendingTranslationWindow(true);

    this.logger.debug('Icon click handled, transitioning to window', { text: text?.substring(0, 30) });

    return { text, position };
  }

  /**
   * Complete icon to window transition
   */
  completeIconTransition() {
    // Reset flags after transition delay
    setTimeout(() => {
      this.state.setPendingTranslationWindow(false);
      this.logger.debug('Icon transition completed');
    }, WindowsConfig.TIMEOUTS.PENDING_WINDOW_RESET);
  }

  /**
   * Check if click is inside specific element
   */
  isClickInsideElement(event, element) {
    if (!event || !element) return false;
    return element.contains(event.target);
  }

  /**
   * Check if click is on any UI element
   */
  isClickOnUIElement(event) {
    // Use ElementDetectionService for optimized UI element detection
    const uiElement = this.elementDetection.getClickedUIElement(event);
    if (uiElement) {
      return uiElement;
    }

    // Fallback to legacy check for old-style elements
    const iconElement = document.getElementById(WindowsConfig.IDS.ICON);
    if (iconElement && this.isClickInsideElement(event, iconElement)) {
      return { type: 'icon', element: iconElement };
    }

    return null;
  }

  /**
   * Add click listener to specific element
   */
  addElementClickListener(element, handler, options = {}) {
    if (!element || typeof handler !== 'function') return null;

    const wrappedHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler(e);
    };

    this.addEventListener(element, 'click', wrappedHandler, options);
    
    // Return cleanup function (ResourceTracker handles automatic cleanup)
    return () => {
      this.logger.debug('Element click listener cleanup requested');
    };
  }

  /**
   * Setup double-click handler
   */
  setupDoubleClickHandler(element, handler) {
    if (!element || typeof handler !== 'function') return null;

    const wrappedHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler(e);
    };

    this.addEventListener(element, 'dblclick', wrappedHandler);
    
    return () => {
      this.logger.debug('Double-click listener cleanup requested');
    };
  }

  /**
   * Prevent event propagation
   */
  stopPropagation(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * Get click coordinates
   */
  getClickCoordinates(event) {
    if (!event) return null;

    return {
      x: event.clientX,
      y: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY
    };
  }

  /**
   * Cleanup click manager
   */
  cleanup() {
    this.removeOutsideClickListener();
    window.removeEventListener('pointerdown', this._onWindowPointerDown, { capture: true });
    window.removeEventListener('pointercancel', this._onWindowPointerCancel, { capture: true });
    window.removeEventListener('click', this._onWindowCaptureClick, { capture: true });
    document.removeEventListener('click', this._handleOutsideClick, { capture: true });
    this.onOutsideClick = null;
    this.onIconClick = null;
    this._armedGesture = null;
    
    // Call ResourceTracker cleanup for automatic resource management
    super.cleanup();
    
    this.logger.debug('ClickManager cleanup completed');
  }
}

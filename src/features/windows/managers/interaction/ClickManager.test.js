import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClickManager } from './ClickManager.js';
import { DismissalManager } from '../dismissal/DismissalManager.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';
import { WindowsConfig } from "../core/WindowsConfig.js";
import ElementDetectionService from '@/shared/services/ElementDetectionService.js';

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('@/shared/logging/logConstants.js', () => ({
  LOG_COMPONENTS: { WINDOWS: 'WINDOWS' }
}));

vi.mock('../core/WindowsConfig.js', () => ({
  WindowsConfig: {
    IDS: { ICON: 'translation-icon' },
    TIMEOUTS: { PENDING_WINDOW_RESET: 500 }
  }
}));

vi.mock('@/core/memory/ResourceTracker.js', () => {
  return {
    default: class ResourceTracker {
      constructor() {
        this.addEventListener = vi.fn();
        this.removeEventListener = vi.fn();
      }
      cleanup() {}
    }
  };
});

vi.mock('@/shared/services/ElementDetectionService.js', () => ({
  default: {
    isUIElement: vi.fn().mockReturnValue(false),
    getClickedUIElement: vi.fn().mockReturnValue(null),
    getElementType: vi.fn().mockReturnValue('unknown')
  }
}));

vi.mock('@/shared/config/constants.js', () => ({
  UI_HOST_IDS: {
    MAIN: 'translate-it-ui-host',
    IFRAME: 'translate-it-ui-host-iframe'
  },
  TTS_ENGINES: { EDGE: 'edge' },
  MOBILE_CONSTANTS: { FAB: { SIDE: { RIGHT: 'right', LEFT: 'left' } }, UI_MODE: { AUTO: 'auto', MOBILE: 'mobile', DESKTOP: 'desktop' } },
  TRANSLATION_HTML: {
    ICON_ID: 'translation-icon',
    WINDOW_CLASS: 'translation-window'
  }
}));

describe('ClickManager', () => {
  let clickManager;
  let mockCrossFrameManager;
  let mockState;
  let mockHandlers;

  beforeEach(() => {
    vi.useFakeTimers();
    
    mockCrossFrameManager = {
      enableGlobalClickBroadcast: vi.fn(),
      disableGlobalClickBroadcast: vi.fn(),
      requestGlobalClickRelay: vi.fn(),
      isTopFrame: true,
      frameId: 'top'
    };

    mockState = {
      hasActiveElements: false,
      shouldPreventDismissal: false,
      isPinned: false,
      activeWindowId: 'window-1',
      isInitialLoadingWindow: vi.fn(() => false),
      setPendingTranslationWindow: vi.fn()
    };

    mockHandlers = {
      onOutsideClick: vi.fn(),
      onIconClick: vi.fn()
    };

    clickManager = new ClickManager(mockCrossFrameManager, mockState);
    clickManager.setHandlers(mockHandlers);
    
    // Clear DOM before each test
    document.body.innerHTML = '';
    
    // Reset global state
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    window.textSelectionManager = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Outside Click Listener Management', () => {
    it('should add outside click listener and enable broadcasting', () => {
      clickManager.addOutsideClickListener();

      expect(clickManager.addEventListener).toHaveBeenCalledWith(
        document,
        'click',
        expect.any(Function),
        { capture: true }
      );
      expect(mockCrossFrameManager.enableGlobalClickBroadcast).toHaveBeenCalled();
      expect(mockCrossFrameManager.requestGlobalClickRelay).toHaveBeenCalledWith(true);
    });

    it('should remove outside click listener and disable broadcasting if no active elements', () => {
      clickManager.addOutsideClickListener();
      clickManager.removeOutsideClickListener();

      expect(mockCrossFrameManager.disableGlobalClickBroadcast).toHaveBeenCalled();
      expect(mockCrossFrameManager.requestGlobalClickRelay).toHaveBeenCalledWith(false);
    });
  });

  describe('Outside Click Detection Logic', () => {
    it.each([
      ['initial spinner', true],
      ['completed window', false],
    ])('pin decision for %s', (_label, initialLoading) => {
      mockState.isPinned = true;
      mockState.isInitialLoadingWindow.mockReturnValue(initialLoading);
      vi.spyOn(clickManager, '_shouldDismissOnOutsideClick').mockReturnValue(true);

      clickManager._handleOutsideClick(new MouseEvent('click'));

      if (initialLoading) expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
      else expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
    });

    it('keeps pinned initial spinner protected during icon-to-window transition', () => {
      mockState.isPinned = true;
      mockState.isInitialLoadingWindow.mockReturnValue(true);
      mockState.shouldPreventDismissal = true;

      clickManager._handleOutsideClick(new MouseEvent('click'));

      expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
    });

    it('should NOT dismiss if shouldPreventDismissal is true', () => {
      mockState.shouldPreventDismissal = true;
      const event = new MouseEvent('click');
      
      clickManager._handleOutsideClick(event);
      
      expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
    });

    it('should NOT dismiss if dragging text selection', () => {
      window.textSelectionManager = { isDragging: true };
      const event = new MouseEvent('click');
      
      clickManager._handleOutsideClick(event);
      
      expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
    });

    it('should NOT dismiss if clicking inside Vue UI Host', () => {
      const host = document.createElement('div');
      host.id = UI_HOST_IDS.MAIN;
      document.body.appendChild(host);
      
      const target = document.createElement('span');
      host.appendChild(target);
      
      const event = { target };
      
      const shouldDismiss = clickManager._shouldDismissOnOutsideClick(event);
      expect(shouldDismiss).toBe(false);
    });

    it('should NOT dismiss if clicking inside Legacy Icon', () => {
      const icon = document.createElement('div');
      icon.id = WindowsConfig.IDS.ICON;
      document.body.appendChild(icon);
      
      const event = { target: icon };
      
      const shouldDismiss = clickManager._shouldDismissOnOutsideClick(event);
      expect(shouldDismiss).toBe(false);
    });

    it('should NOT dismiss if ElementDetectionService says it is a UI element', () => {
      vi.mocked(ElementDetectionService.isUIElement).mockReturnValueOnce(true);
      
      const target = document.createElement('div');
      const event = { target };
      
      const shouldDismiss = clickManager._shouldDismissOnOutsideClick(event);
      expect(shouldDismiss).toBe(false);
    });

    it('should NOT dismiss if clicking outside everything', () => {
      vi.mocked(ElementDetectionService.isUIElement).mockReturnValue(false);
      const target = document.createElement('div');
      document.body.appendChild(target);

      const event = { target };

      const shouldDismiss = clickManager._shouldDismissOnOutsideClick(event);
      expect(shouldDismiss).toBe(true);
    });

    it('should NOT dismiss if translation window was just recently dragged', () => {
      window.__TRANSLATION_WINDOW_JUST_DRAGGED = true;
      const target = document.createElement('div');
      document.body.appendChild(target);
      const event = { target };

      const shouldDismiss = clickManager._shouldDismissOnOutsideClick(event);
      expect(shouldDismiss).toBe(false);
    });

    it('should NOT dismiss while a docked window resize is active', () => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      const event = { target };

      window.__TRANSLATION_WINDOW_IS_RESIZING = true;
      expect(clickManager._shouldDismissOnOutsideClick(event)).toBe(false);
      // Active-resize state belongs to the component; the decision is read-only.
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);
    });

    it('should ignore the resize completion click without consuming the marker', () => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      const event = { target };

      // The click that completes the resize is suppressed read-only: the
      // marker must survive this decision so the bubble-phase consumer
      // (DismissalManager) ignores the same click too.
      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;
      expect(clickManager._shouldDismissOnOutsideClick(event)).toBe(false);
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
    });

    it('should dismiss an independent outside click once the marker is cleared', () => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      const event = { target };

      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      expect(clickManager._shouldDismissOnOutsideClick(event)).toBe(true);
    });

    it('should trigger onOutsideClick handler when it should dismiss', () => {
      // Mock _shouldDismissOnOutsideClick to return true
      vi.spyOn(clickManager, '_shouldDismissOnOutsideClick').mockReturnValue(true);
      
      const event = new MouseEvent('click');
      clickManager._handleOutsideClick(event);
      
      expect(mockHandlers.onOutsideClick).toHaveBeenCalledWith(event);
    });
  });

  describe('Resize completion click coordination', () => {
    const setupDismissalConsumers = (state = { isIconMode: false, isVisible: true, isPinned: false }) => {
      const facade = {};
      const dismissalManager = new DismissalManager(facade, {
        state,
        crossFrameManager: mockCrossFrameManager,
        translationHandler: null,
        tts: null
      });
      const dismissSpy = vi.spyOn(dismissalManager, 'dismiss').mockResolvedValue(undefined);
      dismissalManager._addDismissListener();
      return { facade, dismissSpy };
    };

    it.each([
      ['initial spinner', true],
      ['completed window', false],
    ])('DismissalManager pin decision for %s', (_label, initialLoading) => {
      const state = {
        isIconMode: false,
        isVisible: true,
        isPinned: true,
        activeWindowId: 'window-1',
        isInitialLoadingWindow: vi.fn(() => initialLoading),
      };
      const { facade, dismissSpy } = setupDismissalConsumers(state);
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);

      facade._dismissHandler({ button: 0, target: outsideTarget });

      if (initialLoading) expect(dismissSpy).toHaveBeenCalledTimes(1);
      else expect(dismissSpy).not.toHaveBeenCalled();
      document.removeEventListener('click', facade._dismissHandler);
      document.removeEventListener('keydown', facade._escapeKeyHandler);
    });

    const setupClickManagerCapture = () => {
      // ResourceTracker is mocked in this file, so attach the production
      // handler directly with its real capture phase.
      document.addEventListener('click', clickManager._handleOutsideClick, { capture: true });
    };

    const armResizeCompletionCleanup = () => {
      let completionClick = null;
      const clearMarker = () => {
        window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
        window.removeEventListener('click', bindCompletionClick, { capture: true });
        document.removeEventListener('click', clearAfterCompletionClick);
        document.removeEventListener('pointerdown', clearOnNextPointerDown, { capture: true });
      };
      const clearAfterCompletionClick = (event) => {
        if (event === completionClick) clearMarker();
      };
      const bindCompletionClick = (event) => {
        if (completionClick === null) {
          completionClick = event;
          document.addEventListener('click', clearAfterCompletionClick);
        } else if (event !== completionClick) {
          // Match the component's persistent window listener: a later click
          // also clears protection if the completion click never reached
          // document bubble and no pointerdown occurred.
          clearMarker();
        }
      };
      const clearOnNextPointerDown = () => clearMarker();

      // Match the component: bind the completion event at window capture, then
      // defer marker cleanup to document bubble after all click consumers.
      window.addEventListener('click', bindCompletionClick, { capture: true });
      // If completion-click propagation is interrupted, the next interaction
      // still clears protection before its click is evaluated.
      document.addEventListener('pointerdown', clearOnNextPointerDown, { capture: true, once: true });
      return () => {
        window.removeEventListener('click', bindCompletionClick, { capture: true });
        document.removeEventListener('click', clearAfterCompletionClick);
        document.removeEventListener('pointerdown', clearOnNextPointerDown, { capture: true });
      };
    };

    const removeDismissalConsumers = (facade) => {
      document.removeEventListener('click', clickManager._handleOutsideClick, { capture: true });
      document.removeEventListener('click', facade._dismissHandler);
      document.removeEventListener('keydown', facade._escapeKeyHandler);
    };

    it('ignores the completion click in both consumers, then immediately dismisses after pointerdown and click', () => {
      document.body.innerHTML = '';
      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

      setupClickManagerCapture();
      const { facade, dismissSpy } = setupDismissalConsumers();
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      const completionClick = new MouseEvent('click', { bubbles: true });
      const disarmResizeCompletionCleanup = armResizeCompletionCleanup();

      try {
        outsideTarget.dispatchEvent(completionClick);

        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissSpy).not.toHaveBeenCalled();
        // Synchronous document-bubble cleanup follows both consumers.
        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

        outsideTarget.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
        expect(dismissSpy).toHaveBeenCalledTimes(1);
      } finally {
        disarmResizeCompletionCleanup();
        removeDismissalConsumers(facade);
        window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      }
    });

    it('keeps protection visible to a dismissal listener added after resize is armed', () => {
      document.body.innerHTML = '';
      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

      setupClickManagerCapture();
      const disarmResizeCompletionCleanup = armResizeCompletionCleanup();
      const { facade, dismissSpy } = setupDismissalConsumers();
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);

      try {
        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissSpy).not.toHaveBeenCalled();
        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
      } finally {
        disarmResizeCompletionCleanup();
        removeDismissalConsumers(facade);
        window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      }
    });

    it('clears protection on the next pointerdown if completion-click propagation is interrupted', () => {
      document.body.innerHTML = '';
      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

      const { facade, dismissSpy } = setupDismissalConsumers();
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      const completionClick = new MouseEvent('click', { bubbles: true });
      outsideTarget.addEventListener('click', (event) => {
        if (event === completionClick) event.stopPropagation();
      });
      setupClickManagerCapture();
      const disarmResizeCompletionCleanup = armResizeCompletionCleanup();

      try {
        outsideTarget.dispatchEvent(completionClick);

        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissSpy).not.toHaveBeenCalled();
        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

        outsideTarget.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
        expect(dismissSpy).toHaveBeenCalledTimes(1);
      } finally {
        disarmResizeCompletionCleanup();
        removeDismissalConsumers(facade);
        window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      }
    });

    it('clears interrupted completion protection on a later click without pointerdown', () => {
      document.body.innerHTML = '';
      window.__TRANSLATION_WINDOW_IS_RESIZING = false;
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

      const { facade, dismissSpy } = setupDismissalConsumers();
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      const completionClick = new MouseEvent('click', { bubbles: true });
      outsideTarget.addEventListener('click', (event) => {
        if (event === completionClick) event.stopPropagation();
      });
      setupClickManagerCapture();
      const disarmResizeCompletionCleanup = armResizeCompletionCleanup();

      try {
        outsideTarget.dispatchEvent(completionClick);

        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissSpy).not.toHaveBeenCalled();
        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
        expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
        expect(dismissSpy).toHaveBeenCalledTimes(1);
      } finally {
        disarmResizeCompletionCleanup();
        removeDismissalConsumers(facade);
        window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
      }
    });
  });

  describe('Gesture completion protection', () => {
    const attachGestureHandlers = () => {
      // ResourceTracker is mocked in this file, so attach the production
      // handlers directly with their real capture semantics.
      window.addEventListener('pointerdown', clickManager._onWindowPointerDown, { capture: true });
      window.addEventListener('pointercancel', clickManager._onWindowPointerCancel, { capture: true });
      window.addEventListener('click', clickManager._onWindowCaptureClick, { capture: true });
      document.addEventListener('click', clickManager._handleOutsideClick, { capture: true });
      return () => {
        window.removeEventListener('pointerdown', clickManager._onWindowPointerDown, { capture: true });
        window.removeEventListener('pointercancel', clickManager._onWindowPointerCancel, { capture: true });
        window.removeEventListener('click', clickManager._onWindowCaptureClick, { capture: true });
        document.removeEventListener('click', clickManager._handleOutsideClick, { capture: true });
      };
    };

    const attachDismissalConsumer = () => {
      const facade = {};
      const dismissalManager = new DismissalManager(facade, {
        state: { isIconMode: false, isVisible: true, isPinned: false },
        crossFrameManager: mockCrossFrameManager,
        translationHandler: null,
        tts: null
      });
      const dismissSpy = vi.spyOn(dismissalManager, 'dismiss').mockResolvedValue(undefined);
      dismissalManager._addDismissListener();
      return {
        dismissSpy,
        remove: () => {
          document.removeEventListener('click', facade._dismissHandler, { capture: false });
          document.removeEventListener('keydown', facade._escapeKeyHandler, { capture: false });
        }
      };
    };

    const makePointerEvent = (type, { composedPath = [], pointerId = 1 } = {}) => {
      const event = new Event(type, { bubbles: true, composed: true });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      Object.defineProperty(event, 'composedPath', { value: () => composedPath });
      return event;
    };

    const setupDom = () => {
      const host = document.createElement('div');
      const windowEl = document.createElement('div');
      windowEl.className = 'ti-window';
      const inner = document.createElement('button');
      windowEl.appendChild(inner);
      host.appendChild(windowEl);
      document.body.appendChild(host);
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      return { host, windowEl, inner, outsideTarget };
    };

    it('does not dismiss when a window-press gesture completes outside in the same document', () => {
      const { windowEl, inner, outsideTarget } = setupDom();
      const detach = attachGestureHandlers();
      const dismissal = attachDismissalConsumer();

      try {
        // Press inside the window: composedPath contains the window root.
        const pressPath = [inner, windowEl, document.body, document.documentElement, document, window];
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: pressPath, pointerId: 7 }));
        outsideTarget.dispatchEvent(new Event('pointerup', { bubbles: true }));

        // The completing click outside the window.
        const completionClick = new MouseEvent('click', { bubbles: true });
        outsideTarget.dispatchEvent(completionClick);

        expect(clickManager._armedGesture?.completed).toBe(true);
        expect(clickManager.isGestureProtectionActive()).toBe(false);
        expect(completionClick.__translateItGestureCompletion).toBe(windowEl);
        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissal.dismissSpy).not.toHaveBeenCalled();
      } finally {
        detach();
        dismissal.remove();
      }
    });

    it('dismisses the independent click that follows a completed gesture', () => {
      const { windowEl, inner, outsideTarget } = setupDom();
      const detach = attachGestureHandlers();
      const dismissal = attachDismissalConsumer();

      try {
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: [inner, windowEl], pointerId: 1 }));
        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(mockHandlers.onOutsideClick).not.toHaveBeenCalled();
        expect(dismissal.dismissSpy).not.toHaveBeenCalled();

        // Independent click (fresh pointer sequence): window capture clears
        // the arm before document capture evaluates dismissal.
        const independentClick = new MouseEvent('click', { bubbles: true });
        outsideTarget.dispatchEvent(independentClick);

        expect(clickManager.isGestureProtectionActive()).toBe(false);
        expect(independentClick.__translateItGestureCompletion).toBeUndefined();
        expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
        expect(dismissal.dismissSpy).toHaveBeenCalledTimes(1);
      } finally {
        detach();
        dismissal.remove();
      }
    });

    it('dismisses a keyboard-style click with no armed pointerdown', () => {
      const { outsideTarget } = setupDom();
      const detach = attachGestureHandlers();
      const dismissal = attachDismissalConsumer();

      try {
        outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(clickManager.isGestureProtectionActive()).toBe(false);
        expect(mockHandlers.onOutsideClick).toHaveBeenCalledTimes(1);
        expect(dismissal.dismissSpy).toHaveBeenCalledTimes(1);
      } finally {
        detach();
        dismissal.remove();
      }
    });

    it('arms through an open shadow root path and ignores presses outside the window root', () => {
      const { windowEl } = setupDom();
      const detach = attachGestureHandlers();

      try {
        // Shadow retargeting: press inside an open shadow root whose
        // composedPath contains the window root element.
        const shadowHost = document.createElement('div');
        document.body.appendChild(shadowHost);
        const shadowChild = document.createElement('span');
        const shadowPath = [shadowChild, windowEl, shadowHost, document.body, document.documentElement, document, window];
        clickManager._onWindowPointerDown(makePointerEvent('pointerdown', { composedPath: shadowPath, pointerId: 1 }));
        expect(clickManager.isGestureProtectionActive()).toBe(true);
        expect(clickManager._armedGesture.windowEl).toBe(windowEl);

        // A press whose composed path does not contain the window root
        // (icon toolbar of the broad UI host) does not arm.
        const iconToolbar = document.createElement('div');
        iconToolbar.className = 'pdf-windows-host__toolbar';
        clickManager._onWindowPointerDown(makePointerEvent('pointerdown', { composedPath: [iconToolbar, shadowHost], pointerId: 2 }));
        expect(clickManager.isGestureProtectionActive()).toBe(false);
      } finally {
        detach();
      }
    });

    it('replaces the armed state when a second pointer presses down', () => {
      const { windowEl, inner, outsideTarget } = setupDom();
      const detach = attachGestureHandlers();

      try {
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: [inner, windowEl], pointerId: 1 }));
        // A second pointer also pressing inside the window replaces the arm.
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: [inner, windowEl], pointerId: 2 }));

        // The replaced arm tracks the second pointer: cancelling the first
        // does not clear it, cancelling the second does.
        outsideTarget.dispatchEvent(makePointerEvent('pointercancel', { composedPath: [outsideTarget], pointerId: 1 }));
        expect(clickManager.isGestureProtectionActive()).toBe(true);

        outsideTarget.dispatchEvent(makePointerEvent('pointercancel', { composedPath: [outsideTarget], pointerId: 2 }));
        expect(clickManager.isGestureProtectionActive()).toBe(false);
      } finally {
        detach();
      }
    });

    it('clears the arm on pointercancel and on clearGestureFor for the owning window', () => {
      const { windowEl, inner, outsideTarget } = setupDom();
      const detach = attachGestureHandlers();

      try {
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: [inner, windowEl], pointerId: 3 }));
        expect(clickManager.isGestureProtectionActive()).toBe(true);

        outsideTarget.dispatchEvent(makePointerEvent('pointercancel', { composedPath: [outsideTarget], pointerId: 3 }));
        expect(clickManager.isGestureProtectionActive()).toBe(false);

        // clearGestureFor only clears the arm that owns that window element.
        inner.dispatchEvent(makePointerEvent('pointerdown', { composedPath: [inner, windowEl], pointerId: 4 }));
        clickManager.clearGestureFor(document.createElement('div'));
        expect(clickManager.isGestureProtectionActive()).toBe(true);
        clickManager.clearGestureFor(windowEl);
        expect(clickManager.isGestureProtectionActive()).toBe(false);
      } finally {
        detach();
      }
    });
  });

  describe('Cross-frame outside-click resolution', () => {
    const armPending = (pointerId = 1) => {
      const windowEl = document.createElement('div');
      windowEl.className = 'ti-window';
      const press = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(press, 'pointerId', { value: pointerId });
      Object.defineProperty(press, 'composedPath', { value: () => [windowEl] });
      clickManager._onWindowPointerDown(press);
      return windowEl;
    };

    const completeArm = () => {
      clickManager._onWindowCaptureClick(new MouseEvent('click', { bubbles: true }));
      expect(clickManager._armedGesture?.completed).toBe(true);
    };

    it('returns { suppress: false } without state change when no arm exists', () => {
      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 1, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
      expect(clickManager._armedGesture).toBeNull();
    });

    it('suppresses once and clears a pending arm for a matching cross-document relay', () => {
      armPending(1);

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 1, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: true });
      expect(clickManager._armedGesture).toBeNull();

      // The arm is gone: a follow-up relay cannot suppress again.
      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 1, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
    });

    it('keeps a pending arm and does not suppress independent remote clicks', () => {
      armPending(1);

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 2, fromCrossDocumentGesture: false }))
        .toEqual({ suppress: false });
      expect(clickManager.isGestureProtectionActive()).toBe(true);

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 3, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
      expect(clickManager.isGestureProtectionActive()).toBe(true);
    });

    it('keeps a pending arm for a flagged relay without a pointerId', () => {
      armPending(1);

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: null, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
      expect(clickManager.isGestureProtectionActive()).toBe(true);
    });

    it('keeps a pending arm for a legacy payload without identity fields', () => {
      armPending(1);

      expect(clickManager.resolveCrossFrameOutsideClick({})).toEqual({ suppress: false });
      expect(clickManager.isGestureProtectionActive()).toBe(true);
    });

    it('clears a stale completed arm so an independent remote click dismisses immediately', () => {
      armPending(1);
      completeArm();

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 2, fromCrossDocumentGesture: false }))
        .toEqual({ suppress: false });
      expect(clickManager._armedGesture).toBeNull();
      // No arm: a second independent relay cannot suppress either.
      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 3, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
    });

    it('clears a stale completed arm for a flagged relay with a mismatching pid', () => {
      armPending(1);
      completeArm();

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 2, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
      expect(clickManager._armedGesture).toBeNull();
    });

    it('suppresses exactly once a duplicate relay of the completed gesture', () => {
      armPending(1);
      completeArm();

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 1, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: true });
      expect(clickManager._armedGesture).toBeNull();

      expect(clickManager.resolveCrossFrameOutsideClick({ pointerId: 1, fromCrossDocumentGesture: true }))
        .toEqual({ suppress: false });
    });
  });

  describe('Icon Click Handling', () => {
    it('should setup icon click handler', () => {
      const icon = document.createElement('div');
      clickManager.setupIconClickHandler(icon);
      
      expect(clickManager.addEventListener).toHaveBeenCalledWith(
        icon,
        'click',
        expect.any(Function)
      );
    });

    it('should handle icon click and transition state', () => {
      const context = { text: 'test', position: { x: 10, y: 20 } };
      
      const result = clickManager.handleIconClick(context);
      
      expect(mockState.setPendingTranslationWindow).toHaveBeenCalledWith(true);
      expect(result).toEqual(context);
    });

    it('should complete icon transition after timeout', () => {
      clickManager.completeIconTransition();
      
      expect(mockState.setPendingTranslationWindow).not.toHaveBeenCalledWith(false);
      
      vi.advanceTimersByTime(WindowsConfig.TIMEOUTS.PENDING_WINDOW_RESET);
      
      expect(mockState.setPendingTranslationWindow).toHaveBeenCalledWith(false);
    });
  });

  describe('Utility methods', () => {
    it('should correctly identify if click is inside element', () => {
      const parent = document.createElement('div');
      const child = document.createElement('span');
      parent.appendChild(child);
      
      const event = { target: child };
      expect(clickManager.isClickInsideElement(event, parent)).toBe(true);
      
      const other = document.createElement('div');
      expect(clickManager.isClickInsideElement(event, other)).toBe(false);
    });

    it('should get click coordinates', () => {
      const event = {
        clientX: 100,
        clientY: 200,
        pageX: 150,
        pageY: 250
      };
      
      const coords = clickManager.getClickCoordinates(event);
      expect(coords).toEqual({
        x: 100,
        y: 200,
        pageX: 150,
        pageY: 250
      });
    });

    it('should setup double click handler', () => {
      const element = document.createElement('div');
      const handler = vi.fn();
      clickManager.setupDoubleClickHandler(element, handler);
      
      expect(clickManager.addEventListener).toHaveBeenCalledWith(
        element,
        'dblclick',
        expect.any(Function)
      );
    });

    it('should add element click listener with wrapping', () => {
      const element = document.createElement('div');
      const handler = vi.fn();
      clickManager.addElementClickListener(element, handler);
      
      expect(clickManager.addEventListener).toHaveBeenCalledWith(
        element,
        'click',
        expect.any(Function),
        {}
      );
    });

    it('should prevent event propagation', () => {
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      };
      clickManager.stopPropagation(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('should identify click on UI element using ElementDetectionService', () => {
      const event = { target: {} };
      const uiElement = { type: 'window', element: {} };
      vi.mocked(ElementDetectionService.getClickedUIElement).mockReturnValue(uiElement);
      
      const result = clickManager.isClickOnUIElement(event);
      expect(result).toBe(uiElement);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup all listeners and handlers', () => {
      clickManager.cleanup();
      
      expect(clickManager.onOutsideClick).toBeNull();
      expect(clickManager.onIconClick).toBeNull();
      expect(mockCrossFrameManager.disableGlobalClickBroadcast).toHaveBeenCalled();
    });
  });
});

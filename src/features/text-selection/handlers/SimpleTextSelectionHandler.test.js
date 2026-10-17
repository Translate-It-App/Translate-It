import { describe, it, expect, vi, afterEach } from 'vitest';
import ElementDetectionService from '@/shared/services/ElementDetectionService.js';
import { SimpleTextSelectionHandler } from './SimpleTextSelectionHandler.js';

vi.mock('@/shared/services/ElementDetectionService.js', () => ({
  default: {
    isUIElement: vi.fn(() => false),
    getClickedUIElement: vi.fn(() => null)
  }
}));

/**
 * Focused tests for diagnostic event-path capture in SimpleTextSelectionHandler.
 *
 * In real browsers, event.composedPath() only returns the full path while the
 * event is being dispatched; afterwards it returns an empty array. The handler
 * must classify the path synchronously inside handleMouseUp and store only
 * primitive diagnostic metadata. Classification must be side-effect-free:
 * it uses direct Element.matches() and never touches the cached
 * ElementDetectionService.isUIElement().
 */
describe('SimpleTextSelectionHandler diagnostic capture', () => {
  it('classifies inside-UI composed path during handleMouseUp and reads stored metadata afterwards', () => {
    const handler = new SimpleTextSelectionHandler();
    ElementDetectionService.getClickedUIElement.mockReturnValue(null);

    // First composedPath() call (during dispatch) returns the real path;
    // later calls return empty, simulating post-dispatch behavior.
    const pathDuringDispatch = [
      document.createElement('div'),
      document.createElement('div')
    ];
    pathDuringDispatch[1].classList.add('translation-window'); // matches UI_ELEMENTS
    let composedPathCalls = 0;
    const event = new MouseEvent('mouseup', { bubbles: true });
    event.composedPath = () => {
      composedPathCalls += 1;
      return composedPathCalls === 1 ? pathDuringDispatch : [];
    };

    handler.handleMouseUp(event);

    // Classified synchronously during handleMouseUp, never re-read afterwards.
    expect(composedPathCalls).toBe(1);
    expect(handler._lastMouseUpDiagnostics).toEqual({
      timestamp: handler.lastMouseEventTime,
      composedPathHasUi: true
    });

    // Inside-window detection behavior is unchanged (driven by
    // getClickedUIElement, not by the diagnostic metadata).
    expect(handler.isClickInsideTranslationWindow()).toBe(false);
    expect(composedPathCalls).toBe(1);
  });

  it('classifies outside-UI composed path as false with the same mechanism', () => {
    const handler = new SimpleTextSelectionHandler();
    ElementDetectionService.getClickedUIElement.mockReturnValue(null);

    const event = new MouseEvent('mouseup', { bubbles: true });
    event.composedPath = () => [document.createElement('div'), document.body];

    handler.handleMouseUp(event);

    expect(handler._lastMouseUpDiagnostics).toEqual({
      timestamp: handler.lastMouseEventTime,
      composedPathHasUi: false
    });
  });

  it('keeps inside-window detection true when the service identifies UI and stores no DOM nodes', () => {
    const handler = new SimpleTextSelectionHandler();
    const uiNode = document.createElement('div');
    ElementDetectionService.getClickedUIElement.mockReturnValue({
      type: 'window',
      element: uiNode
    });

    const event = new MouseEvent('mouseup', { bubbles: true });
    event.composedPath = () => [document.createElement('div'), uiNode];
    handler.handleMouseUp(event);

    expect(handler.isClickInsideTranslationWindow()).toBe(true);
    // Metadata holds primitives only, no event path or DOM nodes.
    expect(Object.values(handler._lastMouseUpDiagnostics).every((v) => typeof v !== 'object')).toBe(true);
  });

  it('never invokes the cached ElementDetectionService.isUIElement for diagnostics', () => {
    const handler = new SimpleTextSelectionHandler();

    const insideEvent = new MouseEvent('mouseup', { bubbles: true });
    insideEvent.composedPath = () => [
      document.createElement('div'),
      Object.assign(document.createElement('div'), { className: 'translation-icon' })
    ];
    handler.handleMouseUp(insideEvent);
    handler.isClickInsideTranslationWindow();

    const outsideEvent = new MouseEvent('mouseup', { bubbles: true });
    outsideEvent.composedPath = () => [document.createElement('span')];
    handler.handleMouseUp(outsideEvent);
    handler.isClickInsideTranslationWindow();

    expect(ElementDetectionService.isUIElement).not.toHaveBeenCalled();
  });
});

/**
 * Regression tests for the floating Translation Window Body click dismissal bug.
 *
 * An inside-Body click clears the page selection, and the debounced
 * selectionchange processing runs with an empty selection. Dismissal must not
 * happen when the pointer interaction began inside extension UI, even when the
 * mouseup is not yet recorded (or never reaches the bubble-phase listener
 * because it is stopped inside the UI's shadow DOM). A genuine outside
 * interaction must still dismiss immediately.
 */
describe('SimpleTextSelectionHandler body-click dismissal regression', () => {
  let getSelectionSpy;

  const uiBody = Object.assign(document.createElement('div'), { className: 'translation-window' });
  const uiHeader = document.createElement('div');
  uiHeader.setAttribute('data-translation-window', '');

  function makePointerEvent(path) {
    const event = new Event('pointerdown', { bubbles: true, composed: true });
    event.composedPath = () => path;
    return event;
  }

  function setupEmptySelection() {
    handler.isActive = true;
    handler.selectionManager = { dismissWindow: vi.fn() };
    handler.lastMouseUpEvent = null;
    handler.lastMouseEventTime = 0;
    handler.isDragging = false;
    handler.shiftKeyPressed = false;
    getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' });
  }

  afterEach(() => {
    if (getSelectionSpy) getSelectionSpy.mockRestore();
    handler._lastUiPointerInteraction = null;
  });

  const handler = new SimpleTextSelectionHandler();

  it('does not dismiss on Body-first click with empty-selection processing before mouseup', async () => {
    setupEmptySelection();

    // Pointer interaction begins inside the window Body; the mouseup has not
    // been recorded yet (processing runs first / mouseup never arrives).
    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).not.toHaveBeenCalled();
  });

  it('does not dismiss after header interaction followed by Body click', async () => {
    setupEmptySelection();

    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiHeader]));
    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).not.toHaveBeenCalled();
  });

  it('dismisses immediately on a genuine outside interaction despite a stale inside-UI mouseup', async () => {
    setupEmptySelection();

    // Stale mouseup from an earlier inside-UI interaction (the bug scenario:
    // 3293 ms old at dismissal time).
    const staleMouseUp = new MouseEvent('mouseup', { bubbles: true });
    handler.lastMouseUpEvent = staleMouseUp;
    handler.lastMouseEventTime = Date.now() - 3293;

    // Recent pointerdown clearly outside extension UI refutes the stale record.
    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div')]));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).toHaveBeenCalledTimes(1);
  });

  it('still dismisses on keyboard-driven selection clearing with stale interaction context', async () => {
    setupEmptySelection();

    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    // Context has expired (no fresh pointer interaction); keyboard clearing
    // must behave exactly as before.
    handler._lastUiPointerInteraction.timestamp = Date.now() - 5000;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).toHaveBeenCalledTimes(1);
  });

  it('ignores interaction context once the bounded window has expired', async () => {
    setupEmptySelection();

    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    handler._lastUiPointerInteraction.timestamp = Date.now() - 1500;
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).toHaveBeenCalledTimes(1);
  });

  it('classifies pointerdown originating inside a shadow DOM host via the capture listener', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.className = 'translation-window';
    shadowRoot.appendChild(inner);

    handler.setupEventListeners();
    try {
      inner.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(handler._lastUiPointerInteraction).toEqual({
        insideUi: true,
        timestamp: expect.any(Number)
      });
    } finally {
      handler._removeDOMListeners();
      host.remove();
    }
  });

  it('removes the capture-phase pointerdown listener on cleanup (no leaks)', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      handler._removeDOMListeners();
      expect(removeSpy).toHaveBeenCalledWith(
        'pointerdown',
        handler.handleUiPointerDownCapture,
        { capture: true }
      );
    } finally {
      removeSpy.mockRestore();
    }
  });

  function makeKeyEvent(path) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    event.composedPath = () => path;
    return event;
  }

  it('dismisses when keyboard interaction outside the UI clears the selection within the window', async () => {
    setupEmptySelection();

    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    // Keyboard interaction originates outside extension UI, inside the 1s window
    handler.handleKeyDown(makeKeyEvent([document.createElement('div'), document.body]));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).toHaveBeenCalledTimes(1);
  });

  it('keeps the window when keyboard interaction originates inside the UI (source textarea editing)', async () => {
    setupEmptySelection();

    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    // Typing in the source textarea inside the window must not invalidate context
    handler.handleKeyDown(makeKeyEvent([document.createElement('textarea'), uiBody]));
    await handler.processSelection();

    expect(handler.selectionManager.dismissWindow).not.toHaveBeenCalled();
  });

  it('clears interaction context on deactivation and reactivation starts fresh', async () => {
    handler.isActive = true;
    handler.selectionManager = { dismissWindow: vi.fn(), cleanup: vi.fn() };
    handler.handleUiPointerDownCapture(makePointerEvent([document.createElement('div'), uiBody]));
    expect(handler._lastUiPointerInteraction).not.toBeNull();

    try {
      await handler.deactivate();
      expect(handler._lastUiPointerInteraction).toBeNull();

      // Stale state while inactive must also be dropped by reactivation
      handler._lastUiPointerInteraction = { insideUi: true, timestamp: Date.now() };
      await handler.activate();
      expect(handler._lastUiPointerInteraction).toBeNull();
    } finally {
      // Real lifecycle cleanup: removes DOM listeners, settings subscriptions
      // and tracked resources registered by activate(). Never substitute
      // manual state resets for deactivate().
      await handler.deactivate();
    }

    // The capture-phase pointerdown listener must be gone after deactivate():
    // a pointerdown from inside UI no longer records interaction context.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.className = 'translation-window';
    shadowRoot.appendChild(inner);

    inner.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(handler._lastUiPointerInteraction).toBeNull();
    host.remove();
  });
});

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

describe('SimpleTextSelectionHandler toolbar release position', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses a recent primary release after delayed selectionchange, including frame coordinates', () => {
    const handler = new SimpleTextSelectionHandler();
    let selectedText = '';
    vi.spyOn(window, 'getSelection').mockImplementation(() => ({ toString: () => selectedText }));
    vi.spyOn(window, 'top', 'get').mockReturnValue({});
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(40);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(70);

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 25, clientY: 35 }));
    selectedText = 'selected';
    handler.isActive = true;
    handler.selectionManager = {};
    handler.handleSelectionChange();
    clearTimeout(handler.selectionTimeout);

    expect(handler._consumeToolbarReleasePosition(selectedText)).toEqual({
      x: 25,
      y: 45,
      _isViewportRelative: true
    });
    expect(handler._toolbarReleaseCandidate).toBeNull();
  });

  it('adds page scroll only for top-frame cursor coordinates', () => {
    const handler = new SimpleTextSelectionHandler();
    vi.spyOn(window, 'top', 'get').mockReturnValue(window);
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(40);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(70);
    handler._toolbarReleaseCandidate = {
      x: 25, y: 35, timestamp: Date.now(), selectionChangeVersion: 1,
      selectedTextAtRelease: 'selected', selectedTextAtPress: ''
    };
    handler._selectionChangeVersion = 2;

    expect(handler._consumeToolbarReleasePosition('selected')).toEqual({
      x: 65,
      y: 115,
      _isViewportRelative: false
    });
  });

  it.each([2, 3])('accepts a current selection release from a %s-click sequence', (clickCount) => {
    const handler = new SimpleTextSelectionHandler();
    let selectedText = '';
    vi.spyOn(window, 'getSelection').mockImplementation(() => ({ toString: () => selectedText }));
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0, detail: clickCount }));
    selectedText = 'selected';
    handler._selectionChangeVersion += 1;
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, detail: clickCount, clientX: 8, clientY: 9 }));

    expect(handler._consumeToolbarReleasePosition(selectedText)).toEqual({
      x: 8,
      y: 19,
      _isViewportRelative: false
    });
  });

  it('uses release coordinates after a primary drag lasting longer than 1200ms', () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    let selectedText = '';
    vi.spyOn(window, 'getSelection').mockImplementation(() => ({ toString: () => selectedText }));

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(1201);
    selectedText = 'long drag selection';
    handler._selectionChangeVersion += 1;
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 18, clientY: 24 }));

    expect(handler._consumeToolbarReleasePosition(selectedText)).toEqual({
      x: 18,
      y: 34,
      _isViewportRelative: false
    });
  });

  it('expires a release candidate before delayed processing', () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    let selectedText = '';
    vi.spyOn(window, 'getSelection').mockImplementation(() => ({ toString: () => selectedText }));

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    selectedText = 'selection';
    handler._selectionChangeVersion += 1;
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 18, clientY: 24 }));
    vi.advanceTimersByTime(1201);

    expect(handler._consumeToolbarReleasePosition(selectedText)).toBeNull();
  });

  it('invalidates a release candidate after keyboard interaction', () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    let selectedText = '';
    vi.spyOn(window, 'getSelection').mockImplementation(() => ({ toString: () => selectedText }));

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    selectedText = 'selection';
    handler._selectionChangeVersion += 1;
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 18, clientY: 24 }));
    handler.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(handler._consumeToolbarReleasePosition(selectedText)).toBeNull();
  });

  it('rejects unchanged selections, stale releases, secondary clicks, and candidates after key interaction', () => {
    const handler = new SimpleTextSelectionHandler();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'same' });
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 1, clientY: 2 }));
    handler._selectionChangeVersion += 1;
    expect(handler._consumeToolbarReleasePosition('same')).toBeNull();

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 2 }));
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 2, clientX: 3, clientY: 4 }));
    expect(handler._toolbarReleaseCandidate).toBeNull();

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 5, clientY: 6 }));
    handler._selectionChangeVersion += 1;
    handler._toolbarReleaseCandidate.timestamp -= 1201;
    expect(handler._consumeToolbarReleasePosition('new selection')).toBeNull();

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0, clientX: 5, clientY: 6 }));
    handler.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(handler._consumeToolbarReleasePosition('new selection')).toBeNull();
  });

  it('hands cursor coordinates to the manager while preserving the selected text', async () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    const selection = { toString: () => 'selected text', rangeCount: 1 };
    const processSelection = vi.fn().mockResolvedValue();
    handler.isActive = true;
    handler.isDragging = false;
    handler.shiftKeyPressed = false;
    handler.lastMouseUpEvent = null;
    handler.selectionManager = { processSelection };
    handler._toolbarReleaseCandidate = {
      x: 10, y: 20, timestamp: Date.now(), selectionChangeVersion: 0,
      selectedTextAtRelease: 'selected text', selectedTextAtPress: ''
    };
    handler._selectionChangeVersion = 1;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);

    try {
      await handler.processSelection();

      expect(handler._preservationState.active).toBe(true);
      expect(processSelection).toHaveBeenCalledWith('selected text', selection, {
        ctrlPressed: false,
        shiftPressed: false,
        toolbarPosition: { x: 10, y: 30, _isViewportRelative: false }
      });
    } finally {
      handler._clearPreservationTimer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('SimpleTextSelectionHandler enhanced triple-click waiting state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('processes the final paragraph selection after a three-click drag and clears waiting state', async () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    handler.enhancedTripleClickDrag = true;
    const selection = { toString: () => 'final paragraph', rangeCount: 1 };
    const processSelection = vi.fn().mockResolvedValue();
    handler.isActive = true;
    handler.isDragging = false;
    handler.shiftKeyPressed = false;
    handler.selectionManager = { processSelection };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);

    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(10);
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(10);
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    expect(handler.isWaitingForDragEnd).toBe(true);
    handler.handleSelectionChange();
    expect(handler.selectionTimeout).toBeNull();

    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0 }));
    await vi.runAllTimersAsync();
    expect(handler.isWaitingForDragEnd).toBe(false);
    expect(processSelection).toHaveBeenCalledWith('final paragraph', selection, expect.any(Object));
    handler._clearPreservationTimer();
  });

  it('clears stale waiting state before independent mouse or keyboard selection', () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    handler.enhancedTripleClickDrag = true;
    handler.lastTripleClickTime = Date.now() - 500;
    handler.isWaitingForDragEnd = true;
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    expect(handler.isWaitingForDragEnd).toBe(false);

    handler.isWaitingForDragEnd = true;
    handler.isDragging = false;
    handler.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(handler.isWaitingForDragEnd).toBe(false);
  });

  it('does not enter the triple-click waiting state when the enhancement is disabled', () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    handler.enhancedTripleClickDrag = false;
    handler.lastTripleClickTime = Date.now() - 10;
    handler.handleMouseDown(new MouseEvent('mousedown', { button: 0 }));
    expect(handler.isWaitingForDragEnd).toBe(false);
  });

  it.each([true, false])('creates a continuation only from a primary native third-click expansion with enhancement=%s', (enhanced) => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    handler.enhancedTripleClickDrag = enhanced;
    const paragraph = document.createElement('p');
    const span = document.createElement('span');
    const textNode = document.createTextNode('word then rest');
    span.append(textNode);
    paragraph.append(span);
    document.body.append(paragraph);
    const oldRange = document.createRange();
    oldRange.setStart(textNode, 0);
    oldRange.setEnd(textNode, 4);
    handler._lastSelectionRange = oldRange.cloneRange();
    handler._lastSelectionTarget = span;
    handler._activeSelectionToken = { originFrameId: 'stable-frame', sequence: 12 };
    window.iframeClickManager = { crossFrameManager: { frameId: 'stable-frame' } };
    const expanded = document.createRange();
    expanded.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(expanded);

    const click = new MouseEvent('click', { button: 0, detail: 3 });
    Object.defineProperty(click, 'target', { value: paragraph });

    expect(handler.getSelectionContinuationTokenForClick(click)).toEqual(handler._activeSelectionToken);
    expect(window.__translateItPendingSelectionContinuationToken).toEqual(handler._activeSelectionToken);
    expect(handler.getSelectionContinuationTokenForClick(click)).toBeNull();
    expect(window.__translateItPendingSelectionContinuationToken).toBeNull();
    handler._clearAllTimers();
    delete window.iframeClickManager;
    paragraph.remove();
  });

  it.each([
    ['selectionchange-before-click', 2],
    ['selectionchange-before-click', 3],
    ['click-before-selectionchange', 2],
    ['click-before-selectionchange', 3],
  ])('routes multi-click stabilization through debounced processing (%s, detail %i)', async (order, detail) => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    const target = document.createElement('p');
    document.body.append(target);
    const text = document.createTextNode('selected text');
    target.append(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    handler.lastMouseUpEvent = { target };
    handler._lastMouseUpInteractionId = 12;
    handler.isActive = true;
    handler.isDragging = false;
    handler.isWaitingForDragEnd = false;
    handler.shiftKeyPressed = false;
    const selectionProcessing = vi.fn().mockResolvedValue(false);
    handler.selectionManager = { processSelection: selectionProcessing };
    handler._selectionChangeVersion = 4;
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);
    vi.spyOn(handler, '_detectSelectionType').mockReturnValue('default');
    const click = new MouseEvent('click', { button: 0, detail });
    Object.defineProperty(click, 'target', { value: target });

    try {
      if (order === 'selectionchange-before-click') handler.handleSelectionChange();
      handler.handleClick(click);
      if (order === 'click-before-selectionchange') handler.handleSelectionChange();

      await vi.advanceTimersByTimeAsync(handler.debounceDelay);

      expect(selectionProcessing).toHaveBeenCalledWith(
        'selected text',
        selection,
        expect.objectContaining({ displayInteraction: 'multi-click' }),
      );
      expect(handler._lastNativeClickContext).toBeNull();
    } finally {
      handler._clearPreservationTimer();
      vi.clearAllTimers();
      target.remove();
      vi.useRealTimers();
    }
  });

  it('fails closed for stale versions, mismatched selections, targets, or mouse interactions', () => {
    const handler = new SimpleTextSelectionHandler();
    const firstTarget = document.createElement('p');
    const secondTarget = document.createElement('p');
    const firstText = document.createTextNode('first');
    const secondText = document.createTextNode('second');
    firstTarget.append(firstText);
    secondTarget.append(secondText);
    document.body.append(firstTarget, secondTarget);
    const firstRange = document.createRange();
    firstRange.selectNodeContents(firstTarget);
    const secondRange = document.createRange();
    secondRange.selectNodeContents(secondTarget);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(firstRange);
    handler.lastMouseUpEvent = { target: firstTarget };
    handler._lastMouseUpInteractionId = 9;
    handler._selectionChangeVersion = 3;
    const click = new MouseEvent('click', { button: 0, detail: 2 });
    Object.defineProperty(click, 'target', { value: firstTarget });
    handler.handleClick(click);

    selection.removeAllRanges();
    selection.addRange(secondRange);
    handler._selectionChangeVersion += 2;
    handler.lastMouseEventTime = Date.now();
    expect(handler._getDisplayInteraction('post-drag-selection', selection)).toBeNull();

    handler.lastMouseUpEvent = { target: secondTarget };
    handler._lastMouseUpInteractionId = 10;
    handler.handleClick(click);
    expect(handler._lastNativeClickContext).toBeNull();
    expect(handler._getDisplayInteraction('regular-drag', selection)).toBe('regular-drag');
    expect(handler._getDisplayInteraction('shift-click', selection)).toBe('shift-click');
    expect(handler._getDisplayInteraction('keyboard-selection')).toBe('keyboard-selection');
    firstTarget.remove();
    secondTarget.remove();
  });

  it('retains the active icon token and range when duplicate selection processing does not display a new icon', async () => {
    const handler = new SimpleTextSelectionHandler();
    const token = { originFrameId: 'stable-frame', sequence: 22 };
    const target = document.createElement('p');
    const textNode = document.createTextNode('word then rest');
    target.append(textNode);
    document.body.append(target);
    const priorRange = document.createRange();
    priorRange.setStart(textNode, 0);
    priorRange.setEnd(textNode, 4);
    handler._activeSelectionToken = token;
    handler._lastSelectionText = 'word';
    handler._lastSelectionRange = priorRange.cloneRange();
    handler._lastSelectionTarget = target;
    handler.lastMouseUpEvent = { target };
    handler._lastMouseUpInteractionId = 5;
    handler._lastNativeClickContext = {
      detail: 2, target, range: priorRange.cloneRange(), text: 'word', timestamp: Date.now(),
      interactionId: 5, selectionChangeVersion: handler._selectionChangeVersion,
    };
    handler.isActive = true;
    handler.isDragging = false;
    handler.shiftKeyPressed = false;
    handler.lastKeyEventTime = 0;
    handler.lastMouseEventTime = Date.now();
    handler.selectionManager = { processSelection: vi.fn().mockResolvedValue(false) };
    window.iframeClickManager = { crossFrameManager: { frameId: 'stable-frame' } };
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(priorRange);
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);
    vi.spyOn(handler, '_detectSelectionType').mockReturnValue('default');
    vi.spyOn(handler, '_startSelectionPreservation').mockImplementation(() => {});

    await handler.processSelection();

    expect(handler._activeSelectionToken).toEqual(token);
    expect(handler._lastSelectionRange.toString()).toBe('word');
    expect(handler.selectionManager.processSelection).toHaveBeenCalledWith(
      'word', selection, expect.objectContaining({ displayInteraction: 'multi-click' }),
    );
    const expanded = document.createRange();
    expanded.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(expanded);
    const click = new MouseEvent('click', { button: 0, detail: 3 });
    Object.defineProperty(click, 'target', { value: target });
    expect(handler.getSelectionContinuationTokenForClick(click)).toEqual(token);
    target.remove();
    delete window.iframeClickManager;
    handler._clearPreservationTimer();
  });

  it('clears waiting state when mouseup processing rejects and on deactivation', async () => {
    vi.useFakeTimers();
    const handler = new SimpleTextSelectionHandler();
    handler.isWaitingForDragEnd = true;
    handler.isDragging = false;
    handler.selectionManager = {};
    handler.isActive = true;
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected' });
    vi.spyOn(handler, '_detectSelectionType').mockReturnValue('default');
    vi.spyOn(handler, '_startSelectionPreservation').mockImplementation(() => {});
    vi.spyOn(handler, 'processSelection').mockRejectedValue(new Error('failed'));
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);

    handler.handleMouseUp(new MouseEvent('mouseup', { button: 0 }));
    await vi.runAllTimersAsync();
    expect(handler.isWaitingForDragEnd).toBe(false);

    handler.isWaitingForDragEnd = true;
    handler._activeSelectionToken = { originFrameId: 'frame', sequence: 1 };
    handler._lastSelectionTarget = document.body;
    handler.selectionManager = { dismissWindow: vi.fn(), cleanup: vi.fn() };
    await handler.deactivate();
    expect(handler.isWaitingForDragEnd).toBe(false);
    expect(handler._activeSelectionToken).toBeNull();
    expect(handler._lastSelectionTarget).toBeNull();
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrossFrameManager } from './CrossFrameManager.js';

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

// Mock Registry and Router with constructor support
vi.mock('./FrameRegistry.js', () => ({
  FrameRegistry: vi.fn().mockImplementation(function() {
    this.frameId = 'test-frame';
    this.isTopFrame = true;
    this.isMainDocument = true;
    this.enableDebug = vi.fn();
    this.cleanup = vi.fn();
    this.getIframeByFrameId = vi.fn();
    return this;
  })
}));

vi.mock('./MessageRouter.js', () => ({
  MessageRouter: vi.fn().mockImplementation(function() {
    this.setHandlers = vi.fn();
    this.broadcastOutsideClick = vi.fn();
    this.requestBroadcastChange = vi.fn();
    this.requestWindowCreation = vi.fn();
    this.notifyWindowCreated = vi.fn();
    this.cleanup = vi.fn();
    return this;
  })
}));

describe('CrossFrameManager', () => {
  let cfManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cfManager = new CrossFrameManager();
  });

  afterEach(() => {
    cfManager.cleanup();
    vi.restoreAllMocks();
  });

  it('should initialize correctly', () => {
    expect(cfManager.frameId).toBe('test-frame');
    expect(cfManager.isTopFrame).toBe(true);
  });

  it('should handle outside click by calling onOutsideClick handler', () => {
    const handler = vi.fn();
    cfManager.setEventHandlers({ onOutsideClick: handler });
    
    const event = { type: 'click' };
    cfManager._handleOutsideClick(event);
    
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('should enable and disable global click broadcast', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    
    cfManager.enableGlobalClickBroadcast();
    expect(addSpy).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
    
    cfManager.disableGlobalClickBroadcast();
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
  });

  it('should broadcast outside click through MessageRouter', () => {
    const event = { type: 'click' };
    cfManager._broadcastOutsideClick(event);
    
    expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ pointerId: null, fromCrossDocumentGesture: true })
    );
  });

  it('should not broadcast a gesture-completion click via global click broadcast', () => {
    cfManager.enableGlobalClickBroadcast();
    expect(cfManager._globalClickHandler).toBeTypeOf('function');

    const windowEl = {};
    cfManager._globalClickHandler({ type: 'click', __translateItGestureCompletion: windowEl });
    expect(cfManager.messageRouter.broadcastOutsideClick).not.toHaveBeenCalled();

    const plainClick = { type: 'click' };
    cfManager._globalClickHandler(plainClick);
    expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
      plainClick,
      expect.objectContaining({ pointerId: null, fromCrossDocumentGesture: true })
    );
  });

  it('should not relay a gesture-completion click', () => {
    cfManager._applyGlobalClickRelay(true);
    expect(cfManager._relayClickHandler).toBeTypeOf('function');

    const windowEl = {};
    const gestureClick = { type: 'click', __translateItGestureCompletion: windowEl };
    cfManager._relayClickHandler(gestureClick);
    expect(cfManager.messageRouter.broadcastOutsideClick).not.toHaveBeenCalled();
    expect(gestureClick.__translateItRelay).toBeUndefined();

    const plainClick = { type: 'click' };
    cfManager._relayClickHandler(plainClick);
    expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
      plainClick,
      expect.objectContaining({ pointerId: null, fromCrossDocumentGesture: true })
    );
    expect(plainClick.__translateItRelay).toBe(true);
  });

  describe('local pointer observation for relayed gesture identity', () => {
    const makePointerEvent = (type, pointerId) => {
      const event = new Event(type, { bubbles: true, composed: true });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      return event;
    };

    beforeEach(() => {
      cfManager.enableGlobalClickBroadcast();
      expect(cfManager._pointerObservationBound).toBe(true);
    });

    it('binds observation once (double-init guard)', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      cfManager._ensurePointerObservation();
      expect(addSpy).not.toHaveBeenCalled();
    });

    it('flags a click preceded by a local pointerdown as NOT cross-document', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 4));
      window.dispatchEvent(makePointerEvent('pointerup', 4));

      cfManager._broadcastOutsideClick(makePointerEvent('click', 4));

      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
        expect.anything(),
        { pointerId: 4, fromCrossDocumentGesture: false },
      );
    });

    it('flags a click with no preceding local pointerdown as cross-document', () => {
      cfManager._broadcastOutsideClick(makePointerEvent('click', 7));

      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
        expect.anything(),
        { pointerId: 7, fromCrossDocumentGesture: true },
      );
    });

    it('keeps the pointerup record only until the following click, then starts fresh', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 9));
      window.dispatchEvent(makePointerEvent('pointerup', 9));

      cfManager._broadcastOutsideClick(makePointerEvent('click', 9));
      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenLastCalledWith(
        expect.anything(),
        { pointerId: 9, fromCrossDocumentGesture: false },
      );

      // Record was consumed by the first click: a same-pid click now
      // computes independently as cross-document.
      cfManager._broadcastOutsideClick(makePointerEvent('click', 9));
      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenLastCalledWith(
        expect.anything(),
        { pointerId: 9, fromCrossDocumentGesture: true },
      );
    });

    it('treats a fresh pointerdown without completion as a live local pointer', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 2));

      // No pointerup yet: the pending record still marks the pid as local.
      cfManager._broadcastOutsideClick(makePointerEvent('click', 2));
      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenLastCalledWith(
        expect.anything(),
        { pointerId: 2, fromCrossDocumentGesture: false },
      );
    });

    it('deletes the record on pointercancel so a later click is cross-document', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 3));
      window.dispatchEvent(makePointerEvent('pointercancel', 3));

      cfManager._broadcastOutsideClick(makePointerEvent('click', 3));
      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenLastCalledWith(
        expect.anything(),
        { pointerId: 3, fromCrossDocumentGesture: true },
      );
    });

    it('resets a resolved record on a new pointerdown for the same pointer', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 5));
      window.dispatchEvent(makePointerEvent('pointerup', 5));
      // Record resolved but kept.
      expect(cfManager._localPointers.get(5)).toEqual({ resolved: true });

      window.dispatchEvent(makePointerEvent('pointerdown', 5));
      expect(cfManager._localPointers.get(5)).toEqual({ resolved: false });
    });

    it('prunes older resolved records on a fresh pointerdown without pruning unresolved pointers', () => {
      window.dispatchEvent(makePointerEvent('pointerdown', 5));
      window.dispatchEvent(makePointerEvent('pointerup', 5));
      window.dispatchEvent(makePointerEvent('pointerdown', 6));
      expect(cfManager._localPointers.has(5)).toBe(false);
      expect(cfManager._localPointers.get(6)).toEqual({ resolved: false });

      window.dispatchEvent(makePointerEvent('pointerdown', 7));
      expect(cfManager._localPointers.has(6)).toBe(true);
      expect(cfManager._localPointers.get(7)).toEqual({ resolved: false });
    });

    it('caps unique unresolved pointers and fails open for evicted identities', () => {
      const cap = 16;
      for (let pointerId = 1; pointerId <= cap + 1; pointerId += 1) {
        window.dispatchEvent(makePointerEvent('pointerdown', pointerId));
      }

      expect(cfManager._localPointers.size).toBe(cap);
      expect(cfManager._pointerIdentityOverflow).toBe(true);
      expect(cfManager._localPointers.has(1)).toBe(false);
      expect(cfManager._consumeClickGestureIdentity(makePointerEvent('click', 1)))
        .toEqual({ pointerId: 1, fromCrossDocumentGesture: false });
      expect(cfManager._consumeClickGestureIdentity(makePointerEvent('click', cap + 1)))
        .toEqual({ pointerId: cap + 1, fromCrossDocumentGesture: false });
    });

    it('evicts resolved records before unresolved records when making capacity', () => {
      cfManager._localPointers.set(1, { resolved: true });
      for (let pointerId = 2; pointerId <= 16; pointerId += 1) {
        cfManager._localPointers.set(pointerId, { resolved: false });
      }

      cfManager._makeRoomForPointer();

      expect(cfManager._localPointers.size).toBe(15);
      expect(cfManager._localPointers.has(1)).toBe(false);
      expect(cfManager._localPointers.has(2)).toBe(true);
      expect(cfManager._pointerIdentityOverflow).toBe(true);
    });

    it('tracks all concurrent pointers within the cap through pointerup and click', () => {
      const cap = 16;
      for (let pointerId = 1; pointerId <= cap; pointerId += 1) {
        window.dispatchEvent(makePointerEvent('pointerdown', pointerId));
      }
      expect(cfManager._localPointers.size).toBe(cap);
      expect(cfManager._pointerIdentityOverflow).toBe(false);

      for (let pointerId = 1; pointerId <= cap; pointerId += 1) {
        window.dispatchEvent(makePointerEvent('pointerup', pointerId));
        expect(cfManager._consumeClickGestureIdentity(makePointerEvent('click', pointerId)))
          .toEqual({ pointerId, fromCrossDocumentGesture: false });
      }
      expect(cfManager._localPointers.size).toBe(0);
    });

    it('passes a null pointerId and cross-document flag for identity-less clicks', () => {
      cfManager._broadcastOutsideClick({ type: 'click' });
      expect(cfManager.messageRouter.broadcastOutsideClick).toHaveBeenCalledWith(
        expect.anything(),
        { pointerId: null, fromCrossDocumentGesture: true },
      );
    });
  });

  describe('pointer observation lifecycle', () => {
    const pointerEvent = (type, pointerId) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      return event;
    };

    const observationCalls = (spy, type) =>
      spy.mock.calls.filter(([eventType]) => eventType === type);

    it('removes broadcast observation listeners and clears records when broadcast turns off', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      cfManager.enableGlobalClickBroadcast();
      window.dispatchEvent(pointerEvent('pointerdown', 1));
      window.dispatchEvent(pointerEvent('pointerup', 1));

      cfManager.disableGlobalClickBroadcast();

      expect(cfManager._pointerObservationBound).toBe(false);
      expect(cfManager._localPointers.size).toBe(0);
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        expect(observationCalls(addSpy, type)).toHaveLength(1);
        expect(observationCalls(removeSpy, type)).toHaveLength(1);
      }
    });

    it('removes relay observation listeners and clears records when relay turns off', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      cfManager._applyGlobalClickRelay(true);
      window.dispatchEvent(pointerEvent('pointerdown', 2));

      cfManager._applyGlobalClickRelay(false);

      expect(cfManager._pointerObservationBound).toBe(false);
      expect(cfManager._localPointers.size).toBe(0);
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        expect(observationCalls(addSpy, type)).toHaveLength(1);
        expect(observationCalls(removeSpy, type)).toHaveLength(1);
      }
    });

    it('retains observation and records while either broadcast or relay remains active', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      cfManager._applyGlobalClickRelay(true);
      cfManager.enableGlobalClickBroadcast();
      window.dispatchEvent(pointerEvent('pointerdown', 3));
      window.dispatchEvent(pointerEvent('pointerup', 3));

      cfManager.disableGlobalClickBroadcast();
      expect(cfManager._relayEnabled).toBe(true);
      expect(cfManager._pointerObservationBound).toBe(true);
      expect(cfManager._localPointers.has(3)).toBe(true);
      expect(observationCalls(removeSpy, 'pointerdown')).toHaveLength(0);

      cfManager._applyGlobalClickRelay(false);
      expect(cfManager._pointerObservationBound).toBe(false);
      expect(cfManager._localPointers.size).toBe(0);
      expect(observationCalls(removeSpy, 'pointerdown')).toHaveLength(1);
    });

    it('does not duplicate listeners on repeated activation and restores a clean map on reactivation', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      cfManager.enableGlobalClickBroadcast();
      cfManager.enableGlobalClickBroadcast();
      cfManager._applyGlobalClickRelay(true);
      cfManager._applyGlobalClickRelay(true);
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        expect(observationCalls(addSpy, type)).toHaveLength(1);
      }

      window.dispatchEvent(pointerEvent('pointerdown', 4));
      window.dispatchEvent(pointerEvent('pointerup', 4));
      cfManager.disableGlobalClickBroadcast();
      cfManager._applyGlobalClickRelay(false);
      expect(cfManager._localPointers.size).toBe(0);

      cfManager._applyGlobalClickRelay(true);
      expect(cfManager._localPointers.size).toBe(0);
      expect(cfManager._pointerObservationBound).toBe(true);
      expect(observationCalls(addSpy, 'pointerdown')).toHaveLength(2);
    });

    it('resets overflow on full deactivation so reactivation classifies fresh remote clicks', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      cfManager._applyGlobalClickRelay(true);
      cfManager.enableGlobalClickBroadcast();
      for (let pointerId = 1; pointerId <= 17; pointerId += 1) {
        window.dispatchEvent(pointerEvent('pointerdown', pointerId));
      }
      expect(cfManager._pointerIdentityOverflow).toBe(true);

      cfManager.disableGlobalClickBroadcast();
      expect(cfManager._pointerObservationBound).toBe(true);
      cfManager._applyGlobalClickRelay(false);
      expect(cfManager._pointerObservationBound).toBe(false);
      expect(cfManager._localPointers.size).toBe(0);
      expect(cfManager._pointerIdentityOverflow).toBe(false);
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        expect(observationCalls(addSpy, type)).toHaveLength(1);
        expect(observationCalls(removeSpy, type)).toHaveLength(1);
      }

      cfManager._applyGlobalClickRelay(true);
      expect(cfManager._consumeClickGestureIdentity(pointerEvent('click', 99)))
        .toEqual({ pointerId: 99, fromCrossDocumentGesture: true });
    });

    it('repeated disable restores the observer invariant', () => {
      cfManager.enableGlobalClickBroadcast();
      cfManager.disableGlobalClickBroadcast();
      // Simulate a stale observer flag; idempotent disable repairs it.
      cfManager._pointerObservationBound = true;
      cfManager._localPointers.set(8, { resolved: true });

      cfManager.disableGlobalClickBroadcast();

      expect(cfManager._pointerObservationBound).toBe(false);
      expect(cfManager._localPointers.size).toBe(0);
    });
  });

  it('should request global click relay', () => {
    cfManager.requestGlobalClickRelay(true);
    expect(cfManager.messageRouter.requestBroadcastChange).toHaveBeenCalledWith(true);
    
    cfManager.requestGlobalClickRelay(false);
    expect(cfManager.messageRouter.requestBroadcastChange).toHaveBeenCalledWith(false);
  });

  it('should prevent window creation request from main document', () => {
    // Current mock says it's top frame
    cfManager.requestWindowCreation('text', { x: 0, y: 0 });
    expect(cfManager.messageRouter.requestWindowCreation).not.toHaveBeenCalled();
  });

  it('should allow window creation request from iframe', () => {
    // Force iframe mode
    cfManager.frameRegistry.isTopFrame = false;
    
    cfManager.requestWindowCreation('text', { x: 0, y: 0 });
    expect(cfManager.messageRouter.requestWindowCreation).toHaveBeenCalledWith('text', { x: 0, y: 0 });
  });

  it('should no longer own text selection window routing (relay owns it)', () => {
    const handler = vi.fn();
    cfManager.setEventHandlers({ onTextSelectionWindowRequest: handler });

    expect(cfManager.onTextSelectionWindowRequest).toBeUndefined();
    expect(cfManager._handleTextSelectionWindowRequest).toBeUndefined();
  });

  it('should cleanup resources', () => {
    cfManager.cleanup();
    
    expect(cfManager.messageRouter.cleanup).toHaveBeenCalled();
    expect(cfManager.frameRegistry.cleanup).toHaveBeenCalled();
  });
});

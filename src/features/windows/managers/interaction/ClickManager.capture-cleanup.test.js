import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickManager } from './ClickManager.js';
import { getMemoryManager } from '@/core/memory/MemoryManager.js';

const captureEvents = new Set(['pointerdown', 'pointercancel', 'click']);

describe('ClickManager capture listener cleanup (real ResourceTracker)', () => {
  let activeListeners;

  beforeEach(() => {
    activeListeners = new Map();
    for (const [target, targetName] of [[window, 'window'], [document, 'document']]) {
      const addEventListener = target.addEventListener.bind(target);
      const removeEventListener = target.removeEventListener.bind(target);

      vi.spyOn(target, 'addEventListener').mockImplementation((type, handler, options) => {
        if (captureEvents.has(type) && (options === true || options?.capture)) {
          const key = `${type}:${targetName}`;
          if (!activeListeners.has(key)) activeListeners.set(key, new Set());
          activeListeners.get(key).add(handler);
        }
        return addEventListener(type, handler, options);
      });

      vi.spyOn(target, 'removeEventListener').mockImplementation((type, handler, options) => {
        if (captureEvents.has(type) && (options === true || options?.capture)) {
          activeListeners.get(`${type}:${targetName}`)?.delete(handler);
        }
        return removeEventListener(type, handler, options);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeManager(onOutsideClick = vi.fn()) {
    const manager = new ClickManager(
      {
        enableGlobalClickBroadcast: vi.fn(),
        requestGlobalClickRelay: vi.fn(),
        disableGlobalClickBroadcast: vi.fn(),
        isTopFrame: true,
        frameId: 0
      },
      { hasActiveElements: true, isPinned: false, shouldPreventDismissal: false }
    );
    manager.setHandlers({ onOutsideClick, onIconClick: vi.fn() });
    manager.addOutsideClickListener();
    return manager;
  }

  const listenerCounts = () => ({
    pointerdown: activeListeners.get('pointerdown:window')?.size ?? 0,
    pointercancel: activeListeners.get('pointercancel:window')?.size ?? 0,
    windowClick: activeListeners.get('click:window')?.size ?? 0,
    documentClick: activeListeners.get('click:document')?.size ?? 0
  });

  it('removes all four capture listeners on cleanup and allows a clean subsequent manager', () => {
    const onOutsideClick = vi.fn();
    const manager = makeManager(onOutsideClick);
    const memoryManager = getMemoryManager();

    expect(listenerCounts()).toEqual({ pointerdown: 1, pointercancel: 1, windowClick: 1, documentClick: 1 });
    expect(memoryManager.groups.get(manager.groupId).size).toBe(4);

    const windowRoot = document.createElement('div');
    windowRoot.className = 'ti-window';
    const pointerdown = new Event('pointerdown');
    Object.defineProperties(pointerdown, {
      pointerId: { value: 7 },
      composedPath: { value: () => [windowRoot] }
    });
    window.dispatchEvent(pointerdown);
    expect(manager.isGestureProtectionActive()).toBe(true);

    manager.cleanup();
    expect(listenerCounts()).toEqual({ pointerdown: 0, pointercancel: 0, windowClick: 0, documentClick: 0 });
    expect(memoryManager.groups.has(manager.groupId)).toBe(false);
    manager.cleanup();

    const cancelledPointerdown = new Event('pointerdown');
    Object.defineProperties(cancelledPointerdown, {
      pointerId: { value: 8 },
      composedPath: { value: () => [windowRoot] }
    });
    window.dispatchEvent(cancelledPointerdown);
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(manager.isGestureProtectionActive()).toBe(false);
    expect(onOutsideClick).not.toHaveBeenCalled();

    const nextManager = makeManager();
    expect(listenerCounts()).toEqual({ pointerdown: 1, pointercancel: 1, windowClick: 1, documentClick: 1 });
    expect(memoryManager.groups.get(nextManager.groupId).size).toBe(4);
    nextManager.cleanup();
    expect(listenerCounts()).toEqual({ pointerdown: 0, pointercancel: 0, windowClick: 0, documentClick: 0 });
  });

  it('removes and re-adds the same outside-click handler exactly once', () => {
    const onOutsideClick = vi.fn();
    const manager = makeManager(onOutsideClick);
    const handler = manager._handleOutsideClick;
    const outsideTarget = document.createElement('div');
    document.body.appendChild(outsideTarget);

    manager.removeOutsideClickListener();
    outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOutsideClick).not.toHaveBeenCalled();

    manager.addOutsideClickListener();
    manager.addOutsideClickListener();
    expect(listenerCounts().documentClick).toBe(1);
    outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOutsideClick).toHaveBeenCalledTimes(1);

    const addCall = document.addEventListener.mock.calls.find(
      ([type, listener]) => type === 'click' && listener === handler
    );
    const removeCall = document.removeEventListener.mock.calls.find(
      ([type, listener]) => type === 'click' && listener === handler
    );
    expect(addCall).toEqual(['click', handler, { capture: true }]);
    expect(removeCall).toEqual(['click', handler, { capture: true }]);

    manager.cleanup();
  });

  it('continues dismissing outside clicks after toolbar and window creation', () => {
    const onOutsideClick = vi.fn();
    const manager = makeManager(onOutsideClick);
    const toolbar = document.createElement('div');
    toolbar.className = 'pdf-windows-host__toolbar';
    const windowRoot = document.createElement('div');
    windowRoot.className = 'ti-window';
    toolbar.appendChild(windowRoot);
    document.body.appendChild(toolbar);
    const outsideTarget = document.createElement('div');
    document.body.appendChild(outsideTarget);

    outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onOutsideClick).toHaveBeenCalledTimes(1);
    manager.cleanup();
  });
});

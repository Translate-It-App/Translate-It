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
});

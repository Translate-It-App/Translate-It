import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOWS_MANAGER_EVENTS } from '@/core/PageEventBus.js';
import { useWindowsManager } from './useWindowsManager.js';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), error: vi.fn() }),
}));

describe('useWindowsManager history snapshot metadata', () => {
  let listeners;
  let eventBus;

  beforeEach(() => {
    listeners = new Map();
    eventBus = {
      on: vi.fn((name, callback) => listeners.set(name, callback)),
      off: vi.fn((name) => listeners.delete(name)),
      emit: vi.fn((name, detail) => listeners.get(name)?.(detail)),
    };
    window.pageEventBus = eventBus;
  });

  it('clears explicit null snapshot metadata while updating the existing window', () => {
    const manager = useWindowsManager();
    manager.setupEventListeners();
    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_WINDOW, {
      id: 'window-1',
      selectedText: 'source',
      initialTranslatedText: 'result',
      detectedSourceLanguage: 'fr',
      mode: 'dictionary',
      provider: 'interactive-provider',
      historyProvider: 'snapshot-provider',
    });

    eventBus.emit(WINDOWS_MANAGER_EVENTS.UPDATE_WINDOW, {
      id: 'window-1',
      provider: 'prospective-provider',
    });

    expect(manager.translationWindows.value[0].historyProvider).toBe('snapshot-provider');

    eventBus.emit(WINDOWS_MANAGER_EVENTS.UPDATE_WINDOW, {
      id: 'window-1',
      historyProvider: 'new-snapshot-provider',
      selectedText: 'source',
      initialTranslatedText: 'restored result',
      detectedSourceLanguage: null,
      mode: null,
      historyIndex: 0,
      historyLength: 2,
    });

    expect(manager.translationWindows.value[0]).toMatchObject({
      translatedText: 'restored result',
      detectedSourceLanguage: null,
      mode: null,
      historyIndex: 0,
      historyLength: 2,
      historyProvider: 'new-snapshot-provider',
    });
    manager.cleanupEventListeners();
  });
});

describe('useWindowsManager toolbar continuation updates', () => {
  let listeners;
  let eventBus;

  beforeEach(() => {
    listeners = new Map();
    eventBus = {
      on: vi.fn((name, callback) => listeners.set(name, callback)),
      off: vi.fn((name) => listeners.delete(name)),
      emit: vi.fn((name, detail) => listeners.get(name)?.(detail)),
    };
    window.pageEventBus = eventBus;
  });

  it('updates the same icon entry with current text and both positions without token payload leakage', () => {
    const manager = useWindowsManager();
    manager.setupEventListeners();
    const token = { originFrameId: 'frame-a', sequence: 2 };
    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'toolbar-1', text: 'word', position: { x: 1, y: 2 }, selectionPosition: { x: 3, y: 4 },
      selectionContinuationToken: token,
    });
    const originalEntry = manager.translationIcons.value[0];

    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'toolbar-1', text: 'full paragraph', position: { x: 10, y: 20 }, selectionPosition: { x: 30, y: 40 },
      selectionContinuationToken: token,
    });

    expect(manager.translationIcons.value).toHaveLength(1);
    expect(manager.translationIcons.value[0].id).toBe(originalEntry.id);
    expect(manager.translationIcons.value[0]).toMatchObject({
      text: 'full paragraph', position: { x: 10, y: 20 }, selectionPosition: { x: 30, y: 40 },
    });
    manager.cleanupEventListeners();
  });

  it('retains rendered cursor position only for a matching same-ID continuation with no new position', () => {
    const manager = useWindowsManager();
    manager.setupEventListeners();
    const token = { originFrameId: 'frame-a', sequence: 8 };
    const toolbarPosition = { x: 42, y: 53 };
    const selectionPosition = { x: 11, y: 22 };
    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'toolbar-current', text: 'word', position: toolbarPosition,
      selectionPosition, selectionContinuationToken: token,
    });

    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'toolbar-current', text: 'expanded paragraph', selectionPosition,
      selectionContinuationToken: token,
    });

    expect(manager.translationIcons.value).toHaveLength(1);
    expect(manager.translationIcons.value[0]).toMatchObject({
      id: 'toolbar-current', text: 'expanded paragraph', position: toolbarPosition, selectionPosition,
    });

    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'toolbar-current', text: 'unrelated', selectionPosition,
      selectionContinuationToken: { originFrameId: 'frame-a', sequence: 9 },
    });
    eventBus.emit(WINDOWS_MANAGER_EVENTS.SHOW_ICON, {
      id: 'new-toolbar', text: 'new selection', selectionPosition,
      selectionContinuationToken: token,
    });

    expect(manager.translationIcons.value).toMatchObject([
      { id: 'toolbar-current', text: 'expanded paragraph', position: toolbarPosition },
    ]);
    manager.cleanupEventListeners();
  });
});

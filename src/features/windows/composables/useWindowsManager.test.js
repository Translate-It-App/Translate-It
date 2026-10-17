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

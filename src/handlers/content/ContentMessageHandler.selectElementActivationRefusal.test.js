import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentMessageHandler } from './ContentMessageHandler.js';
import browser from 'webextension-polyfill';
import { loadFeature } from '@/core/content-scripts/chunks/lazy-features.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      id: 'extension-id',
      getURL: vi.fn(() => 'moz-extension://extension-id/'),
      sendMessage: vi.fn(),
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    init: vi.fn(),
    warn: vi.fn(),
    operation: vi.fn(),
  })),
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    constructor() {
      this.eventListeners = [];
    }

    addEventListener(element, event, handler, options = null) {
      if (options) {
        element.addEventListener(event, handler, options);
      } else {
        element.addEventListener(event, handler);
      }
      this.eventListeners.push({ element, event, handler, options });
    }

    trackResource() {}

    cleanup() {
      for (const { element, event, handler, options } of this.eventListeners) {
        if (options) {
          element.removeEventListener(event, handler, options);
        } else {
          element.removeEventListener(event, handler);
        }
      }
      this.eventListeners = [];
    }
  },
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: vi.fn(() => ({ handle: vi.fn() })),
  },
}));

vi.mock('@/features/element-selection/utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

vi.mock('./RevertHandler.js', () => ({
  revertHandler: { executeRevert: vi.fn() },
}));

vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: vi.fn() }));

vi.mock('../smartTranslationIntegration.js', () => ({
  applyTranslationToTextField: vi.fn(),
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  ExclusionChecker: {
    getInstance: vi.fn(() => ({ isFeatureAllowed: vi.fn().mockResolvedValue(false) })),
  },
}));

describe('ContentMessageHandler definitive Select Element activation refusals', () => {
  let handler;

  beforeEach(() => {
    ContentMessageHandler.resetInstance();
    vi.clearAllMocks();
    loadFeature.mockReset();
    browser.runtime.sendMessage.mockResolvedValue({ success: true });
    handler = new ContentMessageHandler();
    handler.handlers.clear();
    handler.setSelectElementManager(null);
    handler.setPageTranslationManager(null);
  });

  it('reports an explicit negative confirmation when Select Element is blocked by exclusion', async () => {
    await expect(handler.handleActivateSelectElementMode({ data: {} })).resolves.toEqual({
      success: false,
      activated: false,
      error: 'Feature blocked on this page',
    });
  });

  it('reports real manager activity when exclusion blocks an already-active session', async () => {
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode: vi.fn(),
      isSelectElementActive: () => true,
    });

    await expect(handler.handleActivateSelectElementMode({ data: {} })).resolves.toEqual({
      success: false,
      activated: true,
      error: 'Feature blocked on this page',
    });
  });

  it('reports an explicit negative confirmation when the on-demand feature load returns null', async () => {
    const { ExclusionChecker } = await import('@/features/exclusion/core/ExclusionChecker.js');
    ExclusionChecker.getInstance.mockReturnValue({
      isFeatureAllowed: vi.fn().mockResolvedValue(true),
    });
    loadFeature.mockResolvedValue(null);

    await expect(handler.handleActivateSelectElementMode({ data: {} })).resolves.toEqual({
      success: false,
      activated: false,
      error: 'Feature blocked on this page',
    });
  });

  it('reports an explicit negative confirmation when the on-demand feature load fails', async () => {
    const { ExclusionChecker } = await import('@/features/exclusion/core/ExclusionChecker.js');
    ExclusionChecker.getInstance.mockReturnValue({
      isFeatureAllowed: vi.fn().mockResolvedValue(true),
    });
    loadFeature.mockRejectedValue(new Error('chunk unavailable'));

    await expect(handler.handleActivateSelectElementMode({ data: {} })).resolves.toEqual({
      success: false,
      activated: false,
      error: 'Feature failed to load',
    });
  });
});

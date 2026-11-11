import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      id: 'extension-id',
      getURL: vi.fn(() => 'moz-extension://extension-id/'),
      sendMessage: vi.fn(() => Promise.resolve({ success: true })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
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

vi.mock('@/handlers/content/RevertHandler.js', () => ({
  revertHandler: { executeRevert: vi.fn() },
}));

vi.mock('@/handlers/smartTranslationIntegration.js', () => ({
  applyTranslationToTextField: vi.fn(),
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { emit: vi.fn() },
}));

vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: vi.fn() }));

vi.mock('@/core/tabPermissions.js', () => ({
  checkContentScriptAccess: () => ({ isAccessible: true }),
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isValidSync: () => true },
}));

vi.mock('@/shared/error-management/windowErrorHandlers.js', () => ({
  setupWindowErrorHandlers: vi.fn(),
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  initializeContentScriptIntegration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/logging/DebugModeBridge.js', () => ({
  debugModeBridge: { initialize: vi.fn().mockResolvedValue(undefined), getHandlerMappings: vi.fn(() => ({})) },
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT', BACKGROUND: 'BACKGROUND' },
  MessageFormat: { create: vi.fn((action, data, ctx) => ({ action, data, context: ctx })), createErrorResponse: vi.fn() },
  reconstructTranslationError: vi.fn(),
  isStructuredTranslationError: vi.fn(),
}));

const {
  createSelectElementFallbackResponders,
  installSelectElementFallbackHandlers,
} = await import('./IFrameContentScriptCore.js');

const FALLBACK_ACTIVATE_RESPONSE = {
  success: false,
  activated: false,
  error: 'Select Element feature not available in this frame',
};

async function createCore() {
  const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
  const core = new IFrameContentScriptCore();
  await core.initializeBase();
  core.registerCoreHandlers();
  return core;
}

describe('IFrameContentScriptCore Select Element fallback responders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.selectElementManagerInstance;
    delete window.translateItContentCore;
    delete window.translateItContentScriptLoaded;
    delete window._translateItBootstrapPromise;
    window.translateItContentScriptInitializing = false;
  });

  afterEach(() => {
    delete window.selectElementManagerInstance;
    delete window.translateItContentCore;
  });

  it('answers ACTIVATE_SELECT_ELEMENT_MODE with a definitive negative confirmation when provably inactive', async () => {
    const core = await createCore();
    const handler = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);

    expect(handler).toBeTruthy();
    await expect(handler({ action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {}))
      .resolves.toEqual(FALLBACK_ACTIVATE_RESPONSE);
  });

  it('answers DEACTIVATE_SELECT_ELEMENT_MODE with completed cleanup when safely inactive', async () => {
    const core = await createCore();
    const handler = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);

    await expect(handler({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {}))
      .resolves.toEqual({ success: true, cleanupCompleted: true, activated: false });
  });

  it('reports accurate read-only frame state with no adopted epoch or generation', async () => {
    const core = await createCore();
    const handler = core.messageHandler.getHandlerForMessage(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE);

    await expect(handler({ action: MessageActions.GET_SELECT_ELEMENT_FRAME_STATE }, {})).resolves.toEqual({
      active: false,
      activationEpoch: null,
      activationGeneration: null,
      hasManager: false,
    });

    window.selectElementManagerInstance = { isSelectElementActive: () => true };

    await expect(handler({ action: MessageActions.GET_SELECT_ELEMENT_FRAME_STATE }, {})).resolves.toEqual({
      active: true,
      activationEpoch: null,
      activationGeneration: null,
      hasManager: true,
    });
  });

  it('hands ownership to the real ContentMessageHandler and never reclaims the actions', async () => {
    const core = await createCore();
    const fallbackActivate = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
    const fallbackDeactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);
    expect(fallbackActivate).toBeTruthy();
    expect(fallbackDeactivate).toBeTruthy();

    const { ContentMessageHandler } = await import('@/handlers/content/ContentMessageHandler.js');
    ContentMessageHandler.resetInstance();
    const contentMessageHandler = new ContentMessageHandler();
    window.translateItContentCore = { messageHandler: core.messageHandler };

    try {
      await expect(contentMessageHandler.activate()).resolves.toBe(true);

      const realActivate = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
      const realDeactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);
      expect(realActivate).not.toBe(fallbackActivate);
      expect(realDeactivate).not.toBe(fallbackDeactivate);

      // Re-installing must not overwrite the real handler's registrations.
      expect(installSelectElementFallbackHandlers(core.messageHandler).size).toBe(0);
      expect(core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(realActivate);
      expect(core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE)).toBe(realDeactivate);
    } finally {
      await contentMessageHandler.deactivate().catch(() => {});
      ContentMessageHandler.resetInstance();
      delete window.translateItContentCore;
    }
  });

  it('keeps an active session fail-closed across exclusion-policy reconciliation', async () => {
    const core = await createCore();
    window.selectElementManagerInstance = {
      isInitialized: true,
      isSelectElementActive: () => true,
    };

    // Re-invoked install (e.g. policy-change reconciliation) must not disturb ownership.
    expect(installSelectElementFallbackHandlers(core.messageHandler).size).toBe(0);
    const handler = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
    const deactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);

    await expect(handler({ action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toEqual({
      success: false,
      activated: true,
      error: 'Select Element state may still exist in this frame',
    });
    await expect(deactivate({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: true,
      error: 'Select Element state may still exist in this frame',
    });
  });

  it('stays fail-closed when a manager exists but its active flag is already cleared (cleanup pending)', async () => {
    const core = await createCore();
    // SelectElementManager clears isActive BEFORE its cleanup work completes,
    // so isSelectElementActive() === false is NOT proof of finished cleanup.
    window.selectElementManagerInstance = {
      isInitialized: true,
      isSelectElementActive: () => false,
    };

    const activate = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
    const deactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);
    const getState = core.messageHandler.getHandlerForMessage(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE);

    await expect(activate({ action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toMatchObject({
      success: false,
      activated: true,
    });
    await expect(deactivate({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toMatchObject({
      success: false,
      cleanupCompleted: false,
    });
    await expect(getState({ action: MessageActions.GET_SELECT_ELEMENT_FRAME_STATE }, {})).resolves.toEqual({
      active: true,
      activationEpoch: null,
      activationGeneration: null,
      hasManager: true,
    });
  });

  it('never replaces a foreign handler that owns an action and never reports an active session as inactive', async () => {
    const core = await createCore();
    const fallbackActivate = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);

    // Foreign handler (the real ContentMessageHandler mid-registration) takes over one action.
    const foreignHandler = async () => ({ success: true, activated: true });
    core.messageHandler.registerHandler(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, foreignHandler);

    const installed = installSelectElementFallbackHandlers(core.messageHandler);
    expect(installed.has(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(false);
    expect(core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(foreignHandler);
    expect(core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE)).toBeTruthy();

    // An active session is never reported as inactive by the remaining fallback responders.
    window.selectElementManagerInstance = { isSelectElementActive: () => true };
    const { handleActivateSelectElementMode } = createSelectElementFallbackResponders();
    await expect(handleActivateSelectElementMode({ action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE }, {})).resolves.toMatchObject({
      success: false,
      activated: true,
    });
    const deactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);
    await expect(deactivate({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE }, {})).resolves.toMatchObject({
      success: false,
      cleanupCompleted: false,
      activated: true,
    });
    expect(fallbackActivate).toBeTruthy();
  });
});

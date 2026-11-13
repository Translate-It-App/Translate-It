import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

const { loggerSpies } = vi.hoisted(() => ({
  loggerSpies: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    init: vi.fn(),
    warn: vi.fn(),
    operation: vi.fn(),
    trace: vi.fn(),
  },
}));

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
  getScopedLogger: vi.fn(() => loggerSpies),
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

const { MessageHandler } = await import('@/shared/messaging/core/MessageHandler.js');
const {
  installSelectElementFallbackHandlers,
} = await import('./IFrameContentScriptCore.js');
const { ContentMessageHandler } = await import('@/handlers/content/ContentMessageHandler.js');

const SELECT_ELEMENT_ACTIONS = [
  MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
  MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
  MessageActions.GET_SELECT_ELEMENT_FRAME_STATE,
];

const duplicateWarnings = () => loggerSpies.warn.mock.calls.filter(([message]) =>
  String(message).includes('already registered'));

describe('Select Element fallback-to-real-handler handoff', () => {
  let messageHandler;
  let installedFallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    delete window.translateItContentCore;
    ContentMessageHandler.resetInstance?.();
    messageHandler = new MessageHandler();
    installedFallbacks = installSelectElementFallbackHandlers(messageHandler);
  });

  it('does not warn when the authoritative handler replaces the fallback', async () => {
    window.translateItContentCore = { messageHandler };
    const contentMessageHandler = new ContentMessageHandler();

    await expect(contentMessageHandler.activate()).resolves.toBe(true);

    expect(duplicateWarnings()).toEqual([]);
  });

  it('gives the real handler ownership of every Select Element action', async () => {
    window.translateItContentCore = { messageHandler };
    const contentMessageHandler = new ContentMessageHandler();
    await contentMessageHandler.activate();

    SELECT_ELEMENT_ACTIONS.forEach((action) => {
      const owner = messageHandler.getHandlerForMessage(action);
      expect(owner).toBeTruthy();
      expect(owner).not.toBe(installedFallbacks.get(action));
    });
  });

  it('still warns about an unexpected duplicate registration', () => {
    const first = vi.fn();
    const second = vi.fn();
    messageHandler.registerHandler('SOME_ACTION', first);
    messageHandler.registerHandler('SOME_ACTION', second);

    expect(duplicateWarnings()).toHaveLength(1);
    expect(messageHandler.getHandlerForMessage('SOME_ACTION')).toBe(second);
  });

  it('still warns when an authoritative Select Element handler is registered twice', async () => {
    window.translateItContentCore = { messageHandler };
    const contentMessageHandler = new ContentMessageHandler();
    await contentMessageHandler.activate();

    expect(duplicateWarnings()).toEqual([]);

    // A second authoritative registration is an unexpected duplicate.
    messageHandler.registerHandler(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, vi.fn());

    expect(duplicateWarnings()).toHaveLength(1);
  });

  it('does not overwrite the real handler when the fallback is installed again', async () => {
    window.translateItContentCore = { messageHandler };
    const contentMessageHandler = new ContentMessageHandler();
    await contentMessageHandler.activate();

    const owner = messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
    const installed = installSelectElementFallbackHandlers(messageHandler);

    expect(installed.size).toBe(0);
    expect(messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(owner);
    expect(duplicateWarnings()).toEqual([]);
  });

  it('leaves a consistent owner for every action when activation fails and is retried', async () => {
    window.translateItContentCore = { messageHandler };
    const contentMessageHandler = new ContentMessageHandler();

    const realRegister = messageHandler.registerHandler.bind(messageHandler);
    let failed = false;
    messageHandler.registerHandler = (action, handler, options) => {
      if (!failed && action === MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE) {
        failed = true;
        throw new Error('registration failed');
      }
      return realRegister(action, handler, options);
    };

    await expect(contentMessageHandler.activate()).resolves.toBe(false);

    // Every action keeps exactly one owner: either the fallback or nothing.
    const fallbackHandlers = new Set(installedFallbacks.values());
    for (const action of SELECT_ELEMENT_ACTIONS) {
      const owner = messageHandler.getHandlerForMessage(action);
      expect(owner === null || fallbackHandlers.has(owner)).toBe(true);
    }

    messageHandler.registerHandler = realRegister;
    await expect(contentMessageHandler.activate()).resolves.toBe(true);

    for (const action of SELECT_ELEMENT_ACTIONS) {
      const owner = messageHandler.getHandlerForMessage(action);
      expect(owner).toBeTruthy();
      expect(fallbackHandlers.has(owner)).toBe(false);
    }
    expect(duplicateWarnings()).toEqual([]);
  });
});

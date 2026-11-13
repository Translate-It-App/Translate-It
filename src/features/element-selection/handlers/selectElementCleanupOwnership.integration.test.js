import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      sendMessage: vi.fn(),
      query: vi.fn(() => Promise.resolve([])),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    webNavigation: {
      getAllFrames: vi.fn(() => Promise.resolve([])),
      onCommitted: { addListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn() },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve()),
      getURL: vi.fn(() => 'chrome-extension://test/'),
      id: 'test',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), operation: vi.fn(), init: vi.fn(), trace: vi.fn() })),
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

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
  WINDOWS_MANAGER_EVENTS: { SHOW_WINDOW: 'SHOW_WINDOW' },
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: vi.fn(() => Promise.resolve()),
  sendRegularMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isTabActive: vi.fn(() => true),
    isValidSync: vi.fn(() => true),
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  },
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: class ErrorHandler {
    constructor() {
      this.handle = vi.fn();
    }

    static getInstance() {
      return { handle: vi.fn() };
    }
  },
}));

vi.mock('@/shared/error-management/PublicTranslationErrorPolicy.js', () => ({
  mapCanonicalTranslationError: vi.fn(() => ({ type: 'UNKNOWN', messageKey: 'ERRORS_TRANSLATION_FAILED' })),
}));

vi.mock('@/shared/error-management/PublicTranslationErrorAdapter.js', () => ({
  createLegacyDisplayError: vi.fn(() => ({ message: 'error' })),
}));

vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({
  isFatalError: vi.fn(() => false),
  isCancellationError: vi.fn(() => false),
  isSilentError: vi.fn(() => false),
  matchErrorToType: vi.fn((error) => error?.type || 'TRANSLATION_ERROR'),
}));

vi.mock('@/shared/constants/ui.js', () => ({
  NOTIFICATION_TIME: { WARNING_PROVIDER: 3000 },
}));

vi.mock('@/shared/constants/translation.js', () => ({
  TRANSLATION_STATUS: { TRANSLATING: 'translating', COMPLETED: 'completed', ERROR: 'error' },
}));

vi.mock('@/shared/config/config.js', () => ({
  getSelectElementShowOriginalOnHoverAsync: vi.fn(() => Promise.resolve(true)),
  getSourceLanguageAsync: vi.fn(() => Promise.resolve('en')),
  getTargetLanguageAsync: vi.fn(() => Promise.resolve('fa')),
  getTranslationApiAsync: vi.fn(() => Promise.resolve('google')),
  getEffectiveProviderAsync: vi.fn(() => Promise.resolve('google')),
  getAIContextTranslationEnabledAsync: vi.fn(() => Promise.resolve(true)),
  TranslationMode: { Select_Element: 'select_element' },
}));

vi.mock('@/utils/i18n/i18n.js', () => ({
  getTranslationString: vi.fn((key) => key),
}));

vi.mock('@/shared/utils/warning-manager.js', () => ({
  shouldShowProviderWarning: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewManager.js', () => ({
  hoverPreviewManager: { initialize: vi.fn(), deactivate: vi.fn() },
}));

vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({
  ProviderRegistryIds: { GOOGLE: 'google', DEEPL: 'deepl', GEMINI: 'gemini' },
}));

vi.mock('@/utils/browser/compatibility.js', () => ({
  deviceDetector: { isMobile: vi.fn(() => false), isIOS: vi.fn(() => false), isAndroid: vi.fn(() => false) },
}));

vi.mock('../SelectElement.scss?inline', () => ({ default: '.mock-styles {}' }));

vi.mock('../core/DomTranslatorAdapter.js', () => ({
  DomTranslatorAdapter: class {
    initialize = vi.fn(() => Promise.resolve());
    translateElement = vi.fn(() => Promise.resolve({ success: true }));
    cleanup = vi.fn();
    cancelTranslation = vi.fn(() => Promise.resolve());
    revertTranslation = vi.fn();
    hasTranslation = vi.fn(() => false);
  },
}));

vi.mock('../core/ElementSelector.js', () => ({
  ElementSelector: class {
    initialize = vi.fn(() => Promise.resolve());
    activate = vi.fn();
    deactivate = vi.fn();
    cleanup = vi.fn();
    handleMouseOver = vi.fn();
    handleMouseOut = vi.fn();
    clearHighlight = vi.fn();
    getHighlightedElement = vi.fn();
    findBestTextElement = vi.fn(element => element);
    isOurElement = vi.fn(() => false);
  },
}));

vi.mock('../utils/elementHelpers.js', () => ({
  extractTextFromElement: vi.fn(() => 'test text'),
  isSelectableTextRoot: vi.fn(() => true),
}));

vi.mock('../SelectElementNotificationManager.js', () => ({
  getSelectElementNotificationManager: vi.fn(() => Promise.resolve({
    showActivationNotification: vi.fn(),
    showProgress: vi.fn(),
    dismiss: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

vi.mock('@/handlers/content/RevertHandler.js', () => ({
  revertHandler: { executeRevert: vi.fn() },
}));

vi.mock('@/handlers/smartTranslationIntegration.js', () => ({
  applyTranslationToTextField: vi.fn(),
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  ExclusionChecker: {
    getInstance: vi.fn(() => ({ isFeatureAllowed: vi.fn(() => Promise.resolve(false)) })),
  },
}));

vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: vi.fn() }));

vi.mock('@/features/element-selection/utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT', BACKGROUND: 'BACKGROUND' },
  MessageFormat: { create: vi.fn((action, data, ctx) => ({ action, data, context: ctx })), createErrorResponse: vi.fn() },
  reconstructTranslationError: vi.fn(),
  isStructuredTranslationError: vi.fn(),
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: {
    checkTabAccess: vi.fn(() => Promise.resolve({ isAccessible: true, fullUrl: 'https://example.com', isRestricted: false })),
  },
  checkContentScriptAccess: () => ({ isAccessible: true }),
}));

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: vi.fn(() => Promise.resolve(false)),
}));

import browser from 'webextension-polyfill';
import { ExclusionChecker } from '@/features/exclusion/core/ExclusionChecker.js';
import { SelectElementManager } from '@/features/element-selection/SelectElementManager.js';
import { ContentMessageHandler } from '@/handlers/content/ContentMessageHandler.js';
import {
  clearDeactivationPending,
  clearProvisionalCleanupFrames,
  clearStateForTab,
  clearTabParticipants,
  getProvisionalCleanupFrames,
  isDeactivationPending,
} from './selectElementStateManager.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';

const TAB_ID = 5501;
const FRAME = { frameId: 0, url: 'https://example.com/watch', documentId: 'doc-top' };

let contentMessageHandler;
let manager;

beforeEach(() => {
  vi.clearAllMocks();
  clearStateForTab(TAB_ID);
  clearTabParticipants(TAB_ID);
  clearDeactivationPending(TAB_ID);
  delete window.selectElementManagerInstance;

  ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(false)) });

  ContentMessageHandler.resetInstance?.();
  contentMessageHandler = new ContentMessageHandler();
  manager = new SelectElementManager();
  manager.isInitialized = true;
  manager.isActive = true;
  manager.emergencyCleanup = vi.fn();
  contentMessageHandler.setSelectElementManager(manager);

  browser.webNavigation.getAllFrames.mockImplementation(async () => [FRAME]);
});

/** Start a deactivation whose cleanup is paused mid-flight. */
function startPausedDeactivation() {
  let resolveCleanup;
  manager.domTranslatorAdapter.cancelTranslation.mockImplementation(() => new Promise((resolve) => {
    resolveCleanup = resolve;
  }));
  const deactivation = manager.deactivate({ reason: 'cancel', fromBackground: true });
  return {
    deactivation,
    resolveCleanup: () => resolveCleanup(),
  };
}

/** Route background messages to the real content handler. */
function routeToContentHandler(onDeactivateDispatched) {
  browser.tabs.sendMessage.mockImplementation(async (_tabId, msg) => {
    if (msg.action === 'activateSelectElementMode') {
      return contentMessageHandler.handleActivateSelectElementMode(msg);
    }
    if (msg.action === 'deactivateSelectElementMode') {
      onDeactivateDispatched?.();
      return contentMessageHandler.handleDeactivateSelectElementMode(msg);
    }
    if (msg.action === 'getSelectElementFrameState') {
      return contentMessageHandler.handleGetSelectElementFrameState();
    }
    return undefined;
  });
}

describe('exclusion refusal keeps Select Element cleanup ownership', () => {
  it('does not report definitive inactivity while the manager still owns cleanup', async () => {
    const { deactivation, resolveCleanup } = startPausedDeactivation();
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    // The manager clears isActive BEFORE its cleanup work completes.
    expect(manager.isActive).toBe(false);
    expect(manager.isSelectElementActive()).toBe(false);

    const refusal = await contentMessageHandler.handleActivateSelectElementMode({ data: {} });
    expect(refusal).toEqual({
      success: false,
      activated: true,
      error: 'Feature blocked on this page',
    });

    resolveCleanup();
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
  });

  it('keeps the refusal fail-closed when the cleanup failed', async () => {
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    const refusal = await contentMessageHandler.handleActivateSelectElementMode({ data: {} });
    expect(refusal.activated).toBe(true);
  });

  it('keeps an explicit negative confirmation when no manager exists', async () => {
    contentMessageHandler.setSelectElementManager(null);

    const refusal = await contentMessageHandler.handleActivateSelectElementMode({ data: {} });
    expect(refusal).toEqual({
      success: false,
      activated: false,
      error: 'Feature blocked on this page',
    });
  });

  it('does not release background cleanup ownership through the refusal', async () => {
    let notifyDeactivationDispatched;
    const deactivationDispatched = new Promise((resolve) => { notifyDeactivationDispatched = resolve; });
    routeToContentHandler(() => notifyDeactivationDispatched());

    const { deactivation, resolveCleanup } = startPausedDeactivation();
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });

    // The refusal keeps the frame's provisional cleanup ownership.
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([FRAME.frameId]);

    // The background deactivation cannot complete before the frame cleanup finishes:
    // the deactivation request is dispatched while the frame cleanup is still pending.
    let backgroundDeactivationSettled = false;
    const backgroundDeactivation = handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } })
      .then((result) => {
        backgroundDeactivationSettled = true;
        return result;
      });
    await deactivationDispatched;
    expect(backgroundDeactivationSettled).toBe(false);

    resolveCleanup();
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    await expect(backgroundDeactivation).resolves.toMatchObject({ success: true, active: false });
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);
    expect(isDeactivationPending(TAB_ID)).toBe(false);
  });
});

describe('failed cleanup keeps background cleanup ownership', () => {
  it('does not acknowledge a successful cleanup after a failed cleanup', async () => {
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    // The manager is inactive, but the cleanup was never confirmed.
    expect(manager.isActive).toBe(false);
    await expect(manager.deactivate({ fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });
  });

  it('keeps provisional ownership until the cleanup is genuinely resolved', async () => {
    routeToContentHandler();
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([FRAME.frameId]);

    // The cleanup fails: the background cannot confirm it and keeps ownership.
    const failed = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('Could not deactivate Select Element mode.');
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([FRAME.frameId]);
    expect(isDeactivationPending(TAB_ID)).toBe(true);

    // The retry confirms the cleanup, so ownership is released.
    manager.domTranslatorAdapter.cancelTranslation.mockResolvedValue(undefined);
    const recovered = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(recovered.success).toBe(true);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);
    expect(isDeactivationPending(TAB_ID)).toBe(false);
  });
});

describe('background recovery preserves cleanup ownership', () => {
  it('does not report success before an in-progress cleanup completes', async () => {
    let notifyDeactivationDispatched;
    const deactivationDispatched = new Promise((resolve) => { notifyDeactivationDispatched = resolve; });
    routeToContentHandler(() => notifyDeactivationDispatched());

    const { deactivation, resolveCleanup } = startPausedDeactivation();
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    // The background owns nothing: it has to recover the frame by reconciling it.
    let backgroundDeactivationSettled = false;
    const backgroundDeactivation = handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } })
      .then((result) => {
        backgroundDeactivationSettled = true;
        return result;
      });

    await deactivationDispatched;
    expect(backgroundDeactivationSettled).toBe(false);

    resolveCleanup();
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    await expect(backgroundDeactivation).resolves.toMatchObject({ success: true, active: false });
  });

  it('keeps ownership and requires a successful retry after a failed cleanup', async () => {
    routeToContentHandler();
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    // The cleanup failed: the frame is inactive but still owns cleanup.
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    const failed = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('Could not deactivate Select Element mode.');

    // The retry confirms the cleanup, so ownership can be released.
    manager.domTranslatorAdapter.cancelTranslation.mockResolvedValue(undefined);
    const recovered = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(recovered.success).toBe(true);
  });

  it('keeps the existing successful behavior for a genuinely inactive frame', async () => {
    routeToContentHandler();
    contentMessageHandler.setSelectElementManager(null);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation).toMatchObject({ success: true, active: false });
  });

  it('keeps frame-state queries read-only', async () => {
    routeToContentHandler();
    const { deactivation, resolveCleanup } = startPausedDeactivation();
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    const state = await contentMessageHandler.handleGetSelectElementFrameState();
    expect(state).toEqual({
      active: false,
      activationEpoch: null,
      activationGeneration: null,
      hasManager: true,
      cleanupUnconfirmed: true,
    });

    // The query did not mutate lifecycle state: the cleanup is still pending.
    expect(manager.isActive).toBe(false);
    expect(manager.isSelectElementCleanupUnconfirmed()).toBe(true);
    expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalledTimes(1);

    resolveCleanup();
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    expect(manager.isSelectElementCleanupUnconfirmed()).toBe(false);
  });
});

describe('activation cannot bypass an unconfirmed cleanup', () => {
  it('refuses activation while a previous cleanup is unconfirmed and keeps background ownership', async () => {
    routeToContentHandler();
    ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(true)) });
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    // The cleanup failed: the frame is inactive but still owns cleanup.
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    // A fresh activation (the background owns nothing after a restart) must not
    // start a new session on top of the outstanding cleanup.
    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(false);
    expect(manager.isActive).toBe(false);
    expect(manager.isSelectElementCleanupUnconfirmed()).toBe(true);

    // The refusal must not discharge the background's provisional ownership.
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([FRAME.frameId]);
  });

  it('permits activation once the outstanding cleanup is confirmed', async () => {
    routeToContentHandler();
    ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(true)) });
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValueOnce(new Error('cleanup exploded'));

    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    // The cleanup retry succeeds, so the activation may proceed.
    manager.domTranslatorAdapter.cancelTranslation.mockResolvedValue(undefined);

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);
    expect(manager.isActive).toBe(true);
    expect(manager.isSelectElementCleanupUnconfirmed()).toBe(false);
  });

  it('does not let a direct manager activation bypass the unconfirmed cleanup', async () => {
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    const activation = await manager.activateSelectElementMode();
    expect(activation).toMatchObject({ isActive: false, cleanupUnconfirmed: true });
    expect(manager.isActive).toBe(false);
    expect(manager.isSelectElementCleanupUnconfirmed()).toBe(true);
  });
});

describe('stale activation refusals keep cleanup ownership', () => {
  it('reports a stale epoch refusal as active while cleanup is unconfirmed', async () => {
    routeToContentHandler();
    ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(true)) });
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));

    // The cleanup failed: the frame is inactive but still owns cleanup.
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    // The frame learns the background's epoch, then a newer one retires it.
    await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(typeof contentMessageHandler.acceptedSelectElementEpoch).toBe('string');
    await contentMessageHandler.handleActivateSelectElementMode({ data: { activationEpoch: 'epoch-newer' } });
    expect(contentMessageHandler.acceptedSelectElementEpoch).toBe('epoch-newer');

    // The background lost its ownership, for example after a service worker restart.
    clearProvisionalCleanupFrames(TAB_ID);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);

    // The background activates again with the retired epoch: the request is stale.
    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(false);

    // The stale refusal must not discharge the background's provisional ownership.
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([FRAME.frameId]);
  });

  it('reports a stale generation refusal as active while cleanup is unconfirmed', async () => {
    routeToContentHandler();
    ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(true)) });

    // A first session establishes the accepted epoch and generation.
    await contentMessageHandler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-1', activationGeneration: 2 },
    });
    expect(contentMessageHandler.acceptedSelectElementGeneration).toBe(2);

    // The cleanup then fails: the frame owns an unconfirmed cleanup.
    manager.domTranslatorAdapter.cancelTranslation.mockRejectedValue(new Error('cleanup exploded'));
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: false, cleanupCompleted: false });

    const refusal = await contentMessageHandler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-1', activationGeneration: 1 },
    });
    expect(refusal).toMatchObject({ success: false, activated: true, staleGeneration: true });
  });

  it('keeps a normal inactive stale refusal unchanged', async () => {
    routeToContentHandler();
    ExclusionChecker.getInstance.mockReturnValue({ isFeatureAllowed: vi.fn(() => Promise.resolve(true)) });

    await contentMessageHandler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-1', activationGeneration: 2 },
    });

    // A confirmed cleanup leaves the frame inactive without outstanding cleanup.
    await expect(manager.deactivate({ reason: 'cancel', fromBackground: true }))
      .resolves.toMatchObject({ success: true, cleanupCompleted: true });

    const refusal = await contentMessageHandler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-1', activationGeneration: 1 },
    });
    expect(refusal).toMatchObject({ success: false, activated: false, staleGeneration: true });
  });
});

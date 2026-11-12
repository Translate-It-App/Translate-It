import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

const mocks = vi.hoisted(() => ({
  featureManagerInit: vi.fn().mockResolvedValue(undefined),
  onPolicyChanged: vi.fn(() => () => {}),
  settingsInit: vi.fn().mockResolvedValue(undefined),
  loadFeature: vi.fn().mockResolvedValue({}),
  checkUrlExclusionAsync: vi.fn().mockResolvedValue(false),
  sendMessage: vi.fn().mockResolvedValue({ success: true }),
  interactionInit: vi.fn().mockResolvedValue(undefined),
  getRelay: vi.fn(() => ({})),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      id: 'extension-id',
      getURL: vi.fn(() => 'moz-extension://extension-id/'),
      sendMessage: mocks.sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), init: vi.fn(), warn: vi.fn(), operation: vi.fn(),
  })),
}));
vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS: { CONTENT: 'content' } }));
vi.mock('@/core/tabPermissions.js', () => ({
  checkContentScriptAccess: () => ({ isAccessible: true }),
}));
vi.mock('@/core/extensionContext.js', () => ({ default: { isValidSync: () => true } }));
vi.mock('@/shared/error-management/windowErrorHandlers.js', () => ({
  setupWindowErrorHandlers: vi.fn(),
}));
vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  initializeContentScriptIntegration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT', BACKGROUND: 'BACKGROUND' },
  MessageFormat: {
    create: vi.fn((action, data, ctx) => ({ action, data, context: ctx })),
    createErrorResponse: vi.fn(),
  },
}));
vi.mock('@/shared/managers/SettingsManager.js', () => ({
  default: { initialize: mocks.settingsInit, warmup: vi.fn() },
}));
vi.mock('@/core/managers/content/FeatureManager.js', () => ({
  FeatureManager: {
    getInstance: () => ({
      initialized: true,
      initialize: mocks.featureManagerInit,
      onPolicyChanged: mocks.onPolicyChanged,
      checkForUrlChange: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock('./chunks/lazy-features.js', () => ({
  loadFeatureOnDemand: (...args) => mocks.loadFeature(...args),
}));
vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: mocks.checkUrlExclusionAsync,
}));
vi.mock('./InteractionCoordinator.js', () => ({
  interactionCoordinator: { initialize: mocks.interactionInit },
}));
vi.mock('@/features/windows/managers/crossframe/TextSelectionWindowRelay.js', () => ({
  getTextSelectionWindowRelay: mocks.getRelay,
}));

async function createCore(options) {
  const { IFrameContentScriptCore } = await import('./IFrameContentScriptCore.js');
  const core = new IFrameContentScriptCore(options);
  await core.initializeBase();
  return core;
}

describe('IFrameContentScriptCore tiny frame bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkUrlExclusionAsync.mockResolvedValue(false);
    mocks.loadFeature.mockResolvedValue({});
    mocks.featureManagerInit.mockResolvedValue(undefined);
    mocks.settingsInit.mockResolvedValue(undefined);
    delete window.selectElementManagerInstance;
    delete window.translateItContentScriptLoaded;
    delete window._translateItBootstrapPromise;
    window.translateItContentScriptInitializing = false;
    globalThis.browser = {
      runtime: { getURL: () => 'moz-extension://extension-id/', sendMessage: mocks.sendMessage },
    };
  });

  it('answers Select Element probes with a definitive inactive state', async () => {
    const core = await createCore({ tinyFrame: true });
    await expect(core.initializeCritical()).resolves.toBe(true);

    const getState = core.messageHandler.getHandlerForMessage(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE);
    const activate = core.messageHandler.getHandlerForMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE);
    const deactivate = core.messageHandler.getHandlerForMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE);

    expect(getState).toBeTruthy();
    expect(activate).toBeTruthy();
    expect(deactivate).toBeTruthy();

    await expect(getState({ action: MessageActions.GET_SELECT_ELEMENT_FRAME_STATE }, {})).resolves.toEqual({
      active: false,
      activationEpoch: null,
      activationGeneration: null,
      hasManager: false,
    });
    await expect(activate({ action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toEqual({
      success: false,
      activated: false,
      error: 'Select Element feature not available in this frame',
    });
    await expect(deactivate({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, data: {} }, {})).resolves.toEqual({
      success: true,
      cleanupCompleted: true,
      activated: false,
    });
  });

  it('initializes messaging but skips every heavy feature', async () => {
    const core = await createCore({ tinyFrame: true });
    await expect(core.initializeCritical()).resolves.toBe(true);

    expect(core.initialized).toBe(true);
    expect(core.messageHandler).toBeTruthy();
    expect(core._allowedRuntimeStarted).toBe(false);
    expect(mocks.settingsInit).not.toHaveBeenCalled();
    expect(mocks.featureManagerInit).not.toHaveBeenCalled();
    expect(mocks.onPolicyChanged).not.toHaveBeenCalled();
    expect(mocks.loadFeature).not.toHaveBeenCalled();
    expect(mocks.interactionInit).not.toHaveBeenCalled();
    expect(mocks.getRelay).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    // No SPA navigation feature bootstrap in a tiny frame.
    expect(core.messageHandler.getHandlerForMessage(MessageActions.SPA_NAVIGATION)).toBeNull();
  });

  it('keeps the normal frame runtime unchanged', async () => {
    const core = await createCore({ tinyFrame: false });
    await expect(core.initializeCritical()).resolves.toBe(true);

    expect(core.initialized).toBe(true);
    expect(core._allowedRuntimeStarted).toBe(true);
    expect(mocks.settingsInit).toHaveBeenCalled();
    expect(mocks.loadFeature).toHaveBeenCalledWith('contentMessageHandler');
    expect(core.messageHandler.getHandlerForMessage(MessageActions.SPA_NAVIGATION)).toBeTruthy();
    expect(mocks.sendMessage).toHaveBeenCalledWith({ action: MessageActions.SELECT_ELEMENT_FRAME_READY, data: {} });
  });
});

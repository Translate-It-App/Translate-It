import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ENVIRONMENTS } from '@/core/contextCore.js';

let useSelectElementTranslation;
let useSidepanelActions;

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendMessageViaMessaging: vi.fn(),
  createMessage: vi.fn((action) => ({ action })),
  handlers: new Map(),
  messageListeners: new Set(),
  activatedListeners: new Set(),
  environment: 'sidepanel',
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: {
        addListener: vi.fn((listener) => mocks.messageListeners.add(listener)),
        removeListener: vi.fn((listener) => mocks.messageListeners.delete(listener)),
      },
    },
    tabs: {
      onActivated: {
        addListener: vi.fn((listener) => mocks.activatedListeners.add(listener)),
        removeListener: vi.fn((listener) => mocks.activatedListeners.delete(listener)),
      },
      query: vi.fn().mockResolvedValue([{ id: 1, windowId: 10 }]),
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@/core/contextCore.js', () => ({
  ENVIRONMENTS: {
    CONTENT: 'content',
    POPUP: 'popup',
    SIDEPANEL: 'sidepanel',
  },
  getActiveEnvironment: () => mocks.environment,
}));

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: vi.fn(() => ({ sendMessage: mocks.sendMessageViaMessaging, createMessage: mocks.createMessage })),
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: (...args) => mocks.sendMessage(...args),
}));

vi.mock('@/shared/messaging/core/MessageHandler.js', () => ({
  createMessageHandler: vi.fn(() => ({
    registerHandler: (action, handler) => mocks.handlers.set(action, handler),
    unregisterHandler: (action) => mocks.handlers.delete(action),
    listen: () => {
      const listener = (message, sender, sendResponse) => {
        const handler = mocks.handlers.get(message?.action);
        return handler ? handler(message, sender, sendResponse) : false;
      };
      mocks.messageListeners.add(listener);
    },
    stopListening: () => mocks.messageListeners.clear(),
    get isListenerActive() { return mocks.messageListeners.size > 0; },
  })),
}));

vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({ matchErrorToType: vi.fn(() => 'UNKNOWN') }));
vi.mock('@/shared/error-management/ErrorTypes.js', () => ({ ErrorTypes: {} }));
vi.mock('@/features/element-selection/utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

const mountedApps = new Set();
let originalTabs;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function withSetup(composable) {
  let result;
  const app = createApp({ setup() { result = composable(); return () => {}; } });
  app.mount(document.createElement('div'));
  mountedApps.add(app);
  return [result, app];
}

function broadcast(tabId, active, windowId = 10) {
  const message = { action: MessageActions.SELECT_ELEMENT_STATE_CHANGED, data: { tabId, active, windowId } };
  for (const listener of mocks.messageListeners) listener(message, {}, vi.fn());
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useTranslationModes', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ useSelectElementTranslation, useSidepanelActions } = await import('./useTranslationModes.js'));
    mocks.environment = ENVIRONMENTS.SIDEPANEL;
    mocks.sendMessage.mockReset();
    mocks.sendMessageViaMessaging.mockReset();
    mocks.createMessage.mockClear();
    mocks.handlers.clear();
    mocks.messageListeners.clear();
    mocks.activatedListeners.clear();
    browser.tabs.query.mockReset().mockResolvedValue([{ id: 1, windowId: 10 }]);
    originalTabs = browser.tabs;
    browser.runtime.onMessage.addListener.mockClear();
    browser.runtime.onMessage.removeListener.mockClear();
    browser.tabs.onActivated.addListener.mockClear();
    browser.tabs.onActivated.removeListener.mockClear();
  });

  afterEach(() => {
    browser.tabs = originalTabs;
    for (const app of mountedApps) app.unmount();
    mountedApps.clear();
    mocks.handlers.clear();
    mocks.messageListeners.clear();
    mocks.activatedListeners.clear();
    vi.clearAllMocks();
  });

  it('does not access Tabs APIs or register listeners in Content Scripts with multiple subscribers', async () => {
    mocks.environment = ENVIRONMENTS.CONTENT;
    mocks.sendMessage.mockResolvedValue({ success: true });
    const original = browser.tabs;
    const query = vi.spyOn(original, 'query');
    browser.tabs = undefined;
    try {
      const [first, firstApp] = withSetup(useSelectElementTranslation);
      const [second, secondApp] = withSetup(useSelectElementTranslation);
      await flushMicrotasks();

      expect(await first.deactivateSelectMode()).toBe(true);
      expect(first.isSelectModeActive).toBe(second.isSelectModeActive);
      expect(query).not.toHaveBeenCalled();
      expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
        data: { active: false },
      }));
      expect(mocks.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.GET_SELECT_ELEMENT_STATE,
      }));
      expect(mocks.activatedListeners.size).toBe(0);
      expect(mocks.messageListeners.size).toBe(0);
      expect(mocks.handlers.has(MessageActions.SELECT_ELEMENT_STATE_CHANGED)).toBe(false);

      firstApp.unmount();
      secondApp.unmount();
      mountedApps.delete(firstApp);
      mountedApps.delete(secondApp);
      expect(mocks.activatedListeners.size).toBe(0);
      expect(mocks.messageListeners.size).toBe(0);
    } finally {
      browser.tabs = original;
    }
  });

  it.each([ENVIRONMENTS.POPUP, ENVIRONMENTS.SIDEPANEL])('%s keeps startup, broadcast, activation, and cleanup behavior', async (environment) => {
    mocks.environment = environment;
    mocks.sendMessage.mockImplementation(({ data }) => ({
      success: true,
      active: data?.tabId === 2,
      tabId: data?.tabId,
    }));
    const [composable, app] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();

    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    expect(mocks.messageListeners.size).toBe(1);
    expect(mocks.activatedListeners.size).toBe(1);
    broadcast(1, true);
    expect(composable.isSelectModeActive.value).toBe(true);

    const [onActivated] = mocks.activatedListeners;
    await onActivated({ tabId: 2, windowId: 10 });
    expect(composable.isSelectModeActive.value).toBe(true);
    expect(await composable.deactivateSelectMode()).toBe(true);
    expect(browser.tabs.query).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
      data: { active: false, tabId: 1 },
    }));

    app.unmount();
    mountedApps.delete(app);
    expect(mocks.messageListeners.size).toBe(0);
    expect(mocks.activatedListeners.size).toBe(0);
  });

  it('ignores a stale deferred Popup state response after a newer broadcast', async () => {
    mocks.environment = ENVIRONMENTS.POPUP;
    const initial = deferred();
    mocks.sendMessage.mockReturnValue(initial.promise);
    const [composable, app] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();

    broadcast(1, true);
    initial.resolve({ success: true, active: false, tabId: 1 });
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(true);
    app.unmount();
    mountedApps.delete(app);
    expect(mocks.activatedListeners.size).toBe(0);
  });

  it('keeps a broadcast received during initial GET instead of replacing it with stale state', async () => {
    const initial = deferred();
    mocks.sendMessage.mockReturnValue(initial.promise);
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    expect(composable.isSelectModeActive.value).toBe(false);
    broadcast(1, true);
    initial.resolve({ success: true, active: false, tabId: 1 });
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('keeps a broadcast received while initial tab ownership is unresolved', async () => {
    const activeTab = deferred();
    const initialGet = deferred();
    mocks.sendMessage.mockReturnValue(initialGet.promise);
    browser.tabs.query.mockReturnValue(activeTab.promise);
    const [composable] = withSetup(useSelectElementTranslation);

    broadcast(1, true);
    activeTab.resolve([{ id: 1, windowId: 10 }]);
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    initialGet.resolve({ success: true, active: true, tabId: 1 });
    await flushMicrotasks();
    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('does not let an old initial GET overwrite a newer broadcast', async () => {
    const initial = deferred();
    mocks.sendMessage.mockReturnValue(initial.promise);
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ data: { tabId: 1 } }));

    broadcast(1, true);
    initial.resolve({ success: true, active: false, tabId: 1 });
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('associates reversed tab activation GET completions with their requested tab', async () => {
    const first = deferred();
    const second = deferred();
    mocks.sendMessage.mockImplementation(({ action, data }) => {
      if (action === MessageActions.GET_SELECT_ELEMENT_STATE && data?.tabId === 1) {
        return Promise.resolve({ success: true, active: false, tabId: 1 });
      }
      if (data?.tabId === 2) return first.promise;
      if (data?.tabId === 3) return second.promise;
      throw new Error(`Unexpected request: ${action}`);
    });
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    mocks.sendMessage.mockClear();
    const [onActivated] = mocks.activatedListeners;

    const firstRefresh = onActivated({ tabId: 2, windowId: 10 });
    const secondRefresh = onActivated({ tabId: 3, windowId: 10 });
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: expect.objectContaining({ tabId: 2 }),
    }));
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: expect.objectContaining({ tabId: 3 }),
    }));

    second.resolve({ success: true, active: true, tabId: 3 });
    await secondRefresh;
    first.resolve({ success: true, active: false, tabId: 2 });
    await firstRefresh;

    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('rejects a successful state response for a different tab than the current tab', async () => {
    const tabTwoGet = deferred();
    mocks.sendMessage.mockImplementation(({ action, data }) => {
      if (action !== MessageActions.GET_SELECT_ELEMENT_STATE) throw new Error(`Unexpected request: ${action}`);
      if (data?.tabId === 1) return Promise.resolve({ success: true, active: false, tabId: 1 });
      if (data?.tabId === 2) return tabTwoGet.promise;
      throw new Error(`Unexpected tab: ${data?.tabId}`);
    });
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    const [onActivated] = mocks.activatedListeners;

    const refresh = onActivated({ tabId: 2, windowId: 10 });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 2 },
    }));
    tabTwoGet.resolve({ success: true, active: true, tabId: 3 });
    await refresh;

    expect(composable.isSelectModeActive.value).toBe(false);
  });

  it('does not let an initial-tab GET overwrite state after switching tabs', async () => {
    const tabOneGet = deferred();
    const tabTwoGet = deferred();
    mocks.sendMessage.mockImplementation(({ action, data }) => {
      if (action !== MessageActions.GET_SELECT_ELEMENT_STATE) throw new Error(`Unexpected request: ${action}`);
      if (data?.tabId === 1) return tabOneGet.promise;
      if (data?.tabId === 2) return tabTwoGet.promise;
      throw new Error(`Unexpected tab: ${data?.tabId}`);
    });
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    const [onActivated] = mocks.activatedListeners;

    const tabTwoRefresh = onActivated({ tabId: 2, windowId: 10 });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 2 },
    }));
    tabTwoGet.resolve({ success: true, active: true, tabId: 2 });
    await tabTwoRefresh;
    tabOneGet.resolve({ success: true, active: false, tabId: 1 });
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('ignores activation events from another window', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true, active: false, tabId: 1 });
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    mocks.sendMessage.mockClear();
    const [onActivated] = mocks.activatedListeners;

    await onActivated({ tabId: 7, windowId: 20 });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(composable.isSelectModeActive.value).toBe(false);
  });

  it('does not register late after unmount while initial GET is pending and removes listeners', async () => {
    const initial = deferred();
    mocks.sendMessage.mockReturnValue(initial.promise);
    const [, app] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    app.unmount();
    mountedApps.delete(app);

    initial.resolve({ success: true, active: true, tabId: 1 });
    await flushMicrotasks();

    expect(mocks.handlers.has(MessageActions.SELECT_ELEMENT_STATE_CHANGED)).toBe(false);
    expect(mocks.messageListeners.size).toBe(0);
    expect(mocks.activatedListeners.size).toBe(0);
  });

  it('ignores a stale initial GET after remount and keeps the remounted listener active', async () => {
    const oldGet = deferred();
    mocks.sendMessage
      .mockReturnValueOnce(oldGet.promise)
      .mockResolvedValue({ success: true, active: false, tabId: 1 });
    const [, oldApp] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    oldApp.unmount();
    mountedApps.delete(oldApp);

    const [remounted] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    broadcast(1, true);
    oldGet.resolve({ success: true, active: false, tabId: 1 });
    await flushMicrotasks();

    expect(remounted.isSelectModeActive.value).toBe(true);
    expect(mocks.messageListeners.size).toBe(1);
  });

  it('ignores cross-window broadcasts while initial tab ownership is unresolved', async () => {
    const activeTab = deferred();
    mocks.sendMessage.mockResolvedValue({ success: true, active: false, tabId: 1 });
    browser.tabs.query.mockReturnValue(activeTab.promise);
    const [composable] = withSetup(useSelectElementTranslation);

    broadcast(1, true, 20);
    activeTab.resolve([{ id: 1, windowId: 10 }]);
    await flushMicrotasks();

    expect(composable.isSelectModeActive.value).toBe(false);
  });

  it('uses a buffered same-window tab activation when initial ownership resolves', async () => {
    const activeTab = deferred();
    const tabTwoGet = deferred();
    browser.tabs.query.mockReturnValue(activeTab.promise);
    mocks.sendMessage.mockImplementation(({ action, data }) => {
      if (action === MessageActions.GET_SELECT_ELEMENT_STATE && data?.tabId === 2) return tabTwoGet.promise;
      throw new Error(`Unexpected request for tab ${data?.tabId}`);
    });
    const [composable] = withSetup(useSelectElementTranslation);
    const [onActivated] = mocks.activatedListeners;

    await onActivated({ tabId: 7, windowId: 20 });
    await onActivated({ tabId: 2, windowId: 10 });
    activeTab.resolve([{ id: 1, windowId: 10 }]);
    await flushMicrotasks();

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 2 },
    }));
    tabTwoGet.resolve({ success: true, active: true, tabId: 2 });
    await flushMicrotasks();
    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('shares one active listener across subscribers and removes it at the final unmount', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true, active: false, tabId: 1 });
    const [first, firstApp] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();

    expect(mocks.messageListeners.size).toBe(1);
    expect(mocks.activatedListeners.size).toBe(1);
    broadcast(1, true);
    expect(first.isSelectModeActive.value).toBe(true);

    const [second, secondApp] = withSetup(useSelectElementTranslation);
    expect(second.isSelectModeActive.value).toBe(true);
    expect(mocks.messageListeners.size).toBe(1);

    firstApp.unmount();
    mountedApps.delete(firstApp);
    expect(first.isSelectModeActive.value).toBe(true);
    expect(second.isSelectModeActive.value).toBe(true);
    expect(mocks.messageListeners.size).toBe(1);
    secondApp.unmount();
    mountedApps.delete(secondApp);
    expect(first.isSelectModeActive.value).toBe(false);
    expect(mocks.messageListeners.size).toBe(0);
    expect(mocks.activatedListeners.size).toBe(0);
  });

  it('resets shared state on final unmount and remounts through deferred tab lookup and GET', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true, active: true, tabId: 1 });
    const [first, firstApp] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    expect(first.isSelectModeActive.value).toBe(true);

    firstApp.unmount();
    mountedApps.delete(firstApp);
    expect(first.isSelectModeActive.value).toBe(false);

    const activeTab = deferred();
    const initialGet = deferred();
    browser.tabs.query.mockReturnValue(activeTab.promise);
    mocks.sendMessage.mockReturnValue(initialGet.promise);
    const [remounted, remountedApp] = withSetup(useSelectElementTranslation);
    expect(remounted.isSelectModeActive.value).toBe(false);

    activeTab.resolve([{ id: 1, windowId: 10 }]);
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.GET_SELECT_ELEMENT_STATE,
      data: { tabId: 1 },
    }));
    expect(remounted.isSelectModeActive.value).toBe(false);

    initialGet.resolve({ success: true, active: true, tabId: 1 });
    await flushMicrotasks();
    expect(remounted.isSelectModeActive.value).toBe(true);

    remountedApp.unmount();
    mountedApps.delete(remountedApp);
  });

  it('does not roll back an authoritative broadcast when the popup toggle request fails', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true, active: false, tabId: 1 });
    const [composable] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    const request = deferred();
    mocks.sendMessage.mockClear();
    mocks.sendMessage.mockReturnValue(request.promise);

    const toggle = composable.toggleSelectElement();
    broadcast(1, true);
    request.resolve({ success: false, message: 'failed' });
    await toggle;

    expect(composable.isSelectModeActive.value).toBe(true);
  });

  it('serializes overlapping toggles without conflicting duplicate requests and cleans up', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true, active: false, tabId: 1 });
    const [composable, app] = withSetup(useSelectElementTranslation);
    await flushMicrotasks();
    mocks.sendMessage.mockClear();
    const request = deferred();
    mocks.sendMessage.mockReturnValue(request.promise);

    const firstToggle = composable.toggleSelectElement();
    const secondToggle = composable.toggleSelectElement();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(composable.isSelectModeActive.value).toBe(true);

    request.resolve({ success: true, active: true, tabId: 1 });
    await Promise.all([firstToggle, secondToggle]);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    app.unmount();
    mountedApps.delete(app);
    expect(mocks.messageListeners.size).toBe(0);
    expect(mocks.activatedListeners.size).toBe(0);
  });

  it('preserves activate, deactivate, and Revert behavior', async () => {
    const [composable] = withSetup(useSelectElementTranslation);
    mocks.sendMessage.mockResolvedValue({ success: true });
    expect(await composable.activateSelectMode({ provider: 'google' })).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
      data: expect.objectContaining({ provider: 'google' }),
    }));

    browser.tabs.query.mockResolvedValueOnce([{ id: 42, windowId: 10 }]);
    expect(await composable.deactivateSelectMode()).toBe(true);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
      data: { active: false, tabId: 42 },
    }));

    mocks.sendMessageViaMessaging.mockResolvedValue({ success: true, revertedCount: 5 });
    const [actions] = withSetup(useSidepanelActions);
    expect(await actions.revertTranslation()).toBe(true);
    expect(mocks.sendMessageViaMessaging).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.REVERT_SELECT_ELEMENT_MODE,
    }), { returnFailureResponse: true });
  });

  it('reports full Revert success only for non-partial responses and treats restricted failures neutrally', async () => {
    const [actions] = withSetup(useSidepanelActions);

    mocks.sendMessageViaMessaging.mockResolvedValueOnce({ success: true, revertedCount: 0 });
    expect(await actions.revertTranslation()).toBe(true);
    expect(mocks.sendMessageViaMessaging).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: MessageActions.REVERT_SELECT_ELEMENT_MODE }),
      { returnFailureResponse: true }
    );

    mocks.sendMessageViaMessaging.mockResolvedValueOnce({
      success: true,
      partial: true,
      revertedCount: 2,
      message: 'Translation partially reverted',
      errors: [{ system: 'vue', error: 'boom' }]
    });
    expect(await actions.revertTranslation()).toBe(false);
    expect(actions.error.value).toContain('Partial Revert');
    expect(actions.error.value).toContain('vue: boom');
    expect(actions.error.value).not.toContain('[object Object]');

    actions.error.value = null;
    mocks.sendMessageViaMessaging.mockResolvedValueOnce({ success: false, isRestrictedPage: true });
    expect(await actions.revertTranslation()).toBe(null);
    expect(actions.error.value).toBe(null);

    mocks.sendMessageViaMessaging.mockRejectedValueOnce(Object.assign(new Error('restricted'), {
      isRestrictedPage: true
    }));
    expect(await actions.revertTranslation()).toBe(null);
    expect(actions.error.value).toBe(null);
  });

  it('keeps the stop TTS action', async () => {
    const [actions] = withSetup(useSidepanelActions);
    mocks.sendMessage.mockResolvedValue({ success: true });

    await actions.stopTTS();

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.TTS_STOP,
    }));
  });

  it('reports a graceful activation failure from the background', async () => {
    const [composable] = withSetup(useSelectElementTranslation);
    mocks.sendMessage.mockResolvedValue({ success: false, message: 'Restricted page' });

    expect(await composable.activateSelectMode()).toBe(false);
    expect(composable.error.value).toBe('Restricted page');
  });

  it('uses a safe fallback for a technical activation error', async () => {
    const [composable] = withSetup(useSelectElementTranslation);
    mocks.sendMessage.mockRejectedValue(new Error('chrome.runtime.lastError: INTERNAL_PORT_9f81'));

    expect(await composable.activateSelectMode()).toBe(false);
    expect(composable.error.value).toBe('Could not activate Select Element mode.');
    expect(composable.error.value).not.toContain('INTERNAL_PORT_9f81');
    expect(composable.error.value).not.toContain('chrome.runtime.lastError');
  });
});

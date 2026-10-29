import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const menuState = new Map();
  const createEvent = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const browser = {
    contextMenus: {
      removeAll: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
      create: vi.fn((menu, callback) => {
        callback?.();
        return menu.id;
      }),
      update: vi.fn().mockResolvedValue(undefined)
    },
    commands: {
      getAll: vi.fn().mockResolvedValue([]),
      openShortcutSettings: vi.fn().mockResolvedValue(undefined)
    },
    runtime: {
      sendMessage: vi.fn(),
      getURL: vi.fn((path) => path),
      onMessage: createEvent(),
      getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Chrome' })
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onActivated: createEvent(),
      onUpdated: createEvent(),
      onRemoved: createEvent()
    },
    windows: { onFocusChanged: createEvent() }
  };

  return {
    browser,
    menuState,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    storageManager: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(true)
    },
    providerRegistry: {
      getAllAvailable: vi.fn()
    },
    getEffectiveProviderAsync: vi.fn().mockResolvedValue('googlev2'),
    handlePageTranslation: vi.fn().mockResolvedValue({ success: true }),
    getDebugModeAsync: vi.fn().mockResolvedValue(false),
    getTranslationString: vi.fn((key) => key),
    tabPermissionChecker: {
      checkTabAccess: vi.fn().mockResolvedValue({ isAccessible: true })
    },
    utilsFactory: {
      getI18nUtils: vi.fn()
    }
  };
});

vi.mock('webextension-polyfill', () => ({
  default: mocks.browser
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: mocks.storageManager
}));

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    TRANSLATION_API: 'googlev2',
    CONTEXT_MENU_VISIBILITY: {
      PAGE_CONTEXT_PAGE_TRANSLATION: true,
      PAGE_CONTEXT_SELECT_ELEMENT: true,
      PAGE_CONTEXT_PDF_TRANSLATOR: true,
      ACTION_CONTEXT_SELECT_ELEMENT: true,
      PAGE_CONTEXT_SCREEN_CAPTURE: true,
      ACTION_CONTEXT_SCREEN_CAPTURE: true,
      ACTION_CONTEXT_PDF_TRANSLATOR: true,
      ACTION_CONTEXT_SUBTITLE_TRANSLATOR: true,
      ACTION_CONTEXT_OPTIONS: true,
      ACTION_CONTEXT_SHORTCUTS: true,
      ACTION_CONTEXT_HELP: true
    }
  },
  TranslationMode: { Select_Element: 'select-element', Page: 'page-translation-batch' },
  getDebugModeAsync: mocks.getDebugModeAsync,
  getTargetLanguageAsync: vi.fn().mockResolvedValue('en'),
  getEffectiveProviderAsync: mocks.getEffectiveProviderAsync
}));

vi.mock('@/features/translation/providers/ProviderRegistry.js', () => ({
  providerRegistry: mocks.providerRegistry
}));

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: mocks.utilsFactory
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => mocks.logger
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    cleanup() {}
  }
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn()
  }
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: mocks.tabPermissionChecker
}));

vi.mock('@/core/ExtensionAppLauncher.js', () => ({
  openExtensionApp: vi.fn()
}));

vi.mock('@/core/background/handlers/lazy/handleElementSelectionLazy.js', () => ({
  handleActivateSelectElementModeLazy: vi.fn()
}));

vi.mock('@/core/background/handlers/page-translation/handlePageTranslation.js', () => ({
  handlePageTranslation: mocks.handlePageTranslation
}));

import { ContextMenuManager } from './context-menu.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

const CONTEXT_MENU_SETTING_KEYS = [
  'EXTENSION_ENABLED',
  'TRANSLATE_WITH_SELECT_ELEMENT',
  'WHOLE_PAGE_TRANSLATION_ENABLED',
  'ENABLE_SCREEN_CAPTURE',
  'CONTEXT_MENU_VISIBILITY',
  'TRANSLATION_API',
  'MODE_PROVIDERS',
  'DEBUG_MODE',
  'HIDDEN_PROVIDERS',
  'DEEPL_API_KEY',
  'LINGVA_API_URL',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'CHEAPERINFERENCE_API_KEY',
  'DEEPSEEK_API_KEY',
  'CUSTOM_API_URL',
  'CUSTOM_API_MODEL',
  'WEBAI_API_URL',
  'WEBAI_API_MODEL'
];

const CONTEXT_MENU_VISIBILITY = {
  PAGE_CONTEXT_PAGE_TRANSLATION: true,
  PAGE_CONTEXT_SELECT_ELEMENT: true,
  PAGE_CONTEXT_PDF_TRANSLATOR: true,
  ACTION_CONTEXT_SELECT_ELEMENT: true,
  PAGE_CONTEXT_SCREEN_CAPTURE: true,
  ACTION_CONTEXT_SCREEN_CAPTURE: true,
  ACTION_CONTEXT_PDF_TRANSLATOR: true,
  ACTION_CONTEXT_SUBTITLE_TRANSLATOR: true,
  ACTION_CONTEXT_OPTIONS: true,
  ACTION_CONTEXT_SHORTCUTS: true,
  ACTION_CONTEXT_HELP: true
};

const API_PROVIDER_PARENT_ID = 'api-provider-parent';
const TRANSLATORS_PARENT_ID = 'translators-parent';
const SETTINGS_PARENT_ID = 'settings-parent';

const createSettings = (overrides = {}) => ({
  EXTENSION_ENABLED: true,
  TRANSLATE_WITH_SELECT_ELEMENT: true,
  WHOLE_PAGE_TRANSLATION_ENABLED: true,
  ENABLE_SCREEN_CAPTURE: true,
  CONTEXT_MENU_VISIBILITY: { ...CONTEXT_MENU_VISIBILITY },
  TRANSLATION_API: 'googlev2',
  MODE_PROVIDERS: {},
  DEBUG_MODE: false,
  HIDDEN_PROVIDERS: [],
  OPENAI_API_KEY: 'configured-key',
  ...overrides
});

const getCreatedMenuIds = () => mocks.browser.contextMenus.create.mock.calls
  .map(([menu]) => menu.id);

const getCreatedMenus = () => mocks.browser.contextMenus.create.mock.calls
  .map(([menu]) => menu);

const getCreatedMenu = (id) => getCreatedMenus().find(menu => menu.id === id);

const getActionMenus = () => getCreatedMenus()
  .filter(menu => menu.contexts?.includes('action'));

const getVisiblePageCommands = () => ['translate-page', 'restore-page']
  .filter(id => mocks.menuState.has(id) && mocks.menuState.get(id).visible !== false);

const inactivePageStatus = () => ({
  success: true,
  isTranslating: false,
  isTranslated: false,
  isAutoTranslating: false,
  translatedCount: 0
});

const unsupportedPageProviders = [
  ['mode-specific', { MODE_PROVIDERS: { 'page-translation-batch': 'vajehyab' } }],
  ['global', { TRANSLATION_API: 'vajehyab' }]
];

const useRealProviderResolution = async (readSettings) => {
  const config = await vi.importActual('@/shared/config/config.js');
  mocks.storageManager.get.mockImplementation(async (keys) => {
    const settings = readSettings();
    const defaults = Array.isArray(keys) ? {} : keys;
    const requestedKeys = Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(requestedKeys.map(key => [
      key,
      Object.hasOwn(settings, key) ? settings[key] : defaults[key]
    ]));
  });
  mocks.getEffectiveProviderAsync.mockImplementation(config.getEffectiveProviderAsync);
  return config;
};

describe('ContextMenuManager keyed storage reads', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.menuState.clear();
    delete globalThis.backgroundService;
    delete mocks.browser.menus;
    mocks.browser.tabs.query.mockResolvedValue([]);
    mocks.browser.contextMenus.removeAll.mockImplementation(async () => { mocks.menuState.clear(); });
    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      mocks.menuState.set(menu.id, { ...menu });
      callback?.();
      return menu.id;
    });
    mocks.browser.contextMenus.update.mockImplementation(async (id, changes) => {
      Object.assign(mocks.menuState.get(id), changes);
    });
    mocks.browser.commands.openShortcutSettings.mockResolvedValue(undefined);
    mocks.browser.runtime.getBrowserInfo.mockResolvedValue({ name: 'Chrome' });
    mocks.getTranslationString.mockImplementation((key) => key);
    mocks.utilsFactory.getI18nUtils.mockResolvedValue({
      getTranslationString: mocks.getTranslationString
    });
    mocks.providerRegistry.getAllAvailable.mockReturnValue([
      { id: 'googlev2', name: 'Google Translate', isLazy: true, category: 'free' },
      { id: 'openai', name: 'OpenAI', isLazy: true, category: 'ai' },
      { id: 'gemini', name: 'Google Gemini', isLazy: true, category: 'ai' }
    ]);
    mocks.getEffectiveProviderAsync.mockResolvedValue('googlev2');
    mocks.handlePageTranslation.mockResolvedValue({ success: true });
    mocks.storageManager.get.mockResolvedValue(createSettings());

    manager = new ContextMenuManager();
    manager.browser = mocks.browser;
  });

  it('requests exact context-menu settings with a fresh read', async () => {
    await manager._setupMenusInternal();

    expect(mocks.storageManager.get).toHaveBeenCalledOnce();
    expect(mocks.storageManager.get).toHaveBeenCalledWith(CONTEXT_MENU_SETTING_KEYS, false);
    expect(mocks.storageManager.get).not.toHaveBeenCalledWith(null, false);
  });

  it('excludes unrelated sensitive and storage keys from the request', async () => {
    await manager._setupMenusInternal();

    const requestedKeys = mocks.storageManager.get.mock.calls[0][0];

    expect(requestedKeys).not.toContain('PROXY_USERNAME');
    expect(requestedKeys).not.toContain('PROXY_PASSWORD');
    expect(requestedKeys).not.toContain('translationHistory');
    expect(requestedKeys).toEqual(CONTEXT_MENU_SETTING_KEYS);
  });

  it('preserves disabled-extension and provider filtering behavior', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      EXTENSION_ENABLED: false,
      HIDDEN_PROVIDERS: ['openai']
    }));

    await manager._setupMenusInternal();

    const menuIds = getCreatedMenuIds();
    expect(menuIds).not.toContain('translate-with-select-element');
    expect(menuIds).not.toContain('screen-capture-page');
    expect(menuIds).not.toContain('translate-page');
    expect(menuIds).not.toContain('restore-page');
    expect(menuIds).toContain('api-provider-googlev2');
    expect(menuIds).not.toContain('api-provider-openai');
    expect(menuIds).not.toContain('api-provider-gemini');
  });

  it('preserves context-menu visibility settings', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        PAGE_CONTEXT_SELECT_ELEMENT: false,
        ACTION_CONTEXT_SELECT_ELEMENT: false,
        PAGE_CONTEXT_SCREEN_CAPTURE: false,
        ACTION_CONTEXT_SCREEN_CAPTURE: false
      }
    }));

    await manager._setupMenusInternal();

    const menuIds = getCreatedMenuIds();
    expect(menuIds).not.toContain('translate-with-select-element');
    expect(menuIds).not.toContain('action-translate-element');
    expect(menuIds).not.toContain('screen-capture-page');
    expect(menuIds).not.toContain('screen-capture-action');
  });

  it('initially shows only the localized translate command for all supported page contexts', async () => {
    await manager._setupMenusInternal('ja');

    expect(getCreatedMenu('translate-page')).toEqual({
      id: 'translate-page',
      title: 'context_menu_translate_page',
      contexts: ['page', 'selection', 'link', 'image', 'video', 'audio'],
      visible: true
    });
    expect(getCreatedMenu('restore-page')).toEqual({
      id: 'restore-page',
      title: 'context_menu_restore_page',
      contexts: ['page', 'selection', 'link', 'image', 'video', 'audio'],
      visible: false
    });
    expect(mocks.getTranslationString).toHaveBeenCalledWith('context_menu_translate_page', 'ja');
    expect(mocks.getTranslationString).toHaveBeenCalledWith('context_menu_restore_page', 'ja');
    expect(getVisiblePageCommands()).toEqual(['translate-page']);
    expect(getCreatedMenus()
      .filter(menu => menu.contexts?.some(context => ['page', 'selection', 'link', 'image', 'video', 'audio'].includes(context)))
      .map(menu => menu.id)).toEqual([
      'translate-with-select-element',
      'open-pdf-with-link',
      'screen-capture-page',
      'translate-page',
      'restore-page'
    ]);
  });

  it.each([
    ['translation in progress', { isTranslating: true }],
    ['translated page', { isTranslated: true }],
    ['auto-translation waiting for new content', { isAutoTranslating: true }],
    ['partial translation after an error', { translatedCount: 3 }]
  ])('recovers %s on initialization and shows only restore', async (_name, state) => {
    const tab = { id: 42 };
    mocks.browser.tabs.query.mockResolvedValue([tab]);
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), ...state });

    await manager.initialize();

    expect(mocks.handlePageTranslation).toHaveBeenCalledWith(
      { action: MessageActions.PAGE_TRANSLATE_GET_STATUS, context: 'context-menu' },
      { tab }
    );
    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it('follows translation and restore from other controls without consuming their messages', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
    const sender = { tab: { id: 42 }, frameId: 0 };

    expect(listener({
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { isAggregated: true, isTranslating: true }
    }, sender)).toBe(false);
    await manager._pageMenuUpdatePromise;
    expect(getVisiblePageCommands()).toEqual(['restore-page']);

    listener({
      action: MessageActions.PAGE_RESTORE_COMPLETE,
      data: { ...inactivePageStatus(), isAggregated: true }
    }, sender);
    await manager._pageMenuUpdatePromise;
    expect(getVisiblePageCommands()).toEqual(['translate-page']);
  });

  it.each([
    ['child frame', { tab: { id: 42 }, frameId: 7 }, { isAggregated: true }],
    ['frame-local event', { tab: { id: 42 }, frameId: 0 }, { isAggregated: false }],
    ['extension UI without a tab', {}, { isAggregated: true }]
  ])('ignores %s instead of treating it as whole-tab state', async (_name, sender, data) => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
    mocks.browser.contextMenus.update.mockClear();

    expect(listener({
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { ...data, isTranslated: true, translatedCount: 2 }
    }, sender)).toBe(false);
    await manager._pageMenuUpdatePromise;

    expect(mocks.browser.contextMenus.update).not.toHaveBeenCalled();
    expect(getVisiblePageCommands()).toEqual(['translate-page']);
  });

  it('keeps partial translations restorable and returns to translate after an all-failed attempt', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
    const sender = { tab: { id: 42 }, frameId: 0 };

    listener({
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { ...inactivePageStatus(), isAggregated: true, translatedCount: 2, failedCount: 1 }
    }, sender);
    await manager._pageMenuUpdatePromise;
    expect(getVisiblePageCommands()).toEqual(['restore-page']);

    listener({
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { ...inactivePageStatus(), isAggregated: true, failedCount: 3 }
    }, sender);
    await manager._pageMenuUpdatePromise;
    expect(getVisiblePageCommands()).toEqual(['translate-page']);
  });

  it('keeps stopped auto-translation restorable while translated nodes remain', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];

    listener({
      action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { ...inactivePageStatus(), isAggregated: true, translatedCount: 4 }
    }, { tab: { id: 42 }, frameId: 0 });
    await manager._pageMenuUpdatePromise;

    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it('caches background-tab events without changing the focused tab menu', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];

    listener({
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { isAggregated: true, isTranslated: true, translatedCount: 2 }
    }, { tab: { id: 43 }, frameId: 0 });
    await manager._pageMenuUpdatePromise;
    expect(getVisiblePageCommands()).toEqual(['translate-page']);

    mocks.browser.tabs.query.mockResolvedValue([{ id: 43 }]);
    mocks.handlePageTranslation.mockResolvedValue({ success: false, reason: 'frame_command_response_timeout' });
    const activate = mocks.browser.tabs.onActivated.addListener.mock.calls[0][0];
    activate({ tabId: 43, windowId: 1 });
    await vi.waitFor(() => expect(getVisiblePageCommands()).toEqual(['restore-page']));
  });

  it('resynchronizes for the focused window rather than a tab activated in a background window', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    mocks.handlePageTranslation.mockClear();
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    const focus = mocks.browser.windows.onFocusChanged.addListener.mock.calls[0][0];

    focus(-1);
    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
    focus(2);
    await vi.waitFor(() => expect(getVisiblePageCommands()).toEqual(['restore-page']));

    expect(mocks.browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(mocks.handlePageTranslation).toHaveBeenLastCalledWith(
      { action: MessageActions.PAGE_TRANSLATE_GET_STATUS, context: 'context-menu' },
      { tab: { id: 42 } }
    );
  });

  it('does not overwrite newer lifecycle state with a late status probe', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    let resolveStatus;
    mocks.handlePageTranslation.mockClear();
    mocks.handlePageTranslation.mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
    const refresh = manager.refreshActivePageMenu();
    await vi.waitFor(() => expect(resolveStatus).toEqual(expect.any(Function)));

    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
    listener({
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { isAggregated: true, isTranslating: true }
    }, { tab: { id: 42 }, frameId: 0 });
    resolveStatus(inactivePageStatus());
    await refresh;
    await manager._pageMenuUpdatePromise;

    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it('ignores late status from a previously active tab', async () => {
    await manager.initialize();
    let resolvePrevious;
    mocks.handlePageTranslation.mockImplementationOnce(() => new Promise(resolve => { resolvePrevious = resolve; }));
    const previousRefresh = manager.refreshActivePageMenu({ id: 42 });
    await vi.waitFor(() => expect(resolvePrevious).toEqual(expect.any(Function)));

    mocks.handlePageTranslation.mockResolvedValue(inactivePageStatus());
    await manager.refreshActivePageMenu({ id: 43 });
    resolvePrevious({ ...inactivePageStatus(), isTranslated: true });
    await previousRefresh;

    expect(getVisiblePageCommands()).toEqual(['translate-page']);
    expect(manager.activePageTabId).toBe(43);
  });

  it('resets on navigation and ignores the previous document status response', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    await manager.initialize();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);

    let resolvePrevious;
    mocks.handlePageTranslation.mockImplementationOnce(() => new Promise(resolve => { resolvePrevious = resolve; }));
    const refresh = manager.refreshActivePageMenu();
    await vi.waitFor(() => expect(resolvePrevious).toEqual(expect.any(Function)));
    const update = mocks.browser.tabs.onUpdated.addListener.mock.calls[0][0];
    update(42, { status: 'loading' });
    await manager._pageMenuUpdatePromise;
    resolvePrevious({ ...inactivePageStatus(), isTranslated: true });
    await refresh;
    expect(getVisiblePageCommands()).toEqual(['translate-page']);

    mocks.handlePageTranslation.mockResolvedValue(inactivePageStatus());
    mocks.handlePageTranslation.mockClear();
    update(42, { status: 'complete' });
    await vi.waitFor(() => expect(mocks.handlePageTranslation).toHaveBeenCalledOnce());
  });

  it('preserves restore when a status query fails or times out', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    await manager.initialize();

    mocks.handlePageTranslation.mockResolvedValue({ success: false, reason: 'frame_command_response_timeout' });
    await manager.refreshActivePageMenu();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);

    mocks.handlePageTranslation.mockRejectedValue(new Error('status unavailable'));
    await expect(manager.refreshActivePageMenu()).resolves.toBeUndefined();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it('never shows both commands when lifecycle changes during an in-flight visibility update', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    const updateMenu = mocks.browser.contextMenus.update.getMockImplementation();
    let resumeHide;
    mocks.browser.contextMenus.update.mockImplementationOnce(async (id, changes) => {
      await new Promise(resolve => { resumeHide = resolve; });
      await updateMenu(id, changes);
      expect(getVisiblePageCommands().length).toBeLessThanOrEqual(1);
    });
    mocks.browser.contextMenus.update.mockImplementation(async (id, changes) => {
      await updateMenu(id, changes);
      expect(getVisiblePageCommands().length).toBeLessThanOrEqual(1);
    });
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
    const sender = { tab: { id: 42 }, frameId: 0 };
    listener({ action: MessageActions.PAGE_TRANSLATE_START, data: { isAggregated: true, isTranslating: true } }, sender);
    await vi.waitFor(() => expect(resumeHide).toEqual(expect.any(Function)));
    listener({ action: MessageActions.PAGE_RESTORE_COMPLETE, data: { ...inactivePageStatus(), isAggregated: true } }, sender);
    resumeHide();
    await manager._pageMenuUpdatePromise;

    expect(getVisiblePageCommands()).toEqual(['translate-page']);
  });

  it('handles a visibility API failure without revealing the other command', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    mocks.browser.contextMenus.update.mockRejectedValueOnce(new Error('hide failed'));
    const listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];

    listener({
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { isAggregated: true, isTranslating: true }
    }, { tab: { id: 42 }, frameId: 0 });
    await manager._pageMenuUpdatePromise;

    expect(getVisiblePageCommands()).toEqual(['translate-page']);
    expect(mocks.logger.error).toHaveBeenCalledWith('Failed to sync page context menu visibility:', expect.any(Error));
  });

  it('refreshes the exact shown tab through Firefox menus when supported', async () => {
    mocks.browser.menus = {
      onShown: { addListener: vi.fn(), removeListener: vi.fn() },
      refresh: vi.fn().mockResolvedValue(undefined)
    };
    await manager.initialize();
    mocks.browser.tabs.query.mockClear();
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    const shown = mocks.browser.menus.onShown.addListener.mock.calls[0][0];

    shown({}, { id: 43 });
    await vi.waitFor(() => expect(mocks.browser.menus.refresh).toHaveBeenCalledOnce());

    expect(mocks.browser.tabs.query).not.toHaveBeenCalled();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);
    expect(mocks.handlePageTranslation).toHaveBeenLastCalledWith(
      { action: MessageActions.PAGE_TRANSLATE_GET_STATUS, context: 'context-menu' },
      { tab: { id: 43 } }
    );
  });

  it('removes page listeners and tab state during cleanup without duplication on forced rebuild', async () => {
    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    await manager.initialize();
    await manager.initialize(true);
    expect(mocks.browser.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    expect(mocks.browser.tabs.onActivated.addListener).toHaveBeenCalledOnce();

    await manager.cleanup();

    for (const event of [mocks.browser.runtime.onMessage, mocks.browser.tabs.onActivated,
      mocks.browser.tabs.onUpdated, mocks.browser.tabs.onRemoved, mocks.browser.windows.onFocusChanged]) {
      expect(event.removeListener).toHaveBeenCalledWith(event.addListener.mock.calls[0][0]);
    }
    expect(manager.pageTranslationStates.size).toBe(0);
    expect(getVisiblePageCommands()).toEqual([]);
  });

  it('hides both whole-page commands when their visibility preference is disabled', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        PAGE_CONTEXT_PAGE_TRANSLATION: false
      }
    }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeUndefined();
    expect(getCreatedMenu('translate-with-select-element')).toBeDefined();
  });

  it('keeps restore available when whole-page translation is disabled', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({ WHOLE_PAGE_TRANSLATION_ENABLED: false }));

    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    await manager.initialize();

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it('uses the Whole Page provider independently of the Select Element provider', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      TRANSLATION_API: 'vajehyab',
      MODE_PROVIDERS: { 'page-translation-batch': 'googlev2' }
    }));
    mocks.getEffectiveProviderAsync.mockResolvedValue('vajehyab');

    await manager._setupMenusInternal();

    expect(getCreatedMenu('translate-page')).toBeDefined();
    expect(getCreatedMenu('translate-with-select-element')).toBeUndefined();
  });

  it('keeps restore available when the Whole Page provider lacks bulk support', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      MODE_PROVIDERS: { 'page-translation-batch': 'vajehyab' }
    }));

    mocks.browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    mocks.handlePageTranslation.mockResolvedValue({ ...inactivePageStatus(), isTranslated: true });
    await manager.initialize();

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
    expect(getCreatedMenu('translate-with-select-element')).toBeDefined();
    expect(getVisiblePageCommands()).toEqual(['restore-page']);
  });

  it.each(unsupportedPageProviders)('hides page translation with an unsupported %s provider despite capability fallback', async (_source, overrides) => {
    const settings = createSettings(overrides);
    const config = await useRealProviderResolution(() => settings);
    expect(await config.getEffectiveProviderAsync(config.TranslationMode.Page)).toBe('googlev2');

    await manager._setupMenusInternal();

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
    expect(getCreatedMenu('translate-with-select-element')).toBeDefined();
  });

  it.each(unsupportedPageProviders)('rejects stale translate clicks with an unsupported %s provider despite capability fallback', async (_source, overrides) => {
    let settings = createSettings();
    const config = await useRealProviderResolution(() => settings);
    await manager._setupMenusInternal();
    expect(getCreatedMenu('translate-page')).toBeDefined();

    settings = createSettings(overrides);
    expect(await config.getEffectiveProviderAsync(config.TranslationMode.Page)).toBe('googlev2');
    await manager.handleMenuClick({ menuItemId: 'translate-page' }, { id: 42 });

    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
  });

  it('enables new whole-page commands for older visibility settings', async () => {
    const visibility = { ...CONTEXT_MENU_VISIBILITY };
    delete visibility.PAGE_CONTEXT_PAGE_TRANSLATION;
    mocks.storageManager.get.mockResolvedValue(createSettings({ CONTEXT_MENU_VISIBILITY: visibility }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu('translate-page')).toBeDefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
  });

  it('keeps other menus available after a whole-page title lookup fails', async () => {
    mocks.getTranslationString.mockImplementation((key) => {
      if (key === 'context_menu_translate_page') throw new Error('page title unavailable');
      return key;
    });

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
    expect(getCreatedMenu('translate-with-select-element')).toBeDefined();
  });

  it('rebuilds page commands after the whole-page setting changes', async () => {
    await manager.initialize();
    const listener = mocks.browser.storage.onChanged.addListener.mock.calls[0][0];
    mocks.browser.contextMenus.create.mockClear();
    mocks.storageManager.get.mockResolvedValue(createSettings({ WHOLE_PAGE_TRANSLATION_ENABLED: false }));

    await listener({ WHOLE_PAGE_TRANSLATION_ENABLED: { newValue: false } }, 'local');

    expect(getCreatedMenu('translate-page')).toBeUndefined();
    expect(getCreatedMenu('restore-page')).toBeDefined();
  });

  it.each([
    ['translate-page', MessageActions.PAGE_TRANSLATE],
    ['restore-page', MessageActions.PAGE_RESTORE]
  ])('routes %s through the shared handler for the clicked tab', async (menuItemId, action) => {
    const clickedTab = { id: 42, url: 'https://example.com' };
    mocks.browser.tabs.query.mockResolvedValue([{ id: 99 }]);

    await manager.handleMenuClick({ menuItemId, frameId: 7 }, clickedTab);

    expect(mocks.handlePageTranslation).toHaveBeenCalledOnce();
    expect(mocks.handlePageTranslation).toHaveBeenCalledWith(
      { action, context: 'context-menu' },
      { tab: clickedTab }
    );
    expect(mocks.browser.tabs.query).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(mocks.browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { id: '42' }, { id: -1 }])('does not fall back to an active tab for an invalid clicked tab: %s', async (tab) => {
    await manager.handleMenuClick({ menuItemId: 'translate-page' }, tab);

    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.query).not.toHaveBeenCalled();
  });

  it.each(['translate-page', 'restore-page'])('does not dispatch stale %s clicks after disabling the extension', async (menuItemId) => {
    mocks.storageManager.get.mockResolvedValue(createSettings({ EXTENSION_ENABLED: false }));

    await manager.handleMenuClick({ menuItemId }, { id: 42 });

    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
  });

  it('does not translate after the whole-page feature is disabled', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({ WHOLE_PAGE_TRANSLATION_ENABLED: false }));

    await manager.handleMenuClick({ menuItemId: 'translate-page' }, { id: 42 });

    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
  });

  it('does not translate with a newly selected provider without bulk support', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      MODE_PROVIDERS: { 'page-translation-batch': 'vajehyab' }
    }));

    await manager.handleMenuClick({ menuItemId: 'translate-page' }, { id: 42 });

    expect(mocks.handlePageTranslation).not.toHaveBeenCalled();
  });

  it('restores existing translations after disabling whole-page translation and switching providers', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      WHOLE_PAGE_TRANSLATION_ENABLED: false,
      MODE_PROVIDERS: { 'page-translation-batch': 'vajehyab' }
    }));

    await manager.handleMenuClick({ menuItemId: 'restore-page' }, { id: 42 });

    expect(mocks.handlePageTranslation).toHaveBeenCalledWith(
      { action: MessageActions.PAGE_RESTORE, context: 'context-menu' },
      { tab: { id: 42 } }
    );
    expect(mocks.getEffectiveProviderAsync).not.toHaveBeenCalled();
  });

  it('keeps restricted-page failures in the canonical handler without trying another tab', async () => {
    const result = { success: false, isRestrictedPage: true };
    mocks.handlePageTranslation.mockResolvedValue(result);

    await manager.handleMenuClick({ menuItemId: 'translate-page' }, { id: 42 });

    expect(mocks.handlePageTranslation).toHaveBeenCalledOnce();
    expect(mocks.browser.tabs.query).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Page context menu command was not completed',
      { action: MessageActions.PAGE_TRANSLATE, tabId: 42, result }
    );
  });

  it('logs dispatch errors without an unhandled context-menu rejection', async () => {
    const error = new Error('page command unavailable');
    mocks.handlePageTranslation.mockRejectedValue(error);

    await expect(manager.handleMenuClick({ menuItemId: 'restore-page' }, { id: 42 })).resolves.toBeUndefined();

    expect(mocks.logger.error).toHaveBeenCalledWith('Context menu click handler failed:', error);
  });

  it('creates the expected Action menu structure with nested children', async () => {
    await manager._setupMenusInternal();

    const topLevelActionIds = getActionMenus()
      .filter(menu => !menu.parentId)
      .map(menu => menu.id);

    expect(topLevelActionIds).toEqual([
      API_PROVIDER_PARENT_ID,
      'action-translate-element',
      'screen-capture-action',
      TRANSLATORS_PARENT_ID,
      SETTINGS_PARENT_ID
    ]);
    expect(getCreatedMenu('open-pdf-page').parentId).toBe(TRANSLATORS_PARENT_ID);
    expect(getCreatedMenu('open-subtitle-page').parentId).toBe(TRANSLATORS_PARENT_ID);
    expect(getCreatedMenu('open-options-page').parentId).toBe(SETTINGS_PARENT_ID);
    expect(getCreatedMenu('open-shortcuts-page').parentId).toBe(SETTINGS_PARENT_ID);
    expect(getCreatedMenu('open-help-page').parentId).toBe(SETTINGS_PARENT_ID);
    expect(getActionMenus().some(menu => menu.type === 'separator' && !menu.parentId)).toBe(false);
  });

  it('preserves provider submenu creation and selected provider state', async () => {
    await manager._setupMenusInternal();

    expect(getCreatedMenu('api-provider-googlev2')).toMatchObject({
      parentId: API_PROVIDER_PARENT_ID,
      type: 'checkbox',
      checked: true
    });
    expect(getCreatedMenu('api-provider-openai')).toMatchObject({
      parentId: API_PROVIDER_PARENT_ID,
      type: 'checkbox',
      checked: false
    });
    expect(getCreatedMenus()).toContainEqual(expect.objectContaining({
      parentId: API_PROVIDER_PARENT_ID,
      type: 'separator'
    }));
  });

  it.each([
    ['both children enabled', { ACTION_CONTEXT_PDF_TRANSLATOR: true, ACTION_CONTEXT_SUBTITLE_TRANSLATOR: true }, ['open-pdf-page', 'open-subtitle-page']],
    ['only PDF enabled', { ACTION_CONTEXT_PDF_TRANSLATOR: true, ACTION_CONTEXT_SUBTITLE_TRANSLATOR: false }, ['open-pdf-page']],
    ['only Subtitle enabled', { ACTION_CONTEXT_PDF_TRANSLATOR: false, ACTION_CONTEXT_SUBTITLE_TRANSLATOR: true }, ['open-subtitle-page']]
  ])('creates Translators parent for %s', async (_name, translatorVisibility, childIds) => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        ...translatorVisibility
      }
    }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu(TRANSLATORS_PARENT_ID)).toBeDefined();
    expect(getCreatedMenus()
      .filter(menu => menu.parentId === TRANSLATORS_PARENT_ID)
      .map(menu => menu.id)).toEqual(childIds);
  });

  it('does not create Translators when both children are disabled', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        ACTION_CONTEXT_PDF_TRANSLATOR: false,
        ACTION_CONTEXT_SUBTITLE_TRANSLATOR: false
      }
    }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu(TRANSLATORS_PARENT_ID)).toBeUndefined();
    expect(getCreatedMenu('open-pdf-page')).toBeUndefined();
    expect(getCreatedMenu('open-subtitle-page')).toBeUndefined();
  });

  it('creates Settings parent with only enabled children', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        ACTION_CONTEXT_OPTIONS: false,
        ACTION_CONTEXT_SHORTCUTS: true,
        ACTION_CONTEXT_HELP: false
      }
    }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu(SETTINGS_PARENT_ID)).toBeDefined();
    expect(getCreatedMenus()
      .filter(menu => menu.parentId === SETTINGS_PARENT_ID)
      .map(menu => menu.id)).toEqual(['open-shortcuts-page']);
  });

  it('does not create Settings when all children are disabled', async () => {
    mocks.storageManager.get.mockResolvedValue(createSettings({
      CONTEXT_MENU_VISIBILITY: {
        ...CONTEXT_MENU_VISIBILITY,
        ACTION_CONTEXT_OPTIONS: false,
        ACTION_CONTEXT_SHORTCUTS: false,
        ACTION_CONTEXT_HELP: false
      }
    }));

    await manager._setupMenusInternal();

    expect(getCreatedMenu(SETTINGS_PARENT_ID)).toBeUndefined();
    expect(getCreatedMenu('open-options-page')).toBeUndefined();
    expect(getCreatedMenu('open-shortcuts-page')).toBeUndefined();
    expect(getCreatedMenu('open-help-page')).toBeUndefined();
  });

  it('preserves defaults when requested settings are absent', async () => {
    mocks.storageManager.get.mockResolvedValue({
      TRANSLATION_API: 'googlev2',
      OPENAI_API_KEY: 'configured-key'
    });

    await manager._setupMenusInternal();

    const menuIds = getCreatedMenuIds();
    expect(menuIds).toContain('translate-with-select-element');
    expect(menuIds).toContain('screen-capture-page');
    expect(menuIds).toContain('screen-capture-action');
  });

  it('rejects initial setup when preflight storage read fails', async () => {
    mocks.storageManager.get.mockRejectedValue(new Error('storage unavailable'));

    await expect(manager.initialize()).rejects.toThrow('storage unavailable');

    expect(mocks.storageManager.get).toHaveBeenCalledWith(CONTEXT_MENU_SETTING_KEYS, false);
    expect(mocks.browser.contextMenus.removeAll).not.toHaveBeenCalled();
    expect(mocks.browser.contextMenus.create).not.toHaveBeenCalled();
    expect(manager.initialized).toBe(false);
  });

  it('preserves existing menus when preflight fails', async () => {
    manager.initialized = true;
    manager.createdMenus.add('existing-menu');
    mocks.storageManager.get.mockRejectedValue(new Error('storage unavailable'));

    await expect(manager.setupDefaultMenus()).rejects.toThrow('storage unavailable');

    expect(mocks.browser.contextMenus.removeAll).not.toHaveBeenCalled();
    expect(manager.getCreatedMenus()).toEqual(['existing-menu']);
    expect(manager.initialized).toBe(false);
  });

  it('allows initialization retry after transient preflight failure', async () => {
    mocks.storageManager.get
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValueOnce(createSettings());

    await expect(manager.initialize()).rejects.toThrow('temporary storage failure');
    expect(manager.initialized).toBe(false);

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.initialized).toBe(true);
    expect(mocks.browser.storage.onChanged.addListener).toHaveBeenCalledOnce();
  });

  it('does not register a duplicate listener after failed forced rebuild retry', async () => {
    await manager.initialize();
    expect(mocks.browser.storage.onChanged.addListener).toHaveBeenCalledOnce();

    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      if (menu.id === 'open-pdf-with-link') {
        throw new Error('menu creation failed');
      }
      callback?.();
      return menu.id;
    });

    await expect(manager.initialize(true)).rejects.toThrow('menu creation failed');
    expect(manager.initialized).toBe(false);

    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      callback?.();
      return menu.id;
    });

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(mocks.browser.storage.onChanged.addListener).toHaveBeenCalledOnce();
  });

  it('restores initialized state after successful runtime rebuild recovery', async () => {
    await manager.initialize();
    expect(manager.initialized).toBe(true);

    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      if (menu.id === 'open-pdf-with-link') {
        throw new Error('menu creation failed');
      }
      callback?.();
      return menu.id;
    });

    await expect(manager.setupDefaultMenus()).rejects.toThrow('menu creation failed');
    expect(manager.initialized).toBe(false);

    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      callback?.();
      return menu.id;
    });

    await expect(manager.setupDefaultMenus()).resolves.toBeUndefined();
    expect(manager.initialized).toBe(true);
    expect(mocks.browser.storage.onChanged.addListener).toHaveBeenCalledOnce();
  });

  it('does not claim listener registration when addListener fails', async () => {
    mocks.browser.storage.onChanged.addListener.mockImplementationOnce(() => {
      throw new Error('listener registration failed');
    });

    await expect(manager.initialize()).rejects.toThrow('listener registration failed');
    expect(manager.initialized).toBe(false);
    expect(manager.storageListener).toBeNull();

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.initialized).toBe(true);
    expect(manager.storageListener).toEqual(expect.any(Function));
    expect(mocks.browser.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
  });

  it('invalidates initialization after fatal post-removal failure and permits retry', async () => {
    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      if (menu.id === 'open-pdf-with-link') {
        throw new Error('menu creation failed');
      }
      callback?.();
      return menu.id;
    });

    await expect(manager.initialize()).rejects.toThrow('menu creation failed');
    expect(mocks.browser.contextMenus.removeAll).toHaveBeenCalledOnce();
    expect(manager.initialized).toBe(false);

    mocks.browser.contextMenus.create.mockImplementation((menu, callback) => {
      callback?.();
      return menu.id;
    });

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.initialized).toBe(true);
  });

  it('handles storage-triggered rebuild rejection', async () => {
    await manager.initialize();
    const storageListener = mocks.browser.storage.onChanged.addListener.mock.calls[0][0];
    vi.spyOn(manager, 'setupDefaultMenus').mockRejectedValue(new Error('rebuild failed'));

    await expect(storageListener({ TRANSLATION_API: { newValue: 'gemini' } }, 'local'))
      .resolves.toBeUndefined();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to rebuild context menus after storage change:',
      expect.any(Error)
    );
  });

  it('persists provider selection without explicitly rebuilding menus', async () => {
    const setupSpy = vi.spyOn(manager, 'setupDefaultMenus');

    await manager.handleMenuClick({ menuItemId: 'api-provider-gemini' });

    expect(mocks.storageManager.set).toHaveBeenCalledOnce();
    expect(mocks.storageManager.set).toHaveBeenCalledWith({ TRANSLATION_API: 'gemini' });
    expect(setupSpy).not.toHaveBeenCalled();
  });

  it('does not rebuild menus when provider persistence fails', async () => {
    const error = new Error('provider write failed');
    mocks.storageManager.set.mockRejectedValue(error);
    const setupSpy = vi.spyOn(manager, 'setupDefaultMenus');

    await expect(manager.handleMenuClick({ menuItemId: 'api-provider-gemini' }))
      .resolves.toBeUndefined();

    expect(setupSpy).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Error setting new API provider:',
      error
    );
  });

  it('routes Help through the canonical Options handler', async () => {
    const openOptionsHandler = vi.fn().mockResolvedValue({ success: true });
    const getHandlerForMessage = vi.fn().mockReturnValue(openOptionsHandler);
    globalThis.backgroundService = {
      messageHandler: { getHandlerForMessage }
    };

    await manager.handleMenuClick({ menuItemId: 'open-help-page' });

    expect(getHandlerForMessage).toHaveBeenCalledWith(MessageActions.OPEN_OPTIONS_PAGE);
    expect(openOptionsHandler).toHaveBeenCalledWith(
      {
        action: MessageActions.OPEN_OPTIONS_PAGE,
        data: { anchor: 'help' }
      },
      { tab: null },
      expect.any(Function)
    );
    expect(mocks.browser.runtime.sendMessage).not.toHaveBeenCalled();
    expect(mocks.browser.runtime.getURL).not.toHaveBeenCalled();
  });

  it('falls back to messaging for canonical Help navigation', async () => {
    await manager.handleMenuClick({ menuItemId: 'open-help-page' });

    expect(mocks.browser.runtime.sendMessage).toHaveBeenCalledWith({
      action: MessageActions.OPEN_OPTIONS_PAGE,
      data: { anchor: 'help' }
    });
    expect(mocks.browser.runtime.getURL).not.toHaveBeenCalled();
  });

  it('opens native Firefox shortcut settings without checking the active tab', async () => {
    mocks.browser.runtime.getBrowserInfo.mockResolvedValue({ name: 'Firefox' });

    await manager.handleMenuClick({ menuItemId: 'open-shortcuts-page' });

    expect(mocks.browser.commands.openShortcutSettings).toHaveBeenCalledOnce();
    expect(mocks.browser.tabs.create).not.toHaveBeenCalled();
    expect(mocks.tabPermissionChecker.checkTabAccess).not.toHaveBeenCalled();
  });

  it('opens Chrome shortcut settings URL outside Firefox', async () => {
    await manager.handleMenuClick({ menuItemId: 'open-shortcuts-page' });

    expect(mocks.browser.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://extensions/shortcuts'
    });
    expect(mocks.browser.commands.openShortcutSettings).not.toHaveBeenCalled();
  });

  it('logs Firefox shortcut API failures without opening the Help page', async () => {
    const error = new Error('shortcut settings unavailable');
    mocks.browser.runtime.getBrowserInfo.mockResolvedValue({ name: 'Firefox' });
    mocks.browser.commands.openShortcutSettings.mockRejectedValue(error);

    await manager.handleMenuClick({ menuItemId: 'open-shortcuts-page' });

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Could not open Firefox shortcut settings:',
      error
    );
    expect(mocks.browser.tabs.create).not.toHaveBeenCalled();
    expect(mocks.browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Select Element title failure local to its menu paths', async () => {
    mocks.getTranslationString.mockImplementation((key) => {
      if (key === 'context_menu_translate_with_selection') {
        throw new Error('selection title unavailable');
      }
      return key;
    });

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(manager.initialized).toBe(true);
    expect(getCreatedMenuIds()).toContain('open-pdf-with-link');
    expect(getCreatedMenuIds()).toContain('api-provider-parent');
    expect(getCreatedMenuIds()).not.toContain('translate-with-select-element');
    expect(getCreatedMenuIds()).not.toContain('action-translate-element');
  });
});

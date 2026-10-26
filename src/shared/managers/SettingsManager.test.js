import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js';
import ExtensionContextManager from '@/core/extensionContext.js';

const { storageManagerMock } = vi.hoisted(() => ({
  storageManagerMock: {
    get: vi.fn().mockResolvedValue({}),
    getFresh: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    off: vi.fn(),
    hasCached: vi.fn().mockReturnValue(false),
    getCached: vi.fn()
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: storageManagerMock
}));

import { settingsManager } from './SettingsManager.js';

function createStorageEventMock() {
  const listeners = new Set();
  const onChanged = {
    addListener: vi.fn(callback => {
      listeners.add(callback);
    }),
    removeListener: vi.fn(callback => {
      listeners.delete(callback);
    })
  };

  return {
    onChanged,
    dispatch: (changes, areaName) => {
      for (const listener of listeners) {
        listener(changes, areaName);
      }
    },
    getListener: () => listeners.values().next().value,
    getActiveListeners: () => [...listeners]
  };
}

let originalStorageOnChanged;

beforeEach(async () => {
  if (settingsManager._initializationPromise) {
    await settingsManager._initializationPromise;
  }

  vi.clearAllMocks();
  settingsManager.destroy();
  storageManagerMock.get.mockReset().mockResolvedValue({});
  storageManagerMock.getFresh.mockReset().mockResolvedValue({});
  storageManagerMock.set.mockReset().mockResolvedValue(true);
  originalStorageOnChanged = browser.storage.onChanged;
  browser.storage.onChanged = undefined;
});

afterEach(() => {
  settingsManager.destroy();
  browser.storage.onChanged = originalStorageOnChanged;
});

describe('SettingsManager defaults', () => {
  it('uses canonical persisted defaults for its fallback schema', () => {
    const canonicalDefaults = getPersistedDefaultSettings();
    const managerDefaults = settingsManager._defaults;

    expect(canonicalDefaults).not.toHaveProperty('ENHANCED_TRIPLE_CLICK_DRAG');
    expect(managerDefaults).not.toHaveProperty('ENHANCED_TRIPLE_CLICK_DRAG');

    expect(Object.keys(managerDefaults).every(key => (
      Object.prototype.hasOwnProperty.call(canonicalDefaults, key)
    ))).toBe(true);
    expect(Object.values(managerDefaults)).not.toContain(undefined);

    [
      'TARGET_LANGUAGE',
      'TRANSLATION_API',
      'MODE_PROVIDERS',
      'WHOLE_PAGE_EXCLUDED_SELECTORS',
      'MOUSE_HOVER_SCOPE',
      'MOUSE_HOVER_TRIGGER',
      'TEXT_FIELD_SHORTCUT',
      'AI_CONTEXT_TRANSLATION_ENABLED'
    ].forEach(key => {
      expect(managerDefaults[key]).toEqual(canonicalDefaults[key]);
    });

    [
      'DESKTOP_FAB_POSITION',
      'MOBILE_FAB_POSITION',
      'WHOLE_PAGE_MAX_CONCURRENT_REQUESTS'
    ].forEach(key => {
      expect(managerDefaults).not.toHaveProperty(key);
    });
  });

  it('excludes all credential-like canonical settings from fallback defaults', () => {
    const managerDefaults = settingsManager._defaults;
    const secretKeys = Object.keys(getPersistedDefaultSettings()).filter(key => (
      /(?:^|_)API_KEY$|(?:USERNAME|PASSWORD)$/.test(key)
    ));

    secretKeys.forEach(key => {
      expect(managerDefaults).not.toHaveProperty(key);
    });
  });

  it('keeps nested defaults independent from later canonical default builds', () => {
    const canonicalDefaults = getPersistedDefaultSettings();
    const untouchedDefaults = getPersistedDefaultSettings();
    const managerDefaults = settingsManager._defaults;

    expect(managerDefaults.MODE_PROVIDERS).not.toBe(canonicalDefaults.MODE_PROVIDERS);
    expect(managerDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS)
      .not.toBe(canonicalDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS);
    expect(managerDefaults.CONTEXT_MENU_VISIBILITY)
      .not.toBe(canonicalDefaults.CONTEXT_MENU_VISIBILITY);

    canonicalDefaults.MODE_PROVIDERS.__testOnly = 'changed';
    canonicalDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS.push('.test-only');
    canonicalDefaults.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_OPTIONS = false;

    expect(managerDefaults.MODE_PROVIDERS).not.toHaveProperty('__testOnly');
    expect(managerDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS).not.toContain('.test-only');
    expect(managerDefaults.MODE_PROVIDERS).toEqual(untouchedDefaults.MODE_PROVIDERS);
    expect(managerDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS)
      .toEqual(untouchedDefaults.WHOLE_PAGE_EXCLUDED_SELECTORS);
    expect(managerDefaults.CONTEXT_MENU_VISIBILITY)
      .toEqual(untouchedDefaults.CONTEXT_MENU_VISIBILITY);
  });

  it('loads only tracked keys during runtime initialization', async () => {
    storageManagerMock.get.mockReset();
    storageManagerMock.get.mockResolvedValue({});
    await settingsManager.initialize();

    const requestedKeys = storageManagerMock.get.mock.calls.at(-1)[0];
    expect(requestedKeys).toEqual(Object.keys(settingsManager._defaults));
    expect(requestedKeys).not.toContain('OPENAI_API_KEY');
    expect(requestedKeys).not.toContain('PROXY_PASSWORD');
    expect(requestedKeys).not.toContain('DESKTOP_FAB_POSITION');
    expect(requestedKeys).not.toContain('MOBILE_FAB_POSITION');
    expect(requestedKeys).not.toContain('WHOLE_PAGE_MAX_CONCURRENT_REQUESTS');
  });

  it('shares runtime initialization and registers one storage listener', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;

    let resolveStorage;
    storageManagerMock.get.mockReturnValue(new Promise(resolve => {
      resolveStorage = resolve;
    }));

    const firstInitialization = settingsManager.initialize();
    const secondInitialization = settingsManager.initialize();

    expect(firstInitialization).toBe(secondInitialization);
    expect(storageManagerMock.get).toHaveBeenCalledTimes(1);

    resolveStorage({ EXTENSION_ENABLED: false });
    await firstInitialization;

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(storageEvents.onChanged.addListener).toHaveBeenCalledTimes(1);
    expect(storageEvents.getListener()).toEqual(expect.any(Function));
  });

  it('remains retryable when required storage listener registration fails', async () => {
    const storageEvents = createStorageEventMock();
    const listenerError = new Error('listener unavailable');
    browser.storage.onChanged = storageEvents.onChanged;
    storageEvents.onChanged.addListener
      .mockImplementationOnce(() => { throw listenerError; });

    await expect(settingsManager.initialize()).rejects.toBe(listenerError);
    expect(settingsManager._initialized).toBe(false);
    expect(settingsManager._storageListenerSetup).toBe(false);

    // Restore normal event registration for retry.
    const recoveredEvents = createStorageEventMock();
    browser.storage.onChanged = recoveredEvents.onChanged;
    await settingsManager.initialize();
    expect(recoveredEvents.onChanged.addListener).toHaveBeenCalledOnce();

    const reaction = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', reaction);
    recoveredEvents.dispatch({ EXTENSION_ENABLED: { oldValue: true, newValue: false } }, 'local');
    expect(reaction).toHaveBeenCalledOnce();
  });

  it('propagates storage failure and remains retryable without publishing fallback state', async () => {
    const error = new Error('storage unavailable');
    storageManagerMock.get.mockRejectedValue(error);

    await expect(settingsManager.initialize()).rejects.toBe(error);

    expect(settingsManager._initialized).toBe(false);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBeUndefined();
    expect(settingsManager._settings.value).toEqual({});

    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await expect(settingsManager.initialize()).resolves.toBeDefined();
    expect(settingsManager._initialized).toBe(true);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
  });

  it('uses own runtime state for has and getAll', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({
      EXTENSION_ENABLED: false,
      OPENAI_API_KEY: 'secret',
      PROXY_PASSWORD: 'secret'
    });

    await settingsManager.initialize();

    expect(settingsManager.has('EXTENSION_ENABLED')).toBe(true);
    expect(settingsManager.has('NOT_EXPOSED')).toBe(false);
    expect(settingsManager.has('OPENAI_API_KEY')).toBe(false);
    expect(settingsManager.has('toString')).toBe(false);

    storageManagerMock.get.mockClear();
    const allSettings = settingsManager.getAll();

    expect(allSettings).not.toBe(settingsManager._settings.value);
    expect(allSettings).toEqual(settingsManager._settings.value);
    expect(allSettings.MODE_PROVIDERS).toBe(settingsManager._settings.value.MODE_PROVIDERS);
    expect(allSettings).not.toHaveProperty('OPENAI_API_KEY');
    expect(allSettings).not.toHaveProperty('GEMINI_API_KEY');
    expect(allSettings).not.toHaveProperty('PROXY_USERNAME');
    expect(allSettings).not.toHaveProperty('PROXY_PASSWORD');
    expect(storageManagerMock.get).not.toHaveBeenCalled();
  });

  it('sets multiple runtime values once and suppresses matching storage events', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({
      EXTENSION_ENABLED: false,
      TRANSLATE_ON_TEXT_FIELDS: false,
      TRANSLATE_ON_TEXT_SELECTION: false
    });
    await settingsManager.initialize();

    const extensionChange = vi.fn();
    const fieldChange = vi.fn();
    const selectionChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', extensionChange);
    settingsManager.onChange('TRANSLATE_ON_TEXT_FIELDS', fieldChange);
    settingsManager.onChange('TRANSLATE_ON_TEXT_SELECTION', selectionChange);
    storageManagerMock.get.mockClear();
    const updates = {
      EXTENSION_ENABLED: true,
      TRANSLATE_ON_TEXT_FIELDS: false,
      TRANSLATE_ON_TEXT_SELECTION: true
    };
    storageManagerMock.set.mockImplementation(async () => {
      storageEvents.dispatch({
        EXTENSION_ENABLED: { oldValue: false, newValue: true },
        TRANSLATE_ON_TEXT_FIELDS: { oldValue: false, newValue: false },
        TRANSLATE_ON_TEXT_SELECTION: { oldValue: false, newValue: true }
      }, 'local');
    });

    await settingsManager.setMultiple(updates);

    expect(storageManagerMock.set).toHaveBeenCalledTimes(1);
    expect(storageManagerMock.set).toHaveBeenCalledWith(updates);
    expect(storageManagerMock.get).not.toHaveBeenCalled();
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
    expect(settingsManager.get('TRANSLATE_ON_TEXT_FIELDS')).toBe(false);
    expect(settingsManager.get('TRANSLATE_ON_TEXT_SELECTION')).toBe(true);
    expect(extensionChange).toHaveBeenCalledTimes(1);
    expect(extensionChange).toHaveBeenCalledWith(true, false, 'EXTENSION_ENABLED');
    expect(fieldChange).not.toHaveBeenCalled();
    expect(selectionChange).toHaveBeenCalledTimes(1);
    expect(selectionChange).toHaveBeenCalledWith(true, false, 'TRANSLATE_ON_TEXT_SELECTION');

    storageEvents.dispatch({
      EXTENSION_ENABLED: { oldValue: false, newValue: true }
    }, 'local');
    expect(extensionChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['THEME', 'dark'],
    ['OPENAI_API_KEY', 'secret'],
    ['PROXY_PASSWORD', 'secret'],
    ['UNKNOWN_SETTING', true]
  ])('rejects unsupported fallback set key %s without side effects', async (key, value) => {
    await settingsManager.initialize();
    const onChange = vi.fn();
    settingsManager.onChange(key, onChange);
    const before = { ...settingsManager._settings.value };
    storageManagerMock.set.mockClear();

    await expect(settingsManager.set(key, value)).rejects.toThrow(
      `SettingsManager fallback does not support setting key: ${key}`
    );

    expect(storageManagerMock.set).not.toHaveBeenCalled();
    expect(settingsManager._settings.value).toEqual(before);
    expect(settingsManager.has(key)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(settingsManager._pendingUpdates.size).toBe(0);
  });

  it.each([
    [
      {
        EXTENSION_ENABLED: true,
        OPENAI_API_KEY: 'secret',
        THEME: 'dark'
      },
      'SettingsManager fallback does not support setting keys: OPENAI_API_KEY, THEME'
    ],
    [
      {
        OPENAI_API_KEY: 'secret',
        PROXY_PASSWORD: 'secret'
      },
      'SettingsManager fallback does not support setting keys: OPENAI_API_KEY, PROXY_PASSWORD'
    ]
  ])('rejects invalid fallback batches atomically', async (updates, message) => {
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();
    const extensionChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', extensionChange);
    const before = { ...settingsManager._settings.value };
    storageManagerMock.set.mockClear();

    await expect(settingsManager.setMultiple(updates)).rejects.toThrow(message);

    expect(storageManagerMock.set).not.toHaveBeenCalled();
    expect(settingsManager._settings.value).toEqual(before);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(extensionChange).not.toHaveBeenCalled();
    expect(settingsManager._pendingUpdates.size).toBe(0);
  });

  it('leaves runtime state and events unchanged when setMultiple fails', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({
      EXTENSION_ENABLED: false,
      TRANSLATE_ON_TEXT_FIELDS: false
    });
    await settingsManager.initialize();

    const extensionChange = vi.fn();
    const fieldChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', extensionChange);
    settingsManager.onChange('TRANSLATE_ON_TEXT_FIELDS', fieldChange);
    const error = new Error('storage unavailable');
    storageManagerMock.set.mockImplementation(async () => {
      storageEvents.dispatch({
        EXTENSION_ENABLED: { oldValue: false, newValue: true },
        TRANSLATE_ON_TEXT_FIELDS: { oldValue: false, newValue: true }
      }, 'local');
      throw error;
    });

    await expect(settingsManager.setMultiple({
      EXTENSION_ENABLED: true,
      TRANSLATE_ON_TEXT_FIELDS: true
    })).rejects.toBe(error);

    expect(storageManagerMock.set).toHaveBeenCalledTimes(1);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(settingsManager.get('TRANSLATE_ON_TEXT_FIELDS')).toBe(false);
    expect(extensionChange).not.toHaveBeenCalled();
    expect(fieldChange).not.toHaveBeenCalled();
  });

  it('rejects unsupported fallback operations without using storage', async () => {
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });

    await settingsManager.initialize();
    storageManagerMock.get.mockClear();
    storageManagerMock.set.mockClear();
    storageManagerMock.clear.mockClear();

    await expect(settingsManager.reset()).rejects.toThrow(
      'SettingsManager reset is unavailable in fallback mode'
    );
    await expect(settingsManager.export()).rejects.toThrow(
      'SettingsManager export is unavailable in fallback mode'
    );
    await expect(settingsManager.import('settings-data')).rejects.toThrow(
      'SettingsManager import is unavailable in fallback mode'
    );

    expect(storageManagerMock.get).not.toHaveBeenCalled();
    expect(storageManagerMock.set).not.toHaveBeenCalled();
    expect(storageManagerMock.clear).not.toHaveBeenCalled();
  });

  it('uses runtime defaults for removed settings and ignores irrelevant changes', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });

    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    const defaultValue = settingsManager._defaults.EXTENSION_ENABLED;

    storageEvents.getListener()({
      EXTENSION_ENABLED: { oldValue: false, newValue: undefined },
      OPENAI_API_KEY: { oldValue: '', newValue: 'secret' }
    }, 'local');

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(defaultValue);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(defaultValue, false, 'EXTENSION_ENABLED');

    storageEvents.getListener()({
      EXTENSION_ENABLED: { oldValue: defaultValue, newValue: defaultValue }
    }, 'local');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('applies normal external runtime storage changes', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });

    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);

    storageEvents.dispatch({
      EXTENSION_ENABLED: { oldValue: false, newValue: true }
    }, 'local');

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true, false, 'EXTENSION_ENABLED');
  });

  it('emits one immediate event for a successful runtime write', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    storageManagerMock.set.mockImplementation(async () => {
      storageEvents.getListener()({
        EXTENSION_ENABLED: { oldValue: false, newValue: true }
      }, 'local');
    });

    await settingsManager.set('EXTENSION_ENABLED', true);

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true, false, 'EXTENSION_ENABLED');

    storageEvents.getListener()({
      EXTENSION_ENABLED: { oldValue: false, newValue: true }
    }, 'local');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not mutate runtime state or emit when a write fails', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    const error = new Error('storage unavailable');
    storageManagerMock.set.mockRejectedValue(error);

    await expect(settingsManager.set('EXTENSION_ENABLED', true)).rejects.toBe(error);

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores defaults when refresh finds removed fallback keys', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValueOnce({ EXTENSION_ENABLED: false });
    storageManagerMock.getFresh.mockResolvedValueOnce({});
    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    const defaultValue = settingsManager._defaults.EXTENSION_ENABLED;

    await expect(settingsManager.refreshSettings()).resolves.toBeUndefined();

    expect(storageManagerMock.getFresh).toHaveBeenCalledWith(Object.keys(settingsManager._defaults));
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(defaultValue);
    expect(onChange).toHaveBeenCalledWith(defaultValue, false, 'EXTENSION_ENABLED');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('rethrows refresh storage failures without mutating runtime state', async () => {
    storageManagerMock.get.mockResolvedValue({
      EXTENSION_ENABLED: false,
      TRANSLATE_ON_TEXT_FIELDS: false
    });
    await settingsManager.initialize();

    const onExtensionChange = vi.fn();
    const onFieldChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onExtensionChange);
    settingsManager.onChange('TRANSLATE_ON_TEXT_FIELDS', onFieldChange);
    const before = { ...settingsManager._settings.value };
    const error = new Error('refresh failed');
    storageManagerMock.getFresh.mockRejectedValue(error);

    await expect(settingsManager.refreshSettings()).rejects.toBe(error);

    expect(settingsManager._settings.value).toEqual(before);
    expect(onExtensionChange).not.toHaveBeenCalled();
    expect(onFieldChange).not.toHaveBeenCalled();
  });

  it('resolves without emitting when refresh values are unchanged', async () => {
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    storageManagerMock.getFresh.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    const stateBeforeRefresh = settingsManager._settings.value;

    await expect(settingsManager.refreshSettings()).resolves.toBeUndefined();

    expect(settingsManager._settings.value).toBe(stateBeforeRefresh);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rethrows context refresh failures after context handling', async () => {
    storageManagerMock.getFresh.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    const error = new Error('Extension context invalidated');
    const isContextError = vi
      .spyOn(ExtensionContextManager, 'isContextError')
      .mockReturnValue(true);
    const handleContextError = vi
      .spyOn(ExtensionContextManager, 'handleContextError')
      .mockReturnValue({ handled: true, silent: true });
    storageManagerMock.getFresh.mockRejectedValue(error);

    try {
      await expect(settingsManager.refreshSettings()).rejects.toBe(error);
      expect(handleContextError).toHaveBeenCalledWith(error, 'settings-manager-refresh');
    } finally {
      handleContextError.mockRestore();
      isContextError.mockRestore();
    }
  });

  it('recovers through the storage listener after a failed refresh', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    const error = new Error('refresh failed');
    storageManagerMock.getFresh.mockRejectedValue(error);

    await expect(settingsManager.refreshSettings()).rejects.toBe(error);

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    storageEvents.dispatch({
      EXTENSION_ENABLED: { oldValue: false, newValue: true }
    }, 'local');

    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true, false, 'EXTENSION_ENABLED');
  });

  it('applies browser storage value when cache-backed value is stale', async () => {
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });
    await settingsManager.initialize();

    storageManagerMock.getFresh.mockResolvedValue({ EXTENSION_ENABLED: true });

    await settingsManager.refreshSettings();

    expect(storageManagerMock.getFresh).toHaveBeenCalledWith(Object.keys(settingsManager._defaults));
    expect(storageManagerMock.get).toHaveBeenCalledTimes(1);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
  });

  it('removes fallback storage listener during destroy', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    await settingsManager.initialize();
    const listener = storageEvents.getListener();

    settingsManager.destroy();

    expect(storageEvents.onChanged.removeListener).toHaveBeenCalledWith(listener);
    expect(settingsManager._storageListenerSetup).toBe(false);
    expect(settingsManager._storageListener).toBeNull();
  });

  it('removes old listener before reinitializing fallback mode', async () => {
    const storageEvents = createStorageEventMock();
    browser.storage.onChanged = storageEvents.onChanged;
    storageManagerMock.get.mockResolvedValue({ EXTENSION_ENABLED: false });

    await settingsManager.initialize();
    const firstListener = storageEvents.getListener();

    settingsManager.destroy();

    expect(storageEvents.onChanged.removeListener).toHaveBeenCalledWith(firstListener);
    expect(storageEvents.getActiveListeners()).not.toContain(firstListener);

    await settingsManager.initialize();
    const secondListener = storageEvents.getListener();

    expect(secondListener).toEqual(expect.any(Function));
    expect(secondListener).not.toBe(firstListener);
    expect(storageEvents.onChanged.addListener).toHaveBeenCalledTimes(2);
    expect(storageEvents.getActiveListeners()).toEqual([secondListener]);
    expect(settingsManager._storageListenerSetup).toBe(true);

    const onChange = vi.fn();
    settingsManager.onChange('EXTENSION_ENABLED', onChange);
    storageEvents.dispatch({
      EXTENSION_ENABLED: { oldValue: false, newValue: true }
    }, 'local');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(settingsManager.get('EXTENSION_ENABLED')).toBe(true);
  });

  it('rejects fallback keys missing from canonical persisted defaults', async () => {
    vi.resetModules();
    vi.doMock('@/shared/config/settingsDefaults.js', () => ({
      getPersistedDefaultSettings: () => ({})
    }));

    await expect(import('./SettingsManager.js')).rejects.toThrow(
      'Fallback settings missing canonical persisted defaults: APPLICATION_LOCALIZE'
    );
  });
});

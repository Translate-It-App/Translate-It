import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import browser from 'webextension-polyfill';
import useSettingsStore from './settings.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import secureStorage from '@/shared/storage/core/SecureStorage.js';
import { SelectionTranslationMode, CONFIG, TranslationMode } from '@/shared/config/config.js';
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js';
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js';
import { runSettingsMigrations } from '@/shared/config/settingsMigrations.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import {
  addDesktopFabExclusion,
  listDesktopFabExclusions,
  DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY,
} from '@/features/desktop-fab/desktopFabExclusions.js';
import { MissingDeepLLanguageKeyError } from '@/features/translation/providers/DeepLLanguageDiscovery.js';

const deepLLanguageDiscoveryMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  fetchFailover: vi.fn(),
  identity: vi.fn(),
}));

vi.mock('@/features/translation/providers/DeepLLanguageDiscovery.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchDeepLLanguageCatalog: (...args) => deepLLanguageDiscoveryMocks.fetch(...args),
    fetchDeepLLanguageCatalogWithKeyFailover: (...args) => deepLLanguageDiscoveryMocks.fetchFailover(...args),
    getDeepLLanguageIdentity: (...args) => deepLLanguageDiscoveryMocks.identity(...args),
  };
});

// Mock Dependencies
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(true),
    getFresh: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn()
  }
}));

vi.mock('@/shared/storage/core/SecureStorage.js', () => ({
  default: {
    prepareForExport: vi.fn().mockResolvedValue({ encrypted: 'data' }),
    processImportedSettings: vi.fn().mockResolvedValue({ THEME: 'dark' })
  }
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn(),
    isContentScript: vi.fn().mockReturnValue(false)
  }
}));

// Mock logger to avoid console noise
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock('@/shared/config/settingsMigrations.js', () => ({
  runSettingsMigrations: vi.fn().mockResolvedValue({ updates: { THEME: 'dark' }, logs: [] })
}));

describe('Settings Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    browser.runtime.sendMessage.mockResolvedValue({
      success: true,
      state: { ids: [], revision: 1 }
    });
    deepLLanguageDiscoveryMocks.fetch.mockReset();
    deepLLanguageDiscoveryMocks.fetchFailover.mockReset();
    deepLLanguageDiscoveryMocks.fetchFailover.mockImplementation(
      (options) => deepLLanguageDiscoveryMocks.fetch(options),
    );
    deepLLanguageDiscoveryMocks.identity.mockImplementation((keys, tier = 'free') => {
      const selected = String(keys || '').split('\n').map(key => key.trim()).filter(Boolean)
        .find(key => tier !== 'pro' || !key.endsWith(':fx'));
      if (!selected) throw new MissingDeepLLanguageKeyError();
      return `${tier}:${selected}`;
    });
    deepLLanguageDiscoveryMocks.fetch.mockImplementation(async ({ apiKey, apiTier }) => ({
      catalog: [],
      identity: deepLLanguageDiscoveryMocks.identity(apiKey, apiTier),
      fetchedAt: Date.now(),
    }));
  });

  const getStorageChangeListener = async (store) => {
    await store.loadSettings();
    return storageManager.on.mock.calls.at(-1)?.[1];
  };

  describe('API-key promotion reconciliation', () => {
    it('protects a dirty API-key draft while syncing clean API keys', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');

      onChange({ key: 'OPENAI_API_KEY', newValue: 'promoted-key', oldValue: 'stored-key' });
      onChange({ key: 'GEMINI_API_KEY', newValue: 'clean-promotion', oldValue: '' });

      expect(store.settings.OPENAI_API_KEY).toBe('draft-key');
      expect(store.settings.GEMINI_API_KEY).toBe('clean-promotion');
    });

    it('persists a dirty key and clears its dirty state only after successful Save', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'intentional-key');

      await store.saveAllSettings();
      onChange({ key: 'OPENAI_API_KEY', newValue: 'later-promotion', oldValue: 'intentional-key' });

      expect(storageManager.set.mock.calls.at(-1)[0].OPENAI_API_KEY).toBe('intentional-key');
      expect(store.settings.OPENAI_API_KEY).toBe('later-promotion');
    });

    it('retains a dirty draft after a failed Save', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');
      storageManager.set.mockRejectedValueOnce(new Error('storage failed'));

      await expect(store.saveAllSettings()).rejects.toThrow('storage failed');
      onChange({ key: 'OPENAI_API_KEY', newValue: 'promoted-key', oldValue: '' });

      expect(store.settings.OPENAI_API_KEY).toBe('draft-key');
    });

    it('does not clear a newer edit made while Save is in flight', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'first-draft');
      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve; }));

      const saving = store.saveAllSettings();
      store.updateSettingLocally('OPENAI_API_KEY', 'newer-draft');
      resolveWrite(true);
      await saving;
      onChange({ key: 'OPENAI_API_KEY', newValue: 'promotion', oldValue: '' });

      expect(store.settings.OPENAI_API_KEY).toBe('newer-draft');
    });

    it('tracks dirty state independently for each provider key', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'openai-draft');

      onChange({ key: 'OPENAI_API_KEY', newValue: 'openai-promotion', oldValue: '' });
      onChange({ key: 'GEMINI_API_KEY', newValue: 'gemini-promotion', oldValue: '' });

      expect(store.settings.OPENAI_API_KEY).toBe('openai-draft');
      expect(store.settings.GEMINI_API_KEY).toBe('gemini-promotion');
    });

    it('continues syncing unrelated settings while an API key is dirty', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');

      onChange({ key: 'THEME', newValue: 'dark', oldValue: 'auto' });

      expect(store.settings.OPENAI_API_KEY).toBe('draft-key');
      expect(store.settings.THEME).toBe('dark');
    });

    it('clears draft tracking after reset and reload', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');
      await store.resetSettings();
      onChange({ key: 'OPENAI_API_KEY', newValue: 'external-key', oldValue: '' });
      expect(store.settings.OPENAI_API_KEY).toBe('external-key');

      store.updateSettingLocally('OPENAI_API_KEY', 'another-draft');
      store.isInitialized = false;
      storageManager.get.mockResolvedValueOnce({ OPENAI_API_KEY: 'loaded-key' });
      await store.loadSettings();
      onChange({ key: 'OPENAI_API_KEY', newValue: 'reloaded-promotion', oldValue: '' });
      expect(store.settings.OPENAI_API_KEY).toBe('reloaded-promotion');
    });

    it('clears prior draft tracking when importing settings', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        OPENAI_API_KEY: 'imported-key'
      });

      await store.importSettings({ THEME: 'dark', _exported: true });
      onChange({ key: 'OPENAI_API_KEY', newValue: 'promoted-after-import', oldValue: '' });

      expect(store.settings.OPENAI_API_KEY).toBe('promoted-after-import');
    });
  });

  describe('custom provider list settings', () => {
    it('persists custom provider list settings through Save', async () => {
      const store = useSettingsStore();
      store.updateSettingLocally('CUSTOM_PROVIDER_LIST_ENABLED', true);
      store.updateSettingLocally('CUSTOM_PROVIDER_LIST', ['openai', 'gemini']);

      await store.saveAllSettings();

      expect(storageManager.set).toHaveBeenCalledWith(expect.objectContaining({
        CUSTOM_PROVIDER_LIST_ENABLED: true,
        CUSTOM_PROVIDER_LIST: ['openai', 'gemini']
      }));
    });

    it('syncs cross-context updates and preserves existing dirty drafts', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('OPENAI_API_KEY', 'draft-key');

      onChange({ key: 'CUSTOM_PROVIDER_LIST_ENABLED', newValue: true, oldValue: false });
      onChange({
        key: 'CUSTOM_PROVIDER_LIST',
        newValue: ['gemini', 'openai'],
        oldValue: []
      });
      onChange({ key: 'OPENAI_API_KEY', newValue: 'external-key', oldValue: '' });

      expect(store.settings.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
      expect(store.settings.CUSTOM_PROVIDER_LIST).toEqual(['gemini', 'openai']);
      expect(store.settings.OPENAI_API_KEY).toBe('draft-key');
    });

    it('includes custom provider list settings in export and imports them', async () => {
      const exportedSettings = {
        CUSTOM_PROVIDER_LIST_ENABLED: true,
        CUSTOM_PROVIDER_LIST: ['openai', 'gemini']
      };
      secureStorage.prepareForExport.mockResolvedValueOnce(exportedSettings);
      const store = useSettingsStore();
      store.settings.CUSTOM_PROVIDER_LIST_ENABLED = true;
      store.settings.CUSTOM_PROVIDER_LIST = ['openai', 'gemini'];

      const exported = await store.exportSettings();
      expect(exported).toMatchObject(exportedSettings);
      expect(secureStorage.prepareForExport).toHaveBeenCalledWith(
        expect.objectContaining(exportedSettings),
        ''
      );

      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        ...exportedSettings
      });
      await store.importSettings({ _exported: true, ...exportedSettings });

      expect(store.settings.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
      expect(store.settings.CUSTOM_PROVIDER_LIST).toEqual(['openai', 'gemini']);
      expect(storageManager.set).toHaveBeenCalledWith(expect.objectContaining(exportedSettings));
    });
  });

  describe('provider category collapse persistence', () => {
    it('restores persisted collapsed categories in a fresh store while others stay expanded', async () => {
      storageManager.get.mockResolvedValueOnce({
        COLLAPSED_PROVIDER_CATEGORIES: { ids: ['ai'], revision: 7 }
      });
      setActivePinia(createPinia());
      const store = useSettingsStore();

      await store.loadSettings();

      expect(storageManager.get).toHaveBeenCalledWith(null);
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: ['ai'], revision: 7 });
    });

    it('persists category intents through the background serializer', async () => {
      const store = useSettingsStore();
      browser.runtime.sendMessage.mockResolvedValueOnce({
        success: true,
        state: { ids: ['free'], revision: 3 }
      });

      await expect(store.setProviderCategoryCollapsed('free', true)).resolves.toEqual({
        ids: ['free'],
        revision: 3
      });
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'SET_PROVIDER_CATEGORY_COLLAPSED',
        categoryId: 'free',
        collapsed: true
      });
    });

    it('dispatches rapid category intents in invocation order without optimistic state', async () => {
      const store = useSettingsStore();
      const requests = [];
      browser.runtime.sendMessage.mockImplementation(message => new Promise(resolve => {
        requests.push({ message, resolve });
      }));

      const first = store.setProviderCategoryCollapsed('free', true);
      const second = store.setProviderCategoryCollapsed('ai', true);
      const third = store.setProviderCategoryCollapsed('local', true);
      await Promise.resolve();

      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(requests[0].message).toMatchObject({ categoryId: 'free', collapsed: true });
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 0 });

      requests[0].resolve({ success: true, state: { ids: ['free'], revision: 1 } });
      await first;
      await Promise.resolve();
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
      expect(requests[1].message).toMatchObject({ categoryId: 'ai', collapsed: true });

      requests[1].resolve({ success: true, state: { ids: ['free', 'ai'], revision: 2 } });
      await second;
      await Promise.resolve();
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(3);
      expect(requests[2].message).toMatchObject({ categoryId: 'local', collapsed: true });

      requests[2].resolve({ success: true, state: { ids: ['free', 'ai', 'local'], revision: 3 } });
      await third;
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({
        ids: ['free', 'ai', 'local'],
        revision: 3
      });
    });

    it('continues the invocation queue after rejection and ignores a stale event', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      const requests = [];
      browser.runtime.sendMessage.mockImplementation(message => new Promise((resolve, reject) => {
        requests.push({ message, resolve, reject });
      }));

      const first = store.setProviderCategoryCollapsed('ai', true);
      const second = store.setProviderCategoryCollapsed('local', true);
      await Promise.resolve();
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);

      const requestError = new Error('request failed');
      requests[0].reject(requestError);
      await expect(first).rejects.toBe(requestError);
      await Promise.resolve();
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
      expect(requests[1].message).toMatchObject({ categoryId: 'local', collapsed: true });

      requests[1].resolve({ success: true, state: { ids: ['local'], revision: 9 } });
      await second;
      onChange({
        key: 'COLLAPSED_PROVIDER_CATEGORIES',
        newValue: { ids: ['ai'], revision: 8 },
        oldValue: { ids: [], revision: 7 }
      });
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: ['local'], revision: 9 });
    });

    it('ignores delayed older storage events and excludes the key from ordinary Save', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.settings.COLLAPSED_PROVIDER_CATEGORIES = { ids: ['local'], revision: 8 };
      onChange({
        key: 'COLLAPSED_PROVIDER_CATEGORIES',
        newValue: { ids: ['free'], revision: 7 },
        oldValue: { ids: [], revision: 6 }
      });

      await store.saveAllSettings();

      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: ['local'], revision: 8 });
      expect(storageManager.set.mock.calls.at(-1)[0]).not.toHaveProperty('COLLAPSED_PROVIDER_CATEGORIES');
    });

    it('does not update local state when the serializer request fails', async () => {
      const store = useSettingsStore();
      const error = new Error('background unavailable');
      browser.runtime.sendMessage.mockRejectedValueOnce(error);

      await expect(store.setProviderCategoryCollapsed('ai', true)).rejects.toBe(error);
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 0 });
    });

    it('rejects generic persistence APIs for serialized category state', async () => {
      const store = useSettingsStore();
      const collapseState = { ids: ['free'], revision: 4 };

      await expect(store.updateSettingAndPersist('COLLAPSED_PROVIDER_CATEGORIES', collapseState))
        .rejects.toThrow('Use setProviderCategoryCollapsed');
      await expect(store.updateMultipleSettings({ COLLAPSED_PROVIDER_CATEGORIES: collapseState }))
        .rejects.toThrow('Use setProviderCategoryCollapsed');

      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 0 });
      expect(storageManager.set).not.toHaveBeenCalled();
    });

    it('exports and imports category IDs through canonical settings', async () => {
      const store = useSettingsStore();
      store.settings.COLLAPSED_PROVIDER_CATEGORIES = { ids: ['ai', 'free'], revision: 5 };
      await store.exportSettings();
      expect(secureStorage.prepareForExport).toHaveBeenCalledWith(
        expect.objectContaining({
          COLLAPSED_PROVIDER_CATEGORIES: { ids: ['ai', 'free'], revision: 5 }
        }),
        ''
      );

      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        COLLAPSED_PROVIDER_CATEGORIES: { ids: ['local'], revision: 999 }
      });
      browser.runtime.sendMessage.mockResolvedValueOnce({
        success: true,
        state: { ids: ['local'], revision: 6 }
      });
      await store.importSettings({ _exported: true, THEME: 'dark' });

      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'SET_PROVIDER_CATEGORY_COLLAPSED',
        replace: true,
        ids: ['local']
      }));
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: ['local'], revision: 6 });
    });

    it('replaces collapse state during reset without writing it from the full default snapshot', async () => {
      const store = useSettingsStore();
      browser.runtime.sendMessage.mockResolvedValueOnce({
        success: true,
        state: { ids: [], revision: 12 }
      });

      await store.resetSettings();

      expect(storageManager.set.mock.calls.at(-1)[0]).not.toHaveProperty('COLLAPSED_PROVIDER_CATEGORIES');
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'SET_PROVIDER_CATEGORY_COLLAPSED',
        replace: true,
        ids: []
      }));
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 12 });
    });

    it('queues reset replacement after a pending toggle and continues after its rejection', async () => {
      const store = useSettingsStore();
      const requests = [];
      browser.runtime.sendMessage.mockImplementation(message => new Promise((resolve, reject) => {
        requests.push({ message, resolve, reject });
      }));

      const toggle = store.setProviderCategoryCollapsed('ai', true);
      const reset = store.resetSettings();
      await Promise.resolve();
      expect(requests).toHaveLength(1);
      expect(requests[0].message).toMatchObject({ categoryId: 'ai', collapsed: true });

      requests[0].reject(new Error('toggle failed'));
      await expect(toggle).rejects.toThrow('toggle failed');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1].message).toMatchObject({ replace: true, ids: [] });

      requests[1].resolve({ success: true, state: { ids: [], revision: 2 } });
      await reset;
      expect(store.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 2 });
    });
  });

  describe('provider model draft reconciliation', () => {
    it('protects each dirty provider group while clean provider groups sync independently', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      const modelKeys = [
        'GEMINI_MODEL', 'OPENAI_API_MODEL', 'OPENROUTER_API_MODEL',
        'REQUESTY_API_MODEL', 'CHEAPERINFERENCE_API_MODEL', 'DEEPSEEK_API_MODEL', 'WEBAI_API_MODEL'
      ];

      store.updateSettingLocally('OPENAI_API_MODEL', 'draft/openai');
      onChange({ key: 'WEBAI_API_MODEL', newValue: 'clean/webai', oldValue: '' });
      expect(store.settings.WEBAI_API_MODEL).toBe('clean/webai');

      modelKeys.forEach((key) => store.updateSettingLocally(key, `draft/${key}`));
      onChange({ key: 'GEMINI_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      onChange({ key: 'GEMINI_API_URL', newValue: 'https://external.example/gemini', oldValue: '' });
      onChange({ key: 'OPENAI_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      onChange({ key: 'OPENROUTER_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      onChange({ key: 'DEEPSEEK_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });

      for (const key of modelKeys) {
        expect(store.settings[key]).toBe(`draft/${key}`);
        expect(store.isSettingDirty(key)).toBe(true);
      }
      expect(store.settings.GEMINI_MODEL_SOURCE).not.toBe('catalog');
      expect(store.settings.GEMINI_API_URL).not.toBe('https://external.example/gemini');
      expect(store.settings.OPENAI_MODEL_SOURCE).not.toBe('catalog');
      expect(store.settings.OPENROUTER_MODEL_SOURCE).not.toBe('catalog');
      expect(store.settings.DEEPSEEK_MODEL_SOURCE).not.toBe('catalog');
    });

    it('syncs clean model settings and resumes external updates after successful Save', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      onChange({ key: 'WEBAI_API_MODEL', newValue: 'clean/external-model', oldValue: '' });
      expect(store.settings.WEBAI_API_MODEL).toBe('clean/external-model');
      expect(store.isSettingDirty('WEBAI_API_MODEL')).toBe(false);

      store.updateSettingLocally('OPENAI_API_MODEL', 'draft/custom-model');
      store.updateSettingLocally('OPENAI_MODEL_SOURCE', 'custom');
      onChange({ key: 'OPENAI_API_MODEL', newValue: 'external/before-save', oldValue: '' });
      onChange({ key: 'OPENAI_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      expect(store.settings.OPENAI_API_MODEL).toBe('draft/custom-model');
      expect(store.settings.OPENAI_MODEL_SOURCE).toBe('custom');

      await store.saveAllSettings();
      expect(store.isSettingDirty('OPENAI_API_MODEL')).toBe(false);
      onChange({ key: 'OPENAI_API_MODEL', newValue: 'external/after-save', oldValue: 'draft/custom-model' });
      onChange({ key: 'OPENAI_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      expect(store.settings.OPENAI_API_MODEL).toBe('external/after-save');
      expect(store.settings.OPENAI_MODEL_SOURCE).toBe('catalog');
    });

    it('retains model and source drafts after failed Save and newer in-flight edits', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('DEEPSEEK_API_MODEL', 'first/custom-draft');
      store.updateSettingLocally('DEEPSEEK_MODEL_SOURCE', 'custom');
      storageManager.set.mockRejectedValueOnce(new Error('storage failed'));
      await expect(store.saveAllSettings()).rejects.toThrow('storage failed');
      onChange({ key: 'DEEPSEEK_API_MODEL', newValue: 'external/failed-save', oldValue: '' });
      expect(store.settings.DEEPSEEK_API_MODEL).toBe('first/custom-draft');
      expect(store.isSettingDirty('DEEPSEEK_MODEL_SOURCE')).toBe(true);

      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve; }));
      const saving = store.saveAllSettings();
      store.updateSettingLocally('DEEPSEEK_API_MODEL', 'newer/custom-draft');
      resolveWrite(true);
      await saving;
      onChange({ key: 'DEEPSEEK_API_MODEL', newValue: 'external/in-flight', oldValue: '' });
      onChange({ key: 'DEEPSEEK_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      expect(store.settings.DEEPSEEK_API_MODEL).toBe('newer/custom-draft');
      expect(store.settings.DEEPSEEK_MODEL_SOURCE).toBe('custom');
      expect(store.isSettingDirty('DEEPSEEK_API_MODEL')).toBe(true);
    });

    it('protects Gemini URL, model, and source together until Save succeeds', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      store.updateSettingLocally('GEMINI_API_URL', 'https://custom.local/models/draft');
      store.updateSettingLocally('GEMINI_MODEL_SOURCE', 'custom');
      onChange({ key: 'GEMINI_MODEL', newValue: 'external/model', oldValue: '' });
      onChange({ key: 'GEMINI_MODEL_SOURCE', newValue: 'catalog', oldValue: 'custom' });
      onChange({ key: 'GEMINI_API_URL', newValue: 'https://external.example/models', oldValue: '' });
      expect(store.settings.GEMINI_MODEL).toBe(CONFIG.GEMINI_MODEL);
      expect(store.settings.GEMINI_MODEL_SOURCE).toBe('custom');
      expect(store.settings.GEMINI_API_URL).toBe('https://custom.local/models/draft');

      await store.saveAllSettings();
      onChange({ key: 'GEMINI_MODEL', newValue: 'external/after-save', oldValue: CONFIG.GEMINI_MODEL });
      expect(store.settings.GEMINI_MODEL).toBe('external/after-save');
    });
  });

  it('should initialize with default settings', () => {
    const store = useSettingsStore();
    expect(store.settings.THEME).toBe('auto');
  });

  it('should not seed non-editable prompt wrappers into default settings', () => {
    const store = useSettingsStore();

    // Editable prompts remain seeded
    expect(store.settings.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
    expect(store.settings.PROMPT_SUBTITLE_USER).toBe(CONFIG.PROMPT_SUBTITLE_USER);

    // Non-editable wrappers are CONFIG-owned and must not be persisted
    expect(store.settings.PROMPT_BASE_AI_BATCH).toBeUndefined();
    expect(store.settings.PROMPT_BASE_AI_BATCH_AUTO).toBeUndefined();
    expect(store.settings.PROMPT_BASE_SELECT).toBeUndefined();
    expect(store.settings.PROMPT_BASE_BATCH).toBeUndefined();
    expect(store.settings.PROMPT_BASE_AI_FOLLOWUP).toBeUndefined();
    expect(store.settings.PROMPT_BASE_AI_FOLLOWUP_AUTO).toBeUndefined();
    expect(store.settings.PROMPT_BASE_SCREEN_CAPTURE).toBeUndefined();
    expect(store.settings.PROMPT_SUBTITLE_BASE).toBeUndefined();
    expect(store.settings.PROMPT_SUBTITLE_BATCH).toBeUndefined();
  });

  it('should initialize with canonical persisted default keys', () => {
    const store = useSettingsStore();

    expect(Object.keys(store.settings).sort()).toEqual(
      [...Object.keys(getPersistedDefaultSettings()), 'translationHistory'].sort()
    );
    expect(store.settings.translationHistory).toEqual([]);
  });

  describe('WINDOW_SHOW_ORIGINAL persistence', () => {
    it('uses the false CONFIG default and restores its persisted value', async () => {
      expect(CONFIG.WINDOW_SHOW_ORIGINAL).toBe(false);
      expect(getPersistedDefaultSettings().WINDOW_SHOW_ORIGINAL).toBe(false);
      storageManager.get.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: true });

      const store = useSettingsStore();
      await store.loadSettings();

      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
    });

    it('keeps a local preference update made while initial storage load is pending', async () => {
      let resolveLoad;
      storageManager.get.mockImplementationOnce(() => new Promise(resolve => { resolveLoad = resolve; }));
      const store = useSettingsStore();
      const loading = store.loadSettings();

      await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
      resolveLoad({ WINDOW_SHOW_ORIGINAL: false });
      await loading;

      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
    });

    it('serializes rapid writes in invocation order and leaves the latest preference in storage', async () => {
      const store = useSettingsStore();
      const writes = [];
      const persisted = {};
      storageManager.set.mockImplementation(settings => new Promise(resolve => {
        writes.push({ settings, resolve: () => {
          Object.assign(persisted, settings);
          resolve(true);
        } });
      }));

      try {
        const first = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        const second = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false);
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].settings).toEqual({ WINDOW_SHOW_ORIGINAL: true });

        writes[0].resolve();
        await first;
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[1].settings).toEqual({ WINDOW_SHOW_ORIGINAL: false });
        writes[1].resolve();
        await second;

        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        // Restore the resolving default or later suites hang on this mock.
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('ignores stale storage notifications while its queued write is pending', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));

      try {
        const pending = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);

        // A stale/older external notification observed while our write is
        // queued must not overwrite the newer local preference.
        onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // The queued write reaches storage after a few microtask hops.
        await vi.waitFor(() => expect(storageManager.set).toHaveBeenCalledTimes(1));
        // The dropped notification is reconciled against durable storage once
        // the queue settles; our own write is the durable value there.
        storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: true });
        resolveWrite(true);
        await pending;
        await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalledWith('WINDOW_SHOW_ORIGINAL'));
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Legitimate external synchronization resumes once pending writes settle;
        // the notification is confirmed against durable storage before applying.
        storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: false });
        onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: true });
        await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('reconciles an external notification that was missed while a local write was pending', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      // Durable storage after our write and the other tab's commit holds false.
      storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: false });

      try {
        const pending = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(storageManager.set).toHaveBeenCalledTimes(1));

        // Another tab commits false while our write is still queued: the
        // notification is dropped for now, but it must not be lost.
        onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        resolveWrite(true);
        await pending;

        // Once the queue settles the missed change is reconciled against
        // durable storage.
        await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('keeps the local preference when a newer local toggle happens during the reconciliation', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      let resolveGet;
      storageManager.getFresh.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));

      try {
        const pending = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(storageManager.set).toHaveBeenCalledTimes(1));
        onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });

        resolveWrite(true);
        await pending;
        // The reconciliation is now reading durable storage.
        await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalled());

        // A newer local toggle owns the value while the reconciliation reads.
        const newer = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false);
        resolveGet({ WINDOW_SHOW_ORIGINAL: true });
        await newer;

        await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('reconciles after a failed write so the local state does not stay divergent', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: false });
      storageManager.set.mockRejectedValueOnce(new Error('storage failed'));

      await expect(store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true)).rejects.toThrow('storage failed');

      // The write never landed, so the local state returns to the durable value.
      await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
    });

    it('falls back to the canonical default when a failed first write left no stored preference', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      // Durable storage has no entry for this key: the first write never landed.
      storageManager.getFresh.mockResolvedValueOnce({});
      storageManager.set.mockRejectedValueOnce(new Error('storage failed'));

      await expect(store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true)).rejects.toThrow('storage failed');

      // The local state returns to the canonical default instead of keeping the
      // intent that was never persisted.
      await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
    });

    // A reconciliation reads durable storage asynchronously; Reset and Import
    // can change the preference while that read is in flight.
    const startPausedReconciliation = async (store, onChange) => {
      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      let resolveGet;
      storageManager.getFresh.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));

      const pending = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
      await vi.waitFor(() => expect(storageManager.set).toHaveBeenCalledTimes(1));
      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });
      resolveWrite(true);
      await pending;
      // The reconciliation is now reading durable storage.
      await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalled());
      return resolveGet;
    };

    it('a Reset that changes the preference invalidates an in-flight reconciliation', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      try {
        const resolveGet = await startPausedReconciliation(store, onChange);

        // Reset applies its default preference while the read is paused.
        await store.resetSettings();
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

        // The stale read must not resurrect the pre-Reset value.
        resolveGet({ WINDOW_SHOW_ORIGINAL: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('an Import that changes the preference invalidates an in-flight reconciliation', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        WINDOW_SHOW_ORIGINAL: false,
      });
      runSettingsMigrations.mockResolvedValueOnce({ updates: {}, removals: [], logs: [] });

      try {
        const resolveGet = await startPausedReconciliation(store, onChange);

        // The import applies the backed-up preference while the read is paused.
        await store.importSettings({ _exported: true, THEME: 'dark', WINDOW_SHOW_ORIGINAL: false });
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

        // The stale read must not resurrect the pre-import value.
        resolveGet({ WINDOW_SHOW_ORIGINAL: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a Reset cancelled before applying its preference keeps the in-flight reconciliation valid', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      try {
        const resolveGet = await startPausedReconciliation(store, onChange);

        // The Reset fails before it applies its preference, so it must not
        // invalidate the pending reconciliation.
        storageManager.get.mockRejectedValueOnce(new Error('storage read failed'));
        await expect(store.resetSettings()).rejects.toThrow('storage read failed');
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // The reconciliation still applies the confirmed durable value.
        resolveGet({ WINDOW_SHOW_ORIGINAL: false });
        await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    // A Reset/Import is a newer preference intent even when it reapplies the
    // same value, so an older in-flight reconciliation must not resurrect a
    // stale durable read.
    const startPausedReconciliationAtSameValue = async (store, onChange) => {
      let resolveWrite;
      storageManager.set.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      let resolveGet;
      storageManager.getFresh.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));

      // Re-persist the current value so a notification is missed while a write
      // is pending and a reconciliation is requested.
      const pending = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false);
      await vi.waitFor(() => expect(storageManager.set).toHaveBeenCalledTimes(1));
      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: true, oldValue: false });
      resolveWrite(true);
      await pending;
      await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalled());
      return resolveGet;
    };

    it('a same-value Reset invalidates an in-flight reconciliation', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      try {
        const resolveGet = await startPausedReconciliationAtSameValue(store, onChange);

        // Reset reapplies the same default value.
        await store.resetSettings();
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

        // The stale read must not replace the re-applied preference.
        resolveGet({ WINDOW_SHOW_ORIGINAL: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a same-value Import invalidates an in-flight reconciliation', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        WINDOW_SHOW_ORIGINAL: false,
      });
      runSettingsMigrations.mockResolvedValueOnce({ updates: {}, removals: [], logs: [] });
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      try {
        const resolveGet = await startPausedReconciliationAtSameValue(store, onChange);

        // The import reapplies the same backed-up value.
        await store.importSettings({ _exported: true, THEME: 'dark', WINDOW_SHOW_ORIGINAL: false });
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

        // The stale read must not replace the re-applied preference.
        resolveGet({ WINDOW_SHOW_ORIGINAL: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    // A notification confirms itself against durable storage asynchronously; a
    // Reset/Import that completes during that read owns the preference.
    const startPausedNotificationValidation = async (store, onChange) => {
      let resolveGet;
      storageManager.getFresh.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));
      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: true, oldValue: false });
      // The confirmation is now reading durable storage.
      await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalled());
      return resolveGet;
    };

    it('rejects a stale notification that overlaps a successful Reset', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      const resolveGet = await startPausedNotificationValidation(store, onChange);

      // A successful Reset reapplies the default preference.
      await store.resetSettings();
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      // The stale confirmation must not replace the re-applied preference.
      resolveGet({ WINDOW_SHOW_ORIGINAL: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
    });

    it('rejects a stale notification that overlaps a successful Import', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        WINDOW_SHOW_ORIGINAL: false,
      });
      runSettingsMigrations.mockResolvedValueOnce({ updates: {}, removals: [], logs: [] });
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      const resolveGet = await startPausedNotificationValidation(store, onChange);

      // A successful Import applies the backed-up preference.
      await store.importSettings({ _exported: true, THEME: 'dark', WINDOW_SHOW_ORIGINAL: false });
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

      // The stale confirmation must not replace the applied preference.
      resolveGet({ WINDOW_SHOW_ORIGINAL: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
    });

    it('ignores a delayed stale notification that arrives after all queued writes settle', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
      // Durable storage holds the newest committed preference.
      storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: true });

      // A delayed notification from the superseded older write arrives late.
      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });
      await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalledWith('WINDOW_SHOW_ORIGINAL'));

      await vi.waitFor(() => { expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true); });
      // Keep the local preference even across following ticks.
      await nextTick();
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
    });

    it('applies a settled notification when it still matches durable storage', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
      // Another context commits false afterwards; the echoed notification matches
      // durable storage, so it must apply despite transcending the write history.
      storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: false });

      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: true });
      await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false));
    });

    it('rejects a stale full-snapshot notification when durable storage keeps the newest value', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
      await store.saveAllSettings(); // full save excludes this key; durable keeps the narrow-write value
      // A delayed notification from an older occurrence arrives afterwards.
      storageManager.getFresh.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: true });

      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: false, oldValue: false });
      await vi.waitFor(() => expect(storageManager.getFresh).toHaveBeenCalledTimes(1));

      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
    });

    it('does not apply a non-boolean or detached notification value for this key', async () => {
      const store = useSettingsStore();
      const onChange = await getStorageChangeListener(store);

      await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);

      // e.g. a storage.remove() emits newValue undefined for this key.
      onChange({ key: 'WINDOW_SHOW_ORIGINAL', newValue: undefined, oldValue: true });
      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      expect(storageManager.getFresh).not.toHaveBeenCalled();
    });

    it('unrelated full save excludes the window preference and cannot clobber a newer toggle committed out of order', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Full-snapshot save starts first but completes after the toggle.
        const saving = store.saveAllSettings();
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].snapshot).not.toHaveProperty('WINDOW_SHOW_ORIGINAL');

        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(writes).toHaveLength(2));

        // Toggle commits BEFORE the delayed full-snapshot save completes.
        writes[1].resolve();
        await toggle;
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        writes[0].resolve();
        await saving;

        // The late snapshot write carried no value for this key, so the newer
        // committed preference survives in durable storage and locally.
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('explicit updateMultipleSettings for this key joins the queued order of narrow toggles', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Multi-update (false) is issued first; a narrow toggle (true) joins
        // the same queue behind it. Completions are forced out of order.
        const multi = store.updateMultipleSettings({ WINDOW_SHOW_ORIGINAL: false, THEME: 'dark' });
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[0].snapshot).toEqual({ THEME: 'dark' });
        expect(writes[1].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });

        // The toggle applies locally and joins the queue behind the pending
        // false key-write before that write has even settled.
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        writes[1].resolve(); // stale false reaches durable storage first
        await vi.waitFor(() => expect(writes).toHaveLength(3));
        expect(writes[2].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: true });

        writes[0].resolve();
        await multi;
        writes[2].resolve(); // the queued toggle commits last and wins
        await toggle;

        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(persisted.THEME).toBe('dark');
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('resetSettings routes the window preference default through the serialized write queue after a pending toggle', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Pending toggle (true) issued first; Reset joins the queue behind it
        // and must still win.
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: true });

        // The durable copy still holds the key, so broad removal must skip it.
        storageManager.get.mockResolvedValueOnce({ WINDOW_SHOW_ORIGINAL: true, THEME: 'dark' });
        const resetting = store.resetSettings();
        await vi.waitFor(() => expect(storageManager.remove).toHaveBeenCalledWith(['THEME']));
        expect(storageManager.remove.mock.calls.every(([keys]) => (
          !(Array.isArray(keys)) || !keys.includes('WINDOW_SHOW_ORIGINAL')
        ))).toBe(true);
        // Reset already replaced local state with defaults while its queued
        // write is still waiting behind the pending toggle.
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);

        writes[0].resolve(); // the older toggle commits first
        await toggle;
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[1].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });
        writes[1].resolve(); // reset's queued default commits after the toggle and wins

        await vi.waitFor(() => expect(writes).toHaveLength(3));
        expect(writes[2]).not.toHaveProperty('snapshot.WINDOW_SHOW_ORIGINAL'); // defaults snapshot carries no value for this key
        writes[2].resolve();
        await resetting;

        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(false);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('resetSettings queues its default before a newer toggle, which then wins', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Reset issues its queued default (false) first.
        const resetting = store.resetSettings();
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });

        // A newer toggle applies locally and joins the queue behind the
        // reset's still-pending default write.
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        writes[0].resolve(); // reset's default (false) commits; the defaults snapshot and the newer toggle's queued write dispatch afterwards
        await vi.waitFor(() => expect(writes).toHaveLength(3));
        expect(writes[1]).not.toHaveProperty('snapshot.WINDOW_SHOW_ORIGINAL'); // defaults snapshot carries no value for this key
        expect(writes[2].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: true });

        writes[1].resolve();
        await resetting;
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(false);

        writes[2].resolve(); // the newer toggle commits after the reset and wins
        await toggle;

        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a toggle issued while Reset awaits storageManager.get() supersedes Reset', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Reset reserves its queue slot synchronously but the default write
        // stays gated behind the prerequisite storage read.
        let resolveGet;
        storageManager.get.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));
        const resetting = store.resetSettings();
        expect(storageManager.set).not.toHaveBeenCalled();

        // A newer toggle issued while Reset awaits the storage read queues
        // behind the reservation and owns the newest intent.
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        resolveGet({ WINDOW_SHOW_ORIGINAL: true, THEME: 'dark' });
        await vi.waitFor(() => expect(storageManager.remove).toHaveBeenCalledWith(['THEME']));
        // Reset's delayed local defaults replacement must not clobber the toggle.
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Prerequisites succeeded: the reserved default write dispatches first.
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });

        writes[0].resolve(); // Reset's default commits; the gated toggle dispatches behind it
        await vi.waitFor(() => expect(writes).toHaveLength(3));
        // Dispatch order after the reserved write resolves: Reset's own
        // continuation awaits the write promise directly, while the toggle's
        // queued callback sits one microtask behind it.
        expect(writes[1]).not.toHaveProperty('snapshot.WINDOW_SHOW_ORIGINAL'); // defaults snapshot carries no value for this key
        expect(writes[2].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: true }); // the newer toggle's queued write

        writes[1].resolve();
        writes[2].resolve();
        await Promise.all([resetting, toggle]);

        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a toggle issued while Reset awaits storageManager.remove() supersedes Reset', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      try {
        // Reset must encounter stored keys so its removal step actually runs;
        // the reserved default write stays gated behind the removal.
        storageManager.get.mockResolvedValueOnce({ THEME: 'dark' });
        let resolveRemove;
        storageManager.remove.mockImplementationOnce(() => new Promise((resolve) => { resolveRemove = resolve; }));
        const resetting = store.resetSettings();
        expect(storageManager.set).not.toHaveBeenCalled();

        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // The removal reaches the storage mock after a few microtask hops.
        await vi.waitFor(() => expect(storageManager.remove).toHaveBeenCalledWith(['THEME']));
        resolveRemove();
        // Reset's delayed local defaults replacement must not clobber the toggle.
        await vi.waitFor(() => expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true));

        // Prerequisites succeeded: the reserved default write dispatches first.
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });

        writes[0].resolve(); // Reset's default commits; the gated toggle dispatches behind it
        await vi.waitFor(() => expect(writes).toHaveLength(3));
        // Dispatch order after the reserved write resolves: Reset's own
        // continuation awaits the write promise directly, while the toggle's
        // queued callback sits one microtask behind it.
        expect(writes[1]).not.toHaveProperty('snapshot.WINDOW_SHOW_ORIGINAL'); // defaults snapshot carries no value for this key
        expect(writes[2].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: true }); // the newer toggle's queued write

        writes[1].resolve();
        writes[2].resolve();
        await Promise.all([resetting, toggle]);

        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a failed Reset storage read cancels the reserved default write and keeps the preference', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      storageManager.set.mockImplementation((snapshot) => {
        Object.assign(persisted, snapshot);
        return Promise.resolve(true);
      });

      try {
        // A committed user preference must survive a failed Reset untouched.
        await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        const readError = new Error('storage read failed');
        storageManager.get.mockRejectedValueOnce(readError);

        await expect(store.resetSettings()).rejects.toBe(readError);

        // The reserved default write was cancelled without any storage write.
        expect(storageManager.set).toHaveBeenCalledTimes(1);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Subsequent toggles continue normally through the drained queue.
        await expect(store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false)).resolves.toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a failed Reset storage removal cancels the reserved default write and keeps the preference', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      storageManager.set.mockImplementation((snapshot) => {
        Object.assign(persisted, snapshot);
        return Promise.resolve(true);
      });

      try {
        // Reset must encounter stored keys so its removal step actually runs.
        await store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        storageManager.get.mockResolvedValueOnce({ THEME: 'dark' });
        const removeError = new Error('storage removal failed');
        storageManager.remove.mockRejectedValueOnce(removeError);

        await expect(store.resetSettings()).rejects.toBe(removeError);

        // The reserved default write was cancelled without any storage write.
        expect(storageManager.set).toHaveBeenCalledTimes(1);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Subsequent toggles continue normally through the drained queue.
        await expect(store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false)).resolves.toBe(true);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(false);
      } finally {
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a failed Reset read cancels its reserved write while an earlier toggle write stays pending', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      // Node surfaces unhandled rejections through this event; capture our slice.
      const unhandledRejections = [];
      const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        // The earlier toggle write stays pending and keeps the reserved slot
        // from running, so a reject-on-cancel design would go unhandled.
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(writes).toHaveLength(1));

        const readError = new Error('storage read failed');
        storageManager.get.mockRejectedValueOnce(readError);
        const resetting = store.resetSettings();

        // Reset's failure propagates without waiting behind the pending write.
        await expect(resetting).rejects.toBe(readError);
        expect(writes).toHaveLength(1); // the cancelled slot dispatched nothing so far
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Release the earlier write: the cancelled slot must skip, not write.
        writes[0].resolve();
        await toggle;
        expect(storageManager.set).toHaveBeenCalledTimes(1);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Subsequent toggles keep functioning through the drained queue.
        const followUpToggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[1].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });
        writes[1].resolve();
        await expect(followUpToggle).resolves.toBe(true);

        // A macro-task tick lets any unhandled rejection surface.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('a failed Reset removal cancels its reserved write while an earlier toggle write stays pending', async () => {
      const store = useSettingsStore();
      await getStorageChangeListener(store);
      const persisted = {};
      const writes = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        writes.push({ snapshot, resolve: () => {
          Object.assign(persisted, snapshot);
          resolve(true);
        } });
      }));

      // Node surfaces unhandled rejections through this event; capture our slice.
      const unhandledRejections = [];
      const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const toggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', true);
        await vi.waitFor(() => expect(writes).toHaveLength(1));

        storageManager.get.mockResolvedValueOnce({ THEME: 'dark' });
        const removeError = new Error('storage removal failed');
        storageManager.remove.mockRejectedValueOnce(removeError);
        const resetting = store.resetSettings();

        await expect(resetting).rejects.toBe(removeError);
        expect(writes).toHaveLength(1);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);

        writes[0].resolve();
        await toggle;
        expect(storageManager.set).toHaveBeenCalledTimes(1);
        expect(persisted.WINDOW_SHOW_ORIGINAL).toBe(true);

        // Subsequent toggles keep functioning through the drained queue.
        const followUpToggle = store.updateSettingAndPersist('WINDOW_SHOW_ORIGINAL', false);
        expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[1].snapshot).toEqual({ WINDOW_SHOW_ORIGINAL: false });
        writes[1].resolve();
        await expect(followUpToggle).resolves.toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        storageManager.set.mockImplementation(async () => true);
      }
    });

    it('importSettings restores the window preference explicitly outside the full save', async () => {
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        WINDOW_SHOW_ORIGINAL: true,
      });
      runSettingsMigrations.mockResolvedValueOnce({ updates: {}, removals: [], logs: [] });
      const store = useSettingsStore();
      const persisted = [];
      storageManager.set.mockImplementation((snapshot) => new Promise((resolve) => {
        persisted.push({ ...snapshot });
        resolve(true);
      }));

      await expect(store.importSettings({ _exported: true, THEME: 'dark', WINDOW_SHOW_ORIGINAL: true })).resolves.toBe(true);

      expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(true);
      // The full-save snapshot carries no value for this key; the explicit
      // queued restore writes the imported value afterwards.
      expect(persisted[0]).not.toHaveProperty('WINDOW_SHOW_ORIGINAL');
      expect(persisted.some((snapshot) => snapshot.WINDOW_SHOW_ORIGINAL === true)).toBe(true);
    });
  });

  it('should include BILINGUAL_TRANSLATION_MODES.PDF with the CONFIG default', () => {
    const store = useSettingsStore();
    expect(store.settings.BILINGUAL_TRANSLATION_MODES[TranslationMode.PDF])
      .toBe(CONFIG.BILINGUAL_TRANSLATION_MODES[TranslationMode.PDF]);
  });

  it('should include CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_PDF_TRANSLATOR with the CONFIG default', () => {
    const store = useSettingsStore();
    expect(store.settings.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_PDF_TRANSLATOR)
      .toBe(CONFIG.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_PDF_TRANSLATOR);
  });

  it('should include the launcher ACTION_CONTEXT flags with the CONFIG defaults', () => {
    const store = useSettingsStore();
    expect(store.settings.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_PDF_TRANSLATOR)
      .toBe(CONFIG.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_PDF_TRANSLATOR);
    expect(store.settings.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_SUBTITLE_TRANSLATOR)
      .toBe(CONFIG.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_SUBTITLE_TRANSLATOR);
  });

  it('should keep fixed-schema nested defaults in sync with CONFIG', () => {
    const store = useSettingsStore();

    const storeBilingual = store.settings.BILINGUAL_TRANSLATION_MODES;
    Object.keys(CONFIG.BILINGUAL_TRANSLATION_MODES).forEach(mode => {
      expect(storeBilingual[mode]).toBe(CONFIG.BILINGUAL_TRANSLATION_MODES[mode]);
    });

    const storeContextMenu = store.settings.CONTEXT_MENU_VISIBILITY;
    Object.keys(CONFIG.CONTEXT_MENU_VISIBILITY).forEach(flag => {
      expect(storeContextMenu[flag]).toBe(CONFIG.CONTEXT_MENU_VISIBILITY[flag]);
    });
  });

  it('should load settings from storage', async () => {
    storageManager.get.mockResolvedValue({ THEME: 'dark', API_KEY: 'test-key' });
    const store = useSettingsStore();
    
    // Force reset and reload to ensure storage mock is used
    store.isInitialized = false;
    await store.loadSettings();
    await nextTick();
    
    expect(store.settings.THEME).toBe('dark');
    expect(store.settings.API_KEY).toBe('test-key');
  });

  it('should sanitize settings: fallback to ON_CLICK if FABs disabled', async () => {
    const store = useSettingsStore();
    store.settings.SHOW_DESKTOP_FAB = false;
    store.settings.SHOW_MOBILE_FAB = false;
    store.settings.selectionTranslationMode = SelectionTranslationMode.ON_FAB_CLICK;

    await store.saveAllSettings();
    await nextTick();

    expect(store.settings.selectionTranslationMode).toBe(SelectionTranslationMode.ON_CLICK);
  });

  it('updateSettingAndPersist should update local state and call storage', async () => {
    const store = useSettingsStore();
    store.settings.THEME = 'dark';
    await nextTick();
    
    await store.updateSettingAndPersist('THEME', 'light');
    await nextTick();

    expect(store.settings.THEME).toBe('light');
    expect(storageManager.set).toHaveBeenCalledWith({ THEME: 'light' });
  });

  describe('updateSettingAndPersist canonical boundary', () => {
    it('persists a canonical key/value exactly', async () => {
      const store = useSettingsStore();

      const result = await store.updateSettingAndPersist('THEME', 'dark');

      expect(result).toBe(true);
      expect(store.settings.THEME).toBe('dark');
      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(storageManager.set.mock.calls[0][0]).toEqual({ THEME: 'dark' });
    });

    it('keeps a non-canonical key local-only without throwing', async () => {
      const store = useSettingsStore();

      const result = await store.updateSettingAndPersist('__SYNTHETIC_UNKNOWN_KEY__', 'x');

      expect(result).toBe(true);
      expect(store.settings.__SYNTHETIC_UNKNOWN_KEY__).toBe('x');
      expect(storageManager.set).not.toHaveBeenCalled();
    });

    it('skips the storage write for store-owned translationHistory', async () => {
      const store = useSettingsStore();
      const history = [{ text: 'hi', translated: 'سلام' }];

      const result = await store.updateSettingAndPersist('translationHistory', history);

      expect(result).toBe(true);
      expect(store.settings.translationHistory).toEqual(history);
      expect(storageManager.set).not.toHaveBeenCalled();
    });

    it('passes nested canonical values through', async () => {
      const store = useSettingsStore();
      const modeProviders = { ...store.settings.MODE_PROVIDERS, field: 'googlev2' };

      await store.updateSettingAndPersist('MODE_PROVIDERS', modeProviders);

      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(storageManager.set.mock.calls[0][0]).toEqual({ MODE_PROVIDERS: modeProviders });
    });

    it('still persists DEBUG_MODE cleanup additions', async () => {
      const store = useSettingsStore();
      store.settings.TRANSLATION_API = 'mock';
      store.settings.MODE_PROVIDERS = { ...store.settings.MODE_PROVIDERS, field: 'mock' };

      await store.updateSettingAndPersist('DEBUG_MODE', false);

      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(storageManager.set.mock.calls[0][0]).toEqual(expect.objectContaining({
        DEBUG_MODE: false,
        TRANSLATION_API: CONFIG.TRANSLATION_API || 'googlev2'
      }));
      expect(storageManager.set.mock.calls[0][0]).toHaveProperty('MODE_PROVIDERS');
    });

    it('preserves rejection behavior for canonical writes', async () => {
      const store = useSettingsStore();
      storageManager.set.mockRejectedValueOnce(new Error('storage failed'));

      await expect(store.updateSettingAndPersist('THEME', 'dark')).rejects.toThrow('storage failed');
      // Synchronous local update still applied before the failure.
      expect(store.settings.THEME).toBe('dark');
    });
  });

  it('should handle complex merge for EXCLUDED_SITES with various data types', async () => {
    // Case 1: Object format (legacy/migration)
    storageManager.get.mockResolvedValueOnce({ 
      EXCLUDED_SITES: { '0': 'google.com', '1': 'github.com' } 
    });
    const store = useSettingsStore();
    store.isInitialized = false;
    await store.loadSettings();
    expect(store.settings.EXCLUDED_SITES).toEqual(['google.com', 'github.com']);

    // Case 2: Array format (modern)
    storageManager.get.mockResolvedValueOnce({ 
      EXCLUDED_SITES: ['bing.com'] 
    });
    store.isInitialized = false;
    await store.loadSettings();
    expect(store.settings.EXCLUDED_SITES).toEqual(['bing.com']);

    // Case 3: Invalid format (fallback to empty)
    storageManager.get.mockResolvedValueOnce({ 
      EXCLUDED_SITES: 'invalid' 
    });
    store.isInitialized = false;
    await store.loadSettings();
    expect(store.settings.EXCLUDED_SITES).toEqual([]);
  });

  it('should handle translationHistory merge properly', async () => {
    const mockHistory = [{ text: 'hi', translated: 'سلام' }];
    storageManager.get.mockResolvedValue({ 
      translationHistory: mockHistory 
    });
    const store = useSettingsStore();
    store.isInitialized = false;
    await store.loadSettings();
    
    expect(store.settings.translationHistory).toEqual(mockHistory);
  });

  it('should persist and load advanced prompt templates', async () => {
    const store = useSettingsStore();
    const customPrompt = 'Custom Base Field Template $_{TEXT}';
    
    // 1. Update locally
    store.updateSettingLocally('PROMPT_BASE_FIELD', customPrompt);
    
    // 2. Save
    await store.saveAllSettings();
    expect(storageManager.set).toHaveBeenCalledWith(expect.objectContaining({
      PROMPT_BASE_FIELD: customPrompt
    }));
    
    // 3. Mock storage return for load
    storageManager.get.mockResolvedValue({ PROMPT_BASE_FIELD: customPrompt });
    
    // 4. Reload
    store.isInitialized = false;
    await store.loadSettings();
    await nextTick();
    
    expect(store.settings.PROMPT_BASE_FIELD).toBe(customPrompt);
  });

  describe('saveAllSettings immediate persistence', () => {
    it('invokes persistence immediately without timer', async () => {
      const store = useSettingsStore();

      const savePromise = store.saveAllSettings();

      // No timer advance: the storage write must already be underway.
      expect(storageManager.set).toHaveBeenCalledTimes(1);

      await savePromise;
      expect(storageManager.set).toHaveBeenCalledTimes(1);
    });

    it('Promise resolves only after storage resolves', async () => {
      const store = useSettingsStore();
      let resolveStorage;
      storageManager.set.mockImplementationOnce(
        () => new Promise((resolve) => { resolveStorage = resolve; })
      );

      let settled = false;
      const savePromise = store.saveAllSettings().then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      await nextTick();

      // Storage still pending: save must not have settled.
      expect(settled).toBe(false);

      resolveStorage(true);
      const result = await savePromise;

      expect(result).toBe(true);
      expect(settled).toBe(true);
    });

    it('multiple concurrent saves settle correctly', async () => {
      const store = useSettingsStore();
      storageManager.set.mockResolvedValue(true);

      const results = await Promise.all([store.saveAllSettings(), store.saveAllSettings()]);

      expect(results).toEqual([true, true]);
      expect(storageManager.set).toHaveBeenCalledTimes(2);
    });
  });

  describe('PROMPT_EDITOR_SELECTED_KEY persistence lifecycle', () => {
    it("persists the selected prompt editor key via saveAllSettings", async () => {
      // PROMPT_BASE_FIELD must stay editable in PROMPT_REGISTRY for this
      // lifecycle coverage; pick another editable key if the registry changes.
      expect(PROMPT_REGISTRY['PROMPT_BASE_FIELD']?.editable).toBe(true);

      const store = useSettingsStore();
      store.settings.PROMPT_EDITOR_SELECTED_KEY = 'PROMPT_BASE_FIELD';

      await store.saveAllSettings();

      expect(storageManager.set).toHaveBeenCalledWith(
        expect.objectContaining({ PROMPT_EDITOR_SELECTED_KEY: 'PROMPT_BASE_FIELD' })
      );
    });

    it('restores the selected key on a fresh store via loadSettings', async () => {
      storageManager.get.mockResolvedValue({ PROMPT_EDITOR_SELECTED_KEY: 'PROMPT_BASE_FIELD' });

      const store = useSettingsStore();
      store.isInitialized = false;
      await store.loadSettings();
      await nextTick();

      expect(store.settings.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_BASE_FIELD');
    });

    it('stale stored value keeps raw value but normalizes effectively to PROMPT_TEMPLATE', async () => {
      storageManager.get.mockResolvedValue({ PROMPT_EDITOR_SELECTED_KEY: 'STALE_REMOVED_KEY' });

      const store = useSettingsStore();
      store.isInitialized = false;
      await store.loadSettings();
      await nextTick();

      // Store boundary: loadSettings does not rewrite stale values in place.
      expect(store.settings.PROMPT_EDITOR_SELECTED_KEY).toBe('STALE_REMOVED_KEY');

      // Effective selection mirrors PromptTab's guarded getter: only editable
      // registry entries are effective, everything else falls back.
      const stored = store.settings.PROMPT_EDITOR_SELECTED_KEY;
      const effective =
        PROMPT_REGISTRY[stored]?.editable === true ? stored : 'PROMPT_TEMPLATE';
      expect(effective).toBe('PROMPT_TEMPLATE');
    });
  });

  describe('write-boundary hardening', () => {
    it('saveAllSettings persists canonical keys with live values', async () => {
      const store = useSettingsStore();
      store.settings.THEME = 'dark';
      store.settings.PROMPT_EDITOR_SELECTED_KEY = 'PROMPT_BASE_FIELD';

      await store.saveAllSettings();

      const payload = storageManager.set.mock.calls[0][0];
      expect(payload.THEME).toBe('dark');
      expect(payload.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_BASE_FIELD');
      // Membership is canonical-only: every written key belongs to the schema.
      const canonicalKeys = new Set(Object.keys(getPersistedDefaultSettings()));
      Object.keys(payload).forEach(key => expect(canonicalKeys.has(key)).toBe(true));
    });

    it('saveAllSettings excludes translationHistory from the global write', async () => {
      const store = useSettingsStore();
      store.settings.translationHistory = [{ text: 'hi', translated: 'سلام' }];

      await store.saveAllSettings();

      const payload = storageManager.set.mock.calls[0][0];
      expect(payload).not.toHaveProperty('translationHistory');
      // History remains store-owned runtime state; the write boundary only skips it.
      expect(store.settings.translationHistory).toHaveLength(1);
    });

    it('saveAllSettings does not persist synthetic unknown keys', async () => {
      const store = useSettingsStore();
      store.settings.__SYNTHETIC_UNKNOWN_KEY__ = 'should-not-persist';

      await store.saveAllSettings();

      const payload = storageManager.set.mock.calls[0][0];
      expect(payload).not.toHaveProperty('__SYNTHETIC_UNKNOWN_KEY__');
      expect(payload).not.toHaveProperty('translationHistory');
    });

    it('saveAllSettings keeps nested canonical values intact', async () => {
      const store = useSettingsStore();
      store.settings.CONTEXT_MENU_VISIBILITY = {
        ...store.settings.CONTEXT_MENU_VISIBILITY,
        ACTION_CONTEXT_OPTIONS: false
      };
      store.settings.PROVIDER_OPTIMIZATION_LEVELS = { gemini: 5 };
      store.settings.LANGUAGE_DETECTION_PREFERENCES = { 'latin-script': 'en' };

      await store.saveAllSettings();

      const payload = storageManager.set.mock.calls[0][0];
      expect(payload.CONTEXT_MENU_VISIBILITY).toEqual(store.settings.CONTEXT_MENU_VISIBILITY);
      expect(payload.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_OPTIONS).toBe(false);
      expect(payload.PROVIDER_OPTIMIZATION_LEVELS).toEqual({ gemini: 5 });
      expect(payload.LANGUAGE_DETECTION_PREFERENCES).toEqual({ 'latin-script': 'en' });
      expect(payload.MODE_PROVIDERS).toEqual(store.settings.MODE_PROVIDERS);
    });

    it('updateMultipleSettings persists only the canonical updated keys', async () => {
      const store = useSettingsStore();
      // Unrelated canonical state must NOT be rewritten by a narrowed write.
      store.settings.TARGET_LANGUAGE = 'fr';
      store.settings.translationHistory = [{ text: 'hi', translated: 'سلام' }];

      await store.updateMultipleSettings({ THEME: 'dark' });

      expect(store.settings.THEME).toBe('dark');
      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(storageManager.set.mock.calls[0][0]).toEqual({ THEME: 'dark' });
    });

    it('updateMultipleSettings keeps unknown keys local-only', async () => {
      const store = useSettingsStore();

      const result = await store.updateMultipleSettings({
        __SYNTHETIC_UNKNOWN_KEY__: 'should-not-persist'
      });

      // Local state still accepts runtime keys; storage sees nothing.
      expect(result).toBe(true);
      expect(store.settings.__SYNTHETIC_UNKNOWN_KEY__).toBe('should-not-persist');
      expect(storageManager.set).not.toHaveBeenCalled();
    });

    it('updateMultipleSettings persists multiple canonical keys and nothing else', async () => {
      const store = useSettingsStore();
      store.settings.TARGET_LANGUAGE = 'fr';

      await store.updateMultipleSettings({ THEME: 'dark', SOURCE_LANGUAGE: 'en' });

      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(storageManager.set.mock.calls[0][0]).toEqual({
        THEME: 'dark',
        SOURCE_LANGUAGE: 'en'
      });
    });

    it('updateMultipleSettings with no canonical keys skips the storage write', async () => {
      const store = useSettingsStore();

      expect(await store.updateMultipleSettings({})).toBe(true);
      expect(await store.updateMultipleSettings({ translationHistory: [] })).toBe(true);

      // set({}) writes nothing and emits no events, so the round-trip is skipped.
      expect(storageManager.set).not.toHaveBeenCalled();
    });
  });

  describe('Import & Migration Flow', () => {
    it('importSettings should merge defaults and run migrations', async () => {
      const mockImportData = { THEME: 'dark', TRANSLATION_API: 'google' };
      const store = useSettingsStore();

      await store.importSettings(mockImportData);

      expect(store.settings.THEME).toBe('dark');
      expect(storageManager.set).toHaveBeenCalled();
      expect(storageManager.remove).not.toHaveBeenCalled();
    });

    it('removes the legacy DeepL beta flag from imported state and storage', async () => {
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        TRANSLATION_API: 'google',
        DEEPL_BETA_LANGUAGES_ENABLED: false,
      });
      runSettingsMigrations.mockResolvedValueOnce({
        updates: {},
        removals: ['DEEPL_BETA_LANGUAGES_ENABLED'],
        logs: [],
      });
      const store = useSettingsStore();

      await store.importSettings({ _exported: true, DEEPL_BETA_LANGUAGES_ENABLED: false });

      expect(store.settings.THEME).toBe('dark');
      expect(store.settings.TRANSLATION_API).toBe('google');
      expect(store.settings).not.toHaveProperty('DEEPL_BETA_LANGUAGES_ENABLED');
      expect(storageManager.remove).toHaveBeenCalledWith(expect.arrayContaining(['DEEPL_BETA_LANGUAGES_ENABLED']));
      expect(storageManager.set.mock.calls.every(([snapshot]) => !Object.hasOwn(snapshot, 'DEEPL_BETA_LANGUAGES_ENABLED'))).toBe(true);
    });

    it('importSettings should remove obsolete endpoint overrides returned by migrations', async () => {
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        MICROSOFT_EDGE_AUTH_URL: 'https://edge.microsoft.com/translate/auth',
        MICROSOFT_EDGE_TRANSLATE_URL: 'https://api-edge.cognitive.microsofttranslator.com/translate'
      });
      runSettingsMigrations.mockResolvedValueOnce({
        updates: {},
        removals: ['MICROSOFT_EDGE_AUTH_URL', 'MICROSOFT_EDGE_TRANSLATE_URL'],
        logs: []
      });

      const store = useSettingsStore();
      await store.importSettings({ THEME: 'dark', _exported: true });

      expect(store.settings).not.toHaveProperty('MICROSOFT_EDGE_AUTH_URL');
      expect(store.settings).not.toHaveProperty('MICROSOFT_EDGE_TRANSLATE_URL');
    });

    it('completes import when obsolete-key cleanup fails after settings are saved', async () => {
      const cleanupError = new Error('storage cleanup failed');
      runSettingsMigrations.mockResolvedValueOnce({
        updates: {},
        removals: ['LEGACY_SETTING'],
        logs: []
      });
      storageManager.remove.mockRejectedValueOnce(cleanupError);
      const store = useSettingsStore();

      await expect(store.importSettings({ THEME: 'dark', _exported: true })).resolves.toBe(true);

      expect(store.settings.THEME).toBe('dark');
      expect(storageManager.set).toHaveBeenCalled();
      expect(storageManager.remove).toHaveBeenCalledWith(['LEGACY_SETTING']);
      expect(storageManager.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('keeps settings-save failures fatal during import', async () => {
      const saveError = new Error('settings save failed');
      storageManager.set.mockRejectedValueOnce(saveError);
      runSettingsMigrations.mockResolvedValueOnce({
        updates: {},
        removals: ['LEGACY_SETTING'],
        logs: []
      });
      const store = useSettingsStore();

      await expect(store.importSettings({ THEME: 'dark', _exported: true })).rejects.toBe(saveError);

      expect(storageManager.remove).not.toHaveBeenCalled();
      expect(storageManager.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('propagates extension-context errors from obsolete-key cleanup', async () => {
      const contextError = new Error('Extension context invalidated');
      runSettingsMigrations.mockResolvedValueOnce({
        updates: {},
        removals: ['LEGACY_SETTING'],
        logs: []
      });
      storageManager.remove.mockRejectedValueOnce(contextError);
      ExtensionContextManager.isContextError.mockImplementation(error => error === contextError);
      const store = useSettingsStore();

      await expect(store.importSettings({ THEME: 'dark', _exported: true })).rejects.toBe(contextError);

      expect(ExtensionContextManager.handleContextError).toHaveBeenCalledWith(
        contextError,
        'settings-store-import'
      );
      expect(storageManager.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('importSettings should pass legacy Mouse Hover triggers through centralized migration', async () => {
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        MOUSE_HOVER_TRIGGER: 'ctrl'
      });
      const migrationInputs = [];
      runSettingsMigrations.mockImplementationOnce(async (settings) => {
        migrationInputs.push({ ...settings });
        return {
          updates: { MOUSE_HOVER_TRIGGER: 'primary' },
          removals: [],
          logs: ['Migrated MOUSE_HOVER_TRIGGER from ctrl to primary']
        };
      });
      const store = useSettingsStore();

      await store.importSettings({ THEME: 'dark', _exported: true });

      expect(migrationInputs[0]).toEqual(
        expect.objectContaining({ MOUSE_HOVER_TRIGGER: 'ctrl' })
      );
      expect(store.settings.MOUSE_HOVER_TRIGGER).toBe('primary');
    });

    it.each([
      [true, {}, true, false],
      [false, {}, false, false],
      [true, {
        LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: false,
        LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: true
      }, false, true],
      [false, {
        LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: true,
        LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: true
      }, true, true]
    ])(
      'importSettings migrates legacy Original transcript value %s while preserving explicit provider values',
      async (legacyValue, providerValues, expectedGemini, expectedOpenAI) => {
        const persistedSettings = {
          LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: legacyValue
        };
        storageManager.set.mockImplementationOnce(async (settings) => {
          Object.assign(persistedSettings, settings);
          return true;
        });
        storageManager.remove.mockImplementationOnce(async (keys) => {
          keys.forEach(key => delete persistedSettings[key]);
          return true;
        });
        secureStorage.processImportedSettings.mockResolvedValueOnce({
          THEME: 'dark',
          LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: legacyValue,
          ...providerValues
        });
        const { runSettingsMigrations: runRealSettingsMigrations } = await vi.importActual(
          '@/shared/config/settingsMigrations.js'
        );
        runSettingsMigrations.mockImplementationOnce(runRealSettingsMigrations);
        const store = useSettingsStore();

        await store.importSettings({ THEME: 'dark', _exported: true });

        expect(store.settings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(expectedGemini);
        expect(store.settings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(expectedOpenAI);
        expect(store.settings).not.toHaveProperty('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
        expect(storageManager.remove).toHaveBeenCalledWith([
          'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT'
        ]);
        expect(persistedSettings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT).toBeUndefined();
        expect(persistedSettings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(expectedGemini);
        expect(persistedSettings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(expectedOpenAI);
      }
    );

    it('importSettings should keep merged default model lists available to model migrations', async () => {
      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        OPENAI_API_MODEL: 'gpt-5.6-luna'
      });
      const { runSettingsMigrations: runRealSettingsMigrations } = await vi.importActual(
        '@/shared/config/settingsMigrations.js'
      );
      let migrationInput;
      runSettingsMigrations.mockImplementationOnce(async (settings, explicitSettingsKeys) => {
        migrationInput = { ...settings };
        return runRealSettingsMigrations(settings, explicitSettingsKeys);
      });
      const store = useSettingsStore();

      await store.importSettings({ THEME: 'dark', _exported: true });

      expect(migrationInput.OPENAI_MODELS).toEqual(CONFIG.OPENAI_MODELS);
      expect(store.settings.OPENAI_API_MODEL).toBe('gpt-6-luna');
      expect(storageManager.remove).not.toHaveBeenCalled();
    });

    it('importSettings should drop non-editable wrappers from old backups and keep editable prompts', async () => {
      secureStorage.processImportedSettings.mockResolvedValue({
        THEME: 'dark',
        PROMPT_BASE_AI_BATCH: 'OLD_MARKER',
        PROMPT_SUBTITLE_BASE: 'OLD_SUBTITLE',
        PROMPT_TEMPLATE: 'custom user template $_{TEXT}'
      });
      const store = useSettingsStore();

      await store.importSettings({ THEME: 'dark', _exported: true });

      // Legacy wrappers from the backup are discarded
      expect(store.settings.PROMPT_BASE_AI_BATCH).toBeUndefined();
      expect(store.settings.PROMPT_SUBTITLE_BASE).toBeUndefined();
      // Editable customized prompt survives
      expect(store.settings.PROMPT_TEMPLATE).toBe('custom user template $_{TEXT}');
      expect(store.settings.THEME).toBe('dark');
    });  });

  it('importSettings should ignore legacy OpenRouter endpoint settings', async () => {
    secureStorage.processImportedSettings.mockResolvedValue({
      THEME: 'dark',
      OPENROUTER_API_URL: 'https://legacy.example.test/chat/completions'
    });
    const store = useSettingsStore();

    await store.importSettings({ THEME: 'dark', _exported: true });

    expect(store.settings).not.toHaveProperty('OPENROUTER_API_URL');
  });

  it('importSettings should ignore legacy OpenAI endpoint settings', async () => {
    secureStorage.processImportedSettings.mockResolvedValue({
      THEME: 'dark',
      OPENAI_API_URL: 'https://legacy.example.test/v1/chat/completions'
    });
    const store = useSettingsStore();

    await store.importSettings({ THEME: 'dark', _exported: true });

    expect(store.settings).not.toHaveProperty('OPENAI_API_URL');
  });

  it.each([
    [{ GEMINI_THINKING_ENABLED: true }, 'minimal'],
    [{ GEMINI_THINKING_ENABLED: false }, 'default'],
    [{ GEMINI_THINKING_MODE: 'default', GEMINI_THINKING_ENABLED: true }, 'default']
  ])('importSettings normalizes legacy Gemini thinking state %o', async (imported, expectedMode) => {
    secureStorage.processImportedSettings.mockResolvedValue({ THEME: 'dark', ...imported });
    const store = useSettingsStore();

    await store.importSettings({ THEME: 'dark', _exported: true });

    expect(store.settings.GEMINI_THINKING_MODE).toBe(expectedMode);
    expect(store.settings).not.toHaveProperty('GEMINI_THINKING_ENABLED');
  });

  it('importSettings keeps default for invalid Gemini mode despite legacy state', async () => {
    secureStorage.processImportedSettings.mockResolvedValue({
      THEME: 'dark',
      GEMINI_THINKING_MODE: 'invalid',
      GEMINI_THINKING_ENABLED: true
    });
    runSettingsMigrations.mockResolvedValue({
      updates: { GEMINI_THINKING_MODE: 'default' },
      removals: [],
      logs: []
    });
    const store = useSettingsStore();

    await store.importSettings({ THEME: 'dark', _exported: true });

    expect(store.settings.GEMINI_THINKING_MODE).toBe('default');
    expect(store.settings).not.toHaveProperty('GEMINI_THINKING_ENABLED');
  });

  describe('Strict Validation', () => {
    it('validateSettings should reject prompt without placeholder', () => {
      const store = useSettingsStore();
      store.settings.PROMPT_TEMPLATE = 'Translate this: hello'; // Missing $_{TEXT}
      
      const result = store.validateSettings();
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('prompt:PROMPT_TEMPLATE:validation_prompt_template_missing_placeholders');
    });

    it('validateSettings should allow subtitle prompt without $_{TEXT}', () => {
      const store = useSettingsStore();
      // Only SOURCE and TARGET are required for subtitles in the registry
      store.settings.PROMPT_SUBTITLE_USER = 'Translate from $_{SOURCE} to $_{TARGET}.';
      
      const result = store.validateSettings();
      
      // Filter out other potential errors to focus on the subtitle prompt
      const subtitleErrors = result.errors.filter(e => e.includes('PROMPT_SUBTITLE_USER'));
      expect(subtitleErrors).toHaveLength(0);
    });

    it('validateSettings should reject subtitle prompt missing required language placeholders', () => {
      const store = useSettingsStore();
      store.settings.PROMPT_SUBTITLE_USER = 'Translate this.'; // Missing SOURCE and TARGET
      
      const result = store.validateSettings();
      expect(result.errors).toContain('prompt:PROMPT_SUBTITLE_USER:validation_prompt_template_missing_placeholders');
    });
  });

  describe('DeepL capability validation', () => {
    const entry = (lang, status = 'stable', source = true, target = true) => ({
      lang, normalizedTag: lang.toLowerCase(), name: lang,
      usableAsSource: source, usableAsTarget: target, status,
      isBeta: status === 'beta', metadataValid: true, catalogComplete: true,
      features: { formalityStatus: null, formalitySupport: 'unknown' },
    });
    const setupDeepL = (store, { source = 'en', target = 'fa', provider = 'deepl', key = 'test-key', tier = 'free' } = {}) => {
      Object.assign(store.settings, {
        TRANSLATION_API: provider,
        DEEPL_API_KEY: key,
        DEEPL_API_TIER: tier,
        SOURCE_LANGUAGE: source,
        TARGET_LANGUAGE: target,
      });
    };
    const setCatalog = async (store, catalog, fetchedAt = Date.now()) => {
      const identity = deepLLanguageDiscoveryMocks.identity(store.settings.DEEPL_API_KEY, store.settings.DEEPL_API_TIER);
      deepLLanguageDiscoveryMocks.fetch.mockResolvedValueOnce({ catalog, identity, fetchedAt });
      await store.refreshDeepLLanguageCapabilities();
    };

    it('allows a supported beta language even if the legacy beta flag is false', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'fa' });
      await setCatalog(store, [entry('en'), entry('de'), entry('fa', 'beta')]);

      Object.defineProperty(store.settings, 'DEEPL_BETA_LANGUAGES_ENABLED', {
        configurable: true,
        enumerable: true,
        get: vi.fn(() => false),
      });
      const result = store.validateSettings();
      expect(result.errors.filter(e => e.includes('deepl'))).toHaveLength(0);
      expect(Object.getOwnPropertyDescriptor(store.settings, 'DEEPL_BETA_LANGUAGES_ENABLED').get).not.toHaveBeenCalled();
    });

    it('uses direction flags and preserves exact BCP47 variants in errors', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'zh_TW', target: 'zh-Hans' });
      await setCatalog(store, [entry('zh-TW', 'stable', false, true), entry('zh-Hans', 'stable', true, false)]);

      const result = store.validateSettings();
      expect(result.errors).toContain('validation_deepl_source_language_unsupported:zh_TW');
      expect(result.errors).toContain('validation_deepl_target_language_unsupported:zh-Hans');
    });

    it('accepts legacy zh-cn target when the catalog exposes zh-Hans', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'zh-cn' });
      await setCatalog(store, [entry('en'), entry('zh-Hans')]);

      expect(store.validateSettings().errors.filter(error => error.includes('deepl'))).toHaveLength(0);
    });

    it('accepts ZH_CN target after normalization without changing the saved value', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'ZH_CN' });
      await setCatalog(store, [entry('en'), entry('zh-Hans')]);

      expect(store.validateSettings().errors.filter(error => error.includes('deepl'))).toHaveLength(0);
      expect(store.settings.TARGET_LANGUAGE).toBe('ZH_CN');
    });

    it('accepts legacy zh-tw source when the catalog exposes zh', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'zh-tw', target: 'en' });
      await setCatalog(store, [entry('zh'), entry('en')]);

      expect(store.validateSettings().errors.filter(error => error.includes('deepl'))).toHaveLength(0);
    });

    it('rejects legacy zh-tw target if its resolved zh-Hant entry is unusable', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'zh-tw' });
      await setCatalog(store, [entry('en'), entry('zh-Hant', 'stable', false, false)]);

      expect(store.validateSettings().errors).toContain('validation_deepl_target_language_unsupported:zh-tw');
    });

    it('keeps pt distinct from pt-BR when validating a saved target', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'pt' });
      await setCatalog(store, [entry('en'), entry('pt-BR')]);

      expect(store.validateSettings().errors).toContain('validation_deepl_target_language_unsupported:pt');
    });

    it('accepts pt_BR against pt-BR without changing the saved value', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'pt_BR' });
      await setCatalog(store, [entry('en'), entry('pt-BR')]);

      expect(store.validateSettings().errors.filter(error => error.includes('deepl'))).toHaveLength(0);
      expect(store.settings.TARGET_LANGUAGE).toBe('pt_BR');
    });

    it('allows auto-detect source and valid standard languages', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'auto', target: 'de' });
      await setCatalog(store, [entry('de')]);
      expect(store.validateSettings().errors.filter(e => e.includes('deepl'))).toHaveLength(0);
    });

    it('blocks save synchronously as unverified without fresh matching metadata', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de' });
      deepLLanguageDiscoveryMocks.fetch.mockRejectedValueOnce(new TypeError('offline'));
      await store.refreshDeepLLanguageCapabilities();

      expect(store.deepLLanguageCapabilities.status).toBe('error');
      expect(store.validateSettings().errors).toContain('validation_deepl_languages_unverified');
      expect(deepLLanguageDiscoveryMocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('refreshes DeepL with the current draft proxy without persisting it, and discards results after proxy edits', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de' });
      Object.assign(store.settings, {
        PROXY_ENABLED: true,
        PROXY_TYPE: 'http',
        PROXY_HOST: 'corrected.draft.proxy',
        PROXY_PORT: 8443,
        PROXY_USERNAME: 'draft-user',
        PROXY_PASSWORD: 'draft-secret',
      });
      let resolveDiscovery;
      deepLLanguageDiscoveryMocks.fetchFailover.mockReturnValueOnce(
        new Promise(resolve => { resolveDiscovery = resolve; }),
      );

      const refresh = store.refreshDeepLLanguageCapabilities();
      await vi.waitFor(() => expect(deepLLanguageDiscoveryMocks.fetchFailover).toHaveBeenCalledTimes(1));
      expect(deepLLanguageDiscoveryMocks.fetchFailover.mock.calls[0][0].proxySettings).toEqual({
        PROXY_ENABLED: true,
        PROXY_TYPE: 'http',
        PROXY_HOST: 'corrected.draft.proxy',
        PROXY_PORT: 8443,
        PROXY_USERNAME: 'draft-user',
        PROXY_PASSWORD: 'draft-secret',
      });
      expect(storageManager.set).not.toHaveBeenCalled();

      // A proxy draft edit aborts and invalidates the in-flight Options
      // refresh; a late response from the old route cannot become ready.
      store.settings.PROXY_HOST = 'newer.draft.proxy';
      resolveDiscovery({
        catalog: [entry('en'), entry('de')],
        identity: deepLLanguageDiscoveryMocks.identity('test-key', 'free'),
        fetchedAt: Date.now(),
      });
      await refresh;

      expect(store.deepLLanguageCapabilities.status).toBe('idle');
      expect(store.validateSettings().errors).toContain('validation_deepl_languages_unverified');
      expect(storageManager.set).not.toHaveBeenCalled();
    });

    it('validates and saves DeepL with corrected draft proxy while persisted proxy stays broken until Save', async () => {
      const persisted = {
        ...getPersistedDefaultSettings(),
        TRANSLATION_API: 'deepl',
        DEEPL_API_KEY: 'test-key',
        DEEPL_API_TIER: 'free',
        SOURCE_LANGUAGE: 'en',
        TARGET_LANGUAGE: 'de',
        PROXY_ENABLED: true,
        PROXY_TYPE: 'http',
        PROXY_HOST: 'broken.saved.proxy',
        PROXY_PORT: 1,
        PROXY_USERNAME: '',
        PROXY_PASSWORD: '',
      };
      storageManager.get.mockResolvedValue(persisted);
      storageManager.set.mockImplementation(async snapshot => {
        Object.assign(persisted, snapshot);
        return true;
      });

      const store = useSettingsStore();
      await store.loadSettings();
      expect(store.settings.PROXY_HOST).toBe('broken.saved.proxy');

      store.updateSettingLocally('PROXY_HOST', 'corrected.draft.proxy');
      store.updateSettingLocally('PROXY_PORT', 8443);
      deepLLanguageDiscoveryMocks.fetchFailover.mockResolvedValueOnce({
        catalog: [entry('en'), entry('de')],
        identity: deepLLanguageDiscoveryMocks.identity('test-key', 'free'),
        fetchedAt: Date.now(),
      });

      await store.refreshDeepLLanguageCapabilities();

      expect(deepLLanguageDiscoveryMocks.fetchFailover).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: 'test-key',
        apiTier: 'free',
        proxySettings: expect.objectContaining({
          PROXY_HOST: 'corrected.draft.proxy',
          PROXY_PORT: 8443,
        }),
      }));
      expect(store.validateSettings()).toMatchObject({ isValid: true, errors: [] });
      expect(persisted.PROXY_HOST).toBe('broken.saved.proxy');
      expect(storageManager.set).not.toHaveBeenCalled();

      await store.saveAllSettings();

      expect(storageManager.set).toHaveBeenCalledTimes(1);
      expect(persisted.PROXY_HOST).toBe('corrected.draft.proxy');
      expect(persisted.PROXY_PORT).toBe(8443);

      // This test models a local persisted snapshot; restore shared storage
      // mocks so subsequent store tests keep their own storage behavior.
      storageManager.get.mockReset().mockResolvedValue({});
      storageManager.set.mockReset().mockResolvedValue(true);
    });

    it('blocks an expired snapshot without using stale metadata in validation', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de' });
      await setCatalog(store, [entry('en'), entry('de')], Date.now() - 300001);

      expect(store.validateSettings().errors).toContain('validation_deepl_languages_unverified');
      expect(deepLLanguageDiscoveryMocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps missing credentials on the provider-config path without discovery', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de', key: '' });

      const state = await store.refreshDeepLLanguageCapabilities();
      const result = store.validateSettings();
      expect(state.status).toBe('missing-key');
      expect(deepLLanguageDiscoveryMocks.fetch).not.toHaveBeenCalled();
      expect(result.errors).toContain('ERRORS_API_CONFIG_INVALID');
      expect(result.errors).not.toContain('validation_deepl_languages_unverified');
    });

    it('treats a Pro tier with only a :fx key as provider configuration invalid', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de', key: 'free-key:fx', tier: 'pro' });

      const state = await store.refreshDeepLLanguageCapabilities();
      const result = store.validateSettings();
      expect(state.status).toBe('missing-key');
      expect(deepLLanguageDiscoveryMocks.fetch).not.toHaveBeenCalled();
      expect(result.errors).toContain('ERRORS_API_CONFIG_INVALID');
      expect(result.errors).not.toContain('validation_deepl_languages_unverified');
    });

    it('fails over Options refresh past an invalid first key and validates the succeeding identity', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de', key: 'bad-key\ngood-key' });
      // Mirror the production 401-only iteration over the per-key mock.
      deepLLanguageDiscoveryMocks.fetchFailover.mockImplementation(async ({ apiKey, apiTier, signal }) => {
        const keys = String(apiKey || '').split('\n').map(key => key.trim()).filter(Boolean)
          .filter(key => apiTier !== 'pro' || !key.endsWith(':fx'));
        let lastError = null;
        for (const key of keys) {
          try {
            return await deepLLanguageDiscoveryMocks.fetch({ apiKey: key, apiTier, signal });
          } catch (error) {
            if (Number(error?.statusCode) === 401) { lastError = error; continue; }
            throw error;
          }
        }
        throw lastError;
      });
      const authError = Object.assign(new Error('DeepL language discovery failed (401)'), { statusCode: 401 });
      deepLLanguageDiscoveryMocks.fetch.mockImplementation(async ({ apiKey, apiTier }) => {
        if (apiKey === 'bad-key') throw authError;
        return {
          catalog: [entry('en'), entry('de')],
          identity: deepLLanguageDiscoveryMocks.identity(apiKey, apiTier),
          fetchedAt: Date.now(),
        };
      });

      const state = await store.refreshDeepLLanguageCapabilities();

      expect(state.status).toBe('ready');
      expect(state.identity).toBe(deepLLanguageDiscoveryMocks.identity('good-key', 'free'));
      expect(deepLLanguageDiscoveryMocks.fetch.mock.calls.map(call => call[0].apiKey)).toEqual(['bad-key', 'good-key']);
      expect(store.validateSettings().errors.filter(error => error.includes('deepl'))).toHaveLength(0);
    });

    it('reports fetch failure when every configured key returns 401', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de', key: 'bad-1\nbad-2' });
      deepLLanguageDiscoveryMocks.fetchFailover.mockImplementation(async ({ apiKey, apiTier, signal }) => {
        const keys = String(apiKey || '').split('\n').map(key => key.trim()).filter(Boolean);
        let lastError = null;
        for (const key of keys) {
          try {
            return await deepLLanguageDiscoveryMocks.fetch({ apiKey: key, apiTier, signal });
          } catch (error) {
            if (Number(error?.statusCode) === 401) { lastError = error; continue; }
            throw error;
          }
        }
        throw lastError;
      });
      deepLLanguageDiscoveryMocks.fetch.mockRejectedValue(
        Object.assign(new Error('DeepL language discovery failed (401)'), { statusCode: 401 }),
      );

      const state = await store.refreshDeepLLanguageCapabilities();

      expect(state.status).toBe('error');
      expect(deepLLanguageDiscoveryMocks.fetch).toHaveBeenCalledTimes(2);
      expect(store.validateSettings().errors).toContain('validation_deepl_languages_unverified');
    });

    it('invalidates a ready snapshot on credential or tier edits and ignores stale responses', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { source: 'en', target: 'de' });
      await setCatalog(store, [entry('en'), entry('de')]);
      expect(store.validateSettings().errors.filter(e => e.includes('deepl'))).toHaveLength(0);
      store.deepLLanguageCapabilities.fetchedAt = Date.now() - 300000;

      let resolveOld;
      deepLLanguageDiscoveryMocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
      const oldRefresh = store.refreshDeepLLanguageCapabilities();
      store.settings.DEEPL_API_KEY = 'new-key';
      store.settings.DEEPL_API_TIER = 'pro';
      expect(store.deepLLanguageCapabilities.status).toBe('idle');
      const identity = deepLLanguageDiscoveryMocks.identity('new-key', 'pro');
      deepLLanguageDiscoveryMocks.fetch.mockResolvedValueOnce({ catalog: [entry('en'), entry('de')], identity, fetchedAt: Date.now() });
      await store.refreshDeepLLanguageCapabilities();
      resolveOld({ catalog: [entry('fa', 'beta')], identity: deepLLanguageDiscoveryMocks.identity('test-key', 'free'), fetchedAt: Date.now() });
      await oldRefresh;

      expect(store.deepLLanguageCapabilities.identity).toBe(identity);
      expect(store.validateSettings().errors.filter(e => e.includes('deepl'))).toHaveLength(0);
    });

    it('does not persist capability snapshots and supports explicit DeepL refresh under another primary provider', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { provider: 'google' });
      const identity = deepLLanguageDiscoveryMocks.identity('test-key', 'free');
      deepLLanguageDiscoveryMocks.fetch.mockResolvedValueOnce({
        catalog: [entry('en'), entry('fa', 'beta')], identity, fetchedAt: Date.now(),
      });
      const result = await store.refreshDeepLLanguageCapabilities({ forProvider: 'deepl' });
      expect(result.status).toBe('ready');
      expect(store.settings.TRANSLATION_API).toBe('google');
      store.settings.SOURCE_LANGUAGE = 'tl';
      store.settings.TARGET_LANGUAGE = 'de';
      expect(store.validateSettings().errors.some(error => error.includes('deepl'))).toBe(false);

      const callsBeforeOtherProvider = deepLLanguageDiscoveryMocks.fetch.mock.calls.length;
      await store.refreshDeepLLanguageCapabilities({ forProvider: 'google' });
      await store.refreshDeepLLanguageCapabilities();
      expect(deepLLanguageDiscoveryMocks.fetch).toHaveBeenCalledTimes(callsBeforeOtherProvider);
      expect(store.deepLLanguageCapabilities.status).toBe('ready');

      // A selector can consume this ready catalog for its own DeepL source or
      // target control, without changing primary-provider save validation.
      expect(store.deepLLanguageCapabilities.catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({ normalizedTag: 'en' }),
        expect.objectContaining({ normalizedTag: 'fa', status: 'beta' }),
      ]));

      await store.saveAllSettings();
      expect(storageManager.set.mock.calls.at(-1)[0]).not.toHaveProperty('deepLLanguageCapabilities');
    });

    it('does not perform an explicit DeepL refresh for missing credentials', async () => {
      const store = useSettingsStore();
      setupDeepL(store, { provider: 'google', key: '' });

      const result = await store.refreshDeepLLanguageCapabilities({ forProvider: 'deepl' });
      expect(result.status).toBe('missing-key');
      expect(deepLLanguageDiscoveryMocks.fetch).not.toHaveBeenCalled();
      expect(store.settings.TRANSLATION_API).toBe('google');
    });
  });

  it('resetSettings should clear storage and restore defaults', async () => {
    const store = useSettingsStore();
    store.settings.THEME = 'dark';

    await store.resetSettings();
    await nextTick();

    expect(storageManager.clear).not.toHaveBeenCalled();
    const persistedDefaults = getPersistedDefaultSettings();
    // Full-snapshot writes never carry serializer/window-owned keys; the
    // window preference restores through its dedicated write queue instead.
    delete persistedDefaults.COLLAPSED_PROVIDER_CATEGORIES;
    delete persistedDefaults.WINDOW_SHOW_ORIGINAL;
    expect(storageManager.set).toHaveBeenCalledWith(persistedDefaults);
    expect(store.settings.WINDOW_SHOW_ORIGINAL).toBe(false);
    expect(storageManager.set.mock.calls.some(([snapshot]) => (
      Object.hasOwn(snapshot, 'WINDOW_SHOW_ORIGINAL') && snapshot.WINDOW_SHOW_ORIGINAL === false
    ))).toBe(true);
    expect(store.settings.THEME).toBe('auto');
    expect(store.settings.translationHistory).toEqual([]);
  });

  it('reset preserves collapse revision and rejects delayed pre-reset events in every context', async () => {
    const firstStore = useSettingsStore();
    const firstListener = await getStorageChangeListener(firstStore);
    firstStore.settings.COLLAPSED_PROVIDER_CATEGORIES = { ids: ['ai'], revision: 5 };

    setActivePinia(createPinia());
    const secondStore = useSettingsStore();
    const secondListener = await getStorageChangeListener(secondStore);
    secondStore.settings.COLLAPSED_PROVIDER_CATEGORIES = { ids: ['ai'], revision: 5 };

    storageManager.get.mockResolvedValueOnce({
      COLLAPSED_PROVIDER_CATEGORIES: { ids: ['ai'], revision: 5 },
      translationHistory: [{ text: 'history' }],
      unrelatedLegacyKey: 'remove-me'
    });
    browser.runtime.sendMessage.mockResolvedValueOnce({
      success: true,
      state: { ids: [], revision: 6 }
    });
    await firstStore.resetSettings();

    expect(storageManager.remove).toHaveBeenCalledWith(
      expect.arrayContaining(['translationHistory', 'unrelatedLegacyKey'])
    );
    expect(storageManager.remove.mock.calls.at(-1)[0]).not.toContain('COLLAPSED_PROVIDER_CATEGORIES');
    expect(firstStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 6 });

    secondListener({
      key: 'COLLAPSED_PROVIDER_CATEGORIES',
      newValue: { ids: [], revision: 6 },
      oldValue: { ids: ['ai'], revision: 5 }
    });
    secondListener({
      key: 'COLLAPSED_PROVIDER_CATEGORIES',
      newValue: { ids: ['ai'], revision: 5 },
      oldValue: { ids: ['ai'], revision: 4 }
    });
    firstListener({
      key: 'COLLAPSED_PROVIDER_CATEGORIES',
      newValue: { ids: ['ai'], revision: 5 },
      oldValue: { ids: ['ai'], revision: 4 }
    });

    expect(secondStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 6 });
    expect(firstStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual({ ids: [], revision: 6 });
  });

  describe('desktop FAB exclusions import/export', () => {
    const installPersistedMap = (persisted) => {
      storageManager.get.mockImplementation(async keys => {
        const values = Object.fromEntries(persisted);
        if (keys === null || keys === undefined) return values;
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.filter(key => key in values).map(key => [key, values[key]]));
      });
      storageManager.set.mockImplementation(async values => {
        for (const [key, value] of Object.entries(values)) persisted.set(key, value);
        return true;
      });
      storageManager.remove.mockImplementation(async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) persisted.delete(key);
        return true;
      });
      storageManager.clear.mockImplementation(async () => {
        persisted.clear();
        return true;
      });
    };
    const resetStorageMocksToDefaults = () => {
      storageManager.get.mockReset();
      storageManager.get.mockResolvedValue({});
      storageManager.set.mockReset();
      storageManager.set.mockResolvedValue(true);
      storageManager.remove.mockReset();
      storageManager.remove.mockResolvedValue(true);
      storageManager.clear.mockReset();
      storageManager.clear.mockResolvedValue(true);
    };
    afterEach(() => {
      resetStorageMocksToDefaults();
    });
    const exclusionKeyWrites = () =>
      [
        ...storageManager.set.mock.calls.flatMap(([values]) => Object.keys(values || {})),
        ...storageManager.remove.mock.calls.flatMap(([keys]) =>
          Array.isArray(keys) ? keys : [keys],
        ),
      ].filter(key => typeof key === 'string' && key.startsWith('desktop-fab-exclusion:v1:'));

    it('resetSettings clears desktop FAB exclusions while export/import carry them', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);

      const pageKey = await addDesktopFabExclusion('page', 'https://example.test/docs');
      const siteKey = await addDesktopFabExclusion('site', 'https://example.test');
      const store = useSettingsStore();

      const exported = await store.exportSettings();
      expect(exported[DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]).toEqual(
        expect.arrayContaining([
          { scope: 'page', value: 'https://example.test/docs' },
          { scope: 'site', value: 'example.test' },
        ]),
      );
      const exportArg = secureStorage.prepareForExport.mock.calls.at(-1)[0];
      expect(exportArg).not.toHaveProperty(pageKey);
      expect(exportArg).not.toHaveProperty(siteKey);
      expect(exportArg).not.toHaveProperty(DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY);

      secureStorage.processImportedSettings.mockResolvedValueOnce({
        THEME: 'dark',
        [pageKey]: true,
        [siteKey]: true,
      });
      storageManager.set.mockClear();
      storageManager.remove.mockClear();
      await store.importSettings({
        THEME: 'dark',
        [pageKey]: true,
        [siteKey]: true,
        [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: [
          { scope: 'page', value: 'https://example.test/docs' },
          { scope: 'site', value: 'example.test' },
        ],
      });
      for (const call of storageManager.set.mock.calls) {
        expect(call[0]).not.toHaveProperty(pageKey);
        expect(call[0]).not.toHaveProperty(siteKey);
        expect(call[0]).not.toHaveProperty(DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY);
      }
      expect(persisted.has(pageKey)).toBe(true);
      expect(persisted.has(siteKey)).toBe(true);

      await store.resetSettings();

      expect(await listDesktopFabExclusions()).toEqual([]);
      expect(persisted.has(pageKey)).toBe(false);
      expect(persisted.has(siteKey)).toBe(false);
      expect(store.settings).toMatchObject({
        ...getPersistedDefaultSettings(),
        COLLAPSED_PROVIDER_CATEGORIES: { ids: [], revision: 1 }
      });
      const persistedDefaults = getPersistedDefaultSettings();
      delete persistedDefaults.COLLAPSED_PROVIDER_CATEGORIES;
      delete persistedDefaults.WINDOW_SHOW_ORIGINAL;
      expect(storageManager.set.mock.calls.at(-1)[0]).toEqual(persistedDefaults);
    });

    it('round-trips exclusions through export and import', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);
      await addDesktopFabExclusion('page', 'https://example.test/docs');
      await addDesktopFabExclusion('site', 'https://example.test');
      const store = useSettingsStore();

      const exported = await store.exportSettings();
      const section = exported[DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY];
      expect(section).toEqual(
        expect.arrayContaining([
          { scope: 'page', value: 'https://example.test/docs' },
          { scope: 'site', value: 'example.test' },
        ]),
      );
      for (const entry of section) {
        expect(Object.keys(entry).sort()).toEqual(['scope', 'value']);
      }
      expect(Object.keys(exported).some(key => key.startsWith('desktop-fab-exclusion:v1:'))).toBe(false);

      const beforeKeys = (await listDesktopFabExclusions()).map(entry => entry.key).sort();
      await storageManager.remove(beforeKeys);
      expect(await listDesktopFabExclusions()).toEqual([]);

      await store.importSettings({ _exported: true, THEME: 'dark', [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: section });

      const afterKeys = (await listDesktopFabExclusions()).map(entry => entry.key).sort();
      expect(afterKeys).toEqual(beforeKeys);
    });

    it('keeps exclusions plain text on password export', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);
      await addDesktopFabExclusion('page', 'https://example.test/docs');
      secureStorage.prepareForExport.mockResolvedValueOnce({ _hasEncryptedKeys: true, _secureKeys: 'enc' });
      const store = useSettingsStore();

      const exported = await store.exportSettings('pw');

      expect(secureStorage.prepareForExport).toHaveBeenCalledWith(expect.anything(), 'pw');
      const exportArg = secureStorage.prepareForExport.mock.calls.at(-1)[0];
      expect(exportArg).not.toHaveProperty(DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY);
      expect(exported._hasEncryptedKeys).toBe(true);
      expect(exported._secureKeys).toBe('enc');
      expect(exported[DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]).toEqual([
        { scope: 'page', value: 'https://example.test/docs' },
      ]);
    });

    it('preserves existing exclusions when the backup has no section', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);
      const pageKey = await addDesktopFabExclusion('page', 'https://example.test/docs');
      const store = useSettingsStore();

      await store.importSettings({ _exported: true, THEME: 'dark' });

      expect(persisted.has(pageKey)).toBe(true);
      expect(await listDesktopFabExclusions()).toEqual([
        { key: pageKey, scope: 'page', value: 'https://example.test/docs' },
      ]);
    });

    it('clears existing exclusions when the section is empty', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);
      const pageKey = await addDesktopFabExclusion('page', 'https://example.test/docs');
      const siteKey = await addDesktopFabExclusion('site', 'https://example.test');
      const store = useSettingsStore();

      await store.importSettings({ _exported: true, THEME: 'dark', [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: [] });

      expect(await listDesktopFabExclusions()).toEqual([]);
      expect(persisted.has(pageKey)).toBe(false);
      expect(persisted.has(siteKey)).toBe(false);
    });

    it.each([
      ['non-array section', 'not-an-array'],
      ['bad scope', [{ scope: 'nope', value: 'https://example.test/docs' }]],
      ['non-canonical casing', [{ scope: 'page', value: 'https://ExAmple.com/x' }]],
    ])('rejects malformed exclusions (%s) without touching storage', async (_label, section) => {
      const persisted = new Map();
      installPersistedMap(persisted);
      const pageKey = await addDesktopFabExclusion('page', 'https://example.test/docs');
      const store = useSettingsStore();
      storageManager.set.mockClear();
      storageManager.remove.mockClear();

      await expect(
        store.importSettings({ _exported: true, THEME: 'dark', [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: section }),
      ).rejects.toThrow('invalid_desktop_fab_exclusions');

      expect(exclusionKeyWrites()).toEqual([]);
      expect(persisted.has(pageKey)).toBe(true);
      expect(await listDesktopFabExclusions()).toEqual([
        { key: pageKey, scope: 'page', value: 'https://example.test/docs' },
      ]);
    });

    it('rejects import when exclusion replace fails', async () => {
      const persisted = new Map();
      installPersistedMap(persisted);
      await addDesktopFabExclusion('page', 'https://example.test/docs');
      storageManager.remove.mockRejectedValueOnce(new Error('exclusion remove failed'));
      const store = useSettingsStore();

      await expect(
        store.importSettings({
          _exported: true,
          THEME: 'dark',
          [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: [{ scope: 'site', value: 'example.test' }],
        }),
      ).rejects.toThrow('exclusion remove failed');
    });
  });

  it('exportSettings should call secureStorage', async () => {
    const store = useSettingsStore();
    const result = await store.exportSettings('password123');
    
    expect(secureStorage.prepareForExport).toHaveBeenCalled();
    expect(result._exported).toBe(true);
  });

  it('should reactively update isDarkTheme in auto mode when system theme changes', async () => {
    let mediaQueryListener = null;
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') {
          mediaQueryListener = handler;
        }
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn((handler) => {
        mediaQueryListener = handler;
      }),
      removeListener: vi.fn(),
    }));

    storageManager.get.mockResolvedValue({});
    const store = useSettingsStore();
    store.settings.THEME = 'auto';

    await store.loadSettings();
    await nextTick();

    expect(store.isDarkTheme).toBe(false);

    mediaQueryListener({ matches: true });
    await nextTick();
    expect(store.isDarkTheme).toBe(true);

    mediaQueryListener({ matches: false });
    await nextTick();
    expect(store.isDarkTheme).toBe(false);
  });
});

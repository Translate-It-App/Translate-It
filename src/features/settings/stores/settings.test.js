import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import useSettingsStore from './settings.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import secureStorage from '@/shared/storage/core/SecureStorage.js';
import { SelectionTranslationMode, CONFIG, TranslationMode } from '@/shared/config/config.js';
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js';
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js';
import { runSettingsMigrations } from '@/shared/config/settingsMigrations.js';

// Mock Dependencies
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(true),
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

  it('resetSettings should clear storage and restore defaults', async () => {
    const store = useSettingsStore();
    store.settings.THEME = 'dark';
    
    await store.resetSettings();
    await nextTick();
    
    expect(storageManager.clear).toHaveBeenCalled();
    expect(storageManager.set).toHaveBeenCalledWith(getPersistedDefaultSettings());
    expect(store.settings.THEME).toBe('auto');
    expect(store.settings.translationHistory).toEqual([]);
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

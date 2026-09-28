import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSettingsMigrations, mergeMissingNestedMembers } from './settingsMigrations.js';
import { HISTORICAL_PROMPT_DEFAULTS } from './promptHistoricalDefaults.js';
import { CONFIG, TranslationMode } from './config.js';
import { getPersistedDefaultSettings } from './settingsDefaults.js';

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe('Settings Migrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add missing settings from canonical persisted defaults', async () => {
    const currentSettings = { THEME: 'dark' }; // Missing most things
    const { updates, logs } = await runSettingsMigrations(currentSettings);
    
    const persistedDefaults = getPersistedDefaultSettings();
    expect(updates.APPLICATION_LOCALIZE).toBe(persistedDefaults.APPLICATION_LOCALIZE);
    expect(logs).toContain('Added missing setting: APPLICATION_LOCALIZE');
    expect(updates.TIMEOUT).toBe(CONFIG.TIMEOUT);
    expect(updates.TEXT_FIELD_SHORTCUT).toBe(CONFIG.TEXT_FIELD_SHORTCUT);
    expect(updates.translationHistory).toBeUndefined();
    expect(updates.CHANGELOG_URL).toBeUndefined();
  });

  it('should add the missing Live Dubbing provider through canonical defaults', async () => {
    const { updates, logs } = await runSettingsMigrations({});

    expect(updates.LIVE_DUBBING_PROVIDER).toBe('gemini');
    expect(logs).toContain('Added missing setting: LIVE_DUBBING_PROVIDER');
    expect(logs).not.toContain('Normalized LIVE_DUBBING_PROVIDER to gemini');
  });

  it.each([
    [true, true],
    [false, false]
  ])('splits legacy Original transcript preference %s to Gemini only', async (legacyValue, geminiValue) => {
    const { updates, removals } = await runSettingsMigrations({
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: legacyValue
    });

    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(geminiValue);
    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(false);
    expect(removals).toContain('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
  });

  it('preserves existing provider-specific Original transcript preferences', async () => {
    const { updates, removals } = await runSettingsMigrations({
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: true,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: false,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: true
    });

    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBeUndefined();
    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBeUndefined();
    expect(removals).toContain('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
  });

  it('uses imported-key presence when merged defaults include provider-specific values', async () => {
    const { updates, removals } = await runSettingsMigrations({
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: true,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: false,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: false
    }, new Set(['LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT']));

    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(true);
    expect(updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBeUndefined();
    expect(removals).toContain('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
  });

  it('makes the legacy Original transcript preference migration idempotent', async () => {
    const first = await runSettingsMigrations({ LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: true });
    const migratedSettings = {
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: first.updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: first.updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI
    };
    const second = await runSettingsMigrations(migratedSettings);

    expect(first.removals).toContain('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
    expect(second.updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBeUndefined();
    expect(second.updates.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBeUndefined();
    expect(second.removals).not.toContain('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
  });

  it.each(['gemini', 'openai'])('should preserve valid Live Dubbing provider %s', async (provider) => {
    const { updates } = await runSettingsMigrations({
      LIVE_DUBBING_PROVIDER: provider
    });

    expect(updates.LIVE_DUBBING_PROVIDER).toBeUndefined();
  });

  it.each([
    '',
    'stale-provider',
    null,
    undefined,
    {},
    42
  ])('should normalize invalid Live Dubbing provider %o to Gemini', async (provider) => {
    const baseSettings = {
      TRANSLATION_API: 'openai',
      MODE_PROVIDERS: { ...CONFIG.MODE_PROVIDERS }
    };
    const baseline = await runSettingsMigrations(baseSettings);
    const { updates, logs } = await runSettingsMigrations({
      ...baseSettings,
      LIVE_DUBBING_PROVIDER: provider,
    });

    expect(updates.LIVE_DUBBING_PROVIDER).toBe('gemini');
    expect(updates.TRANSLATION_API).toBe(baseline.updates.TRANSLATION_API);
    expect(updates.MODE_PROVIDERS).toEqual(baseline.updates.MODE_PROVIDERS);
    expect(logs).toContain('Normalized LIVE_DUBBING_PROVIDER to gemini');
  });

  it('should make Live Dubbing provider normalization idempotent', async () => {
    const first = await runSettingsMigrations({ LIVE_DUBBING_PROVIDER: 'stale-provider' });
    const second = await runSettingsMigrations({
      LIVE_DUBBING_PROVIDER: first.updates.LIVE_DUBBING_PROVIDER
    });

    expect(first.updates.LIVE_DUBBING_PROVIDER).toBe('gemini');
    expect(second.updates.LIVE_DUBBING_PROVIDER).toBeUndefined();
  });

  it('should add the missing popup active view through canonical defaults', async () => {
    const { updates, logs } = await runSettingsMigrations({});

    expect(updates.POPUP_ACTIVE_VIEW).toBe('translate');
    expect(logs).toContain('Added missing setting: POPUP_ACTIVE_VIEW');
    expect(logs).not.toContain('Normalized POPUP_ACTIVE_VIEW to translate');
  });

  it.each(['translate', 'live-dubbing'])('should preserve valid popup active view %s', async (view) => {
    const { updates } = await runSettingsMigrations({ POPUP_ACTIVE_VIEW: view });

    expect(updates.POPUP_ACTIVE_VIEW).toBeUndefined();
  });

  it.each(['', 'unknown-view', null, undefined, {}, 42])(
    'should normalize invalid popup active view %o to translate',
    async (view) => {
      const { updates, logs } = await runSettingsMigrations({ POPUP_ACTIVE_VIEW: view });

      expect(updates.POPUP_ACTIVE_VIEW).toBe('translate');
      expect(logs).toContain('Normalized POPUP_ACTIVE_VIEW to translate');
    }
  );

  it('should make popup active view normalization idempotent', async () => {
    const first = await runSettingsMigrations({ POPUP_ACTIVE_VIEW: 'unknown-view' });
    const second = await runSettingsMigrations({
      POPUP_ACTIVE_VIEW: first.updates.POPUP_ACTIVE_VIEW
    });

    expect(first.updates.POPUP_ACTIVE_VIEW).toBe('translate');
    expect(second.updates.POPUP_ACTIVE_VIEW).toBeUndefined();
  });

  it('should add missing Live Dubbing volume preferences from canonical defaults', async () => {
    const { updates, logs } = await runSettingsMigrations({});

    expect(updates.LIVE_DUBBING_ORIGINAL_VOLUME).toBe(0);
    expect(updates.LIVE_DUBBING_DUBBED_VOLUME).toBe(1);
    expect(logs).toContain('Added missing setting: LIVE_DUBBING_ORIGINAL_VOLUME');
    expect(logs).toContain('Added missing setting: LIVE_DUBBING_DUBBED_VOLUME');
  });

  it.each([0, 0.4, 1])('should preserve valid Live Dubbing original volume %p', async (volume) => {
    const { updates } = await runSettingsMigrations({ LIVE_DUBBING_ORIGINAL_VOLUME: volume });

    expect(updates.LIVE_DUBBING_ORIGINAL_VOLUME).toBeUndefined();
  });

  it.each([0, 0.4, 1])('should preserve valid Live Dubbing dubbed volume %p', async (volume) => {
    const { updates } = await runSettingsMigrations({ LIVE_DUBBING_DUBBED_VOLUME: volume });

    expect(updates.LIVE_DUBBING_DUBBED_VOLUME).toBeUndefined();
  });

  it.each([
    [-0.5, 0], [1.5, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0],
    ['0.5', 0], [null, 0], [{}, 0], [[], 0], [undefined, 0],
  ])('should normalize invalid Live Dubbing original volume %p to %p', async (stored, expected) => {
    const { updates, logs } = await runSettingsMigrations({ LIVE_DUBBING_ORIGINAL_VOLUME: stored });

    expect(updates.LIVE_DUBBING_ORIGINAL_VOLUME).toBe(expected);
    expect(logs).toContain('Normalized LIVE_DUBBING_ORIGINAL_VOLUME to 0');
  });

  it.each([
    [-0.5, 1], [1.5, 1], [Number.NaN, 1], [Number.NEGATIVE_INFINITY, 1],
    ['0.5', 1], [null, 1], [{}, 1], [[], 1], [undefined, 1],
  ])('should normalize invalid Live Dubbing dubbed volume %p to %p', async (stored, expected) => {
    const { updates, logs } = await runSettingsMigrations({ LIVE_DUBBING_DUBBED_VOLUME: stored });

    expect(updates.LIVE_DUBBING_DUBBED_VOLUME).toBe(expected);
    expect(logs).toContain('Normalized LIVE_DUBBING_DUBBED_VOLUME to 1');
  });

  it('should remove obsolete Microsoft Edge endpoint overrides', async () => {
    const { removals, logs } = await runSettingsMigrations({
      MICROSOFT_EDGE_AUTH_URL: 'https://edge.microsoft.com/translate/auth',
      MICROSOFT_EDGE_TRANSLATE_URL: 'https://api-edge.cognitive.microsofttranslator.com/translate'
    });

    expect(removals).toEqual(expect.arrayContaining([
      'MICROSOFT_EDGE_AUTH_URL',
      'MICROSOFT_EDGE_TRANSLATE_URL'
    ]));
    expect(logs).toContain('Removed obsolete setting: MICROSOFT_EDGE_AUTH_URL');
    expect(logs).toContain('Removed obsolete setting: MICROSOFT_EDGE_TRANSLATE_URL');
  });

  it('should migrate the legacy Mouse Hover ctrl trigger to primary', async () => {
    const { updates, logs } = await runSettingsMigrations({
      MOUSE_HOVER_TRIGGER: 'ctrl'
    });

    expect(updates.MOUSE_HOVER_TRIGGER).toBe('primary');
    expect(logs).toContain('Migrated MOUSE_HOVER_TRIGGER from ctrl to primary');
  });

  it.each(['hover', 'primary', 'control', 'alt', 'shift'])(
    'should preserve canonical Mouse Hover trigger %s',
    async (trigger) => {
      const { updates } = await runSettingsMigrations({
        MOUSE_HOVER_TRIGGER: trigger
      });

      expect(updates.MOUSE_HOVER_TRIGGER).toBeUndefined();
    }
  );

  it('should make Mouse Hover trigger migration idempotent', async () => {
    const first = await runSettingsMigrations({ MOUSE_HOVER_TRIGGER: 'ctrl' });
    const second = await runSettingsMigrations({
      MOUSE_HOVER_TRIGGER: first.updates.MOUSE_HOVER_TRIGGER
    });

    expect(first.updates.MOUSE_HOVER_TRIGGER).toBe('primary');
    expect(second.updates.MOUSE_HOVER_TRIGGER).toBeUndefined();
  });

  it('should not re-add non-editable prompt wrappers via missing-setting fill', async () => {
    const currentSettings = { THEME: 'dark' }; // Missing most things
    const { updates } = await runSettingsMigrations(currentSettings);

    // Genuinely persisted settings are still filled
    expect(updates.APPLICATION_LOCALIZE).toBe(CONFIG.APPLICATION_LOCALIZE);
    expect(updates.CHANGELOG_URL).toBeUndefined();
    // Non-editable wrappers are CONFIG-owned and must not be written to storage
    expect(updates.PROMPT_BASE_AI_BATCH).toBeUndefined();
    expect(updates.PROMPT_BASE_AI_BATCH_AUTO).toBeUndefined();
    expect(updates.PROMPT_BASE_SELECT).toBeUndefined();
    expect(updates.PROMPT_BASE_BATCH).toBeUndefined();
    expect(updates.PROMPT_BASE_SCREEN_CAPTURE).toBeUndefined();
    expect(updates.PROMPT_SUBTITLE_BASE).toBeUndefined();
    expect(updates.PROMPT_SUBTITLE_BATCH).toBeUndefined();
  });

  it('should report legacy stored non-editable prompt wrappers for cleanup while keeping editable prompts', async () => {
    const currentSettings = {
      THEME: 'dark',
      PROMPT_BASE_AI_BATCH: 'old wrapper',
      PROMPT_SUBTITLE_BASE: 'old subtitle wrapper',
      PROMPT_TEMPLATE: 'custom user edit $_{TEXT}'
    };
    const { updates, logs, removals } = await runSettingsMigrations(currentSettings);

    // Leftover wrappers are reported for removal by the persistence owner
    expect(removals).toEqual(
      expect.arrayContaining(['PROMPT_BASE_AI_BATCH', 'PROMPT_SUBTITLE_BASE'])
    );
    // Editable customized prompt is preserved (neither removed nor overwritten)
    expect(removals).not.toContain('PROMPT_TEMPLATE');
    expect(updates.PROMPT_TEMPLATE).toBeUndefined();
    expect(logs.some(l => l.includes('Removing obsolete stored prompt wrapper: PROMPT_BASE_AI_BATCH'))).toBe(true);
  });

  it('should report empty removals when no legacy wrappers are present', async () => {
    const currentSettings = { THEME: 'dark', PROMPT_TEMPLATE: CONFIG.PROMPT_TEMPLATE };
    const { removals } = await runSettingsMigrations(currentSettings);

    expect(removals).toEqual([]);
  });

  it('should migrate legacy MODE_PROVIDERS keys', async () => {
    const currentSettings = {
      MODE_PROVIDERS: {
        'select_element': 'google',
        'popup_translate': 'openai'
      }
    };
    
    const { updates } = await runSettingsMigrations(currentSettings);
    
    expect(updates.MODE_PROVIDERS[TranslationMode.Select_Element]).toBe('google');
    expect(updates.MODE_PROVIDERS[TranslationMode.Popup_Translate]).toBe('openai');
    expect(updates.MODE_PROVIDERS['select_element']).toBeUndefined();
  });

  it.each([
    ['gemini-3.7-flash', 'gemini-3.8-flash'],
    ['gemini-3.6-flash', 'gemini-3.8-flash'],
    ['gemini-3.5-flash', 'gemini-3.8-flash'],
    ['gemini-3.1-pro-preview', 'gemini-3.8-flash'],
    ['gemini-3-flash-preview', 'gemini-3.8-flash'],
    ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
    ['gemini-3.1-flash-lite-preview', 'gemini-3.5-flash-lite'],
    ['gemini-3-pro-preview', 'gemini-3.8-flash'],
    ['gemini-2.5-pro', 'gemini-3.8-flash'],
    ['gemini-2.5-flash', 'gemini-3.8-flash'],
    ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite']
  ])('should migrate obsolete Gemini model %s to %s', async (oldModel, newModel) => {
    const { updates, logs } = await runSettingsMigrations({
      GEMINI_MODELS: [{ value: oldModel, label: 'Legacy' }],
      GEMINI_MODEL: oldModel
    });

    expect(updates.GEMINI_MODEL).toBe(newModel);
    expect(CONFIG.GEMINI_MODELS.some(model => model.value === newModel)).toBe(true);
    expect(logs).toContain(`Migrated GEMINI_MODEL from ${oldModel} to ${newModel}`);
  });

  it.each([
    ['gemini-3.7-flash', 'gemini-3.8-flash'],
    ['gemini-3.6-flash', 'gemini-3.8-flash']
  ])('migrates inactive model %s to %s', async (oldModel, newModel) => {
    const activeModels = CONFIG.GEMINI_MODELS;
    CONFIG.GEMINI_MODELS = activeModels.filter(model => model.value !== oldModel);

    try {
      const { updates } = await runSettingsMigrations({
        GEMINI_MODELS: [{ value: oldModel, label: 'Legacy' }],
        GEMINI_MODEL: oldModel
      });

      expect(updates.GEMINI_MODEL).toBe(newModel);
    } finally {
      CONFIG.GEMINI_MODELS = activeModels;
    }
  });

  it.each(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])(
    'preserves active model %s',
    async (model) => {
      const { updates } = await runSettingsMigrations({
        GEMINI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
        GEMINI_MODEL: model
      });

      expect(updates.GEMINI_MODEL).toBeUndefined();
    }
  );

  it('keeps stable Gemini 3.5 Flash-Lite distinct from preview migration ID', async () => {
    const stableResult = await runSettingsMigrations({
      GEMINI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      GEMINI_MODEL: 'gemini-3.5-flash-lite'
    });
    const previewResult = await runSettingsMigrations({
      GEMINI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      GEMINI_MODEL: 'gemini-3.1-flash-lite-preview'
    });

    expect(stableResult.updates.GEMINI_MODEL).toBeUndefined();
    expect(previewResult.updates.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
  });

  it.each([
    ['gpt-5.6-luna', 'gpt-6-luna'],
    ['gpt-4o-mini', 'gpt-6-luna'],
    ['o1-mini', 'gpt-6-luna'],
    ['o3-mini', 'gpt-6-luna'],
    ['gpt-5.6-terra', 'gpt-6-sol'],
    ['gpt-5.6-sol', 'gpt-6-sol'],
    ['o1', 'gpt-6-sol'],
    ['gpt-4.5-preview', 'gpt-6-sol'],
    ['chatgpt-4o-latest', 'gpt-6-sol'],
    ['gpt-4o', 'gpt-6-sol']
  ])('migrates inactive OpenAI model %s to %s', async (oldModel, newModel) => {
    const { updates, logs } = await runSettingsMigrations({
      OPENAI_MODELS: [{ value: oldModel, label: 'Legacy' }],
      OPENAI_API_MODEL: oldModel
    });

    expect(updates.OPENAI_API_MODEL).toBe(newModel);
    expect(logs).toContain(`Migrated OPENAI_API_MODEL from ${oldModel} to ${newModel}`);
  });

  it('preserves current OpenAI static and arbitrary custom models', async () => {
    const currentStatic = await runSettingsMigrations({
      OPENAI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENAI_API_MODEL: 'gpt-6-luna'
    });
    const currentSol = await runSettingsMigrations({
      OPENAI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENAI_API_MODEL: 'gpt-6-sol'
    });
    const custom = await runSettingsMigrations({
      OPENAI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENAI_API_MODEL: 'provider/custom-model'
    });

    expect(currentStatic.updates.OPENAI_API_MODEL).toBeUndefined();
    expect(currentSol.updates.OPENAI_API_MODEL).toBeUndefined();
    expect(custom.updates.OPENAI_API_MODEL).toBeUndefined();
  });

  it('falls back to the new OpenAI default for an empty selection', async () => {
    const { updates, logs } = await runSettingsMigrations({
      OPENAI_MODELS: CONFIG.OPENAI_MODELS,
      OPENAI_API_MODEL: ''
    });

    expect(updates.OPENAI_API_MODEL).toBe(CONFIG.OPENAI_API_MODEL);
    expect(logs.some(log => log.includes('Reset OPENAI_API_MODEL'))).toBe(true);
  });

  it.each([
    ['deepseek-v4-flash', 'deepseek-flash', 'low', undefined],
    ['deepseek-chat', 'deepseek-flash', 'low', 'disabled'],
    ['deepseek-reasoner', 'deepseek-flash', 'low', 'high']
  ])('migrates inactive DeepSeek model %s to %s with %s thinking', async (oldModel, newModel, inputThinking, expectedThinking) => {
    const { updates, logs } = await runSettingsMigrations({
      DEEPSEEK_MODELS: [{ value: oldModel, label: 'Legacy' }],
      DEEPSEEK_API_MODEL: oldModel,
      DEEPSEEK_THINKING_MODE: inputThinking
    });

    expect(updates.DEEPSEEK_API_MODEL).toBe(newModel);
    // An already-valid Thinking Mode is preserved (no update) unless the legacy contract remaps it.
    expect(updates.DEEPSEEK_THINKING_MODE).toBe(expectedThinking);
    expect(logs).toContain(`Migrated DEEPSEEK_API_MODEL from ${oldModel} to ${newModel}`);
  });

  it.each([
    ['deepseek-chat', 'disabled'],
    ['deepseek-reasoner', 'high']
  ])('migrates legacy DeepSeek model %s without stored model list', async (oldModel, thinkingMode) => {
    const { updates } = await runSettingsMigrations({
      DEEPSEEK_API_MODEL: oldModel
    });

    expect(updates.DEEPSEEK_API_MODEL).toBe('deepseek-flash');
    expect(updates.DEEPSEEK_THINKING_MODE).toBe(thinkingMode);
  });

  it('preserves current DeepSeek models and arbitrary custom IDs', async () => {
    const currentFlash = await runSettingsMigrations({
      DEEPSEEK_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      DEEPSEEK_API_MODEL: 'deepseek-flash',
      DEEPSEEK_THINKING_MODE: 'low'
    });
    const currentPro = await runSettingsMigrations({
      DEEPSEEK_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      DEEPSEEK_API_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_THINKING_MODE: 'high'
    });
    const custom = await runSettingsMigrations({
      DEEPSEEK_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      DEEPSEEK_API_MODEL: 'provider/custom-model',
      DEEPSEEK_THINKING_MODE: 'max'
    });

    expect(currentFlash.updates.DEEPSEEK_API_MODEL).toBeUndefined();
    expect(currentPro.updates.DEEPSEEK_API_MODEL).toBeUndefined();
    expect(custom.updates.DEEPSEEK_API_MODEL).toBeUndefined();
    expect(currentFlash.updates.DEEPSEEK_THINKING_MODE).toBeUndefined();
    expect(currentPro.updates.DEEPSEEK_THINKING_MODE).toBeUndefined();
    expect(custom.updates.DEEPSEEK_THINKING_MODE).toBeUndefined();
  });

  it('falls back to the DeepSeek Flash default for an empty selection', async () => {
    const { updates, logs } = await runSettingsMigrations({
      DEEPSEEK_MODELS: CONFIG.DEEPSEEK_MODELS,
      DEEPSEEK_API_MODEL: ''
    });

    expect(updates.DEEPSEEK_API_MODEL).toBe(CONFIG.DEEPSEEK_API_MODEL);
    expect(logs.some(log => log.includes('Reset DEEPSEEK_API_MODEL'))).toBe(true);
  });

  it.each([
    ['openai/gpt-4o-mini', 'openai/gpt-6-luna'],
    ['openai/gpt-4.1-mini', 'openai/gpt-6-luna'],
    ['google/gemini-2.5-flash-lite', 'google/gemini-3.5-flash-lite'],
    ['google/gemini-2.5-flash', 'google/gemini-3.8-flash'],
    ['mistralai/mistral-small-3.2-24b-instruct', 'mistralai/mistral-small-2603'],
    ['deepseek/deepseek-chat', 'deepseek/deepseek-v4.1-flash'],
    ['qwen/qwen3.5-flash-02-23', 'qwen/qwen3.8-flash'],
    ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-5']
  ])('migrates inactive OpenRouter model %s to %s', async (oldModel, newModel) => {
    const { updates, logs } = await runSettingsMigrations({
      OPENROUTER_MODELS: [{ value: oldModel, label: 'Legacy' }],
      OPENROUTER_API_MODEL: oldModel
    });

    expect(updates.OPENROUTER_API_MODEL).toBe(newModel);
    expect(CONFIG.OPENROUTER_MODELS.some(model => model.value === newModel)).toBe(true);
    expect(logs).toContain(`Migrated OPENROUTER_API_MODEL from ${oldModel} to ${newModel}`);
  });

  it.each(CONFIG.OPENROUTER_MODELS
    .filter(model => model.value !== 'custom')
    .map(model => model.value))('preserves curated OpenRouter model ID %s during list synchronization', async (model) => {
    const current = await runSettingsMigrations({
      OPENROUTER_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENROUTER_API_MODEL: model
    });

    expect(current.updates.OPENROUTER_MODELS).toEqual(CONFIG.OPENROUTER_MODELS);
    expect(current.updates.OPENROUTER_API_MODEL).toBeUndefined();
  });

  it.each(CONFIG.REQUESTY_MODELS
    .filter(model => model.value !== 'custom')
    .map(model => model.value))('preserves curated Requesty model ID %s during list synchronization', async (model) => {
    const current = await runSettingsMigrations({
      REQUESTY_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      REQUESTY_API_MODEL: model
    });

    expect(current.updates.REQUESTY_MODELS).toEqual(CONFIG.REQUESTY_MODELS);
    expect(current.updates.REQUESTY_API_MODEL).toBeUndefined();
  });

  it('preserves removed and arbitrary OpenRouter model IDs during list synchronization', async () => {
    const removed = await runSettingsMigrations({
      OPENROUTER_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENROUTER_API_MODEL: 'openai/gpt-4o'
    });
    const custom = await runSettingsMigrations({
      OPENROUTER_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
      OPENROUTER_API_MODEL: 'provider/custom-model'
    });

    expect(removed.updates.OPENROUTER_MODELS).toEqual(CONFIG.OPENROUTER_MODELS);
    expect(removed.updates.OPENROUTER_API_MODEL).toBeUndefined();
    expect(custom.updates.OPENROUTER_MODELS).toEqual(CONFIG.OPENROUTER_MODELS);
    expect(custom.updates.OPENROUTER_API_MODEL).toBeUndefined();
  });

  it('falls back to the OpenRouter curated default for an empty selection', async () => {
    const { updates, logs } = await runSettingsMigrations({
      OPENROUTER_MODELS: CONFIG.OPENROUTER_MODELS,
      OPENROUTER_API_MODEL: ''
    });

    expect(updates.OPENROUTER_API_MODEL).toBe(CONFIG.OPENROUTER_API_MODEL);
    expect(logs.some(log => log.includes('Reset OPENROUTER_API_MODEL'))).toBe(true);
  });

  it.each(['gemini-3-flash', 'gemini-3-pro', 'provider/custom-model'])(
    'preserves WebAI model %s during model-list synchronization',
    async (model) => {
      const { updates } = await runSettingsMigrations({
        WEBAI_MODELS: [{ value: 'legacy-model', label: 'Legacy' }],
        WEBAI_API_MODEL: model
      });

      expect(updates.WEBAI_MODELS).toEqual(CONFIG.WEBAI_MODELS);
      expect(updates.WEBAI_API_MODEL).toBeUndefined();
    }
  );

  it('resets an empty WebAI model to the configured default', async () => {
    const { updates, logs } = await runSettingsMigrations({
      WEBAI_MODELS: CONFIG.WEBAI_MODELS,
      WEBAI_API_MODEL: ''
    });

    expect(updates.WEBAI_API_MODEL).toBe('gemini-3-flash');
    expect(logs.some(log => log.includes('Reset WEBAI_API_MODEL'))).toBe(true);
  });

  it('should preserve arbitrary custom model IDs when a model list changes', async () => {
    const currentSettings = {
      GEMINI_MODELS: [{ value: 'old-model', label: 'Old' }],
      GEMINI_MODEL: 'provider/custom-model'
    };

    const { updates, logs } = await runSettingsMigrations(currentSettings);
    
    expect(updates.GEMINI_MODELS).toEqual(CONFIG.GEMINI_MODELS);
    expect(updates.GEMINI_MODEL).toBeUndefined();
    expect(logs.some(l => l.includes('Reset GEMINI_MODEL'))).toBe(false);
  });

  it('should preserve current static model values during model-list synchronization', async () => {
    const { updates } = await runSettingsMigrations({
      GEMINI_MODELS: [{ value: 'old-model', label: 'Old' }],
      GEMINI_MODEL: 'custom'
    });

    expect(updates.GEMINI_MODEL).toBeUndefined();
  });

  it('should fall back when a custom-capable provider has no usable selected model', async () => {
    const { updates, logs } = await runSettingsMigrations({
      GEMINI_MODELS: CONFIG.GEMINI_MODELS,
      GEMINI_MODEL: ''
    });

    expect(updates.GEMINI_MODEL).toBe(CONFIG.GEMINI_MODEL);
    expect(logs.some(l => l.includes('Reset GEMINI_MODEL'))).toBe(true);
  });

  it('should retain reset behavior for a provider without custom support', async () => {
    const originalModels = CONFIG.GEMINI_MODELS;
    CONFIG.GEMINI_MODELS = originalModels.filter(model => model.value !== 'custom');

    try {
      const { updates, logs } = await runSettingsMigrations({
        GEMINI_MODELS: [{ value: 'old-model', label: 'Old' }],
        GEMINI_MODEL: 'provider/custom-model'
      });

      expect(updates.GEMINI_MODEL).toBe(CONFIG.GEMINI_MODEL);
      expect(logs.some(l => l.includes('Reset GEMINI_MODEL'))).toBe(true);
    } finally {
      CONFIG.GEMINI_MODELS = originalModels;
    }
  });

  it('should migrate API_KEY to GEMINI_API_KEY', async () => {
    const currentSettings = {
      API_KEY: 'my-old-key',
      GEMINI_API_KEY: ''
    };
    
    const { updates, logs } = await runSettingsMigrations(currentSettings);
    expect(updates.GEMINI_API_KEY).toBe('my-old-key');
    expect(updates.API_KEY).toBe('');
    expect(logs).toContain('Migrated API_KEY to GEMINI_API_KEY (multi-key support)');
  });

  it.each([
    [{ GEMINI_THINKING_ENABLED: false }, 'default'],
    [{ GEMINI_THINKING_ENABLED: true }, 'minimal'],
    [{ GEMINI_THINKING_ENABLED: true, GEMINI_THINKING_MODE: 'invalid' }, 'default'],
    [{}, 'default'],
  ])('migrates Gemini thinking setting %o to %s', async (currentSettings, expectedMode) => {
    const { updates } = await runSettingsMigrations(currentSettings);

    expect(updates.GEMINI_THINKING_MODE).toBe(expectedMode);
  });

  it.each([
    [{ GEMINI_THINKING_ENABLED: true, GEMINI_THINKING_MODE: 'default' }, 'default'],
    [{ GEMINI_THINKING_ENABLED: false, GEMINI_THINKING_MODE: 'minimal' }, 'minimal']
  ])('preserves valid Gemini thinking mode %o over legacy state', async (currentSettings, expectedMode) => {
    const { updates, removals } = await runSettingsMigrations(currentSettings);

    expect(updates.GEMINI_THINKING_MODE).toBeUndefined();
    expect(currentSettings.GEMINI_THINKING_MODE).toBe(expectedMode);
    expect(removals).toContain('GEMINI_THINKING_ENABLED');
  });

  it.each([
    [true, 'minimal'],
    [false, 'default']
  ])('removes legacy Gemini thinking state during migration (%s)', async (legacyValue, expectedMode) => {
    const { updates, removals } = await runSettingsMigrations({ GEMINI_THINKING_ENABLED: legacyValue });

    expect(updates.GEMINI_THINKING_MODE).toBe(expectedMode);
    expect(removals).toContain('GEMINI_THINKING_ENABLED');
  });

  it('keeps invalid Gemini mode behavior and removes legacy state', async () => {
    const { updates, removals } = await runSettingsMigrations({
      GEMINI_THINKING_MODE: 'invalid',
      GEMINI_THINKING_ENABLED: true
    });

    expect(updates.GEMINI_THINKING_MODE).toBe('default');
    expect(removals).toContain('GEMINI_THINKING_ENABLED');
  });

  it('should preserve user sensitive data like translationHistory', async () => {
    const history = [{ text: 'a', translated: 'b' }];
    const currentSettings = {
      translationHistory: history
    };
    
    const { updates } = await runSettingsMigrations(currentSettings);
    expect(updates.translationHistory).toBeUndefined(); // Should not be in updates (no change)
  });

  // --- Safe Prompt Migration Tests ---

  it('should add current default when prompt key is missing', async () => {
    const currentSettings = {
      THEME: 'light'
    };
    // Ensure PROMPT_TEMPLATE is missing in currentSettings
    delete currentSettings.PROMPT_TEMPLATE;

    const { updates, logs } = await runSettingsMigrations(currentSettings);
    expect(updates.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
    expect(logs).toContain('Added missing prompt setting: PROMPT_TEMPLATE');
  });

  it('should restore current default when prompt template is empty', async () => {
    const currentSettings = {
      PROMPT_TEMPLATE: '   '
    };

    const { updates, logs } = await runSettingsMigrations(currentSettings);
    expect(updates.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
    expect(logs.some(l => l.includes('Restored empty/missing prompt PROMPT_TEMPLATE to default'))).toBe(true);
  });

  it('should leave prompt unchanged when it exactly matches current default', async () => {
    const currentSettings = {
      PROMPT_TEMPLATE: CONFIG.PROMPT_TEMPLATE
    };

    const { updates } = await runSettingsMigrations(currentSettings);
    expect(updates.PROMPT_TEMPLATE).toBeUndefined();
  });

  it('should migrate historical legacy defaults (string format) to current default', async () => {
    // Add a temporary mock historical default to test matching
    const testOldDefault = 'legacy old default template _{SOURCE} _{TARGET} _{TEXT}';
    if (!HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE) {
      HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE = [];
    }
    HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.push(testOldDefault);

    try {
      const currentSettings = {
        PROMPT_TEMPLATE: testOldDefault
      };

      const { updates, logs } = await runSettingsMigrations(currentSettings);
      expect(updates.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
      expect(logs.some(l => l.includes('Upgraded legacy default prompt PROMPT_TEMPLATE to latest version'))).toBe(true);
    } finally {
      // Clean up to ensure test isolation
      const index = HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.indexOf(testOldDefault);
      if (index > -1) {
        HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.splice(index, 1);
      }
    }
  });

  it('should migrate historical legacy defaults (object format) to current default', async () => {
    // Add a temporary mock historical default in object format to test matching
    const testOldDefaultObj = {
      version: 'v1.17.0',
      reason: 'Legacy default to migrate',
      value: 'legacy old default template in object format _{SOURCE} _{TARGET} _{TEXT}'
    };
    if (!HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE) {
      HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE = [];
    }
    HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.push(testOldDefaultObj);

    try {
      const currentSettings = {
        PROMPT_TEMPLATE: testOldDefaultObj.value
      };

      const { updates, logs } = await runSettingsMigrations(currentSettings);
      expect(updates.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
      expect(logs.some(l => l.includes('Upgraded legacy default prompt PROMPT_TEMPLATE to latest version'))).toBe(true);
    } finally {
      // Clean up to ensure test isolation
      const index = HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.indexOf(testOldDefaultObj);
      if (index > -1) {
        HISTORICAL_PROMPT_DEFAULTS.PROMPT_TEMPLATE.splice(index, 1);
      }
    }
  });

  it('should preserve customized prompt during migration', async () => {
    const customPrompt = 'My custom customized prompt $_{SOURCE} $_{TARGET} $_{TEXT}';
    const currentSettings = {
      PROMPT_TEMPLATE: customPrompt
    };

    const { updates } = await runSettingsMigrations(currentSettings);
    // Custom template must be preserved (not overwritten/reverted)
    expect(updates.PROMPT_TEMPLATE).toBeUndefined();
  });

  // --- Nested Object Migration Tests ---

  it('should add a missing top-level nested object with its complete default', async () => {
    const currentSettings = { THEME: 'dark' }; // CONTEXT_MENU_VISIBILITY absent
    const { updates, logs } = await runSettingsMigrations(currentSettings);

    expect(updates.CONTEXT_MENU_VISIBILITY).toEqual(CONFIG.CONTEXT_MENU_VISIBILITY);
    expect(logs).toContain('Added missing setting: CONTEXT_MENU_VISIBILITY');
  });

  it('should backfill a missing nested member while preserving existing members', async () => {
    const currentSettings = {
      CONTEXT_MENU_VISIBILITY: {
        PAGE_CONTEXT_SELECT_ELEMENT: false
      }
    };

    const { updates } = await runSettingsMigrations(currentSettings);

    expect(updates.CONTEXT_MENU_VISIBILITY).toEqual({
      ...CONFIG.CONTEXT_MENU_VISIBILITY,
      PAGE_CONTEXT_SELECT_ELEMENT: false
    });
    expect(updates.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_SELECT_ELEMENT).toBe(false);
    expect(updates.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_SCREEN_CAPTURE).toBe(true);
  });

  it('should not emit an update when all nested members are already present', async () => {
    const currentSettings = {
      CONTEXT_MENU_VISIBILITY: { ...CONFIG.CONTEXT_MENU_VISIBILITY }
    };

    const { updates } = await runSettingsMigrations(currentSettings);
    expect(updates.CONTEXT_MENU_VISIBILITY).toBeUndefined();
  });

  it('should backfill a newly added nested flag into an older persisted object', async () => {
    const currentSettings = {
      CONTEXT_MENU_VISIBILITY: {
        PAGE_CONTEXT_SELECT_ELEMENT: true,
        PAGE_CONTEXT_SCREEN_CAPTURE: true,
        PAGE_CONTEXT_PDF_TRANSLATOR: true,
        ACTION_CONTEXT_SELECT_ELEMENT: true,
        ACTION_CONTEXT_SCREEN_CAPTURE: true,
        ACTION_CONTEXT_OPTIONS: true,
        ACTION_CONTEXT_SHORTCUTS: true,
        ACTION_CONTEXT_HELP: true
      }
    };

    const { updates } = await runSettingsMigrations(currentSettings);

    expect(updates.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_PDF_TRANSLATOR).toBe(true);
    expect(updates.CONTEXT_MENU_VISIBILITY.PAGE_CONTEXT_SELECT_ELEMENT).toBe(true);
    expect(updates.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_PDF_TRANSLATOR).toBe(true);
    expect(updates.CONTEXT_MENU_VISIBILITY.ACTION_CONTEXT_SUBTITLE_TRANSLATOR).toBe(true);
  });

  it('should preserve existing nested user values and backfill missing MODE_PROVIDERS members', async () => {
    const currentSettings = {
      MODE_PROVIDERS: {
        [TranslationMode.Select_Element]: 'google'
      }
    };

    const { updates } = await runSettingsMigrations(currentSettings);

    expect(updates.MODE_PROVIDERS[TranslationMode.Select_Element]).toBe('google');
    expect(updates.MODE_PROVIDERS[TranslationMode.Popup_Translate]).toBe(null);
    expect(updates.MODE_PROVIDERS[TranslationMode.Page]).toBe(null);
  });

  it('should not clobber a remap result from an earlier migration pass', async () => {
    const currentSettings = {
      MODE_PROVIDERS: {
        'select_element': 'google'
      }
    };

    const { updates } = await runSettingsMigrations(currentSettings);

    // Remap renamed the legacy key BEFORE nested backfill; the legacy key must not return
    expect(updates.MODE_PROVIDERS[TranslationMode.Select_Element]).toBe('google');
    expect(updates.MODE_PROVIDERS['select_element']).toBeUndefined();
  });

  it('should preserve an existing empty-string nested member', async () => {
    const stored = { text: '' };
    const defaults = { text: 'default', extra: 'added' };
    expect(mergeMissingNestedMembers(stored, defaults)).toEqual({ text: '', extra: 'added' });
  });

  it('should preserve existing false and zero nested members', async () => {
    const stored = { enabled: false, level: 0 };
    const defaults = { enabled: true, level: 1, extra: true };
    expect(mergeMissingNestedMembers(stored, defaults)).toEqual({
      enabled: false,
      level: 0,
      extra: true
    });
  });

  it('should recursively backfill deeply missing nested members', async () => {
    const stored = { a: { b: {} } };
    const defaults = { a: { b: { c: 1 }, d: 2 }, e: 3 };
    expect(mergeMissingNestedMembers(stored, defaults)).toEqual({
      a: { b: { c: 1 }, d: 2 },
      e: 3
    });
  });

  it('should not overwrite a cross-type stored primitive (default is object)', async () => {
    const stored = { edge: 'legacy-voice-id' };
    const defaults = { edge: null, google: null };
    expect(mergeMissingNestedMembers(stored, defaults)).toEqual({
      edge: 'legacy-voice-id',
      google: null
    });
  });

  it('should not recurse into a cross-type stored object (default is primitive)', async () => {
    const stored = { x: { a: 1 } };
    const defaults = { x: 1 };
    expect(mergeMissingNestedMembers(stored, defaults)).toBeNull();
  });

  it('should treat arrays as leaves and never element-merge', async () => {
    const stored = { models: [{ value: 'old', thinking: { enabled: true } }] };
    const defaults = { models: [{ value: 'new', thinking: { enabled: false } }], extra: 1 };
    expect(mergeMissingNestedMembers(stored, defaults)).toEqual({
      models: [{ value: 'old', thinking: { enabled: true } }],
      extra: 1
    });
  });

  it('should add a missing array member as a complete leaf', async () => {
    expect(mergeMissingNestedMembers({}, { models: [1, 2] })).toEqual({ models: [1, 2] });
  });

  it('should not recursively process RegExp values', async () => {
    const regex = /[a-z]/;
    expect(mergeMissingNestedMembers({}, { re: regex })).toEqual({ re: regex });
    expect(mergeMissingNestedMembers({ re: /[0-9]/ }, { re: regex })).toBeNull();
  });

  it('should be a no-op for empty dictionary defaults', async () => {
    expect(mergeMissingNestedMembers({}, {})).toBeNull();
    expect(mergeMissingNestedMembers({ custom: 'value' }, {})).toBeNull();
  });

  it('should not mutate either input object', async () => {
    const stored = { a: { keep: 'v' } };
    const defaults = { a: { keep: 'v', add: 2 }, top: 3 };
    const storedSnapshot = JSON.stringify(stored);
    const defaultsSnapshot = JSON.stringify(defaults);

    mergeMissingNestedMembers(stored, defaults);

    expect(JSON.stringify(stored)).toBe(storedSnapshot);
    expect(JSON.stringify(defaults)).toBe(defaultsSnapshot);
  });

  it('should skip DO_NOT_MIGRATE settings entirely', async () => {
    const currentSettings = {
      EXCLUDED_SITES: ['example.com'],
      OPENAI_API_KEY: 'secret'
    };

    const { updates } = await runSettingsMigrations(currentSettings);
    expect(updates.EXCLUDED_SITES).toBeUndefined();
    expect(updates.OPENAI_API_KEY).toBeUndefined();
  });
});

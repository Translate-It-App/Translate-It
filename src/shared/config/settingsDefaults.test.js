import { describe, expect, it } from 'vitest';
import { CONFIG } from './config.js';
import { PROMPT_REGISTRY } from './PromptRegistry.js';
import { getPersistedDefaultSettings } from './settingsDefaults.js';

describe('getPersistedDefaultSettings', () => {
  it('returns fresh mutable defaults without CONFIG-owned nested references', () => {
    const first = getPersistedDefaultSettings();
    const second = getPersistedDefaultSettings();

    expect(first).not.toBe(second);
    first.MODE_PROVIDERS.example = 'changed';
    first.OPENAI_MODELS.push({ value: 'test-only' });

    expect(second.MODE_PROVIDERS.example).toBeUndefined();
    expect(second.OPENAI_MODELS).not.toContainEqual({ value: 'test-only' });
    expect(CONFIG.MODE_PROVIDERS.example).toBeUndefined();
    expect(CONFIG.OPENAI_MODELS).not.toContainEqual({ value: 'test-only' });
  });

  it('contains persisted settings and excludes runtime-only CONFIG keys', () => {
    const defaults = getPersistedDefaultSettings();

    expect(defaults.THEME).toBe(CONFIG.THEME);
    expect(defaults.TIMEOUT).toBe(CONFIG.TIMEOUT);
    expect(CONFIG.LIVE_DUBBING_PROVIDER).toBe('gemini');
    expect(defaults.LIVE_DUBBING_PROVIDER).toBe(CONFIG.LIVE_DUBBING_PROVIDER);
    expect(CONFIG.LIVE_DUBBING_TARGET_LANGUAGE).toBe('en');
    expect(defaults.LIVE_DUBBING_TARGET_LANGUAGE).toBe(CONFIG.LIVE_DUBBING_TARGET_LANGUAGE);
    expect(CONFIG.POPUP_ACTIVE_VIEW).toBe('translate');
    expect(defaults.POPUP_ACTIVE_VIEW).toBe(CONFIG.POPUP_ACTIVE_VIEW);
    expect(CONFIG.LIVE_DUBBING_ORIGINAL_VOLUME).toBe(0);
    expect(defaults.LIVE_DUBBING_ORIGINAL_VOLUME).toBe(0);
    expect(CONFIG.LIVE_DUBBING_DUBBED_VOLUME).toBe(1);
    expect(defaults.LIVE_DUBBING_DUBBED_VOLUME).toBe(1);
    expect(CONFIG.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT).toBe(false);
    expect(defaults.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT).toBe(false);
    expect(CONFIG.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(false);
    expect(defaults.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(false);
    expect(CONFIG.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(false);
    expect(defaults.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(false);
    expect(defaults).not.toHaveProperty('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT');
    expect(CONFIG.LIVE_DUBBING_USE_TRANSLATION_FONT).toBe(false);
    expect(defaults.LIVE_DUBBING_USE_TRANSLATION_FONT).toBe(false);
    expect(CONFIG.LIVE_DUBBING_SUBTITLE_SIZE).toBe('medium');
    expect(defaults.LIVE_DUBBING_SUBTITLE_SIZE).toBe('medium');
    expect(defaults.GEMINI_MODEL).toBe(CONFIG.GEMINI_MODEL);
    expect(defaults.GEMINI_API_URL).toBe(CONFIG.GEMINI_API_URL);
    expect(defaults.GEMINI_MODELS).toEqual(CONFIG.GEMINI_MODELS);
    expect(defaults).not.toHaveProperty('GEMINI_THINKING_ENABLED');
    expect(defaults.OPENAI_API_MODEL).toBe(CONFIG.OPENAI_API_MODEL);
    expect(defaults.OPENAI_MODELS).toEqual(CONFIG.OPENAI_MODELS);
    expect(defaults.DEEPSEEK_API_MODEL).toBe(CONFIG.DEEPSEEK_API_MODEL);
    expect(defaults.DEEPSEEK_THINKING_MODE).toBe(CONFIG.DEEPSEEK_THINKING_MODE);
    expect(defaults.DEEPSEEK_MODELS).toEqual(CONFIG.DEEPSEEK_MODELS);
    expect(defaults.OPENROUTER_API_MODEL).toBe(CONFIG.OPENROUTER_API_MODEL);
    expect(defaults.OPENROUTER_MODELS).toEqual(CONFIG.OPENROUTER_MODELS);
    expect(defaults).not.toHaveProperty('OPENROUTER_API_URL');
    expect(defaults.REQUESTY_API_MODEL).toBe(CONFIG.REQUESTY_API_MODEL);
    expect(defaults.REQUESTY_MODELS).toEqual(CONFIG.REQUESTY_MODELS);
    expect(defaults).not.toHaveProperty('REQUESTY_API_URL');
    expect(defaults.WEBAI_API_MODEL).toBe(CONFIG.WEBAI_API_MODEL);
    expect(defaults.WEBAI_MODELS).toEqual(CONFIG.WEBAI_MODELS);
    expect(defaults.GEMINI_THINKING_MODE).toBe('default');
    expect(defaults).not.toHaveProperty('OPENAI_API_URL');
    expect(defaults.TEXT_FIELD_SHORTCUT).toBe(CONFIG.TEXT_FIELD_SHORTCUT);
    expect(defaults.MOUSE_HOVER_TRIGGER).toBe(CONFIG.MOUSE_HOVER_TRIGGER);
    expect(defaults.translationHistory).toBeUndefined();
    expect(defaults.PROMPT_TEMPLATE).toBe(CONFIG.PROMPT_TEMPLATE);
    expect(defaults.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE');
    expect(defaults.APP_NAME).toBeUndefined();
    expect(defaults.CHANGELOG_URL).toBeUndefined();
    expect(defaults.GOOGLE_TRANSLATE_URL).toBeUndefined();
  });

  it('excludes every non-editable prompt wrapper', () => {
    const defaults = getPersistedDefaultSettings();

    Object.values(PROMPT_REGISTRY)
      .filter(prompt => !prompt.editable)
      .forEach(prompt => expect(defaults[prompt.key]).toBeUndefined());
  });
});

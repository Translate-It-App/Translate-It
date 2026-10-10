import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import TTSTab from './TTSTab.vue';
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js';
import { resolveTTSFlagCode } from './ttsFlag.js';
import { PROVIDER_CONFIGS } from '@/features/tts/constants/ttsProviders.js';

const mockLanguages = vi.hoisted(() => ({ languages: [{ code: 'en', name: 'English' }] }));

// Mock unified i18n (same pattern as other Options tab tests)
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key
  })
}));

// Mock settings store: updateSettingLocally applies synchronously (mirrors the
// real store); updateSettingAndPersist only records calls.
const mockUpdateSettingLocally = vi.fn((key, value) => {
  mockSettingsStore.settings[key] = value;
});
const mockUpdateSettingAndPersist = vi.fn().mockResolvedValue(true);
const mockSettingsStore = reactive({
  settings: {
    TTS_ENGINE: 'google',
    TTS_FALLBACK_ENABLED: true,
    TTS_AUTO_DETECT_ENABLED: true,
    TTS_PREFERRED_VOICES: {}
  },
  updateSettingLocally: mockUpdateSettingLocally,
  updateSettingAndPersist: mockUpdateSettingAndPersist
});

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}));

// Mock language list (single language keeps drawer selectors unambiguous)
vi.mock('@/composables/shared/useLanguages.js', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    useLanguages: () => ({
      isLoaded: vueRef(true),
      translationLanguages: vueRef(mockLanguages.languages),
      loadLanguages: vi.fn().mockResolvedValue()
    })
  };
});

// Mock TTS preview player and observe speak() calls
const mockSpeak = vi.fn().mockResolvedValue(true);
const mockStop = vi.fn().mockResolvedValue();
vi.mock('@/features/tts/composables/useTTSSmart.js', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    useTTSSmart: () => ({
      speak: mockSpeak,
      stop: mockStop,
      isPlaying: vueRef(false),
      isLoading: vueRef(false)
    })
  };
});

vi.mock('@/features/tts/services/TTSVoiceService.js', () => ({
  ttsVoiceService: {
    getVoices: vi.fn().mockResolvedValue([])
  }
}));

vi.mock('@/features/tts/services/TTSLanguageService.js', () => ({
  TTSLanguageService: {
    supportsLanguage: vi.fn().mockReturnValue(true)
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

describe('TTSTab.vue - Voices drawer staged save', () => {
  // Sync Transition stub so drawer v-if teardown applies without waiting for
  // real leave animations (transition behavior itself is not under test).
  const mountTab = () => mount(TTSTab, {
    global: {
      stubs: {
        transition: { template: '<div><slot /></div>' }
      }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsStore.settings.TTS_ENGINE = 'google';
    mockSettingsStore.settings.TTS_PREFERRED_VOICES = {};
    mockLanguages.languages = [{ code: 'en', name: 'English' }];
  });

  const openDrawer = async (wrapper) => {
    await wrapper.find('#TTS_MANAGE_VOICES_BTN').trigger('click');
    await flushPromises();
  };

  const setVoiceSelect = async (wrapper, value) => {
    await wrapper.find('.voice-select-dropdown').setValue(value);
  };

  const clickDone = async (wrapper) => {
    await wrapper.find('.drawer-footer-actions button').trigger('click');
    await flushPromises();
  };

  it('resolves explicit, regional, base-language, and unknown flag codes', () => {
    expect(resolveTTSFlagCode({ code: 'en-us', flagCode: 'ir' })).toBe('ir');
    expect(resolveTTSFlagCode({ code: 'en-us' })).toBe('us');
    expect(resolveTTSFlagCode({ code: 'ja-JP' })).toBe('jp');
    expect(resolveTTSFlagCode({ code: 'en', flagCode: 'missing' })).toBe('un');
    expect(resolveTTSFlagCode({ code: 'unknown' })).toBe('un');
    expect(resolveTTSFlagCode()).toBe('un');
  });

  it('renders bundled flag images and uses the neutral image for unknown languages', async () => {
    mockLanguages.languages = [
      { code: 'en', name: 'English' },
      { code: 'xx-unknown', name: 'Unknown' }
    ];
    const wrapper = mountTab();
    await openDrawer(wrapper);

    const flags = wrapper.findAll('.lang-flag img');
    expect(flags.map(flag => flag.attributes('src'))).toEqual([
      'icons/flags/gb.svg',
      'icons/flags/un.svg'
    ]);
    expect(flags.map(flag => flag.attributes('alt'))).toEqual(['', '']);
    expect(flags.every(flag => flag.attributes('aria-hidden') === 'true')).toBe(true);
    expect(wrapper.findAll('.lang-meta').every(item => !/[\u{1F1E6}-\u{1F1FF}]/u.test(item.text()))).toBe(true);
    expect(browser.runtime.getURL).toHaveBeenCalledWith('icons/flags/gb.svg');
    expect(browser.runtime.getURL).toHaveBeenCalledWith('icons/flags/un.svg');
  });

  it('maps every engine-supported locale and provider language to a bundled flag asset', async () => {
    const { TTSLanguageService: languageService } = await vi.importActual('@/features/tts/services/TTSLanguageService.js');
    const providerLanguages = new Set([
      ...PROVIDER_CONFIGS.google.supportedLanguages,
      ...Object.keys(PROVIDER_CONFIGS.edge.voices)
    ]);
    const localeDirectory = resolve('src/utils/i18n/locales');
    const localeLanguages = readdirSync(localeDirectory)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(resolve(localeDirectory, file), 'utf8')).code);
    const exposedLanguages = new Set([...providerLanguages, ...localeLanguages].filter(code =>
      languageService.supportsLanguage('google', code) || languageService.supportsLanguage('edge', code)
    ));
    const expectedMappings = {
      it: 'it', no: 'no', fi: 'fi', pl: 'pl', ro: 'ro', hu: 'hu', sk: 'sk',
      th: 'th', vi: 'vn', ms: 'my', ps: 'af', bg: 'bg', hr: 'hr', lv: 'lv',
      lt: 'lt', ga: 'ie', is: 'is', mk: 'mk', az: 'az', mn: 'mn', so: 'so', to: 'to'
    };

    Object.entries(expectedMappings).forEach(([language, flag]) => {
      expect(resolveTTSFlagCode({ code: language })).toBe(flag);
    });
    exposedLanguages.forEach((code) => {
      const flag = resolveTTSFlagCode({ code });
      if (code !== 'eo') expect(flag, `${code} should have a country flag`).not.toBe('un');
      expect(existsSync(resolve('src/icons/flags', `${flag}.svg`)), `${code} -> ${flag}`).toBe(true);
    });
    expect(resolveTTSFlagCode({ code: 'eo' })).toBe('un');
  });

  it('open seeds the draft from the store without aliasing it', async () => {
    mockSettingsStore.settings.TTS_PREFERRED_VOICES = {
      de: { edge: 'default', google: 'de-de' }
    };
    const wrapper = mountTab();
    await openDrawer(wrapper);

    // Draft visible in drawer; editing the draft never touches the store.
    await setVoiceSelect(wrapper, 'en-us');
    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      de: { edge: 'default', google: 'de-de' }
    });
    expect(mockUpdateSettingAndPersist).not.toHaveBeenCalled();
  });

  it('nested voice objects are independently cloned on open', async () => {
    mockSettingsStore.settings.TTS_PREFERRED_VOICES = {
      en: { edge: 'en-e1', google: 'en-g1' }
    };
    const wrapper = mountTab();
    await openDrawer(wrapper);

    // Editing the draft mutates only draft-owned nested objects.
    await setVoiceSelect(wrapper, 'en-us');
    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'en-e1', google: 'en-g1' }
    });
    expect(mockUpdateSettingAndPersist).not.toHaveBeenCalled();
  });

  it('Done stages via updateSettingLocally and never persists immediately', async () => {
    const wrapper = mountTab();
    await openDrawer(wrapper);

    await setVoiceSelect(wrapper, 'en-us');
    await clickDone(wrapper);

    expect(mockUpdateSettingLocally).toHaveBeenCalledWith('TTS_PREFERRED_VOICES', {
      en: { edge: 'default', google: 'en-us' }
    });
    expect(mockUpdateSettingAndPersist).not.toHaveBeenCalled();
    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'default', google: 'en-us' }
    });
    // Drawer closed.
    expect(wrapper.find('.drawer-container').exists()).toBe(false);
  });

  it('Done stores a copy: later draft edits cannot alias store state', async () => {
    const wrapper = mountTab();
    await openDrawer(wrapper);

    await setVoiceSelect(wrapper, 'en-us');
    await clickDone(wrapper);

    // Reopen (fresh deep copy) and edit the draft again without Done.
    await openDrawer(wrapper);
    await setVoiceSelect(wrapper, 'en-gb');

    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'default', google: 'en-us' }
    });
  });

  it('Cancel leaves the store unchanged', async () => {
    mockSettingsStore.settings.TTS_PREFERRED_VOICES = {
      en: { edge: 'default', google: 'en-us' }
    };
    const wrapper = mountTab();
    await openDrawer(wrapper);

    await setVoiceSelect(wrapper, 'en-gb');
    await wrapper.find('.drawer-close-btn').trigger('click');
    await flushPromises();

    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'default', google: 'en-us' }
    });
    expect(mockUpdateSettingLocally).not.toHaveBeenCalledWith(
      'TTS_PREFERRED_VOICES',
      expect.anything()
    );
    expect(mockUpdateSettingAndPersist).not.toHaveBeenCalled();
  });

  it('preview receives the temp draft explicitly without touching the store', async () => {
    const wrapper = mountTab();
    await openDrawer(wrapper);

    await setVoiceSelect(wrapper, 'en-us');
    await wrapper.find('.preview-btn').trigger('click');
    await flushPromises();

    expect(mockSpeak).toHaveBeenCalledWith(
      expect.any(String),
      'en',
      expect.objectContaining({
        preferredVoices: { en: { edge: 'default', google: 'en-us' } }
      })
    );
    expect(mockUpdateSettingAndPersist).not.toHaveBeenCalled();
  });

  it('staged voices land on a canonical persisted key (normal save picks them up)', async () => {
    const wrapper = mountTab();
    await openDrawer(wrapper);

    await setVoiceSelect(wrapper, 'en-us');
    await clickDone(wrapper);

    // saveAllSettings() snapshots live canonical state (covered by the settings
    // store suite); staging onto a canonical key is what connects the flows.
    expect(Object.keys(getPersistedDefaultSettings())).toContain('TTS_PREFERRED_VOICES');
    expect(mockSettingsStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'default', google: 'en-us' }
    });
  });
});

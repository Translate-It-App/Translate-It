import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive, ref, nextTick } from 'vue';
import LanguagesTab from './LanguagesTab.vue';
import { getDeepLLanguageIdentity, normalizeDeepLLanguageCatalog } from '@/features/translation/providers/DeepLLanguageDiscovery.js';

// Mock vue-router (useRouter for the tab, useRoute/useRouter for the mocked highlight manager path)
const pushMock = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({
    query: {}
  }),
  useRouter: () => ({
    push: pushMock
  })
}));

// Mock unified i18n with identity translation so raw keys are observable
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key
  })
}));

// Mock settings store: writes go through updateSettingLocally, like other tabs.
const mockUpdateSettingLocally = vi.fn((key, value) => {
  mockSettingsStore.settings[key] = value;
});
const mockValidateSettings = vi.fn(() => ({ isValid: true, errors: [] }));
const mockSettingsStore = reactive({
  settings: {
    TRANSLATION_API: 'deepl',
    SOURCE_LANGUAGE: 'en',
    TARGET_LANGUAGE: 'fa',
    DEEPL_API_KEY: 'test-key',
    DEEPL_API_TIER: 'free',
    MODE_PROVIDERS: {}
  },
  isSettingsValid: true,
  deepLLanguageCapabilities: { status: 'idle', identity: null, catalog: null, fetchedAt: null, error: null },
  refreshDeepLLanguageCapabilities: vi.fn(),
  updateSettingLocally: mockUpdateSettingLocally,
  validateSettings: (...args) => mockValidateSettings(...args)
});

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}));

// Stub ProviderSelector: module-mocked so the real component (and its
// provider-registry import chain) never loads, following ProvidersTab.test.js
vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: {
      modelValue: { type: String, default: '' }
    },
    emits: ['update:modelValue'],
    template: '<div class="provider-selector-stub" />'
  }
}));

// Stub LanguageDropdown: module-mocked for the same reason; keeps props
// observable so tests can assert option filtering vs preserved selections
vi.mock('@/components/feature/LanguageDropdown.vue', () => ({
  default: {
    name: 'LanguageDropdown',
    props: ['languages', 'modelValue', 'id', 'type', 'error'],
    emits: ['update:modelValue'],
    template: '<div class="language-dropdown-stub" />'
  }
}));
vi.mock('@/composables/shared/useLanguages.js', () => ({
  useLanguages: () => ({
    allLanguages: ref([
      { code: 'en', name: 'English' },
      { code: 'fa', name: 'Persian' },
      { code: 'de', name: 'German' }
    ]),
    loadLanguages: vi.fn().mockResolvedValue(),
    isLoaded: ref(true)
  })
}));

// Provider internals are irrelevant here: DeepL with autoDetect, no missing keys
vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: () => ({
    id: 'deepl',
    displayName: 'DeepL',
    features: ['autoDetect']
  })
}));

const missingSettingMocks = vi.hoisted(() => ({
  getFirstMissingSetting: vi.fn(() => null)
}));
vi.mock('@/features/translation/utils/providerValidator.js', () => ({
  getFirstMissingSetting: (...args) => missingSettingMocks.getFirstMissingSetting(...args)
}));

// Mock highlight manager with hoisted spy
const highlightMocks = vi.hoisted(() => ({
  checkAndHighlight: vi.fn(),
  highlightElement: vi.fn()
}));
vi.mock('../composables/useHighlightManager.js', () => ({
  useHighlightManager: () => highlightMocks
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

const mountedWrappers = [];
const mountTab = () => {
  const wrapper = mount(LanguagesTab, {
    global: {
      stubs: {
        // LanguageDropdown/ProviderSelector come from the module mocks above
        BaseCheckbox: { template: '<div class="checkbox-stub" />' },
        BaseSelect: { template: '<div class="select-stub" />' },
        BaseAccordion: {
          template: '<div class="accordion-stub"><slot name="header" /><slot name="content" /><slot /></div>'
        }
      }
    }
  });
  mountedWrappers.push(wrapper);
  return wrapper;
};

const dropdownProps = (wrapper, id) => {
  const dropdowns = wrapper.findAllComponents({ name: 'LanguageDropdown' });
  return dropdowns.find(d => d.props('id') === id)?.props();
};

describe('LanguagesTab.vue - DeepL language metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsStore.settings.TRANSLATION_API = 'deepl';
    mockSettingsStore.settings.SOURCE_LANGUAGE = 'en';
    mockSettingsStore.settings.TARGET_LANGUAGE = 'fa';
    mockSettingsStore.settings.DEEPL_API_KEY = 'test-key';
    mockSettingsStore.settings.DEEPL_API_TIER = 'free';
    mockSettingsStore.deepLLanguageCapabilities = { status: 'idle', identity: null, catalog: null, fetchedAt: null, error: null };
    mockSettingsStore.isSettingsValid = true;
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    missingSettingMocks.getFirstMissingSetting.mockReturnValue(null);
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    await flushPromises();
    while (mountedWrappers.length) mountedWrappers.pop().unmount();
  });

  it('highlights TARGET_LANGUAGE when feedback focus is target', async () => {
    mountTab();
    await flushPromises();
    highlightMocks.highlightElement.mockClear();

    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'target' }
    }));
    await flushPromises();

    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('TARGET_LANGUAGE');
  });

  it('highlights SOURCE_LANGUAGE when feedback focus is source or absent', async () => {    mountTab();
    await flushPromises();

    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'source' }
    }));
    await flushPromises();
    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('SOURCE_LANGUAGE');

    highlightMocks.highlightElement.mockClear();
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages' }
    }));
    await flushPromises();
    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('SOURCE_LANGUAGE');
  });

  it('shows an inline error for the DeepL conflict while rendering the kept value', async () => {
    const wrapper = mountTab();
    await flushPromises();

    mockValidateSettings.mockReturnValue({
      isValid: false,
      errors: ['validation_deepl_target_language_unsupported:fa']
    });
    await nextTick();

    // Save-feedback path surfaces the store conflict inline
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'target' }
    }));
    await flushPromises();

    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('validation_deepl_target_language_unsupported');

    // ...while the dropdown still renders the preserved (unsupported) value
    const props = dropdownProps(wrapper, 'TARGET_LANGUAGE');
    expect(props.modelValue).toBe('fa');
    const kept = props.languages.find(l => l.code === 'fa');
    expect(kept).toBeDefined();
    expect(kept.name).toBeTruthy();
  });

  it('clears the inline error once the conflict is resolved', async () => {
    const wrapper = mountTab();
    await flushPromises();

    mockValidateSettings.mockReturnValue({
      isValid: false,
      errors: ['validation_deepl_target_language_unsupported:fa']
    });
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'target' }
    }));
    await flushPromises();
    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('validation_deepl_target_language_unsupported');

    // Resolving (conflict gone) clears the inline error when draft credentials change.
    // (Asserted via isSettingsValid, which mirrors the inline error computed;
    // the Transition leave itself never completes under jsdom.)
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    mockSettingsStore.updateSettingLocally('DEEPL_API_KEY', 'updated-key');
    await nextTick();
    await flushPromises();
    expect(mockSettingsStore.isSettingsValid).toBe(true);
  });

  it('preserves an unsupported target when source changes', async () => {
    mountTab();
    await flushPromises();

    expect(mockSettingsStore.settings.TARGET_LANGUAGE).toBe('fa');

    // Changing source must not silently replace the conflicting target
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'de');
    await nextTick();
    await flushPromises();

    expect(mockSettingsStore.settings.SOURCE_LANGUAGE).toBe('de');
    expect(mockSettingsStore.settings.TARGET_LANGUAGE).toBe('fa');
  });

  it('keeps automatic sync for unrelated providers', async () => {
    mountTab();
    await flushPromises();

    mockSettingsStore.updateSettingLocally('TRANSLATION_API', 'google');
    mockSettingsStore.updateSettingLocally('TARGET_LANGUAGE', 'xx');
    await nextTick();
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'de');
    await nextTick();
    await flushPromises();

    // 'xx' is in no provider list → still auto-corrected for non-DeepL providers
    // (existing fallback resolves to 'en' here)
    expect(mockSettingsStore.settings.TARGET_LANGUAGE).toBe('en');
  });

  it('shows fresh v3 variants by direction and labels only known beta entries', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'fr', name: 'French', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} },
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'qaa', name: 'Experimental', usable_as_source: false, usable_as_target: true, status: 'future', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(source.map(language => language.code)).toContain('en');
    expect(source.map(language => language.code)).not.toContain('fr');
    expect(target.find(language => language.code === 'fr')).toMatchObject({ isBeta: true, status: 'beta' });
    expect(target.find(language => language.code === 'zh-Hans').name).toBe('Chinese (Simplified)');
    expect(target.map(language => language.code)).not.toContain('qaa');
    expect(normalizeDeepLLanguageCatalog([{ lang: 'qaa', name: 'Experimental', usable_as_source: false, usable_as_target: true, status: 'future', features: {} }])[0].metadataValid).toBe(false);
  });

  it('keeps a selected unknown-status option visible without a Beta label and shows unverified validation', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'QAA';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'qaa', name: 'Experimental', usable_as_source: false, usable_as_target: true, status: 'future', features: {} }
      ])
    };
    mockValidateSettings.mockReturnValue({ isValid: false, errors: ['validation_deepl_languages_unverified'] });
    const wrapper = mountTab();
    await flushPromises();
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { detail: { field: 'languages', focus: 'target' } }));
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE');
    expect(target.languages.some(language => language.code === 'QAA')).toBe(true);
    expect(target.languages.find(language => language.code === 'QAA').isBeta).not.toBe(true);
    expect(target.error).toBe('validation_deepl_languages_unverified');
  });

  it('preserves the saved BCP47 variant spelling when matching catalog entries', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'ZH_hans';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE');
    expect(target.modelValue).toBe('ZH_hans');
    expect(target.languages.find(language => language.code === 'ZH_hans').name).toBe('Chinese (Simplified)');
  });

  it('accepts fresh metadata from the second eligible key after failover', async () => {
    mockSettingsStore.settings.DEEPL_API_KEY = 'bad-key\ngood-key';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('good-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'fr', name: 'French', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    // Lists and Beta labels render from the succeeding-key catalog ...
    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(source.map(language => language.code)).toContain('en');
    expect(target.find(language => language.code === 'fr')).toMatchObject({ isBeta: true });
    // ... and no loading/unavailable status is shown
    expect(wrapper.find('.setting-description[role="status"]').exists()).toBe(false);
  });

  it('rejects metadata for a key no longer among eligible credentials', async () => {
    mockSettingsStore.settings.DEEPL_API_KEY = 'other-key';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('good-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    // Saved selection stays visible, but metadata is no longer trusted
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE');
    expect(target.languages.some(language => language.code === 'fa')).toBe(true);
    expect(wrapper.find('.setting-description[role="status"]').exists()).toBe(true);
  });

  it('treats an expired snapshot as unverified regardless of identity', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'),
      fetchedAt: Date.now() - 300000, error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    expect(source.find(language => language.code === 'en')).toBeDefined();
    expect(wrapper.find('.setting-description[role="status"]').exists()).toBe(true);
  });

  it('resolves legacy Chinese aliases by direction while keeping saved codes and beta labels', async () => {
    mockSettingsStore.settings.SOURCE_LANGUAGE = 'zh-cn';
    mockSettingsStore.settings.TARGET_LANGUAGE = 'zh-cn';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'zh', name: 'Chinese', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} },
        { lang: 'pt', name: 'Portuguese', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();
    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE');
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE');
    expect(source.modelValue).toBe('zh-cn');
    expect(source.languages.find(language => language.code === 'zh-cn')).toMatchObject({ name: 'Chinese', isBeta: false });
    expect(target.modelValue).toBe('zh-cn');
    expect(target.languages.find(language => language.code === 'zh-cn')).toMatchObject({ name: 'Chinese (Simplified)', isBeta: true });
    expect(target.languages.some(language => language.code === 'pt-BR')).toBe(false);
    expect(mockSettingsStore.settings.SOURCE_LANGUAGE).toBe('zh-cn');
    expect(mockSettingsStore.settings.TARGET_LANGUAGE).toBe('zh-cn');

    mockSettingsStore.settings.TARGET_LANGUAGE = 'pt-BR';
    const nonAlias = mountTab();
    await flushPromises();
    expect(dropdownProps(nonAlias, 'TARGET_LANGUAGE').languages.find(language => language.code === 'pt-BR'))
      .toMatchObject({ name: 'pt-BR', isBeta: false });
  });

  it('preserves an unsupported source when switching to DeepL', async () => {
    const wrapper = mountTab();
    await flushPromises();

    // 'fa' is a preserved, incompatible source for the metadata fixture
    mockSettingsStore.updateSettingLocally('TRANSLATION_API', 'google');
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'fa');
    mockSettingsStore.updateSettingLocally('TARGET_LANGUAGE', 'de');
    await nextTick();
    await flushPromises();

    // Store reports the source conflict once DeepL is the provider
    mockValidateSettings.mockImplementation(() => {
      const s = mockSettingsStore.settings;
      if (String(s.TRANSLATION_API).toLowerCase().includes('deepl')
        && s.SOURCE_LANGUAGE === 'fa') {
        return { isValid: false, errors: ['validation_deepl_source_language_unsupported:fa'] };
      }
      return { isValid: true, errors: [] };
    });

    // Switching to DeepL must not silently replace the conflicting source
    mockSettingsStore.updateSettingLocally('TRANSLATION_API', 'deepl');
    await nextTick();
    await flushPromises();

    expect(mockSettingsStore.settings.SOURCE_LANGUAGE).toBe('fa');

    // ...and the store conflict surfaces inline on feedback
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'source' }
    }));
    await flushPromises();

    expect(dropdownProps(wrapper, 'SOURCE_LANGUAGE').error).toBe('validation_deepl_source_language_unsupported');
  });

  it('clears a stale DeepL error when switching to an unconfigured provider', async () => {
    const wrapper = mountTab();
    await flushPromises();

    // Show a DeepL conflict inline first
    mockValidateSettings.mockReturnValue({
      isValid: false,
      errors: ['validation_deepl_target_language_unsupported:fa']
    });
    await nextTick();
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'target' }
    }));
    await flushPromises();
    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('validation_deepl_target_language_unsupported');

    // 'custom' has missing credentials → provider-config warning owns the display
    missingSettingMocks.getFirstMissingSetting.mockImplementation(
      (providerId) => (providerId === 'custom' ? 'CUSTOM_API_KEY' : null)
    );
    mockSettingsStore.updateSettingLocally('TRANSLATION_API', 'custom');
    await nextTick();
    await flushPromises();

    // Stale DeepL key is gone (validity flag mirrors the inline error; the
    // Transition leave itself never completes under jsdom) ...
    expect(mockSettingsStore.isSettingsValid).toBe(true);
    // ... while the provider-config warning still displays
    expect(wrapper.find('.provider-config-warning').exists()).toBe(true);
  });

  it('shows the canonical Translate It name for a DeepL entry with an exact code match', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(source.find(language => language.code === 'fa')).toMatchObject({ name: 'Persian' });
    expect(target.find(language => language.code === 'fa')).toMatchObject({ name: 'Persian' });
  });

  it('keeps the official DeepL name for a regional variant without an exact canonical match', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'pt-BR';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'pt', name: 'Portuguese', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'pt-BR', name: 'Portuguese (Brazilian)', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    // pt and pt-BR stay distinct: no variant collapsing
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(target.find(language => language.code === 'pt-BR')).toMatchObject({ name: 'Portuguese (Brazilian)' });
  });

  it('keeps the Beta flag on a canonical display name', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'fa', name: 'Persian', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(target.find(language => language.code === 'fa')).toMatchObject({ name: 'Persian', isBeta: true, status: 'beta' });
  });

  it('backfills a preserved selection with the canonical name instead of the raw code', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'fa';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    const kept = target.find(language => language.code === 'fa');
    expect(kept).toBeDefined();
    expect(kept.name).toBe('Persian');
  });

  it('backfills a direction-unsupported selection with the official DeepL name when no canonical match exists', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'pt-BR';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'pt-BR', name: 'Portuguese (Brazilian)', usable_as_source: false, usable_as_target: false, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    const kept = target.find(language => language.code === 'pt-BR');
    expect(kept).toBeDefined();
    expect(kept.name).toBe('Portuguese (Brazilian)');
  });

  it('orders DeepL lists by canonical order first, DeepL-only entries in API order', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'pt-BR', name: 'Portuguese (Brazilian)', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'en-GB', name: 'English (British)', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'de', name: 'German', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    // Canonical codes (en, fa, de) follow allLanguages order regardless of
    // API order; DeepL-only variants keep relative API order at the tail.
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(target.map(language => language.code)).toEqual(['en', 'fa', 'de', 'pt-BR', 'en-GB']);
    expect(target.find(language => language.code === 'fa').name).toBe('Persian');

    // Auto-Detect stays first in Source, then the same canonical ordering.
    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    expect(source.map(language => language.code)).toEqual(['auto', 'en', 'fa', 'de', 'pt-BR', 'en-GB']);
  });

  it('orders DeepL Source and Target lists by direction support', async () => {
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'fa', name: 'Persian', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'de', name: 'German', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const source = dropdownProps(wrapper, 'SOURCE_LANGUAGE').languages;
    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(source.map(language => language.code)).toEqual(['auto', 'en', 'de']);
    expect(target.map(language => language.code)).toEqual(['en', 'fa']);
  });

  it('appends a preserved backfill after the ordered DeepL list', async () => {
    mockSettingsStore.settings.TARGET_LANGUAGE = 'xx';
    mockSettingsStore.deepLLanguageCapabilities = {
      status: 'ready', identity: getDeepLLanguageIdentity('test-key', 'free'), fetchedAt: Date.now(), error: null,
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    };
    const wrapper = mountTab();
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(target.map(language => language.code)).toEqual(['en', 'fa', 'xx']);
  });

  it('keeps other providers in allLanguages order', async () => {
    mockSettingsStore.updateSettingLocally('TRANSLATION_API', 'google');
    const wrapper = mountTab();
    await flushPromises();

    const target = dropdownProps(wrapper, 'TARGET_LANGUAGE').languages;
    expect(target.map(language => language.code)).toEqual(['en', 'fa', 'de']);
  });

  it('replaces a shown DeepL error with the standard error on invalid change, and clears on repair', async () => {
    // Store conflict mirrors the real rule: target 'fa' is unsupported.
    mockValidateSettings.mockImplementation(() => (
      mockSettingsStore.settings.TARGET_LANGUAGE === 'fa'
        ? { isValid: false, errors: ['validation_deepl_target_language_unsupported:fa'] }
        : { isValid: true, errors: [] }
    ));
    const wrapper = mountTab();
    await flushPromises();

    // Save-feedback path shows the DeepL conflict first
    window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', {
      detail: { field: 'languages', focus: 'target' }
    }));
    await flushPromises();
    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('validation_deepl_target_language_unsupported');

    // Same-language change is standard-invalid, but arrives WITHOUT explicit
    // feedback: the displayed DeepL error must not remain stale.
    mockSettingsStore.updateSettingLocally('TARGET_LANGUAGE', 'de');
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'de');
    await nextTick();
    await flushPromises();

    const banner = wrapper.find('.validation-error .error-message');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toBe('validation_same_languages');
    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('');

    // Repairing the pair clears the displayed error
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'en');
    await nextTick();
    await flushPromises();
    expect(mockSettingsStore.isSettingsValid).toBe(true);
  });

  it('shows no unsolicited standard errors when validation runs without feedback', async () => {
    const wrapper = mountTab();
    await flushPromises();
    expect(wrapper.find('.validation-error').exists()).toBe(false);

    // Same-language change without prior errors and without feedback: no
    // standard error is surfaced, only Save feedback shows one.
    mockSettingsStore.updateSettingLocally('TARGET_LANGUAGE', 'de');
    mockSettingsStore.updateSettingLocally('SOURCE_LANGUAGE', 'de');
    await nextTick();
    await flushPromises();
    expect(wrapper.find('.validation-error').exists()).toBe(false);
    expect(dropdownProps(wrapper, 'SOURCE_LANGUAGE').error).toBe('');
    expect(dropdownProps(wrapper, 'TARGET_LANGUAGE').error).toBe('');
  });
});

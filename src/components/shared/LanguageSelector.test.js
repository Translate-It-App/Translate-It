import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { reactive, nextTick } from 'vue'
import LanguageSelector from './LanguageSelector.vue'
import { DEEPL_LANGUAGE_CATALOG_TTL_MS, getDeepLLanguageIdentity, normalizeDeepLLanguageCatalog } from '@/features/translation/providers/DeepLLanguageDiscovery.js'
import { utilsFactory } from '@/utils/UtilsFactory.js'

const mockStoreState = vi.hoisted(() => ({ store: null }))
const mockUtils = vi.hoisted(() => ({ getI18nUtils: vi.fn() }))

const mockLanguages = ref([
  { code: 'en', name: 'English' },
  { code: 'fa', name: 'Persian' },
  { code: 'fr', name: 'French' }
])

const { mockUseSelectElementTranslation } = vi.hoisted(() => ({
  mockUseSelectElementTranslation: vi.fn(() => ({
    isSelectModeActive: ref(false),
    deactivateSelectMode: vi.fn()
  }))
}))

const setDeepLCatalog = (languages, overrides = {}) => {
  mockStoreState.store.deepLLanguageCapabilities = {
    status: 'ready',
    identity: getDeepLLanguageIdentity('test-key', 'free'),
    fetchedAt: Date.now(),
    ...overrides,
    catalog: normalizeDeepLLanguageCatalog(languages)
  }
}

// Under fake timers flushPromises would hang; Vue flushes on microtasks, so
// two nextTicks settle watch callbacks and re-renders deterministically.
const flushWatchers = async () => {
  await nextTick()
  await nextTick()
}

const asymmetricDeepLLanguages = () => [
  { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
  { lang: 'fr', name: 'French', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} },
  { lang: 'de', name: 'German', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
  { lang: 'es', name: 'Spanish', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} }
]

vi.mock('@/composables/shared/useLanguages.js', () => ({
  useLanguages: () => ({
    allLanguages: mockLanguages,
    isLoaded: ref(true),
    loadLanguages: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({
    handleError: vi.fn()
  })
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, fallback) => fallback || key
  })
}))

vi.mock('@/features/translation/composables/useTranslationModes.js', () => ({
  useSelectElementTranslation: mockUseSelectElementTranslation
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('@/shared/config/languageConstants.js', () => ({
  PROVIDER_SUPPORTED_LANGUAGES: {},
  PROVIDER_LANGUAGE_PAIRS: {},
  getProviderLanguageCode: (code) => code
}))

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: () => null
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockStoreState.store
}))

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    TARGET_LANGUAGE: 'en'
  }
}))

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: mockUtils
}))

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      getURL: vi.fn((path) => path)
    }
  }
}))

describe('LanguageSelector', () => {
  beforeEach(() => {
    utilsFactory.getI18nUtils.mockReset().mockResolvedValue({
      getLanguageCodeForTTS: vi.fn((value) => Promise.resolve(value))
    })
    mockStoreState.store = reactive({
      settings: { TRANSLATION_API: 'google', DEEPL_API_KEY: 'test-key', DEEPL_API_TIER: 'free' },
      deepLLanguageCapabilities: { status: 'idle', identity: null, catalog: null, fetchedAt: null },
      refreshDeepLLanguageCapabilities: vi.fn()
    })
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  })

  afterEach(() => {
    delete global.ResizeObserver
  })

  const mountSelector = (props = {}) => mount(LanguageSelector, {
    props: {
      sourceLanguage: 'en',
      targetLanguage: 'fa',
      provider: '',
      ...props
    }
  })

  it('hides stars by default', () => {
    const wrapper = mountSelector()
    expect(wrapper.findAll('.ti-default-action-button')).toHaveLength(0)
  })

  it('shows stars when enabled', () => {
    const wrapper = mountSelector({
      showDefaultActions: true
    })

    expect(wrapper.findAll('.ti-default-action-button')).toHaveLength(2)
  })

  it('reflects filled and empty states from props', () => {
    const wrapper = mountSelector({
      showDefaultActions: true,
      sourceIsSavedDefault: true,
      targetIsSavedDefault: false,
      sourceDefaultTitle: 'Source default',
      targetDefaultTitle: 'Target default'
    })

    expect(wrapper.get('button[title="Source default"]').text()).toContain('★')
    expect(wrapper.get('button[title="Target default"]').text()).toContain('☆')
  })

  it('disables star buttons when defaultActionsEnabled is false', () => {
    const wrapper = mountSelector({
      showDefaultActions: true,
      defaultActionsEnabled: false
    })

    const buttons = wrapper.findAll('.ti-default-action-button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeDefined()
  })

  it('emits set-default-source when the source star is clicked', async () => {
    const wrapper = mountSelector({
      showDefaultActions: true,
      sourceDefaultTitle: 'Source default',
      targetDefaultTitle: 'Target default'
    })

    await wrapper.get('button[title="Source default"]').trigger('click')

    expect(wrapper.emitted('set-default-source')).toHaveLength(1)
  })

  it('emits set-default-target when the target star is clicked', async () => {
    const wrapper = mountSelector({
      showDefaultActions: true,
      sourceDefaultTitle: 'Source default',
      targetDefaultTitle: 'Target default'
    })

    await wrapper.get('button[title="Target default"]').trigger('click')

    expect(wrapper.emitted('set-default-target')).toHaveLength(1)
  })

  it('gives star buttons accessible names and native button tab semantics', () => {
    const wrapper = mountSelector({ showDefaultActions: true })
    const sourceButton = wrapper.get('button[aria-label="Set source as default"]')
    const targetButton = wrapper.get('button[aria-label="Set target as default"]')

    expect(sourceButton.element.tagName).toBe('BUTTON')
    expect(sourceButton.attributes('type')).toBe('button')
    expect(sourceButton.attributes('tabindex')).toBeUndefined()
    expect(targetButton.element.tagName).toBe('BUTTON')
    expect(targetButton.attributes('type')).toBe('button')
    expect(targetButton.attributes('tabindex')).toBeUndefined()
  })

  it('does not emit a default action when its button is disabled', async () => {
    const wrapper = mountSelector({ showDefaultActions: true, defaultActionsEnabled: false })

    wrapper.get('button[aria-label="Set source as default"]').element.click()
    wrapper.get('button[aria-label="Set target as default"]').element.click()
    await flushPromises()

    expect(wrapper.emitted('set-default-source')).toBeUndefined()
    expect(wrapper.emitted('set-default-target')).toBeUndefined()
  })

  it('emits source and target updates when their selections change', async () => {
    const wrapper = mountSelector()

    await wrapper.find('.ti-language-control-group--source select').setValue('fr')
    await wrapper.find('.ti-language-control-group--target select').setValue('en')

    expect(wrapper.emitted('update:sourceLanguage')).toEqual([['fr']])
    expect(wrapper.emitted('update:targetLanguage')).toEqual([['en']])
  })

  it('requests DeepL metadata for an override and preserves a v3-only selection through loading and ready', async () => {
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en-GB', targetLanguage: 'fr-CA' })
    await flushPromises()

    expect(mockStoreState.store.refreshDeepLLanguageCapabilities).toHaveBeenCalledWith({ forProvider: 'deepl' })
    expect(wrapper.find('.ti-language-control-group--source select option[value="en-GB"]').exists()).toBe(true)
    expect(wrapper.find('.ti-language-control-group--target select option[value="fr-CA"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('deepl_languages_unavailable')

    mockStoreState.store.deepLLanguageCapabilities = {
      status: 'ready',
      identity: getDeepLLanguageIdentity('test-key', 'free'),
      fetchedAt: Date.now(),
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en-GB', name: 'English (UK)', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'fr-CA', name: 'French (Canada)', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} }
      ])
    }
    await flushPromises()
    expect(wrapper.find('.ti-language-control-group--target select option[value="fr-CA"]').text()).toContain('deepl_beta_label')
    expect(wrapper.find('.ti-language-control-group--source select option[value="en-GB"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('refreshes after a batched proxy draft correction and recovers DeepL list and swap state', async () => {
    mockStoreState.store.settings = {
      ...mockStoreState.store.settings,
      PROXY_ENABLED: true,
      PROXY_TYPE: 'http',
      PROXY_HOST: 'broken.saved.proxy',
      PROXY_PORT: 1,
      PROXY_USERNAME: '',
      PROXY_PASSWORD: '',
    }
    mockStoreState.store.deepLLanguageCapabilities = {
      status: 'error', identity: null, catalog: null, fetchedAt: null,
    }
    mockStoreState.store.refreshDeepLLanguageCapabilities.mockImplementation(({ forProvider }) => {
      if (forProvider === 'deepl' && mockStoreState.store.settings.PROXY_HOST === 'corrected.draft.proxy') {
        mockStoreState.store.deepLLanguageCapabilities = {
          status: 'ready',
          identity: getDeepLLanguageIdentity('test-key', 'free'),
          fetchedAt: Date.now(),
          catalog: normalizeDeepLLanguageCatalog([
            { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
            { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'beta', features: {} },
          ]),
        }
      }
      return Promise.resolve()
    })

    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()
    expect(wrapper.text()).toContain('deepl_languages_unavailable')
    mockStoreState.store.refreshDeepLLanguageCapabilities.mockClear()

    Object.assign(mockStoreState.store.settings, {
      PROXY_ENABLED: true,
      PROXY_TYPE: 'http',
      PROXY_HOST: 'corrected.draft.proxy',
      PROXY_PORT: 8443,
      PROXY_USERNAME: 'draft-user',
      PROXY_PASSWORD: 'draft-password',
    })
    await flushWatchers()
    await flushPromises()

    expect(mockStoreState.store.refreshDeepLLanguageCapabilities).toHaveBeenCalledTimes(1)
    expect(mockStoreState.store.refreshDeepLLanguageCapabilities).toHaveBeenCalledWith({ forProvider: 'deepl' })
    expect(wrapper.find('.ti-language-control-group--target option[value="fa"]').text()).toContain('deepl_beta_label')
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('uses direction-aware Chinese aliases for labels without rewriting saved codes', async () => {
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'zh-cn', targetLanguage: 'zh-cn' })
    mockStoreState.store.deepLLanguageCapabilities = {
      status: 'ready',
      identity: getDeepLLanguageIdentity('test-key', 'free'),
      fetchedAt: Date.now(),
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'zh', name: 'Chinese', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
        { lang: 'zh-Hans', name: 'Chinese (Simplified)', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} },
        { lang: 'pt', name: 'Portuguese', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    }
    await flushPromises()
    const sourceOption = wrapper.get('.ti-language-control-group--source option[value="zh-cn"]')
    const targetOption = wrapper.get('.ti-language-control-group--target option[value="zh-cn"]')
    expect(sourceOption.text()).toBe('Chinese')
    expect(targetOption.text()).toContain('Chinese (Simplified)')
    expect(targetOption.text()).toContain('deepl_beta_label')
    expect(wrapper.find('.ti-language-control-group--target option[value="pt-BR"]').exists()).toBe(false)
    expect(wrapper.emitted('update:sourceLanguage')).toBeUndefined()
    expect(wrapper.emitted('update:targetLanguage')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows the canonical Translate It name for a DeepL entry with an exact code match', async () => {
    setDeepLCatalog([
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    expect(wrapper.find('.ti-language-control-group--target option[value="fa"]').text()).toBe('Persian')
    expect(wrapper.find('.ti-language-control-group--source option[value="fa"]').text()).toBe('Persian')
    wrapper.unmount()
  })

  it('keeps the official DeepL name for a regional variant without an exact canonical match', async () => {
    setDeepLCatalog([
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'pt-BR', name: 'Portuguese (Brazilian)', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'pt-BR', targetLanguage: 'pt-BR' })
    await flushPromises()

    expect(wrapper.find('.ti-language-control-group--target option[value="pt-BR"]').text()).toBe('Portuguese (Brazilian)')
    wrapper.unmount()
  })

  it('appends the localized Beta suffix to a canonical display name', async () => {
    setDeepLCatalog([
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'beta', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    expect(wrapper.find('.ti-language-control-group--target option[value="fa"]').text()).toBe('Persian (deepl_beta_label)')
    wrapper.unmount()
  })

  it('backfills a preserved selection with the canonical name instead of the raw code', async () => {
    setDeepLCatalog([
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    const option = wrapper.find('.ti-language-control-group--target option[value="fa"]')
    expect(option.exists()).toBe(true)
    expect(option.text()).toBe('Persian')
    wrapper.unmount()
  })

  it('orders DeepL lists by canonical order first, DeepL-only entries in API order', async () => {
    setDeepLCatalog([
      { lang: 'fa', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'pt-BR', name: 'Portuguese (Brazilian)', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'en-GB', name: 'English (British)', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'fr', name: 'French', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    // Canonical codes (en, fa, fr) follow allLanguages order regardless of
    // API order; DeepL-only variants keep relative API order at the tail.
    const targetValues = wrapper.findAll('.ti-language-control-group--target option').map(option => option.attributes('value'))
    expect(targetValues).toEqual(['en', 'fa', 'fr', 'pt-BR', 'en-GB'])
    const sourceValues = wrapper.findAll('.ti-language-control-group--source option').map(option => option.attributes('value'))
    expect(sourceValues).toEqual(['en', 'fa', 'fr', 'pt-BR', 'en-GB'])
    wrapper.unmount()
  })

  it('orders DeepL Source and Target lists by direction support', async () => {
    setDeepLCatalog([
      { lang: 'fa', name: 'Persian', usable_as_source: false, usable_as_target: true, status: 'stable', features: {} },
      { lang: 'fr', name: 'French', usable_as_source: true, usable_as_target: false, status: 'stable', features: {} },
      { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
    ])
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    const sourceValues = wrapper.findAll('.ti-language-control-group--source option').map(option => option.attributes('value'))
    const targetValues = wrapper.findAll('.ti-language-control-group--target option').map(option => option.attributes('value'))
    expect(sourceValues).toEqual(['en', 'fr'])
    expect(targetValues).toEqual(['en', 'fa'])
    wrapper.unmount()
  })

  it('keeps other providers in allLanguages order', async () => {
    const wrapper = mountSelector({ provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' })
    await flushPromises()

    const targetValues = wrapper.findAll('.ti-language-control-group--target option').map(option => option.attributes('value'))
    expect(targetValues).toEqual(['en', 'fa', 'fr'])
    wrapper.unmount()
  })

  it('accepts fresh metadata fetched with a later eligible key after failover', async () => {
    mockStoreState.store.settings.DEEPL_API_KEY = 'bad-key\ngood-key'
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fr-CA' })
    mockStoreState.store.deepLLanguageCapabilities = {
      status: 'ready',
      identity: getDeepLLanguageIdentity('good-key', 'free'),
      fetchedAt: Date.now(),
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} },
        { lang: 'fr-CA', name: 'French (Canada)', usable_as_source: false, usable_as_target: true, status: 'beta', features: {} }
      ])
    }
    await flushPromises()

    expect(wrapper.find('.ti-language-status').exists()).toBe(false)
    expect(wrapper.find('.ti-language-control-group--target option[value="fr-CA"]').text()).toContain('deepl_beta_label')
    wrapper.unmount()
  })

  it('treats metadata from a removed credential as unverified and expires stale snapshots', async () => {
    mockStoreState.store.deepLLanguageCapabilities = {
      status: 'ready',
      identity: getDeepLLanguageIdentity('good-key', 'free'),
      fetchedAt: Date.now(),
      catalog: normalizeDeepLLanguageCatalog([
        { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: {} }
      ])
    }
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'en' })
    await flushPromises()

    expect(wrapper.find('.ti-language-status').text()).toContain('deepl_languages_unavailable')
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()

    // Credential change invalidates the previous identity; then expiry does too.
    mockStoreState.store.settings.DEEPL_API_KEY = 'good-key'
    await flushPromises()
    expect(wrapper.find('.ti-language-status').exists()).toBe(false)

    mockStoreState.store.settings.DEEPL_API_KEY = 'test-key'
    mockStoreState.store.deepLLanguageCapabilities = {
      ...mockStoreState.store.deepLLanguageCapabilities,
      identity: getDeepLLanguageIdentity('test-key', 'free'),
      fetchedAt: Date.now() - 300000
    }
    await flushPromises()
    expect(wrapper.find('.ti-language-status').text()).toContain('deepl_languages_unavailable')
    wrapper.unmount()
  })

  it('blocks a swap when the current target cannot be a DeepL source', async () => {
    setDeepLCatalog(asymmetricDeepLLanguages())
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'fr' })
    const swap = wrapper.get('.ti-swap-button')
    expect(swap.attributes('disabled')).toBeDefined()
    await swap.trigger('click')
    expect(wrapper.emitted('swap-languages')).toBeUndefined()
    expect(wrapper.emitted('update:sourceLanguage')).toBeUndefined()
    expect(wrapper.emitted('update:targetLanguage')).toBeUndefined()
  })

  it('allows a swap only when both resulting DeepL directions are supported', async () => {
    setDeepLCatalog(asymmetricDeepLLanguages())
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
    const swap = wrapper.get('.ti-swap-button')
    expect(swap.attributes('disabled')).toBeUndefined()
    await swap.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('swap-languages')).toEqual([[{ newSource: 'de', newTarget: 'en' }]])
  })

  it('validates the auto-source fallback as a DeepL target', async () => {
    const catalog = asymmetricDeepLLanguages().map(language => language.lang === 'en'
      ? { ...language, usable_as_target: false }
      : language)
    setDeepLCatalog(catalog)
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'auto', targetLanguage: 'de' })
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()
    await wrapper.get('.ti-swap-button').trigger('click')
    expect(wrapper.emitted('swap-languages')).toBeUndefined()

    setDeepLCatalog(asymmetricDeepLLanguages())
    await flushPromises()
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.ti-swap-button').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('swap-languages')).toEqual([[{ newSource: 'de', newTarget: 'en' }]])
  })

  it('blocks an auto-source swap that resolves to the same default target language', async () => {
    setDeepLCatalog(asymmetricDeepLLanguages())
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'auto', targetLanguage: 'en' })
    const swap = wrapper.get('.ti-swap-button')
    expect(swap.attributes('disabled')).toBeDefined()
    await swap.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('swap-languages')).toBeUndefined()
    expect(wrapper.emitted('update:sourceLanguage')).toBeUndefined()
    expect(wrapper.emitted('update:targetLanguage')).toBeUndefined()
  })

  it('blocks DeepL swaps when capability metadata is unavailable', async () => {
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()
    await wrapper.get('.ti-swap-button').trigger('click')
    expect(wrapper.emitted('swap-languages')).toBeUndefined()
  })

  it('rechecks the requested pair after asynchronous language resolution', async () => {
    setDeepLCatalog(asymmetricDeepLLanguages())
    let resolveI18n
    utilsFactory.getI18nUtils.mockReturnValue(new Promise(resolve => { resolveI18n = resolve }))
    const wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
    await wrapper.get('.ti-swap-button').trigger('click')
    await wrapper.setProps({ targetLanguage: 'fr' })
    resolveI18n({ getLanguageCodeForTTS: vi.fn(value => Promise.resolve(value)) })
    await flushPromises()
    expect(wrapper.emitted('swap-languages')).toBeUndefined()
    expect(wrapper.emitted('update:sourceLanguage')).toBeUndefined()
    expect(wrapper.emitted('update:targetLanguage')).toBeUndefined()
  })

  it('reflects the TTL boundary proactively and recovers after a successful refresh', async () => {
    let wrapper
    vi.useFakeTimers()
    try {
      setDeepLCatalog(asymmetricDeepLLanguages())
      wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
      await flushWatchers()
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('.ti-language-status').exists()).toBe(false)

      // Cross the TTL boundary: without any store change the swap degrades ...
      vi.advanceTimersByTime(DEEPL_LANGUAGE_CATALOG_TTL_MS + 1)
      await flushWatchers()
      expect(mockStoreState.store.refreshDeepLLanguageCapabilities).toHaveBeenCalledWith({ forProvider: 'deepl' })
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()
      expect(wrapper.find('.ti-language-status').text()).toContain('deepl_languages_unavailable')

      // ... and re-enables only with a fresh, direction-valid catalog.
      setDeepLCatalog(asymmetricDeepLLanguages())
      await flushWatchers()
      expect(wrapper.find('.ti-language-status').exists()).toBe(false)
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper?.unmount()
      vi.useRealTimers()
    }
  })

  it('keeps the DeepL swap disabled when the expiry-triggered refresh fails', async () => {
    let wrapper
    vi.useFakeTimers()
    try {
      mockStoreState.store.refreshDeepLLanguageCapabilities = vi.fn().mockRejectedValue(new Error('offline'))
      setDeepLCatalog(asymmetricDeepLLanguages())
      wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
      await flushWatchers()
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()

      vi.advanceTimersByTime(DEEPL_LANGUAGE_CATALOG_TTL_MS + 1)
      await flushWatchers()
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()
      expect(wrapper.find('.ti-language-status').text()).toContain('deepl_languages_unavailable')
    } finally {
      wrapper?.unmount()
      vi.useRealTimers()
    }
  })

  it('disables the DeepL swap at exactly the TTL boundary and re-enables only after a fresh result', async () => {
    let wrapper
    vi.useFakeTimers()
    try {
      setDeepLCatalog(asymmetricDeepLLanguages())
      wrapper = mountSelector({ provider: 'deepl', sourceLanguage: 'en', targetLanguage: 'de' })
      await flushWatchers()
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()

      // age === TTL exactly: the store rule treats it as expired, so the
      // button must never show enabled while the handler would reject.
      vi.advanceTimersByTime(DEEPL_LANGUAGE_CATALOG_TTL_MS)
      await flushWatchers()
      expect(mockStoreState.store.refreshDeepLLanguageCapabilities).toHaveBeenCalledWith({ forProvider: 'deepl' })
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeDefined()
      expect(wrapper.find('.ti-language-status').text()).toContain('deepl_languages_unavailable')

      setDeepLCatalog(asymmetricDeepLLanguages())
      await flushWatchers()
      expect(wrapper.find('.ti-language-status').exists()).toBe(false)
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper?.unmount()
      vi.useRealTimers()
    }
  })

  it('does not refresh or degrade on DeepL catalog expiry for unrelated providers', async () => {
    let wrapper
    vi.useFakeTimers()
    try {
      mockStoreState.store.deepLLanguageCapabilities = {
        status: 'ready',
        identity: getDeepLLanguageIdentity('test-key', 'free'),
        fetchedAt: Date.now() - DEEPL_LANGUAGE_CATALOG_TTL_MS,
        catalog: []
      }
      wrapper = mountSelector({ provider: 'google', sourceLanguage: 'en', targetLanguage: 'fr' })
      await flushWatchers()
      vi.advanceTimersByTime(DEEPL_LANGUAGE_CATALOG_TTL_MS * 2)
      await flushWatchers()
      expect(mockStoreState.store.refreshDeepLLanguageCapabilities).not.toHaveBeenCalled()
      expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper?.unmount()
      vi.useRealTimers()
    }
  })

  it('preserves unrelated-provider swap behavior without DeepL metadata', async () => {
    const wrapper = mountSelector({ provider: 'google', sourceLanguage: 'en', targetLanguage: 'fr' })
    expect(wrapper.get('.ti-swap-button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.ti-swap-button').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:sourceLanguage')).toEqual([['fr']])
    expect(wrapper.emitted('update:targetLanguage')).toEqual([['en']])
    expect(wrapper.emitted('swap-languages')).toEqual([[{ newSource: 'en', newTarget: 'fr' }]])
  })

  it('does not request DeepL metadata for an unrelated provider when proxy drafts change', async () => {
    const wrapper = mountSelector({ provider: 'google', sourceLanguage: 'en', targetLanguage: 'fr' })
    await flushPromises()
    expect(mockStoreState.store.refreshDeepLLanguageCapabilities).not.toHaveBeenCalled()

    Object.assign(mockStoreState.store.settings, {
      PROXY_ENABLED: true,
      PROXY_TYPE: 'http',
      PROXY_HOST: 'corrected.draft.proxy',
      PROXY_PORT: 8443,
      PROXY_USERNAME: 'draft-user',
      PROXY_PASSWORD: 'draft-password',
    })
    await flushWatchers()

    expect(mockStoreState.store.refreshDeepLLanguageCapabilities).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('emits swapped values and both language updates for an allowed pair', async () => {
    const wrapper = mountSelector({ sourceLanguage: 'fr', targetLanguage: 'fa' })

    await wrapper.get('.ti-swap-button').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:sourceLanguage')).toEqual([['fa']])
    expect(wrapper.emitted('update:targetLanguage')).toEqual([['fr']])
    expect(wrapper.emitted('swap-languages')).toHaveLength(1)
  })

  describe('enableSelectElementIntegration prop', () => {
    beforeEach(() => {
      mockUseSelectElementTranslation.mockClear()
    })

    it('calls useSelectElementTranslation by default (when prop is true or omitted)', () => {
      mountSelector()
      expect(mockUseSelectElementTranslation).toHaveBeenCalledTimes(1)
    })

    it('calls useSelectElementTranslation when prop is explicitly true', () => {
      mountSelector({ enableSelectElementIntegration: true })
      expect(mockUseSelectElementTranslation).toHaveBeenCalledTimes(1)
    })

    it('does NOT call useSelectElementTranslation when prop is false', () => {
      mountSelector({ enableSelectElementIntegration: false })
      expect(mockUseSelectElementTranslation).not.toHaveBeenCalled()
    })
  })

  describe('targetOnly prop', () => {
    it('renders all controls by default', () => {
      const wrapper = mountSelector()

      expect(wrapper.find('.ti-language-control-group--source').exists()).toBe(true)
      expect(wrapper.find('.ti-swap-button').exists()).toBe(true)
      expect(wrapper.find('.ti-language-control-group--target').exists()).toBe(true)
    })

    it('hides source and swap controls but keeps the target when true', () => {
      const wrapper = mountSelector({ targetOnly: true })

      expect(wrapper.find('.ti-language-control-group--source').exists()).toBe(false)
      expect(wrapper.find('.ti-swap-button').exists()).toBe(false)
      expect(wrapper.find('.ti-language-control-group--target').exists()).toBe(true)
    })

    it('applies targetSelectId to the target select only when provided', () => {
      const withId = mountSelector({ targetSelectId: 'live-dubbing-target-language-select' })
      const withoutId = mountSelector()

      expect(withId.find('.ti-language-control-group--target select').attributes('id'))
        .toBe('live-dubbing-target-language-select')
      expect(withoutId.find('.ti-language-control-group--target select').attributes('id'))
        .toBeUndefined()
    })

    it('emits update:targetLanguage when the target changes in target-only mode', async () => {
      const wrapper = mountSelector({ targetOnly: true })

      await wrapper.find('.ti-language-control-group--target select').setValue('en')

      expect(wrapper.emitted('update:targetLanguage')).toEqual([['en']])
    })
  })
})

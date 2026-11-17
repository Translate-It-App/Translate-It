import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import GeminiApiSettings from './GeminiApiSettings.vue'
import ApiKeyInput from './ApiKeyInput.vue'
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js'
import { GEMINI_MODELS_SUPPORTING_MINIMAL_THINKING } from '@/features/translation/providers/geminiModelCapabilities.js'

const mocks = vi.hoisted(() => ({
  settingsStore: null,
  fetchModels: vi.fn(),
  getCachedModels: vi.fn(() => null),
}))

const translations = {
  gemini_catalog_search_label: 'Search Gemini models',
  gemini_catalog_search_placeholder: 'Search by model ID or name',
  gemini_catalog_results_label: 'Available Gemini models',
  gemini_catalog_no_matches: 'No models match your search.',
  gemini_models_missing_key: 'Add an API key to discover available models.',
  gemini_models_loading: 'Loading model catalog…',
  gemini_models_discovery_failed: 'Could not load Gemini models.',
  gemini_models_empty: 'No models were returned by Gemini.',
  gemini_model_not_listed: 'Saved model was not listed by Gemini.',
  gemini_saved_model_label: 'Saved model',
  gemini_catalog_showing_count: ({ shown, total }) => `Showing ${shown} of ${total} matching models`,
  gemini_custom_endpoint_info: 'Using a custom API URL — Google\'s model catalog is not loaded.',
  gemini_catalog_official_info: 'Catalog selection uses Google\'s official Gemini API.',
  gemini_gemma_minimal_thinking_guidance: 'For this Gemma model, Minimal disables thinking and usually provides faster translations with lower token usage.',
  gemini_thinking_mode_description: 'Provider Default uses provider behavior. Minimal is applied only when the selected model supports it.',
}

vi.mock('@/features/settings/stores/settings.js', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/features/translation/providers/GeminiModelDiscovery.js', () => ({
  fetchGeminiModels: mocks.fetchModels,
  getCachedGeminiModels: mocks.getCachedModels,
  MissingGeminiKeyError: class MissingGeminiKeyError extends Error {},
}))
vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    GEMINI_API_KEY: '',
    GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent',
    GEMINI_MODEL: 'curated-one',
    GEMINI_MODEL_SOURCE: 'legacy',
    GEMINI_MODELS: [
      { value: 'curated-one', name: 'Curated One', url: 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent', thinking: { minimal: null } },
      { value: 'curated-two', name: 'Curated Two', url: 'https://generativelanguage.googleapis.com/v1beta/models/curated-two:generateContent', thinking: { minimal: null } },
      { value: 'custom', name: 'Custom Model', custom: true },
    ],
    GEMINI_THINKING_MODE: 'default',
  },
}))
vi.mock('@/composables/ui/useRTLSelect.js', () => ({ useRTLSelect: () => ({ rtlSelectStyle: {} }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({
  t: (key, params) => typeof translations[key] === 'function'
    ? translations[key](params)
    : translations[key] || key,
}) }))
vi.mock('@/features/translation/providers/ApiKeyManager.js', () => ({
  ApiKeyManager: {
    parseKeys: value => typeof value === 'string' ? value.split('\n').map(key => key.trim()).filter(Boolean) : [],
    testKeysDirect: vi.fn(),
  },
}))
vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({ ProviderRegistryIds: { GEMINI: 'gemini' } }))
vi.mock('@/features/settings/presentation/ProviderSettingsErrorPresenter.js', () => ({ presentProviderSettingsError: vi.fn() }))
vi.mock('./ApiKeyInput.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue', 'test'],
    template: '<input data-test="api-key" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">',
  },
}))
vi.mock('@/components/base/BaseInput.vue', () => ({
  default: {
    props: ['id', 'label', 'modelValue', 'placeholder', 'type', 'dir'],
    emits: ['update:modelValue'],
    template: '<div><label v-if="label" :for="id">{{ label }}</label><input :id="id" :type="type || \'text\'" :dir="dir" :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"></div>',
  },
}))
vi.mock('@/components/base/BaseSelect.vue', () => ({
  inheritAttrs: false,
  default: {
    inheritAttrs: false,
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: '<select v-bind="$attrs" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  },
}))
vi.mock('@/components/feature/api-settings/ModelCatalogPicker.vue', () => ({
  default: {
    name: 'ModelCatalogPicker',
    props: { models: Array, modelValue: String, showPricing: { type: Boolean, default: false } },
    emits: ['update:modelValue'],
    template: '<div data-test="model-catalog-picker"><input aria-label="Search models"><select aria-label="Sort models"><option>API order</option><option>Name</option></select><button v-for="model in models" :key="model.value" :data-value="model.value" :aria-checked="model.value === modelValue" @click="$emit(\'update:modelValue\', model.value)">{{ model.name }}</button></div>',
  },
}))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('GeminiApiSettings dynamic model catalog', () => {
  afterEach(() => vi.useRealTimers())

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.settingsStore = {
      settings: reactive({
        GEMINI_API_KEY: '',
        GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent',
        GEMINI_MODEL: 'curated-one',
        GEMINI_MODEL_SOURCE: 'legacy',
        GEMINI_THINKING_MODE: 'default',
        GEMINI_MODELS: [
          { value: 'curated-one', name: 'Curated One' },
          { value: 'curated-two', name: 'Curated Two' },
          { value: 'custom', name: 'Custom Model' },
        ],
      }),
      isSettingDirty: vi.fn(() => false),
      updateSettingLocally: vi.fn((key, value) => { mocks.settingsStore.settings[key] = value }),
    }
    mocks.fetchModels.mockReset()
    mocks.getCachedModels.mockReset().mockReturnValue(null)
    ApiKeyManager.testKeysDirect.mockReset().mockResolvedValue({ allInvalid: true })
  })

  it('keeps curated order and skips discovery without an API key', async () => {
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.get('.model-select').findAll('option').map(option => option.element.value)).toEqual([
      'curated-one', 'curated-two', 'custom',
    ])
    expect(wrapper.text()).toContain('Add an API key to discover available models.')
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('discovers after key entry and does not write on picker search or sort', async () => {
    mocks.fetchModels.mockResolvedValue([
      { value: 'gemini-new', name: 'New Gemini' },
      { value: 'gemini-other', name: 'Other Model' },
    ])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    await wrapper.get('[data-test="api-key"]').setValue('key-one')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(mocks.fetchModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key-one', signal: expect.any(AbortSignal) }))
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('New Gemini')
    expect(wrapper.getComponent({ name: 'ModelCatalogPicker' }).props('showPricing')).toBe(false)
    await wrapper.get('[aria-label="Search models"]').setValue('gemini-new')
    await wrapper.get('[aria-label="Sort models"]').setValue('Name')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL_SOURCE', expect.anything())
    wrapper.unmount()
  })

  it('discovers for a saved official models-list URL', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
    mocks.fetchModels.mockResolvedValue([{ value: 'gemini-new', name: 'New Gemini' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('New Gemini')
    expect(wrapper.text()).not.toContain('Using a custom API URL')
    wrapper.unmount()
  })

  it('selects catalog models with a persistent source marker and clears derived selection after curated pick', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.fetchModels.mockResolvedValue([{ value: 'gemini-catalog', name: 'Catalog Gemini' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    await wrapper.get('[data-value="gemini-catalog"]').trigger('click')
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe('gemini-catalog')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('catalog')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODELS', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_THINKING_MODE', expect.anything())
    await wrapper.get('.model-select').setValue('curated-two')
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe('curated-two')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('curated')
    expect(wrapper.get('[data-value="gemini-catalog"]').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('preserves custom API URL and legacy routing without discovering against a custom endpoint', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/model-id'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    expect(mocks.getCachedModels).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Using a custom API URL — Google\'s model catalog is not loaded.')
    expect(wrapper.text()).not.toContain('Add an API key to discover available models.')
    expect(mocks.settingsStore.settings.GEMINI_API_URL).toBe('https://custom.example/v1beta/models/custom-path:generateContent')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
    expect(wrapper.get('#GEMINI_API_URL').element.value).toBe('https://custom.example/v1beta/models/custom-path:generateContent')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('legacy')
    wrapper.unmount()
  })

  it('guards a pending API URL edit and preserves the selected custom URL', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    // Unknown saved model → custom option, so the API URL input is rendered (pre-existing UX).
    mocks.settingsStore.settings.GEMINI_MODEL = 'my-custom-model'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const signal = mocks.fetchModels.mock.calls[0][0].signal
    const editedUrl = 'https://proxy.example/v1beta/models/custom-route:generateContent'
    await wrapper.get('#GEMINI_API_URL').setValue(editedUrl)
    expect(signal.aborted).toBe(true)
    pending.resolve([{ value: 'catalog/saved-id', name: 'Saved Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Using a custom API URL — Google\'s model catalog is not loaded.')
    expect(wrapper.get('#GEMINI_API_URL').element.value).toBe(editedUrl)
    expect(mocks.settingsStore.settings.GEMINI_API_URL).toBe(editedUrl)
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('custom')
    wrapper.unmount()
  })

  it('represents a saved catalog selection without writing the model or URL on discovery', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/saved-id'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.fetchModels.mockResolvedValue([{ value: 'catalog/saved-id', name: 'Saved Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/saved-id')
    expect(wrapper.get('[data-value="catalog/saved-id"]').attributes('aria-checked')).toBe('true')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', 'catalog/saved-id')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
    wrapper.unmount()
  })

  it('preserves a missing saved model and supports legacy custom selections', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/missing'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    mocks.fetchModels.mockResolvedValue([{ value: 'server/model', name: 'Server Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.text()).toContain('Saved model was not listed by Gemini.')
    expect(wrapper.get('.model-select').findAll('option').map(option => option.element.value)).toContain('legacy/missing')
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe('legacy/missing')
    wrapper.unmount()
  })

  it('shows localized loading, failure, and empty states and renders the full catalog', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const loading = mount(GeminiApiSettings)
    await nextTick()
    expect(loading.text()).toContain('Loading model catalog…')
    pending.reject(new Error('offline'))
    await flushPromises()
    expect(loading.text()).toContain('Could not load Gemini models.')
    loading.unmount()

    mocks.fetchModels.mockResolvedValueOnce([])
    const empty = mount(GeminiApiSettings)
    await flushPromises()
    expect(empty.text()).toContain('No models were returned by Gemini.')
    empty.unmount()

    mocks.fetchModels.mockResolvedValueOnce(Array.from({ length: 600 }, (_, index) => ({ value: `model/${index}`, name: `Model ${index}` })))
    const catalog = mount(GeminiApiSettings)
    await flushPromises()
    expect(catalog.get('[data-test="model-catalog-picker"]').findAll('button')).toHaveLength(600)
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    catalog.unmount()
  })

  it('debounces key changes, ignores stale responses, and aborts on unmount', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key-one'
    const first = deferred()
    const second = deferred()
    mocks.fetchModels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const firstSignal = mocks.fetchModels.mock.calls[0][0].signal
    await wrapper.get('[data-test="api-key"]').setValue('key-two')
    await wrapper.get('[data-test="api-key"]').setValue('key-three')
    expect(firstSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    expect(mocks.fetchModels.mock.calls[1][0].apiKey).toBe('key-three')
    const secondSignal = mocks.fetchModels.mock.calls[1][0].signal
    second.resolve([{ value: 'latest/model', name: 'Latest Model' }])
    await flushPromises()
    first.resolve([{ value: 'stale/model', name: 'Stale Model' }])
    await flushPromises()
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('Latest Model')
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).not.toContain('Stale Model')
    wrapper.unmount()
    expect(secondSignal.aborted).toBe(true)
  })

  it('aborts an in-flight catalog request on unmount and ignores its late result', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const signal = mocks.fetchModels.mock.calls[0][0].signal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    pending.resolve([{ value: 'late/model', name: 'Late Model' }])
    await flushPromises()
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', 'late/model')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
  })

  it('validates a catalog selection against the official Gemini endpoint when the endpoint is official', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'gemini-catalog-model'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.fetchModels.mockResolvedValue([{ value: 'gemini-catalog-model', name: 'Catalog Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    await wrapper.findComponent(ApiKeyInput).vm.$emit('test', 'gemini')
    await flushPromises()
    expect(ApiKeyManager.testKeysDirect).toHaveBeenCalledWith('key', 'gemini', {
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      apiModel: 'gemini-catalog-model',
    })
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL_SOURCE', expect.anything())
    wrapper.unmount()
  })

  it.each([
    ['custom selection', 'custom', 'custom', 'https://custom.example/v1beta/models/other:generateContent'],
    ['legacy selection', 'legacy-unknown-model', 'legacy', 'https://custom.example/v1beta/models/other:generateContent'],
    ['curated selection', 'curated-one', 'curated', 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'],
    ['persisted catalog selection with a custom URL', 'gemini-catalog-model', 'catalog', 'https://custom.example/v1beta/models/other:generateContent'],
  ])('validates %s against the stored URL without mutating settings', async (_, model, source, storedUrl) => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = model
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = source
    mocks.settingsStore.settings.GEMINI_API_URL = storedUrl
    mocks.fetchModels.mockResolvedValue([])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    await wrapper.findComponent(ApiKeyInput).vm.$emit('test', 'gemini')
    await flushPromises()
    expect(ApiKeyManager.testKeysDirect).toHaveBeenCalledWith('key', 'gemini', {
      apiUrl: storedUrl,
      // Legacy unknown saved models map to the custom option (pre-existing selection behavior).
      apiModel: source === 'legacy' ? 'custom' : model,
    })
    expect(mocks.settingsStore.settings.GEMINI_API_URL).toBe(storedUrl)
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe(model)
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe(source)
    wrapper.unmount()
  })

  it('never reads the cache or fetches for a custom endpoint even when the cache is warm', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    mocks.getCachedModels.mockReturnValue([{ value: 'cached/model', name: 'Cached Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(mocks.getCachedModels).not.toHaveBeenCalled()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Using a custom API URL — Google\'s model catalog is not loaded.')
    expect(wrapper.text()).not.toContain('Cached Model')
    wrapper.unmount()
  })

  it('preserves a saved catalog selection and source under a custom endpoint', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/saved-id'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/saved-id')
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe('catalog/saved-id')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('catalog')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL_SOURCE', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_API_URL', expect.anything())
    wrapper.unmount()
  })

  it('aborts a pending official request when the endpoint turns custom and ignores the late result', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const signal = mocks.fetchModels.mock.calls[0][0].signal
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    expect(signal.aborted).toBe(true)
    pending.resolve([{ value: 'late/model', name: 'Late Model' }])
    await flushPromises()
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Using a custom API URL — Google\'s model catalog is not loaded.')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', 'late/model')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).not.toBe('catalog')
    wrapper.unmount()
  })

  it('resumes official discovery from cache after switching back from a custom endpoint', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    mocks.getCachedModels.mockReturnValue([{ value: 'cached/model', name: 'Cached Model' }])
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    expect(mocks.getCachedModels).toHaveBeenCalledWith('key')
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('Cached Model')
    wrapper.unmount()
  })

  it('debounces endpoint and key changes so only the latest official combination fetches', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key-one'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    mocks.fetchModels.mockResolvedValue([{ value: 'fresh/model', name: 'Fresh Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'
    await wrapper.get('[data-test="api-key"]').setValue('key-two')
    await wrapper.get('[data-test="api-key"]').setValue('key-three')
    await vi.advanceTimersByTimeAsync(399)
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
    expect(mocks.fetchModels.mock.calls[0][0].apiKey).toBe('key-three')
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('Fresh Model')
    wrapper.unmount()
  })

  it('keeps an empty persistent live region mounted from initial render and updates only its contents', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.getCachedModels.mockReturnValue([{ value: 'cached/model', name: 'Cached Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const region = wrapper.get('.model-discovery-status-live')
    expect(region.attributes('role')).toBe('status')
    expect(region.attributes('aria-live')).toBe('polite')
    expect(region.attributes('aria-atomic')).toBe('true')
    expect(region.text()).toBe('')
    expect(region.classes()).toContain('model-discovery-status--absent')
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(true)
    await wrapper.get('[data-test="api-key"]').setValue('')
    expect(wrapper.get('.model-discovery-status-live').element).toBe(region.element)
    expect(region.text()).toBe('Add an API key to discover available models.')
    expect(region.classes()).not.toContain('model-discovery-status--absent')
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the live region identity through the loading→failure transition', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await nextTick()
    const region = wrapper.get('.model-discovery-status-live')
    expect(region.text()).toBe('Loading model catalog…')
    pending.reject(new Error('offline'))
    await flushPromises()
    expect(wrapper.get('.model-discovery-status-live').element).toBe(region.element)
    expect(region.text()).toBe('Could not load Gemini models.')
    wrapper.unmount()
  })

  it('keeps the live region identity across a custom→official endpoint transition', async () => {
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom-path:generateContent'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const region = wrapper.get('.model-discovery-status-live')
    expect(region.text()).toBe('Using a custom API URL — Google\'s model catalog is not loaded.')
    expect(region.classes()).not.toContain('model-discovery-status--absent')
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'
    await nextTick()
    expect(wrapper.get('.model-discovery-status-live').element).toBe(region.element)
    expect(region.text()).toBe('Add an API key to discover available models.')
    wrapper.unmount()
  })

  it('keeps the live region identity through loading to the empty-catalog message', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await nextTick()
    const region = wrapper.get('.model-discovery-status-live')
    expect(region.text()).toBe('Loading model catalog…')
    pending.resolve([])
    await flushPromises()
    expect(wrapper.get('.model-discovery-status-live').element).toBe(region.element)
    expect(region.text()).toBe('No models were returned by Gemini.')
    expect(wrapper.find('[data-test="model-catalog-picker"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the saved-model warning region mounted and updates its contents after discovery', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/missing'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await nextTick()
    const warning = wrapper.get('.model-discovery-status-warning')
    expect(warning.attributes('role')).toBe('status')
    expect(warning.attributes('aria-live')).toBe('polite')
    expect(warning.attributes('aria-atomic')).toBe('true')
    expect(warning.text()).toBe('')
    expect(warning.classes()).toContain('model-discovery-status--absent')
    pending.resolve([{ value: 'server/model', name: 'Server Model' }])
    await flushPromises()
    expect(wrapper.get('.model-discovery-status-warning').element).toBe(warning.element)
    expect(warning.text()).toBe('Saved model was not listed by Gemini.')
    expect(mocks.settingsStore.settings.GEMINI_MODEL).toBe('legacy/missing')
    wrapper.unmount()
  })

  it('keeps picker and official-endpoint information outside the discovery live region', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.fetchModels.mockResolvedValue(Array.from({ length: 600 }, (_, index) => ({ value: `model/${index}`, name: `Model ${index}` })))
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const region = wrapper.get('.model-discovery-status-live')
    expect(region.text()).toBe('')
    const officialInfo = wrapper.findAll('.model-discovery-status').find(node => node.text() === 'Catalog selection uses Google\'s official Gemini API.')
    expect(officialInfo.attributes('role')).toBeUndefined()
    expect(officialInfo.attributes('aria-live')).toBeUndefined()
    expect(region.element.contains(officialInfo.element)).toBe(false)
    const picker = wrapper.get('[data-test="model-catalog-picker"]')
    expect(region.element.contains(picker.element)).toBe(false)
    wrapper.unmount()
  })

  it('reconciles external model changes without writing settings and keeps local Custom edits selected', async () => {
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.GEMINI_MODEL = 'curated-two'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('curated-two')
    mocks.settingsStore.settings.GEMINI_MODEL = 'external/unknown'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('#GEMINI_API_URL').exists()).toBe(true)
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL_SOURCE', expect.anything())
    await wrapper.get('.model-select').setValue('custom')
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    wrapper.unmount()
  })

  it('keeps an external selection current when an older discovery request resolves late', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.GEMINI_MODEL = 'curated-two'
    await nextTick()
    pending.resolve([{ value: 'curated-one', name: 'Old Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('curated-two')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('legacy')
    wrapper.unmount()
  })

  it('reconciles Gemini model and source changes regardless of their write order', async () => {
    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/saved'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()

    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/model-first'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/model-first')

    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/source-first'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/source-first')

    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'custom'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', expect.anything())
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL_SOURCE', expect.anything())
    wrapper.unmount()
  })

  it('keeps a discovered legacy model Custom with its effective URL, while explicit catalog provenance selects it', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/listed-id'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/legacy-route:generateContent'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()

    pending.resolve([{ value: 'catalog/listed-id', name: 'Listed Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('#GEMINI_API_URL').element.value).toBe('https://generativelanguage.googleapis.com/v1beta/models/legacy-route:generateContent')
    expect(wrapper.get('.model-select').findAll('option').map(option => option.element.value)).toContain('catalog/listed-id')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()

    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/listed-id')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reconciles source-only and external URL changes without persisting or replacing the legacy URL', async () => {
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/listed-id'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://proxy.example/first:generateContent'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/listed-id')

    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    const externalUrl = 'https://proxy.example/updated:generateContent'
    mocks.settingsStore.settings.GEMINI_API_URL = externalUrl
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('#GEMINI_API_URL').element.value).toBe(externalUrl)
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['legacy', 'legacy/deferred-match'],
    ['custom', 'custom/deferred-match'],
  ])('does not let deferred discovery promote a %s selection', async (source, model) => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = model
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = source
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    pending.resolve([{ value: model, name: 'Catalog Match' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('#GEMINI_API_URL').exists()).toBe(true)
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('represents the current external catalog model when deferred discovery advertises it', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.GEMINI_MODEL = 'catalog/external'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    await nextTick()
    pending.resolve([{ value: 'catalog/external', name: 'External Catalog Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('catalog/external')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_MODEL', 'catalog/external')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('catalog')
    wrapper.unmount()
  })

  it('keeps local curated, catalog, Custom, and saved-legacy selections consistent with their sources', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/saved'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    mocks.getCachedModels.mockReturnValue([{ value: 'catalog/local', name: 'Local Catalog Model' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()

    await wrapper.get('.model-select').setValue('curated-two')
    expect(wrapper.get('.model-select').element.value).toBe('curated-two')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('curated')

    await wrapper.get('[data-value="catalog/local"]').trigger('click')
    expect(wrapper.get('.model-select').element.value).toBe('catalog/local')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('catalog')

    await wrapper.get('.model-select').setValue('custom')
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('custom')

    mocks.settingsStore.settings.GEMINI_MODEL = 'legacy/saved'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    await nextTick()
    await wrapper.get('.model-select').setValue('legacy/saved')
    expect(wrapper.get('.model-select').element.value).toBe('legacy/saved')
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('legacy')
    wrapper.unmount()
  })

  it('does not let discovery replace a dirty Custom model draft', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'draft/custom-model'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'custom'
    mocks.settingsStore.isSettingDirty.mockReturnValue(true)
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    pending.resolve([{ value: 'draft/custom-model', name: 'Catalog Match' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('#GEMINI_API_URL').exists()).toBe(true)
    expect(mocks.settingsStore.settings.GEMINI_MODEL_SOURCE).toBe('custom')
    wrapper.unmount()
  })

  it('associates the main Model label with its native select and keeps selection working', async () => {
    const wrapper = mount(GeminiApiSettings)
    const select = wrapper.get('#gemini-model-select')
    const label = wrapper.get('label[for="gemini-model-select"]')
    expect(label.element.control).toBe(select.element)
    await select.setValue('curated-two')
    expect(select.element.value).toBe('curated-two')
    const ids = wrapper.findAll('[id]').map(element => element.attributes('id'))
    expect(ids).toHaveLength(new Set(ids).size)
    wrapper.unmount()
  })

  it.each(GEMINI_MODELS_SUPPORTING_MINIMAL_THINKING)('shows Gemma 4 guidance for catalog model %s without changing Thinking Mode', async model => {
    mocks.settingsStore.settings.GEMINI_MODEL = model
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.settingsStore.settings.GEMINI_THINKING_MODE = 'minimal'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.text()).toContain(translations.gemini_gemma_minimal_thinking_guidance)
    expect(wrapper.get('.thinking-mode-select').element.value).toBe('minimal')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_THINKING_MODE', expect.anything())
    wrapper.unmount()
  })

  it.each([
    ['unsupported model', 'gemma-4-preview', 'catalog', 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'],
    ['31b preview model', 'gemma-4-31b-it-preview', 'catalog', 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'],
    ['26b preview model', 'gemma-4-26b-a4b-it-preview', 'catalog', 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'],
    ['legacy source', 'gemma-4-31b-it', 'legacy', 'https://generativelanguage.googleapis.com/v1beta/models/curated-one:generateContent'],
    ['custom endpoint', 'gemma-4-31b-it', 'catalog', 'https://custom.example/v1beta/models/custom:generateContent'],
  ])('hides Gemma 4 guidance for %s', async (_, model, source, url) => {
    mocks.settingsStore.settings.GEMINI_MODEL = model
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = source
    mocks.settingsStore.settings.GEMINI_API_URL = url
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.text()).not.toContain(translations.gemini_gemma_minimal_thinking_guidance)
    expect(wrapper.text()).toContain(translations.gemini_thinking_mode_description)
    wrapper.unmount()
  })

  it('updates guidance across model switches and external model, source, and endpoint changes without changing Thinking Mode', async () => {
    mocks.settingsStore.settings.GEMINI_MODEL = 'gemma-4-31b-it'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.settingsStore.settings.GEMINI_THINKING_MODE = 'minimal'
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    const guidance = translations.gemini_gemma_minimal_thinking_guidance
    const select = wrapper.get('#gemini-thinking-mode-select')
    expect(select.attributes('aria-describedby')).toBe('gemini-thinking-mode-description gemini-gemma-thinking-guidance')
    expect(wrapper.text()).toContain(guidance)

    mocks.settingsStore.settings.GEMINI_MODEL = 'gemma-4-26b-a4b-it'
    await nextTick()
    expect(wrapper.text()).toContain(guidance)
    mocks.settingsStore.settings.GEMINI_MODEL = 'curated-one'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'curated'
    await nextTick()
    expect(wrapper.text()).not.toContain(guidance)
    expect(select.attributes('aria-describedby')).toBe('gemini-thinking-mode-description')

    mocks.settingsStore.settings.GEMINI_MODEL = 'gemma-4-31b-it'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    await nextTick()
    expect(wrapper.text()).toContain(guidance)
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'legacy'
    await nextTick()
    expect(wrapper.text()).not.toContain(guidance)
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    await nextTick()
    expect(wrapper.text()).toContain(guidance)
    mocks.settingsStore.settings.GEMINI_API_URL = 'https://custom.example/v1beta/models/custom:generateContent'
    await nextTick()
    expect(wrapper.text()).not.toContain(guidance)
    expect(select.element.value).toBe('minimal')
    expect(mocks.settingsStore.settings.GEMINI_THINKING_MODE).toBe('minimal')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_THINKING_MODE', expect.anything())
    wrapper.unmount()
  })

  it('shows guidance for a saved catalog Gemma model after discovery without changing Thinking Mode', async () => {
    mocks.settingsStore.settings.GEMINI_API_KEY = 'key'
    mocks.settingsStore.settings.GEMINI_MODEL = 'gemma-4-26b-a4b-it'
    mocks.settingsStore.settings.GEMINI_MODEL_SOURCE = 'catalog'
    mocks.settingsStore.settings.GEMINI_THINKING_MODE = 'default'
    mocks.fetchModels.mockResolvedValue([{ value: 'gemma-4-26b-a4b-it', name: 'Gemma 4' }])
    const wrapper = mount(GeminiApiSettings)
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('gemma-4-26b-a4b-it')
    expect(wrapper.text()).toContain(translations.gemini_gemma_minimal_thinking_guidance)
    expect(wrapper.get('#gemini-thinking-mode-select').element.value).toBe('default')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('GEMINI_THINKING_MODE', expect.anything())
    wrapper.unmount()
  })
})

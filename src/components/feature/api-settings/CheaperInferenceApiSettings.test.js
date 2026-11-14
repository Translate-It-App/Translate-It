import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import CheaperInferenceApiSettings from './CheaperInferenceApiSettings.vue'

const mocks = vi.hoisted(() => ({
  settingsStore: null,
  fetchModels: vi.fn(),
  getCachedModels: vi.fn(() => null),
}))

const translations = {
  cheaperinference_catalog_search_label: 'Search Cheaper Inference models',
  cheaperinference_catalog_search_placeholder: 'Search by model ID or name',
  cheaperinference_catalog_results_label: 'Available Cheaper Inference models',
  cheaperinference_catalog_no_matches: 'No models match your search.',
  cheaperinference_models_loading: 'Loading model catalog…',
  cheaperinference_models_discovery_failed: 'Could not load Cheaper Inference models.',
  cheaperinference_models_empty: 'No models were returned by CheaperInference.',
  cheaperinference_model_not_listed: 'Saved model was not listed by CheaperInference.',
  cheaperinference_saved_model_label: 'Saved model',
  cheaperinference_catalog_showing_count: ({ shown, total }) => `Showing ${shown} of ${total} matching models`,
}

vi.mock('@/features/settings/stores/settings.js', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/features/translation/providers/CheaperInferenceModelDiscovery.js', () => ({
  fetchCheaperInferenceModels: mocks.fetchModels,
  getCachedCheaperInferenceModels: mocks.getCachedModels,
}))
vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    CHEAPERINFERENCE_API_MODEL: 'curated/model-one',
    CHEAPERINFERENCE_MODELS: [
      { value: 'curated/model-one', name: 'Curated One' },
      { value: 'curated/model-two', name: 'Curated Two' },
      { value: 'custom', name: 'Custom Model' },
    ],
  },
}))
vi.mock('@/composables/ui/useRTLSelect.js', () => ({ useRTLSelect: () => ({ rtlSelectStyle: {} }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({
  t: (key, params) => typeof translations[key] === 'function'
    ? translations[key](params)
    : translations[key] || key,
}) }))
vi.mock('@/features/translation/providers/ApiKeyManager.js', () => ({ ApiKeyManager: { testKeysDirect: vi.fn() } }))
vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({ ProviderRegistryIds: { CHEAPERINFERENCE: 'cheaperinference' } }))
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
  default: {
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
    template: '<div data-test="model-catalog-picker"><button data-test="open-picker">Open</button><input aria-label="Search models"><select aria-label="Sort models"><option>API order</option><option>Name</option></select><button data-test="close-picker">Close</button><button v-for="model in models" :key="model.value" :data-value="model.value" :aria-checked="model.value === modelValue" @click="$emit(\'update:modelValue\', model.value)">{{ model.name }}</button></div>',
  },
}))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('CheaperInferenceApiSettings model catalog', () => {
  afterEach(() => vi.useRealTimers())

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.settingsStore = {
      settings: reactive({ CHEAPERINFERENCE_API_KEY: 'key-one', CHEAPERINFERENCE_API_MODEL: 'curated/model-one' }),
      isSettingDirty: vi.fn(() => false),
      updateSettingLocally: vi.fn((key, value) => { mocks.settingsStore.settings[key] = value }),
    }
    mocks.fetchModels.mockReset()
    mocks.getCachedModels.mockReset().mockReturnValue(null)
  })

  it('preserves curated order and keeps picker browsing non-mutating', async () => {
    mocks.fetchModels.mockResolvedValue([
      { value: 'vendor/claude', name: 'Friendly Sonnet' },
      { value: 'provider/other', name: 'Other Model' },
    ])
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const curatedSelect = wrapper.find('.model-select')
    expect(curatedSelect.findAll('option').map(option => option.element.value)).toEqual([
      'curated/model-one', 'curated/model-two', 'custom',
    ])
    expect(wrapper.get('[data-test="model-catalog-picker"]').text()).toContain('Friendly Sonnet')
    expect(wrapper.getComponent({ name: 'ModelCatalogPicker' }).props('showPricing')).toBe(false)
    await wrapper.get('[data-test="open-picker"]').trigger('click')
    await wrapper.get('[aria-label="Search models"]').setValue('vendor/')
    await wrapper.get('[aria-label="Sort models"]').setValue('Name')
    await wrapper.get('[data-test="close-picker"]').trigger('click')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', expect.anything())
    wrapper.unmount()
  })

  it('writes a selected catalog model, then clears the catalog value when a curated model is selected', async () => {
    mocks.fetchModels.mockResolvedValue([
      { value: 'server/model', name: 'Server Model' },
      { value: 'server/other', name: 'Other Server Model' },
    ])
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const curatedSelect = wrapper.find('.model-select')
    const picker = wrapper.get('[data-test="model-catalog-picker"]')
    await picker.get('[data-value="server/model"]').trigger('click')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('server/model')
    expect(mocks.settingsStore.settings).not.toHaveProperty('CHEAPERINFERENCE_MODEL_SOURCE')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_MODEL_SOURCE', expect.anything())
    expect(curatedSelect.element.value).toBe('server/model')
    expect(picker.get('[data-value="server/model"]').attributes('aria-checked')).toBe('true')
    await curatedSelect.setValue('curated/model-two')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('curated/model-two')
    expect(picker.get('[data-value="server/model"]').attributes('aria-checked')).toBe('false')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_MODELS', expect.anything())
    wrapper.unmount()
  })

  it('discovers the public catalog with or without configured credentials', async () => {
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_KEY = ''
    mocks.fetchModels.mockResolvedValue([{ value: 'public/model', name: 'Public Model' }])
    const publicCatalog = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '' }))
    expect(publicCatalog.get('[data-test="model-catalog-picker"]').text()).toContain('Public Model')
    publicCatalog.unmount()

    mocks.settingsStore.settings.CHEAPERINFERENCE_API_KEY = 'key-one'
    mocks.fetchModels.mockResolvedValueOnce([{ value: 'keyed/model', name: 'Keyed Model' }])
    const keyedCatalog = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key-one' }))
    expect(mocks.getCachedModels).toHaveBeenCalledWith('key-one')
    expect(keyedCatalog.get('[data-test="model-catalog-picker"]').text()).toContain('Keyed Model')
    keyedCatalog.unmount()
  })

  it('keeps the saved model as the picker value and preserves models missing from the catalog', async () => {
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'server/saved-model'
    mocks.fetchModels.mockResolvedValue([
      { value: 'server/saved-model', name: 'Saved Server Model' },
      { value: 'server/another-model', name: 'Another Server Model' },
    ])
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(wrapper.find('.model-select').element.value).toBe('server/saved-model')
    expect(wrapper.get('[data-value="server/saved-model"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.getComponent({ name: 'ModelCatalogPicker' }).props('modelValue')).toBe('server/saved-model')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('server/saved-model')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', 'server/saved-model')
    wrapper.unmount()

    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'legacy/provider-model'
    mocks.fetchModels.mockResolvedValue([{ value: 'server/model', name: 'Server Model' }])
    const legacy = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(legacy.text()).toContain('Saved model was not listed by CheaperInference.')
    expect(legacy.find('.model-select').findAll('option').map(option => option.element.value)).toContain('legacy/provider-model')
    expect(legacy.getComponent({ name: 'ModelCatalogPicker' }).props('modelValue')).toBe('legacy/provider-model')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('legacy/provider-model')
    legacy.unmount()
  })

  it('clears catalog selection for Custom and preserves custom edits made while discovery is pending', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const curatedSelect = wrapper.find('.model-select')
    await curatedSelect.setValue('custom')
    await wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').setValue('custom/model-entered')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('custom/model-entered')
    const writesBeforeDiscoveryResult = mocks.settingsStore.updateSettingLocally.mock.calls.length
    pending.resolve([{ value: 'server/model', name: 'Server Model' }])
    await flushPromises()
    expect(curatedSelect.element.value).toBe('custom')
    expect(wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').element.value).toBe('custom/model-entered')
    expect(wrapper.getComponent({ name: 'ModelCatalogPicker' }).props('modelValue')).toBe('custom/model-entered')
    expect(mocks.settingsStore.updateSettingLocally).toHaveBeenCalledTimes(writesBeforeDiscoveryResult)
    wrapper.unmount()
  })

  it('preserves Custom selected during the key debounce and still syncs a pre-schedule saved model', async () => {
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_KEY = ''
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise).mockResolvedValue([])
    const wrapper = mount(CheaperInferenceApiSettings)
    await wrapper.get('[data-test="api-key"]').setValue('secret-key')
    await wrapper.find('.model-select').setValue('custom')
    await vi.advanceTimersByTimeAsync(400)
    pending.resolve([{ value: 'curated/model-one', name: 'Curated One' }])
    await flushPromises()
    expect(wrapper.find('.model-select').element.value).toBe('custom')
    expect(wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').exists()).toBe(true)
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('curated/model-one')
    wrapper.unmount()

    mocks.settingsStore.settings.CHEAPERINFERENCE_API_KEY = 'secret-key'
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'server/saved-model'
    const saved = deferred()
    mocks.fetchModels.mockReturnValueOnce(saved.promise)
    const savedWrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    saved.resolve([{ value: 'server/saved-model', name: 'Saved Model' }])
    await flushPromises()
    expect(savedWrapper.find('.model-select').element.value).toBe('server/saved-model')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('server/saved-model')
    savedWrapper.unmount()
  })

  it('synchronizes saved catalog models without writing the setting and honors user interaction during discovery', async () => {
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'server/model'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    await wrapper.find('.model-select').setValue('custom')
    pending.resolve([{ value: 'server/model', name: 'Server Model' }])
    await flushPromises()
    expect(wrapper.find('.model-select').element.value).toBe('custom')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('server/model')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', 'server/model')
    wrapper.unmount()
  })

  it('uses cached models and shows localized loading, failure, and empty states', async () => {
    mocks.getCachedModels.mockReturnValue([{ value: 'cached/model', name: 'Cached Model' }])
    const cached = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    expect(cached.get('[data-test="model-catalog-picker"]').text()).toContain('Cached Model')
    cached.unmount()

    mocks.getCachedModels.mockReturnValue(null)
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const loading = mount(CheaperInferenceApiSettings)
    await nextTick()
    expect(loading.text()).toContain('Loading model catalog…')
    pending.reject(new Error('offline'))
    await flushPromises()
    expect(loading.text()).toContain('Could not load Cheaper Inference models.')
    loading.unmount()

    mocks.fetchModels.mockResolvedValueOnce([])
    const empty = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(empty.text()).toContain('No models were returned by CheaperInference.')
    empty.unmount()

    mocks.fetchModels.mockResolvedValueOnce(Array.from({ length: 60 }, (_, index) => ({
      value: `model/${index}`, name: `Model ${index}`,
    })))
    const capped = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(capped.get('[data-test="model-catalog-picker"]').findAll('button[data-value]')).toHaveLength(60)
    capped.unmount()
  })

  it('does not write a model when discovery adds catalog entries', async () => {
    mocks.fetchModels.mockResolvedValue(Array.from({ length: 600 }, (_, index) => ({
      value: `model/${index}`, name: `Model ${index}`,
    })))
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    expect(wrapper.get('[data-test="model-catalog-picker"]').findAll('button[data-value]')).toHaveLength(600)
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', expect.anything())
    wrapper.unmount()
  })

  it('debounces rapid credential changes, ignores stale responses, and aborts on unmount', async () => {
    const first = deferred()
    const second = deferred()
    mocks.fetchModels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const firstSignal = mocks.fetchModels.mock.calls[0][0].signal
    await wrapper.get('[data-test="api-key"]').setValue('key-two')
    await wrapper.get('[data-test="api-key"]').setValue('key-three')
    await flushPromises()
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

  it('announces catalog loading, failure, empty, and saved-model warnings to screen readers', async () => {
    const liveStatusFor = (target, text) => {
      const status = target.findAll('[role="status"]').find(node => node.text().includes(text))
      expect(status, `expected a live status announcing "${text}"`).toBeTruthy()
      expect(status.attributes('aria-live')).toBe('polite')
      expect(status.attributes('aria-atomic')).toBe('true')
    }

    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await nextTick()
    liveStatusFor(wrapper, 'Loading model catalog…')
    pending.reject(new Error('offline'))
    await flushPromises()
    liveStatusFor(wrapper, 'Could not load Cheaper Inference models.')
    wrapper.unmount()

    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'legacy/missing-model'
    mocks.fetchModels.mockResolvedValueOnce([])
    const empty = mount(CheaperInferenceApiSettings)
    await flushPromises()
    liveStatusFor(empty, 'No models were returned by CheaperInference.')
    liveStatusFor(empty, 'Saved model was not listed by CheaperInference.')
    empty.unmount()
  })

  it('keeps the catalog picker outside the discovery live region', async () => {
    mocks.fetchModels.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      value: `model/${index}`, name: `Model ${index}`,
    })))
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const picker = wrapper.get('[data-test="model-catalog-picker"]')
    expect(picker.element.closest('[role="status"], [aria-live]')).toBeNull()
    wrapper.unmount()
  })

  it('keeps the catalog live region mounted while its text moves through loading, failure, empty, and settled states', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    const catalogRegion = () => wrapper.findAll('[role="status"]')[1]
    expect(catalogRegion().text()).toBe('')
    expect(catalogRegion().classes()).toContain('ti-sr-only')
    const regionElement = catalogRegion().element

    await nextTick()
    expect(catalogRegion().element).toBe(regionElement)
    expect(catalogRegion().text()).toBe('Loading model catalog…')
    expect(catalogRegion().classes()).not.toContain('ti-sr-only')

    pending.reject(new Error('offline'))
    await flushPromises()
    expect(catalogRegion().element).toBe(regionElement)
    expect(catalogRegion().text()).toBe('Could not load Cheaper Inference models.')

    mocks.fetchModels.mockResolvedValueOnce([])
    await wrapper.get('[data-test="api-key"]').setValue('key-two')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(catalogRegion().element).toBe(regionElement)
    expect(catalogRegion().text()).toBe('No models were returned by CheaperInference.')

    mocks.fetchModels.mockResolvedValueOnce([{ value: 'server/model', name: 'Server Model' }])
    await wrapper.get('[data-test="api-key"]').setValue('key-three')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(catalogRegion().element).toBe(regionElement)
    expect(catalogRegion().text()).toBe('')
    expect(catalogRegion().classes()).toContain('ti-sr-only')
    wrapper.unmount()
  })

  it('keeps the saved-model warning live region mounted until the warning clears', async () => {
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'legacy/missing-model'
    mocks.fetchModels.mockResolvedValue([{ value: 'server/model', name: 'Server Model' }])
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    const warningRegion = () => wrapper.findAll('[role="status"]')[0]
    expect(warningRegion().text()).toBe('Saved model was not listed by CheaperInference.')
    expect(warningRegion().classes()).not.toContain('ti-sr-only')
    const regionElement = warningRegion().element

    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'server/model'
    await nextTick()
    expect(warningRegion().element).toBe(regionElement)
    expect(warningRegion().text()).toBe('')
    expect(warningRegion().classes()).toContain('ti-sr-only')
    wrapper.unmount()
  })

  it('reconciles external model changes read-only and protects local Custom drafts', async () => {
    mocks.fetchModels.mockResolvedValue([])
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'curated/model-two'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('curated/model-two')
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'custom'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').exists()).toBe(true)
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'external/unknown'
    await nextTick()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').element.value).toBe('external/unknown')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', expect.anything())
    await wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').setValue('local-draft')
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL).toBe('local-draft')
    wrapper.unmount()
  })

  it('does not let late discovery restore a selection made by an external update', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'curated/model-two'
    await nextTick()
    pending.resolve([{ value: 'curated/model-one', name: 'Old Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('curated/model-two')
    wrapper.unmount()
  })

  it('selects the current external model when deferred discovery advertises it', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = 'external/catalog-model'
    await nextTick()
    pending.resolve([{ value: 'external/catalog-model', name: 'External Model' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('external/catalog-model')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('CHEAPERINFERENCE_API_MODEL', 'external/catalog-model')
    wrapper.unmount()
  })

  it('keeps a dirty Custom draft selected when discovery returns the same ID', async () => {
    const model = 'vendor/custom-draft'
    mocks.settingsStore.settings.CHEAPERINFERENCE_API_MODEL = model
    mocks.settingsStore.isSettingDirty.mockReturnValue(true)
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(CheaperInferenceApiSettings)
    await flushPromises()
    pending.resolve([{ value: model, name: 'Catalog Match' }])
    await flushPromises()
    expect(wrapper.get('.model-select').element.value).toBe('custom')
    expect(wrapper.get('[placeholder="cheaperinference_custom_model_placeholder"]').element.value).toBe(model)
    wrapper.unmount()
  })

  it('associates the main Model label with its native select and keeps selection working', async () => {
    mocks.fetchModels.mockResolvedValue([])
    const wrapper = mount(CheaperInferenceApiSettings)
    const select = wrapper.get('#cheaperinference-model-select')
    const label = wrapper.get('label[for="cheaperinference-model-select"]')
    expect(label.element.control).toBe(select.element)
    await select.setValue('curated/model-two')
    expect(select.element.value).toBe('curated/model-two')
    const ids = wrapper.findAll('[id]').map(element => element.attributes('id'))
    expect(ids).toHaveLength(new Set(ids).size)
    wrapper.unmount()
  })
})

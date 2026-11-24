import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import WebAIApiSettings from './WebAIApiSettings.vue'

const mocks = vi.hoisted(() => ({
  settingsStore: null,
  fetchModels: vi.fn(),
  getCachedModels: vi.fn(() => null),
}))

vi.mock('@/features/settings/stores/settings.js', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/features/translation/providers/WebAIModelDiscovery.js', () => ({
  fetchWebAIModels: mocks.fetchModels,
  getCachedWebAIModels: mocks.getCachedModels,
  resolveWebAIModelsUrl: url => {
    try { return new URL(url).origin + '/v1/stateless/models' } catch { return null }
  },
}))
vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    WEBAI_API_URL: '',
    WEBAI_API_MODEL: 'gemini-auto',
    WEBAI_MODELS: [
      { value: 'gemini-auto', name: 'Gemini Auto' },
      { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
      { value: 'gemini-3-pro', name: 'Gemini 3 Pro' },
      { value: 'custom', name: 'Custom Model', custom: true },
    ],
  },
}))
vi.mock('@/composables/ui/useRTLSelect.js', () => ({ useRTLSelect: () => ({ rtlSelectStyle: {} }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: key => ({
  webai_models_loading: 'Checking available models…',
  webai_models_discovery_failed: 'Could not check available models.',
  webai_model_not_advertised: 'Saved model was not listed by the server.',
}[key] || key) }) }))
vi.mock('@/shared/constants/core.js', () => ({ REPO_URLS: { WEBAI_API: '#' } }))
vi.mock('@/components/base/BaseInput.vue', () => ({ default: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' } }))
vi.mock('@/components/base/BaseSelect.vue', () => ({
  default: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: '<select v-bind="$attrs" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  },
}))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('WebAIApiSettings model discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.settingsStore = {
      settings: reactive({ WEBAI_API_URL: 'https://first.test/v1/translate', WEBAI_API_MODEL: 'gemini-3-flash' }),
      isSettingDirty: vi.fn(() => false),
      updateSettingLocally: vi.fn(),
    }
    mocks.fetchModels.mockReset()
    mocks.getCachedModels.mockReset().mockReturnValue(null)
  })

  it('keeps the saved model selected, adds discovered ids, and never persists the discovered list', async () => {
    mocks.fetchModels.mockResolvedValue(['gemini-3-pro', 'gemini-auto'])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    const select = wrapper.get('select')
    expect(select.element.value).toBe('gemini-3-flash')
    expect(select.findAll('option').map(option => option.element.value)).toEqual([
      'gemini-auto', 'gemini-3-flash', 'gemini-3-pro', 'custom',
    ])
    expect(wrapper.text()).toContain('Saved model was not listed by the server.')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('WEBAI_MODELS', expect.anything())
    wrapper.unmount()
  })

  it('keeps curated options when successful discovery returns no models', async () => {
    mocks.fetchModels.mockResolvedValue([])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.get('select').findAll('option').map(option => option.element.value)).toEqual([
      'gemini-auto', 'gemini-3-flash', 'gemini-3-pro', 'custom',
    ])
    wrapper.unmount()
  })

  it('does not warn when the saved model is the custom sentinel after successful discovery', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'custom'
    mocks.fetchModels.mockResolvedValue(['gemini-auto'])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.text()).not.toContain('Saved model was not listed by the server.')
    wrapper.unmount()
  })

  it('represents a discovered saved model in the dropdown without writing settings', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    mocks.fetchModels.mockResolvedValue(['gemini-auto'])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('gemini-auto')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('synchronizes a saved model from cached discovery without fetching or writing settings', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    mocks.getCachedModels.mockReturnValue(['gemini-auto'])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('gemini-auto')
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not override a user selection made while discovery is pending', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    await wrapper.get('select').setValue('custom')
    pending.resolve(['gemini-auto'])
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(mocks.settingsStore.settings.WEBAI_API_MODEL).toBe('gemini-auto')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('WEBAI_API_MODEL', 'gemini-auto')
    wrapper.unmount()
  })

  it('does not hide the custom input when it is edited while discovery is pending', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'my-custom-model'
    mocks.settingsStore.updateSettingLocally.mockImplementation((key, value) => {
      mocks.settingsStore.settings[key] = value
    })
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('custom')
    await wrapper.findAll('input').at(-1).setValue('gemini-3-flash')
    expect(mocks.settingsStore.settings.WEBAI_API_MODEL).toBe('gemini-3-flash')
    pending.resolve(['gemini-auto'])
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.findAll('input').at(-1).element.value).toBe('gemini-3-flash')
    expect(mocks.settingsStore.settings.WEBAI_API_MODEL).toBe('gemini-3-flash')
    wrapper.unmount()
  })

  it('preserves a Custom selection made during the URL debounce and leaves the saved model untouched', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    const pending = deferred()
    mocks.fetchModels.mockResolvedValueOnce(['gemini-auto']).mockReturnValueOnce(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()

    mocks.settingsStore.settings.WEBAI_API_URL = 'https://second.test/v1/translate'
    await nextTick()
    await wrapper.get('select').setValue('custom')
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    pending.resolve(['gemini-auto'])
    await flushPromises()

    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.findAll('input').at(-1).exists()).toBe(true)
    expect(mocks.settingsStore.settings.WEBAI_API_MODEL).toBe('gemini-auto')
    wrapper.unmount()
  })

  it('synchronizes a saved selection when no interaction occurs during the URL debounce', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    mocks.fetchModels.mockResolvedValueOnce(['gemini-auto']).mockResolvedValueOnce(['gemini-auto'])
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()

    mocks.settingsStore.settings.WEBAI_API_URL = 'https://second.test/v1/translate'
    await nextTick()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(wrapper.get('select').element.value).toBe('gemini-auto')
    wrapper.unmount()
  })

  it('debounces URL changes and ignores an earlier response when the latest URL resolves first', async () => {
    const first = deferred()
    const second = deferred()
    mocks.fetchModels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.WEBAI_API_URL = 'https://second.test/v1/translate'
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    second.resolve(['new-model'])
    await flushPromises()
    first.resolve(['stale-model'])
    await flushPromises()
    const values = wrapper.get('select').findAll('option').map(option => option.element.value)
    expect(values).toContain('new-model')
    expect(values).not.toContain('stale-model')
    wrapper.unmount()
  })

  it('keeps custom-model editing and static options available when discovery fails', async () => {
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'my-custom-model'
    mocks.fetchModels.mockRejectedValue(new Error('offline'))
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.text()).toContain('Could not check available models.')
    expect(wrapper.findAll('input').at(-1).element.value).toBe('my-custom-model')
    expect(wrapper.get('select').findAll('option').map(option => option.element.value)).toContain('gemini-3-flash')
    wrapper.unmount()
  })

  it('clears the previous server models immediately and aborts its request on URL change', async () => {
    const first = deferred()
    const second = deferred()
    mocks.fetchModels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    const firstSignal = mocks.fetchModels.mock.calls[0][1].signal
    mocks.settingsStore.settings.WEBAI_API_URL = 'https://second.test/v1/translate'
    await flushPromises()
    expect(wrapper.get('select').findAll('option').map(option => option.element.value)).not.toContain('old-model')
    expect(firstSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    const secondSignal = mocks.fetchModels.mock.calls[1][1].signal
    second.resolve(['new-model'])
    await flushPromises()
    first.resolve(['late-model'])
    await flushPromises()
    expect(wrapper.get('select').findAll('option').map(option => option.element.value)).toContain('new-model')
    expect(wrapper.get('select').findAll('option').map(option => option.element.value)).not.toContain('late-model')
    wrapper.unmount()
    expect(secondSignal.aborted).toBe(true)
    await flushPromises()
  })

  it('announces loading, failure, and saved-model warnings without live regions for the custom sentinel', async () => {
    const liveStatusFor = (target, text) => {
      const status = target.findAll('[role="status"]').find(node => node.text().includes(text))
      expect(status, `expected a live status announcing "${text}"`).toBeTruthy()
      expect(status.attributes('aria-live')).toBe('polite')
      expect(status.attributes('aria-atomic')).toBe('true')
      return status
    }

    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await nextTick()
    liveStatusFor(wrapper, 'Checking available models…')
    pending.reject(new Error('offline'))
    await flushPromises()
    liveStatusFor(wrapper, 'Could not check available models.')
    wrapper.unmount()

    mocks.fetchModels.mockResolvedValueOnce(['gemini-auto'])
    const warned = mount(WebAIApiSettings)
    await flushPromises()
    liveStatusFor(warned, 'Saved model was not listed by the server.')
    warned.unmount()

    mocks.settingsStore.settings.WEBAI_API_MODEL = 'custom'
    mocks.fetchModels.mockResolvedValueOnce(['gemini-auto'])
    const custom = mount(WebAIApiSettings)
    await flushPromises()
    expect(custom.text()).not.toContain('Saved model was not listed by the server.')
    expect(custom.get('[role="status"]').text()).toBe('')
    custom.unmount()
  })

  it('keeps the discovery live region mounted across loading, failure, warning, and empty transitions', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValueOnce(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    const region = () => wrapper.get('[role="status"]')
    expect(region().text()).toBe('')
    expect(region().classes()).toContain('ti-sr-only')
    const regionElement = region().element

    await nextTick()
    expect(region().element).toBe(regionElement)
    expect(region().text()).toBe('Checking available models…')
    expect(region().classes()).not.toContain('ti-sr-only')

    pending.reject(new Error('offline'))
    await flushPromises()
    expect(region().element).toBe(regionElement)
    expect(region().text()).toBe('Could not check available models.')

    mocks.fetchModels.mockResolvedValueOnce(['gemini-auto'])
    mocks.settingsStore.settings.WEBAI_API_URL = 'https://second.test/v1/translate'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(region().element).toBe(regionElement)
    expect(region().text()).toBe('Saved model was not listed by the server.')

    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-auto'
    await nextTick()
    expect(region().element).toBe(regionElement)
    expect(region().text()).toBe('')
    expect(region().classes()).toContain('ti-sr-only')

    mocks.settingsStore.settings.WEBAI_API_MODEL = 'custom'
    await nextTick()
    expect(region().element).toBe(regionElement)
    expect(region().text()).toBe('')
    wrapper.unmount()
  })

  it('reconciles external WebAI models read-only and keeps the Custom draft selected', async () => {
    mocks.fetchModels.mockResolvedValue([])
    mocks.settingsStore.updateSettingLocally.mockImplementation((key, value) => {
      mocks.settingsStore.settings[key] = value
    })
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-3-pro'
    await nextTick()
    expect(wrapper.get('select').element.value).toBe('gemini-3-pro')
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'custom'
    await nextTick()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.findAll('input').at(-1).exists()).toBe(true)
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'external/unknown'
    await nextTick()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.findAll('input').at(-1).element.value).toBe('external/unknown')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('WEBAI_API_MODEL', expect.anything())
    await wrapper.findAll('input').at(-1).setValue('local-draft')
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(mocks.settingsStore.settings.WEBAI_API_MODEL).toBe('local-draft')
    wrapper.unmount()
  })

  it('does not let late discovery restore a stale WebAI selection', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'gemini-3-pro'
    await nextTick()
    pending.resolve(['gemini-3-flash'])
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('gemini-3-pro')
    wrapper.unmount()
  })

  it('selects the current external model when deferred discovery advertises it', async () => {
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    mocks.settingsStore.settings.WEBAI_API_MODEL = 'external/catalog-model'
    await nextTick()
    pending.resolve(['external/catalog-model'])
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('external/catalog-model')
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalledWith('WEBAI_API_MODEL', 'external/catalog-model')
    wrapper.unmount()
  })

  it('keeps a dirty Custom draft selected when discovery returns the same ID', async () => {
    const model = 'external/custom-draft'
    mocks.settingsStore.settings.WEBAI_API_MODEL = model
    mocks.settingsStore.isSettingDirty.mockReturnValue(true)
    const pending = deferred()
    mocks.fetchModels.mockReturnValue(pending.promise)
    const wrapper = mount(WebAIApiSettings)
    await flushPromises()
    pending.resolve([model])
    await flushPromises()
    expect(wrapper.get('select').element.value).toBe('custom')
    expect(wrapper.findAll('input').at(-1).element.value).toBe(model)
    wrapper.unmount()
  })

  it('associates the main Model label with its native select and keeps selection working', async () => {
    mocks.fetchModels.mockResolvedValue([])
    const wrapper = mount(WebAIApiSettings)
    const select = wrapper.get('#webai-model-select')
    const label = wrapper.get('label[for="webai-model-select"]')
    expect(label.element.control).toBe(select.element)
    await select.setValue('gemini-3-pro')
    expect(select.element.value).toBe('gemini-3-pro')
    const ids = wrapper.findAll('[id]').map(element => element.attributes('id'))
    expect(ids).toHaveLength(new Set(ids).size)
    wrapper.unmount()
  })
})

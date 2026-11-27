import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AppearanceTab from './AppearanceTab.vue'
import FontSelector from '@/components/feature/FontSelector.vue'

const mocks = vi.hoisted(() => {
  const settingsStore = {
    settings: {
      TRANSLATION_FONT_FAMILY: 'system',
      TRANSLATION_FONT_SIZE: '14',
      TARGET_LANGUAGE: 'en'
    },
    updateSettingLocally: vi.fn((key, value) => {
      settingsStore.settings[key] = value
    })
  }
  return {
    settingsStore,
    listeners: new Map(),
    persistedFontFamily: 'verdana',
    storageManager: {
      on: vi.fn((event, callback) => mocks.listeners.set(event, callback)),
      off: vi.fn((event, callback) => {
        if (mocks.listeners.get(event) === callback) mocks.listeners.delete(event)
      }),
      set: vi.fn(),
      getFresh: vi.fn()
    },
    highlightElement: vi.fn()
  }
})

vi.mock('@/features/settings/stores/settings.js', async () => {
  const { reactive } = await import('vue')
  const store = reactive(mocks.settingsStore)
  return { useSettingsStore: () => store }
})

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: mocks.storageManager
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key, fallback) => fallback || key })
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../composables/useHighlightManager.js', () => ({
  useHighlightManager: () => ({ highlightElement: mocks.highlightElement })
}))

describe('AppearanceTab live dubbing font preference', () => {
  it('exposes and updates the live dubbing translation-font preference', async () => {
    const wrapper = mount(AppearanceTab)
    const toggle = wrapper.get('#LIVE_DUBBING_USE_TRANSLATION_FONT')
    expect(toggle.classes()).toContain('ti-translation-font-toggle')
    expect(toggle.text()).toContain('live_dubbing_use_translation_font_label')
    expect(toggle.get('input').element.checked).toBe(false)

    await toggle.get('input').setValue(true)

    expect(mocks.settingsStore.updateSettingLocally).toHaveBeenCalledWith('LIVE_DUBBING_USE_TRANSLATION_FONT', true)
    expect(mocks.settingsStore.settings.LIVE_DUBBING_USE_TRANSLATION_FONT).toBe(true)
    wrapper.unmount()
  })
})

describe('AppearanceTab persisted font description', () => {
  const description = wrapper => wrapper.get('.font-description').text()
  const selectDraftFont = wrapper => wrapper.getComponent(FontSelector).vm.$emit('update:font-family', 'georgia')

  beforeEach(() => {
    mocks.listeners.clear()
    mocks.persistedFontFamily = 'verdana'
    Object.assign(mocks.settingsStore.settings, {
      TRANSLATION_FONT_FAMILY: 'system',
      TRANSLATION_FONT_SIZE: '14',
      TARGET_LANGUAGE: 'en'
    })
    mocks.storageManager.on.mockClear()
    mocks.storageManager.off.mockClear()
    mocks.storageManager.set.mockReset().mockImplementation(async settings => {
      if (settings.TRANSLATION_FONT_FAMILY !== undefined) {
        mocks.persistedFontFamily = settings.TRANSLATION_FONT_FAMILY
        mocks.listeners.get('set:TRANSLATION_FONT_FAMILY')?.({
          value: settings.TRANSLATION_FONT_FAMILY
        })
      }
      return true
    })
    mocks.storageManager.getFresh.mockReset().mockImplementation(async () => ({
      TRANSLATION_FONT_FAMILY: mocks.persistedFontFamily
    }))
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads the persisted font independently of the draft on initial mount', async () => {
    const wrapper = mount(AppearanceTab)
    await flushPromises()

    expect(mocks.storageManager.getFresh).toHaveBeenCalledWith('TRANSLATION_FONT_FAMILY')
    expect(wrapper.get('#font-family-search').attributes('placeholder')).toBe('System Default')
    expect(description(wrapper)).toBe('Verdana')
    wrapper.unmount()
  })

  it('keeps the persisted font displayed after an unsaved selection and tab remount', async () => {
    const firstMount = mount(AppearanceTab)
    await flushPromises()
    selectDraftFont(firstMount)
    expect(mocks.settingsStore.settings.TRANSLATION_FONT_FAMILY).toBe('georgia')
    expect(description(firstMount)).toBe('Verdana')
    firstMount.unmount()

    const remount = mount(AppearanceTab)
    await flushPromises()
    expect(wrapperPlaceholder(remount)).toBe('Georgia')
    expect(description(remount)).toBe('Verdana')
    remount.unmount()
  })

  it('updates the display after a successful storage write event', async () => {
    const wrapper = mount(AppearanceTab)
    await flushPromises()
    await mocks.storageManager.set({ TRANSLATION_FONT_FAMILY: 'georgia' })
    await nextTick()

    expect(description(wrapper)).toBe('Georgia')
    wrapper.unmount()
  })

  it('uses the configured default for a missing key and external removal', async () => {
    mocks.storageManager.getFresh.mockResolvedValueOnce({})
    const wrapper = mount(AppearanceTab)
    await flushPromises()
    expect(description(wrapper)).toBe('Auto (Smart Detection)')

    mocks.persistedFontFamily = 'verdana'
    mocks.listeners.get('change:TRANSLATION_FONT_FAMILY')?.({ newValue: 'system' })
    await flushPromises()
    expect(description(wrapper)).toBe('Verdana')

    mocks.persistedFontFamily = undefined
    mocks.listeners.get('change:TRANSLATION_FONT_FAMILY')?.({ newValue: undefined })
    await flushPromises()
    expect(description(wrapper)).toBe('Auto (Smart Detection)')
    wrapper.unmount()
  })

  it('leaves the persisted display unchanged when a save fails without a write event', async () => {
    const wrapper = mount(AppearanceTab)
    await flushPromises()
    selectDraftFont(wrapper)
    mocks.storageManager.set.mockRejectedValueOnce(new Error('storage write failed'))

    await expect(mocks.storageManager.set({ TRANSLATION_FONT_FAMILY: 'georgia' }))
      .rejects.toThrow('storage write failed')
    expect(description(wrapper)).toBe('Verdana')
    wrapper.unmount()
  })

  it('ignores stale reads and removes storage listeners on unmount', async () => {
    let resolveRead
    mocks.storageManager.getFresh.mockImplementationOnce(() => new Promise(resolve => {
      resolveRead = resolve
    }))
    const wrapper = mount(AppearanceTab)
    await flushPromises()
    mocks.persistedFontFamily = 'georgia'
    mocks.listeners.get('set:TRANSLATION_FONT_FAMILY')?.({ value: 'georgia' })
    await flushPromises()
    resolveRead({ TRANSLATION_FONT_FAMILY: 'verdana' })
    await flushPromises()

    expect(description(wrapper)).toBe('Georgia')
    const listenerEntries = [...mocks.listeners.entries()]
    wrapper.unmount()
    expect(mocks.listeners.size).toBe(0)
    for (const [event, callback] of listenerEntries) {
      expect(mocks.storageManager.off).toHaveBeenCalledWith(event, callback)
    }
  })

  it('uses the latest persisted read when storage notifications arrive out of order', async () => {
    const wrapper = mount(AppearanceTab)
    await flushPromises()
    const pendingReads = []
    mocks.storageManager.getFresh.mockImplementation(() => new Promise(resolve => {
      pendingReads.push(resolve)
    }))

    mocks.listeners.get('set:TRANSLATION_FONT_FAMILY')?.({ value: 'system' })
    mocks.listeners.get('change:TRANSLATION_FONT_FAMILY')?.({ newValue: 'verdana' })
    expect(pendingReads).toHaveLength(2)

    pendingReads[1]({ TRANSLATION_FONT_FAMILY: 'georgia' })
    await flushPromises()
    expect(description(wrapper)).toBe('Georgia')

    pendingReads[0]({ TRANSLATION_FONT_FAMILY: 'system' })
    await flushPromises()
    expect(description(wrapper)).toBe('Georgia')
    wrapper.unmount()
  })
})

function wrapperPlaceholder(wrapper) {
  return wrapper.get('#font-family-search').attributes('placeholder')
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import PopupApp from './PopupApp.vue'

let mockSettingsStore
let mockUnifiedTranslation
let mockLanguageDefaults
const useUnifiedTranslationMock = vi.hoisted(() => vi.fn())
const translationViewFocus = vi.hoisted(() => vi.fn())
const popupTrackedEventListeners = vi.hoisted(() => [])
const liveDubbingViewLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0, stopCalls: 0 }))
const popupLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}))

vi.mock('@/features/translation/composables/useUnifiedTranslation.js', () => ({
  useUnifiedTranslation: (...args) => {
    useUnifiedTranslationMock(...args)
    return mockUnifiedTranslation
  }
}))

vi.mock('@/features/settings/composables/useLanguageDefaults.js', () => ({
  useLanguageDefaults: () => mockLanguageDefaults
}))

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: () => ({
    sendMessage: vi.fn()
  })
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({
    handleError: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, fallback) => fallback || key
  })
}))

vi.mock('@/features/tts/core/TTSGlobalManager.js', () => ({
  useTTSGlobal: () => ({
    register: vi.fn(),
    unregister: vi.fn()
  })
}))

vi.mock('@/composables/core/useResourceTracker.js', () => ({
  useResourceTracker: () => ({
    trackTimeout: vi.fn(),
    addEventListener: vi.fn((target, type, listener) => {
      target.addEventListener(type, listener)
      popupTrackedEventListeners.push([target, type, listener])
    })
  })
}))

vi.mock('@/composables/shared/useFont.js', () => ({
  useGlobalFont: () => ({
    applyGlobalCSSVariables: vi.fn()
  })
}))

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {
    getUIUtils: vi.fn().mockResolvedValue({
      applyTheme: vi.fn().mockResolvedValue(undefined)
    })
  }
}))

vi.mock('@/composables/shared/useLanguages.js', () => ({
  preloadLanguages: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/components/base/LoadingSpinner.vue', () => ({
  default: {
    name: 'LoadingSpinner',
    template: '<div class="loading-spinner-stub" />'
  }
}))

vi.mock('@/components/popup/PopupHeader.vue', () => ({
  default: {
    name: 'PopupHeader',
    props: ['targetLanguage', 'provider'],
    template: '<div class="popup-header-stub"><slot /></div>'
  }
}))

vi.mock('@/components/popup/PopupViewSwitcher.vue', () => ({
  default: {
    name: 'PopupViewSwitcher',
    props: ['modelValue', 'showLiveDubbing'],
    emits: ['update:modelValue'],
    template: `
      <div class="view-switcher-stub">
        <button class="switch-to-translate" role="tab" @click="$emit('update:modelValue', 'translate')">Translate</button>
        <button v-if="showLiveDubbing" class="switch-to-live-dubbing" role="tab" @click="$emit('update:modelValue', 'live-dubbing')">Live Dubbing</button>
      </div>
    `
  }
}))

vi.mock('@/components/popup/TranslationView.vue', () => ({
  default: {
    name: 'TranslationView',
    props: [
      'sourceLanguage',
      'targetLanguage',
      'currentProvider',
      'translation',
      'liveDubbingBusy',
      'isReady',
      'sourceIsSavedDefault',
      'targetIsSavedDefault',
      'showClearButton',
      'sourceDefaultTitle',
      'targetDefaultTitle',
      'lastKeyword'
    ],
    emits: [
      'translate',
      'cancel',
      'clear',
      'set-default-source',
      'set-default-target',
      'can-translate-change',
      'update:sourceLanguage',
      'update:targetLanguage',
      'update:currentProvider'
    ],
    methods: {
      focusSourceInput: translationViewFocus
    },
    template: '<button class="translation-view-stub" :disabled="!showClearButton" @click="$emit(\'clear\')" />'
  }
}))

vi.mock('@/components/popup/LiveDubbingView.vue', () => ({
  default: {
    name: 'LiveDubbingView',
    props: ['targetLanguage', 'targetLanguagePending', 'providerId'],
    emits: ['busy-change', 'update:targetLanguage'],
    mounted() {
      liveDubbingViewLifecycle.mounts += 1
    },
    unmounted() {
      liveDubbingViewLifecycle.unmounts += 1
    },
    methods: {
      stop() {
        liveDubbingViewLifecycle.stopCalls += 1
      }
    },
    template: '<div class="live-dubbing-view-stub" />'
  }
}))

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      getURL: vi.fn((path) => path)
    }
  }
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => popupLogger
}))

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))
const getViewPanel = (wrapper, view) => wrapper.find(`.popup-view-panel--${view}`)
const expectActiveView = (wrapper, activeView) => {
  const inactiveView = activeView === 'translate' ? 'live-dubbing' : 'translate'

  expect(getViewPanel(wrapper, activeView).classes()).toContain('is-active')
  expect(getViewPanel(wrapper, inactiveView).classes()).toContain('is-inactive')
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('PopupApp', () => {
  beforeEach(() => {
    popupTrackedEventListeners.splice(0).forEach(([target, type, listener]) => {
      target.removeEventListener(type, listener)
    })
    vi.stubGlobal('__BROWSER__', 'chrome')
    liveDubbingViewLifecycle.mounts = 0
    liveDubbingViewLifecycle.unmounts = 0
    liveDubbingViewLifecycle.stopCalls = 0
    mockUnifiedTranslation = {
      sourceLanguage: ref('fr'),
      targetLanguage: ref('de'),
      sourceText: ref('hello'),
      translatedText: ref('bonjour'),
      clearTranslation: vi.fn().mockResolvedValue(undefined),
      initializeSessionState: vi.fn().mockResolvedValue(undefined),
      lastTranslation: ref({ source: 'hello' })
    }
    useUnifiedTranslationMock.mockClear()
    translationViewFocus.mockClear()
    popupLogger.debug.mockClear()
    popupLogger.info.mockClear()
    popupLogger.warn.mockClear()
    popupLogger.error.mockClear()

    mockLanguageDefaults = {
      savedSourceLanguage: ref('fr'),
      savedTargetLanguage: ref('en'),
      isReady: ref(true),
      setSourceLanguageAsDefault: vi.fn().mockResolvedValue(true),
      setTargetLanguageAsDefault: vi.fn().mockResolvedValue(true)
    }

    mockSettingsStore = {
      settings: {
        TRANSLATION_API: 'google',
        TARGET_LANGUAGE: 'de',
        LIVE_DUBBING_PROVIDER: 'openai',
        LIVE_DUBBING_TARGET_LANGUAGE: 'fr',
        THEME: 'auto'
      },
      loadSettings: vi.fn().mockResolvedValue(undefined),
      updateSettingLocally: vi.fn((key, value) => {
        mockSettingsStore.settings[key] = value
      }),
      updateSettingAndPersist: vi.fn().mockResolvedValue(undefined),
      isInitialized: true
    }
  })

  it('passes default action props to TranslationView', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const view = wrapper.findComponent({ name: 'TranslationView' })

    expect(view.exists()).toBe(true)
    expect(view.props('isReady')).toBe(true)
    expect(view.props('sourceIsSavedDefault')).toBe(true)
    expect(view.props('targetIsSavedDefault')).toBe(false)
    expect(view.props('showClearButton')).toBe(true)
  })

  it('updates clear-button visibility from text and saved language defaults', async () => {
    mockUnifiedTranslation.sourceText.value = ''
    mockUnifiedTranslation.translatedText.value = ''
    mockUnifiedTranslation.sourceLanguage.value = mockLanguageDefaults.savedSourceLanguage.value
    mockUnifiedTranslation.targetLanguage.value = mockLanguageDefaults.savedTargetLanguage.value

    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const view = wrapper.findComponent({ name: 'TranslationView' })

    expect(view.props('showClearButton')).toBe(false)
    mockUnifiedTranslation.sourceText.value = ' '
    await wrapper.vm.$nextTick()
    expect(view.props('showClearButton')).toBe(true)

    mockUnifiedTranslation.sourceText.value = ''
    mockUnifiedTranslation.translatedText.value = 'translated'
    await wrapper.vm.$nextTick()
    expect(view.props('showClearButton')).toBe(true)

    mockUnifiedTranslation.translatedText.value = ''
    mockUnifiedTranslation.sourceLanguage.value = 'de'
    await wrapper.vm.$nextTick()
    expect(view.props('showClearButton')).toBe(true)

    mockUnifiedTranslation.sourceLanguage.value = mockLanguageDefaults.savedSourceLanguage.value
    mockUnifiedTranslation.targetLanguage.value = 'fr'
    await wrapper.vm.$nextTick()
    expect(view.props('showClearButton')).toBe(true)

    mockUnifiedTranslation.targetLanguage.value = mockLanguageDefaults.savedTargetLanguage.value
    await wrapper.vm.$nextTick()
    expect(view.props('showClearButton')).toBe(false)
  })

  it('creates one popup translation owner and passes it to TranslationView', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(useUnifiedTranslationMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'TranslationView' }).props('translation')).toBe(mockUnifiedTranslation)
  })

  it('waits for a successful clear before focusing source and dispatches clear-storage once', async () => {
    const pendingClear = deferred()
    const delayedDuplicate = deferred()
    mockUnifiedTranslation.clearTranslation = vi.fn(() => (
      mockUnifiedTranslation.clearTranslation.mock.calls.length === 1
        ? pendingClear.promise
        : delayedDuplicate.promise.then(() => {
          mockUnifiedTranslation.sourceText.value = ''
        })
    ))
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const clearButton = wrapper.get('.translation-view-stub')
    clearButton.element.focus()
    const clearStorage = vi.fn()
    const formClearListener = (event) => {
      if (event.detail?.source === 'popup-clear-button') return
      mockUnifiedTranslation.clearTranslation()
    }
    document.addEventListener('clear-storage', clearStorage)
    document.addEventListener('clear-storage', formClearListener)
    try {
      await clearButton.trigger('keydown', { key: 'Enter' })
      await clearButton.trigger('click') // browsers synthesize this click for Enter activation
      expect(mockUnifiedTranslation.clearTranslation).toHaveBeenCalledTimes(1)
      expect(translationViewFocus).not.toHaveBeenCalled()
      expect(clearStorage).not.toHaveBeenCalled()

      pendingClear.resolve()
      await flushPromises()
      expect(translationViewFocus).toHaveBeenCalledTimes(1)
      expect(clearStorage).toHaveBeenCalledTimes(1)
      expect(clearStorage.mock.calls[0][0].detail).toEqual({ source: 'popup-clear-button' })
      expect(mockUnifiedTranslation.clearTranslation).toHaveBeenCalledTimes(1)

      mockUnifiedTranslation.sourceText.value = 'typed after clear focus'
      delayedDuplicate.resolve()
      await flushPromises()
      expect(mockUnifiedTranslation.sourceText.value).toBe('typed after clear focus')
    } finally {
      document.removeEventListener('clear-storage', clearStorage)
      document.removeEventListener('clear-storage', formClearListener)
      wrapper.unmount()
    }
  })

  it('continues handling separately dispatched unmarked clear-storage events', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const clearStorage = vi.fn()
    const formClearListener = (event) => {
      if (event.detail?.source === 'popup-clear-button') return
      mockUnifiedTranslation.clearTranslation()
    }
    document.addEventListener('clear-storage', clearStorage)
    document.addEventListener('clear-storage', formClearListener)

    try {
      mockUnifiedTranslation.clearTranslation.mockClear()
      document.dispatchEvent(new CustomEvent('clear-storage'))
      await flushPromises()
      expect(clearStorage).toHaveBeenCalledTimes(1)
      expect(clearStorage.mock.calls[0][0].detail).toBeNull()
      expect(mockUnifiedTranslation.clearTranslation).toHaveBeenCalledTimes(2)
    } finally {
      document.removeEventListener('clear-storage', clearStorage)
      document.removeEventListener('clear-storage', formClearListener)
      wrapper.unmount()
    }
  })

  it('propagates clear rejection without focusing or dispatching clear-storage', async () => {
    const pendingClear = deferred()
    const errorHandler = vi.fn()
    mockUnifiedTranslation.clearTranslation.mockReturnValue(pendingClear.promise)
    const wrapper = mount(PopupApp, { global: { config: { errorHandler } } })
    await flushPromises()
    await flushPromises()
    const clearButton = wrapper.get('.translation-view-stub')
    clearButton.element.focus()
    const clearStorage = vi.fn()
    document.addEventListener('clear-storage', clearStorage)

    try {
      await clearButton.trigger('click')
      const error = new Error('clear failed')
      pendingClear.reject(error)
      await flushPromises()

      expect(errorHandler).toHaveBeenCalledWith(error, expect.anything(), expect.anything())
      expect(translationViewFocus).not.toHaveBeenCalled()
      expect(clearStorage).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('clear-storage', clearStorage)
      wrapper.unmount()
    }
  })

  it('focuses after a successful clear blurs its now-disabled action to body', async () => {
    const pendingClear = deferred()
    mockUnifiedTranslation.clearTranslation.mockImplementation(() => {
      mockUnifiedTranslation.sourceText.value = ''
      mockUnifiedTranslation.translatedText.value = ''
      mockUnifiedTranslation.sourceLanguage.value = mockLanguageDefaults.savedSourceLanguage.value
      mockUnifiedTranslation.targetLanguage.value = mockLanguageDefaults.savedTargetLanguage.value
      return pendingClear.promise
    })
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const clearButton = wrapper.get('.translation-view-stub')
    clearButton.element.focus()
    await clearButton.trigger('click')
    await wrapper.vm.$nextTick()

    expect(clearButton.attributes('disabled')).toBeDefined()
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
    expect(document.activeElement).toBe(document.body)
    pendingClear.resolve()
    await flushPromises()

    expect(translationViewFocus).toHaveBeenCalledTimes(1)
    document.body.removeAttribute('tabindex')
    wrapper.unmount()
  })

  it('does not focus if focus changes while clear is pending', async () => {
    const pendingClear = deferred()
    mockUnifiedTranslation.clearTranslation.mockReturnValue(pendingClear.promise)
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const clearButton = wrapper.get('.translation-view-stub')
    clearButton.element.focus()
    await clearButton.trigger('click')

    const otherInput = document.createElement('input')
    document.body.append(otherInput)
    otherInput.focus()
    pendingClear.resolve()
    await flushPromises()

    expect(document.activeElement).toBe(otherInput)
    expect(translationViewFocus).not.toHaveBeenCalled()
    otherInput.remove()
    wrapper.unmount()
  })

  it('does not focus after unmount or while the Translation view is inactive', async () => {
    const pendingClear = deferred()
    mockUnifiedTranslation.clearTranslation.mockReturnValue(pendingClear.promise)
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const clearButton = wrapper.get('.translation-view-stub')
    clearButton.element.focus()
    await clearButton.trigger('click')
    wrapper.unmount()
    pendingClear.resolve()
    await flushPromises()
    expect(translationViewFocus).not.toHaveBeenCalled()

    mockUnifiedTranslation.clearTranslation.mockResolvedValue(undefined)
    const inactiveWrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    inactiveWrapper.get('.switch-to-live-dubbing').element.click()
    await inactiveWrapper.vm.$nextTick()
    const inactiveClear = inactiveWrapper.get('.translation-view-stub')
    inactiveClear.element.focus()
    await inactiveClear.trigger('click')
    await flushPromises()
    expect(translationViewFocus).not.toHaveBeenCalled()
    inactiveWrapper.unmount()
  })

  it('persists current source and target when stars are clicked', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const view = wrapper.findComponent({ name: 'TranslationView' })

    view.vm.$emit('set-default-source')
    view.vm.$emit('set-default-target')
    await flushPromises()

    expect(mockLanguageDefaults.setSourceLanguageAsDefault).toHaveBeenCalledWith('fr')
    expect(mockLanguageDefaults.setTargetLanguageAsDefault).toHaveBeenCalledWith('de')
  })

  it('does not persist language defaults when dropdowns change', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const view = wrapper.findComponent({ name: 'TranslationView' })
    view.vm.$emit('update:sourceLanguage', 'de')
    view.vm.$emit('update:targetLanguage', 'fr')
    await flushPromises()

    expect(view.props('sourceLanguage')).toBe('de')
    expect(view.props('targetLanguage')).toBe('fr')
    expect(mockSettingsStore.updateSettingAndPersist).not.toHaveBeenCalledWith(
      'SOURCE_LANGUAGE',
      expect.anything()
    )
    expect(mockSettingsStore.updateSettingAndPersist).not.toHaveBeenCalledWith(
      'TARGET_LANGUAGE',
      expect.anything()
    )
  })

  it('passes the normalized live dubbing provider without affecting translation provider', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).props('providerId')).toBe('openai')
    expect(wrapper.findComponent({ name: 'TranslationView' }).props('currentProvider')).toBe('google')
  })

  it('restores the persisted live dubbing target independently', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).props('targetLanguage')).toBe('fr')
    expect(wrapper.findComponent({ name: 'TranslationView' }).props('targetLanguage')).toBe('de')
  })

  it('uses the independent Live Dubbing default when no value is persisted', async () => {
    mockSettingsStore.settings.LIVE_DUBBING_TARGET_LANGUAGE = undefined
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).props('targetLanguage')).toBe('en')
    expect(wrapper.findComponent({ name: 'TranslationView' }).props('targetLanguage')).toBe('de')
  })

  it('keeps target-language changes isolated between Translation and Live Dubbing', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const translationView = wrapper.findComponent({ name: 'TranslationView' })
    const liveDubbingView = wrapper.findComponent({ name: 'LiveDubbingView' })

    translationView.vm.$emit('update:targetLanguage', 'ja')
    await flushPromises()
    expect(translationView.props('targetLanguage')).toBe('ja')
    expect(liveDubbingView.props('targetLanguage')).toBe('fr')
    expect(mockSettingsStore.updateSettingAndPersist).not.toHaveBeenCalledWith(
      'LIVE_DUBBING_TARGET_LANGUAGE',
      expect.anything()
    )

    liveDubbingView.vm.$emit('update:targetLanguage', 'es')
    await flushPromises()
    expect(liveDubbingView.props('targetLanguage')).toBe('es')
    expect(translationView.props('targetLanguage')).toBe('ja')
    expect(mockSettingsStore.updateSettingAndPersist).toHaveBeenCalledWith(
      'LIVE_DUBBING_TARGET_LANGUAGE',
      'es'
    )
    expect(mockSettingsStore.updateSettingAndPersist).not.toHaveBeenCalledWith(
      'TARGET_LANGUAGE',
      expect.anything()
    )
  })

  it('rolls back only the Live Dubbing target when its persistence fails', async () => {
    mockSettingsStore.updateSettingAndPersist = vi.fn().mockRejectedValue(new Error('storage failed'))
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const liveDubbingView = wrapper.findComponent({ name: 'LiveDubbingView' })
    liveDubbingView.vm.$emit('update:targetLanguage', 'es')
    await flushPromises()

    expect(liveDubbingView.props('targetLanguage')).toBe('fr')
    expect(wrapper.findComponent({ name: 'TranslationView' }).props('targetLanguage')).toBe('de')
    expect(liveDubbingView.props('targetLanguagePending')).toBe(false)
    expect(liveDubbingView.vm).toBe(wrapper.findComponent({ name: 'LiveDubbingView' }).vm)
    expect(liveDubbingViewLifecycle.mounts).toBe(1)
    expect(mockSettingsStore.settings.TARGET_LANGUAGE).toBe('de')
    expect(mockSettingsStore.updateSettingLocally).toHaveBeenCalledWith(
      'LIVE_DUBBING_TARGET_LANGUAGE',
      'fr'
    )
  })

  it('ignores a second Live Dubbing target change while the first write is pending', async () => {
    const writes = []
    mockSettingsStore.updateSettingAndPersist = vi.fn((key, value) => {
      const pending = deferred()
      writes.push({ key, value, ...pending })
      return pending.promise
    })
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const liveDubbingView = wrapper.findComponent({ name: 'LiveDubbingView' })

    liveDubbingView.vm.$emit('update:targetLanguage', 'es')
    await flushPromises()
    expect(liveDubbingView.props('targetLanguagePending')).toBe(true)
    expect(writes).toHaveLength(1)

    liveDubbingView.vm.$emit('update:targetLanguage', 'ja')
    await flushPromises()
    expect(writes).toHaveLength(1)
    expect(liveDubbingView.props('targetLanguage')).toBe('es')

    writes[0].resolve()
    await flushPromises()
    expect(liveDubbingView.props('targetLanguagePending')).toBe(false)
  })

  it('forwards the independent Live Dubbing target to its start view', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).props('targetLanguage')).toBe('fr')
  })

  it('falls back to Gemini for an unknown live dubbing provider', async () => {
    mockSettingsStore.settings.LIVE_DUBBING_PROVIDER = 'unsupported'
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).props('providerId')).toBe('gemini')
  })

  it('shows the translate view by default and hides live dubbing', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-active')
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-inactive')
    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).exists()).toBe(true)
  })

  it('restores a persisted live dubbing view after settings load', async () => {
    mockSettingsStore.settings.POPUP_ACTIVE_VIEW = 'live-dubbing'
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).props('modelValue'))
      .toBe('live-dubbing')
    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-inactive')
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')
  })

  it('normalizes an invalid persisted view to translate', async () => {
    mockSettingsStore.settings.POPUP_ACTIVE_VIEW = 'invalid-view'
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).props('modelValue'))
      .toBe('translate')
    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-active')
  })

  it('falls back to translate when persisted live dubbing is unsupported', async () => {
    vi.stubGlobal('__BROWSER__', 'firefox')
    mockSettingsStore.settings.POPUP_ACTIVE_VIEW = 'live-dubbing'
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).exists()).toBe(false)
    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-active')
  })

  it('renders only after settings resolve so restoring the view does not flicker', async () => {
    let resolveSettings
    mockSettingsStore.settings.POPUP_ACTIVE_VIEW = 'live-dubbing'
    mockSettingsStore.loadSettings = vi.fn(() => new Promise((resolve) => {
      resolveSettings = resolve
    }))
    const wrapper = mount(PopupApp)

    await flushPromises()
    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).exists()).toBe(false)
    expect(wrapper.find('.loading-container').exists()).toBe(true)

    resolveSettings()
    await flushPromises()
    await flushPromises()

    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')
  })

  it('updates the active view immediately and persists the supported switch', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')

    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')
    await flushPromises()
    expect(mockSettingsStore.updateSettingAndPersist)
      .toHaveBeenCalledWith('POPUP_ACTIVE_VIEW', 'live-dubbing')
  })

  it('skips duplicate and invalid active-view updates', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const switcher = wrapper.findComponent({ name: 'PopupViewSwitcher' })

    switcher.vm.$emit('update:modelValue', 'translate')
    switcher.vm.$emit('update:modelValue', 'invalid-view')
    switcher.vm.$emit('update:modelValue', 'live-dubbing')
    switcher.vm.$emit('update:modelValue', 'live-dubbing')
    await flushPromises()

    expect(mockSettingsStore.updateSettingAndPersist).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.updateSettingAndPersist)
      .toHaveBeenCalledWith('POPUP_ACTIVE_VIEW', 'live-dubbing')
  })

  it('keeps the immediate view when active-view persistence fails', async () => {
    mockSettingsStore.updateSettingAndPersist = vi.fn().mockRejectedValue(new Error('storage failed'))
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')

    await flushPromises()
    expect(popupLogger.warn).toHaveBeenCalledWith(
      '[PopupApp] Failed to persist active view:',
      expect.any(Error)
    )
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')
  })

  it('serializes rapid active-view writes in selection order', async () => {
    const writes = []
    mockSettingsStore.updateSettingAndPersist = vi.fn((key, value) => {
      const pending = deferred()
      writes.push({ key, value, ...pending })
      return pending.promise
    })
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await flushPromises()
    expect(writes.map(({ value }) => value)).toEqual(['live-dubbing'])

    await wrapper.find('.switch-to-translate').trigger('click')
    await flushPromises()
    expect(writes.map(({ value }) => value)).toEqual(['live-dubbing'])

    writes[0].resolve()
    await flushPromises()
    expect(writes.map(({ value }) => value)).toEqual(['live-dubbing', 'translate'])

    writes[1].resolve()
    await flushPromises()
    expect(mockSettingsStore.updateSettingAndPersist).toHaveBeenNthCalledWith(
      1,
      'POPUP_ACTIVE_VIEW',
      'live-dubbing'
    )
    expect(mockSettingsStore.updateSettingAndPersist).toHaveBeenLastCalledWith(
      'POPUP_ACTIVE_VIEW',
      'translate'
    )
  })

  it('logs an earlier write failure and continues with later active-view writes', async () => {
    const writes = []
    mockSettingsStore.updateSettingAndPersist = vi.fn((key, value) => {
      const pending = deferred()
      writes.push({ key, value, ...pending })
      return pending.promise
    })
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await flushPromises()
    await wrapper.find('.switch-to-translate').trigger('click')
    await flushPromises()
    expect(writes).toHaveLength(1)

    writes[0].reject(new Error('storage failed'))
    await flushPromises()
    expect(writes.map(({ value }) => value)).toEqual(['live-dubbing', 'translate'])

    writes[1].resolve()
    await flushPromises()
    expect(popupLogger.warn).toHaveBeenCalledWith(
      '[PopupApp] Failed to persist active view:',
      expect.any(Error)
    )
    expect(mockSettingsStore.updateSettingAndPersist).toHaveBeenLastCalledWith(
      'POPUP_ACTIVE_VIEW',
      'translate'
    )
  })

  it('passes the last translation keyword to TranslationView', async () => {
    mockUnifiedTranslation.lastTranslation = ref({ source: 'hello-world' })
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'TranslationView' }).props('lastKeyword')).toBe('hello-world')
  })

  it('passes an empty keyword when there is no last translation', async () => {
    mockUnifiedTranslation.lastTranslation = ref(null)
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'TranslationView' }).props('lastKeyword')).toBe('')
  })

  it('switching to live dubbing hides the translation view', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')

    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-inactive')
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-active')
  })

  it('switching back restores the translation view', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')

    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-active')
    expect(getViewPanel(wrapper, 'live-dubbing').classes()).toContain('is-inactive')
  })

  it('keeps both view panels mounted and disables interaction for the inactive panel', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const translationView = wrapper.findComponent({ name: 'TranslationView' })
    const liveDubbingView = wrapper.findComponent({ name: 'LiveDubbingView' })
    const initialTranslationRef = wrapper.vm.$refs.translationFormRef

    expect(translationView.exists()).toBe(true)
    expect(liveDubbingView.exists()).toBe(true)
    expect(getViewPanel(wrapper, 'live-dubbing').attributes('inert')).toBe('')
    expect(getViewPanel(wrapper, 'live-dubbing').attributes('aria-hidden')).toBe('true')

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    expectActiveView(wrapper, 'live-dubbing')
    expect(getViewPanel(wrapper, 'translate').attributes('inert')).toBe('')
    expect(getViewPanel(wrapper, 'translate').attributes('aria-hidden')).toBe('true')
    expect(getViewPanel(wrapper, 'live-dubbing').attributes('inert')).toBeUndefined()
    expect(wrapper.findComponent({ name: 'TranslationView' }).vm).toBe(translationView.vm)
    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).vm).toBe(liveDubbingView.vm)

    await wrapper.find('.switch-to-translate').trigger('click')
    expectActiveView(wrapper, 'translate')
    expect(wrapper.vm.$refs.translationFormRef).toBe(initialTranslationRef)
  })

  it('preserves TranslationView props and ref after multiple switches', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()
    const translationView = wrapper.findComponent({ name: 'TranslationView' })
    const translationRef = wrapper.vm.$refs.translationFormRef

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')
    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')

    expect(wrapper.vm.$refs.translationFormRef).toBe(translationRef)
    expect(wrapper.findComponent({ name: 'TranslationView' }).vm).toBe(translationView.vm)
    expect(translationView.props('translation')).toBe(mockUnifiedTranslation)
    expect(translationView.props('sourceLanguage')).toBe('fr')
    expect(translationView.props('targetLanguage')).toBe('de')
  })

  it('ends on the latest active view after rapid repeated switching', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')
    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')

    expectActiveView(wrapper, 'translate')
    expect(wrapper.findComponent({ name: 'TranslationView' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).exists()).toBe(true)
  })

  it('hides live dubbing entirely when unsupported', async () => {
    vi.stubGlobal('__BROWSER__', 'firefox')
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('.switch-to-live-dubbing').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PopupViewSwitcher' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingView' }).exists()).toBe(false)
    expect(getViewPanel(wrapper, 'translate').classes()).toContain('is-active')
  })

  it('keeps header actions independent from the active view', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    const header = wrapper.findComponent({ name: 'PopupHeader' })
    expect(header.exists()).toBe(true)
    expect(header.props('targetLanguage')).toBe('de')
    expect(header.props('provider')).toBe('google')

    await wrapper.find('.switch-to-live-dubbing').trigger('click')

    const headerAfterSwitch = wrapper.findComponent({ name: 'PopupHeader' })
    expect(headerAfterSwitch.exists()).toBe(true)
    expect(headerAfterSwitch.props('targetLanguage')).toBe('de')
    expect(headerAfterSwitch.props('provider')).toBe('google')
  })

  it('does not stop live dubbing when switching views', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')

    expect(liveDubbingViewLifecycle.stopCalls).toBe(0)
  })

  it('keeps the live dubbing view mounted across view switches', async () => {
    const wrapper = mount(PopupApp)
    await flushPromises()
    await flushPromises()

    expect(liveDubbingViewLifecycle.mounts).toBe(1)

    await wrapper.find('.switch-to-live-dubbing').trigger('click')
    await wrapper.find('.switch-to-translate').trigger('click')

    expect(liveDubbingViewLifecycle.mounts).toBe(1)
    expect(liveDubbingViewLifecycle.unmounts).toBe(0)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref, nextTick } from 'vue'
import InputView from './InputView.vue'
import { getErrorMessage } from '@/shared/error-management/ErrorMessages.js'

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createMessage: vi.fn(),
  getErrorForDisplay: vi.fn(),
  handleError: vi.fn(),
  isContextError: vi.fn(() => false),
  handleContextError: vi.fn()
}))

let mockMobileStore
let mockSettingsStore
let mockLanguageDefaults
let mockTTSSmart

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => mockMobileStore
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}))

vi.mock('@/features/settings/composables/useLanguageDefaults.js', () => ({
  useLanguageDefaults: () => mockLanguageDefaults
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, fallback) => fallback || key
  })
}))

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: () => ({
    sendMessage: mocks.sendMessage,
    createMessage: mocks.createMessage
  })
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({
    getErrorForDisplay: mocks.getErrorForDisplay,
    handleError: mocks.handleError
  })
}))

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => mockTTSSmart
}))

vi.mock('@/components/shared/TranslationDisplay.vue', () => ({
  default: {
    name: 'TranslationDisplay',
    props: ['error', 'content'],
    template: '<div class="translation-display-stub" :data-error="error">{{ error || content }}</div>'
  }
}))

vi.mock('@/components/shared/LanguageSelector.vue', () => ({
  default: {
    name: 'LanguageSelector',
    props: [
      'sourceLanguage',
      'targetLanguage',
      'provider',
      'compact',
      'showDefaultActions',
      'defaultActionsEnabled',
      'sourceIsSavedDefault',
      'targetIsSavedDefault',
      'sourceDefaultTitle',
      'targetDefaultTitle',
      'sourceTitle',
      'targetTitle',
      'swapTitle',
      'autoDetectLabel'
    ],
    emits: ['set-default-source', 'set-default-target'],
    template: '<div class="language-selector-stub" />'
  }
}))

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: ['modelValue'],
    template: '<button class="provider-selector-stub" @click="$emit(\'update:modelValue\', \'edge\')" />'
  }
}))

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    emit: vi.fn()
  }
}))

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {
    getI18nUtils: vi.fn().mockResolvedValue({
      getTranslationString: vi.fn(() => undefined)
    })
  }
}))

vi.mock('@/shared/messaging/core/MessagingCore.js', async () => {
  const actual = await vi.importActual('@/shared/messaging/core/MessagingCore.js')
  return {
    MessageActions: {
      SHOW_NOTIFICATION_SIMPLE: 'SHOW_NOTIFICATION_SIMPLE',
      TRANSLATE: 'TRANSLATE',
      CANCEL_TRANSLATION: 'CANCEL_TRANSLATION'
    },
    MessageContexts: {
      MOBILE_TRANSLATE: 'MOBILE_TRANSLATE'
    },
    reconstructTranslationError: actual.reconstructTranslationError
  }
})

vi.mock('@/shared/utils/text/textAnalysis.js', () => ({
  shouldApplyRtl: vi.fn(() => false)
}))

vi.mock('@/shared/constants/mobile.js', () => ({
  MOBILE_CONSTANTS: {
    VIEWS: {
      DASHBOARD: 'dashboard',
      HISTORY: 'history'
    },
    SHEET_STATE: {
      FULL: 'full'
    },
    UI_MODE: {
      AUTO: 'auto'
    }
  }
}))

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: { TRANSLATION_API: 'edge' },
  TranslationMode: {
    Dictionary_Translation: 'dictionary',
    Mobile_Translate: 'mobile'
  }
}))

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: mocks.isContextError,
    handleContextError: mocks.handleContextError
  }
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      getURL: vi.fn((path) => path)
    }
  }
}))

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('InputView', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.sendMessage.mockResolvedValue({ success: true, result: { translatedText: 'hello' } })
    mocks.createMessage.mockImplementation((action, payload) => ({ action, payload }))
    mocks.getErrorForDisplay.mockResolvedValue({ message: 'error' })
    mocks.handleError.mockResolvedValue(undefined)
    mocks.isContextError.mockReturnValue(false)

    mockMobileStore = reactive({
      selectionData: {
        text: 'hello',
        sourceLang: 'fr',
        targetLang: 'de',
        translation: '',
        mode: null,
        error: ''
      },
      updateSelectionData: vi.fn(),
      navigate: vi.fn(),
      setSheetState: vi.fn(),
      closeSheet: vi.fn(),
      setView: vi.fn()
    })

    mockSettingsStore = reactive({
      isDarkTheme: false,
      isInitialized: false,
      settings: {
        SOURCE_LANGUAGE: 'auto',
        TARGET_LANGUAGE: 'en',
        TRANSLATION_API: 'google'
      }
    })

    mockLanguageDefaults = {
      savedSourceLanguage: ref('auto'),
      savedTargetLanguage: ref('en'),
      isReady: ref(false),
      setSourceLanguageAsDefault: vi.fn().mockResolvedValue(true),
      setTargetLanguageAsDefault: vi.fn().mockResolvedValue(true)
    }

    mockTTSSmart = {
      ttsState: ref('idle'),
      stop: vi.fn(),
      speak: vi.fn().mockResolvedValue(undefined)
    }
  })

  it('disables default actions before settings are ready', async () => {
    const wrapper = mount(InputView)
    await flushPromises()
    await nextTick()

    const selector = wrapper.findComponent({ name: 'LanguageSelector' })
    expect(selector.props('defaultActionsEnabled')).toBe(false)
  })

  it('enables default actions after settings become ready', async () => {
    const wrapper = mount(InputView)
    await flushPromises()
    await nextTick()

    mockLanguageDefaults.isReady.value = true
    mockSettingsStore.isInitialized = true
    await nextTick()

    const selector = wrapper.findComponent({ name: 'LanguageSelector' })
    expect(selector.props('defaultActionsEnabled')).toBe(true)
  })

  it('persists the current local language when a star is clicked', async () => {
    const wrapper = mount(InputView)
    await flushPromises()
    await nextTick()

    mockLanguageDefaults.isReady.value = true
    mockSettingsStore.isInitialized = true
    await nextTick()

    const selector = wrapper.findComponent({ name: 'LanguageSelector' })
    expect(selector.props('sourceLanguage')).toBe('fr')
    expect(selector.props('targetLanguage')).toBe('de')

    selector.vm.$emit('set-default-source')
    selector.vm.$emit('set-default-target')
    await flushPromises()

    expect(mockLanguageDefaults.setSourceLanguageAsDefault).toHaveBeenCalledWith('fr')
    expect(mockLanguageDefaults.setTargetLanguageAsDefault).toHaveBeenCalledWith('de')
    expect(selector.props('sourceLanguage')).toBe('fr')
    expect(selector.props('targetLanguage')).toBe('de')
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  const translate = async (wrapper) => {
    await wrapper.get('.ti-m-translate-main-btn').trigger('click')
    await flushPromises()
    await settle()
  }

  const displayError = (wrapper) => wrapper.findComponent({ name: 'TranslationDisplay' }).props('error')

  it('does not expose raw provider diagnostics for structured MODEL_MISSING failures', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'MODEL_MISSING',
        message: 'raw model detail: gemini-2.5-flash not found for key acct_12345'
      }
    })

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(displayError(wrapper)).toContain(await getErrorMessage('ERRORS_MODEL_MISSING'))
    expect(displayError(wrapper)).not.toContain('gemini-2.5-flash')
    expect(displayError(wrapper)).not.toContain('acct_12345')
  })

  it('does not expose raw provider bodies for API_ERROR failures', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'API_ERROR',
        statusCode: 502,
        message: 'Provider said: upstream 502 with body {\\"error\\":\\"private payload\\"}'
      }
    })

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(displayError(wrapper)).toContain(await getErrorMessage('ERRORS_API_ERROR'))
    expect(displayError(wrapper)).not.toContain('502')
    expect(displayError(wrapper)).not.toContain('private payload')
    expect(displayError(wrapper)).not.toContain('Provider said')
  })

  it('prefers errorDetails over the legacy error string', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      success: false,
      error: 'raw legacy provider string',
      errorDetails: {
        type: 'QUOTA_EXCEEDED',
        message: 'raw quota detail'
      }
    })

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(displayError(wrapper)).toContain(await getErrorMessage('ERRORS_QUOTA_EXCEEDED'))
    expect(displayError(wrapper)).not.toContain('raw legacy provider string')
    expect(displayError(wrapper)).not.toContain('raw quota detail')
  })

  it('keeps user cancellation silent in the manual input view', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      success: false,
      error: { type: 'USER_CANCELLED', message: 'Translation cancelled by user' }
    })

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(wrapper.find('.ti-m-result-wrapper').exists()).toBe(false)
  })

  it('keeps context invalidation silent in the manual input view', async () => {
    mocks.isContextError.mockReturnValue(true)
    mocks.sendMessage.mockResolvedValueOnce({
      success: false,
      error: 'Context error: extension context invalidated',
      isContextInvalidated: true
    })

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(wrapper.find('.ti-m-result-wrapper').exists()).toBe(false)
    expect(mocks.isContextError).toHaveBeenCalled()
  })

  it('routes translation-domain exceptions through the canonical chain without raw details', async () => {
    mocks.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('raw provider detail from transport'), { type: 'API_ERROR' })
    )

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(displayError(wrapper)).toContain(await getErrorMessage('ERRORS_API_ERROR'))
    expect(displayError(wrapper)).not.toContain('raw provider detail from transport')
  })

  it('preserves existing presentation for ordinary local errors', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('local non-translation failure'))

    const wrapper = mount(InputView)
    await translate(wrapper)

    expect(displayError(wrapper)).toBe('error')
    expect(mocks.getErrorForDisplay).toHaveBeenCalledWith(
      expect.any(Error),
      'mobile-input'
    )
  })

  it('marks only a deliberately selected provider as explicit in requests', async () => {
    const wrapper = mount(InputView)
    await translate(wrapper)
    expect(mocks.createMessage.mock.calls[0][1]).toMatchObject({
      provider: 'google',
      isExplicitProvider: false
    })

    mocks.createMessage.mockClear()
    await wrapper.get('.provider-selector-stub').trigger('click')
    await translate(wrapper)
    expect(mocks.createMessage.mock.calls[0][1]).toMatchObject({
      provider: 'edge',
      isExplicitProvider: true
    })
  })
})

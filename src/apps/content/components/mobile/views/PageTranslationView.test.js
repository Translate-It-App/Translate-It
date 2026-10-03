import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import PageTranslationView from './PageTranslationView.vue'
import { pageEventBus } from '@/core/PageEventBus.js'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js'
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js'
import enMessages from '../../../../../_locales/en/messages.json'
import faMessages from '../../../../../_locales/fa/messages.json'
import jaMessages from '../../../../../_locales/ja/messages.json'

let mobileStore
let settingsStore
let autoRules

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => mobileStore,
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (_key, fallback) => fallback }),
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: vi.fn() }),
}))

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: () => ({ features: ['bulk'] }),
}))

vi.mock('@/features/page-translation/composables/useAutoTranslateRules.js', () => ({
  useAutoTranslateRules: ({ currentUrl }) => ({
    ...autoRules,
    isAutoTranslateToggleVisible: computed(() => {
      try {
        return ['http:', 'https:', 'file:'].includes(new URL(currentUrl.value).protocol)
      } catch {
        return false
      }
    }),
  }),
}))

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { emit: vi.fn() },
}))

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn(),
}))

vi.mock('@/components/shared/PageTranslationStatus.vue', () => ({
  default: { template: '<span />' },
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

describe('PageTranslationView page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendRegularMessage.mockResolvedValue({ success: true })
    mobileStore = {
      pageTranslationData: ref({
        status: 'error',
        errorMessage: 'HTTP error',
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: false,
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
      }),
      closeSheet: vi.fn(),
      navigate: vi.fn(),
    }
    settingsStore = reactive({
      isDarkTheme: false,
      settings: { MOBILE_PAGE_TRANSLATION_AUTO_CLOSE: false },
      getEffectiveProvider: () => 'google',
    })
    autoRules = {
      normalizedPageUrl: ref('https://example.com/page'), siteRule: ref(null),
      hasPageRule: ref(false), hasSiteRule: ref(false), hasBroaderMatchingRule: ref(false),
      isActive: ref(false), isFileUrl: ref(false), siteScopeAvailable: ref(true), showManageRules: ref(false),
      scopeActions: { togglePageScope: vi.fn(), toggleSiteScope: vi.fn() }, openManageRules: vi.fn(),
    }
  })

  it('uses the normal Start Translation action for terminal errors without committed content', () => {
    const wrapper = mount(PageTranslationView)

    expect(wrapper.get('.ti-m-header-primary-btn').text()).toBe('Start Translation')
    expect(wrapper.text()).toContain('HTTP error')
    expect(wrapper.text()).not.toContain('Retry Translation')
  })

  it('uses the normal Start Translation action for zero-result completion', () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      status: 'error',
      errorMessage: null,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
    }

    const wrapper = mount(PageTranslationView)

    expect(wrapper.get('.ti-m-header-primary-btn').text()).toBe('Start Translation')
    expect(wrapper.text()).not.toContain('Retry Translation')
  })

  it('uses the normal Start Translation action when idle', () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      status: 'idle',
      errorMessage: null,
      failedCount: 0,
      totalCount: 0,
    }
    const wrapper = mount(PageTranslationView)

    expect(wrapper.get('.ti-m-header-primary-btn').text()).toBe('Start Translation')
  })

  it('resets terminal error and starts a fresh PAGE_TRANSLATE session', async () => {
    const wrapper = mount(PageTranslationView)

    await wrapper.get('.ti-m-header-primary-btn').trigger('click')

    expect(pageEventBus.emit).toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_RESET_ERROR)

    expect(sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_TRANSLATE,
      data: { provider: 'google' },
    }, { returnFailureResponse: true })
    expect(pageEventBus.emit).not.toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE,
      expect.anything(),
    )
  })

  it('sends STOP_AUTO through runtime', async () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      status: 'translating',
      isTranslating: true,
    }
    const wrapper = mount(PageTranslationView)

    await wrapper.get('.ti-m-header-primary-btn').trigger('click')

    expect(sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
    }, { returnFailureResponse: true })
    expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_STOP_AUTO)
  })

  it('sends PAGE_RESTORE through runtime', async () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      status: 'completed',
      isTranslated: true,
    }
    const wrapper = mount(PageTranslationView)

    await wrapper.get('.ti-m-header-primary-btn').trigger('click')

    expect(sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_RESTORE,
    }, { returnFailureResponse: true })
    expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_RESTORE)
  })

  it('keeps Restore for fatal partial output', () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      isTranslated: true,
      translatedCount: 1,
      failedCount: 1,
      totalCount: 2,
    }
    const wrapper = mount(PageTranslationView)

    expect(wrapper.get('.ti-m-header-primary-btn').text()).toBe('Restore Original Page')
    expect(wrapper.text()).not.toContain('Retry Translation')
    expect(pageEventBus.emit).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE, expect.anything())
  })

  it('shows passive wording for partial completion', () => {
    mobileStore.pageTranslationData.value = {
      ...mobileStore.pageTranslationData.value,
      status: 'completed',
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
    }

    const wrapper = mount(PageTranslationView)

    expect(wrapper.text()).toContain('Completed with some content untranslated')
  })

  it('shows both scope rows and routes the actions to the rules composable', async () => {
    const wrapper = mount(PageTranslationView)
    const rows = wrapper.findAll('.ti-m-auto-translate-row')
    expect(rows).toHaveLength(2)
    await rows[0].trigger('click')
    await rows[1].trigger('click')
    expect(autoRules.scopeActions.togglePageScope).toHaveBeenCalledOnce()
    expect(autoRules.scopeActions.toggleSiteScope).toHaveBeenCalledOnce()
  })

  it('hides site scope for file URLs and offers broader-rule management', async () => {
    autoRules.siteScopeAvailable.value = false
    autoRules.showManageRules.value = true
    const wrapper = mount(PageTranslationView)
    expect(wrapper.findAll('.ti-m-auto-translate-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Managed by a broader rule')
    await wrapper.get('.ti-m-managed-note button').trigger('click')
    expect(autoRules.openManageRules).toHaveBeenCalledOnce()
  })

  it('renders no scope controls for an invalid current URL', () => {
    const originalWindow = window
    vi.stubGlobal('window', { location: { href: 'not-a-url' } })
    try {
      const wrapper = mount(PageTranslationView)
      expect(wrapper.findAll('.ti-m-auto-translate-row')).toHaveLength(0)
      expect(wrapper.find('.ti-m-managed-note').exists()).toBe(false)
    } finally {
      vi.stubGlobal('window', originalWindow)
    }
  })

  it('defines localized mobile scope states in all supported locales', () => {
    for (const key of ['mobile_auto_translate_active', 'mobile_auto_translate_inactive']) {
      for (const messages of [enMessages, faMessages, jaMessages]) {
        expect(messages[key]?.message, key).toBeTruthy()
      }
    }
  })
})

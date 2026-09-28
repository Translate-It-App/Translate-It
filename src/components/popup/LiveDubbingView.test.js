import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import LiveDubbingView from './LiveDubbingView.vue'

const here = dirname(fileURLToPath(import.meta.url))

// Shared mutable harness so vi.mock factories (hoisted above imports) can
// reach per-test store/i18n state.
const harness = vi.hoisted(() => ({
  store: null,
  i18n: {},
  tCalls: [],
  openOptionsPageMock: vi.fn(),
  locale: { value: 'en' },
  controlStatusResolved: true
}))

vi.mock('@/core/helpers.js', () => ({
  openOptionsPage: (...args) => harness.openOptionsPageMock(...args)
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => harness.store
}))

// Mirrors useUnifiedI18n semantics: (key, 'fallback') uses the fallback when
// untranslated; (key, { params }) interpolates; bare key falls back to key.
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
    useUnifiedI18n: () => ({
      locale: harness.locale,
      t: (key, options) => {
        harness.tCalls.push([key, options])
        const message = harness.i18n[key]
      if (typeof options === 'string') return message ?? options
      if (message == null) return key
      if (options && typeof options === 'object') {
        return message.replace(/\{(\w+)\}/g, (match, name) => options[name] ?? match)
      }
      return message
    }
  })
}))

// Stubbed children: this suite covers the view-level wiring contract and transcript
// preference write lifecycle. LiveDubbingControl behavior itself is covered by
// LiveDubbingControl.test.js and must not be duplicated.
const LanguageSelectorStub = {
  name: 'LanguageSelector',
  props: {
    targetLanguage: { type: String, default: 'en' },
    targetSelectId: { type: String, default: '' },
    targetTitle: { type: String, default: '' },
    provider: { type: String, default: '' },
    enableSelectElementIntegration: { type: Boolean, default: true },
    targetOnly: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:targetLanguage'],
  template: '<div class="language-selector-stub"><select :id="targetSelectId || undefined" :title="targetTitle" /></div>'
}

const setupLifecycle = { mounts: 0 }

const controlLifecycle = { mounts: 0, unmounts: 0, nextId: 0 }

  const LiveDubbingControlStub = {
  name: 'LiveDubbingControl',
  props: {
    targetLanguage: { type: String, default: '' },
    providerId: { type: String, default: '' },
    startDisabled: { type: Boolean, default: false }
  },
  emits: ['busy-change', 'status-resolved'],
  data() {
    return { instanceId: 0 }
  },
  mounted() {
    controlLifecycle.mounts += 1
    this.instanceId = ++controlLifecycle.nextId
    if (harness.controlStatusResolved) this.$emit('status-resolved')
  },
  unmounted() {
    controlLifecycle.unmounts += 1
  },
  template: '<div class="live-dubbing-control-stub" />'
}

const LiveDubbingProviderSetupStub = {
  name: 'LiveDubbingProviderSetup',
  props: {
    providerId: { type: String, default: '' },
    targetLanguage: { type: String, default: '' }
  },
  emits: ['save-pending', 'saved'],
  mounted() {
    setupLifecycle.mounts += 1
  },
  template: '<div class="live-dubbing-provider-setup-stub" />'
}

/** In-memory settings store: persists one key immediately into reactive state. */
const makeStore = (settings = {}) => {
  const store = {
    settings: reactive({
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      API_KEY: '',
       TRANSLATION_API: 'google',
       LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT: false,
        LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: false,
        LIVE_DUBBING_SUBTITLE_SIZE: 'medium',
        ...settings
    }),
    updateSettingLocally: vi.fn((key, value) => {
      store.settings[key] = value
    }),
    getSetting: vi.fn((key, defaultValue = null) => (
      store.settings[key] !== undefined ? store.settings[key] : defaultValue
    )),
    updateSettingAndPersist: vi.fn(async (key, value) => {
      store.updateSettingLocally(key, value)
      return true
    })
  }
  return store
}

const makeDeferredWriteStore = (settings = {}) => {
  const store = makeStore(settings)
  const writes = []
  const persisted = {}
  store.updateSettingAndPersist = vi.fn((key, value) => {
    store.updateSettingLocally(key, value)
    return new Promise((resolve, reject) => {
      writes.push({
        key,
        value,
        resolve: () => {
          persisted[key] = value
          resolve(true)
        },
        reject
      })
    })
  })
  return { store, writes, persisted }
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

const mountView = (props = {}) => mount(LiveDubbingView, {
  props: { targetLanguage: 'en', providerId: 'gemini', ...props },
  global: {
    stubs: {
      LanguageSelector: LanguageSelectorStub,
      LiveDubbingControl: LiveDubbingControlStub,
      LiveDubbingProviderSetup: LiveDubbingProviderSetupStub
    }
  }
})

const providerSelect = (wrapper) => wrapper.find('#live-dubbing-provider-select')
const transcriptHeader = (wrapper) => wrapper.find('.live-dubbing-transcript-preferences-toggle')
const transcriptHeaderRow = (wrapper) => wrapper.find('.live-dubbing-transcript-preferences-header')
const transcriptContent = (wrapper) => wrapper.find('#live-dubbing-transcript-preferences-content')

describe('LiveDubbingView', () => {
  beforeEach(() => {
    setupLifecycle.mounts = 0
    controlLifecycle.mounts = 0
    controlLifecycle.unmounts = 0
    controlLifecycle.nextId = 0
    harness.locale.value = 'en'
    harness.controlStatusResolved = true
    harness.store = makeStore({
      GEMINI_API_KEY: 'gemini-configured-key',
      OPENAI_API_KEY: 'openai-configured-key'
    })
    harness.i18n = {
      provider_gemini_title: 'Google Gemini',
      provider_openai_title: 'OpenAI GPT',
      provider_label: 'Provider',
      live_dubbing_manage_api_keys: 'Manage API keys',
      target_language_label: 'Target Language',
      live_dubbing_provider_description: 'Used for new live dubbing sessions.',
       live_dubbing_config_label: 'Configuration',
      live_dubbing_transcript_preferences_label: 'Subtitle preferences',
        live_dubbing_change_font_label: 'Change font',
       live_dubbing_show_translated_transcript: 'Dubbed',
       live_dubbing_show_original_transcript: 'Original',
       live_dubbing_subtitle_size_label: 'Subtitle size',
       live_dubbing_subtitle_size_small: 'Small',
       live_dubbing_subtitle_size_medium: 'Medium',
       live_dubbing_subtitle_size_large: 'Large',
      live_dubbing_subtitle_size_xlarge: 'Extra Large'
    }
    harness.tCalls = []
    harness.openOptionsPageMock.mockReset()
  })

  it('renders the LanguageSelector in target-only mode', () => {
    const wrapper = mountView({ providerId: 'openai' })

    const selector = wrapper.findComponent({ name: 'LanguageSelector' })
    expect(selector.exists()).toBe(true)
    expect(selector.props('targetOnly')).toBe(true)
    expect(selector.props('enableSelectElementIntegration')).toBe(false)
    expect(selector.props('provider')).toBe('openai')
  })

  it('disables the target selector while a target write or session is busy', async () => {
    const wrapper = mountView({ targetLanguagePending: true })
    const selector = wrapper.findComponent({ name: 'LanguageSelector' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    expect(selector.props('disabled')).toBe(true)

    await wrapper.setProps({ targetLanguagePending: false })
    expect(selector.props('disabled')).toBe(false)

    await control.vm.$emit('busy-change', true)
    expect(selector.props('disabled')).toBe(true)

    await control.vm.$emit('busy-change', false)
    expect(selector.props('disabled')).toBe(false)
  })

  it('passes the language pending gate to START and clears it after settle', async () => {
    const wrapper = mountView({ targetLanguagePending: true })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    const controlId = control.vm.instanceId

    expect(control.props('startDisabled')).toBe(true)

    await wrapper.setProps({ targetLanguagePending: false })
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).props('startDisabled'))
      .toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).vm.instanceId).toBe(controlId)
  })

  it('renders localized labels with the shared label treatment', () => {
    const wrapper = mountView()

    expect(wrapper.findAll('.live-dubbing-config-label').map((label) => label.text())).toEqual([
      'Target Language',
      'Provider'
    ])
    const targetLabel = wrapper.find('label[for="live-dubbing-target-language-select"]')
    const targetSelector = wrapper.findComponent({ name: 'LanguageSelector' })
    expect(targetLabel.exists()).toBe(true)
    expect(targetLabel.element.tagName).toBe('LABEL')
    expect(targetLabel.text()).toBe('Target Language')
    expect(targetSelector.props('targetSelectId')).toBe('live-dubbing-target-language-select')
    expect(targetSelector.props('targetTitle')).toBe('Target Language')
    expect(targetLabel.attributes('for'))
      .toBe(targetSelector.find('select').attributes('id'))
    expect(wrapper.find('label[for="live-dubbing-provider-select"]').classes())
      .toContain('live-dubbing-config-label')
    expect(wrapper.find('label[for="live-dubbing-provider-select"]').element.tagName).toBe('LABEL')
  })

  it('keeps Change font hidden and non-focusable while the Subtitles card is collapsed', () => {
    harness.i18n.live_dubbing_change_font_label = 'Change font locally'
    const wrapper = mountView()

    const link = wrapper.find('.live-dubbing-change-font-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('style')).toContain('display: none')
    expect(link.element.matches(':focus')).toBe(false)
    expect(link.text()).toBe('Change font locally')
    const header = transcriptHeaderRow(wrapper)
    expect(header.element.contains(link.element)).toBe(true)
    expect(link.element.compareDocumentPosition(header.find('.live-dubbing-transcript-preferences-chevron').element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('false')
    expect(harness.tCalls).toContainEqual([
      'live_dubbing_change_font_label',
      'Change font'
    ])
  })

  it('renders compact subtitle controls in order with an accessible size select', () => {
    const wrapper = mountView()
    const row = wrapper.find('.live-dubbing-transcript-preferences-list')
    const items = row.findAll('.live-dubbing-transcript-preference')
    const sizeSelect = wrapper.find('#live-dubbing-subtitle-size-select')

    expect(items).toHaveLength(3)
    expect(items[0].text()).toBe('Dubbed')
    expect(items[0].findComponent({ name: 'BaseToggle' }).exists()).toBe(true)
    expect(items[1].text()).toBe('Original')
    expect(items[1].classes()).not.toContain('live-dubbing-transcript-preference--size')
    expect(items[1].findComponent({ name: 'BaseToggle' }).exists()).toBe(true)
    expect(items[2].element.contains(sizeSelect.element)).toBe(true)
    expect(items[2].classes()).toContain('live-dubbing-transcript-preference--size')
    expect(sizeSelect.attributes('aria-label')).toBe('Subtitle size')
    expect(row.element.compareDocumentPosition(sizeSelect.element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const scss = readFileSync(resolve(here, 'LiveDubbingView.scss'), 'utf8')
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-list\s*\{[^}]*flex-flow:\s*row\s+wrap/)
    expect(scss).toMatch(/\.live-dubbing-change-font-enter-from[\s\S]*?opacity:\s*0/)
    expect(scss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.live-dubbing-change-font-leave-active[\s\S]*?transition:\s*none/)
  })

  it('starts the Subtitles card collapsed when both subtitle preferences are off', () => {
    const wrapper = mountView()

    expect(transcriptHeader(wrapper).element.tagName).toBe('BUTTON')
    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('false')
    expect(transcriptHeader(wrapper).attributes('aria-controls'))
      .toBe('live-dubbing-transcript-preferences-content')
    expect(transcriptContent(wrapper).exists()).toBe(true)
    expect(transcriptContent(wrapper).attributes('inert')).toBe('')
    expect(wrapper.findAllComponents({ name: 'BaseToggle' })).toHaveLength(2)
    expect(wrapper.find('.live-dubbing-change-font-link').attributes('style')).toContain('display: none')
  })

  it('keeps a large title disclosure control and independent Change font button', () => {
    const wrapper = mountView()
    const header = transcriptHeader(wrapper)

    expect(wrapper.findAll('button.live-dubbing-transcript-preferences-toggle')).toHaveLength(1)
    expect(header.attributes('type')).toBe('button')
    expect(header.element.tabIndex).toBe(0)
    expect(header.attributes('aria-expanded')).toBe('false')
    expect(header.attributes('aria-controls')).toBe('live-dubbing-transcript-preferences-content')
    expect(header.find('.live-dubbing-card-title').text()).toBe('Subtitle preferences')
    expect(header.findAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .toHaveLength(0)
    expect(transcriptHeaderRow(wrapper).findAll('button')).toHaveLength(2)
    expect(transcriptHeaderRow(wrapper).find('.live-dubbing-change-font-link').exists()).toBe(true)

    const source = readFileSync(resolve(here, 'LiveDubbingView.vue'), 'utf8')
    const toggleTemplate = source.match(/<button\s+type="button"\s+class="live-dubbing-transcript-preferences-toggle"[\s\S]*?<\/button>/)?.[0]
    expect(toggleTemplate).toBeTruthy()
    expect(toggleTemplate).not.toMatch(/<button\s[\s\S]+<button\s|<a\s/)
  })

  it('shows Change font when expanded without coupling its click to disclosure', async () => {
    const wrapper = mountView()
    const disclosure = transcriptHeader(wrapper)
    const changeFont = wrapper.find('.live-dubbing-change-font-link')

    await disclosure.trigger('click')
    expect(disclosure.attributes('aria-expanded')).toBe('true')
    expect(changeFont.attributes('style')).not.toContain('display: none')
    expect(changeFont.element.matches(':enabled')).toBe(true)

    await changeFont.trigger('click')

    expect(disclosure.attributes('aria-expanded')).toBe('true')
  })

  it('toggles from the title disclosure control but not from content clicks', async () => {
    const wrapper = mountView()
    const header = transcriptHeader(wrapper)

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')

    await transcriptContent(wrapper).trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
  })

  it.each([
    ['translated', { LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT: true }],
    ['original', { LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT: true }]
  ])('starts the Subtitles card expanded when %s subtitles are enabled', (_label, settings) => {
    harness.store = makeStore(settings)
    const wrapper = mountView()

    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('true')
    expect(transcriptContent(wrapper).attributes('inert')).toBeUndefined()
  })

  it('toggles the disclosure state without changing subtitle settings or remounting control', async () => {
    const wrapper = mountView()
    const controlId = wrapper.findComponent({ name: 'LiveDubbingControl' }).vm.instanceId
    const updateCount = harness.store.updateSettingAndPersist.mock.calls.length
    const localUpdateCount = harness.store.updateSettingLocally.mock.calls.length

    await transcriptHeader(wrapper).trigger('click')

    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('true')
    expect(transcriptContent(wrapper).attributes('inert')).toBeUndefined()
    expect(harness.store.updateSettingAndPersist).toHaveBeenCalledTimes(updateCount)
    expect(harness.store.updateSettingLocally).toHaveBeenCalledTimes(localUpdateCount)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).vm.instanceId).toBe(controlId)

    await transcriptHeader(wrapper).trigger('click')
    await settle()
    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('false')
    expect(transcriptContent(wrapper).attributes('inert')).toBe('')
  })

  it('keeps the existing subtitle controls hidden or visible with the disclosure state', async () => {
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })
    const sizeSelect = wrapper.find('#live-dubbing-subtitle-size-select')

    expect(toggles).toHaveLength(2)
    expect(transcriptContent(wrapper).attributes('inert')).toBe('')
    expect(sizeSelect.exists()).toBe(true)
    await transcriptHeader(wrapper).trigger('click')
    await settle()
    expect(transcriptContent(wrapper).attributes('inert')).toBeUndefined()
    expect(wrapper.findAllComponents({ name: 'BaseToggle' })).toHaveLength(2)
  })

  it('animates measured height and cleans up temporary styles after opening and closing', async () => {
    vi.useFakeTimers()
    const frameCallbacks = []
    const requestAnimationFrameMock = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
    const cancelAnimationFrameMock = vi.spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
    const wrapper = mountView()
    const content = transcriptContent(wrapper).element
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 144 })

    await transcriptHeader(wrapper).trigger('click')
    expect(content.style.height).toBe('0px')
    while (content.style.height === '0px' && frameCallbacks.length) frameCallbacks.shift()()
    expect(content.style.height).toBe('144px')
    vi.advanceTimersByTime(190)
    await nextTick()
    expect(content.style.height).toBe('')
    expect(content.style.transition).toBe('')

    await transcriptHeader(wrapper).trigger('click')
    expect(content.style.height).toBe('144px')
    while (content.style.height !== '0px' && frameCallbacks.length) frameCallbacks.shift()()
    expect(content.style.height).toBe('0px')
    vi.advanceTimersByTime(190)
    await nextTick()
    expect(content.style.height).toBe('')
    expect(content.style.transition).toBe('')

    requestAnimationFrameMock.mockRestore()
    cancelAnimationFrameMock.mockRestore()
    vi.useRealTimers()
  })

  it('settles rapid disclosure toggles on the latest requested state', async () => {
    vi.useFakeTimers()
    const frameCallbacks = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const wrapper = mountView()
    const content = transcriptContent(wrapper).element
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 144 })

    await transcriptHeader(wrapper).trigger('click')
    await transcriptHeader(wrapper).trigger('click')
    await transcriptHeader(wrapper).trigger('click')
    frameCallbacks.splice(0).forEach(callback => callback())
    vi.advanceTimersByTime(190)
    await nextTick()

    expect(transcriptHeader(wrapper).attributes('aria-expanded')).toBe('true')
    expect(content.attributes.inert).toBeUndefined()
    expect(content.style.height).toBe('')
    expect(content.style.transition).toBe('')

    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('skips height animation when reduced motion is preferred', async () => {
    vi.useFakeTimers()
    const originalMatchMedia = window.matchMedia
    const matchMediaMock = vi.fn().mockReturnValue({ matches: true })
    window.matchMedia = matchMediaMock
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const wrapper = mountView()
    const content = transcriptContent(wrapper).element
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 144 })

    await transcriptHeader(wrapper).trigger('click')

    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    // Change font's independent fade may use a frame; the disclosure height
    // transition itself must still complete synchronously under reduced motion.
    expect(content.style.height).toBe('')
    expect(content.style.transition).toBe('')

    vi.restoreAllMocks()
    if (originalMatchMedia) window.matchMedia = originalMatchMedia
    else delete window.matchMedia
    vi.useRealTimers()
  })

  it('does not auto-toggle the disclosure when subtitle preferences change', async () => {
    const collapsed = mountView()
    await collapsed.findAllComponents({ name: 'BaseToggle' })[0].vm.$emit('update:modelValue', true)
    expect(transcriptHeader(collapsed).attributes('aria-expanded')).toBe('false')

    harness.store = makeStore({ LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT: true })
    const expanded = mountView()
    await expanded.findAllComponents({ name: 'BaseToggle' })[0].vm.$emit('update:modelValue', false)
    expect(transcriptHeader(expanded).attributes('aria-expanded')).toBe('true')
  })

  it('opens Appearance at the translation-font setting and closes the popup', async () => {
    harness.store = makeStore({ LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT: true })
    harness.openOptionsPageMock.mockResolvedValue({ success: true })
    const wrapper = mountView()
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

    await wrapper.find('.live-dubbing-change-font-link').trigger('click')
    await settle()

    expect(harness.openOptionsPageMock).toHaveBeenCalledWith(
      '/appearance?highlight=LIVE_DUBBING_USE_TRANSLATION_FONT'
    )
    expect(harness.openOptionsPageMock.mock.calls[0][0])
      .toContain('LIVE_DUBBING_USE_TRANSLATION_FONT')
    expect(closeSpy).toHaveBeenCalledOnce()
    closeSpy.mockRestore()
  })

  it('marks the view locally for Persian RTL styling', async () => {
    harness.locale.value = 'fa'
    const wrapper = mountView()

    await nextTick()
    expect(wrapper.find('.live-dubbing-view').classes()).toContain('live-dubbing-view--rtl')
  })

  it('forwards the selected target language to LiveDubbingControl', async () => {
    const wrapper = mountView()

    // A selection inside the LanguageSelector flows up as update:targetLanguage;
    // the parent owns the prop, so the view re-emits it unchanged.
    await wrapper.findComponent({ name: 'LanguageSelector' }).vm.$emit('update:targetLanguage', 'de')
    expect(wrapper.emitted('update:targetLanguage')).toEqual([['de']])

    // Once the parent applies the new prop, the control receives it.
    await wrapper.setProps({ targetLanguage: 'de' })
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).props('targetLanguage')).toBe('de')
  })

  it('forwards the selected provider to the selector and the control', async () => {
    const wrapper = mountView()

    await wrapper.setProps({ providerId: 'openai' })
    expect(wrapper.findComponent({ name: 'LanguageSelector' }).props('provider')).toBe('openai')
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).props('providerId')).toBe('openai')
  })

  it('offers exactly the Gemini and OpenAI provider options', async () => {
    const wrapper = mountView()

    const options = providerSelect(wrapper).findAll('option')
    expect(options.map((option) => option.attributes('value'))).toEqual(['gemini', 'openai'])
    expect(options.map((option) => option.text())).toEqual(['Google Gemini', 'OpenAI GPT'])
  })

  it('places a keyboard-focusable Manage API keys icon button in the Provider header', () => {
    const wrapper = mountView({ providerId: 'openai' })
    const button = wrapper.find('button.ti-live-dubbing-manage-keys')
    const providerLabel = wrapper.find('label[for="live-dubbing-provider-select"]')
    const select = providerSelect(wrapper).element
    const icon = button.find('.mask-icon')

    expect(button.exists()).toBe(true)
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    expect(button.element.tabIndex).toBe(0)
    expect(button.attributes('aria-label')).toBe('Manage API keys')
    expect(button.attributes('title')).toBe('Manage API keys')
    expect(button.element.parentElement).toBe(providerLabel.element.parentElement)
    expect(select.contains(button.element)).toBe(false)
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('aria-hidden')).toBe('true')
    expect(icon.element.style.maskImage).toMatch(/^url\("data:image\/svg\+xml/)
    expect(icon.element.style.webkitMaskImage).toMatch(/^url\("data:image\/svg\+xml/)
    const source = readFileSync(resolve(here, 'LiveDubbingView.vue'), 'utf8')
    expect(source).toMatch(/import keyIcon from ['"]@\/icons\/ui\/key\.svg\?url['"];?/)
    expect(source).toMatch(/<MaskIcon\s+:src="keyIcon"/)

    expect(button.element.matches(':enabled')).toBe(true)
  })

  it.each([
    ['openai', 'gemini', '/providers?highlight=OPENAI_API_KEY'],
    ['gemini', 'openai', '/providers?highlight=GEMINI_API_KEY']
  ])('opens settings for the selected %s provider, independent of global %s setting', async (providerId, globalProvider, path) => {
    harness.store = makeStore({ LIVE_DUBBING_PROVIDER: providerId, TRANSLATION_API: globalProvider })
    harness.openOptionsPageMock.mockResolvedValue({ success: true })
    const wrapper = mountView({ providerId })
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

    await wrapper.find('button.ti-live-dubbing-manage-keys').trigger('click')
    await settle()

    expect(harness.openOptionsPageMock).toHaveBeenCalledOnce()
    expect(harness.openOptionsPageMock).toHaveBeenCalledWith(path)
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(providerSelect(wrapper).element.value).toBe(providerId)
    expect(harness.store.settings.LIVE_DUBBING_PROVIDER).toBe(providerId)
    expect(harness.store.settings.TRANSLATION_API).toBe(globalProvider)
    expect(harness.store.updateSettingAndPersist).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it.each([
    ['openai', '/providers?highlight=OPENAI_API_KEY'],
    ['gemini', '/providers?highlight=GEMINI_API_KEY']
  ])('uses the selected %s key route without closing when navigation does not report success', async (providerId, path) => {
    const globalProvider = providerId === 'openai' ? 'gemini' : 'openai'
    harness.store = makeStore({ LIVE_DUBBING_PROVIDER: providerId, TRANSLATION_API: globalProvider })
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const wrapper = mountView({ providerId })

    for (const response of [undefined, { success: false }]) {
      harness.openOptionsPageMock.mockResolvedValue(response)

      await wrapper.find('button.ti-live-dubbing-manage-keys').trigger('click')
      await settle()

      expect(harness.openOptionsPageMock).toHaveBeenLastCalledWith(path)
      expect(closeSpy).not.toHaveBeenCalled()
      expect(providerSelect(wrapper).element.value).toBe(providerId)
      expect(harness.store.settings.LIVE_DUBBING_PROVIDER).toBe(providerId)
      expect(harness.store.settings.TRANSLATION_API).toBe(globalProvider)
      expect(harness.store.updateSettingAndPersist).not.toHaveBeenCalled()
      harness.openOptionsPageMock.mockClear()
    }

    closeSpy.mockRestore()
  })

  it('keeps configuration headers and controls aligned across desktop, narrow, and RTL layouts', () => {
    const scss = readFileSync(resolve(here, 'LiveDubbingView.scss'), 'utf8')
    const headerRule = scss.match(/\.ti-live-dubbing-provider-header\s*\{[^}]*\}/m)?.[0]
    expect(headerRule).toMatch(/display:\s*flex/)
    expect(headerRule).toMatch(/justify-content:\s*space-between/)
    expect(headerRule).toMatch(/gap\s*:/)
    expect(headerRule).not.toMatch(/(?:block-size|height|min-height)\s*:/)
    expect(headerRule).not.toMatch(/(?:^|\n)\s*(?:left|right)\s*:/)

    const buttonRule = scss.match(/\.ti-live-dubbing-manage-keys\s*\{[^}]*\}/m)?.[0]
    expect(buttonRule).toMatch(/inline-size\s*:/)
    expect(buttonRule).toMatch(/block-size\s*:/)
    expect(buttonRule).not.toMatch(/overflow\s*:/)
    expect(buttonRule).toMatch(/color:\s*var\(--ti-action-icon\)/)
    expect(buttonRule).toMatch(/transition:\s*background-color 140ms ease, color 140ms ease/)
    expect(buttonRule).not.toMatch(/(?:^|\n)\s*(?:transform|box-shadow)\s*:/)
    const hoverRule = scss.match(/\.ti-live-dubbing-manage-keys:hover\s*\{[^}]*\}/m)?.[0]
    expect(hoverRule).toMatch(/color:\s*var\(--ti-action-icon-hover\)/)
    expect(hoverRule).toMatch(/background-color:\s*var\(--ti-action-hover-bg\)/)
    const viewRule = scss.match(/\.live-dubbing-view\s*\{[^}]*\}/m)?.[0]
    expect(viewRule).toMatch(/--ti-action-icon:\s*var\(--tab-button-color/)
    expect(viewRule).toMatch(/--ti-action-icon-hover:\s*var\(--color-action-hover-accent/)
    expect(viewRule).toMatch(/--ti-action-hover-bg:/)
    expect(scss).toMatch(/\.theme-dark \.live-dubbing-view[\s\S]*?--ti-action-hover-bg:\s*#424242/)

    const configGridRule = scss.match(/\.live-dubbing-config-grid\s*\{[^}]*\}/m)?.[0]
    expect(configGridRule).toMatch(/grid-template-areas:\s*["']language-header\s+provider-header["']\s+["']language-control\s+provider-control["']/)
    const narrowGrid = scss.match(/@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.live-dubbing-config-grid\s*\{[^}]*\}/m)?.[0]
    expect(narrowGrid).toMatch(/grid-template-areas:\s*["']language-header["']\s+["']language-control["']\s+["']provider-header["']\s+["']provider-control["']/)
    expect(scss).toMatch(/\.live-dubbing-config-field--provider \.ti-select[\s\S]*?width:\s*100%\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-config-field--language \.ti-language-select[\s\S]*?height:\s*36px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-config-field--provider \.ti-select[\s\S]*?height:\s*36px\s*!important/)

    const wrapper = mountView()
    const configGrid = wrapper.find('.live-dubbing-config-grid').element
    const orderedElements = [
      configGrid.querySelector('.ti-live-dubbing-language-header'),
      configGrid.querySelector('.ti-live-dubbing-provider-header'),
      configGrid.querySelector('.live-dubbing-config-field--language .language-selector-stub'),
      configGrid.querySelector('#live-dubbing-provider-select')
    ]
    expect(orderedElements.every(Boolean)).toBe(true)
    expect(orderedElements.slice(0, -1).every((element, index) => (
      element.compareDocumentPosition(orderedElements[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ))).toBe(true)
  })

  it('persists provider changes under LIVE_DUBBING_PROVIDER without touching TRANSLATION_API', async () => {
    const wrapper = mountView()

    await providerSelect(wrapper).setValue('openai')

    expect(harness.store.updateSettingAndPersist).toHaveBeenCalledWith('LIVE_DUBBING_PROVIDER', 'openai')
    expect(harness.store.updateSettingAndPersist).not.toHaveBeenCalledWith(
      'TRANSLATION_API',
      expect.anything()
    )
    expect(harness.store.settings.TRANSLATION_API).toBe('google')

    // Parent applies the persisted value back down; the control follows it.
    await wrapper.setProps({ providerId: 'openai' })
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).props('providerId')).toBe('openai')
  })

  it('disables the configuration card while the control reports busy', async () => {
    const wrapper = mountView()
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    control.vm.$emit('busy-change', true)
    await nextTick()

    expect(providerSelect(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'LanguageSelector' }).props('disabled')).toBe(true)
    // Busy still propagates to the parent unchanged (TranslationView lock).
    expect(wrapper.emitted('busy-change')).toEqual([[true]])

    control.vm.$emit('busy-change', false)
    await nextTick()

    expect(providerSelect(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.findComponent({ name: 'LanguageSelector' }).props('disabled')).toBe(false)
    expect(wrapper.emitted('busy-change')).toEqual([[true], [false]])
  })

  it('renders and persists each transcript preference independently', async () => {
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })

    expect(toggles).toHaveLength(2)
    expect(toggles.map(toggle => toggle.props('modelValue'))).toEqual([false, false])

    await toggles[0].vm.$emit('update:modelValue', true)
    await toggles[1].vm.$emit('update:modelValue', true)

    expect(harness.store.updateSettingAndPersist).toHaveBeenNthCalledWith(
      1, 'LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT', true
    )
    expect(harness.store.updateSettingAndPersist).toHaveBeenNthCalledWith(
      2, 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT', true
    )
    expect(harness.store.settings.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT).toBe(true)
    expect(harness.store.settings.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT).toBe(true)
  })

  it('renders all subtitle size options independently of subtitle visibility and session state', async () => {
    const wrapper = mountView()
    const sizeSelect = wrapper.find('#live-dubbing-subtitle-size-select')
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    expect(sizeSelect.exists()).toBe(true)
    expect(sizeSelect.classes()).toContain('live-dubbing-subtitle-size-select')
    expect(sizeSelect.element.value).toBe('medium')
    expect(sizeSelect.findAll('option').map(option => option.attributes('value')))
      .toEqual(['small', 'medium', 'large', 'xlarge'])
    expect(sizeSelect.element.disabled).toBe(false)

    control.vm.$emit('busy-change', true)
    await nextTick()
    expect(sizeSelect.element.disabled).toBe(false)
  })

  it('persists a successful subtitle size change without remounting the control', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const sizeSelect = wrapper.findAllComponents({ name: 'BaseSelect' })[1]
    const controlId = wrapper.findComponent({ name: 'LiveDubbingControl' }).vm.instanceId

    await sizeSelect.vm.$emit('update:modelValue', 'large')
    expect(deferred.writes).toHaveLength(1)
    expect(deferred.writes[0]).toMatchObject({
      key: 'LIVE_DUBBING_SUBTITLE_SIZE',
      value: 'large'
    })
    expect(harness.store.settings.LIVE_DUBBING_SUBTITLE_SIZE).toBe('large')
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).vm.instanceId).toBe(controlId)

    deferred.writes[0].resolve()
    await settle()
    expect(sizeSelect.props('disabled')).toBe(false)
  })

  it('restores the previous subtitle size after persistence failure', async () => {
    const deferred = makeDeferredWriteStore({ LIVE_DUBBING_SUBTITLE_SIZE: 'large' })
    harness.store = deferred.store
    const wrapper = mountView()
    const sizeSelect = wrapper.findAllComponents({ name: 'BaseSelect' })[1]

    await sizeSelect.vm.$emit('update:modelValue', 'small')
    expect(harness.store.settings.LIVE_DUBBING_SUBTITLE_SIZE).toBe('small')
    deferred.writes[0].reject(new Error('storage unavailable'))
    await settle()

    expect(harness.store.settings.LIVE_DUBBING_SUBTITLE_SIZE).toBe('large')
    expect(sizeSelect.props('modelValue')).toBe('large')
  })

  it('prevents overlapping subtitle size writes', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const sizeSelect = wrapper.findAllComponents({ name: 'BaseSelect' })[1]

    await sizeSelect.vm.$emit('update:modelValue', 'large')
    await sizeSelect.vm.$emit('update:modelValue', 'small')

    expect(deferred.writes).toHaveLength(1)
    expect(deferred.writes[0].value).toBe('large')
  })

  it('keeps the Gemini preference toggles editable while busy', async () => {
    const wrapper = mountView()
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    control.vm.$emit('busy-change', true)
    await nextTick()

    expect(wrapper.findAllComponents({ name: 'BaseToggle' }).every(toggle => !toggle.props('disabled')))
      .toBe(true)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
  })

  it('does not lock Gemini preferences while initial status is unresolved', async () => {
    harness.controlStatusResolved = false
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    expect(toggles.every(toggle => !toggle.props('disabled'))).toBe(true)

    control.vm.$emit('busy-change', true)
    await nextTick()

    expect(toggles.every(toggle => !toggle.props('disabled'))).toBe(true)
  })

  it('keeps Gemini translated and original preferences independently persistent while busy', async () => {
    const wrapper = mountView()
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })

    control.vm.$emit('busy-change', true)
    await nextTick()

    await toggles[0].vm.$emit('update:modelValue', true)
    await toggles[1].vm.$emit('update:modelValue', true)

    expect(harness.store.updateSettingAndPersist).toHaveBeenNthCalledWith(
      1, 'LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT', true
    )
    expect(harness.store.updateSettingAndPersist).toHaveBeenNthCalledWith(
      2, 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT', true
    )
  })

  it('keeps the OpenAI translated preference editable while busy', async () => {
    const wrapper = mountView({ providerId: 'openai' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })

    control.vm.$emit('busy-change', true)
    await nextTick()

    expect(toggles[0].props('disabled')).toBe(false)
    expect(toggles[1].props('disabled')).toBe(true)

    await toggles[0].vm.$emit('update:modelValue', true)
    expect(harness.store.updateSettingAndPersist).toHaveBeenCalledWith(
      'LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT', true
    )
  })

  it('re-enables the OpenAI original preference after the session ends', async () => {
    const wrapper = mountView({ providerId: 'openai' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    const original = wrapper.findAllComponents({ name: 'BaseToggle' })[1]

    control.vm.$emit('busy-change', true)
    await nextTick()
    expect(original.props('disabled')).toBe(true)

    control.vm.$emit('busy-change', false)
    await nextTick()

    expect(original.props('disabled')).toBe(false)
    expect(control.exists()).toBe(true)
  })

  it('keeps OpenAI original disabled until initial status resolves, including remounts', async () => {
    harness.controlStatusResolved = false
    const wrapper = mountView({ providerId: 'openai' })
    let original = wrapper.findAllComponents({ name: 'BaseToggle' })[1]

    expect(original.props('disabled')).toBe(true)

    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    control.vm.$emit('status-resolved')
    await nextTick()
    expect(original.props('disabled')).toBe(false)

    await wrapper.setProps({ providerId: 'gemini' })
    await wrapper.setProps({ providerId: 'openai' })
    original = wrapper.findAllComponents({ name: 'BaseToggle' })[1]

    expect(original.props('disabled')).toBe(true)
  })

  it('starts one write immediately and disables only that toggle while pending', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })

    toggles[0].vm.$emit('update:modelValue', true)
    expect(deferred.writes).toHaveLength(1)
    expect(deferred.writes[0]).toMatchObject({
      key: 'LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT',
      value: true
    })

    await nextTick()
    expect(toggles[0].props('disabled')).toBe(true)
    expect(toggles[1].props('disabled')).toBe(false)
  })

  it('ignores a second event for the same pending preference', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const translated = wrapper.findAllComponents({ name: 'BaseToggle' })[0]

    translated.vm.$emit('update:modelValue', true)
    translated.vm.$emit('update:modelValue', false)
    expect(deferred.writes).toHaveLength(1)
  })

  it('keeps the other preference enabled and starts its independent write', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })

    toggles[0].vm.$emit('update:modelValue', true)
    await nextTick()
    expect(toggles[1].props('disabled')).toBe(false)

    toggles[1].vm.$emit('update:modelValue', true)
    expect(deferred.writes).toHaveLength(2)
    expect(deferred.writes[1]).toMatchObject({
      key: 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT',
      value: true
    })
  })

  it('keeps a pending write functionally disabled while showing the neutral pending visual', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })
    const labels = () => wrapper.findAll('label.base-toggle')

    toggles[0].vm.$emit('update:modelValue', true)
    await nextTick()

    // Functionally disabled while its own write is pending.
    expect(toggles[0].props('disabled')).toBe(true)
    expect(toggles[1].props('disabled')).toBe(false)
    // Neutral visual only on the pending lane, never on the idle one.
    expect(labels()[0].classes()).toContain('live-dubbing-toggle--pending-neutral')
    expect(labels()[1].classes()).not.toContain('live-dubbing-toggle--pending-neutral')

    // Settling the write removes both the functional disable and the class.
    deferred.writes[0].resolve()
    await settle()
    expect(toggles[0].props('disabled')).toBe(false)
    expect(labels()[0].classes()).not.toContain('live-dubbing-toggle--pending-neutral')
  })

  it('keeps the real OpenAI restriction visual without the pending-neutral override', async () => {
    harness.controlStatusResolved = false
    const wrapper = mountView({ providerId: 'openai' })
    const original = wrapper.findAllComponents({ name: 'BaseToggle' })[1]
    const originalLabel = () => wrapper.findAll('label.base-toggle')[1]

    // Real restriction: functionally disabled with BaseToggle's disabled look.
    expect(original.props('disabled')).toBe(true)
    expect(originalLabel().classes()).toContain('disabled')
    expect(originalLabel().classes()).not.toContain('live-dubbing-toggle--pending-neutral')
    // The translated toggle has no restriction of its own.
    expect(wrapper.findAllComponents({ name: 'BaseToggle' })[0].props('disabled')).toBe(false)
  })

  it('lets the real OpenAI restriction win over the pending-neutral visual when both apply', async () => {
    harness.controlStatusResolved = false
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView({ providerId: 'openai' })
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })
    const originalLabel = () => wrapper.findAll('label.base-toggle')[1]

    toggles[1].vm.$emit('update:modelValue', true)
    await nextTick()

    // The write is pending and the restriction is active: the genuine
    // disabled presentation must win — no neutral override.
    expect(deferred.writes).toHaveLength(1)
    expect(toggles[1].props('disabled')).toBe(true)
    expect(originalLabel().classes()).toContain('disabled')
    expect(originalLabel().classes()).not.toContain('live-dubbing-toggle--pending-neutral')
  })

  it('applies the pending-only visual override locally in LiveDubbingView, not in BaseToggle', () => {
    const viewScss = readFileSync(resolve(here, 'LiveDubbingView.scss'), 'utf8')
    const override = viewScss.match(
      /\.live-dubbing-transcript-preference-toggle\.live-dubbing-toggle--pending-neutral\.base-toggle\s*\{[\s\S]*?\n\}/
    )?.[0]
    expect(override).toBeTruthy()
    expect(override).toMatch(/opacity:\s*1/)
    expect(override).toMatch(/cursor:\s*pointer/)
    // Both the label root and the slider keep the neutral pointer cursor.
    expect(override).toMatch(/\.slider\s*\{[^}]*cursor:\s*pointer/)

    // The shared BaseToggle is untouched — no global behavior change.
    const baseToggleScss = readFileSync(resolve(here, '../base/BaseToggle.scss'), 'utf8')
    expect(baseToggleScss).not.toMatch(/pending-neutral/)
  })

  it('keeps LiveDubbingControl mounted and Start disabled until both independent writes settle', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const toggles = wrapper.findAllComponents({ name: 'BaseToggle' })
    const control = () => wrapper.findComponent({ name: 'LiveDubbingControl' })
    const initialControlId = control().vm.instanceId

    toggles[0].vm.$emit('update:modelValue', true)
    toggles[1].vm.$emit('update:modelValue', true)

    expect(deferred.writes).toHaveLength(2)
    await nextTick()
    // Control stays mounted while either write is pending — its status/session
    // presentation must not flicker through remounts.
    expect(control().exists()).toBe(true)
    expect(control().vm.instanceId).toBe(initialControlId)
    // Start is gated on every pending write.
    expect(control().props('startDisabled')).toBe(true)

    // Resolving one write still leaves Start gated on the other pending write.
    deferred.writes[0].resolve()
    await settle()
    expect(control().exists()).toBe(true)
    expect(control().vm.instanceId).toBe(initialControlId)
    expect(control().props('startDisabled')).toBe(true)

    // Once both writes settle, Start is re-enabled.
    deferred.writes[1].resolve()
    await settle()
    expect(control().exists()).toBe(true)
    expect(control().vm.instanceId).toBe(initialControlId)
    expect(control().props('startDisabled')).toBe(false)
  })

  it('rolls back a rejected preference write without retrying or an unhandled rejection', async () => {
    const deferred = makeDeferredWriteStore()
    harness.store = deferred.store
    const wrapper = mountView()
    const translated = wrapper.findAllComponents({ name: 'BaseToggle' })[0]
    const unhandledRejections = []
    const onUnhandledRejection = (reason) => unhandledRejections.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    translated.vm.$emit('update:modelValue', true)
    await nextTick()
    expect(translated.props('disabled')).toBe(true)

    deferred.writes[0].reject(new Error('storage unavailable'))
    await settle()

    process.off('unhandledRejection', onUnhandledRejection)
    expect(unhandledRejections).toHaveLength(0)
    expect(harness.store.settings.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT).toBe(false)
    expect(translated.props('disabled')).toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
    expect(harness.store.updateSettingAndPersist).toHaveBeenCalledTimes(1)
  })

  it('shows credential setup only for a provider that lacks credentials', async () => {
    harness.store = makeStore({ OPENAI_API_KEY: 'openai-configured-key' })
    const wrapper = mountView({ providerId: 'gemini' })

    const setup = () => wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })
    expect(setup().exists()).toBe(true)
    expect(setup().props('providerId')).toBe('gemini')
    expect(setup().props('targetLanguage')).toBe('en')

    await wrapper.setProps({ providerId: 'openai' })
    expect(setup().exists()).toBe(false)

    await wrapper.setProps({ providerId: 'gemini' })
    expect(setup().exists()).toBe(true)
  })

  it('hides the session card while keeping the control mounted when setup is needed', () => {
    harness.store = makeStore({ OPENAI_API_KEY: 'openai-configured-key' })
    const wrapper = mountView({ providerId: 'gemini' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style')).toContain('display: none')
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
  })

  it('shows the session card when the hidden control becomes busy', async () => {
    harness.store = makeStore({ OPENAI_API_KEY: 'openai-configured-key' })
    const wrapper = mountView({ providerId: 'gemini' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })

    expect(wrapper.find('.live-dubbing-session-card').attributes('style')).toContain('display: none')

    control.vm.$emit('busy-change', true)
    await nextTick()

    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style') || '')
      .not.toContain('display: none')
  })

  it('keeps the session control visible for a configured provider', () => {
    const wrapper = mountView({ providerId: 'openai' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(false)
    expect(wrapper.find('.live-dubbing-session-card').exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style') || '')
      .not.toContain('display: none')
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
  })

  it('shows setup and hides the Subtitles and session cards while credentials are missing', () => {
    harness.store = makeStore({ OPENAI_API_KEY: 'openai-configured-key' })
    const wrapper = mountView({ providerId: 'gemini' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-transcript-preferences').attributes('style'))
      .toContain('display: none')
    expect(wrapper.find('.live-dubbing-session-card').attributes('style'))
      .toContain('display: none')
  })

  it('shows both the Subtitles and session cards for a configured credential', () => {
    const wrapper = mountView({ providerId: 'gemini' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(false)
    expect(wrapper.find('.live-dubbing-transcript-preferences').attributes('style') || '')
      .not.toContain('display: none')
    expect(wrapper.find('.live-dubbing-session-card').attributes('style') || '')
      .not.toContain('display: none')
  })

  it('keeps both cards visible during a busy session after credentials are removed', async () => {
    const wrapper = mountView({ providerId: 'gemini' })
    const control = wrapper.findComponent({ name: 'LiveDubbingControl' })
    const transcriptCard = () => wrapper.find('.live-dubbing-transcript-preferences')
    const sessionCard = () => wrapper.find('.live-dubbing-session-card')

    control.vm.$emit('busy-change', true)
    await nextTick()

    harness.store.settings.GEMINI_API_KEY = ''
    harness.store.settings.API_KEY = ''
    await nextTick()

    expect(transcriptCard().attributes('style') || '').not.toContain('display: none')
    expect(sessionCard().attributes('style') || '').not.toContain('display: none')
  })

  it('shows the session control immediately after successful setup', async () => {
    harness.store = makeStore()
    const wrapper = mountView({ providerId: 'gemini' })
    const setup = wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })

    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style')).toContain('display: none')

    await setup.vm.$emit('saved')
    harness.store.settings.GEMINI_API_KEY = 'freshly-saved-key'
    await nextTick()

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style') || '')
      .not.toContain('display: none')
  })

  it('treats the legacy API_KEY store as configured for Gemini', async () => {
    harness.store = makeStore({ API_KEY: 'legacy-gemini-key' })
    const wrapper = mountView({ providerId: 'gemini' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(false)

    // OpenAI has its own key store — an empty one still requires setup.
    await wrapper.setProps({ providerId: 'openai' })
    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(true)
  })

  it('ignores blank-only credential values when deciding setup visibility', async () => {
    harness.store = makeStore({ GEMINI_API_KEY: '  \n\t ' })
    const wrapper = mountView({ providerId: 'gemini' })

    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(true)
  })

  it('switching provider remounts the setup card so stale state is cleared', async () => {
    // Neither provider configured → card visible across the switch.
    harness.store = makeStore()
    const wrapper = mountView({ providerId: 'gemini' })
    expect(setupLifecycle.mounts).toBe(1)

    await wrapper.setProps({ providerId: 'openai' })

    const setup = wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })
    expect(setup.props('providerId')).toBe('openai')
    // :key="providerModel" forces a fresh instance (fresh draft/error state).
    expect(setupLifecycle.mounts).toBe(2)
  })

  it('keeps the redesign out of TranslationView and the sidepanel', () => {
    const translationView = readFileSync(resolve(here, 'TranslationView.vue'), 'utf8')
    expect(translationView).not.toMatch(/LiveDubbingProviderSetup|LIVE_DUBBING_PROVIDER/)

    const sidepanelDir = resolve(here, '../../apps/sidepanel')
    const sidepanelFiles = readdirSync(sidepanelDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.vue'))
    expect(sidepanelFiles.length).toBeGreaterThan(0)
    for (const file of sidepanelFiles) {
      const source = readFileSync(resolve(sidepanelDir, file), 'utf8')
      expect(source, file).not.toMatch(/LiveDubbingProviderSetup|LiveDubbingControl|LIVE_DUBBING_PROVIDER/)
    }
  })

  it('uses logical CSS properties so the layout survives RTL locales', () => {
    const scss = readFileSync(resolve(here, 'LiveDubbingView.scss'), 'utf8')

    expect(scss).not.toMatch(/(?:padding|margin|inset)-(?:left|right)\s*:/)
    expect(scss).not.toMatch(/(?:text-align|border(?:-left|-right)?):\s*(?:left|right)/)
    expect(scss).not.toMatch(/\b(?:left|right)\s*:\s*\d/)
    // Feedback/source text aligns to the logical start edge.
    expect(scss).toMatch(/text-align:\s*start/)
    // Theme-aware tokens only — no hardcoded light/dark surfaces.
    expect(scss).toMatch(/var\(--header-border-color\)/)
    expect(scss).toMatch(/var\(--language-controls-bg-color\)/)
    // Control alignment is owned by this card, not shared control styles.
    expect(scss).toMatch(/\.live-dubbing-config-field--language \.ti-language-select/)
    expect(scss).toMatch(/\.live-dubbing-config-field--provider \.ti-select/)
    const sharedCardRule = scss.match(/\.live-dubbing-card\s*\{[^}]*\}/m)?.[0]
    const transcriptCardRule = scss.match(/\.ti-live-dubbing-transcript-card\s*\{[^}]*\}/m)?.[0]
    expect(sharedCardRule).toMatch(/padding:\s*8px 10px/)
    expect(transcriptCardRule).toMatch(/padding:\s*0/)
    const viewSource = readFileSync(resolve(here, 'LiveDubbingView.vue'), 'utf8')
    expect(viewSource).toMatch(/class="(?=[^"]*\blive-dubbing-transcript-preferences\b)(?=[^"]*\bti-live-dubbing-transcript-card\b)[^"]*"/)
    const headerRule = scss.match(
      /\.live-dubbing-transcript-preferences-header\s*\{[\s\S]*?^\}/m
    )?.[0]
    const headerHoverRule = scss.match(/\.live-dubbing-transcript-preferences-toggle:hover\s*\{[^}]*\}/)?.[0]
    const headerFocusRule = scss.match(
      /\.live-dubbing-transcript-preferences-toggle:focus-visible\s*\{[^}]*\}/m
    )?.[0]
    const titleRule = scss.match(/\.live-dubbing-card-title\s*\{[^}]*\}/m)?.[0]
    expect(headerRule).toMatch(/inline-size:\s*100%/)
    expect(headerRule).toMatch(/box-sizing:\s*border-box/)
    expect(headerRule).toMatch(/padding-block:\s*8px/)
    expect(headerRule).toMatch(/padding-inline:\s*10px/)
    expect(headerRule).not.toMatch(/transition\s*:/)
    expect(headerRule).not.toMatch(/transform\s*:|box-shadow\s*:/)
    expect(headerHoverRule).toBeTruthy()
    expect(headerHoverRule).not.toMatch(/^\s*background(?:-color)?\s*:/m)
    expect(headerHoverRule).toMatch(/color:\s*var\(--ti-action-icon-hover\)/)
    expect(headerHoverRule).not.toMatch(/(?:transform|box-shadow|border(?:-[\w-]+)?|transition|animation)\s*:/)
    expect(titleRule).toMatch(/color:\s*inherit/)
    expect(headerFocusRule).toBeTruthy()
    expect(headerFocusRule).toMatch(/outline:\s*2px\s+solid\s+var\(--color-primary\)/)
    expect(headerFocusRule).not.toMatch(/transform\s*:|box-shadow\s*:/)
    expect(scss.match(/\.live-dubbing-transcript-preferences-toggle(?::hover|:focus-visible)?\s*\{/g))
      .toEqual(['.live-dubbing-transcript-preferences-toggle {', '.live-dubbing-transcript-preferences-toggle:hover {', '.live-dubbing-transcript-preferences-toggle:focus-visible {'])
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-chevron[\s\S]*?border-inline-end:/)
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-chevron[\s\S]*?border-block-end:/)
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-chevron\s*\{[^}]*border-(?:inline-end|block-end):\s*[^;]*currentColor/)
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-chevron[\s\S]*?transition:\s*transform\s+190ms\s+cubic-bezier\(0\.2,\s*0,\s*0,\s*1\)/)
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-toggle\s*\{[^}]*min-inline-size:\s*44px/)
    expect(scss).toMatch(/\.live-dubbing-transcript-preferences-header--expanded[\s\S]*?transform:\s*rotate\(225deg\)/)
    expect(scss).not.toMatch(/grid-template-rows/)
    const contentRule = scss.match(
      /\.live-dubbing-transcript-preferences-content\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(contentRule).toMatch(/box-sizing:\s*border-box/)
    expect(contentRule).toMatch(/padding:\s*0/)
    const contentInnerRule = scss.match(
      /\.live-dubbing-transcript-preferences-content-inner\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(contentInnerRule).toMatch(/padding-block:\s*0 8px/)
    expect(contentInnerRule).toMatch(/padding-inline:\s*10px/)
    expect(contentRule).not.toMatch(/opacity|transition/)
    expect(scss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.live-dubbing-transcript-preferences-chevron[\s\S]*?transition:\s*none/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?flex:\s*1\s+1\s+112px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?inline-size:\s*112px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?height:\s*32px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?font-size:\s*12px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?border-radius:\s*6px\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-subtitle-size-select\s*\{[\s\S]*?min-width:\s*0\s*!important/)
    expect(scss).toMatch(/\.live-dubbing-view--rtl \.live-dubbing-subtitle-size-select\s*\{[\s\S]*?background-position:\s*left 10px center\s*!important/)
    expect(scss).not.toMatch(/^\.ti-language-select/m)
    expect(scss).not.toMatch(/^\.ti-select/m)
    expect(scss).not.toMatch(/\.live-dubbing-view--rtl\s*\{[\s\S]*?direction:\s*rtl/)

    const setupInputField = scss.match(
      /\.live-dubbing-setup-input-field\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(setupInputField).toMatch(/direction:\s*ltr/)
    expect(scss).toMatch(/\.live-dubbing-setup-input \.ti-textarea\s*\{[\s\S]*?padding-inline:\s*10px 42px\s*!important/)
    expect(scss).toMatch(/:root\.theme-dark \.live-dubbing-setup-toggle img[\s\S]*?filter:\s*invert\(1\)/)

    const saveButton = scss.match(
      /\.live-dubbing-setup-controls-row > \.ti-btn\.live-dubbing-setup-save\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(saveButton).toBeTruthy()
    const saveButtonSelector = saveButton.split('{')[0]
    expect((saveButtonSelector.match(/\./g) || []).length)
      .toBeGreaterThan(('.ti-btn'.match(/\./g) || []).length)
    expect(saveButton).toMatch(/width:\s*auto\s*!important/)
    expect(saveButton).toMatch(/height:\s*36px\s*!important/)
    expect(saveButton).toMatch(/min-height:\s*36px\s*!important/)
    expect(saveButton).toMatch(/min-inline-size:\s*72px/)
    expect(saveButton).toMatch(/padding-inline:\s*14px\s*!important/)
    expect(saveButton).toMatch(/border-radius:\s*6px\s*!important/)
    expect(saveButton).toMatch(/font-size:\s*13px\s*!important/)
    expect(saveButton).toMatch(/font-weight:\s*500\s*!important/)
    expect(scss).not.toMatch(/^\.ti-btn\s*\{/m)

    const disabledLanguage = scss.match(
      /\.live-dubbing-config-card \.live-dubbing-config-field--language\s+\.ti-language-select:disabled\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(disabledLanguage).toBeTruthy()
    expect(disabledLanguage).toMatch(/background-color:\s*var\(--color-background-muted\)\s*!important/)
    expect(disabledLanguage).toMatch(/color:\s*var\(--color-text-muted\)\s*!important/)
    expect(disabledLanguage).toMatch(/opacity:\s*0\.6\s*!important/)
    expect(disabledLanguage).toMatch(/cursor:\s*not-allowed\s*!important/)
    expect(scss).not.toMatch(/^\.ti-language-select:disabled\s*\{/m)

    const rtlSetupFeedback = scss.match(
      /\.live-dubbing-view--rtl \.live-dubbing-setup-feedback\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(rtlSetupFeedback).toMatch(/direction:\s*rtl\s*!important/)
    expect(rtlSetupFeedback).toMatch(/text-align:\s*start\s*!important/)

    const rtlActions = scss.match(
      /\.live-dubbing-view--rtl \.live-dubbing-setup-controls-row\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(rtlActions).toMatch(/direction:\s*rtl/)
    expect(scss).toMatch(/\.live-dubbing-setup-controls-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/)

    const languageWrapper = scss.match(
      /\.live-dubbing-config-card \.live-dubbing-config-field--language > \.ti-language-controls\s*\{[\s\S]*?\n\}/m
    )?.[0]
    const languageWrapperSelector = languageWrapper.split('{')[0]
    expect((languageWrapperSelector.match(/\./g) || []).length)
      .toBeGreaterThan(('.popup-wrapper .ti-language-controls'.match(/\./g) || []).length)
    expect(languageWrapper).toMatch(/width:\s*100%/)
    expect(languageWrapper).toMatch(/min-width:\s*0/)
    expect(languageWrapper).toMatch(/height:\s*36px\s*!important/)
    expect(languageWrapper).toMatch(/min-height:\s*36px\s*!important/)
    expect(languageWrapper).toMatch(/margin:\s*0\s*!important/)
    expect(languageWrapper).toMatch(/padding:\s*0\s*!important/)
    expect(languageWrapper).toMatch(/background:\s*transparent\s*!important/)

    const responsiveSelector = '.ti-language-controls:not(.ti-compact-mode) .ti-language-select'
    const languageOverride = scss.match(
      /\.live-dubbing-config-card \.live-dubbing-config-field--language\s+\.ti-language-controls:not\(\.ti-compact-mode\) \.ti-language-select\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(languageOverride).toBeTruthy()
    const languageOverrideSelector = languageOverride.split('{')[0]
    expect((languageOverrideSelector.match(/\./g) || []).length)
      .toBeGreaterThan((responsiveSelector.match(/\./g) || []).length)
    expect(languageOverride).toMatch(/height:\s*36px\s*!important/)
    expect(languageOverride).toMatch(/min-height:\s*36px\s*!important/)
    expect(languageOverride).toMatch(/font-size:\s*13px\s*!important/)
    expect(languageOverride).toMatch(/border-radius:\s*6px\s*!important/)
    expect(languageOverride).toMatch(/padding-inline:\s*10px 34px\s*!important/)
    expect(languageOverride).toMatch(/background-position:\s*right 10px center\s*!important/)
    const languageRtlBlock = scss.match(
      /\.live-dubbing-view--rtl \.live-dubbing-config-card\s+\.live-dubbing-config-field--language[\s\S]*?\{[\s\S]*?\n\}/m
    )?.[0]
    const providerRtlBlock = scss.match(
      /\.live-dubbing-view--rtl \.live-dubbing-config-card\s+\.live-dubbing-config-field--provider \.ti-select\s*\{[\s\S]*?\n\}/m
    )?.[0]
    expect(languageRtlBlock).toMatch(/padding-inline:\s*10px 34px\s*!important/)
    expect(providerRtlBlock).toMatch(/padding-inline:\s*10px 34px\s*!important/)
    expect(languageRtlBlock).toMatch(/background-position:\s*left 10px center\s*!important/)
    expect(providerRtlBlock).toMatch(/background-position:\s*left 10px center\s*!important/)
  })

  it('keeps the setup card mounted while a save is pending despite optimistic store mutation', async () => {
    harness.store = makeStore()
    const wrapper = mountView({ providerId: 'gemini' })
    const setup = () => wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })
    expect(setup().exists()).toBe(true)

    // The setup signals pending BEFORE the store mutates; the card must stay.
    await setup().vm.$emit('save-pending', true)
    harness.store.settings.GEMINI_API_KEY = 'optimistic-draft-key'
    await nextTick()
    expect(setup().exists()).toBe(true)

    // Success path: pending clears and credentials are present → card hides.
    await setup().vm.$emit('save-pending', false)
    await nextTick()
    expect(setup().exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'LiveDubbingControl' }).exists()).toBe(true)
  })

  it('keeps the setup card visible when a failed save restores the previous value', async () => {
    harness.store = makeStore()
    const wrapper = mountView({ providerId: 'gemini' })
    const setup = () => wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })

    await setup().vm.$emit('save-pending', true)
    harness.store.settings.GEMINI_API_KEY = 'optimistic-draft-key'
    await nextTick()
    expect(setup().exists()).toBe(true)

    // Failure path restores the previous (empty) value → card stays mounted.
    harness.store.settings.GEMINI_API_KEY = ''
    await setup().vm.$emit('save-pending', false)
    await nextTick()
    expect(setup().exists()).toBe(true)
  })

  it('locks the provider select while a credential save is pending', async () => {
    harness.store = makeStore()
    const wrapper = mountView({ providerId: 'gemini' })
    const setup = () => wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })

    await setup().vm.$emit('save-pending', true)
    await nextTick()
    expect(providerSelect(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'LanguageSelector' }).props('disabled')).toBe(true)

    harness.store.settings.GEMINI_API_KEY = 'saved-key'
    await setup().vm.$emit('save-pending', false)
    await nextTick()
    expect(providerSelect(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.findComponent({ name: 'LanguageSelector' }).props('disabled')).toBe(false)
  })

  it('remounts the control on an idle provider switch so stale state cannot survive', async () => {
    const wrapper = mountView({ providerId: 'gemini' })
    const control = () => wrapper.findComponent({ name: 'LiveDubbingControl' })
    const beforeId = control().vm.instanceId

    await wrapper.setProps({ providerId: 'openai' })

    expect(control().props('providerId')).toBe('openai')
    // :key follows the provider while idle → fresh instance, fresh state.
    expect(control().vm.instanceId).not.toBe(beforeId)
  })

  it('does not remount the control while busy, then remounts once idle', async () => {
    const wrapper = mountView({ providerId: 'gemini' })
    const control = () => wrapper.findComponent({ name: 'LiveDubbingControl' })

    control().vm.$emit('busy-change', true)
    await nextTick()
    const busyInstanceId = control().vm.instanceId

    await wrapper.setProps({ providerId: 'openai' })
    expect(control().props('providerId')).toBe('openai')
    // Key frozen while busy: same instance, no mid-session remount.
    expect(control().vm.instanceId).toBe(busyInstanceId)

    control().vm.$emit('busy-change', false)
    await nextTick()
    // Unlocking with a changed provider remounts to the fresh provider state.
    expect(control().vm.instanceId).not.toBe(busyInstanceId)
    expect(control().props('providerId')).toBe('openai')
  })

  it('leaves a fresh control behind after successful credential setup', async () => {
    harness.store = makeStore({ GEMINI_API_KEY: 'existing-key' })
    const wrapper = mountView({ providerId: 'gemini' })
    const control = () => wrapper.findComponent({ name: 'LiveDubbingControl' })
    const setup = () => wrapper.findComponent({ name: 'LiveDubbingProviderSetup' })
    const beforeId = control().vm.instanceId

    // Re-enter setup while idle, then complete it successfully.
    harness.store.settings.GEMINI_API_KEY = ''
    await nextTick()
    expect(setup().exists()).toBe(true)
    expect(control().exists()).toBe(true)
    expect(wrapper.find('.live-dubbing-session-card').attributes('style')).toContain('display: none')

    // Save success while idle freshens the control; the persisted credential
    // then hides the setup card — no popup reopen required.
    await setup().vm.$emit('saved')
    harness.store.settings.GEMINI_API_KEY = 'freshly-saved-key'
    await nextTick()

    expect(control().vm.instanceId).not.toBe(beforeId)
    expect(setup().exists()).toBe(false)
  })

  it('does not remount the control for a save that completes while busy', async () => {
    harness.store = makeStore({ GEMINI_API_KEY: 'existing-key' })
    const wrapper = mountView({ providerId: 'gemini' })
    const control = () => wrapper.findComponent({ name: 'LiveDubbingControl' })

    control().vm.$emit('busy-change', true)
    await nextTick()
    const busyInstanceId = control().vm.instanceId

    harness.store.settings.GEMINI_API_KEY = ''
    await nextTick()
    expect(wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).exists()).toBe(true)

    await wrapper.findComponent({ name: 'LiveDubbingProviderSetup' }).vm.$emit('saved')
    await nextTick()

    expect(control().vm.instanceId).toBe(busyInstanceId)
  })
})

import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ref } from 'vue'

const eventHandlers = {}
const unsubscribeMocks = []
let windowsManagerImported = false
const getI18nUtilsMock = vi.fn(async () => ({ getTranslationString: vi.fn(() => undefined) }))
const storageSetMock = vi.fn(async (data) => {
  globalThis.__pdfWindowsHostStorageState = {
    ...(globalThis.__pdfWindowsHostStorageState || {}),
    ...data
  }
  return true
})

const sendRegularMessageMock = vi.fn()
const sendMessageMock = vi.fn()
const ttsStopMock = vi.fn(async () => {
  sendMessageMock({
    action: 'TTS_STOP',
    context: 'tts-smart'
  })
  return true
})

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageCore: {
    get: vi.fn(async (keys) => {
      const state = globalThis.__pdfWindowsHostStorageState || {}

      if (typeof keys === 'string') {
        return { [keys]: state[keys] }
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]))
      }

      if (keys && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            state[key] ?? fallback
          ])
        )
      }

      return { ...state }
    }),
    set: storageSetMock,
    on: vi.fn(),
    off: vi.fn()
  }
}))

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    on: vi.fn((event, handler) => {
      eventHandlers[event] = handler
      const unsubscribe = vi.fn()
      unsubscribeMocks.push(unsubscribe)
      return unsubscribe
    }),
    emit: vi.fn(),
    off: vi.fn()
  }
}))

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: sendRegularMessageMock,
  sendMessage: sendMessageMock
}))

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {
    getI18nUtils: getI18nUtilsMock
  }
}))

const getEffectiveProviderAsyncMock = vi.fn(async () => 'googlev2')
const getTargetLanguageAsyncMock = vi.fn(async () => 'fa')

vi.mock('@/shared/config/config.js', () => ({
  TranslationMode: {
    PDF: 'pdf-translation',
    Selection: 'selection-manager',
    Dictionary_Translation: 'dictionary',
    LEGACY_DICTIONARY: 'legacy-dictionary'
  },
  getEffectiveProviderAsync: getEffectiveProviderAsyncMock,
  getSourceLanguageAsync: vi.fn(async () => 'auto'),
  getTargetLanguageAsync: getTargetLanguageAsyncMock
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key
  })
}))

vi.mock('@/composables/shared/useTextDirection.js', () => ({
  useTextDirection: (contentRef) => {
    const text = typeof contentRef?.value === 'string' ? contentRef.value : ''
    const rtlCount = (text.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length
    const direction = rtlCount > 0 ? 'rtl' : 'ltr'

    return {
      direction: ref(direction),
      textAlign: ref(direction === 'rtl' ? 'right' : 'left')
    }
  }
}))

vi.mock('@/composables/shared/useFont.js', () => ({
  useFont: () => ({
    fontStyles: ref({}),
    cssVariables: ref({})
  })
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => ({
    isDarkTheme: false,
    settings: {
      SHOW_TRANSLATE_ICON_IN_TOOLBAR: true,
      SHOW_TTS_ICON_IN_TOOLBAR: true
    }
  })
}))

vi.mock('@/components/shared/ActionToolbar.vue', () => ({
  default: {
    name: 'ActionToolbar',
    template: '<div class="action-toolbar-stub" />'
  }
}))

vi.mock('@/components/base/LoadingSpinner.vue', () => ({
  default: {
    name: 'LoadingSpinner',
    template: '<div class="loading-spinner-stub" />'
  }
}))

vi.mock('@/components/shared/TTSButton.vue', () => ({
  default: {
    name: 'TTSButton',
    props: ['text', 'language', 'disabled', 'isDictionary'],
    emits: ['tts-started', 'tts-stopped', 'tts-error', 'state-changed'],
    setup(_, { expose }) {
      const isPlaying = ref(false)

      const start = async () => {
        isPlaying.value = true
        return true
      }

      const stop = async () => {
        if (!isPlaying.value) {
          return true
        }

        isPlaying.value = false
        ttsStopMock()
        sendMessageMock({
          action: 'TTS_STOP',
          context: 'tts-smart'
        })
        return true
      }

      expose({
        start,
        stop
      })

      return {
        start,
        stop
      }
    },
    template: '<button class="tts-button-stub" :data-text="text" :data-language="language" :data-dictionary="isDictionary" :disabled="disabled" @click="start">{{ text }}</button>'
  }
}))

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: ['modelValue', 'mode', 'isGlobal', 'allowDefault', 'allowSetDefault', 'onlyConfigured', 'requiredFeature', 'disabled'],
    emits: ['update:modelValue', 'provider-change'],
    template: `
      <div
        class="provider-selector-stub"
        :data-mode="mode"
        :data-is-global="isGlobal"
        :data-allow-default="allowDefault"
        :data-allow-set-default="allowSetDefault"
        :data-only-configured="onlyConfigured"
        :data-required-feature="requiredFeature"
      >
        <select
          data-testid="translation-window-toolbar-provider-select"
          :value="modelValue"
          :disabled="disabled"
          @change="$emit('update:modelValue', $event.target.value)"
        >
          <option value="googlev2">googlev2</option>
          <option value="deepl">deepl</option>
          <option value="openai">openai</option>
        </select>
      </div>
    `
  }
}))

vi.mock('@/features/windows/composables/useWindowsManager.js', () => {
  windowsManagerImported = true
  return {
    useWindowsManager: vi.fn()
  }
})

const { default: PdfWindowsHost } = await import('./PdfWindowsHost.vue')
const { getErrorMessage } = await import('@/shared/error-management/ErrorMessages.js')

function emitSelection(detail) {
  eventHandlers['global-selection-change']?.(detail)
}

function emitSelectionClear(detail = {}) {
  eventHandlers['global-selection-clear']?.(detail)
}

async function showSelectionIcon(text, position = { x: 120, y: 180, width: 90, height: 18 }) {
  emitSelection({
    text,
    position,
    context: { source: 'pdf-viewer', isPdf: true }
  })
  await flushPromises()
}

async function openWindowFromSelectionIcon(wrapper) {
  const icon = wrapper.get('[data-testid="pdf-translation-icon"]')
  const translateButton = icon.get('.ti-icon-btn--translate')
  await translateButton.trigger('pointerdown')
  await flushPromises()
  await translateButton.trigger('click')
  await flushPromises()
}

async function openAndPinWindow(wrapper, text = 'Pinned result') {
  await showSelectionIcon(text)
  await openWindowFromSelectionIcon(wrapper)
  await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
  await flushPromises()
}

function mockVisibleHostHeight(wrapper, height) {
  const host = wrapper.get('[data-testid="pdf-windows-host"]')
  vi.spyOn(host.element, 'getBoundingClientRect').mockReturnValue({
    width: 320,
    height,
    top: 60,
    right: 360,
    bottom: 60 + height,
    left: 40,
    x: 40,
    y: 60
  })
  return host
}

async function clickSelectionTtsButton(wrapper) {
  const icon = wrapper.get('[data-testid="pdf-translation-icon"]')
  const buttons = icon.findAll('button')

  if (buttons.length < 2) {
    throw new Error('Expected both translate and TTS buttons to be rendered')
  }

  await buttons[1].trigger('click')
  await flushPromises()
}

function dispatchPointerEvent(target, type, options = {}) {
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...options
  }))
}

function dispatchOutsidePointerDown(options = {}) {
  if (typeof PointerEvent === 'function') {
    document.body.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: options.pointerType ?? 'mouse',
      isPrimary: options.isPrimary ?? true,
      button: options.button ?? 0,
      buttons: options.buttons ?? (options.button === 0 ? 1 : 0),
      clientX: options.clientX ?? 4,
      clientY: options.clientY ?? 4
    }))
    return
  }

  document.body.dispatchEvent(new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: options.button ?? 0,
    buttons: options.buttons ?? (options.button === 0 ? 1 : 0),
    clientX: options.clientX ?? 4,
    clientY: options.clientY ?? 4
  }))
}

describe('PdfWindowsHost', () => {
  let wrapper
  let addEventListenerSpy
  let removeEventListenerSpy
  let windowAddEventListenerSpy
  let windowRemoveEventListenerSpy
  let clipboardWriteTextMock

  async function openPendingTranslation(text = 'Pending translation') {
    let resolveTranslation
    sendRegularMessageMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranslation = resolve
    }))

    const operation = wrapper.vm.openTranslation({
      text,
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    await flushPromises()

    return {
      operation,
      request: sendRegularMessageMock.mock.calls.at(-1)[0],
      resolveTranslation
    }
  }

  function expectCancellationRequest(request, messageId) {
    expect(request).toEqual(expect.objectContaining({
      action: 'CANCEL_TRANSLATION',
      context: 'pdf-translation',
      data: expect.objectContaining({ messageId })
    }))
  }

  beforeEach(async () => {
    windowsManagerImported = false
    ttsStopMock.mockClear()
    globalThis.__pdfWindowsHostStorageState = {
      pdfWindowsHostLayout: {
        version: 1,
        global: {
          isPinned: false,
          dockMode: 'none',
          dockedWidth: 420,
          defaultPosition: { x: 72, y: 72 }
        },
        documents: {}
      }
    }
    sendRegularMessageMock.mockReset()
    sendRegularMessageMock.mockResolvedValue({ success: true, translatedText: 'Translated text' })
    sendMessageMock.mockReset()
    sendMessageMock.mockResolvedValue({ success: true })
    getEffectiveProviderAsyncMock.mockReset().mockResolvedValue('googlev2')
    getTargetLanguageAsyncMock.mockReset().mockResolvedValue('fa')
    storageSetMock.mockClear()

    Object.keys(eventHandlers).forEach((key) => {
      delete eventHandlers[key]
    })
    unsubscribeMocks.length = 0

    clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteTextMock
      }
    })

    addEventListenerSpy = vi.spyOn(document, 'addEventListener')
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
    windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener')
    windowRemoveEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
  })

  it('opens for PDF selection events and ignores non-PDF selections', async () => {
    let resolveTranslation
    sendRegularMessageMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranslation = resolve
    }))

    emitSelection({
      text: 'PDF text',
      position: { x: 120, y: 180, width: 90, height: 18 },
      context: { source: 'web-page', isPdf: false }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)

    await showSelectionIcon('PDF text')

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(sendRegularMessageMock).not.toHaveBeenCalled()

    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('.pdf-windows-host--loading').exists()).toBe(true)
    expect(wrapper.find('.pdf-windows-host--loading').element.style.minHeight).toBe('')
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="translation-window-toolbar"]').exists()).toBe(false)

    resolveTranslation({
      success: true,
      translatedText: 'Translated text'
    })
    await flushPromises()

    expect(wrapper.find('.pdf-windows-host--loading').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-toolbar"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Translated text')
  })

  it('opens direct supplied text in existing loading and translation flow without selection icon', async () => {
    let resolveTranslation
    sendRegularMessageMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranslation = resolve
    }))

    const operation = wrapper.vm.openTranslation({
      text: '  Region OCR text  ',
      position: { x: 40, y: 60, width: 120, height: 80, _isViewportRelative: true }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
    expect(wrapper.find('.pdf-windows-host--loading').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TRANSLATE',
      context: 'pdf-translation',
      data: expect.objectContaining({
        text: 'Region OCR text',
        mode: 'selection-manager'
      })
    }))

    resolveTranslation({ success: true, translatedText: 'Region translated' })
    await operation
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Region translated')
  })

  it('does not dispatch stale settings resolution after a new selection', async () => {
    wrapper.unmount()
    const staleProvider = deferred()
    getEffectiveProviderAsyncMock
      .mockResolvedValueOnce('')
      .mockImplementationOnce(() => staleProvider.promise)
      .mockResolvedValueOnce('')
    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()

    const staleOperation = wrapper.vm.openTranslation({
      text: 'Stale selection',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    await flushPromises()
    const currentOperation = wrapper.vm.openTranslation({
      text: 'Current selection',
      position: { x: 80, y: 100, width: 120, height: 80 }
    })
    await currentOperation
    await flushPromises()

    expect(sendRegularMessageMock).toHaveBeenCalledOnce()
    expect(sendRegularMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ text: 'Current selection' })
    }))

    staleProvider.resolve('stale-provider')
    await expect(staleOperation).resolves.toBe(true)
    await flushPromises()

    expect(sendRegularMessageMock).toHaveBeenCalledOnce()
    expect(wrapper.findComponent({ name: 'TranslationWindowToolbar' }).props('provider')).toBe('')
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(false)
  })

  it('does not dispatch stale provider resolution after window close', async () => {
    wrapper.unmount()
    const staleProvider = deferred()
    getEffectiveProviderAsyncMock
      .mockResolvedValueOnce('')
      .mockImplementationOnce(() => staleProvider.promise)
      .mockResolvedValueOnce('')
    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()

    wrapper.vm.openTranslation({
      text: 'Stale provider close',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    wrapper.vm.dismissHost()

    staleProvider.resolve('stale-provider')
    await flushPromises()

    expect(sendRegularMessageMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('does not dispatch stale provider resolution after PDF replacement', async () => {
    wrapper.unmount()
    const staleProvider = deferred()
    getEffectiveProviderAsyncMock
      .mockResolvedValueOnce('')
      .mockImplementationOnce(() => staleProvider.promise)
      .mockResolvedValueOnce('')
    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()

    wrapper.vm.openTranslation({
      text: 'Stale provider replace',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    await wrapper.setProps({ pdfFingerprint: 'pdf-doc-2' })

    staleProvider.resolve('stale-provider')
    await flushPromises()

    expect(sendRegularMessageMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('cancels the active translation request when the window closes', async () => {
    await wrapper.vm.openTranslation({
      text: 'Close replacement',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    await wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').setValue('deepl')
    await flushPromises()
    const pendingRequest = sendRegularMessageMock.mock.calls[1][0]

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expectCancellationRequest(sendRegularMessageMock.mock.calls[2][0], pendingRequest.messageId)
    pending.resolve({ success: true, translatedText: 'Late result' })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('cancels the previous request before opening a new Region OCR translation', async () => {
    const pending = await openPendingTranslation('Old Region OCR text')

    await wrapper.vm.openTranslation({
      text: 'Current Region OCR text',
      position: { x: 80, y: 100, width: 120, height: 80 }
    })
    await flushPromises()

    expectCancellationRequest(sendRegularMessageMock.mock.calls[1][0], pending.request.messageId)
    expect(sendRegularMessageMock.mock.calls[2][0]).toEqual(expect.objectContaining({
      action: 'TRANSLATE',
      data: expect.objectContaining({ text: 'Current Region OCR text' })
    }))
    pending.resolveTranslation({ success: true, translatedText: 'Stale result' })
    await pending.operation
    expect(wrapper.text()).not.toContain('Stale result')
  })

  it('cancels the active translation request before provider replacement', async () => {
    await wrapper.vm.openTranslation({
      text: 'Provider replacement',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    await wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').setValue('deepl')
    await flushPromises()
    const pendingRequest = sendRegularMessageMock.mock.calls[1][0]

    await wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').setValue('openai')
    await flushPromises()

    expectCancellationRequest(sendRegularMessageMock.mock.calls[2][0], pendingRequest.messageId)
    pending.resolve({ success: true, translatedText: 'Stale provider result' })
    await flushPromises()
  })

  it('cancels the active translation request on PDF fingerprint replacement', async () => {
    const pending = await openPendingTranslation()

    await wrapper.setProps({ pdfFingerprint: 'pdf-doc-2' })
    await flushPromises()

    expectCancellationRequest(sendRegularMessageMock.mock.calls[1][0], pending.request.messageId)
    pending.resolveTranslation({ success: true, translatedText: 'Late result' })
    await pending.operation
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('cancels the active translation request on host unmount', async () => {
    const pending = await openPendingTranslation()

    wrapper.unmount()
    wrapper = null
    await flushPromises()

    expectCancellationRequest(sendRegularMessageMock.mock.calls[1][0], pending.request.messageId)
    pending.resolveTranslation({ success: true, translatedText: 'Late result' })
    await pending.operation
  })

  it('keeps window invalidation intact when cancellation transport fails', async () => {
    await wrapper.vm.openTranslation({
      text: 'Cancellation transport',
      position: { x: 40, y: 60, width: 120, height: 80 }
    })
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    await wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').setValue('deepl')
    await flushPromises()
    sendRegularMessageMock.mockRejectedValueOnce(new Error('Cancellation transport failed'))

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    pending.resolve({ success: true, translatedText: 'Late result' })
    await flushPromises()
  })

  it('keeps the selection icon transition alive until the icon click opens the window', async () => {
    await showSelectionIcon('Transition me')

    const icon = wrapper.get('[data-testid="pdf-translation-icon"]')
    const translateButton = icon.get('.ti-icon-btn--translate')
    await translateButton.trigger('pointerdown')
    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)

    await translateButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the icon alive for toolbar-surface pointerdown and preserves the normal icon click action', async () => {
    await showSelectionIcon('Toolbar surface')

    const icon = wrapper.get('[data-testid="pdf-translation-icon"]')
    const translateButton = icon.get('.ti-icon-btn--translate')

    dispatchPointerEvent(translateButton.element, 'pointerdown', { button: 0, buttons: 1 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)

    await translateButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
  })

  it('dismisses the icon-only toolbar from transparent stage, PDF toolbar, and application chrome clicks', async () => {
    await showSelectionIcon('Transparent stage')

    dispatchPointerEvent(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').element, 'pointerdown', { button: 0, buttons: 1 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)

    const pdfToolbar = document.createElement('header')
    pdfToolbar.className = 'pdf-toolbar'
    document.body.appendChild(pdfToolbar)

    await showSelectionIcon('PDF toolbar click')
    dispatchPointerEvent(pdfToolbar, 'pointerdown', { button: 0, buttons: 1 })
    pdfToolbar.remove()
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)

    await showSelectionIcon('Application chrome click')
    dispatchOutsidePointerDown({ button: 0 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
  })

  it('speaks selected text from the selection icon without opening the translation window', async () => {
    await showSelectionIcon('Speak before open')

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    await clickSelectionTtsButton(wrapper)

    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      context: 'tts-smart',
      action: expect.any(String),
      data: expect.objectContaining({
        text: 'Speak before open',
        language: 'auto'
      })
    }))
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(sendRegularMessageMock).not.toHaveBeenCalled()
  })

  it('stops selection-stage TTS when the PDF icon is dismissed or replaced, but not when it transitions into the window', async () => {
    await showSelectionIcon('Dismiss speak')
    await clickSelectionTtsButton(wrapper)

    const hasTtsStopCall = () => sendMessageMock.mock.calls.some(([message]) => message?.action === 'TTS_STOP')

    sendMessageMock.mockClear()

    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(hasTtsStopCall()).toBe(true)

    sendMessageMock.mockClear()

    await showSelectionIcon('Transition speak')
    await clickSelectionTtsButton(wrapper)
    sendMessageMock.mockClear()

    const translateButton = wrapper.get('[data-testid="pdf-translation-icon"]').get('.ti-icon-btn--translate')
    await translateButton.trigger('pointerdown')
    await flushPromises()
    await translateButton.trigger('click')
    await flushPromises()

    expect(hasTtsStopCall()).toBe(false)

    sendMessageMock.mockClear()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(hasTtsStopCall()).toBe(true)

    sendMessageMock.mockClear()

    await showSelectionIcon('Replaced speak')
    await clickSelectionTtsButton(wrapper)
    sendMessageMock.mockClear()

    await showSelectionIcon('Replaced speak next', { x: 160, y: 220, width: 90, height: 18 })
    await flushPromises()

    expect(hasTtsStopCall()).toBe(true)
  })

  it('stops window TTS when the PDF window is dismissed', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Translated text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Window speak')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="translation-window-toolbar-tts"]').trigger('click')
    await flushPromises()

    ttsStopMock.mockClear()
    sendMessageMock.mockClear()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TTS_STOP',
      context: 'tts-smart'
    }))
  })

  it('does not send a redundant TTS stop when the PDF window is dismissed while idle', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Translated text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Idle window')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    ttsStopMock.mockClear()
    sendMessageMock.mockClear()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(ttsStopMock).not.toHaveBeenCalled()
    expect(sendMessageMock.mock.calls.some(([message]) => message?.action === 'TTS_STOP')).toBe(false)
  })

  it('stops visible window TTS once when a new selection replaces the window', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Translated text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Replace window')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="translation-window-toolbar-tts"]').trigger('click')
    await flushPromises()

    ttsStopMock.mockClear()
    sendMessageMock.mockClear()

    await showSelectionIcon('Replacement text', { x: 190, y: 240, width: 110, height: 18 })
    await flushPromises()

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TTS_STOP',
      context: 'tts-smart'
    }))
  })

  it('toggles the original source text visibility and switches TTS input between source and translated text', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Translated result',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Toggle me')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('Translated result')

    await wrapper.get('[data-testid="translation-window-toolbar-original"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(true)
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('Toggle me')

    await wrapper.get('[data-testid="translation-window-toolbar-copy"]').trigger('click')
    await flushPromises()

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('Translated result')
    expect(clipboardWriteTextMock).not.toHaveBeenCalledWith('Toggle me')

    await wrapper.get('[data-testid="translation-window-toolbar-original"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('Translated result')
    expect(storageSetMock).not.toHaveBeenCalled()
  })

  it('renders the detected language badge after a successful translation', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Detected language result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Detect me')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const badge = wrapper.get('[data-testid="translation-window-footer-detected-language"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('English')
  })

  it('renders the target language badge after translation and updates it on the next translation when the target language changes', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Target language result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Target me')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    const targetBadge = wrapper.get('[data-testid="translation-window-footer-target-language"]')
    expect(targetBadge.exists()).toBe(true)
    expect(targetBadge.text()).toBe('Persian')

    await wrapper.setProps({ pdfTargetLanguage: 'ja' })
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Updated target result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Target update me', { x: 150, y: 210, width: 90, height: 18 })
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Japanese')
  })

  it('hides the target language badge for auto or unknown target language values', async () => {
    wrapper.unmount()
    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'auto'
      },
      attachTo: document.body
    })
    await flushPromises()

    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Auto target result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Auto target')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-footer-target-language"]').exists()).toBe(false)

    wrapper.unmount()
    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'xx-unknown'
      },
      attachTo: document.body
    })
    await flushPromises()

    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Unknown target result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Unknown target')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-footer-target-language"]').exists()).toBe(false)
  })

  it('prefers detectedSourceLanguage over sourceLanguage when rendering the badge', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Preferred detected result',
      sourceLanguage: 'en',
      detectedSourceLanguage: 'fa',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Prefer me')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const badge = wrapper.get('[data-testid="translation-window-footer-detected-language"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('Persian')
  })

  it('hides the detected language badge for missing or auto source language values', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Auto source result',
      sourceLanguage: 'auto',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Auto me')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)
  })

  it('hides the detected language badge for unknown or invalid source language values', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Unknown source result',
      sourceLanguage: 'xx-unknown',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Unknown me')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)
  })

  it('resets the original text toggle on a new selection', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Translated once',
      mode: 'selection-manager'
    })

    await showSelectionIcon('First selection')
    await openWindowFromSelectionIcon(wrapper)
    await wrapper.get('[data-testid="translation-window-toolbar-original"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(true)

    await showSelectionIcon('Second selection', { x: 140, y: 200, width: 90, height: 18 })
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    await openWindowFromSelectionIcon(wrapper)
    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(false)
    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('Translated text')
  })

  it('initializes the local provider switcher from PDF provider resolution', async () => {
    wrapper.unmount()
    wrapper = null
    getEffectiveProviderAsyncMock.mockClear()
    getEffectiveProviderAsyncMock.mockResolvedValueOnce('deepl')

    wrapper = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await showSelectionIcon('Initial provider')

    expect(getEffectiveProviderAsyncMock).toHaveBeenCalledWith('selection-manager')
    expect(wrapper.find('[data-testid="translation-window-toolbar-provider-selector"]').exists()).toBe(false)

    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-selector"]').attributes('data-mode')).toBe('icon-only')
    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-selector"]').attributes('data-is-global')).toBe('false')
    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-selector"]').attributes('data-allow-default')).toBe('false')
    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-selector"]').attributes('data-allow-set-default')).toBe('false')
    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').element.value).toBe('deepl')
  })

  it('does not render explicit dock buttons', async () => {
    await showSelectionIcon('No dock buttons')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="pdf-windows-host-dock-left"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-dock-right"]').exists()).toBe(false)
  })

  it('auto-retranslates the visible selection when the provider changes and clears stale state', async () => {
    sendRegularMessageMock
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Provider initial result',
        sourceLanguage: 'en',
        mode: 'selection-manager'
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        sendRegularMessageMock.__resolveProviderChange = resolve
      }))

    await showSelectionIcon('Provider switch')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Provider initial result')
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('English')
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')

    const providerSelect = wrapper.get('[data-testid="translation-window-toolbar-provider-select"]')
    await providerSelect.setValue('deepl')
    await flushPromises()

    expect(providerSelect.element.value).toBe('deepl')
    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(2)
    expect(storageSetMock).not.toHaveBeenCalled()
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout).toBeDefined()
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')

    sendRegularMessageMock.__resolveProviderChange({
      success: true,
      translatedText: 'Provider updated result',
      sourceLanguage: 'fa',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Provider updated result')
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('Persian')
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')
    expect(sendRegularMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provider: 'deepl',
        text: 'Provider switch',
        mode: 'selection-manager'
      })
    }))
  })

  it('handles provider-change events with the same local-only handler and retriggers translation', async () => {
    sendRegularMessageMock
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Provider contract result',
        sourceLanguage: 'en',
        mode: 'selection-manager'
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        sendRegularMessageMock.__resolveProviderContract = resolve
      }))

    await showSelectionIcon('Provider contract')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const providerSelector = wrapper.findComponent({ name: 'ProviderSelector' })
    providerSelector.vm.$emit('provider-change', 'openai')
    await flushPromises()

    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').element.value).toBe('openai')
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(2)

    sendRegularMessageMock.__resolveProviderContract({
      success: true,
      translatedText: 'Provider contract updated',
      sourceLanguage: 'fa',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Provider contract updated')
    expect(storageSetMock).not.toHaveBeenCalled()
  })

  it('retranslates immediately when the provider changes during an active translation request', async () => {
    let resolveInitialTranslation
    let resolvePendingProviderTranslation
    sendRegularMessageMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveInitialTranslation = resolve
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolvePendingProviderTranslation = resolve
      }))
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Latest provider result',
        sourceLanguage: 'fa',
        mode: 'selection-manager'
      })

    await showSelectionIcon('In-flight provider switch')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('.pdf-windows-host--loading').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)

    resolveInitialTranslation({
      success: true,
      translatedText: 'Initial provider result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Initial provider result')

    const providerSelector = wrapper.findComponent({ name: 'ProviderSelector' })
    providerSelector.vm.$emit('provider-change', 'deepl')
    await flushPromises()

    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').element.value).toBe('deepl')
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)

    providerSelector.vm.$emit('provider-change', 'openai')
    await flushPromises()

    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').element.value).toBe('openai')
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(4)
    expect(sendRegularMessageMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
      data: expect.objectContaining({ provider: 'openai' })
    }))
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Latest provider result')

    resolvePendingProviderTranslation({
      success: true,
      translatedText: 'Stale in-flight result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Latest provider result')
    expect(wrapper.text()).not.toContain('Stale in-flight result')
  })

  it('does not auto-translate while only the icon stage is visible', async () => {
    await showSelectionIcon('Icon stage only')
    sendRegularMessageMock.mockClear()

    await wrapper.vm.handleProviderChange('deepl')
    await flushPromises()

    expect(sendRegularMessageMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('renders normal markdown translation results through SafeMarkdownPreview and cleans copy/TTS input', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Normal **bold** text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Hello PDF')
    await openWindowFromSelectionIcon(wrapper)

    expect(sendRegularMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TRANSLATE',
      context: 'pdf-translation',
      data: expect.objectContaining({
        text: 'Hello PDF',
        provider: 'googlev2',
        sourceLanguage: 'auto',
        targetLanguage: 'fa',
        mode: 'selection-manager',
        isExplicitProvider: true
      })
    }))
    expect(sendRegularMessageMock.mock.calls[0][0].data.enableDictionary).toBeUndefined()
    expect(getEffectiveProviderAsyncMock).toHaveBeenCalledWith('selection-manager')
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(false)
    const result = wrapper.get('[data-testid="pdf-windows-host-result"]')
    expect(result.find('.simple-markdown').exists()).toBe(true)
    expect(result.text()).toContain('Normal')
    expect(result.text()).toContain('bold')
    expect(result.text()).not.toContain('**')
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-dictionary')).toBe('false')
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('Normal **bold** text')

    await wrapper.get('[data-testid="translation-window-toolbar-copy"]').trigger('click')
    await flushPromises()

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('Normal bold text')
  })

  it('keeps the footer visible when a long translation is rendered', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n'),
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Long body')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="translation-window-footer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-retry"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-target-language"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(true)
    expect(wrapper.find('.pdf-windows-host__body').exists()).toBe(true)
    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).not.toContain('pdf-windows-host--docked')
  })

  it('keeps shared TranslationDisplay toolbar actions out of PdfWindowsHost while preserving PDF-local actions', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Toolbar parity check',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Toolbar check')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('.action-toolbar-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="translation-window-toolbar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-toolbar-copy"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-retry"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="translation-window-footer-retry"]').text().trim()).toBe('')
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="translation-window-footer-target-language"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-toolbar-tts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-toolbar-provider-selector"]').exists()).toBe(true)
  })

  it('uses the currently selected local provider for the next translation and retry actions', async () => {
    sendRegularMessageMock.mockResolvedValue({
      success: true,
      translatedText: 'Translated with local provider',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Provider selected text')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').setValue('deepl')
    await flushPromises()
    sendRegularMessageMock.mockClear()

    await showSelectionIcon('Provider selected text 2', { x: 150, y: 210, width: 90, height: 18 })
    await flushPromises()
    await openWindowFromSelectionIcon(wrapper)

    expect(sendRegularMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provider: 'deepl',
        mode: 'selection-manager'
      })
    }))

    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Retry with selected provider',
      mode: 'selection-manager'
    })

    await wrapper.get('[data-testid="translation-window-footer-retry"]').trigger('click')
    await flushPromises()

    expect(sendRegularMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provider: 'deepl',
        mode: 'selection-manager'
      })
    }))
  })

  it('clears stale translation state and retriggers translation when the provider changes', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Stale result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })
    let resolveProviderChange
    sendRegularMessageMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProviderChange = resolve
    }))

    await showSelectionIcon('Clear me')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').text()).toContain('Stale result')
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('English')
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')

    const providerSelector = wrapper.findComponent({ name: 'ProviderSelector' })
    providerSelector.vm.$emit('update:modelValue', 'deepl')
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="translation-window-toolbar-provider-select"]').element.value).toBe('deepl')
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(false)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(2)

    resolveProviderChange({
      success: true,
      translatedText: 'Translated after provider change',
      sourceLanguage: 'fa',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Translated after provider change')
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('Persian')
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')
  })

  it('keeps the window open for teleported provider dropdown interactions and retriggers translation', async () => {
    sendRegularMessageMock
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Dropdown initial result',
        sourceLanguage: 'en',
        mode: 'selection-manager'
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        sendRegularMessageMock.__resolveDropdownProviderChange = resolve
      }))

    await showSelectionIcon('Dropdown provider selection')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const dropdownMenu = document.createElement('div')
    dropdownMenu.className = 'ti-provider-dropdown-menu'
    const dropdownList = document.createElement('div')
    dropdownList.className = 'ti-provider-dropdown-list'
    const dropdownItem = document.createElement('button')
    dropdownItem.type = 'button'
    dropdownItem.className = 'ti-dropdown-item'
    dropdownList.appendChild(dropdownItem)
    dropdownMenu.appendChild(dropdownList)
    document.body.appendChild(dropdownMenu)

    dropdownItem.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true
    }))
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    const providerSelector = wrapper.findComponent({ name: 'ProviderSelector' })
    providerSelector.vm.$emit('provider-change', 'deepl')
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(2)

    sendRegularMessageMock.__resolveDropdownProviderChange({
      success: true,
      translatedText: 'Dropdown provider updated',
      sourceLanguage: 'fa',
      mode: 'selection-manager'
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').text()).toContain('Dropdown provider updated')
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('Persian')

    document.body.removeChild(dropdownMenu)
  })

  it('keeps the PDF window open when toolbar TTS starts while the original PDF selection is still active', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Selection still active',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Active selection')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const ttsButton = wrapper.get('[data-testid="translation-window-toolbar-tts"]')
    ttsButton.element.focus()
    await ttsButton.trigger('pointerdown')
    await ttsButton.trigger('click')
    await flushPromises()

    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(ttsStopMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TTS_STOP',
      context: 'tts-smart'
    }))
  })

  it('keeps the visible PDF window open when the browser window blurs while toolbar TTS is active', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Blur safe result',
      sourceLanguage: 'en',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Blur safe selection')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="translation-window-toolbar-tts"]').trigger('click')
    await flushPromises()

    window.dispatchEvent(new Event('blur'))
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(ttsStopMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the PDF translation icon visible when the browser window blurs before the window opens', async () => {
    await showSelectionIcon('Icon blur selection')

    window.dispatchEvent(new Event('blur'))
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('keeps plain text output readable through SafeMarkdownPreview', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Plain translated text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Plain source')
    await openWindowFromSelectionIcon(wrapper)

    const result = wrapper.get('[data-testid="pdf-windows-host-result"]')
    expect(result.find('.simple-markdown').exists()).toBe(true)
    expect(result.text()).toBe('Plain translated text')
  })

  it('renders dictionary-formatted translation results without raw markdown artifacts', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: '**Noun**: hello\n- a greeting',
      mode: 'dictionary'
    })

    await showSelectionIcon('hello')
    await openWindowFromSelectionIcon(wrapper)

    const result = wrapper.get('[data-testid="pdf-windows-host-result"]')
    expect(result.find('.simple-markdown').exists()).toBe(true)
    expect(result.text()).toContain('Noun')
    expect(result.text()).toContain('hello')
    expect(result.text()).toContain('a greeting')
    expect(result.text()).not.toContain('**')
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-dictionary')).toBe('true')
    expect(wrapper.get('[data-testid="translation-window-toolbar-tts"]').attributes('data-text')).toBe('**Noun**: hello\n- a greeting')
  })

  it('renders errors and retries using the current selected text', async () => {
    sendRegularMessageMock
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'Provider unavailable' }
      })
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Recovered result'
      })

    await showSelectionIcon('Retry me')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').text()).toContain(await getErrorMessage('ERRORS_TRANSLATION_FAILED'))
    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').text()).not.toContain('Provider unavailable')

    await wrapper.get('[data-testid="translation-window-footer-retry"]').trigger('click')
    await flushPromises()

    expect(sendRegularMessageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        text: 'Retry me'
      })
    }))
    expect(sendRegularMessageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        text: 'Retry me'
      })
    }))
    expect(wrapper.find('[data-testid="pdf-windows-host-result"]').text()).toContain('Recovered result')
  })

  it('renders structured MODEL_MISSING failures as safe localized errors without raw diagnostics', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'MODEL_MISSING',
        message: 'raw provider model detail: gemini-2.5-flash not found for key acct_12345'
      }
    })

    await showSelectionIcon('Model check')
    await openWindowFromSelectionIcon(wrapper)

    const error = wrapper.get('[data-testid="pdf-windows-host-error"]')
    expect(error.text()).toContain(await getErrorMessage('ERRORS_MODEL_MISSING'))
    expect(error.text()).not.toContain('gemini-2.5-flash')
    expect(error.text()).not.toContain('acct_12345')
  })

  it('hides retry for deterministic HTTP translation failures', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: false,
      error: { type: 'HTTP_ERROR', statusCode: 404, message: 'HTTP 404' },
    })

    await showSelectionIcon('HTTP failure')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="translation-window-footer-retry"]').exists()).toBe(false)
  })

  it('never renders raw API provider response bodies', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'API_ERROR',
        statusCode: 502,
        message: 'Provider said: upstream 502 with body {\\"error\\":\\"private payload\\"}'
      }
    })

    await showSelectionIcon('Api check')
    await openWindowFromSelectionIcon(wrapper)

    const error = wrapper.get('[data-testid="pdf-windows-host-error"]')
    expect(error.text()).toContain(await getErrorMessage('ERRORS_API_ERROR'))
    expect(error.text()).not.toContain('502')
    expect(error.text()).not.toContain('private payload')
    expect(error.text()).not.toContain('Provider said')
  })

  it('prefers errorDetails over the legacy error string', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: false,
      error: 'raw legacy provider string',
      errorDetails: {
        type: 'QUOTA_EXCEEDED',
        message: 'raw quota detail'
      }
    })

    await showSelectionIcon('Precedence check')
    await openWindowFromSelectionIcon(wrapper)

    const error = wrapper.get('[data-testid="pdf-windows-host-error"]')
    expect(error.text()).toContain(await getErrorMessage('ERRORS_QUOTA_EXCEEDED'))
    expect(error.text()).not.toContain('raw legacy provider string')
    expect(error.text()).not.toContain('raw quota detail')
  })

  it('keeps user cancellation silent in the windows host', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: false,
      error: { type: 'USER_CANCELLED', message: 'Translation cancelled by user' }
    })

    await showSelectionIcon('Cancel check')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="pdf-windows-host-error"]').exists()).toBe(false)
  })

  it('preserves raw presentation for local operational errors', async () => {
    sendRegularMessageMock.mockRejectedValueOnce(new Error('local windows host failure'))

    await showSelectionIcon('Local error')
    await openWindowFromSelectionIcon(wrapper)

    const error = wrapper.get('[data-testid="pdf-windows-host-error"]')
    expect(error.text()).toContain('local windows host failure')
  })

  it('updates the detected language badge on retry using the latest response', async () => {
    sendRegularMessageMock
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'Provider unavailable' }
      })
      .mockResolvedValueOnce({
        success: true,
        translatedText: 'Recovered result',
        detectedSourceLanguage: 'fa'
      })

    await showSelectionIcon('Retry badge')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').exists()).toBe(false)

    await wrapper.get('[data-testid="translation-window-footer-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('Persian')
    expect(wrapper.get('[data-testid="translation-window-footer-target-language"]').text()).toBe('Persian')
  })

  it('copies a normal markdown translation as cleaned plain text', async () => {
    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Copy **this** text',
      mode: 'selection-manager'
    })

    await showSelectionIcon('Copy me')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-copy"]').trigger('click')
    await flushPromises()

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('Copy this text')
  })

  it('pins the window so outside clicks and clear events do not dismiss it until unpinned', async () => {
    await showSelectionIcon('Pin me')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()

    document.body.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 4,
      clientY: 4
    }))
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()

    document.body.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 4,
      clientY: 4
    }))
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('keeps pinned window position when a new PDF selection updates its translation', async () => {
    await showSelectionIcon('Pinned first selection', { x: 120, y: 180, width: 90, height: 18 })
    await openWindowFromSelectionIcon(wrapper)
    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()

    const host = wrapper.get('[data-testid="pdf-windows-host"]')
    const initialPosition = {
      left: host.element.style.left,
      top: host.element.style.top
    }
    sendRegularMessageMock.mockResolvedValueOnce({ success: true, translatedText: 'Pinned second result' })

    emitSelection({
      text: 'Pinned second selection',
      position: { x: 760, y: 520, width: 90, height: 18 },
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(host.element.style.left).toBe(initialPosition.left)
    expect(host.element.style.top).toBe(initialPosition.top)
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Pinned second result')
  })

  it('reanchors floating window to the latest selection', async () => {
    await showSelectionIcon('Floating first selection', { x: 120, y: 180, width: 90, height: 18 })
    await openWindowFromSelectionIcon(wrapper)

    const firstHost = wrapper.get('[data-testid="pdf-windows-host"]')
    const initialPosition = {
      left: firstHost.element.style.left,
      top: firstHost.element.style.top
    }
    sendRegularMessageMock.mockResolvedValueOnce({ success: true, translatedText: 'Floating second result' })

    await showSelectionIcon('Floating second selection', { x: 760, y: 520, width: 90, height: 18 })
    await openWindowFromSelectionIcon(wrapper)

    const secondHost = wrapper.get('[data-testid="pdf-windows-host"]')
    expect({
      left: secondHost.element.style.left,
      top: secondHost.element.style.top
    }).not.toEqual(initialPosition)
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Floating second result')
  })

  it('keeps manually dragged pinned window position when a new PDF selection arrives', async () => {
    await showSelectionIcon('Dragged first selection', { x: 120, y: 180, width: 90, height: 18 })
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 340, clientY: 280 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 340, clientY: 280 })
    await flushPromises()

    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()

    const host = wrapper.get('[data-testid="pdf-windows-host"]')
    const draggedPosition = {
      left: host.element.style.left,
      top: host.element.style.top
    }
    sendRegularMessageMock.mockResolvedValueOnce({ success: true, translatedText: 'Dragged second result' })

    emitSelection({
      text: 'Dragged second selection',
      position: { x: 760, y: 520, width: 90, height: 18 },
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(host.element.style.left).toBe(draggedPosition.left)
    expect(host.element.style.top).toBe(draggedPosition.top)
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Dragged second result')
  })

  it('preserves visible pinned host height while a replacement selection loads', async () => {
    await openAndPinWindow(wrapper, 'Pinned original')
    const host = mockVisibleHostHeight(wrapper, 260)
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    emitSelection({
      text: 'Pinned replacement',
      position: { x: 140, y: 200, width: 90, height: 18 },
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()

    expect(host.element.style.minHeight).toBe('260px')
    expect(wrapper.get('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Pinned original')

    pending.resolve({ success: true, translatedText: 'Pinned replacement result' })
    await flushPromises()

    expect(host.element.style.minHeight).toBe('')
    expect(wrapper.get('[data-testid="pdf-windows-host-result"]').text()).toContain('Pinned replacement result')
  })

  it('clears pinned loading height after a replacement selection fails', async () => {
    await openAndPinWindow(wrapper, 'Pinned original')
    const host = mockVisibleHostHeight(wrapper, 240)
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    emitSelection({
      text: 'Pinned failing replacement',
      position: { x: 140, y: 200, width: 90, height: 18 },
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()
    expect(host.element.style.minHeight).toBe('240px')

    pending.resolve({ success: false, error: { message: 'Provider unavailable' } })
    await flushPromises()

    expect(host.element.style.minHeight).toBe('')
    expect(wrapper.get('[data-testid="pdf-windows-host-error"]').text()).toContain(await getErrorMessage('ERRORS_TRANSLATION_FAILED'))
    expect(wrapper.get('[data-testid="pdf-windows-host-error"]').text()).not.toContain('Provider unavailable')
  })

  it('clears pinned loading height when a pending replacement is dismissed', async () => {
    await openAndPinWindow(wrapper, 'Pinned original')
    mockVisibleHostHeight(wrapper, 220)
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    emitSelection({
      text: 'Pinned dismissed replacement',
      position: { x: 140, y: 200, width: 90, height: 18 },
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.minHeight).toBe('220px')

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    sendRegularMessageMock.mockClear()
    sendRegularMessageMock.mockResolvedValue({ success: true, translatedText: 'Reopened result' })
    await showSelectionIcon('Pinned reopened')
    await openWindowFromSelectionIcon(wrapper)

    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.minHeight).toBe('')

    pending.resolve({ success: true, translatedText: 'Late result' })
    await flushPromises()
  })

  it('does not preserve height for visible non-pinned direct translations', async () => {
    await showSelectionIcon('Floating original')
    await openWindowFromSelectionIcon(wrapper)
    const host = mockVisibleHostHeight(wrapper, 240)
    const pending = deferred()
    sendRegularMessageMock.mockImplementationOnce(() => pending.promise)

    wrapper.vm.openTranslation({
      text: 'Region OCR replacement',
      position: { x: 140, y: 200, width: 90, height: 18 }
    })
    await flushPromises()

    expect(host.element.style.minHeight).toBe('')

    pending.resolve({ success: true, translatedText: 'Region OCR result' })
    await flushPromises()
  })

  it('shows the icon first when the window is pinned but currently closed', async () => {
    await showSelectionIcon('Pinned closed')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    sendRegularMessageMock.mockClear()

    await showSelectionIcon('Pinned closed again', { x: 140, y: 200, width: 90, height: 18 })

    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(sendRegularMessageMock).not.toHaveBeenCalled()

    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(1)
  })

  it('docks by dragging near viewport edges and clamps dock resize width', async () => {
    await showSelectionIcon('Dock me')
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 4, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 4, clientY: 210 })
    await flushPromises()
    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).toContain('pdf-windows-host--dock-left')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.minHeight).toBe('')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.left).toBe('0px')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.top).toBe('0px')
    expect(wrapper.find('[data-testid="pdf-windows-host-resize-handle"]').exists()).toBe(true)

    const resizeHandle = wrapper.get('[data-testid="pdf-windows-host-resize-handle"]')
    dispatchPointerEvent(resizeHandle.element, 'pointerdown', { clientX: 420, clientY: 40 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 2000, clientY: 40 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 2000, clientY: 40 })
    await flushPromises()

    const dockedWidth = Number.parseInt(wrapper.get('[data-testid="pdf-windows-host"]').element.style.width, 10)
    const expectedMaxDockedWidth = Math.max(280, Math.floor((document.documentElement.clientWidth || window.innerWidth || 0) * 0.8))
    expect(dockedWidth).toBeLessThanOrEqual(expectedMaxDockedWidth)
    expect(dockedWidth).toBeGreaterThanOrEqual(280)

    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 20, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 540, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 540, clientY: 210 })
    await flushPromises()
    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).not.toContain('pdf-windows-host--dock-left')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).not.toContain('pdf-windows-host--dock-right')

    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 520, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: window.innerWidth - 4, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: window.innerWidth - 4, clientY: 210 })
    await flushPromises()
    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).toContain('pdf-windows-host--dock-right')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.right).toBe('0px')
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.top).toBe('0px')
  })

  it('starts dragging from empty header space', async () => {
    await showSelectionIcon('Header drag')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const host = wrapper.get('[data-testid="pdf-windows-host"]')
    const header = wrapper.get('.pdf-windows-host__header')
    const initialLeft = host.element.style.left

    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 300, clientY: 190 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 340, clientY: 220 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 340, clientY: 220 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.left).not.toBe(initialLeft)
  })

  it('keeps toolbar controls clickable at minimum docked width', async () => {
    await showSelectionIcon('Toolbar minimum width')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 4, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 4, clientY: 210 })
    await flushPromises()

    const dockHandle = wrapper.get('[data-testid="pdf-windows-host-resize-handle"]')
    dispatchPointerEvent(dockHandle.element, 'pointerdown', { clientX: 4, clientY: 40 })
    dispatchPointerEvent(document, 'pointermove', { clientX: -2000, clientY: 40 })
    dispatchPointerEvent(document, 'pointerup', { clientX: -2000, clientY: 40 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).toContain('pdf-windows-host--dock-left')

    await wrapper.get('[data-testid="translation-window-toolbar-original"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(true)
    expect(wrapper.get('[data-testid="translation-window-toolbar-original"]').classes()).toContain('ti-original-visible')
  })

  it('keeps the dock mode unchanged while dragging within the breakaway threshold and retains the resize handle', async () => {
    await showSelectionIcon('Stable dock')
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 4, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 4, clientY: 210 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).toContain('pdf-windows-host--dock-left')
    expect(wrapper.find('[data-testid="pdf-windows-host-resize-handle"]').exists()).toBe(true)

    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 20, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 72, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 72, clientY: 210 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host"]').classes()).toContain('pdf-windows-host--dock-left')
    expect(wrapper.find('[data-testid="pdf-windows-host-resize-handle"]').exists()).toBe(true)
  })

  it('translates directly without the icon when docked', async () => {
    await showSelectionIcon('Dock direct')
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 4, clientY: 210 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 4, clientY: 210 })
    await flushPromises()
    sendRegularMessageMock.mockClear()

    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Docked translation',
      sourceLanguage: 'en'
    })

    await showSelectionIcon('Dock direct updated')
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    await flushPromises()
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="translation-window-footer-detected-language"]').text()).toBe('English')
  })

  it('translates directly when a visible pinned window receives a new selection', async () => {
    await showSelectionIcon('Pinned visible')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-pin"]').trigger('click')
    await flushPromises()
    sendRegularMessageMock.mockClear()

    sendRegularMessageMock.mockResolvedValueOnce({
      success: true,
      translatedText: 'Pinned translation',
      sourceLanguage: 'fa'
    })

    await showSelectionIcon('Pinned direct selection', { x: 180, y: 220, width: 90, height: 18 })
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
    expect(sendRegularMessageMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="translation-window-footer-detected-language"]').text()).toBe('Persian')
  })

  it('drags the floating window and persists positions by fingerprint and global fallback', async () => {
    await showSelectionIcon('Drag me')
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 260, clientY: 260 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 260, clientY: 260 })
    await flushPromises()

    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.documents['pdf-doc-1']).toBeDefined()
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.documents['pdf-doc-1'].position.x).toBeGreaterThanOrEqual(12)
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.documents['pdf-doc-1'].position.y).toBeGreaterThanOrEqual(12)

    wrapper.unmount()
    wrapper = null

    globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.global.defaultPosition = { x: 88, y: 96 }
    const fingerprintRestored = mount(PdfWindowsHost, {
      props: {
        pdfFingerprint: 'pdf-doc-1',
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()

    await showSelectionIcon('Doc restore', { x: 20, y: 20, width: 80, height: 18 })
    expect(fingerprintRestored.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    await openWindowFromSelectionIcon(fingerprintRestored)
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.documents['pdf-doc-1']).toBeDefined()
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.global.defaultPosition).toEqual({ x: 88, y: 96 })

    fingerprintRestored.unmount()

    const globalFallback = mount(PdfWindowsHost, {
      props: {
        pdfSourceLanguage: 'auto',
        pdfTargetLanguage: 'fa'
      },
      attachTo: document.body
    })
    await flushPromises()

    await showSelectionIcon('Global fallback', { x: 20, y: 20, width: 80, height: 18 })
    expect(globalFallback.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    await openWindowFromSelectionIcon(globalFallback)
    expect(globalThis.__pdfWindowsHostStorageState.pdfWindowsHostLayout.global.defaultPosition).toEqual({ x: 88, y: 96 })

    globalFallback.unmount()
  })

  it('anchors a fresh icon-click open to the current selection instead of a previously persisted floating position', async () => {
    await showSelectionIcon('Persist anchor me')
    await openWindowFromSelectionIcon(wrapper)

    const header = wrapper.get('.pdf-windows-host__header')
    dispatchPointerEvent(header.element, 'pointerdown', { clientX: 180, clientY: 210 })
    dispatchPointerEvent(document, 'pointermove', { clientX: 320, clientY: 280 })
    dispatchPointerEvent(document, 'pointerup', { clientX: 320, clientY: 280 })
    await flushPromises()

    const persistedLeft = wrapper.get('[data-testid="pdf-windows-host"]').element.style.left
    const persistedTop = wrapper.get('[data-testid="pdf-windows-host"]').element.style.top

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    await showSelectionIcon('Fresh icon anchor', { x: 24, y: 28, width: 96, height: 18 })
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()

    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.left).not.toBe(persistedLeft)
    expect(wrapper.get('[data-testid="pdf-windows-host"]').element.style.top).not.toBe(persistedTop)
  })

  it('ignores stale results after a newer PDF selection arrives', async () => {
    let resolveTranslation
    sendRegularMessageMock.mockImplementation(() => new Promise((resolve) => {
      resolveTranslation = resolve
    }))

    await showSelectionIcon('Old selection')
    await openWindowFromSelectionIcon(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(true)

    await showSelectionIcon('New selection', { x: 160, y: 220, width: 90, height: 18 })
    await flushPromises()

    resolveTranslation({
      success: true,
      translatedText: 'Stale result'
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Stale result')
    expect(wrapper.find('[data-testid="pdf-windows-host-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('keeps the visible PDF window open on selection clear or blur, but still dismisses on Escape and outside click', async () => {
    await showSelectionIcon('Dismiss me')
    await openWindowFromSelectionIcon(wrapper)

    await wrapper.get('[data-testid="translation-window-toolbar-original"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pdf-windows-host__source').exists()).toBe(true)

    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    window.dispatchEvent(new Event('blur'))
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    await showSelectionIcon('Dismiss me again')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)

    await showSelectionIcon('Dismiss me one more time')
    expect(wrapper.find('[data-testid="pdf-windows-host-icon-stage"]').exists()).toBe(true)

    dispatchOutsidePointerDown({ button: 0 })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)

    emitSelectionClear({
      context: { source: 'pdf-viewer', isPdf: true }
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="pdf-windows-host-icon-stage"]').isVisible()).toBe(false)
  })

  it('dismisses on primary left-click outside but ignores right and middle clicks', async () => {
    await showSelectionIcon('Primary dismissal')
    await openWindowFromSelectionIcon(wrapper)

    dispatchOutsidePointerDown({ button: 0, buttons: 1 })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)

    await showSelectionIcon('Right click stay open')
    await openWindowFromSelectionIcon(wrapper)

    dispatchOutsidePointerDown({ button: 2, buttons: 2 })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

    dispatchOutsidePointerDown({ button: 1, buttons: 4 })
    await flushPromises()
    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)
  })

  it('dismisses on a primary touch pointer outside the PDF window', async () => {
    await showSelectionIcon('Touch dismissal')
    await openWindowFromSelectionIcon(wrapper)

    dispatchOutsidePointerDown({
      button: 0,
      buttons: 1,
      pointerType: 'touch',
      isPrimary: true
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('keeps the unpinned window open for internal toolbar and body interactions until the close button is used', async () => {
    await showSelectionIcon('Internal interaction')
    await openWindowFromSelectionIcon(wrapper)

    const internalSelectors = [
      '[data-testid="translation-window-toolbar"]',
      '.pdf-windows-host__body',
      '[data-testid="translation-window-toolbar-provider-select"]',
      '[data-testid="translation-window-toolbar-copy"]',
      '[data-testid="translation-window-toolbar-tts"]',
      '[data-testid="translation-window-toolbar-original"]'
    ]

    for (const selector of internalSelectors) {
      const target = wrapper.get(selector)
      await target.trigger('pointerdown')
      emitSelectionClear({
        context: { source: 'pdf-viewer', isPdf: true }
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(true)

      await target.trigger('pointerup')
      await flushPromises()
    }

    await wrapper.get('[data-testid="translation-window-toolbar-close"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="pdf-windows-host"]').exists()).toBe(false)
  })

  it('cleans up all listeners on unmount and does not import the WindowsManager stack', async () => {
    expect(windowsManagerImported).toBe(false)

    wrapper.unmount()
    wrapper = null
    await flushPromises()

    expect(unsubscribeMocks).toHaveLength(2)
    unsubscribeMocks.forEach((unsubscribe) => {
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true })
    expect(addEventListenerSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), { capture: true })
    expect(windowAddEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true })
    expect(windowAddEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function), undefined)

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true })
    expect(removeEventListenerSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), { capture: true })
    expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true })
    expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function), undefined)
  })

  it('keeps PdfWindowsHost implementation free of WindowsManager imports', () => {
    const hostSource = fs.readFileSync(path.resolve(process.cwd(), 'src/apps/pdf/components/PdfWindowsHost.vue'), 'utf8')
    const composableSource = fs.readFileSync(path.resolve(process.cwd(), 'src/apps/pdf/composables/usePdfWindowsHost.js'), 'utf8')

    expect(hostSource).not.toMatch(/@\/features\/windows|src\/features\/windows/)
    expect(composableSource).not.toMatch(/@\/features\/windows|src\/features\/windows/)
  })
})

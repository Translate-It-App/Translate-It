import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const settingsStoreMock = vi.hoisted(() => ({
  settings: { MODE_PROVIDERS: {}, TRANSLATION_API: 'googlev2', DEBUG_MODE: false },
  updateSettingAndPersist: vi.fn(() => Promise.resolve(true))
}))

const tMock = vi.hoisted(() => vi.fn((key, fallback) => fallback || key))

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    template: `
      <div>
        <button class="mock-provider-selector" :disabled="disabled" @click="$emit(loading ? 'cancel' : 'translate', { provider: 'googlev2' })" />
        <button class="mock-provider-change-a" :disabled="disabled || dropdownDisabled" @click="$emit('provider-change', 'deepl'); if (translateOnProviderChange) $emit('translate', { provider: 'deepl' })" />
        <button class="mock-provider-change-b" :disabled="disabled || dropdownDisabled" @click="$emit('provider-change', 'openai'); if (translateOnProviderChange) $emit('translate', { provider: 'openai' })" />
      </div>
    `,
    props: ['disabled', 'dropdownDisabled', 'loading', 'presentation', 'translateOnProviderChange'],
    emits: ['translate', 'cancel', 'provider-change', 'update:modelValue']
  }
}))

vi.mock('@/components/shared/LanguageSelector.vue', () => ({
  default: {
    name: 'LanguageSelector',
    template: '<div class="mock-language-selector" :data-provider="provider" :data-auto-detect-label="autoDetectLabel"><select class="mock-source-lang" :value="sourceLanguage" @change="$emit(\'update:sourceLanguage\', $event.target.value)"><option value="auto">Auto</option><option value="en">English</option><option value="fr">French</option></select><select class="mock-target-lang" :value="targetLanguage" @change="$emit(\'update:targetLanguage\', $event.target.value)"><option value="fa">Persian</option><option value="en">English</option><option value="de">German</option></select></div>',
    props: ['sourceLanguage', 'targetLanguage', 'provider', 'autoDetectLabel', 'compact', 'showDefaultActions', 'enableSelectElementIntegration', 'disabled', 'allowAuto'],
    emits: ['update:sourceLanguage', 'update:targetLanguage', 'swap-languages']
  }
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => settingsStoreMock
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: tMock })
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => loggerMock
}))

import PdfToolbar from './PdfToolbar.vue'
import ToolbarActionDock from './ToolbarActionDock.vue'
import ToolbarCenterRegion from './ToolbarCenterRegion.vue'
import ToolbarNavigationGroup from './ToolbarNavigationGroup.vue'
import ToolbarPresentationGroup from './ToolbarPresentationGroup.vue'
import { TranslationMode } from '@/shared/config/config.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('PdfToolbar', () => {
  beforeEach(() => {
    settingsStoreMock.settings.MODE_PROVIDERS = {}
    settingsStoreMock.settings.TRANSLATION_API = 'googlev2'
    settingsStoreMock.settings.DEBUG_MODE = false
    settingsStoreMock.updateSettingAndPersist.mockReset()
    settingsStoreMock.updateSettingAndPersist.mockResolvedValue(true)
    loggerMock.debug.mockReset()
    loggerMock.info.mockReset()
    loggerMock.warn.mockReset()
    loggerMock.error.mockReset()
    tMock.mockReset()
  })

  it('renders the info button and keeps core actions available', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'very-long-document-name.pdf',
        pageCount: 12,
        currentPageNumber: 5,
        isLoading: false,
        isTranslating: false,
        canTranslateVisiblePages: true,
        canExport: true,
        ocrRecommendationCount: 0,
        isOcrProcessing: false,
        zoomMode: 'fit-width',
        zoomPercent: 100,
        showTranslationOption: true,

      }
    })

    expect(wrapper.find('.pdf-toolbar__file-row').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__info-toggle').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__page-input').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__page-input').element.value).toBe('5')
    expect(wrapper.find('.pdf-toolbar__page-total').text()).toBe('12')
    expect(wrapper.find('.pdf-toolbar__zoom-select').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').exists()).toBe(true)

    expect(wrapper.find('.pdf-toolbar__mode-button--active').exists()).toBe(true)
  })

  it('renders each logical group once with its assigned controls', () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 5,
        showTranslationOption: true,
        hasOutline: true,
        ocrViewModel: {
          primaryAction: 'region',
          preferredAction: 'region',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: false,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: false,
          hasInstalledLanguages: true,
          installedLanguages: []
        }
      }
    })

    const outline = wrapper.find('.pdf-toolbar__group--outline-access')
    const view = wrapper.find('.pdf-toolbar__group--view')
    const navigation = wrapper.find('.pdf-toolbar__group--navigation')
    const primary = wrapper.find('.pdf-toolbar__group--primary-operation')
    const secondary = wrapper.find('.pdf-toolbar__group--secondary-actions')

    expect(wrapper.findAll('.pdf-toolbar__group--outline-access')).toHaveLength(1)
    expect(wrapper.findAll('.pdf-toolbar__group--view')).toHaveLength(1)
    expect(wrapper.findAll('.pdf-toolbar__group--navigation')).toHaveLength(1)
    expect(wrapper.findAll('.pdf-toolbar__group--primary-operation')).toHaveLength(1)
    expect(wrapper.findAll('.pdf-toolbar__group--secondary-actions')).toHaveLength(1)
    expect(outline.find('.pdf-toolbar__outline-toggle').exists()).toBe(true)
    expect(view.find('.pdf-toolbar__view-mode--desktop').exists()).toBe(true)
    expect(view.find('.pdf-toolbar__view-mode--mobile').exists()).toBe(true)
    expect(view.find('.pdf-toolbar__zoom-group').exists()).toBe(true)
    expect(navigation.find('.pdf-toolbar__page-input').exists()).toBe(true)
    expect(primary.find('.pdf-toolbar__ocr-primary').exists()).toBe(true)
    expect(primary.findComponent({ name: 'ProviderSelector' }).exists()).toBe(true)
    expect(secondary.find('.pdf-toolbar__button--menu-trigger').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__actions').find('.pdf-toolbar__group--primary-operation').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__actions').find('.pdf-toolbar__group--secondary-actions').exists()).toBe(true)
    expect(wrapper.findAll('[class*="pdf-toolbar__group--"]')).toHaveLength(5)
  })

  it('composes logical groups through stateless layout components', () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 5,
        hasOutline: true
      }
    })

    expect(wrapper.findComponent(ToolbarCenterRegion).exists()).toBe(true)
    expect(wrapper.findComponent(ToolbarPresentationGroup).find('.pdf-toolbar__group--view').exists()).toBe(true)
    expect(wrapper.findComponent(ToolbarNavigationGroup).find('.pdf-toolbar__group--navigation').exists()).toBe(true)
    expect(wrapper.findComponent(ToolbarActionDock).find('.pdf-toolbar__actions').exists()).toBe(true)
  })

  it('keeps logical groups in stable semantic source order', () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 5,
        hasOutline: true
      }
    })

    const sourceOrder = Array.from(wrapper.find('.pdf-toolbar').element.querySelectorAll(
      '.pdf-toolbar__group--outline-access, .pdf-toolbar__info-toggle, .pdf-toolbar__group--view, .pdf-toolbar__group--navigation, .pdf-toolbar__group--primary-operation, .pdf-toolbar__group--secondary-actions'
    )).map((element) => {
      if (element.classList.contains('pdf-toolbar__group--outline-access')) return 'outline'
      if (element.classList.contains('pdf-toolbar__info-toggle')) return 'info'
      if (element.classList.contains('pdf-toolbar__group--view')) return 'view'
      if (element.classList.contains('pdf-toolbar__group--navigation')) return 'navigation'
      if (element.classList.contains('pdf-toolbar__group--primary-operation')) return 'primary'
      return 'secondary'
    })

    expect(sourceOrder).toEqual(['outline', 'info', 'view', 'navigation', 'primary', 'secondary'])
  })

  it('keeps full and compact View representations on the same event contract', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        contentView: 'original',
        showTranslationOption: true
      }
    })

    const translationButton = wrapper.findAll('.pdf-toolbar__view-mode--desktop .pdf-toolbar__mode-button')
      .find(button => button.text() === 'Text')
    await translationButton.trigger('click')
    await wrapper.find('.pdf-toolbar__view-mode--mobile select').setValue('translated-pdf')

    expect(wrapper.emitted('content-view-change')).toEqual([['translation'], ['translated-pdf']])
  })

  it('keeps PDF Information toolbar and Overflow projections on one event contract', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 1
      }
    })

    await wrapper.find('.pdf-toolbar__info-toggle').trigger('click')
    await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
    const pdfInfoItem = wrapper.findAll('.pdf-toolbar__export-item')
      .find(item => item.text().includes('PDF Information'))
    await pdfInfoItem.trigger('click')

    expect(wrapper.emitted('request-document-info')).toHaveLength(2)
  })

  it('emits content-view-change when a content view button is clicked', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        contentView: 'original',
        layoutMode: 'single',
        zoomMode: 'fit-width',
        zoomPercent: 100,
        showTranslationOption: true
      }
    })

    await wrapper.find('.pdf-toolbar__mode-button--active').trigger('click')
    expect(wrapper.emitted('content-view-change')).toBeTruthy()
    expect(wrapper.emitted('content-view-change')?.[0]?.[0]).toBe('original')

    const translationButton = wrapper.findAll('.pdf-toolbar__mode-button').find(
      (btn) => btn.text().includes('Text')
    )
    await translationButton?.trigger('click')
    expect(wrapper.emitted('content-view-change')?.[1]?.[0]).toBe('translation')
  })

  it('hides the mode section when showTranslationOption is false', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        contentView: 'original',
        showTranslationOption: false
      }
    })

    const section = wrapper.find('.pdf-toolbar__view-mode--desktop')
    expect(section.exists()).toBe(true)
    expect(section.classes()).toContain('pdf-toolbar__view-mode--hidden')
    expect(wrapper.find('.pdf-toolbar__view-mode--mobile select').attributes('tabindex')).toBe('-1')
  })

  it('shows Translation option when showTranslationOption is true', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        contentView: 'translation',
        showTranslationOption: true
      }
    })

    const allButtons = wrapper.findAll('.pdf-toolbar__mode-button')
    const contentButtons = allButtons.filter(
      btn => ['Original', 'Text', 'PDF'].some(label => btn.text().includes(label))
    )
    expect(contentButtons).toHaveLength(3)
    expect(contentButtons.some(btn => btn.text().includes('Text'))).toBe(true)
  })

  it('emits layout-mode-change when a layout mode button is clicked', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        contentView: 'translation',
        layoutMode: 'single',
        zoomMode: 'fit-width',
        zoomPercent: 100,
        showTranslationOption: true
      }
    })

    const sideBySideButton = wrapper.find('.pdf-toolbar__mode-button[aria-label="Side by Side"]')
    await sideBySideButton?.trigger('click')
    expect(wrapper.emitted('layout-mode-change')).toBeTruthy()
    expect(wrapper.emitted('layout-mode-change')?.[0]?.[0]).toBe('side-by-side')
  })

  it('applies the shared right-anchored presentation contract to More menu rows', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canExport: true,
        zoomMode: 'fit-width',
        zoomPercent: 100
      }
    })

    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')

    const mainRows = wrapper.findAll('.pdf-toolbar__export-menu .pdf-toolbar__menu-row')
    expect(mainRows.length).toBeGreaterThan(0)
    expect(mainRows.every((row) => row.find('.pdf-toolbar__menu-row-label').exists())).toBe(true)

    const exportTrigger = wrapper.find('.pdf-toolbar__export-item--submenu-trigger')
    expect(exportTrigger.classes()).toContain('pdf-toolbar__menu-row')
    expect(exportTrigger.find('.pdf-toolbar__menu-row-label').text()).toBe('Export')
    expect(exportTrigger.find('.pdf-toolbar__submenu-chevron').exists()).toBe(true)

    await exportTrigger.trigger('click')
    expect(wrapper.findAll('.pdf-toolbar__flyout .pdf-toolbar__menu-row')).toHaveLength(3)
  })

  it('keeps Open PDF and Export inside the hamburger menu', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        isLoading: false,
        isTranslating: false,
        canTranslateVisiblePages: true,
        canExport: true,
        ocrRecommendationCount: 0,
        isOcrProcessing: false,
        zoomMode: 'fit-width',
        zoomPercent: 100,

      }
    })

    const toggleExportSubmenu = () =>
      wrapper.find('.pdf-toolbar__export-item--submenu-trigger').trigger('click')

    const toolbarButtons = () => wrapper.findAll('.pdf-toolbar__actions button')

    expect(toolbarButtons().some((button) => button.text().includes('Open PDF'))).toBe(false)
    expect(toolbarButtons().some((button) => button.text().includes('Clear Cache'))).toBe(false)

    await wrapper.find('.mock-provider-selector').trigger('click')
    expect(wrapper.emitted('translate-visible')).toBeTruthy()

    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    expect(wrapper.find('.pdf-toolbar__export-menu').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__export-menu').text()).toContain('Open PDF')
    expect(wrapper.find('.pdf-toolbar__export-menu').text()).not.toContain('Clear Cache')
    await toggleExportSubmenu()
    const menu = wrapper.find('.pdf-toolbar__export-menu')
    expect(menu.text()).toContain('Export TXT')
    expect(menu.text()).toContain('Export Markdown')
    expect(menu.text()).toContain('Export HTML')

    await toggleExportSubmenu()
    await wrapper.findAll('.pdf-toolbar__export-menu .pdf-toolbar__export-item').find(b => b.text().includes('Open PDF')).trigger('click')
    expect(wrapper.emitted('request-open-pdf')).toHaveLength(1)

    // Export items inside hamburger menu — no standalone export button
    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    await toggleExportSubmenu()
    await wrapper.findAll('button').find((button) => button.text().includes('Export TXT'))?.trigger('click')
    expect(wrapper.emitted('export-txt')).toBeTruthy()

    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    await toggleExportSubmenu()
    await wrapper.findAll('button').find((button) => button.text().includes('Export Markdown'))?.trigger('click')
    expect(wrapper.emitted('export-markdown')).toBeTruthy()

    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    await toggleExportSubmenu()
    await wrapper.findAll('button').find((button) => button.text().includes('Export HTML'))?.trigger('click')
    expect(wrapper.emitted('export-html')).toBeTruthy()

    await wrapper.find('.pdf-toolbar__zoom-select').setValue('125')
    expect(wrapper.emitted('zoom-change')?.at(-1)?.[0]).toEqual({ mode: 'percent', value: 125 })

    await wrapper.find('.pdf-toolbar__button[title="Fit to page"]').trigger('click')
    expect(wrapper.emitted('zoom-change')?.at(-1)?.[0]).toEqual({ mode: 'fit-page', value: 100 })

    await wrapper.findAll('button').find((button) => button.text().trim() === '+')?.trigger('click')
    expect(wrapper.emitted('zoom-step')?.at(-1)?.[0]).toBe(1)
  })

  it('emits region comparison trigger only while Debug Mode is enabled', async () => {
    const debugDisabled = mount(PdfToolbar)

    await debugDisabled.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    expect(debugDisabled.find('.pdf-toolbar__menu-section').exists()).toBe(false)
    expect(debugDisabled.findAll('button').some((button) => button.text().includes('Region Comparison'))).toBe(false)

    settingsStoreMock.settings.DEBUG_MODE = true
    const debugEnabled = mount(PdfToolbar)
    await debugEnabled.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')

    expect(debugEnabled.find('.pdf-toolbar__menu-section').text()).toContain('Developer')
    const regionComparison = debugEnabled.findAll('button').find((button) => button.text().includes('Region Comparison'))
    expect(regionComparison?.attributes('disabled')).toBeUndefined()

    await regionComparison?.trigger('click')
    expect(debugEnabled.emitted('request-region-comparison')).toHaveLength(1)
    expect(debugEnabled.find('.pdf-toolbar__export-menu').exists()).toBe(false)
  })

  it('does not render terminal regionComparison results in the toolbar', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const wrapper = mount(PdfToolbar, {
      props: {
        regionComparisonState: {
          status: 'completed',
          progress: { totalCandidates: 1, completedCandidates: 1, currentCandidate: null },
          results: [],
          analysis: { winner: null },
          summary: null
        }
      }
    })
    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')

    expect(wrapper.find('.pdf-toolbar__regionComparison').exists()).toBe(false)
  })

  it('shows OCR split button with region action and language label', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        ocrViewModel: {
          primaryAction: 'region',
          preferredAction: 'region',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: false,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
          hasInstalledLanguages: true,
          installedLanguages: []
        }
      }
    })

    const primary = wrapper.find('.pdf-toolbar__ocr-primary')
    expect(primary.exists()).toBe(true)
    expect(primary.find('.pdf-toolbar__ocr-primary-text--full').text()).toBe('OCR Region · EN')
    expect(primary.find('.pdf-toolbar__ocr-primary-text--compact').text()).toBe('Region · EN')
    expect(primary.find('.pdf-toolbar__ocr-primary-size--full').text()).toBe('OCR Region · EN')
    expect(primary.find('.pdf-toolbar__ocr-primary-size--compact').text()).toBe('Region · EN')
    expect(wrapper.find('.pdf-toolbar__ocr-arrow').exists()).toBe(true)
  })

  it('hides the language suffix when no OCR language is installed', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        ocrViewModel: {
          primaryAction: 'region',
          preferredAction: 'region',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: false,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: false,
          hasInstalledLanguages: false,
          installedLanguages: []
        }
      }
    })

    expect(wrapper.find('.pdf-toolbar__ocr-primary-text').text()).toBe('OCR Region')

    await wrapper.setProps({
      ocrViewModel: {
        ...wrapper.props('ocrViewModel'),
        primaryAction: 'page'
      }
    })

    expect(wrapper.find('.pdf-toolbar__ocr-primary-text').text()).toBe('OCR Page')
  })

  it('emits primary-click from OCR primary button', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        ocrViewModel: {
          primaryAction: 'region',
          preferredAction: 'region',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: false,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
          hasInstalledLanguages: true,
          installedLanguages: []
        }
      }
    })

    await wrapper.find('.pdf-toolbar__ocr-primary').trigger('click')
    expect(wrapper.emitted('primary-click')).toHaveLength(1)
  })

  it('reflects cancel state and disabled state via ocrViewModel', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        ocrViewModel: {
          primaryAction: 'region',
          preferredAction: 'region',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: true,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
          hasInstalledLanguages: true,
          installedLanguages: []
        }
      }
    })

    const primary = wrapper.find('.pdf-toolbar__ocr-primary')
    expect(primary.find('.pdf-toolbar__ocr-primary-text').text()).toBe('Cancel · EN')

    await wrapper.setProps({
      ocrViewModel: {
        primaryAction: 'region',
        preferredAction: 'region',
        regionOcrAvailable: false,
        language: { code: 'eng', name: 'English' },
        canCancel: false,
        currentPageContainsOcr: false,
        hasDocument: true,
        isPageOcrRecommended: false,
        hasInstalledLanguages: true,
        installedLanguages: []
      }
    })
    expect(primary.attributes('disabled')).toBeDefined()
  })

  it('emits execution-mode-change from current execution mode selection', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        executionMode: 'ocr',
        executionModes: ['ocr', 'region-comparison']
      }
    })

    const modeSelect = wrapper.find('.pdf-toolbar__execution-mode-select')
    expect(modeSelect.element.value).toBe('ocr')

    await modeSelect.setValue('region-comparison')

    expect(wrapper.emitted('execution-mode-change')).toEqual([['region-comparison']])
  })

  it('hides OCR split button when ocrViewModel is not provided', async () => {
    const wrapper = mount(PdfToolbar, { props: { ocrViewModel: null } })

    expect(wrapper.find('.pdf-toolbar__ocr-primary').exists()).toBe(false)
    expect(wrapper.find('.pdf-toolbar__ocr-arrow').exists()).toBe(false)
  })

  it('shows OCR split button when ocrViewModel is provided', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        ocrViewModel: {
          primaryAction: 'page',
          preferredAction: 'page',
          language: { code: 'eng', name: 'English', compactLabel: 'EN' },
          canCancel: false,
          currentPageContainsOcr: false,
          hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
          installedLanguages: []
        }
      }
    })

    expect(wrapper.find('.pdf-toolbar__ocr-primary').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__ocr-arrow').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__ocr-primary-text').text()).toContain('OCR Page')
  })

  it('keeps the main provider selector action cancellable while translating', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        isTranslating: true,
        canTranslateVisiblePages: false
      }
    })

    const mainButton = wrapper.find('.mock-provider-selector')

    expect(mainButton.attributes('disabled')).toBeUndefined()

    await mainButton.trigger('click')

    expect(wrapper.emitted('cancel-translation')).toHaveLength(1)
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('disables provider selection while translating', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        isTranslating: true,
        canTranslateVisiblePages: false
      }
    })

    const dropdownButton = wrapper.find('.mock-provider-change-a')

    expect(dropdownButton.attributes('disabled')).toBeDefined()

    await dropdownButton.trigger('click')

    expect(settingsStoreMock.updateSettingAndPersist).not.toHaveBeenCalled()
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('keeps provider selector idle behavior unchanged', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        isTranslating: false,
        canTranslateVisiblePages: true
      }
    })

    expect(wrapper.find('.mock-provider-selector').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.mock-provider-change-a').attributes('disabled')).toBeUndefined()

    await wrapper.find('.mock-provider-selector').trigger('click')

    expect(wrapper.emitted('translate-visible')).toHaveLength(1)
  })

  it('persists PDF provider changes without translating', async () => {
    const persistence = createDeferred()
    settingsStoreMock.updateSettingAndPersist.mockImplementationOnce((key, value) => {
      return persistence.promise.then(() => {
        settingsStoreMock.settings[key] = value
        return true
      })
    })

    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canTranslateVisiblePages: true
      }
    })

    await wrapper.find('.mock-provider-change-a').trigger('click')

    expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledWith(
      'MODE_PROVIDERS',
      expect.objectContaining({ [TranslationMode.PDF]: 'deepl' })
    )
    expect(wrapper.emitted('translate-visible')).toBeFalsy()

    persistence.resolve(true)
    await flushPromises()

    expect(settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF]).toBe('deepl')
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('translates when the user clicks Translate after a provider change', async () => {
    settingsStoreMock.updateSettingAndPersist.mockImplementationOnce((key, value) => {
      settingsStoreMock.settings[key] = value
      return Promise.resolve(true)
    })

    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canTranslateVisiblePages: true
      }
    })

    await wrapper.find('.mock-provider-change-a').trigger('click')
    await flushPromises()

    expect(settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF]).toBe('deepl')
    expect(wrapper.emitted('translate-visible')).toBeFalsy()

    await wrapper.find('.mock-provider-selector').trigger('click')

    expect(wrapper.emitted('translate-visible')).toHaveLength(1)
  })

  it('closes language popover when More menu opens and does not reopen when More closes', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'doc.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        sourceLanguage: 'auto',
        targetLanguage: 'fa',
        canExport: true
      }
    })
    // Open language popover
    await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
    const langItem = wrapper.findAll('.pdf-toolbar__export-item')
      .find(item => item.text().includes('Language:'))
    await langItem.trigger('click')
    expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)

    // Open More menu — language popover closes
    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
    expect(wrapper.find('.pdf-toolbar__export-menu').exists()).toBe(true)

    // Close More menu by clicking outside
    document.dispatchEvent(new PointerEvent('pointerdown'))
    await flushPromises()
    expect(wrapper.find('.pdf-toolbar__export-menu').exists()).toBe(false)

    // Language popover stays closed
    expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
  })

  it('serializes rapid PDF provider changes so the latest selection persists without translating', async () => {
    const firstPersistence = createDeferred()
    const secondPersistence = createDeferred()
    settingsStoreMock.updateSettingAndPersist
      .mockImplementationOnce((key, value) => {
        return firstPersistence.promise.then(() => {
          settingsStoreMock.settings[key] = value
          return true
        })
      })
      .mockImplementationOnce((key, value) => {
        return secondPersistence.promise.then(() => {
          settingsStoreMock.settings[key] = value
          return true
        })
      })

    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canTranslateVisiblePages: true
      }
    })

    await wrapper.find('.mock-provider-change-a').trigger('click')
    await wrapper.find('.mock-provider-change-b').trigger('click')

    expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledTimes(1)

    firstPersistence.resolve(true)
    await flushPromises()
    expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('translate-visible')).toBeFalsy()

    secondPersistence.resolve(true)
    await flushPromises()

    expect(settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF]).toBe('openai')
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('does not log stale PDF provider persistence failures when the latest selection succeeds', async () => {
    const firstPersistence = createDeferred()
    const secondPersistence = createDeferred()
    settingsStoreMock.updateSettingAndPersist
      .mockImplementationOnce(() => firstPersistence.promise)
      .mockImplementationOnce((key, value) => {
        return secondPersistence.promise.then(() => {
          settingsStoreMock.settings[key] = value
          return true
        })
      })

    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canTranslateVisiblePages: true
      }
    })

    await wrapper.find('.mock-provider-change-a').trigger('click')
    await wrapper.find('.mock-provider-change-b').trigger('click')

    firstPersistence.reject(new Error('stale failed'))
    await flushPromises()

    expect(loggerMock.error).not.toHaveBeenCalled()
    expect(wrapper.emitted('translate-visible')).toBeFalsy()

    secondPersistence.resolve(true)
    await flushPromises()

    expect(settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF]).toBe('openai')
    expect(loggerMock.error).not.toHaveBeenCalled()
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('logs latest PDF provider persistence failures without translating', async () => {
    const error = new Error('storage failed')
    settingsStoreMock.updateSettingAndPersist.mockRejectedValueOnce(error)

    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 12,
        currentPageNumber: 1,
        canTranslateVisiblePages: true
      }
    })

    await wrapper.find('.mock-provider-change-a').trigger('click')
    await flushPromises()

    expect(loggerMock.error).toHaveBeenCalledWith('Failed to persist PDF provider selection:', error)
    expect(wrapper.emitted('translate-visible')).toBeFalsy()
  })

  it('keeps the current labels while loading', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 2,
        currentPageNumber: 1,
        isLoading: true,
        canTranslateVisiblePages: false,
        canExport: false,
        isTranslating: false,
        zoomMode: 'fit-width',
        zoomPercent: 100
      }
    })

    expect(wrapper.find('.pdf-toolbar__info-toggle').exists()).toBe(true)

    await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
    expect(wrapper.find('.pdf-toolbar__export-menu').text()).toContain('Loading...')
  })

  it('shows outline toggle button when hasOutline is true', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 1,
        currentPageNumber: 1,
        hasOutline: true,
        isOutlineVisible: false
      }
    })

    expect(wrapper.find('.pdf-toolbar__outline-toggle').exists()).toBe(true)
    expect(wrapper.find('.pdf-toolbar__outline-toggle--active').exists()).toBe(false)
  })

  it('hides outline toggle button when hasOutline is false', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 1,
        currentPageNumber: 1,
        hasOutline: false
      }
    })

    expect(wrapper.find('.pdf-toolbar__outline-toggle').exists()).toBe(false)
  })

  it('emits toggle-outline when outline button is clicked', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 1,
        currentPageNumber: 1,
        hasOutline: true,
        isOutlineVisible: false
      }
    })

    await wrapper.find('.pdf-toolbar__outline-toggle').trigger('click')
    expect(wrapper.emitted('toggle-outline')).toBeTruthy()
  })

  it('applies active class to outline toggle when outline is visible', async () => {
    const wrapper = mount(PdfToolbar, {
      props: {
        fileName: 'demo.pdf',
        pageCount: 1,
        currentPageNumber: 1,
        hasOutline: true,
        isOutlineVisible: true
      }
    })

    expect(wrapper.find('.pdf-toolbar__outline-toggle--active').exists()).toBe(true)
  })

  describe('OCR split button - compact language label', () => {
    it('uses compactLabel when available', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'fas', name: 'Persian', compactLabel: 'FA' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            hasInstalledLanguages: true,
            installedLanguages: []
          }
        }
      })

      expect(wrapper.find('.pdf-toolbar__ocr-primary-text').text()).toBe('OCR Region · FA')
    })

    it('falls back to code uppercase when no compactLabel', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'deu', name: 'German' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            hasInstalledLanguages: true,
            installedLanguages: []
          }
        }
      })

      expect(wrapper.find('.pdf-toolbar__ocr-primary-text').text()).toBe('OCR Region · DEU')
    })
  })

  describe('OCR split button - empty language state', () => {
    it('shows no-languages message when installedLanguages is empty', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')

      expect(wrapper.find('.pdf-toolbar__ocr-menu-empty').exists()).toBe(true)
      expect(wrapper.find('.pdf-toolbar__ocr-menu-empty').text()).toBe('No languages installed')
    })
  })

  describe('OCR split button - disabled states', () => {
    it('disables primary when preferred action is region and region is unavailable', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
            regionOcrAvailable: false,
            language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          isPageOcrRecommended: true,
            installedLanguages: []
          }
        }
      })

      expect(wrapper.find('.pdf-toolbar__ocr-primary').attributes('disabled')).toBeDefined()
    })

    it('disables primary when disabled prop is true', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'page',
            preferredAction: 'page',
            hasDocument: false,
            language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: false,
            installedLanguages: []
          }
        }
      })

      expect(wrapper.find('.pdf-toolbar__ocr-primary').attributes('disabled')).toBeDefined()
    })

    it('does not disable when cancel is active', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'cancel',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: true,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: []
          }
        }
      })

      expect(wrapper.find('.pdf-toolbar__ocr-primary').attributes('disabled')).toBeUndefined()
    })

    it('disables OCR Page menu item when hasDocument is false', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: false,
            regionOcrAvailable: false,
            isPageOcrRecommended: false,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const items = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const pageItem = items.find(b => b.text().includes('OCR Page'))
      const regionItem = items.find(b => b.text().includes('OCR Region'))

      expect(pageItem?.attributes('disabled')).toBeDefined()
      expect(regionItem?.attributes('disabled')).toBeDefined()
    })

    it('enables both OCR menu items when document is loaded and original pane visible', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
            regionOcrAvailable: true,
            isPageOcrRecommended: false,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const items = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const pageItem = items.find(b => b.text().includes('OCR Page'))
      const regionItem = items.find(b => b.text().includes('OCR Region'))

      expect(pageItem?.attributes('disabled')).toBeUndefined()
      expect(regionItem?.attributes('disabled')).toBeUndefined()
    })

    it('disables only OCR Region menu item when original pane is hidden', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
            regionOcrAvailable: false,
            isPageOcrRecommended: false,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const items = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const pageItem = items.find(b => b.text().includes('OCR Page'))
      const regionItem = items.find(b => b.text().includes('OCR Region'))

      expect(pageItem?.attributes('disabled')).toBeUndefined()
      expect(regionItem?.attributes('disabled')).toBeDefined()
    })

    it('disables both OCR menu items when processing', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'cancel',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: true,
            currentPageContainsOcr: false,
            hasDocument: true,
            regionOcrAvailable: true,
            isPageOcrRecommended: false,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const items = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const pageItem = items.find(b => b.text().includes('OCR Page'))
      const regionItem = items.find(b => b.text().includes('OCR Region'))

      expect(pageItem?.attributes('disabled')).toBeDefined()
      expect(regionItem?.attributes('disabled')).toBeDefined()
    })
  })

  describe('OCR split button - manage languages', () => {
    it('emits manage-languages from main menu', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const manageButtons = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const manageButton = manageButtons.find(b => b.text().includes('Manage Languages'))

      expect(manageButton.find('.mask-icon').exists()).toBe(true)
      expect(manageButton.text()).toBe('Manage Languages...')

      await manageButton.trigger('click')

      expect(wrapper.emitted('manage-languages')).toHaveLength(1)
    })

    it('emits select-language when language is clicked', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: [{ code: 'eng', name: 'English', selected: true }]
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const langButton = wrapper.findAll('.pdf-toolbar__ocr-menu-item').find(b => b.text().includes('English'))
      await langButton.trigger('click')

      expect(wrapper.emitted('select-language')).toEqual([['eng']])
    })

    it('shows language list with checkmark on selected language', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'fas', name: 'Persian', compactLabel: 'FA' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: [
              { code: 'eng', name: 'English', selected: false },
              { code: 'fas', name: 'Persian', selected: true }
            ]
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const engButton = wrapper.findAll('.pdf-toolbar__ocr-menu-item').find(b => b.text().includes('English'))
      const fasButton = wrapper.findAll('.pdf-toolbar__ocr-menu-item').find(b => b.text().includes('Persian'))

      expect(engButton?.attributes('aria-checked')).toBe('false')
      expect(fasButton?.attributes('aria-checked')).toBe('true')
      expect(fasButton?.classes()).toContain('pdf-toolbar__ocr-menu-item--selected')
    })
  })

  describe('OCR split button - escape focus restoration', () => {
    it('closes menu and restores focus to arrow trigger on Escape', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: []
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      expect(wrapper.find('.pdf-toolbar__ocr-menu').exists()).toBe(true)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()

      expect(wrapper.find('.pdf-toolbar__ocr-menu').exists()).toBe(false)
    })

  })

  describe('OCR split button - arrow navigation', () => {
    it('opens menu on ArrowDown from closed arrow', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: false,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: true,
            installedLanguages: [{ code: 'eng', name: 'English', selected: true }]
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('keydown', { key: 'ArrowDown' })
      await flushPromises()

      expect(wrapper.find('.pdf-toolbar__ocr-menu').exists()).toBe(true)
    })

    it('skips disabled items during ArrowDown navigation', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          ocrViewModel: {
            primaryAction: 'region',
            preferredAction: 'region',
              language: { code: 'eng', name: 'English', compactLabel: 'EN' },
            canCancel: true,
            currentPageContainsOcr: false,
            hasDocument: true,
          regionOcrAvailable: true,
          isPageOcrRecommended: false,
            installedLanguages: [{ code: 'eng', name: 'English', selected: true }]
          }
        }
      })

      await wrapper.find('.pdf-toolbar__ocr-arrow').trigger('click')
      const items = wrapper.findAll('.pdf-toolbar__ocr-menu-item')
      const disabledItem = items.find(b => b.attributes('disabled') === '')
      expect(disabledItem?.exists?.() ?? true).toBe(true)
    })
  })

  describe('language summary button', () => {
    it('language info lives in More menu, not as inline button', () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      expect(wrapper.find('.pdf-toolbar__language-summary-button').exists()).toBe(false)
    })

    it('does not render inline language button when fileName is empty', () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: '',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      expect(wrapper.find('.pdf-toolbar__language-summary-button').exists()).toBe(false)
    })

    it('shows Auto and language codes in More menu', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const languageItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      expect(languageItem.text()).toContain('Auto')
      expect(languageItem.text()).toContain('FA')
    })

    it('shows uppercase source code in More menu', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'en',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const languageItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      expect(languageItem.text()).toContain('EN')
      expect(languageItem.text()).toContain('FA')
    })
  })

  describe('PDF Information menu item', () => {
    it('emits request-document-info and closes menu', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          pageCount: 12,
          currentPageNumber: 1,
          canExport: true,
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const pdfInfoItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('PDF Information'))
      expect(pdfInfoItem.exists()).toBe(true)
      await pdfInfoItem.trigger('click')
      expect(wrapper.emitted('request-document-info')).toHaveLength(1)
      expect(wrapper.find('.pdf-toolbar__export-menu').exists()).toBe(false)
    })
  })

  describe('language popover', () => {
    beforeEach(() => {
      settingsStoreMock.settings.MODE_PROVIDERS = {}
      settingsStoreMock.settings.TRANSLATION_API = 'googlev2'
    })

    it('opens popover on trigger click', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
    })

    it('shows LanguageSelector inside popover when open', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').exists()).toBe(true)
    })

    it('does not render LanguageSelector in toolbar when popover is closed', () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      expect(wrapper.find('.mock-language-selector').exists()).toBe(false)
    })

    it('closes popover on second trigger click', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
    })

    it('closes popover on Escape', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
    })

    it('closes popover on outside click', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      document.dispatchEvent(new PointerEvent('pointerdown'))
      await flushPromises()
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
    })

    it('returns focus to More button on Escape close', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      wrapper.find('.pdf-toolbar__button--menu-trigger').element.focus()
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
    })

    it('does not close popover on language change', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      await wrapper.find('.mock-source-lang').setValue('en')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      expect(wrapper.emitted('update:sourceLanguage')).toBeTruthy()
    })

    it('passes sourceLanguage prop to LanguageSelector inside popover', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'en',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      const sourceSelect = wrapper.find('.mock-source-lang')
      expect(sourceSelect.element.value).toBe('en')
    })

    it('passes targetLanguage prop to LanguageSelector inside popover', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'en'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      const targetSelect = wrapper.find('.mock-target-lang')
      expect(targetSelect.element.value).toBe('en')
    })

    it('passes effective provider to LanguageSelector inside popover when mode-specific provider is set', async () => {
      settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF] = 'deepl'
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').attributes('data-provider')).toBe('deepl')
    })

    it('passes effective provider to LanguageSelector inside popover when mode-specific provider is default', async () => {
      settingsStoreMock.settings.MODE_PROVIDERS[TranslationMode.PDF] = 'default'
      settingsStoreMock.settings.TRANSLATION_API = 'openai'
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').attributes('data-provider')).toBe('openai')
    })

    it('passes effective provider to LanguageSelector inside popover when no mode-specific override exists', async () => {
      settingsStoreMock.settings.TRANSLATION_API = 'gemini'
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').attributes('data-provider')).toBe('gemini')
    })

    it('falls back to the configured global provider when none is configured', async () => {
      settingsStoreMock.settings.MODE_PROVIDERS = {}
      settingsStoreMock.settings.TRANSLATION_API = ''
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').attributes('data-provider')).toBe('edge')
    })

    it('passes localized auto-detect label to LanguageSelector inside popover', async () => {
      tMock.mockReturnValueOnce('Auto-Detect')
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.mock-language-selector').attributes('data-auto-detect-label')).toBe('Auto-Detect')
    })

    it('emits update:sourceLanguage when source dropdown changes inside popover', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      await wrapper.find('.mock-source-lang').setValue('en')
      expect(wrapper.emitted('update:sourceLanguage')).toBeTruthy()
      expect(wrapper.emitted('update:sourceLanguage')[0]).toEqual(['en'])
    })

    it('emits update:targetLanguage when target dropdown changes inside popover', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          sourceLanguage: 'auto',
          targetLanguage: 'fa'
        }
      })
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      await wrapper.find('.mock-target-lang').setValue('de')
      expect(wrapper.emitted('update:targetLanguage')).toBeTruthy()
      expect(wrapper.emitted('update:targetLanguage')[0]).toEqual(['de'])
    })

    it('does not interfere with other toolbar menus', async () => {
      const wrapper = mount(PdfToolbar, {
        props: {
          fileName: 'doc.pdf',
          pageCount: 12,
          currentPageNumber: 1,
          sourceLanguage: 'auto',
          targetLanguage: 'fa',
          canExport: true
        }
      })
      // Open language popover
      await wrapper.find('.pdf-toolbar__button--menu-trigger').trigger('click')
      const langItem = wrapper.findAll('.pdf-toolbar__export-item')
        .find(item => item.text().includes('Language:'))
      await langItem.trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(true)
      // Open hamburger menu — language popover closes
      await wrapper.find('.pdf-toolbar__button[aria-label="More actions"]').trigger('click')
      expect(wrapper.find('.pdf-toolbar__language-popover').exists()).toBe(false)
      expect(wrapper.find('.pdf-toolbar__export-menu').exists()).toBe(true)
    })
  })

  describe('page input editing', () => {
    const baseProps = () => ({
      fileName: 'doc.pdf',
      pageCount: 12,
      currentPageNumber: 5,
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    })

    it('emits go-to-page on Enter', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('8')
      await input.trigger('keydown', { key: 'Enter' })
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeTruthy()
      expect(wrapper.emitted('go-to-page')[0]).toEqual([8])

      wrapper.unmount()
    })

    it('emits go-to-page on blur', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('3')
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeTruthy()
      expect(wrapper.emitted('go-to-page')[0]).toEqual([3])

      wrapper.unmount()
    })

    it('does not emit go-to-page on invalid input blur and restores value', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('')
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeFalsy()
      expect(input.element.value).toBe('5')

      wrapper.unmount()
    })

    it('restores current page immediately on invalid non-numeric blur', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('abc')
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeFalsy()
      expect(input.element.value).toBe('5')

      wrapper.unmount()
    })

    it('Enter emits go-to-page only once', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('8')
      await input.trigger('keydown', { key: 'Enter' })
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeTruthy()
      expect(wrapper.emitted('go-to-page')).toHaveLength(1)
      expect(wrapper.emitted('go-to-page')[0]).toEqual([8])

      wrapper.unmount()
    })

    it('cancels edit on Escape and restores value', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('99')
      await input.trigger('keydown', { key: 'Escape' })

      expect(wrapper.emitted('go-to-page')).toBeFalsy()
      expect(input.element.value).toBe('5')

      wrapper.unmount()
    })

    it('syncs value when currentPageNumber prop changes while not editing', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      expect(input.element.value).toBe('5')

      await wrapper.setProps({ currentPageNumber: 7 })
      expect(input.element.value).toBe('7')

      wrapper.unmount()
    })

    it('does not overwrite input while editing when prop changes', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('1')

      await wrapper.setProps({ currentPageNumber: 9 })
      expect(input.element.value).toBe('1')

      wrapper.unmount()
    })

    it('strips non-numeric characters from input', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.setValue('4abc2')
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeTruthy()
      expect(wrapper.emitted('go-to-page')[0]).toEqual([42])

      wrapper.unmount()
    })

    it('does not emit go-to-page on blur when value is unchanged', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeFalsy()
      expect(input.element.value).toBe('5')

      wrapper.unmount()
    })

    it('does not emit go-to-page on Enter when value is unchanged', async () => {
      const wrapper = mount(PdfToolbar, {
        props: baseProps(),
        global: { stubs: { MaskIcon: true } },
        attachTo: document.body
      })
      const input = wrapper.find('.pdf-toolbar__page-input')
      await input.trigger('focus')
      await input.trigger('keydown', { key: 'Enter' })
      await input.trigger('blur')

      expect(wrapper.emitted('go-to-page')).toBeFalsy()
      expect(input.element.value).toBe('5')

      wrapper.unmount()
    })
  })

  describe('content view mode tooltips', () => {
    const tooltipProps = (overrides = {}) => ({
      fileName: 'doc.pdf',
      pageCount: 3,
      currentPageNumber: 1,
      contentView: 'original',
      showTranslationOption: true,
      ...overrides
    })

    const findDesktopButtonByLabel = (wrapper, label) => wrapper
      .findAll('.pdf-toolbar__view-mode--desktop .pdf-toolbar__mode-button')
      .find((button) => button.text().trim() === label)

    it('exposes per-mode tooltips on desktop buttons while keeping visible labels unchanged', () => {
      const wrapper = mount(PdfToolbar, { props: tooltipProps() })

      const buttons = wrapper.findAll('.pdf-toolbar__view-mode--desktop .pdf-toolbar__mode-button')
      expect(buttons.map((button) => button.text().trim())).toEqual(['Original', 'Text', 'PDF'])

      expect(findDesktopButtonByLabel(wrapper, 'Original').attributes('title')).toBe('Original PDF')
      expect(findDesktopButtonByLabel(wrapper, 'Text').attributes('title')).toBe('Translated Text (Beta)')
      expect(findDesktopButtonByLabel(wrapper, 'PDF').attributes('title')).toBe('Translated PDF (Experimental)')
    })

    it('sets mobile select title from the selected content view', async () => {
      const wrapper = mount(PdfToolbar, { props: tooltipProps({ contentView: 'original' }) })
      const select = () => wrapper.find('.pdf-toolbar__view-mode--mobile select')

      expect(select().attributes('title')).toBe('Original PDF')
      expect(wrapper.findAll('.pdf-toolbar__view-mode--mobile option').map((option) => option.text().trim()))
        .toEqual(['Original', 'Text', 'PDF'])

      await wrapper.setProps({ contentView: 'translation' })
      expect(select().attributes('title')).toBe('Translated Text (Beta)')

      await wrapper.setProps({ contentView: 'translated-pdf' })
      expect(select().attributes('title')).toBe('Translated PDF (Experimental)')
    })

    it('keeps mode-change behavior unchanged', async () => {
      const wrapper = mount(PdfToolbar, { props: tooltipProps({ contentView: 'original' }) })

      await findDesktopButtonByLabel(wrapper, 'Text').trigger('click')
      await wrapper.find('.pdf-toolbar__view-mode--mobile select').setValue('translated-pdf')

      expect(wrapper.emitted('content-view-change')).toEqual([['translation'], ['translated-pdf']])
    })
  })

  describe('page navigation buttons', () => {
    const baseProps = () => ({
      fileName: 'doc.pdf',
      pageCount: 12,
      currentPageNumber: 5
    })

    it('disables Previous on the first page', () => {
      const wrapper = mount(PdfToolbar, { props: { ...baseProps(), currentPageNumber: 1 } })

      expect(wrapper.find('button[aria-label="Previous page"]').attributes('disabled')).toBeDefined()
    })

    it('disables Next on the last page', () => {
      const wrapper = mount(PdfToolbar, { props: { ...baseProps(), currentPageNumber: 12 } })

      expect(wrapper.find('button[aria-label="Next page"]').attributes('disabled')).toBeDefined()
    })

    it('enables Previous and Next between page boundaries', () => {
      const wrapper = mount(PdfToolbar, { props: baseProps() })

      expect(wrapper.find('button[aria-label="Previous page"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('button[aria-label="Next page"]').attributes('disabled')).toBeUndefined()
    })

    it('emits previous-page and next-page from their buttons', async () => {
      const wrapper = mount(PdfToolbar, { props: baseProps() })

      await wrapper.find('button[aria-label="Previous page"]').trigger('click')
      await wrapper.find('button[aria-label="Next page"]').trigger('click')

      expect(wrapper.emitted('previous-page')).toHaveLength(1)
      expect(wrapper.emitted('next-page')).toHaveLength(1)
    })

    it('labels page navigation buttons for assistive technology and tooltips', () => {
      const wrapper = mount(PdfToolbar, { props: baseProps() })

      expect(wrapper.find('button[aria-label="Previous page"]').attributes('title')).toBe('Previous page')
      expect(wrapper.find('button[aria-label="Next page"]').attributes('title')).toBe('Next page')
    })
  })
})

import { afterEach, describe, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive, ref } from 'vue'
import PdfApp from './PdfApp.vue'
import { createPdfRegion } from '@/features/pdf-translation/core/PdfRegion.js'
import { PdfDeveloperApi } from './PdfDeveloperApi.js'
import { PDF_REGION_OCR_RENDER_SCALE } from '@/features/pdf-translation/core/pdfRenderingConstants.js'

// jsdom does not implement matchMedia — stub it before component mount
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
}

let mockViewerController
let mockViewerMode
let mockPdfExport
let mockPdfNavigation

let mockPdfOcr
let mockPdfOcrOptions
let mockRegionOcr
let mockRegionOcrOptions
let mockLayoutSyncFromPane
let mockPdfViewport
let mockPdfSession
const mockRegionExecutionDispatch = vi.fn((request, runner) => runner(request))
const openTranslationMock = vi.fn()
const downloadFileMock = vi.hoisted(() => vi.fn())
const openOptionsPageMock = vi.hoisted(() => vi.fn())
const pdfDiagnosticsImportMock = vi.hoisted(() => vi.fn())
const pdfAppLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
const browserTabStateMock = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}))
const settingsStoreMock = vi.hoisted(() => ({
  isDarkTheme: false,
  settings: { THEME: 'auto', DEBUG_MODE: false },
  updateSettingAndPersist: vi.fn().mockResolvedValue(true)
}))
const ocrStoreMock = vi.hoisted(() => ({
  downloadedLanguages: ['eng'],
  init: vi.fn().mockResolvedValue()
}))
const regionComparisonRunnerMock = vi.hoisted(() => ({
  execute: vi.fn(),
  options: null
}))
const activityCompletedMock = vi.hoisted(() => vi.fn(() => ({ name: 'activity-completed' })))
const translationPartialMock = vi.hoisted(() => vi.fn())
const translationFailedMock = vi.hoisted(() => vi.fn())
const pdfTranslationErrorPresenterMock = vi.hoisted(() => vi.fn(async ({ errorDetails }) => {
  if (['CONTEXT', 'EXTENSION_CONTEXT_INVALIDATED', 'TRANSLATION_CANCELLED'].includes(errorDetails?.type)) {
    return { kind: 'silent' }
  }
  return errorDetails
    ? { kind: 'display', message: 'Localized model error' }
    : { kind: 'display', message: 'Generic PDF translation error' }
}))
const pageContentSourceMock = vi.hoisted(() => Object.freeze({
  PDF_TEXT: 'pdf-text',
  OCR: 'ocr',
  NONE: 'none',
  MIXED: 'mixed'
}))

function createMockOperation(promise, cancel = vi.fn(), context = { target: 'ocr' }) {
  return Object.freeze({
    promise,
    cancel,
    context: Object.freeze(context)
  })
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

vi.mock('./composables/usePdfViewerController.js', () => ({
  usePdfViewerController: () => mockViewerController
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => pdfAppLoggerMock,
}))

vi.mock('./utils/PdfBrowserTabState.js', () => browserTabStateMock)

vi.mock('./composables/usePdfViewerMode.js', () => ({
  usePdfViewerMode: () => mockViewerMode,
  CONTENT_VIEW: { ORIGINAL: 'original', TRANSLATION: 'translation', TRANSLATED_PDF: 'translated-pdf' },
  LAYOUT_MODE: { SINGLE: 'single', SIDE_BY_SIDE: 'side-by-side' },
  VIEWER_ROLE: { ORIGINAL: 'original', OVERLAY: 'overlay' }
}))

vi.mock('./composables/usePdfExport.js', () => ({
  usePdfExport: () => mockPdfExport
}))

vi.mock('./composables/usePdfNavigation.js', () => ({
  usePdfNavigation: () => mockPdfNavigation
}))

vi.mock('@/features/pdf-translation/core/PdfDocumentSession.js', () => ({
  pdfDocumentSession: {},
  PAGE_CONTENT_SOURCE: pageContentSourceMock
}))

vi.mock('./presentation/domainEvents.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    DomainEvents: Object.freeze({
      ...actual.DomainEvents,
      activityCompleted: activityCompletedMock,
      translationPartial: (payload) => {
        translationPartialMock(payload)
        return actual.DomainEvents.translationPartial(payload)
      },
      translationFailed: (payload) => {
        translationFailedMock(payload)
        return actual.DomainEvents.translationFailed(payload)
      }
    })
  }
})

vi.mock('./presentation/PdfTranslationErrorPresenter.js', () => ({
  presentPdfTranslationError: pdfTranslationErrorPresenterMock,
}))

vi.mock('./composables/usePdfOcr.js', () => ({
  usePdfOcr: (options) => {
    mockPdfOcrOptions = options
    return mockPdfOcr
  }
}))

vi.mock('./composables/usePdfRegionOcr.js', () => ({
  usePdfRegionOcr: (options) => {
    mockRegionOcrOptions = options
    return mockRegionOcr
  }
}))

vi.mock('./composables/regionExecutionDispatcher.js', () => ({
  createRegionExecutionDispatcher: (options) => {
    return {
      dispatchRegionExecution: (request) => {
        const runner = options.runners?.[request.target]
        if (!runner) throw new RangeError('Unsupported region execution target')
        return mockRegionExecutionDispatch(request, runner)
      }
    }
  }
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => settingsStoreMock
}))

vi.mock('@/features/screen-capture/stores/ocrStore.js', () => ({
  useOCRStore: () => ocrStoreMock
}))

vi.mock('@/features/screen-capture/utils/ocrLanguageMap.js', () => ({
  SUPPORTED_OCR_LANGUAGES: [
    { code: 'eng', name: 'English' },
    { code: 'fas', name: 'Persian' },
    { code: 'deu', name: 'German' },
    { code: 'fra', name: 'French' }
  ],
  getTesseractLanguageCodeLabel: (code) => {
    const map = { eng: 'EN', fas: 'FA', deu: 'DE', fra: 'FR' }
    return map[code] || code?.toUpperCase() || 'EN'
  }
}))

vi.mock('./RegionComparisonRunner.js', () => ({
  RegionComparisonRunner: class {
    constructor(options) {
      regionComparisonRunnerMock.options = options
    }

    execute(request) {
      return regionComparisonRunnerMock.execute(request)
    }
  }
}))

vi.mock('@/utils/ui/theme.js', () => ({
  applyTheme: vi.fn()
}))

vi.mock('@/core/helpers.js', () => ({
  openOptionsPage: openOptionsPageMock
}))

const localeMock = ref('en')
const localeMessagesMock = ref({})
const tMock = vi.fn((key, fallback) =>
  localeMessagesMock.value[localeMock.value]?.[key] ?? fallback ?? key
)

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: tMock })
}))

vi.mock('@/features/pdf-translation/core/PdfFileDownloader.js', () => ({
  downloadFile: downloadFileMock
}))

vi.mock('./components/PdfToolbar.vue', () => ({
  default: {
    name: 'PdfToolbar',
    props: ['fileName', 'pageCount', 'currentPageNumber', 'zoomMode', 'zoomPercent', 'contentView', 'layoutMode', 'executionMode', 'executionModes', 'ocrViewModel', 'regionComparisonState', 'canExportRegionComparisonArtifact', 'hasOutline'],
    emits: ['toggle-outline', 'translate-visible', 'cancel-translation', 'content-view-change', 'layout-mode-change', 'zoom-step', 'zoom-change', 'export-txt', 'export-markdown', 'export-html', 'request-region-comparison', 'cancel-region-comparison', 'export-region-comparison-artifact', 'clear-cache', 'request-open-pdf', 'open-remote-pdf', 'execution-mode-change', 'primary-click', 'select-action', 'select-language', 'manage-languages', 'open-settings', 'request-document-info', 'previous-page', 'next-page'],
    template: '<header class="pdf-toolbar-stub"><button v-if="hasOutline" class="pdf-toolbar__outline-toggle" /></header>'
  }
}))

vi.mock('./components/PdfDropzone.vue', () => ({
  default: {
    name: 'PdfDropzone',
    props: ['hasDocument'],
    template: '<section class="pdf-dropzone-stub"><slot v-if="!hasDocument" name="empty" /><slot v-else name="document" /></section>'
  }
}))

vi.mock('./components/PdfViewerLayout.vue', () => ({
  default: {
    name: 'PdfViewerLayout',
    props: ['showOriginalPane', 'showTranslatedPane', 'suppressScrollSync'],
    setup(props, { expose }) {
      const getOriginalPageStep = () => (props.showTranslatedPane ? 100 : 120)
      const translatedPageStep = 100
      const originalCanvasOffset = 24
      const translatedCanvasOffset = 12
      const getOriginalCanvasHeight = () => (getOriginalPageStep() - 48)
      const translatedCanvasHeight = 76

      const original = document.createElement('div')
      const translated = document.createElement('div')
      original.className = 'mock-original-scroll'
      translated.className = 'mock-translated-scroll'
      original.scrollTo = vi.fn(({ top }) => { original.scrollTop = top })
      translated.scrollTo = vi.fn(({ top }) => { translated.scrollTop = top })
      original.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 300, width: 300 })
      translated.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 300, width: 300 })

      for (let pageNumber = 1; pageNumber <= 12; pageNumber++) {
        const originalPage = document.createElement('div')
        originalPage.className = 'pdf-page'
        originalPage.dataset.pageNumber = String(pageNumber)
        originalPage.getBoundingClientRect = () => {
          const pageStep = getOriginalPageStep()
          const top = ((pageNumber - 1) * pageStep) - original.scrollTop
          return { top, bottom: top + pageStep, height: pageStep, left: 0, right: 300, width: 300 }
        }
        const originalCanvas = document.createElement('canvas')
        originalCanvas.getBoundingClientRect = () => {
          const pageStep = getOriginalPageStep()
          const canvasHeight = getOriginalCanvasHeight()
          const top = ((pageNumber - 1) * pageStep) - original.scrollTop + originalCanvasOffset
          return { top, bottom: top + canvasHeight, height: canvasHeight, left: 0, right: 260, width: 260 }
        }
        originalPage.appendChild(originalCanvas)
        original.appendChild(originalPage)

        const translatedPage = document.createElement('div')
        translatedPage.className = 'pdf-translated-page pdf-page'
        translatedPage.dataset.pageNumber = String(pageNumber)
        translatedPage.getBoundingClientRect = () => {
          const top = ((pageNumber - 1) * translatedPageStep) - translated.scrollTop
          return { top, bottom: top + translatedPageStep, height: translatedPageStep, left: 0, right: 300, width: 300 }
        }
        const translatedCanvas = document.createElement('canvas')
        translatedCanvas.getBoundingClientRect = () => {
          const top = ((pageNumber - 1) * translatedPageStep) - translated.scrollTop + translatedCanvasOffset
          return { top, bottom: top + translatedCanvasHeight, height: translatedCanvasHeight, left: 0, right: 260, width: 260 }
        }
        translatedPage.appendChild(translatedCanvas)
        translated.appendChild(translatedPage)
      }

      const exposed = {
        syncFromPane: mockLayoutSyncFromPane
      }
      Object.defineProperties(exposed, {
        scrollContainer: {
          get: () => props.showOriginalPane ? original : null
        },
        translatedPaneRef: {
          get: () => props.showTranslatedPane ? translated : null
        }
      })
      expose(exposed)

      return {}
    },
    template: '<div class="pdf-viewer-layout-stub"><slot name="original" /><slot name="translated" /></div>'
  }
}))

vi.mock('./components/PdfViewer.vue', () => ({
  default: {
    name: 'PdfViewer',
    props: ['viewerRole', 'showOverlay', 'handleNavigationTarget', 'scrollContainer', 'freezeRenderWindowEviction', 'regionSelectionActive'],
    emits: ['layout-change', 'current-page-change', 'visible-pages-change', 'region-selection-complete'],
    setup(_, { expose }) {
      const pageElement = document.createElement('div')
      const stageElement = document.createElement('div')
      pageElement.getBoundingClientRect = () => ({ left: 20, top: 30, width: 180, height: 220, right: 200, bottom: 250 })
      stageElement.getBoundingClientRect = () => ({ left: 48, top: 64, width: 100, height: 100, right: 148, bottom: 164 })
      expose({
        getPageElement: vi.fn(() => pageElement),
        getPageStageElement: vi.fn(() => stageElement)
      })
      return () => h('div', { class: 'pdf-viewer-stub' })
    }
  }
}))

vi.mock('./components/PdfTranslatedPane.vue', () => ({
  default: {
    name: 'PdfTranslatedPane',
    props: ['scrollContainer'],
    template: '<div class="pdf-translated-pane-stub" />'
  }
}))

vi.mock('./components/PdfWindowsHost.vue', () => ({
  default: defineComponent({
    name: 'PdfWindowsHost',
    setup(_, { expose }) {
      expose({ openTranslation: openTranslationMock })
      return () => h('div', { class: 'pdf-windows-host-stub' })
    }
  })
}))

vi.mock('./debug/pdfOverlayDiagnostics.js', () => {
  pdfDiagnosticsImportMock()
  return {}
})

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  },
  Toaster: { name: 'Toaster', template: '<div />' }
}))

const mockHandleZoomChange = vi.fn()
const mockWaitForInitialLayoutCommit = vi.fn()
vi.mock('./composables/createPdfTransitionController.js', () => ({
  createPdfTransitionController: () => ({
    handleContentViewChange: vi.fn((value) => {
      mockViewerMode.setContentView(value)
    }),
    handleLayoutModeChange: vi.fn((value) => {
      mockViewerMode.setLayoutMode(value)
    }),
    handleLayoutChange: vi.fn(),
    waitForInitialLayoutCommit: mockWaitForInitialLayoutCommit,
    handleZoomChange: mockHandleZoomChange,
    handleZoomStep: vi.fn(),
    buildLayoutRequest: vi.fn(() => ({ width: 960, height: 600 })),
    resetViewerState: vi.fn(),
    currentPageUpdatesSuppressed: ref(false),
    renderWindowEvictionFrozen: ref(false),
    suppressScrollSync: ref(false),
    zoomMode: ref('fit-width'),
    zoomPercent: ref(100),
  })
}))

let mockPendingState
const mockGetPending = vi.fn(() => mockPendingState)
const mockClearPending = vi.fn(() => { mockPendingState = null })
const mockSetPending = vi.fn((state) => { mockPendingState = state })
vi.mock('@/features/pdf-translation/core/PendingViewerState.js', () => ({
  getPendingViewerState: () => mockGetPending(),
  setPendingViewerState: (state) => mockSetPending(state),
  clearPendingViewerState: () => mockClearPending(),
}))

const mockReadUrl = vi.fn(() => null)
const mockWriteUrl = vi.fn()
vi.mock('@/features/pdf-translation/core/PdfViewerStateUrlAdapter.js', () => ({
  readViewerStateFromUrl: () => mockReadUrl(),
  writeViewerStateToUrl: (state) => mockWriteUrl(state),
}))

import { createViewerState } from '@/features/pdf-translation/core/PdfViewerState.js'

const flushPromises = () => nextTick()
function createMocks({
  bannerState = null,
  hasDocument = true,
  sessionAsRef = false
} = {}) {
  const sessionMock = {
    getPageViewport: vi.fn(() => mockPdfViewport),
    getPageContentSource: vi.fn(() => pageContentSourceMock.PDF_TEXT),
    getCommittedOcrState: vi.fn(() => null),
    fileName: '',
    documentMetadata: {},
    documentIdentity: 'loaded-doc-id',
    documentGeneration: 1,
  }
  mockPdfSession = sessionMock

  mockViewerController = {
    error: ref(''),
    fileName: ref('demo.pdf'),
    hasDocument: ref(hasDocument),
    pdfSourceLanguage: ref('auto'),
    pdfTargetLanguage: ref('fa'),
    isLoading: ref(false),
    isTranslating: ref(false),
    hasTranslationContent: ref(false),
    canTranslateVisiblePages: ref(true),
    pageCount: ref(12),
    pageMetrics: ref([]),
    translationSummary: ref({
      status: 'idle',
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0
    }),
    translatedPageData: ref([]),
    translationTick: ref(0),
    restoredTranslationCount: ref(0),
    pdfFingerprint: ref('fingerprint'),
    workerLabel: ref('worker'),
    currentFile: ref(null),
    loadFailure: ref(null),
    fileSize: ref(0),
    session: sessionAsRef ? ref(sessionMock) : sessionMock,
    loadPdfFile: vi.fn().mockResolvedValue(true),
    openPdfUrl: vi.fn().mockResolvedValue(true),
    recomputeLayout: vi.fn().mockResolvedValue(undefined),
    translateVisiblePages: vi.fn().mockResolvedValue(false),
    hydrateVisiblePageBlocks: vi.fn().mockResolvedValue(false),
    refreshTranslatedPageBlocks: vi.fn(),
    cancelTranslation: vi.fn(),
    clearDocumentCache: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn()
  }

  const contentView = ref('translated-pdf')
  const selectedLayoutMode = ref('single')
  const layoutMode = computed(() => (
    contentView.value === 'original' ? 'single' : selectedLayoutMode.value
  ))
  const isSideBySide = computed(() => layoutMode.value === 'side-by-side')

  mockViewerMode = {
    contentView,
    selectedLayoutMode,
    layoutMode,
    showOriginalPane: computed(() => contentView.value !== 'translation' || isSideBySide.value),
    showTranslatedTextPane: computed(() => contentView.value === 'translation'),
    showTranslatedPdfPane: computed(() => contentView.value === 'translated-pdf' && isSideBySide.value),
    showOverlayLayer: computed(() => contentView.value === 'translated-pdf' && layoutMode.value === 'single'),
    isSideBySide,
    setContentView: vi.fn((value) => {
      contentView.value = value
    }),
    setLayoutMode: vi.fn((value) => {
      selectedLayoutMode.value = value
    })
  }
  mockLayoutSyncFromPane = vi.fn()
  mockPdfViewport = {
    convertToPdfPoint: vi.fn((x, y) => [x / 2, y / 2]),
    convertToViewportPoint: vi.fn((x, y) => [x * 2, y * 2])
  }

    mockPdfExport = {
    canExport: ref(false),
    exportError: ref(''),
    exportTxt: vi.fn().mockResolvedValue(false),
    exportMarkdown: vi.fn().mockResolvedValue(false),
    exportHtml: vi.fn().mockResolvedValue(false),
  }

  const outline = ref(null)
  mockPdfNavigation = {
    currentPage: ref(5),
    isNavigating: ref(false),
    outline,
    hasOutline: computed(() => Array.isArray(outline.value) && outline.value.length > 0),
    activeOutlineDest: ref(null),
    expandedDests: ref(new Set()),
    navigateToPage: vi.fn(),
    navigateToDestination: vi.fn(),
    handleNavigationTarget: vi.fn(),
    attachDocument: vi.fn(),
    detachDocument: vi.fn(() => { outline.value = null })
  }

  mockPdfOcr = {
    ocrRecommendationCount: ref(0),
    ocrRecommendations: ref([]),
    ocrBatch: { pageNumbers: [] },
    isOcrProcessing: ref(false),
    ocrError: ref(''),
    refreshOcrRecommendations: vi.fn(),
    requestOcr: vi.fn(),
    confirmOcr: vi.fn(),
    cancelOcr: vi.fn()
  }

  mockRegionOcr = {
    outcome: ref(null),
    isProcessing: ref(false),
    startRegionOcr: vi.fn(),
    executeRegionOcr: vi.fn(),
    cancelRegionOcr: vi.fn()
  }

  if (bannerState) {
    mockViewerController.isLoading.value = Boolean(bannerState.isLoading)
    mockViewerController.error.value = bannerState.error || ''
  }
}

describe('PdfApp', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    localeMock.value = 'en'
    localeMessagesMock.value = {}
    tMock.mockImplementation((key, fallback) =>
      localeMessagesMock.value[localeMock.value]?.[key] ?? fallback ?? key
    )
    const { toast } = await import('vue-sonner')
    toast.success.mockClear()
    toast.error.mockClear()
    toast.warning.mockClear()
    toast.info.mockClear()
    openTranslationMock.mockReset()
    openOptionsPageMock.mockReset()
    downloadFileMock.mockReset()
    pdfDiagnosticsImportMock.mockReset()
    pdfAppLoggerMock.warn.mockReset()
    browserTabStateMock.read.mockReset()
    browserTabStateMock.read.mockReturnValue(null)
    browserTabStateMock.write.mockReset()
    mockRegionExecutionDispatch.mockClear()
    regionComparisonRunnerMock.execute.mockReset()
    regionComparisonRunnerMock.options = null
    activityCompletedMock.mockClear()
    translationPartialMock.mockClear()
    translationFailedMock.mockClear()
    pdfTranslationErrorPresenterMock.mockClear()
    settingsStoreMock.settings = reactive({ THEME: 'auto', DEBUG_MODE: false })
    settingsStoreMock.settings.DEBUG_MODE = false
    settingsStoreMock.settings.OCR_DEFAULT_LANG = 'eng'
    settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'region'
    ocrStoreMock.downloadedLanguages = ['eng']
    ocrStoreMock.init.mockReset()
    ocrStoreMock.init.mockResolvedValue()
    mockHandleZoomChange.mockReset()
    mockHandleZoomChange.mockResolvedValue(undefined)
    mockWaitForInitialLayoutCommit.mockReset()
    mockWaitForInitialLayoutCommit.mockResolvedValue(undefined)
    mockGetPending.mockReset()
    mockClearPending.mockReset()
    mockSetPending.mockReset()
    mockReadUrl.mockReset()
    mockReadUrl.mockReturnValue(null)
    mockWriteUrl.mockReset()
    mockPendingState = null
    browser.runtime.onMessage.addListener.mockClear()
    browser.runtime.onMessage.removeListener.mockClear()
    window.matchMedia.mockReset()
    window.matchMedia.mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
    createMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllTimers()
  })

  it('delegates previous-page toolbar intent through navigation', () => {
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('previous-page')

    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(4)
  })

  it('uses manual browser scroll restoration only while mounted', async () => {
    const hadOwnProperty = Object.hasOwn(history, 'scrollRestoration')
    const originalDescriptor = Object.getOwnPropertyDescriptor(history, 'scrollRestoration')
    let value = 'auto'
    Object.defineProperty(history, 'scrollRestoration', {
      configurable: true,
      get: () => value,
      set: (nextValue) => { value = nextValue }
    })

    try {
      const wrapper = mount(PdfApp)
      await flushPromises()

      expect(value).toBe('manual')
      wrapper.unmount()
      expect(value).toBe('auto')
    } finally {
      if (hadOwnProperty && originalDescriptor) {
        Object.defineProperty(history, 'scrollRestoration', originalDescriptor)
      } else {
        delete history.scrollRestoration
      }
    }
  })

  it('delegates next-page toolbar intent through navigation', () => {
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('next-page')

    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(6)
  })

  it('does not continue bootstrap after unmount while OCR initialization is pending', async () => {
    const init = createDeferred()
    const mediaQuery = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const documentAddListenerSpy = vi.spyOn(document, 'addEventListener')
    vi.stubEnv('DEV', true)
    window.matchMedia.mockImplementation(() => mediaQuery)
    ocrStoreMock.init.mockReturnValue(init.promise)

    const wrapper = mount(PdfApp)
    await nextTick()
    documentAddListenerSpy.mockClear()
    browser.runtime.onMessage.addListener.mockClear()
    wrapper.unmount()

    init.resolve()
    await Promise.resolve()
    await nextTick()

    expect(pdfDiagnosticsImportMock).not.toHaveBeenCalled()
    expect(browser.runtime.onMessage.addListener).not.toHaveBeenCalled()
    expect(mediaQuery.addEventListener).not.toHaveBeenCalled()
    expect(documentAddListenerSpy.mock.calls.some(([eventName]) => eventName === 'keydown')).toBe(false)

    documentAddListenerSpy.mockRestore()
  })

  it('registers bootstrap side effects after OCR initialization while mounted', async () => {
    const init = createDeferred()
    const mediaQuery = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const documentAddListenerSpy = vi.spyOn(document, 'addEventListener')
    vi.stubEnv('DEV', true)
    window.matchMedia.mockImplementation(() => mediaQuery)
    ocrStoreMock.init.mockReturnValue(init.promise)

    const wrapper = mount(PdfApp)
    await nextTick()
    documentAddListenerSpy.mockClear()
    browser.runtime.onMessage.addListener.mockClear()

    init.resolve()
    await Promise.resolve()
    await nextTick()

    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledOnce()
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(documentAddListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))

    wrapper.unmount()
    documentAddListenerSpy.mockRestore()
  })

  it('does not continue bootstrap when OCR initialization rejects after unmount', async () => {
    const init = createDeferred()
    const mediaQuery = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const documentAddListenerSpy = vi.spyOn(document, 'addEventListener')
    vi.stubEnv('DEV', true)
    window.matchMedia.mockImplementation(() => mediaQuery)
    ocrStoreMock.init.mockReturnValue(init.promise)

    const wrapper = mount(PdfApp)
    await nextTick()
    documentAddListenerSpy.mockClear()
    browser.runtime.onMessage.addListener.mockClear()
    wrapper.unmount()

    init.reject(new Error('OCR cache unavailable'))
    await Promise.resolve()
    await nextTick()

    expect(pdfDiagnosticsImportMock).not.toHaveBeenCalled()
    expect(browser.runtime.onMessage.addListener).not.toHaveBeenCalled()
    expect(mediaQuery.addEventListener).not.toHaveBeenCalled()
    expect(documentAddListenerSpy.mock.calls.some(([eventName]) => eventName === 'keydown')).toBe(false)

    documentAddListenerSpy.mockRestore()
  })

  it('renders the status banner outside the viewer content flow when active', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult()),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    createMocks()

    const wrapper = mount(PdfApp)
    await startRegionComparison(wrapper)
    await vi.waitFor(() => expect(wrapper.find('.pdf-status-banner').exists()).toBe(true))

    const banner = wrapper.find('.pdf-status-banner')
    const content = wrapper.find('.pdf-app__content')
    const viewerLayout = wrapper.find('.pdf-viewer-layout-stub')

    expect(banner.exists()).toBe(true)
    expect(wrapper.find('.pdf-app__status-row').exists()).toBe(true)
    expect(viewerLayout.exists()).toBe(true)
    expect(content.exists()).toBe(true)
    expect(content.element.contains(banner.element)).toBe(false)
    expect(banner.element.parentElement?.closest('.pdf-app__content')).toBeNull()
  })

  it('hides the status banner cleanly when idle', async () => {
    createMocks({
      bannerState: null
    })

    const wrapper = mount(PdfApp)

    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
    expect(wrapper.find('.pdf-app__status-row').exists()).toBe(false)
    expect(wrapper.find('.pdf-viewer-layout-stub').exists()).toBe(true)
  })

  it('completes successful page translation activity once', async () => {
    const deferred = createDeferred()
    createMocks()
    mockViewerController.translateVisiblePages.mockImplementation(() => deferred.promise)
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    deferred.resolve(true)
    await vi.waitFor(() => expect(activityCompletedMock).toHaveBeenCalledOnce())

    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
    expect(translationPartialMock).not.toHaveBeenCalled()
    expect(translationFailedMock).not.toHaveBeenCalled()
  })

  it('presents partial page translation through its canonical event', async () => {
    createMocks()
    mockViewerController.translationSummary.value = {
      status: 'partial',
      translatedCount: 1,
      failedCount: 1,
      totalCount: 2,
      translationOccurrenceId: 7,
      error: 'Provider failed',
      failureReason: 'provider-error'
    }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await vi.waitFor(() => expect(translationPartialMock).toHaveBeenCalledOnce())

    expect(translationPartialMock).toHaveBeenCalledWith(expect.objectContaining({
      occurrenceId: 7,
      error: 'Generic PDF translation error',
      reason: 'provider-error',
    }))
    expect(translationPartialMock.mock.calls[0][0].error).not.toContain('Provider failed')
  })

  it('presents failed page translation through its canonical event', async () => {
    createMocks()
    mockViewerController.translationSummary.value = {
      status: 'error',
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      translationOccurrenceId: 8,
      error: 'Translation request failed',
      failureReason: 'provider-error'
    }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await vi.waitFor(() => expect(translationFailedMock).toHaveBeenCalledOnce())

    expect(translationFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      occurrenceId: 8,
      error: 'Generic PDF translation error',
      reason: 'provider-error',
    }))
    expect(translationFailedMock.mock.calls[0][0].error).not.toContain('Translation request failed')
  })

  it('uses structured PDF error identity for summary presentation', async () => {
    createMocks()
    mockViewerController.translationSummary.value = {
      status: 'error',
      translatedCount: 0,
      failedCount: 1,
      totalCount: 1,
      translationOccurrenceId: 11,
      error: 'raw provider body with model list',
      errorDetails: { message: 'raw provider diagnostic', type: 'MODEL_NOT_FOUND' },
      failureReason: 'provider-error'
    }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await vi.waitFor(() => expect(translationFailedMock).toHaveBeenCalledOnce())

    expect(pdfTranslationErrorPresenterMock).toHaveBeenCalledWith(expect.objectContaining({
      error: 'raw provider body with model list',
      errorDetails: { message: 'raw provider diagnostic', type: 'MODEL_NOT_FOUND' },
      failureReason: 'provider-error'
    }))
    expect(translationFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Localized model error',
      errorDetails: { message: 'raw provider diagnostic', type: 'MODEL_NOT_FOUND' },
      reason: 'provider-error'
    }))
    expect(translationFailedMock.mock.calls[0][0].error).not.toContain('raw provider')
  })

  it('keeps structured context failure silent at summary boundary', async () => {
    createMocks()
    mockViewerController.translationSummary.value = {
      status: 'error',
      translatedCount: 0,
      failedCount: 1,
      totalCount: 1,
      translationOccurrenceId: 12,
      error: 'raw context diagnostic',
      errorDetails: { message: 'raw context diagnostic', type: 'EXTENSION_CONTEXT_INVALIDATED' },
      failureReason: 'provider-error'
    }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()

    expect(translationFailedMock).not.toHaveBeenCalled()
  })

  it('completes page translation once when cancelled from the progress bar', async () => {
    const deferred = createDeferred()
    createMocks()
    mockViewerController.translateVisiblePages.mockImplementation(() => deferred.promise)
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await wrapper.find('.operation-status__cancel').trigger('click')
    mockViewerController.translationSummary.value = { status: 'partial', translationOccurrenceId: 9, error: 'late failure' }
    deferred.resolve(true)
    await flushPromises()
    await flushPromises()

    expect(mockViewerController.cancelTranslation).toHaveBeenCalledOnce()
    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
    expect(translationPartialMock).not.toHaveBeenCalled()
  })

  it('keeps provider-cancelled page translation silent', async () => {
    createMocks()
    mockViewerController.translationSummary.value = {
      status: 'partial', translationOccurrenceId: 10, error: 'Cancelled', failureReason: 'cancelled'
    }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()

    expect(translationPartialMock).not.toHaveBeenCalled()
    expect(translationFailedMock).not.toHaveBeenCalled()
    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
  })

  it('does not build page banners from initial translationSummary or error state', async () => {
    createMocks()
    mockViewerController.translationSummary.value = { status: 'partial', translationOccurrenceId: 10, error: 'stale summary' }
    mockViewerController.error.value = ''
    const wrapper = mount(PdfApp)
    await flushPromises()

    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
  })

  it.each([
    ['combines metadata title and file name', 'Annual Report', 'annual-report.pdf', 'Annual Report - annual-report.pdf'],
    ['uses metadata title without a file name', 'Annual Report', '', 'Annual Report'],
    ['uses file name without metadata title', '', 'annual-report.pdf', 'annual-report.pdf'],
    ['uses fallback title without document values', '', '', 'PDF Viewer'],
    ['uses fallback title for whitespace-only file name', '', '   ', 'PDF Viewer'],
    ['suppresses duplicate metadata title and file name', 'annual-report.pdf', 'annual-report.pdf', 'annual-report.pdf'],
    ['ignores whitespace-only metadata title', '   ', 'annual-report.pdf', 'annual-report.pdf']
  ])('sets browser title: %s', (_, metadataTitle, fileName, expectedTitle) => {
    createMocks({ sessionAsRef: false })
    mockPdfSession.documentMetadata.title = metadataTitle
    mockPdfSession.fileName = fileName

    mount(PdfApp)

    expect(document.title).toBe(expectedTitle)
  })

  it('uses the localized PDF Viewer name for the empty browser title', () => {
    createMocks({ sessionAsRef: false })
    tMock.mockImplementation((key, fallback) => key === 'pdf_app_title' ? 'نمایشگر PDF' : fallback ?? key)

    mount(PdfApp)

    expect(document.title).toBe('نمایشگر PDF')
  })

  it('updates the fallback browser title when configured-locale messages load after mount', async () => {
    createMocks({ sessionAsRef: false })
    localeMock.value = 'ja'
    mount(PdfApp)

    expect(document.title).toBe('PDF Viewer')
    localeMessagesMock.value = { ja: { pdf_app_title: 'PDFビューアー' } }
    await nextTick()

    expect(document.title).toBe('PDFビューアー')
    localeMock.value = 'fa'
    await nextTick()

    expect(document.title).toBe('PDF Viewer')
    localeMessagesMock.value = {
      ja: { pdf_app_title: 'PDFビューアー' },
      fa: { pdf_app_title: 'نمایشگر PDF' }
    }
    await nextTick()

    expect(document.title).toBe('نمایشگر PDF')
  })

  it.each([
    ['metadata and filename', 'Annual Report', 'annual-report.pdf', 'Annual Report - annual-report.pdf'],
    ['filename only', '', 'annual-report.pdf', 'annual-report.pdf']
  ])('preserves the %s browser title while locale translations load', async (_, metadataTitle, fileName, expectedTitle) => {
    createMocks({ sessionAsRef: false })
    localeMock.value = 'ja'
    mockPdfSession.documentMetadata.title = metadataTitle
    mockPdfSession.fileName = fileName
    mount(PdfApp)

    localeMessagesMock.value = { ja: { pdf_app_title: 'PDFビューアー' } }
    await nextTick()

    expect(document.title).toBe(expectedTitle)
  })

  it('updates browser title when replacing a document', async () => {
    createMocks({ sessionAsRef: false })
    mockViewerController.loadPdfFile
      .mockImplementationOnce(async () => {
        mockPdfSession.documentMetadata.title = 'First Report'
        mockPdfSession.fileName = 'first.pdf'
        return true
      })
      .mockImplementationOnce(async () => {
        mockPdfSession.documentMetadata.title = 'Second Report'
        mockPdfSession.fileName = 'second.pdf'
        return true
      })
    const wrapper = mount(PdfApp)

    const dropzone = wrapper.findComponent({ name: 'PdfDropzone' })
    dropzone.vm.$emit('file-selected', { name: 'first.pdf' })
    await flushPromises()
    await flushPromises()
    expect(document.title).toBe('First Report - first.pdf')

    dropzone.vm.$emit('file-selected', { name: 'second.pdf' })
    await flushPromises()
    await flushPromises()
    expect(document.title).toBe('Second Report - second.pdf')
  })

  it('resets browser title after a failed document load', async () => {
    createMocks({ sessionAsRef: false })
    mockPdfSession.documentMetadata.title = 'Previous Report'
    mockPdfSession.fileName = 'previous.pdf'
    mockViewerController.loadPdfFile.mockImplementation(async () => {
      mockPdfSession.documentMetadata.title = ''
      mockPdfSession.fileName = ''
      return false
    })
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'failed.pdf' })
    await flushPromises()
    await flushPromises()

    expect(document.title).toBe('PDF Viewer')
  })

  it('reveals translated pages side by side after a successful page translation', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translationSummary.value = { status: 'translated' }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await vi.waitFor(() => expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side'))
    await vi.waitFor(() => expect(activityCompletedMock).toHaveBeenCalledOnce())

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
    expect(mockViewerMode.setLayoutMode.mock.invocationCallOrder[0])
      .toBeLessThan(activityCompletedMock.mock.invocationCallOrder[0])
  })

  it('reveals partial page translations side by side', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translationSummary.value = { status: 'partial', translationOccurrenceId: 17 }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await vi.waitFor(() => expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side'))

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
  })

  it('reveals OCR-backed page translations from the translated PDF view', async () => {
    createMocks({ sessionAsRef: false })
    mockPdfSession.getPageContentSource.mockReturnValue(pageContentSourceMock.OCR)
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translationSummary.value = { status: 'translated' }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('current-page-change', 1)
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()
    await flushPromises()

    expect(mockPdfSession.getPageContentSource).toHaveBeenCalledWith(1)
    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
  })

  it.each([
    pageContentSourceMock.PDF_TEXT,
    pageContentSourceMock.NONE,
    pageContentSourceMock.MIXED
  ])('keeps translated PDF view for %s page content', async (pageContentSource) => {
    createMocks({ sessionAsRef: false })
    mockPdfSession.getPageContentSource.mockReturnValue(pageContentSource)
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translationSummary.value = { status: 'translated' }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('current-page-change', 1)
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()

    expect(mockPdfSession.getPageContentSource).toHaveBeenCalledWith(1)
    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('does not override a viewer mode selected while page translation is running', async () => {
    const deferred = createDeferred()
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translateVisiblePages.mockImplementation(() => deferred.promise)
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    mockViewerMode.contentView.value = 'translated-pdf'
    mockViewerController.translationSummary.value = { status: 'translated' }
    deferred.resolve(true)
    await flushPromises()
    await flushPromises()

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('keeps original view when a completed translation has no displayable content', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.translationSummary.value = { status: 'translated' }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('does not reveal after a failed page translation', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockViewerController.translationSummary.value = { status: 'error' }
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('translate-visible')
    await flushPromises()
    await flushPromises()

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  async function startRegionComparison(wrapper, region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })) {
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-region-comparison')
    await flushPromises()
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()
    return region
  }

  async function startRegionOcr(wrapper, region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })) {
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
    await flushPromises()
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()
    return region
  }

  function readyRegionComparisonResult(candidateId = 'scale-1') {
    return {
      status: 'ready',
      results: [{
        candidateId,
        configuration: { scale: 1.5 },
        runtime: { latencyMs: 42 },
        output: { status: 'recognized', data: { text: 'hello', confidence: 95 } },
        evaluation: { cer: { characterErrorRate: 0.2 } },
        runtimeLanguage: 'fas'
      }],
      summary: { totalCandidates: 1, completedCandidates: 1, totalElapsedMs: 42 }
    }
  }

  it('shows a dismissible developer notification after a successful regionComparison', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult()),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await vi.waitFor(() => expect(wrapper.find('.pdf-status-banner').exists()).toBe(true))

    expect(wrapper.findAll('.pdf-region-comparison-notification__results tbody td').map(cell => cell.text())).toEqual([
      'scale-1', '1.5', 'fas', '42ms', '95', '0.200', 'Winner'
    ])
    await wrapper.find('.pdf-status-banner__dismiss').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.pdf-status-banner').exists()).toBe(false))
  })

  it('shows a developer error notification after regionComparison failure', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      Promise.reject(new Error('OCR worker unavailable')),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await vi.waitFor(() => expect(wrapper.find('.pdf-status-banner').exists()).toBe(true))

    expect(wrapper.find('.pdf-message-notification').text()).toBe('OCR worker unavailable')
  })

  it('does not notify after regionComparison cancellation', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const deferred = createDeferred()
    const cancel = vi.fn(() => deferred.resolve({
      status: 'cancelled',
      results: [],
      summary: { totalCandidates: 1, completedCandidates: 0, totalElapsedMs: 0 }
    }))
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(deferred.promise, cancel, { target: 'region-comparison', request }))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('cancel-region-comparison')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await flushPromises()

    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
  })

  it('completes progress once when cancelling regionComparison from the progress bar', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const deferred = createDeferred()
    const cancel = vi.fn()
    const { toast } = await import('vue-sonner')
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(deferred.promise, cancel, { target: 'region-comparison', request }))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await wrapper.find('.operation-status__cancel').trigger('click')
    await flushPromises()

    expect(cancel).toHaveBeenCalledOnce()
    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'PdfToolbar' }).props('regionComparisonState')).toMatchObject({ status: 'cancelled' })

    deferred.resolve({
      status: 'cancelled',
      results: [],
      summary: { totalCandidates: 1, completedCandidates: 0, totalElapsedMs: 0 }
    })
    await flushPromises()
    await flushPromises()

    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('handles synchronous regionComparison startup failure as one terminal lifecycle', async () => {
    vi.useFakeTimers()
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementation(() => {
      throw new Error('OCR worker unavailable')
    })
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await vi.advanceTimersByTimeAsync(200)

    expect(wrapper.findComponent({ name: 'PdfToolbar' }).props('regionComparisonState')).toMatchObject({ status: 'failed' })
    expect(wrapper.find('.pdf-message-notification').text()).toBe('OCR worker unavailable')
    expect(wrapper.find('.operation-status').exists()).toBe(false)
    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
  })

  it('replaces a dismissed developer notification on the next regionComparison lifecycle', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementationOnce(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult('scale-1')),
      vi.fn(),
      { target: 'region-comparison', request }
    )).mockImplementationOnce(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult('scale-1.5')),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await vi.waitFor(() => expect(wrapper.find('.pdf-status-banner__dismiss').exists()).toBe(true))
    await wrapper.find('.pdf-status-banner__dismiss').trigger('click')
    await startRegionComparison(wrapper, createPdfRegion({ pageNumber: 2, left: 1, top: 4, right: 3, bottom: 2 }))
    await vi.waitFor(() => expect(wrapper.text()).toContain('scale-1.5'))
  })

  it('blocks direct Region Comparison requests outside Debug Mode', async () => {
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult()),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-region-comparison')
    await flushPromises()

    expect(regionComparisonRunnerMock.execute).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(false)
    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
  })

  it('blocks direct Region Comparison artifact export outside Debug Mode', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      Promise.resolve(readyRegionComparisonResult()),
      vi.fn(),
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    await vi.waitFor(() => expect(wrapper.findComponent({ name: 'PdfToolbar' }).props('canExportRegionComparisonArtifact')).toBe(true))
    settingsStoreMock.settings.DEBUG_MODE = false
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('export-region-comparison-artifact')

    expect(downloadFileMock).not.toHaveBeenCalled()
  })

  it('cancels comparison selection when Debug Mode is disabled before selection completes', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(Promise.resolve({ status: 'cancelled' })))
    const wrapper = mount(PdfApp)
    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })

    toolbar.vm.$emit('request-region-comparison')
    await flushPromises()
    expect(viewer.props('regionSelectionActive')).toBe(true)

    settingsStoreMock.settings.DEBUG_MODE = false
    await nextTick()
    viewer.vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
    await flushPromises()

    expect(viewer.props('regionSelectionActive')).toBe(false)
    expect(regionComparisonRunnerMock.execute).not.toHaveBeenCalled()
  })

  it('keeps a running comparison active when Debug Mode is disabled', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const deferred = createDeferred()
    const cancel = vi.fn()
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      deferred.promise,
      cancel,
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    settingsStoreMock.settings.DEBUG_MODE = false
    await nextTick()
    deferred.resolve(readyRegionComparisonResult())
    await vi.waitFor(() => expect(wrapper.findComponent({ name: 'PdfToolbar' }).props('regionComparisonState')).toMatchObject({ status: 'completed' }))

    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps OCR selection active when Debug Mode is disabled', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const wrapper = mount(PdfApp)
    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })

    toolbar.vm.$emit('primary-click')
    await flushPromises()
    settingsStoreMock.settings.DEBUG_MODE = false
    await nextTick()

    expect(viewer.props('regionSelectionActive')).toBe(true)
  })

  it('refreshes OCR page wrappers before incrementing translationTick on OCR completion', async () => {
    createMocks()
    const order = []
    mockViewerController.refreshTranslatedPageBlocks.mockImplementation(() => {
      order.push(`refresh:${mockViewerController.translationTick.value}`)
      return true
    })

    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [2, 1] })

    expect(mockViewerController.refreshTranslatedPageBlocks).toHaveBeenCalledWith([2, 1])
    expect(mockViewerController.translationTick.value).toBe(1)
    expect(order).toEqual(['refresh:0'])
    expect(mockPdfOcr.refreshOcrRecommendations).toHaveBeenCalled()
    expect(mockViewerController.recomputeLayout).not.toHaveBeenCalled()
  })

  it('reveals OCR results side by side from the original view', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [1] })

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
    expect(mockViewerController.refreshTranslatedPageBlocks.mock.invocationCallOrder[0])
      .toBeLessThan(mockViewerMode.setContentView.mock.invocationCallOrder[0])
    expect(mockViewerMode.setLayoutMode.mock.invocationCallOrder[0])
      .toBeLessThan(activityCompletedMock.mock.invocationCallOrder[0])
  })

  it('reveals OCR results side by side from the translated PDF view', async () => {
    createMocks()
    mockViewerController.hasTranslationContent.value = true
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [1] })

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
  })

  it('preserves Translation view after successful OCR', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'translation'
    mockViewerController.hasTranslationContent.value = true
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [1] })

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('refreshes partial OCR page wrappers from the terminal error callback', async () => {
    createMocks()
    mount(PdfApp)
    await flushPromises()

    mockPdfOcrOptions.onOcrError('ocr-failed', { pageNumbers: [2, 1] })

    expect(mockViewerController.refreshTranslatedPageBlocks).toHaveBeenCalledWith([2, 1])
    expect(mockViewerController.translationTick.value).toBe(1)
    expect(mockPdfOcr.refreshOcrRecommendations).toHaveBeenCalled()
  })

  it('does not reveal after an OCR error', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mount(PdfApp)
    await flushPromises()

    mockPdfOcrOptions.onOcrError('ocr-failed', { pageNumbers: [1] })

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('does not reveal OCR results without translated content', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [1] })

    expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    expect(mockViewerMode.setLayoutMode).not.toHaveBeenCalled()
  })

  it('commits the OCR page once after the automatic reveal layout commit', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockPdfNavigation.currentPage.value = 7
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [7] })

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledTimes(1)
    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(7)
  })

  it('waits for the layout commit before committing the OCR page', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockPdfNavigation.currentPage.value = 7
    let resolveLayoutCommit
    mockWaitForInitialLayoutCommit.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLayoutCommit = resolve
    }))
    mount(PdfApp)
    await flushPromises()

    const completion = mockPdfOcrOptions.onOcrComplete({ pageNumbers: [7] })
    await vi.waitFor(() => expect(typeof resolveLayoutCommit).toBe('function'))

    expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()

    resolveLayoutCommit()
    await completion
    await flushPromises()

    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledTimes(1)
    expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(7)
  })

  it('does not commit the OCR page when the layout commit is cancelled', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockPdfNavigation.currentPage.value = 7
    mockWaitForInitialLayoutCommit.mockResolvedValueOnce({ cancelled: true })
    mount(PdfApp)
    await flushPromises()

    await mockPdfOcrOptions.onOcrComplete({ pageNumbers: [7] })

    expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
    expect(mockViewerMode.setLayoutMode).toHaveBeenCalledWith('side-by-side')
    expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
  })

  it('does not commit a stale OCR page to a replaced document', async () => {
    createMocks()
    mockViewerMode.contentView.value = 'original'
    mockViewerController.hasTranslationContent.value = true
    mockPdfNavigation.currentPage.value = 7
    let resolveLayoutCommit
    mockWaitForInitialLayoutCommit.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLayoutCommit = resolve
    }))
    mount(PdfApp)
    await flushPromises()

    const completion = mockPdfOcrOptions.onOcrComplete({ pageNumbers: [7] })
    await vi.waitFor(() => expect(typeof resolveLayoutCommit).toBe('function'))
    mockPdfSession.documentGeneration += 1
    resolveLayoutCommit()
    await completion
    await flushPromises()

    expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
  })

  it('builds OCR RegionExecutionRequest and preserves recognized-text handoff', async () => {
    createMocks({ sessionAsRef: false })

    mockRegionOcr.startRegionOcr.mockImplementation(() => {
      mockRegionOcrOptions.onRecognized?.({ text: ' recognized text ', lines: [], confidence: 99 })
      return createMockOperation(Promise.resolve({ status: 'recognized', data: { text: 'recognized text', lines: [], confidence: 99 } }))
    })

    const wrapper = mount(PdfApp)
    await flushPromises()

    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()
    await flushPromises()

    expect(mockRegionExecutionDispatch).toHaveBeenCalledOnce()
    expect(mockRegionExecutionDispatch.mock.calls[0][0]).toEqual({
      region,
      target: 'ocr',
      scope: 'live-region'
    })
    expect(mockRegionOcr.startRegionOcr).toHaveBeenCalledOnce()
    expect(mockRegionOcr.startRegionOcr).toHaveBeenCalledWith(expect.objectContaining({
      region,
      scale: PDF_REGION_OCR_RENDER_SCALE
    }))

    await vi.waitFor(() => {
      expect(openTranslationMock).toHaveBeenCalledWith({
        text: 'recognized text',
        position: {
          x: 50,
          y: 68,
          width: 4,
          height: 4,
          _isViewportRelative: true
        }
      })
    })
  })

  it('arms one region selection from the toolbar and dispatches through PdfApp ownership', async () => {
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(Promise.resolve({ status: 'cancelled' })))
    const wrapper = mount(PdfApp)
    await flushPromises()

    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })
    toolbar.vm.$emit('primary-click')
    await flushPromises()

    expect(viewer.props('regionSelectionActive')).toBe(true)

    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    viewer.vm.$emit('region-selection-complete', region)
    await flushPromises()

    expect(viewer.props('regionSelectionActive')).toBe(false)
    expect(mockRegionExecutionDispatch).toHaveBeenCalledOnce()
    expect(mockRegionExecutionDispatch.mock.calls[0][0]).toEqual(expect.objectContaining({ region, target: 'ocr' }))
    expect(mockRegionOcr.startRegionOcr).toHaveBeenCalledOnce()
  })

  it('prevents region selection and shows guidance when no OCR language is installed', async () => {
    const { toast } = await import('vue-sonner')
    ocrStoreMock.downloadedLanguages = []
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
    await flushPromises()

    expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(false)
    expect(mockRegionExecutionDispatch).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No OCR language installed'))
  })

  it('prevents page OCR and shows guidance when no OCR language is installed', async () => {
    const { toast } = await import('vue-sonner')
    settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'page'
    ocrStoreMock.downloadedLanguages = []
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
    await flushPromises()

    expect(mockPdfOcr.requestOcr).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No OCR language installed'))
  })

  it('starts page OCR progress only after the composable confirms work', async () => {
    settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'page'
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
    await flushPromises()

    expect(mockPdfOcr.requestOcr).toHaveBeenCalledOnce()
    expect(wrapper.find('.operation-status__cancel').exists()).toBe(false)

    mockPdfOcrOptions.onOcrStart()
    await flushPromises()

    expect(wrapper.find('.progress-indicator').exists()).toBe(true)
  })

  it('keeps the OCR Manage Languages entry point routed to options', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('manage-languages')

    expect(openOptionsPageMock).toHaveBeenCalledWith('ocr')
  })

  it('completes a regionComparison and exports its artifact through PdfApp ownership', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    downloadFileMock.mockReset()
    const candidates = Object.freeze([Object.freeze({
      candidateId: 'scale-1',
      configuration: Object.freeze({ scale: 1 })
    })])
    const results = Object.freeze([Object.freeze({
      candidateId: 'scale-1',
      configuration: candidates[0].configuration,
      runtime: Object.freeze({ latencyMs: 40 }),
      output: Object.freeze({ status: 'recognized' })
    })])
    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    const runRegionComparison = vi.spyOn(PdfDeveloperApi.prototype, 'runRegionComparison')
      .mockReturnValue(createMockOperation(Promise.resolve({
        status: 'ready',
        candidates,
        results,
        summary: Object.freeze({ totalCandidates: 1, completedCandidates: 1, startedAt: 0, completedAt: 40, totalElapsedMs: 40 })
      }), vi.fn(), { target: 'region-comparison', request: { region } }))
    const wrapper = mount(PdfApp)
    await flushPromises()

    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })
    toolbar.vm.$emit('request-region-comparison')
    await flushPromises()

    expect(viewer.props('regionSelectionActive')).toBe(true)

    viewer.vm.$emit('region-selection-complete', region)
    await flushPromises()

    expect(viewer.props('regionSelectionActive')).toBe(false)
    expect(runRegionComparison).toHaveBeenCalledWith({ region })
    expect(mockRegionOcr.startRegionOcr).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(toolbar.props('regionComparisonState')).toMatchObject({
      status: 'completed',
      progress: { totalCandidates: 1, completedCandidates: 1 }
    }))
    expect(toolbar.props('canExportRegionComparisonArtifact')).toBe(true)
    toolbar.vm.$emit('export-region-comparison-artifact')
    expect(downloadFileMock).toHaveBeenCalledWith(
      expect.stringContaining('"artifactType": "region-comparison"'),
      'region-comparison-artifact.json',
      'application/json'
    )
    const { toast } = await import('vue-sonner')
    expect(toast.success).toHaveBeenCalledWith('JSON exported successfully')
    runRegionComparison.mockRestore()
  })

  it('reports regionComparison artifact download failure through the export contract', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    downloadFileMock.mockImplementation(() => {
      throw new Error('Disk full')
    })
    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    const runRegionComparison = vi.spyOn(PdfDeveloperApi.prototype, 'runRegionComparison')
      .mockReturnValue(createMockOperation(Promise.resolve({
        status: 'ready',
        candidates: Object.freeze([]),
        results: Object.freeze([]),
        summary: Object.freeze({ totalCandidates: 0, completedCandidates: 0, startedAt: 0, completedAt: 0, totalElapsedMs: 0 })
      }), vi.fn(), { target: 'region-comparison', request: { region } }))
    const wrapper = mount(PdfApp)
    await startRegionComparison(wrapper, region)
    await vi.waitFor(() => expect(wrapper.findComponent({ name: 'PdfToolbar' }).props('canExportRegionComparisonArtifact')).toBe(true))

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('export-region-comparison-artifact')

    const { toast } = await import('vue-sonner')
    expect(toast.error).toHaveBeenCalledWith('Disk full')
    runRegionComparison.mockRestore()
  })

  it('ignores a late regionComparison cancellation result', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const deferred = createDeferred()
    const cancel = vi.fn()
    const runRegionComparison = vi.spyOn(PdfDeveloperApi.prototype, 'runRegionComparison')
      .mockReturnValue(createMockOperation(deferred.promise, cancel))
    const wrapper = mount(PdfApp)
    await flushPromises()
    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })
    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })

    toolbar.vm.$emit('request-region-comparison')
    await flushPromises()
    viewer.vm.$emit('region-selection-complete', region)
    await flushPromises()
    expect(toolbar.props('regionComparisonState')).toMatchObject({ status: 'running' })

    toolbar.vm.$emit('cancel-region-comparison')
    expect(cancel).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(toolbar.props('regionComparisonState')).toMatchObject({ status: 'cancelled' }))

    deferred.resolve({
      status: 'cancelled',
      results: Object.freeze([Object.freeze({ candidateId: 'scale-1' })]),
      summary: Object.freeze({ totalCandidates: 2, completedCandidates: 1, totalElapsedMs: 40 })
    })
    await flushPromises()

    await vi.waitFor(() => expect(toolbar.props('regionComparisonState')).toMatchObject({
      status: 'cancelled',
      progress: { totalCandidates: 0, completedCandidates: 0 },
      results: []
    }))
    runRegionComparison.mockRestore()
  })

  it('toggles selection off with toolbar cancel and Escape', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()
    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    const viewer = wrapper.findComponent({ name: 'PdfViewer' })

    toolbar.vm.$emit('primary-click')
    await flushPromises()
    expect(viewer.props('regionSelectionActive')).toBe(true)

    toolbar.vm.$emit('primary-click')
    await flushPromises()
    expect(viewer.props('regionSelectionActive')).toBe(false)

    toolbar.vm.$emit('primary-click')
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(viewer.props('regionSelectionActive')).toBe(false)
  })

  it('returns selection to idle on document replacement', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(true)

    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(false)
  })

  it('detaches navigation before loading a replacement PDF', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    expect(mockPdfNavigation.detachDocument).toHaveBeenCalled()
    expect(mockPdfNavigation.detachDocument.mock.invocationCallOrder[0])
      .toBeLessThan(mockViewerController.loadPdfFile.mock.invocationCallOrder[0])
  })

  it('hides the previous outline action until replacement outline is available', async () => {
    const loading = createDeferred()
    mockViewerController.loadPdfFile.mockReturnValueOnce(loading.promise)
    mockPdfNavigation.outline.value = [{ title: 'Document A', dest: [1] }]
    const wrapper = mount(PdfApp)
    await flushPromises()

    expect(wrapper.find('.pdf-toolbar__outline-toggle').exists()).toBe(true)

    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    expect(wrapper.find('.pdf-toolbar__outline-toggle').exists()).toBe(false)

    mockPdfNavigation.outline.value = [{ title: 'Document B', dest: [2] }]
    loading.resolve(true)
    await flushPromises()

    expect(wrapper.find('.pdf-toolbar__outline-toggle').exists()).toBe(true)
  })

  it('keeps cancelled Region OCR silent', async () => {
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(Promise.resolve({ status: 'failed', error: new Error('cancelled') })))
    const wrapper = mount(PdfApp)
    await flushPromises()

    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    toolbar.vm.$emit('primary-click')
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).not.toContain('OCR failed. Please try another region.')
  })

  it('emits one completion on progress-bar Region OCR cancel and ignores late outcome', async () => {
    const deferred = createDeferred()
    const cancel = vi.fn()
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(deferred.promise, cancel))
    mockRegionOcr.cancelRegionOcr.mockImplementation(cancel)
    const { toast } = await import('vue-sonner')
    const wrapper = mount(PdfApp)
    await flushPromises()

    await startRegionOcr(wrapper)
    await wrapper.find('.operation-status__cancel').trigger('click')
    await flushPromises()

    expect(cancel).toHaveBeenCalledOnce()
    expect(activityCompletedMock).toHaveBeenCalledTimes(1)

    deferred.resolve({ status: 'recognized', data: { text: 'late text', lines: [], confidence: 1 } })
    await flushPromises()
    await flushPromises()

    expect(activityCompletedMock).toHaveBeenCalledTimes(1)
    expect(openTranslationMock).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
  })

  it('presents Region OCR no-text, missing-language, and failure outcomes', async () => {
    const { toast } = await import('vue-sonner')
    const outcomes = [
      [{ status: 'recognized', data: { text: '   ' } }, 'warning', 'No text found in the selected region.'],
      [{ status: 'failed', error: new Error('model-not-installed') }, 'error', 'No OCR language installed.'],
      [{ status: 'failed', error: new Error('worker failed') }, 'error', 'Region OCR failed. Try another region.']
    ]

    for (const [result, severity, message] of outcomes) {
      mockRegionOcr.startRegionOcr.mockReturnValueOnce(createMockOperation(Promise.resolve(result)))
      const wrapper = mount(PdfApp)
      await flushPromises()

      await startRegionOcr(wrapper)
      await flushPromises()

      expect(toast[severity]).toHaveBeenCalledWith(expect.stringContaining(message))
      wrapper.unmount()
      toast.error.mockClear()
      toast.warning.mockClear()
    }
  })

  it('owns the OCR-only execution mode and rejects unsupported toolbar intent', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()

    const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
    expect(toolbar.props('executionMode')).toBe('ocr')
    expect(toolbar.props('executionModes')).toEqual(['ocr'])

    toolbar.vm.$emit('execution-mode-change', 'region-comparison')
    await flushPromises()

    expect(toolbar.props('executionMode')).toBe('ocr')
    expect(mockPdfSession).not.toHaveProperty('executionMode')
  })

  it('keeps dispatched request target immutable after later mode intent', async () => {
    let resolveOcr
    mockRegionOcr.startRegionOcr.mockImplementation(() => createMockOperation(new Promise((resolve) => {
      resolveOcr = resolve
    })))

    const wrapper = mount(PdfApp)
    await flushPromises()

    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()

    const request = mockRegionExecutionDispatch.mock.calls[0][0]
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('execution-mode-change', 'region-comparison')
    await flushPromises()

    expect(mockRegionExecutionDispatch).toHaveBeenCalledOnce()
    expect(request).toEqual({ region, target: 'ocr', scope: 'live-region' })
    expect(Object.isFrozen(request)).toBe(true)

    resolveOcr({ status: 'cancelled' })
    await flushPromises()
  })

  it('cancels active Region OCR before loading a replacement PDF', async () => {
    const order = []
    const operationCancel = vi.fn(() => order.push('operation-cancel'))
    let resolveOcr
    mockRegionOcr.startRegionOcr.mockImplementation(() => createMockOperation(new Promise((resolve) => {
      resolveOcr = resolve
    }), operationCancel))
    mockRegionOcr.cancelRegionOcr.mockImplementation(() => {
      order.push('cancel-region-ocr')
      operationCancel()
    })
    mockViewerController.loadPdfFile.mockImplementation(() => {
      order.push('load-pdf')
      return Promise.resolve(true)
    })

    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
    await flushPromises()
    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    expect(mockRegionOcr.cancelRegionOcr).toHaveBeenCalledOnce()
    expect(operationCancel).toHaveBeenCalledOnce()
    expect(order).toEqual(['cancel-region-ocr', 'operation-cancel', 'load-pdf'])

    resolveOcr({ status: 'cancelled' })
  })

  it('suppresses late recognized handoff after PDF replacement', async () => {
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(new Promise(() => {})))

    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
    await flushPromises()
    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()
    mockRegionOcrOptions.onRecognized({ text: 'late text', lines: [], confidence: 99 })
    await flushPromises()

    expect(mockRegionOcr.cancelRegionOcr).toHaveBeenCalledOnce()
    expect(openTranslationMock).not.toHaveBeenCalled()
  })

  it('cancels Page OCR before loading a replacement PDF', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()

    mockPdfOcrOptions.onOcrStart()
    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    expect(mockPdfOcr.cancelOcr).toHaveBeenCalledOnce()
  })

  it('cancels Region Comparison and discards its artifact on PDF replacement', async () => {
    settingsStoreMock.settings.DEBUG_MODE = true
    const deferred = createDeferred()
    const cancel = vi.fn()
    regionComparisonRunnerMock.execute.mockImplementation(request => createMockOperation(
      deferred.promise,
      cancel,
      { target: 'region-comparison', request }
    ))
    const wrapper = mount(PdfApp)

    await startRegionComparison(wrapper)
    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()
    deferred.resolve(readyRegionComparisonResult())
    await flushPromises()
    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('export-region-comparison-artifact')

    expect(cancel).toHaveBeenCalledOnce()
    expect(wrapper.find('.pdf-status-banner').exists()).toBe(false)
    expect(downloadFileMock).not.toHaveBeenCalled()
  })

  it('cancels Page OCR across rapid PDF replacements', async () => {
    const wrapper = mount(PdfApp)
    await flushPromises()

    mockPdfOcrOptions.onOcrStart()
    const dropzone = wrapper.findComponent({ name: 'PdfDropzone' })
    dropzone.vm.$emit('file-selected', { name: 'replacement-a.pdf' })
    dropzone.vm.$emit('file-selected', { name: 'replacement-b.pdf' })
    await flushPromises()

    expect(mockPdfOcr.cancelOcr).toHaveBeenCalledTimes(2)
    expect(mockViewerController.loadPdfFile).toHaveBeenCalledTimes(2)
  })

  it('keeps completed Region OCR behavior through document replacement', async () => {
    createMocks({ sessionAsRef: false })
    mockRegionOcr.startRegionOcr.mockImplementation(() => {
      mockRegionOcrOptions.onRecognized({ text: 'recognized text', lines: [], confidence: 99 })
      return createMockOperation(Promise.resolve({ status: 'recognized', data: { text: 'recognized text', lines: [], confidence: 99 } }))
    })

    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
    await flushPromises()
    wrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    await vi.waitFor(() => {
      expect(openTranslationMock).toHaveBeenCalledOnce()
    })
    expect(mockRegionOcr.cancelRegionOcr).toHaveBeenCalledOnce()
    expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith({ name: 'replacement.pdf' }, expect.any(Object))
  })

  it('keeps execution mode through document replacement and cancels no active Region OCR', async () => {
    const firstWrapper = mount(PdfApp)
    await flushPromises()

    firstWrapper.findComponent({ name: 'PdfDropzone' }).vm.$emit('file-selected', { name: 'replacement.pdf' })
    await flushPromises()

    expect(firstWrapper.findComponent({ name: 'PdfToolbar' }).props('executionMode')).toBe('ocr')
    expect(mockRegionOcr.cancelRegionOcr).toHaveBeenCalledOnce()
    expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith({ name: 'replacement.pdf' }, expect.any(Object))
    firstWrapper.unmount()

    const secondWrapper = mount(PdfApp)
    await flushPromises()

    expect(secondWrapper.findComponent({ name: 'PdfToolbar' }).props('executionMode')).toBe('ocr')
  })

  it('does not open translation for failed OCR result', async () => {
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(Promise.resolve({ status: 'failed', error: new Error('failed') })))

    const wrapper = mount(PdfApp)
    await flushPromises()

    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()
    await flushPromises()

    expect(mockRegionExecutionDispatch).toHaveBeenCalledOnce()
    expect(openTranslationMock).not.toHaveBeenCalled()
  })

  it('does not open translation for cancelled OCR result', async () => {
    mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(Promise.resolve({ status: 'cancelled' })))

    const wrapper = mount(PdfApp)
    await flushPromises()

    const region = createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 })
    wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', region)
    await flushPromises()
    await flushPromises()

    expect(mockRegionExecutionDispatch).toHaveBeenCalledOnce()
    expect(openTranslationMock).not.toHaveBeenCalled()
  })

  it('falls back to hidden file input when the Chromium picker is unavailable', async () => {
    createMocks()

    const wrapper = mount(PdfApp)
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    let currentValue = 'stale.pdf'
    Object.defineProperty(fileInput.element, 'value', {
      configurable: true,
      get: () => currentValue,
      set: (next) => {
        currentValue = next
      }
    })
    const clickSpy = vi.spyOn(fileInput.element, 'click').mockImplementation(() => {
      expect(currentValue).toBe('')
    })

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await flushPromises()

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(browserTabStateMock.write).not.toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('uses Chromium picker and forwards selected file to the loading pipeline', async () => {
    const file = new File(['pdf'], 'chromium.pdf', { type: 'application/pdf' })
    const getFile = vi.fn().mockResolvedValue(file)
    const showOpenFilePicker = vi.fn().mockResolvedValue([{ getFile }])
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker)
    const wrapper = mount(PdfApp)
    await flushPromises()
    const inputClick = vi.spyOn(wrapper.find('input[type="file"]').element, 'click')

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await vi.waitFor(() => expect(browserTabStateMock.write).toHaveBeenCalledOnce())

    expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }))
    expect(getFile).toHaveBeenCalledOnce()
    expect(browserTabStateMock.write).toHaveBeenCalledWith({ fileHandle: expect.objectContaining({ getFile }) })
    expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'chromium.pdf' }), expect.any(Object))
    expect(inputClick).not.toHaveBeenCalled()
  })

  it('silently ignores Chromium picker cancellation', async () => {
    const showOpenFilePicker = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker)
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await flushPromises()

    expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
    expect(browserTabStateMock.write).not.toHaveBeenCalled()
  })

  it('uses stored picker handle as startIn', async () => {
    const storedHandle = { getFile: vi.fn() }
    const file = new File(['pdf'], 'stored.pdf', { type: 'application/pdf' })
    browserTabStateMock.read.mockReturnValue({ fileHandle: storedHandle })
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]))
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await vi.waitFor(() => expect(globalThis.showOpenFilePicker).toHaveBeenCalledOnce())

    expect(globalThis.showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({ startIn: storedHandle }))
  })

  it('does not persist picker handle when PDF loading rejects', async () => {
    const file = new File(['pdf'], 'failed.pdf', { type: 'application/pdf' })
    const error = new Error('load failed')
    mockViewerController.loadPdfFile.mockRejectedValueOnce(error)
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]))
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await vi.waitFor(() => expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Failed to open PDF picker.', error))

    expect(browserTabStateMock.write).not.toHaveBeenCalled()
  })

  it('retries without startIn when stored picker handle is rejected', async () => {
    const storedHandle = { getFile: vi.fn() }
    const file = new File(['pdf'], 'retry.pdf', { type: 'application/pdf' })
    browserTabStateMock.read.mockReturnValue({ fileHandle: storedHandle })
    const showOpenFilePicker = vi.fn()
      .mockRejectedValueOnce(new DOMException('invalid handle', 'SecurityError'))
      .mockResolvedValueOnce([{ getFile: vi.fn().mockResolvedValue(file) }])
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker)
    const wrapper = mount(PdfApp)
    await flushPromises()

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await vi.waitFor(() => expect(showOpenFilePicker).toHaveBeenCalledTimes(2))

    expect(showOpenFilePicker).toHaveBeenNthCalledWith(1, expect.objectContaining({ startIn: storedHandle }))
    expect(showOpenFilePicker).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ startIn: expect.anything() }))
    expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Failed to open PDF picker with stored location.', expect.any(DOMException))
    expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'retry.pdf' }), expect.any(Object))
  })

  it('falls back to hidden input when Chromium picker fails', async () => {
    const error = new DOMException('blocked', 'SecurityError')
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockRejectedValue(error))
    const wrapper = mount(PdfApp)
    await flushPromises()
    const inputClick = vi.spyOn(wrapper.find('input[type="file"]').element, 'click')

    wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('request-open-pdf')
    await vi.waitFor(() => expect(pdfAppLoggerMock.warn).toHaveBeenCalledOnce())

    expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Failed to open PDF picker.', error)
    expect(inputClick).toHaveBeenCalledOnce()
    expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
    expect(browserTabStateMock.write).not.toHaveBeenCalled()
  })

  it('loads selected pdf and resets hidden input value', async () => {
    createMocks()

    const wrapper = mount(PdfApp)
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    const file = new File(['pdf'], 'sample.pdf', { type: 'application/pdf' })

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [file]
    })

    fileInput.element.dispatchEvent(new Event('change'))
    await flushPromises()
    await flushPromises()

    expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'sample.pdf' }), expect.any(Object))
    expect(fileInput.element.value).toBe('')
  })

  // ── Rendering modes ──────────────────────────────────────────

  describe('rendering modes', () => {
    it('original + single renders one PdfViewer without overlay', async () => {
      createMocks()
      mockViewerMode.contentView.value = 'original'
      mockViewerMode.selectedLayoutMode.value = 'single'

      const wrapper = mount(PdfApp)
      await flushPromises()

      const viewers = wrapper.findAllComponents({ name: 'PdfViewer' })
      expect(viewers).toHaveLength(1)
      expect(viewers[0].props('viewerRole')).toBe('original')
      expect(viewers[0].props('showOverlay')).toBe(false)
      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).exists()).toBe(false)
    })

    it('translation + single renders only PdfTranslatedPane', async () => {
      createMocks()
      mockViewerMode.contentView.value = 'translation'
      mockViewerMode.selectedLayoutMode.value = 'single'

      const wrapper = mount(PdfApp)
      await flushPromises()

      expect(wrapper.findAllComponents({ name: 'PdfViewer' })).toHaveLength(0)
      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).exists()).toBe(true)
    })

    it('translation + side-by-side renders PdfViewer and PdfTranslatedPane', async () => {
      createMocks()
      mockViewerMode.contentView.value = 'translation'
      mockViewerMode.selectedLayoutMode.value = 'side-by-side'

      const wrapper = mount(PdfApp)
      await flushPromises()

      const viewers = wrapper.findAllComponents({ name: 'PdfViewer' })
      expect(viewers).toHaveLength(1)
      expect(viewers[0].props('viewerRole')).toBe('original')
      expect(viewers[0].props('showOverlay')).toBe(false)
      expect(viewers[0].props('scrollContainer')).toBe(wrapper.findComponent({ name: 'PdfViewerLayout' }).vm.scrollContainer)
      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).exists()).toBe(true)
      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).props('scrollContainer')).toBe(wrapper.findComponent({ name: 'PdfViewerLayout' }).vm.translatedPaneRef)
    })

    it('translated-pdf + single renders one PdfViewer with overlay', async () => {
      createMocks()
      mockViewerMode.contentView.value = 'translated-pdf'
      mockViewerMode.selectedLayoutMode.value = 'single'

      const wrapper = mount(PdfApp)
      await flushPromises()

      const viewers = wrapper.findAllComponents({ name: 'PdfViewer' })
      expect(viewers).toHaveLength(1)
      expect(viewers[0].props('viewerRole')).toBe('original')
      expect(viewers[0].props('showOverlay')).toBe(true)
      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).exists()).toBe(false)
    })

    it('translated-pdf + side-by-side renders two PdfViewers', async () => {
      createMocks()
      mockViewerMode.contentView.value = 'translated-pdf'
      mockViewerMode.selectedLayoutMode.value = 'side-by-side'

      const wrapper = mount(PdfApp)
      await flushPromises()

      const viewers = wrapper.findAllComponents({ name: 'PdfViewer' })
      expect(viewers).toHaveLength(2)

      expect(viewers[0].props('viewerRole')).toBe('original')
      expect(viewers[0].props('showOverlay')).toBe(false)
      expect(viewers[0].props('scrollContainer')).toBe(wrapper.findComponent({ name: 'PdfViewerLayout' }).vm.scrollContainer)
      expect(viewers[0].props('handleNavigationTarget')).toBeTruthy()
      expect(viewers[0].props('freezeRenderWindowEviction')).toBe(false)

      expect(viewers[1].props('viewerRole')).toBe('overlay')
      expect(viewers[1].props('showOverlay')).toBe(true)
      expect(viewers[1].props('scrollContainer')).toBe(wrapper.findComponent({ name: 'PdfViewerLayout' }).vm.translatedPaneRef)
      expect(viewers[1].props('freezeRenderWindowEviction')).toBe(false)
      expect(viewers[1].props('handleNavigationTarget')).toBeTruthy()

      expect(wrapper.findComponent({ name: 'PdfTranslatedPane' }).exists()).toBe(false)
    })
  })

  describe('OCR split button cancel routing', () => {
    it('routes cancel to region OCR when regionOcrState is processing', async () => {
      mockRegionOcr.startRegionOcr.mockReturnValue(createMockOperation(new Promise(() => {})))
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
      await flushPromises()

      wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('region-selection-complete', createPdfRegion({ pageNumber: 1, left: 1, top: 4, right: 3, bottom: 2 }))
      await flushPromises()

      expect(mockRegionExecutionDispatch).toHaveBeenCalled()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')

      expect(mockRegionOcr.cancelRegionOcr).toHaveBeenCalledOnce()
      expect(mockPdfOcr.cancelOcr).not.toHaveBeenCalled()
    })

    it('routes cancel to page OCR when page OCR is processing', async () => {
      mockPdfOcr.isOcrProcessing.value = true
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')

      expect(mockPdfOcr.cancelOcr).toHaveBeenCalledOnce()
      expect(mockRegionOcr.cancelRegionOcr).not.toHaveBeenCalled()
    })

    it('routes cancel to region OCR when in selecting state', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
      await flushPromises()

      expect(mockPdfOcr.cancelOcr).not.toHaveBeenCalled()
      expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(false)
    })

    it('does not cancel when nothing is active', async () => {
      mockPdfOcr.isOcrProcessing.value = false
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('primary-click')
      await flushPromises()

      expect(mockPdfOcr.cancelOcr).not.toHaveBeenCalled()
      expect(mockRegionOcr.cancelRegionOcr).not.toHaveBeenCalled()
      expect(wrapper.findComponent({ name: 'PdfViewer' }).props('regionSelectionActive')).toBe(true)
    })
  })

  describe('OCR action and language persistence', () => {
    it('persists preferred action on select-action', async () => {
      settingsStoreMock.updateSettingAndPersist.mockClear()
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('select-action', 'page')

      expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledWith('OCR_PREFERRED_ACTION', 'page')
    })

    it('persists language on select-language', async () => {
      settingsStoreMock.updateSettingAndPersist.mockClear()
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('select-language', 'fas')

      expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledWith('OCR_DEFAULT_LANG', 'fas')
    })

    it('handles preferred-action persistence rejection without unhandled rejection', async () => {
      const failures = []
      const onUnhandled = (reason) => failures.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        settingsStoreMock.updateSettingAndPersist.mockClear()
        settingsStoreMock.updateSettingAndPersist.mockRejectedValueOnce(new Error('storage failed'))
        const wrapper = mount(PdfApp)
        await flushPromises()

        wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('select-action', 'page')
        await flushPromises()
        await flushPromises()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledWith('OCR_PREFERRED_ACTION', 'page')
        expect(pdfAppLoggerMock.warn).toHaveBeenCalled()
        expect(failures).toHaveLength(0)
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('handles language persistence rejection without unhandled rejection', async () => {
      const failures = []
      const onUnhandled = (reason) => failures.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        settingsStoreMock.updateSettingAndPersist.mockClear()
        settingsStoreMock.updateSettingAndPersist.mockRejectedValueOnce(new Error('storage failed'))
        const wrapper = mount(PdfApp)
        await flushPromises()

        wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('select-language', 'fas')
        await flushPromises()
        await flushPromises()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(settingsStoreMock.updateSettingAndPersist).toHaveBeenCalledWith('OCR_DEFAULT_LANG', 'fas')
        expect(pdfAppLoggerMock.warn).toHaveBeenCalled()
        expect(failures).toHaveLength(0)
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  })

  describe('OCR highlight reactivity', () => {
    it('updates currentPageContainsOcr after page OCR completes on current page', async () => {
      createMocks({ sessionAsRef: false })
      ocrStoreMock.downloadedLanguages = []
      const wrapper = mount(PdfApp)
      await flushPromises()

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      expect(toolbar.props('ocrViewModel').currentPageContainsOcr).toBe(false)
      expect(toolbar.props('ocrViewModel').hasInstalledLanguages).toBe(false)

      wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('current-page-change', 0)
      await flushPromises()

      mockViewerController.session.getCommittedOcrState.mockReturnValue({ ocrBlocks: [{ text: 'hello' }], ocrLanguage: 'eng' })
      mockPdfOcr.isOcrProcessing.value = true
      mockPdfOcrOptions.onOcrComplete({ pageNumbers: [1] })
      mockPdfOcr.isOcrProcessing.value = false
      await flushPromises()

      expect(toolbar.props('ocrViewModel').currentPageContainsOcr).toBe(true)
    })
  })

  describe('OCR preferred action validation', () => {
    it('defaults invalid OCR_PREFERRED_ACTION to region', async () => {
      settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'invalid'
      const wrapper = mount(PdfApp)
      await flushPromises()

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      expect(toolbar.props('ocrViewModel').preferredAction).toBe('region')
    })

    it('accepts valid region value', async () => {
      settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'region'
      const wrapper = mount(PdfApp)
      await flushPromises()

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      expect(toolbar.props('ocrViewModel').preferredAction).toBe('region')
    })

    it('accepts valid page value', async () => {
      settingsStoreMock.settings.OCR_PREFERRED_ACTION = 'page'
      const wrapper = mount(PdfApp)
      await flushPromises()

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      expect(toolbar.props('ocrViewModel').preferredAction).toBe('page')
    })
  })

  describe('PDF Information dialog', () => {
    it('opens dialog on request-document-info from toolbar', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      expect(wrapper.findComponent({ name: 'PdfDocumentInfoDialog' }).props('modelValue')).toBe(false)

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      toolbar.vm.$emit('request-document-info')
      await flushPromises()

      expect(wrapper.findComponent({ name: 'PdfDocumentInfoDialog' }).props('modelValue')).toBe(true)
    })
  })

  describe('Remote URL dialog', () => {
    it('opens the dialog from the Open PDF Link toolbar action', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      const dialog = wrapper.findComponent({ name: 'PdfRemoteUrlDialog' })
      expect(dialog.props('visible')).toBe(false)
      expect(wrapper.find('.pdf-remote-url-overlay').exists()).toBe(false)

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('open-remote-pdf')
      await flushPromises()

      expect(dialog.props('visible')).toBe(true)
      expect(wrapper.find('.pdf-remote-url-overlay').exists()).toBe(true)
    })

    it('closes the dialog and hides its overlay on close', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('open-remote-pdf')
      await flushPromises()
      expect(wrapper.find('.pdf-remote-url-overlay').exists()).toBe(true)

      wrapper.findComponent({ name: 'PdfRemoteUrlDialog' }).vm.$emit('close')
      await flushPromises()

      expect(wrapper.findComponent({ name: 'PdfRemoteUrlDialog' }).props('visible')).toBe(false)
      await vi.waitFor(() => expect(wrapper.find('.pdf-remote-url-overlay').exists()).toBe(false))
    })

    it('submits a valid URL through the existing remote loading flow', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfToolbar' }).vm.$emit('open-remote-pdf')
      await flushPromises()

      const url = 'https://example.com/document.pdf'
      await wrapper.find('.pdf-remote-url-dialog__input').setValue(url)
      await wrapper.find('.pdf-remote-url-dialog form').trigger('submit')
      await flushPromises()

      expect(mockViewerController.openPdfUrl).toHaveBeenCalledWith(url, expect.anything())
      expect(browserTabStateMock.write).toHaveBeenCalledWith({ remoteUrl: url })
      expect(wrapper.findComponent({ name: 'PdfRemoteUrlDialog' }).props('visible')).toBe(false)
      await vi.waitFor(() => expect(wrapper.find('.pdf-remote-url-overlay').exists()).toBe(false))
    })
  })

  function pendingState(overrides = {}) {
    return createViewerState({
      documentIdentity: 'loaded-doc-id',
      currentPage: 8,
      contentView: 'translation',
      ...overrides,
    })
  }

  describe('Restore pipeline', () => {
    async function simulateFileOpen(wrapper) {
      const file = new File([''], 'test.pdf', { type: 'application/pdf' })
      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [file],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()
    }

    it('restores full viewer state on identity match', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalled()

      // ordering: contentView → navigateToPage → clearPending
      const cv = mockViewerMode.setContentView.mock.invocationCallOrder[0]
      const np = mockPdfNavigation.navigateToPage.mock.invocationCallOrder[0]
      const cp = mockClearPending.mock.invocationCallOrder[0]
      expect(cv).toBeLessThan(np)
      expect(np).toBeLessThan(cp)
    })

    it('waits for pending initial layout commit before navigating once', async () => {
      let resolveLayoutCommit
      mockWaitForInitialLayoutCommit.mockImplementationOnce(() => new Promise(resolve => {
        resolveLayoutCommit = resolve
      }))
      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockWaitForInitialLayoutCommit).toHaveBeenCalledOnce()
      expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
      expect(mockClearPending).not.toHaveBeenCalled()

      resolveLayoutCommit()
      await flushPromises()

      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledTimes(1)
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalledOnce()
    })

    it('does not navigate a replacement document after pending layout commit', async () => {
      let resolveLayoutCommit
      mockWaitForInitialLayoutCommit.mockImplementationOnce(() => new Promise(resolve => {
        resolveLayoutCommit = resolve
      }))
      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()
      mockPdfSession.documentGeneration += 1
      resolveLayoutCommit()
      await flushPromises()

      expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
      expect(mockClearPending).not.toHaveBeenCalled()
    })

    it('does not navigate when initial layout wait is cancelled', async () => {
      mockWaitForInitialLayoutCommit.mockResolvedValueOnce({ cancelled: true })
      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
      expect(mockClearPending).not.toHaveBeenCalled()
    })

    it('does not restore on identity mismatch', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState({ documentIdentity: 'different-id' })

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
      expect(mockHandleZoomChange).not.toHaveBeenCalled()
      expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
      expect(mockClearPending).toHaveBeenCalled()
    })

    it('keeps pending state on load failure', async () => {
      mockViewerController.loadPdfFile.mockResolvedValueOnce(false)

      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockClearPending).not.toHaveBeenCalled()
      expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
    })

    it('restores viewer state after a retried load succeeds', async () => {
      mockViewerController.hasDocument.value = false
      mockViewerController.loadFailure.value = { kind: 'TIMEOUT', details: {} }
      mockViewerController.loadPdfFile.mockResolvedValueOnce(false)

      const wrapper = mount(PdfApp)
      await flushPromises()
      mockPendingState = pendingState()

      await simulateFileOpen(wrapper)
      await flushPromises()

      expect(mockClearPending).not.toHaveBeenCalled()

      const retryButton = wrapper.find('.pdf-load-failure-banner__retry')
      expect(retryButton.exists()).toBe(true)
      await retryButton.trigger('click')
      await flushPromises()

      expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalled()
    })
  })

  describe('Startup restore', () => {
    const remoteUrl = 'https://example.com/remote.pdf'

    afterEach(() => {
      window.history.pushState({}, '', window.location.pathname)
    })

    it('restores a stored local file handle through the load pipeline', async () => {
      const file = new File([''], 'restored.pdf', { type: 'application/pdf' })
      browserTabStateMock.read.mockReturnValue({
        fileHandle: { getFile: vi.fn().mockResolvedValue(file) }
      })

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.loadPdfFile).toHaveBeenCalledWith(file, expect.anything())
        expect(mockViewerController.openPdfUrl).not.toHaveBeenCalled()
      })
    })

    it('does not auto-load anything when no restore source exists', async () => {
      browserTabStateMock.read.mockReturnValue(null)

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(browserTabStateMock.read).toHaveBeenCalled()
      })

      expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
      expect(mockViewerController.openPdfUrl).not.toHaveBeenCalled()
    })

    it('loads a remote URL from the ?remote= startup param', async () => {
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.openPdfUrl).toHaveBeenCalledWith(remoteUrl, expect.anything())
        expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
        expect(window.location.search).toBe('')
      })
    })

    it('loads a stored remote URL from BrowserTabState on startup', async () => {
      browserTabStateMock.read.mockReturnValue({ remoteUrl })

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.openPdfUrl).toHaveBeenCalledWith(remoteUrl, expect.anything())
        expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
      })
    })

    it('restores a remote PDF after a successful load and remount', async () => {
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)
      mockReadUrl.mockReturnValue(pendingState())

      const wrapper = mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.openPdfUrl).toHaveBeenCalledWith(remoteUrl, expect.anything())
      })
      await vi.waitFor(() => expect(mockClearPending).toHaveBeenCalled())

      expect(browserTabStateMock.write).toHaveBeenCalledWith({ remoteUrl })
      expect(window.location.search).toBe('')

      wrapper.unmount()

      browserTabStateMock.read.mockReturnValue({ remoteUrl })
      mockReadUrl.mockReturnValue(pendingState())
      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.openPdfUrl).toHaveBeenCalledWith(remoteUrl, expect.anything())
      })
      await vi.waitFor(() => {
        expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
      })
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalled()
    })

    it('skips restore when ?remote= and a stored remote URL both exist', async () => {
      browserTabStateMock.read.mockReturnValue({ remoteUrl })
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Ambiguous PDF restore sources detected. Skipping restore.')
      })

      expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
      expect(mockViewerController.openPdfUrl).not.toHaveBeenCalled()
    })

    it('skips restore when multiple sources exist', async () => {
      const file = new File([''], 'restored.pdf', { type: 'application/pdf' })
      browserTabStateMock.read.mockReturnValue({
        fileHandle: { getFile: vi.fn().mockResolvedValue(file) }
      })
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Ambiguous PDF restore sources detected. Skipping restore.')
      })

      expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
      expect(mockViewerController.openPdfUrl).not.toHaveBeenCalled()
    })

    it('does not auto-restore when the file handle getFile fails', async () => {
      browserTabStateMock.read.mockReturnValue({
        fileHandle: { getFile: vi.fn().mockRejectedValue(new Error('handle revoked')) }
      })

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(pdfAppLoggerMock.warn).toHaveBeenCalledWith('Failed to restore local PDF file handle.', expect.any(Error))
      })

      expect(mockViewerController.loadPdfFile).not.toHaveBeenCalled()
      expect(mockViewerController.openPdfUrl).not.toHaveBeenCalled()
    })

    it('restores viewer state for a stored local file on identity match', async () => {
      const file = new File([''], 'restored.pdf', { type: 'application/pdf' })
      browserTabStateMock.read.mockReturnValue({
        fileHandle: { getFile: vi.fn().mockResolvedValue(file) }
      })
      mockReadUrl.mockReturnValue(pendingState())

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
      })
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalled()
    })

    it('restores viewer state for a remote URL on identity match', async () => {
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)
      mockReadUrl.mockReturnValue(pendingState())

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerMode.setContentView).toHaveBeenCalledWith('translation')
      })
      expect(mockPdfNavigation.navigateToPage).toHaveBeenCalledWith(8)
      expect(mockClearPending).toHaveBeenCalled()
    })

    it('preserves pending viewer state when remote startup load fails', async () => {
      window.history.pushState({}, '', `/?remote=${remoteUrl}`)
      mockReadUrl.mockReturnValue(pendingState())
      mockViewerController.openPdfUrl.mockResolvedValueOnce(false)

      mount(PdfApp)
      await flushPromises()

      await vi.waitFor(() => {
        expect(mockViewerController.openPdfUrl).toHaveBeenCalled()
      })

      expect(mockViewerMode.setContentView).not.toHaveBeenCalled()
      expect(mockPdfNavigation.navigateToPage).not.toHaveBeenCalled()
      expect(mockClearPending).not.toHaveBeenCalled()
    })
  })

  describe('Viewer State URL write', () => {
    it('writes Viewer State on successful document open', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      const file = new File([''], 'test.pdf', { type: 'application/pdf' })
      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [file],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()

      expect(mockWriteUrl).toHaveBeenCalled()
      const state = mockWriteUrl.mock.calls[0][0]
      expect(state.documentIdentity).toBe('loaded-doc-id')
      expect(state.contentView).toBe('translated-pdf')
    })

    it('does not write on failed document load', async () => {
      mockViewerController.loadPdfFile.mockResolvedValueOnce(false)

      const wrapper = mount(PdfApp)
      await flushPromises()

      const file = new File([''], 'test.pdf', { type: 'application/pdf' })
      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        value: [file],
        writable: false,
      })
      await fileInput.trigger('change')
      await flushPromises()

      expect(mockWriteUrl).not.toHaveBeenCalled()
    })

    it('writes updated page on currentPage change', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      wrapper.findComponent({ name: 'PdfViewer' }).vm.$emit('current-page-change', 12)
      await flushPromises()

      expect(mockWriteUrl).toHaveBeenCalled()
      const state = mockWriteUrl.mock.calls[0][0]
      expect(state.documentIdentity).toBe('loaded-doc-id')
      expect(state.currentPage).toBe(12)
      expect(state.contentView).toBe('translated-pdf')
    })

    it('writes updated contentView on view change', async () => {
      const wrapper = mount(PdfApp)
      await flushPromises()

      const toolbar = wrapper.findComponent({ name: 'PdfToolbar' })
      await toolbar.vm.$emit('content-view-change', 'translation')
      await flushPromises()

      expect(mockWriteUrl).toHaveBeenCalled()
      const state = mockWriteUrl.mock.calls[0][0]
      expect(state.documentIdentity).toBe('loaded-doc-id')
      expect(state.currentPage).toBe(5)
      expect(state.contentView).toBe('translation')
    })
  })

  describe('Failure presentation', () => {
    it('renders PdfLoadFailureBanner when loadFailure exists', () => {
      mockViewerController.hasDocument.value = false
      mockViewerController.loadFailure.value = { kind: 'TIMEOUT', details: {} }
      const wrapper = mount(PdfApp)

      const banner = wrapper.find('.pdf-load-failure-banner')
      expect(banner.exists()).toBe(true)
      expect(banner.find('.pdf-load-failure-banner__title').text()).toBe('Connection timed out')
      expect(banner.find('.pdf-load-failure-banner__description').text()).toBe('The server did not respond in time. Please check your connection and try again.')

      expect(wrapper.find('.pdf-app__empty').exists()).toBe(false)
    })

    it('renders original empty state when loadFailure is null', () => {
      mockViewerController.hasDocument.value = false
      mockViewerController.loadFailure.value = null
      const wrapper = mount(PdfApp)

      expect(wrapper.find('.pdf-load-failure-banner').exists()).toBe(false)
      expect(wrapper.find('.pdf-app__empty').exists()).toBe(true)
    })

    it('passes only presentation model to banner, never raw producer data', () => {
      mockViewerController.hasDocument.value = false
      mockViewerController.loadFailure.value = { kind: 'TIMEOUT', details: {} }
      const wrapper = mount(PdfApp)

      const banner = wrapper.find('.pdf-load-failure-banner')
      expect(banner.exists()).toBe(true)

      const props = wrapper.find('.pdf-load-failure-banner').attributes()
      expect(props).not.toHaveProperty('kind')
      expect(props).not.toHaveProperty('error')
    })
  })
})

<template>
  <div class="pdf-app">
    <PdfToolbar
      :file-name="fileName"
      :page-count="pageCount"
      :current-page-number="currentPageNumber"
      :is-loading="isLoading"
      :is-translating="isTranslating"
      :can-translate-visible-pages="canTranslateVisiblePages"
      :can-export="canExport"
      :ocr-view-model="toolbarOcrModel"
      :content-view="contentView"
      :layout-mode="selectedLayoutMode"
      :zoom-mode="zoomMode"
      :zoom-percent="zoomPercent"
      :show-translation-option="hasTranslationContent"
      :has-outline="hasOutline"
      :is-outline-visible="isOutlineVisible"
      :execution-mode="executionMode"
      :execution-modes="supportedExecutionModes"
      :region-comparison-state="regionComparisonState"
      :can-export-region-comparison-artifact="canExportRegionComparisonArtifact"
      :is-clear-cache-disabled="isClearCacheDisabled"
      :source-language="pdfSourceLanguage"
      :target-language="pdfTargetLanguage"
      @update:source-language="pdfSourceLanguage = $event"
      @update:target-language="pdfTargetLanguage = $event"
      @toggle-outline="toggleOutline"
      @translate-visible="handleTranslateVisiblePages"
      @cancel-translation="handleCancelTranslation"
      @content-view-change="onContentViewChange"
      @layout-mode-change="handleLayoutModeChange"
      @zoom-step="handleZoomStep"
      @zoom-change="handleZoomChange"
      @export-txt="handleExportTxt"
      @export-markdown="handleExportMarkdown"
      @export-html="handleExportHtml"
      @request-region-comparison="handleRequestRegionComparison"
      @cancel-region-comparison="handleCancelRegionComparison"
      @export-region-comparison-artifact="handleExportRegionComparisonArtifact"
      @clear-cache="handleClearCache"
      @request-open-pdf="requestOpenPdf"
      @open-remote-pdf="showRemoteUrlDialog = true"
      @execution-mode-change="handleExecutionModeChange"
      @primary-click="handleOcrPrimaryClick"
      @select-action="handleOcrSelectAction"
      @select-language="handleOcrSelectLanguage"
      @manage-languages="handleOcrManageLanguages"
      @open-settings="handleOpenSettings"
      @request-document-info="showPdfInfo = true"
      @previous-page="navigateToPage(currentPageNumber - 1)"
      @next-page="navigateToPage(currentPageNumber + 1)"
      @go-to-page="navigateToPage($event)"
    >
      <template #leading>
        <PdfAppBrand
          v-if="!hasDocument"
          :icon-src="pdfBrandIcon"
          :title="t('pdf_app_title', 'PDF Viewer')"
          :subtitle="t('subtitle_app_powered_by', 'Powered by Translate It')"
        />
      </template>
    </PdfToolbar>

    <ProgressIndicator
      v-if="showProgressIndicator"
      :progress="progressOperation.progress"
      :indeterminate="progressOperation.indeterminate"
    />

    <OperationStatus
      v-if="showOperationStatus"
      :title="progressOperation.title"
      :cancellable="progressOperation.cancellable"
      @cancel="handleProgressCancel"
    />

    <input
      ref="fileInput"
      class="pdf-app__file-input"
      hidden
      type="file"
      accept="application/pdf,.pdf"
      @change="handleFileInputChange"
    >

    <div class="pdf-app__viewport">
      <div class="pdf-app__status-layer">
        <Transition
          name="pdf-banner"
          mode="out-in"
        >
          <div
            v-if="isPdfStatusBannerVisible"
            class="pdf-app__status-row"
          >
            <PdfStatusBanner
              :body="pdfStatusBanner.body || null"
              :dismissible="pdfStatusBanner.dismissible"
              @dismiss="dismissPdfStatusBanner"
            >
              <template #body="{ body }">
                <PdfNotificationBodyRenderer :body="body" />
              </template>
            </PdfStatusBanner>
          </div>
        </Transition>
      </div>

      <main class="pdf-app__content">
        <div class="pdf-app__workspace">
          <PdfOutline
            :outline="pdfOutline"
            :visible="isOutlineVisible && hasOutline"
            :active-dest="activeOutlineDest"
            :expanded-dests="expandedDests"
            @close="isOutlineVisible = false"
            @navigate="handleOutlineNavigate"
          />

          <PdfDropzone
            :has-document="hasDocument"
            :is-drag-over="isDragOver"
            @file-selected="handleFileSelected"
            @drag-state-change="isDragOver = $event"
            @request-open-pdf="requestOpenPdf"
          >
            <template #empty>
              <PdfLoadFailureBanner
                v-if="loadFailurePresentation"
                v-bind="loadFailurePresentation"
                :is-loading="isLoading"
                @retry="handleRetry"
              />
              <div
                v-else
                class="pdf-app__empty"
              >
                <p class="pdf-app__empty-title">
                  Drop a PDF here or choose one from disk.
                </p>
              </div>
            </template>

            <template #document>
              <PdfViewerLayout
                ref="pdfViewerLayoutRef"
                :layout-mode="layoutMode"
                :show-original-pane="showOriginalPane"
                :show-translated-pane="showTranslatedTextPane || showTranslatedPdfPane"
                :suppress-scroll-sync="suppressScrollSync"
              >
                <template
                  v-if="showOriginalPane"
                  #original
                >
                  <PdfViewer
                    ref="pdfViewerRef"
                    :viewer-role="VIEWER_ROLE.ORIGINAL"
                    :pages="pageMetrics"
                    :session="session"
                    :document-load-id="documentLoadId"
                    :suppress-current-page-updates="currentPageUpdatesSuppressed"
                    :freeze-render-window-eviction="renderWindowEvictionFrozen"
                    :show-overlay="showOverlayLayer"
                    :overlay-page-data="translatedPageData"
                    :handle-navigation-target="handleNavigationTarget"
                    :scroll-container="originalScrollContainer"
                    :region-selection-active="regionOcrState === REGION_OCR_STATE.SELECTING"
                    @layout-change="handleLayoutChange"
                    @current-page-change="handleCurrentPageChange"
                    @visible-pages-change="handleVisiblePagesChange"
                    @region-selection-complete="handleRegionSelectionComplete"
                  />
                </template>

                <template #translated>
                  <PdfTranslatedPane
                    v-if="showTranslatedTextPane"
                    ref="pdfTranslatedPaneRef"
                    :translated-page-data="translatedPageData"
                    :page-metrics="pageMetrics"
                    :layout-mode="layoutMode"
                    :scroll-container="translatedScrollContainer"
                    :suppress-current-page-updates="currentPageUpdatesSuppressed"
                    @current-page-change="handleTranslatedPaneCurrentPageChange"
                    @visible-pages-change="handleTranslatedPaneVisiblePages"
                  />
                  <PdfViewer
                    v-if="showTranslatedPdfPane"
                    :viewer-role="VIEWER_ROLE.OVERLAY"
                    :pages="pageMetrics"
                    :session="session"
                    :document-load-id="documentLoadId"
                    :suppress-current-page-updates="currentPageUpdatesSuppressed"
                    :freeze-render-window-eviction="renderWindowEvictionFrozen"
                    :show-overlay="true"
                    :overlay-page-data="translatedPageData"
                    :handle-navigation-target="handleNavigationTarget"
                    :scroll-container="translatedScrollContainer"
                  />
                </template>
              </PdfViewerLayout>
            </template>
          </PdfDropzone>
        </div>
      </main>
    </div>

    <PdfDocumentInfoDialog
      v-model="showPdfInfo"
      :rows="pdfInfoRows"
    />

    <PdfWindowsHost
      ref="pdfWindowsHostRef"
      :pdf-fingerprint="pdfFingerprint"
      :pdf-source-language="pdfSourceLanguage"
      :pdf-target-language="pdfTargetLanguage"
    />

    <Toaster
      rich-colors
      position="bottom-right"
    />

    <PdfOverlayRoot :set-root="setOverlayRoot" />

    <PdfRemoteUrlDialog
      :visible="showRemoteUrlDialog"
      :loading="isRemoteUrlLoading"
      @close="showRemoteUrlDialog = false"
      @submit="handleOpenRemoteUrl"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { Toaster } from 'vue-sonner'
import PdfToolbar from './components/PdfToolbar.vue'
import PdfDropzone from './components/PdfDropzone.vue'
import PdfViewer from './components/PdfViewer.vue'
import PdfViewerLayout from './components/PdfViewerLayout.vue'
import PdfTranslatedPane from './components/PdfTranslatedPane.vue'
import PdfNotificationBodyRenderer from './components/notifications/PdfNotificationBodyRenderer.vue'
import PdfStatusBanner from './components/PdfStatusBanner.vue'
import PdfWindowsHost from './components/PdfWindowsHost.vue'
import PdfOutline from './components/PdfOutline.vue'
import PdfDocumentInfoDialog from './components/PdfDocumentInfoDialog.vue'
import PdfRemoteUrlDialog from './components/PdfRemoteUrlDialog.vue'
import PdfLoadFailureBanner from './components/PdfLoadFailureBanner.vue'
import ProgressIndicator from './components/ProgressIndicator.vue'
import OperationStatus from './components/OperationStatus.vue'
import PdfAppBrand from './components/PdfAppBrand.vue'
import PdfOverlayRoot from './components/PdfOverlayRoot.vue'
import pdfBrandIcon from '@/icons/ui/pdf_viewer/pdf.svg?url'
import { usePdfViewerController } from './composables/usePdfViewerController.js'
import { usePdfViewerMode, CONTENT_VIEW, LAYOUT_MODE, VIEWER_ROLE } from './composables/usePdfViewerMode.js'
import { PAGE_CONTENT_SOURCE } from '@/features/pdf-translation/core/PdfDocumentSession.js'
import { mapPdfLoadFailurePresentation } from '@/features/pdf-translation/failures/mapPdfLoadFailurePresentation.js'
import { usePdfDocumentInfo } from './composables/usePdfDocumentInfo.js'
import { usePdfExport } from './composables/usePdfExport.js'
import { usePdfOcr } from './composables/usePdfOcr.js'
import { usePdfRegionOcr } from './composables/usePdfRegionOcr.js'
import { createRegionExecutionDispatcher } from './composables/regionExecutionDispatcher.js'
import { createRegionExecutionRequest, REGION_EXECUTION_TARGET } from './composables/regionExecutionRequest.js'
import { usePdfNavigation } from './composables/usePdfNavigation.js'
import { usePdfKeyboard } from './composables/usePdfKeyboard.js'
import { createPdfTransitionController } from './composables/createPdfTransitionController.js'
import { createPdfStatusBannerController } from './utils/pdfStatusBanner.js'
import { DomainEvents } from './presentation/domainEvents.js'
import { createPresentationHost } from './presentation/presentationHost.js'
import { createPresentationSurfaces } from './presentation/presentationSurfaces.js'
import { presentPdfTranslationError } from './presentation/PdfTranslationErrorPresenter.js'
import { REGION_OCR_STATE } from './constants/regionOcrState.js'
import { getTesseractLanguageCodeLabel } from '@/features/screen-capture/utils/ocrLanguageMap.js'
import { mapOcrError } from '@/features/ocr/errors/ocrErrorMapper.js'
import { PdfDeveloperApi } from './PdfDeveloperApi.js'
import { RegionComparisonRunner } from './RegionComparisonRunner.js'
import { RegionComparisonAnalyzer } from './RegionComparisonAnalyzer.js'
import { RegionComparisonArtifactWriter } from './RegionComparisonArtifactWriter.js'
import { REGION_COMPARISON_CONFIGURATIONS } from './regionComparisonConfigurations.js'
import { downloadFile } from '@/features/pdf-translation/core/PdfFileDownloader.js'
import { PDF_REGION_OCR_RENDER_SCALE } from '@/features/pdf-translation/core/pdfRenderingConstants.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useOCRStore } from '@/features/screen-capture/stores/ocrStore.js'
import { SUPPORTED_OCR_LANGUAGES } from '@/features/screen-capture/utils/ocrLanguageMap.js'
import { openOptionsPage } from '@/core/helpers.js'
import { applyTheme } from '@/utils/ui/theme.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { OVERLAY_ROOT_KEY } from '@/components/base/ToolbarMenu/keys.js'
import { readViewerStateFromUrl, writeViewerStateToUrl } from '@/features/pdf-translation/core/PdfViewerStateUrlAdapter.js'
import { setPendingViewerState, getPendingViewerState, clearPendingViewerState } from '@/features/pdf-translation/core/PendingViewerState.js'
import { createViewerState } from '@/features/pdf-translation/core/PdfViewerState.js'
import { read as readBrowserTabState, write as writeBrowserTabState } from './utils/PdfBrowserTabState.js'
import './PdfApp.scss'
import 'vue-sonner/style.css'
import '@/assets/styles/components/_toast.scss'

const { t } = useUnifiedI18n()

const overlayRootRef = ref(null)
provide(OVERLAY_ROOT_KEY, overlayRootRef)

function setOverlayRoot(el) {
  overlayRootRef.value = el ?? null
}

const {
  fileName,
  hasDocument,
  isLoading,
  isTranslating,
  canTranslateVisiblePages,
  hasTranslationContent,
  pageCount,
  pageMetrics,
  translationSummary,
  translatedPageData,
  translationTick,
  pdfFingerprint,
  fileSize,
  session,
  pdfSourceLanguage,
  pdfTargetLanguage,
  loadPdfFile,
  loadFailure,
  recomputeLayout,
  openPdfUrl,
  translateVisiblePages,
  hydrateVisiblePageBlocks,
  refreshTranslatedPageBlocks,
  cancelTranslation,
  clearDocumentCache,
  cleanup
} = usePdfViewerController()

const showPdfInfo = ref(false)
const showRemoteUrlDialog = ref(false)
const isRemoteUrlLoading = ref(false)
const lastRetryAction = ref(null)
const loadFailurePresentation = computed(() => {
  if (!loadFailure.value) return null
  return mapPdfLoadFailurePresentation(loadFailure.value)
})

const { rows: pdfInfoRows } = usePdfDocumentInfo(computed(() => ({
  fileName: fileName.value,
  pageCount: pageCount.value,
  fileSize: fileSize.value,
  pageMetrics: pageMetrics.value,
  pdfFingerprint: session.pdfFingerprint,
  documentMetadata: session.documentMetadata,
})))

const {
  contentView,
  layoutMode,
  selectedLayoutMode,
  isSideBySide,
  showOriginalPane,
  showTranslatedTextPane,
  showTranslatedPdfPane,
  showOverlayLayer,
  setContentView,
  setLayoutMode
} = usePdfViewerMode()

const {
  canExport,
  exportError,
  exportTxt,
  exportMarkdown,
  exportHtml
} = usePdfExport(translationTick)

const pdfViewerRef = ref(null)
const pdfWindowsHostRef = ref(null)
const pdfTranslatedPaneRef = ref(null)
const pdfViewerLayoutRef = ref(null)
const fileInput = ref(null)
const documentLoadId = ref(0)
const originalScrollContainer = computed(() => pdfViewerLayoutRef.value?.scrollContainer ?? null)
const translatedScrollContainer = computed(() => pdfViewerLayoutRef.value?.translatedPaneRef ?? null)
const {
  currentPage,
  isNavigating,
  outline: pdfOutline,
  hasOutline,
  activeOutlineDest,
  expandedDests,
  navigateToPage,
  navigateToDestination,
  handleNavigationTarget,
  attachDocument,
  detachDocument
} = usePdfNavigation(pdfViewerRef, pdfTranslatedPaneRef, contentView)
const currentPageNumber = computed(() => Number(currentPage.value) || 0)
const dismissedPdfStatusBannerKey = ref('')
const logger = getScopedLogger(LOG_COMPONENTS.PDF, 'PdfApp')
const ocrStore = useOCRStore()
let activeRegionPosition = null
const regionOcrState = ref(REGION_OCR_STATE.IDLE)
const regionSelectionTarget = ref(null)
const regionComparisonState = ref(null)
let developerNotificationOccurrenceId = 0
const canExportRegionComparisonArtifact = computed(() => regionComparisonState.value?.status === 'completed')
const isClearCacheDisabled = computed(() =>
  isLoading.value ||
  isTranslating.value ||
  isOcrProcessing.value ||
  regionOcrState.value !== REGION_OCR_STATE.IDLE ||
  ['running', 'cancelling'].includes(regionComparisonState.value?.status)
)
const regionOcrAvailable = computed(() => hasDocument.value && showOriginalPane.value)
const supportedExecutionModes = Object.freeze([REGION_EXECUTION_TARGET.OCR])
const executionMode = ref(REGION_EXECUTION_TARGET.OCR)
const pdfStatusBannerController = createPdfStatusBannerController()
const presentation = createPresentationHost({
  surfaces: createPresentationSurfaces()
})

const progressOperation = computed(() => {
  return presentation.progressState.value.operation
})

function writeCurrentViewerState() {
  if (!hasDocument.value) return
  if (!session.documentIdentity) return
  writeViewerStateToUrl(createViewerState({
    documentIdentity: session.documentIdentity,
    currentPage: currentPageNumber.value,
    contentView: contentView.value,
  }))
}

// ── Lifecycle Controller ──────────
// PdfApp owns all lifecycle state and timers.
// Computed properties derive from state — never own timers.
const lifecycleProgressVisible = ref(false)
const lifecycleStatusVisible = ref(false)
let lingerTimer = null

function clearLingerTimer() {
  if (lingerTimer !== null) {
    clearTimeout(lingerTimer)
    lingerTimer = null
  }
}

// Lifecycle controller: reacts to progress state changes
// and transitions lifecycle state. Timers update state.
// Computed properties read state.
watch(
  () => progressOperation.value.running,
  (running) => {
    if (running) {
      clearLingerTimer()
      lifecycleProgressVisible.value = true
      lifecycleStatusVisible.value = true
    } else {
      clearLingerTimer()
      lifecycleStatusVisible.value = false
      lingerTimer = setTimeout(() => {
        lifecycleProgressVisible.value = false
        lingerTimer = null
      }, 200)
    }
  },
  { immediate: true }
)

// Pure computed visibility — derives from lifecycle state only.
// Never owns timers, never performs side effects.
const showProgressIndicator = computed(() => lifecycleProgressVisible.value)
const showOperationStatus = computed(() => lifecycleStatusVisible.value)

let activeProgressCancel = null
let cancelActiveRegionOcr = null
let cancelActiveRegionComparison = null
let cancelActivePageTranslation = null

function handleProgressCancel() {
  const completionHandled = activeProgressCancel?.() === true
  if (!completionHandled) presentation.present(DomainEvents.activityCompleted())
  activeProgressCancel = null
}

const {
  ocrRecommendations,
  isOcrProcessing,
  ocrError,
  refreshOcrRecommendations,
  requestOcr,
  cancelOcr
} = usePdfOcr({
  onOcrStart: () => {
    presentation.present(DomainEvents.ocrStarted())
    activeProgressCancel = cancelOcr
  },
  onOcrComplete: async ({ pageNumbers } = {}) => {
    activeProgressCancel = null
    refreshOcrPageData(pageNumbers)
    if (hasTranslationContent.value && (
      contentView.value === CONTENT_VIEW.ORIGINAL ||
      contentView.value === CONTENT_VIEW.TRANSLATED_PDF
    )) await revealTranslation()
    presentation.present(DomainEvents.activityCompleted())
  },
  onOcrProgress: ({ current, total } = {}) => {
    presentation.present(DomainEvents.ocrProgressUpdated({ current, total }))
  },
  onOcrError: (errorCode, { pageNumbers } = {}) => {
    presentation.present(DomainEvents.activityCompleted())
    activeProgressCancel = null
    presentation.present(errorCode === 'model-not-installed'
      ? DomainEvents.ocrLanguageMissing()
      : DomainEvents.ocrFailed())
    refreshOcrPageData(pageNumbers)
  }
})

const { startRegionOcr, cancelRegionOcr } = usePdfRegionOcr({
  onRecognized: handleRegionOcrRecognized
})
const regionComparisonRunner = new RegionComparisonRunner({
  configurations: REGION_COMPARISON_CONFIGURATIONS,
  getPdfDocument: () => session.pdfDocument,
  onProgress: handleRegionComparisonProgress
})
const regionComparisonArtifactWriter = new RegionComparisonArtifactWriter()
const regionComparisonAnalyzer = new RegionComparisonAnalyzer()
let activeRegionComparisonOperation = null
let completedRegionComparisonResult = null
let completedRegionComparisonRegion = null
let previousScrollRestoration = null
let managesScrollRestoration = false

const regionExecutionDispatcher = createRegionExecutionDispatcher({
  runners: {
    [REGION_EXECUTION_TARGET.OCR]: (request) => startRegionOcr({
      region: request.region,
      pdfDocument: session.pdfDocument,
      scale: PDF_REGION_OCR_RENDER_SCALE,
      language: settingsStore.settings.OCR_DEFAULT_LANG || 'eng'
    }),
    [REGION_EXECUTION_TARGET.REGION_COMPARISON]: (request) => regionComparisonRunner.execute(request, settingsStore.settings.OCR_DEFAULT_LANG || 'eng')
  }
})
const pdfDeveloperApi = new PdfDeveloperApi({ regionExecutionDispatcher })

usePdfKeyboard({
  currentPage,
  totalPages: pageCount,
  navigateToPage,
  containerRef: originalScrollContainer
})

  const {
    handleContentViewChange,
    handleLayoutModeChange,
    handleLayoutChange,
    waitForInitialLayoutCommit,
    handleZoomChange,
    handleZoomStep,
    buildLayoutRequest,
    resetViewerState,
    currentPageUpdatesSuppressed,
    renderWindowEvictionFrozen,
    suppressScrollSync,
    zoomMode,
    zoomPercent
  } = createPdfTransitionController({
    contentView,
    selectedLayoutMode,
    isSideBySide,
    showOriginalPane,
    showTranslatedTextPane,
    showTranslatedPdfPane,
    setContentView,
    setLayoutMode,
    session,
    hasDocument,
    recomputeLayout,
    currentPage,
    originalScrollContainer,
    translatedScrollContainer,
    pdfViewerRef,
    pdfTranslatedPaneRef,
    pdfViewerLayoutRef
  })

function onContentViewChange(value) {
  handleContentViewChange(value)
  writeCurrentViewerState()
}

const isDragOver = ref(false)
const isOutlineVisible = ref(false)

const settingsStore = useSettingsStore()
const isDebugMode = computed(() => settingsStore.settings?.DEBUG_MODE === true)

let removeThemeMessageListener = null
let themeMediaQuery = null
let themeMqHandler = null
let isAlive = true

watch(() => settingsStore.settings.THEME, (theme) => {
  applyTheme(theme || 'auto')
}, { immediate: true })

// Language preloading utility — matches PopupApp/SidepanelApp pattern
const usePreloadLanguages = async () => {
  const { preloadLanguages } = await import('@/composables/shared/useLanguages.js')
  return preloadLanguages()
}

function toggleOutline() {
  isOutlineVisible.value = !isOutlineVisible.value
}

function handleOutlineNavigate(dest) {
  navigateToDestination(dest)
}

function handleExecutionModeChange(mode) {
  if (!supportedExecutionModes.includes(mode)) return
  executionMode.value = mode
}

const toolbarOcrModel = computed(() => {
  const rawAction = settingsStore.settings.OCR_PREFERRED_ACTION
  const preferredAction = (rawAction === 'page' || rawAction === 'region') ? rawAction : 'region'
  const langCode = settingsStore.settings.OCR_DEFAULT_LANG || 'eng'
  const langName = SUPPORTED_OCR_LANGUAGES.find(l => l.code === langCode)?.name || langCode.toUpperCase()
  const processing = regionOcrState.value !== REGION_OCR_STATE.IDLE || isOcrProcessing.value
  const ocrState = session?.getCommittedOcrState?.(currentPage.value)
  const hasOcr = (ocrState?.ocrBlocks?.length ?? 0) > 0
  const shouldRecommendPageOcr = ocrRecommendations.value.includes(currentPage.value)

  return {
    primaryAction: processing ? 'cancel' : preferredAction,
    preferredAction,
    language: { code: langCode, name: langName, compactLabel: getTesseractLanguageCodeLabel(langCode) },
    canCancel: processing,
    currentPageContainsOcr: hasOcr,
    hasDocument: hasDocument.value,
    regionOcrAvailable: regionOcrAvailable.value,
    isPageOcrRecommended: shouldRecommendPageOcr,
    hasInstalledLanguages: ocrStore.downloadedLanguages.length > 0,
    installedLanguages: SUPPORTED_OCR_LANGUAGES
      .filter(lang => ocrStore.downloadedLanguages.includes(lang.code))
      .map(lang => ({
        code: lang.code,
        name: lang.name,
        selected: lang.code === langCode
      }))
  }
})

function showOcrLanguageRequiredMessage() {
  ocrError.value = 'model-not-installed'
  presentation.present(DomainEvents.ocrLanguageMissing())
}

function ensureOcrLanguageInstalled() {
  if (toolbarOcrModel.value.hasInstalledLanguages) return true

  showOcrLanguageRequiredMessage()
  return false
}

function handleOcrPrimaryClick() {
  const model = toolbarOcrModel.value
  if (!model.canCancel) {
    if (!ensureOcrLanguageInstalled()) return

    const action = model.preferredAction
    if (action === 'region') {
      if (!model.regionOcrAvailable) return
      beginRegionSelection(REGION_EXECUTION_TARGET.OCR)
    } else {
      if (!model.hasDocument) return
      startPageOcr()
    }
    return
  }

  if (regionOcrState.value === REGION_OCR_STATE.PROCESSING) {
    cancelActiveRegionOcr?.()
  } else if (regionOcrState.value !== REGION_OCR_STATE.IDLE) {
    setRegionOcrIdle()
  }
  if (isOcrProcessing.value) {
    cancelOcr()
  }
}

function startPageOcr() {
  requestOcr()
}

function refreshOcrPageData(pageNumbers) {
  if (!pageNumbers?.length) return
  refreshTranslatedPageBlocks(pageNumbers)
  translationTick.value += 1
  refreshOcrRecommendations()
}

function handleOcrSelectAction(action) {
  void settingsStore.updateSettingAndPersist('OCR_PREFERRED_ACTION', action).catch(error => {
    logger.warn('Failed to persist OCR_PREFERRED_ACTION:', error);
  });
}

function handleOcrSelectLanguage(langCode) {
  void settingsStore.updateSettingAndPersist('OCR_DEFAULT_LANG', langCode).catch(error => {
    logger.warn('Failed to persist OCR_DEFAULT_LANG:', error);
  });
}

function handleOcrManageLanguages() {
  openOptionsPage('ocr')
}

function handleOpenSettings() {
  openOptionsPage()
}

const pdfStatusBanner = computed(() => pdfStatusBannerController.build({
  notification: isDebugMode.value ? presentation.bannerState.value.notification : null
}))

const isPdfStatusBannerVisible = computed(() => {
  if (!pdfStatusBanner.value) {
    return false
  }
  const dismissed = dismissedPdfStatusBannerKey.value
  const bid = pdfStatusBanner.value.id
  if (dismissed === bid) {
    return false
  }
  return true
})

watch(hasDocument, (has) => {
  if (has) {
    refreshOcrRecommendations()
  }
})

watch(hasTranslationContent, (has) => {
  if (!has && !isTranslating.value && contentView.value !== CONTENT_VIEW.ORIGINAL) {
    setContentView(CONTENT_VIEW.ORIGINAL)
  }
})

watch(regionOcrAvailable, (available) => {
  if (!available) exitRegionSelection()
})

watch(isDebugMode, (enabled) => {
  if (!enabled && regionSelectionTarget.value === REGION_EXECUTION_TARGET.REGION_COMPARISON) {
    exitRegionSelection()
  }
})

function resetPresentationState() {
  currentPage.value = 0
  activeRegionPosition = null
  setRegionOcrIdle()
  resetViewerState()
}

function invalidateDocumentOperations() {
  cancelOcr()
  cancelRegionOcr()
  cancelActiveRegionComparison?.()
  void cancelTranslation()
  activeProgressCancel = null
  cancelActiveRegionOcr = null
  cancelActiveRegionComparison = null
  cancelActivePageTranslation = null
  activeRegionComparisonOperation = null
  completedRegionComparisonResult = null
  completedRegionComparisonRegion = null
  regionComparisonState.value = null
  presentation.reset()
}

function updateDocumentTitle() {
  const metadataTitle = session.documentMetadata?.title?.trim()
  const fileName = session.fileName
  const normalizedFileName = fileName?.trim()
  if (metadataTitle) {
    document.title = normalizedFileName && metadataTitle !== normalizedFileName
      ? `${metadataTitle} - ${fileName}`
      : metadataTitle
    return
  }
  document.title = normalizedFileName ? fileName : t('pdf_app_title', 'PDF Viewer')
}

watch(() => t('pdf_app_title', 'PDF Viewer'), updateDocumentTitle)

function prepareDocumentReplacement() {
  detachDocument()
  invalidateDocumentOperations()
  documentLoadId.value += 1
  resetPresentationState()
}

function finalizeDocumentOpen() {
  void attachDocument(session)
}

async function restoreViewerState() {
  const pending = getPendingViewerState()
  const isMatch = pending && pending.documentIdentity === session.documentIdentity
  const restoredDocumentGeneration = session.documentGeneration

  if (!isMatch) {
    clearPendingViewerState()
  }

  if (isMatch) {
    setContentView(pending.contentView)
    await nextTick()
    const layoutCommit = await waitForInitialLayoutCommit()
    if (layoutCommit?.cancelled) return
    if (session.documentGeneration !== restoredDocumentGeneration) return
    navigateToPage(pending.currentPage)
    clearPendingViewerState()
  } else {
    writeCurrentViewerState()
  }
}

function updateBrowserState() {
  updateDocumentTitle()
}

async function handleFileSelected(file) {
  lastRetryAction.value = () => handleFileSelected(file)
  prepareDocumentReplacement()
  const loaded = await loadPdfFile(file, buildLayoutRequest())
  if (loaded) {
    isDragOver.value = false
    finalizeDocumentOpen()
    await restoreViewerState()
  }
  updateBrowserState()
  return loaded
}

async function handleOpenRemoteUrl(url) {
  lastRetryAction.value = () => handleOpenRemoteUrl(url)
  isRemoteUrlLoading.value = true
  try {
    if (hasDocument.value) {
      prepareDocumentReplacement()
    }
    const loaded = await openPdfUrl(url, buildLayoutRequest())
    if (loaded) {
      showRemoteUrlDialog.value = false
      writeBrowserTabState({ remoteUrl: url })
      finalizeDocumentOpen()
      await restoreViewerState()
    }
    updateBrowserState()
    return loaded
  } finally {
    isRemoteUrlLoading.value = false
  }
}

async function handleRetry() {
  if (!lastRetryAction.value || isLoading.value) return false
  return lastRetryAction.value()
}

async function tryAutoRestore() {
  const params = new URLSearchParams(location.search)
  const remoteUrl = params.get('remote')
  const browserTabState = readBrowserTabState()
  const storedRemoteUrl = browserTabState?.remoteUrl
  const fileHandle = browserTabState?.fileHandle

  const sourceCount = (
    Number(Boolean(remoteUrl))
    + Number(Boolean(storedRemoteUrl))
    + Number(Boolean(fileHandle))
  )

  if (sourceCount > 1) {
    logger.warn('Ambiguous PDF restore sources detected. Skipping restore.')
    return
  }

  if (remoteUrl) {
    const loaded = await handleOpenRemoteUrl(remoteUrl)
    if (loaded) {
      params.delete('remote')
      const url = new URL(location.href)
      url.search = params.toString()
      history.replaceState(history.state, '', url.toString())
    }
    return
  }

  if (storedRemoteUrl) {
    await handleOpenRemoteUrl(storedRemoteUrl)
    return
  }

  if (fileHandle) {
    try {
      const file = await fileHandle.getFile()
      if (file) {
        await handleFileSelected(file)
      }
    } catch (error) {
      logger.warn('Failed to restore local PDF file handle.', error)
    }
  }
}

async function requestOpenPdf() {
  if (typeof globalThis.showOpenFilePicker === 'function') {
    const storedHandle = readBrowserTabState()?.fileHandle
    let fileHandle

    try {
      fileHandle = await pickPdfFile(storedHandle)
    } catch (error) {
      if (error?.name === 'AbortError') return

      if (storedHandle) {
        logger.warn('Failed to open PDF picker with stored location.', error)
        try {
          fileHandle = await pickPdfFile()
        } catch (retryError) {
          if (retryError?.name === 'AbortError') return
          logger.warn('Failed to open PDF picker.', retryError)
          openFileInput()
          return
        }
      } else {
        logger.warn('Failed to open PDF picker.', error)
        openFileInput()
        return
      }
    }

    try {
      const file = await fileHandle?.getFile?.()
      if (file) {
        const loaded = await handleFileSelected(file)
        if (loaded) {
          writeBrowserTabState({ fileHandle })
        }
      }
    } catch (error) {
      logger.warn('Failed to open PDF picker.', error)
      openFileInput()
    }
    return
  }

  openFileInput()
}

function pickPdfFile(startIn = null) {
  const options = {
    multiple: false,
    types: [{
      description: 'PDF files',
      accept: { 'application/pdf': ['.pdf'] },
    }],
  }
  if (startIn) options.startIn = startIn

  return globalThis.showOpenFilePicker(options).then(([fileHandle]) => fileHandle)
}

function openFileInput() {
  const input = fileInput.value
  if (!input) return

  input.value = ''
  input.click()
}

async function handleFileInputChange(event) {
  const [file] = event.target.files || []

  try {
    if (file) {
      await handleFileSelected(file)
    }
  } finally {
    event.target.value = ''
  }
}

function handleCurrentPageChange(pageNumber) {
  if (isNavigating.value) return
  if (!Number.isFinite(Number(pageNumber))) return
  currentPage.value = Number(pageNumber) || 0
  writeCurrentViewerState()
}

function handleVisiblePagesChange(pageNumbers) {
  if (contentView.value !== CONTENT_VIEW.TRANSLATED_PDF) return
  const pages = new Set(pageNumbers || [])
  if (pages.size === 0) return

  void hydrateVisiblePageBlocks(pages)
}

function handleTranslatedPaneVisiblePages(pageNumbers) {
  if (contentView.value !== CONTENT_VIEW.TRANSLATION) return

  session.updateVisiblePages(new Set(pageNumbers))
}

function resolveRegionViewportPosition(region) {
  const pageElement = pdfViewerRef.value?.getPageStageElement?.(region?.pageNumber)
  const viewport = session?.getPageViewport?.(region?.pageNumber)
  const bounds = pageElement?.getBoundingClientRect?.()

  if (!pageElement || !viewport || !bounds) return null

  const topLeft = viewport.convertToViewportPoint(region.left, region.top)
  const bottomRight = viewport.convertToViewportPoint(region.right, region.bottom)
  if (![...topLeft, ...bottomRight, bounds.left, bounds.top].every(Number.isFinite)) return null

  return {
    x: bounds.left + Math.min(topLeft[0], bottomRight[0]),
    y: bounds.top + Math.min(topLeft[1], bottomRight[1]),
    width: Math.abs(bottomRight[0] - topLeft[0]),
    height: Math.abs(bottomRight[1] - topLeft[1]),
    _isViewportRelative: true
  }
}

function handleRegionSelectionComplete(region) {
  const target = regionSelectionTarget.value
  exitRegionSelection()

  if (target === REGION_EXECUTION_TARGET.REGION_COMPARISON) {
    if (!isDebugMode.value) return
    presentation.present(DomainEvents.comparisonStarted())
    completedRegionComparisonResult = null
    completedRegionComparisonRegion = null
    regionComparisonState.value = {
      status: 'running',
      progress: Object.freeze({
        totalCandidates: 0,
        completedCandidates: 0,
        currentCandidate: null
      }),
      results: Object.freeze([]),
      analysis: null,
      summary: null
    }
    regionOcrState.value = REGION_OCR_STATE.PROCESSING
    let operation
    try {
      operation = pdfDeveloperApi.runRegionComparison({ region })
    } catch (error) {
      regionComparisonState.value = {
        ...regionComparisonState.value,
        status: 'failed'
      }
      setRegionOcrIdle()
      activeRegionComparisonOperation = null
      cancelActiveRegionComparison = null
      activeProgressCancel = null
      const id = `developer-notification:${++developerNotificationOccurrenceId}`
      presentation.present(DomainEvents.comparisonFailed({ id, error: error?.message }))
      presentation.present(DomainEvents.activityCompleted())
      return
    }

    let completionHandled = false
    const cancelOperation = () => {
      if (completionHandled || activeRegionComparisonOperation !== operation) return true

      completionHandled = true
      activeRegionComparisonOperation = null
      regionComparisonState.value = {
        ...regionComparisonState.value,
        status: 'cancelled'
      }
      operation.cancel()
      setRegionOcrIdle()
      presentation.present(DomainEvents.activityCompleted())
      if (cancelActiveRegionComparison === cancelOperation) cancelActiveRegionComparison = null
      if (activeProgressCancel === cancelOperation) activeProgressCancel = null
      return true
    }

    activeRegionComparisonOperation = operation
    cancelActiveRegionComparison = cancelOperation
    activeProgressCancel = cancelOperation
    void operation.promise.then(
      result => handleRegionComparisonOutcome(operation, result),
      error => handleRegionComparisonFailure(operation, error)
    ).finally(() => {
      if (!completionHandled && activeProgressCancel === cancelOperation) {
        completionHandled = true
        presentation.present(DomainEvents.activityCompleted())
      }
      if (cancelActiveRegionComparison === cancelOperation) cancelActiveRegionComparison = null
      if (activeProgressCancel === cancelOperation) activeProgressCancel = null
    })
    return
  }

  activeRegionPosition = resolveRegionViewportPosition(region)
  const request = createRegionExecutionRequest({
    region,
    target: executionMode.value
  })

  if (!request) return

  presentation.present(DomainEvents.regionOcrStarted())
  const operation = regionExecutionDispatcher.dispatchRegionExecution(request)
  let completionHandled = false
  const cancelOperation = () => {
    if (completionHandled) return true
    completionHandled = true
    cancelRegionOcr()
    setRegionOcrIdle()
    presentation.present(DomainEvents.activityCompleted())
    if (activeProgressCancel === cancelOperation) activeProgressCancel = null
    return true
  }
  cancelActiveRegionOcr = cancelOperation
  activeProgressCancel = cancelOperation
  regionOcrState.value = REGION_OCR_STATE.PROCESSING
  void operation.promise.then(handleRegionOcrOutcome, handleRegionOcrFailure).finally(() => {
    if (!completionHandled) presentation.present(DomainEvents.activityCompleted())
    if (cancelActiveRegionOcr === cancelOperation) cancelActiveRegionOcr = null
    if (activeProgressCancel === cancelOperation) activeProgressCancel = null
  })
}

function handleRequestRegionComparison() {
  if (!isDebugMode.value) return
  beginRegionSelection(REGION_EXECUTION_TARGET.REGION_COMPARISON)
}

function handleCancelRegionComparison() {
  return cancelActiveRegionComparison?.() === true
}

function handleExportRegionComparisonArtifact() {
  if (!isDebugMode.value) return
  if (!canExportRegionComparisonArtifact.value || !completedRegionComparisonResult || !completedRegionComparisonRegion) return

  try {
    const artifact = regionComparisonArtifactWriter.write(completedRegionComparisonResult, {
      region: completedRegionComparisonRegion
    })
    downloadFile(JSON.stringify(artifact, null, 2), 'region-comparison-artifact.json', 'application/json')
    presentation.present(DomainEvents.exportCompleted({ format: 'json' }))
  } catch (error) {
    presentation.present(DomainEvents.exportFailed({ error: error?.message }))
  }
}

function handleRegionComparisonProgress(progress) {
  if (!activeRegionComparisonOperation || !regionComparisonState.value) return

  regionComparisonState.value = {
    ...regionComparisonState.value,
    status: progress.status === 'cancelled' ? 'cancelled' : regionComparisonState.value.status,
    progress
  }
}

function handleRegionComparisonOutcome(operation, result) {
  if (activeRegionComparisonOperation !== operation) return

  activeRegionComparisonOperation = null
  completedRegionComparisonResult = result.status === 'ready' ? result : null
  completedRegionComparisonRegion = result.status === 'ready' ? operation.context.request.region : null
  const analysis = result.status === 'ready' ? regionComparisonAnalyzer.analyze(result) : null
  regionComparisonState.value = {
    status: result.status === 'cancelled' ? 'cancelled' : 'completed',
    progress: Object.freeze({
      totalCandidates: result.summary.totalCandidates,
      completedCandidates: result.summary.completedCandidates,
      currentCandidate: null
    }),
    results: result.results,
    analysis,
    summary: result.summary
  }

  setRegionOcrIdle()
  if (result.status === 'ready') {
    const id = `developer-notification:${++developerNotificationOccurrenceId}`
    presentation.present(DomainEvents.comparisonCompleted({ id, summary: analysis, result }))
  }
}

function handleRegionComparisonFailure(operation, error) {
  if (activeRegionComparisonOperation !== operation) return

  activeRegionComparisonOperation = null
  regionComparisonState.value = {
    ...regionComparisonState.value,
    status: 'failed'
  }
  setRegionOcrIdle()
  const id = `developer-notification:${++developerNotificationOccurrenceId}`
  presentation.present(DomainEvents.comparisonFailed({ id, error: error?.message }))
}

function beginRegionSelection(target) {
  if (regionOcrState.value === REGION_OCR_STATE.PROCESSING) return
  if (target === REGION_EXECUTION_TARGET.OCR && !ensureOcrLanguageInstalled()) return
  if (regionOcrState.value === REGION_OCR_STATE.SELECTING) {
    if (regionSelectionTarget.value === target) {
      exitRegionSelection()
      return
    }
  }
  if (!regionOcrAvailable.value) return
  regionSelectionTarget.value = target
  regionOcrState.value = REGION_OCR_STATE.SELECTING
}

function exitRegionSelection() {
  if (regionOcrState.value === REGION_OCR_STATE.SELECTING) {
    setRegionOcrIdle()
  }
}

function setRegionOcrIdle() {
  regionOcrState.value = REGION_OCR_STATE.IDLE
  regionSelectionTarget.value = null
}

function handleRegionOcrOutcome(result) {
  if (regionOcrState.value !== REGION_OCR_STATE.PROCESSING) return
  setRegionOcrIdle()

  if (result?.status === 'recognized' && !String(result?.data?.text || '').trim()) {
    presentation.present(DomainEvents.regionOcrNoText())
  } else if (result?.status === 'failed') {
    const errorCode = mapOcrError(result.error)
    if (errorCode === 'cancelled') return
    if (errorCode === 'model-not-installed') {
      showOcrLanguageRequiredMessage()
      return
    }

    presentation.present(DomainEvents.regionOcrFailed())
  }
}

function handleRegionOcrFailure(error) {
  handleRegionOcrOutcome({ status: 'failed', error })
}

function handleRegionOcrRecognized(payload) {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  const position = activeRegionPosition
  activeRegionPosition = null
  if (!text || !position) return

  void pdfWindowsHostRef.value?.openTranslation?.({
    text,
    position
  })
}

function handleTranslatedPaneCurrentPageChange(pageNumber) {
  if (showOriginalPane.value) return
  handleCurrentPageChange(pageNumber)
}

async function revealTranslation() {
  const targetPage = currentPageNumber.value
  const transitionDocumentGeneration = session.documentGeneration
  await handleContentViewChange(CONTENT_VIEW.TRANSLATION)
  if (!isSideBySide.value) {
    await handleLayoutModeChange(LAYOUT_MODE.SIDE_BY_SIDE)
  }
  await commitTransitionPage(targetPage, transitionDocumentGeneration)
}

async function commitTransitionPage(targetPage, transitionDocumentGeneration) {
  if (!Number.isInteger(targetPage) || targetPage < 1) return

  const layoutCommit = await waitForInitialLayoutCommit()
  if (layoutCommit?.cancelled) return
  if (session.documentGeneration !== transitionDocumentGeneration) return
  navigateToPage(targetPage)
}

async function getTranslationPresentationError(summary) {
  const presentation = await presentPdfTranslationError({ ...summary, translationDomain: true })
  if (presentation.kind === 'silent') return null
  if (presentation.kind === 'display') return presentation.message
  return 'Translation failed. Try again.'
}

function handleTranslateVisiblePages() {
  presentation.present(DomainEvents.translationOutcomeCleared())
  presentation.present(DomainEvents.translationStarted())
  let completionHandled = false
  const cancelOperation = () => {
    if (completionHandled || activeProgressCancel !== cancelOperation) return true

    completionHandled = true
    void cancelTranslation()
    presentation.present(DomainEvents.activityCompleted())
    if (cancelActivePageTranslation === cancelOperation) cancelActivePageTranslation = null
    if (activeProgressCancel === cancelOperation) activeProgressCancel = null
    return true
  }

  cancelActivePageTranslation = cancelOperation
  activeProgressCancel = cancelOperation
  void translateVisiblePages().then(async () => {
    if (completionHandled || activeProgressCancel !== cancelOperation) return

    const summary = translationSummary.value
    if (summary?.failureReason === 'cancelled') return
    const shouldRevealTranslatedContent = hasTranslationContent.value && (
      contentView.value === CONTENT_VIEW.ORIGINAL ||
      (contentView.value === CONTENT_VIEW.TRANSLATED_PDF &&
        session.getPageContentSource(currentPage.value) === PAGE_CONTENT_SOURCE.OCR)
    )
    if (summary?.status === 'partial') {
      const error = await getTranslationPresentationError(summary)
      if (error !== null) {
        presentation.present(DomainEvents.translationPartial({
          occurrenceId: summary.translationOccurrenceId,
          error,
          errorDetails: summary.errorDetails,
          reason: summary.failureReason
        }))
      }
      if (shouldRevealTranslatedContent) await revealTranslation()
    } else if (summary?.status === 'error') {
      const error = await getTranslationPresentationError(summary)
      if (error !== null) {
        presentation.present(DomainEvents.translationFailed({
          occurrenceId: summary.translationOccurrenceId,
          error,
          errorDetails: summary.errorDetails,
          reason: summary.failureReason
        }))
      }
    } else if (summary?.status === 'translated') {
      if (shouldRevealTranslatedContent) await revealTranslation()
    }
  }).finally(() => {
    if (!completionHandled && activeProgressCancel === cancelOperation) {
      completionHandled = true
      presentation.present(DomainEvents.activityCompleted())
    }
    if (cancelActivePageTranslation === cancelOperation) cancelActivePageTranslation = null
    if (activeProgressCancel === cancelOperation) activeProgressCancel = null
  })
}

function handleCancelTranslation() {
  return cancelActivePageTranslation?.() === true
}

async function handleExportTxt() {
  if (await exportTxt()) {
    presentation.present(DomainEvents.exportCompleted({ format: 'txt' }))
  } else if (exportError.value) {
    presentation.present(DomainEvents.exportFailed({ error: exportError.value }))
  }
}

async function handleExportMarkdown() {
  if (await exportMarkdown()) {
    presentation.present(DomainEvents.exportCompleted({ format: 'markdown' }))
  } else if (exportError.value) {
    presentation.present(DomainEvents.exportFailed({ error: exportError.value }))
  }
}

async function handleExportHtml() {
  const canvasDataUrls = pdfViewerRef.value?.collectCanvasDataUrls?.() || new Map()
  if (await exportHtml(canvasDataUrls)) {
    presentation.present(DomainEvents.exportCompleted({ format: 'html' }))
  } else if (exportError.value) {
    presentation.present(DomainEvents.exportFailed({ error: exportError.value }))
  }
}

async function handleClearCache() {
  await clearDocumentCache()
  presentation.present(DomainEvents.cacheCleared())
}

function dismissPdfStatusBanner() {
  if (!pdfStatusBanner.value?.id || !pdfStatusBanner.value.dismissible) {
    return
  }
  dismissedPdfStatusBannerKey.value = pdfStatusBanner.value.id
}

updateDocumentTitle()

onMounted(async () => {
  if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
    previousScrollRestoration = history.scrollRestoration
    history.scrollRestoration = 'manual'
    managesScrollRestoration = true
  }

  // Preload languages asynchronously — LanguageSelector expects cached values
  usePreloadLanguages().catch(() => {})

  try {
    await ocrStore.init()
  } catch (error) {
    logger.error('Failed to initialize OCR store.', error)
  }

  if (!isAlive) return

  setPendingViewerState(readViewerStateFromUrl())

  if (import.meta.env.DEV) {
    import('./debug/pdfOverlayDiagnostics.js')
  }

  const handler = (message) => {
    if (message.action === 'THEME_CHANGED') {
      applyTheme(message.payload.theme)
    } else if (message.action === 'OCR_LANGUAGES_UPDATED') {
      ocrStore.refreshDownloadedLanguages()
    }
  }
  browser.runtime.onMessage.addListener(handler)
  removeThemeMessageListener = () => browser.runtime.onMessage.removeListener(handler)

  await tryAutoRestore()

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const mqHandler = () => {
    if (settingsStore.settings.THEME === 'auto') {
      applyTheme('auto')
    }
  }
  mq.addEventListener('change', mqHandler)
  themeMediaQuery = mq
  themeMqHandler = mqHandler

  document.addEventListener('keydown', handleRegionOcrKeyDown)
})

onBeforeUnmount(() => {
  isAlive = false
  clearLingerTimer()
  activeRegionPosition = null
  activeRegionComparisonOperation?.cancel()
  activeRegionComparisonOperation = null
  setRegionOcrIdle()
  detachDocument()
  void cleanup()

  if (managesScrollRestoration) {
    history.scrollRestoration = previousScrollRestoration
    previousScrollRestoration = null
    managesScrollRestoration = false
  }

  if (removeThemeMessageListener) {
    removeThemeMessageListener()
    removeThemeMessageListener = null
  }
  if (themeMediaQuery && themeMqHandler) {
    themeMediaQuery.removeEventListener('change', themeMqHandler)
  }
  document.removeEventListener('keydown', handleRegionOcrKeyDown)
})

function handleRegionOcrKeyDown(event) {
  if (event.key !== 'Escape' || regionOcrState.value !== REGION_OCR_STATE.SELECTING) return
  event.preventDefault()
  exitRegionSelection()
}
</script>

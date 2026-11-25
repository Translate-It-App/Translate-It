<template>
  <header
    class="pdf-toolbar"
    :class="{ 'pdf-toolbar--empty': !fileName }"
  >
    <div class="pdf-toolbar__title-block">
      <slot name="leading" />
      <div class="pdf-toolbar__file-row">
        <div class="pdf-toolbar__group pdf-toolbar__group--outline-access">
          <button
            v-if="hasOutline"
            class="pdf-toolbar__outline-toggle"
            :class="{ 'pdf-toolbar__outline-toggle--active': isOutlineVisible }"
            type="button"
            :aria-label="TOOLTIP_OUTLINE"
            :title="TOOLTIP_OUTLINE"
            @click="$emit('toggle-outline')"
          >
            <MaskIcon
              :src="outlineIcon"
              :size="16"
            />
          </button>
        </div>
        <button
          v-if="fileName"
          :disabled="!fileName"
          class="pdf-toolbar__info-toggle"
          type="button"
          aria-label="PDF Information"
          title="PDF Information"
          @click="$emit('request-document-info')"
        >
          <MaskIcon
            :src="infoIcon"
            :size="16"
          />
        </button>
      </div>
    </div>

    <ToolbarCenterRegion v-if="fileName">
      <ToolbarPresentationGroup>
        <div
          class="pdf-toolbar__view-mode pdf-toolbar__view-mode--desktop"
          :class="{ 'pdf-toolbar__view-mode--hidden': !showTranslationOption }"
        >
          <div class="pdf-toolbar__mode-group pdf-toolbar__mode-group--content">
            <button
              v-for="opt in contentOptions"
              :key="opt.value"
              class="pdf-toolbar__mode-button"
              :class="{ 'pdf-toolbar__mode-button--active': contentView === opt.value }"
              type="button"
              :aria-label="opt.ariaLabel ?? opt.label"
              :title="opt.tooltip"
              @click="$emit('content-view-change', opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div
          class="pdf-toolbar__view-mode pdf-toolbar__view-mode--mobile"
          :class="{ 'pdf-toolbar__view-mode--hidden': !showTranslationOption }"
        >
          <select
            class="pdf-toolbar__view-mode-select"
            :value="contentView"
            :title="selectedContentTooltip"
            :tabindex="showTranslationOption ? 0 : -1"
            :aria-hidden="!showTranslationOption"
            aria-label="View mode"
            @change="$emit('content-view-change', $event.target.value)"
          >
            <option
              v-for="opt in contentOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div
          class="pdf-toolbar__mode-group pdf-toolbar__mode-group--layout"
          :class="{ 'pdf-toolbar__mode-group--hidden': !showTranslationOption }"
        >
          <button
            class="pdf-toolbar__mode-button"
            :class="{ 'pdf-toolbar__mode-button--active': isSideBySide }"
            type="button"
            :aria-label="TOOLTIP_SIDE_BY_SIDE"
            :title="TOOLTIP_SIDE_BY_SIDE"
            :aria-pressed="isSideBySide"
            @click="handleLayoutModeToggle"
          >
            <MaskIcon
              :src="splitScreenIcon"
              :size="14"
            />
          </button>
        </div>

        <span
          class="pdf-toolbar__separator"
          :class="{ 'pdf-toolbar__separator--hidden': !showTranslationOption }"
          aria-hidden="true"
        />

        <div class="pdf-toolbar__zoom-group">
          <button
            class="pdf-toolbar__zoom-button pdf-toolbar__zoom-button--out"
            type="button"
            :disabled="!hasZoomOut"
            :aria-label="TOOLTIP_ZOOM_OUT"
            :title="TOOLTIP_ZOOM_OUT"
            @click="$emit('zoom-step', -1)"
          >
            −
          </button>

          <select
            class="pdf-toolbar__zoom-select"
            :value="zoomSelectValue"
            @change="handleZoomSelectChange"
          >
            <option
              v-for="option in zoomPercentOptions"
              :key="option"
              :value="String(option)"
            >
              {{ option }}%
            </option>
          </select>

          <button
            class="pdf-toolbar__zoom-button pdf-toolbar__zoom-button--in"
            type="button"
            :disabled="!hasZoomIn"
            :aria-label="TOOLTIP_ZOOM_IN"
            :title="TOOLTIP_ZOOM_IN"
            @click="$emit('zoom-step', 1)"
          >
            +
          </button>
        </div>

        <span
          class="pdf-toolbar__separator"
          aria-hidden="true"
        />

        <button
          class="pdf-toolbar__button pdf-toolbar__button--icon-trigger"
          type="button"
          :aria-label="fitToggleTooltip"
          :title="fitToggleTooltip"
          @click="handleFitToggle"
        >
          <MaskIcon
            v-if="fitToggleIcon === 'fit-page'"
            :src="fitPageIcon"
            :size="18"
          />
          <MaskIcon
            v-else
            :src="fitWidthIcon"
            :size="18"
          />
        </button>
      </ToolbarPresentationGroup>

      <ToolbarNavigationGroup>
        <button
          class="pdf-toolbar__button pdf-toolbar__button--icon-trigger"
          type="button"
          :disabled="!canGoPrevious"
          :aria-label="TOOLTIP_PREVIOUS_PAGE"
          :title="TOOLTIP_PREVIOUS_PAGE"
          @click="$emit('previous-page')"
        >
          <MaskIcon
            class="pdf-toolbar__icon--rotated"
            :src="dropdownArrowIcon"
            :size="14"
          />
        </button>
        <button
          class="pdf-toolbar__button pdf-toolbar__button--icon-trigger"
          type="button"
          :disabled="!canGoNext"
          :aria-label="TOOLTIP_NEXT_PAGE"
          :title="TOOLTIP_NEXT_PAGE"
          @click="$emit('next-page')"
        >
          <MaskIcon
            :src="dropdownArrowIcon"
            :size="14"
          />
        </button>
        <input
          class="pdf-toolbar__page-input"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          :value="isEditingPage ? editPageValue : currentPageDisplayValue"
          @focus="startEditingPage"
          @input="handlePageInput"
          @keydown="handlePageKeydown"
          @blur="commitPageEdit"
        >
        <span class="pdf-toolbar__page-separator">/</span>
        <span class="pdf-toolbar__page-total">{{ pageCount || 0 }}</span>
      </ToolbarNavigationGroup>
    </ToolbarCenterRegion>

    <ToolbarActionDock>
      <div class="pdf-toolbar__group pdf-toolbar__group--primary-operation">
        <div
          v-if="ocrViewModel"
          ref="ocrSplitRef"
          class="pdf-toolbar__ocr-split"
        >
          <div class="pdf-toolbar__ocr-buttons">
            <button
              class="pdf-toolbar__ocr-primary"
              :class="{
                'pdf-toolbar__ocr-primary--cancel': ocrViewModel.canCancel,
                'pdf-toolbar__ocr-primary--highlight': ocrViewModel.isPageOcrRecommended && !ocrViewModel.canCancel
              }"
              :disabled="primaryDisabled"
              type="button"
              :aria-label="primaryAriaLabel"
              @click="$emit('primary-click')"
            >
              <span
                class="pdf-toolbar__ocr-primary-size pdf-toolbar__ocr-primary-size--full"
                aria-hidden="true"
              >{{ widestPrimaryLabel }}</span>
              <span
                class="pdf-toolbar__ocr-primary-size pdf-toolbar__ocr-primary-size--compact"
                aria-hidden="true"
              >{{ widestCompactPrimaryLabel }}</span>
              <span class="pdf-toolbar__ocr-primary-text pdf-toolbar__ocr-primary-text--full">{{ primaryLabel }}</span>
              <span class="pdf-toolbar__ocr-primary-text pdf-toolbar__ocr-primary-text--compact">{{ compactPrimaryLabel }}</span>
            </button>
            <button
              ref="ocrMenuTriggerRef"
              class="pdf-toolbar__ocr-arrow"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'ocr'"
              :aria-label="'More OCR options'"
              @click="toggleOcrMenu"
              @keydown="handleOcrArrowKeydown"
            >
              ▼
            </button>
          </div>

          <div
            v-if="activeMenu === 'ocr'"
            ref="ocrMenuRef"
            class="pdf-toolbar__ocr-menu"
            role="menu"
          >
            <button
              class="pdf-toolbar__ocr-menu-item"
              :class="{
                'pdf-toolbar__ocr-menu-item--selected': ocrViewModel.preferredAction === 'region',
                'pdf-toolbar__ocr-menu-item--disabled': regionDisabled
              }"
              role="menuitemradio"
              :aria-checked="ocrViewModel.preferredAction === 'region'"
              :disabled="regionDisabled"
              @click="selectAction('region')"
            >
              <span
                class="pdf-toolbar__ocr-menu-check"
                aria-hidden="true"
              >✓</span>
              OCR Region
            </button>
            <button
              class="pdf-toolbar__ocr-menu-item"
              :class="{
                'pdf-toolbar__ocr-menu-item--selected': ocrViewModel.preferredAction === 'page',
                'pdf-toolbar__ocr-menu-item--disabled': pageDisabled
              }"
              role="menuitemradio"
              :aria-checked="ocrViewModel.preferredAction === 'page'"
              :disabled="pageDisabled"
              title=""
              @click="selectAction('page')"
            >
              <span
                class="pdf-toolbar__ocr-menu-check"
                aria-hidden="true"
              >✓</span>
              OCR Page
            </button>

            <div
              class="pdf-toolbar__ocr-menu-divider"
              role="separator"
            />

            <div class="pdf-toolbar__ocr-menu-scroll">
              <template v-if="ocrViewModel.installedLanguages.length">
                <button
                  v-for="lang in ocrViewModel.installedLanguages"
                  :key="lang.code"
                  class="pdf-toolbar__ocr-menu-item"
                  :class="{ 'pdf-toolbar__ocr-menu-item--selected': lang.selected }"
                  role="menuitemradio"
                  :aria-checked="lang.selected"
                  @click="selectLanguage(lang.code)"
                >
                  <span
                    class="pdf-toolbar__ocr-menu-check"
                    aria-hidden="true"
                  >✓</span>
                  {{ lang.name }}
                </button>
              </template>
              <div
                v-else
                class="pdf-toolbar__ocr-menu-empty"
              >
                No languages installed
              </div>
            </div>

            <div
              class="pdf-toolbar__ocr-menu-divider"
              role="separator"
            />

            <button
              class="pdf-toolbar__ocr-menu-item"
              role="menuitem"
              @click="handleManageLanguages"
            >
              <MaskIcon
                :src="settingsIcon"
                :size="16"
              />
              Manage Languages...
            </button>
          </div>
        </div>

        <ProviderSelector
          :model-value="pdfProviderValue"
          mode="split"
          presentation="compact-label"
          :is-global="false"
          allow-default
          only-configured
          required-feature="bulk"
          :loading="isTranslating"
          :disabled="!canTranslateVisiblePages && !isTranslating"
          :dropdown-disabled="isTranslating"
          :translate-on-provider-change="false"
          @provider-change="handleProviderChange"
          @translate="handleTranslateRequest"
          @cancel="$emit('cancel-translation')"
        />
      </div>
      <div class="pdf-toolbar__group pdf-toolbar__group--secondary-actions">
        <select
          v-if="hasExecutionModeChoice"
          class="pdf-toolbar__execution-mode-select"
          :value="executionMode"
          aria-label="Region execution mode"
          @change="handleExecutionModeChange"
        >
          <option
            v-for="mode in executionModes"
            :key="mode"
            :value="mode"
          >
            {{ mode }}
          </option>
        </select>
        <div class="pdf-toolbar__language-settings">
          <PdfMoreMenu
            :file-name="fileName"
            :is-loading="isLoading"
            :can-export="canExport"
            :source-language="sourceLanguage"
            :target-language="targetLanguage"
            :region-comparison-state="regionComparisonState"
            :can-export-region-comparison-artifact="canExportRegionComparisonArtifact"
            :is-clear-cache-disabled="isClearCacheDisabled"
            :is-debug-mode="isDebugMode"
            @request-open-pdf="emit('request-open-pdf')"
            @open-remote-pdf="emit('open-remote-pdf')"
            @export-txt="emit('export-txt')"
            @export-markdown="emit('export-markdown')"
            @export-html="emit('export-html')"
            @request-region-comparison="emit('request-region-comparison')"
            @export-region-comparison-artifact="emit('export-region-comparison-artifact')"
            @clear-cache="emit('clear-cache')"
            @open-settings="emit('open-settings')"
            @request-document-info="emit('request-document-info')"
            @open-language-settings="handleOpenLanguageSettings"
            @open="closeMenus"
          />
          <PdfTranslationSettingsPopover
            v-if="activeMenu === 'language'"
            ref="languagePopoverRef"
            :source-language="sourceLanguage"
            :target-language="targetLanguage"
            :provider="effectivePdfProvider"
            :auto-detect-label="t('auto_detect', 'Auto-Detect')"
            :disabled="isTranslating"
            @update:source-language="emit('update:sourceLanguage', $event)"
            @update:target-language="emit('update:targetLanguage', $event)"
          />
        </div>
      </div>
    </ToolbarActionDock>
  </header>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CONTENT_VIEW, LAYOUT_MODE } from '../composables/usePdfViewerMode.js'
import { CONFIG, TranslationMode } from '@/shared/config/config.js'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import MaskIcon from '@/components/shared/MaskIcon.vue'
import ProviderSelector from '@/components/shared/ProviderSelector.vue'
import PdfTranslationSettingsPopover from './PdfTranslationSettingsPopover.vue'
import ToolbarActionDock from './ToolbarActionDock.vue'
import ToolbarCenterRegion from './ToolbarCenterRegion.vue'
import PdfMoreMenu from './PdfMoreMenu.vue'
import ToolbarNavigationGroup from './ToolbarNavigationGroup.vue'
import ToolbarPresentationGroup from './ToolbarPresentationGroup.vue'
import outlineIcon from '@/icons/ui/outline.svg?url'
import splitScreenIcon from '@/icons/ui/split-screen.svg?url'
import fitPageIcon from '@/icons/ui/fit-page.svg?url'
import fitWidthIcon from '@/icons/ui/fit-width.svg?url'
import infoIcon from '@/icons/ui/info.svg?url'
import dropdownArrowIcon from '@/icons/ui/dropdown-arrow.svg?url'
import settingsIcon from '@/icons/ui/settings.svg?url'
import { PDF_ZOOM_PERCENT_OPTIONS } from '../constants/pdfZoomConstants.js'
import './PdfToolbar.scss'

const TOOLTIP_OUTLINE = 'Toggle outline'
const TOOLTIP_SIDE_BY_SIDE = 'Side by Side'
const TOOLTIP_ZOOM_OUT = 'Zoom out'
const TOOLTIP_ZOOM_IN = 'Zoom in'
const TOOLTIP_PREVIOUS_PAGE = 'Previous page'
const TOOLTIP_NEXT_PAGE = 'Next page'

const props = defineProps({
  fileName: { type: String, default: '' },
  pageCount: { type: Number, default: 0 },
  currentPageNumber: { type: Number, default: 0 },
  isLoading: { type: Boolean, default: false },
  isTranslating: { type: Boolean, default: false },
  canTranslateVisiblePages: { type: Boolean, default: false },
  canExport: { type: Boolean, default: false },
  ocrViewModel: { type: Object, default: null },
  contentView: { type: String, default: CONTENT_VIEW.ORIGINAL },
  layoutMode: { type: String, default: LAYOUT_MODE.SINGLE },
  zoomMode: { type: String, default: 'fit-width' },
  zoomPercent: { type: Number, default: 100 },
  showTranslationOption: { type: Boolean, default: false },
  hasOutline: { type: Boolean, default: false },
  isOutlineVisible: { type: Boolean, default: false },
  executionMode: { type: String, default: '' },
  executionModes: { type: Array, default: () => [] },
  regionComparisonState: { type: Object, default: null },
  canExportRegionComparisonArtifact: { type: Boolean, default: false },
  isClearCacheDisabled: { type: Boolean, default: false },
  sourceLanguage: { type: String, default: 'auto' },
  targetLanguage: { type: String, default: 'fa' },
})

const emit = defineEmits(['request-open-pdf', 'open-remote-pdf', 'translate-visible', 'cancel-translation', 'content-view-change', 'layout-mode-change', 'toggle-outline', 'export-txt', 'export-markdown', 'export-html', 'request-region-comparison', 'cancel-region-comparison', 'export-region-comparison-artifact', 'clear-cache', 'zoom-step', 'zoom-change', 'execution-mode-change', 'primary-click', 'select-action', 'select-language',   'manage-languages', 'open-settings', 'request-document-info', 'previous-page', 'next-page',
  'go-to-page', 'update:sourceLanguage', 'update:targetLanguage'])

const logger = getScopedLogger(LOG_COMPONENTS.PDF, 'PdfToolbar')
const settingsStore = useSettingsStore()
const { t } = useUnifiedI18n()

const pdfProviderValue = computed(() => {
  return settingsStore.settings?.MODE_PROVIDERS?.[TranslationMode.PDF] || 'default'
})

const effectivePdfProvider = computed(() => {
  const modeProvider = settingsStore.settings?.MODE_PROVIDERS?.[TranslationMode.PDF]
  if (modeProvider && modeProvider !== 'default') return modeProvider
  return settingsStore.settings?.TRANSLATION_API || CONFIG.TRANSLATION_API
})

const isDebugMode = computed(() => settingsStore.settings?.DEBUG_MODE === true)

const providerPersistenceState = {
  sequence: 0,
  latest: null,
  running: null
}

const persistPdfProvider = async (providerId) => {
  const modeProviders = {
    ...(settingsStore.settings?.MODE_PROVIDERS || {}),
    [TranslationMode.PDF]: providerId === 'default' ? null : providerId
  }
  await settingsStore.updateSettingAndPersist('MODE_PROVIDERS', modeProviders)
}

const handleProviderChange = (providerId) => {
  providerPersistenceState.latest = {
    sequence: ++providerPersistenceState.sequence,
    providerId
  }

  if (!providerPersistenceState.running) {
    providerPersistenceState.running = runProviderPersistenceQueue()
  }
}

const runProviderPersistenceQueue = async () => {
  try {
    while (providerPersistenceState.latest) {
      const ownership = providerPersistenceState.latest
      providerPersistenceState.latest = null

      try {
        await persistPdfProvider(ownership.providerId)
      } catch (error) {
        if (ownership.sequence === providerPersistenceState.sequence && !providerPersistenceState.latest) {
          logger.error('Failed to persist PDF provider selection:', error)
          return
        }

        continue
      }

      if (ownership.sequence === providerPersistenceState.sequence && !providerPersistenceState.latest) {
        return
      }
    }
  } finally {
    providerPersistenceState.running = null

    if (providerPersistenceState.latest) {
      providerPersistenceState.running = runProviderPersistenceQueue()
    }
  }
}

const handleTranslateRequest = () => {
  if (providerPersistenceState.running) return
  emit('translate-visible')
}

const ocrModel = computed(() => props.ocrViewModel || {})

function buildPrimaryLabel(state, compact = false) {
  const actionText = state.action === 'cancel'
    ? t('cancel', 'Cancel')
    : (state.action === 'page'
      ? t(compact ? 'ocr_page_compact' : 'ocr_page', compact ? 'Page' : 'OCR Page')
      : t(compact ? 'ocr_region_compact' : 'ocr_region', compact ? 'Region' : 'OCR Region'))
  if (state.language === null) return actionText
  const languageLabel = state.language.compactLabel || state.language.code?.toUpperCase() || 'EN'
  return `${actionText} · ${languageLabel}`
}

const currentOcrState = computed(() => {
  const m = ocrModel.value
  return {
    action: m.canCancel ? 'cancel' : m.primaryAction,
    language: m.hasInstalledLanguages ? (m.language ?? null) : null,
  }
})

const primaryLabel = computed(() => buildPrimaryLabel(currentOcrState.value))
const compactPrimaryLabel = computed(() => buildPrimaryLabel(currentOcrState.value, true))

const widestOcrState = computed(() => {
  const m = ocrModel.value
  const longestInstalledLanguage = (m.installedLanguages || [])
    .reduce((longest, candidate) => (
      (candidate.code?.length || 0) > (longest?.code?.length || 0) ? candidate : longest
    ), null)
  const language = longestInstalledLanguage ?? m.language ?? null
  return {
    action: 'region',
    language,
  }
})

const widestPrimaryLabel = computed(() => buildPrimaryLabel(widestOcrState.value))
const widestCompactPrimaryLabel = computed(() => buildPrimaryLabel(widestOcrState.value, true))

const primaryAriaLabel = computed(() => {
  const m = ocrModel.value
  if (m.canCancel) return `Cancel OCR. ${m.language?.name || 'EN'}`
  const action = m.primaryAction === 'page' ? 'OCR Page' : 'OCR Region'
  let label = `${action}. ${m.language?.name || 'EN'}`
  if (m.currentPageContainsOcr && !m.canCancel) label += '. Current page has OCR data.'
  return label
})

const primaryDisabled = computed(() => {
  if (ocrModel.value.canCancel) return false
  if (ocrModel.value.preferredAction === 'region') return !ocrModel.value.regionOcrAvailable
  return !ocrModel.value.hasDocument
})

const regionDisabled = computed(() => ocrModel.value.canCancel || !ocrModel.value.regionOcrAvailable)

const pageDisabled = computed(() => ocrModel.value.canCancel || !ocrModel.value.hasDocument)

function toggleOcrMenu() {
  if (activeMenu.value === 'ocr') {
    closeMenus()
    return
  }
  closeMenus()
  activeMenu.value = 'ocr'
}

function handleOcrArrowKeydown(event) {
  if (event.key === 'ArrowDown' && activeMenu.value !== 'ocr') {
    event.preventDefault()
    toggleOcrMenu()
    nextTick(() => {
      const items = Array.from(ocrMenuRef.value?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') || [])
      const first = items.find(el => !el.disabled)
      first?.focus()
    })
  }
}

function selectAction(action) {
  if (ocrModel.value.canCancel) return
  if (action === 'region' && !ocrModel.value.regionOcrAvailable) return
  if (action === 'page' && !ocrModel.value.hasDocument) return
  emit('select-action', action)
  closeMenus()
}

function selectLanguage(code) {
  emit('select-language', code)
  closeMenus()
}

function handleManageLanguages() {
  emit('manage-languages')
  closeMenus()
}

const ocrSplitRef = ref(null)
const ocrMenuRef = ref(null)
const ocrMenuTriggerRef = ref(null)
const languagePopoverRef = ref(null)
const activeMenu = ref(null)
const zoomPercentOptions = PDF_ZOOM_PERCENT_OPTIONS

const allContentOptions = [
  { value: CONTENT_VIEW.ORIGINAL, label: 'Original', ariaLabel: 'Original', tooltip: 'Original PDF' },
  { value: CONTENT_VIEW.TRANSLATION, label: 'Text', ariaLabel: 'Translation', tooltip: 'Translated Text (Beta)' },
  { value: CONTENT_VIEW.TRANSLATED_PDF, label: 'PDF', ariaLabel: 'Translated PDF', tooltip: 'Translated PDF (Experimental)' }
]

const contentOptions = computed(() => allContentOptions)

const selectedContentTooltip = computed(() => {
  return contentOptions.value.find((opt) => opt.value === props.contentView)?.tooltip ?? ''
})

const isSideBySide = computed(() => props.layoutMode === LAYOUT_MODE.SIDE_BY_SIDE)
const hasExecutionModeChoice = computed(() => props.executionModes.length > 1)

const zoomSelectValue = computed(() => String(props.zoomPercent || 100))

const fitToggleIcon = computed(() => {
  if (props.zoomMode === 'fit-page') return 'fit-width'
  return 'fit-page'
})

const fitToggleTooltip = computed(() => {
  if (fitToggleIcon.value === 'fit-width') return 'Fit to width'
  return 'Fit to page'
})

const currentPageDisplayValue = computed(() => {
  const total = Number(props.pageCount) || 0
  const current = Number(props.currentPageNumber) || 0

  if (!total) {
    return '0'
  }

  return String(current || 1)
})

const canGoPrevious = computed(() => Number(props.currentPageNumber) > 1)
const canGoNext = computed(() => Number(props.currentPageNumber) < Number(props.pageCount))

const isEditingPage = ref(false)
const editPageValue = ref('')
const originalPageNumber = ref(0)

function startEditingPage(e) {
  isEditingPage.value = true
  editPageValue.value = currentPageDisplayValue.value
  originalPageNumber.value = Number(currentPageDisplayValue.value)
  nextTick(() => e.target.select())
}

function handlePageInput(e) {
  editPageValue.value = e.target.value.replace(/\D/g, '')
}

function commitPageEdit() {
  if (!isEditingPage.value) return
  isEditingPage.value = false

  const num = Number(editPageValue.value)
  const isValidPage = Number.isInteger(num) && num >= 1

  if (!isValidPage) {
    editPageValue.value = currentPageDisplayValue.value
  } else if (num !== originalPageNumber.value) {
    emit('go-to-page', num)
  }

  originalPageNumber.value = 0
}

function cancelPageEdit(e) {
  isEditingPage.value = false
  editPageValue.value = currentPageDisplayValue.value
  originalPageNumber.value = 0
  e.target.value = editPageValue.value
  e.target.blur()
}

function handlePageKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.target.blur()
  } else if (e.key === 'Escape') {
    cancelPageEdit(e)
  }
}

watch(() => props.currentPageNumber, (val) => {
  if (!isEditingPage.value) {
    editPageValue.value = String(val || 1)
  }
})

const hasZoomOut = computed(() => props.zoomMode !== 'fit-width' || props.zoomPercent > zoomPercentOptions[0])
const hasZoomIn = computed(() => props.zoomMode !== 'fit-width' || props.zoomPercent < zoomPercentOptions[zoomPercentOptions.length - 1])

function handleOpenLanguageSettings() {
  activeMenu.value = 'language'
}

function closeMenus() {
  activeMenu.value = null
}

function getActiveMenuRefs() {
  if (activeMenu.value === 'ocr') {
    return {
      menuRef: ocrMenuRef.value,
      triggerRef: ocrMenuTriggerRef.value
    }
  }

  if (activeMenu.value === 'language') {
    return {
      menuRef: languagePopoverRef.value?.$el || null,
      triggerRef: null
    }
  }

  return {
    menuRef: null,
    triggerRef: null
  }
}

function handleDocumentPointerDown(event) {
  if (!activeMenu.value) return

  const { menuRef, triggerRef } = getActiveMenuRefs()
  if (activeMenu.value === 'ocr') {
    const inside = ocrSplitRef.value?.contains(event.target) || menuRef?.contains(event.target)
    if (inside) return
    closeMenus()
    return
  }
  if (menuRef?.contains(event.target) || triggerRef?.contains(event.target)) return
  closeMenus()
}

function handleDocumentKeyDown(event) {
  if (!activeMenu.value) return

  if (activeMenu.value === 'ocr' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const items = Array.from(ocrMenuRef.value?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') || [])
    const enabled = items.filter(el => !el.disabled)
    if (!enabled.length) return
    const currentIndex = enabled.indexOf(document.activeElement)
    let nextIndex
    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % enabled.length
    } else {
      nextIndex = currentIndex === -1 ? enabled.length - 1 : (currentIndex - 1 + enabled.length) % enabled.length
    }
    enabled[nextIndex]?.focus()
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    const activeMenuName = activeMenu.value
    if (activeMenuName === 'ocr') {
      closeMenus()
      ocrMenuTriggerRef.value?.focus?.()
      return
    }
    closeMenus()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  document.addEventListener('keydown', handleDocumentKeyDown)

})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  document.removeEventListener('keydown', handleDocumentKeyDown)
})

function handleZoomSelectChange(event) {
  const percent = Number(event.target.value)
  if (!Number.isFinite(percent)) return
  emit('zoom-change', { mode: 'percent', value: percent })
}

function handleFitToggle() {
  const mode = fitToggleIcon.value
  emit('zoom-change', { mode, value: mode === 'fit-width' ? 100 : (props.zoomPercent || 100) })
}

function handleLayoutModeToggle() {
  emit('layout-mode-change', isSideBySide.value ? LAYOUT_MODE.SINGLE : LAYOUT_MODE.SIDE_BY_SIDE)
}

function handleExecutionModeChange(event) {
  emit('execution-mode-change', event.target.value)
}

</script>

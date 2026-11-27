import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { MOBILE_CONSTANTS } from '@/shared/constants/mobile.js'
import { TRANSLATION_STATUS } from '@/shared/constants/translation.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

export const useMobileStore = defineStore('mobile', () => {
  const logger = getScopedLogger(LOG_COMPONENTS.MOBILE, 'Store');
  
  // State
  const isOpen = ref(false)
  const activeView = ref(MOBILE_CONSTANTS.VIEWS.DASHBOARD)
  const sheetState = ref(MOBILE_CONSTANTS.SHEET_STATE.PEEK)
  const isKeyboardVisible = ref(false)
  const isFullscreen = ref(false)
  
  // Selection Specific State
  const selectionData = ref({
    text: '',
    translation: '',
    sourceLang: 'auto',
    targetLang: 'en',
    isLoading: false,
    error: null,
    mode: null
  })

  // Page Translation State
  const pageTranslationData = ref({
    isTranslating: false,
    isTranslated: false,
    isAutoTranslating: false,
    hasManualContinuity: false,
    manualContinuityGeneration: -1,
    translatedCount: 0,
    failedCount: 0,
    totalCount: 0,
    status: TRANSLATION_STATUS.IDLE, // 'idle' | 'translating' | 'completed' | 'error'
    errorMessage: null
  })

  // Select Element State
  const hasElementTranslations = ref(false)

  // Getters
  const isSheetOpen = computed(() => isOpen.value)
  const currentView = computed(() => activeView.value)
  const currentSheetState = computed(() => sheetState.value)
  
  // Actions
  const navigate = (view, state = null) => {
    logger.debug('Navigating mobile view', { view, state });
    // 1. Set the active view
    activeView.value = view;

    // 2. Determine the smart sheet state if not explicitly provided
    if (state) {
      sheetState.value = state;
    } else {
      // Default logic: Fullscreen for complex interaction views, Peek for others
      const fullViews = [
        MOBILE_CONSTANTS.VIEWS.INPUT, 
        MOBILE_CONSTANTS.VIEWS.HISTORY
      ];
      
      sheetState.value = fullViews.includes(view)
        ? MOBILE_CONSTANTS.SHEET_STATE.FULL
        : MOBILE_CONSTANTS.SHEET_STATE.PEEK;
    }
  }

  const openSheet = (view = MOBILE_CONSTANTS.VIEWS.DASHBOARD, state = null) => {
    logger.info('Opening mobile sheet', { view, state });
    navigate(view, state);
    isOpen.value = true;
  }

  const closeSheet = () => {
    logger.info('Closing mobile sheet');
    isOpen.value = false;
    sheetState.value = MOBILE_CONSTANTS.SHEET_STATE.CLOSED;
  }

  const toggleSheet = () => {
    if (isOpen.value) {
      closeSheet()
    } else {
      openSheet()
    }
  }

  const setView = (view) => {
    logger.debug('Setting mobile view', view);
    activeView.value = view
  }

  const setSheetState = (state) => {
    logger.debug('Setting mobile sheet state', state);
    sheetState.value = state
  }

  const setKeyboardVisibility = (visible) => {
    logger.debug('Keyboard visibility changed', visible);
    isKeyboardVisible.value = visible
    // Automatically expand to full when keyboard is visible
    if (visible && isOpen.value) {
      sheetState.value = MOBILE_CONSTANTS.SHEET_STATE.FULL
    }
  }

  const updateSelectionData = (data) => {
    logger.debug('Updating selection data', data);
    selectionData.value = { ...selectionData.value, ...data }
  }

  const resetSelectionData = () => {
    logger.debug('Resetting selection data');
    selectionData.value = {
      text: '',
      translation: '',
      sourceLang: 'auto',
      targetLang: 'en',
      isLoading: false,
      error: null,
      mode: null
    }
  }

  const setPageTranslation = (data) => {
    logger.debug('Updating page translation data', data);
    pageTranslationData.value = { ...pageTranslationData.value, ...data }
  }

  const resetPageTranslation = () => {
    logger.debug('Resetting page translation data');
    const manualContinuityGeneration = pageTranslationData.value.manualContinuityGeneration ?? -1;
    pageTranslationData.value = {
      isTranslating: false,
      isTranslated: false,
      isAutoTranslating: false,
      hasManualContinuity: false,
      manualContinuityGeneration,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      status: TRANSLATION_STATUS.IDLE,
      errorMessage: null
    }
  }

  const setHasElementTranslations = (value) => {
    hasElementTranslations.value = value
  }

  const setFullscreen = (value) => {
    isFullscreen.value = value
  }

  return {
    // State
    isOpen,
    activeView,
    sheetState,
    isKeyboardVisible,
    isFullscreen,
    selectionData,
    pageTranslationData,
    hasElementTranslations,
    
    // Getters
    isSheetOpen,
    currentView,
    currentSheetState,
    
    // Actions
    navigate,
    openSheet,
    closeSheet,
    toggleSheet,
    setView,
    setSheetState,
    setKeyboardVisibility,
    updateSelectionData,
    resetSelectionData,
    setPageTranslation,
    resetPageTranslation,
    setHasElementTranslations,
    setFullscreen
  }
})

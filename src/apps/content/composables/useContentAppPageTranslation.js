import { onMounted } from 'vue';
import { deviceDetector } from '@/utils/browser/compatibility.js';
import { MOBILE_CONSTANTS } from '@/shared/constants/mobile.js';
import { TRANSLATION_STATUS } from '@/shared/constants/translation.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { WINDOWS_MANAGER_EVENTS } from '@/core/PageEventBus.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { getPageTranslationErrorPresentation } from '@/features/page-translation/utils/PageTranslationErrorPresenter.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT_APP, 'useContentAppPageTranslation');

/**
 * Composable for managing page translation states and events in the ContentApp.
 * Synchronizes translation progress with the mobile store and UI components.
 * 
 * @param {Object} mobileStore - The mobile store instance
 * @param {Object} tracker - Resource tracker for event listeners
 * @returns {void}
 */
export function useContentAppPageTranslation(mobileStore, tracker) {
  let errorPresentationRevision = 0;

  const manualContinuityPatch = (detail) => {
    const generation = detail?.manualContinuityGeneration;
    const currentGeneration = mobileStore.pageTranslationData.manualContinuityGeneration ?? -1;
    if (!Number.isSafeInteger(generation) || generation < 0 || generation < currentGeneration) return {};
    if (detail.hasManualContinuity !== true && detail.hasManualContinuity !== false) return {};
    if (generation === currentGeneration
      && detail.hasManualContinuity !== mobileStore.pageTranslationData.hasManualContinuity) return {};
    return { hasManualContinuity: detail.hasManualContinuity, manualContinuityGeneration: generation };
  };
  const isObsoleteGeneration = (detail) => Number.isSafeInteger(detail?.manualContinuityGeneration)
    && detail.manualContinuityGeneration < (mobileStore.pageTranslationData.manualContinuityGeneration ?? -1);

  onMounted(() => {
    const pageEventBus = window.pageEventBus;
    if (!pageEventBus) return;

    // Mobile Sheet Visibility & Data Events
    tracker.addEventListener(pageEventBus, WINDOWS_MANAGER_EVENTS.SHOW_MOBILE_SHEET, (detail) => {
      logger.info('Received SHOW_MOBILE_SHEET event:', detail);
      
      if (detail.isOpen === false) {
        mobileStore.closeSheet();
        return;
      }

      if (detail.text !== undefined) {
        mobileStore.updateSelectionData({
          text: detail.text,
          translation: detail.translation || '',
          sourceLang: detail.sourceLang || detail.sourceLanguage || 'auto',
          targetLang: detail.targetLang || detail.targetLanguage || 'en',
          isLoading: detail.isLoading || false,
          isError: detail.isError || false,
          error: detail.error || null,
          mode: detail.mode || null
        });
      }

      mobileStore.openSheet(
        detail.view || MOBILE_CONSTANTS.VIEWS.SELECTION, 
        detail.state || MOBILE_CONSTANTS.SHEET_STATE.PEEK
      );
    });

    // Page Translation Life-cycle Events
    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_START, (detail) => {
      logger.debug('PAGE_TRANSLATE_START received:', detail);
      if (isObsoleteGeneration(detail)) return;
      errorPresentationRevision++;
      mobileStore.setPageTranslation({
        isTranslating: true,
        isTranslated: detail.isTranslated === true,
        isAutoTranslating: detail.isAutoTranslating || false,
        ...manualContinuityPatch(detail),
        status: TRANSLATION_STATUS.TRANSLATING,
        translatedCount: 0,
        failedCount: 0,
        totalCount: 0,
        errorMessage: null,
      });

      if (deviceDetector.isMobile()) {
        logger.info('Mobile: Page translation started, switching view');
        mobileStore.setView(MOBILE_CONSTANTS.VIEWS.PAGE_TRANSLATION);
        mobileStore.setSheetState(MOBILE_CONSTANTS.SHEET_STATE.PEEK);
      }
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_PROGRESS, (detail) => {
      logger.debug('PAGE_TRANSLATE_PROGRESS received:', detail);
      if (isObsoleteGeneration(detail)) return;
      
      // If we are in a context with an aggregator (main frame), prioritize aggregated messages
      // to avoid UI "jumping" between iframe-specific and aggregated progress
      const isMainFrame = window.self === window.top;
      if (isMainFrame && !detail.isAggregated && mobileStore.pageTranslationData.status !== TRANSLATION_STATUS.IDLE) {
        return;
      }

      errorPresentationRevision++;

      const translatedCount = detail.translatedCount ?? detail.translated ?? mobileStore.pageTranslationData.translatedCount;
      const failedCount = detail.failedCount ?? detail.failed ?? 0;
      const totalCount = detail.totalCount ?? mobileStore.pageTranslationData.totalCount;

      // Use status from aggregator if available, otherwise calculate based on counts
      let finalStatus = detail.status || ((translatedCount + failedCount) >= totalCount ? TRANSLATION_STATUS.COMPLETED : TRANSLATION_STATUS.TRANSLATING);

      // Map 'idle' status to COMPLETED for UI purposes (shows the badge/restore button)
      if (finalStatus === 'idle') {
        finalStatus = TRANSLATION_STATUS.COMPLETED;
      }

      mobileStore.setPageTranslation({
        translatedCount,
        failedCount,
        totalCount,
        isTranslating: detail.isTranslating !== undefined ? detail.isTranslating : mobileStore.pageTranslationData.isTranslating,
        isAutoTranslating: detail.isAutoTranslating !== undefined ? detail.isAutoTranslating : mobileStore.pageTranslationData.isAutoTranslating,
        ...manualContinuityPatch(detail),
        status: finalStatus
      });
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_IDLE, (detail) => {
      logger.debug('PAGE_TRANSLATE_IDLE received:', detail);
      if (isObsoleteGeneration(detail)) return;

      const isMainFrame = window.self === window.top;
      if (isMainFrame && !detail.isAggregated) {
        return;
      }

      errorPresentationRevision++;

      const translatedCount = detail.translatedCount ?? detail.translated ?? mobileStore.pageTranslationData.translatedCount;
      const failedCount = detail.failedCount ?? detail.failed ?? 0;
      const totalCount = detail.totalCount ?? mobileStore.pageTranslationData.totalCount;

      // IDLE means visible content is done but more might be hidden - show as COMPLETED for UI
      mobileStore.setPageTranslation({
        translatedCount,
        failedCount,
        totalCount,
        isTranslating: false,
        isAutoTranslating: detail.isAutoTranslating !== undefined ? detail.isAutoTranslating : mobileStore.pageTranslationData.isAutoTranslating,
        ...manualContinuityPatch(detail),
        isTranslated: detail.isTranslated === true || translatedCount > 0,
        status: TRANSLATION_STATUS.COMPLETED
      });
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_COMPLETE, async (detail) => {
      if (isObsoleteGeneration(detail)) return;
      // Skip empty/invalid completion messages - they might come from iframes or initialization
      // BUT: process if it is aggregated as it represents the whole page state
      if (!detail.isAggregated && (!detail || (detail.translatedCount === 0 && detail.failedCount === 0 && !detail.isTranslated && !mobileStore.pageTranslationData.isTranslating))) {
        logger.debug('Skipping empty PAGE_TRANSLATE_COMPLETE message:', detail);
        return;
      }

      const revision = ++errorPresentationRevision;
      const translatedCount = detail.translatedCount ?? mobileStore.pageTranslationData.translatedCount;
      const failedCount = detail.failedCount ?? detail.failed ?? 0;
      const totalCount = detail.totalCount ?? mobileStore.pageTranslationData.totalCount ?? (translatedCount + failedCount);
      const isZeroResult = translatedCount === 0 && failedCount > 0;
      let errorMessage = null;

      if (isZeroResult && isStructuredTranslationError(detail.errorDetails)) {
        const displayError = await getPageTranslationErrorPresentation(detail);
        if (revision !== errorPresentationRevision || isObsoleteGeneration(detail)) return;
        errorMessage = displayError?.message || null;
      }

      if (revision !== errorPresentationRevision || isObsoleteGeneration(detail)) return;
      mobileStore.setPageTranslation({
        isTranslating: false,
        isTranslated: detail.isTranslated === true || translatedCount > 0,
        isAutoTranslating: detail.isAutoTranslating !== undefined ? detail.isAutoTranslating : mobileStore.pageTranslationData.isAutoTranslating,
        ...manualContinuityPatch(detail),
        status: isZeroResult ? TRANSLATION_STATUS.ERROR : TRANSLATION_STATUS.COMPLETED,
        translatedCount,
        failedCount,
        totalCount,
        errorMessage,
      });
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_ERROR, async (detail) => {
      if (isObsoleteGeneration(detail)) return;
      if (detail.isFatal === false) return;

      const isMainFrame = window.self === window.top;
      if (isMainFrame && detail.isAggregated !== true) return;

      const revision = ++errorPresentationRevision;
      const presentation = await getPageTranslationErrorPresentation(detail);
      if (revision !== errorPresentationRevision || isObsoleteGeneration(detail)) return;
      if (!presentation) return;

      const translatedCount = typeof detail.translatedCount === 'number'
        ? detail.translatedCount
        : typeof detail.committedCount === 'number'
          ? detail.committedCount
          : null;
      const hasCommittedContent = detail.isTranslated === true || (translatedCount !== null
        ? translatedCount > 0
        : mobileStore.pageTranslationData.isTranslated
          || mobileStore.pageTranslationData.translatedCount > 0);
      const currentState = mobileStore.pageTranslationData;
      const isTranslating = detail.isTranslating !== undefined
        ? detail.isTranslating
        : currentState.isTranslating;
      const isAutoTranslating = detail.isAutoTranslating !== undefined
        ? detail.isAutoTranslating
        : currentState.isAutoTranslating;

      if (revision !== errorPresentationRevision || isObsoleteGeneration(detail)) return;
      mobileStore.setPageTranslation({ 
        isTranslating,
        isAutoTranslating,
        isTranslated: hasCommittedContent,
        ...(translatedCount !== null && { translatedCount }),
        status: TRANSLATION_STATUS.ERROR,
        errorMessage: presentation.message,
        ...manualContinuityPatch(detail),
      });
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_TRANSLATE_RESET_ERROR, () => {
      errorPresentationRevision++;
      const currentState = mobileStore.pageTranslationData;
      if (currentState.status !== TRANSLATION_STATUS.ERROR) return;

      const hasTranslatedContent = currentState.isTranslated === true
        || currentState.translatedCount > 0;

      if (hasTranslatedContent) {
        mobileStore.setPageTranslation({
          isTranslating: false,
          isAutoTranslating: false,
          isTranslated: true,
          status: TRANSLATION_STATUS.COMPLETED,
          errorMessage: null,
        });
        return;
      }

      mobileStore.dismissPageTranslationError();
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_RESTORE_COMPLETE, () => {
      logger.debug('PAGE_RESTORE_COMPLETE received, resetting page translation state');
      errorPresentationRevision++;
      mobileStore.resetPageTranslation();
    });

    tracker.addEventListener(pageEventBus, MessageActions.PAGE_AUTO_RESTORE_COMPLETE, (detail) => {
      if (isObsoleteGeneration(detail)) return;
      const currentState = mobileStore.pageTranslationData;
      const isMainFrame = window.self === window.top;

      if (!detail.isAggregated && isMainFrame) return;

      const translatedCount = typeof detail.translatedCount === 'number'
        ? detail.translatedCount
        : currentState.translatedCount;
      const failedCount = typeof detail.failedCount === 'number'
        ? detail.failedCount
        : typeof detail.failed === 'number'
          ? detail.failed
          : currentState.failedCount;
      const totalCount = typeof detail.totalCount === 'number'
        ? detail.totalCount
        : currentState.totalCount;
      const hasTranslations = detail.isTranslated !== undefined
        ? detail.isTranslated || translatedCount > 0
        : translatedCount > 0;

      // Skip empty messages if we already have active/valid translation state
      // This prevents individual iframe messages from overwriting main frame translation data
      // BUT: Allow aggregated messages to pass through as they represent the whole page state
      if (!detail.isAggregated && !isMainFrame && !hasTranslations && (currentState.isTranslated || currentState.isTranslating || currentState.isAutoTranslating)) {
        logger.debug('Skipping empty auto-restore message from iframe, keeping current state:', currentState);
        return;
      }

      errorPresentationRevision++;

      const isTranslating = detail.isTranslating !== undefined
        ? detail.isTranslating
        : false;
      const isAutoTranslating = detail.isAutoTranslating !== undefined
        ? detail.isAutoTranslating
        : false;

      const baseState = {
        isTranslating,
        isAutoTranslating,
        isTranslated: hasTranslations,
        status: isTranslating || isAutoTranslating
          ? TRANSLATION_STATUS.TRANSLATING
          : hasTranslations
            ? TRANSLATION_STATUS.COMPLETED
            : TRANSLATION_STATUS.IDLE,
        translatedCount,
        failedCount,
        totalCount,
        ...manualContinuityPatch(detail)
      };

      mobileStore.setPageTranslation(baseState);
    });

    // Element Translation Sync
    tracker.addEventListener(pageEventBus, WINDOWS_MANAGER_EVENTS.ELEMENT_TRANSLATIONS_AVAILABLE, () => {
      logger.debug('Received ELEMENT_TRANSLATIONS_AVAILABLE event');
      mobileStore.setHasElementTranslations(true);
    });

    tracker.addEventListener(pageEventBus, WINDOWS_MANAGER_EVENTS.ELEMENT_TRANSLATIONS_CLEARED, () => {
      logger.debug('Received ELEMENT_TRANSLATIONS_CLEARED event');
      mobileStore.setHasElementTranslations(false);
    });
  });
}

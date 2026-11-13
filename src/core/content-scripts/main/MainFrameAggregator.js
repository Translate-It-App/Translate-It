/**
 * MainFrameAggregator.js
 * Manages and aggregates translation progress from the main frame and all child iframes.
 */
import { pageEventBus } from '@/core/PageEventBus.js';
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.IFRAME, 'Aggregator');

export class MainFrameAggregator {
  constructor(MessageActions) {
    this.MessageActions = MessageActions;
    this.frameProgressMap = new Map();
    this.terminalCauseSequence = 0;
    
    // Bind methods to ensure correct 'this' context
    this.updateFrameData = this.updateFrameData.bind(this);
    this.getGlobalPageTranslationStatus = this.getGlobalPageTranslationStatus.bind(this);
    this.emitAggregateProgress = this.emitAggregateProgress.bind(this);
  }

  /**
   * Updates a specific frame's progress data by merging it with existing data.
   * @param {Window|string} frameId - Source window or identifier for the frame.
   * @param {Object} newData - New progress data to merge.
   */
  updateFrameData(frameId, newData) {
    const existing = this.frameProgressMap.get(frameId) || {};
    this.frameProgressMap.set(frameId, { ...existing, ...newData });
  }

  removeFrame(frameId) {
    this.frameProgressMap.delete(frameId);
  }

  /**
   * Clears all progress data (usually on a fresh translation start).
   */
  clearAll() {
    this.frameProgressMap.clear();
    this.terminalCauseSequence = 0;
  }

  recordTerminalCause(frameId, errorDetails) {
    if (!isStructuredTranslationError(errorDetails)) return;

    const progress = this.frameProgressMap.get(frameId);
    if (!progress) return;

    progress.terminalErrorDetails = errorDetails;
    progress.terminalCauseSequence = ++this.terminalCauseSequence;
  }

  getLatestTerminalCause() {
    let latestCause = null;
    let latestSequence = -1;

    for (const progress of this.frameProgressMap.values()) {
      if (
        isStructuredTranslationError(progress.terminalErrorDetails)
        && progress.terminalCauseSequence > latestSequence
      ) {
        latestCause = progress.terminalErrorDetails;
        latestSequence = progress.terminalCauseSequence;
      }
    }

    return latestCause;
  }

  /**
   * Computes the global translation status for the entire page across all frames.
   * @returns {Object} Unified status object.
   */
  getGlobalPageTranslationStatus() {
    let grandTotalTranslated = 0;
    let grandTotalFailed = 0;
    let grandTotalCount = 0;
    let anyAutoTranslating = false;
    let anyActiveTranslating = false;
    let isTranslated = false;
    
    for (const progress of this.frameProgressMap.values()) {
      grandTotalTranslated += progress.translatedCount || 0;
      grandTotalFailed += progress.failedCount || progress.failed || 0;
      grandTotalCount += progress.totalCount || 0;
      
      if (progress.isAutoTranslating) anyAutoTranslating = true;
      if (progress.isTranslated || progress.translatedCount > 0) isTranslated = true;
      
      // A frame is actively translating if it hasn't signaled 'idle' and has remaining tasks
      const isExplicitlyIdle = progress.status === 'idle' || progress.isTranslating === false;
      const processed = (progress.translatedCount || 0) + (progress.failedCount || progress.failed || 0);
      if (!isExplicitlyIdle && (processed < progress.totalCount || progress.totalCount === 0)) {
        anyActiveTranslating = true;
      }
    }
    
    return {
      success: true,
      isActive: isTranslated || anyActiveTranslating || anyAutoTranslating,
      isTranslating: anyActiveTranslating,
      isTranslated: isTranslated,
      isAutoTranslating: anyAutoTranslating,
      translatedCount: grandTotalTranslated,
      failedCount: grandTotalFailed,
      totalCount: grandTotalCount,
      currentUrl: window.location.href
    };
  }

  /**
   * Aggregates progress from all trusted frames, then publishes local UI state
   * and one unified top-frame runtime event.
   * @param {string|null} overrideAction - Optional action name to override the default progress event.
   * @param {Object} extraData - Additional data to include in the payload.
   */
  emitAggregateProgress(overrideAction = null, extraData = {}) {
    const status = this.getGlobalPageTranslationStatus();

    if (pageEventBus) {
      const action = overrideAction || this.MessageActions.PAGE_TRANSLATE_PROGRESS;
      const payload = {
        isAggregated: true,
        ...extraData,
        // Override with aggregated values to ensure they are not overwritten by frame-specific data
        translatedCount: status.translatedCount,
        failedCount: status.failedCount,
        totalCount: status.totalCount,
        isAutoTranslating: status.isAutoTranslating,
        isTranslating: status.isTranslating,
        status: status.isTranslating ? 'translating' : 'idle'
      };

      // Special handling for completion events
      if (action === this.MessageActions.PAGE_TRANSLATE_COMPLETE ||
          action === this.MessageActions.PAGE_AUTO_RESTORE_COMPLETE) {
        payload.isTranslated = status.translatedCount > 0;
        payload.url = window.location.href;

        if (action === this.MessageActions.PAGE_TRANSLATE_COMPLETE) {
          delete payload.errorDetails;
          if (!status.isTranslating && status.translatedCount === 0 && status.failedCount > 0) {
            const terminalCause = this.getLatestTerminalCause();
            if (terminalCause) payload.errorDetails = terminalCause;
          }
        }
      } else if (action === this.MessageActions.PAGE_TRANSLATE_ERROR) {
        // A failing frame must not hide the page-wide translation state: the
        // aggregated error keeps the accepted translations of the other frames
        // so Restore stays available while translated content is retained.
        payload.isTranslated = status.translatedCount > 0;
      } else if (action === this.MessageActions.PAGE_RESTORE_COMPLETE) {
        // For restore complete, force clean state regardless of frame data
        payload.isTranslated = false;
        payload.isTranslating = false;
        payload.isAutoTranslating = false;
        payload.translatedCount = 0;
        payload.failedCount = 0;
        payload.totalCount = 0;
        payload.status = 'idle';
        payload.url = window.location.href;
      }

      logger.debug(`Emitting aggregated event: ${action}`, payload);

      pageEventBus.emit(action, payload);
      sendRegularMessage({
        action,
        data: payload,
        context: 'page-translation-aggregate',
      }, { silent: true }).catch(() => {});

      return payload;
    }
  }
}

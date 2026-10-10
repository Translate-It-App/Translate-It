import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons, MessageFormat } from '@/shared/messaging/core/MessagingCore.js';

import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getPageTranslationErrorPresentation } from './utils/PageTranslationErrorPresenter.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { NOTIFICATION_TIME } from '@/shared/constants/ui.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { ToastIntegration } from '@/shared/toast/ToastIntegration.js';
import { getTranslationString } from '@/utils/i18n/i18n.js';
import { shouldShowProviderWarning } from '@/shared/utils/warning-manager.js';
import { delay } from '@/core/helpers.js';
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { isSilentError } from '@/shared/error-management/ErrorMatcher.js';

// Internal components
import { PageTranslationHelper } from './PageTranslationHelper.js';
import { PageTranslationScheduler } from './PageTranslationScheduler.js';
import { PageTranslationBridge } from './PageTranslationBridge.js';
import { hoverPreviewManager } from '@/features/shared/hover-preview/HoverPreviewManager.js';
import { PageTranslationScrollTracker } from './utils/PageTranslationScrollTracker.js';
import { PAGE_TRANSLATION_TIMING } from './PageTranslationConstants.js';
import NotificationManager from '@/core/managers/core/NotificationManager.js';

// Modularized utilities
import { PageTranslationSettingsLoader } from './utils/PageTranslationSettingsLoader.js';
import { PageTranslationEventManager } from './utils/PageTranslationEventManager.js';

const INTERNAL_CANCELLATION_REASON = 'operation-abort';

export class PageTranslationManager extends ResourceTracker {
  constructor({ featureManager } = {}) {
    super('page-translation-manager');
    this.logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'Manager');
    this.featureManager = featureManager || null;

    this.toastIntegration = new ToastIntegration(pageEventBus);
    this.notificationManager = new NotificationManager();

    this.isActive = false;
    this.isTranslating = false;
    this.isTranslated = false;
    this.isAutoTranslating = false;
    this.currentUrl = null;
    this.abortController = null;
    this.translationMessageId = null;
    this.acceptedLifecycleSessionId = null;
    this.sessionContext = null;
    this.isFatalErrorHandling = false;
    this._isCancelling = false;
    this.userRestoredOverride = false;
    this.autoStartCancelledUrls = new Set();
    this.translationSettingsRevision = 0;
    this.pendingSettingsAttempt = null;

    
    this.scheduler = new PageTranslationScheduler({
      onFatalError: (fatal) => this._handleSchedulerFatalError(fatal),
      onLifecycleEvent: (action, data) => this._handleSchedulerLifecycle(action, data),
      onInternalError: (details) => this._handleSchedulerInternalError(details),
    });
    this.bridge = new PageTranslationBridge();
    this.hoverManager = hoverPreviewManager;
    this.scrollTracker = new PageTranslationScrollTracker(
      () => {
        this.logger.debug('Scroll stop detected, signaling scheduler');
        this.scheduler.signalScrollStop();
      },
      () => {
        this.logger.debug('Scroll start detected, signaling scheduler');
        this.scheduler.signalScrollStart();
      }
    );

    this.settings = {};
    
    // Modularize event management
    this.eventManager = new PageTranslationEventManager(this);
  }

  async activate() {
    if (this.isActive) return true;
    try {
      this.eventManager.initialize();
      await this.toastIntegration.initialize();
      this.settings = await PageTranslationSettingsLoader.load();
      this.scheduler.setSettings(this.settings);
      
      if (this.settings.showOriginalOnHover) {
        this.hoverManager.initialize();
      }
      
      this.isActive = true;
      this.logger.init('PageTranslationManager activated');
      return true;
    } catch (error) {
      this.logger.error('Activation failed', error);
      return false;
    }
  }

  async deactivate() {
    if (!this.isActive) return;
    await this.cleanup();
    this.isActive = false;
  }

  async translatePage(options = {}) {
    if (options.navigationUnavailable) {
      void this.stopAutoTranslation({ cancellationReason: INTERNAL_CANCELLATION_REASON });
      return { success: false, reason: ActionReasons.SILENT_ERROR };
    }
    const cursor = options.navigationCursor;
    if (Object.hasOwn(options, 'navigationCursor') && (
      !Number.isSafeInteger(cursor?.documentEpoch) || cursor.documentEpoch <= 0
      || !Number.isSafeInteger(cursor.routeRevision) || cursor.routeRevision < 0
      || cursor.url !== window.location.href
      || (this.featureManager && !this.featureManager.acceptPageNavigation?.(cursor))
    )) return { success: false, reason: ActionReasons.SILENT_ERROR };
    let hasAcceptedStart = false;
    // 1. Check for URL change - ALWAYS reset for a clean slate in SPAs
    if (this.currentUrl !== window.location.href) {
      this.resetLocalState({ preserveAcceptedTranslations: !!options.isAuto && !!options.preserveAcceptedTranslations });
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.translationMessageId = null;
      this.acceptedLifecycleSessionId = null;
      this.sessionContext = null;
      this.currentUrl = window.location.href;
      this.userRestoredOverride = false;
    }

    if (this.isTranslating || (this.isTranslated && !options.isAuto)) return { success: false, reason: ActionReasons.BUSY_OR_DONE };
    if (!PageTranslationHelper.isSuitableForTranslation(this.logger)) return { success: false, reason: ActionReasons.NOT_SUITABLE };

    // Inject layout fixes to the host page
    const layoutBeforeAttempt = {
      classActive: document.documentElement.classList.contains('ti-translation-active'),
      styleActive: Boolean(document.getElementById('ti-translation-layout-fix')),
    };
    const attempt = {
      controller: null,
      messageId: null,
      sessionContext: null,
      url: window.location.href,
      explicitProvider: options.provider,
      settingsRevision: this.translationSettingsRevision,
      previousState: {
        isTranslated: this.isTranslated,
        isTranslating: this.isTranslating,
        isAutoTranslating: this.isAutoTranslating,
        layoutAlreadyActive: layoutBeforeAttempt.classActive || layoutBeforeAttempt.styleActive,
        layoutOwnedByAcceptedState: (this.isTranslated || this.isTranslating)
          && (layoutBeforeAttempt.classActive || layoutBeforeAttempt.styleActive),
        abortController: this.abortController,
        translationMessageId: this.translationMessageId,
        sessionContext: this.sessionContext,
      },
    };

    try {
      this.pendingSettingsAttempt = attempt;
      this._injectLayoutFix();

      this.isTranslating = true;
      attempt.controller = new AbortController();
      attempt.messageId = `page-translate-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      attempt.sessionContext = Symbol('translation-session');
      this.abortController = attempt.controller;
      this.translationMessageId = attempt.messageId;
      this.sessionContext = attempt.sessionContext;

      // Reserve cancellation ownership before resolving the feature conflict.
      await this.featureManager?.resolveFeatureConflict?.('pageTranslation');
      if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);

      const settings = await PageTranslationSettingsLoader.load(options);
      if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);
      this.settings = settings;
      if (this.pendingSettingsAttempt === attempt) this.pendingSettingsAttempt = null;

      // Token Usage Warning: AI and DeepL providers consume tokens/credits.
      // Whole Page Translation is very heavy, so we warn the user to avoid surprise costs.
      const providerId = this.settings.translationApi;
      const provider = findProviderById(providerId);
      
      // Use the explicit manifest flag to identify potentially costly services.
      // This is the clean-code way as it centralizes the configuration in the manifest.
      const isTokenHeavy = provider && provider.consumesTokens;

      this.logger.debug('Checking token usage warning:', { providerId, isTokenHeavy, isAuto: options.isAuto });

      // Show warning for token-heavy providers. 
      // We show it even for auto-translation to ensure user is aware, but limited to 2 times total.
      if (isTokenHeavy) {
        const confirmed = await this._confirmTokenUsage(providerId, provider.displayName);
        if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);
        if (!confirmed) {
          this.logger.info('Page translation cancelled: User declined token usage');
          if (options.isAuto) {
            this.autoStartCancelledUrls.add(attempt.url);
          }
          this._cleanupFailedPreStartAttempt(attempt);
          return { success: false, reason: ActionReasons.USER_CANCELLED };
        }
      }

      if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);

      this.acceptedLifecycleSessionId = attempt.messageId;
      this._broadcastEvent(MessageActions.PAGE_TRANSLATE_START, { 
        url: this.currentUrl, 
        messageId: attempt.messageId,
        sessionId: attempt.messageId,
        isAutoTranslating: !!this.settings.autoTranslateOnDOMChanges
      }, attempt.messageId);
      hasAcceptedStart = true;

      this.isTranslated = false;
      this.isTranslating = true;
      this.isAutoTranslating = !!this.settings.autoTranslateOnDOMChanges;

      // Reset only after admission so failed pre-START attempts cannot erase
      // scheduler state belonging to a previously accepted auto-translation.
      this.scheduler.reset();
      this.scheduler.setSettings(this.settings);

      // Update hover manager based on current settings
      if (this.settings.showOriginalOnHover) {
        this.hoverManager.initialize();
      } else {
        this.hoverManager.destroy();
      }

      // Start scroll tracker to ensure visibility-driven flushes for already-enqueued items.
      // This is critical for catching nodes skipped during fast scrolling.
      this.scrollTracker.start(this.settings.scrollStopDelay);

      // Show warning for Lingva provider in Whole Page Translation
      if (this.settings.translationApi === ProviderRegistryIds.LINGVA) {
        if (await shouldShowProviderWarning('Lingva')) {
          const warningMessage = await getTranslationString('LINGVA_WPT_WARNING');
          this.notificationManager.show(
            warningMessage || 'Lingva may have issues with long texts during page translation.',
            'warning',
            NOTIFICATION_TIME.WARNING_PROVIDER
          );
        }
      } else if (this.settings.translationApi === ProviderRegistryIds.BING) {
        if (await shouldShowProviderWarning('Bing')) {
          const warningMessage = await getTranslationString('BING_WPT_WARNING');
          this.notificationManager.show(
            warningMessage || 'Bing may have issues with long texts during page translation.',
            'warning',
            NOTIFICATION_TIME.WARNING_PROVIDER
          );
        }
      }

      if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);
      this.scheduler.setTranslationState(true, this.translationMessageId, this.sessionContext);

      // Initialize bridge with fresh context and standard callback
      await this.bridge.initialize(
        this.settings, 
        (text, context, score, node) => {
          // If we were idle, switch back to translating state
          if (this.isAutoTranslating && !this.isTranslating) {
            this.isTranslating = true;
            this._broadcastEvent(MessageActions.PAGE_TRANSLATE_PROGRESS, {
              status: 'translating',
              isTranslating: true,
              isAutoTranslating: true
            }, attempt.messageId);
          }

          // If we are in "On Stop" mode, notify activity to reset the timer
          if (this.settings.translateAfterScrollStop) {
            this.scrollTracker.notifyActivity();
          }
          return this.scheduler.enqueue(text, context, score, node);
        },
        attempt.sessionContext,
        {
          preserveAcceptedTranslations: !!options.isAuto && !!options.preserveAcceptedTranslations,
          settingsRevision: this.translationSettingsRevision,
          onRetainedTranslation: () => {
            if (this._isCurrentPreStartAttempt(attempt)) {
              this.scheduler.recordRetainedTranslation(attempt.sessionContext);
            }
          },
        }
      );
      if (!this._isCurrentPreStartAttempt(attempt)) return this._settleStalePreStartAttempt(attempt);
      
      // CRITICAL: Translate only document.body to prevent scroll jumps and HEAD-tag interference.
      // Translating documentElement causes jumps to top on sites with complex scrollers (like Twitter).
      this.bridge.translate(document.body);

      // Non-lazy, non-auto translation has no future work when no task was scheduled.
      if (!this.isAutoTranslating && !this.settings.lazyLoading && this.scheduler.totalTasks === 0) {
        const result = {
          success: true,
          url: this.currentUrl,
          messageId: attempt.messageId,
          isAutoTranslating: false
        };
        this._settleSilentPostStart();
        return result;
      }
      
      this.isTranslated = false;
      this.isTranslating = true;
      this.isAutoTranslating = !!this.settings.autoTranslateOnDOMChanges;

      return { 
        success: true, 
        url: this.currentUrl, 
        messageId: attempt.messageId,
        isAutoTranslating: this.isAutoTranslating 
      };
    } catch (error) {
      if (isSilentError(error)) {
        this.logger.debug('translatePage: Silent error caught', error.message);
        if (hasAcceptedStart) {
          this._settleSilentPostStart();
        } else {
          this._cleanupFailedPreStartAttempt(attempt, {
            restorePreviousState: this._canRestorePreStartState(attempt),
          });
        }
        return { success: false, reason: ActionReasons.SILENT_ERROR };
      }
      
      this.logger.error('translatePage failed', error);
      if (!hasAcceptedStart) {
        this._cleanupFailedPreStartAttempt(attempt, {
          restorePreviousState: this._canRestorePreStartState(attempt),
        });
      } else {
        this.isTranslating = false;
        this.isAutoTranslating = false;
      }
      this._broadcastEvent(MessageActions.PAGE_TRANSLATE_ERROR, {
        error: error.message,
        errorDetails: MessageFormat.serializeTranslationError(error)
      }, hasAcceptedStart ? attempt.messageId : null);
      throw error;
    } finally {
      if (this.pendingSettingsAttempt === attempt) this.pendingSettingsAttempt = null;
    }
  }

  _isCurrentPreStartAttempt(attempt) {
    return Boolean(
      attempt?.controller
      && !attempt.controller.signal.aborted
      && this.abortController === attempt.controller
      && this.translationMessageId === attempt.messageId
      && this.sessionContext === attempt.sessionContext
      && this.currentUrl === attempt.url
      && window.location.href === attempt.url
      && this.translationSettingsRevision === attempt.settingsRevision
    );
  }

  _canRestorePreStartState(attempt) {
    return this._isCurrentPreStartAttempt(attempt);
  }

  _settleStalePreStartAttempt(attempt) {
    const isUserCancelled = attempt.controller?.signal?.reason === ActionReasons.USER_CANCELLED
      || attempt.controller?.signal?.reason === 'user-cancelled';
    this._cleanupFailedPreStartAttempt(attempt, {
      restorePreviousState: this._canRestorePreStartState(attempt),
    });
    return {
      success: false,
      reason: isUserCancelled ? ActionReasons.USER_CANCELLED : ActionReasons.SILENT_ERROR,
    };
  }

  _cleanupFailedPreStartAttempt(attempt, { restorePreviousState = true } = {}) {
    if (!attempt) return;

    const ownsController = !attempt.controller || this.abortController === attempt.controller;
    const ownsMessageId = !attempt.messageId || this.translationMessageId === attempt.messageId;
    const ownsSessionContext = !attempt.sessionContext || this.sessionContext === attempt.sessionContext;
    const ownsAttemptState = ownsController && ownsMessageId && ownsSessionContext;

    if (attempt.controller && !attempt.controller.signal.aborted) {
      attempt.controller.abort();
    }
    if (ownsController && this.abortController === attempt.controller) {
      this.abortController = null;
    }
    if (ownsMessageId && this.translationMessageId === attempt.messageId) {
      this.translationMessageId = null;
    }
    if (ownsSessionContext && this.sessionContext === attempt.sessionContext) {
      this.sessionContext = null;
    }

    if (ownsAttemptState) {
      if (restorePreviousState) {
        this.isTranslated = attempt.previousState.isTranslated;
        this.isTranslating = attempt.previousState.isTranslating;
        this.isAutoTranslating = attempt.previousState.isAutoTranslating;
        this.abortController = attempt.previousState.abortController;
        this.translationMessageId = attempt.previousState.translationMessageId;
        this.sessionContext = attempt.previousState.sessionContext;
      } else {
        this.isTranslated = false;
        this.isTranslating = false;
        this.isAutoTranslating = false;
      }

      if (!restorePreviousState || !attempt.previousState.layoutOwnedByAcceptedState) {
        this._removeLayoutFix();
      }
    }
  }

  _settleSilentPostStart() {
    if (!this.isTranslating) return false;

    const translatedCount = this.scheduler.translatedCount || 0;
    const failedCount = this.scheduler.failedCount || 0;
    const totalCount = this.scheduler.totalTasks || 0;
    const isTranslated = translatedCount > 0;
    const sessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;

    this.scrollTracker.stop();
    this.bridge.stopPersistence();
    this.scheduler.setTranslationState(false, undefined, undefined, INTERNAL_CANCELLATION_REASON);
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._cleanupSession();

    this.isTranslating = false;
    this.isAutoTranslating = false;
    this.isTranslated = isTranslated;
    this.sessionContext = null;

    // Keep layout protection with preserved translated DOM; remove it for empty output.
    if (!isTranslated) this._removeLayoutFix();

    this._broadcastEvent(MessageActions.PAGE_TRANSLATE_IDLE, {
      url: this.currentUrl,
      messageId: sessionId,
      sessionId,
      translatedCount,
      failedCount,
      totalCount,
      isTranslated,
      isTranslating: false,
      isAutoTranslating: false
    }, sessionId);

    return true;
  }

  async restorePage(options = {}) {
    if (options.manual) {
      this.userRestoredOverride = true;
    }
    const cancellationReason = options.cancellationReason
      ?? (options.manual ? ActionReasons.USER_STOPPED_PAGE_TRANSLATION : INTERNAL_CANCELLATION_REASON);
    const restoringSessionId = options.sessionId ?? this.acceptedLifecycleSessionId;
    this._cleanupAdmittedSession();
    this._removeLayoutFix();
    try {
      // 0. Stop scroll tracker
      this.scrollTracker.stop();

      // 1. First stop batcher to prevent loop during library's restore
      this.scheduler.setTranslationState(false, undefined, undefined, cancellationReason);
      this.isTranslated = false;
      this.isAutoTranslating = false;

      const translationRoot = this.bridge.getTranslationRoot?.() || document.documentElement;

      // 2. Use standard library restore
      this.bridge.restore(document.documentElement);

      // 3. Deep clean any remaining markers
      PageTranslationHelper.deepCleanDOM(translationRoot);

      // 4. Get the count before resetting
      const restoredCount = this.scheduler.translatedCount || 0;

      // 5. Complete reset
      this.resetLocalState();

      // Small delay for DOM to stabilize
      await delay(PAGE_TRANSLATION_TIMING.DOM_STABILIZATION_DELAY);

      const resultData = {
        url: this.currentUrl,
        restoredCount,
        ...(restoringSessionId && { sessionId: restoringSessionId }),
      };
      this._broadcastEvent(MessageActions.PAGE_RESTORE_COMPLETE, resultData, restoringSessionId);
      if (this.acceptedLifecycleSessionId === restoringSessionId) {
        this.acceptedLifecycleSessionId = null;
      }
      return { success: true, ...resultData };
    } catch (error) {
      this.logger.error('Restore failed', error);
      this._broadcastEvent(MessageActions.PAGE_RESTORE_ERROR, {
        error: error.message,
        errorDetails: MessageFormat.serializeTranslationError(error)
      }, restoringSessionId);
      throw error;
    }
  }

  resetError() {
    this.isFatalErrorHandling = false;
    this._broadcastEvent(MessageActions.PAGE_TRANSLATE_RESET_ERROR, { isInternal: true });
  }

  resetLocalState({ preserveAcceptedTranslations = false } = {}) {
    this._removeLayoutFix();
    this.isTranslated = false;
    this.isTranslating = false;
    this.isAutoTranslating = false;
    this.isFatalErrorHandling = false; // Reset flag
    this.sessionContext = null;
    this.scheduler.reset();
    // Keep one stopped restore owner until a replacement session is admitted.
    if (preserveAcceptedTranslations) this.bridge.stopPersistence();
    else this.bridge.cleanup();
  }

  /**
   * Stop auto-translation (persistence) or current pass without restoring
   * @param {Object} [options] - Stop provenance options
   * @param {string} [options.cancellationReason] - Remote cancellation reason
   */
  async stopAutoTranslation({ cancellationReason = ActionReasons.USER_STOPPED_PAGE_TRANSLATION } = {}) {
    if (cancellationReason === ActionReasons.USER_STOPPED_PAGE_TRANSLATION) this.userRestoredOverride = true;
    // Lazy nodes can still own a live session after presentation becomes idle.
    if (!this.isAutoTranslating && !this.isTranslating
        && !this.scheduler.isTranslated && !this.bridge.session?.active) {
      return { success: false, reason: ActionReasons.NOT_AUTO_TRANSLATING };
    }

    try {
      this.logger.info('Stopping page translation/persistence without restoring');
      const stoppingSessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;

      this.scrollTracker.stop();
      this.bridge.stopPersistence();
      this.abortController?.abort();
      this.abortController = null;
      this.sessionContext = null;
      this.isAutoTranslating = false;
      this.isTranslating = false;
      this.isTranslated = this.scheduler.translatedCount > 0;

      // Stop the scheduler from processing more batches
      this.scheduler.setTranslationState(false, undefined, undefined, cancellationReason);
      this._cleanupSession(stoppingSessionId);

      const resultData = {
        url: this.currentUrl,
        translatedCount: this.scheduler.translatedCount,
        isTranslated: this.isTranslated,
        isAutoTranslating: false,
        ...(stoppingSessionId && { sessionId: stoppingSessionId }),
      };

      this._broadcastEvent(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, resultData, stoppingSessionId);
      return { success: true, ...resultData };
    } catch (error) {
      this.logger.error('Failed to stop auto-translation', error);
      return { success: false, error: error.message };
    }
  }

  cancelTranslation(options = {}) {
    if (this._isCancelling) return;
    this._isCancelling = true;

    try {
      const cancellingSessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;
      this._cleanupAdmittedSession();
      this.restorePage({
        ...options,
        sessionId: cancellingSessionId,
        cancellationReason: options.cancellationReason ?? ActionReasons.USER_STOPPED_PAGE_TRANSLATION,
      }); // Use full restore for cancel
      
      if (this.abortController) {
        this.abortController.abort();
        this._broadcastEvent(MessageActions.PAGE_TRANSLATE_CANCELLED, {
          ...(cancellingSessionId && { sessionId: cancellingSessionId }),
        }, cancellingSessionId);
      }
    } finally {
      this._isCancelling = false;
    }
  }

  /**
   * Best-effort persistence for the "don't show again" token warning choice.
   * Never blocks or alters the confirm/cancel flow; failures are logged.
   * @private
   */
  _persistTokenWarningHidden() {
    void storageManager.set({ WHOLE_PAGE_TOKEN_WARNING_HIDDEN: true }).catch(error => {
      this.logger.warn('Failed to persist token warning preference:', error);
    });
  }

  /**
   * Shows a confirmation dialog for token-heavy providers (AI, DeepL) 
   * to warn the user about potential high usage in Page Translation.
   * 
   * @param {string} providerId - The provider registry ID
   * @param {string} providerName - Display name of the provider
   * @returns {Promise<boolean>} True if user confirms, false if cancelled
   * @private
   */
  async _confirmTokenUsage(providerId, providerName) {
    // 1. Check if the warning is permanently hidden in settings
    if (this.settings.tokenWarningHidden) {
      this.logger.debug('Token usage warning is permanently hidden in settings');
      return true;
    }

    this.logger.info(`Showing token usage warning for provider: ${providerName}`);

    const rawMessage = await getTranslationString('page_translation_token_warning');
    const message = (rawMessage || 'The selected provider ({provider}) uses tokens/credits. Do you want to proceed?')
      .replace('{provider}', providerName);
    const confirmLabel = await getTranslationString('page_translation_token_confirm');
    const cancelLabel = await getTranslationString('page_translation_token_cancel');
    const dontShowAgainLabel = await getTranslationString('dont_show_again');

    return new Promise((resolve) => {
      this.notificationManager.show(message, 'warning', Infinity, {
        persistent: true,
        hasCheckbox: true,
        checkboxLabel: dontShowAgainLabel || "Don't show again",
        actions: [
          {
            label: confirmLabel || 'Translate Anyway',
            onClick: (dontShowAgain) => {
              this.logger.info('User confirmed token usage', { dontShowAgain });
              if (dontShowAgain) {
                this._persistTokenWarningHidden();
              }
              resolve(true);
            }
          },
          {
            label: cancelLabel || 'Cancel',
            onClick: (dontShowAgain) => {
              this.logger.info('User cancelled translation due to token warning', { dontShowAgain });
              if (dontShowAgain) {
                this._persistTokenWarningHidden();
              }
              resolve(false);
            }
          }
        ]
      });
    });
  }

  _handleSchedulerFatalError(fatal = {}) {
    const { error, errorType, sessionId, sessionContext, localizedMessage } = fatal || {};

    if (sessionId == null || sessionContext == null) return false;
    if (sessionId !== this.translationMessageId || sessionContext !== this.sessionContext) return false;
    if (this.scheduler.translationSessionId !== sessionId) return false;
    if (!this.isTranslating && !this.isAutoTranslating) return false;

    this._handleFatalError(error, errorType, localizedMessage, sessionId);
    return true;
  }

  _handleSchedulerInternalError({ error, errorType, isFatal, sessionId } = {}) {
    if (isFatal || ExtensionContextManager.isContextError(error)) return;

    this._publishLifecycle(MessageActions.PAGE_TRANSLATE_ERROR, {
      error: error?.message || String(error),
      errorDetails: MessageFormat.serializeTranslationError(error),
      errorType,
      isFatal: false,
    }, sessionId);
  }

  _handleSchedulerLifecycle(action, data = {}) {
    if (
      action === MessageActions.PAGE_TRANSLATE_COMPLETE
      || action === MessageActions.PAGE_TRANSLATE_IDLE
    ) {
      this.isTranslating = false;
      this.isTranslated = (data.translatedCount || 0) > 0;
    }

    this._publishLifecycle(action, data, data.sessionId);
  }

  _handleFatalError(error, errorType, localizedMessage = null, sessionId = this.translationMessageId) {
    if (this.isFatalErrorHandling) return;
    this.isFatalErrorHandling = true;
    const translatedCount = this.scheduler.translatedCount;

    const isContextError = ExtensionContextManager.isContextError(error);

    // Use centralized context error detection to avoid orange/red logs
    if (isContextError) {
      ExtensionContextManager.handleContextError(error, 'page-translation-fatal');
    } else {
      this.logger.warn('Fatal error. Stopping page translation.', error.message);
    }

    // CRITICAL: Stop further translation without restoring the page.
    // We call this BEFORE resetting local flags to ensure its internal guards pass.
    this.stopAutoTranslation({ cancellationReason: INTERNAL_CANCELLATION_REASON }).catch(err => {
      this.logger.debug('stopAutoTranslation failed in fatal handler (expected if already stopped):', err);
    });

    this.isTranslating = false;
    this.isAutoTranslating = false;
    this.isFatalErrorHandling = false;

    // Use Page's public presentation boundary before centralized ErrorHandler.
    if (!isContextError) {
      void getPageTranslationErrorPresentation({ error, errorType }).then((displayError) => {
        if (!displayError) return;
        return ErrorHandler.getInstance().handle(displayError, {
          type: errorType || displayError.type || ErrorTypes.TRANSLATION_FAILED,
          context: 'page-translation-fatal',
          showToast: true
        });
      }).catch(err => {
        this.logger.error('ErrorHandler failed in _handleFatalError:', err);
      });
    }

    // Don't broadcast UI error for context errors to keep it silent
    if (!isContextError) {
      this._broadcastEvent(MessageActions.PAGE_TRANSLATE_ERROR, {
        error: localizedMessage || error.message || String(error),
        errorDetails: MessageFormat.serializeTranslationError(error),
        errorType: errorType || ErrorTypes.TRANSLATION_FAILED,
        translatedCount,
        isFatal: true
      }, sessionId);
    }

    // ALWAYS broadcast local state update via PageEventBus to ensure UI (FAB, Sidepanel) 
    // resets its state even on non-silent fatal errors.
    this._publishLifecycle(MessageActions.PAGE_TRANSLATE_PROGRESS, {
      status: 'idle',
      isTranslating: false,
      isAutoTranslating: false,
      percent: 0,
      isInternal: true
    }, sessionId);
  }

  _cleanupSession(sessionId = this.translationMessageId) {
    if (sessionId) {
      if (this.translationMessageId === sessionId) this.translationMessageId = null;
      sendRegularMessage({
        action: MessageActions.CANCEL_SESSION,
        data: { sessionId }
      }).catch(() => {});
    }
  }

  _cleanupAdmittedSession() {
    if (this.translationMessageId && this.translationMessageId !== this.scheduler.translationSessionId) {
      this.translationMessageId = null;
      return;
    }
    this._cleanupSession();
  }

  /**
   * Injects surgical CSS fixes to ensure layout stability during translation.
   * 
   * STRATEGY: "Hybrid Content Management"
   * This method solves the "Scroll Conflict" problem where some sites (Wikipedia) 
   * need aggressive horizontal clipping, while others (Twitter/SPAs) break if 
   * their scroll containers or 'fixed' elements are tampered with.
   * 
   * Why these specific properties?
   * 1. overflow-x: clip -> Superior to 'hidden' as it prevents horizontal scroll 
   *    without creating a new scroll container or affecting vertical scroll logic.
   * 2. position: relative -> Establishes a safe containing block for absolute elements 
   *    (like our UI Host/Toasts) without the destructive side effects of 'contain: paint'.
   * 3. overflow-wrap: break-word -> Prevents long translated strings (e.g., German/Farsi) 
   *    from forcing the body to expand horizontally.
   * 4. Media Query (Mobile/Touch) -> Wikipedia's mobile site forces overflow at the 
   *    <html> level; we clip it there ONLY for mobile to keep Twitter-desktop stable.
   * 
   * @private
   */
  _injectLayoutFix() {
    try {
      // Mark html for specificity and styling hooks
      document.documentElement.classList.add('ti-translation-active');

      if (!document.getElementById('ti-translation-layout-fix')) {
        const style = document.createElement('style');
        style.id = 'ti-translation-layout-fix';
        style.textContent = `
          /**
           * 1. UNIVERSAL BODY PROTECTION
           * Prevents horizontal expansion caused by long translations.
           */
          html.ti-translation-active body {
            /* Clip horizontal overflow without killing vertical scroll */
            overflow-x: clip !important;
            max-width: 100% !important;
            
            /* Ensure absolute children are clipped/positioned within body bounds */
            position: relative !important;

            /* Prevent long words from breaking the layout */
            overflow-wrap: break-word !important;
            word-wrap: break-word !important;
          }

          /**
           * 2. MOBILE & TOUCH SPECIFIC PROTECTION
           * Solves Wikipedia/Mobile-Web horizontal scroll issues.
           */
          @media (max-width: 1024px), (pointer: coarse) {
            html.ti-translation-active {
              /* Force horizontal clip at root level to trap wide tables/elements */
              overflow-x: hidden !important;
              width: 100% !important;
              position: relative !important;
            }

            html.ti-translation-active body {
              /* Ensure body fills viewport correctly on touch devices */
              width: 100% !important;
              margin: 0 !important;
              overflow-x: clip !important;
            }
          }
        `;
        document.head.appendChild(style);
      }
    } catch (e) {
      this.logger.debug('Failed to inject layout fix:', e);
    }
  }

  /**
   * Removes layout fixes and cleans up the DOM after translation is restored or stopped.
   * @private
   */
  _removeLayoutFix() {
    try {
      document.documentElement.classList.remove('ti-translation-active');
      const style = document.getElementById('ti-translation-layout-fix');
      if (style) style.remove();
    } catch (e) {
      this.logger.debug('Failed to remove layout fix:', e);
    }
  }

  _publishLifecycle(action, data = {}, sessionId = null) {
    const lifecycleData = typeof sessionId === 'string' && sessionId.length > 0
      ? { ...data, sessionId }
      : data;
    pageEventBus.emit(action, lifecycleData);

    if (!MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE_ACTIONS.includes(action)) {
      return;
    }

    sendRegularMessage({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: { action, data: lifecycleData },
      context: 'page-translation-frame-lifecycle',
    }, { silent: true }).catch(() => {});
  }

  async _broadcastEvent(action, data = {}, sessionId = null) {
    this._publishLifecycle(action, data, sessionId);

    if (
      !MessageActions.PAGE_TRANSLATION_AGGREGATE_ACTIONS.includes(action)
      && window.self === window.top
    ) {
      sendRegularMessage({ action, data: typeof sessionId === 'string' && sessionId.length > 0 ? { ...data, sessionId } : data, context: 'page-translation-broadcast' }, { silent: true }).catch(() => {});
    }
  }

  getStatus() {
    if (this.currentUrl && this.currentUrl !== window.location.href) {
      this.currentUrl = window.location.href;
    }

    return {
      isActive: this.isActive,
      isTranslating: this.isTranslating,
      isTranslated: this.isTranslated,
      isAutoTranslating: this.isAutoTranslating,
      translatedCount: this.scheduler.translatedCount,
      currentUrl: this.currentUrl,
      settings: this.settings,
    };
  }

  async cleanup() {
    this.eventManager.destroy();
    this.cancelTranslation({ cancellationReason: INTERNAL_CANCELLATION_REASON });
    if (this.isTranslated) await this.restorePage();
    this.isAutoTranslating = false;
    this.scrollTracker.destroy();
    this.bridge.cleanup();
    this.scheduler.reset();
    this.acceptedLifecycleSessionId = null;
    if (this.hoverManager) {
      this.hoverManager.destroy();
    }
    if (this.toastIntegration) {
      this.toastIntegration.shutdown();
    }
    super.cleanup();
  }
}

export const pageTranslationManager = new PageTranslationManager();

import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { TranslationMode } from '@/config.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { getPageTranslationErrorPresentation } from './PageTranslationErrorPresenter.js';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js';

const TRANSLATION_SETTING_KEYS = new Set([
  'SOURCE_LANGUAGE', 'TARGET_LANGUAGE', 'OPTIMIZATION_LEVEL', 'BILINGUAL_TRANSLATION',
  'AI_CONTEXT_TRANSLATION_ENABLED', 'SMART_CONTEXT_TRANSLATION_ENABLED',
  'PROMPT_TEMPLATE', 'PROMPT_TEMPLATE_AUTO', 'PROMPT_BASE_BATCH',
  'PROMPT_BASE_AI_BATCH', 'PROMPT_BASE_AI_BATCH_AUTO',
]);

/**
 * PageTranslationEventManager - Specialized class to handle external events
 * (PageEventBus, Storage) for the PageTranslationManager.
 */
export class PageTranslationEventManager {
  /**
   * Initialize event management.
   * @param {PageTranslationManager} manager - The parent manager instance.
   */
  constructor(manager) {
    this.manager = manager;
    this.logger = manager.logger;
    this._init();
  }

  _init() {
    this.initialize();
    this._setupPageEventBusListeners();
  }

  initialize() {
    if (this.navigationListener) return;
    this.navigationListener = (message, sender) => {
      if (message?.action !== MessageActions.SPA_NAVIGATION
          || !browser.runtime.id
          || sender?.id !== browser.runtime.id
          || sender?.tab) return;
      void this.manager.featureManager?.checkForUrlChange({
        navigationCursor: message.data?.navigationCursor,
        navigationUnavailable: message.data?.navigationUnavailable,
      });
    };
    this.manager.addEventListener(browser.runtime.onMessage, 'message', this.navigationListener);
    this._setupStorageListeners();
  }

  destroy() {
    if (!this.navigationListener) return;
    this.manager.removeEventListener(browser.runtime.onMessage, 'message', this.navigationListener);
    this.navigationListener = null;
  }

  _setupStorageListeners() {
    // Stop obsolete work without reverting translations already committed.
    this.manager.addEventListener(storageManager, 'change:TRANSLATION_API', ({ newValue, oldValue }) => {
      const pending = this.manager.pendingSettingsAttempt;
      if (newValue !== oldValue
          && (pending ? !pending.explicitProvider : (
            this.manager.settings?.usesGlobalProvider !== false
            && !this.manager.settings?.isExplicitProvider
            && newValue !== this.manager.settings?.translationApi
          ))) {
        this._invalidateTranslation();
      }
    });

    this.manager.addEventListener(storageManager, 'change:MODE_PROVIDERS', ({ newValue, oldValue }) => {
      const newPageProvider = newValue?.[TranslationMode.Page];
      const oldPageProvider = oldValue?.[TranslationMode.Page];

      const isExplicitProvider = this.manager.pendingSettingsAttempt
        ? !!this.manager.pendingSettingsAttempt.explicitProvider : this.manager.settings?.isExplicitProvider;
      if (newPageProvider !== oldPageProvider && !isExplicitProvider) {
        this._invalidateTranslation();
      }
    });

    this.manager.addEventListener(storageManager, 'change', ({ key, newValue, oldValue }) => {
      if (newValue === oldValue) return;
      const providerId = this.manager.pendingSettingsAttempt?.explicitProvider || this.manager.settings?.translationApi;
      const provider = findProviderById(providerId);
      let affectsTranslation = TRANSLATION_SETTING_KEYS.has(key);

      if (key === 'PROVIDER_OPTIMIZATION_LEVELS') {
        affectsTranslation = newValue?.[providerId] !== oldValue?.[providerId]
          || (provider?.name && newValue?.[provider.name] !== oldValue?.[provider.name]);
      } else if (key === 'BILINGUAL_TRANSLATION_MODES') {
        affectsTranslation = newValue?.[TranslationMode.Page] !== oldValue?.[TranslationMode.Page];
      } else if (providerId && key.startsWith(`${providerId.toUpperCase()}_`)) {
        affectsTranslation = /_(API_KEY|API_URL|API_MODEL|MODEL|THINKING_MODE|API_TIER|FORMALITY|BETA_LANGUAGES_ENABLED)$/.test(key);
        if (affectsTranslation && key.endsWith('_API_KEY')) {
          const previousKeys = ApiKeyManager.parseKeys(oldValue).sort();
          const nextKeys = ApiKeyManager.parseKeys(newValue).sort();
          // Successful failover promotes an existing key without changing credentials.
          affectsTranslation = previousKeys.length !== nextKeys.length
            || previousKeys.some((value, index) => value !== nextKeys[index]);
        }
      }

      if (affectsTranslation) this._invalidateTranslation();
    });

    // Listen for scroll stop delay changes
    this.manager.addEventListener(storageManager, 'change:WHOLE_PAGE_SCROLL_STOP_DELAY', ({ newValue }) => {
      this.logger.debug('WHOLE_PAGE_SCROLL_STOP_DELAY changed in storage:', newValue);
      if (this.manager.settings) {
        this.manager.settings.scrollStopDelay = Number(newValue) || 500;
        
        // Update scroll tracker if it's active
        if (this.manager.scrollTracker) {
          this.manager.scrollTracker.updateDelay(newValue);
        }
      }
    });

    // Listen for mode changes (Fluid vs On Stop)
    this.manager.addEventListener(storageManager, 'change:WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP', ({ newValue }) => {
      this.logger.info('WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP changed in storage:', newValue);
      if (this.manager.settings) {
        this.manager.settings.translateAfterScrollStop = !!newValue;
        
        // Update scroll tracker - it should now be active in BOTH modes
        // to ensure visibility-driven flushes for already-enqueued items.
        if (this.manager.isTranslating || this.manager.isAutoTranslating) {
          this.manager.scrollTracker.start(this.manager.settings.scrollStopDelay);
        }
      }
    });
  }

  _invalidateTranslation() {
    this.manager.translationSettingsRevision = (this.manager.translationSettingsRevision || 0) + 1;
    void this.manager.stopAutoTranslation({ cancellationReason: 'operation-abort' }).catch(() => {
      this.logger.warn('Stopping obsolete page translation failed');
    });
    this.manager.resetError();
  }

  _setupPageEventBusListeners() {
    const bus = window.pageEventBus;
    if (!bus || window._translateItPageTranslationListenersSet) return;

    this.logger.info('Setting up GLOBAL PageEventBus listeners for PageTranslationManager');

    // Aggregate completion is canonical presentation because child-only failures
    // have no top-frame local completion event. Use retained structured cause when available.
    bus.on(MessageActions.PAGE_TRANSLATE_COMPLETE, (data) => {
      if (
        data?.isAggregated
        && data.isTranslating === false
        && data.isAutoTranslating === false
        && data.translatedCount === 0
        && data.failedCount > 0
      ) {
        const presentationDetail = isStructuredTranslationError(data.errorDetails)
          ? data
          : {
              error: Object.assign(new Error('Translation failed'), {
                type: ErrorTypes.TRANSLATION_FAILED,
              }),
              errorType: ErrorTypes.TRANSLATION_FAILED,
            };

        void getPageTranslationErrorPresentation(presentationDetail).then((displayError) => {
          if (!displayError) return;
          return ErrorHandler.getInstance().handle(displayError, {
            type: displayError.type || ErrorTypes.TRANSLATION_FAILED,
            context: 'page-translation-zero-result',
            showToast: true,
          });
        }).catch(err => this.logger.warn('ErrorHandler failed for zero-result page translation:', err));
      }
    });

    // 2. Error Handling
    bus.on(MessageActions.PAGE_TRANSLATE_RESET_ERROR, (data) => {
      if (!data?.isInternal) this.manager.resetError();
    });

    bus.on('page-translation-internal-error', async (data) => {
      if (data.isFatal || ExtensionContextManager.isContextError(data.error)) return;

      this.logger.debug('Non-fatal page translation error received', data.error);

      const presentationPromise = getPageTranslationErrorPresentation({
        error: data.error,
        errorDetails: data.errorDetails,
        errorType: data.errorType,
      });

      const displayError = await presentationPromise;
      if (displayError) this.logger.debug('Non-fatal page translation failure kept silent', displayError.type);
    });

    window._translateItPageTranslationListenersSet = true;
  }
}

import browser from "webextension-polyfill";
import { featureLoader } from "@/core/background/feature-loader.js";

import { initializeSettingsListener } from "@/shared/config/config.js";
import { TranslationEngine } from "@/features/translation/core/translation-engine.js";
import { createMessageHandler } from "@/shared/messaging/core/MessageHandler.js";
import * as Handlers from "@/core/background/handlers/index.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import * as browserCapabilities from '@/core/browserHandlers.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { utilsFactory } from '@/utils/UtilsFactory.js';
import { LIVE_DUBBING_ACTIONS } from '@/features/live-dubbing/constants.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'LifecycleManager');

function isChromeRuntime() {
  if (typeof __BROWSER__ !== 'undefined') return __BROWSER__ === 'chrome';
  const detector = Object.prototype.hasOwnProperty.call(browserCapabilities, 'isChrome')
    ? browserCapabilities.isChrome
    : null;
  return typeof detector === 'function' ? detector() : true;
}

async function handleLiveDubbingSetOriginalVolumeLazy(message, sender) {
  try {
    const { handleLiveDubbingSetOriginalVolume } = await import('@/features/live-dubbing/background/handlers.js');
    return handleLiveDubbingSetOriginalVolume(message, sender);
  } catch {
    return { success: false, error: 'LIVE_DUBBING_HANDLER_UNAVAILABLE' };
  }
}

async function handleLiveDubbingGetOriginalVolumeLazy(message, sender) {
  try {
    const { handleLiveDubbingGetOriginalVolume } = await import('@/features/live-dubbing/background/handlers.js');
    return handleLiveDubbingGetOriginalVolume(message, sender);
  } catch {
    return { success: false, error: 'LIVE_DUBBING_HANDLER_UNAVAILABLE' };
  }
}

async function handleLiveDubbingSetDubbedVolumeLazy(message, sender) {
  try {
    const { handleLiveDubbingSetDubbedVolume } = await import('@/features/live-dubbing/background/handlers.js');
    return handleLiveDubbingSetDubbedVolume(message, sender);
  } catch {
    return { success: false, error: 'LIVE_DUBBING_HANDLER_UNAVAILABLE' };
  }
}

async function handleLiveDubbingGetDubbedVolumeLazy(message, sender) {
  try {
    const { handleLiveDubbingGetDubbedVolume } = await import('@/features/live-dubbing/background/handlers.js');
    return handleLiveDubbingGetDubbedVolume(message, sender);
  } catch {
    return { success: false, error: 'LIVE_DUBBING_HANDLER_UNAVAILABLE' };
  }
}

async function handleLiveDubbingOriginalTranscriptLazy(message, sender) {
  try {
    const { handleLiveDubbingOriginalTranscript } = await import('@/features/live-dubbing/background/handlers.js');
    return handleLiveDubbingOriginalTranscript(message, sender);
  } catch {
    return { success: false, error: 'LIVE_DUBBING_HANDLER_UNAVAILABLE' };
  }
}

async function handleDebugBridgeActionLazy(action, ...args) {
  try {
    const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js');
    return debugModeBridge.getHandlerMappings()[action](...args);
  } catch {
    return { success: false, error: 'DEBUG_LOGGING_HANDLER_UNAVAILABLE' };
  }
}

class LifecycleManager {
  constructor() {
    this.initialized = false;
    this._initializationPromise = null;
    this._handlersRegistered = false;
    this._browserApiInitialized = false;
    this._translationEngineInitialized = false;
    this._dynamicIconInitialized = false;
    this._errorHandlersInitialized = false;
    this.browser = null;
    this.translationEngine = null;
    this.featureLoader = featureLoader;
    this.messageHandler = createMessageHandler();
    this.dynamicIconManager = null;
    // Note: messageHandler.listen() will be called after handlers are registered
  }

  initialize() {
    if (this._cleanupPromise) {
      return this._cleanupPromise.then(() => this.initialize(), () => this.initialize());
    }
    if (this.initialized) {
      return;
    }

    if (this._initializationPromise) {
      return this._initializationPromise;
    }

    let initializationPromise;
    initializationPromise = (async () => {
      // Register message handlers FIRST to prevent race conditions
      // Only register once per instance to avoid duplicates on retry
      if (!this._handlersRegistered) {
        this.registerMessageHandlers();
        this._handlersRegistered = true;
      }

      // Activate message listener AFTER handlers are registered
      if (!this.messageHandler.isListenerActive) {
        this.messageHandler.listen();
      }

      await this.initializebrowserAPI();

      await this.initializeTranslationEngine();

      await this.initializeDynamicIconManager();

      await this.initializeErrorHandlers();

      await this.preloadFeatures();

      await this.refreshContextMenus();

      // Initialize TTS voice cache in background
      this.initializeTTSVoiceCache();

      this.initialized = true;
      logger.info("[LifecycleManager] Background service initialized successfully");
    })();

    this._initializationPromise = initializationPromise;
    const clearInitializationPromise = () => {
      if (this._initializationPromise === initializationPromise) {
        this._initializationPromise = null;
      }
    };
    void initializationPromise.then(clearInitializationPromise, clearInitializationPromise);
    return initializationPromise;
  }

  /**
   * Initialize TTS voice list cache in background
   * @private
   */
  async initializeTTSVoiceCache() {
    try {
      // Lazy load to keep startup light
      const { ttsVoiceService } = await import("@/features/tts/services/TTSVoiceService.js");
      // This will trigger a fetch only if the 24h cache is expired
      ttsVoiceService.getVoices();
      logger.debug("[LifecycleManager] TTS Voice cache initialization triggered");
    } catch (e) {
      logger.debug("[LifecycleManager] TTS Voice cache initialization skipped:", e.message);
    }
  }

  /**
   * Preload essential features using featureLoader
   * @private
   */
  async preloadFeatures() {
    try {
      logger.info("Preloading essential features...");
      const features = await this.featureLoader.preloadEssentialFeatures();
      logger.info("Essential features preloaded:", Object.keys(features));
    } catch (error) {
      logger.error("Failed to preload essential features:", error);
      // Continue initialization even if preloading fails
    }
  }

  async initializebrowserAPI() {
    if (this._browserApiInitialized) return;
    this.browser = browser;
    globalThis.browser = browser;
    await initializeSettingsListener(browser);
    this._browserApiInitialized = true;
  }

  async initializeTranslationEngine() {
    if (this._translationEngineInitialized && this.translationEngine) return;
    if (this.translationEngine) {
      this.translationEngine = null;
    }
    try {
      logger.info('[LifecycleManager] Creating TranslationEngine...');
      this.translationEngine = new TranslationEngine();
      logger.info('[LifecycleManager] Initializing TranslationEngine...');
      await this.translationEngine.initialize();
      this._translationEngineInitialized = true;
      logger.info('[LifecycleManager] TranslationEngine initialized successfully');
    } catch (error) {
      this.translationEngine = null;
      this._translationEngineInitialized = false;
      logger.error('[LifecycleManager] Failed to initialize TranslationEngine:', error);
      throw error;
    }
  }

  async initializeDynamicIconManager() {
    if (this._dynamicIconInitialized && this.dynamicIconManager?.isInitialized) return;
    logger.info('Initializing ActionbarIconManager...');
    const { getActionbarIconManager } = await utilsFactory.getBrowserUtils();
    const manager = await getActionbarIconManager();
    if (manager.isInitialized === false) {
      throw new Error('ActionbarIconManager not initialized');
    }
    this.dynamicIconManager = manager;
    this._dynamicIconInitialized = true;
    logger.info('ActionbarIconManager initialized');
  }

  registerMessageHandlers() {
    logger.info('Registering message handlers...');
    // Available handlers - logged at TRACE level for detailed debugging
    // logger.trace('Available handlers:', Object.keys(Handlers));
    
    // Hybrid approach: explicit mapping with validation
    const handlerMappings = {
      // Common handlers
      'ping': Handlers.handlePingLazy,
      [MessageActions.OPEN_OPTIONS_PAGE]: Handlers.handleOpenOptionsPageLazy,
      'openURL': Handlers.handleOpenURLLazy,
      [MessageActions.LAUNCH_EXTENSION_APP]: Handlers.handleLaunchExtensionAppLazy,
      'showOSNotification': Handlers.handleShowOSNotification,
      'REFRESH_CONTEXT_MENUS': Handlers.handleRefreshContextMenusLazy,
      'contentScriptWillReload': Handlers.handleContentScriptWillReload,
      [MessageActions.SETTINGS_UPDATED]: Handlers.handleSettingsUpdatedLazy,
      [MessageActions.SET_PROVIDER_CATEGORY_COLLAPSED]: Handlers.handleSetProviderCategoryCollapsedLazy,
      [MessageActions.OFFSCREEN_LOGGING_SETTINGS_GET]: (...args) =>
        handleDebugBridgeActionLazy(MessageActions.OFFSCREEN_LOGGING_SETTINGS_GET, ...args),
      [MessageActions.DEBUG_MODE_CHANGED]: (...args) =>
        handleDebugBridgeActionLazy(MessageActions.DEBUG_MODE_CHANGED, ...args),
      [MessageActions.COMPONENT_LOG_LEVELS_CHANGED]: (...args) =>
        handleDebugBridgeActionLazy(MessageActions.COMPONENT_LOG_LEVELS_CHANGED, ...args),
      
      // Lifecycle handlers
      'contextInvalid': Handlers.handleContextInvalid,
      'extensionReloaded': Handlers.handleExtensionReloaded,
      'restartContentScript': Handlers.handleRestartContentScript,
      'backgroundReloadExtension': Handlers.handleBackgroundReloadExtension,
      
      // Translation handlers
      'TRANSLATE': Handlers.handleTranslateLazy,
      [MessageActions.TRANSLATE_TEXT]: Handlers.handleTranslateTextLazy,
      'translateText': Handlers.handleTranslateTextLazy,
      'revertTranslation': Handlers.handleRevertTranslationLazy,
      'CANCEL_TRANSLATION': Handlers.handleCancelTranslationLazy,
      [MessageActions.CANCEL_SESSION]: Handlers.handleCancelSessionLazy,
      [MessageActions.PARENT_ACCEPTANCE_ACK]: Handlers.handleParentAcceptanceAckLazy,
      'CHECK_TRANSLATION_STATUS': Handlers.handleCheckTranslationStatusLazy,
      [MessageActions.BATCH_TRANSLATE]: Handlers.handleBatchTranslateLazy,

      // TTS handlers - Lazy loaded for better performance
      [MessageActions.GOOGLE_TTS_SPEAK]: Handlers.handleTTSSpeakLazy,
      'TTS_SPEAK': Handlers.handleTTSSpeakLazy,
      [MessageActions.TTS_STOP]: Handlers.handleTTSStopLazy,
      [MessageActions.GOOGLE_TTS_ENDED]: Handlers.handleTTSEndedLazy,
      [MessageActions.INTERNAL_TTS_CHUNK_FINISHED]: Handlers.handleTTSEndedLazy,
      [MessageActions.OFFSCREEN_READY]: Handlers.handleOffscreenReadyLazy,
      'clearTTSHandlerCache': Handlers.clearTTSHandlerCache,
      'getTTSHandlerStats': Handlers.getTTSHandlerStats,
      
      // Element selection handlers - Lazy loaded for better performance
      'activateSelectElementMode': Handlers.handleActivateSelectElementModeLazy,
      'deactivateSelectElementMode': Handlers.handleDeactivateSelectElementModeLazy,
      'setSelectElementState': Handlers.handleSetSelectElementStateLazy,
      'getSelectElementState': Handlers.handleGetSelectElementStateLazy,
      [MessageActions.IFRAME_SELECT_ELEMENT_FINISHED]: Handlers.handleIframeSelectElementFinishedLazy,
      [MessageActions.SELECT_ELEMENT_FRAME_READY]: Handlers.handleSelectElementFrameReadyLazy,
      'clearElementSelectionHandlerCache': Handlers.clearElementSelectionHandlerCache,
      'getElementSelectionHandlerStats': Handlers.getElementSelectionHandlerStats,
      
      // Screen capture handlers - Lazy loaded for better performance
      [MessageActions.START_SCREEN_CAPTURE]: Handlers.handleStartScreenCaptureLazy,
      [MessageActions.CAPTURE_SCREEN_AREA]: Handlers.handleCaptureScreenAreaLazy,
      
      // Text selection handlers
      'getSelectedText': Handlers.handleGetSelectedText,
      [MessageActions.INVALIDATE_PENDING_DISPLAY]: Handlers.handlePendingDisplayInvalidation,
      
      // Page exclusion handlers
      'isCurrentPageExcluded': Handlers.handleIsCurrentPageExcluded,
      'setExcludeCurrentPage': Handlers.handleSetExcludeCurrentPage,

      // Page translation handlers
      [MessageActions.PAGE_TRANSLATE]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_BATCH]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_RESTORE]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_GET_STATUS]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_START]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_PROGRESS]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_IDLE]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_COMPLETE]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_ERROR]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_RESET_ERROR]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_RESTORE_COMPLETE]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_AUTO_RESTORE_COMPLETE]: Handlers.handlePageTranslation, // NEW
      [MessageActions.PAGE_RESTORE_ERROR]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_CANCELLED]: Handlers.handlePageTranslation,
      [MessageActions.PAGE_TRANSLATE_STOP_AUTO]: Handlers.handlePageTranslation, // NEW
      [MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE]: Handlers.handlePageTranslation,
      [MessageActions.MOUSE_HOVER_FRAME_EVENT]: Handlers.handleMouseHoverFrameEvent,
      [MessageActions.MOUSE_HOVER_FRAME_FEEDBACK]: Handlers.handleMouseHoverFrameFeedback,

      // Sidepanel handlers
      'openSidePanel': Handlers.handleOpenSidePanel,
      
      // Vue integration handlers - Lazy loaded for better performance
      'testProviderConnection': Handlers.handleTestProviderConnectionLazy,
      [MessageActions.TEST_CUSTOM_CONNECTION]: Handlers.handleTestCustomConnectionLazy,
      'saveProviderConfig': Handlers.handleSaveProviderConfigLazy,
      'getProviderConfig': Handlers.handleGetProviderConfigLazy,
      'updateContextMenu': Handlers.handleUpdateContextMenuLazy,
      'getExtensionInfo': Handlers.handleGetExtensionInfoLazy,
      'logError': Handlers.handleLogErrorLazy,
      [MessageActions.SYNC_OCR_DOWNLOADABLE_LANGUAGES]: Handlers.handleSyncOCRLanguagesLazy,

      // Vue Bridge handlers - Lazy loaded for better performance
      'CREATE_VUE_MICRO_APP': Handlers.handleVueBridgeLazy,
      'DESTROY_VUE_MICRO_APP': Handlers.handleVueBridgeLazy,

      // Subtitle translation handlers
      [MessageActions.SUBTITLE_TRANSLATE]: Handlers.handleSubtitleTranslation,
      [MessageActions.SUBTITLE_TRANSLATE_CANCEL]: Handlers.handleSubtitleTranslation
    };

    if (isChromeRuntime()) {
      Object.assign(handlerMappings, {
        [MessageActions.START_LIVE_DUBBING]: Handlers.handleLiveDubbingStartLazy,
        [MessageActions.STOP_LIVE_DUBBING]: Handlers.handleLiveDubbingStopLazy,
        [MessageActions.GET_LIVE_DUBBING_STATUS]: Handlers.handleLiveDubbingGetStatusLazy,
        [LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME]: handleLiveDubbingSetOriginalVolumeLazy,
        [LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME]: handleLiveDubbingGetOriginalVolumeLazy,
        [LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME]: handleLiveDubbingSetDubbedVolumeLazy,
        [LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME]: handleLiveDubbingGetDubbedVolumeLazy,
        [LIVE_DUBBING_ACTIONS.MEDIA_OBSERVER_HELLO]: Handlers.handleLiveDubbingMediaObserverHelloLazy,
        [LIVE_DUBBING_ACTIONS.MEDIA_OBSERVATION]: Handlers.handleLiveDubbingMediaObservationLazy,
        [LIVE_DUBBING_ACTIONS.MEDIA_STATE_CHANGED]: Handlers.handleLiveDubbingMediaStateChangedLazy,
        [LIVE_DUBBING_ACTIONS.RETRY_MEDIA]: Handlers.handleLiveDubbingRetryMediaLazy,
        [MessageActions.LIVE_DUBBING_START]: Handlers.handleLiveDubbingStartLazy,
        [MessageActions.LIVE_DUBBING_STOP]: Handlers.handleLiveDubbingStopLazy,
        [MessageActions.LIVE_DUBBING_GET_STATUS]: Handlers.handleLiveDubbingGetStatusLazy,
        [MessageActions.LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP]: Handlers.handleLiveDubbingBootstrapRequestLazy,
        [MessageActions.LIVE_DUBBING_VALIDATE_CREDENTIAL]: Handlers.handleLiveDubbingValidateCredentialLazy,
        [LIVE_DUBBING_ACTIONS.TERMINAL]: Handlers.handleLiveDubbingStopLazy,
        [LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT]: handleLiveDubbingOriginalTranscriptLazy,
        [LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT]: Handlers.handleLiveDubbingTranslatedTranscriptLazy,
      });
    }
    
    // Add browser-specific handlers
    browserCapabilities.addBrowserSpecificHandlers();
    
    // Validate handler mappings
    this.validateHandlerMappings(handlerMappings);
    
    // Register all handlers with proper action names
    const { registeredCount, failedCount } = this.performHandlerRegistration(handlerMappings);
    
    logger.info(`Handler registration complete: ${registeredCount} registered, ${failedCount} failed`);
  }

  /**
   * Validate handler mappings to detect unmapped handlers
   * @private
   * @param {Object} handlerMappings - Handler mappings object
   */
  validateHandlerMappings(handlerMappings) {
    const mappedHandlers = new Set(Object.values(handlerMappings));
    const unmappedHandlerNames = Object.entries(Handlers)
      .filter(([, handler]) => typeof handler === 'function' && !mappedHandlers.has(handler))
      .map(([name]) => name);
    
    if (unmappedHandlerNames.length > 0) {
      logger.warn(`Unmapped handlers detected (consider adding to handlerMappings): ${unmappedHandlerNames.join(', ')}`);
    } else {
      logger.debug('All available handlers are properly mapped');
    }
    
    // Mapping statistics - logged at TRACE level for detailed debugging
    // logger.trace(`Handler mapping validation: ${Object.keys(handlerMappings).length} mapped, ${unmappedHandlers.length} unmapped`);
  }

  /**
   * Perform actual handler registration with error tracking
   * @private
   * @param {Object} handlerMappings - Handler mappings object
   * @returns {Object} Registration results with counts
   */
  performHandlerRegistration(handlerMappings) {
    let registeredCount = 0;
    let failedCount = 0;
    
    for (const [actionName, handlerFunction] of Object.entries(handlerMappings)) {
      if (handlerFunction) {
        try {
          this.messageHandler.registerHandler(actionName, handlerFunction);
          // Handler registered - logged at TRACE level for detailed debugging
          // logger.trace(`Registered handler: ${actionName}`);

          if (actionName === MessageActions.SET_SELECT_ELEMENT_STATE) {
            // Special handler registered - logged at TRACE level for detailed debugging
            // logger.trace('setSelectElementState handler registered', {
            //   actionName,
            //   handlerName: handlerFunction?.name,
            // });
          }
          
          registeredCount++;
        } catch (error) {
          logger.error(`Failed to register handler for action: ${actionName}`, error);
          failedCount++;
        }
      } else {
        logger.warn(`Handler function not found for action: ${actionName}`);
        failedCount++;
      }
    }
    
    return { registeredCount, failedCount };
  }

  /**
   * Initialize error handlers for specific modules
   * @private
   */
  async initializeErrorHandlers() {
    if (this._errorHandlersInitialized) return;
    logger.info("Initializing error handlers...");

    try {
      const { ErrorHandler } = await import(
        "@/shared/error-management/ErrorHandler.js"
      );
      new ErrorHandler();

      // TTS error handling now integrated into handleGoogleTTS directly

      this._errorHandlersInitialized = true;
      logger.info("Error handlers initialization completed");
    } catch (error) {
      logger.error("Failed to initialize error handlers:", error);
    }
  }

  async refreshContextMenus(locale) {
    logger.info("[LifecycleManager] Starting context menu refresh...");

    try {
      // Use featureLoader to get the singleton manager
      this.contextMenuManager = await this.featureLoader.loadContextMenuManager();
      
      // Only call initialize(true) if we need to force a refresh (e.g. locale change)
      // loadContextMenuManager already calls initialize() once
      if (locale) {
        logger.info("[LifecycleManager] Re-initializing context menus with locale:", locale);
        await this.contextMenuManager.initialize(true, locale);
      } else {
        // If no locale specified, ensuring it's at least initialized
        // Note: loadContextMenuManager already initialized it, so this might be redundant
        // but safe due to ContextMenuManager's internal checks.
        // To be even safer against duplicates, we only initialize if NOT already initialized
        if (!this.contextMenuManager.initialized) {
           await this.contextMenuManager.initialize();
        }
      }
      
      logger.info("[LifecycleManager] Context menus refreshed successfully");

    } catch (error) {
      logger.error("[LifecycleManager] Failed to refresh context menus:", error);
      // Try one more direct approach as ultimate fallback if featureLoader failed
      await this.createContextMenuDirectly();
      throw error;
    }
  }

  /**
   * Direct context menu creation as ultimate fallback
   * NOTE: This method is now deprecated. ContextMenuManager should be the sole authority.
   * This is kept only as emergency fallback and will not create duplicate menus.
   */
  async createContextMenuDirectly() {
    try {
      logger.info("[LifecycleManager] ContextMenuManager failed, checking if menus exist...");

      const browser = await import("webextension-polyfill");

      // Check if any menus already exist before doing anything
      try {
        const existingMenus = await browser.contextMenus.getAll();
        if (existingMenus && existingMenus.length > 0) {
          logger.info("[LifecycleManager] Context menus already exist, skipping creation to avoid duplicates");
          return;
        }
      } catch {
        logger.debug("[LifecycleManager] Could not check existing menus, proceeding with caution");
      }

      logger.warn("[LifecycleManager] Creating minimal fallback menus only if absolutely necessary...");

      // Create minimal fallback menus with unique IDs that won't conflict
      try {
        await browser.contextMenus.create({
          id: "lifecycle-emergency-translate",
          title: "Translate (Emergency)",
          contexts: ["action"]
        });
      } catch (createError) {
        logger.error("[LifecycleManager] Even emergency menu creation failed:", createError);
      }

      logger.info("[LifecycleManager] Emergency context menu setup completed");

    } catch (directError) {
      logger.error("[LifecycleManager] Emergency context menu creation failed:", directError);
    }
  }

  cleanup() {
    this.initialized = false;
    this._initializationPromise = null;
    this._handlersRegistered = false;
    this._browserApiInitialized = false;
    this._translationEngineInitialized = false;
    this._dynamicIconInitialized = false;
    this._errorHandlersInitialized = false;
    this.browser = null;
    this.translationEngine = null;
    this.dynamicIconManager = null;
    
    logger.debug('LifecycleManager cleanup completed');
  }
}

export { LifecycleManager };

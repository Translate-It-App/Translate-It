import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { ExclusionChecker } from '@/features/exclusion/core/ExclusionChecker.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { RELEVANT_FEATURE_SETTINGS } from './FeatureConfig.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'FeatureManager');

// Singleton instance
let featureManagerInstance = null;

export class FeatureManager extends ResourceTracker {
  constructor() {
    // Enforce singleton pattern
    if (featureManagerInstance) {
      logger.debug('FeatureManager singleton already exists, returning existing instance');
      return featureManagerInstance;
    }

    super();
    this.activeFeatures = new Set();
    this.requestedFeatures = new Set();
    this.featureHandlers = new Map();
    this.exclusionChecker = ExclusionChecker.getInstance();
    this.initialized = false;
    this.settingsListener = null;
    this._initializationPromise = null;
    this._evaluationInProgress = false;
    this._evaluationQueue = [];
    this._evaluationDebounceTimer = null;
    this._lastDetectedUrl = window.location.href;
    this.navigationCursor = null;
    this._featureRevisions = new Map();
    this._activationPromises = new Map();
    this._navigationRevision = 0;
    this._lifecycleRevision = 0;
    this._evaluationToken = 0;
    this._activeEvaluationToken = null;
    this._isCleaningUp = false;
    this._cleanupPromise = null;
    this._activeEvaluationPromise = null;
    this._selectElementAuthorityCleanupPending = false;
    this._policyChangeCallbacks = new Set();

    // Store singleton instance
    featureManagerInstance = this;
    logger.debug('FeatureManager singleton created');
  }

  _getFeatureRevision(featureName) {
    return this._featureRevisions.get(featureName) || 0;
  }

  _incrementFeatureRevision(featureName) {
    const next = this._getFeatureRevision(featureName) + 1;
    this._featureRevisions.set(featureName, next);
    return next;
  }

  _isActivationStale(featureName, capturedRevision) {
    return capturedRevision !== this._getFeatureRevision(featureName) || this._isCleaningUp;
  }

  _isNavigationStale(capturedRevision) {
    return capturedRevision !== this._navigationRevision;
  }

  async _requestSelectElementGlobalDeactivation() {
    try {
      const { sendMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      const { MessageActions } = await import('@/shared/messaging/core/MessageActions.js');
      const response = await sendMessage({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  onPolicyChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    this._policyChangeCallbacks.add(callback);
    return () => this._policyChangeCallbacks.delete(callback);
  }

  _notifyPolicyChanged(reason = 'unknown') {
    for (const cb of Array.from(this._policyChangeCallbacks)) {
      try { cb(reason); } catch (e) { logger.debug('Policy change callback error', e); }
    }
  }

  // Static method to get singleton instance
  static getInstance() {
    if (!featureManagerInstance) {
      featureManagerInstance = new FeatureManager();
    }
    return featureManagerInstance;
  }

  // Method to reset singleton (for testing or cleanup)
  static async resetInstance() {
    const instance = featureManagerInstance;
    if (instance) {
      featureManagerInstance = null;
      try {
        await instance.cleanupAsync();
      } catch {
        // tolerant reset even if cleanup fails
      }
    }
    // Also reset other singletons
    ExclusionChecker.resetInstance();
    // Reset ContentMessageHandler singleton
    try {
      const module = await import('@/handlers/content/ContentMessageHandler.js');
      await module.default.resetInstance();
    } catch {
      // Import might not be available
    }

    // Reset WindowsManager singleton
    try {
      const { WindowsManager } = await import('@/features/windows/managers/WindowsManager.js');
      await WindowsManager.resetInstance();
    } catch {
      // Import might not be available
    }
  }

  initialize() {
    if (this._cleanupPromise) {
      return this._cleanupPromise.then(() => this.initialize(), () => this.initialize());
    }
    if (this.initialized) return Promise.resolve();
    if (this._initializationPromise) return this._initializationPromise;

    let initializationPromise;
    initializationPromise = (async () => {
      try {
        logger.init('Initializing FeatureManager');

        // Initialize exclusion checker
        await this.exclusionChecker.initialize();

        // Evaluate and register features
        await this.evaluateAndRegisterFeatures();

        // Setup settings change listener
        this.setupSettingsListener();

        // Setup URL change detection for SPAs
        this.setupUrlChangeDetection();

        this.initialized = true;
        logger.info('FeatureManager initialized successfully', {
          activeFeatures: Array.from(this.activeFeatures)
        });

      } catch (error) {
        ErrorHandler.getInstance().handle(error, {
          type: ErrorTypes.SERVICE,
          context: 'FeatureManager-initialize',
          showToast: false
        });
        throw error;
      } finally {
        if (this._initializationPromise === initializationPromise) {
          this._initializationPromise = null;
        }
      }
    })();

    this._initializationPromise = initializationPromise;
    return initializationPromise;
  }

  async evaluateAndRegisterFeatures() {
    try {
      logger.debug('FeatureManager ready for on-demand activation');
      
      // Inject dependencies for any already active features (failsafe)
      await this.injectDependencies();
    } catch (error) {
      logger.error('Error in evaluateAndRegisterFeatures:', error);
    }
  }

  /**
   * Main entry point for requesting feature activation.
   * Features will only be activated if allowed by the exclusion checker.
   */
  async requestFeatureActivation(featureName, force = false) {
    logger.debug(`Request to activate feature: ${featureName} (force=${force})`);
    
    // Ensure manager is initialized (sets up listeners, exclusion checker, etc.)
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Track that this feature has been formally requested
    this.requestedFeatures.add(featureName);
    
    const shouldActivate = force || await this.shouldActivateFeature(featureName);
    if (shouldActivate) {
      await this.activateFeature(featureName);
    } else {
      logger.debug(`Feature ${featureName} activation skipped (not allowed)`);
    }
    
    return this.getFeatureHandler(featureName);
  }

  async injectDependencies() {
    const contentMessageHandler = this.featureHandlers.get('contentMessageHandler');
    const selectElementManager = this.featureHandlers.get('selectElement');

    // Inject SelectElementManager into ContentMessageHandler for direct access
    if (contentMessageHandler && selectElementManager) {
      try {
        if (typeof contentMessageHandler.setSelectElementManager === 'function') {
          contentMessageHandler.setSelectElementManager(selectElementManager);
          logger.debug('Injected SelectElementManager into ContentMessageHandler');
        }
      } catch (error) {
        logger.error('Error injecting SelectElementManager into ContentMessageHandler:', error);
      }
    }
  }

  async shouldActivateFeature(featureName) {
    if (featureName === 'contentMessageHandler') {
      return true;
    }
    try {
      const allowed = await this.exclusionChecker.isFeatureAllowed(featureName);
      logger.debug(`Feature ${featureName} evaluation:`, allowed ? 'ALLOWED' : 'BLOCKED');
      return allowed;
    } catch (error) {
      logger.error(`Error evaluating feature ${featureName}:`, error);
      return false;
    }
  }

  async activateFeature(featureName) {
    logger.debug(`Request to activate feature: ${featureName}`);
    if (this.activeFeatures.has(featureName)) {
      return;
    }

    if (this._isCleaningUp) {
      logger.debug(`Feature ${featureName} activation skipped: cleanup in progress`);
      return;
    }

    // Serialize per-feature: wait for stale activation to settle, dedupe same generation
    while (this._activationPromises.has(featureName)) {
      const existing = this._activationPromises.get(featureName);
      if (existing.revision === this._getFeatureRevision(featureName)) {
        return existing.promise;
      }
      try { await existing.promise; } catch { /* ignore stale */ }
    }

    if (this.activeFeatures.has(featureName)) {
      return;
    }

    if (this._isCleaningUp) {
      logger.debug(`Feature ${featureName} activation skipped: cleanup in progress`);
      return;
    }

    const capturedRevision = this._getFeatureRevision(featureName);
    let activationPromise;
    activationPromise = (async () => {

    // Check if handler already exists (protection against double creation)
    if (this.featureHandlers.has(featureName)) {
      logger.warn(`Feature ${featureName} handler already exists but not marked as active - cleaning up`);
      const existingHandler = this.featureHandlers.get(featureName);
      if (existingHandler && typeof existingHandler.deactivate === 'function') {
        await existingHandler.deactivate().catch(() => {});
      }
      this.featureHandlers.delete(featureName);
      try {
        const { notifyFeatureDeactivated } = await import('@/core/content-scripts/chunks/lazy-features.js');
        notifyFeatureDeactivated(featureName);
      } catch { /* ignore */ }
      if (this._isActivationStale(featureName, capturedRevision)) {
        return;
      }
    }

    let handler = null;
    try {
      logger.debug(`Loading handler for: ${featureName}`);
      if (featureName === 'textSelection') {
        const { SimpleTextSelectionHandler } = await import('@/features/text-selection/handlers/SimpleTextSelectionHandler.js');
        if (this._isActivationStale(featureName, capturedRevision)) {
          return;
        }
        handler = SimpleTextSelectionHandler.getInstance({ featureManager: this });
      } else if (featureName === 'contentMessageHandler') {
        const { contentMessageHandler } = await import('@/handlers/content/ContentMessageHandler.js');
        if (this._isActivationStale(featureName, capturedRevision)) {
          return;
        }
        handler = contentMessageHandler;
      } else {
        handler = await this.loadFeatureHandler(featureName);
        if (this._isActivationStale(featureName, capturedRevision)) {
          if (handler && typeof handler.deactivate === 'function') {
            await handler.deactivate().catch(() => {});
          }
          return;
        }
      }

      if (!handler) {
        return;
      }

      if (featureName !== 'contentMessageHandler') {
        const stillAllowed = await this.shouldActivateFeature(featureName);
        if (this._isActivationStale(featureName, capturedRevision) || !stillAllowed) {
          logger.debug(`Feature ${featureName} activation aborted: stale or no longer allowed`);
          return;
        }
      }

      logger.debug(`Executing .activate() for: ${featureName}`);
      const success = await handler.activate();
      if (this._isActivationStale(featureName, capturedRevision)) {
        if (success !== false) {
          await handler.deactivate().catch(() => {});
        }
        logger.debug(`Feature ${featureName} stale after activate, cleaned up`);
        return;
      }

      if (featureName !== 'contentMessageHandler') {
        const allowedFinal = await this.shouldActivateFeature(featureName);
        if (this._isActivationStale(featureName, capturedRevision) || !allowedFinal) {
          await handler.deactivate().catch(() => {});
          logger.debug(`Feature ${featureName} no longer allowed after activate, deactivated`);
          return;
        }
      }

      if (success !== false) {
        this.featureHandlers.set(featureName, handler);
        this.activeFeatures.add(featureName);
        logger.info(`Feature '${featureName}' activated successfully`);
        if (featureName === 'selectElement') {
          try {
            const contentMessageHandler = this.featureHandlers.get('contentMessageHandler');
            if (contentMessageHandler && typeof contentMessageHandler.setSelectElementManager === 'function') {
              contentMessageHandler.setSelectElementManager(handler);
              logger.debug('SelectElementManager integrated with ContentMessageHandler');
            }
          } catch (integrationError) {
            logger.warn('Failed to integrate SelectElementManager with ContentMessageHandler:', integrationError);
          }
        } else if (featureName === 'contentMessageHandler') {
          try {
            const selectElementManager = this.featureHandlers.get('selectElement');
            if (selectElementManager && typeof handler.setSelectElementManager === 'function') {
              handler.setSelectElementManager(selectElementManager);
              logger.debug('ContentMessageHandler integrated with existing SelectElementManager');
            }
            const screenCaptureManager = this.featureHandlers.get('screenCapture');
            if (screenCaptureManager && typeof handler.setScreenCaptureManager === 'function') {
              handler.setScreenCaptureManager(screenCaptureManager);
              logger.debug('ContentMessageHandler integrated with existing ScreenCaptureHandler');
            }
          } catch (integrationError) {
            logger.warn('Failed to integrate ContentMessageHandler with managers:', integrationError);
          }
        } else if (featureName === 'screenCapture') {
          try {
            const contentMessageHandler = this.featureHandlers.get('contentMessageHandler');
            if (contentMessageHandler && typeof contentMessageHandler.setScreenCaptureManager === 'function') {
              contentMessageHandler.setScreenCaptureManager(handler);
              logger.debug('ScreenCaptureHandler integrated with ContentMessageHandler');
            }
          } catch (integrationError) {
            logger.warn('Failed to integrate ScreenCaptureHandler with ContentMessageHandler:', integrationError);
          }
        }

        logger.debug(`Feature ${featureName} activated successfully`);
      } else {
        logger.warn(`Feature ${featureName} activation returned false - not registering`);
      }
      
    } catch (error) {
      logger.error(`Failed to activate feature ${featureName}:`, error);
      ErrorHandler.getInstance().handle(error, {
        type: ErrorTypes.SERVICE,
        context: `FeatureManager-activateFeature-${featureName}`,
        showToast: false
      });
      if (handler && typeof handler.deactivate === 'function') {
        try { await handler.deactivate(); } catch { /* ignore */ }
      }
    }
    })();

    this._activationPromises.set(featureName, { promise: activationPromise, revision: capturedRevision });
    try {
      await activationPromise;
    } finally {
      if (this._activationPromises.get(featureName)?.promise === activationPromise) {
        this._activationPromises.delete(featureName);
      }
    }
  }

  async deactivateFeature(featureName) {
    this._incrementFeatureRevision(featureName);

    const wasActive = this.activeFeatures.has(featureName);
    const hadHandler = this.featureHandlers.has(featureName);

    if (featureName === 'selectElement' && !wasActive && !hadHandler) {
      const ok = await this._requestSelectElementGlobalDeactivation();
      this._selectElementAuthorityCleanupPending = !ok;
      if (!ok) {
        logger.warn('Select Element local cleanup completed, but Background authority remains unconfirmed');
      }
      this.activeFeatures.delete(featureName);
      this.featureHandlers.delete(featureName);
      try {
        const { notifyFeatureDeactivated } = await import('@/core/content-scripts/chunks/lazy-features.js');
        notifyFeatureDeactivated(featureName);
      } catch {
        // Maybe in iframe or other context where lazy-features isn't used
      }
      logger.info(`Feature ${featureName} deactivated successfully`);
      return;
    }

    if (!wasActive && !hadHandler) {
      logger.debug(`Feature ${featureName} not active (revision invalidated for pending)`);
      return;
    }

    try {
      logger.debug(`Deactivating feature: ${featureName}`);

      // Special handling for textFieldIcon feature to destroy singleton
      if (featureName === 'textFieldIcon') {
        try {
          const { TextFieldIconManager } = await import('@/features/text-field-interaction/managers/TextFieldIconManager.js');
          TextFieldIconManager.resetInstance();
          logger.debug('TextFieldIconManager singleton destroyed');
        } catch (importError) {
          logger.error('Failed to import TextFieldIconManager for singleton destruction:', importError);
          // Fall back to normal deactivation
        }
      }

      // Special handling for textSelection feature to destroy singleton
      if (featureName === 'textSelection') {
        try {
          const { SimpleTextSelectionHandler } = await import('@/features/text-selection/handlers/SimpleTextSelectionHandler.js');
          SimpleTextSelectionHandler.resetInstance();
          logger.debug('SimpleTextSelectionHandler singleton destroyed');
        } catch (importError) {
          logger.error('Failed to import SimpleTextSelectionHandler for singleton destruction:', importError);
          // Fall back to normal deactivation
        }
      }

      const handler = this.featureHandlers.get(featureName);
      if (handler && typeof handler.deactivate === 'function') {
        const success = featureName === 'selectElement'
          ? await handler.deactivate({
            reason: 'manual',
            requestGlobalDeactivation: true,
          })
          : await handler.deactivate();
        if (featureName === 'selectElement') {
          let ok = null;
          if (success && typeof success === 'object') {
            if (success.globalDeactivationRequested === true) {
              ok = success.globalDeactivationSucceeded === true;
            } else if (success.alreadyInactive === true) {
              ok = await this._requestSelectElementGlobalDeactivation();
            } else if (success.globalDeactivationSucceeded === false) {
              ok = false;
            } else if (success.globalDeactivationSucceeded === true) {
              ok = true;
            }
          }
          if (ok !== null) {
            this._selectElementAuthorityCleanupPending = !ok;
            if (!ok) {
              logger.warn('Select Element local cleanup completed, but Background authority remains unconfirmed');
            }
          } else if (success?.globalDeactivationSucceeded === false) {
            this._selectElementAuthorityCleanupPending = true;
            logger.warn('Select Element local cleanup completed, but Background authority remains unconfirmed');
          }
        }
        if (success === false) {
          logger.warn(`Feature ${featureName} deactivation returned false, but proceeding with cleanup`);
        }
      } else if (featureName === 'selectElement') {
        const ok = await this._requestSelectElementGlobalDeactivation();
        this._selectElementAuthorityCleanupPending = !ok;
        if (!ok) {
          logger.warn('Select Element local cleanup completed, but Background authority remains unconfirmed');
        }
      }

      this.featureHandlers.delete(featureName);
      this.activeFeatures.delete(featureName);

      // CRITICAL: Notify lazy-features cache to clear
      try {
        const { notifyFeatureDeactivated } = await import('@/core/content-scripts/chunks/lazy-features.js');
        notifyFeatureDeactivated(featureName);
      } catch {
        // Maybe in iframe or other context where lazy-features isn't used
      }

      logger.info(`Feature ${featureName} deactivated successfully`);

    } catch (error) {
      if (featureName === 'selectElement') {
        this._selectElementAuthorityCleanupPending = true;
      }
      logger.error(`Failed to deactivate feature ${featureName}:`, error);
      ErrorHandler.getInstance().handle(error, {
        type: ErrorTypes.SERVICE,
        context: `FeatureManager-deactivateFeature-${featureName}`,
        showToast: false
      });
    }
  }

  /**
   * Resolves the two mutually exclusive in-page translation modes without
   * routing state-changing commands through the DOM event bus.
   * @param {'pageTranslation'|'selectElement'} requestingFeature
   * @returns {Promise<boolean>} Whether a conflicting active feature was stopped.
   */
  async resolveFeatureConflict(requestingFeature) {
    if (requestingFeature === 'pageTranslation') {
      const selectElementManager = this.featureHandlers.get('selectElement');
      if (!selectElementManager?.isActive) return false;

      await selectElementManager.deactivate({ silent: true, reason: 'conflict' });
      return true;
    }

    if (requestingFeature === 'selectElement') {
      const pageTranslationManager = this.featureHandlers.get('pageTranslation');
      if (!pageTranslationManager?.isTranslating && !pageTranslationManager?.isTranslated) return false;

      await pageTranslationManager.restorePage();
      return true;
    }

    return false;
  }

  async loadFeatureHandler(featureName) {
    try {
      let HandlerClass;
      
      switch (featureName) {
        // Note: contentMessageHandler and textSelection are handled as special cases in activateFeature
        case 'selectElement': {
          const { SelectElementManager } = await import('@/features/element-selection/SelectElementManager.js');
          HandlerClass = SelectElementManager;
          break;
        }

  
        case 'textFieldIcon': {
          const { TextFieldHandler } = await import('@/features/text-field-interaction/handlers/TextFieldHandler.js');
          HandlerClass = TextFieldHandler;
          break;
        }

        case 'shortcut': {
          const { ShortcutHandler } = await import('@/features/shortcuts/handlers/ShortcutHandler.js');
          // Use singleton pattern for ShortcutHandler
          return ShortcutHandler.getInstance({ featureManager: this });
        }

        case 'windowsManager': {
          const { WindowsManagerHandler } = await import('@/features/windows/handlers/WindowsManagerHandler.js');
          HandlerClass = WindowsManagerHandler;
          break;
        }

        case 'pageTranslation': {
          const { PageTranslationManager } = await import('@/features/page-translation/PageTranslationManager.js');
          HandlerClass = PageTranslationManager;
          break;
        }

        case 'screenCapture': {
          const { ScreenCaptureHandler } = await import('@/handlers/content/ScreenCaptureHandler.js');
          HandlerClass = ScreenCaptureHandler;
          break;
        }
        case 'mouseHover': {
          const { hoverTranslationManager } = await import('@/features/mouse-hover/HoverTranslationManager.js');
          return hoverTranslationManager;
        }
        default:
          logger.error(`Unknown feature: ${featureName}`);
          return null;
      }
      
      return new HandlerClass({ featureManager: this });
      
    } catch (error) {
      logger.error(`Failed to load handler for feature ${featureName}:`, error);
      return null;
    }
  }

  setupSettingsListener() {
    try {
      this.settingsListener = async (data) => {
        if (RELEVANT_FEATURE_SETTINGS.includes(data.key)) {
          logger.debug(`Settings change detected: ${data.key} = ${data.newValue}`);
          await this.handleSettingsChange(data.key, data.newValue);
        }
      };
      
      storageManager.on('change', this.settingsListener);
      logger.debug('Settings listener registered');
      
    } catch (error) {
      logger.error('Failed to setup settings listener:', error);
    }
  }

  async handleSettingsChange(key, newValue) {
    try {
      logger.debug(`Handling settings change: ${key} = ${newValue}`);
      
      // Refresh exclusion checker with new settings
      await this.exclusionChecker.refreshSettings();
      
      // Re-evaluate all features
      await this.reevaluateFeatures(`settings-change:${key}`);
      this._notifyPolicyChanged(`settings-change:${key}`);
      
    } catch (error) {
      logger.error('Error handling settings change:', error);
    }
  }

  async reevaluateFeatures(reason = 'unknown') {
    return new Promise((resolve, reject) => {
      // Add to evaluation queue
      this._evaluationQueue.push({ reason, resolve, reject });

      // Clear existing debounce timer
      if (this._evaluationDebounceTimer) {
        clearTimeout(this._evaluationDebounceTimer);
      }

      // Debounce multiple rapid calls
      this._evaluationDebounceTimer = setTimeout(() => {
        this._processEvaluationQueue();
      }, 100); // 100ms debounce
    });
  }

  async _processEvaluationQueue() {
    if (this._activeEvaluationPromise) {
      logger.debug('Feature evaluation already in progress, queueing...');
      return this._activeEvaluationPromise;
    }

    if (this._evaluationQueue.length === 0) {
      return;
    }

    // Get all pending requests
    const requests = [...this._evaluationQueue];
    this._evaluationQueue = [];

    const reasons = requests.map(r => r.reason).join(', ');
    logger.debug(`Processing ${requests.length} queued feature evaluation requests (reasons: ${reasons})`);

    const capturedLifecycle = this._lifecycleRevision;
    const evaluationToken = ++this._evaluationToken;
    this._activeEvaluationToken = evaluationToken;
    this._evaluationInProgress = true;

    const isEvaluationStale = () => capturedLifecycle !== this._lifecycleRevision || evaluationToken !== this._activeEvaluationToken;

    const evaluationPromise = Promise.resolve().then(async () => {
      try {
        // Re-evaluate only features that have been requested by the loader
        const features = Array.from(this.requestedFeatures);

        logger.debug('Re-evaluating requested features', { features });

        for (const feature of features) {
          if (isEvaluationStale()) break;
          if (feature === 'contentMessageHandler') {
            const shouldBeActive = await this.shouldActivateFeature(feature);
            if (isEvaluationStale()) break;
            const isCurrentlyActive = this.activeFeatures.has(feature);
            if (shouldBeActive && !isCurrentlyActive) {
              await this.activateFeature(feature);
              if (isEvaluationStale()) break;
            }
            continue;
          }

          const shouldBeActive = await this.shouldActivateFeature(feature);
          if (isEvaluationStale()) break;
          const isCurrentlyActive = this.activeFeatures.has(feature);

          logger.debug(`Feature ${feature}: shouldBeActive=${shouldBeActive}, isCurrentlyActive=${isCurrentlyActive}`);

          if (shouldBeActive && !isCurrentlyActive) {
            await this.activateFeature(feature);
            if (isEvaluationStale()) break;
          } else if (!shouldBeActive && isCurrentlyActive) {
            logger.debug(`About to deactivate feature: ${feature}`);
            await this.deactivateFeature(feature);
            if (isEvaluationStale()) break;
          } else if (!shouldBeActive && !isCurrentlyActive) {
            if (feature === 'selectElement' && this._selectElementAuthorityCleanupPending) {
              const ok = await this._requestSelectElementGlobalDeactivation();
              if (ok) this._selectElementAuthorityCleanupPending = false;
              if (isEvaluationStale()) break;
            }
            this._incrementFeatureRevision(feature);
            if (this.featureHandlers.has(feature)) {
              const staleHandler = this.featureHandlers.get(feature);
              if (staleHandler && typeof staleHandler.deactivate === 'function') {
                await staleHandler.deactivate().catch(() => {});
                if (isEvaluationStale()) break;
              }
              this.featureHandlers.delete(feature);
              try {
                const { notifyFeatureDeactivated } = await import('@/core/content-scripts/chunks/lazy-features.js');
                if (isEvaluationStale()) break;
                notifyFeatureDeactivated(feature);
              } catch { /* ignore */ }
              if (isEvaluationStale()) break;
            }
          }
        }

        if (isEvaluationStale()) {
          logger.debug('Evaluation stale: lifecycle invalidated, settling as cancelled', { reasons });
          const staleError = new Error('Evaluation cancelled: lifecycle invalidated');
          staleError.name = 'EvaluationStaleError';
          requests.forEach(request => {
            try { request.reject(staleError); } catch { /* ignore */ }
          });
          return;
        }

        logger.debug('Feature re-evaluation complete', {
          activeFeatures: Array.from(this.activeFeatures),
          processedRequests: requests.length
        });

        // Resolve all pending requests
        requests.forEach(request => {
          try { request.resolve(); } catch { /* ignore */ }
        });

      } catch (error) {
        logger.error('Feature re-evaluation failed:', error);
        // Reject all pending requests
        requests.forEach(request => {
          try { request.reject(error); } catch { /* ignore */ }
        });
      } finally {
        if (this._activeEvaluationToken === evaluationToken) {
          this._activeEvaluationToken = null;
          this._activeEvaluationPromise = null;
          this._evaluationInProgress = false;
          // Process any new requests that came in during evaluation
          if (this._evaluationQueue.length > 0) {
            setTimeout(() => this._processEvaluationQueue(), 50);
          }
        }
      }
    });

    this._activeEvaluationPromise = evaluationPromise;
    return evaluationPromise;
  }

  setupUrlChangeDetection() {
    try {
      // Use MutationObserver for SPA detection
      const observer = new MutationObserver(() => {
        void this.checkForUrlChange();
      });
      
      observer.observe(document, { 
        subtree: true, 
        childList: true 
      });
      
      // Register observer for cleanup
      this.trackResource('url-change-listener', () => {
        observer.disconnect();
      });
      
      // Also listen to popstate for history navigation
      const popstateHandler = () => {
        void this.checkForUrlChange();
      };
      
      this.addEventListener(window, 'popstate', popstateHandler);
      
      logger.debug('URL change detection setup complete');
      
    } catch (error) {
      logger.error('Failed to setup URL change detection:', error);
    }
  }

  _compareNavigationCursor(cursor) {
    if (!Number.isSafeInteger(cursor?.documentEpoch) || cursor.documentEpoch <= 0
        || !Number.isSafeInteger(cursor.routeRevision) || cursor.routeRevision < 0
        || typeof cursor.url !== 'string' || !cursor.url) return null;
    const current = this.navigationCursor;
    if (!current) return 1;
    if (cursor.documentEpoch !== current.documentEpoch) return cursor.documentEpoch > current.documentEpoch ? 1 : -1;
    if (cursor.routeRevision !== current.routeRevision) return cursor.routeRevision > current.routeRevision ? 1 : -1;
    return cursor.url === current.url ? 0 : null;
  }

  _stopPageForNavigation() {
    this._navigationRevision += 1;
    this.featureHandlers.get('pageTranslation')?.stopAutoTranslation({ cancellationReason: 'operation-abort' }).catch(() => {
      logger.warn('Stopping obsolete page translation on navigation failed');
    });
  }

  acceptPageNavigation(cursor) {
    const comparison = this._compareNavigationCursor(cursor);
    if (comparison === null || comparison < 0 || cursor.url !== window.location.href) return false;
    if (comparison > 0) {
      const page = this.featureHandlers.get('pageTranslation');
      if (this.navigationCursor && (page?.isTranslating || page?.isAutoTranslating
          || page?.abortController || page?.bridge?.session?.active)) this._stopPageForNavigation();
      this.navigationCursor = { ...cursor };
    }
    this._lastDetectedUrl = cursor.url;
    return true;
  }

  checkForUrlChange({ navigationCursor, navigationUnavailable = false } = {}) {
    const newUrl = window.location.href;
    let capturedNavigation = false;
    if (navigationCursor !== undefined) {
      const comparison = this._compareNavigationCursor(navigationCursor);
      if (comparison === null) navigationUnavailable = true;
      else if (comparison > 0) {
        this.navigationCursor = { ...navigationCursor };
        capturedNavigation = true;
      }
    }
    if (!navigationUnavailable && !capturedNavigation && newUrl === this._lastDetectedUrl) return false;

    const oldUrl = this._lastDetectedUrl;
    this._lastDetectedUrl = newUrl;
    this._stopPageForNavigation();
    if (navigationUnavailable) return false;
    return this.handleUrlChange(oldUrl, newUrl, this._navigationRevision);
  }

  async handleUrlChange(oldUrl, newUrl, expectedRevision = null) {
    if (expectedRevision !== null && this._isNavigationStale(expectedRevision)) return;
    let capturedRevision;
    if (expectedRevision !== null) {
      capturedRevision = expectedRevision;
    } else {
      this._navigationRevision += 1;
      capturedRevision = this._navigationRevision;
      this._lastDetectedUrl = newUrl;
    }
    if (this._lastDetectedUrl !== newUrl) {
      this._lastDetectedUrl = newUrl;
    }
    logger.debug('URL changed:', { oldUrl, newUrl });

    const isStale = () => this._isNavigationStale(capturedRevision);

    try {
      this.exclusionChecker.updateUrl(newUrl);

      await this.reevaluateFeatures('url-change');
      this._notifyPolicyChanged('url-change');
      if (isStale()) {
        logger.debug('Stale navigation after reevaluation, aborting', { newUrl });
        return;
      }

      if (window !== window.top) return;

      const { default: settingsManager } = await import('@/shared/managers/SettingsManager.js');
      if (isStale()) return;
      const isEnabled = settingsManager.get('WHOLE_PAGE_TRANSLATION_ENABLED', true);
      if (!isEnabled || !settingsManager.isExtensionEnabled()) return;
      if (isStale()) return;
      const autoRules = settingsManager.get('WHOLE_PAGE_AUTO_TRANSLATE_RULES', []);
      if (autoRules.length === 0) return;
      if (isStale()) return;

      const { matchesAutoTranslateRule } = await import('@/utils/ui/exclusion.js');
      if (isStale()) return;
      const isMatch = autoRules.some(rule => matchesAutoTranslateRule(newUrl, rule));
      if (!isMatch) return;
      if (isStale()) return;

      const isAllowed = await this.exclusionChecker.isFeatureAllowed('pageTranslation');
      if (isStale() || !isAllowed) return;

      const { loadFeature } = await import('@/core/content-scripts/chunks/lazy-features.js');
      if (isStale()) return;
      const manager = await loadFeature('pageTranslation');
      if (isStale() || !manager) return;

      if (manager.currentUrl !== newUrl) {
        manager.userRestoredOverride = false;
      }
      if (isStale()) return;
      if (!manager.isActive) {
        await manager.activate();
        if (isStale()) return;
      }
      if (!manager.userRestoredOverride && !manager.autoStartCancelledUrls?.has(newUrl)) {
        if (isStale()) return;
        logger.info('Auto-translate rule matched on SPA URL change. Triggering translation...');
        const { MessageActions } = await import('@/shared/messaging/core/MessageActions.js');
        if (isStale()) return;
        const { sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
        if (isStale()) return;
        const response = await sendRegularMessage({
          action: MessageActions.PAGE_TRANSLATE,
          data: { isAuto: true, preserveAcceptedTranslations: true },
        }, { returnFailureResponse: true });
        if (response?.success === false) {
          logger.debug('SPA auto page translation command rejected', response);
        }
      }
    } catch (error) {
      logger.error('Error handling URL change:', error);
    }
  }

  // Public API methods
  getActiveFeatures() {
    return Array.from(this.activeFeatures);
  }

  isFeatureActive(featureName) {
    return this.activeFeatures.has(featureName);
  }

  getFeatureHandler(featureName) {
    return this.featureHandlers.get(featureName);
  }

  async manualRefresh() {
    logger.debug('Manual refresh requested');
    await this.exclusionChecker.refreshSettings();
    await this.reevaluateFeatures('manual-refresh');
    this._notifyPolicyChanged('manual-refresh');
  }

  async getStatus() {
    return {
      initialized: this.initialized,
      activeFeatures: Array.from(this.activeFeatures),
      totalHandlers: this.featureHandlers.size,
      exclusionStatus: await this.exclusionChecker.getFeatureStatus()
    };
  }


  // Smart cleanup during memory pressure - only deactivate non-critical features
  performSmartCleanup() {
    try {
      logger.debug('FeatureManager performing smart cleanup during memory pressure');

      // Define critical features that should NEVER be cleaned up during memory pressure
      const criticalFeatures = new Set([
        'selectElement',        // Active translation mode should persist
        'contentMessageHandler', // Core messaging must remain active
        'textSelection',        // Text selection should remain active
        'textFieldIcon',        // Text field icons should remain active for UX consistency
        'shortcut'              // Keyboard shortcuts should remain active for UX consistency
      ]);

      // Define optional features that can be cleaned up to free memory
      const optionalFeatures = new Set([
        // No optional features currently - all features are critical for UX
      ]);

      // Only deactivate optional features, preserve critical ones
      const activeFeatures = Array.from(this.activeFeatures);
      for (const feature of activeFeatures) {
        if (optionalFeatures.has(feature)) {
          logger.debug(`Smart cleanup: deactivating optional feature '${feature}'`);
          this.deactivateFeature(feature).catch(error => {
            logger.error(`Error deactivating optional feature ${feature} during smart cleanup:`, error);
          });
        } else if (criticalFeatures.has(feature)) {
          logger.debug(`Smart cleanup: preserving critical feature '${feature}'`);
        } else {
          logger.debug(`Smart cleanup: unknown feature '${feature}' - preserving by default`);
        }
      }

      logger.debug('FeatureManager smart cleanup completed');

    } catch (error) {
      logger.error('Error during FeatureManager smart cleanup:', error);
    }
  }

  async cleanupAsync() {
    if (this._cleanupPromise) {
      return this._cleanupPromise;
    }

    let cleanupPromise;
    cleanupPromise = (async () => {
      const alreadySync = this._isCleaningUp;
      if (!alreadySync) {
        this._isCleaningUp = true;

        for (const feature of new Set([...this.requestedFeatures, ...this.activeFeatures])) {
          this._incrementFeatureRevision(feature);
        }
        this._navigationRevision += 1;
        this._lifecycleRevision += 1;

        if (this._evaluationDebounceTimer) {
          clearTimeout(this._evaluationDebounceTimer);
          this._evaluationDebounceTimer = null;
        }

        const queued = [...this._evaluationQueue];
        this._evaluationQueue = [];
        if (queued.length > 0) {
          const cleanupError = new Error('FeatureManager cleanup');
          for (const req of queued) {
            try { req.reject(cleanupError); } catch { /* ignore */ }
          }
        }

        if (this.settingsListener) {
          try { storageManager.off('change', this.settingsListener); } catch { /* ignore */ }
          this.settingsListener = null;
        }
        this._policyChangeCallbacks.clear();
      }

      // Wait for stale activation attempts to settle (identity-safe, do not delete)
      const pendingActivations = [...this._activationPromises.values()];
      if (pendingActivations.length > 0) {
        await Promise.allSettled(pendingActivations.map(entry => entry.promise));
      }
      // Wait for in-flight evaluation to settle
      if (this._activeEvaluationPromise) {
        try { await this._activeEvaluationPromise; } catch { /* ignore */ }
      }

      const toDeactivate = Array.from(this.activeFeatures);
      for (const feature of toDeactivate) {
        try {
          await this.deactivateFeature(feature);
        } catch (error) {
          logger.error(`Error deactivating feature ${feature} during cleanup:`, error);
        }
      }

      for (const feature of Array.from(this.requestedFeatures)) {
        if (this.featureHandlers.has(feature)) {
          const handler = this.featureHandlers.get(feature);
          if (handler && typeof handler.deactivate === 'function') {
            try { await handler.deactivate(); } catch { /* ignore */ }
          }
          this.featureHandlers.delete(feature);
          try {
            const { notifyFeatureDeactivated } = await import('@/core/content-scripts/chunks/lazy-features.js');
            notifyFeatureDeactivated(feature);
          } catch { /* ignore */ }
        }
      }

      if (this._selectElementAuthorityCleanupPending) {
        const ok = await this._requestSelectElementGlobalDeactivation();
        if (ok) this._selectElementAuthorityCleanupPending = false;
      }

      try {
        super.cleanup();
      } catch (error) {
        logger.error('Error during FeatureManager super cleanup:', error);
      }

      this.initialized = false;
      this._isCleaningUp = false;
      logger.debug('FeatureManager full cleanup completed');
    })();

    this._cleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } finally {
      if (this._cleanupPromise === cleanupPromise) {
        this._cleanupPromise = null;
      }
    }
  }

  // Override cleanup to handle settings listener (for full shutdown)
  // Preserves sync-call compatibility: callers not awaiting still trigger authoritative teardown.
  cleanup() {
    // Synchronous invalidation for immediate staleness and queue settlement
    for (const feature of new Set([...this.requestedFeatures, ...this.activeFeatures])) {
      this._incrementFeatureRevision(feature);
    }
    this._navigationRevision += 1;
    this._lifecycleRevision += 1;
    this._isCleaningUp = true;

    if (this._evaluationDebounceTimer) {
      clearTimeout(this._evaluationDebounceTimer);
      this._evaluationDebounceTimer = null;
    }

    if (this._evaluationQueue.length > 0) {
      const queued = [...this._evaluationQueue];
      this._evaluationQueue = [];
      const cleanupError = new Error('FeatureManager cleanup');
      for (const req of queued) {
        try { req.reject(cleanupError); } catch { /* ignore */ }
      }
    }

    if (this.settingsListener) {
      try { storageManager.off('change', this.settingsListener); } catch { /* ignore */ }
      this.settingsListener = null;
    }
    this._policyChangeCallbacks.clear();

    // Defer remaining async teardown (feature deactivation) without blocking caller
    void this.cleanupAsync().catch(error => {
      logger.error('Error during FeatureManager cleanup:', error);
    });
  }
}

export default FeatureManager;

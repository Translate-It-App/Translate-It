/**
 * MainFeatureLoader.js
 * Manages the prioritized and intelligent loading of extension features.
 */
export class MainFeatureLoader {
  constructor(contentScriptCore, initializeLogger) {
    this.contentScriptCore = contentScriptCore;
    this.initializeLogger = initializeLogger;
    this.featureLoadPromises = new Map();
    this.logger = null;
    this._intelligentLoadingStarted = false;

    // Smart loading configuration
    this.LOAD_STRATEGIES = {
      CRITICAL: { delay: 0, priority: 'high' },
      ESSENTIAL: { delay: 400, priority: 'medium' },
      LAZY_UI: { delay: 2500, priority: 'low' },
      ON_DEMAND: { delay: 4000, priority: 'low' },
      INTERACTIVE: { delay: 0, priority: 'high' }
    };

    // Feature categorization
    this.FEATURE_CATEGORIES = {
      CRITICAL: ['messaging', 'extensionContext'], // Core infrastructure
      ESSENTIAL: ['contentMessageHandler'], // Essential communication
      LAZY_UI: ['textSelection', 'mouseHover'], // UI & Selection
      INTERACTIVE: ['windowsManager', 'selectElement', 'pageTranslation', 'screenCapture'], // On-demand heavy UI
      ON_DEMAND: ['shortcut', 'textFieldIcon'] // Optional features
    };
  }

  /**
   * Lazy load the logger instance.
   * Note: This logger uses the 'Content' component level (LOG_COMPONENTS.CONTENT).
   * To see these logs, ensure the 'Content' log level is set to INFO (2) or higher in Options.
   */
  async getLogger() {
    if (this.logger) return this.logger;
    try {
      this.logger = await this.initializeLogger('MainFeatureLoader');
      return this.logger;
    } catch {
      return console;
    }
  }

  /**
   * Starts the multi-stage intelligent loading sequence.
   * Idempotent per instance: only the first call schedules startup stages.
   */
  async startIntelligentLoading() {
    if (this._intelligentLoadingStarted) return;
    this._intelligentLoadingStarted = true;

    // Stage 1: Critical features (immediate, awaited)
    await Promise.all(
      this.FEATURE_CATEGORIES.CRITICAL.map(feature =>
        this.loadFeature(feature, 'CRITICAL')
      )
    );

    // Vue is needed early by UI features, but must not delay startup stages.
    void this.loadFeature('vue', 'LAZY_UI');

    // Stage 2: Essential features (short delay)
    setTimeout(() => {
      Promise.all(
        this.FEATURE_CATEGORIES.ESSENTIAL.map(feature =>
          this.loadFeature(feature, 'ESSENTIAL')
        )
      );
    }, this.LOAD_STRATEGIES.ESSENTIAL.delay);

    // Stage 3: Lazy UI & Stage 4: On-demand (Using Idle Deadline)
    const scheduleIdleTask = (category, delay) => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => {
          Promise.all(
            this.FEATURE_CATEGORIES[category].map(feature =>
              this.loadFeature(feature, category)
            )
          );
        }, { timeout: delay + 2000 }); // Backup timeout
      } else {
        setTimeout(() => {
          Promise.all(
            this.FEATURE_CATEGORIES[category].map(feature =>
              this.loadFeature(feature, category)
            )
          );
        }, delay);
      }
    };

    scheduleIdleTask('LAZY_UI', this.LOAD_STRATEGIES.LAZY_UI.delay);
    scheduleIdleTask('ON_DEMAND', this.LOAD_STRATEGIES.ON_DEMAND.delay);
  }

  /**
   * Loads a specific feature, delegating to the lower feature-loading layer.
   * Delay ownership is exclusive to startIntelligentLoading(); this method
   * schedules nothing and only dedupes, delegates, logs, and handles errors.
   * @param {string} featureName - Name of the feature to load.
   * @param {string} category - Category for logging and error context.
   */
  async loadFeature(featureName, category) {
    if (this.featureLoadPromises.has(featureName)) {
      return this.featureLoadPromises.get(featureName);
    }

    // Declared before the IIFE so the cleanup finalizer below can reference the
    // same promise it cleans up (identity-safe removal).
    let loadPromise;
    loadPromise = (async () => {
      try {
        if (this.contentScriptCore && this.contentScriptCore.loadFeature) {
          const logger = await this.getLogger();
          logger.info(`Loading feature: ${featureName} (${category})`);
          await this.contentScriptCore.loadFeature(featureName);

          if (process.env.NODE_ENV === 'development') {
            logger.debug(`Loaded feature: ${featureName} (${category})`);
          }
          logger.info(`Successfully loaded feature: ${featureName}`);
        }
      } catch (error) {
        await this.handleLoadingError(featureName, category, error);
      }
    })();

    this.featureLoadPromises.set(featureName, loadPromise);

    // In-flight-only cache: dedupe concurrent loads, then release the entry so a
    // later call delegates again to contentScriptCore.loadFeature. The lower
    // lazy-features layer owns loaded-state, so this stays safe for retry and
    // reactivation without duplicating lifecycle state here.
    loadPromise.finally(() => {
      if (this.featureLoadPromises.get(featureName) === loadPromise) {
        this.featureLoadPromises.delete(featureName);
      }
    });

    return loadPromise;
  }

  /**
   * Handles errors that occur during feature loading.
   */
  async handleLoadingError(featureName, category, error) {
    try {
      const { ErrorHandler } = await import('@/shared/error-management/ErrorHandler.js');
      if (ErrorHandler) {
        const errorHandler = ErrorHandler.getInstance();
        await errorHandler.handle(error, {
          context: `feature-loading-${featureName}`,
          isSilent: true,
          showToast: false
        });
      }
    } catch { /* ignore */ }

    const errorLogger = await this.getLogger();
    errorLogger.warn(`Failed to load feature ${featureName}`, {
      error: error.message || error,
      category,
      stack: error.stack
    });
  }
}

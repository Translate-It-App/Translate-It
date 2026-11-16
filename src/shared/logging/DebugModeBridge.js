/**
 * DebugModeBridge - Bridge between DEBUG_MODE setting and logging system
 *
 * This service connects the user's DEBUG_MODE preference to the logging system's
 * debugOverride flag and synchronizes changes across all extension contexts.
 *
 * Features:
 * - Reads DEBUG_MODE from storage and applies it to logging system
 * - Listens for storage changes and updates logging in real-time
 * - Cross-context synchronization using browser runtime messaging
 * - Context detection and appropriate initialization
 * - Graceful error handling and fallbacks
 */

import { safeConsole } from './SafeConsole.js';
import { getScopedLogger } from './logger.js';
import { LOG_COMPONENTS, LOG_LEVELS } from './logConstants.js';
import { MessageActions } from '../messaging/core/MessageActions.js';
import { isAuthorizedOffscreenSender } from '@/features/live-dubbing/contracts.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'DebugModeBridge');
const validComponents = new Set(Object.values(LOG_COMPONENTS));
const validLevels = new Set(Object.values(LOG_LEVELS));

function sanitizeComponentLogLevels(levels) {
  if (!levels || typeof levels !== 'object' || Array.isArray(levels)) return {};
  return Object.fromEntries(Object.entries(levels).filter(([component, level]) =>
    validComponents.has(component) && validLevels.has(level)));
}

function sanitizeLoggingSettings(settings = {}, partial = false) {
  const sanitized = {};
  if (!partial || Object.hasOwn(settings, 'DEBUG_MODE')) {
    sanitized.DEBUG_MODE = settings.DEBUG_MODE === true;
  }
  if (!partial || Object.hasOwn(settings, 'COMPONENT_LOG_LEVELS')) {
    sanitized.COMPONENT_LOG_LEVELS = sanitizeComponentLogLevels(settings.COMPONENT_LOG_LEVELS);
  }
  return sanitized;
}

function readInitialLoggingSettings(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || (Object.getPrototypeOf(response) !== Object.prototype && Object.getPrototypeOf(response) !== null)
    || Object.hasOwn(response, 'success') || Object.hasOwn(response, 'error')
    || typeof response.DEBUG_MODE !== 'boolean'
    || !response.COMPONENT_LOG_LEVELS || typeof response.COMPONENT_LOG_LEVELS !== 'object'
    || Array.isArray(response.COMPONENT_LOG_LEVELS)) {
    throw new Error('OFFSCREEN_LOGGING_SETTINGS_INVALID');
  }
  return sanitizeLoggingSettings(response);
}

/**
 * DebugModeBridge class manages the connection between DEBUG_MODE setting
 * and the logging system across all extension contexts
 */
class DebugModeBridge {
  constructor() {
    this.isInitialized = false;
    this.currentDebugMode = false;
    this.context = this.detectContext();
    this.storageListener = null;
    this.messageListener = null;
    this.offscreenSettingRevisions = { DEBUG_MODE: 0, COMPONENT_LOG_LEVELS: 0 };
    this.offscreenInitializationPromise = null;
    this.offscreenRetryTimeout = null;
    this.offscreenRetryWaitResolve = null;
    this.offscreenInitializationGeneration = 0;
  }

  /**
   * Detect the current context (background, content script, popup, options, offscreen)
   * @returns {string} Context name
   */
  detectContext() {
    try {
      // Check if we're in background script
      const hasWindowUrl = Boolean(globalThis.window?.location?.href);
      if (!hasWindowUrl && typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()) {
        return 'background';
      }

      // Check if we're in content script
      if (typeof window !== 'undefined' && window.location?.href &&
          !window.location.href.startsWith('chrome-extension://') &&
          !window.location.href.startsWith('moz-extension://')) {
        return 'content';
      }

      // Check if we're in popup
      if (typeof window !== 'undefined' && window.location?.href) {
        const url = window.location.href;
        if (url.includes('/popup.html') || url.includes('popup/')) {
          return 'popup';
        }
        if (url.includes('/options.html') || url.includes('options/')) {
          return 'options';
        }
        if (url.includes('/sidepanel.html') || url.includes('sidepanel/')) {
          return 'sidepanel';
        }
        if (url.includes('/offscreen.html')) {
          return 'offscreen';
        }
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Initialize the DebugModeBridge
   * @returns {Promise<boolean>} Whether initialization was successful
   */
  initialize() {
    if (this.isInitialized) {
      return Promise.resolve(true);
    }

    if (this.context === 'offscreen') return this.initializeOffscreen();

    return this.initializeFromStorage();
  }

  initializeOffscreen() {
    if (this.offscreenInitializationPromise) return this.offscreenInitializationPromise;

    const requestRevisions = { ...this.offscreenSettingRevisions };
    const generation = this.offscreenInitializationGeneration;
    const initialization = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (generation !== this.offscreenInitializationGeneration) return false;
        try {
          const response = await chrome.runtime.sendMessage({ action: MessageActions.OFFSCREEN_LOGGING_SETTINGS_GET });
          if (generation !== this.offscreenInitializationGeneration) return false;
          const settings = readInitialLoggingSettings(response);
          if (this.offscreenSettingRevisions.DEBUG_MODE === requestRevisions.DEBUG_MODE) {
            this.currentDebugMode = settings.DEBUG_MODE;
            await this.applyDebugMode(settings.DEBUG_MODE);
          }
          if (this.offscreenSettingRevisions.COMPONENT_LOG_LEVELS === requestRevisions.COMPONENT_LOG_LEVELS) {
            await this.applyComponentLogLevels(settings.COMPONENT_LOG_LEVELS);
          }
          if (generation !== this.offscreenInitializationGeneration) return false;
          this.isInitialized = true;
          return true;
        } catch {
          if (attempt < 2) {
            await new Promise((resolve) => {
              this.offscreenRetryWaitResolve = resolve;
              this.offscreenRetryTimeout = setTimeout(() => {
                this.offscreenRetryTimeout = null;
                this.offscreenRetryWaitResolve = null;
                resolve();
              }, 50);
            });
          }
        }
      }
      return false;
    })();
    this.offscreenInitializationPromise = initialization;
    void initialization.then(() => {
      if (this.offscreenInitializationPromise === initialization) this.offscreenInitializationPromise = null;
    });
    return initialization;
  }

  async initializeFromStorage() {
    try {
      let settings;
      try {
        const { storageManager } = await import('@/shared/storage/core/StorageCore.js');
        if (storageManager && typeof storageManager.get === 'function') {
          settings = await storageManager.get({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
        }
      } catch {
        logger.warn('storageManager not available, trying fallback for logging settings');
      }

      if (!settings) {
        try {
          if (typeof browser !== 'undefined' && browser.storage?.local) {
            settings = await browser.storage.local.get({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
          }
        } catch {
          logger.warn('browser.storage not available for logging settings');
        }
      }

      const debugMode = Boolean(settings?.DEBUG_MODE);
      const componentLogLevels = settings?.COMPONENT_LOG_LEVELS || {};
      this.currentDebugMode = debugMode;

      // Apply to logging system
      await this.applyDebugMode(debugMode);
      await this.applyComponentLogLevels(componentLogLevels);

      // Set up listeners for real-time updates
      this.setupStorageListener();

      this.isInitialized = true;

      logger.info('Initialized successfully', {
        context: this.context,
        debugMode,
        componentLogLevelsCount: Object.keys(componentLogLevels).length
      });

      return true;
    } catch {
      logger.error('Initialization failed');
      return false;
    }
  }

  /**
   * Get DEBUG_MODE from storage with fallback
   * @returns {Promise<boolean>}
   */
  async getDebugModeFromStorage() {
    try {
      // Try to get from storageManager first
      const { storageManager } = await import('@/shared/storage/core/StorageCore.js');

      if (storageManager && typeof storageManager.get === 'function') {
        const result = await storageManager.get({ DEBUG_MODE: false });
        return Boolean(result.DEBUG_MODE);
      }
    } catch {
      logger.warn('storageManager not available, trying fallback for DEBUG_MODE');
    }

    try {
      // Fallback to browser.storage
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        const result = await browser.storage.local.get({ DEBUG_MODE: false });
        return Boolean(result.DEBUG_MODE);
      }
    } catch {
      logger.warn('browser.storage not available for DEBUG_MODE');
    }

    // Fallback to default value
    return false;
  }

  /**
   * Get COMPONENT_LOG_LEVELS from storage with fallback
   * @returns {Promise<Object>}
   */
  async getComponentLogLevelsFromStorage() {
    try {
      const { storageManager } = await import('@/shared/storage/core/StorageCore.js');

      if (storageManager && typeof storageManager.get === 'function') {
        const result = await storageManager.get({ COMPONENT_LOG_LEVELS: {} });
        return result.COMPONENT_LOG_LEVELS || {};
      }
    } catch {
      logger.warn('storageManager not available, trying fallback for COMPONENT_LOG_LEVELS');
    }

    try {
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        const result = await browser.storage.local.get({ COMPONENT_LOG_LEVELS: {} });
        return result.COMPONENT_LOG_LEVELS || {};
      }
    } catch {
      logger.warn('browser.storage not available for COMPONENT_LOG_LEVELS');
    }

    return {};
  }

  /**
   * Apply debug mode to logging system
   * @param {boolean} debugMode - Whether to enable debug mode
   */
  async applyDebugMode(debugMode) {
    const offscreenRevision = this.context === 'offscreen'
      ? this.offscreenSettingRevisions.DEBUG_MODE
      : null;
    const isCurrentOffscreenApplication = () =>
      offscreenRevision === null || offscreenRevision === this.offscreenSettingRevisions.DEBUG_MODE;

    try {
      // Update SafeConsole
      safeConsole.setEnabled(debugMode);

      // Update logging system's debug override
      try {
        const { setGlobalDebugOverride } = await import('./GlobalDebugState.js');
        if (!isCurrentOffscreenApplication()) return;
        setGlobalDebugOverride(debugMode);
        logger.debug('Updated GlobalDebugState (debugOverride):', debugMode);
      } catch (error) {
        logger.warn('Could not update GlobalDebugState (debugOverride):', error);
      }

      // Update ErrorHandler debug mode
      try {
        const { ErrorHandler } = await import('@/shared/error-management/ErrorHandler.js');
        if (!isCurrentOffscreenApplication()) return;
        const errorHandler = ErrorHandler.getInstance();
        if (errorHandler && typeof errorHandler.setDebugMode === 'function') {
          errorHandler.setDebugMode(debugMode);
          logger.debug('Updated ErrorHandler:', debugMode);
        }
      } catch (error) {
        logger.warn('Could not update ErrorHandler:', error);
      }

      if (isCurrentOffscreenApplication()) this.currentDebugMode = debugMode;
    } catch (error) {
      logger.error('Failed to apply debug mode:', error);
    }
  }

  /**
   * Apply component log levels to logging system
   * @param {Object} levels - Component log levels object
   */
  async applyComponentLogLevels(levels) {
    if (!levels || typeof levels !== 'object') return;

    try {
      const { setComponentLogLevel } = await import('./GlobalDebugState.js');
      
      Object.entries(levels).forEach(([component, level]) => {
        setComponentLogLevel(component, level);
      });
      
      logger.debug('Updated GlobalDebugState (componentLogLevels):', Object.keys(levels).length);
    } catch (error) {
      logger.warn('Could not update GlobalDebugState (componentLogLevels):', error);
    }
  }

  /**
   * Set up storage change listener
   */
  setupStorageListener() {
    try {
      // Try storageManager events first
      import('@/shared/storage/core/StorageCore.js').then(({ storageManager }) => {
        if (storageManager && typeof storageManager.on === 'function') {
          storageManager.on('change', (changes) => {
            if (changes.DEBUG_MODE !== undefined) {
              this.handleStorageChange({ DEBUG_MODE: { newValue: changes.DEBUG_MODE } });
            }
            if (changes.COMPONENT_LOG_LEVELS !== undefined) {
              this.handleStorageChange({ COMPONENT_LOG_LEVELS: { newValue: changes.COMPONENT_LOG_LEVELS } });
            }
          });
        }
      }).catch(() => {
        // Silently fall back to browser.storage
      });

      // Also set up browser.storage listener as backup
      if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
        this.storageListener = (changes, areaName) => {
          if (areaName === 'local') {
            if (changes.DEBUG_MODE !== undefined || changes.COMPONENT_LOG_LEVELS !== undefined) {
              this.handleStorageChange(changes);
            }
          }
        };
        browser.storage.onChanged.addListener(this.storageListener);
      }
    } catch (error) {
      logger.warn('Could not setup storage listener:', error);
    }
  }

  /**
   * Set up message listener for cross-context sync
   * @deprecated Use getHandlerMappings() with centralized MessageHandler instead
   */
  setupMessageListener() {
    // Logic moved to getHandlerMappings for centralized MessageHandler
  }

  /**
   * Get handler mappings for centralized MessageHandler
   * @returns {Object} Handler mappings for debug/logging actions
   */
  getHandlerMappings() {
    return {
      [MessageActions.OFFSCREEN_LOGGING_SETTINGS_GET]: async (_message, sender) => {
        if (!isAuthorizedOffscreenSender(sender, globalThis.chrome)) {
          return { success: false, error: 'OFFSCREEN_UNAUTHORIZED' };
        }
        try {
          const { storageManager } = await import('@/shared/storage/core/StorageCore.js');
          const result = await storageManager.get({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
          return sanitizeLoggingSettings(result);
        } catch {
          return { success: false, error: 'OFFSCREEN_LOGGING_SETTINGS_UNAVAILABLE' };
        }
      },
      [MessageActions.DEBUG_MODE_CHANGED]: (message) => {
        this.handleDebugModeChange(message.data.debugMode);
        return { success: true };
      },
      [MessageActions.COMPONENT_LOG_LEVELS_CHANGED]: (message) => {
        this.handleComponentLogLevelsChange(message.data.levels);
        return { success: true };
      },
    };
  }

  /**
   * Handle storage changes
   * @param {Object} changes - Storage changes object
   */
  handleStorageChange(changes) {
    if (changes.DEBUG_MODE && changes.DEBUG_MODE.newValue !== this.currentDebugMode) {
      const newDebugMode = Boolean(changes.DEBUG_MODE.newValue);
      this.handleDebugModeChange(newDebugMode);
    }

    if (changes.COMPONENT_LOG_LEVELS) {
      this.handleComponentLogLevelsChange(changes.COMPONENT_LOG_LEVELS.newValue);
    }
  }

  /**
   * Handle debug mode change
   * @param {boolean} newDebugMode - New debug mode value
   */
  handleDebugModeChange(newDebugMode) {
    if (this.context === 'offscreen') this.offscreenSettingRevisions.DEBUG_MODE++;
    if (newDebugMode !== this.currentDebugMode) {
      logger.info('Debug mode changed', {
        from: this.currentDebugMode,
        to: newDebugMode,
        context: this.context
      });

      this.currentDebugMode = newDebugMode;
      this.applyDebugMode(newDebugMode);
      if (this.context === 'background') this.sendOffscreenSettings({ DEBUG_MODE: newDebugMode });

      // Background owns broadcasts; offscreen applies local changes only.
      if (this.context !== 'background' && this.context !== 'offscreen') {
        this.broadcastChange(MessageActions.DEBUG_MODE_CHANGED, { debugMode: newDebugMode });
      }
    } else if (this.context === 'offscreen') {
      this.applyDebugMode(newDebugMode);
    }
  }

  /**
   * Handle component log levels change
   * @param {Object} levels - New component log levels object
   */
  handleComponentLogLevelsChange(levels) {
    if (this.context === 'offscreen') this.offscreenSettingRevisions.COMPONENT_LOG_LEVELS++;
    levels = sanitizeComponentLogLevels(levels);
    logger.info('Component log levels changed', {
      count: levels ? Object.keys(levels).length : 0,
      context: this.context
    });

    this.applyComponentLogLevels(levels);
    if (this.context === 'background') this.sendOffscreenSettings({ COMPONENT_LOG_LEVELS: levels });

    if (this.context !== 'background' && this.context !== 'offscreen') {
      this.broadcastChange(MessageActions.COMPONENT_LOG_LEVELS_CHANGED, { levels });
    }
  }

  /**
   * Broadcast change to other contexts
   * @param {string} action - Action name
   * @param {Object} data - Message data
   */
  broadcastChange(action, data) {
    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({
          action,
          data
        }).catch(() => {
          // Silently ignore errors - some contexts might not be available
        });
      }
    } catch {
      // Silently ignore broadcast errors
    }
  }

  sendOffscreenSettings(data) {
    try {
      globalThis.chrome?.runtime?.sendMessage({
        target: 'offscreen',
        action: MessageActions.OFFSCREEN_LOGGING_SETTINGS_UPDATED,
        data: sanitizeLoggingSettings(data, true),
      }).catch(() => {});
    } catch { /* offscreen may not exist */ }
  }

  /**
   * Broadcast debug mode change to other contexts
   * @deprecated Use broadcastChange instead
   * @param {boolean} debugMode - Debug mode value to broadcast
   */
  broadcastDebugModeChange(debugMode) {
    this.broadcastChange(MessageActions.DEBUG_MODE_CHANGED, { debugMode });
  }

  /**
   * Get current debug mode
   * @returns {boolean} Current debug mode state
   */
  getCurrentDebugMode() {
    return this.currentDebugMode;
  }

  /**
   * Force refresh debug mode from storage
   * @returns {Promise<boolean>} Current debug mode after refresh
   */
  async refresh() {
    try {
      const debugMode = await this.getDebugModeFromStorage();
      if (debugMode !== this.currentDebugMode) {
        await this.applyDebugMode(debugMode);
      }
      return debugMode;
    } catch (error) {
      logger.error('Failed to refresh debug mode:', error);
      return this.currentDebugMode;
    }
  }

  /**
   * Cleanup listeners and resources
   */
  cleanup() {
    try {
      this.offscreenInitializationGeneration++;
      if (this.offscreenRetryTimeout !== null) clearTimeout(this.offscreenRetryTimeout);
      this.offscreenRetryTimeout = null;
      this.offscreenRetryWaitResolve?.();
      this.offscreenRetryWaitResolve = null;
      // Remove storage listener
      if (this.storageListener && typeof browser !== 'undefined' && browser.storage?.onChanged) {
        browser.storage.onChanged.removeListener(this.storageListener);
        this.storageListener = null;
      }

      // Remove message listener
      if (this.messageListener && typeof browser !== 'undefined' && browser.runtime?.onMessage) {
        browser.runtime.onMessage.removeListener(this.messageListener);
        this.messageListener = null;
      }

      this.isInitialized = false;
      logger.debug('Cleanup completed');
    } catch (error) {
      logger.warn('Error during cleanup:', error);
    }
  }
}

// Create singleton instance
const debugModeBridge = new DebugModeBridge();

export { DebugModeBridge };
export { debugModeBridge };
export default debugModeBridge;

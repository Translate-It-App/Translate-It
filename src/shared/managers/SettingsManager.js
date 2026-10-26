/**
 * SettingsManager - Runtime settings facade
 *
 * Provides centralized access to tracked runtime settings backed by StorageCore.
 */

import { getScopedLogger } from '@/shared/logging/logger.js'
import browser from 'webextension-polyfill'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { storageManager } from '@/shared/storage/core/StorageCore.js'
import ExtensionContextManager from '@/core/extensionContext.js'
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js'
import { ref, computed } from 'vue'

const logger = getScopedLogger(LOG_COMPONENTS.CONFIG, 'SettingsManager');

/**
 * Settings needed by SettingsManager runtime consumers.
 * Keep runtime storage reads narrower than the complete persisted schema.
 */
const FALLBACK_SETTING_KEYS = Object.freeze([
  'APPLICATION_LOCALIZE',
  'EXTENSION_ENABLED',
  'TRANSLATE_ON_TEXT_FIELDS',
  'TRANSLATE_ON_TEXT_SELECTION',
  'TRANSLATE_WITH_SELECT_ELEMENT',
  'ENABLE_SCREEN_CAPTURE',
  'OCR_DEFAULT_LANG',
  'OCR_PREFERRED_ACTION',
  'REQUIRE_CTRL_FOR_TEXT_SELECTION',
  'selectionTranslationMode',
  'ENABLE_SHORTCUT_FOR_TEXT_FIELDS',
  'SOURCE_LANGUAGE',
  'TARGET_LANGUAGE',
  'TRANSLATION_API',
  'MODE_PROVIDERS',
  'AI_CONTEXT_TRANSLATION_ENABLED',
  'ENABLE_DICTIONARY',
  'EXCLUDED_SITES',
  'POPUP_MAX_CHARS',
  'SIDEPANEL_MAX_CHARS',
  'SELECTION_MAX_CHARS',
  'SELECT_ELEMENT_MAX_CHARS',
  'MOBILE_UI_MODE',
  'SHOW_DESKTOP_FAB',
  'TEXT_FIELD_SHORTCUT',
  'WINDOW_IS_PINNED',
  'WINDOW_DOCK_MODE',
  'WINDOW_DOCKED_WIDTH',
  'WHOLE_PAGE_TRANSLATION_ENABLED',
  'WHOLE_PAGE_LAZY_LOADING',
  'WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES',
  'WHOLE_PAGE_EXCLUDED_SELECTORS',
  'WHOLE_PAGE_ATTRIBUTES_TO_TRANSLATE',
  'WHOLE_PAGE_MAX_ELEMENTS',
  'WHOLE_PAGE_CHUNK_SIZE',
  'WHOLE_PAGE_MAX_CHARS',
  'WHOLE_PAGE_AI_MAX_CHARS',
  'WHOLE_PAGE_DEBOUNCE_DELAY',
  'WHOLE_PAGE_ROOT_MARGIN',
  'WHOLE_PAGE_PROGRESS_UPDATE_INTERVAL',
  'WHOLE_PAGE_SHOW_ORIGINAL_ON_HOVER',
  'WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP',
  'WHOLE_PAGE_SCROLL_STOP_DELAY',
  'WHOLE_PAGE_TOKEN_WARNING_HIDDEN',
  'WHOLE_PAGE_AUTO_TRANSLATE_RULES',
  'CONTEXT_MENU_VISIBILITY',
  'MOUSE_HOVER_TRANSLATION_ENABLED',
  'MOUSE_HOVER_SCOPE',
  'MOUSE_HOVER_TRIGGER',
  'MOUSE_HOVER_DELAY',
  'MOUSE_HOVER_AUTO_CLOSE',
  'MOUSE_HOVER_TIMER_DURATION',
  'MOUSE_HOVER_SHOW_CONTAINER_BORDER'
]);

function areSettingValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return false;
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getFallbackDefaults() {
  const persistedDefaults = getPersistedDefaultSettings();
  const missingKeys = FALLBACK_SETTING_KEYS.filter(key => (
    !Object.prototype.hasOwnProperty.call(persistedDefaults, key)
    || persistedDefaults[key] === undefined
  ));

  if (missingKeys.length > 0) {
    throw new Error(
      `Fallback settings missing canonical persisted defaults: ${missingKeys.join(', ')}`
    );
  }

  return Object.fromEntries(
    FALLBACK_SETTING_KEYS.map(key => [key, persistedDefaults[key]])
  );
}

/**
 * Runtime settings facade for content, iframe, and background consumers.
 */
class SettingsManager {
  constructor() {
    if (SettingsManager.instance) {
      return SettingsManager.instance
    }

    SettingsManager.instance = this

    // Internal state
    this._initialized = false
    this._initializationPromise = null
    this._storageListenerSetup = false
    this._storageListener = null
    this._storageListenerTarget = null
    this._eventListeners = new Map()
    this._pendingUpdates = new Map()

    // Keep runtime settings reactive for existing consumers.
    this._settings = ref({})

    // Canonical values restricted to tracked runtime consumers; loaded settings override these values.
    this._defaults = getFallbackDefaults()

    logger.debug('SettingsManager singleton created')
  }

  /**
   * Initialize the SettingsManager
   */
  initialize() {
    if (this._initialized) {
      logger.debug('SettingsManager already initialized')
      return Promise.resolve(this)
    }

    if (this._initializationPromise) {
      logger.debug('SettingsManager initialization already in progress')
      return this._initializationPromise
    }

    this._initializationPromise = this._initializeRuntime().finally(() => {
      this._initializationPromise = null
    })

    return this._initializationPromise
  }

  async _initializeRuntime() {
    let settings
    try {
      settings = await storageManager.get(Object.keys(this._defaults))
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-manager-runtime-load')
      } else {
        logger.error('Failed to load settings from storage for runtime facade:', error)
      }
      throw error
    }

    const loadedSettings = Object.fromEntries(
      Object.keys(this._defaults)
        .filter(key => settings?.[key] !== undefined)
        .map(key => [key, settings[key]])
    )
    this._settings.value = { ...this._defaults, ...loadedSettings }
    logger.debug('Settings loaded from storage for runtime facade')

    // Setup storage listener for real-time updates only after success
    this._setupStorageListener()

    this._initialized = true
    logger.debug('SettingsManager runtime facade initialized successfully')
    return this
  }

  /**
   * Warm up the cache by loading all settings at once
   * This is recommended to be called early in the lifecycle
   */
  async warmup() {
    try {
      const keys = Object.keys(this._defaults);
      await storageManager.get(keys);
      logger.debug(`Cache warmed up with ${keys.length} keys`);
      return this;
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-manager-warmup');
      } else {
        logger.error('Failed to warmup SettingsManager:', error);
      }
      return this;
    }
  }

  /**
   * Get all tracked runtime settings
   */
  getSettings() {
    if (!this._initialized) {
      logger.debug('SettingsManager not initialized, returning empty object')
      return ref({})
    }

    return this._settings.value
  }

  /**
   * Get a specific setting value (synchronous)
   */
  get(key, defaultValue = undefined) {
    if (!this._initialized) {
      logger.debug(`SettingsManager not initialized, returning default for ${key}`)
      return defaultValue
    }

    const value = this._settings.value[key]
    return value !== undefined ? value : (this._defaults[key] !== undefined ? this._defaults[key] : defaultValue)
  }

  /**
   * Get a setting value asynchronously (ensures initialization)
   */
  async getAsync(key, defaultValue = undefined) {
    if (!this._initialized) {
      await this.initialize()
    }

    return this.get(key, defaultValue)
  }

  /**
   * Set a setting value
   */
  async set(key, value) {
    if (!this._initialized) {
      await this.initialize()
    }

    this._assertRuntimeSettingKeys([key])

    const oldValue = this.get(key)

    const pendingUpdate = this._trackPendingUpdate(key, value)

    try {
      await storageManager.set({ [key]: value })
      this._settings.value[key] = value

      // Emit change event
      this._emitChangeEvent(key, value, oldValue)

      logger.debug(`Setting updated (runtime): ${key} =`, value)
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, `settings-manager-set-runtime-${key}`);
      } else {
        logger.error('Failed to update setting in runtime facade:', error)
      }
      throw error
    } finally {
      this._clearPendingUpdate(key, pendingUpdate)
    }
  }

  /**
   * Set multiple settings at once
   */
  async setMultiple(updates) {
    if (!this._initialized) {
      await this.initialize()
    }

    const updateKeys = Object.keys(updates)
    this._assertRuntimeSettingKeys(updateKeys, true)
    const oldValues = {}
    const pendingUpdates = {}

    for (const key of updateKeys) {
      oldValues[key] = this.get(key)
      pendingUpdates[key] = this._trackPendingUpdate(key, updates[key])
    }

    try {
      await storageManager.set(updates)

      for (const key of updateKeys) {
        this._settings.value[key] = updates[key]
        this._emitChangeEvent(key, updates[key], oldValues[key])
      }

      logger.debug('Multiple settings updated (runtime):', updates)
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-manager-set-multiple-runtime')
      } else {
        logger.error('Failed to update multiple settings in runtime facade:', error)
      }
      throw error
    } finally {
      for (const key of updateKeys) {
        this._clearPendingUpdate(key, pendingUpdates[key])
      }
    }
  }

  /**
   * Check if a setting exists
   */
  has(key) {
    if (!this._initialized) {
      return false
    }

    return Object.prototype.hasOwnProperty.call(this._settings.value, key)
  }

  /**
   * Get all settings as a plain object
   */
  getAll() {
    if (!this._initialized) {
      return { ...this._defaults }
    }

    return Object.fromEntries(
      Object.entries(this._settings.value).filter(([key]) => (
        Object.prototype.hasOwnProperty.call(this._defaults, key)
      ))
    )
  }

  /**
   * Listen for settings changes
   */
  onChange(key, callback, context = null) {
    // Validate callback
    if (typeof callback !== 'function') {
      logger.error(`Invalid callback provided for ${key}:`, typeof callback, callback)
      return () => {} // Return noop function
    }

    const listenerId = `${key}_${Date.now()}_${Math.random()}`

    if (!this._eventListeners.has(key)) {
      this._eventListeners.set(key, new Map())
    }

    const listenerObj = { callback, context }
    Object.freeze(listenerObj) // Prevent modification
    this._eventListeners.get(key).set(listenerId, listenerObj)

    logger.debug(`Listener added for setting: ${key}`)

    // Return unsubscribe function
    return () => {
      const keyListeners = this._eventListeners.get(key)
      if (keyListeners) {
        keyListeners.delete(listenerId)
        if (keyListeners.size === 0) {
          this._eventListeners.delete(key)
        }
      }
    }
  }

  /**
   * Remove all listeners for a specific context
   */
  removeContextListeners(context) {
    for (const [key, listeners] of this._eventListeners) {
      for (const [id, listener] of listeners) {
        if (listener.context === context) {
          listeners.delete(id)
        }
      }
      if (listeners.size === 0) {
        this._eventListeners.delete(key)
      }
    }
  }

  /**
   * Create a computed property for a setting (Vue specific)
   */
  computed(key, defaultValue = undefined) {
    if (!this._initialized) {
      logger.debug('SettingsManager not initialized for computed property')
      return computed(() => defaultValue)
    }

    return computed({
      get: () => this.get(key, defaultValue),
      set: (value) => this.set(key, value)
    })
  }

  /**
   * Check if extension is enabled
   */
  isExtensionEnabled() {
    return this.get('EXTENSION_ENABLED', true)
  }

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(featureKey) {
    // Master switch
    if (!this.isExtensionEnabled()) {
      return false
    }

    // Feature-specific flag
    return this.get(featureKey, true)
  }

  /**
   * Reset all settings to defaults
   */
  async reset() {
    if (!this._initialized) {
      await this.initialize()
    }

    throw new Error('SettingsManager reset is unavailable in fallback mode')
  }

  /**
   * Export settings
   */
  async export(password = '') {
    void password

    if (!this._initialized) {
      await this.initialize()
    }

    throw new Error('SettingsManager export is unavailable in fallback mode')
  }

  /**
   * Import settings
   */
  async import(settingsData, password = '') {
    void settingsData
    void password

    if (!this._initialized) {
      await this.initialize()
    }

    throw new Error('SettingsManager import is unavailable in fallback mode')
  }

  
  /**
   * Setup chrome.storage listener for runtime settings
   */
  _setupStorageListener() {
    // Only setup listener once
    if (this._storageListenerSetup) {
      logger.debug('Storage listener already setup, skipping')
      return
    }

    // Use cross-browser compatible approach for storage API
    const browserAPI = typeof browser !== "undefined"
      ? browser
      : (typeof chrome !== "undefined" ? chrome : null);

    if (
      !browserAPI?.storage?.onChanged
      || typeof browserAPI.storage.onChanged.addListener !== 'function'
    ) {
      logger.debug('Storage API not available, cannot setup storage listener')
      return
    }

    // Runtime-only storage listener.
    // StorageCore remains the persistence and cache authority for all writes.
    this._storageListener = (changes, areaName) => {
      logger.debug(`Storage onChanged triggered for area: ${areaName}`, Object.keys(changes || {}))

      if (areaName !== 'local') return

      for (const [key, change = {}] of Object.entries(changes || {})) {
        if (Object.prototype.hasOwnProperty.call(this._defaults, key)) {
          const newValue = change.newValue === undefined
            ? this._defaults[key]
            : change.newValue
          const oldValue = this._settings.value[key] === undefined
            ? this._defaults[key]
            : this._settings.value[key]

          // Local writes emit immediately; their matching browser event is acknowledgement only.
          if (this._consumePendingUpdate(key, newValue)) {
            continue
          }

          if (areSettingValuesEqual(newValue, oldValue)) {
            continue
          }

          // Update internal settings
          this._settings.value[key] = newValue

          // Emit change event
          this._emitChangeEvent(key, newValue, oldValue)

          logger.info(`Setting changed (storage listener): ${key} =`, newValue)
        }
      }
    }

    try {
      browserAPI.storage.onChanged.addListener(this._storageListener)
      this._storageListenerTarget = browserAPI.storage.onChanged
      this._storageListenerSetup = true
      logger.debug('Storage listener setup complete')
    } catch (error) {
      this._storageListener = null
      this._storageListenerTarget = null
      throw error
    }
  }

  /**
   * Manually trigger settings refresh (useful when settings are saved from options page)
   * @returns {Promise<void>} Resolves after refresh; rejects when storage refresh fails
   */
  async refreshSettings() {
    if (!this._initialized) {
      await this.initialize();
    }

    try {
      const trackedKeys = Object.keys(this._defaults)
      const currentSettings = await storageManager.getFresh(trackedKeys)

      for (const key of trackedKeys) {
        const newValue = currentSettings?.[key] === undefined
          ? this._defaults[key]
          : currentSettings[key]
        const oldValue = this._settings.value[key] === undefined
          ? this._defaults[key]
          : this._settings.value[key]

        if (!areSettingValuesEqual(newValue, oldValue)) {
          logger.debug(`Manual refresh detected change: ${key} =`, newValue)

          // Update internal settings
          this._settings.value[key] = newValue

          // Emit change event
          this._emitChangeEvent(key, newValue, oldValue)
        }
      }

      logger.debug('Settings refreshed manually')
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-manager-refresh');
      } else {
        logger.error('Error manually refreshing settings:', error)
      }

      throw error
    }
  }

  /**
   * Emit change event
   */
  _emitChangeEvent(key, newValue, oldValue) {
    if (areSettingValuesEqual(newValue, oldValue)) {
      return
    }

    // Notify listeners
    const listeners = this._eventListeners.get(key)
    if (listeners) {
      logger.debug(`Notifying ${listeners.size} listeners for ${key}`)
      for (const listener of listeners.values()) {
        try {
          if (typeof listener.callback === 'function') {
            listener.callback(newValue, oldValue, key)
          } else {
            logger.error(`Invalid callback for ${key}:`, typeof listener.callback, listener)
          }
        } catch (error) {
          if (ExtensionContextManager.isContextError(error)) {
            ExtensionContextManager.handleContextError(error, `settings-manager-emit-${key}`);
          } else {
            logger.error(`Error in settings listener for ${key}:`, error)
          }
        }
      }
    }

    // Log important changes
    const importantKeys = ['EXTENSION_ENABLED', 'TRANSLATE_API', 'SOURCE_LANGUAGE', 'TARGET_LANGUAGE']
    if (importantKeys.includes(key)) {
      logger.info(`Important setting changed: ${key} =`, newValue)
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this._storageListener && this._storageListenerTarget?.removeListener) {
      try {
        this._storageListenerTarget.removeListener(this._storageListener)
      } catch (error) {
        logger.warn('Failed to remove storage listener:', error)
      }
    }

    this._eventListeners.clear()
    this._pendingUpdates.clear()
    this._initialized = false
    this._initializationPromise = null
    this._storageListenerSetup = false
    this._storageListener = null
    this._storageListenerTarget = null
    this._settings.value = {}
    SettingsManager.instance = null
    logger.debug('SettingsManager destroyed')
  }

  _trackPendingUpdate(key, value) {
    const pendingUpdates = this._pendingUpdates.get(key) || []
    const pendingUpdate = { value }
    pendingUpdates.push(pendingUpdate)
    this._pendingUpdates.set(key, pendingUpdates)
    return pendingUpdate
  }

  _consumePendingUpdate(key, value) {
    const pendingUpdates = this._pendingUpdates.get(key)
    if (!pendingUpdates) return false

    const index = pendingUpdates.findIndex(update => areSettingValuesEqual(update.value, value))
    if (index === -1) return false

    pendingUpdates.splice(index, 1)
    if (pendingUpdates.length === 0) {
      this._pendingUpdates.delete(key)
    }
    return true
  }

  _clearPendingUpdate(key, pendingUpdate) {
    const pendingUpdates = this._pendingUpdates.get(key)
    if (!pendingUpdates) return

    const index = pendingUpdates.indexOf(pendingUpdate)
    if (index !== -1) {
      pendingUpdates.splice(index, 1)
    }
    if (pendingUpdates.length === 0) {
      this._pendingUpdates.delete(key)
    }
  }

  _assertRuntimeSettingKeys(keys, multiple = false) {
    const unsupportedKeys = keys
      .filter(key => !Object.prototype.hasOwnProperty.call(this._defaults, key))
      .sort()

    if (unsupportedKeys.length === 0) return

    const label = multiple ? 'keys' : 'key'
    throw new Error(
      `SettingsManager fallback does not support setting ${label}: ${unsupportedKeys.join(', ')}`
    )
  }
}

// Export singleton instance
export const settingsManager = new SettingsManager()

// Export for direct use in Vue components
export function useSettings() {
  return {
    settings: settingsManager.getSettings(),
    get: settingsManager.get.bind(settingsManager),
    getAsync: settingsManager.getAsync.bind(settingsManager),
    set: settingsManager.set.bind(settingsManager),
    setMultiple: settingsManager.setMultiple.bind(settingsManager),
    has: settingsManager.has.bind(settingsManager),
    getAll: settingsManager.getAll.bind(settingsManager),
    onChange: settingsManager.onChange.bind(settingsManager),
    computed: settingsManager.computed.bind(settingsManager),
    isExtensionEnabled: settingsManager.isExtensionEnabled.bind(settingsManager),
    isFeatureEnabled: settingsManager.isFeatureEnabled.bind(settingsManager),
    reset: settingsManager.reset.bind(settingsManager),
    export: settingsManager.export.bind(settingsManager),
    import: settingsManager.import.bind(settingsManager),
    refreshSettings: settingsManager.refreshSettings.bind(settingsManager),
    removeContextListeners: settingsManager.removeContextListeners.bind(settingsManager)
  }
}

// Initialize on module load (if in browser context)
if (typeof window !== 'undefined') {
  settingsManager.initialize().catch(error => {
    setTimeout(() => {
      logger.error('Failed to auto-initialize SettingsManager:', error)
    }, 0)
  })
}

export default settingsManager

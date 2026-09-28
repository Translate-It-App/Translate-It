import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import browser from 'webextension-polyfill'
import { CONFIG, TranslationMode, SelectionTranslationMode } from '@/shared/config/config.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js'
import secureStorage from '@/shared/storage/core/SecureStorage.js'
import { storageManager } from '@/shared/storage/core/StorageCore.js'
import ExtensionContextManager from '@/core/extensionContext.js'
import { runSettingsMigrations } from '@/shared/config/settingsMigrations.js'
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js'
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js'
import { getFirstMissingSetting } from '@/features/translation/utils/providerValidator.js'
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
const logger = getScopedLogger(LOG_COMPONENTS.SETTINGS, 'settings');

// --- Helpers ------------------------------------------------------------
/**
 * Canonical persisted-settings defaults source.
 *
 * Thin delegate to the shared builder in src/shared/config/settingsDefaults.js,
 * which is the single persisted-schema authority. Translation history is
 * feature data, not a persisted setting-schema member, so store initialization
 * owns its empty runtime value here.
 */
function getDefaultSettings() {
  return {
    ...getPersistedDefaultSettings(),
    translationHistory: []
  };
}

/**
 * Filters a source object to canonical persisted-settings keys.
 *
 * Ownership invariant: SettingsStore owns key membership (from
 * getPersistedDefaultSettings(), keys only); StorageCore owns plain-data
 * conversion (StorageCore.set() runs _convertToPlainObject() on every write,
 * so reactive proxies never reach browser storage as proxies). Values here
 * keep their original references — no store-level cloning.
 *
 * Values are always taken from the source and never backfilled from defaults.
 * Keys absent from the source — or explicitly undefined — are skipped.
 * translationHistory and any non-schema runtime keys are excluded by
 * construction — history owns its own storage key via the history feature.
 *
 * Used for full-state writes (performSave reads settings.value) and for
 * narrowed writes (updateMultipleSettings reads the updates object only).
 */
function buildPersistedSnapshot(source) {
  const snapshot = {};
  Object.keys(getPersistedDefaultSettings()).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) return;
    snapshot[key] = source[key];
  });
  return snapshot;
}

export const useSettingsStore = defineStore('settings', () => {
  // State - complete settings object with CONFIG defaults
  const settings = ref(getDefaultSettings())
  
  // Loading states
  const isLoading = ref(false)
  const isInitialized = ref(false)
  const isSaving = ref(false)
  const isSettingsValid = ref(true) // Global validation state for options UI
  
  // Non-persisted UI state for the Options page
  const activeConfigProvider = ref(null)
  const systemPrefersDark = ref(false)
  let systemThemeMediaQuery = null
  let removeSystemThemeListener = null
  
  // Getters
  const isDarkTheme = computed(() => {
    if (settings.value.THEME === 'auto') {
      return systemPrefersDark.value
    }
    return settings.value.THEME === 'dark'
  })
  
  const canTranslate = computed(() => {
    return settings.value.EXTENSION_ENABLED && settings.value.TRANSLATION_API && !isLoading.value
  })
  
  const sourceLanguage = computed(() => settings.value.SOURCE_LANGUAGE)
  const targetLanguage = computed(() => settings.value.TARGET_LANGUAGE)
  const selectedProvider = computed(() => settings.value.TRANSLATION_API)
  
  /**
   * Helper to get the effective provider for a mode from reactive state.
   * Follows the same logic as getEffectiveProviderAsync in config.js.
   * Includes feature validation to ensure the provider is suitable for the mode.
   */
  const getEffectiveProvider = (mode) => {
    const modeProviders = settings.value.MODE_PROVIDERS || {};
    const globalApi = settings.value.TRANSLATION_API || ProviderRegistryIds.GOOGLE_V2;
    const systemDefault = ProviderRegistryIds.GOOGLE_V2;

    let resolvedId = globalApi;

    // 1. Direct mode-specific setting
    if (mode && modeProviders[mode]) {
      resolvedId = modeProviders[mode];
    } 
    // 2. Hierarchical Fallbacks
    else if (mode === TranslationMode.Dictionary_Translation && modeProviders[TranslationMode.Selection]) {
      resolvedId = modeProviders[TranslationMode.Selection];
    }

    // 3. Validation
    const provider = findProviderById(resolvedId);
    const needsBulk = [
      TranslationMode.Page,
      TranslationMode.PDF,
      TranslationMode.Select_Element,
      TranslationMode.Field
    ].includes(mode);

    if (needsBulk && provider && !provider.features?.includes('bulk')) {
      return systemDefault;
    }

    return resolvedId;
  };

  // Font settings getters
  const fontFamily = computed(() => settings.value.TRANSLATION_FONT_FAMILY)
  const fontSize = computed(() => settings.value.TRANSLATION_FONT_SIZE)
  
  // Actions
  let __loadInFlight = null;
  const loadSettings = async () => {
    if (isInitialized.value) return settings.value;
    if (__loadInFlight) return __loadInFlight;
    isLoading.value = true;
    __loadInFlight = (async () => {
      try {
        const stored = await storageManager.get(null);
        const current = settings.value;

  
        // Merge settings from storage (after potential migrations)
        Object.keys(current).forEach(key => {
          if (Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined) {
            if (key === 'EXCLUDED_SITES') {
              if (Array.isArray(stored[key])) current[key] = stored[key];
              else if (typeof stored[key] === 'object' && stored[key] !== null) current[key] = Object.values(stored[key]).filter(s => typeof s === 'string');
              else current[key] = [];
            } else if (key === 'translationHistory') {
              current[key] = Array.isArray(stored[key]) ? stored[key] : [];
            } else {
              current[key] = stored[key];
            }
          }
        });

        logger.debug('Settings merged from storage');

        isInitialized.value = true;
        
        // Setup listener for future changes
        await setupStorageListener();
        
        return current;
      } catch (error) {
        if (ExtensionContextManager.isContextError(error)) {
          ExtensionContextManager.handleContextError(error, 'settings-store-load');
        } else {
          logger.error('Failed to load settings:', error);
        }
        throw error;
      } finally {
        isLoading.value = false;
        __loadInFlight = null;
      }
    })();
    return __loadInFlight;
  }
  
  // Immediate save: resolves only after the storage operation finishes.
  const saveAllSettings = async () => performSave()

  /**
   * Sanitizes settings before saving to prevent logical inconsistencies.
   * - If Desktop FAB is disabled, ensure selectionTranslationMode is not set to ON_FAB_CLICK.
   */
  const sanitizeSettings = () => {
    const s = settings.value;
    
    // 1. FAB Consistency: If BOTH FABs are disabled, we can't use it for translation trigger.
    // Fallback to ON_CLICK (Show icon) to ensure user has a way to translate.
    if (s.SHOW_DESKTOP_FAB === false && s.SHOW_MOBILE_FAB === false && s.selectionTranslationMode === SelectionTranslationMode.ON_FAB_CLICK) {
      logger.info('Sanitizing settings: Both FABs disabled, falling back selectionTranslationMode to ON_CLICK');
      s.selectionTranslationMode = SelectionTranslationMode.ON_CLICK;
    }
    
    // 2. Extension State: If extension is disabled, ensure we still allow some internal state to be consistent
    // (Add more sanitization rules here if needed in the future)
  }

  async function performSave() {
    isSaving.value = true;
    try {
      // Run sanitization before saving
      sanitizeSettings();

      // Write-boundary: persist canonical schema keys only, with live values.
      await storageManager.set(buildPersistedSnapshot(settings.value));
      return true;
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-save');
      } else {
        logger.error('Failed to save all settings:', error);
      }
      throw error;
    } finally {
      isSaving.value = false;
    }
  }
  
  // Action to update a single setting in the local store state (without immediate persistence)
  const updateSettingLocally = (key, value) => {
    settings.value[key] = value
  }

  // Action to update a single setting and immediately persist it to storage
  const updateSettingAndPersist = async (key, value) => {
    try {
      settings.value[key] = value // Update local state
      
      const updates = { [key]: value };

      // SMART CLEANUP: If Debug Mode is disabled while Mock provider is active, 
      // automatically switch to the system default provider.
      if (key === 'DEBUG_MODE' && value === false) {
        const defaultApi = CONFIG.TRANSLATION_API || 'googlev2';
        let hasChanges = false;

        // Cleanup Global Provider
        if (settings.value['TRANSLATION_API'] === 'mock') {
          settings.value['TRANSLATION_API'] = defaultApi;
          updates['TRANSLATION_API'] = defaultApi;
          hasChanges = true;
          logger.info(`Debug mode disabled: Reverted global provider from Mock to default: ${defaultApi}`);
        }

        // Cleanup Mode-Specific Providers
        if (settings.value.MODE_PROVIDERS) {
          Object.keys(settings.value.MODE_PROVIDERS).forEach(mode => {
            if (settings.value.MODE_PROVIDERS[mode] === 'mock') {
              settings.value.MODE_PROVIDERS[mode] = null; // Revert to fallback (Global)
              hasChanges = true;
              logger.info(`Debug mode disabled: Reverted ${mode} provider from Mock to fallback`);
            }
          });
          
          if (hasChanges) {
            updates['MODE_PROVIDERS'] = { ...settings.value.MODE_PROVIDERS };
          }
        }
      }

      // Canonical write boundary: persist only schema keys from the final
      // updates object (including DEBUG_MODE cleanup additions, which are
      // canonical). An empty result skips the storage round-trip; local state
      // and the true return are unaffected.
      const filtered = buildPersistedSnapshot(updates)
      if (Object.keys(filtered).length === 0) return true
      await storageManager.set(filtered)
      return true
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, `settings-store-update-${key}`);
      } else {
        logger.error(`Failed to update and persist setting ${key}:`, error);
      }
      throw error
    }
  }
  
  const updateMultipleSettings = async (updates) => {
    try {
      // Update local state (all keys, including non-schema runtime keys)
      Object.assign(settings.value, updates)

      // Narrow write: persist only the canonical keys from this update.
      // Unrelated canonical settings already in state are NOT rewritten, which
      // removes the concurrent-overwrite window of a whole-snapshot write.
      // An empty result skips the storage round-trip (set({}) writes nothing
      // and emits no events); local state and the true return are unaffected.
      const filtered = buildPersistedSnapshot(updates || {})
      if (Object.keys(filtered).length === 0) return true
      await storageManager.set(filtered)
      
      return true
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-update-multiple');
      } else {
        logger.error('Failed to update multiple settings:', error);
      }
      throw error
    }
  }
  
  const resetSettings = async () => {
    try {
      await storageManager.clear();
      const defaults = getDefaultSettings();
      // Preserve reference to reactive object
      Object.keys(settings.value).forEach(k => delete settings.value[k]);
      Object.assign(settings.value, defaults);
      // Persist canonical settings only; translation history is store-owned
      // feature data and is already cleared with storage above.
      await storageManager.set(getPersistedDefaultSettings());
      return true;
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-reset');
      } else {
        logger.error('Failed to reset settings:', error);
      }
      throw error;
    }
  }
  
  const exportSettings = async (password = '') => {
    try {
      const settingsToExport = await loadSettings();
      
      // Use the centralized secureStorage utility for consistent export behavior
      // This will handle API key encryption and exclude large data like history
      const exportData = await secureStorage.prepareForExport(
        settingsToExport,
        password
      );

      // Add additional metadata for the export
      let version;
      try { 
        version = browser.runtime.getManifest()?.version; 
      } catch {
        // Browser runtime not available, use undefined
      }

      return {
        ...exportData,
        _exported: true,
        _timestamp: new Date().toISOString(),
        _version: version
      };
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-export');
      } else {
        logger.error('Failed to export settings:', error);
      }
      throw error;
    }
  }
  
  const importSettings = async (importData, password = '') => {
    try {
      logger.info('[Import] Starting');

      // Validate that importData is a valid JSON object and contains Translate-It signatures
      if (!importData || typeof importData !== 'object' || Array.isArray(importData)) {
        throw new Error('invalid_settings_format');
      }

      const VALID_SIGNATURE_KEYS = [
        'TRANSLATION_API',
        'THEME',
        'SOURCE_LANGUAGE',
        'TARGET_LANGUAGE',
        'SHOW_DESKTOP_FAB',
        '_exported'
      ];

      const hasSignature = VALID_SIGNATURE_KEYS.some(key => Object.prototype.hasOwnProperty.call(importData, key)) || 
                           (importData._hasEncryptedKeys && importData._secureKeys);

      if (!hasSignature) {
        throw new Error('invalid_settings_format');
      }

      const processedSettings = await secureStorage.processImportedSettings(importData, password);
      const explicitImportedKeys = new Set(Object.keys(processedSettings));
      const hasImportedThinkingMode = Object.prototype.hasOwnProperty.call(
        processedSettings,
        'GEMINI_THINKING_MODE'
      );
      if (!hasImportedThinkingMode) {
        processedSettings.GEMINI_THINKING_MODE = processedSettings.GEMINI_THINKING_ENABLED === true
          ? 'minimal'
          : 'default';
      }
      // Legacy thinking state is converted before defaults are merged.
      delete processedSettings.GEMINI_THINKING_ENABLED;
      // OpenRouter endpoint is a CONFIG-owned runtime constant, not an imported setting.
      delete processedSettings.OPENROUTER_API_URL;
      // OpenAI endpoint is a CONFIG-owned runtime constant, not an imported setting.
      delete processedSettings.OPENAI_API_URL;

      // 1. Merge imported settings with defaults before migration to preserve
      // the established import contract for all other setting migrations.
      const defaultSettings = getDefaultSettings();
      // Non-editable prompt wrappers are CONFIG-owned implementation defaults that
      // are no longer persisted. Silently drop any copies carried by older backups
      // so they never re-enter storage via import.
      const nonEditablePromptKeys = Object.values(PROMPT_REGISTRY)
        .filter(p => !p.editable)
        .map(p => p.key);
      nonEditablePromptKeys.forEach(key => {
        delete processedSettings[key];
      });

      const mergedSettings = { ...defaultSettings, ...processedSettings };

      // Keep imported nested provider choices complete before migrations remap
      // legacy mode keys.
      if (processedSettings.MODE_PROVIDERS) {
        mergedSettings.MODE_PROVIDERS = {
          ...defaultSettings.MODE_PROVIDERS,
          ...processedSettings.MODE_PROVIDERS
        };
      }

      // 2. Run centralized migrations against the complete default shape while
      // passing imported-key presence so legacy migrations can distinguish
      // explicit values from defaults injected above.
      const { updates, logs, removals = [] } = await runSettingsMigrations(
        mergedSettings,
        explicitImportedKeys
      );

      // 3. Apply migrated values, then remove retired settings.
      Object.assign(mergedSettings, updates);
      removals.forEach(key => delete mergedSettings[key]);
      
      if (logs && logs.length > 0) {
        logger.info('[Import] Migrations applied:', logs);
      }

      // Temporarily remove storage listener to prevent interference during import
      if (storageListener) {
        storageManager.off('change', storageListener);
        storageListener = null;
      }

      // 4. Update local state with the fully migrated and merged settings
      // We replace the entire settings object to ensure no stale old keys remain
      Object.keys(settings.value).forEach(k => delete settings.value[k]);
      Object.assign(settings.value, mergedSettings);

      await saveAllSettings();
      if (removals.length > 0) {
        await storageManager.remove(removals);
      }

      // Re-setup storage listener after import is complete
      await setupStorageListener();

      logger.info('[Import] Completed');

      return true;
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-import');
      } else {
        logger.error('[Import] Failed:', error);
      }
      // Re-setup storage listener on error
      await setupStorageListener();
      throw error;
    }
  }
  
  const getSetting = (key, defaultValue = null) => {
    return settings.value[key] !== undefined ? settings.value[key] : defaultValue
  }
  
  const reconcileOcrLanguage = async (downloadedLanguages) => {
    const current = settings.value['OCR_DEFAULT_LANG'] || 'eng'
    if (downloadedLanguages.includes(current)) return

    const next = downloadedLanguages.length > 0 ? downloadedLanguages[0] : 'eng'
    await updateSettingAndPersist('OCR_DEFAULT_LANG', next)
  }

  const validateSettings = () => {
    const errors = []
    
    // 1. Validate languages
    const sLang = settings.value.SOURCE_LANGUAGE;
    const tLang = settings.value.TARGET_LANGUAGE;

    if (!sLang || sLang.toString().trim() === '') {
      errors.push('validation_source_language_empty')
    }
    
    if (!tLang || tLang.toString().trim() === '') {
      errors.push('validation_target_language_empty')
    }
    
    if (sLang && tLang && sLang !== 'auto' && sLang === tLang) {
      errors.push('validation_same_languages')
    }
    
    // 2. Validate Global Translation Provider
    const apiProvider = settings.value.TRANSLATION_API;
    if (apiProvider) {
      const missingKey = getFirstMissingSetting(apiProvider, settings.value);
      if (missingKey) {
        errors.push('ERRORS_API_CONFIG_INVALID')
      }
    }
    
    // 3. Validate Mode-Specific Providers
    if (settings.value.MODE_PROVIDERS) {
      const isExtEnabled = settings.value.EXTENSION_ENABLED !== false;
      
      Object.entries(settings.value.MODE_PROVIDERS).forEach(([mode, providerId]) => {
        if (providerId && providerId !== 'default' && providerId !== null) {
          // Determine if the feature for this mode is enabled
          let isFeatureEnabled = true;
          
          if (mode === TranslationMode.Field) {
            isFeatureEnabled = isExtEnabled && settings.value.TRANSLATE_ON_TEXT_FIELDS;
          } else if (mode === TranslationMode.Select_Element) {
            isFeatureEnabled = isExtEnabled && settings.value.TRANSLATE_WITH_SELECT_ELEMENT;
          } else if (mode === TranslationMode.Selection) {
            isFeatureEnabled = isExtEnabled && settings.value.TRANSLATE_ON_TEXT_SELECTION;
          } else if (mode === TranslationMode.Page) {
            isFeatureEnabled = isExtEnabled && settings.value.WHOLE_PAGE_TRANSLATION_ENABLED;
          } else if (mode === TranslationMode.MouseHover) {
            isFeatureEnabled = isExtEnabled && settings.value.MOUSE_HOVER_TRANSLATION_ENABLED;
          } else if (mode === TranslationMode.ScreenCapture) {
            isFeatureEnabled = isExtEnabled && (settings.value.ENABLE_SCREEN_CAPTURE !== false);
          }
          // Popup, Sidepanel, and Dictionary are always considered active features if extension is installed

          if (isFeatureEnabled) {
            const modeMissingKey = getFirstMissingSetting(providerId, settings.value);
            if (modeMissingKey) {
              errors.push('ERRORS_API_CONFIG_INVALID');
            }
          }
        }
      });
    }
    
    // 4. Validate Prompt Templates (Registry-Driven)
    Object.values(PROMPT_REGISTRY).forEach(promptMeta => {
      // Only validate editable prompts on save
      if (promptMeta.editable) {
        const template = settings.value[promptMeta.key];
        
        if (!template || template.toString().trim() === '') {
          errors.push(`prompt:${promptMeta.key}:validation_prompt_template_empty`);
        } else {
          // Verify required placeholders from registry
          const requiredPlaceholders = promptMeta.placeholders || ["$_{SOURCE}", "$_{TARGET}", "$_{TEXT}"];
          const missingPlaceholders = requiredPlaceholders.filter(p => !template.toString().includes(p));
          
          if (missingPlaceholders.length > 0) {
            errors.push(`prompt:${promptMeta.key}:validation_prompt_template_missing_placeholders`);
          }
        }
      }
    });
    
    // 5. Validate Proxy
    if (settings.value.PROXY_ENABLED && (!settings.value.PROXY_HOST || settings.value.PROXY_HOST.trim() === '')) {
      errors.push('proxy_host_invalid')
    }

    // 6. Validate Whole Page Translation Settings
    const scrollDelay = settings.value.WHOLE_PAGE_SCROLL_STOP_DELAY;
    if (scrollDelay !== undefined && (scrollDelay < 100 || scrollDelay > 5000)) {
      if (settings.value.WHOLE_PAGE_TRANSLATION_ENABLED && settings.value.EXTENSION_ENABLED !== false) {
        errors.push('validation_scroll_delay_invalid');
      } else {
        // Reset to default if feature is disabled
        const defaults = getDefaultSettings();
        settings.value.WHOLE_PAGE_SCROLL_STOP_DELAY = defaults.WHOLE_PAGE_SCROLL_STOP_DELAY;
      }
    }

    // 7. Validate Font Settings
    const fontSize = settings.value.TRANSLATION_FONT_SIZE;
    if (fontSize !== undefined) {
      const sizeNum = parseInt(fontSize);
      if (isNaN(sizeNum) || sizeNum < 10 || sizeNum > 30) {
        const defaults = getDefaultSettings();
        settings.value.TRANSLATION_FONT_SIZE = defaults.TRANSLATION_FONT_SIZE;
      }
    }

    const fontFamily = settings.value.TRANSLATION_FONT_FAMILY;
    if (!fontFamily || fontFamily.toString().trim() === '') {
      const defaults = getDefaultSettings();
      settings.value.TRANSLATION_FONT_FAMILY = defaults.TRANSLATION_FONT_FAMILY;
    }

    // 8. Validate Mouse Hover Settings
    const hoverDelay = settings.value.MOUSE_HOVER_DELAY;
    if (hoverDelay !== undefined && (hoverDelay < 100 || hoverDelay > 5000)) {
      if (settings.value.MOUSE_HOVER_TRANSLATION_ENABLED && settings.value.EXTENSION_ENABLED !== false) {
        errors.push('validation_mouse_hover_delay_invalid');
      } else {
        const defaults = getDefaultSettings();
        settings.value.MOUSE_HOVER_DELAY = defaults.MOUSE_HOVER_DELAY;
      }
    }

    const hoverTimer = settings.value.MOUSE_HOVER_TIMER_DURATION;
    if (hoverTimer !== undefined && (hoverTimer < 1000 || hoverTimer > 30000)) {
      if (settings.value.MOUSE_HOVER_TRANSLATION_ENABLED && settings.value.EXTENSION_ENABLED !== false) {
        errors.push('validation_mouse_hover_timer_invalid');
      } else {
        const defaults = getDefaultSettings();
        settings.value.MOUSE_HOVER_TIMER_DURATION = defaults.MOUSE_HOVER_TIMER_DURATION;
      }
    }

    if (errors.length > 0) {
      logger.debug('Settings validation failed:', errors);
    }
    
    return {
      isValid: errors.length === 0,
      errors
    }
  }
  
  /**
   * Resets the store to its default state.
   * Required for setup-style Pinia stores to support $reset().
   */
  function $reset() {
    settings.value = getDefaultSettings()
    isInitialized.value = false
    isLoading.value = false
    isSaving.value = false
  }
    
  // Storage change listener
  let storageListener = null

  // Handle storage changes from other parts of extension
  const handleStorageChange = ({ key, newValue, oldValue }) => {
    // Update the reactive settings ref
    if (settings.value[key] !== newValue) {
      settings.value[key] = newValue

      // Special handling for DEBUG_MODE - sync with logging system
      if (key === 'DEBUG_MODE' && oldValue !== newValue) {
        handleDebugModeChange(Boolean(newValue))
      }

      // Special handling for COMPONENT_LOG_LEVELS - sync with logging system
      if (key === 'COMPONENT_LOG_LEVELS' && JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        handleComponentLogLevelsChange(newValue)
      }
    }
  }

  // Handle DEBUG_MODE changes and sync with logging system
  const handleDebugModeChange = async (debugMode) => {
    try {
      // Import and initialize DebugModeBridge
      const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js')

      // Apply debug mode to logging system
      debugModeBridge.handleDebugModeChange(debugMode)

      logger.info('[SettingsStore] DEBUG_MODE changed and synced with logging system', {
        debugMode,
        source: 'storage_change'
      })
    } catch (error) {
      logger.warn('[SettingsStore] Failed to sync DEBUG_MODE with logging system:', error)
    }
  }

  // Handle COMPONENT_LOG_LEVELS changes and sync with logging system
  const handleComponentLogLevelsChange = async (levels) => {
    try {
      const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js')
      debugModeBridge.handleComponentLogLevelsChange(levels)
      
      logger.info('[SettingsStore] COMPONENT_LOG_LEVELS changed and synced with logging system', {
        levels,
        source: 'storage_change'
      })
    } catch (error) {
      logger.warn('[SettingsStore] Failed to sync COMPONENT_LOG_LEVELS with logging system:', error)
    }
  }

  // Setup storage listener using StorageManager
  const setupStorageListener = async () => {
    try {
      storageListener = handleStorageChange
  storageManager.on('change', storageListener)
  if (settings.value.DEBUG_MODE) logger.info('[SettingsStore] Listener setup')
    } catch (error) {
      logger.warn('[SettingsStore] Unable to setup storage listener:', error.message)
    }
  }

  const setupSystemThemeListener = () => {
    if (systemThemeMediaQuery || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !systemThemeMediaQuery) {
        systemPrefersDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      return;
    }

    systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemPrefersDark.value = systemThemeMediaQuery.matches;

    const handleSystemThemeChange = (event) => {
      systemPrefersDark.value = !!event?.matches;
    };

    if (typeof systemThemeMediaQuery.addEventListener === 'function') {
      systemThemeMediaQuery.addEventListener('change', handleSystemThemeChange);
      removeSystemThemeListener = () => {
        systemThemeMediaQuery?.removeEventListener('change', handleSystemThemeChange);
      };
    } else if (typeof systemThemeMediaQuery.addListener === 'function') {
      systemThemeMediaQuery.addListener(handleSystemThemeChange);
      removeSystemThemeListener = () => {
        systemThemeMediaQuery?.removeListener(handleSystemThemeChange);
      };
    }
  }

  // Cleanup storage listener using StorageManager
  const cleanupStorageListener = async () => {
    if (!storageListener) return;
    try {
      storageManager.off('change', storageListener);
      storageListener = null;
  if (settings.value.DEBUG_MODE) logger.info('[SettingsStore] Listener cleaned up');
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'settings-store-cleanup');
      } else {
        logger.error('[SettingsStore] Error cleaning up storage listener:', error);
      }
    }
  }

  // Sync activeConfigProvider with global TRANSLATION_API
  // This ensures that if the user changes the primary provider in the Languages tab, 
  // the Providers tab will automatically switch to it for configuration.
  watch(() => settings.value.TRANSLATION_API, (newVal) => {
    if (newVal) {
      activeConfigProvider.value = newVal;
      logger.debug(`[SettingsStore] activeConfigProvider synced to: ${newVal}`);
    }
  }, { immediate: true });

  // Initialize settings on store creation and setup listener
  loadSettings().then(async () => {
    setupSystemThemeListener();
    // Initialize DebugModeBridge after settings are loaded
    try {
      const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js')
      await debugModeBridge.initialize()

      logger.info('[SettingsStore] DebugModeBridge initialized successfully', {
        currentDebugMode: settings.value.DEBUG_MODE
      })
    } catch (error) {
      logger.warn('[SettingsStore] Failed to initialize DebugModeBridge:', error)
    }
  }).catch(error => {
    logger.error('Failed to initialize settings store:', error)
  })

  const cleanupStoreResources = () => {
    cleanupStorageListener()
    if (removeSystemThemeListener) {
      removeSystemThemeListener();
      removeSystemThemeListener = null;
      systemThemeMediaQuery = null;
    }
  }
  
  return {
    // State
    settings,
    isLoading,
    isInitialized,
    isSaving,
    isSettingsValid,
    activeConfigProvider,
    
    // Getters
    isDarkTheme,
    canTranslate,
    sourceLanguage,
    targetLanguage,
    selectedProvider,
    getEffectiveProvider,
    fontFamily,
    fontSize,
    
    // Actions
    loadSettings,
    saveAllSettings,
    updateSettingLocally,
    updateSettingAndPersist,
    updateMultipleSettings,
    resetSettings,
    exportSettings,
    importSettings,
    getSetting,
    validateSettings,
    reconcileOcrLanguage,
    cleanupStoreResources,
    $reset
  }
})

export default useSettingsStore

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import browser from 'webextension-polyfill'
import { CONFIG, TranslationMode, SelectionTranslationMode } from '@/shared/config/config.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js'
import secureStorage from '@/shared/storage/core/SecureStorage.js'
import { storageManager } from '@/shared/storage/core/StorageCore.js'
import { DESKTOP_FAB_EXCLUSION_PREFIX, DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY, serializeDesktopFabExclusions, parseDesktopFabExclusionsSection, replaceDesktopFabExclusions } from '@/features/desktop-fab/desktopFabExclusions.js'
import ExtensionContextManager from '@/core/extensionContext.js'
import { runSettingsMigrations } from '@/shared/config/settingsMigrations.js'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js'
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js'
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js'
import { getFirstMissingSetting } from '@/features/translation/utils/providerValidator.js'
import {
  DEEPL_LANGUAGE_CATALOG_TTL_MS,
  fetchDeepLLanguageCatalogWithKeyFailover,
  getCachedDeepLLanguageCatalog,
  getDeepLEligibleKeys,
  getDeepLLanguageIdentity,
  matchDeepLLanguage,
  MissingDeepLLanguageKeyError,
  SupersededDeepLLanguageDiscoveryError,
} from '@/features/translation/providers/DeepLLanguageDiscovery.js'
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
const logger = getScopedLogger(LOG_COMPONENTS.SETTINGS, 'settings');

export const DEEPL_SOURCE_UNSUPPORTED_ERROR = 'validation_deepl_source_language_unsupported';
export const DEEPL_TARGET_UNSUPPORTED_ERROR = 'validation_deepl_target_language_unsupported';

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

function normalizeProviderCategoryCollapseState(value) {
  const ids = Array.isArray(value) ? value : value?.ids
  return {
    ids: Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))] : [],
    revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0
  }
}

export const useSettingsStore = defineStore('settings', () => {
  // State - complete settings object with CONFIG defaults
  const settings = ref(getDefaultSettings())
  let providerCategoryIntentQueue = Promise.resolve()
  const dirtySettingVersions = new Map()
  let nextSettingEditVersion = 0
  let windowShowOriginalEditVersion = 0
  let windowShowOriginalWriteQueue = Promise.resolve()
  let windowShowOriginalPendingWrites = 0
  // Serializes durable-storage confirmation of WINDOW_SHOW_ORIGINAL
  // notifications so out-of-order events cannot apply in reverse.
  let windowShowOriginalSyncQueue = Promise.resolve()
  const apiKeySettingKeys = new Set([
    'API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'REQUESTY_API_KEY',
    'CHEAPERINFERENCE_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'CUSTOM_API_KEY', 'DEEPL_API_KEY'
  ])
  const settingDraftGroups = [
    ['GEMINI_MODEL', 'GEMINI_MODEL_SOURCE', 'GEMINI_API_URL'],
    ['OPENAI_API_MODEL', 'OPENAI_MODEL_SOURCE'],
    ['OPENROUTER_API_MODEL', 'OPENROUTER_MODEL_SOURCE'],
    ['REQUESTY_API_MODEL'],
    ['CHEAPERINFERENCE_API_MODEL'],
    ['DEEPSEEK_API_MODEL', 'DEEPSEEK_MODEL_SOURCE'],
    ['WEBAI_API_MODEL']
  ]
  const settingDraftGroupByKey = new Map(
    settingDraftGroups.flatMap(group => group.map(key => [key, group]))
  )
  const isSettingDirty = (key) => {
    if (dirtySettingVersions.has(key)) return true
    return settingDraftGroupByKey.get(key)?.some(groupKey => dirtySettingVersions.has(groupKey)) || false
  }
  
  // Loading states
  const isLoading = ref(false)
  const isInitialized = ref(false)
  const isSaving = ref(false)
  const isSettingsValid = ref(true) // Global validation state for options UI

  // Volatile capability snapshot: deliberately separate from `settings` so
  // catalogs can never enter persisted/exported settings.
  const deepLLanguageCapabilities = ref({
    status: 'idle', identity: null, catalog: null, fetchedAt: null, error: null
  })
  let deepLLanguageRequest = null
  let deepLLanguageRequestVersion = 0

  const invalidateDeepLLanguageCapabilities = () => {
    deepLLanguageRequestVersion += 1
    deepLLanguageRequest?.controller.abort()
    deepLLanguageRequest = null
    deepLLanguageCapabilities.value = {
      status: 'idle', identity: null, catalog: null, fetchedAt: null, error: null
    }
  }

  // Invalidate immediately on every draft/load/import/reset credential or
  // tier change; the Options navigation owns debounced network refreshes.
  watch(() => [
    settings.value.DEEPL_API_KEY,
    settings.value.DEEPL_API_TIER,
    settings.value.PROXY_ENABLED,
    settings.value.PROXY_TYPE,
    settings.value.PROXY_HOST,
    settings.value.PROXY_PORT,
    settings.value.PROXY_USERNAME,
    settings.value.PROXY_PASSWORD,
  ], invalidateDeepLLanguageCapabilities, { flush: 'sync' })

  const refreshDeepLLanguageCapabilities = async ({ forProvider } = {}) => {
    const provider = forProvider === undefined ? settings.value.TRANSLATION_API : forProvider
    const tier = settings.value.DEEPL_API_TIER === 'pro' ? 'pro' : 'free'
    const configuredKeys = settings.value.DEEPL_API_KEY || ''
    // Snapshot the current Options draft; discovery makes its own detached
    // canonical copy and never persists draft proxy credentials.
    const proxySettings = {
      PROXY_ENABLED: settings.value.PROXY_ENABLED,
      PROXY_TYPE: settings.value.PROXY_TYPE,
      PROXY_HOST: settings.value.PROXY_HOST,
      PROXY_PORT: settings.value.PROXY_PORT,
      PROXY_USERNAME: settings.value.PROXY_USERNAME,
      PROXY_PASSWORD: settings.value.PROXY_PASSWORD,
    }

    // Explicit mode consumers can request DeepL without changing the primary
    // provider. Other providers do not invalidate a usable DeepL snapshot.
    if (provider !== ProviderRegistryIds.DEEPL) {
      return deepLLanguageCapabilities.value
    }

    if (getFirstMissingSetting(ProviderRegistryIds.DEEPL, settings.value)) {
      invalidateDeepLLanguageCapabilities()
      deepLLanguageCapabilities.value = {
        status: 'missing-key', identity: null, catalog: null, fetchedAt: null, error: null
      }
      return deepLLanguageCapabilities.value
    }

    let identity
    try {
      identity = getDeepLLanguageIdentity(configuredKeys, tier)
    } catch (error) {
      if (error instanceof MissingDeepLLanguageKeyError) {
        invalidateDeepLLanguageCapabilities()
        deepLLanguageCapabilities.value = {
          status: 'missing-key', identity: null, catalog: null, fetchedAt: null, error: null
        }
        return deepLLanguageCapabilities.value
      }
      throw error
    }

    const current = deepLLanguageCapabilities.value
    const age = current.fetchedAt === null ? Infinity : Date.now() - current.fetchedAt
    if (current.status === 'ready' && current.identity === identity
      && age >= 0 && age < DEEPL_LANGUAGE_CATALOG_TTL_MS) {
      return current
    }
    if (deepLLanguageRequest?.identity === identity) return deepLLanguageRequest.promise

    // A failover success is cached under the succeeding key's identity, which
    // differs from the first-key request identity: serve any fresh eligible
    // cache entry before spending network work.
    for (const eligibleKey of getDeepLEligibleKeys(configuredKeys, tier)) {
      let cached = null
      try {
        cached = getCachedDeepLLanguageCatalog(eligibleKey, tier)
      } catch {
        cached = null
      }
      if (cached) {
        deepLLanguageCapabilities.value = {
          status: 'ready', identity: cached.identity, catalog: cached.catalog,
          fetchedAt: cached.fetchedAt, error: null,
        }
        return deepLLanguageCapabilities.value
      }
    }

    deepLLanguageRequest?.controller.abort()
    const controller = new AbortController()
    const requestVersion = ++deepLLanguageRequestVersion
    deepLLanguageCapabilities.value = {
      status: 'loading', identity, catalog: null, fetchedAt: null, error: null
    }
    const request = { identity, controller, version: requestVersion, promise: null }
    deepLLanguageRequest = request
    request.promise = (async () => {
      try {
        const snapshot = await fetchDeepLLanguageCatalogWithKeyFailover({
          apiKey: configuredKeys,
          apiTier: tier,
          signal: controller.signal,
          proxySettings,
        })
        // The snapshot carries the succeeding key's identity after failover,
        // so staleness is membership in the current eligible identities.
        const currentEligibleIdentities = new Set()
        for (const eligibleKey of getDeepLEligibleKeys(settings.value.DEEPL_API_KEY || '', settings.value.DEEPL_API_TIER)) {
          try {
            currentEligibleIdentities.add(getDeepLLanguageIdentity(eligibleKey, settings.value.DEEPL_API_TIER))
          } catch {
            // Skip keys that lost eligibility mid-flight.
          }
        }
        const stillCurrent = deepLLanguageRequest === request
          && request.version === deepLLanguageRequestVersion
          && currentEligibleIdentities.has(snapshot.identity)
        if (!stillCurrent) return deepLLanguageCapabilities.value
        deepLLanguageCapabilities.value = {
          status: 'ready', identity: snapshot.identity, catalog: snapshot.catalog,
          fetchedAt: snapshot.fetchedAt, error: null
        }
        return deepLLanguageCapabilities.value
      } catch (error) {
        if (deepLLanguageRequest !== request || request.version !== deepLLanguageRequestVersion) {
          return deepLLanguageCapabilities.value
        }
        const status = error instanceof MissingDeepLLanguageKeyError ? 'missing-key' : 'error'
        const errorType = error instanceof SupersededDeepLLanguageDiscoveryError
          ? 'superseded'
          : error?.name === 'AbortError'
            ? 'aborted'
            : 'fetch-failed'
        deepLLanguageCapabilities.value = {
          status, identity, catalog: null, fetchedAt: null,
          error: status === 'error' ? errorType : null
        }
        return deepLLanguageCapabilities.value
      } finally {
        if (deepLLanguageRequest === request) deepLLanguageRequest = null
      }
    })()
    return request.promise
  }
  
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
    invalidateDeepLLanguageCapabilities()
    isLoading.value = true;
    __loadInFlight = (async () => {
      try {
        const windowShowOriginalVersionAtLoadStart = windowShowOriginalEditVersion
        const stored = await storageManager.get(null);
        const current = settings.value;

        // Storage is authoritative during load; discard draft tracking from any
        // earlier, uninitialized state before applying the persisted snapshot.
        dirtySettingVersions.clear()

  
        // Merge settings from storage (after potential migrations)
        Object.keys(current).forEach(key => {
          if (Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined
            && (key !== 'WINDOW_SHOW_ORIGINAL' || windowShowOriginalVersionAtLoadStart === windowShowOriginalEditVersion)) {
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
      const savedSettingVersions = new Map(dirtySettingVersions)
      const snapshot = buildPersistedSnapshot(settings.value)
      // These settings are never persisted through a full snapshot, so an
      // unrelated save can never overwrite the live durable copy:
      // - COLLAPSED_PROVIDER_CATEGORIES is owned by the background serializer.
      // - WINDOW_SHOW_ORIGINAL is a window-owned preference; a snapshot taken
      //   before a later toggle and committed after it would clobber the
      //   newest value. Local changes persist through the dedicated write
      //   queue (narrow toggles and explicit updates), external changes are
      //   validated against durable storage, and importSettings restores the
      //   key explicitly after Save.
      delete snapshot.COLLAPSED_PROVIDER_CATEGORIES
      delete snapshot.WINDOW_SHOW_ORIGINAL
      await storageManager.set(snapshot);
      for (const [key, version] of savedSettingVersions) {
        if (dirtySettingVersions.get(key) === version) dirtySettingVersions.delete(key)
      }
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
    if (apiKeySettingKeys.has(key) || settingDraftGroupByKey.has(key)) {
      dirtySettingVersions.set(key, ++nextSettingEditVersion)
    }
  }

  const enqueueProviderCategoryIntent = (intent) => {
    const operation = providerCategoryIntentQueue.then(intent)
    providerCategoryIntentQueue = operation.catch(() => {})
    return operation
  }

  const setProviderCategoryCollapsed = (categoryId, collapsed) => {
    return enqueueProviderCategoryIntent(async () => {
      const response = await browser.runtime.sendMessage({
        action: MessageActions.SET_PROVIDER_CATEGORY_COLLAPSED,
        categoryId,
        collapsed
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to save provider category state')
      const next = normalizeProviderCategoryCollapseState(response.state)
      const current = normalizeProviderCategoryCollapseState(settings.value.COLLAPSED_PROVIDER_CATEGORIES)
      if (next.revision > current.revision) settings.value.COLLAPSED_PROVIDER_CATEGORIES = next
      return settings.value.COLLAPSED_PROVIDER_CATEGORIES
    })
  }

  const replaceProviderCategoryCollapseState = (ids) => {
    return enqueueProviderCategoryIntent(async () => {
      const response = await browser.runtime.sendMessage({
        action: MessageActions.SET_PROVIDER_CATEGORY_COLLAPSED,
        replace: true,
        ids
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to save provider category state')
      const next = normalizeProviderCategoryCollapseState(response.state)
      const current = normalizeProviderCategoryCollapseState(settings.value.COLLAPSED_PROVIDER_CATEGORIES)
      if (next.revision > current.revision) settings.value.COLLAPSED_PROVIDER_CATEGORIES = next
      return settings.value.COLLAPSED_PROVIDER_CATEGORIES
    })
  }

  // Window-owned preference (`WINDOW_SHOW_ORIGINAL`): every local write for
  // this key is serialized through one queue so overlapping writes can never
  // commit out of order. The value is captured at enqueue time so each action
  // persists its own intent; full snapshots never carry this key, and the
  // explicit import restore enqueues behind pending narrow writes.
  // Pending count: our queued write represents the latest local intent; a
  // concurrently observed (possibly stale) storage notification for this key
  // must not clobber it before the write commits.
  const queueWindowShowOriginalWrite = (writeFactory) => {
    windowShowOriginalPendingWrites += 1
    const write = windowShowOriginalWriteQueue.catch(() => {}).then(writeFactory)
    windowShowOriginalWriteQueue = write
    void write.then(
      () => {
        windowShowOriginalPendingWrites -= 1
        // A missed notification is reconciled once the queue settles.
        runWindowShowOriginalReconciliation()
      },
      () => {
        windowShowOriginalPendingWrites -= 1
        // The write never landed: reconcile against durable storage so local
        // state does not stay permanently divergent.
        requestWindowShowOriginalReconciliation()
      }
    )
    return write
  }
  const enqueueWindowShowOriginalWrite = (value) => (
    queueWindowShowOriginalWrite(() => storageManager.set({ WINDOW_SHOW_ORIGINAL: value }))
  )

  // Action to update a single setting and immediately persist it to storage
  const updateSettingAndPersist = async (key, value) => {
    try {
      if (key === 'COLLAPSED_PROVIDER_CATEGORIES') {
        throw new Error('Use setProviderCategoryCollapsed to update category state')
      }
      settings.value[key] = value // Update local state
      if (key === 'WINDOW_SHOW_ORIGINAL') windowShowOriginalEditVersion += 1
      
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
      if (key === 'WINDOW_SHOW_ORIGINAL') {
        await enqueueWindowShowOriginalWrite(filtered.WINDOW_SHOW_ORIGINAL)
      } else {
        await storageManager.set(filtered)
      }
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
      if (Object.prototype.hasOwnProperty.call(updates || {}, 'COLLAPSED_PROVIDER_CATEGORIES')) {
        throw new Error('Use setProviderCategoryCollapsed to update category state')
      }
      // Update local state (all keys, including non-schema runtime keys)
      Object.assign(settings.value, updates)

      // Narrow write: persist only the canonical keys from this update.
      // Unrelated canonical settings already in state are NOT rewritten, which
      // removes the concurrent-overwrite window of a whole-snapshot write.
      // An empty result skips the storage round-trip (set({}) writes nothing
      // and emits no events); local state and the true return are unaffected.
      const filtered = buildPersistedSnapshot(updates || {})
      // Window-owned preference: an explicit multi-update for this key joins
      // the same serialized queue as narrow toggles so it can never commit
      // out of order over the latest preference.
      let windowShowOriginalWrite = null
      if (Object.prototype.hasOwnProperty.call(filtered, 'WINDOW_SHOW_ORIGINAL')) {
        windowShowOriginalEditVersion += 1
        windowShowOriginalWrite = enqueueWindowShowOriginalWrite(filtered.WINDOW_SHOW_ORIGINAL)
        delete filtered.WINDOW_SHOW_ORIGINAL
      }
      if (Object.keys(filtered).length === 0) {
        if (windowShowOriginalWrite) await windowShowOriginalWrite
        return true
      }
      await storageManager.set(filtered)
      // Keep "persisted before resolve" semantics for the window-owned key too.
      if (windowShowOriginalWrite) await windowShowOriginalWrite

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
      const defaults = getDefaultSettings();
      // Window-owned preference: intent ordering is captured at Reset
      // initiation — the reserved slot joins the serialized queue
      // synchronously, so a toggle issued while Reset performs its async
      // work lands after it (the toggle supersedes Reset), while an older
      // pending toggle lands before it (Reset supersedes the toggle). The
      // actual default write is gated behind the prerequisite storage
      // operations: if they fail, the reservation is cancelled and the
      // preference is left untouched while the queue keeps draining.
      const windowShowOriginalEditAtReset = windowShowOriginalEditVersion
      // Non-rejecting cancellation: the gate resolves with a cancellation
      // sentinel instead of rejecting, so cancelling the reservation can
      // never cause an unhandled rejection — even when an earlier queued
      // write keeps the reserved slot from running yet.
      const windowShowOriginalResetCancelledMarker = Symbol('window-show-original-reset-cancelled')
      let proceedWindowShowOriginalReset
      const windowShowOriginalResetGate = new Promise((resolve) => {
        proceedWindowShowOriginalReset = resolve
      })
      const windowShowOriginalResetWrite = queueWindowShowOriginalWrite(async () => {
        if (await windowShowOriginalResetGate === windowShowOriginalResetCancelledMarker) return false // Cancelled reservation: the preference is left untouched.
        return storageManager.set({ WINDOW_SHOW_ORIGINAL: defaults.WINDOW_SHOW_ORIGINAL })
      })
      invalidateDeepLLanguageCapabilities()
      let storedSettings
      try {
        storedSettings = await storageManager.get(null)
        // WINDOW_SHOW_ORIGINAL is window-owned: broad reset writes must not
        // bypass its serialized write queue, so its removal is deferred to
        // the reserved default write above.
        const keysToRemove = Object.keys(storedSettings || {})
          .filter(key => key !== 'COLLAPSED_PROVIDER_CATEGORIES' && key !== 'WINDOW_SHOW_ORIGINAL')
        if (keysToRemove.length > 0) await storageManager.remove(keysToRemove)
      } catch (error) {
        // Cancel the reserved default write without touching the preference.
        // The gate fulfils with the cancellation sentinel (never rejects), so
        // the queue slot releases and later toggles keep flowing; Reset's
        // error propagates immediately without waiting behind pending writes.
        proceedWindowShowOriginalReset(windowShowOriginalResetCancelledMarker)
        throw error
      }
      proceedWindowShowOriginalReset(true)
      // A toggle issued during Reset's async work owns the newest intent:
      // keep its local value instead of letting the defaults replacement
      // clobber it (storage settles the same way through the queue).
      const newerWindowShowOriginalEdit = windowShowOriginalEditVersion !== windowShowOriginalEditAtReset
      const newerWindowShowOriginalValue = settings.value.WINDOW_SHOW_ORIGINAL
      // Preserve reference to reactive object
      Object.keys(settings.value).forEach(k => delete settings.value[k]);
      Object.assign(settings.value, defaults);
      if (newerWindowShowOriginalEdit) settings.value.WINDOW_SHOW_ORIGINAL = newerWindowShowOriginalValue
      // A Reset that applies its preference invalidates older in-flight
      // reconciliations, which would otherwise apply a stale durable read.
      // The reset is the newer intent even when the resulting value is
      // unchanged, so the version always advances. A Reset cancelled before
      // applying its preference never reaches this point.
      windowShowOriginalEditVersion += 1
      dirtySettingVersions.clear()
      // Persist canonical settings only; translation history is store-owned
      // feature data and is already cleared with storage above.
      const persistedDefaults = getPersistedDefaultSettings()
      delete persistedDefaults.COLLAPSED_PROVIDER_CATEGORIES
      delete persistedDefaults.WINDOW_SHOW_ORIGINAL
      // Keep "persisted before resolve" semantics: Reset resolves only after
      // its queued default write settles.
      await windowShowOriginalResetWrite
      await storageManager.set(persistedDefaults);
      await replaceProviderCategoryCollapseState([])
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

      const fabExclusions = await serializeDesktopFabExclusions();

      return {
        ...exportData,
        [DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY]: fabExclusions,
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
      invalidateDeepLLanguageCapabilities()

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

      const hasFabExclusionsSection = Object.prototype.hasOwnProperty.call(importData, DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY);
      // Validate before any storage mutation; throws on malformed data.
      const importedFabExclusions = hasFabExclusionsSection
        ? parseDesktopFabExclusionsSection(importData[DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY])
        : null;

      const processedSettings = await secureStorage.processImportedSettings(importData, password);
      Object.keys(processedSettings).forEach(key => {
        if (key.startsWith(DESKTOP_FAB_EXCLUSION_PREFIX)) delete processedSettings[key];
      });
      delete processedSettings[DESKTOP_FAB_EXCLUSIONS_EXPORT_KEY];
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
      const importedCollapseIds = normalizeProviderCategoryCollapseState(
        mergedSettings.COLLAPSED_PROVIDER_CATEGORIES
      ).ids
      // A backup's collapse revision is not authoritative. Keep the live
      // revision until the background serializer returns its current value.
      mergedSettings.COLLAPSED_PROVIDER_CATEGORIES = normalizeProviderCategoryCollapseState(
        settings.value.COLLAPSED_PROVIDER_CATEGORIES
      )
      
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
      // An import that applies its preference invalidates older in-flight
      // reconciliations, which would otherwise apply a stale durable read. The
      // import is the newer intent even when the resulting value is unchanged.
      windowShowOriginalEditVersion += 1
      dirtySettingVersions.clear()

      await saveAllSettings();
      // Explicit full-state import: restore the window-owned preference too,
      // serialized behind queued narrow writes through the shared queue.
      await enqueueWindowShowOriginalWrite(settings.value.WINDOW_SHOW_ORIGINAL)
      await replaceProviderCategoryCollapseState(importedCollapseIds)
      if (removals.length > 0) {
        try {
          await storageManager.remove(removals);
        } catch (error) {
          if (ExtensionContextManager.isContextError(error)) throw error;
          logger.warn('[Import] Obsolete settings cleanup failed');
        }
      }

      if (importedFabExclusions !== null) {
        await replaceDesktopFabExclusions(importedFabExclusions);
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

    // 1b. DeepL validation is synchronous and consumes only a fresh snapshot
    // for the current draft identity; validation never starts network work.
    if (settings.value.TRANSLATION_API === ProviderRegistryIds.DEEPL) {
      const configuredKeys = settings.value.DEEPL_API_KEY || ''
      const tier = settings.value.DEEPL_API_TIER === 'pro' ? 'pro' : 'free'
      const missingKey = getFirstMissingSetting(ProviderRegistryIds.DEEPL, settings.value)
      if (!missingKey) {
        // Validation accepts a fresh snapshot for any currently eligible key,
        // since capability discovery fails over to the first succeeding key.
        const eligibleIdentities = new Set(
          getDeepLEligibleKeys(configuredKeys, tier).map(key => getDeepLLanguageIdentity(key, tier)),
        )
        const capability = deepLLanguageCapabilities.value
        const age = capability.fetchedAt === null ? Infinity : Date.now() - capability.fetchedAt
        const isFresh = capability.status === 'ready'
          && eligibleIdentities.has(capability.identity)
          && age >= 0 && age < DEEPL_LANGUAGE_CATALOG_TTL_MS
          && Array.isArray(capability.catalog)

        if (eligibleIdentities.size === 0) {
          errors.push('ERRORS_API_CONFIG_INVALID')
        } else if (!isFresh) {
          errors.push('validation_deepl_languages_unverified')
        } else {
          const checkLanguage = (language, direction, errorKey) => {
            if (!language || (direction === 'source' && language === 'auto')) return
            const match = matchDeepLLanguage(capability.catalog, language, direction)
            if (match === 'unknown') {
              if (!errors.includes('validation_deepl_languages_unverified')) {
                errors.push('validation_deepl_languages_unverified')
              }
              return
            }
            if (match === 'unsupported') {
              errors.push(`${errorKey}:${language}`)
            }
          }
          checkLanguage(sLang, 'source', DEEPL_SOURCE_UNSUPPORTED_ERROR)
          checkLanguage(tLang, 'target', DEEPL_TARGET_UNSUPPORTED_ERROR)
        }
      }
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
    invalidateDeepLLanguageCapabilities()
    settings.value = getDefaultSettings()
    dirtySettingVersions.clear()
    isInitialized.value = false
    isLoading.value = false
    isSaving.value = false
  }
    
  // Storage change listener
  let storageListener = null

  // A storage notification carries no ordering evidence, so a delayed event
  // from an already-superseded older write can arrive after our writes settle
  // for this key. Confirm a differing value against durable storage before
  // applying it: the notification is trusted only when it still matches what
  // storage holds right now, otherwise it is dropped as a stale echo. Our own
  // writes keep durable storage in sync, so legitimate external updates
  // (which match durable storage) still apply.
  const validateWindowShowOriginalNotification = (notifiedValue) => {
    // The notification is only applied while the local intent is unchanged: a
    // newer local intent (toggle, Reset, Import) that completes while the
    // durable read is in flight owns the preference and must not be
    // overwritten by the stale confirmation.
    const intentVersion = windowShowOriginalEditVersion
    const operation = windowShowOriginalSyncQueue.then(async () => {
      if (typeof notifiedValue !== 'boolean') return
      if (notifiedValue === settings.value.WINDOW_SHOW_ORIGINAL) return
      if (windowShowOriginalPendingWrites > 0) return
      const stored = await storageManager.getFresh('WINDOW_SHOW_ORIGINAL')
      if (stored?.WINDOW_SHOW_ORIGINAL !== notifiedValue) return
      // New writes may have started while the confirmation was in flight.
      if (windowShowOriginalPendingWrites > 0) return
      // A newer local intent won while the confirmation was in flight.
      if (windowShowOriginalEditVersion !== intentVersion) return
      settings.value.WINDOW_SHOW_ORIGINAL = notifiedValue
    })
    // Confirmation failures are swallowed in the chain itself: the last
    // applied value is kept and later events re-validate from storage.
    const settled = operation.catch(() => {})
    windowShowOriginalSyncQueue = settled
    return settled
  }

  // A notification that arrives while a local write is pending is dropped so
  // it cannot clobber the latest local intent — but a cross-tab change must
  // not be lost. The version of the local intent at that moment is remembered
  // and reconciled against fresh durable storage once the queue settles: the
  // newest local edit always wins, and durable storage decides everything
  // else (so stale echoes are ignored as well).
  let windowShowOriginalReconcileVersion = -1

  const requestWindowShowOriginalReconciliation = () => {
    windowShowOriginalReconcileVersion = windowShowOriginalEditVersion
    return runWindowShowOriginalReconciliation()
  }

  const runWindowShowOriginalReconciliation = () => {
    if (windowShowOriginalReconcileVersion < 0) return
    if (windowShowOriginalPendingWrites > 0) return
    const expectedVersion = windowShowOriginalReconcileVersion
    windowShowOriginalReconcileVersion = -1
    const operation = windowShowOriginalSyncQueue.then(async () => {
      if (windowShowOriginalPendingWrites > 0) return
      // A newer local edit owns the value; its own write keeps storage in sync.
      if (windowShowOriginalEditVersion !== expectedVersion) return
      const stored = await storageManager.getFresh('WINDOW_SHOW_ORIGINAL')
      if (windowShowOriginalPendingWrites > 0) return
      if (windowShowOriginalEditVersion !== expectedVersion) return
      const durable = stored?.WINDOW_SHOW_ORIGINAL
      // A failed first write can leave durable storage without this key: the
      // canonical default is the authoritative value in that case, so the local
      // state does not keep an intent that was never persisted.
      const resolved = durable === undefined || durable === null
        ? getDefaultSettings().WINDOW_SHOW_ORIGINAL
        : durable
      if (typeof resolved !== 'boolean') return
      if (resolved === settings.value.WINDOW_SHOW_ORIGINAL) return
      settings.value.WINDOW_SHOW_ORIGINAL = resolved
    })
    const settled = operation.catch(() => {})
    windowShowOriginalSyncQueue = settled
    return settled
  }

  // Handle storage changes from other parts of extension
  const handleStorageChange = ({ key, newValue, oldValue }) => {
    if (key === 'COLLAPSED_PROVIDER_CATEGORIES') {
      const next = normalizeProviderCategoryCollapseState(newValue)
      const current = normalizeProviderCategoryCollapseState(settings.value.COLLAPSED_PROVIDER_CATEGORIES)
      if (next.revision > current.revision) settings.value.COLLAPSED_PROVIDER_CATEGORIES = next
      return
    }
    if (key === 'WINDOW_SHOW_ORIGINAL') {
      // While a queued write is still pending it represents the latest local
      // intent: drop concurrently observed (possibly stale) notifications for
      // this key before any durable-storage confirmation. The dropped event is
      // not lost — it is reconciled against durable storage once the queue
      // settles (unless a newer local edit supersedes it).
      if (windowShowOriginalPendingWrites > 0) {
        requestWindowShowOriginalReconciliation()
        return
      }
      validateWindowShowOriginalNotification(newValue)
      return
    }
    // Keep local API-key/model-setting drafts until Save succeeds, while allowing
    // clean provider groups and unrelated settings to sync independently.
    if (apiKeySettingKeys.has(key) ? dirtySettingVersions.has(key) : isSettingDirty(key)) return

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
    invalidateDeepLLanguageCapabilities()
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
    deepLLanguageCapabilities,
    
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
    refreshDeepLLanguageCapabilities,
    saveAllSettings,
    updateSettingLocally,
    setProviderCategoryCollapsed,
    isSettingDirty,
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

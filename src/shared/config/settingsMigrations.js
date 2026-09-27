/**
 * Settings Migration System
 *
 * Handles automatic migrations for user settings when the extension is updated.
 *
 * Responsibilities:
 * 1. Add newly introduced settings with their default values.
 * 2. Migrate legacy setting formats and keys.
 * 3. Synchronize configuration-driven option lists.
 * 4. Apply safe prompt template migrations.
 * 5. Preserve user data, API keys, history, and customizations.
 *
 * Prompt migration details and historical prompt defaults are maintained in:
 *   promptHistoricalDefaults.js
 *
 * Migration is executed during extension update and settings import flows.
 */

import { CONFIG, TranslationMode } from './config.js';
import { PROMPT_REGISTRY } from './PromptRegistry.js';
import { getPersistedDefaultSettings } from './settingsDefaults.js';
import { HISTORICAL_PROMPT_DEFAULTS } from './promptHistoricalDefaults.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { LIVE_DUBBING_PROVIDER_ID, LIVE_DUBBING_PROVIDER_IDS } from '@/features/live-dubbing/constants.js';
import { normalizeLiveDubbingVolume } from '@/features/live-dubbing/contracts.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONFIG, 'SettingsMigrations');

const MODEL_VALUE_MIGRATIONS = {
  OPENAI_MODELS: {
    'gpt-5.6-luna': 'gpt-6-luna',
    'gpt-4o-mini': 'gpt-6-luna',
    'o1-mini': 'gpt-6-luna',
    'o3-mini': 'gpt-6-luna',
    'gpt-5.6-terra': 'gpt-6-sol',
    'gpt-5.6-sol': 'gpt-6-sol',
    o1: 'gpt-6-sol',
    'gpt-4.5-preview': 'gpt-6-sol',
    'chatgpt-4o-latest': 'gpt-6-sol',
    'gpt-4o': 'gpt-6-sol'
  },
  DEEPSEEK_MODELS: {
    'deepseek-chat': 'deepseek-v4-flash',
    'deepseek-reasoner': 'deepseek-v4-flash'
  },
  GEMINI_MODELS: {
    'gemini-3.7-flash': 'gemini-3.8-flash',
    'gemini-3.6-flash': 'gemini-3.8-flash',
    'gemini-3.5-flash': 'gemini-3.8-flash',
    'gemini-3.1-pro-preview': 'gemini-3.8-flash',
    'gemini-3-flash-preview': 'gemini-3.8-flash',
    'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
    'gemini-3-pro-preview': 'gemini-3.8-flash',
    'gemini-2.5-pro': 'gemini-3.8-flash',
    'gemini-2.5-flash': 'gemini-3.8-flash',
    'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite'
  }
};

const DEEPSEEK_THINKING_MODE_MIGRATIONS = {
  'deepseek-chat': 'disabled',
  'deepseek-reasoner': 'high'
};

const OBSOLETE_MICROSOFT_EDGE_SETTING_KEYS = [
  'MICROSOFT_EDGE_AUTH_URL',
  'MICROSOFT_EDGE_TRANSLATE_URL'
];

/**
 * Migrate the former ambiguous Ctrl trigger to the platform-aware primary modifier.
 */
function migrateMouseHoverTrigger(currentSettings, updates, migrationLog) {
  if (currentSettings.MOUSE_HOVER_TRIGGER !== 'ctrl') return;

  updates.MOUSE_HOVER_TRIGGER = 'primary';
  migrationLog.push('Migrated MOUSE_HOVER_TRIGGER from ctrl to primary');
}

/**
 * Normalize an explicitly stored Live Dubbing provider without affecting
 * unrelated translation-provider settings. Missing values are filled by the
 * canonical persisted-default pass below.
 */
function normalizeLiveDubbingProvider(currentSettings, updates, migrationLog) {
  if (!Object.prototype.hasOwnProperty.call(currentSettings, 'LIVE_DUBBING_PROVIDER')) return;
  if (LIVE_DUBBING_PROVIDER_IDS.includes(currentSettings.LIVE_DUBBING_PROVIDER)) return;

  updates.LIVE_DUBBING_PROVIDER = LIVE_DUBBING_PROVIDER_ID;
  migrationLog.push(`Normalized LIVE_DUBBING_PROVIDER to ${LIVE_DUBBING_PROVIDER_ID}`);
}

/**
 * Normalize the persisted popup view to one of the supported views.
 * Missing values are filled by the canonical persisted-default pass below.
 */
function normalizePopupActiveView(currentSettings, updates, migrationLog) {
  if (!Object.prototype.hasOwnProperty.call(currentSettings, 'POPUP_ACTIVE_VIEW')) return;
  if (['translate', 'live-dubbing'].includes(currentSettings.POPUP_ACTIVE_VIEW)) return;

  updates.POPUP_ACTIVE_VIEW = 'translate';
  migrationLog.push('Normalized POPUP_ACTIVE_VIEW to translate');
}

/**
 * Normalize explicitly stored Live Dubbing volume preferences. Malformed
 * values fall back to their persisted defaults (Original 0, Dubbed 1)
 * without affecting unrelated settings. Missing values are filled by the
 * canonical persisted-default pass below.
 */
function normalizeLiveDubbingVolumes(currentSettings, updates, migrationLog) {
  const volumeKeys = [
    ['LIVE_DUBBING_ORIGINAL_VOLUME', 0],
    ['LIVE_DUBBING_DUBBED_VOLUME', 1],
  ];
  for (const [key, fallback] of volumeKeys) {
    if (!Object.prototype.hasOwnProperty.call(currentSettings, key)) continue;
    const normalized = normalizeLiveDubbingVolume(currentSettings[key], fallback);
    if (normalized !== currentSettings[key]) {
      updates[key] = normalized;
      migrationLog.push(`Normalized ${key} to ${normalized}`);
    }
  }
}

/**
 * Remove internal Microsoft Edge endpoint overrides from older installations.
 * The provider now owns one canonical endpoint and exposes no custom endpoint setting.
 */
function removeObsoleteMicrosoftEdgeSettings(currentSettings, removals, migrationLog) {
  OBSOLETE_MICROSOFT_EDGE_SETTING_KEYS.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(currentSettings, key)) return;

    removals.push(key);
    migrationLog.push(`Removed obsolete setting: ${key}`);
  });
}

/**
 * Determine whether a value is a plain object.
 *
 * Only plain objects are candidates for recursive nested migration. Arrays,
 * RegExp, Date, Map, Set, functions, null and primitives are treated as
 * leaves and are never merged into.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Add-only deep merge of nested default members into a persisted object.
 *
 * Returns a complete merged object when at least one member of `defaultValue`
 * is missing from `storedValue`, otherwise `null`.
 *
 * Semantics:
 * - Existing persisted members are never overwritten (add-only).
 * - Recursion descends only when BOTH values are plain objects.
 * - Cross-type values are never replaced or recursed into.
 * - Arrays, RegExp and other non-plain values are leaves.
 * - `false`, `0`, empty strings and null-like user values are preserved.
 * - Neither input is mutated.
 */
export function mergeMissingNestedMembers(storedValue, defaultValue) {
  if (!isPlainObject(storedValue) || !isPlainObject(defaultValue)) return null;

  const merged = {};
  let changed = false;

  Object.keys(storedValue).forEach(key => {
    merged[key] = storedValue[key];
  });

  Object.keys(defaultValue).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(storedValue, key)) {
      merged[key] = defaultValue[key];
      changed = true;
    } else {
      const nested = mergeMissingNestedMembers(storedValue[key], defaultValue[key]);
      if (nested !== null) {
        merged[key] = nested;
        changed = true;
      }
    }
  });

  return changed ? merged : null;
}

/**
 * Migrate MODE_PROVIDERS keys from old format (underscore) to new format (hyphenated/MessageContexts)
 */
function migrateModeProviderKeys(currentSettings, updates, migrationLog) {
  if (!currentSettings.MODE_PROVIDERS) return;

  const providers = { ...currentSettings.MODE_PROVIDERS };
  let changed = false;

  // Mapping of old keys to new keys using standard TranslationMode constants
  const MAPPING = {
    'select_element': TranslationMode.Select_Element,
    'popup_translate': TranslationMode.Popup_Translate,
    'sidepanel_translate': TranslationMode.Sidepanel_Translate,
    'screen_capture': TranslationMode.ScreenCapture,
    'screen-capture': TranslationMode.ScreenCapture,
    'selection': TranslationMode.Selection,
    'field': TranslationMode.Field,
    'page': TranslationMode.Page
  };

  Object.entries(MAPPING).forEach(([oldKey, newKey]) => {
    if (oldKey in providers && providers[oldKey] !== undefined && providers[oldKey] !== null) {
      // Always migrate old value to new key if new key is missing or null
      if (!(newKey in providers) || providers[newKey] === null) {
        providers[newKey] = providers[oldKey];
        migrationLog.push(`Migrated MODE_PROVIDERS.${oldKey} to ${newKey}`);
        changed = true;
      }
      // Always delete the old legacy key regardless
      delete providers[oldKey];
      changed = true;
    } else if (oldKey in providers) {
      // Just delete the old key if it's undefined or null
      delete providers[oldKey];
      changed = true;
    }
  });

  if (changed) {
    updates.MODE_PROVIDERS = providers;
  }
}

/**
 * Migrate BILINGUAL_TRANSLATION_MODES keys from old format to new format
 */
function migrateBilingualModeKeys(currentSettings, updates, migrationLog) {
  if (!currentSettings.BILINGUAL_TRANSLATION_MODES) return;

  const modes = { ...currentSettings.BILINGUAL_TRANSLATION_MODES };
  let changed = false;

  const MAPPING = {
    'select_element': TranslationMode.Select_Element,
    'popup_translate': TranslationMode.Popup_Translate,
    'sidepanel_translate': TranslationMode.Sidepanel_Translate,
    'screen_capture': TranslationMode.ScreenCapture,
    'screen-capture': TranslationMode.ScreenCapture,
    'selection': TranslationMode.Selection,
    'field': TranslationMode.Field,
    'page': TranslationMode.Page,
    'dictionary': TranslationMode.Dictionary_Translation
  };

  Object.entries(MAPPING).forEach(([oldKey, newKey]) => {
    if (oldKey in modes && modes[oldKey] !== undefined && modes[oldKey] !== null) {
      if (!(newKey in modes) || modes[newKey] === null) {
        modes[newKey] = modes[oldKey];
        migrationLog.push(`Migrated BILINGUAL_TRANSLATION_MODES.${oldKey} to ${newKey}`);
        changed = true;
      }
      delete modes[oldKey];
      changed = true;
    } else if (oldKey in modes) {
      delete modes[oldKey];
      changed = true;
    }
  });

  if (changed) {
    updates.BILINGUAL_TRANSLATION_MODES = modes;
  }
}

/**
 * Main migration function - handles all settings updates
 */
function runMainMigration(currentSettings) {
  const updates = {};
  const migrationLog = [];

  // Canonical persisted-settings schema — the single source of which keys
  // belong in storage. New persisted keys here automatically become migration
  // targets; CONFIG-only runtime constants are excluded by not appearing here.
  const persistedDefaults = getPersistedDefaultSettings();

  // Migrate Mode Provider keys first to ensure new structure is used
  migrateModeProviderKeys(currentSettings, updates, migrationLog);

  // Migrate legacy Mouse Hover trigger values before filling missing defaults.
  migrateMouseHoverTrigger(currentSettings, updates, migrationLog);

  // Normalize only an explicitly stored invalid provider. Missing values are
  // handled by the generic persisted-default migration below.
  normalizeLiveDubbingProvider(currentSettings, updates, migrationLog);

  // Normalize explicitly stored invalid popup views; missing values are filled
  // by the generic persisted-default migration below.
  normalizePopupActiveView(currentSettings, updates, migrationLog);

  // Normalize explicitly stored invalid volume preferences; missing values
  // are filled by the generic persisted-default migration below.
  normalizeLiveDubbingVolumes(currentSettings, updates, migrationLog);
  
  // Migrate Bilingual Mode keys
  migrateBilingualModeKeys(currentSettings, updates, migrationLog);

  // 1. List of settings that should NOT be auto-migrated (User sensitive data)
  const DO_NOT_MIGRATE = [
    'translationHistory',    // User data
    'EXCLUDED_SITES',        // User's custom exclusions
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'REQUESTY_API_KEY',
    'DEEPSEEK_API_KEY',
    'DEEPL_API_KEY',
    'CUSTOM_API_KEY',
    'GEMINI_API_KEY',        // New multi-key setting
    'PROXY_USERNAME',        // Credentials
    'PROXY_PASSWORD'
  ];

  // 2. Dynamic Model Detection
  // Automatically identifies all _MODELS lists and their corresponding selection keys
  const modelListKeys = Object.keys(CONFIG).filter(key => key.endsWith('_MODELS'));
  const MODEL_MAPPING = {};
  
  modelListKeys.forEach(listKey => {
    const provider = listKey.replace('_MODELS', '');
    // Preference: [PROVIDER]_API_MODEL, fallback: [PROVIDER]_MODEL
    const modelKey = `${provider}_API_MODEL` in CONFIG ? `${provider}_API_MODEL` : `${provider}_MODEL`;
    if (modelKey in CONFIG) {
      MODEL_MAPPING[listKey] = modelKey;
    }
  });

  // 3. Dynamic Prompt Detection
  // Automatically identifies all editable prompt templates from the registry
  const PROMPT_TEMPLATES = Object.values(PROMPT_REGISTRY)
    .filter(p => p.editable)
    .map(p => p.key);

  // Non-editable prompt wrappers are CONFIG-owned implementation defaults and
  // are absent from persistedDefaults. Keep registry-derived keys only for
  // legacy storage cleanup below.
  const NON_EDITABLE_PROMPT_KEYS = Object.values(PROMPT_REGISTRY)
    .filter(p => !p.editable)
    .map(p => p.key);

  // 4. Synchronized Option Lists (UI Options that should always match CONFIG)
  const OPTION_LISTS = [
    'FONT_SIZE_OPTIONS',
    'DEEPL_API_TIER_OPTIONS',
    'DEEPL_FORMALITY_OPTIONS'
  ];

  // --- Start Migration Process ---

  // A. Check for missing settings and add them
  Object.keys(persistedDefaults).forEach(key => {
    if (DO_NOT_MIGRATE.includes(key)) return;
    if (!(key in currentSettings)) {
      updates[key] = persistedDefaults[key];
      migrationLog.push(`Added missing setting: ${key}`);
    } else if (!(key in updates)) {
      // Backfill missing nested members for existing settings. The merge
      // helper is the single owner of mergeability validation (plain object,
      // cross-type, leaf values) and returns null when not applicable.
      // Skips keys already updated by earlier passes (e.g. MODE_PROVIDERS/BILINGUAL remaps).
      const merged = mergeMissingNestedMembers(currentSettings[key], persistedDefaults[key]);
      if (merged !== null) {
        updates[key] = merged;
        migrationLog.push(`Added missing nested members for ${key}`);
      }
    }
  });

  // Migrate and remove the legacy Gemini thinking toggle.
  const thinkingMode = currentSettings.GEMINI_THINKING_MODE;
  if (thinkingMode !== 'default' && thinkingMode !== 'minimal') {
    const migratedThinkingMode = Object.prototype.hasOwnProperty.call(currentSettings, 'GEMINI_THINKING_MODE')
      ? 'default'
      : currentSettings.GEMINI_THINKING_ENABLED === true ? 'minimal' : 'default';
    updates.GEMINI_THINKING_MODE = migratedThinkingMode;
    migrationLog.push(`Migrated GEMINI_THINKING_MODE to ${migratedThinkingMode}`);
  }

  const deepseekThinkingMode = currentSettings.DEEPSEEK_THINKING_MODE;
  const supportedDeepSeekThinkingModes = CONFIG.DEEPSEEK_THINKING_MODE_OPTIONS.map(option => option.value);
  if (!supportedDeepSeekThinkingModes.includes(deepseekThinkingMode)) {
    updates.DEEPSEEK_THINKING_MODE = CONFIG.DEEPSEEK_THINKING_MODE;
    migrationLog.push(`Migrated DEEPSEEK_THINKING_MODE to ${CONFIG.DEEPSEEK_THINKING_MODE}`);
  }

  // A2. Legacy storage cleanup: non-editable prompt wrappers were persisted by
  // older versions. Remove leftover copies so storage no longer carries them.
  const removals = currentSettings
    ? NON_EDITABLE_PROMPT_KEYS.filter(key => key in currentSettings)
    : [];
  if (removals.length > 0) {
    removals.forEach(key => {
      migrationLog.push(`Removing obsolete stored prompt wrapper: ${key}`);
    });
  }

  removeObsoleteMicrosoftEdgeSettings(currentSettings, removals, migrationLog);
  if (Object.prototype.hasOwnProperty.call(currentSettings, 'GEMINI_THINKING_ENABLED')) {
    removals.push('GEMINI_THINKING_ENABLED');
    migrationLog.push('Removing obsolete stored setting: GEMINI_THINKING_ENABLED');
  }

  // B. Handle model lists - Dynamic update & reset if model removed
  Object.entries(MODEL_MAPPING).forEach(([modelListKey, currentModelKey]) => {
    const hasStoredModelList = modelListKey in currentSettings;
    const currentUserModel = currentSettings[currentModelKey];
    const isLegacyDeepSeekModelWithoutList = modelListKey === 'DEEPSEEK_MODELS'
      && Object.prototype.hasOwnProperty.call(MODEL_VALUE_MIGRATIONS[modelListKey], currentUserModel);
    if (!hasStoredModelList && !isLegacyDeepSeekModelWithoutList) return;

    const newModels = CONFIG[modelListKey];
    const modelIsActive = newModels.some(model => model.value === currentUserModel);
    const explicitReplacement = modelIsActive
      ? undefined
      : MODEL_VALUE_MIGRATIONS[modelListKey]?.[currentUserModel];
    const modelListChanged = hasStoredModelList
      && JSON.stringify(currentSettings[modelListKey]) !== JSON.stringify(newModels);

    if (explicitReplacement) {
      updates[currentModelKey] = explicitReplacement;
      migrationLog.push(`Migrated ${currentModelKey} from ${currentUserModel} to ${explicitReplacement}`);

      const migratedThinkingMode = modelListKey === 'DEEPSEEK_MODELS'
        ? DEEPSEEK_THINKING_MODE_MIGRATIONS[currentUserModel]
        : undefined;
      if (migratedThinkingMode) {
        updates.DEEPSEEK_THINKING_MODE = migratedThinkingMode;
        migrationLog.push(`Migrated DEEPSEEK_THINKING_MODE to ${migratedThinkingMode}`);
      }
    }

    if (modelListChanged) {
      updates[modelListKey] = newModels;
      migrationLog.push(`Updated ${modelListKey} list`);
    }

    const modelToValidate = explicitReplacement || currentUserModel;
    const modelStillExists = newModels.some(model => model.value === modelToValidate);
    const supportsCustomModels = newModels.some(model => model.value === 'custom');

    // Preserve arbitrary model IDs only for providers that expose custom models.
    const hasUsableModelValue = typeof currentUserModel === 'string' && currentUserModel.trim().length > 0;
    if (!explicitReplacement && (!hasUsableModelValue || (!modelStillExists && !supportsCustomModels))) {
      updates[currentModelKey] = CONFIG[currentModelKey];
      migrationLog.push(`Reset ${currentModelKey} (previous model no longer available)`);
    }
  });

  // C. Handle prompt templates - safe update using historical defaults

  PROMPT_TEMPLATES.forEach(key => {
    const defaultPrompt = CONFIG[key];

    // Safety check: skip if key doesn't exist in CONFIG
    if (defaultPrompt === undefined) {
      logger.warn(`Prompt key ${key} is defined in registry but missing in CONFIG.`);
      return;
    }

    // 1. If key is completely missing in user settings, add it
    if (!(key in currentSettings)) {
      updates[key] = defaultPrompt;
      migrationLog.push(`Added missing prompt setting: ${key}`);
      return;
    }

    const userPrompt = currentSettings[key];

    // 2. If stored prompt is empty or null, restore it to current default
    if (!userPrompt || userPrompt.toString().trim() === '') {
      updates[key] = defaultPrompt;
      migrationLog.push(`Restored empty/missing prompt ${key} to default`);
      return;
    }

    // 3. If stored prompt exactly matches current default, leave it
    if (userPrompt === defaultPrompt) {
      return;
    }

    // 4. If stored prompt matches a known historical default, upgrade to current default
    const historicals = HISTORICAL_PROMPT_DEFAULTS[key] || [];
    const isHistorical = historicals.some(entry =>
      typeof entry === 'string'
        ? entry === userPrompt
        : entry?.value === userPrompt
    );
    
    if (isHistorical) {
      updates[key] = defaultPrompt;
      migrationLog.push(`Upgraded legacy default prompt ${key} to latest version`);
      return;
    }

    // 5. Otherwise, treat as user-customized and preserve
    logger.debug(`Preserved user customized prompt: ${key}`);
  });

  // D. Synchronize Option Lists
  OPTION_LISTS.forEach(key => {
    if (key in CONFIG && key in currentSettings) {
      if (JSON.stringify(currentSettings[key]) !== JSON.stringify(CONFIG[key])) {
        updates[key] = CONFIG[key];
        migrationLog.push(`Synchronized ${key}`);
      }
    }
  });

  // E. Handle legacy API_KEY migration to GEMINI_API_KEY
  if ('API_KEY' in currentSettings && currentSettings.API_KEY && currentSettings.API_KEY.trim() !== '') {
    if (!currentSettings.GEMINI_API_KEY || currentSettings.GEMINI_API_KEY.trim() === '') {
      updates.GEMINI_API_KEY = currentSettings.API_KEY;
      migrationLog.push(`Migrated API_KEY to GEMINI_API_KEY (multi-key support)`);
    }
    updates.API_KEY = '';
    migrationLog.push(`Removed deprecated API_KEY setting`);
  }

  if (migrationLog.length > 0) {
    logger.debug('Auto-migration completed', {
      addedCount: Object.keys(updates).length,
      migrations: migrationLog
    });
  }

  return { updates, migrationLog, removals };
}


/**
 * Run settings migrations - always checks for missing/updated settings.
 *
 * PURE · DECLARATIVE: computes migration decisions only. It never reads/writes
 * browser storage. The caller (persistence owner) applies `updates` and
 * `removals` to the persisted settings.
 *
 * @param {object} currentSettings Current persisted settings
 * @returns {Promise<{updates: object, removals: string[], logs: string[]>}}
 */
export async function runSettingsMigrations(currentSettings) {
  logger.info('Running settings migrations check');

  const allUpdates = {};
  const allLogs = [];
  const allRemovals = [];

  // Always run main migration to check for missing/updated settings
  const { updates, migrationLog, removals = [] } = runMainMigration(currentSettings);
  Object.assign(allUpdates, updates);
  allLogs.push(...migrationLog);
  allRemovals.push(...removals);

  logger.debug('Settings migrations completed', {
    updatesCount: Object.keys(allUpdates).length,
    logs: allLogs
  });

  return { updates: allUpdates, logs: allLogs, removals: allRemovals };
}

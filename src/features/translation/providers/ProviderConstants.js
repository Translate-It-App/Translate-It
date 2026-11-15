/**
 * Provider Constants
 *
 * Centralized provider identifier constants to avoid hardcoded strings
 * and prevent typos/type mismatches across the codebase.
 *
 * Usage:
 *   import { ProviderNames } from '@/features/translation/providers/ProviderConstants.js';
 *
 *   if (this.providerName === ProviderNames.DEEPL_TRANSLATE) {
 *     // Handle DeepL-specific logic
 *   }
 */

/**
 * Provider Name Constants
 * These are the exact strings passed to super() in each provider constructor
 */
export const ProviderNames = {
  // Traditional Translation Services
  GOOGLE_TRANSLATE: 'GoogleTranslate',
  GOOGLE_TRANSLATE_V2: 'GoogleTranslateV2',
  DEEPL_TRANSLATE: 'DeepLTranslate',
  YANDEX_TRANSLATE: 'YandexTranslate',
  BING_TRANSLATE: 'BingTranslate',
  MICROSOFT_EDGE: 'MicrosoftEdge',
  LINGVA: 'Lingva',

  // AI Services
  GEMINI: 'Gemini',
  OPENAI: 'OpenAI',
  DEEPSEEK: 'DeepSeek',
  OPENROUTER: 'OpenRouter',
  REQUESTY: 'Requesty',
  CHEAPERINFERENCE: 'CheaperInference',
  WEBAI: 'WebAI',

  // Browser & Custom
  BROWSER_API: 'browserTranslate',
  VAJEHYAB: 'Vajehyab',
  CUSTOM: 'Custom',
  MOCK: 'MockProvider',

  // Legacy aliases (for backward compatibility)
  DEEPL: 'DeepLTranslate', // Same as DEEPL_TRANSLATE
  GOOGLE: 'GoogleTranslate', // Same as GOOGLE_TRANSLATE
};

/**
 * Provider Registry IDs
 * These are the IDs used in the provider registry (lowercase, shorter names)
 */
export const ProviderRegistryIds = {
  GOOGLE: 'google',
  GOOGLE_V2: 'googlev2',
  DEEPL: 'deepl',
  YANDEX: 'yandex',
  BING: 'bing',
  EDGE: 'edge',
  LINGVA: 'lingva',
  GEMINI: 'gemini',
  OPENAI: 'openai',
  DEEPSEEK: 'deepseek',
  OPENROUTER: 'openrouter',
  REQUESTY: 'requesty',
  CHEAPERINFERENCE: 'cheaperinference',
  WEBAI: 'webai',
  BROWSER: 'browser',
  VAJEHYAB: 'vajehyab',
  CUSTOM: 'custom',
  MOCK: 'mock',
};

/**
 * Provider Type Constants
 */
export const ProviderTypes = {
  TRANSLATE: 'translate',
  AI: 'ai',
  NATIVE: 'native',
  CUSTOM: 'custom',
  MOCK: 'mock',
};

export const TranslationCallPurpose = Object.freeze({
  PRIMARY_TRANSLATION: 'PRIMARY_TRANSLATION',
  STRUCTURED_RECOVERY: 'STRUCTURED_RECOVERY',
  PARENT_RECOVERY: 'PARENT_RECOVERY',
});

/**
 * Helper function to check if provider name matches
 * @param {string} providerName - The provider name to check
 * @param {string} expectedName - The expected provider name constant
 * @returns {boolean}
 */
export function isProvider(providerName, expectedName) {
  return providerName === expectedName;
}

/**
 * Helper function to check if provider is of type
 * @param {string} providerName - The provider name
 * @param {string} type - The provider type
 * @returns {boolean}
 */
export function isProviderType(providerName, type) {
  // Map provider names to their types
  const providerTypeMap = {
    [ProviderNames.GOOGLE_TRANSLATE]: ProviderTypes.TRANSLATE,
    [ProviderNames.GOOGLE_TRANSLATE_V2]: ProviderTypes.TRANSLATE,
    [ProviderNames.DEEPL_TRANSLATE]: ProviderTypes.TRANSLATE,
    [ProviderNames.YANDEX_TRANSLATE]: ProviderTypes.TRANSLATE,
    [ProviderNames.BING_TRANSLATE]: ProviderTypes.TRANSLATE,
    [ProviderNames.MICROSOFT_EDGE]: ProviderTypes.TRANSLATE,
    [ProviderNames.LINGVA]: ProviderTypes.TRANSLATE,
    [ProviderNames.GEMINI]: ProviderTypes.AI,
    [ProviderNames.OPENAI]: ProviderTypes.AI,
    [ProviderNames.DEEPSEEK]: ProviderTypes.AI,
    [ProviderNames.OPENROUTER]: ProviderTypes.AI,
    [ProviderNames.REQUESTY]: ProviderTypes.AI,
    [ProviderNames.CHEAPERINFERENCE]: ProviderTypes.AI,
    [ProviderNames.WEBAI]: ProviderTypes.AI,
    [ProviderNames.BROWSER_API]: ProviderTypes.NATIVE,
    [ProviderNames.VAJEHYAB]: ProviderTypes.TRANSLATE,
    [ProviderNames.CUSTOM]: ProviderTypes.CUSTOM,
    [ProviderNames.MOCK]: ProviderTypes.MOCK,
  };
  return providerTypeMap[providerName] === type;
}

/**
 * Map registry ID to provider name
 * @param {string} registryId - The registry ID
 * @returns {string|null} - The provider name or null if not found
 */
export function registryIdToName(registryId) {
  const idToNameMap = {
    [ProviderRegistryIds.GOOGLE]: ProviderNames.GOOGLE_TRANSLATE,
    [ProviderRegistryIds.GOOGLE_V2]: ProviderNames.GOOGLE_TRANSLATE_V2,
    [ProviderRegistryIds.DEEPL]: ProviderNames.DEEPL_TRANSLATE,
    [ProviderRegistryIds.YANDEX]: ProviderNames.YANDEX_TRANSLATE,
    [ProviderRegistryIds.BING]: ProviderNames.BING_TRANSLATE,
    [ProviderRegistryIds.EDGE]: ProviderNames.MICROSOFT_EDGE,
    [ProviderRegistryIds.LINGVA]: ProviderNames.LINGVA,
    [ProviderRegistryIds.GEMINI]: ProviderNames.GEMINI,
    [ProviderRegistryIds.OPENAI]: ProviderNames.OPENAI,
    [ProviderRegistryIds.DEEPSEEK]: ProviderNames.DEEPSEEK,
    [ProviderRegistryIds.OPENROUTER]: ProviderNames.OPENROUTER,
    [ProviderRegistryIds.REQUESTY]: ProviderNames.REQUESTY,
    [ProviderRegistryIds.CHEAPERINFERENCE]: ProviderNames.CHEAPERINFERENCE,
    [ProviderRegistryIds.WEBAI]: ProviderNames.WEBAI,
    [ProviderRegistryIds.BROWSER]: ProviderNames.BROWSER_API,
    [ProviderRegistryIds.VAJEHYAB]: ProviderNames.VAJEHYAB,
    [ProviderRegistryIds.CUSTOM]: ProviderNames.CUSTOM,
    [ProviderRegistryIds.MOCK]: ProviderNames.MOCK,
  };
  return idToNameMap[registryId] || null;
}

/**
 * Map provider name to registry ID
 * @param {string} providerName - The provider name
 * @returns {string|null} - The registry ID or null if not found
 */
export function nameToRegistryId(providerName) {
  const nameToIdMap = {
    [ProviderNames.GOOGLE_TRANSLATE]: ProviderRegistryIds.GOOGLE,
    [ProviderNames.GOOGLE_TRANSLATE_V2]: ProviderRegistryIds.GOOGLE_V2,
    [ProviderNames.DEEPL_TRANSLATE]: ProviderRegistryIds.DEEPL,
    [ProviderNames.YANDEX_TRANSLATE]: ProviderRegistryIds.YANDEX,
    [ProviderNames.BING_TRANSLATE]: ProviderRegistryIds.BING,
    [ProviderNames.MICROSOFT_EDGE]: ProviderRegistryIds.EDGE,
    [ProviderNames.LINGVA]: ProviderRegistryIds.LINGVA,
    [ProviderNames.GEMINI]: ProviderRegistryIds.GEMINI,
    [ProviderNames.OPENAI]: ProviderRegistryIds.OPENAI,
    [ProviderNames.DEEPSEEK]: ProviderRegistryIds.DEEPSEEK,
    [ProviderNames.OPENROUTER]: ProviderRegistryIds.OPENROUTER,
    [ProviderNames.REQUESTY]: ProviderRegistryIds.REQUESTY,
    [ProviderNames.CHEAPERINFERENCE]: ProviderRegistryIds.CHEAPERINFERENCE,
    [ProviderNames.WEBAI]: ProviderRegistryIds.WEBAI,
    [ProviderNames.BROWSER_API]: ProviderRegistryIds.BROWSER,
    [ProviderNames.VAJEHYAB]: ProviderRegistryIds.VAJEHYAB,
    [ProviderNames.CUSTOM]: ProviderRegistryIds.CUSTOM,
    [ProviderNames.MOCK]: ProviderRegistryIds.MOCK,
  };
  return nameToIdMap[providerName] || null;
}

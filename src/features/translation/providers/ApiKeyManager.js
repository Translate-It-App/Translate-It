/**
 * ApiKeyManager - Centralized API key management with failover support
 *
 * Responsibilities:
 * - Parse newline-separated API keys into arrays
 * - Get primary key (first in list)
 * - Move successful key to front of list
 * - Check if error should trigger failover
 * - Test all keys and reorder them (valid keys first)
 */

import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { resolveProxyConfig } from '@/shared/proxy/ProxySettings.js';
import { CONFIG, getDeeplApiTierAsync } from '@/shared/config/config.js';
import { ProviderRegistryIds } from './ProviderConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'ApiKeyManager');
const DEEPL_FREE_USAGE_URL = 'https://api-free.deepl.com/v2/usage';
const DEEPL_PRO_USAGE_URL = 'https://api.deepl.com/v2/usage';

function isValidDeepLUsagePayload(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Number.isInteger(payload.character_count)
    && payload.character_count >= 0
    && Number.isInteger(payload.character_limit)
    && payload.character_limit >= 0;
}

/**
 * Settings key mapping for each provider
 */
const PROVIDER_SETTINGS_KEYS = {
  OPENAI: 'OPENAI_API_KEY',
  GEMINI: 'API_KEY',
  DEEPSEEK: 'DEEPSEEK_API_KEY',
  OPENROUTER: 'OPENROUTER_API_KEY',
  REQUESTY: 'REQUESTY_API_KEY',
  DEEPL: 'DEEPL_API_KEY',
  CUSTOM: 'CUSTOM_API_KEY'
};

/**
 * Provider names for API testing
 */
const PROVIDER_NAMES = {
  OPENAI: 'OpenAI',
  GEMINI: 'Gemini',
  DEEPSEEK: 'DeepSeek',
  OPENROUTER: 'OpenRouter',
  REQUESTY: 'Requesty',
  DEEPL: 'DeepL',
  CUSTOM: 'Custom'
};

/**
 * Failover error types that should trigger key rotation
 */
const FAILOVER_ERROR_TYPES = new Set([
  ErrorTypes.API_KEY_INVALID,
  ErrorTypes.INSUFFICIENT_BALANCE,
  ErrorTypes.QUOTA_EXCEEDED,
  ErrorTypes.RATE_LIMIT_REACHED,
  ErrorTypes.DEEPL_QUOTA_EXCEEDED
]);

class ApiKeyManager {
  /**
   * Parse API key string into array of keys
   * @param {string} keyString - Newline-separated keys
   * @returns {string[]} - Array of trimmed, non-empty keys
   */
  static parseKeys(keyString) {
    if (!keyString || typeof keyString !== 'string') {
      return [];
    }
    const keys = keyString
      .split('\n')
      .map(key => key.trim())
      .filter(key => key.length > 0);

    if (keys.length > 1) {
      logger.debug('[ApiKeyManager] Parsed API keys', { count: keys.length });
    }

    return keys;
  }

  /**
   * Convert array of keys back to newline-separated string
   * @param {string[]} keys - Array of keys
   * @returns {string} - Newline-separated keys
   */
  static stringifyKeys(keys) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return '';
    }
    return keys.join('\n');
  }

  /**
   * Get all keys for a provider
   * @param {string} providerSettingKey - Settings key (e.g., 'OPENAI_API_KEY')
   * @returns {Promise<string[]>} - Array of keys
   */
  static async getKeys(providerSettingKey) {
    try {
      const result = await storageManager.get({ [providerSettingKey]: '' });
      const keyString = result[providerSettingKey] || '';

      const keys = this.parseKeys(keyString);
      logger.debug('[ApiKeyManager] Loaded API keys', {
        provider: providerSettingKey,
        count: keys.length
      });
      return keys;
    } catch {
      logger.error(`[ApiKeyManager] Failed to get keys for ${providerSettingKey}`);
      return [];
    }
  }

  /**
   * Get primary key (first in list)
   * @param {string} providerSettingKey - Settings key
   * @returns {Promise<string>} - First key or empty string
   */
  static async getPrimaryKey(providerSettingKey) {
    const keys = await this.getKeys(providerSettingKey);
    return keys.length > 0 ? keys[0] : '';
  }

  /**
   * Move key to front of list and save to storage
   * @param {string} providerSettingKey - Settings key
   * @param {string} key - Key to promote
   * @returns {Promise<void>}
   */
  static async promoteKey(providerSettingKey, key) {
    try {
      const keys = await this.getKeys(providerSettingKey);

      // Find and remove the key from its current position
      const index = keys.indexOf(key);
      if (index === -1) {
        logger.warn(`[ApiKeyManager] Key not found in list for ${providerSettingKey}, cannot promote`);
        return;
      }

      // Remove from current position
      keys.splice(index, 1);

      // Add to front
      keys.unshift(key);

      // Save back to storage
      const keyString = this.stringifyKeys(keys);
      await storageManager.set({ [providerSettingKey]: keyString });

      logger.debug(`[ApiKeyManager] Promoted key to front for ${providerSettingKey}`);
    } catch {
      logger.error(`[ApiKeyManager] Failed to promote key for ${providerSettingKey}`);
    }
  }

  /**
   * Check if error should trigger failover to next key
   * @param {Error} error - Error object
   * @returns {boolean} - True if error should trigger failover
   */
  static shouldFailover(error) {
    if (!error || !error.type) {
      return false;
    }
    return FAILOVER_ERROR_TYPES.has(error.type);
  }

  /**
   * Execute one validation request with a fresh proxy configuration snapshot.
   * @param {string} url - Request URL
   * @param {Object} options - Fetch options
   * @returns {Promise<Response>} - Validation response
   * @private
   */
  static async _fetchWithCurrentProxy(url, options = {}) {
    const proxyConfig = await resolveProxyConfig();
    const { proxyManager } = await import('@/shared/proxy/ProxyManager.js');
    return proxyManager.fetch(url, options, proxyConfig);
  }

  /**
   * Test all keys for validity and reorder them
   * @param {string} providerSettingKey - Settings key
   * @param {string} providerId - Provider registry ID for testing
   * @returns {Promise<Object>} - Test result with valid, invalid arrays and allInvalid flag
   */
  static async testAndReorderKeys(providerSettingKey, providerId) {
    const keys = await this.getKeys(providerSettingKey);

    if (providerId === ProviderRegistryIds.CUSTOM) {
      const result = await this._testCustomKeys(keys);
      if (result.reorderedString !== undefined) {
        await storageManager.set({ [providerSettingKey]: result.reorderedString });
      }
      return result;
    }

    if (keys.length === 0) {
      return {
        valid: [],
        invalid: [],
        allInvalid: true,
        messageKey: 'api_test_no_keys'
      };
    }

    const deepLContext = providerId === ProviderRegistryIds.DEEPL
      ? { apiTier: await getDeeplApiTierAsync() }
      : {};

    // Import provider classes dynamically
    const providerTests = {
      [ProviderRegistryIds.OPENAI]: async (key) => await this._testOpenAIKey(key),
      [ProviderRegistryIds.GEMINI]: async (key) => await this._testGeminiKey(key),
      [ProviderRegistryIds.DEEPSEEK]: async (key) => await this._testDeepSeekKey(key),
      [ProviderRegistryIds.OPENROUTER]: async (key) => await this._testOpenRouterKey(key),
      [ProviderRegistryIds.REQUESTY]: async (key) => await this._testRequestyKey(key),
      [ProviderRegistryIds.DEEPL]: async (key) => await this._testDeepLKey(key, deepLContext),
      [ProviderRegistryIds.CUSTOM]: async (key) => await this._testCustomKey(key)
    };

    const testFunc = providerTests[providerId];
    if (!testFunc) {
      return {
        valid: [],
        invalid: keys,
        allInvalid: true,
        messageKey: 'api_test_unknown_provider',
        params: { provider: providerId }
      };
    }

    // Test all keys in parallel
    const testPromises = keys.map(async (key) => {
      try {
        const isValid = await testFunc(key);
        return { key, isValid };
      } catch (error) {
        logger.debug(`[ApiKeyManager] Key test failed for ${providerId}`, {
          errorType: error instanceof Error ? 'Error' : typeof error
        });
        return { key, isValid: false };
      }
    });

    const results = await Promise.all(testPromises);

    // Separate valid and invalid keys
    const valid = results.filter(r => r.isValid).map(r => r.key);
    const invalid = results.filter(r => !r.isValid).map(r => r.key);

    // Reorder: valid keys first, then invalid keys
    const reorderedKeys = [...valid, ...invalid];
    const keyString = this.stringifyKeys(reorderedKeys);
    await storageManager.set({ [providerSettingKey]: keyString });

    // Return message key and params for Vue component to translate
    const messageKey = valid.length > 0 ? 'api_test_result_partial' : 'api_test_result_all_invalid';
    const params = valid.length > 0
      ? { valid: valid.length, invalid: invalid.length }
      : { count: invalid.length };

    return {
      valid,
      invalid,
      allInvalid: valid.length === 0,
      messageKey,
      params
    };
  }

  /**
   * Test keys directly from provided value (without reading from storage)
   * @param {string} keysString - Keys string (one per line)
   * @param {string} providerId - Provider registry ID for testing
   * @param {Object} [context={}] - Optional additional context (e.g., custom URL/Model or DeepL API tier)
   * @returns {Promise<Object>} - Test result with valid, invalid arrays and allInvalid flag
   */
  static async testKeysDirect(keysString, providerId, context = {}) {
    // Parse keys from string
    const keys = this.parseKeys(keysString);

    if (providerId === ProviderRegistryIds.CUSTOM) {
      return this._testCustomKeys(keys, context);
    }

    if (keys.length === 0) {
      return {
        valid: [],
        invalid: [],
        allInvalid: true,
        messageKey: 'api_test_no_keys'
      };
    }

    // Import provider classes dynamically
    const providerTests = {
      [ProviderRegistryIds.OPENAI]: async (key) => await this._testOpenAIKey(key, context),
      [ProviderRegistryIds.GEMINI]: async (key) => await this._testGeminiKey(key, context),
      [ProviderRegistryIds.DEEPSEEK]: async (key) => await this._testDeepSeekKey(key, context),
      [ProviderRegistryIds.OPENROUTER]: async (key) => await this._testOpenRouterKey(key, context),
      [ProviderRegistryIds.REQUESTY]: async (key) => await this._testRequestyKey(key, context),
      [ProviderRegistryIds.DEEPL]: async (key) => await this._testDeepLKey(key, context),
      [ProviderRegistryIds.CUSTOM]: async (key) => await this._testCustomKey(key, context)
    };

    const testFunc = providerTests[providerId];
    if (!testFunc) {
      return {
        valid: [],
        invalid: keys,
        allInvalid: true,
        messageKey: 'api_test_unknown_provider',
        params: { provider: providerId }
      };
    }

    // Test all keys in parallel
    const testPromises = keys.map(async (key) => {
      try {
        const isValid = await testFunc(key);
        return { key, isValid };
      } catch (error) {
        logger.debug(`[ApiKeyManager] Key test failed for ${providerId}`, {
          errorType: error instanceof Error ? 'Error' : typeof error
        });
        return { key, isValid: false };
      }
    });

    const results = await Promise.all(testPromises);

    // Separate valid and invalid keys
    const valid = results.filter(r => r.isValid).map(r => r.key);
    const invalid = results.filter(r => !r.isValid).map(r => r.key);

    // Return message key and params for Vue component to translate
    const messageKey = valid.length > 0 ? 'api_test_result_partial' : 'api_test_result_all_invalid';
    const params = valid.length > 0
      ? { valid: valid.length, invalid: invalid.length }
      : { count: invalid.length };

    return {
      valid,
      invalid,
      allInvalid: valid.length === 0,
      messageKey,
      params,
      reorderedString: [...valid, ...invalid].join('\n')
    };
  }

  static async _testCustomKeys(keys, context = {}) {
    if (keys.length === 0) {
      const result = await this._testCustomConnection('', context);
      if (result.reason === 'missing_config') {
        return {
          valid: [],
          invalid: [],
          allInvalid: true,
          messageKey: 'api_test_custom_config_missing'
        };
      }
      if (result.reason === 'model_not_found') {
        return {
          valid: [],
          invalid: [],
          allInvalid: true,
          messageKey: 'api_test_custom_model_not_found',
          params: { model: result.model }
        };
      }
      if (result.valid) {
        return {
          valid: [],
          invalid: [],
          allInvalid: false,
          messageKey: 'api_test_custom_connection_success'
        };
      }
      return {
        valid: [],
        invalid: [],
        allInvalid: true,
        messageKey: 'api_test_custom_connection_failed'
      };
    }

    const results = await Promise.all(keys.map(async (key) => ({
      key,
      result: await this._testCustomConnection(key, context)
    })));
    const valid = results.filter(({ result }) => result.valid).map(({ key }) => key);
    const invalid = results.filter(({ result }) => !result.valid).map(({ key }) => key);
    const firstFailure = results.find(({ result }) => !result.valid)?.result;

    return {
      valid,
      invalid,
      allInvalid: valid.length === 0,
      messageKey: valid.length > 0
        ? 'api_test_result_partial'
        : firstFailure?.reason === 'missing_config'
          ? 'api_test_custom_config_missing'
        : firstFailure?.reason === 'model_not_found'
          ? 'api_test_custom_model_not_found'
          : 'api_test_result_all_invalid',
      params: valid.length > 0
        ? { valid: valid.length, invalid: invalid.length }
        : firstFailure?.reason === 'missing_config'
          ? undefined
        : firstFailure?.reason === 'model_not_found'
          ? { model: firstFailure.model }
          : { count: invalid.length },
      reorderedString: [...valid, ...invalid].join('\n')
    };
  }

  /**
   * Test OpenAI API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testOpenAIKey(key, context = {}) {
    try {
      const apiUrl = context.apiUrl || 'https://api.openai.com/v1/models';
      const response = await this._fetchWithCurrentProxy(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test Gemini API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testGeminiKey(key, context = {}) {
    try {
      let apiUrl = context.apiUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
      
      // If a full endpoint was provided, try to get the base models URL
      if (apiUrl.includes(':generateContent')) {
        apiUrl = apiUrl.split(':generateContent')[0];
        // If it was a specific model URL like .../models/gemini-pro:generateContent
        // we want the parent .../models URL or just the models list
        if (apiUrl.includes('/models/')) {
          apiUrl = apiUrl.split('/models/')[0] + '/models';
        }
      } else if (!apiUrl.endsWith('/models') && !apiUrl.includes('/models/')) {
        // If it's just a base URL, append /models
        if (apiUrl.endsWith('/')) apiUrl += 'v1beta/models';
        else if (!apiUrl.includes('v1beta')) apiUrl += '/v1beta/models';
        else apiUrl += '/models';
      }
      
      const urlObj = new URL(apiUrl);
      urlObj.searchParams.set('key', key);
      
      const response = await this._fetchWithCurrentProxy(urlObj.toString(), { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test DeepSeek API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testDeepSeekKey(key, context = {}) {
    try {
      const apiUrl = context.apiUrl || 'https://api.deepseek.com/models';
      const response = await this._fetchWithCurrentProxy(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test OpenRouter API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testOpenRouterKey(key, context = {}) {
    try {
      // Use auth/key endpoint instead of models to properly validate the key
      // models endpoint is public and may return 200 even for invalid keys
      const apiUrl = context.apiUrl || 'https://openrouter.ai/api/v1/auth/key';
      const response = await this._fetchWithCurrentProxy(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/Translate-It-App/Translate-It',
          'X-Title': 'Translate-It Extension'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test Requesty API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testRequestyKey(key, context = {}) {
    try {
      // Authenticated models request returns 403 for an invalid key
      const apiUrl = context.apiUrl || 'https://router.requesty.ai/v1/models';
      const response = await this._fetchWithCurrentProxy(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/Translate-It-App/Translate-It',
          'X-Title': 'Translate-It Extension'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Test DeepL API key
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional validation context with API tier
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testDeepLKey(key, context = {}) {
    try {
      const requestedTier = context?.apiTier;
      const configuredTier = requestedTier === undefined
        ? await getDeeplApiTierAsync()
        : requestedTier;
      const apiTier = configuredTier === 'free' || configuredTier === 'pro'
        ? configuredTier
        : CONFIG.DEEPL_API_TIER;
      const apiUrl = typeof key === 'string' && key.endsWith(':fx')
        ? DEEPL_FREE_USAGE_URL
        : apiTier === 'pro'
          ? DEEPL_PRO_USAGE_URL
          : DEEPL_FREE_USAGE_URL;

      const response = await this._fetchWithCurrentProxy(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `DeepL-Auth-Key ${key}`
        }
      });
      if (!response.ok) return false;

      return isValidDeepLUsagePayload(await response.json());
    } catch {
      return false;
    }
  }

  /**
   * Test Custom API key
   * For custom provider, we use the provided context or fallback to storage
   * @param {string} key - API key to test
   * @param {Object} [context={}] - Optional context with URL and Model
   * @returns {Promise<boolean>} - True if key is valid
   * @private
   */
  static async _testCustomKey(key, context = {}) {
    return (await this._testCustomConnection(key, context)).valid;
  }

  static async _testCustomConnection(key, context = {}) {
    try {
      // Priority: use provided context values, fallback to storage
      let apiUrl = context.apiUrl;
      let apiModel = context.apiModel;

      if (!apiUrl || !apiModel) {
        const settings = await storageManager.get({
          CUSTOM_API_URL: '',
          CUSTOM_API_MODEL: ''
        });
        apiUrl = apiUrl || settings.CUSTOM_API_URL;
        apiModel = apiModel || settings.CUSTOM_API_MODEL;
      }

      if (!apiUrl?.trim() || !apiModel?.trim()) {
        return { valid: false, reason: 'missing_config' };
      }

      // Try to determine models endpoint
      let modelsUrl = apiUrl;
      if (apiUrl.endsWith('/chat/completions')) {
        modelsUrl = apiUrl.replace('/chat/completions', '/models');
      } else if (apiUrl.endsWith('/v1/chat/completions')) {
        modelsUrl = apiUrl.replace('/v1/chat/completions', '/v1/models');
      }

      const headers = {};
      if (key?.trim()) {
        headers.Authorization = `Bearer ${key}`;
      }

      try {
        // Try models endpoint first
        const response = await this._fetchWithCurrentProxy(modelsUrl, {
          method: 'GET',
          headers
        });

        if (response.status === 401 || response.status === 403) {
          return { valid: false, reason: 'authentication' };
        }

        if (response.ok) {
          try {
            const payload = await response.json();
            const modelIds = Array.isArray(payload?.data)
              && payload.data.every(model => model && typeof model.id === 'string')
              ? payload.data.map(model => model.id)
              : null;

            if (modelIds) {
              return modelIds.includes(apiModel)
                ? { valid: true }
                : { valid: false, reason: 'model_not_found', model: apiModel };
            }
          } catch {
            // Fall back to a minimal chat test when model metadata is unreadable.
          }
        }

        // Missing or nonstandard model metadata cannot prove model membership.
        const chatResponse = await this._fetchWithCurrentProxy(apiUrl, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: apiModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1
          })
        });

        if (chatResponse.status === 401 || chatResponse.status === 403) {
          return { valid: false, reason: 'authentication' };
        }

        return { valid: chatResponse.ok };
      } catch (err) {
        logger.error('[ApiKeyManager] Custom API test error', {
          errorType: err instanceof Error ? 'Error' : typeof err
        });
        return { valid: false, reason: 'request_failed' };
      }
    } catch (error) {
      logger.error('[ApiKeyManager] Custom API test failed', {
        errorType: error instanceof Error ? 'Error' : typeof error
      });
      return { valid: false, reason: 'request_failed' };
    }
  }

  /**
   * Get provider name from provider code
   * @param {string} providerCode - Provider code (e.g., 'OPENAI')
   * @returns {string} - Provider display name
   */
  static getProviderName(providerCode) {
    return PROVIDER_NAMES[providerCode] || providerCode;
  }

  /**
   * Get settings key from provider code
   * @param {string} providerCode - Provider code (e.g., 'OPENAI')
   * @returns {string} - Settings key
   */
  static getSettingsKey(providerCode) {
    return PROVIDER_SETTINGS_KEYS[providerCode];
  }
}

export { ApiKeyManager };

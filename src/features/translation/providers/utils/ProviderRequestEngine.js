/**
 * Provider Request Engine - Centralized logic for executing API requests
 * Handles headers, proxy, error normalization, and failover with API keys
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { getBrowserInfoSync } from "@/utils/browser/compatibility.js";
import { proxyManager } from "@/shared/proxy/ProxyManager.js";
import { statsManager } from '../../core/TranslationStatsManager.js';
import { ApiKeyManager } from "@/features/translation/providers/ApiKeyManager.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { matchErrorToType } from "@/shared/error-management/ErrorMatcher.js";
import { ProviderNames, TranslationCallPurpose } from "@/features/translation/providers/ProviderConstants.js";
import { appendTranslationDiagnostic } from '@/features/translation/ir/TranslationOperation.js';
import { rateLimitManager } from '@/features/translation/core/RateLimitManager.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'ProviderRequestEngine');

function normalizeCallPurpose(callPurpose) {
  return Object.values(TranslationCallPurpose).includes(callPurpose)
    ? callPurpose
    : TranslationCallPurpose.PRIMARY_TRANSLATION;
}

const REFINABLE_ERROR_TYPES = new Set([
  ErrorTypes.TRANSLATION_ERROR,
  ErrorTypes.TRANSLATION_FAILED,
  ErrorTypes.UNKNOWN,
]);

function isAuthoritativeErrorType(error) {
  const type = typeof error?.type === 'string' ? error.type.trim() : '';
  return Boolean(type) && !REFINABLE_ERROR_TYPES.has(type);
}

const PROVIDER_ERROR_FIELD_MAX_LENGTH = 128;
const PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 2048;

function getBoundedProviderErrorField(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= PROVIDER_ERROR_FIELD_MAX_LENGTH
    ? normalized
    : undefined;
}

function getBoundedProviderErrorMessage(value) {
  if (typeof value !== 'string') return undefined;

  return value.trim().length > 0 && value.length <= PROVIDER_ERROR_MESSAGE_MAX_LENGTH
    ? value
    : undefined;
}

function extractProviderHttpErrorInfo(body) {
  const topLevel = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const nestedError = topLevel.error && typeof topLevel.error === 'object' && !Array.isArray(topLevel.error)
    ? topLevel.error
    : {};
  const info = {};

  const fields = [
    ['topLevelCode', topLevel.code],
    ['nestedErrorCode', nestedError.code],
    ['topLevelType', topLevel.type],
    ['nestedErrorType', nestedError.type],
  ];

  for (const [field, value] of fields) {
    const boundedValue = getBoundedProviderErrorField(value);
    if (boundedValue !== undefined) info[field] = boundedValue;
  }

  return Object.freeze(info);
}

function classifyProviderHttpError(provider, errorInfo) {
  if (typeof provider?.classifyProviderHttpError !== 'function') return null;

  try {
    const result = provider.classifyProviderHttpError(errorInfo);
    const normalizedResult = typeof result === 'string' ? result.trim() : '';
    return Object.values(ErrorTypes).includes(normalizedResult) ? normalizedResult : null;
  } catch (error) {
    logger.debug(`[${provider.providerName}] Provider HTTP error classification failed; using generic classification`, error);
    return null;
  }
}

function getApiKeyCandidates(provider, keys, apiKeyFailoverContext) {
  if (typeof provider?.isApiKeyCandidateEligible !== 'function') return keys;

  return keys.filter((key) => {
    try {
      return provider.isApiKeyCandidateEligible(key, apiKeyFailoverContext) === true;
    } catch (error) {
      logger.debug(`[${provider.providerName}] API key candidate check failed; excluding key`, error);
      return false;
    }
  });
}

function shouldFailoverApiKey(provider, error) {
  if (typeof provider?.shouldFailoverApiKey !== 'function') {
    return ApiKeyManager.shouldFailover(error);
  }

  try {
    return provider.shouldFailoverApiKey(error) === true;
  } catch (hookError) {
    logger.debug(`[${provider.providerName}] Provider API key failover check failed`, hookError);
    return false;
  }
}

function createOperationAbortError(signal) {
  const isUserAbort = signal?.reason === 'user-cancelled' || signal?.reason === 'user_cancelled';
  const error = new Error(isUserAbort ? 'Translation cancelled by user' : 'Translation operation aborted');
  error.name = 'AbortError';

  if (isUserAbort) {
    error.type = ErrorTypes.USER_CANCELLED;
  } else {
    error.operationAborted = true;
    error.cancellationReason = typeof signal?.reason === 'string'
      && signal.reason
      && signal.reason !== 'timeout'
      ? signal.reason
      : 'operation-abort';
  }

  return error;
}

function parseRetryAt(response, now = Date.now()) {
  const header = response?.headers?.get?.('Retry-After')
    ?? response?.headers?.get?.('retry-after');
  if (typeof header !== 'string') return undefined;

  const value = header.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    const retryAt = now + seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(retryAt)
      ? retryAt
      : undefined;
  }

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && retryAt > now ? retryAt : undefined;
}

export const ProviderRequestEngine = {
  /**
   * Internal helper to adapt request headers based on the environment (Browser/Platform)
   */
  prepareHeaders(headers = {}, providerName = "") {
    const info = getBrowserInfoSync();
    const finalHeaders = { ...headers };

    // 1. Remove Chrome-only sensitive headers if not in a Chromium-based browser
    if (info.isFirefox || info.isMobile) {
      delete finalHeaders['Sec-Fetch-Dest'];
      delete finalHeaders['Sec-Fetch-Mode'];
      delete finalHeaders['Sec-Fetch-Site'];
      delete finalHeaders['Sec-Fetch-User'];
      delete finalHeaders['Sec-Fetch-Storage-Access'];
      
      if (info.isFirefox) {
        delete finalHeaders['Referer'];
      }
    }

    // 2. Identity Spoofing for specific providers in non-native environments
    if (providerName === ProviderNames.MICROSOFT_EDGE && (info.isFirefox || info.isMobile)) {
      finalHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    }

    return finalHeaders;
  },

  /**
   * UNIFIED API REQUEST HANDLER
   */
  async executeRequest(provider, { url, fetchOptions, extractResponse, context, abortController, updateApiKey, charCount, originalCharCount, sessionId, executionContext, callPurpose, apiKeyFailoverContext }) {
    const normalizedCallPurpose = normalizeCallPurpose(callPurpose);
    // 1. Determine how many attempts we should make based on available keys
    let availableKeysCount = 1;
    let apiKeyCandidates = null;
    if (provider.providerSettingKey && updateApiKey) {
      try {
        const keys = await ApiKeyManager.getKeys(provider.providerSettingKey);
        const candidates = getApiKeyCandidates(provider, keys, apiKeyFailoverContext);
        apiKeyCandidates = candidates.slice(0, 10);
        availableKeysCount = Math.max(1, apiKeyCandidates.length);
      } catch (e) {
        logger.warn(`[${provider.providerName}] Failed to count keys for failover:`, e);
      }
    }

    let lastError = null;
    let currentUrl = url;

    for (let attempt = 0; attempt < availableKeysCount; attempt++) {
      if (abortController?.signal?.aborted) {
        const abortError = createOperationAbortError(abortController.signal);
        appendTranslationDiagnostic(executionContext, {
          type: 'PROVIDER_CANCELLED',
          stage: 'provider-request',
          provider: provider.providerName,
          reason: abortError.message,
          code: abortError.type || abortError.cancellationReason,
          cancelled: true,
        });
        throw abortError;
      }

      try {
        // 2. Perform actual API call
        const result = await this.executeApiCall(provider, { 
          url: currentUrl, 
          fetchOptions, 
          extractResponse, 
          context, 
          abortController,
          sessionId: sessionId || null,
          charCount: charCount !== undefined ? charCount : 0,
          originalCharCount: originalCharCount || 0,
          callPurpose: normalizedCallPurpose,
        });

        // 3. Success! Promote the working key
        if (attempt > 0 && provider.providerSettingKey) {
          // Get the key actually used in THIS successful attempt
          const currentKey = apiKeyCandidates?.[attempt];
          
          if (currentKey) {
            await ApiKeyManager.promoteKey(provider.providerSettingKey, currentKey);
            logger.info(`[${provider.providerName}] Failover successful on attempt ${attempt + 1}, key promoted.`);
            appendTranslationDiagnostic(executionContext, {
              type: 'PROVIDER_KEY_FAILOVER',
              stage: 'provider-request',
              provider: provider.providerName,
              attempt: attempt + 1,
            });
          }
        }

        return result;

      } catch (error) {
        lastError = error;

        const errorType = error.type || (error.operationAborted ? null : matchErrorToType(error));
        if (error.operationAborted || errorType === ErrorTypes.USER_CANCELLED || errorType === ErrorTypes.TRANSLATION_CANCELLED) {
          appendTranslationDiagnostic(executionContext, {
            type: 'PROVIDER_CANCELLED',
            stage: 'provider-request',
            provider: provider.providerName,
            reason: error.message,
            code: errorType || error.cancellationReason,
            cancelled: true,
          });
          throw error;
        }

        if (abortController?.signal?.aborted) {
          const abortError = createOperationAbortError(abortController.signal);
          appendTranslationDiagnostic(executionContext, {
            type: 'PROVIDER_CANCELLED',
            stage: 'provider-request',
            provider: provider.providerName,
            reason: abortError.message,
            code: abortError.type || abortError.cancellationReason,
            cancelled: true,
          });
          throw abortError;
        }

        if (!error.type && errorType) error.type = errorType;

        // 5. Handle Failover
        if (attempt < availableKeysCount - 1 && shouldFailoverApiKey(provider, error)) {
          if (apiKeyCandidates?.length > attempt + 1) {
            logger.warn(`[${provider.providerName}] Key error, attempting failover (${attempt + 1}/${availableKeysCount})`);
            appendTranslationDiagnostic(executionContext, {
              type: 'PROVIDER_KEY_FAILOVER_ATTEMPT',
              stage: 'provider-request',
              provider: provider.providerName,
              attempt: attempt + 1,
              reason: error.message,
              code: errorType,
            });
            const nextKey = apiKeyCandidates[attempt + 1];
            await updateApiKey(nextKey, fetchOptions);
            
            if (fetchOptions.url && fetchOptions.url !== currentUrl) {
              currentUrl = fetchOptions.url;
            } else if (provider.providerName === ProviderNames.GEMINI) {
              const urlObj = new URL(currentUrl);
              urlObj.searchParams.set('key', nextKey);
              currentUrl = urlObj.toString();
            }
            continue; 
          }
        }

        appendTranslationDiagnostic(executionContext, {
          type: 'PROVIDER_REQUEST_FAILURE',
          stage: 'provider-request',
          provider: provider.providerName,
          attempt: attempt + 1,
          reason: error.message,
          code: error.type,
        });
        throw error;
      }
    }
    throw lastError;
  },

  /**
   * Executes a fetch call and normalizes errors
   */
  async executeApiCall(provider, { url, fetchOptions, extractResponse = (data) => data, context, abortController, sessionId, charCount, originalCharCount, callPurpose }) {
    const normalizedCallPurpose = normalizeCallPurpose(callPurpose);
    const finalSessionId = sessionId || abortController?.sessionId || null;
    const finalCharCount = charCount || 0;
    const finalOriginalCharCount = originalCharCount || 0;

    // MOCK BYPASS: If URL is a mock protocol, skip actual fetch but keep stats and logs
    if (url.startsWith('mock://')) {
      const { globalCallId } = statsManager.recordRequest(provider.providerName, finalSessionId, finalCharCount, finalOriginalCharCount, normalizedCallPurpose);
      const mockDuration = 100 + Math.random() * 200;
      logger.debugLazy(() => {
        return [`[Call #${globalCallId}] Mock Engine Bypass: 200 OK (${mockDuration.toFixed(0)}ms)`, {
          status: 200,
          duration: mockDuration,
          context: 'mock-simulation'
        }];
      });
      return { status: 200, ok: true, json: async () => ({ mock: true }) };
    }

    try {
      const finalFetchOptions = { ...fetchOptions };
      if (abortController) {
        finalFetchOptions.signal = abortController.signal;
      }

      if (finalFetchOptions.headers) {
        finalFetchOptions.headers = this.prepareHeaders(finalFetchOptions.headers, provider.providerName);
      }

      // Capture proxy configuration for this physical attempt.
      const proxyConfig = await provider._initializeProxy();

      if (provider.constructor.isAI) {
        await rateLimitManager.waitForCooldown(provider.providerName, abortController?.signal);
      }
      if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);

      const { globalCallId, sessionCallId } = statsManager.recordRequest(provider.providerName, finalSessionId, finalCharCount, finalOriginalCharCount, normalizedCallPurpose);
      const sessionTag = finalSessionId ? ` [Session: ${finalSessionId.substring(0, 8)}${sessionCallId > 0 ? ` #${sessionCallId}` : ''}]` : '';

      // CENTRALIZED SMART LOGGING: REQUEST
      logger.debugLazy(() => {
        const sanitizedUrl = this._maskSensitiveData(url);
        const payload = this._parsePayload(fetchOptions.body);

        return [`[Call #${globalCallId}]${sessionTag} Request: ${sanitizedUrl}`, {
          context,
          charCount: finalCharCount,
          payloadType: payload ? (Array.isArray(payload) ? 'array' : typeof payload) : 'empty',
        }];
      });

      const startTime = Date.now();
      const response = await proxyManager.fetch(url, finalFetchOptions, proxyConfig);
      const duration = Date.now() - startTime;
      const retryAt = parseRetryAt(response);
      
      let responseData = null;

      // 1. Pre-process response data for logging (SMART LOGGING)
      const canClone = typeof response.clone === 'function';
      const clonedForLogging = canClone ? response.clone() : null;
      
      if (clonedForLogging) {
        const contentType = clonedForLogging.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          try {
            responseData = await clonedForLogging.json();
          } catch { /* ignore */ }
        } else {
          try {
            responseData = await clonedForLogging.text();
          } catch { /* ignore */ }
        }
      }

      // CENTRALIZED SMART LOGGING: RESPONSE
      logger.debugLazy(() => {
        let responseSize = 0;
        try {
          if (typeof responseData === 'string') {
            responseSize = responseData.length;
          } else if (responseData != null) {
            responseSize = JSON.stringify(responseData)?.length ?? 0;
          }
        } catch {
          responseSize = 0;
        }

        return [`[Call #${globalCallId}] Response: ${response.status} (${duration}ms)`, {
          status: response.status,
          duration,
          responseType: responseData ? (typeof responseData === 'object' && !Array.isArray(responseData) && responseData !== null ? 'json' : typeof responseData) : 'empty',
          responseSize,
        }];
      });

      // 2. Handle HTTP errors
      if (!response.ok) {
        let body = {};
        // If we already parsed JSON for logging, use it
        if (responseData && typeof responseData === 'object') {
          body = responseData;
        } else if (responseData && typeof responseData === 'string') {
          try {
            body = JSON.parse(responseData);
          } catch { /* ignore */ }
        } else {
          // If we didn't parse it for logging (e.g. clone() was missing), try reading it now
          try {
            body = await response.json();
          } catch { /* ignore */ }
        }
        
        // A top-level string `body.error` must participate via the existing
        // bounded helper; non-strings safely yield undefined.
        const classificationMessage = getBoundedProviderErrorMessage(body?.detail)
          ?? getBoundedProviderErrorMessage(body?.error?.message)
          ?? getBoundedProviderErrorMessage(body?.error)
          ?? getBoundedProviderErrorMessage(response.statusText)
          ?? `HTTP ${response.status}`;
        const message = getBoundedProviderErrorMessage(body?.detail)
          ?? getBoundedProviderErrorMessage(body?.error?.message)
          ?? getBoundedProviderErrorMessage(body?.error)
          ?? getBoundedProviderErrorMessage(body?.message)
          ?? getBoundedProviderErrorMessage(response.statusText)
          ?? `HTTP ${response.status}`;
        const logLevel = 'warn'; // Providers only warn, upper layers handle errors
        
        let sanitizedUrl = url;
        try {
          const urlObj = new URL(url);
          if (urlObj.searchParams.has('key')) urlObj.searchParams.set('key', '***');
          if (urlObj.searchParams.has('api_key')) urlObj.searchParams.set('api_key', '***');
          sanitizedUrl = urlObj.toString();
        } catch { /* fallback */ }

        logger[logLevel](`[${provider.providerName}] executeApiCall HTTP error (${response.status})`, {
          status: response.status,
          message,
          url: sanitizedUrl,
        });

        const providerErrorInfo = Object.freeze({
          statusCode: response.status,
          ...extractProviderHttpErrorInfo(body),
        });
        const providerErrorType = classifyProviderHttpError(provider, providerErrorInfo);
        const errorType = providerErrorType || matchErrorToType({
          statusCode: response.status,
          message: classificationMessage,
          providerType: provider.constructor.type,
        });

        const err = new Error(message);
        err.type = errorType;
        err.statusCode = response.status;
        err.context = context;
        err.providerName = provider.providerName;
        const providerCode = providerErrorInfo.nestedErrorCode ?? providerErrorInfo.topLevelCode;
        if (providerCode !== undefined) err.code = providerCode;
        if (errorType === ErrorTypes.RATE_LIMIT_REACHED && retryAt !== undefined) {
          err.retryAt = retryAt;
        }
        if (provider.constructor.isAI && errorType === ErrorTypes.RATE_LIMIT_REACHED) {
          rateLimitManager.notifyRateLimit(provider.providerName, err);
        }
        throw err;
      }

      // 3. Process successful response
      const isAsyncHandler = extractResponse.constructor.name === 'AsyncFunction';
      const wantsRawResponse = extractResponse.length > 2;

      // Special case: If handler wants the raw response object, give it a fresh clone
      if (isAsyncHandler || wantsRawResponse) {
        const responseToPass = typeof response.clone === 'function' ? response.clone() : response;
        return await extractResponse(responseToPass, response.status, responseToPass);
      }

      // If we already have the data parsed for logging, use it to avoid re-parsing
      if (responseData !== null) {
        try {
          // If the provider returned an error structure inside a 200 OK (common in some APIs)
          // we treat it as an error to trigger failover/UI messaging.
          const result = await extractResponse(responseData, response.status);
          
          if (result === undefined) {
            const err = new Error(ErrorTypes.API_RESPONSE_INVALID);
            err.type = ErrorTypes.API_RESPONSE_INVALID;
            err.statusCode = response.status;
            err.context = context;
            throw err;
          }
          return result;
        } catch (extractErr) {
          // If extractResponse threw an error (like API_ERROR), propagate it
          if (extractErr.message && (extractErr.message.includes('API_ERROR') || extractErr.type)) {
            throw extractErr;
          }
          logger.debug(`[${provider.providerName}] extractResponse failed with parsed data`, extractErr);
        }
      }

      // Fallback: If we didn't parse for logging or parsing failed, try reading now
      const contentTypeSuccess = response.headers.get('content-type');
      if (contentTypeSuccess && contentTypeSuccess.includes('application/json')) {
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          if (parseError?.name === 'AbortError') throw parseError;
          const error = new Error('Provider response contains invalid JSON');
          error.type = ErrorTypes.JSON_PARSING_ERROR;
          error.statusCode = response.status;
          error.context = context;
          error.providerName = provider.providerName;
          throw error;
        }
        const result = await extractResponse(data, response.status);
        if (result === undefined) {
          const error = new Error(ErrorTypes.API_RESPONSE_INVALID);
          error.type = ErrorTypes.API_RESPONSE_INVALID;
          error.statusCode = response.status;
          error.context = context;
          error.providerName = provider.providerName;
          throw error;
        }
        return result;
      }

      const responseText = await response.text();
      return await extractResponse(responseText, response.status);
    } catch (err) {
      const hasAuthoritativeType = isAuthoritativeErrorType(err);

      // Record error in stats if it's not a cancellation
      const isCancellation = err.operationAborted === true
        || err.type === ErrorTypes.USER_CANCELLED
        || err.type === ErrorTypes.TRANSLATION_CANCELLED
        || (!hasAuthoritativeType && err.name === 'AbortError');
      
      if (!isCancellation) {
        statsManager.recordError(provider.providerName, finalSessionId, normalizedCallPurpose);
      }

      if (err.name === 'AbortError') {
        if (hasAuthoritativeType) throw err;

        const signal = abortController?.signal;
        const isUserAbort = signal?.aborted
          && (signal.reason === 'user-cancelled' || signal.reason === 'user_cancelled');
        const abortErr = new Error(isUserAbort ? 'Translation cancelled by user' : 'Translation operation aborted');
        if (isUserAbort) {
          abortErr.type = ErrorTypes.USER_CANCELLED;
        } else {
          abortErr.operationAborted = true;
          abortErr.cancellationReason = typeof signal?.reason === 'string'
            && signal.reason
            && signal.reason !== 'timeout'
            ? signal.reason
            : 'operation-abort';
        }
        abortErr.context = context;
        throw abortErr;
      }
      
      if (err instanceof TypeError && /NetworkError/.test(err.message)) {
        const networkErr = new Error(err.message);
        networkErr.type = ErrorTypes.NETWORK_ERROR;
        networkErr.context = context;
        throw networkErr;
      }
      throw err;
    }
  },

  /**
   * Masks sensitive data in strings or objects (API Keys, etc.)
   * @private
   */
  _maskSensitiveData(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has('key')) urlObj.searchParams.set('key', '***');
      if (urlObj.searchParams.has('api_key')) urlObj.searchParams.set('api_key', '***');
      return urlObj.toString();
    } catch {
      return url;
    }
  },

  /**
   * Smartly parses different payload types (JSON, Form Data, String)
   * @private
   */
  _parsePayload(body) {
    if (!body) return null;
    
    // 1. JSON
    if (typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }

    // 2. URLSearchParams (FormData representation)
    if (body instanceof URLSearchParams || (typeof body === 'string' && body.includes('='))) {
      try {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [key, value] of params.entries()) {
          // Mask context if needed, but usually we want to see it for debug
          obj[key] = value;
        }
        return obj;
      } catch {
        return body;
      }
    }

    return body;
  }
};

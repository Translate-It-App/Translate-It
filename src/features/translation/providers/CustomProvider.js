// src/core/providers/CustomProvider.js
import { BaseAIProvider } from "@/features/translation/providers/BaseAIProvider.js";
import {
  getCustomApiUrlAsync,
  getCustomApiKeysAsync,
  getCustomApiModelAsync,
} from "@/shared/config/config.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ProviderNames } from "@/features/translation/providers/ProviderConstants.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { AIConversationHelper } from "./utils/AIConversationHelper.js";
import { AITextProcessor } from "./utils/AITextProcessor.js";
import { ResponseFormat } from "@/shared/config/translationConstants.js";
import {
  CompletionProviderFamily,
  createCompletionRecord,
  createUsageRecord,
  normalizeTermination,
} from "@/features/translation/ir/CompletionContract.js";
import { recordProviderCompletion } from "@/features/translation/ir/TranslationOperation.js";

const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'Custom');

const STRUCTURED_RESPONSE_FORMATS = new Set([
  ResponseFormat.JSON_OBJECT,
  ResponseFormat.JSON_ARRAY,
]);

// Capability state lives in CustomResponseFormatCapability (single owner).
// Re-exported here for backward compatibility with existing import sites.
import {
  CUSTOM_RESPONSE_FORMAT_SUPPORT,
  normalizeCustomResponseFormatCacheKey,
  getCustomResponseFormatSupport,
  setCustomResponseFormatSupport,
  clearCustomResponseFormatSupportCache,
  isUnsupportedResponseFormatError,
} from './CustomResponseFormatCapability.js';
export {
  CUSTOM_RESPONSE_FORMAT_SUPPORT,
  normalizeCustomResponseFormatCacheKey,
  getCustomResponseFormatSupport,
  setCustomResponseFormatSupport,
  clearCustomResponseFormatSupportCache,
  isUnsupportedResponseFormatError,
};

const CUSTOM_MODEL_NOT_FOUND_CODES = new Set(['model_not_found']);

function didSendResponseFormat(fetchOptions) {
  if (typeof fetchOptions?.body !== 'string') return false;

  try {
    return JSON.parse(fetchOptions.body)?.response_format != null;
  } catch {
    return false;
  }
}

function removeResponseFormat(fetchOptions) {
  if (typeof fetchOptions?.body !== 'string') return null;

  try {
    const payload = JSON.parse(fetchOptions.body);
    delete payload.response_format;
    return { ...fetchOptions, body: JSON.stringify(payload) };
  } catch {
    return null;
  }
}

export class CustomProvider extends BaseAIProvider {
  static type = "ai";
  static description = "Custom OpenAI-compatible API";
  static displayName = "Custom AI";

  constructor() {
    super(ProviderNames.CUSTOM);
    this.providerSettingKey = 'CUSTOM_API_KEY';
  }

  /**
   * Classify only explicit OpenAI-compatible model-not-found responses.
   * Route and ambiguous 404 responses remain generic HTTP failures.
   * @param {Object} errorInfo - Bounded transport error facts.
   * @returns {string|null}
   */
  classifyProviderHttpError(errorInfo) {
    if (Number(errorInfo?.statusCode) !== 404) return null;

    const codes = [errorInfo.topLevelCode, errorInfo.nestedErrorCode];
    return codes.some(code => CUSTOM_MODEL_NOT_FOUND_CODES.has(code))
      ? ErrorTypes.MODEL_MISSING
      : ErrorTypes.HTTP_ERROR;
  }

  /**
   * Normalizes one raw CustomProvider response into a provider-neutral
   * completion record at the adapter boundary. Optional OpenAI-compatible
   * metadata is recorded when present; absent facts remain null. No-op when
   * no selected choice exists.
   * @private
   */
  _recordCustomCompletion(data, executionContext) {
    const choice = data?.choices?.[0];
    if (!choice) return false;

    return recordProviderCompletion(executionContext, createCompletionRecord({
      provider: this.providerName,
      model: data?.model ?? null,
      termination: normalizeTermination(CompletionProviderFamily.OPENAI_COMPATIBLE, choice?.finish_reason),
      responseId: data?.id ?? null,
      usage: createUsageRecord({
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens,
        totalTokens: data?.usage?.total_tokens,
      }),
    }));
  }


  /**
   * Internal implementation of the AI API call.
   * Handles authentication, endpoint resolution, and payload formatting.
   * @protected
   */
  async _callAI(systemPrompt, userText, options = {}) {
    const {
      abortController,
      sessionId,
      expectedFormat,
      isBatch,
      executionContext,
      callPurpose,
      conversationCommitCandidate,
      conversationParticipates: participationOverride,
      mode,
      customResponseFormatCapabilityRef,
    } = options;
    const conversationParticipates = typeof participationOverride === 'boolean'
      ? participationOverride
      : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode: mode, sessionId });

    const [apiUrl, apiKeys, model] = await Promise.all([
      getCustomApiUrlAsync(),
      getCustomApiKeysAsync(),
      getCustomApiModelAsync(),
    ]);

    const apiKey = apiKeys.length > 0 ? apiKeys[0] : '';

    this._validateConfig({ apiUrl, model }, ["apiUrl", "model"], `${this.providerName.toLowerCase()}-translation`);

    const turnNumber = conversationParticipates
      ? await AIConversationHelper.claimNextTurn(sessionId, this.providerName, { callPurpose, translateMode: mode, conversationParticipates })
      : 1;
    logger.info(`[Custom] Model: ${model || 'default'}${sessionId ? ` (Session: ${sessionId.substring(0, 15)}..., Turn: ${turnNumber})` : ''}`);

    const { messages } = await AIConversationHelper.getConversationMessages(sessionId, this.providerName, userText, systemPrompt, mode, { callPurpose, conversationParticipates });

    const headers = {
      "Content-Type": "application/json",
    };

    if (apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Keyed runtime cache (CustomResponseFormatCapability, sole authority)
    // decides send/omit. The per-batch ref is a compat/observer mirror only
    // and never suppresses a probe: a stale ref reused across URL/model
    // change must not leak into a new key. _validateConfig above guarantees
    // truthy apiUrl/model in normal execution; a null key (e.g.
    // whitespace-only) probes conservatively instead of omitting.
    const cachedSupport = getCustomResponseFormatSupport(apiUrl, model);
    const responseFormatUnsupported = cachedSupport === CUSTOM_RESPONSE_FORMAT_SUPPORT.UNSUPPORTED;
    if (customResponseFormatCapabilityRef) {
      customResponseFormatCapabilityRef.responseFormatUnsupported = responseFormatUnsupported;
    }
    const shouldSendResponseFormat = STRUCTURED_RESPONSE_FORMATS.has(expectedFormat)
      && !responseFormatUnsupported;

    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 4096,
        // Apply JSON mode if requested by the contract
        ...(shouldSendResponseFormat && { response_format: { type: "json_object" } })
      }),
    };

    const request = {
      url: apiUrl,
      fetchOptions,
      charCount: fetchOptions.body.length,
      originalCharCount: options.originalCharCount ?? (isBatch ? AITextProcessor.estimateOriginalChars(userText) : userText.length),
      extractResponse: (data) => {
        if (data?.error) {
          throw new Error(`API_ERROR: ${data.error.message || 'Unknown Custom AI Error'}`);
        }
        this._recordCustomCompletion(data, executionContext);
        return data?.choices?.[0]?.message?.content;
      },
      context: `${this.providerName.toLowerCase()}-translation`,
      abortController,
      sessionId,
      executionContext,
      callPurpose,
      updateApiKey: (newKey, options) => {
        if (options && options.headers) {
          options.headers.Authorization = `Bearer ${newKey}`;
        }
      }
    };

    let result;
    try {
      result = await this._executeRequest(request);
      // Structured success while sending response_format proves support.
      if (shouldSendResponseFormat) {
        setCustomResponseFormatSupport(apiUrl, model, CUSTOM_RESPONSE_FORMAT_SUPPORT.SUPPORTED);
        if (customResponseFormatCapabilityRef) {
          customResponseFormatCapabilityRef.responseFormatUnsupported = false;
        }
      }
    } catch (error) {
      // Fallback only when ALL hold: 400/422 + request actually contained
      // response_format + error specifically rejects the response_format field.
      if (!didSendResponseFormat(fetchOptions) || !isUnsupportedResponseFormatError(error)) {
        throw error;
      }

      setCustomResponseFormatSupport(apiUrl, model, CUSTOM_RESPONSE_FORMAT_SUPPORT.UNSUPPORTED);
      if (customResponseFormatCapabilityRef) {
        customResponseFormatCapabilityRef.responseFormatUnsupported = true;
      }

      const fallbackFetchOptions = removeResponseFormat(fetchOptions);
      if (!fallbackFetchOptions) throw error;

      result = await this._executeRequest({
        ...request,
        fetchOptions: fallbackFetchOptions,
      });
    }

    if (sessionId && result && conversationParticipates) {
      if (conversationCommitCandidate) conversationCommitCandidate.stage({ sessionId, userContent: userText, assistantContent: result });
      else await AIConversationHelper.updateSessionHistory(sessionId, userText, result, { callPurpose, translateMode: mode, conversationParticipates });
    }

    return result;
  }

  _validateConfig(config, requiredFields, context) {
    super._validateConfig(config, requiredFields, context);
  }
}

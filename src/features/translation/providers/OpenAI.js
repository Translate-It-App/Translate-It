// src/core/providers/OpenAIProvider.js
import { BaseAIProvider } from "@/features/translation/providers/BaseAIProvider.js";
import {
  CONFIG,
  getOpenAIApiKeysAsync,
  getOpenAIModelAsync
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

const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'OpenAI');

const OPENAI_REQUEST_CAPABILITIES = Object.freeze({
  'gpt-6-luna': Object.freeze({ supportsTemperature: false, reasoningEffort: 'none' }),
  'gpt-6-sol': Object.freeze({ supportsTemperature: false, reasoningEffort: 'none' }),
});

const getRequestCapabilities = (model) => OPENAI_REQUEST_CAPABILITIES[model] || { supportsTemperature: false };

const OPENAI_PERMANENT_QUOTA_CODES = new Set([
  'billing_hard_limit_reached',
  'credit_balance_exhausted',
  'insufficient_credits',
  'insufficient_quota',
]);

const OPENAI_REQUEST_INVALID_CODES = new Set(['invalid_request_error']);

export class OpenAIProvider extends BaseAIProvider {
  static type = "ai";
  static description = "OpenAI GPT models";
  static displayName = "OpenAI GPT";

  constructor() {
    super(ProviderNames.OPENAI);
    this.providerSettingKey = 'OPENAI_API_KEY';
  }

  classifyProviderHttpError(errorInfo) {
    const structuredValues = [
      errorInfo?.topLevelCode,
      errorInfo?.nestedErrorCode,
      errorInfo?.topLevelType,
      errorInfo?.nestedErrorType,
    ]
      .filter(value => typeof value === 'string')
      .map(value => value.trim().toLowerCase());

    if (structuredValues.some(value => OPENAI_PERMANENT_QUOTA_CODES.has(value))) {
      return ErrorTypes.INSUFFICIENT_BALANCE;
    }

    const statusCode = Number(errorInfo?.statusCode);
    if ([400, 422].includes(statusCode)
        && structuredValues.some(value => OPENAI_REQUEST_INVALID_CODES.has(value))) {
      return ErrorTypes.INVALID_REQUEST;
    }

    return null;
  }

  /**
   * Normalizes one raw OpenAI Chat Completion response into a provider-neutral
   * completion record at the adapter boundary. No-op when no selected choice
   * exists; absent facts remain null and raw provider fields do not leak.
   * @private
   */
  _recordOpenAICompletion(data, executionContext) {
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
   * @protected
   */
  async _callAI(systemPrompt, userText, options = {}) {
    const { abortController, sessionId, expectedFormat, isBatch, executionContext, callPurpose, conversationCommitCandidate, conversationParticipates: participationOverride, mode } = options;
    const conversationParticipates = typeof participationOverride === 'boolean'
      ? participationOverride
      : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode: mode, sessionId });

    const [apiKeys, model] = await Promise.all([
      getOpenAIApiKeysAsync(),
      getOpenAIModelAsync(),
    ]);

    const apiKey = apiKeys.length > 0 ? apiKeys[0] : '';

    this._validateConfig({ apiKey }, ["apiKey"], `${this.providerName.toLowerCase()}-translation`);

    const turnNumber = conversationParticipates
      ? await AIConversationHelper.claimNextTurn(sessionId, this.providerName, { callPurpose, translateMode: mode, conversationParticipates })
      : 1;
    const activeModel = model || CONFIG.OPENAI_API_MODEL;
    logger.info(`[OpenAI] Model: ${activeModel}${sessionId ? ` (Session: ${sessionId.substring(0, 15)}..., Turn: ${turnNumber})` : ''}`);

    const { messages } = await AIConversationHelper.getConversationMessages(sessionId, this.providerName, userText, systemPrompt, mode, { callPurpose, conversationParticipates });
    const requestCapabilities = getRequestCapabilities(activeModel);

    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: activeModel,
        messages: messages,
        max_completion_tokens: 4096,
        ...(requestCapabilities.supportsTemperature && { temperature: 0.1 }),
        // Curated GPT-6 models run with disabled reasoning; custom/unknown IDs
        // keep the conservative payload (no temperature, no reasoning effort).
        ...(requestCapabilities.reasoningEffort && { reasoning_effort: requestCapabilities.reasoningEffort }),
        // Enforce JSON Mode for both Object and Batch (Array) contracts
        ...((expectedFormat === ResponseFormat.JSON_OBJECT || expectedFormat === ResponseFormat.JSON_ARRAY) && { 
          response_format: { type: "json_object" } 
        })
      }),
    };

    const result = await this._executeRequest({
      url: CONFIG.OPENAI_API_URL,
      fetchOptions,
      charCount: fetchOptions.body.length,
      originalCharCount: isBatch ? AITextProcessor.estimateOriginalChars(userText) : userText.length,
      extractResponse: (data) => {
        if (data?.error) {
          throw new Error(`API_ERROR: ${data.error.message || 'Unknown OpenAI Error'}`);
        }
        this._recordOpenAICompletion(data, executionContext);
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
    });

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

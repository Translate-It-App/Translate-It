// src/features/translation/providers/CheaperInference.js
import { BaseAIProvider } from "@/features/translation/providers/BaseAIProvider.js";
import {
  CONFIG,
  getCheaperInferenceApiKeysAsync,
  getCheaperInferenceApiModelAsync,
} from "@/shared/config/config.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ProviderNames } from "@/features/translation/providers/ProviderConstants.js";
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

const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'CheaperInference');

export class CheaperInferenceProvider extends BaseAIProvider {
  static type = "ai";
  static description = "Cheaper Inference Multi-Model API";
  static displayName = "Cheaper Inference";

  constructor() {
    super(ProviderNames.CHEAPERINFERENCE);
    this.providerSettingKey = 'CHEAPERINFERENCE_API_KEY';
  }

  /**
   * Normalizes one raw Cheaper Inference response into one completion record at the
   * adapter boundary. Optional metadata remains absent; provider-specific
   * fields are deliberately ignored. Recording is null-safe and cannot alter
   * translated text or existing error behavior.
   * @private
   */
  _recordCheaperInferenceCompletion(data, executionContext) {
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
   * Internal implementation of the Cheaper Inference API call.
   * @protected
   */
  async _callAI(systemPrompt, userText, options = {}) {
    const { abortController, sessionId, expectedFormat, isBatch, executionContext, callPurpose, conversationCommitCandidate, conversationParticipates: participationOverride, mode } = options;
    const conversationParticipates = typeof participationOverride === 'boolean'
      ? participationOverride
      : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode: mode, sessionId });

    const [apiKeys, model] = await Promise.all([
      getCheaperInferenceApiKeysAsync(),
      getCheaperInferenceApiModelAsync(),
    ]);

    const apiKey = apiKeys.length > 0 ? apiKeys[0] : '';

    this._validateConfig({ apiKey }, ["apiKey"], `${this.providerName.toLowerCase()}-translation`);

    const turnNumber = conversationParticipates
      ? await AIConversationHelper.claimNextTurn(sessionId, this.providerName, { callPurpose, translateMode: mode, conversationParticipates })
      : 1;
    logger.info(`[CheaperInference] Model: ${model || 'default'}${sessionId ? ` (Session: ${sessionId.substring(0, 15)}..., Turn: ${turnNumber})` : ''}`);

    const { messages } = await AIConversationHelper.getConversationMessages(sessionId, this.providerName, userText, systemPrompt, mode, { callPurpose, conversationParticipates });

    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || CONFIG.CHEAPERINFERENCE_API_MODEL,
        messages: messages,
        max_tokens: 4096,
        // Enforce JSON Mode if requested
        ...((expectedFormat === ResponseFormat.JSON_OBJECT || expectedFormat === ResponseFormat.JSON_ARRAY)
          && { response_format: { type: "json_object" } })
      }),
    };

    const result = await this._executeRequest({
      url: CONFIG.CHEAPERINFERENCE_API_URL,
      fetchOptions,
      charCount: fetchOptions.body.length,
      originalCharCount: options.originalCharCount ?? (isBatch ? AITextProcessor.estimateOriginalChars(userText) : userText.length),
      extractResponse: (data) => {
        // Handle case where data might be a string (if parsing failed in engine but passed here)
        let parsed = data;
        if (typeof data === 'string') {
          try { parsed = JSON.parse(data); } catch { /* use raw string */ }
        }

        if (parsed?.error) {
          const errorInfo = parsed.error;
          const errorMsg = errorInfo.message || errorInfo.metadata?.raw || (typeof errorInfo === 'string' ? errorInfo : 'Unknown Cheaper Inference Error');
          throw new Error(`API_ERROR: ${errorMsg}`);
        }

        // Error responses carry the error object as the ONLY field
        if (parsed && Object.keys(parsed).length === 1 && parsed.error) {
           throw new Error(`API_ERROR: ${parsed.error.message || 'Unknown Cheaper Inference Error'}`);
        }

        this._recordCheaperInferenceCompletion(parsed, executionContext);
        return parsed?.choices?.[0]?.message?.content;
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

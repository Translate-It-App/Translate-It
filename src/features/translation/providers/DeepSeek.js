// src/core/providers/DeepSeekProvider.js
import { BaseAIProvider } from "@/features/translation/providers/BaseAIProvider.js";
import {
  CONFIG,
  getDeepSeekApiKeysAsync,
  getDeepSeekApiUrlAsync,
  getDeepSeekApiModelAsync,
  getDeepSeekThinkingModeAsync,
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

const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'DeepSeek');
const DEEPSEEK_THINKING_CAPABLE_MODELS = new Set(
  CONFIG.DEEPSEEK_MODELS
    .filter(({ supportsThinking }) => supportsThinking === true)
    .map(({ value }) => value)
);
const DEEPSEEK_THINKING_MODES = new Set(
  CONFIG.DEEPSEEK_THINKING_MODE_OPTIONS
    .filter(({ value }) => value !== 'disabled')
    .map(({ value }) => value)
);

const getDeepSeekThinkingConfig = (model, mode) => {
  if (!DEEPSEEK_THINKING_CAPABLE_MODELS.has(model) || !DEEPSEEK_THINKING_MODES.has(mode)) {
    return { thinking: { type: 'disabled' } };
  }

  return {
    thinking: { type: 'enabled' },
    reasoning_effort: mode,
  };
};

export class DeepSeekProvider extends BaseAIProvider {
  static type = "ai";
  static description = "DeepSeek AI models";
  static displayName = "DeepSeek";

  constructor() {
    super(ProviderNames.DEEPSEEK);
    this.providerSettingKey = 'DEEPSEEK_API_KEY';
  }

  /**
   * Normalizes one raw DeepSeek response into one completion record at the
   * adapter boundary. Missing metadata remains absent and recording cannot
   * alter existing text or error behavior.
   * @private
   */
  _recordDeepSeekCompletion(data, executionContext) {
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
   * Internal implementation of the DeepSeek API call.
   * @protected
   */
  async _callAI(systemPrompt, userText, options = {}) {
    const { abortController, sessionId, expectedFormat, isBatch, executionContext, callPurpose, conversationCommitCandidate, conversationParticipates: participationOverride, mode } = options;
    const conversationParticipates = typeof participationOverride === 'boolean'
      ? participationOverride
      : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode: mode, sessionId });

    const [apiKeys, apiUrl, model, thinkingMode] = await Promise.all([
      getDeepSeekApiKeysAsync(),
      getDeepSeekApiUrlAsync(),
      getDeepSeekApiModelAsync(),
      getDeepSeekThinkingModeAsync(),
    ]);

    const apiKey = apiKeys.length > 0 ? apiKeys[0] : '';

    this._validateConfig({ apiKey }, ["apiKey"], `${this.providerName.toLowerCase()}-translation`);

    const turnNumber = conversationParticipates
      ? await AIConversationHelper.claimNextTurn(sessionId, this.providerName, { callPurpose, translateMode: mode, conversationParticipates })
      : 1;
    const activeModel = model || CONFIG.DEEPSEEK_API_MODEL;
    const thinkingConfig = getDeepSeekThinkingConfig(activeModel, thinkingMode);
    logger.info(`[DeepSeek] Model: ${activeModel}${sessionId ? ` (Session: ${sessionId.substring(0, 15)}..., Turn: ${turnNumber})` : ''}`);

    const { messages } = await AIConversationHelper.getConversationMessages(sessionId, this.providerName, userText, systemPrompt, mode, { callPurpose, conversationParticipates });

    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: activeModel,
        messages: messages,
        temperature: 0.1,
        max_tokens: 4096,
        ...thinkingConfig,
        // DeepSeek supports JSON Mode for structured data
        ...((expectedFormat === ResponseFormat.JSON_OBJECT || expectedFormat === ResponseFormat.JSON_ARRAY) && { 
          response_format: { type: "json_object" } 
        })
      }),
    };

    const result = await this._executeRequest({
      url: apiUrl || "https://api.deepseek.com/chat/completions",
      fetchOptions,
      charCount: fetchOptions.body.length,
      originalCharCount: options.originalCharCount ?? (isBatch ? AITextProcessor.estimateOriginalChars(userText) : userText.length),
      extractResponse: (data) => {
        if (data?.error) {
          throw new Error(`API_ERROR: ${data.error.message || 'Unknown DeepSeek Error'}`);
        }
        this._recordDeepSeekCompletion(data, executionContext);
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

// src/features/translation/providers/GoogleGemini.js
import { BaseAIProvider } from "@/features/translation/providers/BaseAIProvider.js";
import {
  CONFIG,
  getGeminiApiKeysAsync,
  getGeminiModelAsync,
  getGeminiThinkingModeAsync,
  getGeminiApiUrlAsync
} from "@/shared/config/config.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ProviderNames } from "@/features/translation/providers/ProviderConstants.js";
import { AIConversationHelper } from "./utils/AIConversationHelper.js";
import { AITextProcessor } from "./utils/AITextProcessor.js";
import { ResponseFormat, TRANSLATION_CONSTANTS } from "@/shared/config/translationConstants.js";
import {
  CompletionProviderFamily,
  createCompletionRecord,
  createUsageRecord,
  normalizeTermination,
} from "@/features/translation/ir/CompletionContract.js";
import { recordProviderCompletion } from "@/features/translation/ir/TranslationOperation.js";
const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'GoogleGemini');

export class GeminiProvider extends BaseAIProvider {
  static type = "ai";
  static description = "Google Gemini AI";
  static displayName = "Google Gemini";

  constructor() {
    super(ProviderNames.GEMINI);
    this.providerSettingKey = 'GEMINI_API_KEY';
  }

  /**
   * Normalizes one raw Gemini response into a single completion record and
   * attaches it to the current operation. Executes exactly once per physical
   * Gemini response at the provider-adapter boundary. Null-safe: recording
   * never throws and never alters translation. SAFETY responses record POLICY
   * before the existing throw so the response fact survives.
   * @private
   */
  _recordGeminiCompletion(data, executionContext) {
    const candidate = data?.candidates?.[0];
    if (!candidate) return false;

    const usageMetadata = data?.usageMetadata;
    return recordProviderCompletion(executionContext, createCompletionRecord({
      provider: this.providerName,
      model: data?.modelVersion ?? null,
      termination: normalizeTermination(CompletionProviderFamily.GEMINI, candidate?.finishReason),
      responseId: data?.responseId ?? null,
      usage: createUsageRecord({
        inputTokens: usageMetadata?.promptTokenCount,
        outputTokens: usageMetadata?.candidatesTokenCount,
        reasoningTokens: usageMetadata?.thoughtsTokenCount,
        totalTokens: usageMetadata?.totalTokenCount,
      }),
    }));
  }

  /**
   * Internal implementation of the Gemini API call.
   * @protected
   */
  async _callAI(systemPrompt, userText, options = {}) {
    const { abortController, sessionId, expectedFormat, isBatch, executionContext, callPurpose, conversationCommitCandidate, conversationParticipates: participationOverride, mode } = options;
    const conversationParticipates = typeof participationOverride === 'boolean'
      ? participationOverride
      : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode: mode, sessionId });

    const [apiKeys, model, thinkingMode, rawApiUrl] = await Promise.all([
      getGeminiApiKeysAsync(),
      getGeminiModelAsync(),
      getGeminiThinkingModeAsync(),
      getGeminiApiUrlAsync()
    ]);

    const apiKey = apiKeys.length > 0 ? apiKeys[0] : '';

    this._validateConfig({ apiKey }, ["apiKey"], `${this.providerName.toLowerCase()}-translation`);

    const turnNumber = conversationParticipates
      ? await AIConversationHelper.claimNextTurn(sessionId, this.providerName, { callPurpose, translateMode: mode, conversationParticipates })
      : 1;
    logger.info(`[Gemini] Model: ${model || CONFIG.GEMINI_MODEL}${sessionId ? ` (Session: ${sessionId.substring(0, 15)}..., Turn: ${turnNumber})` : ''}`);

    const modelConfig = CONFIG.GEMINI_MODELS?.find(configuredModel => configuredModel.value === model);
    const minimalThinking = modelConfig?.thinking?.minimal;
    const thinkingConfig = thinkingMode === 'minimal' &&
      minimalThinking?.type === 'level' &&
      minimalThinking.value === 'minimal'
      ? { thinkingLevel: 'minimal' }
      : undefined;

    const requestBody = {
      contents: [{
        parts: [{ text: userText }]
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        // The deprecated sampling parameter is intentionally omitted for the curated built-in models.
        // Custom/unknown model IDs keep temperature: 0.1 (capability unknown).
        ...(!['gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(model) && { temperature: 0.1 }),
        maxOutputTokens: 8192, 
        // Enforce JSON Mode for Structured Data
        ...((expectedFormat === ResponseFormat.JSON_OBJECT || expectedFormat === ResponseFormat.JSON_ARRAY) && { responseMimeType: "application/json" }),
        ...(thinkingConfig && { thinkingConfig })
      }
    };

    if (sessionId && conversationParticipates) {
      // Limit history to last 2 turns with character capping to optimize tokens
      const history = await AIConversationHelper.getConversationHistory(sessionId, options.mode, { 
        maxTurns: 2,
        maxChars: TRANSLATION_CONSTANTS.HISTORY_CHARACTER_LIMITS.AI,
         callPurpose,
         conversationParticipates
      });
      
      if (history.length > 0) {
        const contents = [];
        for (const turn of history) {
          contents.push({ role: 'user', parts: [{ text: turn.user }] });
          contents.push({ role: 'model', parts: [{ text: turn.assistant }] });
        }
        contents.push({ role: 'user', parts: [{ text: userText }] });
        requestBody.contents = contents;
      }
    }

    let apiUrl = rawApiUrl;
    const isStandardGoogleUrl = !rawApiUrl || 
                                rawApiUrl.includes('generativelanguage.googleapis.com') || 
                                rawApiUrl === CONFIG.GEMINI_API_URL;

    if (isStandardGoogleUrl && model && CONFIG.GEMINI_MODELS) {
      const modelConfig = CONFIG.GEMINI_MODELS.find(m => m.value === model);
      if (modelConfig?.url) {
        apiUrl = modelConfig.url;
      }
    }

    let url = apiUrl || CONFIG.GEMINI_API_URL;
    if (!url.includes(':generateContent')) url = `${url}:generateContent`;
    url = `${url}?key=${apiKey}`;

    const fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    };
    const originalCharCount = isBatch ? AITextProcessor.estimateOriginalChars(userText) : userText.length;

    const result = await this._executeRequest({
      url,
      fetchOptions,
      charCount: fetchOptions.body.length,
      originalCharCount,
      extractResponse: (data) => {
        this._recordGeminiCompletion(data, executionContext);
        if (data?.error) {
          throw new Error(`API_ERROR: ${data.error.message || 'Unknown Gemini Error'}`);
        }

        const candidate = data?.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY') {
          throw new Error('API_ERROR: Content blocked by Gemini safety filters');
        }

        return candidate?.content?.parts?.[0]?.text;
      },
      context: `${this.providerName.toLowerCase()}-translation`,
      abortController,
      sessionId,
      executionContext,
      callPurpose,
      updateApiKey: (newKey, options) => {
        if (options.url) {
          const urlObj = new URL(options.url);
          urlObj.searchParams.set('key', newKey);
          options.url = urlObj.toString();
        }
      }
    });

    if (sessionId && result && conversationParticipates) {
      if (conversationCommitCandidate) conversationCommitCandidate.stage({ sessionId, userContent: userText, assistantContent: result });
      else await AIConversationHelper.updateSessionHistory(sessionId, userText, result, { callPurpose, translateMode: mode, conversationParticipates });
    }

    return result;
  }
}

export default GeminiProvider;

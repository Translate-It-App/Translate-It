/**
 * AI Conversation Helper - Manages session history and prompt preparation for AI providers
 * Optimized for token reduction while maintaining quality for small LLMs.
 */

import { buildPrompt } from "@/features/translation/utils/promptBuilder.js";
import { ResponseFormat } from '@/shared/config/translationConstants.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { TRANSLATION_CONSTANTS } from '@/shared/config/translationConstants.js';
import {
  getPromptAsync,
  getPromptAutoAsync,
  getPromptBASEAIBatchAsync, 
  getPromptBASEAIBatchAutoAsync,
  getPromptBASEAIFollowupAsync, 
  getPromptBASEAIFollowupAutoAsync,
  getPromptBASEFieldAsync,
  getPromptBASEFieldAutoAsync,
  getPromptPopupTranslateAsync,
  getPromptDictionaryAsync,
  getEnableDictionaryAsync,
  CONFIG,
  TranslationMode,
  getAIContextTranslationEnabledAsync,
  getAIConversationHistoryEnabledAsync
} from '@/shared/config/config.js';
import { NewlineManager } from '@/features/translation/utils/NewlineManager.js';
import { shouldUseAutoPromptAsync } from '@/features/translation/utils/bilingualPromptHelper.js';
import { buildSemanticInstructions } from './SemanticPromptBuilder.js';
import { TranslationCallPurpose } from '../ProviderConstants.js';
import { HISTORICAL_PROMPT_DEFAULTS } from '@/shared/config/promptHistoricalDefaults.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'AIConversationHelper');
const SOURCE_TEXT_REFERENCE = '⟦SOURCE_TEXT_IN_USER_MESSAGE⟧';

const MARKER_PRESERVATION_INSTRUCTIONS = `- Preserve every segment marker that begins with @@TI_SEG_ and ends with @@ exactly as it appears. Example: @@TI_SEG_xxx_session_n5@@. Do not translate, remove, duplicate, reorder, or modify any character inside these markers.
- Each segment marker is one complete boundary token, not an opening/closing pair. Do not add extra @@ around translated text.
- Preserve every @@TI_ESC_...@@ escape token exactly as it appears. Do not translate, remove, or modify it.`;

async function getEditableBasePrompt(translateMode, useAutoPrompt) {
  if (translateMode === TranslationMode.Popup_Translate || translateMode === TranslationMode.Sidepanel_Translate) {
    return { key: 'PROMPT_BASE_POPUP_TRANSLATE', value: await getPromptPopupTranslateAsync() };
  }
  if (translateMode === TranslationMode.Dictionary_Translation && await getEnableDictionaryAsync()) {
    return { key: 'PROMPT_BASE_DICTIONARY', value: await getPromptDictionaryAsync() };
  }
  if (translateMode !== TranslationMode.ScreenCapture) {
    const key = useAutoPrompt ? 'PROMPT_BASE_FIELD_AUTO' : 'PROMPT_BASE_FIELD';
    const value = useAutoPrompt ? await getPromptBASEFieldAutoAsync() : await getPromptBASEFieldAsync();
    return { key, value };
  }
  return null;
}

function isCustomizedEditableBase(key, value) {
  if (!key || typeof value !== 'string') return false;
  return value !== CONFIG[key] && !(HISTORICAL_PROMPT_DEFAULTS[key] || []).some((entry) => (
    (typeof entry === 'string' ? entry : entry?.value) === value
  ));
}

function hasCommittedConversationPair(session) {
  const history = session?.history;
  if (!Array.isArray(history)) return false;
  return history.some((message, index) => (
    message?.role === 'user' && history[index + 1]?.role === 'assistant'
  ));
}

/**
 * Checks if the parsed JSON object matches the specific format
 * (array of objects where each object has a 'text' property as string)
 *
 * @param {any} obj - The object to check
 * @returns {boolean}
 */
function isSpecificTextJsonFormat(obj) {
  return (
    Array.isArray(obj) &&
    obj.length > 0 &&
    obj.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.text === "string"
    )
  );
}

export const AIConversationHelper = {
  /**
   * Resolves one conversation participation decision for current semantic call.
   * The result governs both history reads and normal history writes.
   */
  async getConversationParticipation({ callPurpose, translateMode, sessionId, isAIProvider = true } = {}) {
    if (callPurpose !== TranslationCallPurpose.PRIMARY_TRANSLATION) return false;
    if (translateMode !== TranslationMode.Select_Element) return false;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    if (!isAIProvider) return false;
    return getAIConversationHistoryEnabledAsync();
  },

  /**
   * Internal helper to truncate text intelligently at sentence or word boundaries
   * to maintain meaning while staying under the character limit.
   * @private
   */
  _truncateSmart(text, maxLength) {
    if (!text || typeof text !== 'string' || text.length <= maxLength) return text;

    // 1. Try to find the last sentence end (., !, ?, \n) within the last 25% of the allowed range
    const searchRangeStart = Math.floor(maxLength * 0.75);
    const lastSentenceEnd = Math.max(
      text.lastIndexOf('. ', maxLength),
      text.lastIndexOf('! ', maxLength),
      text.lastIndexOf('? ', maxLength),
      text.lastIndexOf('\n', maxLength)
    );

    let cutIndex = -1;

    if (lastSentenceEnd >= searchRangeStart) {
      // Prioritize sentence ends if they are reasonably close to the limit
      cutIndex = lastSentenceEnd + 1;
    } else {
      // 2. Fallback: Find the last space before the limit to avoid cutting a word
      cutIndex = text.lastIndexOf(' ', maxLength);
    }

    // 3. Last resort: Hard cut if no space or sentence end is found (e.g., very long word)
    if (cutIndex <= 0) cutIndex = maxLength;

    // 4. Clean up trailing punctuation/whitespace and add ellipsis
    // Includes Arabic/Persian comma (U+060C)
    return text.substring(0, cutIndex).replace(/[.,;:\-\s\u060C]+$/, '') + '...';
  },

  /**
   * Check if this is the first turn in a session
   */
  async isFirstTurn(sessionId) {
    if (!sessionId) return true;
    try {
      const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
      const session = translationSessionManager.sessions.get(sessionId);
      return !hasCommittedConversationPair(session);
    } catch {
      return true;
    }
  },

  /**
   * Reserve and get the next turn number for a session
   */
  async claimNextTurn(sessionId, providerName = 'Unknown', { callPurpose, translateMode, conversationParticipates } = {}) {
    const participates = typeof conversationParticipates === 'boolean'
      ? conversationParticipates
      : await this.getConversationParticipation({ callPurpose, translateMode, sessionId });
    if (!participates) return 1;
    if (!sessionId) return 1;
    try {
      const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
      return translationSessionManager.claimNextTurn(sessionId, providerName);
    } catch {
      return 1;
    }
  },

  /**
   * Get current turn number for a session
   */
  async getTurnNumber(sessionId) {
    if (!sessionId) return 1;
    try {
      const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
      return translationSessionManager.getTurnNumber(sessionId);
    } catch {
      return 1;
    }
  },

  /**
   * Helper to get conversation history as structured turns
   * @param {string} sessionId - Active session ID
   * @param {string} translateMode - Current translation mode
   * @param {Object} options - Options for history (maxTurns, maxChars)
   */
  async getConversationHistory(sessionId, translateMode = '', options = {}) {
    const participates = typeof options.conversationParticipates === 'boolean'
      ? options.conversationParticipates
      : await this.getConversationParticipation({
        callPurpose: options.callPurpose,
        translateMode,
        sessionId,
      });
    if (!participates) return [];

    const { 
      maxTurns = 1, 
      maxChars = TRANSLATION_CONSTANTS.HISTORY_CHARACTER_LIMITS.AI 
    } = options;

    try {
      const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
      const session = translationSessionManager.sessions.get(sessionId);
      if (!session || !session.history || session.history.length === 0) return [];

      const turns = [];
      const messagesToProcess = session.history.slice(-(maxTurns * 2));

      for (let i = 0; i < messagesToProcess.length; i += 2) {
        const userMsg = messagesToProcess[i];
        const assistantMsg = messagesToProcess[i + 1];
        if (userMsg && assistantMsg && userMsg.role === 'user' && assistantMsg.role === 'assistant') {
          turns.push({ 
            user: this._truncateSmart(userMsg.content, maxChars), 
            assistant: this._truncateSmart(assistantMsg.content, maxChars) 
          });
        }
      }
      return turns;
    } catch (e) {
      logger.warn('Failed to get conversation history:', e);
      return [];
    }
  },

  /**
   * Format the last Select Element turn as compact prompt context.
   * Returns an empty string when history is disabled or unavailable.
   */
  async formatCompactHistoryContext(sessionId, translateMode = '', options = {}) {
    const turns = await this.getConversationHistory(sessionId, translateMode, {
      maxTurns: 1,
      maxChars: options.maxChars ?? TRANSLATION_CONSTANTS.HISTORY_CHARACTER_LIMITS.AI,
      callPurpose: options.callPurpose,
      conversationParticipates: options.conversationParticipates,
    });

    if (!turns.length) return '';

    const lastTurn = turns[turns.length - 1];
    if (!lastTurn?.user || !lastTurn?.assistant) return '';

    return [
      'Previous translation context:',
      'Original:',
      lastTurn.user,
      '',
      'Translated:',
      lastTurn.assistant
    ].join('\n');
  },

  /**
   * Prepares a compact context string for DeepL
   */
  async prepareDeepLContext(sessionId, contextMetadata, translateMode = null) {
    let contextParts = [];

    const [contextEnabled, historyEnabled] = await Promise.all([
      getAIContextTranslationEnabledAsync(),
      getAIConversationHistoryEnabledAsync()
    ]);

    // 1. Subtitle Context (Dialogue continuity for subtitle translation)
    if (contextEnabled && contextMetadata?.dialogueContext) {
      contextParts.push(contextMetadata.dialogueContext);
    }

    // 2. Structural Context (Site Title, Section Heading)
    if (contextEnabled && contextMetadata) {
      if (contextMetadata.pageTitle) contextParts.push(`Site: ${contextMetadata.pageTitle}`);
      if (contextMetadata.heading) contextParts.push(`Section: ${contextMetadata.heading}`);
      if (contextMetadata.role) contextParts.push(`Context: ${contextMetadata.role}`);
    }

    // 3. Compact History (Last full turn: User + Assistant)
    // History is only included for Select Element to maintain style/consistency
    if (historyEnabled && sessionId && translateMode === TranslationMode.Select_Element) {
      const charLimit = TRANSLATION_CONSTANTS.HISTORY_CHARACTER_LIMITS.DEEPL;
      try {
        const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
        const session = translationSessionManager.sessions.get(sessionId);
        if (session && session.history.length >= 2) {
          const lastTwo = session.history.slice(-2);
          const userPart = lastTwo.find(m => m.role === 'user');
          const assistantPart = lastTwo.find(m => m.role === 'assistant');
          
          if (userPart && assistantPart) {
            const userSnippet = typeof userPart.content === 'string' ? userPart.content : JSON.stringify(userPart.content);
            const assistantSnippet = typeof assistantPart.content === 'string' ? assistantPart.content : JSON.stringify(assistantPart.content);
            
            contextParts.push(`Last turn reference: [Original: "${this._truncateSmart(userSnippet, charLimit)}" | Translated: "${this._truncateSmart(assistantSnippet, charLimit)}"]`);
          }
        } else if (session && session.history.length > 0) {
          // Fallback for single message
          const lastMsg = session.history[session.history.length - 1];
          const snippet = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
          contextParts.push(`Reference: ${this._truncateSmart(snippet, charLimit + 50)}`);
        }
      } catch { /* ignore */ }
    }

    if (contextParts.length === 0) return undefined;

    // Final safety guard: DeepL API context parameter has a hard limit of 1024 characters.
    // We join and truncate at 1000 for maximum safety while preserving meaning.
    const finalContext = contextParts.join('. ');
    return finalContext.length > 1000 
      ? this._truncateSmart(finalContext, 1000) 
      : finalContext;
  },

  /**
   * Helper to prepare system prompt and user text for AI providers
   */
  async preparePromptAndText(text, sourceLang, targetLang, translateMode, providerType, sessionId = null, contextMetadata = null) {
    const firstTurn = await this.isFirstTurn(sessionId);
    const [historyEnabled, contextEnabled] = await Promise.all([
      getAIConversationHistoryEnabledAsync(),
      getAIContextTranslationEnabledAsync()
    ]);

    // Flatten contextMetadata if it's nested (compatibility with Select Element context passing)
    const metadata = contextMetadata?.contextMetadata 
      ? { ...contextMetadata, ...contextMetadata.contextMetadata } 
      : contextMetadata;
    const textsArray = Array.isArray(text) ? text : [text];
    const hasGroupedUnits = textsArray.some((item) => (
      item
      && typeof item === 'object'
      && item.group !== null
      && item.group !== undefined
      && Number.isInteger(item.part)
    ));
    const hasMarkerTokens = textsArray.some((item) => /@@\s*TI\s*_\s*(?:SEG|ESC)\s*_[\s\S]*?@@/i.test(
      typeof item === 'object' && item !== null ? (item.t ?? item.text ?? '') : String(item ?? '')
    ));

    const { getLanguageNameFromCode, getCanonicalCode } = await import('@/shared/config/languageConstants.js');
    const { getSourceLanguageAsync } = await import('@/shared/config/config.js');
    
    // Use consistent language name logic with capitalization (matches promptBuilder.js)
    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const isStructuredRecovery = metadata?.callPurpose === TranslationCallPurpose.STRUCTURED_RECOVERY;
    const isScalarStructuredRecovery = isStructuredRecovery && metadata?.expectedFormat === ResponseFormat.STRING;
    const effectiveTranslateMode = isScalarStructuredRecovery ? TranslationMode.Field : translateMode;
    const useAutoPrompt = await shouldUseAutoPromptAsync(sourceLang, effectiveTranslateMode);
    
    let actualSourceLang = sourceLang === 'auto' ? await getSourceLanguageAsync() : sourceLang;
    if (actualSourceLang === 'auto') {
      actualSourceLang = 'en';
    }

    const sourceName = capitalize(getLanguageNameFromCode(getCanonicalCode(actualSourceLang)) || actualSourceLang);
    const targetName = capitalize(getLanguageNameFromCode(getCanonicalCode(targetLang)) || targetLang);
    const editableBase = await getEditableBasePrompt(effectiveTranslateMode, useAutoPrompt);

    let promptTemplate;
    const isDictionary = translateMode === TranslationMode.Dictionary_Translation;

    // Detect if the input is in the specific JSON format (array of objects with 'text' property)
    let isJsonMode = false;
    const textToCheck = Array.isArray(text) ? text[0] : text;
    if (isSpecificTextJsonFormat(textToCheck)) {
      isJsonMode = true;
    }

    // Determine if we should use AI batch prompt
    // Use batch prompt for structured batch modes OR when input is in JSON format
    const isStructuredRecoveryFormat = isStructuredRecovery
      && (metadata?.expectedFormat === ResponseFormat.JSON_OBJECT || metadata?.expectedFormat === ResponseFormat.JSON_ARRAY);
    const shouldUseBatchPrompt = !isDictionary && !isScalarStructuredRecovery && (
      translateMode === TranslationMode.Select_Element ||
      translateMode === TranslationMode.Page ||
      translateMode === TranslationMode.PDF ||
      translateMode === TranslationMode.Subtitle ||
      isJsonMode ||
      isStructuredRecoveryFormat
    );
    const customEditableBase = !shouldUseBatchPrompt
      && isCustomizedEditableBase(editableBase?.key, editableBase?.value);
    if (shouldUseBatchPrompt) {
      const useFollowup = !firstTurn && historyEnabled && translateMode === TranslationMode.Select_Element;

      // Prioritize custom prompt template from metadata (Subtitle mode)
      if (metadata?.promptTemplate) {
        promptTemplate = metadata.promptTemplate;
      } else if (useAutoPrompt) {
        promptTemplate = useFollowup
          ? await getPromptBASEAIFollowupAutoAsync()
          : await getPromptBASEAIBatchAutoAsync();
      } else {
        promptTemplate = useFollowup
          ? await getPromptBASEAIFollowupAsync()
          : await getPromptBASEAIBatchAsync();
      }

      if (useFollowup) {
        promptTemplate += `\n\nCRITICAL: Keep original JSON structure. Result must be ONLY JSON. Target Language: ${targetName}.`;
      }
    } else {
      // For other modes (Popup, Sidepanel, Field, Selection, ScreenCapture), use the standard buildPrompt logic
      const promptText = Array.isArray(text) ? text[0] : text;
      promptTemplate = await buildPrompt(
        promptText,
        sourceLang,
        targetLang,
        isScalarStructuredRecovery ? TranslationMode.Field : translateMode,
        providerType,
        { instructionsOnly: true },
      );
    }

    // Resolve instructions from template even for AI batch prompts
    let promptInstructions;
    if (metadata?.instruction) {
      // Prioritize custom instructions from metadata (Subtitle mode)
      promptInstructions = metadata.instruction
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{TEXT}\s*/g, '')  // Remove $_{TEXT} placeholder to prevent nesting
        .replace(/\n\s*$/g, '');        // Remove trailing empty lines
    } else {
      const promptInstructionsTemplate = useAutoPrompt
        ? await getPromptAutoAsync()
        : await getPromptAsync();

      // Remove $_{TEXT} from prompt instructions since it will be replaced in the base prompt
      const promptInstructionsWithoutText = promptInstructionsTemplate
        .replace(/\$_{TEXT}\s*/g, '')  // Remove $_{TEXT} placeholder and trailing whitespace
        .replace(/\n\s*$/g, '');        // Remove trailing empty lines

      promptInstructions = promptInstructionsWithoutText
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName);
    }

    if (metadata?.callPurpose === TranslationCallPurpose.STRUCTURED_RECOVERY && metadata.repairContext) {
      const repairInstructions = `\n\nStructured recovery repair context:\n${JSON.stringify(metadata.repairContext)}\nRe-translate the affected source unit(s) and preserve their marker ownership.`;
      promptInstructions += repairInstructions;
      if (isStructuredRecovery) promptTemplate += repairInstructions;
    }

    if (metadata?.callPurpose === TranslationCallPurpose.PARENT_RECOVERY) {
      promptInstructions += '\n\nTranslate every input item, including very short items; preserve each input id.';
    }

    if (hasGroupedUnits) {
      promptInstructions += '\n\nItems with the same "group" belong to one logical text and are ordered by "part". Use adjacent items as translation context. Return exactly one translated item for every input "id". Do not merge, split, omit, duplicate, or reorder IDs. Return only each item\'s "id" and translated "text".';
    }

    // Append semantic translation context when available (PDF mode only)
    if (translateMode === TranslationMode.PDF && metadata?.semanticHint) {
      const semanticInstructions = buildSemanticInstructions(metadata.semanticHint)
      if (semanticInstructions) {
        promptInstructions += '\n' + semanticInstructions
      }
    }

    const textsCount = textsArray.length;

    // Use project standard placeholders, including marker rules only when input contains markers.
    let systemPrompt;
    if (shouldUseBatchPrompt) {
      // For batch prompts, we need to inject instructions and verify $_{TEXT} exists
      // All prompt templates must include $_{TEXT} placeholder
      
      // Fallback if the custom template doesn't have standard placeholders (e.g. SubtitlePrompt uses _{SOURCE})
      let normalizedTemplate = promptTemplate
        .replace(/_{SOURCE}/g, "$_{SOURCE}")
        .replace(/_{TARGET}/g, "$_{TARGET}");

      if (!normalizedTemplate.includes("$_{TEXT}")) {
        // If it's a batch prompt but doesn't have $_{TEXT}, append it at the end
        normalizedTemplate += "\n\n$_{TEXT}";
      }

      // Handle batch-specific instructions (e.g. JSON schema examples)
      const batchInstruction = metadata?.batchInstruction || '';
      const processedBatchInstruction = batchInstruction
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{TEXT}/g, ''); // Ensure TEXT is not double-nested

      systemPrompt = normalizedTemplate
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
        .replace(/\$_{MARKER_PRESERVATION_INSTRUCTIONS}/g, hasMarkerTokens ? MARKER_PRESERVATION_INSTRUCTIONS : '')
        .replace(/\$_{BATCH_INSTRUCTION}/g, processedBatchInstruction)
        .replace(/\$_{COUNT}/g, String(textsCount));
    } else {
      // Non-batch prompts carry source text in the provider's user message.
      systemPrompt = promptTemplate
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{COUNT}/g, '1');
    }

    // Determine if we should wrap the text in a JSON structure
    // We wrap for batch requests (Select_Element, Page, Subtitle) or JSON input (excluding dictionary)
    const shouldWrap = shouldUseBatchPrompt && !isDictionary;

    let userText;
    let originalCharCount;
    if (shouldWrap) {
      // Wrap into the structured JSON format expected by PROMPT_BASE_AI_BATCH
      // This ensures compatibility with strict AI models that expect 'translations' and 'id'
      userText = JSON.stringify({
        translations: textsArray.map((t, idx) => {
          if (typeof t === 'object' && t !== null) {
            const originalText = t.t || t.text || '';
            const protectedText = NewlineManager.protect(originalText);
            return {
              id: String(t.wireId ?? t.i ?? t.id ?? idx),
              ...(t.group !== null && t.group !== undefined && { group: t.group }),
              ...(Number.isInteger(t.part) && { part: t.part }),
              text: protectedText,
              // Include per-cue context if available (critical for Subtitles)
              ...(t.context && { context: t.context })
            };
          }
          return { id: String(idx), text: NewlineManager.protect(String(t)) };
        })
      });
    } else {
      // Default bases keep source in the user message; customized bases are rendered below.
      const scalarText = Array.isArray(text) ? text[0] : text;
      const sourceText = typeof scalarText === 'object' && scalarText !== null
        ? (scalarText.t ?? scalarText.text ?? '')
        : String(scalarText ?? '');
      originalCharCount = typeof sourceText === 'string' ? sourceText.length : undefined;
      userText = NewlineManager.protect(sourceText);

      if (customEditableBase) {
        const renderCustomBase = (textSlot) => editableBase.value
          .replace(/\$_{SOURCE}/g, sourceName)
          .replace(/\$_{TARGET}/g, targetName)
          .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
          .replace(/\$_{COUNT}/g, '1')
          .replace(/\$_{TEXT}/g, () => textSlot);
        systemPrompt = renderCustomBase(SOURCE_TEXT_REFERENCE);
        userText = renderCustomBase(userText);
        if (!editableBase.value.includes('$_{TEXT}')) {
          userText += `\n${NewlineManager.protect(sourceText)}`;
        }
      }
    }

    let finalSystemPrompt = systemPrompt;

    // Inject context only for DOM-related modes if enabled
    const contextSupportedMode = translateMode === TranslationMode.Select_Element ||
                                translateMode === TranslationMode.Page ||
                                translateMode === TranslationMode.Selection;

    if (metadata && contextEnabled && contextSupportedMode) {
      finalSystemPrompt += `\nContext: Page: "${metadata.pageTitle || 'Unknown'}", Section: "${metadata.heading || 'Main'}", Role: "${metadata.role || 'Content'}".`;
    }

    // Replace text placeholder according to project standard $_{TEXT} with global regex
    // Only for batch prompts; non-batch source text is sent separately as userText.
    let resultPrompt;
    if (shouldUseBatchPrompt) {
      resultPrompt = finalSystemPrompt
        .replace(/\$_{TEXT}/g, "the text provided in the user message")
        .trim();
    } else {
      resultPrompt = finalSystemPrompt.trim();
    }

    return {
      systemPrompt: resultPrompt,
      userText,
      ...(!shouldUseBatchPrompt && originalCharCount !== undefined && { originalCharCount }),
    };
  },

  /**
   * Helper to get conversation messages for AI providers
   */
  async getConversationMessages(sessionId, providerName, currentText, systemPrompt, translateMode = '', { callPurpose, conversationParticipates } = {}) {
    const participates = typeof conversationParticipates === 'boolean'
      ? conversationParticipates
      : await this.getConversationParticipation({ callPurpose, translateMode, sessionId });
    if (!participates) {
      return {
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: currentText }],
        session: null
      };
    }
    if (!sessionId) {
      return {
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: currentText }],
        session: null
      };
    }

    const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
    const session = translationSessionManager.getOrCreateSession(sessionId, providerName);
    if (!hasCommittedConversationPair(session)) {
      session.systemPrompt = systemPrompt;
      return {
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: currentText }],
        session
      };
    }

    const messages = [
      { role: 'system', content: systemPrompt || session.systemPrompt }
    ];

    // History limited to last 1 turn with character capping for token optimization
    if (participates && translateMode === TranslationMode.Select_Element) {
      const maxHistoryMessages = 2; // Last 1 turn (User + Assistant)
      const rawHistory = session.history.slice(-maxHistoryMessages);
      
      const charLimit = TRANSLATION_CONSTANTS.HISTORY_CHARACTER_LIMITS.AI;
      const history = rawHistory.map(msg => ({
        ...msg,
        content: this._truncateSmart(msg.content, charLimit)
      }));
      
      messages.push(...history);
    }

    messages.push({ role: 'user', content: currentText });

    return { messages, session };
  },

  /**
   * Helper to update session history with results
   */
  async updateSessionHistory(sessionId, userContent, assistantContent, { callPurpose, translateMode, conversationParticipates } = {}) {
    const participates = typeof conversationParticipates === 'boolean'
      ? conversationParticipates
      : await this.getConversationParticipation({ callPurpose, translateMode, sessionId });
    if (!participates) return;
    try {
      const { translationSessionManager } = await import('@/features/translation/core/TranslationSessionManager.js');
      translationSessionManager.addMessage(sessionId, 'user', userContent);
      translationSessionManager.addMessage(sessionId, 'assistant', assistantContent);
      
      const session = translationSessionManager.sessions.get(sessionId);
      if (session) session.batchCount++;
    } catch { /* ignore */ }
  }
};

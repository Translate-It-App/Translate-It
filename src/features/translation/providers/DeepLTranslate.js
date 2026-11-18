// src/features/translation/providers/DeepLTranslate.js
import { BaseTranslateProvider } from "@/features/translation/providers/BaseTranslateProvider.js";
import {
  getDeeplApiKeysAsync,
  getDeeplApiTierAsync,
  getDeeplFormalityAsync,
  getDeeplFreeApiUrlAsync,
  getDeeplProApiUrlAsync
} from "@/shared/config/config.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { TRANSLATION_CONSTANTS } from "@/shared/config/translationConstants.js";
import { LanguageSwappingService } from "@/features/translation/providers/LanguageSwappingService.js";
import { AUTO_DETECT_VALUE } from "@/shared/constants/core.js";
import { 
  getProviderLanguageCode
} from "@/shared/config/languageConstants.js";
import { ProviderNames } from "@/features/translation/providers/ProviderConstants.js";
import { getTextInfo } from "./utils/TraditionalTextProcessor.js";
import { fetchDeepLLanguageCatalogWithKeyFailover, matchDeepLFormality, matchDeepLTagHandling } from './DeepLLanguageDiscovery.js';
import { matchErrorToType, isFatalError, isProviderRequestSizeError } from '@/shared/error-management/ErrorMatcher.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { createOperationAbortError } from './utils/ProviderRequestEngine.js';
import { NewlineManager } from '@/features/translation/utils/NewlineManager.js';

const logger = getScopedLogger(LOG_COMPONENTS.PROVIDERS, 'DeepLTranslate');
const DEEPL_SOURCE_CHINESE_VARIANTS = new Set(['zh', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant']);
// Generated subtitle/newline markup that requires DeepL XML mode to survive
// translation: <x id="..."/> placeholders and <br> sentence boundaries.
const GENERATED_XML_MARKUP_PATTERN = /<(?:x|br)\s[^>]*\/?>|<br\s*\/?>/i;

export class DeepLTranslateProvider extends BaseTranslateProvider {
  static type = "translate";
  static displayName = "DeepL Translate";
  static description = "AI-powered translation by DeepL";
  static reliableJsonMode = false;
  static supportsDictionary = false;

  // BaseTranslateProvider capabilities (Default values)
  // NOTE: Character limits and chunk sizes are now dynamically managed 
  // by ProviderConfigurations.js based on the active Optimization Level.
  static supportsStreaming = TRANSLATION_CONSTANTS.SUPPORTS_STREAMING.DEEPL;
  static chunkingStrategy = TRANSLATION_CONSTANTS.CHUNKING_STRATEGIES.DEEPL;
  static characterLimit = TRANSLATION_CONSTANTS.CHARACTER_LIMITS.DEEPL;
  static maxChunksPerBatch = TRANSLATION_CONSTANTS.MAX_CHUNKS_PER_BATCH.DEEPL;

  constructor() {
    super(ProviderNames.DEEPL_TRANSLATE);
    this.providerSettingKey = 'DEEPL_API_KEY';
  }

  classifyProviderHttpError(errorInfo) {
    return Number(errorInfo?.statusCode) === 529
      ? ErrorTypes.RATE_LIMIT_REACHED
      : null;
  }

  _isUnsupportedLanguageError(error) {
    if (Number(error?.statusCode) !== 400 || typeof error?.message !== 'string') return false;

    const normalizedMessage = error.message
      .toLowerCase()
      .replace(/[\s"'`.,!?;:()\x5b\x5d{}-]+/g, ' ')
      .trim();

    return /\b(?:source_lang|target_lang|source language|target language)\b(?:\s+is)?\s+(?:not supported|unsupported)\b/.test(normalizedMessage)
      || /\b(?:not supported|unsupported)\b\s+(?:source_lang|target_lang|source language|target language)\b/.test(normalizedMessage);
  }

  shouldFailoverApiKey(error) {
    return Number(error?.statusCode) === 401
      && error?.type === ErrorTypes.API_KEY_INVALID;
  }

  isApiKeyCandidateEligible(key, context = {}) {
    return context.apiTier !== 'pro'
      || (typeof key === 'string' && !key.endsWith(':fx'));
  }

  /**
   * All configured keys for capability discovery, so a dead first key can
   * fail over to the next eligible key (401-only) instead of blocking.
   */
  _getCapabilityDiscoveryKeys(apiKey, apiKeys) {
    return Array.isArray(apiKeys) && apiKeys.length > 0 ? apiKeys.join('\n') : apiKey;
  }

  /**
   * Get configuration using project's existing config system
   * Uses StorageManager's built-in caching and config.js helpers
   */
  async _getConfig() {
    try {
      // Use project's existing config system with built-in caching
      const [apiKeys, apiTier] = await Promise.all([
        getDeeplApiKeysAsync(),
        getDeeplApiTierAsync(),
      ]);

      const normalizedTier = apiTier === 'pro' ? 'pro' : 'free';

      // Select the first key compatible with the configured global tier.
      const apiKey = apiKeys.find(key => this.isApiKeyCandidateEligible(key, { apiTier: normalizedTier })) || '';

      // Get API endpoint based on tier
      const apiUrl = normalizedTier === 'pro'
        ? await getDeeplProApiUrlAsync()
        : await getDeeplFreeApiUrlAsync();

      // Configuration loaded successfully
      logger.info(`[DeepL] Using tier: ${normalizedTier}`);

      return { apiKey, apiTier: normalizedTier, apiUrl, apiKeys };
    } catch (error) {
      logger.error(`[DeepL] Error loading configuration:`, error);
      throw error;
    }
  }

  /**
   * Convert source language to DeepL code.
   * @param {string} lang - Language code or name
   * @returns {string} DeepL source language code
   */
  _getSourceLangCode(lang) {
    const normalized = LanguageSwappingService._normalizeLangValue(lang).replace(/_/g, '-');
    if (normalized === AUTO_DETECT_VALUE) return ''; // DeepL auto-detect uses empty string
    if (DEEPL_SOURCE_CHINESE_VARIANTS.has(normalized)) return 'ZH';

    return this._getDeepLLanguageCode(normalized);
  }

  /**
   * Convert target language to DeepL code.
   * @param {string} lang - Language code or name
   * @returns {string} DeepL target language code
   */
  _getTargetLangCode(lang) {
    const normalized = LanguageSwappingService._normalizeLangValue(lang).replace(/_/g, '-');
    if (normalized === AUTO_DETECT_VALUE) return '';
    if (normalized === 'zh-cn' || normalized === 'zh-hans') return 'ZH-HANS';
    if (normalized === 'zh-tw' || normalized === 'zh-hant') return 'ZH-HANT';

    return this._getDeepLLanguageCode(normalized);
  }

  _getDeepLLanguageCode(normalized) {
    // Keep validated v3 BCP47 variants intact (for example en-US and pt-BR).
    if (normalized.includes('-') && !['zh-cn', 'zh-tw'].includes(normalized)) {
      const mappedCode = getProviderLanguageCode(normalized, 'DEEPL');
      if (mappedCode !== normalized) return mappedCode;
      try {
        return Intl.getCanonicalLocales(normalized)[0];
      } catch {
        return normalized;
      }
    }
    return getProviderLanguageCode(normalized, 'DEEPL');
  }

  /**
   * Validate XML placeholder integrity in DeepL response
   * @param {string} requestText - Original text sent to DeepL
   * @param {string} responseText - Translated text received from DeepL
   * @returns {Object} Validation result with isValid flag and error details
   */
  _validateXMLPlaceholders(requestText, responseText) {
    const xmlTagRegex = /<(?:x|br)\s+id\s*=\s*["']([A-Za-z0-9_]+)["']\s*\/?>/gi;

    // Extract XML tags from request
    const requestTags = requestText.match(xmlTagRegex);
    const requestTagCount = requestTags ? requestTags.length : 0;

    // Extract XML tags from response
    const responseTags = responseText.match(xmlTagRegex);
    const responseTagCount = responseTags ? responseTags.length : 0;

    // Check 1: Tag count mismatch
    if (requestTagCount !== responseTagCount) {
      return {
        isValid: false,
        error: 'tag_count_mismatch',
        details: {
          requestTagCount,
          responseTagCount
        }
      };
    }

    // Check 2: Validate tag syntax integrity (REMOVED)
    // DeepL API can sometimes alter spacing or expand tags, which causes false positives here.
    // As long as the tags can be parsed and IDs match, we are good.

    // Check 3: Verify all placeholder IDs are unique and present
    const requestIds = new Set();
    const requestIdMatch = /<(?:x|br)\s+id\s*=\s*["']([A-Za-z0-9_]+)["']\s*\/?>/gi;
    let match;
    while ((match = requestIdMatch.exec(requestText)) !== null) {
      requestIds.add(match[1]);
    }

    const responseIds = new Set();
    const responseIdMatch = /<(?:x|br)\s+id\s*=\s*["']([A-Za-z0-9_]+)["']\s*\/?>/gi;
    while ((match = responseIdMatch.exec(responseText)) !== null) {
      const id = match[1];
      if (responseIds.has(id)) {
        // Duplicate ID found
        return {
          isValid: false,
          error: 'duplicate_ids',
          details: {
            duplicateId: id
          }
        };
      }
      responseIds.add(id);
    }

    // Check 4: All request IDs present in response
    for (const id of requestIds) {
      if (!responseIds.has(id)) {
        return {
          isValid: false,
          error: 'missing_ids',
          details: {
            missingId: id
          }
        };
      }
    }

    return {
      isValid: true,
      details: {
        requestTagCount,
        responseTagCount
      }
    };
  }

  /**
   * Translate a single chunk of texts using DeepL API
   * @param {string[]} chunkTexts - Texts in this chunk
   * @param {string} sourceLang - Source language (DeepL code)
   * @param {string} targetLang - Target language (DeepL code)
   * @param {string} translateMode - Translation mode
   * @param {AbortController} abortController - Cancellation controller
   * @param {number} retryAttempt - Current retry attempt
   * @param {number} segmentCount - Total number of segments in this chunk
   * @param {number} chunkIndex - Current chunk index
   * @param {number} totalChunks - Total number of chunks
   * @param {Object} options - Additional options (sessionId, originalCharCount)
   * @returns {Promise<string[]>} - Translated texts for this chunk
   */
  async _translateChunk(chunkTexts, sourceLang, targetLang, translateMode, abortController, retryAttempt, segmentCount, chunkIndex, totalChunks, options = {}) {
    // Recover sessionId from abortController if available
    const sessionId = options.sessionId || abortController?.sessionId;
    const context = `${this.providerName.toLowerCase()}-translate-chunk`;

    // Normalize language codes with explicit source/target semantics.
    const sl = this._getSourceLangCode(sourceLang);
    const tl = this._getTargetLangCode(targetLang);

    // Get configuration and validate API key
    const { apiKey, apiUrl, apiTier, apiKeys } = await this._getConfig();

    // Validate configuration
    this._validateConfig(
      { apiKey, apiUrl },
      ["apiKey", "apiUrl"],
      context
    );

    // Filter out empty or whitespace-only texts (DeepL rejects them)
    // Use getTextInfo to extract text from objects (Subtitle cues, Select Element)
    const validTexts = chunkTexts
      .map(item => getTextInfo(item).text)
      .filter(text => text && text.trim().length > 0);

    if (validTexts.length === 0) {
      logger.warn('[DeepL] No valid texts to translate after filtering');
      return chunkTexts.map(() => '');
    }

    // CRITICAL: Pre-compile regex patterns FIRST, before any usage
    // Build control character pattern from character codes to avoid lint errors
    const CONTROL_CHAR_CODES = [
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,  // \x00-\x08
      0x0B, 0x0C,  // \x0B-\x0C (vertical tab, form feed)
      0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,  // \x0E-\x1F
      0x7F  // DEL
    ];
    const CONTROL_CHARS_PATTERN = new RegExp(`[${CONTROL_CHAR_CODES.map(c => String.fromCharCode(c)).join('')}]`, 'g');
    const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;
    const SPECIAL_UNICODE_PATTERN = /[\uFFF0-\uFFFF]/g;

    // Pattern to detect potentially problematic characters BEFORE escaping
    // These cause "not well-formed" errors in XML mode
    const PROBLEMATIC_XML_CHARS = /[<>&]|&#?\w+;/;

    // Unescape XML entities back to original characters after translation
    const unescapeXML = (text) => {
      if (!text) return text;
      return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');  // Must be last to avoid double-unescaping
    };

    // PRE-FLIGHT: Detect texts with problematic XML characters
    // This helps identify which segments would cause HTTP 400 errors
    const problematicIndices = [];
    validTexts.forEach((text, i) => {
      if (PROBLEMATIC_XML_CHARS.test(text)) {
        problematicIndices.push(i);
      }
    });

    if (problematicIndices.length > 0) {
      logger.debug(`[DeepL] Pre-flight: Found ${problematicIndices.length} texts with XML-special chars (indices: ${problematicIndices.join(', ')}) - will escape them`);
    }

    if (validTexts.length < chunkTexts.length) {
      logger.debug(`[DeepL] Filtered ${chunkTexts.length - validTexts.length} empty/whitespace texts`);
    }

    const sanitizeText = (text, escapeXml = true) => {
      const originalLength = text.length;
      let sanitized = text
        .replace(ZERO_WIDTH_PATTERN, '')  // Zero-width characters
        .replace(CONTROL_CHARS_PATTERN, '')  // Control chars except \n, \r, \t
        .replace(SPECIAL_UNICODE_PATTERN, '');  // Other special Unicode characters

      // CRITICAL: Escape XML special characters BEFORE adding XML markers
      // This prevents "not well-formed (invalid token)" errors when tag_handling=xml
      // Order matters: escape & first, then < and >
      if (escapeXml) {
        sanitized = sanitized
          .replace(/&/g, '&amp;')           // Must be first to avoid double-escaping
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      // Log if sanitization removed any characters
      if (sanitized.length !== originalLength) {
        logger.debug(`[DeepL] Sanitization processed ${originalLength} char text`);
      }

      return sanitized;
    };

    const textsToTranslate = validTexts.map(text => {
      // CRITICAL: Sanitize text before processing to remove problematic characters
      let sanitizedText = sanitizeText(text);

      // CRITICAL: Convert SubtitleTextProtector tokens to DeepL XML tags
      // Do this AFTER sanitization so the < and > don't get escaped
      
      // 1. Convert newline tokens to <br> tags. This is crucial because DeepL treats <br> as a hard 
      // sentence boundary and will not merge sentences across it or move it to the edges.
      sanitizedText = sanitizedText.replace(/@@SUB_NL_([A-Za-z0-9_]+)@@/g, '<br id="SUB_NL_$1" />');
      
      // 2. Convert other tokens (formatting, styles) to standard <x> placeholders
      sanitizedText = sanitizedText.replace(/@@SUB_([A-Za-z0-9_]+)@@/g, '<x id="SUB_$1" />');

      // Protect any other newlines using the unified NewlineManager
      let textWithMarkers = NewlineManager.protect(sanitizedText);
      
      // Convert standard NewlineManager markers to HTML <br/> tags as well
      textWithMarkers = textWithMarkers.replace(/<n1\s*\/?>/gi, '<br/>');
      textWithMarkers = textWithMarkers.replace(/<n2\s*\/?>/gi, '<br/><br/>');
      
      return textWithMarkers;
    });

    // Step 1: Detect XML placeholders in request (after conversion)
    const hasXMLPlaceholders = textsToTranslate.some(text =>
      /<x\s+id\s*=\s*["'][A-Za-z0-9_]+["']\s*\/?>/gi.test(text)
    );

    logger.debug('[DeepL] XML placeholder detection:', {
      hasXMLPlaceholders,
      textCount: validTexts.length
    });

    logger.info(`[DeepL] Starting translation: ${validTexts.join('').length} chars, ${validTexts.length} segments (filtered from ${chunkTexts.length})`);

    const hasGeneratedXmlMarkup = textsToTranslate.some(text => GENERATED_XML_MARKUP_PATTERN.test(text));

    // Plain-text requests must preserve literal XML-looking text. XML mode
    // uses the escaped, marker-prepared variant above.
    const requestBody = new URLSearchParams();

    // DeepL uses empty source_lang for auto-detection
    if (sl && sl !== '') {
      requestBody.append('source_lang', sl);
    }
    requestBody.append('target_lang', tl);

    // DeepL accepts preference-style values universally, while strict formality
    // values require confirmed target capability from the v3 language catalog.
    const formality = await getDeeplFormalityAsync() || 'default';
    const strictFormality = formality === 'more' || formality === 'less';
    let canSendFormality = formality === 'prefer_more' || formality === 'prefer_less';
    if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
    if (strictFormality && apiKey) {
      try {
        const { catalog } = await fetchDeepLLanguageCatalogWithKeyFailover({
          apiKey: this._getCapabilityDiscoveryKeys(apiKey, apiKeys),
          apiTier,
          signal: abortController?.signal,
        });
        canSendFormality = matchDeepLFormality(catalog, targetLang) === 'supported';
      } catch {
        if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
        // Capability discovery is optional; translation should proceed without strict formality.
      }
    }
    if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
    if (formality !== 'default' && canSendFormality) {
      requestBody.append('formality', formality);
    }

    // XML capability gating: per official docs, tag_handling is a
    // source-and-target feature, so it must be confirmed on BOTH the source
    // and target language records (GET /v3/languages?resource=translate_text
    // &include=beta). Without tag_handling support DeepL translates tags as
    // regular text, so omitting tag_handling when generated <x>/<br> markup
    // is present is NOT a safe fallback — it would corrupt placeholders and
    // newline structure. Fail fast with LANGUAGE_PAIR_NOT_SUPPORTED instead
    // of translating as plain text. Narrow exception: texts with zero
    // generated <x>/<br> markup need no XML mode, so they take the
    // plain-text path without tag_handling even when capability metadata is
    // unavailable (fetch failure returns unknown) — nothing can be
    // corrupted. Metadata fetch failure with markup present also fails fast,
    // since correctness cannot be guaranteed.
    // CRITICAL: Add XML tag handling parameters
    // This enables DeepL's native XML tag preservation.
    // We MUST NOT use 'ignore_tags' for <x> or <n1> because DeepL's engine often completely deletes
    // empty ignored tags (which causes the translated output to lose SRT tags and newlines).
    // By simply enabling XML mode, DeepL treats them as structural elements and preserves them perfectly.
    if (hasGeneratedXmlMarkup) {
      if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
      let tagHandlingCapability = 'unknown';
      try {
        const { catalog } = await fetchDeepLLanguageCatalogWithKeyFailover({
          apiKey: this._getCapabilityDiscoveryKeys(apiKey, apiKeys),
          apiTier,
          signal: abortController?.signal,
        });
        tagHandlingCapability = matchDeepLTagHandling(catalog, sourceLang, targetLang);
      } catch {
        if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
        tagHandlingCapability = 'unknown';
      }
      if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
      if (tagHandlingCapability !== 'supported') {
        const capabilityError = new Error(
          `DeepL XML tag handling is not available for this language pair (capability: ${tagHandlingCapability})`,
        );
        capabilityError.type = ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED;
        throw capabilityError;
      }
      requestBody.append('tag_handling', 'xml');

      // IMPORTANT: Force DeepL to treat <n1>, <n2>, and <br> as hard sentence splits.
      // This prevents DeepL from artificially moving newline markers to the beginning or end of a translation block.
      requestBody.append('splitting_tags', 'n1,n2,br');

      logger.debug('[DeepL] XML tag handling enabled', {
        tag_handling: 'xml',
        splitting_tags: 'n1,n2,br'
      });
    } else {
      logger.debug('[DeepL] Plain-text path: no generated XML markup, omitting tag_handling', {
        textCount: validTexts.length
      });
    }

    (hasGeneratedXmlMarkup ? textsToTranslate : validTexts.map(text => sanitizeText(text, false)))
      .forEach(text => requestBody.append('text', text));

    // 1. Prepare rich context (Environmental + Compact History)
    // DeepL context is free and significantly improves quality for related segments.
    const { AIConversationHelper } = await import("./utils/AIConversationHelper.js");
    const richContext = await AIConversationHelper.prepareDeepLContext(sessionId, options.contextMetadata, translateMode);

    if (richContext) {
      requestBody.append('context', richContext);
      logger.debug('[DeepL] Rich context integrated', { 
        length: richContext.length,
        preview: richContext.substring(0, 100) + '...'
      });
    }

    // Additional options
    // CRITICAL: We must NOT use 'nonewlines' here. If we use 'nonewlines', DeepL treats the entire
    // block as a single sentence and will aggressively merge phrases (e.g. "OK\nLet's do it" -> "باشه انجامش بدیم")
    // which results in the newline being pushed to the very beginning or end of the string.
    // By using '1' (default), DeepL splits at newlines and preserves their exact structural position.
    requestBody.append('split_sentences', '1');
    requestBody.append('preserve_formatting', '1'); // true

    // Debug log the request (without exposing full text content)
    logger.debug('[DeepL] Request details:', {
      textCount: validTexts.length,
      totalChars: this._calculateTraditionalCharCount(validTexts),
      sourceLang: sl || 'auto',
      targetLang: tl,
      hasXMLPlaceholders,
      hasContext: !!richContext
    });

    const originalCharCount = chunkTexts.reduce((s, t) => s + getTextInfo(t).length, 0);

    try {
      if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
      const result = await this._executeRequest({
        url: apiUrl,
        fetchOptions: {
          method: "POST",
          headers: {
            "Authorization": `DeepL-Auth-Key ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: requestBody,
        },
        extractResponse: (data) => {
          if (!data?.translations || !Array.isArray(data.translations)) {
            const error = new Error('DeepL response has invalid format');
            error.type = ErrorTypes.API_RESPONSE_INVALID;
            throw error;
          }

          // DeepL returns array of translation objects for valid texts only
          if (data.translations.length !== validTexts.length || data.translations.some(t => typeof t?.text !== 'string' || !t.text.trim())) {
            const error = new Error('DeepL response omitted a translated segment');
            error.type = ErrorTypes.API_RESPONSE_INVALID;
            throw error;
          }
          const validTranslations = data.translations.map(t => t.text);

          // CRITICAL: Validate XML placeholders if present in request
          if (hasXMLPlaceholders) {
            for (let i = 0; i < validTranslations.length; i++) {
              const requestText = textsToTranslate[i];
              const responseText = validTranslations[i];

              const validation = this._validateXMLPlaceholders(requestText, responseText);

              if (!validation.isValid) {
                logger.error('[DeepL] XML placeholder validation failed', {
                  index: i,
                  error: validation.error,
                  details: validation.details
                });

                // Throw special error with XML corruption flag to trigger fallback
                const error = new Error(`XML placeholder validation failed: ${validation.error}`);
                error.isXMLCorruptionError = true;
                error.validationDetails = validation.details;
                error.errorIndex = i;
                throw error;
              }
            }

            logger.debug('[DeepL] XML placeholder validation passed for all translations');
          }

          const detectedLanguages = data.translations
            .map(translation => translation?.detected_source_language)
            .filter(language => typeof language === 'string' && language.trim())
            .map(language => language.toLowerCase().trim());
          if (detectedLanguages.length > 0 && detectedLanguages.every(language => language === detectedLanguages[0])) {
            this._setExecutionDetectedLanguage(options, detectedLanguages[0]);
          }

          // Restore ALL newlines using the unified NewlineManager
          const restoredTranslations = validTranslations.map(translation => {
            let restored = translation;

            if (hasGeneratedXmlMarkup) {
              // Restore standard <br/> tags back to newlines and markers.
              restored = restored.replace(/<br\s*\/?>/gi, '\n');
              restored = NewlineManager.restore(restored);

              // Unescape XML entities back to original characters.
              restored = unescapeXML(restored);

              // Restore SubtitleTextProtector tokens.
              restored = restored.replace(/<br\s+id\s*=\s*["']SUB_NL_([A-Za-z0-9_]+)["']\s*\/?>\s*(?:<\/br>\s*)?/gi, '@@SUB_NL_$1@@');
              restored = restored.replace(/<x\s+id\s*=\s*["']SUB_([A-Za-z0-9_]+)["']\s*\/?>\s*(?:<\/x>\s*)?/gi, '@@SUB_$1@@');
            }

            return restored;
          });

          // Map translations back to original chunkTexts order
          // Fill in empty strings for filtered texts
          const result = [];
          let validIndex = 0;

          for (let i = 0; i < chunkTexts.length; i++) {
            const text = getTextInfo(chunkTexts[i]).text;
            if (text && text.trim().length > 0) {
              // This text was translated - use restored translation
               result.push(restoredTranslations[validIndex]);
              validIndex++;
            } else {
              // This text was filtered out, return empty
              result.push('');
            }
          }

          return result;
        },
        context,
        abortController,
        charCount: validTexts.join('').length,
        sessionId: options.sessionId,
        originalCharCount: options.originalCharCount || originalCharCount,
        callPurpose: options.callPurpose,
        apiKeyFailoverContext: Object.freeze({ apiTier }),
        updateApiKey: (newKey, options) => {
          if (options?.headers) {
            options.headers.Authorization = `DeepL-Auth-Key ${newKey}`;
          }
        }
      });

      const finalResult = result;
      if (!Array.isArray(finalResult) || finalResult.length !== chunkTexts.length || finalResult.some((translation, index) => {
        const source = getTextInfo(chunkTexts[index]).text;
        return source?.trim() && (typeof translation !== 'string' || !translation.trim());
      })) {
        const error = new Error('DeepL response has no complete translation result');
        error.type = ErrorTypes.API_RESPONSE_INVALID;
        throw error;
      }

      // Add completion log for successful translation
      if (finalResult.length > 0) {
        logger.info(`[DeepL] Translation completed successfully`);
      }

      return finalResult;
    } catch (error) {
      if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
      if (this._isUnsupportedLanguageError(error)) {
        error.type = ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED;
        throw error;
      }

      // CRITICAL: Check if this is an XML corruption error and trigger fallback
      if (error.isXMLCorruptionError) {
        error.type = ErrorTypes.API_RESPONSE_INVALID;
        throw error;
      }

      // Split only when shared request-size evidence says smaller payloads can recover.
      if (isProviderRequestSizeError(error) && validTexts.length > 1 && retryAttempt < 3) {
        logger.debug(`[DeepL] Request-size error, retrying with smaller chunks (${retryAttempt + 1}/3)`);

        const midPoint = Math.ceil(chunkTexts.length / 2);
        const firstHalf = chunkTexts.slice(0, midPoint);
        const secondHalf = chunkTexts.slice(midPoint);

        const results = [];
        for (const half of [firstHalf, secondHalf]) {
          if (abortController?.signal?.aborted) throw createOperationAbortError(abortController.signal);
          results.push(...await this._translateChunk(
            half, sourceLang, targetLang, translateMode, abortController,
            retryAttempt + 1, segmentCount, chunkIndex, totalChunks, options,
          ));
        }

        return results;
      }

      // Final fallback for request-size errors: translate each segment individually.
      if (isProviderRequestSizeError(error) && validTexts.length > 1 && retryAttempt >= 3) {
        logger.debug(`[DeepL] Exhausted request-size retries, attempting sequential fallback for ${validTexts.length} segments`);

        const results = [];
        for (const text of chunkTexts) {
          const originalText = getTextInfo(text).text;
          if (!originalText || originalText.trim().length === 0) {
            results.push('');
            continue;
          }

          // Simplified call for single segment fallback
          const res = await this._translateChunk([text], sourceLang, targetLang, translateMode, abortController, 5, 1, 0, 1, options);
          results.push(Array.isArray(res) ? res[0] : res);
        }

        logger.info(`[DeepL] Sequential fallback completed`);
        return results;
      }

      // Otherwise, rethrow the error
      const errorType = error.type || matchErrorToType(error);
      if (isFatalError(error) || isFatalError(errorType)) {
        if (!error.type) error.type = errorType;
      }
      throw error;
    }
  }
}

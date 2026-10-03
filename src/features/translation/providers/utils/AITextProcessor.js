/**
 * AI Text Processor - Handles text chunking, batching, and complexity calculation for AI providers
 * Includes placeholder protection and language-aware sentence splitting
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { getProviderBatching } from '../../core/ProviderConfigurations.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'AITextProcessor');

export const AITextProcessor = {
  /**
   * Create optimal batches based on provider strategy
   * @param {string[]} texts - Texts to translate
   * @param {string} providerName - Provider name
   * @param {string} translateMode - Translation mode
   * @param {object} defaults - Default configuration { strategy, optimalSize, maxComplexity }
   * @returns {string[][]} - Array of batches
   */
  createOptimalBatches(texts, providerName, translateMode = null, defaults = {}) {
    // CRITICAL: Check for placeholders and use atomic batching
    // When placeholders are present, NEVER split texts across batches
    if (this.hasPlaceholders(texts)) {
      logger.debug(`[${providerName}] Placeholders detected in ${texts.length} texts, using atomic batching`);
      return [texts]; // Single batch to preserve placeholder integrity
    }

    // Get mode-specific batching configuration
    const batchingConfig = this.getBatchingConfig(providerName, translateMode, defaults);
    const strategy = batchingConfig.strategy || defaults.strategy;
    const optimalSize = batchingConfig.optimalSize || defaults.optimalSize;
    const maxComplexity = batchingConfig.maxComplexity || defaults.maxComplexity;
    const maxBatchSizeChars = batchingConfig.maxBatchSizeChars;

    // For Select Element mode with character target, use character-based batching
    if (translateMode === 'select_element' && maxBatchSizeChars) {
      return this.createCharacterBasedBatches(texts, providerName, maxBatchSizeChars, batchingConfig.balancedBatching);
    }

    switch (strategy) {
      case 'smart':
        return this.createSmartBatches(texts, providerName, optimalSize, maxComplexity);
      case 'single':
        return [texts]; // All texts in one batch
      case 'fixed':
      default:
        return this.createFixedBatches(texts, providerName, optimalSize);
    }
  },

  /**
   * Check if any text contains placeholder markers
   * @param {string[]} texts - Texts to check
   * @returns {boolean} - True if placeholders found
   */
  hasPlaceholders(texts) {
    const PLACEHOLDER_PATTERN = /\[\[AIWC-\d+\]\]/;
    return texts.some(text => {
      const content = typeof text === 'object' ? (text.t || text.text || '') : text;
      return content && PLACEHOLDER_PATTERN.test(content);
    });
  },

  /**
   * Create smart batches based on complexity and segment count
   * @param {string[]} texts - Texts to translate
   * @param {string} providerName - Provider name
   * @param {number} optimalSize - Optimal batch size
   * @param {number} maxComplexity - Maximum complexity per batch
   * @returns {string[][]} - Array of batches
   */
  createSmartBatches(texts, providerName, optimalSize, maxComplexity) {
    const totalSegments = texts.length;
    const totalComplexity = this.getTotalComplexity(texts);
    
    // Smart batching logic - only avoid splitting if BOTH segments and complexity are low
    if (totalSegments <= Math.min(20, optimalSize) && totalComplexity < Math.min(300, maxComplexity)) {
      logger.debug(`[${providerName}] Using single batch for ${totalSegments} segments (complexity: ${totalComplexity})`);
      return [texts];
    }
    
    // Create multiple batches
    const batches = [];
    let currentBatch = [];
    let currentComplexity = 0;
    
    for (const text of texts) {
      const content = typeof text === 'object' ? (text.t || text.text || '') : text;
      const textComplexity = this.calculateTextComplexity(content);
      
      if (currentBatch.length >= optimalSize || 
          (currentComplexity + textComplexity > maxComplexity && currentBatch.length > 0)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentComplexity = 0;
      }
      
      currentBatch.push(text);
      currentComplexity += textComplexity;
    }
    
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
    logger.debug(`[${providerName}] Created ${batches.length} smart batches for ${totalSegments} segments`);
    return batches;
  },

  /**
   * Create fixed-size batches
   * @param {string[]} texts - Texts to translate
   * @param {string} providerName - Provider name
   * @param {number} batchSize - Fixed batch size
   * @returns {string[][]} - Array of batches
   */
  createFixedBatches(texts, providerName, batchSize) {
    const batches = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }
    logger.debug(`[${providerName}] Created ${batches.length} fixed batches (size: ${batchSize})`);
    return batches;
  },

  /**
   * Create character-based batches for optimal API usage in Select Element mode
   * @param {string[]} texts - Texts to translate
   * @param {string} providerName - Provider name
   * @param {number} maxCharsPerBatch - Maximum characters per batch
   * @param {boolean} balancedBatching - Enable balanced batch sizes
   * @returns {string[][]} - Array of batches
   */
  createCharacterBasedBatches(texts, providerName, maxCharsPerBatch, balancedBatching = false) {
    const totalChars = texts.reduce((sum, text) => {
      const content = typeof text === 'object' ? (text.t || text.text || '') : text;
      return sum + (content?.length || 0);
    }, 0);

    // If total content fits in one batch, return early to avoid unnecessary splitting
    if (totalChars <= maxCharsPerBatch) {
      logger.debug(`[${providerName}] Total content (${totalChars} chars) fits in single batch (limit: ${maxCharsPerBatch}), skipping batching`);
      return [texts];
    }

    const idealBatchCount = Math.ceil(totalChars / maxCharsPerBatch);
    const balancedBatchSize = Math.ceil(totalChars / Math.min(idealBatchCount + 1, texts.length));

    const batches = [];
    let currentBatch = [];
    let currentChars = 0;
    const targetBatchChars = balancedBatching ? Math.min(balancedBatchSize, maxCharsPerBatch) : maxCharsPerBatch;

    for (const text of texts) {
      const content = typeof text === 'object' ? (text.t || text.text || '') : text;
      const textLength = content?.length || 0;

      // If adding this text would exceed the limit and we have items in the batch, create new batch
      if (currentChars + textLength > targetBatchChars && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      // If a single text exceeds the limit, it goes in its own batch
      if (textLength > targetBatchChars) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentChars = 0;
        }
        batches.push([text]); // Single item batch for oversized text
        continue;
      }

      currentBatch.push(text);
      currentChars += textLength;
    }

    // Add the last batch if it has items
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    logger.debug(`[${providerName}] Created ${batches.length} ${balancedBatching ? 'balanced' : ''}character-based batches for ${texts.length} segments (${totalChars} chars, target: ${targetBatchChars} chars/batch)`);

    return batches;
  },

  /**
   * Calculate total complexity of all texts
   * @param {string[]} texts - Texts to analyze
   * @returns {number} - Total complexity score
   */
  getTotalComplexity(texts) {
    return texts.reduce((sum, text) => {
      const content = typeof text === 'object' ? (text.t || text.text || '') : text;
      return sum + this.calculateTextComplexity(content);
    }, 0);
  },

  /**
   * Calculate complexity of a single text
   * @param {string} text - Text to analyze
   * @returns {number} - Complexity score
   */
  calculateTextComplexity(text) {
    if (!text || typeof text !== 'string') return 0;
    
    const length = text.length;
    const sentences = (text.match(/[.!?]+/g) || []).length;
    const words = text.trim().split(/\s+/).length;
    
    // Base complexity from character count
    let complexity = Math.min(length * 0.5, 100);
    
    // Bonus for sentence structure
    complexity += sentences * 2;
    
    // Bonus for word density
    complexity += Math.min(words * 0.5, 20);
    
    return Math.round(complexity);
  },

  /**
   * Split text into sentences using Intl.Segmenter API (100+ language support)
   * @param {string} text - Text to split
   * @param {string} sourceLanguage - Source language code
   * @returns {string[]} - Array of sentences
   */
  splitIntoSentences(text, sourceLanguage = 'en') {
    // Use Intl.Segmenter for culture-aware sentence splitting
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const segmenter = new Intl.Segmenter(sourceLanguage, { granularity: 'sentence' });
        const segments = segmenter.segment(text);
        return Array.from(segments).map(s => s.segment);
      } catch (error) {
        logger.debug(`Intl.Segmenter failed for ${sourceLanguage}, falling back to regex:`, error.message);
      }
    }

    // Fallback to regex-based splitting
    return this.fallbackSentenceSplitting(text);
  },

  /**
   * Fallback sentence splitting using regex
   * @param {string} text - Text to split
   * @returns {string[]} - Array of sentences
   */
  fallbackSentenceSplitting(text) {
    const sentences = text.split(/(?<=[.!?。！？])\s+/);
    return sentences.filter(s => s.trim().length > 0);
  },

  /**
   * Smart chunking with placeholder boundary protection
   * Ensures ALL resulting chunks are below the character limit
   * @param {string} text - Text to chunk
   * @param {number} limit - Character limit per chunk
   * @param {string} sourceLanguage - Source language code
   * @returns {string[]} - Array of text chunks
   */
  smartChunkWithPlaceholders(text, limit, sourceLanguage = 'en') {
    if (text.length <= limit) {
      return [text];
    }

    // Phase 1: Split by Paragraphs
    let chunks = this._splitAtParagraphBoundaries(text, limit);
    
    // Phase 2: If any chunk is still too large, split it by Sentences
    if (this._hasOversizedChunks(chunks, limit)) {
      let sentenceChunks = [];
      for (const chunk of chunks) {
        if (chunk.length > limit) {
          const sentences = this.splitIntoSentences(chunk, sourceLanguage);
          sentenceChunks.push(...this._groupSentencesIntoChunks(sentences, limit));
        } else {
          sentenceChunks.push(chunk);
        }
      }
      chunks = sentenceChunks;
    }

    // Phase 3: If any chunk is STILL too large, split it by Words
    if (this._hasOversizedChunks(chunks, limit)) {
      let wordChunks = [];
      for (const chunk of chunks) {
        if (chunk.length > limit) {
          wordChunks.push(...this._splitAtWordBoundaries(chunk, limit));
        } else {
          wordChunks.push(chunk);
        }
      }
      chunks = wordChunks;
    }

    // Phase 4: Validate placeholder boundaries
    if (!this.validatePlaceholderBoundaries(chunks, text)) {
      logger.warn(`Cannot chunk without splitting placeholders, using single batch`);
      return [text];
    }

    return chunks;
  },

  /**
   * Check if any chunk in the array exceeds the limit
   * @private
   */
  _hasOversizedChunks(chunks, limit) {
    return chunks.some(chunk => chunk.length > limit);
  },

  /**
   * Split text at word boundaries (spaces)
   * @private
   */
  _splitAtWordBoundaries(text, limit) {
    const words = text.split(/\s+/);
    const chunks = [];
    let currentChunk = '';

    for (const word of words) {
      if ((currentChunk + ' ' + word).length > limit && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = word;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + word;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  },

  /**
   * Split text at paragraph boundaries
   * @private
   */
  _splitAtParagraphBoundaries(text, limit) {
    const paragraphs = text.split(/\n\n+/);
    const chunks = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if ((currentChunk + paragraph).length > limit && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  },

  /**
   * Group sentences into chunks respecting character limit
   * @private
   */
  _groupSentencesIntoChunks(sentences, limit) {
    const chunks = [];
    let currentChunk = '';
    let currentLength = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.length;

      if (currentLength + sentenceLength > limit && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
        currentLength = sentenceLength;
      } else {
        currentChunk += sentence;
        currentLength += sentenceLength;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  },

  /**
   * Validate that placeholder boundaries are preserved
   * @param {string[]} chunks - Array of text chunks
   * @param {string} originalText - Original text
   * @returns {boolean} - True if placeholders are intact
   */
  validatePlaceholderBoundaries(chunks, originalText) {
    const PLACEHOLDER_PATTERN = /\[\[AIWC-\d+\]\]/g;

    // Count placeholders in original text
    const originalMatches = originalText.match(PLACEHOLDER_PATTERN);
    const originalCount = originalMatches ? originalMatches.length : 0;

    // Count placeholders in all chunks
    let chunkCount = 0;
    for (const chunk of chunks) {
      const matches = chunk.match(PLACEHOLDER_PATTERN);
      if (matches) {
        chunkCount += matches.length;
      }

      // Check for broken placeholders: 
      // 1. Starts with end of placeholder: ^\d+\]\]
      // 2. Ends with start of placeholder: \[\[AIWC-\d+$
      // 3. Contains partial markers not forming a full placeholder
      const brokenPattern = /\[\[AIWC-\d+$|^\d+\]\]/;
      if (brokenPattern.test(chunk)) {
        logger.error(`Found broken placeholder in chunk`);
        return false;
      }
    }

    return chunkCount === originalCount;
  },

  /**
   * Check if a position is inside a placeholder marker
   */
  isInsidePlaceholder(text, position) {
    const PLACEHOLDER_PATTERN = /\[\[AIWC-\d+\]\]/g;
    const matches = [...text.matchAll(PLACEHOLDER_PATTERN)];

    for (const match of matches) {
      const startIndex = match.index;
      const endIndex = match.index + match[0].length;

      if (position >= startIndex && position < endIndex) {
        return true;
      }

      // Protect 2 characters before and after
      if (Math.abs(position - startIndex) <= 2 || Math.abs(position - endIndex) <= 2) {
        return true;
      }
    }

    return false;
  },

  /**
   * Get batching configuration for a specific translation mode
   */
  getBatchingConfig(providerName, translateMode = null, defaults = {}) {
    try {
      return getProviderBatching(providerName, translateMode);
    } catch (error) {
      logger.debug(`[${providerName}] Failed to load batching config, using defaults:`, error.message);
      return {
        strategy: defaults.strategy,
        optimalSize: defaults.optimalSize,
        maxComplexity: defaults.maxComplexity
      };
    }
  },

  /**
   * Calculate network character count for AI payload (messages array or content object)
   * @param {Array|object} messages - Input data to measure
   * @returns {number} - Total character count
   */
  calculatePayloadChars(messages) {
    if (!messages) return 0;
    
    // Handle single object (like Gemini system instruction or WebAI prompt)
    if (!Array.isArray(messages)) {
      return this._measureMessageContent(messages);
    }

    return messages.reduce((sum, msg) => sum + this._measureMessageContent(msg), 0);
  },

  /**
   * Internal helper to measure content of a single message object
   * @private
   */
  _measureMessageContent(msg) {
    if (!msg) return 0;

    // 1. Standard 'content' field (OpenAI, DeepSeek, OpenRouter)
    if (msg.content) {
      return typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
    }

    // 2. Gemini 'parts' array
    if (Array.isArray(msg.parts)) {
      return msg.parts.reduce((sum, part) => {
        if (part.text) return sum + part.text.length;
        if (part.inline_data?.data) return sum + part.inline_data.data.length;
        return sum + JSON.stringify(part).length;
      }, 0);
    }

    // 3. WebAI 'message' field
    if (msg.message) return String(msg.message).length;

    // 4. Fallback: measure the whole object if it doesn't match known formats
    if (typeof msg === 'object') {
      // Exclude metadata fields from count if possible, but for safety measure the whole string
      return JSON.stringify(msg).length;
    }

    return String(msg).length;
  },

  /**
   * Estimate original chars from a JSON string payload
   * @param {string|object} jsonInput - Input JSON
   * @returns {number} - Estimated character count
   */
  estimateOriginalChars(jsonInput) {
    if (!jsonInput) return 0;
    let data = jsonInput;
    if (typeof jsonInput === 'string') {
      try {
        data = JSON.parse(jsonInput);
      } catch {
        return jsonInput.length;
      }
    }
    
    // Handle wrapped AI batch format {"translations": [...]}
    if (typeof data === 'object' && data !== null && Array.isArray(data.translations)) {
      data = data.translations;
    }

    if (!Array.isArray(data)) return String(jsonInput).length;
    
    return data.reduce((sum, item) => {
      const text = typeof item === 'object' ? (item.t || item.text || '') : String(item);
      return sum + text.length;
    }, 0);
  }
};

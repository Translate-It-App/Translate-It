/**
 * Newline Manager - Utility for preserving line breaks during translation
 * Uses XML-like markers to protect newlines from being collapsed by providers or processors.
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'NewlineManager');

export const NewlineManager = {
  MARKERS: {
    SINGLE: '<n1/>', // Represents \n
    DOUBLE: '<n2/>', // Represents \n\n
  },

  /**
   * Protects newlines by replacing them with XML-safe markers.
   * @param {string} text - Original text
   * @returns {string} - Protected text
   */
  protect(text) {
    if (!text || typeof text !== 'string') return text;

    // logger.debug('Protecting newlines in text', { length: text.length });

    // 1. Replace double (or more) newlines first
    let processed = text.replace(/\n\n+/g, (match) => {
      // For \n\n\n, we could use <n2/><n1/>, but usually <n2/> is enough for paragraphs
      const doubleCount = Math.floor(match.length / 2);
      const remains = match.length % 2;
      return this.MARKERS.DOUBLE.repeat(doubleCount) + (remains ? this.MARKERS.SINGLE : '');
    });

    // 2. Replace remaining single newlines
    processed = processed.replace(/\n/g, this.MARKERS.SINGLE);

    return processed;
  },

  /**
   * Restores newlines from markers.
   * @param {string} text - Translated text with markers
   * @returns {string} - Restored text
   */
  restore(text) {
    if (!text || typeof text !== 'string') return text;

    // logger.debug('Restoring newlines from markers', { length: text.length });

    let restored = text;

    // 1. Restore double newlines first
    restored = restored.replace(/<n2\s*\/?>/gi, '\n\n');

    // 2. Restore single newlines
    restored = restored.replace(/<n1\s*\/?>/gi, '\n');

    return restored;
  },

  /**
   * Checks if a text contains newline markers.
   */
  hasMarkers(text) {
    return typeof text === 'string' && (text.includes('<n1') || text.includes('<n2'));
  }
};

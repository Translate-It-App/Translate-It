import { PAGE_TRANSLATION_ATTRIBUTES } from './PageTranslationConstants.js';
import { DOM_FILTERS } from '@/utils/dom/DomFilters.js';
import { walkOpenShadowTree } from '@/utils/dom/walkOpenShadowTree.js';

/**
 * PageTranslationHelper - Utility methods for whole page translation
 */
export class PageTranslationHelper {
  /**
   * Normalize text for consistent tracking and comparison
   */
  static normalizeText(text) {
    if (!text) return '';
    return text.trim().replace(/\s+/g, ' ');
  }

  /**
   * Determine if a text should be translated.
   */
  static shouldTranslate(text) {
    if (!text) return false;
    const trimmed = text.trim();
    
    // Skip empty or purely whitespace strings
    if (!trimmed) return false;

    // 1. Structural/Technical Filters (Regex)
    // These items are universally non-translatable and often occur in technical content
    if (DOM_FILTERS.isTechnicalPattern(trimmed)) return false;

    // 1b. BIDI/zero-width formatting-mark-only text (no visible glyphs to translate)
    if (DOM_FILTERS.isFormattingOnly(trimmed)) return false;

    // 2. Numeric and Metric Filters
    const isNumeric = DOM_FILTERS.NUMERIC_REGEX.test(trimmed);
    const isTime = DOM_FILTERS.TIME_REGEX.test(trimmed);
    
    // ALLOW 2+ character words for English (e.g., "In", "On", "Go")
    // For Farsi/Arabic, we already have special handling.
    const isTooShort = trimmed.length < 2 && !/[\u0600-\u06FF]/.test(trimmed);
    const isMetric = DOM_FILTERS.METRIC_REGEX.test(trimmed);

    const shouldSkip = isNumeric || isTime || isTooShort || isMetric;

    return !shouldSkip;
  }

  /**
   * Deeply clean all translation-related markers from the DOM.
   * This is crucial for allowing re-translation and clean restoration.
   */
  static deepCleanDOM(root = document.documentElement) {
    const { TRANSLATED_MARKER, TRANSLATE_DIR, HAS_ORIGINAL } = PAGE_TRANSLATION_ATTRIBUTES;

    // 1. Remove our own markers and direction attributes from all elements
    // We do NOT touch 'dir' here because restoreElementDirection (called by bridge.restore)
    // should have already handled it properly using saved original state.
    walkOpenShadowTree(root, (element) => {
      if (!element.hasAttribute(TRANSLATED_MARKER)
          && !element.hasAttribute(TRANSLATE_DIR)
          && !element.hasAttribute(HAS_ORIGINAL)) return;
      element.removeAttribute(TRANSLATED_MARKER);
      element.removeAttribute(TRANSLATE_DIR);
      element.removeAttribute(HAS_ORIGINAL);
    });

    // 2. Specific reset for common containers (just the markers)
    const containers = ['html', 'body', 'main', 'article', 'section'];
    containers.forEach(tag => {
      const el = document.querySelector(tag);
      if (el) {
        el.removeAttribute(TRANSLATED_MARKER);
        el.removeAttribute(TRANSLATE_DIR);
        el.removeAttribute(HAS_ORIGINAL);
      }
    });
  }

  /**
   * Finds the nearest semantic container for a node to group related texts.
   * This helps in "Logical Context Batching" to prevent language detection traps.
   * 
   * @param {Node} node - The DOM node
   * @returns {HTMLElement|null} The nearest semantic container element
   */
  static getNearestSemanticContainer(node) {
    if (!node) return null;
    
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement :
                 (node.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node);
    
    if (!element) return null;

    // Define semantic tags that represent a logical context
    const semanticTags = new Set([
      'ARTICLE', 'ASIDE', 'NAV', 'SECTION', 'HEADER', 'FOOTER', 
      'MAIN', 'FORM', 'BLOCKQUOTE', 'UL', 'OL'
    ]);

    let current = element;
    let depth = 0;
    const MAX_DEPTH = 10; // Performance safety limit

    while (current && depth < MAX_DEPTH) {
      if (semanticTags.has(current.tagName)) {
        return current;
      }
      
      // Special case for Twitter/React: check for roles
      const role = current.getAttribute('role');
      if (role === 'article' || role === 'navigation' || role === 'main') {
        return current;
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  /**
   * Check if a node is within the viewport plus a given margin.
   * This is used for prioritization and lazy loading.
   * 
   * STRATEGY: For Text Nodes, we use Range.getBoundingClientRect() to get precise
   * coordinates of the text itself. This prevents over-translation of off-screen 
   * text that shares a large visible parent container.
   * 
   * @param {Node} node - The DOM node to check (Text, Attribute or Element)
   * @param {number} margin - Extra safety margin in pixels
   * @param {Object} logger - Optional logger for debugging
   * @returns {boolean}
   */
  static isInViewportWithMargin(node, margin, logger = null) {
    return this.classifyVisibility(node, margin, logger) !== 'offscreen';
  }

  /** Classify a node's current geometry without retaining it between checks. */
  static classifyVisibility(node, bufferMargin, logger = null) {
    if (!node) return 'offscreen';
    try {
      let rect;

      // 1. Precise Viewport Detection for Text Nodes
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement || !node.isConnected) return 'offscreen';

        // Use a shared Range to prevent GC pressure during high-frequency scrolling
        if (!this._sharedRange) {
          this._sharedRange = document.createRange();
        }
        
        this._sharedRange.selectNodeContents(node);
        rect = this._sharedRange.getBoundingClientRect();

        // Fallback: If text node has no dimensions (0x0), it might be a quirk 
        // or a zero-width element. Fallback to parent element for safety.
        if (rect.width === 0 && rect.height === 0) {
          rect = node.parentElement.getBoundingClientRect();
        }
      } else {
        // 2. Detection for Elements and Attributes
        const element = node.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node;
        if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.isConnected) return 'offscreen';
        rect = element.getBoundingClientRect();
      }
      
      // If the bounding box has no dimensions, it's effectively invisible (e.g., display: none)
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return 'offscreen';
      }

      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

      if (this._intersectsViewport(rect, 0, viewportHeight, viewportWidth)) return 'viewport';
      if (this._intersectsViewport(rect, bufferMargin, viewportHeight, viewportWidth)) return 'buffer';
      return 'offscreen';
    } catch (e) {
      if (logger) logger.debug('Error in classifyVisibility', e);
      return 'offscreen';
    }
  }

  static _intersectsViewport(rect, margin, viewportHeight, viewportWidth) {
    return rect.bottom >= -margin && rect.top <= viewportHeight + margin
      && rect.right >= -margin && rect.left <= viewportWidth + margin;
  }

  static isSuitableForTranslation(logger = null) {
    if (window === window.top) return true;
    try {
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width < 50 || height < 50) {
        if (logger) logger.debug('Frame too small for translation', { width, height });
        return false;
      }
      const style = window.getComputedStyle(document.documentElement);
      if (style.display === 'none' || style.visibility === 'hidden') {
        if (logger) logger.debug('Frame hidden, skipping translation');
        return false;
      }
      return true;
    } catch (error) {
      if (logger) logger.debug('Error checking frame suitability', error);
      return window.innerWidth > 150 && window.innerHeight > 150;
    }
  }
}

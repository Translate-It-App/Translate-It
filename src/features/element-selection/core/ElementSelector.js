// ElementSelector - Handles element highlighting and selection
// Integrated with ContentScriptCore for global styles and navigation prevention

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';
import { isSelectableTextRoot } from '../utils/elementHelpers.js';
import { ToastElementDetector } from '@/shared/toast/ToastElementDetector.js';
import { iterateSelectElementAncestors } from '../utils/shadowDom.js';

/**
 * Element selection and highlighting functionality
 */
export class ElementSelector extends ResourceTracker {
  constructor() {
    super('element-selector');

    this.logger = getScopedLogger(LOG_COMPONENTS.ELEMENT_SELECTION, 'ElementSelector');

    // State
    this.currentHighlighted = null;
    this.highlightTimeout = null;
    this.isActive = false;

    // Configuration
    this.config = {
      minArea: 4000,
      maxArea: 120000,
      minTextLength: 20,
      minWordCount: 3,
      maxAncestors: 10,
      highlightTimeout: 100, // ms before clearing highlight on mouseout
    };

    // Highlight class name
    this.HIGHLIGHT_CLASS = 'translate-it-element-highlighted';

    this.logger.debug('ElementSelector created');
  }

  /**
   * Initialize the selector
   */
  async initialize() {
    this.logger.debug('Initializing ElementSelector');
    // Global styles are now managed by ContentScriptCore.injectMainDOMStyles()
    this.logger.debug('ElementSelector initialized');
  }

  /**
   * Activate the selection mode
   */
  activate() {
    this.isActive = true;
    this.logger.debug('ElementSelector activated');
  }

  /**
   * Deactivate the selection mode
   */
  deactivate() {
    this.isActive = false;
    this.clearHighlight();
    this.logger.debug('ElementSelector deactivated');
  }

  /**
   * Check if element belongs to the extension's UI (should be excluded from selection)
   * @param {HTMLElement} element - Element to check
   * @returns {boolean} Whether element is our UI
   */
  isOurElement(element) {
    if (!element) return false;

    // Use centralized ToastElementDetector for robust detection of toasts and extension UI
    if (ToastElementDetector.shouldExcludeFromSelection(element)) {
      return true;
    }
    
    // Fallback for specific Shadow DOM root check if needed (though ToastElementDetector handles this)
    if (element.id && (element.id === UI_HOST_IDS.MAIN || element.id === UI_HOST_IDS.IFRAME)) {
      return true;
    }

    return false;
  }

  /**
   * Handle mouse over event - highlight element
   * @param {HTMLElement} element - Element to highlight
   */
  handleMouseOver(element) {
    if (!this.isActive) return;

    // Guard against invalid elements
    if (!element || typeof element.hasAttribute !== 'function' || this.isOurElement(element)) {
      return;
    }

    // Find the best element to highlight
    const bestElement = this.findBestTextElement(element);

    if (!bestElement || typeof bestElement.hasAttribute !== 'function' || this.isOurElement(bestElement)) {
      return;
    }

    // A pointer may re-enter the same candidate before its delayed mouseout
    // clear fires. Cancel that clear before the same-element fast path.
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
      this.highlightTimeout = null;
    }

    // Skip if already highlighted
    if (bestElement === this.currentHighlighted) {
      return;
    }

    // Clear previous highlight
    this.clearHighlight();

    // Add highlight
    bestElement.classList.add(this.HIGHLIGHT_CLASS);
    bestElement.setAttribute('data-translate-highlighted', 'true');
    this.currentHighlighted = bestElement;

    this.logger.debug('Element highlighted', {
      tag: bestElement.tagName,
      textLength: bestElement.textContent?.length || 0,
    });
  }

  /**
   * Handle mouse out event - clear highlight with timeout
   */
  handleMouseOut(relatedTarget = null) {
    if (!this.isActive) return;

    if (this.currentHighlighted && relatedTarget && this.currentHighlighted.contains(relatedTarget)) {
      this.clearPendingHighlight();
      return;
    }

    // Clear any existing timeout
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
    }

    // Set timeout to clear highlight (prevents flicker)
    this.highlightTimeout = setTimeout(() => {
      this.clearHighlight();
    }, this.config.highlightTimeout);
  }

  clearPendingHighlight() {
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
      this.highlightTimeout = null;
    }
  }

  /**
   * Clear the current highlight
   */
  clearHighlight() {
    if (this.currentHighlighted) {
      this.currentHighlighted.classList.remove(this.HIGHLIGHT_CLASS);
      this.currentHighlighted.removeAttribute('data-translate-highlighted');
      this.currentHighlighted = null;
    }

    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
      this.highlightTimeout = null;
    }
  }

  /**
   * Find the best element to highlight for translation
   * @param {HTMLElement} startElement - Starting element
   * @returns {HTMLElement|null} Best element to highlight
   */
  findBestTextElement(startElement) {
    let maxAncestors = this.config.maxAncestors || 10;
    let blockFallback = null;
    let eligibleFallback = null;

    // Prefer the deepest meaningful block, rather than a tiny inline descendant.
    for (const element of iterateSelectElementAncestors(startElement)) {
      if (element === document.body || element === document.documentElement || maxAncestors-- <= 0) break;
      if (this.isSelectionCandidate(element)) {
        const area = element.offsetWidth * element.offsetHeight;
        const text = element.textContent?.trim() || '';
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const display = window.getComputedStyle(element).display;
        const isInline = display === 'inline' || display === 'contents';
        if (text.length > 0 && !eligibleFallback) {
          eligibleFallback = element;
        }
        if (!isInline && area > 0 && area <= this.config.maxArea && text.length > 0 && !blockFallback) {
          blockFallback = element;
        }

        if (
          !isInline &&
          area >= this.config.minArea &&
          area <= this.config.maxArea &&
          text.length >= this.config.minTextLength &&
          wordCount >= this.config.minWordCount
        ) {
          return element;
        }
      }

    }

    return blockFallback || eligibleFallback;
  }

  /**
   * Check if element is a valid candidate for text translation
   * Root eligibility comes from the shared isSelectableTextRoot contract
   * (policy root eligibility + ancestor notranslate + text content).
   * Selector-only heuristics (area, text length, word count) live in
   * findBestTextElement, NOT here and NOT in SelectElementPolicy.
   * @param {HTMLElement} element - Element to check
   * @returns {boolean} Whether element is valid
   */
  isSelectionCandidate(element) {
    if (!element) return false;
    
    // 1. Skip our own elements (extension UI)
    if (this.isOurElement(element)) {
      return false;
    }

    // 2. Use shared root-eligibility contract for text elements
    return isSelectableTextRoot(element);
  }

  /**
   * Get the currently highlighted element
   * @returns {HTMLElement|null} Current highlighted element
   */
  getHighlightedElement() {
    return this.currentHighlighted;
  }

  /**
   * Check if selector is active
   * @returns {boolean} Active status
   */
  isSelectorActive() {
    return this.isActive;
  }

  /**
   * Update configuration
   * @param {Object} newConfig - New configuration values
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.logger.debug('Configuration updated', this.config);
  }

  /**
   * Get current configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.logger.debug('Cleaning up ElementSelector');

    // Clear state
    this.deactivate();

    // Use ResourceTracker cleanup
    super.cleanup();

    this.logger.debug('ElementSelector cleanup completed');
  }
}

export default ElementSelector;

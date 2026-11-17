import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';
import { PAGE_TRANSLATION_ATTRIBUTES } from '@/features/page-translation/PageTranslationConstants.js';
import { detectDirectionFromContent, applyNodeDirection, captureNodeDirectionState, restoreNodeDirectionState, BIDI_MARKS } from '@/utils/dom/DomDirectionManager.js';
import { parseV3Intervals } from '@/features/translation/core/V3IntervalParser.js';
import { runBestEffortRollback } from '@/utils/dom/DomRollback.js';
import { iterateSelectElementAncestors } from '../utils/shadowDom.js';
import { getTranslationFontTarget, getSelectElementMixedFontTarget, isSelectElementFontTargetSafe } from '@/shared/fonts/TranslationFontPolicy.js';
import { applySelectElementMixedFontStyle, restoreSelectElementMixedFontStyle } from './SelectElementFontStyles.js';

const logger = getScopedLogger(LOG_COMPONENTS.ELEMENT_SELECTION, 'BlockGroupReconstructor');

export class BlockGroupMutationFailure {
  constructor(cause, rollbackFailures = []) {
    this.cause = cause;
    this.rollbackFailures = rollbackFailures;
  }
}

/**
 * Escapes a string for use in a RegExp.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reconstructor engine for whitespace-marker based translation block reconstruction.
 * Implements strict all-or-nothing transactional safety, pre-apply DOM revalidation,
 * printable ASCII-safe segment markers @@TI_SEG_uuid_nN@@, and flicker prevention.
 */
export class BlockGroupReconstructor {
  /**
   * Concatenates TranslationUnit texts into a single string joined by printable markers.
   *
   * @param {TranslationUnit[]} units - Array of TranslationUnits in the block group
   * @param {string} sessionId - Optional translation session ID
   * @param {string} entropy - Optional randomized entropy-scoped escaping prefix
   * @returns {string} The assembled block text
   */
  static injectMarkers(units, sessionId = '', entropy = '') {
    if (!units || units.length === 0) return '';
    
    // entropy-scoped escaping: @@ -> @@TI_ESC_<entropy>@@
    const escapePattern = /@@/g;
    const escapeReplacement = entropy ? `@@TI_ESC_${entropy}@@` : '@@TI_ESC@@';
    
    const escapeText = (text) => text.replace(escapePattern, escapeReplacement);

    // First node start is block start (no marker prefix)
    let result = escapeText(units[0].text);
    
    // Use session-scoped markers with ASCII-safe delimiters @@
    // Hardened Reconstruction Protocol: @@TI_SEG_<entropy>_<sessionId>_<segmentId>@@
    let markerPrefix;
    if (entropy && sessionId) {
      markerPrefix = `TI_SEG_${entropy}_${sessionId}_`;
    } else if (sessionId) {
      markerPrefix = `TI_SEG_${sessionId}_`;
    } else {
      markerPrefix = 'SEG_';
    }
    
    for (let i = 1; i < units.length; i++) {
      // @@ delimiters are ASCII-safe, model-resilient, and normalization-safe
      result += `@@${markerPrefix}${units[i].id}@@${escapeText(units[i].text)}`;
    }
    
    return result;
  }

  /**
   * Splitting and validating the translated block text.
   * Ensures absolute corruption detection and strict segment/UID order matching.
   *
   * @param {string} translatedText - Raw translated block text from LLM
   * @param {TranslationUnit[]} expectedUnits - The expected TranslationUnits in order
   * @param {string} sessionId - Optional session ID to validate
   * @param {string} entropy - Optional entropy-scoped escaping prefix
   * @returns {Object[]} Parsed segment objects { id, text }
   * @throws {Error} If markers are corrupted, count mismatches, or UID order is broken
   */
  static splitTranslatedBlock(translatedText, expectedUnits, sessionId = '', entropy = '') {
    if (!translatedText || typeof translatedText !== 'string') {
      throw new Error('Translated text is empty or invalid');
    }

    const parsed = parseV3Intervals(translatedText, {
      sessionId,
      entropy,
      grammar: sessionId ? 'ti' : 'legacy',
    });
    const segments = parsed.intervals.map((interval, index) => ({
      id: index === 0 ? expectedUnits[0]?.id : interval.markerId,
      text: interval.text || '',
    }));

    // --- Deterministic Structural Validation Gates ---
    
    // 1. Verify exact segment count matches expected. 
    // This catches duplicated/nested markers because split() would create more parts.
    if (segments.length !== expectedUnits.length) {
      throw new Error(`Segment count mismatch: expected ${expectedUnits.length}, received ${segments.length}`);
    }

    // 2. Verify each segment UID maps perfectly in the expected sequential order (Monotonicity)
    // Segment IDs must remain exact and case-sensitive.
    for (let i = 0; i < expectedUnits.length; i++) {
      if (segments[i].id !== expectedUnits[i].id) {
        throw new Error(`Structural validation failure (monotonicity): expected ${expectedUnits[i].id}, received ${segments[i].id}`);
      }
    }

    return segments;
  }

  /**
   * Applies the parsed translations atomically to the DOM.
   * Synchronously performs connection validation check first, ensuring absolute rollback safety.
   */
  static apply(expectedUnits, translatedText, targetLanguage, rootElement, sessionId = '', entropy = '', translationFontFamily = null) {
    if (!expectedUnits || expectedUnits.length === 0) {
      return false;
    }
 
    const blockId = expectedUnits[0].blockId;
    logger.debug(`[Reconstructor] Starting apply for block group ${blockId}`);

    // --- Hardened Reconstruction Protocol: Transaction-Scoped Bidi Cache ---
    // Instantiating a fresh cache per apply transaction ensures fresh direction lookups.
    const transactionCache = new WeakMap();
    const resolveDir = (node) => {
      if (!node || (!node.parentElement && !node.parentNode?.host)) return 'ltr';
      const el = node.parentElement || node.parentNode?.host;
      if (transactionCache.has(el)) return transactionCache.get(el);
      let direction = 'ltr';
      try {
        const dirNode = iterateSelectElementAncestors(node).find(parent => parent.hasAttribute('dir'));
        if (dirNode) direction = (dirNode.dir || dirNode.getAttribute('dir')).toLowerCase();
        else direction = window.getComputedStyle(el).direction || 'ltr';
      } catch {
        // Ignore errors in direction detection
      }
      transactionCache.set(el, direction);
      return direction;
    };

    // --- Read-Only Validation Phase (Pre-Apply Connection & Semantic Revalidation) ---
    // Use Unicode-aware whitespace normalization for validation
    const normalizeForValidation = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/[\s\u200B\u200C\u200D]+/gu, ' ').trim();

    for (const unit of expectedUnits) {
      if (!unit.node || !unit.node.isConnected) {
        throw new Error(`Stale or detached DOM node reference for segment ${unit.id}`);
      }
      
      const currentVal = unit.node.nodeValue || '';
      const expectedOriginalVal = unit.leadingWS + unit.text + unit.trailingWS;
      
      if (normalizeForValidation(currentVal) !== normalizeForValidation(expectedOriginalVal)) {
        throw new Error(`DOM node content changed mid-flight for segment ${unit.id}`);
      }
    }

    // --- Parsing & Structural Verification Phase ---
    // Pre-parsing sanitization: strip zero-width characters ONLY inside markers @@...@@
    const sanitizedText = translatedText.replace(/@@[\s\S]*?@@/gu, (match) => {
       return match.replace(/[\u200B-\u200D\uFEFF]/gu, '');
    });

    const parsedSegments = this.splitTranslatedBlock(sanitizedText, expectedUnits, sessionId, entropy);

    if (parsedSegments.some((segment, index) => (
      typeof segment.text !== 'string' || !segment.text.trim() ||
      typeof expectedUnits[index]?.text !== 'string' || !expectedUnits[index].text.trim()
    ))) {
      throw new Error('Invalid translated segment content');
    }

    // --- Preparation Phase (Calculate everything before DOM mutations) ---
    const commitPlan = [];
    const unescapeReplacement = '@@';
    const unescapePattern = entropy ? new RegExp(`@@TI_ESC_${escapeRegExp(entropy)}@@`, 'g') : /@@TI_ESC@@/g;

    for (let i = 0; i < expectedUnits.length; i++) {
      const unit = expectedUnits[i];
      const segment = parsedSegments[i];
      
      // entropy-scoped escaping: unescape back to literal @@
      const exactTranslation = segment.text.replace(unescapePattern, unescapeReplacement);
      
      let finalValue;
      const shouldBidi = () => {
        if (!unit.node) return false;
        for (const p of iterateSelectElementAncestors(unit.node)) {
          const t = p.tagName.toUpperCase();
          if (['PRE', 'CODE', 'INPUT', 'TEXTAREA'].includes(t)) return false;
          if (p.contentEditable === 'true' || p.getAttribute('contenteditable') === 'true') return false;
        }
        if (!exactTranslation || typeof exactTranslation !== 'string') return false;
        if (!/[\p{L}\p{N}]/u.test(exactTranslation)) return false;
        return detectDirectionFromContent(exactTranslation) !== resolveDir(unit.node);
      };

      if (shouldBidi()) {
        const detectedDir = detectDirectionFromContent(exactTranslation);
        const bidiMark = detectedDir === 'rtl' ? BIDI_MARKS.RLM : BIDI_MARKS.LRM;
        finalValue = unit.leadingWS + bidiMark + exactTranslation + bidiMark + unit.trailingWS;
      } else {
        finalValue = unit.leadingWS + exactTranslation + unit.trailingWS;
      }
      
      commitPlan.push({
        unit,
        finalValue,
        originalText: unit.node.textContent,
      });
    }

    // --- Mutation Phase (Synchronous DOM writes) ---
    const firstNodeParent = expectedUnits[0].node.parentElement;
    const attributeParents = new Map();
    const directionSnapshots = [];
    const fontParents = new Map();
    const cssFontTargets = new Map();
    const directionElements = new Set();
    const hoverSnapshots = commitPlan.map(({ unit }) => ({ node: unit.node, value: hoverPreviewLookup.get(unit.node) }));
    for (const { unit } of commitPlan) {
      const parentElement = unit.node.parentElement;
      if (parentElement && !attributeParents.has(parentElement)) {
        attributeParents.set(parentElement, {
          present: parentElement.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL),
          value: parentElement.getAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL),
        });
      }
      for (const snapshot of captureNodeDirectionState(unit.node, rootElement, {
        shadowAware: Boolean(unit.node?.getRootNode?.()?.host),
      })) {
        if (!directionElements.has(snapshot.element)) {
          directionElements.add(snapshot.element);
          directionSnapshots.push(snapshot);
        }
      }
    }
    const hadTranslatingClass = firstNodeParent?.classList.contains('ti-translating') || false;
    let active = true;
    const restoreTranslatingClass = () => {
      if (!firstNodeParent) return;
      if (hadTranslatingClass) firstNodeParent.classList.add('ti-translating');
      else firstNodeParent.classList.remove('ti-translating');
    };
    const rollback = (primaryError = null) => {
      if (!active) return [];
      active = false;
      const restorations = [
        ...[...commitPlan].reverse().map(({ unit, originalText }) => ({
          kind: 'text',
          restore: () => { unit.node.nodeValue = originalText; },
          createFailure: (error) => ({ kind: 'text', id: unit.id, error }),
        })),
        ...[...attributeParents].map(([element, state]) => ({
          kind: 'attribute',
          restore: () => {
            if (state.present) element.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL, state.value);
            else element.removeAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL);
          },
          createFailure: (error) => ({ kind: 'attribute', element, error }),
        })),
        ...[...fontParents].map(([element, state]) => ({
          kind: 'font',
          restore: () => {
            if (state.present) element.style.setProperty('font-family', state.value, state.priority);
            else element.style.removeProperty('font-family');
          },
          createFailure: (error) => ({ kind: 'font', element, error }),
        })),
        ...[...cssFontTargets].map(([target, state]) => ({
          kind: 'css-font',
          restore: () => restoreSelectElementMixedFontStyle(target, state),
          createFailure: (error) => ({ kind: 'css-font', element: target, error }),
        })),
        {
          kind: 'direction',
          restore: () => restoreNodeDirectionState(directionSnapshots),
        },
        ...hoverSnapshots.map(({ node, value }) => ({
          kind: 'hover',
          restore: () => {
            if (value === undefined) hoverPreviewLookup.delete(node);
            else hoverPreviewLookup.add(node, value, node?.nodeValue);
          },
          createFailure: (error) => ({ kind: 'hover', node, error }),
        })),
        {
          kind: 'class',
          restore: restoreTranslatingClass,
          createFailure: (error) => ({ kind: 'class', element: firstNodeParent, error }),
        },
      ];

      return runBestEffortRollback({ primaryError, restorations }).rollbackFailures;
    };

    try {
      if (firstNodeParent) {
        firstNodeParent.classList.add('ti-translating');
      }

      for (const task of commitPlan) {
        const parentElement = task.unit.node.parentElement;
        if (parentElement && parentElement.getAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL) !== 'true') {
          parentElement.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL, 'true');
        }

        task.unit.node.nodeValue = task.finalValue;
        // Register only after the DOM write so cache validation reflects the value actually applied.
        hoverPreviewLookup.add(task.unit.node, task.originalText, task.unit.node.nodeValue);

        if (translationFontFamily) {
          const fontTarget = getTranslationFontTarget(task.unit.node);
          if (fontTarget && isSelectElementFontTargetSafe(fontTarget) && !fontParents.has(fontTarget)) {
            try {
              fontParents.set(fontTarget, {
                present: fontTarget.style.getPropertyValue('font-family') !== '',
                value: fontTarget.style.getPropertyValue('font-family'),
                priority: fontTarget.style.getPropertyPriority('font-family'),
              });
              fontTarget.style.setProperty('font-family', translationFontFamily);
            } catch (fontError) {
              fontParents.delete(fontTarget);
              logger.debug('[Reconstructor] Select Element font enhancement skipped', fontError);
            }
          } else if (!fontTarget) {
            const mixedTarget = getSelectElementMixedFontTarget(task.unit.node);
            if (mixedTarget) applySelectElementMixedFontStyle(mixedTarget, translationFontFamily, cssFontTargets);
          }
        }
        applyNodeDirection(task.unit.node, targetLanguage, rootElement, {
          shadowAware: Boolean(task.unit.node?.getRootNode?.()?.host),
        });
      }
      restoreTranslatingClass();

      return {
        success: true,
        cleanResult: parsedSegments.map(segment => segment.text).join(''),
        segments: parsedSegments,
        auxiliarySnapshots: { attributeParents, directionSnapshots, fontParents, cssFontTargets },
        transaction: {
          rollback,
          finalize() { active = false; },
        },
      };
    } catch (error) {
      throw new BlockGroupMutationFailure(error, rollback(error));
    }
  }
}

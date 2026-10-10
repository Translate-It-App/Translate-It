import {
  DOMTranslator,
  NodesTranslator,
  PersistentDOMTranslator,
  IntersectionScheduler
} from 'domtranslator';
import { createNodesFilter } from 'domtranslator/utils/nodes';
import { applyNodeDirection, isRTL, restoreElementDirection, BIDI_MARKS } from '@/utils/dom/DomDirectionManager.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';
import { 
  PAGE_TRANSLATION_ATTRIBUTES, 
  PAGE_TRANSLATION_SELECTORS
} from './PageTranslationConstants.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { walkOpenShadowTree } from '@/utils/dom/walkOpenShadowTree.js';
import { getTranslationFontTarget } from '@/shared/fonts/TranslationFontPolicy.js';

const FORM_VALUE_TAGS = new Set(['INPUT', 'TEXTAREA', 'BUTTON']);

const getComposedParent = (node) => {
  if (!node) return null;
  if (node.parentElement) return node.parentElement;
  if (node.parentNode?.nodeType === Node.ELEMENT_NODE) return node.parentNode;
  return node.parentNode?.host || null;
};

const isComposedDescendant = (root, node) => {
  let current = node;

  while (current) {
    if (current === root) return true;
    current = getComposedParent(current);
  }

  return false;
};

const getFilterElement = (node) => {
  if (node?.nodeType === Node.ELEMENT_NODE) return node;
  if (node?.nodeType === Node.ATTRIBUTE_NODE) return node.ownerElement;
  return getComposedParent(node);
};

const matchesAnySelector = (element, selectors) => selectors.some((selector) => {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
});

const isShadowRoot = (root) => Boolean(
  root
  && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
  && root.host
);

const isExcludedAcrossShadowHosts = (owner, selectors) => {
  let root = owner?.getRootNode?.();

  while (isShadowRoot(root)) {
    const host = root.host;
    let current = host;

    while (current) {
      if (matchesAnySelector(current, selectors)) return true;
      current = current.parentElement;
    }

    root = host.getRootNode?.();
  }

  return false;
};

const getEditableState = (element) => {
  let current = element;

  while (current) {
    const value = current.getAttribute?.('contenteditable');
    if (value !== null && value !== undefined) {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'false') return false;
      if (normalized === '' || normalized === 'true' || normalized === 'plaintext-only') return true;
    }
    current = current.parentElement;
  }

  return false;
};

const isMutableEditableNode = (node) => {
  if (!node) return false;

  if (node.nodeType === Node.TEXT_NODE) {
    const owner = node.parentElement;
    return Boolean(owner?.closest('textarea') || getEditableState(owner));
  }

  if (node.nodeType === Node.ATTRIBUTE_NODE) {
    const owner = node.ownerElement;
    return node.name.toLowerCase() === 'value' && FORM_VALUE_TAGS.has(owner?.tagName);
  }

  return false;
};

const FONT_FAMILY_PROPERTY = 'font-family';

const readInlineFontState = (element) => {
  const value = element.style.getPropertyValue(FONT_FAMILY_PROPERTY);
  return {
    present: value !== '',
    value,
    priority: element.style.getPropertyPriority(FONT_FAMILY_PROPERTY),
  };
};

const restoreInlineFontState = (element, state) => {
  if (state.present) element.style.setProperty(FONT_FAMILY_PROPERTY, state.value, state.priority);
  else element.style.removeProperty(FONT_FAMILY_PROPERTY);
};

const restoreSessionFontOwnership = (session, logger) => {
  if (!session?.fontOwnership?.size) return;

  try {
    for (const [element, ownership] of session.fontOwnership) {
      try {
        const current = readInlineFontState(element);
        const wasNotChangedExternally = current.present === ownership.appliedPresent
          && current.value === ownership.appliedValue
          && current.priority === ownership.appliedPriority;

        if (!wasNotChangedExternally) {
          logger.debug('Skipping externally changed Page Translation font');
          continue;
        }

        restoreInlineFontState(element, ownership.original);
      } catch (error) {
        logger.debug('Page Translation font restore skipped', error);
      }
    }
  } finally {
    session.fontOwnership.clear();
  }
};

export class PageTranslationBridge extends ResourceTracker {
  constructor() {
    super('page-translation-bridge');
    this.logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'Bridge');
    this.session = null;
    this.showOriginalOnHover = true; // Initial default
  }

  async initialize(settings, onTranslateCallback, sessionContext = null, {
    preserveAcceptedTranslations = false, onRetainedTranslation = null, settingsRevision = 0,
  } = {}) {
    const previous = preserveAcceptedTranslations && this.session ? {
      nodeStorage: this.session.nodesTranslator?.nodeStorage,
      document: this.session.root?.ownerDocument,
      translationApi: this.session.translationApi,
      targetLanguage: this.session.targetLanguage,
      settingsRevision: this.session.settingsRevision,
    } : null;
    const previousStorage = preserveAcceptedTranslations
      && previous?.document === document
      && previous.targetLanguage === settings.targetLanguage
      && previous.translationApi === settings.translationApi
      && previous.settingsRevision === settingsRevision
      ? previous.nodeStorage : null;
    this.cleanup();
    
    // Explicitly set from settings (defaulted to true if undefined)
    this.showOriginalOnHover = settings.showOriginalOnHover ?? true;
    const isTargetRTL = isRTL(settings.targetLanguage);

    // Reset lookup for a new session
    hoverPreviewLookup.clear();

    const currentSession = {
      intersectionScheduler: null,
      domTranslator: null,
      persistentTranslator: null,
      context: sessionContext,
      url: window.location.href,
      targetLanguage: settings.targetLanguage,
      translationApi: settings.translationApi,
      settingsRevision,
      root: null,
      active: true,
      shadowDiscoveryObserver: null,
      shadowRoots: new Map(),
      shadowMutatedNodes: new WeakSet(),
      shadowMovedNodes: new WeakSet(),
      shadowPersistenceStarted: false,
      translationFontFamily: settings.translationFontFamily || null,
      fontOwnership: new Map(),
    };
    const targetGenerations = new WeakMap();
    const applyDecisions = new WeakMap();

    const nextTargetGeneration = (node) => {
      const generation = (targetGenerations.get(node) || 0) + 1;
      targetGenerations.set(node, generation);
      return generation;
    };

    const getCurrentNodeValue = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.ATTRIBUTE_NODE) return node.value ?? node.nodeValue ?? '';
      return node.nodeValue ?? '';
    };

    const setCurrentNodeValue = (node, value) => {
      if (node?.nodeType === Node.ATTRIBUTE_NODE) {
        node.value = value;
        return;
      }
      node.nodeValue = value;
    };

    const isFreshTarget = (node, sourceValue, generation) => {
      if (!currentSession.active || this.session !== currentSession || !node) return false;
      if (window.location.href !== currentSession.url) return false;

      const owner = node.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node;
      const root = currentSession.root;
      if (!isOwnedTarget(owner, root)) return false;

      if (node.nodeType === Node.ATTRIBUTE_NODE) {
        const currentAttribute = owner.getAttributeNode(node.name);
        if (currentAttribute !== node || getCurrentNodeValue(node) !== sourceValue) return false;
      } else if (!node.isConnected || node.nodeValue !== sourceValue) {
        return false;
      }

      return generation === undefined || targetGenerations.get(node) === generation;
    };

    const recordApplyDecision = (node, generation, outcome, settlement = null, ownsStorage = false) => {
      if (!node) return;
      let decisions = applyDecisions.get(node);
      if (!decisions) {
        decisions = new Map();
        applyDecisions.set(node, decisions);
      }
      decisions.set(generation, {
        generation,
        outcome,
        settlement,
        ownsStorage,
        session: currentSession,
      });
    };

    const getApplyDecision = (node, generation = targetGenerations.get(node)) => (
      applyDecisions.get(node)?.get(generation)
    );

    const forgetApplyDecision = (node, generation) => {
      const decisions = applyDecisions.get(node);
      if (!decisions) return;
      decisions.delete(generation);
      if (decisions.size === 0) applyDecisions.delete(node);
    };

    const isActiveTarget = (node) => {
      if (!currentSession.active || this.session !== currentSession || !node) return false;
      if (window.location.href !== currentSession.url) return false;
      const owner = node.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node;
      const root = currentSession.root;
      return isOwnedTarget(owner, root);
    };

    const isConnectedTarget = (node) => {
      if (!node) return false;
      const owner = node.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node;
      const root = currentSession.root;
      return isOwnedTarget(owner, root);
    };

    function isOwnedTarget(owner, root) {
      return Boolean(owner?.isConnected
        && (!root || (root.isConnected && isComposedDescendant(root, owner))));
    }

    const applyTranslationFont = (textNode) => {
      if (!currentSession.translationFontFamily || textNode?.nodeType !== Node.TEXT_NODE) return;

      let target = null;
      let original = null;
      try {
        target = getTranslationFontTarget(textNode);
        if (!target || currentSession.fontOwnership.has(target)) return;

        original = readInlineFontState(target);
        target.style.setProperty(FONT_FAMILY_PROPERTY, currentSession.translationFontFamily);
        const applied = readInlineFontState(target);
        currentSession.fontOwnership.set(target, {
          original,
          appliedPresent: applied.present,
          appliedValue: applied.value,
          appliedPriority: applied.priority,
        });
      } catch (error) {
        if (target && original) {
          try {
            restoreInlineFontState(target, original);
          } catch {
            // Best-effort font presentation must not affect translation.
          }
        }
        this.logger.debug('Page Translation font enhancement skipped', error);
      }
    };


    if (settings.lazyLoading) {
      currentSession.intersectionScheduler = new IntersectionScheduler({ rootMargin: settings.rootMargin });
    }

    /**
     * Standard translator callback for domtranslator.
     * Note: In domtranslator 1.x, the constructor callback ONLY receives (text, score).
     * We synchronously capture the current node before any async work to prevent de-sync.
     */
    const translateWithContext = async (text, score) => {
      // CRITICAL: Capture the node IMMEDIATELY as the first line.
      // Since domtranslator's walk is synchronous, this is the only safe way 
      // to link the text to the node before the event loop yields.
      const node = nodesTranslator.currentNode;
      const sourceValue = getCurrentNodeValue(node);
      const generation = nodesTranslator.currentTaskGeneration;
      const ownsStorage = nodesTranslator.currentTaskOwnsStorage === true;

      if (!text || !text.trim()) {
        recordApplyDecision(node, generation, 'accepted-pending', null, ownsStorage);
        return text;
      }

      // 1. Capture original whitespace to preserve formatting
      const leadingMatch = text.match(/^(\s*)/);
      const trailingMatch = text.match(/(\s*)$/);
      const leadingWhitespace = leadingMatch ? leadingMatch[1] : '';
      const trailingWhitespace = trailingMatch ? trailingMatch[1] : '';
      const trimmedText = text.trim();

      // 2. Request translation for trimmed text
      // We pass the node as the 4th argument
      const settlement = await onTranslateCallback(trimmedText, sessionContext, score, node);
      const hasSettlement = settlement && settlement.__pageTranslationSettlement === true;
      const translated = hasSettlement ? settlement.text : settlement;

      // Validate before NodesTranslator receives provider output. Its own updateId
      // protects DOM writes, but cannot correct page-level settlement accounting.
      if (node && (!currentSession.active || this.session !== currentSession)) {
        settlement?.settle?.('cancelled');
        recordApplyDecision(node, generation, 'cancelled', settlement, ownsStorage);
        return getCurrentNodeValue(node);
      }

      if (node && hasSettlement && settlement.state !== 'pending') {
        recordApplyDecision(node, generation, settlement.state, settlement, ownsStorage);
        return getCurrentNodeValue(node);
      }

      if (node && !isFreshTarget(node, sourceValue, generation)) {
        settlement?.settle?.('stale');
        recordApplyDecision(node, generation, 'stale', settlement, ownsStorage);
        return getCurrentNodeValue(node);
      }

      recordApplyDecision(node, generation, 'accepted-pending', settlement, ownsStorage);

      
      // OPTIMIZATION: Preserve ZWNJ, Tatweel, Dashes and BiDi marks if the provider 
      // returned a "cleaned" version of the same text.
      // We ignore: ZWSP(\u200b), ZWNJ(\u200c), ZWJ(\u200d), LRM(\u200e), RLM(\u200f), BOM(\ufeff), Tatweel(\u0640), EnDash(\u2013), EmDash(\u2014)
      const normalizeForComparison = (s) => s ? s.replace(/[\u200b-\u200f\uFEFF\u0640\u2013\u2014]/g, '').replace(/\s+/g, ' ').trim() : '';
      const isFunctionallyIdentical = translated && 
        normalizeForComparison(translated) === normalizeForComparison(trimmedText);

      // FIX: Only apply marks if the text was actually translated (different from original)
      // and not just a ZWNJ-stripped version of the original.
      if (translated && translated !== trimmedText && !isFunctionallyIdentical) {
        // 3. Inject BiDi Isolation Mark (RLM/LRM) directly into the string.
        const mark = isTargetRTL ? BIDI_MARKS.RLM : BIDI_MARKS.LRM;
        
        return leadingWhitespace + mark + translated.trim() + trailingWhitespace;
      }
      
      // Use trimmedText if functionally identical to preserve ZWNJ
      return leadingWhitespace + (isFunctionallyIdentical ? trimmedText : (translated ? translated.trim() : trimmedText)) + trailingWhitespace;
    };

    class GuardedNodesTranslator extends NodesTranslator {
      translateNodeContent(node, callback) {
        const nodeData = this.nodeStorage.get(node);
        if (!nodeData) throw new Error('Node is not register');
        if (node.nodeValue === null) return;

        const nodeId = nodeData.id;
        const nodeContext = nodeData.updateId;
        const taskGeneration = this.currentTaskGeneration;
        return this.translateCallback(node.nodeValue, nodeData.importanceScore).then((text) => {
          const actualNodeData = this.nodeStorage.get(node);
          const decision = getApplyDecision(node, taskGeneration);
          const isCurrentStorage = actualNodeData
            && nodeId === actualNodeData.id
            && nodeContext === actualNodeData.updateId;

          if (!isCurrentStorage) {
            if (decision?.settlement?.state === 'pending') {
              const outcome = decision.session === currentSession && currentSession.active
                ? 'stale'
                : 'cancelled';
              decision.settlement.settle(outcome);
            }
            if (decision) decision.outcome = decision.session === currentSession && currentSession.active
              ? 'stale'
              : 'cancelled';
            forgetApplyDecision(node, taskGeneration);
            return;
          }

          const canPreserveProviderFailure = decision?.outcome === 'failed'
            && decision.session === currentSession
            && isActiveTarget(node)
            && decision.generation === targetGenerations.get(node)
            && decision.settlement?.state === 'failed';

          if (canPreserveProviderFailure) {
            actualNodeData.originalText = getCurrentNodeValue(node);
            setCurrentNodeValue(node, text);
            decision.outcome = 'failed-applied';
            try {
              if (callback) callback(node);
            } finally {
              forgetApplyDecision(node, taskGeneration);
            }
            return;
          }

          const canApply = decision
            && decision.session === currentSession
            && isActiveTarget(node)
            && decision.generation === targetGenerations.get(node)
            && decision.outcome === 'accepted-pending'
            && (!decision.settlement || decision.settlement.state === 'pending');

          if (!canApply) {
            if (decision?.settlement?.state === 'pending') {
              decision.settlement.settle(
                decision.session === currentSession && currentSession.active ? 'stale' : 'cancelled'
              );
            }
            if (decision?.ownsStorage
                && decision.generation === targetGenerations.get(node)
                && this.nodeStorage.get(node) === nodeData) {
              this.nodeStorage.delete(node);
            }
            if (!decision?.ownsStorage
                && (decision?.outcome === 'stale' || decision?.outcome === 'cancelled')
                && decision.generation === targetGenerations.get(node)
                && this.nodeStorage.get(node) === nodeData
                && isConnectedTarget(node)) {
              // Current-generation update owns restore baseline; obsolete updates do not.
              nodeData.originalText = getCurrentNodeValue(node);
            }
            if (decision) decision.outcome = decision.session === currentSession && currentSession.active
              ? 'stale'
              : 'cancelled';
            forgetApplyDecision(node, taskGeneration);
            return;
          }

          try {
            actualNodeData.originalText = getCurrentNodeValue(node);
            setCurrentNodeValue(node, text);
            actualNodeData.acceptedTranslation = {
              originalText: actualNodeData.originalText,
              text: getCurrentNodeValue(node),
              updateId: actualNodeData.updateId,
            };
          } catch (error) {
            if (decision.settlement?.state === 'pending') {
              decision.settlement.settle(
                decision.session === currentSession && currentSession.active ? 'stale' : 'cancelled'
              );
            }
            decision.outcome = decision.session === currentSession && currentSession.active
              ? 'stale'
              : 'cancelled';
            forgetApplyDecision(node, taskGeneration);
            throw error;
          }
          decision.outcome = 'applied';
          decision.settlement?.settle?.('accepted');
          try {
            if (callback) callback(node);
          } finally {
            forgetApplyDecision(node, taskGeneration);
          }
        });
      }

      restore(node, callback) {
        const nodeData = this.nodeStorage.get(node);
        const accepted = nodeData?.acceptedTranslation;
        // A stopped SPA owner may outlive host edits while its replacement loads.
        if (!currentSession.active && (!isConnectedTarget(node)
            || node.ownerDocument !== document
            || !accepted || nodeData.updateId !== accepted.updateId
            || getCurrentNodeValue(node) !== accepted.text)) {
          this.nodeStorage.delete(node);
          callback?.(node);
          return;
        }
        if (node?.nodeType === Node.ATTRIBUTE_NODE && nodeData) {
          if (nodeData.originalText !== null) setCurrentNodeValue(node, nodeData.originalText);
          this.nodeStorage.delete(node);
          callback?.(node);
          return;
        }
        super.restore(node);
        callback?.(node);
      }
    }

    const nodesTranslator = new GuardedNodesTranslator(translateWithContext);
    const retainAcceptedTranslation = (node) => {
      if (!previousStorage || nodesTranslator.has(node) || !isActiveTarget(node)) return false;
      const previous = previousStorage.get(node);
      const accepted = previous?.acceptedTranslation;
      if (!accepted || previous.updateId !== accepted.updateId
          || getCurrentNodeValue(node) !== accepted.text) return false;
      nodesTranslator.nodeStorage.set(node, {
        id: nodesTranslator.idCounter++, updateId: 1, originalText: accepted.originalText,
        importanceScore: previous.importanceScore,
        acceptedTranslation: { ...accepted, updateId: 1 },
      });
      if (settings.showOriginalOnHover) hoverPreviewLookup.add(node, accepted.originalText, accepted.text);
      applyTranslationFont(node);
      onRetainedTranslation?.();
      return true;
    };

    if (currentSession.intersectionScheduler) {
      const originalAdd = currentSession.intersectionScheduler.add;
      currentSession.intersectionScheduler.add = function(node, callback) {
        // Restore ownership must survive even when visibility defers translation.
        if (retainAcceptedTranslation(node)) return;
        return originalAdd.call(this, node, callback);
      };
    }

    /**
     * MONKEY-PATCH: Capture the node being processed by NodesTranslator.
     * This allows us to pass the node to the scheduler for visibility checks.
     * We set it directly on the instance as the walk is synchronous.
     */
    const originalTranslate = nodesTranslator.translate;
    nodesTranslator.translate = function(node, callback) {
      retainAcceptedTranslation(node);
      if (this.has(node)) return originalTranslate.call(this, node, callback);
      this.currentNode = node;
      this.currentTaskGeneration = nextTargetGeneration(node);
      this.currentTaskOwnsStorage = typeof this.has === 'function' ? !this.has(node) : true;
      return originalTranslate.call(this, node, callback);
    };

    const originalUpdate = nodesTranslator.update;
    nodesTranslator.update = function(node, callback) {
      this.currentNode = node;
      this.currentTaskGeneration = nextTargetGeneration(node);
      this.currentTaskOwnsStorage = false;
      return originalUpdate.call(this, node, callback);
    };

    /**
     * FIX: Since domtranslator doesn't pass the node to the constructor's callback,
     * we wrap its core methods (translate and update) to intercept the processed node.
     * This allows us to apply container-level direction (CSS) after text is swapped.
     */
    const wrapWithDirection = (originalFn) => {
      const bridge = this;
      return function(node, callback) {
        const originalValue = node?.nodeType === Node.ATTRIBUTE_NODE
          ? node.value
          : node?.textContent;

        // Wrap the processed node callback
        const wrappedCallback = (processedNode) => {
          const decision = getApplyDecision(node);
          const isAcceptedCurrent = decision?.session === currentSession
            && currentSession.active
            && decision.generation === targetGenerations.get(node)
            && decision.outcome === 'applied';
          const shouldPostProcess = !decision || isAcceptedCurrent;

          if (!shouldPostProcess) {
            // PersistentDOMTranslator uses callback to mark its own write as handled.
            // Keep that internal bookkeeping, but suppress semantic page effects.
            if (callback) callback(processedNode);
            return;
          }

          if (processedNode) {
            const { TRANSLATED_MARKER, HAS_ORIGINAL } = PAGE_TRANSLATION_ATTRIBUTES;

            if (bridge.showOriginalOnHover) {
              hoverPreviewLookup.add(
                processedNode,
                originalValue,
                getCurrentNodeValue(processedNode)
              );
            }
            
            // Determine if it was actually translated by checking for the BiDi mark
            const textContent = processedNode.nodeType === Node.TEXT_NODE ? processedNode.textContent : processedNode.value;
            const hasMark = textContent && (textContent.includes(BIDI_MARKS.RLM) || textContent.includes(BIDI_MARKS.LRM));

            if (processedNode.nodeType === Node.TEXT_NODE) {
              try {
                if (hasMark) {
                  // 1. Apply directional logic (Unicode marks + container alignment) only for RTL targets
                  if (isTargetRTL) {
                    applyNodeDirection(processedNode, settings.targetLanguage);
                  }
                  
                  // 2. Mark the parent for tooltip display regardless of target direction
                  const parent = processedNode.parentElement;
                  if (parent) {
                    parent.setAttribute(TRANSLATED_MARKER, 'true');
                    if (bridge.showOriginalOnHover) {
                      parent.setAttribute(HAS_ORIGINAL, 'true');
                    }
                  }
                  if (isAcceptedCurrent) applyTranslationFont(processedNode);
                }
              } catch (e) {
                bridge.logger.warn('Failed to apply direction/marking to node', e);
              }
            } else if (processedNode.nodeType === Node.ATTRIBUTE_NODE) {
              // For attributes, we mark the owner element only if translated
              if (hasMark && bridge.showOriginalOnHover && processedNode.ownerElement) {
                processedNode.ownerElement.setAttribute(HAS_ORIGINAL, 'true');
                processedNode.ownerElement.setAttribute(TRANSLATED_MARKER, 'true');
              }
            }
          }
          
          // Call original callback if provided (e.g., from PersistentDOMTranslator)
          if (callback) {
            currentSession.shadowMutatedNodes.add(processedNode);
            callback(processedNode);
          }
        };
        
        try {
          return originalFn.call(this, node, wrappedCallback);
        } catch (e) {
          if (e.message && e.message.includes('already been translated')) {
            bridge.logger.debug('Node already translated, skipping.', node);
            return; // Silently ignore this specific error
          }
          throw e;
        }
      };
    };

    // Intercept both initial translations and dynamic updates
    nodesTranslator.translate = wrapWithDirection(nodesTranslator.translate);
    nodesTranslator.update = wrapWithDirection(nodesTranslator.update);

    const composedExcludedSelectors = [
      ...(settings.excludedSelectors || []),
      `#${PAGE_TRANSLATION_SELECTORS.UI_HOST_MAIN}`,
      `#${PAGE_TRANSLATION_SELECTORS.UI_HOST_IFRAME}`,
      `#${PAGE_TRANSLATION_SELECTORS.TOOLTIP_ID}`,
      `.${PAGE_TRANSLATION_SELECTORS.INTERNAL_IGNORE_CLASS}`,
      `.${PAGE_TRANSLATION_SELECTORS.STANDARD_NO_TRANSLATE_CLASS}`,
      `[translate='${PAGE_TRANSLATION_SELECTORS.TRANSLATE_NO_VALUE}']`
    ];
    const domTranslatorFilter = createNodesFilter({
      ignoredSelectors: composedExcludedSelectors,
      attributesList: settings.attributesToTranslate || ['title', 'alt', 'placeholder'],
    });
    const filter = (node) => {
      if (!domTranslatorFilter(node) || isMutableEditableNode(node)) return false;

      const owner = getFilterElement(node);
      const root = owner?.getRootNode?.();
      return !isShadowRoot(root) || !isExcludedAcrossShadowHosts(owner, composedExcludedSelectors);
    };

    currentSession.nodesTranslator = nodesTranslator;
    currentSession.filter = filter;
    currentSession.autoTranslateOnDOMChanges = settings.autoTranslateOnDOMChanges ?? true;

    currentSession.domTranslator = new DOMTranslator(nodesTranslator, {
      scheduler: currentSession.intersectionScheduler,
      filter: filter
    });

    const restoreDomNode = currentSession.domTranslator.restore.bind(currentSession.domTranslator);
    currentSession.domTranslator.restore = (node, callback) => {
      if (currentSession.shadowMovedNodes.has(node)) return;
      return restoreDomNode(node, callback);
    };

    const markShadowMutation = (node) => currentSession.shadowMutatedNodes.add(node);

    const unregisterShadowRoot = (shadowRoot) => {
      const registration = currentSession.shadowRoots.get(shadowRoot);
      if (!registration) return;
      registration.observer.disconnect();
      currentSession.shadowRoots.delete(shadowRoot);
    };

    const unregisterShadowRootsUnder = (subtree) => {
      for (const [shadowRoot, registration] of currentSession.shadowRoots) {
        if (isComposedDescendant(subtree, registration.host)) {
          unregisterShadowRoot(shadowRoot);
        }
      }
    };

    const discoverShadowRoots = (subtree) => {
      walkOpenShadowTree(subtree, (element) => {
        if (element.shadowRoot) registerShadowRoot(element.shadowRoot, element);
      });
    };

    const translateAddedNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement) return;
        if (currentSession.domTranslator.has(node)) return;
      } else if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      currentSession.domTranslator.translate(node, markShadowMutation);
    };

    const restoreRemovedNode = (node) => {
      if (isOwnedTarget(node, currentSession.root)) return;
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return;
      currentSession.domTranslator.restore(node);
      unregisterShadowRootsUnder(node);
    };

    const processShadowMutations = (shadowRoot, mutations) => {
      const registration = currentSession.shadowRoots.get(shadowRoot);
      if (!registration) return;
      if (!currentSession.active
          || this.session !== currentSession
          || !isOwnedTarget(registration.host, currentSession.root)) {
        unregisterShadowRoot(shadowRoot);
        return;
      }

      const childChanges = new Map();
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          if (currentSession.shadowMutatedNodes.has(mutation.target)) {
            currentSession.shadowMutatedNodes.delete(mutation.target);
          } else if (currentSession.domTranslator.has(mutation.target)) {
            currentSession.domTranslator.update(mutation.target, markShadowMutation);
          } else if (mutation.target.parentElement) {
            currentSession.domTranslator.translate(mutation.target, markShadowMutation);
          }
          continue;
        }

        if (mutation.type === 'attributes') {
          const attribute = mutation.target.attributes.getNamedItem(mutation.attributeName);
          if (!attribute) continue;
          if (currentSession.shadowMutatedNodes.has(attribute)) {
            currentSession.shadowMutatedNodes.delete(attribute);
          } else if (currentSession.domTranslator.has(attribute)) {
            currentSession.domTranslator.update(attribute, markShadowMutation);
          } else {
            currentSession.domTranslator.translate(attribute, markShadowMutation);
          }
          continue;
        }

        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          const change = childChanges.get(node) || { added: 0, removed: 0 };
          change.added++;
          childChanges.set(node, change);
        }
        for (const node of mutation.removedNodes) {
          const change = childChanges.get(node) || { added: 0, removed: 0 };
          change.removed++;
          childChanges.set(node, change);
        }
      }

      for (const [node, change] of childChanges) {
        if (change.added > change.removed) {
          translateAddedNode(node);
          discoverShadowRoots(node);
        } else if (change.removed > change.added) {
          restoreRemovedNode(node);
        }
      }
    };

    const registerShadowRoot = (shadowRoot, host) => {
      if (currentSession.shadowRoots.has(shadowRoot)
          || !currentSession.active
          || this.session !== currentSession
          || !isOwnedTarget(host, currentSession.root)) return;

      const observer = new MutationObserver((mutations) => {
        processShadowMutations(shadowRoot, mutations);
      });
      currentSession.shadowRoots.set(shadowRoot, { host, observer });
      observer.observe(shadowRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    };

    const processDiscoveryMutations = (mutations) => {
      if (!currentSession.active || this.session !== currentSession) return;
      const childChanges = new Map();
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          const change = childChanges.get(node) || { added: 0, removed: 0 };
          change.added++;
          childChanges.set(node, change);
        }
        for (const node of mutation.removedNodes) {
          const change = childChanges.get(node) || { added: 0, removed: 0 };
          change.removed++;
          childChanges.set(node, change);
        }
      }
      for (const [node, change] of childChanges) {
        if (change.added > change.removed) discoverShadowRoots(node);
        else if (change.removed > change.added) {
          if (isOwnedTarget(node, currentSession.root)) {
            currentSession.shadowMovedNodes.add(node);
            queueMicrotask(() => currentSession.shadowMovedNodes.delete(node));
          } else {
            unregisterShadowRootsUnder(node);
          }
        }
      }
    };

    currentSession.startShadowPersistence = (root) => {
      if (currentSession.shadowPersistenceStarted) return;
      currentSession.shadowPersistenceStarted = true;
      currentSession.shadowDiscoveryObserver = new MutationObserver(processDiscoveryMutations);
      currentSession.shadowDiscoveryObserver.observe(root, { childList: true, subtree: true });
      discoverShadowRoots(root);
    };

    currentSession.stopShadowPersistence = () => {
      currentSession.shadowDiscoveryObserver?.disconnect();
      currentSession.shadowDiscoveryObserver = null;
      for (const registration of currentSession.shadowRoots.values()) {
        registration.observer.disconnect();
      }
      currentSession.shadowRoots.clear();
      currentSession.shadowPersistenceStarted = false;
    };

    // We always wrap in PersistentDOMTranslator to handle dynamic content consistently
    currentSession.persistentTranslator = new PersistentDOMTranslator(currentSession.domTranslator);

    this.session = currentSession;
  }

  translate(element) {
    if (!this.session?.active || window.location.href !== this.session.url) return;
    this.session.root = element;
    
    // Respect auto-translate setting: 
    // Use persistentTranslator (MutationObserver) only if enabled.
    // Otherwise, use basic domTranslator for a single-pass translation.
    if (this.session.autoTranslateOnDOMChanges && this.session.persistentTranslator) {
      this.logger.debug('Starting persistent translation (Auto-translate enabled)');
      this.session.startShadowPersistence?.(element);
      this.session.persistentTranslator.translate(element);
    } else if (this.session.domTranslator) {
      this.logger.debug('Starting single-pass translation (Auto-translate disabled)');
      this.session.domTranslator.translate(element);
    }
  }

  getTranslationRoot() {
    return this.session?.root || null;
  }

  stopPersistence() {
    // Retain restore storage, but invalidate pending writers and lazy callbacks.
    if (this.session) this.session.active = false;
    if (this.session && this.session.persistentTranslator) {
      try {
        this.session.stopShadowPersistence?.();
        this.session.intersectionScheduler?.intersectionObserver?.intersectionObserver?.disconnect();
        const pt = this.session.persistentTranslator;
        // Search for the observer in observedNodesStorage (it's a Map of node -> XMutationObserver)
        if (pt.observedNodesStorage) {
          for (const observer of pt.observedNodesStorage.values()) {
            observer.disconnect();
          }
          // Do NOT clear storage, so PersistentDOMTranslator.restore can still find the node if called later
        }
      } catch (e) {
        this.logger.warn('Failed to stop persistence:', e.message);
      }
    }
  }

  restore(element) {
    if (!this.session) return;

    const currentSession = this.session;
    try {
      const ownedRoot = currentSession.root || element;
      restoreSessionFontOwnership(currentSession, this.logger);
      currentSession.stopShadowPersistence?.();

      // 1. Surgical Restore: Revert all direction and alignment changes
      restoreElementDirection(ownedRoot, { shadowAware: true });

      const pt = currentSession.persistentTranslator;
      const dt = currentSession.domTranslator;

      // 2. Check if the node is still actively observed
      const isObserved = pt && pt.observedNodesStorage && pt.observedNodesStorage.has(element);

      if (isObserved) {
        pt.restore(ownedRoot);
      } else if (dt) {
        // Fallback to direct DOM restore if persistence was stopped or node is not in observer storage
        dt.restore(ownedRoot);
      }
    } catch (e) {
      this.logger.warn('[Bridge] Restore failed:', e.message);
      // Last resort fallback directly on domTranslator
      if (currentSession.domTranslator) {
        try { currentSession.domTranslator.restore(currentSession.root || element); } catch {
          // Silent fallback
        }
      }
    } finally {
      this.cleanup();
    }
  }

  cleanup() {
    if (!this.session) return;

    const currentSession = this.session;
    currentSession.active = false;

    try {
      currentSession.stopShadowPersistence?.();
    } catch (e) {
      this.logger.error('Bridge Cleanup failed', e);
    }

    try {
      restoreSessionFontOwnership(currentSession, this.logger);
    } catch (e) {
      this.logger.debug('Page Translation font cleanup restore skipped', e);
    }

    try {
      // 1. Manually disconnect all internal observers just in case
      const pt = currentSession.persistentTranslator;
      if (pt && pt.observedNodesStorage) {
        for (const observer of pt.observedNodesStorage.values()) {
          observer.disconnect();
        }
        pt.observedNodesStorage.clear();
      }

      const is = currentSession.intersectionScheduler;
      if (is && is.intersectionObserver && is.intersectionObserver.intersectionObserver) {
        is.intersectionObserver.intersectionObserver.disconnect();
      }
    } catch (e) {
      this.logger.error('Bridge Cleanup failed', e);
    } finally {
      this.session = null;
    }
  }
}

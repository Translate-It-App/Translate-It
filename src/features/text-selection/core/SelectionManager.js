import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { WindowsConfig } from "@/features/windows/managers/core/WindowsConfig.js";
import { ExtensionContextManager } from "@/core/extensionContext.js";
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { utilsFactory } from '@/utils/UtilsFactory.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import settingsManager from '@/shared/managers/SettingsManager.js';
import { SelectionTranslationMode } from '@/shared/config/config.js';
import { walkOpenShadowTree } from '@/utils/dom/walkOpenShadowTree.js';

/**
 * SelectionManager - Simplified text selection management
 *
 * Handles the core logic for processing text selections and showing translation UI.
 * Much simpler than the old TextSelectionManager - no drag detection complexity.
 */
export class SelectionManager extends ResourceTracker {
  constructor(options = {}) {
    super('selection-manager');

    this.logger = getScopedLogger(LOG_COMPONENTS.TEXT_SELECTION, 'SelectionManager');

    // Mark this instance as critical to prevent cleanup during memory management
    this.trackResource('selection-manager-critical', () => {
      // This is the core selection manager - should not be cleaned up
      this.logger.debug('Critical SelectionManager cleanup skipped');
    }, { isCritical: true });

    // Initialize exclusion state - will be checked asynchronously
    this.isExcluded = false;
    this.exclusionChecked = false;

    // FeatureManager reference for accessing WindowsManager
    this.featureManager = options.featureManager;

    // Simple state tracking - no complex drag detection
    this.lastProcessedText = null;
    this.lastProcessedTime = 0;
    this.processingCooldown = 1000; // 1 second to prevent duplicates

    // Generate frameId for cross-frame communication
    this.frameId = Math.random().toString(36).substring(7);

    this.logger.init('SelectionManager initialized');
  }

  /**
   * Check if URL is excluded using UtilsFactory
   */
  async checkExclusion() {
    if (!this.exclusionChecked) {
      const { isUrlExcluded } = await utilsFactory.getUIUtils();
      this.isExcluded = isUrlExcluded(window.location.href);
      this.exclusionChecked = true;
      if (this.isExcluded) {
        this.logger.info('Text selection disabled on excluded URL', {
          url: window.location.hostname
        });
      }
    }
    return this.isExcluded;
  }

  /**
   * Get WindowsManager instance from FeatureManager
   */
  getWindowsManager() {
    const isTopFrame = window === window.top;
    if (!isTopFrame) {
      // In iframe context, no direct WindowsManager needed
      return null;
    }

    if (!this.featureManager) {
      this.logger.debug('FeatureManager not available');
      return null;
    }

    const windowsHandler = this.featureManager.getFeatureHandler('windowsManager');
    if (!windowsHandler || !windowsHandler.getIsActive()) {
      this.logger.debug('WindowsManager handler not active');
      return null;
    }

    return windowsHandler.getWindowsManager();
  }

  /**
   * Process text selection and show translation UI
   */
  async processSelection(selectedText, selection, options = {}) {
    if (!ExtensionContextManager.isValidSync()) {
      this.logger.debug('Extension context invalid, skipping selection processing');
      return;
    }

    // Calculate position for the translation UI
    const position = this.calculateSelectionPosition(selection);
    
    // CRITICAL: If we can't calculate a valid position, it's almost certainly 
    // a selection inside a Shadow DOM (our own UI) or an invalid range.
    // In this case, we MUST NOT emit events or show any UI.
    if (!position) {
      this.logger.debug('Skipping selection: Invalid position (likely inside Shadow DOM)');
      return;
    }

    // 1. Emit global selection event (Coordinator Pattern)
    // This allows any module (like FAB or TTS) to react independently
    const selectionTranslationMode = settingsManager.get('selectionTranslationMode', SelectionTranslationMode.ON_CLICK);
    const { toolbarPosition, selectionContinuationToken, displayInteraction, ...selectionOptions } = options;
    if (selectionContinuationToken && window === window.top) {
      window.__translateItSelectionDisplayToken = selectionContinuationToken;
    }
    if (displayInteraction && window === window.top) {
      window.__translateItSelectionDisplayInteraction = displayInteraction;
    }
    pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, {
      text: selectedText,
      position: position,
      ...(toolbarPosition ? { toolbarPosition } : {}),
      mode: selectionTranslationMode,
      options: selectionOptions, // Pass keyboard state (ctrlPressed, shiftPressed)
      context: {
        frameId: this.frameId,
        isIframe: window !== window.top
      }
    });
    if (window.__translateItSelectionDisplayToken === selectionContinuationToken) {
      window.__translateItSelectionDisplayToken = null;
    }
    if (window.__translateItSelectionDisplayInteraction === displayInteraction) {
      window.__translateItSelectionDisplayInteraction = null;
    }

    // 2. Check if we should skip showing our own UI (WindowsManager)
    const isTextSelectionEnabled = settingsManager.get('TRANSLATE_ON_TEXT_SELECTION', true);
    if (!isTextSelectionEnabled) {
      return;
    }

    // Check for Ctrl requirement if in IMMEDIATE mode
    if (selectionTranslationMode === SelectionTranslationMode.IMMEDIATE) {
      const requireCtrl = settingsManager.get('REQUIRE_CTRL_FOR_TEXT_SELECTION', false);
      if (requireCtrl) {
        // If required but not pressed, skip. 
        // Note: we check if ctrlPressed is explicitly TRUE.
        if (!options || options.ctrlPressed !== true) {
          this.logger.debug('Ctrl requirement not met for immediate translation, skipping UI display');
          return;
        }
      }
    }

    if (await this.checkExclusion()) {
      this.logger.debug('URL excluded, skipping translation UI display');
      return;
    }

    const currentTime = Date.now();

    // Prevent duplicate processing of same text for the UI display part
    if (this.isDuplicateSelection(selectedText, currentTime)) {
      this.logger.debug('Skipping duplicate selection UI display', {
        text: selectedText.substring(0, 30) + '...'
      });
      return false;
    }

    this.logger.debug('Processing new selection for UI', {
      text: selectedText.substring(0, 30) + '...',
      length: selectedText.length
    });

    // Show translation UI (This part is still dependent on WindowsManager being allowed)
    await this.showTranslationUI(selectedText, position, {
      ...selectionOptions,
      ...(selectionContinuationToken ? { selectionContinuationToken } : {}),
      ...(displayInteraction ? { displayInteraction } : {})
    }, toolbarPosition);

    // Track this selection
    this.lastProcessedText = selectedText;
    this.lastProcessedTime = currentTime;
    return true;
  }

  /**
   * Check if this is a duplicate selection
   */
  isDuplicateSelection(selectedText, currentTime) {
    if (!selectedText || !this.lastProcessedText) return false;

    const isSameText = selectedText === this.lastProcessedText;
    const withinCooldown = (currentTime - this.lastProcessedTime) < this.processingCooldown;
    const uiVisible = this.isWindowVisible();

    // If UI is already visible and text is same, it's ALWAYS a duplicate regardless of time
    // This prevents re-triggering when user is interacting with the sheet/window
    if (uiVisible && isSameText) {
      return true;
    }

    // Otherwise use the standard cooldown logic
    return isSameText && withinCooldown;
  }

  /**
   * Calculate position for selection UI
   */
  calculateSelectionPosition(selection) {
    try {
      if (!selection || selection.rangeCount === 0) {
        this.logger.debug('Position calculation failed: No selection or empty ranges', {
          hasSelection: !!selection,
          rangeCount: selection?.rangeCount
        });
        return null;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      if (!rect || (rect.width === 0 && rect.height === 0)) {
        // Fallback for empty rects (e.g., input fields)
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT')) {
          const elementRect = activeElement.getBoundingClientRect();
          this.logger.debug('Using input field position fallback', {
            tagName: activeElement.tagName,
            rect: elementRect
          });
          return {
            x: elementRect.left + 10 + window.scrollX,
            y: elementRect.bottom + 10 + window.scrollY
          };
        }

        const selectedText = selection.toString();
        if (selectedText && typeof selection.getComposedRanges === 'function') {
          const shadowRoots = this.getSelectionShadowRoots(selection);
          const position = this.getComposedRangePosition(selection, shadowRoots);
          if (position) return position;

          const descendantRoots = this.getDescendantSelectionShadowRoots(selection);
          const expandedRoots = new Set([...shadowRoots, ...descendantRoots]);
          if (descendantRoots.length > 0) {
            const expandedPosition = this.getComposedRangePosition(selection, [...expandedRoots], false, true);
            if (expandedPosition) return expandedPosition;
          } else if (shadowRoots.length === 0) {
            const documentPosition = this.getComposedRangePosition(selection, shadowRoots, true);
            if (documentPosition) return documentPosition;
          }
        }

        this.logger.debug('Position calculation failed: Empty rectangle and not input field', {
          rect: rect,
          activeElement: activeElement?.tagName,
          selectionText: selection.toString().substring(0, 50)
        });
        return null;
      }

      const iconSize = WindowsConfig.POSITIONING.ICON_SIZE || 32;
      const selectionCenter = rect.left + rect.width / 2;

      // For iframes, we prefer sending viewport-relative coordinates
      // because the main frame can easily map them to its own viewport.
      const isTopFrame = window === window.top;
      
      return {
        x: selectionCenter - (iconSize / 2) + (isTopFrame ? window.scrollX : 0),
        y: rect.bottom + (WindowsConfig.POSITIONING.SELECTION_OFFSET || 10) + (isTopFrame ? window.scrollY : 0),
        // Add a flag so the receiver knows if scroll was already included
        _isViewportRelative: !isTopFrame
      };

    } catch (error) {
      this.logger.error('Error calculating selection position:', error);
      return null;
    }
  }

  getSelectionShadowRoots(selection) {
    const roots = new Set();
    const addRoot = (node) => {
      let root = node?.getRootNode?.();
      while (root instanceof ShadowRoot && root.mode === 'open' && root.host.shadowRoot === root) {
        roots.add(root);
        root = root.host.getRootNode();
      }
    };

    addRoot(selection.anchorNode);
    addRoot(selection.focusNode);
    for (const node of [selection.anchorNode, selection.focusNode, document.activeElement]) {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (element?.shadowRoot?.mode === 'open') addRoot(element.shadowRoot);
    }

    return [...roots];
  }

  getDescendantSelectionShadowRoots(selection) {
    const roots = new Set();
    const scopes = new Set(
      [selection.anchorNode, selection.focusNode]
        .map((node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)
        .filter(Boolean)
    );
    for (const scope of scopes) {
      walkOpenShadowTree(scope, (element) => {
        if (element.shadowRoot?.mode === 'open') roots.add(element.shadowRoot);
      });
    }

    return [...roots];
  }

  getComposedRangePosition(selection, shadowRoots, allowDocumentRange = false, allowElementRange = false) {
    let elementPosition = null;
    for (const range of selection.getComposedRanges({ shadowRoots })) {
      if (!range || range.collapsed || this.isExtensionUiRange(range) ||
          !this.isComposedRangeForSelection(range, selection, shadowRoots, allowDocumentRange, allowElementRange)) continue;

      const measurableRange = this.createRangeFromStaticRange(range);
      if (!measurableRange) continue;

      const rect = measurableRange.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom) ||
          !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
          (rect.width === 0 && rect.height === 0)) continue;

      const iconSize = WindowsConfig.POSITIONING.ICON_SIZE || 32;
      const isTopFrame = window === window.top;
      const position = {
        x: rect.left + rect.width / 2 - (iconSize / 2) + (isTopFrame ? window.scrollX : 0),
        y: rect.bottom + (WindowsConfig.POSITIONING.SELECTION_OFFSET || 10) + (isTopFrame ? window.scrollY : 0),
        _isViewportRelative: !isTopFrame
      };
      if (range.startContainer.nodeType === Node.TEXT_NODE && range.endContainer.nodeType === Node.TEXT_NODE) return position;
      elementPosition ||= position;
    }
    return elementPosition;
  }

  isComposedRangeForSelection(range, selection, shadowRoots, allowDocumentRange, allowElementRange) {
    const roots = new Set(shadowRoots);
    const startRoot = range.startContainer.getRootNode();
    const endRoot = range.endContainer.getRootNode();
    if (startRoot === endRoot && roots.has(startRoot)) {
      if (range.startContainer.nodeType === Node.TEXT_NODE && range.endContainer.nodeType === Node.TEXT_NODE) return true;

      const anchorRoot = selection.anchorNode?.getRootNode();
      const focusRoot = selection.focusNode?.getRootNode();
      const matchesBoundaries = (startNode, startOffset, endNode, endOffset) =>
        range.startContainer === startNode && range.startOffset === startOffset &&
        range.endContainer === endNode && range.endOffset === endOffset;
      const boundariesMatch = matchesBoundaries(selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset) ||
        matchesBoundaries(selection.focusNode, selection.focusOffset, selection.anchorNode, selection.anchorOffset);
      const containsNestedHost = this.rangeContainsNestedShadowHost(range, startRoot);

      if (anchorRoot === startRoot && focusRoot === startRoot && boundariesMatch &&
          !containsNestedHost) return true;

      if (allowElementRange && anchorRoot === startRoot && focusRoot === startRoot && boundariesMatch &&
          range.startContainer.nodeType === Node.ELEMENT_NODE && range.endContainer === range.startContainer &&
          containsNestedHost && this.hasLightDomTextOutsideNestedHosts(
            range.startContainer, startRoot, range.startOffset, range.endOffset
          )) {
        return true;
      }
      if (containsNestedHost) return false;

      if (!allowElementRange || range.startContainer.nodeType !== Node.ELEMENT_NODE ||
          range.endContainer !== range.startContainer || this.hasNestedShadowHost(range.startContainer, startRoot, roots)) return false;

      if (anchorRoot !== startRoot || focusRoot !== startRoot) {
        return range.startOffset === 0 && range.endOffset === range.startContainer.childNodes.length;
      }

      return boundariesMatch;
    }

    if (!allowDocumentRange || roots.size > 0 || startRoot !== document || endRoot !== document) return false;
    const matchesBoundaries = (startNode, startOffset, endNode, endOffset) =>
      range.startContainer === startNode && range.startOffset === startOffset &&
      range.endContainer === endNode && range.endOffset === endOffset;

    return matchesBoundaries(selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset) ||
      matchesBoundaries(selection.focusNode, selection.focusOffset, selection.anchorNode, selection.anchorOffset);
  }

  hasNestedShadowHost(container, rangeRoot, roots) {
    return [...roots].some((root) => root !== rangeRoot && container.contains(root.host));
  }

  rangeContainsNestedShadowHost(range, rangeRoot) {
    const container = range.startContainer;
    if (container.nodeType !== Node.ELEMENT_NODE || range.endContainer !== container) return false;
    if (container.shadowRoot && container.shadowRoot !== rangeRoot) return true;

    for (let index = range.startOffset; index < range.endOffset; index += 1) {
      const child = container.childNodes[index];
      if (child?.nodeType !== Node.ELEMENT_NODE) continue;
      let hasNestedRoot = false;
      walkOpenShadowTree(child, (element) => {
        if (element.shadowRoot && element.shadowRoot !== rangeRoot) hasNestedRoot = true;
      });
      if (hasNestedRoot) return true;
    }
    return false;
  }

  hasLightDomTextOutsideNestedHosts(container, rangeRoot, startOffset, endOffset) {
    const hasText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim();
      if (node.nodeType !== Node.ELEMENT_NODE || (node.shadowRoot && node.shadowRoot !== rangeRoot)) return false;
      return [...node.childNodes].some(hasText);
    };
    return [...container.childNodes].slice(startOffset, endOffset).some(hasText);
  }

  isExtensionUiRange(range) {
    let node = range.startContainer;
    while (node) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (element?.id && Object.values(UI_HOST_IDS).includes(element.id)) return true;
      const root = node.getRootNode?.();
      if (!(root instanceof ShadowRoot)) break;
      node = root.host;
    }
    return false;
  }

  createRangeFromStaticRange(staticRange) {
    try {
      const range = document.createRange();
      range.setStart(staticRange.startContainer, staticRange.startOffset);
      range.setEnd(staticRange.endContainer, staticRange.endOffset);
      return range;
    } catch {
      return null;
    }
  }

  /**
   * Show translation UI (icon or window based on settings)
   */
  async showTranslationUI(selectedText, position, options = {}, toolbarPosition = null) {
    // Note: We no longer call WindowsManager.show() directly here.
    // The GLOBAL_SELECTION_CHANGE event emitted in processSelection() 
    // triggers all UI managers independently (Decoupled Architecture).

    // Only handle cross-frame relaying if we are in an iframe
    // because the local PageEventBus won't reach the main frame's WindowsManager.
    const isTopFrame = window === window.top;
    if (!isTopFrame) {
      this.logger.info('Relaying translation window request from iframe to parent', {
        frameId: this.frameId,
        textLength: selectedText.length
      });

      this.requestWindowCreationInMainFrame(selectedText, position, options, toolbarPosition);
    }
  }

  /**
   * Request window creation in main frame (for iframe context)
   */
  requestWindowCreationInMainFrame(selectedText, position, options = {}, toolbarPosition = null) {
    try {
      const message = {
        type: WindowsConfig.CROSS_FRAME.TEXT_SELECTION_WINDOW_REQUEST,
        frameId: this.frameId,
        selectedText: selectedText,
        position: position,
        ...(toolbarPosition ? { toolbarPosition } : {}),
        options: options, // Pass keyboard state
        timestamp: Date.now()
      };

      if (window.parent !== window) {
        window.parent.postMessage(message, '*');
        this.logger.debug('Text selection window request sent to parent frame');
      }

    } catch (error) {
      this.logger.error('Failed to request window creation in main frame:', error);
    }
  }

  /**
   * Dismiss any visible translation windows
   */
  dismissWindow() {
    // 1. Emit global clear event (Coordinator Pattern)
    // This allows any module (WindowsManager, FAB, etc.) to clear its state
    this.logger.debug('Emitting GLOBAL_SELECTION_CLEAR', { reason: 'selection_cleared' });
    pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR, {
      reason: 'selection_cleared'
    });

    // Clear tracking
    this.lastProcessedText = null;
    this.lastProcessedTime = 0;
  }

  /**
   * Check if translation UI is visible on screen
   * Uses Shadow DOM check as the final source of truth (Decoupled)
   */
  isWindowVisible() {
    const shadowHost = document.getElementById(UI_HOST_IDS.MAIN) ||
                      document.getElementById(UI_HOST_IDS.IFRAME);

    if (shadowHost && shadowHost.shadowRoot) {
      const activeWindows = shadowHost.shadowRoot.querySelectorAll('.translation-window');
      const activeIcons = shadowHost.shadowRoot.querySelectorAll('.translation-icon');
      const activeFabBadges = shadowHost.shadowRoot.querySelectorAll('.fab-translate-badge');
      return activeWindows.length > 0 || activeIcons.length > 0 || activeFabBadges.length > 0;
    }

    return false;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.lastProcessedText = null;
    this.lastProcessedTime = 0;

    // Call parent cleanup
    super.cleanup();

    this.logger.debug('SelectionManager cleaned up');
  }

  /**
   * Get manager info for debugging
   */
  getInfo() {
    return {
      initialized: true,
      uiVisible: this.isWindowVisible(),
      isExcluded: this.isExcluded,
      frameId: this.frameId,
      lastProcessedText: this.lastProcessedText ? this.lastProcessedText.substring(0, 50) + '...' : null,
      lastProcessedTime: this.lastProcessedTime,
      timeSinceLastProcess: this.lastProcessedTime ? Date.now() - this.lastProcessedTime : null
    };
  }
}

export default SelectionManager;

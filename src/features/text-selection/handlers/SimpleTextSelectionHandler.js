import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { SelectionManager } from '../core/SelectionManager.js';
import ElementDetectionService from '@/shared/services/ElementDetectionService.js';
import { settingsManager } from '@/shared/managers/SettingsManager.js';
import { INPUT_TYPES } from '@/shared/constants/detection.js';
import { SelectionTranslationMode } from '@/shared/config/config.js';
import { COMBINED_SELECTORS } from '@/shared/services/ElementDetectionConfig.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { sendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';

const logger = getScopedLogger(LOG_COMPONENTS.TEXT_SELECTION, 'SimpleTextSelectionHandler');

// Bounded window (ms) during which a pointerdown inside extension UI protects
// the floating window from empty-selection dismissal. Selection processing is
// debounced (~100ms) and can run before the mouseup is recorded, or the
// mouseup may never reach the bubble-phase listener when it is stopped inside
// the UI's shadow DOM. Any new pointerdown overwrites this context, so a
// genuine outside click still dismisses immediately.
const UI_INTERACTION_CONTEXT_MS = 1000;
const TOOLBAR_RELEASE_FRESHNESS_MS = 1200;

// Singleton instance for SimpleTextSelectionHandler
let simpleTextSelectionHandlerInstance = null;

/**
 * Simplified Text Selection Handler
 *
 * Handles page text selection using only selectionchange events.
 * Much simpler than the old complex drag detection system.
 *
 * Features:
 * - Single selectionchange event listener
 * - Debounced processing for performance
 * - Ctrl key requirement support
 * - Clean integration with WindowsManager
 */
export class SimpleTextSelectionHandler extends ResourceTracker {
  constructor(options = {}) {
    super('simple-text-selection-handler');

    // Enforce singleton pattern
    if (simpleTextSelectionHandlerInstance) {
      logger.debug('SimpleTextSelectionHandler singleton already exists, returning existing instance');
      return simpleTextSelectionHandlerInstance;
    }

    this.isActive = false;
    this.selectionManager = null;
    this.featureManager = options.featureManager;

    // Simple debouncing for performance
    this.selectionTimeout = null;
    this.debounceDelay = 100; // 100ms debounce

    // Track Ctrl key state
    this.ctrlKeyPressed = false;
    this.lastKeyEventTime = 0;
    this.lastMouseEventTime = 0;

    // Track Shift key state for Shift+Click operations
    this.shiftKeyPressed = false;
    this.isInShiftClickOperation = false;

    // Simple drag detection to prevent selection during drag
    this.isDragging = false;
    this.mouseDownTime = 0;
    this.lastMouseUpEvent = null;
    this._selectionChangeVersion = 0;
    this._primaryMouseDown = null;
    this._primaryMouseInteractionSequence = 0;
    this._lastMouseUpInteractionId = null;
    this._lastSelectionInteractionId = null;
    this._toolbarReleaseCandidate = null;

    // Diagnostic metadata captured synchronously during mouseup dispatch
    // (composedPath() is unreliable once dispatch has finished).
    this._lastMouseUpDiagnostics = null;
    this._lastNativeClickContext = null;
    this._lastSelectionRange = null;
    this._lastSelectionTarget = null;
    this._lastSelectionText = null;
    this._selectionContinuationToken = null;
    this._selectionContinuationText = null;
    this._activeSelectionToken = null;
    this._continuationClickIssued = false;
    this._continuationSequence = 0;
    this._continuationExpiryTimer = null;

    // Bounded interaction context: start of the latest pointer interaction,
    // classified read-only during the capture phase. { insideUi, timestamp }.
    this._lastUiPointerInteraction = null;

    // Simplified triple-click + drag support
    this.lastTripleClickTime = 0;
    this.isWaitingForDragEnd = false;

    // Smart selection preservation system
    this._preservationState = {
      active: false,
      reason: null,
      timestamp: 0,
      timeout: null,
      duration: 1000
    };

    // Simple typing detection for text field preservation
    this.typingDetection = {
      isActive: false,
      startTime: 0,
      timeout: null
    };

    // Element detection service
    this.elementDetection = ElementDetectionService;

    // Settings change listeners
    this._settingsListeners = [];

    // Bind methods
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleUiPointerDownCapture = this.handleUiPointerDownCapture.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleInput = this.handleInput.bind(this);

    // Store singleton instance
    simpleTextSelectionHandlerInstance = this;

    // Make instance globally available for WindowsManager
    window.simpleTextSelectionHandlerInstance = this;

    logger.debug('SimpleTextSelectionHandler singleton created');
  }

  // Static method to get singleton instance
  static getInstance(options = {}) {
    if (!simpleTextSelectionHandlerInstance) {
      simpleTextSelectionHandlerInstance = new SimpleTextSelectionHandler(options);
    } else if (options.featureManager && !simpleTextSelectionHandlerInstance.featureManager) {
      // Update featureManager if it wasn't set initially
      simpleTextSelectionHandlerInstance.featureManager = options.featureManager;
      logger.debug('Updated SimpleTextSelectionHandler with FeatureManager');
    }
    return simpleTextSelectionHandlerInstance;
  }

  // Method to reset singleton (for testing or cleanup)
  static resetInstance() {
    if (simpleTextSelectionHandlerInstance) {
      simpleTextSelectionHandlerInstance.cleanup();
      simpleTextSelectionHandlerInstance = null;
    }
  }

  async activate() {
    if (this.isActive) {
      logger.debug('SimpleTextSelectionHandler already active');
      return true;
    }

    try {
      logger.debug('Activating SimpleTextSelectionHandler');

      // Start from a clean interaction context; never inherit stale state
      this._lastUiPointerInteraction = null;
      this._lastMouseUpDiagnostics = null;
      this._primaryMouseDown = null;
      this._toolbarReleaseCandidate = null;
      this._clearSelectionContinuation();

      // If selectionManager already exists, clean it up first
      if (this.selectionManager) {
        this.selectionManager = null;
      }

      // Create selection manager
      this.selectionManager = new SelectionManager({
        featureManager: this.featureManager
      });

      // Setup event listeners
      this.setupEventListeners();

      // Setup settings listeners
      this.setupSettingsListeners();

      // Note: SelectionManager is already a ResourceTracker and handles its own cleanup
      // We just need to null our reference when we're deactivated
      // No need to track it since it manages itself

      this.isActive = true;
      logger.info('SimpleTextSelectionHandler activated successfully');
      return true;

    } catch (error) {
      try {
        const handler = ErrorHandler.getInstance();
        handler.handle(error, {
          type: ErrorTypes.SERVICE,
          context: 'SimpleTextSelectionHandler-activate',
          showToast: false
        });
      } catch (handlerError) {
        logger.error('Error activating SimpleTextSelectionHandler:', error);
        logger.error('ErrorHandler not available:', handlerError);
      }
      return false;
    }
  }

  async deactivate() {
    if (!this.isActive) {
      logger.debug('SimpleTextSelectionHandler not active');
      return true;
    }

    try {
      logger.debug('Deactivating SimpleTextSelectionHandler');

      // 1. Remove DOM Listeners explicitly (with matching options)
      this._removeDOMListeners();

      // 2. Clear any pending timeouts and animation frames
      this._clearAllTimers();

      // 2.5 Clear interaction context so reactivation cannot inherit stale state
      this._lastUiPointerInteraction = null;
      this._lastMouseUpDiagnostics = null;
      this._primaryMouseDown = null;
      this._toolbarReleaseCandidate = null;
      this._clearSelectionContinuation();

      // 3. Clean up settings listeners
      this._settingsListeners.forEach(unsubscribe => {
        if (unsubscribe) unsubscribe();
      });
      this._settingsListeners = [];

      // 4. Dismiss and cleanup managers
      if (this.selectionManager) {
        this.selectionManager.dismissWindow();
        this.selectionManager.cleanup();
      }
      this.selectionManager = null;

      // 5. Final resource cleanup via parent
      this.cleanup();

      this.isActive = false;
      logger.info('SimpleTextSelectionHandler deactivated successfully');
      return true;

    } catch (error) {
      logger.error('Error deactivating SimpleTextSelectionHandler:', error);
      this.isActive = false;
      return true;
    }
  }

  /**
   * Explicitly remove all registered DOM listeners
   * @private
   */
  _removeDOMListeners() {
    // Use exact same targets and options as setupEventListeners
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    window.removeEventListener('pointerdown', this.handleUiPointerDownCapture, { capture: true });
    window.removeEventListener('mousedown', this.handleMouseDown, { critical: true });
    window.removeEventListener('mouseup', this.handleMouseUp, { critical: true });
    window.removeEventListener('click', this.handleClick, { capture: true });
    window.removeEventListener('mousemove', this.handleMouseMove, { critical: true });
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    document.removeEventListener('input', this.handleInput, { capture: true });
  }

  /**
   * Clear all active timers and animation frames
   * @private
   */
  _clearAllTimers() {
    if (this.selectionTimeout) clearTimeout(this.selectionTimeout);
    if (this._shiftKeyTimeout) clearTimeout(this._shiftKeyTimeout);
    if (this._mouseUpTimeout) clearTimeout(this._mouseUpTimeout);
    if (this._mouseUpAnimationFrame) cancelAnimationFrame(this._mouseUpAnimationFrame);
    this._clearPreservationTimer();
    this.cleanupTypingDetection();
    this.isWaitingForDragEnd = false;
    this._clearSelectionContinuation();
  }

  _clearSelectionContinuation() {
    if (this._continuationExpiryTimer) clearTimeout(this._continuationExpiryTimer);
    this._continuationExpiryTimer = null;
    this._lastSelectionRange = null;
    this._lastSelectionTarget = null;
    this._lastSelectionText = null;
    this._selectionContinuationToken = null;
    this._selectionContinuationText = null;
    this._activeSelectionToken = null;
    this._continuationClickIssued = false;
    window.__translateItPendingSelectionContinuationToken = null;
  }

  cleanup() {
    this._clearSelectionContinuation();
    super.cleanup();
  }

  setupEventListeners() {
    try {

      // Main selection change listener
      this.addEventListener(document, 'selectionchange', this.handleSelectionChange, {
        critical: true
      });

      // Simple drag detection - use window to prevent duplicate events
      // Capture-phase pointerdown: records the start of pointer interaction
      // inside extension UI before any shadow-DOM stopPropagation can hide
      // the event from the bubble-phase listeners.
      this.addEventListener(window, 'pointerdown', this.handleUiPointerDownCapture, {
        capture: true,
        critical: true
      });
      this.addEventListener(window, 'mousedown', this.handleMouseDown, {
        critical: true
      });
      this.addEventListener(window, 'mouseup', this.handleMouseUp, {
        critical: true
      });
      this.addEventListener(window, 'click', this.handleClick, {
        capture: true,
        critical: true
      });
      this.addEventListener(window, 'mousemove', this.handleMouseMove, {
        critical: true
      });

      // Ctrl key tracking for requirement checking
      this.addEventListener(window, 'keydown', this.handleKeyDown);
      this.addEventListener(window, 'keyup', this.handleKeyUp);

      // Simple input detection for text field typing
      this.addEventListener(document, 'input', this.handleInput, {
        capture: true,
        critical: true
      });

      logger.debug('Simple text selection listeners setup complete');

    } catch (error) {
      logger.error('Failed to setup text selection listeners:', error);
    }
  }

  /**
   * Setup settings change listeners for reactive updates
   */
  setupSettingsListeners() {
    try {
      // Note: EXTENSION_ENABLED listener is handled by FeatureManager
      // We don't need to duplicate it here as FeatureManager will handle activation/deactivation

      // TRANSLATE_ON_TEXT_SELECTION changes
      this._settingsListeners.push(
        settingsManager.onChange('TRANSLATE_ON_TEXT_SELECTION', (newValue) => {
          logger.debug('TRANSLATE_ON_TEXT_SELECTION changed:', newValue);
          if (!newValue && this.selectionManager) {
            this.selectionManager.dismissWindow();
          }
        }, 'simple-text-selection')
      );

      // REQUIRE_CTRL_FOR_TEXT_SELECTION changes
      this._settingsListeners.push(
        settingsManager.onChange('REQUIRE_CTRL_FOR_TEXT_SELECTION', (newValue) => {
          logger.debug('REQUIRE_CTRL_FOR_TEXT_SELECTION changed:', newValue);
          // Reset Ctrl state when setting changes to avoid stale "stuck" keys
          this.ctrlKeyPressed = false;
        }, 'simple-text-selection')
      );

      // selectionTranslationMode changes
      this._settingsListeners.push(
        settingsManager.onChange('selectionTranslationMode', (newValue) => {
          logger.debug('selectionTranslationMode changed:', newValue);
          if (newValue === SelectionTranslationMode.ON_CLICK && this.selectionManager) {
            this.selectionManager.dismissWindow();
          }
        }, 'simple-text-selection')
      );

      logger.debug('Settings listeners setup complete');

    } catch (error) {
      logger.error('Failed to setup settings listeners:', error);
    }
  }

  /**
   * Smart selection preservation system
   * Combines event-driven approach with timer optimization
   */
  _startSelectionPreservation(reason, customDuration = null) {
    this._clearPreservationTimer();

    const duration = customDuration || this._getOptimalDuration(reason);

    this._preservationState = {
      active: true,
      reason,
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        this._preservationState.active = false;
        this._preservationState.timeout = null;
        logger.debug('Selection preservation expired', { reason });
      }, duration),
      duration
    };

    // Set global flags for cross-component communication
    window.translateItJustFinishedSelection = true;
    window.translateItSelectionPreservationReason = reason;

    // Clear global flags after preservation period
    setTimeout(() => {
      window.translateItJustFinishedSelection = false;
      window.translateItSelectionPreservationReason = null;
    }, duration);

    logger.debug('Selection preservation started', { reason, duration });
  }

  /**
   * Clear preservation timer
   */
  _clearPreservationTimer() {
    if (this._preservationState.timeout) {
      clearTimeout(this._preservationState.timeout);
      this._preservationState.timeout = null;
    }
    this._preservationState.active = false;
  }

  /**
   * Get optimal preservation duration based on selection type
   */
  _getOptimalDuration(reason) {
    const durations = {
      'triple-click-drag': 2500,     // Longer for triple-click + drag
      'shift-click': 2000,           // Medium for Shift+Click
      'regular-drag': 1500,          // Standard for drag
      'post-drag-selection': 1800,   // Extended for immediate post-drag
      'keyboard-selection': 1000,    // Shorter for keyboard
      'default': 1000                // Increased from 1000 to 1500 for better UX
    };
    return durations[reason] || durations.default;
  }

  /**
   * Check if preservation is currently active
   */
  _isPreservationActive() {
    return this._preservationState.active &&
           Date.now() - this._preservationState.timestamp < this._preservationState.duration;
  }

  /**
   * Detect selection type based on current state
   */
  _detectSelectionType() {
    const currentTime = Date.now();

    // Enhanced triple-click + drag detection
    if (currentTime - this.lastTripleClickTime < 500 &&
        this.isDragging) {
      return 'triple-click-drag';
    }

    // Regular drag detection with extended time window
    if (this.isDragging) {
      return 'regular-drag';
    }

    // Shift+Click detection
    if (this.shiftKeyPressed) {
      return 'shift-click';
    }

    // Check if keyboard selection (Ctrl+A, Shift+Arrow)
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      const recentKeyEvent = currentTime - this.lastKeyEventTime < 300; // Extended window
      const recentMouseEvent = currentTime - this.lastMouseEventTime < 150; // Extended window

      if (recentKeyEvent && !recentMouseEvent) {
        return 'keyboard-selection';
      }
    }

    // Check if this is immediate post-drag scenario
    if (currentTime - this.mouseDownTime < 1000 && selection && selection.toString().trim()) {
      return 'post-drag-selection';
    }

    return 'default';
  }

  /**
   * Handle selection change events - the heart of our simplified system
   */
  handleSelectionChange() {
    if (!this.isActive || !this.selectionManager) return;
    this._selectionChangeVersion += 1;

    // Clear existing timeout
    if (this.selectionTimeout) {
      clearTimeout(this.selectionTimeout);
    }

    // If waiting for drag end after triple-click, don't process selection yet
    if (this.isWaitingForDragEnd) {
      this.selectionTimeout = null;
      logger.debug('Waiting for drag end after triple-click, skipping selection processing');
      return;
    }

    // Debounce to avoid excessive processing
    this.selectionTimeout = setTimeout(() => {
      this.processSelection();
    }, this.debounceDelay);
  }

  /**
   * Process the current text selection
   */
  async processSelection() {
    // CRITICAL SAFETY: Check if active and manager exists
    if (!this.isActive || !this.selectionManager) {
      logger.debug('Skipping selection processing: Handler inactive or manager null');
      return;
    }

    try {
      const selection = window.getSelection();
      const selectedText = selection ? selection.toString().trim() : '';

      logger.debug('Processing selection', {
        hasText: !!selectedText,
        textLength: selectedText.length,
        ctrlPressed: this.ctrlKeyPressed,
        shiftPressed: this.shiftKeyPressed,
        isDragging: this.isDragging
      });

      if (!selectedText) {
        // Only skip dismissal if preservation is active AND we are dragging
        // If the user clicked to unselect (not dragging), we should dismiss regardless of preservation
        if (this._isPreservationActive() && this.isDragging) {
          logger.debug('Selection preservation active during drag - skipping dismissal', {
            reason: this._preservationState.reason
          });
          return;
        }

        // Bounded interaction context from the capture-phase pointerdown.
        // Reliable even when the mouseup is not yet recorded or never reaches
        // this handler (stopped inside the UI's shadow DOM).
        const interaction = this._hasRecentUiInteraction();

        // The interaction began inside extension UI: never dismiss
        if (interaction && interaction.insideUi) {
          logger.debug('Recent pointer interaction inside extension UI - skipping dismissal', {
            ageMs: interaction.ageMs
          });
          return;
        }

        // Stale-mouseup fallback: only trusted when no recent interaction
        // refutes it (a genuine outside click dismisses immediately).
        // No text selected, check if user clicked inside translation window
        const insideTranslationWindow = !interaction && this.isClickInsideTranslationWindow();
        if (insideTranslationWindow) {
          logger.debug('Click inside translation window, not dismissing');
          return;
        }

        // Skip if currently dragging (prevents dismissal during drag operations)
        if (this.isDragging) {
          logger.debug('Currently dragging with no text selected, skipping dismissal');
          return;
        }

        // Skip dismissal during Shift+Click operations
        if (this.shiftKeyPressed) {
          logger.debug('Shift+Click in progress with no text selected, skipping dismissal');
          return;
        }

        // No text selected and click outside translation window, dismiss
        if (this.selectionManager) {
          logger.debug('Empty selection dismissing window', {
            preservationActive: this._isPreservationActive(),
            isDragging: this.isDragging,
            shiftPressed: this.shiftKeyPressed,
            insideTranslationWindow,
            recentInteraction: interaction ? 'outside-ui' : null
          });
          this.selectionManager.dismissWindow();
        }
        return;
      }

      // Skip if currently dragging (prevents selection during drag)
      if (this.isDragging) {
        logger.debug('Currently dragging, skipping selection processing');

        // BUT: Start preservation for drag operations to prevent selection clearing
        // EXCEPT: Don't preserve for regular-drag in text fields (let typing detection handle it)
        if (selectedText) {
          const selectionType = this._detectSelectionType();
          const activeElement = document.activeElement;
          const isInTextField = activeElement && activeElement.isConnected && this.isTextField(activeElement);

          if (selectionType === 'regular-drag' && isInTextField) {
            logger.debug('Skipping regular-drag preservation in text field - let typing detection handle it', {
              selectionType,
              textFieldType: activeElement.tagName
            });
          } else if (selectionType === 'regular-drag' ||
                     selectionType === 'triple-click-drag' ||
                     selectionType === 'post-drag-selection') {
            this._startSelectionPreservation(selectionType);
            logger.debug('Preservation started during drag operation', { selectionType });
          }
        }
        return;
      }

      // Skip if select element mode is active
      if (this.isSelectElementModeActive()) {
        logger.debug('Select element mode active, skipping text selection');
        return;
      }

      // Skip if selection is in a text field (handled by TextFieldDoubleClickHandler)
      if (this.isSelectionInTextField()) {
        logger.debug('Selection in text field, skipping (handled by TextFieldDoubleClickHandler)', {
          activeElement: document.activeElement?.tagName,
          activeElementType: document.activeElement?.type,
          selectionText: selectedText.substring(0, 20)
        });
        return;
      }

      // Detect selection type and start preservation
      const selectionType = this._detectSelectionType();

      // CRITICAL: Ignore selections originating from our own UI
      if (this.isSelectionInsideUI(selection)) {
        logger.debug('Selection is inside extension UI, ignoring');
        return;
      }

      this._startSelectionPreservation(selectionType);

      // Process the selection
      if (this.selectionManager) {
        this.logger.debug('Processing valid text selection', {
          textLength: selectedText.length,
          sourceElement: selection?.anchorNode?.nodeName || 'unknown',
          selectionType: selectionType,
          ctrlPressed: this.ctrlKeyPressed
        });
        
        // Pass the keyboard state to selection manager
        const continuationToken = this._selectionContinuationToken;
        const currentRange = selection?.rangeCount && typeof selection.getRangeAt === 'function'
          ? selection.getRangeAt(0)
          : null;
        const toolbarPosition = this._consumeToolbarReleasePosition(
          selectedText,
          continuationToken,
          currentRange,
        );
        const selectionUnchanged = selectedText === this._lastSelectionText && currentRange &&
          this._lastSelectionRange && this._isSameRange(currentRange, this._lastSelectionRange);
        const samePriorSelection = selectionUnchanged &&
          this._isRelatedSelectionTarget(this._lastSelectionTarget, this.lastMouseUpEvent?.target);
        const originToken = continuationToken ||
          (samePriorSelection ? this._activeSelectionToken : null) || this._newSelectionToken();
        const displayInteraction = this._getDisplayInteraction(selectionType, selection);
        this._selectionContinuationToken = null;
        this._selectionContinuationText = null;
        const displayed = await this.selectionManager.processSelection(selectedText, selection, {
          ctrlPressed: this.ctrlKeyPressed,
          shiftPressed: this.shiftKeyPressed,
          ...(this._lastSelectionInteractionId !== null && (!selectionUnchanged || continuationToken)
            ? { selectionInteractionId: this._lastSelectionInteractionId }
            : {}),
          ...(toolbarPosition ? { toolbarPosition } : {}),
          ...(originToken ? { selectionContinuationToken: originToken } : {}),
          ...(displayInteraction ? { displayInteraction } : {})
        });
        if (displayed && selection?.rangeCount && typeof selection.getRangeAt === 'function') {
          this._activeSelectionToken = originToken;
          this._continuationClickIssued = false;
          this._lastSelectionRange = selection.getRangeAt(0).cloneRange();
          this._lastSelectionTarget = this.lastMouseUpEvent?.target || null;
          this._lastSelectionText = selectedText;
        } else if (!selectionUnchanged) {
          this._lastSelectionRange = null;
          this._lastSelectionText = null;
          this._lastSelectionTarget = null;
          this._activeSelectionToken = null;
          this._continuationClickIssued = false;
        } else if (!samePriorSelection) {
          this._lastSelectionTarget = null;
          this._activeSelectionToken = null;
          this._continuationClickIssued = false;
        }
      } else {
        logger.warn('SelectionManager is null - this should not happen with critical protection');
      }

    } catch (error) {
      logger.error('Error processing selection:', error);
      try {
        const handler = ErrorHandler.getInstance();
        await handler.handle(error, {
          type: ErrorTypes.UI,
          context: 'simple-text-selection-process',
          showToast: false
        });
      } catch (handlerError) {
        logger.error('ErrorHandler not available when processing selection:', handlerError);
      }
    }
  }

  /**
   * Check if the selection originated from inside our own UI elements
   */
  isSelectionInsideUI(selection) {
    // 1. Check if the last mouse up was inside our UI (highly reliable for mouse selections)
    if (this.isClickInsideTranslationWindow()) {
      return true;
    }

    if (!selection || !selection.anchorNode) return false;

    try {
      /**
       * Helper to check if a node is inside our UI
       */
      const isOurNode = (node) => {
        if (!node) return false;
        
        // Get the element container
        const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!element) return false;

        // Check standard element matching (isUIElement checks ancestors too)
        if (this.elementDetection.isUIElement(element)) {
          return true;
        }
        
        // Check Shadow DOM boundaries
        const root = node.getRootNode();
        if (root instanceof ShadowRoot) {
          // Specifically verify if this shadow root host belongs to our extension
          // This prevents ignoring selections in OTHER extensions' shadow DOMs
          if (this.elementDetection.isHostElement(root.host)) {
            return true;
          }
        }
        
        return false;
      };

      // 2. Check anchorNode (where selection started)
      if (isOurNode(selection.anchorNode)) {
        return true;
      }

      // 3. Check focusNode (where selection ended)
      if (isOurNode(selection.focusNode)) {
        return true;
      }

      // 4. Check common ancestor if range exists
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (isOurNode(range.commonAncestorContainer)) {
          return true;
        }
      }

    } catch (error) {
      logger.debug('Error checking if selection is inside UI:', error);
    }

    return false;
  }

  /**
   * Check if we should process this selection based on settings
   */
  async shouldProcessSelection() {
    try {
      // Check if extension is enabled
      const isExtensionEnabled = settingsManager.get('EXTENSION_ENABLED', false);
      if (!isExtensionEnabled) {
        logger.debug('Extension disabled, skipping selection');
        return false;
      }

      // Check if either the main text selection feature OR the Desktop FAB is enabled
      const isTextSelectionEnabled = settingsManager.get('TRANSLATE_ON_TEXT_SELECTION', false);
      const isFabEnabled = settingsManager.get('SHOW_DESKTOP_FAB', false);

      if (!isTextSelectionEnabled && !isFabEnabled) {
        logger.debug('Both text selection and FAB are disabled, skipping');
        return false;
      }

      return true;

    } catch (error) {
      logger.warn('Error checking selection requirements:', error);
      return true; // Default to allowing selection
    }
  }

  /**
   * Check if select element mode is active
   */
  isSelectElementModeActive() {
    try {
      return window.translateItNewSelectManager ||
             (window.selectElementManagerInstance && window.selectElementManagerInstance.isActive);
    } catch {
      return false;
    }
  }

  /**
   * Check if current selection is in a text field
   */
  isSelectionInTextField() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return false;
      }

      // Get the active element (focused element)
      const activeElement = document.activeElement;
      if (this.isTextField(activeElement)) {
        logger.debug('Selection detected in active text field', {
          tagName: activeElement.tagName,
          type: activeElement.type
        });
        return true;
      }

      // Check if selection range is within a text field
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;

      // Walk up the DOM to find if we're inside a text field
      let element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;

      while (element && element !== document.body) {
        if (this.isTextField(element)) {
          logger.debug('Selection detected within text field element', {
            tagName: element.tagName,
            type: element.type
          });
          return true;
        }
        element = element.parentElement;
      }

      return false;

    } catch (error) {
      logger.debug('Error checking if selection is in text field:', error);
      return false;
    }
  }

  /**
   * Check if element is a text field
   */
  isTextField(element) {
    if (!element) return false;

    // Standard input fields
    if (element.tagName === 'INPUT') {
      const type = (element.type || '').toLowerCase();
      // Use all text field types for selection detection (to ignore text selections in these fields)
      return INPUT_TYPES.ALL_TEXT_FIELDS.includes(type);
    }

    // Textarea
    if (element.tagName === 'TEXTAREA') {
      return true;
    }

    // Contenteditable elements
    if (element.contentEditable === 'true') {
      return true;
    }

    return false;
  }

  /**
   * Update Ctrl key state by checking actual keyboard state
   */
  updateCtrlKeyState() {
    // Use Keyboard API if available (most reliable)
    if (typeof navigator.keyboard !== 'undefined') {
      try {
        const hasCtrl = navigator.keyboard.getModifierState('Control');
        const hasMeta = navigator.keyboard.getModifierState('Meta');
        this.ctrlKeyPressed = hasCtrl || hasMeta;
        logger.debug('Ctrl key state from Keyboard API:', this.ctrlKeyPressed);
        return;
      } catch {
        logger.debug('Keyboard API failed, using fallback');
      }
    }

    // Simple and reliable fallback
    // The issue is that we can't reliably get modifier state without Keyboard API
    // So we'll use a simple time-based reset to prevent the "stuck Ctrl" issue
    if (Date.now() - this.lastKeyEventTime > 300) {
      // If no key event for 300ms, check if we should reset Ctrl state
      // Only reset if it was previously true (to avoid false negatives)
      if (this.ctrlKeyPressed) {
        // We can't be sure, so let's assume Ctrl is not pressed
        // This is better than having it stuck on true
        this.ctrlKeyPressed = false;
        logger.debug('Ctrl key state reset after timeout');
      }
    }
  }

  /**
   * Check if a key event was recent (within last 100ms)
   */
  isKeyEventRecent() {
    return Date.now() - this.lastKeyEventTime < 100;
  }

  /**
   * Check if Ctrl key was pressed recently (within last 200ms)
   * This is more reliable than trying to get the current keyboard state
   */
  isCtrlRecentlyPressed() {
    const now = Date.now();

    // If we have a recent keydown event, use the stored state
    if (now - this.lastKeyEventTime < 200) {
      return this.ctrlKeyPressed;
    }

    // If we have a recent mouse event, try to get the modifier state from the event
    if (now - this.lastMouseEventTime < 100) {
      // Check if the last mouse event had Ctrl pressed
      // This helps when Ctrl is held during mouse operations
      try {
        // We can't get the actual modifier state from past events
        // So we'll use a heuristic: if Ctrl was recently pressed and we're in a mouse operation,
        // assume it's still pressed
        return this.ctrlKeyPressed && (now - this.lastKeyEventTime < 1000);
      } catch {
        // Fall back to simple check
        return this.ctrlKeyPressed;
      }
    }

    // If no recent events, check if we should maintain the Ctrl state
    // Only maintain if it was set within the last second
    if (this.ctrlKeyPressed && (now - this.lastKeyEventTime < 1000)) {
      return true;
    }

    // Otherwise, assume Ctrl is not pressed
    return false;
  }

  /**
   * Handle key down events for Ctrl and Shift tracking
   */
  handleKeyDown(event) {
    this.lastKeyEventTime = Date.now();
    this._clearSelectionContinuation();
    if (this.isWaitingForDragEnd && !this.isDragging) this.isWaitingForDragEnd = false;
    this._primaryMouseDown = null;
    this._lastSelectionInteractionId = null;
    this._toolbarReleaseCandidate = null;

    // A keyboard interaction originating outside extension UI refutes any
    // recent inside-UI pointer context, so keyboard-driven selection clearing
    // still dismisses the window within the bounded context window. Keyboard
    // interaction inside the UI (e.g. source textarea editing) keeps it.
    // Classification is read-only (no detection cache).
    if (this._classifyComposedPath(event) === false) {
      this._lastUiPointerInteraction = { insideUi: false, timestamp: Date.now() };
    }

    if (event.ctrlKey || event.metaKey) {
      this.ctrlKeyPressed = true;
      // logger.debug('Ctrl key pressed down');
    }
    if (event.shiftKey) {
      this.shiftKeyPressed = true;
      this.isInShiftClickOperation = true;

      // Set global flag for WindowsManager to check
      window.translateItShiftClickOperation = true;

      // Clean up previous shift key release handler if exists
      if (this._shiftKeyReleaseHandler) {
        document.removeEventListener('keyup', this._shiftKeyReleaseHandler, { capture: true });
        this._shiftKeyReleaseHandler = null;
      }

      // Clean up previous fallback timeout if exists
      if (this._shiftKeyTimeout) {
        clearTimeout(this._shiftKeyTimeout);
        this._shiftKeyTimeout = null;
      }

      // Set up event-based Shift key release detection
      this._shiftKeyReleaseHandler = (event) => {
        if (event.key === 'Shift' && this.isInShiftClickOperation) {
          this.isInShiftClickOperation = false;
          this.shiftKeyPressed = false;
          window.translateItShiftClickOperation = false;

          // Clean up event listener
          document.removeEventListener('keyup', this._shiftKeyReleaseHandler, { capture: true });
          this._shiftKeyReleaseHandler = null;

          // Clean up fallback timeout
          if (this._shiftKeyTimeout) {
            clearTimeout(this._shiftKeyTimeout);
            this._shiftKeyTimeout = null;
          }

          logger.debug('Shift key released via event listener');
        }
      };

      // Add event listener with capture for immediate response
      document.addEventListener('keyup', this._shiftKeyReleaseHandler, { capture: true });

      // Fallback timeout as backup (reduced from 2s to 1.5s)
      this._shiftKeyTimeout = setTimeout(() => {
        if (this.isInShiftClickOperation) {
          this.isInShiftClickOperation = false;
          this.shiftKeyPressed = false;
          window.translateItShiftClickOperation = false;

          // Clean up event listener if still exists
          if (this._shiftKeyReleaseHandler) {
            document.removeEventListener('keyup', this._shiftKeyReleaseHandler, { capture: true });
            this._shiftKeyReleaseHandler = null;
          }

          this._shiftKeyTimeout = null;
          logger.debug('Shift key state reset via fallback timeout');
        }
      }, 1500);
    }
  }

  /**
   * Handle key up events for Ctrl and Shift tracking
   */
  handleKeyUp(event) {
    this.lastKeyEventTime = Date.now();
    if (!event.ctrlKey && !event.metaKey) {
      this.ctrlKeyPressed = false;
      // logger.debug('Ctrl key released');
    }
    if (!event.shiftKey && this.isInShiftClickOperation) {
      this.shiftKeyPressed = false;
      this.isInShiftClickOperation = false;
      window.translateItShiftClickOperation = false;

      // Clean up event listener if it exists (prevent duplicate cleanup)
      if (this._shiftKeyReleaseHandler) {
        document.removeEventListener('keyup', this._shiftKeyReleaseHandler, { capture: true });
        this._shiftKeyReleaseHandler = null;
      }

      // Clean up fallback timeout
      if (this._shiftKeyTimeout) {
        clearTimeout(this._shiftKeyTimeout);
        this._shiftKeyTimeout = null;
      }

      logger.debug('Shift key released via keyup handler');
    }
  }

  /**
   * Handle mouse down - start drag detection with triple-click support
   */
  handleMouseDown(event) {
    const eligibleSelectionInteraction = event.isTrusted === true && event.button === 0 && !event.shiftKey &&
      this._classifyComposedPath(event) !== true;
    if (eligibleSelectionInteraction) {
      const timestamp = Date.now();
      const windowsManager = this.getWindowsManager();
      windowsManager?.invalidatePendingShows(timestamp);

      let crossOriginTop = false;
      try {
        if (window !== window.top) {
          try {
            const topWindowsManager = window.top.windowsManagerInstance;
            if (topWindowsManager && topWindowsManager !== windowsManager) {
              topWindowsManager.invalidatePendingShows(timestamp);
            }
          } catch {
            crossOriginTop = true;
          }
        }
      } catch {
        crossOriginTop = true;
      }

      if (crossOriginTop) {
        void sendMessage({
          action: MessageActions.INVALIDATE_PENDING_DISPLAY,
          data: { timestamp },
        }, { silent: true }).catch(() => {});
      }
    }

    if (this._continuationExpiryTimer) clearTimeout(this._continuationExpiryTimer);
    this._continuationExpiryTimer = null;
    window.__translateItPendingSelectionContinuationToken = null;
    this._selectionContinuationToken = null;
    this._selectionContinuationText = null;
    this._lastNativeClickContext = null;
    this.lastMouseEventTime = Date.now();
    this._lastMouseUpInteractionId = null;
    this._lastSelectionInteractionId = null;
    this.isDragging = true;
    this.mouseDownTime = Date.now();
    const currentSelection = window.getSelection()?.toString().trim() || '';
    this._primaryMouseDown = event.button === 0 ? {
      interactionId: ++this._primaryMouseInteractionSequence,
      selectionInteractionId: eligibleSelectionInteraction ? this._primaryMouseInteractionSequence : null,
      selectionChangeVersion: this._selectionChangeVersion,
      selectedText: currentSelection
    } : null;
    this._toolbarReleaseCandidate = null;

    // Update modifier states from mouse event (Sync both TRUE and FALSE states)
    this.ctrlKeyPressed = event.ctrlKey || event.metaKey;
    this.shiftKeyPressed = event.shiftKey;

    if (this.ctrlKeyPressed) {
      this.lastKeyEventTime = Date.now();
    }

    // Track consecutive clicks to preserve the final expanded selection.
    let detectedTripleClick = false;
    const currentTime = Date.now();
    const timeSinceLastClick = currentTime - this.lastTripleClickTime;

    if (timeSinceLastClick < 300 && timeSinceLastClick > 0) {
      detectedTripleClick = true;
      this.isWaitingForDragEnd = true;
      logger.debug('Multi-click selection detected - waiting for drag end');
    }
    this.lastTripleClickTime = currentTime;
    if (!detectedTripleClick) this.isWaitingForDragEnd = false;
  }

  /**
   * Handle mouse move - simple drag detection
   */
  handleMouseMove() {
    // Not needed for simplified triple-click + drag
    // We only care about mouse up to end the drag
  }

  handleClick(event) {
    this._lastNativeClickContext = null;
    if (event?.button !== 0 || !Number.isInteger(event.detail) || event.detail <= 1 ||
        this._lastMouseUpInteractionId === null ||
        !this._isRelatedSelectionTarget(this.lastMouseUpEvent?.target, event.target)) return;

    const selection = window.getSelection();
    if (!selection?.toString().trim() || !selection.rangeCount || typeof selection.getRangeAt !== 'function') return;
    let range;
    try {
      range = selection.getRangeAt(0).cloneRange();
    } catch {
      return;
    }
    this._lastNativeClickContext = {
      detail: event.detail,
      target: event.target,
      range,
      text: selection.toString().trim(),
      timestamp: Date.now(),
      interactionId: this._lastMouseUpInteractionId,
      selectionChangeVersion: this._selectionChangeVersion,
    };
  }

  _getDisplayInteraction(selectionType, selection = null) {
    const click = this._lastNativeClickContext;
    if (selectionType === 'keyboard-selection') {
      this._lastNativeClickContext = null;
      return selectionType;
    }
    if (click?.detail > 1) {
      const currentRange = selection?.rangeCount && typeof selection.getRangeAt === 'function'
        ? selection.getRangeAt(0)
        : null;
      const versionDelta = this._selectionChangeVersion - click.selectionChangeVersion;
      const clickMatchesSelection = currentRange && click.text === selection.toString().trim() &&
        this._isSameRange(currentRange, click.range);
      const clickMatchesInteraction = click.interactionId === this._lastMouseUpInteractionId &&
        this._isRelatedSelectionTarget(this.lastMouseUpEvent?.target, click.target);
      const selectionChangeOrderMatches = versionDelta === 0 || versionDelta === 1;
      const isFresh = Date.now() - click.timestamp < 500;
      this._lastNativeClickContext = null;
      if (clickMatchesSelection && clickMatchesInteraction && selectionChangeOrderMatches && isFresh) {
        return 'multi-click';
      }
      return null;
    }
    this._lastNativeClickContext = null;
    if (['regular-drag', 'shift-click', 'post-drag-selection'].includes(selectionType) &&
        this._isRecentMouseSelection(selection)) {
      return selectionType;
    }
    return null;
  }

  _isRecentMouseSelection(selection) {
    const target = this.lastMouseUpEvent?.target;
    const anchor = selection?.anchorNode;
    const anchorElement = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    return !!(target && anchorElement && Date.now() - this.lastMouseEventTime < 500 &&
      this._isRelatedSelectionTarget(target, anchorElement));
  }

  /**
   * Handle mouse up - end drag detection and process selection if needed
   */
  handleMouseUp(event) {
    this.lastMouseEventTime = Date.now();
    this.lastMouseUpEvent = event; // Store for translation window detection
    const mouseDown = this._primaryMouseDown;
    this._primaryMouseDown = null;
    this._lastMouseUpInteractionId = event.button === 0 ? mouseDown?.interactionId ?? null : null;
    this._lastSelectionInteractionId = event.button === 0
      ? mouseDown?.selectionInteractionId ?? null
      : null;
    const currentSelection = window.getSelection()?.toString().trim() || '';
    this._toolbarReleaseCandidate = event.button === 0 && mouseDown &&
      Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      ? {
          interactionId: mouseDown.interactionId,
          selectionInteractionId: mouseDown.selectionInteractionId,
          x: event.clientX,
          y: event.clientY,
          timestamp: Date.now(),
          selectionChangeVersion: mouseDown.selectionChangeVersion,
          selectedTextAtRelease: currentSelection,
          selectedTextAtPress: mouseDown.selectedText
        }
      : null;
    this._lastMouseUpDiagnostics = {
      timestamp: this.lastMouseEventTime,
      composedPathHasUi: this._classifyComposedPath(event)
    };

    // Update modifier states from mouse event (Sync both TRUE and FALSE states)
    this.ctrlKeyPressed = event.ctrlKey || event.metaKey;
    this.shiftKeyPressed = event.shiftKey;

    if (this.ctrlKeyPressed) {
      this.lastKeyEventTime = Date.now();
    }

    // For Shift+Click operations, we need special handling to preserve selection
    const wasShiftClick = this.shiftKeyPressed;

    // End drag detection
    this.isDragging = false;

    // Clean up any previous mouse up timeout
    if (this._mouseUpTimeout) {
      clearTimeout(this._mouseUpTimeout);
      this._mouseUpTimeout = null;
    }

    // Clean up any previous animation frame
    if (this._mouseUpAnimationFrame) {
      cancelAnimationFrame(this._mouseUpAnimationFrame);
      this._mouseUpAnimationFrame = null;
    }

    // Use requestAnimationFrame for better performance and visual consistency
    // Then use setTimeout as a fallback to ensure selection processing
    const delay = wasShiftClick ? 150 : 50; // Longer delay for Shift+Click to allow browser to complete selection

    this._mouseUpAnimationFrame = requestAnimationFrame(() => {
      this._mouseUpTimeout = setTimeout(async () => {
        try {
          const selection = window.getSelection();
          if (selection && selection.toString().trim()) {
            // Enhanced preservation for post-mouseup scenarios
            const selectionType = this._detectSelectionType();
            if (selectionType === 'triple-click-drag' || wasShiftClick) {
              // Start preservation immediately for critical scenarios
              this._startSelectionPreservation(selectionType);
            }

            logger.debug('Processing selection after drag end', {
              wasShiftClick,
              selectionType,
              hasPreservation: this._isPreservationActive()
            });
            await this.processSelection();
          }
        } catch (error) {
          logger.error('Error processing selection after mouseup:', error);
        } finally {
          // The triple-click hold only protects the active pointer drag. Once
          // mouseup processing completes or fails, later selections proceed.
          this.isWaitingForDragEnd = false;
          this._mouseUpTimeout = null;
          this._mouseUpAnimationFrame = null;
        }
      }, delay);
    });
  }

  getSelectionContinuationTokenForClick(event) {
    if (event?.button !== 0 || ![1, 2, 3].includes(event?.detail)) {
      this._clearSelectionContinuation();
      window.__translateItPendingSelectionContinuationToken = null;
      return null;
    }
    if (event.detail !== 3) {
      window.__translateItPendingSelectionContinuationToken = null;
      const current = window.getSelection();
      const currentRange = current?.rangeCount && typeof current.getRangeAt === 'function'
        ? current.getRangeAt(0)
        : null;
      const selectionUnchanged = currentRange && this._lastSelectionRange &&
        this._isSameRange(currentRange, this._lastSelectionRange) &&
        this._isRelatedSelectionTarget(this._lastSelectionTarget, event.target);
      if (this._activeSelectionToken && !selectionUnchanged) {
        if (this._continuationExpiryTimer) clearTimeout(this._continuationExpiryTimer);
        this._continuationExpiryTimer = setTimeout(() => this._clearSelectionContinuation(), 500);
      }
      return null;
    }
    if (this._continuationExpiryTimer) clearTimeout(this._continuationExpiryTimer);
    this._continuationExpiryTimer = null;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const frameId = window.iframeClickManager?.crossFrameManager?.frameId ||
      window.windowsManagerInstance?.crossFrameManager?.frameId;
    const isExpansion = !!(
      selection?.toString().trim() && range && this._lastSelectionRange &&
      !this._continuationClickIssued && this._activeSelectionToken && frameId === this._activeSelectionToken.originFrameId &&
      this._isRelatedSelectionTarget(this._lastSelectionTarget, event.target) &&
      this._isExpandedRange(range, this._lastSelectionRange)
    );
    if (!isExpansion) {
      if (!range || !this._lastSelectionRange ||
          !this._isSameRange(range, this._lastSelectionRange) ||
          !this._isRelatedSelectionTarget(this._lastSelectionTarget, event.target)) {
        this._clearSelectionContinuation();
      }
      return null;
    }

    this._selectionContinuationToken = this._activeSelectionToken;
    this._selectionContinuationText = selection.toString().trim();
    this._continuationClickIssued = true;
    window.__translateItPendingSelectionContinuationToken = this._activeSelectionToken;
    if (this._continuationExpiryTimer) clearTimeout(this._continuationExpiryTimer);
    const token = this._activeSelectionToken;
    this._continuationExpiryTimer = setTimeout(() => {
      if (window.__translateItPendingSelectionContinuationToken === token) {
        window.__translateItPendingSelectionContinuationToken = null;
      }
      this._continuationExpiryTimer = null;
    }, 500);
    return token;
  }

  _isSameRange(first, second) {
    try {
      return first.compareBoundaryPoints(Range.START_TO_START, second) === 0 &&
        first.compareBoundaryPoints(Range.END_TO_END, second) === 0;
    } catch {
      return false;
    }
  }

  _newSelectionToken() {
    const originFrameId = window.iframeClickManager?.crossFrameManager?.frameId ||
      window.windowsManagerInstance?.crossFrameManager?.frameId;
    return originFrameId ? { originFrameId, sequence: ++this._continuationSequence } : null;
  }

  _isExpandedRange(nextRange, previousRange) {
    try {
      const startsEarlierOrEqual = nextRange.compareBoundaryPoints(Range.START_TO_START, previousRange) <= 0;
      const endsLaterOrEqual = nextRange.compareBoundaryPoints(Range.END_TO_END, previousRange) >= 0;
      const changed = nextRange.compareBoundaryPoints(Range.START_TO_START, previousRange) !== 0 ||
        nextRange.compareBoundaryPoints(Range.END_TO_END, previousRange) !== 0;
      return startsEarlierOrEqual && endsLaterOrEqual && changed;
    } catch {
      return false;
    }
  }

  _isRelatedSelectionTarget(previousTarget, nextTarget) {
    if (!previousTarget || !nextTarget) return false;
    if (previousTarget === nextTarget) return true;
    try {
      return previousTarget.contains(nextTarget) || nextTarget.contains(previousTarget);
    } catch {
      return false;
    }
  }

  _consumeToolbarReleasePosition(selectedText, continuationToken = null, currentRange = null) {
    const candidate = this._toolbarReleaseCandidate;
    if (!candidate) return null;

    const verifiedContinuation = continuationToken &&
      continuationToken === this._activeSelectionToken &&
      continuationToken === this._selectionContinuationToken &&
      selectedText === this._selectionContinuationText;
    const independentSameTextSelection = selectedText === candidate.selectedTextAtPress &&
      Number.isInteger(candidate.selectionInteractionId) &&
      candidate.selectionInteractionId === this._lastSelectionInteractionId &&
      currentRange && this._lastSelectionRange &&
      !this._isSameRange(currentRange, this._lastSelectionRange);
    const validCandidate = Date.now() - candidate.timestamp <= TOOLBAR_RELEASE_FRESHNESS_MS &&
      Number.isInteger(candidate.interactionId) &&
      candidate.interactionId === this._lastMouseUpInteractionId &&
      Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && !!selectedText &&
      (verifiedContinuation || (
        candidate.selectionChangeVersion !== this._selectionChangeVersion &&
        (selectedText !== candidate.selectedTextAtPress || independentSameTextSelection) &&
        (!candidate.selectedTextAtRelease || candidate.selectedTextAtRelease === selectedText)
      ));
    this._toolbarReleaseCandidate = null;
    if (!validCandidate) return null;

    const isTopFrame = window === window.top;
    const scrollX = isTopFrame ? window.scrollX : 0;
    const scrollY = isTopFrame ? window.scrollY : 0;
    return {
      x: candidate.x + scrollX,
      y: candidate.y + 10 + scrollY,
      _isViewportRelative: !isTopFrame
    };
  }

  /**
   * Handle input events - simple text field typing detection for preservation
   */
  handleInput(event) {
    if (!this.isActive) return;

    const target = event.target;

    // Check if target is a text field AND we have recent selection activity
    if (this.isTextField(target) && this._isPreservationActive()) {
      logger.debug('Text input detected in text field during preservation', {
        target: target.tagName,
        preservationReason: this._preservationState.reason,
        timeSinceSelectionStart: Date.now() - this._preservationState.timestamp
      });

      // Start simple typing detection period to allow text replacement
      this._startTypingDetection(target);
    }
  }

  /**
   * Start simple typing detection period to allow text replacement
   */
  _startTypingDetection(textField) {
    // Clean up any existing typing detection
    this._stopTypingDetection();

    this.typingDetection = {
      isActive: true,
      startTime: Date.now(),
      timeout: setTimeout(() => {
        this._stopTypingDetection();
      }, 800) // 800ms typing detection period
    };

    // Set global flags for cross-component communication
    window.translateItTextFieldTypingActive = true;
    window.translateItTextFieldTypingElement = textField;
    window.translateItTextFieldTypingTimestamp = Date.now();

    logger.debug('Text field typing detection started (SimpleTextSelectionHandler)', {
      textField: textField.tagName,
      duration: 800
    });
  }

  /**
   * Stop typing detection and clean up
   */
  _stopTypingDetection() {
    if (this.typingDetection.timeout) {
      clearTimeout(this.typingDetection.timeout);
      this.typingDetection.timeout = null;
    }

    this.typingDetection.isActive = false;
    this.typingDetection.startTime = 0;

    // Clear global flags
    window.translateItTextFieldTypingActive = false;
    window.translateItTextFieldTypingElement = null;
    window.translateItTextFieldTypingTimestamp = null;

    logger.debug('Text field typing detection stopped (SimpleTextSelectionHandler)');
  }

  /**
   * Clean up typing detection (alias for _stopTypingDetection)
   */
  cleanupTypingDetection() {
    this._stopTypingDetection();
  }

  /**
   * Check if the last click was inside a translation window
   */
  isClickInsideTranslationWindow() {
    const lastMouseUp = this.lastMouseUpEvent;
    if (!lastMouseUp) {
      logger.debug('Inside-window check: no mouseup event recorded');
      return false;
    }

    // Diagnostic only: target element type (no page content), mouseup age, and
    // the composed-path classification captured during mouseup dispatch.
    const diagnostics = this._lastMouseUpDiagnostics;
    const mouseUpAgeMs = diagnostics?.timestamp ? Date.now() - diagnostics.timestamp : null;
    const targetTag = lastMouseUp.target?.tagName ?? null;
    const composedPathHasUi = diagnostics ? diagnostics.composedPathHasUi : null;

    // Use ElementDetectionService to check if click is on UI element
    try {
      const uiElement = this.elementDetection.getClickedUIElement(lastMouseUp);
      logger.debug('Inside-window check', {
        hasLastMouseUp: true,
        mouseUpAgeMs,
        targetTag,
        uiElementType: uiElement?.type ?? null,
        composedPathHasUi,
      });
      if (uiElement) {
        return true;
      }

      // Fallback: ElementDetectionService should catch all translation elements
      // This is now redundant since we already use elementDetection.getClickedUIElement() above
      // Keeping this log for debugging but the detection is already handled

    } catch (error) {
      logger.debug('Error checking click inside translation window:', error);
    }

    return false;
  }

  /**
   * Capture-phase pointerdown handler: records whether the current pointer
   * interaction began inside extension UI. Read-only classification (no
   * detection cache); stores primitives only.
   */
  handleUiPointerDownCapture(event) {
    this._lastUiPointerInteraction = {
      insideUi: this._classifyComposedPath(event) === true,
      timestamp: Date.now()
    };
  }

  /**
   * Returns the bounded interaction context ({ insideUi, ageMs }) when a
   * pointerdown was recorded within UI_INTERACTION_CONTEXT_MS, else null.
   */
  _hasRecentUiInteraction() {
    const interaction = this._lastUiPointerInteraction;
    if (!interaction) return null;
    const ageMs = Date.now() - interaction.timestamp;
    if (ageMs >= UI_INTERACTION_CONTEXT_MS) return null;
    return { insideUi: interaction.insideUi, ageMs };
  }

  /**
   * Classify the event's composed path synchronously during dispatch.
   * Diagnostic only and side-effect-free: uses direct Element.matches()
   * against the shared UI_ELEMENTS selector instead of
   * ElementDetectionService, so the detection cache is never populated.
   * Returns whether any path node is extension UI, or null when the path
   * cannot be classified. Stores no DOM nodes.
   */
  _classifyComposedPath(event) {
    try {
      if (typeof event?.composedPath !== 'function') return null;
      const path = event.composedPath();
      if (!Array.isArray(path)) return null;
      return path.some((node) => {
        try {
          return node instanceof Element
            && typeof node.matches === 'function'
            && node.matches(COMBINED_SELECTORS.UI_ELEMENTS);
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }
  }

  /**
   * Get WindowsManager instance from FeatureManager
   */
  getWindowsManager() {
    if (!this.featureManager) return null;

    const windowsHandler = this.featureManager.getFeatureHandler('windowsManager');
    if (!windowsHandler || !windowsHandler.getIsActive()) return null;

    return windowsHandler.getWindowsManager();
  }

  // Public API methods
  getSelectionManager() {
    return this.selectionManager;
  }

  hasActiveSelection() {
    const selection = window.getSelection();
    return selection && selection.toString().trim().length > 0;
  }

  getCurrentSelection() {
    if (!this.isActive) return null;
    const selection = window.getSelection();
    return selection?.toString().trim() || null;
  }

  getStatus() {
    return {
      handlerActive: this.isActive,
      hasSelection: this.hasActiveSelection(),
      managerAvailable: !!this.selectionManager,
      ctrlPressed: this.ctrlKeyPressed,
      isDragging: this.isDragging,
      mouseDownTime: this.mouseDownTime,
      currentSelection: this.getCurrentSelection()?.substring(0, 100),
      preservation: {
        active: this._isPreservationActive(),
        reason: this._preservationState.reason,
        remainingTime: this._preservationState.active ?
          Math.max(0, this._preservationState.duration - (Date.now() - this._preservationState.timestamp)) : 0
      },
      typingDetection: {
        isActive: this.typingDetection.isActive,
        startTime: this.typingDetection.startTime,
        timeSinceStart: this.typingDetection.isActive ? Date.now() - this.typingDetection.startTime : null
      }
    };
  }

  /**
   * Check if typing detection is currently active
   */
  isTypingDetectionActive() {
    return this.typingDetection.isActive;
  }

  /**
   * Check if a specific element is the current typing target
   */
  isTypingTarget(element) {
    return this.typingDetection.isActive && window.translateItTextFieldTypingElement === element;
  }

  destroy() {
    this._clearSelectionContinuation();
    // Clean up preservation system
    this._clearPreservationTimer();

    // Clean up typing detection
    this.cleanupTypingDetection();

    // Clean up global reference
    if (window.simpleTextSelectionHandlerInstance === this) {
      window.simpleTextSelectionHandlerInstance = null;
    }

    this.cleanup();
    // Reset singleton instance
    if (simpleTextSelectionHandlerInstance === this) {
      simpleTextSelectionHandlerInstance = null;
    }
  }
}

export default SimpleTextSelectionHandler;

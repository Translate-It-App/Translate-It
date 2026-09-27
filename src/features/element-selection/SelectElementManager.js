// SelectElementManager - Specialized Manager for Select Element
// Single responsibility: Manage Select Element mode lifecycle and interactions

import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { pageEventBus, WINDOWS_MANAGER_EVENTS } from '@/core/PageEventBus.js';
import { sendMessage, sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { isFatalError, isCancellationError } from '@/shared/error-management/ErrorMatcher.js';
import { mapCanonicalTranslationError } from '@/shared/error-management/PublicTranslationErrorPolicy.js';
import { createLegacyDisplayError } from '@/shared/error-management/PublicTranslationErrorAdapter.js';
import { getEffectiveProviderAsync, TranslationMode } from '@/shared/config/config.js';
import { NOTIFICATION_TIME } from '@/shared/constants/ui.js';
import { TRANSLATION_STATUS } from '@/shared/constants/translation.js';
import { getTranslationString } from '@/utils/i18n/i18n.js';
import { shouldShowProviderWarning } from '@/shared/utils/warning-manager.js';
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js';
import { deviceDetector } from '@/utils/browser/compatibility.js';

// Hover manager for original text preview
import { hoverPreviewManager } from '@/features/shared/hover-preview/HoverPreviewManager.js';
import { getSelectElementShowOriginalOnHoverAsync } from '@/shared/config/config.js';

// Import CSS as inline string
import selectionStyles from './SelectElement.scss?inline';

// Import new simplified services
import { DomTranslatorAdapter } from './core/DomTranslatorAdapter.js';
import { ElementSelector } from './core/ElementSelector.js';
import { extractTextFromElement, isSelectableTextRoot } from './utils/elementHelpers.js';
import { SelectElementReason } from './core/SelectElementPolicy.js';
import {
  resolveSelectInteractionElement,
  SELECT_ELEMENT_SHADOW_DOM_ENABLED,
} from './utils/shadowDom.js';

// Import notification manager
import { getSelectElementNotificationManager } from './SelectElementNotificationManager.js';

const SELECT_ELEMENT_PARTIAL_ERROR_KEY = 'ERRORS_SELECT_ELEMENT_PARTIAL_TRANSLATION_FAILED';
const SELECT_ELEMENT_PARTIAL_ERROR_FALLBACK = 'Some content could not be translated.';

const SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT_KEY = 'SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT';
const SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT_FALLBACK = 'No translatable text was found in this element.';

const SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE_KEY = 'SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE';
const SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE_FALLBACK = 'This content cannot be translated with the current translation mode.';
const SELECT_ELEMENT_DEACTIVATION_ERROR = 'Could not deactivate Select Element mode.';
const GENERIC_TRANSLATION_ERROR_TYPES = new Set([
  ErrorTypes.TRANSLATION_ERROR,
  ErrorTypes.TRANSLATION_FAILED,
  ErrorTypes.UNKNOWN,
]);

/**
 * Resolves the localized partial-completion message shared by non-terminal
 * PARTIAL_SUCCESS and terminal PARTIAL_FAILURE paths.
 * @private
 * @returns {Promise<string>}
 */
async function getPartialCompletionMessage() {
  return (await getTranslationString(SELECT_ELEMENT_PARTIAL_ERROR_KEY))
    || SELECT_ELEMENT_PARTIAL_ERROR_FALLBACK;
}

function hasUsefulCommittedOutput(outcome) {
  return Number.isInteger(outcome?.committedParentCount)
    && outcome.committedParentCount > 0;
}

function isSilentInternalOperationAbort(error) {
  const type = error?.type;
  return error?.operationAborted === true
    && (!type || GENERIC_TRANSLATION_ERROR_TYPES.has(type));
}

/**
 * SelectElementManager - Coordinates the interactive Select Element mode.
 * Uses a specialized DomTranslatorAdapter optimized for AI/DeepL context and token efficiency.
 */
class SelectElementManager extends ResourceTracker {
  constructor({ featureManager } = {}) {
    super('select-element-manager');
    this.featureManager = featureManager || null;

    // Core state
    this.isActive = false;
    this.isProcessingClick = false;
    this.isCancellationInProgress = false;
    this.isInitialized = false;
    this.selectElementLifecycleQueue = Promise.resolve();
    this.instanceId = Math.random().toString(36).substring(7);
    this.isTopFrame = window === window.top;
    this.mouseSelectionFrame = null;
    this.lastMouseX = undefined;
    this.lastMouseY = undefined;

    // Logger
    this.logger = getScopedLogger(LOG_COMPONENTS.ELEMENT_SELECTION, 'SelectElementManager');

    // New simplified services
    this.domTranslatorAdapter = new DomTranslatorAdapter();
    this.elementSelector = new ElementSelector();

    // Store instance globally for cross-component detection
    window.selectElementManagerInstance = this;

    // Track services
    this.trackResource('dom-translator-adapter', () => {
      if (this.domTranslatorAdapter) {
        this.domTranslatorAdapter.cleanup?.();
        this.domTranslatorAdapter = null;
      }
    }, { isCritical: true });

    this.trackResource('element-selector', () => {
      if (this.elementSelector) {
        this.elementSelector.cleanup?.();
        this.elementSelector = null;
      }
    }, { isCritical: true });

    this.notificationManager = null;
    this.baseNotificationManager = null;
    this.contextWatchdogInterval = null;

    // Event handlers (bound)
    this.handleMouseOver = this.handleMouseOver.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseOut = this.handleMouseOut.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleInteraction = this.handleInteraction.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);

    window.selectElementHandlingESC = false;
  }

  /**
   * Initialize the manager and all services
   */
  async initialize() {
    if (this.isInitialized) return;
    try {
      const [NotificationManagerModule] = await Promise.all([
        import('@/core/managers/core/NotificationManager.js'),
        this.domTranslatorAdapter.initialize(),
        this.elementSelector.initialize()
      ]);

      const baseNotificationManager = new NotificationManagerModule.default();
      this.baseNotificationManager = baseNotificationManager;
      this.notificationManager = await getSelectElementNotificationManager(baseNotificationManager);

      this.setupKeyboardListeners();
      this.setupCancelListener();
      // Initialize hover manager for original text preview if enabled
      getSelectElementShowOriginalOnHoverAsync().then(enabled => {
        if (enabled) {
          hoverPreviewManager.initialize();
          this.logger.debug('Hover manager initialized via SelectElementManager');
        }
      });

      this.addEventListener(pageEventBus, MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, (data) => {
        this.activateSelectElementMode(data || {}).catch(() => {});
      });

      // Listen for translation progress events
      this.addEventListener(pageEventBus, 'select-element-translation-progress', (data) => {
        if (data?.completed !== undefined && data?.total !== undefined) {
          const progressType = data.isRequestProgress ? 'API requests' : 'items';
          this.logger.debug(`[SelectElementManager] Progress update: ${data.completed}/${data.total} ${progressType}`);
          this.updateNotificationForTranslationProgress(data.completed, data.total, data.isRequestProgress);
        }
      });

      this.isInitialized = true;
    } catch (error) {
      this.logger.warn('Error initializing SelectElementManager:', error);
      throw error;
    }
  }

  async activate() {
    if (this.isInitialized) return true;
    try {
      await this.initialize();
      return true;
    } catch {
      return false;
    }
  }

  // Single frame-local owner for manager and ContentMessageHandler lifecycle work.
  enqueueSelectElementLifecycle(operation) {
    const run = () => operation({
      activate: options => this._activateSelectElementMode(options),
      deactivate: options => this._deactivateSelectElementMode(options),
    });
    const queuedOperation = this.selectElementLifecycleQueue.then(run, run);
    this.selectElementLifecycleQueue = queuedOperation.catch(() => {});
    return queuedOperation;
  }

  /**
   * Activate Select Element mode
   */
  async activateSelectElementMode(options = {}) {
    return this.enqueueSelectElementLifecycle(({ activate }) => activate(options));
  }

  async _activateSelectElementMode(options = {}) {
    if (this.isActive) return { isActive: this.isActive, instanceId: this.instanceId };

    await this._ensureStylesInjected();
    
    // Add activation attribute for global CSS styles (navigation prevention/cursor)
    document.documentElement.setAttribute('data-translate-it-select-mode', 'true');
    this._startContextWatchdog();

    const activationOptions = { targetLanguage: options.targetLanguage || null, ...options };

    try {
      await this.featureManager?.resolveFeatureConflict?.('selectElement');

      this.isActive = true;
      this.isProcessingClick = false;
      this.isCancellationInProgress = false;
      this.hasInitialMovementOccurred = false; 
      this._cancelPendingMouseFrame();
      this.lastMouseX = undefined;
      this.lastMouseY = undefined;
      this.currentOptions = activationOptions; 

      if (this.elementSelector) this.elementSelector.clearHighlight();
      this.setupEventListeners();

      // Ensure hover manager is initialized if enabled
      getSelectElementShowOriginalOnHoverAsync().then(enabled => {
        if (enabled) hoverPreviewManager.initialize();
      });

      const servicesAvailable = await this._ensureServicesAvailable();
      if (!servicesAvailable) throw new Error('Services initialization failed');

      // CRITICAL: Re-check if still active after async operations
      if (!this.isActive) return { isActive: false };

      this.elementSelector.activate();

      if (this.isTopFrame) {
        this.showNotification();
        const [bingWarning, lingvaWarning, effectiveProvider] = await Promise.all([
          getTranslationString('BING_WPT_WARNING'),
          getTranslationString('LINGVA_WPT_WARNING'),
          options.provider || getEffectiveProviderAsync(TranslationMode.Select_Element)
        ]);

        // RE-CHECK again after another set of async calls
        if (!this.isActive) {
          this.dismissNotification();
          return { isActive: false };
        }

        const activeProvider = effectiveProvider;
        if (activeProvider === ProviderRegistryIds.BING) {
          if (await shouldShowProviderWarning('Bing')) {
            this.baseNotificationManager.show(
              bingWarning || 'Bing may have issues. Try another provider.',
              'warning',
              NOTIFICATION_TIME.WARNING_PROVIDER,
              { id: 'bing-warning' }
            );
          }
        } else if (activeProvider === ProviderRegistryIds.LINGVA) {
          if (await shouldShowProviderWarning('Lingva')) {
            this.baseNotificationManager.show(
              lingvaWarning || 'Lingva may have issues. Try another provider.',
              'warning',
              NOTIFICATION_TIME.WARNING_PROVIDER,
              { id: 'lingva-warning' }
            );
          }
        }
      }

      await this.notifyBackgroundActivation();
      this.activationTime = Date.now();
      pageEventBus.emit('select-mode-activated');

      return { isActive: this.isActive, instanceId: this.instanceId };
    } catch (error) {
      this.logger.warn('Error activating SelectElementManager:', error);
      this.isActive = false;
      this.emergencyCleanup();
      throw error;
    }
  }

  /**
   * Deactivate Select Element mode
   * @param {Object} [options]
   * @param {string} [options.reason='manual'] - Cleanup/UX semantics only
   *   ('success' | 'error' | 'cancel' | 'manual' | 'conflict'). Never grants
   *   propagation authority.
   * @param {boolean} [options.fromBackground=false] - Trusted broadcast
   *   receiver marker; suppresses every outbound state/global request.
   * @param {boolean} [options.requestGlobalDeactivation=false] - Explicit
   *   producer-declared tab-wide exit intent (user Escape / explicit Cancel).
   *   Routes the trusted DEACTIVATE_SELECT_ELEMENT_MODE request through the
   *   background, which authenticates the sender tab and broadcasts to all
   *   frames. Frame position never implies this intent.
   * @returns {Promise<{success: boolean, cleanupCompleted: boolean, alreadyInactive?: boolean, error?: string, globalDeactivationRequested?: boolean, globalDeactivationSucceeded?: boolean}>}
  */
  async deactivate(options = {}) {
    const result = await this.enqueueSelectElementLifecycle(({ deactivate }) => deactivate(options));

    // Background broadcasts re-enter this manager's queue. Propagate only once
    // local cleanup has released it, otherwise ESC/cancel can wait on itself.
    if (
      result?.success === true
      && options.requestGlobalDeactivation === true
      && options.fromBackground !== true
    ) {
      try {
        const response = await sendMessage({ action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE });
        return {
          ...result,
          globalDeactivationRequested: true,
          globalDeactivationSucceeded: response?.success === true,
        };
      } catch {
        return {
          ...result,
          globalDeactivationRequested: true,
          globalDeactivationSucceeded: false,
        };
      }
    }

    return result;
  }

  async _deactivateSelectElementMode(options = {}) {
    if (!this.isActive) {
      return { success: true, cleanupCompleted: true, alreadyInactive: true };
    }

    try {
      const {
        reason = 'manual', // 'success', 'error', 'cancel', 'manual', 'conflict'
        fromBackground = false,
        requestGlobalDeactivation = false,
        silent = false,
        preserveTranslations = options.preserveTranslations !== undefined
          ? options.preserveTranslations
          : true // Default: preserve translations in Select Element mode even on error
      } = options;

      this.logger.debug(`Deactivating SelectElementManager (Reason: ${reason})`, { ...options, preserveTranslations });

      this.isActive = false;
      this.activationTime = 0;
      
      // STOP watchdog and REMOVE interaction-blocking attribute immediately (Safety first)
      this._stopContextWatchdog();
      document.documentElement.removeAttribute('data-translate-it-select-mode');

      // User/manual cancellation and conflict teardown both invalidate active
      // adapter work, while retaining distinct cleanup reasons and UX.
      if (reason === 'cancel' || reason === 'manual') {
        await this.domTranslatorAdapter.cancelTranslation({ silent });
      } else if (reason === 'conflict') {
        await this.domTranslatorAdapter.cancelTranslation({ silent: true });
      }

      this.removeEventListeners();
      this.elementSelector.deactivate();

      // Always dismiss selection notifications during deactivation
      if (this.isTopFrame) {
        this.dismissNotification();
      }

      if (!preserveTranslations && this.domTranslatorAdapter.hasTranslation()) {
        await this.domTranslatorAdapter.revertTranslation();
      }

      if (!fromBackground) {
        if (!requestGlobalDeactivation) {
          await this.notifyBackgroundDeactivation();
        }
      }
      pageEventBus.emit('select-mode-deactivated');
      return { success: true, cleanupCompleted: true };

    } catch (error) {
      this.logger.error('Critical error deactivating SelectElementManager:', error);
      
      // Integrate with the centralized error system for unexpected manager failures
      if (!ExtensionContextManager.isContextError(error)) {
        // Log correctly
      } else {
        ExtensionContextManager.handleContextError(error, 'element-selection-deactivate');
      }
      
      this.emergencyCleanup();
      return {
        success: false,
        cleanupCompleted: false,
        error: SELECT_ELEMENT_DEACTIVATION_ERROR,
      };
    } finally {
      // Final guard for the UI lock
      document.documentElement.removeAttribute('data-translate-it-select-mode');
    }
  }

  async forceDeactivate() {
    return this.deactivate({ preserveTranslations: false, silent: true, reason: 'cancel' });
  }

  setupEventListeners() {
    if (this.isActive) {
      window.addEventListener('mouseover', this.handleMouseOver, true);
      window.addEventListener('mousemove', this.handleMouseMove, true);
      window.addEventListener('mouseout', this.handleMouseOut, true);
      window.addEventListener('touchstart', this.handleTouchStart, { capture: true, passive: false });
      window.addEventListener('touchmove', this.handleTouchMove, { capture: true, passive: false });
      window.addEventListener('touchend', this.handleTouchEnd, { capture: true, passive: false });

      // Robust interaction blocking: Include auxclick for middle-click and ensure capture phase
      const interactionEvents = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dragstart', 'auxclick'];
      interactionEvents.forEach(eventType => {
        window.addEventListener(eventType, this.handleInteraction, { capture: true, passive: false });
        // Secondary safety: some sites use document-level capture listeners
        document.addEventListener(eventType, this.handleInteraction, { capture: true, passive: false });
      });

      window.addEventListener('keydown', this.handleKeyDown, true);
      window.addEventListener('keyup', this.handleKeyUp, true);

    }
  }

  removeEventListeners() {
    this._cancelPendingMouseFrame();
    this.lastMouseX = undefined;
    this.lastMouseY = undefined;
    window.removeEventListener('mouseover', this.handleMouseOver, true);
    window.removeEventListener('mousemove', this.handleMouseMove, true);
    window.removeEventListener('mouseout', this.handleMouseOut, true);
    window.removeEventListener('touchstart', this.handleTouchStart, { capture: true, passive: false });
    window.removeEventListener('touchmove', this.handleTouchMove, { capture: true, passive: false });
    window.removeEventListener('touchend', this.handleTouchEnd, { capture: true, passive: false });
    
    const interactionEvents = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dragstart', 'auxclick'];
    interactionEvents.forEach(eventType => {
      window.removeEventListener(eventType, this.handleInteraction, { capture: true, passive: false });
      document.removeEventListener(eventType, this.handleInteraction, { capture: true, passive: false });
    });

    window.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('keyup', this.handleKeyUp, true);
  }

  isCooldownActive() { return Date.now() - (this.activationTime || 0) < 100; }

  handleMouseOver(event) {
    if (!this.isActive || this.isProcessingClick || this.isCooldownActive()) return;
    this._queueMouseSelection(event);
  }

  /** Coalesce desktop pointer movement and resolve only the latest hit target. */
  handleMouseMove(event) {
    if (!this.isActive || this.isProcessingClick || this.isCooldownActive()) return;
    // A mousemove event itself proves the pointer has moved since activation.
    this.hasInitialMovementOccurred = true;
    this._queueMouseSelection(event);
  }

  _queueMouseSelection(event) {
    const currentX = event.clientX;
    const currentY = event.clientY;
    if (this.lastMouseX !== undefined && (this.lastMouseX !== currentX || this.lastMouseY !== currentY)) {
      this.hasInitialMovementOccurred = true;
    }
    this.lastMouseX = currentX;
    this.lastMouseY = currentY;
    if (this.elementSelector) {
      const highlighted = this.elementSelector.getHighlightedElement();
      if (highlighted && event.target && highlighted.contains(event.target)) {
        this.elementSelector.clearPendingHighlight?.();
      }
    }
    if (!this.hasInitialMovementOccurred || this.mouseSelectionFrame !== null) return;

    this.mouseSelectionFrame = window.requestAnimationFrame(() => {
      this.mouseSelectionFrame = null;
      if (!this.isActive || this.isProcessingClick || this.isCooldownActive()) return;

      // Hit-test at frame time so a delayed frame never selects an obsolete event target.
      const target = document.elementFromPoint(this.lastMouseX, this.lastMouseY);
      if (!target) return;
      const resolvedTarget = resolveSelectInteractionElement(
        { target, composedPath: () => [target] },
        element => this.elementSelector?.isOurElement(element),
        { allowShadowDom: SELECT_ELEMENT_SHADOW_DOM_ENABLED }
      );
      if (resolvedTarget) this.elementSelector.handleMouseOver(resolvedTarget);
    });
  }

  _cancelPendingMouseFrame() {
    if (this.mouseSelectionFrame !== null) {
      window.cancelAnimationFrame(this.mouseSelectionFrame);
      this.mouseSelectionFrame = null;
    }
  }

  handleTouchStart(event) {
    if (!this.isActive || this.isProcessingClick || this.isCooldownActive()) return;
    if (this.elementSelector && this.elementSelector.isOurElement(event.touches[0].target)) return;
    event.preventDefault();
  }

  handleTouchMove(event) {
    if (!this.isActive || this.isProcessingClick || this.isCooldownActive()) return;
    if (!this.hasInitialMovementOccurred) this.hasInitialMovementOccurred = true;
    event.preventDefault();
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!target || (this.elementSelector && this.elementSelector.isOurElement(target))) return;
    this.elementSelector.handleMouseOver(target);
  }

  handleTouchEnd(event) {
    if (!this.isActive || this.isProcessingClick) return;
    const highlighted = this.elementSelector.getHighlightedElement();
    if (highlighted) this.handleClick(event).catch(() => {});
  }

  handleMouseOut(event) {
    if (!this.isActive || this.isProcessingClick) return;
    this.elementSelector.handleMouseOut(event.relatedTarget);
  }

  handleInteraction(event) {
    if (!this.isActive || this.isCooldownActive()) return;

    const path = (event.composedPath && event.composedPath()) || [event.target];

    // Check if the interaction is with our UI (Toasts, Popup, etc.)
    // We must NOT block interactions with our own UI.
    const isExtensionUI = path.some(el => {
      if (!el) return false;
      const isOur = this.elementSelector && this.elementSelector.isOurElement(el);
      return isOur;
    });

    if (isExtensionUI) return;

    const isScrollRelatedTouch = event.type.startsWith('touch') || event.type.startsWith('pointer');
    if (this.isProcessingClick && isScrollRelatedTouch) return;

    // Block the event for the page
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const isTriggerEvent = event.type === 'click' || (event.type === 'touchend' && deviceDetector.isMobile());
    if (isTriggerEvent && !this.isProcessingClick) {
      this.handleClick(event).catch(() => {});
    }
  }

  handleKeyDown(event) {
    this.handleEscape(event);
  }

  handleKeyUp(event) {
    this.handleEscape(event);
  }

  handleEscape(event) {
    if (!this.isActive || this.isCancellationInProgress || event.key !== 'Escape' || window.selectElementHandlingESC) return;

    window.selectElementHandlingESC = true;
    setTimeout(() => { window.selectElementHandlingESC = false; }, 100);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.isCancellationInProgress = true;
    this.deactivate({ silent: false, reason: 'cancel', requestGlobalDeactivation: true })
      .finally(() => { this.isCancellationInProgress = false; });
  }

  async handleClick(event) {
    if (this.isProcessingClick) return;
    try {
      this.isProcessingClick = true;
      const interactionElement = resolveSelectInteractionElement(
        event,
        element => this.elementSelector?.isOurElement(element),
        { allowShadowDom: SELECT_ELEMENT_SHADOW_DOM_ENABLED }
      );
      const highlightedElement = this.elementSelector.getHighlightedElement();
      const elementToTranslate = event?.type !== 'touchend' && interactionElement
        ? this.elementSelector.findBestTextElement(interactionElement)
        : highlightedElement;
      if (!elementToTranslate) return;

      // Authoritative click revalidation: re-run root eligibility at click time
      // even if the element was highlighted earlier. The DOM may change between
      // hover and click, so hover eligibility is never trusted blindly.
      if (!isSelectableTextRoot(elementToTranslate)) return;

      const text = extractTextFromElement(elementToTranslate);
      if (text && text.trim()) {
        // 1. Stop highlighting logic
        this.elementSelector.deactivate();
        
        // 2. Restore page interaction immediately (Unlock cursor and links)
        this._unlockPageInteraction();
        
        // 3. Notify background that selection phase is finished
        await this.notifyBackgroundDeactivation();

        // 4. Start the translation process
        await this.startTranslation(elementToTranslate, this.currentOptions);
      }
    } catch (error) {
      this.logger.warn('Error handling element click:', error);
    } finally {
      this.isProcessingClick = false;
    }
  }

  /**
   * Unlock page interaction immediately after selection
   * Restores cursor and pointer events while the watchdog continues to cover
   * the in-flight translation lifecycle.
   * @private
   */
  _unlockPageInteraction() {
    this.logger.debug('Restoring page interaction after selection');
    document.documentElement.removeAttribute('data-translate-it-select-mode');
    this.removeEventListeners();
  }

  async startTranslation(targetElement, options = {}) {
    try {
      if (!this.isActive) return;

      // Mark as translating for Memory Garbage Collector protection
      window.isTranslationInProgress = true;

      const result = await this.domTranslatorAdapter.translateElement(targetElement, {
        ...this.currentOptions,
        ...options,
        onProgress: async () => {
          // Emit both for backward compatibility and Coordinator discovery
          pageEventBus.emit(WINDOWS_MANAGER_EVENTS.ELEMENT_TRANSLATIONS_AVAILABLE);
          pageEventBus.emit('ELEMENT_TRANSLATIONS_AVAILABLE');

          // CRITICAL: Notify top frame about iframe translations so Desktop FAB can show Revert button
          if (!this.isTopFrame) {
            try {
              window.top.postMessage({ 
                type: WINDOWS_MANAGER_EVENTS.ELEMENT_TRANSLATIONS_AVAILABLE,
                source: 'translate-it-iframe' 
              }, '*');
            } catch { /* ignore cross-origin errors */ }
          }
        }
      });

      if (result?.success) {
        pageEventBus.emit('hide-translation', { element: targetElement });
        pageEventBus.emit('ELEMENT_TRANSLATIONS_AVAILABLE'); // Notify that revert is now possible

        if (result.partial === true && !hasUsefulCommittedOutput(result)) {
          // Non-terminal partial completion: stream/provider completed normally but
          // some requested logical parents remain uncommitted. Committed translations
          // are valid and preserved; this is feature outcome UX, not a terminal error.
          this.logger.debug('Select Element translation completed partially', {
            committedParentCount: result.committedParentCount,
            totalParentCount: result.totalParentCount,
          });
          const partialMessage = await getPartialCompletionMessage();
          const partialDisplayError = Object.assign(new Error(partialMessage), {
            type: ErrorTypes.TRANSLATION_FAILED,
          });
          ErrorHandler.getInstance().handle(partialDisplayError, { context: 'select-element', showToast: true }).catch(() => {});
        }

        this.performPostTranslationCleanup({ reason: 'success' });
      } else if (result?.cancelled) {
        this.deactivate({ reason: 'cancel', silent: true });
      } else {
        // Explicit failure contract: any resolved value that is neither success
        // nor cancellation (zero-commit results, undefined, {}) is a failure.
        const failure = (result && result.error) || new Error('Translation failed');
        await this._handleTranslationFailure(failure, result?.translationOutcome || failure.translationOutcome);
      }
    } catch (error) {
      await this._handleTranslationFailure(error, error?.translationOutcome);
    } finally {
      // Clear flag after translation is complete (success or error)
      window.isTranslationInProgress = false;
    }
  }

  /**
   * Routes a Select Element translation failure through the standard error
   * pipeline (ErrorHandler notification + cleanup), preserving silent paths.
   * @private
   */
  async _handleTranslationFailure(error, outcome = error?.translationOutcome) {
    const committedParentCount = Number.isInteger(outcome?.committedParentCount)
      ? outcome.committedParentCount
      : 0;
    const totalParentCount = Number.isInteger(outcome?.totalParentCount)
      ? outcome.totalParentCount
      : 0;
    const isCancellation = Boolean(outcome?.cancelled) || isCancellationError(error);
    const isInternalOperationAbort = !isCancellation && isSilentInternalOperationAbort(error);
    const hasCommittedOutput = hasUsefulCommittedOutput(outcome);
    const isPartialFailure = !isCancellation
      && committedParentCount > 0
      && committedParentCount < totalParentCount;
    const isNoTranslatableContent = error.type === ErrorTypes.NO_TRANSLATABLE_CONTENT;
    const isAlreadyTranslated = error.type === ErrorTypes.NODE_ALREADY_TRANSLATED;
    const isSilentSkip = isCancellation
      || isInternalOperationAbort
      || error.type === ErrorTypes.FEATURE_BLOCKED
      || ExtensionContextManager.isContextError(error);

    if (isCancellation) {
      this.logger.debug('Select Element translation cancelled:', error.message);
    } else if (isNoTranslatableContent) {
      await this._handleNoTranslatableContent(error);
    } else if (isSilentSkip || isAlreadyTranslated || hasCommittedOutput) {
      this.logger.debug('Select Element translation skipped:', error.message);
    } else {
      this.logger.warn('Select Element translation failed:', error);
      let displayError;
      if (isPartialFailure) {
        displayError = Object.assign(new Error(await getPartialCompletionMessage()), {
          type: ErrorTypes.TRANSLATION_FAILED,
          cause: error,
          translationOutcome: outcome,
        });
      } else {
        const publicError = mapCanonicalTranslationError(error);
        displayError = await createLegacyDisplayError(error, publicError);
      }
      if (isPartialFailure) {
        this.logger.warn('Select Element translation partially failed:', {
          committedParentCount,
          totalParentCount,
        });
      }
      if (displayError) {
        ErrorHandler.getInstance().handle(displayError, { context: 'select-element', showToast: true }).catch(() => {});
      }
    }
    
    if (ExtensionContextManager.isContextError(error)) {
      ExtensionContextManager.handleContextError(error, 'element-selection');
    }

    if (isFatalError(error) && !isSilentSkip) {
      // Fatal failure is a terminal outcome: route through the terminal
      // owner so child frames use the trusted IFRAME_SELECT_ELEMENT_FINISHED
      // global deactivation path instead of frame-local cleanup.
      this.performPostTranslationCleanup({ reason: 'error' });
    } else if (isNoTranslatableContent) {
      this.performPostTranslationCleanup({ reason: 'no-content' });
    } else {
      this.performPostTranslationCleanup({ reason: isSilentSkip ? 'cancel' : 'error' });
    }
  }

  /**
   * Handles an accepted Select Element request that produced zero translatable
   * units. Non-error, non-cancellation outcome: shows one informational message
   * and lets cleanup run on a semantic 'no-content' reason. Deliberately keeps
    * the outcome out of ErrorHandler error semantics.
   * @private
   * @param {Error} error - The NO_TRANSLATABLE_CONTENT error.
   */
  async _handleNoTranslatableContent(error) {
    this.logger.debug('Select Element translation completed with no translatable content:', error.message);
    const isUnsupportedMode = error.reason === SelectElementReason.UNSUPPORTED_MODE;
    const message = isUnsupportedMode
      ? ((await getTranslationString(SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE_KEY))
        || SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE_FALLBACK)
      : ((await getTranslationString(SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT_KEY))
        || SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT_FALLBACK);
    this.showNoContentNotification(message);
  }

  /**
   * Routes an informational Select Element message through the notification
    * owner. Feature-owned non-error path; never public translation error handling.
   * @param {string} message - Localized informational message.
   */
  showNoContentNotification(message) {
    pageEventBus.emit('show-select-element-info', { message });
  }

  performPostTranslationCleanup(options = {}) {
    const reason = options.reason || 'success';
    // In Select Element mode, we want to preserve partial translations even on error
    const preserveTranslations = true;

    if (!this.isTopFrame) {
      try {
        void sendRegularMessage({
          action: MessageActions.IFRAME_SELECT_ELEMENT_FINISHED,
          data: { reason },
        }, { silent: true }).catch((error) => {
          this.logger.debug('Failed to report iframe Select Element completion:', error);
        });
      } catch { /* ignore */ }

      // Also locally deactivate to ensure clean state
      this.deactivate({ preserveTranslations, reason, fromBackground: true }).catch(() => {});
    } else if (this.isActive) {
      // Terminal outcome owns tab-wide deactivation in the top frame. The
      // explicit flag preserves that ownership without making frame position
      // authoritative inside deactivate().
      this.deactivate({ preserveTranslations, reason, requestGlobalDeactivation: true }).catch(() => {});
    } else {
      // Safety guard: ensure notification is dismissed in top frame even if already inactive
      this.dismissNotification();
    }
    this.isProcessingClick = false;
  }

  async revertTranslations() {
    window.isTranslationInProgress = false;
    const revertedCount = await this.domTranslatorAdapter.revertTranslation();
    pageEventBus.emit(WINDOWS_MANAGER_EVENTS.ELEMENT_TRANSLATIONS_CLEARED);
    return revertedCount;
  }

  showNotification() {
    pageEventBus.emit('show-select-element-notification', {
      managerId: this.instanceId,
      actions: {
        cancel: () => this.deactivate({ fromNotification: true, reason: 'cancel', requestGlobalDeactivation: true }),
        revert: () => this.revertTranslations(),
      },
    });
  }

  updateNotificationForTranslationProgress(completed, total, isRequestProgress = true) {
    pageEventBus.emit('update-select-element-notification', {
      status: TRANSLATION_STATUS.TRANSLATING,
      progress: { completed, total, isRequestProgress }
    });
  }

  dismissNotification() {
    pageEventBus.emit('dismiss-select-element-notification', { managerId: this.instanceId, isCancelAction: true });
  }

  setupKeyboardListeners() {}

  setupCancelListener() {
    this.addEventListener(pageEventBus, 'cancel-select-element-mode', () => {
      if (this.isActive) this.deactivate({ silent: true, reason: 'cancel', requestGlobalDeactivation: true });
    });
  }

  async notifyBackgroundActivation() {
    try {
      if (this._isNotifyingBackground) return;
      this._isNotifyingBackground = true;
      await sendMessage({ action: MessageActions.SET_SELECT_ELEMENT_STATE, data: { active: true } });
    } catch { /* ignore */ } finally { this._isNotifyingBackground = false; }
  }

  async notifyBackgroundDeactivation() {
    try { await sendMessage({ action: MessageActions.SET_SELECT_ELEMENT_STATE, data: { active: false } }); } catch { /* ignore */ }
  }

  /**
   * Emergency cleanup for critical situations (e.g. extension context invalid)
   * Restores page interaction immediately.
   */
  emergencyCleanup() {
    this._stopContextWatchdog();
    document.documentElement.removeAttribute('data-translate-it-select-mode');
    this.isActive = false;
    const adapterWasTranslating = this.domTranslatorAdapter?.isCurrentlyTranslating?.() === true;
    this.domTranslatorAdapter?.invalidateContext?.();
    this.forceCleanup();
    if (!adapterWasTranslating) this._notifyContextInvalidation();
  }

  /**
   * Monitor extension context to prevent stuck UI on extension reload/update
   * Only runs while the mode is active.
   * @private
   */
  _startContextWatchdog() {
    this._stopContextWatchdog();
    this.contextWatchdogInterval = setInterval(() => {
      if (this.isActive && !ExtensionContextManager.isValidSync()) {
        this.logger.warn('Extension context invalidated while in select mode. Performing emergency cleanup...');
        this.emergencyCleanup();
      }
    }, 2000); // Check every 2 seconds - balanced for performance and safety
  }

  /**
   * Routes watchdog-detected extension-context invalidation through the
   * canonical ExtensionContextManager recovery contract. isValidSync() only
   * reports a boolean signal, so the minimum typed context-invalidated error
   * required by the contract is constructed here. Runs after emergencyCleanup
   * so cleanup always completes even if notification handling were to fail.
   * @private
   */
  _notifyContextInvalidation() {
    const contextError = Object.assign(new Error('Extension context invalidated'), {
      type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
    });
    ExtensionContextManager.handleContextError(contextError, 'element-selection-watchdog');
  }

  /**
   * Stop the context watchdog interval
   * @private
   */
  _stopContextWatchdog() {
    if (this.contextWatchdogInterval) {
      clearInterval(this.contextWatchdogInterval);
      this.contextWatchdogInterval = null;
    }
  }

  async _ensureServicesAvailable() {
    try {
      if (!this.domTranslatorAdapter) {
        this.domTranslatorAdapter = new DomTranslatorAdapter();
        await this.domTranslatorAdapter.initialize();
      }
      if (!this.elementSelector) {
        this.elementSelector = new ElementSelector();
        await this.elementSelector.initialize();
      }
      return true;
    } catch { return false; }
  }

  /**
   * Ensure necessary CSS styles are injected for element selection
   * Only runs in main frame and uses the content core singleton
   * @private
   */
  async _ensureStylesInjected() {
    if (!this.isTopFrame) return;

    const contentCore = window.translateItContentCore;
    if (contentCore && typeof contentCore.injectMainDOMStyles === 'function') {
      await contentCore.injectMainDOMStyles(selectionStyles, 'translate-it-select-mode-styles');
    }
  }

  isSelectElementActive() { return this.isActive; }
  getStatus() { return { serviceActive: this.isActive, isProcessingClick: this.isProcessingClick, isInitialized: this.isInitialized, instanceId: this.instanceId, isTopFrame: this.isTopFrame }; }
  forceCleanup() {
    try {
      this._cancelPendingMouseFrame();
      this.removeEventListeners();
      this.elementSelector.deactivate();
      if (this.isTopFrame) this.dismissNotification();
    } catch { /* ignore */ }
  }

  async cleanup() {
    if (this.isActive) await this.deactivate({ reason: 'manual' });
    this.notificationManager = null;
    this.baseNotificationManager = null;
    super.cleanup();
  }
}

export { SelectElementManager };

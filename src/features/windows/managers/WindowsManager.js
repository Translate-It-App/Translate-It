// src/features/windows/managers/WindowsManager.js

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { WindowsState } from "./core/WindowsState.js";
import { CrossFrameManager } from "./crossframe/CrossFrameManager.js";
import { TranslationHandler as WindowsTranslationHandler } from "./translation/TranslationHandler.js";
import { ClickManager } from "./interaction/ClickManager.js";
import { ThemeManager } from "./theme/ThemeManager.js";
import { ErrorHandler } from "@/shared/error-management/ErrorHandler.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { WindowsManagerEvents } from '@/core/PageEventBus.js';

// New specialized managers
import { DisplayManager } from "./display/DisplayManager.js";
import { DismissalManager } from "./dismissal/DismissalManager.js";
import { EventCoordinator } from "./events/EventCoordinator.js";

/**
 * Facade WindowsManager that delegates to specialized modules
 */
let windowsManagerInstance = null;

export class WindowsManager extends ResourceTracker {
  constructor(options = {}) {
    super('windows-manager');

    if (windowsManagerInstance) {
      return windowsManagerInstance;
    }
    
    this.logger = getScopedLogger(LOG_COMPONENTS.WINDOWS, 'WindowsManager');
    windowsManagerInstance = this;
    if (typeof window !== 'undefined') {
      window.windowsManagerInstance = this;
    }
    
    // 1. Initialize core state and cross-frame communication
    this.crossFrameManager = new CrossFrameManager({
      debugCrossFrame: options.debugCrossFrame
    });
    this.state = new WindowsState(this.crossFrameManager.frameId);
    
    // 2. Initialize specialized logic modules
    this.translationHandler = options.translationHandler || new WindowsTranslationHandler(this.state);
    this.translationHandler.errorHandler = options.translationHandler?.errorHandler || ErrorHandler.getInstance();
    this.errorHandler = ErrorHandler.getInstance();
    this.clickManager = new ClickManager(this.crossFrameManager, this.state);
    this.themeManager = new ThemeManager();
    
    // TTS functionality (lazy loaded)
    this.tts = null;
    this.ttsManager = null;
    
    // Transient flags for internal coordination
    this._isIconToWindowTransition = false;
    this._lastDismissedIcon = null;
    this._isDismissingDueToTyping = false;
    this._preserveSelectionForTyping = false;
    this._isDismissing = false;
    this._lastDismissTime = 0;
    this._lastDismissedText = null;
    this._internalDisplayDismissRequestVersion = null;
    this._isInShiftClickOperation = false;

    // Event handler references for cleanup
    this._iconClickHandler = null;
    this._speakRequestHandler = null;
    this._retryRequestHandler = null;
    this._changeProviderRequestHandler = null;
    this._dismissRequestHandler = null;
    this._selectionTriggerHandler = null;
    this._selectionClearHandler = null;
    this._selectionChangeHandler = null;
    this._dismissHandler = null;
    this._escapeKeyHandler = null;
    this._shiftKeyReleaseHandler = null;
    this._lastProcessedClick = null;

    // 3. Initialize Domain Managers
    const deps = {
      state: this.state,
      crossFrameManager: this.crossFrameManager,
      translationHandler: this.translationHandler,
      errorHandler: this.errorHandler,
      clickManager: this.clickManager,
      themeManager: this.themeManager,
      tts: this.tts
    };

    this.displayManager = new DisplayManager(this, deps);
    this.dismissalManager = new DismissalManager(this, deps);
    this.eventCoordinator = new EventCoordinator(this, deps);

    this._initPromise = this._initialize();
  }

  async _initialize() {
    try {
      await this.themeManager.initialize();
      this.eventCoordinator.setup();
      this.logger.info('WindowsManager Facade initialized successfully');
    } catch (error) {
      this.logger.warn('Failed to initialize WindowsManager (non-critical):', error.message);
    }
  }

  /**
   * Ensure the WindowsManager is fully initialized and listeners are attached.
   * Useful when the feature is lazy-loaded to avoid race conditions.
   */
  async ensureInitialized() {
    if (this._initPromise) {
      await this._initPromise;
    }
  }

  // --- Public API Delegation ---

  async show(selectedText, position, options = {}, toolbarPosition = null) {
    return this.displayManager.show(selectedText, position, options, toolbarPosition);
  }

  invalidatePendingShows() {
    return this.displayManager.invalidatePendingShows();
  }

  async dismiss(withFadeOut = true, preserveSelection = false, displayRequestVersion = null) {
    if (displayRequestVersion !== null) {
      if (!this.displayManager.isCurrentShowRequest(displayRequestVersion)) return false;
    } else {
      this.displayManager.invalidatePendingShows();
      return this.dismissalManager.dismiss(withFadeOut, preserveSelection);
    }

    const previousRequestVersion = this._internalDisplayDismissRequestVersion;
    this._internalDisplayDismissRequestVersion = displayRequestVersion;
    try {
      return this.dismissalManager.dismiss(withFadeOut, preserveSelection);
    } finally {
      this._internalDisplayDismissRequestVersion = previousRequestVersion;
    }
  }

  async cancelCurrentTranslation() {
    await this.dismiss();
    this.state.setTranslationCancelled(true);
    try {
      if (this.tts) {
        await this.tts.stopAll();
      }
    } catch (error) {
      this.logger.warn('Failed to stop TTS during cancellation:', error);
    }
  }

  // --- Internal Shared Logic ---

  async _ensureTTSLoaded() {
    if (!this.tts || !this.ttsManager) {
      try {
        const { TTSFactory } = await import('@/features/tts/TTSFactory.js');
        const useTTSSmart = await TTSFactory.getTTSSmart();
        this.tts = useTTSSmart();
        const ttsGlobal = await TTSFactory.getTTSGlobal();
        this.ttsManager = ttsGlobal.TTSGlobalManager;
        
        // Update sub-managers with loaded TTS
        this.dismissalManager.tts = this.tts;
        this.eventCoordinator.tts = this.tts;

        this.logger.info('[TTS] TTS functionality loaded');
      } catch (error) {
        this.logger.warn('[TTS] Failed to load TTS functionality:', error.message);
        throw error;
      }
    }
    return this.tts;
  }

  async _startTranslationProcess(selectedText, windowId = null, options = {}) {
    const requestId = (this.state.translationGeneration || 0) + 1;
    this.state.translationGeneration = requestId;
    this.translationHandler.cancelAllTranslations?.();
    const isCurrent = () => this.state.translationGeneration === requestId;
    try {
      const translationOptions = { ...options, windowId };
      if (this.state.provider && !options.provider) {
        translationOptions.provider = this.state.provider;
      }
      translationOptions.isCurrent = isCurrent;
      const result = await this.translationHandler.performTranslation(selectedText, translationOptions);
      if (!isCurrent() || this.state.isTranslationCancelled || result?.cancelled) return null;
      if (result?.success === false || typeof result?.translatedText !== 'string' || !result.translatedText.trim()) {
        const error = new Error(ErrorTypes.API_RESPONSE_INVALID);
        error.type = ErrorTypes.API_RESPONSE_INVALID;
        throw error;
      }
      if (windowId) this.state.commitTranslation?.(selectedText, result, options);
      return { ...result, _requestId: requestId };
    } catch (error) {
      if (!isCurrent() || this.state.isTranslationCancelled || error.message === 'Translation cancelled') {
        return null;
      }
      error._requestId = requestId;
      throw error;
    }
  }

  _isCurrentTranslation(requestId) {
    return this.state.translationGeneration === requestId;
  }

  _historyUpdate(entry) {
    if (!entry) return {};
    return {
      selectedText: entry.sourceText,
      historyIndex: this.state.historyIndex,
      historyLength: this.state.translationHistory.length,
      historyProvider: entry.provider || '',
    };
  }

  _navigateTranslationHistory(id, direction) {
    const nextIndex = this.state.historyIndex + (direction === 'previous' ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= this.state.translationHistory.length) return;
    const entry = this.state.navigateHistory(direction);
    if (!entry) return;
    ++this.state.translationGeneration;
    this.translationHandler.cancelAllTranslations?.();
    WindowsManagerEvents.updateWindow(id, {
      isLoading: false, isStreaming: false, isError: false,
      initialTranslatedText: entry.translatedText,
      provider: entry.provider,
      sourceLanguage: entry.sourceLanguage,
      detectedSourceLanguage: entry.detectedSourceLanguage,
      targetLanguage: entry.targetLanguage,
      mode: entry.mode,
      ...this._historyUpdate(entry),
    });
  }

  isTextFieldElement(element) {
    if (!element || !element.isConnected) return false;
    if (element.tagName === 'INPUT') {
      const excludedTypes = ['checkbox', 'radio', 'submit', 'reset', 'button', 'file', 'image', 'hidden'];
      return !excludedTypes.includes(element.type || 'text');
    }
    return element.tagName === 'TEXTAREA' || 
           element.isContentEditable === true || 
           (element.closest && !!element.closest('[contenteditable="true"]')) ||
           (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false');
  }

  // --- Utility Forwarders for internal sub-manager use and backward compatibility ---
  _addDismissListener() { return this.dismissalManager._addDismissListener(); }
  _showWindow(text, pos, opt) { return this.displayManager._showWindow(text, pos, opt); }
  _showMobileSheet(text, opt) { return this.displayManager._showMobileSheet(text, opt); }
  _createTranslationWindow(text, pos) { return this.displayManager._createTranslationWindow(text, pos); }
  _handleTranslationError(err, text, pos) { return this.displayManager._handleTranslationError(err, text, pos); }
  _handleWindowCreationRequest(data) { return this.eventCoordinator._handleWindowCreationRequest(data); }
  _handleSelectionTrigger(payload) { return this.eventCoordinator._handleSelectionTrigger(payload); }

  // --- Lifecycle & Singleton ---

  destroy() {
    this.displayManager?.cleanup?.();
    this.cleanup();
    if (this.eventCoordinator?.cleanup) this.eventCoordinator.cleanup();
    this.eventCoordinator = null;
    this.displayManager = null;
    this.dismissalManager = null;
    
    if (this.crossFrameManager?.destroy) this.crossFrameManager.destroy();
    if (this.translationHandler?.destroy) this.translationHandler.destroy();
    if (this.clickManager?.destroy) this.clickManager.destroy();
    if (this.themeManager?.destroy) this.themeManager.destroy();
    
    windowsManagerInstance = null;
    this.logger.debug('🗑️ WindowsManager Facade destroyed');
  }

  static getInstance(options = {}) {
    if (!windowsManagerInstance) {
      windowsManagerInstance = new WindowsManager(options);
    }
    return windowsManagerInstance;
  }

  static resetInstance() {
    if (windowsManagerInstance) {
      windowsManagerInstance.destroy();
      windowsManagerInstance = null;
    }
  }

  // Backward compatibility getters
  get isVisible() { return this.state.isVisible; }
  get isIconMode() { return this.state.isIconMode; }
  get frameId() { return this.crossFrameManager.frameId; }
  get isTopFrame() { return this.crossFrameManager.isTopFrame; }
}

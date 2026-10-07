/**
 * FieldShortcutManager - Manages keyboard shortcuts for text field interactions
 * Handles the configured shortcut for quick translation of focused text field content
 */

import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { ErrorHandler } from "@/shared/error-management/ErrorHandler.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { isCancellationError } from "@/shared/error-management/ErrorMatcher.js";
import ExtensionContextManager from '@/core/extensionContext.js';
import { settingsManager } from '@/shared/managers/SettingsManager.js';
import { INPUT_TYPES } from '@/shared/constants/detection.js';
import { translateFieldViaSmartHandler } from '@/handlers/smartTranslationIntegration.js';
import { captureFieldTranslationSource } from '@/features/text-field-interaction/utils/framework/framework-compat/fieldSourceSnapshot.js';
import { isFieldTranslationRequestError } from '@/handlers/smart-translation/translationErrorOwnership.js';
import { getFieldTranslationErrorPresentation } from '@/features/text-field-interaction/utils/FieldTranslationErrorPresenter.js';
import { matchesShortcutEvent, parseShortcut } from '@/core/managers/content/shortcuts/shortcutKeys.js';

export class FieldShortcutManager {
  constructor() {
    this.key = 'Ctrl+/';
    this.description = 'Translate text in active field using keyboard shortcut';
    this.translationHandler = null;
    this.featureManager = null;
    this.initialized = false;
    this.currentShortcut = null;
    this.parsedShortcut = null;

    // Initialize logger
    this.logger = getScopedLogger(LOG_COMPONENTS.TEXT_FIELD_INTERACTION, 'FieldShortcutManager');
    this.logger.init('FieldShortcutManager initialized');
  }

  /**
   * Initialize with required dependencies
   * @param {Object} dependencies - Required dependencies
   */
  initialize(dependencies) {
    this.featureManager = dependencies.featureManager;
    this.initialized = true;

    // Load initial shortcut
    this.updateShortcut();

    // Listen for settings changes
    this._settingsUnsubscribe = settingsManager.onChange('ENABLE_SHORTCUT_FOR_TEXT_FIELDS', (newValue) => {
      this.logger.debug('ENABLE_SHORTCUT_FOR_TEXT_FIELDS changed:', newValue);
    }, 'field-shortcut-manager');

    this._shortcutUnsubscribe = settingsManager.onChange('TEXT_FIELD_SHORTCUT', (newValue) => {
      this.logger.debug('TEXT_FIELD_SHORTCUT changed:', newValue);
      this.updateShortcut();
    }, 'field-shortcut-manager');

    this.logger.debug('Initialized with dependencies');
  }

  /**
   * Update shortcut from settings
   */
  updateShortcut() {
    this.currentShortcut = settingsManager.get('TEXT_FIELD_SHORTCUT', 'Ctrl+/');
    this.parsedShortcut = this.parseShortcut(this.currentShortcut);
    this.logger.debug('Updated shortcut:', this.currentShortcut, this.parsedShortcut);
  }

/**
   * Parse shortcut string into object
   * @param {string} shortcut - Shortcut string (e.g., "Ctrl+Alt+T")
   * @returns {Object} Parsed shortcut object
   */
  parseShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== 'string') {
      return this.parseShortcut('Ctrl+/'); // fallback
    }

    return parseShortcut(shortcut);
  }

/**
   * Check if shortcut should be executed
   * @param {KeyboardEvent} event - Keyboard event
   * @returns {Promise<boolean>} Whether to execute the shortcut
   */
  async shouldExecute(event) {
    // Only execute on configured shortcut combination
    if (!this.isShortcutEvent(event)) {
      return false;
    }

    // Check if required dependencies are available
    if (!this.initialized) {
      this.logger.debug('Not initialized');
      return false;
    }

    // Check if extension and shortcut are enabled
    const isExtensionEnabled = settingsManager.get('EXTENSION_ENABLED', false);
    const isShortcutEnabled = settingsManager.get('ENABLE_SHORTCUT_FOR_TEXT_FIELDS', false);

    if (!isExtensionEnabled) {
      this.logger.debug('Extension is disabled');
      return false;
    }

    if (!isShortcutEnabled) {
      this.logger.debug('ENABLE_SHORTCUT_FOR_TEXT_FIELDS feature is disabled');
      return false;
    }

    // Check if active element is editable
    const activeElement = document.activeElement;
    if (!this.isEditableElement(activeElement)) {
      this.logger.debug('Active element is not editable');
      return false;
    }

    // Extract text from active element (request-time selection defines source)
    const snapshot = captureFieldTranslationSource(activeElement);
    const text = snapshot.text;
    if (!text) {
      this.logger.debug('No text found in active element');
      return false;
    }

    this.logger.debug('All conditions met, ready to execute');
    return true;
  }

  /**
   * Execute the configured field shortcut
   * @param {KeyboardEvent} event - Keyboard event
   * @returns {Promise<Object>} Execution result
   */
  async execute() {
    this.logger.debug('Executing field shortcut');

    try {
      // Get active element
      const activeElement = document.activeElement;

      // Extract text from active element (request-time selection defines source;
      // no selection preserves existing full-field behavior)
      const snapshot = captureFieldTranslationSource(activeElement);
      const text = snapshot.text;

      if (!text) {
        this.logger.debug('No text found in active element');
        return {
          success: false,
          error: 'No text found',
          type: 'ctrl-slash'
        };
      }
      this.logger.debug(`Translating field text: "${text.substring(0, 50)}..."`);

      await translateFieldViaSmartHandler({
        text: snapshot.text,
        target: activeElement,
        selectionRange: snapshot.selectionRange,
        sourceSnapshot: snapshot.sourceSnapshot,
      });

      this.logger.debug('Translation completed successfully');
      return {
        success: true,
        type: 'ctrl-slash',
        textLength: text.length,
        target: activeElement.tagName
      };

    } catch (error) {
      this.logger.warn('Error in Ctrl+/ handler:', error);

      const failure = (message = 'Shortcut execution failed') => ({
        success: false,
        error: message,
        type: 'ctrl-slash'
      });

      const isSilentFailure = isCancellationError(error)
        || error?.type === ErrorTypes.CONTEXT
        || error?.type === ErrorTypes.EXTENSION_CONTEXT_INVALIDATED
        || ExtensionContextManager.isContextError(error);

      if (isSilentFailure) {
        return failure(error?.message || 'Translation cancelled');
      }

      if (isFieldTranslationRequestError(error)) {
        const presentation = await getFieldTranslationErrorPresentation(error);

        if (!presentation) {
          return failure('Translation failed');
        }

        const errorHandler = ErrorHandler.getInstance();
        await errorHandler.handle(presentation.displayError, {
          context: 'ctrl-slash-shortcut',
          showToast: true,
          type: presentation.canonicalType || presentation.displayError.type
        });

        return failure(presentation.displayError.message || 'Translation failed');
      }

      // Use centralized error handling
      const errorHandler = ErrorHandler.getInstance();
      await errorHandler.handle(error, {
        type: ErrorTypes.TRANSLATION_FAILED,
        context: 'ctrl-slash-shortcut',
        showToast: true
      });

      return {
        success: false,
        error: error.message || 'Shortcut execution failed',
        type: 'ctrl-slash'
      };
    }
  }

  /**
   * Check if element is editable
   * @param {Element} element - DOM element
   * @returns {boolean} Whether element is editable
   */
  isEditableElement(element) {
    if (!element) return false;

    if (element.tagName === 'INPUT') {
      const type = (element.type || '').toLowerCase();
      // Use all text field types including financial, datetime, and control inputs
      return INPUT_TYPES.ALL_TEXT_FIELDS.includes(type);
    }

    if (element.tagName === 'TEXTAREA') {
      return true;
    }

    if (element.contentEditable === 'true') {
      return true;
    }

    return false;
  }

  /**
   * Extract text from element
   * @param {Element} element - DOM element
   * @returns {string|null} Extracted text
   */
  extractTextFromElement(element) {
    if (!element) return null;

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.value || null;
    }

    if (element.contentEditable === 'true') {
      return element.textContent || null;
    }

    return null;
  }

  /**
   * Check if event matches the configured shortcut
   * @param {KeyboardEvent} event - Keyboard event
   * @returns {boolean} Whether event matches the shortcut
   */
  isShortcutEvent(event) {
    return matchesShortcutEvent(event, this.parsedShortcut);
  }

  /**
   * Get shortcut description
   * @returns {string} Description
   */
  getDescription() {
    return this.description;
  }

  /**
   * Get current shortcut string
   * @returns {string} Current shortcut
   */
  getCurrentShortcut() {
    return this.currentShortcut || 'Ctrl+/';
  }

  /**
   * Get shortcut info
   * @returns {Object} Shortcut info
   */
  getInfo() {
    return {
      key: this.key,
      description: this.description,
      type: 'FieldShortcutManager',
      initialized: this.initialized,
      triggers: [
        'Configured shortcut in editable fields',
        'Requires SHORTCUT_TEXT_FIELDS feature enabled',
        'Requires text content in active field'
      ],
      dependencies: {
        translationHandler: !!this.translationHandler,
        featureManager: !!this.featureManager
      }
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    // Unsubscribe from settings changes
    if (this._settingsUnsubscribe) {
      this._settingsUnsubscribe();
      this._settingsUnsubscribe = null;
    }
    this._shortcutUnsubscribe?.();
    this._shortcutUnsubscribe = null;

    this.featureManager = null;
    this.initialized = false;

    this.logger.debug('Cleaned up');
  }
}

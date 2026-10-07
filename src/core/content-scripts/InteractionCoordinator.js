import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { settingsManager } from '@/shared/managers/SettingsManager.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { ExclusionChecker } from '@/features/exclusion/core/ExclusionChecker.js';
import { checkUrlExclusionAsync } from '@/features/exclusion/utils/exclusion-utils.js';
import { shortcutManager } from '@/core/managers/content/shortcuts/ShortcutManager.js';
import { matchesShortcutEvent, parseShortcut } from '@/core/managers/content/shortcuts/shortcutKeys.js';

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT, 'InteractionCoordinator');

class InteractionCoordinator {
  constructor() {
    this.activeListeners = new Map();
    this.isInitialized = false;
    this.exclusionChecker = ExclusionChecker.getInstance();
    
    this.isTopFrame = window === window.top;
    this.revertMightBeNeeded = false;
    
    this.handlers = {
      textSelection: this._handleTextSelection.bind(this),
      shortcut: this._handleKeyboardInteraction.bind(this),
      textFieldIcon: this._handleTextFieldFocus.bind(this),
      selectElement: this._handleContextMenu.bind(this),
      scroll: this._handleScroll.bind(this)
    };
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      // Setup settings change listeners
      const sync = () => this.sync();
      const featureSettings = [
        'EXTENSION_ENABLED', 'TRANSLATE_ON_TEXT_SELECTION', 'SHOW_DESKTOP_FAB',
        'TRANSLATE_WITH_SELECT_ELEMENT', 'ENABLE_SHORTCUT_FOR_TEXT_FIELDS', 'EXCLUDED_SITES'
      ];

      featureSettings.forEach(setting => {
        settingsManager.onChange(setting, sync, 'interaction-coordinator');
      });

      this._setupInternalTriggers();
      await this.sync();
      this.isInitialized = true;
      logger.debug('InteractionCoordinator initialized');
    } catch (error) {
      logger.error('Failed to initialize InteractionCoordinator:', error);
    }
  }

  _setupInternalTriggers() {
    const enableAndSync = (reason) => {
      if (!this.revertMightBeNeeded) {
        this.revertMightBeNeeded = true;
        logger.debug(`${reason} detected, enabling ESC monitoring`);
        this.sync();
      }
    };

    pageEventBus.on('select-mode-activated', () => enableAndSync('Select mode'));
    pageEventBus.on('ELEMENT_TRANSLATIONS_AVAILABLE', () => enableAndSync('Translations'));
  }

  async sync() {
    const isEnabled = settingsManager.isExtensionEnabled() && !(await checkUrlExclusionAsync());

    // Define listener requirements dynamically
    const config = [
      { key: 'textSelection', type: 'mouseup', handler: this.handlers.textSelection, allowed: isEnabled && await this.exclusionChecker.isFeatureAllowed('textSelection') },
      { key: 'shortcut', type: 'keydown', handler: this.handlers.shortcut, allowed: isEnabled && (await this.exclusionChecker.isFeatureAllowed('shortcut') || this.revertMightBeNeeded) },
      { key: 'textFieldIcon', type: 'focusin', handler: this.handlers.textFieldIcon, allowed: isEnabled && await this.exclusionChecker.isFeatureAllowed('textFieldIcon') },
      { key: 'selectElement', type: 'contextmenu', handler: this.handlers.selectElement, allowed: isEnabled && await this.exclusionChecker.isFeatureAllowed('selectElement') },
      { key: 'scroll', type: 'scroll', handler: this.handlers.scroll, allowed: isEnabled }
    ];

    config.forEach(item => this._manageListener(item.key, item.type, item.handler, item.allowed));
    pageEventBus.emit('sync-interaction-listeners');
  }

  _manageListener(key, eventType, handler, shouldBeActive) {
    const isActive = this.activeListeners.has(key);
    if (shouldBeActive && !isActive) {
      document.addEventListener(eventType, handler, { passive: eventType !== 'keydown' });
      this.activeListeners.set(key, { eventType, handler });
      logger.info(`Attached ${eventType} listener for ${key}`);
    } else if (!shouldBeActive && isActive) {
      document.removeEventListener(eventType, handler);
      this.activeListeners.delete(key);
      logger.info(`Detached ${eventType} listener for ${key}`);
    }
  }

  // --- Event Handlers ---

  async _handleTextSelection() {
    const selection = window.getSelection();
    if (selection?.toString().trim()) {
      const { loadFeature } = await import('./chunks/lazy-features.js');
      
      // Load UI and Selection logic
      if (this.isTopFrame) await loadFeature('windowsManager');
      await loadFeature('textSelection');
      
      // If in iframe, notify top frame (handled within selectionManager usually, but kept for safety)
      if (!this.isTopFrame) {
        window.top.postMessage({ type: 'TRANSLATE_IT_TEXT_SELECTION_DETECTED', source: 'translate-it-iframe' }, '*');
      }
    }
  }

  async _handleKeyboardInteraction(event) {
    const configuredShortcut = parseShortcut(settingsManager.get('TEXT_FIELD_SHORTCUT', 'Ctrl+/'));
    const isMainShortcut = matchesShortcutEvent(event, configuredShortcut);
    const isEscape = event.key === 'Escape' || event.code === 'Escape';
    
    if (!isMainShortcut && !(isEscape && this.revertMightBeNeeded)) return;

    const shortcutManagerWasInitialized = shortcutManager.initialized;
    const { loadFeature } = await import('./chunks/lazy-features.js');
    
    // ShortcutManager owns dispatch once initialized. First lazy activation
    // happens after this event has propagated, so delegate only that event once.
    await loadFeature('shortcut', isEscape);
    if (!shortcutManagerWasInitialized && shortcutManager.initialized) {
      shortcutManager.handleKeyboardEvent(event);
    }
  }

  async _handleTextFieldFocus(event) {
    const el = event.target;
    const isEditable = el && (el.isContentEditable || el.tagName === 'TEXTAREA' || 
                       (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel'].includes(el.type)));

    if (isEditable) {
      const { loadFeature } = await import('./chunks/lazy-features.js');
      await loadFeature('textFieldIcon');
    }
  }

  async _handleContextMenu() {
    if (await this.exclusionChecker.isFeatureAllowed('selectElement')) {
      const { loadFeature } = await import('./chunks/lazy-features.js');
      await loadFeature('selectElement');
    }
  }

  _handleScroll() {}

  cleanup() {
    for (const { eventType, handler } of this.activeListeners.values()) {
      document.removeEventListener(eventType, handler);
    }
    this.activeListeners.clear();
    this.isInitialized = false;
  }
}

export const interactionCoordinator = new InteractionCoordinator();
export default interactionCoordinator;

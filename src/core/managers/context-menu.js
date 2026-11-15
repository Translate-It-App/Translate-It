// src/managers/context-menu.js
// Context menu manager for cross-browser compatibility

import browser from "webextension-polyfill";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { 
  getDebugModeAsync, 
  getTargetLanguageAsync,
  getEffectiveProviderAsync,
  TranslationMode,
  CONFIG 
} from '@/shared/config/config.js';
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js';
import { providerRegistry } from '@/features/translation/providers/ProviderRegistry.js';
import { findProviderById, PROVIDER_MANIFEST } from '@/features/translation/providers/ProviderManifest.js';
import { isProviderConfigured } from '@/features/translation/utils/providerValidator.js';
import { handleActivateSelectElementModeLazy } from '@/core/background/handlers/lazy/handleElementSelectionLazy.js';
import { utilsFactory } from '@/utils/UtilsFactory.js';
// Element selection handler will be loaded lazily when needed
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import { openExtensionApp } from '@/core/ExtensionAppLauncher.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'context-menu');

// --- Constants for Menu Item IDs ---
const PAGE_CONTEXT_MENU_ID = "translate-with-select-element";
const PAGE_CONTEXT_TRANSLATE_ID = "translate-page";
const PAGE_CONTEXT_RESTORE_ID = "restore-page";
const PAGE_CONTEXT_PDF_ID = "open-pdf-with-link";
const ACTION_TRANSLATE_ELEMENT_ID = "action-translate-element";
const SCREEN_CAPTURE_MENU_ID = "screen-capture";
const ACTION_CONTEXT_MENU_OPTIONS_ID = "open-options-page";
const ACTION_CONTEXT_MENU_PDF_ID = "open-pdf-page";
const ACTION_CONTEXT_MENU_SUBTITLE_ID = "open-subtitle-page";
const ACTION_CONTEXT_MENU_SHORTCUTS_ID = "open-shortcuts-page";
const HELP_MENU_ID = "open-help-page";
const API_PROVIDER_PARENT_ID = "api-provider-parent";
const TRANSLATORS_PARENT_ID = "translators-parent";
const SETTINGS_PARENT_ID = "settings-parent";
const API_PROVIDER_ITEM_ID_PREFIX = "api-provider-";

// Settings required to build context menus and filter available providers.
const CONTEXT_MENU_SETTING_KEYS = [
  'EXTENSION_ENABLED',
  'TRANSLATE_WITH_SELECT_ELEMENT',
  'WHOLE_PAGE_TRANSLATION_ENABLED',
  'ENABLE_SCREEN_CAPTURE',
  'CONTEXT_MENU_VISIBILITY',
  'TRANSLATION_API',
  'MODE_PROVIDERS',
  'DEBUG_MODE',
  'HIDDEN_PROVIDERS',
  'DEEPL_API_KEY',
  'LINGVA_API_URL',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'CHEAPERINFERENCE_API_KEY',
  'DEEPSEEK_API_KEY',
  'CUSTOM_API_URL',
  'CUSTOM_API_MODEL',
  'WEBAI_API_URL',
  'WEBAI_API_MODEL'
];

// Match PageTranslationSettingsLoader's configured provider selection.
// Whole Page does not use getEffectiveProviderAsync's capability fallback.
function getConfiguredPageProvider(settings) {
  return settings.MODE_PROVIDERS?.[TranslationMode.Page]
    || (settings.TRANSLATION_API ?? CONFIG.TRANSLATION_API);
}

// --- Get API Providers from Registry ---
async function getApiProviders(settings = {}) {
  try {
    // Get current debug mode from storage to correctly filter Mock provider
    const isDebug = settings.DEBUG_MODE ?? await getDebugModeAsync();

    // Get available providers with dynamic debug mode override
    const hiddenProviders = settings.HIDDEN_PROVIDERS || [];
    let availableProviders = providerRegistry.getAllAvailable().filter(p => {
      if (p.id === 'mock' && !isDebug) return false;
      // Filter out hidden providers unless it's the currently selected one
      if (hiddenProviders.includes(p.id) && p.id !== settings.TRANSLATION_API) return false;
      return true;
    });

    // Filter by configuration status (API keys, etc.)
    availableProviders = availableProviders.filter(p => isProviderConfigured(p.id, settings));

    // Log provider structure for debugging
    logger.info("Processing available providers for context menu", {
      totalProviders: availableProviders.length,
      isDebugMode: isDebug
    });

    const validProviders = [];

    for (const provider of availableProviders) {
      // Handle both lazy providers and loaded provider classes
      let id, name, category;

      if (provider.isLazy) {
        // This is a lazy provider with metadata
        id = provider.id;
        name = provider.name;
        category = provider.category || provider.type; // Support both naming conventions
      } else {
        // This is a loaded provider class - should have been filtered out at registry level
        // But we handle it defensively
        logger.warn("Unexpected loaded provider class found in context menu:", provider.constructor?.name);
        continue;
      }

      // Validate required fields
      if (!id || !name) {
        logger.warn("Provider missing required id or name:", { id, name, provider });
        continue;
      }

      // Validate field types
      if (typeof id !== 'string' || typeof name !== 'string') {
        logger.warn("Provider id or name is not a string:", { id, name, provider });
        continue;
      }

      // Validate field content
      if (id.includes('undefined') || name.includes('undefined')) {
        logger.warn("Provider id or name contains undefined:", { id, name });
        continue;
      }

      // Validate ID format - should match registered provider IDs
      if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
        logger.warn("Provider ID doesn't match expected format:", { id, name });
        continue;
      }

      // Validate name content
      if (name.length < 2 || name.length > 50) {
        logger.warn("Provider name length seems invalid:", { id, name });
        continue;
      }

      // Check against known provider IDs for extra validation from manifest
      const knownProviderIds = PROVIDER_MANIFEST
        .map(p => p.id ? String(p.id).toLowerCase() : null)
        .filter(id => id !== null);

      if (id && !knownProviderIds.includes(String(id).toLowerCase())) {
        logger.warn("Unknown provider ID detected:", { id, name });
        // Don't filter out unknown providers, just warn - they might be newly added
      }

      validProviders.push({
        id: id ? String(id).toLowerCase() : 'unknown', // Normalize ID to lowercase
        defaultTitle: name,
        category: category
      });
    }

    // Remove duplicates based on id (case-insensitive)
    const uniqueProviders = [];
    const seenIds = new Set();

    for (const provider of validProviders) {
      const normalizedId = provider.id ? String(provider.id).toLowerCase() : null;
      if (normalizedId && !seenIds.has(normalizedId)) {
        seenIds.add(normalizedId);
        uniqueProviders.push({
          ...provider,
          id: normalizedId // Ensure consistent case
        });
      } else if (normalizedId) {
        logger.warn(`Removing duplicate provider with id: ${provider.id}`);
      }
    }

    logger.debug("Final provider list created", {
      providerCount: uniqueProviders.length,
      providers: uniqueProviders.map(p => p.id)
    });
    return uniqueProviders;
  } catch (error) {
    logger.error("Failed to get providers dynamically, using fallback:", error);

    // Fallback to basic provider list if dynamic loading fails
    return [
      { id: ProviderRegistryIds.GOOGLE_V2, defaultTitle: "Google Translate" },
      { id: ProviderRegistryIds.GOOGLE, defaultTitle: "Google Translate (Classic)" },
      { id: ProviderRegistryIds.YANDEX, defaultTitle: "Yandex Translate" },
      { id: ProviderRegistryIds.DEEPL, defaultTitle: "DeepL Translate" },
      { id: ProviderRegistryIds.GEMINI, defaultTitle: "Google Gemini" },
      { id: ProviderRegistryIds.OPENAI, defaultTitle: "OpenAI" },
      { id: ProviderRegistryIds.OPENROUTER, defaultTitle: "OpenRouter" },
      { id: ProviderRegistryIds.REQUESTY, defaultTitle: "Requesty" },
      { id: ProviderRegistryIds.CHEAPERINFERENCE, defaultTitle: "Cheaper Inference" },
      { id: ProviderRegistryIds.DEEPSEEK, defaultTitle: "DeepSeek" },
      { id: ProviderRegistryIds.WEBAI, defaultTitle: "WebAI" },
      { id: ProviderRegistryIds.BING, defaultTitle: "Bing Translate" },
      { id: ProviderRegistryIds.LINGVA, defaultTitle: "Lingva Translate" },
      { id: ProviderRegistryIds.BROWSER, defaultTitle: "Browser API" },
      { id: ProviderRegistryIds.CUSTOM, defaultTitle: "Custom Provider" }
    ];
  }
}

/**
 * Canonical bulk deactivation: routes each accessible tab through authoritative Background handler.
 */
async function deactivateSelectElementModeInAllTabs() {
  try {
    const tabs = await browser.tabs.query({});
    let processedTabs = 0;

    const { handleDeactivateSelectElementModeLazy } = await import('@/core/background/handlers/lazy/handleElementSelectionLazy.js');

    for (const tab of tabs) {
      if (tab.id) {
        try {
          const tabAccess = await tabPermissionChecker.checkTabAccess(tab.id);

          if (tabAccess.isAccessible) {
            try {
              await handleDeactivateSelectElementModeLazy(
                { action: MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, data: { tabId: tab.id, active: false } },
                { tab: { id: tab.id } }
              );
            } catch (handlerError) {
              if (ExtensionContextManager.isContextError(handlerError)) {
                ExtensionContextManager.handleContextError(handlerError, `context-menu:deactivate:tab-${tab.id}`);
              } else {
                logger.debug(`Canonical deactivation failed for tab ${tab.id}:`, handlerError);
              }
            }
            processedTabs++;
          } else {
            logger.debug(`Skipping deactivation for restricted tab ${tab.id}: ${tabAccess.errorMessage}`);
          }
        } catch (permError) {
          logger.debug(`Error checking permissions for tab ${tab.id}, skipping:`, permError);
        }
      }
    }

    logger.info(
      "Sent canonical deactivation for Select Element mode to accessible tabs",
      {
        totalTabs: tabs.length,
        processedTabs,
        skippedTabs: tabs.length - processedTabs
      }
    );
  } catch (e) {
    logger.error("Error trying to deactivate select element mode in all tabs:", e);
  }
}

/**
 * Helper function to focus or create a tab using the background script message action
 */
async function focusOrCreateTab(url) {
  try {
    const backgroundService = globalThis.backgroundService;
    if (backgroundService && backgroundService.messageHandler) {
      const handler = backgroundService.messageHandler.getHandlerForMessage(MessageActions.LAUNCH_EXTENSION_APP);
      if (handler) {
        // Extract just the relative path (e.g. "src/html/subtitle.html")
        let urlPath = "";
        try {
          urlPath = new URL(url).pathname.replace(/^\//, '');
        } catch {
          urlPath = url; // Fallback
        }
        
        await handler({
          action: MessageActions.LAUNCH_EXTENSION_APP,
          data: { urlPath }
        }, { tab: null }, () => {});
        return;
      }
    }
    
    // Fallback if background service is not available (unlikely in context-menu.js since it runs in background)
    // Send message through regular messaging system
    let urlPath = "";
    try {
      urlPath = new URL(url).pathname.replace(/^\//, '');
    } catch {
      urlPath = url;
    }
    
    await browser.runtime.sendMessage({
      action: MessageActions.LAUNCH_EXTENSION_APP,
      data: { urlPath }
    });
  } catch (error) {
    logger.error("Failed to focus or create tab via message:", error);
    // Absolute fallback: just create a new tab
    await browser.tabs.create({ url });
  }
}

/**
 * Context Menu Manager
 * Handles context menu creation and management across browsers
 */
export class ContextMenuManager extends ResourceTracker {
  constructor() {
    super('context-menu-manager');
    this.browser = null;
    this.initialized = false;
    this.createdMenus = new Set();
    this.storageListener = null;
    this.pageMenuListeners = [];
    this.pageTranslationStates = new Map();
    this.activePageTabId = null;
    this._pageMenuRefreshVersion = 0;
    this._pageMenuUpdatePromise = Promise.resolve();
  }

  /**
   * Initialize the context menu manager
   * @param {boolean} force - Force re-initialization even if already initialized
   * @param {string} locale - Specific locale to use for translations
   */
  async initialize(force = false, locale = null) {
    if (this.initialized && !force) return;

    try {
      this.browser = browser;

      // Check if contextMenus API is available (not available on mobile)
      if (!this.browser.contextMenus) {
        logger.info("Context menus API not available, skipping initialization");
        this.initialized = true;
        return;
      }

      logger.info("Initializing context menu manager", force ? '(forced)' : '');

      // Set up default context menus (this clears existing ones)
      await this.setupDefaultMenus(locale);

      // Register storage listener only if it has not already been registered
      if (!this.storageListener) {
        this.registerStorageListener();
      }

      if (!this.pageMenuListeners.length) {
        this.registerPageMenuListeners();
        await this.refreshActivePageMenu();
      }

      this.initialized = true;
      logger.info("Context menu manager initialized");
    } catch (error) {
      this.initialized = false;
      logger.error("Failed to initialize context menu manager:", error);
      throw error;
    }
  }

  /**
   * Set up default context menus
   * @param {string} locale - Specific locale to use for translations
   * @private
   */
  // Prevent concurrent menu setup
  _menuSetupLock = false;
  _pendingSetupPromise = null;
  _needsRerun = false;

  async setupDefaultMenus(locale = null) {
    if (!this.browser?.contextMenus && !browser?.contextMenus) {
      logger.debug("Skipping setupDefaultMenus: contextMenus API not available");
      return;
    }

    logger.debug("🔧 [ContextMenuManager] Starting setupDefaultMenus...");

    // If already running, mark as needing a rerun and wait for the current one
    if (this._menuSetupLock) {
      logger.debug("setupDefaultMenus called concurrently, marking for rerun");
      this._needsRerun = true;
      if (this._pendingSetupPromise) {
        await this._pendingSetupPromise;
      }
      return;
    }

    this._menuSetupLock = true;
    this._needsRerun = false;

    try {
      // Execute setup, and rerun if requested while we were running
      do {
        this._needsRerun = false;
        this._pendingSetupPromise = this._setupMenusInternal(locale);
        await this._pendingSetupPromise;
        logger.debug("[ContextMenuManager] Setup iteration completed", { needsRerun: this._needsRerun });
      } while (this._needsRerun);

      if (this.storageListener) {
        this.initialized = true;
      }
    } catch (error) {
      this.initialized = false;
      logger.error("Failed to setup default menus:", error);
      throw error;
    } finally {
      this._menuSetupLock = false;
      this._pendingSetupPromise = null;
      this._needsRerun = false;
    }

    if (this.pageMenuListeners.length) {
      await this.refreshActivePageMenu();
    }
  }

  /**
   * Internal implementation of menu setup (separated for proper locking)
   * @private
   */
  async _setupMenusInternal(locale) {
    try {
      // Get i18n utility from factory
      const { getTranslationString } = await utilsFactory.getI18nUtils();

      // Prepare all required data before removing working menus.
      const settings = await storageManager.get(CONTEXT_MENU_SETTING_KEYS, false);
      const isExtensionEnabled = settings.EXTENSION_ENABLED !== false;
      const selectElementApi = await getEffectiveProviderAsync(TranslationMode.Select_Element);
      const pageApi = getConfiguredPageProvider(settings);
      const provider = findProviderById(selectElementApi);
      const isBulkSupported = provider?.features?.includes('bulk') ?? false;
      const isSelectElementEnabled = isExtensionEnabled &&
                                   (settings.TRANSLATE_WITH_SELECT_ELEMENT !== false) &&
                                   isBulkSupported;
      const isScreenCaptureEnabled = isExtensionEnabled && (settings.ENABLE_SCREEN_CAPTURE !== false);
      const isPageTranslationEnabled = isExtensionEnabled &&
                                      (settings.WHOLE_PAGE_TRANSLATION_ENABLED !== false) &&
                                      (findProviderById(pageApi)?.features?.includes('bulk') ?? false);
      const visibility = settings.CONTEXT_MENU_VISIBILITY || CONFIG.CONTEXT_MENU_VISIBILITY;
      const isPageMenuVisible = isExtensionEnabled && visibility.PAGE_CONTEXT_PAGE_TRANSLATION !== false;
      const commands = await browser.commands.getAll();

      // Finish any in-flight visibility update before replacing its menu IDs.
      await this._pageMenuUpdatePromise;

      // Clear existing menus first and wait for completion
      // Increase delay to ensure removeAll() fully completes before creating new menus
      // This prevents "duplicate id" errors from Chrome
      await browser.contextMenus.removeAll();

      // Verify menus are cleared by waiting longer
      await new Promise(resolve => setTimeout(resolve, 200));

      // Double-check that all menus are cleared
      try {
        const existingMenus = await browser.contextMenus.getAll();
        if (existingMenus.length > 0) {
          logger.warn(`Found ${existingMenus.length} menus still after removeAll(), clearing again`);
          await browser.contextMenus.removeAll();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (e) {
        logger.debug("Could not verify menu removal:", e);
      }

      this.createdMenus.clear();
      logger.debug("[ContextMenuManager] Cleared existing menus and verified");

      // --- 1. Create Page Context Menu (Select Element) ---
      if (isSelectElementEnabled && visibility.PAGE_CONTEXT_SELECT_ELEMENT) {
        try {
          let pageMenuTitle =
            (await getTranslationString("context_menu_translate_with_selection", locale)) ||
            "Translate Element";
          const command = commands.find((c) => c.name === "SELECT-ELEMENT-COMMAND");
          if (command && command.shortcut) {
            pageMenuTitle = `${pageMenuTitle} (${command.shortcut})`;
          }
          await this.createMenu({
            id: PAGE_CONTEXT_MENU_ID,
            title: pageMenuTitle,
            contexts: ["page", "selection", "link", "image", "video", "audio"],
          });
          logger.debug(`Created page context menu: "${pageMenuTitle}"`);
        } catch (e) {
          logger.error("Error creating page context menu:", e);
        }
      }

      // --- 1.5. Create Page Context Menu (Open in PDF Translator) ---
      if (visibility.PAGE_CONTEXT_PDF_TRANSLATOR !== false) {
        await this.createMenu({
          id: PAGE_CONTEXT_PDF_ID,
          title: (await getTranslationString("pdf_app_title", locale)) || "PDF Translator",
          contexts: ["link"],
          targetUrlPatterns: ["*://*/*.pdf", "*://*/*.PDF"],
        });
      }

      // --- 2. Create Action (Browser Action) Context Menus ---
      try {
        logger.debug("[ContextMenuManager] Creating Action (Browser Action) menus...");

        // --- 2.1. API Provider Parent Menu (First option in Action menu) ---
        await this.createMenu({
          id: API_PROVIDER_PARENT_ID,
          title:
            (await getTranslationString("context_menu_api_provider", locale)) ||
            "API Provider",
          contexts: ["action"],
        });
        logger.debug("Created API Provider parent menu");

        // --- API Provider Sub-Menus (Radio Buttons) ---
        const apiProviders = await getApiProviders(settings);
        logger.debug(`[ContextMenuManager] Found ${apiProviders.length} providers`);

        let lastCategory = null;
        let separatorCount = 0;

        for (const provider of apiProviders) {
          // Add separator if category changes (except for the first provider)
          if (lastCategory !== null && provider.category && provider.category !== lastCategory) {
            separatorCount++;
            await this.createMenu({
              id: `api-provider-separator-${separatorCount}`,
              parentId: API_PROVIDER_PARENT_ID,
              type: "separator",
              contexts: ["action"],
            });
          }
          
          lastCategory = provider.category;

          await this.createMenu({
            id: `${API_PROVIDER_ITEM_ID_PREFIX}${provider.id}`,
            parentId: API_PROVIDER_PARENT_ID,
            title: provider.defaultTitle,
            type: "checkbox",
            checked: provider.id === settings.TRANSLATION_API,
            contexts: ["action"],
          });
        }
        logger.debug(
          `Created ${apiProviders.length} API Provider sub-menus. Current API: ${settings.TRANSLATION_API}`
        );

        // --- 2.2. Translate Element Menu (Second option in Action menu) ---
        if (isSelectElementEnabled && visibility.ACTION_CONTEXT_SELECT_ELEMENT) {
          let actionPageMenuTitle =
            (await getTranslationString("context_menu_translate_with_selection", locale)) ||
            "Translate Element";
          const command = commands.find((c) => c.name === "SELECT-ELEMENT-COMMAND");
          if (command && command.shortcut) {
            actionPageMenuTitle = `${actionPageMenuTitle} (${command.shortcut})`;
          }
          await this.createMenu({
            id: ACTION_TRANSLATE_ELEMENT_ID,
            title: actionPageMenuTitle,
            contexts: ["action"],
          });
          logger.debug(`Created Translate Element action menu: "${actionPageMenuTitle}"`);
        }

        // --- 2.3. Screen Capture Menu (Third option in Action menu, also in Page menu) ---
        // Separate Page and Action contexts for Screen Capture to match Select Element logic
        if (isScreenCaptureEnabled) {
          try {
            const captureMenuTitle =
              (await getTranslationString("context_menu_translate_screen", locale)) ||
              "Capture Screen";

            // 2.3.1. Create in Page Context
            if (visibility.PAGE_CONTEXT_SCREEN_CAPTURE !== false) {
              await this.createMenu({
                id: `${SCREEN_CAPTURE_MENU_ID}-page`, // Unique ID for page context
                title: captureMenuTitle,
                contexts: ["page"],
              });
              logger.debug(`Created screen capture page menu: "${captureMenuTitle}"`);
            }

            // 2.3.2. Create in Action Context
            if (visibility.ACTION_CONTEXT_SCREEN_CAPTURE !== false) {
              await this.createMenu({
                id: `${SCREEN_CAPTURE_MENU_ID}-action`, // Unique ID for action context
                title: captureMenuTitle,
                contexts: ["action"],
              });
              logger.debug(`Created screen capture action menu: "${captureMenuTitle}"`);
            }
          } catch (e) {
            logger.error("Error creating screen capture menu:", e);
          }
        }

        // --- 2.4. Translators Menu ---
        const isTranslatorsMenuVisible =
          visibility.ACTION_CONTEXT_PDF_TRANSLATOR !== false ||
          visibility.ACTION_CONTEXT_SUBTITLE_TRANSLATOR !== false;

        if (isTranslatorsMenuVisible) {
          await this.createMenu({
            id: TRANSLATORS_PARENT_ID,
            title:
              (await getTranslationString("context_menu_translators", locale)) ||
              "Translators",
            contexts: ["action"],
          });

          if (visibility.ACTION_CONTEXT_PDF_TRANSLATOR !== false) {
            await this.createMenu({
              id: ACTION_CONTEXT_MENU_PDF_ID,
              parentId: TRANSLATORS_PARENT_ID,
              title: (await getTranslationString("pdf_app_title", locale)) || "PDF Translator",
              contexts: ["action"],
            });
          }

          if (visibility.ACTION_CONTEXT_SUBTITLE_TRANSLATOR !== false) {
            await this.createMenu({
              id: ACTION_CONTEXT_MENU_SUBTITLE_ID,
              parentId: TRANSLATORS_PARENT_ID,
              title: (await getTranslationString("subtitle_app_title", locale)) || "Subtitle Translator",
              contexts: ["action"],
            });
          }
        }

        // --- 2.5. Settings Menu ---
        const isSettingsMenuVisible =
          visibility.ACTION_CONTEXT_OPTIONS ||
          visibility.ACTION_CONTEXT_SHORTCUTS ||
          visibility.ACTION_CONTEXT_HELP;

        if (isSettingsMenuVisible) {
          await this.createMenu({
            id: SETTINGS_PARENT_ID,
            title:
              (await getTranslationString("context_menu_settings", locale)) ||
              "Settings",
            contexts: ["action"],
          });

          if (visibility.ACTION_CONTEXT_OPTIONS) {
            await this.createMenu({
              id: ACTION_CONTEXT_MENU_OPTIONS_ID,
              parentId: SETTINGS_PARENT_ID,
              title: (await getTranslationString("context_menu_options", locale)) || "Options",
              contexts: ["action"],
            });
          }

          if (visibility.ACTION_CONTEXT_SHORTCUTS) {
            await this.createMenu({
              id: ACTION_CONTEXT_MENU_SHORTCUTS_ID,
              parentId: SETTINGS_PARENT_ID,
              title:
                (await getTranslationString("context_menu_shortcuts", locale)) ||
                "Manage Shortcuts",
              contexts: ["action"],
            });
          }

          if (visibility.ACTION_CONTEXT_HELP) {
            await this.createMenu({
              id: HELP_MENU_ID,
              parentId: SETTINGS_PARENT_ID,
              title:
                (await getTranslationString("context_menu_help", locale)) || "Help & Support",
              contexts: ["action"],
            });
          }
        }
        logger.debug("Action context menus created successfully.");
      } catch (e) {
        logger.error("Error creating action context menus:", e);
      }

      // Create whole-page commands last so the visible command stays at the
      // bottom of the extension's page context menu in either translation state.
      const needsRestore = this.pageTranslationStates.get(this.activePageTabId)?.needsRestore === true;
      if (isPageMenuVisible && isPageTranslationEnabled) {
        try {
          await this.createMenu({
            id: PAGE_CONTEXT_TRANSLATE_ID,
            title: (await getTranslationString("context_menu_translate_page", locale)) || "Translate This Page",
            contexts: ["page", "selection", "link", "image", "video", "audio"],
            visible: !needsRestore,
          });
        } catch (e) {
          logger.error("Error creating page translation context menu:", e);
        }
      }

      // Keep restore available even after disabling page translation or changing
      // to a provider without bulk support, so existing translations can be undone.
      if (isPageMenuVisible) {
        try {
          await this.createMenu({
            id: PAGE_CONTEXT_RESTORE_ID,
            title: (await getTranslationString("context_menu_restore_page", locale)) || "Restore Original Page",
            contexts: ["page", "selection", "link", "image", "video", "audio"],
            visible: needsRestore,
          });
        } catch (e) {
          logger.error("Error creating page restore context menu:", e);
        }
      }

      logger.info("Default context menus created");
    } catch (error) {
      logger.error("Failed to setup default menus:", error);
      throw error;
    }
  }

  /**
   * Create a context menu item
   * @param {Object} menuConfig - Menu configuration
   * @returns {Promise<string>} Menu item ID
   */
  async createMenu(menuConfig) {
    if (!this.browser) {
      this.browser = browser;
    }

    try {
      const menuId = await new Promise((resolve, reject) => {
        // Use a universal approach that works in both Firefox and Chromium
        // Most browser APIs (like contextMenus.create) are still synchronous or 
        // use callbacks rather than returning a Promise, even in Firefox.
        try {
          // 1. Attempt to create the menu
          const id = this.browser.contextMenus.create(menuConfig, () => {
            // Check for Chromium/Chrome runtime errors in the callback
            const lastError = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.lastError : null;
            if (lastError) {
              const msg = lastError.message || "";
              if (msg && typeof msg === 'string' && (msg.toLowerCase().includes('duplicate id') || msg.toLowerCase().includes('already exists'))) {
                logger.debug(`Context menu with duplicate ID "${menuConfig.id}" already exists (callback), skipping`);
                resolve(menuConfig.id);
              } else {
                reject(new Error(msg || "Unknown context menu creation error"));
              }
            } else {
              resolve(menuConfig.id || id);
            }
          });

          // 2. Handle non-callback errors (especially for Firefox)
          // If we reached here without a crash, the menu was at least submitted.
          // Firefox will throw an error immediately if the ID is duplicate.
          if (id) {
            resolve(id);
          }
        } catch (err) {
          const msg = err ? (err.message || String(err)) : "";
          if (msg && typeof msg === 'string' && (msg.toLowerCase().includes('duplicate id') || msg.toLowerCase().includes('already exists'))) {
            logger.debug(`Context menu with duplicate ID "${menuConfig.id}" already exists (sync/exception), skipping`);
            resolve(menuConfig.id);
          } else {
            reject(err);
          }
        }
      });

      this.createdMenus.add(menuConfig.id || menuId);
      logger.debug(`Created context menu: ${menuConfig.title || menuConfig.id}`);
      return menuId;
    } catch (error) {
      logger.error("Failed to create context menu:", error);
      throw error;
    }
  }

  /**
   * Update a context menu item
   * @param {string} menuId - Menu item ID
   * @param {Object} updateInfo - Updated menu properties
   */
  async updateMenu(menuId, updateInfo) {
    // Use browser API check instead of initialized check to avoid recursion
    if (!this.browser) {
      this.browser = browser;
    }

    try {
      await this.browser.contextMenus.update(menuId, updateInfo);
      logger.debug(`Updated context menu: ${menuId}`);
    } catch (error) {
      logger.error(`Failed to update context menu ${menuId}:`, error);
      throw error;
    }
  }

  /**
   * Remove a context menu item
   * @param {string} menuId - Menu item ID to remove
   */
  async removeMenu(menuId) {
    // Use browser API check instead of initialized check to avoid recursion
    if (!this.browser) {
      this.browser = browser;
    }

    try {
      await this.browser.contextMenus.remove(menuId);
      this.createdMenus.delete(menuId);

      logger.debug(`Removed context menu: ${menuId}`);
    } catch (error) {
      logger.error(`Failed to remove context menu ${menuId}:`, error);
      throw error;
    }
  }

  /**
   * Clear all context menus
   */
  async clearAllMenus() {
    // Use browser API check instead of initialized check to avoid recursion
    if (!this.browser) {
      this.browser = browser;
    }

    try {
      await this.browser.contextMenus.removeAll();
      this.createdMenus.clear();

      logger.info("Cleared all context menus");
    } catch (error) {
      logger.error("Failed to clear context menus:", error);
      throw error;
    }
  }

  /**
   * Helper to activate select element mode via the central handler
   * @param {Object} tab - The tab to activate the mode in
   */
  async _activateSelectElement(tab) {
    if (!tab || !tab.id) return;

    try {
      // Check if tab is accessible before attempting activation
      const tabAccess = await tabPermissionChecker.checkTabAccess(tab.id);

      if (!tabAccess.isAccessible) {
        logger.warn(`Cannot activate select element mode for tab ${tab.id}: ${tabAccess.errorMessage}`);
        return;
      }

      logger.info(`Activating select mode for tab ${tab.id} via central handler`);

      const [targetLanguage, provider] = await Promise.all([
        getTargetLanguageAsync(),
        getEffectiveProviderAsync(TranslationMode.Select_Element)
      ]);

      const message = {
        action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
        context: 'context-menu',
        data: { active: true, tabId: tab.id, targetLanguage, provider }
      };
      const sender = { tab };

      // Element Selection handler is already imported statically
      await handleActivateSelectElementModeLazy(message, sender);
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, `context-menu:activate-select-element:tab-${tab.id}`);
      } else {
        logger.error(`Could not activate select element mode for tab ${tab.id}:`, error);
      }
    }
  }

  /**
   * Route a whole-page command through the canonical Background handler.
   * The clicked tab is authoritative even if the active tab changes meanwhile.
   */
  async _handlePageCommand(action, tab) {
    if (!Number.isInteger(tab?.id) || tab.id < 0) return;

    const settings = await storageManager.get([
      'EXTENSION_ENABLED',
      'WHOLE_PAGE_TRANSLATION_ENABLED',
      'TRANSLATION_API',
      'MODE_PROVIDERS',
    ], false);
    if (settings.EXTENSION_ENABLED === false) return;

    if (action === MessageActions.PAGE_TRANSLATE) {
      if (settings.WHOLE_PAGE_TRANSLATION_ENABLED === false) return;
      const provider = getConfiguredPageProvider(settings);
      if (!findProviderById(provider)?.features?.includes('bulk')) return;
    }

    const { handlePageTranslation } = await import('@/core/background/handlers/page-translation/handlePageTranslation.js');
    const result = await handlePageTranslation({ action, context: 'context-menu' }, { tab });
    if (result?.success === false) {
      logger.warn('Page context menu command was not completed', { action, tabId: tab.id, result });
    }
    await this.refreshActivePageMenu();
  }

  /**
   * Observe authoritative top-frame aggregates without responding to messages.
   * Frame-local completion/restore events cannot determine the whole tab state.
   */
  registerPageMenuListeners() {
    if (this.pageMenuListeners.length) return;

    const listen = (event, listener) => {
      if (!event?.addListener) return;
      event.addListener(listener);
      this.pageMenuListeners.push([event, listener]);
    };

    try {
      listen(browser.runtime.onMessage, (message, sender) => {
        const tabId = sender?.tab?.id;
        if (
          !Number.isInteger(tabId) || tabId < 0 || sender.frameId !== 0
          || message?.data?.isAggregated !== true
          || !MessageActions.PAGE_TRANSLATION_AGGREGATE_ACTIONS.includes(message.action)
        ) return false;

        const previousState = this.pageTranslationStates.get(tabId);
        const needsRestore = this.hasRestorablePageState(message.data);
        this.pageTranslationStates.set(tabId, { needsRestore });
        if (tabId === this.activePageTabId && previousState?.needsRestore !== needsRestore) {
          void this.syncPageMenuVisibility();
        }
        return false;
      });
      listen(browser.tabs.onActivated, () => { void this.refreshActivePageMenu(); });
      listen(browser.windows?.onFocusChanged, (windowId) => {
        if (windowId !== -1) void this.refreshActivePageMenu();
      });
      listen(browser.tabs.onUpdated, (tabId, changes) => {
        if (changes.status === 'loading') {
          this.pageTranslationStates.delete(tabId);
          if (tabId === this.activePageTabId) {
            this._pageMenuRefreshVersion++;
            void this.syncPageMenuVisibility();
          }
        } else if (tabId === this.activePageTabId && (changes.status === 'complete' || changes.url)) {
          void this.refreshActivePageMenu();
        }
      });
      listen(browser.tabs.onRemoved, (tabId) => {
        this.pageTranslationStates.delete(tabId);
        if (tabId === this.activePageTabId) {
          this.activePageTabId = null;
          this._pageMenuRefreshVersion++;
          void this.syncPageMenuVisibility();
        }
      });

      // Firefox can also refresh the menu for the exact tab where it opens.
      // Chrome relies on the tab/window and translation lifecycle listeners.
      const menus = browser.menus || browser.contextMenus;
      listen(menus.onShown, (_info, tab) => {
        void this.refreshActivePageMenu(tab)
          .then(() => menus.refresh?.())
          .catch(error => logger.debug('Could not refresh shown page menu:', error));
      });
    } catch (error) {
      this.removePageMenuListeners();
      throw error;
    }
  }

  removePageMenuListeners() {
    for (const [event, listener] of this.pageMenuListeners) {
      event.removeListener(listener);
    }
    this.pageMenuListeners = [];
  }

  hasRestorablePageState(status) {
    return status.isTranslating === true || status.isTranslated === true
      || status.isAutoTranslating === true || status.translatedCount > 0;
  }

  /**
   * Recover a tab's state on activation/rebuild, including background restarts.
   * Unknown status preserves the last known state; late probes cannot overwrite
   * newer lifecycle events, navigation, or a switch to another tab.
   */
  async refreshActivePageMenu(tab = null) {
    if (!this.createdMenus.has(PAGE_CONTEXT_TRANSLATE_ID) && !this.createdMenus.has(PAGE_CONTEXT_RESTORE_ID)) return;

    const version = ++this._pageMenuRefreshVersion;
    try {
      const activeTab = tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      if (version !== this._pageMenuRefreshVersion) return;
      this.activePageTabId = Number.isInteger(activeTab?.id) && activeTab.id >= 0 ? activeTab.id : null;
      await this.syncPageMenuVisibility();
      if (this.activePageTabId === null) return;

      const tabId = this.activePageTabId;
      const previousState = this.pageTranslationStates.get(tabId);
      const { handlePageTranslation } = await import('@/core/background/handlers/page-translation/handlePageTranslation.js');
      const status = await handlePageTranslation(
        { action: MessageActions.PAGE_TRANSLATE_GET_STATUS, context: 'context-menu' },
        { tab: activeTab }
      );
      if (version !== this._pageMenuRefreshVersion || previousState !== this.pageTranslationStates.get(tabId)) return;
      if (status?.success) {
        this.pageTranslationStates.set(tabId, { needsRestore: this.hasRestorablePageState(status) });
        await this.syncPageMenuVisibility();
      }
    } catch (error) {
      logger.debug('Could not refresh page context menu state:', error);
    }
  }

  /**
   * Hide the previous command before revealing the other one. Serializing
   * updates keeps rapid tab/lifecycle changes from showing both commands.
   */
  syncPageMenuVisibility() {
    this._pageMenuUpdatePromise = this._pageMenuUpdatePromise.then(async () => {
      if (this._menuSetupLock) return;
      const needsRestore = this.pageTranslationStates.get(this.activePageTabId)?.needsRestore === true;
      const hiddenId = needsRestore ? PAGE_CONTEXT_TRANSLATE_ID : PAGE_CONTEXT_RESTORE_ID;
      const visibleId = needsRestore ? PAGE_CONTEXT_RESTORE_ID : PAGE_CONTEXT_TRANSLATE_ID;
      if (this.createdMenus.has(hiddenId)) await this.updateMenu(hiddenId, { visible: false });
      if (this.createdMenus.has(visibleId)) await this.updateMenu(visibleId, { visible: true });
    }).catch(error => logger.error('Failed to sync page context menu visibility:', error));
    return this._pageMenuUpdatePromise;
  }

  /**
   * Handle context menu click
   * @param {Object} info - Click information
   * @param {Object} tab - Tab information
   */
  async handleMenuClick(info, tab) {
    try {
      logger.info(`Context menu clicked: ${info.menuItemId}`);

      // --- Handle browser action menu clicks ---
      const isApiProviderClick = info.menuItemId.startsWith(
        API_PROVIDER_ITEM_ID_PREFIX
      );
      const isStaticActionClick = [
        ACTION_CONTEXT_MENU_PDF_ID,
        ACTION_CONTEXT_MENU_SUBTITLE_ID,
        ACTION_CONTEXT_MENU_OPTIONS_ID,
        ACTION_CONTEXT_MENU_SHORTCUTS_ID,
        HELP_MENU_ID,
      ].includes(info.menuItemId);

      // Deactivate select element mode when clicking on browser action menu items
      if (isApiProviderClick || isStaticActionClick) {
        await deactivateSelectElementModeInAllTabs();
      }

      // --- Handler for API Provider selection ---
      if (isApiProviderClick) {
        const newApiId = info.menuItemId.replace(API_PROVIDER_ITEM_ID_PREFIX, "");
        try {
          await storageManager.set({ TRANSLATION_API: newApiId });
          logger.info(`API Provider changed to: ${newApiId}`);
        } catch (e) {
          logger.error(`Error setting new API provider:`, e);
        }
        return; // Stop further processing
      }

      // --- Handle specific menu items ---
      switch (info.menuItemId) {
        case PAGE_CONTEXT_TRANSLATE_ID:
          await this._handlePageCommand(MessageActions.PAGE_TRANSLATE, tab);
          break;

        case PAGE_CONTEXT_RESTORE_ID:
          await this._handlePageCommand(MessageActions.PAGE_RESTORE, tab);
          break;

        case PAGE_CONTEXT_MENU_ID:
          await this._activateSelectElement(tab);
          break;

        case PAGE_CONTEXT_PDF_ID: {
          const linkUrl = info.linkUrl;
          if (linkUrl) {
            await openExtensionApp('pdf', { remoteUrl: linkUrl });
          }
          break;
        }

        case `${SCREEN_CAPTURE_MENU_ID}-page`:
        case `${SCREEN_CAPTURE_MENU_ID}-action`:
        case SCREEN_CAPTURE_MENU_ID: { // Keep original ID for backward compatibility during transitions
          const targetTab = tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          if (targetTab?.id) {
            const backgroundService = globalThis.backgroundService;
            if (backgroundService && backgroundService.messageHandler) {
              // Try both possible action names for compatibility
              const handler = backgroundService.messageHandler.getHandlerForMessage(MessageActions.START_SCREEN_CAPTURE) 
                           || backgroundService.messageHandler.getHandlerForMessage('startScreenCapture');
              
              if (handler) {
                logger.debug("Directly calling startScreenCapture handler from context menu");
                // Handlers expect (message, sender, sendResponse)
                await handler({
                  action: MessageActions.START_SCREEN_CAPTURE,
                  data: { tabId: targetTab.id, source: "context-menu" }
                }, { tab: targetTab }, (response) => {
                  logger.debug("Direct handler response:", response);
                });
              } else {
                logger.error("Start screen capture handler not found in background service");
              }
            } else {
              logger.error("Background service or message handler not available");
            }
          }
          break;
        }

        case ACTION_TRANSLATE_ELEMENT_ID: {
          const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
          await this._activateSelectElement(activeTab);
          break;
        }

        case ACTION_CONTEXT_MENU_PDF_ID:
          await openExtensionApp('pdf');
          break;

        case ACTION_CONTEXT_MENU_SUBTITLE_ID:
          await openExtensionApp('subtitle');
          break;

        case ACTION_CONTEXT_MENU_OPTIONS_ID:
          await focusOrCreateTab(browser.runtime.getURL("src/html/options.html"));
          break;

        case ACTION_CONTEXT_MENU_SHORTCUTS_ID:
          try {
            let browserName = null;
            if (typeof browser.runtime?.getBrowserInfo === 'function') {
              try {
                browserName = (await browser.runtime.getBrowserInfo())?.name;
              } catch (browserInfoError) {
                logger.debug("Browser info not available, using default Chrome shortcuts URL", browserInfoError);
              }
            }

            if (browserName === "Firefox") {
              if (typeof browser.commands?.openShortcutSettings === 'function') {
                try {
                  await browser.commands.openShortcutSettings();
                } catch (error) {
                  logger.error("Could not open Firefox shortcut settings:", error);
                }
              } else {
                logger.error("Firefox shortcut settings API unavailable");
              }
            } else {
              await browser.tabs.create({ url: "chrome://extensions/shortcuts" });
            }
          } catch (e) {
            if (ExtensionContextManager.isContextError(e)) {
              ExtensionContextManager.handleContextError(e, 'context-menu:open-shortcuts');
            } else {
              logger.error("Could not open shortcuts page:", e);
            }
          }
          break;

        case HELP_MENU_ID: {
          const message = {
            action: MessageActions.OPEN_OPTIONS_PAGE,
            data: { anchor: 'help' }
          };
          const backgroundService = globalThis.backgroundService;
          const handler = backgroundService?.messageHandler?.getHandlerForMessage?.(
            MessageActions.OPEN_OPTIONS_PAGE
          );

          if (handler) {
            await handler(message, { tab: null }, () => {});
          } else {
            await browser.runtime.sendMessage(message);
          }
          break;
        }


        default:
          logger.warn(`Unhandled context menu: ${info.menuItemId}`);
      }
    } catch (error) {
      logger.error("Context menu click handler failed:", error);
    }
  }


  /**
   * Register storage change listener to sync context menus
   */
  registerStorageListener() {
    if (this.storageListener || !browser?.storage?.onChanged) return;

    if (browser?.storage?.onChanged) {
      const storageListener = async (changes, areaName) => {
        try {
          if (areaName === "local") {
            // 1. DATA INTEGRITY CHECK: 
            // If Debug Mode is disabled while Mock provider is selected, revert to default.
            if (changes.DEBUG_MODE && changes.DEBUG_MODE.newValue === false) {
              const settings = await storageManager.get(['TRANSLATION_API']);
              if (settings.TRANSLATION_API === 'mock') {
                const defaultApi = CONFIG.TRANSLATION_API || 'googlev2';
                
                await storageManager.set({ TRANSLATION_API: defaultApi });
                logger.info(`Background Integrity: Debug mode disabled while Mock was active. Reverted to ${defaultApi}`);
                
                // Note: This set() will trigger this listener again, 
                // but the 'if' above won't match, preventing infinite loops.
                return; 
              }
            }

            // 2. UI SYNC:
            // Rebuild menus if relevant settings changed
            const relevantKeys = [
              'TRANSLATION_API', 
              'TRANSLATE_WITH_SELECT_ELEMENT', 
              'WHOLE_PAGE_TRANSLATION_ENABLED',
              'ENABLE_SCREEN_CAPTURE',
              'MODE_PROVIDERS', 
              'EXTENSION_ENABLED', 
              'DEBUG_MODE', 
              'CONTEXT_MENU_VISIBILITY',
              'HIDDEN_PROVIDERS'
            ];
            
            const isRelevantChange = Object.keys(changes).some(key => 
              relevantKeys.includes(key) || 
              key.endsWith('_API_KEY') ||
              key.endsWith('_API_URL') ||
              key.endsWith('_API_MODEL')
            );

            if (isRelevantChange) {
              logger.info(
                "Relevant settings changed in storage. Rebuilding context menus for synchronization."
              );
              await this.setupDefaultMenus();
            }
          }
        } catch (error) {
          logger.error("Failed to rebuild context menus after storage change:", error);
        }
      };
      browser.storage.onChanged.addListener(storageListener);
      this.storageListener = storageListener;
      logger.info("Storage change listener registered");
    }
  }

  /**
   * Check if context menu manager is available
   * @returns {boolean}
   */
  isAvailable() {
    return this.initialized && !!this.browser?.contextMenus;
  }

  /**
   * Get list of created menu IDs
   * @returns {Array<string>}
   */
  getCreatedMenus() {
    return Array.from(this.createdMenus);
  }

  /**
   * Get debug information
   * @returns {Object}
   */
  getDebugInfo() {
    return {
      type: "context-menu",
      initialized: this.initialized,
      createdMenus: this.getCreatedMenus(),
      hasContextMenusAPI: !!this.browser?.contextMenus,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    logger.info("Cleaning up context menu manager");

    try {
      this.removePageMenuListeners();
      this._pageMenuRefreshVersion++;
      this.activePageTabId = null;
      this.pageTranslationStates.clear();
      await this._pageMenuUpdatePromise;
      await this.clearAllMenus();
      
      // Remove storage listener
      if (this.storageListener && browser?.storage?.onChanged) {
        browser.storage.onChanged.removeListener(this.storageListener);
        this.storageListener = null;
      }
    } catch (error) {
      logger.error("Error during context menu cleanup:", error);
    }

    this.initialized = false;
    this.createdMenus.clear();
    
    super.cleanup();
  }
}

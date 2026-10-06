# Options Page Documentation

## Overview

The **Options Page** is the central configuration hub for the Translate-It extension. It allows users to customize translation providers, languages, appearance, and behavioral settings. The page is built using a modern Vue.js architecture with a clear separation between state management and UI components.

## Settings Application Logic

One of the most important aspects of the Options page is how settings are applied and persisted. The system uses a dual-approach strategy:

### 1. Instant Application (No Save Required)
Certain settings take effect immediately the moment the user interacts with the control. These are typically UI-related settings that provide instant visual feedback.

- **Theme Switching**: Switching between Light, Dark, or Auto mode.
- **UI Language (Localization)**: Changing the interface language of the extension.

**Technical Implementation:**
These settings use the `updateSettingAndPersist` method in the `settings` store, which updates the local state and immediately calls `storageManager.set()` to persist the change.

### 2. Save-Triggered Application (Manual Save Required)
Most other configurations are buffered in the local state and require the user to explicitly click the **"Save"** button at the bottom of the navigation sidebar to be permanently applied and synchronized across tabs.

- **Translation Providers**: API keys, model selections, and provider-specific URLs.
- **Languages**: Source and Target language preferences.
- **Activation Modes**: Enabling/disabling Select Element, Text Selection, or Whole Page translation.
- **Advanced Settings**: Proxy configurations, exclusion lists, and debug mode.
- **Prompt Templates**: Custom templates for AI-based translation providers.

**Technical Implementation:**
These settings use the `updateSettingLocally` method, which only modifies the reactive `settings` object in the Pinia store. The changes are only written to `browser.storage.local` when the `saveAllSettings` action is called by the Save button.

## Architecture

### Store: `settings.js`
The `useSettingsStore` (Pinia) is the single source of truth for all settings.
- **`settings`**: A reactive object containing all configuration keys.
- **`loadSettings()`**: Fetches data from storage on initialization.
- **`saveAllSettings()`**: Persists all current local changes to storage.
- **`resetSettings()`**: Restores all settings to their default values.

### Layout: `OptionsLayout.vue`
Coordinates the overall structure, including:
- **`OptionsSidebar.vue`**: Navigation links.
- **`OptionsNavigation.vue`**: Contains the **Save Button** and status messages.
- **`router-view`**: Dynamically loads the selected tab component.

### Tabs
The configuration is divided into logical tabs:
- **Languages**: Source/Target language and primary provider selection.
- **Appearance**: Theme, font family, and font size settings.
- **Activation**: Toggle specific features (Select Element, Page Translation, etc.).
- **Providers**: Detailed configuration for each API (Gemini, OpenAI, etc.).
- **Prompt**: Custom AI prompt templates.
- **Advance**: Exclusion sites, Proxy settings, and Debug mode.
- **Import/Export**: Backup and restore settings via JSON.

## Developer Guide: Adding a New Setting

To ensure a new configuration key is properly tracked, persisted, and synchronized across the extension, follow this checklist:

### 1. Define the Default Value
Add your new key and its default value to the `CONFIG` object in `src/shared/config/config.js`.

Adding a key to `CONFIG` **does not** automatically make it a persisted setting. `CONFIG` owns default values only; CONFIG-only runtime constants are never stored in browser storage. A persisted setting therefore requires two registrations: its default value in `CONFIG`, and its membership in `getPersistedDefaultSettings()`.

### 2. Register in the Canonical Persisted Schema
Add the key to `getPersistedDefaultSettings()` in `src/shared/config/settingsDefaults.js`.
This is the single authority for persisted key membership and drives fresh install, reset, import defaults, and migration fill.
**CRITICAL:** If you skip this step, the setting will not be persisted and will be lost on extension reload.

### 3. Store-Only Runtime State
If the value is runtime state and not a persisted setting (e.g., `translationHistory`), it does **not** belong in `getPersistedDefaultSettings()`. Initialize it separately in the settings store and manage its lifecycle independently.

### 4. Create an Async Getter (Optional but Recommended)
Add an async getter function in `src/shared/config/config.js` (e.g., `export const getMySettingAsync = ...`).
*Why:* This allows background scripts and non-Vue logic to access the setting reliably using the `StorageManager`.

### 5. Implement the UI Control
Add the appropriate input or toggle in the relevant tab component (under `src/components/feature/options/tabs/`).
- Use **`updateSettingLocally(key, value)`** for most settings (requires clicking the "Save" button).
- Use **`updateSettingAndPersist(key, value)`** for settings that should take effect instantly (e.g., UI theme, language).

---

## Highlighting & Spotlight System

The Options page features a **Spotlight System** designed to direct user attention to specific settings or sections via deep-linking. This is particularly useful for linking from the `Changelog` or `Help` pages directly to a relevant configuration.

### How it Works
The system is managed centrally and follows this sequence:
1.  **Detection**: The `OptionsLayout.vue` watches for a `highlight` query parameter in the URL (e.g., `#/languages?highlight=BILINGUAL_SECTION`).
2.  **Reveal**: Exact highlight targets may have declarative reveal descriptors for an accordion or generic non-accordion UI. The manager emits `options-reveal-intent` with the string intent as its detail for generic UI; the owning tab/component handles that intent and opens its own drawer, modal, or panel. Existing accordions continue to use `options-reveal-accordion` with a raw string detail.
3.  **Target ready**: After the reveal, the manager waits up to 1500ms for the target to become available.
4.  **Scroll and highlight**: The page smoothly scrolls the target to the center of the viewport and applies the `ti-highlight-pulse` animation.
5.  **Cleanup**: The `highlight` parameter is automatically removed from the URL as the target-ready/scroll/highlight pipeline completes, keeping the browser history clean.

### Developer Guide: Highlighting an Element

To make an element or a section "highlightable," follow these steps:

#### 1. Assign a Unique ID
Add a unique `id` attribute to the target Vue component or HTML element. 
**Convention**: For individual settings, use the setting key name (e.g., `id="SHOW_DESKTOP_FAB"`). For sections, use a descriptive suffix (e.g., `id="PROXY_SECTION"`, `id="TTS_VOICES_TUNING_SECTION"`, `id="PROMPT_SELECTOR_SECTION"`, `id="PROMPT_PREVIEW_SECTION"`).

```html
<BaseCheckbox
  id="MY_SETTING_KEY"
  v-model="mySetting"
  label="Custom Setting"
/>
```

#### 2. Configure Reveal Logic (When Needed)
If the element needs a reveal before it can be highlighted, provide a declarative reveal descriptor for its exact target. For an element inside a `BaseAccordion`, ensure the following:
-   **Global Rules**: Add a rule to the `globalReveal` function in `src/apps/options/composables/useHighlightManager.js` so the system knows which accordion to open based on the ID prefix.
-   **Tab Listener**: Ensure the Tab component listens for `options-reveal-accordion` and updates its internal `activeAccordion` state. This event retains its raw string detail for existing accordion handling.

For a generic non-accordion UI such as a drawer, modal, or panel, use an intent descriptor and have the owning tab/component listen for `options-reveal-intent` and open that UI itself. Its detail is the intent string.

```javascript
// Example accordion reveal rule in useHighlightManager.js
if (id.startsWith('MY_PREFIX_')) return 'my-accordion-name';
```

#### 3. Create the Link
Use the following URL structure to trigger the highlight:
`options.html#/{tab_name}?highlight={element_id}`

For example, `options.html#/activation?highlight=WHOLE_PAGE_AUTO_TRANSLATE_RULES` reveals the existing rules accordion and highlights its target. `options.html#/activation?highlight=WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER` opens the rules drawer through its owning component and highlights that target. Both use the existing `highlight` parameter and target-ready/scroll/highlight/query-cleanup pipeline.

---

## Import/Export Mechanism

The extension provides a robust way to backup and restore settings via the **Import/Export** tab. This process is not a simple JSON dump; it involves security and integrity checks:

-   **Exporting**: When `exportSettings()` is called, it uses `SecureStorage` to encrypt sensitive data (like API keys) and excludes large, non-essential data (like translation history).
-   **Importing**: When a user uploads a settings file, `importSettings()` performs:
    1.  **Decryption**: Validates and decrypts API keys.
    2.  **Merging**: Combines imported values with current defaults to prevent missing keys.
    3.  **Migration**: Automatically runs the migration system to ensure the imported file is compatible with the current version of the extension.

## Settings Migration System

Located in `src/shared/config/settingsMigrations.js`, this system ensures that user settings remain valid across different versions of the extension.

### When does it run?
1.  **On Update**: Triggered automatically when the extension is updated to a new version.
2.  **On Import**: Triggered after a user imports a settings file.

### Key Responsibilities:
-   **Structure Alignment**: Remaps old configuration keys to new formats (e.g., migrating `select_element` to the new `MessageContexts` format).
-   **Default Filling**: Adds any newly introduced settings from the canonical persisted settings schema (`getPersistedDefaultSettings()`) that are missing in the user's current storage.
-   **Model List Updates**: Synchronizes AI model lists (Gemini, OpenAI, etc.) while preserving the user's specific model selection if it still exists.
-   **Legacy Conversions**: Handles complex migrations like moving from a single `API_KEY` to the multi-key `GEMINI_API_KEY` system.

**Developer Note:** If you rename a setting or change its data type, you **must** add a migration rule in `src/shared/config/settingsMigrations.js` to prevent breaking existing users' setups.

---

## UI/UX Considerations

- **RTL Support**: The Options page fully supports RTL (Right-to-Left) layouts based on the selected UI language.
- **Transitions**: Theme and Language changes utilize the `useUITransition` composable for smooth visual effects (View Transitions API).
- **Responsive Design**: The layout adapts to Tablet and Mobile screens, switching the vertical sidebar to a horizontal scrollable navigation.

---

**Last Updated**: April 2026

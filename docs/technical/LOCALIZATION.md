# Localization (i18n) Contribution Guide

## Overview

Translate-It uses a **Manifest-Driven Architecture** for localization. Instead of manually managing multiple JSON files, all supported UI languages are defined in a central manifest. Automated scripts handle synchronization and consistency across the project.

This guide covers **UI localization only**. Runtime text language detection is documented separately in **[Language Detection](LANGUAGE_DETECTION.md)**.

## Architecture Components

1.  **LocaleManifest (`src/shared/config/LocaleManifest.js`)**: The single source of truth for all supported UI languages.
2.  **Chrome i18n Folders (`src/_locales/`)**: Standard browser extension localization folders (e.g., `src/_locales/en/messages.json`).
3.  **Automated Scripts**: Tools for keeping all language files in sync with the primary English (EN) reference.

---

## Workflow: Adding a New Language

Follow these 4 steps to add a new language to the extension:

### 1. Update the Manifest (`src/shared/config/LocaleManifest.js`)
Add your language to the `UI_LOCALES` array. This automatically enables the language in the Options UI, Sidebar, and initializes the dynamic mapping system.

```javascript
{ 
  code: 'de',          // ISO 639-1 language code
  name: 'Deutsch',     // Native name of the language
  flag: 'de',          // Flag icon name (references icons/flags/de.svg)
  dir: 'ltr',          // 'ltr' (Left-to-Right) or 'rtl' (Right-to-Left)
  aliases: ['Deutsch', 'German', 'de'] // Used for dynamic mapping (English/Native/Code)
}
```
*Note: The `aliases` field is critical as it's used to dynamically generate the `UI_LOCALE_TO_CODE_MAP`, ensuring the language is recognized correctly across all extension services.*

### 2. Synchronize Files
Run the synchronization script to automatically create the new folder and populate it with all required keys from the English reference.

```bash
pnpm i18n:sync:fix
```
*This will create `src/_locales/de/messages.json` with all keys marked as `UNTRANSLATED`.*

### 3. Translate the Content
Open `src/_locales/[code]/messages.json` and replace the English messages with your translations.

*   **Variables**: Keep placeholders like `{appName}` or `{version}` intact.
*   **Direction**: The extension automatically handles layout flipping (RTL/LTR) based on the `dir` property in the manifest.

### 4. Verify and Clean Up
Run the check script to ensure there are no missing or orphaned keys, and purge the temporary notes after translation is complete for your specific language.

```bash
pnpm i18n:check:fix
pnpm i18n:purge de    # Replace 'de' with your language code
```

---

## Best Practices & Standards

### 1. The English Reference
Always add new keys to `src/_locales/en/messages.json` first. The `i18n:sync` script uses English as the master template.

### 2. UI Component Localization
Do not hardcode user-facing strings when localization is required. Follow the existing localization pattern of the component or area you are working in. `useUnifiedI18n` is the shared bridge when unified/legacy behavior is needed; direct `useI18n` from `vue-i18n` is also used in current Vue components:

```javascript
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n';
const { t } = useUnifiedI18n();

// Usage in template
<span>{{ t('save_settings_button') }}</span>
```

### 3. Language-Specific Punctuation
Respect regional standards. For example:
*   **Japanese**: Use the full-width period (`。`) instead of the standard dot (`.`).
*   **Farsi/Arabic**: Ensure numbers and punctuation are suitable for RTL flow.

### 4. Protected Prefixes
Our maintenance scripts automatically protect dynamic keys. `scripts/localization/check-i18n.cjs` is the source of truth for protected/safe prefixes and keys — check it before adding or removing protected patterns. As examples, prefixes such as `provider_`, `api_`, and `theme_` are skipped during unused-key detection, so avoid using them for general UI strings.

---

## Maintenance Commands

| Command | Description |
| :--- | :--- |
| `pnpm i18n:sync:status` | Checks if all languages have the same keys as English. |
| `pnpm i18n:sync:fix` | Adds missing keys to all languages and sorts them by English reference. |
| `pnpm i18n:check` | Identifies orphaned keys that are no longer used in the code. |
| `pnpm i18n:check:fix` | Removes unused keys from English and syncs all languages automatically. |
| `pnpm i18n:purge <locale>` | Removes all "note": "UNTRANSLATED" fields for a specific language. |

---

**Last Updated**: October 2026

#### Unreleased

##### Added

- Added whole-page translation to the context menu. (by [@H4M4CHi-ttr](https://github.com/H4M4CHi-ttr))

##### Fixed

- Fixed Gemini translation in `Popup`, `Sidepanel`, and `Text Selection`.

##### Changed

- The Auto Page Translation star in `Popup`, Desktop FAB, and Mobile now lets you choose between **This Page** and **This Site** ([#156](https://github.com/Translate-It-App/Translate-It/issues/156)).

---

#### v1.20.0 – Released on September 30, 2026

##### Added

- Added **Live Dubbing** to the Popup on Chrome with Gemini Live and OpenAI Realtime, including volume controls and bilingual subtitles.
- Added [**Requesty.ai**](#/providers?highlight=REQUESTY_API_KEY) as a translation provider. (by [@Thibaultjaigu](https://github.com/Thibaultjaigu))

##### Fixed

- Improved `Select Element` highlight targeting on nested and dynamic page content.

---

#### v1.19.1 – Released on September 11, 2026

##### Added

- Added a [Compatibility Check](#/providers?highlight=CUSTOM_API_COMPATIBILITY_CHECK) for OpenAI-compatible providers in Settings.

##### Fixed

- Fixed `Field` translation to translate and replace only the selected text instead of the entire field ([#201](https://github.com/Translate-It-App/Translate-It/issues/201)).
- Fixed `Select Element` translation failures with OpenAI-compatible local LLM providers such as LM Studio ([#164](https://github.com/Translate-It-App/Translate-It/issues/164)).
- Fixed Settings persistence issues, including Prompt Template selections not being saved correctly ([#202](https://github.com/Translate-It-App/Translate-It/issues/202)).

---

#### v1.19.0 – Released on September 06, 2026

##### Added

- Added font customization for [Select Element](#/appearance?highlight=SELECT_ELEMENT_USE_TRANSLATION_FONT) and [Page Translation](#/appearance?highlight=WHOLE_PAGE_USE_TRANSLATION_FONT) in the Settings page.
- `Popup` and `Sidepanel` now remember your last translation while the browser is open.

##### Changed

- Updated AI provider models.
- Changed the `Select Element` revert shortcut from `Esc` to **double `Esc`**.

##### Fixed

- Fixed various issues and improved the overall reliability of `Select Element`, including better compatibility with AI models with limited or no JSON support.
- Fixed various issues and improved the overall reliability of `Page Translation` and other translation features.

---

#### v1.18.0 – Released on August 01, 2026

##### Added

- Introduced [PDF Translator](#/about?highlight=PDF_TRANSLATOR) for translating PDF documents.

##### Fixed

- Improved `Select Element` translation performance and responsiveness, especially when processing large selections.
- Fixed WebAI conversation history behavior to provide more consistent and predictable translation results.

---

#### v1.17.1 – Released on June 11, 2026

##### Added

- Added [auto-translate rule](#/activation?highlight=WHOLE_PAGE_AUTO_TRANSLATE_RULES) toggle to both FAB Desktop, Mobile and Popup translation controls.
- Added the ability to set the current source and target languages as defaults directly from Popup, Sidepanel, and Mobile language selectors.
- Added modern Markdown rendering support for translation results and history entries, with improved dictionary formatting and pronunciation display.
- Added advanced [prompt customization](#/prompt?highlight=PROMPT_SELECTOR_SECTION) with support for Auto Translation, Subtitle Translation, prompt previews, and selected system translation wrappers.

---

#### v1.17.0 – Released on June 06, 2026

##### Added

- Added a new [Subtitle Translator](#/about?highlight=SUBTITLE_TRANSLATOR) tool for translating subtitle files
- Added new pronunciation accent and voice tuning options in the [Text-to-Speech Settings](#/tts?highlight=TTS_VOICES_TUNING_SECTION)
- Added a Text-to-Speech button when selecting text on webpages, along with new options to customize the visibility of the [translation button](#/activation?highlight=SHOW_TRANSLATE_ICON_IN_TOOLBAR) and [pronunciation button](#/activation?highlight=SHOW_TTS_ICON_IN_TOOLBAR)

##### Fixed

- Fixed an issue where the selected translation provider was not being saved correctly ([#133](https://github.com/Translate-It-App/Translate-It/issues/133))
- Fixed an sidebar/popup compatibility issue that prevented parts of the extension UI from working correctly ([#140](https://github.com/Translate-It-App/Translate-It/issues/140))
- Fixed `Vajehyab` dictionary lookups and related integration issues

---

#### v1.16.0 – Released on May 19, 2026

##### Added

- Added [Mouse on Hover Translation](#/activation?highlight=activation_group_mouse_hover) for instant, frictionless translation by simply hovering over text or containers
- Added customizable **Idle Opacity** and **Icon Size** for the [Quick Action Button (FAB)](#/activation?highlight=FAB_CUSTOMIZATION_SETTINGS)
- Added an option to [hide translation providers](#/providers?highlight=HIDDEN_PROVIDERS_CHECKBOX) you don’t use to keep the interface cleaner

- Added the ability to choose a translation provider for [OCR translations](#/ocr?highlight=OCR_PROVIDER_SELECTOR)
- Improved dictionary results with more detailed information such as pronunciations, synonyms, definitions, and examples, along with new [Dictionary Display Options](#/languages?highlight=DICTIONARY_DISPLAY_OPTIONS) to customize which sections are displayed

---

#### v1.15.0 – Released on May 11, 2026

##### Added

- Added [Screen Capture (OCR)](#/ocr) to extract and translate text from any visual area, including images and videos, with full offline support ([#120](https://github.com/Translate-It-App/Translate-It/pull/120))
- Added **Pin** and **Dock** capabilities with **Edge Snapping**: You can now pin the window to stay open or drag it to the screen edges to dock it as a persistent, resizable sidebar that updates instantly with new selections ([#121](https://github.com/Translate-It-App/Translate-It/pull/121))

##### Changed

- Improved overall performance and responsiveness

---

#### v1.14.1 – Released on May 09, 2026

##### Added

- Added Text-to-Speech support for original text and improved the mobile experience with better text selection and floating button interactions ([#116](https://github.com/Translate-It-App/Translate-It/issues/116))

##### Fixed

- Fixed an issue where the translation window could close unexpectedly when dragging it quickly ([#113](https://github.com/Translate-It-App/Translate-It/issues/113))
- Fixed issues with `Page Translation` and `Hover Original Previews` on large pages, while reducing unnecessary translations and token usage ([#114](https://github.com/Translate-It-App/Translate-It/issues/114))
- Improved the mobile experience by preventing accidental text deselection, improving floating button interactions, and adding Text-to-Speech support for original text ([#115](https://github.com/Translate-It-App/Translate-It/issues/115))
- Fixed issues where `Select Element` mode could accidentally open links instead of translating content on some websites (e.g. Twitter/X) ([#117](https://github.com/Translate-It-App/Translate-It/issues/117), [#119](https://github.com/Translate-It-App/Translate-It/issues/119))

##### Changed

- Improved translation filtering to reduce unnecessary token usage and better protect technical content such as links, emails, addresses, and code-related text ([#118](https://github.com/Translate-It-App/Translate-It/issues/118))

---

#### v1.14.0 – Released on May 07, 2026

##### Added

- Text-to-Speech can now read very long translations smoothly without stopping
- Added the [Vajehyab](#/languages?highlight=DICTIONARY_SECTION) Persian dictionary for better dictionary results ([vajehyab.com](https://vajehyab.com))
- Added a [Prompt Preview](#/prompt?highlight=PROMPT_PREVIEW_BUTTON) feature in the Prompt Settings tab
- Added a [warning notification](#/activation?highlight=WHOLE_PAGE_TOKEN_WARNING_HIDDEN) before starting `Page Translation` with paid providers.
- Added a [shortcut management](#/activation?highlight=SELECT_ELEMENT_CONFIGURE_SHORTCUTS) button for the Select Element feature in Settings

##### Fixed

- Fixed an issue where the translation window would not open when the `Require Ctrl` setting was enabled
- Fixed issues where some translation modes were not using the correct provider
- Fixed cases where `Page Translation` stopped working after an error
- Fixed formatting problems in translated text, including missing Persian half-spaces (نیم‌فاصله) and extra line breaks
- Fixed several stability and reliability issues

##### Changed

- Improved dictionary provider selection in Settings
- Improved provider selection to only show available and configured providers
- Improved Settings validation before saving
- Improved popup performance

---

#### v1.13.0 – Released on May 03, 2026

##### Fixed

- **[#102](https://github.com/Translate-It-App/Translate-It/issues/102)**: Resolved timeout issues affecting popup, side panel, and window contexts
- Fixed Dictionary Mode for traditional providers (e.g., Google Translate)
- Addressed various major and minor bugs

---

#### v1.12.1 – Released on April 30, 2026

##### Fixed

- **[#102](https://github.com/Translate-It-App/Translate-It/issues/102)**: Fixed translation issues in popup, side panel, and window contexts
- Fixed minor bugs
- Fixed dictionary issues for AI providers

---

#### v1.12.0 – Released on April 29, 2026

##### Added

- Added an [option](#/activation?highlight=SELECT_ELEMENT_SHOW_ORIGINAL_ON_HOVER) to show the original text on hover via `Select Element`.

##### Fixed

- Fixed issues in language detection
- Fixed an issue where canceling translation in `Select Element` mode did not work properly
- Fixed issues with `Optimization Level` settings

##### Changed

- Improved Bing provider performance

---

#### v1.11.0 – Released on April 26, 2026

##### Added

- Added an option to toggle `Select Element` in the context menu via [Activation](#/activation?highlight=PAGE_CONTEXT_SELECT_ELEMENT) settings.

##### Fixed

- Fixed various UI issues and improved visual consistency
- Resolved issues in `Page Translation` where certain text segments were intermittently skipped or left untranslated

---

#### v1.10.0 – Released on April 25, 2026

##### Added

- Added a persistent, vertically draggable [Desktop FAB (Floating Action Button)](#/activation?highlight=FIELDSET_FAB) for quick access to `Select Element` and `Page Translation` with smart-fading and real-time status tracking
- Added comprehensive `Mobile & Touchscreen Support` featuring a native-like `In-Page Bottom Sheet` architecture with smooth gesture controls (swipe-to-expand/dismiss) for mobile browsers (Firefox Android, Kiwi, Lemur)
- Added [Optimization Levels](#/providers?highlight=OPTIMIZATION_LEVELS_SECTION) to fine-tune translation strategies between speed and cost (Economy, Balanced, Turbo/Fast) for both AI and traditional providers
- Added [Microsoft Edge TTS (Neural)](#/tts?highlight=TTS_ENGINE_SECTION) engine support for high-quality, natural-sounding speech synthesis
- Added advanced [Text-to-Speech Settings](#/tts?highlight=TTS_SETTINGS_SECTION), including Smart Language Detection and automatic fallback to similar languages (e.g., Arabic for Persian)
- Added [Bilingual Translation](#/languages?highlight=BILINGUAL_SECTION) (Swap Language) support across all translation modes (Selection, Field, Select Element, Page) with independent toggles
- Added [Language Detection Preferences](#/languages?highlight=DETECTION_SECTION) to prioritize specific languages within script families (e.g., Persian vs. Arabic, Simplified vs. Traditional Chinese, Hindi vs. Marathi)
- Added [AI Optimization](#/languages?highlight=AI_OPT_SECTION) features for AI providers, including `Smart Context` for better accuracy and `Conversation History` for consistent terminology
- Added new [Whole Page Translation](#/activation?highlight=FIELDSET_WHOLE_PAGE) triggers: "On Scroll Stop" (with customizable delay) and "Fluid Translation" during scroll
- Added support for `Iframe` content translation across all translation modules
- Added comprehensive support for Local Files (`file:///` URLs) in all translation modes
- Added a toggle to enable or disable [Translation History](#/advance?highlight=TRANSLATION_HISTORY_SECTION) in the Advanced settings
- Added a granular [Debug Mode](#/advance?highlight=DEBUG_MODE_SECTION) with component-level logging controls for advanced troubleshooting and performance monitoring

##### 

---

#### v1.9.0 – Released on March 20, 2026

##### Added

- Added Full `Page Translation` engine for real-time translation of entire web pages
- Added [Provider Management](#/activation) settings to toggle and prioritize translation engines
- Added **Microsoft Translator** and **Lingva Translate** as new translation providers
- Added `Sync Page Translation` and `Sync Select Element` toggles to the provider dropdown for ephemeral synchronization
- Added `History Export` feature to the side panel (anki, csv, json)
- Added a `Provider Selector` to floating translation windows for switching providers
- Added Japanese UI support (by [@monta-gh](https://github.com/monta-gh))

##### Fixed

- Fixed stability and detection accuracy issues in `Select Element` mode
- Fixed phonetic issues in **Google TTS** for Japanese, Chinese, Korean, Russian, Hebrew, and European languages
- Fixed UI regressions and improved cross-browser stability

##### Changed

- Improved `Select Element` logic for better DOM context preservation and reduced API token usage
- Modernized UI/UX layout for a more streamlined workflow
- Updated the copy button to perform a clean text copy without Markdown formatting

---

#### v1.8.0 – Released on January 06, 2026

##### Added

- Added [Multiple API Keys Support](#/providers) for all API-based providers. You can now enter multiple API keys per provider (one per line), and the extension will automatically failover to the next key if one reaches its quota limit or becomes invalid. Working keys are automatically promoted to the top for better performance. Use the "Test Keys" button to validate all keys at once.

##### Fixed

- Fixed several minor issues

---

#### v1.7.0 – Released on January 03, 2026

##### Added

- Added `DeepL` translation provider with support for Free/Pro API tiers
- Updated providers for new models (Gemini 3, Gemini 2.5)

##### Fixed

- Fixed the `Revert` issue after using `Select Element`


##### Changed

- Merged `API Settings` tab into [Providers](#/providers) tab for better UX

---

#### v1.6.0 – Released on December 31, 2025

##### Fixed

- Fixed Select Element display direction for RTL languages such as Persian, Arabic, Hebrew, and others
- Improved Select Element for CJK languages (Chinese, Japanese, Korean)
- Improved Select Element for Eastern European languages like Russian
- Fixed various minor issues

##### Changed

- **[#88](https://github.com/Translate-It-App/Translate-It/issues/88)**: Changed default macOS shortcut for Select Element to `Option+Shift+S`

---

#### v1.5.1 – Released on December 12, 2025

##### Fixed

- **[#87](https://github.com/Translate-It-App/Translate-It/issues/87)**: Fixed an issue where validation errors (like missing API keys) incorrectly triggered the circuit breaker, causing false quota exceeded errors for Gemini and other providers

---

#### v1.5.0 – Released on December 09, 2025

##### Added

- Made **[keyboard shortcuts](#/activation)** configurable for text field translation

##### Fixed

- **[#84](https://github.com/Translate-It-App/Translate-It/issues/84)**: Enhanced handling of unknown errors

##### Changed

- Enabled **[debug logs](#/advance)** for troubleshooting in production environment

---

#### v1.4.11 – Released on November 25, 2025

##### Fixed

- Enhanced sidepanel language controls with responsive layout
- Fixed various issues in Firefox
- Fixed minor issues

##### Changed

- Changed default macOS shortcut to Command+A for Select Element activation
- Disabled `Thinking Mode` by default for Gemini models to improve translation speed

---

#### v1.4.10 – Released on November 23, 2025

##### Added

- **Local File Support**: Added support for translating content from local files (`file:///` URLs)

##### Fixed

- **Enhanced Floating Window**: Improved floating window display and performance for translation results
- **Enhanced Original Text TTS**: Added visual indicators and tooltips for better discoverability of original text pronunciation in floating windows
- **Select Element Improvements**: Enhanced element selection functionality and reliability
- Removed caching system from Select Element for better performance and accuracy

##### Changed

- Changed default macOS keyboard shortcut to `Option+A`

---

#### v1.4.8 – Released on November 10, 2025

##### Fixed

- **Dark Mode Action Toolbar**: Fixed visibility issues with action buttons (copy, paste, TTS) when the system is in dark mode

##### Added

- Added example URL text below the API URL field in [Options page > Custom API](#/providers) settings for better user guidance

---

#### v1.4.7 – Released on November 01, 2025

##### Fixed

- **[#71](https://github.com/Translate-It-App/Translate-It/issues/71)**: Fixed an issue with keyboard shortcuts support.
- Fixed issues with context menu items (Useful Help and Keyboard Shortcut).

---

#### v1.4.6 – Released on November 01, 2025

##### Fixed

- Fixed options page opening issue.

---

#### v1.4.4 – Released on October 12, 2025

##### Added

- The translation icon now automatically hides when text is entered in a textbox

##### Fixed

- **[#69](https://github.com/Translate-It-App/Translate-It/issues/69)**: Fixed an issue where the selected text could become deselected unexpectedly

---

#### v1.4.3 – Released on October 09, 2025

##### Fixed

- Fixed Exclusion feature not working properly
- Fixed translation icon display issue with double-click on text fields in iframe
- Fixed text deselection issue when using `Shift+Click`
- Fixed delay when clicking outside text fields to dismiss translation icon
- Improved icon responsiveness for faster dismissal while keeping scroll behavior unchanged
- **[#66](https://github.com/Translate-It-App/Translate-It/issues/66)**: Fixed text field deactivation issue

---

#### v1.4.2 – Released on October 06, 2025

##### Fixed

- Fixed console logs appearing in production environment
- Fixed icon display position in text fields

---

#### v1.4.0 – Released on October 04, 2025

##### Added

- Support for [Triple-Click](#/activation)

##### Fixed

- Dynamic display issue of provider icons in Chrome
- Improved icon display in text fields

##### Changed

- Optimized core architecture

---

#### v1.3.2 – Released on September 25, 2025

##### Fixed

- Fixed issue where the floating window was not displayed
- Fixed issue with dictionary mode in the floating window

---

#### v1.3.0 – Released on September  25, 2025

##### Added

- Added option to enable or disable selection text in text fields

##### Fixed

- Fixed issue where translated text did not appear in the floating window when using dark theme
- **[#66](https://github.com/Translate-It-App/Translate-It/issues/66)**: Fixed text field deactivation issue

---

#### v1.2.0 – Released on September 19, 2025

##### Added

- **Proxy Support**: Added proxy configuration support in [Settings > Advanced Tab > Proxy Settings](#/advance) to enable access to translation services with geographic restrictions

##### Fixed

- **Translation Status Notification**: Fixed issue where `Translating...` notification would remain stuck when text field translation failed due to text extraction errors or background service failures
- **[#59](https://github.com/Translate-It-App/Translate-It/issues/59)**: Fixed issue where prompt changes from the recent update were not being applied
- **[#65](https://github.com/Translate-It-App/Translate-It/issues/65)**: Fixed icon display issue when selecting text in advanced fields via drag, and resolved CSS injection problem.

---

#### v1.1.0 – Released on September 16, 2025

##### Added

- Scroll support for long translations in the floating window

##### Fixed

- Fixed styles and UI

---

#### v1.0.0 – Released on September 15, 2025


##### Added

- **Dynamic Extension Icon**: The extension icon now changes to match the selected translation provider
- **Custom Fonts for Translations**: Users can now choose the font used to display translations. ([Appearance](#/appearance))

##### Changed

- **Enhanced Notifications**: Added cancel functionality to Select Element Mode translations
- **Universal Translation History**: History now tracks all translation modes and is searchable in Side Panel
- **Removed YouTube Subtitles**: Experimental feature was removed due to low usage
- **Optimized Field Icons**: Translation icon now only appears in relevant fields (like editors), not all input fields. Keyboard shortcuts still work everywhere.

##### Fixed

- **CSP Issues**: Resolved Content Security Policy conflicts across all websites
- **Core Optimization**: Extension core rewritten for optimal resource usage with minimal overhead
- **Pronunciation Selection**: Pronunciation options are now properly selectable and functional

---

#### v0.9.5 – Released on July 26, 2025


##### Added

- Added `Microsoft Bing` as a translation provider
- Added `Yandex Translate` as a translation provider
- Added support for `Chrome Browser Translator` API as a translation provider (Chrome only)

##### Changed

- Hotfixed temporary disabling of the YouTube subtitle translation button due to visibility issue
- Fixed translation issues in input fields

##### Fixed

- Improved handling of user settings
- [#55](https://github.com/Translate-It-App/Translate-It/issues/55) [#53](https://github.com/Translate-It-App/Translate-It/issues/53) Centralized icon management and improved icon cleanup, resolving `RESULT_CODE_KILLED_BAD_MESSAGE` errors and enhancing DOM organization.

---

#### v0.9.0 – Released on July 22, 2025


##### Added

- **Translation History in Side Panel**: Added comprehensive translation history tracking in the side panel for easy access to previous translations
- **Provider Selection in Side Panel**: Added ability to change translation providers directly from the side panel interface
- **Provider Selection in Popup**: Added translation provider selection dropdown to the popup interface
- **Dictionary Mode for Google Translate**: Implemented dictionary functionality for Google Translate with enhanced formatting and markdown rendering
- **Enhanced Floating Window**: Improved selection window with drag functionality and copy button for better user experience
- **Model Selection in Settings**: Added comprehensive model selection options in settings page for each translation provider (Gemini, OpenAI, OpenRouter, DeepSeek)
- **Secure AES-256 Import/Export**: Settings can now be exported and imported in AES-256 encrypted format, recoverable using a password
- **YouTube Subtitle Translation** (Experimental): Implemented real-time subtitle translation for YouTube videos with dual-language display
        - **Subtitle Icon Control**: Added a setting to independently control YouTube translation icon visibility

##### Changed

- **Enhanced XSS Security**: Implemented comprehensive XSS protection using filterXSS library across all translation outputs and UI components
- **Firefox Validation Compliance**: Achieved zero warnings in Firefox addon validation through full `addons-linter` compatibility testing
- **Chrome Extension Validation**: Achieved zero warnings in Chrome extension validation using complete `web-ext` compatibility testing
- **Improved Language Selection**: Fixed and enhanced language selection dropdowns in popup interface
- **Typography Improvements**: Enhanced font sizes and consistency across popup and side panel interfaces (14px→15px, unified font families)
- **Optimized AI Prompts**: Improved prompt templates, particularly dictionary prompts, for better translation accuracy and reduced AI confusion
- **Text Insertion Framework**: Enhanced text replacement system with multi-strategy approach and framework compatibility for React, Vue, Angular
- **Google Translate API Enhancements**: Fixed language detection and swapping logic, improved auto-detect functionality

##### Fixed

- **Text Field Insertion**: Resolved text insertion issues across more websites with enhanced framework compatibility system
- **Field Translation Settings**: Fixed incompatibility issues related to text field translation settings
- **Discord Text Insertion**: Resolved text placement issues specifically for Discord platform
- **Text Field Optimization**: Optimized text insertion mechanism for better reliability across various input field types
- **UI Bug Fixes**: Resolved various user interface inconsistencies and visual issues
- **TTS Character Limit**: Removed 200-character restriction from Google TTS functionality

---

#### v0.8.0 – Released on July 14, 2025


##### Added

- Introduced Side Panel support for display in the browser's sidebar

##### Changed

- Improved various UI and UX elements for a better user experience

---

#### v0.7.0 – Released on 12 July 2025


##### Added

- New feature: enhanced translation support in text fields, including copy and paste actions.
- Improved behavior for `Google Translate`: when source and target languages are the same, the system now auto-swaps them for a smoother user experience.
- Minor UI enhancements for better usability.

##### Fixed

- Fixed issues with localization strings.
- Fixed error in handling DeepSeek translation credits.
- Resolved various minor bugs.

##### Changed

- Added validation to prevent selecting the same source and target languages, with clearer user feedback.

---


#### v0.6.5 – Released on 02 July 2025


##### Added

- Added quick access to the API provider from the right-click context menu in the extension's action bar.

##### Changed

- Changed the default font in the Settings page and Popup to `Vazirmatn`.

##### Fixed

- Fixed an issue with in-field translation when using `Google Translate` as the provider.
- Fixed the issue where country flags were not displayed on Windows in the settings page.
- Fixed several minor bugs.

---

#### v0.6.0 – Released on 01 July 2025


##### Added

- Added support for **Google Translate** as a translation provider.
- Disabled the translation icon on the following websites to prevent interference with important content areas:

        `microsoftonline.com`
        `docs.microsoft.com`
        `cloud.microsoft`
        `acrobat.adobe.com`
        `docs.google.com`
        `onedrive.live.com`
        `canva.com/design`
        `dochub.com`
        `edit-document.pdffiller.com`
        `zoho.com`

##### Changed

- Disabled in-field translation icon in non-webpage contexts (e.g., internal browser pages or other extensions).

##### Fixed

- Fixed an issue where the translation icon appeared incorrectly when selecting text on first install.

---

#### v0.5.0 – Released on 30 June 2025


##### Added

- Added quick access options to the extension's context (right-click) menu via the action toolbar.
- Added a Help section to the Settings page.
- Added a Changelog section to the Settings page.

##### Changed

- Completely redesigned the Settings page for better clarity and usability.
- Changed the default model for OpenRouter to `gpt-4o`.

##### Fixed

- Added handling for newly occurring error scenarios with appropriate messaging.

---

#### v0.4.0 – Released on 29 June 2025


##### Added

- Added 'Translate with Select Element' mode to the right-click context menu for quick access.
- Added a keyboard shortcut to activate 'Select Element' mode.

##### Changed

- Improved the positioning and behavior of the in-field translation icon to be more intelligent and less intrusive.
- Enhanced translation prompts to yield more natural and human-like translations.
- Updated Light Theme

---

#### v0.3.6 – Released on 28 June 2025


##### Fixed
- Resolved issues on certain pages where the extension failed to function properly — particularly on platforms acting as software containers (e.g., frameworks like PhoneGap and similar).

##### Changed
- Improved the visual design of in-page messages for better readability and aesthetics.

---

#### v0.3.5 – Released on 27 June 2025


##### Fixed
- Resolved an error that occurred during page loading.

##### Changed
- Removed the default list of websites where the extension was previously disabled.

        accounts.google.com
        chrome.google.com/webstore
        addons.mozilla.org
        meet.google.com
        acrobat.adobe.com
        developer.chrome.com
        docs.google.com
        docs.microsoft.com
        developers.google.com
        ai.google.de

---

#### v0.3.3 - Released 26 June 2025


##### Added
- Add API key information and links for WebAI, OpenAI, OpenRouter, and DeepSeek on Options page.
- Add additional default excluded sites to the exclusion list:

        developer.chrome.com
        docs.microsoft.com
        docs.google.com
        meet.google.com
        developers.google.com
        ai.google.dev

##### Fixed
- Improve content script injection logic and add validation checks

---

#### v0.3.0 - Released 23 June 2025


##### Added

- **Added support for the DeepSeek API** as a new translation provider.
- **Added a "Custom" provider**, allowing users to connect to any OpenAI-compatible API endpoint (e.g., for local or self-hosted models).
- **Added an update notification** to inform users when a new version has been installed (Chromium-based only).

##### Changed

- **Overhauled the error handling system** to be more robust and provide clearer, generalized messages for all supported API providers.

##### Fixed

- The extension is now correctly disabled on non-web pages (e.g., `file://` or internal browser pages) to prevent errors.
- The in-field translation icon now appears more accurately on editable text fields and ignores non-text elements like checkboxes.
- A default list of excluded sites (e.g., `accounts.google.com`, web stores) has been added to prevent conflicts.

---

#### v0.2.2 - Released 21 June 2025


- New Feature: In addition to automatic translation on text selection, a new method has been added — a small icon now appears near the selected text. The translation is shown only after clicking this icon, allowing for a more deliberate and user-controlled experience.
- Minor UI improvements and stability enhancements.

---

#### v0.2.1 - Released 28 May 2025


- Improved Popup Behavior on Initial Inactivity
- Enhanced display of the last translation (now shown only in Dictionary mode)
- fix: resolve conflicts between theme styles and website styles (#43)

---

#### v0.2.0 - Released 26 May 2025


- Theme Support Added
    - Switch between Light, Dark, or Auto (system-based) themes to suit your visual preferences.
- Improved RTL Language Support
    - Text rendering and alignment for Right-to-Left languages like Persian and Arabic has been significantly refined for better readability and accuracy.
- Discord Input Fix
    - Resolved an issue where translated text wasn't properly sent in Discord input fields — it now works as expected.
- General Enhancements
    - Various bug fixes and performance improvements for a more stable and seamless experience.

---

#### v0.1.1 - Released 06 May 2025


- Updated the build process and added a lint check
- Renamed the extension (UUID remains unchanged)

---

#### v0.1.0 - Released 30 April 2025


- First public release

# Logging System Guide

The extension uses a **unified, strictly filtered** logging system for structured, environment-aware logging across all components.

## Quick Start

```javascript
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

// Standard static initialization
const logger = getScopedLogger(LOG_COMPONENTS.CONTENT, 'MyComponent')

// Usage
logger.error('Fatal failure', error) // Level 0
logger.warn('Recoverable issue')     // Level 1
logger.info('User milestone')        // Level 2
logger.debug('Technical trace')      // Level 3
```

## Log Levels & Strategy

To maintain a clean console, logging follows a strict numerical hierarchy: `level <= componentLevel`.

| Level | Name | Responsibility (Strategy) | Visibility |
|-------|------|---------------------------|------------|
| `0` | **ERROR** | **Final Handlers & Critical Background.** `ErrorHandler`, fatal app crashes, or unexpected runtime errors. | When allowed by the component level and console output is enabled |
| `1` | **WARN** | **Providers & Core.** Used for technical limits (429, 402, Network errors). | Default component level |
| `2` | **INFO** | **Milestones.** Processes starting/ending (e.g., "Translation started"). | Only when the component is set to INFO or DEBUG and console output is enabled |
| `3` | **DEBUG** | **Granular Traces.** High-frequency events (e.g., "Mouse moved", "Message sent"). | Only when the component is set to DEBUG and console output is enabled |

---

## Strict Filtering Mandate

The logger first applies `level <= componentLevel`, independently of `DEBUG_MODE`. Each known component defaults to WARN (1); an unknown component falls back to the global level, also WARN (1). Thus, Debug Mode does not raise component levels or make INFO/DEBUG calls pass this filter. `isDebugEnabled()` is a separate helper that returns true when the debug override is on or the component level is DEBUG; it does not change the filtering of `logger.debug()`.

Console output is a second, global gate: `SafeConsole` suppresses all wrapped output, including ERROR, while disabled. Production starts with it disabled. Development builds initially enable it, but `DebugModeBridge.initialize()` later applies the persisted `DEBUG_MODE` setting; when that setting is false (the default), it disables output again. For reliable debugging, enable **Debug Mode** in Options, set the relevant component's log level to **Debug** (or the level needed), and click **Save Settings**. A log is visible only if it passes both gates (and any configured runtime filter).

### Performance Optimization

For logs that involve expensive string concatenation or object serialization, use **Lazy Evaluation**:

```javascript
// ✅ CORRECT - Expensive logic only runs if level 3 (DEBUG) is enabled
logger.debugLazy(() => ['Complex State:', heavyObject.serialize()])

// ❌ INCORRECT - JSON.stringify runs even if log is hidden
logger.debug(`Complex State: ${JSON.stringify(heavyObject)}`)
```

## Configuration

### 1. Options Page (Recommended)
The primary way to manage log levels is through the Options UI:
- **Location**: `Options Page` -> `Advance Tab` (`AdvanceTab.vue`).
- **Section**: Look for the **Debug Mode** accordion (`DEBUG_MODE_SECTION`).
- **Features**:
  - **Debug Mode toggle**: Enables/disables `SafeConsole` output and sets the debug override used by `isDebugEnabled()`; it does not bypass component-level filtering.
  - **Granular control**: Set specific log levels (Error to Debug) for individual components organized by categories (UI, Background, Messaging, etc.).
- **Apply changes**: The checkbox and component-level edits are drafts in the Options settings store. Click **Save Settings** to persist them; only then do storage listeners and the `DebugModeBridge` synchronize the changed values to other contexts.

For troubleshooting, check the component's configured level as well as the global Debug Mode gate. Extension contexts have separate consoles (for example, the background worker and a page's content script), so inspect the console belonging to the context that emitted the log:

- **Content scripts:** inspect the webpage tab. In Chrome, select the extension/content-script context from the Console context dropdown; in Firefox, use that page's DevTools.
- **Background:** in Chrome, open `chrome://extensions` and choose **Inspect views** for the service worker. In Firefox, open `about:debugging` → **This Firefox** → **Inspect** for the extension, then use its Console; Firefox uses an event page, not a service worker.
- **Popup:** in Chrome, right-click the open popup and choose **Inspect**. In Firefox, open the extension Toolbox and select the popup in its page selector (disable popup auto-hide if needed).
- **Options:** inspect the Options tab in Chrome; in Firefox, use the extension Toolbox to select the Options iframe.
- **Side Panel:** in Chrome, right-click the open panel and choose **Inspect**. In Firefox, use the extension Toolbox document selector to choose the sidebar.

Before sharing logs, redact API keys, credentials, private text, and other sensitive data. See the browser guides for [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug) and [Firefox](https://extensionworkshop.com/documentation/develop/debugging/) for more debugging details.

The offscreen document retrieves its initial logging settings from the authorized background context over runtime messaging; it does not read extension storage directly. A valid response contains boolean `DEBUG_MODE` and object `COMPONENT_LOG_LEVELS` values. Failed or malformed requests remain uninitialized and are retried up to three total attempts; subsequent explicit initialization calls can retry after exhaustion. Targeted setting updates received during this process take precedence over the initial response.

### 2. Default Values
To change default verbosity permanently:
1.  **Open**: `src/shared/logging/GlobalDebugState.js`
2.  **Edit**: `globalLogLevel` or the mapping logic in `initialComponentLogLevels`.

### 3. Adding Components
1.  **Open**: `src/shared/logging/logConstants.js`
2.  **Add**: A new key to the `LOG_COMPONENTS` object.
3.  **UI**: Add the component explicitly to the appropriate `LOG_CATEGORIES` entry in `logConstants.js` if it should have a control in the Options UI. `LOG_CATEGORIES` is a hand-maintained list; adding a `LOG_COMPONENTS` key alone does not add it to the UI.

### 4. Return to normal logging

Set the affected components back to **Warn**, turn off **Debug Mode**, and click **Save Settings**. If a context still appears to use stale settings, reload that extension context so it reloads the persisted values.

## Summary

The logging system provides:
- **Numerical Filtering**: Simple, strict logic (`level <= componentLevel`).
- **Sync Architecture**: Saved settings are synchronized across extension contexts via storage listeners and `DebugModeBridge`.
- **Memory Efficient**: Singleton logger instances with internal caching.

# Logging System Guide

## Overview

The extension uses a unified, environment-aware logger across its components. Logs pass both a component-level filter and a global console-output gate. Logger instances are cached, and saved settings synchronize across extension contexts through storage listeners and `DebugModeBridge`.

## Enabling Debug Logs

1. Open **Options** → **Advance** and expand the **Debug Mode** section (`DEBUG_MODE_SECTION`).
2. Enable **Debug Mode** to allow `SafeConsole` output.
3. Set the relevant component's log level to **Debug** (or the level needed). Prefer changing only the component you are investigating.
4. Click **Save Settings**. The toggle and component-level changes are drafts until saved.

Debug Mode does not raise component log levels. A log appears only when it passes the component filter and console-output gate (and any configured runtime filter).

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

## Log Levels & Filtering

Filtering uses the strict rule `level <= componentLevel`, independently of `DEBUG_MODE`. Known components default to WARN (1); unknown components fall back to the global level, also WARN (1).

| Level | Name | Typical use | Visibility |
|-------|------|-------------|------------|
| `0` | **ERROR** | Final handlers, fatal crashes, unexpected runtime errors | When allowed by the component level and console output is enabled |
| `1` | **WARN** | Providers and core issues (for example, 429, 402, and network errors) | Default component level |
| `2` | **INFO** | Milestones, such as a process starting or ending | When the component is INFO or DEBUG and console output is enabled |
| `3` | **DEBUG** | Granular, high-frequency traces | When the component is DEBUG and console output is enabled |

`isDebugEnabled()` returns true when the debug override is on or the component level is DEBUG; it does not change the filtering of `logger.debug()`. `SafeConsole` is a second, global gate that suppresses all wrapped output, including ERROR, while disabled. Production starts with it disabled. Development builds initially enable it, but `DebugModeBridge.initialize()` applies the saved `DEBUG_MODE` setting; when false (the default), output is disabled again.

## Advanced Configuration

### Defaults and components

- To change default verbosity, edit `globalLogLevel` or `initialComponentLogLevels` in `src/shared/logging/GlobalDebugState.js`.
- Add component keys to `LOG_COMPONENTS` in `src/shared/logging/logConstants.js`. To expose a component in Options, also add it to the appropriate `LOG_CATEGORIES` entry; this UI list is maintained separately.

### Performance

Use lazy evaluation for expensive log arguments so the work runs only when the message is enabled:

```javascript
// ✅ Expensive logic runs only if DEBUG is enabled
logger.debugLazy(() => ['Complex State:', heavyObject.serialize()])

// ❌ JSON.stringify runs even if the log is hidden
logger.debug(`Complex State: ${JSON.stringify(heavyObject)}`)
```

### Offscreen logging settings

The offscreen document gets initial settings from the authorized background context over runtime messaging; it does not read extension storage directly. A valid response contains boolean `DEBUG_MODE` and object `COMPONENT_LOG_LEVELS` values. Failed or malformed requests remain uninitialized and are retried up to three total attempts. After exhaustion, a later explicit initialization call can retry. Targeted setting updates received during initialization take precedence over the initial response.

## Troubleshooting

### Missing logs

Check both gates: confirm the component level permits the message and **Debug Mode** is enabled and saved. `Debug Mode` alone does not make INFO or DEBUG messages pass the component filter. Logs appear in the console for the context that emitted them; extension contexts have separate consoles.

### Browser DevTools

- **Content scripts:** inspect the webpage tab. In Chrome, select the extension/content-script context from the Console context dropdown; in Firefox, use that page's DevTools.
- **Background:** in Chrome, open `chrome://extensions` and choose **Inspect views** for the service worker. In Firefox, open `about:debugging` → **This Firefox** → **Inspect** for the extension, then use its Console; Firefox uses an event page, not a service worker.
- **Popup:** in Chrome, right-click the open popup and choose **Inspect**. In Firefox, open the extension Toolbox and select the popup in its page selector (disable popup auto-hide if needed).
- **Options:** inspect the Options tab in Chrome; in Firefox, use the extension Toolbox to select the Options iframe.
- **Side Panel:** in Chrome, right-click the open panel and choose **Inspect**. In Firefox, use the extension Toolbox document selector to choose the sidebar.

Before sharing logs, redact API keys, credentials, private text, and other sensitive data. See the browser guides for [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug) and [Firefox](https://extensionworkshop.com/documentation/develop/debugging/) for more details.

### Restore normal logging

Set changed components back to **Warn**, turn off **Debug Mode**, and click **Save Settings**. If a context still uses stale settings, reload that extension context.

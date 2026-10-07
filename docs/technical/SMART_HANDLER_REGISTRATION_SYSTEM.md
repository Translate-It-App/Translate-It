# Smart Handler Registration System

## Overview
The **Smart Handler Registration System** is a feature-based exclusion system that provides dynamic handler lifecycle management with real-time settings updates. Unlike traditional systems that register all handlers and check exclusions at runtime, this system only registers handlers when they are actually needed based on feature settings and URL exclusions.

## Key Features
- **Centralized Event Monitoring** - Uses `InteractionCoordinator` to manage global listeners efficiently.
- **Dynamic Activation/Deactivation** - Features activate/deactivate without requiring page refresh.
- **On-Demand Loading (Lazy)** - Heavy feature code is only loaded when a trigger (click/shortcut) occurs.
- **Forced Utility Loading** - Allows loading core logic (like Revert/ESC) even if the main feature is disabled.
- **Memory-Efficient** - Only active handlers and required listeners consume resources.

---

## Architecture Components

### 1. Feature Configuration (`src/core/managers/content/FeatureConfig.js`)
The **Single Source of Truth** for feature definitions. It maps every feature to its governing settings and defines custom enablement logic. This eliminates hardcoded logic across the system.

```javascript
export const FEATURE_CONFIG = {
  mouseHover: {
    settings: ['MOUSE_HOVER_TRANSLATION_ENABLED'],
    settingKey: 'MOUSE_HOVER_TRANSLATION_ENABLED'
  },
  textSelection: {
    settings: ['TRANSLATE_ON_TEXT_SELECTION', 'SHOW_DESKTOP_FAB', 'MOBILE_UI_MODE'],
    isEnabled: (get) => { /* custom logic */ }
  }
};
```

### 2. InteractionCoordinator (`src/core/content-scripts/InteractionCoordinator.js`)
The **InteractionCoordinator** acts as the system's "Gatekeeper." It manages lightweight global listeners (`mouseup`, `keydown`, `contextmenu`, `focusin`, `scroll`) and decides when to trigger the full loading of a feature.

```javascript
  async sync() {
    const isEnabled = settingsManager.isExtensionEnabled() && !(await checkUrlExclusionAsync());

    // Define listener requirements dynamically
    const config = [
      { key: 'textSelection', type: 'mouseup', handler: this.handlers.textSelection, allowed: isEnabled && await this.exclusionChecker.isFeatureAllowed('textSelection') },
      // ...
    ];

    config.forEach(item => this._manageListener(item.key, item.type, item.handler, item.allowed));
  }
```

**Key Responsibilities:**
- **Trigger-Only Role**: Detects potential interactions and triggers `loadFeature()` without knowing the internal business logic of the features.
- **Dynamic Listener Sync**: Automatically attaches/detaches DOM listeners based on real-time permission changes.
- **Context Awareness**: Manages different behaviors for Top Frames vs. IFrames while keeping the logic decoupled.

### 2. Lazy Feature Loader (`src/core/content-scripts/chunks/lazy-features.js`)
Acts as a lean **Proxy Layer** for dynamic imports. It delegates all logical activation and permission checking to the `FeatureManager`, focusing only on retrieving and caching the returned feature instances.

```javascript
export async function loadFeature(featureName, force = false) {
  const featureManager = FeatureManager.getInstance();
  
  // Delegates logical activation to FeatureManager
  const handler = await featureManager.requestFeatureActivation(featureName, force);
  
  // Caches and returns the instance for backward compatibility
  let instance = handler;
  if (featureName === 'windowsManager') instance = handler.getWindowsManager();
  // ...
  return instance;
}
```

### 3. FeatureManager (`src/core/managers/content/FeatureManager.js`)
The **Single Source of Truth** for feature lifecycle and logical state. It manages not only the activation but also the tracking of *formally requested* features to ensure targeted re-evaluation during settings or URL changes.

```javascript
class FeatureManager extends ResourceTracker {
  constructor() {
    this.requestedFeatures = new Set(); // Tracks features requested by the Loader
    this.activeFeatures = new Set();    // Tracks features currently running
  }

  /**
   * Main entry point for activating features.
   * Ensures permissions are checked before instantiation.
   */
  async requestFeatureActivation(featureName, force = false) {
    this.requestedFeatures.add(featureName);
    
    const allowed = force || await this.shouldActivateFeature(featureName);
    if (allowed) {
      await this.activateFeature(featureName);
    }
    return this.getFeatureHandler(featureName);
  }

  /**
   * Targeted Re-evaluation for SPAs and Settings Changes.
   * Only re-evaluates features that have been requested, preventing premature activation.
   */
  async _processEvaluationQueue() {
    const features = Array.from(this.requestedFeatures);
    for (const feature of features) {
      const shouldBeActive = await this.shouldActivateFeature(feature);
      // ... activate or deactivate accordingly
    }
  }
}
```

**Key Responsibilities:**
- **Logical Gatekeeper**: Checks `ExclusionChecker` before any dynamic import occurs.
- **State Management**: Tracks which features should be active based on current context.
- **Cleanup Orchestrator**: Ensures complete resource teardown and singleton destruction during deactivation.
- **IFrame Support**: Automatically propagates activation and settings updates across all contexts.
- **Self-Initialization**: Automatically sets up exclusion rules and listeners if a feature is requested before the manager is ready.

---

## Content Script Integration

The main content script (`src/core/content-scripts/index-main.js`) stays lean: it creates `ContentScriptCore` and calls `initializeContentCore(contentScriptCore)`. `ContentScriptCore` owns allowed-runtime bootstrap and initializes `InteractionCoordinator`:

```javascript
// index-main.js
const { ContentScriptCore } = await import('./ContentScriptCore.js');
const contentScriptCore = new ContentScriptCore();

const { initializeContentCore } = await import('./contentStartup.js');
await initializeContentCore(contentScriptCore);
```

### Staged Startup and Feature Activation

The allowed-runtime bootstrap in `ContentScriptCore` constructs `MainFeatureLoader`, loads `extensionContext`, initializes `InteractionCoordinator`, then starts staged startup. `MainFeatureLoader.startIntelligentLoading()` awaits the CRITICAL stage, schedules ESSENTIAL loading, and schedules LAZY_UI and ON_DEMAND through `requestIdleCallback` when available (with timer fallbacks). `MainFeatureLoader.loadFeature()` itself adds no delay: it deduplicates only concurrent in-flight requests and delegates to `ContentScriptCore.loadFeature()`.

This startup schedule is separate from interaction-triggered activation. `InteractionCoordinator` synchronizes lightweight listeners against settings and exclusions, then asks `lazy-features.js` to load features when matching events occur. That module delegates permission checks and activation to `FeatureManager`; the startup loader is not the activation authority. Applicable whole-page auto-translate rules can also explicitly load `contentMessageHandler` and `pageTranslation` during bootstrap, so not every feature load waits for a user interaction.

---

## Feature Lifecycle & Exclusion Mapping

### URL & Setting Mapping
| Feature | Setting | Exclusion Rule | Trigger Event |
| :--- | :--- | :--- | :--- |
| `selectElement` | `TRANSLATE_WITH_SELECT_ELEMENT` | `EXCLUDED_SITES` | `contextmenu` / FAB Click |
| `textSelection` | `TRANSLATE_ON_TEXT_SELECTION` | `EXCLUDED_SITES` | `mouseup` (Selection) |
| `textFieldIcon` | `TRANSLATE_ON_TEXT_SELECTION` | `DEFAULT_EXCLUDED_TEXT_FIELDS_ICON` + `EXCLUDED_SITES` | `focusin` |
| `shortcut` | `ENABLE_SHORTCUT_FOR_TEXT_FIELDS` | `EXCLUDED_SITES` | `keydown` (configured Text Field shortcut; default Ctrl+/) |

### Special Case: Select Element Escape
Select Element Escape support works even if user disabled field shortcuts.
1. Active selection owns and consumes single Esc through `SelectElementManager`.
2. Outside selection, global cancellation and revert require non-consuming Double Esc; websites receive both events.
3. Repeated or modifier Escape does not count.
4. Lazy shortcut activation may delegate only its triggering event when `ShortcutManager` was not initialized; initialized managers own dispatch directly, preventing duplicate delivery.

---

## Benefits
1. **Staged Startup** - Feature groups load in prioritized stages; interactions and applicable auto-translate rules can also request activation.
2. **Robustness** - The system recovers from settings changes in real-time by re-syncing the Coordinator.
3. **Clean Architecture** - Separation between "Event Detection" (Coordinator) and "Business Logic" (Handlers).
4. **Reliable Revert** - User can always undo translations regardless of their current shortcut settings.

---

**Last Updated**: April 2026

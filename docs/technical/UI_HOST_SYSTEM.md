# UI Host System Architecture

## Overview

The UI Host system is a centralized Vue.js application that manages all in-page user interface elements for the Translate It extension. It runs within an open Shadow DOM to limit style leakage; this does not provide complete JavaScript isolation or protection from page-level layout and stacking contexts.

The shared host is appended to the current document's `documentElement` (with distinct top-frame and iframe IDs). On pages whose root establishes layout containment, supported browsers promote the host as a manual popover so its fixed-position descendants remain viewport-positioned. The promoted host resets page-authored popover-state effects on its transform, opacity, containment, filters, and clipping; its backdrop is hidden, transparent, and pointer-inert. Unsupported or failing popover APIs fall back to the regular host; this cannot defeat root containment there. Normal pages do not enter the top layer. The host remains pointer-transparent, and its shadow root stops extension-originated `focusin` propagation.

Containment is checked when the host is created; changing root containment afterward does not promote or demote an already-mounted host.

## Architecture

### Components

1. **ContentApp.vue** - The root Vue component that hosts all in-page UI elements.
2. **Selection Coordinator** - Pub/Sub system that broadcasts text selection events to all UI modules.
3. **PageEventBus.js** - Lightweight event bus for communication between vanilla JS and Vue components.
4. **NotificationManager.js** - Clean API wrapper for showing notifications via the event bus.

### Key Features

- **Shadow DOM styling boundary**: UI component styles are scoped within an open Shadow DOM, limiting CSS leakage without claiming complete CSS or JavaScript isolation.
- **Selection Coordinator Integration**: Decoupled selection awareness for FAB, Windows, and TTS.
- **Event-Based Communication**: Uses a custom event bus for seamless communication between vanilla JS and Vue.
- **Centralized Management**: All in-page UI (notifications, toolbars, icons) is managed by a single Vue app.
- **Performance Optimized**: Minimizes DOM manipulation and leverages Vue's reactivity system.

## Communication Pattern

### Selection Coordination (Pub/Sub)

```javascript
// In Detectors (SelectionManager / TextFieldHandler)
import { pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';

pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, {
  text: 'selected text',
  position: { x, y },
  mode: 'immediate'
});

// In Subscribers (useFabSelection.js / WindowsManager.js)
pageEventBus.on(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, (detail) => {
  // React independently to selection
});
```

### Vanilla JS → Vue (Event Emission via Managers)

```javascript
// Recommended approach: Use NotificationManager (Standard Project Policy)
import NotificationManager from '@/core/managers/core/NotificationManager.js';

const notifier = new NotificationManager();

// Show a notification
notifier.show('Translation completed', 'success', 4000);
```

### Direct Event Emission (Low-level)

```javascript
// Only use if a manager is not available or for specialized events
import { pageEventBus } from '@/core/PageEventBus.js';

// Activate select mode
pageEventBus.emit('select-mode-activated');

// Add a text field icon
pageEventBus.emit('add-field-icon', {
  id: 'unique-id',
  position: { top: 100, left: 200 }
});
```

### Vue → Vanilla JS (Event Listening)

```javascript
// In ContentApp.vue
pageEventBus.on('text-field-icon-clicked', (detail) => {
  console.log('Icon clicked:', detail.id);
  // Handle the click event
});
```

## Notification System

The notification system uses `vue-sonner` for rich, customizable toast notifications:

### Notification Types
- `success` - Green success notifications
- `error` - Red error notifications  
- `warning` - Orange warning notifications
- `info` - Blue informational notifications
- `status` - Loading/status notifications
- `revert` - Special revert operations

### Usage via NotificationManager

```javascript
import NotificationManager from '@/managers/core/NotificationManager.js';

const notifier = new NotificationManager();

// Show notification
const toastId = notifier.show('Translation completed', 'success');

// Dismiss specific notification
notifier.dismiss(toastId);

// Dismiss all notifications
notifier.dismissAll();
```

## UI Components

### SelectModeToolbar.vue
Renders the toolbar/overlay when Select Element mode is active. Controlled by the `isSelectModeActive` reactive property.

### TextFieldIcon.vue  
Renders translation icons on text fields. Managed through the `activeIcons` reactive array with absolute positioning.

### DesktopFabMenu.vue
A persistent, vertically draggable floating action button that provides quick access to "Select Element" and "Page Translation" features. It features smart-fading and dynamic menu items based on page state. See [Desktop FAB System](DESKTOP_FAB_SYSTEM.md) for full details.

### MobileSheet.vue
The central UI container for mobile browsers. It provides a touch-friendly "Bottom Sheet" experience with gesture support and dynamic view switching. See [Mobile Support System](MOBILE_SUPPORT.md) for full details.

## Benefits

1. **Style boundary**: Shadow DOM limits CSS conflicts; page-level rules can still affect the host element.
2. **Maintainability**: Centralized UI management simplifies debugging and updates
3. **Consistency**: Uniform notification and UI patterns across the extension
4. **Performance**: Reduced DOM manipulation and optimized rendering
5. **Scalability**: Easy to add new UI components and features
6. **CSS Architecture**: Modern principled CSS with CSS Grid, containment, and safe variable functions
7. **Future-Proof**: SCSS mixins and functions prevent variable interpolation issues

## Integration Points

The system integrates with:
- **Selection Coordinator**: Centralized selection signal management.
- **WindowsManager.js**: For translation windows and icons (now a Subscriber).
- **Desktop FAB System**: For the persistent floating action menu (via `useFabSelection`).
- **Mobile Support System**: For the touch-friendly mobile interface.
- **ErrorHandler.js**: For error notifications and state-aware UI recovery.

## File Structure

```
src/
├── apps/content/
│   ├── ContentApp.vue          # Root UI Host component
│   └── components/             # Sub-components (FAB, Windows, Icons)
├── core/
│   ├── PageEventBus.js         # Event communication system
│   └── managers/core/
│       └── NotificationManager.js # Notification API wrapper
├── features/
│   └── text-selection/
│       └── events/
│           └── SelectionEvents.js # Global coordinator constants
└── apps/content/composables/
    └── useFabSelection.js      # Decoupled UI logic handler
```

## Best Practices

1. Always use `NotificationManager` for notifications instead of direct event emission
2. Use descriptive event names with consistent naming conventions
3. Include all necessary data in event payloads for proper handling
4. Clean up event listeners when components are unmounted
5. Test UI components in various webpage environments

# Selection Coordinator System Architecture (2026)

## Overview

The **Selection Coordinator** is a central orchestration layer designed to decouple text selection events from specific UI implementations. By moving away from a coupled "gateway" model (where `WindowsManager` handled all requests), the system now uses a **Pub/Sub (Publisher/Subscriber)** pattern. 

This architecture ensures that all modules (Desktop FAB, Mobile FAB, TTS, Dashboard, and WindowsManager) operate independently and respond to global selection signals based on their own internal logic and user settings.

---

## Architecture (Implemented)

The system is built around three distinct roles: **Detectors**, the **Coordinator**, and **Subscribers**.

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────────────┐
│    DETECTORS    │      │   COORDINATOR    │      │       SUBSCRIBERS       │
├─────────────────┤      ├──────────────────┤      ├─────────────────────────┤
│SelectionManager │      │   PageEventBus   │      │ WindowsManager (Window) │
│                 │───▶ │                  │───▶ │ Desktop FAB (Badge/TTS) │
│TextFieldHandler │      │ GLOBAL_SELECTION │      │ Mobile FAB (Sheet/TTS)  │
│                 │      │      EVENTS      │      │ DashboardView (TTS)     │
└─────────────────┘      └──────────────────┘      └─────────────────────────┘
```

### Key Components

1.  **SelectionEvents.js**: Defines the standard event constants used across the project.
2.  **SelectionManager / TextFieldDoubleClickHandler**: These act as **Detectors**. They identify text and broadcast the signal. They no longer have any knowledge of UI managers.
3.  **useFabSelection.js**: A specialized logic handler (composable) that allows FAB components to manage their selection state independently of other systems.
4.  **WindowsManager**: Now operates as a subscriber. It listens for selection changes and independently applies logic (Ctrl key checks, exclusions) to decide if its UI should be displayed.

---

## Technical Specifications

### 1. Global Events (`SELECTION_EVENTS`)

The system uses three primary events defined in `src/features/text-selection/events/SelectionEvents.js`:

*   **`GLOBAL_SELECTION_CHANGE`**: Broadcasted when new text is selected.
    *   *Payload*: `{ text, position, mode, options, context, toolbarPosition? }`
    *   `position` remains the selection-derived position for subscribers and translation windows. `toolbarPosition` is an optional recent primary mouse-release position, used only to place the ON_CLICK icon; keyboard selections and other display modes fall back to `position`. Iframe requests carry it separately and accumulate direct-child iframe offsets like `position` while preserving viewport-relative coordinates.
*   **`GLOBAL_SELECTION_CLEAR`**: Unified signal to hide selection-aware UI elements.
    *   *Payload*: `{ reason, mode }`
*   **`GLOBAL_SELECTION_TRIGGER`**: Emitted by a UI (like FAB) to request a full translation display.
    *   *Payload*: `{ text, position }`

### 2. Implementation Files

*   **Events**: `src/features/text-selection/events/SelectionEvents.js`
*   **FAB Logic**: `src/apps/content/composables/useFabSelection.js`
*   **Core Managers**:
    *   `src/features/text-selection/core/SelectionManager.js` (Detector)
    *   `src/features/text-field-interaction/handlers/TextFieldDoubleClickHandler.js` (Detector)
    *   `src/features/windows/managers/WindowsManager.js` (Subscriber)

---

## Advantages of the Decoupled Model

### 1. Feature Independence
The Desktop/Mobile FAB remains fully functional (Badge display, TTS) even if the user disables the primary `WindowsManager` (Translation Windows). Each module respects its own toggle in settings.

### 2. Resilient Selection State
By passing keyboard state (`ctrlPressed`, `shiftPressed`) through the global event payload, the system ensures that complex requirements (like "Require Ctrl") are handled at the final display layer, preventing "stuck" states or missing UI during rapid interactions.

### 3. Unified Mobile & Desktop Flow
Both platforms now follow the exact same architectural pattern. A selection in an Iframe is relayed to the top frame where it's broadcasted to all subscribers (FAB, Windows, etc.) simultaneously.

### 4. Shadow DOM Integrity
`SelectionManager` now uses direct Shadow DOM inspection to detect active UI elements, removing the need for internal state sharing between managers.

---

## Development Guide

### To listen for selection changes in a new module:
1.  Import `SELECTION_EVENTS` from the events directory.
2.  Add a listener to `pageEventBus` for `GLOBAL_SELECTION_CHANGE`.
3.  Implement your own local state management or UI logic based on the payload.

### To request a translation window from a custom UI:
1.  Emit `GLOBAL_SELECTION_TRIGGER` via `pageEventBus`.
2.  `WindowsManager` will automatically pick up the request and handle the display.

---

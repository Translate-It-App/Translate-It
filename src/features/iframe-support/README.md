# IFrame Support System (Dual-Entry Architecture)

Streamlined and high-performance iframe support system for Translate-It extension, optimized for Manifest V3 and multi-frame environments.

## Overview

This system manages the extension's behavior across multiple frames using a **Dual-Entry** approach. It ensures that heavy UI components (Vue) are only loaded in the main frame, while iframes run a "Lite Proxy" script. This architecture guarantees maximum performance and seamless coordination for features like Select Element and Whole Page Translation.

## Structure

```
src/features/iframe-support/
├── managers/
│   └── IFrameManager.js          # Core management, registry & coordinate mapping
├── composables/
│   ├── useIFrameSupport.js       # Vue 3 composables (isTopFrame detection, etc.)
│   └── useIFrameSupportLazy.js   # Lazy-loaded iframe support
├── IFrameSupportFactory.js       # Factory for creating iframe support instances
├── index.js                      # Entry point for feature discovery
└── README.md                     # This file
```

## Key Features

### Dual-Entry Architecture
- **index-main.js**: Orchestrator for the top frame. Manages UI, Stores, and Coordination.
- **index-iframe.js**: Lightweight proxy for all iframes. Tiny frames (ads) get a messaging-only core and handles text detection.

### Cross-Frame Coordination
- **Event Synchronization**: Coordinated `ESC` key, `Revert`, and `Deactivation` across all frames.
- **Smart Click Detection**: Clicks inside iframes correctly dismiss UI elements in the main frame.
- **Progress Aggregation**: Hierarchical reporting where iframes send stats to the main frame for a unified FAB progress display (via `MainFrameAggregator.js`).

### Intelligent Viewport Translation
- **Browser-Native Detection**: Leverages standard `IntersectionObserver` within iframes to detect visibility relative to the top-level viewport.
- **Lazy Promotion**: Heavy translation modules are only loaded in iframes when they become visible or are triggered by the user.

### Performance Optimized
- **Tiny Frame Filter**: Frames smaller than 80x80px (ads/trackers) keep messaging only: they answer Select Element probes but load no features.
- **Zero Memory Leaks**: Full integration with `ResourceTracker` for automatic cleanup of cross-frame listeners.

## Usage

### 1. Automatic Initialization
The system is automatically handled by the manifest/background flow and the two entry points:
- `index-main.js` (Top frame only, declarative content script)
- `index-iframe.js` (Subframes only, injected programmatically after subframe DOM is ready)

### 2. Vue Composable Usage (Standardized)

```vue
<script setup>
import { 
  useIFrameDetection, 
  useIFramePositioning 
} from '@/features/iframe-support/composables/useIFrameSupport.js';

// Standardized frame detection (Positive Logic)
const { isTopFrame, isMainDocument, frameDepth } = useIFrameDetection();

// Positioning transformation
const { transformPosition, getFrameBounds } = useIFramePositioning();

// Coordinates are automatically mapped to the main viewport
const adjustedPosition = transformPosition({ x: 100, y: 200 });
</script>
```

## Recent Improvements (2026)

### 1. Unified Frame Detection
Standardized all checks to use `isTopFrame` instead of `isInIframe` for better code clarity and consistency across the project.

### 2. Precision Positioning Fix
Fixed "Double Scroll" issue. Iframe selections now use absolute Viewport-Relative mapping, ensuring the translation icon appears exactly under the selected text regardless of scroll levels in any frame.

### 3. Page Translation Aggregator
Implemented a central aggregator in the top frame. It collects `translatedCount` and `totalCount` from all active iframes to show a true "Whole Page" progress percentage in the FAB.

### 4. Cross-Frame Shortcut Sync
Fixed the issue where the `ESC` key only reverted the main frame. It now broadcasts a global revert signal to all iframes.

## Security Considerations

- **Cross-Origin Safety**: Uses `postMessage` with strict source validation (`translate-it-main`/`iframe`).
- **Placeholder Bootstrapping**: Uses pre-initialization objects to prevent messaging race conditions during asynchronous loading.
- **Sandboxing**: Respects browser security boundaries while maintaining functional integration.

---

**Status**: Refactored April 2026

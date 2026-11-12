# Whole Page Translation System

> **Feature contract:** see [Feature Behavioral Contracts](contracts/FEATURE_CONTRACTS.md#10-whole-page-contract) for the authoritative whole-page outcome, progress-count, and revert contract.

## Overview

The **Whole Page Translation** system is responsible for the recursive translation of all text content within a web page. Utilizing the `domtranslator` library and a specialized layered architecture, it provides a smooth, optimized, and fault-tolerant translation experience.

**Performance:** Lazy Loading + Dual-Mode Filtering + Modular Management
**Reliability:** Circuit Breaker for Rate Limits

## Architecture

The system is divided into 10 distinct parts to adhere to the Single Responsibility Principle and ensure maintainability:


```

PageTranslationManager (Orchestrator)
↓
├─→ PageTranslationSettingsLoader (Settings Logic)
├─→ PageTranslationEventManager (Event & Bus Handling)
│
├─→ PageTranslationBridge (Library Wrapper)
│       └─→ domtranslator (External Lib)
│
├─→ PageTranslationScheduler (Batching Engine)
│       ├─→ PageTranslationQueueFilter (On-Stop Filtering)
│       ├─→ PageTranslationFluidFilter (Fluid/Score Filtering)
│       └─→ UnifiedMessaging → UnifiedModeCoordinator (Background Orchestration)
│                                       ↓
│                                  Translation Engine
│
├─→ PageTranslationScrollTracker (Motion Detection)
│
├─→ HoverPreviewManager (Shared Interaction Manager)
│       └─→ PageEventBus → PageTranslationTooltip (Vue UI)
│
├─→ PageTranslationHelper (Static Utilities)
└─→ PageTranslationConstants (Shared Values)

```

### 1. PageTranslationManager
The main coordinator of the page translation lifecycle. It orchestrates activation, deactivation, and high-level commands (Translate/Restore). It delegates specialized tasks to dedicated utilities to maintain a clean core.

### 2. PageTranslationSettingsLoader
A specialized utility for loading, formatting, and resolving translation settings.
- **Responsibilities**: Parallel fetching of settings from storage, formatting DOM margins (e.g., `rootMargin`), and resolving the effective provider based on global vs. mode-specific settings.

### 3. PageTranslationEventManager
Centralizes all external event listeners for the system.
- **Responsibilities**: Manages `PageEventBus` listeners (Translate, Stop, Cancel) and `storageManager` observers. It bridges external signals to internal manager actions.

### 4. PageTranslationScheduler
The core engine for queue management and batch request dispatching. It is deeply integrated with the **Optimization Levels** system.
- **Dynamic Chunk Scaling**: Automatically adjusts the number of text segments per request based on the provider's optimization level (e.g., larger batches for "Economy" mode to save AI tokens, smaller batches for "Turbo" mode for faster progressive updates).
- **Concurrency Control**: Fills a bounded set of independent AI batch workers from one flush. The existing parallel retry lane dispatches these batches; the shared provider `RateLimitManager` bounds physical AI requests, including recovery. AUTO source resolution still holds siblings until the first batch confirms the session's language pair. Traditional providers retain their existing dispatch behavior.
- **Memory Safety**: Inherits from `ResourceTracker`; automatically clears the queue on cleanup.
- **Prioritization**: Forces immediate flush for high-priority items if capacity is reached.

### 5. PageTranslationFiltering Engines
Specialized engines for batch selection:
- **PageTranslationQueueFilter**: Used for "On-Stop" mode. Focuses on visibility and **memory-safe purging** (ejecting distant nodes during long scrolls).
- **PageTranslationFluidFilter**: Used for "Fluid" mode. Focuses on visibility + element importance (Score).

### 6. PageTranslationScrollTracker
Activity and motion detection utility. Detects scroll events and **dynamic DOM changes** to signal the Scheduler when the page has "stabilized" for translation.

### 7. PageTranslationBridge
The communication bridge between the extension and the `domtranslator` library. Owns the Sliced Discovery traversal that feeds the `Scheduler`, and intercepts nodes to provide visibility data. `domtranslator` retains per-node state management, the restore traversal, and re-translation of mutated nodes.

### 8. HoverPreviewManager
Handles user interactions (Original Text Preview) via `PageEventBus`. Shared with Select Element mode.

### 9. PageTranslationHelper & Constants
Static utilities for DOM calculations and shared system values.

## Technical Flow

1.  **Activation**: The `Manager` uses `SettingsLoader` to fetch configuration and initializes the `EventManager`.
2.  **Capture**: Sliced Discovery walks the tree in the `Bridge`, which enqueues discovered nodes into the `Scheduler`.
3.  **Scheduling**:
    - **Optimization Level Alignment**: The `Scheduler` queries the active provider's optimization level (1-5) and adjusts its internal `chunkSize` and `maxConcurrent` limits accordingly.
    - **Fluid Mode**: Automatic flushes using `FluidFilter`.
    - **On Stop Mode**: Deferred flushes triggered by `ScrollTracker` via `QueueFilter`.
4.  **Background Orchestration**:
    - **Unified Routing**: Requests are sent to `UnifiedModeCoordinator.processPageTranslation`.
    - **Standardized Processing**: Uses `_processGenericBatch` for consistent lifecycle management and character counting.
    - **Stability Guard**: Leverages the 5-minute background timeout to ensure resources are reclaimed if a provider hangs.
5.  **Application**: Directionality (RTL/LTR) is applied, and text is replaced in the DOM.

When enabled in Appearance, Page Translation resolves the existing `TRANSLATION_FONT_FAMILY` setting and best-effort applies only `font-family` to safe translated text parents after accepted text writes. The option defaults to off, and font setting or resolution failures do not fail translation.

## Sliced Discovery (Production Default)

`PAGE_TRANSLATION_SLICED_DISCOVERY` in `PageTranslationConstants.js` is an internal flag, captured when a Bridge session is created. It adds no UI or persisted setting, and it is enabled by default: Sliced Discovery is the production discovery path for initial page translation. Complete discovery of the existing supported tree, including initial open-shadow-root observation, runs in cooperative time/step slices without viewport pruning. Filtering, lazy intersection scheduling, provider batching, and guarded DOM application remain feature-owned. `domtranslator` keeps the remaining responsibilities: per-node original-text storage, the restore traversal, re-translation of mutated nodes, and the internal Legacy Discovery fallback — its own whole-tree walk — used when this flag is set to `false` before a session starts.

Discovery-pending state prevents premature empty, complete, or idle settlement; it ends after enumeration and observer registration, without waiting for offscreen lazy targets or provider results. Stop, Restore, cleanup, and session invalidation cancel remaining discovery. Discovery failure stops the session while preserving accepted translations for Restore; it never restarts legacy enumeration within that session. Legacy discovery remains available for subsequent sessions with the flag disabled. Mutation-time coverage is stable-tree parity plus revalidated live admission, not an atomic DOM snapshot.

`PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY` is a separate internal, default-off option and has effect only when sliced discovery is enabled. It performs a single bounded reorder window on the initial canonical cursor: eligible primitives in the first 100 traversal steps (at most 100 candidates) are measured and stably admitted viewport-intersecting first, then traversal resumes at that same cursor. Enumeration, geometry checks, partition work, and admissions all consume the normal slice step/time budget; the configured eligible attribute names are visited incrementally instead of copying each element's full live attribute collection. This is a bounded-window fallback, not a viewport hit-test seed: it cannot prioritize visible content beyond the initial window, does not prune canonical traversal, and scrolling does not restart it. No speedup is guaranteed. Disable this flag to roll back to sliced-only discovery, or disable both flags to restore legacy traversal in the next session.

## Stability & Resiliency

### 1. Background Timeout
Page translation batches are protected by a **5-minute timeout** in the background services. This ensures that even if a page has thousands of nodes and the translation provider becomes unresponsive, the background script won't hang indefinitely.

### 2. Smart Abort
When the user clicks "Stop" or "Restore" in the page translation UI, a cancellation signal is sent to the background to immediately abort any pending batches, saving API costs and local resources.

### 3. Fault-Tolerant Mapping
The system uses a "Soft-Failure" strategy. If a single batch fails, the scheduler catches the error, marks those specific segments as failed (reverting to original text), and continues with the rest of the page. This prevents a single network error from breaking the entire page translation.

Scheduler item IDs are returned by the background and matched before settlement, so out-of-order batches or results cannot cross-assign nodes. Missing IDs fail only their own items; unknown or duplicate IDs invalidate the response. Relevant setting changes and trusted SPA navigation stop obsolete sessions without reverting committed nodes. Internal automatic navigation within one document can retain unchanged accepted nodes in fresh session storage, including their original text, after checking document, provider, target and settings revision. This avoids resending translated shared navigation through AUTO language bootstrap. Global provider changes stop only Page sessions that actually use the global fallback. Shared AI 429 cooldown also applies to siblings and API-key failover; cancellation keeps an occupied request slot until its transport task settles.

## Smart Features

### Optimization Level Integration
The system is "Optimization-Aware." It respects the user's preference for **Speed vs. Cost** by dynamically reconfiguring its scheduling strategy:
- **Level 1 (Economy/Stable)**: Uses larger chunks (up to 80 segments for AI) and lower concurrency. This is highly efficient for LLMs as it reduces the frequency of System Prompt repetition and stays within IP-based rate limits for traditional providers.
- **Level 5 (Turbo/Fast)**: Uses smaller chunks and higher concurrency. Current Custom page batches retain their existing maximum of 10 segments at level 5 and 25 at level 3 (the separate Custom provider category uses the traditional sizing curve). Other AI providers use 15 and 30 respectively. Character limits can further reduce a batch. Custom's shared request ceilings are 4 and 2 respectively.

### Modular Event Management
By isolating event handling into `PageTranslationEventManager`, the system prevents "Listener Leaks" and ensures that global signals (like conflict resolution with Select Element mode) are handled consistently.

### Memory-Safe Scrolling (Smart Purge)
To prevent memory exhaustion during infinite scrolling, the `QueueFilter` implements a **Smart Purge** policy. Nodes that move significantly far from the viewport (e.g., > 3000px) are automatically ejected from the queue. These nodes remain eligible for translation if the user scrolls back to them, ensuring a balance between RAM usage and persistence.

### Activity-Aware Scheduling
The system treats both scrolling and significant DOM mutations as "activity." Translation is deferred until all activity ceases for the duration of the `SCROLL_STOP_DELAY`, preventing fragmented translation batches during heavy content loading.

### Dual-Mode Modular Filtering
The system provides optimized behavior for different scrolling patterns (Fluid vs. On-Stop), ensuring the most efficient use of API requests.

### Memory Management
The system is fully integrated with `ResourceTracker`. All queues, observers, and event listeners are automatically reclaimed when the page is restored or the extension is disabled.

## Configuration

| Setting | Default | Description |
| :--- | :--- | :--- |
| `chunkSize` | 250 | Number of segments per API request (Base value, scaled by Optimization Level) |
| `WHOLE_PAGE_SCROLL_STOP_DELAY` | 500ms | User-configurable debounce time after scrolling stops |
| `VIEWPORT_BUFFER_PX` | 100px | Safety margin for batch-filling |
| `rootMargin` | 150px | Recognition margin for node detection |
| `WHOLE_PAGE_USE_TRANSLATION_FONT` | false | Apply the resolved translation `font-family` to safe translated text parents |

---

## References
- [Optimization Levels System](./OPTIMIZATION_LEVELS.md)
- [Translation Provider System](./providers/PROVIDERS.md)
- [Messaging System](./MessagingSystem.md)
- [UI Host System](./UI_HOST_SYSTEM.md)

---

**Last Updated**: November 2026

# Translation System Guide

> **Architecture diagrams:** see [DIAGRAMS.md](DIAGRAMS.md) for the end-to-end pipeline, provider ownership, conversation lifecycle, identity/fragment, terminal-state, and feature-routing diagrams.
>
> **Feature contracts:** see [Feature Behavioral Contracts](../contracts/FEATURE_CONTRACTS.md) for the authoritative per-feature observable outcome contracts on top of this shared pipeline.

The translation system handles translation requests from popup, sidepanel, and content scripts through a **Unified Translation Service** architecture (2025) that provides centralized coordination, duplicate prevention, and intelligent result routing.

## Quick Start

### Frontend Usage
```javascript
// In Vue Components
import { useUnifiedTranslation } from '@/features/translation/composables/useUnifiedTranslation.js'

// For Popup
const { triggerTranslation, isTranslating, translatedText } = useUnifiedTranslation('popup')

// For Sidepanel
const { triggerTranslation, isTranslating, translatedText } = useUnifiedTranslation('sidepanel')

// Translate text
await triggerTranslation(sourceLang, targetLang)
```

### Message Flow
```
UI Component → useMessaging → browser.runtime.sendMessage
     ↓
Background: UnifiedTranslationService → handleTranslate.js
     ↓
TranslationEngine → Provider Execution → Response Parsing → Contract Validation
      ↓
Recovery When Required → Final Merge → Terminal Execution Router
      ↓
Result Dispatcher → Target Context
```

### Unified Translation Service Architecture (2025)

The translation system has been completely redesigned with a **Unified Translation Service** that provides:

**Core Components**:
- **UnifiedTranslationService**: Central coordinator for all translation operations
- **TranslationRequestTracker**: Manages request lifecycle and prevents duplicates
- **UnifiedResultDispatcher**: Intelligent result routing based on translation mode

**Translation Modes**:
- **Field Mode**: Direct response pattern for text field translations
- **Select Element Mode**: Frame-targeted streaming for large content translations
- **Standard Mode**: Regular translation with context-based routing

## Core Architecture

### Translation Handler
**File**: `src/features/translation/handlers/handleTranslate.js`
- Entry point for ALL translation requests
- Integrates with UnifiedTranslationService for centralized processing
- Delegates to UnifiedModeCoordinator for mode-specific handling

### Unified Translation Service
**File**: `src/core/services/translation/UnifiedTranslationService.js`
- **Central coordinator** for all translation operations
- **Request tracking** to prevent duplicate processing
- **Mode-specific routing** for optimal result delivery
- **Lifecycle management** with automatic cleanup

### Translation Request Tracker
**File**: `src/core/services/translation/TranslationRequestTracker.js`
- **Request lifecycle management** from creation to completion
- **Duplicate detection** using messageId-based tracking
- **Element data recovery** for resilient field mode translations
- **Automatic cleanup** of completed requests

### Runtime Ownership And Terminal Rules

Every translation request has one globally unique `messageId`. Exact-ID cancellation, queue removal, rate-limit cleanup, lifecycle aborting, and stream routing use this ID; text, tab, toast, and mode are never cancellation identities.

| Owner | Responsibility |
|---|---|
| Workflow/UI | Current intent, run/session identity, and stale presentation suppression. PDF, page, OCR, and window workflows retain their own session ownership. |
| `TranslationLifecycleRegistry` | `AbortController`, cancellation tombstones, pre-registration cancellation, and execution registration. |
| `TranslationRequestTracker` | Request status, active tab/toast indexes, immutable terminal transitions, and lifecycle metrics. |
| `TranslationEngine` | Provider execution entry point and exact-ID cancellation propagation. |
| `QueueManager` | Provider-execution retry/backoff and exact-ID queue removal. |
| `RateLimitManager` | Admission, concurrency, circuit state, and exact-ID pending-work removal. |
| `StreamingManager` | Sender routing, chunks, local terminal delivery suppression, and delayed stream retention. It does not own workflow lifecycle. |
| `UnifiedResultDispatcher` | Delivery of accepted results and cancellation notifications. Delivery failure never rewrites tracker state. |

Terminal states are `completed`, `failed`, `cancelled`, and `timeout`. `TranslationRequestTracker` accepts one terminal transition only. Rejected late transitions never dispatch a normal result. Tracker records leave active tab and toast indexes immediately; `QueueManager` owns retry/backoff execution.

Cancellation snapshots exact active IDs, marks accepted tracker requests cancelled, notifies their original sender once, then independently attempts lifecycle abort, stream cancellation, rate-limit cleanup, and queue removal. A cancellation tombstone rejects execution when cancellation arrives before lifecycle registration.

Forbidden patterns:
- Raw terminal status writes outside `TranslationRequestTracker`.
- Cancellation by text, mode, tab, or toast rather than exact `messageId`.
- Result delivery before tracker accepts its terminal transition.
- Treating every rejected transition as cancellation.
- Keeping retained terminal records in active indexes.
- Using `StreamingManager` as a workflow lifecycle owner.
- Broad cancellation where exact-ID ownership exists.

## Runtime Architecture Freeze

### Request Identity

One logical request owns one stable, globally unique `messageId` from dispatch through terminal retention. Distinct logical requests must never reuse an ID. The tracker rejects both active and retained terminal IDs; callers must generate a new ID instead of replacing a record.

```text
UI / workflow creates messageId
  -> request tracker registration
  -> lifecycle registration
  -> provider / queue / rate-limit / stream work keyed by messageId
  -> terminal tracker record retained for lifecycle cleanup
```

### Ownership

| Layer | Owns | Does Not Own |
|---|---|---|
| Workflow / UI | Current user intent, run/session identity, stale presentation suppression | Backend lifecycle state |
| `TranslationRequestTracker` | Request lifecycle, active indexes, terminal transition, metrics, terminal retention | Provider aborting, retry execution, or result transport |
| `TranslationLifecycleRegistry` | Abort controllers, tombstones, pre-registration cancellation, execution registration | Tracker terminal state |
| `TranslationEngine` | Provider entry and exact-ID cancellation propagation | UI session ownership |
| `ProviderCoordinator` | Provider selection and admission | Workflow staleness |
| `QueueManager` | Provider-execution retry/backoff and exact-ID removal | Tracker terminal transition |
| `RateLimitManager` | Limiter admission and pending request cleanup | UI delivery |
| `StreamingManager` | Sender routing, chunk transport, local stream terminal suppression, delayed stream retention | Translation workflow lifecycle |
| `UnifiedResultDispatcher` | Accepted result and cancellation delivery; per-instance result deduplication | Tracker state mutation |
| Terminal execution router | Completed and cancelled terminal routing; failed/timeout no-op boundary; one stable terminal outcome per request | Semantic success, recovery strategy, tracker state mutation |
| Execution foundation | Request unit manifest, validation facts, preserved diagnostics | Semantic success, recovery strategy, tracker terminal transition |
| `V3IntervalParser` | Shared structural V3 marker and interval parsing | Semantic validity and recovery policy |
| `TranslationContractValidator` | Canonical provider-contract validity, including V3 marker ownership | Recovery policy and feature mutation |
| `AIResponseParser` | Structured response parsing, mapping, and parser/recovery facts | Semantic provider validity and recovery policy |
| `BaseAIProvider` | Provider-local structured recovery policy, execution, and merge | V3 semantic interpretation and queue retry policy |
| `OptimizedJsonHandler` | Final structured-result orchestration and pre-stream enforcement | Independent V3 semantic validity rules |

### Request Lifecycle

```text
CREATED
  -> TRACKED
  -> REGISTERED
  -> QUEUED / RATE-LIMITED
  -> DISPATCHED
  -> STREAMING (when supported)
  -> COMPLETED | FAILED | CANCELLED | TIMEOUT
  -> retained diagnostic record
  -> periodic cleanup
```

`TranslationRequestTracker` exclusively owns terminal lifecycle transitions. A transition returns an explicit acceptance result. Only an accepted completion may trigger normal result dispatch.

| Current State | Requested Terminal State | Result |
|---|---|---|
| `pending`, `processing`, `streaming` | `completed`, `failed`, `cancelled`, `timeout` | Accepted once |
| Any terminal state | Any terminal state | Rejected without metadata, metric, or timestamp mutation |

Late provider results, errors, timeout callbacks, and duplicate result messages are harmless after a terminal transition because they cannot replace tracker state or trigger normal delivery.

### Exact-ID Cancellation And Timeout

```text
CANCEL_TRANSLATION { messageId }
  -> tracker cancel transition
  -> service-owned stream terminal delivery
  -> cancellation delivery for accepted cancellation
  -> lifecycle abort and tombstone
  -> rate-limit cleanup
  -> queue/retry cleanup

Timeout for messageId
  -> CANCEL_TRANSLATION { messageId, timeout: true }
  -> tracker timeout transition, only while active
  -> service-owned timeout stream terminal delivery
  -> lifecycle abort and tombstone
  -> exact-ID fallback cleanup for unowned requests
  -> late duplicate timeout skips all cleanup
```

Timeout callbacks act only for their original request ID. A rejected service timeout transition means that completion, failure, cancellation, or an earlier timeout already won; no additional service cleanup is attempted.

### Cleanup Matrix

| Terminal Path | Tracker | Lifecycle / Provider | Queue / Rate Limit | Stream / Delivery |
|---|---|---|---|---|
| Success | Completed record retained; active indexes removed | Unregister after execution | Provider completion | Service accepts tracker transition, then stream ends if present |
| Failure | Failed record retained; active indexes removed | Unregister after execution | Retry/reject cleanup | Service publishes error terminal delivery if stream exists |
| Cancellation | Cancelled record retained; active indexes removed | Abort and tombstone | Exact-ID removal | Service publishes one cancellation/end delivery; late chunks ignored |
| Timeout | Timed-out record retained; active indexes removed | Exact-ID abort | Exact-ID removal | Service publishes timeout terminal delivery; later normal delivery is rejected |
| Empty batch | Normal service terminal handling | Batch executor allocates no lifecycle controller or provider work | None | Immediate empty success |
| Retention cleanup | Terminal lifecycle record deleted | None | None | None |

Tracker terminal records leave active tab and toast indexes immediately. They are not eligible for active request selection or bulk cancellation.

### Timeout Ownership Matrix

| Timeout Owner | Request Identity | Terminal Action |
|---|---|---|
| Messaging request timeout | Outgoing `messageId` | Sends timeout-marked exact cancellation |
| Unified streaming coordinator | Active streaming `messageId` | Sends timeout-marked exact cancellation |
| Translation window timeout | Window request `messageId` | Sends timeout-marked exact cancellation before local rejection |
| Smart field timeout | Field request `messageId` | Aborts local operation and sends timeout-marked exact cancellation |
| Generic batch timeout | Batch `messageId` / lifecycle controller | Aborts provider signal; tracker records timeout through service result handling |

### Streaming And Delivery

`StreamingManager` is a transport owner, not a workflow owner. It accepts chunks only while its local stream is active. Its terminal stream states are immutable and its delayed retention exists only for late transport messages.

`UnifiedResultDispatcher` owns delivery after tracker acceptance. Its `processedResults` set is per dispatcher instance, so duplicate-result suppression remains scoped to the owning `UnifiedTranslationService` instance. Delivery failure returns a delivery error and never rewrites accepted tracker state.

Structured contract-invalid results, including invalid V3 results, are rejected
before stream visibility. Recovery and merge complete before downstream
streaming and delivery; consumers receive final validated provider results
rather than raw failed primary candidates. `OptimizedJsonHandler` enforces this
canonical boundary without becoming a second semantic validation owner.

### Specialized Workflow Boundaries

For the logical identity and fragment contract governing structured Select Element and PDF flows, see [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

At the shared architecture boundary, keep these identities distinct:

- **Logical ID**: source/request identity.
- **Positional Wire ID**: provider transport identity in a proven positional-wire batch.
- **V3 Member ID**: marker/member identity inside a V3 parent.

The detailed namespace and fragment rules remain in the identity contract.

| Workflow | Local Owner | Shared Runtime Boundary | Stale Guard |
|---|---|---|---|
| PDF visible blocks | `PdfTranslationCoordinator.activeRunId` | Exact active request IDs | Run ID before block update |
| PDF Region OCR | Region operation and run ID | OCR executor then window translation | Operation/run validation |
| PDF translation windows | Selection session and active message ID | Standard translation request | Session/message validation |
| Page translation | Scheduler session context | Unified batch requests | Session-context validation |
| Hover translation | Current message ID | Standard translation request | Latest-ID check before display |
| Screen OCR | Capture session ID | Downstream window/selection translation | Capture-session validation |
| Text replacement | Local field/toast ownership | Exact field request cancellation | Local message/toast guard |

### Frozen Runtime Invariants

- One logical request owns one stable `messageId`.
- Distinct logical requests never reuse a `messageId`.
- Tracker exclusively owns immutable terminal lifecycle transitions.
- Timeout behaves as exact-ID cancellation and only acts while the same request is active.
- Late callbacks cannot replace terminal state or publish normal stale results.
- Lifecycle ownership is separate from stream transport and UI presentation ownership.
- `StreamingManager` owns transport only; workflows own stale presentation rules.
- Dispatcher owns delivery only; delivery errors never alter tracker terminal state.
- Empty executable batches allocate no provider, lifecycle, timeout, or execution resources.

### Execution Routing

**File**: `src/features/translation/ir/TerminalExecutionRouter.js`

Execution routing is applied after the tracker accepts a terminal transition. The tracker owns the terminal *transition*; the terminal execution router owns terminal *routing*.

Currently adopted terminal paths:
- **Completed**: accepted completion routes through the terminal execution router before normal result delivery.
- **Cancelled**: accepted cancellation routes through the terminal execution router before cancellation delivery.

Failed and timed-out states reach the terminal execution router boundary, whose current policy is a no-op; their lifecycle handling is unchanged. Terminal routing is structural foundation, not provider/key failover, which remains owned by the operation lifecycle.

### Execution Foundation and Diagnostics

**Files**: `src/features/translation/ir/` (request unit manifest, operation, outcome and unit contracts, terminal execution router)

The foundation layer establishes request structure, validation boundaries, and
immutable execution contracts without moving feature ownership into the shared
runtime.

- **Request Unit Manifest**: A deterministic manifest of a request's translation units (`RequestUnitManifest`). It is the structural reference for request membership and mapping facts.
- **Validation boundaries**: `V3IntervalParser` provides structural V3 facts only. `TranslationContractValidator` owns semantic provider-contract validity, including V3 marker ownership. Parser and mapping facts remain separate from recovery policy.
- **TranslationDiagnosticReport Preservation**: Parser and execution facts feed an immutable terminal diagnostic report. `UnifiedTranslationService` retains that report privately in service-owned `WeakMap` storage for internal lifecycle/debugging use; it has no public retrieval, export, persistence, or time-based retention guarantee. This is distinct from tracker lifecycle records.

For provider-owned structured recovery and response-ID namespaces, see
[TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md). For the
identity and fragment contract, see
[TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

> **Deferred**: Runtime production and adoption of `TranslationOutcome` is intentionally deferred to a future initiative. See the [ADR-015 Implementation Status](../../adr/ADR-015-translation-outcome-semantics.md). Runtime adoption should begin only after a concrete `TranslationOutcome` consumer has been defined.

### Unified Result Dispatcher
**File**: `src/core/services/translation/UnifiedResultDispatcher.js`
- **Intelligent result routing** based on translation mode
- **Direct response** for field mode translations
- **Frame-targeted streaming delivery** for Select Element requests, using the originating tab/frame
- **Tab-specific routing** for context isolation

`TranslationResultDispatcher.js` remains in-tree but has no consumer in the checked runtime source; `UnifiedTranslationService` uses `UnifiedResultDispatcher.js` for result delivery.

### Vue Composables
**File**: `src/features/translation/composables/useUnifiedTranslation.js`
- Unified reactive translation state management for both popup and sidepanel
- Context-specific message filtering and error handling
- Integrated with `useSettingsStore` for automatic language resolution

### Translation Engine
**File**: `src/features/translation/core/translation-engine.js`
- Provider coordination and selection
- Cache management via `StorageCore`
- Intelligent provider waterfall logic

## Translation Flows

### 1. Popup Translation
```
User Input → useUnifiedTranslation('popup') → handleTranslate.js → Provider → UI Update
```

### 2. Sidepanel Translation  
```
User Input → useUnifiedTranslation('sidepanel') → handleTranslate.js → Provider → UI Update
```

### 3. Select Element Translation
```
DOM Selection → Structured Provider Response → Parse / Validate
      ↓
Recovery / Merge When Required → Final Validation → Stream Final Results
      ↓
BlockGroup Reconstruction → DOM Apply
```

### 4. Subtitle Translation
```
File Upload → SubtitleTranslationCoordinator → Progressive Batching → SrtAdapter → UI Preview
```
*Note: Subtitle translation uses the unified provider infrastructure but maintains a decoupled orchestration flow to handle large file volumes and format preservation.*

**Special Processing**: Select element mode uses streaming for large content:
- **Streaming Updates**: Real-time translation progress
- **JSON Processing**: Efficient handling of multiple text elements
- **Frame-targeted Results**: Updates, errors, and completion target the originating tab/frame; internal extension contexts use runtime messaging
- **Progress Tracking**: Visual feedback during translation

Select Element receives final accepted structured results. Detailed provider
recovery policy belongs in [TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md),
while V3 identity and fragment rules belong in
[TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

### 4. Field Mode Translation (New)
```
Text Field → Direct Request → UnifiedTranslationService → Direct Response → Field Update
```

**Field Mode Characteristics**:
- **Direct Response**: No broadcast, results returned directly
- **Element Tracking**: Resilient element reference management
- **Queue-Free**: Eliminated complex queueing mechanism
- **Duplicate Prevention**: Request tracking prevents multiple processing

## Provider System

> **Contracts:** [Provider Contract](../contracts/PROVIDER_CONTRACT.md) (result/error/retry/health/stats) and [Conversation Contract](../contracts/CONVERSATION_CONTRACT.md) (AI conversation-candidate lifecycle).

### Supported Providers
- **Google Translate** (Free, default)
- **DeepL** (AI-powered with formal/informal styles)
- **Google Gemini** (AI-powered)
- **OpenAI** (GPT models)
- **Bing Translate** (Free tier)
- **Yandex** (Free tier)
- **DeepSeek** (AI service)
- **OpenRouter** (AI aggregator)
- **Requesty** (AI aggregator)
- **WebAI** (AI service)
- **Browser API** (Chrome 138+)
- **Custom APIs** (OpenAI-compatible)

### Provider Interface
```javascript
class BaseProvider {
  async translate(text, sourceLang, targetLang, mode) {
    // Implementation
    return {
      translatedText: 'result',
      sourceLanguage: 'detected',
      targetLanguage: 'target',
      provider: 'name'
    }
  }
}
```

### Provider Selection
```javascript
// In TranslationEngine
const provider = this.factory.getProvider(data.provider || 'google-translate')
const result = await provider.translate(text, sourceLang, targetLang, mode)
```

### Structured-Response Recovery

When a structured batch response violates its contract, the system recovers
explicitly instead of silently corrupting results. Contract failures do not
automatically require full-batch recovery.

- **`AIResponseParser`** provides parser and mapping facts; it does not decide semantic validity or recovery policy.
- **`BaseAIProvider`** owns provider-local recovery policy. It may selectively recover safely mapped invalid items, preserving valid primary results, or use full sequential recovery when mapping is unsafe.
- **Recovery and merge complete before final delivery.** Repair-aware recovery context may be supplied to structured recovery, and recovery failure becomes a typed provider failure.

See [TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md) for the
canonical provider execution and recovery policy. Queue retry remains separate
from structured recovery and is owned by the existing queue/request
infrastructure.

Structured recovery remains conversation-isolated; see
[CONVERSATION_CONTRACT.md](../contracts/CONVERSATION_CONTRACT.md) for the full
conversation lifecycle.

## Context Separation

### Multi-Context Isolation
The system ensures that translation results are routed only to the initiating context (Popup, Sidepanel, or Content Script). This prevents cross-component interference.

### Implementation
Context-based message filtering:
```javascript
// Each component filters by context
browser.runtime.onMessage.addListener((message) => {
  if (message.context !== MessagingContexts.POPUP) {
    return false // Ignore non-popup messages
  }
  // Handle popup-specific updates
})
```

## Message Format

### Standard Message
```javascript
{
  action: "TRANSLATE",
  context: "popup", // or "sidepanel", "content"
  data: {
    text: "Hello",
    provider: "google-translate",
    sourceLanguage: "auto",
    targetLanguage: "fa",
    mode: "Popup_Translate"
  }
}
```

### Result Message
```javascript
{
  action: "TRANSLATION_RESULT_UPDATE",
  context: "popup",
  data: {
    translatedText: "سلام",
    originalText: "Hello",
    provider: "google-translate",
    sourceLanguage: "en",
    targetLanguage: "fa"
  }
}
```

## Error Handling

### Translation Errors
```javascript
try {
  const result = await provider.translate(text, sourceLang, targetLang)
} catch (error) {
  return {
    success: false,
    error: {
      message: error.message,
      code: 'TRANSLATION_FAILED',
      provider: providerName
    }
  }
}
```

### Failure Handling

There is **no automatic cross-provider fallback**. If a translation request fails, the system does **not** substitute another provider. Instead it applies recovery mechanisms **within the selected provider**, then surfaces a final typed failure to the caller:

- **QueueManager retry**: transient errors (e.g. `NETWORK_ERROR`, `RATE_LIMIT_REACHED`, `SERVER_ERROR`) are retried by `QueueManager` with backoff according to error policy before a final failure is reported.
- **API-key failover**: `ProviderRequestEngine` may rotate to another API key **of the same provider** (e.g. `RATE_LIMIT_REACHED`, `API_KEY_INVALID`, `QUOTA_EXCEEDED`).
- **BaseAIProvider structured recovery**: a structured contract violation triggers selective provider recovery when mapping is safe, otherwise full sequential provider recovery (`STRUCTURED_RECOVERY`); recovery failure becomes a typed failure.
- **No cross-provider fallback**: the selected provider's final failure is returned to the caller.

These are distinct mechanisms; do not label QueueManager retry, key failover, or structured recovery with the single term "fallback."

## Development Guide

### Adding New Translation Context
1. Create composable in `src/composables/useNewContextTranslation.js`
2. Add context to `MessagingContexts` in `MessagingCore.js`
3. Register mode in `config.js` `TranslationMode`
4. Update message listeners for context filtering

### Adding New Provider
1. Implement `BaseProvider` interface
2. Add to `ProviderFactory.js`
3. Register in `ProviderRegistry.js`
4. Add API key handling in settings

### Debugging Translation Issues
1. Check browser console for errors
2. Monitor background service worker logs
3. Verify message format in `handleTranslate.js`
4. Test provider API connectivity
5. Check context filtering in composables

## Performance

### Optimization Strategies
- **Provider Caching**: Reuse provider instances
- **Result Caching**: Avoid duplicate API calls
- **Message Efficiency**: Minimal payload size
- **Context Routing**: Direct message routing

### Bundle Sizes
- **Popup**: ~6KB
- **Sidepanel**: ~8KB  
- **Content Script**: ~100KB (optimization ongoing)

## Key Files

### Core Files - Unified Translation Service (2025)
- `src/core/services/translation/UnifiedTranslationService.js` - Central translation coordinator
- `src/core/services/translation/TranslationRequestTracker.js` - Request lifecycle management
- `src/core/services/translation/UnifiedResultDispatcher.js` - Intelligent result routing
- `src/features/translation/handlers/handleTranslate.js` - Translation request handler
- `src/features/translation/core/StreamingManager.js` - Central streaming terminal delivery
- `src/features/translation/core/translation-engine.js` - Provider coordination

### Execution Foundation (Translation Pipeline Foundation)
- `src/features/translation/ir/RequestUnitManifest.js` - Deterministic request unit manifest
- `src/features/translation/ir/TerminalExecutionRouter.js` - Completed and cancelled terminal routing
- `src/features/translation/ir/TranslationOperation.js` - Execution lifecycle and diagnostics collection
- `src/features/translation/ir/TranslationOutcome.js` - Immutable outcome contract
- `src/features/translation/ir/TranslationUnit.js` - Unit disposition contract

### Integration Files
- `src/handlers/smartTranslationIntegration.js` - Field mode integration with element recovery
- `src/handlers/content/ContentMessageHandler.js` - Content script message handling

### Supporting Files
- `src/shared/messaging/core/UnifiedMessaging.js` - Unified messaging system
- `src/shared/messaging/core/UnifiedTranslationCoordinator.js` - Streaming coordination
- `src/features/translation/stores/` - Translation state management
- `src/features/translation/providers/` - Provider implementations

## Summary

The translation system provides:
- **Unified Architecture**: All translations coordinated through UnifiedTranslationService
- **Duplicate Prevention**: Request tracking eliminates duplicate processing
- **Mode-Specific Routing**: Optimal result delivery based on translation mode
- **Resilient Element Management**: Smart recovery for field mode translations
- **Streaming Support**: Real-time updates for large content translations
- **Context Isolation**: Components only receive relevant messages
- **Provider Flexibility**: Easy switching between translation services
- **Cross-Browser Support**: Chrome and Firefox compatibility
- **Error Resilience**: Comprehensive error handling and recovery

**Key Insight**: The **UnifiedTranslationService** is the core of all translation operations, providing centralized coordination, intelligent routing, and comprehensive lifecycle management for all translation requests regardless of source or mode.

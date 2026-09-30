# Translation Runtime Architecture

## Purpose and scope

This guide explains how translation work enters the background runtime, crosses shared execution boundaries, and reaches feature consumers. It describes current production structure, not a guarantee that every mode uses every component. Use the [contracts](../contracts/README.md) for behavior guarantees and ownership, and check implementation status before treating an accepted [ADR](../../adr/) as fully deployed.

For repository-wide context, see the [architecture overview](../ARCHITECTURE.md). For flow diagrams, see [DIAGRAMS.md](DIAGRAMS.md).

## Runtime entry points

The service worker's `LifecycleManager` registers the background message handlers. A standard `TRANSLATE` action is registered to the lazy `handleTranslateLazy` wrapper; that wrapper loads `handleTranslate`, which validates the message and delegates to `UnifiedTranslationService`.

Other workflows may enter the shared translation service through their own handlers:

- Whole-page batches arrive as `PAGE_TRANSLATE_BATCH` through `handlePageTranslation`.
- Subtitle translation starts a job through `handleSubtitleTranslation`; `SubtitleTranslationCoordinator` plans the job and submits shared batch requests while it owns job state, progress, and cancellation.
- UI and content features may originate standard requests through their messaging/composable paths.

The page and subtitle handlers are distinct feature entry points, not aliases for the standard `TRANSLATE` handler. The subtitle job's long-running workflow is separate from the individual shared translation requests it issues.

## Standard request path

For a standard `TRANSLATE` message, the current high-level route is:

```text
UI or content feature
  → browser runtime message
  → MessageHandler
  → handleTranslateLazy → handleTranslate
  → UnifiedTranslationService
  → UnifiedModeCoordinator
  → TranslationEngine
  → ProviderCoordinator → QueueManager → provider request
  → accepted result or typed failure
  → direct response and/or mode-specific feature delivery
```

`UnifiedTranslationService` resolves request-level provider selection, registers and tracks the request, supplies execution context, and coordinates mode processing and terminal handling. `UnifiedModeCoordinator` chooses the execution path for the mode. `TranslationEngine` and `ProviderCoordinator` execute the selected provider; queue scheduling, physical provider calls, and response interpretation remain lower-layer concerns.

This is not the only route into shared execution. Whole-page batch actions call the service from their handler. A subtitle job is coordinated separately and calls the shared service for each batch. See [Whole Page Translation](../WHOLE_PAGE_TRANSLATION.md) and [Subtitle Translation](../SUBTITLE_TRANSLATION_SYSTEM.md) for feature details.

## Request and execution ownership

| Concern | Owner and boundary |
| --- | --- |
| Background message registration | `LifecycleManager` registers handlers with `MessageHandler`; lazy wrappers load feature handlers when actions arrive. |
| Shared translation request | `UnifiedTranslationService` resolves provider choice, registers the request, coordinates mode processing, and handles terminal outcomes and delivery. |
| Mode-specific execution | `UnifiedModeCoordinator` routes standard, Field, Select Element, Page, PDF, and Subtitle modes to their respective execution paths. |
| Provider selection and execution | `UnifiedTranslationService` resolves the provider; `ProviderCoordinator` orchestrates execution for that selected provider. |
| Queue retry | `QueueManager` owns queued retry/backoff for provider execution. It is distinct from provider recovery. |
| API-key failover | `ProviderRequestEngine` / `ApiKeyManager` may move between keys for the same selected provider. |
| Structured-response recovery | `BaseAIProvider` owns provider-local recovery policy after structured-response violations. `OptimizedJsonHandler` owns structured batch orchestration, fragment aggregation, parent validation, and the pre-stream acceptance boundary. |
| Request terminal state | `TranslationRequestTracker` accepts or rejects terminal transitions. `TranslationLifecycleRegistry` tracks abort controllers and cancellation tombstones for provider execution. |
| Feature application | Feature workflows own mode-specific state and application to page/document/UI resources. The shared provider layer does not own feature mutation or presentation. |
| Conversation acceptance | For eligible structured Select Element parent work, Content acceptance and Background conversation commit form a separate lifecycle from provider execution. |

These boundaries are intentionally separate. Provider-local structured recovery, queue retry, same-provider API-key failover, and switching providers are not one fallback mechanism; the selected-provider path has no automatic cross-provider fallback. See the [Provider Contract](../contracts/PROVIDER_CONTRACT.md) and [provider execution guide](../TRANSLATION_PROVIDER_LOGIC.md).

## Request identity and terminal lifecycle

The `messageId` supplied with a request is the shared request/lifecycle key used by tracking, cancellation, queue cleanup, streaming, and result routing. It is not a translation-unit identity. The runtime tracks that supplied ID; callers remain responsible for providing IDs that do not collide with other logical requests. Structured unit identities and fragment mapping belong to the [Identity & Fragment Contract](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

The service registers a request with `TranslationRequestTracker` and accepts one terminal transition among `completed`, `failed`, `cancelled`, or `timeout`. Once terminal, a later completion, failure, cancellation, or timeout cannot replace the accepted state or dispatch a normal result. Terminal requests leave active indexes immediately and remain in tracker storage until cleanup.

Timeout and user cancellation are distinct. On the service-owned timeout path, `UnifiedTranslationService` marks the exact request timed out before engine abort/cleanup; service-owned user cancellation likewise records its terminal state before aborting. A batch-owned timeout may abort locally first and then follow mode-specific service result handling, which need not record a `timeout` tracker state. A cancellation that arrives before provider execution registration is retained as a lifecycle tombstone so later registration cannot start that request. Cancellation handlers may first select IDs by tab/context/session for bulk requests, but cleanup and abort then operate on each exact `messageId`.

Timeouts may originate at different boundaries, including messaging, active-request expiry, stream handling, and feature-owned batch workflows. These paths use the original request ID without sharing one terminal ordering or tracker outcome. Streaming end/error messages report transport state; they do not replace request-tracker ownership of service terminal state. See [Messaging System](../MessagingSystem.md) for message/timeouts details and the [Provider Contract](../contracts/PROVIDER_CONTRACT.md) for typed timeout/cancellation semantics.

## Cancellation path

For service-owned requests, `handleCancelTranslation` delegates cancellation or timeout to `UnifiedTranslationService` first. The service attempts the corresponding tracker transition, publishes any stream terminal event, finalizes accepted execution routing, and requests engine cancellation. The handler then performs exact-ID cleanup for queue and rate-limit work, with engine/stream fallbacks for requests not handled by the service. When cancellation predates engine registration, `TranslationLifecycleRegistry` keeps the exact ID in a tombstone so registration observes the cancellation.

This ordering keeps request state, provider abort, queue/rate-limit cleanup, and stream cleanup coordinated without making the stream transport the workflow owner. See the [terminal and cancellation diagrams](DIAGRAMS.md#5-error--terminal-state-flow) and [Provider Contract](../contracts/PROVIDER_CONTRACT.md#13-timeout-and-cancellation).

## Streaming and result delivery

`StreamingManager` owns chunk and stream-terminal transport, sender routing, and stream cleanup. It does not own the feature's run/session lifecycle or determine semantic success. A feature may use streaming or a direct result path depending on mode.

After the service accepts a terminal transition, it delivers a result through the relevant route. `UnifiedResultDispatcher` handles supported routed results, including frame-targeted Select Element delivery. Field mode returns the result directly from `UnifiedTranslationService` before its dispatcher call; it still follows provider execution and queue processing. Delivery failure may be returned to the caller, but it does not rewrite an already accepted tracker terminal state.

`TranslationResultDispatcher.js` remains in the repository but has no consumer in the checked runtime source; current routed delivery uses `UnifiedResultDispatcher`.

For structured Select Element and PDF execution, invalid structured/V3 results are rejected before they become stream-visible. The dispatch/stream handoff does not itself establish feature acceptance. In particular, a successful message send to Content is transport delivery, not proof that a reconstructed Select Element parent passed its feature acceptance boundary.

## Structured execution foundation

For structured batches, `RequestUnitManifest` records internal request-unit membership (`unitId` and `requestIndex`) and the declared mapping strategy; it is execution metadata, not a provider payload schema. `TranslationOperation` carries operation lifecycle, accepted unit settlement, provider execution facts, and bounded diagnostics. It does not own feature resource mutation.

Structured response processing has separate structural, semantic, and recovery owners:

1. `AIResponseParser` parses and maps provider response data and packages parser/mapping facts.
2. `V3IntervalParser` extracts V3 marker/interval structure only.
3. `TranslationContractValidator` owns semantic provider-contract validation, including V3 marker ownership.
4. `BaseAIProvider` owns provider-local structured recovery policy and execution after a structured contract violation.
5. `OptimizedJsonHandler` aggregates fragments and structured batches, enforces final validation before stream visibility, and coordinates parent-level handling where required.

The distinct recovery layers should not be conflated: `BaseAIProvider` owns provider-local structured-response recovery (`STRUCTURED_RECOVERY`); `OptimizedJsonHandler` may coordinate parent-level recovery (`PARENT_RECOVERY`) after parent validation; both are separate from `QueueManager` retry. For the detailed rules and call-purpose distinctions, see [Translation Provider Logic](../TRANSLATION_PROVIDER_LOGIC.md) and the [Provider Contract](../contracts/PROVIDER_CONTRACT.md).

The adopted `TerminalExecutionRouter` is a bounded execution-foundation component: `COMPLETED` settles accepted units and `CANCELLED` cancels remaining units; its current `FAILED` and `TIMEOUT` policies are no-ops. This structural settlement routing does not decide semantic translation success or replace request tracking.

`UnifiedTranslationService` finalizes diagnostic reports from operation facts and keeps them in private service-owned `WeakMap` storage; they are not a public retrieval/export API. Avoid inferring more persistence or retention guarantees from that internal storage.

## Mode and feature boundaries

- **Standard UI and selection requests** use the shared request/service path, while their requesting UI or window owns the visible state.
- **Field** runs through `UnifiedModeCoordinator` and `TranslationEngine`; the service returns its result directly. Field insertion/replacement is owned by the field feature, not by provider execution.
- **Select Element** uses structured batches and frame-targeted streaming/result delivery. Content reconstructs and validates logical parents before applying them. For eligible AI conversation work, Background registers an immutable parent handoff; Content `FinalAcceptance` and acknowledgement precede ordered conversation-history commit. This acceptance lifecycle is separate from provider completion and operation terminal state.
- **Whole Page** uses page feature orchestration for traversal, batching, progress, and DOM application. `PAGE_TRANSLATE_BATCH` enters the shared translation service for provider work; the page feature owns page mutation and its run/session state.
- **Subtitle** starts as a job owned by `SubtitleTranslationCoordinator`; it sends batches through the shared translation service and owns cue-level progress, output formatting, and cancellation.
- **PDF** uses the shared structured execution foundation while PDF coordinators/adapters own document session and cell/block application.
- **Hover, selection windows, OCR, and other UI workflows** may call shared translation execution but retain their own user-interaction and stale-result/session boundaries.

The full observable behavior for modes belongs in [Feature Contracts](../contracts/FEATURE_CONTRACTS.md), not in this shared-runtime summary.

## Adoption status

- **ADR-015:** Structural execution contracts, diagnostics preservation, shared validation, and completed/cancelled terminal routing are present. Universal runtime production and feature consumption of `TranslationOutcome` remain explicitly deferred; runtime result shapes have not universally migrated.
- **ADR-016:** Provider completion normalization is an architectural decision with incremental adoption. Do not assume every provider has fully adopted the complete completion contract.
- **ADR-017:** Execution and conversation acceptance are separate lifecycles. Current eligible Select Element parent flows use the handoff/acceptance coordination path; the conversation contract remains scoped to its documented participation and migration status.

Accepted decisions describe architecture, not proof of adoption. Compare their status with production code and tests before making claims about deployed behavior.

## Further reading

- [Architecture Diagrams](DIAGRAMS.md) — current runtime flow, provider ownership, conversation lifecycle, terminal states, and feature routing.
- [Feature Contracts](../contracts/FEATURE_CONTRACTS.md) — per-mode observable behavior and feature-owned application.
- [Provider Contract](../contracts/PROVIDER_CONTRACT.md) — provider results, retries, failover, recovery, and typed failures.
- [Conversation Contract](../contracts/CONVERSATION_CONTRACT.md) — parent acceptance, conversation turns, and lifecycle boundaries.
- [Identity & Fragment Contract](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) — structured request/response identities and fragment aggregation.
- [Translation Provider Logic](../TRANSLATION_PROVIDER_LOGIC.md) and [Provider Implementation Guide](../providers/PROVIDERS.md) — provider choice, execution, and recovery.
- [Messaging System](../MessagingSystem.md) — cross-context request, response, timeout, and streaming transport.
- [Select Element](../SELECT_ELEMENT_SYSTEM.md), [Whole Page](../WHOLE_PAGE_TRANSLATION.md), [Subtitle](../SUBTITLE_TRANSLATION_SYSTEM.md), and [PDF](../pdf-translator/PDF_TRANSLATION_ARCHITECTURE.md) guides — feature-specific orchestration.
- [ADR-015](../../adr/ADR-015-translation-outcome-semantics.md), [ADR-016](../../adr/ADR-016-provider-completion-contract.md), and [ADR-017](../../adr/ADR-017-conversation-acceptance-lifecycle-ownership.md) — accepted decisions and adoption notes.

# Select Element System

Select Element lets user choose DOM subtree, translate its accepted logical
parents, and preserve each completed parent independently. `SelectElementManager`
owns feature lifecycle. `DomTranslatorAdapter` owns page mutation. Shared
translation services own provider execution, validation, recovery, and request
lifecycle.

## Translation Font

`SELECT_ELEMENT_USE_TRANSLATION_FONT` is disabled by default. When enabled,
Select Element applies resolved translation `font-family` only to immediate,
text-only parents. Mixed or unsafe content is skipped without affecting
translation. Font changes use normal inline styles and Select Element ownership
tracking, so revert restores prior values while preserving external changes.

This document explains feature architecture and integration. Observable
behavior is defined by [Feature Behavioral Contracts](contracts/FEATURE_CONTRACTS.md#6-select-element-contract).

## Scope and Authoritative Contracts

Use this document for:

- Select Element lifecycle and ownership;
- selection and extraction architecture;
- DOM commit and preservation behavior;
- integration with shared translation, recovery, conversation, and error systems;
- current feature file map and debugging entry points.

Authoritative documents:

- [Feature Behavioral Contracts](contracts/FEATURE_CONTRACTS.md#6-select-element-contract): observable Select Element behavior.
- [Translation Identity and Fragment Contract](contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md): identity, fragments, and acceptance mapping.
- [Translation Provider Logic](TRANSLATION_PROVIDER_LOGIC.md): provider selection, structured validation, and recovery.
- [Conversation Contract](contracts/CONVERSATION_CONTRACT.md): logical-parent history participation and acceptance.
- [ADR-015: Translation Outcome Semantics](../adr/ADR-015-translation-outcome-semantics.md): shared outcome model and adoption boundary.
- [ADR-016: Provider Completion Contract](../adr/ADR-016-provider-completion-contract.md): provider completion concepts.
- [Error Management System](ERROR_MANAGEMENT_SYSTEM.md): public error and feedback ownership.
- [Provider Contract](contracts/PROVIDER_CONTRACT.md): provider result, retry, and failure guarantees.

Select Element must not redefine provider recovery, identity namespaces,
conversation history, provider completion, or global error policy here.

## End-to-End Architecture

```text
activation
  -> selection and highlighting
  -> click-time root validation
  -> SelectElementPolicy capability check
  -> provider and extraction-mode resolution
  -> V2 or V3 extraction
  -> UnifiedTranslationService request
  -> UnifiedModeCoordinator
  -> TranslationEngine / ProviderCoordinator
  -> OptimizedJsonHandler where structured handling applies
  -> provider execution, parsing, validation, and provider-local recovery
  -> streaming or direct result
  -> logical-parent identity and completeness validation
  -> transactional DOM parent commit
  -> conversation acceptance ACK when registered
  -> final direction/state completion
  -> manager cleanup and user feedback
```

Ownership is intentionally split:

| Responsibility | Owner |
| --- | --- |
| Activation and mode lifecycle | `SelectElementManager` and activation handlers |
| Highlighting and candidate heuristics | `ElementSelector` |
| Root/traversal/capability taxonomy | `SelectElementPolicy` |
| Text extraction | `DomTranslatorUtils` |
| V2 direct-parent orchestration | `DomTranslatorAdapter` |
| V3 group reconstruction | `BlockGroupReconstructor` through `DomTranslatorAdapter` |
| DOM mutation and feature snapshots | `DomTranslatorAdapter`, `DomTranslatorState` |
| Provider resolution and request lifecycle | `UnifiedTranslationService` |
| Mode routing and priority | `UnifiedModeCoordinator` |
| Provider execution and structured orchestration | `TranslationEngine`, `ProviderCoordinator`, `OptimizedJsonHandler` |
| Conversation acceptance | `ConversationAcceptanceCoordinator` |
| Public terminal error display | `PublicTranslationErrorPolicy`, `PublicTranslationErrorAdapter`, `ErrorHandler`, and feature-owned feedback |
| Extension context recovery | `ExtensionContextManager` |
| Select Element toast lifecycle | `SelectElementNotificationManager` |

No single component owns this complete pipeline.

## Behavioral Contract

The feature contract defines the complete observable behavior. Core invariants:

- A complete logical parent may commit independently of unrelated parents.
- An incomplete or invalid logical parent remains original.
- A later provider or batch failure does not revert committed sibling parents.
- User cancellation and conflict cancellation preserve committed content.
- Failure and cancellation do not automatically perform explicit revert.
- Explicit revert is separate from cancellation and restores stored original state.
- During active selection, single Esc cancels the mode and is consumed by the manager.
- Outside active selection, global cancellation and revert require Double Esc. Both browser events remain available to the website; repeated and modifier Escape presses do not count.
- Raw provider fragments are not feature-visible results.
- Public feedback uses feature and shared error boundaries, not raw runtime text.

## Activation Lifecycle

Typical activation flow:

```text
Popup / sidepanel / command caller
  -> UnifiedMessaging
  -> lazy background activation handler
  -> handleActivateSelectElementMode
  -> ContentMessageHandler
  -> SelectElementManager.activateSelectElementMode()
```

Activation initializes the manager and selector, starts the context watchdog,
installs interaction listeners, and shows the top-frame activation status toast.
The manager synchronizes active state with background state.

Restricted pages preserve restricted-page metadata and do not attempt content
activation. Iframe activation uses `IFRAME_ACTIVATE_SELECT_ELEMENT` and the
Select Element branch of `IFRAME_COORDINATE_OPERATION`.

An activation refusal from a frame that reports `activated: false` (no active
Select Element manager in that frame, for example a feature-load failure) is an
explicit negative confirmation and discharges that frame's provisional cleanup
ownership in the background. A refusal that reports `activated: true` (an
already-active manager, for example exclusion settings changed mid-session) is
not a negative confirmation and keeps the frame's cleanup ownership. Ambiguous
or undelivered activation outcomes also keep the frame's cleanup ownership until
it can be resolved.

Unexpected activation failures use the shared
`getSelectElementActivationErrorMessage()` contract and
`ErrorTypes.SELECT_ELEMENT`. Original exceptions remain diagnostic only; raw
runtime messages do not cross activation response boundaries.

## Selection and SelectElementPolicy

Selection has separate contracts for:

1. root eligibility: may this element be selected;
2. descendant traversal: may extraction enter this subtree;
3. extraction capability: can the resolved V2/V3 mode represent the category.

`SelectElementPolicy` is feature-local source of truth for this taxonomy. It
does not own DOM traversal, text-unit filtering, provider selection, or UI
feedback.

`elementHelpers.isSelectableTextRoot()` composes policy root eligibility,
ancestor `notranslate` checks, and meaningful-text checks. `ElementSelector`
adds selection heuristics such as area and text thresholds. `handleClick()`
revalidates root eligibility after hover and before translation; hover state is
not trusted as a click-time authorization.

Important policy examples:

- `BUTTON` and `role="button"` are ordinary traversable content.
- `SELECT` is a traversable label container but is not a selectable root.
- `OPTION` label text is traversable only with explicit `value` attribute.
- `PRE` and `CODE` can be selectable roots but require V3 capability for traversal.
- `KBD` and `SAMP` are preformatted categories with mode-dependent capability.
- `role="code"` is excluded during descendant traversal.
- Nested GitHub code classes are excluded; explicit-root behavior is intentionally distinct.
- Editable controls, exclusion markers, hidden roots, excluded roles, and
  non-content tags are rejected according to the relevant axis.

The exhaustive taxonomy belongs in `SelectElementPolicy.js` and its tests, not
in this document.

## Extraction Modes: V2 and V3

V2 and V3 are Select Element extraction strategies, not provider protocols.

### V2 Direct Extraction

V2 is selected for traditional providers or when semantic block grouping is
disabled. `collectTextNodes()` returns accepted text nodes with stable
operation-local identity and structural parent information. The adapter sends
direct units and aggregates them into direct-parent states by block identity.

Each direct parent tracks expected units, pending results, source validity,
application state, and acceptance state. A direct parent commits only when all
required units are valid and present.

### V3 Semantic Grouping

V3 is selected when the provider is AI-capable and semantic block grouping is
enabled. `collectBlockGroups()` creates `TranslationUnit` records with:

- unit identity;
- logical block identity;
- source text and whitespace boundaries;
- direction hints;
- inline parent information;
- preformatted mode information;
- source DOM node reference.

Units are assembled by logical parent. `BlockGroupReconstructor` injects and
validates reconstruction markers, parses provider output, and applies a group
transactionally.

Preformatted V3 units may use `V2_PASSTHROUGH`. This preserves unit-level
transport for content that should not receive marker reconstruction while
remaining inside the V3 operation model.

## Logical Parent and BlockGroup Model

UID mapping remains necessary, but it is not the acceptance model.

| Term | Meaning |
| --- | --- |
| Translation unit | One extracted text unit associated with a DOM text node. |
| Direct parent | V2 parent state aggregating units by structural parent identity. |
| BlockGroup | V3 logical parent containing related `TranslationUnit` records. |
| Provider fragment | Transport or provider output fragment that is not independently feature-visible. |
| Logical parent | Semantic parent-level unit that must pass completeness and content validation before acceptance. |
| Committed parent | Logical parent whose validated content was applied to the DOM. |

The feature validates identity, duplicates, content, expected membership, and
completion before parent acceptance. Split or incomplete fragments remain
pending or unresolved. Independent sibling parents may be accepted and
committed while another parent fails.

One provider batch or physical response can contain several logical parents;
one logical parent can span several provider fragments. These are not
interchangeable terms.

## DOM Commit, Rollback, and Preservation

`DomTranslatorAdapter` owns feature DOM mutation. The mutation boundary includes
source and ownership validation before accepting a result.

Direct-parent and BlockGroup paths use parent-local transactional behavior:

- connected node and source-content validation occur before mutation;
- identity and content validation occur before acceptance;
- direct source-drift validation prevents stale captured source from being
  mutated;
- reconstruction calculates the commit plan before DOM writes;
- a failed parent mutation rolls back that parent transaction;
- previously committed sibling parents are not globally rolled back;
- stale source nodes remain original;
- invalid, missing, blank, or suppressed results do not replace source content.

Rollback uses the shared `runBestEffortRollback()` helper in
`src/utils/dom/DomRollback.js`. Restoration runs in order and continues after an
individual restoration failure; rollback failures are aggregated and preserved
as secondary diagnostics while the primary mutation error remains authoritative.

Mutation failures surface as typed errors:

- `DirectMutationFailure` — direct-parent mutation failure;
- `BlockGroupMutationFailure` — block-group mutation failure.

A failed parent mutation results in parent rejection rather than leaving
acceptance pending, so the background coordinator settles the parent and does
not block later parents.

`BlockGroupReconstructor` performs atomic group application and restores its
own text, attributes, direction, hover state, and temporary class state on
mutation failure.

Final direction application occurs after accepted parent results are finalized.
Context ownership is revalidated before finalization so context loss cannot
perform late direction or state finalization.

`DomTranslatorState` stores immutable session-scoped original snapshots and
translation history for explicit revert. It is not the provider result store.

## Shadow DOM Readiness

Production Select Element Shadow DOM translation is **gated off**
(`SELECT_ELEMENT_SHADOW_DOM_ENABLED = false` in
`src/features/element-selection/utils/shadowDom.js`). This must not be
interpreted as production Shadow DOM translation support.

Established preparation includes:

- composed interaction-target resolution across available event paths
  (`getSelectEventElements`, `resolveSelectInteractionElement`);
- open-shadow traversal infrastructure for future extraction support;
- composed ownership and ancestry checks (`isComposedDescendant`,
  `isSelectShadowNode`, `iterateSelectElementAncestors`);
- shadow-aware direction/BiDi preparation;
- revert and mutation-safety preparation.

Until the gate is enabled, Select Element does not extract or translate
shadow-contained content. Shadow-DOM interactions may still resolve to their
retargeted host through the normal Select Element interaction path.

## Provider and Recovery Integration

Select Element composes the shared provider pipeline:

```text
provider response
  -> parser and response mapping
  -> TranslationContractValidator
  -> provider-local structured recovery when required
  -> merged accepted structured result
  -> OptimizedJsonHandler pre-stream validation
  -> Select Element logical-parent validation
  -> DOM acceptance
```

Recovery is not a second Select Element lifecycle. It is provider-layer work
that completes before invalid structured output becomes feature-visible.

Ownership boundaries:

- `V3IntervalParser` parses structural marker/interval facts.
- `TranslationContractValidator` owns semantic provider-contract validity.
- `AIResponseParser` owns syntax decoding, mapping, and generic recovery facts.
- `BaseAIProvider` owns structured recovery policy and execution.
- `OptimizedJsonHandler` enforces the final structured-result boundary before
  stream visibility.
- Select Element owns logical-parent acceptance and DOM application.

Structured recovery is separate from QueueManager retry, provider failover,
and cross-provider fallback. See [Translation Provider Logic](TRANSLATION_PROVIDER_LOGIC.md)
for recovery policy and [Provider Contract](contracts/PROVIDER_CONTRACT.md) for
provider execution guarantees.

## Streaming and Completion Semantics

The adapter supports streaming and direct responses. Both paths converge on
the same identity, content, logical-parent, transaction, ACK, and finalization
rules.

These are separate facts:

```text
provider call completed
  != provider result contract valid
  != logical parent accepted
  != DOM parent committed
  != conversation turn committed
```

A successful provider transport response with no accepted logical parent is
not feature success. Invalid or incomplete fragments cannot become
feature-visible merely because provider execution reached a terminal state.

All-committed late stream failures may be treated as effective feature success
when the existing operation-local commit rule applies. Context ownership loss
has precedence and produces context invalidation instead.

Provider completion concepts are defined by [ADR-016](../adr/ADR-016-provider-completion-contract.md).

## Outcome and Partial-Commit Semantics

Select Element uses conceptual terminal outcomes, but does not currently expose
one canonical runtime enum containing all of them.

| Concept | Current feature representation |
| --- | --- |
| Full success | `success: true`, `partial: false`, accepted counts. |
| Partial success | `success: true`, `partial: true`, accepted and total counts. |
| Partial failure | Typed thrown failure carrying operation-local outcome counts. |
| Total failure | Typed failure or no-accepted-result result with zero committed parents. |
| Cancellation | Cancelled result/error and silent cleanup path. |
| No content | `NO_TRANSLATABLE_CONTENT` and feature-owned info feedback. |

Important typed or special outcomes include:

- `NO_TRANSLATABLE_CONTENT`;
- `SelectElementReason.UNSUPPORTED_MODE` for capability-specific no-content;
- `ELEMENT_TOO_LARGE`;
- `FEATURE_BLOCKED`;
- `EXTENSION_CONTEXT_INVALIDATED`;
- `TRANSLATION_TIMEOUT`;
- `NO_ACCEPTED_TRANSLATION_RESULTS`.

The adapter currently attaches operation-local `translationOutcome` metadata,
including committed-parent count, total-parent count, and cancellation state.
The shared immutable `TranslationOutcome` model exists as supporting
infrastructure, but this document does not claim complete canonical runtime
adoption by Select Element. See [ADR-015](../adr/ADR-015-translation-outcome-semantics.md).

## Partial-Commit Semantics

Parent commits are immediate once that logical parent is complete and valid.
They do not wait for unrelated parents or provider batches.

```text
parent A accepted -> commit A
parent B incomplete/failed -> preserve B original
parent C accepted -> commit C
```

Current guarantees:

- a complete parent commits independently;
- split fragments wait for parent completeness;
- later provider failures do not revert prior commits;
- partial success may resolve with `success: true` and `partial: true`;
- failure after prior commits carries operation-local counts;
- cancellation preserves committed DOM;
- uncommitted content remains original;
- explicit revert is required to restore committed content.

## Conversation Acceptance, ACK, and History

Conversation participation is shared infrastructure, not provider completion.

```text
UnifiedTranslationService participation decision
  -> parent candidates and acceptance handle
  -> provider result dispatch
  -> logical-parent DOM acceptance
  -> parent acceptance ACK
  -> ConversationAcceptanceCoordinator
  -> ordered conversation commit
```

The adapter emits parent acceptance ACKs only when the background registered a
conversation acceptance handle and returned `conversationAcceptance: true`.

Consequences:

- history-disabled or nonparticipating requests emit no parent ACK;
- one accepted logical parent corresponds to one semantic conversation turn;
- provider fragments, retries, recovery passes, and provider completion do not
  create conversation turns;
- rejected parents write no normal history;
- cancellation, conflict, context invalidation, and stale operations suppress
  late ACKs.

See [Conversation Contract](contracts/CONVERSATION_CONTRACT.md) for lifecycle,
history, ordering, timeout, and candidate rules.

## Error and User-Feedback Boundaries

Select Element separates diagnostics from public feedback.

```text
internal typed failure
  -> SelectElementManager classification
  -> mapCanonicalTranslationError()
  -> createLegacyDisplayError()
  -> localized safe display error
  -> ErrorHandler
```

Feature-owned paths:

| Condition | Feedback owner |
| --- | --- |
| Public translation failure | `mapCanonicalTranslationError()` then `createLegacyDisplayError()` then `ErrorHandler` |
| Partial outcome | Select Element partial message through existing renderer |
| No translatable content | `show-select-element-info` feature info channel |
| Unsupported extraction mode | Feature info channel with capability-specific message |
| `NODE_ALREADY_TRANSLATED` | Silent feature-owned skip; cleanup reason `error` |
| `FEATURE_BLOCKED` | Silent defensive skip |
| Context invalidation | `ExtensionContextManager` |
| Activation failure | Safe activation-error contract |

Raw provider/runtime messages remain logs or diagnostic `cause` values. They are
not the user-facing Select Element contract.

## Cancellation and Conflict

Lifecycle reasons remain distinct:

- `success`: finalize and clean up while preserving translations;
- `error`: classify feedback and preserve prior accepted parents;
- `cancel`: stop active work and preserve committed translations;
- `manual`: deactivate and preserve translations by default;
- `conflict`: silently cancel active work when another feature takes ownership;
- `no-content`: show feature info and clean up;
- context invalidation: locally invalidate work and use canonical context recovery;
- explicit revert: restore stored original state.

Conflict cancellation prevents stale callbacks and releases operation ownership.
It does not automatically revert already committed DOM. Shared cancellation may
still use `USER_CANCELLED` internally; this document does not define a separate
wire-level conflict reason.

## Active-Root Ownership and Concurrency

Each adapter operation owns its selected root while translating.

- An ancestor/descendant overlap is blocked with `FEATURE_BLOCKED`.
- A rejected operation cannot release another operation's root.
- Non-overlapping roots may translate concurrently.
- Root ownership releases during terminal cleanup, including failure and context
  invalidation.
- Operation tokens guard current callbacks, mutation, and ACK emission.

This protects page ownership without introducing a global feature lock.

## Context Invalidation

Context resilience has three owners:

```text
SelectElementManager watchdog
  -> detects invalid extension context
  -> emergency UI cleanup

DomTranslatorAdapter
  -> invalidates operation token and local acceptance
  -> settles request/stream waiters
  -> rejects late direct/stream work
  -> suppresses late DOM mutation and ACK
  -> releases active root

ExtensionContextManager
  -> canonical user recovery guidance
```

Finalization revalidates operation/context ownership before direction, state,
completion, or success side effects. Context loss preserves committed DOM and
does not automatically revert it. Unsafe runtime cancellation is not attempted
once the extension context is already invalid.

## Revert

Revert is explicit and separate from cancellation or failure.

`DomTranslatorState` restores stored original text nodes, direction metadata,
translation markers, and session-scoped history/snapshots. It emits the
translation-hidden event and clears revert state after restoration.

Committed partial translations remain available for explicit revert. Normal
failure, cancellation, conflict, and context invalidation do not automatically
revert committed parents.

The current Select Element activation/progress toast renders Cancel. It does
not render a Revert button. Revert uses explicit feature or global
shortcut/revert routing where enabled.

## Notifications and Keyboard Behavior

`SelectElementNotificationManager` owns top-frame Select Element toast state.
It handles:

- activation status;
- translation progress;
- cancellation action;
- informational no-content messages;
- dismissal and replacement of in-flight status toast.

Relevant feature events include:

- `show-select-element-notification`;
- `update-select-element-notification`;
- `dismiss-select-element-notification`;
- `show-select-element-info`;
- `cancel-select-element-mode`;
- `select-element-translation-progress`;
- `hide-translation`;
- `ELEMENT_TRANSLATIONS_AVAILABLE`;
- `ELEMENT_TRANSLATIONS_CLEARED`.

Notifications are top-frame-owned. Iframe managers coordinate completion and
deactivation with the top frame rather than rendering identical feature toasts.

Keyboard ownership:

- Select Element manager handles Escape while selection mode owns interaction.
- Global `RevertShortcut` cancels active translation before considering revert.
- When idle, the global shortcut may revert completed translations.
- A modifier-based undo shortcut is not a Select Element capability documented
  by current source.

## Iframe and Cross-Frame Integration

Iframe support uses frame-specific content managers and message routes:

- `IFRAME_ACTIVATE_SELECT_ELEMENT` activates the frame manager;
- `IFRAME_COORDINATE_OPERATION` delegates Select Element operations when the
  operation is `TranslationMode.Select_Element`;
- top-frame coordination handles global deactivation;
- iframe completion can notify the top frame through postMessage;
- top-frame notification ownership prevents duplicate toasts;
- iframe activation failures use the safe activation-error contract.

This is coordinated multi-frame behavior, not identical UI rendering in every
frame. Manifest entry points and frame-specific loading impose separate
top-frame and iframe responsibilities.

## Provider Resolution, Priority, and Timeout Ownership

Select Element accepts an explicit provider when supplied. Otherwise provider
resolution uses the shared effective-provider waterfall, including mode-specific
and global settings. See [Translation Provider Logic](TRANSLATION_PROVIDER_LOGIC.md)
for the complete order.

Provider capability and semantic-grouping configuration determine whether the
adapter uses V2 or V3 extraction. Provider selection itself belongs to shared
configuration/service layers, not `SelectElementPolicy`.

`UnifiedModeCoordinator` currently assigns Select Element LOW request priority.
Queue, rate-limit, retry, and provider execution details belong to shared
translation infrastructure.

Timeout budgets are owned by shared request/provider batch layers. They are not
represented here as one universal Select Element operation timer. The current
batch budget, retry behavior, and recovery deadlines are implementation and
provider-contract concerns.

## Resource Ownership

Stable resource guarantees:

- `ResourceTracker` manages manager, selector, adapter, and notification cleanup.
- Each translation operation owns an operation token and selected root.
- Adapter state uses operation/session identity to reject stale callbacks.
- Translation history and original snapshots are session-scoped.
- WeakMap-backed lookup/state prevents original-text references from becoming a
  permanent ownership mechanism.
- Terminal cleanup releases root, token, stream, and invalidation ownership.

## File Map

```text
src/features/element-selection/
├── SelectElementManager.js
├── SelectElementNotificationManager.js
├── ElementSelectionFactory.js
├── SelectElement.scss
├── index.js
├── constants/
│   └── SelectElementModes.js
├── handlers/
│   ├── handleActivateSelectElementMode.js
│   ├── handleDeactivateSelectElementMode.js
│   ├── handleGetSelectElementState.js
│   ├── handleSetSelectElementState.js
│   └── selectElementStateManager.js
├── composables/
│   └── useElementSelectionLazy.js
├── core/
│   ├── BlockGroupReconstructor.js
│   ├── DomTranslatorAdapter.js
│   ├── DomTranslatorState.js
│   ├── DomTranslatorUtils.js
│   ├── ElementSelector.js
│   ├── SelectElementPolicy.js
│   └── ShadowComparisonEngine.js
└── utils/
    ├── activationError.js
    ├── elementHelpers.js
    ├── shadowDom.js
    └── textDirection.js
```

Important shared dependencies:

- `features/shared/hover-preview/`;
- `features/translation/`;
- `core/services/translation/`;
- `shared/error-management/`;
- `core/content-scripts/`;
- `core/extensionContext.js`.

## Debugging

When FeatureManager is available:

```js
const manager = window.featureManager.getFeatureHandler('selectElement');
console.table(manager.getStatus());
```

`getStatus()` exposes service-active state, click-processing state,
initialization state, instance identity, and top-frame status.

Useful diagnostics include message/session identity, logical parent/block
identity, rejected mapping reasons, commit counts, provider recovery facts,
conversation acceptance decisions, and context invalidation events. Exact log
strings and private payload fields are implementation details.

## Terminology

| Term | Meaning |
| --- | --- |
| Translation unit | Extracted text unit associated with a DOM node. |
| Logical parent | Parent-level semantic unit requiring complete valid content before acceptance. |
| BlockGroup | V3 logical parent containing related units. |
| Provider fragment | Transport/provider piece that is not independently feature-visible. |
| Direct parent | V2 parent aggregation state. |
| V2 | Direct text-node extraction strategy. |
| V3 | Semantic block-group extraction and reconstruction strategy. |
| V2_PASSTHROUGH | V3 unit mode for supported preformatted content without group markers. |
| Committed parent | Validated parent already applied to DOM. |
| Accepted result | Result that passed feature identity, content, source, and completeness checks. |
| Provider completion | Provider execution terminal fact. |
| Conversation acceptance | Feature acceptance that permits parent ACK/history lifecycle. |
| Recovery | Provider-local structured recovery after contract failure. |
| Public display error | Localized safe error intended for user feedback. |

Use “provider batch”, “logical parent”, and “physical response” precisely. They
are not interchangeable.

## References

- [Feature Behavioral Contracts](contracts/FEATURE_CONTRACTS.md#6-select-element-contract)
- [Translation Identity and Fragment Contract](contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md)
- [Translation Provider Logic](TRANSLATION_PROVIDER_LOGIC.md)
- [Conversation Contract](contracts/CONVERSATION_CONTRACT.md)
- [Provider Contract](contracts/PROVIDER_CONTRACT.md)
- [Error Management System](ERROR_MANAGEMENT_SYSTEM.md)
- [ADR-015: Translation Outcome Semantics](../adr/ADR-015-translation-outcome-semantics.md)
- [ADR-016: Provider Completion Contract](../adr/ADR-016-provider-completion-contract.md)
- [Messaging System](MessagingSystem.md)
- [Smart Handler Registration System](SMART_HANDLER_REGISTRATION_SYSTEM.md)
- [Toast Integration System](TOAST_INTEGRATION_SYSTEM.md)

---

**Last reviewed:** August 2026

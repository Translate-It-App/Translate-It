# Conversation Contract

Authoritative semantic contract for conversation/context participation in AI-provider translation. Conversation history represents accepted semantic translations, not provider transport activity.

- **Owner(s)**: `TranslationSessionManager`, `AIConversationHelper`, `ConversationAcceptanceCoordinator`, `OptimizedJsonHandler`, and feature acceptance boundaries.
- **Scope**: conversation participation, logical-parent turns, candidate lifecycle, and final acceptance for AI translation.
- **Status**: semantic foundation for P8 implementation phases.

- **Owner of storage**: `TranslationSessionManager` (in-memory session map, TTL 30 min, max 50, LRU evict). `AIConversationHelper` reads/writes through it and does **not** touch browser storage.

---

## 1. Purpose and Scope

Conversation history exists to provide accepted translation context, including linguistic/style continuity for eligible Select Element AI translations. It is separate from provider-call success.

A provider call may succeed without any conversation commit. A provider completion, provider batch, retry, failover, or recovery pass is not itself a conversation turn.

For structured Select Element translation, one logical parent is the semantic translation unit. Transport fragmentation is transparent to conversation semantics.

---

## 2. Terminology

| Term | Definition |
| --- | --- |
| **ConversationSession** | Extension-managed in-memory conversation namespace. Owned by `TranslationSessionManager`; not provider-native state. |
| **ConversationTurn** | One finally accepted semantic translation context. For Select Element structured AI translation, one turn represents one accepted logical parent. |
| **ConversationCandidate** | Provisional parent-scoped source/result contribution used by non-migrated provider paths. It is not history. |
| **ConversationAcceptanceHandoff** | Immutable Background-to-Content parent identity and clean-source handoff. |
| **ConversationAcceptanceHandle** | Private mutable lifecycle state for one request's logical parents. |
| **ConversationAcceptanceCoordinator** | Background owner of ACK routing, ordered commits, timeout, idempotency, and lifecycle cleanup. |
| **HistoryRead** | Projection of committed conversation turns into an eligible provider prompt. Owned by `AIConversationHelper`. |
| **HistoryWrite** | Creation of provisional semantic history data. It is not durable until commit. |
| **HistoryCommit** | Irreversible append of one accepted `ConversationTurn` to session history. |
| **HistoryDiscard** | Removal of provisional candidate without changing committed history. |
| **LogicalParent** | Semantic translation unit, such as one Select Element BlockGroup. It may contain multiple transport fragments. |
| **ProviderBatch** | Provider execution unit. It is not a canonical conversation unit. |
| **PhysicalProviderResponse** | One provider response fact represented by an ADR-016 `CompletionRecord`. It is not history. |
| **FeatureOperation** | One user translation workflow that may contain multiple logical parents. It is not automatically one conversation turn. |
| **FinalAcceptance** | Content-side point at which a `LogicalParent` is fully reconstructed, validated, and accepted, making it eligible for DOM commit and causing a parent ACK. It is not the DOM mutation itself. |
| **stage** | Capture provisional parent-level semantic content before commit. |
| **commit** | Persist one accepted turn into conversation history, at most once. |
| **discard** | Drop provisional candidate without history mutation. |
| **primary translation** | A normal `PRIMARY_TRANSLATION` execution eligible only when participation rules pass. |
| **structured recovery** | A provider-local `STRUCTURED_RECOVERY` pass after a contract violation; never normal history. |
| **late settlement** | A provider outcome arriving after the request reached a terminal state. |
| **history-enabled request** | A request satisfying the complete conversation participation predicate, including mode, setting, purpose, provider, and session identity. |

---

## 3. Participation Policy

Conversation participation is evaluated once per `LogicalParent`, not once per fragment, provider batch, retry, or physical response.

A request participates only when all conditions hold:

```text
AI provider
AND history setting enabled
AND mode is history-eligible
AND callPurpose === PRIMARY_TRANSLATION
AND valid session identity exists
```

Current history-eligible mode is Select Element. Other modes remain non-participating until separately defined by product contract.

Participation controls both directions:

```text
participating request
→ may read normal history
→ may write normal history

non-participating request
→ no normal history read
→ no normal history write
```

Read/write symmetry is mandatory. Accidental write-only participation and prewarming are prohibited.

`STRUCTURED_RECOVERY` is always excluded from normal history, regardless of subset/full scope.

Operational call sequencing may remain independent, but operational sequence is not a `ConversationTurn`.

---

## 3.1. CompletionRecord Is Not ConversationTurn

ADR-016 `CompletionRecord` describes one physical provider response:

```text
PhysicalProviderResponse → CompletionRecord
```

`ConversationTurn` describes one accepted semantic translation:

```text
FinalAcceptance(LogicalParent) → ConversationTurn
```

Therefore:

- one provider completion does not imply a conversation commit;
- multiple physical responses may produce one conversation turn;
- retries, failover, and recovery do not create additional turns;
- completion termination and conversation acceptance remain separate facts.

---

## 3.2. Canonical History Content

`ConversationTurn.userContent` is clean logical parent source content.

`ConversationTurn.assistantContent` is the final accepted clean logical translation.

Conversation history must never contain:

- provider prompts or request payloads;
- JSON transport envelopes;
- internal marker-bearing source or output;
- individual transport-fragment text;
- raw provider responses;
- repair prompts or `repairContext`;
- rejected or source-filled output.

Content is copied into the provisional candidate and does not depend on later mutable DOM state.

---

## 3.3. Final Acceptance and DOM Atomicity

For Select Element logical parents, the acceptance lifecycle is:

```text
Provider execution
→ semantic validation
→ immutable handoff registered in Background
→ result dispatched to Content
→ BlockGroupReconstructor.apply()
→ FinalAcceptance
→ PARENT_ACCEPTANCE_ACK
→ ConversationAcceptanceCoordinator
→ ordered commitAcceptedParent()
```

`FinalAcceptance` is the earliest semantic point at which the parent is fully validated and accepted by the feature. It is not the DOM mutation itself. DOM commit and Conversation commit both consume the same accepted semantic parent; neither commit defines, replaces, or changes semantic acceptance.

A failed parent produces neither normal conversation history nor a committed parent DOM result.

DOM mutation and history storage remain separate responsibilities, but both consume the same accepted logical-parent result. A failure in one parent emits a rejected ACK and writes no normal history. A failure does not roll back unrelated accepted parents.

---

## 3.4. Logical Parent Fragmentation Invariant

Provider transport may execute:

```text
LogicalParent
→ N ProviderBatches
→ M PhysicalProviderResponses
```

Conversation semantics remain:

```text
one finally accepted LogicalParent
→ one ConversationTurn
```

The conversation lifecycle must never observe provider fragmentation as separate semantic turns.

The following are implementation details only and must never become semantic history units:

- `ProviderBatch`;
- transport fragment;
- `PhysicalProviderResponse`.

Examples:

```text
1 LogicalParent
5 ProviderBatches
9 PhysicalProviderResponses

→ 1 ConversationTurn
```

```text
1 LogicalParent
3 retries

→ 1 ConversationTurn
```

```text
1 LogicalParent
provider failover

→ 1 ConversationTurn
```

---

## 4. Primary Success Lifecycle

```text
eligible logical parent begins
→ parent candidate/handoff created
→ provider/parser/recovery execution
→ result dispatched to Content
→ FinalAcceptance
→ ACK
→ ordered Coordinator commit
→ one ConversationTurn
```

- A `ConversationCandidate` is provisional and does not imply accepted history.
- For migrated Select Element parent lifecycles, provider adapters stage or discard provisional data; they never durably commit the parent.
- `ConversationAcceptanceCoordinator` is the only durable writer for migrated parent lifecycles, through `TranslationSessionManager.commitAcceptedParent()`.
- ACK activation starts only after successful result dispatch; registration alone starts no timer.
- ACK timeout disposes the handle and removes the coordinator entry. Pending parents are discarded; accepted-but-uncommitted parents remain accepted in the disposed handle and cannot commit.
- Late ACKs return `STALE`; duplicate ACKs cannot create duplicate writes.
- Transport fragmentation does not create additional turns.
- Non-fragmented and fragmented parents use identical parent-level semantics.
- One accepted parent with one or five transport fragments produces exactly one turn.
- Provider retries and failover do not create additional turns.
- The final parent acceptance barrier and ACK must precede conversation commit.

**No migrated parent commit before Content ACK.**

For non-migrated/direct provider paths, the existing provider candidate commit remains available. Such paths do not use the parent acceptance lifecycle and are outside this ACK contract.

---

## 5. Contract Violation Lifecycle

```text
provider/parser candidate invalid
→ discard provisional candidate contribution
→ structured recovery (selective or full, per provider policy)
```

- A provider/parser-invalid contribution is provisional and is discarded; recovery does not reuse or commit it.
- A provider-level recovery success does not itself create history. The final logical parent must still pass final acceptance.
- A post-merge logical-parent failure discards the parent candidate, even when every physical provider call succeeded.
- Recovery scope may cover a subset of invalid request units or the full structured batch; conversation semantics are identical either way. The subset or full distinction is a provider recovery-policy concern, not a conversation concern.
- Recovery is a single provider-local pass (see [TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md)).
- Exactly one provider-local structured recovery pass is attempted: safely mapped invalid units are repaired selectively, otherwise the whole batch is retried once in the same structured format. Recovery does not enter normal conversation history; see the [Provider Contract](PROVIDER_CONTRACT.md#11-structured-ai-response-contract).

---

## 6. Recovery Lifecycle

- Call purpose: `STRUCTURED_RECOVERY`.
- No conversation participation (excluded from history, per [Participation Policy](#3-participation-policy)).
- Recovery may operate on a subset of invalid request units or the full structured batch; conversation isolation is unchanged either way.
- Atomic failure: a failure rejects the active structured-recovery operation.
- Original recovery error is propagated with its `type` preserved (e.g. `NETWORK_ERROR`).

***

## 6.5. Repair Context Lifetime

`repairContext` is transient recovery metadata supplied to the structured
recovery request. It:

- exists only for the recovery request;
- is not committed into normal conversation history;
- does not alter conversation turn-counter semantics;
- does not become provider memory.

The fact that recovery may be supplied with failure-specific repair guidance does
not change the conversation-isolation rules above.

---

## 7. Failure Lifecycle

| Failure | Candidate discarded | History changed | Notes |
| --- | --- | --- | --- |
| `NETWORK_ERROR` | yes | no | `catch → discard` |
| `API_RESPONSE_INVALID` | yes | no | same |
| `VALIDATION` | yes | no | same |
| recovery failure | yes | no | recovery rethrown |

Invariant:

```text
failed request
→ no conversation commit
```

---

## 8. Timeout Lifecycle

```text
timeout / signal aborted before commit
→ discard candidate
→ no commit
→ USER_CANCELLED internally if abort propagated
→ external timeout remains TRANSLATION_TIMEOUT
```

- A timed-out request with an aborted signal discards its candidate; the commit is skipped.
- If the abort surfacing was a cancellation, it is raised as `USER_CANCELLED`; the canonical external timeout stays `TRANSLATION_TIMEOUT`.
- **Late-commit guard:** after a discard or an aborted signal, `commit()` is a no-op (`settled` guard).

Conversation acceptance timeout is separate from provider execution timeout:

```text
handle registered
→ result dispatch succeeds
→ acceptance window activated
→ ACK timeout
→ pending parents discarded
→ handle disposed and coordinator entry removed
→ late ACK = STALE
```

Timeout cleanup never creates history and never rewrites an `ACCEPTED` parent as `REJECTED`.

---

## 9. Cancellation Lifecycle

```text
USER_CANCELLED
→ discard candidate
→ no commit
```

A genuine cancellation must not be reported as a timeout or generic translation error.

---

## 10. Late Settlement

- **Late provider success** and **late provider failure** after the request is already terminal are dropped.
- **No history write after terminal timeout/cancel.**
- **No second commit/discard cycle** — once settled, `commit`/`discard` are no-ops.

---

## 11. Exactly-Once Lifecycle

```text
stage:    at most once per parent candidate
commit:   at most once per accepted logical parent
discard:  at most once for the parent terminal path
```

- Candidate is parent-scoped for eligible migrated Select Element work and must not be independently committed per provider batch.
- `stage` captures semantic parent content only while the candidate remains provisional.
- `commit` is allowed only after final logical-parent acceptance and the cancellation check.
- `discard` invalidates the entire provisional parent contribution.
- A second `discard` is a no-op; commit after discard is prohibited.

Nuance: discard is effectively **idempotent** rather than strictly once, because repeated `discard` calls are no-ops once settled. Do not overstate strictly-once semantics.

---

## 12. Retry Interaction

- **Queue retry creates a fresh translation attempt**. It does not create a new semantic conversation turn.
- A failed parent candidate from a prior attempt is **not committed** and **not reused**.
- **Recovery failure** is rethrown and may enter the outer `QueueManager` retry of the whole task.
- **Retries must not double-commit** any previous parent candidate; only one candidate can commit for one accepted logical parent.
- **Structured recovery is not queue retry.** Structured recovery is a provider-local contract-failure response path excluded from conversation history; queue retry is a separate execution retry lifecycle. They must not be conflated in conversation semantics. See [TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md) for execution policy.

---

## 13. Conversation Data vs Stats

These are separate systems:

| System | What it holds | Persistence |
| --- | --- | --- |
| Conversation history | `TranslationSessionManager.session.history` (messages) | in-memory only |
| Provider physical stats | `TranslationStatsManager` (`recordRequest`/`recordError`, counters) | in-memory (no raw payload) |
| Diagnostics | structural facts | — |
| Feature history/UI history | `HistoryStorage` (`translationHistory` key, `sourceText`/`translatedText`) | persisted (`StorageCore`) |

Do not imply they are one persistence system.

---

## 14. Privacy

- Conversation history stores raw `userContent` and `assistantContent` in memory (`session.history[].content`), plus the system prompt.
- **It is not persisted to `browser.storage`** — only the in-memory `Map`, TTL 30 min, evicted by LRU.
- Durable feature history (`HistoryStorage`) persists `sourceText`/`translatedText` under `translationHistory`.

Do not state more than verified: raw request/response content is retained in the in-memory conversation session only.

---

## 15. Canonical Ordering

Conversation history order follows logical/source parent order, not:

- provider completion timing;
- provider execution order;
- retry order;
- failover order;
- fragment arrival order;
- stream arrival order.

Concurrent provider execution must not change semantic history ordering. Accepted parent candidates may wait for earlier logical parents before commit.

---

## 16. Session and Operational Sequence Semantics

`sessionId` identifies an extension-managed conversation namespace. It is not provider-native conversation state.

`TranslationSessionManager` owns in-memory session storage, TTL, eviction, and committed message pairs. `turnCounter` is operational sequence bookkeeping for diagnostics and provider logging. It is not `ConversationTurn` identity and does not define history order.

Gaps in operational sequence numbers caused by failure, cancellation, retry, or excluded recovery are not semantic history gaps.

---

## 17. Ownership Contract

| Responsibility | Owner |
| --- | --- |
| Session storage and committed messages | `TranslationSessionManager` |
| Participation predicate and history projection | `AIConversationHelper` |
| Provider protocol execution | Provider adapters and `BaseAIProvider` |
| Provisional parent candidate | Conversation lifecycle |
| Logical-parent acceptance | `OptimizedJsonHandler` and feature reconstruction boundary |
| DOM mutation | `BlockGroupReconstructor` / feature adapter |
| History commit/discard | Conversation lifecycle |
| Terminal request state | `UnifiedTranslationService` |

Provider adapters may contribute provisional semantic data, but must not decide final logical-parent acceptance or independently commit history.

---

## 18. Architecture Invariants

- `CompletionRecord` is not `ConversationTurn`.
- Conversation lifecycle must never observe provider fragmentation as semantic history.
- History participation is evaluated once per logical parent.
- History read and write eligibility are symmetric.
- History disabled means no normal history read and no normal history write.
- Transport execution never defines semantic history.
- Recovery, retry, failover, and physical response count do not create extra turns.
- History ordering must never depend on completion timing.
- A failed logical parent contributes no normal conversation history.
- Unrelated accepted parents remain committed.

---

## 19. Consumer Guarantees

Callers may assume:
- accepted, committed history corresponds only to **finally accepted logical parents**;
- **structured recovery does not pollute** conversation history;
- timeout/cancel **cannot create phantom history entries**.

---

## 20. P8 Implementation Scope

This contract defines semantics only. Runtime alignment is staged:

### P8.1 — Participation Gating

Align history reads and writes with the participation predicate. History-disabled and non-participating requests create no normal history contribution.

### P8.2 — Parent Candidate Foundation

Introduce parent-scoped provisional conversation data without independently committing provider-batch or fragment contributions.

### P8.3 — Parent Acceptance Commit

Commit one clean turn only after Content FinalAcceptance and ACK. Discard or reject the parent contribution on parent validation failure, cancellation, timeout, dispatch failure, or reconstruction failure.

### P8.4 — Non-Fragmented Alignment

Evaluate the same parent-level lifecycle for non-fragmented Select Element parents so fragmentation remains transport-transparent.

### P8.5 — Documentation and Cleanup

Synchronize documentation with parent acceptance ownership. Legacy provider candidate commits remain valid only for non-migrated paths.

These phases must not change ADR-015 outcome semantics or ADR-016 completion semantics.

---

## 21. ADR Consistency

ADR-015 remains authoritative for translation outcomes, validation, feature acceptance, and DOM/feature mutation semantics.

ADR-016 remains authoritative for normalized physical provider completion facts.

This contract complements both decisions:

```text
CompletionRecord → physical provider fact
ConversationTurn → accepted semantic translation context
TranslationOutcome → final workflow outcome
```

No contract here reclassifies completion termination, changes recovery policy, or changes final translation outcome semantics.

---

## 22. Known Intentional Behavior

```text
successful structured recovery
→ returned to caller
→ not committed into conversation history
```

This remains an intentional policy: recovery can produce an accepted translation result without creating a separate recovery history turn. The eventual accepted logical parent may create one normal turn under the parent lifecycle.

---

## 23. Non-Goals

This document does not define:
- provider retry algorithms → [PROVIDER_CONTRACT.md](PROVIDER_CONTRACT.md).
- provider recovery execution policy (selective vs full eligibility) → [TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md).
- identity/fragment rules → [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).
- feature source preservation → [FEATURE_CONTRACTS.md](FEATURE_CONTRACTS.md).
- canonical `TranslationOutcome` model → [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md).
- overall shared pipeline and runtime flow → [../architecture/TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md).

Diagram: see the AI conversation lifecycle in [../architecture/DIAGRAMS.md](../architecture/DIAGRAMS.md).

---

## 24. Test Map

| Lifecycle guarantee | Primary tests |
| --- | --- |
| Participation policy / recovery exclusion | `src/features/translation/providers/utils/AIConversationHelper.test.js` |
| Commit-once, final-acceptance and abort guard | `src/features/translation/providers/BaseAIProvider.test.js` |
| Contract violation → discard → one recovery | `src/features/translation/providers/BaseAIProvider.test.js`, `AIResponseParser.test.js` |
| Recovery no history pollution | `src/features/translation/providers/BaseAIProvider.test.js`, `AIConversationHelper.test.js` |
| Failure discards, no history write | `src/features/translation/providers/BaseAIProvider.test.js` |
| Timeout / abort discard + late-commit guard | `src/features/translation/providers/BaseAIProvider.test.js`, `src/features/translation/core/managers/OptimizedJsonHandler.test.js` |
| Cancellation discard, no commit | `src/features/translation/providers/BaseAIProvider.test.js` |
| Late settlement suppression | `src/features/translation/core/managers/OptimizedJsonHandler.test.js` |
| Exactly-once stage/commit/discard (`settled` guard) | `src/features/translation/providers/BaseAIProvider.test.js` |
| Physical stats (transactional separation) | `src/features/translation/core/TranslationStatsManager.test.js`, `src/features/translation/providers/utils/ProviderRequestEngine.test.js` |

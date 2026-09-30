# Provider Contract

Authoritative contract for the provider/translation layer: **valid translated result OR explicit typed failure** — never a silent source substitution.

- **Owner(s)**: `ProviderCoordinator`, `QueueManager`, `RateLimitManager`, `ProviderRequestEngine`, `ApiKeyManager`, `BaseAIProvider`, `AIResponseParser`, `AIConversationHelper`, `TranslationStatsManager`, `OptimizedJsonHandler`.
- **Scope**: provider implementation and execution contracts.
- **Status**: finalized for the documented scope.

This is the authoritative provider layer contract. Features and conversation participation are defined separately; see [FEATURE_CONTRACTS.md](FEATURE_CONTRACTS.md) and [CONVERSATION_CONTRACT.md](CONVERSATION_CONTRACT.md).

---

## 1. Purpose and Scope

```text
valid translated result
OR
explicit typed failure
```

- **Providers must not source-fill failed output.** A failed request is reported as a typed failure; the original source is never replayed as a successful translation.
- **Providers must not blank-fill nonblank input as success.** Blank output for nonblank input is rejected, not accepted.
- **Explicit source-equal output is valid.** `URL → URL`, `OpenAI → OpenAI`, `2026 → 2026` may be perfectly valid results (see [Source-Equal Translation](#14-source-equal-translation)).
- **Provider failure does not trigger another provider automatically.** Coordination is single-provider; there is no automatic cross-provider fallback.

---

## 2. Provider Layer Ownership

| Layer | Responsibility |
| --- | --- |
| `ProviderCoordinator` | Selected-provider execution orchestration (language swap, JSON detection, strategy choice, clean-up). |
| `QueueManager` | Retry scheduling (attempts, backoff, cancellation). |
| `RateLimitManager` | Provider health / circuit breaker. |
| `ProviderRequestEngine` | Physical API call, API-key failover, physical request stats. |
| `BaseAIProvider` | Structured-response recovery and conversation-candidate lifecycle. |
| Feature consumers | Source preservation and UI mutation. |

These responsibilities are **not** merged under a single "fallback" concept. Each layer owns a bounded concern.

Unit collision — a real one you can hit:

- `ProviderCoordinator.execute(provider, …)` orchestrates **one** provider. A thrown failure is rethrown; nothing switches providers.
- `QueueManager` retries the same item through the same provider.
- `ProviderRequestEngine` fails over between **API keys of the same provider**.
- `BaseAIProvider` runs recovery on the **same provider**.

No layer calls a different provider.

---

## 3. Provider Result Contract

- **Scalar/string result** — a single translated string.
- **Array result** — a batch of translated strings; each element corresponds to one requested unit.
- **Cardinality** — a mismatch between requested and returned units is a malformed response (see `AIResponseParser` gap-filling, which never inserts source text).
- **Malformed response** — rejected; reported as `API_RESPONSE_INVALID` / contract violation.
- **Blank result** — blank output for a nonblank source is rejected (failure). Blank source output handling is feature-side.
- **Source-equal result** — valid; never treated as failure or as a gap.
- **Structured responses** — parsed via `AIResponseParser` and validated via `TranslationContractValidator` (see [Structured AI Response Contract](#11-structured-ai-response-contract), [V3 Provider Contract](#18-v3-provider-contract), and [Response Identity](#19-response-identity)); assembled or reported as a contract violation.
- **Explicit typed errors** — `ErrorTypes` values (see [Error Contract](#4-error-contract)).
- **Successful structured result** — a structured result is accepted provider output only when it is syntactically parseable, contract-valid, identity/mapping-valid enough for the accepted path, and recovered and merged when necessary. A primary response that violates its contract is not successful provider output merely because transport succeeded.

**Invariant:** an unresolved/missing result is never replaced with source text as translated output.

---

## 4. Error Contract

Canonical types (defined in `src/shared/error-management/ErrorTypes.js`):

```text
TEXT_TOO_LONG
VALIDATION
API_RESPONSE_INVALID
NETWORK_ERROR
SERVER_ERROR
RATE_LIMIT_REACHED
TRANSLATION_TIMEOUT
USER_CANCELLED
```

- **`TEXT_TOO_LONG` is local deterministic validation**, performed before any network request. It is produced by local pre-entry checks (`translation-engine` max-chars, `useUnifiedTranslation` field guards, `LingvaProvider` partition budget), never inferred from a remote payload.
- **Timeout ≠ cancellation.** `TRANSLATION_TIMEOUT` and `USER_CANCELLED` are distinct types with distinct consequences (see [Timeout and Cancellation](#13-timeout-and-cancellation)).
- **Cancellation ≠ generic translation failure.** A cancelled request is `USER_CANCELLED` and must not surface as a generic provider error.
- **Validation must not be masked as `USER_CANCELLED`.** Local validation is a typed outcome, never a cancellation.

---

## 5. Retry Ownership

These are **independent, bounded** mechanisms. Do not treat them as one global retry engine.

### Queue retry
Owned by `QueueManager`. Per-item `attempts`; exponential backoff with cap; retries `RETRYING → setTimeout → PENDING → PROCESSING`. Global attempt caps are keyed by error type via `RETRY_STRATEGIES` (e.g. `RATE_LIMIT_REACHED`, `QUOTA_EXCEEDED`, `MODEL_OVERLOADED`, `SERVER_ERROR`, `NETWORK_ERROR`, `HTTP_ERROR`, plus a `default`). `shouldRetry()` returns false for cancellation, local deterministic validation, and fatal errors outside `retryableFatalTypes` or 429.

#### API-key failover
Owned by `ProviderRequestEngine` + `ApiKeyManager`. `executeRequest` iterates the provider's keys; on a failover-triggering error (`API_KEY_INVALID`, `INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`, `RATE_LIMIT_REACHED`, `DEEPL_QUOTA_EXCEEDED`) `ApiKeyManager.shouldFailover` selects the next key. Cancellation aborts the failover loop. There is a cap on counted keys.

#### Structured recovery
Owned by `BaseAIProvider`. On a structured contract violation the provider runs
**one provider-local recovery pass**. The pass is selective when invalid units
are reliably and unambiguously mapped — preserving valid primary results and
merging recovered values back into their original indexes — and falls back to
full sequential recovery when mapping is unsafe or ambiguous (see
[Structured AI Response Contract](#11-structured-ai-response-contract)). Not
recursive.

#### Provider-local partitioning
Example: `LingvaProvider._partitionByBudget` splits by serialized request-URL length against `FULL_URL_BUDGET`. Provider-local forwarding.

Each mechanism is owner-scoped and bounded. **Do not claim a single global attempt cap exists**; the caps are per-mechanism.

---

## 6. Retry Boundaries

Where stable and code-verified:

- `RateLimitManager` circuit `circuitBreakThreshold` (default 5) and `circuitRecoveryTime` (default 30 s, no exported const — inline in initializer).
- `QueueManager` `RETRY_STRATEGIES` max-retry values keyed by error type (not a single global number).
- `LingvaProvider.FULL_URL_BUDGET` partitioning ceiling.

Retry amplification:

```text
queue attempts
×
key failover
×
structured recovery
```

**No cross-layer total-attempt guard currently exists.** A queue retry that fails keys can itself fail over multiple keys; a structured recovery is an additional call. The aggregate is bounded indirectly by the participating layer-specific limits, but there is no single cross-layer total-attempt guard.

---

## 7. Local Deterministic Validation

```text
TEXT_TOO_LONG
→ no network request
→ no queue retry
→ no provider-health penalty
```

`ValidationPolicy.isLocalDeterministicValidationError` classifies by error **type** (local ⇒ `TEXT_TOO_LONG`). Its provenance invariant: **only pre-network local validation may assign `TEXT_TOO_LONG`**. A provider/HTTP error must never be relabeled as `TEXT_TOO_LONG`, otherwise it would wrongly be excluded from retry and health.

---

## 8. Provider Health Contract

`RateLimitManager` per-provider state drives health: `consecutiveFailures`, `isCircuitOpen`, `circuitOpenTime`, `currentBackoffMultiplier`, `performanceStats`.

- **Network/provider failures affect health.** `_recordFailure` increments failure counters and may open the circuit.
- **Cancellation does not.** Excluded from `_recordFailure`.
- **Local deterministic validation does not.** `TEXT_TOO_LONG` is never a failure; never a circuit input.
- **Circuit breaker survives within a cooldown** (`circuitRecoveryTime`); while open, calls throw `CIRCUIT_BREAKER_OPEN` preserving the original type.
- **Timeout treatment as implemented:** `TRANSLATION_TIMEOUT` is transient (non-fatal), counted as a failure, and may open the circuit only after the threshold.

Feature progress counters are not provider health.

---

## 9. Physical Request Stats

```text
ProviderRequestEngine.executeRequest
→ statsManager.recordRequest (per API attempt)
→ statsManager.recordError  (on non-cancel error)
```

Separation:
- **Physical provider-call stats** — `TranslationStatsManager` (`calls`, `chars`, `originalChars`, `errors`, per purpose).
- **Queue retry diagnostics** — `QueueManager` item `attempts`/status.
- **Feature progress counts** — feature counters (`.` `translated`/`failed`), defined in [FEATURE_CONTRACTS](FEATURE_CONTRACTS.md#17-diagnostics-and-progress).
- **Recovery call purposes** — `STRUCTURED_RECOVERY` and `PARENT_RECOVERY` are attributed separately from primary and from each other.

---

## 10. Call Purpose

Current purpose set (`TranslationCallPurpose`, frozen in `ProviderConstants.js`):

```text
PRIMARY_TRANSLATION
STRUCTURED_RECOVERY
PARENT_RECOVERY
```

`PRIMARY_TRANSLATION` is normal provider execution. `STRUCTURED_RECOVERY` is provider-local recovery after a structured-response contract violation. `PARENT_RECOVERY` is bounded logical-parent recovery initiated by structured-result orchestration when a reconstructed/fragmented parent fails parent-level validation; it is a distinct non-primary physical call purpose and does not participate in normal conversation history. Nested provider-local structured recovery during `PARENT_RECOVERY` retains `STRUCTURED_RECOVERY` as its physical call purpose. `ProviderRequestEngine.normalizeCallPurpose` maps unknown purposes to `PRIMARY_TRANSLATION`.

---

## 11. Structured AI Response Contract

```text
structured primary call
→ AIResponseParser
→ TranslationContractValidator
→ parser/mapping facts
→ provider recovery policy (selective or full)
→ merge
→ accepted candidate OR typed failure
```

- `AIResponseParser` parses and exposes parser/mapping facts; it does not trigger recovery and does not decide semantic provider validity.
- **Acceptance:** once a valid structured candidate is accepted, `BaseAIProvider` checks the abort signal then commits conversation once.
- **On contract violation:** discard the primary conversation candidate, then execute a single provider-local recovery pass:
  - **Selective recovery** when invalid units are reliably and unambiguously mapped: recover only the invalid subset, preserving valid primary results and merging recovered values back into their original request indexes.
  - **Full sequential recovery** when mapping is unsafe or ambiguous.
  - Merge and final validation complete before the accepted result is returned downstream.
  - Recovery success returns the merged final result.
  - **Recovery failure fails the provider batch.** No mixed successful/unresolved result is returned through this path, and unresolved values are never source-filled. No second structured-recovery loop is implied.
- Recovery facts are inputs to provider recovery policy; they do not decide that policy themselves.
- Structured recovery may carry transient repair context, which does not redefine provider validity.

- **No parser source-fill may escape as success.** Gap filling uses blank/unmapped placeholders, never the source text as a real translation.

---

## 12. Provider-Side Size Errors vs Local Validation

```text
local validation
→ TEXT_TOO_LONG (acts before network)

HTTP/provider-side 400/413 error
→ preserve provider/HTTP semantics (not TEXT_TOO_LONG)
```

Do not infer local provenance from the shape of an error message or HTTP status. `ErrorMatcher` reports provider error types; it does not invent a `TEXT_TOO_LONG` provenance.

---

## 13. Timeout and Cancellation

- **Timeout owner**: `OptimizedJsonHandler.processBatch` (and `StreamingManager` for streaming) produce `TRANSLATION_TIMEOUT` and abort the request.
- **Abort propagation:** the `AbortController` signal flows into `ProviderRequestEngine.executeRequest`/fetch. An `AbortError` normalizes to `USER_CANCELLED`.
- **Final type preservation:** timeout keeps `TRANSLATION_TIMEOUT`; user abort keeps `USER_CANCELLED`; a post-response abort is converted to `USER_CANCELLED`.
- **Late settlement suppression:** `OptimizedJsonHandler` wraps the provider promise so a late resolve/reject is consumed and dropped; no unhandled rejection, no second application.
- **No unhandled promise rejection:** late settlements are consumed/wrapped.
- **No retry on terminal timeout/cancel** except where the code explicitly does so (a send/done of the batch boundary aborts instead of queue-retrying).

---

## 14. Source-Equal Translation

```text
URL → URL
OpenAI → OpenAI
2026 → 2026
```

These may be perfectly valid provider results. **Source equality is not a provider-failure or contract-violation signal.** Feature consumers may treat an identical accepted result as a display no-op, but must not classify it as a failed translation. (Blank-output rejection applies only when the input source is nonblank AND the output is blank; equality to a nonblank source is fine.)

---

## 15. Consumer Guarantees

Consumers may assume:
- accepted output passed validation;
- no silent source-fill;
- no invalid blank success;
- typed errors;
- structured recovery already resolved where applicable;
- final accepted provider results after any recovery/merge, not the rejected primary candidate.

Consumers must **not** independently:
- retry the **provider** (that is `QueueManager`'s scope) — a consumer must not loop a provider on its own;
- infer local `TEXT_TOO_LONG` from an HTTP 413 (provider-side);
- treat source equality as failure;
- perform API-key failover.

---

## 16. Diagnostics

Provider diagnostics must carry identifiers and structural facts only. **Do not expose raw prompt/source/translated bodies** in diagnostics unless explicitly sanitized. See also the identity contract's [Diagnostics](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md#13-diagnostics) rule.

---

## 17. Non-Goals

This document does not define:
- conversation lifecycle → [CONVERSATION_CONTRACT.md](CONVERSATION_CONTRACT.md).
- per-feature observable behavior → [FEATURE_CONTRACTS.md](FEATURE_CONTRACTS.md).
- identity / duplicate / fragment rules → [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).
- shared pipeline/routing → [../architecture/TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md).
- canonical `TranslationOutcome` model → [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md).
- structured-recovery execution policy and provider recovery decisions → [../TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md).

For the overall translation architecture and runtime-diagram references, see
[TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md) and
[DIAGRAMS.md](../architecture/DIAGRAMS.md).

## 18. V3 Provider Contract

V3 marker ownership is part of the provider response contract. For a V3 parent, the provider must preserve:

- marker count;
- marker identity;
- marker ordering;
- absence of duplicate markers;
- presence of all expected markers (no missing markers);
- absence of unexpected markers;
- marker-owned interval content.

Semantic content belonging to one source interval must remain within its corresponding translated interval. Providers must not move or merge content across marker boundaries, and a meaningful source interval must not translate to a blank interval (`V3_EMPTY_TRANSLATED_INTERVAL`). V3 contract violations are provider contract failures. See [ADR-015](../../adr/ADR-015-translation-outcome-semantics.md) for the ownership decision.

## 19. Response Identity

Provider response identity uses distinct namespaces and must not be conflated:

| Term | Meaning |
|---|---|
| Logical ID | Logical source/request identity such as `g1`, `g2`. |
| Positional Wire ID | Provider transport identity such as `"0"`, `"1"` in a proven positional-wire batch. |
| V3 Member ID | Marker/member identity inside a V3 parent such as `n1`, `n2`, `n13`. |
| `requestIndex` | Original request-array position. |
| `responseId` | Identifier returned by the provider response. |

Numeric response IDs are valid only in a proven positional-wire context; they are not globally valid logical IDs. Unknown, duplicate, or unresolved identity remains contract-relevant. For detailed identity and fragment rules, see [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

---

## 20. Test Map

| Contract area | Primary tests |
| --- | --- |
| Local validation (TEXT_TOO_LONG: no network, no retry, no health) | `src/features/translation/core/QueueManager.test.js`, `src/features/translation/core/RateLimitManager.test.js`, `RateLimitManager.real-policy.test.js`, `src/shared/error-management/ValidationPolicy.test.js`, `src/features/translation/core/CrossLayerRetryBound.test.js`, `src/features/translation/providers/LingvaProvider.test.js` |
| Rate limit / circuit breaker | `src/features/translation/core/RateLimitManager.test.js`, `RateLimitManager.real-policy.test.js`, `src/shared/error-management/ErrorMatcher.test.js` |
| Queue retry | `src/features/translation/core/QueueManager.test.js`, `src/features/translation/core/CrossLayerRetryBound.test.js` |
| API-key failover | `src/features/translation/providers/ApiKeyManager.test.js`, `src/features/translation/providers/utils/ProviderRequestEngine.test.js` |
| Timeout / cancel / late settlement | `src/features/translation/core/managers/OptimizedJsonHandler.test.js`, `src/features/translation/core/StreamingManager.test.js`, `src/features/translation/handlers/handleCancelTranslation.test.js` |
| Source-equal accepted | `src/features/translation/providers/utils/AIResponseParser.test.js`, `OptimizedJsonHandler.test.js`, `LingvaProvider.test.js`, `src/features/translation/providers/DeepLTranslate.test.js`, `GoogleTranslate.test.js` |
| Structured recovery | `src/features/translation/providers/BaseAIProvider.test.js`, `AIResponseParser.test.js` |
| Physical stats | `src/features/translation/core/TranslationStatsManager.test.js`, `ProviderRequestEngine.test.js` |

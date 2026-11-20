# Translation Provider Logic (Selection Strategy)

This document defines the logic used by the system to determine which translation provider should be used for different features. 

## Core Architecture

The system uses a **Hierarchical Provider Selection** mechanism combined with an **Execution Strategy** layer. Decisions are resolved centrally in `UnifiedTranslationService.js` and executed through the `ProviderCoordinator.js`.

### 1. Decision Hierarchy (The "Waterfall" Logic)

When a translation request is initiated, the provider is resolved based on this priority:

1.  **Direct UI Override (Highest Priority):** If the request explicitly carries a `provider` field (e.g., from Popup/Sidepanel direct translation).
2.  **Ephemeral Sync (Smart Overrides):** 
    - **Sync Page**: When enabled, Whole Page Translation bypasses settings and uses the UI's active provider.
    - **Sync Element**: When enabled, Select Element mode uses the UI's active provider.
3.  **Feature-Specific Setting (`MODE_PROVIDERS`):** Configured in Options (e.g., `select-element`, `page-translation-batch`).
4.  **Global Default (`TRANSLATION_API`):** The fallback system-wide provider.

### 2. Execution Orchestration (New)

Once a provider is selected, the **ProviderCoordinator** determines the technical strategy:
- **Language Normalization**: Maps standard codes to provider-specific ones.
- **Optimization Awareness**: Adjusts batch sizes and concurrency based on the 1-5 level scale.
- **Streaming Decisions**: Decides whether to use chunk-based streaming or unified JSON response.

---

## Structured Response Execution and Recovery

This is the canonical provider-layer flow for structured responses:

```text
structured primary request
→ AIResponseParser
→ TranslationContractValidator
→ parser/mapping facts
→ BaseAIProvider recovery policy when invalid
→ selective recovery when safe
→ one full-batch structured retry when unsafe
→ merge
→ final accepted result
→ OptimizedJsonHandler final validation / streaming
```

`V3IntervalParser` is structural-only. It exposes observed V3 markers and
intervals but does not determine provider semantic validity.
`TranslationContractValidator` is the single semantic owner of provider
response validity, including V3 marker ownership. `AIResponseParser` owns
syntax parsing, response/request mapping, and packaging generic recovery facts.
`BaseAIProvider` owns recovery policy, execution, and merge; it must not
interpret V3 semantic rules. `OptimizedJsonHandler` enforces the canonical
validation boundary before accepted translated results become stream-visible.

### Response Identity Namespaces

Provider response identities use separate namespaces:

| Identity | Meaning |
|---|---|
| Logical ID | Logical source/request identity such as `g1`, `g2`. |
| Positional Wire ID | Provider transport identity such as `"0"`, `"1"` in a proven positional-wire batch. |
| V3 Member ID | Member interval identity inside a V3 parent such as `n1`, `n2`, `n13`. |

`requestIndex` is the original request-array position. `responseId` is the
identifier returned by the provider response. They are separate concepts.
Numeric response IDs are valid only in a proven positional-wire context and
are not globally valid logical IDs.

### Parser and Mapping Facts

When a structured response violates its contract, parser output may expose:

```js
{
  invalidUnits,
  mappingFacts,
  repairContext
}
```

`invalidUnits` contains mapped invalid response facts, conceptually including:

```js
{
  requestIndex,
  responseId,
  violationCodes
}
```

`mappingFacts` describes mapping confidence:

```js
{
  identityReliable,
  complete,
  ambiguous
}
```

These are parser and validation facts only. They do not decide recovery policy.

### Selective Recovery

Selective recovery is allowed only when invalid items can be mapped reliably and
unambiguously:

```text
valid primary items
+ reliably mapped invalid items
→ recover only invalid subset
→ merge recovered values into original request indexes
```

Valid primary results are preserved. Recovered values replace only invalid
indexes, and the merge completes before final result visibility.

`TRUNCATED_RESPONSE` does not override mapping-based selective/full recovery
eligibility: unreliable or incomplete mapping uses full structured recovery,
reliably mapped invalid subsets may use selective recovery, and a
contract-valid truncated response remains accepted.

### Full Recovery Fallback

Unsafe or ambiguous mapping uses one retry of the entire original batch in the
same structured format. This includes malformed or unparseable responses,
unresolved or duplicate mappings, unknown response IDs, positional fallback,
incomplete or ambiguous mapping, and cases with no safely preservable valid
primary results. A valid retry replaces the rejected primary candidate. If it
also violates the contract, the batch fails with `API_RESPONSE_INVALID`;
recovery does not recurse or fall back to scalar translation.

When invalid units are reliably mapped, up to three invalid units use
sequential scalar repair; four or more use one structured subset retry. Both
preserve valid primary results and merge repaired values into their original
indexes. This implementation cutoff is not a provider-wide contract limit.

Structured recovery is one provider-local recovery pass per batch execution.
If recovery fails, the provider batch fails; this path does not return a mixed
successful/unresolved result and does not source-fill unresolved output.

### Repair-Aware Recovery

Semantic facts originate from validation. `AIResponseParser` packages generic
`repairContext`; `BaseAIProvider` transports it without interpreting V3-specific
codes or marker semantics; `AIConversationHelper` renders repair guidance in
the existing structured-recovery prompt. `repairContext` is transient and does
not enter normal conversation history.

The rejected primary conversation candidate is discarded, and
`STRUCTURED_RECOVERY` remains excluded from normal conversation history. Normal
turn semantics remain unchanged. See [CONVERSATION_CONTRACT.md](contracts/CONVERSATION_CONTRACT.md)
for the complete conversation lifecycle.

### Retry Versus Recovery

These are separate mechanisms:

| Mechanism | Owner and purpose |
|---|---|
| Structured recovery | `BaseAIProvider`; one provider-local pass after structured contract failure; selective or full according to mapping safety. |
| Queue retry | `QueueManager` and request infrastructure; retries provider execution according to existing retry policy. |

Structured recovery does not redesign `QueueManager` and must not be described
as generic queue retry or cross-provider fallback.

---

## Feature-Specific Behaviors

### Select Element Mode
*   **Behavior:** UI-Aware & Batch-Optimized.
*   **Logic:** 
    - Uses `OptimizedJsonHandler` for batch processing.
    - **Sync Element** allows instant switching between AI (for context) and Traditional (for speed) providers without refreshing settings.

### Whole Page Translation (WPT)
*   **Behavior:** Throughput-Driven.
*   **Logic:** 
    - Uses `PageTranslationScheduler` to balance API costs vs. rendering speed.
    - **Sync Page** is critical for users who want to use a specific AI provider (like Gemini) temporarily for complex technical pages.

### Text Selection (WindowsManager)
*   **Behavior:** Interactive & Context-Rich.
*   **Logic:** 
    - **Manual Override:** Persistent per-window lifecycle.
    - **Smart Prompting**: The selection mode passes extra context (Headings, Page Title) to AI providers to improve accuracy.
    - **Dictionary Fallback**: Uses `MODE_PROVIDERS['dictionary-translation']` for single words.

---

## Implementation References

-   **`src/shared/config/config.js`**: Defines `MODE_PROVIDERS` and default settings.
-   **`src/features/translation/core/ProviderCoordinator.js`**: The final orchestration hub for all resolved requests.
-   **`src/core/services/translation/UnifiedTranslationService.js`**: Handles the `_resolveEffectiveProvider` waterfall.
-   **`src/features/translation/providers/utils/AIConversationHelper.js`**: Repair-aware recovery prompt rendering.
-   **`src/features/translation/providers/utils/AIResponseParser.js`**: Parses structured responses and packages mapping/recovery facts.
-   **`src/features/translation/core/V3IntervalParser.js`**: Structural V3 marker and interval parsing.
-   **`src/features/translation/core/TranslationContractValidator.js`**: Canonical semantic provider-contract validation.
-   **`src/features/translation/providers/BaseAIProvider.js`**: Structured recovery policy, execution, and merge.
-   **`src/features/translation/core/managers/OptimizedJsonHandler.js`**: Manages the batching logic for Select Element.

## Guidelines for AI Maintenance
- **When adding a new feature:** Register its mode in `TranslationMode` (config.js) and update the resolution waterfall if it requires unique inheritance.
- **When modifying resolution:** Ensure `UnifiedTranslationService` remains the source of truth for *selecting* the provider, while `ProviderCoordinator` remains the source of truth for *executing* it.
- Do not implement semantic V3 validation outside `TranslationContractValidator`.
- Do not treat numeric response IDs as globally valid logical IDs.
- Do not add V3-specific policy branches to `BaseAIProvider`.
- Keep `repairContext` generic and transient.
- Preserve full structured-recovery fallback when mapping confidence is insufficient.

For the accepted architectural decisions and deferred outcome migration, see
[ADR-015](../adr/ADR-015-translation-outcome-semantics.md). For provider
result, error, retry, health, and statistics semantics, see
[PROVIDER_CONTRACT.md](contracts/PROVIDER_CONTRACT.md). For shared pipeline
architecture, see [TRANSLATION_SYSTEM.md](architecture/TRANSLATION_SYSTEM.md).
For identity and fragment details, see
[TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

---

**Last Updated**: April 2026

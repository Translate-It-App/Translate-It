# Translation System — Architecture Diagrams

Mermaid diagrams for the current translation runtime. These **illustrate ownership and flow only**; they do not restate the contract text.

- Contract (details): [FEATURE_CONTRACTS.md](../contracts/FEATURE_CONTRACTS.md), [PROVIDER_CONTRACT.md](../contracts/PROVIDER_CONTRACT.md), [CONVERSATION_CONTRACT.md](../contracts/CONVERSATION_CONTRACT.md), [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).
- Architecture guide: [TRANSLATION_SYSTEM.md](TRANSLATION_SYSTEM.md).

---

## 1. End-to-End Translation Pipeline

```mermaid
flowchart TD
    T[Feature trigger] --> US[UnifiedTranslationService]
    US --> MC[UnifiedModeCoordinator]
    MC --> RE[TranslationEngine]
    RE --> PC[ProviderCoordinator]
    PC --> QM[QueueManager]
    QM --> PRE[ProviderRequestEngine]

    PRE --> P{provider outcome}
    P -->|translated text| VAL[result validation]
    P -->|typed failure| TRACK[TranslationRequestTracker terminal]

    VAL --> FEAT[feature consumer]

    subgraph Direct UI result
        VAL --> DISP[UnifiedResultDispatcher -- direct]
        DISP --> POPUP[Popup / Sidepanel / Selection Window]
    end

    subgraph Structured select-element / PDF
        VAL --> OH[OptimizedJsonHandler -- identity / fragment validation]
        OH --> DISP2[UnifiedResultDispatcher -- structured]
        DISP2 --> DOMA[DomTranslatorAdapter]
        DISP2 --> PDFA[PdfTranslationAdapter]
    end

    subgraph Batch whole-page / subtitle
        VAL --> PAGE[Whole Page -- PageTranslationScheduler]
        VAL --> SUB[Subtitle -- SubtitleTranslationCoordinator]
    end
```

No automatic cross-provider fallback node exists: `ProviderCoordinator` orchestrates a single selected provider; a failure is a typed terminal, not a switch to another provider.

---

## 2. Provider Execution / Retry Ownership

```mermaid
flowchart LR
    subgraph retry[QueueManager retry]
        QM[QueueManager] -->|same provider, same item| ATTEMPT[attempt]
    end

    ATTEMPT --> PRE[ProviderRequestEngine]

    subgraph failover[API-key failover]
        PRE --> AKM[ApiKeyManager.shouldFailover]
    end

    PRE --> CALL[physical provider call]

    subgraph recovery[Structured recovery — BaseAIProvider]
        CALL --> P[AIResponseParser]
        P --> V[TranslationContractValidator]
        V -->|valid| PC[primary candidate]
        V -->|contractViolation| DISC[discard primary candidate]
        DISC --> FACTS[parser / mapping facts]
        FACTS -->|safe mapping| SEL[selective recovery<br/>preserve valid primaries]
        FACTS -->|unsafe mapping| FULL[one full-batch structured retry]
        SEL --> MERGE[merge recovered values<br/>into original indexes]
        FULL --> REPL[recovered batch candidate]
        PC --> FINAL[final candidate]
        MERGE --> FINAL
        REPL --> FINAL
        FINAL --> OH[OptimizedJsonHandler<br/>pre-stream validation]
        OH -->|valid| ACCEPTED[accepted result]
        OH -->|invalid| FAIL[typed provider failure]
        ACCEPTED --> OUT[stream / delivery]
    end
```

Separate bounded mechanisms — do not merge them: **retry** (`QueueManager`) is the same item, **key failover** (`ProviderRequestEngine`/`ApiKeyManager`) is the same provider's keys, **structured recovery** (`BaseAIProvider`) is one provider-local pass per batch execution. Safely mapped invalid units are repaired selectively; unsafe mapping retries the whole batch once in the same structured format. `AIResponseParser` parses and produces facts; `TranslationContractValidator` decides semantic validity; selective recovery merges repairs, while a valid full retry replaces the rejected candidate before final validation and stream visibility. No single cross-layer total-attempt guard exists. Recovery failure produces a typed provider failure; no second recovery pass or source fallback is introduced. See the [Provider Contract](../contracts/PROVIDER_CONTRACT.md#11-structured-ai-response-contract) for policy details.

---

## 3. AI Conversation Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PrimaryCall
    PrimaryCall --> Staged: stage(candidate)
    Staged --> Parsed: parse / validate
    Parsed --> Crit{accepted?}

    Crit --> Discard: contract violation
    Discard --> Recovery
    Recovery --> Done: return result
    Done --> [*]: no conversation commit

    Crit --> Commit: yes (abort check)
    Commit --> [*]: commit once

    Parsed --> Fail: failure / timeout / cancel
    Fail --> Discard2: discard
    Discard2 --> [*]: no commit

    state Late {
        [*] --> Ignored: late settlement after terminal
    }
```

`STRUCTURED_RECOVERY` never participates in conversation history. A timed-out/cancelled request discards its candidate; the external outcome stays `TRANSLATION_TIMEOUT` or `USER_CANCELLED`. Recovery may be selective or full per provider policy; either way, no history entry is committed.

---

## 4. Identity and Fragment Lifecycle

```mermaid
flowchart LR
    U[request units] --> B[batching]
    B --> FRAG[V2 / V3 fragments]
    FRAG --> OH[OptimizedJsonHandler buffering]
    OH --> CMP{complete?}
    CMP -->|no| SUPP[suppress -- INCOMPLETE_FRAGMENT_EVENT_SUPPRESSED]
    CMP -->|yes| ASE[assemble parent]

    ASE --> DUP{duplicate?}
    subgraph Identity precedence
        P0[uid] --> P1[cellId] --> P2[i] --> P3[id] --> P4[blockId]
    end
    DUP -->|same batch| FATAL[typed VALIDATION error -- no emission]
    DUP -->|cross batch| SUPPRESS[DUPLICATE_IDENTITY_SUPPRESSED -- first wins]
    ASE --> ACCEPT[accepted logical result] --> CONSUMER[feature consumer]
```

Identity follows `uid ?? cellId ?? i ?? id ?? blockId` (nullish, `0` valid). Same-batch duplicate aborts the batch; cross-batch suppresses the later occurrence (request-local, no global cache).

---

## 5. Error / Terminal State Flow

```mermaid
flowchart TD
    TRACK[TranslationRequestTracker] --> STATES

    subgraph STATES[terminal states -- immutable]
        S[COMPLETED]
        F[FAILED]
        T[TIMEOUT]
        C[CANCELLED]
    end

    TERM{{already terminal?}}
    LATE[late settlement: success / error / timeout / duplicates]

    REQ[request] --> TRACK
    TRACK -->|accepted transition once| TERM
    TERM --> S
    TERM --> F
    TERM --> T
    TERM --> C

    TRACK -->|rejected| LATE
    LATE --> IGN[ignored -- no metadata / metric change]
```

Terminal states are immutable. `TRANSLATION_TIMEOUT` and `USER_CANCELLED` are distinct; a cancel after a timeout is suppressed, and late settlements cannot replace terminal state or trigger delivery.

---

## 6. Feature Routing Overview

```mermaid
flowchart LR
    US[UnifiedTranslationService]

    DIRECT[Direct result]
    US --> DIRECT
    DIRECT --> R1[Selection Window -- read-only overlay]
    DIRECT --> R2[Inline Selection -- tooltip overlay]
    DIRECT --> R3[Popup -- app store]
    DIRECT --> R4[Sidepanel -- app store]

    FIELD[Field -- smart-handler replacement service]
    US --> FIELD

    DOM[DomTranslatorAdapter]
    US --> DOM
    DOM --> SEL[Select Element -- mutation + revert]

    PAGE[PageTranslationManager]
    US --> PAGE
    PAGE --> WP[Whole Page]

    PDF[PdfTranslationAdapter]
    US --> PDF
    PDF --> PDFOUT[PDF -- cell / block application]

    SUB[SubtitleTranslationCoordinator]
    US --> SUB
    SUB --> SUBOUT[Subtitle -- cue batch application]
```

High-level mutation owners. See [FEATURE_CONTRACTS.md](../contracts/FEATURE_CONTRACTS.md) for per-mode mutation/revert details.

---

## Cross-References

- [TRANSLATION_SYSTEM.md](TRANSLATION_SYSTEM.md) — architecture guide and runtime freeze.
- [../contracts/FEATURE_CONTRACTS.md](../contracts/FEATURE_CONTRACTS.md) — feature observable contracts.
- [../contracts/PROVIDER_CONTRACT.md](../contracts/PROVIDER_CONTRACT.md) — provider/retry/health/stats contracts and structured-recovery guarantees.
- [../contracts/CONVERSATION_CONTRACT.md](../contracts/CONVERSATION_CONTRACT.md) — conversation candidate lifecycle and recovery history exclusion.
- [../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) — identity / fragment contract.
- [../TRANSLATION_PROVIDER_LOGIC.md](../TRANSLATION_PROVIDER_LOGIC.md) — structured-response execution and recovery policy.
- [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md) — architectural decisions and deferred outcome adoption.

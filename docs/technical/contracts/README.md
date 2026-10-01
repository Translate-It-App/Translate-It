# contracts/ — Behavioral Contracts

Purpose: **behavioral invariants and runtime contracts.**

## What belongs here

- Documents stating invariants, policies, and guarantees that consumers may rely on.
- Contracts enforced at runtime, independent of a specific provider or subsystem.
- Future planned contracts belong here.

## In this folder

- [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) — logical identity, duplicate handling, and V2/V3 fragment aggregation contract.
- [FEATURE_CONTRACTS.md](FEATURE_CONTRACTS.md) — per-feature observable behavior: input, routing, success, failure, partial success, timeout, cancellation, source preservation, revert/cleanup, consumer guarantees.
- [PROVIDER_CONTRACT.md](PROVIDER_CONTRACT.md) — provider result/error/retry/health/stats contracts, structured recovery, source-equal rules.
- [CONVERSATION_CONTRACT.md](CONVERSATION_CONTRACT.md) — AI conversation candidate lifecycle: stage/commit/discard, recovery exclusion, timeout/cancel/late-settlement.

## What does not belong here

- Whole-runtime architecture and routing → `architecture/`.
- Provider implementation → `providers/`.
- Shared subsystem internals → `infrastructure/`.

## See also

- [../architecture/TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md) — translation runtime ownership and routing.
- [../providers/PROVIDERS.md](../providers/PROVIDERS.md) — provider implementation.
- [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md) — outcome semantics ADR.

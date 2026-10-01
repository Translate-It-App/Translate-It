# architecture/ — Runtime Architecture

Purpose: **translation-runtime architecture, ownership, and routing.**

## What belongs here

- Translation/routing orchestration and runtime boundaries.

## In this folder

- [TRANSLATION_SYSTEM.md](TRANSLATION_SYSTEM.md) — detailed shared translation-runtime architecture and ownership, including entry paths, lifecycle, and delivery.
- [DIAGRAMS.md](DIAGRAMS.md) — detailed diagrams of translation/runtime flows and ownership.

## What does not belong here

- Behavioral invariants and per-request contracts → `contracts/`.
- Provider implementation → `providers/`.
- Shared subsystem internals → `infrastructure/`.

## See also

- [../ARCHITECTURE.md](../ARCHITECTURE.md) — high-level repository and runtime architecture overview.
- [../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) — identity and fragment contract.
- [../providers/PROVIDERS.md](../providers/PROVIDERS.md) — provider implementation guide.

# Technical Documentation Index

General technical documentation for the extension. Documents are grouped by stable folder classification.

## Folders

- [**architecture/**](architecture/README.md) — translation-runtime architecture, ownership, and routing.
- [**contracts/**](contracts/README.md) — behavioral invariants and runtime contracts.
- [**providers/**](providers/README.md) — provider implementation and integration guides.
- [**infrastructure/**](infrastructure/README.md) — shared runtime subsystems (stats, queues, lifecycle, messaging).

## In this folder

Flattened technical guides that cover standalone features and general engineering topics.

- [ARCHITECTURE.md](ARCHITECTURE.md) — high-level repository and runtime architecture overview.
- [MessagingSystem.md](MessagingSystem.md) — race-condition-free communication.
- [TRANSLATION_PROVIDER_LOGIC.md](TRANSLATION_PROVIDER_LOGIC.md) — canonical provider selection/execution and retry/structured-recovery boundaries; API-key failover details are in the [Provider Contract](contracts/PROVIDER_CONTRACT.md).
- [VITE_BUILD_SYSTEM.md](VITE_BUILD_SYSTEM.md) — modular bundling and manual chunking.
- [CSS_ARCHITECTURE.md](CSS_ARCHITECTURE.md), [CSS_VARIABLES_GUIDE.md](CSS_VARIABLES_GUIDE.md), [ICON_SYSTEM.md](ICON_SYSTEM.md) — styling and icon standards.
- Feature guides: [MOBILE_SUPPORT.md](MOBILE_SUPPORT.md), [DESKTOP_FAB_SYSTEM.md](DESKTOP_FAB_SYSTEM.md), [TTS_SYSTEM.md](TTS_SYSTEM.md), [MOUSE_HOVER_SYSTEM.md](MOUSE_HOVER_SYSTEM.md), [SUBTITLE_TRANSLATION_SYSTEM.md](SUBTITLE_TRANSLATION_SYSTEM.md), and others.

## Does not belong here

- Architecture of the translation runtime → move to `architecture/`.
- Behavioral invariants and contracts → move to `contracts/`.
- Provider-specific implementation → move to `providers/`.
- Shared subsystem internals → move to `infrastructure/`.

## See also

- [pdf-translator/](./pdf-translator/README.md) — PDF viewer internals.
- [docs/adr/](../adr/README.md) — architectural decision records.

# Translation Outcome Adoption (Project B)

This document defines the execution boundary and adoption strategy for runtime use of `TranslationOutcome`. It is a roadmap, not an ADR. The architectural source of truth remains [ADR-015: Translation Outcome Semantics](../adr/ADR-015-translation-outcome-semantics.md).

## Status

The Translation Pipeline Foundation (Project A) is complete.

Project B is now tracked in GitHub:

- [Tracking issue #244](https://github.com/Translate-It-App/Translate-It/issues/244)
- [TranslationOutcomeAssembler slice #243](https://github.com/Translate-It-App/Translate-It/issues/243)
- [History adoption #245](https://github.com/Translate-It-App/Translate-It/issues/245)

A concrete first consumer has now been selected: **History**. Runtime adoption itself is still incremental work and must preserve current observable behavior.

## What Project A Delivered

Project A established the foundation required by ADR-015, including:

- terminal execution routing;
- cancellation and timeout ownership;
- request-unit manifests;
- observational validation;
- diagnostics preservation;
- immutable `TranslationOutcome` domain contracts;
- structured-response recovery.

The foundation stops short of canonical runtime production and consumer migration.

## Project B Goal

Project B introduces canonical runtime outcome production and migrates consumers incrementally.

The target flow remains:

```text
Execution facts
+ Validation facts
        |
        v
TranslationOutcomeAssembler
        |
        v
TranslationOutcome
        |
        v
Feature / persistence consumer
```

The assembler aggregates already-existing terminal facts. It does not own parsing, validation, retries, provider behavior, storage, UI, logging, or feature mutation.

## Initial Adoption Sequence

### 1. TranslationOutcomeAssembler

Introduce a pure, deterministic assembler at the shared runtime boundary.

For this slice:

- produce `TranslationOutcome` beside the legacy result;
- do not remove existing result fields;
- do not redesign execution;
- do not change observable translation behavior;
- cover assembler invariants with focused tests.

### 2. History

Adopt the canonical outcome in History as the first real consumer.

History should consume canonical semantic state rather than reconstructing equivalent success/failure/partial state where possible, while preserving backward compatibility with existing stored data.

### 3. Further Consumers

Additional consumers are adopted only when individually justified. Possible future consumers include:

- Popup / Sidepanel;
- Dictionary;
- Text Fields;
- Select Element;
- Whole Page;
- Subtitles;
- PDF;
- Export / diagnostics / analytics.

This list is guidance, not a commitment or fixed migration order.

### 4. Legacy Cleanup

Legacy outcome/result fields remain available until all dependent consumers have migrated. Removal happens only after compatibility paths are no longer required.

## Invariants

Project B must preserve the following rules:

- `TranslationOutcomeAssembler` is pure and deterministic.
- The assembler aggregates facts; it never creates or infers missing runtime facts.
- Provider completion, validation, feature application, and presentation remain separate concerns.
- Original/source preservation is not translated output.
- Partial and cancellation semantics remain truthful.
- Migration is incremental; no big-bang rewrite.
- ADR-015 prevails if this roadmap and the ADR ever differ.

## Tracking

Implementation status belongs in GitHub Issues and the [Translate It Roadmap](https://github.com/orgs/Translate-It-App/projects/2), not in additional backlog documents.

This file exists only to preserve the stable architectural execution strategy for Project B.

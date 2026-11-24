# Benchmark reports

Recorded benchmark reports and their original artifacts. Historical reports remain unchanged; the Issue #406 and Issue #432 syntheses are separate final records.

## Whole-page translation

- [Google Translate V2 concurrency (2026-11-24)](google-translate-v2-concurrency-2026-11-24.md) — Level 3 C4/C6/C8 comparison, 600 designated targets / 603 translated segments, with HAR verification and sample-size limitations.
- [Microsoft Edge concurrency (2026-11-24)](microsoft-edge-concurrency-2026-11-24.md) — 600 designated targets / 603 translated segments, Level 3 C5/C6/C8 comparison, and HAR validation.
- [WebAI concurrency — gemini-auto](webai-concurrency-gemini-auto.md) — Level 3 C2/C3/C4 comparison on the 120-target fixture, with HAR verification and sample-size limitations.
- [Issue #432 final report (2026-11-21)](whole-page-issue-432-final-2026-11-21.md) — provider performance matrix, resilience, cancellation/stale-result probes, and the ten-cycle offline soak, with provenance boundaries and evidence gaps.
- [Issue #406 final report (2026-11-19)](whole-page-issue-406-final-2026-11-19.md) — final Chrome E2E performance matrix and Chrome/Firefox correctness probes.
- [SPA navigation (2026-10-10)](whole-page-spa-navigation-2026-10-10.md)
- [SPA reordered notifications (2026-10-10)](whole-page-spa-reordered-notifications-2026-10-10.md)
- [Start cursor (2026-10-10)](whole-page-start-cursor-2026-10-10.md) and [JSON artifact](whole-page-start-cursor-2026-10-10.json)
- [Review lifecycle (2026-10-10)](whole-page-review-lifecycle-2026-10-10.md) and [JSON artifact](whole-page-review-lifecycle-2026-10-10.json)
- [SPA bootstrap (2026-10-09)](whole-page-spa-bootstrap-2026-10-09.md)
- [SPA follow-up (2026-10-09)](whole-page-spa-followup-2026-10-09.md)
- [Concurrency (2026-10-09)](whole-page-concurrency-2026-10-09.md)

The [manual live Page Translation benchmark](../../../scripts/dev/page-translation/live-benchmark/README.md) is opt-in and uses real providers configured in the extension. It measures Page Translation lifecycle and DOM-change timings on a fixed 120-paragraph fixture, unlike the automated E2E benchmark, which uses controlled test scenarios.

The Chrome E2E runner, reproduction instructions, and its historical small-fixture result are in [`scripts/dev/page-translation/e2e-benchmark/README.md`](../../../scripts/dev/page-translation/e2e-benchmark/README.md). Raw Issue #406 artifacts are retained outside the repository under `/tmp/opencode` and are not copied into tracked documentation.

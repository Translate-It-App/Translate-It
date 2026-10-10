# Whole-page SPA followup (2026-10-09)

This report records the measured followup build `ce5879d82559485903796703f9858543c3f01567`, addressing partial translation reported with the first concurrency fix, `6ff3a1eb63694fe7924bc325cb2d45acfd4c62c4`. Its performance measurements remain attributed to that earlier commit in [the original report](whole-page-concurrency-2026-10-09.md). Subsequent same-document cross-route retention and effective-provider fixes are documented in [the next followup](whole-page-spa-bootstrap-2026-10-09.md).

## Reproduction and causes

Use Windows Chrome 155, the AI Agent profile and an unpacked build. On the public Delta documentation site, enable the existing `delta.dev/*` automatic translation rule, Custom level 5, AUTO → Japanese, lazy loading and automatic DOM translation. Follow the site's Welcome → Quick Start → Welcome links without reloading the document. For this followup, the existing configured model was `gemini-3.5-flash-lite`; it was not changed to the model used for the earlier performance experiment.

Two distinct failures were reproduced:

1. A successful AUTO owner batch containing already Japanese navigation returned no concrete source language. The coordinator treated this as a session error and rejected three waiting ten-item batches. Quick Start ended at 28 translated / 30 failed / 58 total; the return to Welcome ended at 24 / 30 / 54. The error was `No semantic language pair resolved for page session`. This was a coordinator failure, not an HTTP failure.
2. A trusted history notification could arrive after the local URL detector had already started the next session. Its independent stop left automatic translation inactive. Calling `history.replaceState(history.state, '', location.href)` also reproduced the stop at an unchanged URL; a subsequent synthetic English paragraph remained untranslated.

## Changes

- A successful AUTO batch without a concrete pair releases its waiting siblings to elect the next owner in the same session. Source-resolution handoff never re-sends an already successful batch; actual failure still rejects waiters. Abort, session identity and one deadline cover both waiting and provider work.
- Trusted history notifications delegate to FeatureManager's existing navigation revision and rule policy. Old Page work is invalidated before asynchronous re-evaluation; stop/restore continues to suppress same-URL automatic restart.
- Same-URL automatic restart copies only unchanged, accepted node records into separate fresh session storage, before lazy visibility scheduling. Pending/failed/edited records are excluded, and provider, target and settings revision must match. This retains original-text restoration even offscreen and avoids resending accepted translations. Manual retranslation does not inherit these records.

## Regression coverage

Provider tests exercise mixed Japanese/English batches, repeated unresolved AUTO success, reverse completion, cancellation, timeout and clear during owner handoff. Real CustomProvider integration asserts stable IDs, one request per successful batch and bounded overlap.

Page tests use the actual FeatureManager, Page manager, Bridge and `domtranslator`: late notification, same-URL update, ABA navigation, delayed nodes, retained-node counting without HTTP, original-text restore, edits/pending/failures, settings changes, manual stop/restore, attributes, supported shadow nodes, hover metadata and font restoration. Offscreen accepted nodes are restored immediately and survive consecutive restarts without retransmission; new or edited offscreen nodes still wait for intersection. Site rules and exclusions remain admission gates.

## Final Chrome verification

chrome-devtools reloaded the test extension and the separate public test tab. Loaded version 1.20.1 and resource hashes matched the final production build:

- Background: `1543b141b132d9cd74935479cfe44ba77a8c996981460392b6db63f88ea6974a`.
- Main content entry: `1497012abbbbd611d2825aef5ef14c9280552c46d6fe6b618fa0ba2fd44687a2`.

The document sentinel survived actual link navigation. Scheduler state was read through this extension's isolated content world from its own options target. No credentials, text bodies or authenticated HAR were collected; selected saved settings were identical before and after.

| Route | First fix before followup: translated / failed / total | Final followup, round 1 | Final followup, round 2 |
| --- | --- | --- | --- |
| Quick Start | 28 / 30 / 58 | 59 / 0 / 59 | 62 / 0 / 62 |
| Welcome return | 24 / 30 / 54 | 57 / 0 / 57 | 57 / 0 / 57 |

Both final rounds stayed automatically active, with no queued or active flush work at sampling. The main heading and all sampled visible main headings/paragraphs contained Japanese script (Quick Start 9/9, Welcome 5/5). Logical node totals can vary with lazy visibility and dynamic DOM, so this table establishes recovery from the failures rather than a speed comparison or a fixed-input benchmark.

An unchanged-URL history update kept auto translation active at 57/57. A subsequently inserted synthetic English paragraph translated successfully (58/58). After scrolling it offscreen, two distinct same-URL restarts retained its original source in fresh storage; both settled at 75/75 after lower content became visible. Restoring while the probe remained offscreen returned its exact original string. A separate manual restore set the user override; another same-URL update and a new visible paragraph did not restart or translate.

## Final checks and limits

Final focused suite: 29 files / 917 tests passed. Full applicable Windows suite: 554 files / 10,979 tests passed, with the same four unchanged CI helper suites excluded as in the original report. JS/style lint, Chrome and Firefox production builds, both extension validators, production-bundle invariants and diff checks passed. Chrome validation had no warnings; Firefox had 16 warnings, the same count as the prior build. No typecheck script exists. Independent source review found and then verified the lazy-retention correction; its two failing reproductions are now covered by text, attribute and shadow-node regressions.

No new HTTP latency, maximum real fetch concurrency, hidden proxy retry count or semantic translation quality is claimed for this followup. The earlier fixed-page performance experiment is attributed to its measured commit. Deterministic final provider tests still enforce the physical request cap and no re-send of successful batches during source-resolution handoff; existing HTTP retries and selective JSON repair remain separate mechanisms.

Persistent navigation text carried across *different* URLs has a separate existing original-text restoration limitation: the old session storage is cleaned while its committed DOM remains. Direct source comparison confirms this in both the first fix and its upstream baseline. This followup's restoration guarantee is limited to accepted records retained during a same-URL automatic restart; it does not claim whole-site restoration to the text before the first navigation. Firefox UI remains unmeasured.

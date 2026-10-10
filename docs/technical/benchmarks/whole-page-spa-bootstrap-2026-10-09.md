# SPA bootstrap and effective-provider followup (2026-10-09)

Measured baseline: `ce5879d82559485903796703f9858543c3f01567`. Windows Chrome 155, AI Agent profile, the same public Delta docs and existing Custom configuration: `gpt-6-luna-low-fast`, level 5, AUTO → Japanese, `delta.dev/*` automatic rule, lazy loading and automatic DOM translation on. No saved configuration or credentials were changed.

## Cause and scope

The four-worker Page limit did not disappear. On Welcome → Models & Providers → Welcome, four Page batches were dispatched together, but the first three successful provider calls returned source `auto`. The first three batches contained 28 previously accepted, unchanged navigation nodes (8/10, 10/10, 10/10). Only the fourth owner resolved English and released siblings. The initial HTTP-serial interval was 12.9–16.8 seconds; later requests did reach peaks of four or three.

The URL reset had discarded Bridge's accepted-node storage while leaving the translated shared navigation in the DOM. Resending this navigation fed target-language samples into the existing AUTO bootstrap. ProviderCoordinator deliberately keeps AUTO for such mixed-page samples, and the coordinator permits one unresolved owner at a time. This was neither a restored limit of one nor an observed 429/retry problem.

Automatic navigation now carries a local accepted-storage snapshot through eager cleanup, including document identity and scalar provider/target/settings revision. The new Bridge retains only owned, unchanged accepted nodes in fresh storage before lazy dispatch. Old sessions/controllers and resolved language pairs are not carried. Pending, edited, disconnected, failed or mismatched records remain ineligible.

The separate [review comment](https://github.com/Translate-It-App/Translate-It/pull/296#discussion_r4230088592) identified unnecessary invalidation on a global provider change when Page uses its own provider. SettingsLoader now records transient `usesGlobalProvider` provenance. The synchronous listener invalidates only a dependent session whose effective provider changes; explicit request precedence and the existing mode-provider listener remain unchanged. No saved setting was introduced.

## Observation

chrome-devtools observed the extension options/content targets and the current service worker. Its page-scoped network collector cannot collect worker HTTP requests, so a non-shipped runtime probe recorded fetch invocation, headers arrival and first normal application body-consumption completion, plus provider language/count metadata and Page batch admission. It added no response-body reads and recorded no request/response content, headers, credentials or HAR. All measured calls belonged to the controlled public test tab's session.

The loaded final version was 1.20.1. Resource hashes matched the built files:

- Background: `1543b141b132d9cd74935479cfe44ba77a8c996981460392b6db63f88ea6974a`.
- Main content entry: `e93e9cb4a4c6d5ab22990bb99dcc002096780202acc26e8f1c27b40aacec494a`.

## Two warm-document round trips per build

Each round follows real SPA links, preserving the document and translated navigation. "First overlap" is elapsed time from the first fetch invocation to the first overlapping fetch. "HTTP span" ends at the last normal body consumption; it is not full-page paint or complete offscreen translation time.

| Build | Destination | Round | First overlap (s) | HTTP span (s) | Peak | HTTP successes | Unresolved successful owners | Completed / admitted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | Models & Providers | 1 | 14.423 | 23.507 | 4 | 9/9 | 3 | 69/69 |
| baseline | Welcome | 1 | 16.826 | 24.428 | 3 | 8/8 | 3 | 57/57 |
| baseline | Models & Providers | 2 | 12.946 | 20.554 | 4 | 9/9 | 3 | 69/69 |
| baseline | Welcome | 2 | 13.858 | 20.165 | 3 | 8/8 | 3 | 57/57 |
| fixed | Models & Providers | 1 | 4.422 | 13.490 | 4 | 6/6 | 0 | 69/69 |
| fixed | Welcome | 1 | 5.173 | 11.474 | 3 | 5/5 | 0 | 57/57 |
| fixed | Models & Providers | 2 | 3.830 | 11.520 | 4 | 6/6 | 0 | 69/69 |
| fixed | Welcome | 2 | 6.032 | 9.670 | 3 | 4/4 | 0 | 54/54 |

All eight route samples had zero failed items and no queued/active Page work at sampling. HTTP attempts equaled provider calls, every status was 200, and there were no observed additional client HTTP attempts for retry/repair. Each fixed route retained 28 accepted nodes; none appeared in a new batch. Remaining HTTP input counts plus retained counts equal admitted totals. The last Welcome sample admitted three fewer nodes under lazy/dynamic visibility, so its HTTP span is not a fixed-input speed comparison. Subsequent full-height scrolling reached 73/73 current targets with 73 matching text records, no duplicate record IDs and no committed-value mismatch.

The retained shared navigation also kept its original English value across an actual route change and restored that exact value on manual restore. The original one-owner AUTO initialization remains; a page with fewer new batches need not reach the limit of four.

## Checks and limits

Final relevant suite: 29 files / 939 tests passed. Full applicable Windows suite: 554 files / 11,001 tests passed, excluding the same four unchanged Windows-incompatible CI helpers. JS/style lint, both production builds, both extension validators, production-bundle invariants and diff checks passed. Independent source review approved both fixes. Firefox validation had no errors and 16 warnings, the same prior count; Firefox UI was not measured.

The review issue first failed its mode-provider regression; the cross-route issue first failed a real Manager/Bridge test by resending an accepted node. Final tests cover precedence, immediate invalidation, new-session/ABA ordering, fresh storage, text/attribute/shadow/offscreen retention and restore, settings/document mismatch, edited/pending/disconnected nodes, late old responses, delayed DOM and manual/no-auto admission.

One uninstrumented startup immediately after extension/page reload reported 43 translated / 10 failed / 53 admitted. Two subsequent instrumented cold reloads completed 53/53 with normal output counts and no skipped, blank or missing outputs; the first was also checked through 73/73 after scrolling. The initial failure's cause was not captured and is not presented as resolved or silently included among the successful route samples.

No general speedup, semantic translation-quality score, proxy-internal retry/cache behavior or effective effort/tier is inferred. No new level-3 performance measurement is claimed; the original fixed-page comparison remains attributed to `6ff3a1e`. If a later navigation preempts initialization, the local snapshot may be discarded: safe retransmission can occur, and restoration to the earlier original is not guaranteed for that interrupted chain. Runtime probes were removed after measurement and are absent from the production patch.

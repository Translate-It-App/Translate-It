# Reordered SPA notification followup (2026-10-10)

Baseline: `dc87e0ab46d3ab842b02169d5067384f4ad4408d`. This addresses [review r4232673846](https://github.com/Translate-It-App/Translate-It/pull/296#discussion_r4232673846).

## Cause and minimal fix

In a same-document A → B → A round trip, receiving A@20 first advanced the receipt highwater without stopping the active A session. The later B@10 notification was then discarded as old. With unchanged node/source/generation and the live URL back at A, an old pending response could still commit.

FeatureManager now separates the latest received timestamp from the range actually invalidated. It evaluates meaningful intermediate-URL evidence before receipt ordering, and advances `_spaInvalidatedThrough` only when it really invalidates work. A@20 alone leaves the old session uncovered; B@10 cancels it once and covers the received range through 20. Duplicate receivers and covered delayed notifications cannot cancel replacement work. Actual local URL changes, existing rule/restore policy and accepted-original retention remain unchanged.

The product change is confined to FeatureManager, with one scalar and no new protocol, dependency or history collection. A newly generated missed round trip sharing an identical already-covered timestamp is not distinguishable from duplicate metadata; the shortcut is documented rather than claiming a stronger guarantee.

## Deterministic regressions

The unfixed source failed three regression cases. Final related coverage passed **29 files / 995 tests**; full applicable Windows coverage passed **554 files / 11,033 tests**, excluding the same four unchanged Windows-only CI incompatibilities. After the final explanatory comment, the two affected suites passed again: **120 tests**.

Tests use real Manager and Bridge code for reversed current/intermediate notifications: old responses settle cancelled, no old value commits, replacement work succeeds, accepted nodes are not resent and their exact originals restore. The matrix also covers covered duplicates, multiple delayed old URLs, subsequent new round trips, same-URL updates, initial equal timestamps, local/hash navigation and stop/restart policy.

## Firefox 157 end-to-end fault injection

Firefox DevTools MCP temporarily installed the baseline and fixed extension into its own disposable WebDriver profile. It supports ordinary-page scripts but rejected evaluation in extension pages with `unsupported operation`; it exposed no extension background-target selector. No security flags or restrictions were changed.

A non-shipped test copy added two fixture-scoped probes: a content-side control bridge and a background relay. The relay captured real browser SPA notifications, kept their original timestamps and delivered them to the normal content receivers in reverse order. Production runtime files were not edited. All **145 final Firefox JavaScript files** matched those in the tested copy after the final build.

A loopback mock served a fixed English document and deterministic Custom responses, using fixture-only configuration and no real credentials or external backend. The initial pass translated 34 nodes. Another 12 nodes were added while responses were held; then A → B → A occurred without changing that DOM. Native notifications were B first, A second in both recordings. The reverse delivery was deliberately injected, **not naturally observed**.

| Observation | Baseline | Fixed |
| --- | --- | --- |
| Initial accepted nodes | 34/34 | 34/34 |
| Revision after reversed notifications | 0 | 1 |
| Old controller aborted | no | yes |
| Held old response | commits 12 nodes in old session | 2 old HTTP requests abort |
| Replacement | none | new session translates 12 nodes |
| Final accepted / admitted | 46/46 | 46/46 |
| Accepted-value mismatch / duplicate record IDs | 0 / 0 | 0 / 0 |
| Mock HTTP requests / successes / aborted | 6 / 6 / 0 | 8 / 6 / 2 |
| Peak mock HTTP | 3 | 3 |

The fixed replacement inherited all 34 accepted nodes; only the 12 pending nodes were requested again. A separate fixed test appended 12 more nodes and sent 20 same-URL state updates while scrolling: session and revision stayed unchanged, two requests completed with zero aborts, and 58/58 records matched without duplicate IDs. Manual restore matched the retained node storage's saved original; the unit regressions independently compare restoration with the initial source text.

One preliminary manual run held the mock beyond the existing batch deadline; its 12 timeout failures prevented a valid stale-commit observation. It was excluded from the comparison, and the complete choreography was rerun in one bounded browser evaluation. The successful baseline/fixed recordings above completed within the deadline.

## Verification and limits

Standard JS/style lint, both final production builds, both validators, production-bundle checks and diff checks passed. Chrome validation had zero warnings; Firefox had zero errors and the same 16 warnings. Independent source review approved the fix. No typecheck script exists.

Final ZIP hashes:
- Chrome: `131f451d0c585692323a05f3481eab083a8d4feaca65f17e93adf48ee102858e`.
- Firefox: `1fba8c5fac9a91a75b234b987ceef6b473f286a4413a782e18b0e5bf2c0cf53d`.

Temporary probes were uninstalled, the owned Firefox session closed and the mock server stopped. No request/response bodies, headers, real credentials or private pages were exported. Probe code is absent from production packages.

This is a deterministic correctness experiment, not a model performance benchmark. Naturally reversed notification delivery has not been observed in Chrome or Firefox. The Firefox extension settings UI remained inaccessible through this MCP session. Earlier Chrome/model performance measurements retain their original commit attribution; no new speedup or incidence estimate is claimed.

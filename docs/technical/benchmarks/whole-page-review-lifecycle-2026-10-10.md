# Whole-page review and lifecycle verification — 2026-10-10

This followup reviews the complete Page concurrency patch against `ab672717` and fixes the two new review findings plus three lifecycle defects found during the review. The review, implementation and verification were performed by the primary agent without subagents. Earlier performance measurements remain attributed to their original commits; this study makes no new real-model speed claim.

## Findings and minimal changes

1. **Invalid discovery removed tracked child frames.** `getAllFrames` rejection falls back to a top-frame entry without a URL. `PageNavigationTracker.seed` previously pruned children before rejecting that entry. Validate the entire list before any pruning or epoch allocation. Existing tracking, durable counters and child A→B→A detection survive invalid input; successful discovery still removes missing participants.
2. **The navigation contract described the removed timestamp protocol.** Document `navigationCursor: { documentEpoch, routeRevision, url }`, epoch/revision ordering, persistence, guarded live-frame admission and unavailable-evidence behavior. Reconcile the adjacent Page result-counting notes with the implemented blank/identity/duplicate settlement behavior.
3. **Retired Page instances kept settings observers.** Feature reactivation can create a replacement manager, but direct storage subscriptions retained old managers. Use the existing `ResourceTracker` listener API and register observers on initialization. Cleanup removes them; reactivation registers once.
4. **Stop retained AUTO language-resolution state.** Stop now uses the existing `CANCEL_SESSION` cleanup path for the accepted session ID. It preserves a different pending start ID and the accepted lifecycle ID needed for presentation and restore.
5. **Translation commands could revive a different, retired manager.** The content handler cached a Page manager independently of `FeatureManager`. After deactivation/reactivation, it could reactivate that cached instance while navigation and status used its replacement. Reacquire an inactive cached manager from the existing feature loader. A denied load cannot revive it. This requires changing one admission condition.

No settings schema/defaults, dependencies, provider sizing, retry policy or physical request ceilings change in this followup.

## Deterministic regressions

Twelve new cases cover invalid discovery/fallback, a valid prefix followed by an invalid frame, malformed entries/list, retained child cursors across worker restart, unchanged epoch allocation, later valid pruning, settings-observer cleanup/reactivation, accepted-session cleanup with a competing pending start, and current-manager reacquisition/admission denial.

Before the respective source fixes, five discovery cases, three observer/session cases and two retired-manager cases failed. The additional two malformed-input variants are included in the final suite. Existing connected tests cover levels 3/5 and limit one, reversed HTTP/item completion, partial failure, shared 429/Retry-After including key failover, bounded JSON recovery, cancellation, late responses, duplicate enqueue, source/DOM generations, SPA cursor ordering, settings changes and history-dependent paths.

## Browser method

- Firefox MCP, Firefox 157.0.1, an owned temporary browser and temporary addon.
- Product version 1.20.1; all 269 non-manifest runtime files in the final diagnostic copy matched the final build byte for byte. Only the diagnostic manifest and added probe scripts differ. These probes are absent from the shipped ZIPs.
- Fixed local `/spa/a` fixture, fake Custom/OpenAI-compatible provider, AUTO → Japanese, level 5, cache disabled, lazy loading disabled, DOM persistence enabled, and fixed local 800 ms responses. The mock records HTTP start/end/status/abort independently of DOM probes. No real model or paid service is contacted.
- Normal runtime Page commands start/stop/restore translation. Native history updates test A→B→A. Feature deactivation/reactivation tests manager replacement. Controlled fake-model changes test settings notification ownership.
- An independent fixture text/ID oracle checks translated values and exact original restoration. No input text, authorization header, request body, profile path or HAR is exported in the published data.

The intermediate browser build exposed finding 5: after three manager replacements, HTTP finished successfully and the DOM contained 46 translations, but the current manager reported zero tasks and no session. A completion probe timed out waiting for those counters. That trial is a functional failure, not a performance result. The new unit regressions and final browser rerun verify the root cause and correction.

## Final browser results

| Case | Completed | HTTP attempts / success / abort | Peak HTTP | Outcome |
| --- | --- | --- | --- | --- |
| Initial fixed page | 34/34 | 4 / 4 / 0 | 3 | No failed items or mapping errors |
| Add 12 pending nodes, then A→B→A | 46/46 | 3 / 2 / 1 | 1 | Old controller aborted; 34 accepted nodes retained |
| Stop | 46 accepted nodes remain | No new translation request | — | One matching `CANCEL_SESSION`; stopped bridge inactive |
| Three deactivate/reactivate cycles | 3/3 cycles | No translation requests | — | Retired revision unchanged; each active settings change increments once |
| Translate again after replacement | 46/46 | 5 / 5 / 0 | 4 | Current manager owns the session; independent mapping errors 0 |
| Add 12 more nodes, then another A→B→A | 58/58 | 4 / 2 / 2 | 2 | Obsolete work aborted; mapping and exact restoration errors 0 |
| 20 same-URL state updates and 20 actual in-flight scrolls | 58/58 | 6 / 6 / 0 | 4 | Same session/revision; controller stays live; mapping and restoration errors 0 |

All valid cases have zero HTTP errors and zero failed elements. The cancellation cases intentionally abort obsolete work. Their lower peaks reflect the remaining input and AUTO bootstrap, not a changed ceiling. The fresh 46/58-node runs send all admitted items with cache off; retained nodes are explicitly accounted for in the route cases. No timing speedup, model effort/tier or proxy-internal retry claim is made.

Machine-readable summaries and source/build hashes: [measurement data](whole-page-review-lifecycle-2026-10-10.json).

## Checks and limits

- Final applicable Windows suite: **557 files / 11,112 tests passed**. Only the four unchanged Linux-shell CI helper files are excluded locally; final GitHub Linux CI runs them without exclusions.
- Related first-pass suite: 30 files / 1,011 tests passed. After the current-manager correction: 23 files / 656 tests passed, followed by the complete final suite.
- Standard JavaScript and style lint passed. One intermediate lint invocation also scanned an untracked diagnostic build and failed on generated vendor files. Moving that owned copy outside the checkout restored a clean standard lint run; no lint rule or tracked source exclusion was added.
- Both final builds, both extension validators, the production-bundle validator and diff whitespace checks passed. Firefox has zero errors and the existing 16 warnings; Chrome has zero errors/warnings. There is no typecheck script in the project.
- Chrome MCP listed no installed product extension and rejected internal-URL navigation, so this followup does not claim a new Chrome run. No browser/tool security restriction was relaxed. The new child-discovery failure is verified deterministically at the real handler/tracker boundary, not injected into a live browser API.
- The temporary addon and owned Firefox instance were removed/closed; the owned mock process was stopped and its port was confirmed closed. Normal profiles/settings and existing user branches were preserved.

Static review and these regressions reduce the tested risks; they do not prove the absence of all defects. Public-site/real-backend observations in the earlier studies remain historical evidence rather than measurements of this final followup.

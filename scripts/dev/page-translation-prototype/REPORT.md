# Page translation traversal prototype — synthetic benchmark report

**Run date:** 2026-11-02  
**Environment:** Headless Chromium 156.0.0.0, Linux x86_64, viewport 780×493; long-task observer supported.  
**Fixture:** isolated marked local fixture; default 2,500 branches × depth 4, with visible text/attributes, open shadow content, exclusions/editable controls, dynamic additions, and two external edits before restore.  
**Trials:** one discarded warmup per mode, then five measured samples per mode; order alternated (baseline→viewport, then viewport→baseline).  
**Commands:** `pnpm test:run scripts/dev/page-translation-prototype.test.js scripts/dev/page-translation-prototype-benchmark.test.js`; `pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs`.

Medians and p95s are across five samples (nearest-rank p95). Times are milliseconds. Baseline is a simulated synchronous full-discovery prototype, **not** production `domtranslator`.

**Historical results:** the initial table and the later “Historical: candidate/scroll fix comparison” section are preserved 2026-11-02 records from the earlier harness. They are not directly comparable to the phase-isolated old/new measurements below and must not be used as this engine comparison.

| Metric | Baseline median (p95) | Viewport median (p95) |
| --- | ---: | ---: |
| Engine processing | 192.8 (259.6) | 232.2 (298.4) |
| External wall elapsed | 209.7 (286.5) | 664.6 (757.4) |
| Restore | 14.0 (26.8) | 0.6 (0.7) |
| First visible DOM write | 122.3 (134.0) | 6.0 (8.6) |
| Max engine translation slice | 180.6 (243.8) | 9.2 (14.7) |
| Max engine restore slice | not measured | 0.5 (0.7) |
| Heartbeat delay proxy | 176.2 (241.8) | 12.8 (28.4) |
| Longest observed translation task | 180 (243) | 0 (0) |
| Longest observed restore task | 0 (0) | 0 (0) |
| `performance.memory` delta, bytes | -632,088 (12,485,105) | -2,647,349 (11,334,406) |

**Counts (each of five trials in each mode):** 108 targets changed (24 visible text, 74 visible attributes, 4 shadow targets); 108 translated; 106 restored; 2 externally edited owned nodes preserved. Baseline visited 15,066 units and restoration visited 15,066 DOM nodes. Viewport visited 15,090 traversal units and restoration visited 108 owned Text/Attr records. Visit counts are engine work units, not unique page-node counts; discovery may revisit seeded nodes. The two modes had equal target coverage and translation/restoration counts.

**Correctness:** zero pre-restore translation mismatches and zero restore text/attribute mismatches in both modes; external edits preserved and excluded/editable content untouched in all trials. Long-task observer recorded one translation task per baseline sample and none in viewport; no restore tasks were recorded. A reported zero means no qualifying long-task entry was observed, not zero actual task duration or proof of no jank. Memory deltas include fixture setup/cleanup and GC effects; they are noisy and do not establish retained-memory behavior.

**Observation:** in this successful run, viewport mode improved first visible mutation latency, slice lengths, and restore time, but its total engine-processing and wall elapsed medians were higher. The measurements do not establish production equivalence or real-page responsiveness. Keep production `domtranslator`; perform controlled Firefox profiling and fresh real-page validation before considering replacement. Firefox validation remains outstanding.

## Historical: phase-separated viewport comparison before attribute audit (2026-11-03)

These are the previous engine revision's old/new initial-and-scroll runs, before the attribute audit. They used Headless Chromium 156.0.0.0, Linux x86_64, 780×493 viewport, long-task observer available; each engine/shape used one discarded warmup and five samples per mode, alternating baseline and viewport. Runs were sequential, each in a fresh isolated browser. The grouped fixture has 2,500 nested depth-4 branches; flat has 2,500 sibling depth-1 branches; both have 24 visible targets. Times are median (nearest-rank p95), milliseconds unless noted. Do not treat its 3d639 engine results as the final attribute-audit run below. The simulated baseline mode remains a synchronous full-discovery comparison, **not** production `domtranslator`.

Old engine snapshot: `/tmp/opencode/page-translation-engine-before.js`, SHA-256 `50d7911e458a4f95cada11c354ba46e022c17303eb3c013f9bcc9e7f50110815`. New engine source: SHA-256 `3d639965d2ebd6f57422664813c01db0e9c23013053d1b8fb865f86a827ca595`.

| Fixture / viewport metric | Old engine | New engine |
| --- | ---: | ---: |
| **Grouped — total processing / wall** | 804.7 (1,339.9) / 1,674.1 (2,658.0) | 192.8 (256.9) / 412.4 (546.8) |
| **Grouped — initial processing / wall** | 587.9 (1,164.9) / 1,298.4 (2,310.4) | 135.5 (158.6) / 273.2 (337.5) |
| Grouped — initial visits; geometry checks; pruned branches; discovery passes | 15,098; unavailable; unavailable; unavailable | 2,602; 2,739; 2,498; 1 |
| Grouped — initial first-visible latency; heartbeat delay; longest task | 9.3 (18.9); 54.3 (105.8); 0 (0) ms | 6.3 (10.8); 11.5 (22.5); 0 (0) ms |
| Grouped — max engine slice over both phases | 24.6 (47.7) ms | 10.6 (24.9) ms |
| Grouped — after-scroll processing / wall | 175.3 (290.5) / 347.6 (460.0) | 61.7 (98.3) / 142.8 (209.3) |
| Grouped — after-scroll visits; geometry checks; pruned branches; discovery passes | 0 additional visits; unavailable; unavailable; unavailable | 5,063 visits; 5,106; 4,992; 1 |
| Grouped — scroll first-visible latency; heartbeat delay; longest task | 17.2 (38.6); 22.0 (28.7); 52 (134) ms | 17.4 (59.7); 11.1 (36.3); 0 (0) ms |
| Grouped — peak pending jobs / candidates / observers; peak owned; restore | 11 / 4,998 / 2; 118; 1.2 (10.7) ms | 1 / 0 / 2; 118; 0.7 (0.8) ms |
| Grouped — `performance.memory` delta bytes | 1,459,760 (5,109,708) | -828,548 (2,701,184) |
| **Flat — total processing / wall** | 219.4 (255.1) / 615.8 (628.6) | 150.2 (482.6) / 318.2 (981.9) |
| **Flat — initial processing / wall** | 158.0 (203.4) / 464.8 (504.9) | 95.5 (335.4) / 189.1 (707.2) |
| Flat — initial visits; geometry checks; pruned branches; discovery passes | 7,589; unavailable; unavailable; unavailable | 2,590; 2,721; 2,498; 1 |
| Flat — initial first-visible latency; heartbeat delay; longest task | 6.0 (7.3); 12.6 (16.6); 0 (0) ms | 6.8 (43.9); 10.1 (150); 0 (0) ms |
| Flat — max engine slice over both phases | 10.1 (11.5) ms | 8.2 (34.0) ms |
| Flat — after-scroll processing / wall | 47.5 (61.4) / 120.4 (151.1) | 63.0 (147.2) / 138.1 (274.7) |
| Flat — after-scroll visits; geometry checks; pruned branches; discovery passes | 0 additional visits; unavailable; unavailable; unavailable | 5,030 visits; 5,046; 4,992; 1 |
| Flat — scroll first-visible latency; heartbeat delay; longest task | 15.7 (33.2); 9.6 (12.9); 0 (0) ms | 19.2 (41.3); 9.8 (23.9); 0 (57) ms |
| Flat — peak pending jobs / candidates / observers; peak owned; restore | 1 / 4,996 / 2; 118; 0.8 (1.0) ms | 1 / 0 / 2; 118; 0.9 (0.9) ms |
| Flat — `performance.memory` delta bytes | 329,302 (7,610,096) | -1,849,172 (2,175,064) |

New-engine geometry-check, prune, and discovery values are additional work in each phase, not unique-node counts. Old-engine `visitedNodes` does not count candidate rescans; its zero after-scroll visit delta does not mean zero scroll work (processing/wall measures that phase). Old geometry/discovery fields are unsupported/null, not zero. Both engines/shapes had 0 pre-restore translation mismatches and 0 restore mismatches; all 118 targets were translated, 116 restored, both external edits preserved, and exclusions untouched in each trial. The 118 owned records intentionally remain until restore and are not pending backlog. Long-task zeros mean no qualifying entry observed, not proof of no long tasks. `performance.memory` deltas include fixture setup, restore/cleanup, and GC effects; they are noisy and do not establish retained-memory behavior. These small synthetic runs are noisy, especially flat p95s; they show no arbitrary CSS correctness guarantee—geometry pruning can miss descendants overflowing an offscreen ancestor—and establish no production speedup or replacement equivalence.

Reproduce the old run with `PAGE_TRANSLATION_ENGINE_SOURCE=/tmp/opencode/page-translation-engine-before.js pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs`; add `PAGE_TRANSLATION_FIXTURE=flat` for siblings (default grouped). Omit the engine override to use the current `engine.js`. Keep each run sequential and use the same browser, viewport, fixture parameters, and trial count.

## Irrelevant root-attribute churn (old engine; 2026-11-03)

The current benchmark additionally performs 12 serial writes of distinct values to root `data-benchmark-noise`, awaiting a scheduler tick and `whenIdle()` after each. This attribute is not referenced by fixture CSS or configured custom exclusions. Root-attribute validation permits only this intentional change; it is restored before the next trial. This phase follows initial/scroll correctness sampling, and its task meter/heartbeat exclude all oracle work. These measurements use `/tmp/opencode/page-translation-engine-before-attributes.js`, the 355-line source captured before the attribute-audit change (SHA-256 `3d639965d2ebd6f57422664813c01db0e9c23013053d1b8fb865f86a827ca595`).

| Viewport noise-phase metric | Grouped depth 4 | Flat sibling depth 1 |
| --- | ---: | ---: |
| Processing time | 697.9 (877.8) ms | 432.1 (518.7) ms |
| Wall elapsed for 12 write-and-idle bursts | 1,825.0 (2,044.0) ms | 1,495.7 (1,596.8) ms |
| Additional visits / geometry checks / pruned branches / discovery passes | 60,756 / 61,152 / 59,904 / 12 | 60,360 / 60,432 / 59,904 / 12 |
| Peak pending jobs / candidates / observers | 1 / 0 / 2 | 1 / 0 / 2 |
| Heartbeat delay / longest observed task | 10.4 (17.7) / 0 (0) ms | 4.4 (8.0) / 0 (0) ms |
| Mutation audit time / count / fallback count | unavailable (old stats) | unavailable (old stats) |

Both fixture shapes retained 118 owned nodes, had zero translation/restore mismatches, preserved both external edits, and passed the deliberate-root-attribute exclusion check. The 12-burst result exposes repeated traversal/geometry work on this pre-audit engine; it is not evidence of user-visible production performance.

## Final bounded attribute-audit comparison (2026-11-03)

The same 12-burst harness and 780×493 Headless Chromium setup were run sequentially against the captured pre-audit engine (`/tmp/opencode/page-translation-engine-before-attributes.js`, SHA-256 `3d639965d2ebd6f57422664813c01db0e9c23013053d1b8fb865f86a827ca595`) and final engine SHA-256 `8535cc11a03e7c99a584cd7ea6f43deafe1707f8393c0f501b6a849841fae2bc`. Each run used one warmup and five samples per mode. This final set excludes provisional `cd5b…` runs.

| Viewport metric, median (p95) | Grouped old | Grouped final | Flat old | Flat final |
| --- | ---: | ---: | ---: | ---: |
| Initial processing / wall (ms) | 160.4 (214.6) / 315.1 (437.0) | 140.9 (159.5) / 315.1 (323.8) | 95.3 (148.5) / 215.6 (277.6) | 108.5 (125.9) / 215.3 (250.4) |
| Initial visits / geometry checks / discovery passes | 2,602 / 2,739 / 1 | 2,602 / 2,739 / 1 | 2,590 / 2,721 / 1 | 2,590 / 2,721 / 1 |
| Initial first-visible latency / max slice (ms) | 8.6 (31.5) / 12.1 (27.8) | 6.8 (28.0) / 9.7 (11.6) | 5.7 (8.8) / 8.9 (14.5) | 5.7 (6.3) / 9.5 (10.6) |
| Scroll processing / wall (ms) | 76.1 (108.7) / 166.5 (208.0) | 68.6 (78.0) / 156.5 (164.6) | 51.0 (84.9) / 124.7 (185.6) | 53.4 (71.3) / 133.9 (145.4) |
| Scroll visits / geometry checks / discovery passes | 5,063 / 5,106 / 1 | 5,063 / 5,106 / 1 | 5,030 / 5,046 / 1 | 5,030 / 5,046 / 1 |
| Scroll first-visible latency (ms) | 15.0 (19.5) | 12.8 (20.9) | 17.1 (35.6) | 16.1 (22.0) |
| Noise scheduled engine processing (ms) | 697.9 (877.8) | 0 (0) | 432.1 (518.7) | 0 (0) |
| Synchronous mutation audit callback (ms; 12 audits) | unavailable | 0.9 (2.7); 12 calls, 0 fallbacks | unavailable | 0.6 (0.9); 12 calls, 0 fallbacks |
| Total accounted noise processing = scheduled processing + audit (ms) | 697.9 (877.8), audit unavailable | 0.9 (2.7) | 432.1 (518.7), audit unavailable | 0.6 (0.9) |
| Noise wall / heartbeat delay (ms) | 1,825.0 (2,044.0) / 10.4 (17.7) | 51.3 (51.8) / 0.5 (1.5) | 1,495.7 (1,596.8) / 4.4 (8.0) | 50.7 (52.7) / 0.4 (2.0) |
| Noise visits / geometry checks / pruned branches / discovery passes | 60,756 / 61,152 / 59,904 / 12 | 0 / 0 / 0 / 0 | 60,360 / 60,432 / 59,904 / 12 | 0 / 0 / 0 / 0 |
| Noise peak pending jobs / candidates / observers; peak owned nodes | 1 / 0 / 2; 118 | 0 / 0 / 2; 118 | 1 / 0 / 2; 118 | 0 / 0 / 2; 118 |
| Noise longest observed task (ms) | 0 (0) | 0 (59) | 0 (0) | 0 (0) |

The final engine reports the CSS audit as synchronous callback time separate from `processingMs` and `maxSliceMs`. Consequently the relevant new-engine noise work figure is scheduled processing plus audit time (0.9 ms grouped, 0.6 ms flat median); wall and heartbeat also include callback impact. A 59 ms grouped noise-phase long-task p95 was observed despite a 2.7 ms maximum reported audit in five samples; this observer signal is broader/noisier and is reported, not attributed to a single audit. Initial/scroll results show mixed flat timing indicators (flat initial processing median rose 13.2 ms, while p95 and wall were lower); do not infer broad speedup. All modes/shapes reported 0 translation mismatches and 0 restore mismatches, preserved external edits, left exclusions untouched, translated 118 targets, restored 116, and retained 118 owned records until Restore. Candidate/backlog reached zero during final noise sampling; owned-node retention is intentionally separate. These bounded synthetic results do not establish general CSS correctness or production performance. Scoped dependency auditing cannot see un-discovered shadow stylesheet references; escapes/inaccessible sheets/over-budget audits use fallback rediscovery, and fallback counts were zero in these trials.

## Historical: candidate/scroll fix comparison (2026-11-02; earlier harness)

**Run date:** 2026-11-02. Same Headless Chromium 156/Linux x86_64, viewport 780×493, fixture workload, warmup, five measured samples per mode, and alternating mode order as above. “Pre” and “final post” are separate runs of the same harness around the candidate/scroll fix; these are noisy synthetic measurements, not a controlled timing benchmark. Values are median (p95), milliseconds unless stated.

| Viewport metric | Pre | Final post |
| --- | ---: | ---: |
| Engine processing | 235.1 (301.4) | 216.2 (326.9) |
| External wall elapsed | 711.1 (793.0) | 649.1 (786.4) |
| First visible DOM write | 7.1 (7.7) | 6.5 (17.4) |
| Restore | 0.5 (2.5) | 0.5 (2.1) |
| Max engine translation slice | 9.6 (11.6) | 9.0 (17.9) |
| Heartbeat delay proxy | 13.4 (16.6) | 11.0 (28.0) |
| Longest observed translation task | 0 (0) | 0 (0) |
| `performance.memory` delta, bytes | -1,330,864 (3,080,540) | 229,932 (10,471,077) |

The synchronous baseline in the pre run had engine-processing median 211.0 ms, wall median 228.0 ms, first-write median 134.5 ms, restore median 11.1 ms, and longest observed task median/p95 200/245 ms. In the final-post run those figures were 208.9 (330.5) ms, 247.1 (369.8) ms, 139.1 (216.8) ms, 17.2 (26.2) ms, and 201 (316) ms respectively.

Across all samples in both runs and modes: zero pre-restore translation mismatches, zero restoration mismatches, exclusions untouched, external edits preserved; 108 translated, 106 restored, 2 external edits preserved. Baseline traversal/restoration visits were 15,066 in both runs. Viewport visits changed from 15,090 pre to 15,102 final post as the seed/discovery deduplication strategy changed; viewport restoration visits were 108 in each. Visit counts describe engine work, not unique nodes. Timing differences are within noisy synthetic-run variability; the final viewport max-slice and heartbeat p95s were higher, so do not claim broad timing improvement. Heap deltas include setup, cleanup, and GC; they do not establish retained memory. The confirmed benefit is deterministic bounded candidate/queue memory under the tested churn, not broad speedup. Firefox/Reddit validation was not run.

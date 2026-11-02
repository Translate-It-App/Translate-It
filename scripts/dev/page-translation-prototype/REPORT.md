# Page translation traversal prototype — synthetic benchmark report

**Run date:** 2026-11-02  
**Environment:** Headless Chromium 156.0.0.0, Linux x86_64, viewport 780×493; long-task observer supported.  
**Fixture:** isolated marked local fixture; default 2,500 branches × depth 4, with visible text/attributes, open shadow content, exclusions/editable controls, dynamic additions, and two external edits before restore.  
**Trials:** one discarded warmup per mode, then five measured samples per mode; order alternated (baseline→viewport, then viewport→baseline).  
**Commands:** `pnpm test:run scripts/dev/page-translation-prototype.test.js scripts/dev/page-translation-prototype-benchmark.test.js`; `pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs`.

Medians and p95s are across five samples (nearest-rank p95). Times are milliseconds. Baseline is a simulated synchronous full-discovery prototype, **not** production `domtranslator`.

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

## Candidate/scroll fix comparison

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

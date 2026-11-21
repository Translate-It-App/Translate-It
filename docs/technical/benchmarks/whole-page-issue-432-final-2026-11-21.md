# Whole-page translation benchmark — Issue #432 final

**Evidence reviewed:** 2026-11-21 · **Checkout reviewed:** `5404f99cb9367d2013cf1789d98b4d31b5efb5be` · **Browser in provider matrix:** Chrome 157.0.8103.78

This report synthesizes the available Issue #432 provider, resilience, cancellation, stale-reply, and offline-soak artifacts under `/tmp/opencode`. These are historical artifacts from multiple dirty source revisions, not a single run of the current checkout. The report does not combine their timings across revisions, and no benchmark was run to fill evidence gaps. See the separate [Issue #406 final report](whole-page-issue-406-final-2026-11-19.md) for its unrelated scenarios and provenance.

## Executive summary

- The provider matrix covers Google V2, Custom, and Gemini at optimization levels 1/3/5 with Fluid and On-Stop scheduling: 18 configurations, each with three passing measured trials and one discarded warmup. All timing cells below are derived from the measured raw trials; Google's stored summaries are absent, while the Custom and Gemini summaries are not used for the table. p95 is not reported for `n=3`.
- These are synthetic, offline production-pipeline tests with a fixed 50 ms response delay, not live-provider latency, quality, capacity, or service-limit comparisons. They do not support ranking Google V2, Custom, or Gemini in real-world use.
- In these fixtures, On-Stop took longer from command to total completion than Fluid for all 18 provider/configuration pairs. This is an observation about this scroll-through harness and its deliberate scroll-stop policy, not evidence that either policy is universally better.
- Higher optimization levels changed the batch/request counts and observed concurrency as configured. In the synthetic matrices, level 5 often took longer to complete than levels 1/3; the association is real in these samples, but its cause and real-provider impact are not established.
- Selected isolated probes pass for Google V2 503 retry and timeout, Custom 429/400 handling, Gemini structured recovery, three cancellation cases, and three stale-reply cases. The separate Phase 2.4 Custom soak passed all 30 scenarios across ten cycles with no cleanup errors.
- Chrome renderer heap was unavailable. Runner RSS includes report/history overhead and cannot establish or exclude a memory leak.

## Coverage matrix

| Area | Evidence | Coverage and status | Important boundary |
| --- | --- | --- | --- |
| Google V2 / Custom / Gemini provider performance | Per-configuration JSON artifacts under `/tmp/opencode/issue432-{googlev2,custom,gemini}-level-*.json` | Levels 1/3/5 × Fluid/On-Stop; 3 measured + 1 warmup each; passing artifacts selected below | Synthetic response; provider matrices come from three different source revisions |
| Edge optimization levels | `page-translation-provider-e2e-2026-11-19T16-{19-43.023Z-1403969,21-11.818Z-1406045,22-38.649Z-1408154}.json` | Levels 1/3/5, `early-visible`, 1,000 targets, 3 measured + 1 warmup | Not a matching three-band Fluid/On-Stop provider matrix; cannot serve as an equivalent Edge comparison |
| Resilience | `issue432-r3-resilience-{googlev2-503,googlev2-timeout,custom-429,custom-400,gemini-recovery}.json` and matching `*-resilience-*.json` evidence sidecars | Passing isolated cases; correctness-only | Injected/offline responses; no performance samples |
| Cancellation | `issue432-r3-cancellation-probes.json` | Stop, Restore, Replacement passed | Separate fresh sessions, correctness-only |
| Successful stale result | `issue432-r3-stale-success-probes.json` | Replacement, Stop, Restore passed | Genuine held successful reply in harness; correctness-only |
| Offline stability | `custom-offline-soak-issue-432-final.json` | 10 cycles / 30 scenarios passed | One reused Chrome process/profile; not a leak test |
| Live providers, real-world ranking, p95, Chrome heap | None | Not measured / not supported | See [Coverage gaps](#coverage-gaps) |

## Source and environment provenance

The checked-out baseline at report time was `5404f99cb9367d2013cf1789d98b4d31b5efb5be`; it is not the source of all the archived runs.

| Evidence group | `provenance.gitSha` | Branch | Browser | Recorded source state |
| --- | --- | --- | --- | --- |
| Google V2 performance matrix | `186e6f1971b59907038b69d86b1e9117b596b510` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; artifact records per-file SHA-256 hashes |
| Custom performance matrix | `2d1c4b9aedcbba757db3eb6a4aa489bcef869d76` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; use `issue432-custom-level-3-fluid-final.json` for that passing cell |
| Gemini performance matrix | `4b73d1a7963e161f365da329ea2d0ef1bda6cf00` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; artifact records per-file SHA-256 hashes |
| Edge early-visible levels | `0917e0baae051ea062e2ded73cc827dd60875de8` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; the matching final Edge artifacts are identified from the final-level run logs |
| R3 resilience / cancellation / stale-success | `c8082fa54e123e969fbf510659396c7670e31d78` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; each result is a separate correctness probe |
| Final offline soak | `cabc04375db06e19f2784245e782f969cd6c6f0e` | `issue-432-provider-benchmark` | Chrome 157.0.8103.78 | Dirty working tree; production build parity passed |

The performance artifacts run the production MV3 background/content builds, actual page scheduler and provider pipeline, with CDP fulfilling deterministic synthetic provider responses. The matrices are each internally consistent within their recorded artifact/source revision; numbers are **not** pooled across source revisions. The fixed 50 ms synthetic response delay is part of the workload. Build parity, source hashes, run settings, trial status, and cleanup are recorded in the raw JSON. The `*-network-guard-probe.json` siblings are guard checks, not performance trials.

### Reproduction commands

Run from repository root. These commands document how to reproduce the setup; they were not run for this report. Reproduction requires checking out the matching historical source and reproducing its working-tree changes; the commit SHA alone is insufficient. `BENCH_OUTPUT` values below identify the historical output names, but a new run must not overwrite retained evidence.

```sh
set -e
for provider in googlev2 custom gemini; do
  for level in 1 3 5; do
    for scheduling in fluid on-stop; do
      BENCH_LANE=provider BENCH_PROVIDER="$provider" BENCH_OPTIMIZATION_LEVEL="$level" \
        BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING="$scheduling" \
        BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
        BENCH_OUTPUT="/tmp/opencode/reproduction-${provider}-level-${level}-${scheduling}.json" \
        pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
    done
  done
done
```

The original Edge artifacts use the early-visible large-page scenario, not this provider matrix:

```sh
for level in 1 3 5; do
  BENCH_LANE=provider BENCH_PROVIDER=edge BENCH_OPTIMIZATION_LEVEL="$level" \
    BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
    BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
    BENCH_OUTPUT="/tmp/opencode/reproduction-edge-level-${level}.json" \
    pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
done
```

The isolated correctness-only reproductions are documented in the [harness README](../../../scripts/dev/page-translation/e2e-benchmark/README.md): search for “Google V2 transient 503”, “Custom 429”, “Custom permanent HTTP 400”, “Gemini structured-recovery”, “Google V2 production timeout”, “Custom cancellation”, “successful stale”, and “Ten-cycle Custom offline soak”. They are intentionally run separately from the performance matrix.

## Provider performance

The comparison is 1,000 unique targets arranged in three viewport bands on the provider matrices. “First visible” is command-to-first accepted DOM write among the initially visible band; “all writes” is command-to-last accepted DOM write; “complete” is command-to-terminal completion; Restore is separate. Values are **median (minimum–maximum) milliseconds across the three measured raw trials**. They are not p95. Throughput is derived per trial as 1,000 targets divided by command-to-terminal milliseconds, then summarized as median (range) targets/s. Small samples and run-to-run variance make these descriptive, not inferential.

| Provider | Level | Scheduling | First visible (ms) | All writes (ms) | Complete (ms) | Throughput (targets/s) | Restore (ms) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| Google V2 | 1 | Fluid | 256 (250–262) | 2451 (2420–2491) | 2488 (2479–2503) | 402 (400–403) | 92 (90–116) |
| Google V2 | 1 | On-Stop | 270 (245–272) | 3021 (2953–3117) | 3035 (2981–3145) | 329 (318–335) | 94 (92–103) |
| Google V2 | 3 | Fluid | 271 (251–308) | 2606 (2480–2979) | 2630 (2512–3004) | 380 (333–398) | 94 (92–105) |
| Google V2 | 3 | On-Stop | 257 (257–260) | 2951 (2949–2984) | 2985 (2967–3473) | 335 (288–337) | 99 (91–100) |
| Google V2 | 5 | Fluid | 264 (247–337) | 2930 (2852–3609) | 3386 (3336–4009) | 295 (249–300) | 102 (98–124) |
| Google V2 | 5 | On-Stop | 292 (261–489) | 3505 (3478–4179) | 3910 (3891–4574) | 256 (219–257) | 93 (91–102) |
| Custom | 1 | Fluid | 227 (222–234) | 2377 (2369–2386) | 2418 (2400–2434) | 414 (411–417) | 90 (86–103) |
| Custom | 1 | On-Stop | 233 (222–236) | 2827 (2816–2854) | 2871 (2862–2903) | 348 (344–349) | 92 (89–93) |
| Custom | 3 | Fluid | 229 (226–252) | 2402 (2389–2647) | 2441 (2432–3129) | 410 (320–411) | 96 (89–106) |
| Custom | 3 | On-Stop | 229 (228–233) | 2827 (2826–2901) | 2893 (2866–2927) | 346 (342–349) | 93 (90–94) |
| Custom | 5 | Fluid | 232 (219–235) | 2845 (2764–2851) | 3300 (2780–3301) | 303 (303–360) | 93 (91–93) |
| Custom | 5 | On-Stop | 225 (216–232) | 3250 (3157–3311) | 3624 (3596–3672) | 276 (272–278) | 91 (91–93) |
| Gemini | 1 | Fluid | 259 (235–352) | 2271 (2029–2574) | 2443 (2212–2807) | 409 (356–452) | 91 (90–93) |
| Gemini | 1 | On-Stop | 317 (280–450) | 2859 (2797–3192) | 3018 (2956–3270) | 331 (306–338) | 96 (95–109) |
| Gemini | 3 | Fluid | 325 (282–348) | 2193 (2157–2387) | 2360 (2276–2487) | 424 (402–439) | 122 (99–144) |
| Gemini | 3 | On-Stop | 242 (226–318) | 2581 (2354–2664) | 2870 (2586–3003) | 348 (333–387) | 108 (88–130) |
| Gemini | 5 | Fluid | 238 (225–467) | 2149 (1913–2934) | 2349 (2121–3418) | 426 (293–471) | 93 (90–95) |
| Gemini | 5 | On-Stop | 271 (216–293) | 2574 (2398–2644) | 2735 (2612–2773) | 366 (361–383) | 92 (88–99) |

### Batch and concurrency observations

Logical batches and physical HTTP operations are separate evidence and are reported separately. Counts/peaks below are identical across all three measured trials within each row:

| Provider | Level | Logical batches / trial | Batch size range | Peak logical concurrency | Physical HTTP requests / trial | Peak physical concurrency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Google V2 | 1 | 21 | 33–50 | 1 | 21 | 1 |
| Google V2 | 3 | 42 | 8–25 | 2 | 42 | 2 |
| Google V2 | 5 | 102 | 3–10 | 4 | 102 | 4 |
| Custom | 1 | 21 | 33–50 | 1 | 21 | 1 |
| Custom | 3 | 42 | 8–25 | 2 | 42 | 2 |
| Custom | 5 | 102 | 3–10 | 4 | 102 | 4 |
| Gemini | 1 | 15 | 13–80 | 1 | 15 | 1 |
| Gemini | 3 | 36 | 3–30 | 3 | 36 | 3 |
| Gemini | 5 | 69 | 3–15 | 6 | 69 | 6 |

The per-provider optimizer changes the observed batching and concurrency. At levels 1/3/5, Custom and Google V2 emitted 21/42/102 batches; Gemini emitted 15/36/69. These are confirmed fixture observations. The increase in request count at higher levels coincides with longer completion in most rows but does not prove that request count alone caused the latency; scheduler policy, provider pipeline, synthetic adapter, and differing source revisions also matter.

### Edge results are a different fixture

The three final Edge artifacts cover optimization levels 1/3/5 on a 1,000-target **early-visible** fixture with the same four initially visible targets, but do not cover Fluid/On-Stop scroll-through scheduling. Values are median (minimum–maximum) milliseconds over three raw trials:

| Edge level | First visible (ms) | All writes (ms) | Complete (ms) | Physical requests / trial | Peak physical concurrency |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 (n=3) | 225 (224–230) | 1335 (1334–1367) | 1780 (1759–1781) | 20 | 1 |
| 3 (n=3) | 228 (225–228) | 2416 (2412–2469) | 2858 (2807–2863) | 40 | 1 |
| 5 (n=3) | 194 (194–291) | 5636 (5625–5734) | 6138 (6129–6236) | 100 | 1 |

This is not a like-for-like comparison with the three-band AI provider matrix. In particular, it cannot answer whether Edge Fluid versus On-Stop performs differently on 1,000 scroll-through targets.

### Timing interpretation

**Observations:** artifacts separately timestamp discovery start/drain, first scheduler flush, scheduler request entry, background and queue admission, provider request start/end, individual transport attempts, first visible acceptance, all writes, completion, and Restore. In the Google V2 level-3 Fluid measured trial, for example, `runtimeMessageHandoff` is explicitly unavailable, while discovery drain and provider transport are observed separately. The provider matrices contain request-level HTTP latencies, with synthetic responses around the fixture's fixed delay plus harness/browser overhead.

**Interpretation:** these timestamps overlap across concurrent batches and do not form additive stage durations. They also come from different execution contexts/clocks in places. Runtime-message handoff is not measured, accepted DOM writes are not paint, and the fixed synthetic response cannot quantify real network or provider time. The present evidence identifies no single confirmed production bottleneck in discovery, scheduler, transport, or provider service. A delay measured in one synthetic stage is not sufficient to diagnose user-perceived latency.

## Correctness and stability

### Resilience probes

The selected R3 artifacts use source `c8082fa54e123e969fbf510659396c7670e31d78`; all parent artifacts passed, had empty root cleanup-error arrays, and recorded passing network-guard sibling probes. The focused results are:

- **Google V2 HTTP 503:** exactly one selected synthetic 503 was followed by a successful production retry; the 1,000-target result validated. This proves the tested retry path, not live Google behavior.
- **Google V2 timeout:** the held production batch reached the real timeout path; the expected 25 targets remained unaccepted and 975 were translated. No performance conclusion follows from this intentionally extended probe.
- **Custom HTTP 429:** the injected rate limit exercised shared cooldown and queued sibling behavior; all 1,000 target outputs validated after recovery. No live Custom service was contacted.
- **Custom HTTP 400:** the permanent-error path did not treat the failed 25-target batch as a successful translation; the unaffected 975 targets validated. This is typed-error correctness, not a claim about remote provider error text.
- **Gemini structured recovery:** one malformed structured primary response triggered the recorded same-batch recovery path; all 1,000 translations validated. It does not characterize live model reliability.

Raw parent artifacts: `issue432-r3-resilience-googlev2-503.json`, `issue432-r3-resilience-googlev2-timeout.json`, `issue432-r3-resilience-custom-429.json`, `issue432-r3-resilience-custom-400.json`, and `issue432-r3-resilience-gemini-recovery.json`; each has a sibling probe-specific `*-resilience-*.json` evidence artifact. These are single isolated correctness runs, not repeated statistical evidence.

### Cancellation and stale success

`issue432-r3-cancellation-probes.json` passed the three requested cases:

- **Stop:** a correlated held provider request was cancelled/settled and then restored.
- **Restore:** restore invalidated active work, with the held request and handler accounted for.
- **Replacement:** A was stopped, B ran under a distinct session, and Restore returned the fixture to its original state.

`issue432-r3-stale-success-probes.json` passed **Replacement**, **Stop**, and **Restore**. Its genuine held successful scheduler reply was released after invalidation; the cases verified no stale-result mutation and appropriate replacement ownership. The replacement case accepted all 1,000 B targets and restored the page. These findings establish the tested Chrome harness scenarios only; they do not establish cross-browser behavior or performance.

### Ten-cycle offline soak

`/tmp/opencode/custom-offline-soak-issue-432-final.json` is the final Phase 2.4 artifact. It passed 10 cycles × Complete→Restore, Partial→Stop→Restore, and stale-success A→B replacement (30/30 scenarios). Configuration: Custom, level 3, Sliced, Fluid, 1,000 targets; one Chrome 157.0.8103.78 launch/process and one reused page target; build parity passed. Its source is `cabc04375db06e19f2784245e782f969cd6c6f0e` on `issue-432-provider-benchmark`.

All scenarios passed their target/metadata restoration and ownership checks; sampled active runtime resources drained to zero; cleanup errors were empty. The artifact records 1,020 Custom physical requests total and peak physical concurrency 2. Normalized concurrency evidence reports peak logical-batch concurrency 2 for Complete and Partial, and 3 for Stale Replacement, in every cycle. Partial-stop runs accepted 334 targets before Stop; replacement runs accepted zero A targets and all 1,000 B targets with no stale writes.

Runner RSS had a 133,386,240-byte baseline and an observed checkpoint range of 1,147,445,248–1,870,258,176 bytes. The last scenario checkpoint was 1,753,575,424 bytes; final Runner RSS was 1,930,133,504 bytes. These process-level values include runner and retained artifact/history overhead. `browserHeapBytes` is null with an explicit unavailable reason. **Chrome Heap was not measured; Runner RSS cannot establish or exclude memory leaks.** The soak verifies repeated scenario behavior and drainage under this bounded workload, not indefinite stability.

## Confirmed findings, hypotheses, and follow-ups

### Confirmed from these artifacts

1. All 18 selected AI matrix configurations passed three measured trials and a separate discarded warmup, with build parity and cleanup recorded as passing. Matrix timing metrics come from raw trial fields for Google V2 and from stored summaries cross-checked against trials for Custom/Gemini.
2. On-Stop completion was slower than Fluid in every matching provider/level pair in this synthetic three-band fixture. It is an effect of this configured interaction, not a universal scheduler result.
3. Optimization levels changed observed batch sizes, request counts, and concurrency, as shown above. The level-5 Custom and Google V2 rows had substantially more requests than their level-1 rows; their completion times were also higher in the observed runs.
4. The selected resilience and lifecycle probes passed their recorded assertions, and the 10-cycle soak passed all 30 scenarios with cleanup and resource-drain checks.
5. The historical Edge fixture metadata is inconsistent: the harness README says Edge scroll-through remains a 12-target fixture, but the final Edge artifacts cited above record `scenario: early-visible` and `targetCount: 1000`. The artifacts also record the Edge startup voice-list GET as `startup-metadata-fixture`, fulfilled with `[]`; the README's generic description of Edge fixture transport should not be read as a claim that the Edge translation fixture used the same request shape or workload as the AI provider lanes. This is historical metadata drift, not evidence to alter old artifacts or to change harness code.

### Hypotheses (not established)

- More, smaller batches and increased queue/scheduler coordination may contribute to the high-level completion increase. Artifacts show correlation, not a causal decomposition.
- The observed On-Stop delay may be largely due to the explicit scroll-stop wait and staged viewport advancement. The measurements do not isolate that policy from all other scheduling and harness effects.
- Any stage dominating real-user delay remains unknown. Synthetic response timing and incomplete runtime-message handoff measurements prevent attribution.

### Recommended separate GitHub issues (not created)

1. **Equivalent Edge provider matrix:** add an explicitly matched 1,000-target three-band Edge run for Fluid and On-Stop across optimizer levels, with the same trial protocol and provenance requirements. The current early-visible Edge result is not a substitute.
2. **Increase repeated matrix samples:** repeat key provider/scheduling cells with at least 40 valid samples before reporting p95 or making stable performance claims; keep source revision and fixture constant within each comparison.
3. **Investigate high-level request amplification:** inspect why the recorded level-5 configuration emits more, smaller requests and whether that is desirable under real workloads. First reproduce with deterministic controlled inputs; do not infer a provider-service bottleneck from synthetic timings.
4. **Memory observability:** if leak claims are needed, add a separate Chrome renderer/heap measurement design with repeated checkpoints and controlled artifact retention. Runner RSS is not a browser heap proxy.

## Coverage gaps

- **Edge parity:** no equivalent Edge matrix for the three-band, 1,000-target Fluid/On-Stop workload. The available Edge results are early-visible with no lazy scheduling; their environment metadata describes a `targetCount` of 1,000, so “missing” means missing an equivalent comparison, not missing all 1,000-target Edge data.
- **Source revisions:** Edge, Google V2, Custom, Gemini, R3 correctness, and the soak each have distinct provenance. The provider matrix was not measured at one common source revision. This report preserves those boundaries and does not use cross-revision differences as provider rankings.
- **Samples and summary availability:** only three measured samples per configuration. p95 is not supported. Primary Google V2 JSON lacks `scenarioSummaries`; Google timings here are derived as `derivedTimings[metric] - derivedTimings.translationCommand` from its three passing measured trials. Custom level-3 Fluid had failed earlier attempts; the table uses the later `issue432-custom-level-3-fluid-final.json`, not the failed artifacts.
- **Timing boundaries:** runtime-message handoff was unavailable; discovery drain is not traversal CPU; measured acceptance is DOM mutation, not paint; overlapping stages are not additive. The table does not include a defensible independent scheduler/provider “bottleneck” ranking.
- **Synthetic versus live:** no provider matrix, resilience probe, or soak sent live provider traffic. Synthetic answers cannot establish translation quality, live latency, availability, limits, 429 frequency, or real service behavior. Throughput is fixture completion rate, not provider capacity.
- **Transport metadata:** the README's Edge description needs to be read with the historical mismatch called out above: Edge final artifacts show a 1,000-target early-visible scenario, while README text describes Edge scroll-through as 12 targets. The Edge startup voice-list request is separately logged as a local metadata fixture with a `[]` response. This report documents the mismatch without rewriting historical artifacts.
- **Memory and stability:** Chrome Heap was not measured. Runner RSS includes evidence retention and cannot prove or disprove a leak. Ten cycles cannot establish indefinite memory stability.
- **Browser/network scope:** this is Chrome-only evidence; iframe/OOPIF and Chrome process/component traffic are outside the harness guard. No Firefox/WebKit comparison is present.

## Validation notes

Every reported matrix cell was checked against its named raw artifact and three measured `results` entries. Latency was calculated from each trial's `derivedTimings` as `eventTimestamp - translationCommand`; Restore is `restoreEnd - restoreStart`. Throughput was calculated per trial as `1000 / (completionLatencyMs / 1000)`. Tables report only median and observed min/max, not p95. Batch counts, sizes, peaks, run status, warmup count, build parity, provenance, and cleanup were read from the corresponding JSON. R3 correctness assertions and the soak totals were checked in their raw artifacts. Historical Edge transport/scenario metadata was compared with the harness README. No benchmarks were executed for this report.

# Whole-page translation benchmark — Issue #406 final

**Run date:** 2026-11-19 · **Final source:** `e72e06d2370d301a9e6b9298294b05907ecdd7ab` (clean tracked and untracked provenance) · **Chrome:** 157.0.8103.78

This record consolidates the final real-pipeline Chrome E2E measurements and separate correctness probes. It does not replace or combine with the earlier direct-Bridge discovery studies below. Raw final artifacts live outside the repository in `/tmp/opencode` (artifact filenames referenced in the run ledger).

## Final performance results

Each cell is p50 milliseconds, **n=5**, Legacy/Sliced. **First Visible Acceptance** is command-to-first accepted write among targets visible at the start of the run; it is not first acceptance anywhere. The raw runs separately record `firstAcceptedWrite`, the first accepted DOM write among all targets, but that metric is not summarized in this table. `All writes` is command-to-last accepted write across all fixture targets; `Terminal` is command-to-real terminal lifecycle receipt; `Restore` is actual Restore duration. These are distinct clock boundaries. p95 is unavailable by repository policy because five samples are fewer than the minimum 40.

| Scenario | First Visible Acceptance | All writes | Terminal | Restore |
| --- | ---: | ---: | ---: | ---: |
| Small (12 targets) | 919 / 920 | 919 / 920 | 1419 / 1420 | 66 / 65 |
| Dynamic DOM (12 initial + 6 inserted) | 920 / 920 | 1238 / 1240 | 1420 / 1420 | 63 / 63 |
| Open Shadow DOM (3 initial + 2 inserted) | 919 / 919 | 1552 / 1560 | 2054 / 2062 | 66 / 65 |
| SPA route B (navigation clock) | 995 / 995 | — | 1496 / 1497 | passed |
| Early-visible (1,000 targets) | 203 / 184 | 2608 / 2331 | 2865 / 2829 | 86 / 86 |
| In-window-visible (1,000 targets) | 205 / 179 | 2615 / 2325 | 2875 / 2820 | 85 / 89 |
| Late-visible (1,000 targets) | 205 / 247 | 2624 / 2327 | 2871 / 2825 | 87 / 87 |
| Scroll-through, Fluid (12 targets) | 930 / 933 | 2533 / 2498 | 3035 / 3001 | 66 / 66 |
| Scroll-through, On-stop (12 targets) | 625 / 627 | 2210 / 2191 | 2712 / 2693 | 65 / 65 |

SPA route B's first accepted write is `navigationToFirstAcceptedWrite` on the navigation clock (the row is not command-clocked); the final value is `navigationToBCompletion`, not a page-start clock. SPA validates real route-A invalidation, B ownership, retained-node reuse, changed-target-only work, and route-specific Restore. The raw per-mode values are 994.6/995ms and 1496.2/1496.9ms respectively.

The standard Chrome run passed all seven scenarios in Legacy and Sliced, with build parity/comparison gates passed and empty cleanup errors: 70 measured trials plus 14 discarded warmups (84 total). Each standard scenario has five measured samples and one cold-profile warmup per mode. The two scroll runs each passed 10 measured plus 2 warmup trials. **Total performance evidence: 108 trials = 90 measured + 18 discarded warmups.** Correctness probes below are additional, not included in 108.

Dynamic cohorts reached first/all acceptance at approximately 877ms for cohort 1 and 308/309ms for cohort 2 (Legacy/Sliced). Each Shadow DOM inserted cohort reached acceptance in approximately 309ms in both modes. The Shadow fixture has three initial targets (light DOM text, open-root text, nested open-root `title`) and two dynamic targets (a root on a detached host, then later root content); direct ShadowRoot child-text and closed-root sentinels remain untouched.

For the three large layouts, Legacy/Sliced calibrated task summaries over five samples were: early-visible 5 tasks (max 83ms, total blocking time 155ms) / 0; in-window 5 (max 86ms, 161ms) / 1 (max 55ms, 5ms); late-visible 5 (max 106ms, 186ms) / 0. Each sample issues 40 synthetic provider HTTP batches of 25 for these 1,000 targets. The long-task calibration runs a separate 75ms task excluded from measurement; entries (browser threshold generally ≥50ms) count only if the whole entry lies within the measurement interval. Long tasks are not paint measurements.

## Correctness and network evidence

- **Chrome cancellation:** `page-translation-issue-406-final-cancellation.json`; Sliced `stop`, `restore`, and `replacement` all passed, its sibling negative network probe passed, cleanup empty. These cancellation probes do not release a successful stale provider reply.
- **Chrome successful stale reply:** `page-translation-issue-406-final-stale-success.json`; `replacement`, `stop`, and `restore` all passed. A genuine successful stale reply was held and released after invalidation and rejected; network sidecar passed and cleanup was empty.
- **Firefox replacement:** `page-translation-issue-406-final-firefox-replacement.json`; Firefox 160.0, same source commit, `SUPPORTED`, isolated loopback-only/no routes. Exactly three requests were released/aborted/released; A/B ownership verified, with 10 retained and 2 B-accepted targets. Cleanup supported. This was a 12-target Sliced-only probe; unrelated capabilities including broad provider Restore remain **NOT_TESTED**.
- **Firefox successful stale reply:** `page-translation-issue-406-final-firefox-stale-success.json`; same version, commit, and network isolation, `SUPPORTED`. All three requests released; genuine held A reply released after 1061ms; B owned 10 retained + 2 accepted, with zero post-invalidation A writes. Cleanup supported. This 12-target Sliced-only case does not establish unrelated Restore behavior (**NOT_TESTED**).
- The Chrome negative network probes block unexpected HTTPS probes from page main and extension isolated worlds before network access. Translation responses are synthetic and offline: Chrome CDP fulfills them; Firefox's TLS proxy terminates only on loopback and has no upstream. No live provider traffic occurred.

## Interpretation and limits

The small fixture's p50 first acceptance is about 919ms, first flush 827ms, and Sliced discovery drain 29ms. Legacy discovery drain is unavailable (`null`), not zero. In the isolated Bridge studies, `discoveryDrainElapsed` means invocation-to-drain elapsed (and Legacy synchronous invocation duration), **not active traversal CPU**; it is not an apples-to-apples discovery CPU comparison. The small-case wait is dominated by the intentionally configured 800ms `FIRST_BATCH_DELAY` and 500ms terminal completion check, rather than discovery. The last accepted write and real terminal receipt are separate boundaries: on the small fixture terminal follows the final write by about 500ms, while the gap varies across larger and dynamic scenarios.

Large-page measurements do show Sliced about 280–297ms faster to all-write acceptance in these visible layouts and fewer calibrated long tasks. Terminal is only about 36–55ms faster; for late-visible, first visible acceptance is about 42ms later. These fixture results do not justify further discovery optimization or enabling viewport-first. If UX latency is prioritized, investigate scheduling delays separately.

Other limits: only the stated browser versions and synthetic fixtures were tested. Instrumentation and MutationObserver add overhead; accepted DOM writes are not paint. The large fixtures use four visible targets and 50ms synthetic responses. Standard scenarios keep lazy loading off. Scroll-through uses deterministic `scrollTo` plus native scroll events/animation frames and does not model physical input-to-acceptance latency. Long-task task-boundary accounting uses full reported task duration, which cannot be split. The Chrome network guard covers the page target and service worker, not iframe/OOPIF or Chrome process/component traffic.

### Iframe status: **NOT TESTED**

No iframe probe occurred. The required isolated-network setup was blocked by the environment: `unshare --user --map-current-user --net` retained uid 1000 and showed empty IPv4/IPv6 routes, but loopback (`lo`) was DOWN and `ip link set lo up` returned EPERM. A root-mapped namespace can bring loopback up, but Chrome then reports “Running as root without --no-sandbox is not supported.” Do not disable Chrome's sandbox. Existing guard coverage is page target and service worker only; it does not cover iframe/OOPIF traffic.

## Earlier isolated Bridge studies (separate provenance)

These were exploratory direct deterministic Bridge-callback runs, not full-page E2E: they exercised actual `PageTranslationBridge`, `GuardedNodesTranslator`, and installed `domtranslator`, with in-memory flags and fixed 0/50ms settlement delay. They had no `PageTranslationScheduler`, queue, external transport/network, or live provider. Do not add their samples to the final 108 trials.

1. **General discovery baseline:** `/tmp/opencode/page-translation-issue-406-production-baseline.json`; 80 trials (10 samples for each late-DOM/flat × 0/50ms callback × Legacy/Sliced combination), Chrome 157.0.8103.78, original HEAD `4bf1c20978d088c44c869a9956da5e12e5fc095f`. Fixture: 1,200 prefix nodes, 64 tail nodes, 16 viewport targets, with viewport panel after prefix for late-DOM or before for flat. Each trial validated all 1,280 eligible targets exactly once. Provenance hashes: Bridge `a1400aece0cd5bddbfaa47323d4f389dc011e3e343ba01005fa18d2cf1359c4e`; constants `4a158b60ef6654d660ac06fb0a712f9c11b9ac68eeec184579ea53f34cb897df`; harness `5adaf33d2dadd6e5e96b1bb942eb04bdb5c646139519d57b10e705a3e0d564e`; fixture `33871471bb892838e6f47d343c7f1c85a257318a5d236305c4be2281faa8b4d5`. In late-DOM, 0ms first visible accepted write p50 was 74.3ms Legacy / 213.2ms Sliced; 50ms callback: 111.9 / 203.1ms. Its Legacy `discoveryDrainElapsed` is invocation-to-drain elapsed, not traversal CPU.
2. **Attribute-heavy baseline:** `/tmp/opencode/page-translation-attribute-heavy-final-e22ab960-2026-11-19.json`; 40 trials (10 samples × 2 callback delays × 2 modes), Chrome 157.0.8103.78, original HEAD `e22ab960a47eabad6b93aa0c3a14266a009eecbe`. Fixture: 48 repeated groups, 240 eligible text/attribute targets, plus absent supported attributes and present excluded `data-*` attributes; every target validated once. Same Bridge/constants hashes as above; harness `d89565b81f0b9f9f880e4b619cd7720575004053ec9f3e428b4a7b5fa11d5061`; fixture `b896b58af7f04a55507288edd92b6f9c3091f0fcd87e04f339afa484492c8dc8`. For zero-delay callback, all-write completion p50 was 14.7ms Legacy / 24.2ms Sliced; with 50ms delay, 62.3 / 63ms. This focused fixture result is not a scheduler or live provider comparison.

Reproduce these historical studies only from their corresponding source revisions to preserve provenance. These commands are documented for reproduction and were not rerun for this report:

```sh
# At 4bf1c20978d088c44c869a9956da5e12e5fc095f
BENCH_MODES=legacy,sliced BENCH_SAMPLES=10 BENCH_PREFIX_NODES=1200 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-production-baseline.json \
  pnpm exec node scripts/dev/page-translation/production-benchmark/run.mjs

# At e22ab960a47eabad6b93aa0c3a14266a009eecbe
BENCH_FIXTURES=attribute-heavy BENCH_MODES=legacy,sliced BENCH_SAMPLES=10 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-attribute-heavy-final-e22ab960-2026-11-19.json \
  pnpm exec node scripts/dev/page-translation/production-benchmark/run.mjs
```

## Reproduction

Run from repository root. These three performance command groups yield the 108-trial total: 84 standard trials and 12 per scroll mode.

```sh
BENCH_MODES=legacy,sliced BENCH_SCENARIOS=small,dynamic-dom,shadow-dom,spa-navigation,early-visible,in-window-visible,late-visible \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-final-baseline.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs

BENCH_MODES=legacy,sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-final-scroll-fluid.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
BENCH_MODES=legacy,sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=on-stop \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-final-scroll-on-stop.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

Correctness suites are extra to performance totals:

```sh
BENCH_CANCELLATION_PROBES=stop,restore,replacement BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-final-cancellation.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
BENCH_STALE_SUCCESS_PROBES=replacement,stop,restore BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  BENCH_OUTPUT=/tmp/opencode/page-translation-issue-406-final-stale-success.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The Firefox replacement and stale-success probes use the isolated loopback namespace launcher (run only where user namespaces and loopback setup are permitted):

```sh
FIREFOX_E2E_LOOPBACK_TLS_PROXY=1 FIREFOX_E2E_PAGE_TRANSLATION_REPLACEMENT=1 \
  pnpm exec node scripts/dev/page-translation/e2e-firefox/run.mjs
FIREFOX_E2E_LOOPBACK_TLS_PROXY=1 FIREFOX_E2E_PAGE_TRANSLATION_STALE_SUCCESS=1 \
  pnpm exec node scripts/dev/page-translation/e2e-firefox/run.mjs
```

The checked artifacts are `page-translation-issue-406-final-firefox-replacement.json` and `page-translation-issue-406-final-firefox-stale-success.json` under `/tmp/opencode`. A separate sibling `*-network-guard-probe.json` is emitted by each Chrome run. Preserve all artifacts as external run evidence; do not treat probe runs or warmups as performance samples.

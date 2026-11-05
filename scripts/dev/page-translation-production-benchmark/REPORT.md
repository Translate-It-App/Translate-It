# Production-path benchmark — final run

## Run metadata and integrity

- Command: `BENCH_SAMPLES=10 BENCH_PREFIX_NODES=1200 BENCH_OUTPUT=/tmp/opencode/page-translation-production-benchmark-final.json pnpm exec node scripts/dev/page-translation-production-benchmark/run.mjs`
- Branch/HEAD: `feat/page-translate-engine` / `5c62aca2c6064682106a091cc4f07bc19b52cc03`
- Chrome: `/usr/bin/google-chrome-stable`, `156.0.8078.79`
- `PageTranslationBridge.js` SHA-256 before and after the run: `a7fa7a5638267252e630ece7fbf7614c23c5114ca9c90a259a1d45f54fc72748`
- `PageTranslationConstants.js` SHA-256 before and after the run: `25ddec4ce496af08ab8eb7324ad919e826ab1edd120e499fe622a9206e087988`
- Harness SHA-256: `18f3574f10f88ebe318f3ef7a0f23091a4bb0009154d538ccc7f3134ab813345`; fixture SHA-256: `4a6fa741abd367e66cb21dbbdacb828bbeab5fd7ee5cac8db4d77d54072f7307`.
- 120 measured trials: legacy/sliced/viewport × late-dom/flat × 0ms/50ms callback delay × 10 samples; one warmup per mode/fixture/delay. Modes reversed on alternate measured rounds.
- Every trial passed exact accepted DOM parity, one callback/admission/accepted settlement for each of 1,280 unique targets (1,200-prefix + 64-tail + 16 viewport targets), and source restoration. Zero duplicate or untracked admissions.
- Production caps recorded: slice 100 steps / 8ms; bounded window enumeration 100, candidates 100, geometry checks 100. Flags were changed only in the served in-memory module graph.
- Long Task calibration was valid: isolated 75ms task yielded one 79ms entry. Calibration is excluded from trials. Output JSON: `/tmp/opencode/page-translation-production-benchmark-final.json` (per-trial details, no page text).

## Timing results

Milliseconds, p50 / p95 over 10 samples. `First visible` and `Visible complete` are exact accepted DOM mutations observed via `MutationObserver`, not paint. `Drain` is elapsed invocation-to-drain (legacy is synchronous invocation duration), not active traversal CPU. `All writes` is accepted completion for all eligible targets. With ten samples, nearest-rank p95 is the maximum observation.

| Fixture | Delay | Mode | First visible | Visible complete | Drain elapsed | All writes complete |
|---|---:|---|---:|---:|---:|---:|
| late-dom | 0 | legacy | 159.7 / 734.8 | 160.1 / 735.5 | 51.2 / 153.0 | 160.1 / 735.5 |
| late-dom | 0 | sliced | 822.6 / 3115.2 | 823.1 / 3124.0 | 818.9 / 3118.9 | 823.1 / 3124.0 |
| late-dom | 0 | viewport | 332.4 / 2413.9 | 333.0 / 2414.7 | 326.2 / 2405.2 | 333.0 / 2414.7 |
| late-dom | 50 | legacy | 159.9 / 343.2 | 160.3 / 344.1 | 44.8 / 125.6 | 160.3 / 344.1 |
| late-dom | 50 | sliced | 423.8 / 1610.0 | 430.1 / 1634.0 | 376.7 / 1552.5 | 430.1 / 1634.0 |
| late-dom | 50 | viewport | 280.0 / 583.0 | 280.6 / 583.9 | 229.1 / 525.8 | 280.6 / 583.9 |
| flat | 0 | legacy | 75.0 / 257.8 | 76.1 / 261.3 | 74.4 / 256.6 | 153.7 / 493.8 |
| flat | 0 | sliced | 2.9 / 14.8 | 4.0 / 19.3 | 1152.1 / 1634.8 | 1156.4 / 1639.5 |
| flat | 0 | viewport | 6.1 / 39.4 | 6.8 / 43.7 | 646.4 / 1789.3 | 650.9 / 1794.1 |
| flat | 50 | legacy | 53.2 / 123.6 | 55.4 / 124.7 | 50.1 / 112.0 | 174.9 / 284.4 |
| flat | 50 | sliced | 58.2 / 62.0 | 60.1 / 69.5 | 444.5 / 926.5 | 496.4 / 996.5 |
| flat | 50 | viewport | 58.1 / 143.5 | 61.8 / 175.2 | 258.6 / 519.4 | 316.6 / 570.7 |

## Main-thread Long Tasks

Count and max/total duration (ms), each p50 / p95 across the ten trial intervals. The observer is calibrated and Long Task entries are filtered to overlap scheduled `translate()` invocation through last accepted write. Boundary-crossing tasks count at full reported duration because entries cannot be split. Browser Long Task APIs generally cannot observe tasks below 50ms; zero recorded qualifying entries is not a claim of no shorter tasks.

| Fixture | Delay | Mode | Count | Max duration | Total duration |
|---|---:|---|---:|---:|---:|
| late-dom | 0 | legacy | 1 / 1 | 51 / 153 | 51 / 153 |
| late-dom | 0 | sliced | 0 / 2 | 0 / 71 | 0 / 132 |
| late-dom | 0 | viewport | 0 / 0 | 0 / 0 | 0 / 0 |
| late-dom | 50 | legacy | 0 / 1 | 0 / 125 | 0 / 125 |
| late-dom | 50 | sliced | 0 / 0 | 0 / 0 | 0 / 0 |
| late-dom | 50 | viewport | 0 / 0 | 0 / 0 | 0 / 0 |
| flat | 0 | legacy | 1 / 1 | 74 / 256 | 74 / 256 |
| flat | 0 | sliced | 0 / 2 | 0 / 63 | 0 / 115 |
| flat | 0 | viewport | 0 / 0 | 0 / 0 | 0 / 0 |
| flat | 50 | legacy | 1 / 1 | 50 / 112 | 50 / 112 |
| flat | 50 | sliced | 0 / 0 | 0 / 0 | 0 / 0 |
| flat | 50 | viewport | 0 / 0 | 0 / 0 | 0 / 0 |

## Interpretation and limitations

- Late-DOM first-visible p50 versus sliced-only improved **59.6%** at 0ms (332.4 vs 822.6ms) and **33.9%** at 50ms (280.0 vs 423.8ms), exceeding the 20% fixture target in both delay profiles.
- Flat-control first-visible p50 versus sliced-only regressed **110.3%** at 0ms (6.1 vs 2.9ms) and changed **−0.2%** at 50ms (58.1 vs 58.2ms; effectively equal). Therefore the overall “no meaningful regression elsewhere” target is **not met**; do not claim benchmark success or general speedup.
- The viewport-first fallback is bounded to the current discovery window; it does not jump over the 1,200-node prefix. All offscreen identities are still processed, so first-visible and all-target completion are intentionally separate.
- This is a whole-mode comparison, not an isolated test of reordering. Viewport mode also uses configured-name attribute enumeration and the callback-safe admission adapter. Its late-DOM gains cannot be attributed to viewport prioritization alone; an ablation would be needed to separate those effects. Ten samples and the wide p95 spread further limit causal and general performance conclusions.
- The harness exercises production Bridge, `GuardedNodesTranslator`, and installed `domtranslator`; provider work is a deterministic local settlement-shaped callback. It does not measure `PageTranslationScheduler`, batching/queue behavior, external provider/network transport, actual paint, or active traversal CPU. Chrome only was tested. These synthetic fixtures and settings do not establish general site performance.

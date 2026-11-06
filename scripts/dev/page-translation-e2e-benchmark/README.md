# Whole-page translation Chrome E2E benchmark

Run the real MV3 background/content entries against a local synthetic page. Translation requests pass through the actual scheduler, background routing, Unified Translation Service, provider and fetch transport; only the outbound Edge HTTP response is supplied by CDP. The exact startup Edge voice-list metadata `GET` is separately fulfilled with `[]`, which the production `TTSVoiceService` accepts and caches. Other unexpected external HTTP(S) requests are blocked and fail the run. Chrome DevTools Fetch guards the test extension service worker before it resumes and the top-level fixture page before navigation, including the content isolated world; iframes and Chrome process/component-extension traffic outside these targets are not covered.

```sh
pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
# Optional controls
BENCH_MODES=legacy,sliced,viewport BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-e2e-custom.json \
  pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
```

Legacy always runs first (one discarded preliminary run plus at least three measured runs). This preliminary run uses a fresh Chrome process/profile too: it is a cold-profile baseline check, **not** a persistent-process or JIT warmup. Sliced/viewport comparisons run only after every Legacy preliminary and measured run passes exact translation and true-restore validation. Each run uses a fresh Chrome profile; one mode bundle is reused for its runs. Defaults are five measured samples per mode; p95 stays unavailable below 40 observations.

Every mode uses the same 12 static short targets, French target, Edge provider, non-lazy/Fluid settings and 50 ms fixture transport delay. Effective target language, lazy loading, scroll-stop and auto-DOM-change Manager settings are asserted on every trial. The fixture is small and visible; it does **not** isolate viewport-first behavior or establish a performance benefit for offscreen-heavy pages. Reports include raw runs, provider request batch sizes, lifecycle/DOM trace observations, unavailable metrics with reasons and sample counts, provenance hashes, browser version, and cleanup status. Do not infer provider concurrency or queue throughput unless trace counts show those components actually ran.

Artifacts default to a unique `/tmp/opencode/page-translation-e2e-<timestamp>-<pid>.json`; set `BENCH_OUTPUT` to choose a path. The separate network-guard negative probe has a sibling `*-network-guard-probe.json` artifact. Failures, including later samples and cleanup failures, are retained and produce a nonzero exit. A malformed `chrome-extension://invalid/` placeholder request is blocked and recorded separately; it is not an HTTP(S) request or an allowed extension asset. The harness does not claim coverage of Chrome’s own process/component traffic, heap-leak behavior, or paint timing.

## Latest Chrome result

Artifacts:
- Benchmark: `/tmp/opencode/page-translation-e2e-2026-11-05T23-15-41.190Z-3726452.json`
- Network negative probe: `/tmp/opencode/page-translation-e2e-2026-11-05T23-15-41.190Z-3726452-network-guard-probe.json`

Chrome 156.0.8078.79, source `5c3bd6081cb3e2cf81f9746831c41155d6dd71a6`; one warmup and three measured runs per mode. All 12 trials passed exact 12/12 DOM translation, completion and true Restore validation. Each measured run issued one real Edge provider POST with batch size 12 and one separate startup-voices metadata-fixture GET. The negative probe confirmed external HTTPS fetches from both the page main world and extension isolated content world were intercepted, blocked, and rejected without network access. No unexpected external HTTP(S) requests or cleanup errors occurred.

Measured p50 milliseconds (p95 is null for n=3):

| Mode | Command → first visible accepted write | Command → all accepted writes | Command → real completion | Restore |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 977 | 978 | 1482 | 78 |
| Sliced | 934 | 934 | 1435 | 73 |
| Viewport-first | 988 | 988 | 1491 | 71 |

Observed path counts per trial: 12 `PageTranslationScheduler.enqueue`, one flush, one batch request entry, one background admission, one `QueueManager.enqueue`/`_processItem`, one `RateLimitManager.executeWithRateLimit`, one Edge chunk, one `ProviderRequestEngine.executeApiCall`, and one outbound translation POST. This does not establish AI-limiter use or queue concurrency. The observed effective Manager settings were `targetLanguage: fr`, `lazyLoading: false`, `translateAfterScrollStop: false`, and `autoTranslateOnDOMChanges: false` on all trials. All 12 targets were visible at the start, so these exploratory numbers do not show viewport-first benefit for offscreen-heavy pages. Runtime-message handoff time was unavailable; it was not inferred from adjacent trace events. Long-task calibration captured a 75 ms task before each timed translation interval; the measured observers reported no long tasks in these runs.

Cancellation with a held stale response was not run; the raw artifact records this as unavailable, and no stale-write cancellation claim is made. The negative probe separately blocked an unexpected HTTPS `fetch` from both page main world and extension isolated content world. A malformed non-HTTP `chrome-extension://invalid/` request was also blocked and recorded; it was not continued or fulfilled. This Fetch scope does not cover Chrome’s own process/component-extension telemetry or iframes. Nonfatal ActionbarIconManager warnings about missing `icons/extension/extension_icon_128.png` and `icons/providers/google.png` are captured in the raw Chrome console trace; the background and translation pipeline initialized and completed despite them. No real credentials or external translation service were used.

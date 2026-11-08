# Whole-page translation Chrome E2E benchmark

Run the real MV3 background/content entries against a local synthetic page. Translation requests pass through the actual scheduler, background routing, Unified Translation Service, provider and fetch transport; only the outbound Edge HTTP response is supplied by CDP. The exact startup Edge voice-list metadata `GET` is separately fulfilled with `[]`, which the production `TTSVoiceService` accepts and caches. Other unexpected external HTTP(S) requests are blocked and fail the run. Chrome DevTools Fetch guards the test extension service worker before it resumes and the top-level fixture page before navigation, including the content isolated world; iframes and Chrome process/component-extension traffic outside these targets are not covered.

```sh
pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
# Optional controls
BENCH_MODES=legacy,sliced,viewport BENCH_SCENARIOS=small,early-visible,in-window-visible,late-visible \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-e2e-custom.json \
  pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
```

`BENCH_SCENARIOS` accepts a comma-separated, unique selection from `small`, `early-visible`, `in-window-visible`, and `late-visible`; it defaults to `small`. The three large scenarios each contain 1,000 stable-ID targets and four visible targets (`target-500` through `target-503`), with the visible group placed at the beginning, inside the initial 100-step discovery window, or after that window. Discovery steps include element and text-node traversal, plus configured attribute lookups even when the attribute is absent; they are not a count of eligible targets. Actual viewport geometry and ordered source IDs are checked on every run. `BENCH_SAMPLES` accepts integer values 3–40 and `BENCH_WARMUPS` 1–3.

## Opt-in sliced-discovery cancellation probes

Run the three real Chrome cancellation cases (A stop without restore, B real restore, C stop A then start replacement B while preserving accepted translations) with:

```sh
BENCH_CANCELLATION_PROBES=stop,restore,replacement \
  BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
```

The probe mode rejects non-Sliced mode selections and uses a fresh Chrome trial for each requested case plus the normal network-guard negative probe. Case B invokes real Restore while A remains the active session with its later provider request held; it does not Stop A first. Case C starts a real auto/preserve replacement B after stopping A. It holds real Edge provider Fetch requests after a completed 25-target batch, maps them to the actual provider-root promise, session, controller and physical request, then releases/fails the held Fetch after the production command. Teardown closes Fetch admission for guarded targets, settles registered requests and drains every asynchronous Fetch handler before closing Chrome; a drain/release deadline or unclassified CDP error fails the trial and is retained. A post-abort Fetch-ID error is not ignored by itself: the artifact requires the matched production controller abort, cancellation acknowledgement, provider-root and physical-promise settlement, owner-scoped content promises, and drained DOM/lifecycle evidence. Replacement B must have a distinct trusted coordinator-owned session and exactly 975 unique successful accepted targets disjoint from the 25 retained A targets, with a complete 1,000-target final DOM before Restore. If A's provider root has already settled before B is active, the result is restart isolation, not live stale-success overlap. Each case retains raw commands, session IDs, Fetch/network events, lifecycle/promise ledgers, DOM/attribute snapshots, validations and cleanup results in the normal atomic main artifact; the negative probe remains a sibling artifact. These are correctness probes, not performance measurements. They do not fabricate a successful provider response after cancellation, so they do not by themselves prove that a stale-success response reached the runtime or that a stale-success guard was exercised; the raw Fetch release and provider settlement classification is authoritative per case. No default feature flags are enabled by these probes.

Every selected mode bundle is built and its worker/content production-build environment evidence is checked for parity before measured work. Legacy warmups run first as qualification; all selected modes' discarded warmups then finish before the measured rounds. Every measured round cyclically rotates the complete selected mode list using scenario index plus zero-based measured ordinal (for example, `legacy,sliced` then `sliced,legacy`; with three modes, `legacy,sliced,viewport`, then `sliced,viewport,legacy`, then `viewport,legacy,sliced`). This balances positions over each complete cycle; an interrupted or deliberately partial cycle can retain an imbalance. Raw trials retain actual global run order and the artifact records the planned per-scenario measured order. The comparison gate requires complete expected Legacy qualification and measured evidence for every selected mode/scenario/ordinal, all passing statuses, and verified build parity; incomplete, missing, failed, or mismatched evidence withholds summaries and comparisons. Each trial uses a fresh Chrome process/profile, while each compiled mode bundle is reused for that mode's trials. A warmup is a discarded fresh-profile run, not a persistent-process/JIT warmup; profiles are not shared across trials. The `small` fixture retains 12 static visible targets; large fixtures use the same French target, Edge provider, non-lazy/Fluid settings, and 50 ms response delay. Effective Manager settings and the content bundle's actual sliced/viewport discovery flags are asserted on every trial. Filtered primitive admissions are observed per session in all modes, separately from scheduler enqueue. Reports include per-trial artifacts, exact ID/admission/enqueue/batch observations, viewport-window membership where applicable, provider request batches, provenance hashes, and cleanup status. The mutation observer and instrumentation add overhead; accepted DOM text is a DOM-write observation, not paint or visual-presentation timing. Duplicate-write flags require a directly observed repeated accepted character-data write or accepted subtree replacement; coalesced records do not prove intermediate states that the observer did not expose. Unsupported or unobserved timings remain null with reasons; Legacy discovery-drain timing remains unavailable unless the runtime transition is observed. p95 remains unavailable below 40 samples; no p95<40 claim is made. The 800 ms initial batch timer and 1,000-item emergency bound can mask priority differences; large-layout results are exploratory, not a general performance claim. Do not infer provider concurrency or queue throughput unless trace counts show those components actually ran.

Artifacts default to a unique `/tmp/opencode/page-translation-e2e-<timestamp>-<pid>.json`; set `BENCH_OUTPUT` to choose a path. The separate network-guard negative probe has a sibling `*-network-guard-probe.json` artifact. Failures, including later samples and cleanup failures, are retained and produce a nonzero exit. A malformed `chrome-extension://invalid/` placeholder request is blocked and recorded separately; it is not an HTTP(S) request or an allowed extension asset. The harness does not claim coverage of Chrome’s own process/component traffic, heap-leak behavior, or paint timing.

The main report is atomically streamed once after normal completion or a handled failure, retaining all raw trials without quadratic full-report rewrites. Progress is otherwise memory-only; abnormal process termination is not guaranteed to leave a current main report. The separate negative-probe artifact is still written when that probe runs.

## Opt-in successful stale Page-reply probes

Run deterministic stale-reply cases independently from performance and cancellation-Fetch probes:

```sh
BENCH_STALE_SUCCESS_PROBES=replacement,stop,restore \
  BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  pnpm exec node scripts/dev/page-translation-e2e-benchmark/run.mjs
```

Each requested case gets a fresh Chrome trial plus the normal network-guard negative probe. Before A starts, a stale-lane-only content bundle transform wraps the real Page scheduler's `safeSendMessage` result. It binds the first current-owner scheduler batch to its exact `PAGE_TRANSLATE_BATCH` message ID, session ID, and serialized item IDs/text, then holds only a genuine successful result after production send, timeout, and cancellation checks have completed, but before the Scheduler's `await` resumes. The real Edge HTTP response and `ProviderRequestEngine.executeApiCall` / provider-root promises must already have fulfilled. Stop or Restore invalidates A through the normal command. The `stop` and `restore` cases release A's held reply without starting B and verify the original DOM remains unchanged (including exact original attributes for Restore); A has accepted zero targets. Only `replacement` starts a distinct trusted auto/preserve B and holds its first real provider Fetch response while releasing A's exact result. It requires B's first batch to overlap targets A never accepted, positive call-through `_ownsFlushSession(false)` evidence after release, fulfilled A scheduler-batch settlement, no post-invalidation A acceptance or unattributed DOM write, and unchanged B counters/queue/context/controller/resources across that boundary. B must accept all 1,000 fixture IDs exactly once with B-prefixed output; the full DOM and original text/attributes after real Restore are checked. A separate raw mutation observer retains per-target old/new text values (including transient same-delivery changes) from invalidation through final drain; any A-prefixed or unknown value fails. Artifacts retain the gate state/events, exact batch message and members, network/provider evidence, scheduler ownership checks, lifecycle/settlement attribution, raw mutation values, full DOM snapshots, runtime resource snapshots and cleanup/drain status. Gate timeout/close always opens the held result unchanged; cleanup first requires actual inactive/discovery-cancelled lifecycle evidence. If Stop/Restore cannot establish it, Chrome is disposed without opening the gate. These probes make no performance comparison and do not replace the separate cancellation tests.

## Historical small-fixture Chrome result

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

## Latest large-page exploratory Chrome result

Artifacts:
- Benchmark: `/tmp/opencode/page-translation-e2e-2026-11-06T02-07-55.972Z-3824097.json`
- Network negative probe: `/tmp/opencode/page-translation-e2e-2026-11-06T02-07-55.972Z-3824097-network-guard-probe.json`

This run used Chrome 156.0.8078.79 at HEAD `26c80831953ba721034a909e51a629fa5ebe29ee`, with working-tree changes recorded in the artifact's provenance and source SHA-256 map. It covered three large layouts (`early-visible`, `in-window-visible`, `late-visible`) across `legacy`, `sliced`, and `viewport`: 36 trials total (9 warmups/preflights and 27 measured). Each large fixture had 1,000 exact targets. All measured runs passed translation, 1,000-target admission/enqueue, provider-request-order, and 1,000-target restore checks. Each run issued 40 physical provider requests in batches of 25; all returned HTTP 200. The viewport-first observations recorded 100 enumeration steps and 12 candidates per sample: 4/4 visible IDs for early and in-window layouts, 0/4 for late. Window membership validation passed. The network negative probe passed; there were no cleanup errors. The separately blocked `chrome-extension://invalid/` placeholder is not an unexpected HTTP(S) request.

Measured p50 milliseconds (n=3 per row; p95 unavailable). Long-task totals are aggregated across the three measured samples in that row: observed-entry count / maximum duration / total blocking time (TBT), in ms.

| Layout | Mode | First visible write | Visible completion | Total completion | Long tasks across 3 samples: count / max ms / TBT ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Early-visible | Legacy | 296 | 297 | 3441 | 3 / 125 / 203 |
| Early-visible | Sliced | 275 | 275 | 2871 | 0 / 0 / 0 |
| Early-visible | Viewport | 299 | 299 | 2898 | 0 / 0 / 0 |
| In-window-visible | Legacy | 323 | 323 | 3458 | 3 / 135 / 225 |
| In-window-visible | Sliced | 326 | 326 | 2964 | 0 / 0 / 0 |
| In-window-visible | Viewport | 302 | 302 | 2953 | 0 / 0 / 0 |
| Late-visible | Legacy | 327 | 328 | 3558 | 3 / 144 / 245 |
| Late-visible | Sliced | 347 | 347 | 2924 | 1 / 54 / 4 |
| Late-visible | Viewport | 476 | 476 | 2931 | 0 / 0 / 0 |

These three-sample results do not establish a performance benefit, provide p95, or justify enabling flags by default. Legacy discovery-drain timing was unavailable, not zero. The 104 MB raw artifact predates a reporting-only change that streams trials individually and atomically replaces the report, avoiding Node's whole-string size limit. Focused writer tests cover a synthetic 369-trial report and preservation of the previous artifact on serialization failure; a rewrite of the complete recorded artifact was byte-identical. Measurement logic is unchanged. No 40-sample Chrome matrix was run. Raw trials remain in memory, so larger matrices still incur memory and I/O costs.

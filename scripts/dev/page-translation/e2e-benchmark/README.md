# Whole-page translation Chrome E2E benchmark

> **Issue #406 final results:** see the [final benchmark report](../../../../docs/technical/benchmarks/whole-page-issue-406-final-2026-11-19.md) for the complete performance matrix, correctness probes, limitations, and reproduction commands.

Run the real MV3 background/content entries against a local synthetic page. Translation requests pass through the actual scheduler, background routing, Unified Translation Service, provider and fetch transport; the selected Edge or Google V2 outbound response is supplied synthetically by CDP. The exact startup Edge voice-list metadata `GET` is separately fulfilled with `[]`, which the production `TTSVoiceService` accepts and caches. Other unexpected external HTTP(S) requests are blocked and fail the run. Chrome DevTools Fetch guards the test extension service worker before it resumes and the top-level fixture page before navigation, including the content isolated world; iframes and Chrome process/component-extension traffic outside these targets are not covered.

## Module responsibilities

`run.mjs` owns CLI configuration, build orchestration, execution planning, aggregation, and artifact finalization. `trial-runner.mjs` owns one trial's Chrome/fixture lifetime, shared interception, measurement, and shared teardown ordering. `network-interception.mjs` owns paused-request admission, request tracking, provider request classification/decoding, session-qualified Network correlation, and Fetch settlement/lifecycle primitives. `cancellation-runner.mjs` owns Stop/Restore/Replacement scenario execution and cancellation command recording. `stale-success-runner.mjs` owns successful stale-reply execution, reply-gate capture polling, and fail-closed gate teardown. `trial-validation.mjs` owns shared translation-result validation. Each `resilience/` module owns its probe-specific arming, selection/claim, execution, fault injection, and evidence collection/validation; shared selectors and validators remain in `resilience-probes.mjs`.

```sh
pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
# Optional controls
BENCH_MODES=legacy,sliced,viewport BENCH_SCENARIOS=small,early-visible,in-window-visible,late-visible \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-e2e-custom.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

`BENCH_SCENARIOS` accepts a comma-separated, unique selection from `small`, `dynamic-dom`, `shadow-dom`, `spa-navigation`, `early-visible`, `in-window-visible`, `late-visible`, and `scroll-through`; it defaults to `small`. The three large scenarios each contain 1,000 stable-ID targets and four visible targets (`target-500` through `target-503`), with the visible group placed at the beginning, inside the initial 100-step discovery window, or after that window. Discovery steps include element and text-node traversal, plus configured attribute lookups even when the attribute is absent; they are not a count of eligible targets. Actual viewport geometry and ordered source IDs are checked on every run. `BENCH_SAMPLES` accepts integer values 3–40 and `BENCH_WARMUPS` 1–3.

## Opt-in Edge, Google V2, and Custom provider lanes (Issue #432)

```sh
BENCH_LANE=provider BENCH_PROVIDER=googlev2 BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The lane requires an explicit optimization level (`1`, `3`, or `5`) and forces production-default Sliced discovery. If `BENCH_MODES` is set it must be `sliced`. Google V2 and Custom runs require the scroll-through fixture and one scheduling mode. The default/discovery and Edge scroll-through remain 12 targets and preserve the original burst/settled scroll sequence. Google V2 and Custom use 1,000 unique targets in three bands (334/333/333), spaced 1px apart so each entire band is safely inside the viewport at the runner's existing native scroll offsets; they verify exact visible membership and wait for each band's exact accepted-write set before scrolling onward.

### Independent Page batch-size and worker experiment

Provider runs can independently override Page chunk size and Page flush workers with the paired `BENCH_PAGE_BATCH_SIZE=10|25` and `BENCH_PAGE_WORKERS=2|4` options. The harness applies these only to its benchmark-built bundles and fails if the effective runtime snapshot does not match; leaving both unset preserves existing defaults. All other provider batching and optimization settings remain unchanged. Google V2's physical limiter is set to twice the requested Page workers because its scheduler caps workers at `floor(provider capacity / 2)` (up to four). Custom's shared physical limiter remains at its normal optimization-level capacity, so four Page workers may be queued behind a physical capacity of two.

For example, run case D with five measured samples and one warmup:

```sh
BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_PAGE_BATCH_SIZE=10 BENCH_PAGE_WORKERS=4 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

For the six-run Google V2 matrix (optimization levels 1/3/5 × `fluid`/`on-stop`), run once per row with 3 measured trials plus 1 discarded warmup:

```sh
for level in 1 3 5; do
  for scheduling in fluid on-stop; do
    BENCH_LANE=provider BENCH_PROVIDER=googlev2 BENCH_OPTIMIZATION_LEVEL="$level" \
      BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING="$scheduling" \
      BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
      BENCH_OUTPUT="/tmp/opencode/googlev2-level-${level}-${scheduling}.json" \
      pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
  done
done
```

This is the minimal matrix spanning all requested optimizer levels and both scroll scheduling modes, with one representative 1,000-target scenario rather than multiplying fixture variants. Provider artifacts persist `scenarioSummaries[scenario].sliced`, aggregated from measured trials only; warmups are excluded. Synthetic Fetch interception returns deterministic parser-compatible legacy Google arrays; it does not contact Google or measure live provider latency/quality. Google V2's configured endpoint is exactly `https://translate.google.com/translate_a/single` POST. The actual `sl` query is recorded per request and is not overridden: the Page AUTO resolver may choose a source code such as `nl` even for this English-language fixture. The fixture's deterministic response metadata reports detected language `en`; this is synthetic parser metadata, separate from and not evidence of the request's `sl` value. Reports record observed provider optimizer/rate-limiter capacity, scheduler chunk/maxChars/parallel execution and Page worker limit, logical batch intervals/sizes/peak overlap, and separately correlated physical HTTP count/peak overlap, each request's latency and terminal settlement, first accepted translation, and total completion. Logical batches are not assumed to map 1:1 to HTTP requests, nor are configured limits presented as observed physical parallelism. With fewer than 40 valid samples, p95 remains unavailable.

### Isolated Google V2 transient 503 resilience probe (Phase 2.3.1)

This opt-in correctness probe runs one fresh Sliced Chrome session at Google V2 Optimization Level 3 with Fluid scheduling. It leaves the normal network guard enabled, waits for an observed concrete Page AUTO source resolver state before selecting a physical Google V2 request, and fulfills exactly one selected request with HTTP 503. The production QueueManager, RateLimitManager, provider, and scheduler remain active; the subsequent request must be an actual 200 retry. It does not create performance samples or run alongside the provider matrix or other isolated probes.

```sh
BENCH_RESILIENCE_PROBES=googlev2-503 \
  BENCH_LANE=provider BENCH_PROVIDER=googlev2 BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/googlev2-503-resilience.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The separate `*-resilience-googlev2-503.json` artifact preserves raw physical attempts, Page/root/QueueManager message and item IDs, resolver state, queue start/settlement status, retry error type/attempt limit/timer state, retry delay, resource cleanup, DOM and Restore evidence. The observed retry delay must be 950–2050ms, allowing 50ms timestamp tolerance around the production SERVER_ERROR 1–2s jitter window. The selector fails closed when the resolver is not concrete or the request cannot be tied to exactly one provider root and fixture target set. This is an offline deterministic harness response, not a live Google service/latency test.

### Isolated Custom 429 shared-cooldown resilience probe (Phase 2.3.2)

This opt-in probe selects the Custom synthetic adapter at Optimization Level 3 with Fluid scheduling, waits for a concrete AUTO resolver, then injects one `429` with `Retry-After: 5`. It uses the blank-key strict Custom fixture and does not send live traffic. It shares the production QueueManager, RateLimitManager and limiter, and writes a separate `*-resilience-custom-429.json` raw artifact without performance summaries or comparisons.

```sh
BENCH_RESILIENCE_PROBES=custom-429 \
  BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/custom-429-resilience.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

After the initial visible band is accepted, the probe records a concrete AUTO resolver/session and arms only for later bands. It claims and holds two disjoint same-session Fetch requests (A/B), injects the 429 into A, and observes the typed QueueManager settlement plus server/limiter deadlines. Because both Page scheduler flush slots are occupied, it fulfills B once the cooldown is established; B must complete Network and worker settlement before the unchanged deadline. The newly freed slot lets the next normal Page batch P enter the real Custom limiter queue, where the probe verifies same-session ownership, spare capacity, and that P remains queued before the deadline. No physical request may start prematurely. The validator also requires one successful A retry retaining its QueueManager item/message, exact 1,000-target DOM/Restore/session evidence, and logical/physical concurrency no greater than two. Any timeout fails closed and settles held Fetches once; partial evidence is retained in the raw artifact. This is an offline resilience correctness check, not a live Custom service or latency test.

### Isolated Custom permanent HTTP 400 resilience probe (Phase 2.3.4)

This opt-in probe runs the blank-key strict Custom fixture in a fresh Chrome Page Translation session at Optimization Level 3, Sliced discovery, Fluid scheduling, and 1,000 targets. After the Page AUTO resolver selects a concrete source/target pair, it injects one HTTP 400 response with `Invalid request parameters` for one complete 25-target batch. All other batches receive the ordinary deterministic fixture response. No live traffic or real credentials are used.

```sh
BENCH_RESILIENCE_PROBES=custom-400 \
  BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/custom-400-resilience.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The separate `*-resilience-custom-400.json` artifact retains the selected physical request and correlates its HTTP/network status, message/session/QueueManager item, and exact target IDs. Validation requires one terminal QueueManager `HTTP_ERROR` attempt with no retry, API-key failover, structured recovery, or circuit-breaker activation; unaffected batches must continue without retransmitting successful siblings. The expected partial outcome is exactly 975 translated and accepted targets, 25 failed targets that remain unchanged and unaccepted, and 1,000 targets total. Logical and physical concurrency must remain within the observed effective limit of two. Exact Restore of every target and strict runtime cleanup are still required. Partial-success allowances are scoped to this probe and do not alter normal benchmark validation. This is an offline provider-resilience check, not a live Custom service or latency test.

### Isolated Gemini structured-recovery resilience probe (Phase 2.3.3)

This opt-in probe uses the existing strict synthetic Gemini adapter in a fresh Chrome Page Translation run with Optimization Level 3, Sliced discovery, Fluid scheduling, and 1,000 targets. It waits until the Page AUTO source resolver has selected a concrete source/target pair, then returns exactly one malformed JSON model answer inside an otherwise valid Gemini HTTP 200 response envelope. The production parser must trigger `FULL_STRUCTURED_RETRY`; `BaseAIProvider` must issue one same-batch recovery request, whose valid structured items are returned in reverse order to exercise response-identity mapping. The dummy Gemini query credential and `.invalid` endpoint are enforced by the adapter; no live traffic or real credentials are used.

```sh
BENCH_RESILIENCE_PROBES=gemini-structured-recovery \
  BENCH_LANE=provider BENCH_PROVIDER=gemini BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/gemini-structured-recovery.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The separate `*-resilience-gemini-structured-recovery.json` artifact retains every physical attempt while excluding only the intentionally malformed primary response from canonical source accounting. It records production `PRIMARY_TRANSLATION` and `STRUCTURED_RECOVERY` execution purposes and verifies that the recovery retains the affected message, Page session, and targets; no QueueManager retry, API-key failover, parent/recursive recovery, or unaffected-batch retransmission occurs; and logical and physical concurrency remain within the observed effective limit of three. Exact translations, unique acceptance of all targets, real Restore, and strict runtime-resource/terminal cleanup must pass. Any missing correlation or unexpected request fails closed. This is a production-pipeline resilience check, not a live Gemini latency or quality test.

### Isolated Google V2 production timeout probe (Phase 2.3.5)

```sh
BENCH_RESILIENCE_PROBES=googlev2-timeout \
  BENCH_LANE=provider BENCH_PROVIDER=googlev2 BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/googlev2-timeout-resilience.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The probe holds one actual 25-target Google V2 Fetch request after concrete Page AUTO source resolution. It does not synthesize a response or timeout: production's 60-second batch deadline and cancellation execute normally, while sibling requests receive ordinary deterministic Google responses. Only the held-request observation is extended (to allow the actual 60-second deadline); other harness deadlines remain unchanged. The `*-resilience-googlev2-timeout.json` artifact separates the content `OPERATION_TIMEOUT` from the internal provider abort and retains exact request/message/session/controller/root/physical/QueueManager evidence. Passing requires one QueueManager attempt with no retry or failover, successful unrelated requests, logical and physical concurrency no greater than two, exactly 975 accepted writes and 25 unchanged/unmarked/unaccepted targets, exact Restore, strict runtime-resource validation, and settled held Fetch plus drained request handlers before Chrome teardown. Cleanup releases the held request on every path and fails closed if its release or handler drain is unproven. This is a correctness probe, not a performance sample or live Google test.

### Isolated Custom cancellation resilience probe (Phase 2.3.6)

```sh
GIT_OPTIONAL_LOCKS=0 BENCH_RESILIENCE_PROBES=custom-cancellation \
  BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 \
  BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/custom-cancellation-resilience.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

This isolated correctness probe uses the blank-key strict Custom fixture, 1,000 targets, and synthetic responses only. It completes the initial visible band and observes concrete AUTO source/target resolution before scrolling to the second band and holding one real Custom Fetch request. Deterministic pending-request and ownership barriers precede the real production Stop command; the held request must correlate to its actual Page session, logical batch, physical operation, controller, and unique fixture target IDs.

Passing requires positive session invalidation, cancellation acknowledgement, matched controller abort and request settlement, with cancellation distinguished from timeout or generic provider failure. Previously accepted translations must remain exact, later targets must stay unaccepted, and no duplicate acceptance, stale write, retry, API-key failover, structured recovery, or new physical request from the cancelled session is allowed after cancellation. Real Restore must return all 1,000 targets and their original DOM metadata exactly. QueueManager, RateLimitManager, source resolver, lifecycle registry, scheduler, and Fetch handlers must drain; unexpected or unclassified Fetch release errors fail closed. Logical and physical concurrency remain subject to the existing Custom level-3 limits.

An already-concurrent second-band sibling may have started before Stop. It is accounted for separately from the single selected held request and must also settle through production cancellation, without accepting its targets. Both cancelled physical operations require positive abort-cause evidence; a cancelled logical root alone cannot excuse a generic transport failure.

The separate `*-resilience-custom-cancellation.json` artifact retains raw commands, correlation, cancellation and DOM evidence, physical request accounting, concurrency, resource cleanup, and source/build provenance. It contributes no performance samples or comparisons. Successful stale-reply injection is not part of this probe (Phase 2.3.7); this does not measure live Custom latency or quality.

### Custom provider offline matrix

This opt-in lane exercises the production `CustomProvider` and parser through the real scheduler and provider pipeline. The harness intercepts the exact synthetic `https://benchmark-custom.invalid/v1/chat/completions` POST only when `BENCH_PROVIDER=custom` selects this lane; requests to that endpoint are blocked in discovery runs and other provider lanes. The fixed model is `benchmark-custom-model`; the harness sets `CUSTOM_API_KEY` blank, rejects Authorization headers, validates the actual JSON request, and returns reversed structured translations with the exact wire IDs. No credentials or live provider traffic are used. HTTP sequence `ids` are fixture target IDs mapped from request texts; Custom parser wire IDs are recorded separately as `wireIds`. Each successful trial requires one HTTP request per observed logical batch, exact source and DOM accounting, and correlated terminal network outcomes; retries or structured-recovery requests fail the trial.

Run each of the six level/scheduling combinations:

```sh
set -e
for level in 1 3 5; do
  for scheduling in fluid on-stop; do
    BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL="$level" \
      BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING="$scheduling" \
      BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
      BENCH_OUTPUT="/tmp/opencode/custom-level-${level}-${scheduling}.json" \
      pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
  done
done
```

The expected Custom configuration is independently checked against observed runtime values: 5,000-character batching, provider concurrency 1/2/4, and Page chunk sizes 50/25/10 with parallel execution and worker/flush limits 1/2/4. Level 1 is expected to remain serial; levels 3 and 5 must exhibit overlapping logical and physical work. Three measured trials plus one discarded warmup are not enough to report p95. Browser scheduling, CDP interception, the fixed 50ms fixture response delay, 1,000-target fixture geometry, and instrumentation contribute overhead; these offline results do not characterize real provider latency, quality, service limits, or network behavior.

### Gemini offline matrix

The Gemini lane runs the production Gemini provider and parser against only the exact synthetic `https://benchmark-gemini.invalid/v1beta/models/benchmark-gemini-model:generateContent` POST. The harness configures that full endpoint, fixed model `benchmark-gemini-model`, and dummy query key `benchmark-dummy-key`; the strict decoder checks the endpoint, query key, request schema, generation config and fixture texts, and rejects Authorization headers. This endpoint is classified as a provider request only when `BENCH_PROVIDER=gemini`; discovery, Edge, Google V2 and Custom runs block it. No real key or live Gemini request is used. The browser URL retains the configured custom endpoint and production routing appends no official Google endpoint.

Run the six level/scheduling combinations (3 measured samples plus one discarded warmup each: 24 trials total):

```sh
set -e
for level in 1 3 5; do
  for scheduling in fluid on-stop; do
    BENCH_LANE=provider BENCH_PROVIDER=gemini BENCH_OPTIMIZATION_LEVEL="$level" \
      BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING="$scheduling" \
      BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
      BENCH_OUTPUT="/tmp/opencode/gemini-level-${level}-${scheduling}.json" \
      pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
  done
done
```

Expected runtime values are independently checked, not copied from the observed provider snapshot: level 1/3/5 expects provider batching optimal size 50/20/6, 5,000 character limit, and provider concurrency 1/3/6. Scheduler chunk size is 80/30/15, maxChars 15,000, parallel execution enabled, and its flush/worker cap is 1/3/6. The trial retains the existing AUTO source-language resolution; the fixture does not force or claim a particular source code. HTTP target `ids` are mapped from fixture texts and structured Gemini wire IDs are retained separately as `wireIds`.

Logical scheduler batch count/sizes/peak and physical HTTP request count/peak are reported independently. AI retries or recovery can create additional physical requests, so there is deliberately no one-logical-batch/one-HTTP assertion; every physical attempt remains network-correlated, must settle successfully, and participates in exact target/source accounting. The deterministic valid response is reversed and retains request IDs, exercising the real parser's ID-to-input-order mapping. p95 remains unavailable for n=3 (the minimum remains 40). These offline measurements do not represent live Gemini latency, quality, model behavior, service limits or network behavior.

## Opt-in lazy scroll-through scheduling

The separate `scroll-through` fixture contains 12 unique targets in three four-target vertical bands; only band one is initially visible. Discovery remains selected with `BENCH_MODES` (`legacy`, `sliced`, or `viewport`), independently of lazy scheduler selection. Select one scheduler mode per invocation with `BENCH_SCROLL_SCHEDULING=fluid` or `on-stop`; either setting enables production lazy loading, while `on-stop` additionally enables translate-after-scroll-stop. These flags are never enabled for other fixtures.

```sh
BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=on-stop \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The runner uses deterministic `window.scrollTo` calls and awaits native scroll events plus animation frames; it does not simulate physical input-to-acceptance latency, invoke scheduler signals, or dispatch synthetic scroll events. It records initial visible acceptance separately from actual viewport-entry (`IntersectionObserver` with a zero-pixel root margin) and first accepted DOM-write timestamps on the same renderer `performance.now()` clock. Each target reports viewport-entry-to-write milliseconds when the write follows entry; an earlier accepted write is classified as prefetch and has unavailable (`null`) latency, not a negative measurement. Reports include per-band measurable count, mean, median, maximum, and prefetch count, plus `max(acceptedAt) - max(viewportEntryAt)` for last-entry-to-full-acceptance; that completion delta is signed and may be negative if permitted prefetch completed before the last entry. Production pipeline stages are separately recorded per target: Bridge discovery handoff, `IntersectionScheduler.add` registration, that scheduler's actual observer callback, DOMTranslator primitive admission, and PageTranslationScheduler enqueue. The production observer callback is not inferred from viewport entry; its configured prefetch margin remains a separate stage. Scheduler `isScrolling` is captured at every scroll checkpoint and at each batch selection/dispatch; no value is forbidden because first-batch, emergency, or already-running work can validly dispatch during scrolling. Batch `selectionViewport` geometry is sampled synchronously from the selected nodes when the scheduler chooses the batch. This is distinct from `requestViewport`, which is sampled later when the physical provider request is observed; neither is substituted for actual viewport-entry timestamps. Both geometry ledgers classify targets as in-viewport, within the existing 50px buffer, or outside that buffer. Re-requested targets, incomplete stage/acceptance coverage, missing timestamps, a terminal preceding a write, queue/settlement not drained, Restore mismatch, or observer cleanup errors fail the trial. These are correctness/timing probes, not physical scrolling performance claims.

The opt-in `dynamic-dom` fixture keeps the same 12-target initial page, enables production `WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES` only for that scenario, and inserts two deterministic three-target cohorts into the active session. Cohort one is inserted while the initial session is translating; cohort two is registered and inserted only after all 12 initial targets have both accepted settlements and accepted DOM writes. The report retains each cohort's raw IDs/timestamps and insertion-to-first/all accepted-write intervals. Static scenarios retain the existing setting (`false`) and fixture. The opt-in `spa-navigation` selection exposes a native `history.pushState` control and an exact local `/replacement` auto-rule (route A is not auto-started); its B-source mutation is gated on the real production invalidation callback.

## Opt-in open Shadow DOM fixture

Run the open-root traversal and automatic-mutation fixture in Legacy and Sliced modes:

```sh
BENCH_MODES=legacy,sliced BENCH_SCENARIOS=shadow-dom BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

The fixture starts with exactly three targets: light-DOM text (`shadow-light`), open-root element text (`shadow-open`), and a nested open-root `title` attribute (`shadow-nested-title`). It then inserts exactly two targets into the active session: one in an open root attached before its host is connected, then one added to that connected root. The direct `ShadowRoot` child-text and closed-root text sentinels must remain unchanged and are not targets. Automatic DOM-mutation translation is enabled only for this fixture; lazy loading remains off.

Timing uses one renderer-document `performance.now()` clock: initial acceptance is the latest accepted DOM write among the three initial IDs, measured from measurement start; each dynamic latency runs from that target's registered insertion to its accepted DOM write. Exact accounting checks each of the five IDs once at primitive admission, scheduler enqueue, selected batch, provider request, accepted DOM write, and scheduler settlement; batch and settlement ownership must match the run's translation session. The run then performs real Restore, verifies original target values/attributes and both sentinels, and checks that session work has settled and measurement observers disconnected.

Long-task results are reported only after the fixture's pre-measurement calibration captures a task of at least 50 ms. For the measurement-to-terminal and each insertion-to-accepted-write interval, only calibrated task entries whose full start-to-end interval lies within the renderer-clock bounds are included. Unsupported, failed, or uncaptured calibration makes the interval's long-task result unavailable (`null` with a reason), never zero. Translation and startup voice-list Edge responses are local fixtures; no external Edge service response is used.

`spa-navigation` uses the 12-target mixed text/title fixture and fully translates route A before navigation, then verifies production cursor progression, invalidation-gated source changes, automatic route-B session ownership, retained-node reuse, changed-target-only provider work, same-document `performance.now()` navigation latencies, and exact route-specific Restore of text and title attributes. It never holds provider responses or runs pending/stale-result probes. Run it with the static and dynamic regressions:

```sh
BENCH_MODES=legacy,sliced BENCH_SCENARIOS=small,dynamic-dom,spa-navigation BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
  BENCH_OUTPUT=/tmp/opencode/page-translation-spa-navigation-smoke.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

```sh
BENCH_MODES=sliced BENCH_SCENARIOS=dynamic-dom BENCH_SAMPLES=3 BENCH_WARMUPS=1 \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

## Opt-in sliced-discovery cancellation probes

Run the three real Chrome cancellation cases (A stop without restore, B real restore, C stop A then start replacement B while preserving accepted translations) with:

```sh
BENCH_CANCELLATION_PROBES=stop,restore,replacement \
  BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
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
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

Each requested case gets a fresh Chrome trial plus the normal network-guard negative probe. Before A starts, a stale-lane-only content bundle transform wraps the real Page scheduler's `safeSendMessage` result. It binds the first current-owner scheduler batch to its exact `PAGE_TRANSLATE_BATCH` message ID, session ID, and serialized item IDs/text, then holds only a genuine successful result after production send, timeout, and cancellation checks have completed, but before the Scheduler's `await` resumes. The real Edge HTTP response and `ProviderRequestEngine.executeApiCall` / provider-root promises must already have fulfilled. Stop or Restore invalidates A through the normal command. The `stop` and `restore` cases release A's held reply without starting B and verify the original DOM remains unchanged (including exact original attributes for Restore); A has accepted zero targets. Only `replacement` starts a distinct trusted auto/preserve B and holds its first real provider Fetch response while releasing A's exact result. It requires B's first batch to overlap targets A never accepted, positive call-through `_ownsFlushSession(false)` evidence after release, fulfilled A scheduler-batch settlement, no post-invalidation A acceptance or unattributed DOM write, and unchanged B counters/queue/context/controller/resources across that boundary. B must accept all 1,000 fixture IDs exactly once with B-prefixed output; the full DOM and original text/attributes after real Restore are checked. A separate raw mutation observer retains per-target old/new text values (including transient same-delivery changes) from invalidation through final drain; any A-prefixed or unknown value fails. Artifacts retain the gate state/events, exact batch message and members, network/provider evidence, scheduler ownership checks, lifecycle/settlement attribution, raw mutation values, full DOM snapshots, runtime resource snapshots and cleanup/drain status. Gate timeout/close always opens the held result unchanged; cleanup first requires actual inactive/discovery-cancelled lifecycle evidence. If Stop/Restore cannot establish it, Chrome is disposed without opening the gate. These probes make no performance comparison and do not replace the separate cancellation tests.

### Custom provider stale-success ownership probe (Phase 2.3.7)

```sh
BENCH_STALE_SUCCESS_PROBES=custom-stale-success \
  BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_MODES=sliced BENCH_SCENARIOS=early-visible \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

This isolated case uses the blank-key synthetic Custom adapter, 1,000-target Early-visible fixture, and the production level-3 25-item/two-worker configuration. `BENCH_SCROLL_SCHEDULING=fluid` is recorded as requested probe configuration only; Early-visible does not enable scroll scheduler settings, and `on-stop` is rejected. The case is correctness-only and does not enter provider performance aggregates or run with other correctness probes. Custom replies use the exact request wire IDs (not DOM fixture IDs) in the OpenAI-compatible `choices[0].message.content` envelope; the harness independently maps request text to fixture targets. Concurrent B batches are permitted only when they remain attributed to B and pass the existing active-resource ownership checks. No live provider traffic or credentials are used.

### Ten-cycle Custom offline soak (Phase 2.4)

Run the bounded 10-cycle, 30-scenario correctness soak in one Chrome process/profile and one reused page target:

```sh
GIT_OPTIONAL_LOCKS=0 BENCH_SOAK=1 BENCH_LANE=provider BENCH_PROVIDER=custom \
  BENCH_OPTIMIZATION_LEVEL=3 BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through \
  BENCH_SCROLL_SCHEDULING=fluid \
  BENCH_OUTPUT=/tmp/opencode/custom-offline-soak.json \
  pnpm exec node scripts/dev/page-translation/e2e-benchmark/run.mjs
```

Each cycle runs real Complete→Restore, Partial→Stop→Restore with a correlated held Custom Fetch request, then successful stale A→B replacement with all 1,000 B translations and Restore. The shared browser is not reset between scenarios; the same page target navigates to a new fixture document only after Restore, verified resource drainage, and evidence export. The harness validates unique session ownership, exact target/metadata restoration, physical request counts and concurrency, logical batch intervals and overlap, Fetch/handler drainage, and zero active runtime resources at each boundary. Settled instrumentation references are released only after their diagnostic history has been copied to the artifact. Any scenario failure or timeout stops the sequence, closes Chrome, and preserves completed plus partial trial evidence; timeout does not rely on `Promise.race` to cancel work.

This is a deterministic offline correctness soak, not a performance aggregate or live provider test. Custom credentials are blank and all provider responses are locally fulfilled; no live provider traffic is sent. Runner RSS is recorded only as process-level diagnostic context and includes artifact/history overhead. Chrome renderer heap/process memory is not available through this harness, so memory evidence cannot establish or exclude a browser memory leak. The soak makes no claim about browser-owned/component-extension traffic outside guarded targets, paint, live provider quality/latency, or physical user scrolling.

**Final validated result:** `/tmp/opencode/custom-offline-soak-issue-432-final.json` passed all 30 scenarios (10 cycles) on Chrome 157.0.8103.78. It used one Chrome launch/process and one reused page target, with no idle network requests at the end. The run used Custom, optimization level 3, Sliced discovery, Fluid scheduling, and 1,000 targets. Its provenance records HEAD `cabc04375db06e19f2784245e782f969cd6c6f0e` on `issue-432-provider-benchmark`; both production builds passed and `soak.buildParity.ok` is true.

Every scenario passed exact target-text and metadata restoration, and all sampled active-resource counts were zero. Each Partial→Stop→Restore scenario accepted 334 targets before Stop, proved the held Fetch was correlated and cancellation confirmed, and recorded no stale writes. Each stale A→B replacement accepted zero A targets and all 1,000 B targets with valid B ownership and no stale writes. Physical Custom Fetch counts were 42 / 16 / 44 per cycle for Complete / Partial / Stale replacement (1,020 total); peak physical concurrency was 2. Normalized concurrency evidence records logical-batch peaks of 2 for Complete and Partial, and 3 for Stale Replacement, in all 10 cycles. No cleanup errors were reported.

Runner RSS had a 133,386,240-byte baseline and an observed checkpoint range of 1,147,445,248–1,870,258,176 bytes. The last scenario checkpoint was 1,753,575,424 bytes; final Runner RSS was 1,930,133,504 bytes. These are process-level Runner RSS values and include retained evidence/artifact overhead; Chrome Heap was not measured, so Runner RSS cannot establish or exclude a browser memory leak. The final report is [Issue #432 final](../../../../docs/technical/benchmarks/whole-page-issue-432-final-2026-11-21.md).

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

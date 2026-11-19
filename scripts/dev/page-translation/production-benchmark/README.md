# Page-translation production-path benchmark

Run the default three-mode text benchmark:

```sh
BENCH_SAMPLES=10 BENCH_PREFIX_NODES=1200 BENCH_OUTPUT=/tmp/opencode/page-translation-production-benchmark-final.json pnpm exec node scripts/dev/page-translation/production-benchmark/run.mjs
```

Requires existing repository `node_modules` (including `domtranslator`), Node with native WebSocket, and Chrome/Chromium. No build, dependency install, production edit, or test-framework dependency is used. The harness imports the production `PageTranslationBridge`, `GuardedNodesTranslator`, and installed `domtranslator`; mode flags are in-memory constants overlays. It verifies 100-step / 8ms sliced defaults and reports caps from `PAGE_TRANSLATION_VIEWPORT_WINDOW_ENUMERATION_STEPS`, `PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_CANDIDATES`, and `PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_GEOMETRY_CHECKS` (each 100).

The local provider callback returns the Bridge settlement-shaped result after a fixed 0ms or 50ms delay. It does not exercise `PageTranslationScheduler`, real queue/batch behavior, external provider transport, or network latency. Expected accepted values include the exact English LRM prefix `\u200eT:<provider text>`; checks do not strip markers. Every eligible text or attribute primitive has a unique ID and must have one admission, one accepted settlement, and one exact translated DOM value. Each trial restores and checks original source text/attribute values before cleanup. Late-DOM uses a fixed viewport-spanning 4x4 panel after a 1,200-node offscreen prefix; flat control puts the same panel before the prefix. `BENCH_PREFIX_NODES` (minimum 200), `BENCH_SAMPLES` (default 10), and `BENCH_MODES` may be overridden. Each mode is warmed once; measured order reverses on alternating rounds.

Opt in to the attribute-heavy fixture separately (it is not in the default fixture list):

```sh
BENCH_FIXTURES=attribute-heavy BENCH_MODES=legacy,sliced BENCH_SAMPLES=10 BENCH_OUTPUT=/tmp/opencode/page-translation-attribute-heavy.json pnpm exec node scripts/dev/page-translation/production-benchmark/run.mjs
```

The fixture has 48 repeated groups and 240 eligible targets: each group has paragraph text, a separate title-bearing paragraph, image `alt`, a read-only text input `placeholder`, and button `aria-label`. It intentionally does not use form-control `value`: production excludes `value` on input, textarea, and button elements as mutable form state, including `input[type=button]`. It also includes absent supported attributes and present `data-*` attributes excluded from the allow-list; neither is a target. Only `title`, `alt`, `placeholder`, `value`, and `aria-label` are enabled for this fixture. Its first-visible metric counts only targets whose elements have a positive-area bounding box intersecting the viewport, rather than treating every target as visible. The invocation rejects Viewport-first mode for `attribute-heavy`; compare only legacy and sliced across both fixed callback-delay profiles (0ms and 50ms). The JSON artifact is written outside the repository.

The harness calibrates `PerformanceObserver` with a separate 75ms busy task excluded from trial data. Each `translate()` runs in a native scheduled macrotask after setup. Long Task entries are collected/drained and filtered to overlap invocation through the final accepted write; tasks crossing an interval boundary count at full duration because the API cannot split them. Count, maximum duration, and total duration are reported. If calibration fails, task metrics are null/unavailable, not zero. Browser Long Task observation generally cannot report tasks under 50ms. Discovery drain and all-write completion are elapsed measures, not active traversal CPU. First-visible is an observed accepted DOM mutation, not paint.

The aggregate JSON defaults to `/tmp/opencode/page-translation-production-benchmark-final.json` and contains per-trial data, percentiles, counts, browser/source hashes, and no page text. Chrome only has been validated.

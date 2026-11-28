# Manual live Page Translation benchmark

This opt-in development fixture measures Page Translation using the extension's configured provider. It does not make API requests on its own, and it is not part of the default test suite.

## Run

```sh
PORT=4178 node scripts/dev/page-translation/live-benchmark/serve.mjs
```

Open the printed `http://127.0.0.1:<port>/` URL in a browser profile with the Translate It extension installed. Specifying `PORT` is optional; without it, the server selects an available port automatically. Reuse the same port and origin across server restarts to keep accessing saved results in that origin's `localStorage`. Configure the provider, API credentials, source language, and target language manually in the extension first. Before running the standard benchmark, also disable `WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES` and `WHOLE_PAGE_LAZY_LOADING` in the extension configuration. These are extension settings, not benchmark URL parameters. With automatic DOM translation enabled, the scheduler may emit IDLE rather than terminal COMPLETE; the benchmark does not treat IDLE as completion. Start Page Translation on the fixture page and allow it to finish. For comparison, use the same settings and a fresh page for each trial.

Optional URL parameters include `?variant=A&level=1` for recorded labels and `?targets=600` for the higher-load fixture. Labels do not select a provider, change optimization settings, or configure the extension. The default fixture remains 120 targets; `targets=600` adds 480 deterministic, distinct paragraphs.

The page records the first accepted DOM change, first accepted change to an initially visible target, all-target DOM change, and lifecycle completion times, along with target counts, observed errors, cancellation, and interruption. A temporary IDLE event is not completion; wait for the matching terminal COMPLETE event. A trial passes only when the initial fixture is clean, all configured targets have changed, a matching COMPLETE event arrives, and no failure is observed.

These are lifecycle and DOM-change measurements, not paint timings or evidence of translation quality or semantic correctness. The fixture checks that target text changed; it does not judge the translated text.

## DeepSeek concurrency comparison

A manual 600-target Page Translation comparison used `deepseek-flash` at `https://api.deepseek.com/chat/completions` with thinking disabled. Four trials were run at each concurrency setting (2, 3, and 4); all 12/12 trials passed, with 252/252 HTTP requests successful and 18,833 input tokens per trial. The warm-cache hit rate was 74.76%. Warm-cache median completion times were 45.71s at concurrency 2, 31.98s at concurrency 3, and 26.55s at concurrency 4. The first cold-cache concurrency-4 trial is excluded from this warm-cache comparison.

Per-trial completion times and browser/network provenance are not included with these medians. These measurements cover this manual 600-target Page fixture and its lifecycle/DOM completion signal, not paint timings or translation quality. They are directional only and must not be generalized to other models or provider, network, or browser environments.

## Results and privacy

Trials are saved in this page's `localStorage`. Use **Export JSON** to download the recorded metadata or **Clear results** to remove it. Exports intentionally omit session IDs, page/source/translated text, credentials, and raw error messages or payloads. Error records contain event type, elapsed time, and a numeric failed count when available. Keep downloaded exports private if trial labels or timing patterns are sensitive.

The server binds only to `127.0.0.1`, uses an available port by default, and exits cleanly on Ctrl-C. Set `PORT=<port>` to request a specific local port.

## Test the fixture without API requests

```sh
pnpm test:run scripts/dev/page-translation/page-translation-live-benchmark.test.js
```

The Vitest tests serve the local fixture and simulate Page Translation lifecycle events and DOM mutations; they do not contact a provider or require API credentials.

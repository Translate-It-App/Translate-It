# Manual live Page Translation benchmark

This opt-in development fixture measures Page Translation using the extension's configured provider. It does not make API requests on its own, and it is not part of the default test suite.

## Run

```sh
node scripts/dev/page-translation/live-benchmark/serve.mjs
```

Open the printed `http://127.0.0.1:<port>/` URL in a browser profile with the Translate It extension installed. Configure the provider, API credentials, source language, and target language manually in the extension first. Before running the standard benchmark, also disable `WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES` and `WHOLE_PAGE_LAZY_LOADING` in the extension configuration. These are extension settings, not benchmark URL parameters. With automatic DOM translation enabled, the scheduler may emit IDLE rather than terminal COMPLETE; the benchmark does not treat IDLE as completion. Start Page Translation on the fixture page and allow it to finish. For comparison, use the same settings and a fresh page/profile for each trial.

Optional URL labels can be supplied as `?variant=A&level=1`. They appear in recorded trial metadata only; they do not select a provider, change optimization settings, or configure the extension.

The page records the first accepted DOM change, first accepted change to an initially visible target, all-target DOM change, and lifecycle completion times, along with target counts, observed errors, cancellation, and interruption. A temporary IDLE event is not completion; wait for the matching terminal COMPLETE event. A trial passes only when the initial fixture is clean, all 120 targets have changed, a matching COMPLETE event arrives, and no failure is observed.

These are lifecycle and DOM-change measurements, not paint timings or evidence of translation quality or semantic correctness. The fixture checks that target text changed; it does not judge the translated text.

## Results and privacy

Trials are saved in this page's `localStorage`. Use **Export JSON** to download the recorded metadata or **Clear results** to remove it. Exports intentionally omit session IDs, page/source/translated text, credentials, and raw error messages or payloads. Error records contain event type, elapsed time, and a numeric failed count when available. Keep downloaded exports private if trial labels or timing patterns are sensitive.

The server binds only to `127.0.0.1`, uses an available port by default, and exits cleanly on Ctrl-C. Set `PORT=<port>` to request a specific local port.

## Test the fixture without API requests

```sh
pnpm test:run scripts/dev/page-translation/page-translation-live-benchmark.test.js
```

The Vitest tests serve the local fixture and simulate Page Translation lifecycle events and DOM mutations; they do not contact a provider or require API credentials.

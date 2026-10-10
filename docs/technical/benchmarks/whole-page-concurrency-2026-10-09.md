# Whole-page concurrency measurement (2026-10-09)

Baseline: upstream `22ccf3711f7b827fe359094bb18336036813e2cd`, version 1.20.1. Measured fix: `6ff3a1eb63694fe7924bc325cb2d45acfd4c62c4`, including the duplicate-node guard. These timings precede the subsequent SPA followup and are not new measurements of that followup. Windows Chrome 155, AI Agent test profile, Custom OpenAI-compatible provider and the same existing loopback proxy/model alias (`gpt-6-luna-low-fast`). The alias is not evidence of effective reasoning effort or service tier.

## Controls and observation

- Serve [`tests/fixtures/page-translation-concurrency.html`](../../../tests/fixtures/page-translation-concurrency.html). SHA-256: `06a5794bb2efa9bcb7db4daf8e3ef7043ae01f0ef16f19afb1b229906fea550f`. All runs start from the same 90 distinct English paragraphs, AUTO → Japanese, no lazy loading or automatic DOM translation, conversation history off.
- Cold: reload the test extension and bypass the fixture cache. Warm: reuse the extension and reload the original fixture. This Page route does not reuse translated results: all 90 source IDs occur exactly once in the successful HTTP inputs in every run. Proxy/model caches cannot be disabled or inspected here.
- Use chrome-devtools on the fixture and extension options targets. Its page-scoped network collector cannot collect service-worker requests. A non-shipped observer in the copied test background records native fetch invocation, response headers and full-body completion, and Page batch receipt times. An own-options-only diagnostic returns metadata without headers, credentials, request/response text or HAR.
- Timing starts at the admitted Page command. First/full times are first/last validated DOM mutation, rather than the next paint. Peak counts are background HTTP fetches in flight; the deterministic loopback server independently validates actual HTTP overlap and the cap. Wire start timing and proxy-internal retries are not observable for the real proxy.
- Node checks require exactly one expected three-digit source ID and Japanese-script presence. They assess mapping, not semantic translation quality.
- Loaded background and content-script hashes were checked against the built files, including the final duplicate guard. Original background: baseline `6f03d80f8b77f3ec1d38e22206024bafda2119dd298eed2931a4c4b118c33197`, fixed `4f8cc7de7f893ce3d79306094b25a29bfbeb5ac5bc87bbcc952b1b8855b17139`. Final main content script: `e50721b98b17a2da1c52ed2108c61a6dce686f9750ccd192e741f8cfef7ecfe6`. Both use observer hash `a0c646b8830e17f80ca35229d35aaabe0902ae55d32d01923fa463ee06a06aa0`.

## Individual real-proxy runs

All 16 runs mapped 90/90 to the expected nodes, with zero missing, duplicate or misassigned results, zero HTTP failures and zero extension-side retransmissions. Hidden proxy retries are excluded from that statement. Custom batching is unchanged: level 5 = 10 items / 9 HTTP requests; level 3 = 25 items / 4 HTTP requests.

| Build | Level | Client state | Trial | First (s) | Full (s) | Peak fetches | HTTP successes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 5 | cold | 1 | 9.755 | 76.705 | 1 | 9/9 |
| baseline | 5 | warm | 1 | 9.665 | 80.747 | 1 | 9/9 |
| baseline | 5 | cold | 2 | 12.093 | 78.777 | 1 | 9/9 |
| baseline | 5 | warm | 2 | 9.407 | 77.459 | 1 | 9/9 |
| baseline | 3 | cold | 1 | 19.673 | 76.810 | 1 | 4/4 |
| baseline | 3 | warm | 1 | 18.928 | 71.498 | 1 | 4/4 |
| baseline | 3 | cold | 2 | 19.636 | 69.365 | 1 | 4/4 |
| baseline | 3 | warm | 2 | 19.266 | 68.386 | 1 | 4/4 |
| fixed | 5 | cold | 1 | 9.582 | 27.920 | 4 | 9/9 |
| fixed | 5 | warm | 1 | 9.389 | 26.638 | 4 | 9/9 |
| fixed | 5 | cold | 2 | 9.291 | 27.019 | 4 | 9/9 |
| fixed | 5 | warm | 2 | 9.787 | 29.539 | 4 | 9/9 |
| fixed | 3 | cold | 1 | 19.626 | 51.347 | 2 | 4/4 |
| fixed | 3 | warm | 1 | 20.218 | 51.362 | 2 | 4/4 |
| fixed | 3 | cold | 2 | 19.532 | 51.969 | 2 | 4/4 |
| fixed | 3 | warm | 2 | 19.487 | 50.179 | 2 | 4/4 |

## Aggregate (four runs per build and level)

| Level | Build | First mean (s) | Full mean ± sample SD (s) | Full range (s) | Peak |
| --- | --- | --- | --- | --- | --- |
| 5 | baseline | 10.230 | 78.422 ± 1.771 | 76.705–80.747 | 1 |
| 5 | fixed | 9.512 | 27.779 ± 1.291 | 26.638–29.539 | 4 |
| 3 | baseline | 19.376 | 71.515 ± 3.762 | 68.386–76.810 | 1 |
| 3 | fixed | 19.716 | 51.214 ± 0.748 | 50.179–51.969 | 2 |

Observed mean completion ratios are **2.82× at level 5** and **1.40× at level 3** on this fixture. They are not universal speedup guarantees. First-result latency remains primarily the intentionally serial AUTO owner/backend latency; level 3's measured first result did not improve.

Before the first HTTP body completed, baseline admitted one Page batch in every run; fixed admitted four at level 5 and two at level 3. Sibling provider calls still wait for the AUTO owner to resolve the semantic language pair. This separates accidental Page/normal-queue serialization from intentional AUTO initialization and transport wait.

## Deterministic browser calibration

The same final Chrome build, parser and scheduler used a local synthetic OpenAI-compatible endpoint with 120 ms base response delay. It retains all source/wire IDs, injects reversed batch completion and never logs credentials.

| Level | Fault | Actual server peak | Fetch observer peak | HTTP | Mapped nodes |
| --- | --- | --- | --- | --- | --- |
| 1 | none | 1 | 1 | 3 success / 0 error / 3 total | 90/90 |
| 3 | none | 2 | 2 | 4 success / 0 error / 4 total | 90/90 |
| 5 | none | 4 | 4 | 9 success / 0 error / 9 total | 90/90 |
| 5 | 429 | 4 | 4 | 9 success / 1 error / 10 total | 90/90 |

The 429 run made one retry; its first retry began **3.009 s after the 429 finished**, respecting `Retry-After: 1` plus shared client backoff. It recovered all 90 nodes. Unit/integration tests additionally cover partial failure, malformed JSON/selective recovery, cancellation, abort-ignoring delayed transport, lowered limits, cleared queues, settings/SPA/retranslation and duplicate pending walks. Those adversarial cases are not claimed as real-model performance measurements.

## Validation limits

Final applicable suite: 554 files / 10,936 tests passed, with only the four unchanged Windows-incompatible CI helper suites explicitly excluded. JS/style lint, both production builds, extension validation and production-bundle invariants passed. The unfiltered Windows run had 41 failures; a Git Bash CI-only rerun still had 13 failures plus preflight's missing `which`. No typecheck script exists. Firefox UI and the proxy's upstream effort/tier, retries or internal caches were not measured. The diagnostic prefix is absent from the production patch.

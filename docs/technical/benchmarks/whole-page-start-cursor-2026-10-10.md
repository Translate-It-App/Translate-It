# Page START and cumulative navigation regressions — 2026-10-10

This followup fixes two review findings and an independently reproduced immediate cancellation. It updates the bounded Page translation patch on top of `7017de2faf050418ef73d547a192114cc79f2fe1`. Product source SHA-256 values and sanitized measurements are in [the accompanying JSON](whole-page-start-cursor-2026-10-10.json).

## Immediate cancellation: delayed START erased live work

A Page attempt emits a frame START and then begins enqueueing work. START reaches the background through a round trip to the main-frame aggregator. On pages with enough synchronously discovered nodes, batches can register before the aggregated START arrives.

The START handler cleared the session's already active source-resolution state and request statistics. Waiting AUTO batches rejected as `USER_CANCELLED`; Page treated that as fatal and stopped the owner HTTP request. No navigation or setting change was needed.

The actual Nimbalyst trace registered four batches 19/16/13/9 ms before aggregated START; cancellation followed three milliseconds after START. The corresponding first HTTP was aborted before the mock's 800 ms response. GitHub showed the same order: four batch registrations, aggregated START, then cancellation six milliseconds later.

The product fix deletes the nine-line START reset block. A new Page attempt already allocates a new session ID. Source resolution and statistics already initialize on the first request; existing terminal cleanup remains. No new synchronization or startup delay is added.

### Reproduction

In an isolated profile, use Custom / OpenAI Compatible, AUTO → Japanese, level 5 Turbo, translation cache off, lazy loading off, and automatic DOM translation on. Open these public pages and start Page translation:

- <https://nimbalyst.com/>
- <https://github.com/openai/codex/issues/51649>
- <https://v3.primevue.org/configuration/>
- Control: <https://v3.primevue.org/autoimport/>

Nimbalyst was also tested with its site automatic-translation rule. Reload the extension and target tab when changing the tested build. This dataset uses a local fixed-response compatible mock, not a billable model.

### Browser comparison

Firefox 157 on Windows; the immutable 7017 ZIP was compared with the final build. Each HTTP returns valid ID-keyed fixed Japanese JSON after 800 ms, preserving segment/escape markers. Model quality and real-model speed are outside this test.

| Page / start | 7017 completed / admitted | Final completed / admitted | Final HTTP requests / 200 / abort | Final peak |
| --- | --- | --- | --- | --- |
| Nimbalyst manual, repeated | 0/450 in both runs | 450/450 in both runs | 45 / 45 / 0 each | 4 |
| Nimbalyst site automatic, lazy off | 0/450 | 450/450 | 45 / 45 / 0 | 4 |
| GitHub manual | 0/357 | 357/357 in both runs | 36 / 36 / 0 each | 4 |
| PrimeVue configuration | 0/481 | 481/481 | 49 / 49 / 0 | 4 |
| PrimeVue autoimport control | 188/188 | 188/188 | 19 / 19 / 0 | 4 before and after |

Every failed baseline above issued one HTTP, then aborted it before any translation was accepted. Its reported failed-element count was 10; the remaining work stopped. No HTTP 4xx/5xx occurred. Final successful wire-item sums equal the admitted counts; no retry or JSON-repair retransmission was observed in the valid 200 fixture. Failure/429/recovery behavior is covered separately by automated tests.

A lazy-on Nimbalyst baseline control did not cancel: 36 of 71 admitted tasks were processed at capture, with other tasks waiting for visibility; four HTTP requests succeeded, peak three. It is not a full-page completion sample. This supports an arrival-order race, rather than a site-wide deterministic rule.

Final Nimbalyst had 413 accepted body text records and 37 attributes, totaling 450. GitHub had 347 body text records, five attributes and five accepted text records in open shadow roots, totaling 357. PrimeVue records totaled 481 and 188. Final complete probes found zero duplicate record IDs or mismatches between live values and their accepted records. These checks do not claim model semantic accuracy.

### Timing boundaries

Manual-start time is measured before the normal runtime Page command. First-visible time is the first poll observing an accepted text record with a visible parent rectangle; completion requires all admitted tasks processed and local translating state idle. Polling adds approximately 150 ms plus the DOM bridge wait. Exact paint timestamps are not measured.

| Final manual sample | First visible observation | Idle completion observation |
| --- | --- | --- |
| Nimbalyst, valid timing run | 0.991 s | 10.587 s |
| GitHub, two runs | 1.039 / 1.032 s | 8.899 / 9.071 s |
| PrimeVue configuration | 0.966 s | 11.331 s |
| PrimeVue autoimport | 1.777 s | 6.354 s |

No speedup percentage is derived: failed baselines never completed and these are mocked timings. GitHub completion spread was 0.172 s across two runs. Other rows have only one valid timing sample. Automatic timings are omitted because navigation waiting already overlapped translation. The first final Nimbalyst timing exceeded the BiDi command deadline; its independently recovered 450/450 result and HTTP counts remain correctness evidence, but its first/completion times are excluded. The earlier successful autoimport baseline was captured before local IDLE, so its completion timing is also excluded from comparisons.

## Review P1: repeated away/return notifications

URL plus timestamp could not distinguish a new B occurrence from a same-URL state update when an A return notification was delayed. The background now attaches a cumulative per-frame cursor: ordered document epoch, route revision, and URL. Only tracked Page frames are enrolled; one current record per frame and the epoch allocator survive worker restart in session storage. No settings or permissions are added.

A fresh frame read at admission runs outside the shared capture queue. Its snapshot updates a record only if the document and route counters still match the durable baseline. This repairs first-enrollment discovery races without overwriting newer native captures or resurrecting removed frames. Failures reject admission safely; expired dispatch reads never send late commands.

A regression initially failed two repeated-away cases. Independent review then found a first-enrollment stale-discovery gap; two additional tests failed before the guarded fresh read. Unchanged/untracked operations initially made 105 storage writes for a 100-state-update scenario; the final mutation-only implementation makes zero additional writes and retries prior failed writes before returning a cursor.

### Native Firefox fixture

The production runtime translated 32 fixed paragraphs plus two shared nodes, then 12 new paragraphs were held at HTTP. Native A → B → A → B → A packets were captured, and a temporary relay deliberately delivered B1, B3, A4, A2. Natural native event reversal is not claimed.

- Both old sessions were aborted; replacement session IDs changed twice.
- Document route revision reached four; content invalidation revision changed twice.
- All 34 initially accepted nodes were retained without successful resending.
- Final 46/46 were accepted: 8 HTTP attempts, 6 successes, 2 aborts, peak three. Successful wire items totaled 46.
- An independent fixture-ID/text oracle checked all 46 translated values, with zero mismatches.
- Restore was checked against independently generated initial English strings for all 46 nodes, with zero mismatches.

A separate in-flight run performed 20 same-URL state updates and 20 scrolls while the mock response was held. Session and revision stayed unchanged, its controller remained live, and 46/46 completed with 5 successful HTTP requests, zero aborts and peak four. The smaller peak in the cancellation fixture reflects its batch count and AUTO bootstrap, not a lower configured ceiling.

## Review P2: queued attempts counted before transport

Request/character accounting and start logging now happen after proxy preparation, shared cooldown and the terminal cancellation check, immediately before transport handoff. Cancellation while awaiting 429 cooldown does not count an unsent attempt. This is handoff accounting; internal proxy work is not claimed to be exact wire telemetry. The browser peak/counts above come from the independent mock server.

Real Engine / RateLimitManager / Stats regressions failed five cases before repair; the final related seven suites passed 233 tests, including 429, key failover, non-AI preparation, abort, elapsed timing and slot release. Intentional `mock://` accounting remains.

## Verification, integrity and limits

- Navigation-related checks: 39 suites / 845 tests passed.
- START race integration: 7 cases using the real handler, coordinator and statistics manager with injected browser/engine/provider dependencies; related 4 suites / 156 tests passed.
- Final applicable Windows suite: 557 files / 11,100 tests passed. Four unchanged Linux-shell CI helpers were excluded on Windows: preflight, official-release, publish-development, development-workflow.
- Standard JS/style lint, both builds/validators, production-bundle invariant and diff checks passed. Firefox validation has zero errors and the existing 16 warnings. No typecheck script exists.
- Independent Astra source review approved the cursor/admission, accounting and START fixes.
- All 273 Chrome and 269 Firefox non-manifest product files in the diagnostic copies matched their immutable corresponding builds. Diagnostic scripts and manifest edits stayed in separate copies; production ZIPs contain neither probes nor seeded credentials.

Chrome DevTools confirmed Chrome 155's AI Agent profile but rejected installation from the configured workspace paths. No restriction was disabled and no extension was installed there, so this followup does not claim a new Chrome or real-backend run. Firefox MCP cannot evaluate the extension background directly; temporary metadata-only probes were used, then the temporary addon, owned Firefox instance and local server were removed/stopped. An initially stopped fixture and a diagnostic localhost match-pattern failure were excluded before valid runs.

The earlier 16 real-backend cold/warm performance trials remain attributed to `6ff3a1e`: level 5 mean full completion 78.422 → 27.779 s, peak 1 → 4; level 3 71.515 → 51.214 s, peak 1 → 2, all 90/90. See [the original study](whole-page-concurrency-2026-10-09.md). These values are not new measurements of this followup. Effective model effort/tier, hidden proxy retries/cache and live semantic quality remain unmeasured.

Final production ZIP SHA-256:

- Chrome: `5379797097c7a411d8741b6e12a992c38538448c6c0d4f63914a3a9eb6be4366`
- Firefox: `936b5a20a2ba403f84759a6f4cc1d6da608815ff82120a974e0de46f97e87ec7`

# Page translation traversal prototype benchmark

This isolated browser experiment compares the standalone viewport prototype with a **simulated synchronous full-traversal baseline**. It is not `domtranslator`, does not make a production-equivalence claim, and uses deterministic mock strings only. The harness never sends fixture/page text to a provider or writes page content to output. On live pages, site code may react to DOM mutations and make its own network requests.

## Local fixture

The factory accepts only the marked, dedicated `main#benchmark-root` in `fixture.html`; it refuses to modify `body`, `html`, or an unmarked/live-page root. The default workload has 2,500 deep branches plus visible text/attributes, exclusions/editable controls, open shadow content, light/shadow dynamic additions, and external edits immediately before restore. Baseline and viewport runs get independently reset identical DOMs and alternate order. One warmup per mode is discarded; five measured runs per mode are default. Setup, dynamic insertion scheduling, translation/idle processing, restore, and correctness accounting are distinct. Local correctness compares source text and attributes in memory before and after restore; the returned report contains only counts and aggregates.

```sh
pnpm exec node scripts/dev/page-translation-prototype/serve.mjs
```

Open `http://127.0.0.1:4178/` in Firefox, open DevTools Console, and run:

```js
await TranslateItPageBenchmark.run()
```

Optional arguments: `samples` (1–30; default 5), and `fixtureOptions` (`branches`, `depth`, `visibleCount`). The report includes medians/p95s and correctness counts; save only the aggregate output if recording a result. Do not capture DOM snapshots, text, node references, or console output containing page content.

The harness reports three different responsiveness signals, which must not be conflated:

- `maxSliceMs` is the engine's own slice timer, not a browser task duration.
- `heartbeatMaxDelayMs` is a coarse event-loop delay proxy, not a main-thread task measurement.
- `translationLongestTaskMs` and `restoreLongestTaskMs` use scoped `PerformanceObserver` longtask entries where supported; unsupported Firefox reports `null` for task counts/durations. Lack of entries is not proof of no jank. Firefox Performance Profiler's task/marker timeline is authoritative for real task lengths. `maxSliceMs` remains an engine measurement and is not interchangeable with longest browser task. Firefox's profiler memory view is authoritative for memory; `performance.memory` is sampled before setup and after cleanup per sample when available, otherwise the delta is `null`.
- `timeToFirstVisibleWriteMs`/`firstVisibleMs` is the engine's first visible DOM mutation, not paint. An optional `requestAnimationFrame` observation is not equivalent to a guaranteed presented frame.
- `engineProcessingMs` is `getStats().processingMs`: cumulative measured engine-slice execution time, excluding scheduler waits, fixture setup, and restore; it is not exclusive CPU time. `externalWallElapsedMs` is start-to-idle wall time including dynamic additions and scheduler delays. `restoreMs` is separately timed.

### Optional isolated Chromium run

Requires Node 22+ native `fetch`/`WebSocket` and installed Chrome/Chromium. It starts the loopback server and a headless browser with a fresh temporary profile under `/tmp/opencode`, reuses the single discovered DevTools endpoint, prints only aggregate metrics, and tears both processes/profile down in `finally`.

```sh
pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs
# or: CHROME_BIN=/path/to/chromium pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs
```

This is a convenience run, not Firefox validation. If browser startup or DevTools connection fails, report the failure; do not point it at an existing profile or weaken browser security settings.

## Firefox DevTools on a real page (manual, explicit opt-in)

1. Use a dedicated Firefox profile. Disable the extension's automatic Page Translation rule for the target page (or disable that feature in this profile) so it cannot mutate the DOM alongside the prototype. Keep the extension's production behavior otherwise untouched.
2. On a live page, paste **only** the standalone `engine.js` source from the local file into the Firefox DevTools Console. Do not load/paste `fixture.js`, `benchmark.js`, or run the fixture harness on a live page. Use the engine API directly and inspect only numeric stats:
   ```js
   const engine = TranslateItViewportPrototype.createEngine({ root: document.body, mode: 'viewport' });
   await engine.start();
   await engine.whenIdle();
   engine.getStats(); // numeric fields only; do not stringify/log DOM content
   engine.stop();
   await engine.restore();
   await engine.cleanup();
   ```
   Never inject with page fetch/import or paste a dynamic localhost import into Reddit. The prototype itself makes no network requests, but site code may react to observed DOM changes and initiate its own requests.
3. Reload the target before each mode/trial and capture matching initial conditions. Site mutation means repeated Reddit runs are not equivalent DOMs; record a fresh reload and comparable admitted-node counts for every trial. Never claim paired equivalence if counts differ.
4. Start only the viewport prototype first. Use the Firefox Performance Profiler to record tasks, responsiveness and memory; note profiler/browser version, viewport, initial counts, extension auto-rule state and trial order. Firefox Long Tasks observer support is not assumed: unsupported is reported as `null`. The harness first-write value is mutation latency, not a rendered-pixel measurement.
5. The `baseline` intentionally performs synchronous full discovery and can freeze a large live page. **Do not run it on Reddit or another real page unless you explicitly accept that risk.** Prefer baseline only in the local fixture.
6. Stop and restore before navigating away. Verify restoration without exporting page text. The direct live-page commands above own this lifecycle; fixture harness instructions apply only to the marked local fixture.

Firefox measurement is outstanding until performed manually. The synthetic baseline is not the current production implementation and cannot support replacing it.

The prototype is a traversal/mutation spike, not a production feature-equivalent implementation: it does not apply production font or direction behavior or own a SPA/session lifecycle. An externally edited owned node is preserved on restore, not translated again. Pending live candidates for removed nodes are pruned cooperatively; owned restoration records are intentionally retained until restore/cleanup. Scroll events coalesce to one finite viewport pass and, if changes arrive during it, one dirty follow-up pass; this is not an IntersectionObserver index and each pass is O(live pending candidates). Open shadow roots attached after discovery are not automatically discovered. Page scripts may react to prototype DOM changes even though the prototype has no outbound request code.

## Short report template

```text
Date / tester:
Browser + version / OS / viewport:
Environment: local synthetic fixture | live site (fresh reload)
Prototype revision / engine source hash:
Initial fixture/admitted counts (per trial):
Runs: warmups discarded; n=__ per mode; order:
Automatic Page Translation disabled for target: yes/no
Fixture: baseline engine execution median/p95 __/__ ms; wall elapsed __/__ ms; restore __ ms; first visible write __ ms
Fixture: viewport engine execution median/p95 __/__ ms; wall elapsed __/__ ms; restore __ ms; first visible write __ ms
Coverage / translated / restored / preserved-external counts, baseline: __
Coverage / translated / restored / preserved-external counts, viewport: __
maxSliceMs (engine only): __   heartbeat delay proxy: __
Translation longest task/count: __ / __ or unsupported/null
Restore longest task/count: __ / __ or unsupported/null
Firefox profiler longest task / task distribution: __ (not maxSliceMs)
Memory: Firefox profiler observation; performance.memory if available: __
Restore text/attribute mismatches: baseline __; viewport __
External edits preserved / exclusions untouched: __ / __
Limitations, deviations, failures, count mismatch or mutation between live trials:
Conclusion: synthetic evidence only; live Firefox validation required before replacement.
```

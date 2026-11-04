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

For the bounded rendered-geometry coverage checks (marked fixture only; numeric/boolean results, no DOM text output), run:

```sh
PAGE_TRANSLATION_BROWSER_CHECK=coverage pnpm exec node scripts/dev/page-translation-prototype/run-browser.mjs
```

## Firefox DevTools on a real page (manual, explicit opt-in)

1. Use a dedicated Firefox profile. Disable the extension's automatic Page Translation rule for the target page (or disable that feature in this profile) so it cannot mutate the DOM alongside the prototype. Keep the extension's production behavior otherwise untouched.
2. On a live page, paste **only** the standalone `engine.js` source from the local file into the Firefox DevTools Console. Do not load/paste `fixture.js`, `benchmark.js`, or run the fixture harness on a live page. Use the engine API directly and inspect only numeric stats. First start the engine and capture a numeric-only snapshot:
    ```js
    const engine = TranslateItViewportPrototype.createEngine({ root: document.body, mode: 'viewport' });
    await engine.start();
    await engine.whenIdle();
    window.__translateItNumericSnapshot = (stats) => Object.fromEntries(Object.entries(stats).filter(([, value]) => typeof value === 'number'));
    window.__translateItBeforeScroll = window.__translateItNumericSnapshot(engine.getStats());
    ```
   Scroll the page normally, stop scrolling, then run the second block to await idle, capture numeric counters, and clean up:
    ```js
    await engine.whenIdle();
    window.__translateItAfterScroll = window.__translateItNumericSnapshot(engine.getStats());
    console.table({ before: window.__translateItBeforeScroll, after: window.__translateItAfterScroll });
    engine.stop();
    await engine.restore();
    await engine.cleanup();
    delete window.__translateItBeforeScroll; delete window.__translateItAfterScroll; delete window.__translateItNumericSnapshot;
    ```
   The projection includes `processingMs`, `maxSliceMs`, `geometryChecks`, `prunedBranches`, and mutation-audit timings/counters as well as the new diagnostics. Nullable `firstVisibleMs` is omitted until a visible write occurs.
   Never inject with page fetch/import or paste a dynamic localhost import into Reddit. The prototype itself makes no network requests, but site code may react to observed DOM changes and initiate its own requests.
3. Reload the target before each mode/trial and capture matching initial conditions. Site mutation means repeated Reddit runs are not equivalent DOMs; record a fresh reload and comparable admitted-node counts for every trial. Never claim paired equivalence if counts differ.
4. Start only the viewport prototype first. Use the Firefox Performance Profiler to record tasks, responsiveness and memory; note profiler/browser version, viewport, initial counts, extension auto-rule state and trial order. Firefox Long Tasks observer support is not assumed: unsupported is reported as `null`. The harness first-write value is mutation latency, not a rendered-pixel measurement.
5. The `baseline` intentionally performs synchronous full discovery and can freeze a large live page. **Do not run it on Reddit or another real page unless you explicitly accept that risk.** Prefer baseline only in the local fixture.
6. Stop and restore before navigating away. Verify restoration without exporting page text. The direct live-page commands above own this lifecycle; fixture harness instructions apply only to the marked local fixture.

Firefox measurement is outstanding until performed manually. The synthetic baseline is not the current production implementation and cannot support replacing it.

`getStats()` keeps numeric viewport diagnostics after stop/restore; new diagnostics add no observers, scans, timers or node histories. `discoveryRequests` is the sum of trigger requests: start, scroll, resize, root/shadow DOM mutation, head mutation, body mutation, stylesheet load, and stylesheet error. `discoveryRequestsImmediate` counts requests that start a pass while idle; `discoveryRequestsCoalesced` counts requests folded into an active pass's dirty bit. Their sum equals `discoveryRequests`. `discoveryPasses` counts pass starts, including a pass later stopped partway; `discoveryFollowupPasses` counts dirty-bit follow-up starts, even if subsequently cancelled. For viewport mode, `seedAncestorVisits + seedSubtreeVisits + rootTraversalVisits` equals `visitedNodes`. `seedTargetRepeatVisits` counts only a hit-test target revisited at the start of its seed subtree after the ancestor-chain visit; it is a lower bound on overlap and does not measure seed/root cross-overlap or unique nodes. Baseline mode leaves new viewport counters at zero (the legacy `visitedNodes` remains its baseline traversal count). Mutation batch counters count observer callback invocations per source, even if no discovery is requested; record counters count delivered records. Observer scopes can overlap, so one DOM change may be counted by multiple callbacks. `mutationDataAttributeRecords` counts eligible data-attribute records seen; `mutationCssReferencedBatches`, `mutationCssClearBatches`, and `mutationCssFallbackBatches` describe one CSS audit outcome per batch when an audit runs. `mutationRelevantAttributeRecords` includes direct invalidators and data-attribute records classified as referenced/fallback; it excludes candidate data records when a different trigger makes the batch skip CSS auditing.

`discoveryRequestsDomMutation` specifically counts root and discovered-shadow mutation callbacks that request a pass; head/body request counters are separate. `domMutationObserverBatches` sums root, head, and body callback invocations, including callbacks that do not request discovery. Mutation record counters are not exclusive cause attribution: a batch can contain multiple categories, and overlapping observers can report the same DOM change more than once. `mutationRelevantAttributeRecords` includes direct attribute invalidators and data records classified as referenced/fallback; it excludes data candidates in a mixed batch when another trigger skips CSS auditing. For viewport mode, `discoveryPasses` equals immediate starts plus dirty follow-up starts; stopping with a dirty bit cancels that follow-up rather than counting it as a started pass.

The prototype is a traversal/mutation spike, not a production feature-equivalent implementation: it does not apply production font or direction behavior or own a SPA/session lifecycle. An externally edited owned node is preserved on restore, not translated again; owned restoration records are intentionally retained until restore/cleanup. Viewport mode uses one sliced discovery pass, prunes positive-area offscreen element branches, and coalesces scroll, resize, and relevant mutations to one active pass plus a dirty follow-up. It does not retain offscreen text/attribute candidates; each pass checks visible branches and a fixed set of hit-test seeds. Seed traversal can overlap the root pass, but every visited node is yielded to the slicer; `visitedNodes` counts these repeated visits. `geometryChecks` counts bounding-box reads (including write eligibility checks), `prunedBranches` counts skipped positive-area element subtrees, `discoveryPasses` counts viewport scans, and `pendingJobCount` is 0/1 for the active scan. A wide flat sibling list still costs O(N); overlapping seed subtrees incur bounded duplicate work (at most 16 hit-test targets). Bounding-box pruning is a heuristic, not a completeness guarantee: positioned/fixed or overflowing descendants can escape an offscreen ancestor and be missed until another eligible path/trigger reaches them. Zero-area containers are descended conservatively. Open shadow roots are observed once encountered, including for local scroll events; late-attached roots have no automatic trigger until another scan/mutation happens, and closed roots remain inaccessible. Page scripts may react to prototype DOM changes even though the prototype has no outbound request code.

Viewport mutation handling observes all attributes. Namespaced attributes, non-`data-*` changes and `data-translate-it-ui` always trigger rediscovery; own translated attribute writes are ignored. Other plain ASCII `data-*` changes trigger a bounded, batch-local CSSOM audit of document sheets/imports/adopted sheets, discovered shadow-root sheets, enclosing shadow scopes, and custom exclusion selectors. Shadow scopes retain at most 128 style/link element references, prune detached references, and reread each element's current sheet during an audit; overflow or an unresolved link conservatively forces rediscovery. Pending document stylesheet links are tracked with the same cap from a bounded head scan, a bounded startup enumeration of body link elements, root traversal, and bounded scans of added subtrees. When the translation root does not cover the body, a bounded body mutation observer registers/removes stylesheet resources outside that root; it filters other mutations but does observe broad body child-list activity. Document capture-phase load/error listeners catch links across head and body, with discovered shadow scopes covered separately and duplicate targets deduplicated. Link settlement/removal/replacement releases pending entries and requests rediscovery. A pre-existing link hidden in a pruned offscreen subtree may remain unknown until it is encountered or its load event fires; the load listener still schedules a fresh scan. If the audit proves the changed name is absent, no viewport pass is scheduled. The audit has fixed scope/sheet/rule/text/name limits; escaped or unsupported CSS, inaccessible sheets/imports, unresolved links, or exceeded limits conservatively schedule a pass. There is no dependency cache, so stylesheet changes are seen on the next batch. `mutationAuditCount`, `mutationAuditFallbacks`, and `mutationAuditMs` report these synchronous callback audits; audit time is separate from `processingMs`/`maxSliceMs` (the scheduled engine-slice metrics), and must not be treated as free. CSSOM access can be incomplete for shadow stylesheets hidden in unvisited/pruned content; when such a stylesheet is not known to the scope audit, no proof is possible. This remains an explicit stylesheet-coverage limitation, alongside geometry pruning's possible omission of positioned/overflowing descendants.

Over-budget added subtrees and stylesheet/pending-link cap overflow during a subtree scan are coalesced into one marker on that added subtree; resource caps found during per-node discovery mark the resource node. The bounded uncertainty-root set makes data audits fail closed while a marked subtree/resource remains live, then prunes its marker when the subtree is actually disconnected from the document (including through nested shadow hosts); a remove/reinsert within one mutation batch keeps the marker. The configured root observer also remains installed across temporary root detachment and is released on stop/restore. Body-link inventory and pending-map overflow are rechecked on body child-list changes and clear when the current bounded inventory fits. If the uncertainty-root set itself overflows, fallback remains conservative for the session because some live unknown roots can no longer be individually retired.

IntersectionObserver was considered but is not used for discovery: it only reports on explicitly registered targets, so registering every descendant would reintroduce the full scan. Scroll-triggered root rediscovery reaches previously unregistered branches instead. This prototype deliberately has no eventual full-document fallback.

For text nodes only, the existing composed-owner bounding-box fast path remains unchanged. If that owner has a finite, exactly zero-by-zero box, a fallback checks rendered `Range` fragments against the margin-expanded viewport and overflow clip boxes along the composed/assigned-slot ancestor chain, including ancestors above the configured root. Computed display/content visibility and the text owner's effective visibility are checked. Attributes, positive/one-dimensional boxes, failed geometry APIs, and unsupported clip/transform/zoom/paint-containment cases do not use this fallback; rounded overflow clips and nonzero overflow-clip margins fail closed. `geometryChecks` counts bounding-box reads used by the fallback; computed-style and Range calls are not included. This is conservative supplemental coverage, not a general painted-pixel oracle: unsupported effects and the existing positive-box fast path can still disagree with actual paint.

Directly slotted text starts fallback ancestry and effective-visibility checks at its assigned slot. Only computed `display`, `visibility`, and both overflow axes are mandatory; absent optional effect properties use inactive defaults, while explicit masks, clips, transforms, zooms, and paint containment fail closed.

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

# SPA navigation and pending-start followup (2026-10-10)

Measured baseline: `bf8fda6a428fce2b29bdc7a73923b12cea2f0933`. The final tested Chrome build is identified by its resource hashes below. Windows Chrome 155, AI Agent profile, the public Delta docs, existing Custom provider/model `gpt-6-luna-low-fast`, level 5, AUTO → Japanese, site automatic translation, lazy loading and DOM translation on, scroll-stop mode off. Saved settings and credentials were unchanged.

## Four review fixes

1. Background history notifications previously discarded their URL and forced a restart even for state-only updates. FeatureManager now shares one browser URL/timestamp tuple across both receivers. Same-URL updates and duplicate evidence do not restart translation; actual URL changes, hash routes and observed intermediate URLs still invalidate obsolete work. Browser timestamps are never compared with a renderer clock.
2. A snapshot local to a pending start could disappear when another route superseded that start. One stopped Bridge now retains accepted-original storage until a replacement takes ownership. Fresh storage still requires matching document, owned live node, committed value, update generation, provider, target and settings revision. Restore during pending initialization cannot overwrite host edits.
3. Provider-default listeners previously consulted the last accepted settings while a new settings load was pending. The current attempt records explicit-provider provenance before its first await; unresolved nonexplicit starts invalidate conservatively on default changes. Attempt ownership and captured settings revision are checked before publishing loaded settings or admitting work.
4. Explicit request providers now ignore both unrelated global and Page-mode defaults, addressing [the additional review](https://github.com/Translate-It-App/Translate-It/pull/296#discussion_r4231281684). Relevant provider-specific settings and translation settings still invalidate.

The connected first-await cancellation gap also uses the existing controller reservation before feature-conflict resolution. Stop, restore and cancel cannot start translation when that wait later completes; old continuations cannot replace a newer session. No additional cancellation flags, saved setting, dependency or history cache was introduced.

## Real Chrome scroll reproduction

From a settled Welcome page, follow the actual Quick Start SPA link. Alternate `window.scrollTo` between the document bottom and top 16 times at 500 ms intervals while translation runs. Observe the extension service worker and the controlled tab, rather than inferring concurrency from display order.

On the baseline, Delta emitted repeated history notifications with the unchanged Quick Start URL. Six in-flight HTTP calls aborted immediately after those notifications: for example, notification at 1791559380163 ms and request termination at 1791559380167 ms. Six subsequent calls returned 200 after scrolling stopped. The ordinary scroll tracker only signals scheduler activity; the forced navigation restart caused these aborts.

The fixed build received 19 browser navigation events in each repeat, including state-only updates during scrolling. Both receivers consulted the same navigation owner. There was exactly one stop/revision change for each genuine Welcome → Quick Start transition and no additional restart while scrolling.

| Build / sample | HTTP attempts | HTTP 200 | Aborted | Peak HTTP | Completed / admitted | Live accepted records | Duplicate IDs / value mismatch |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| baseline | 12 | 6 | 6 | 3 | 63/63 | not captured | not captured |
| fixed / 1 | 14 | 14 | 0 | 4 | 98/98 | 98 | 0 / 0 |
| fixed / 2 | 11 | 11 | 0 | 4 | 91/91 | 91 | 0 / 0 |

The HTTP spans were 24.611 s, 16.777 s and 12.636 s respectively. These are first fetch invocation to final normal application body consumption, including aborted requests, **not full-page paint/completion times**. Lazy/dynamic admission differed substantially, so they do not establish a fixed-input speedup or request-cost reduction. First translated paint and cold/warm provider-cache performance were not remeasured in this followup. Earlier fixed-page level-5/level-3 measurements remain attributed to `6ff3a1e`; earlier SPA-bootstrap measurements remain attributed to `bf8fda6a`.

Both fixed samples had zero failed logical items. Their provider calls and HTTP attempts matched, all logical calls belonged to the controlled Page session, and no additional client HTTP attempts for retry/repair were observed. After the second round trip, manual restore returned a retained shared navigation node to its exact earlier original. Temporary worker/content probes were removed.

chrome-devtools' page network collector cannot observe extension-worker requests. Non-shipped probes record fetch start, headers arrival, abort/end and the first **normal application** body-consumption completion; they add no body reads. Only public navigation URLs, timing, session/count/language metadata and record consistency counts were saved. No content, headers, credentials or HAR were exported.

## Final build and checks

Loaded resource hashes matched the final unpacked files:

- Background: `80aac4149e98fcf8895f2ff07710c1837d6a699530cfe7592607d58f12f172f7`.
- Main content entry: `3fb6e397c166f4d290b62623a04b7cc42df6800862387aca57555bf27dc57db3`.
- Chrome ZIP: `928c644b919118165c460b24eed0e555445a28413b52b080efb1b2c35fc5aa9d`.

The four original regressions and four first-await cancellation regressions first failed on their respective unfixed sources. Final related tests passed: **29 files / 991 tests**. Full applicable Windows suite passed: **554 files / 11,029 tests**, excluding the same four unchanged Windows-incompatible CI helpers. The 1,765 tracked source/test/config/script/package files had identical hashes before and after final verification. Standard ESLint, Stylelint, both builds, both validators, production-bundle invariants and diff checks passed. Chrome validation had zero warnings; Firefox had zero errors and the same 16 warnings. No typecheck script exists. Independent source review approved the fixes.

A genuinely different URL notification delivered late can conservatively cause one restart; retaining originals makes that restart safe. Pending nonexplicit provider selection is deliberately conservative until settings resolve. Hidden proxy retries/cache, effective model effort/tier and semantic translation quality remain unmeasured. Firefox UI was not exercised. The earlier uninstrumented startup with ten failed logical items remains unexplained and is not claimed resolved by these fixes.

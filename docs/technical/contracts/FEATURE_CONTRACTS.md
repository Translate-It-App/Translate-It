# Feature Behavioral Contracts

Authoritative reference for the **observable, feature-level behavior** of all user-facing translation modes after the shared translation pipeline returns an accepted result or a typed failure.

- **Owner(s)**: feature consumers (`UnifiedModeCoordinator` routing, `DomTranslatorAdapter`, `PdfTranslationCoordinator`, `PageTranslationScheduler`, `SubtitleTranslationCoordinator`, selection/window handlers, Popup and Sidepanel stores and components).
- **Scope**: selection, field, element, popup, sidepanel, whole-page, PDF, and subtitle translation.
- **Status**: finalized for the documented scope.

This document defines feature-level behavior only. It references, but does not replace, the shared pipeline contracts.

---

## 1. Purpose and Scope

This document defines **feature-level observable behavior** after the shared translation pipeline returns accepted results or typed failures.

The shared pipeline validates and classifies results. Each feature consumer decides how **source presentation is preserved or mutated**.

```text
shared pipeline
→ validates and classifies results

feature consumer
→ decides how source presentation is preserved or mutated
```

Source preservation is a **feature decision**, not a provider fallback. The shared pipeline never silently substitutes the original source text as a successful translation; features state explicitly what happens to original content on failure.

Sibling contract: [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) defines the structured identity/fragment rules shared by Select Element and PDF. This document covers the per-feature observable contract on top of those rules.

---

## 2. Shared Feature Invariants

The following invariants hold for every feature unless a section below explicitly overrides them.

```text
valid complete result
→ may be applied

failed / missing / invalid result
→ original source remains

explicit source-equal result
→ valid

timeout
→ TRANSLATION_TIMEOUT

cancellation
→ USER_CANCELLED

late settlement
→ ignored

same logical identity
→ applied at most once
```

Additional invariants:

- **No nonblank source may be replaced by blank translated output.** A blank translation result is a failure; the feature keeps the original.
- **Completed independent units may remain applied after a later failure.** Features process units independently; a later failure does not roll back already-accepted earlier units (see [Partial Success Contract](#13-partial-success-contract)).
- **No raw V2/V3 fragment reaches feature consumers.** Fragments are assembled by the shared pipeline; features defensively suppress any fragment that still leaks through (Select Element and PDF directly).
- **Feature counters must exclude suppressed or unresolved results.** Terms `translated`, `failed`, `skipped`, `unresolved`, and `partial` describe logical feature outcomes, never raw provider statistics.

---

## 3. Feature Matrix

| Feature | Mutation owner | Partial success | Revert support | Timeout owner | Cancellation owner |
| ------- | -------------- | --------------- | -------------- | ------------- | ------------------ |
| Selection Window | none (read-only overlay) | n/a (single result) | not needed | `TranslationHandler` (window manager) | `WindowsManager.cancelCurrentTranslation` |
| Inline Selection | none (tooltip overlay) | n/a (single result) | not needed | `TranslationHandler.performTranslation` | `HoverTranslationManager._cancelPendingHover` |
| Select Element | `DomTranslatorAdapter` + `BlockGroupReconstructor` | yes (per-unit, A/B/C kept) | manual via `SelectElementManager.revertTranslations` | pipeline (`ErrorTypes.TRANSLATION_TIMEOUT`) | selection: single Esc via `SelectElementManager`; global cancellation/revert: non-consuming Double Esc |
| Field | smart-handler replacement service | n/a (single value) | no (write-on-apply) | shared pipeline | `cancelTranslation` via `useUnifiedTranslation` / `dataStore.abortExistingRequest` |
| Popup | none (app-owned store) | n/a (single result) | not needed | shared pipeline | `cancelTranslation` (silent reset) |
| Sidepanel | none (app-owned store) | n/a (single result) | not needed | shared pipeline | `cancelTranslation` |
| Whole Page | `PageTranslationManager` → `PageTranslationScheduler` | yes (per-batch, kept) | yes (`restorePage`) | `Promise.race` timeout (shared) | `cancelTranslation` → abort + `restorePage` |
| PDF | `PdfTranslationCoordinator` + `PdfTranslationAdapter` | yes (per-cell, kept) | no per-block revert | `getAbortTimeout` / `TRANSLATION_TIMEOUT` | `cancelActiveTranslation` (bumps `runId`) |
| Subtitle | `SubtitleTranslationCoordinator` | yes (per-cue, kept) | no revert of committed cues | `Promise.race` (5-min) | `cancelJob` → `status: cancelled` |

Feature mutation ownership:

- **Selection Window / Inline / Popup / Sidepanel** do not mutate the page; they render into overlay or app-owned UI.
- **Field / Select Element / Whole Page / PDF / Subtitle** own mutations and are responsible for per-unit application and any revert.

---

## 4. Selection Window Contract

Modes: text-selection window (`SelectionWindow`), `Selection`/`Selection_Window` dispatch.

- **Trigger**: from text selection (`mouseup` in text-selection handlers).
- **Source DOM remains unchanged.** The window is a shadow-DOM Vue overlay; it never writes page text.
- **Valid result** appears in the translation window via `TranslationDisplay`.
- **Invalid / timeout / cancel / error** becomes error state (`isError`, `errorType`, `canRetry`).
- **Closed or stale window must not accept late results.** `useWindowsManager.handleUpdateWindow` drops updates whose `id` is no longer present ("Window was closed before translation completed"); a late result cannot recreate a dismissed window. `TranslationHandler` also keys on `messageId` and returns `false` for unmatched results.
- **No revert needed** because the source is never mutated.
- **Source-equal translation remains valid.** It is non-destructive and stored as normal content.

---

## 5. Inline Selection Contract

Modes: hover / mouse-on-hover inline tooltip.

- **Selected page text is never replaced.** `HoverTranslationManager` only manages highlight classes and tooltip states; it never writes text to the page.
- **Result box appears only for accepted output.** `_processHover` emits ready only when `currentMessageId` matches and `translatedText` is truthy; the tooltip also skips a missing translation.
- **Loading UI settles on success / error / timeout / cancel.** Streaming settles via `isStreaming`; error → `showError`; timeout → `showError`; cancel → ignored (no UI error) and the tooltip hides.
- **Duplicate result/display prevented.** Ready only emitted when message id matches; a redundant (source-equal) result hides the tooltip rather than displaying.
- **Late result cannot recreate a dismissed box.** `_cancelPendingHover` bumps `messageId`; old resolve/reject does not match.
- **Modifier trigger intent is standalone.** `primary`, `control`, `alt`, and `shift` modes activate only after a standalone modifier press is released; `primary` resolves to Control on Windows/Linux and Command on macOS, while `control` remains explicit Control. Normal keyboard shortcuts invalidate the gesture. Mouse movement updates position but does not independently schedule modifier-mode translation.

---

## 6. Select Element Contract

Modes: `Select_Element`.

- **DOM mutation owned by `DomTranslatorAdapter`** (via `_applyTranslationToNode`; block groups via `BlockGroupReconstructor.apply`).
- **Accepted units are applied independently and immediately** (synchronously within the stream/direct loop; no batch flush/commit phase).
- **Failed units remain original** — failure is recorded by omission (UID→node resolution simply never calls `_applyTranslationToNode`), so a failed node is untouched.
- **Partial success scenario: A success, B failure, C success** → nodes A and C stay translated; node B remains original. No rollback of completed independent units on a later provider failure.
- **Raw fragments suppressed** at the adapter boundary (`isSplitFragment` / `isV3Fragment` → skip before any write).
- **Duplicate logical identities applied once** via UID + `processedUnits` set.
- **Esc / user cancellation**: during active selection, `SelectElementManager.handleKeyDown` owns and consumes single Esc to cancel the mode. Outside selection, global cancellation or revert requires two plain Esc presses within 400ms and never consumes either event. Repeated or modifier Escape does not count. Cancellation does **not** revert already-applied partial translations.
- **Revert** (`SelectElementManager.revertTranslations`) restores the **original text and direction metadata** (`restoreElementDirection`, removes `data-has-original`).
- **Block-group reconstruction is atomic.** `BlockGroupReconstructor` validates first (segment markers, node connectivity/content), then commits all units synchronously. Atomicity is enforced through validation plus transactional rollback: validation occurs before mutation, mutation may then begin, and a mutation-phase failure triggers best-effort rollback of the affected transaction. Rollback failures are aggregated as secondary diagnostics and never replace the primary mutation failure.

Revert can be invoked for a partial state: `preserveTranslations` keeps intervening decomposable successes; only reverted on explicit user action.

---

## 7. Field Contract

Modes: `Field` (`textarea`, `contentEditable`) via smart-translation field service and text-field interactions.

Coverage includes `input` and `textarea`, `contentEditable`, and framework-controlled fields.

- **The configurable Text Field shortcut (default Ctrl+/) and inline icon use the same behavioral contract.** Both funnel into `translateFieldViaSmartHandler({ text, target, selectionRange, sourceSnapshot })` (icon manager and shortcut handler) before applying results. An active selection defines the source on every field technology: `input`/`textarea` capture the exact substring with `{ start, end }` offsets; `contentEditable` captures the selected text only (canonical newlines) with a serializable root-relative DOM bookmark (plain index paths + offsets + per-level structural lineage of tags/child-counts from the scope root — never live `Range`/`Selection`/node refs, never overloaded onto native offsets). No selection means full-field behavior. The single canonical identity field is `expectedSourceText` (selected text for selection scope, full request-time source for full scope), carried on the descriptor as `{ scope, targetKind: 'native' | 'contenteditable', expectedSourceText }` plus the kind-appropriate range representation.
- **Failed / invalid / empty translation leaves the field value unchanged.** The application service throws without writing; a failed insert returns false with no DOM mutation.
- **Cursor/selection must not be corrupted.** Replacement goes through via `range`/selectionStart/End and re-setSelectionRange after applying. The request-time scope is authoritative for normal `input`/`textarea` and `contentEditable` on every strategy: selection scope replaces only the captured range/bookmark and full scope forces a whole-value replace, so a later caret/selection movement can never redirect old output. Enforcement lives centrally in the shared `framework-compat` replacement pipeline (via `applicationContext.fieldSource`: offsets for native, bookmark restore + live aim for CE); strategies hold no duplicated range/stale logic. Insertion layers revalidate and re-aim just in time before each contentEditable mutation, so a selection moved during an awaited step still resolves to the captured range or fails closed — the moved range never receives output. Scoped contentEditable requests never enter character-by-character natural typing (its await/mutate loop cannot hold a captured range); atomic strategies run first and simple replacement remains the final scoped fallback, while legacy descriptor-absent calls keep char-by-char typing exactly. Multiline sources travel with `\n` (canonical block-structure serialization on capture; `<br>`-preserving insertion) and multiline translations apply with structure kept. A contained non-collapsed selection stays a selection scope even when its canonical text is whitespace-only; it is captured verbatim and applied to exactly that range.
- **Accepted update emits only the required `input`/`change` events** (with `bubbles`), not synthetic unrelated events. A `beforeinput` simulation layer that produces no mutation emits nothing and yields, so the single succeeding fallback owns mutation+events (no duplicate/spurious input).
- **Cancellation never clears user text.** Cancellation dismisses UI and discards pending data without modifying `target`.
- **Stale translation instance cannot overwrite newer user input.** `translateFieldViaSmartHandler` aborts on an existing request for the same target, and a pending-result guard (`STALE_DATA_THRESHOLD` timestamp) drops stale data. Source identity protects both scopes before any write on every strategy path: native selection requires the live substring at `[start, end]` to still equal the captured source, and native full requires the live full value to still equal it; contentEditable selection requires the bookmark to resolve with every lineage level (tags/child-counts from the scope root) intact and the canonical source text there to still equal the captured source, and contentEditable full requires the current canonical editor text to still equal it — otherwise the apply fails safely with no overwrite and no text-search relocation. Caret/selection-only movement never invalidates either scope. Edits outside a captured native range stay valid while the captured substring still matches; outside text-only edits on CE stay valid while path, lineage, and source text all still match. Residual: perfectly indistinguishable same-structure/same-text swaps (e.g. reordered identical twins) carry no signal to refuse on and stay valid by design. Contradictory descriptors (a full scope carrying any range representation, or mixed native/CE range forms) are rejected as malformed, never silently canonicalized. A present-but-malformed scope descriptor also fails closed (no write); only a fully absent descriptor (legacy callers) keeps the live-DOM fallback. Known routing notes: Medium uses the original request target with the shared pipeline for explicit CE descriptors (historical paragraph/editor resolution is legacy-only); Twitter Draft.js skips its select-all only for CE selection scope, with an exactly-once input nudge; Telegram parks the caret at end only for non-selection scopes; Discord Slate full-document replace is bypassed for CE selection scope (range-aware pipeline instead).
- **Selection scope is independent from Copy/Replace mode.** Selected + Replace replaces only the captured range (prefix/suffix preserved, newlines kept); selected + Copy copies only the selection translation with no field mutation (no range restore needed); no selection copies the full canonical text / replaces the whole field.
- **Source-equal output is valid** — it is accepted and, being identical to the field value, applies as an effective no-op.

Same-language popup fallback explicitly does NOT apply to fields within the field path; fields only write a truly accepted result.

---

## 8. Popup Contract

Modes: `Popup Translation` (direct result in the popup UI).

- **Input remains visible on failure.** Textarea keeps `sourceText`; only the result area resets.
- **Result area contains only accepted output.** On error `translatedText` is cleared and the error state is shown. **No source fallback is inserted as a translation** on failure.
- **Same-language display caveat:** when source and target languages are equal, the popup app may display the original text as the result. This is a deliberate display behavior, not a source fallback on failure; it is never used to mask a failed translation.
- **Spinner always settles** on success, error, no-valid-response, timeout, or cancel.
- **Copy / TTS controls are enabled only for valid result content.** The display toolbar renders only when content is non-empty (not loading).
- **Cancellation and timeout remain distinct.** Cancel is a silent reset with no error state; timeout is a typed `TRANSLATION_TIMEOUT` error state.
- **Direct result does not mutate page content.** `UnifiedResultDispatcher` routes `Popup_Translate` results directly back to the popup; it does not dispatch Popup mode to the tab. (History persistence writes to storage, not the DOM.)

---

## 9. Sidepanel Contract

Modes: `Sidepanel Translation`, `Popup Translation`-equivalent direct result in the app.

- **Same direct-translation result contract as Popup.** It reuses the same unified composable/store and direct-mode principle: source remains, result area shows only accepted output, no source fallback on failure.
- **Persistent view lifecycle.** Local refs and store keep the current translation across panel usage.
- **Stale request protection.** A `pendingRequests` set filters out late/unknown results; the awaited response or a matching id is the only accepted terminal.
- **Result/history state after error:** source kept in the textarea, result cleared to error state; no history write is recorded (history records only success).
- **Page source remains unchanged.** Sidepanel results return directly to the app and are never dispatched to the tab DOM.
- **Navigation or panel closure prevents late UI mutation.** `onUnmounted` removes the message listener and clears pending requests signal so late updates are dropped.

---

## 10. Whole Page Contract

Modes: `whole_page` / batch translation.

- **Page mutation owned by the page-translation feature** (`PageTranslationManager` → `PageTranslationBridge`, which wraps the `domtranslator` library).
- **Accepted nodes are applied independently** (each text/attribute node translated via `NodesTranslator`, driven by `DomTranslator`'s per-node walk).
- **Independent AI page batches use bounded workers.** Page dispatch shares the provider's physical request limit; it does not multiply that limit. The first AUTO batch still resolves the session's language pair before sibling provider calls. Traditional and conversation-history-dependent paths retain their execution policy.
- **Batch item identity is session-owned.** The scheduler sends stable item IDs; the background preserves those IDs after provider response normalization. The scheduler maps results by ID, rejects unknown/duplicate IDs, and settles missing items as failed without resending valid siblings.
- **Obsolete work cannot commit.** Session, source, target generation and DOM ownership are checked before application. Relevant settings changes, stop/restore and trusted SPA navigation invalidate pending work while retaining already committed translations on stop.
- **SPA invalidation and automatic restart share navigation ownership.** `FeatureManager` invalidates loaded Page work synchronously before re-evaluating the existing site rules, exclusions and user override. Trusted background `SPA_NAVIGATION` and `PAGE_TRANSLATE` messages carry `navigationCursor: { documentEpoch, routeRevision, url }`. The background persists participating frame cursors in `browser.storage.session` before delivery: a committed tracked document gets a new monotonic epoch, and each captured full-URL change increments its route revision, including hash changes. Consumers compare epoch first, then revision; a newer cumulative cursor invalidates obsolete work even after a missed A→B→A round trip. Same-URL state updates do not increment the cursor, and equal/older cursor notifications do not invalidate replacement work when the live URL is unchanged. The live document URL remains authoritative; Page admission also requires the cursor URL to match it. Explicit stop/restore suppresses automatic restart on the same URL. Browser timestamps are not used for cursor ordering.
- **Page navigation admission preserves reliable tracking or fails closed.** Frame discovery validates the entire participating list before pruning records or allocating epochs; failed or invalid discovery preserves existing child tracking. Admission refreshes an existing cursor from the live browser frame outside the serialized capture queue; newer native epoch/revision evidence wins over a delayed snapshot, and a removed frame cannot be resurrected. Missing, malformed or undurable navigation evidence is sent as `navigationUnavailable: true`, which stops obsolete Page work without admitting a new translation. Frame-command deadlines include admission reads, and expired reads cannot send a late start. Successful discovery still prunes missing participants; a top-frame commit retires child records, and tab closure retires all records for that tab.
- **Same-document automatic navigation preserves only unchanged accepted nodes.** One stopped Bridge session keeps restore storage until its replacement takes ownership, including when another navigation preempts settings loading. Original text is copied into fresh session storage only when the document, live node, committed DOM value, update generation, provider, target and settings revision still match. Pending, failed or edited nodes are not inherited. Retained nodes count once without another request; manual retranslation does not use this retention path. Restore during a pending restart touches only unchanged, owned accepted nodes.
- **Provider defaults invalidate only dependent Page sessions.** SettingsLoader records the effective provider's source in transient `usesGlobalProvider` metadata. A Page mode provider remains active when the unrelated global provider changes; an explicit request override also ignores Page-default changes. An unresolved start uses its own explicit-provider provenance rather than the previous session's settings, and nonexplicit starts invalidate conservatively on provider-default changes. Settings revision and attempt ownership are checked before publishing loaded settings and admitting work. `isExplicitProvider` continues to identify request overrides only.
- **Settings observers and commands follow the current Page instance.** Page settings listeners use the existing resource tracker, so cleanup removes retired callbacks and reactivation registers them once. A later setting change cannot keep invalidating a retired instance. The content command handler reacquires an inactive cached manager from the feature loader, keeping translation execution and navigation invalidation on the same instance; failed feature admission cannot revive a retired manager.
- **Failed nodes remain original.** An errored batch item is resolved but the node's original text is retained and the DOM is not marked translated.
- **Explicit skipped results remain original.** An item with `isSkipped === true` resolves to its original text, increments `failedCount`, never increments `translatedCount`, and does not prevent other valid items in the same batch from being applied.
- **Completed nodes remain translated after a later failure/timeout.** Already-settled resolved nodes are not rolled back; only the in-flight batch is affected.
- **Blank output keeps the original node text.** Empty, whitespace-only and non-string results resolve as failed: original text remains, `failedCount` increments once, and `translatedCount` does not increment.
- **Source-equal output is valid.** Identity translations are accepted results and must not be classified as skipped or failed; they count as translated once the bridge accepts the current node.
- **Progress uses terminal counts (translated + failed) against the total.** Counts describe logical nodes, not provider statistics. Suppressed (context-mismatched, empty, excluded) items are excluded from totals before counting. Provider success remains pending until the bridge validates DOM ownership and accepts the node; stale results count as failed, and each item settles at most once. Unknown/duplicate response IDs reject the affected batch without applying results or counting duplicates as translated.
- **Nested/child omission:** traversal recurses into shadow roots and visits all text nodes and translatable attributes (`title`, `alt`, `placeholder`); nodes for excluded selectors / internal UI hosts and empty text are omitted from translation and counting.
- **Cancellation:** `cancelTranslation` aborts the current session and prevents partial commits of in-flight un-committed nodes; committed nodes follow the feature's revert policy. Stop also releases the accepted session's AUTO language-resolution state through the existing `CANCEL_SESSION` path, without clearing a different pending start's identity.
- **Revert behavior and metadata ownership.** Full-page revert (`restorePage`) calls the underlying translator's `restore` to restore original node text and then deep-cleans page markers (`data-page-translated`, direction, original-text metadata), restoring both translation markers and direction.

A batch is not individually atomic-in-partial: only the in-flight batch is bounded by failure; committed earlier nodes persist.

---

## 11. PDF Contract

Modes: `pdf_translation` (whole document) and structured cell batches.

- **Block/cell application owned by `PdfTranslationCoordinator` + `PdfTranslationAdapter`.** Results applied into session state (`setBlockTranslationState`).
- **Structured cells use `cellId`** to disambiguate cells within a block; `lineIndex`/`cellIndex` position cells, `cellId` identifies.
- **Numeric `cellId: 0` is valid** and preserved (identity uses nullish, not truthy `||`).
- **null/undefined/blank translated slot becomes unresolved/error** (normalizes to empty; a block whose text is empty becomes error).
- **Original rendered PDF content remains available.** The source cell text is stored alongside and, when a cell is unresolved, the overlay preserves the original text for display. This is source preservation — the original is never emitted as a *translated* result.
- **Explicit source-equal output is valid** (status set by presence, not by inequality to source).
- **Missing cell keeps position and does not shift later cells.** Position is placed at the local index (write `cells[cellIndex]`); a gap does not slide later cells.
- **A mixed block may contain valid and unresolved cells.** Missing/empty cells become empty holes; the block falls back to source for those cells.
- **Block-level status rules:** block status is per-block scalar — `idle / loading / routed / translated / error`; on empty it is `error`; a run-level summary can be `partial` when `failedCount > 0`.
- **Duplicate cell identity:** within a batch, the last result at the same position overwrites; an identity duplicate produced by the pipeline is suppressed here.
- **No raw fragments in final PDF results.** Only assembled cells are applied; fragments are not concatenated into final results.

Link: [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) for identity precedence (`uid ?? cellId ?? i ?? id ?? blockId`), duplicate and fragment rules.

---

## 12. Subtitle Contract

Modes: `subtitle_translation`.

```text
under-returned result
→ isSkipped
→ original cue preserved
→ failed count increments
```

Additional rules:

- **Blank / whitespace output fails** — treated as missing translation.
- **Explicit source-equal translation remains valid** — never a failure.
- **Cue timing/order is unchanged** — cues keep parse order and serialize them in that order (in-place array order).
- **Failed cues serialize using original text.** Export writes `translatedText` only when present; otherwise the cue's `text`.
- **Mixed batch counts translated and failed accurately** — `validateAndRestore` sets per-cue status; the progress tracker sums `translated`, `failed`, `skipped`.
- **Timeout/cancel does not write late translated text.** Timeout (`Promise.race`) marks the cue failed; late-resolving value ignored. Cancel sets the job status without writing later cue contents.
- **No rollback of already translated independent cues.** Each batch settles independently; a later fatal error keeps earlier committed cues.

---

## 13. Partial Success Contract

Shared example:

```text
A succeeds
B fails
C succeeds
```

Expected behavior by feature:

| Feature | A/B/C result | Revert on later failure | Counts |
| --- | --- | --- | --- |
| Select Element | A, C applied; B original | no | A/C marked accepted, B failed |
| Whole Page | A, C translated; B original | no (completed nodes kept) | translated=2, failed=1 |
| PDF | A, C cells/block accepted; B unresolved | no | translated + failed from block states |
| Subtitle | A, C translated; B failed (original) | no | translated=2, failed=1 |

Required result:

```text
A/C accepted
B original
counts accurate
no global rollback
terminal state reports partial/failure accurately
```

Exceptions:

- **Select Element** supports *explicit* whole-session revert of completed units (manual, not automatic) — distinct from automatic rollback.
- **Whole Page `stopAutoTranslation`** stops producing new translations but leaves committed nodes (no revert) by design.
- **PDF block** is `error` when its text is empty; a run is `partial` only at the run summary level, never a block-level partial.

---

## 14. Timeout and Cancellation

Ownership and distinction:

```text
timeout
→ TRANSLATION_TIMEOUT
→ no late mutation

user cancellation
→ USER_CANCELLED
→ no late mutation
```

- **Terminal request state is immutable.** After a request reaches a terminal state (success / timeout / cancel), a later settlement is ignored (`TranslationRequestTracker`, dispatcher processed-set, handler guards).
- **Abort-related late `USER_CANCELLED` after a timeout is suppressed.** A cancel arriving on an already timed-out request does not override the timeout outcome.
- **Feature UI must not reinterpret timeout as cancellation.** They are distinct typed states; features render them differently (e.g. Popup: timeout → error state, cancel → silent).
- **Previously completed units follow the feature's approved partial-success policy** (unchanged by a later timeout/cancel).

---

## 15. Source Preservation vs Source Fallback

Distinguish:

```text
source preservation
→ feature leaves original presentation unchanged after failure

source fallback
→ original source inserted as translated output
```

```text
source preservation is required
source fallback is prohibited
```

Examples of valid source-equal translations (NOT failures, NOT fallback):

```text
URL → URL
OpenAI → OpenAI
2026 → 2026
```

- Source-equal output is a **valid accepted result**, meaning a consumer must not treat equality as a failure.
- Source-equal is **never** a fallback (the source was not substituted as a success).

---

## 16. Feature Consumer Guarantees

Feature consumers may **assume**:

- typed terminal errors (timeout vs cancel distinct);
- no source-filled invalid result;
- no raw fragments;
- an accepted identity set already deduplicated where the structured handler applies;
- timeout/cancel late settlements are suppressed;
- unresolved object results may carry explicit status metadata such as `isSkipped`.

Feature consumers **must not**:

- infer failure from text equality;
- convert missing results into successful source text;
- apply blank translated output to nonblank text;
- independently retry providers;
- rebuild fragments.

---

## 17. Diagnostics and Progress

- Feature progress counters are **not** actual provider statistics.
- `translated` / `failed` counts describe logical feature units.
- Suppressed duplicates do not count as translated.
- Unresolved subtitle/PDF units count as failed.
- Diagnostics must avoid raw source or translation bodies unless sanitized.

---

## 18. Non-Goals

This document does not define:

- provider implementation;
- API-key failover;
- QueueManager retry policy;
- domain AI recovery;
- conversation lifecycle;
- identity/fragment mechanics;
- canonical `TranslationOutcome` runtime adoption (deferred).

Links:
- [../providers/PROVIDERS.md](../providers/PROVIDERS.md)
- [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md)
- [../architecture/TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md)
- [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md)

---

## 19. Test Map

| Feature | Primary tests | Contract areas covered | Known coverage gaps |
| --- | --- | --- | --- |
| Selection Window | `src/features/windows/managers/translation/TranslationHandler.test.js`, `src/features/windows/managers/WindowsManager.test.js`, `src/utils/rendering/TranslationRenderer.test.js` | result display, error/timeout/cancel display, closed-window late-result drop, renderer error/markdown | no test asserts source-equal result rendered as normal (non-destructive) in the window; source-DOM-untouched is structural (no DOM write APIs), not asserted |
| Inline Selection | `src/features/mouse-hover/HoverTranslationManager.test.js`, `src/apps/content/components/MouseHoverTooltip.test.js`, `src/features/shared/hover-preview/HoverPreviewManager.test.js` | text never replaced, ready-only-on-accepted, mouseleave cancel, stale-request isolation, loading settle, error cleanup | no dedicated test for duplicate/source-equal suppression path asserting the tooltip hides on redundant output |
| Select Element | `src/features/element-selection/core/DomTranslatorAdapter.test.js`, `DomTranslatorState.test.js`, `DomTranslatorStress.test.js`, `BlockGroupReconstructor.test.js`, `SelectElementManager.test.js`, `ElementSelectionFactory.test.js` | per-unit apply, A/B/C partial, fragment suppression, dedup, ESC/cancel, revert, block-group atomicity, direction metadata | none material; most behavioral guarantees are directly asserted |
| Field | `src/features/text-field-interaction/managers/TextFieldIconManager.test.js`, `components/TextFieldIcon.test.js`, `managers/FieldShortcutManager.test.js`, `handlers/TextFieldHandler.test.js`, `TextFieldDetector.test.js` | icon triggers, double-click, shortcut gate, detector classification | **no test file for the replacement `service.js`** (smart-translation apply, cursor preservation, event dedup, stale override). Those guarantees are covered only via the legacy `framework-compat` path, not asserted |
| Whole Page | `src/features/page-translation/PageTranslationScheduler.test.js`, `PageTranslationBridge.test.js`, `PageTranslationManager.test.js`, `PageTranslationFilters.test.js`, `usePageTranslation.test.js`, `PageTranslationHelper.test.js` | batch error→original, mixed skipped results, all-skipped results, identity/source-equal translation, per-batch queueing, cancel, restore, progress counts | blank/duplicate string results may still count as translated; mocks only, no integration against real `domtranslator` walk |
| PDF | `src/features/pdf-translation/core/PdfTranslationAdapter.test.js`, `PdfTranslationCoordinator.test.js`, `PdfTranslationState.test.js`, `src/apps/pdf/presentation/operationResults.test.js`, `presentationPresenter.test.js`, `PdfBlockOverlayItem.test.js` | cell/cellId, mixed block, missing-cell-no-shift, no raw cells, typed timeout/cancel, progress, partial summary | duplicate-cell-identity (last-write-wins) untested for explicit same-`cellId` collisions; numeric `cellId: 0` map-layer validity only, not overlay |
| Subtitle | `src/features/subtitle-translation/core/SubtitleTranslationCoordinator.test.js`, `SubtitleBatchPlanner.test.js`, `SubtitleTextProtector.test.js` | isSkipped→original+failed, blank fails, source-equal valid, mixed counts, timeout/cancel, no rollback | no separate `SubtitleValidationService`/`SubtitleProgressTracker`/`SrtAdapter` test files; those are covered only through the coordinator test |

---

## 20. Current Code Gaps <a name="current-gaps"></a>

Known deviations between this document's stated invariant and current production behavior. These are flagged as gaps, not documented as facts:

- **Whole Page translated counter.** Blank or source-equal string output accepted for a batch item may increment `translatedCount`, even though the DOM keeps the original text. Intended invariant "blank/duplicate results do not increment translated count" is not yet met. Explicit `isSkipped === true` results are excluded from this gap: they increment `failedCount` instead.
- **PDF `cellId: 0`** is valid at the mapping layer (nullish identity), but the overlay mask lookup uses a truthy guard, so string-keyed cells are the practical path.
- **Popup same-language display** writes the source into the result area when languages match. This is an explicit display behavior, not a source fallback on failure, and must not be generalized to other features.
- **Field service-tier guarantees** (cursor preservation, event dedup, stale override) are not directly unit-tested; only the legacy framework-compat path is asserted.

---

## 21. Cross-References

Related contracts and architecture:

- [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md) — identity, duplicates, V2/V3 fragment contract.
- [../architecture/TRANSLATION_SYSTEM.md](../architecture/TRANSLATION_SYSTEM.md) — shared translation pipeline and routing.
- [../providers/PROVIDERS.md](../providers/PROVIDERS.md) — provider implementation (out of scope here).
- [../../adr/ADR-015-translation-outcome-semantics.md](../../adr/ADR-015-translation-outcome-semantics.md) — outcome semantics (runtime adoption deferred).
- [../SUBTITLE_TRANSLATION_SYSTEM.md](../SUBTITLE_TRANSLATION_SYSTEM.md) — subtitle architecture.
- [../WHOLE_PAGE_TRANSLATION.md](../WHOLE_PAGE_TRANSLATION.md) — whole-page architecture.
- [../SELECT_ELEMENT_SYSTEM.md](../SELECT_ELEMENT_SYSTEM.md) — element-selection architecture.
- [../pdf-translator/PDF_TRANSLATION_ARCHITECTURE.md](../pdf-translator/PDF_TRANSLATION_ARCHITECTURE.md) — PDF translation architecture.
- [../architecture/DIAGRAMS.md](../architecture/DIAGRAMS.md) — architecture diagrams of the current runtime.

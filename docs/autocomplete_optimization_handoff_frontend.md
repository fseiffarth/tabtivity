# Autocomplete optimization — frontend handoff

Plan: `docs/autocomplete_optimization_plan.md` (main checkout), steps A1–A10. Commit order: A4, A10,
A3, A2, A1, A7, A5, A6 (two), A8, A9.

This file lives uncommitted in the worktree: the agent's isolation refused a
write to the main checkout. Copy it there when merging.

- Base: `a70bc3e32` (`develop` tip when the worktree was reset)
- Worktree: `.claude/worktrees/agent-aa2984ffc0dc6ae3c`
- Branch: `worktree-agent-aa2984ffc0dc6ae3c` (not pushed, not merged)

## Steps

### A4 — trigger hygiene — `633a60131`

- `autocomplete.ts`: `EditKind` (`insert | delete | accept | external`) and
  `editKind(before, after)` (common prefix/suffix; new text in = insert, even
  over a selection).
- CE: `edit()` records the kind; `acceptSuggestion`/`acceptWord` overwrite it
  with `accept`; the external-change effect (draft changed without `edit()`:
  undo, redo, reload, first load) sets `external`. The idle timer is armed only
  when the last change was `insert`, and checks an IME-composition ref when it
  fires; `compositionend` bumps a counter in the timer's deps so the pause after
  a composition still asks.
- `useTabAiPrefs` memoises `ac`.
- `OllamaCompletionProvider` sends `trigger` (`auto` for the idle timer, else
  `manual`).
- Coordinator addition (user decision): `COPILOT_AUTO_AC_DEBOUNCE_MS` 1200 → 200.
  Copilot's default trigger stays "on request"; the local debounce stays 600 ms.
  No test or frontend comment named 1200 ms besides the constant's own comment.
- Choice: a reload and the initial load count as `external` (no automatic
  request until the user types).
- Tests added (`Autocomplete.test.tsx`): trigger auto/manual; no auto request
  after a deletion (typing asks again); none after Tab accept; none after undo;
  IME composition holds it until `compositionend`; `editKind` unit test;
  `useTabAiPrefs().ac` keeps identity across re-renders.

### A3 — window — `5c7f1142d`

- `completionWindow`: start = 0 up to a 4096-character caret, else
  `ceil((caret − 4096) / 1024) × 1024`, then snapped to the next line boundary
  before the caret (surrogate-safe when there is none). Suffix 2048.
- Choice: on a single line longer than the window, the fallback start is the
  same quantised step (≤ 4096 characters, no split surrogate pair) rather than
  today's sliding `caret − 4096`; it satisfies the plan's stated bounds and
  keeps the start stable on long lines too.
- Tests: the two window tests rewritten (2048 suffix; the emoji slice is now
  3000 emoji); new "two nearby carets share the window start".

### A10 — delay in the menu — `71b512f66`

- `editorPrefs.tsx`: `AC_DELAY_CHOICES` (100/200/400/600/1200),
  `AC_DEFAULT_DELAY_MS` (`ollama` 600, `copilot` 200), `acDelayMs(stored,
  copilot)` (a value outside the choices → default). `EditorAiControls` shows a
  "Delay" `Dropdown` (same `file-viewer-ai-mode` class as the trigger) while the
  effective trigger is Auto; it writes `autocomplete_delay_ms` for the provider
  serving the tab, keeping the other provider's value.
- CE: the two debounce constants are gone; the timer reads `acDelayMs` from the
  settings store.
- `Settings.autocomplete_delay_ms?: { ollama?: number; copilot?: number }`
  in `src/types/index.ts`.
- Tests: stored 100 ms fires within 350 ms; a stored 250 uses 600; `acDelayMs`
  unit cases; the Delay choice writes `{ copilot: 400, ollama: 100 }`; no Delay
  choice while the trigger is On request.

### A2 — references — `1beb53ceb`

- `completionContext.ts`: `AUTO_REFERENCE_BYTES` (4000), `referenceBudget`,
  `trimReferences`, `referenceSetId` (cyrb53 over names + contents),
  `ReferenceReads` (per-editor frozen reads, misses remembered, keyed on file +
  root + import list; `explicit` reads afresh). `completionContext` gains
  `explicit` and `reads`: automatic = manual + TeX keys + imports, explicit adds
  open tabs sorted by path. Cap: 16 files that exist, 64 candidate paths tried.
- `OllamaCompletionProvider`: lookup, gathering and `prepare_text_completion`
  run in `Promise.all`; a reservation that lands after abort/finish/cache hit is
  cancelled. References trimmed to the model's budget (`context_length` from
  `list_ollama_models_detailed`). Cache key uses the set id (and model name +
  insert flag instead of the whole model object). Sends `fileName` (omitted when
  the file is outside the project). Listens to `text-completion-stats-<id>` and
  reports it via `onStats(stats, model)`.
- CE: `acReads`, `acDropsReferences` (model names); `referencesDropped` →
  that model gets no references from this editor.
- Choices: Alt+[/] and Shift+Tab re-requests count as explicit (they are
  `trigger: manual` too) and read afresh. The explicit budget is used as
  computed even when it is below 4 KB (a model loaded with < 5.3 K context).
  A cache hit now costs one reservation + cancel round trip, because the
  reservation starts before the cache is consulted (the plan's parallel start).
- Tests: `CompletionContext.test.ts` (automatic scope/order/4 KB, frozen reads,
  cap counts existing files, budgets, trim + id); `Autocomplete.test.tsx`
  (second automatic request reads no file and sends `fileName`; parallel start;
  `referencesDropped` stops references). The existing explicit-refresh test and
  the cache-revisit test pass unchanged.

### A1 — measurement — `f0f821c85`

- `METRIC`: `AUTOCOMPLETE_SHOWN/TAB/WORD/LINE/TYPED/REJECTED/REQUEST`
  (`autocomplete.shown` … `autocomplete.request`); old ACCEPT/DISMISS kept for
  reading only.
- `completion/completionTimings.ts`: the ring (200, module scope, not
  persisted; `startCompletionTiming`, `completionTimings`,
  `clearCompletionTimings`) and `CompletionOffers`, the per-editor tracker.
- Choices: each take kind counts **at most once per offer** (so `tab + word +
  line + typed` per identity can exceed `shown`, but each is a share of
  offers); `shown` is counted at the first take or at the offer's end if it
  was visible ≥ 750 ms (no timer). A stream's token updates and a partly taken
  ghost are one offer (keyed on the candidate id). An offer ends when the ghost
  is consumed, dismissed, replaced (new request, Alt+[/] on Copilot) or
  invalidated by an edit or an external change. Request outcome `cache` is a
  completion-cache hit; aborted and `copilot_cancelled`/`copilot_stale_document`
  requests count nothing. Copilot's model segment is `copilot`
  (`copilot/copilot`), as the old keys had it.
- CE: `acOffers` replaces `acOutcome`/`recordAcOutcome`; `acAccepting` keeps
  accept keys from booking as typed; `acLastEditAt` feeds the ring's keystroke.
- `StatsRecap`: `autocompleteOffers(counters)` (exported for its test) and one
  Metric row per identity with the new `stats.autocompleteOffers` line, before
  the old history rows.
- `DevPerfHost`: a "Completions" table (newest 12): model, trigger, endpoint
  (+ `−ref` when references were dropped), ms to context-ready / first event /
  done, keystroke→done, prompt tokens, outcome. Reset clears the ring. English
  only, as the rest of the panel.
- Tests: rewritten the two old-key assertions (now `rejected` + `shown` +
  `request.ok/cache` after a skewed 750 ms; and `shown, line, tab` for Alt+Right
  then Tab); added typed-through (one char no accept, three = `typed`), request
  outcomes incl. `ollama/none`, the ring's milestones and stats, and
  `CompletionTimings.test.ts` (tracker with an injected clock, ring cap, recap
  reader).
- No parity test between `usageMetrics.ts` and `schema/usage_stats.rs` exists
  in the tree; none was added (the Rust half is the backend's).

### A7 — keys — `81ca1628d`

- Plain Right: no longer handled while a ghost shows, so it falls to the
  generic arrow branch (dismiss) and the native caret move. Ctrl+Right (no
  other modifier) accepts a word; Alt+Right the line, as before.
- `AC_KEY_LABELS.ctrlRight` (`chordLabel`, reads ⌃→ on macOS); the hint strings
  `fileViewer.autocompleteControls` / `copilotControls` in all five languages
  now say `{ctrlRight}: word` instead of `→: word`.
- Tests: the word-accept test uses Ctrl+Right and checks the hint; new "plain
  Right dismisses the ghost and inserts nothing" (default not prevented).

### A6 — ghost rendering — `d2b30a08b` (frame/scroll/gutter), `8934a0769` (inline ghost, revertable alone)

- First commit: `requestCompletion` wraps the provider's `publish` so a burst
  of stream events renders once per `requestAnimationFrame` with the newest
  text; `settle(result)` after `provider.complete` cancels a pending frame and
  publishes the final answer at once; `settle()` in `finally` drops a pending
  frame on abort/error. Ghost scroll alignment moved to `useLayoutEffect`. The
  line-number gutter cells are a `useMemo` (deps: line count, wrap, line
  heights, breakpoints, match lines, caret line, unclosed lines, breakpoint
  handler, `t`). Tests: the stream test waits a frame; new "a burst of streamed
  tokens renders once, on the next frame; the final text lands at once". The
  gutter memo has no dedicated test (pure render-cost change).
- Second commit: `inlineGhostTail(draft, at, ghost, {highlighted, wrapped})`
  decides; CE renders `pre.file-viewer-ghost.is-inline` (transparent text and
  background) with `span.file-viewer-ghost-cover` (`--bg-panel`, text colour)
  holding the ghost span and the shifted tail; otherwise the unchanged opaque
  projection. The cover holds the background because `.file-viewer-ghost-text`
  has `opacity: 0.85`, which would let the original closers show through.
  Tail rule: spaces, tabs and closers only (stricter than `caretAtLineEnd`'s
  `\s`); a CRLF `\r` stays outside the tail.
- **Plan statement found wrong in effect:** "wrap is off" — all four
  `CodeEditor` hosts (TextView, MarkdownView, TexView ×2) pass `wrap`
  unconditionally, so the inline path is never reached in the app today. Kept
  conservative as instructed; see Flagged.
- Tests: the inline branch through a bare unwrapped `CodeEditor` harness (cover
  text `42)`, whole document in the layer); the real text view (wrapped) keeps
  the opaque projection for a one-line ghost; a multi-line ghost stays opaque;
  `inlineGhostTail` unit cases.

### A5 — model clarity — `e7e02ab36`

- `autocomplete.ts`: `missingRoleModel(loaded, lang, role, proseRole)`,
  `RECOMMENDED_AUTOCOMPLETE_MODEL`, `autocompleteModelAdvice(models, role)`;
  `completionModels.clear()`.
- `useTabAiPrefs().ac.role` = the bare `ollama_roles.autocomplete`.
- Provider: for an automatic request, a role (code role; for prose the prose
  role then the code role) naming models none of which is resident throws
  `role_not_loaded:<model>`. Explicit requests keep today's fallback.
- CE: that error shows the status pill "`<model>` not loaded — [Load]"
  (`.file-viewer-ac-status.has-action` takes pointer events; the button keeps
  the caret by preventing mousedown). Load → `loadOllamaModel`, clears the
  model cache, asks again automatically. The hint pill now starts with the
  model that answered (`fileViewer.autocompleteFrom`), local models only.
- Models hub (overlay page only): a "Fill-in" capability chip on models
  reporting `insert` (both lists, via `CapabilityChips`); a banner (copied from
  the context-too-short notice: `local-model-igpu-notice` + `settings-btn sm`)
  when the role holds a model that reports no `insert`, or no role is set and
  no installed model reports `insert`. Button: "Download qwen2.5-coder:1.5b for
  autocomplete" (`pull_ollama_model`, then `assignRole` once the pull resolved)
  or "Use … for autocomplete" when installed. `useModelsHub` gains
  `assignRole` (set, never toggle, against fresh settings) and `pullIntoRole`.
- Choices: "automatic mode" read as *automatic requests* (an explicit
  Ctrl+Space still falls back and names the model). The pill does not
  auto-dismiss (the 4 s timer is for `acStatus` only); typing hides it, and the
  next pause shows it again. The banner is in the overlay page only, not the
  header hover dropdown. A model with an empty capability list never triggers
  the banner.
- Tests: automatic request with role unloaded → no `complete_text`, pill,
  Load → `load_ollama_model` → request on the role model with `insert: true`,
  pill names it; Ctrl+Space falls back and names `llama3.2:3b`;
  `missingRoleModel` and `autocompleteModelAdvice` unit tests. The hub banner
  and chip are covered only through the pure function (no render test).

### A8 — Copilot in the editor and card — `559971b89`

- Card: signed in only for `account.status` `OK`/`MaybeOK` (user present
  too); `NotAuthorized` gets "Signed in as {user}, but this GitHub account has
  no Copilot access." with Sign out (to switch accounts); a sign-in that rejects
  with `copilot_sign_in_failed` gets "The sign-in did not finish" instead of
  the generic error. A missing/unknown `account.status` reads as not signed in
  (strict reading of the plan).
- Card "Details": the shared `SettingsAdvanced` fold (its classes; unmounted
  while closed, so `copilot_diagnostics` is called only on open and on
  Refresh); lines in `pre.ollama-install-log` (the card's sibling log style);
  shown when provider is Copilot and the project consented. A backend without
  the command → "This build cannot show the server log."
- Editor: after a Copilot request that returned nothing, one
  `copilot_account` call; an outer `status.kind === "Inactive"` message shows
  as "Copilot: {message}" unless a newer request or edit happened. The
  Copilot hint uses `fileViewer.copilotControlsSingle` (no Alt+[/]) unless more
  than one candidate came back.
- Tests: new `src/__tests__/editor/CopilotCard.test.tsx` (verdicts, failed
  sign-in line, Details open/Refresh, missing command); two editor tests
  (single-candidate hint, Inactive status with exactly one account call).

### A9 — stay signed in — `9e5a0bf3e`

- `Settings.copilot_stay_signed_in?: boolean`; a `settings-toggle-card-row`
  Toggle (copied from the consent rows) shown once the server is installed,
  plus one help line. `CopilotAccount.remembered?: boolean`: true → "This
  sign-in is remembered in the OS keychain." replaces
  `settings.copilotSessionOnly`; absent/false keeps the old note.
- Tests (card file): off by default, writes `{ copilot_stay_signed_in: true }`,
  session-only note without `remembered`; `remembered: true` swaps the note.

## Gates

Midway (`--base a70bc3e32`, after A1/A2/A3/A4/A10 work): brand, whitespace,
lint-fe, build, vitest all PASS (Rust gates skipped: no Rust change).
Final (`scripts/gates-job.sh start --base a70bc3e32`, tree at `79407dd9a`):
brand, whitespace, lint-fe, build, vitest (`--changed a70bc3e32`) all PASS;
Rust gates skipped (no Rust change). The first final run failed `npm run
build` on two type errors from earlier steps (optional `wrap` passed as a
boolean in A6; `Array.prototype.at` in two A1 tests, not in the TS lib target);
fixed in `79407dd9a`. So `f0f821c85` and `8934a0769` do not type-check on
their own; the branch tip does.

Changed-set vitest run during A5: 878 files, 8943 tests passed (the gate's
own count is not printed in its summary).

## New i18n keys (all five dictionaries; the parity test requires it)

- `fileViewer.autocompleteDelayTitle`, `fileViewer.autocompleteDelayOption`
- `fileViewer.autocompleteFrom`, `fileViewer.autocompleteRoleNotLoaded`,
  `fileViewer.autocompleteLoadModel`, `fileViewer.autocompleteLoadingModel`,
  `fileViewer.autocompleteLoadFailed`
- `fileViewer.copilotControlsSingle`, `fileViewer.copilotInactive`
- `stats.autocompleteOffers`
- `localModel.insertChip`, `localModel.insertTitle`,
  `localModel.autocompleteNoInsert`, `localModel.autocompleteNoFim`,
  `localModel.autocompleteGet`, `localModel.autocompleteUse`,
  `localModel.autocompleteDownloading`, `localModel.autocompletePullFailed`
- `settings.copilotNotAuthorized`, `settings.copilotSignInFailed`,
  `settings.copilotDetails`, `settings.copilotDetailsEmpty`,
  `settings.copilotDetailsUnavailable`, `settings.copilotDetailsRefresh`
- `settings.copilotStaySignedIn`, `settings.copilotStaySignedInHelp`,
  `settings.copilotRemembered`
- Changed text: `fileViewer.autocompleteControls` / `copilotControls` (`→` →
  `{ctrlRight}`) in all five.

The merge: other sessions hold uncommitted edits to `en.ts` and `untested.ts`
in the main checkout (per the plan); these are pure additions after existing
anchor keys.

## New UntestedTag ids (rows in `src/lib/untested.ts`)

`fileViewer.autocompleteDelay`, `fileViewer.autocompleteRoleNotLoaded`,
`localModel.insertChip`, `localModel.autocompleteAdvice`,
`settings.copilotDetails`, `settings.copilotAccountStatus`,
`settings.copilotStaySignedIn`.

## File-map rows to update (`docs/filemap_frontend.md`)

- 555 `lib/viewers/completion/autocomplete.ts`: + stepped window, `editKind`,
  `missingRoleModel`, `inlineGhostTail`, `autocompleteModelAdvice` /
  `RECOMMENDED_AUTOCOMPLETE_MODEL`, `completionModels.clear()`.
- 556 `completionContext.ts`: + frozen per-editor reads (`ReferenceReads`),
  automatic 4 KB vs explicit budgets (`referenceBudget`), `trimReferences`,
  set id (`referenceSetId`).
- new row `lib/viewers/completion/completionTimings.ts`: the 200-request
  timings ring (dev perf monitor) and `CompletionOffers` (usage keys per offer).
- 559 `ollamaCompletionProvider.ts`: + parallel start, budgets per model,
  stats event (`CompletionStats`), trigger/fileName, role rule for automatic
  requests.
- 370 `CodeEditor.tsx`: + per-frame ghost publish, inline ghost, role-not-loaded
  pill, edit-kind/IME trigger hygiene.
- 372 `editorPrefs.tsx`: + Delay choice (`autocomplete_delay_ms`), memoised `ac`.
- 243/244 `useModelsHub.ts` / `ModelsHubSections.tsx`: + `assignRole`,
  `pullIntoRole`; Fill-in chip, autocomplete-model banner.
- 446 `StatsRecap.tsx`: "accept/dismiss" → offers (shown/Tab/word/line/typed/
  rejected) plus old history.
- 651 `lib/usageMetrics.ts`: + offer and request prefixes.
- `CopilotCompletionCard.tsx` and `dev/DevPerfHost.tsx` have no row; add one
  if wanted (Details fold + stay signed in; completions table).

## Plan statements found wrong

- A6: "wrap is off" as a condition — every `CodeEditor` host (TextView,
  MarkdownView, TexView ×2) passes `wrap` unconditionally, so the inline ghost
  never renders in the app. Implemented as written (conservative).
- A1: "`StatsRecap` … `:494-503`, `:627-635` matches only the two old
  prefixes" — correct. "A parity test between the two passes only on the
  merged tree": there is no such test in the tree today (only a comment in
  `schema/usage_stats.rs`); none was added.
- A2: `completionImports` capped candidate *paths* at 16 (as the plan says);
  now 64 candidates are allowed and 16 *existing files* counted.
- Minor: line anchors had drifted by a few lines (expected).

## Click-through for the user

1. A4: TypeScript file, automatic autocomplete on: type, pause → a ghost.
   Backspace, pause → none. Tab-accept, pause → none. Ctrl+Z, pause → none.
   With an IME, nothing fires until the composition is committed.
2. A10: in the editor's AI controls, with "Auto", a Delay choice
   (100–1200 ms) sits beside it; pick 100 ms → suggestions come sooner in
   every local-model tab; switch the tab to "On request" → the choice hides.
   With Copilot serving and Auto chosen, the default reads 200 ms.
3. A3/A2: type in a long file with imports; the perf monitor (Ctrl+Alt+P) →
   Completions table: after the first automatic request, later ones show a
   short "ctx" time (no reference reads); Ctrl+Space re-reads.
4. A1: perf monitor rows show model, trigger, path (`generate`/`chat` once the
   backend lands), ms columns, prompt tokens, result. Stats recap (day view)
   shows "N shown · Tab … · rejected" per mode/model, old accept/dismiss rows
   still listed below.
5. A7: with a ghost, plain → moves the caret and the ghost goes; Ctrl+→ takes
   one word; Alt+→ a line; the hint reads "Ctrl+→: word".
6. A5: set the autocomplete role to an unloaded model, type and pause → pill
   "<model> not loaded — Load"; Load → it loads, then a ghost from it, the pill
   naming it. Ctrl+Space before loading → a ghost from another resident model,
   named. Models hub: Fill-in chip on FIM models; with a chat-only model in the
   role, the banner offers "Download qwen2.5-coder:1.5b for autocomplete" →
   download shows in Downloads, then the role moves to it.
7. A6: streamed ghosts render smoothly; a multi-line ghost (Shift+Tab to
   Block) lines up when scrolled. The syntax-coloured inline ghost cannot be
   seen yet (all editors soft-wrap; see Flagged).
8. A8: Settings → Experimental → Copilot card: an account without Copilot
   access says so (and offers Sign out); "Details" lists server log lines
   (empty/unavailable text against an old backend); a request that returns
   nothing on an inactive plan shows "Copilot: <server message>" in the editor;
   with a single candidate the hint has no Alt+[/].
9. A9: Copilot card: "Stay signed in (OS keychain)" off by default; on, sign
   in, quit, reopen → the card shows the account and "remembered" without a new
   sign-in (needs B11/B12); sign out → asks again after the next restart.

## Flagged for the user

- **A6 inline ghost is unreachable today.** All editor hosts soft-wrap. To
  make it reachable needs either an unwrapped editor or a reflow check (does
  the caret line plus the ghost still fit its wrapped rows?) that must be judged
  on screen. Product/visual decision; the commit is revertable alone.
- **A5 "automatic mode" read as automatic *requests*.** Ctrl+Space with the
  role model unloaded still falls back to another resident model (named in the
  pill). If you meant "a tab whose trigger is Auto never falls back", that is a
  one-line change in the provider.
- **A5 nagging:** the "not loaded — Load" pill reappears after every typing
  pause until the model is loaded or the role changes.
- **A5 banner** is on the Models & agents overlay page only, not in the header
  hover dropdown.
- **A7 on macOS:** Ctrl+→ (⌃→) is a Mission Control shortcut by default;
  Option+→ might suit macOS better. Not decided here.
- **A2 explicit budget** below 4 KB for a model loaded with a small context
  (< ~5.3 K tokens) is used as computed (smaller than the automatic budget).
- **A2 cost of a cache hit:** the reservation now starts with the lookup, so a
  cache hit costs one `prepare_text_completion` + `cancel_text_completion`.
- **A8:** an account reply without `account.status` reads as not signed in.
- **Recap row** (`stats.autocompleteOffers`) and the Inactive editor status
  carry no `UntestedTag` (plain text lines in existing surfaces).
- `Autocomplete.test.tsx` "automatically includes imports and refreshes
  context…" failed once in a full-file run early on (its last `invoke` was a
  `file_mtime` poll, not `cancel_text_completion`) and passed on every rerun:
  a pre-existing ordering flake, watch it.
- The commit hook prints "MOBILE BUNDLE IS STALE / EMBEDDED PWA IS STALE"; no
  `mobile-web/` file was touched. `backend:stale` not run (no Rust change).
- This handoff could not be written to the main checkout (agent isolation);
  it is untracked in the worktree at the same relative path.

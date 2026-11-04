# Box redesign — handoff

Plan: `docs/box_redesign_plan.md`. One section per agent step; each agent
appends to its own section only (worktree copies are merged by the main agent).

Per section: worktree + branch, commit shas, choices made, gotchas, gate status
with test counts, i18n keys added, `untested.ts` ids, **Flagged for user**.

## Plan review

Reviewer pass 2026-11-03 against the code; changes are in `docs/box_redesign_plan.md`.

**Blocking questions for the user:** none. No Fixed or User decision is unworkable.

Corrections made to the plan:
- i18n: "en.ts only" was wrong (`src/__tests__/shell/i18n.test.ts` needs all five dictionaries, both directions).
- The slice (`boxFilter`) is `useState` in `ProjectSwitcher`, so ✕, `cycleBox` return, palette "Show all projects" and Dissolve-while-inside could not reach it: new `stores/boxSlice.ts` (step 2b).
- `patch_box` already exists with singular `addMember`/`removeMember`; plural fields and `name` are additions. Old-backend fallbacks specified (`saveBox`, `createBoxQuick`).
- Decision 3: there is no Ctrl+T; the real paths (+ button, Ctrl+Shift+N/M, Ctrl+1-9, steering, popout, empty group) all meet in the group's `TabBar`; `CenterPanel.newTabCwd` is per scope and cannot carry it.
- Wrong paths fixed (`ProjectSearch.tsx` is in `components/projects/`, `agentMenuEntries.ts` in `components/tabs/`, `featureHints.ts` in `lib/shortcuts/`, `headerPins.ts` in `lib/`). Agent steps split: AS2 -> 2a/2b, AS3 -> 3a/3b, AS4 -> 4a/4b, AS5 -> 5a/5b; file overlaps named.

Non-blocking choices I made (override freely):
- Member chip shows only on shell, agent, `files` and `projectfiles` tabs, not on viewers or monitors.
- Remote members' tabs (cwd = local copy) get no chip in v1; `memberOfCwd` shares `boxMembersOfScope`'s directory table.
- Persisted accordion state is `localStorage` (per-viewer, try/catch), keyed by box id, not a JSON file.
- Local Model, API-key and cloud rows follow the header target only; they get no "Start in" fly-out.
- Non-new-tab kinds (Monitor, Disk usage, ...) keep the box folder as cwd so "already open" matching does not split per member.
- Name rules apply only when the name changes, so legacy empty/duplicate names never block a colour or member save.
- `memberIds` on `create_box` drops reserved scope ids via `is_reserved_scope`.
- Popout strips share one `TabMemberChip` with the main strip; the popout's member list is its one-time seed, so a member added later shows no chip there until a reseed.
- Dirty dots: no probe and no dot for remote members (omit, not zero).

## AS1 Groundwork

Worktree `.claude/worktrees/box-as1`, branch `box/as1` (cut from develop `48f4b5b9`). One commit: **`b4a318ac`** (24 files).

### API for the later steps

Backend (`src-tauri/src/commands/boxes.rs`; `box_store.rs` untouched):
- `clean_box_name(name, &BoxesList, own_id) -> Result<String,String>`: trim, non-empty, <= `MAX_BOX_NAME_CHARS` (80, characters), no control chars, unique case-insensitively against the other boxes (trimmed). Runs in `create_box`, `rename_box`, `patch_box` and only when the name differs from the stored one (raw compare), so legacy empty/duplicate names never block an unrelated save.
- `create_box(name, memberIds?, color?)`; members ordered, deduped, blanks and `is_reserved_scope` ids dropped; colour via the shared `clean_box_color` (also used by the colour patch).
- `BoxPatch { name, addMembers, removeMembers }` beside the singular fields (`deny_unknown_fields` kept). Order: adds (singular + plural), then removals, so an id in both ends out. Singular `addMember` now also drops reserved ids. Name + members = one `write_boxes_stamped`, `rev` moves once.
- `create_box_at` / `rename_box_at` / `patch_box_at(path, ..)` hold the file lock for the whole read-modify-write (create and rename used to read and write under separate locks).
- No new command, no `command_class` row; `commandClasses.ts` unchanged (generated-file test passes).

Frontend:
- `src/stores/boxes.ts`: `boxNameProblem(name, boxes, ownId?) -> "empty"|"tooLong"|"invalid"|"taken"|null`; `BoxNameError{problem}`; `MAX_BOX_NAME_CHARS`; `defaultBoxName(boxes, label:(n)=>string)` (first free "Box N", from 1); store actions `createBoxQuick({name, memberIds?, color?}) -> ProjectBox`, `saveBox(boxId, {name?, addMembers?, removeMembers?}) -> ProjectBox` (throws on failure, `BoxNameError` for a refused name; empty diff sends nothing; returns the file's box and refreshes agent docs), `diffBoxMembers(loaded, draft) -> {addMembers, removeMembers}`; pure `memberOfCwd(cwd, members, boxFolder?)`, `memberOfCwdInScope(cwd, scope, boxes, projects)`, `newTabTarget(scope, activeTabCwd, boxes, projects) -> {cwd, member}|null` (null outside a box scope), `scopeDisplayName(scope, projects, boxes, t)` (root = `palette.scope.root`; null for assistant/unknown), type `BoxMemberDir`.
- `src/lib/theme/boxColor.ts`: `memberColor(projectId)` (= `autoBoxColor`).
- `src/stores/boxEditor.ts`: `renamingId`, `startRename(id)`, `stopRename()` (independent of `open`/`close`).
- `src/stores/boxSlice.ts`: `useBoxSliceStore` with `sliceBoxId`, `lastUnslicedScope`, `selectBox(id|null)` (async: slice + `openBox`, or hand the scope back via `setActive`), `leaveBox()` (= `selectBox(null)`; call it first when dissolving the box you are in), plus the switcher's effect primitives `setSlice`, `followScope`, `dropIfGone`, `noteScope`; `resetBoxSlice()` for tests.
- `src/components/projects/useQuickCreateBox.ts`: `useQuickCreateBox() -> { quickCreateBox(memberIds?) -> Promise<ProjectBox|null>, dialogs }` (render `dialogs` once; prompt prefilled "Box N", validated, failed write keeps the prompt open, clears the pill selection, enters the box via `selectBox`). Also `useBoxNameCheck() -> { check(name, ownId?) -> string|null, text(problem), messageOf(error) }` (for inline rename / the sheet) and `useDefaultBoxName()`.

### Choices I made (override freely)
- `memberOfCwd` takes the member table plus an optional `boxFolder` that competes as a root (longest wins, ties to the box), so a member project that is an ancestor of the box folder does not claim the folder.
- Old-backend detection for `saveBox` is `/unknown field/i` on the refusal text; fallback order is rename, then singular adds, then singular removes. `createBoxQuick` tops up with singular `patch_box` adds and a colour patch when the answer lacks them; a refused top-up toasts (`switchToast`) and returns the box as it is.
- `saveBox` and `createBoxQuick` pre-validate the name in the frontend always (not only on the fallback), so the message is localized by the UI instead of the backend's English text.
- `boxProjects`'s new-box path now uses `createBoxQuick` (one `create_box`, no `set_box_members`); its append path is unchanged.
- Uniqueness broke two callers, so I touched them minimally: Alt-drag (`ProjectSwitcher.groupProjects`) now names the box `defaultBoxName` ("Box N") instead of "New Box"; `BoxEditorDialog` create mode defaults to "Box N" and shows a toast on a failed save (it swallowed errors silently). `boxEditor.defaultName` was removed from all five dictionaries (last use gone). `projectSwitcher.newBox` (menu row label) stays.
- `BoxScopeChip` still keeps its own `renamingId` state; AS2a/AS5a should switch it to the store field.
- `lastUnslicedScope` now survives a `ProjectSwitcher` remount (store, not a ref). Tests that render the switcher must call `resetBoxSlice()` in `beforeEach` (done in BoxRendering, BoxUx, BoxMembershipControls, BoxSearch; later steps' tests too, or the slice leaks between tests).
- `BoxEditorDialog` still saves with `renameBox` + `setBoxMembers`; AS5b swaps it to `saveBox` + `diffBoxMembers`.

### Gotchas
- Name checks must only run on a changed name; the sheet must compare against the stored name before calling `check`, or a legacy duplicate blocks every save.
- `quickCreateBox` resolves after `selectBox` started `openBox` (it awaits it); `openBox` is mocked in the hook test.
- The first `npm test` run showed one failure; the rerun was fully green (10297), so treat it as a load flake (not identified).
- `cargo test -p tabtivity --no-default-features --lib` failed once on `sysstat::tests::relaxed_lookup_reuses_an_entry_the_default_would_recompute` (unrelated, load-sensitive); it passes alone (41/41 sysstat tests) and `--test server_secrets` passes.

### Gates (in the worktree, `scripts/gates.sh`)
brand, `git diff --check`, `npm run lint`, clippy (tabtivity+app-serverd, dlib, daemon) at zero warnings, `npm run build`, vitest `--changed`, `cargo test -p tabtivity -p app-serverd` (incl. generated `commandClasses.ts` test, no diff): PASS. Full `npm test`: 1026 files, **10297 tests passed** (+4 new files: BoxQuickCreate, MemberOfCwd, BoxSlice, UseQuickCreateBox = 38 tests; boxes cargo module 41 tests incl. 8 new). Dlib lib tests: 4863 passed, 1 unrelated flake (above), rerun green.

### i18n keys added (all five dictionaries, after `boxPill.deleteBox`)
`boxName.default` ("Box {n}"), `boxName.empty`, `boxName.tooLong` ({max}), `boxName.invalid`, `boxName.taken`, `boxName.promptTitle`, `boxName.promptLabel`, `boxName.promptConfirm`, `boxName.promptMembers` ({names}). Removed: `boxEditor.defaultName`.

### untested.ts / filemap
No `untested.ts` rows: AS1 adds no visible surface (the prompt has no tag slot; the first door that uses it, AS5a, tags itself). Filemap: frontend rows for `projects/useQuickCreateBox.ts`, `stores/boxes.ts (box helpers)`, `stores/boxSlice.ts`; backend `boxes.rs` row extended.

### Run `backend:stale`
Backend changed (`create_box` args, `BoxPatch`): the main agent reports `npm run backend:stale`. Until the running window restarts, the fallbacks above apply.

### Flagged for user
- Box names are now unique case-insensitively on every new write: a second Alt-drag or an "New box" typed twice is refused/auto-numbered ("Box N") instead of creating a twin "New Box".
- The Alt-drag default name changed from "New Box" to "Box N".
- No Fixed or User decision was undone.

### AS1 review

Reviewer pass 2026-11-03 on `b4a318ac` (worktree `box-as1`).

**Checked, found sound:** lock held across read-modify-write in `create_box_at`/`rename_box_at`/`patch_box_at` (rename now goes through `patch_box_at`); `rev` moves once per patch (stamped against the file's copy); legacy empty and duplicate names stay readable and saveable (name rules only on a changed name; whole-list `save_boxes` does not validate); no schema change, so Python-era shapes round-trip; `deny_unknown_fields` unchanged, so an old frontend's calls still deserialize; `is_reserved_scope` drops reserved ids in `create_box(memberIds)`, `addMembers` and the singular `addMember`; `clean_box_name` counts characters (not bytes), rejects `Cc` controls like the frontend's `\p{Cc}`, and Rust/JS lower-casing agree (final sigma, dotted I); `saveBox` sends a diff (adds/removes), and the old-backend fallback uses rename + singular patches, never a whole-list write, so a concurrently added member survives both paths; `boxSlice` effects (`followScope`, `dropIfGone`, `noteScope`) keep the old order and conditions, `selectBox(null)` reads the same scope/projects as before; `memberOfCwd` is path-component based via `isPathWithin` (trailing slash, Windows case/separators, nested member, member above or inside the box folder all behave); i18n parity (all five dictionaries, same placeholders, `boxEditor.defaultName` gone from all).

**Fixed (`5b631104`):** the new backend name rule made three callers fail silently. The pill's inline rename (`onRename` -> `void renameBox(..)`), the Alt-drag grouping (`groupProjects`) and a failed box entry after quick-create all let a refusal (taken, empty, too long) become an unhandled rejection with no message. `renameBox` now pre-validates a changed name (`BoxNameError`, no invoke), `ProjectSwitcher` toasts the localized reason for rename and Alt-drag, `useQuickCreateBox` toasts a failed `selectBox` and still resolves to the created box. Regression tests (each fails without the fix): `BoxQuickCreate` (renameBox), `BoxRendering` (Alt-drop refused), `UseQuickCreateBox` (enter fails). Also re-indented a mis-indented `membership` line in `ProjectSwitcher`.

**Flagged for user (not changed):**
- Names: only `Cc` control characters are refused. Format characters (zero-width space U+200B, bidi override U+202E) pass, so a name of only those looks empty, and NFC/NFD spellings of one name count as two. Unicode normalisation and `Cf` stripping would be a rule change.
- `saveBox` fallback (older backend only): if the rename succeeds and a later singular patch fails, the error is thrown but the store keeps the pre-save copy until the next `load`.
- `lastUnslicedScope` and the slice now survive a `ProjectSwitcher` remount (store, not `useState`/ref); before, a remount reset the slice unless the scope was a box. Harmless unless the switcher is conditionally mounted somewhere; AS2a should check when it touches `HeaderBar`.
- `memberOfCwd` ranks roots by raw string length; only pathological (multi-slash) spellings could mis-rank two nested roots. `resolveProjectDirectory` output is not normalised.
- Old backend + `createBoxQuick`: a reserved id in `memberIds` would be added by the singular top-up (a new backend drops it). Callers pass real project ids.
- `BoxEditorDialog` still saves the whole member list (`set_box_members`); the known data-loss path stays until AS5b.
- Store pre-validation uses the window's copy of `boxes`; the backend's check against the file is authoritative.

**Gates (worktree, `scripts/gates.sh --base 48f4b5b9`, the whole branch):** `scripts/gates.sh --base 48f4b5b9` (branch `box/as1` at `5b631104`; machine load 50-120 from other agents): brand, whitespace, `npm run lint`, clippy (tabtivity+app-serverd, dlib, daemon, zero warnings), `npm run build`: PASS. Remaining gates run by hand: `cargo test -p tabtivity -p app-serverd`: PASS (5024 lib + 143 + 36 + 1 integration tests, generated `commandClasses.ts` test included, no diff). Dlib `cargo test -p tabtivity --no-default-features --lib --test server_secrets`: 4863 passed, 1 failed (`mobile_control::host::tests::an_apply_submit_answers_an_undo_the_phone_can_settle_preview_and_run`, untouched by this branch; passes alone, 1/1). Full `npm test`: 1026 files, 10301 tests; under load 10 failed (Autocomplete, BibCards, YamlViewer import timeouts, DeckAutosave, PromptChart, MobileTerminalXtermGround, TypeCheckGate, ReaderVoice, TerminalAiSwitch, odtArchive; plus PdfZoomRaster in the `--changed` run), all unrelated to boxes and all green when rerun in isolation (DeckAutosave/BibCards/PdfZoomRaster rerun alone: 17/17 and 5/5). New tests in this review: 3 (BoxQuickCreate +2, BoxRendering +1, UseQuickCreateBox +1 = 4 cases). So the suite is 10301 tests vs the implementer's 10297 + 4. The `--changed` vitest run itself: 7222 tests selected; not rerun whole after the flake because the isolated reruns and the full run cover every file.

## AS2 Header access

### AS2a

Worktree `.claude/worktrees/box-as2`, branch `box/as2` (cut from `b4a318ac`). One commit: **`f2c68837`** (15 files, frontend only; no backend, no `backend:stale`).

**What landed**
- `BoxScopeChip.tsx` (pill row and caret only; the context-menu block is untouched): always-visible `.box-pill-leave` ✕ on the selected pill (`onLeave` prop = `boxSlice.leaveBox`, passed by `ProjectSwitcher`); `boxPillsShown(ordered, selectedId, budget)` (exported, pure) replaces the inline `shown` logic; fold pill `.box-fold-pill` (`▣▾ +N`, last child of `.box-pill-row`, bare `N` when no pill is shown) replaces the `+N` beside the logo; `GhostBoxPill` (own component so the `useQuickCreateBox` prompt mounts only while it shows) when `boxes.length === 0`; menu rows get `is-slice` (bold) and `is-scope` + `CheckIcon` (✓), keeping `is-current` on the slice row; caret and fold pill open on hover/focus, a click **pins** the list (a hover-opened list is kept by a click, a second click or Escape/outside press/pick closes it).
- `ProjectSwitcher.tsx`: new `widthTier` prop (default 0) forwarded to the chip, `onLeave={leaveBox}`, and the strip region gets `is-sliced` + inline `--slice-color` while `currentBox` is set.
- `HeaderBar.tsx` passes `widthTier`; `lib/headerPins.ts` gains `HeaderWidthTier` and `boxPillBudget(tier)` (6,6,3,1). `MAX_BOX_PILLS` stays exported (= `boxPillBudget(0)`).
- `projects-tabs.css` (box-chip/pill-row block only): `.box-pill-leave`, `.project-pills-region.is-sliced` (9% background wash + 2px inset bottom line, static, no transition), `.box-fold-pill`, `.box-ghost-pill`, label caps `.app-header[data-width-tier="2"|"3"]` (96/80 px), `.is-slice`, `.box-chip-menu-scope`. No animation or blurred shadow was added, so `[data-software-paint]` needs nothing.

**Choices (override freely)**
- Tier 3 with no box selected shows **no** pill (budget 1 = "the selected box alone", as in the access doc's mockup); the fold pill carries all boxes as a bare count. Tier 2 = 3 pills incl. the selected one.
- The user's "hide pill" checkbox still applies first; the selected box always keeps its pill (unchanged rule).
- The mockup's "check = box scope" clashed with the existing left checkbox (= shown on the row). I kept that checkbox and added the ✓ as a separate trailing mark on the row; bold = slice.
- Click-pins-the-list is my reading of "opens on click as well as on hover": the click already opened it, but it evaporated with the hover grace.
- The rename state moved to `boxEditor.renamingId`: the chip keeps local wrappers named `setRenamingId`/`setRenameValue`, so the context-menu block (AS5a) is textually unchanged; an effect seeds `renameValue` from the box whichever door started the rename.
- Tint is on the `.project-pills-region` (chip, pill row and member strip), not a line, to avoid guessing the header height.

**Gotchas**
- Tests rendering the switcher must also close the shared header hover menu in `beforeEach` (`useHeaderHoverMenuStore.getState().close("box-scope-chip")`); the open id survives unmount and opens the next test's menu (added in `BoxRendering`).
- `.box-chip:not(.box-scope-pill)` also matches the fold and ghost pills; the logo's "grabbing" rule excludes `.box-ghost-pill`. Test helper `chip()` still gets the logo chip first.
- `commitRename` in the chip still does not run `useBoxNameCheck` (a refused name is silent): AS5a's "Alt-drag lands in inline rename" should validate there.
- `ProjectPill.tsx` swatch click (AS2b) is untouched.

**Gates** (worktree, `scripts/gates.sh`, machine at load ~90): brand, whitespace, lint (0 errors, 29 warnings, same as before, none in touched files), build PASS. Rust gates skipped (no Rust change). `vitest --changed` ran 744 files / 7158 tests: 10 failed by 20 s timeouts under load (AgentTabRename, MobileChatSentIndex, MobileOutboxDeleteAll, MobileTerminalWorktree, MachineToProject, RemoteSavedCredentials, DesktopMenus, UntestedRegistry); all 8 files re-run alone: 31/31 pass. New/extended: `BoxRendering` 44 tests (+12 new, 2 updated), `BoxUx` 21 (+2), `HeaderWidthTier` (+6: `boxPillBudget`, `boxPillsShown`). `i18n` and `UntestedRegistry` pass. `git diff --check` clean.

**i18n keys** (all five dictionaries, after `boxChip.hidePillTitle`): `boxChip.leaveTitle` ({name}), `boxChip.newBoxPill`, `boxChip.newBoxPillTitle`, `boxChip.rowScope` ({members}), `boxChip.rowSlice` ({members}). Reworded: `boxChip.pickerTitle` ("click or hover"). Reused: `boxChip.moreBoxes`, `boxChip.moreBoxesTitle`.

**untested ids** (`src/lib/untested.ts`, after `boxChip.onRowLabel`): `boxChip.leaveBox` (✕ + strip tint), `boxChip.marks` (✓/bold + click-pin), `boxChip.foldPill` (budget + fold pill), `boxChip.newBoxPill` (ghost pill).

**Filemap rows touched** (`docs/filemap_frontend.md`): `HeaderBar.tsx`, `ProjectSwitcher.tsx`, `projects/BoxScopeChip.tsx`, `lib/headerPins.ts`.

**Flagged for user**
- Tier 3 with no selected box shows no box pill at all (only the fold count).
- A click on the caret/fold pill now keeps the list open until a second click, Escape, a pick or a press elsewhere.
- Nothing live-verified; the CSS (tint, ✕ size, ghost pill look) in particular needs eyes on it, including the CPU paint path.
- No Fixed or User decision was undone.

### AS2b

Worktree `.claude/worktrees/box-as2`, branch `box/as2` (on top of `f2c68837`). Commit: **`44505ad0`** (frontend only; no backend, no `backend:stale`).

**What landed**
- `stores/boxSlice.ts`: new pure `stripProjects(projects, box|null, scope)` = the pills the strip shows (unsliced: active projects; sliced: the box's members of any status plus the project in scope), pill order. `ProjectSwitcher`'s `visibleProjects` now calls it, so the strip, the ring and the badges share one list.
- `keyboardSteering.projectStations()` = `[null, ...stripProjects(...)]` using `sliceBoxId`, the boxes and the tab scope. `cycleProject`, the steering digits and `statusJump` all follow it. `stationById` (the badges) moved below `visibleProjects` in `ProjectSwitcher` and keys off it.
- `cycleProject`: when the current project is not in the ring (you are on the box's own scope, nothing in the slice is current) the first step lands on the first / last visible pill instead of the root.
- `useKeyboard.cycleBox`: ring `[home, box1 ... boxN]`. Past the last box (or back from the first) it calls `boxSlice.leaveBox()` (unslices and, from a box scope, hands the scope back to `lastUnslicedScope`); from home the step goes to the first / last box via `openBox` as before. "Inside box X" = scope `box:X`, or the slice's box while you visit a member, so the chord keeps its place in the ring. A ring of one box is now box <-> home (it used to be a no-op).
- `ProjectPill.tsx` (swatch span only, plus one separate portal): `.project-pill-boxdot` is `role="button"`, `stopPropagation` on pointer-down (no pill drag) and click (no activation). One box: `boxSlice.selectBox(id)` (slice + `openBox`). Several: a `ContextMenuPortal` (`context-menu project-pill-box-menu`, shared scheme, `keepBelow`) anchored under the swatches, one row per box with its swatch. The pill's own context menus are untouched.
- CSS (`projects-tabs.css`, box-swatch block): `.project-pill-boxdot.is-link` pads the hit area to 16x17 px and cancels it with a negative margin (no layout shift); hover wash; no animation/shadow, so `[data-software-paint]` needs nothing.

**Choices (override freely)**
- The swatch container is the click target (not each swatch): spec says "a small menu when in several", so a click never picks a box blindly. Inside a slice the pill wears one swatch (the sliced box); a click re-opens that box (scope moves to the box).
- Not keyboard-focusable (`role="button"` without `tabIndex`): it sits inside the pill's `<button>`; the keyboard doors are `cycleBox` and the palette/search steps.
- The return stop "project you came from" = `lastUnslicedScope` (already how the ✕ / "All projects" works). Visiting a member inside the slice and pressing the chord past the last box only clears the slice (the scope is already a project) - `selectBox(null)`'s existing rule.
- `statusJump` also reads `projectStations`, so its walk order puts projects hidden by a slice into the "rest" group (sorted by name); no tab is dropped.
- One untested id for both chords: the two `shortcut.cycleBox*` rows are replaced by `boxCycle.returnStop` (both shortcut defs point at it; the settings row shows one pill).

**Gotchas**
- `projectStations` now imports `boxSlice`/`boxes`/`tabs` stores; no import cycle (checked by the test run). Tests that set `sliceBoxId` must reset it (`resetBoxSlice()`), as `BoxCycle`, `KeyboardSteering`, `KeyboardNavDom` and `BoxRendering` now do.
- `BoxCycle`'s old "ring of one in scope does nothing" test is replaced (it now returns home).
- `Array.prototype.at` is not in the tsc lib: use `arr[arr.length - 1]` in tests.

**Gates** (worktree; `scripts/gates.sh` itself was too slow at load ~100-120: its `brand-check` step alone ran > 10 min, so I ran its gates by hand in parallel): `scripts/brand-check.sh` PASS, `git diff --check` clean, `npm run build` PASS, `npm run lint` 0 errors / 29 warnings (same as AS2a, none in touched files), full `npm test`: **1026 files, 10334 tests, 10321 passed, 13 failed in 8 files (load timeouts, none in boxes/keyboard); rerun alone: DeckAutosave, MobileTerminalXtermGround, PdfZoomRaster, TypeCheckGate, odtArchive pass; `CursorPacks` was a REAL failure from my first CSS (`cursor: pointer`; `[role=button]` already gets it from reset.css), fixed and passing; `BibCards` and `TexCommandOccurrences` fail only when run together under load and pass alone (5/5), 5 of the 13 failures; after the CSS fix `BoxRendering`/`BoxCycle`/`i18n`/`UntestedRegistry`/`BibCards` rerun green: 88/88**. New/extended: `BoxCycle` 9 tests (+5), `KeyboardSteering` 6 (+4), `KeyboardNavDom` +2, `BoxRendering` 49 (+5). Cargo gates skipped (no Rust change). `UntestedRegistry` and `i18n` pass.

**i18n keys** (all five, after `pill.inBoxes`): `pill.openBoxTitle` ({list}), `pill.openBoxesTitle` ({list}), `pill.openBoxHeading`.
**untested.ts**: `boxCycle.returnStop` (replaces `shortcut.cycleBox` and `shortcut.cycleBoxBack`; wears the shortcut settings row pill), `projectPill.boxSwatch` (pill in the several-boxes menu heading; the single-box click has no pill spot).
**Filemap**: rows `projects/ProjectPill.tsx`, `stores/boxSlice.ts` extended.

**Flagged for user**
- Nothing seen live; the 16 px hit area, the hover wash and the menu placement need eyes on them.
- `cycleBox` on a ring of one box no longer does nothing: box and home alternate. Pressing it on the last box also unslices and moves the scope.
- The slice-aware ring means `Shift+Ctrl+Tab` and the steering digits skip projects outside the box while a slice is selected (digits still number only the visible pills).
- I replaced the untested rows `shortcut.cycleBox` / `shortcut.cycleBoxBack` (neither stamped tested) with one row; say if you want the old ids back.
- No Fixed or User decision was undone.

## AS3 Tabs + "+" menu

### AS3a Tab member chip

Worktree `.claude/worktrees/box-as3a`, branch `box/as3a` (cut from `b4a318ac`). One commit: **`6fcb4a9c`** (13 files).

**What landed**
- New `src/components/tabs/TabMemberChip.tsx`: pure `memberTableOf(scope, boxes, projects) -> MemberTable|null` (`{box, members, boxFolder}`), `tabMemberInfo(tab, table) -> {kind:"member"|"box", name, color, id?}|null`, `labelNamesMember(label, name)`, hook `useScopeMemberTable(scope)` (stores; no subscription cost outside a box), component `TabMemberChip({info, label})`, `tabMemberTitle(info, t)`, `NARROW_BAR_PX = 520`.
- Main strip: `TabItem` (TabBar.tsx) calls `useScopeMemberTable(scope)` itself and renders the chip after the label (hidden while renaming); fast-mode tooltip gains the member line. No bar-level change, no new `TabItem` prop.
- Popout strip (`DetachedCenterPanel.tsx`): `memberTable` `useMemo` from the seed (`remoteInfo.box` + `boxMembers`), chip after the label, `memberTable` passed to its `TabHoverCard`.
- `TabHoverCard`: new optional `memberTable` prop (popout passes its seed; main window leaves it out and the card reads the stores), new "member" row (dot or square + name) with the `UntestedTag`.
- CSS in the `.tab` block of `projects-tabs.css` (`.tab-member-chip/-mark/-name`, `.tab-bar[data-narrow-chips] .tab-member-name`, `.tab-popup-member`): dot is `border-radius:50%`, box is `2px`; no shadow, no animation.

**Choices (override freely)**
- Label suffix removal (" — name") is AS3b's (plan step 11), not done here. Until it lands, new box tabs still carry the suffix and the chip shows dot only for them (legacy-label rule).
- Chip kinds: `shell`, `agent`, `local_agent`, `files`, `projectfiles` (local_agent added to the plan's list: it is an agent). Viewers, monitors etc. get none.
- A cwd under neither a member nor the box folder gets **no chip** (the plan's "anything else is whole box" would claim a tab for the box that may belong to a remote member without a local copy). While the box has no folder yet, every other cwd reads as the whole box. `memberOfCwd` itself is unchanged.
- "Narrow" = the tab BAR (not the tab) is under 520 px. Tabs never shrink (`flex-shrink:0`), so a per-tab width cannot be narrow; and "strip overflows" would oscillate (hiding names un-overflows it). One shared `ResizeObserver` per `.tab-bar` (ref-counted, set up by the chips) toggles `data-narrow-chips` on the bar element directly: no React state, no re-render, no edit to either bar. Container queries are not used anywhere in the app, so I avoided them.
- Legacy-label rule: chip text is suppressed when the label contains the name as a whole word (unicode-aware, case-insensitive): "Claude — api" yes, "rapid" no. A rename that drops the name brings the text back.
- Chip text ellipsised at `10ch`. Hover card label is lowercase "member" like its siblings ("session", "activity").
- `UntestedTag` sits in the hover card's member row (the strip chip is too small for a pill).
- The hover card's extra "Can also write: paper, box" line from the workspace mockup is not done (not in the AS3a scope list).

**Gotchas**
- Do not put a derived object in `TabHoverCard`'s layout-effect deps (loop): it depends on `memberInfo?.kind/name`.
- Popout member list is its one-time seed; a member added later shows no chip there until a reseed (as planned).
- Tests: `t()` returns the real English in vitest, not the key.
- Merge: AS3b also edits `TabBar.tsx` (add-menu code) and `DetachedCenterPanel.tsx` (add-menu block); my hunks are the import line, `fastModeTitle`, the `TabItem` body (memberInfo + chip + title), and in the popout the import, the `memberTable` memo after `computeHosts`, the chip after the `tab-label` span and one prop on `TabHoverCard`.

**Gates** (worktree): brand, whitespace, lint, build PASS via `scripts/gates.sh`. Its `vitest --changed` run (756 files) had 3 load timeouts (`MobileAntigravityModel`, 2x `BibCards`, 20 s) that pass alone; full `npm test` afterwards: **1027 files, 10317 tests passed** (AS1 10297 + 20 new in `src/__tests__/tabs/TabMemberChip.test.tsx`: derivation, kinds, legacy/renamed labels, chip markup, main strip, narrow attribute, popout from the seed, hover row). No Rust change. Cargo gates skipped (no Rust change).

**i18n keys** (all five, after `tabHoverCard.provider.openai`): `tabHoverCard.memberLabel`, `tabMember.wholeBox` ("Whole box — {name}").
**untested.ts**: `tabHoverCard.memberLabel` (area `tabs`).
**Filemap**: frontend row `tabs/TabMemberChip.tsx` (after `TabMarkMenuItems`).

**Flagged for user**
- No dot-only/narrow behaviour or popout chip was seen live; threshold 520 px is a guess to tune.
- Tabs outside every member and the box folder show no chip (see Choices).

### AS3b "+" menu + new-tab target

Worktree `.claude/worktrees/box-as3b`, branch `box/as3b` (cut from `6fcb4a9c`). One commit: **`9d7b62ba`** (22 files, frontend only).

**What landed**
- New `components/tabs/startIn.ts`: `openInMember({kind, member, item, table, launchCwd, t, viaRow, add, addUnique})` is the one helper; `startInSpec`, `startInFlyout` (the ▾ entries, `searchable` full labels "Claude in api" / "Claude in the whole box"), `targetHeading`, `FILES_ITEM`. Hosts supply how a tab lands: `TabBar` (`focusGroup` + `addTab`/`ensureTab`), `NewTabMenu` (`pickStatic`/`pickFixed`).
- `AddTabMenuList`: `AddMenuEntry.searchable` (a `machineEntries` entry that is also a flat search result, matched on its full label; remote machine names are not searchable, so remote behaviour is unchanged), new `heading` prop (`AddMenuHeading`: the pinned `.tab-new-menu-target` line with a dot or square mark). CSS block `.tab-new-menu-target` in `projects-tabs.css` after `.tab-add-menu > .tab-new-menu-search`.
- `agentMenuEntries`: new `startIn(what, item)` option, used instead of `machines` (a box has none).
- `useAddTabMenuData`: `boxMembers` replaced by `memberTable: MemberTable | null`; option `seed: {box, members}` for a popout (inert stores).
- `TabBar`: `boxTarget = newTabTarget(scope, activeTabCwd, boxes, projects)` (this group's active tab), `launchCwd = boxTarget?.cwd || projectCwd`. `launchCwd` feeds `handleAdd` (agents, shell, API-key rows, file dedupe), the worktree picker (so it follows the member's repo; the session is named after the member/box), Local Model and local-driver launches. `projectCwd` (box folder) stays for Monitor, Disk usage, Network, Printing, Prompt chart, Skills, Browser, Projects 3D. The three `handleAddBoxMember*` handlers and the "Box members" group are deleted. Chords, steering and the empty group need no code: they all reach this bar's `handleAdd`.
- Popout: `stores/detached.ts` `detachedNewTabTarget` (+ `detachedNewTabCwd` now member-aware); `DetachedCenterPanel` add-menu block only (passes `target`, `boxSeed`; no change to AS3a's strip code); `NewTabMenu` props `target`, `boxSeed`, fixed kinds use `memberTable.boxFolder`; its old member group is gone (popout now has the agent fly-out too).

**Choices (override freely)**
- A plain Files click in a box with a member target opens that member's `projectfiles` tab (one per folder, `ensureTab`); with the box as target, the plain `files` tab. Falls back to the old path when the target has no folder.
- Fly-out pick for the folder the plain row already targets goes through the row (keeps the worktree choice); another folder builds the spec directly (no worktree question).
- Whole-box entry only when the box has a folder; no fly-out when there is only one place to go.
- Skills and Browser tabs keep the box folder too (the plan names neither; neither is a launch directory).
- Popout with a box that has no folder: fixed kinds fall back to the member dir (no box folder to keep).
- Entries show the full label inside the fly-out under a "Start Claude in…" heading (redundant, but exactly what search needs).
- The fly-out opens on hover like the machine list (existing mechanism).

**Gotchas**
- The ▾ fly-out entries carry an `untested` pill, so a row's text content ends in "untested"; tests read the text node after `.tab-new-menu-dot`.
- Merge: AS3a hunks in `TabBar.tsx`/`DetachedCenterPanel.tsx` are untouched; mine in `TabBar.tsx` are the imports, constants `NO_BOXES/NO_PROJECTS`, the block after `useAddTabMenuData`, `openInMember`/`startInFor` replacing the three handlers, launchCwd uses, and the menu entries; in the popout only the add-menu block.
- `BoxScopeMenus.test.tsx` (AS5a's area) had two tests of the old per-member rows: rewritten for the fly-out.

**Gates** (worktree `scripts/gates.sh`): brand, whitespace, lint, build PASS. Its `vitest --changed` run had 2 failing files: `BoxScopeMenus` (old rows, fixed) and `TerminalAiSwitch` (passes alone, load flake). Full `npm test`: **1028 files, 10346 tests passed** (AS3a 10317 + 29: `StartInMenu.test.tsx` 14 new; `NewTabChordTabBar` +6; `TabBarPlusPinned` +8; `DetachedNewTabCwd` +3; `BoxScopeMenus` rewritten, same count). No Rust change; cargo gates skipped.

**i18n keys** (all five, after `newTabMenu.chooseMachine`): `newTabMenu.startInTitle`, `startInMember`, `startInBox`, `targetMember`, `targetBox`. Removed everywhere: `newTabMenu.groupBoxMembers`, `boxMemberFiles`, `boxMemberShell`, `boxMemberAgent`.
**untested.ts**: `newTabMenu.startInMember` (fly-out, search, no-suffix labels), `newTabMenu.targetMember` (target header and every new-tab path), area `tabs`.
**Filemap**: frontend row `tabs/startIn.ts` (after `TabMemberChip`).

**Flagged for user**
- Nothing seen live. A plain "+" in a box now starts in the active tab's member; after a tab in an unknown folder (e.g. a remote member's local copy) it starts in the box folder.
- Hovering any Agents/Shell/Files row in a box opens the "Start in…" list after 150 ms (existing machine-list behaviour).
- Old tabs saved as "Claude — api" keep their label (AS3a's chip then shows the dot only).

### AS3 review

Reviewer pass 2026-11-03/04 on `6fcb4a9c` + `9d7b62ba` (worktree `box-as3b`). **No code change: no confirmed bug found.**

**Checked, found sound:**
- Every new-tab path reads one value: `TabBar` `launchCwd = newTabTarget(...)?.cwd || projectCwd` (plain "+", Ctrl+Shift+N, Ctrl+1-9, steering, the empty group via `StartHere` -> `requestNewTab` -> the group's own bar, fly-out). `newTabTarget` is `null` outside a box scope, so projects, root, remote projects, containers and the assistant keep `projectCwd` exactly (also `projectName`, the worktree picker `enabled`, cloud rows). Monitor, Disk usage, Network, Printing, Prompt chart, Skills, Browser, Projects 3D keep the box folder.
- Popout: `detachedNewTabTarget` is `null` without `remoteInfo.box`; the member list comes from `boxSeed` (`remoteInfo.box` + `boxMembers`), not from the (also seeded) stores; fixed kinds use `memberTable.boxFolder`; an empty group falls to the box folder.
- Resume/restore: label is no identity anywhere (prompt history/chart match by `tab_id`, then `session_id`, label only as last fallback and already tolerate repeated "Claude"; restore keys on `sessionId`). `restoredAgentCwd`/`restoreBoxScope` already keep a member root (or a worktree under it) for restored agent tabs, so member-rooted agents now being the default resume as before; old "Claude - api" labels keep their text and the chip drops to the dot (`labelNamesMember`).
- Spawn gate (`launch_prep`, box branch) and `compute_allowed_roots` accept box folder + member roots + mirror overrides; no backend/fence change, nothing widens. Box tabs are local-only (no `location`), the fly-out lists the same member dirs as the old rows, so no local path is treated as remote or the reverse.
- Search: `searchable` fly-out entries are matched on their full label, appended after their row, only when the group label itself does not match; remote machine names are not searchable (unchanged). Enter takes the best match (the plain row first).
- No new effects or polling; new store subscriptions are constant-empty outside a box. i18n parity (all five, same placeholders), `UntestedTag` rows (`newTabMenu.startInMember`, `newTabMenu.targetMember`, `tabHoverCard.memberLabel`). Tests assert behaviour (landed cwd/kind/label per path), not only structure.

**Fixed:** nothing.

**Flagged for user (not changed):**
- A viewer opened through the box folder's member symlink (`<box>/api/...`) counts as "whole box" (`memberOfCwd` ties go to the box folder, no symlink resolution), so a plain "+" after it starts in the box folder, not in `api`.
- Box with no folder yet: the heading says "whole box" while the tab starts in `projectCwd` (the active project's dir). Practically unreachable (`openBox` creates the folder).
- Search lists one "Claude in api" style hit per agent x member x kind: with many members/agents a short query ("api") is long.
- Dropping the " - name" suffix leaves several tabs with the same label ("Claude") in the palette (AS6) and on the phone (`PublicTab`, step 14) until those steps show the member.
- `DOCUMENTATION.md:1226` still describes the removed per-member rows (step 13 doc pass).

**Gates** (worktree, `--base b4a318ac`, load 100+): brand, whitespace, `npm run lint`, `npm run build`: PASS (the gate runner was killed during its vitest step, so vitest was rerun by hand). `vitest --changed b4a318ac`: 757 files, 7272 tests, 7271 passed, 1 failed (`BibCards` "mounts only a window...", load flake; alone 12/12). Tabs/windows/`BoxScopeMenus` subset: 114 files, 1007 passed. Full `npm test` not rerun (no code change since the implementer's 1028 files / 10346 tests). No Rust change, cargo gates skipped.

## AS4 Side panel

### AS4a

Worktree `.claude/worktrees/box-as4`, branch `box/as4` (cut from `b4a318ac`). Commit **`f42877bb`** (frontend only; no backend, no `backend:stale`).

**What landed**
- New `src/stores/boxAccordion.ts` (`useBoxAccordionStore`, `resetBoxAccordion`): per box id in `localStorage` (`storageKey("boxAccordion")`, via `lib/persist` so every read/write is try/catch'd, cap 100 rows): `open` (`undefined` = never chose -> follow the active tab's member, else the first; `null` = all folded by a click; id = expanded member), `boxFolded` (the box folder's own section), `views` (member -> Files/Git).
- New `files/useBoxAccordion.ts`: effective expanded member, per-member agent-tab counts (tabs of kind `agent`/`local_agent` whose cwd is in the member's root, `memberOfCwd`), the "active tab moved to another member -> expand it" effect (a change, not the mount), and the drop spring-open.
- `ProjectFilesPane.tsx` `BoxRootSection`: header = grip, caret, round colour dot (`memberColor`), name, git dot, `✦N` agent count; the kind tag stays on the box folder only. Collapse is driven by the pane (props `expanded/onToggle/view/onViewChange/agentCount/springArmed`). The box folder's section stays independent (it is not part of the accordion; folded state persisted). A header click on the expanded member folds it (all folded).
- Git dot: `useGitDirtyStore.byId[rootId]`, drawn only for dirty/staged/unpushed/broken (pill colours, `pill.git*` titles reused); clean, unknown and no reading draw nothing; remote members and fast mode never. A local member nobody has probed (closed project) gets one `refresh` when the pane is on screen.
- Drops on a collapsed section: its header band carries `data-move-rel=""`, `data-move-root={treeDir}`, `data-move-remote`, so the existing cross-root hit test (`hitTestMove` in `fileTreeDrag.ts`) resolves it, with the usual `.move-drop-target` class. The dwell open uses `createSpringLoader` + `SPRING_LOAD_MS` (now exported from `fileTreeDrag.ts`, the only edit there) driven from `useDragStore` (file drags). The open is transient (`dragOpen`) and does NOT fold the others, so the section the file came from stays mounted; at drag end the last section dwelt over becomes the persisted expanded one.
- CSS (`.file-root` block only): `border-radius: var(--radius)`, rail = `--file-root-accent` set inline to `memberColor`, header band rounds its own corners (no `overflow` clip, which would break the sticky band), `.file-root-dot/-dirty/-agents`, `.is-spring-armed` (static outline). No animation, no blurred shadow, nothing for `[data-software-paint]` to do.

**Choices (override freely)**
- The box folder's section is not an accordion member (the mockup shows it open beside an open member).
- No dirty dot for `unknown`/`clean` (omit, never zero).
- Hover-expand folds nothing until release (see above), so a drag out of a section never unmounts its tree.
- `fileRoot.kindProject` removed (last use gone) from all five dictionaries.

**Gotchas**
- `FileMove.test.ts` has source tripwires on `ProjectFilesPane.tsx` (`key={`${rootId}|${treeDir}`}`, `syncSource={remote ? source : undefined}`): kept.
- Stored `open` naming a project that left the box falls back to the active tab's member / the first.
- Existing `SidePanelBox` remote-gating test now sets p2 as the expanded member (only one section has a body).

**Gates** (worktree, `scripts/gates.sh`): brand, whitespace, lint, build, `vitest --changed` PASS. Full `npm test`: 1026 files, 10309 tests (+12 over AS1's 10297, all in `SidePanelBox`); two full runs showed 2 then 5 failures, all load timeouts / flakes in files this step does not touch (`BibCards` x2 timeouts, `MobileProjectPrompts`, `MobileTerminalXtermGround`, `TerminalAiSwitch`); rerun alone: `TerminalAiSwitch` 4/4, `MobileProjectPrompts` + `MobileTerminalXtermGround` pass, `BibCards` 12/12 with `--testTimeout=60000`. `git diff --check` clean.

**i18n keys** (all five, after `fileRoot.gripTitle`): `fileRoot.agentsTitle` ({count}). Removed: `fileRoot.kindProject`. Reused: `pill.gitDirty/Staged/Unpushed/Broken`.
**untested ids** (after `projectFilesPane.2`): `projectFilesPane.accordion`, `projectFilesPane.dropCollapsed` (both pills in the expanded member's toolbar row).
**Filemap rows**: `stores/boxAccordion.ts`, `files/useBoxAccordion.ts`; `files/ProjectFilesPane.tsx` extended.

**Flagged for user**
- Never live: the whole accordion, the colour rail and the spring-open need eyes on them (CSS in particular, including the CPU paint path).
- A closed project's git dot now costs one `git_dirty_probe` per mount of the pane (only when nothing else has read it).
- Persisted rows of dissolved boxes linger (capped at 100).


### AS4b

Same worktree and branch. Commit **`faf417dd`** (13 files, frontend only; stacked on `f42877bb`).

**What landed**
- New `files/BoxMemberMenu.tsx`: the `⋯` menu on a member header, on the shared `ContextMenuPortal` with `.context-menu-check` radio rows (as `MobileAccessPicker`). Rows: Files / Git (picks the view; on a collapsed member it also expands it), Remote / Local (remote SSH members that have a Local side; same project-wide side as the body switch), Open folder in file manager (not host-pinned), Project settings (when there is a `project.json`), Open as tab. Open as tab = `openProjectFilesTab(t, dir, "")`: a `projectfiles` tab in the box scope with cwd = the member root, the one with the git bar and commit row.
- `BoxRootSection`: `⋯` button (`.file-root-more`) is a sibling of the header button, members only. The body toolbar keeps only the Files/Git segmented control and the Remote/Local switch; the folder and gear buttons moved into the menu (the "Project settings" `UntestedTag` `projectFilesPane.1` moved with it).
- One shared search: the host's existing toolbar 🔍 (unchanged `ProjectFilesView`) opens a single `.box-shared-search` field (name/content modes, Aa) above the sections; it searches the expanded member. The query clears when the field closes or another member expands. A remote member on its Remote side is not searchable (the backends walk local paths): the field is disabled and says to switch to Local; a host-pinned member searches the host as before.
- `FileTree.tsx` gained one optional prop `sharedSearch?: SharedTreeSearch` (type in `fileTreeTypes.ts`): when set the tree draws no search box, lists that query's results from the project root, and clears the host's query when a result is revealed. Box trees get `searchOpen={false}` and only the expanded member's tree gets `sharedSearch`. This is the one change outside the named files (`ProjectFilesView.tsx` needed nothing).

**Choices (override freely)**
- Shared search scope is the member's whole root, not the browsed subfolder (the per-tree "this folder / project" toggle is gone in a box). "All members" stays a follow-on.
- Remote/Local lives both in the menu and in the expanded body (mockup shows it there).
- The `⋯` menu is not offered on the box folder's own section (nothing to act on).

**Gotchas**
- The `⋯` is outside the header `<button>` (button in button is invalid), so the reorder grip, header and `⋯` are three siblings in `.file-root-headrow`.
- Tests that open the search press `button[aria-label="Show search"]` (the toolbar toggle).

**Gates** (worktree, `scripts/gates.sh` on the whole step): brand, whitespace, lint, build PASS; `vitest --changed` ran 755 files / 7246 tests with 2 load failures in untouched files (`PdfZoomRaster`, `TerminalAiSwitch`); the two re-run alone with `SidePanelBox` and `i18n`: 55/55 pass. `SidePanelBox` now has 33 tests (+11 for AS4b: menu rows, Git-expands, Open as tab, folder, Remote/Local, one search field, expanded-only search, clear on close, remote not searchable). I did NOT re-run the whole `npm test` after AS4b under load (it takes about 11 min and flaked in untouched files twice for AS4a); expected total 10320 (AS4a's 10309 + 11).

**i18n keys** (all five, after `fileRoot.agentsTitle`): `fileRoot.moreAria`, `moreTitle`, `openAsTab`, `openAsTabTitle`, `findIn` ({name}), `searchIn` ({name}), `searchNoMember`, `searchNeedsLocal`. Reused: `projectFilesView.tabFiles/tabGit/openInFileManagerTitle/projectSettingsTitle`, `fileSourceSwitch.*`, `fileTree.search*`/`clearSearch`, `search.caseSensitive`.
**untested ids**: `projectFilesPane.memberMenu`, `projectFilesPane.sharedSearch` (pills in the menu's Open-as-tab row and beside the shared field).
**Filemap rows**: `files/BoxMemberMenu.tsx`; `files/ProjectFilesPane.tsx` extended (accordion, `⋯`, shared search).

**Flagged for user**
- Not live: the menu placement, the disabled-field wording, and search in a remote member need a click-through.
- The per-tree "search this folder only" is gone inside a box (search is root-wide).
- Not covered: a keyboard path into the `⋯` (it is a focusable button, Enter/Space opens the menu; no chord).
- No Fixed or User decision was undone.

### AS4 review

Reviewer pass over `f42877bb` + `faf417dd` (worktree `box-as4`).

**Checked, found sound**
- Single project: with no `sharedSearch` the `FileTree` expressions (`searching`, the search row, `FileTreeSearch` props) reduce to the old ones; `ProjectFilesView` is untouched; outside a box `useBoxAccordion` has `boxId` null and its spring effect never subscribes.
- Probes: the dirty probe is skipped for remote members, in fast mode, while the pane is not `active`, and when anything has already read the project (any stored reading, `unknown` included, stops it); `refresh` also dedups in flight. The `git_dirty_probe` is therefore at most one per local, unread member per mount of the visible pane. Nothing remote is probed or searched on its Remote side.
- `localStorage`: `lib/persist` wraps every read/write, rows keyed per box id, capped at 100, stale member ids fall back (`expandedId`, views ignored); `persistRow` re-reads so two windows do not clobber rows.
- Drag: the collapsed header carries `data-move-rel=""`, `data-move-root={treeDir}`, `data-move-remote` (same rule as the tree's `moveTargetAttrs`: remote and Remote side), so `hitTestMove` -> `resolveMoveTarget` decides (remote refuses cross-root); the highlight class goes on the header band via the existing cross-root path. Spring-open does not fold the source section. The reorder grip sits in the same band and uses its own gesture.
- `⋯` menu: shared `ContextMenuPortal` + `.context-menu-check`; Open as tab = `projectfiles` tab with cwd = that member's `dir`, which `ProjectFilesTab` resolves back to the same member in a box scope (`resolveProjectDirectory(p) === cwd`); in a popout `addTab` is shipped to the main window.
- Missing readings omitted (dirty dot only for dirty/staged/unpushed/broken, agent count only when > 0). CSS: no animation, no blurred shadow; nothing for `[data-software-paint]` to do. i18n parity test passes.

**Fixed**
- `1e5f7a56` `fix(boxes): the side panel keeps a remembered member when the scope's tabs load after the mount`. `setScope` runs before `hydrateScopeFromDisk`, so on the first visit to a box scope in a session the pane mounts with no tab; the tabs arriving read as "the active tab moved to member X" and overwrote the persisted choice (the relaunch case the persistence exists for). `useBoxAccordion` now also remembers whether there was an active tab and follows a move only from one. Regression test `keeps the remembered choice when the scope's tabs only load after the mount` (failed before: `['p2']` instead of `['p1']`).

**Flagged for user (design, not changed)**
- The shared search field stays open and enabled when the expanded member is on its Git view (no tree is mounted, so it searches nothing), and it cannot search the box folder's own section (placeholder says "no member" when all members are folded). Either disable it in those cases or let it follow the box folder.
- A closed member's git dot is read once per mount and then not refreshed (only open projects are polled by the switcher); a dot can go stale until the box is re-entered.
- Cancelling a file drag with Esc still opens (and persists as expanded) the last section dwelt over.
- "Open as tab" is not given the pane's scope (it opens in the store's current scope, which is the box whenever the box pane is shown); passing `scope` would be belt and braces.
- No Fixed or User decision was undone.

**Gates** (worktree): `scripts/gates.sh` itself printed only the brand line and exited 0 under this load (it stopped early, so I do not rely on it); run by hand against `b4a318ac`: `scripts/brand-check.sh` OK, `git diff --check` clean, `npm run lint` 0 errors / 29 warnings, none in touched files, `npm run build` OK, full `npm test`: **1026 files, 10321 tests passed** (AS4b's expected 10320 + 1 regression test), no timeouts this run. `SidePanelBox` alone: 34/34. No Rust change, cargo gates skipped.

## AS5 Membership UI

### AS5a

Worktree `.claude/worktrees/box-as5`, branch `box/as5` (cut from `04d1d7f5`). Commit **`10a956fd`** (17 files, frontend only, no `backend:stale`).

**What landed**
- New `projects/BoxMemberChecklist.tsx` (`<BoxMemberChecklist box>` rows = projects, closed ones labelled; `<BoxMemberChecklist project>` rows = boxes with swatch). Stays open, own scroll region (no 12/6 cap), filter past 8 rows (`CHECKLIST_FILTER_FROM`), opening order kept (a ticked row does not jump), each toggle = `addToBox`/`removeFromBox` (one singular `patch_box`, optimistic with revert), never a whole list. Used by the box pill menu (`BoxScopeChip` menu block) and the project pill Boxes group (`ProjectPill`).
- Quick create everywhere: chip list "New Box" row, switcher "+" row, "Box these (N)...", "New box with X..." all call `useQuickCreateBox`. Alt-drag: `boxProjects` -> `selectBox` -> `boxEditor.startRename`. "Edit boxes..." opens the slice box, else the first, and is hidden with no box; the project pill's old overflow "Edit boxes..." row is gone.
- Project pill menu: in a slice, member pill shows "Remove X from Box" (reuses `projectSwitcher.removeFromBox`).
- "Delete box" is now "Dissolve box..." (`BoxScopeChip` prop `onDelete` renamed `onDissolve`); dissolving the box you are in calls `leaveBox()` first. Inline rename validates (`useBoxNameCheck`): Enter with a refused name keeps the field open (`aria-invalid`, reason as title), blur drops it and toasts.

**Choices (override freely)**
- Toggles use `addToBox`/`removeFromBox` rather than `saveBox` (optimistic, same singular add/remove, existing tests assert them).
- Alt-drag enters the box (slice) so its pill is certainly on the row; if the scope change steals focus the field just blurs and "Box N" stays.
- `BoxEditorDialog`, `openCreate` and the dialog's create mode untouched (AS5b removes them; `openCreate` has no caller now). `boxEditor.dissolve` unchanged; `boxEditor.dissolveTitle` reworded to "Dissolve".
- The slice "+" candidate list still lists active projects only (closed ones cannot join through it; they can via the checklists). `BoxScopeMenus`/`BoxAssignment`: no change needed except one new BoxAssignment case.

**i18n** (all five): added `boxMembers.closed/filterProjects/filterBoxes/noMatch/noProjects`, `boxPill.dissolveBox`; removed `boxPill.moreInEditor`, `boxPill.deleteBox`; reworded `boxEditor.dissolveTitle`.
**untested.ts**: added `boxMembers.checklist`, `boxMembers.removeFromBox`, `boxPill.rename`, `boxPill.dissolveBox`, `boxChip.createDoors`; removed `boxPill.membersGroup`, `projectPill.6`.
**Filemap**: new row `projects/BoxMemberChecklist.tsx`; `BoxScopeChip.tsx` row extended.
**Tests**: BoxUx, BoxRendering (+10), BoxMembershipControls, BoxAssignment updated; new `BoxMemberChecklist.test.tsx` (5). Targeted vitest of those files, tsc and eslint on touched dirs were green before the commit.

**Gates: NOT finished.** `scripts/gates.sh` was still on its lint stage (machine load ~80) when I had to stop; full `npm test`, count check and `git diff --check` (clean before commit) still owed. The merger must run them.

**Flagged for user**
- Nothing seen live; the checklist CSS (list height 240px/40vh, filter field, "closed" label) needs eyes.
- Alt-drag focus behaviour after entering the box is unverified.

### AS5b Box sheet

Worktree `.claude/worktrees/box-as5`, branch `box/as5` (on top of `6d614963`). Commit **`bb0df771`** (frontend only; no backend, no `backend:stale`).

**What landed**
- `BoxEditorDialog.tsx` rewritten as a one-box sheet (same classes `project-dialog dialog-framed box-editor`, `useModalFocus`, `useDialogs()`): name with inline check (`useBoxNameCheck`, only when the name differs from the opening one, so a legacy duplicate/empty never blocks), colour row, member list, trust lines, folder, phone row, "Dissolve box..." footer. `BoxEditorHost`/`dissolveBoxSpec` stay exported; `dissolveBoxSpec(t, name, folder?)` now names the folder when given (`ProjectSwitcher`'s pill Dissolve passes `target.folder`: a one-argument change).
- Save = ONE `saveBox(boxId, diff)` with `diffBoxMembers(openingSnapshot, draft)` + `name` only if changed + `color` only if changed. `saveBox` gained `color` in `BoxDraftDiff` (`""` = auto; no write when equal to the stored colour; the old-backend fallback sends a singular `color` patch). A member added meanwhile is neither in `addMembers` nor `removeMembers`, so it survives (tested).
- Member list: members (as at opening) first, then the rest by position; ticking never reorders; filter field always; closed projects included. Badges: closed / container / VM / remote (`projectHostKind`), and `BoxSwatch`es of the other boxes holding the project (title "Also in: ..."). Trust lines (one per kind, only for ticked members): "outside the container of: ...", "outside the VM of: ...", "remote ... connection has to be up".
- Folder: path + Open (`open_in_file_manager`) + "renaming does not move it"; a box with no folder yet says it is created on first open (no Open button).
- Phone row: `ToggleRow` + new shared `PhoneReachButton` (extracted from `MobileSettings.phoneScopeButton`, now used by both) + `MobileAccessPicker`. Toggle passes the box's CURRENT list (`live[MOBILE_DEVICES_KEY] ?? null`, read at click time); acts at once like Settings. Preconditions as in `set_box_mobile_access`: not Windows (no tmux) and `persist_local_sessions !== false`; otherwise the row is replaced by a line saying why. Escape closes the open picker before the sheet.
- Dissolve: confirm (names the folder) -> if inside (`sliceBoxId === id` or scope `box:<id>`) `boxSlice.leaveBox()` -> `deleteBox`. The sheet closes by itself if its box vanishes (dissolved elsewhere).
- `stores/boxEditor.ts`: `openCreate` and `initialMemberIds` removed; `openEditor(boxId: string)`.
- `BoxColorPicker.tsx`: swatch grid extracted as `BoxColorSwatches({boxId, color, onPick})`; the pill menu row and the sheet both use it.
- Empty box: new `projects/BoxEmptyLine.tsx` ("No projects yet" + "Add projects..." button -> `openEditor(boxId)`), shown in `ProjectSwitcher` (slice strip, when the sliced box has no visible pill) and in `ProjectFilesPane` (above the sections when `member_ids` is empty; the old "no member folders" line now only shows for a box with members but no folders). Only those two small pieces were added in those files.

**Choices (override freely)**
- The button opens the **sheet**, not the checklist menu (closed projects and filter included, no anchor needed).
- The copy drops "drag a pill here": inside a slice no other project's pill is on the row, so a drag cannot start there; the line is "No projects yet" + button.
- The sheet does not reuse `BoxMemberChecklist`: that one writes each toggle at once (`addToBox`/`removeFromBox`), the sheet needs a draft. It reuses the pill menu's colour swatches and the box-swatch icon instead.
- Phone switch acts immediately (not on Save), like the Settings row and picker.
- No "Select shown" button (mockup had one); not in the scope list.
- Trust wording replaces `boxEditor.trustNotice`.

**Gotchas**
- A project row that points at a deleted project stays in `checked` untouched (not in the list, not in the diff).
- Tests that set boxes after opening must wrap in `act` or the controlled checkbox keeps stale state.

**Gates** (worktree): `scripts/gates.sh` (load 100-130): brand 639 s, whitespace, lint (1152 s), build PASS; its `vitest --changed` run (731 files / 7071 tests) had 28 files fail by load timeouts, none in box files; all 28 re-run alone (`--testTimeout=120000`): **28 files / 307 tests pass**. Full `npm test` after the commit: **1030 files, 10457 tests, 10456 passed, 1 failed (`TerminalAiSwitch`, load flake; 4/4 alone)**. New: `BoxSheet.test.tsx` 23 tests (diff save with a concurrent addition, name+colour in one patch, untouched sheet writes nothing, inline name check incl. legacy duplicate, refused write, member order/filter, closed members add/remove, badges + also-in swatches, trust lines, folder, phone row keeping the list / null with no list / hidden with persist off, dissolve with folder path / leave-first by slice / by scope / not for another box, empty line); `BoxUx` (+2 strip cases; the old create-mode and rename+set-members editor tests removed), `SidePanelBox` (+2). `git diff --check` clean. Cargo gates skipped (no Rust change).

**i18n keys** (all five, after `boxEditor.dissolveConfirm`): `boxEditor.sheetTitle` ({name}), `colourLabel`, `membersCount` ({count},{total}), `badgeContainer/Vm/Remote`, `alsoIn` ({list}), `trust.container/vm/remote` ({list}), `folderLabel/Open/None/Note`, `phoneLabel/Switch/NoTmux/NoPersist`, `dissolveConfirmFolder` ({name},{folder}), `boxEmpty.text/add/addTitle`. Removed everywhere: `boxEditor.title`, `boxLabel`, `newBoxOption`, `trustNotice`. Reused: `boxMembers.closed`, `boxPill.dissolveBox`, `boxName.*`, `projectFilesView.openInFileManagerTitle`.
**untested.ts**: added `boxEditor.sheet`, `boxEditor.phoneRow`, `boxEmpty.line`; removed `boxEditor.title`.
**Filemap**: rows `projects/BoxEditorDialog.tsx`, `projects/BoxColorPicker.tsx`, `mobile/MobileSettings.tsx` rewritten/extended; new `projects/BoxEmptyLine.tsx`.

**Flagged for user**
- Nothing seen live. CSS for the sheet (swatch row in a dialog, badges, 520 px width, list height `min(30vh,240px)`, the empty line in the strip) needs eyes, including the CPU paint path (no animation or blurred shadow added).
- The empty-box copy omits "drag a pill here" (see Choices).
- Cancel/Escape/backdrop still discards the draft without asking (as before).
- Switching the phone row acts at once even if Cancel is pressed afterwards.
- `ProjectSwitcher`'s own Dissolve handler still duplicates the sheet's leave-then-delete (6 lines); it could call a shared helper later.
- No Fixed or User decision was undone.

### AS5 review

Reviewer pass 2026-11-04 over `10a956fd` + `bb0df771` (worktree `box-as5`).

**Checked, found sound**
- Data: the sheet's `saveBox` sends `diffBoxMembers(openingSnapshot, draft)` plus `name` and `color` only when changed, as ONE `patch_box` (tested with a member added meanwhile: it is neither added nor removed). The patch answer (the file's box) replaces the store copy. Checklist toggles are singular `addMember`/`removeMember` patches with revert. The old-backend fallback (`/unknown field/` -> `rename_box`, singular adds, singular removes, singular colour) sends no whole list; a failed colour/only-colour save needs no fallback because `color` was always in `BoxPatch`.
- Phone row: toggle passes `live?.[MOBILE_DEVICES_KEY] ?? null`, read at click time. `null` reaches the backend only when the box has no stored list (off, or "all phones"), which is exactly what Settings sends; a box with a list keeps it (the store sends `null` on disable and the backend drops the list on disable anyway). Gating mirrors `set_box_mobile_access` (no tmux on Windows; `persist_local_sessions === false`). Device ids stay on the desktop side (`mobile_paired_devices` is the Settings call); nothing new crosses the browser API.
- Dissolve: both doors (pill menu in `ProjectSwitcher`, sheet footer) confirm with `dissolveBoxSpec(t, name, folder)` using the box's own `folder`, then `leaveBox()` when the slice is that box or the scope is `box:<id>`, then `deleteBox`. `delete_box` never touches the folder; nothing touches `box:<id>` session state. No third delete door exists.
- Quick create: `createBoxQuick` is called only by `useQuickCreateBox` (chip "New Box", ghost pill, switcher "+", "Box these", "New box with X") and by `boxProjects` for Alt-drag, which then `selectBox` + `startRename`. A refused name stays on the prompt (`validate`) or the rename field (Enter) and toasts on blur. `openCreate`/`initialMemberIds` have no references left (the `openCreate` in `CalendarPane` is that file's own function).
- Closed projects: listed, labelled, addable and removable in the checklists and the sheet; only `patch_box` is sent, no project status changes.
- Shared pieces: `BoxColorSwatches` and `PhoneReachButton` are verbatim extractions (same classes, props, labels); Settings -> Mobile and the pill-menu colour row render the same as before (their suites are green).
- Conventions: confirms through `useDialogs()`, the dialog is `project-dialog dialog-framed` with the modal stack handling Escape (picker first), i18n placeholders identical in all five dictionaries for every new key, every `UntestedTag` id has a register row, no removed key is still referenced.

**Fixed:** nothing needed fixing. One test added (`2a8a3004`): the sheet's save of a closed project leaves it `inactive` and calls no project command (the old test only checked the patch).

**Flagged for user (not changed)**
- `set_box_members` is still a whole-list write in two places: the side panel's drag reorder (`ProjectFilesPane` `commit`, needs a backend reorder patch to be safe) and `boxProjects`' append branch, which now has NO caller outside tests (dead code with the lost-member hazard; delete it or route it through `saveBox({addMembers})`).
- The sheet shows a member added meanwhile as unticked (the checklist is the opening snapshot, so "N of M" under-counts) although it is a member; Save leaves it alone. Cosmetic.
- A box whose phone access is already ON while persistent sessions are off (or on Windows) gets the "not available" line instead of the switch, so it cannot be turned off from the sheet (Settings still can). The wording "off for now" is then wrong.
- Alt-drag: `startRename` is set before `await selectBox`; if the scope switch steals focus the field blurs unchanged and "Box N" just stays. Unverified live; awaiting `selectBox` first is the alternative.
- "Add projects..." (`BoxEmptyLine`) calls `openEditor`, but `BoxEditorHost` is mounted in `AppShell` only; if a popout ever shows that line the button does nothing.
- No Fixed or User decision was undone.

**Gates** (worktree, by hand, base `48f4b5b9`, `scripts/gates.sh` not used): `scripts/brand-check.sh` OK; `git diff --check 48f4b5b9` clean; `npm run lint` 0 errors / 29 warnings (same as AS4, none new); `npm run build` OK; full `npm test`: **1030 files, 10457 tests passed**, no timeouts or flakes this run (load was low); `BoxSheet` alone 23/23 after the added assertion. No Rust change, cargo skipped.

## AS6 Search, palette, polish

Worktree `.claude/worktrees/box-as6`, branch `box/as6` (cut from `10a956fd`). Commits: **`c54d4ba4`** (code, tests, i18n, lesson, untested), **`40ba0939`** (docs + todo), **`07d6f6d7`** (search list closes when focus tabs away), **`a6b87b21`** (box rows keep their own title class; fixes `SteeringProjectJump`). Frontend only: no backend, no `backend:stale`.

**What landed**
- `ProjectSearch.tsx`: focus with nothing typed lists the boxes under a "Boxes" heading (`BoxSwatch` in `boxColor`, "N members: a, b, c, d, ..."); a query matches a box by name or a member project's name; project rows wear the swatches of their boxes (`.project-search-boxes`); while a box is sliced an "All projects" row (`kind: "all"`, `boxSlice.leaveBox`) is first. Reads `useBoxSliceStore` itself; no new props. Hexagon icon gone from the box row.
- `CommandPalette.tsx`: Boxes group after Projects (pick = `boxSlice.selectBox`, i.e. slice + `openBox`); actions "New box..." (`useQuickCreateBox`; its `dialogs` render on both sides of `open`, so the prompt outlives the palette), "Show all projects" (only while sliced), "Add X to Y" (current project, one row per box it is not in, only once something is typed); box-scope tab rows get `scopeDisplayName` as `detail` (replaces the local `name()`).
- `DetachedCenterPanel.tsx` (titlebar block + one const above the `return`): `BoxSwatch` + box name, `--box-mark` colour, when `scope === boxScopeId(remoteInfo.box.id)`.
- `BoxScopeChip.tsx`: new private `BoxStatusBars` (box scope + `member_ids`, memoised) used by the pill and the list row. `ScopeSetStatusBars` itself untouched.
- Hint `box-create` (anchor `.box-ghost-pill`, ambient, after `box-list`): `FeatureHintSpec.when`, `HintCtx.boxCount` (undefined until the boxes file has loaded, which never makes it eligible), `HintHost` passes it.
- Lesson `project-boxes`: reworded 5 steps, two new (`member-chip`, `side-panel`), seven in all, five languages.
- Docs: `docs/help/containers-boxes.md` (boxes part rewritten), `DOCUMENTATION.md` Project Boxes section (switcher, create/membership, finding boxes, box scope incl. Start in..., side-panel accordion, `patch_box` in the command list; the per-member "+" rows text is gone), `docs/context/project_boxes.md` (new "2026-11 redesign" section), `docs/filemap_frontend.md` (ProjectSearch, CommandPalette rows). `todo/group-a-boxes.md`: entry **2427** with 11 manual boxes, each with the four-platform pairs, all unticked.

**Choices (override freely)**
- "Add X to Y" has no trailing ellipsis (it acts at once; the plan wrote "..."), and appears only after typing so a blank palette is not one row per box.
- "All projects" in the search: first on an empty field; once typed, last and only while the query is a prefix of its label, so it never takes Enter from a match. In steering's jump mode the open projects still lead (then All projects, then boxes) so Enter there still lands on a project.
- The search list opens on focus/click only if it has rows (no boxes and not sliced: unchanged behaviour). A pick, Escape, a press elsewhere or Tab-away closes it.
- Popout mark uses `BoxSwatch` (the hexagon-shaped box mark used everywhere else), not a literal "▣" glyph; the name is tinted 55% toward the box colour for contrast.
- The status strip counts member scopes even for closed members (a member's tabs live in its own scope).
- The hint needs `projectCount >= 4` where `projectCount` is `projects.length` (all entries, as HintHost already computes it), plus the ghost pill on screen (which exists only at 0 boxes).
- Lesson steps for the side panel and member chip are written from the plan (AS4 landed the accordion; the box sheet is described only in the "Edit box..." clause).

**Gotchas**
- The scratchpad directory is shared by all agents of the session: another agent's `gates.log` clobbered mine; use a unique log name.
- `FeatureHints.test` "falls through the catalogue" now needs a ctx with 4 projects and `boxCount: 0`.
- `SteeringProjectJump` counts `.project-search-name` rows: box rows use `.project-search-box-title`.

**Gates** (worktree; machine load 80-140 during the run): `scripts/gates.sh --base 10a956fd`: brand PASS (425 s), whitespace PASS, `npm run lint` PASS (1053 s), `npm run build` PASS; Rust gates skipped (no Rust change). Its `vitest --changed` run had 27 files fail by load (worker start timeouts, 20 s test timeouts: AgentApiKeys, PromptChart, DeckAutosave, several Mobile*/PdfMarkup*, YamlViewer, BibCards, Tex*, Terminal*, ...); rerun alone with 90 s timeout: 26 of 27 passed, the 27th (`SteeringProjectJump`) was a real failure from my box-row class, fixed in `a6b87b21`. Final full `npx vitest run` (90 s timeouts, 4 workers) at HEAD: **1031 files, 10431 tests, all passed**. New: `BoxSearch` +6, `CommandPalette` +6, `FeatureHints` +5 (one case reshaped), new `DetachedBoxMark` (3), new `BoxMemberAgents` (2). `tsc` and `git diff --check 10a956fd` clean.

**i18n keys** (all five): `projectSearch.groupBoxes`, `projectSearch.allProjects`, `projectSearch.allProjectsHint`, `palette.group.boxes`, `palette.action.newBox`, `palette.action.showAllProjects`, `palette.action.addToBox` ({project}, {box}), `detachedTabs.boxMarkTitle` ({name}), `hint.f.box-create.title/body`, `lessons.projectBoxes.memberChipTitle/Body`, `lessons.projectBoxes.sidePanelTitle/Body`; reworded `lessons.projectBoxes.blurb/whyBoxes*/newBox{Title,Body}/assignMembers*/boxDropdown*/boxScope*`. Nothing removed.
**untested.ts**: `projectSearch.boxes`, `palette.boxes` (pill in the palette footer), `detachedTabs.boxMark`, `boxChip.memberAgents` (pill in the box list heading).
**Filemap**: `ProjectSearch.tsx`, `CommandPalette.tsx` rows extended.
**Merge**: my hunks in `DetachedCenterPanel.tsx` are the import line, one const before `return` and the titlebar span; in `BoxScopeChip.tsx` the `BoxStatusBars` component, two call sites and one tag; `projects-tabs.css` (search rows, after `.project-search-row.is-box`), `base.css` (`.detached-titlebar-box*`), `header-menus.css` (`.command-palette-box-swatch`).

**Flagged for user**
- Nothing seen live: the search heading and swatches, palette rows, popout mark and the ghost-pill hint need eyes (including the CPU paint path; nothing animated was added).
- The todo entry's "box sheet" and "side panel menu/search" rows are written from the plan; they describe AS4b/AS5b as planned, so re-read them after those land.
- The docs describe the box sheet ("Edit box...": name, colour, folder, phone access, Dissolve) from the plan; `DOCUMENTATION.md` names it `BoxEditorDialog.tsx` until AS5b renames anything.
- No Fixed or User decision was undone.

## Final review

Final reviewer pass 2026-11-04 on `box/redesign` (worktree `box-int`), range `48f4b5b9..4ec0c466`, then five commits on top. Final sha **`ee0657bf`**.

### What I checked (cross-step)
- The three "where" readers agree: the tab chip (`tabMemberInfo`), the "+" target (`newTabTarget`) and the accordion's member pick (`useBoxAccordion`) all call the one `memberOfCwd` over the same member table. They differ only by design: the chip skips viewer/monitor kinds, the "+" target and the accordion use any tab's cwd.
- Slice store vs the other doors: palette, search, keyboard ring, swatch click, ✕ and Dissolve all go through `boxSlice` (`selectBox`/`leaveBox`/`stripProjects`).
- Whole-list writes: `save_boxes` and `set_box_members` had two live callers each; after (c)/(d) below only the old-backend fallback of `reorderBoxMembers` calls `set_box_members`.
- Duplicated helper found and merged: "leave the box you are in, then delete" was written twice (pill menu in `ProjectSwitcher`, sheet footer) -> `boxSlice.dissolveBox`.
- Leftovers: no TODO/FIXME in the range; `openCreate`/`initialMemberIds`/`boxEditor.defaultName`/`boxEditor.title`/`newBoxOption`/`trustNotice`/`boxPill.deleteBox`/`boxPill.moreInEditor`/`fileRoot.kindProject`/`newTabMenu.boxMember*` have no reference left; `boxPill.membersGroup` is still used. All 88 keys added in the range are referenced (literally, or through a template key: `boxEditor.trust.*`, `boxEditor.phone*`, `hint.f.*`). i18n parity test passes.
- `node scripts/untested.mjs check`: "The register and the source agree." `scripts/brand-check.sh` OK. `scripts/privacy-check.sh 48f4b5b9..HEAD`: no sensitive data (9345 added lines, 84 paths, 27 commits).
- Filemap rows exist for `BoxMemberChecklist`, `TabMemberChip`, `startIn`, `useQuickCreateBox`, `boxSlice`, `boxAccordion`, `useBoxAccordion`, `BoxMemberMenu`, `BoxColorSwatches` (in the `BoxColorPicker` row), `BoxEmptyLine`. `PhoneReachButton` had none (it lives in `mobile/MobileAccessPicker.tsx`): added to that row. Rows for `stores/boxes.ts`, `BoxEmptyLine` and the backend `boxes.rs` updated for the changes below.
- Docs: `docs/help/containers-boxes.md`, `DOCUMENTATION.md` and `docs/context/project_boxes.md` matched the merged code for the switcher, create flow, checklists, search/palette, "Start in…", chip; they were missing the side-panel `⋯` menu / Open as tab / shared search, the box sheet's contents and the order patch: added. `todo/group-a-boxes.md` entry 2427 (11 manual rows, each with the four-platform ✅/❌ pairs) had the sheet and accordion rows "described from the plan": rewritten against the merged code (sheet: member list, badges, trust lines, phone-off-persist case; accordion: `⋯` menu, shared search, reorder, empty-box line).

### Fixes (each regression test fails without its fix)
- **(a) `826e7ecc`** Phone access can be revoked: the backend checks nothing when switching OFF, but the sheet replaced the switch with an "off for now" line whenever persistent sessions were off (or on Windows). A box whose access is on now keeps its switch plus a new line ("still on, but cannot work…", keys `boxEditor.phoneOnNoTmux`/`phoneOnNoPersist` in all five dictionaries); a box with access off keeps the old line. Test: `BoxSheet` "can still be switched off while persistent local sessions are off".
- **(b) `826e7ecc`** (same commit) "Add projects…" is left out of `BoxEmptyLine` in a popout (`isDetachedWindow()`), since `BoxEditorHost` is mounted in `AppShell` only; the "No projects yet" text stays. Test: `BoxSheet` "has no button in a popout…".
- **(c) `c88ca94a`** Order-only reorder. Backend: `BoxPatch.order: Option<Vec<String>>` (camelCase `order`, `deny_unknown_fields` kept): the named ids that are members take, in that order, the slots those ids hold; every other member keeps its slot; applied after adds/removals; unknown ids and repeats ignored; one write, no `rev` bump if nothing changed. Frontend: `reorderBoxMembers(boxId, order)` in `stores/boxes.ts` sends `patch_box {order}`, falls back to the slot-wise whole list (`reorderedMembers`, `set_box_members`) only on an `unknown field` refusal (running old backend); `ProjectFilesPane`'s drag/keyboard reorder uses it and toasts a failure. Tests: cargo `an_order_patch_reorders_the_named_members_and_keeps_a_concurrent_one`, `an_order_patch_comes_after_the_adds_and_removals`, the camelCase/`deny_unknown_fields` test extended; vitest `SidePanelBox` (3 cases now assert `patch_box {order}` and no `set_box_members`), `BoxAssignment` "reorderBoxMembers" (order-only patch; fallback; other errors not retried).
- **(d) `c88ca94a`** `boxProjects`' append branch and the `setBoxMembers` store action are gone (type is `{name?}` only). Test: `BoxAssignment` "has no append branch…".
- **`369c89af`** (refactor) `dissolveBox(boxId)` in `boxSlice.ts`, used by the pill menu and the sheet.
- **`ee0657bf`** (found while reviewing the AS5 "cosmetic" flag; it is a bug: the project could not be removed from the sheet) The sheet showed a project added meanwhile as UNticked, left it out of "N of M" and could not remove it. The user's own ticks are now an overlay on the live box and Save diffs against the live box. Test: `BoxSheet` "shows a member added meanwhile as ticked, and unticking it removes it".
- **`62066ee4`** docs/filemap/todo as listed above.

### Run `backend:stale`
Backend changed (`BoxPatch.order`). `npm run backend:stale` in the main checkout reports: "THE OPEN WINDOW PREDATES THE CURRENT BUILD" (the sidecar's bundle and the window's frontend are behind the tree); rebuild/relaunch to pick up the changes. Until then the reorder uses the whole-list fallback. I did not restart anything.

### Flagged for user (design, not changed)
- Shared side-panel search stays enabled when the expanded member is on its Git view (it searches nothing), and cannot search the box folder's own section.
- A closed member's git dot is read once per mount of the pane and can go stale.
- Cancelling a file drag with Esc still opens (and persists) the last section dwelt over.
- "Open as tab" is not given the pane's scope (it uses the store's current scope, which is the box whenever the pane shows).
- Alt-drag: `startRename` is set before `await selectBox`; if the scope switch steals focus the field blurs unchanged and "Box N" stays. Unverified live.
- Box names: only `Cc` control characters are refused (zero-width/bidi characters and NFC/NFD twins pass).
- `saveBox` old-backend fallback: if the rename succeeds and a later singular patch fails, the store keeps the pre-save copy until the next load.
- Tier 3 shows no box pill when none is selected; a click on the caret pins the list open; `cycleBox` on a ring of one alternates box and home; the slice-aware ring makes Ctrl+Shift+Tab and the steering digits skip non-members.
- A viewer opened through the box folder's member symlink counts as "whole box" for the "+" target; a box with no folder yet says "whole box" while the tab starts in the active project's dir.
- Remote members' tabs (cwd = local copy) get no chip (remoteness is not inferred from paths); the popout's member list is its seed.
- The reorder fallback on an older running backend still writes the whole list (can lose a concurrent member until the app restarts).
- Nothing in this redesign is live-verified: every visual detail (tint, ✕, ghost pill, chip dot, accordion rail, sheet layout, popout mark) and the CPU-paint path need a click-through. Entry 2427 in `todo/group-a-boxes.md` has the rows.
- No Fixed or User decision was undone.

### Gates (worktree `box-int` at `ee0657bf`, all run by hand; load 20-45 during the runs)
- `npm run build`: PASS (tsc 7 + vite + mobile + web bundles).
- `npm test`: PASS, **1032 files, 10486 tests passed**, 0 failed, no timeouts, 228 s.
- `npm run lint`: 0 errors, 29 warnings (same as before the final review).
- `cargo test --workspace`: PASS, 13 suites, 5443 passed, 0 failed (includes `the_generated_command_classes_ts_is_current`; no command added, `UPDATE_COMMAND_CLASSES` not needed, `commandClasses.ts` unchanged). `commands::boxes` module alone: 43 passed (was 41).
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`: PASS, 4866 passed (9 ignored) + 1 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`, `cargo clippy -p app-serverd --all-targets -- -D warnings`: all exit 0.
- `scripts/brand-check.sh`: OK. `git diff --check 48f4b5b9`: clean. `node scripts/untested.mjs check`: agree.
- `scripts/gates.sh` not used (it has exited early under load).

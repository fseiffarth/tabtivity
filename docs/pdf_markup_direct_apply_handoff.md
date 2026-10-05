# PDF markup direct apply — handoff

Plan: `docs/pdf_markup_direct_apply_plan.md`. All work uncommitted in the
shared tree; not run live.

## Phase 1 — backend (2026-10-04)

### Files touched

| File | What |
|---|---|
| `src-tauri/src/services/markup_rounds.rs` | **New.** The undo service: `begin` / `settle` / `preview` / `undo`, `Owner`, `NoUndo`, `RoundError`, `Changes`/`Changed`/`PdfFate`, prune; 17 tests on temp repos. |
| `src-tauri/src/services/mod.rs` | `pub mod markup_rounds;` (+ a comment). |
| `src-tauri/src/services/mobile_control/markup.rs` | `DEFAULT_APPLY_INSTRUCTION`; `Mode` (`list`/`apply`, serde lowercase, default `List`); `MarkupRequest.mode` (`#[serde(default)]`); `UndoTarget`, `UndoRequest`; `Submitted` gains `mode`, `undo`, `no_undo`; `submit` is now a `list`-only wrapper over new `submit_with_undo`; `submit_local` a wrapper over new `submit_local_with_undo`; `bake_and_prompt` takes the undo target and calls `undo_snapshot` **after** the bake (so the marked copy and layers are in the "before" tree) and picks the default instruction by the effective mode; `DEFAULT_INSTRUCTION` doc updated; test helper gets `mode`; equality test checks the TS mirror of the new constant; 3 new tests. |
| `src-tauri/src/commands/pdf_markup.rs` | `pdf_markup_submit` gains `mode`; `PdfMarkupSubmitted` is camelCase with `mode`, `undo`, `noUndo`; new commands `pdf_markup_undo_settle`, `pdf_markup_undo_preview`, `pdf_markup_undo`; `PdfMarkupUndoFailure`; `submit_in_with` now test-only over new `submit_in_with_undo`; 2 new tests. |
| `src-tauri/src/lib.rs` | Registers the three new commands beside `pdf_markup_submit`. |
| `src-tauri/src/services/mobile_control/host.rs` | `markup_submit` passes an `UndoTarget` (owner = tab + raw project id; `NoUndo::Remote` for a remote project) and answers `mode`/`undo`/`noUndo`; new routes + handlers `markup_undo_preview` / `markup_undo` / `markup_undo_settle` (+ `markup_undo_owner`, `markup_undo_error`, `markup_undo_call`). |
| `src-tauri/src/schema/settings.rs` | `pdf_markup_direct: Option<bool>` (`None` = on) + a round-trip test. |
| `mobile-web/src/markupInstruction.ts` | `DEFAULT_MARKUP_APPLY_INSTRUCTION` mirror constant only (forced by the Rust equality test). |
| `docs/filemap_backend.md` | Row for `markup_rounds.rs`; `pdf_markup.rs` row extended. |

### Design choices where the plan was open (or had to change)

1. **Naming: `undo`, not `round`.** A concurrent session is adding its own
   `round` to the same request (`MarkupRequest.round`, a view-minted id for
   `markup_done`, `valid_round`). To keep the two apart the snapshot id is
   `undo` on the wire, the routes are `/markup/undo/{undoId}`, the desktop
   commands `pdf_markup_undo*` with `undoId`. The plan's `round` /
   `/markup/rounds/{round}` / `pdf_markup_round_*` are **not** used.
2. **Settings switch is `Option<bool>` (None = on)**, not `bool` with a serde
   default of `true`: `Settings` derives `Default`, so a plain `bool` would be
   `false` from `Settings::default()`; this matches the sibling
   `pdf_markup_auto_reload`. Old files round-trip (test). The frontend reads
   it as `settings.pdf_markup_direct ?? true`. Not yet in `src/types/index.ts`
   (Phase 2).
3. **Desktop `mode` is `Option<markup::Mode>`**, i.e. `"apply"`/`"list"` (an
   unknown string fails the invoke) rather than a free `Option<String>`.
4. **No `git apply`.** The undo reads the before/after blobs raw (`git
   cat-file --batch`), checks every changed path is byte-for-byte what the
   round left (or absent when the round removed it), then removes what the
   round added and writes the before bytes back itself (temp + rename, exec
   bit from the tree mode, symlinks as symlinks). Reasons: `git apply`
   re-applies eol conversion (CRLF files came back LF under the user's global
   `core.autocrlf=input`), and git 2.53's `apply` **segfaults** under
   `GIT_ATTR_SOURCE`. The conflict check is therefore exact (any edit to a
   changed file since settle is a conflict, not just an overlapping hunk).
5. **Byte-exact snapshots.** All snapshot calls run with
   `GIT_ATTR_SOURCE=<empty tree>`, `GIT_ATTR_NOSYSTEM=1`, a round-local empty
   `core.attributesFile`, `core.autocrlf=false` — needs **git ≥ 2.40**
   (older → `no_git`). `info/attributes` naming a conversion can't be
   switched off → `filtered`.
6. **Seeded vs fresh start.** The repo index is copied (plan §2.2.3) only
   when nothing could have converted what it holds (no `core.autocrlf`, no
   `text`/`eol`/`crlf`/`ident`/`filter`/`working-tree-encoding` in any
   `.gitattributes`, the global attributes file or `info/attributes`).
   Otherwise an empty index: every tracked file present (force-added ignored
   ones included) + every non-ignored file is hashed raw, bounded as a whole
   at 20 000 files / 128 MB (`too_big`). **Note:** the user's global config has
   `core.autocrlf=input`, so on this machine every repo takes the fresh path —
   big repos get `too_big` and run as `list`.
7. **Nothing under `.git` written, not even mtimes.** git *freshens* (utimes)
   an existing object when `add` would write it, also in alternates. So the
   writing calls (`add`, `write-tree --missing-ok`) never get the repo's
   object dir; only reading calls (`diff-tree`, `cat-file`, `diff`) get it as
   `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Test asserts the full `.git` listing
   (paths, sizes, mtimes) unchanged, both start modes.
8. **Extra pins:** `core.splitIndex=false` (shared index would land in the
   repo's git dir), `core.untrackedCache=false`, `gc.auto=0`,
   `GIT_NO_LAZY_FETCH=1`, caller's `GIT_DIR`/`GIT_INDEX_FILE`/… removed.
   `hardened_git_command_in` does not clear env and only sets
   `GIT_COMMON_DIR` + `GIT_OPTIONAL_LOCKS=0` — no conflict with the
   object/index/attr variables.
9. **Effective mode rules** (`markup::undo_snapshot`): `apply` only if asked,
   the source is a **PDF** (a picture → `list`, `noUndo: "not_pdf"`), the
   caller gave a target (phone remote project → `"remote"`), and `begin`
   succeeded. `before.pdf` is kept only for a project-file source, not an
   outbox copy.
10. **Prune** runs in `begin`: > 7 days by `round.json` `created`, then all
    but the newest 30 (the new one always kept).
11. **Concurrency:** a process-wide mutex around every round operation.
12. **Undo requires a settled round** (plan §2.2 undo step 1): an unsettled
    round answers `undo_not_ready`; `preview` settles first, so the UI's
    preview-then-undo flow never hits it.
13. **File names:** listed paths are relative to the project folder; changes
    outside it (project below the repo top), and names with control
    characters or a backtick (could speak in the chat note) are counted in
    `more`, not named. The undo still reverts them (whole work tree, plan
    §2.2). *(Superseded 2026-10-04, #2345: changes outside the project are
    named in `outside` and left alone; only the project folder is undone.)*
14. **Submodules** (gitlink entries) are listed but never touched by undo.

### Wire shapes for Phase 2

**Phone** (all under the existing `authenticate`; POSTs also `exact_origin`):

- `POST /api/v1/tabs/{tab}/markup` — request adds `"mode": "apply" | "list"`
  (absent = list). Response:
  `{ "prompt", "marked", "mode": "apply"|"list", "undo": "<32 hex>"|null, "noUndo": <code>|null }`.
- `POST /api/v1/tabs/{tab}/markup/undo/{undoId}/settle` → `200 {}`.
- `GET  /api/v1/tabs/{tab}/markup/undo/{undoId}` →
  `200 { "files": [{ "path": "docs/a.tex", "change": "added"|"modified"|"deleted"|"changed" }], "more": 0, "pdf": "restored"|"kept"|"none" }`
  (preview: `pdf` says what an undo *would* do).
- `POST /api/v1/tabs/{tab}/markup/undo/{undoId}` → same shape as preview
  (what was done; `pdf: "kept"` also when a restore was refused, e.g. the PDF
  became a symlink).
- Errors `{ "error": code }`: 404 `round_not_found` (bad id shape, or not this
  tab+project's round), 404 `tab_not_found`, 410 `undo_gone` (pruned,
  undone, or lost at settle because it grew too big), 409 `undo_not_ready`,
  409 `{ "error": "undo_conflict", "files": ["a.tex"], "more": 0 }` (nothing
  changed), 500 `undo_failed` / `markup_failed`, 403 `invalid_origin`.

**`noUndo` codes:** `not_git`, `no_git` (no git, or older than 2.40),
`too_big`, `filtered` (`info/attributes` conversion), `git_failed` (error or
20 s timeout), `remote` (phone, remote project), `not_pdf` (picture). Only set
when `apply` was asked and the round runs as `list`. The plan's fallback line
names three reasons; Phase 2 needs text for all seven (or a generic one).

**Desktop** (Tauri, camelCase):

- `pdf_markup_submit({ projectId, path, pages, instruction?, ask?, round?, mode? })`
  → `{ prompt, marked, mode, undo, noUndo }` (errors: strings as before).
- `pdf_markup_undo_settle({ projectId, undoId })` → `null`.
- `pdf_markup_undo_preview({ projectId, undoId })` → `{ files, more, pdf }`.
- `pdf_markup_undo({ projectId, undoId })` → `{ files, more, pdf }`.
- The three undo commands reject with an **object**
  `{ code, files, more }` (`code` = the phone's error codes above, or
  `markup_failed`); `files`/`more` are filled only for `undo_conflict`.

**Instruction:** the user's own text is sent as written in either mode;
otherwise `apply` → `DEFAULT_APPLY_INSTRUCTION`, `list` → `DEFAULT_INSTRUCTION`
(decided by the backend from the *effective* mode). Phone mirror:
`DEFAULT_MARKUP_APPLY_INSTRUCTION` in `mobile-web/src/markupInstruction.ts`.

### Gates

- `cargo test` — the real tree's **lib tests do not compile right now**
  because of another session's in-progress `round` field: `submit_in_with`
  calls in `pdf_markup.rs` tests pass 5 args (6 needed), and `MarkupRequest` /
  `Prompt` literals in the tests of `markup.rs` and `pdf_markup.rs` lack
  `round` (10 errors, none in Phase 1 code). Not touched. Verified instead on
  a scratch copy of the whole current tree with only those test literals
  patched (`round: None`): **lib 3310 passed, 2 ignored, 0 failed**; all
  integration test binaries pass. `markup_rounds` 17/17, `markup`/
  `pdf_markup`/`settings` filter 114+ pass.
- `cargo clippy --all-targets -D warnings` — clean on the scratch copy;
  `cargo clippy --lib -D warnings` clean on the real tree (rustc 1.97.1).
- `npm run build` — passes (tsc + both bundles; rebuilt `dist/` and
  `mobile-dist/` as the gate does).
- `npm test -- --reporter=dot` — 705 files, 7188 tests passed.
- `npm run lint` — 0 errors, 31 warnings, all pre-existing in files not
  touched here.
- `scripts/brand-check.sh` — fails on 3 places, none Phase 1's
  (`screenshots/tabtivity-promo.{gif,mp4}`, `mobile-web/src/terminal/inboxRefs.ts:12`).
- `git diff --check` on the touched files — clean.
- `npm run backend:stale` — "No Tabtivity process was identified, but the
  sidecar on 127.0.0.1:8742 is serving the bundle built in mobile-dist/. The
  Rust side could not be checked." The running window/sidecar does not have
  this backend; it needs the dev build after commit.

### Open points / known limitations

- The real tree's `cargo test` must be re-run once the other session finishes
  its `round` test updates.
- Fresh-start cost: on this machine (`core.autocrlf=input` globally) every
  begin hashes the whole tree (≤ 128 MB / 20 000 files) and stores it in the
  round, up to 30 rounds kept — worst case a few GB in `markup-rounds/`.
- `git` < 2.40 → no undo (`no_git`).
- `info/attributes` conversions → `filtered`; attribute *macros* defined in
  `[attr]` lines that set a conversion indirectly are not resolved when
  deciding seeded vs fresh (a token scan only).
- An undo write that fails mid-way (I/O error after the all-or-nothing
  check) answers `undo_failed` with some files already back.
- The round's diff covers the whole work tree during the round — another
  tab's edits included (plan §2.2); the UI must show the preview first.
  *(2026-10-04, #2345: only inside the project folder now — the rest is
  named and left alone.)*
- Phase 2 must also: treat `DEFAULT_MARKUP_APPLY_INSTRUCTION` like
  `DEFAULT_MARKUP_INSTRUCTION` in `readMarkupInstruction` (a stored default
  is "no instruction"); add `pdf_markup_direct?: boolean` to
  `src/types/index.ts`; update the `markupInstruction.ts` header comment
  (still says the default asks first).

## Phase 1 review (2026-10-04)

Reviewed the undo/direct-apply hunks only (the other session's `round` /
`markup_done` / `ASK_LINES` hunks left alone). Plan-level design (no
`git apply`, own object store, owner check, effective mode) is sound; the
prompt/mode plumbing in `markup.rs`, the desktop commands and the phone
routes' gates (`authenticate`, `exact_origin` on the POSTs, hex id, owner =
tab + its project, project-relative names only) check out.

### Found and fixed

| # | Finding | Fix |
|---|---|---|
| 1 | **Undo could write into another repo.** A project's `.git` *pointer file* (not pinned by `pin_common_dir`) naming a git dir whose config sets `core.worktree` made `--show-toplevel` another of the user's repos; the snapshot and the undo's writes went there. | `markup_rounds.rs` `locate`: the canonical project folder must lie inside the canonical work-tree top, else `not_git`. Test `a_planted_core_worktree_has_no_undo` (fails without the fix). |
| 2 | **Seeding trusted the index's blobs.** `index_is_raw` was a heuristic: an index written under an earlier `core.autocrlf` (or a conversion attribute since removed, or an attribute macro it did not resolve) seeded LF blobs for CRLF files — an undo then rewrote them LF. | Seeding no longer guesses: the repo index is copied, every tracked regular file is hashed raw **without writing** (`hash-object --no-filters --stdin-paths`), and each whose bytes differ from the index's blob is `update-index --force-remove`d and `add --force`d raw (a stat-clean entry is never re-read by `add`). `index_is_raw` and the `.gitattributes`/global-attributes scan are gone; the attribute-macro open point goes with them (`info/attributes` macros are caught on their definition line — test added). Test `a_seeded_snapshot_holds_the_bytes_and_copies_only_what_differs` (fails under the old heuristic). |
| 3 | **Cost.** With the user's global `core.autocrlf=input` every repo took the fresh path: on a copy of this repo (2 106 files, 45 MB) begin took ~0.6 s and stored **24 MB / 2 240 objects per round** (×30 kept). | Fix 2 makes every repo with an index seeded: same copy now **~0.21 s begin, ~0.04 s settle, 0.8 MB per round** (222 KB index copy + 141 tree/changed-blob objects). Only differing tracked files + untracked ones are copied (`MAX_COPIED_FILES/BYTES`, the former `MAX_UNTRACKED_*`, 5 000 / 64 MB); the hash pass is bounded at `MAX_HASHED_FILES/BYTES` (50 000 / 512 MB → `too_big`). Fresh (whole tree, 20 000 / 128 MB) remains only for a repo without an index or when seeding fails. No shared object dir needed. |
| 4 | **Timeout stacked per call.** 20 s per git call, ~10 calls on the Submit's request path → minutes worst case. | `OPERATION_BUDGET` (30 s) per begin/settle/preview/undo: a thread-local deadline (`Budget`) caps every call at `min(now + 20 s, operation end)`. Test `a_call_past_the_operations_deadline_is_killed`. |
| 5 | **Partial undo on an I/O failure**, and **check-then-write by path** (a fenced agent of another tab in the same project could swap a checked folder for a link before the write — an undo then wrote/renamed outside the work tree). | All writes now go through `Folder` (Unix: `openat(O_DIRECTORY\|O_NOFOLLOW)` walk from the top, `mkdirat`/`symlinkat`/`renameat`/`unlinkat` relative to the handle — the `services::home_io` shape; Windows: checked paths). Every put-back is **staged** (temp beside its file) before the first change; a staging failure discards the temps and answers `undo_failed` with nothing changed. Only files whose folder the round removed are written after the removals. Commit re-walks the folders, so a swap after staging is refused. The PDF restore uses the same path (replaces `restore_pdf`; a link/folder at the PDF's name → `kept`). Tests `a_write_that_cannot_be_staged_changes_nothing`, `a_folder_swapped_for_a_link_after_staging_is_never_written_through`. |
| 6 | Put-back reset permissions to umask defaults (a `0600` file came back `0644`). | `stage` keeps the current file's permission bits; the exec bit follows the before-mode only when the round changed it. Test `a_files_permissions_survive_the_undo`. |
| 7 | No route-level test for the phone undo API. | `host.rs` test `an_apply_submit_answers_an_undo_the_phone_can_settle_preview_and_run`: apply Submit in a git project → `undo` id; settle (403 on a foreign origin), preview (project-relative only, no root/raw id), forged id / path-ish id / foreign tab → 404/410, undo puts the `.tex` back, second undo `410 undo_gone`. |

### Left as is (and why)

- **Partial undo after staging**: a `renameat` refused *after* staging (all
  temps written) still leaves some files back and answers `undo_failed`; a
  retry then meets those as conflicts. Narrow (same-folder renames), not
  worth a journal.
- **Seeded blobs live in the repo**: an unchanged file's blob is read from the
  repo's object store at undo time. A blob that becomes unreachable and is
  pruned within the 7-day round life (only staged-never-committed content)
  makes that undo `undo_failed` with nothing changed — never wrong bytes.
- **assume-unchanged / skip-worktree entries** in the copied index keep the
  index's blob in both snapshots, so an agent's edit to such a file is not
  undone (missed, never overwritten).
- **Dir ↔ file swaps** by the round (a file replaced by a folder of the same
  name) answer a false `undo_conflict` (the safe direction).
- **git version**: `git version` parse is fine (`2.39.3 (Apple Git-145)` → no
  undo, `2.40.1.windows.1` ok); < 2.40 stays `no_git`.
- `GET …/markup/undo/{id}` (preview) may settle an unsettled round without an
  `exact_origin` check (a GET); it only writes the round's own state, and the
  undo's conflict check guards the files. Left.
- `info/attributes` naming a conversion still → `filtered` (the attribute
  switch cannot reach it).

### Wire changes for Phase 2

None. Shapes, codes and statuses are as in the Phase 1 section. Semantics
only: `too_big` now means "more than 5 000 files / 64 MB to *copy* (changed
tracked + untracked), or more than 50 000 / 512 MB tracked to *hash*"; and
`undo_failed` is now almost always "nothing changed" (staging), but the rare
partial case is not distinguishable on the wire — keep a generic error line
rather than promising "nothing was changed".

### Gates (review)

- `cargo test` — the real tree's lib tests still do not compile (the other
  session's `round` literals: 10 errors, none in Phase 1/review code). Run on a
  scratch copy of the current tree with only those literals patched
  (`round: None`, 6-arg `submit_in_with`): **lib 3 317 passed, 2 ignored, 0
  failed** (+7 vs Phase 1: 6 in `markup_rounds`, 1 in `host`); every
  integration binary passes. `markup_rounds` 23/23.
- `cargo clippy --all-targets -- -D warnings` — clean on the scratch copy;
  `cargo clippy --lib -- -D warnings` clean on the real tree.
- Windows type-check (`cargo check --target x86_64-pc-windows-msvc`, RC/AR
  shims) — clean (the non-Unix `Folder`).
- `npm run lint` — 0 errors, 31 warnings (pre-existing, no TS touched).
- `scripts/brand-check.sh` — the same 3 pre-existing places, none ours.
- `git diff --check` — clean on the touched files.
- `npm run backend:stale` — "No Tabtivity process was identified, but the
  sidecar on 127.0.0.1:8742 is serving the bundle built in mobile-dist/. The
  Rust side could not be checked." The running sidecar/window does not have
  this backend; it needs the dev build after a commit.
- Not run live.

## Phase 2 — phone + desktop UI (2026-10-04)

No backend Rust touched. Wire shapes exactly as in the Phase 1 section
(`undo`, `/markup/undo/{undoId}[/settle]`, `pdf_markup_undo_*`).

### Files touched

| File | What |
|---|---|
| `mobile-web/src/markup/submitState.ts` | Header comment (two kinds of round; the default no longer asks first). `RoundUndo` `{ id, state: "ready" \| "done" }`, `Round.undo`; `startRound(queued, now, applied, undo?)`; `canApply` false for a round with `undo`; new `canUndo`, `undoneRound`, and `undoSummary` (the confirm text, shared by both hosts). |
| `mobile-web/src/markupInstruction.ts` | Header comment; `readMarkupInstruction`/`writeMarkupInstruction` treat **either** default as none; `readMarkupDirect`/`writeMarkupDirect` (flag `markupDirect`, absent = on); `defaultMarkupInstruction(direct)`; `markupUndoNote(files, more)` — the plan's chat note. |
| `mobile-web/src/prefs.ts` | `markupDirect` added to `MobileFlag` (+ doc line). |
| `mobile-web/src/api.ts` | `ApiError.detail` (the refusal body; `api()` passes it) so `undo_conflict` can name its files; `MarkupBody.mode`, `MarkupMode`; `MarkupAnswer` gains `mode`/`undo`/`noUndo`; `settleMarkupUndo`, `previewMarkupUndo`, `runMarkupUndo` (40 s deadline, above the backend's 30 s budget), `markupUndoConflict`; `MarkupUndoChanges`/`MarkupUndoFile`. |
| `mobile-web/src/components/MarkupView.tsx` | Submit sends `mode` from the switch and starts the round with the answer's `undo` (only when `mode === "apply"`); `noUndo` line; settle effect on every `finished` of a ready undo; **Undo** in the pill's Make-these-changes slot (same classes as that button); `OptionSheet` confirm (the phone's shared one-option confirm, as `Calendar`'s `ConfirmSheet`) with `undoSummary`; on success: round marked done, `markupUndoNote` sent the way Make these changes sends (`onSend` or `holdPrompt` into the opened tab) **without** a new round, then `reload()`; conflict / gone / failed lines; an answered `markup_ask` keeps the round's undo. |
| `mobile-web/src/components/MarkupInstructionSheet.tsx` | **Apply marks directly** checkbox above the fields (wrapped in the form's existing `mobile-schedule-weekdays` chip row — the only checkbox treatment inside `.mobile-schedule-form`), note line, untested pill; the instruction field starts from the current mode's default and swaps default↔default when the switch moves; Save stores it, Use the default resets it to on. |
| `src/lib/viewers/pdfMarkup.ts` | `submitPdfMarkup(…, mode?)`; `PdfMarkupResult` gains `mode`/`undo`/`noUndo`; `settlePdfMarkupUndo`, `previewPdfMarkupUndo`, `runPdfMarkupUndo`, `pdfMarkupUndoFailure` (reads the `{ code, files, more }` rejection); re-exports `DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION`, `markupUndoNote`; `pdfMarkupInstruction` (null for blank or either default). |
| `src/components/embed/pdf/usePdfMarkup.ts` | Submit sends `mode` from `pdf_markup_direct ?? true`, instruction via `pdfMarkupInstruction`; round gets the undo; settle effect; `roundUndo` (`offered`, `busy`, `preview`, `ask`, `confirm`, `cancel`, `note`, `noUndo`) — named so as not to clash with the layer's own `undo`/`canUndo`; the note is queued + held like Make these changes, no new round. |
| `src/components/embed/pdf/PdfMarkupBar.tsx` | **Undo** button beside Make these changes (same class expression), `noUndo` line, note/alert line, `ConfirmDialog` (shared `PromptDialogs`, `danger`) with `undoSummary`; on success calls `onReload` (= `reloadUnderMarks`, the Reload PDF path). |
| `src/components/layout/SettingsPanel.tsx` | `ToggleCard` **Apply marks directly** bound to `pdf_markup_direct` (unset = on) above the prompts; the Mark up prompt card's fallback follows the mode. |
| `src/types/index.ts` | `pdf_markup_direct?: boolean`. |
| `src/lib/i18n.ts` + `i18nDicts/{de,es,fr,it}.ts` | 28 new keys (`mobile.markup.undoRound*`, `mobile.markup.undo.*`, `mobile.markup.noUndo*` for all seven codes + `other`, `mobile.markup.direct.*`, `settings.pdfMarkupDirect*`) in all five languages; reworded `mobile.markup.instruction.default` and `settings.pdfMarkupInstructionHelp` (no longer "the default asks first"). |
| `src/lib/untested.ts` | Rows `desktop.markup.undo`, `mobile.markup.undo`. |
| Tests | `MobileMarkupRoundsCore.test.ts` (+3: canUndo/canApply/undone/startRound keeps undo; summary + note wording; defaults + switch storage), `MobileMarkupRounds.test.tsx` (+5: settle on finish → Undo → sheet → undo → reload + note, no new round, marks kept; conflict line, no note; `undo_failed` line; list fallback line + Make these changes, no settle; switch off sends `list`; two key lists now include `mode`), `MobileMarkupView.test.tsx` (payload includes `mode`), `PdfMarkupSubmit.test.tsx` (+4 alike; two payload checks include `mode`), `DesktopSettings.test.tsx` (+1 switch; instruction now starts from the apply default). |
| Docs | `docs/help/mobile.md` markup paragraph; `DOCUMENTATION.md` phone rounds section (new **Apply marks directly, with an Undo** paragraph) and the desktop PDF markup bullet; `docs/filemap_frontend.md` MarkupView + desktop markup rows (one sentence each); QA sub-item under 31bt in `todo/group-h-crossplatform.md` with the four platform pairs. |
| `mobile-dist/` | Rebuilt (`npm run build` runs `mobile:bundle`). |

### Design choices

1. **The answer decides, not the switch.** Undo only when the answer says
   `mode: "apply"` with an `undo` id; anything else (incl. an older backend that
   answers neither) is a `list` round with Make these changes. The fallback line
   shows only when the switch asked for `apply` and the answer carries a
   `noUndo` code.
2. **Phone switch is a flag** (`readFlag("markupDirect", true)`), not
   `writeChoice` as the plan sketched: same `prefs.ts` store, and the flag
   helpers already give "absent = on". Lives in the Mark up prompt sheet and is
   stored on **Save** with the rest of the sheet.
3. **Undo button label/name**: visible text "Undo", accessible name / title
   "Undo the agent's changes from this round" — the toolbar's layer ↶ already
   owns the name "Undo" (`mobile.markup.undo`), so the pill's keys are
   `mobile.markup.undoRound*`. Hidden while the agent has open `markup_ask`
   questions, like Make these changes.
4. **Confirm**: phone = `OptionSheet` with one option (the phone's existing
   confirm pattern, rendered inside the viewer so it stacks above it); desktop =
   `ConfirmDialog` (`danger`, Cancel focused). Text from `undoSummary`: files
   joined, "and N more", plus the PDF line (`restored` → goes back, `kept` →
   changed since, stays, `none` → nothing).
5. **Errors**: `undo_conflict` → "Can't undo — `a.tex` changed since. Nothing
   was changed." (Undo stays offered); `undo_gone` / `round_not_found` → "no
   longer available" and the round's undo is marked done; anything else
   (incl. `undo_failed`) → a generic line that does **not** promise nothing
   changed (per the Phase 1 review). Preview failures get their own line.
   Settle failures are silent.
6. **Chat note** is `markupUndoNote` in `markupInstruction.ts` (English, like
   every other agent prompt), files back-quoted. If it cannot be sent, the undo
   still counts and an alert line says the note was not sent.
7. **Reload after undo**: phone calls the view's own `reload()` (PDF only);
   desktop calls the bar's `onReload` (`reloadUnderMarks`). For a phone outbox
   copy, Reload looks for the newest copy the agent sent — after an undo that
   is still the agent's rebuilt copy, not the restored project file (see open
   points).
8. **Instruction defaults**: both hosts treat either mode's default as "no
   instruction" (phone `readMarkupInstruction`, desktop `pdfMarkupInstruction`),
   so a default saved under one mode never pins the other's wording.

### Gates

- `npm run build` — passes (tsc + both bundles + `mobile:bundle`); only the
  pre-existing chunk-size / dynamic-import notes.
- `npm test -- --reporter=dot` — **705 files, 7 201 tests passed** (Phase 1:
  7 188).
- `npm run lint` — 0 errors, 31 warnings, all pre-existing (none in touched
  files; `eslint` on the touched files alone is clean).
- `scripts/brand-check.sh` — the same 3 pre-existing places
  (`screenshots/tabtivity-promo.{gif,mp4}`, `mobile-web/src/terminal/inboxRefs.ts:12`).
- `git diff --check` on the touched files — clean.
- `cargo test` / `clippy` — not re-run: no Rust touched in this phase.
- `npm run backend:stale` — "No Tabtivity process was identified, but the
  sidecar on 127.0.0.1:8742 is serving … the bundle built in mobile-dist/. The
  Rust side could not be checked." The running window has neither half; it
  needs the dev build after a commit.
- Not run live.

### Open points

- **Phone outbox copies**: after an undo, Reload of an outbox-scope view picks
  the newest copy the agent *sent* (the post-edit build), not the restored
  project PDF. Views opened on the project file itself (files drawer, or an
  outbox copy with a `file_row`) reload the restored file. Fixing that needs
  the reload to prefer the project file after an undo — left for review.
- The undo is offered until the next Submit or the view closes (not
  persisted), as the plan says; a reopened view over sent marks follows the
  agent without an undo.
- The note turn makes the pill follow the agent again ("working" →
  "finished"); no settle is sent for it (the undo is `done`).
- The other session's `round` id / `markup_done` work was not present in the
  TS files at the time of editing; `startRound`'s new fourth argument and
  `submitPdfMarkup`'s sixth (`mode`) may need merging with it.

## Phase 2 review (2026-10-04)

Reviewed the undo/direct-apply hunks only (other sessions' ask dial,
auto-reload, subagent, eraser, anchors hunks in the same files left alone).
State machine (`canUndo` only on an apply round with a `ready` undo once
`finished`/`unconfirmed`; `canApply` never on one), settle once per entry to
`finished` (effect keyed on `round.since` + undo id — no loop, no storm), the
error codes and `noUndo` lines (all seven + `other`), older-backend answers
(no `mode` → list), the switch defaults (phone flag absent = on, desktop
`pdf_markup_direct ?? true`), i18n (English holds every key), untested pills +
rows, and the copied sibling classes (Undo = Make these changes' classes;
phone `OptionSheet`, desktop shared `ConfirmDialog`) check out.

### Found and fixed

| # | Finding | Fix |
|---|---|---|
| 1 | **A slow undo answer acted on a newer round.** `askUndo`/`runUndo`/`confirmUndo` read the id from the *current* round and `undoneRound` marked whatever round was current: a preview that answered after a new Submit opened the old round's file list over the new round, and its **Undo** then ran the **new** round's id; an undo/`undo_gone` that answered late marked the new round's Undo done. | `submitState.ts`: `undoneRound(round, id)` changes only the round holding that id; new `holdsUndo(round, id)`. Phone `MarkupView.tsx` and desktop `usePdfMarkup.ts`: the confirm sheet/dialog carries the id it was read for (`{ id, changes }`) and the confirm runs that id; a preview answer opens the sheet / says its failure only while the round still holds the id. Tests: core `undoneRound`/`holdsUndo` cases. |
| 2 | **Double tap could send two requests** (busy guard read `undoBusy` state from the click's closure). | `undoBusyRef` set synchronously on both hosts (preview and undo). Test: desktop double click → one preview. |
| 3 | **Phone outbox view: Reload after Undo showed the agent's post-edit copy** (open point). After an undo the agent's sent copies show the undone edits, and an outbox source keeps no `before.pdf`; the note's turn then auto-reloaded that copy again on finish. | `MarkupView.tsx`: the Submit remembers the copy its marks were drawn on (`roundFile`); after an undo in an outbox view the view reloads **that** copy (`reload(false, target)`), and remembers the newest copy the agent had sent by then (`undoneUpTo`); `freshFile` (now used by Reload and by the look after each finish) answers those copies as "nothing newer", so a later agent copy still loads. Project-file views reload as before (the restored file). Test: outbox round → auto-reload to the agent's copy → Undo → back on the marked copy → the note's turn finishes "PDF unchanged", no layer move. |
| 4 | Post-undo reload ran even when the view had closed meanwhile (moving the stored layer to another key with no view). | `viewUp` ref; the note still goes out, the reload does not. |
| 5 | The fallback line ("No undo here … lists the changes first") stayed on the **Make these changes** round. | Cleared on that follow-up (both hosts). Test: desktop list round → Make these changes → line gone. |
| 6 | Desktop Settings showed the **list** default as a custom instruction when an older build had kept it as the setting (Use the default enabled, field ≠ what a Submit sends). | `SettingsPanel.tsx`: the instruction card gets no value while `pdfMarkupInstruction` says it is either default. Test added (and a custom one round-trips as typed, trailing space kept). |
| 7 | Phone **Use the default** switched **Apply marks directly** back on. | `MarkupInstructionSheet.tsx`: the prompts reset, the switch stays as set (the default instruction is then that mode's) — as on the desktop, where the switch is its own setting. Test: switch off → field follows to the list default → Use the default → still off; a custom instruction does not follow the switch. |
| 8 | Settings search did not find the switch. | `SEARCH_KEYS.pdfMarkup` gains `settings.pdfMarkupDirect`. |
| 9 | Older backend / `undo_gone` on the desktop untested. | Tests: an answer without `mode` → Make these changes, no line, no settle; preview `undo_gone` → "no longer available", Undo gone, no dialog. |

Docs: `DOCUMENTATION.md` apply-directly paragraph gains the outbox-copy
sentence.

### Left as is (and why)

- **Settle is not held back in a hidden desktop pane** (AGENTS.md "gate work
  in hidden panes"): deliberate, comment in `usePdfMarkup.ts`. The
  after-snapshot must be the agent's finish; deferring it to the next show
  would sweep the user's own edits made meanwhile (another pane, an editor)
  into the round, and the Undo would revert them. It is one call per finish,
  never a poll; the round machine itself already runs while hidden.
- **Outbox copy gone**: if the copy the marks were drawn on was deleted from
  the outbox before the undo, the post-undo reload fetches a missing file and
  the view shows its load failure (Reload then finds the newest copy again,
  passing over the undone ones). Rare; not worth a listing round-trip.
- **A finished-and-changed pill after an undo without a reload** (outbox view
  that never loaded the agent's copy) keeps its "PDF changed" words until the
  next finish; Reload then says no newer version. Cosmetic.
- **The other session's `round` id / `markup_done`**: still backend-only (no
  `round` in `submitMarkup`/`submitPdfMarkup` or `startRound` callers in TS);
  nothing to reconcile yet. When it lands, `submitPdfMarkup`'s positional
  args (`instruction, ask, mode`) and `startRound(queued, now, applied, undo)`
  are the merge points; the wire names do not clash (`undo` vs `round`).
- `NO_UNDO_KEYS` is duplicated in `MarkupView.tsx` and `PdfMarkupBar.tsx`
  (same as `ROUND_KEYS` already is). Left.

### Gates (review)

- `npm run build` — passes (tsc + both bundles + phone bundle); only the
  chunk-size notes.
- `npm test -- --reporter=dot` — **705 files, 7 207 tests passed** (+6 vs
  Phase 2).
- `npm run lint` — 0 errors, 31 warnings, all pre-existing (`eslint` on the
  touched files alone: clean).
- `scripts/brand-check.sh` — the same 3 pre-existing places
  (`screenshots/tabtivity-promo.{gif,mp4}`, `mobile-web/src/terminal/inboxRefs.ts:12`).
- `git diff --check` on the touched files — clean.
- No Rust touched: `cargo test`/`clippy` not re-run.
- `npm run backend:stale` — "No Tabtivity process was identified, but the
  sidecar on 127.0.0.1:8742 is serving … the bundle built in mobile-dist/. The
  Rust side could not be checked." Needs the dev build after a commit.
- Not run live.

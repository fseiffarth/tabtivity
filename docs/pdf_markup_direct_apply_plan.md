# PDF markup: apply the marks directly, with an Undo

Status: **implemented 2026-10-04** — phases 1 and 2 built and reviewed
(uncommitted, never run live; `docs/pdf_markup_direct_apply_handoff.md`,
whose wire names — `undo`, not `round` — override §2.4; untested ids
`mobile.markup.undo`, `desktop.markup.undo`). Builds on `docs/pdf_markup_rounds_plan.md`
(rounds, status pill, Reload, **Make these changes** — §2.8) and
`docs/markup_questions_mcp_plan.md` (`markup_ask`). Phone and desktop.

---

## 1. Context

Today a markup round has two steps: Submit sends the marks with
`DEFAULT_INSTRUCTION` ("list the changes … do not change any file yet"); once
the agent has finished, the pill offers **Make these changes**, which sends the
apply prompt (`DEFAULT_MARKUP_APPLY` / `DEFAULT_PDF_MARKUP_APPLY`). The list
step was added because an agent told to "apply my marks" edited the `.tex`
beside a PDF unasked.

The user (2026-10-04): *"isn't it better to directly make these changes and
add an undo button?"* — yes, provided the undo is real. Most marks are plain
corrections (typo, deleted word); the review step costs a whole extra round
for them, and the ambiguous ones are already handled by `markup_ask` and the
reader's ask dial (`ASK_LINES`).

Goal: by default a Submit makes the changes, rebuilds and (phone) sends the
PDF back in one turn; once the round has finished the pill offers **Undo**,
which puts every file the round changed back as it was — without touching
anything the user changed since, and refusing rather than overwriting when it
cannot. Where no reliable undo exists, the round stays list-first.

## 2. Decisions

### 2.1 Mode

- A per-host switch **Apply marks directly** (default **on**):
  - phone: Home → This phone → **Mark up prompt** section, a switch above the
    two prompt fields; stored with `writeChoice("markupDirect", …)` in
    `mobile-web/src/prefs.ts` style, absent = on;
  - desktop: Settings → Agents → PDF markup, `pdf_markup_direct: bool` in
    `src-tauri/src/schema/settings.rs` with a serde default of `true` (old
    settings files without the key round-trip and get `true`).
- The Submit request carries `mode: "apply" | "list"` (phone `MarkupRequest`,
  `deny_unknown_fields` → add the field with `#[serde(default)]`; desktop
  `pdf_markup_submit` gets `mode: Option<String>`). Absent = `list`, so an old
  phone bundle against a new desktop keeps today's behaviour.
- **Effective mode** is decided by the backend: `apply` only if the user asked
  for it **and** the round snapshot (§2.2) succeeded. Otherwise `list`. The
  response says which: `{ prompt, marked, round: Option<id>, mode }`. The UI
  trusts the response, never its own switch, to choose between **Undo** and
  **Make these changes**.
- The instruction: the user's own text when set (unchanged); else
  `DEFAULT_INSTRUCTION` for `list`, a new `DEFAULT_APPLY_INSTRUCTION` for
  `apply`:

  > Make the changes these marks ask for (strike-throughs, insertions, circled
  > parts, margin notes): edit the sources the PDF is built from — not the PDF
  > itself and not the marked copy — and rebuild it. Afterwards list what you
  > changed, and any mark you could not read.

  The ask line (`ask_line`) and the send-back line follow it as today. The
  phone keeps a mirror constant in `mobile-web/src/markupInstruction.ts` with
  the same equality test as `DEFAULT_MARKUP_INSTRUCTION`. The settings field's
  "Use the default" / starting text shows the default of the current mode.
  A custom instruction is the user's: it is sent as written in either mode;
  the Undo is offered whenever a snapshot exists.
- When effective mode falls back to `list` although the switch is on, the pill
  says why once, in one short line (i18n): *"No undo for this folder (not a
  git repository / too many untracked files / git unavailable) — the agent
  lists the changes first."*

### 2.2 Snapshots: git trees in Tabtivity's own object store

A new AppHandle-free service `src-tauri/src/services/markup_rounds.rs`
(unit-testable with temp repos, like `services::git_*` tests).

- **Where the round lives:** `<state_dir>/markup-rounds/<id>/` with
  `round.json`, `objects/` and `index`. `<id>` is 128 random bits, hex. Never
  anything inside the project folder: the snapshot's objects are written to
  the round's own `objects/` via `GIT_OBJECT_DIRECTORY`, with the repo's
  object dir as `GIT_ALTERNATE_OBJECT_DIRECTORIES` (read only), and the
  private `index` via `GIT_INDEX_FILE`. So nothing is written to the user's
  `.git`, and `git gc` there cannot prune a live snapshot.
- **Every git call** goes through `commands::git::hardened_git_command_in`
  (hooks off, config sanitized, common dir pinned) with `--no-ext-diff
  --no-textconv` on diffs, `core.fsmonitor=false`, and a timeout (20 s per
  call; over it → no undo). Locate the repo with `rev-parse --show-toplevel
  --git-dir --git-common-dir` from the project root; the snapshot covers the
  whole work tree (an agent may edit outside the PDF's folder). *(2026-10-04,
  #2345: the undo puts back only files under the project folder; the rest of
  the tree is diffed only to name what changed outside it, left alone.)*
- **`begin(state_dir, root, owner, pdf: Option<rel>, pdf_bytes) -> Result<RoundId, NoUndo>`**
  1. Not a git work tree / no `git` binary → `NoUndo::NotGit` / `NoUndo::NoGit`.
  2. Bound the untracked part first: `ls-files --others --exclude-standard -z`;
     more than 5 000 files or 64 MB together → `NoUndo::TooBig` (a data folder
     that is not ignored must not be copied into the state dir every round).
  3. Copy the repo's index into the round's `index` (stat cache → `add` is
     cheap on a large tree; missing index is fine), then `add -A` and
     `write-tree` → `tree_before`.
  4. A project-file PDF source (not an outbox leaf) ≤ 64 MB: keep its bytes
     (already read by `submit`) as `before.pdf`, its rel path in the record —
     a built PDF is usually git-ignored, so the tree does not hold it.
  5. Write `round.json` `{ v: 1, owner, root, toplevel, tree_before,
     tree_after: null, pdf, pdf_after_sha256: null, created, undone: false }`.
     `owner` = the phone tab id + project raw id, or the desktop project id —
     checked by every later call (§2.4).
  6. Prune: rounds older than 7 days, and all but the newest 30 overall.
- **`settle(id)`**: the same `add -A` / `write-tree` with the same bounds →
  `tree_after`, plus `pdf_after_sha256` of the PDF now. Called every time a
  round reaches `finished` (a later turn after a `markup_ask` answer moves it
  on again — last settle wins). Over the bounds → the round loses its undo.
- **`preview(id)`**: settles first when `tree_after` is still null (an
  `unconfirmed` round); then `diff --name-status -z tree_before tree_after`
  → the changed files, as paths relative to the project root (outside it:
  counted, not named), at most 50 listed plus a count. Plus whether the PDF
  will be restored.
- **`undo(id)`**:
  1. Refuse if `undone` or `tree_after` is null.
  2. `diff --binary --full-index tree_before tree_after` → patch;
     `apply -R --check` in the toplevel, then `apply -R` (working tree only —
     never `--index`, never `checkout`/`reset`). A failing check → `Conflict {
     files }` and **nothing** is changed: the user (or another tab) edited one
     of these files since the round.
  3. The PDF, when `before.pdf` exists and the PDF is not in the diff: if its
     sha256 still equals `pdf_after_sha256`, write `before.pdf` back
     (temp file + rename); if it changed since, leave it and say so.
  4. Record `undone: true`; return `{ files, pdf: "restored" | "kept" | "none" }`.
- The round's diff covers **everything** that changed in the work tree during
  the round, including edits by another tab, and edits from the agent's
  previous turn when the Submit was queued behind it. That is why Undo always
  shows the file list first (§2.3) and why the 3-way check refuses rather than
  merging.
- Remote projects: the desktop Submit already refuses them
  (`commands::pdf_markup::local_root`); the phone route works on the local
  root only. No remote snapshot in this plan — remote rounds stay `list`.
- Nothing here runs project code: no hooks, no filters beyond what
  `hardened_git_command_in` already pins, and `apply` never runs a program.

### 2.3 The pill and the Undo

Shared logic in `mobile-web/src/markup/submitState.ts` (used by both hosts):

- `Round` gains `undo?: { id: string; state: "ready" | "done" }` (absent =
  list mode). `canApply` stays as is but is false for a round with `undo`;
  a new `canUndo(round)` = `undo.state === "ready"` and phase `finished` or
  `unconfirmed`.
- When a round with `undo` enters `finished`, the host calls settle (phone:
  new API call; desktop: tauri command). Errors are silent (the next settle or
  the preview tries again).
- **Undo** button on the pill (the same slot and class as **Make these
  changes** — copy the sibling, no new treatment). Tap → the shared confirm
  dialog: *"Undo the agent's changes from these marks?"*, the file list from
  `preview`, and the PDF line ("The PDF goes back to before" / "The PDF has
  changed since — it stays"). **Undo** / **Cancel**.
- After a successful undo: reload the PDF (the existing Reload path), mark the
  round `done`, and send a short note into the agent's chat the way **Make
  these changes** sends its prompt, but **without** starting a new round:
  > I undid your edits from my last marks: `a.tex`, `b.bib` are back as they
  > were before that round. Don't redo them; no need to reply.
- Conflict → an inline error on the pill: *"Can't undo — `a.tex` changed
  since. Nothing was changed."*
- The undo is offered until a new Submit replaces the round or the view
  closes (the round lives in the view's state, as today). Not persisted.
- The sent marks stay shown after an undo (user rule: markers are never
  removed automatically).
- `list` mode is today's flow, unchanged: **Make these changes**.

### 2.4 Wire

Phone (`services::mobile_control::host`, beside `markup_submit`):

- `POST /api/v1/tabs/{tab}/markup` — request `mode`; response `round`, `mode`,
  `noUndo` (a fixed reason code when the switch asked for `apply` but got
  `list`).
- `POST /api/v1/tabs/{tab}/markup/rounds/{round}/settle` → `{}`.
- `GET  /api/v1/tabs/{tab}/markup/rounds/{round}` → `{ files, more, pdf }`.
- `POST /api/v1/tabs/{tab}/markup/rounds/{round}/undo` → `{ files, pdf }`, or
  409 `{ error: "undo_conflict", files }`, 410 `undo_gone` (pruned/undone).
- Same `authenticate` + `exact_origin` gates as `markup_submit`; the round id
  is checked hex; the round's `owner` must be this tab and its project, else
  404. Paths in answers are project-relative display names only (as the
  markup prompt already carries) — no root, no raw ids.

Desktop (`src-tauri/src/commands/pdf_markup.rs`, registered with the other
markup commands): `pdf_markup_submit({ …, mode })` →
`{ prompt, marked, round, mode, noUndo }`; `pdf_markup_round_settle({ projectId,
round })`, `pdf_markup_round_preview(…)`, `pdf_markup_round_undo(…)`. camelCase
payloads. Blocking work in `spawn_blocking`.

### 2.5 Untested tags, i18n, docs

- `UntestedTag` pills + register rows `mobile.markup.undo`,
  `desktop.markup.undo` (`src/lib/untested.ts`) on the Undo button and the
  new switch.
- All strings through `src/lib/i18n.ts` (English holds every key); the phone
  uses its existing i18n path.
- Docs: `docs/help/mobile.md` (the markup paragraph that explains Make these
  changes), the matching `DOCUMENTATION.md` section (`rg -n "Make these
  changes"`), `docs/filemap_backend.md` row for `services/markup_rounds.rs`,
  `docs/filemap_frontend.md` if a load-bearing file is reshaped. A QA sub-item
  under 31bt in `todo/group-h-crossplatform.md` with the platform pairs.
- Update the doc comments that say the default asks first
  (`markup.rs` `DEFAULT_INSTRUCTION`, `markupInstruction.ts`, `submitState.ts`
  header).

## 3. Phases (one implementing subagent each, a reviewer after each)

Work in the shared tree on the current branch, **uncommitted** (the tree holds
other sessions' uncommitted work, including in `markup.rs` — re-read a file
right before each edit, edit surgically, never stash, never revert hunks you
did not write). Each phase writes/extends `docs/pdf_markup_direct_apply_handoff.md`:
files touched, design taken, gates and test counts, open points.

### Phase 1 — backend

`services/markup_rounds.rs` (§2.2) with tests on temp repos: begin/settle/undo
round trip; tracked edit, new untracked file, deleted file, binary file; a
later user edit to another file survives the undo; a later edit to the same
file → conflict, tree untouched; ignored PDF restored only when unchanged
since settle; not-a-repo and too-big → `NoUndo`; nothing written under the
repo's `.git` (assert its object count/mtime unchanged); owner mismatch
refused; prune. `DEFAULT_APPLY_INSTRUCTION` + `mode` in `markup.rs`
(`submit`, `submit_local`, `MarkupRequest`), the routes (§2.4) in `host.rs`,
the desktop commands, `pdf_markup_direct` in settings.

### Phase 2 — phone + desktop UI

`submitState.ts` (`undo`, `canUndo`), `MarkupView.tsx` + `mobile-web/src/api.ts`
(phone), `usePdfMarkup.ts` + the markup strip (desktop), the switch in both
settings, the confirm dialog, the chat note, i18n, untested rows, docs (§2.5),
`npm run mobile:bundle`. Tests beside the existing ones
(`src/__tests__/mobile/MobileMarkupRounds*.test.*`,
`src/__tests__/pdf/PdfMarkupSubmit.test.tsx`).

## 4. Verification

- All gates in `AGENTS.md`, plus `npm run backend:stale` (report its result —
  the running window needs a rebuild for the backend half), `git diff --check`.
- Not run live. Manual QA (the user, after the dev build): a LaTeX project in
  git — mark a typo, Submit → one turn edits + rebuilds; pill → Undo → file
  list → Undo → `.tex` and PDF back, note in the chat; edit the `.tex` by hand
  after the round → Undo refuses naming it; a folder that is not a git repo →
  the fallback line and **Make these changes**; switch off → list-first as
  before.

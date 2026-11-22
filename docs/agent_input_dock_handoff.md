# Agent input dock — handoff

Plan: `docs/agent_input_dock_plan.md` (S1–S5). Branch `input-dock`, BASE
`ca855ae67` (`develop` when the run started). Frontend only; nothing was run
live: no Tabtivity window was started for this.

## Steps

| Step | Commit | What changed |
|---|---|---|
| S1 | `8c425a708` | `TerminalReaderChanges` / `TerminalReaderFiles` render inside `.terminal-reader`, after `.terminal-reader-stream`, before the facts row (H7). The root's `hidden` is `!shown` only; `panel-open` while a panel is open. H1 (`terminalScroll` `readerList`), H2 (panel `z-index: 0`), H3 (`onRegionKey` ignores keys from inside `.terminal-changes`), H4 (the browsed-chat focus effect skips panels), H5 comment. CSS hid facts row, composer, error, waiting and chat foot under `panel-open`, so no visible change. |
| S2 | `4b1280ffa` | `ReaderComposer`: `visible={visible && shown}`, new `docked` / `resting` / `onBusy`, `acceptInserts` / `onReveal` / `revealRef` removed (D7). Resting: `rows={1}`, `dockPlaceholder` or `dockBlocked`, the height effect keyed on `[draft, resting]`. ↑/↓ question walk off while `docked`. `TerminalReaderView`: `panelShown`, hoisted `questionOpen` / `inputBlocked`, `composerBusy`, `dockEngaged` (D3: React `onPointerDown`/`onFocus` on `.terminal-reader-dock` record the native event; document `pointerdown`/`focusin` bubble listeners, only while `panelShown && dockEngaged`, clear it), `dockOpen` (D2), root class `dock-open`. CSS: S1's hide rule narrowed to the resting facts row and chips; resting strip/field; `.terminal-reader-dock { display: contents }`. Strings `dockPlaceholder`, `dockBlocked` (5 dictionaries). Pill `terminal.reader.dock` + register row. |
| S3 | `7d3bac121` | `ReaderDockStatus.tsx` (D8 props), rendered between the panel and the dock while `panelShown && !browsed`: question (outranks), subagent working, session working. "Answer in Chat" = `onShowChat` then `focusQuestionOption(root)` on the next tick. CSS strip; the dock under it drops its own top rule. Strings `dockQuestion`, `dockQuestionHint`, `dockAnswerInChat`, `dockQueued`. |
| S4 | `e26b6b958` | Tests: Add to draft keeps Diffs with the field open (`ReaderDiffNotes`), steering's Prompt key under Diffs opens the docked field and Esc gives `scroll` back (`TerminalReaderView.test`). Comments in `TerminalReaderChanges` `addToDraft`, `TerminalPromptStrip` `reuse`, `readerSteering.ts`. |
| S5 | `0fd1df0c1` | `ReaderInputDock.test.tsx` (10 tests), `docs/context/agent_reader.md`, `docs/filemap_frontend.md` (new `ReaderDockStatus` row; `TerminalReaderView`, `TerminalReaderChanges`, `steeringAgent`, `terminalScroll` rows), `docs/help/agent-clis.md`, `docs/help/keyboard.md`, `todo/group-s-agents.md` (new item + the diff-notes QA wording). |

This handoff is its own final docs commit after S5.

## Choices and deviations

- **Test updates moved earlier, to keep each commit green.** S1 already makes
  the composer findable under a panel (the root is no longer `hidden`), so the
  two `TerminalReaderToolbar` assertions `queryByRole("textbox")` → `null`
  (Diffs, Data) changed in S1, not S2. S2 removes the reveal, so the
  Toolbar's "returns to Chat when … inserted while reviewing Diffs" was
  inverted and renamed in S2 (plan: S4). S4 keeps the other two tests and the
  comments.
- **Resting placeholder** is `dockPlaceholder` also with a subagent open (the
  subagent's own placeholder is the long one; the plan asked for the short
  text). Open, the subagent placeholder is back.
- **"Answer in Chat"** uses the existing `.terminal-reader-chat-resume` class
  (the accent pill of Resume this chat); Stop uses `.terminal-reader-stop`.
  No new colours.
- **Status line top rule**: done with sibling selectors
  (`.terminal-reader-dock-status + .terminal-reader-dock …`), no root class.
- **Pill placement**: `.terminal-reader-dock-tag`, absolutely placed: left of
  the mic in the resting line, top right in the open box (like the prompt
  suggestion's pill).
- **Resting mic/Send offsets**: `right: 4px; bottom: 3px` (Send) and
  `right: 36px; bottom: 6px` (mic): the plain offsets, nudged 1 px so both sit
  centred in the 34 px line.
- Steering's Prompt key under Diffs/Data while a question waits keeps Chat's
  rule (field enabled, rests, Enter keeps the text), as confirmed.

## Gotchas for a reviewer

- jsdom loads no CSS: Chat's list, working row and question rows are in the
  document under a panel. Tests query `.terminal-reader-dock` /
  `.terminal-reader-dock-status` and assert `panel-open` / `dock-open`.
- `fireEvent.click` moves no focus in jsdom, so the "keyboard stays on the
  panel" test focuses `.terminal-changes` itself, as `TerminalView`
  `focusReaderView` does; it proves nothing in the Reader takes the keys back,
  not the focus move.
- `dockEngaged` is only set while `panelShown` (`engageDock` returns early in
  Chat), so a box focused in Chat does not arrive open under Diffs.
- `composerBusy` is not reset when the composer unmounts (browsed chat, key
  change); `dockOpen` already requires `!browsed`, and a remounted composer
  reports its own value on mount.
- Under a panel, `useCheckpointNow` and `useReaderVoice` now see
  `visible = true` (plan S2/D10, accepted there): checkpoints are listed and
  the hands-free loop may re-listen under Diffs/Data.
- `docs/help/*.md` are embedded by `src-tauri/build.rs` (help MCP), so the
  gate run selected the Rust gates too; the help text a running build serves
  changes only with a rebuild.

## Gates

Baseline (BASE, before the first edit): `npm test` 13356 tests in 1272 files,
all passing; `npm run lint` 0 errors, 31 warnings.

After S5 (`scripts/gates-job.sh start --base ca855ae67`, job
`/tmp/gates-job.FgVvzi`): brand PASS, whitespace PASS, `npm run lint` PASS
(0 errors, 31 warnings: no new one), the three clippy gates PASS,
`npm run build` PASS, `vitest --changed` PASS. `cargo test -p tabtivity -p
app-serverd` failed once on
`terminal::host_pty::tests::a_dead_remain_on_exit_pane_stays_open_until_killed`
(a known load-flaky test; no Rust was changed). Rerun alone, the
`host_pty` tests pass (5/5), so `test-dlib` was not reached. Run by hand
afterwards: `cargo test -p tabtivity --no-default-features --lib --test
server_secrets` passes (6187 passed, 18 ignored). The job also said the tree
changed while it ran: that was this handoff file, which was untracked then.

Full `npm test` after S5: 13368 tests in 1273 files, all passing (+12: 10 in
`ReaderInputDock.test.tsx`, the H3 Esc test, the steering Prompt-key test
under Diffs). `git diff --check ca855ae67..HEAD` clean;
`scripts/privacy-check.sh ca855ae67 HEAD` clean.

## Flagged for user

- Nothing was run live. The click-through is the plan's Verification list and
  the new manual QA item in `todo/group-s-agents.md`.
- Design doubt: at rest, the one-line field still shows a kept draft only as
  its first line (decision 6: a question waits). Nothing tells the user more
  text is there besides the clipped line.
- The resting line's exact height (34 px) against the theme's `--text-md` line
  height was not seen on the real paint path; a draft line could be clipped by
  a pixel. Check on WebKitGTK.

## Final review

Reviewer: the range `ca855ae67..c7a163fd7` read commit by commit against the
plan; fixes on top. Nothing was run live.

### Fixed

- `b0b130525` **The dock stayed open once steering's Prompt key handed the
  field back.** `dockEngaged` was cleared only by a press or focus landing
  elsewhere. Esc or Enter in a Prompt-key field (`backToSteering` blurs the
  box), the box locking for a question, or the composer hiding for steering
  all lose focus to nowhere, so the dock stayed `dock-open`: the facts row
  drawn over the Diffs cursor, and the empty dock open again when steering
  let go. Now a blur to nowhere (`onBlur` on `.terminal-reader-dock`,
  `relatedTarget === null`) ends the engagement, except while a press that
  began in the dock is still down (WebKit blurs the field under a chip's
  press: D3 holds) or the window, not the page, lost focus (the field is still
  `activeElement`). Tests in `ReaderInputDock.test.tsx`: "rests again once
  steering's Prompt key has handed the field back" (failed before the fix) and
  "keeps the dock open while a press in it, or the window, takes the field's
  focus away" (guards the exceptions).
- `3eee89407` **Esc in a dialog from Diffs/Data, with an earlier chat browsed,
  ran the chat's Back and kept the dialog open.** S1 made the panels React
  children of the root, so a dialog they portal out (Diffs' Clear-notes
  confirm, `useDialogs`) bubbles its keydown into `onRegionKey`; its target is
  outside `.terminal-changes`, so H3's check missed it, and `preventDefault`
  stopped `useModalFocus` closing the dialog. While a panel is shown, a key
  from outside the root's DOM is now the panel's. Chat without a panel is
  unchanged. Test: `TerminalReaderChanges.test.tsx` "closes a dialog the Diffs
  panel opened on Esc, keeping an earlier chat" (failed before the fix).
- `c58da06e6` `docs/filemap_frontend.md` `DiffNoteBox` row still said Add to
  draft "reveals Chat itself".

### Flagged for user

- **Likely bug, not fixed (touches D3, needs paint):** a click on the mic in
  the *resting* line probably does not start dictation. The pointerdown
  engages the dock (D3), which opens on that press; the mic moves from
  `right 36px / bottom 6px` in a 34 px line with 8 px strip padding to the
  card composer's `right 42px / bottom 12px` with 18 px padding: its centre
  moves ~16 px up and ~10 px left, off the pointer. The pointerup then lands on
  the textarea, the click goes to their common ancestor, and the mic's
  `onClick` never runs; a second click works. Possible fix: a pointerdown on a
  button in the resting line records the event (so it is not "elsewhere") but
  does not engage; the mic's listening (`composerBusy`) then opens the dock
  after the click. Check on WebKitGTK first.
- Cosmetic: under Diffs/Data steering's `card` region outline
  (`.subwindow.focused .terminal-sign-in`) now draws twice, on the Reader root
  and on the panel inside it (both carry `terminal-sign-in`).
- Cosmetic: with the dock open, an empty field and Claude's suggestion shown,
  the dock pill and the suggestion pill sit at the same spot (both
  `top: 4px; right: 12px`).
- `docs/help/agent-clis.md` says "under Diffs and Files"; the UI tab is
  "Data", but that page already calls the view **Files** elsewhere, so it was
  left as is.
- Side effect of the blur fix: after picking from a facts-row menu with an
  empty field, the dock rests again (nothing holds it: no focus, no draft),
  where before it stayed open until the next press elsewhere.

### Checked and sound

Chat unchanged in focus (composer focus effect, `focusReaderView`), `hidden`
only `!shown`, `panel-open`/`dock-open` classes; Tabby/`readerAlways` and
attach-only views never get a panel; browsed and subagent states (foot,
placeholders, status line values per D8, Stop only with `live.working`);
`composerBusy` reported only on change (no per-keystroke render of the view);
height effect at rest vs open and a kept blocked draft; every
`insertIntoReader` caller (drop, paste, diff notes, prompt strip, checkpoint
restore, selection menu) with `onReveal`/`acceptInserts` gone; inserts in a
hidden pane or Terminal (no composer registered, falls back as before);
`terminalScroll` `readerList`; CSS specificity of the resting rules over the
`card-composer` ones, no selector reaching panel content, upward menus
(z 2/1) over the panel (z 0), no new animation, theme tokens only,
`.terminal-reader[hidden]`; i18n keys in all five dictionaries; the pill and
its register row; the todo item's format; brand.

Not checked: anything on a real paint path (positions, clipping of the 34 px
line), WebView2/WKWebView focus behaviour, the phone.

### Gates after the review fixes

The full gates were **not** rerun after these fixes: the user said to skip
them (a `gates-job.sh` run was started and left unfinished). Run here:
`vitest` on `ReaderInputDock.test.tsx`, `TerminalReaderView.test.tsx`,
`TerminalReaderToolbar.test.tsx`, `ReaderDiffNotes.test.tsx` (4 files, 112
tests, pass) and `TerminalReaderChanges.test.tsx` (8 tests, pass);
`git diff --check ca855ae67..HEAD` clean; `scripts/privacy-check.sh
ca855ae67 HEAD` clean; `scripts/brand-check.sh` pass. Not run: `npm run
build` (type-check), `npm run lint`, the full `npm test`, the Rust gates (no
Rust changed).

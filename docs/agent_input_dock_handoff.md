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

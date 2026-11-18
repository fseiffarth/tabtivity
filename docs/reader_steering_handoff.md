# Reader steering run: handoff log

Plans: `docs/reader_diffs_steering_plan.md` (umbrella: mechanism, Agent steps,
Organisation, Base dependency) and `docs/reader_files_steering_plan.md`.
Frontend only; not run live (nothing here can be). Each agent starts with
`git checkout -B <branch> develop` (worktrees branch from `origin/main`), runs
`scripts/gates.sh` in the background, commits green, and fills its section.
Parallel agents (A4, A5) list their `i18n` / `untested.ts` / filemap / help-doc
edits here when they would collide; the main agent applies them once.

Baseline (develop HEAD, `npm test`): _files / tests / known failures: fill in_.
Base used (sha, and whether the other sessions' steering edits were committed
first; how the `Tab` blocking question was settled): _fill in_.

## Steps and commits

| Agent step | Branch / worktree | Commit sha(s) | What |
| --- | --- | --- | --- |
| A1 Links section | `reader-links` / `.claude/worktrees/agent-a091b278d7457dd9f` | `ae2af7d3f` (+ merge `8ccc5de54`) | Links section in the Files tab, no steering |
| A2 Mechanism core | `reader-steer-core` / `.claude/worktrees/agent-a35212a2f41f8f3c3` | `fd66dc998` | Inside scope, `readerView` Tab, registry module, handler |
| A3 View cycle in the UI | `reader-steer-core` / `.claude/worktrees/agent-a35212a2f41f8f3c3` | `7eb23bc51` | TerminalView registration, legend, ladder label, docs |
| A4 Diffs inside | `reader-steer-diffs` / `.claude/worktrees/agent-af91e2cf31538c9d8` | `9ea2a7378` | Card cursor, Inside target and legend rows for the Diffs view |
| A5 Files inside | `reader-steer-files` / `.claude/worktrees/agent-aa5e5d41375799468` | `599ddb9cb` | Files view: walk files+links, sections, scroll, open, show |
| R1 review (A2+A3) | | | |
| R-final | | | |

Gate results per step (`scripts/gates.sh`: build, `npm test`, lint, brand-check;
files / tests / failures; lint warnings vs baseline): _fill in per step_.

## A1 Links section

- sha: `ae2af7d3f` (feat(reader): list the conversation's web links in the Files tab), on branch `reader-links`, worktree `.claude/worktrees/agent-a091b278d7457dd9f`. Based on develop `d5064b553`; the branch tip is `8ccc5de54`, a "Merge branch 'develop' into reader-links" (develop `ff63619a2`, v0.2.61) that was made in the worktree by something other than me after my work was done. The commit and the merge were not mine: the agent was told to commit, but the tree was already committed when I looked. Content of `ae2af7d3f` is exactly my change (17 files). Not pushed, not merged into develop.
- Choices the plan left open:
  - Role labels: the Chat has no "You"/"Agent" keys, so added `terminal.readerFiles.linkFromYou` / `linkFromAgent` (de "Du"/"Agent", es "Tú"/"Agente", fr "Vous"/"Agent", it "Tu"/"Agente").
  - Row time uses the Reader's `use24h` (new optional `use24h` prop on `TerminalReaderFiles`), formatted with `chatMoment`/`chatTime`, as bubbles do.
  - `host` keeps the port (`localhost:3000`), `www.` dropped; `rest` = path + query, empty for a bare host; middle-truncated to 56 characters in the component (`middle()`).
  - `www.example.org/x` autolinks come out of `renderMarkdown` as `https://www.example.org/x` (not http); the list shows what the Chat would open.
  - The `.terminal-changes-files` column is now a plain `div` (no `role`); the listboxes are inner `.terminal-files-group` divs (Files: label "Files this conversation names", unchanged; Links: "Links this conversation names"). Headings `.terminal-files-heading` only when both exist; with links only, that heading row holds just the `UntestedTag` pill.
  - Doc parts done by A1: filemap rows (TerminalReaderFiles edited, `chatLinks.ts` new), `docs/help/agent-clis.md` paragraph, one paragraph in `docs/context/agent_reader.md`, `todo/group-s-agents.md` entry with the four platform pairs, `terminal.reader.links` row in `untested.ts`. `terminal.reader.filesNone` / `readerFiles.empty` changed in all five locales ("...file or link yet").
- Gotchas (for A5, who adds steering to the same Files view):
  - Rows are `<button role="option" aria-selected>` in two `role="listbox"` groups inside `.terminal-changes-files`; link rows carry class `terminal-files-link` and `aria-selected={false}` always. A cursor/`data-steer-row` has to be added to both groups; keys are `file.entry.path` and `link.url` (the URL, with fragment of the first sighting).
  - `TerminalReaderFiles` gets `links` (default a shared empty array) and `onOpenLink`; with no `onOpenLink` no Links group is drawn, so `rowsOf(files, links)` must use what is actually drawn (`linkRows`).
  - `readerLinks` is built in `TerminalReaderView` from `turns`, gated on `!!onOpenUrl` (`linksOffered`), and `onFilesKnown(hasItems)` now means files or links.
  - The Files tab's empty state text depends on links too (`onlyLinks`).
  - `chatLinksOf` has a module-level memo keyed by `kind|text` (bounded 500); it needs `document` (jsdom in tests).
- Gates / test counts (run before the merge commit, on the tree that became `ae2af7d3f`):
  - `npm run build`: green.
  - `npm run lint`: 0 errors, 29 warnings total; none in the files I touched (TerminalReaderView's one warning at l.1505 `live.question` is not mine).
  - `npm test`: 1116 files, 11617 tests. Two runs: the first (machine load average ~70) had 14 failures in 7 files, all timeouts; the second had 1 failure: `src/__tests__/mobile/MobileTerminalTranscript.test.tsx` "keeps the chat while a /clear sent mid-turn waits behind the turn" (expected 3 sent frames, got 4). That test fails identically on a clean checkout of `d5064b553` (checked in a throwaway detached worktree, since removed), so it is pre-existing and not caused by A1. After the merge commit the new/changed test files (ChatLinks, ReaderFilesLinks, TerminalReaderToolbar, UntestedRegistry) were re-run: 36 passed.
  - `scripts/brand-check.sh`: green. `git diff --check`: clean. `scripts/gates.sh` not run (read-only cargo registry).
  - New tests: `src/__tests__/terminal/ChatLinks.test.ts` (13), `ReaderFilesLinks.test.tsx` (8), one case in `TerminalReaderToolbar.test.tsx` (Files tab enabled by a link alone, click calls `onOpenUrl`, no `fetch`, no `a[href]`).
  - `node_modules`: `cp -al` worked in the worktree (same device); it does not work from the scratchpad dir (cross-device).
- Edits deferred to the main agent (hot files): none. A5 should add its `steering.readerFiles.*` keys after `terminal.readerFiles.onlyLinks` area only if convenient; my keys sit right after `terminal.readerFiles.close` in all five locales.

## A2 Mechanism core

- sha: `fd66dc998` on `reader-steer-core` (from develop `4a677738d`), worktree `.claude/worktrees/agent-a35212a2f41f8f3c3`. Not pushed, not merged. The user said skip the gates: only the added/touched test files were run (see below), plus `node node_modules/typescript-native/bin/tsc` once (clean) after each step.
- Choices the plan left open (incl. the `Tab` default and `nextTab`):
  - On HEAD `Tab` is free, so `readerView` (scopes `["panes"]`, default `["Tab"]`) sits after `popout`. `nextTab` does not exist on develop; whoever lands second drops `nextTab`'s `Tab` default (Blocking question 1).
  - `readerView` is `panes`-scoped, so it resolves at panes, tabs and (via `scopeFits`) inside, not in the projects.
  - `scopeFits(scopes, "inside")` also fits `panes`-scoped defs; `steeringActionFor` for `inside` orders `inside` defs first (`defsFor`), in both passes. So at scroll `c`/`w`/`m` still resolve to their (dead, swallowed) pane actions and `n`/`o`/`v`/`u` resolve to the `view*` actions.
  - Conflicts: `scopesMeet` became the def-based `defsMeet`; `LIVE_INSIDE` = `work, exit, agentPrompt, readerView, slot1..9`. `inside` meets `inside` and `mode`; a `panes` def only if live; never `projects`/`region`.
  - `SteeringKeyContext` gained `"inside"` (= `Exclude<SteeringScope,"mode">`); `tsc` found no `Record`/switch that needed a new arm.
  - Key repeat: the view cycle ignores `e.repeat` in the handler itself; targets own the repeat rule for their own actions.
  - `cycleActiveReaderView` is a function declaration in `useKeyboard.ts` just above `steerPanes` (reads `steeringActivePty()`, so a tab with no registered xterm is swallowed too).
  - i18n for all A2 + A3 keys (settings labels `steering.viewToggle|viewMode|viewOpen|viewOpenAlt|viewNew.label`, `steering.readerView.label/.desc`, `steering.intoReader.label/.desc`, `steering.level.scrollChat|scrollChanges|scrollFiles`, `steeringKeys.section.inside`) was added in A2 in all five locales: after `steering.level.scrollDocument`, `steering.intoTerminal.desc`, `steering.popout.desc`, `steeringKeys.section.panes`. A4 adds only `steering.changes.*`.
- Gotchas (`SteeringKeyContext` ripple, two-pass resolution, `LIVE_INSIDE`):
  - `inside` on the scroll level only: in `steerKey` `scroll -> "inside"`; the `exit`/`help`/`legend` checks before `steerPanes` still resolve (they are mode-wide or `panes`).
  - The Inside target is asked only when `pty && action` (a terminal registered for the active tab) and BEFORE the existing scroll `switch`; digits go through `answerDigit` first. `work` and `agentPrompt` must answer `pass`.
  - `pass` falls into the existing switch: left/right scroll, down = `scrollTerminalToLive` (A4 should return `handled` for down at the end rather than let it wheel the hidden terminal), up = tabs, work/prompt break out.
  - The new test dir `src/__tests__/lib/` was created for `ReaderSteering.test.ts` (plan path).
- Gates / test counts: gates skipped by the user. Ran `npx vitest run`: `SteeringBindings.test.ts` (18, +6 new), `src/__tests__/lib/ReaderSteering.test.ts` (14), `SteeringReaderView.test.tsx` (7), `SteeringReaderInside.test.tsx` (6), plus the existing `SteeringScroll|Levels|Settings|Bar` and `shell/i18n.test.ts` all green (the whole `src/__tests__/shell` + `lib` directories later: 102 files / 1009 tests green together with the A3 files).
- Edits deferred to the main agent (hot files): none beyond the merge points in **Base dependency** (the `Tab` default vs `nextTab`; `SteeringAction` union / table in `steeringBindings.ts`; `steerPanes` hunks in `useKeyboard.ts`).

## A3 View cycle in the UI

- sha: `7eb23bc51` on `reader-steer-core`, on top of A2 `fd66dc998`. Same worktree. Gates skipped (user); tests below.
- Choices the plan left open:
  - `selectReaderView` is inline in `TerminalView` (the strip is untouched). `chat` -> `showReaderChat()`, `changes`/`files` -> `setPanelPicked`, `terminal` -> `setReader(false)` (already focuses the xterm); the others focus the shown view in a `setTimeout(0)` through `focusReaderView(view)`. `onReturnFocus` now calls the same `focusReaderView(readerViewNow)` (same behaviour as before).
  - Offered = chat, `changes` if `changesOffered && !readerOnHost && (changesOn || changesKnown)`, `files` if `readerTopBar && (filesOn || filesKnown)`, terminal. The target reads the latest render through `readerSteerRef`; the registration effect is keyed `[id, readerTopBar && visible]`, the facts effect `[id, active, view, offered.join()]`.
  - Legend: `SteeringLegendState.reader?: { view }`; `intoTerminal`/`inTerminal` are false and the new `intoReader` true when the view is Diffs/Files (`readerPanelShown`); the cycle row sits in the `act` group right after the `files` row (away from the agent K/L/G rows another session removes). `inChanges`/`inFiles`/`readerViews`/`intoReader` conditions exist.
  - Ladder: `ladder({ reader })`; lit Inside rung = scrollDocument > scrollChat/Changes/Files by view > scroll. `SteeringLegend` passes `reader` in both `ladder(...)` calls and the legend state.
  - Docs by A3: `UntestedTag steering.readerView` row (after `steering.scrollDocument`) and cheat-sheet pill, `docs/help/keyboard.md` rows, `docs/context/agent_reader.md` paragraph, filemap rows (new `readerSteering.ts`, updated steeringBindings/steeringBar+SteeringLegend/TerminalView), `todo/group-l-tabs.md` item 213h with the platform pairs.
- Gotchas (focus after a switch, `visible` gating, attach-only duplicates):
  - Registration needs `readerTopBar && visible`; a hidden pane or a Tabby chat (`readerAlways`) never registers, so Tab is swallowed there and the legend row is hidden. Last registration wins (attach-only duplicates); the facts withdrawal only removes its own object.
  - Until A4/A5 register, `Tab` already works, `D` into Diffs/Files lands in the scroll level with the terminal's ←/→ (`readerList` matches Diffs, not Files) and the legend there shows only cycle/Work/prompt rows (the terminal's scroll rows are hidden by design).
  - Test file `TerminalReaderSteerViews.test.tsx` mounts the real `TerminalView` with a mocked `TerminalReaderView` that exposes `onChangesKnown`/`onFilesKnown`.
- API for A4/A5 (all in `src/lib/agents/readerSteering.ts`):
  - `registerReaderInside(steerId, { view: "changes" | "files", key(action, e) })` returns the unregister; call it from an effect keyed on `steerId` and `visible`, reading latest state through a ref; register only when `steerId && visible`.
  - `key` returns `"handled" | "leave" | "pass"`: `pass` for `work`, `agentPrompt`, and `left`/`right` (Diffs); `handled` for unused actions; `leave` for up past the first item (`handled` if `e.repeat`).
  - `useSteeringInside(steerId)` -> boolean for the cursor (`.steer-cursor`).
  - Both panels already declare `steerId?: string`, and `TerminalReaderView` passes `steerId={ptyId}` to both; destructure it when you use it.
  - Legend rows go between the markers `// -- inside Diffs: begin/end` and `// -- inside Files: begin/end` in `STEERING_KEYS` (`shortcuts.ts`, after the `inDocument` rows): `when: "inChanges"` / `"inFiles"`, `levels: ["scroll"]`, actions `up`/`down`/`left`/`right`/`viewToggle`/`viewMode`/`viewOpen`/`viewOpenAlt`/`viewNew`; labels/descs start "In Diffs, ..." / "In Files, ..." (cheat sheet keys are `levels[0]|actions|labelKey`, unique).
  - `UntestedTag steering.insideChanges` and the pill go beside `steering.readerView` in `ShortcutHelpOverlay.tsx` and after the `steering.readerView` row in `untested.ts`.
- Gates / test counts: gates skipped. `npx vitest run`: `SteeringReaderLegend.test.ts` (10), `TerminalReaderSteerViews.test.tsx` (5), and the directories `src/__tests__/shell`, `src/__tests__/lib`, `src/__tests__/terminal/TerminalReader*`, `ReaderFiles*`, `AgentPaneMouse`: 102 files / 1009 tests, all passed. `tsc` clean. Targeted `eslint` on the touched files: 0 errors, 3 warnings, all pre-existing in `TerminalView.tsx` (l.2258, 2367, 2429), none new.
- Edits deferred to the main agent (hot files): none new. Merge points as in **Base dependency**: `shortcuts.ts` (condition union after `inDocument`, rows after `files` and after the `inDocument` rows), i18n anchors above, `ShortcutHelpOverlay` pill line, `docs/help/keyboard.md` row after `V`.

## A4 Diffs inside

- sha: `9ea2a7378` on `reader-steer-diffs` (from `reader-steer-core` tip `7eb23bc51` via develop), worktree `.claude/worktrees/agent-af91e2cf31538c9d8`. Not pushed, not merged. Gates skipped (user).
- Choices the plan left open:
  - The key logic is a plain function `changesSteerKey(state, action, e, setters)` in `TerminalReaderChanges.tsx` (not exported); the registered target reads the latest render through a `live` ref (cards newest first, `keyed` oldest first, files, filter, effective cursor, fresh set, `openFile`, `openDiff`, root element). Keys write `state.cursor` too so a fast second key before the re-render still moves on.
  - Cursor = card key in state; the effective cursor snaps to the newest card when the stored one is not in the shown list (fresh entry, file narrowed). Drawn only when `useSteeringInside(steerId)`. `ChangeCard` (memo) takes `cursor: boolean`, puts `steer-cursor` on `.terminal-changes-card-head`, and the `<section>` carries `data-card-key` (found by iterating, no `CSS.escape`).
  - Shift+up/down: order `[All, ...files]`, wrapping both ways (Shift+up on All goes to the last file; the plan only fixed the down direction); cursor goes to the newest card of the new list; Shift never leaves. With no changed files it is `handled`.
  - `viewToggle` clicks the card's `.terminal-changes-fold` (one path for `onUnfold`). Toggle, mode, new and both open actions ignore `e.repeat`. `viewNew` walks cards after the cursor with wrap; none fresh -> `handled`. `viewOpen`/`viewOpenAlt` do nothing on delete/moved cards.
  - `down` on the last card stays (`handled`), so it never falls through to `scrollTerminalToLive`; `left`/`right`/`work`/`agentPrompt` are `pass`; every other action `handled`.
  - Legend rows (levels `["scroll"]`, `when: "inChanges"`, groups move/act) sit between `// -- inside Diffs: begin/end`: left/right, up/down (card), Shift up/down (file), fold, new, layout, open, diff viewer. Keys `steering.changes.{scroll,card,file,fold,new,layout,open,openDiff}.{label,desc}` added in all five locales after `steering.viewNew.label` (not after `steering.readerView.desc`).
  - Pill `steering.insideChanges` in the cheat-sheet heading right after `steering.readerView`; `untested.ts` row right after `steering.readerView`.
  - Docs: `docs/help/keyboard.md` has a Diffs key table after the table ending `Esc / Enter`; filemap row for `TerminalReaderChanges.tsx` extended; `todo/group-l-tabs.md` item 213i (with the four platform pairs) placed after 213h. The `docs/context/agent_reader.md` note was already covered by A3's paragraph; not touched.
- Gotchas (memo `ChangeCard` cursor prop, `.click()` path):
  - Only the cards whose `cursor` flips re-render. The `.click()` on the fold button works only while the card is in the DOM; `viewToggle` returns `handled` when it is not.
  - In jsdom `scrollIntoView` is absent; the effect guards it.
  - A hidden panel never registers (`visible` false), checked in the test.
- Gates / test counts: gates skipped. New: `src/__tests__/terminal/ReaderChangesSteering.test.tsx` (11 tests) and `src/__tests__/shell/SteeringDiffsLegend.test.ts` (4). `npx vitest run` on `src/__tests__/shell`, `src/__tests__/lib` and the `terminal/TerminalReader*`, `ReaderFiles*`, `ReaderChanges*`, `AgentPaneMouse` files: 103 files / 1004 tests, all passed; `UntestedRegistry.test.ts` 5 passed. `tsc --noEmit` (typescript-native) clean; `eslint` on the touched TS/TSX files: no output; `git diff --check` and `scripts/brand-check.sh` clean.
- Edits deferred to the main agent (hot files): the merge with A5 will touch `ShortcutHelpOverlay.tsx` (pill line after `steering.readerView`), `untested.ts` (row after `steering.readerView`), the i18n files (my block after `steering.viewNew.label`), `shortcuts.ts` (own marked block only), `docs/help/keyboard.md` and `todo/group-l-tabs.md` (213i sits after 213h; A5's entry will be adjacent).

## A5 Files inside

- sha: `599ddb9cb` (feat(steering): walk, open and scroll the Reader's Files view from the keyboard) on `reader-steer-files` (from develop `7eb23bc51`), worktree `.claude/worktrees/agent-aa5e5d41375799468`. Not pushed, not merged. Gates skipped (user).
- Choices the plan left open (`v` = Show here, `o` = tab):
  - Pure model `src/lib/terminal/readerFilesSteer.ts` (`rowsOf`, `startKey`, `effectiveCursor`, `stepCursor`, `jumpSection`, `decide`); `TerminalReaderFiles.tsx` only applies the decision. Held up on the first row, and held `o`/`v`, return `handled` (decided in `decide` through `mods.repeat`).
  - Shift+up/down never leaves: it jumps Files<->Links and otherwise stays.
  - `o` on a file with no in-app viewer (`internalViewerFor` null, where the ↗ button is hidden) does nothing; `v` on it still picks it (the Viewless card, like a click).
  - Cursor: `.steer-cursor` (existing global class in `subwindows.css`, no new CSS) + `aria-current`; `data-steer-row` is on every row always (path / URL), the class only while `useSteeringInside(steerId)`.
  - Registration effect keyed `[steerId, visible]`, latest state through `liveRef` (updated in render and, on a cursor move, written through so two presses before a re-render still step on). Scroll target = `largestScroller(.terminal-files-viewer)`.
  - `largestScroller(root)` / `scrollBox(box, pages)` extracted in `lib/shortcuts/documentScroll.ts`; `documentScroller` / `scrollDocument` behave as before (internal `scrollerBelow`, root excluded; `largestScroller` falls back to `root` itself).
  - i18n keys `steering.readerFiles.{walk,section,scroll,open,show}.{label,desc}` in all five locales, before `steering.scroll.label` (A4 uses the anchor after `steering.scrollOutDocument.desc`). Legend rows sit between `// -- inside Files: begin/end` (walk, Shift-section, scroll, open, show; `inFiles`, level `scroll`).
  - Untested: `steering.readerFiles` row in `untested.ts` (right after `steering.readerView`'s neighbour, before `steering.legendGroups`) and the pill in `ShortcutHelpOverlay.tsx` (own line after the `steering.readerView` pill). `docs/help/keyboard.md`: a paragraph "Inside an agent's Reader Files view" before the phone paragraph (not a table row). Filemap: `TerminalReaderFiles`, `documentScroll` rows updated, `readerFilesSteer.ts` row added; one paragraph in `docs/context/agent_reader.md`.
  - `todo/group-l-tabs.md`: new item **213j** (after 213h, before 215) with the four platform pairs; 213i skipped on purpose so A4's likely 213i does not collide.
- Gotchas (`largestScroller` scope, cursor key vs index):
  - The viewer half and the list column both scroll; scoping to `.terminal-files-viewer` keeps ←/→ off the list. Unclaimed ←/→ would wheel the hidden xterm, so Files answers `handled` for them even when nothing scrolls (picture, no file shown).
  - The cursor is a key: rows arriving above it do not move it; if its row disappears it snaps to the shown file's row (else the first). The key is a plain path / URL (no kind prefix); a path and a URL cannot collide in practice.
- Gates / test counts: gates skipped. `tsc --noEmit` (typescript-native) clean; targeted `eslint` on the touched files: 0 errors, 0 warnings; `scripts/brand-check.sh` green; `git diff --check` clean. New: `src/__tests__/terminal/ReaderFilesSteer.test.ts` (pure, 15 tests) and `src/__tests__/shell/SteeringReaderFiles.test.tsx` (14, real `useKeyboard` + real `TerminalReaderFiles`), plus 3 `largestScroller`/`scrollBox` cases in `SteeringScroll.test.tsx`. `npx vitest run` on `src/__tests__/shell`, `src/__tests__/lib`, `terminal/ReaderFiles*`, `terminal/TerminalReader*`, `terminal/ChatLinks`: 104 files / 1034 tests, all passed (includes `ReaderFilesLinks`, `SteeringReader*`, `UntestedRegistry`, `i18n`).
- Edits deferred to the main agent (hot files): merge points with A4 — `src/lib/untested.ts`, `ShortcutHelpOverlay.tsx` (pill lines), the i18n anchor before `steering.scroll.label`, `shortcuts.ts` (only inside the `inside Files` markers), `todo/group-l-tabs.md` (213j vs A4's entry), `docs/filemap_frontend.md`, `docs/help/keyboard.md`.
- Manual click-through (never run live; also the 213j todo entry): agent tab whose chat names a file and two links; Shift+Space, Tab to Files, D: legend "Inside Files", one row outlined (the shown file); E/D walk files then links; Shift+D lands on the first link, Shift+E on the first file; V shows a file; S/F (Shift: whole screen) scroll a long Markdown file and the terminal behind does not move; O opens it as a tab, Shift+O in a new subwindow; O on a link shows the "Open link?" box naming the exact URL (Cancel opens nothing); Enter leaves steering with the keys in the view; E on the first row goes to the tabs, a held E does not; a remote tab's `localhost:` link is forwarded, not opened locally.

## Reviews

- R1 (A2+A3): confirmed bugs fixed (each with a regression test):
- R-final: confirmed bugs fixed: one, `2d9c8a383` (see Final review).

## Final review

Worktree `.claude/worktrees/agent-af3e932fff4ddac05`, branch `reader-steer-review` (from develop `b9f5b15b7`), range `30bb5c706^..b9f5b15b7`. Gates skipped by the user; not run live.

Checked (read against the code, plus the existing tests): the `inside` scope and two-pass resolution (`defsFor`, `scopeFits`, `LIVE_INSIDE`, `defsMeet`: arrows are `mode`-scoped so a rebinding onto them is flagged); `steerKey` context and `steerPanes` ordering (digit answer, then the cycle, then the Inside target, then the scroll switch; `work`/`agentPrompt` pass; a dead pane key reaches the target as its own action, so the scroll level still swallows it); the cycle (`cycleReaderView` skips greyed views, keeps an open one, ignores `e.repeat`, wraps, same `offered` conditions as the strip's `empty` flags); registrations (views: `[id, readerTopBar && visible]`; Diffs/Files: `[steerId, visible]`; both unregister on hide/unmount, last registration wins, guarded unregister); two Reader panes (distinct ids, separate registry entries and cursors); a tab closing while Inside (unmount unregisters, `useSteeringInside` goes false); Tab while a dialog or menu is up (`hasActiveModal` and `syncLayer` put steering on the `region` level, where `readerView` does not resolve); Diffs keys (up leave and held-key rule, Shift wrap, fold through the card's own button, `n`, `u`, `o`, `v`); Files keys (`decide`, key-based cursor, left/right always `handled` so the hidden xterm is never wheeled, `o` on a link goes `onOpenLink` -> `onOpenUrl` -> `openLinkRef` -> the Chat's confirm; no fetch, no `<a href>` in `chatLinks.ts` or the row); legend conditions (`inChanges`, `inFiles`, `intoReader`, `inTerminal`/`inDocument` exclusion, ladder label) and the cheat-sheet row keys; i18n key parity (11395 keys in each of en/de/es/fr/it, `comm` clean, new strings really translated); `UntestedTag` ids (`steering.readerView`, `steering.insideChanges`, `steering.readerFiles`, `terminal.reader.links`) against `untested.ts` rows; filemap rows (`readerSteering.ts`, `readerFilesSteer.ts`, `chatLinks.ts`, the edited components); todo items 213h/i/j and the A1 entry; no TODO/FIXME left in the new modules; no bare `listen()`, `.split("/").pop()`, new `any` or animated blurred shadow in the added lines; `scripts/brand-check.sh` green; `tsc` clean.

Bug fixed (1):
- `2d9c8a383` Files view: ↓ with no rows at all (view open on a conversation with no files and no links) fell through `stepCursor`'s empty-list `out` and stepped out to the tabs, the opposite direction of the key. `decide` now answers `{}` for ↓ on an empty list (↑ still leaves, not on repeat). Test: `ReaderFilesSteer.test.ts` "on an empty list, down stays and up leaves".

Tests run (all green): `src/__tests__/shell/Steering*` + `shell/i18n`, `terminal/ReaderFiles*`, `ReaderChanges*`, `ChatLinks*`, `TerminalReader*`, `lib/ReaderSteering*`, `UntestedRegistry`: 38 files / 435 tests before the fix; after it `ReaderFilesSteer` 16 (was 15), `SteeringReaderFiles` + `ReaderFiles*` 3 files / 38 tests. `tsc` (typescript-native) clean; `scripts/brand-check.sh` green. Not run: build, full `npm test`, lint, `gates.sh` (skipped by the user).

## Click-through for the user

Per the umbrella's **Verification** and the Files plan's **Verification**. Not
run live by any agent. Platform child pairs live in the `todo/` entries.

## Flagged for user

- Blocking question 1 (`Tab`): settled — the view cycle keeps `Tab`, `nextTab` loses its default.
- Files `v` = "Show here", `o` = open as a tab: confirmed by the user.
- Home/End to first/last card not added (not rebindable actions): as planned, not added by A2/A3.
- A4: Shift+up on "All files" wraps to the last file (the plan only spelled out Shift+down wrapping to All); easy to change in `changesSteerKey` if the user wants no wrap upward.
- A4 click-through (never run live), on an agent tab with a finished turn that edited files and Diffs shown: (1) Shift+Space, D: ladder reads "Inside Diffs", the newest card head is highlighted. (2) E/D walk the cards, the viewport follows; D on the last card stays. (3) Z folds/unfolds the card; U flips split/unified; O opens the file in a tab, Shift+O in a new subwindow, V the diff viewer; on a deleted or moved card they do nothing. (4) Shift+D narrows to the next changed file, past the last back to All; Shift+E goes back. (5) S/F scroll a long diff. (6) While the agent edits again, N jumps to the New card. (7) E on the first card steps back to the tabs; holding E does not leave. (8) Tab inside Diffs switches to Files, the legend follows. (9) Enter leaves steering with the keys in the view; Space opens the prompt. (10) Settings -> Shortcuts -> Inside a view: rebinding Z to E shows the conflict. Platform pairs: `todo/group-l-tabs.md` 213i.
- A5: todo item numbered 213j (213i left free for A4); `o` on a file with no in-app viewer does nothing (as the hidden ↗ button).
- Final review (not fixed, needs a decision or a live look):
  - Facts for an id mounted twice (a tab attached to two panes at once, both `visible`): `publishReaderViewFacts` keeps the first object when the value is equal, so when the first pane unmounts first it withdraws the facts the second still stands on and the legend row disappears until the next change. Views/inside registrations are safe (last wins, guarded). Needs a ref count per id; reachable only in the attach-only duplicate case, so left.
  - Steering ignores modifiers by design, so Ctrl+Tab / Alt+Tab pressed while steering is on cycles the Reader view like Tab (the OS may take Alt+Tab first); the app's own Ctrl+Tab "next tab" chord is swallowed by the mode either way, as before.
  - Holding D at the tab level steps Inside and, on repeats, keeps walking the cards/rows (documents guard the step-in key's repeats with `!e.repeat`; Diffs and Files do not). Probably wanted; say if not.
  - Diffs reads `rootRef.current` into its live state at render time; correct because the data load re-renders, but a lazy read in the key handler would be sturdier.
  - `stepCursor([], …, 1)` still returns `out` (pinned by an existing test); only `decide` guards it.

## Run note (2026-11-10)

- The user said "skip the gates" for the remaining steps: implementers run only
  the tests they add or touch, not `npm run build` / full `npm test` / lint /
  `gates.sh`. The final report must say the gates were skipped.

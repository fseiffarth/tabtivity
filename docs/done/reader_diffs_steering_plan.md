# Reader view switch + native Diffs steering — plan (the run's umbrella)

Status: plan, reviewed 2026-11-10. Nothing built. Planned against the working
tree, which holds uncommitted steering edits from other sessions; see **Base
dependency** before starting.

## Run overview

Two plans, one run:

- **This doc** (umbrella): the steering key that switches an agent tab's Reader
  view (Chat / Diffs / Files / Terminal), the **shared mechanism** (binding scope
  `inside`, `src/lib/agents/readerSteering.ts`), native steering inside Diffs.
  Also owns **Agent steps**, **Organisation**, **Base dependency**.
- `docs/reader_files_steering_plan.md`: a Links section in the Reader's Files
  view, and native steering inside Files, written on this doc's mechanism.
- Handoff log (skeleton): `docs/reader_steering_handoff.md`.

Order: Links section first (no steering), then the shared mechanism + view
cycle, then Diffs-inside and Files-inside in parallel.

## Blocking questions — settled 2026-11-10

1. **`Tab`:** the user chose that the **view cycle keeps `Tab` / Shift+Tab**.
   The other session's uncommitted `nextTab` loses its `Tab` default (it stays
   rebindable; ←/→ at Tabs and Ctrl+Tab still step tabs). Implementers on HEAD
   use `Tab`; whoever lands second drops `nextTab`'s default.
2. **Files `o` / `v`:** confirmed — `o` opens the file as a tab (Shift+`o` a
   new subwindow; a link opens after the confirm), `v` shows it in the viewer
   pane. Moving the cursor previews nothing.
3. **Base:** the user chose to **wait for the other sessions to commit** their
   steering edits. A1 (Links, touches none of them) runs now; A2+ branch from
   `develop` only once those edits are committed.

## Base dependency (working tree vs committed `develop` HEAD)

Implementers work in worktrees. `Agent isolation: worktree` branches from
`origin/main`; every agent must first `git checkout -B <branch> develop`
(memory: `project_worktree_base_main`). That base lacks the uncommitted edits
below (`git diff HEAD`, 2026-11-10). What the plans assume of each:

| Uncommitted edit | Plan dependency | What an implementer on HEAD assumes | Conflict when landing |
|---|---|---|---|
| `steeringBindings.ts`: `nextTab` = `Tab`; `agentClear/Plan/Goal` (K/L/G) removed | None for correctness. The old plan text "K L G unbound, a test asserts null" only explained why they are not taken; this plan takes only `Tab` (panes) and `z u o v n` (inside, which shadow panes keys only Inside). | On HEAD `Tab` is free at panes; `k l g` are still agent keys at panes (irrelevant Inside). | **`Tab`** (Blocking question 1). Textual: `SteeringAction` union and the table around `agentPrompt`/`nextTab`. Mitigation: add `readerView` after `popout`, the five `view*` defs after the slot block, and `readerView` after `agentPrompt` in the union only if that hunk still merges; never edit the `right`/`nextTab`/`agentClear` lines. |
| `useKeyboard.ts` `steerPanes`: `case "nextTab"` merged into `left/right`; comment; `popout` now `exitSteering()`; blur/`onFocus` grace (`STEERING_BLUR_GRACE_MS`, ours, committed separately before the run) | The S3 handler hunks (`steerKey` context; two inserts in `steerPanes`) sit in untouched lines. | HEAD's `steerPanes` has no `nextTab`. | None textual (hunks ≥ 15 lines apart). Semantic: at `scroll`, a `nextTab` action is swallowed by `default: return`; `readerView` is handled before that block. |
| `shortcuts.ts`: `STEERING_KEYS` agent rows removed, `nextTab` row added; `SteeringCondition` union loses `agentClear/Plan/Goal`; doc comment | New conditions `readerViews`, `inChanges`, `inFiles`, `intoReader` and the new rows. | HEAD still has the agent conditions/rows. | Union + comment block adjacent to the removed lines. Mitigation: add the new conditions **after `inDocument`**, rows after the `inDocument` rows, never next to `agentPrompt`. |
| `steeringBar.ts` (agent anchors removed) | `ladder()` edit is ~190 lines below. | — | None. |
| i18n x5 (`steering.tabKey.*` after `steering.…` ~l.2588, `mobile.question.attach*`) | New keys. | — | Insert new `steering.*` keys after `steering.scrollOutDocument.desc` (Diffs) and before `steering.scroll.label` (Files); `terminal.readerFiles.*` after `terminal.readerFiles.close`. |
| `untested.ts` (+4 rows near l.479, 499, 700, 703) | New rows. | — | Add each new row beside its family, not at the touched lines. |
| `ShortcutHelpOverlay.tsx` (+1 pill `steering.tabKey`), `docs/help/keyboard.md` (Tab row), `docs/filemap_frontend.md` (steeringAgent/confirm/projectJump rows) | Pills, help rows, filemap rows. | — | Adjacent one-line edits; resolve by hand. |
| `TerminalReaderView.tsx` (45+/28-: LiveQuestion, composer paste, slash menu) | Files plan F2 hunks at ~l.2355 and ~l.2688, S4 `steerId` hunks at ~l.2675/2688. | — | None (different hunks). |
| Tests: `SteeringBindings.test.ts`, `SteeringLevels.test.tsx`, `SteeringBar.test.tsx` modified; `SteeringBlur.test.tsx` untracked (ours) | New cases go in **new files** where possible; legend cases extend `SteeringBar.test.tsx` / `SteeringBindings.test.ts` at the end of a `describe`. | — | Small, at file tails. |

Not touched by anyone: `TerminalView.tsx`, `TerminalReaderChanges.tsx`,
`TerminalReaderFiles.tsx`, `SteeringLegend.tsx`, `documentScroll.ts`,
`readerSteering.ts` (new), `answerMarkdown.ts`.

Recommendation to the main agent: commit (or discard) the other sessions'
steering edits **before** branching the worktrees, and settle the `Tab`
question in that commit; then this table reduces to the `Tab` row.

## Why

An agent tab's Reader has four views on its strip — Chat / Diffs / Files /
Terminal — but steering cannot switch them (only the mouse can), and once
Inside a tab, steering only scrolls: in Diffs it cannot walk the file list,
fold a card, flip split/unified or open the file. Two requests:

1. a steering key to switch the four views;
2. native steering inside Diffs (and, by the same mechanism, Files).

## Ground truth (read from the tree, verified 2026-11-10)

- The view is **local state of `TerminalView`** (`panelPicked: "changes" |
  "files" | null`, plus the per-CLI Chat/Terminal choice in
  `useAgentReaderStore`; current view = `!readerOn` → terminal, `changesOn`,
  `filesOn`, else chat). `TerminalPromptStrip` draws the tabs from the `reader`
  prop; Diffs/Files are greyed (`empty`) until the Reader has something to show,
  and Diffs is not offered on a remote-host tab or a CLI without
  `changesOffered`. Nothing outside the pane can read or set it. Both panels'
  root is `aside.terminal-changes` (`tabIndex -1`).
- Steering levels: `projects › panes › tabs › scroll ("Inside") › region`.
  `steerPanes` (`useKeyboard.ts`) serves panes, tabs **and** scroll; at scroll
  only left/right/down/up/work/agentPrompt act (digits answer a question first),
  everything else is swallowed (`default: return`). ↓ on an agent tab steps into
  scroll because its xterm is registered (`steeringActivePty`, key
  `${scope}:${tab.key}` = the `TerminalView` id). Inside, ←/→ call
  `scrollTerminal`, whose `readerList` (`lib/terminal/terminalScroll.ts`)
  already matches the **Chat** and **Diffs** list; Files is not matched, so ←/→
  there would wheel the hidden terminal (Files claims ←/→ itself).
- `steeringActionFor` resolves by *context* `region | projects | panes`; scroll
  shares `panes`. Free letters at `panes`: **i y z**. `h`, `e d s f ? .` are
  mode-wide; D F T C are Down/Right/To-do/Calendar.
- Enter is "Work here" (leave steering, focus stays), Esc leaves steering from
  tabs/scroll, ↑ steps Inside → Tabs, Space opens the prompt box. They keep
  their meaning.
- The legend is static data: `STEERING_KEYS` rows with a `levels` list and a
  `when` evaluated by `steeringKeysFor(SteeringLegendState)`; `SteeringLegend.tsx`
  builds that state at render (it has two `ladder(...)` calls: lent and normal).
  **The cheat sheet (`ShortcutHelpOverlay`) lists every row under its
  `levels[0]` regardless of `when`, keyed `actions|labelKey`**: rows need unique
  `actions|labelKey` pairs, and each Diffs/Files label's `.desc` must name its
  view ("In Diffs, …").
- The phone solves "Terminal registers what steering may do inside it" with
  `InsideTarget` (`mobile-web/src/steering/steeringState.ts`). The desktop has
  only DOM probes (`documentScroller`, `activeTabCard`).
- `ChangeCard` is a `memo` component; the cursor reaches it as a prop.

## Fixed decisions (the user's; reviewers may not undo them)

1. **View switch:** one cycle action `readerView`, default `Tab` (Shift+Tab
   backwards), order Chat → Diffs → Files → Terminal, wraps, **skips greyed
   views** (an open view stays selectable), works at Panes, Tabs and Inside; the
   level does not change (Inside re-targets to the new view). No direct per-view
   keys. (A tab with no strip — shell, viewer, Tabby, root console,
   `readerAlways` — swallows the key; the legend row is hidden there.)
2. **Enter inside Diffs and Files stays "Work here"**, as today, in both views.
   **Opening is `o` in both views** (Diffs: the file; Files: the picked file, or
   the link). **Shift+`o` is the alternate open** (new subwindow; in Files for a
   file: open as a tab on `o`, new subwindow on Shift+`o`, consistent with
   Diffs). The Files plan's "Files claims Enter", Shift+Enter/Ctrl+Enter and
   `claimsWork` are dropped.
3. **No regular (non-steering) app chord** for the view switch.
4. **The shared mechanism is this doc's:** `src/lib/agents/readerSteering.ts`
   (view registry + inside registry, `key(action, e) → "handled" | "leave" |
   "pass"`), the new binding scope `inside` with generic actions `viewToggle` z,
   `viewMode` u, `viewOpen` o, `viewOpenAlt` v, `viewNew` n. Files reuses the
   generic actions with its own legend labels where they make sense; its i18n
   namespace is `steering.readerFiles.*`; this doc defines
   `steering.level.scrollFiles`. Shared conventions: ↑/↓ walk items, ↑ on the
   first item → leave (not on key repeat), Shift+↑/↓ a bigger step (Diffs: the
   file list; Files: jump Files↔Links), ←/→ scroll the content (Files claims
   ←/→ itself — `readerList` only matches Chat and Diffs).
5. Open questions resolved: Files — cursor move previews nothing; links pasted
   in prompts are included, marked "You"; no kind chips; no in-app link preview
   (open only after the Chat's own confirm); phone Links group and a row context
   menu are follow-ups; the tab stays "Files". Diffs — ↑ on the first card steps
   out and ↓ no longer jumps to the end; the Chat view Inside stays a plain
   scroll.

## Decided here (review)

- **Home/End: not added.** They are not rebindable steering actions (an unbound
  key never reaches a target); the cursor starts on the newest card and
  Shift+↑/↓ narrows to a file. The target receives the raw event, so adding them
  later is cheap.
- `inside` shadows `panes` only where the panes action is dead Inside. The
  conflict check therefore treats `inside` as meeting a `panes`-scoped action
  that **is live Inside** (`work`, `exit`, `agentPrompt`, `readerView`, the nine
  slots) — a user rebinding `viewOpen` to Enter is flagged — and as not meeting
  the rest (`n`, `o`, `v`, `u` keep their pane meaning outside Inside).
- The cycle's legend row is plain `Tab` (not `shift: true`, which would label
  it "Shift+Tab"); its `.desc` names Shift.
- The legend fact is `reader?: { view }` only (Chat and Terminal are always
  offered, so "≥ 2 views" is always true when a strip exists).
- Open keys ignore key repeat (`e.repeat`): a held `o` must not open a tab per
  repeat.
- Files `v` (`viewOpenAlt`) = "Show here" (the viewer pane), since Enter is not
  claimed and a cursor move previews nothing; `o` opens as a tab. Flag in the
  handoff if the user meant otherwise (one table row each).
- Diffs `viewOpenAlt` (`v`) = the diff viewer (the ± button).
- Cursor draws with `.steer-cursor` driven by React state; both views get
  "steering is Inside me" from one hook, `useSteeringInside(ptyId)`.
- Both views take an optional `steerId` prop (the `TerminalView` id), plumbed in
  S4; targets register only while `visible` (hidden panes do nothing).

## Shared mechanism

New module `src/lib/agents/readerSteering.ts` (no Tauri; React only for the
hooks), four parts:

- **View registry.** `TerminalView` registers, per pane id, `ReaderViewTarget {
  view(): ReaderViewId; offered(): ReaderViewId[]; show(view): void }` while it
  draws a strip (`readerAvailable && !readerAlways`) **and is `visible`**.
  `ReaderViewId = "chat" | "changes" | "files" | "terminal"`. Last registration
  wins; unregister is a no-op if replaced (attach-only duplicates of one tab).
  `cycleReaderView(current, offered, ±1)` is pure.
- **Reactive facts.** The same module is a tiny external store
  (`useSyncExternalStore`, the phone's `steeringState.ts` shape): `TerminalView`
  publishes `{ view, offered }` per pane id; `useReaderViewFacts(ptyId)` returns
  them so the legend redraws after `Tab`.
- **Inside registry.** A view component registers `ReaderInsideTarget { view:
  "changes" | "files"; key(action: SteeringAction, e: KeyboardEvent): "handled" |
  "leave" | "pass" }` while mounted **and visible** (`registerReaderInside`,
  `readerInsideFor`). `useKeyboard`'s scroll branch asks it **first**, only for a
  non-null action: `handled` = done; `leave` = `setLevel("tabs")`; `pass` = fall
  through to today's behaviour (scroll, Work here, prompt). Contract for
  targets: `work` and `agentPrompt` → `pass`; actions a view does not use →
  `handled` (swallowed, as today); open/toggle/mode actions ignore `e.repeat`;
  digits/Esc/help never arrive (resolved earlier).
- **`useSteeringInside(ptyId): boolean`** — true when steering is `active`, at
  level `scroll`, and `steeringTabsActive()` is the tab of `ptyId`; subscribes to
  the steering and tabs stores. Views draw their cursor from it (no enter/leave
  callback).
- **Cursor:** class `steer-cursor` on the item head (the region cursor's look;
  the region cursor only removes the class from its own element, so React-owned
  use is safe), `scrollIntoView({ block: "nearest" })` on change (guarded for
  jsdom). Keys act by calling the view's own functions or `.click()` on its
  controls, so pointer and key paths stay one.

### Inside keys (default letters; all rebindable)

| Action | Key | Diffs | Files |
|---|---|---|---|
| `up` / `down` | E D ↑ ↓ | card cursor ±1; ↑ on the first card or an empty list → `leave` (not on repeat; `handled` on repeat) | row cursor over Files then Links (headings skipped); ↑ on the first row → `leave` (same repeat rule) |
| Shift + `up` / `down` | | previous / next file in `[All, ...files]`; past the last → All | first row of the previous / next section (Files ↔ Links); an empty section skipped |
| `left` / `right` | S F ← → | `pass` (existing `readerList` scroll; Shift = whole screen) | scroll the viewer half a screen (Shift: whole); nothing for a picture / viewless file |
| `viewToggle` | z | fold / unfold the cursor card | unused (`handled`) |
| `viewNew` | n | next New card after the cursor (wraps) | unused |
| `viewMode` | u | split ⇄ unified | unused |
| `viewOpen` | o | open the file in a tab; Shift: new subwindow | file: open in a tab; Shift: new subwindow; link: open (asks first), Shift same |
| `viewOpenAlt` | v | open the diff viewer (± button) | file: show in the viewer pane; link: nothing |
| `work`, `agentPrompt` | Enter, Space | `pass` | `pass` |

## Steps

1. **S1 Bindings** — `src/lib/shortcuts/steeringBindings.ts`:
   - `SteeringScope` += `"inside"`; `STEERING_BINDING_SECTIONS` += `{ scope:
     "inside", labelKey: "steeringKeys.section.inside" }` after `panes`.
   - `SteeringAction` += `readerView`, `viewToggle`, `viewMode`, `viewOpen`,
     `viewOpenAlt`, `viewNew`.
   - Table: `readerView` scopes `["panes"]` defaults `["Tab"]` (after `popout`);
     the five `view*` scopes `["inside"]` defaults `z u o v n` after the slot
     block. Settings labels (generic): `steering.readerView.label`,
     `steering.viewToggle.label` …
   - `scopeFits(scopes, context)`: context `inside` fits `inside | panes | mode`;
     every other context unchanged. `steeringActionFor` for context `inside`
     makes two passes: `inside` defs first, then the rest (both the
     character-match pass and the physical-key pass).
   - `findSteeringConflicts`: replace the scope-only `scopesMeet` by a def-based
     check: `inside` vs `inside` and vs `mode` → meet; `inside` vs a
     `panes`-scoped def → meet only if it is in `LIVE_INSIDE` (`work`, `exit`,
     `agentPrompt`, `readerView`, `slot1…9`); `inside` vs `projects`/`region` →
     no.
   - File header comment: one sentence on `inside`.
   - `SteeringKeyContext` gains `"inside"`: fix every `Record`/switch tsc flags.
2. **S2 Registry** — new `src/lib/agents/readerSteering.ts` (as above): types,
   `cycleReaderView`, `registerReaderViews`/`readerViewFor`, facts store +
   `useReaderViewFacts`, `registerReaderInside`/`readerInsideFor`,
   `useSteeringInside`.
3. **S3 Handler** — `src/hooks/useKeyboard.ts`:
   - `steerKey`: `context` = `region` | `projects` | `scroll → "inside"` | `panes`.
   - `steerPanes`, right after the digit check and before the scroll block: `if
     (action === "readerView") { cycle(e.shiftKey ? -1 : 1); return; }` where
     `cycle` reads `readerViewFor(steeringActivePty())`, computes
     `cycleReaderView(...)`, calls `show`. No target → return (swallowed). Skip
     `e.repeat`.
   - Scroll block, before the existing `switch`: `const inside = pty ?
     readerInsideFor(pty) : null; if (inside && action) { const r =
     inside.key(action, e); if (r === "leave") { steering.setLevel("tabs");
     return; } if (r === "handled") return; }`.
   - `case "work"/"agentPrompt"` unchanged.
4. **S4 `TerminalView` wiring** — `src/components/terminal/TerminalView.tsx`
   (near `panelPicked`, l.~2442):
   - Extract `selectReaderView(view)` from the strip's handlers: `chat` →
     `showReaderChat()`; `changes` → `setPanelPicked("changes")`; `files` →
     `setPanelPicked("files")`; `terminal` → `setReader(false)` (focuses the
     xterm). After a switch to chat/Diffs/Files call the strip's `onReturnFocus`
     body (hoist it to a function) in `setTimeout(…, 0)` — the panel is not
     mounted yet — so leaving steering with Enter leaves the keys with the view.
     Ignore `view === current`.
   - `offered` = chat, terminal, `changes` if `changesOffered(readerAgent) &&
     !readerOnHost && (changesOn || changesKnown)`, `files` if `readerTopBar &&
     (filesOn || filesKnown)` — exactly the strip's enabled tabs.
   - `useEffect` registers the target and publishes facts for `id` only when
     `readerAvailable && !readerAlways && visible`; cleanup on unmount. Deps are
     primitives (`view`, `offered.join()`), no new exhaustive-deps warnings.
   - `TerminalPromptStrip` stays as is (call `selectReaderView` from it only if
     that removes duplicate code).
   - Pass `steerId={id}` to `TerminalReaderChanges` and `TerminalReaderFiles`
     (via `TerminalReaderView`, `src/components/terminal/TerminalReaderView.tsx`
     l.~2675/2688); both declare `steerId?: string` (unused until S6 / Files F6).
5. **S5 Legend + cycle rows** — `src/lib/shortcuts/shortcuts.ts`:
   - `SteeringLegendState.reader?: { view: ReaderViewId }`; conditions
     `readerViews` (`!!reader`), `inChanges`, `inFiles`, `intoReader`;
     `inTerminal`/`intoTerminal` do not hold when the view is Diffs/Files (the
     `terminal` fact stays true there: the xterm is registered under the Reader).
   - Rows: `readerView` (label `steering.readerView.label`, group `act`, levels
     `[...PANE_LEVELS, "scroll"]`, `when: "readerViews"`, plain not `shift`);
     `intoReader` for ↓ at Tabs/Panes (`steering.intoReader.label`). Create two
     empty marked blocks in the table, "Inside Diffs" and "Inside Files", after
     the `inDocument` rows (S7 and Files F7 fill them in parallel).
   - `src/lib/shortcuts/steeringBar.ts`: `ladder({ reader })` lit-rung label
     `steering.level.scrollChat | scrollChanges | scrollFiles` (Terminal view and
     no reader keep `scroll`; document keeps `scrollDocument`; Chat view today
     reads "Inside the terminal", which is wrong).
   - `src/components/layout/SteeringLegend.tsx`: `useReaderViewFacts(activePtyId)`
     → `reader` in the legend state and in **both** `ladder(...)` calls.
   - `ShortcutHelpOverlay.tsx`: `<UntestedTag id="steering.readerView" />` beside
     `steering.scroll`.
6. **S6 Diffs inside target** — `src/components/terminal/TerminalReaderChanges.tsx`:
   - State: `cursor: string | null` (card key). `inside = useSteeringInside(
     steerId)`. When inside and `cursor` is missing from `cards`, snap to the
     first card; entering with no cursor starts on the newest card. Cards render
     `data-card-key`; `ChangeCard` (memo) takes `cursor: boolean` and puts
     `steer-cursor` on `.terminal-changes-card-head`; effect `scrollIntoView` on
     change. A root ref lets keys find the card's controls.
   - Register `ReaderInsideTarget` (`view: "changes"`) in an effect keyed on
     `steerId` and `visible`, reading latest `cards/files/filter/cursor/split`
     through a ref (the `tabRef` pattern). Actions per the key table:
     - `up`/`down`: move `cursor` ±1; `up` on the first card or an empty list →
       `leave` (`handled` on `e.repeat`); `down` on the last stays (`handled`).
     - Shift `up`/`down`: step `[All, ...files]`, `setPicked`; cursor to the
       first card of the new list.
     - `left`/`right`, `work`, `agentPrompt`: `pass`.
     - `viewToggle`: `.click()` the cursor card's `.terminal-changes-fold`
       (keeps `onUnfold`/fresh bookkeeping on the one path). `viewNew`: next
       card in `freshCards` after the cursor (wraps; none → `handled`).
       `viewMode`: `setSplit((s) => !s)`.
     - `viewOpen`: `openFile(change.path, e.shiftKey)`; `viewOpenAlt`:
       `openDiff(change.path)`; both only for `openable` (not delete/moved),
       else `handled`; both ignore `e.repeat`.
     - anything else: `handled`.
   - CSS only for the cursor (existing `.steer-cursor`); no new chrome.
7. **S7 Diffs legend rows** (`shortcuts.ts`, the "Inside Diffs" block; `when:
   "inChanges"`, levels `["scroll"]`): ←/→ (own label `steering.changes.scroll.*`,
   not the terminal's), ↑/↓ card, Shift ↑/↓ file, `viewToggle`, `viewNew`,
   `viewMode`, `viewOpen`, `viewOpenAlt`. Keep Work here / Prompt rows. Cheat
   sheet pill `steering.insideChanges` beside `steering.scroll`.
8. **S8 i18n** — below, all five dictionaries (`en.ts` first), at the anchors in
   **Base dependency**.
9. **S9 Register + docs** — `src/lib/untested.ts` rows; filemap rows;
   `docs/help/keyboard.md` (rows: `Tab`; Inside a Diffs view; "Inside a view"
   rebinding section); a note in `docs/context/agent_reader.md` ("steering
   reaches the pane's view through `readerSteering.ts`"); a manual-QA item in
   `todo/group-l-tabs.md` next to #213 with the platform child pairs (`Linux
   (X11)`, `Linux (Wayland)`, `Windows`, `macOS`; tick only where checked).

## Agent steps

Plan sections in this doc are S1–S9; in the Files plan F1–F8. Each agent starts
with `git checkout -B <branch> develop`, implements only its step, runs
`scripts/gates.sh` (in the background), commits green, and fills its section of
`docs/reader_steering_handoff.md`.

| Agent step | Plan sections | Files (large ones in bold) | Est. |
|---|---|---|---|
| **A1 Links section** (no steering) | Files plan F1–F3 + Links docs/register/i18n | `mobile-web/src/terminal/chatLinks.ts` (new), `TerminalReaderFiles.tsx`, **`TerminalReaderView.tsx`**, `src/styles/subwindows.css`, tests | 1 d |
| **A2 Mechanism core** | S1, S2, S3 | `steeringBindings.ts`, `lib/agents/readerSteering.ts` (new), **`useKeyboard.ts`**, tests (bindings, registry, handler) | 0.75 d |
| **A3 View cycle in the UI** | S4, S5, cycle part of S8/S9 | **`TerminalView.tsx`**, **`shortcuts.ts`**, `steeringBar.ts`, `SteeringLegend.tsx`, `TerminalReaderView.tsx` (2 props), tests | 1 d |
| **A4 Diffs inside** | S6, S7, Diffs part of S8/S9 | `TerminalReaderChanges.tsx`, `shortcuts.ts` (own block), tests | 1 d |
| **A5 Files inside** | Files plan F4–F7, Files part of S8/S9 | `TerminalReaderFiles.tsx`, `lib/terminal/readerFilesSteer.ts` (new), `documentScroll.ts`, `shortcuts.ts` (own block), tests | 1.25 d |

Reviewers: R1 after A3 (the risky core: registry, handler, bindings, legend);
R-final over the whole range (integration, i18n x5, `UntestedTag` rows, filemap,
brand-check, privacy-check, `git diff --check`).

## Organisation

Shape: **contract first, then parallel** — a coupled chain only up to A3, then
two disjoint views.

1. A1 and A2 develop **in parallel** (disjoint files; both frontend-only); the
   main agent lands A1 first, then A2.
2. A3 starts after A2 is merged (needs the registry and bindings) and after A1
   is merged (shared `TerminalReaderView.tsx`). R1 reviews A2+A3 (fixes
   confirmed bugs only, with a regression test).
3. A4 and A5 run in parallel after A3 (they share only `shortcuts.ts`,
   i18n, `untested.ts`, filemap and help docs — each in its own marked block /
   anchor; the main agent merges sequentially, A4 then A5, and resolves the
   adjacent hot-file hunks). Then R-final.

Concurrency: at most 2 implementers at once (never more than 2–3 running
gates; at most 5 subagents total). The feature is **frontend-only** (no cargo):
the gates are `npm run build`, `npm test`, `npm run lint`,
`scripts/brand-check.sh`; `scripts/gates.sh` queues across sessions, so two
agents' runs wait for each other instead of fighting for CPU (full `npm test`
~4 min; use targeted vitest while developing). 7 agents in all (5 + 2
reviewers). The main agent reads only reports and the handoff, merges (develop,
`project_commit_amid_concurrent_sessions` recipe), and never starts the app.

## i18n keys (en.ts; same keys in de, es, fr, it)

- `steering.readerView.label` "Next view" · `.desc` "Switch the active agent
  tab between Chat, Diffs, Files and Terminal; with Shift, the other way. Views
  with nothing to show are skipped."
- `steering.intoReader.label` "Into the view" · `.desc` "Step inside the shown
  Diffs or Files view to walk it."
- `steering.level.scrollChat` "Inside the chat" · `scrollChanges` "Inside
  Diffs" · `scrollFiles` "Inside Files".
- `steeringKeys.section.inside` "Inside a view".
- Settings labels (generic): `steering.viewToggle.label` "Fold / unfold" ·
  `steering.viewMode.label` "Switch layout" · `steering.viewOpen.label` "Open
  the file or link" · `steering.viewOpenAlt.label` "Other view (diff viewer,
  show here)" · `steering.viewNew.label` "Next new".
- Diffs legend rows (each `.desc` starts "In Diffs, …"):
  `steering.changes.scroll.label` "Scroll" · `steering.changes.card.label` "Card"
  (↑ on the first card steps out) · `steering.changes.file.label` "File" (Shift:
  previous / next file) · `steering.changes.fold.label` "Fold" ·
  `steering.changes.new.label` "Next new" · `steering.changes.layout.label`
  "Split / unified" · `steering.changes.open.label` "Open file" (Shift: new
  subwindow) · `steering.changes.openDiff.label` "Diff viewer".
- Namespace `steering.readerFiles.*` is the Files plan's (the bare
  `steering.files.*` is the docked File viewer, V).

## UntestedTag rows (`src/lib/untested.ts`; pills in the cheat-sheet heading)

- `steering.readerView` — area `lib`: Tab / Shift+Tab cycle the active agent
  tab's Chat / Diffs / Files / Terminal in Panes, Tabs and Inside; greyed views
  skipped; level kept.
- `steering.insideChanges` — area `lib`: Inside Diffs, ↑/↓ card, Shift+↑/↓ file,
  Z fold, N next new, U split/unified, O open (Shift: new subwindow), V diff
  viewer; ↑ on the first card steps out; "Inside a view" keys rebindable.
- Files plan: `terminal.reader.links`, `steering.readerFiles`.
- Clear none until the user says so (`npm run untested -- tested <id>`).

## Tests (vitest)

- `SteeringBindings.test.ts`: `Tab` → `readerView` at panes (on HEAD; with the
  `nextTab` edit landed this is the conflict test, see Blocking question 1); `z
  u o v n` → `view*` at context `inside` and null/unchanged at panes/tabs/projects;
  `n` is still `newShell` at panes; at `inside`, `c` still resolves to the dead
  `calendar` (swallowed); conflicts: none for the defaults, rebinding `viewNew`
  to `e` is flagged against `up`, rebinding `viewOpen` to `Enter` is flagged
  against `work`, rebinding it to `m` (mail, dead Inside) is not.
- New `src/__tests__/lib/ReaderSteering.test.ts`: `cycleReaderView` (order,
  wrap, skips, Shift, a single offered view), registry last-wins/unregister,
  facts notify subscribers, `useSteeringInside`.
- New `src/__tests__/shell/SteeringReaderView.test.tsx` (the `SteeringScroll`
  harness): with a fake registered target, `Tab`/`Shift+Tab` call `show` with
  the right view at tabs, panes and scroll; level unchanged; no target → no
  call, no throw; repeat ignored.
- New `src/__tests__/shell/SteeringReaderInside.test.tsx`: fake inside target at
  scroll: `leave` → level `tabs`, `handled` stops, `pass` reaches the scroll
  default; unbound keys never reach it; a terminal (no target) behaves as in
  `SteeringScroll.test.tsx`.
- New `src/__tests__/terminal/ReaderChangesSteering.test.tsx` (the
  `TerminalReaderChanges.test.tsx` setup, three changes in two files): steering
  store `active/level: "scroll"`; `readerInsideFor(id).key("down")` moves
  `.steer-cursor`; `viewToggle` flips `aria-expanded`; `viewMode` flips
  split/unified; `viewOpen` calls `openFileEntry` (Shift → `newSubwindow`);
  `viewOpenAlt` opens the diff tab; Shift+down narrows to a file, past the last
  returns to All; `up` on the first card → `leave`, with `repeat` → `handled`;
  a delete/moved card ignores open; no cursor class when steering is off; no
  registration when `visible` is false.
- `SteeringBar.test.tsx` / `SteeringBindings.test.ts` legend cases
  (`steeringKeysFor`): reader chat/terminal → cycle row + terminal rows; changes
  → Diffs rows, no "scroll the terminal" rows; files → cycle row + Files rows;
  no `reader` → none; ladder label per view; rows unique by `actions|labelKey`.
- `TerminalReaderToolbar.test.tsx`: a mounted `TerminalView` registers a target
  whose `offered()` matches the strip's enabled tabs and whose `show("changes")`
  selects Diffs (extend if it already mounts `TerminalView`; otherwise cover
  `selectReaderView` through the registry plus the pure parts).
- The settings binding list gains the "Inside a view" section (assert via
  `STEERING_BINDING_SECTIONS`; `SteeringSettings.test.tsx` is the *region* test,
  not this).

## Filemap rows (`docs/filemap_frontend.md`, one line each)

- New: `lib/agents/readerSteering.ts` — steering's reach into a Reader pane:
  view registry + facts, Inside-view registry, `cycleReaderView`,
  `useSteeringInside`.
- Update: `lib/shortcuts/steeringBindings.ts` (the `inside` scope, `readerView`,
  `view*`), `lib/shortcuts/steeringBar.ts` + `SteeringLegend.tsx` (reader facts,
  ladder label), `terminal/TerminalReaderChanges.tsx` (steering cursor + Inside
  target), `terminal/TerminalView.tsx` row if it lists the panel state, the
  `lib/terminal/terminalScroll.ts` row (Diffs ↓ is no longer "to the end").
- Files plan rows: see its own list.

## Verification

- `scripts/gates.sh` in the background (frontend-only: `npm run build`, `npm
  test`, `npm run lint`, `scripts/brand-check.sh`; cargo gates untouched). No new
  `any`, no new lint warnings; `git diff --check`; `scripts/privacy-check.sh`
  before any push.
- Not run live (AGENTS: never start the app). `src/` hot-reloads into the user's
  window; no backend change, so no `backend:stale`.
- Click-through for the user, on an agent tab with a finished turn that edited
  files: (1) Shift+Space, land on the tab, press `Tab`: Diffs shows; again:
  Files; again: Terminal; again: Chat; `Shift+Tab` goes back. Legend shows the
  row only on agent tabs. (2) A fresh tab with no edits: `Tab` skips Diffs.
  (3) On Diffs press `D`: ladder reads "Inside Diffs", first card highlighted.
  `D`/`E` walk cards (viewport follows), `Z` folds, `U` flips layout, `O` opens
  the file in a tab, Shift+`O` in a new subwindow, `V` the diff viewer.
  Shift+`D` narrows to the next file, past the last back to All files. `S`/`F`
  scroll a long diff. While the agent edits again: `N` jumps to the New card.
  (4) `E` on the first card steps back to Tabs; holding `E` does not run out of
  the view. (5) `Tab` Inside Diffs switches to Files and the legend/ladder
  follow. (6) Enter leaves steering with the keys in the view; Esc leaves
  steering. (7) Settings → Shortcuts → "Inside a view" lists the five keys;
  rebinding `Z` to `E` shows the conflict. (8) Files-view steps: Files plan.

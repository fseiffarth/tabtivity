# Agent input dock — plan

Status: plan, reviewed against the code 2026-11-22; implementation run
started 2026-11-22. Handoff (the implementer writes it):
`docs/agent_input_dock_handoff.md`.

No blocking questions for the user.

## Why

A readable agent tab has four views in its top bar: Chat · Diffs · Data ·
Terminal. The input field (`ReaderComposer`) and the facts row above it belong
to Chat's panel. Diffs (`TerminalReaderChanges`) and Data
(`TerminalReaderFiles`) are full-pane overlays (`.terminal-changes`,
`position: absolute; inset: 0`) portaled beside `.terminal-reader`, which is
`hidden` while one is open. The composer stays mounted and keeps its draft, but
it cannot be seen or typed in. So:

- answering while reading a diff means switching to Chat;
- a diff note's "Add to draft" (`insertIntoReader` → `onReveal`) throws the
  user to Chat;
- Diffs and Data show nothing of a running turn (no working row, no Stop) or
  of a waiting question.

Goal: the input field stays under Chat, Diffs and Data. One composer instance,
one draft.

## Fixed decisions

Reviewers may not undo these.

The user's (asked 2026-11-22):

1. **Views.** Chat, Diffs and Data get the dock. Terminal stays the raw CLI
   with only its own prompt: nothing is added there.
2. **Size.** Under Diffs and Data the dock *rests* as one line (field, mic,
   Send). It *opens* to Chat's full dock (facts row + the card composer with
   Plan/Goal, Clear/Commit, mic, Send) while the field has focus or holds a
   draft. Chat always shows the full dock, exactly as today.
3. **Live state.** Under Diffs and Data only, one status line stands over the
   field, only while there is something to say:
   - working: the dots, Chat's working line, elapsed/tokens, "N queued" when
     prompts are queued, and Stop;
   - a question waits: "The agent asks a question", "Messages wait until it is
     answered", and a button "Answer in Chat" that switches to Chat.
   Idle: no line.

Decided here (recorded, not asked):

4. Sending from Diffs or Data stays in that view.
5. An insert into the draft (`insertIntoReader`: diff note "Add to draft",
   dropped files, pasted image, a picked earlier prompt) no longer reveals Chat
   while Diffs or Data is shown. The text lands in the docked field, which
   opens and takes focus. From Terminal nothing changes.
6. While a question waits (`inputBlocked` because of `shownLive.question` /
   `asyncAsk.sending`) the docked field under Diffs/Data is the resting line,
   disabled, placeholder "Answer the agent's question first". A draft is kept,
   not shown opened.
7. One instance: no second composer, no second draft store, no new global
   state, no new Tauri command, no backend change. The same `ReaderComposer`
   (draft, undo, history, `/` menu, voice, chips, subagent input) serves all
   three views.
8. Switching to Diffs or Data does not move the keyboard into the field: the
   panel root takes focus as today (`TerminalView` `focusReaderView`), so
   steering and scroll keys keep working. A click, steering's Prompt key
   (`registerReaderComposer`) or an insert focuses the field.
9. Keys in the docked field are Chat's: Enter sends, Esc is `onEscape` as in
   Chat. No panel-specific key map.
10. An earlier chat browsed read-only (`browsed`): under Diffs/Data the dock is
    Chat's read-only foot (`.terminal-reader-chat-foot`: Back, Resume this
    chat), no field and no status line.
11. The dock opens and closes without animation (WebKitGTK software path;
    `docs/context/desktop_ui_system.md`).
12. `TerminalReaderView` must not re-render per keystroke: `ReaderComposer`
    holds its own draft for that reason. It reports only the *transition*
    resting ⇄ open.
13. Out of scope: the phone PWA (`mobile-web`), Tabby and other `readerAlways`
    chats (they have no view tabs), non-readable agents' bottom strip.

## Decided in review

Open details the plan left, settled here so the implementer has no questions.

- **D1 — structure.** S1's structure stands: the panel moves *inside*
  `.terminal-reader` as a flex child. The other structure (dock outside the
  Reader root) would need a second portal for the composer or the composer
  moving between parents, which remounts it and loses draft/undo/voice state
  (decision 7). The hazards below are all local fixes.
- **D2 — who decides "open".** `TerminalReaderView` owns one boolean,
  `dockOpen`, and sets `dock-open` on the root. It is computed, not stored, from:
  `panelShown && !browsed && !inputBlocked && (dockEngaged || composerBusy ||
  statusOpen !== null || picking)`, where
  - `panelShown = shown && (changesOpen || filesOpen)`;
  - `inputBlocked` is the expression passed to the composer today, moved into
    a `const` (same for `questionOpen`);
  - `dockEngaged` — view state, see D3;
  - `composerBusy` — reported by `ReaderComposer` through a new
    `onBusy(busy: boolean)` prop, called from an effect only when the value
    changes: `draft.trim() !== "" || voice.listening || slashMenu.length > 0 ||
    steerOpen !== null`;
  - `statusOpen` (the `/status`·`/context` panel lives in the facts row) and
    `picking` (a facts-row picker is up) are view state already.
  Each input changes only on a transition, so the view never re-renders per
  keystroke (decision 12). The composer gets `resting = panelShown && !dockOpen`
  back as a prop.
- **D3 — engagement, not `:focus`.** WebKit does not focus a `<button>` on a
  mouse click, so "open while the textarea has focus" would close the dock on
  mouse-down of a chip, the mic or a facts-row picker, before the click lands.
  Instead: `TerminalReaderFacts` and `ReaderComposer` are wrapped in one
  `<div className="terminal-reader-dock">` with `display: contents` (Chat's
  layout and the `.terminal-reader-facts-wrap + .terminal-reader-composer`
  rule are unchanged). Its React `onPointerDown` and `onFocus` record
  `e.nativeEvent` in a ref and set `dockEngaged = true`; React handlers bubble
  through portals, so a menu portaled out of the dock counts as inside. While
  `panelShown && dockEngaged`, document listeners (`pointerdown` and
  `focusin`, bubble phase, removed in cleanup) clear `dockEngaged` for any
  event that is not the recorded one. Bubble phase matters: React's root
  listener runs before `document`'s, so the ref is set first. `dockEngaged` is
  reset to false whenever `panelShown` goes false.
- **D4 — resting textarea.** `ReaderComposer` gets `resting: boolean`.
  Resting: `rows={1}`, the short placeholder (or D5's), and the auto-height
  layout effect (today keyed on `[draft]`: `style.height = "auto"`, then grows
  to `scrollHeight`) is keyed on `[draft, resting]` and, when resting, sets
  `style.height = ""` and returns. Inline `height: auto` would otherwise beat
  any CSS height. CSS gives the resting box `min-height: 34px; max-height:
  34px; overflow: hidden`. That matters for a draft kept while blocked
  (decision 6).
- **D5 — blocked states.** `questionOpen` under a panel → resting, disabled,
  placeholder `terminal.reader.dockBlocked` ("Answer the agent's question
  first"). The CLI still starting (`inputBlocked` without `questionOpen`) →
  resting, disabled, the short placeholder (Chat also shows its normal
  placeholder on a disabled box). **Exception, as in Chat today:** a field
  steering's Prompt key opened (`steerOpen !== null`) stays enabled, because
  otherwise the keyboard would be handed to a disabled box. It still *rests*
  (D2 excludes `inputBlocked`), and Enter keeps the text with
  `answerQuestionFirst` / `notStarted`, as Chat and `docs/help/keyboard.md`
  (Space row) say today. Recorded under Reviewer notes.
- **D6 — chips and facts row stay rendered.** While resting they are hidden
  by CSS only (`display: none`), never unmounted. `factKey` (Alt+P/G/T/C/M/E)
  clicks `[data-reader-fact]` buttons, and `click()` works on hidden buttons.
  `ReaderComposerChips` keeps its Commit-menu state. `TerminalReaderFacts`
  keeps its polls (already keyed on the view's `visible`, which is already true
  under a panel: nothing new runs). Under the top bar, the only case with
  panels, `chipSlot` is `null` (`actionSlot || ASSISTANT_SCOPE ? null :
  chipSlot`), so the chips are inside `.terminal-reader-composer` (the
  `card-composer` rules) and the facts row's `.terminal-reader-facts-chips` is
  `:empty`. One CSS rule on the composer hides them.
- **D7 — `onReveal` and `acceptInserts` go.** `acceptInserts` is passed as
  `visible && shown`. After S2, `visible` is `visible && shown` too, so the two
  are equal. `onReveal` only ever fired under a panel, because in Chat
  `showReaderChat` is a no-op and under Terminal `shown` is false, so no insert
  is registered. Remove both props, `revealRef`, and the `onReveal={onShowChat}`
  at the call site. The insert handler keeps `box?.focus()`, which engages the
  dock (D3) and so opens it. When the box is disabled (a question), the focus
  fails and the dock rests with the draft kept (decision 6).
- **D8 — status line values.** Rendered only while `panelShown && !browsed`.
  - Working, session (`!openStep && live.working`): `workingLine`,
    `[live.working.elapsed, live.working.tokens && t("terminal.reader.workingTokens",
    { count: live.working.tokens })]` joined with " · " (Chat's row, verbatim),
    queued `queuedPrompts.length` (non-zero only while `queueCli`), Stop =
    `stop` (`pressEscape`), title `terminal.reader.stopHint`.
  - Working, subagent open (`openStep && subagentWorking`): `subagentModel ?
    workingModel-key : working-key`, `subagentFacts`, no queued count (Chat
    hides pending bubbles under a subagent), Stop only when `live.working`
    (Chat's rule).
  - Question: `questionOpen` exactly (`!!shownLive.question ||
    !!asyncAsk.sending`), so the line and the blocked field agree. It outranks
    working: one line, the question's.
  - "Answer in Chat" calls `onShowChat`, then on the next tick
    `focusQuestionOption(regionRef.current)` (the existing helper; `closest`
    matches the root itself) so the keys answer at once. Without that, focus
    falls to `<body>`, because Chat's composer is disabled.
  - `ReaderDockStatus` takes plain values: `{ kind: "working" | "question",
    line?, facts?, queued?, onStop?, onAnswerInChat? }`, no store, no hooks
    besides `useT`.
- **D9 — steering hides the dock as it hides Chat's composer.** While steering
  holds the keyboard, `ReaderComposer` returns `null` (`steering && steerOpen
  === null`). Under a panel that leaves the status line and nothing under it,
  the same rule Chat follows. No change.
- **D10 — voice under a panel.** `useReaderVoice` gets `visible = true` under
  a panel now: the mic in the resting line works, and the hands-free loop
  re-listens after an answer under Diffs/Data too, while read-aloud already
  ran there (it is keyed on the view's `visible`). Intended: one composer for
  all three views (decision 7).
- **D11 — strings.** New keys in **all five** dictionaries (`en`, `de`, `es`,
  `fr`, `it`). `src/__tests__/shell/i18n.test.ts` fails on a key missing from
  any language, on a stray key, and on a `{placeholder}` mismatch; recent
  commits (e.g. `bf98e456e`) add every key to all five. Keys:
  `terminal.reader.dockPlaceholder` ("Message the agent — Enter sends"),
  `terminal.reader.dockBlocked` ("Answer the agent's question first"),
  `terminal.reader.dockQuestion` ("The agent asks a question"),
  `terminal.reader.dockQuestionHint` ("Messages wait until it is answered"),
  `terminal.reader.dockAnswerInChat` ("Answer in Chat"),
  `terminal.reader.dockQueued` ("{count} queued"). Reuse
  `terminal.reader.working`, `workingModel`, `workingTokens`, `stop`,
  `stopHint`.
- **D12 — pill.** One row in `src/lib/untested.ts`, inside `UNTESTED`:
  `"terminal.reader.dock": { area: "agents", what: "Agent pane · Diffs and Data
  views · the Chat's input field docked under the panel: one line at rest,
  Chat's full dock (facts row, Plan/Goal, Clear/Commit) while engaged or
  holding a draft; same draft as Chat; sending, Add to draft, dropped files
  and a picked earlier prompt stay in the view; a status line over it while
  the agent works (Stop, queued count) or asks (Answer in Chat)" }`. One
  literal `<UntestedTag id="terminal.reader.dock" />` call site, inside the
  composer, rendered only while `docked` (the composer's new `docked` prop =
  `panelShown`), in the resting row's right end before the mic.
  `src/__tests__/shell/UntestedRegistry.test.ts` fails on a call site without a
  row and on a row without a call site, so the row and the pill land in the
  same commit.

## What the code looks like today (verified 2026-11-22)

- `src/components/terminal/TerminalView.tsx`
  - 2519–2604: `readerOnHost`, `readerAvailable`, `readerTopBar`
    (`readerAvailable && !readerAlways`), `panelPicked`
    (`"changes" | "files" | null`, 2527), `changesOn` (2532), `filesOn`,
    `panelOn`, `readerOn` (2538), `setReader`, `showReaderChat` (2547: only
    `setPanelPicked(null)` + set the CLI's choice), `readerViewNow`,
    `focusReaderView` (2563: Chat → `host.querySelector(".terminal-reader-composer
    textarea")`, Diffs/Data → `host.querySelector(".terminal-changes")`),
    `selectReaderView` (2569, focuses through `setTimeout`),
    `registerReaderViews` / `publishReaderViewFacts`.
  - 2705–2750: the pane's drop handler; it inserts into the Reader when
    `readerOnRef.current && insertIntoReader(id, text)`, else pastes into the
    xterm.
  - 2780–2805: `TerminalPromptStrip` with `onReturnFocus={() =>
    focusReaderView(readerViewNow)}`, `chatShown={readerOn}`.
  - 2804–2827: `<TerminalReaderView … visible={visible && readerOn}
    focused={focused && readerOn && !panelOn} shown={readerOn}
    changesOpen={changesOn} filesOpen={filesOn} onShowChat={showReaderChat}
    onShowFiles=… navigationSlot actionSlot />`.
  - Expected change in this file: none (verify only; decision 8 needs
    `focused` to stay `!panelOn`).
- `src/components/terminal/TerminalReaderView.tsx`
  - `focusQuestionOption` (186), `OPTION_BUTTONS` (182).
  - `ReaderComposer` (702–1430). Props: `focused`, `visible`,
    `acceptInserts = visible`, `onReveal`, `steering`, `questionOpen`,
    `inputBlocked`, `chipSlot`, `actionSlot`, … Inside:
    - textarea auto-height `useLayoutEffect` on `[draft]` (~784–789);
    - `registerReaderComposer` while `visible` (855–858);
    - "the Chat went out of view" effect, `[steerOpen, visible]`: it gives the
      keyboard back to steering (877–882);
    - the focus effect, `[focused, visible, steering, inputBlocked, ptyId]`
      (909–925);
    - the insert handler `onReaderInsert` while `acceptInserts`, calling
      `revealRef.current?.()` first (929–940);
    - `onComposerPaste` → `insertIntoReader` (947–952);
    - `useReaderVoice({ visible, … })` (1029);
    - `useCheckpointNow(sessionId, visible)` (1204);
    - `factKey` clicks `[data-reader-fact]` inside `.terminal-reader` (1305);
    - `if (steering && steerOpen === null) return null;` (1354);
    - `textarea rows={3}`, `disabled={inputBlocked && steerOpen === null}`;
    - `sendError` portaled into `actionSlot` when `actionSlot && !visible`,
      else `.terminal-reader-error` (1420–1425); `.terminal-reader-waiting`
      while `holding`.
  - `TerminalReaderView` (1456–): `steering` (1589), `live` (1606),
    `workingLine` (1633), `canAnswerAsync` (1780, already `!changesOpen &&
    !filesOpen`), `asyncAsk` (1782), `stop = pressEscape` (1823), `shownLive`
    (1824), the effect that focuses the root when a browsed chat opens
    (1993–1995), `queueCli` / `queuedPrompts` (2305–2307), `subagentWorking`,
    `subagentModel`, `subagentFacts` (2495–2516), `onRegionKey` (2544: Esc →
    `chatBack`/`subagentUp`, only while `browsed`).
  - Render (2689–3032), all in one `createPortal(<>…</>, host)`:
    `ReaderSelectionMenu` (`enabled={visible && shown && !changesOpen &&
    !filesOpen}`), then the root `div.terminal-reader` (`ref={regionRef}`,
    classes `terminal-reader ${SIGN_IN_CARD_CLASS}` + `browsing` +
    `has-topbar` + `card-composer`, `hidden={!shown || changesOpen ||
    filesOpen}`, `role="region"`, `tabIndex={browsed ? -1 : undefined}`,
    `onKeyDown={onRegionKey}`). Inside it: the browsed bar
    (`nav.terminal-reader-subagent-bar.terminal-reader-chat-bar`), the open
    subagent's bar (`nav.terminal-reader-subagent-bar`) or `subagentsMenu`
    when there is no `navigationSlot`; then `.terminal-reader-stream`, which
    holds the `PathLinksContext` / `ReaderInboxContext` /
    `ReaderAnswerFilesContext` providers around the list only, `PathLinkHint`,
    `ReaderArtifactDialog` and the pinned prompt; then `TerminalReaderFacts`
    (when `tab && !browsed && scope !== ASSISTANT_SCOPE`); then the browsed
    foot or `ReaderComposer` (`visible={visible && shown && !changesOpen &&
    !filesOpen}`, `acceptInserts={visible && shown}`, `onReveal={onShowChat}`,
    `questionOpen={!!shownLive.question || !!asyncAsk.sending}`,
    `inputBlocked={…same… || (!!terminalFor(ptyId) && !shownLive.status &&
    !shownLive.working)}`). After the root, as siblings: the `navigationSlot`
    portal, `checkpoints.dialog`, `TerminalReaderChanges` (`changesOpen &&
    shown && tab`), `TerminalReaderFiles` (`filesOpen && shown`); both get
    `onClose={() => onShowChat?.()}` and `steerId={ptyId}`.
  - Chat's working row: `.terminal-reader-working` with
    `.terminal-reader-working-dots` and a `.terminal-reader-stop` button
    (2850–2876), inside the list.
- `TerminalReaderChanges.tsx` root: `<aside ref={rootRef} className="terminal-changes
  terminal-changes-tab terminal-sign-in" tabIndex={-1}>` (673), no key
  handler of its own; `registerReaderInside` while `visible` (656–665);
  `addToDraft` (585) → `insertIntoReader`, else the `diffNotes.noComposer`
  notice; its comment says the insert "takes the Reader to Chat itself".
- `TerminalReaderFiles.tsx` root: `<aside className="terminal-changes
  terminal-changes-tab terminal-files terminal-sign-in" tabIndex={-1}>` (204);
  `registerReaderInside` (153–194, ←/→ scroll `largestScroller(viewerRef)`);
  the embedded `FileViewerPane … visible={visible}` (286).
- `insertIntoReader` callers (`lib/terminal/terminalDrop.ts` 153): the drop
  handler (`TerminalView` 2735), `onComposerPaste` (`TerminalReaderView` 949),
  `ReaderSelectionMenu`'s Add to draft / Quote (2693, Chat only),
  `TerminalReaderChanges` `addToDraft` (586), `CheckpointRestoreDialog`
  `restore` note (103, opened from Diffs or a Chat bubble), and
  `TerminalPromptStrip` `reuse` (227, Enter on a picked earlier prompt while
  `chatShown`, which is already `readerOn` and so true under a panel). All of
  them fall back when it returns false; none needs a change.
- `lib/terminal/terminalScroll.ts` `readerList` (57–59): `:scope >
  .terminal-changes .terminal-changes-list, :scope >
  .terminal-reader:not([hidden]) .terminal-reader-list`. It assumes the panel
  is a direct child of the host and that the root is hidden under a panel.
- `lib/agents/readerSteering.ts`: `registerReaderComposer` /
  `openReaderComposer` (127–138); `steeringAgent.ts` `requestSteeringPrompt`
  (131) tries the composer, else the window's prompt box. Under Diffs/Data
  today no composer is registered, so the Prompt key opens the prompt box.
  `useSteering.ts`: the scroll level asks `readerInsideFor(pty)` first (942),
  and both panels answer `pass` for `agentPrompt`, so it reaches the
  `agentPrompt` case (1115). `workHere` (419–440) leaves the keyboard where a
  panel has it.
- `src/styles/subwindows.css`: `.prompt-strip, .terminal-reader {
  --prompt-strip-h }` (2169); `.terminal-reader` (2599: `position: absolute;
  inset: 0; z-index: 4`, flex column); `.terminal-reader-stream` (2611);
  `.terminal-reader.browsing:focus` (3290); `.terminal-reader-chat-foot`
  (3312); `.terminal-changes` (3397: absolute, `inset: 0`, `z-index: 4`);
  `.terminal-reader-composer` … `.terminal-reader-mic` (3771–3935);
  `.terminal-reader[hidden] { display: none }` (4044); the `card-composer`
  rules (4049–4068: chips absolutely placed over the textarea's 42px bottom
  padding, `min-height: 108px`, the `::before` strip); `.terminal-reader-error`
  / `-waiting` (4069–4086); `.terminal-reader-slash` (4087, `z-index: 2`, opens
  upward); `.terminal-reader-facts-wrap` (4175); `.terminal-reader-facts-wrap
  + .terminal-reader-composer { border-top: none }` (4294);
  `.terminal-reader-picker` (4295, `z-index: 1`); `.terminal-reader-commit-menu`
  (`z-index: 2`, opens upward); `.terminal-reader-working`, `-dots`, `-stop`
  (4677–4770; the dots' opacity loop runs only while work is in progress, and
  has a reduced-motion stop).

## Hazards of S1 (each with what to do)

- **H1 — steering scroll goes to the hidden chat.** `terminalScroll.ts`
  `readerList` will no longer find `:scope > .terminal-changes`, and
  `.terminal-reader:not([hidden]) .terminal-reader-list` will match the
  CSS-hidden chat list first. Change the selector to
  `:scope > .terminal-reader:not([hidden]) > .terminal-changes
  .terminal-changes-list, :scope > .terminal-reader:not([hidden]):not(.panel-open)
  .terminal-reader-list`, and update its comment.
- **H2 — popups painted under the panel.** `.terminal-changes` has `z-index:
  4`. Inside the root, a positioned panel earlier in the DOM would paint over
  the dock's upward popups (`.terminal-reader-slash` z 2, commit menu z 2,
  facts pickers z 1, which live in the root's stacking context). The in-Reader
  rule sets `z-index: 0` (a stacking context of its own, below them), not
  `auto` and not 4.
- **H3 — Esc in a panel runs `chatBack`.** The panel becomes a React and DOM
  child of the root, so its keydowns now bubble into `onRegionKey`. With a
  browsed chat, Esc in a diff note box (`DiffNoteBox`), the file viewer's
  editor/search or the panel root would leave the browsed chat. Fix: in
  `onRegionKey` return early when `event.target` is inside
  `.terminal-changes` (`(event.target as Element).closest?.(".terminal-changes")`).
  No other handler sits on the root.
- **H4 — the browsed-chat focus effect steals the panel's focus.** The effect
  at 1993 (`chatId && visible` → `regionRef.current.focus()`) failed silently
  on the hidden root. Now it would take focus off the panel when a chat is
  picked from Resume while Diffs/Data shows. Add `&& !changesOpen &&
  !filesOpen` and add both to its deps.
- **H5 — the composer's focus "fromThisPane" check.** `box.closest(".terminal-reader")`
  now contains the panel too. It runs only while `focused`, which stays false
  under a panel (decision 8), so no change. Leave a one-line comment.
- **H6 — CSS that assumed a hidden root.** Only `.terminal-reader[hidden]`
  (4044) depends on it, and it still holds for `!shown` (Terminal). No
  descendant rule under `.terminal-reader` other than the `card-composer`
  ones (composer only), so the panel inherits nothing but `color`,
  `font-family` and `font-size` (the panel sets its own `--text-sm`).
  `SIGN_IN_CARD_CLASS` is on both the root and the panel, as before: the
  pane's mouse handlers skip both.
- **H7 — providers.** The chat's context providers wrap only the list inside
  `.terminal-reader-stream`. Render the panel as a sibling of the stream,
  never inside it, and it sits inside no new provider.
- **H8 — hidden Chat parts stay in the DOM.** jsdom loads no CSS. Tests must
  assert the `panel-open` / `dock-open` classes, and must query the status
  line within `.terminal-reader-dock-status`, because Chat's own working row
  (`role="status"`) is still in the document under a panel.
- Checked, no change needed: `focusReaderView` (both queries search the
  whole host); `registerReaderInside` and `largestScroller` (scoped to the
  panel's own elements); `FileViewerPane` (`visible` unchanged; it now sits in
  the root's flex column, so its parent `.terminal-files-viewer` needs the
  panel to keep `min-height: 0`); `steeringRegion` `activeTabCard` (the first
  shown `.terminal-sign-in` is now the root rather than the panel, the same
  as in Chat); `activeSubagentFrame` / `activeSubagentControl` (the bars are
  `display: none` under a panel, as they were inside the hidden root);
  popouts and attach-only panes (same `TerminalView` path, top bar included).

## Layout

```
.terminal-reader  (flex column, as today; no longer hidden for a panel)
  bars, .terminal-reader-stream            ← display:none while .panel-open
  .terminal-changes (Diffs or Data)        ← flex child: flex 1, min-height 0
  ReaderDockStatus                         ← panel open + working or question
  .terminal-reader-dock (display:contents)
    TerminalReaderFacts                    ← Chat: always; panel: only .dock-open
    ReaderComposer | read-only foot
```

- The panel is rendered *inside* `.terminal-reader`, after the stream (H7),
  not as an absolute overlay beside it. Under `.terminal-reader` it is
  `position: relative; inset: auto; z-index: 0; flex: 1 1 auto; min-height: 0`
  (H2). Chat's other parts (the browsed bar, the subagent bar or
  `.terminal-reader-subagent-index`, the stream with its pinned prompt and
  path hint) are hidden by
  `.terminal-reader.panel-open > :is(.terminal-reader-subagent-bar,
  .terminal-reader-subagent-index, .terminal-reader-stream)`. Nothing of them
  is unmounted: the chat and its scroll position survive a view switch, as
  today. `ReaderSelectionMenu` stays gated off as it is.
- Resting field (`.panel-open:not(.dock-open)`): strip padding `8px 14px`, the
  field one line (34px high, padding `7px 72px 7px 12px`, `--radius`), mic
  and Send in its right end (the card-composer mic/Send offsets reset to the
  plain ones), no chips row, no `::before` strip, no facts row. Placeholder:
  `terminal.reader.dockPlaceholder`.
- Open under a panel (`.panel-open.dock-open`): exactly Chat's dock (the
  `card-composer` rules, which already apply: the class is on the root).
- Status line `.terminal-reader-dock-status`: one row, `padding: 6px 14px`,
  `--bg-panel`, `border-top: 1px solid var(--border-subtle)`. When it is drawn,
  the strip under it has no top border of its own
  (`.terminal-reader-dock-status + .terminal-reader-dock
  :is(.terminal-reader-facts-wrap, .terminal-reader-composer):first-child`, or
  set a `has-dock-status` root class: the implementer picks one). It reuses the
  `.terminal-reader-working-dots` and `.terminal-reader-stop` classes, but not
  `.terminal-reader-working` itself, which is a pill (`align-self:
  flex-start`, `--radius-full`).
- Theme tokens only; no new colours. No transition on height or on the
  facts/chips showing. No new animation: the dots' existing loop is tied to
  work in progress, so it needs no `[data-software-paint]` gate.

## Steps

Commit units, in order. One implementer runs all of them. **Each commit is
green on its own.** A step updates the tests it breaks, and adds its own
strings (all five dictionaries) and register row, in the same commit.

### S1 — the panel moves into the Reader (no visible change yet)

- `TerminalReaderView.tsx`: render `TerminalReaderChanges` /
  `TerminalReaderFiles` inside `.terminal-reader`, right after
  `.terminal-reader-stream` and before the facts row (H7), with their
  conditions unchanged. Drop `changesOpen || filesOpen` from the root's
  `hidden` (it stays `!shown`). Add the root class `panel-open` while
  `changesOpen || filesOpen`. Keep `ReaderSelectionMenu`, `canAnswerAsync`,
  the navigation portal and every other `!changesOpen && !filesOpen` gate as
  they are. Fix H3 (`onRegionKey`) and H4 (browsed focus effect).
- `subwindows.css`: the in-Reader `.terminal-changes` rule (Layout), and the
  `panel-open` hide rule. In this step it also hides the facts row,
  `.terminal-reader-composer`, `.terminal-reader-error`,
  `.terminal-reader-waiting` and `.terminal-reader-chat-foot`, so S1 looks
  exactly like today. S2 narrows that rule.
- `lib/terminal/terminalScroll.ts`: H1.
- Tests to update in this commit:
  - `src/__tests__/terminal/TerminalReaderChanges.test.tsx`, "opens a
    full-width Diffs tab, newest first, with split and unified views": it
    asserts `chat?.hidden` is `true`. Assert instead: not hidden, has
    `panel-open`, and `chat.contains(panel)`.
  - `src/__tests__/shell/SteeringScroll.test.tsx`, "scrolls Diffs when
    selected, and ignores the hidden Chat when returning to Terminal": its
    fixture is the old shape (`<div class="terminal-reader" hidden>…</div><aside
    class="terminal-changes">`). Make it the new one (`<div
    class="terminal-reader panel-open"><div class="terminal-reader-list"></div><aside
    class="terminal-changes"><div class="terminal-changes-list"></div></aside></div>`).
    For the "back to Terminal" half, remove the aside, remove `panel-open` and
    set `hidden` on the root. Keep the assertions.
  - Add to `TerminalReaderChanges.test.tsx`: with a browsed chat
    (`useReaderChatsStore.getState().browse(…)`) and Diffs open, Esc keydown
    on the panel does not leave the browsed chat (H3).

### S2 — resting and open dock

- `ReaderComposer`: `visible` is now `visible && shown` from the call site (no
  `!changesOpen && !filesOpen`). New props: `docked` (= `panelShown`),
  `resting` (D2), `onBusy` (D2). Remove `acceptInserts` and `onReveal` (D7).
  Effects keyed on `visible` and what each now does under a panel:
  - `registerReaderComposer`: registers under a panel, so steering's Prompt
    key opens the docked field instead of the window's prompt box. Wanted (S4).
  - "the Chat went out of view" (`[steerOpen, visible]`): it now fires only
    for Terminal or a hidden pane, so a Prompt-key field stays open across
    Chat ⇄ Diffs. Wanted.
  - The focus effect: unchanged, because `focused` stays false under a panel
    (decision 8).
  - The insert handler: registered under a panel already. Only the reveal
    goes (D7).
  - `useReaderVoice({ visible })`: D10.
  - `useCheckpointNow(…, visible)`: lists the session's checkpoints under a
    panel now too. A cheap read, and Diffs already reads the same scope
    (`useCheckpointScope`). Accept.
  - The `sendError` portal (`actionSlot && !visible`): under a panel the error
    is now drawn in the dock (`.terminal-reader-error`), never in the top bar.
    So is the "waits for your answer" line. Both come out of `visible` alone.
- Resting (D4, D5): `rows`, the placeholder, the height effect, `disabled`
  (`inputBlocked && (steerOpen === null)`, unchanged; D5's exception falls out
  of it). In the ↑/↓ question-walk branch of `onComposerKey`, add `!docked`:
  under a panel the question rows are hidden.
- `TerminalReaderView`: hoist `questionOpen` / `inputBlocked` into consts;
  `panelShown`, `composerBusy` (state set by `onBusy`), `dockEngaged` (D3),
  `dockOpen`, the root class `dock-open`; the `.terminal-reader-dock` wrapper
  around the facts row and the composer/foot, with its React handlers and the
  document listeners, registered only while `panelShown && dockEngaged`.
- `subwindows.css`: narrow S1's hide rule to the resting dock: the facts row
  and `.terminal-reader-chips` hidden under `.panel-open:not(.dock-open)`; the
  resting strip/field rules (Layout); `.terminal-reader-dock { display:
  contents }`.
- Strings: `dockPlaceholder`, `dockBlocked` (D11).
- Pill and register row: D12.
- Tests to update in this commit:
  - `src/__tests__/terminal/TerminalReaderToolbar.test.tsx`, "keeps the draft
    across Chat, Diffs and Terminal; Clear and Commit sit in the composer": it
    asserts `queryByRole("textbox")` is `null` under Diffs. It is now the same
    box (`toBe(box)`), with the kept draft, and the root has `dock-open`
    (draft non-empty). Under Terminal it is still gone (`shown` false).

### S3 — status line

- New `src/components/terminal/ReaderDockStatus.tsx` (D8 props), rendered by
  `TerminalReaderView` between the panel and `.terminal-reader-dock` while
  `panelShown && !browsed` and there is something to say (D8). The dots are
  `aria-hidden`; the row is `role="status"`; the Stop and Answer buttons are
  plain `<button type="button">` with the existing classes.
- Strings: `dockQuestion`, `dockQuestionHint`, `dockAnswerInChat`,
  `dockQueued` (D11).

### S4 — inserts and steering stay in the view

- Already done by S2 (D7). This step adds the tests and fixes comments:
  - `src/__tests__/terminal/TerminalReaderToolbar.test.tsx`, "returns to Chat
    when a prompt or dropped file is inserted while reviewing Diffs": invert
    it. The Diffs tab stays `aria-selected`, the box holds `"draft file.ts"`,
    `document.activeElement` is the box, and the root has `dock-open`. Rename it
    ("keeps Diffs when a prompt or dropped file is inserted, the docked field
    open").
  - `src/__tests__/terminal/ReaderDiffNotes.test.tsx`, "takes a note on a split
    row, counts it, and puts the prompt into the Chat box": also assert the
    panel is still in the document (`.terminal-changes`). This test mounts
    `TerminalReaderView` directly with `changesOpen` and no `onShowChat`, so
    the view cannot switch; the Toolbar test above is the one that proves the
    view stays.
  - Steering: a test in `src/__tests__/terminal/TerminalReaderView.test.tsx`
    beside "shows the composer for steering's Prompt key, and hides it again
    on Esc". With `changesOpen` and steering on `"scroll"`,
    `openReaderComposer("p:agent-1", "scroll")` returns `true`, the box takes
    focus, the root has `dock-open`, and Esc gives steering back on `"scroll"`.
- Comments: `TerminalReaderChanges` `addToDraft` ("takes the Reader to Chat
  itself"); `TerminalPromptStrip` `reuse` ("Over the chat"); `readerSteering.ts`
  `openReaderComposer` / `registerReaderComposer` docs ("Chat composer … false
  on Terminal view").

### S5 — the dock's own tests, docs, todo

- New `src/__tests__/terminal/ReaderInputDock.test.tsx`, mounting
  `TerminalReaderView` (pattern: `TerminalReaderChanges.test.tsx` /
  `TerminalReaderToolbar.test.tsx`'s `Pane`). It covers: the field is in the
  document and enabled under Diffs and under Data; resting (no `dock-open`)
  on show, open on focus/pointerdown in the field, on a draft, and on
  pointerdown on a chip (the chip's click still lands: Plan toggles the
  prefix); back to resting on a pointerdown in the panel with an empty draft;
  the panel root, not the field, has focus after a switch to Diffs; send from
  Diffs stays in Diffs; the status line for working (with Stop → `\x1b`
  written), queued (`N queued`), question (blocked field + placeholder,
  "Answer in Chat" calls `onShowChat`), absent when idle and absent under
  Chat; the browsed foot under Diffs with no field and no status line. Query
  by class/role inside `.terminal-reader-dock-status` / `.terminal-reader-dock`
  (H8).
- Check, and change only if it fails: `TerminalReaderSteerViews.test.tsx`
  mocks `TerminalReaderView` and asserts nothing about the root or the
  composer. `ReaderChangesSteering.test.tsx` and
  `SteeringReaderFiles.test.tsx` mount the panels alone. `Checkpoints.test.tsx`
  mocks `insertIntoReader`.
- Docs:
  - `docs/context/agent_reader.md`: line 9 (Diffs/Data "occupies the whole
    pane"; "The chat and its draft remain mounted across view switches": add
    that the composer docks under Diffs/Data, the resting/open rule, the
    status line and the panel-inside-root structure with H1–H3); line 17
    ("(which reveals Chat)" → stays in Diffs, the docked field opens).
  - `docs/filemap_frontend.md` (grep, never read whole): a new row for
    `terminal/ReaderDockStatus.tsx`; touch the `TerminalReaderView` row (327),
    the `TerminalReaderChanges` row (337, "over the still-running terminal" →
    inside the Reader, above the docked field), the `steeringAgent` row (562,
    "when the Chat is up" → Chat, Diffs or Data), and the `terminalScroll` row
    (662) if its wording no longer fits.
  - User help (the help MCP serves these): `docs/help/agent-clis.md` ~354
    ("puts all your notes … into the Chat's text box" → the text box under
    Diffs; one sentence saying the box stays under Diffs and Data);
    `docs/help/keyboard.md` ~113 (Space: "with its Chat view shown" → Chat,
    Diffs or Data).
  - `DOCUMENTATION.md`: `rg -n` found no desktop sentence saying the composer
    is Chat's only (its Diffs mention, ~527, is the phone's). Change nothing
    unless a new search finds one.
  - `todo/group-s-agents.md`: one new top-level item beside "Notes on diff
    lines" (same shape: bold title, "implemented <date>, never live; frontend
    only", plan/handoff paths, pill `terminal.reader.dock`), with a
    `[x] 🤖 Automated test (…)` child and one `[ ] 🖐️ Manual QA: …` child
    (the Verification click-through) carrying the eight platform children
    (`✅ Works on` / `❌ Doesn't work on` × `Linux (X11)`, `Linux (Wayland)`,
    `Windows`, `macOS`, unticked). In the existing diff-notes manual item,
    change "the Chat composer holds the prompt" to "the field under Diffs
    holds the prompt".

## Rules from AGENTS.md that apply

- All display text through `useT()`; English in `en.ts` and every key in the
  four other dictionaries (D11). No hardcoded strings, including `title`s and
  `aria-label`s on the status line's buttons.
- `UntestedTag` with a register row (D12).
- No animated blurred `box-shadow`. The textarea's focus ring is static and
  stays so. No new animation loop (Layout).
- Gate work in hidden panes: the only new listeners (D3) exist only while
  `panelShown && dockEngaged`, and `panelShown` implies `shown`. No new timers.
  The status line reads values the view already computes.
- No new global state, no new Zustand store, no Tauri command, no backend
  change (decision 7). `src-tauri/` untouched, so `backend:stale` is not
  needed.
- Lint rules (`eslint.config.js`): no bare `listen()`, no
  `.split("/").pop()`, no plugin-dialog `confirm`. The document listeners are
  DOM `addEventListener` with cleanup, which is allowed. No new `any`, no new
  `exhaustive-deps` warning. If an effect deliberately omits a dependency,
  copy the file's existing `eslint-disable-next-line` style with a reason.
- Never spell the app's name in code or dictionary values (`brand-check.sh`).
- Comments: match the file's style (what and why, no history).

## Verification

- `scripts/gates-job.sh start` in the worktree, wait on `<job>/exit-code`,
  then `status` once. Frontend only: `npm run build`, `npm test`,
  `npm run lint` (no new warnings, no new `any`), `scripts/brand-check.sh`.
  Compare the test *count* with the baseline's.
- Never run the app. Click-through for the user:
  1. Agent tab → Diffs: the one-line field is under the diff cards.
  2. Click it: facts row and chips appear; click Plan: it toggles and the
     dock stays open; type; switch to Chat: same draft.
  3. Send from Diffs: view stays; status line shows working and Stop.
  4. Add a note on a diff line → Add to draft: stays in Diffs, field opens.
  5. Data: same field; a `/` opens the slash menu over the file viewer, not
     under it. Terminal: no field.
  6. A permission ask while in Diffs: status line, disabled field, Answer in
     Chat switches and the question's row has the keyboard.
  7. Steering on, inside Diffs: Space opens the docked field; Esc returns to
     the Diffs cursor; S/F still scroll the diffs, not the hidden chat.

## Reviewer notes

- **Structure kept (D1).** Moving the panel inside the root is the cheaper
  correct structure. Its hazards are H1–H4 (four local fixes) plus H8 for the
  tests.
- **D5's Prompt-key exception** is the one place where the docked field is
  enabled while a question waits. It keeps today's rule for a field the
  Prompt key opens (`docs/help/keyboard.md`, the Space row). A disabled box
  there would leave the keyboard nowhere. It still rests, so decision 6's
  look holds. If the user wants it disabled there too, the Prompt key must
  instead return `false` under a panel while `questionOpen` (then the window's
  prompt box opens). That is a one-line change in `openForSteering`.
- **Step order changed.** The old plan put all test updates in S5. With a
  green commit per step, each step now carries the test updates it forces,
  and its strings and pill. S5 keeps the new dock test file and the docs.
- **Size.** One implementer for S1–S5 is right: every step edits
  `TerminalReaderView.tsx` and `subwindows.css`. S2 is the largest (D2–D6);
  if it grows past one sitting, split it as S2a (props, `visible`, `onBusy`,
  removal of `onReveal`/`acceptInserts`) and S2b (engagement, resting CSS).

## Organisation

Small and coupled: almost every step edits `TerminalReaderView.tsx`
(3000 lines) and `subwindows.css`, so parallel implementers would only
conflict. Three Opus subagents, one at a time:

1. **Plan reviewer** — reads this plan against the code and `AGENTS.md`,
   edits the plan (wrong paths, missing steps, steps that cannot work),
   leaves the fixed decisions alone. *Done 2026-11-22.*
2. **Implementer** — S1–S5 in one worktree, a green commit per step, writes
   the handoff.
3. **Final reviewer** — the whole range: bugs only, each fix with a
   regression test; design objections go under "Flagged for user" in the
   handoff.

| Agent step | Plan steps | Main files |
|---|---|---|
| A (implementer) | S1–S5 | `TerminalReaderView.tsx`, `ReaderDockStatus.tsx`, `subwindows.css`, `terminalScroll.ts`, i18n (5 dictionaries), `untested.ts`, tests, docs, `todo/group-s-agents.md` |
| B (final reviewer) | whole range | the same |

The main agent lands the range on `develop` and reports.

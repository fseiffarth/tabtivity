# Prompt chart redesign: handoff from implementer A (steps 1-5)

Branch `prompt-chart-redesign` (worktree `.claude/worktrees/agent-a40cba7d0f34f1d42`),
started from `develop` at `4cf65018d`. Plan: `docs/done/prompt_chart_redesign_plan.md`.
Nothing here was run live; every claim below is from tests, `tsc`, lint and
reading the CSS.

## Steps

| Step | Commit | State |
| --- | --- | --- |
| 1. Shell: command bar, three columns, timeline fills the tab | `0ee64cbf2` | done |
| 2. Inspector replaces expand-in-place | `c8f561ddc` | done |
| 3. Card face and anchoring | `e7b2800af` | done |
| 4. Axis: Now pill and the folded night | `762b4995e` | done |
| 5. Help and options popovers | `cfd94933b` (tests only, see below) | done |

Steps 6-10 are untouched.

## Where the plan was silent, and what I chose

Step 1
- **The Help and Options components landed in step 1**, not step 5: the command
  bar needs its two buttons, and leaving them dead for three commits was worse
  than moving the work. The step-5 commit is the tests that pin them.
- `PromptChartCommandBar.tsx` exports `PromptChartPopoverButton` (a button that
  drops a popover through `ContextMenuPortal`, `keepBelow`, class
  `agent-prompt-popover`). Filters, Options and Help all use it. Use it for any
  new bar popover (the composer's When menu is its own thing).
- The Filters popover uses **chip rows**, not `Dropdown`s, for agent / outcome /
  when: a Dropdown inside a portaled popover is a menu inside a menu. The
  Options popover does hold the two `Dropdown`s the plan asks for.
- `PromptChartFilterBar` is now the popover body (same file name). The
  `shown of total` count is `strip matches + timeline session matches` over
  `cards.length`, always visible in the popover; Clear appears only while a
  facet is set. The Filters button gets `is-active` while any facet is set.
- The Drafts column: collapse state `storageKey("promptChart.drafts")` =
  `collapsed`, width `storageKey("promptChart.draftsWidth")` (240-720, default
  288). A collapsed column unmounts the board (layout lives in localStorage, so
  nothing is lost) and stays the unschedule drop zone (`stripRef`). The handle is
  a `role="separator"`, pointer drag via `bindDragRelease`, and Left/Right keys
  move it by 16 px.
- List layout is now one card per row at the column's width; Free keeps the
  168 px cards. The viewport scrolls inside the column (no `max-height`).
- `DraftBoardHandle` gained `setFree(free)`. The List | Free switch is drawn by
  `PromptChart` and reads `draftBoard.current?.free`; it re-renders via the
  board's `onLayout` -> `refreshLinks`, as the links did before.
- Layout geometry: `.agent-prompt-chart` is a container (`container-type:
  inline-size`) and `.agent-prompt-chart-columns` is the grid; below 899 px of
  the chart's own width the columns stack. The timeline body is
  `height: 100%` and scrolls inside; a `.agent-prompt-timeline-sizer` child
  carries the lanes' height (`bodyHeight`) so lifted and queued cards still
  scroll.
- The composer row (step 6) goes between `PromptChartCommandBar` and the
  `.agent-prompt-chart` div in `PromptChart.tsx`. The temporary "New draft"
  button in the Drafts header (`draftBoard.compose()`) is yours to remove.
- Retired i18n keys (all five dictionaries): `draftSearch`, `timelineSearch`,
  `timeline`, `timelineTitle`, `hideTimeline`, `showTimeline`, `zoomHint`,
  `dropHint`, `draftLayoutHint`, `draftCreateHint`, `completionHint`,
  `selectHint`, `draftFreeHint`, `now`. `hideOthers` now reads "Hide
  non-matching". The old `promptChart.timeline` localStorage key is not read.

Step 2
- Selection state stays in `PromptChart` (`selected`); the inspector's editor is
  `editId` (a double click on a card sets it with the selection, the inspector's
  Edit button sets it too) and `focusToken` (Enter/Space on a card bumps it, the
  inspector focuses its heading). `closeInspector` returns focus to the card's
  node. Escape order: link mode, multi-selection, selection (the handler still
  ignores keys inside fields, dialogs and `.context-menu`, and anything
  `defaultPrevented`, so an open popover swallows its own Escape).
- `PromptInspector` is keyed by the selected card id, so its edit buffer resets
  on a new selection. It shows the session view (a list of the session's
  prompts with Collect again / Delete per row) when the selected sent card's
  session has more than one prompt in `timeCards`, whether or not the session
  card is what was clicked.
- `PromptAgentPick.tsx` is the agent picker both the card face and the
  inspector use. `PromptCardTarget` moved there (re-exported from `PromptCard`).
- `PromptCard`'s prop list shrank to what the face needs: gone are `onSave`,
  `onSend`, `onSchedule`, `onUnschedule`, `onCollect`, `onRetime`, `onQueueMove`,
  `onUnlink`, `onEditLink`, `links` (re-added in step 3 for the chip),
  `linkLabel`, `onGoToTab`, `retimeEarlierDisabled`. New: `onOpen`, `onEdit`.
  `PromptSessionCard` lost `onCollect`, `onDelete`, `onGoToTab`.
- The inspector's +-5 min buttons read "-5" / "+5" with `aria-label` "5 min
  earlier" / "5 min later" (the existing keys). Tests find them by role.
- `stateFact` is exported from `PromptCard` (the inspector prints it as the When
  text). `AgentScheduleProposal` (Approve / Reject for agent-authored rules)
  stayed on the card face **and** shows in the inspector.
- Untested register: `promptChart.heading` row text now describes the shell,
  new rows `promptChart.inspector` and `promptChart.options`. The register test
  wants a row per pill, so rows for your composer, sequences, usage band and
  outcome chips are yours (step 10).

Step 3
- State chip: `lib/agents/prompt/stateChip.ts` `promptStateChip(card, links)`
  returns `{ key, params?, tone }`; chip class `.agent-prompt-chip.is-<tone>`.
  A chained card reads "After step n" with n = `chainDepth` (predecessors along
  `after` edges, at least 1). Your `sequences.ts` can replace `chainDepth`.
- Card face rows: `.agent-prompt-card-top` (time + chip), the message, an
  optional `.agent-prompt-card-fact`, `PromptAgentPick` (dot, tab or picker,
  model from the `model:` tag), two stored tags then `+n`. Auto tags are only in
  the inspector. The lamp is gone from cards (kept for the month's day cells).
- The time row prints the **date only in Week and Month** (`showDate` prop);
  Day and Hour leave it to the range label. Session cards print the dates when
  the span crosses midnight, as before.
- **The sent card's fact line is already built**: `lib/agents/prompt/cardFacts.ts`
  `sentFactLine(cards, t)` = "6 min . 4 files . 2 prompts" (duration from
  `files_at - sent_at`, file count over the session, prompt count). That is the
  plan's step-7 sentence; step 7 should extend it (Running, Needs answer, Cut
  off, Finished, the "Missed"/"Failed" reasons) rather than redo it. New keys:
  `durationMin`, `durationHourMin`, `filesOne`, `filesMany`, `noTime`.
- `packLanes(items, win, width, now, cardWidth?, gap?)` takes `now` as the 4th
  argument. `LaneItem` gained `anchor` ("left" for future, "right" for past) and
  `barWidth` (px, at least 4; a past card's bar is `files_at - sent_at` wide,
  capped at the card width; a future card just gets the 4 px corner).
  `promptEndedAt(card)` (exported from `timeline.ts`) is the one place that
  reads `files_at`. A card whose end is after `now` (clock skew) is treated as
  future. `renderCard` gained a 5th argument `{ anchor, width }` that the cards
  draw as `.agent-prompt-card-bar`.
- `TIMELINE_LANE_HEIGHT` 120 -> 140 (the face got a row). The 3 px stripe is
  gone from `.agent-prompt-card`; `--prompt-strand` now only colours the dot and
  the bar.

Step 4
- `TimelineWindow.fold?: { start, end, px }`; `timelineX`/`timelineTimeAt` are
  piecewise when it is set; `dayFold(win, instants)` decides it. `PromptChart`
  keeps `baseWin` (what `timelineWindow` returns, used for the usage query) and
  `win` (the same with the fold, used by the axis, the drag hook, drops and the
  badge). The instants that keep the night open: `now`, every timeline item's
  start and end (`promptEndedAt`), every reset mark. Queued cards sit at `now`,
  so they are covered by it.
- The axis markup changed: `.agent-prompt-timeline-axis` now holds
  `.agent-prompt-timeline-axis-marks` (aria-hidden: ticks, reset labels, the
  Now pill) and, when folded, the `button.agent-prompt-timeline-fold`
  (`data-testid="prompt-timeline-fold"`). The axis is 28 px tall. The reset
  labels are **still in the axis marks** (they were not moved: that is step 9).
- Opening a day is `unfolded: Set<anchor>` in `PromptChart` state.
- **Test helper gotcha**: with an empty night the fold is on in most fixtures,
  which changes every x <-> time mapping. `layout()` in `PromptChart.test.tsx`
  and `PromptChartSelect.test.tsx` clicks the fold open first. A new gesture test
  that lays out a "plain 1000 px day" must do the same, or compute on the folded
  scale (40 px + 960 px over 18 h).

Step 5
- Help rows are gesture/effect pairs from the mock (`promptChart.help.*`, five
  dictionaries). `{modifier}` is `modifierLabel()`.

## Tests

- Rewritten against the new structure (intent kept): the `PromptChart.test.tsx`
  tests that expanded a card (now read the inspector through a local
  `inspector()` helper), the filter / hide / count tests (one filter), the
  timeline-hidden test (now drafts collapse), the edit-near-the-edge test (now
  "nothing grows inside the timeline"), `PromptCardKeyboard`,
  `PromptSessionCard`, the two `AgentSchedulesView` filter/hide tests, the
  `PromptChartLift` height check (reads the sizer), two `packLanes` tests.
- Added: `AgentPromptStateChip.test.ts`, an "anchoring" block and a "folded
  night" block in `AgentPromptTimeline.test.ts` (round trip across the fold,
  snapping inside it, ticks, `dayFold` conditions), and in `PromptChart.test.tsx`
  inspector, face, axis and popover describes.
- `AgentPromptTimelineDst.test.ts` is unchanged and green.

## Gates

- `scripts/gates-job.sh start --base develop` (the whole A range): brand PASS,
  whitespace PASS, lint PASS (0 errors, the repo's existing warnings only; I ran
  eslint on every file I touched and it is clean), build PASS, vitest
  `--changed develop` PASS (215 s). No Rust changed, so no cargo gate ran.
- Per-step I ran `tsc` (TS 7), eslint on the touched files and
  `vitest run src/__tests__/agents src/__tests__/theme src/__tests__/shell`:
  259 files, 2299 tests green at the last commit (that directory set holds
  `FloatingRecipe`, `TypeScale`, `ChromeGlyphs`, `DialogShellRatchet` and the
  untested-registry test).
- Step 1's full `--changed` run once timed out `tex/BibCards.test.tsx > mounts
  only a window of a long list` (20 s, under the load of ~930 files); it passes
  alone and in the last full run.
- Commits 2-4 were checked by the manual set above, not by a separate gate job
  each (an i18n edit pulls ~930 test files into `--changed`, about 9 minutes).

## Flagged for user

- **Nothing was run live.** What I could not see: the container-query stacking
  below 900 px, the scrolling timeline body (`height: 100%` + sizer), the
  `Dropdown` menus opening inside the Options popover, the chip / bar / pill
  colours in the user's themes, the fold block's look. The click-through at the
  end of the plan covers them; add "open the Options popover and pick a model"
  and "fold: click the 00-06 block" to it.
- **Fold vs hanging cards.** A past card hangs left of its end, so a card ending
  at 06:30 draws over the folded block. The fold only checks instants, not card
  extents. Harmless (the card is clamped at x >= 0) but it can cover the block's
  "00-06" label. Fix if it bothers: also count `item.at - cardWidthInTime` as
  occupying the night.
- **Day-view cards no longer print their date**, even when the day shown is not
  today (Week and Month do). The range label carries it. Easy to flip with
  `showDate`.
- **Hiding the timeline is gone** as planned; the timeline can no longer be
  made to give its room to the drafts (only the drafts column collapses). If
  that mattered to the user, say so.
- **Collapsed drafts draw no links to chained cards** (the board is unmounted,
  so `cardNodes` has no entry for them).
- The stacked layout (< 900 px) puts the inspector after the timeline, below the
  fold of the tab; selecting a card there scrolls nothing into view.
- `.agent-prompt-chart-select-hint` and `.agent-prompt-lamp.is-*` rules are
  still in `projects-tabs.css` (the lamp is the month's). The select-hint rule is
  dead; I left it for the wrap-up sweep.
- Decisions-made-while-planning I implemented as written, no objection: one
  filter, no Hide timeline, options popover, `files_at - sent_at` as duration,
  face buttons in the inspector. The one I would watch: **"When applies to the
  timeline only"** means a draft is never dimmed by Today / Upcoming, which can
  read as "the filter ignored my drafts".
- The plan's step-5 text said the hints "are removed from the layout"; they are,
  and a test pins it, but a reader who never opens "?" will not learn
  Shift+drag or Ctrl+wheel. That is the trade the user chose.

## Click-through for the user (additions to the plan's list)

Day view with an empty night: the `00-06` block at the left of the axis; click
it, the day opens; go to the next day, it folds again. Select a card: the
inspector appears; Esc closes it; Enter on a focused card moves focus into it.
Open Filters, Options and `?`: each drops under its button and Esc closes it.
Drag the right edge of the Drafts column; collapse it and reload the window.

---

# Implementer B (steps 6-10)

Branch `prompt-chart-redesign-b` (worktree `.claude/worktrees/agent-adaa2e87be644ad8d`),
on top of A's `e77f8270c`. Nothing was run live; every claim is from tests,
`tsc`, lint, cargo and reading the CSS.

| Step | Commit | State |
| --- | --- | --- |
| A's flagged defects (fold vs hanging cards, stacked inspector) | `ee3caef90` | done |
| 6. Quick composer | `659b895d5` | done |
| 7. Outcome on past cards | `d0ee512fd` | done, no "Cut off" |
| 8. Sequences + `PromptLink.paused` | `d908b9c82` | done |
| 9. Limit-aware scheduling | `b466b51e5` | done |
| 10. Wrap-up (file maps, todo, dead style and keys) | `da458cfaa` | done |

## Defects from A's range

- **Fold vs hanging cards:** `packLanes` now stops a card at the folded block's
  edge (`x >= fold.px`) instead of 0. Test in `AgentPromptTimeline.test.ts`.
- **Stacked inspector:** selecting a card (or a sequence) below 900 px of the
  chart's width scrolls `.agent-prompt-inspector` into view, `block: "nearest"`
  (`PROMPT_CHART_STACK_WIDTH`, test `PromptChartLayout.test.tsx`).
- A's other gotchas were notes; none turned out to be a bug.

## Where the plan was silent

Step 6
- The composer's text goes through the draft first, always (`submitCompose`).
  The draft's own write failing keeps the text; anything after it reports in the
  banner and clears the field (the draft exists, resubmitting would duplicate).
- Its tab picker offers the free tabs (a draft's options) and the new tab. A
  reset choice is offered only when the chosen tab's agent has that mark ahead;
  a stale pick falls back to "Keep as draft".
- `usePromptChartUsage` now returns `{ marks, upcoming }`: `upcoming` is every
  agent's resets from now to +8 days regardless of the axis window or the agent
  facet. The composer and the limit warning read it; the band and snapping read
  the window's `marks`.
- "After another prompt..." arms `afterFor` (the draft id); the next card clicked
  becomes the edge's **source** (the draft is the target). Esc / Cancel leave the
  draft unlinked. The command bar chip reads "Pick the prompt it follows".
- The Lands here preview is drawn in the timeline's overlay at the top lane, over
  whatever card sits there (pointer-events none).
- `DraftBoardHandle.compose` and `promptChart.newDraft` are gone (the button was
  the only caller); a double click on the board still opens its own composer.

Step 7
- Live states come from `useActivityStore.statusTabsByScope`: the newest
  delivered row of each live tab, with no `files_at`, while the tab is `working`
  (Running) or `needs-decision` (Needs answer). Shell-only busy tabs are ignored.
- `packLanes(..., running)`: a running card ends at `now` (its bar is `now -
  sent_at`, capped at the card width) and grows with the chart's 30 s tick.
- Chips: Finished is a delivered row with `files_at`; a delivered row without it
  stays "Delivered". Missed / Failed facts say what happened ("Nothing was sent at
  its minute", "Could not be delivered to the tab"); a session card adds its
  prompt count. The inspector has a Result row.
- **Cut off was left out.** `limitHandoff.ts` reads a limit notice off a live
  screen only; nothing per turn records that a turn ended on a usage limit, and
  the plan forbids a new detector.
- The `paused?: boolean` field on the TS `PromptLink` and the store's payload
  trimming landed in this commit (step 8 needed them first by the chip).

Step 8
- A sequence is a plain chain only (every node one in, one out, no loop). Joins,
  forks and loops are left out; `roll:` edges are not sequences.
- Statuses: sent+delivered is `done` (or `running` when live), missed/failed
  `stopped`, an edge with `paused` is `paused`, `chainStopped` is `stopped`; the
  first open step after a done one is `next`, later ones `waiting`.
- Only a chained member can be skipped / stopped / paused ("the next pending
  member" = first chained, not-yet-sent step). Pause toggles to Resume while any
  step is paused. Skip keeps a pause (the new edge inherits it) and carries the
  removed out-edge's tab and commands. The edge writes of a Skip are sequential;
  a failure in the middle leaves the chain cut and the banner says why.
- Resume sends the held step through `sendCollectedPrompt` only when its
  predecessor is a sent row with `files_at` and not live; a running predecessor
  needs nothing (the host reacts when it ends).
- A sequence is selected from its Drafts header; the inspector then shows the
  sequence instead of a card. Picking a step selects that card. A sequence with
  every step done is not drawn in Drafts (it is history; its cards say step n of m).
- The mock's "a step that ends on a question, is cut off or fails pauses the
  sequence" is not claimed: the inspector's note says what the host does (a
  failed or missed step stops the chain, a step waiting on an answer holds the
  next back until its turn ends).
- Host test: there is no positive after-link host test to extend (the existing
  ones are negatives), so pause is pinned at `nextAfter` (the host's only reader)
  plus the chart's Resume test; no new host-level test.

Step 9
- Band row per agent with a mark in view: session bar `reset - 5 h` (cut at the
  view start) to the reset, tone by percent (below 70, 70-89, 90+), the text
  always carries the number; a "new window from" note after it; weekly resets as
  ticks. A 90 %+ window also shades the lanes from now to the reset.
- The agent is named by the "+" menu's label ("Claude"), else its command.
- `snapToReset` runs in the drag hook's zone computation (time zones carry
  `reset`); only marks in view and of the card's agent; the agent is the card's
  `agent:` tag, so an unaimed draft uses the chart's new-tab agent.
- The warning is raised for scheduled cards (the next occurrence of a recurring
  one); Move after reset is offered on face and inspector, not for a recurring
  rule. The mock's "Claude is nearly out until 14:20" stretch label is not drawn
  (the shade and the card's own warning carry it).

Step 10
- Untested rows: `promptChart.composer`, `.outcome`, `.sequences`, `.usageBand`.
- Dead: `.agent-prompt-chart-select-hint`, the axis `.agent-prompt-timeline-reset-label`
  rules, i18n `promptChart.newDraft` and `promptChart.reset.session|week`. A sweep of
  every `.agent-prompt-*` class against the sources found nothing else unused.
- File maps: the frontend row now lists all the chart files (A had not updated it).

## Backend

`PromptLink.paused` (`skip_serializing_if = Not::not`) and `PromptLinkInput.paused`
(`#[serde(default)]`); `validate_link` keeps it on `after` edges only. The store
sends `paused` only when true and omits `preface` when empty, so an older backend
(which denies unknown fields) accepts an ordinary link. An upsert replaces the
edge, so re-saving without the key resumes it. The shape is not mirrored strictly
anywhere else (`core_dispatch`, `mobile-web`, `src/lib/transport` hold no link
shape). No new Tauri command. Cargo tests:
`a_paused_flag_is_kept_on_an_after_edge_only_and_round_trips`,
`a_link_file_written_before_the_flag_loads_unpaused`,
`re_saving_an_edge_without_the_flag_resumes_it`.

`npm run backend:stale` (run after the Rust change), abridged:

```
EMBEDDED MOBILE PWA IS STALE - the sidecar on 127.0.0.1:8742 is serving a
  different bundle than the one built in mobile-dist/. The phone is on the old one.
THE OPEN WINDOW PREDATES THE CURRENT BUILD - the sidecar is serving a bundle
  built before the one in mobile-dist/, so the window's compiled-in frontend is
  behind your tree as well. It is not only the phone that is on the old code.
```

Meaning: the running window needs the new build, and the paused flag needs a
backend restart to be stored.

## Gates

Full range `scripts/gates-job.sh start --base develop` at `da458cfaa`: brand PASS,
whitespace PASS, lint PASS (0 errors, 30 warnings, none in the chart files),
clippy x3 PASS, `npm run build` PASS, vitest PASS (941 files, 9509 tests), cargo
`test -p tabtivity -p app-serverd`: 6272 passed, 2 failed:
`terminal::pty_child::tests::signals_and_open_files_match_the_portable_pty_spawn`
(`left: "SigBlk:0000000000000000,SigIgn:0000000000000007,"`, `right: "...SigIgn:0000000000000000,"`)
and `terminal::pty_child::tests::ctrl_c_on_the_master_interrupts_the_foreground_program`.
Both failed in the step-6 gate run too and pass alone in a foreground shell
(`cargo test -p tabtivity --lib terminal::pty_child`: 7 passed): the gate job's
shell ignores SIGINT/QUIT/ILL and the tests inherit that. Unrelated to this change.
Because of that failure the job skipped `test-dlib`; run by hand:
`cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
6086 passed, 16 ignored. Per step: `tsc`, eslint on the touched dirs and
`vitest run src/__tests__/agents src/__tests__/theme src/__tests__/shell`
(2365 tests at step 9).

## Flagged for user (added)

- **Nothing was run live.** Unseen: the composer row's wrapping, the When menu,
  the band's bars and tones in the user's themes, the sequence group / outline on
  the Free canvas (its heading sits under the cards), the dashed Lands here card
  (it can cover a card on the top lane), the Running / Needs answer chips.
- **Cut off has no state.** If wanted, a per-turn signal has to be recorded first
  (e.g. the schedule host stamping a limit notice it sees on the screen when a
  turn ends); then `promptOutcome` gains the word.
- **A paused edge needs a backend restart** to be stored at all; before that the
  Pause button fails with the backend's unknown-field refusal in the banner.
- **Sequences with a fork are not shown** as sequences (no group, no step n of m),
  though the draft runtime still sends both branches; the backend allows forks.
- **A finished sequence is listed nowhere** except through its cards' "step n of
  m"; Drafts lists only sequences with a draft member.
- **Resume timing:** it sends at once if the predecessor has `files_at`; the
  host's 5-minute idle wait is skipped on that path (the scheduler's idle gate
  still applies).
- **Delivered vs Finished:** a row typed in the terminal and adopted has no
  `files_at` and so never reads Finished.

## Click-through for the user (additions)

1. Composer: type a prompt, Enter (draft). Pick a tab and try Send now, At a
   time... (the schedule dialog opens with the text), After another prompt...
   (the bar asks "Pick the prompt it follows"; click a card; Esc instead leaves
   the draft), and, if Claude's usage panel is read, After the 5h reset (dashed
   Lands here card, the rule lands on the first 5-minute mark after the reset).
2. Sequence: link three drafts After one another (a `/clear` on one edge), send
   the first. Drafts shows Sequence - 3 steps; click its heading: progress, one
   line per step, the `/clear` row with Edit. Pause (the next card says Paused;
   when step 1 ends nothing is sent), Resume (it goes out), Skip next step (its
   neighbours are linked, it is a loose draft again), Stop (the edge goes, the
   rest stays linked).
3. Drag a draft to within a few pixels of a reset in the usage band: the badge
   reads "Schedule on <tab> - after the 5h reset", the rule lands just after it.
4. With the 5h window at 90 % or more, a scheduled card due before the reset
   warns "May hit the limit"; Move after reset retimes it; a daily rule has no button.
5. A running turn: its card says Running with "n min so far", the bar on top
   reaches the Now line and grows; a tab asking a question reads Needs answer.
6. Narrow the split below 900 px and select a card: the inspector scrolls into view.

---

# Final review (steps 1-10, reviewer C)

Branch `prompt-chart-redesign-final` (from `prompt-chart-redesign-b` at `890c70cb7`). Range
`4cf65018d..HEAD`; `develop` has moved on to `2d88a8224` and was neither merged nor
rebased. Nothing was run live. No Rust changed in the review, so no `backend:stale`.

## Fixed (each with a test that fails before)

| Commit | Bug | Test |
| --- | --- | --- |
| `5034425f0` | Resume cleared `paused` first, then looked the tab up and sent. A closed tab, or a failed send, left the step unheld and unsent with nothing to trigger it (its predecessor had already finished). Now the tab is resolved and the step sent first; the flag is cleared after. | `PromptChartSequence.test.tsx`: Resume onto a closed tab, Resume whose send fails |
| `4c7ce465b` | "After another prompt..." leaves the focus in the composer field, and the chart's Escape handler ignores keys in fields, so the documented Escape did nothing. Inside the composer Escape now ends an armed pick, and only that. | `PromptChartComposer.test.tsx` (two tests) |
| `bda4b7ec4` | The inspector focused its heading on every mount once `focusToken > 0`, and the token never reset, so after one Enter every mouse selection stole the focus. The token is handed over only for the card the keyboard opened. | new `PromptChartFocus.test.tsx` |
| `5724213e8` | The chart is a size container (`container-type: inline-size`, layout containment), which makes it the containing block of `position: fixed` children. The carry ghost and the marquee are fixed and placed in client coordinates, so they would draw offset by the chart's origin. Both are portaled to the body. Not measured in WebKitGTK (no display reachable from the review sandbox); the portal is right whatever the engine does. | `PromptChartSelect.test.tsx` (parent is `document.body`) |
| `da16b8660` | Dead `.agent-prompt-session-row-head .agent-prompt-lamp` rule. | none (CSS) |

## Flagged for user

- **Container query vs. engine:** please confirm in the window that the carry ghost
  follows the pointer and the stacked layout switches below 900 px.
- **Skip next step when the predecessor already finished** (a stalled chain, e.g. a
  closed tab): the new edge predecessor -> successor is written, but the host only
  reacts to a turn ending, so nothing sends it. Resume handles this case
  (`resumeSendsAtOnce`); Skip does not. `PromptChart.tsx` `skipStep`.
- **Resume relies on `files_at`:** if the predecessor was never stamped (blame
  failed, adopted row), Resume clears the pause and sends nothing.
  `sequences.ts` `resumeSendsAtOnce`.
- **Running on a stale row:** `livePromptStates` marks the newest delivered row with
  no `files_at` as Running while the tab works; a terminal-typed prompt not yet
  adopted makes an older never-stamped row read Running. `outcome.ts`.
- **Inspector editor buffer:** `PromptInspector.tsx` resets the text on any
  `card.message` change, so an edit arriving from elsewhere (phone, agent) while the
  editor is open overwrites what was typed.
- **Skip is three sequential link writes** (two deletes, one upsert); a failure in
  the middle leaves the chain cut (the banner says why). The backend's join check
  forbids a safer order.
- **`terminal::pty_child` (outside this range):** the new spawn path does not reset
  inherited SIGINT/SIGQUIT/SIGHUP dispositions the way `portable-pty` did. A product
  launched with those ignored (nohup, a background job) hands the ignore to every
  agent terminal, so Ctrl-C would not interrupt there. See below.

## The two `pty_child` failures

Not caused by this branch: the range changes only `schema/agent_prompts.rs` and
`services/agent/agent_prompts.rs` under `src-tauri`; nothing in `terminal/`.

- Foreground (`cargo test -p tabtivity --lib terminal::pty_child`, shell with
  `SigIgn:4`): 7 passed. With `-- --test-threads=6`: 7 passed.
- Under the gate job's launch (`nohup setsid bash -c ... &`, `SigIgn:0000000000000007`)
  both fail identically on this branch and on a `develop` worktree
  (`2d88a8224`), same command:
  `left: "SigBlk:0000000000000000,SigIgn:0000000000000007,"` vs
  `right: "...SigIgn:0000000000000000,"` and `ctrl_c_on_the_master_interrupts_the_foreground_program`:
  `the child did not exit; output "ready\r\n"`.
- Cause: a backgrounded non-interactive shell ignores SIGINT/SIGQUIT and `nohup`
  ignores SIGHUP; the test process inherits that and `pty_child`'s spawn passes it to
  the child, where the `portable-pty` path reset it. The tests were not edited.

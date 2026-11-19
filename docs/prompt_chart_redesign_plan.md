# Prompt chart redesign plan

Status: plan, implementation in progress (2026-11-19). Handoff:
`docs/prompt_chart_redesign_handoff.md`.

## Why

The prompt chart (#262, `components/agents/PromptChart.tsx`) works but reads
badly:

- The timeline is only as tall as its lanes, so most of the tab is empty.
- A sent card is 168 px wide whatever its turn took, so a six-minute session
  appears to run for hours and crosses the now line.
- Five hint sentences are on screen at all times.
- Drafts and timeline each have their own search, facets and "Hide others".
- The sticky defaults (link kind, new-tab agent and model) sit in the top row
  like primary actions.
- The reset marks share the axis with the hour labels and collide with them.

The user chose the direction on a design canvas (2026-11-19). The mock's
source is in `tmp/prompt_chart_mock/*.dc.html` in the main checkout (untracked,
**never commit it**: it quotes the user's own prompts). Read it for layout,
spacing and wording. Its colours are the `light_lavender` theme resolved to
hex; in code use the theme variables (table below), never the hex values.

| Mock | Variable |
| --- | --- |
| `#faf9fe` / `#f2effa` / `#ffffff` | `--bg-main` / `--bg-panel` / `--bg-elevated` |
| `#d2cae8` / `#e6e1f3` | `--border-color` / `--border-subtle` |
| `#2e2a3d` / `#565072` / `#6b6486` | `--text-primary` / `--text-secondary` / `--text-muted` |
| `#6f4fd3`, its tints | `--accent`, `--accent-soft`, `color-mix` on `--accent` |
| green / amber / red / teal chips | `--success` / `--warning` / `--danger` / `--info`, tints by `color-mix` |

## Fixed decisions

The user's, or made with them. Reviewers do not undo these.

1. **Layout:** one command bar, a composer row, then three columns: Drafts on
   the left (collapsible, resizable), the timeline filling the rest, an
   inspector on the right that exists only while something is selected.
2. **Free placement stays.** No lanes or rows per agent tab (rejected twice,
   2026-09-10 and 2026-11-19). Lane packing, Shift+drag lifts and the marquee
   keep working. The agent is a chip on the card.
3. **Chained cards never take a place on the time axis** (2026-09-15). A
   sequence's sent and scheduled members stay on the timeline; its chained
   members stay in Drafts.
4. **The agent picker stays on the card face** for draft, scheduled, queued and
   chained cards (2026-09-10). The inspector repeats it.
5. **Features in:** inspector, quick composer, sequences as objects,
   limit-aware scheduling, outcome on past cards, help popover.
   **Out:** activity minimap, new keyboard shortcuts.
6. **Card anchoring:** a card in the past ends at its right edge and hangs
   left; a card in the future starts at its left edge and hangs right. Nothing
   crosses the now line.
7. **Sequences are unnamed.** A sequence is an `after` chain of two or more
   prompts, shown as "Sequence · N steps". No new stored name.
8. **The phone is untouched.**
9. Everything new is tagged untested (`src/lib/untested.ts` + `UntestedTag`).
   Nothing here is run live by an agent.

## Decisions made while planning

Open to a reviewer's objection, recorded in the handoff rather than changed.

- **One filter for both parts.** `draftFilter`/`chartFilter` and the two hide
  switches become one `filter` and one `hide`. The "When" facet applies to the
  timeline only.
- **"Hide timeline" goes away.** The Drafts column collapses instead
  (`storageKey("promptChart.drafts")`, value `collapsed`; width in
  `storageKey("promptChart.draftsWidth")`). The old `promptChart.timeline` key
  is no longer read.
- **Link kind and new-tab defaults** move into an options popover (gear button
  in the command bar). New links default to After, as today.
- **Outcome needs no new storage for duration.** `apply_blame` stamps
  `files_at` at the moment the schedule host saw the tab idle again, in a git
  repository or not. Duration is `files_at − sent_at`. A row never blamed
  (typed in the terminal and adopted) shows no duration.
- **Running and Needs answer are live states**, read from
  `useActivityStore` for the newest delivered row of a live tab. They are not
  stored and `buildPromptChart` stays a pure join of the persisted sources.
- **Cut off** is shown only if an existing per-tab signal says the turn ended
  on a usage limit (look in `lib/agents/limitHandoff.ts`, `agentTabStop.ts`,
  auto-continue). No new detector. If there is no usable signal, leave the
  state out and list it under "Flagged for user".
- **Face buttons from the mock (Continue, Go to tab, Collect again) live in the
  inspector**, not on the card face.
- **Pause is a stored flag on the edge** (`PromptLink.paused`), the one backend
  change. Skip and Stop are link writes only.
- **Night fold:** Day view only, the leading 00:00–06:00 stretch, only while
  nothing lies in it.

## Steps

One commit per step, each green on the gates its diff touches
(`scripts/gates-job.sh start`, then `status`). All user-facing text goes
through `src/lib/i18n` with the key in all five dictionaries (`en`, `de`,
`es`, `fr`, `it`). Menus and popovers use the shared frames (the `add-menu`
skill). No new lint warnings, no `any`.

### 1. Shell: command bar, three columns, timeline fills the tab

Files: `components/agents/PromptChart.tsx`, new
`components/agents/PromptChartCommandBar.tsx`,
`components/agents/PromptChartFilterBar.tsx`,
`components/agents/PromptDraftBoard.tsx`, `styles/projects-tabs.css`.

- Command bar, in order: heading with its `UntestedTag`, one search field, a
  Filters popover (agent, outcome, when, tag chips, "Hide non-matching", clear,
  `shown of total`), the view switch, earlier / Today / later, the range
  label, the selection count or "Reset positions" when they apply, the options
  button, the help button. While a link is armed, its "Pick the other card ·
  Cancel" chip shows here.
- Replace the two filter states with one. `matches()` and `visible()` ask the
  same match set for strip and timeline cards; `promptChartInWindow` is asked
  only of timeline cards. `usePromptChartUsage` takes the one filter's agent.
- Body is a three-column grid. Drafts: header (name, count, List | Free switch,
  collapse) and the board. `PromptDraftBoard` loses its own layout bar and
  hint lines and exposes `setFree`. A drag handle on the column's right edge
  sets its width (240–720 px, persisted). `stripRef` stays the drop zone.
- The timeline's body gets `min-height` from the available space instead of a
  fixed height: lanes below the cards are empty lanes. Scrolling stays inside
  the body; the axis stays sticky.
- Below 900 px of container width the columns stack: Drafts, timeline,
  inspector (container query, not a media query: the tab can sit in a split).
- Remove the header's ＋ (the composer replaces it in step 6; until then the
  Drafts header carries a "New draft" button calling `draftBoard.compose()`).

### 2. Inspector replaces expand-in-place

Files: new `components/agents/PromptInspector.tsx`,
`components/agents/PromptCard.tsx`, `components/agents/PromptSessionCard.tsx`,
`components/agents/PromptChart.tsx`, `components/agents/PromptTimeline.tsx`,
`styles/projects-tabs.css`.

- A click or Enter/Space selects a card and no longer toggles a body inside
  it. `selected` drives the inspector. Escape backs out in order: link mode,
  multi-selection, selection. Enter moves focus to the inspector's heading;
  closing it returns focus to the card.
- Inspector content, moved out of `PromptCard`'s expanded block: state chip,
  the prompt (read view; Edit opens `MarkdownPromptField` and the tags field;
  a double click on a card opens the inspector already editing), the When row
  (± 5 min for a one-time rule, ↑ ↓ for a queued one, "Edit rule…" for a
  recurring one), the agent picker, tags (stored and auto), session id copy,
  changed files, links with Edit and Remove, and the actions (Send, Schedule,
  Collect again, Unschedule, Go to tab, Link, Delete).
- A session card's inspector lists the session's prompts, as its expanded body
  did.
- Delete `TIMELINE_EDIT_WIDTH`, `is-editing`, `is-edit-flip` and
  `--edit-shift`: nothing grows inside the timeline any more.

### 3. Card face and anchoring

Files: `components/agents/PromptCard.tsx`,
`components/agents/PromptSessionCard.tsx`, `lib/agents/prompt/timeline.ts`
(`packLanes`), `components/agents/PromptTimeline.tsx`,
`styles/projects-tabs.css`.

- Face rows: time and state chip; the message (three-line clamp); for a sent
  card a fact line (step 7 fills in the outcome; here: result and file count);
  the agent row (dot in `promptTargetColor`, tab label, model from the
  `model:` auto tag, or the picker per decision 4). Stored tags stay on the
  face (two, then "+n"); auto tags move to the inspector.
- State chips carry a word, not only a colour: Draft, Scheduled, Queued,
  After step n, Delivered, Missed, Failed. The `.agent-prompt-lamp` dot leaves
  the cards and stays for the Month view's lamps.
- The 3 px left stripe goes. A duration bar sits on the card's top edge at its
  anchored corner, in the tab's colour: `files_at − sent_at` wide on the axis
  (a session card: first prompt to last finish), at least 4 px.
- `packLanes(items, win, width, now)`: an item whose newest instant is at or
  before `now` is placed with its right edge at the x of its end (the newest
  member's `files_at`, else its `at`), clamped to `x ≥ 0`; a future item as
  today, clamped so the card stays inside the body. Pack on the resulting
  intervals, not on start positions alone. `LaneItem` gains `anchor` and
  `barWidth`. Session tick offsets are measured from the new left edge.
- Tests: `AgentPromptTimeline.test.ts` (anchoring, clamps, packing on
  intervals), `PromptSessionCard.test.tsx` (offsets), `PromptChartLift` and
  `PromptChartSelect` stay green.

### 4. Axis: Now pill and the folded night

Files: `lib/agents/prompt/timeline.ts`,
`components/agents/PromptTimeline.tsx`, `components/agents/PromptChart.tsx`.

- The now label becomes a pill "Now 10:13", kept inside the axis at both ends.
- `TimelineWindow` gains optional `fold: { start, end, px }`. In Day view the
  stretch 00:00–06:00 folds to 40 px when no timeline item, queued card, reset
  mark or `now` lies in it. `timelineX` and `timelineTimeAt` become piecewise
  when `fold` is set; every caller already goes through those two.
  `PromptChart` computes the fold (new pure `dayFold`) and passes the window
  on, so the drag hook and the axis agree. A click on the folded block unfolds
  that day (view state, not persisted).
- Tests: x ↔ time round trip across the fold, snapping inside it, ticks, and
  `AgentPromptTimelineDst.test.ts` unchanged.

### 5. Help and options popovers

Files: new `components/agents/PromptChartHelp.tsx`,
`components/agents/PromptChartOptions.tsx`, `lib/i18n/*`.

- Help ("?"): the gestures now printed inline (`dropHint`, `draftLayoutHint`,
  `draftCreateHint`, `completionHint`, `selectHint`, `zoomHint`), grouped as
  in `tmp/prompt_chart_mock/Help.dc.html`. Remove them from the layout.
- Options (gear): new links After / Related (`linkKind`), new agent tab's
  agent and model (the two `Dropdown`s that write `prompt_chart_agent` and
  `prompt_chart_model`).

### 6. Quick composer

Files: new `components/agents/PromptComposer.tsx`, new
`lib/agents/prompt/compose.ts` (pure), `components/agents/PromptChart.tsx`.

- A row under the command bar: a growing text field (Enter submits,
  Shift+Enter adds a line), the target picker (a draft's options: new agent
  tab first, then the free tabs), the When menu, the submit button whose label
  follows the choice (Add / Send / Schedule).
- When menu and what each writes, through the chart's existing writes only:
  - Keep as draft: `upsertPrompt` with `target`.
  - Send now: the draft, then the `pickTab(card, "send")` path.
  - At a time…: the draft, then `AgentScheduleDialog` on the tab (a new tab is
    opened first, as `pickTab` does).
  - After another prompt…: the draft, then a pick mode; the next card clicked
    becomes the source of an `after` link to the draft. Escape leaves the
    draft unlinked.
  - After the 5h reset / After the weekly reset: offered when step 9's marks
    exist for the target's agent; a one-time rule at the first snap minute
    after the reset. A tab that already holds a rule is refused with the
    existing occupied sentence.
- A dashed "Lands here" preview on the timeline while a reset option is
  chosen and the field holds text.
- The Drafts header's temporary "New draft" button from step 1 goes; a double
  click on the free canvas still opens the board's own composer.

### 7. Outcome on past cards

Files: `components/agents/PromptCard.tsx`,
`components/agents/PromptSessionCard.tsx`,
`components/agents/PromptInspector.tsx`, new
`components/agents/usePromptLiveState.ts`, new
`lib/agents/prompt/outcome.ts` (pure).

- `promptOutcome(card, live)`: `running`, `needsAnswer`, `cutOff` (see the
  planning decision), `finished` (delivered with `files_at`), `delivered`,
  `missed`, `failed`; plus `durationMs` and the file count.
- Fact line: "6 min · 4 files · 2 prompts". Chips: Running, Needs answer,
  Finished, Cut off, Delivered, Missed, Failed.
- Running: the duration bar grows with `now` (the chart's 30 s tick; no
  animation loop).
- Tests: `outcome.ts` unit tests; a `PromptChart` test per chip.

### 8. Sequences

Files: new `lib/agents/prompt/sequences.ts`, new
`components/agents/PromptSequenceGroup.tsx`,
`components/agents/PromptInspector.tsx`,
`components/agents/PromptDraftBoard.tsx`, `lib/agents/prompt/links.ts`,
`components/layout/AgentScheduleHost.tsx`, `stores/agents/agentPrompts.ts`,
`src-tauri/src/schema/agent_prompts.rs`,
`src-tauri/src/services/agent/agent_prompts.rs`.

- `promptSequences(cards, links, live)`: every `after` chain of two or more
  members, in order, across history rows, rules and drafts (a recurring
  source's rows match `id` or `id@occurrence`, as `buildPromptChart` does).
  Per member a status: `done`, `running`, `next`, `waiting`, `paused`,
  `stopped` (`chainStopped`). Joins and cycles are left out, as in
  `draftSequence`.
- Drafts, List layout: a sequence is one group. Header: "Sequence · N steps",
  then "Starts 12:30", "step n of m" or Paused. Members on the timeline are
  one-line rows that select their timeline card; chained members are cards
  with a step number. Loose drafts follow. Free layout: the header and an
  outline drawn around the chain's draft cards.
- Timeline cards that belong to a sequence show "step n of m".
- Inspector, sequence view (click the header): progress segments, the step
  list with one state line each, the edge's commands with Edit (opens
  `PromptLinkEditor`), and Pause / Resume, Skip next step, Stop.
- Skip next step: remove the edges into and out of the next pending member and
  link its predecessor to its successor (the removed out-edge's `target` and
  `preface` carry over). The skipped card is a loose draft again.
- Stop: remove the edge into the next pending member. The rest stays linked.
- Pause: `paused: true` on the edge into the next pending member. `nextAfter`
  skips a paused edge, so `continueAfterDelivery` queues nothing. Resume
  clears it; if the source's row already has `files_at`, the successor is sent
  at once through `sendCollectedPrompt` with the edge's preface.
- Backend: `PromptLink.paused: bool`
  (`#[serde(default, skip_serializing_if = …)]`) and `PromptLinkInput.paused`
  (`#[serde(default)]`); the upsert keeps it on `after` edges only. The
  frontend sends `paused` only when true: `PromptLinkInput` denies unknown
  fields, so an older backend must still accept an ordinary link. Check the
  shape is not mirrored strictly elsewhere (`mobile-web/`, `core_dispatch`).
- Tests: `sequences.ts` (order, statuses, recurring source, excluded shapes),
  `AgentPromptLinks.test.ts` (paused edge yields nothing), a host test for
  pause then resume, cargo tests for the round trip of a file without the
  field and for `paused` dropped on a `related` edge.
- After the Rust change: `npm run backend:stale`, result into the handoff.

### 9. Limit-aware scheduling

Files: `lib/agents/agentUsageResets.ts`,
`components/agents/usePromptChartUsage.ts`,
`components/agents/PromptTimeline.tsx`, `lib/agents/prompt/timeline.ts`,
`components/agents/usePromptChartDrag.ts`,
`components/agents/PromptCard.tsx`, `components/agents/PromptInspector.tsx`.

- A usage band between the axis and the lanes, one row per agent with a mark
  in view. Session window: a bar from `reset − 5 h` (clamped to the view) to
  the reset, reading "{agent} · 5h window · {percent}% used"; three tones by
  percent (below 70, 70–89, 90 and up), the number always in the text. Weekly
  reset: a labelled tick in the same row. The reset labels leave the hour
  axis; the dashed lines in the underlay stay.
- Snap: while a card is carried, a snapped instant within 10 px of a reset
  mark of that card's agent becomes the first snap minute after the reset
  (pure `snapToReset`). The time zone carries `reset: kind` and the badge
  reads "Schedule on Claude · after the 5h reset · 14:20".
- Warning: a scheduled card on an agent whose session window is at 90 % or
  more, due between now and that reset, shows "May hit the limit" on its face
  and in the inspector, with "Move after reset" (a retime; not offered for a
  recurring rule). Pure `limitWarning(card, marks, now)`.
- Tests: `usageWindows`, `snapToReset`, `limitWarning`; a `PromptChart` test
  for the warning and for "Move after reset".

### 10. Wrap-up (with the last step's commit or its own)

- `src/lib/untested.ts`: rows for the inspector, composer, sequences, usage
  band and outcome; pills where each starts.
- `docs/filemap_frontend.md`: extend the prompt chart row with the new files
  (one line). `docs/filemap_backend.md` only if a row names the link schema.
- `todo/group-s-agents.md`, under #262: a "Rework (2026-11-19)" entry with the
  automated tests ticked and one manual box with the four platform pairs.
- `scripts/brand-check.sh` and `scripts/privacy-check.sh` pass.

## Organisation

Shape: **coupled chain, serial, one worktree.** Three subagents in total, one
at a time (the user's bound for this run is three). Every step edits
`PromptChart.tsx`, `PromptCard.tsx`, the one stylesheet and the dictionaries,
so parallel implementers would only produce conflicts.

The plan review that the routine gives to a subagent is done by the main
agent here, which read the chart's code to write this plan; that keeps the
third subagent for the final review.

| Agent | Plan steps | Main files |
| --- | --- | --- |
| A, implementer | 1–5 | `PromptChart.tsx`, `PromptCard.tsx`, `PromptTimeline.tsx`, `timeline.ts`, `projects-tabs.css`, new command bar, inspector, help, options |
| B, implementer | 6–10 | new composer, `outcome.ts`, `sequences.ts`, `AgentScheduleHost.tsx`, `links.ts`, `agentUsageResets.ts`, `usePromptChartDrag.ts`, the Rust link schema |
| C, final reviewer | whole range | bugs only, each with a regression test; design objections go to "Flagged for user" |

B continues in A's branch. An implementer that runs low on context stops at a
green commit and writes the handoff; the main agent finishes the remainder
itself rather than spawning a fourth agent.

## Verification

- Gates per step as above; before landing, `scripts/gates.sh` on the whole
  range in a clean worktree.
- Not run live by any agent. The handoff ends with click-through steps for the
  user: Day view with two agent tabs, drag a draft to a time and to Now, select
  a card and edit it in the inspector, compose with each When option, build a
  three-step sequence and pause, skip and stop it, drag onto a reset, and check
  the stacked layout in a narrow split.

# Steering inside popout windows — implementer's handoff

Plan: `docs/steering_popout_plan.md`. Worktree branch starts at `develop`
40f3918b2. Nothing here was run live (the app is never started by the
implementer); everything below is verified by tests and gates only.

## Step 1 — pure move to `hooks/useSteering.ts`

Commit: (see `git log`; message `refactor(steering): move steering mode into useSteering`)

- `src/hooks/useSteering.ts` holds everything from "Keyboard steering mode"
  through `steerKey`, the scroll-release subscription, the layer observer,
  `STATUS_ACTIONS`, `cycleProject` / `landOnStation` (exported; `useKeyboard`'s
  cycle chords import `cycleProject`), `BESIDE_ACTIVE`,
  `STEERING_BLUR_GRACE_MS` (re-exported from `useKeyboard` so the tests and
  any importer keep working).
- `useKeyboard` calls `useSteering({ surface: "main", onTogglePanels,
  onSidePanel })` before its own effect, so the document capture listeners
  are still added before the window ones.
- Choice: the blur grace lives entirely in `useSteering` (its own window
  `blur` / `focus` listeners) instead of `useKeyboard`'s blur handler calling
  `noteBlur` / `noteFocus` as the plan sketches. Same behaviour, and the popout
  surface gets the grace for free. `useKeyboard`'s `onBlur` keeps the Super
  and subwindow-nav resets only; its `focus` listener is gone (it did only
  steering).
- `onTogglePanels` is optional in `SteeringOptions` (a popout has none).
- Net: `src/__tests__/shell/Steering*.test.tsx` + `cockpit/Steering*.test.tsx`
  before: 28 files / 291 tests; after: 28 files / 291 tests, untouched.

## Flagged for user

- (none yet)

## Gotchas for whoever continues

- Shell output here goes through the `rtk` proxy: use `rtk proxy <cmd>` for
  raw eslint / grep output.
- Compound shell commands (pipes into `{ …; }`, `cp` chains) are refused by
  the worktree guard; edit through scripts in the scratchpad or plain calls.

# Phone PWA design pass — Plan

Status: **steps 1–7 implemented, uncommitted, 2026-11-01; never live.** The
user chose all eight proposals from the design canvas (Phone PWA Design
Proposals, 2026-11-01). Nothing here is live-verified; every behaviour change
wears an `UntestedTag` row (`mobile.focus.caption`, `mobile.composer.bar`,
`mobile.focus.flatAnswers`, `mobile.design.skeletons`, `mobile.design.pair`,
`mobile.design.sheets`, `mobile.design.icons`).

Why: the October Home/project redesign (`docs/mobile_home_redesign_plan.md`,
"octagon, but calm") left the rest of the phone app in the older idiom —
16–20 px radii and circles in chrome, ~30 one-off greys, 14 font sizes outside
the `--fs-*` scale, and chrome glyphs drawn as text characters (‹ ✕ ⋯ ◷ ⎇ ⠿
◇ ⌕ ▭), which each phone renders from a different symbol font.

## Fixed decisions

- **One mechanism for cut corners.** Reuse the corner-layer rule the Mail /
  To-do / Calendar block already uses (`--oct`, `--oct-edge`, `--oct-img`,
  clip-path) for every bordered element; a borderless one is only clipped.
  No new technique, no `[data-theme]` selectors, no new `--m-*` anchors.
- **Tokens, not literals**, on the screens this pass touches: `--fs-*`,
  `--sp-*`, `--surface-group`, `--surface-raised`, `--hairline`, `--edge`,
  `--ink-muted`, `--oct-sm/md/lg`. Plain hex stays allowed (it is rewritten
  per theme at build time); one-off greys are replaced, not added.
- **Icons come from the desktop's set** (`src/components/common/icons/Icon.tsx`):
  the missing ones are added there, the phone's `glyphs.tsx` re-exports what
  the phone uses. Text glyphs stay only inside content (chat text, hints).
- **Clear and Commit stay in the composer bar**, as icon buttons with their
  accessible names unchanged (the mockup put them in the ＋ tray; one tap
  beats two, and the ＋ tray is for attachments). Plan | Goal becomes a
  segment. The textarea row keeps the mic; Send is a cut-corner square.
- **The facts strip moves into the Status sheet** as rows (model, mode,
  worktree, location, limits, context) and the header caption summarises it
  (lamp · CLI · model · mode · ⎇ branch · context). The row classes
  (`fact-action`, `fact-limit`, `fact-limit-bar`, `fact-model`) and the
  `session-facts` container are kept inside the sheet so the tests change
  only by opening it first.
- **Agent answers are flat**: no bubble, full width, the time under the text;
  user prompts keep their bubble; a plan keeps its outline (it waits on a
  yes). Tool rows stay dim. The output area loses its gradient. One block per
  message, keys unchanged ([[feedback_chat_bubbles_immutable]]).
- **Sheets**: cut top corners (`--oct-lg`), the ✕ on the right by CSS order
  (markup untouched: 27 sheets), inset option groups, slide-up 180 ms and a
  short screen fade — transform and opacity only, off under
  `prefers-reduced-motion`. The terminal screen only fades (a transform would
  move its fixed children).
- **Skeletons**: static cut-corner rows in the group surface, opacity pulse
  only; the single `role=status` element stays the loading announcement.
- **Pair / Unlock**: brand head kept (mark + wordmark), fields and the primary
  button in the system, the version in a footer. The code stays one input
  (letter-spaced) — a six-cell field would re-open the pairing test contracts.
- **Out of scope**: the files library, outbox viewer, markup view and the
  Mail / To-do / Calendar interiors keep their own rules; only their edge
  colour is unified.

## Steps

1. **B · Icons** — `Icon.tsx` gains Close, More, Plus, Menu, ChevronLeft,
   ChevronRight, Branch, Diff, Grip, Diamond, Question; `glyphs.tsx` exports the
   phone's set. Sites: `Project.tsx`, `TabCard.tsx`, `Home.tsx`, `Terminal.tsx`
   (header, notices), `NewTabSheet.tsx`, `AgentStatusPill.tsx`,
   `AgentModeMarks.tsx`, `GitSheet.tsx`, `NeedsYou.tsx`, the sheets' ✕.
2. **A + E + F · style.css** — tokens and cut corners on: base `button` /
   `input` / `select` / `textarea`, `.option-sheet`, `.focus-menu`,
   `.hint-message`, `.terminal-view-switch`, `.prompt-composer` and its
   buttons, `.chat-change`, `.new-tab-*`, `.usage-*`, `.status-*`,
   `.mobile-schedule-*`, `.sign-in-*`, `.inbox-upload`, `.question-*`,
   `.asked-list`, `.option-list`; the card's meta line; sheet and screen
   motion.
3. **C · Focus chrome** — `Terminal.tsx`: caption button under the title,
   facts rows handed to `StatusSheet.tsx` (new `facts` prop), composer bar
   reshaped. Tests: `MobileTerminalLimits`, `MobileModelSheetSteps`,
   `MobileTerminalTranscript` (Clear text), `MobileAssistantScreens`.
4. **D · Flat answers** — `style.css` chat rules, `themes.css` octagon rule
   narrowed to the user bubble.
5. **G · Skeletons** — `Home.tsx`, `Project.tsx`, `Activity.tsx` loading rows.
6. **H · Pair / Unlock** — `Pair.tsx`, `LocalUnlock.tsx`, `BrandHead.tsx`,
   their CSS.
7. Register rows (`src/lib/untested.ts`), i18n keys (five languages),
   filemap rows, gates.

## Verification

`npm run build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`. Live:
open the phone app after the next dev build; the pills name what to check.

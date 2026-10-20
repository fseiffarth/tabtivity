# Phone Home + project screen redesign — plan

Goal (user, 2026-10-15): make the PWA start page (`mobile-web/src/screens/Home.tsx`)
and the project tab view (`mobile-web/src/screens/Project.tsx`) modern like
existing apps and more user-friendly. Three planners (visual design, usability,
engineering constraints) proposed and then debated; this file is the agreed
result. Out of scope: anything inside a tab (`Terminal.tsx`).

Direction: **"octagon, but calm"** — keep the cut-corner signature (it mirrors
the desktop Reader), drop the gradients, spend the accent only on actions and
selection, spend colour only on state. Patterns borrowed: iOS inset grouped
lists + segmented control, Material 3 extended FAB in the thumb zone,
Mail/Telegram rows (leading tile · title · meta · preview).

## 1. Hard constraints (read before touching anything)

- **Files with another session's uncommitted edits — do not edit:**
  `mobile-web/src/screens/Terminal.tsx`, `api.ts`, `thumbs.ts`,
  `markupInstruction.ts`, `markup/*`, `pdfFrame/*`, `components/OutboxViewer.tsx`,
  `MarkupView.tsx`, `MarkupQuestionsCard.tsx`, anything under
  `src-tauri/src/services/mobile_control/`. Calling existing `api.ts`
  functions is fine; changing them is not.
- `src/lib/i18n.ts` and `src/lib/i18nDicts/{de,es,fr,it}.ts` are also dirty but
  new strings must go there: **append-only** key blocks, every new key in all
  five languages (parity test). Never stash, checkout, reformat or reorder
  those files. Keys: `mobile.home.*` / `mobile.project.*`.
- **No commits** — the tree is shared with a concurrent session; leave the work
  uncommitted for the user.
- Never start Tabtivity, `tauri:dev`, or a dev server.
- **CSS scoping:** sheets, the drawer and OutboxViewer render *inside*
  `main.home-screen` / `main.project-screen` (no portals), and `button header
  nav h1 .primary .card .cards .count .notice .error .lamp .create .selected
  .search .back .terminal-title .view-caret .agent-status* .option-sheet
  .option-list .sheet-*` are shared with Terminal/Todo/Mail/Calendar/sheets.
  Every new or changed selector uses child combinators
  (`.project-screen > .cards > .tab-card`) or a Home/Project-only class
  (`.home-*`, `.project-*`, `.mobile-alert*`, `.tab-card*`). `LockedHomeShell.tsx`
  echoes Home's header classes — keep it looking right.
- **Theme pass** (`themeColors.ts`): author plain hex in the dark palette; it is
  rewritten onto the `--m-*` anchors for every theme. No `[data-theme]`
  selectors, no new `--m-*` anchors, no accent gradients (unreadable in Plain
  Dark, whose accent is white), no inline colour styles. Reuse literals near
  `#7c6cff` for accent. No CSS nesting / `@container` / `@layer` (jsdom loads
  style.css).
- **WebKit/iOS:** never animate a blurred `box-shadow` — static shadow
  pseudo-element, animate opacity. At most **one** new `backdrop-filter`: the
  sticky project header, over a fill ≥ 0.85 opaque. Only `transform`/`opacity`
  transitions; all motion off under `prefers-reduced-motion`.
- **Gestures:** no inner scroll containers, no horizontal chip strips (focusSwipe
  abandons on pannable `overflow-x:auto`), keep `touch-action:none` on grips,
  every icon button ≥ 44px hit box. No long-press menus (conflicts with
  `useRowDrag` and iOS callout).
- **Test contracts that stay** (unless this plan explicitly changes one):
  - `.tab-card strong` = row order; no extra `<strong>` in a card (tile text is
    an `aria-hidden` `<span>`).
  - Home openers are `button.card` whose first `<strong>` is the label, caption
    `<small>` sibling inside the same span, GitMark inside the opener;
    `aria-label="Open tabs: N"` element's text is exactly N.
  - Active / Agents / Search stay `button[aria-pressed]` (not `role=tab`); gear
    "This device" reachable in all three views; one `role=status` while loading.
  - Project: first `header` contains `.back`; `header h1` text is exactly the
    project name; `.terminal-title small` reads "Sorted by …"; no `<select>`;
    menu "Sort tabs" with three `menuitemradio`.
  - Unique accessible names: "New tab" (or "Send a file…"), "Project menu",
    "Colour X", "Rename X", "Close X", "Move X", "Open X", "Scheduled prompts
    for X", "Change the model of X", "◷ Collected prompts". Never render two
    buttons with the same name at once.
  - `.has-tab-color`, `.swiped-out`, `data-swipe-close`, `.file-tab-card`,
    `.tab-card-prompt.scheduled`, exact schedule-line text.
  - `Home` / `Project` prop signatures unchanged (`App.tsx`, `lastPlace`).
- New not-live-verified features get an `UntestedTag`-style pill
  (`isUntested("id") && <span className="untested">`) **and** a row in
  `src/lib/untested.ts`; a removed control loses its row (`npm test` runs the
  register check).

## 2. Shared tokens (style.css `:root`, hex)

- Type: `--fs-large` 1.75rem/700/−.02em · `--fs-title` 1.25rem/650 ·
  `--fs-headline` 1.0625rem/600 · `--fs-body` .9375rem · `--fs-sub` .875rem ·
  `--fs-foot` .8125rem · `--fs-caption` .75rem · `--fs-micro` .6875rem. Use them
  on these two screens instead of ad-hoc sizes.
- Spacing 4pt: `--sp-1…7` = 4, 8, 12, 16, 20, 24, 32px; screen gutter 16px,
  section gap ~28px.
- Surfaces: `--surface-group #1a1d2b`, `--surface-raised #222637`,
  `--hairline #2b3040`, `--edge #363c50`, `--ink-muted #98a0b4` (check each
  maps onto an anchor in the built CSS — no new `oklch(` own-hue fallbacks).
- `--hit: 44px`. Corner cuts `--oct-sm 6px`, `--oct-md 10px`, `--oct-lg 14px`,
  `--oct-fab 17px` (= `.todo-fab`).
- Budget: **no net growth of style.css** — delete the octagon/gradient layers
  these screens stop using (≈ style.css 244-300, 403-405, 452-482 and the Home
  header gradient ≈ 387) as you replace them. Check every deleted rule has no
  other user (`rg` the class across `mobile-web/src`).

## 3. Home (start page)

Top → bottom:

```
 ◈ Tabtivity          ● Offline   ⚙      slim bar; lamp has aria-label,
 Projects                        [＋]     worded chip only when down
 ┌ Active ▕ Agents ②▕ Search ┐            one segmented track
 NEEDS YOU
 ╱‾ ? Paper · claude 2            2m  ‾╲  agent rows: question/interrupted,
 │    Drop the legacy table?          │   unseen done
 │ ✉ Reply to Anna      in 1h   [✓]  │   then alert rows
 │ Show all 5 ›                       │   cap 3, expands in place
 ╲_ ▶ 2 working · see Agents ›       _╱
 PROJECTS
 ╱‾ [P] Paper   ?1 ✓1      ▭3    ⠿  ‾╲  inset grouped list,
 │──────────────────────────────────│   hairline separators
 ╲_ [W] Website ▶1         ▭2    ⠿  _╱
   Drag ⠿ to arrange.                    group footer hint
 DESKTOP
 ╱‾ Send to desktop · Local models    ‾╲
```

1. **Header:** remove the 70px gradient brand card. Slim 44px bar: AppMark +
   name, connection lamp (add an accessible name; show a worded "Offline" chip
   only when down), gear "This device". Move the build version (and its
   untested pill) into the This device sheet. Restyle `LockedHomeShell` to match.
2. **Title row:** "Projects"/"Agents" h1 at `--fs-large` (CSS only, no
   collapsing title). The New-project ＋ stays here, 44px.
3. **Switch:** Active / Agents / Search as one segmented track (same buttons,
   `aria-pressed`, selected thumb = accent tint). On Agents add an
   `aria-hidden` badge = sum of `agents.question` over the loaded project rows
   (no new poll; accessible name stays "Agents").
4. **Needs you** (Active view only, above the projects, hidden when empty —
   no empty box):
   - Agent rows from `getActivity` (existing `api.ts` fn, polled 5 s while the
     Active view is visible and the page is shown — the same cost as Agents
     mode today): tabs in `question` / `interrupted`, plus `done` tabs not yet
     seen. Row = status mark, project · tab label, relative time, last prompt
     one line (reuse Activity's row data/markup where possible). Tap = `openTab`.
   - **Seen marker:** new pure module (e.g. `mobile-web/src/seenDone.ts`) — a
     per-device prefs map tab id → `done_at`, capped (~200), with its own unit
     test. Opening a done tab from anywhere on Home marks it seen; a newer
     `done_at` makes it unseen again.
   - Then the existing alert rows (mail/to-do/calendar, their ✓ buttons
     unchanged), moved up from below the project list.
   - Cap 3 rows; "Show all N" expands in place (no inner scroll). If any tabs
     are working, a last summary row "▶ N working" switches to the Agents view.
   - Must not add a second `role=status` while loading; Needs you renders
     nothing until its first answer.
   - Search view: no Needs you, no alerts (as today). Agents view: unchanged.
5. **Projects:** inset grouped list (one octagon group `--oct-lg`, rows inside
   with hairline borders, no per-row gradient or violet bar). Each row: 36px
   leading tile (first grapheme of the name; ⬡ for a box, `>_` for root;
   `aria-hidden` span, single accent tint — no per-project hues), label
   `<strong>` + caption, status counts (`AgentCounts`), `.tab-count` as muted
   number with a `::before` tab glyph (text stays just N), grip under Active
   with >1 row. Drop the repeated "active" caption in the Active view
   (`projectOrder.ts:68` / caption logic) only if no test pins it — otherwise
   keep it. Drop line = static inset shadow. ≥ 900px: Home list stays one
   column (`.home-screen > .cards` override).
6. **Desktop group** at the bottom: section head "Desktop", then the existing
   `SendToDesktop` and `LocalModelsSection` restyled as grouped rows. They stay
   on the page (moving them into a sheet would kill in-flight upload rows).
7. **Empty / loading:** empty states become glyph (muted 40px) + headline +
   one line + an action ("Search all projects" → switches to Search). Loading
   stays a single `role=status`, styled quietly.

## 4. Project screen (tab list)

```
 ‹  Paper ▾                       ☰      sticky 44px bar (≤1 blur)
    Sorted by last working
 [ Activate this project ]               only when inactive, primary
 ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲
 ▌[C?] Docs rewrite   opus-4  ◷  ⋯ ✕│   tile = agent initial + status badge
 ▌     4m · PLAN · 2 sub · wt:fix   │   meta row
 ▌     Rewrite the README intro so  │   latest prompt ≤ 3 lines
 ▌     14:02 run the tests          │   older prompts 1 line
 ▌     ◷ 18:00 run nightly tests    │   schedule foot (exact text)
 ╲______________________________ ⠿╱
   Drag ⠿ to arrange · swipe left to close   group footer, dismissible
 ▸ Recently closed (2)                   disclosure
 ╱‾ ◷ Collected prompts          › ‾╲
                       ╱‾‾‾‾‾‾‾‾‾‾‾╲
                       │ ＋ New tab │      extended FAB above the tab bar
                       ╲___________╱
```

1. **Header:** keep `‹` (now a 44px button), the h1 sort dropdown with its
   "Sorted by …" `<small>`, ☰ "Project menu" — all 44px. **Remove the header
   ＋.** Make the header sticky; this is the one place a `backdrop-filter` is
   allowed (fill ≥ 0.85 opaque).
2. **FAB:** extended octagon "＋ New tab" bottom-right above the tab bar,
   generalised from `.todo-fab` (`.fab` + `.fab-extended`), same aria-label and
   behaviour as the old header ＋ ("New tab", or the send-a-file name when there
   is no tmux). Static shadow pseudo-element. Add bottom padding to the list so
   the FAB never covers the last card. Label may fade on scroll-down (opacity
   only, off under reduced motion) — optional.
3. **Activate:** for an inactive project, a primary button at the top of the
   list instead of at the foot.
4. **Tab card:**
   - Leading 40px tile: agent initial from `agent_label` (`>_` for a shell),
     `aria-hidden` span. `AgentStatusMark` stays a **direct child of
     `.tab-card`** and is positioned as a badge on the tile's lower-right corner;
     change only `.tab-card > .tab-card-status` rules (Terminal shares
     `.agent-status`), retiring the left-border mask holes.
   - Tab colour stays the 3px left stripe (`.has-tab-color`).
   - First line: name (`<strong>`, part of the card opener — tapping it opens
     the tab), model chip ("Change the model of X", one tap, unchanged), ◷ only
     when the tab has schedules ("Scheduled prompts for X", one tap), ⋯ "More
     for X", ✕ "Close X" (one tap, unchanged). Swipe-left still closes.
   - ⋯ opens an `OptionSheet` (copy FilesLibrary's "More for X" pattern):
     Rename, Colour, Scheduled prompts, Subagents (when present), Close. Row
     names inside the sheet must not equal the card buttons' names (e.g.
     "Rename", "Colour…", "Scheduled prompts") so `getByRole` stays unique;
     Rename/Colour open the existing RenameSheet/ColorSheet. The standalone
     colour dot and the name-tap-renames button go away — **test edits:**
     MobileTabRename, MobileTabColor, MobileProjectSchedule (when not via ◷),
     MobileProjectTerminalsUnsupported: open ⋯ first. Say so in the report.
   - Second line (meta): TurnDuration, AgentModeMarks, WorktreeMark,
     SubagentCount — moved down from the title row.
   - PromptLines unchanged in behaviour; the "LAST PROMPTS" caps label becomes
     screen-reader-only.
   - Grip stays in the lower-right cut, Manual sort only, quieter.
   - File cards (`.file-tab-card`) get the same tile/row treatment (file glyph
     in the tile); ✕ forget unchanged.
5. **Hints:** reorder and swipe hints move into the group footer as one muted
   line; dismissible (×) and remembered in `prefs` once dismissed or once the
   gesture was used.
6. **Foot:** Recently closed becomes a disclosure row "Recently closed (N)"
   (collapsed by default) listing the same reopen buttons; "◷ Collected
   prompts" a grouped row. Both keep their names.
7. **Empty state:** project with no tabs → glyph + headline + one line pointing
   at the FAB (no second "New tab" button).
8. **Undo after close (agent tabs):** after ✕/swipe on an agent tab, a
   snackbar "Closed X · Undo" for ~5 s that calls the existing `reopenTab`
   (verify the `ClosedTabRow.id` ↔ tab id mapping first; shells close with no
   snackbar). New test + untested pill + register row. Do this last; skip and
   report if the mapping doesn't hold.

## 5. Steps (single implementer)

1. **Baseline:** `git status` snapshot; `npx vitest run src/__tests__/mobile
   --reporter=dot` and record pre-existing failures (other session's tests).
   Add a test that scans `mobile-web/src/style.css` for animated blurred
   `box-shadow` (mirror the existing AnimatedShadowBlur check).
2. **Extract** without visual/behaviour change (tests pass unedited):
   `components/TabCard.tsx` (TabCard, FileTabCard, PromptLines, scheduleLine),
   `ProjectHeader`, `HomeAlerts`, `ProjectRow` as fits — state, polling,
   `useRowDrag`, swipe-close stay in the screens; TabCard forwards the row ref,
   `data-swipe-close` and classes. Only extract what makes the next steps
   simpler; don't churn for its own sake.
3. **Tokens + Project CSS** (§2, §4 visuals).
4. **Project structure** (§4.1–4.7), then §4.8.
5. **Home CSS + structure** (§3.1–3.3, 3.5–3.7).
6. **Needs you + seen marker** (§3.4).
7. **Wrap-up:** strings in all five dictionaries (append-only), untested pills
   + register rows for: Needs you, seen marker, card ⋯ menu, FAB, Undo snackbar,
   hint dismissal; `docs/help/mobile.md` where controls moved; one-line rows in
   `docs/filemap_frontend.md` for new files.

## 6. Verification (no app launch)

- `npm run build` (tsc + mobile bundle), `npm test -- --reporter=dot` (at least
  the mobile suites + i18n parity + untested register), `npm run lint` (no new
  warnings), `scripts/brand-check.sh`, `git diff --check`.
- `npm run mobile:bundle`, then grep the emitted CSS for new `oklch(` own-hue
  fallbacks from the new literals.
- Review the style.css diff: every changed selector scoped per §1.
- Attribute any failure to this work vs the concurrent session before acting.
- The user verifies on a phone (steps in the final report).

## 7. Deferred (agreed not now)

Replacing the Active/Agents/Search switch with an inbox; a host `view=all`
"browse all projects" (host.rs is dirty); a badge on the bottom-bar Projects
section (needs an App-level poll); per-card long-press; moving Send to desktop
/ Local models into a sheet; collapsing large titles; per-project tile hues;
undo for shell tabs.

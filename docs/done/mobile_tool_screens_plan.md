# Phone Mail, Calendar and To-do redesign — Plan

Status: **implemented 2026-11-15 (steps A–D + an unused-strings cleanup on
develop); reviewed before implementation (notes at the end); never live.**
Mockups: Design canvas "Phone Mail, Calendar & To-do"
(https://claude.ai/artifact/NnhGGac3rd1YqYgwseBmYJ, nine artboards). Nothing
here is live-verified; every changed screen wears an untested pill with a row
in `src/lib/untested.ts`.

Why: Home and the project screen moved to the calm system in October/November
(`docs/done/mobile_home_redesign_plan.md`, `docs/done/mobile_pwa_design_plan.md`: large
title, inset groups with hairline rows, icon chrome). The design pass left the
Mail / To-do / Calendar interiors out of scope, so they still draw every
element as its own bordered box: a six-line rules banner on Mail, seven
buttons above the month, two rows of filter boxes and a paragraph above the
first card, four always-visible controls on every column head.

## Fixed decisions

The user picked these on 2026-11-15; reviewers may not undo them.

1. **One screen head** for the three screens, Home's idiom: large title
   (`--fs-large`, 700), then icon-only buttons (refresh, ⓘ or ⋯) at `--hit`
   size, transparent — Home's own `.home-head-button`. A pushed level (a Mail
   folder or message) shows a back row: chevron + the parent's name, accent
   text. Glyphs come from `glyphs.tsx` / the desktop `Icon.tsx`, never text
   characters (‹ › ↻ × ✎ ▸ ✓). Every icon button has an `aria-label` (and
   `title`), as Home's do.
2. **Mail rules banner → ⓘ button** in the head (every level). It opens a
   sheet with the same sentences the banner shows now (`mobile.mail.notice*`
   keys, same composition logic). The banner `<p className="notice">` goes.
3. **Calendar actions**: "+ Event" becomes the To-do FAB (`.todo-fab`, same
   shape and position; disabled on `busy || !canWrite` as today); "Calendars"
   and "Reminders" move into the head's ⋯ menu (an `OptionSheet`). Above the
   month: only the view segment + Today. The ‹ label › step row
   (`.mobile-calendar-nav`) stays under it, with chevron icons.
4. **To-do filters**: a filter button inside the search field opens a sheet
   (project, tag, hide done, hide archived). An active project or tag filter
   shows as a removable chip under the search. The two hide switches are the
   normal state and show no chip. The filter button shows a count badge of
   active project/tag filters.
5. **To-do columns as sections**: head = colour dot, name, count, ⋯. The ⋯
   opens an `OptionSheet`: Rename, Fold/Unfold, Move left, Move right, Delete
   (danger, own section). Tapping the name still folds. An empty column is one
   quiet line (dot, name, count, "empty"); a folded one the same with a
   chevron. Cards sit in one inset group under the head.
6. **Cards as rows**: round check on the left, title, then — only when the
   card has notes — one muted, single-line clipped notes preview (the user
   chose this 2026-11-15; today's `.todo-mobile-notes` class stays, clamped
   to one line), then one meta line of chips
   (due tone, priority, steps, tags, and the progress bar). Tapping the row
   body opens the editor (as Edit does now). The per-card action row (Edit,
   ↑, ↓, move-to select) goes; a ⋯ on the row opens an `OptionSheet` with
   Edit, Move up, Move down and one "Move to <column>" row per other column.
   No function is lost: rows the desktop would refuse (`moveAccepted`, first /
   last card) show disabled, as the select's options do today.
7. **Tips compact** (shared `HintMessage`, all phone screens): one row of
   text buttons instead of boxed buttons, × (as `CloseIcon`) kept top right.
   Turn off tips on the left in the muted ink, Skip and Read on the right,
   Read in the accent. Same handlers and labels, so the tip semantics and
   tests stay. Each text button keeps the 44 px hit height.
8. **Mail lists**: folders are one inset group (icon, name, unread badge in
   the accent, total muted, chevron); folders with `total === 0` (never the
   inbox) fold under a "More folders · N empty" row that expands in place.
   The inbox list is one inset group per page: unread dot, sender (bold when
   unread), answered and star marks, attachment clip, time, subject, one-line
   preview. The pager stays (chevron icon buttons + the "1–25 of N" text);
   syncing / empty / loading lines stay. The account picker becomes a
   subtitle button under the title ("Work · 281 unread ⌄") that opens an
   `OptionSheet` of accounts; with one account it is plain text. Inside a
   folder the subtitle stays a button and its sheet lists that account's
   folders first, then the other accounts (replaces today's two selects;
   picking an account opens its inbox, as `chooseAccount` does now).
9. **Mail message**: mark read/unread and star become head icon buttons
   (aria-pressed for star); sender block with an initials tile; truncated
   warning kept; body on the raised surface; attachments as an inset group
   with the line "Attachments open on the desktop."; reply box as one group
   (label, textarea, send icon button). The confirm-before-send step, the
   sent line and the too-long warning stay as they are.
10. **Calendar month**: weekday row + borderless day cells inside one group;
    today = filled accent circle, selected = tinted circle, outside days in
    muted ink; dots stay. The selected day's agenda is one inset group (time
    column, colour dot, title, location). Week and day views keep their
    structure, restyled to the same group/row idiom; the day view's dashed
    empty-hour `+` buttons become borderless full-width rows with a faint
    `PlusIcon` (the whole row stays the tap target, same aria-label). The
    headless notice, truncated warnings and the event editor / calendar
    manager (read-only rows, `readonly` calendars disabled) keep their
    content.
11. **Dropped from the mockup** (no API for them, out of scope): Mail's "New
    in inbox" section and the All/Unread/Starred segment; localized folder
    names (server names stay).
12. **Colours are authored in the dark palette.** `mobile-web/src/style.css`
    is rewritten per theme at build time (`mobile-web/src/themes.css` header,
    `mobile-web/src/themeColors.ts`), so new rules use the existing tokens
    (`--surface-group`, `--surface-raised`, `--hairline`, `--edge`,
    `--ink-muted`, `--fs-*`, `--sp-*`, `--r-*`) and the existing accent hexes
    (`#8c7df4`, `#7c6cff`, `#bcb0ff`, `#2e2b48`), never the canvas's
    light-theme hexes. No `[data-theme]` selectors, no `/* theme: fixed */`,
    no new one-off greys. New rules go **above** the tablet `@media` block,
    which must stay the last block (`MobileTablet.test.tsx`).
13. **Tests read class names**: keep every class, role and accessible name a
    test or `HintMessage` `TARGETS` reads unless this plan renames it; a
    renamed selector is updated in `TARGETS` and the tests in the same step.
14. **No backend, API or prefs change.** `readFlag`/`writeFlag` keys for
    hide-done/hide-archived, the fold list (`todoCollapsedColumns`), the
    remembered `mailAccount` choice and the To-do deep link (`card` prop →
    editor, once) stay. No animation is added (WebKitGTK /
    `[data-software-paint]`); an expanding row may reuse
    `.project-foot-caret`'s existing rotate.

## Shared contract (step A lands it; B–D build on it)

**Reuse first** ("copy the working sibling"): no new class where Home has one.

- `mobile-web/src/components/ScreenHead.tsx` —
  `ScreenHead({ title, subtitle?, back?: { label, onClick }, actions?: ReactNode, onRefresh?, refreshing?, untested?: boolean })`:
  `<header className="screen-head">` with an optional `.screen-head-back`
  button (ChevronLeftIcon + label), a row holding the `<h1>` and the actions,
  and `subtitle` (a `ReactNode`: plain text or the screen's own button) in
  `.screen-head-sub` under the title. `onRefresh` draws the first action:
  `.home-head-button` with `RefreshIcon`, `aria-label`/`title`
  `common.refresh`, disabled while `refreshing`. Screens put their other
  icon buttons in `actions` with class `home-head-button` (no new `head-icon`
  class). The pill: `untested || isUntested("mobile.design.toolHead")` →
  `<span className="untested">{t("mobile.newTab.untested")}</span>` after
  the title. The `<h1>` wraps (a long Mail subject) rather than ellipsizing.
- `OptionSheet.tsx`: `SheetOption.disabled?: boolean` (`disabled={busy ||
  option.disabled}`), and the `waiting` paragraph renders only when
  `waiting` is non-empty (lets Mail's ⓘ sheet be `note` + no rows). Filemap
  row updated.
- Icons: add `InfoIcon` (ⓘ, circle + i) and `FilterIcon` (funnel or
  sliders) to `src/components/common/icons/Icon.tsx`; re-export them and
  `RefreshIcon` from `mobile-web/src/glyphs.tsx`.
- CSS, all in A (`style.css`):
  - New block "Tool screens" right after the Home rules (~line 456):
    `.screen-head`, `.screen-head-back` (accent `#bcb0ff`, `--hit` tall),
    `.screen-head-sub` (`--fs-sub`, `--ink-muted`; as a button: bare, with
    `ChevronDownIcon`), `.tool-section-head` (small caps label, `--fs-foot`,
    `--ink-muted`), `.tool-segment` sizing (full width, equal segments),
    `.tool-chip` (removable pill), `.tool-badge` (accent count pill).
  - Aliases into existing rules, not copies: `.screen-head h1` beside
    `.projects-row h1`; `.tool-group` beside `.home-group` (the group rule,
    its `> * + *` hairline rule and the `border-radius:var(--o)` list);
    `.tool-row` beside `.home-needs-row,.home-group-more` (52 px row);
    `.tool-segment` beside `.terminal-view-switch` (track, bare buttons,
    lit = `.selected` + `aria-pressed`).
  - Ground and gutter: add `.mail-mobile-screen,.todo-screen,
    .mobile-calendar-screen` to `.home-screen,.project-screen { padding-inline;
    background }`.
  - Split the "Mail, To-do and Calendar are rounded" block (~742–790) **in
    place** into four groups, each headed by its own comment line: shared
    (`.todo-editor*`, `.todo-inline-check`, `.todo-fab` for both
    `.todo-screen` and `.mobile-calendar-screen`), Mail, To-do, Calendar.
    Drop its `> header > button:not(.back)` selectors (the head is
    `ScreenHead` now). Move the "Mail's pickers" lines (~734–741) up into
    the Mail region.
  - Calendar's FAB room: `.tabbed > .mobile-calendar-screen` beside
    `.tabbed > .todo-screen` in the padding rule (~537) and in the tablet
    block's copy (~2399).
  - Editor close glyph: `.todo-editor-heading > .sheet-close` loses the
    rounding block's border (C and D then draw the editors' × as
    `<button className="sheet-close" aria-label={t("common.close")}><CloseIcon size="1em" /></button>`,
    copying `CalendarEditSheet`).
- `HintMessage` (decision 7) + `TARGETS` for the new markup (the pointer is
  simply absent until B–D land the classes):
  `mailBack: ".screen-head-back"`, `mailPickers: ".mail-account-switch"`,
  `mailWrite: ".mail-mobile-reply textarea"`,
  `todoDone: ".todo-check"`, `todoEdit: ".todo-card-body"`,
  `todoMove: ".todo-card-more"`, `todoFilter: ".todo-filter-button"`,
  `todoColumns: ".todo-column-fold"`, `todoAdd: ".todo-fab"`,
  `calendarViews: ".mobile-calendar-views"`,
  `calendarDays: ".mobile-calendar-day"`,
  `calendarEvents: ".mobile-calendar-event"`,
  `calendarCalendars: ".mobile-calendar-more"`,
  `calendarReminders: ".mobile-calendar-more"`.
  The `mobile.hints.read` pill moves from the actions row into the head's
  existing `isUntested(…)` chain, joined by `isUntested("mobile.design.tips")`.
  Tips reworded in all five dictionaries to the new controls:
  `mobile.hints.todoDone` (round check), `todoEdit` (tap the card),
  `todoMove` (⋯ on a card), `todoFilter` (filter button in the search),
  `todoColumns` (⋯ beside the name), `mailPickers` (the line under the
  title), `mailWrite` (head buttons; no "★ Star" text), `calendarCalendars`
  and `calendarReminders` (⋯ → Calendars / Reminders).
- i18n — new keys (all five dictionaries, beside their area's keys; the
  `src/__tests__/shell/i18n.test.ts` gate needs every language to hold every
  English key with its `{placeholders}`):
  `mobile.mail.info` "How mail works here", `mobile.mail.infoTitle` "Mail on
  this phone", `mobile.mail.moreFolders` "More folders",
  `mobile.mail.emptyFolders` "{count} empty",
  `mobile.mail.attachmentsDesktop` "Attachments open on the desktop.",
  `mobile.calendar.more` "More", `mobile.calendar.manageNote` "Add, rename,
  recolour or delete", `mobile.calendar.remindersNote` "Notifications on
  this phone", `mobile.calendar.previous` "Previous", `mobile.calendar.next`
  "Next", `mobile.todo.filters` "Filters", `mobile.todo.filtersOn`
  "Filters, {count} on", `mobile.todo.chipProject` "Project: {name}",
  `mobile.todo.chipTag` "Tag: {name}", `mobile.todo.removeFilter` "Remove
  filter {name}", `mobile.todo.columnMenu` "{name}: column actions",
  `mobile.todo.cardMenu` "{name}: card actions", `mobile.todo.fold` "Fold",
  `mobile.todo.unfold` "Unfold", `mobile.todo.moveToColumn` "Move to {name}".
  Reworded value: `mobile.mail.star` "★ Star" → "Star" (the star button's
  label; state is `aria-pressed`).
  Reused, no new key: `mail.folders` (folder section head),
  `mail.switchAccount` (subtitle button label), `mobile.mail.account`
  (account sheet title), `mobile.mail.sendReply` (send icon's label),
  `mobile.mail.markRead`/`markUnread`, `mobile.mail.previous` +
  `common.next` (pager), `common.refresh`, `common.close`, `common.reset`,
  `common.edit`, `common.delete`, `mobile.calendar.today`,
  `calendarSidebar.calendarsTitle`, `mobile.push.reminders`,
  `eventDialog.newEventTitle` (Calendar FAB label), `mobile.todo.noCards`
  (the empty column's word), `mobile.todo.hiddenByFilters` (an empty column
  whose cards the filters hold), `mobile.todo.renameColumnNamed`,
  `moveColumnLeft/Right`, `deleteColumnNamed`, `moveCardUp/Down` (sheet
  rows), `todoBoard.addColumn` (the foot row, with `PlusIcon`),
  `todoBoard.filterAnyProject`/`filterNoProject`/`filterAnyTag`,
  `todoDialog.project`/`tags`, `todoBoard.hideDone`,
  `mobile.todo.hideArchived`.
- `src/lib/untested.ts` rows (area `mobile`, one line each saying what to
  check): `mobile.design.toolHead`, `mobile.design.tips`,
  `mobile.design.mail`, `mobile.design.calendar`, `mobile.design.todo`.
  Call sites land **in A** or `scripts/untested.mjs check` fails: ScreenHead
  (`toolHead`), HintMessage (`tips`), and each screen's
  `<ScreenHead untested={isUntested("mobile.design.mail")} …>` (the scanner
  only sees `isUntested("…")`, `untested: "…"`, `<UntestedTag id=…>` —
  never a JSX `untested="…"` attribute). A step that removes a pill's spot
  moves its `isUntested("id")` into its head's `untested` chain; no step
  deletes or stamps a row.

## Steps

- **A · Shared contract** — everything in "Shared contract", plus: switch the
  three screens' `<header>` to `ScreenHead` with today's controls (Mail's
  back → `back`, its ↻ → `onRefresh`; Calendar's and To-do's ↻ →
  `onRefresh`), nothing else in the screens. Filemap rows:
  `ScreenHead.tsx` (new), `OptionSheet.tsx`, `HintMessage.tsx`.
  Tests: none should break; keep `MobileHintMessage`, `UntestedRegistry`,
  `i18n`, `MobileTablet`, `MobileTheme` green.
- **B · Mail** — `mobile-web/src/screens/Mail.tsx` + the Mail CSS (its
  region, the moved pickers lines, its group of the rounding block):
  decisions 2, 8, 9, 11. Keep `.mail-mobile-folders` (buttons with the name
  in a `<span>`), `.mail-mobile-row` (+ `unread`/`flagged`/`answered`),
  `.mail-mobile-reply textarea`, `.mail-mobile-empty`, `.mail-mobile-pager`.
  New: `.mail-account-switch` (the subtitle button, both levels; carries the
  `mobile.mail.accountPicker` pill). ⓘ = `OptionSheet` with
  `title=mobile.mail.infoTitle`, `note` = the composed sentences, no rows.
  Back row: message → folder name; folder → `mobile.mail.title`.
  Tests to update: `MobileMailWrites` ("Mark read"/"Mark unread" →
  `getByLabelText`; "★ Star"/"☆ Unstar" → the "Star" button's
  `aria-pressed`; `/Read-only mail/` and the write notices → open ⓘ first;
  "Send reply…" → `getByRole("button", { name: "Send reply…" })`),
  `MobileMailAccounts` (the "Mail account" and "Folder" selects → the
  subtitle button's sheet).
- **C · Calendar** — `mobile-web/src/screens/Calendar.tsx` + the Calendar
  CSS (`.mobile-calendar-*`, `.calendar-*`, its rounding group, the
  ≤360 px media line): decisions 3, 10. Head actions: ⋯
  `.mobile-calendar-more` (`aria-label` `mobile.calendar.more`) →
  `OptionSheet` rows Calendars (`manageNote`, `more`) and Reminders
  (`remindersNote`, `more`, `trailing` = the `mobile.calendar.push` pill).
  The view segment gets `tool-segment mobile-calendar-views`, keeps
  `role="group"`, `aria-pressed` and the `mobile.calendar.views` pill.
  Nav chevrons get `mobile.calendar.previous`/`next` labels. FAB:
  `<button className="primary todo-fab" aria-label={t("eventDialog.newEventTitle")}>＋</button>`.
  Editor and manager: only the × (→ `.sheet-close` + `CloseIcon`). Keep
  every exported helper (`MobileCalendarDates` imports them).
  Tests to update: `MobileCalendarManage` (open ⋯, then the row
  `/^Calendars/` — the row's name includes its description),
  `MobileCalendarReminders` (open ⋯ before `/^Reminders/`).
- **D · To-do** — `mobile-web/src/screens/Todo.tsx` + the To-do CSS
  (`.todo-mobile-*`, `.todo-column*`, `.todo-check`, `.todo-chip`,
  `.todo-add-column`, `.todo-progress-*`, its rounding group; not
  `.todo-editor*`, `.todo-inline-check`, `.todo-fab`, which are shared):
  decisions 4, 5, 6. Classes: `.todo-filter-button` (inside a wrapper with
  `.todo-mobile-search`; `aria-label` `filters`/`filtersOn`; badge
  `.tool-badge`), `.tool-chip` chips, `.todo-card-body` (row body button),
  `.todo-card-more` (⋯, `cardMenu`), column ⋯ (`columnMenu`), `.todo-check`
  with `CheckIcon`. Filter sheet: `OptionSheet` titled `mobile.todo.filters`,
  `children` = the two existing `todo-inline-check` checkboxes (labels
  unchanged), rows grouped by project and tag with `current` marks, footer
  `common.reset`. Keep: the column `<h2>`'s accessible name = name + count
  (⋯, "empty" and the dot outside or `aria-hidden`); `todo-column-fold`
  with `aria-expanded`; the progress bar's `role="progressbar"` +
  `progressOf` label in the meta line; the headless notice and its pill;
  the FAB; `card` deep link. The `foldHint` paragraph goes (its
  `mobile.todo.fold` pill joins the head's chain; the `todoColumns` tip says
  it); the `todo-mobile-note` foot notice goes (the headless notice covers
  the closed-window case). "+ Column" → a `.tool-row` at the foot with
  `PlusIcon` + `todoBoard.addColumn`.
  Tests to update: `MobileTodoBoard` ("Hide done"/"Hide archived" → open
  the filter sheet first; "1 card folded away" is gone — assert the folded
  line instead), `MobileTodoSheets` ("+ Column" → "Add a column"; "Rename
  Doing"/"Delete Doing" → open the column ⋯ first; "✎ Edit" → tap the card
  body), `MobileTodoDateColumns` ("Move Late" select → the card ⋯ sheet:
  enabled "Move to" rows are `doing`, `shelf`; the current column has no
  row).

## Conflicts to avoid

- B/C/D edit only their screen file, their own `style.css` region and their
  own rounding-block group (A split it so the groups are separated by
  unchanged comment lines). They do not touch `ScreenHead.tsx`,
  `OptionSheet.tsx`, `HintMessage.tsx`, `glyphs.tsx`, `Icon.tsx`,
  `untested.ts`, the filemap, the "Tool screens" block, the shared rounding
  group, or the `.todo-editor*` / `.todo-inline-check` / `.todo-fab` /
  `.reorder-hint` rules.
- Dictionaries: A adds every key. B–D add none; a key they cannot do
  without goes in the middle of their area (never at its first or last line:
  the `mobile.mail.*` and `mobile.todo.*` blocks touch) and is named in the
  report. No step removes a key — see "Keys that go dead".
- The main checkout has another session's uncommitted edits in the five
  dictionaries, `untested.ts` and `docs/filemap_frontend.md`. Landing A must
  apply A's commit onto `develop` without sweeping those in (private-index
  recipe), and must not overwrite them in the working tree.

## Organisation

Shape: **contract first, then parallel**. Four Sonnet implementers, at most
three at once:

| Agent | Step | Base | Files |
|---|---|---|---|
| A | Shared contract | `develop` | `ScreenHead.tsx`, `OptionSheet.tsx`, `HintMessage.tsx`, `glyphs.tsx`, `Icon.tsx`, `style.css` (shared parts above), 5 dictionaries, `untested.ts`, filemap, the three screens' head only |
| B | Mail | A's commit | `Mail.tsx`, Mail CSS, Mail tests |
| C | Calendar | A's commit | `Calendar.tsx`, Calendar CSS, Calendar tests |
| D | To-do | A's commit | `Todo.tsx`, To-do CSS, To-do tests |

Each runs in its own worktree (`isolation: "worktree"`; first `git reset
--hard <base>`, then `cp -al` the main checkout's `node_modules` per
`project_worktree_node_modules`), runs `scripts/gates.sh` for what it touched
(`npm run build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`),
commits green with the noreply author, and reports shas, choices, test
counts and anything flagged. The main session lands A, then B, C, D in
order onto `develop` (the dirty-checkout landing recipe), runs the gates
once on the result, removes the dead keys below in one pass, and reports.

### Keys that go dead (main session, after D, once `rg` shows no use)

`mobile.mail.unstar`, `mobile.mail.folder`, `mobile.mail.accountLabel` (if
B does not use them as sheet group heads), `mobile.todo.foldHint`,
`mobile.todo.note`, `mobile.todo.editCard`, `mobile.todo.moveCardTo`,
`mobile.todo.addColumn`, `mobile.todo.foldedCards`,
`mobile.todo.foldedCardsOne` — from all five dictionaries. The orphaned
`.reorder-hint` rule (style.css ~150) goes with them if nothing else uses it.

## Verification

Gates as above. Live (the user, after the dev build): open Mail, Calendar
and To-do on the phone in a light and a dark theme; check the ⓘ sheet, the
account switch (overview and inside a folder, folder switch too), folders
folding, a message's star/read/reply; the month grid, ⋯ menu, + FAB (and
disabled with only read-only calendars), day and week views; the filter
sheet and chips, a column's ⋯ menu, a card's ⋯ menu (move up/down/to, a
refused column disabled), fold, an alert's card link opening the editor,
and a tip's three buttons on another screen too (Home, a chat).

## Review notes (2026-11-15)

Changed:
- Reuse over invention: `.head-icon` dropped for `.home-head-button`;
  `.tool-group`/`.tool-row`/`.tool-segment`/`.screen-head h1` are aliases on
  Home's and the Focus segment's rules. Duplicate keys dropped in favour of
  existing ones (`mail.folders`, `mail.switchAccount`,
  `mobile.mail.sendReply`, `mobile.todo.noCards`).
- Lost functions restored: the in-folder folder switch (decision 8), the
  calendar step row (3), the percent bar (6), disabled refused moves (6),
  inbox never folded (8), FAB disabled without a writable calendar (3).
- Missing pieces: `SheetOption.disabled` and an empty-`waiting` fix in
  `OptionSheet`; `InfoIcon`/`FilterIcon` (none existed); labels for the new
  icon buttons (calendar nav had none); `mobile.mail.star` reworded.
- Untested register: A must land call sites with the rows (the audit fails
  otherwise, and does not see a JSX `untested="…"`); removed pill spots
  move into the head chain.
- Conflicts: the rounding block listed all three screens in single lines —
  A splits it; FAB padding, Calendar's `.todo-fab` rounding, the editor ×
  and the Mail pickers CSS moved into A; dictionary edits all in A; dead
  keys removed once at the end. Noted the dirty main checkout.
- Corrected: `themeColors.ts` path; tips list (todoDone, todoColumns,
  mailWrite also need rewording); the `todo-mobile-note` rationale; per-step
  test lists.

Blocking questions for the user: none. Two choices were put to the user on
2026-11-15: the in-folder subtitle sheet listing folders and accounts
together (decision 8) — **kept**; the card's notes preview — **one muted
line** (decision 6), not dropped.

Step A landed as `6b05f85a1` (worktree branch, on `c453aec09`): head is
`ScreenHead({ title, subtitle?, back?, actions?, onRefresh?, refreshing?,
untested? })`; icon buttons are `.home-head-button`; `SheetOption.disabled`;
`InfoIcon`/`FilterIcon`/`RefreshIcon` in `glyphs.tsx`; tip buttons
`.hint-message-off/-skip/-read`; the rounding block is split into "Rounding ·
shared / Mail / To-do / Calendar"; the editor × is a plain `.sheet-close`;
`MobileMailWrites` already queries "Star". A screen whose pill spot goes away
moves its `isUntested("id")` into its head's `untested` prop.

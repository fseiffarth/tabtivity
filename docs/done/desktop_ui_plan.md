# Desktop UI pass — Plan

Status: **implemented on develop 2026-11-02, never run live** (see "As built"
at the end; the system itself is `docs/context/desktop_ui_system.md`). The user chose all seven
proposals from the design canvas (Tabtivity desktop UI plan,
https://claude.ai/artifact/8f6xLVjZ4ZQbzePgWk4Q3q — six boards: workspace
chrome, command palette, empty subwindow + skeletons, floating surfaces, the
token system, the icon mapping). Nothing here is live-verified; every
behaviour change wears an `UntestedTag` row when implemented.

Goal (user): make the desktop app's UI more modern and more user-friendly.
Counterpart of the phone pass (`docs/mobile_pwa_design_plan.md`): same
direction — "one system, calm chrome, colour only for state" — applied to
`src/`.

## Why: what the audit found (develop @ 0f076be6)

- **Type.** 993 `font-size: <n>px` literals vs 290 token uses in
  `src/styles/*.css`; 57 distinct sizes. 11 px is the commonest (347 rules),
  then 12 (317) and 10 (171); `--text-base` (13) is used 18 times. The UI
  reads small next to VS Code (13) and Slack (15).
- **Spacing.** `--space-1…4` are declared in `themes.css` and used **0** times;
  259 distinct `padding:` values.
- **Colour.** 195 hex + 131 `rgba()` literals outside `themes.css` — the Theme
  Customizer and the seven themes cannot reach them. 151 `box-shadow:` rules
  beside the three `--shadow-*` tokens.
- **Glyphs.** 308 lines in `src/components/**/*.tsx` draw chrome with text
  glyphs (✓ 73 · ✕ 44 · ‹› 73 · ● 28 · ✎ 18 · ✉ 17 · ⟳ 16 · ▶ 16 · ⠿ 15 ·
  ⎇ 12 · ⚙ 11 · ☑ 11 · 🗓 9 · 🧠 8 · ⋯ 8 · ◷ ▭ 14) while
  `src/components/common/icons/Icon.tsx` already holds 75 stroke icons
  (the phone pass added Close/More/Plus/Chevrons/Branch/Diff/Grip/Diamond/
  Question/Stop). Each OS renders the glyphs from its own symbol or emoji
  font: different weight, baseline and — for the two emoji — colour.
- **Chrome.** The header decrowding (memory: status cluster, 2026-08-31) left
  four items open: the always-on "VPN"/"Machines" text labels, the three
  CPU/RAM/GPU digit rows, width-tiered folding, and the clock placement.
  Active project pills and tabs still carry two side "3D" shadows plus the
  accent line plus a wash — three signals for one state.
- **Finding things.** Four separate searches: Quick open (files only,
  `components/files/QuickOpen.tsx`), the settings search
  (`layout/settingsSearch.ts`), the project strip's filter, and the tab hover
  cards. No command palette; actions are reachable only through menus or the
  keyboard overlay (`layout/ShortcutHelpOverlay.tsx`).
- **Empty and loading states.** An empty subwindow shows one `+` with
  `.empty-hint`; the first-run guide (`layout/HowToStart.tsx`) is a separate
  overlay. Panels that load (project list, remote file tree, machines) show
  nothing until data arrives; no skeleton class exists in `src/styles`.
- **Motion and focus.** 60 `@keyframes`, 127 transitions, `prefers-reduced-motion`
  handled in 22 scattered rules (none global), 68 `:focus-visible` rules
  with no shared ring token; `--focus*` is undeclared.
- Already right, keep: the seven-theme token architecture
  (`themes.css`, derived accents, Customizer), the two canonical menu
  families and the framed scrolling dialog (memory: unified menu layout),
  the settings design system (`layout/settingsUi.tsx` + `settings-chrome.css`),
  `TooltipHost` replacing native `title` hints, rebindable keys
  (`lib/shortcuts/`), the agent-status stroke language (dotted = working,
  solid = done, amber = waiting), the Reader's cut corners.

## Fixed decisions (user, 2026-11-01)

- **All seven proposals** A–G are in: A one system · B one icon set · C calmer
  chrome · D command palette · E start-here + skeletons · F one floating
  recipe + motion · G focus ring + keyboard.
- **Type scale: 13 px body, 12 secondary, 11 meta, 10 badges only.**
  `--text-base` 13 becomes the default body size (set on `.app-shell`, not
  `:root`, so popouts and the splash follow but `index.html`'s pre-paint does
  not change); `--text-md` 12 for tab labels, chips, table cells;
  `--text-sm` 11 for meta, section heads, timestamps; `--text-xs` 10 for
  count badges only. Add `--text-xl: 18px` for dialog and page titles. The
  terminal keeps its own `--code-font-size` setting; the chat transcript
  keeps `--text-base`. Control heights settle on 24 / 28 / 32, rows on
  26 / 32 / 36; the header stays 44, the tab bar 34 (2 + 30 + 1 + 1).
- **Cut corners on floating surfaces only** — menus, dialogs, hover cards,
  toasts, the palette — by one `clip-path` on the shared popover-surface
  rule (`projects-tabs.css:2441` group) and the shared dialog rule
  (`apps.css:798` group), 10 px cut (the Reader's), top-left and
  bottom-right like the phone's `--oct-md`. The window chrome (header, tab
  bars, side panel, pills, tabs, buttons, fields) **stays square**:
  `--radius*` tokens unchanged. The accent top rail stays; it starts after
  the cut. Glass themes keep their translucent fill — the clip is on the
  element, the wash stays a `::before`.
- **Chrome signals: one per state.** The active project pill and the active
  tab keep the accent/kind line plus the wash and **lose the side shadows**
  (`.project-pill.active`, `.tab.active`, `projects-tabs.css`). A category
  colour stays the inset bottom stripe. Nothing else changes in the
  stroke language.
- **Header, closing the four open items:** the VPN and Machines members show
  an icon + lamp, their text labels move into their menus; CPU/RAM/GPU fold
  into one meter glyph (`AppResourceDisplay`) whose hover card shows the
  three rows; the cluster degrades by width (fold apps' badges → fold the
  clock → collapse the cluster), driven by a `ResizeObserver` on
  `.app-header`, never by a media query (the window is resizable, the
  popouts are narrow). The clock stays where it is (item #6 closed as
  "keep").
- **Command palette = Ctrl+K** (rebindable in `lib/shortcuts/shortcuts.ts`;
  macOS Cmd+K). Quick open (files) becomes the `#` filter of the palette and
  keeps its own shortcut as an alias that opens the palette pre-filtered.
  Groups in order: Tabs · Projects · Files in <project> · Actions ·
  Settings. The settings group reuses `settingsSearch.ts`'s scorer and
  `revealSetting`; actions reuse the shortcut registry's action list so
  their keys display from one source. Enter opens, Ctrl+Enter opens in a
  new subwindow, Esc closes. No agent/LLM in the palette.
- **Start-here** is the empty subwindow's own content (`PaneSlot`/
  `CenterPanel` render it when `tabs.length === 0`), three starts (Agent ·
  Shell · File) with their live shortcuts, a "last time here" line from the
  session store when the project has a resumable agent tab, and the three
  links (tour, shortcuts, help). `HowToStart` keeps its fresh-install
  takeover but is otherwise reached from the "tour" link, no longer an
  overlay the user must dismiss.
- **Skeletons:** one `.skeleton-row` rule (static blocks in `--border-subtle`,
  opacity pulse 1.2 s, off under reduced motion), one `role="status"`
  announcement per loading surface; used by the project list
  (`ProjectSwitcher`), the file tree (`files/*` remote wait), the machines
  menu and the mail list. Never a spinner where rows will appear.
- **Floating recipe:** `--bg-elevated` + accent top rail + `--shadow-2`
  (popovers, hover cards, toasts) / `--shadow-3` (dialogs, palette);
  enter = opacity 0→1 and `translateY(4px)→0` over 120 ms `--ease-out`
  (dialogs 160 ms, backdrop fade only); exit = opacity only, 80 ms; **one
  global** `@media (prefers-reduced-motion: reduce)` block in `base.css`
  that zeroes `--transition`, `--transition-slow` and the enter/exit
  durations, replacing the 22 scattered rules. `transform`/`opacity` only —
  never animate a blurred `box-shadow` (WebKitGTK, AGENTS.md).
- **Focus ring:** `--focus-ring: var(--accent)` on `:root` (the ink themes
  inherit their ink); one rule `:where(button, a, input, select, textarea,
  [tabindex]):focus-visible { outline: 2px solid var(--focus-ring);
  outline-offset: 2px }` in `base.css`; the 68 per-control rules are
  deleted where they only restate it, kept where they place the ring
  inside (tabs, pills, table rows). Esc closes every floating surface
  (shared `useEscapeToClose`, the dialog families already have it).
- **Tokens, not literals,** on every file this pass touches: `--text-*`,
  `--space-*`, `--shadow-*`, `--bg-*`, `--border-*`, `color-mix()` of
  tokens. A literal survives only when it is a brand colour
  (`lib/theme/gitColors.ts`, the xterm palettes) or already named in
  `themes.css`. No new tokens beyond `--text-xl`, `--focus-ring`,
  `--space-6/8` (24/32) and `--motion-enter/--motion-exit`.
- **Buttons:** four classes — `btn-primary`, `settings-btn` (default),
  a new `btn-quiet` (borderless, text-secondary → text-primary on hover),
  `btn-danger`. The 40 per-feature `*-btn` classes become one of these plus
  a feature modifier only where they differ in size (`toolbar-btn--sm`
  pattern). Rename by `rg` across `src/components` and the tests that query
  by class.
- **Out of scope:** the viewers' interiors (`viewers.css` 6.9 k lines —
  only their chrome rows take the tokens), the terminal (`TerminalView`
  theme palettes), mail/calendar/to-do interiors beyond edge and surface
  tokens, the onboarding tour's content, any theme's hues, the phone PWA.
- Nothing in this plan removes a control or changes what a key does;
  shortcuts only gain the palette.

## Steps

Order: tokens first (everything after reads them), then the icon set (every
chrome change after draws from it), then chrome, surfaces, the palette, the
empty/loading states, focus. Each step is one commit; each commit passes the
gates it touches.

1. **A · Tokens.** `src/styles/themes.css`: add `--text-xl`, `--space-6`,
   `--space-8`, `--focus-ring`, `--motion-enter`, `--motion-exit`;
   `.app-shell { font-size: var(--text-base) }`. Migrate literals in this
   order, one file per commit, each with `npm run build` + the CSS invariant
   tests (`src/__tests__/cssCorpus.ts` consumers): `base.css`, `shell.css`,
   `projects-tabs.css`, `subwindows.css`, `header-menus.css`, `apps.css`,
   `settings-chrome.css`, `files-panel.css`, `file-tree.css`, then
   `monitoring.css`, `onboarding.css`, `mail-todo.css`, `calendar.css`,
   `stats-deck.css`, `browser-print-tex.css`, `viewers.css` (chrome rows only).
   Mapping: 9–10 → `--text-xs`, 11 → `--text-sm`, 12 → `--text-md`,
   13 → `--text-base`, 14–15 → `--text-lg`, 16–20 → `--text-xl`;
   half-px sizes round to the scale; 4/8/12/16/24/32 paddings → `--space-*`;
   `rgba(0,0,0,…)` shadows → `--shadow-1/2/3`; hex surfaces → the nearest
   `--bg-*`/`--border-*`/`--text-*` or a `color-mix()` of them. Update the
   HOW TO ADD A THEME comment. Theme Customizer catalogue
   (`lib/theme/themeTokens.ts`) gains `--focus-ring` with its example key
   (five languages, invariant test).
2. **B · Icons.** `Icon.tsx` gains what the mapping board needs and the set
   lacks: `Refresh`, `Brain`, `Grid`, `Meter`, `Minus`, `Window`;
   `header/HeaderGlyphs.tsx` and `header/appIcons.tsx` re-export from it (the
   phone's `glyphs.tsx` pattern). Replace sites by glyph, one commit per glyph
   family: ✕ (`dialog-close-btn` sites, `TabBar` close), ✓, ‹ ›, ●
   (status marks → the existing square mark component where the stroke
   language applies), ✎, ✉ 🗓 ☑ 🧠 ▦ ⚙ (header), ⟳ ▶ ⠿ ⎇ ⋯ ◷ ▭. Keep text
   where a test reads it as text (`⎇ label` in `AgentModeMarks`,
   `■ Interrupted`) and inside content. ESLint: a `no-restricted-syntax`
   rule in `eslint.config.js` flagging the glyph set in JSX text under
   `src/components/**` except an allowlist, so the sites do not grow back.
3. **C · Chrome.** `projects-tabs.css`: drop the side shadows on
   `.project-pill.active` and `.tab.active` (keep line + wash + weight).
   `header/VpnIndicator.tsx`, `header/MachinesIndicator.tsx`: icon + lamp in
   the bar, label inside the menu. `header/AppResourceDisplay.tsx`: one meter
   glyph, tone from the worst of the three, hover card with the rows (reuse
   the hover-card surface). `header/StatusCluster.tsx` + `lib/headerPins.ts`:
   width tiers from a `ResizeObserver` on `.app-header` (`HeaderBar.tsx`),
   persisted nowhere. `stores/headerStatus.ts` unchanged. Settings → Layout
   → Header gains nothing new (tiers are automatic).
4. **F · Floating surfaces + motion.** `projects-tabs.css:2441` popover group
   and `apps.css:798` dialog group: the cut-corner `clip-path`, `--shadow-2`
   / `--shadow-3`, the enter/exit motion via one `.is-entering`/`.is-leaving`
   pair applied by `ContextMenuPortal`, `Dropdown`, `PromptDialogs`, the
   `.modal-backdrop` host and `TooltipHost`'s card; toasts (`HintHost`,
   `ErrorNote`) join the popover group (all FOUR lists — surface, `::before`
   wash, glass blur, glass fill — per the unified-menu rule). Delete the 151
   per-surface shadows these groups now cover. `base.css`: the one global
   reduced-motion block; remove the 22 local ones it subsumes.
5. **D · Command palette.** New `components/layout/CommandPalette.tsx` +
   `styles/header-menus.css` rules on the dialog surface: input, grouped
   results, footer keys. Sources: tabs from the tab store (all subwindows,
   all projects, status mark + "waiting for you"), projects from the
   projects store, files from `QuickOpen`'s index (extract its indexer into
   `lib/files/quickOpenIndex.ts`; `QuickOpen.tsx` becomes a thin opener of
   the palette with the `#` filter), actions from the shortcut registry
   (`lib/shortcuts/shortcuts.ts` — give each action a label key and a
   `run()`), settings from `settingsSearch.ts` + `revealSetting`. Scoring:
   `lib/fuzzy.ts`. Shortcut `Ctrl+K` registered in the registry (shown in
   `ShortcutHelpOverlay`); the `+` menu and the header gear gain a "Search
   everything… Ctrl+K" row. Mounted once in `AppShell.tsx` beside `QuickOpen`;
   popouts (`DetachedApp.tsx`) get it too, scoped to their own tabs.
   `services::command_class`: no backend change (all sources are already in
   the renderer).
6. **E · Start-here + skeletons.** `PaneSlot.tsx`/`CenterPanel.tsx`: the
   empty-subwindow content (`components/layout/StartHere.tsx`), reading the
   shortcut registry for the three keys and the session store for the
   "last time" line; `TabBar.tsx` keeps `.empty-hint` on the `+`.
   `AppShell.tsx`: `HowToStart` opens from the tour link; the
   fresh-install takeover path unchanged. `base.css`: `.skeleton-row`;
   apply in `ProjectSwitcher.tsx` (projects loading), the file tree's
   remote-wait state (`files-panel.css` host), `MachinesIndicator.tsx`,
   the mail list. Each surface keeps exactly one `role="status"`.
7. **G · Focus + keyboard.** `base.css`: the shared `:focus-visible` rule;
   prune the 68 local ones. `lib/useEscapeToClose.ts` (new, or the existing
   dialog hook generalised) on every popover member of step 4.
   `ShortcutHelpOverlay.tsx`: group by area, mark rebindable keys, add
   Ctrl+K. Tab order audit of the header (apps → cluster → clock → controls)
   and the tab bar (tabs → + → files/hide/close).
8. **Register, strings, docs.** `src/lib/untested.ts` rows: `desktop.type.scale`,
   `desktop.icons.set`, `desktop.header.meter`, `desktop.header.tiers`,
   `desktop.surfaces.corners`, `desktop.surfaces.motion`, `desktop.palette`,
   `desktop.startHere`, `desktop.skeletons`, `desktop.focusRing`. i18n keys
   in all five dictionaries (`src/lib/i18n/{en,de,es,fr,it}.ts`, parity
   test). `docs/filemap_frontend.md`: one row each for `CommandPalette.tsx`,
   `StartHere.tsx`, `quickOpenIndex.ts`; update the `QuickOpen.tsx`,
   `StatusCluster.tsx`, `AppResourceDisplay.tsx` rows. `docs/context/`: a
   short `desktop_ui_system.md` naming the scale, the four button classes,
   the floating recipe and the glyph rule (so the next agent does not
   reinvent them).

## Verification

Gates per step: `npm run build`, `npm test`, `npm run lint`,
`scripts/brand-check.sh`; no new `any`, no new lint warnings. The CSS
invariant tests (`src/__tests__/cssCorpus.ts` consumers) run on every CSS
commit; add one asserting no `font-size: <n>px` outside the allowlist
(`viewers.css` interiors, xterm) once step 1 is through, and one asserting
the glyph set is absent from `src/components/**` JSX text outside the
allowlist (step 2). Popouts: open a detached window after steps 4–5 and
check the palette and the surfaces there (they share `styles/index.css`).

Live, after a dev build (`src/` hot-reloads, but the user runs the frozen
dev build): walk the seven themes once each — Settings → Appearance → each
theme — looking at the header, a tab bar, the `+` menu, one dialog, the
palette and an empty subwindow; the `UntestedTag` pills name what to check
and `npm run untested -- tested <id>` stamps each once it is.

Risks, stated: the type bump shifts every row height a pixel or two — the
divider-drag maths (`usePaneRects.ts`, `useDividerDrag.ts`) and the tab-strip
scroll chevrons read computed heights, not literals, but the terminal's fit
addon re-measures on font-size change and should be watched; the cut-corner
clip on a scrolling dialog needs the `dialog-framed` split (the frame clips,
`.dialog-scroll` scrolls) or the corners show scrollbar; the glass themes'
`backdrop-filter` plus `clip-path` on the same element is untested on
WebKitGTK — if the blur drops, move the clip to the `::before` wash and the
outline to an inset `box-shadow`.

## As built (2026-11-02)

Where the code differs from the plan above, and why:

- **Cut corners are painted, not a `clip-path`.** A clip takes the elevation
  shadow off (the Reader's bubbles hit the same thing) and cuts whatever hangs
  outside a surface. The surfaces paint a 135° hard-stop gradient instead.
- **Rounded since 2026-11-02.** After seeing the pass in the dev build the user
  rejected the cut corners ("the edgy everywhere"): the recipe now rounds on
  `--radius` / `--radius-lg`, the radius tokens are 6 / 10 / 14 px instead of
  0, and the Reader's plain-theme bubbles are rounded like the other themes'.
  The painted cut and `--shadow-2-drop` are gone. Design: canvas "Rounded
  Theme" (2026-11-02).
- **10 px goes to badges only** needed a second pass: the step-1 mapping keeps
  every 10 px rule at `--text-xs`, so 245 non-badge rules moved up to 11.
- **`.is-entering` is not a class:** entry is a CSS animation on the surface
  rule. `.is-leaving` exists, on `ContextMenuPortal` only; `Dropdown`,
  `PromptDialogs`, `.modal-backdrop` hosts and tooltips unmount at once.
- **`ErrorNote` is not a toast** (it renders in its host's flow), so the
  toasts in the recipe are `HintBubble` and `.project-switch-toast`.
- **Reduced motion:** the 22 `@media` blocks became 14, one of them the global
  block. The 13 left do more than stop (a static tint, a finished bar, a fade).
- **Focus rules:** 68 became 58. Only the ones that restated the ring went;
  the others place it inside or draw their own, and any accent ring among them
  now reads `--focus-ring`. Tabs stay out of the Tab order, as before: moving
  between them is steering mode's job.
- **`VpnIndicator` and `MachinesIndicator`** already showed icon + lamp, so
  that part of step C was done before the pass.
- **The palette's Ctrl+K** yields to a focused field or terminal (kill-line,
  make-link), since nothing in this plan changes what a key does. Ctrl+P works
  from anywhere but a focused PDF.
- **Not done:** folding the ~90 per-feature `*-btn` classes into the four
  buttons. The plan fixes the decision but gives it no step; `.btn-quiet` exists
  and is used by new chrome. Also the `AlarmPopup` stays without Escape, since a
  document-wide Esc would silently dismiss a reminder.

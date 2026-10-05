# UI Unification Plan — 2026-09-16

The desktop frontend (`src/styles/*.css`, `src/components/**`) has a well-designed
token layer and a real set of shared primitives, but adoption is uneven: the
vocabulary exists, the call sites often re-spell it. This document is the work
plan for closing that gap without redesigning anything.

Scope: `src/styles/**` and `src/components/**` (plus `src/lib` helpers they use).
Out of scope for this strand: `src-tauri/`, `mobile-web/`, `src/lib/i18n*`. **No
new user-facing strings** — every item below is a rename, a merge, a deletion or
a token swap, never new copy.

Every finding here was re-checked against the code at `develop` (file:line as of
2026-09-16). Findings from the source audits that did not survive that check are
listed in [§6](#6-audit-findings-dropped) so nobody re-files them.

**Tier 1 landed in full on 2026-09-16 — all 21 items, none skipped.** Gates at
the time of landing: `npm test` 957 files / 10282 tests passed (byte-identical
to the pre-change baseline), `npm run build` green, `git diff --check` clean.
Not verified live — Tabtivity was not started; `src/` hot-reloads, so the user's
open window has it.

**Reviewed 2026-09-16 (second pass).** All 21 items re-read hunk by hunk against
the theme blocks, the `@import` order and the call sites; nothing was reverted.
Re-checked and confirmed: `--radius-full` is declared once (themes.css:128) and
no theme block — `soft_dark` included, which does re-round `--radius-sm/…` —
overrides it, so U-16 is value-identical everywhere; `--text-xs/sm/md/base/lg`
are declared once in the derived `:root` and nothing reads or rewrites them from
JS, so U-17 is too; `--info` is declared in all six theme blocks plus the base,
so U-18's dropped `#4aa3df` fallback was genuinely unreachable. Every deleted
selector was re-grepped across `src/` **and** `mobile-web/src` including
template-literal class building (`yaml-card-d${…}`, `deck-text-${…}`) — all
dead. The four cross-file merges were re-checked for cascade order rather than
just for identical declarations: each moved selector has no competing
equal-specificity rule anywhere, and each merged element carries only the merged
class, so the moves (U-11/U-12 earlier, U-13/U-15 later) change no computed
value. `.toolbar-btn--sm` is the only rule in the corpus setting that button's
geometry — there is no base `.toolbar-btn` rule and no host-scoped one — so
dropping the inline objects in U-20 loses to nothing. No blurred box-shadow is
animated and no portaled dialog lost its `color` (U-19 adds one).

Gates on the **current working tree** (which carries unrelated uncommitted WIP
from other strands, and which moved twice during the review — a mid-review
`tsc` failure and a mid-review test failure both came from another author's
in-flight edit to `src/components/embed/draftSaver.ts` and both vanished when
that file was reverted; neither was ever this strand's):

- `npm run build` — **green** (tsc + both bundles).
- `npm test` — 1429 files / 15389 tests pass. Two files fail, **neither in this
  strand**: `src/__tests__/MobileChatTurns.test.ts`, which is another strand's
  uncommitted Mobile WIP, and one under `.claude/worktrees/`, a sibling
  worktree vitest walks into because its `exclude` covers only `target/**`.
- `npm run lint` — `npx eslint src` is **clean**, as is a targeted run over all
  nine changed components. Repo-wide `npm run lint` reports ~24.8k errors, but
  every one of them is under `.claude/worktrees/**`: the flat config's ignore is
  `dist/**` relative to the repo root, so a sibling worktree's build output gets
  linted. Pre-existing and environmental, not from this batch.
- The CSS-invariant and affected-surface tests were run in-repo explicitly
  (`ThemeVars`, `PdfTextLayerCss`, `NativeEditorMetricsCss`, `CursorPacks`,
  `BoxRendering`, `SidePanelAlertsEveryView`): 86 tests, all passing. Note that
  naming a test path on the vitest CLI also matches the worktree copies, so an
  in-repo run needs `--exclude '**/.claude/**'`.
- `git diff --check` clean.

One cosmetic defect was fixed rather than reverted: `DownloadsSection.tsx`'s
`dl-copy-btn` had its `onClick` left at a mangled indent by the U-20 edit.

Per-item notes (only where something differed from the plan as written):

- **U-19 / U-01 / U-02 / U-04 / U-07 / U-08 / U-09 / U-10 / U-11 / U-12 / U-13 /
  U-14 / U-16 / U-21** — done exactly as filed. U-16 covered all 21 `999px`
  sites; U-02 left `.project-box-member-count` (:555) untouched.
- **U-03** — done. Two further rules went with the dead set because they are
  *scoped* to it and so could never match: `.agent-prompts-row-main
  .agent-prompts-message` / `-session-id` (as filed) and `.agent-prompts-row-main
  .agent-prompts-edit`, which the plan listed as live. `-edit` is a live class
  name but its only rule sat under the dead `-row-main`; `-changed` turns out to
  be a Tauri **event** name, not a class at all. Two comments elsewhere still
  cite `.agent-prompts-file(s)` as a style precedent (:2506, :2830) — prose
  only, left alone.
- **U-05** — done, plus the `> span.local-model-notools-chip` rule nested under
  the dead `-notools-slot` (dead by its ancestor). The live chip rule under
  `.local-model-loaded-badges` (:578) is untouched.
- **U-06** — leftovers removed, but the `--yaml-guide-0..3` block on
  `.yaml-cards` was **kept**: the `-d*` rules were not its only consumers.
  `.yaml-level + .yaml-level` (viewers.css) reads `--yaml-guide-0` for the
  drill's nesting rails, so dropping it would have un-tinted them.
- **U-15** — joined in `apps.css`, which imports *after* `projects-tabs.css`.
  Safe because nothing else declares those six pseudo-elements, so moving the
  menu wash later in the cascade changes no computed value.
- **U-17** — 89 declarations as filed (24 / 38 / 27); `files-panel.css` had one
  fewer `10px` to swap because U-08 had already deleted the rule holding it.
- **U-18** — all five fallbacks dropped. The `var(--border, …)` /
  `var(--mono-font, …)` phantoms were left alone (T2-01 / T2-02).
- **U-20** — `.toolbar-btn--sm` + all 18 call sites; the per-call `marginLeft`
  stays inline. `ProjectFilesPane`'s `autoAll` conditional accent spread is left
  inline as well — that is T2-26, not this item.

---

## 1. The canonical vocabulary

### 1.1 Tokens — all already defined in `src/styles/themes.css`

`themes.css` is the one file that owns tokens. The base block is
`:root, [data-theme="fancy_dark"]` (themes.css:43); the derived block that serves
every theme at once is `:root` (themes.css:622). **Propose a new token only in
those two places**, and only where a scale is genuinely missing.

| Axis | Tokens | Defined | Notes |
|------|--------|---------|-------|
| Type scale | `--text-xs/sm/md/base/lg` = 10/11/12/13/15px | themes.css:640-644 | The five sanctioned sizes. 823 literal px font-sizes still bypass them; `--text-lg` has **0** uses. |
| Spacing | `--space-1..4` = 4/8/12/16px | themes.css:647-650 | **0 uses app-wide.** Real gaps: 6px ×185, 8px ×171, 4px ×128. See T2-22 for the 6px question. |
| Radius | `--radius-sm` / `--radius` / `--radius-lg` = **0px** · `--radius-full` = 999px | themes.css:125-128 | The house style is square; only `--radius-full` curves. `soft_dark` alone re-rounds (4/8/12px, themes.css:602-604). |
| Color | `--bg-main/panel/elevated`, `--text-primary/secondary/muted`, `--accent`, `--success/--warning/--danger/--info`, `--control-bg/-hover-bg/-border`, `--border-color/--border-subtle` | per theme | Derived washes already exist: `--accent-soft` (22%), `--success-soft`/`--warning-soft`/`--danger-soft` (18%), `--pill-hover-bg`, `--pill-active-bg`, `--bg-subheader`. |
| Elevation | `--shadow-1/2/3` | themes.css:134-136 (+ light overrides at 402/475/521) | 1 = resting, 2 = popovers, 3 = dialogs. |
| Motion | `--transition` 140ms · `--transition-slow` 240ms · `--ease-out` | themes.css:139-140, 653 | `--ease-out` has 3 uses. |
| Layers | `--z-hint` 90 · `--z-modal` 100 · `--z-modal-elevated` 110 · `--z-menu-catcher` 999 · `--z-menu` 1000 · `--z-scrollbar` 9990 · `--z-tooltip` 10000 | themes.css:662-676 | Only 11 rules read them; 40+ literals ignore the contract. |
| Fonts | `--font-sans`, `--font-mono` | themes.css:144-147 | |

**Proposed new tokens** (only these three; each fills a hole the corpus proves
exists, and each goes in `themes.css`):

- `--scrim: rgba(0,0,0,0.35)` — the modal backdrop fill, currently a literal at
  `apps.css:864` and re-spelled in `QuickOpen.css:11`.
- `--menu-wash: 0.32` — the accent-wash opacity that defines every popover and
  dialog tint, currently the literal `0.32` written twice (`apps.css:914`,
  `projects-tabs.css:1989`).
- `--editor-mark: #58a6ff` — the deliberately theme-independent editor overlay
  blue, currently six hand-spelled `rgba(88,166,255,·)` alphas.

Do **not** add a `--radius-xs`, and do not add a 6px spacing step without the
user's decision (T2-22).

### 1.2 Shared classes and components

Prefer these over anything new. The rule is *copy the working sibling*: unify
toward the entry in the right column, never invent a parallel treatment.

| Concept | Canonical | Where |
|---|---|---|
| Dialog surface | `.project-dialog` / `.settings-dialog` / `.stats-dialog` (+ `.dialog-framed` when it scrolls) | apps.css:883, 979 |
| Dialog header / close | `.settings-title-row` + its `h2` + `.dialog-close-btn` | apps.css:1004, shell.css:257 |
| Dialog footer | `.dialog-actions` (with `.project-dialog-actions`, `.mail-dialog-actions`, `.folder-picker-actions` as **deliberate** aliases) | header-menus.css:9-23 |
| Popover / menu surface | `.context-menu` / `.tab-new-menu` / `.project-switcher-add-menu` (accent top rail + `::before` wash, **no** 1px frame) | projects-tabs.css:1966-1998 |
| Menu row | `.tab-new-menu-item` (+ `.tab-new-menu-dot`) | projects-tabs.css:2094, 2124 |
| Menu portal | `common/ContextMenuPortal` — owns catcher, clamping and layering; call sites pass **no** z-index | ContextMenuPortal.tsx:5-24 |
| Button | `.settings-btn` + `.sm` / `.icon` / `.primary` / `.danger`; `.btn-primary` / `.btn-danger` for CTAs (`.btn-block` is a documented dormant API — keep) | settings-chrome.css:24-122, 3306-3356 |
| Field | `.project-dialog input/select/textarea`, `.menu-form input/…` — h34, `--control-bg`, `--control-border`, `--radius-sm`, padding 0 8px | settings-chrome.css:1755-1766 |
| Settings-shaped section | `layout/settingsUi.tsx` — `SettingsSection` / `SettingsCard` / `SettingRow` / `ToggleRow` | src/CLAUDE.md |
| Prompts / confirms | `common/PromptDialogs` → `useDialogs()` | PromptDialogs.tsx:10-27 |
| Select | `common/Dropdown` (+ `.dropdown-block`) — a native `<select>` popup is unstyleable under WebKitGTK | Dropdown.tsx:6-13 |
| Boolean option | `common/Toggle` (`.eld-switch`) | Toggle.tsx |
| Spinner | `common/OrbitSpinner` | OrbitSpinner.tsx |
| Viewer states | `.file-viewer-loading` / `.file-viewer-error` | viewers.css:959-970 |

### 1.3 Standing constraints

- `src/styles/index.css` `@import` order is **load-bearing** — append, never reorder.
  Any cross-file merge must check that nothing later re-declares the moved selector.
- `src/__tests__/cssCorpus.ts` assembles the corpus from those imports; the CSS
  invariant tests (`NativeEditorMetricsCss`, `PdfTextLayerCss`) scan the whole
  thing. Keep them passing; never weaken them.
- Portaled dialogs must set an explicit `color` — `body` has none, so bare text
  falls back to black.
- Never animate a blurred `box-shadow` (WebKitGTK software-renders it): static
  shadow pseudo-element, animate `opacity`.
- Every theme must keep working, including `soft_dark`, `system`, and the Theme
  Customizer's derived accent tokens. Prefer tokens over literals for that reason.
- Keep the documented `!important` blankets (fast-mode/blur at
  projects-tabs.css:1470-1513, the scrollbar baseline at base.css:341/405/409)
  and the xterm.js classes (`.xterm-viewport`, `.xterm-screen`,
  `.xterm-helper-textarea`) — they are third-party markup, not dead code.

---

## 2. Tier 1 — visually neutral

Pixel-identical or sub-pixel. Literal → existing token *with the same value*,
identical duplicate rules merged, verified-dead selectors removed, inline styles
that restate an existing class, explicit `color` on the shared dialog surface.

**Verification for every Tier-1 item** (the "Verify" column names only the
*extra* check): `npm test` (the CSS invariant tests read the whole corpus),
`npm run lint`, `npm run build`, and `git diff --check`. `src/` hot-reloads, so
the user's open window shows the result without a restart — **never** restart
Tabtivity to check.

### 2.1 Dead selectors (all re-verified: zero references in `src/`, including
concatenated class names and the test suite)

| ID | Files | Change | Risk | Verify |
|---|---|---|---|---|
| **U-01** | `styles/projects-tabs.css:1031-1069` | Delete the pre-Settings-dialog theme popover: `.settings-overlay`, `.settings-label`, `.theme-btn` (+ `:hover`/`.selected`). Theme picking lives in SettingsPanel/ThemeCustomizer. | none | Open Settings → theme list unchanged. |
| **U-02** | `styles/projects-tabs.css:638-676` | Delete `.project-box-member-row`, `-open`, `-remove`. Only `.project-box-member-count` is live (BoxScopeChip.tsx:345). | none | `BoxRendering.test.tsx` asserts `-count` only. |
| **U-03** | `styles/projects-tabs.css:~2869-3470` | Delete the 24 dead `.agent-prompts-*` classes left by the #262 rewrite (`row`, `row-main`, `row-actions`, `form`, `grip`, `message`, `queued`, `queued-text`, `scheduled`, `target`, `picker`, `picker-label`, `filters`, `filter-*`, `session`, `session-id`, `sent-head`, `copy`, `file`, `files`, `tags-input`). **Two ride shared lists** — edit the list, do not delete the block: `.agent-prompts-tab, .agent-prompts-row` (:2869) and `.agent-composer-chip, .agent-prompts-copy` (:3305). Live: `-section`, `-view`, `-tab*`, `-sort`, `-notice`, `-edit`, `-rename*`, `-changed`, `-model`, `-last-prompt`, `-tag`, `-tags`. | low (shared lists) | Agents view + prompt chart render unchanged. |
| **U-04** | `styles/settings-chrome.css:1493-1528, 3140-3144, 1062-1064, 3629-3678` | Delete `.project-ending-form` (+ `input`, `:hover/:focus`, `button`, `button:hover`), `.vpn-section-header`, `.settings-link-row-end`, and the whole `.sshfs-install*` family (7 classes — mount-free remote replaced it). Live siblings `.project-ending-list` / `-toggle` stay. | none | Settings → Files endings, VPN section, SSH connect dialog. |
| **U-05** | `styles/header-menus.css:532-546, 1240-1262, 2240` | Delete `.local-model-loaded`, `-idle`, `-row` (live: `-name`, `-badges`), the `.local-model-param-slot` / `.local-model-notools-slot` pair **and their `> span` children** (the live chip is `.local-model-notools-chip`), and `.vpn-indicator-untracked` **from the shared list** at :2240 (`.vpn-indicator-holders` stays). | low (shared list) | Local-model menu + VPN indicator. |
| **U-06** | `styles/viewers.css:1041, 1607-1630, 1666, 1701, 1764-1782` | Delete the YamlGrid-rewrite leftovers: `.yaml-grip-empty`, `.yaml-card-root` (+ the adjacent-sibling rule), `.yaml-card-d0..d5`, `.yaml-card-caret`, `.yaml-card-body`, `.yaml-subcards`, `.yaml-subcards-root`, `.yaml-card-scalar`. Depth tinting now lives on `.yaml-level-card`. **Check the `--yaml-guide-0..3` block on `.yaml-cards` (:1634-1636) once `-d*` is gone** — if nothing else reads it there, it goes too (the `.yaml-tree` copy at :983-985 is the live one). | low | `YamlViewer.test.tsx`; open a YAML file in card view. |
| **U-07** | `styles/apps.css:420-446` · `styles/shell.css:357-363` · `styles/stats-deck.css:479-489` | Delete `.project-switcher-root-btn` (+`:hover`/`.active` — the ★ root pill folded into BoxScopeChip), `.app-version-stack` (live: `.app-version-label`), `.deck-text-line`, `.deck-text-marker`. | none | Project switcher, side-panel footer, Deck. |
| **U-08** | `styles/files-panel.css:1020-1047` | Delete `.project-files-tab-header`, `-name`, `-spacer` and the `.project-files-tab-header .toolbar-btn` rule. `ProjectFilesTab` passes no chrome slots, so it renders no header — **that scoped rule is why the toolbar geometry lives inline everywhere** (see U-20). | none | Files (Project) tab. |
| **U-09** | `styles/mail-todo.css:1456-1475` | Remove `.mail-note-strip` from the three shared selector lists (base, fill, `span`) and delete its own fill rule; `.mail-error-strip` stays. | low (shared lists) | Mail pane error strip still paints. |
| **U-10** | `components/embed/SqliteView.tsx:122` | Remove the `file-viewer-empty` class name — **no such rule exists in any stylesheet**, so it paints nothing today. (Giving it a real state class changes padding → T2-19.) | none | SQLite viewer empty result. |

### 2.2 Identical duplicate rules

Each pair/group below was compared declaration-for-declaration and is
byte-identical. Cross-file merges were checked against the `@import` order: in
every case the moved selector has no other rule anywhere, so the cascade result
is unchanged.

| ID | Files | Change | Risk | Verify |
|---|---|---|---|---|
| **U-11** | `styles/mail-todo.css:19` · `styles/browser-print-tex.css:22, 473, 683` | Four identical 7-declaration pane shells (`.mail-pane`, `.browser-pane`, `.print-pane`, `.skills-pane` — flex column, 100% height, `min-height:0`, `--bg-panel`, `--text-primary`, 13px). Join into one selector list in `mail-todo.css` (the earlier import); leave each file's own layout rules in place. | low | Mail, Browser, Print, Skills panes. |
| **U-12** | `styles/settings-chrome.css:1076-1104` · `styles/onboarding.css:714-742` | `.lesson-item` and `.settings-nav-item` are identical across **all four** rules (base, `:hover`, `-title`, `-blurb`). Join the lists in `settings-chrome.css` (the comment at :1067 already says they are meant to be one style); delete the onboarding copies. | low | Settings sub-panel nav + Lessons list. |
| **U-13** | `styles/viewers.css:5392, 5519` | `.file-viewer-tex-error-jump` and `.file-viewer-tex-warn-jump` are identical 13-declaration blocks. Merge the base into one list; keep the two `:hover` rules separate (warn's is `:hover:not(:disabled)`) and the `-loc`/`-msg` hue rules untouched. | low | TeX log error/warning rows. |
| **U-14** | `styles/files-panel.css:148-177, 1052-1081` | `.side-panel.drop-active::before/::after` and `.project-files-tab.drop-active::before/::after` are identical. Join each into one selector list. **Preserve the `content:"＋ Drop to copy into project"` string exactly** — it is user-facing text and this run adds none. | low | Drag an OS file over the panel and over the Files tab. |
| **U-15** | `styles/apps.css:914` · `styles/projects-tabs.css:1989` | The accent-wash `::before` is declared twice, identically (dialogs and menus). Join into one selector list in `apps.css`. (Promoting the `0.32` to `--menu-wash` is T2-09 — not this item.) | low | Any dialog + any context menu keep their tint. |

### 2.3 Literal → token, same value

| ID | Files | Change | Risk | Verify |
|---|---|---|---|---|
| **U-16** | 11 files, 21 sites | `border-radius: 999px` → `var(--radius-full)` (defined as exactly `999px`, themes.css:128). Sites: mail-todo ×5, projects-tabs ×5 (two inside one-line rules), viewers ×3, browser-print-tex ×3, header-menus, file-tree, files-panel, base, calendar. | none | Pills/chips unchanged in every theme. |
| **U-17** | `styles/apps.css` (24) · `styles/files-panel.css` (38) · `styles/subwindows.css` (27) | Literal `font-size: 10/11/12/13/15px` → `var(--text-xs/sm/md/base/lg)`. The tokens are exactly those five values, so the swap is value-identical. **Scoped to three files (89 declarations) to stay reviewable** — the remaining ~730 follow the same way, file by file, after this batch. | none | Diff should contain no other change. |
| **U-18** | `styles/settings-chrome.css:3557, 3615` · `styles/viewers.css:4082` · `components/tabs/newTabItems.ts:107, 109` | Drop dead fallbacks on always-defined tokens: `var(--text-primary, var(--text))` → `var(--text-primary)`, `var(--text-secondary, var(--text))` → `var(--text-secondary)` (`--text` is a phantom, defined nowhere), `var(--danger, #c33)` → `var(--danger)`, `var(--info, #4aa3df)` → `var(--info)` (`--info` **is** declared in six theme blocks). | none | No computed-style change; the fallbacks were unreachable. |

### 2.4 Inline styles that restate a class, and the dialog `color`

| ID | Files | Change | Risk | Verify |
|---|---|---|---|---|
| **U-19** | `styles/apps.css:883-901` | Add `color: var(--text-primary);` to the shared `.project-dialog, .settings-dialog, .stats-dialog` rule, with the same comment `.stats-dialog` (stats-deck.css:15) and `.file-delete-dialog` (file-tree.css:1855) already carry. **27 dialogs portal onto this surface into `<body>`, which sets no color**, so bare text nodes inherit black today. Leave the existing per-dialog patches in place for now (removing them is T2-13). | low — strictly adds a color where black was inherited | Open a portaled dialog (BoxEditorDialog, ExtendToRemoteDialog, VmSettingsDialog, RemoteConnectDialog, PythonInterpreterWindow, CategoryEditor) in a dark theme. |
| **U-20** | `styles/files-panel.css` (new rule beside `.toolbar-btn.active`, :772) · `components/files/ProjectFilesView.tsx` (11) · `ProjectFilesPane.tsx` (:323 const + :812, :839) · `AlertsSection.tsx` (2) · `DownloadsSection.tsx` (3) | Add a `.toolbar-btn--sm { font-size: 10px; padding: 1px 6px; height: 20px; }` modifier (same suffix style as the existing `.toolbar-btn--flagged`) and replace the 18 copies of `style={{ fontSize: 10, padding: "1px 6px", height: 20, … }}` with it. **Keep the per-call `marginLeft`** (`2`, `auto`, `6`, or `0`) inline — it is the only value that genuinely varies. A *host-scoped* selector (`.side-panel-toolbar .toolbar-btn`) would miss the Alerts/Downloads rows, which is why this is a modifier. | low | Side-panel toolbar, Files tab toolbar, Alerts and Downloads rows keep identical button geometry. |
| **U-21** | `styles/projects-tabs.css:2124` · `components/tabs/TabBar.tsx` (7) · `layout/DetachedCenterPanel.tsx` (2) · `tabs/TabLocalityBadges.tsx` (2) | Add `.tab-new-menu-dot--accent { color: var(--accent); }` and `.tab-new-menu-dot--danger { color: var(--danger); }` beside the existing `.tab-new-menu-dot` rule; replace the 11 inline `style={{ color: "var(--accent)" }}` / `"var(--danger)"` objects. **Leave inline**: `AddTabMenuList.tsx` (per-entry `e.color`, real data) and `LocalModelMenu.tsx`'s `color: "transparent"` spacers (deliberate). | none | Tab context menu glyphs keep their colors. |

---

## 3. Tier 2 — subtle visual change

Snapping near-duplicate values onto the scale, and adopting a shared
menu/dialog/button in a hand-rolled spot. Each changes some pixels; none changes
what a screen *is*. Land them in small batches and let the user look.

| ID | Files | Change | Risk |
|---|---|---|---|
| **T2-01** | header-menus.css ×8, files-panel.css:329 | Phantom `var(--border, …)` → `var(--border-color)`. The fallbacks (`var(--bg-panel)`, `var(--text-secondary)`, `rgba(127,127,127,.3)`) are the *current* design, so borders change tone — this is the bug themes.css:615-621 says was fixed once. | subtle, 9 sites |
| **T2-02** | header-menus.css ×6, settings-chrome.css:3194 | Phantom `var(--mono-font, monospace)` → `var(--font-mono)`, `var(--body-font, sans-serif)` → `var(--font-sans)`. Swaps the generic face for the bundled JetBrains Mono / Inter. | subtle |
| **T2-03** | 12 files, 37 sites | Literal `border-radius: 1px/2px/3px` → `var(--radius-sm)` (**0px**, so corners go square). This is the house style (themes.css:116-124) but it is a visible change; `soft_dark` would round them to 4px. | subtle, wide |
| **T2-04** | apps.css:635-656, projects-tabs.css:959-971, files-panel.css:1171-1175, 1320-1321 | Hardcoded git hues → `var(--danger/--warning/--success/--text-muted)`. `lib/gitColors.ts` **already** does exactly this and a test locks it (`GitStatusColors.test.tsx`); the CSS froze the dark palette for all seven themes. Declare a `--git-*` family in themes.css if the CSS needs its own names. | subtle in dark, visible in light themes |
| **T2-05** | embed/DiffView.tsx:164, embed/SqliteView.tsx:110, 191 | Inline `color: "#f85149"` → `var(--danger)`. Identical in `dark`, different elsewhere. | subtle |
| **T2-06** | viewers.css ×6, file-tree.css:1775 | Six `rgba(88,166,255,·)` alphas → one `--editor-mark` token + `color-mix` alphas. Keep it theme-independent (that is the documented decision); just stop spelling it six ways. | none-to-subtle |
| **T2-07** | apps.css, stats-deck.css, projects-tabs.css, subwindows.css | Literal `rgba(0,0,0,·)` shadows → `var(--shadow-1/2/3)`; `apps.css:864` backdrop → `var(--scrim)`. Light themes override the shadow scale and these literals never followed. | subtle |
| **T2-08** | viewers, file-tree, projects-tabs, header-menus, stats-deck, subwindows, apps, settings-chrome | 40+ z-index literals → the `--z-*` contract. Notably: three hover tooltips at 9999/60 belong at `--z-tooltip`; `.tab-new-menu { z-index: 100 }` (projects-tabs.css:2004) sits at the modal layer while its own portal path uses `--z-menu`. Split the 4px offset into a positioning modifier. | subtle; stacking bugs possible — do it as one reviewed pass |
| **T2-09** | themes.css + 27 mix sites | Accent-mix percentages that re-spell existing tokens → `var(--accent-soft)` (22%), `--pill-active-bg` (16%), `--pill-hover-bg` (12%), `--bg-subheader` (14%); promote the 32% dialog/menu wash to `--menu-wash`. | none-to-subtle |
| **T2-10** | projects-tabs.css:456 + BoxScopeChip.tsx:365 | `.box-chip-menu` declares its own surface (`--bg-elevated` + 1px `--border-subtle` + `--shadow-3`) — no accent rail, no wash — although its own comment claims it wears the switcher's chrome, and the same component uses `.context-menu` for its other popover. Join the canonical list, keep only width/anchoring. | visible on that one menu |
| **T2-11** | calendar.css:1405 | `.date-pop` (the shared DateField popover) uses `--bg-panel` + 1px border + `--shadow-2` — wrong surface, one elevation step low, no rail. Adopt the canonical popover chrome. | visible on that one popover |
| **T2-12** | file-tree.css:1843 | `.file-delete-dialog` restates the dialog chrome by hand and is the one dialog with **no** `::before` accent wash; its `h2` duplicates `.settings-title-row h2`. Join the shared surface + wash list, keep its own sizing. | visible on every PromptDialogs question |
| **T2-13** | settings-chrome.css:2894-2922, header-menus.css:1864, file-tree.css:1856 | After U-19, delete the per-element `color: var(--text-primary) !important` patches that exist only because the shared rule had no `color`. | none |
| **T2-14** | settings-chrome.css:1690 + 6 rows | Replace the 11 `!important` declarations fighting `.project-dialog label { flex-direction: column }` with the `.project-dialog label.<modifier>` specificity pattern the same file already uses twice (:1701, :1730). | none |
| **T2-15** | apps.css:840-857 | `.project-switcher-add-menu button` restyles bare `<button>` (7px 9px, own border) instead of using `.tab-new-menu-item`, and needs `color: … !important` + `-webkit-text-fill-color` against a fancy-theme gradient that onboarding.css:806-826 documents as **removed**. Adopt the row class, drop both overrides. | subtle |
| **T2-16** | apps.css:377, 704 · settings-chrome.css:2866 · projects-tabs.css:2183 · files-panel.css:1642 · header-menus.css:1753, 1806 · subwindows.css:563 | Eight floating surfaces each roll their own chrome (all with the boxed 1px outline the canon deliberately dropped; `.scaffold-popover` sits on `--bg-main`). Adopt the canonical popover surface. | visible, one surface at a time |
| **T2-17** | viewers.css ×4, file-tree.css:1790, header-menus.css:195, projects-tabs.css:845, subwindows.css:563 | Eight hand-rolled hovercards on two surface tokens and four z-layers → one `.hovercard` base (`--bg-elevated`, `--radius-sm`, `--shadow-2`, `--text-sm`, `--z-tooltip`) + per-site modifiers. | subtle |
| **T2-18** | ~40 `*-empty` rules across 8 files, + files/RemarksPane.tsx:72 | One `.empty-note` (muted, `--text-md`) + a padding modifier; feature classes keep positioning only. This also gives RemarksPane's `.empty-state` — which matches **no rule anywhere** — something real to point at. | subtle; paddings currently range 4px→28px |
| **T2-19** | embed/SqliteView.tsx:110-123 | Drop the inline `padding: "1rem"` that overrides `.file-viewer-loading`/`-error`'s own 12px, so the classes actually apply. | subtle (16px → 12px) |
| **T2-20** | browser-print-tex.css:63, 515, 718 · monitoring.css:483 | `.browser-btn` / `.print-btn` / `.skills-btn` are byte-identical to each other and `.du-btn` is the same button on `--control-*`. Adopt `.settings-btn` + `.sm`/`.danger`, which already carries that modifier set. | subtle (padding/radius/token shifts) |
| **T2-21** | settings-chrome.css:24-122 + SettingsSubPanels.tsx (43 uses) | `.ollama-action-btn` is not a button — it is bolted onto six `.settings-btn` selector lists and resolves to `.settings-btn.sm`. Use `settings-btn sm` at the call sites, then drop the alias from all six lists. | none-to-subtle |
| **T2-22** | themes.css + call sites | Decide the spacing scale: `--space-1..4` have **zero** uses while 6px appears 185 times and 3/5/7px 107 times. Either the scale gains a 6px step or those rules migrate to 4/8. **Needs a decision before any code moves.** | subtle, wide |
| **T2-23** | calendar.css:192 · mail-todo.css:1432 | `.cal-input` (h28, `--control-*`, `--radius`) vs `.mail-input` (padding 5px 8px, `--bg-input`/`--border-color`) — two shades and two heights for one field, and `.cal-input` has already leaked into TodoCardDialog and AddRemarkDialog. Unify onto the `.project-dialog input` metrics; keep both names as thin aliases during migration. | subtle |
| **T2-24** | mail-todo.css, browser-print-tex.css, calendar.css, monitoring.css, files-panel.css | Pane toolbars: mail/todo/skills/print are identical (gap 8, 8px 10px, `--border-subtle`); cal and du disagree on gap, padding and border token. One `.pane-toolbar` from the four-way majority; keep the side panel's documented dense row as a commented modifier. Same treatment for the notice strips (`.browser-*-strip` == `.mail-*-strip`) → one `.notice-strip` with `.is-error/.is-warning/.is-note`. | subtle |
| **T2-25** | files/QuickOpen.css · embed/ImageAnnotator.css | Move both into `src/styles` (appended at the **end** of the `@import` order) and drop the dark-theme hex fallbacks (`#1e1e1e`, `#e6e6e6`, `#1c1c1e`, `#3a3a3c`, …). Today they sit outside the corpus `cssCorpus.ts` scans, so **no CSS invariant test can see them**. Check the cascade: they move from JS-injected to bundled. | subtle |
| **T2-26** | files/ProjectFilesPane.tsx:784 | `...(autoAll ? { color: "var(--accent)", borderColor: "var(--accent)" } : {})` → `toolbar-btn active` + `aria-pressed`, matching the view switcher two rows up. `.toolbar-btn.active` also adds the accent wash. | subtle |
| **T2-27** | GitHistory.tsx:810, 824-835, 925-937 · TableView.tsx:692, 721, 748, 999 · FileTree.tsx:276-286 · ProjectFilesView.tsx:1306, 1358 · FileViewerPane.tsx:5782 | Move the remaining repeated inline objects into CSS: the lockstep bar/pill, TableView's two inputs and two `all: unset` buttons, FileTree's git-dot `slot` (→ `.git-step-dot` + a `--dot-color` custom property, matching ProjectFilesView), `.pill-popup-tag`'s `${tag.color}22` hex concat (→ `--tag-color` + `color-mix`), and the preview iframe's literal `background: "#fff"` (→ a stated `--paper-bg`). | subtle |
| **T2-28** | skills, monitoring, common, calendar, onboarding | Six names for one section title → `.settings-section-title` (already used outside Settings by the Agents view). | subtle |

**Tier 2 item count: 28.**

---

## 4. Tier 3 — visible redesign / structural (needs user sign-off)

These change what the user sees or how a control behaves. Do not start one
without the user saying yes to that specific item.

| ID | Files | Change | Why it needs sign-off |
|---|---|---|---|
| **T3-01** | calendar ×4, onboarding ×2, viewers ×2, projects-tabs, subwindows, browser-print-tex, settings-chrome, mail-todo, file-tree | Filled-accent controls put their label in **three** colors: `--bg-main` (the canon, reasoned at settings-chrome.css:3276/3305), `--accent-contrast` (fixed `#ffffff`, which themes.css:108-111 itself calls poor contrast on bright accents), and `--bg-panel`. Unify on `--bg-main`. | A real contrast fix, but it repaints ~15 prominent controls. |
| **T3-02** | files/GitHistory.tsx:154-158, 965, 979 | `LANE_PALETTE` — eight GitHub-dark literals driving the commit-graph lanes, fixed across all themes and every Customizer override → a `--graph-lane-1..8` family. | Changes the look of the commit graph. |
| **T3-03** | 11 files, ~22 sites | Native `<select>` → `common/Dropdown` (+ `.dropdown-block`). A native popup cannot be styled under WebKitGTK and renders as a light OS menu ignoring the theme. | Changes an interaction, not just a skin. |
| **T3-04** | 8 files, ~11 sites | Bare checkboxes for boolean *options* → `common/Toggle`. Multi-select lists (CalDav collections, BigFolderExclude, Box membership, checklist rows) stay checkboxes. | Visible control swap. |
| **T3-05** | 11 files, 17 sites | `window.confirm` / `prompt` / `alert` and `@tauri-apps/plugin-dialog`'s `confirm` → `useDialogs()`. These render as an origin-titled browser alert (PromptDialogs.tsx:10-27) or an OS box — themeless, no validation message, no `UntestedTag`. | Replaces OS dialogs with in-app ones. |
| **T3-06** | mail/, calendar/, todo/, agents/ | Those dialogs are settings-shaped (label + field + toggle + help) but import **zero** primitives from `layout/settingsUi.tsx`. Rebuild on `SettingsSection`/`SettingsCard`/`SettingRow`/`ToggleRow`. | Re-lays-out entire dialogs. |
| **T3-07** | app-wide | 194 button-shaped base rules → `.settings-btn` + modifiers. Radius splits 96 `--radius-sm` / 28 `--radius` / 53 none; font-size splits 11px ×42 / 12px ×40 / 10px ×36. | The single largest visual change available. |
| **T3-08** | app-wide | 96 field-shaped rules, heights 22/24/26/28/34/40px → one `.field` (+ `.field-sm`). | Every form changes height. |
| **T3-09** | app-wide | State the border rule and apply it: `--control-border` for interactive chrome, `--border-subtle` for separators inside a surface, `--border-color` for surface edges (currently 226/168/64 with sibling surfaces disagreeing; in the achromatic themes the two differ by a full tone step). | Repaints borders app-wide. |
| **T3-10** | header/ ×6 + apps.css:300 | The header's dropdowns split across three shells (`tab-new-menu`, `project-switcher-add-menu`, `global-apps-menu`) for one concept; `.tab-new-menu` is simultaneously the tab strip's add-menu. Reduce to one class + positioning modifiers. | Touches every header menu. |
| **T3-11** | tabs/TabBar.tsx ×2, NewTabMenu.tsx, AddTabMenuList.tsx, DetachedCenterPanel.tsx | Five hand-rolled `createPortal` menus with their own fixed positioning and outside-click handling → `common/ContextMenuPortal` (which owns clamping, the right-click catcher and layering). | Changes menu positioning behavior near screen edges. |
| **T3-12** | DetachedCenterPanel.tsx:1924-1945 vs TabBar.tsx:1728-1805 | One shared `tabs/TabContextMenu`. The popout copy renames through `window.prompt`; the main one uses an inline editor — same menu, two behaviors. | Unifies an interaction. |
| **T3-13** | embed/ContextFilePicker.tsx:157-159 + QuickOpen.css | The `qo-backdrop`/`qo-panel`/`qo-context-header` family is a second modal-chrome system parallel to `.modal-backdrop` + `.project-dialog` + `.settings-title-row`. Adopt the canon, keep `.qo-*` for the palette list rows only. | Redraws the picker. |
| **T3-14** | files/AddRemarkDialog.tsx | The dialog renders `modal-card`, `modal-header`, `modal-divider`, `modal-actions`, `p.muted`, `p.error-text` — **none of which exist in any stylesheet**. It is an unstyled box with a bare `<button>×</button>`. Rebuild on `TextPromptDialog` (it is literally a titled prompt + text field + validation + Cancel/Save) or on the `.file-delete-dialog` surface. | It will look entirely different — because right now it looks like nothing. |

**Tier 3 item count: 14.**

---

## 5. The ordered Tier-1 batch

21 items, ordered so each is **independently revertable** — no item depends on
another's result, and no two touch the same lines. Suggested cadence: land
U-19 alone first (highest value, one line), then the dead-code block, then the
merges, then the token swaps, then the inline-style items.

All 21 landed on 2026-09-16; see the per-item notes in the header above.

| # | ID | What | |
|---|---|---|---|
| 1 | **U-19** | `color: var(--text-primary)` on the shared dialog surface | ✅ |
| 2 | **U-01** | projects-tabs: dead theme popover | ✅ |
| 3 | **U-02** | projects-tabs: dead box member rows | ✅ |
| 4 | **U-03** | projects-tabs: 24 dead `.agent-prompts-*` (two shared lists) | ✅ |
| 5 | **U-04** | settings-chrome: dead ending form, VPN header, link-row-end, sshfs family | ✅ |
| 6 | **U-05** | header-menus: dead local-model + VPN members | ✅ |
| 7 | **U-06** | viewers: dead YamlGrid leftovers (guide block kept) | ✅ |
| 8 | **U-07** | apps/shell/stats-deck: dead singletons | ✅ |
| 9 | **U-08** | files-panel: dead Files-tab header trio | ✅ |
| 10 | **U-09** | mail-todo: dead `.mail-note-strip` | ✅ |
| 11 | **U-10** | SqliteView: dead `file-viewer-empty` class name | ✅ |
| 12 | **U-11** | merge four identical pane shells | ✅ |
| 13 | **U-12** | merge `.lesson-item` / `.settings-nav-item` | ✅ |
| 14 | **U-13** | merge the two TeX log jump rules | ✅ |
| 15 | **U-14** | merge the two `drop-active` affordances | ✅ |
| 16 | **U-15** | merge the two accent-wash `::before` rules | ✅ |
| 17 | **U-16** | `999px` → `--radius-full` (21 sites) | ✅ |
| 18 | **U-17** | font-size literals → `--text-*` (apps, files-panel, subwindows) | ✅ |
| 19 | **U-18** | drop unreachable `var()` fallbacks | ✅ |
| 20 | **U-20** | `.toolbar-btn--sm` replaces 18 inline geometry objects | ✅ |
| 21 | **U-21** | `.tab-new-menu-dot--accent/--danger` replace 11 inline colors | ✅ |

After each item: `npm test`, `npm run lint`, `npm run build`, `git diff --check`.
The three CSS-corpus tests (`NativeEditorMetricsCss`, `PdfTextLayerCss`, plus
`GitStatusColors`) were green at 68 passing tests before this plan was written —
that is the baseline to hold.

No backend files are touched, so `npm run backend:stale` is not part of this
strand. `src/` hot-reloads: the user sees each landed item in their open window
immediately, and **Tabtivity must not be started, stopped or restarted** to check.

---

## 6. Audit findings dropped

Re-checked against the code and **not** actionable as filed:

- **`.mail-dialog-actions` is not drift.** header-menus.css:9-23 declares it in
  one rule with `.dialog-actions`, `.project-dialog-actions` and
  `.folder-picker-actions`, with a comment stating the aliases are deliberate
  because each scopes its own button chrome that a rename would detach. Left alone.
- **"`.file-viewer-empty` already gives padding and color."** It does not — the
  class has **no rule anywhere**. Only `.file-viewer-loading`/`.file-viewer-error`
  exist (viewers.css:959-970). Re-filed as U-10 (drop the dead name) + T2-19.
- **"files-panel.css:1042 already declares the toolbar-button geometry."** That
  rule is scoped to `.project-files-tab-header`, which is itself dead (U-08), so
  it matches nothing. There is **no base `.toolbar-btn` rule at all** — the class
  gets only `font: inherit` from shell.css:19 plus the `.active`/`--flagged`
  modifiers. Hence U-20 adds a modifier rather than "re-using" a rule.
- **"`--info` has zero uses."** It is declared in six theme blocks *and* read
  twice from `components/tabs/newTabItems.ts` with a redundant `#4aa3df`
  fallback. Kept, fallback dropped in U-18.
- **"`--text-lg`, `--space-1..4` are dead tokens — consider dropping."** True on
  usage (0 each) but they are the documented scale new rules must read. Keep;
  the real item is adoption (U-17, T2-22).
- **`.btn-block`** has no call site but is a documented part of the CTA API
  (settings-chrome.css:3306). Keep.
- **`.xterm-viewport` / `.xterm-screen` / `.xterm-helper-textarea`** look
  unreferenced but are xterm.js's own markup. Keep — and this note is the record
  so the next audit does not re-flag them.
- **"Replace the repeated flex idioms with Tailwind utilities."** Not filed as an
  item: it would put layout in `className` strings for rules that currently live
  in the stylesheet, against the house pattern. If it is ever wanted, it is a
  Tier 3 decision, not a cleanup.

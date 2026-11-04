# The desktop UI system

What the desktop pass (`docs/desktop_ui_plan.md`, 2026-11-01) settled, so the
next change reads it instead of reinventing it. The phone has its own sheet
(`docs/mobile_pwa_design_plan.md`) in the same direction: one system, calm
chrome, colour only for state.

## Type

Every UI size reads a token (`src/styles/themes.css`), checked by
`theme/TypeScale.test.ts`; `viewers.css` interiors size their own content.

| Token | px | For |
| --- | --- | --- |
| `--text-xs` | 10 | Count badges, kbd caps and drawn marks only |
| `--text-sm` | 11 | Meta, section heads, timestamps |
| `--text-md` | 12 | Tab labels, chips, table cells, menu rows |
| `--text-base` | 13 | Body (`.app-shell`), the chat transcript |
| `--text-lg` | 15 | Sub-titles, the palette's input |
| `--text-xl` | 18 | Dialog and page titles |

The terminal keeps `--code-font-size`. Literals left on purpose: 7 and 8 px
marks, 21 and 32 px hero numbers.

## Space and colour

`--space-1…4`, `--space-6`, `--space-8` are the 4 px grid. Colours are
`--bg-*`, `--border-*`, `--text-*`, the status tokens, or a `color-mix()` of
them, so the themes and the Theme Customizer reach them. Git states are tokens
too (`lib/theme/gitColors.ts`). Literals that stay: scrims (`.modal-backdrop`,
`.split-preview`, the tour spotlight), paper and content surfaces (a mail body,
a PDF page), ink on a fixed status fill (`#1c1300` on amber), calendar category
colours, the deck presenter on its black stage, and the viewers' interiors.

**The accent budget** (round 2, 2026-11-04, `docs/desktop_ui_round2_plan.md`).
The accent marks the active pill, tab and view, focus, a selection wash and the
one primary action. It is not a frame, a label colour, a scrollbar or a
header wash. Concretely:
- **Surfaces:** `--bg-main/panel/elevated` step evenly in lightness. A
  floating surface reads `--float-fill`, which the glass pair point at
  `--glass-elevated` and soft_dark at its fourth step.
- **Header:** `--top-frame-wash` is transparent in every theme. The seam is
  the accent at 35–40% (fancy pair) or `--border-subtle` (light_lavender,
  soft_dark), and `--bg-subheader` carries no accent mix.
- **Lines:** `--border-subtle` draws dividers, `--border-color` draws fields
  and frames. Neither is accent-tinted.
- **Chips:** type tags, branch and worktree chips, the git action buttons and
  the reader's chips are neutral (`--bg-subtle`, no frame at rest). A kind or
  state colour sits on a 6 px lamp, a dot or the glyph.
- **Counts:** header badges are neutral. Red means fresh mail or an overdue
  to-do, and amber means an agent asking.
- **Scrollbar and window controls:** the scrollbar thumb is `--text-muted`
  over the panel, and the window controls are `--text-secondary` until hovered.

## Buttons

`.btn-primary` and `.btn-danger` are the CTAs, `.settings-btn` the default,
`.btn-quiet` the link-weight fourth: no fill at rest, a hover fill, with
`.is-danger` (a destructive row action) and `.is-notable` (news, such as an
update) as modifiers. `.seg` is the one segmented control: a soft track with
the picked option as a lifted chip, marked by the host's `.active`, `.on` or
`.selected`. New buttons take one of these. Most older per-feature `*-btn`
classes are still their own (`docs/desktop_ui_round2_plan.md` says why the
rest need a sizing pass first).

## Floating surfaces

One recipe in `apps.css`: `--bg-elevated`, an accent rail, an accent `::before`
wash, rounded corners from the radius tokens (`--radius` 10 px for menus, hover
cards and toasts, `--radius-lg` 14 px for dialogs and the palette), `--shadow-2`
(popovers, hover cards, toasts) or `--shadow-3` (dialogs, palette). To add a
member, follow the comment at the top of the recipe;
`theme/FloatingRecipe.test.ts` holds the lists together.

The corners were two painted 10 px cuts until 2026-11-02, when the user asked
for round; `--radius-sm/--radius/--radius-lg` went from 0 to 6 / 10 / 14 px on
`:root` at the same time, so buttons and fields soften too. Never a
`clip-path` here: it takes the elevation shadow off and cuts whatever hangs
outside the surface (a submenu).

Enter is opacity plus a 4 px rise over `--motion-enter` (dialogs 4/3 of it, the
backdrop fades only). Exit is opacity over `--motion-exit`, and only
`ContextMenuPortal` holds a surface for it; the others unmount at once. A surface
opens from `opacity: 0`, so it is exempt from the blurred-window animation pause
(`projects-tabs.css`), or it would stay invisible in an unfocused window.

`base.css` holds the one reduced-motion block. It zeroes the tokens, and any
rule whose stand-in is only "stop" goes in its list. A rule whose stand-in is
more than that (a static tint, a finished bar) stays beside its animation.

The motion above is for a GPU. On the CPU paint path, Linux's default,
`lib/window/softwarePaint` sets `data-software-paint` on each window root:
`base.css` zeroes the same two tokens, and `onboarding.css` stops the hint and
tour loops on their peak tint and drops their entries. Measured 2026-11-02 on
WebKitGTK 2.52.6 at 1920x1200, in an offscreen view without the app's DOM (the
real stylesheets, so a floor rather than the app's cost): a menu open took 49 ms
of renderer time with the fade and 15 without, a dialog with its backdrop 182 ms
and 29, at 7.5 frames in 220 ms against 13.5, and a hint's loops held 16–18% of a
core against 0% for as long as the hint stayed up. A new loop or entry that is not
tied to work in progress gets a rule under this attribute.

## Glyphs

Chrome marks come from `common/icons/Icon.tsx`: a text glyph is drawn from
whichever symbol or emoji font the OS has. `GLYPH_SYNTAX` in `eslint.config.js`
and `theme/ChromeGlyphs.test.ts` keep them out of JSX text. An icon-only button
needs its name in `aria-label` or `title`, since the icon is `aria-hidden`. Text
stays inside content, and where a glyph names a choice (the approval strip's ✓).

## Focus and keys

`--focus-ring` (2 px, offset 2) in `base.css`. A component's own focus rule is
for a ring drawn inside, and reads the same token. Escape closes every floating
surface: dialogs through `useModalFocus`, portal menus themselves, hover menus
through `useEscapeToClose`.

The palette's Ctrl+K fires only outside a field or terminal, where the key is
kill-line or make-link. Ctrl+P, its `#` door, works from anywhere except a
focused PDF, which prints with it.

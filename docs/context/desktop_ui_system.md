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

## Buttons

`.btn-primary` and `.btn-danger` are the CTAs, `.settings-btn` the default,
`.btn-quiet` the link-weight fourth. New buttons take one of these. The ~90
older per-feature `*-btn` classes have not been folded in.

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

# Desktop UI round 2 — Plan

Status: step 1 landed (see Progress); steps 2–4 open.

Design: the "Desktop UI round 2" canvas (palette, layout, hygiene, and
light_lavender today vs proposed rebuilt from the user's screenshot of
2026-11-04). The rules that came out of it are in
`docs/context/desktop_ui_system.md` → "The accent budget".

## Fixed decisions (user, 2026-11-04)

- Scope: colour + layout + hygiene; all four themes the user picked
  (fancy_dark, fancy_light, light_lavender, soft_dark). The achromatic
  `dark`/`light` pair is untouched.
- Direction: keep the navy/cyan identity, calmed — not a neutral grey base.
- Layout from the screenshot, judged by me; the user's theme is light_lavender.

## Steps

1. **Tokens and the accent budget** (done):
   - **Palettes:** the four palettes (`themes.css`), solid headers, no
     header wash, a neutral or 35–40% seam, a neutral `--bg-subheader`, and
     `--float-fill` replacing the two glass class lists.
   - **Neutral chrome:**
     - a neutral scrollbar and neutral window controls;
     - neutral type tags (lamp via `--tag-color`), branch and worktree chips,
       and git action buttons;
     - the active `.toolbar-btn` as a wash in ink;
     - neutral header counts (red for fresh or overdue, amber for asking);
     - the reader's view switch and Commit chip in ink.
   - **Reader:** answer bubbles as a card, prompt bubbles as a soft wash,
     10 px; flat composer chips, a focus ring on the composer, facts in sans
     with the frames only on hover.
   - **Search:** a short header search placeholder (all five dictionaries).
   - **Git view:** the worktree row folded into the branch toolbar.
2. **Side panel head, the rest:** the icon action row (↓ ⧉ ⤓ ⚙) joins a row
   that has room. The view tabs fill the panel at the default width, so this
   needs the tabs icon-only below a width, or the actions in the tab row's
   overflow. Open — pick with the user.
3. **Tabs:** the subwindow tab labels sit centred in equal widths. Find the
   rule (not `.tab`) and left-align to content, up to 220 px.
4. **Hygiene:**
   - fold the 95 `*-btn` classes into `.btn-primary` / `.settings-btn` /
     `.btn-quiet` (+ `.is-icon`) / `.btn-danger`, plus one `.seg` for the six
     segmented controls (map on the canvas; read each rule before folding);
   - move the colour literals outside `themes.css`/`viewers.css` to tokens,
     keeping the listed exceptions;
   - buttons on `--radius-sm`.

## Progress

- Step 1: committed on develop (see `git log --grep "desktop UI round 2"`).
  Not run live.

## Verification

`npm run build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`. Live:
the user restarts into the dev build and compares with the canvas (light_lavender
first).

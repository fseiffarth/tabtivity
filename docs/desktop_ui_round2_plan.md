# Desktop UI round 2 — Plan

Status: steps 1–2 and two fold batches landed; step 3 dropped; the rest of the fold needs its own design pass (see Progress).

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
2. **Side panel head, the rest** (done; the user picked "icons on a narrow
   panel"): the two toolbar rows share `.side-panel-toolbars`, a container.
   Below 560 px the view tabs show only their glyph (the name is the tooltip
   and the accessible name) and the action row joins them.
3. **Tabs** (dropped): `.tab` is a `div` sized to its content and no rule
   centres the label. The spacing in the screenshot is likely the close
   button's reserved room. Needs a live look before anything changes.
4. **Hygiene:**
   - fold the 95 `*-btn` classes into `.btn-primary` / `.settings-btn` /
     `.btn-quiet` (+ `.is-icon`) / `.btn-danger`, plus one `.seg` for the six
     segmented controls (map on the canvas; read each rule before folding);
   - move the colour literals outside `themes.css`/`viewers.css` to tokens,
     keeping the listed exceptions;
   - buttons on `--radius-sm`.

## Progress

- Step 1: `7b2e7301`. Not run live.
- Step 2 and fold batches 1–2: committed on develop (see `git log --grep
  "round 2"`). Not run live.
  - **Batch 1:** one `.seg` replaces the skills scope, Ollama filter, stats
    period and activity-year looks.
  - **Batch 2:** `.btn-quiet` gains a hover fill and the `.is-danger` and
    `.is-notable` modifiers, and Ollama's ghost buttons fold into it. Three
    hand-rolled shadows now read `--shadow-1/2`.
- **Not folded, measured 2026-11-04:** the canvas's name-based map does not
  hold for the rest.
  - Several "per-feature" classes are shared bases. `file-viewer-zoom-btn` has
    104 call sites as the viewer toolbar's button, and `toolbar-btn` is the
    side panel's.
  - Others are one-line modifiers on those bases (`vpn-disconnect-btn`), or
    links that are links (`inline-link-btn`, `cal-link-btn`).
  - The next fold is a design pass of its own: settle the viewer-toolbar and
    side-panel button sizes, then rename those bases into one shared toolbar
    button.
- **Colour literals left outside `themes.css`/`viewers.css`:** all in the
  allowed set (the pre-paint splash in `base.css`, scrims, switch knobs, the
  colour wheel, ink on amber, mail paper).

## Verification

`npm run build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`. Live:
the user restarts into the dev build and compares with the canvas (light_lavender
first).

/**
 * The catalog of theme color variables the Theme Customizer may override.
 *
 * It is an ALLOW-LIST, not a convenience: `Settings.ui_theme_vars` is written
 * straight onto the root element's inline style, so an unbounded name/value
 * pair would let a hand-edited settings.json set arbitrary CSS custom
 * properties. Only names listed here, holding a validated hex color, ever
 * reach the document (`stores/settings.normalizeThemeVars`).
 *
 * Every name here must exist in `styles/themes.css` — a token that no theme
 * declares is a knob wired to nothing, and `ThemeTokens.test.ts` fails on one.
 * Tokens are shown by their CSS variable name rather than a prose label: this
 * panel edits the design system directly, and the name IS the identifier the
 * stylesheet (and this repo's theme docs) use. Under it sits an **example** of
 * what that token paints — `themeTokenExampleKey`'s i18n string — because the
 * name says where a value lives in the system and not what moves on screen
 * when it changes, which is the only question somebody at this panel is
 * asking. The GROUP headings still carry the family-level explanation.
 */

export interface ThemeToken {
  /** The CSS custom property, including the leading `--`. */
  name: string;
  /** When `name` may hold a non-color (a gradient in the "fancy" themes), the
   *  token to read instead for the swatch's "current value" preview. */
  probe?: string;
  /** `--accent` is NOT stored in `ui_theme_vars`: it already has its own
   *  cross-theme setting (`ui_accent`, with the derived hover/active/pill
   *  family that rides along). The row is shown here so the customizer covers
   *  the whole palette, but it reads and writes that setting instead. */
  linked?: "accent";
}

export interface ThemeTokenGroup {
  /** Stable id; the i18n keys are `theme.group.<id>` and `theme.group.<id>.help`. */
  id: string;
  tokens: readonly ThemeToken[];
}

export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroup[] = [
  // The accent leads, ahead of the surfaces: it is the one color most people
  // come here to change, and the swatch strip is the fastest thing in the
  // window to try.
  {
    id: "accent",
    tokens: [
      { name: "--accent", linked: "accent" },
      { name: "--accent-hover" },
      { name: "--accent-active" },
      { name: "--accent-secondary" },
      { name: "--accent-soft" },
      { name: "--accent-contrast" },
      { name: "--focus-ring" },
    ],
  },
  {
    id: "surfaces",
    tokens: [
      { name: "--bg-main" },
      { name: "--bg-panel" },
      { name: "--bg-elevated" },
      { name: "--bg-subheader" },
      { name: "--bg-header", probe: "--bg-header-solid" },
      { name: "--bg-header-solid" },
    ],
  },
  // The top frame gets a section of its own for the reason the side panel and
  // the alerts strip do: its look is a composite of tokens that paint half the
  // window besides (--bg-header, --accent twice over), so before these three
  // existed the only way to retone the app's title bar was to move everything
  // it borrows from. `--top-frame-bg` follows --bg-header in most themes and
  // the frosted --glass-header in the two glass ones, which is why the swatch
  // probes the solid twin.
  {
    id: "topframe",
    tokens: [
      { name: "--top-frame-bg", probe: "--bg-header-solid" },
      { name: "--top-frame-wash" },
      { name: "--top-frame-seam" },
      { name: "--top-frame-text" },
      { name: "--top-frame-text-secondary" },
      { name: "--top-frame-text-muted" },
    ],
  },
  // A subwindow's header, on the same footing. Its three text tiers are not a
  // second name for the shared ones: they are remapped for the bar's subtree
  // (projects-tabs.css), which is the only way one knob can reach every rule
  // that paints a tab label, a chip or a chevron — none of which was written
  // to read a subwindow-specific token.
  {
    id: "subwindow",
    tokens: [
      { name: "--subwindow-header-bg" },
      { name: "--subwindow-header-border" },
      { name: "--subwindow-header-text" },
      { name: "--subwindow-header-text-secondary" },
      { name: "--subwindow-header-text-muted" },
      { name: "--subwindow-tab-active" },
      { name: "--subwindow-focus-frame" },
    ],
  },
  // The side panel gets a section of its own rather than three more rows among
  // the surfaces: its tokens each FOLLOW a shared one (--bg-panel,
  // --bg-subheader, --border-color) and exist only so this one panel can be
  // recolored without the surfaces those tokens also paint coming along.
  {
    id: "sidepanel",
    tokens: [
      { name: "--bg-side-panel" },
      { name: "--bg-side-panel-header" },
      { name: "--side-panel-border" },
    ],
  },
  // The Alerts strip under the file tree, likewise: its look is DERIVED from
  // the accent, the ground and the status hues, so without tokens of its own
  // the only way to recolor it is to move everything it borrows from.
  {
    id: "alerts",
    tokens: [
      { name: "--alerts-bg" },
      { name: "--alerts-header-bg" },
      { name: "--alerts-border" },
      { name: "--alerts-overdue" },
      { name: "--alerts-now" },
      { name: "--alerts-soon" },
    ],
  },
  {
    id: "text",
    tokens: [
      { name: "--text-primary" },
      { name: "--text-secondary" },
      { name: "--text-muted" },
    ],
  },
  {
    id: "borders",
    tokens: [{ name: "--border-color" }, { name: "--border-subtle" }],
  },
  {
    id: "controls",
    tokens: [
      { name: "--control-bg" },
      { name: "--control-hover-bg" },
      { name: "--control-border" },
      { name: "--bg-hover" },
      { name: "--bg-subtle" },
      { name: "--bg-inset" },
      { name: "--bg-secondary" },
    ],
  },
  {
    id: "status",
    tokens: [
      { name: "--success" },
      { name: "--warning" },
      { name: "--danger" },
      { name: "--info" },
      { name: "--status-working" },
      { name: "--status-shell-working" },
      { name: "--status-decision" },
      { name: "--status-done" },
    ],
  },
  {
    id: "pills",
    tokens: [
      { name: "--pill-active-bg" },
      { name: "--pill-active-border" },
      { name: "--pill-hover-bg" },
    ],
  },
  {
    id: "window",
    tokens: [
      { name: "--wm-close" },
      { name: "--wm-minimize" },
      { name: "--wm-maximize" },
    ],
  },
  {
    id: "activity",
    tokens: [
      { name: "--activity-0" },
      { name: "--activity-1" },
      { name: "--activity-2" },
      { name: "--activity-3" },
      { name: "--activity-4" },
    ],
  },
  {
    id: "other",
    tokens: [
      { name: "--logo-color" },
      { name: "--helix-orange" },
      { name: "--scrollbar-thumb" },
      { name: "--scrollbar-thumb-hover" },
      { name: "--glass-panel" },
      { name: "--glass-subheader" },
      { name: "--glass-elevated" },
    ],
  },
];

/** The i18n key holding one token's example — what visibly changes when it
 *  does. Derived from the name rather than stored on the entry, so a token
 *  cannot be added to the catalog with its example silently missing:
 *  `ThemeVars.test.ts` checks that every derived key exists in English. */
export function themeTokenExampleKey(name: string): string {
  return `theme.var.${name.slice(2)}`;
}

/** Every catalog token, in panel order. */
export const THEME_TOKENS: readonly ThemeToken[] = THEME_TOKEN_GROUPS.flatMap(
  (g) => g.tokens,
);

/** The names `ui_theme_vars` may carry — the catalog minus the linked ones,
 *  which live in their own setting. */
export const THEME_VAR_NAMES: ReadonlySet<string> = new Set(
  THEME_TOKENS.filter((tk) => !tk.linked).map((tk) => tk.name),
);

/** `#rrggbb` or `#rrggbbaa`. The alpha form matters for the wash tokens
 *  (`--bg-hover`, `--pill-active-bg`, …) whose theme values are translucent —
 *  without it, overriding one would turn a wash into an opaque slab. */
export const THEME_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

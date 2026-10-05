/**
 * A tab's user-set colour (#264): the palette a right-click (desktop) or a
 * ✻ Colour sheet (Tabtivity Mobile) picks from.
 *
 * The palette is a **closed set of named hues**, not a free-form colour, and
 * that is the whole design:
 *
 *  - The id is what is persisted and what crosses the phone boundary, so the
 *    sidecar validates against a list rather than parsing CSS — the same
 *    bargain every other mobile write makes (`clean_tab_label` and friends).
 *  - Both surfaces resolve the id to the *same* hex, so a tab coloured on the
 *    phone reads as the same colour in the window. A free hex would have
 *    drifted the moment one side clamped or widened it.
 *  - The hues are fixed rather than theme tokens (`var(--accent)` and the rest,
 *    which `TAB_ACCENT` uses for tab *kinds*), because a user colour is a
 *    label, not a status: it has to stay tellable-apart under the monochrome
 *    theme, where every semantic token collapses onto white.
 *
 * They are the calendar sidebar's eight (`CALENDAR_COLORS`) — one palette for
 * the app, already legible on the dark chrome and light themes alike.
 */
export const TAB_COLORS = {
  blue: "#4aa3df",
  orange: "#e8663d",
  green: "#59b96a",
  purple: "#c164d6",
  yellow: "#e2b93b",
  red: "#d9556b",
  teal: "#4fc3c3",
  indigo: "#8d8fd6",
} as const;

export type TabColor = keyof typeof TAB_COLORS;

/** Menu/sheet order — the object's own, kept as an array so both surfaces draw
 *  the swatches in one order instead of relying on key iteration. */
export const TAB_COLOR_IDS = Object.keys(TAB_COLORS) as TabColor[];

/** Whether an unknown value (a layout written by a newer build, a phone body)
 *  names a colour in this palette. Everything else reads as "no colour", never
 *  as a CSS value to render. */
export function isTabColor(value: unknown): value is TabColor {
  return typeof value === "string" && value in TAB_COLORS;
}

/** The CSS a stored colour renders as, or `undefined` for an uncoloured tab —
 *  which is what leaves `--tab-accent` on the tab's kind colour. */
export function tabColorCss(value: unknown): string | undefined {
  return isTabColor(value) ? TAB_COLORS[value] : undefined;
}

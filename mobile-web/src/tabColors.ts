import type { TranslationKey } from "../../src/lib/i18n";

/**
 * The tab-colour palette, phone side (#264).
 *
 * A deliberate mirror of `src/lib/theme/tabColors.ts`, not an import: `mobile-web/`
 * is its own bundle with its own tsconfig and ships to a browser, and the two
 * halves share their contract over the wire (a palette id, validated against
 * `protocol::TAB_COLORS` by the sidecar) rather than through a module. What
 * must not drift is the id→hex mapping, so both files carry the same eight
 * hues and the sidecar carries the same eight ids; a colour the desktop does
 * not know never reaches the phone, and one the phone does not know renders as
 * no colour rather than as a guess.
 */
export const TAB_COLORS: Record<string, string> = {
  blue: "#4aa3df",
  orange: "#e8663d",
  green: "#59b96a",
  purple: "#c164d6",
  yellow: "#e2b93b",
  red: "#d9556b",
  teal: "#4fc3c3",
  indigo: "#8d8fd6",
};

/** Sheet order — an array so the swatches draw in one fixed order. */
export const TAB_COLOR_IDS = Object.keys(TAB_COLORS);

/** Palette-name labels for the swatch buttons: the desktop's own colour
 *  names, so both surfaces call a hue the same thing in every language. */
export const TAB_COLOR_LABELS: Record<string, TranslationKey> = {
  blue: "tabColor.blue",
  orange: "tabColor.orange",
  green: "tabColor.green",
  purple: "tabColor.purple",
  yellow: "tabColor.yellow",
  red: "tabColor.red",
  teal: "tabColor.teal",
  indigo: "tabColor.indigo",
};

/** The CSS a published colour renders as, or `undefined` for an uncoloured tab
 *  (and for an id from a newer desktop than this bundle). */
export function tabColorCss(value: string | undefined | null): string | undefined {
  return value && value in TAB_COLORS ? TAB_COLORS[value] : undefined;
}

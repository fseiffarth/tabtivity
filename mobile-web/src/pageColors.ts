// The page colour each theme opens on, as one plain colour: what the browser
// chrome (`theme-color`) and the launch splash (the manifest's
// `background_color`) paint, neither of which can read the theme's tokens.
// Kept apart from `theme.ts` so the build (`vite.mobile.config.ts`) can read it
// to write one manifest per theme.

export const PAGE_COLOR = {
  dark: "#000000",
  fancy_dark: "#04070d",
  soft_dark: "#0c0d10",
  light: "#ffffff",
  fancy_light: "#fbfdff",
  light_lavender: "#fcfbff",
} as const;

export type PaintedTheme = keyof typeof PAGE_COLOR;

/** The manifest whose splash and chrome match `theme`. An installed app reads
 * its splash colour from the manifest, so the page links the one for the theme
 * it paints in, and Chrome re-mints the installed app when that changes. */
export function manifestPath(theme: PaintedTheme): string {
  return `/manifest-${theme}.webmanifest`;
}

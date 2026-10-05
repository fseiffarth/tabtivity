// The phone's theme: one of the desktop's (`themes.css` holds their anchors),
// chosen on the phone and kept there — a phone read in bed and a desk under
// daylight need not share one. Unset, it follows whatever the desktop is set
// to, which `/status` reports and this module caches, so a cold open paints in
// the right theme before the first request answers.

import type { ITheme } from "@xterm/xterm";
import { terminalPalette } from "../../src/lib/terminal/terminalPalette";
import { manifestPath, PAGE_COLOR } from "./pageColors";
import { readChoice, writeChoice } from "./prefs";

/** The desktop's own themes (`src/types` `THEMES`), "system" included. */
export const DESKTOP_THEMES = ["system", "fancy_dark", "soft_dark", "dark", "light", "fancy_light", "light_lavender"] as const;
export type DesktopTheme = (typeof DESKTOP_THEMES)[number];
/** What the phone can be set to: a desktop theme, or "whatever the desktop uses". */
export type PhoneTheme = "desktop" | DesktopTheme;
export const PHONE_THEMES: readonly PhoneTheme[] = ["desktop", ...DESKTOP_THEMES];

/** The desktop's default (`Settings::color_scheme`), for a desktop that has
 * never said what it uses. */
const DESKTOP_DEFAULT: DesktopTheme = "light_lavender";
const DESKTOP_DEFAULT_PAINT = "dark" as const;

const isDesktopTheme = (value: unknown): value is DesktopTheme => typeof value === "string" && (DESKTOP_THEMES as readonly string[]).includes(value);
const isPhoneTheme = (value: unknown): value is PhoneTheme => value === "desktop" || isDesktopTheme(value);

const LIGHT = new Set<string>(["light", "fancy_light", "light_lavender"]);

export function readPhoneTheme(): PhoneTheme {
  return readChoice("theme", isPhoneTheme, "desktop");
}

export function readDesktopTheme(): DesktopTheme {
  return readChoice("desktopTheme", isDesktopTheme, DESKTOP_DEFAULT);
}

/** The OS's light preference, or `null` when it cannot be read. */
function prefersLight(): boolean | null {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ?? null;
  } catch {
    return null;
  }
}

/** The theme to paint and whether it came from "System (follow OS)" — the
 * desktop resolves "system" to Fancy Light or Fancy Dark by the OS preference
 * (Plain Dark when it cannot read one, `stores/settings.resolveTheme`), and
 * the phone does the same with its own OS. */
export function resolvePhoneTheme(choice: PhoneTheme, desktop: DesktopTheme, light: boolean | null): { theme: Exclude<DesktopTheme, "system">; system: boolean } {
  const picked = choice === "desktop" ? desktop : choice;
  if (picked !== "system") return { theme: picked, system: false };
  return { theme: light === null ? DESKTOP_DEFAULT_PAINT : light ? "fancy_light" : "fancy_dark", system: true };
}

let osMedia: MediaQueryList | null = null;

function followOs(on: boolean) {
  try {
    if (on && !osMedia) {
      osMedia = window.matchMedia?.("(prefers-color-scheme: light)") ?? null;
      osMedia?.addEventListener?.("change", applyPhoneTheme);
    } else if (!on && osMedia) {
      osMedia.removeEventListener?.("change", applyPhoneTheme);
      osMedia = null;
    }
  } catch {
    // No matchMedia: "system" stays whatever it resolved to.
  }
}

export function applyPhoneTheme(): void {
  const { theme, system } = resolvePhoneTheme(readPhoneTheme(), readDesktopTheme(), prefersLight());
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  if (system) root.setAttribute("data-theme-pick", "system");
  else root.removeAttribute("data-theme-pick");
  followOs(system);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PAGE_COLOR[theme]);
  // The launch splash is the manifest's, so it follows the theme too.
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", manifestPath(theme));
  // iOS reads this at launch only: a light theme needs dark status-bar text,
  // which the translucent black style cannot give it.
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute("content", LIGHT.has(theme) ? "default" : "black-translucent");
}

export function setPhoneTheme(choice: PhoneTheme): void {
  writeChoice("theme", choice);
  applyPhoneTheme();
}

/** The desktop's theme as `/status` reported it. Repaints only on a change, and
 * only matters while the phone follows the desktop. Anything that is not one
 * of the desktop's themes is ignored rather than cached. */
export function noteDesktopTheme(value: unknown): void {
  if (!isDesktopTheme(value) || value === readDesktopTheme()) return;
  writeChoice("desktopTheme", value);
  applyPhoneTheme();
}

/** The desktop's terminal palette for the theme the phone paints in
 * (`data-theme`; a bare root paints Plain Dark), with the cursor drawn in the
 * background colour: the phone's terminal is output only, and a cursor would
 * make an agent's prompt look like a field to type into. */
export function phoneTerminalTheme(): ITheme {
  const palette = terminalPalette(document.documentElement.getAttribute("data-theme") ?? "dark");
  return { ...palette, cursor: palette.background, cursorAccent: palette.background };
}

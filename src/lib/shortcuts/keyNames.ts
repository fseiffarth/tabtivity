/**
 * Key-name helpers with no imports, shared by the chord table
 * (`shortcuts.ts`), the steering table (`steeringBindings.ts`) and the phone's
 * steering keys (`mobile-web/src/steering/`). Kept free of Tauri, stores and
 * the platform module so the phone bundle can import it.
 */

/** Lone modifier keys that must be ignored while capturing a chord. */
export const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "Super",
  "OS",
  "AltGraph",
  "CapsLock",
]);

/**
 * A keydown's `key`, except that Shift+Tab always reads as "Tab". GTK turns
 * Shift+Tab into the `ISO_Left_Tab` keyval, which WebKitGTK reports as key
 * "Unidentified" with code "Tab" (measured: a GDK key event into an offscreen
 * WebKit2 4.1 view, 2026-11-10; plain Tab and other engines say "Tab").
 * Read Tab through this helper, never `e.key === "Tab"`. Otherwise Shift+Tab
 * is dead on Linux while jsdom tests pass.
 */
export function eventKey(e: Pick<KeyboardEvent, "key"> & { code?: string }): string {
  return e.key === "Unidentified" && e.code === "Tab" ? "Tab" : e.key;
}

/** Whether a keydown is Tab, with or without Shift (see `eventKey`). */
export function isTabKey(e: Pick<KeyboardEvent, "key"> & { code?: string }): boolean {
  return eventKey(e) === "Tab";
}

/** Normalize a `KeyboardEvent.key` for storage/comparison: single printable
 *  letters become lower-case so "W" and "w" match; everything else is kept. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** True when the keystroke is only a modifier (Ctrl/Shift/Alt/Meta) — these
 *  must not be captured as a chord on their own. */
export function isLoneModifier(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

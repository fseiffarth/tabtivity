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

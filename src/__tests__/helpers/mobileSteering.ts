/**
 * Shared helpers for the phone's keyboard-steering tests: real-looking key
 * events (with the `code` a hardware keyboard sends), a stub for the layout
 * calls jsdom lacks, and one reset for the module state a test leaves behind.
 */
import { vi, type Mock } from "vitest";
import { resetBackStackForTests } from "../../../mobile-web/src/backStack";
import { resetSteeringForTests } from "../../../mobile-web/src/steering/steeringState";

export interface KeyMods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** Overrides the derived `code` ("" for an IME that sends none). */
  code?: string;
  keyCode?: number;
}

/** The `code` a US keyboard sends for `key`. */
export function codeFor(key: string): string {
  if (key === " " || key === " ") return "Space";
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const named: Record<string, string> = { ".": "Period", "/": "Slash", ",": "Comma", "+": "Equal", "=": "Equal" };
  return named[key] ?? key;
}

/** Init for a `KeyboardEvent` of `key`, with the right `code`. */
export function keyInit(key: string, mods: KeyMods = {}): KeyboardEventInit {
  return {
    key,
    code: mods.code ?? codeFor(key),
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    repeat: !!mods.repeat,
    isComposing: !!mods.isComposing,
    keyCode: mods.keyCode,
    bubbles: true,
    cancelable: true,
  };
}

/** Fires keydown then keyup of `key` on `target` (default `window`); answers whether the keydown was `defaultPrevented`. */
export function press(target: EventTarget | null, key: string, mods: KeyMods = {}): boolean {
  const at = target ?? window;
  const down = new KeyboardEvent("keydown", keyInit(key, mods));
  at.dispatchEvent(down);
  at.dispatchEvent(new KeyboardEvent("keyup", keyInit(key, { ...mods, repeat: false })));
  return down.defaultPrevented;
}

/** Defines `Element.prototype.scrollIntoView` as a mock; call the returned `restore` after the test. */
export function stubLayout(): { scrollIntoView: Mock; restore: () => void } {
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
  const before = proto.scrollIntoView;
  const scrollIntoView = vi.fn();
  proto.scrollIntoView = scrollIntoView;
  return {
    scrollIntoView,
    restore: () => {
      if (had) proto.scrollIntoView = before;
      else delete proto.scrollIntoView;
    },
  };
}

/** Forgets steering's state, the back stack and the root attributes a test set. */
export function resetSteering(): void {
  resetSteeringForTests();
  resetBackStackForTests();
  document.documentElement.removeAttribute("data-steering");
  document.documentElement.removeAttribute("data-steer-bar");
}

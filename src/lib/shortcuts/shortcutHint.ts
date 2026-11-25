/**
 * Tooltip shortcut hints — "Close tab (Ctrl+W)".
 *
 * A button that a chord also drives should say so on hover, and it should say
 * the chord the user actually has: the rebindable actions live in
 * `settings.keyboard_shortcuts`, so a hardcoded "(Ctrl+W)" in a translated
 * string goes stale the moment someone rebinds it (and is wrong on macOS,
 * where `chordLabel` renders ⌘ glyphs). Everything here resolves through
 * `resolveChord`/`chordLabel` instead, and formats through the one i18n key
 * (`shortcut.hint`) so the parenthesis convention is translatable.
 *
 * Fixed chords the editors handle themselves (Ctrl+S, Ctrl+Z, …) are not in
 * the action table — pass those as a literal `ChordDescriptor` and they are
 * still platform-resolved.
 */
import { useCallback } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../i18n";
import {
  chordLabel,
  chordMatches,
  resolveChord,
  type ChordDescriptor,
  type ShortcutAction,
  type ShortcutMap,
} from "./shortcuts";

/** The user's chord overrides, or undefined while settings are still loading
 *  (every consumer falls back to the built-in defaults). */
export function useShortcutOverrides(): ShortcutMap | undefined {
  return useSettingsStore((s) => s.settings?.keyboard_shortcuts) as ShortcutMap | undefined;
}

/** Resolve a rebindable action outside a shortcut hook. */
export function liveShortcutChord(action: ShortcutAction): ChordDescriptor {
  const overrides = useSettingsStore.getState().settings?.keyboard_shortcuts as ShortcutMap | undefined;
  return resolveChord(action, overrides);
}

/** Format a rebindable action for copy rendered outside a shortcut hook. */
export function liveShortcutLabel(action: ShortcutAction): string {
  return chordLabel(liveShortcutChord(action));
}

/** The panel toggle's key as the user has it — the Super/F9 default for this
 *  desktop (`livePanelToggleKey`) unless rebound — for the copy that names it
 *  (the "panels hidden" toast, the onboarding tips). Read at call time. */
export function livePanelToggleLabel(): string {
  return liveShortcutLabel("togglePanels");
}

/** Whether a keydown is the app's window-fullscreen chord (F11 unless
 *  rebound) — for the windows that toggle their own fullscreen outside
 *  `useKeyboard` (popouts, the presenters). */
export function osFullscreenChord(e: KeyboardEvent): boolean {
  const overrides = useSettingsStore.getState().settings?.keyboard_shortcuts as ShortcutMap | undefined;
  return chordMatches(resolveChord("osFullscreen", overrides), e);
}

/**
 * `hint(label, "closeTab")` → "Close tab (Ctrl+W)". The second argument is
 * either a rebindable action id (resolved against the user's overrides) or a
 * fixed chord descriptor for the keys handled outside the action table.
 */
export function useChordHint(): (
  label: string,
  chord: ShortcutAction | ChordDescriptor,
) => string {
  const t = useT();
  const overrides = useShortcutOverrides();
  return useCallback(
    (label: string, chord: ShortcutAction | ChordDescriptor) =>
      t("shortcut.hint", {
        label,
        chord: chordLabel(typeof chord === "string" ? resolveChord(chord, overrides) : chord),
      }),
    [t, overrides],
  );
}

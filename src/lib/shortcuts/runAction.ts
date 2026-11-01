import { isLoneSuper, isUnbound, resolveChord, type ShortcutAction, type ShortcutMap } from "./shortcuts";

/**
 * Run a shortcut's action from somewhere that is not its key, by pressing its
 * chord: `useKeyboard` and the capture-phase listeners stay the one place each
 * action lives, and a rebound chord still reaches it. An action the user
 * unbound, or bound to a lone Super tap, has no chord to press; that answers
 * false, so the caller can leave it out.
 */
export function runShortcutAction(action: ShortcutAction, overrides: ShortcutMap | null | undefined): boolean {
  const chord = resolveChord(action, overrides);
  if (isUnbound(chord) || isLoneSuper(chord)) return false;
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: chord.key,
      ctrlKey: !!chord.ctrl,
      shiftKey: !!chord.shift,
      altKey: !!chord.alt,
      metaKey: !!chord.meta,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}

/**
 * When the steering chord counts as one, for the one steering handler
 * (`hooks/useSteering`) in every window: the main window and each popout
 * steer themselves. A popout hands steering or a key to the main window over
 * `DETACHED_STEER`, which the main window's host passes on as
 * {@link STEER_FROM_POPOUT}.
 */
import { chordMatches, type ChordDescriptor } from "./shortcuts";
import { normalizeKey } from "./keyNames";

/** A steering chord typed within this long of the last text key is text. */
export const TYPING_BURST_MS = 400;

/** Whether a chord would type a character (no Ctrl / Alt / Meta held). */
export function typesText(chord: ChordDescriptor): boolean {
  return !chord.ctrl && !chord.alt && !chord.meta && normalizeKey(chord.key).length === 1;
}

/** Whether `e` is the steering chord and meant as one. A chord that types text
 *  (the Shift+Space default) is left alone in the middle of a typing burst:
 *  "I am" with the Shift still down from the I is a space, not a request to
 *  steer. While steering is on the chord always counts (it leaves). */
export function steeringChordFires(
  chord: ChordDescriptor,
  e: KeyboardEvent,
  steeringActive: boolean,
  lastTypedAt: number,
): boolean {
  return (
    chordMatches(chord, e) &&
    (steeringActive || !typesText(chord) || e.timeStamp - lastTypedAt > TYPING_BURST_MS)
  );
}

/** Whether a keydown types text, for the typing-burst clock. */
export function isTextKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
}

/** Main window: a popout handed steering or a key over (window `CustomEvent`
 *  whose `detail` is the popout's `DetachedSteerPayload`). */
export const STEER_FROM_POPOUT = "app:steer-from-popout";

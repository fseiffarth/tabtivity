import { writePtyInput } from "../terminal/terminalInput";
import { isDialogNavigationInput, isInterruptInput, noteUserInput } from "../../stores/activity";
import { noteInputFrom } from "./inputFrom";

/** The phone's key pacing for a dialog answer: arrows apart, Enter later. */
const KEY_GAP_MS = 80;
const SUBMIT_GAP_MS = 200;
const ENCODER = new TextEncoder();

/**
 * Type `keys` into the pane as the user's own presses — the Reader's dialog
 * answers and session pickers, steering's prompt box too: each one noted as
 * user input, arrows apart, the last (the Enter) a little later.
 * `stillAsking` reads the pane's live screen (`dialogOnScreen`): given by a
 * caller whose pane is on screen, it keeps the tab's question mark while a
 * dialog stays up after the answer (the next of several questions).
 */
export async function typePaneKeys(ptyId: string, keys: string[], stillAsking?: () => boolean | null): Promise<void> {
  for (let index = 0; index < keys.length; index += 1) {
    const bytes = ENCODER.encode(keys[index]);
    noteUserInput(ptyId, isInterruptInput(keys[index]), { navigate: isDialogNavigationInput(keys[index]), stillAsking });
    noteInputFrom(ptyId, "desktop");
    await writePtyInput(ptyId, bytes);
    if (index + 1 < keys.length) {
      await new Promise((resolve) => setTimeout(resolve, index + 2 === keys.length ? SUBMIT_GAP_MS : KEY_GAP_MS));
    }
  }
}

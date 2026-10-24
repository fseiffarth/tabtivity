import { invoke } from "@tauri-apps/api/core";

/**
 * Where the user typed into a tab from — the screen `tabtivity-send` puts a
 * file on (`agent_turn::note_input_from`, read by the send script as the
 * tab's `<uid>.from` record): "send me the plot" answered on the desktop
 * names the file in the Chat; asked from the phone, it goes to the phone.
 *
 * Only a person's input counts: desktop keystrokes and the Reader's or
 * steering's prompts, the phone's typing and its held prompts. A scheduled
 * prompt or a line Tabtivity types on a tab's behalf says nothing about where
 * the user is, and moves nothing.
 */
export type InputFrom = "phone" | "desktop";

/** The screen last reported per PTY: the backend hears a change of screen,
 *  not every keystroke. */
const reported = new Map<string, InputFrom>();

export function noteInputFrom(ptyId: string, from: InputFrom): void {
  if (reported.get(ptyId) === from) return;
  reported.set(ptyId, from);
  invoke("pty_input_from", { id: ptyId, from }).catch(() => {
    // Not recorded: the next input tries again.
    if (reported.get(ptyId) === from) reported.delete(ptyId);
  });
}

/** A (re)spawned PTY may run under a new uid, whose record is still empty:
 *  its first input reports again. */
export function forgetInputFrom(ptyId: string): void {
  reported.delete(ptyId);
}

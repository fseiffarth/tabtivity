import { terminalFor } from "../terminal/terminalRegistry";
import { AGENT_ITEMS } from "../tabs/newTabItems";
import { readReaderLive } from "./readerLive";

/**
 * Whether `ptyId`'s pane shows a dialog its agent waits on (a question, a
 * permission prompt, the review step of a multi-question ask), read off the
 * live xterm as the Reader reads it; null when the pane has no terminal.
 *
 * The activity store asks this after a keystroke on a decision
 * (`noteUserInput`'s `stillAsking`): Claude repaints by cell diff, so the
 * bytes after an answer never hold a whole dialog, but the screen does. Only
 * for a pane the user is looking at: a hidden pane's xterm is not fed, and
 * its screen would be stale.
 */
export function dialogOnScreen(ptyId: string, agentLabel: string): boolean | null {
  const term = terminalFor(ptyId);
  if (!term) return null;
  return readReaderLive(term.buffer.active, agentLabel, term.cols).question !== null;
}

/** The Reader's label for an agent command (`agentTabLabel` without the tab). */
export function agentLabelOfCmd(cmd: string): string {
  return AGENT_ITEMS.find((item) => item.cmd === cmd)?.label ?? cmd;
}

import { agentFamily } from "../../../shared/agentComposer";
import { agentWork } from "./agentBusy";
import { isCursorTab } from "./cursorAgent";
import { isOpenCodeTab, readOpenCodeNotice } from "./openCodeMini";
import type { ReadableLine } from "./readableScreen";
import { pressHintShown, readCodexHooksPage, readReviewStep, readSelectPrompt, readStrayDialog, type SelectPrompt } from "./selectPrompt";
import { inputFrameStart } from "./statusLine";

/**
 * Whether the rows above the input frame the screen shows cannot be a dialog of
 * this agent's, because the agent hides its input box while one is up.
 *
 * Claude Code does: a permission prompt, its own question, a picker or the
 * review step all replace the box (none of the 537 dialog frames captured from
 * 2.1.318 to 2.1.327 has one). So where a box is on screen, the rows above it
 * are output — an answer whose numbered list leads with `>` or `→` reads as a
 * highlighted dialog row otherwise, and the chat showed a question card where
 * the agent asked nothing.
 *
 * Cursor's too: its approvals, trust page and pickers draw no footer (28
 * frames, 2026.11.22), and its frame is found only with one, so answer text
 * quoting `Run (once) (y)` rows above the box is not a dialog whose `y` the
 * Chat would type into the prompt. The other CLIs keep (or draw) a `›`/`>` box
 * where a dialog sits, and have not been captured the same way. The desktop Reader
 * (`readReaderLive`) and the phone (`readLiveQuestion`) both ask this.
 */
export function boxHidesDialog(agentLabel: string | undefined, frameFound: boolean): boolean {
  return frameFound && (agentFamily(agentLabel ?? "") === "claude" || isCursorTab(agentLabel));
}

/**
 * The phone's reading of the choice the session is waiting on — the desktop
 * Reader's (`readReaderLive`) over the phone's own screen rows.
 *
 * `tail` is the screen after the last echoed prompt with the input frame cut
 * off (or Codex's whole hooks page); `screen` is the whole live screen, frame
 * included, which says whether a box is on it.
 */
export function readLiveQuestion(
  tail: readonly ReadableLine[],
  screen: readonly ReadableLine[],
  agentLabel: string,
  columns?: number,
): SelectPrompt | null {
  if (tail.length === 0) return null;
  const hooksPage = readCodexHooksPage(tail, agentLabel);
  if (hooksPage) return hooksPage;
  // A page that names its own keys (`Press enter to save`) holds no input box.
  const noFrame = pressHintShown(screen) || inputFrameStart(screen, agentLabel) >= screen.length;
  if (boxHidesDialog(agentLabel, !noFrame)) return null;
  // OpenCode's notice (`What's new`) takes every key until closed.
  return (isOpenCodeTab(agentLabel) ? readOpenCodeNotice(tail) : null)
    ?? readSelectPrompt(tail, agentLabel, columns) ?? readReviewStep(tail, agentLabel)
    // No input box and no busy row: a first run's own screen (Claude
    // Code's theme picker, a `Press Enter to continue`).
    ?? (noFrame && !agentWork(screen) ? readStrayDialog(tail, columns) : null);
}

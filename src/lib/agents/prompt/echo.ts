import { chatTurns } from "../../../../mobile-web/src/terminal/chatTurns";
import { readableScreen, readableText, type ReadableBufferLike } from "../../../../mobile-web/src/terminal/readableScreen";
import { inputFrameStart } from "../../../../mobile-web/src/terminal/statusLine";
import { antigravityDialogStart, isAntigravityTab } from "../../../../mobile-web/src/terminal/antigravity";
import { foldPrompt } from "./adopt";

/**
 * The last prompt echoed on an agent tab's screen — the fallback for an
 * agent whose transcript Tabtivity cannot read (Gemini, Qwen, Codex since its
 * thread store stopped recording messages, any custom command).
 *
 * Every agent TUI echoes a submitted prompt back into its transcript with
 * its own marker at the left edge (`> …`, `› …`), which is the one shape the
 * phone's Focus chat already reads turns out of (`chatTurns`), off the same
 * rendering of xterm's buffer (`readableScreen`) with the live input box cut
 * away first (`inputFrameStart`) — so a draft still being typed is never
 * taken for a prompt, and a select dialog's `❯ 1. Yes` never is either. The
 * desktop reads its own pane's buffer the same way, and the answer is what
 * that screen shows: the prompt typed into *this* pane, which is the case
 * the transcript route cannot cover for these agents. A pane that is hidden
 * receives no output, so its buffer is the screen it last showed.
 *
 * Antigravity draws its `Switch Model` dialog *under* its input box, rows
 * marked `> ` like an echo, so the screen is cut where that dialog starts
 * (`antigravityDialogStart`) — its highlighted model once named a tab.
 */
export function lastPromptEcho(buffer: ReadableBufferLike, agentLabel?: string): string | undefined {
  const { lines } = readableScreen(buffer);
  const dialog = isAntigravityTab(agentLabel) ? antigravityDialogStart(lines) : -1;
  const shown = dialog >= 0 ? lines.slice(0, dialog) : lines;
  const turns = chatTurns(shown.slice(0, inputFrameStart(shown)));
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "user" || !turn.prompt) continue;
    const text = foldPrompt(readableText(turn.prompt));
    if (text) return text;
  }
  return undefined;
}

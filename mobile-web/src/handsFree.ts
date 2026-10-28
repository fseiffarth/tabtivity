// The Focus composer's hands-free loop on the phone (docs/desktop_voice_plan.md
// step 5): what decides that a turn is over, which question row a spoken
// answer picks, and how a question is read out. The send guard itself is
// shared with the desktop (`shared/handsFree.ts`).

import { matchOption } from "../../shared/voice";
import { freeTextRow, UNNUMBERED, type SelectOption, type SelectPrompt } from "./terminal/selectPrompt";

/** The pause after dictated words before the chime. The desktop's default;
 * the phone has no setting for it. */
export const HANDS_FREE_PAUSE_MS = 1_500;
/** The agent must look idle this long before the mic opens again: its busy
 * row can blink off between two tool calls. */
export const TURN_SETTLE_MS = 1_500;

/**
 * Whether the turn a hands-free send started is over, so the mic may open
 * again. The phone reads the agent's busy row off the live screen
 * (`agentWork`); the turn is over once that was seen and is gone, or once the
 * agent waits on a question, or once a new answer arrived while it looks idle
 * — a turn too quick for its busy row to reach the phone. A wait that only
 * read aloud (a spoken reading command such as "repeat") started no turn:
 * it is over at once, and the mic waits for the voice alone.
 */
export function handsFreeTurnOver(state: {
  reading?: boolean;
  busy: boolean;
  sawWork: boolean;
  question: boolean;
  answerAtSend: string | null;
  answerNow: string | null;
}): boolean {
  if (state.question || state.reading) return true;
  if (state.busy) return false;
  return state.sawWork || (state.answerNow !== null && state.answerNow !== state.answerAtSend);
}

/** The rows a voice can pick: the numbered ones. A free-text row needs typed
 * words, and an unnumbered Submit row is no answer of its own. */
function pickable(prompt: SelectPrompt): SelectOption[] {
  return prompt.options.filter((option) => option.number !== UNNUMBERED && !freeTextRow(option));
}

/** The row `utterance` picks on the question `prompt` — by the number the
 * dialog printed beside it — or `null` when it picks none (`matchOption`). */
export function voicePick(utterance: string, prompt: SelectPrompt): SelectOption | null {
  const rows = pickable(prompt);
  if (rows.length === 0) return null;
  const count = Math.max(...rows.map((option) => option.number));
  const pick = matchOption(utterance, count);
  if (pick === null) return null;
  return rows.find((option) => option.number === pick + 1) ?? null;
}

/** A question as it is read out: its own words, then each pickable row by
 * its number ("1: Yes. 2: No."), so the answer can be said back. */
export function questionSpeech(ask: readonly string[], prompt: SelectPrompt): string {
  const question = ask.map((line) => line.trim()).filter(Boolean).join(" ") || prompt.title?.trim() || "";
  const rows = pickable(prompt).map((option) => `${option.number}: ${option.label.trim()}.`);
  return [question, ...rows].filter(Boolean).join(" ");
}

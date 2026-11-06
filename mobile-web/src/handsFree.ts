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

/** A pick-the-row answer that grants a permission or saves a rule: the dialog
 * words that say so (Claude's "Yes, and don't ask again for …", OpenCode's
 * "Allow always"). */
const GRANTING_ROW = /(?:don'?t|do not|never|stop)\s+ask(?:ing)?\s+again|always\s+allow|allow\s+always|allow\s+all\b|auto-?approve|remember\s+(?:this|my)\b/iu;

/**
 * Whether a voice may answer the dialog `prompt` at all (gap 80: no voice on
 * permissions). Only a dialog positively read as a *question* the agent asks —
 * its steps carry navigation (OpenCode's, Gemini's tabs) or one of its rows is
 * the free-text row Claude Code's question and OpenCode's always add — is
 * pickable. A permission dialog ("Do you want to proceed?" — Yes / Yes, and
 * don't ask again / No), a picker, a review page and any shape the parser does
 * not classify are refused: the parse carries no "kind", so this refuses by
 * default rather than guessing. A screen-drawn fake question can still look
 * like a question — the screen is the agent's — which is why a pick also waits
 * out the send guard's chime-and-cancel window (`PickStage`). A row that names
 * a grant or a saved rule refuses it too.
 */
export function voicePickable(prompt: SelectPrompt): boolean {
  if (prompt.review) return false;
  if (prompt.navigation === undefined && !prompt.options.some(freeTextRow)) return false;
  return !prompt.options.some((option) => GRANTING_ROW.test(option.label));
}

/** The row `utterance` picks on the question `prompt` — by the number the
 * dialog printed beside it — or `null` when it picks none (`matchOption`), and on a dialog a voice may not
 * answer at all (`voicePickable`). */
export function voicePick(utterance: string, prompt: SelectPrompt): SelectOption | null {
  if (!voicePickable(prompt)) return null;
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

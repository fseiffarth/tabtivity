// What a spoken jump's landing reads (docs/desktop_tabby_navigate_plan.md),
// shared by the phone (`mobile-web/src/voiceNav.ts`) and the desktop Chat
// (`useReaderVoiceLanding.ts`): the reader's last prompt in the conversation,
// cut for the voice, and the answers that came after it. Pure functions.
import { withoutInboxReferences } from "../mobile-web/src/terminal/inboxRefs";

/** The prompt cut to its first sentences for the voice: a long prompt is not
 * read out whole. */
export function promptForVoice(text: string, maxSentences = 2, maxChars = 280): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/gu) ?? [flat];
  let out = sentences.slice(0, maxSentences).map((sentence) => sentence.trim()).join(" ");
  if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/\s+\S*$/u, "")}…`;
  return out;
}

/** One turn of a conversation as `transcriptTurns` gives it. */
export interface LandingTurn {
  kind: string;
  key: string;
  text: string;
  /** A slash command: not a prompt the reader asked. */
  command?: unknown;
}

/** The reader's last prompt (not a slash command) and what followed it:
 * `text`, cut for the voice; `sinceKey`, the newest answer *before* it (a
 * reading cursor reads the ones after that); `answers`, the answers after it,
 * oldest first. `null` when the conversation holds no prompt. */
export function landingFromTurns<T extends LandingTurn>(turns: readonly T[]): { text: string; sinceKey: string | null; answers: T[] } | null {
  let at = -1;
  for (let index = turns.length - 1; index >= 0 && at < 0; index -= 1) {
    if (turns[index].kind === "prompt" && !turns[index].command) at = index;
  }
  if (at < 0) return null;
  let sinceKey: string | null = null;
  for (let index = at - 1; index >= 0 && sinceKey === null; index -= 1) {
    if (turns[index].kind === "answer") sinceKey = turns[index].key;
  }
  const text = promptForVoice(withoutInboxReferences(turns[at].text) || turns[at].text);
  return { text, sinceKey, answers: turns.slice(at + 1).filter((turn) => turn.kind === "answer") };
}

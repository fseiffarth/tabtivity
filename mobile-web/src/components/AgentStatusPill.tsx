import type { AgentStatus } from "../api";
import { useT, type TranslationKey } from "../../../src/lib/i18n";

/** The desktop tab strip's status glyphs (`TabStatusMark`): ▶ working,
 *  ? waiting on a decision, ■ interrupted, ✓ finished. ▶ and ■ have emoji
 *  presentations on phones, so each carries U+FE0E to stay a plain glyph in
 *  the pill's own colour — written as an escape because the selector is
 *  invisible in source. */
const TEXT = "︎";
export const AGENT_STATUS_GLYPH: Record<AgentStatus, string> = {
  working: `▶${TEXT}`,
  question: `?`,
  interrupted: `■${TEXT}`,
  done: `✓${TEXT}`,
};

/** The state's word, in the phone's language. */
const AGENT_STATUS_WORD: Record<AgentStatus, TranslationKey> = {
  working: "mobile.agentStatus.working",
  question: "mobile.agentStatus.question",
  interrupted: "mobile.agentStatus.interrupted",
  done: "mobile.agentStatus.done",
};

/** A tab's agent state, as the project and Activity lists both show it: the
 *  desktop's glyph, then the word. The glyph is decoration on a pill that
 *  already names its state, so a screen reader hears the word alone. */
export function AgentStatusPill({ status }: { status: AgentStatus }) {
  const t = useT();
  return <small className={`agent-status ${status}`}><span className="agent-status-glyph" aria-hidden="true">{AGENT_STATUS_GLYPH[status]}</span>{t(AGENT_STATUS_WORD[status])}</small>;
}

/** The same state as the bare glyph, for the project screen's tab cards, which
 *  wear it on their left border. It has no word beside it, so the word is its
 *  accessible name. The glyph sits in its own span because the disc's
 *  `transform` places it on the border — the glyph's motion needs its own. */
export function AgentStatusMark({ status }: { status: AgentStatus }) {
  const t = useT();
  const word = t(AGENT_STATUS_WORD[status]);
  return <span className={`agent-status tab-card-status ${status}`} role="img" aria-label={word} title={word}><span className="agent-status-glyph" aria-hidden="true">{AGENT_STATUS_GLYPH[status]}</span></span>;
}

import type { SentAgentPrompt } from "../../../stores/agents/agentPrompts";
import type { TabEntry } from "../../../stores/tabs";
import { rowOfTab, sameWords } from "./adopt";

/**
 * One tab's prompts, oldest first, for the prompt strip over an agent pane
 * (`components/terminal/TerminalPromptStrip`).
 *
 * Two sources, joined:
 *  - the project's prompt history rows of the tab — what Tabtivity sent itself
 *    (composer, schedules, the phone) and what it already adopts from the
 *    agents that keep a transcript. Exact, and it survives a restart.
 *  - the lines the keystrokes submitted (`lib/agents/typedPrompt`), which
 *    need nothing of any CLI but live only as long as the window.
 *
 * A typed line and a history row within {@link TRAIL_PAIR_MS} of each other
 * are one prompt: the row wins as the record, the typed text as the words
 * when they agree (the history folds a transcript prompt to one line and
 * cuts it; the keystrokes kept its lines and its whole length).
 */
export interface TrailPrompt {
  text: string;
  /** Epoch ms it went. */
  at: number;
  /** `typed` = only the keystrokes saw it: a best reading, not a record. */
  source: "history" | "typed";
}

/** One line the keystrokes submitted. */
export interface TypedPrompt {
  text: string;
  at: number;
}

/** How far apart a history row and the typed line it records may be: a
 *  transcript stamps the submit, a message queued mid-turn lands later. */
export const TRAIL_PAIR_MS = 2 * 60_000;

export function buildPromptTrail(
  history: readonly SentAgentPrompt[],
  typed: readonly TypedPrompt[],
  tab: TabEntry,
): TrailPrompt[] {
  const unpaired = [...typed];
  const trail: TrailPrompt[] = [];
  for (const row of history) {
    if (!rowOfTab(row, tab) || row.result === "missed" || row.result === "failed") continue;
    const at = Date.parse(row.sent_at);
    if (!Number.isFinite(at)) continue;
    let best = -1;
    for (let i = 0; i < unpaired.length; i++) {
      const gap = Math.abs(unpaired[i].at - at);
      if (gap <= TRAIL_PAIR_MS && (best < 0 || gap < Math.abs(unpaired[best].at - at))) best = i;
    }
    const pair = best < 0 ? undefined : unpaired.splice(best, 1)[0];
    const text = pair && sameWords(pair.text, row.message) ? pair.text : row.message;
    trail.push({ text, at, source: "history" });
  }
  for (const line of unpaired) trail.push({ text: line.text, at: line.at, source: "typed" });
  return trail.sort((a, b) => a.at - b.at);
}

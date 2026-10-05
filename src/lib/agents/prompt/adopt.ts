import { useAgentPromptsStore, type SentAgentPrompt } from "../../../stores/agents/agentPrompts";
import { isSessionCommand } from "./chart";
import type { TabEntry } from "../../../stores/tabs";

/**
 * Prompts typed straight into an agent's terminal, adopted into the prompt
 * history so the prompt chart shows them beside the ones Tabtivity sent.
 *
 * Tabtivity sees a prompt go by only when it sends one itself (the composer, a
 * schedule): keystrokes into the terminal reach the PTY, the TUI's input box
 * edits them, and what was finally submitted is known to the agent alone —
 * and written to its transcript. `stores/agents/agentModels` reads that transcript's
 * last prompt when a turn starts, and hands a *changed* one here. A prompt
 * Tabtivity sent is already on the history (the composer archives at send time,
 * the scheduler records at delivery, both before the agent's first output
 * flips the tab busy), so the newest history row for the tab is compared
 * first and a match is left alone rather than recorded twice.
 *
 * The transcript's text is one folded line, cut at the backend's bound, so a
 * long typed prompt is recorded as its opening; the tab holds the whole of it.
 */

/** Whitespace folded the way the backend folds a transcript prompt
 * (`agent_session::clean_prompt_text`), so the two texts compare. */
export function foldPrompt(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** Whether a history row went to `tab`, by the strongest identity the row
 * carries and by that one only: its tab id (the launch id, the same across
 * `/clear`), else its session id (a row written before the tab id was
 * recorded), else its label (a row from a tab that had no session id). A
 * fallback, never an OR: default labels repeat ("Claude"), so matching by
 * label as well hands every tab of that name every other one's prompts —
 * as `chart.rowOnStrand` learned first. For the same reason a tab with an id
 * of its own never takes a label-only row: it stamped every row it got. */
export function rowOfTab(row: SentAgentPrompt, tab: TabEntry): boolean {
  if (row.tab_id) return row.tab_id === historyTabId(tab);
  if (row.session_id) return row.session_id === tab.sessionId;
  return !historyTabId(tab) && row.tab_label === tab.label;
}

/** The id a tab's history rows carry as `tab_id`: its launch id, or — for a
 * tab without one (a CLI Tabtivity cannot resume) — its schedule target id,
 * which a restore keeps too. */
export function historyTabId(tab: Pick<TabEntry, "sessionId" | "scheduleTargetId">): string | undefined {
  return tab.sessionId ?? tab.scheduleTargetId;
}

/** The tab's newest history row: its session first, its label as the
 * fallback for a tab that had no session id when the row was written. */
function newestFor(history: readonly SentAgentPrompt[], tab: TabEntry): SentAgentPrompt | undefined {
  let newest: SentAgentPrompt | undefined;
  for (const row of history) {
    if (!rowOfTab(row, tab)) continue;
    if (!newest || row.sent_at > newest.sent_at) newest = row;
  }
  return newest;
}

/** Whether `prompt` (a transcript's folded, possibly cut line) is the tab's
 * newest recorded prompt already — i.e. Tabtivity sent it. */
export function alreadyRecorded(history: readonly SentAgentPrompt[], prompt: string, tab: TabEntry): boolean {
  const newest = newestFor(history, tab);
  if (!newest) return false;
  const recorded = foldPrompt(newest.message);
  const seen = foldPrompt(prompt);
  return seen.endsWith("…") ? recorded.startsWith(seen.slice(0, -1)) : recorded === seen;
}

/** One prompt out of the agent's transcript and the moment it went
 * (`agent_tab_recent_prompts`). */
export interface TranscriptPrompt {
  text: string;
  at: string;
}

/** How far back a transcript prompt is still adopted: a restored tab fills in
 * its day, not its whole past. */
export const ADOPT_LOOKBACK_MS = 24 * 3_600_000;
/** A history row of the same words within this of the transcript's time is
 * that prompt already: the scheduler records a delivery when it submits it,
 * and a send-now prompt waits at most the one-hour window for idle. */
export const SAME_PROMPT_MS = 65 * 60_000;

/** Whether a transcript's (folded, possibly cut) line reads as a recorded
 * message: the same words, or the opening of them when the line was cut. */
export function sameWords(recorded: string, seen: string): boolean {
  const a = foldPrompt(recorded);
  const b = foldPrompt(seen);
  return b.endsWith("…") ? a.startsWith(b.slice(0, -1)) : a === b;
}

/**
 * The transcript prompts the history is missing for `tab`, oldest first.
 * Every prompt the tail holds is a candidate — a message sent while the agent
 * was working never starts a turn, so "the prompt at a turn's start" misses
 * it — and each is placed at the transcript's own time. Skipped: session
 * commands, anything older than the lookback, and a prompt already on the
 * history as a row of this tab with the same words near that time.
 */
export function promptsToAdopt(
  history: readonly SentAgentPrompt[],
  prompts: readonly TranscriptPrompt[],
  tab: TabEntry,
  now: number,
): TranscriptPrompt[] {
  const mine = history.filter((row) => rowOfTab(row, tab));
  const taken: { text: string; at: number }[] = mine.map((row) => ({ text: row.message, at: Date.parse(row.sent_at) }));
  const adopt: TranscriptPrompt[] = [];
  for (const prompt of prompts) {
    const at = Date.parse(prompt.at);
    if (!Number.isFinite(at) || now - at > ADOPT_LOOKBACK_MS || isSessionCommand(prompt.text)) continue;
    const known = taken.some((row) => sameWords(row.text, prompt.text) && (!Number.isFinite(row.at) || Math.abs(row.at - at) <= SAME_PROMPT_MS));
    if (known) continue;
    adopt.push(prompt);
    taken.push({ text: prompt.text, at });
  }
  return adopt;
}

/** Prompts on their way into the history, so two reads racing (a turn's start
 * and its recheck) cannot record one twice before the first write lands. */
const inFlight = new Set<string>();

/** Record every transcript prompt the history is missing for `tab`, each at
 * its own time. Never throws. */
export async function adoptTranscriptPrompts(scope: string, tab: TabEntry, prompts: readonly TranscriptPrompt[]): Promise<void> {
  const store = useAgentPromptsStore.getState();
  const history = store.historyByProject[scope] ?? await store.loadHistory(scope).catch(() => [] as SentAgentPrompt[]);
  for (const prompt of promptsToAdopt(history, prompts, tab, Date.now())) {
    const key = `${scope}|${tab.sessionId ?? tab.label}|${prompt.at}|${prompt.text}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      await store.record(scope, {
        id: crypto.randomUUID(),
        message: prompt.text,
        sent: { tabLabel: tab.label, sessionId: tab.sessionId, tabId: tab.scheduleTargetId, agent: tab.cmd, result: "delivered", sentAt: prompt.at },
      });
    } catch {
      // A prompt the history cannot take is still shown beside the tab.
    } finally {
      inFlight.delete(key);
    }
  }
}

/** Record `prompt` as delivered to `tab` unless it is already the tab's
 * newest history row, or a session command (`/rename …`, `/model …`, any
 * bare `/command` — `lib/agents/prompt/chart.isSessionCommand`). Never throws: a prompt the
 * history cannot take is still shown in the Agents view. */
export async function adoptTypedPrompt(scope: string, tab: TabEntry, prompt: string): Promise<void> {
  if (isSessionCommand(prompt)) return;
  const store = useAgentPromptsStore.getState();
  const history = store.historyByProject[scope] ?? await store.loadHistory(scope).catch(() => [] as SentAgentPrompt[]);
  if (alreadyRecorded(history, prompt, tab)) return;
  await store
    .record(scope, {
      id: crypto.randomUUID(),
      message: prompt,
      sent: { tabLabel: tab.label, sessionId: tab.sessionId, tabId: tab.scheduleTargetId, agent: tab.cmd, result: "delivered" },
    })
    .catch(() => []);
}

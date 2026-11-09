// What spoken navigation (docs/voice_nav_mode_plan.md) works with: the lists
// the matcher resolves names against, the choice of a tab, the three queues
// ("the waiting / working / done tab", across projects) with their cursor, and
// the one-shot landing a jump leaves for the screen it opens. Pure functions
// plus two small pieces of module state (the cursor and the landing), which
// outlive the Terminal that sets them — a jump unmounts the screen.
//
// Only opaque ids the phone already holds go in or out (`mobile_control` is
// unchanged): the project and tab ids of `GET /api/v1/projects`,
// `/projects/{id}` and `/activity`.
import { sortAgentTabs } from "../../shared/agentSort";
import { BUILTIN_AGENT_ALIASES, type VoiceListItem } from "../../src/lib/voice/voiceCommands";
import { lastPrompt } from "./agentPrompts";
import { type ActivityTab, type ProjectDetail, type ProjectRow, type SessionTranscript, type TabRow } from "./api";
import { lastWorkedAt } from "./components/AgentModeMarks";
import { needsYouGroups } from "./needsYouGroups";
import { type SeenDone } from "./seenDone";
import { withoutInboxReferences } from "./terminal/inboxRefs";
import { transcriptTurns } from "./terminal/transcriptTurns";

// ---------------------------------------------------------------- lists

/** The projects a name may be said for: real projects only (not boxes, the
 * root or the assistant), by their label. */
export function projectItems(rows: readonly ProjectRow[]): VoiceListItem[] {
  return rows
    .filter((row) => row.kind === undefined || row.kind === "project")
    .map((row) => ({ id: row.id, name: row.label }));
}

/** The first word of an agent's label, folded: "Claude Code" and "Claude" are
 * one agent, as the tab rows and the launch list spell them. */
function agentKey(label: string | undefined): string {
  return (label ?? "").trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
}

/** The project's tabs by title and its agents by name (the built-in ones with
 * the spellings a recognizer writes for them). */
export function detailLists(detail: Pick<ProjectDetail, "tabs" | "agents">): { tabs: VoiceListItem[]; agents: VoiceListItem[] } {
  return {
    tabs: detail.tabs.map((tab) => ({ id: tab.id, name: tab.label })),
    agents: detail.agents.map((agent) => ({
      id: agent.id,
      name: agent.label,
      aliases: BUILTIN_AGENT_ALIASES[agentKey(agent.label)] ?? [],
    })),
  };
}

// ---------------------------------------------------------------- choosing a tab

/** A tab with a mic and a session to read: an agent tab that is up and is not
 * a sign-in or a vendor cloud session. */
export function isNavigableAgentTab(tab: TabRow): boolean {
  return tab.kind === "agent" && tab.available && tab.sign_in !== true && tab.cloud !== true;
}

/** The project's agent tab to land on: the one with the latest activity, else
 * the first. `undefined` for a project with none. */
export function latestAgentTab(tabs: readonly TabRow[]): TabRow | undefined {
  const agents = tabs.filter(isNavigableAgentTab);
  let best = agents[0];
  for (const tab of agents) if ((tab.last_activity ?? 0) > (best?.last_activity ?? 0)) best = tab;
  return best;
}

/** The `n`-th tab of the project, from 1, in the order the project lists them. */
export function tabAtNumber(tabs: readonly TabRow[], n: number): TabRow | undefined {
  return Number.isInteger(n) && n >= 1 ? tabs[n - 1] : undefined;
}

/** The tabs of one agent, in the project's order. */
export function tabsOfAgent(tabs: readonly TabRow[], agentLabel: string): TabRow[] {
  const key = agentKey(agentLabel);
  return key ? tabs.filter((tab) => tab.kind === "agent" && agentKey(tab.agent_label ?? tab.label) === key) : [];
}

/** "Claude tab 2" is the second Claude tab; "Claude tab" the one with the
 * latest activity. */
export function agentTabChoice(tabs: readonly TabRow[], agentLabel: string, n?: number): TabRow | undefined {
  const own = tabsOfAgent(tabs, agentLabel);
  if (n !== undefined) return own[n - 1];
  return latestAgentTab(own) ?? own[0];
}

// ---------------------------------------------------------------- the queues

export type NavQueueKind = "waiting" | "working" | "done";

/** The tabs a spoken "the … tab" walks, in the phone's own order — the one
 * Home's Needs you and the Agents view show — across every project:
 * - waiting: Needs you's asking group (questions first, then cut-off turns);
 * - done: its finished group (done and not opened on this phone yet);
 * - working: the working tabs in the Agents view's `lastWorking` order.
 * A tab that is not up cannot be opened and is left out. */
export function navQueue(kind: NavQueueKind, tabs: readonly ActivityTab[], seen: SeenDone, drafted: ReadonlySet<string> = new Set()): ActivityTab[] {
  const groups = needsYouGroups(tabs, seen);
  const list = kind === "waiting" ? groups.asking
    : kind === "done" ? groups.finished
      : sortAgentTabs(tabs.filter((tab) => tab.agent_status === "working"), "lastWorking", (tab) => ({
        decision: false,
        ready: false,
        working: true,
        drafted: drafted.has(tab.id),
        workingAt: tab.working_at,
        doneAt: lastWorkedAt(tab),
      }));
  return list.filter((tab) => tab.available);
}

/** The last tab each queue jumped to; "again" goes on from it. */
const cursors = new Map<NavQueueKind, string>();

export function resetNavCursors(): void {
  cursors.clear();
}

/** The next tab of a queue: the one after the cursor's (wrapping), never the
 * tab the reader is on. The done queue is walked without a cursor (the caller
 * notes no jump): a landing marks the tab seen, so it leaves the queue by
 * itself. `undefined` when the queue holds nothing else. */
export function nextInQueue<T extends { id: string }>(kind: NavQueueKind, queue: readonly T[], currentTabId: string): T | undefined {
  const after = cursors.get(kind);
  const start = after === undefined ? 0 : queue.findIndex((tab) => tab.id === after) + 1;
  for (let step = 0; step < queue.length; step += 1) {
    const tab = queue[(start + step) % queue.length];
    if (tab.id !== currentTabId) return tab;
  }
  return undefined;
}

/** Remembers where a queue jumped to. */
export function noteJump(kind: NavQueueKind, tabId: string): void {
  cursors.set(kind, tabId);
}

// ---------------------------------------------------------------- the landing

/** A jump's note to the screen it opens. */
export interface Landing {
  /** The tab the jump opened. */
  tabId: string;
  /** "Claude in Alpha", for a landing that has nothing else to read. */
  where: string;
  at: number;
}

/** A landing older than this was never meant for the screen that finds it. */
export const LANDING_MAX_AGE_MS = 30_000;

let pending: Landing | null = null;

/** Leaves the note for the next Terminal (replacing any older one). */
export function leaveLanding(landing: Omit<Landing, "at">, now: number = Date.now()): void {
  pending = { ...landing, at: now };
}

/** The new Terminal's mount takes it, once: a note for another tab, or one
 * gone stale, is dropped without being returned. */
export function takeLanding(tabId: string, now: number = Date.now()): Landing | null {
  const landing = pending;
  pending = null;
  return landing && landing.tabId === tabId && now - landing.at <= LANDING_MAX_AGE_MS ? landing : null;
}

// ---------------------------------------------------------------- the lines read at a landing

/** The prompt cut to its first sentences for the voice: a long prompt is not
 * read out whole. */
export function promptForVoice(text: string, maxSentences = 2, maxChars = 280): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/gu) ?? [flat];
  let out = sentences.slice(0, maxSentences).map((sentence) => sentence.trim()).join(" ");
  if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/\s+\S*$/u, "")}…`;
  return out;
}

/** What a landing reads, decided from what the new screen holds:
 * - `prompt`: the reader's last prompt there; `answered` says whether the
 *   session has an answer after it, and `sinceKey` is the key of the newest
 *   answer *before* it (the reading cursor reads the ones after that);
 * - `fallback`: the session could not be read: the tab row's last prompt, and
 *   no answer;
 * - `where`: only where it landed ("Claude in Alpha") — a tab whose Focus is
 *   not a stored session, or one with no prompt yet. */
export type LandingRead =
  | { kind: "where" }
  | { kind: "prompt"; text: string; answered: boolean; sinceKey: string | null }
  | { kind: "fallback"; text: string };

export function landingRead(tab: TabRow, transcript: SessionTranscript | null, sessionFocus: boolean): LandingRead {
  if (!sessionFocus) return { kind: "where" };
  // A session that does not exist (a terminal view, no stored session) has
  // nothing to read; one that failed to read, or has not answered, falls back.
  if (transcript && !transcript.available && transcript.reason !== "read_failed") return { kind: "where" };
  if (transcript?.available) {
    const turns = transcriptTurns(transcript.entries);
    let at = -1;
    for (let index = turns.length - 1; index >= 0 && at < 0; index -= 1) {
      if (turns[index].kind === "prompt" && !turns[index].command) at = index;
    }
    if (at < 0) return { kind: "where" };
    let sinceKey: string | null = null;
    for (let index = at - 1; index >= 0 && sinceKey === null; index -= 1) {
      if (turns[index].kind === "answer") sinceKey = turns[index].key;
    }
    const text = promptForVoice(withoutInboxReferences(turns[at].text) || turns[at].text);
    return { kind: "prompt", text, answered: turns.slice(at + 1).some((turn) => turn.kind === "answer"), sinceKey };
  }
  const asked = lastPrompt(tab);
  return asked ? { kind: "fallback", text: promptForVoice(asked.text) } : { kind: "where" };
}

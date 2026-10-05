import { invoke } from "@tauri-apps/api/core";
import type { SessionTranscript } from "../../mobile-web/src/api";
import type { TabEntry } from "../stores/tabs";
import { noteBackgroundWork } from "../stores/activity";
import { readerRequest } from "./agents/agentReader";

/**
 * How many subagents an agent tab's session has at work, for the phone's tab
 * cards: the `runningAgents` count `agent_tab_transcript` takes over the whole
 * tail it reads (`services::agent_transcript`), so a background subagent
 * spawned many turns ago still counts.
 *
 * Answered from what was last counted, with a re-count started for the next
 * poll — the catalog answer never waits on a transcript parse. The re-count
 * hands back the version it was counted at, so a session sitting still costs
 * a stat; one at work is parsed at most once per `RECOUNT_FLOOR_MS`, the
 * model store's floor for the prompt lines beside it.
 */
const RECOUNT_FLOOR_MS = 10_000;

interface Counted { count: number; version?: string; askedAt: number; reading: boolean }
const counted = new Map<string, Counted>();

/** Only Claude's record says whether a subagent is still at work; any other
 * CLI is zero without a read (the backend's `running_subagents` rule). */
function counts(tab: Pick<TabEntry, "cmd">): boolean {
  return tab.cmd === "claude";
}

export function mobileSubagentCount(scope: string, tab: TabEntry, now = Date.now()): number {
  if (!counts(tab) || !tab.sessionId) return 0;
  const ptyId = `${scope}:${tab.key}`;
  const known = counted.get(ptyId);
  if (!known || (!known.reading && now - known.askedAt >= RECOUNT_FLOOR_MS)) void recount(ptyId, scope, tab, known, now);
  return known?.count ?? 0;
}

async function recount(ptyId: string, scope: string, tab: TabEntry, known: Counted | undefined, now: number): Promise<void> {
  const args = readerRequest(scope, tab, undefined, known?.version, 1);
  if (!args) return;
  const entry: Counted = { count: known?.count ?? 0, version: known?.version, askedAt: now, reading: true };
  counted.set(ptyId, entry);
  const read = await invoke<SessionTranscript>("agent_tab_transcript", args).catch(() => null);
  entry.reading = false;
  if (!read) return;
  if (!read.unchanged) {
    entry.count = read.available ? read.runningAgents ?? 0 : 0;
    entry.version = read.version;
  }
  // A subagent at work after the Stop keeps the turn open for when it wakes
  // the agent (`noteBackgroundWork`); stamped with when the read began.
  if (entry.count > 0) noteBackgroundWork(ptyId, now);
}

export function clearMobileSubagentCountsForTest(): void {
  counted.clear();
}

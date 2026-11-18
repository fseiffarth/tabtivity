import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { lastUserInputAt, useActivityStore } from "../../stores/activity";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { activeProjectScopesRestored } from "../../stores/projects";
import {
  noteAgentTabUsed,
  stopAgentTab,
  stopPlaceOf,
  stopSignalsOf,
  wakeAgentTab,
  type FinalStopChecks,
} from "../../stores/agents/agentTabStop";
import {
  MEMORY_STOPS_PER_TICK,
  PINNED_ONLY_CLIS,
  STOPS_PER_TICK,
  freeMemoryBytes,
  lastUsedOf,
  pickRestoreWakes,
  pickStops,
  staticStopBlockers,
  stopAgentTabsCap,
  stopAgentTabsIdleMs,
  stopAgentTabsMinFreeBytes,
  stopBlockers,
  type StopCandidate,
} from "../../lib/agents/agentTabStop";
import { agentPaneLastShownAt, agentTabStartedAt, takeRestoredStopped } from "../../lib/agents/agentTabStopMarks";
import { readerRequest } from "../../lib/agents/agentReader";
import { listMarkupQuestions } from "../../lib/viewers/markupQuestions";
import { projectIdOfScope } from "../../lib/terminal/ptyId";

/** The sweep's cadence, and while free memory is low. */
const SWEEP_MS = 60_000;
const SWEEP_LOW_MEMORY_MS = 30_000;
/** How often the restore wake looks for tabs a layout load brought back stopped. */
const RESTORE_POLL_MS = 5_000;
/** A tab the backend said has no conversation to resume is not asked again for this long. */
const NO_CONVERSATION_RETRY_MS = 10 * 60_000;

interface Agent {
  scope: string;
  tab: TabEntry;
  ptyId: string;
}

/** Every agent tab of every loaded scope. */
function agentTabs(): Agent[] {
  return Object.entries(useTabsStore.getState().tabsByScope).flatMap(([scope, tabs]) =>
    tabs
      .filter((tab) => tab.kind === "agent" || tab.kind === "local_agent")
      .map((tab) => ({ scope, tab, ptyId: `${scope}:${tab.key}` })),
  );
}

/** Agent tabs with a running process: any CLI, not stopped, not a Host
 *  session waiting for its Resume. */
function liveCount(agents: readonly Agent[]): number {
  return agents.filter(({ tab }) => !tab.stopped && !tab.hostSessionPaused).length;
}

/** When the tab was last used, from this window's marks and its saved one. */
function lastUsedOfTab(a: Agent, withStart = true): number {
  const activity = useActivityStore.getState();
  return lastUsedOf({
    lastShownAt: agentPaneLastShownAt(a.ptyId),
    lastUserInputAt: lastUserInputAt(a.ptyId),
    lastDoneAt: activity.lastDoneByTab[a.ptyId],
    lastWorkingAt: activity.busyByTab[a.ptyId] ? Date.now() : activity.lastWorkingByTab[a.ptyId],
    restoredLastUsedAt: a.tab.lastUsedAt,
    startedAt: withStart ? agentTabStartedAt(a.ptyId) : undefined,
  });
}

/** Free memory is under the floor; false when off or the reading is missing. */
async function memoryLow(minFree: number | null): Promise<boolean> {
  if (minFree === null) return false;
  const snapshot = await invoke<Parameters<typeof freeMemoryBytes>[0]>("machine_load_snapshot").catch(() => null);
  const free = freeMemoryBytes(snapshot);
  return free !== null && free < minFree;
}

/** The backend's word: a respawn of the tab now resumes its own conversation. */
function askResumePinned(a: Agent): Promise<boolean> {
  return invoke<boolean>("agent_tab_resume_pinned", {
    agent: a.tab.cmd,
    projectId: projectIdOfScope(a.scope),
    sessionId: a.tab.sessionId ?? "",
    cwd: a.tab.cwd,
  }).catch(() => false);
}

/** The answers only the backend has, one IPC each, for a final candidate. */
async function finalChecks(a: Agent): Promise<FinalStopChecks> {
  const projectId = projectIdOfScope(a.scope);
  const resumePinned = await askResumePinned(a);
  if (!resumePinned) return { resumePinned };
  let runningSubagents = 0;
  if (a.tab.cmd === "claude") {
    const args = readerRequest(a.scope, a.tab, undefined, undefined, 1);
    const read = args
      ? await invoke<{ available?: boolean; runningAgents?: number } | null>("agent_tab_transcript", args).catch(() => null)
      : null;
    // An unreadable session is not known to be idle.
    runningSubagents = read ? (read.available ? (read.runningAgents ?? 0) : 0) : 1;
  }
  let markupAsk = false;
  if (projectId && a.tab.scheduleTargetId) {
    markupAsk = await listMarkupQuestions(projectId, a.tab.scheduleTargetId).then(
      (asks) => asks.length > 0,
      () => true,
    );
  }
  return { resumePinned, runningSubagents, markupAsk };
}

/**
 * Stops idle agent tabs and wakes the ones a relaunch brought back stopped
 * (`docs/agent_tab_stop_plan.md` §6). Main window only, beside the other agent
 * hosts; runs unfocused like them.
 *
 * Each sweep: the cheap guards on every agent tab, the pure pick
 * (`pickStops`: low memory, the cap, the idle time), then the backend's word
 * on each picked tab (`finalChecks`) before `stopAgentTab` reads every guard
 * again and stops it. One console line per stop names its trigger.
 */
export function AgentTabStopHost() {
  useEffect(() => {
    let disposed = false;
    let running = false;
    let lastSweep = 0;
    let lowMemory = false;
    const noConversationUntil = new Map<string, number>();

    const restoreWake = async () => {
      if (!activeProjectScopesRestored()) return;
      const restored = takeRestoredStopped();
      if (restored.size === 0) return;
      const agents = agentTabs();
      const restoredStopped = agents.filter((a) => a.tab.stopped && restored.get(a.scope)?.has(a.tab.key));
      // The restore stops by the static guards alone. A CLI that resumes its
      // own conversation only while its record exists (`PINNED_ONLY_CLIS`)
      // otherwise falls back to the folder's newest — woken later, possibly
      // another tab's. Such a tab is always-live, as the sweep treats it: it
      // wakes now, the cap aside, on the args a restore always gave it.
      const unpinned = new Set<Agent>();
      for (const a of restoredStopped) {
        if (PINNED_ONLY_CLIS.has(a.tab.cmd) && !(await askResumePinned(a))) unpinned.add(a);
      }
      if (disposed) return;
      for (const a of unpinned) wakeAgentTab(a.scope, a.tab.key);
      const stopped = restoredStopped.filter((a) => !unpinned.has(a));
      if (stopped.length === 0) return;
      const sessions = stopped.some((a) => a.tab.tmuxSession)
        ? new Set(await invoke<string[]>("local_tmux_app_sessions").catch(() => []))
        : new Set<string>();
      const settings = useSettingsStore.getState().settings;
      const wakes = pickRestoreWakes({
        live: liveCount(agentTabs()),
        cap: stopAgentTabsCap(settings),
        memLow: await memoryLow(stopAgentTabsMinFreeBytes(settings)),
        stopped: stopped.map((a) => ({
          ptyId: a.ptyId,
          lastUsedAt: a.tab.lastUsedAt ?? 0,
          sessionAlive: !!a.tab.tmuxSession && sessions.has(a.tab.tmuxSession),
        })),
      });
      if (disposed) return;
      const byPty = new Map(stopped.map((a) => [a.ptyId, a]));
      for (const ptyId of wakes) {
        const a = byPty.get(ptyId);
        if (a) wakeAgentTab(a.scope, a.tab.key);
      }
    };

    const sweep = async () => {
      const settings = useSettingsStore.getState().settings;
      const cap = stopAgentTabsCap(settings);
      const idleMs = stopAgentTabsIdleMs(settings);
      const minFree = stopAgentTabsMinFreeBytes(settings);
      const agents = agentTabs();
      // The persisted last-use mark, moved in coarse steps (never by a spawn
      // alone: a tab that was only restored was not used).
      for (const a of agents) {
        const used = lastUsedOfTab(a, false);
        if (used > (a.tab.lastUsedAt ?? 0)) noteAgentTabUsed(a.scope, a.tab.key, used);
      }
      if (cap === null && idleMs === null && minFree === null) return;
      lowMemory = await memoryLow(minFree);
      if (disposed) return;
      const now = Date.now();
      const candidates: StopCandidate[] = [];
      const byPty = new Map<string, Agent>();
      for (const a of agents) {
        if (a.tab.stopped || (noConversationUntil.get(a.ptyId) ?? 0) > now) continue;
        const place = stopPlaceOf(a.scope, a.tab);
        if (staticStopBlockers(a.tab, place).length > 0) continue;
        const signals = stopSignalsOf(a.scope, a.tab, now);
        if (stopBlockers(a.tab, place, signals).length > 0) {
          // A schedule list not loaded yet reads as queued: load it for the next sweep.
          if (a.tab.scheduleTargetId && !useAgentSchedulesStore.getState().byTarget[scheduleCacheKey(a.scope, a.tab.scheduleTargetId)]) {
            void useAgentSchedulesStore.getState().load(a.scope, a.tab.scheduleTargetId).catch(() => []);
          }
          continue;
        }
        // `mcpStale` is the MCP-reattach work's input: a tab whose lanes went
        // stale ranks first (`rankStopCandidates`).
        candidates.push({ ptyId: a.ptyId, scope: a.scope, key: a.tab.key, lastUsedAt: lastUsedOfTab(a) });
        byPty.set(a.ptyId, a);
      }
      let live = liveCount(agents);
      let stops = 0;
      let memoryStops = 0;
      const tried = new Set<string>();
      // Two rounds: a picked tab the backend refuses makes room for the next one.
      for (let round = 0; round < 2 && stops < STOPS_PER_TICK; round += 1) {
        const picks = pickStops({
          live,
          candidates: candidates.filter((c) => !tried.has(c.ptyId)),
          cap,
          idleMs,
          now,
          memLow: lowMemory && memoryStops < MEMORY_STOPS_PER_TICK,
          perTick: STOPS_PER_TICK - stops,
        });
        if (picks.length === 0) break;
        for (const { candidate, trigger } of picks) {
          if (disposed) return;
          tried.add(candidate.ptyId);
          const a = byPty.get(candidate.ptyId);
          if (!a) continue;
          if (trigger === "memory" && memoryStops >= MEMORY_STOPS_PER_TICK) continue;
          const final = await finalChecks(a);
          if (disposed) return;
          if (!final.resumePinned) noConversationUntil.set(a.ptyId, Date.now() + NO_CONVERSATION_RETRY_MS);
          if (stopAgentTab(a.scope, a.tab.key, final, trigger).length > 0) continue;
          stops += 1;
          live -= 1;
          if (trigger === "memory") memoryStops += 1;
        }
      }
    };

    const tick = async () => {
      if (disposed || running) return;
      running = true;
      try {
        await restoreWake();
        const due = Date.now() - lastSweep >= (lowMemory ? SWEEP_LOW_MEMORY_MS : SWEEP_MS);
        if (due && !disposed) {
          lastSweep = Date.now();
          await sweep();
        }
      } catch (e) {
        console.warn("agent tab stop sweep failed", e);
      } finally {
        running = false;
      }
    };

    // The first sweep a full interval after mount: restored tabs settle first.
    lastSweep = Date.now();
    const timer = setInterval(() => void tick(), RESTORE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return null;
}

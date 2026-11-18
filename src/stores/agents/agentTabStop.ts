/**
 * Stopping and waking one agent tab (`docs/agent_tab_stop_plan.md` §3–§5).
 *
 * Stop: the guards are read again on the tab as it is now; then the tab is
 * marked `stopped`, so its pane (`PaneSlot`) unmounts the `TerminalView`,
 * whose teardown kills the PTY and its subtree (or the slot kills a sleeping
 * pane's parked PTY); then the tab's own minted tmux session, if tmux wraps
 * it, is ended — never a session it only attached to. The same order as the
 * Undo-clear relaunch (`agentClearUndo.relaunch`), without the respawn.
 *
 * Wake: the tab respawns on the args a restore would give it
 * (`resumeArgsOf`), with `stopped` and the first prompt cleared in the same
 * write, so nothing is typed again. The backend resolves the conversation to
 * resume (`services::agent_session::resolve_agent_session`).
 */
import { invoke } from "@tauri-apps/api/core";
import { ROOT_SCOPE, resumeArgsOf, useTabsStore, type TabEntry } from "../tabs";
import { useProjectsStore } from "../projects";
import { agentDeliveryReady, lastBackgroundWorkAt, useActivityStore } from "../activity";
import { useAgentSchedulesStore, scheduleCacheKey } from "./agentSchedules";
import { usePrintRequestsStore } from "../printRequests";
import { runsLocally } from "./agentClearUndo";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { isHostPinned, tabRunsInContainer } from "../../lib/projectTabHost";
import { currentAttention } from "../../lib/cockpit/agentNotes";
import { phoneHoldDue } from "../../lib/agents/phoneHolds";
import { isAgentProposal, nextScheduleOccurrence, scheduleVerdict, type ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import { scheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import {
  SCHEDULE_SOON_MS,
  staticStopBlockers,
  stopAgentTabsCap,
  stopBlockers,
  type StopBlocker,
  type StopPlace,
  type StopSignals,
  type StopTrigger,
} from "../../lib/agents/agentTabStop";
import {
  agentPaneShown,
  agentTabStartedAt,
  noteAgentTabStarted,
  phoneSawTabAt,
  setRestoreStopRule,
} from "../../lib/agents/agentTabStopMarks";
import { useSettingsStore } from "../settings";

/** The last-use mark moves only by at least this much, so it does not churn
 *  the layout's save debounce. */
export const LAST_USED_STEP_MS = 10 * 60_000;
/** A turn counts as settled after this long done (the scheduler's gate). */
const SETTLED_MS = 3_000;

/** Session kills in flight, per PTY id: a wake waits for its tab's, so the
 *  respawn's `new-session -A` never lands on the session being ended. */
const pendingKill = new Map<string, Promise<void>>();

function findTab(scope: string, key: string): TabEntry | undefined {
  return useTabsStore.getState().tabsByScope[scope]?.find((t) => t.key === key);
}

/** Move the tab's persisted last-use mark to `at`, when it moved at least
 *  {@link LAST_USED_STEP_MS}. */
export function noteAgentTabUsed(scope: string, key: string, at = Date.now()): void {
  const tab = findTab(scope, key);
  if (!tab || tab.kind !== "agent") return;
  if (tab.lastUsedAt !== undefined && at - tab.lastUsedAt < LAST_USED_STEP_MS) return;
  useTabsStore.getState().setTabLastUsedAt(scope, key, at);
}

/** Where the tab runs, as the pane layer derives it (`PaneSlot`). */
export function stopPlaceOf(scope: string, tab: TabEntry): StopPlace {
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  return {
    reservedScope: scope === ROOT_SCOPE || scope === ASSISTANT_SCOPE,
    local: runsLocally(scope, tab),
    inContainer: tabRunsInContainer(project, tab.kind, scope) || isHostPinned(project),
  };
}

/** Whether a prompt is waiting for the tab, or due soon: a send-now or due
 *  rule, a phone hold, an agent's proposal, or a rule firing within
 *  {@link SCHEDULE_SOON_MS}. */
export function promptQueued(schedules: readonly ScheduledAgentPrompt[] | undefined, now: Date): boolean {
  return (schedules ?? []).some((s) => {
    if (isAgentProposal(s) || phoneHoldDue(s.id)) return true;
    if (scheduleVerdict(s, now).kind === "wait") return true;
    const next = nextScheduleOccurrence(s, now);
    return !!next && next.at.getTime() - now.getTime() <= SCHEDULE_SOON_MS;
  });
}

/** The tab's cheap signals of the moment, from the stores (no IPC). A
 *  schedule list not loaded yet reads as a prompt queued, so the sweep loads
 *  it before deciding. */
export function stopSignalsOf(scope: string, tab: TabEntry, now = Date.now()): StopSignals {
  const ptyId = `${scope}:${tab.key}`;
  const activity = useActivityStore.getState();
  const schedules = tab.scheduleTargetId
    ? useAgentSchedulesStore.getState().byTarget[scheduleCacheKey(scope, tab.scheduleTargetId)]
    : [];
  return {
    now,
    deliveryReady: agentDeliveryReady(ptyId, SETTLED_MS),
    busy: !!activity.busyByTab[ptyId],
    decision: activity.attentionByTab[ptyId] === "decision",
    askedAttention: !!currentAttention(tab.cockpitMeta, now),
    backgroundAt: lastBackgroundWorkAt(ptyId),
    shown: agentPaneShown(ptyId),
    phoneSeenAt: phoneSawTabAt(ptyId),
    queuedPrompt: schedules === undefined || promptQueued(schedules, new Date(now)),
    printPending: usePrintRequestsStore.getState().requests.some((r) => r.tab === ptyId),
    startedAt: agentTabStartedAt(ptyId),
  };
}

/** The answers the sweep asked the backend for, one IPC each. */
export type FinalStopChecks = Pick<StopSignals, "runningSubagents" | "markupAsk" | "resumePinned">;

/**
 * Stop the tab when no guard holds, read again now. Returns the blockers
 * that held (nothing was stopped), or `[]` once it is stopped. `final`
 * carries the sweep's IPC answers; without them the tab is not stopped
 * (`no_conversation`), since only the backend can say a respawn resumes it.
 */
export function stopAgentTab(scope: string, key: string, final: FinalStopChecks, trigger: StopTrigger | "manual" = "manual"): StopBlocker[] {
  const tab = findTab(scope, key);
  if (!tab) return ["not_agent"];
  const blockers = stopBlockers(tab, stopPlaceOf(scope, tab), { ...stopSignalsOf(scope, tab), ...final });
  if (final.resumePinned !== true && !blockers.includes("no_conversation")) blockers.push("no_conversation");
  if (blockers.length > 0) return blockers;
  const ptyId = `${scope}:${key}`;
  useTabsStore.getState().setTabStopped(scope, key, true);
  const kill = killMintedSession(tab);
  const tracked = kill.finally(() => {
    if (pendingKill.get(ptyId) === tracked) pendingKill.delete(ptyId);
  });
  pendingKill.set(ptyId, tracked);
  console.info(`agent tab stopped (${trigger}): ${ptyId} ${tab.cmd}`);
  return [];
}

function killMintedSession(tab: TabEntry): Promise<void> {
  // The tab's own minted session, if tmux wraps it at all (a Mobile-access
  // project or box, the Windows session host); ending one that is not there
  // is a no-op. Never a session the tab only attached to.
  const session = tab.tmuxAttach ? null : tab.tmuxSession;
  if (!session) return Promise.resolve();
  return invoke("local_tmux_kill", { session }).then(
    () => undefined,
    (e: unknown) => {
      console.warn("agent tab stop: tmux kill failed", e);
    },
  );
}

function relaunchAwake(scope: string, key: string): boolean {
  const tab = findTab(scope, key);
  if (!tab?.stopped) return false;
  useTabsStore.getState().relaunchTabInScope(scope, key, resumeArgsOf(tab), {
    stopped: undefined,
    initialInput: undefined,
  });
  noteAgentTabStarted(`${scope}:${key}`);
  return true;
}

/**
 * Wake a stopped tab: respawn it on its resume args. True when this call
 * woke it now; false for a tab that is not stopped (or gone). While the tab's
 * own session is still being ended the wake waits for that and answers false
 * here — the tab then wakes a moment later.
 */
export function wakeAgentTab(scope: string, key: string): boolean {
  const kill = pendingKill.get(`${scope}:${key}`);
  if (kill) {
    void kill.then(() => relaunchAwake(scope, key));
    return false;
  }
  return relaunchAwake(scope, key);
}

/** The restore's rule (`loadFromLayout`): with the cap on, a tab no static
 *  guard holds for comes back stopped. With the cap off, none does. */
export function restoredStopped(scope: string, tab: TabEntry): boolean {
  if (stopAgentTabsCap(useSettingsStore.getState().settings) === null) return false;
  return staticStopBlockers(tab, stopPlaceOf(scope, tab)).length === 0;
}
setRestoreStopRule(restoredStopped);

/** The scope and tab a schedule target names. */
export function tabOfScheduleTarget(scheduleTargetId: string): { scope: string; tab: TabEntry } | null {
  for (const [scope, tabs] of Object.entries(useTabsStore.getState().tabsByScope)) {
    const tab = tabs.find((t) => t.scheduleTargetId === scheduleTargetId);
    if (tab) return { scope, tab };
  }
  return null;
}

const AWAKE_POLL_MS = 250;

/**
 * For a caller about to type into a tab off screen (steering): wake it if it
 * is stopped, then wait until its input is ready. True when it is; false
 * after `timeoutMs`, or for a tab that is not there.
 */
export async function ensureAgentTabAwake(scheduleTargetId: string, timeoutMs = 60_000): Promise<boolean> {
  const found = tabOfScheduleTarget(scheduleTargetId);
  if (!found) return false;
  if (found.tab.stopped) wakeAgentTab(found.scope, found.tab.key);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (scheduledAgentInput(scheduleTargetId)?.ready()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, AWAKE_POLL_MS));
  }
}

/** {@link ensureAgentTabAwake} for a tab that is stopped now; nothing for
 *  one that is not (its caller waits for its pane as it always did). */
export async function wakeStoppedForInput(scheduleTargetId: string): Promise<void> {
  if (tabOfScheduleTarget(scheduleTargetId)?.tab.stopped) await ensureAgentTabAwake(scheduleTargetId);
}

/** Test seam. */
export function _resetAgentTabStopForTest(): void {
  pendingKill.clear();
}

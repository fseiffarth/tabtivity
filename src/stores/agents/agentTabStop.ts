/**
 * Stopping and waking one agent tab (`docs/agent_tab_stop_plan.md` §3–§4).
 *
 * Stop: the tab is marked `stopped`, so its pane (`PaneSlot`) unmounts the
 * `TerminalView`, whose teardown kills the PTY and its subtree (or the slot
 * kills a sleeping pane's parked PTY); then the tab's own minted tmux session,
 * if tmux wraps it, is ended — never a session it only attached to.
 *
 * Wake: the tab respawns on the args a restore would give it
 * (`resumeArgsOf`), with `stopped` and the first prompt cleared in the same
 * write, so nothing is typed again. The backend resolves the conversation to
 * resume (`services::agent_session::resolve_agent_session`).
 */
import { resumeArgsOf, useTabsStore, type TabEntry } from "../tabs";
import { noteAgentTabStarted } from "../../lib/agents/agentTabStopMarks";

/** The last-use mark moves only by at least this much, so it does not churn
 *  the layout's save debounce. */
export const LAST_USED_STEP_MS = 10 * 60_000;

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

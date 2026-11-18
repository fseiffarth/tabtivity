import { useEffect, useLayoutEffect } from "react";
import type { TabEntry } from "../../stores/tabs";
import { killAsleepPty } from "../../lib/terminal/sleepingPtys";
import { noteAgentPaneShown, noteAgentTabStarted } from "../../lib/agents/agentTabStopMarks";
import { noteAgentTabUsed, wakeAgentTab } from "../../stores/agents/agentTabStop";

/**
 * The pane layer's part in stopping agent tabs (`docs/agent_tab_stop_plan.md`
 * §3–§5), for one `PaneSlot`. Returns whether the tab is stopped, so the slot
 * renders `StoppedPane` in place of its `TabPane`.
 *
 *  - Reports whether the pane is on screen (`shown`: visible, in a popout, or
 *    drawn by another view) and when it was spawned, for the sweep's guards
 *    and ranking, and moves the tab's last-use mark when it is shown.
 *  - A stopped pane that was asleep has no view to kill its parked PTY: the
 *    slot does. An awake one unmounts its `TerminalView`, whose teardown kills.
 *  - A stopped tab shown wakes in the same commit, before paint.
 */
export function useAgentTabStopPane({
  tab,
  scopeKey,
  ptyId,
  shown,
}: {
  tab: Pick<TabEntry, "key" | "kind" | "stopped" | "relaunchSeq">;
  scopeKey: string;
  ptyId: string | null;
  shown: boolean;
}): boolean {
  const agent = tab.kind === "agent" && !!ptyId;
  const stopped = agent && !!tab.stopped;
  const key = tab.key;

  useEffect(() => {
    if (!agent || !ptyId) return;
    noteAgentPaneShown(ptyId, shown && !stopped);
    if (shown) noteAgentTabUsed(scopeKey, key);
  }, [agent, ptyId, shown, stopped, scopeKey, key]);

  useEffect(() => {
    if (!agent || !ptyId) return;
    return () => noteAgentPaneShown(ptyId, false);
  }, [agent, ptyId]);

  // A live pane mounted (or respawned by a relaunch): its agent starts now.
  useEffect(() => {
    if (agent && ptyId && !stopped) noteAgentTabStarted(ptyId);
  }, [agent, ptyId, stopped, tab.relaunchSeq]);

  useEffect(() => {
    if (stopped && ptyId) killAsleepPty(ptyId);
  }, [stopped, ptyId]);

  useLayoutEffect(() => {
    if (stopped && shown) wakeAgentTab(scopeKey, key);
  }, [stopped, shown, scopeKey, key]);

  return stopped;
}

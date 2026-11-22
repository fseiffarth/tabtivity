/**
 * What a stopped agent tab's pane renders (`docs/done/agent_tab_stop_plan.md`):
 * an empty box in place of its `TabPane`, so no `TerminalView` mounts and
 * nothing is spawned. A stopped tab is never on screen — the render that shows
 * it wakes it (`PaneSlot`) — so, like `SleepingPane`, this draws nothing.
 */
export function StoppedPane() {
  return <div className="sleeping-pane" data-stopped="agent" aria-hidden="true" />;
}

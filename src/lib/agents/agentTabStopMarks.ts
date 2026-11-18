/**
 * Runtime marks the stop sweep (`AgentTabStopHost`) reads per agent PTY
 * (`docs/agent_tab_stop_plan.md` §5–§6): whether its pane is on screen and
 * when it last was, when this window last started it, when the phone last
 * looked at it, and which tabs a restore brought back stopped. Plain module
 * state, written by the pane layer (`PaneSlot`), the phone bridge and the
 * layout load, so nothing here imports a store.
 */

const shownNow = new Set<string>();
const lastShown = new Map<string, number>();
const started = new Map<string, number>();
const phoneSeen = new Map<string, number>();
const restoredStopped = new Map<string, Set<string>>();

/** The pane layer: the tab's pane is (or stopped being) on screen — visible,
 *  in a popout, or drawn by another view. */
export function noteAgentPaneShown(ptyId: string, shown: boolean, now = Date.now()): void {
  if (shown) shownNow.add(ptyId);
  else if (shownNow.delete(ptyId)) lastShown.set(ptyId, now);
  if (shown) lastShown.set(ptyId, now);
}

/** Whether the tab's pane is on screen now. */
export function agentPaneShown(ptyId: string): boolean {
  return shownNow.has(ptyId);
}

/** When the tab was last on screen (now, while it is). */
export function agentPaneLastShownAt(ptyId: string, now = Date.now()): number | undefined {
  return shownNow.has(ptyId) ? now : lastShown.get(ptyId);
}

/** This window spawned or woke the tab's agent at `at`. */
export function noteAgentTabStarted(ptyId: string, at = Date.now()): void {
  started.set(ptyId, at);
}

/** When this window last spawned or woke the tab's agent. */
export function agentTabStartedAt(ptyId: string): number | undefined {
  return started.get(ptyId);
}

/** The phone opened, looked at or typed into the tab (`tab_seen`/`tab_input`). */
export function notePhoneSawTab(ptyId: string, at = Date.now()): void {
  phoneSeen.set(ptyId, at);
}

/** When the phone last looked at the tab. */
export function phoneSawTabAt(ptyId: string): number | undefined {
  return phoneSeen.get(ptyId);
}

/** The layout load restored these tabs of `scope` stopped, for the restore
 *  wake to consider once. */
export function noteRestoredStopped(scope: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const set = restoredStopped.get(scope) ?? new Set<string>();
  for (const key of keys) set.add(key);
  restoredStopped.set(scope, set);
}

/** Every tab restored stopped since the last take, as `scope → keys`; the
 *  registry is empty afterwards. */
export function takeRestoredStopped(): Map<string, Set<string>> {
  const out = new Map(restoredStopped);
  restoredStopped.clear();
  return out;
}

/** Forget a tab's marks (its pane went for good). */
export function forgetAgentTabMarks(ptyId: string): void {
  shownNow.delete(ptyId);
  lastShown.delete(ptyId);
  started.delete(ptyId);
  phoneSeen.delete(ptyId);
}

/** Test seam. */
export function _resetAgentTabStopMarksForTest(): void {
  shownNow.clear();
  lastShown.clear();
  started.clear();
  phoneSeen.clear();
  restoredStopped.clear();
}

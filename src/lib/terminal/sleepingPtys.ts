import { invoke } from "@tauri-apps/api/core";
import { useAgentTaskStore } from "../../stores/agents/agentTask";
import { splitPtyId } from "../../stores/activity";

/**
 * Sleeping terminal panes (performance plan §5.3, terminal kinds).
 *
 * A terminal tab hidden long enough is unmounted like a viewer — its xterm,
 * DOM and listeners released — but its PTY keeps running: the program does
 * not know its pane slept. This registry is what makes that hand-over safe.
 * An id is in it exactly while its owning pane is asleep (or waking): the PTY
 * is alive (or ended while asleep), and no `TerminalView` owns it.
 *
 *  - The pane layer (`PaneSlot`) marks the id in the render that swaps the
 *    pane for `SleepingPane` — before the commit, so the `TerminalView`
 *    unmounting in that commit sees it and parks instead of killing.
 *  - The unmounting view parks what a later owner needs ({@link parkPty}):
 *    its spawn identity, whether the program was up, and a stand-in for its
 *    scheduled-prompt registration, so the scheduler, steering and the phone
 *    still reach a sleeping agent.
 *  - The view mounted on wake finds the id, and — when its spawn identity is
 *    the parked one — attaches (`pty_scrollback` wake) instead of spawning; a
 *    changed identity (a relaunch, a container toggle while asleep) respawns,
 *    exactly as a mounted pane would have on that change.
 *  - Closing the tab while asleep: the slot's unmount kills the PTY
 *    ({@link killAsleepPty}) — no view exists to do it.
 *
 * Only an owning pane in the main window takes part; attach-only views
 * (popouts, the root console, an overlay's docked column) never read it.
 */
export interface ParkedPty {
  /** The spawn identity the sleeping view ran with (`terminalSpawnKey`),
   *  or null when no view owned a running PTY when the pane slept. */
  spawnKey: string | null;
  /** The program reported `terminal-ready` before the pane slept. */
  ready: boolean;
  /** When the program first printed, as the sleeping view saw it. */
  firstOutputAt: number | null;
  /** The program had drawn and gone quiet once (scheduled input `started`). */
  settled: boolean;
  /** Ends the parked scheduled-input registration. */
  release: (() => void) | null;
}

const asleep = new Map<string, ParkedPty>();

/** The pane of `id` is going to sleep (or already sleeps). Idempotent; the
 *  entry starts empty until the unmounting view parks into it. */
export function markPtyAsleep(id: string): void {
  if (asleep.has(id)) return;
  asleep.set(id, { spawnKey: null, ready: false, firstOutputAt: null, settled: false, release: null });
}

/** The parked state of `id`, when its pane sleeps — a read, nothing changes. */
export function asleepPty(id: string): ParkedPty | undefined {
  return asleep.get(id);
}

/**
 * The unmounting owner's state, kept for the wake. Fills an entry the pane
 * layer made; never creates one, so a view torn down after its tab's close
 * already released the id cannot resurrect it. Returns whether it parked.
 */
export function parkPty(id: string, state: Omit<ParkedPty, "release"> & { release?: (() => void) | null }): boolean {
  const entry = asleep.get(id);
  if (!entry) {
    state.release?.();
    return false;
  }
  entry.release?.();
  asleep.set(id, { ...state, release: state.release ?? null });
  return true;
}

/** The waking view takes the id over: the entry goes, and the parked
 *  scheduled-input stand-in with it (the view registers its own). */
export function takeAsleepPty(id: string): ParkedPty | undefined {
  const entry = asleep.get(id);
  if (!entry) return undefined;
  asleep.delete(id);
  entry.release?.();
  return entry;
}

/**
 * A sleeping pane's tab is gone (closed, its scope unloaded): kill its PTY and
 * reap the subtree, as the view's own unmount would have, and drop the task
 * title a reused key must not inherit. No-op when `id` is not asleep.
 */
export function killAsleepPty(id: string): boolean {
  if (!takeAsleepPty(id)) return false;
  invoke("pty_kill", { id }).catch(() => {});
  useAgentTaskStore.getState().clearTabTitle(splitPtyId(id)?.key ?? id);
  return true;
}

/** Test seam. */
export function _clearAsleepPtysForTest(): void {
  for (const entry of asleep.values()) entry.release?.();
  asleep.clear();
}

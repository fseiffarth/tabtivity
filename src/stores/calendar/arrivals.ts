import { create } from "zustand";

/** How long a row stays "arrived" — a little past the CSS animation, so a
 *  re-render mid-animation never drops the class early. */
export const ARRIVAL_MS = 1800;

interface ArrivalsState {
  /** Row id → the time (ms) its arrival mark expires. Only live marks are
   *  kept: the sweep below deletes each one as it expires. */
  until: Record<string, number>;
  markArrived: (ids: string[]) => void;
}

/**
 * Which rows just "flew in": an event or task a root agent
 * wrote over MCP that the window had not had before. The views give such a
 * row the `arrived` class, which plays a short arrival animation; nothing a
 * user does marks anything here.
 *
 * Session-only and tiny by construction: one sweep timer, aimed at the
 * earliest expiry, deletes what has run out and re-arms for what is left, so
 * the map never outlives the marks in it.
 */
export const useArrivalsStore = create<ArrivalsState>((set, get) => ({
  until: {},
  markArrived: (ids) => {
    if (ids.length === 0) return;
    const expires = Date.now() + ARRIVAL_MS;
    const until = { ...get().until };
    for (const id of ids) until[id] = expires;
    set({ until });
    armSweep();
  },
}));

let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function armSweep() {
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  const times = Object.values(useArrivalsStore.getState().until);
  if (times.length === 0) return;
  const next = Math.min(...times);
  sweepTimer = setTimeout(sweep, Math.max(0, next - Date.now()));
}

function sweep() {
  sweepTimer = null;
  const now = Date.now();
  const { until } = useArrivalsStore.getState();
  const kept: Record<string, number> = {};
  for (const [id, at] of Object.entries(until)) if (at > now) kept[id] = at;
  useArrivalsStore.setState({ until: kept });
  armSweep();
}

/** Whether row `id` is arrived right now — one boolean per subscriber. */
export function useArrived(id: string): boolean {
  return useArrivalsStore((s) => id in s.until);
}

/** The live marks, for a view that draws its rows inline (no per-row
 *  component to hold a hook). The object only changes when an agent write
 *  lands or a mark expires, so the view re-renders no more than that. */
export function useArrivedMarks(): Readonly<Record<string, number>> {
  return useArrivalsStore((s) => s.until);
}

/** Test helper: drop every mark and the pending sweep. */
export function resetArrivals() {
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  useArrivalsStore.setState({ until: {} });
}

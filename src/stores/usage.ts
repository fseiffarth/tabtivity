import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";

import type { BucketReport, Counters, Period } from "../lib/usageRollup";
import { countersForPeriod, dayKey } from "../lib/usageRollup";
import { isDetachedWindow } from "./detachedContext";

/** Mirrors `DETACHED_USAGE` in stores/detached (spelled here to keep this module
 *  free of that import: detached.ts imports this one). */
const DETACHED_USAGE_EVENT = "detached-usage";

/**
 * The usage counters behind the daily recap.
 *
 * Two halves:
 *
 * - **Recording** — a plain module-level accumulator (not store state: it churns
 *   on every keystroke and nothing renders off it, the same reason `activity.ts`
 *   keeps its per-PTY maps outside React). Counters are flushed to the backend on
 *   an interval and on window close, so a burst of typing costs one whole-file
 *   rewrite per flush rather than one per key.
 * - **Reading** — the zustand store proper, holding the report the recap renders.
 *
 * Scopes are the same ids tabs use: a project id, `"root"` for the root
 * terminal, or `"assistant"` (`lib/assistant.ASSISTANT_SCOPE`) for the Tabby
 * chats; the recap labels the last two (`StatsRecap`).
 */

/** The scope the root terminal's counters are filed under. */
export const ROOT_SCOPE = "root";

/** scope → metric → count, pending flush. Prototype-free: scope and metric
 *  names are used as keys, so `__proto__` must be an ordinary key here. */
let pending: Record<string, Counters> = Object.create(null);

/**
 * Tabs already counted as "active" (given ≥1 prompt) today, keyed `date|ptyId`.
 * `agent.active.*` answers "how many agent tabs did you actually use", so a tab
 * must contribute exactly once per day no matter how many prompts it gets — and
 * keying by date means a long-running tab counts again tomorrow.
 */
const activeSeen = new Set<string>();

/**
 * Accumulate `n` against a metric. The unit of every write path.
 *
 * `n` may be fractional — agent working time arrives as a sub-second slice per
 * activity tick. It is summed as a float here and only rounded at flush (see
 * {@link flushUsage}), so those slices add up to whole seconds instead of each
 * being floored to zero.
 */
export function bumpUsage(scope: string, key: string, n = 1): void {
  if (!scope || !key || !Number.isFinite(n) || n <= 0) return;
  // Group B #234: a popout's accumulator is never flushed (only the main shell
  // runs the interval and the quit flush), so a prompt typed in a popped-out
  // agent never reached the recap. Hand the bump to the main window instead.
  if (isDetachedWindow()) {
    void emit(DETACHED_USAGE_EVENT, { scope, key, n });
    return;
  }
  const counters = (pending[scope] ??= Object.create(null));
  counters[key] = (counters[key] ?? 0) + n;
}

/**
 * Count a tab as "used today" the first time it is asked something. Returns true
 * if this was its first prompt today (so the caller knows a counter moved).
 */
export function markAgentActive(scope: string, ptyId: string, activeKey: string): boolean {
  const seen = `${dayKey(Date.now())}|${ptyId}`;
  if (activeSeen.has(seen)) return false;
  activeSeen.add(seen);
  bumpUsage(scope, activeKey);
  return true;
}

/**
 * Push everything accumulated so far to the backend and clear it.
 *
 * Drains *before* awaiting, so counters recorded while the flush is in flight
 * land in the next batch rather than being dropped by the clear. A failed invoke
 * loses that batch — acceptable for a statistic, and far better than retrying
 * into an unbounded buffer.
 *
 * Counts are rounded to integers on the way out: the store is `u64`-typed, so a
 * fractional value would fail to deserialize and lose the whole batch. Anything
 * that rounds to zero is dropped rather than sent as a no-op.
 */
export async function flushUsage(): Promise<void> {
  const batch = pending;
  pending = Object.create(null);
  const payloads: [string, Counters][] = [];
  for (const [scope, counters] of Object.entries(batch)) {
    const metrics: Counters = Object.create(null);
    for (const [key, n] of Object.entries(counters)) {
      const rounded = Math.round(n);
      if (rounded > 0) metrics[key] = rounded;
    }
    if (Object.keys(metrics).length > 0) payloads.push([scope, metrics]);
  }
  if (payloads.length === 0) return;
  await Promise.all(
    payloads.map(([scope, metrics]) =>
      invoke("usage_bump", { projectId: scope, metrics }).catch(() => {}),
    ),
  );
}

/** Test seam: drop all pending counters and dedup state. */
export function _resetUsageForTest(): void {
  pending = Object.create(null);
  activeSeen.clear();
}

/** Test seam: read the pending batch without flushing it. */
export function _pendingUsageForTest(): Record<string, Counters> {
  return pending;
}

// ── Reading (the recap) ────────────────────────────────────────────────────

/** Commits/lines for a project, as `usage_git_stats` returns them. */
export interface GitStats {
  commits: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

interface UsageStore {
  /** Every project's counters, summed — the recap is a global view. */
  report: BucketReport<Counters> | null;
  loading: boolean;
  load: () => Promise<void>;
  /** Counters for one period, anchored on a day. */
  countersFor: (period: Period, anchorMs: number) => Counters;
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  report: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    // Empty projectId = summed across every project, which is what the recap
    // shows; the per-project split it needs comes from the time store.
    const report = await invoke<BucketReport<Counters>>("usage_summary", {
      projectId: "",
    }).catch(() => ({ hours: {}, days: {} }));
    set({ report, loading: false });
  },

  countersFor: (period, anchorMs) => {
    const report = get().report;
    if (!report) return {};
    return countersForPeriod(report, period, anchorMs);
  },
}));

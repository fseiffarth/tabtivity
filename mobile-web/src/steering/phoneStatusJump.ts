/**
 * The phone's Q R X jumps, pure. Named apart from the desktop's
 * `src/lib/shortcuts/statusJump.ts`, which imports stores. Candidates come from
 * `getActivity()` in list order and the walk wraps; "done" is the phone's own
 * unseen-done (what Home's Needs you lists), not every finished tab.
 */
import type { ActivityTab, TabRow } from "../api";
import { isUnseenDone, readSeenDone, type SeenDone } from "../seenDone";

/** `ask`: waiting on a decision or interrupted (the Waiting tile counts both). */
export type StatusKind = "ask" | "working" | "done";

/** The kind a tab's status falls in, or null for none. A "done" here is not yet filtered by what this phone has seen. */
export function kindOf(tab: Pick<TabRow, "agent_status">): StatusKind | null {
  switch (tab.agent_status) {
    case "question":
    case "interrupted":
      return "ask";
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      return null;
  }
}

function matches(tab: ActivityTab, kind: StatusKind, seen: SeenDone): boolean {
  if (!tab.available) return false;
  if (kind === "done") return isUnseenDone(seen, tab);
  return kindOf(tab) === kind;
}

/** How many tabs the jump of each kind could reach, for the legend's counts. */
export function statusCounts(list: readonly ActivityTab[], seen: SeenDone = readSeenDone()): Record<StatusKind, number> {
  const out: Record<StatusKind, number> = { ask: 0, working: 0, done: 0 };
  for (const kind of Object.keys(out) as StatusKind[]) out[kind] = list.filter((tab) => matches(tab, kind, seen)).length;
  return out;
}

/**
 * The next tab of `kind` after `currentTabId` in list order (before it, with
 * `backwards`), wrapping; from the first or last when the current tab is not in
 * the list. Never the current tab itself, so null also means "nothing else".
 * Tabs that are not `available` are skipped.
 */
export function nextStatusTab(
  list: readonly ActivityTab[],
  currentTabId: string | null,
  kind: StatusKind,
  backwards = false,
  seen: SeenDone = readSeenDone(),
): ActivityTab | null {
  const at = currentTabId === null ? -1 : list.findIndex((tab) => tab.id === currentTabId);
  const found = list
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => tab.id !== currentTabId && matches(tab, kind, seen));
  if (found.length === 0) return null;
  if (backwards) return (found.filter(({ index }) => index < at).pop() ?? found[found.length - 1]).tab;
  return (found.find(({ index }) => index > at) ?? found[0]).tab;
}

/**
 * The order the Agents views (desktop `AgentSchedulesView`, phone `Activity`)
 * list agent tabs in. Shared so the two cannot disagree about what "last
 * working" means: the laptop and the phone show the same tabs, and a reader
 * who switches between them should find them in the same places.
 *
 * - `lastWorking`: what to look at next, in three tiers — a tab that has
 *   stopped to ask something, then the tabs working right now, then everything
 *   else by the last turn it finished, most recent first. The default. The
 *   tiers are the point: a question is the only thing on this list that cannot
 *   make progress without the reader, so it outranks any timestamp; a working
 *   tab needs nothing but time; and once neither applies, the newest finished
 *   answer is the one to read. Within the first two tiers the tabs keep their
 *   arrival order — a tab that is working right now has no reading that would
 *   order it (its `workingAt` is the last turn's edge, not this one's), and
 *   shuffling the questions would move them under the pointer as they arrive.
 *   The phone adds one tier below the working tabs: a tab holding a message
 *   typed on the phone and not sent yet (`drafted`) — the reader started
 *   something there and is the one it waits on, more than any finished turn.
 *   The desktop never knows of a phone draft and passes none.
 * - `lastDone`: by the last turn each agent finished, most recent first. The
 *   triage order with no tiers over it: what finished last, whatever else the
 *   tabs are doing now.
 * - `native`: the order the list arrived in — the tab bar's on the desktop, the
 *   sidecar's (waiting first, finished last) on the phone.
 *
 * Ties (and tabs with no reading — one restored this session that has not
 * finished a turn yet) keep their arrival order, so a sort is a stable
 * reordering and a tab with nothing to say sinks to the bottom of its tier
 * rather than jumping around.
 */
export type AgentSort = "lastWorking" | "lastDone" | "native";

export const AGENT_SORTS: readonly AgentSort[] = ["lastWorking", "lastDone", "native"];
export const DEFAULT_AGENT_SORT: AgentSort = "lastWorking";

export interface AgentSortKeys {
  /** Stopped and waiting on the reader — the top tier of `lastWorking`. */
  decision?: boolean;
  /** Producing output right now — the second tier of `lastWorking`. */
  working: boolean;
  /** Holds a typed, unsent message — the third tier of `lastWorking`. */
  drafted?: boolean;
  /** ms epoch of the tab's last output while working, if seen this session. */
  workingAt?: number;
  /** ms epoch of the tab's last finished turn, if seen this session. */
  doneAt?: number;
}

export function isAgentSort(value: unknown): value is AgentSort {
  return typeof value === "string" && (AGENT_SORTS as readonly string[]).includes(value);
}

/** 3 needs the reader, 2 is busy, 1 holds a draft, 0 is none of these —
 * `lastWorking`'s tiers. */
function tierOf(keys: AgentSortKeys): number {
  if (keys.decision) return 3;
  if (keys.working) return 2;
  return keys.drafted ? 1 : 0;
}

export function sortAgentTabs<T>(tabs: readonly T[], sort: AgentSort, keysOf: (tab: T) => AgentSortKeys): T[] {
  if (sort === "native") return [...tabs];
  return tabs
    .map((tab, index) => ({ tab, index, keys: keysOf(tab) }))
    .sort((a, b) => {
      if (sort === "lastWorking") {
        const tier = tierOf(a.keys);
        const byTier = tierOf(b.keys) - tier;
        if (byTier !== 0) return byTier;
        // A question and a working tab are ordered by nothing but the tab bar:
        // neither carries a reading of what it is doing *now*.
        if (tier >= 2) return a.index - b.index;
      }
      // The drafted and bottom tiers, and the whole of `lastDone`: newest
      // finished turn first, a tab that has finished none of them last.
      const byDone = (b.keys.doneAt ?? Number.NEGATIVE_INFINITY) - (a.keys.doneAt ?? Number.NEGATIVE_INFINITY);
      // Two infinities subtract to NaN, which is the tie the index settles.
      return Number.isNaN(byDone) || byDone === 0 ? a.index - b.index : byDone;
    })
    .map((entry) => entry.tab);
}

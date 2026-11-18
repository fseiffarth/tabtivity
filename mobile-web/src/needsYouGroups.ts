// Home's Needs you groups, as pure filters over the activity list, so the
// screen and the spoken "the done tab" / "the waiting tab" (`voiceNav.ts`)
// read the same tabs in the same order.
import { type ActivityTab } from "./api";
import { isUnseenDone, type SeenDone } from "./seenDone";

/** When the row's state began, as the desktop stamped it: a question since its
 * last output, a finished tab since its turn ended. */
export function since(tab: ActivityTab): number | undefined {
  return tab.agent_status === "done" ? tab.done_at : tab.working_at ?? tab.done_at;
}

/** The two agent groups of Needs you: tabs asking something or cut off (a
 * question first, then the newest of each), and finished tabs this phone has
 * not opened yet (newest first). */
export function needsYouGroups(tabs: readonly ActivityTab[], seen: SeenDone): { asking: ActivityTab[]; finished: ActivityTab[] } {
  const asking = tabs
    .filter((tab) => tab.agent_status === "question" || tab.agent_status === "interrupted")
    // A question first: it is the one thing that cannot go on without the
    // reader. Then the newest of each.
    .sort((a, b) => Number(b.agent_status === "question") - Number(a.agent_status === "question") || (since(b) ?? 0) - (since(a) ?? 0));
  const finished = tabs
    .filter((tab) => isUnseenDone(seen, tab))
    .sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
  return { asking, finished };
}

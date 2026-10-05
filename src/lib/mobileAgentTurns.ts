/**
 * Which agent-turn changes become a push notice on the phone
 * (`docs/tabtivity_mobile_future_plan.md` §A).
 *
 * Only the desktop sees a transition — the sidecar gets snapshots — so the
 * edges are found here, from the same per-tab state the phone's lists show
 * (`MobileBridgeHost`'s `mobileAgentState`). What is sent is the tmux name and
 * the edge; the sidecar resolves the tab, decides whether a phone is already
 * looking at it, and applies each phone's choices and the per-tab cooldown.
 */

export type MobileAgentState = "working" | "question" | "interrupted" | "done" | "idle";

export interface AgentTurnEdge {
  tmuxSession: string;
  status: "question" | "done";
}

/**
 * The edges between two snapshots, keyed by tmux session.
 *
 * - into `question` from anything else: the session stalls until answered.
 * - `working` → `done`: a turn finished. `idle` → `done` is not one — that is
 *   an old finished turn resurfacing (a read mark moving back), not news.
 *
 * A tab seen for the first time is never an edge: the window starting, or a
 * project being opted in, must not replay every question already open.
 */
export function agentTurnEdges(
  previous: ReadonlyMap<string, MobileAgentState>,
  next: ReadonlyMap<string, MobileAgentState>,
): AgentTurnEdge[] {
  const edges: AgentTurnEdge[] = [];
  for (const [tmuxSession, state] of next) {
    const before = previous.get(tmuxSession);
    if (before === undefined || before === state) continue;
    if (state === "question") edges.push({ tmuxSession, status: "question" });
    else if (state === "done" && before === "working") edges.push({ tmuxSession, status: "done" });
  }
  return edges;
}

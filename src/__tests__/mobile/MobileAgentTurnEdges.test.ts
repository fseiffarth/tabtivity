import { describe, expect, it } from "vitest";
import { agentTurnEdges, type MobileAgentState } from "../../lib/mobileAgentTurns";

const snap = (entries: [string, MobileAgentState][]) => new Map(entries);

/** Which agent-turn changes become a push notice on the phone. */
describe("agent turn edges", () => {
  it("reports a tab that starts waiting on an answer, from any other state", () => {
    expect(agentTurnEdges(snap([["a", "working"], ["b", "idle"], ["c", "done"]]), snap([["a", "question"], ["b", "question"], ["c", "question"]])))
      .toEqual([
        { tmuxSession: "a", status: "question" },
        { tmuxSession: "b", status: "question" },
        { tmuxSession: "c", status: "question" },
      ]);
  });

  it("reports a finished turn only when it follows work", () => {
    expect(agentTurnEdges(snap([["a", "working"], ["b", "idle"], ["c", "question"]]), snap([["a", "done"], ["b", "done"], ["c", "done"]])))
      .toEqual([{ tmuxSession: "a", status: "done" }]);
  });

  it("stays quiet for an unchanged tab, a tab going back to work, and a first sighting", () => {
    expect(agentTurnEdges(snap([["a", "question"], ["b", "done"]]), snap([["a", "question"], ["b", "working"], ["new", "question"]])))
      .toEqual([]);
  });

  it("sends no notice for a turn the user cut off, nor for the idle notice after it", () => {
    expect(agentTurnEdges(snap([["a", "working"], ["b", "interrupted"]]), snap([["a", "interrupted"], ["b", "done"]])))
      .toEqual([]);
  });
});

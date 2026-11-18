/**
 * The phone's Q R X jumps (`mobile-web/src/steering/phoneStatusJump`): which
 * tabs count for each key, the walk, and "done" meaning unseen-done.
 */
import { describe, expect, it } from "vitest";
import type { ActivityTab, AgentStatus } from "../../../mobile-web/src/api";
import { kindOf, nextStatusTab, statusCounts } from "../../../mobile-web/src/steering/phoneStatusJump";
import type { SeenDone } from "../../../mobile-web/src/seenDone";

let n = 0;
function tab(id: string, status: AgentStatus | undefined, extra: Partial<ActivityTab> = {}): ActivityTab {
  n += 1;
  return { id, label: id, kind: "agent", agent_status: status, available: true, viewer_busy: false, project_id: `p${n % 2}`, project_label: "P", ...extra };
}
const NONE: SeenDone = [];
const ids = (list: ActivityTab[], current: string | null, kind: Parameters<typeof nextStatusTab>[2], back = false, seen = NONE) =>
  nextStatusTab(list, current, kind, back, seen)?.id ?? null;

describe("kindOf", () => {
  it("groups a question and an interruption as asking", () => {
    expect(kindOf({ agent_status: "question" })).toBe("ask");
    expect(kindOf({ agent_status: "interrupted" })).toBe("ask");
    expect(kindOf({ agent_status: "working" })).toBe("working");
    expect(kindOf({ agent_status: "done" })).toBe("done");
    expect(kindOf({})).toBeNull();
  });
});

describe("nextStatusTab", () => {
  const list = [tab("a", "question"), tab("b", "working"), tab("c", "question"), tab("d", "interrupted"), tab("e", "done", { done_at: 5 })];

  it("walks forward from the current tab in list order and wraps", () => {
    expect(ids(list, "a", "ask")).toBe("c");
    expect(ids(list, "c", "ask")).toBe("d");
    expect(ids(list, "d", "ask")).toBe("a");
  });

  it("walks backwards with Shift and wraps", () => {
    expect(ids(list, "c", "ask", true)).toBe("a");
    expect(ids(list, "a", "ask", true)).toBe("d");
  });

  it("continues from a current tab that is not itself a candidate", () => {
    expect(ids(list, "b", "ask")).toBe("c");
    expect(ids(list, "b", "ask", true)).toBe("a");
    expect(ids(list, "e", "ask")).toBe("a");
  });

  it("starts at the first (last, backwards) with no current tab or one the list lacks", () => {
    expect(ids(list, null, "ask")).toBe("a");
    expect(ids(list, null, "ask", true)).toBe("d");
    expect(ids(list, "gone", "ask")).toBe("a");
    expect(ids(list, "gone", "ask", true)).toBe("d");
  });

  it("finds working tabs on their own", () => {
    expect(ids(list, "a", "working")).toBe("b");
  });

  it("answers null when nothing matches, and never the current tab itself", () => {
    expect(ids(list, "a", "done", false, [["e", 5]])).toBeNull();
    expect(ids([tab("only", "question")], "only", "ask")).toBeNull();
    expect(ids([], null, "ask")).toBeNull();
    expect(ids([tab("w", "working")], null, "ask")).toBeNull();
  });

  it("skips tabs that are not available", () => {
    const gone = [tab("a", "question", { available: false }), tab("b", "question"), tab("c", "question", { available: false })];
    expect(ids(gone, null, "ask")).toBe("b");
    expect(ids(gone, "b", "ask")).toBeNull();
  });

  it("counts only finished tabs this phone has not seen as done", () => {
    expect(ids(list, "a", "done")).toBe("e");
    expect(ids(list, "a", "done", false, [["e", 5]])).toBeNull();
    expect(ids(list, "a", "done", false, [["e", 4]])).toBe("e");
    expect(ids(list, "a", "done", false, [["other", 9]])).toBe("e");
  });
});

describe("statusCounts", () => {
  it("counts what each key could reach", () => {
    const list = [tab("a", "question"), tab("b", "interrupted"), tab("c", "working"), tab("d", "done", { done_at: 1 }), tab("e", "done", { done_at: 1 }), tab("f", "working", { available: false })];
    expect(statusCounts(list, [["e", 1]])).toEqual({ ask: 2, working: 1, done: 1 });
    expect(statusCounts([], NONE)).toEqual({ ask: 0, working: 0, done: 0 });
  });
});

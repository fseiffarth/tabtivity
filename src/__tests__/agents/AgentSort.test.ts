import { describe, expect, it } from "vitest";
import { isAgentSort, sortAgentTabs } from "../../../shared/agentSort";
import { claudeModelLabel, shortModelName } from "../../lib/agents/agentModel";

interface Row { id: string; decision?: boolean; working?: boolean; drafted?: boolean; workingAt?: number; doneAt?: number }
const keys = (row: Row) => ({ decision: row.decision, working: !!row.working, drafted: row.drafted, workingAt: row.workingAt, doneAt: row.doneAt });
const ids = (rows: Row[]) => rows.map((row) => row.id);

describe("agent tab sorting (shared by the desktop and the phone)", () => {
  const rows: Row[] = [
    { id: "quiet" },
    { id: "old", workingAt: 100, doneAt: 900 },
    { id: "busy", working: true, workingAt: 50, doneAt: 10 },
    { id: "recent", workingAt: 500, doneAt: 400 },
    { id: "quiet-2" },
  ];

  it("asks first, then works, then the newest finished turn, and the unseen last in their own order", () => {
    const asking: Row[] = [
      ...rows,
      // A question outranks a working tab even while it is producing output,
      // and even with a fresher finished turn behind the tabs below it.
      { id: "asking", decision: true, working: true, workingAt: 10, doneAt: 5 },
      { id: "asking-2", decision: true, doneAt: 20 },
    ];
    expect(ids(sortAgentTabs(asking, "lastWorking", keys)))
      .toEqual(["asking", "asking-2", "busy", "old", "recent", "quiet", "quiet-2"]);
  });

  it("keeps the questions and the working tabs in tab order, having no reading of what they are doing now", () => {
    const asking: Row[] = [
      { id: "busy-2", working: true, doneAt: 900 },
      { id: "asking-2", decision: true, doneAt: 100 },
      { id: "busy-1", working: true, doneAt: 10 },
      { id: "asking-1", decision: true, doneAt: 800 },
    ];
    expect(ids(sortAgentTabs(asking, "lastWorking", keys)))
      .toEqual(["asking-2", "asking-1", "busy-2", "busy-1"]);
  });

  it("lifts a tab holding a phone draft under the working ones, newest finished turn first among them", () => {
    const drafted: Row[] = [
      ...rows,
      { id: "draft-old", drafted: true, doneAt: 50 },
      { id: "draft-new", drafted: true, doneAt: 950 },
      { id: "draft-unseen", drafted: true },
      // Asking or working outranks the draft it also holds.
      { id: "asking-draft", decision: true, drafted: true },
    ];
    expect(ids(sortAgentTabs(drafted, "lastWorking", keys)))
      .toEqual(["asking-draft", "busy", "draft-new", "draft-old", "draft-unseen", "old", "recent", "quiet", "quiet-2"]);
    // The other orders have no tiers, so a draft moves nothing there.
    expect(ids(sortAgentTabs(drafted, "lastDone", keys))[0]).toBe("draft-new");
    expect(ids(sortAgentTabs(drafted, "native", keys))).toEqual(ids(drafted));
  });

  it("orders by the last finished turn, ignoring what is working now or asking", () => {
    expect(ids(sortAgentTabs(rows, "lastDone", keys))).toEqual(["old", "recent", "busy", "quiet", "quiet-2"]);
  });

  it("leaves the native order alone and copies rather than mutating", () => {
    const sorted = sortAgentTabs(rows, "native", keys);
    expect(ids(sorted)).toEqual(ids(rows));
    expect(sorted).not.toBe(rows);
    expect(isAgentSort("lastDone")).toBe(true);
    expect(isAgentSort("newest")).toBe(false);
    expect(isAgentSort(null)).toBe(false);
  });
});

describe("model tag", () => {
  it("drops the vendor prefix and the date, and leaves the rest as it is", () => {
    expect(shortModelName("claude-opus-4-1-20250805")).toBe("opus-4-1");
    expect(shortModelName("claude-fable-5-1")).toBe("fable-5-1");
    expect(shortModelName("gpt-5-codex")).toBe("gpt-5-codex");
    expect(shortModelName("  o3 ")).toBe("o3");
  });

  it("puts a Claude slug in the words Claude's status line uses", () => {
    expect(claudeModelLabel("opus-4-1")).toBe("Opus 4.1");
    expect(claudeModelLabel("fable-5")).toBe("Fable 5");
    expect(claudeModelLabel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(claudeModelLabel("Opus 4.1")).toBe("Opus 4.1");
  });
});

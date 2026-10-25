import { describe, expect, it } from "vitest";
import { fallbackColumnId } from "../../../shared/todoColumns";
import { delayMinutes } from "../../../shared/scheduleDelay";

describe("shared/todoColumns fallbackColumnId", () => {
  const cols = [
    { id: "overdue", overdue: true },
    { id: "today", due_today: true },
    { id: "doing" },
    { id: "backlog", intake: true },
    { id: "done", done: true },
    { id: "archived", archived: true },
  ];

  it("prefers the intake column, then the first open non-date column, then any open one", () => {
    expect(fallbackColumnId(cols)).toBe("backlog");
    expect(fallbackColumnId(cols.filter((c) => c.id !== "backlog"))).toBe("doing");
    expect(fallbackColumnId([{ id: "overdue", overdue: true }, { id: "done", done: true }])).toBe("overdue");
  });

  it("answers an empty id for no columns, and the first column when nothing qualifies", () => {
    expect(fallbackColumnId([])).toBe("");
    expect(fallbackColumnId([{ id: "done", done: true }])).toBe("done");
  });
});

describe("shared/scheduleDelay delayMinutes", () => {
  it("counts whole minutes ahead and refuses everything else", () => {
    expect(delayMinutes("1", "30")).toBe(90);
    expect(delayMinutes("", "5")).toBe(5);
    for (const [h, m] of [["", ""], ["0", "0"], ["-1", "0"], ["1.5", "0"], ["x", "1"]]) expect(delayMinutes(h, m)).toBeNull();
  });
});

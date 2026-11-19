import { describe, expect, it } from "vitest";
import { ceilPromptTime } from "../../lib/agents/prompt/chart";
import { composeIsReset, composeOffered, composeReset, composeSubmitKey } from "../../lib/agents/prompt/compose";
import type { UsageResetMark } from "../../lib/agents/agentUsageResets";

const now = new Date(2026, 8, 4, 12, 2);
const mark = (agent: string, kind: "session" | "week", at: Date): UsageResetMark =>
  ({ key: `${agent}:${kind}:${at.getTime()}`, agent, kind, at, labels: [], percent: 50, resets: "" });

describe("ceilPromptTime", () => {
  it("rounds up to the next step of the local wall clock and keeps an exact step", () => {
    expect(ceilPromptTime(new Date(2026, 8, 4, 14, 20))).toEqual(new Date(2026, 8, 4, 14, 20));
    expect(ceilPromptTime(new Date(2026, 8, 4, 14, 21))).toEqual(new Date(2026, 8, 4, 14, 25));
    expect(ceilPromptTime(new Date(2026, 8, 4, 14, 20, 1))).toEqual(new Date(2026, 8, 4, 14, 25));
    expect(ceilPromptTime(new Date(2026, 8, 4, 14, 1), 15)).toEqual(new Date(2026, 8, 4, 14, 15));
  });
});

describe("the composer's When choices", () => {
  const marks = [
    mark("claude", "session", new Date(2026, 8, 4, 14, 20)),
    mark("claude", "week", new Date(2026, 8, 7, 9)),
    mark("claude", "session", new Date(2026, 8, 4, 11, 0)),
    mark("codex", "session", new Date(2026, 8, 4, 15, 45)),
  ];

  it("names the submit after what the choice does", () => {
    expect(["draft", "after"].map((when) => composeSubmitKey(when as "draft"))).toEqual(["promptChart.compose.add", "promptChart.compose.add"]);
    expect(composeSubmitKey("now")).toBe("promptChart.compose.send");
    expect(["time", "session", "week"].map((when) => composeSubmitKey(when as "time"))).toEqual(Array(3).fill("promptChart.compose.schedule"));
    expect(composeIsReset("session") && composeIsReset("week") && !composeIsReset("time")).toBe(true);
  });

  it("lands a reset choice on the first snap minute at or after the agent's next reset, never one already gone", () => {
    expect(composeReset(marks, "claude", "session", now)?.at).toEqual(new Date(2026, 8, 4, 14, 20));
    expect(composeReset(marks, "claude", "week", now)?.at).toEqual(new Date(2026, 8, 7, 9, 0));
    expect(composeReset([mark("claude", "session", new Date(2026, 8, 4, 14, 22))], "claude", "session", now)?.at)
      .toEqual(new Date(2026, 8, 4, 14, 25));
    expect(composeReset(marks, "codex", "week", now)).toBeNull();
    expect(composeReset(marks, undefined, "session", now)).toBeNull();
  });

  it("offers the two reset choices only for an agent that has the mark", () => {
    expect(composeOffered(marks, "claude", now).map((item) => item.when)).toEqual(["draft", "now", "time", "after", "session", "week"]);
    expect(composeOffered(marks, "codex", now).map((item) => item.when)).toEqual(["draft", "now", "time", "after", "session"]);
    expect(composeOffered([], "claude", now).map((item) => item.when)).toEqual(["draft", "now", "time", "after"]);
  });
});

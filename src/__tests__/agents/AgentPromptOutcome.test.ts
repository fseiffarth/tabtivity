import { describe, expect, it } from "vitest";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { livePromptStates, promptOutcome } from "../../lib/agents/prompt/outcome";
import { promptStateChip } from "../../lib/agents/prompt/stateChip";
import { sentFactLine } from "../../lib/agents/prompt/cardFacts";
import { packLanes, timelineWindow } from "../../lib/agents/prompt/timeline";

const now = new Date(2026, 8, 4, 12, 2);
const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);

function sent(id: string, over: { strand?: string; start?: Date; filesAt?: Date; result?: "delivered" | "missed" | "failed"; files?: string[] } = {}): PromptChartCard {
  const start = over.start ?? at(9);
  return {
    key: `history:${id}`, id, state: "sent", message: id, tags: [], autoTags: [], strandId: over.strand ?? "strand:t", at: start, recurring: false,
    history: {
      id, message: id, created_at: "x", sent_at: start.toISOString(), tab_label: "Claude", result: over.result ?? "delivered",
      files_at: over.filesAt?.toISOString(), files: over.files,
    },
  };
}
const t = (key: string, params?: Record<string, number | string>) =>
  `${key}${params ? JSON.stringify(params) : ""}`;

describe("livePromptStates", () => {
  const rows = [sent("old", { start: at(8), filesAt: at(8, 5) }), sent("new", { start: at(11, 50) })];

  it("marks only the newest delivered row of a working tab, and only while its turn is unfinished", () => {
    expect(livePromptStates(rows, () => "working")).toEqual(new Map([["new", "running"]]));
    expect(livePromptStates(rows, () => "needs-decision")).toEqual(new Map([["new", "needsAnswer"]]));
    expect(livePromptStates(rows, () => "finished").size).toBe(0);
    expect(livePromptStates(rows, () => undefined).size).toBe(0);
    // A row already stamped finished means the tab works on something typed later.
    expect(livePromptStates([sent("done", { filesAt: at(9, 6) })], () => "working").size).toBe(0);
  });

  it("keeps each strand's own newest row, and never marks a missed or failed one", () => {
    const other = sent("other", { strand: "strand:u", start: at(11) });
    expect(livePromptStates([...rows, other], () => "working")).toEqual(new Map([["new", "running"], ["other", "running"]]));
    expect(livePromptStates([sent("m", { result: "missed" }), sent("f", { result: "failed", start: at(10) })], () => "working").size).toBe(0);
  });
});

describe("promptOutcome", () => {
  it("reads finished from the stamp, delivered without one, and measures a live turn to now", () => {
    expect(promptOutcome([sent("a", { filesAt: at(9, 6), files: ["x", "y"] })], undefined, now)).toEqual({ kind: "finished", durationMs: 6 * 60_000, files: 2 });
    expect(promptOutcome([sent("b")], undefined, now)).toEqual({ kind: "delivered", durationMs: null, files: 0 });
    expect(promptOutcome([sent("c", { start: at(11, 50) })], "running", now)).toMatchObject({ kind: "running", durationMs: 12 * 60_000 });
    expect(promptOutcome([sent("d", { result: "failed" })], "running", now).kind).toBe("failed");
  });
});

describe("the outcome chip and the fact line", () => {
  it("words each outcome", () => {
    expect(promptStateChip(sent("a", { filesAt: at(9, 6) }), [])).toMatchObject({ key: "promptChart.outcome.finished", tone: "finished" });
    expect(promptStateChip(sent("b"), [])).toMatchObject({ key: "promptChart.result.delivered" });
    expect(promptStateChip(sent("c"), [], "running")).toMatchObject({ key: "promptChart.outcome.running", tone: "running" });
    expect(promptStateChip(sent("d"), [], "needsAnswer")).toMatchObject({ key: "promptChart.outcome.needsAnswer", tone: "needs" });
    expect(promptStateChip(sent("e", { result: "missed" }), [], "running")).toMatchObject({ key: "promptChart.result.missed" });
  });

  it("writes the length so far for a live turn, the reasons for a missed or failed row", () => {
    expect(sentFactLine([sent("a", { start: at(11, 50) })], t, { state: "running", now })).toContain("promptChart.soFar");
    expect(sentFactLine([sent("a", { start: at(11, 50) })], t, { state: "needsAnswer", now })).toContain("promptChart.waitingForAnswer");
    expect(sentFactLine([sent("m", { result: "missed" })], t)).toBe("promptChart.missedFact");
    expect(sentFactLine([sent("f", { result: "failed" })], t)).toBe("promptChart.failedFact");
    expect(sentFactLine([sent("a", { filesAt: at(9, 6), files: ["x"] })], t)).toBe('promptChart.durationMin{"count":6} · promptChart.filesOne{"count":1}');
  });
});

describe("a running turn on the lanes", () => {
  const day = timelineWindow("day", "2026-09-04", 1);
  const item = (card: PromptChartCard) => ({ key: card.key, card, at: card.at! });

  it("ends at the now line and its bar grows with now, where a stamped one stops at its finish", () => {
    const card = sent("r", { start: at(10) });
    const running = new Set(["r"]);
    // 2400px: 100px an hour; now 12:02 is x 1203.3, the turn began at x 1000.
    const [early] = packLanes([item(card)], day, 2400, now, undefined, undefined, running).items;
    expect(early.anchor).toBe("right");
    expect(early.barWidth).toBeCloseTo(168, 6);
    const [soon] = packLanes([item(sent("r", { start: at(11, 40) }))], day, 2400, new Date(2026, 8, 4, 11, 50), undefined, undefined, running).items;
    expect(soon.barWidth).toBeCloseTo(100 / 6, 3);
    // Without the live word the same row is only a point.
    expect(packLanes([item(card)], day, 2400, now).items[0].barWidth).toBe(4);
  });
});

import { describe, expect, it } from "vitest";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { nextPendingStep, promptSequences, resumeSendsAtOnce, sequencePlaces, skipPlan, stopEdge } from "../../lib/agents/prompt/sequences";
import type { PromptLink } from "../../stores/agents/agentPrompts";

const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);

function card(id: string, state: PromptChartCard["state"], over: Partial<PromptChartCard> = {}): PromptChartCard {
  return { key: `${state}:${id}`, id, state, message: id, tags: [], autoTags: [], strandId: "s", at: null, recurring: false, ...over };
}
const sent = (id: string, over: { result?: "delivered" | "missed" | "failed"; filesAt?: Date; start?: Date } = {}) => {
  const start = over.start ?? at(9);
  return card(id, "sent", {
    at: start,
    history: { id, message: id, created_at: "x", sent_at: start.toISOString(), tab_label: "Claude", result: over.result ?? "delivered", files_at: over.filesAt?.toISOString() },
  });
};
const edge = (from: string, to: string, over: Partial<PromptLink> = {}): PromptLink => ({ id: `${from}>${to}`, from, to, kind: "after", ...over });

describe("promptSequences", () => {
  it("reads an after chain in order across a sent row, a rule and drafts, with a status per step", () => {
    const cards = [
      sent("a", { filesAt: at(9, 11) }),
      card("b", "scheduled", { at: at(13) }),
      card("c", "chained"),
      card("d", "chained"),
      card("loose", "draft"),
    ];
    const [sequence] = promptSequences(cards, [edge("a", "b"), edge("b", "c"), edge("c", "d")]);
    expect(sequence.steps.map((step) => [step.card.id, step.n, step.status])).toEqual([
      ["a", 1, "done"], ["b", 2, "next"], ["c", 3, "waiting"], ["d", 4, "waiting"],
    ]);
    expect(sequence).toMatchObject({ id: "a", status: "waiting", current: 2, done: 1, running: 0, pending: 3 });
    expect(promptSequences(cards, [edge("a", "b")])).toHaveLength(1);
  });

  it("marks the running step from the live states, and the pending ones after it as waiting", () => {
    const cards = [sent("a"), card("b", "chained"), card("c", "chained")];
    const [sequence] = promptSequences(cards, [edge("a", "b"), edge("b", "c")], new Map([["a", "running" as const]]));
    expect(sequence.steps.map((step) => step.status)).toEqual(["running", "waiting", "waiting"]);
    expect(sequence.status).toBe("running");
    expect(sequence.current).toBe(1);
  });

  it("matches a recurring source's rows, id@occurrence, and speaks for it by the newest", () => {
    const cards = [sent("a@2026-09-03T09:00", { start: at(8) }), sent("a@2026-09-04T09:00", { filesAt: at(9, 5) }), card("b", "chained")];
    const [sequence] = promptSequences(cards, [edge("a", "b")]);
    expect(sequence.steps[0].card.id).toBe("a@2026-09-04T09:00");
    expect(sequence.steps.map((step) => step.status)).toEqual(["done", "next"]);
  });

  it("reads a paused edge as a paused step and a failed source as stopped", () => {
    const paused = promptSequences([sent("a", { filesAt: at(9, 5) }), card("b", "chained")], [edge("a", "b", { paused: true })])[0];
    expect(paused.steps[1].status).toBe("paused");
    expect(paused.status).toBe("paused");
    const stopped = promptSequences([sent("a", { result: "failed" }), card("b", "chained", { chainStopped: true })], [edge("a", "b")])[0];
    expect(stopped.steps.map((step) => step.status)).toEqual(["stopped", "stopped"]);
    expect(stopped.status).toBe("stopped");
  });

  it("is done when every step is, and leaves out joins, forks, loops, single edges and session rolls", () => {
    expect(promptSequences([sent("a", { filesAt: at(9, 5) }), sent("b", { filesAt: at(9, 9) })], [edge("a", "b")])[0].status).toBe("done");
    const four = ["a", "b", "c", "d"].map((id) => card(id, "chained"));
    // Join: c waits on both a and b.
    expect(promptSequences(four, [edge("a", "c"), edge("b", "c")])).toEqual([]);
    // Fork: a leads to both b and c.
    expect(promptSequences(four, [edge("a", "b"), edge("a", "c")])).toEqual([]);
    // A loop has no start.
    expect(promptSequences(four, [edge("a", "b"), edge("b", "a")])).toEqual([]);
    // The history's own edges between session cards, and related edges, are not sequences.
    expect(promptSequences(four, [{ ...edge("a", "b"), id: "roll:b" }, { ...edge("c", "d"), kind: "related" }])).toEqual([]);
    // An end the chart has no card for (pruned by the backend) leaves the chain out.
    expect(promptSequences(four, [edge("a", "ghost")])).toEqual([]);
  });

  it("gives each member its place for step n of m", () => {
    const cards = [card("a", "scheduled", { at: at(13) }), card("b", "chained"), card("c", "chained")];
    const places = sequencePlaces(promptSequences(cards, [edge("a", "b"), edge("b", "c")]));
    expect(places.get("b")).toEqual({ n: 2, of: 3, sequence: "a" });
    expect(places.get("loose")).toBeUndefined();
  });
});

describe("the writes Pause, Skip and Stop mean", () => {
  const cards = [sent("a", { filesAt: at(9, 5) }), card("b", "chained"), card("c", "chained"), card("d", "chained")];
  const links = [edge("a", "b"), edge("b", "c", { target: "tab-2", preface: ["/clear"] }), edge("c", "d")];
  const sequence = promptSequences(cards, links)[0];

  it("finds the next pending member, and the edge into it is what Stop removes", () => {
    expect(nextPendingStep(sequence)?.card.id).toBe("b");
    expect(stopEdge(sequence)?.id).toBe("a>b");
  });

  it("skips by removing the edges into and out of it and linking its neighbours, carrying the out-edge's tab and commands", () => {
    const plan = skipPlan(sequence, "new")!;
    expect(plan.remove).toEqual(["a>b", "b>c"]);
    expect(plan.add).toEqual({ id: "new", from: "a", to: "c", kind: "after", target: "tab-2", preface: ["/clear"] });
  });

  it("skips the last pending member by removing its in-edge alone, and keeps a pause across a skip", () => {
    const tail = promptSequences([sent("a", { filesAt: at(9, 5) }), card("b", "chained")], [edge("a", "b")])[0];
    expect(skipPlan(tail, "new")).toEqual({ remove: ["a>b"] });
    const held = promptSequences(cards, [edge("a", "b", { paused: true }), links[1], links[2]])[0];
    expect(skipPlan(held, "new")!.add).toMatchObject({ paused: true });
    expect(skipPlan(promptSequences([sent("a", { filesAt: at(9, 5) }), sent("b", { filesAt: at(9, 9) })], [edge("a", "b")])[0], "new")).toBeNull();
  });

  it("sends the held step at once on Resume only when its predecessor has already finished", () => {
    const held = promptSequences(cards, [edge("a", "b", { paused: true }), links[1], links[2]])[0];
    const step = nextPendingStep(held)!;
    expect(resumeSendsAtOnce(held, step, new Map())).toBe(true);
    // The predecessor is still running: its end is ahead, the host will react to it.
    expect(resumeSendsAtOnce(held, step, new Map([["a", "running" as const]]))).toBe(false);
    // Never stamped finished: nothing says it is over.
    const unknown = promptSequences([sent("a"), card("b", "chained")], [edge("a", "b", { paused: true })])[0];
    expect(resumeSendsAtOnce(unknown, nextPendingStep(unknown)!, new Map())).toBe(false);
  });
});

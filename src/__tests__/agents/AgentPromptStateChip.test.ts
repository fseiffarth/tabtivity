import { describe, expect, it } from "vitest";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { chainDepth, promptStateChip } from "../../lib/agents/prompt/stateChip";
import type { PromptLink } from "../../stores/agents/agentPrompts";

const card = (id: string, state: PromptChartCard["state"], extra: Partial<PromptChartCard> = {}) =>
  ({ id, key: id, state, message: id, tags: [], autoTags: [], strandId: "s", at: null, recurring: false, ...extra }) as PromptChartCard;
const after = (from: string, to: string): PromptLink => ({ id: `${from}-${to}`, from, to, kind: "after" });

describe("promptStateChip", () => {
  it("writes every state as a word with its own tone", () => {
    expect(promptStateChip(card("a", "draft"))).toEqual({ key: "promptChart.state.draft", tone: "draft" });
    expect(promptStateChip(card("a", "scheduled"))).toEqual({ key: "promptChart.state.scheduled", tone: "scheduled" });
    expect(promptStateChip(card("a", "queued"))).toEqual({ key: "promptChart.state.queued", tone: "queued" });
  });

  it("a sent card wears its result, delivered when the row names none", () => {
    const sent = (result?: "delivered" | "missed" | "failed") =>
      card("h", "sent", { history: { id: "h", message: "h", created_at: "x", result } as never });
    expect(promptStateChip(sent()).key).toBe("promptChart.result.delivered");
    expect(promptStateChip(sent("missed"))).toEqual({ key: "promptChart.result.missed", tone: "missed" });
    expect(promptStateChip(sent("failed")).tone).toBe("failed");
  });

  it("a chained card says which step it follows", () => {
    const links = [after("a", "b"), after("b", "c")];
    expect(chainDepth(card("c", "chained"), links)).toBe(2);
    expect(promptStateChip(card("b", "chained"), links)).toEqual({ key: "promptChart.state.chained", params: { step: 1 }, tone: "chained" });
    expect(promptStateChip(card("c", "chained"), links).params).toEqual({ step: 2 });
    // No edge found (a fixture, a stale join): after step 1, never step 0.
    expect(promptStateChip(card("x", "chained")).params).toEqual({ step: 1 });
  });

  it("stops on a hand-edited loop instead of spinning", () => {
    expect(chainDepth(card("a", "chained"), [after("b", "a"), after("a", "b")])).toBe(64);
  });
});

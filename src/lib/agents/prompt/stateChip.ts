import type { PromptLink } from "../../../stores/agents/agentPrompts";
import type { PromptChartCard } from "./chart";
import type { PromptLiveState } from "./outcome";
import { promptEndedAt } from "./timeline";

/** The word a card wears for its state (never a colour alone), with the tone
 *  its chip is drawn in. The inspector and the card face read the same one. */
export type PromptStateChipKey =
  | "promptChart.state.draft"
  | "promptChart.state.scheduled"
  | "promptChart.state.queued"
  | "promptChart.state.chained"
  | "promptChart.state.chainPaused"
  | "promptChart.outcome.running"
  | "promptChart.outcome.needsAnswer"
  | "promptChart.outcome.finished"
  | "promptChart.result.delivered"
  | "promptChart.result.queued"
  | "promptChart.result.missed"
  | "promptChart.result.failed";

export interface PromptStateChip {
  key: PromptStateChipKey;
  /** Interpolation for the key: a chained card's `step`. */
  params?: { step: number };
  tone: "draft" | "scheduled" | "queued" | "chained" | "paused" | "running" | "needs" | "finished" | "delivered" | "missed" | "failed";
}

/** How many prompts sit before this one in its After chain (a chained card is
 *  at least after one). Bounded: the writes refuse cycles, but a hand-edited
 *  file may not. */
export function chainDepth(card: PromptChartCard, links: readonly PromptLink[]): number {
  let depth = 0;
  let id = card.id;
  for (let guard = 0; guard < 64; guard += 1) {
    const edge = links.find((link) => link.kind === "after" && link.to === id);
    if (!edge) break;
    depth += 1;
    id = edge.from;
  }
  return depth;
}

export function promptStateChip(card: PromptChartCard, links: readonly PromptLink[] = [], live?: PromptLiveState): PromptStateChip {
  if (card.state === "sent") {
    const result = card.history?.result ?? "delivered";
    if (result === "delivered") {
      if (live === "running") return { key: "promptChart.outcome.running", tone: "running" };
      if (live === "needsAnswer") return { key: "promptChart.outcome.needsAnswer", tone: "needs" };
      if (promptEndedAt(card)) return { key: "promptChart.outcome.finished", tone: "finished" };
    }
    return { key: `promptChart.result.${result}`, tone: result };
  }
  // A step held back with Pause says so instead of counting its place.
  if (card.state === "chained" && card.chainLink?.paused) return { key: "promptChart.state.chainPaused", tone: "paused" };
  if (card.state === "chained") return { key: "promptChart.state.chained", params: { step: Math.max(1, chainDepth(card, links)) }, tone: "chained" };
  return { key: `promptChart.state.${card.state}`, tone: card.state };
}

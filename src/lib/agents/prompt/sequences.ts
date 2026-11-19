import type { PromptLink } from "../../../stores/agents/agentPrompts";
import type { PromptChartCard } from "./chart";
import { isSessionRollLink } from "./links";
import type { PromptLiveState } from "./outcome";
import { promptEndedAt } from "./timeline";

/**
 * A sequence is an `after` chain of two or more prompts: each goes out once the
 * one before it has finished. It has no stored name or id of its own — it is
 * read off the edges, across the history's rows, the rules and the drafts — and
 * is identified by its first member.
 *
 * Only a plain chain counts. A prompt that two edges wait on (a join) or that
 * two edges lead out of (a fork) has no single order, and a loop has no start;
 * those components are left out, as `draftSequence` leaves out joins and loops.
 * The history's own `roll:` edges between session cards are not a sequence.
 */
export type SequenceStepStatus = "done" | "running" | "next" | "waiting" | "paused" | "stopped";
export type SequenceStatus = "running" | "paused" | "stopped" | "done" | "waiting";

export interface SequenceStep {
  card: PromptChartCard;
  /** 1-based place in the chain. */
  n: number;
  status: SequenceStepStatus;
  /** The edge into this step; absent on the first. */
  edge?: PromptLink;
}

export interface PromptSequence {
  /** The first member's card id. */
  id: string;
  steps: SequenceStep[];
  status: SequenceStatus;
  /** The step in hand: the first not yet done (the last, when all are). */
  current: number;
  done: number;
  running: number;
  /** Next, waiting, paused and stopped steps together. */
  pending: number;
}

/** The card an edge's end stands for. A recurring source's rows are
 *  `id@occurrence`, as `buildPromptChart` matches them; the newest sent one
 *  speaks for the prompt, else its draft or rule. */
function cardFor(id: string, cards: readonly PromptChartCard[]): PromptChartCard | undefined {
  const matches = cards.filter((card) => card.id === id || card.id.startsWith(`${id}@`));
  const sent = matches.filter((card) => card.state === "sent").sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  return sent[0] ?? matches.find((card) => card.state !== "sent");
}

function stepStatus(
  card: PromptChartCard,
  edge: PromptLink | undefined,
  before: SequenceStepStatus | undefined,
  live: ReadonlyMap<string, PromptLiveState>,
): SequenceStepStatus {
  if (card.state === "sent") {
    const result = card.history?.result ?? "delivered";
    if (result === "missed" || result === "failed") return "stopped";
    return live.has(card.id) ? "running" : "done";
  }
  if (edge?.paused) return "paused";
  if (card.chainStopped) return "stopped";
  return before === undefined || before === "done" ? "next" : "waiting";
}

export function promptSequences(
  cards: readonly PromptChartCard[],
  links: readonly PromptLink[],
  live: ReadonlyMap<string, PromptLiveState> = new Map(),
): PromptSequence[] {
  const edges = links.filter((link) => link.kind === "after" && !isSessionRollLink(link));
  const outgoing = new Map<string, PromptLink[]>();
  const incoming = new Map<string, PromptLink[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  const sequences: PromptSequence[] = [];
  for (const root of [...outgoing.keys()].filter((id) => !incoming.has(id))) {
    const chain: { id: string; edge?: PromptLink }[] = [{ id: root }];
    const seen = new Set([root]);
    let valid = true;
    for (let at = root; outgoing.has(at) && valid;) {
      const next = outgoing.get(at)!;
      const edge = next[0];
      if (next.length !== 1 || incoming.get(edge.to)!.length !== 1 || seen.has(edge.to)) { valid = false; break; }
      seen.add(edge.to);
      chain.push({ id: edge.to, edge });
      at = edge.to;
    }
    const resolved = chain.map((member) => cardFor(member.id, cards));
    if (!valid || chain.length < 2 || resolved.some((card) => !card)) continue;
    const steps: SequenceStep[] = [];
    chain.forEach((member, index) => {
      const card = resolved[index]!;
      steps.push({ card, n: index + 1, edge: member.edge, status: stepStatus(card, member.edge, steps[index - 1]?.status, live) });
    });
    const count = (status: SequenceStepStatus) => steps.filter((step) => step.status === status).length;
    const done = count("done");
    const running = count("running");
    const status: SequenceStatus = count("stopped") > 0 ? "stopped"
      : count("paused") > 0 ? "paused"
        : done === steps.length ? "done"
          : running > 0 ? "running" : "waiting";
    const first = steps.findIndex((step) => step.status !== "done");
    sequences.push({
      id: steps[0].card.id,
      steps,
      status,
      current: first < 0 ? steps.length : first + 1,
      done,
      running,
      pending: steps.length - done - running,
    });
  }
  return sequences;
}

/** Each member card's place, for "step n of m" on its face. */
export function sequencePlaces(sequences: readonly PromptSequence[]): Map<string, { n: number; of: number; sequence: string }> {
  return new Map(sequences.flatMap((sequence) =>
    sequence.steps.map((step) => [step.card.id, { n: step.n, of: sequence.steps.length, sequence: sequence.id }] as const)));
}

/** The next prompt still to be sent: the first chained member not yet sent.
 *  Pause, Skip and Stop act on the edge into it. */
export function nextPendingStep(sequence: PromptSequence): SequenceStep | undefined {
  return sequence.steps.find((step) => step.card.state === "chained" && !!step.edge && step.status !== "done" && step.status !== "running");
}

/** The writes Skip means: the edges into and out of the next pending member go,
 *  and its predecessor is linked to its successor (carrying the removed
 *  out-edge's tab and commands, and a pause on the removed in-edge). The
 *  skipped card is a loose draft again. `null` when nothing is pending. */
export function skipPlan(sequence: PromptSequence, newLinkId: string): { remove: string[]; add?: PromptLink } | null {
  const step = nextPendingStep(sequence);
  if (!step?.edge) return null;
  const after = sequence.steps[step.n];
  const out = after?.edge;
  const remove = [step.edge.id, ...(out ? [out.id] : [])];
  if (!out) return { remove };
  return {
    remove,
    add: {
      id: newLinkId,
      from: step.edge.from,
      to: out.to,
      kind: "after",
      ...(out.target ? { target: out.target } : {}),
      ...(out.preface?.length ? { preface: out.preface } : {}),
      ...(step.edge.paused ? { paused: true } : {}),
    },
  };
}

/** The edge Stop removes: the one into the next pending member. The rest stays linked. */
export function stopEdge(sequence: PromptSequence): PromptLink | undefined {
  return nextPendingStep(sequence)?.edge;
}

/** Whether Resume must send the held step itself: its predecessor already
 *  finished (so the host, which only sends when a turn ends, has nothing left
 *  to react to). A predecessor still running needs nothing — its end is ahead. */
export function resumeSendsAtOnce(sequence: PromptSequence, held: SequenceStep, live: ReadonlyMap<string, PromptLiveState>): boolean {
  const before = sequence.steps[held.n - 2]?.card;
  return !!before && before.state === "sent" && (before.history?.result ?? "delivered") === "delivered"
    && !live.has(before.id) && !!promptEndedAt(before);
}

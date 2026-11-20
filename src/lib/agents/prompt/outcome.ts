import type { PromptChartCard } from "./chart";
import { promptEndedAt } from "./timeline";

/**
 * What became of a sent prompt. Two of the words are LIVE — the tab is working
 * on it, or waiting for the reader's answer — and are read off the tab's
 * activity, never stored; the rest follow from the persisted row. "Cut off" has
 * no word here: nothing per turn records that it ended on a usage limit (the
 * limit notice is read off a live screen only), so it is not guessed at.
 */
export type PromptLiveState = "running" | "needsAnswer";
export type PromptOutcomeKind = PromptLiveState | "finished" | "delivered" | "missed" | "failed";

/** A tab's verdict as `useActivityStore.statusTabsByScope` words it. */
export type PromptTabStatus = "working" | "needs-decision" | "finished" | "interrupted";

/**
 * Which cards are live right now: the NEWEST delivered row of a live tab whose
 * turn has not been stamped finished (`files_at`), while the tab works or asks.
 * An older row is history whatever the tab does now, and a row already stamped
 * finished means the tab's work is a later prompt typed in the terminal.
 * `statusOf` answers by strand id (a closed strand has no status).
 */
export function livePromptStates(
  cards: readonly PromptChartCard[],
  statusOf: (strandId: string) => PromptTabStatus | undefined,
): Map<string, PromptLiveState> {
  const newest = new Map<string, PromptChartCard>();
  for (const card of cards) {
    if (card.state !== "sent" || (card.history?.result ?? "delivered") !== "delivered" || !card.at) continue;
    const held = newest.get(card.strandId);
    if (!held || card.at.getTime() > held.at!.getTime()) newest.set(card.strandId, card);
  }
  const live = new Map<string, PromptLiveState>();
  for (const [strandId, card] of newest) {
    if (card.history?.files_at) continue;
    const status = statusOf(strandId);
    if (status === "working") live.set(card.id, "running");
    else if (status === "needs-decision") live.set(card.id, "needsAnswer");
  }
  return live;
}

export interface PromptOutcome {
  kind: PromptOutcomeKind;
  /** How long the turn took (so far, when it is running); null when unknown. */
  durationMs: number | null;
  files: number;
}

/** The outcome of a sent card, or of a session's cards (the newest decides the word). */
export function promptOutcome(cards: readonly PromptChartCard[], live: PromptLiveState | undefined, now: Date): PromptOutcome {
  const latest = cards[cards.length - 1];
  const first = cards[0]?.at;
  const result = latest?.history?.result ?? "delivered";
  const ended = latest ? promptEndedAt(latest) : null;
  const files = new Set(cards.flatMap((card) => card.history?.files ?? [])).size;
  const kind: PromptOutcomeKind = result !== "delivered" ? result : live ?? (ended ? "finished" : "delivered");
  const end = live ? now : ended;
  return { kind, durationMs: first && end ? Math.max(0, end.getTime() - first.getTime()) : null, files };
}

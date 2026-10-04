/**
 * What the agent did with the last markup Submit — the pill a markup view
 * shows while it stays open (`docs/pdf_markup_rounds_plan.md` §2.2). One pure
 * machine for the phone and the desktop: each host feeds it the agent's state
 * as it sees it (the phone: the live screen's busy row and select prompt; the
 * desktop: the tab's activity) and a clock.
 *
 * ```
 * Submit ─► queued (agent was working) ─┐
 *        └► sent   (agent was idle)    ─┼─ work seen ─► working ⇄ question
 *                                       │                 │ idle ≥ SETTLE_MS
 *                                       │                 ▼
 *                                       │              finished ── work again ─► working
 *                                       └─ no work within CONFIRM_MS ─► unconfirmed
 * ```
 *
 * `finished` needs idle to hold for `SETTLE_MS`: between a turn and a queued
 * prompt the CLI is briefly idle. The machine keeps following the tab after
 * `finished` — a `markup_ask` answer, or in a `list` round the edit itself,
 * comes in a later turn — and a new Submit restarts it.
 *
 * Two kinds of round (`docs/pdf_markup_direct_apply_plan.md`): by default a
 * Submit has the agent make the changes at once, and the desktop keeps an
 * undo snapshot of the project's work tree — the round carries its id
 * (`undo`), the host settles it each time the round finishes, and the pill
 * offers **Undo** (`canUndo`). Where the desktop took no snapshot (switched
 * off, not a git repository, …) the round is `list`: the agent lists the
 * changes and **Make these changes** (`canApply`) has it make them.
 */

import type { TranslationKey } from "../../../src/lib/i18n";

/** The agent as the host sees it now. */
export type AgentSignal = "working" | "question" | "idle";
export type RoundPhase = "sent" | "queued" | "working" | "question" | "finished" | "unconfirmed";
/** An `apply` round's undo snapshot on the desktop: its id, and whether the
 * Undo is still to be had (`ready`) or went through (`done`). */
export type RoundUndo = { id: string; state: "ready" | "done" };
/** `since`: when `phase` began. `sentAt`: the Submit. `idleSince`: when a
 * working or asking agent was last seen going idle, until it settles.
 * `applied`: this round is the **Make these changes** follow-up, not a
 * Submit — the button that sends it is offered only on a round without.
 * `undo`: the round made its changes directly and the desktop can put them
 * back; absent = a `list` round. */
export type Round = { phase: RoundPhase; since: number; sentAt: number; idleSince: number | null; applied?: boolean; undo?: RoundUndo };

/** How long idle must hold before a turn counts as finished — as the
 * desktop scheduler's `COMPLETION_STABLE_MS`. */
export const SETTLE_MS = 3_000;
/** How long a Submit may wait for the agent to be seen at work before the
 * pill stops claiming to know (an agent whose state the host cannot read). */
export const CONFIRM_MS = 20_000;

/** A Submit went out: into the agent's queue (it was working) or straight in.
 * `applied`: it was the **Make these changes** follow-up instead. `undo`: the
 * desktop's snapshot for an `apply` round (an answer to the round's markup
 * questions keeps the round's own). */
export function startRound(queued: boolean, now: number, applied = false, undo?: RoundUndo): Round {
  const round: Round = { phase: queued ? "queued" : "sent", since: now, sentAt: now, idleSince: null };
  return { ...round, ...(applied ? { applied: true } : {}), ...(undo ? { undo } : {}) };
}

/** Whether the agent is done with the round for now (or nothing says what it
 * does) — when the pill offers its follow-up. */
function done(round: Round): boolean {
  return round.phase === "finished" || round.phase === "unconfirmed";
}

/** Whether **Make these changes** fits the round: a `list` round (no undo —
 * the agent has only listed the changes) is done and the follow-up has not
 * gone out yet. */
export function canApply(round: Round | null): boolean {
  return round !== null && !round.applied && round.undo === undefined && done(round);
}

/** Whether **Undo** fits the round: an `apply` round, done, whose undo has
 * not gone through yet. */
export function canUndo(round: Round | null): boolean {
  return round !== null && round.undo?.state === "ready" && done(round);
}

/** The round once its Undo `id` went through (or is gone): offered no more.
 * The same round when it holds another undo — an answer that arrives after a
 * new Submit replaced the round never touches the new one's. */
export function undoneRound(round: Round, id: string): Round {
  return round.undo?.id === id && round.undo.state !== "done" ? { ...round, undo: { ...round.undo, state: "done" } } : round;
}

/** Whether `round` still holds the undo `id` — a slow undo call's answer
 * speaks only to the round it was made for. */
export function holdsUndo(round: Round | null, id: string): boolean {
  return round?.undo?.id === id;
}

/** A view opened again over marks sent before: no Submit of its own, so the
 * pill appears only once the agent is seen at work. */
export function followRound(agent: Exclude<AgentSignal, "idle">, now: number): Round {
  return { phase: agent, since: now, sentAt: now, idleSince: null };
}

/** The round after one look at the agent — the same object when nothing
 * changed, so a host can step it on every render without looping. */
export function stepRound(round: Round, agent: AgentSignal, now: number): Round {
  if (agent !== "idle") {
    if (round.phase === agent && round.idleSince === null) return round;
    return { ...round, phase: agent, since: round.phase === agent ? round.since : now, idleSince: null };
  }
  switch (round.phase) {
    case "sent":
    case "queued":
      return now - round.sentAt >= CONFIRM_MS ? { ...round, phase: "unconfirmed", since: now } : round;
    case "working":
    case "question": {
      const idle = round.idleSince ?? now;
      if (now - idle >= SETTLE_MS) return { ...round, phase: "finished", since: now, idleSince: null };
      return round.idleSince === null ? { ...round, idleSince: now } : round;
    }
    default:
      return round;
  }
}

/** Milliseconds until the round could change with the agent as it is — when
 * a host should look again — or `null` when only the agent can change it. */
export function nextCheck(round: Round, agent: AgentSignal, now: number): number | null {
  if (agent !== "idle") return null;
  if (round.phase === "sent" || round.phase === "queued") return Math.max(0, CONFIRM_MS - (now - round.sentAt));
  if ((round.phase === "working" || round.phase === "question") && round.idleSince !== null) return Math.max(0, SETTLE_MS - (now - round.idleSince));
  return null;
}

/** What an undo would put back, as the confirm dialog says it on both hosts:
 * the files (project-relative), how many more were not named, and the PDF's
 * fate. */
export function undoSummary(
  changes: { files: readonly { path: string }[]; more: number; pdf: "restored" | "kept" | "none" },
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  const named = changes.files.map((file) => file.path).join(", ");
  const files = !named && changes.more === 0
    ? t("mobile.markup.undo.noFiles")
    : t("mobile.markup.undo.files", { files: changes.more > 0 ? t("mobile.markup.undo.andMore", { files: named || "…", count: changes.more }) : named });
  const pdf = changes.pdf === "restored" ? t("mobile.markup.undo.pdfRestored") : changes.pdf === "kept" ? t("mobile.markup.undo.pdfKept") : "";
  return pdf ? `${files} ${pdf}` : files;
}

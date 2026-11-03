import type { AttentionKind } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import type { ScheduledAgentPrompt } from "../agents/agentSchedule";
import { isAgentProposal } from "../agents/agentSchedule";
import { ASSISTANT_SCOPE } from "../assistant";
import { isRosterAgentKind } from "../agents/agentRoster";
import type { AlertItem } from "../alerts";
import type { MarkupAsk } from "../viewers/markupQuestions";
import type { GitPushProposal } from "../../types";
import type { RosterRow } from "./roster";

/** What the header's cockpit badge counts, each part on its own. */
export interface CockpitBadgeInput {
  tabsByScope: Record<string, readonly TabEntry[]>;
  busyByTab: Record<string, boolean>;
  attentionByTab: Record<string, AttentionKind>;
  /** Loaded schedules, by `scheduleCacheKey` (whatever surfaces loaded). */
  schedulesByTarget: Record<string, readonly ScheduledAgentPrompt[]>;
  /** Root approvals waiting (`useDomainReview().waiting`). */
  approvals: number;
  /** Pending push / release requests, where known. */
  pushRequests?: number;
}

export interface CockpitBadge {
  asking: number;
  interrupted: number;
  proposals: number;
  approvals: number;
  total: number;
}

/**
 * The header button's badge: Asking + Interrupted + proposals + approvals,
 * **derived, never acknowledged** (the `TodoIndicator` rule) — it falls as each
 * is answered and has no dismissal of its own.
 *
 * Every agent tab of every hydrated scope but the assistant's counts, with the
 * desktop's own lamps (`deriveAgentRosterState`'s first answers: a decision
 * only while not working). Schedule proposals are counted from the schedules
 * the window has loaded; push requests only when a caller knows them (the
 * backend read behind them runs git, so nothing reads it while the cockpit
 * is shut).
 */
export function cockpitBadge(input: CockpitBadgeInput): CockpitBadge {
  let asking = 0;
  let interrupted = 0;
  for (const [scope, tabs] of Object.entries(input.tabsByScope)) {
    if (scope === ASSISTANT_SCOPE) continue;
    for (const tab of tabs) {
      if (!isRosterAgentKind(tab.kind)) continue;
      const pty = `${scope}:${tab.key}`;
      if (input.busyByTab[pty]) continue;
      const attention = input.attentionByTab[pty];
      if (attention === "decision") asking += 1;
      else if (attention === "interrupted") interrupted += 1;
    }
  }
  let proposals = input.pushRequests ?? 0;
  for (const rows of Object.values(input.schedulesByTarget)) {
    for (const row of rows) if (isAgentProposal(row)) proposals += 1;
  }
  const approvals = input.approvals;
  return { asking, interrupted, proposals, approvals, total: asking + interrupted + proposals + approvals };
}

/** The Decisions inbox's groups, in the rail's urgency order (the phone's
 *  Needs you order, with the desktop's extra groups slotted in). */
export const DECISION_GROUPS = [
  "asking",
  "interrupted",
  "push",
  "schedule",
  "approvals",
  "markup",
  "unseen",
  "alerts",
] as const;
export type DecisionGroupId = (typeof DECISION_GROUPS)[number];

/** A schedule an agent proposed (`isAgentProposal`), where it lives. */
export interface ScheduleProposalRef {
  projectId: string;
  targetId: string;
  schedule: ScheduledAgentPrompt;
  /** The tab it targets, when that tab is open. */
  ptyId?: string;
}

/** A push / release request of one project. */
export interface PushRequestRef {
  projectId: string;
  proposal: GitPushProposal;
}

/** An open `markup_ask` of one agent tab. */
export interface MarkupAskRef {
  projectId: string;
  ptyId: string;
  ask: MarkupAsk;
}

export interface DecisionsInput {
  /** Every roster row (unfiltered: the rail is not cut by the roster chips). */
  rows: readonly RosterRow[];
  push: readonly PushRequestRef[];
  schedules: readonly ScheduleProposalRef[];
  /** Root approvals waiting. */
  approvals: number;
  markup: readonly MarkupAskRef[];
  alerts: readonly AlertItem[];
  /** Scope id → the name its rows show. */
  names: Record<string, string>;
}

export type DecisionItems = {
  asking: RosterRow[];
  interrupted: RosterRow[];
  push: PushRequestRef[];
  schedule: ScheduleProposalRef[];
  approvals: number;
  markup: MarkupAskRef[];
  unseen: RosterRow[];
  alerts: AlertItem[];
};

export interface Decisions {
  items: DecisionItems;
  /** Non-empty groups, in rail order, with their counts. Empty groups are
   *  not drawn. */
  groups: { id: DecisionGroupId; count: number }[];
  total: number;
  /** What the detail pane shows with nothing selected: the top Asking row. */
  topAsking: string | null;
  names: Record<string, string>;
}

const newest = (at: (row: RosterRow) => number | undefined) => (a: RosterRow, b: RosterRow) =>
  (at(b) ?? Number.NEGATIVE_INFINITY) - (at(a) ?? Number.NEGATIVE_INFINITY) || 0;

/**
 * The rail model: the eight groups, each in its own order — asking and
 * interrupted newest first (by the last working edge before they stopped),
 * unseen finished turns by when they finished. A push request counts while it
 * waits (pending or running); a finished one is history the card's own
 * Dismiss clears, so it is listed but not counted.
 */
export function buildDecisions(input: DecisionsInput): Decisions {
  const asking = input.rows.filter((row) => row.state === "question").sort(newest((row) => row.facts.workingAt));
  const interrupted = input.rows.filter((row) => row.state === "interrupted").sort(newest((row) => row.facts.workingAt));
  const unseen = input.rows.filter((row) => row.state === "done").sort(newest((row) => row.facts.doneAt));
  const push = input.push.filter(({ proposal }) => !proposal.cleared && proposal.status !== "dismissed" && proposal.status !== "expired");
  const waitingPush = push.filter(({ proposal }) => proposal.status === "pending" || proposal.status === "running").length;
  const items: DecisionItems = {
    asking,
    interrupted,
    push,
    schedule: [...input.schedules],
    approvals: input.approvals,
    markup: [...input.markup],
    unseen,
    alerts: [...input.alerts],
  };
  const counts: Record<DecisionGroupId, number> = {
    asking: asking.length,
    interrupted: interrupted.length,
    push: waitingPush,
    schedule: items.schedule.length,
    approvals: items.approvals,
    markup: items.markup.length,
    unseen: unseen.length,
    alerts: items.alerts.length,
  };
  const groups = DECISION_GROUPS.filter((id) => (id === "push" ? push.length > 0 : counts[id] > 0)).map((id) => ({
    id,
    count: counts[id],
  }));
  const total = DECISION_GROUPS.reduce((sum, id) => sum + counts[id], 0);
  return { items, groups, total, topAsking: asking[0]?.ptyId ?? null, names: input.names };
}

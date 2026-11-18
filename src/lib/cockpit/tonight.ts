import { nextScheduleOccurrence, type ScheduledAgentPrompt } from "../agents/agentSchedule";
import { agentCronTimes, parseTimeOfDay, scheduledAgentCmds, type AgentCron } from "../agents/agentCron";
import type { RootProposal } from "../../stores/rootReview";
import type { PushRequestRef } from "./decisions";
import type { RosterRow } from "./roster";
import { milestonesSince } from "./agentNotes";
import type { AgentMilestone } from "../../stores/tabs/types";

/**
 * The cockpit's Tonight view model (`docs/desktop_cockpit_plan.md`, View 3):
 * one time-ordered *Coming up* list across projects, and the *While you were
 * away* recap. Pure: every boundary is read against the `now` passed in, in
 * the machine's local time (the schedules' own clock).
 */

export const TONIGHT_BUCKETS = ["now", "nextHour", "tonight", "tomorrow", "later"] as const;
export type TonightBucket = (typeof TONIGHT_BUCKETS)[number];

/** How close "now" is: due or within five minutes. */
const NOW_MS = 5 * 60_000;
/** How far *Coming up* looks. */
export const COMING_UP_DAYS = 7;

/** The next local midnight after `ms`. */
function nextMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Which part of the timeline `at` falls in, seen from `now`: due or within
 * five minutes, within the hour, before the next midnight, before the one
 * after it, or later. A time already past counts as now (a rule due, not yet
 * sent).
 */
export function tonightBucket(at: number, now: number): TonightBucket {
  if (at - now <= NOW_MS) return "now";
  if (at - now <= 60 * 60_000) return "nextHour";
  const midnight = nextMidnight(now);
  if (at < midnight) return "tonight";
  if (at < nextMidnight(midnight)) return "tomorrow";
  return "later";
}

export type ComingUpKind = "schedule" | "chart" | "autoContinue" | "warmup" | "event";

export interface ComingUpItem {
  id: string;
  kind: ComingUpKind;
  /** When it happens (ms epoch); null for a standing state (auto-continue). */
  at: number | null;
  title: string;
  /** The project / box name, and tab label, where it belongs to one. */
  scopeName?: string;
  scope?: string;
  tabLabel?: string;
  ptyId?: string;
  recurring?: boolean;
  /** The schedule behind a `schedule` item, for its enable switch. */
  schedule?: ScheduledAgentPrompt;
  targetId?: string;
  /** A chart card's own state (`queued`, `chained`). */
  state?: string;
}

export interface ComingUpGroup {
  bucket: TonightBucket;
  items: ComingUpItem[];
}

/** The timeline: standing items and due ones under Now, then each bucket in
 *  time order; anything past the horizon is left out. */
export function buildComingUp(items: readonly ComingUpItem[], now: number, horizonDays = COMING_UP_DAYS): ComingUpGroup[] {
  const horizon = now + horizonDays * 86_400_000;
  const byBucket = new Map<TonightBucket, ComingUpItem[]>();
  for (const item of items) {
    if (item.at !== null && item.at > horizon) continue;
    const bucket = item.at === null ? "now" : tonightBucket(item.at, now);
    const list = byBucket.get(bucket) ?? [];
    list.push(item);
    byBucket.set(bucket, list);
  }
  return TONIGHT_BUCKETS.flatMap((bucket) => {
    const list = byBucket.get(bucket);
    if (!list) return [];
    list.sort((a, b) => (a.at ?? Number.NEGATIVE_INFINITY) - (b.at ?? Number.NEGATIVE_INFINITY));
    return [{ bucket, items: list }];
  });
}

/** One tab's schedules as timeline items: the next occurrence of each enabled
 *  rule. A disabled rule (an agent's proposal included) has no next run. */
export function scheduleItems(
  rules: readonly ScheduledAgentPrompt[],
  where: { scope: string; scopeName: string; tabLabel: string; ptyId: string; targetId: string },
  now: number,
): ComingUpItem[] {
  return rules.flatMap((rule) => {
    const next = nextScheduleOccurrence(rule, new Date(now));
    if (!next) return [];
    return [{
      id: `schedule:${where.targetId}:${rule.id}`,
      kind: "schedule" as const,
      at: next.at.getTime(),
      title: rule.message,
      ...where,
      recurring: rule.rule.type !== "once",
      schedule: rule,
    }];
  });
}

/** The scheduled warm-ups (`AgentCronSection`): each participating agent's next
 *  slot today, or tomorrow once today's has passed. */
export function warmupItems(cron: AgentCron | undefined, now: number): ComingUpItem[] {
  return scheduledAgentCmds(cron).flatMap((cmd) =>
    agentCronTimes(cron, cmd).flatMap((time) => {
      const minutes = parseTimeOfDay(time);
      if (minutes === null) return [];
      const d = new Date(now);
      d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (d.getTime() < now) d.setDate(d.getDate() + 1);
      return [{ id: `warmup:${cmd}:${time}`, kind: "warmup" as const, at: d.getTime(), title: cmd, recurring: true }];
    }),
  );
}

/** When the away window starts: the later of the cockpit's last close and the
 *  last input the window saw, else twelve hours back. */
export function awaySince(lastClosedAt: number | null, lastInputAt: number | undefined, now: number): number {
  const known = Math.max(lastClosedAt ?? 0, lastInputAt ?? 0);
  return known > 0 ? known : now - 12 * 3_600_000;
}

export interface AwayInput {
  rows: readonly RosterRow[];
  /** Every loaded schedule, with where it lives. */
  schedules: readonly { rule: ScheduledAgentPrompt; scopeName: string; tabLabel: string; targetId: string }[];
  push: readonly PushRequestRef[];
  root: readonly RootProposal[];
  since: number;
  /** The clock a milestone stamped in the future is judged against (default: now). */
  now?: number;
}

/** A milestone an agent reported while the user was away, with its row. */
export interface AwayMilestone {
  row: RosterRow;
  milestone: AgentMilestone;
}

export interface AwayRecap {
  finished: RosterRow[];
  cutOff: RosterRow[];
  pushes: PushRequestRef[];
  fired: AwayInput["schedules"][number][];
  rootWrites: RootProposal[];
  /** What agents reported as milestones inside the window (their own
   *  statements, host-stamped), newest first. */
  milestones: AwayMilestone[];
  empty: boolean;
}

const parsed = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * What happened while the user was away, built from stamps the stores already
 * keep — a derivation, not a log: turns finished (newest first), turns cut off,
 * pushes that went through, schedules that fired, root writes applied, and the
 * milestones agents reported inside the window (`cockpitMeta.milestones`, the
 * host's stamp; the view labels them as agent-reported).
 */
export function buildAway(input: AwayInput): AwayRecap {
  const { since } = input;
  const finished = input.rows
    .filter((row) => (row.state === "done" || row.state === "idle") && (row.facts.doneAt ?? 0) > since)
    .sort((a, b) => (b.facts.doneAt ?? 0) - (a.facts.doneAt ?? 0));
  const cutOff = input.rows.filter((row) => row.state === "interrupted" && (row.facts.workingAt ?? 0) > since);
  const pushes = input.push.filter(({ proposal }) => proposal.status === "pushed" && parsed(proposal.created_at) > since);
  const fired = input.schedules
    .filter(({ rule }) => parsed(rule.last?.at) > since)
    .sort((a, b) => parsed(b.rule.last?.at) - parsed(a.rule.last?.at));
  const rootWrites = input.root.filter((p) => p.status === "applied" && parsed(p.created) > since);
  const now = input.now ?? Date.now();
  const milestones = input.rows
    .flatMap((row) => milestonesSince(row.tab.cockpitMeta, since, now).map((milestone) => ({ row, milestone })))
    .sort((a, b) => b.milestone.at - a.milestone.at);
  return {
    finished,
    cutOff,
    pushes,
    fired,
    rootWrites,
    milestones,
    empty: !finished.length && !cutOff.length && !pushes.length && !fired.length && !rootWrites.length && !milestones.length,
  };
}

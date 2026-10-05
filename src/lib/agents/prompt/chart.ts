import {
  latestScheduleOccurrence,
  localOccurrenceKey,
  nextScheduleOccurrence,
  scheduleStatus,
  type ScheduledAgentPrompt,
} from "../agentSchedule";
import { promptOfSchedule } from "./scheduled";
import { shortModelName } from "../agentModel";
import { agentPromptAutoTags } from "./autoTags";
import { matchesTagsOrText } from "./tags";
import type {
  ProjectAgentPrompt,
  PromptLink,
  SentAgentPrompt,
} from "../../../stores/agents/agentPrompts";

export type PromptCardState = "draft" | "scheduled" | "queued" | "sent" | "chained";

/** One agent tab as the chart knows it: the target a card can be aimed at,
 *  the label and agent it wears, and the rules that live on it. A closed
 *  session is a strand too, so its sent cards keep a name. */
export interface PromptChartStrand {
  id: string;
  label: string;
  scheduleTargetId?: string;
  tabKey?: string;
  /** A live tab's launch id; a closed strand's first session id. */
  sessionId?: string;
  /** The launch id the strand's rows carry as `tab_id` — a tab's sessions
   *  after a `/clear` still belong to the one strand. */
  tabId?: string;
  agent?: string;
  /** The model a live tab last answered with (`stores/agents/agentModels`), as the
   *  pill beside the tab shows it. Absent on a closed strand: its rows carry
   *  their own. */
  model?: string;
  closed?: boolean;
  schedules: ScheduledAgentPrompt[];
}

/** Whether a sent row belongs to `strand`, by the strongest identity the row
 *  carries and by that one only: the tab it went to when the row names one,
 *  else the session (a row written before the tab id was recorded — a live
 *  tab's launch id is its session id too), else the label for a row with
 *  neither. A fallback, never an OR: default labels repeat ("Claude"), so a
 *  gone tab's row matched by label would land on whichever live tab shares it. */
export function rowOnStrand(strand: PromptChartStrand, row: SentAgentPrompt): boolean {
  if (row.tab_id) return strand.tabId === row.tab_id;
  if (row.session_id) return strand.sessionId === row.session_id;
  return strand.label === row.tab_label;
}

export interface PromptChartCard {
  key: string;
  id: string;
  state: PromptCardState;
  message: string;
  tags: string[];
  autoTags: string[];
  strandId: string;
  at: Date | null;
  prompt?: ProjectAgentPrompt;
  history?: SentAgentPrompt;
  schedule?: ScheduledAgentPrompt;
  targetId?: string;
  recurring: boolean;
  chainStopped?: boolean;
  /** The `after` edge a chained card waits on. */
  chainLink?: PromptLink;
}

export interface PromptChartInput {
  prompts: ProjectAgentPrompt[];
  history: SentAgentPrompt[];
  strands: PromptChartStrand[];
  links: PromptLink[];
  now: Date;
  /** The agent an unaimed draft's "New agent tab" would launch (the chart's
   *  toolbar pick): worn as the draft's `agent:` tag so the strip filters by
   *  it like any aimed card. Absent, an unaimed draft carries no agent. */
  newTabAgent?: string;
  /** The model that tab is told to use (the toolbar's second pick), worn the
   *  same way as a `model:` tag. */
  newTabModel?: string;
}

/** Lines that steer the session rather than ask it anything, never adopted
 * into the history (and rows an older build stored are not drawn): any bare
 * one-word slash command (`/clear`, `/login`, `/compact`, …), plus the two
 * that take an argument and still only housekeep — the `/rename <name>` Tabtivity
 * types into a new agent tab and a `/model <name>` switch. A command that
 * carries words for the agent (`/goal ship the release`) is a prompt. */
const SESSION_COMMANDS_WITH_ARGS = new Set(["/rename", "/model"]);

export function isSessionCommand(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/u);
  const head = words[0].toLowerCase();
  if (!/^\/[\w:-]+$/u.test(head)) return false;
  return words.length === 1 || SESSION_COMMANDS_WITH_ARGS.has(head);
}

/** Join the three persisted sources without manufacturing another state field. */
export function buildPromptChart(input: PromptChartInput): PromptChartCard[] {
  const cards: PromptChartCard[] = [];
  const rulesByPrompt = new Map<string, { strand: PromptChartStrand; schedule: ScheduledAgentPrompt }[]>();
  const historyById = new Map(input.history.map((row) => [row.id, row]));
  const afterTargets = new Map(
    input.links.filter((link) => link.kind === "after").map((link) => [link.to, link]),
  );
  for (const strand of input.strands.filter((item) => !item.closed)) {
    for (const schedule of strand.schedules) {
      if (schedule.rule.type === "once" && schedule.last) continue;
      // One prompt per rule, never every prompt with the words: the others
      // are their own drafts (`promptOfSchedule`).
      const linked = promptOfSchedule(input.prompts, schedule);
      if (linked) {
        const rows = rulesByPrompt.get(linked.id) ?? [];
        rows.push({ strand, schedule });
        rulesByPrompt.set(linked.id, rows);
      }
      const status = scheduleStatus(schedule, input.now);
      const queued = status.kind === "due";
      const history = historyById.get(schedule.id);
      const at = queued
        ? latestScheduleOccurrence(schedule, input.now)?.at ?? status.at ?? null
        : nextScheduleOccurrence(schedule, input.now)?.at ?? status.at ?? null;
      const recurring = schedule.rule.type !== "once";
      cards.push({
        key: `rule:${strand.id}:${schedule.id}`,
        id: linked?.id ?? schedule.id,
        state: queued ? "queued" : "scheduled",
        message: schedule.message,
        tags: history?.tags ?? linked?.tags ?? [],
        autoTags: agentPromptAutoTags({
          message: schedule.message,
          agent: strand.agent,
          model: strand.model,
          preface: schedule.preface,
          recurring,
          queued,
        }),
        strandId: strand.id,
        targetId: strand.scheduleTargetId,
        at,
        prompt: linked,
        history,
        schedule,
        recurring,
      });
    }
  }
  for (const prompt of input.prompts) {
    if (rulesByPrompt.has(prompt.id)) continue;
    const link = afterTargets.get(prompt.id);
    const chained = !!link;
    const sourceCard = link ? cards.find((card) => card.id === link.from) : undefined;
    const strand = chained
      ? input.strands.find((item) => item.scheduleTargetId === link.target)
        ?? input.strands.find((item) => item.id === sourceCard?.strandId)
      : undefined;
    const sourceRows = link
      ? input.history.filter((row) => row.id === link.from || row.id.startsWith(`${link.from}@`))
      : [];
    const stoppedResult = sourceRows[sourceRows.length - 1]?.result;
    // A draft's aim is advisory: the tab it names may be gone, and then the
    // card is simply unaimed rather than stuck on a strand nobody can see.
    const aimed = !chained && prompt.target
      ? input.strands.find((item) => !item.closed && item.scheduleTargetId === prompt.target)
      : undefined;
    cards.push({
      key: `prompt:${prompt.id}`,
      id: prompt.id,
      state: chained ? "chained" : "draft",
      message: prompt.message,
      tags: prompt.tags ?? [],
      autoTags: agentPromptAutoTags({
        message: prompt.message,
        chained,
        agent: strand?.agent ?? aimed?.agent ?? (chained ? undefined : input.newTabAgent),
        model: strand?.model ?? aimed?.model ?? (chained ? undefined : input.newTabModel),
        preface: link?.preface,
      }),
      strandId: strand?.id ?? "drafts",
      targetId: chained ? link?.target : aimed?.scheduleTargetId,
      at: null,
      prompt,
      recurring: false,
      chainStopped: chained && ((!!link?.target && !strand) || stoppedResult === "missed" || stoppedResult === "failed"),
      chainLink: link,
    });
  }
  for (const row of input.history) {
    if (!row.result || isSessionCommand(row.message)) continue;
    const liveStrand = input.strands.find((strand) => !strand.closed && rowOnStrand(strand, row));
    const closed = input.strands.find((strand) => strand.closed && rowOnStrand(strand, row));
    const strandId = liveStrand?.id ?? closed?.id ?? `closed:${row.tab_id ?? row.session_id ?? row.tab_label}`;
    cards.push({
      key: `history:${row.id}`,
      id: row.id,
      state: "sent",
      message: row.message,
      tags: row.tags ?? [],
      autoTags: agentPromptAutoTags({
        message: row.message,
        agent: row.agent,
        model: row.model ? shortModelName(row.model) : undefined,
        preface: row.preface,
        files: row.files,
        result: row.result,
        recurring: row.id.includes("@"),
      }),
      strandId,
      at: new Date(row.sent_at),
      history: row,
      recurring: row.id.includes("@"),
    });
  }
  return cards;
}

/**
 * The tabs that already hold a live rule, and the cards holding them. Two
 * independent rules on one tab have no order between them — the host
 * delivers whichever minute comes first and the other waits, or is missed —
 * so the chart does not offer such a tab as a target for a second one: the
 * way to put a further prompt on it is an `after` link from the rule it
 * holds. A paused rule fires nothing and occupies nothing.
 */
export function occupiedTargets(cards: PromptChartCard[]): Map<string, PromptChartCard[]> {
  const occupied = new Map<string, PromptChartCard[]>();
  for (const card of cards) {
    if (!card.schedule?.enabled || !card.targetId) continue;
    if (card.state !== "scheduled" && card.state !== "queued") continue;
    occupied.set(card.targetId, [...(occupied.get(card.targetId) ?? []), card]);
  }
  return occupied;
}

/** Round to the nearest `minutes` step of the LOCAL wall clock. The epoch's
 *  grid is UTC's, so in a :30 or :45 zone an hour snap would land on the half
 *  or three-quarter hour. */
export function snapPromptTime(date: Date, minutes = 5): Date {
  const step = minutes * 60_000;
  const offset = -date.getTimezoneOffset() * 60_000;
  return new Date(Math.round((date.getTime() + offset) / step) * step - offset);
}

export function queueOrderTimes(ids: string[], now: Date): Record<string, string> {
  const first = new Date(now.getTime() - Math.min(59, Math.max(0, ids.length - 1)) * 60_000);
  return Object.fromEntries(ids.map((id, index) => [
    id,
    localOccurrenceKey(new Date(first.getTime() + index * 60_000)),
  ]));
}

export interface PromptChartFilter {
  text: string;
  tag: string;
  agent: string;
  result: string;
}

/** The timeline's "When" facet, in the order the picker offers it. */
export const PROMPT_CHART_WINDOWS = ["any", "past", "upcoming", "hour", "today", "week", "month"] as const;
export type PromptChartWindow = (typeof PROMPT_CHART_WINDOWS)[number];

/**
 * Whether a card's instant falls in a "When" window. The axis runs both ways
 * from now, so the rolling windows do too: "within a week" admits last
 * Tuesday's delivery and next Tuesday's rule alike, and `today` is the day on
 * the wall. A queued card is waiting at the now line whatever its due minute
 * said, so it counts as upcoming, never past. A card with no instant (a
 * paused rule) is kept: a window says nothing about it.
 */
export function promptChartInWindow(
  card: Pick<PromptChartCard, "state">,
  at: Date | null,
  window: PromptChartWindow,
  now: Date,
): boolean {
  if (window === "any" || !at) return true;
  const t = card.state === "queued" ? now.getTime() : at.getTime();
  const n = now.getTime();
  switch (window) {
    case "past":
      return card.state !== "queued" && t <= n;
    case "upcoming":
      return card.state === "queued" || t > n;
    case "hour":
      return Math.abs(t - n) <= 3_600_000;
    case "today": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      return t >= start && t < end;
    }
    case "week":
      return Math.abs(t - n) <= 7 * 86_400_000;
    case "month":
      return Math.abs(t - n) <= 30 * 86_400_000;
  }
}

export function promptChartCardMatches(card: PromptChartCard, filter: PromptChartFilter): boolean {
  const tags = [...card.tags, ...card.autoTags];
  if (filter.tag && !tags.includes(filter.tag)) return false;
  const agent = card.history?.agent ?? card.autoTags.find((tag) => tag.startsWith("agent:"))?.slice(6) ?? "";
  if (filter.agent && agent !== filter.agent) return false;
  const result = card.state === "queued" ? "queued" : card.history?.result ?? "";
  if (filter.result && result !== filter.result) return false;
  const needle = filter.text.trim();
  if (!needle) return true;
  const haystack = [card.message, card.history?.tab_label ?? "", card.history?.session_id ?? "", ...(card.history?.files ?? [])].join("\n");
  return matchesTagsOrText(tags, haystack, needle);
}

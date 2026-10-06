import {
  MAX_AGENT_MESSAGE_BYTES,
  agentMessageBytes,
  sanitizeAgentMessage,
} from "../../../shared/agentComposer";
import { MAX_PREFACE_COMMANDS, sanitizePrefaceCommand } from "./agentPrefaces";

export const MAX_SCHEDULES_PER_TAB = 32;
export const SCHEDULE_CATCH_UP_MS = 60 * 60 * 1000;

export type ScheduleResult = "delivered" | "missed" | "failed";

export type ScheduleRule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekdays"; weekdays: number[]; time: string };

export interface ScheduleLastRun {
  occurrence: string;
  result: ScheduleResult;
  at: string;
}

export interface ScheduledAgentPrompt {
  origin?: { by: "agent"; session: string; at: string; from_delivery?: string };
  id: string;
  enabled: boolean;
  message: string;
  rule: ScheduleRule;
  /** Slash commands submitted one at a time, in order, before `message` — the
   *  composer's prefix chips and its `/model` pick. See `lib/agents/agentPrefaces`. */
  preface?: string[];
  last?: ScheduleLastRun;
  /** The paired phone that made this rule (#2348): revoking it, or narrowing
   *  its Mobile access, cancels the rule. Desktop and agent rules have none. */
  phone_device?: string;
}

export function isAgentProposal(schedule: ScheduledAgentPrompt): boolean {
  return schedule.origin?.by === "agent" && !schedule.enabled && !schedule.last;
}

export interface ScheduleOccurrence {
  key: string;
  at: Date;
}

export type ScheduleVerdict =
  | { kind: "wait"; occurrence: ScheduleOccurrence }
  | { kind: "missed"; occurrence: ScheduleOccurrence }
  | { kind: "none" };

const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localOccurrenceKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO weekday (Monday=1 … Sunday=7), independent of locale. */
export function isoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

/**
 * Construct one desktop-local wall-clock instant. A spring-forward gap is
 * rejected instead of accepting JavaScript's normalization to the next hour.
 */
export function localWallClock(value: string): Date | null {
  const match = DATE_TIME_RE.exec(value);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis] = match;
  const year = Number(ys);
  const month = Number(mos) - 1;
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(year, month, day, hour, minute, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date
    : null;
}

function timeParts(value: string): [number, number] | null {
  const match = TIME_RE.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? [hour, minute] : null;
}

function occurrenceOnDay(day: Date, time: string): ScheduleOccurrence | null {
  const parts = timeParts(time);
  if (!parts) return null;
  const value = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(parts[0])}:${pad(parts[1])}`;
  const at = localWallClock(value);
  return at ? { key: value, at } : null;
}

function dayOffset(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12, 0, 0, 0);
}

function ruleOccursOn(rule: ScheduleRule, day: Date): boolean {
  if (rule.type === "daily") return true;
  if (rule.type === "weekdays") return rule.weekdays.includes(isoWeekday(day));
  return false;
}

export function validateScheduleRule(rule: ScheduleRule): string | null {
  if (rule.type === "once") return localWallClock(rule.at) ? null : "invalid_once";
  if (!timeParts(rule.time)) return "invalid_time";
  if (rule.type === "weekdays") {
    const unique = new Set(rule.weekdays);
    if (unique.size === 0 || unique.size !== rule.weekdays.length) return "invalid_weekdays";
    if ([...unique].some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return "invalid_weekdays";
  }
  return null;
}

export function normalizedScheduleMessage(message: string): string {
  const clean = sanitizeAgentMessage(message);
  if (!clean) throw new Error("empty_message");
  if (agentMessageBytes(clean) > MAX_AGENT_MESSAGE_BYTES) throw new Error("message_too_long");
  return clean;
}

/**
 * The preface as it is stored on a schedule: sanitized, capped, and dropped
 * entirely when nothing survives — so a schedule without prefix commands has no
 * `preface` key at all, exactly like every schedule written before they existed.
 */
export function normalizedSchedulePreface(preface: string[] | undefined): string[] | undefined {
  if (!preface?.length) return undefined;
  const clean = preface.map(sanitizePrefaceCommand).filter(Boolean);
  if (!clean.length) return undefined;
  if (clean.length > MAX_PREFACE_COMMANDS) throw new Error("too_many_prefix_commands");
  return clean;
}

export function latestScheduleOccurrence(
  schedule: Pick<ScheduledAgentPrompt, "rule">,
  now: Date,
): ScheduleOccurrence | null {
  const { rule } = schedule;
  if (rule.type === "once") {
    const at = localWallClock(rule.at);
    return at && at.getTime() <= now.getTime() ? { key: rule.at, at } : null;
  }
  // Seven prior days cover every weekday set; eight lets a DST-gap day be
  // skipped without losing the previous occurrence.
  for (let offset = 0; offset >= -8; offset -= 1) {
    const day = dayOffset(now, offset);
    if (!ruleOccursOn(rule, day)) continue;
    const occurrence = occurrenceOnDay(day, rule.time);
    if (occurrence && occurrence.at.getTime() <= now.getTime()) return occurrence;
  }
  return null;
}

export function nextScheduleOccurrence(
  schedule: Pick<ScheduledAgentPrompt, "enabled" | "rule" | "last">,
  now: Date,
): ScheduleOccurrence | null {
  if (!schedule.enabled) return null;
  const { rule } = schedule;
  if (rule.type === "once") {
    if (schedule.last) return null;
    const at = localWallClock(rule.at);
    return at && at.getTime() >= now.getTime() ? { key: rule.at, at } : null;
  }
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = dayOffset(now, offset);
    if (!ruleOccursOn(rule, day)) continue;
    const occurrence = occurrenceOnDay(day, rule.time);
    if (occurrence && occurrence.at.getTime() >= now.getTime()) return occurrence;
  }
  return null;
}

/** Latest-only catch-up decision: recurring schedules never fan out a backlog. */
export function scheduleVerdict(schedule: ScheduledAgentPrompt, now: Date): ScheduleVerdict {
  if (!schedule.enabled) return { kind: "none" };
  const occurrence = latestScheduleOccurrence(schedule, now);
  // Local occurrence keys sort chronologically. Refuse an occurrence at or
  // before the latest receipt so a desktop clock/time-zone move backwards
  // cannot replay an already passed wall-clock slot.
  if (!occurrence || (schedule.last?.occurrence ?? "") >= occurrence.key) return { kind: "none" };
  // A one-time schedule is finished after any recorded result. This also keeps a
  // manually changed clock from making an older occurrence eligible again.
  if (schedule.rule.type === "once" && schedule.last) return { kind: "none" };
  const age = now.getTime() - occurrence.at.getTime();
  return age <= SCHEDULE_CATCH_UP_MS
    ? { kind: "wait", occurrence }
    : { kind: "missed", occurrence };
}

export function sortSchedules(schedules: ScheduledAgentPrompt[], now: Date): ScheduledAgentPrompt[] {
  return [...schedules].sort((a, b) => {
    const left = nextScheduleOccurrence(a, now)?.at.getTime()
      ?? latestScheduleOccurrence(a, now)?.at.getTime()
      ?? Number.MAX_SAFE_INTEGER;
    const right = nextScheduleOccurrence(b, now)?.at.getTime()
      ?? latestScheduleOccurrence(b, now)?.at.getTime()
      ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.id.localeCompare(b.id);
  });
}

export function desktopTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

// ── Status readout ───────────────────────────────────────────────────────────

/**
 * What a saved schedule is *doing* right now, as one word the row can wear.
 *
 * The list of a tab's schedules used to print only the rule and a next-run
 * stamp, which answers "when" and never "is this thing going to fire" — the two
 * states a user actually looks for (a schedule that is switched off, and one
 * whose hour has arrived and is waiting for the agent to fall idle) were
 * invisible, and a one-time prompt that had already run looked exactly like one
 * that never would. Precedence, highest first: an off switch beats everything,
 * a due-and-waiting occurrence beats a future one, and a recorded result is only
 * the headline once there is no future occurrence left to name.
 */
export type ScheduleStatusKind =
  | "paused"
  | "due"
  | "armed"
  | "delivered"
  | "missed"
  | "failed"
  | "expired";

export interface ScheduleStatus {
  kind: ScheduleStatusKind;
  /** The instant the status is *about*: the next run, or the last one. */
  at?: Date;
}

export function scheduleStatus(schedule: ScheduledAgentPrompt, now: Date): ScheduleStatus {
  if (!schedule.enabled) {
    const next = nextScheduleOccurrence({ ...schedule, enabled: true }, now);
    return { kind: "paused", at: next?.at };
  }
  const verdict = scheduleVerdict(schedule, now);
  if (verdict.kind === "wait") return { kind: "due", at: verdict.occurrence.at };
  const next = nextScheduleOccurrence(schedule, now);
  if (next) return { kind: "armed", at: next.at };
  if (schedule.last) return { kind: schedule.last.result, at: new Date(schedule.last.at) };
  return { kind: "expired" };
}

/**
 * `"in 3 hours"` / `"2 days ago"` in the app's language, via `Intl` — no unit
 * table to translate, and no hand-rolled pluralization to get wrong in four
 * languages. The unit is the largest one that still says something: minutes up
 * to an hour and a half, hours up to a day and a half, days beyond that.
 *
 * Pure, and takes `now` and `lang` as arguments for the reason the occurrence
 * math does: a readout that reaches for ambient state cannot be tested.
 */
export function relativeToNow(at: Date, now: Date, lang: string): string {
  const ms = at.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (abs < 90 * 60_000) return rtf.format(Math.round(ms / 60_000), "minute");
  if (abs < 36 * 3_600_000) return rtf.format(Math.round(ms / 3_600_000), "hour");
  return rtf.format(Math.round(ms / 86_400_000), "day");
}

/** The one-line summary above the list: how many rules, and when the first fires. */
export function scheduleSummary(
  schedules: ScheduledAgentPrompt[],
  now: Date,
): { total: number; enabled: number; next: Date | null } {
  const enabled = schedules.filter((schedule) => schedule.enabled);
  const next = enabled
    .map((schedule) => nextScheduleOccurrence(schedule, now)?.at)
    .filter((at): at is Date => !!at)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return { total: schedules.length, enabled: enabled.length, next };
}

/** The enabled schedules that will still fire, soonest first, each with its
 * next occurrence — what the phone's tab card lists above the last prompts. */
export function upcomingSchedules(
  schedules: ScheduledAgentPrompt[],
  now: Date,
  limit: number,
): { message: string; at: Date }[] {
  return schedules
    .flatMap((schedule) => {
      const at = nextScheduleOccurrence(schedule, now)?.at;
      return at ? [{ message: schedule.message, at }] : [];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, limit);
}

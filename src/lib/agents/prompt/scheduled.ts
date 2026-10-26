/**
 * Which collected prompts already went to scheduling.
 *
 * The two actions on a collected prompt part ways at send time: "Send now"
 * retires the prompt to the history (`sendCollectedPrompt`), so the list itself
 * says what happened to it, while "Schedule…" leaves it sitting exactly where
 * it was — the rule is somewhere else, on a tab, behind a dialog. The list then
 * reads the same whether a prompt is idle text or is going out at 09:00 every
 * morning, which is how the same prompt gets scheduled twice.
 *
 * The link is the prompt's TEXT, not an id: a schedule stores
 * `normalizedScheduleMessage(message)`, so the sanitized message is a key both
 * sides already agree on, with no field to add to the stored schedule and
 * nothing to keep in step. It follows the truth rather than an intention —
 * delete the rule and the mark goes with it, reword either side and the mark
 * drops, which is the honest answer to "is this text scheduled".
 *
 * Pure over already-loaded schedules: the view
 * holds the tabs and their rules, this decides what they mean for the list.
 */
import { sanitizeAgentMessage } from "../../../../shared/agentComposer";
import { isFinishedOneTime } from "./send";
import { nextScheduleOccurrence, type ScheduledAgentPrompt } from "../agentSchedule";

/** One agent tab's rules, named the way the row will name it. */
export interface ScheduleTargetRules {
  label: string;
  schedules: ScheduledAgentPrompt[];
}

export interface ScheduledPromptMark {
  /** The tabs carrying a rule for this text, in the order the tabs were given,
   *  each named once however many rules it holds. */
  tabs: string[];
  /** How many rules there are across those tabs. */
  count: number;
  /** The soonest occurrence any of them is armed for — null when every matching
   *  rule is disabled, which is scheduled but going nowhere. */
  next: Date | null;
}

/** The key a collected prompt and a schedule meet under. Empty for a message
 *  that sanitizes away, which is never matched. */
export function promptScheduleKey(message: string): string {
  return sanitizeAgentMessage(message);
}

/**
 * The collected prompt a rule carries, at most ONE: the prompt sharing the
 * rule's id (every path that turns a prompt into a rule — the chart's drop,
 * the schedule dialog opened from a prompt, send-now — writes the rule under
 * the prompt's id), else, for a rule written before rules carried that id or
 * typed straight into the dialog, the oldest prompt with its text.
 *
 * Never every prompt with the text: a second prompt with the same words is a
 * second prompt, and joining it to the first one's rule made it vanish from
 * the chart and get deleted when that rule retired.
 */
export function promptOfSchedule<P extends { id: string; message: string }>(
  prompts: readonly P[],
  schedule: { id: string; message: string },
): P | undefined {
  const byId = prompts.find((prompt) => prompt.id === schedule.id);
  if (byId) return byId;
  const key = promptScheduleKey(schedule.message);
  if (!key) return undefined;
  return prompts.find((prompt) => promptScheduleKey(prompt.message) === key);
}

/**
 * Mark, by prompt id, every collected prompt whose text has a live rule.
 *
 * A finished one-time rule is not one: it is a receipt, already in the Sent
 * prompts list, and marking a prompt for it would say "scheduled" about
 * something that can never fire again.
 */
export function scheduledPromptMarks(
  prompts: { id: string; message: string }[],
  targets: ScheduleTargetRules[],
  now: Date,
): Record<string, ScheduledPromptMark> {
  const byKey = new Map<string, ScheduledPromptMark>();
  for (const target of targets) {
    for (const schedule of target.schedules) {
      if (isFinishedOneTime(schedule)) continue;
      const key = promptScheduleKey(schedule.message);
      if (!key) continue;
      const mark = byKey.get(key) ?? { tabs: [], count: 0, next: null };
      if (!mark.tabs.includes(target.label)) mark.tabs.push(target.label);
      mark.count += 1;
      const at = nextScheduleOccurrence(schedule, now)?.at ?? null;
      if (at && (!mark.next || at.getTime() < mark.next.getTime())) mark.next = at;
      byKey.set(key, mark);
    }
  }
  const marks: Record<string, ScheduledPromptMark> = {};
  for (const prompt of prompts) {
    const mark = byKey.get(promptScheduleKey(prompt.message));
    if (mark) marks[prompt.id] = mark;
  }
  return marks;
}

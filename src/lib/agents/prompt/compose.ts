import type { UsageResetMark, UsageWindowKind } from "../agentUsageResets";
import { ceilPromptTime } from "./chart";

/**
 * What the quick composer's When menu can mean, in the order it lists them.
 * Each one is written through the chart's own writes (a draft, a send, the
 * schedule dialog, an `after` link, a one-time rule); this file only decides
 * which choices exist and what they would be called and aimed at.
 */
export const COMPOSE_WHENS = ["draft", "now", "time", "after", "session", "week"] as const;
export type ComposeWhen = (typeof COMPOSE_WHENS)[number];

/** The choices that wait for a rate-limit window to roll over. */
export function composeIsReset(when: ComposeWhen): when is UsageWindowKind {
  return when === "session" || when === "week";
}

/** The submit button's word follows the choice: a draft or a link to pick is
 *  only added, "now" is sent, a time or a reset is scheduled. */
export function composeSubmitKey(when: ComposeWhen): "promptChart.compose.add" | "promptChart.compose.send" | "promptChart.compose.schedule" {
  if (when === "now") return "promptChart.compose.send";
  if (when === "time" || composeIsReset(when)) return "promptChart.compose.schedule";
  return "promptChart.compose.add";
}

/** Where a prompt waiting for one agent's next reset of `kind` lands: the
 *  first snap minute at or after the reset. */
export interface ComposeReset {
  mark: UsageResetMark;
  at: Date;
}

/** The agent's next reset of `kind` after `now`, or null when it has no such
 *  mark ahead (no usage panel for that agent, or its window is not read). */
export function composeReset(
  marks: readonly UsageResetMark[],
  agent: string | undefined,
  kind: UsageWindowKind,
  now: Date,
  snapMinutes = 5,
): ComposeReset | null {
  if (!agent) return null;
  const mark = marks
    .filter((item) => item.agent === agent && item.kind === kind)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .find((item) => item.at.getTime() > now.getTime());
  return mark ? { mark, at: ceilPromptTime(mark.at, snapMinutes) } : null;
}

export interface ComposeOffer {
  when: ComposeWhen;
  reset?: ComposeReset;
}

/** The When choices an agent's marks allow; the two reset ones only when they exist. */
export function composeOffered(
  marks: readonly UsageResetMark[],
  agent: string | undefined,
  now: Date,
  snapMinutes = 5,
): ComposeOffer[] {
  return COMPOSE_WHENS.flatMap<ComposeOffer>((when) => {
    if (!composeIsReset(when)) return [{ when }];
    const reset = composeReset(marks, agent, when, now, snapMinutes);
    return reset ? [{ when, reset }] : [];
  });
}

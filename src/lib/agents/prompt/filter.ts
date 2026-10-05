/**
 * Narrowing the Agents view's Sent prompts list.
 *
 * The history is a bounded record of every prompt that reached (or failed to
 * reach) an agent — 200 entries per project — and the questions it is opened
 * with are always narrow ones: *what did I send Codex*, *what failed*, *what
 * went out today*, *where did that one sentence go*. Four independent facets
 * answer all four, and they compose, so "Claude, delivered, this week" is one
 * list rather than a scroll.
 *
 * Pure over already-loaded entries, like `lib/todoBoard`'s selectors: the view
 * holds the filter state and this decides what it means, so the meaning is what
 * gets unit-tested rather than a rendered list.
 */
import type { SentAgentPrompt } from "../../../stores/agents/agentPrompts";
import { matchesTagsOrText } from "./tags";

/** The time windows the picker offers, in the order it offers them. */
export const SENT_WINDOWS = ["any", "hour", "today", "week", "month"] as const;
export type SentWindow = (typeof SENT_WINDOWS)[number];

/** The delivery outcomes the picker offers. `queued` is the absence of a result
 *  — a prompt that has not reached its agent yet — which is a state of its own
 *  and the one a user goes looking for when something feels stuck. */
export const SENT_RESULTS = ["delivered", "queued", "missed", "failed"] as const;
export type SentResult = (typeof SENT_RESULTS)[number];

export interface SentPromptFilter {
  /** Free text over the prompt, the tab it went to, the agent, the session
   *  id, the tags and the files the prompt touched — a file name typed here is
   *  the prompt blame: every prompt that changed it. `#tag` matches tags only. */
  text: string;
  /** One tag, or "" for every prompt. */
  tag: string;
  /** An agent command (`claude`, `codex`, …), or "" for every agent. */
  agent: string;
  /** One of `SENT_RESULTS`, or "" for every outcome. */
  result: string;
  /** How far back to look, counted from the send. */
  window: SentWindow;
}

export const EMPTY_SENT_FILTER: SentPromptFilter = {
  text: "",
  tag: "",
  agent: "",
  result: "",
  window: "any",
};

/** Whether anything is actually being filtered out — what the "Clear filters"
 *  affordance and the "showing n of m" line key off. */
export function isSentFilterActive(filter: SentPromptFilter): boolean {
  return (
    filter.text.trim() !== ""
    || filter.tag !== ""
    || filter.agent !== ""
    || filter.result !== ""
    || filter.window !== "any"
  );
}

/**
 * The agents present in a project's history, sorted, so the picker offers the
 * ones this project actually talks to rather than a list of every agent Tabtivity
 * can launch. An entry written before the agent was recorded has none, and is
 * simply not an option.
 */
export function sentAgents(entries: SentAgentPrompt[]): string[] {
  return [...new Set(entries.map((entry) => entry.agent).filter((agent): agent is string => !!agent))].sort(
    (a, b) => a.localeCompare(b),
  );
}

/** The tags present in a project's history, sorted, for the tag picker. */
export function sentTags(entries: SentAgentPrompt[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.tags ?? []))].sort((a, b) => a.localeCompare(b));
}

/** A history entry's outcome as the filter names it. */
function resultOf(entry: SentAgentPrompt): SentResult {
  return entry.result ?? "queued";
}

/**
 * The earliest send a window admits, or `null` for "any time".
 *
 * `today` is the calendar day in the user's own timezone — "did I send that
 * this morning" is a question about the day on the wall, not about the last 24
 * hours — while the other three are rolling windows back from now, which is
 * what "in the last hour/week/month" means.
 */
function windowStart(window: SentWindow, now: Date): Date | null {
  switch (window) {
    case "hour":
      return new Date(now.getTime() - 3_600_000);
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "week":
      return new Date(now.getTime() - 7 * 86_400_000);
    case "month":
      return new Date(now.getTime() - 30 * 86_400_000);
    default:
      return null;
  }
}

function matchesText(entry: SentAgentPrompt, needle: string): boolean {
  const haystack = [
    entry.message,
    entry.tab_label,
    entry.agent ?? "",
    entry.session_id ?? "",
    entry.commit ?? "",
    entry.branch ?? "",
    ...(entry.files ?? []),
  ].join("\n");
  return matchesTagsOrText(entry.tags, haystack, needle);
}

/**
 * Apply a filter, keeping the list's own order (the caller reverses it for
 * newest-first display).
 *
 * An entry with an unparseable `sent_at` is KEPT by a time window rather than
 * dropped: the history is a record, and a row silently missing from a filtered
 * view is worse than one that fails to be excluded.
 */
export function filterSentPrompts(
  entries: SentAgentPrompt[],
  filter: SentPromptFilter,
  now: Date = new Date(),
): SentAgentPrompt[] {
  const needle = filter.text.trim();
  const since = windowStart(filter.window, now);
  return entries.filter((entry) => {
    if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false;
    if (filter.agent && entry.agent !== filter.agent) return false;
    if (filter.result && resultOf(entry) !== filter.result) return false;
    if (since) {
      const sent = new Date(entry.sent_at).getTime();
      if (Number.isFinite(sent) && sent < since.getTime()) return false;
    }
    if (needle && !matchesText(entry, needle)) return false;
    return true;
  });
}

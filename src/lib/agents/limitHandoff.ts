import { effectiveAgentOrder } from "../tabs/newTabItems";
import { stripAnsi } from "./prompt/prompt";
import { stripFormatControls } from "../textSafety";
import { resolveResetAt } from "../../../shared/usageReport";

const LIMIT_LINE = /^(?:[\s✻●⎿!■]*)(?:you(?:'|’)?ve hit your (?:(?:usage|5-hour|weekly|session) )?limit|you have hit your (?:(?:usage|5-hour|weekly|session) )?limit|you(?:'|’)?re out of (?:extra )?usage|usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|quota exceeded|limit reached)(?:\b|[.!])/iu;

/** The longest screen line the hand-off dialog quotes. */
export const LIMIT_LINE_MAX = 160;

/** A screen line as the dialog may quote it: ANSI, control and bidi/zero-width
 * characters gone (the screen is the agent's own output, so a line can be made
 * to read as something it is not), trimmed and cut. */
export function quotableLine(line: string): string {
  const plain = stripFormatControls(stripAnsi(line)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(plain).slice(0, LIMIT_LINE_MAX).join("");
}

/** The first screen line that is an explicit exhaustion notice, ready to quote;
 * `null` when none is. Never low-quota warnings or context limits. */
export function cliLimitNoticeLine(screen: string): string | null {
  const line = stripAnsi(screen).split("\n").find((candidate) => LIMIT_LINE.test(candidate));
  return line === undefined ? null : quotableLine(line);
}

/** Only explicit exhaustion notices, never low-quota warnings or context limits. */
export function hasCliLimitNotice(screen: string): boolean {
  return cliLimitNoticeLine(screen) !== null;
}

/** How far above the screen's last line a notice may sit and still be the
 *  current one: a TUI keeps its composer, hints and status line under the
 *  transcript, and anything further up has been answered by later output. */
const NOTICE_TAIL_LINES = 10;

/** `try again at 3:45 PM`, `resets 6pm (Europe/Berlin)`, `available again on Nov 20th, 2026 3:45 PM`. */
const RESET_AT = /\b(?:try again|retry|resets?|available again|again)\s+(?:at|on)?\s*([^.!;]*)/iu;
/** `try again in 2 hours 5 minutes`, `retry in 1h 30m`, `retry in 45s`. */
const RESET_IN = /\b(?:try again|retry|resets?|available again|again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/iu;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/giu;

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("d")) return 86_400_000;
  if (u.startsWith("h")) return 3_600_000;
  if (u.startsWith("m")) return 60_000;
  return 1_000;
}

export interface LimitNoticeReset {
  /** The notice as the dialog would quote it. */
  line: string;
  /** The CLI's own words for when it frees up, when the notice named a time. */
  resets?: string;
  /** That time, placed; absent when the notice names none this reader can place. */
  at?: Date;
}

/**
 * An exhaustion notice at the bottom of an agent's screen and the moment it
 * says the limit lifts — what auto-continue arms off for a CLI with no usage
 * panel. Only a notice in the last few lines counts: one further up is history
 * the session has already moved past. A time is read only from the notice and
 * the two lines it may wrap onto, through the same `resolveResetAt` the usage
 * panels go through; a duration is added to `now`. Anything else leaves `at`
 * unset rather than guessed.
 */
export function limitNoticeReset(screen: string, now: Date): LimitNoticeReset | null {
  const lines = stripAnsi(screen).split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < NOTICE_TAIL_LINES; i--) {
    if (lines[i].trim() !== "") tail.unshift(lines[i]);
  }
  let index = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (LIMIT_LINE.test(tail[i])) { index = i; break; }
  }
  if (index < 0) return null;
  const line = quotableLine(tail[index]);
  const text = tail.slice(index, index + 3).map(quotableLine).join(" ")
    // Codex writes ordinals (`Nov 20th, 2026`), which the panel reader does not.
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/giu, "$1");

  const within = RESET_IN.exec(text);
  if (within) {
    let ms = 0;
    for (const part of within[1].matchAll(DURATION_PART)) ms += Number(part[1]) * unitMs(part[2]);
    if (ms > 0) return { line, resets: within[0].trim(), at: new Date(now.getTime() + ms) };
  }
  const at = RESET_AT.exec(text);
  if (at) {
    const phrase = at[1].trim();
    const placed = phrase ? resolveResetAt(phrase, now) : null;
    if (placed && placed.getTime() > now.getTime()) return { line, resets: phrase, at: placed };
  }
  return { line };
}

export interface HandoffCli { bin: string; label: string; installed: boolean }

/** Walk forward only: exhausting the list must never cycle back to a limited CLI. */
export function nextLimitCli(current: string, rows: readonly HandoffCli[], order: readonly string[] | undefined, defaultBin: string): HandoffCli | undefined {
  const keys = effectiveAgentOrder(rows.map((row) => row.bin), order, defaultBin);
  const index = keys.indexOf(current);
  if (index < 0) return undefined;
  return keys.slice(index + 1).map((bin) => rows.find((row) => row.bin === bin)).find((row) => row?.installed);
}

import { effectiveAgentOrder } from "../tabs/newTabItems";
import { stripAnsi } from "./prompt/prompt";
import { stripFormatControls } from "../textSafety";

const LIMIT_LINE = /^(?:[\s✻●⎿!]*)(?:you(?:'|’)?ve hit your (?:(?:usage|5-hour|weekly|session) )?limit|you have hit your (?:(?:usage|5-hour|weekly|session) )?limit|you(?:'|’)?re out of (?:extra )?usage|usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|quota exceeded|limit reached)(?:\b|[.!])/iu;

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

export interface HandoffCli { bin: string; label: string; installed: boolean }

/** Walk forward only: exhausting the list must never cycle back to a limited CLI. */
export function nextLimitCli(current: string, rows: readonly HandoffCli[], order: readonly string[] | undefined, defaultBin: string): HandoffCli | undefined {
  const keys = effectiveAgentOrder(rows.map((row) => row.bin), order, defaultBin);
  const index = keys.indexOf(current);
  if (index < 0) return undefined;
  return keys.slice(index + 1).map((bin) => rows.find((row) => row.bin === bin)).find((row) => row?.installed);
}

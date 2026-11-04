import { effectiveAgentOrder } from "../tabs/newTabItems";
import { stripAnsi } from "./prompt/prompt";

/** Only explicit exhaustion notices, never low-quota warnings or context limits. */
export function hasCliLimitNotice(screen: string): boolean {
  return stripAnsi(screen).split("\n").some((line) => /^(?:[\s✻●⎿!]*)(?:you(?:'|’)?ve hit your (?:(?:usage|5-hour|weekly|session) )?limit|you have hit your (?:(?:usage|5-hour|weekly|session) )?limit|you(?:'|’)?re out of (?:extra )?usage|usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|quota exceeded|limit reached)(?:\b|[.!])/iu.test(line));
}

export interface HandoffCli { bin: string; label: string; installed: boolean }

/** Walk forward only: exhausting the list must never cycle back to a limited CLI. */
export function nextLimitCli(current: string, rows: readonly HandoffCli[], order: readonly string[] | undefined, defaultBin: string): HandoffCli | undefined {
  const keys = effectiveAgentOrder(rows.map((row) => row.bin), order, defaultBin);
  const index = keys.indexOf(current);
  if (index < 0) return undefined;
  return keys.slice(index + 1).map((bin) => rows.find((row) => row.bin === bin)).find((row) => row?.installed);
}

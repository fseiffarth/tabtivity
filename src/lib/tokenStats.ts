/**
 * Agent token counts for the usage recap's Tokens section — the pure half.
 *
 * The backend derives `tokens.<kind>.<cli>.<model>` counters from the CLIs' own
 * transcripts (`usage_token_stats`, `services::token_stats`) and hands them over
 * in the same hour/day bucket shape as `usage_summary`, so the recap's window
 * helpers (`usageRollup`) sum them into a period unchanged. This module folds
 * one period's counters into per-CLI rows with a per-model breakdown, formats
 * the numbers, and drives the bounded refetch of a scan that is still partial.
 *
 * Kept free of React and Tauri so vitest can cover it directly.
 */

import { METRIC } from "./usageMetrics";
import type { BucketReport, Counters } from "./usageRollup";

/** What `usage_token_stats` returns (`commands::usage_stats::TokenReport`). */
export interface TokenReport extends BucketReport<Counters> {
  /** The scan stopped at its byte budget; the counts are short and the next
   *  call carries on from where it stopped. */
  partial: boolean;
  /** The CLIs whose records are read at all (`claude`, `codex`). A CLI used in
   *  the period but missing here is "not reported" — never zero. */
  sources: string[];
}

/** One CLI's or model's tokens. `total` is the part reported with no split
 *  (only Codex's SQLite fallback writes one); it is never folded into the four
 *  split fields. */
export interface TokenSplit {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface TokenModelRow {
  model: string;
  split: TokenSplit;
}

export interface TokenCliRow {
  cli: string;
  split: TokenSplit;
  /** Largest first. */
  models: TokenModelRow[];
}

export interface TokenRows {
  /** CLIs with token records, or used in the period and readable — largest first. */
  reported: TokenCliRow[];
  /** CLIs used in the period whose records Tabtivity cannot read, sorted. */
  notReported: string[];
}

type Kind = keyof TokenSplit;

const KIND_BY_PREFIX: [string, Kind][] = [
  [METRIC.TOKENS_IN, "fresh"],
  [METRIC.TOKENS_CACHE_W, "cacheWrite"],
  [METRIC.TOKENS_CACHE_R, "cacheRead"],
  [METRIC.TOKENS_OUT, "output"],
  [METRIC.TOKENS_TOTAL, "total"],
];

const emptySplit = (): TokenSplit => ({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });

/**
 * Read one `tokens.<kind>.<cli>.<model>` key. The model is everything after the
 * third `.` — model names carry dots (`gpt-6.1-sol`, `claude-opus-4.5`) — so it
 * is never split further. Anything else (another metric, a key with no model)
 * is `null`.
 */
export function parseTokenKey(key: string): { kind: Kind; cli: string; model: string } | null {
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (!key.startsWith(`${prefix}.`)) continue;
    const rest = key.slice(prefix.length + 1);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return null;
    return { kind, cli: rest.slice(0, dot), model: rest.slice(dot + 1) };
  }
  return null;
}

/** Fresh in + cache write + cache read + output. */
export function splitSum(s: TokenSplit): number {
  return s.fresh + s.cacheWrite + s.cacheRead + s.output;
}

/** Everything, the unsplit total included. */
export function grandTotal(s: TokenSplit): number {
  return splitSum(s) + s.total;
}

/**
 * Output as a share of the split tokens, 0–1; `null` when nothing was split
 * (a total-only row has no share to show, and 0/0 is not 0 %).
 */
export function outputShare(s: TokenSplit): number | null {
  const sum = splitSum(s);
  return sum > 0 ? s.output / sum : null;
}

function addInto(into: TokenSplit, kind: Kind, n: number): void {
  if (Number.isFinite(n) && n > 0) into[kind] += n;
}

/**
 * Fold one period's counters into rows per CLI, each with its models.
 *
 * `usedClis` are the agent leaves the period's `agent.tab.*` / `agent.prompt.*`
 * counters name (see {@link usedAgentClis}). One that is in `sources` but wrote
 * no tokens gets an honest all-zero row; one that is not in `sources` is
 * listed in `notReported` and never shows a number.
 */
export function foldTokens(counters: Counters, sources: string[], usedClis: string[] = []): TokenRows {
  const byCli = new Map<string, { split: TokenSplit; models: Map<string, TokenSplit> }>();
  const cliEntry = (cli: string) => {
    let entry = byCli.get(cli);
    if (!entry) {
      entry = { split: emptySplit(), models: new Map() };
      byCli.set(cli, entry);
    }
    return entry;
  };
  for (const [key, n] of Object.entries(counters)) {
    const parsed = parseTokenKey(key);
    if (!parsed) continue;
    const entry = cliEntry(parsed.cli);
    let model = entry.models.get(parsed.model);
    if (!model) {
      model = emptySplit();
      entry.models.set(parsed.model, model);
    }
    addInto(entry.split, parsed.kind, n);
    addInto(model, parsed.kind, n);
  }

  const readable = new Set(sources);
  const notReported = new Set<string>();
  for (const cli of usedClis) {
    if (byCli.has(cli)) continue;
    if (readable.has(cli)) cliEntry(cli);
    else notReported.add(cli);
  }

  const reported: TokenCliRow[] = [...byCli].map(([cli, { split, models }]) => ({
    cli,
    split,
    models: [...models]
      .map(([model, s]) => ({ model, split: s }))
      .sort((a, b) => grandTotal(b.split) - grandTotal(a.split) || a.model.localeCompare(b.model)),
  }));
  reported.sort((a, b) => grandTotal(b.split) - grandTotal(a.split) || a.cli.localeCompare(b.cli));
  return { reported, notReported: [...notReported].sort() };
}

/**
 * The cloud-agent CLIs a period's usage counters say were used: the leaves of
 * `agent.tab.*` (local models excluded — they are a model, not a CLI, and file
 * under `agent.tab.local.*`) and of `agent.prompt.*` (minus their `local.*`
 * leaves for the same reason).
 */
export function usedAgentClis(counters: Counters): string[] {
  const used = new Set<string>();
  const tabHead = `${METRIC.AGENT_TAB}.`;
  const localHead = `${METRIC.AGENT_TAB_LOCAL}.`;
  const promptHead = `${METRIC.AGENT_PROMPT}.`;
  for (const [key, n] of Object.entries(counters)) {
    if (!(n > 0)) continue;
    if (key.startsWith(tabHead) && !key.startsWith(localHead)) used.add(key.slice(tabHead.length));
    else if (key.startsWith(promptHead)) {
      const leaf = key.slice(promptHead.length);
      if (!leaf.startsWith("local.")) used.add(leaf);
    }
  }
  used.delete("");
  return [...used];
}

const UNITS = ["", "k", "M", "B", "T"];

/** A compact count: `950`, `1.2k`, `34k`, `1.2M`. One decimal below 10 of a unit. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  let unit = 0;
  let v = n;
  while (v >= 1000 && unit < UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  if (unit === 0) return String(Math.round(v));
  let text = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
  // 999.6k rounds to "1000k"; that is 1M.
  if (Number(text) >= 1000 && unit < UNITS.length - 1) {
    unit++;
    text = "1";
  }
  return `${text}${UNITS[unit]}`;
}

/** A 0–1 share as a percentage: `0.4%` below one percent, whole numbers above. */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** How many times the recap asks again while a first scan is still partial. */
export const TOKEN_FETCH_MAX_TRIES = 5;
/** The pause between those asks. */
export const TOKEN_FETCH_DELAY_MS = 1500;

/**
 * Fetch the token report, asking again while the backend says it is partial —
 * a first scan of a big agent home takes a few budgeted passes — but at most
 * `maxTries` times in all, and never once it is complete. This is the only
 * repetition: no polling once the numbers are whole.
 *
 * `onReport` gets every answer (the counts grow pass by pass) with whether
 * another ask is coming. `isCancelled` stops it between asks (the dialog
 * closed). A failed ask ends the loop and rejects.
 */
export async function fetchTokenReport(
  fetch: () => Promise<TokenReport>,
  onReport: (report: TokenReport, moreComing: boolean) => void,
  opts: {
    maxTries?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
  } = {},
): Promise<number> {
  const maxTries = opts.maxTries ?? TOKEN_FETCH_MAX_TRIES;
  const delayMs = opts.delayMs ?? TOKEN_FETCH_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cancelled = opts.isCancelled ?? (() => false);
  let tries = 0;
  while (!cancelled()) {
    const report = await fetch();
    tries++;
    if (cancelled()) break;
    const more = report.partial && tries < maxTries;
    onReport(report, more);
    if (!more) break;
    await sleep(delayMs);
  }
  return tries;
}

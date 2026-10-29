import { parseUsageReport, type UsageMeter } from "./usageReport";
import { sessionLimits } from "../mobile-web/src/terminal/sessionUsage";

/**
 * The CLI overview's rows (`services::cli_overview`, `agent_overview` on the
 * desktop, `GET /api/v1/clis` on the phone) and the two readings both
 * surfaces make of them: the plan's name and the windows as meters. Shared so
 * the side panel and the phone cannot word a plan or a window differently.
 */

export interface CliPlan {
  /** As the login file spells it: `max`, `pro`, `plus`, `team`, … */
  name: string;
  /** Claude's `rateLimitTier` (`default_claude_max_5x`). */
  tier?: string;
  /** Codex's subscription end, RFC 3339. */
  until?: string;
}

export interface CliWindow { used: number; resetsAt?: number }

export interface CliLimits {
  session?: CliWindow;
  week?: CliWindow;
  /** Unix seconds the figures were written (Codex's last turn). */
  readAt: number;
}

/** Claude's `/usage` panel as printed, or the fixed code why there is none. */
export interface CliUsagePanel { raw?: string; code?: string; cached: boolean }

export interface CliOverviewRow {
  id: string;
  label: string;
  signedIn: boolean;
  /** Desktop only — the phone's rows never carry it. */
  account?: string;
  plan?: CliPlan;
  limits?: CliLimits;
  usage?: CliUsagePanel;
}

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * A plan's display name: `max` on a `…_max_5x` tier is `Max 5x`, every other
 * value title-cased word by word (`pro` → `Pro`, `team_plus` → `Team Plus`).
 * An unknown value is still shown, never dropped.
 */
export function planLabel(plan: CliPlan): string {
  const base = plan.name.split(/[_\s-]+/u).filter(Boolean).map(titleCase).join(" ");
  const multiple = plan.tier?.match(/_(\d+)x$/u)?.[1];
  return multiple ? `${base} ${multiple}x` : base;
}

/**
 * A row's windows as meters. Claude's come from its panel — every window it
 * names, the per-model weekly lines too; Codex's from its rollout, where a
 * window that has rolled over since is left out rather than shown as used.
 */
export function overviewMeters(row: CliOverviewRow, now: Date): UsageMeter[] {
  if (row.usage?.raw) return parseUsageReport(row.usage.raw).meters;
  if (!row.limits) return [];
  const { session, week } = sessionLimits(
    { session: row.limits.session, week: row.limits.week },
    now,
  );
  return [session, week].filter((meter): meter is UsageMeter => !!meter);
}

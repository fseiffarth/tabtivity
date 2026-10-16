import { dayKey } from "./usageRollup";

/** The time log's shape: UTC day ("YYYY-MM-DD") → scope id → seconds
 *  (`get_time_activity_all`). Holds pseudo-scopes too (the app's own timer,
 *  the root terminal), which are never projects. */
export type TimeByDay = Record<string, Record<string, number>>;

/** What the welcome-back line says: on `day` you worked mostly on
 *  `projectId`; `alternatives` are the other projects you worked on lately. */
export interface WelcomeBack {
  day: string;
  projectId: string;
  alternatives: string[];
}

const DAY_MS = 86_400_000;
/** How far back, from the last working day, an alternative may come from. */
const ALTERNATIVE_WINDOW_DAYS = 14;
const MAX_ALTERNATIVES = 2;

/** The last day before today with tracked time on any scope but `ignore` (the
 *  app's own timer) — the day the startup recap is about. Null when there is
 *  none: a fresh install, so nothing to look back on. */
export function lastActiveDay(timeByDay: TimeByDay, today: string, ignore: string): string | null {
  let best: string | null = null;
  for (const [day, scopes] of Object.entries(timeByDay)) {
    if (day >= today || (best !== null && day <= best)) continue;
    if (Object.entries(scopes).some(([id, secs]) => id !== ignore && secs > 0)) best = day;
  }
  return best;
}

/**
 * Where you left off: the project with the most time on `day`, and up to two
 * others ranked by time over the fortnight ending that day. Only ids in
 * `projectIds` count — pseudo-scopes and deleted projects drop out. Null when
 * no live project has time on `day`.
 */
export function pickWelcomeBack(timeByDay: TimeByDay, day: string, projectIds: ReadonlySet<string>): WelcomeBack | null {
  const rank = (totals: Record<string, number>) =>
    Object.entries(totals)
      .filter(([id, secs]) => projectIds.has(id) && secs > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

  const projectId = rank(timeByDay[day] ?? {})[0];
  if (!projectId) return null;

  const end = dayAnchorMs(day);
  const totals: Record<string, number> = {};
  for (let i = 0; i < ALTERNATIVE_WINDOW_DAYS; i++) {
    for (const [id, secs] of Object.entries(timeByDay[dayKey(end - i * DAY_MS)] ?? {})) {
      totals[id] = (totals[id] ?? 0) + secs;
    }
  }
  const alternatives = rank(totals).filter((id) => id !== projectId).slice(0, MAX_ALTERNATIVES);
  return { day, projectId, alternatives };
}

/** Midday UTC of a day key, as an anchor timestamp for the recap's window. */
export function dayAnchorMs(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

/**
 * Folding persisted per-bucket usage into calendar windows.
 *
 * Both stores Tabtivity rolls up on disk — `net_usage.json` (bytes) and
 * `usage_stats.json` (counters) — have the same shape: a map of UTC bucket keys
 * ("YYYY-MM-DD" for days, "YYYY-MM-DDTHH" for hours) to a per-bucket payload. So
 * the windowing is one implementation, generic over the payload, rather than one
 * per store. `NetworkTrafficPane` and the usage recap both read it.
 *
 * Every key here is **UTC**, because the backend writes them with
 * `storage::hour_utc()` / `today_utc()`. Computing the windows in local time
 * would silently mis-file the hours around midnight.
 *
 * Windows are **calendar-aligned**, not rolling: "this week" is the elapsed part
 * of the current ISO week (Mon–Sun), not the last seven days, to match how
 * "today" and "this month" already read.
 */

const DAY_MS = 86_400_000;

/** The five windows every usage surface shows. */
export interface Windows<T> {
  hour: T;
  today: T;
  week: T;
  month: T;
  overall: T;
}

/** A period the recap can be scoped to. */
export type Period = "day" | "week" | "month";

/** The UTC date key ("YYYY-MM-DD") for a timestamp. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC hour key ("YYYY-MM-DDTHH") for a timestamp. */
export function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

/**
 * The seven UTC date keys of the ISO week (Monday–Sunday) containing `nowMs`.
 * Calendar-aligned rather than a rolling seven days, to match "today" and "this
 * month" — every window shown is the elapsed part of a calendar period.
 */
export function isoWeekKeys(nowMs: number): string[] {
  const now = new Date(nowMs);
  const sinceMonday = (now.getUTCDay() + 6) % 7; // getUTCDay: 0 = Sunday
  const monday = nowMs - sinceMonday * DAY_MS;
  return Array.from({ length: 7 }, (_, day) => dayKey(monday + day * DAY_MS));
}

/**
 * Every UTC date key belonging to `period` as anchored at `anchorMs`.
 *
 * - `day` → just that date.
 * - `week` → the ISO week containing it.
 * - `month` → every day of that calendar month (not a rolling 30).
 *
 * Days in the future (the rest of the current week/month) are included and simply
 * have no buckets — summing them contributes nothing.
 */
export function periodKeys(period: Period, anchorMs: number): string[] {
  if (period === "day") return [dayKey(anchorMs)];
  if (period === "week") return isoWeekKeys(anchorMs);
  const anchor = new Date(anchorMs);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  // Day 0 of the *next* month is the last day of this one.
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => dayKey(Date.UTC(year, month, i + 1)));
}

/** A store's two bucket maps, as the backend returns them. */
export interface BucketReport<T> {
  hours?: Record<string, T>;
  days?: Record<string, T>;
}

/**
 * Fold a report into this-hour / today / this-week / this-month / overall.
 *
 * `zero` mints an empty accumulator and `add` folds one bucket into it — supply
 * the pair for the payload in question (bytes, counters, …). Only the hour total
 * reads `hours`; the rest sum `days`, which is why pruning the hour window can
 * never change them.
 */
export function summarizeBuckets<T>(
  report: BucketReport<T>,
  nowMs: number,
  zero: () => T,
  add: (into: T, from: T | undefined) => void,
): Windows<T> {
  const iso = new Date(nowMs).toISOString();
  const hour = iso.slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const today = iso.slice(0, 10); // YYYY-MM-DD (UTC)
  const month = iso.slice(0, 7); // YYYY-MM (UTC)
  const weekKeys = new Set(isoWeekKeys(nowMs));

  const acc: Windows<T> = {
    hour: zero(),
    today: zero(),
    week: zero(),
    month: zero(),
    overall: zero(),
  };

  add(acc.hour, report.hours?.[hour]);
  for (const [date, payload] of Object.entries(report.days ?? {})) {
    add(acc.overall, payload);
    if (date.startsWith(month)) add(acc.month, payload);
    if (weekKeys.has(date)) add(acc.week, payload);
    if (date === today) add(acc.today, payload);
  }
  return acc;
}

// ── Counter payloads (usage_stats.json) ────────────────────────────────────

/** metric key → count, as `schema::usage_stats::Counters` serializes. */
export type Counters = Record<string, number>;

/** Add every counter in `from` into `into`, in place. */
export function addCounters(into: Counters, from: Counters | undefined): void {
  if (!from) return;
  for (const [key, n] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + n;
  }
}

/** Sum the counters of `keys`' buckets. Absent buckets contribute nothing. */
export function sumCounters(buckets: Record<string, Counters> | undefined, keys: string[]): Counters {
  const acc: Counters = {};
  for (const key of keys) addCounters(acc, buckets?.[key]);
  return acc;
}

/** The counters recorded over `period`, anchored at `anchorMs`. */
export function countersForPeriod(
  report: BucketReport<Counters>,
  period: Period,
  anchorMs: number,
): Counters {
  return sumCounters(report.days, periodKeys(period, anchorMs));
}

/**
 * Counters whose key starts with `prefix.`, keyed by the remaining leaf.
 *
 * The metric key space is deliberately open — `agent.prompt.claude`,
 * `agent.tab.local.qwen3:8b` — so this is how a breakdown ("prompts, by agent")
 * is read back out without the reader needing to know which agents exist.
 *
 * `exclude` names deeper namespaces that sit *under* `prefix` and must not be
 * folded into it: `agent.tab` has to skip `agent.tab.local.*`, or every local
 * model would be counted both as its own model and as an agent named "local".
 * It is passed explicitly rather than inferred from the leaf shape, because a
 * leaf may legitimately contain dots — `llama3.1:8b` is one model, not a
 * namespace.
 */
export function breakdown(
  counters: Counters,
  prefix: string,
  exclude: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {};
  const head = `${prefix}.`;
  for (const [key, n] of Object.entries(counters)) {
    if (!key.startsWith(head)) continue;
    if (exclude.some((ex) => key.startsWith(`${ex}.`))) continue;
    out[key.slice(head.length)] = (out[key.slice(head.length)] ?? 0) + n;
  }
  return out;
}

/** Total of every value in a breakdown. */
export function totalOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

import type { useT } from "../../lib/i18n";
import { useI18nStore } from "../../lib/i18n";
import { relativeToNow } from "../../lib/agents/agentSchedule";
import { formatTime } from "../../lib/calendar/calendarTime";
import { readUse24h } from "../../lib/timeFormat";
import type { RosterRow } from "../../lib/cockpit/roster";

type T = ReturnType<typeof useT>;

/** "42s", "4m", "1h 12m" — a turn's length, in the phone card's words. */
export function formatTurn(ms: number, t: T): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t("mobile.project.durationSecs", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("mobile.project.durationMins", { count: minutes });
  return t("mobile.project.durationHours", { hours: Math.floor(minutes / 60), mins: minutes % 60 });
}

/** A wall-clock time ("22:00" / "10:00 PM"), in the user's clock format. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return formatTime(hhmm, readUse24h());
}

/** How long ago, in the app language ("2 hours ago"). */
export function formatAgo(ms: number, now: number): string {
  return relativeToNow(new Date(ms), new Date(now), useI18nStore.getState().lang);
}

/** The roster's turn reading: "4m so far" while a turn runs, "took 12m ·
 *  finished 2 hours ago" once it is over; nothing without a reading. */
export function rosterTurnLabel(row: RosterRow, now: number, t: T): string {
  const turn = row.turn;
  if (!turn) return row.facts.doneAt !== undefined ? t("mobile.project.turnFinished", { ago: formatAgo(row.facts.doneAt, now) }) : "";
  const duration = formatTurn(turn.ms, t);
  if (turn.running) return t("mobile.project.turnRunning", { duration });
  return `${t("mobile.project.turnTook", { duration })} · ${t("mobile.project.turnFinished", { ago: formatAgo(turn.end, now) })}`;
}

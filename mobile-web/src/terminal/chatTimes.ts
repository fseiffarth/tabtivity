import { dateLocale } from "../../../src/lib/i18n";

/**
 * The times a messenger puts on a chat: the clock time in a bubble's corner,
 * and a day chip across the chat where the day changes. Both read the
 * record's own RFC 3339 stamp in the phone's time zone; a record without one
 * gets neither (never a made-up time).
 */

/** A stamp as a moment, or null when it is missing or unreadable. */
export function chatMoment(at: string | undefined): Date | null {
  if (!at) return null;
  const moment = new Date(at);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/** The clock time in a bubble's corner: `14:05`. `use24h` is the desktop's
 * clock answer (`lib/timeFormat`: the setting, else the OS) — its webview's
 * locale is not the desktop's, so without it an English UI printed `2:05 PM`
 * on a 24-hour desktop. The phone leaves it to its own browser's locale. */
export function chatTime(moment: Date, use24h?: boolean): string {
  return moment.toLocaleTimeString([], use24h === undefined
    ? { hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

/** The local calendar day of a moment, as a sortable key (`2026-09-29`). */
export function chatDayKey(moment: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** The day chip's words: Today, Yesterday, the weekday within the last week,
 * else the date — with its year only when that is not this year. */
export function chatDayLabel(moment: Date, now: Date, labels: { today: string; yesterday: string }): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day across a daylight-saving change is 23 or 25 hours.
  const days = Math.round((midnight(now) - midnight(moment)) / 86_400_000);
  if (days === 0) return labels.today;
  if (days === 1) return labels.yesterday;
  if (days > 1 && days < 7) return moment.toLocaleDateString(dateLocale(), { weekday: "long" });
  return moment.toLocaleDateString(dateLocale(), moment.getFullYear() === now.getFullYear()
    ? { weekday: "short", day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

/** Which of the stamps (in chat order) open a day and so get a chip over
 * them. Only a later day opens one — a prompt pending on the phone's clock,
 * a little behind the desktop's, does not bring an earlier day back — so a
 * new chip only ever comes at the end, never above a bubble already shown. */
export function dayOpeners(stamps: readonly (string | undefined)[]): Set<number> {
  const openers = new Set<number>();
  let last = "";
  stamps.forEach((stamp, index) => {
    const moment = chatMoment(stamp);
    if (!moment) return;
    const day = chatDayKey(moment);
    if (day > last) {
      openers.add(index);
      last = day;
    }
  });
  return openers;
}

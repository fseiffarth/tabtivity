import { resolveResetAt } from "../../../shared/usageReport";
import { dateLocale, translate, useI18nStore } from "../../../src/lib/i18n";

/* The facts row's reset readouts, shared by the phone's facts row and status
 * sheet and the desktop Reader's facts row (`TerminalReaderFacts`). */

/** A compact time left for a reset the reader can place. Empty for an unknown
 * phrase or a reset that has already passed. */
export function resetCountdown(phrase: string, now: Date, readAt = now): string {
  const at = resolveResetAt(phrase, readAt);
  if (!at) return "";
  const minutes = Math.floor((at.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return "";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  // Past two days the minutes drop off, unless the hours read zero: `4d 0h`
  // says nothing a `4d 37m` doesn't say better.
  const days = Math.floor(hours / 24);
  const lang = useI18nStore.getState().lang;
  return hours % 24
    ? translate(lang, "mobile.time.daysHours", { days, hours: hours % 24 })
    : translate(lang, "mobile.time.daysMinutes", { days, minutes: minutes % 60 });
}

/**
 * A window's rollover said exactly: weekday, date and clock in the phone's own
 * locale and timezone, plus how long is left. The CLI's words name a day or a
 * clock depending on its release and the window (`Mon 9am`, `6:20pm`,
 * `Sep 17, 2pm (Europe/Berlin)`) and are written on the desktop's clock, which
 * need not be the phone's. Placed through `resolveResetAt`, the same reading
 * auto-continue arms off, so the two cannot disagree; a phrase it cannot place
 * is shown in the CLI's own words rather than guessed at.
 */
export function resetText(phrase: string, now: Date, readAt = now): string {
  const at = resolveResetAt(phrase, readAt);
  const lang = useI18nStore.getState().lang;
  if (!at) return translate(lang, "mobile.time.resets", { when: phrase });
  const when = new Intl.DateTimeFormat(dateLocale(lang), {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at);
  const left = resetCountdown(phrase, now, readAt);
  return left ? translate(lang, "mobile.time.resetsIn", { when, left }) : translate(lang, "mobile.time.resets", { when });
}

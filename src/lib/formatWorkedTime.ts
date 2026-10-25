import type { TranslationKey } from "./i18n";

/** A tracked-time total — `< 1 min`, `12m`, `1h 5m`: the one
 *  ladder the header timer, project hover card, stats and activity calendar share. */
export function formatWorkedTime(t: (key: TranslationKey) => string, secs: number): string {
  if (secs < 60) return t("projectHoverCard.timeUnderMinute");
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

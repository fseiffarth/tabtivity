/** How a file's age and size read on the phone: the same words wherever a
 * file is listed — the composer's desktop pictures and the agent's gallery —
 * in the phone's language. */

import { translate, useI18nStore } from "../../../src/lib/i18n";

export function ageLabel(seconds: number) {
  const lang = useI18nStore.getState().lang;
  if (seconds < 60) return translate(lang, "mobile.time.justNow");
  if (seconds < 3_600) return translate(lang, "mobile.time.minutesAgo", { count: Math.round(seconds / 60) });
  if (seconds < 86_400) return translate(lang, "mobile.time.hoursAgo", { count: Math.round(seconds / 3_600) });
  return translate(lang, "mobile.time.daysAgo", { count: Math.round(seconds / 86_400) });
}

export function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

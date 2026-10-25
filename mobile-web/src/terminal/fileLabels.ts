/** How a file's or a tab's age reads on the phone: the same words wherever
 * something is dated — the composer's desktop pictures, the agent's gallery,
 * the Activity rows — in the phone's language. */

import { translate, useI18nStore, type TranslationKey } from "../../../src/lib/i18n";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** "3 min ago" from an age in seconds — a rough one: minutes up to 90 of
 * them, hours up to 36 of them, then days. `t` defaults to the phone's
 * current language; a component passes its own `useT()` to re-render on a switch. */
export function ageLabel(seconds: number, t?: Translate) {
  const say: Translate = t ?? ((key, vars) => translate(useI18nStore.getState().lang, key, vars));
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 1) return say("mobile.time.justNow");
  if (minutes < 90) return say("mobile.time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 36) return say("mobile.time.hoursAgo", { count: hours });
  return say("mobile.time.daysAgo", { count: Math.round(hours / 24) });
}

import { useSettingsStore } from "../stores/settings";
import { useI18nStore, type Language } from "./i18n";
import { useOsClockStore } from "./osClock";

/**
 * **The one answer to "12-hour or 24-hour?"** — read by every surface that
 * prints a wall clock: the header clock, the calendar's grids and agenda, the
 * header's day and to-do lists, the board cards, the reminder popup, the mail
 * list's dates.
 *
 * It is one setting rather than one per feature because a clock is not a
 * property of a *feature*. A user who reads "17:00" in the calendar and "5:00 PM"
 * two centimetres away on a to-do card is looking at one app that cannot agree
 * with itself about what time it is — and the calendar's own switch, which is
 * what this replaces, was exactly that: it moved the grid and left the header
 * clock, the alarm popup and every task readout behind.
 *
 * **Unset follows the OS.** The user has already told their desktop which
 * clock they read — its panel clock is right there beside Tabtivity — so an unset
 * setting takes that answer (`lib/osClock.ts`) instead of guessing from the UI
 * language: an English UI on a German desktop still reads 17:00. Only when the
 * OS has no opinion (or has not answered yet) does the language decide. Setting
 * it explicitly overrides both for good: a choice made by hand must not be
 * undone by a later desktop or language change, which is why `null`/`undefined`
 * (never `false`) is what "not chosen" looks like on the wire.
 */

/**
 * The convention a language implies — the last resort, used only while nothing
 * is set and the OS gave no answer.
 *
 * A language, not a region: Tabtivity has no region setting, and the five languages
 * it speaks split cleanly here — English is the AM/PM one, German, Spanish,
 * French and Italian all write 17:00. (Regional exceptions exist — Australian
 * and Irish English lean 24-hour in print — but a *default* only has to be right
 * more often than not, and the switch is what settles the rest.)
 */
export function defaultUse24h(lang: Language): boolean {
  return lang !== "en";
}

/**
 * The effective clock: the explicit setting when there is one, then the OS's
 * clock, then the language's convention.
 *
 * `legacy` is the retired calendar-only key (`calendar_time_format_24h`), read
 * once so a user who already turned 24-hour on for their calendar keeps it
 * app-wide instead of silently losing it. It is never written again — the two
 * cannot drift, because only one of them is a destination.
 *
 * Pure, and takes every input, for the reason `lib/alerts`' `now` is a
 * parameter: this is a precedence rule, and the cases that matter (unset, so
 * the OS or the language decides) are only testable if nothing is ambient.
 */
export function resolveUse24h(
  setting: boolean | null | undefined,
  legacy: boolean | null | undefined,
  os: boolean | null | undefined,
  lang: Language,
): boolean {
  if (setting !== undefined && setting !== null) return setting;
  if (legacy !== undefined && legacy !== null) return legacy;
  if (os !== undefined && os !== null) return os;
  return defaultUse24h(lang);
}

/**
 * The hook every component uses. Subscribes to every input, so flipping the
 * switch — or the OS answering, or the language changing while the switch is
 * untouched — re-renders the clocks in place, the way `useT()` already
 * re-renders the words.
 */
export function useUse24h(): boolean {
  const setting = useSettingsStore((s) => s.settings?.time_format_24h);
  const legacy = useSettingsStore((s) => s.settings?.calendar_time_format_24h);
  const os = useOsClockStore((s) => s.use24h);
  const lang = useI18nStore((s) => s.lang);
  return resolveUse24h(setting, legacy, os, lang);
}

/**
 * The same answer for a caller with no hooks — a store action, a notification
 * built outside React (`stores/calendar/alarms`). A read, not a subscription: those
 * callers format one string and are done, so there is nothing to re-render.
 *
 * Deliberately **not** named `use…`: React's rules-of-hooks lint goes by the
 * name, so a `useX()` called from a plain function is an error however correct
 * it is — and the name would be claiming something untrue anyway.
 */
export function readUse24h(): boolean {
  const settings = useSettingsStore.getState().settings;
  return resolveUse24h(
    settings?.time_format_24h,
    settings?.calendar_time_format_24h,
    useOsClockStore.getState().use24h,
    useI18nStore.getState().lang,
  );
}

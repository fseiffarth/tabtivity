/**
 * The AI switch (`docs/ai_switch_plan.md`): the side panel's ⏻ sets
 * `Settings.ai_off`, which stops every new AI use machine-wide. The backend
 * enforces it (`services::ai_switch`: agent spawns, input to agents,
 * completions, mail AI, the phone); the window reads the same setting to
 * stand its own timers down and to say why an agent tab is not listening.
 * Agents already running keep running. Switched off for a while
 * (`ai_off_until`), it is on again once that instant passes, with nothing
 * written: every reader compares against the clock.
 */
import { useEffect, useReducer } from "react";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

/** The refusal every backend gate returns (`ai_switch::AI_OFF`). */
export const AI_OFF = "ai_off";

/** The longest wait `setTimeout` keeps (about 24.8 days); a longer one fires at once. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** Whether `settings` say AI is off at `now` (`ai_switch::off_now`). */
export function aiOffIn(settings: Settings | null | undefined, now = Date.now()): boolean {
  if (settings?.ai_off !== true) return false;
  const until = settings.ai_off_until;
  return until == null || now < until;
}

/** Whether AI is off right now (outside React). */
export function aiIsOff(): boolean {
  return aiOffIn(useSettingsStore.getState().settings);
}

/** When a timed switch turns AI on again (Unix ms), or `null` when AI is on
 *  or off until switched back on. */
export function aiOffUntil(settings: Settings | null | undefined): number | null {
  return aiOffIn(settings) ? (settings?.ai_off_until ?? null) : null;
}

/** Whether AI is off, as a React subscription — re-rendered when a timed
 *  switch runs out. */
export function useAiOff(): boolean {
  const off = useSettingsStore((s) => s.settings?.ai_off === true);
  const until = useSettingsStore((s) => s.settings?.ai_off_until ?? null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!off || until == null || Date.now() >= until) return;
    const id = window.setTimeout(bump, Math.min(until - Date.now() + 50, MAX_TIMEOUT));
    return () => window.clearTimeout(id);
  }, [off, until, tick]);
  return off && (until == null || Date.now() < until);
}

/** Switch AI off (`true`) or back on. `hours` turns it on again by itself
 *  after that long; without it, off lasts until switched back on. */
export function setAiOff(off: boolean, hours?: number): Promise<void> {
  const until = off && hours != null ? Date.now() + Math.round(hours * 3_600_000) : null;
  return useSettingsStore.getState().updateSettings({ ai_off: off, ai_off_until: until });
}

/** Whether a backend error is the AI switch's refusal. */
export function isAiOffRefusal(error: unknown): boolean {
  return String(error).trim() === AI_OFF;
}

/** Resolves `true` once AI is on, or `false` when `signal` aborts first. */
export function whenAiOn(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (!aiIsOff()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = 0;
    const done = (on: boolean) => {
      unsubscribe();
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(on);
    };
    const onAbort = () => done(false);
    // A timed switch runs out without a settings write, so the clock is the
    // other way back on.
    const check = () => {
      if (!aiIsOff()) return done(true);
      window.clearTimeout(timer);
      const until = aiOffUntil(useSettingsStore.getState().settings);
      if (until != null) timer = window.setTimeout(check, Math.min(until - Date.now() + 50, MAX_TIMEOUT));
    };
    const unsubscribe = useSettingsStore.subscribe(check);
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

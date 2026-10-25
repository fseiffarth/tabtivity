/**
 * The AI switch (`docs/ai_switch_plan.md`): the side panel's ⏻ sets
 * `Settings.ai_off`, which stops every new AI use machine-wide. The backend
 * enforces it (`services::ai_switch`: agent spawns, input to agents,
 * completions, mail AI, the phone); the window reads the same setting to
 * stand its own timers down and to say why an agent tab is not listening.
 * Agents already running keep running.
 */
import { useSettingsStore } from "../stores/settings";

/** The refusal every backend gate returns (`ai_switch::AI_OFF`). */
export const AI_OFF = "ai_off";

/** Whether AI is off right now (outside React). */
export function aiIsOff(): boolean {
  return useSettingsStore.getState().settings?.ai_off === true;
}

/** Whether AI is off, as a React subscription. */
export function useAiOff(): boolean {
  return useSettingsStore((s) => s.settings?.ai_off === true);
}

/** Switch AI off (`true`) or back on. */
export function setAiOff(off: boolean): Promise<void> {
  return useSettingsStore.getState().updateSettings({ ai_off: off });
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
    const done = (on: boolean) => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(on);
    };
    const onAbort = () => done(false);
    const unsubscribe = useSettingsStore.subscribe((s) => {
      if (s.settings?.ai_off !== true) done(true);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

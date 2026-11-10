import { invoke } from "@tauri-apps/api/core";
import { steeringTabs } from "../shortcuts/steeringScope";
import { useTabsStore } from "../../stores/tabs";

/** The popout each scope's J raised last, so the next J takes the one after. */
const lastRaised = new Map<string, string>();

/** The popout label to raise after `last` in `labels` (wrapping); the first
 *  when `last` is unset or gone. Pure. */
export function nextPopoutLabel(labels: readonly string[], last: string | undefined): string | null {
  if (labels.length === 0) return null;
  const i = last ? labels.indexOf(last) : -1;
  return labels[(i + 1) % labels.length];
}

/**
 * Steering's J: raise the active scope's next popped-out subwindow and give it
 * the keyboard (`focus_detached_window`). The caller ends the initiating
 * steering visit after success. False when the scope has no popout or the raise
 * failed (a backend that predates the command included).
 */
export async function focusNextPopout(scope = steeringTabs().scope): Promise<boolean> {
  const { detachedGroupsByScope } = useTabsStore.getState();
  const label = nextPopoutLabel(
    (detachedGroupsByScope[scope] ?? []).map((g) => g.label),
    lastRaised.get(scope),
  );
  if (!label) return false;
  try {
    const focused = await invoke<boolean>("focus_detached_window", { label });
    if (focused) lastRaised.set(scope, label);
    return focused;
  } catch {
    return false;
  }
}

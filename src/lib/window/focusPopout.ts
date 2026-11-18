import { invoke } from "@tauri-apps/api/core";
import { steeringTabs } from "../shortcuts/steeringScope";
import { useTabsStore } from "../../stores/tabs";

/** The popout each scope's J raised last, so the next J takes the one after.
 *  Set by both paths — the main window's J and a popout's J the main window
 *  answers — so the main window's J carries on from where a popout's left. */
const lastRaised = new Map<string, string>();

/** The popout label to raise after `last` in `labels` (wrapping); the first
 *  when `last` is unset or gone. Pure. */
export function nextPopoutLabel(labels: readonly string[], last: string | undefined): string | null {
  if (labels.length === 0) return null;
  const i = last ? labels.indexOf(last) : -1;
  return labels[(i + 1) % labels.length];
}

/** The scope's popout labels, in the order J walks them. */
function popoutLabels(scope: string): string[] {
  return (useTabsStore.getState().detachedGroupsByScope[scope] ?? []).map((g) => g.label);
}

/**
 * A popout's J, as the main window answers it: the scope's popout after
 * `label`, wrapping to the first after the last one. Null when there is no
 * other popout (the only one, or a label the scope no longer lists): J then
 * does nothing. It never goes to the main window; that is its own key.
 */
export function popoutAfter(scope: string, label: string): string | null {
  const labels = popoutLabels(scope);
  const i = labels.indexOf(label);
  return i >= 0 && labels.length > 1 ? labels[(i + 1) % labels.length] : null;
}

/** Raise one popout and give it the keyboard (`focus_detached_window`). False
 *  when the raise failed (a backend that predates the command included). */
export async function raisePopout(scope: string, label: string): Promise<boolean> {
  try {
    const focused = await invoke<boolean>("focus_detached_window", { label });
    if (focused) lastRaised.set(scope, label);
    return focused;
  } catch {
    return false;
  }
}

/**
 * Steering's J in the main window: raise the active scope's next popped-out
 * subwindow and give it the keyboard. The raised popout's label, which the
 * caller then asks to take steering; null when the scope has no popout or the
 * raise failed.
 */
export async function focusNextPopout(scope = steeringTabs().scope): Promise<string | null> {
  const label = nextPopoutLabel(popoutLabels(scope), lastRaised.get(scope));
  if (!label) return null;
  return (await raisePopout(scope, label)) ? label : null;
}

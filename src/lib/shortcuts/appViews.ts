/**
 * The apps — mail ✉, calendar 🗓 and the to-do board ☑ — as the keyboard sees
 * them: views of the one console window (`rootOverlay.view`), not overlays of
 * their own, so "which app is in front" is just the shown view.
 *
 * `useKeyboard` routes Ctrl+1–9 into the shown app (it docks that slot's root
 * agent beside the app, `OVERLAY_AGENT_EVENT`) instead of opening a tab in the
 * workspace pane hidden under the window, and steering's M / C / T show and
 * leave them.
 */
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { steeringAppEnabled, type SteeringApp } from "./steeringRegion";

const APPS: readonly SteeringApp[] = ["mail", "calendar", "todo"];

/** Is `view` one of the three apps? */
function isApp(view: string): view is SteeringApp {
  return (APPS as readonly string[]).includes(view);
}

/**
 * The app the window is showing, or null when it is closed or on any other
 * view. One counts only while its settings gate is on (`steeringAppEnabled`: the
 * `mail_client` flag, `calendar_global_app`, `todo_board`) — the window falls
 * back to Now otherwise, so this is the same answer a frame later.
 */
export function shownApp(): SteeringApp | null {
  const { open, view } = useRootOverlayStore.getState();
  if (!open || !isApp(view)) return null;
  return steeringAppEnabled(view, useSettingsStore.getState().settings) ? view : null;
}

/** Show `app`'s view (its gate decides whether it opens). */
export function openApp(app: SteeringApp): void {
  useRootOverlayStore.getState().openView(app);
}

/** Close the window if it is showing `app`. */
export function closeApp(app: SteeringApp): void {
  const { open, view } = useRootOverlayStore.getState();
  if (open && view === app) useRootOverlayStore.getState().close();
}

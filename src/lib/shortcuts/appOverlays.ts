/**
 * The header apps' overlays — mail ✉, calendar 🗓 and the to-do board ☑ — as
 * the keyboard sees them: each one's store, and which of them is in front.
 *
 * `useKeyboard` routes Ctrl+1–9 into the front overlay (it docks that slot's
 * root agent beside the app, `OVERLAY_AGENT_EVENT`) instead of opening a tab
 * in the workspace pane hidden under it.
 */
import { useMailStore } from "../../stores/mail";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useTodoStore } from "../../stores/todo";
import { useSettingsStore } from "../../stores/settings";
import { steeringAppEnabled, type SteeringApp } from "./steeringRegion";

/** The overlay store behind a header app — the same `openOverlay` /
 *  `closeOverlay` its header button calls. */
export function appOverlayStore(app: SteeringApp): {
  overlayOpen: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
} {
  switch (app) {
    case "mail":
      return useMailStore.getState();
    case "calendar":
      return useCalendarStore.getState();
    case "todo":
      return useTodoStore.getState();
  }
}

/** Topmost first: `AppShell` mounts mail, then calendar, then the board — all
 *  `.modal-backdrop` at one z-index, so the later one paints on top. */
const STACK: readonly SteeringApp[] = ["todo", "calendar", "mail"];

/** Each overlay's frame (`<App>Overlay.tsx`). */
const FRAME: Record<SteeringApp, string> = {
  todo: ".todo-overlay",
  calendar: ".calendar-overlay",
  mail: ".mail-overlay",
};

/**
 * The app overlay in front, or null when none is up. One counts only while its
 * store has it open AND its settings gate is on (`steeringAppEnabled`: the
 * `mail_client` flag, `calendar_global_app`, `todo_board`) — the overlay
 * renders nothing otherwise, and mail stays mounted while hidden. The one
 * holding the keyboard focus wins; else the topmost by mount order.
 */
export function frontAppOverlay(): SteeringApp | null {
  const settings = useSettingsStore.getState().settings;
  const open = STACK.filter(
    (app) => appOverlayStore(app).overlayOpen && steeringAppEnabled(app, settings),
  );
  if (open.length === 0) return null;
  const active = document.activeElement;
  if (active) {
    const focused = open.find((app) =>
      Array.from(document.querySelectorAll(FRAME[app])).some((frame) => frame.contains(active)),
    );
    if (focused) return focused;
  }
  return open[0];
}

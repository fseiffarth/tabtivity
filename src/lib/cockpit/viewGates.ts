import { experimentalEnabled } from "../experimental";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import type { WindowView } from "./views";

/**
 * Is `view` offered? Four views sit behind a feature gate that also hides their
 * header icon: Mail (the experimental `mail_client`), Calendar
 * (`calendar_global_app`), To-do (`todo_board`) and Machines
 * (`machines_enabled`). The others are always there. A gated view that is
 * shown when its gate goes off falls back to Now (`RootOverlay`).
 */
export function viewEnabled(view: WindowView, settings: Settings | null | undefined): boolean {
  switch (view) {
    case "mail":
      return experimentalEnabled(settings, "mail_client");
    case "calendar":
      return settings?.calendar_global_app ?? true;
    case "todo":
      return settings?.todo_board ?? true;
    case "machines":
      return settings?.machines_enabled ?? true;
    default:
      return true;
  }
}

export function useViewEnabled(view: WindowView): boolean {
  return useSettingsStore((s) => viewEnabled(view, s.settings));
}

import type { ConsoleView } from "../../lib/cockpit/views";
import { CockpitNow } from "./CockpitNow";
import { CockpitProjects } from "./CockpitProjects";
import { CockpitTonight } from "./CockpitTonight";

/** The shown view's body — only the shown one mounts, so a hidden view
 *  computes and loads nothing. */
export function CockpitViewBody({ view }: { view: ConsoleView }) {
  switch (view) {
    case "now":
      return <CockpitNow />;
    case "projects":
      return <CockpitProjects />;
    case "tonight":
      return <CockpitTonight />;
    default:
      return null;
  }
}

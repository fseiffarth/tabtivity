import type { CockpitView } from "../../stores/cockpit";
import { CockpitNow } from "./CockpitNow";
import { CockpitProjects } from "./CockpitProjects";
import { CockpitTonight } from "./CockpitTonight";
import { CockpitUsage } from "./CockpitUsage";

/** The shown view's body — only the shown one mounts, so a hidden view
 *  computes and loads nothing. */
export function CockpitViewBody({ view }: { view: CockpitView }) {
  if (view === "now") return <CockpitNow />;
  if (view === "projects") return <CockpitProjects />;
  if (view === "tonight") return <CockpitTonight />;
  return <CockpitUsage />;
}

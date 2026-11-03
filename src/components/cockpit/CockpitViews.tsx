import type { CockpitView } from "../../stores/cockpit";
import { useT } from "../../lib/i18n";
import { CockpitViewHeading } from "./CockpitViewHeading";
import { CockpitNow } from "./CockpitNow";
import { CockpitProjects } from "./CockpitProjects";

/** The shown view's body — only the shown one mounts, so a hidden view
 *  computes and loads nothing. */
export function CockpitViewBody({ view }: { view: CockpitView }) {
  const t = useT();
  if (view === "now") return <CockpitNow />;
  if (view === "projects") return <CockpitProjects />;
  return (
    <div className={`cockpit-view cockpit-view-${view}`}>
      <CockpitViewHeading view={view} />
      <p className="cockpit-empty">{t("cockpit.comingSoon")}</p>
    </div>
  );
}

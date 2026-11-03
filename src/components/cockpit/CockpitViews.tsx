import type { ReactNode } from "react";
import type { CockpitView } from "../../stores/cockpit";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** Each view's heading — its i18n key and its untested-register id alike. */
const HEADING = {
  now: "cockpit.now.heading",
  projects: "cockpit.projects.heading",
  tonight: "cockpit.tonight.heading",
  usage: "cockpit.usage.heading",
} as const satisfies Record<CockpitView, TranslationKey>;

/** A view's heading row, with its untested pill. */
export function CockpitViewHeading({ view, children }: { view: CockpitView; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="cockpit-view-heading">
      <h2>{t(HEADING[view])}</h2>
      {/* Literal ids: the register's audit reads the pills off the source. */}
      {view === "now" && <UntestedTag id="cockpit.now.heading" />}
      {view === "projects" && <UntestedTag id="cockpit.projects.heading" />}
      {view === "tonight" && <UntestedTag id="cockpit.tonight.heading" />}
      {view === "usage" && <UntestedTag id="cockpit.usage.heading" />}
      {children}
    </div>
  );
}

/** The shown view's body — only the shown one mounts, so a hidden view
 *  computes and loads nothing. */
export function CockpitViewBody({ view }: { view: CockpitView }) {
  const t = useT();
  return (
    <div className={`cockpit-view cockpit-view-${view}`}>
      <CockpitViewHeading view={view} />
      <p className="cockpit-empty">{t("cockpit.comingSoon")}</p>
    </div>
  );
}

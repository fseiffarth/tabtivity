import { useEffect, type ReactNode } from "react";

import { useT } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { MachineMeters } from "../models/ModelsHubSections";
import { useMachineMeters } from "../models/useModelsHub";
import { UntestedTag } from "../common/UntestedTag";

/** This machine: the models hub's own CPU / RAM / GPU meters — the hub's
 *  component, not a copy — side by side in one band. Polled while the view is
 *  mounted, i.e. shown. */
function ThisMachine() {
  const t = useT();
  const meters = useMachineMeters(true);
  const showing = meters.machine?.supported === true || meters.gpus.length > 0;
  if (!showing) return null;
  return (
    <section className="machines-meters" aria-label={t("machinesView.thisMachine")}>
      <span className="machines-meters-label">{t("machinesView.thisMachine")}</span>
      <MachineMeters hub={meters} layout="strip" />
    </section>
  );
}

/**
 * The **Machines** view's layout: a toolbar (the lead, Add machine, and a ⋯ for
 * import / export and the all-machine actions), this machine's meters as one
 * band, the open add / import / export form if any, then the one machine list
 * (`header/MachinesTable`: project hosts and global machines merged, sorted by
 * state then name).
 *
 * It owns no machine state. `header/MachinesIndicator` (`surface="view"`)
 * renders the toolbar's actions and the list, so the dropdown and the view are
 * one implementation — the probes, the connect/check/HPC rules, the forms — and
 * can never disagree.
 *
 * The dialogs a gesture here raises (host-key prompt, HPC guard, machine
 * monitor, connect) are mounted at the shell AFTER the window, so they land on
 * top of it (`layout/AppShell`).
 */
export function MachinesViewFrame({ actions, children }: { actions: ReactNode; children: ReactNode }) {
  const t = useT();
  const machinesLoaded = useGlobalMachinesStore((s) => s.loaded);
  // The list itself is a local file; the project hosts' lamps are whatever the
  // stores hold.
  useEffect(() => {
    if (!machinesLoaded) void useGlobalMachinesStore.getState().load();
  }, [machinesLoaded]);
  return (
    <div className="app-view app-view-machines models-overlay-body machines-overlay-body">
      <div className="models-home machines-home">
        <div className="models-home-inner machines-home-inner">
          <div className="machines-view-toolbar">
            <p className="models-home-lead">
              {t("machinesView.lead")}
              <UntestedTag id="machines.overlayTitle" />
            </p>
            <div className="machines-view-actions">{actions}</div>
          </div>
          <ThisMachine />
          {children}
        </div>
      </div>
    </div>
  );
}

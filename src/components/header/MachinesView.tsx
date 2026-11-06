import { useEffect, type ReactNode } from "react";

import { useT } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { MachineMeters } from "../models/ModelsHubSections";
import { useMachineMeters } from "../models/useModelsHub";
import { UntestedTag } from "../common/UntestedTag";
import { CockpitMachineList } from "../cockpit/CockpitMachineList";

/** This machine: the models hub's own CPU / RAM / GPU meters — the hub's
 *  component, not a copy. Polled while the view is mounted, i.e. shown. */
function ThisMachine() {
  const t = useT();
  const meters = useMachineMeters(true);
  return (
    <section className="machines-view-section" aria-label={t("machinesView.thisMachine")}>
      <div className="tab-new-menu-group-label">{t("machinesView.thisMachine")}</div>
      <MachineMeters hub={meters} layout="overlay" />
    </section>
  );
}

/**
 * The **Machines** view's layout — what the Machines overlay's frame was, with
 * the cockpit's former Usage view's machine parts above the tiles: this machine's
 * meters, the machine list (`cockpit/CockpitMachineList`: project hosts and
 * global machines merged by host name, with Connect), then the global machines'
 * tiles, where they are managed.
 *
 * It owns no machine state. `header/MachinesIndicator` renders its own list into
 * `children` (`surface="view"`: every row a `.models-tile`, the rows one grid),
 * so the dropdown and the view are one implementation — the probes, the
 * connect/check/HPC rules, the forms — and can never disagree.
 *
 * The dialogs a gesture here raises (host-key prompt, HPC guard, machine
 * monitor, connect) are mounted at the shell AFTER the window, so they land on
 * top of it (`layout/AppShell`).
 */
export function MachinesViewFrame({ children }: { children: ReactNode }) {
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
          <p className="models-home-lead">
            {t("machines.overlayLead")}
            <UntestedTag id="machines.overlayTitle" />
          </p>
          <ThisMachine />
          <CockpitMachineList />
          {children}
        </div>
      </div>
    </div>
  );
}

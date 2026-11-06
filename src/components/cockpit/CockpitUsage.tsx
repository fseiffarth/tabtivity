import { useT } from "../../lib/i18n";
import { CliOverviewBody } from "../agents/CliOverviewView";
import { MachineMeters, RunningModelCard } from "../models/ModelsHubSections";
import { useMachineMeters, useModelsHub } from "../models/useModelsHub";
import { CockpitMachineList } from "./CockpitMachineList";
import { CockpitUntested } from "./CockpitUntested";

/** This machine: the models hub's own CPU / RAM / GPU meters and its resident
 *  Ollama models with their Unload — the hub's components, not copies. */
function ThisMachine() {
  const t = useT();
  const meters = useMachineMeters(true);
  const hub = useModelsHub(true);
  const running = hub.models.filter((m) => m.running);
  return (
    <section className="cockpit-usage-section" aria-label={t("cockpit.usage.machine")}>
      <div className="cockpit-section-head">
        <span className="tab-new-menu-group-label">{t("cockpit.usage.machine")}</span>
        <CockpitUntested view="usage" />
      </div>
      <MachineMeters hub={meters} layout="overlay" />
      {running.length > 0 && (
        <div className="cockpit-usage-models">
          {running.map((m) => <RunningModelCard key={m.name} m={m} hub={hub} t={t} />)}
        </div>
      )}
    </section>
  );
}

/**
 * The Usage view (`docs/desktop_cockpit_plan.md`, View 4): a top strip with the
 * side panel's CLIs body (same cadence: read while shown, every 5 min, ⟳)
 * beside this machine's meters and resident models, and below it, full width,
 * the machine list (`CockpitMachineList`: one row per machine, project hosts and
 * global machines merged). Each part is the surface it came from, rendered here
 * as a second host — not a copy.
 */
export function CockpitUsage() {
  const t = useT();
  return (
    <div className="cockpit-view cockpit-view-usage" role="region" aria-label={t("cockpit.usage.heading")}>
      <div className="cockpit-usage">
        <div className="cockpit-usage-top">
          <div className="cockpit-usage-col">
            <CliOverviewBody active />
          </div>
          <div className="cockpit-usage-col">
            <ThisMachine />
          </div>
        </div>
        <CockpitMachineList />
      </div>
    </div>
  );
}

import { useEffect, useMemo } from "react";

import { useT, type TranslationKey } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { CliOverviewBody } from "../agents/CliOverviewView";
import { MachineMeters, RunningModelCard } from "../models/ModelsHubSections";
import { useMachineMeters, useModelsHub } from "../models/useModelsHub";
import { CockpitUntested } from "./CockpitUntested";

const LAMP_LABEL: Record<ConnState, TranslationKey> = {
  off: "cockpit.lamp.off",
  connecting: "cockpit.lamp.connecting",
  connected: "cockpit.lamp.connected",
  error: "cockpit.lamp.error",
};

/** This machine: the models hub's own CPU / RAM / GPU meters and its resident
 *  Ollama models with their Unload — the hub's components, not copies. */
function ThisMachine() {
  const t = useT();
  const meters = useMachineMeters(true);
  const hub = useModelsHub(true);
  const running = hub.models.filter((m) => m.running);
  return (
    <section className="cockpit-usage-section" aria-label={t("cockpit.usage.machine")}>
      <div className="tab-new-menu-group-label">{t("cockpit.usage.machine")}</div>
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
 * Remote: every project host and worker, and the global machines, with the
 * lamps the stores already hold — no probe runs from here. Live tmux sessions
 * are the count the sessions store last read (it polls only for a surface that
 * retains it). Connect goes through the existing hubs.
 */
function Remote() {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHost = useRemoteStatusStore((s) => s.byHost);
  const sessions = useHostSessionsStore((s) => s.byProject);
  const machines = useGlobalMachinesStore((s) => s.machines);
  const machineStatus = useGlobalMachinesStore((s) => s.status);
  const machinesLoaded = useGlobalMachinesStore((s) => s.loaded);

  // The list itself is a local file; its lamps are whatever the store holds.
  useEffect(() => {
    if (!machinesLoaded) void useGlobalMachinesStore.getState().load();
  }, [machinesLoaded]);

  const rows = useMemo(
    () =>
      projects
        .filter((p) => p.remote)
        .flatMap((project) => [
          { project, hostId: PRIMARY_HOST, label: project.remote?.host ?? project.name },
          ...(project.compute_hosts ?? []).map((h) => ({ project, hostId: h.id, label: h.label || h.host || h.id })),
        ]),
    [projects],
  );

  return (
    <section className="cockpit-usage-section" aria-label={t("cockpit.usage.remote")}>
      <div className="tab-new-menu-group-label">{t("cockpit.usage.remote")}</div>
      {rows.length === 0 && machines.length === 0 && <p className="cockpit-empty">{t("cockpit.usage.noRemote")}</p>}
      {rows.map(({ project, hostId, label }) => {
        const state = hostStateOf({ byProject, byHost }, project.id, hostId);
        const live = (sessions[project.id] ?? []).filter((row) => row.hostId === hostId).length;
        return (
          <div key={`${project.id}/${hostId}`} className="cockpit-tonight-row">
            <span className={`cockpit-chip lamp-${state.ssh}`}>{t(LAMP_LABEL[state.ssh])}</span>
            <span className="cockpit-rail-scope">{project.name}</span>
            <span className="cockpit-rail-text">{label}</span>
            {hostId === PRIMARY_HOST && project.run_host && (
              <span className="cockpit-meta">{t("cockpit.projects.runHost", { host: project.run_host })}</span>
            )}
            {live > 0 && <span className="cockpit-meta">{t("cockpit.usage.sessions", { count: live })}</span>}
            <span className="cockpit-tonight-actions">
              {state.ssh !== "connected" && (
                <button type="button" className="settings-btn sm" onClick={() => useRemoteMachinesStore.getState().open(project.id)}>
                  {t("cockpit.detail.connect")}
                </button>
              )}
            </span>
          </div>
        );
      })}
      {machines.length > 0 && (
        <>
          <div className="tab-new-menu-group-label">{t("machines.overlayTitle")}</div>
          {machines.map((m) => {
            const ssh = machineStatus[m.id] ?? "off";
            return (
              <div key={m.id} className="cockpit-tonight-row">
                <span className={`cockpit-chip lamp-${ssh}`}>{t(LAMP_LABEL[ssh])}</span>
                <span className="cockpit-rail-text">{m.label || m.host}</span>
              </div>
            );
          })}
          <button type="button" className="settings-btn sm" onClick={() => useMachinesOverlayStore.getState().openOverlay()}>
            {t("cockpit.usage.openMachines")}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * The Usage view (`docs/desktop_cockpit_plan.md`, View 4): the side panel's
 * CLIs body (same cadence: read while shown, every 5 min, ⟳), this machine's
 * meters and resident models, and the remote hosts. Each part is the surface
 * it came from, rendered here as a second host — not a copy.
 */
export function CockpitUsage() {
  return (
    <div className="cockpit-view cockpit-view-usage">
      <CockpitUntested view="usage" />
      <div className="cockpit-usage">
        <div className="cockpit-usage-col">
          <CliOverviewBody active />
        </div>
        <div className="cockpit-usage-col">
          <ThisMachine />
          <Remote />
        </div>
      </div>
    </div>
  );
}

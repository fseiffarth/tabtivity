import { useEffect, useMemo, type ReactNode } from "react";

import { useT, type TranslationKey } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { MachineMeters } from "../models/ModelsHubSections";
import { useMachineMeters } from "../models/useModelsHub";
import { UntestedTag } from "../common/UntestedTag";

const LAMP_LABEL: Record<ConnState, TranslationKey> = {
  off: "cockpit.lamp.off",
  connecting: "cockpit.lamp.connecting",
  connected: "cockpit.lamp.connected",
  error: "cockpit.lamp.error",
};

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
 * Remote: every project host and worker, with the lamps the stores already hold
 * — no probe runs from here. Live tmux sessions are the count the sessions
 * store last read (it polls only for a surface that retains it). Connect goes
 * through the existing hub. Shown only when some project is remote; the global
 * machines are the tiles below it.
 */
function ProjectHosts() {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHost = useRemoteStatusStore((s) => s.byHost);
  const sessions = useHostSessionsStore((s) => s.byProject);

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
  if (rows.length === 0) return null;

  return (
    <section className="machines-view-section" aria-label={t("machinesView.projectHosts")}>
      <div className="tab-new-menu-group-label">{t("machinesView.projectHosts")}</div>
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
            {live > 0 && <span className="cockpit-meta">{t("machinesView.sessions", { count: live })}</span>}
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
    </section>
  );
}

/**
 * The **Machines** view's layout — what the Machines overlay's frame was, with
 * the cockpit's Usage view's machine parts above the tiles: this machine's
 * meters, the project hosts with their lamps, then the global machines.
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
          <ProjectHosts />
          {children}
        </div>
      </div>
    </div>
  );
}

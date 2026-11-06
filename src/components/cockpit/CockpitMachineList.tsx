import { useEffect, useMemo, useState } from "react";

import {
  buildMachineRows,
  type GlobalMachineInput,
  type MachineProjectHost,
  type MachineRow,
} from "../../lib/cockpit/machines";
import { runHostLabel } from "../../lib/cockpit/projectCards";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { DotIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { EntryMenu } from "./EntryMenu";

const LAMP_LABEL: Record<ConnState, TranslationKey> = {
  off: "cockpit.lamp.off",
  connecting: "cockpit.lamp.connecting",
  connected: "cockpit.lamp.connected",
  error: "cockpit.lamp.error",
};

/** One Connect for a machine's not-connected projects: with one it opens that
 *  project's connection hub directly, with several a menu names them. */
function ConnectButton({ row }: { row: MachineRow }) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = (projectId: string) => useRemoteMachinesStore.getState().open(projectId);
  if (row.disconnected.length === 0) return null;
  const only = row.disconnected.length === 1 ? row.disconnected[0] : null;
  return (
    <>
      <button
        type="button"
        className="settings-btn sm"
        aria-haspopup={only ? undefined : "menu"}
        aria-expanded={only ? undefined : menu != null}
        onClick={(e) => {
          if (only) return open(only.projectId);
          if (menu) return setMenu(null);
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        {t("cockpit.detail.connect")}
      </button>
      {menu && (
        <EntryMenu
          x={menu.x}
          y={menu.y}
          entries={row.disconnected.map((p) => ({ key: p.projectId, label: p.name, run: () => open(p.projectId) }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function Machine({ row }: { row: MachineRow }) {
  const t = useT();
  return (
    <div role="listitem" aria-label={row.name} className="cockpit-mrow">
      <span className={`cockpit-lamp lamp-${row.lamp}`} aria-hidden>
        <DotIcon />
      </span>
      <span className="cockpit-mrow-name" title={row.name}>{row.name}</span>
      <span className="cockpit-meta">
        {t(LAMP_LABEL[row.lamp])}
        {row.sessions > 0 && ` · ${t("cockpit.usage.sessions", { count: row.sessions })}`}
      </span>
      <span className="cockpit-mrow-projects">
        {row.projects.map((p) => (
          <span key={p.projectId} className="cockpit-chip cockpit-mchip" title={`${p.name}: ${t(LAMP_LABEL[p.ssh])}`}>
            <span className={`cockpit-lamp lamp-${p.ssh}`} aria-hidden>
              <DotIcon />
            </span>
            {p.name}
            {p.runHost && <span className="dim"> · {t("cockpit.projects.runHost", { host: p.runHost })}</span>}
          </span>
        ))}
      </span>
      <span className="cockpit-mrow-connect">
        <ConnectButton row={row} />
      </span>
    </div>
  );
}

/**
 * The Machines view's machine list (`header/MachinesView`, above the global
 * machines' tiles): one row per machine. Every project host (primary and
 * compute hosts) and the global machines merge by host name
 * (`lib/cockpit/machines`); the lamps are the stores' own readings, nothing is
 * probed from here. Built for the cockpit's Usage view, which dissolved into the
 * Agents / Models / Machines views (`docs/cockpit_apps_merge_plan.md`).
 */
export function CockpitMachineList() {
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

  const rows = useMemo(() => {
    const hosts = projects
      .filter((p) => p.remote)
      .flatMap((project): MachineProjectHost[] => {
        const one = (hostId: string, host: string, label: string): MachineProjectHost => ({
          projectId: project.id,
          projectName: project.name,
          hostId,
          host,
          label,
          ssh: hostStateOf({ byProject, byHost }, project.id, hostId).ssh,
          sessions: (sessions[project.id] ?? []).filter((row) => row.hostId === hostId).length,
          runHost: hostId === PRIMARY_HOST ? runHostLabel(project, project.run_host, t) : undefined,
        });
        const primary = project.remote?.host ?? project.name;
        return [
          one(PRIMARY_HOST, primary, primary),
          ...(project.compute_hosts ?? []).map((h) => one(h.id, h.host || h.label || h.id, h.label || h.host || h.id)),
        ];
      });
    const globals: GlobalMachineInput[] = machines.map((m) => ({ id: m.id, host: m.host, label: m.label, ssh: machineStatus[m.id] ?? "off" }));
    return buildMachineRows(hosts, globals);
  }, [projects, byProject, byHost, sessions, machines, machineStatus, t]);

  return (
    <section className="machines-view-section cockpit-machines" aria-label={t("cockpit.usage.machines")}>
      <div className="cockpit-section-head">
        <span className="tab-new-menu-group-label">{t("cockpit.usage.machines")}</span>
        {/* Literal id: the register's audit reads the pills off the source. */}
        <UntestedTag id="cockpit.usage.machines" />
      </div>
      {rows.length === 0 && <p className="cockpit-empty">{t("cockpit.usage.noRemote")}</p>}
      <div role="list">
        {rows.map((row) => <Machine key={row.key} row={row} />)}
      </div>
    </section>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  buildMachineRows,
  isIdleMachine,
  machineMatches,
  MACHINE_GROUPS,
  sortByStateThenName,
  type GlobalMachineInput,
  type MachineGroup,
  type MachineProject,
  type MachineProjectHost,
  type MachineRow,
} from "../../lib/cockpit/machines";
import { runHostLabel } from "../../lib/cockpit/projectCards";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { MoreIcon, SearchIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { EntryMenu, type MenuEntry } from "../cockpit/EntryMenu";

/** The lamp a row paints: a session's colours, plus blue for "answers, no
 *  session" — never green, which only a session may be. Off is a hollow ring. */
export type MachineLampTone = "connected" | "connecting" | "error" | "up" | "off";

/** One machine of the Machines view, ready to draw: the caller
 *  (`header/MachinesIndicator`, `surface="view"`) owns every action and form. */
export interface MachineTableRow {
  key: string;
  name: string;
  /** Where it is (`user@host:port`), when the view knows. */
  target?: string;
  group: MachineGroup;
  /** The state in a word, and the sentence behind it (the word's tooltip). */
  stateWord: string;
  stateTip: string;
  lamp: MachineLampTone;
  hpc: boolean;
  projects: MachineProject[];
  activity: ReactNode;
  /** The row's one main action (Connect, Retry…, Disconnect). */
  primary: ReactNode;
  onMonitor?: () => void;
  /** The ⋯ menu; empty → no ⋯. */
  menu: MenuEntry[];
  error?: string;
  /** An open form (edit, retry, confirm), drawn under the row. */
  detail?: ReactNode;
}

const GROUP_LABEL: Record<MachineGroup, TranslationKey> = {
  connected: "machinesView.group.connected",
  connecting: "machinesView.group.connecting",
  failed: "machinesView.group.failed",
  up: "machinesView.group.up",
  off: "machinesView.group.off",
};

/** Project chips shown before "+N". */
const CHIP_LIMIT = 3;

type Filter = MachineGroup | "all" | "idle";

function ProjectChips({ projects }: { projects: MachineProject[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? projects : projects.slice(0, CHIP_LIMIT);
  const rest = projects.slice(CHIP_LIMIT);
  return (
    <div className={`machines-table-chips${all ? " is-open" : ""}`}>
      {shown.map((p) => (
        <span
          key={p.projectId}
          className={`machines-chip is-${p.ssh}`}
          title={p.runHost ? `${p.name} — ${t("cockpit.projects.runHost", { host: p.runHost })}` : p.name}
        >
          <span className="machines-chip-name">{p.name}</span>
          {p.runHost && <span className="machines-chip-runs">→ {p.runHost}</span>}
        </span>
      ))}
      {!all && rest.length > 0 && (
        <button
          type="button"
          className="machines-chip-more"
          title={t("machinesView.moreProjectsTitle", { names: rest.map((p) => p.name).join(", ") })}
          onClick={() => setAll(true)}
        >
          {t("machinesView.moreProjects", { count: rest.length })}
        </button>
      )}
    </div>
  );
}

function Row({ row, onMenu }: { row: MachineTableRow; onMenu: (row: MachineTableRow, el: HTMLElement) => void }) {
  const t = useT();
  return (
    <div role="listitem" aria-label={row.name} className={`machines-table-item group-${row.group}`}>
      <div className="machines-table-row">
        <span className={`machines-state is-${row.lamp}`} title={row.stateTip}>
          <span className="machines-lamp" aria-hidden />
          <span className="machines-state-word">{row.stateWord}</span>
        </span>
        <span className="machines-table-machine">
          <span className="machines-table-name-line">
            {row.onMonitor ? (
              <button type="button" className="machines-table-name" title={row.target} onClick={row.onMonitor}>
                {row.name}
              </button>
            ) : (
              <span className="machines-table-name" title={row.target}>
                {row.name}
              </span>
            )}
            {row.hpc && <span className="hpc-badge">HPC</span>}
          </span>
          {row.target && row.target !== row.name && <span className="machines-table-target">{row.target}</span>}
        </span>
        <ProjectChips projects={row.projects} />
        <span className="machines-table-activity">{row.activity}</span>
        <span className="machines-table-actions">
          {row.primary}
          {row.onMonitor && (
            <button
              type="button"
              className="machines-icon-btn"
              aria-label={t("machinesView.monitorAria", { name: row.name })}
              title={t("machines.systemMonitorTitle")}
              onClick={row.onMonitor}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12h4l3-7 4 14 3-7h4" />
              </svg>
            </button>
          )}
          {row.menu.length > 0 && (
            <button
              type="button"
              className="machines-icon-btn"
              aria-haspopup="menu"
              aria-label={t("machinesView.rowMenuAria", { name: row.name })}
              onClick={(e) => onMenu(row, e.currentTarget)}
            >
              <MoreIcon />
            </button>
          )}
        </span>
      </div>
      {row.error && !row.detail && <div className="machines-table-error">{row.error}</div>}
      {row.detail && <div className="machines-table-detail">{row.detail}</div>}
    </div>
  );
}

/**
 * The Machines view's one list: every machine — project hosts and global
 * machines, merged by host name — sorted by state then name, under one heading
 * per state. Off machines no project uses fold into a strip of names at the
 * foot; a name opens the same ⋯ menu as a row. A filter box and state chips
 * narrow it. Draws only: every action, probe and form is the caller's.
 */
export function MachinesTable({ rows, loading }: { rows: MachineTableRow[]; loading?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const { listed, idle, counts } = useMemo(() => {
    const matching = sortByStateThenName(rows.filter((r) => machineMatches(r, query)));
    // A row with something to say (an error, an open form) is never folded away.
    const folds = (r: MachineTableRow) => isIdleMachine(r) && !r.detail && !r.error;
    const idleRows = matching.filter(folds);
    const listedRows = matching.filter((r) => !folds(r));
    const byGroup = new Map<MachineGroup, number>();
    for (const r of listedRows) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + 1);
    return { listed: listedRows, idle: idleRows, counts: byGroup };
  }, [rows, query]);

  const openMenu = (row: MachineTableRow, el: HTMLElement) => {
    if (menu?.key === row.key) return setMenu(null);
    const rect = el.getBoundingClientRect();
    setMenu({ key: row.key, x: rect.left, y: rect.bottom + 4 });
  };
  const menuRow = menu ? rows.find((r) => r.key === menu.key) : undefined;

  const groups = MACHINE_GROUPS.filter((g) => (counts.get(g) ?? 0) > 0);
  const shownGroups = filter === "all" ? groups : groups.filter((g) => g === filter);
  const showIdle = idle.length > 0 && (filter === "all" || filter === "idle");
  const chip = (key: Filter, label: string, count: number) => (
    <button
      key={key}
      type="button"
      className={`machines-filter-chip${key === "all" ? "" : ` is-${key}`}`}
      aria-pressed={filter === key}
      onClick={() => setFilter(filter === key && key !== "all" ? "all" : key)}
    >
      {key !== "all" && key !== "idle" && <span className="machines-lamp" aria-hidden />}
      {label} · {count}
    </button>
  );

  return (
    <section className="machines-table-section" aria-label={t("cockpit.usage.machines")}>
      <div className="machines-table-tools">
        <label className="machines-filter-box">
          <SearchIcon />
          <input
            type="search"
            aria-label={t("machinesView.filterAria")}
            placeholder={t("machinesView.filterPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="machines-filter-chips" role="group" aria-label={t("machinesView.showAria")}>
          {chip("all", t("machinesView.filter.all"), listed.length + idle.length)}
          {groups.map((g) => chip(g, t(GROUP_LABEL[g]), counts.get(g) ?? 0))}
          {idle.length > 0 && chip("idle", t("machinesView.filter.idle"), idle.length)}
        </div>
        <UntestedTag id="machinesView.list" />
      </div>
      <div className="machines-table">
        <div className="machines-table-head machines-table-row" aria-hidden>
          <span>{t("machinesView.col.state")}</span>
          <span>{t("machinesView.col.machine")}</span>
          <span>{t("machinesView.col.projects")}</span>
          <span>{t("machinesView.col.activity")}</span>
          <span className="machines-table-actions">{t("machinesView.col.actions")}</span>
        </div>
        {rows.length === 0 && !loading && <p className="machines-table-empty">{t("machinesView.empty")}</p>}
        {rows.length > 0 && listed.length === 0 && idle.length === 0 && (
          <p className="machines-table-empty">{t("machinesView.noMatch", { query: query.trim() })}</p>
        )}
        {shownGroups.map((g) => (
          <div key={g} className="machines-table-group">
            <div className="machines-table-group-head">
              <span>{t(GROUP_LABEL[g])}</span>
              <span className="machines-table-group-count">{counts.get(g)}</span>
            </div>
            <div role="list" aria-label={t(GROUP_LABEL[g])}>
              {listed
                .filter((r) => r.group === g)
                .map((r) => (
                  <Row key={r.key} row={r} onMenu={openMenu} />
                ))}
            </div>
          </div>
        ))}
        {showIdle && (
          <div className="machines-idle-strip">
            <span className="machines-idle-label">
              <span className="machines-state is-off">
                <span className="machines-lamp" aria-hidden />
              </span>
              <strong>{t(idle.length === 1 ? "machinesView.idleOne" : "machinesView.idle", { count: idle.length })}</strong>
              <span>{t("machinesView.idleHint")}</span>
            </span>
            {idle.map((r) => (
              <button
                key={r.key}
                type="button"
                className="machines-idle-tag"
                aria-haspopup={r.menu.length > 0 ? "menu" : undefined}
                title={r.target ?? r.stateTip}
                onClick={(e) => (r.menu.length > 0 ? openMenu(r, e.currentTarget) : r.onMonitor?.())}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {menu && menuRow && menuRow.menu.length > 0 && (
        <EntryMenu x={menu.x} y={menu.y} entries={menuRow.menu} onClose={() => setMenu(null)} />
      )}
    </section>
  );
}

/**
 * Every machine the view lists: each project host (primary and compute hosts)
 * and each global machine, merged by host name (`lib/cockpit/machines`). The
 * lamps are the stores' own readings; nothing is probed from here.
 */
export function useMachineListRows(): MachineRow[] {
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

  return useMemo(() => {
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
}

/** The view's list: the merged rows, each drawn by the caller's `build` (it
 *  owns the global machines' actions and forms). Its own component so the store
 *  reads above re-render only the open view, never the header button. */
export function MachinesViewList({ build, loading }: { build: (row: MachineRow) => MachineTableRow; loading?: boolean }) {
  const rows = useMachineListRows();
  return <MachinesTable rows={rows.map(build)} loading={loading} />;
}

/** One Connect for a machine's not-connected projects: with one it opens that
 *  project's connection hub directly, with several a menu names them. */
export function ProjectConnectButton({ row, className = "settings-btn sm" }: { row: MachineRow; className?: string }) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = (projectId: string) => useRemoteMachinesStore.getState().open(projectId);
  if (row.disconnected.length === 0) return null;
  const only = row.disconnected.length === 1 ? row.disconnected[0] : null;
  return (
    <>
      <button
        type="button"
        className={className}
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

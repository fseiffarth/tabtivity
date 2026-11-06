import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  agentsSummary,
  buildProjectCards,
  filterGroups,
  hostsSummary,
  projectTotals,
  runHostLabel,
  splitGroups,
  type ProjectCard,
  type ProjectCardInput,
} from "../../lib/cockpit/projectCards";
import { agentRosterState, isRosterAgentKind } from "../../lib/agents/agentRoster";
import { isHostPinned, projectHostKind, type ProjectHostKind } from "../../lib/projectTabHost";
import { formatWorkedTime } from "../../lib/formatWorkedTime";
import { requestNewTab } from "../../lib/shortcuts/newTabChord";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useFrameBandValue } from "../../lib/window/frameBand";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { restoreProjectScope, useProjectsStore } from "../../stores/projects";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { useSyncStore } from "../../stores/remote/sync";
import { useTabsStore } from "../../stores/tabs";
import { EntryMenu, type MenuEntry } from "./EntryMenu";
import { DotIcon, MoreIcon } from "../common/icons/Icon";
import { CockpitUntested } from "./CockpitUntested";
import { useCockpitNow, useCockpitScopes, usePushRequests } from "./useCockpitData";
import { formatAgo } from "./cockpitFormat";

/** The kind marker's long name (its title) and one- or two-letter mark. */
const KIND_LABEL: Record<ProjectHostKind | "remoteOnly", TranslationKey> = {
  local: "cockpit.projects.kindLocal",
  remote: "cockpit.projects.kindRemote",
  remoteOnly: "cockpit.projects.kindRemoteOnly",
  vm: "cockpit.projects.kindVm",
  container: "cockpit.projects.kindContainer",
};
const KIND_MARK: Record<ProjectHostKind | "remoteOnly", TranslationKey> = {
  local: "cockpit.projects.kindMarkLocal",
  remote: "cockpit.projects.kindMarkRemote",
  remoteOnly: "cockpit.projects.kindMarkRemote",
  vm: "cockpit.projects.kindMarkVm",
  container: "cockpit.projects.kindMarkContainer",
};

/** The long git sentence is the cell's title; the short word is what it shows. */
const GIT_LABEL: Record<GitDirtyState, TranslationKey> = {
  clean: "cockpit.projects.gitClean",
  unpushed: "cockpit.projects.gitUnpushed",
  staged: "cockpit.projects.gitStaged",
  dirty: "cockpit.projects.gitDirty",
  broken: "cockpit.projects.gitBroken",
  unknown: "cockpit.projects.gitUnknown",
};
const GIT_WORD: Record<GitDirtyState, TranslationKey> = {
  clean: "cockpit.projects.gitWordClean",
  unpushed: "cockpit.projects.gitWordUnpushed",
  staged: "cockpit.projects.gitWordStaged",
  dirty: "cockpit.projects.gitWordDirty",
  broken: "cockpit.projects.gitWordBroken",
  unknown: "cockpit.projects.gitWordUnknown",
};

const LAMP_LABEL: Record<ConnState, TranslationKey> = {
  off: "cockpit.lamp.off",
  connecting: "cockpit.lamp.connecting",
  connected: "cockpit.lamp.connected",
  error: "cockpit.lamp.error",
};

/** Seconds worked today per project, read once on mount and each minute while
 *  the view is up (the committed figure `get_time_today` keeps). */
function useTimeToday(ids: readonly string[], now: number): Record<string, number> {
  const [secs, setSecs] = useState<Record<string, number>>({});
  const key = ids.join("\n");
  const minute = Math.floor(now / 60_000);
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    void Promise.allSettled(list.map((projectId) => invoke<number>("get_time_today", { projectId }))).then((results) => {
      const next: Record<string, number> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && typeof r.value === "number") next[list[i]] = r.value;
      });
      setSecs(next);
    });
  }, [key, minute]);
  return secs;
}

/** Bring a project up and close the cockpit; resolves once switched. */
async function openProject(id: string): Promise<void> {
  useRootOverlayStore.getState().close();
  await useProjectsStore.getState().setActive(id);
}

/** Hydrate a project's tabs (the one way a scope is restored from here, on a click). */
function restoreProject(card: ProjectCard) {
  const store = useProjectsStore.getState();
  if (!card.open) void store.activateProject(card.id);
  else {
    const project = store.projects.find((p) => p.id === card.id);
    if (project) void restoreProjectScope(project);
  }
}

const newAgentIn = (id: string) => void openProject(id).then(() => requestAnimationFrame(() => requestNewTab({ kind: "agent", slot: 0 })));
const showAgentsOf = (id: string) => {
  useCockpitStore.getState().showScope(id);
  useRootOverlayStore.getState().openView("now");
};

type Band = "wide" | "mid" | "narrow";

/** The grid each band lays its rows (and the column header) on. */
function gridClass(band: Band): string {
  return `cockpit-prow-grid ${band}`;
}

function Row({ card, now, band }: { card: ProjectCard; now: number; band: Band }) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const kind = card.hostPinned && card.kind === "remote" ? "remoteOnly" : card.kind;
  const agents = agentsSummary(card.counts);
  const hosts = hostsSummary(card.hosts);
  const hostsTitle = card.hosts
    .map((host) => t("cockpit.projects.lampTitle", { host: host.label, ssh: t(LAMP_LABEL[host.ssh]), vpn: t(LAMP_LABEL[host.vpn]) }))
    .join("\n");
  const entries: MenuEntry[] = [
    ...(band !== "narrow" ? [] : [
      { key: "agent", label: t("cockpit.projects.newAgent"), run: () => newAgentIn(card.id) },
      { key: "agents", label: t("cockpit.projects.agentsAction"), run: () => showAgentsOf(card.id) },
    ]),
    { key: "restore", label: t("cockpit.projects.restore"), run: () => restoreProject(card) },
  ];
  const dim = !agents || (agents.working === 0 && agents.asking === 0);
  return (
    <div
      role="listitem"
      aria-label={card.name}
      className={`cockpit-prow ${gridClass(band)}`}
      onClick={() => void openProject(card.id)}
    >
      <span className={`cockpit-state-mark state-${agents?.state ?? "idle"}`} aria-hidden>
        <DotIcon />
      </span>
      <span className="cockpit-prow-name">
        <button
          type="button"
          className="cockpit-prow-open"
          title={t("cockpit.projects.open")}
          onClick={(e) => {
            e.stopPropagation();
            void openProject(card.id);
          }}
        >
          {card.name}
        </button>
        <span className="cockpit-kind" title={t(KIND_LABEL[kind])}>{t(KIND_MARK[kind])}</span>
      </span>
      <span className={`cockpit-prow-agents${dim ? " dim" : ""}`}>
        {agents && (
          <>
            {agents.working > 0 && <span className="working">{t("cockpit.projects.nWorking", { count: agents.working })}</span>}
            {agents.asking > 0 && <span className="asking">{t("cockpit.projects.nAsking", { count: agents.asking })}</span>}
            <span>{t("cockpit.projects.nAgents", { count: agents.total })}</span>
          </>
        )}
      </span>
      <span className="cockpit-prow-git" title={card.git ? t(GIT_LABEL[card.git]) : undefined}>
        {card.git && (
          <>
            <span className={`cockpit-git-dot git-${card.git}`} aria-hidden>
              <DotIcon />
            </span>
            <span>{t(GIT_WORD[card.git])}</span>
          </>
        )}
        {card.pushPending > 0 && <span className="cockpit-chip">{t("cockpit.projects.push", { count: card.pushPending })}</span>}
        {card.syncDiverged ? <span className="cockpit-chip">{t("cockpit.projects.sync", { count: card.syncDiverged })}</span> : null}
      </span>
      {band !== "narrow" && (
        <span className="cockpit-prow-hosts" title={hostsTitle || undefined}>
          {hosts?.kind === "single" && (
            <>
              <span className={`cockpit-lamp lamp-${hosts.host.ssh}`} aria-hidden>
                <DotIcon />
              </span>
              <span>{hosts.host.label} · {t(LAMP_LABEL[hosts.host.ssh])}</span>
            </>
          )}
          {hosts?.kind === "many" && (
            <span className={hosts.on === 0 ? "dim" : undefined}>
              {hosts.on === 0
                ? t("cockpit.projects.hostsAllOff", { count: hosts.total })
                : t("cockpit.projects.hostsSomeOn", { on: hosts.on, count: hosts.total })}
            </span>
          )}
          {card.runHost && <span className="dim">{hosts ? "· " : ""}{t("cockpit.projects.runHost", { host: card.runHost })}</span>}
        </span>
      )}
      {band === "wide" && (
        <>
          <span className="cockpit-prow-today">{card.timeTodaySecs ? formatWorkedTime(t, card.timeTodaySecs) : ""}</span>
          <span className="cockpit-prow-last">{card.lastActivityAt !== undefined ? formatAgo(card.lastActivityAt, now) : ""}</span>
        </>
      )}
      <span className="cockpit-prow-actions" onClick={(e) => e.stopPropagation()}>
        {band !== "narrow" && (
          <>
            <button type="button" className="settings-btn sm" onClick={() => newAgentIn(card.id)}>{t("cockpit.projects.newAgent")}</button>
            <button type="button" className="settings-btn sm" onClick={() => showAgentsOf(card.id)}>{t("cockpit.projects.agentsAction")}</button>
          </>
        )}
        <button
          type="button"
          className="settings-btn sm cockpit-prow-more"
          aria-label={t("cockpit.projects.more")}
          title={t("cockpit.projects.more")}
          aria-haspopup="menu"
          aria-expanded={menu != null}
          onClick={(e) => {
            if (menu) return setMenu(null);
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <MoreIcon />
        </button>
      </span>
      {menu && <EntryMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A box's not-open projects: one dim line and their names as small buttons.
 *  A click opens the project; a right-click offers Restore tabs. */
function NotOpenLine({ cards }: { cards: ProjectCard[] }) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; card: ProjectCard } | null>(null);
  if (cards.length === 0) return null;
  return (
    <div className="cockpit-pfold">
      <span className="cockpit-meta">{t("cockpit.projects.notOpenCount", { count: cards.length })}</span>
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className="cockpit-chip-btn"
          title={t("cockpit.projects.foldHint", { name: card.name })}
          onClick={() => void openProject(card.id)}
          onContextMenu={(e: ReactMouseEvent) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, card });
          }}
        >
          {card.name}
        </button>
      ))}
      {menu && (
        <EntryMenu
          x={menu.x}
          y={menu.y}
          entries={[{ key: "restore", label: t("cockpit.projects.restore"), run: () => restoreProject(menu.card) }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * The Projects view (`docs/desktop_cockpit_plan.md`, View 2; compact rows per
 * `docs/cockpit_declutter_plan.md`): a ~34 px row per open project, grouped by
 * box under *All*, and the projects that are not open folded into one line per
 * box. It probes nothing: git dots, remote lamps and sync states are the
 * stores' own readings, time worked is the timer's committed figure, push
 * requests are read only for git-readable (local or connected) projects.
 * Restore is the one way a scope is hydrated from here, and only on a click.
 */
export function CockpitProjects() {
  const t = useT();
  const band = useFrameBandValue();
  const now = useCockpitNow();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const busy = useActivityStore((s) => s.busyByTab);
  const attention = useActivityStore((s) => s.attentionByTab);
  const lastDone = useActivityStore((s) => s.lastDoneByTab);
  const lastWorking = useActivityStore((s) => s.lastWorkingByTab);
  const git = useGitDirtyStore((s) => s.byId);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHost = useRemoteStatusStore((s) => s.byHost);
  const sync = useSyncStore((s) => s.byProject);
  const boxFilter = useCockpitStore((s) => s.boxFilter);
  const [query, setQuery] = useState("");
  const scopes = useCockpitScopes();
  const push = usePushRequests(scopes);
  const time = useTimeToday(useMemo(() => projects.map((p) => p.id), [projects]), now);

  const allGroups = useMemo(() => {
    // `agentRosterState` reads the activity store's current state; these
    // subscriptions are what re-derive the counts when a lamp changes.
    void [busy, attention];
    const inputs = projects.map((project): ProjectCardInput => {
      const tabs = tabsByScope[project.id];
      const loaded = project.status !== "inactive" && !!tabs;
      const agents = (tabs ?? []).filter((tab) => isRosterAgentKind(tab.kind));
      const ptys = agents.map((tab) => `${project.id}:${tab.key}`);
      const stamps = ptys.flatMap((pty) => [lastDone[pty], lastWorking[pty]]).filter((at): at is number => at !== undefined);
      const hosts = project.remote
        ? [
            { id: PRIMARY_HOST, label: project.remote.host ?? project.name, ...hostStateOf({ byProject, byHost }, project.id) },
            ...(project.compute_hosts ?? []).map((h) => ({ id: h.id, label: h.label || h.host || h.id, ...hostStateOf({ byProject, byHost }, project.id, h.id) })),
          ]
        : [];
      const diverged = Object.values(sync[project.id] ?? {}).filter((entry) => entry.state === "amber").length;
      return {
        id: project.id,
        name: project.name,
        kind: projectHostKind(project),
        hostPinned: isHostPinned(project),
        open: project.status !== "inactive",
        loaded,
        position: project.position ?? 0,
        boxIds: boxes.filter((b) => b.member_ids.includes(project.id)).map((b) => b.id),
        agentStates: loaded ? ptys.map((pty) => agentRosterState(pty)) : undefined,
        lastActivityAt: stamps.length ? Math.max(...stamps) : undefined,
        git: git[project.id],
        hosts,
        syncDiverged: diverged || undefined,
        runHost: runHostLabel(project, project.run_host, t),
        pushPending: push.filter((r) => r.projectId === project.id && (r.proposal.status === "pending" || r.proposal.status === "running")).length,
        timeTodaySecs: time[project.id],
      };
    });
    return buildProjectCards(inputs, { boxFilter, boxOrder: boxes.map((b) => b.id) });
  }, [projects, boxes, tabsByScope, busy, attention, lastDone, lastWorking, git, byProject, byHost, sync, push, time, boxFilter, t]);

  const totals = useMemo(() => projectTotals(allGroups), [allGroups]);
  const groups = useMemo(() => splitGroups(filterGroups(allGroups, query)), [allGroups, query]);

  return (
    <div className="cockpit-view cockpit-view-projects" role="region" aria-label={t("cockpit.projects.heading")}>
      <div className="cockpit-ptoolbar">
        <input
          type="search"
          className="settings-input sm cockpit-filter"
          value={query}
          placeholder={t("cockpit.projects.filter")}
          aria-label={t("cockpit.projects.filter")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <CockpitUntested view="projects" />
        <span className="cockpit-meta">{t("cockpit.projects.totals", totals)}</span>
      </div>
      <div className={`cockpit-prow-head ${gridClass(band)}`} aria-hidden>
        <span />
        <span>{t("cockpit.projects.colProject")}</span>
        <span>{t("cockpit.projects.colAgents")}</span>
        <span>{t("cockpit.projects.colGit")}</span>
        {band !== "narrow" && <span>{t("cockpit.projects.colHosts")}</span>}
        {band === "wide" && (
          <>
            <span>{t("cockpit.projects.colToday")}</span>
            <span>{t("cockpit.projects.colLast")}</span>
          </>
        )}
        <span />
      </div>
      {groups.length === 0 && <p className="cockpit-empty">{t(query.trim() ? "cockpit.projects.noMatch" : "cockpit.projects.empty")}</p>}
      {groups.map((group) => (
        <section key={group.boxId || "none"} className="cockpit-card-group">
          {!boxFilter && boxes.length > 0 && (
            <div className="tab-new-menu-group-label">
              {boxes.find((b) => b.id === group.boxId)?.name ?? t("cockpit.roster.noBox")}
            </div>
          )}
          <div role="list">
            {group.rows.map((card) => <Row key={`${group.boxId}/${card.id}`} card={card} now={now} band={band} />)}
          </div>
          <NotOpenLine cards={group.closed} />
        </section>
      ))}
    </div>
  );
}

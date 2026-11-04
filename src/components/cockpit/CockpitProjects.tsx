import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { buildProjectCards, type ProjectCard, type ProjectCardInput } from "../../lib/cockpit/projectCards";
import { agentRosterState, isRosterAgentKind } from "../../lib/agents/agentRoster";
import { isHostPinned, projectHostKind, type ProjectHostKind } from "../../lib/projectTabHost";
import { formatWorkedTime } from "../../lib/formatWorkedTime";
import { requestNewTab } from "../../lib/shortcuts/newTabChord";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { restoreProjectScope, useProjectsStore } from "../../stores/projects";
import { hostStateOf, PRIMARY_HOST, useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { useSyncStore } from "../../stores/remote/sync";
import { useTabsStore } from "../../stores/tabs";
import { ScopeSetStatusBars } from "../projects/PillStatusBars";
import { CockpitViewHeading } from "./CockpitViewHeading";
import { useCockpitNow, useCockpitScopes, usePushRequests } from "./useCockpitData";
import { formatAgo } from "./cockpitFormat";

const KIND_LABEL: Record<ProjectHostKind | "remoteOnly", TranslationKey> = {
  local: "cockpit.projects.kindLocal",
  remote: "cockpit.projects.kindRemote",
  remoteOnly: "cockpit.projects.kindRemoteOnly",
  vm: "cockpit.projects.kindVm",
  container: "cockpit.projects.kindContainer",
};

const GIT_LABEL: Record<GitDirtyState, TranslationKey> = {
  clean: "cockpit.projects.gitClean",
  unpushed: "cockpit.projects.gitUnpushed",
  staged: "cockpit.projects.gitStaged",
  dirty: "cockpit.projects.gitDirty",
  broken: "cockpit.projects.gitBroken",
  unknown: "cockpit.projects.gitUnknown",
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
  useCockpitStore.getState().closeOverlay();
  await useProjectsStore.getState().setActive(id);
}

function Card({ card, now }: { card: ProjectCard; now: number }) {
  const t = useT();
  const kind = card.hostPinned && card.kind === "remote" ? "remoteOnly" : card.kind;
  const restore = () => {
    const store = useProjectsStore.getState();
    if (!card.open) void store.activateProject(card.id);
    else {
      const project = store.projects.find((p) => p.id === card.id);
      if (project) void restoreProjectScope(project);
    }
  };
  return (
    <article className={`cockpit-card${card.loaded ? "" : " not-open"}`} aria-label={card.name}>
      <header className="cockpit-card-head">
        <strong className="cockpit-card-name" title={card.name}>{card.name}</strong>
        <span className="cockpit-chip">{t(KIND_LABEL[kind])}</span>
        {!card.loaded && <span className="cockpit-meta">{t("cockpit.projects.notOpen")}</span>}
      </header>
      {card.loaded && card.counts && (
        <div className="cockpit-card-row">
          <ScopeSetStatusBars scopes={[card.id]} interactive={false} />
          <span className="cockpit-meta">
            {t("cockpit.projects.agents", { total: card.counts.total, working: card.counts.working, asking: card.counts.asking, done: card.counts.done })}
          </span>
        </div>
      )}
      <div className="cockpit-card-row">
        {card.git && <span className={`cockpit-chip git-${card.git}`}>{t(GIT_LABEL[card.git])}</span>}
        {card.pushPending > 0 && <span className="cockpit-chip">{t("cockpit.projects.push", { count: card.pushPending })}</span>}
        {card.syncDiverged ? <span className="cockpit-chip">{t("cockpit.projects.sync", { count: card.syncDiverged })}</span> : null}
      </div>
      {card.hosts.length > 0 && (
        <div className="cockpit-card-row">
          {card.hosts.map((host) => (
            <span key={host.id} className={`cockpit-chip lamp-${host.ssh}`} title={t("cockpit.projects.lampTitle", { host: host.label, ssh: t(LAMP_LABEL[host.ssh]), vpn: t(LAMP_LABEL[host.vpn]) })}>
              {host.label} · {t(LAMP_LABEL[host.ssh])}
            </span>
          ))}
          {card.runHost && <span className="cockpit-meta">{t("cockpit.projects.runHost", { host: card.runHost })}</span>}
        </div>
      )}
      <div className="cockpit-card-row cockpit-meta">
        {card.timeTodaySecs !== undefined && <span>{t("cockpit.projects.timeToday", { time: formatWorkedTime(t, card.timeTodaySecs) })}</span>}
        {card.lastActivityAt !== undefined && <span>{t("cockpit.projects.lastActivity", { ago: formatAgo(card.lastActivityAt, now) })}</span>}
      </div>
      <footer className="cockpit-card-actions">
        <button type="button" className="settings-btn sm" onClick={() => void openProject(card.id)}>{t("cockpit.projects.open")}</button>
        {card.loaded && (
          <>
            <button
              type="button"
              className="settings-btn sm"
              onClick={() => void openProject(card.id).then(() => requestAnimationFrame(() => requestNewTab({ kind: "agent", slot: 0 })))}
            >
              {t("cockpit.projects.newAgent")}
            </button>
            <button type="button" className="settings-btn sm" onClick={() => useCockpitStore.getState().showScope(card.id)}>
              {t("cockpit.projects.agentsAction")}
            </button>
          </>
        )}
        {!card.loaded && (
          <button type="button" className="settings-btn sm" onClick={restore}>{t("cockpit.projects.restore")}</button>
        )}
      </footer>
    </article>
  );
}

/**
 * The Projects view (`docs/desktop_cockpit_plan.md`, View 2): a card per
 * project, grouped by box under *All*. It probes nothing: git dots, remote
 * lamps and sync states are the stores' own readings, time worked is the
 * timer's committed figure, push requests are read only for git-readable
 * (local or connected) projects. Restore is the one way a scope is hydrated
 * from here, and only on a click.
 */
export function CockpitProjects() {
  const t = useT();
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
  const scopes = useCockpitScopes();
  const push = usePushRequests(scopes);
  const time = useTimeToday(useMemo(() => projects.map((p) => p.id), [projects]), now);

  const groups = useMemo(() => {
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
        runHost: project.run_host,
        pushPending: push.filter((r) => r.projectId === project.id && (r.proposal.status === "pending" || r.proposal.status === "running")).length,
        timeTodaySecs: time[project.id],
      };
    });
    return buildProjectCards(inputs, { boxFilter, boxOrder: boxes.map((b) => b.id) });
  }, [projects, boxes, tabsByScope, busy, attention, lastDone, lastWorking, git, byProject, byHost, sync, push, time, boxFilter]);

  return (
    <div className="cockpit-view cockpit-view-projects">
      <CockpitViewHeading view="projects" />
      {groups.length === 0 && <p className="cockpit-empty">{t("cockpit.projects.empty")}</p>}
      {groups.map((group) => (
        <section key={group.boxId || "none"} className="cockpit-card-group">
          {!boxFilter && boxes.length > 0 && (
            <div className="tab-new-menu-group-label">
              {boxes.find((b) => b.id === group.boxId)?.name ?? t("cockpit.roster.noBox")}
            </div>
          )}
          <div className="cockpit-card-grid">
            {group.cards.map((card) => <Card key={`${group.boxId}/${card.id}`} card={card} now={now} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

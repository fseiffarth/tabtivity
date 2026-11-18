import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { agentRosterFacts, isRosterAgentKind } from "../../lib/agents/agentRoster";
import { isAgentProposal, nextScheduleOccurrence } from "../../lib/agents/agentSchedule";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { listMarkupQuestions, MARKUP_MCP_CHANGED } from "../../lib/viewers/markupQuestions";
import { paneRemoteHost } from "../../lib/tabs/remoteHold";
import { buildDecisions, type Decisions, type MarkupAskRef, type PushRequestRef, type ScheduleProposalRef } from "../../lib/cockpit/decisions";
import { buildRoster, type RosterInput, type RosterScope } from "../../lib/cockpit/roster";
import { useCockpitStore } from "../../stores/cockpit";
import { useAlertsFeed, type AlertsFeed } from "../files/useAlertsFeed";
import { useT } from "../../lib/i18n";
import type { GitPushProposal } from "../../types";
import { GIT_PUSH_MCP_CHANGED } from "../agents/GitPushMcp";

/** The backend's schedule-change event (the Agents view's own refresh). */
const SCHEDULES_CHANGED = "agent-schedules-changed";
/** How often the roster re-reads the clock for its turn times, and asks the
 *  model store for fresh tags (the store throttles its own reads). */
const TICK_MS = 15_000;

/** One loaded scope's agent tabs, in tab-bar order. */
export interface CockpitScopeTabs {
  scope: RosterScope;
  tabs: TabEntry[];
}

/**
 * Every hydrated scope the cockpit lists — projects that are not inactive,
 * boxes, and root, never the assistant scope — with its agent tabs. A scope
 * with no array has not been restored this session and is not listed: the
 * cockpit never hydrates one (that is the Projects card's explicit Restore).
 */
export function useCockpitScopes(): CockpitScopeTabs[] {
  const t = useT();
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  return useMemo(() => {
    const out: CockpitScopeTabs[] = [];
    const agents = (scope: string) => (tabsByScope[scope] ?? []).filter((tab) => isRosterAgentKind(tab.kind));
    if (tabsByScope[ROOT_SCOPE]) {
      out.push({ scope: { id: ROOT_SCOPE, name: t("cockpit.root"), kind: "root", boxIds: [] }, tabs: agents(ROOT_SCOPE) });
    }
    for (const project of projects) {
      if (project.status === "inactive" || !tabsByScope[project.id]) continue;
      const boxIds = boxes.filter((box) => box.member_ids.includes(project.id)).map((box) => box.id);
      out.push({ scope: { id: project.id, name: project.name, kind: "project", boxIds }, tabs: agents(project.id) });
    }
    for (const box of boxes) {
      const id = `${BOX_SCOPE_PREFIX}${box.id}`;
      if (!tabsByScope[id]) continue;
      out.push({ scope: { id, name: box.name, kind: "box", boxIds: [box.id] }, tabs: agents(id) });
    }
    return out.filter((entry) => entry.scope.id !== ASSISTANT_SCOPE);
  }, [tabsByScope, projects, boxes, t]);
}

/** A clock that ticks while the caller is mounted — the cockpit's views only. */
export function useCockpitNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The roster's inputs: one row per agent tab of `scopes`, read off the stores
 * at `now`. Re-derived when any of the readings it shows changes. Model tags
 * are re-read on mount and every tick, never per render.
 */
export function useRosterInputs(
  scopes: readonly CockpitScopeTabs[],
  now: number,
  { refresh = true }: { refresh?: boolean } = {},
): RosterInput[] {
  const busy = useActivityStore((s) => s.busyByTab);
  const attention = useActivityStore((s) => s.attentionByTab);
  const lastDone = useActivityStore((s) => s.lastDoneByTab);
  const lastWorking = useActivityStore((s) => s.lastWorkingByTab);
  const screenByTab = useAgentModelsStore((s) => s.screenByTab);
  const byTab = useAgentModelsStore((s) => s.byTab);
  const modeByTab = useAgentModelsStore((s) => s.modeByTab);
  const goalByTab = useAgentModelsStore((s) => s.goalByTab);
  const promptByTab = useAgentModelsStore((s) => s.promptByTab);
  const projects = useProjectsStore((s) => s.projects);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHost = useRemoteStatusStore((s) => s.byHost);
  const schedules = useAgentSchedulesStore((s) => s.byTarget);

  useEffect(() => {
    // A caller that only needs the states (the Root rail) reads what the model
    // store holds and asks it for nothing.
    if (!refresh) return;
    const models = useAgentModelsStore.getState();
    for (const { scope, tabs } of scopes) {
      for (const tab of tabs) {
        void models.refresh(scope.id, tab);
        void models.refreshScreen(scope.id, tab);
      }
    }
  }, [scopes, now, refresh]);

  return useMemo(() => {
    // The facts are read off the stores' current state; these subscriptions
    // are what re-derive them when a reading changes.
    void [busy, attention, lastDone, lastWorking, screenByTab, byTab, modeByTab, goalByTab];
    const at = new Date(now);
    return scopes.flatMap(({ scope, tabs }) => {
      const project = projects.find((p) => p.id === scope.id);
      return tabs.map((tab): RosterInput => {
        const facts = agentRosterFacts(scope.id, tab, now, { reread: false });
        const remote = project?.remote ? paneRemoteHost(tab, project, byProject[scope.id]?.ssh, byHost[scope.id]) : null;
        const rules = tab.scheduleTargetId ? schedules[scheduleCacheKey(scope.id, tab.scheduleTargetId)] ?? [] : [];
        const next = rules
          .map((rule) => nextScheduleOccurrence(rule, at)?.at.getTime())
          .filter((ms): ms is number => ms !== undefined)
          .sort((a, b) => a - b)[0];
        const prompt = tab.cmd === "opencode" ? undefined : promptByTab[facts.ptyId];
        return {
          scope,
          tab,
          facts,
          lastPrompt: prompt || undefined,
          hostDown: remote?.held || undefined,
          host: remote?.hostId ? remote.label : undefined,
          nextScheduleAt: next,
        };
      });
    });
  }, [scopes, now, busy, attention, lastDone, lastWorking, screenByTab, byTab, modeByTab, goalByTab, promptByTab, projects, byProject, byHost, schedules]);
}

/** What a Needs-you rail adds to the live stores' groups: the groups that need
 *  a backend read (push requests, schedule proposals, markup asks). */
export interface DecisionExtras {
  push: readonly PushRequestRef[];
  schedules: readonly ScheduleProposalRef[];
  markup: readonly MarkupAskRef[];
}
const NO_EXTRAS: DecisionExtras = { push: [], schedules: [], markup: [] };

/**
 * The Needs-you groups (`buildDecisions`) over `scopes`, for a rail that is not
 * the Now view: the live-store groups — asking, interrupted,
 * finished-not-seen, alerts — plus whatever `extras` a caller loaded. It
 * carries no `useCockpitNow` clock, asks the model store for nothing and reads
 * nothing from the backend, so a rail built on it costs a re-derivation when a
 * store changes and nothing else. (`now` is only the minute: the states are
 * the activity store's, which `useRosterInputs` is subscribed to.)
 */
export function useDecisionsFor(
  scopes: readonly CockpitScopeTabs[],
  extras: DecisionExtras = NO_EXTRAS,
): { decisions: Decisions; alerts: AlertsFeed } {
  const sort = useCockpitStore((s) => s.sort);
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const inputs = useRosterInputs(scopes, minute, { refresh: false });
  const alerts = useAlertsFeed();
  const rows = useMemo(
    () => buildRoster(inputs, { stateFilter: "all", sort, mode: "flat", query: "", boxFilter: null, scopeFilter: null }).rows,
    [inputs, sort],
  );
  const names = useMemo(() => Object.fromEntries(scopes.map((entry) => [entry.scope.id, entry.scope.name])), [scopes]);
  const decisions = useMemo(
    () =>
      buildDecisions({
        rows,
        push: extras.push,
        schedules: extras.schedules,
        markup: extras.markup,
        alerts: alerts.enabled ? alerts.items : [],
        names,
      }),
    [rows, extras, alerts.enabled, alerts.items, names],
  );
  return { decisions, alerts };
}

/** Run `load` now and again on each of `events`, while mounted. */
function useLoadOn(events: readonly string[], load: () => void) {
  useEffect(() => {
    load();
    const stops = events.map((name) => subscribeTauri(() => listen(name, () => load())));
    return () => {
      for (const stop of stops) stop();
    };
  }, [events, load]);
}

const PUSH_EVENTS = [GIT_PUSH_MCP_CHANGED];
const SCHEDULE_EVENTS = [SCHEDULES_CHANGED];
const MARKUP_EVENTS = [MARKUP_MCP_CHANGED];

/** Projects a git read may run against: local ones, and remote ones whose
 *  session is connected (a read against a dead one can freeze the window). */
function useGitReadableProjects(scopes: readonly CockpitScopeTabs[]): string[] {
  const projects = useProjectsStore((s) => s.projects);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const key = scopes
    .filter((entry) => entry.scope.kind === "project")
    .map((entry) => entry.scope.id)
    .filter((id) => {
      const project = projects.find((p) => p.id === id);
      return !project?.remote || byProject[id]?.ssh === "connected";
    })
    .join("\n");
  return useMemo(() => (key ? key.split("\n") : []), [key]);
}

/**
 * The push / release requests of every git-readable project, read on mount
 * and on `git-push-mcp-changed`. One project's failure leaves the others.
 */
export function usePushRequests(scopes: readonly CockpitScopeTabs[]): PushRequestRef[] {
  const ids = useGitReadableProjects(scopes);
  const [rows, setRows] = useState<PushRequestRef[]>([]);
  const load = useCallback(() => {
    void Promise.allSettled(
      ids.map((projectId) =>
        invoke<GitPushProposal[]>("git_push_mcp_proposals", { projectId })
          .then((list) => (Array.isArray(list) ? list : []).map((proposal) => ({ projectId, proposal })))
          .catch(() => [] as PushRequestRef[]),
      ),
    ).then((results) => setRows(results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))));
  }, [ids]);
  useLoadOn(PUSH_EVENTS, load);
  return rows;
}

/** Every agent tab's schedules loaded into the schedules store (on mount and
 *  on the backend's change event), so proposals and Tonight read them. */
export function useLoadSchedules(scopes: readonly CockpitScopeTabs[]): void {
  const key = scopes
    .flatMap(({ scope, tabs }) => tabs.flatMap((tab) => (tab.scheduleTargetId ? [`${scope.id}\t${tab.scheduleTargetId}`] : [])))
    .join("\n");
  const load = useCallback(() => {
    const store = useAgentSchedulesStore.getState();
    void Promise.allSettled(
      (key ? key.split("\n") : []).map((row) => {
        const [scope, target] = row.split("\t");
        return store.load(scope, target).catch(() => []);
      }),
    );
  }, [key]);
  useLoadOn(SCHEDULE_EVENTS, load);
}

/** The schedule proposals in the loaded schedules, with the tab each targets. */
export function useScheduleProposals(scopes: readonly CockpitScopeTabs[]): ScheduleProposalRef[] {
  const byTarget = useAgentSchedulesStore((s) => s.byTarget);
  return useMemo(
    () =>
      scopes.flatMap(({ scope, tabs }) =>
        tabs.flatMap((tab) => {
          if (!tab.scheduleTargetId) return [];
          const targetId = tab.scheduleTargetId;
          return (byTarget[scheduleCacheKey(scope.id, targetId)] ?? [])
            .filter(isAgentProposal)
            .map((schedule) => ({ projectId: scope.id, targetId, schedule, ptyId: `${scope.id}:${tab.key}` }));
        }),
      ),
    [scopes, byTarget],
  );
}

/** Open `markup_ask` cards of every agent tab, on mount and on change. */
export function useMarkupAsks(scopes: readonly CockpitScopeTabs[]): MarkupAskRef[] {
  const key = scopes
    .filter((entry) => entry.scope.kind === "project")
    .flatMap(({ scope, tabs }) =>
      tabs.flatMap((tab) => (tab.scheduleTargetId ? [`${scope.id}\t${tab.scheduleTargetId}\t${scope.id}:${tab.key}`] : [])),
    )
    .join("\n");
  const [rows, setRows] = useState<MarkupAskRef[]>([]);
  const load = useCallback(() => {
    void Promise.allSettled(
      (key ? key.split("\n") : []).map((row) => {
        const [projectId, target, ptyId] = row.split("\t");
        return listMarkupQuestions(projectId, target)
          .then((asks) => asks.map((ask) => ({ projectId, ptyId, ask })))
          .catch(() => [] as MarkupAskRef[]);
      }),
    ).then((results) => setRows(results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))));
  }, [key]);
  useLoadOn(MARKUP_EVENTS, load);
  return rows;
}

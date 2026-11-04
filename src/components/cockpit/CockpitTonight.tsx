import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { buildPromptChart, type PromptChartStrand } from "../../lib/agents/prompt/chart";
import { historyTabId } from "../../lib/agents/prompt/adopt";
import { buildRoster } from "../../lib/cockpit/roster";
import {
  awaySince,
  buildAway,
  buildComingUp,
  scheduleItems,
  warmupItems,
  type ComingUpItem,
  type TonightBucket,
} from "../../lib/cockpit/tonight";
import { useT, type TranslationKey } from "../../lib/i18n";
import { openPromptChartTab } from "../../lib/shortcuts/tabJump";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { lastUserInputAt, useActivityStore } from "../../stores/activity";
import { queuePromptForTab, useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { useSettingsStore } from "../../stores/settings";
import { useAlertsFeed } from "../files/useAlertsFeed";
import { CockpitViewHeading } from "./CockpitViewHeading";
import { formatAgo, formatClock, formatTurn } from "./cockpitFormat";
import { jumpToRow } from "./CockpitRoster";
import { useCockpitNow, useCockpitScopes, useLoadSchedules, usePushRequests, useRosterInputs, type CockpitScopeTabs } from "./useCockpitData";

const BUCKET_LABEL: Record<TonightBucket, TranslationKey> = {
  now: "cockpit.tonight.bucketNow",
  nextHour: "cockpit.tonight.bucketHour",
  tonight: "cockpit.tonight.bucketTonight",
  tomorrow: "cockpit.tonight.bucketTomorrow",
  later: "cockpit.tonight.bucketLater",
};

const KIND_LABEL: Record<ComingUpItem["kind"], TranslationKey> = {
  schedule: "cockpit.tonight.kindSchedule",
  chart: "cockpit.tonight.kindChart",
  autoContinue: "cockpit.tonight.kindAutoContinue",
  warmup: "cockpit.tonight.kindWarmup",
  event: "cockpit.tonight.kindEvent",
};

/** Prompts, links and history of every loaded project, read while the view
 *  is up and again on `agent-prompts-changed` (the Prompt chart's own loads). */
function useLoadPrompts(scopes: readonly CockpitScopeTabs[]) {
  const key = scopes.filter((s) => s.scope.kind === "project").map((s) => s.scope.id).join("\n");
  const load = useCallback(() => {
    const store = useAgentPromptsStore.getState();
    void Promise.allSettled(
      (key ? key.split("\n") : []).flatMap((id) => [
        store.load(id).catch(() => []),
        store.loadLinks(id).catch(() => []),
        store.loadHistory(id).catch(() => []),
      ]),
    );
  }, [key]);
  useEffect(() => {
    load();
    return subscribeTauri(() => listen("agent-prompts-changed", () => load()));
  }, [load]);
}

/**
 * The Tonight view (`docs/desktop_cockpit_plan.md`, View 3): *Coming up* — every
 * enabled schedule, queued / chained Prompt chart card, auto-continue tab,
 * warm-up and calendar event in one timeline — and *While you were away*,
 * derived from stamps the stores keep. Its reads run only while it is shown.
 */
export function CockpitTonight() {
  const t = useT();
  const now = useCockpitNow();
  const scopes = useCockpitScopes();
  useLoadSchedules(scopes);
  useLoadPrompts(scopes);
  const inputs = useRosterInputs(scopes, now);
  const push = usePushRequests(scopes);
  const schedules = useAgentSchedulesStore((s) => s.byTarget);
  const prompts = useAgentPromptsStore((s) => s.byProject);
  const links = useAgentPromptsStore((s) => s.linksByProject);
  const history = useAgentPromptsStore((s) => s.historyByProject);
  const root = useRootReviewStore((s) => s.proposals);
  const cron = useSettingsStore((s) => s.settings?.agent_cron);
  const lastClosedAt = useCockpitStore((s) => s.lastClosedAt);
  const alerts = useAlertsFeed();
  const [error, setError] = useState("");
  // When this view opened: the away window ends here, not at each tick.
  const [openedAt] = useState(() => Date.now());

  const comingUp = useMemo(() => {
    const items: ComingUpItem[] = [];
    for (const { scope, tabs } of scopes) {
      const strands: PromptChartStrand[] = [];
      for (const tab of tabs) {
        const ptyId = `${scope.id}:${tab.key}`;
        if (tab.autoContinue) {
          items.push({ id: `auto:${ptyId}`, kind: "autoContinue", at: null, title: tab.label, scope: scope.id, scopeName: scope.name, tabLabel: tab.label, ptyId });
        }
        if (!tab.scheduleTargetId) continue;
        const rules = schedules[scheduleCacheKey(scope.id, tab.scheduleTargetId)] ?? [];
        items.push(...scheduleItems(rules, { scope: scope.id, scopeName: scope.name, tabLabel: tab.label, ptyId, targetId: tab.scheduleTargetId }, now));
        strands.push({ id: `strand:${tab.scheduleTargetId}`, label: tab.label, scheduleTargetId: tab.scheduleTargetId, tabKey: tab.key, sessionId: tab.sessionId, tabId: historyTabId(tab), agent: tab.cmd, schedules: rules });
      }
      if (scope.kind !== "project" || !prompts[scope.id]) continue;
      const cards = buildPromptChart({ prompts: prompts[scope.id] ?? [], history: history[scope.id] ?? [], strands, links: links[scope.id] ?? [], now: new Date(now) });
      for (const card of cards) {
        if (card.state !== "queued" && card.state !== "chained") continue;
        items.push({ id: `chart:${scope.id}:${card.key}`, kind: "chart", at: card.at ? card.at.getTime() : null, title: card.message, scope: scope.id, scopeName: scope.name, state: card.state });
      }
    }
    items.push(...warmupItems(cron, now));
    if (alerts.enabled) {
      for (const alert of alerts.items) {
        if (alert.kind !== "event" || !alert.at || alert.allDay) continue;
        const at = new Date(alert.at).getTime();
        if (Number.isFinite(at) && at >= now) items.push({ id: `event:${alert.id}`, kind: "event", at, title: alert.title });
      }
    }
    return buildComingUp(items, now);
  }, [scopes, schedules, prompts, links, history, cron, alerts.enabled, alerts.items, now]);

  const rows = useMemo(
    () => buildRoster(inputs, { stateFilter: "all", sort: "lastDone", mode: "flat", query: "", boxFilter: null, scopeFilter: null }).rows,
    [inputs],
  );
  const lastInput = useMemo(
    () => Math.max(0, ...rows.map((row) => lastUserInputAt(row.ptyId) ?? 0).filter((at) => at < openedAt)),
    [rows, openedAt],
  );
  const away = useMemo(() => {
    const loaded = scopes.flatMap(({ scope, tabs }) =>
      tabs.flatMap((tab) =>
        tab.scheduleTargetId
          ? (schedules[scheduleCacheKey(scope.id, tab.scheduleTargetId)] ?? []).map((rule) => ({ rule, scopeName: scope.name, tabLabel: tab.label, targetId: tab.scheduleTargetId! }))
          : [],
      ),
    );
    return buildAway({ rows, schedules: loaded, push, root, since: awaySince(lastClosedAt, lastInput || undefined, openedAt) });
  }, [scopes, schedules, rows, push, root, lastClosedAt, lastInput, openedAt]);

  const act = (work: () => Promise<unknown>) => {
    setError("");
    void work().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const markAllSeen = () => {
    const activity = useActivityStore.getState();
    for (const row of away.finished) activity.clearAttention(row.ptyId);
  };

  return (
    <div className="cockpit-view cockpit-view-tonight">
      <CockpitViewHeading view="tonight" />
      {error && <p className="cockpit-empty" role="alert">{error}</p>}
      <div className="cockpit-tonight">
        <section className="cockpit-tonight-col" aria-label={t("cockpit.tonight.heading")}>
          {comingUp.length === 0 && <p className="cockpit-empty">{t("cockpit.tonight.nothing")}</p>}
          {comingUp.map((group) => (
            <div key={group.bucket} className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t(BUCKET_LABEL[group.bucket])}</div>
              {group.items.map((item) => (
                <div key={item.id} className={`cockpit-tonight-row kind-${item.kind}`}>
                  <span className="cockpit-meta cockpit-tonight-time">{item.at !== null ? formatClock(item.at) : "—"}</span>
                  <span className="cockpit-chip">{t(KIND_LABEL[item.kind])}</span>
                  {item.scopeName && <span className="cockpit-rail-scope">{item.scopeName}{item.tabLabel ? ` · ${item.tabLabel}` : ""}</span>}
                  <span className="cockpit-rail-text" title={item.title}>{item.title}</span>
                  <span className="cockpit-tonight-actions">
                    {item.kind === "schedule" && item.schedule && item.scope && item.targetId && (
                      <>
                        <button
                          type="button"
                          className="settings-btn sm"
                          onClick={() => act(() => useAgentSchedulesStore.getState().upsert(item.scope!, item.targetId!, { ...item.schedule!, enabled: false }, { expectExistingOn: item.targetId }))}
                        >
                          {t("cockpit.tonight.disable")}
                        </button>
                        <button
                          type="button"
                          className="settings-btn sm"
                          onClick={() => act(() => queuePromptForTab(item.scope!, item.targetId!, item.schedule!.message, { preface: item.schedule!.preface }))}
                        >
                          {t("cockpit.tonight.sendNow")}
                        </button>
                      </>
                    )}
                    {item.kind === "chart" && item.scope && (
                      <button type="button" className="settings-btn sm" onClick={() => { useRootOverlayStore.getState().close(); void openPromptChartTab(item.scope!); }}>
                        {t("cockpit.tonight.openChart")}
                      </button>
                    )}
                    {item.kind === "autoContinue" && item.ptyId && (
                      <button type="button" className="settings-btn sm" onClick={() => {
                          const store = useCockpitStore.getState();
                          store.select(item.ptyId!);
                          useRootOverlayStore.getState().openView("now");
                        }}>
                        {t("cockpit.tonight.show")}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
        <section className="cockpit-tonight-col" aria-label={t("cockpit.tonight.awayTitle")}>
          <div className="cockpit-column-head">
            {t("cockpit.tonight.awayTitle")}
            <span className="cockpit-meta">{t("cockpit.tonight.awaySince", { ago: formatAgo(awaySince(lastClosedAt, lastInput || undefined, openedAt), now) })}</span>
            {away.finished.length > 0 && (
              <button type="button" className="settings-btn sm" onClick={markAllSeen}>{t("cockpit.tonight.markSeen")}</button>
            )}
          </div>
          {away.empty && <p className="cockpit-empty">{t("cockpit.tonight.awayEmpty")}</p>}
          {away.finished.length > 0 && (
            <div className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t("cockpit.tonight.finished")}</div>
              {away.finished.map((row) => (
                <button key={row.ptyId} type="button" className="cockpit-tonight-row as-button" onClick={() => jumpToRow(row.ptyId)}>
                  <span className="cockpit-meta cockpit-tonight-time">{row.facts.doneAt ? formatClock(row.facts.doneAt) : ""}</span>
                  <span className="cockpit-rail-scope">{row.scope.name} · {row.tab.label}</span>
                  {row.turn && !row.turn.running && <span className="cockpit-meta">{formatTurn(row.turn.ms, t)}</span>}
                  <span className="cockpit-rail-text">{row.lastPrompt ?? ""}</span>
                </button>
              ))}
            </div>
          )}
          {away.cutOff.length > 0 && (
            <div className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t("cockpit.tonight.cutOff")}</div>
              {away.cutOff.map((row) => (
                <button key={row.ptyId} type="button" className="cockpit-tonight-row as-button" onClick={() => jumpToRow(row.ptyId)}>
                  <span className="cockpit-rail-scope">{row.scope.name} · {row.tab.label}</span>
                </button>
              ))}
            </div>
          )}
          {away.pushes.length > 0 && (
            <div className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t("cockpit.tonight.pushes")}</div>
              {away.pushes.map(({ projectId, proposal }) => (
                <div key={proposal.id} className="cockpit-tonight-row">
                  <span className="cockpit-rail-scope">{scopes.find((s) => s.scope.id === projectId)?.scope.name ?? projectId}</span>
                  <span className="cockpit-rail-text">{proposal.tag ?? proposal.branch ?? ""}</span>
                </div>
              ))}
            </div>
          )}
          {away.fired.length > 0 && (
            <div className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t("cockpit.tonight.fired")}</div>
              {away.fired.map(({ rule, scopeName, tabLabel, targetId }) => (
                <div key={`${targetId}/${rule.id}`} className="cockpit-tonight-row">
                  <span className="cockpit-meta cockpit-tonight-time">{rule.last ? formatClock(Date.parse(rule.last.at)) : ""}</span>
                  <span className="cockpit-rail-scope">{scopeName} · {tabLabel}</span>
                  <span className="cockpit-rail-text">{rule.message}</span>
                </div>
              ))}
            </div>
          )}
          {away.rootWrites.length > 0 && (
            <div className="cockpit-tonight-group">
              <div className="tab-new-menu-group-label">{t("cockpit.tonight.rootWrites")}</div>
              {away.rootWrites.map((p) => (
                <div key={p.id} className="cockpit-tonight-row">
                  <span className="cockpit-rail-text">{p.tool}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

import type { DecisionGroupId, Decisions } from "../../lib/cockpit/decisions";
import type { RosterRow } from "../../lib/cockpit/roster";
import { useT, type TranslationKey } from "../../lib/i18n";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { splitPtyId } from "../../stores/activity";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { GitPushProposalCard } from "../agents/GitPushMcp";
import { AgentScheduleProposal } from "../agents/AgentScheduleProposal";
import { RootReviewStrip } from "../layout/RootReviewStrip";
import { AlertsMenu } from "../header/AlertsMenu";
import { TabContinueButton } from "../tabs/TabLocalityBadges";
import type { AlertsFeed } from "../files/useAlertsFeed";

const GROUP_LABEL: Record<DecisionGroupId, TranslationKey> = {
  asking: "cockpit.rail.asking",
  interrupted: "cockpit.rail.interrupted",
  push: "cockpit.rail.push",
  schedule: "cockpit.rail.schedule",
  approvals: "cockpit.rail.approvals",
  markup: "cockpit.rail.markup",
  unseen: "cockpit.rail.unseen",
  alerts: "cockpit.rail.alerts",
};

/** One group: its heading with the count, then its rows. */
function Group({ id, count, children }: { id: DecisionGroupId; count: number; children: ReactNode }) {
  const t = useT();
  return (
    <section className="cockpit-rail-group" data-group={id} aria-label={t(GROUP_LABEL[id])}>
      <div className="tab-new-menu-group-label cockpit-rail-heading">
        {t(GROUP_LABEL[id])} <span className="cockpit-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

/** A tab row: picks the tab for the detail pane. */
function TabRow({ row, selected, trailing }: { row: RosterRow; selected: boolean; trailing?: ReactNode }) {
  return (
    <div className={`cockpit-rail-row${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="cockpit-rail-pick"
        onClick={() => useCockpitStore.getState().select(row.ptyId)}
        title={row.lastPrompt}
      >
        <span className="cockpit-rail-scope">{row.scope.name}</span>
        <span className="cockpit-rail-tab">{row.tab.label}</span>
      </button>
      {trailing}
    </div>
  );
}

/**
 * The Decisions inbox (`docs/desktop_cockpit_plan.md`, View 1 · Needs you): the
 * eight groups in the phone's urgency order, each with its own action in place
 * — the existing cards, never a second answering UI. Empty groups are not
 * drawn; a rail with nothing says so in one line.
 */
export function CockpitRail({ decisions, selected, alerts }: { decisions: Decisions; selected: string | null; alerts: AlertsFeed }) {
  const t = useT();
  const { items } = decisions;
  const close = () => useRootOverlayStore.getState().close();
  return (
    <aside className="cockpit-rail" aria-label={t("cockpit.rail.title")}>
      <div className="cockpit-column-head">
        {t("cockpit.rail.title")} <span className="cockpit-count">{decisions.total}</span>
      </div>
      <div className="cockpit-column-scroll">
        {decisions.groups.length === 0 && <p className="cockpit-empty">{t("cockpit.rail.empty")}</p>}
        {decisions.groups.map(({ id, count }) => {
          switch (id) {
            case "asking":
              return (
                <Group key={id} id={id} count={count}>
                  {items.asking.map((row) => <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} />)}
                </Group>
              );
            case "interrupted":
              return (
                <Group key={id} id={id} count={count}>
                  {items.interrupted.map((row) => (
                    <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} trailing={<TabContinueButton tab={row.tab} stateClass="interrupted" />} />
                  ))}
                </Group>
              );
            case "push":
              return (
                <Group key={id} id={id} count={count}>
                  {items.push.map(({ projectId, proposal }) => (
                    <details key={proposal.id} className="cockpit-rail-fold">
                      <summary>
                        {t("cockpit.rail.pushLine", { project: decisions.names[projectId] ?? projectId, branch: proposal.branch ?? proposal.tag ?? "…" })}
                      </summary>
                      <GitPushProposalCard proposal={proposal} />
                    </details>
                  ))}
                </Group>
              );
            case "schedule":
              return (
                <Group key={id} id={id} count={count}>
                  {items.schedule.map((ref) => (
                    <div key={`${ref.targetId}/${ref.schedule.id}`} className="cockpit-rail-row column">
                      <span className="cockpit-rail-scope">{decisions.names[ref.projectId] ?? ref.projectId}</span>
                      <span className="cockpit-rail-text" title={ref.schedule.message}>{ref.schedule.message}</span>
                      <AgentScheduleProposal projectId={ref.projectId} targetId={ref.targetId} schedule={ref.schedule} />
                    </div>
                  ))}
                </Group>
              );
            case "approvals":
              return (
                <Group key={id} id={id} count={count}>
                  <details className="cockpit-rail-fold">
                    <summary>{t("cockpit.rail.approvalsLine", { count })}</summary>
                    <RootReviewStrip />
                  </details>
                </Group>
              );
            case "markup":
              return (
                <Group key={id} id={id} count={count}>
                  {items.markup.map(({ projectId, ptyId, ask }) => (
                    <div key={ask.id} className="cockpit-rail-row">
                      <button
                        type="button"
                        className="cockpit-rail-pick"
                        onClick={() => {
                          const at = splitPtyId(ptyId);
                          if (at) jumpToTab(at.scope, at.key);
                          close();
                        }}
                      >
                        <span className="cockpit-rail-scope">{decisions.names[projectId] ?? projectId}</span>
                        <span className="cockpit-rail-tab">{ask.fileName ?? t("cockpit.rail.markupAny")}</span>
                      </button>
                    </div>
                  ))}
                </Group>
              );
            case "unseen":
              return (
                <Group key={id} id={id} count={count}>
                  {items.unseen.map((row) => <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} />)}
                </Group>
              );
            case "alerts":
              return (
                <Group key={id} id={id} count={count}>
                  <AlertsMenu feed={alerts} onNavigate={close} />
                </Group>
              );
          }
          return null;
        })}
      </div>
    </aside>
  );
}

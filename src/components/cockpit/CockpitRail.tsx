import type { ReactNode } from "react";

import type { DecisionGroupId, Decisions } from "../../lib/cockpit/decisions";
import type { RosterRow } from "../../lib/cockpit/roster";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { GitPushProposalCard } from "../agents/GitPushMcp";
import { AgentScheduleProposal } from "../agents/AgentScheduleProposal";
import { AlertsMenu } from "../header/AlertsMenu";
import { jumpToRow } from "./CockpitRoster";
import { TabContinueButton } from "../tabs/TabLocalityBadges";
import type { AlertsFeed } from "../files/useAlertsFeed";
import { RefreshIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { dismissAttention } from "../../lib/cockpit/attention";
import type { AgentAskRef } from "../../lib/cockpit/decisions";
import { formatAgo } from "./cockpitFormat";

/** Each group's heading, also the icon rail's labels. */
export const GROUP_LABEL: Record<DecisionGroupId, TranslationKey> = {
  asking: "cockpit.rail.asking",
  agentAsks: "cockpit.rail.agentAsks",
  interrupted: "cockpit.rail.interrupted",
  push: "cockpit.rail.push",
  schedule: "cockpit.rail.schedule",
  markup: "cockpit.rail.markup",
  unseen: "cockpit.rail.unseen",
  alerts: "cockpit.rail.alerts",
};

/** One group: its heading with the count (and an optional control at its
 *  right end), then its rows. */
function Group({ id, count, trailing, children }: { id: DecisionGroupId; count: number; trailing?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <section className="cockpit-rail-group" data-group={id} aria-label={t(GROUP_LABEL[id])}>
      <div className="tab-new-menu-group-label cockpit-rail-heading">
        {t(GROUP_LABEL[id])} <span className="cockpit-count">{count}</span>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** A tab row: picks the tab for the detail pane. */
function TabRow({
  row,
  selected,
  trailing,
  onPick,
}: {
  row: RosterRow;
  selected: boolean;
  trailing?: ReactNode;
  onPick: (row: RosterRow) => void;
}) {
  return (
    <div className={`cockpit-rail-row${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="cockpit-rail-pick"
        onClick={() => onPick(row)}
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
 * An agent-reported question (`tab_request_attention`): the tab's row, which
 * opens its conversation exactly as an asking row does, the agent's question as
 * plain text, and a Dismiss that only hides the notice (the host marks it
 * dismissed; nothing is answered or approved).
 */
function AgentAskRow({ ask, selected, onPick }: { ask: AgentAskRef; selected: boolean; onPick: (row: RosterRow) => void }) {
  const t = useT();
  const { row } = ask;
  return (
    <div className={`cockpit-rail-row column cockpit-agent-ask${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="cockpit-rail-pick"
        onClick={() => onPick(row)}
        title={t("cockpit.rail.agentAsksNote", { ago: formatAgo(ask.setAt, Date.now()) })}
      >
        <span className="cockpit-rail-scope">{row.scope.name}</span>
        <span className="cockpit-rail-tab">{row.tab.label}</span>
      </button>
      <span className="cockpit-note-text cockpit-agent-ask-text">{ask.question}</span>
      <span className="cockpit-agent-ask-actions">
        <button
          type="button"
          className="settings-btn sm"
          title={t("cockpit.rail.agentAsksDismissTitle")}
          onClick={() => void dismissAttention(row.scope.id, row.tab.id, ask.id)}
        >
          {t("cockpit.rail.agentAsksDismiss")}
        </button>
        <UntestedTag id="cockpit.mcp.attention" />
      </span>
    </div>
  );
}

/**
 * The Decisions inbox (`docs/desktop_cockpit_plan.md`, View 1 · Needs you): the
 * eight groups in the phone's urgency order, each with its own action in place
 * — the existing cards, never a second answering UI. Empty groups are not
 * drawn; a rail with nothing says so in one line.
 */
export function CockpitRail({
  decisions,
  selected,
  alerts,
  onPick,
  headAction,
}: {
  decisions: Decisions;
  selected: string | null;
  alerts: AlertsFeed;
  /** A tab row picked. The Now view selects it for the detail pane (the default);
   *  the Root view's rail, with no detail pane, jumps to the tab. */
  onPick?: (row: RosterRow) => void;
  /** A control at the right of the heading (the Root rail's fold button). */
  headAction?: ReactNode;
}) {
  const t = useT();
  const { items } = decisions;
  const pick = onPick ?? ((row: RosterRow) => useCockpitStore.getState().select(row.ptyId));
  const close = () => useRootOverlayStore.getState().close();
  return (
    <aside className="cockpit-rail" aria-label={t("cockpit.rail.title")}>
      <div className="cockpit-column-head">
        {t("cockpit.rail.title")} <span className="cockpit-count">{decisions.total}</span>
        {headAction}
      </div>
      <div className="cockpit-column-scroll">
        {decisions.groups.length === 0 && <p className="cockpit-empty">{t("cockpit.rail.empty")}</p>}
        {decisions.groups.map(({ id, count }) => {
          switch (id) {
            case "asking":
              return (
                <Group key={id} id={id} count={count}>
                  {items.asking.map((row) => <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} onPick={pick} />)}
                </Group>
              );
            case "agentAsks":
              return (
                <Group key={id} id={id} count={count}>
                  {items.agentAsks.map((ask) => (
                    <AgentAskRow key={`${ask.row.ptyId}:${ask.id}`} ask={ask} selected={ask.row.ptyId === selected} onPick={pick} />
                  ))}
                </Group>
              );
            case "interrupted":
              return (
                <Group key={id} id={id} count={count}>
                  {items.interrupted.map((row) => (
                    <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} onPick={pick} trailing={<TabContinueButton tab={row.tab} stateClass="interrupted" />} />
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
            case "markup":
              return (
                <Group key={id} id={id} count={count}>
                  {items.markup.map(({ projectId, ptyId, ask }) => (
                    <div key={ask.id} className="cockpit-rail-row">
                      <button
                        type="button"
                        className="cockpit-rail-pick"
                        onClick={() => jumpToRow(ptyId)}
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
                  {items.unseen.map((row) => <TabRow key={row.ptyId} row={row} selected={row.ptyId === selected} onPick={pick} />)}
                </Group>
              );
            case "alerts":
              return (
                <Group
                  key={id}
                  id={id}
                  count={count}
                  trailing={
                    <button
                      type="button"
                      className="toolbar-btn toolbar-btn--sm cockpit-rail-refresh"
                      onClick={alerts.refresh}
                      title={t("filesAlerts.refresh")}
                      aria-label={t("filesAlerts.refresh")}
                    >
                      <RefreshIcon />
                    </button>
                  }
                >
                  <AlertsMenu feed={alerts} onNavigate={close} bare />
                </Group>
              );
          }
          return null;
        })}
      </div>
    </aside>
  );
}

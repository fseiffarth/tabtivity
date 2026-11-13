import { useMemo } from "react";

import type { RosterRow } from "../../lib/cockpit/roster";
import { nextScheduleOccurrence } from "../../lib/agents/agentSchedule";
import { useT } from "../../lib/i18n";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { currentHandoff } from "../../lib/cockpit/agentNotes";
import { ArrowUpRightIcon } from "../common/icons/Icon";
import { CockpitDetailPane } from "./CockpitDetailPane";
import { formatAgo, formatClock } from "./cockpitFormat";
import { jumpToRow, ScopeChip } from "./CockpitRoster";
import { UntestedTag } from "../common/UntestedTag";
import { CockpitResults } from "./CockpitResults";
import { CockpitAttention, CockpitBlocker, CockpitMilestones, CockpitProgress, CockpitVerification } from "./CockpitReports";

const NO_PROMPTS: readonly { text: string }[] = [];

/**
 * The Now view's right column: the shown tab's header (scope · tab, ↗ Jump,
 * the facts the roster has for it), its live Chat through `CockpitDetailPane`,
 * and, folded below, its schedules and last prompts. Nothing to show: the top
 * Asking row, else the latest working agent (a one-line strip says it is
 * following; picking a row pins), else one line.
 */
export function CockpitDetail({
  row,
  focused,
  now,
  following = false,
}: {
  row: RosterRow | undefined;
  focused: boolean;
  now: number;
  /** Nothing is picked and nothing asks: the pane shows the latest working agent. */
  following?: boolean;
}) {
  const t = useT();
  const target = row?.tab.scheduleTargetId;
  const schedules = useAgentSchedulesStore((s) => (row && target ? s.byTarget[scheduleCacheKey(row.scope.id, target)] : undefined));
  const recent = useAgentModelsStore((s) => (row ? s.recentByTab[row.ptyId] : undefined)) ?? NO_PROMPTS;
  const upcoming = useMemo(() => {
    const at = new Date(now);
    return (schedules ?? [])
      .map((rule) => ({ rule, next: nextScheduleOccurrence(rule, at)?.at.getTime() }))
      .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  }, [schedules, now]);

  if (!row) {
    return (
      <section className="cockpit-detail">
        <p className="cockpit-empty">{t("cockpit.detail.empty")}</p>
      </section>
    );
  }
  const handoff = currentHandoff(row.tab.cockpitMeta);
  const jumpKey = row.scope.kind === "root" ? "cockpit.detail.openInRoot" : "cockpit.detail.jump";
  return (
    <section className="cockpit-detail" aria-label={t("cockpit.detail.title", { tab: row.tab.label })}>
      <div className="cockpit-column-head cockpit-detail-head">
        <span className="cockpit-detail-name">
          <ScopeChip scope={row.scope} /> {row.tab.label}
        </span>
        <span className="cockpit-meta">
          {[row.facts.model, row.host].filter(Boolean).join(" · ")}
        </span>
        {/* A root tab has no pane behind the window: Enter opens it in the Root view. */}
        {row.scope.kind === "root" && <UntestedTag id="rootConsole.rootRow" />}
        <button type="button" className="settings-btn sm" onClick={() => jumpToRow(row.ptyId)} title={t(jumpKey)}>
          <ArrowUpRightIcon /> {t(jumpKey)}
        </button>
      </div>
      {following && (
        <div className="cockpit-detail-follow">
          <span className="cockpit-meta">{t("cockpit.detail.following")}</span>
          <UntestedTag id="cockpit.now.follow" />
        </div>
      )}
      <CockpitDetailPane key={row.ptyId} ptyId={row.ptyId} focused={focused} />
      <CockpitAttention row={row} now={now} />
      {handoff && (
        <details className="cockpit-detail-fold cockpit-agent-note" open>
          <summary>
            {t("cockpit.notes.handoff")} <UntestedTag id="cockpit.mcp.handoff" />
          </summary>
          <p className="cockpit-meta">{t("cockpit.notes.handoffMeta", { ago: formatAgo(handoff.setAt, now) })}</p>
          {(
            [
              ["cockpit.notes.summary", handoff.summary],
              ["cockpit.notes.checks", handoff.checks],
              ["cockpit.notes.remaining", handoff.remaining],
            ] as const
          ).map(([label, body]) =>
            body.trim() === "" ? null : (
              <div key={label} className="cockpit-note-field">
                <span className="cockpit-note-tag">{t(label)}</span>
                <p className="cockpit-note-text">{body}</p>
              </div>
            ),
          )}
        </details>
      )}
      <CockpitResults row={row} now={now} />
      <CockpitProgress row={row} now={now} />
      <CockpitBlocker row={row} now={now} />
      <CockpitVerification row={row} now={now} />
      <CockpitMilestones row={row} now={now} />
      <details className="cockpit-detail-fold">
        <summary>{t("cockpit.detail.schedules", { count: upcoming.length })}</summary>
        {upcoming.length === 0 ? (
          <p className="cockpit-empty">{t("cockpit.detail.noSchedules")}</p>
        ) : (
          <ul className="cockpit-detail-list">
            {upcoming.map(({ rule, next }) => (
              <li key={rule.id} className={rule.enabled ? undefined : "off"}>
                <span className="cockpit-meta">{next !== undefined ? formatClock(next) : t("cockpit.detail.off")}</span> {rule.message}
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="cockpit-detail-fold">
        <summary>{t("cockpit.detail.prompts", { count: recent.length })}</summary>
        <ul className="cockpit-detail-list">
          {recent.slice(-5).map((prompt, i) => <li key={i}>{prompt.text}</li>)}
        </ul>
      </details>
    </section>
  );
}

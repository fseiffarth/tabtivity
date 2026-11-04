import { useMemo } from "react";

import type { RosterRow } from "../../lib/cockpit/roster";
import { nextScheduleOccurrence } from "../../lib/agents/agentSchedule";
import { useT } from "../../lib/i18n";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { ArrowUpRightIcon } from "../common/icons/Icon";
import { CockpitDetailPane } from "./CockpitDetailPane";
import { formatClock } from "./cockpitFormat";
import { jumpToRow, ScopeChip } from "./CockpitRoster";
import { UntestedTag } from "../common/UntestedTag";

const NO_PROMPTS: readonly { text: string }[] = [];

/**
 * The Now view's right column: the shown tab's header (scope · tab, ↗ Jump,
 * the facts the roster has for it), its live Chat through `CockpitDetailPane`,
 * and, folded below, its schedules and last prompts. Nothing to show: the top
 * Asking row, else one line.
 */
export function CockpitDetail({ row, focused, now }: { row: RosterRow | undefined; focused: boolean; now: number }) {
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
      <CockpitDetailPane key={row.ptyId} ptyId={row.ptyId} focused={focused} />
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

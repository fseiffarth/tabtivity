import type { RosterRow } from "../../lib/cockpit/roster";
import { currentBlocker, currentMilestones, currentVerification, openAttention, progressReport } from "../../lib/cockpit/agentNotes";
import { dismissAttention } from "../../lib/cockpit/attention";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { ProgressState, VerificationOutcome } from "../../stores/tabs/types";
import { UntestedTag } from "../common/UntestedTag";
import { formatAgo, formatClock } from "./cockpitFormat";

/*
 * The structured reports an agent publishes about its own tab (cockpit MCP
 * `tab_set_progress`, `tab_set_blocker`, `tab_set_verification`), under the
 * handoff and results in the detail pane. Everything here is the agent's own
 * statement, as plain text: it never changes an app-detected state, runs a
 * check or asserts a result, and nothing in it is clickable. Static marks only
 * (no spinner): a live step is a word, not an animation.
 */

const STEP_LIVE: Record<ProgressState, TranslationKey> = {
  pending: "cockpit.notes.stepPending",
  active: "cockpit.notes.stepActive",
  done: "cockpit.notes.stepDone",
};
// A past report never says a step is in progress: its active step "was".
const STEP_PAST: Record<ProgressState, TranslationKey> = { ...STEP_LIVE, active: "cockpit.notes.stepWasActive" };

const OUTCOME: Record<VerificationOutcome, TranslationKey> = {
  passed: "cockpit.notes.outcomePassed",
  failed: "cockpit.notes.outcomeFailed",
  pending: "cockpit.notes.outcomePending",
  not_run: "cockpit.notes.outcomeNotRun",
};

/** The agent's plan steps: running only while the agent is live and the report
 *  is its own and under 30 minutes old; otherwise a past report. */
export function CockpitProgress({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const report = progressReport(row.tab.cockpitMeta, now, !row.hostDown);
  if (!report) return null;
  const marks = report.running ? STEP_LIVE : STEP_PAST;
  return (
    <details
      className={`cockpit-detail-fold cockpit-agent-note cockpit-agent-progress ${report.running ? "running" : "past"}`}
      open
    >
      <summary>
        {t(report.running ? "cockpit.notes.progress" : "cockpit.notes.progressPastTitle")} <UntestedTag id="cockpit.mcp.progress" />
      </summary>
      <p className="cockpit-meta">
        {t(report.running ? "cockpit.notes.progressMeta" : "cockpit.notes.progressPastMeta", { ago: formatAgo(report.setAt, now) })}
      </p>
      <ol className="cockpit-step-list">
        {report.steps.map((step) => (
          <li key={step.id} className={`cockpit-step ${step.state}`}>
            <span className="cockpit-step-state">{t(marks[step.state])}</span>
            <span className="cockpit-note-text">{step.label}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** What the agent says is in its way, while it is live and under 30 minutes
 *  old - the same line the roster shows in place of the activity. */
export function CockpitBlocker({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const blocker = currentBlocker(row.tab.cockpitMeta, now, !row.hostDown);
  if (!blocker) return null;
  return (
    <details className="cockpit-detail-fold cockpit-agent-note cockpit-agent-blocker" open>
      <summary>
        {t("cockpit.notes.blocker")} <UntestedTag id="cockpit.mcp.blocker" />
      </summary>
      <p className="cockpit-meta">{t("cockpit.notes.blockerMeta", { ago: formatAgo(blocker.setAt, now) })}</p>
      <p className="cockpit-note-text">{blocker.text}</p>
    </details>
  );
}

/** The checks the agent reports. A statement with the time it was reported,
 *  not a run time and not a result this app produced. */
export function CockpitVerification({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const report = currentVerification(row.tab.cockpitMeta);
  if (!report) return null;
  return (
    <details className="cockpit-detail-fold cockpit-agent-note cockpit-agent-verification" open>
      <summary>
        {t("cockpit.notes.verification")} <UntestedTag id="cockpit.mcp.verification" />
      </summary>
      <p className="cockpit-meta">
        {t("cockpit.notes.verificationMeta", { time: formatClock(report.setAt), ago: formatAgo(report.setAt, now) })}
      </p>
      <ul className="cockpit-check-list">
        {report.entries.map((entry, index) => (
          <li key={index} className={`cockpit-check ${entry.outcome}`}>
            <span className="cockpit-step-state">{t(OUTCOME[entry.outcome])}</span>
            <span className="cockpit-note-text">{entry.label}</span>
            {entry.note && <p className="cockpit-note-text cockpit-check-note">{entry.note}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The question the agent reported for its tab while it is open (under 24
 *  hours), with a Dismiss that only hides the notice. It answers and approves
 *  nothing; the real conversation is the pane above. */
export function CockpitAttention({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const ask = openAttention(row.tab.cockpitMeta, now);
  if (!ask) return null;
  return (
    <details className="cockpit-detail-fold cockpit-agent-note cockpit-agent-attention" open>
      <summary>
        {t("cockpit.notes.attention")} <UntestedTag id="cockpit.mcp.attention" />
      </summary>
      <p className="cockpit-meta">{t("cockpit.notes.attentionMeta", { ago: formatAgo(ask.setAt, now) })}</p>
      <p className={`cockpit-note-text cockpit-agent-ask-text${ask.dismissed ? " dismissed" : ""}`}>{ask.question}</p>
      {ask.dismissed ? (
        <p className="cockpit-meta">{t("cockpit.notes.attentionDismissed")}</p>
      ) : (
        <button
          type="button"
          className="settings-btn sm"
          title={t("cockpit.rail.agentAsksDismissTitle")}
          onClick={() => void dismissAttention(row.scope.id, row.tab.id, ask.id)}
        >
          {t("cockpit.rail.agentAsksDismiss")}
        </button>
      )}
    </details>
  );
}

/** The agent's finished milestones, newest first, each with the time the host
 *  received the report. A bounded history (20) of the agent's own statements. */
export function CockpitMilestones({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const list = currentMilestones(row.tab.cockpitMeta);
  if (list.length === 0) return null;
  return (
    <details className="cockpit-detail-fold cockpit-agent-note cockpit-agent-milestones" open>
      <summary>
        {t("cockpit.notes.milestones")} <UntestedTag id="cockpit.mcp.milestones" />
      </summary>
      <p className="cockpit-meta">{t("cockpit.notes.milestonesMeta")}</p>
      <ul className="cockpit-check-list">
        {list.map((m) => (
          <li key={m.requestId} className="cockpit-check">
            <span className="cockpit-step-state" title={formatAgo(m.at, now)}>{formatClock(m.at)}</span>
            <span className="cockpit-note-text">{m.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

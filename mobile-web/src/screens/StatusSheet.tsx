import { useCallback, useEffect, useState } from "react";
import { useI18nStore, useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { getAgentStatus, type AgentStatusReport, type TabRow } from "../api";
import { describeFailure } from "../connection";
import { limitMeters, noteParts, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import { resetCountdown, resetText } from "../terminal/limitResets";
import type { SessionStatus } from "../terminal/statusLine";

export { resetCountdown, resetText };

/** Wording for the tab's own state, which the desktop classified from the
 * session's output. `idle` is the honest fifth: the catalog only publishes the
 * other four, and a tab nobody is waiting on is not "done". */
const STATE_TEXT: Record<AgentStatusReport["state"], TranslationKey> = {
  working: "agentPrompts.state.working",
  question: "mobile.status.waiting",
  interrupted: "tabBar.statusInterrupted",
  done: "mobile.status.finishedTurn",
  idle: "agentPrompts.state.idle",
};

/** `4880` → `1h 21m`. Seconds are dropped above a minute: this is a day's
 * rollup, and a second of it is noise. */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}


/**
 * The composer's status chip: what this agent tab is doing, and what its CLI
 * says about the account behind it.
 *
 * Two views, the same switch the header uses for the session itself.
 * **Formatted** parses the CLI's panel into bars; **Terminal** shows the panel
 * exactly as the CLI printed it. The raw text is always one tap away on
 * purpose — the format belongs to somebody else's CLI, so a release that
 * reshapes it must cost the reader a nicer layout, never the figures.
 *
 * `live` is what the phone already read off the session's own status line
 * (model, mode, context) — free, and about *this* tab, where the quota panel is
 * about the whole account.
 */
export function StatusSheet({ tab, live, onLimits, onClose, signIn }: {
  tab: TabRow;
  live: SessionStatus | null;
  /** Hands a fresh panel's 5h/week windows to the facts row, so a Refresh
   * here updates it without waiting for its own poll. */
  onLimits?: (limits: LimitMeters) => void;
  onClose: () => void;
  /** How this CLI signs in from here — a sign-in tab of its own, or its
   * slash command typed into the session (`signIn.ts`) — when it can; the
   * sheet then offers Sign in. */
  signIn?: { hint: string; start: () => void } | null;
}) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  /** A count in the phone's language, under the key its number calls for. */
  const counted = (count: number, one: TranslationKey, many: TranslationKey, vars: Record<string, string> = {}) =>
    t(count === 1 ? one : many, { ...vars, count: count.toLocaleString(lang) });
  const [view, setView] = useState<"formatted" | "terminal">("formatted");
  const [report, setReport] = useState<AgentStatusReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError("");
    try {
      const next = await getAgentStatus(tab.id, refresh);
      setReport(next);
      if (next.usage.raw) onLimits?.(limitMeters(parseUsageReport(next.usage.raw)));
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setBusy(false);
    }
  }, [tab.id, onLimits]);

  useEffect(() => { void load(false); }, [load]);

  const usage = report?.usage;
  const panel = usage?.raw ? parseUsageReport(usage.raw) : null;

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet status-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.status.of", { name: tab.label })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{t("terminal.reader.status.button")} {isUntested("mobile.sheet.status") && <small>{t("mobile.newTab.untested")}</small>}</h2>
        <div className="terminal-view-switch" aria-label={t("mobile.status.view")}>
          <button className={view === "formatted" ? "selected" : ""} aria-pressed={view === "formatted"} onClick={() => setView("formatted")}>{t("mobile.status.formatted")}</button>
          <button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => setView("terminal")}>{t("mobile.focus.terminal")}</button>
        </div>
      </header>

      {report && <p className={`status-headline ${report.state}`}>
        <strong>{t(STATE_TEXT[report.state])}{report.state === "interrupted" && isUntested("mobile.tabs.statusMotion") && <> · {t("mobile.focus.untested")}</>}</strong>
        {report.agent && <span>{report.agent}</span>}
        {live?.model && <span>{live.model}</span>}
        {live?.mode && <span>{live.mode}</span>}
        {live?.context && <span>{t("mobile.status.contextLeft", { context: live.context })}</span>}
      </p>}

      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {busy && !report && <p className="sheet-note">{t("pdfMeta.reading")}</p>}

      {view === "formatted" && report && <>
        {/* `usage.error` is a code (`connection.ts`): the CLI's own stderr
            stays on the desktop, since it names paths there. */}
        {usage?.supported === false && <p className="sheet-note">
          {usage.error && usage.error !== "no_usage_readout" && usage.error !== "unknown_agent"
            ? describeFailure(usage.error)
            : t("mobile.status.noReadout", { agent: usage.label })}
        </p>}
        {usage?.supported && usage.error && <p className="sheet-note error">{describeFailure(usage.error)}</p>}
        {panel && panel.meters.map((meter) => <div className="usage-meter" key={meter.label}>
          <div>
            <strong>{meter.label}</strong>
            <span>{meter.percent}%</span>
          </div>
          <div className="usage-bar" role="img" aria-label={t("mobile.status.meterUsed", { label: meter.label, percent: meter.percent })}>
            <span style={{ width: `${meter.percent}%` }} />
          </div>
          {meter.resets && <small title={t("mobile.status.resets", { when: meter.resets })}>{resetText(meter.resets, new Date())}</small>}
        </div>)}
        {panel?.unparsed && <p className="sheet-note">
          {t("mobile.status.unparsed", { agent: usage?.label ?? "" })}
        </p>}
        {panel && panel.notes.length > 0 && <ul className="usage-notes">
          {panel.notes.map((note, index) => <li key={`${note.label ?? ""}-${index}`}>
            {note.label && <strong>{note.label}</strong>}
            <span>{noteParts(note.value).join(" · ")}</span>
          </li>)}
        </ul>}

        <div className="usage-today">
          <strong>{t("mobile.status.todayIn", { project: report.project })}</strong>
          <span>{counted(report.today.prompts, "mobile.status.promptsToOne", "mobile.status.promptsTo", { agent: report.agent ?? t("mobile.status.thisAgent") })}</span>
          <small>
            {t("mobile.status.acrossProject", { duration: duration(report.today.worked_s) })}
            {" · "}{counted(report.today.decisions, "mobile.status.decisionsOne", "mobile.status.decisions")}
            {" · "}{counted(report.today.done, "mobile.status.turnsFinishedOne", "mobile.status.turnsFinished")}
          </small>
        </div>
      </>}

      {view === "terminal" && <pre className="usage-raw" aria-label={t("mobile.status.rawPanel")}>
        {usage?.raw ?? (usage?.error ? describeFailure(usage.error) : busy ? t("pdfMeta.reading") : t("mobile.status.nothingPrinted"))}
      </pre>}

      <div className="mobile-schedule-actions">
        {usage?.cached && <span className="sheet-pending">{t("mobile.status.cached")}</span>}
        {signIn && <button onClick={signIn.start} title={signIn.hint}>{t("mobile.signIn.start")}</button>}
        <button disabled={busy} onClick={() => void load(true)}>{t(busy ? "pdfMeta.reading" : "common.refresh")}</button>
        <button className="primary" onClick={onClose}>{t("mobile.gitSheet.done")}</button>
      </div>
    </section>
  </div>;
}

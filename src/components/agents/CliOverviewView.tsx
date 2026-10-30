import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { overviewMeters, planLabel, type CliOverviewRow } from "../../../shared/cliOverview";
import { resetText } from "../../../mobile-web/src/terminal/limitResets";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentClis";
import { useI18nStore, useT, dateLocale } from "../../lib/i18n";
import { usePoll } from "../../lib/usePoll";
import { useTabsStore } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

/** The phone's pacing for a usage panel: often enough to watch a window fill,
 *  rare enough that the CLI is not spawned for nothing (its read is cached
 *  60 s on the backend anyway). */
const POLL_MS = 5 * 60_000;

/** Open tabs per CLI id, over every scope the window holds. */
function useOpenTabs(): Record<string, number> {
  const tabsByScope = useTabsStore((state) => state.tabsByScope);
  return useMemo(() => {
    const idOfBin = new Map(AGENT_CLI_ROWS.map((row) => [row.bin, row.id]));
    const counts: Record<string, number> = {};
    for (const tabs of Object.values(tabsByScope)) {
      for (const tab of tabs ?? []) {
        const id = tab.cmd ? idOfBin.get(tab.cmd) : undefined;
        if (id) counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    return counts;
  }, [tabsByScope]);
}

/**
 * The side panel's CLIs view: per agent CLI in use, its plan, the account it
 * is signed in as, its usage windows with when each rolls over, and how many
 * of its tabs are open (`docs/cli_overview_plan.md`). Account-wide, so the
 * same in every scope. Read while shown, every few minutes; ⟳ asks again.
 */
export function CliOverviewView({ active }: { active: boolean }) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const openTabs = useOpenTabs();
  const [rows, setRows] = useState<CliOverviewRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState(() => Date.now());

  const load = useCallback(async (refresh: boolean, stopped?: () => boolean) => {
    setBusy(true);
    try {
      const next = await invoke<CliOverviewRow[]>("agent_overview", { refresh });
      if (stopped?.()) return;
      setRows(next);
      setFailed(false);
      setReadAt(Date.now());
    } catch {
      if (!stopped?.()) setFailed(true);
    } finally {
      if (!stopped?.()) setBusy(false);
    }
  }, []);

  usePoll((poll) => load(false, () => poll.stopped), POLL_MS, { enabled: active });

  // Rows with an open tab but no login, plan or reading still say they are
  // in use: the backend lists only what the store knows about.
  const shown = useMemo(() => {
    const list = [...(rows ?? [])];
    for (const cli of AGENT_CLI_ROWS) {
      if (openTabs[cli.id] && !list.some((row) => row.id === cli.id)) {
        list.push({ id: cli.id, label: cli.label, signedIn: false });
      }
    }
    return list;
  }, [rows, openTabs]);

  // The panel's words are placed against the moment they were read; the
  // countdown against now.
  const readTime = new Date(readAt);
  const clock = new Date();
  const dateFormat = new Intl.DateTimeFormat(dateLocale(lang), { month: "short", day: "numeric" });
  const timeFormat = new Intl.DateTimeFormat(dateLocale(lang), { hour: "numeric", minute: "2-digit" });

  return <div className="side-panel-scroll cli-overview-view" style={{ flex: 1, overflowY: "auto", padding: 6 }}>
    <section className="agent-prompts-section">
      <div className="agent-prompts-tabs-head">
        <h3 className="settings-section-title">{t("cliOverview.title")} <UntestedTag id="clis.overview" /></h3>
        <button
          type="button"
          className="toolbar-btn toolbar-btn--sm"
          disabled={busy}
          onClick={() => void load(true)}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >↻</button>
      </div>
      {failed && <p className="settings-help">{t("cliOverview.failed")}</p>}
      {rows && shown.length === 0 && <p className="settings-help">{t("cliOverview.empty")}</p>}
      {!rows && !failed && <p className="settings-help">{t("pdfMeta.reading")}</p>}
      {shown.map((row) => {
        const meters = overviewMeters(row, clock);
        const tabs = openTabs[row.id] ?? 0;
        const facts = [
          row.account,
          row.signedIn ? null : t("cliOverview.notSignedIn"),
          tabs ? t(tabs === 1 ? "cliOverview.tabsOne" : "cliOverview.tabs", { count: tabs }) : null,
          row.plan?.until ? t("cliOverview.planUntil", { date: dateFormat.format(new Date(row.plan.until)) }) : null,
        ].filter(Boolean);
        return <article className="agent-prompts-tab cli-overview-card" key={row.id}>
          <div className="agent-prompts-tab-main">
            <div className="cli-overview-head">
              <strong>{row.label}</strong>
              {row.plan && <span className="cli-overview-plan">{planLabel(row.plan)}</span>}
            </div>
            {facts.length > 0 && <small className="cli-overview-facts">{facts.join(" · ")}</small>}
            {meters.map((meter) => <div className="cli-overview-meter" key={meter.label}>
              <div>
                <span>{meter.label}</span>
                <span>{t("cliOverview.used", { percent: Math.round(meter.percent) })}</span>
              </div>
              <div
                className={`cli-overview-bar${meter.percent >= 90 ? " high" : ""}`}
                role="img"
                aria-label={t("mobile.status.meterUsed", { label: meter.label, percent: Math.round(meter.percent) })}
              ><span style={{ width: `${meter.percent}%` }} /></div>
              {meter.resets && <small>{resetText(meter.resets, clock, readTime)}</small>}
            </div>)}
            {row.limits && meters.length > 0 && <small className="cli-overview-facts">
              {t("cliOverview.asOf", { time: timeFormat.format(new Date(row.limits.readAt * 1000)) })}
            </small>}
            {row.signedIn && meters.length === 0 && <small className="cli-overview-facts">
              {row.usage?.code ? t("cliOverview.usageFailed") : t("cliOverview.noUsage")}
            </small>}
          </div>
        </article>;
      })}
    </section>
  </div>;
}

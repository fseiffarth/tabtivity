import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getCliOverview } from "../api";
import { overviewMeters, planLabel, type CliOverviewRow } from "../../../shared/cliOverview";
import { resetText } from "../terminal/limitResets";
import { isUntested } from "../../../src/lib/untested";
import { dateLocale, useI18nStore, useT } from "../../../src/lib/i18n";
import { useBackLayer } from "../backStack";

type Translate = ReturnType<typeof useT>;

interface Overview { clis: CliOverviewRow[]; desktopAvailable: boolean; readAt: number }

function codeOf(reason: unknown): string {
  return reason instanceof ApiError ? reason.code : "request_failed";
}

/** The fullest window across the CLIs — what the Home row says at a glance. */
function tightest(overview: Overview, now: Date): { label: string; percent: number } | null {
  let best: { label: string; percent: number } | null = null;
  for (const row of overview.clis) {
    for (const meter of overviewMeters(row, now)) {
      if (!best || meter.percent > best.percent) best = { label: row.label, percent: Math.round(meter.percent) };
    }
  }
  return best;
}

function caption(overview: Overview | null, failure: string | null, t: Translate): string {
  if (failure) return t("cliOverview.failed");
  if (!overview) return t("pdfMeta.reading");
  if (overview.clis.length === 0) return t("cliOverview.empty");
  const signedIn = t("mobile.clis.summary", { count: overview.clis.filter((row) => row.signedIn).length });
  const top = tightest(overview, new Date());
  return top ? `${signedIn} · ${t("mobile.clis.tightest", top)}` : signedIn;
}

/** One CLI's card: plan, facts, a bar per window with its rollover. */
function CliCard({ row, readAt, t }: { row: CliOverviewRow; readAt: number; t: Translate }) {
  const lang = useI18nStore((state) => state.lang);
  const clock = new Date();
  const meters = overviewMeters(row, clock);
  const facts = [
    row.signedIn ? null : t("cliOverview.notSignedIn"),
    row.plan?.until
      ? t("cliOverview.planUntil", { date: new Intl.DateTimeFormat(dateLocale(lang), { month: "short", day: "numeric" }).format(new Date(row.plan.until)) })
      : null,
  ].filter(Boolean);
  return <li className="cli-overview-card">
    <div className="cli-overview-head">
      <strong>{row.label}</strong>
      {row.plan && <span className="cli-overview-plan">{planLabel(row.plan)}</span>}
    </div>
    {facts.length > 0 && <small>{facts.join(" · ")}</small>}
    {meters.map((meter) => <div className="usage-meter" key={meter.label}>
      <div>
        <strong>{meter.label}</strong>
        <span>{Math.round(meter.percent)}%</span>
      </div>
      <div className="usage-bar" role="img" aria-label={t("mobile.status.meterUsed", { label: meter.label, percent: Math.round(meter.percent) })}>
        <span style={{ width: `${meter.percent}%` }} />
      </div>
      {meter.resets && <small>{resetText(meter.resets, clock, new Date(readAt))}</small>}
    </div>)}
    {row.limits && meters.length > 0 && <small>
      {t("cliOverview.asOf", { time: new Intl.DateTimeFormat(dateLocale(lang), { hour: "numeric", minute: "2-digit" }).format(new Date(row.limits.readAt * 1000)) })}
    </small>}
    {row.signedIn && meters.length === 0 && <small>
      {row.usage?.code ? t("cliOverview.usageFailed") : t("cliOverview.noUsage")}
    </small>}
  </li>;
}

function CliOverviewSheet({ overview, failure, busy, onRefresh, onClose }: {
  overview: Overview | null;
  failure: string | null;
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useBackLayer(onClose);
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet cli-overview-sheet" role="dialog" aria-modal="true" aria-label={t("cliOverview.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.gitSheet.done")}>✕</button>
        <h2>{t("cliOverview.title")}{isUntested("mobile.clis") && <small>{t("mobile.newTab.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {failure && <p className="sheet-note error" role="alert">{t("cliOverview.failed")}</p>}
      {!overview && !failure && <p className="sheet-note" role="status">{t("pdfMeta.reading")}</p>}
      {overview && overview.clis.length === 0 && <p className="sheet-note">{t("cliOverview.empty")}</p>}
      {overview && !overview.desktopAvailable && overview.clis.some((row) => row.id === "claude") &&
        <p className="sheet-note">{t("mobile.clis.noWindow")}</p>}
      {overview && overview.clis.length > 0 && <ul className="cli-overview-list">
        {overview.clis.map((row) => <CliCard key={row.id} row={row} readAt={overview.readAt} t={t} />)}
      </ul>}
      <div className="mobile-schedule-actions">
        <button disabled={busy} onClick={onRefresh}>{t(busy ? "pdfMeta.reading" : "common.refresh")}</button>
        <button className="primary" onClick={onClose}>{t("mobile.gitSheet.done")}</button>
      </div>
    </section>
  </div>;
}

/**
 * Home → Agent CLIs: one row saying how many CLIs are signed in and the
 * fullest window, opening a sheet with each CLI's plan and usage bars — the
 * desktop's side panel CLIs view, without the account
 * (`docs/cli_overview_plan.md`). Read when Home shows and again when the page
 * comes back into view; the sheet's Refresh asks the desktop to re-read.
 */
export function CliOverviewSection() {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const reading = useRef<AbortController | null>(null);

  const read = useCallback((refresh: boolean) => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setBusy(true);
    getCliOverview(refresh, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setOverview({ clis: next.clis ?? [], desktopAvailable: next.desktop_available, readAt: Date.now() });
        setFailure(null);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        // A 404 is a sidecar older than the route: no feature, no row.
        if (reason instanceof ApiError && reason.status === 404) setHidden(true);
        setFailure(codeOf(reason));
      },
    ).finally(() => { if (!controller.signal.aborted) setBusy(false); });
  }, []);

  useEffect(() => {
    read(false);
    const onVisible = () => { if (document.visibilityState === "visible") read(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      reading.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read]);

  if (hidden) return null;
  return <>
    <section className="phone-settings local-models-home" aria-labelledby="cli-overview-heading">
      <h2 id="cli-overview-heading">{t("cliOverview.tab")}</h2>
      <ul className="option-list">
        <li><button aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <span><strong>{t("mobile.clis.row")}{isUntested("mobile.clis") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{caption(overview, failure, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button></li>
      </ul>
    </section>
    {open && <CliOverviewSheet overview={overview} failure={failure} busy={busy} onRefresh={() => read(true)} onClose={() => setOpen(false)} />}
  </>;
}

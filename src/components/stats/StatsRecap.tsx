import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";

import { APP_TIMER_ID } from "../../stores/timer";
import { ROOT_SCOPE, useUsageStore, type GitStats } from "../../stores/usage";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { METRIC, agentLabel } from "../../lib/usageMetrics";
import {
  breakdown,
  dayKey,
  periodKeys,
  sumCounters,
  totalOf,
  type Counters,
  type Period,
} from "../../lib/usageRollup";
import { formatBytes, type ByteCounts, type NetUsageReport } from "../monitoring/NetworkTrafficPane";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { useT, type TranslationKey } from "../../lib/i18n";
import {
  fetchTokenReport,
  foldTokens,
  formatShare,
  formatTokens,
  grandTotal,
  outputShare,
  splitSum,
  usedAgentClis,
  type TokenReport,
  type TokenRows,
  type TokenSplit,
} from "../../lib/tokenStats";

/** Human duration, matching the header timer's phrasing. */
function formatTime(secs: number): string {
  if (secs < 60) return secs > 0 ? "< 1m" : "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const PERIOD_LABEL_KEYS: Record<Period, TranslationKey> = {
  day: "stats.periodDay",
  week: "stats.periodWeek",
  month: "stats.periodMonth",
};
const PERIODS: Period[] = ["day", "week", "month"];

const DAY_MS = 86_400_000;

/** One headline number. */
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stats-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/** A labelled bar in a breakdown list, sized against the largest row. */
function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="stats-bar-row">
      <span className="stats-bar-label" title={label}>{label}</span>
      <span className="stats-bar-track">
        <span className="stats-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="stats-bar-value">{suffix ?? value}</span>
    </div>
  );
}

/**
 * Per-hour sparkline over a day's 24 UTC hour buckets — hand-rolled SVG, like
 * every other graph in Tabtivity (there is no chart dependency, and this is not the
 * place to add one). Only meaningful for the Day period.
 */
function HourSparkline({
  hours,
  anchorMs,
  t,
}: {
  hours: Record<string, Counters>;
  anchorMs: number;
  t: ReturnType<typeof useT>;
}) {
  const date = dayKey(anchorMs);
  const values = Array.from({ length: 24 }, (_, h) => {
    const bucket = hours[`${date}T${String(h).padStart(2, "0")}`] ?? {};
    // "Activity" here is everything the user did that hour, agent and shell alike.
    return (
      totalOf(breakdown(bucket, METRIC.AGENT_PROMPT)) + (bucket[METRIC.SHELL_COMMAND] ?? 0)
    );
  });
  const max = Math.max(1, ...values);
  const busiest = values.indexOf(Math.max(...values));
  const width = 600;
  const height = 60;
  const barW = width / 24;

  if (max <= 1 && values.every((v) => v === 0)) return null;

  return (
    <div className="stats-spark-wrap">
      <svg
        className="stats-spark"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("stats.sparklineAriaLabel")}
      >
        {values.map((v, h) => (
          <rect
            key={h}
            x={h * barW + 1}
            y={height - (v / max) * height}
            width={barW - 2}
            height={(v / max) * height}
            className={h === busiest ? "stats-spark-bar busiest" : "stats-spark-bar"}
          />
        ))}
      </svg>
      <div className="stats-spark-legend">
        <span>{t("stats.busiestHour", { hour: String(busiest).padStart(2, "0") })}</span>
        <span className="stats-spark-scale">{t("stats.peak", { value: max })}</span>
      </div>
    </div>
  );
}

/** One CLI's or model's split, as the line under its bar: fresh in · cache
 *  write · cache read · output · output share, or the unsplit total. */
function splitText(s: TokenSplit, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (splitSum(s) > 0 || s.total === 0) {
    parts.push(
      t("stats.tokensFresh", { count: formatTokens(s.fresh) }),
      t("stats.tokensCacheWrite", { count: formatTokens(s.cacheWrite) }),
      t("stats.tokensCacheRead", { count: formatTokens(s.cacheRead) }),
      t("stats.tokensOutput", { count: formatTokens(s.output) }),
    );
    const share = outputShare(s);
    if (share !== null) parts.push(t("stats.tokensOutputShare", { share: formatShare(share) }));
  }
  if (s.total > 0) {
    parts.push(
      t(splitSum(s) > 0 ? "stats.tokensUnsplitExtra" : "stats.tokensNoSplit", {
        count: formatTokens(s.total),
      }),
    );
  }
  return parts.join(" · ");
}

/**
 * The Tokens section: one bar per CLI over the period's tokens, the split on
 * the line beneath, per-model rows behind a toggle. Numbers come from the CLIs'
 * own records (`usage_token_stats`); a CLI Tabtivity cannot read is named as not
 * reported rather than shown as zero.
 */
function TokensSection({
  rows,
  sources,
  loading,
  counting,
  partial,
  failed,
  t,
}: {
  rows: TokenRows | null;
  sources: string[];
  loading: boolean;
  counting: boolean;
  partial: boolean;
  failed: boolean;
  t: ReturnType<typeof useT>;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (cli: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(cli)) next.delete(cli);
      else next.add(cli);
      return next;
    });

  const reported = rows?.reported ?? [];
  const notReported = rows?.notReported ?? [];
  const max = Math.max(0, ...reported.map((r) => grandTotal(r.split)));

  return (
    <>
      <div className="settings-section-title">
        {t("stats.sectionTokens")} <UntestedTag id="stats.sectionTokens" />
      </div>
      {failed ? (
        <p className="settings-help">{t("stats.tokensUnavailable")}</p>
      ) : (
        <>
          {(loading || counting) && <p className="settings-help">{t("stats.tokensCounting")}</p>}
          {partial && !counting && <p className="settings-help">{t("stats.tokensPartial")}</p>}
          {reported.length > 0 && (
            <div className="stats-bars">
              {reported.map((row) => {
                const total = grandTotal(row.split);
                const expanded = open.has(row.cli);
                const modelMax = Math.max(0, ...row.models.map((m) => grandTotal(m.split)));
                return (
                  <Fragment key={row.cli}>
                    <Bar label={agentLabel(row.cli)} value={total} max={max} suffix={formatTokens(total)} />
                    <p className="settings-help stats-token-split">
                      <span>{splitText(row.split, t)}</span>
                      {row.models.length > 0 && (
                        <button
                          type="button"
                          className="inline-link-btn"
                          aria-expanded={expanded}
                          onClick={() => toggle(row.cli)}
                        >
                          {t("stats.tokensPerModel")}
                        </button>
                      )}
                    </p>
                    {expanded && (
                      <div className="stats-bars stats-token-models">
                        {row.models.map((m) => {
                          const mTotal = grandTotal(m.split);
                          return (
                            <Fragment key={m.model}>
                              <Bar label={m.model} value={mTotal} max={modelMax} suffix={formatTokens(mTotal)} />
                              <p className="settings-help stats-token-split">
                                <span>{splitText(m.split, t)}</span>
                              </p>
                            </Fragment>
                          );
                        })}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          )}
          {!loading && reported.length === 0 && notReported.length === 0 && (
            <p className="settings-help">{t("stats.tokensNone")}</p>
          )}
          {notReported.length > 0 && (
            <p className="settings-help">
              {t("stats.tokensNotReported", {
                clis: notReported.map(agentLabel).join(", "),
                sources: sources.map(agentLabel).join(", "),
              })}
            </p>
          )}
          <p className="settings-help">{t("stats.tokensFootnote")}</p>
        </>
      )}
    </>
  );
}

interface Props {
  onClose: () => void;
  /** Which day the recap opens on. The startup recap anchors on yesterday — the
   *  day that actually finished; opened from Settings it anchors on today. */
  initialAnchorMs: number;
  /** Shown only when the recap opened by itself, since it is the thing that
   *  turns that off. */
  showAutoToggle: boolean;
}

export function StatsRecap({ onClose, initialAnchorMs, showAutoToggle }: Props) {
  const t = useT();
  const [period, setPeriod] = useState<Period>("day");
  const [anchorMs] = useState(initialAnchorMs);
  const [timeByDay, setTimeByDay] = useState<Record<string, Record<string, number>>>({});
  const [net, setNet] = useState<NetUsageReport>({ hours: {}, days: {} });
  const [git, setGit] = useState<GitStats | null>(null);
  const [tokens, setTokens] = useState<TokenReport | null>(null);
  const [tokensCounting, setTokensCounting] = useState(false);
  const [tokensFailed, setTokensFailed] = useState(false);

  const report = useUsageStore((s) => s.report);
  const loadUsage = useUsageStore((s) => s.load);
  const projects = useProjectsStore((s) => s.projects);
  const autoOn = useSettingsStore((s) => s.settings?.daily_stats_recap ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  useEffect(() => {
    void loadUsage();
    void invoke<Record<string, Record<string, number>>>("get_time_activity_all")
      .then(setTimeByDay)
      .catch(() => setTimeByDay({}));
    void invoke<NetUsageReport>("get_net_usage", { projectId: "" })
      .then(setNet)
      .catch(() => setNet({ hours: {}, days: {} }));
  }, [loadUsage]);

  // Tokens are derived from the CLIs' records by a budgeted backend scan. The
  // first scan of a long history comes back `partial`, so it is asked again a
  // few times (bounded in `fetchTokenReport`) — never polled after that. The
  // recap is a global view, like `usage_summary`: summed across every scope.
  useEffect(() => {
    let cancelled = false;
    void fetchTokenReport(
      () => invoke<TokenReport>("usage_token_stats", { projectId: "" }),
      (r, more) => {
        setTokens(r);
        setTokensCounting(more);
      },
      { isCancelled: () => cancelled },
    ).catch(() => {
      if (cancelled) return;
      setTokensFailed(true);
      setTokensCounting(false);
    });
    return () => { cancelled = true; };
  }, []);

  const keys = useMemo(() => periodKeys(period, anchorMs), [period, anchorMs]);

  // Git is derived on demand (never stored), so it is re-read whenever the window
  // moves. `since` is the first day of the period; a remote project reports zero
  // rather than stalling the dialog on an unreachable host.
  useEffect(() => {
    const since = keys[0];
    const dirs = projects.map((p) => p.directory).filter((d): d is string => !!d);
    let cancelled = false;
    void Promise.all(
      dirs.map((dir) =>
        invoke<GitStats>("usage_git_stats", { projectDir: dir, since }).catch(
          () => null,
        ),
      ),
    ).then((all) => {
      if (cancelled) return;
      setGit(
        all.filter((g): g is GitStats => !!g).reduce(
          (acc, g) => ({
            commits: acc.commits + g.commits,
            filesChanged: acc.filesChanged + g.filesChanged,
            linesAdded: acc.linesAdded + g.linesAdded,
            linesRemoved: acc.linesRemoved + g.linesRemoved,
          }),
          { commits: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
        ),
      );
    });
    return () => { cancelled = true; };
  }, [keys, projects]);

  // ── The numbers ─────────────────────────────────────────────────────────
  const counters: Counters = useMemo(() => {
    const acc: Counters = {};
    for (const key of keys) {
      for (const [metric, n] of Object.entries(report?.days?.[key] ?? {})) {
        acc[metric] = (acc[metric] ?? 0) + n;
      }
    }
    return acc;
  }, [report, keys]);

  // `agent.tab` must not swallow `agent.tab.local.*` — a local model is its own
  // namespace, and folding it here would count every local tab twice.
  const tabsByAgent = breakdown(counters, METRIC.AGENT_TAB, [METRIC.AGENT_TAB_LOCAL]);
  const localTabs = breakdown(counters, METRIC.AGENT_TAB_LOCAL);
  const activeByAgent = breakdown(counters, METRIC.AGENT_ACTIVE);
  const promptsByAgent = breakdown(counters, METRIC.AGENT_PROMPT);

  const usedTabs = totalOf(activeByAgent);
  const prompts = totalOf(promptsByAgent);
  const openedTabs = totalOf(tabsByAgent) + totalOf(localTabs);

  // The per-model view merges cloud agents and local models into one ranking —
  // "which models did I work with" is one question, not two.
  const byModel: Record<string, number> = {};
  for (const [leaf, n] of Object.entries(activeByAgent)) {
    byModel[agentLabel(leaf)] = (byModel[agentLabel(leaf)] ?? 0) + n;
  }

  // Time per project, over the same window.
  const secsByProject: Record<string, number> = {};
  for (const key of keys) {
    for (const [pid, secs] of Object.entries(timeByDay[key] ?? {})) {
      // The app's own total is tracked under a pseudo-project; it is the whole
      // session, not a project, so it must not appear as one in the ranking.
      if (pid === APP_TIMER_ID) continue;
      secsByProject[pid] = (secsByProject[pid] ?? 0) + secs;
    }
  }
  const appSecs = keys.reduce((sum, k) => sum + (timeByDay[k]?.[APP_TIMER_ID] ?? 0), 0);
  const projectName = (id: string) =>
    id === ROOT_SCOPE ? t("stats.rootTerminal") : projects.find((p) => p.id === id)?.name ?? id;
  const rankedProjects = Object.entries(secsByProject)
    .filter(([, secs]) => secs > 0)
    .sort((a, b) => b[1] - a[1]);

  const bytes: ByteCounts = keys.reduce<ByteCounts>(
    (acc, key) => {
      const c = net.days?.[key];
      return { rx: acc.rx + (c?.rx ?? 0), tx: acc.tx + (c?.tx ?? 0) };
    },
    { rx: 0, tx: 0 },
  );

  const created = counters[METRIC.FILE_CREATED] ?? 0;
  const modified = counters[METRIC.FILE_MODIFIED] ?? 0;
  const deleted = counters[METRIC.FILE_DELETED] ?? 0;
  const shellCommands = counters[METRIC.SHELL_COMMAND] ?? 0;
  const workedS = counters[METRIC.AGENT_WORKED_S] ?? 0;
  const decisions = counters[METRIC.AGENT_DECISION] ?? 0;

  const autocomplete = new Map<string, { accepted: number; dismissed: number }>();
  for (const [key, count] of Object.entries(counters)) {
    for (const [prefix, outcome] of [[METRIC.AUTOCOMPLETE_ACCEPT, "accepted"], [METRIC.AUTOCOMPLETE_DISMISS, "dismissed"]] as const) {
      if (!key.startsWith(prefix + ".")) continue;
      const identity = key.slice(prefix.length + 1);
      const row = autocomplete.get(identity) ?? { accepted: 0, dismissed: 0 };
      row[outcome] += count;
      autocomplete.set(identity, row);
    }
  }

  // The same window as every other number in the dialog.
  const tokenRows: TokenRows | null = useMemo(
    () =>
      tokens
        ? foldTokens(sumCounters(tokens.days, keys), tokens.sources, usedAgentClis(counters))
        : null,
    [tokens, keys, counters],
  );

  const label =
    period === "day" ? dayLabel(anchorMs, t) : period === "week" ? t("stats.thisWeek") : t("stats.thisMonth");
  const empty =
    openedTabs + prompts + shellCommands + created + modified + deleted === 0 &&
    autocomplete.size === 0 &&
    !tokenRows?.reported.length;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="stats-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("stats.title")}</h2>
          <div className="stats-period-switch" role="group" aria-label={t("stats.periodGroupLabel")}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={period === p ? "stats-period-btn active" : "stats-period-btn"}
                onClick={() => setPeriod(p)}
              >
                {t(PERIOD_LABEL_KEYS[p])}
              </button>
            ))}
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="dialog-scroll">
        <p className="settings-help stats-window-label">{label}</p>

        {empty ? (
          <p className="stats-empty">{t("stats.emptyState")}</p>
        ) : (
          <>
            {/* ── Agents ───────────────────────────────────────────────── */}
            <div className="settings-section-title">{t("stats.sectionAgents")}</div>
            <p className="stats-headline">
              {t("stats.headlinePre")}
              <strong>
                {t(usedTabs === 1 ? "stats.usedTabsOne" : "stats.usedTabsMany", { count: usedTabs })}
              </strong>
              {t("stats.headlineMid")}
              <strong>
                {t(prompts === 1 ? "stats.promptsOne" : "stats.promptsMany", { count: prompts })}
              </strong>
              {t("stats.headlinePost")}
            </p>
            {Object.keys(byModel).length > 0 && (
              <div className="stats-bars">
                {Object.entries(byModel)
                  .sort((a, b) => b[1] - a[1])
                  .map(([model, n]) => (
                    <Bar key={model} label={model} value={n} max={Math.max(...Object.values(byModel))} />
                  ))}
              </div>
            )}
            <div className="stats-metrics">
              <Metric label={t("stats.metricTabsOpened")} value={String(openedTabs)} />
              <Metric
                label={t("stats.metricAgentsWorking")}
                value={formatTime(workedS)}
                sub={t("stats.metricSummedAcrossTabs")}
              />
              <Metric
                label={t("stats.metricStoppedToAsk")}
                value={String(decisions)}
                sub={t(decisions === 1 ? "stats.timeOne" : "stats.timeMany")}
              />
            </div>

            {/* ── Tokens ───────────────────────────────────────────────── */}
            <TokensSection
              rows={tokenRows}
              sources={tokens?.sources ?? []}
              loading={!tokens && !tokensFailed}
              counting={tokensCounting}
              partial={!!tokens?.partial}
              failed={tokensFailed}
              t={t}
            />

            {/* ── Work per project ─────────────────────────────────────── */}
            <div className="settings-section-title">{t("stats.sectionWork")}</div>
            {rankedProjects.length > 0 ? (
              <div className="stats-bars">
                {rankedProjects.map(([pid, secs]) => (
                  <Bar
                    key={pid}
                    label={projectName(pid)}
                    value={secs}
                    max={rankedProjects[0][1]}
                    suffix={formatTime(secs)}
                  />
                ))}
              </div>
            ) : (
              <p className="settings-help">{t("stats.noTrackedTime")}</p>
            )}
            <div className="stats-metrics">
              <Metric label={t("stats.metricAppOpen")} value={formatTime(appSecs)} />
              <Metric
                label={t("stats.metricCommandsRun")}
                value={String(shellCommands)}
                sub={t("stats.metricInShellTabs")}
              />
              <Metric
                label={t("stats.metricNetwork")}
                value={`↓ ${formatBytes(bytes.rx)}`}
                sub={`↑ ${formatBytes(bytes.tx)}`}
              />
            </div>

            {autocomplete.size > 0 && <div className="stats-metrics">
              {[...autocomplete].map(([identity, counts]) => {
                const dot = identity.indexOf(".");
                const mode = identity.slice(0, dot);
                const modeLabel = mode === "copilot" ? t("settings.copilotProviderCopilot") : mode === "scope" ? t("projectSettings.scope") : mode === "block" ? t("projectSettings.block") : t("projectSettings.sentence");
                return <Metric key={identity}
                  label={t("stats.autocomplete", { mode: modeLabel, model: identity.slice(dot + 1) })}
                  value={t("stats.autocompleteOutcomes", counts)} />;
              })}
            </div>}

            {/* ── Files ────────────────────────────────────────────────── */}
            <div className="settings-section-title">{t("stats.sectionFiles")}</div>
            <div className="stats-metrics">
              <Metric label={t("fileTree.tooltipCreated")} value={String(created)} />
              <Metric label={t("fileTree.tooltipModified")} value={String(modified)} />
              <Metric label={t("stats.metricDeleted")} value={String(deleted)} />
              {git && (
                <Metric
                  label={t("stats.metricCommitted")}
                  value={t(git.commits === 1 ? "stats.commitOne" : "stats.commitMany", { count: git.commits })}
                  sub={`+${git.linesAdded} −${git.linesRemoved}`}
                />
              )}
            </div>
            <p className="settings-help">{t("stats.fileFootnote")}</p>

            {/* ── Rhythm ───────────────────────────────────────────────── */}
            {period === "day" && report?.hours && (
              <>
                <div className="settings-section-title">{t("stats.sectionRhythm")}</div>
                <HourSparkline hours={report.hours} anchorMs={anchorMs} t={t} />
              </>
            )}
          </>
        )}

        {showAutoToggle && (
          <label className="settings-switch-row stats-auto-row">
            <span>{t("stats.autoToggleLabel")}</span>
            <Toggle
              checked={autoOn}
              onChange={(e) => void updateSettings({ daily_stats_recap: e.target.checked })}
            />
          </label>
        )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "Yesterday" / "Today" / the date, for the Day window's caption. */
function dayLabel(anchorMs: number, t: ReturnType<typeof useT>): string {
  const today = dayKey(Date.now());
  const anchor = dayKey(anchorMs);
  if (anchor === today) return t("stats.today");
  if (anchor === dayKey(Date.now() - DAY_MS)) return t("stats.yesterday");
  return anchor;
}

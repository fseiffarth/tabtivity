import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../common/Dropdown";
import { isoWeekKeys, summarizeBuckets } from "../../lib/usageRollup";
import { formatBytes } from "../../lib/formatBytes";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { isCarefulHost, primaryTargetOf } from "../../lib/remote/carefulHost";
import { isHpcHost } from "../../lib/remote/hpc/hpcHost";
import { useT } from "../../lib/i18n";

export interface NetworkInterfaceSnapshot {
  name: string;
  rxBytes: number;
  txBytes: number;
  up: boolean;
  loopback: boolean;
}

export interface NetworkConnectionSnapshot {
  protocol: string;
  state: string;
  localAddress: string;
  localPort: string;
  remoteAddress: string;
  remotePort: string;
  pid?: number;
  process?: string;
}

export interface NetworkHostSnapshot {
  supported: boolean;
  remote: boolean;
  connected: boolean;
  sampledAtMs: number;
  hostLabel: string;
  interfaces: NetworkInterfaceSnapshot[];
  connections?: NetworkConnectionSnapshot[];
  warning?: string;
}

export interface SshLinkSnapshot {
  supported: boolean;
  connected: boolean;
  sampledAtMs: number;
  connectionId?: string;
  rxBytes: number;
  txBytes: number;
  localEndpoint?: string;
  remoteEndpoint?: string;
  warning?: string;
}

export interface TrafficPoint {
  at: number;
  rxRate: number;
  txRate: number;
}

interface Props {
  /** Whose network this is, or `null` in the ROOT scope — the machine Tabtivity
   *  runs on, with no project behind it. A root tab therefore has no remote
   *  half at all: no host to be careful of, no SSH link, no per-project usage
   *  totals — exactly the shape a LOCAL project already renders. */
  projectId: string | null;
  visible: boolean;
  onConnect?: () => void;
}

interface CounterSample {
  id: string;
  at: number;
  rx: number;
  tx: number;
}

const HISTORY_POINTS = 300;
const CONNECTION_POLL_EVERY = 5;
/** The live cadence, for a local read and for an ordinary remote box. */
const LIVE_POLL_MS = 1000;
/** …and the cadence on a **careful** or HPC-tagged host, matching
 *  `SystemMonitorPane`'s `CAREFUL_POLL_MS` exactly — the same machine must not be
 *  read gently by one pane and hammered by another. On a remote project the host
 *  snapshot is a *shell exec on the host* (`commands::network`), so the old fixed
 *  1 s tick was one command per second against a login node for as long as the
 *  tab stayed open: precisely the "process causing load over a longer period" a
 *  cluster's rules reserve the right to kill. */
const CAREFUL_POLL_MS = 12_000;

export function rateFromSamples(
  previous: CounterSample | null,
  next: CounterSample,
): { rxRate: number; txRate: number; rxDelta: number; txDelta: number } {
  if (
    !previous ||
    previous.id !== next.id ||
    next.at <= previous.at ||
    next.rx < previous.rx ||
    next.tx < previous.tx
  ) {
    return { rxRate: 0, txRate: 0, rxDelta: 0, txDelta: 0 };
  }
  const seconds = (next.at - previous.at) / 1000;
  const rxDelta = next.rx - previous.rx;
  const txDelta = next.tx - previous.tx;
  return {
    rxRate: rxDelta / seconds,
    txRate: txDelta / seconds,
    rxDelta,
    txDelta,
  };
}

export function aggregateInterfaceCounters(
  interfaces: NetworkInterfaceSnapshot[],
  selected: string,
): { id: string; rx: number; tx: number } {
  const chosen =
    selected === "aggregate"
      ? interfaces.filter((iface) => iface.up && !iface.loopback)
      : interfaces.filter((iface) => iface.name === selected);
  return {
    id: selected,
    rx: chosen.reduce((sum, iface) => sum + iface.rxBytes, 0),
    tx: chosen.reduce((sum, iface) => sum + iface.txBytes, 0),
  };
}

export interface ByteCounts {
  rx: number;
  tx: number;
}

/** Bucket key ("YYYY-MM-DD" or "YYYY-MM-DDTHH", UTC) → bytes moved in it. */
export type ByteCountsByBucket = Record<string, ByteCounts>;

/** How many discrete files were downloaded/uploaded by the sync engine. */
export interface FileCounts {
  down: number;
  up: number;
}

/** Bucket key ("YYYY-MM-DD" or "YYYY-MM-DDTHH", UTC) → files synced in it. */
export type FileCountsByBucket = Record<string, FileCounts>;

/** Persisted per-project SSH-link usage, at the two granularities stored. */
export interface NetUsageReport {
  /** UTC hours ("YYYY-MM-DDTHH"); only the retained window (14 days). */
  hours: ByteCountsByBucket;
  /** UTC dates ("YYYY-MM-DD"); full history. */
  days: ByteCountsByBucket;
  /** UTC hours ("YYYY-MM-DDTHH"); files transferred, retained window. */
  fileHours?: FileCountsByBucket;
  /** UTC dates ("YYYY-MM-DD"); files transferred, full history. */
  fileDays?: FileCountsByBucket;
}

export interface NetUsageTotals {
  hour: ByteCounts;
  today: ByteCounts;
  week: ByteCounts;
  month: ByteCounts;
  overall: ByteCounts;
}

export interface NetUsageFileTotals {
  hour: FileCounts;
  today: FileCounts;
  week: FileCounts;
  month: FileCounts;
  overall: FileCounts;
}

// The bucket → calendar-window folding is shared with the usage recap, which
// reads a store of the same shape (`usage_stats.json`): same UTC keys, same
// ISO-week alignment, different payload. One implementation, in lib/usageRollup;
// re-exported here because this pane is where it has always been imported from.
export { isoWeekKeys };

/**
 * Fold the persisted usage maps into this-hour / today / this-week / this-month
 * / overall totals — [`summarizeBuckets`] specialised to byte counts.
 */
export function summarizeNetUsage(report: NetUsageReport, nowMs: number): NetUsageTotals {
  return summarizeBuckets<ByteCounts>(
    report,
    nowMs,
    () => ({ rx: 0, tx: 0 }),
    (into, counts) => {
      into.rx += counts?.rx ?? 0;
      into.tx += counts?.tx ?? 0;
    },
  );
}

/**
 * Fold the persisted file-count maps into this-hour / today / this-week /
 * this-month / overall totals — [`summarizeBuckets`] specialised to how many
 * files the sync engine downloaded/uploaded, mirroring [`summarizeNetUsage`].
 */
export function summarizeNetFileUsage(report: NetUsageReport, nowMs: number): NetUsageFileTotals {
  return summarizeBuckets<FileCounts>(
    { hours: report.fileHours, days: report.fileDays },
    nowMs,
    () => ({ down: 0, up: 0 }),
    (into, counts) => {
      into.down += counts?.down ?? 0;
      into.up += counts?.up ?? 0;
    },
  );
}

export function formatFileCount(value: number): string {
  return value.toLocaleString();
}

// Re-exported from the one canonical formatter (§9.1) — this pane used to keep
// its own KiB-labelled ladder, the only surface with binary unit names.
export { formatBytes };

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function endpoint(address: string, port: string): string {
  if (!port) return address;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${host}:${port}`;
}

function TrafficGraph({
  points,
  pollMs,
  t,
}: {
  points: TrafficPoint[];
  pollMs: number;
  t: ReturnType<typeof useT>;
}) {
  const width = 600;
  const height = 150;
  // How far back the graph actually reaches: a fixed point count at a cadence
  // that is no longer fixed. Stating "5 min" while a gently-polled host shows an
  // hour would be the kind of quiet mislabel a slower poll is easy to introduce.
  const spanMin = Math.max(1, Math.round((HISTORY_POINTS * pollMs) / 60000));
  const max = Math.max(1, ...points.flatMap((point) => [point.rxRate, point.txRate]));
  const path = (field: "rxRate" | "txRate") =>
    points
      .map((point, index) => {
        const x = points.length <= 1 ? width : (index / (HISTORY_POINTS - 1)) * width;
        const y = height - (point[field] / max) * (height - 12);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div className="network-graph-wrap">
      <div className="network-graph-scale">{t("network.graphPeak", { rate: formatRate(max) })}</div>
      <svg
        className="network-graph"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("network.graphAriaLabel", { span: spanMin })}
      >
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="network-grid-line" />
        {points.length > 1 && (
          <>
            <path d={path("rxRate")} className="network-line receive" />
            <path d={path("txRate")} className="network-line transmit" />
          </>
        )}
      </svg>
      <div className="network-graph-legend">
        <span className="receive">● {t("network.download")}</span>
        <span className="transmit">● {t("network.upload")}</span>
        <span className="network-history-label">{t("network.rollingMin", { span: spanMin })}</span>
      </div>
    </div>
  );
}

function StatusPanel({
  title,
  message,
  reconnect,
  t,
}: {
  title: string;
  message: string;
  reconnect?: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div className="network-status-panel">
      <div className="network-status-title">{title}</div>
      <div className="network-status-message">{message}</div>
      {reconnect && (
        <button className="btn-primary" onClick={reconnect}>
          {t("common.connect")}
        </button>
      )}
    </div>
  );
}

export function NetworkTrafficPane({ projectId, visible, onConnect }: Props) {
  const t = useT();
  const [view, setView] = useState<"host" | "link">("host");
  const [host, setHost] = useState<NetworkHostSnapshot | null>(null);
  const [link, setLink] = useState<SshLinkSnapshot | null>(null);
  const [connections, setConnections] = useState<NetworkConnectionSnapshot[]>([]);
  const [selectedInterface, setSelectedInterface] = useState("aggregate");
  const [history, setHistory] = useState<TrafficPoint[]>([]);
  const [sessionRx, setSessionRx] = useState(0);
  const [sessionTx, setSessionTx] = useState(0);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState<"ALL" | "TCP" | "UDP">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<NetUsageReport>({
    hours: {},
    days: {},
    fileHours: {},
    fileDays: {},
  });
  const previous = useRef<CounterSample | null>(null);

  // Whose network this is, and whether it may be read unasked. Two gates, both
  // about the same fact: on a remote project `network_host_snapshot` runs a
  // shell command *on the host*.
  //
  //  * **The lamp, read here.** The only connectivity check used to be
  //    `result.connected` — the answer to a request already made, so a project
  //    whose pool was down still dialled once a second to be told "not
  //    connected". The SSH state is known before the call; ask it first.
  //  * **The careful/HPC cadence.** Same constant, same reasoning as the system
  //    monitor: a shared login node is not to carry a sustained background load,
  //    and a network tab left open all afternoon at 1 s is exactly that.
  //
  // A local project keeps both as they were — there is no host to be careful of,
  // and the snapshot is a `/proc` read of this machine.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useSettingsStore((s) => s.settings);
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const isRemoteProject = !!project?.remote;
  const sshDown = isRemoteProject && sshState !== "connected";
  // The HPC tag outranks the Light/Detailed answer, exactly as `SystemMonitorPane`
  // has it: a machine the user called a cluster login node is read gently whatever
  // else is stored for it.
  const carefulHost =
    isRemoteProject &&
    (isHpcHost(settings, primaryTargetOf(project)) ||
      isCarefulHost(settings, primaryTargetOf(project)));
  // Only the **host** view costs the host anything. The SSH-link view is a local
  // `ss` read of this machine's own socket (`commands::network`'s
  // `linux_ssh_link`), so it keeps the live cadence on any machine.
  const pollMs = carefulHost && view === "host" ? CAREFUL_POLL_MS : LIVE_POLL_MS;

  useEffect(() => {
    previous.current = null;
    setHistory([]);
    setSessionRx(0);
    setSessionTx(0);
  }, [view, selectedInterface, projectId]);

  // What the backend commands are asked about. A root tab names no project, and
  // an id no project carries is exactly what `remote::remote_target_for` finds
  // no host for — so the snapshot is the `/proc` read of this machine, the same
  // answer a local project gets. Root never reaches the link view (its buttons
  // render only for a remote project), so this id is only ever the host view's.
  const snapshotId = projectId ?? "";

  useEffect(() => {
    // A disconnected remote project samples nothing at all — see `sshDown`.
    if (!visible || sshDown) return;
    // A hidden tab does not sample. Start with a fresh baseline when it becomes
    // visible again so bytes transferred while hidden are not folded into the
    // first visible rate/session-total point.
    previous.current = null;
    let cancelled = false;
    let inFlight = false;
    let tick = 0;

    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        let counterSample: CounterSample | null = null;
        if (view === "link") {
          const result = await invoke<SshLinkSnapshot>("network_ssh_link_snapshot", {
            projectId: snapshotId,
          });
          if (cancelled) return;
          setLink(result);
          if (result.supported && result.connected) {
            counterSample = {
              id: result.connectionId ?? "connected",
              at: result.sampledAtMs,
              rx: result.rxBytes,
              tx: result.txBytes,
            };
          } else {
            previous.current = null;
          }
        } else {
          const includeConnections = tick % CONNECTION_POLL_EVERY === 0;
          tick += 1;
          const result = await invoke<NetworkHostSnapshot>("network_host_snapshot", {
            projectId: snapshotId,
            includeConnections,
          });
          if (cancelled) return;
          setHost(result);
          if (result.connections) setConnections(result.connections);
          if (result.supported && result.connected) {
            const counters = aggregateInterfaceCounters(result.interfaces, selectedInterface);
            counterSample = {
              id: counters.id,
              at: result.sampledAtMs,
              rx: counters.rx,
              tx: counters.tx,
            };
          } else {
            previous.current = null;
          }
        }
        setError(null);
        if (counterSample) {
          const rate = rateFromSamples(previous.current, counterSample);
          previous.current = counterSample;
          setHistory((current) => [
            ...current.slice(-(HISTORY_POINTS - 1)),
            { at: counterSample.at, rxRate: rate.rxRate, txRate: rate.txRate },
          ]);
          setSessionRx((value) => value + rate.rxDelta);
          setSessionTx((value) => value + rate.txDelta);
        }
      } catch (reason) {
        previous.current = null;
        if (!cancelled) setError(String(reason));
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [snapshotId, selectedInterface, view, visible, sshDown, pollMs]);

  // Persisted per-project SSH-link usage (accrued in the background by
  // `services::net_usage`), refreshed slowly since it changes at most every
  // ~30 s. Independent of the 1 s live poll and of the host/link view. Root asks
  // nothing: it has no link to have moved bytes over, and the empty id this
  // command takes means *every* project's totals (the recap's reading), which is
  // not what a machine-wide tab would be showing.
  useEffect(() => {
    if (!visible || !projectId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await invoke<NetUsageReport>("get_net_usage", { projectId });
        if (!cancelled) {
          setUsage({
            hours: data?.hours ?? {},
            days: data?.days ?? {},
            fileHours: data?.fileHours ?? {},
            fileDays: data?.fileDays ?? {},
          });
        }
      } catch {
        // Leave the last-known totals in place on a transient failure.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, visible]);

  const current = history[history.length - 1] ?? { rxRate: 0, txRate: 0 };
  // The project's own record, not the last snapshot's: with the poll gated on the
  // lamp a disconnected remote project has no snapshot to read remoteness from,
  // and it must still offer its Remote-host / SSH-link tabs.
  const remote = isRemoteProject || (host?.remote ?? false);
  const usageTotals = useMemo(() => summarizeNetUsage(usage, Date.now()), [usage]);
  const fileTotals = useMemo(() => summarizeNetFileUsage(usage, Date.now()), [usage]);
  const warning = view === "link" ? link?.warning : host?.warning;
  // "Disconnected" is now something the pane knows rather than something it is
  // told: nothing was polled, so neither snapshot can report it.
  const available = sshDown
    ? false
    : view === "link"
      ? link?.supported !== false && link?.connected !== false
      : host?.supported !== false && host?.connected !== false;

  const filteredConnections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connections.filter((connection) => {
      if (protocol !== "ALL" && connection.protocol !== protocol) return false;
      if (!needle) return true;
      return [
        connection.protocol,
        connection.state,
        connection.localAddress,
        connection.localPort,
        connection.remoteAddress,
        connection.remotePort,
        connection.process ?? "",
        connection.pid?.toString() ?? "",
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [connections, protocol, query]);

  if (error && !host && !link) {
    return <StatusPanel title={t("network.unavailableTitle")} message={error} t={t} />;
  }

  if (!available) {
    const connected = sshDown ? false : view === "link" ? link?.connected : host?.connected;
    return (
      <div className="network-pane">
        {remote && (
          <div className="network-view-tabs">
            <button className={view === "host" ? "active" : ""} onClick={() => setView("host")}>
              {t("network.remoteHostTab")}
            </button>
            <button className={view === "link" ? "active" : ""} onClick={() => setView("link")}>
              {t("network.sshLinkTab")}
            </button>
          </div>
        )}
        <StatusPanel
          title={connected === false ? t("network.disconnectedTitle") : t("network.unsupportedTitle")}
          message={warning ?? error ?? t("network.unavailableMessage")}
          reconnect={connected === false ? onConnect : undefined}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className="network-pane">
      <div className="network-toolbar">
        <div>
          <div className="network-heading">{t("network.heading")}</div>
          <div className="network-subheading">
            {view === "link"
              ? `${link?.localEndpoint ?? t("network.localFallback")} ⇄ ${link?.remoteEndpoint ?? host?.hostLabel ?? t("network.sshHostFallback")}`
              : host?.hostLabel ?? t("network.localHost")}
          </div>
        </div>
        {remote && (
          <div className="network-view-tabs">
            <button className={view === "host" ? "active" : ""} onClick={() => setView("host")}>
              {t("network.remoteHostTab")}
            </button>
            <button className={view === "link" ? "active" : ""} onClick={() => setView("link")}>
              {t("network.sshLinkTab")}
            </button>
          </div>
        )}
        {view === "host" && (
          <label className="network-interface-select">
            {t("network.interfaceLabel")}
            <Dropdown
              value={selectedInterface}
              onChange={setSelectedInterface}
              options={[
                { value: "aggregate", label: t("network.activeNonLoopback") },
                ...(host?.interfaces ?? []).map((iface) => ({
                  value: iface.name,
                  label: `${iface.name}${!iface.up ? t("network.downSuffix") : ""}`,
                })),
              ]}
            />
          </label>
        )}
      </div>

      <div className="network-metrics">
        <div className="network-metric receive">
          <span>{t("network.download")}</span>
          <strong>{formatRate(current.rxRate)}</strong>
          <small>{formatBytes(sessionRx)} {t("network.thisView")}</small>
        </div>
        <div className="network-metric transmit">
          <span>{t("network.upload")}</span>
          <strong>{formatRate(current.txRate)}</strong>
          <small>{formatBytes(sessionTx)} {t("network.thisView")}</small>
        </div>
      </div>

      {remote && (
        <div className="network-usage-totals">
          <span className="network-usage-label">{t("network.sshLinkUsage")}</span>
          {(
            [
              [t("network.thisHour"), usageTotals.hour],
              [t("stats.today"), usageTotals.today],
              [t("stats.thisWeek"), usageTotals.week],
              [t("stats.thisMonth"), usageTotals.month],
              [t("network.overall"), usageTotals.overall],
            ] as const
          ).map(([label, counts]) => (
            <span key={label} className="network-usage-stat">
              {label} <span className="rx">↓ {formatBytes(counts.rx)}</span>{" "}
              <span className="tx">↑ {formatBytes(counts.tx)}</span>
            </span>
          ))}
        </div>
      )}

      {remote && (
        <div className="network-usage-totals">
          <span className="network-usage-label">{t("network.filesSynced")}</span>
          {(
            [
              [t("network.thisHour"), fileTotals.hour],
              [t("stats.today"), fileTotals.today],
              [t("stats.thisWeek"), fileTotals.week],
              [t("stats.thisMonth"), fileTotals.month],
              [t("network.overall"), fileTotals.overall],
            ] as const
          ).map(([label, counts]) => (
            <span key={label} className="network-usage-stat">
              {label} <span className="rx">↓ {formatFileCount(counts.down)}</span>{" "}
              <span className="tx">↑ {formatFileCount(counts.up)}</span>
            </span>
          ))}
        </div>
      )}

      <TrafficGraph points={history} pollMs={pollMs} t={t} />

      {warning && <div className="network-warning">{warning}</div>}
      {error && <div className="network-warning">{error}</div>}

      {view === "host" && (
        <section className="network-connections">
          <div className="network-connections-head">
            <div>
              <h3>{t("network.connections")}</h3>
              <span>{t("network.visibleCount", { count: filteredConnections.length })}</span>
            </div>
            <div className="network-connection-filters">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("network.searchPlaceholder")}
                aria-label={t("network.searchAriaLabel")}
              />
              <Dropdown
                value={protocol}
                title={t("network.filterProtocolTitle")}
                onChange={(v) => setProtocol(v as "ALL" | "TCP" | "UDP")}
                options={[
                  { value: "ALL", label: t("network.protocolBoth") },
                  { value: "TCP", label: "TCP" },
                  { value: "UDP", label: "UDP" },
                ]}
              />
            </div>
          </div>
          <div className="network-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("network.colProtocol")}</th>
                  <th>{t("network.colState")}</th>
                  <th>{t("network.colLocal")}</th>
                  <th>{t("network.colRemote")}</th>
                  <th>{t("network.colProcess")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredConnections.map((connection, index) => (
                  <tr
                    key={`${connection.protocol}/${connection.localAddress}/${connection.localPort}/${connection.remoteAddress}/${connection.remotePort}/${connection.pid ?? "x"}/${index}`}
                  >
                    <td>{connection.protocol}</td>
                    <td>{connection.state}</td>
                    <td>{endpoint(connection.localAddress, connection.localPort)}</td>
                    <td>{endpoint(connection.remoteAddress, connection.remotePort)}</td>
                    <td>
                      {connection.process ?? "—"}
                      {connection.pid != null ? ` · ${connection.pid}` : ""}
                    </td>
                  </tr>
                ))}
                {filteredConnections.length === 0 && (
                  <tr>
                    <td colSpan={5} className="network-empty-row">
                      {t("network.noMatchingConnections")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="network-table-note">{t("network.hostWideNote")}</div>
        </section>
      )}
      {view === "link" && <div className="network-link-note">{t("network.linkNote")}</div>}
    </div>
  );
}

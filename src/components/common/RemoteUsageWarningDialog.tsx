import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import {
  machineKey,
  projectHostKey,
  useRemoteUsageStore,
  type RemoteUsageReport,
  type UsageTarget,
} from "../../stores/remote/remoteUsage";
import { hostsForProject } from "../../lib/remote/remoteHosts";
import { sameTarget } from "../../lib/remote/machineSync";
import { PRIMARY_HOST, sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { isHpcHost } from "../../lib/remote/hpc/hpcHost";
import { useT, type TranslationKey } from "../../lib/i18n";

/**
 * Host usage — CPU/load, memory, GPU, logged-in sessions and top processes (see
 * `services::remote_usage` for the probe). It is **not** a verdict:
 * `report.busy`/`report.reasons` are surfaced as extra context (a "may be in
 * use" hint) but never gate anything. Note the one known false positive the hint
 * carries: a Tabtivity terminal tab already open to the same host shows up in
 * `who` exactly like a human login.
 *
 * **On demand only.** It used to pop up by itself after every connect, which
 * put a modal in front of a user who had just asked for something else. Now the
 * *only* thing that opens it is the header Machines menu's "Remote host usage…"
 * button (`useRemoteUsageStore.open`), and opening it rechecks every host it may
 * so what's on screen is current rather than however stale the last connect's
 * report had become.
 *
 * **"Every host it may" is the whole of the second gate.** Each probe is real
 * work on the machine — a global machine's is a fresh SSH login, a project
 * host's opens the pool — so a dialog that swept the entire list dialled every
 * machine anyone had ever added, every time it was opened. The sweep now covers
 * only hosts with a session actually open, and **never** a host tagged HPC
 * whatever its lamp says. Everything else renders from cache and carries its own
 * read button: that press is a gesture, which is the one thing a tagged cluster
 * login node answers to (and the only caller that may say `background: false`).
 *
 * **Its subject is the machine list, not a project.** It opens from the Machines
 * menu, so it shows a section for **every global machine, in that menu's exact
 * order** (`stores/remote/globalMachines`), then the active project's own hosts — the
 * primary and any `compute_hosts` worker — that aren't already in the list. The
 * two are matched by SSH target (`lib/remote/machineSync`'s `sameTarget`), never by id:
 * dropping a machine onto a project copies it by value, so `user@host:port` is
 * the only bridge, and without that dedupe one machine would appear twice.
 *
 * Mounted once at the shell, like `LocalLossDialog`. Advisory, not a record of
 * something already destroyed, so a backdrop click closes it same as any
 * ordinary modal.
 *
 * The connect-time probe still runs (the backend emits a `remote-usage-report`
 * event per project host after `remote_connect`) and this still listens for it
 * globally, so a just-connected project's report is already cached when the
 * button is pressed — but receiving one no longer shows anything.
 */

interface UsageReportEvent {
  projectId: string;
  hostId: string;
  report: RemoteUsageReport;
}

function fmtPct(used: number, total: number): string {
  if (total <= 0) return "?";
  return `${Math.round((used / total) * 100)}%`;
}

/**
 * Traffic-light tone for a CPU/GPU utilization percentage: green when the host
 * is effectively idle (≤5%), orange up to 40%, red above — so a glance at the
 * connect report says whether the machine is free to work on.
 */
type UsageTone = "green" | "orange" | "red";
function usageTone(pct: number): UsageTone {
  if (pct <= 5) return "green";
  if (pct <= 40) return "orange";
  return "red";
}

interface UserGroup {
  user: string;
  sessions: RemoteUsageReport["users"];
  /** Sum of this user's `ps` `%CPU`/`%MEM` across the top-processes sample — a
   *  login count says nothing about load (one idle `bash` vs. one `python`
   *  pinning a core both read as "1 session"), so this is compute, not session
   *  share. */
  cpuPct: number;
  memPct: number;
}

/** Collapse `who`'s per-session rows into one row per user, each carrying its
 *  summed CPU%/MEM% from `report.topProcs` instead of a session tally. Sorted
 *  by CPU%, busiest first — the point of the panel is spotting who's loading
 *  the host, not roll-call order. Only the top-N processes are sampled (same
 *  data the "Top processes" section shows), so a user's true total can be
 *  higher than what's attributed here if their load falls outside that
 *  sample. */
function groupSessionsByUser(report: RemoteUsageReport): UserGroup[] {
  const order: string[] = [];
  const byUser = new Map<string, RemoteUsageReport["users"]>();
  for (const s of report.users) {
    if (!byUser.has(s.user)) {
      order.push(s.user);
      byUser.set(s.user, []);
    }
    byUser.get(s.user)!.push(s);
  }
  const cpuByUser = new Map<string, number>();
  const memByUser = new Map<string, number>();
  for (const p of report.topProcs) {
    cpuByUser.set(p.user, (cpuByUser.get(p.user) ?? 0) + p.cpuPct);
    memByUser.set(p.user, (memByUser.get(p.user) ?? 0) + p.memPct);
  }
  return order
    .map((user) => ({
      user,
      sessions: byUser.get(user)!,
      cpuPct: cpuByUser.get(user) ?? 0,
      memPct: memByUser.get(user) ?? 0,
    }))
    .sort((a, b) => b.cpuPct - a.cpuPct);
}

const TONE_KEY: Record<UsageTone, TranslationKey> = {
  green: "usage.toneGreen",
  orange: "usage.toneOrange",
  red: "usage.toneRed",
};

function UsageLight({ pct }: { pct: number }) {
  const t = useT();
  const tone = usageTone(pct);
  return (
    <span
      className={`remote-usage-light is-${tone}`}
      aria-label={t("usage.utilizationAria", { tone: t(TONE_KEY[tone]) })}
    />
  );
}

/** One host's usage: reasons, CPU/load/memory/GPU stats, the per-user "Logged
 *  in" table, and top processes — repeated per connected host in the combined
 *  dialog (it used to be the dialog's whole body, back when only the primary
 *  was ever probed). */
function HostUsageSection({
  label,
  report,
  action,
}: {
  label: string;
  report: RemoteUsageReport;
  /** The row's own "read it now" control, for a host the automatic sweep skips
   *  (see [`RemoteUsageWarningDialog`]). Absent for a host the sweep covers. */
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="remote-usage-host">
      <div className="remote-usage-host-title">
        {label}
        {action}
      </div>
      {/* Said before the numbers, because on a cluster the short session list and
          own-processes-only table are a deliberate limit, not a quiet machine. */}
      {report.careful && <div className="remote-usage-careful">{t("usage.carefulNote")}</div>}
      {report.reasons.length > 0 && (
        <ul className="remote-usage-reasons">
          {report.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="remote-usage-stats">
        <div className="remote-usage-stat">
          <span className="remote-usage-stat-label">{t("usage.cpu")}</span>
          <span className="remote-usage-stat-value">
            <UsageLight pct={report.cpuPct} />
            {report.cpuPct.toFixed(0)}%{" "}
            <span className="remote-usage-stat-sub">
              {t(report.cpuCount === 1 ? "usage.coresOne" : "usage.coresMany", { count: report.cpuCount })}
            </span>
          </span>
        </div>
        <div className="remote-usage-stat">
          <span className="remote-usage-stat-label">{t("usage.loadAverage")}</span>
          <span className="remote-usage-stat-value">
            {report.load1.toFixed(2)}, {report.load5.toFixed(2)}, {report.load15.toFixed(2)}
          </span>
        </div>
        <div className="remote-usage-stat">
          <span className="remote-usage-stat-label">{t("usage.memory")}</span>
          <span className="remote-usage-stat-value">
            {report.memUsedMb} / {report.memTotalMb} MB{" "}
            <span className="remote-usage-stat-sub">
              ({fmtPct(report.memUsedMb, report.memTotalMb)})
            </span>
          </span>
        </div>
        {report.gpus.map((g, i) => (
          <div className="remote-usage-stat" key={`${g.name}-${i}`}>
            <span className="remote-usage-stat-label">GPU{report.gpus.length > 1 ? ` ${i}` : ""}</span>
            <span className="remote-usage-stat-value">
              <UsageLight pct={g.utilPct} />
              {g.utilPct.toFixed(0)}%{" "}
              <span className="remote-usage-stat-sub">
                ({g.memUsedMb} / {g.memTotalMb} MB · {g.name})
              </span>
            </span>
          </div>
        ))}
      </div>
      {/* Shown for **every** host, even with no sessions: `who` on a host reached
          only over the pooled (non-PTY) master has no utmp entry of its own, so a
          compute node with no interactive login is legitimately empty. The empty
          note makes that explicit rather than dropping the section, which read as
          "only the primary host reports logins". */}
      <div className="remote-usage-section">
        <div className="remote-usage-section-title">
          {t("usage.loggedIn")}{" "}
          <span className="remote-usage-stat-sub">
            {t(report.users.length === 1 ? "usage.sessionsOne" : "usage.sessionsMany", { count: report.users.length })}
          </span>
        </div>
        {report.users.length > 0 ? (
          <ul className="remote-usage-users">
            <li className="remote-usage-users-head" aria-hidden="true">
              <span>{t("usage.userCol")}</span>
              <span>{t("usage.cpu")}</span>
              <span>{t("usage.sessionsCol")}</span>
              <span>{t("usage.memCol")}</span>
            </li>
            {groupSessionsByUser(report).map((g) => (
              <li key={g.user}>
                <span className="remote-usage-user">{g.user}</span>
                <span className="remote-usage-user-cpu">
                  <UsageLight pct={g.cpuPct} />
                  {g.cpuPct.toFixed(0)}%
                </span>
                <span className="remote-usage-user-sessions">{g.sessions.length}</span>
                <span className="remote-usage-user-mem">{g.memPct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="remote-usage-empty">{t("usage.noInteractiveLogins")}</div>
        )}
      </div>
      {report.topProcs.length > 0 && (
        <div className="remote-usage-section">
          <div className="remote-usage-section-title">{t("usage.topProcesses")}</div>
          <ul className="remote-usage-procs">
            {report.topProcs.map((p, i) => (
              <li key={`${p.pid}-${i}`}>
                <span className="remote-usage-proc-cmd">{p.command}</span>
                <span className="remote-usage-proc-user">{p.user}</span>
                <span className="remote-usage-proc-pct">{p.cpuPct.toFixed(1)}% {t("usage.cpuSuffix")}</span>
                <span className="remote-usage-proc-pct">{p.memPct.toFixed(1)}% {t("usage.memSuffix")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One section of the dialog: the host it reads, plus the two facts that decide
 *  whether it may be read *unasked* — is a session open on it, and is it tagged. */
interface UsageRow {
  target: UsageTarget;
  /** A session this app opened (a machine's lamp / the project host's pool). */
  connected: boolean;
  /** Tagged as a shared cluster login node (`lib/remote/hpc/hpcHost.ts`). */
  hpc: boolean;
  /** Whether the open-the-dialog sweep may read it. */
  autoRead: boolean;
}

export function RemoteUsageWarningDialog() {
  const t = useT();
  const activeId = useProjectsStore((s) => s.activeId);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === activeId));
  const machines = useGlobalMachinesStore((s) => s.machines);
  const machineStatus = useGlobalMachinesStore((s) => s.status);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHost = useRemoteStatusStore((s) => s.byHost);
  const settings = useSettingsStore((s) => s.settings);
  const setReport = useRemoteUsageStore((s) => s.setReport);
  const close = useRemoteUsageStore((s) => s.close);
  const recheck = useRemoteUsageStore((s) => s.recheck);
  const reports = useRemoteUsageStore((s) => s.reports);
  const isOpen = useRemoteUsageStore((s) => s.isOpen);
  const [rechecking, setRechecking] = useState(false);
  /** Per-row in-flight state for the explicit reads (the sweep has `rechecking`). */
  const [reading, setReading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<UsageReportEvent>("remote-usage-report", (event) => {
      setReport(
        projectHostKey(event.payload.projectId, event.payload.hostId),
        event.payload.report,
      );
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setReport]);

  // Every global machine first, in the Machines menu's own order — this dialog
  // opens from that menu, so its list must be that list. Then the active
  // project's own hosts (primary, then `compute_hosts` in project order, the
  // same order the System Monitor's host picker uses), minus any whose SSH
  // target is already a machine above: the two lists are related by
  // `user@host:port` and nothing else, since attaching a machine to a project
  // copies it by value rather than linking ids.
  //
  // Each row also carries what licenses an *unasked* read of it. Both probes
  // behind `recheck` are real work on the host — `global_machine_usage_check` is
  // a fresh `run_ssh_auth`, `remote_usage_check` opens the pool — so opening this
  // dialog used to dial every machine anyone had ever added, connected or not,
  // tagged or not. Two facts narrow that:
  //
  //  * **the lamp** — a machine with no session is not read by the sweep. Its
  //    section renders from cache with a button, so nothing is lost but the
  //    login nobody asked for.
  //  * **the tag** — a shared login node is never in an automatic sweep at all,
  //    whatever its lamp says. `isHpcHost` on the target, the same key the rest
  //    of the tag uses, so tagging a machine once covers it here too.
  const rows = useMemo<UsageRow[]>(() => {
    const build = (target: UsageTarget, connected: boolean, hpc: boolean): UsageRow => ({
      target,
      connected,
      hpc,
      autoRead: connected && !hpc,
    });
    const list: UsageRow[] = machines.map((m) =>
      build(
        {
          kind: "machine",
          key: machineKey(m.id),
          label: m.label || m.host,
          user: m.user,
          host: m.host,
          port: m.port,
        },
        machineStatus[m.id] === "connected",
        isHpcHost(settings, { user: m.user, host: m.host, port: m.port }),
      ),
    );
    if (project?.remote) {
      const hostLabels = hostsForProject(project);
      const specs = [
        { id: PRIMARY_HOST, spec: project.remote },
        ...(project.compute_hosts ?? []).map((w) => ({ id: w.id, spec: w })),
      ];
      for (const { id, spec } of specs) {
        if (machines.some((m) => sameTarget(m, spec))) continue;
        const label = hostLabels.find((h) => h.id === id)?.label ?? spec.host;
        list.push(
          build(
            {
              kind: "projectHost",
              key: projectHostKey(project.id, id),
              label: `${label} — ${project.name}`,
              projectId: project.id,
              hostId: id,
            },
            sshOf({ byProject, byHost }, project.id, id) === "connected",
            isHpcHost(settings, {
              user: spec.user || undefined,
              host: spec.host,
              port: spec.port ?? undefined,
            }),
          ),
        );
      }
    }
    return list;
  }, [machines, machineStatus, project, byProject, byHost, settings]);

  // Opening is itself the request for a reading: whatever the last connect left
  // cached is however old the session is, so every host the sweep may touch is
  // rechecked as the dialog appears (its sections fill in as the probes land).
  // The rest keep their cached reading and a button.
  const sweep = useMemo(() => rows.filter((r) => r.autoRead).map((r) => r.target), [rows]);
  const sweepKey = sweep.map((r) => r.key).join("|");
  const runRecheck = useMemo(
    () => () => {
      if (sweep.length === 0) return;
      setRechecking(true);
      // No `background` flag: this IS the background path, and a command that
      // gates on one must see it omitted rather than talked out of.
      void Promise.all(sweep.map((r) => recheck(r))).finally(() => setRechecking(false));
    },
    // `sweepKey` stands in for `sweep` (a fresh array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sweepKey, recheck],
  );
  useEffect(() => {
    if (isOpen) runRecheck();
  }, [isOpen, runRecheck]);

  /**
   * Read ONE host because the user pressed its button. Deliberately not
   * `recheck`: that is the sweep's call and omits `background`, which is what
   * makes a tagged host refuse it. A press is a gesture, so this one says
   * `background: false` — the only spelling that reaches a tagged machine, and
   * one no timer can produce.
   */
  const readNow = async (row: UsageRow) => {
    const key = row.target.key;
    setReading((m) => ({ ...m, [key]: true }));
    try {
      const report =
        row.target.kind === "machine"
          ? await invoke<RemoteUsageReport>("global_machine_usage_check", {
              user: row.target.user,
              host: row.target.host,
              port: row.target.port,
              background: false,
            })
          : await invoke<RemoteUsageReport>("remote_usage_check", {
              projectId: row.target.projectId,
              hostId: row.target.hostId,
              background: false,
            });
      setReport(key, report);
    } catch {
      // Best-effort, exactly as the sweep is: a host that can't be reached keeps
      // whatever was cached instead of tearing the dialog down.
    } finally {
      setReading((m) => ({ ...m, [key]: false }));
    }
  };

  /** Why a section has no fresh reading — stated, because "no reading" alone
   *  reads as a broken probe when it is in fact a machine waiting to be asked. */
  const rowNote = (row: UsageRow): string => {
    if (reading[row.target.key] || (rechecking && row.autoRead)) return t("usage.checkingEllipsis");
    if (row.hpc) return t("usage.notReadHpc");
    if (!row.connected) return t("usage.notReadNoSession");
    return t("usage.noReading");
  };

  /** The per-row read control, for the hosts the sweep skips. */
  const rowAction = (row: UsageRow): ReactNode =>
    row.autoRead ? null : (
      <>
        {" "}
        <button
          type="button"
          className="inline-link-btn"
          onClick={() => void readNow(row)}
          disabled={!!reading[row.target.key]}
          title={t(row.hpc ? "usage.readNowHpcTitle" : "usage.readNowTitle")}
        >
          {reading[row.target.key] ? t("usage.checkingEllipsis") : t("usage.recheck")}
        </button>
      </>
    );

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="project-dialog dialog-framed remote-usage-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("usage.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={close}>×</button>
        </div>
        <div className="dialog-scroll">
          <p className="remote-usage-lede">
            {rows.length === 0
              ? t("usage.noMachines")
              : t("usage.lede", {
                  hosts: rows.length === 1 ? t("usage.hostSingular") : t("usage.hostsPlural", { count: rows.length }),
                  reading: rechecking ? t("usage.beingReadNow") : t("usage.asLastRead"),
                })}
          </p>
          {rows.map((row) =>
            reports[row.target.key] ? (
              <HostUsageSection
                key={row.target.key}
                label={row.target.label}
                report={reports[row.target.key]}
                action={rowAction(row)}
              />
            ) : (
              <div className="remote-usage-host" key={row.target.key}>
                <div className="remote-usage-host-title">
                  {row.target.label}
                  {rowAction(row)}
                </div>
                <div className="remote-usage-empty">{rowNote(row)}</div>
              </div>
            ),
          )}
          <div className="project-dialog-actions">
            {/* Rechecks only what the sweep may touch; a skipped host keeps its
                own button, which is the only thing that reads it. */}
            <button type="button" onClick={runRecheck} disabled={rechecking || sweep.length === 0}>
              {rechecking ? t("usage.rechecking") : t("usage.recheck")}
            </button>
            <button type="button" onClick={close}>
              {t("howToStart.gotIt")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

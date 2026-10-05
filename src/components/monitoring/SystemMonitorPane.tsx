import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatBytes,
  formatFan,
  formatMhz,
  formatTempC,
  formatWatts,
  gpuAdapterTooltip,
  gpuLinkLabel,
  gpuPercent,
  gpuTotals,
  type GpuProc,
  type GpuSample,
} from "../../lib/gpu";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import {
  carefulIsExplicit,
  isCarefulHost,
  setCarefulPatch,
  targetOfSpec,
} from "../../lib/remote/carefulHost";
import { isHpcHost } from "../../lib/remote/hpc/hpcHost";
import { hpcGuardRefusal } from "../../lib/remote/hpc/hpcGuard";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { sameTarget } from "../../lib/remote/machineSync";
import { ConnLamp } from "../common/ConnLamp";
import { UntestedTag } from "../common/UntestedTag";
import { hostsForProject } from "../../lib/remote/remoteHosts";
import { PRIMARY_HOST, sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useT, type TranslationKey } from "../../lib/i18n";
import { FeatherIcon, MicroscopeIcon } from "../common/icons/Icon";

// ── Backend snapshot shape (mirrors sysstat::SystemSnapshot, snake_case) ──────

export interface CpuTimes {
  busy: number;
  total: number;
}

export interface ProcSample {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string;
  state: string;
  rss_kib: number;
  cpu_jiffies: number;
  threads: number;
  /** Owning user's name (resolved on the sampled machine's passwd db). Empty when
   *  the backend can't resolve an owner (Windows/macOS) — the per-user section is
   *  hidden then. An unmapped uid reads as `#<uid>`. */
  user: string;
}

/** One interactive login session on the sampled host (a `who` row). Populated
 *  only on the **remote** path — the local pane never shows the "Logged in"
 *  panel, since local sampling is always just this user. */
export interface LoginSession {
  user: string;
  tty: string;
  /** The rest of the `who` line verbatim — login time and `(origin)`. */
  detail: string;
  /** This session belongs to the account Tabtivity is connected as. The backend also
   *  *synthesizes* such a row when `who` has none: utmp only records a session that
   *  got a pty, and the monitor's own probe rides the pooled (non-pty) master — so
   *  without it the panel listed every logged-in user except the one reading it. */
  is_self?: boolean;
}

export interface SystemSnapshot {
  supported: boolean;
  clk_tck: number;
  num_cores: number;
  cpu: CpuTimes;
  per_core: CpuTimes[];
  mem_total_kib: number;
  mem_available_kib: number;
  swap_total_kib: number;
  swap_free_kib: number;
  load_avg: [number, number, number];
  uptime_secs: number;
  processes: ProcSample[];
  /** Every GPU whose memory the machine reports; empty when none (see `lib/gpu`). */
  gpus: GpuSample[];
  /** Per-process GPU memory — populated only on the remote path (sampled on the
   *  host); locally the pane fetches `gpu_process_snapshot` instead. */
  gpu_procs?: GpuProc[];
  /** Whole-package CPU temperature in °C, or null/undefined when no CPU hwmon
   *  sensor is present (or on Windows/macOS, which don't read one). */
  cpu_temp_c?: number | null;
  /** Hottest DIMM temperature in °C, or null/undefined when the board exposes no
   *  on-module sensor (`jc42`/`spd5118`) — most desktops don't wire one. */
  mem_temp_c?: number | null;
  /** Interactive login sessions on the host (from `who`), backing the "Logged in"
   *  panel — the same per-user session view the connect-time remote-usage dialog
   *  shows. Populated only on the remote path; empty locally. */
  sessions?: LoginSession[];
  /** Whether the **host** reported itself an HPC node (SLURM on its `PATH`) and
   *  therefore sampled itself carefully: no other user's account name, command
   *  line, GPU process or login session is in this snapshot — everyone else's
   *  processes arrive bucketed under one `other users` label. A cluster login
   *  node's usage rules don't allow collecting more, and its operators don't want
   *  a 3-second poll either, so the pane also slows down when this is set
   *  (`docs/context/hpc_careful_mode.md`). Never set for a local sample. */
  careful?: boolean;
}

interface Props {
  /** Owning project, or `null` in the root scope. A remote (SSH) project unlocks
   *  a source toggle so the pane can sample the **host** instead of this machine.
   *  Ignored when `globalMachine` is set. */
  projectId: string | null;
  visible: boolean;
  /** When set, the pane skips the project/host machinery entirely and samples
   *  this ad-hoc global machine (`stores/remote/globalMachines.ts` — no project, no
   *  pooled ControlMaster) via `global_machine_monitor_snapshot`, opened by
   *  `GlobalMachineMonitorDialog` from the header's Machines menu in place of
   *  its old small inline usage bars. Always treated as a remote source (no
   *  "This machine" toggle — there is only the one machine to show). */
  globalMachine?: { user?: string; host: string; port?: number };
}

/** Which machine the pane samples: this one, or a connected remote project's host.
 *  A hostId of `PRIMARY_HOST` selects the project's own remote; any other id
 *  selects a `compute_hosts` worker (`docs/multi_host_remote_plan.md`). */
type Source = "local" | { hostId: string };

const POLL_MS = 1500;
/** The host sample is one SSH round-trip reading its whole `/proc`, so it polls
 *  more gently than the local `/proc` read to keep host load and traffic down. */
const REMOTE_POLL_MS = 3000;
/** …and more gently still on an **HPC host** (one that reported `careful`): a
 *  shared login node is explicitly not to carry a sustained background load, and
 *  a pane left open all afternoon at 3 s is exactly the "process causing load
 *  over a longer period" its rules reserve the right to kill. 12 s still tracks a
 *  job starting; nothing here needs sub-second news. Paired with the unfocused
 *  pause below — an HPC sample the user isn't looking at costs the cluster for
 *  nothing. Both apply ONLY to a careful host; an ordinary remote box keeps the
 *  responsive cadence it always had. */
const CAREFUL_POLL_MS = 12_000;

// ── Pure delta helpers (unit-tested in SystemMonitorSampling.test.ts) ─────────

/**
 * CPU utilisation of one core (or the aggregate) as a 0–100 percentage, from two
 * successive cumulative [`CpuTimes`] samples: `(busyΔ / totalΔ) * 100`. Returns 0
 * with no previous sample, a non-positive total delta, or a negative busy delta
 * (a counter reset / first frame), and clamps to 100.
 */
export function coreUsagePercent(
  prev: CpuTimes | undefined,
  next: CpuTimes,
): number {
  if (!prev) return 0;
  const totalDelta = next.total - prev.total;
  const busyDelta = next.busy - prev.busy;
  if (totalDelta <= 0 || busyDelta < 0) return 0;
  return Math.min(100, (busyDelta / totalDelta) * 100);
}

/**
 * Per-process CPU% in top's convention (% of a single core, so a fully busy
 * N-thread process can report up to N*100). Derived from the process's jiffy
 * delta over the machine's total-CPU-jiffy delta, scaled by core count. Returns
 * 0 on the first frame (no previous jiffies), a non-positive total delta, or a
 * negative process delta (pid reuse / exit-respawn).
 */
export function procCpuPercent(
  prevJiffies: number | undefined,
  nextJiffies: number,
  totalDelta: number,
  numCores: number,
): number {
  if (prevJiffies === undefined || totalDelta <= 0) return 0;
  const delta = nextJiffies - prevJiffies;
  if (delta < 0) return 0;
  return (delta / totalDelta) * numCores * 100;
}

/** Resident memory as a 0–100 percentage of total RAM. */
export function memPercent(rssKib: number, memTotalKib: number): number {
  if (memTotalKib <= 0) return 0;
  return (rssKib / memTotalKib) * 100;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Human-readable size from KiB (KiB → MiB → GiB → TiB). */
function formatKib(kib: number): string {
  if (kib < 1024) return `${kib} K`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} M`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(gib < 10 ? 2 : 1)} G`;
  return `${(gib / 1024).toFixed(2)} T`;
}

/** Seconds → `Dd HH:MM:SS` / `HH:MM:SS` uptime string. */
function formatUptime(secs: number): string {
  const s = Math.floor(secs);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/** Green → amber → red tone for a 0–100 load ratio. */
function toneFor(pct: number): string {
  if (pct >= 90) return "var(--danger)";
  if (pct >= 60) return "var(--warning)";
  return "var(--success)";
}

/** Traffic-light tone for a utilization percentage, matching the remote-usage
 *  connect dialog exactly: green when effectively idle (≤5%), orange up to 40%,
 *  red above — so the per-user "By user" panel reads identically to the session
 *  stats there. */
type UsageTone = "green" | "orange" | "red";
function usageTone(pct: number): UsageTone {
  if (pct <= 5) return "green";
  if (pct <= 40) return "orange";
  return "red";
}

const TONE_KEY: Record<UsageTone, TranslationKey> = {
  green: "usage.toneGreen",
  orange: "usage.toneOrange",
  red: "usage.toneRed",
};

/** The same green/orange/red dot the remote-usage dialog puts next to a user's
 *  CPU share (`.remote-usage-light`), reused here so the two panels match. */
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

// ── Derived rows ──────────────────────────────────────────────────────────────

interface ProcRow extends ProcSample {
  cpu: number;
  mem: number;
}

type SortKey = "cpu" | "mem" | "rss_kib" | "pid" | "threads" | "comm";

function buildRows(snap: SystemSnapshot, prev: SystemSnapshot | null): ProcRow[] {
  const totalDelta = prev ? snap.cpu.total - prev.cpu.total : 0;
  const prevJiff = new Map<number, number>(
    prev ? prev.processes.map((p) => [p.pid, p.cpu_jiffies]) : [],
  );
  return snap.processes.map((p) => ({
    ...p,
    cpu: procCpuPercent(prevJiff.get(p.pid), p.cpu_jiffies, totalDelta, snap.num_cores),
    mem: memPercent(p.rss_kib, snap.mem_total_kib),
  }));
}

function sortRows(rows: ProcRow[], key: SortKey, asc: boolean): ProcRow[] {
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "comm") return dir * a.comm.localeCompare(b.comm);
    return dir * ((a[key] as number) - (b[key] as number));
  });
}

/** One user's share of the machine: their summed CPU%/MEM% across every process
 *  they own, and how many processes that is. This is the same "who's loading the
 *  host" statistic the connect-time usage dialog shows, but derived from the full
 *  process table rather than a top-N `ps` sample — so it's exact, not a sample. */
interface UserRow {
  user: string;
  cpu: number;
  mem: number;
  count: number;
}

/** Collapse the process rows into one row per owning user, summing CPU%/MEM% and
 *  counting processes. Sorted by CPU%, busiest first — the point is spotting who's
 *  loading the machine. Processes with no resolved owner are ignored (the section
 *  itself is hidden when *no* process reports one). */
function groupByUser(rows: ProcRow[]): UserRow[] {
  const byUser = new Map<string, UserRow>();
  for (const r of rows) {
    if (!r.user) continue;
    const cur = byUser.get(r.user) ?? { user: r.user, cpu: 0, mem: 0, count: 0 };
    cur.cpu += r.cpu;
    cur.mem += r.mem;
    cur.count += 1;
    byUser.set(r.user, cur);
  }
  return [...byUser.values()].sort((a, b) => b.cpu - a.cpu);
}

/** One logged-in user: how many interactive sessions they hold, plus their summed
 *  CPU%/MEM% from the full process table. Same look as the connect-time
 *  remote-usage dialog's "Logged in" row. */
interface SessionRow {
  user: string;
  sessions: number;
  cpu: number;
  mem: number;
  /** The row is the connected account's own — marked "you" and pinned to the top. */
  isSelf: boolean;
}

/** Collapse `who`'s login sessions into one row per user — a session count plus
 *  that user's CPU%/MEM% looked up from the full-table `byUser` breakdown, so the
 *  compute figures are exact rather than a `ps` sample (which is what the connect
 *  dialog has to settle for). Sorted by CPU%, busiest first. Unlike "By user"
 *  (every process owner, including system daemons), this lists only users with an
 *  actual interactive login — the "who else is on this shared machine?" view. The
 *  connected account is always among them (the backend synthesizes its row when
 *  utmp has no record of it, see `LoginSession.is_self`) and is pinned to the top:
 *  sorting purely by CPU buried the one row the reader is looking for, and on an
 *  idle-but-shared host it landed at the bottom under everyone else. */
function groupLoginSessions(
  sessions: LoginSession[],
  byUser: Map<string, UserRow>,
): SessionRow[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const selves = new Set<string>();
  for (const s of sessions) {
    if (!counts.has(s.user)) order.push(s.user);
    counts.set(s.user, (counts.get(s.user) ?? 0) + 1);
    if (s.is_self) selves.add(s.user);
  }
  return order
    .map((user) => {
      const u = byUser.get(user);
      return {
        user,
        sessions: counts.get(user) ?? 0,
        cpu: u?.cpu ?? 0,
        mem: u?.mem ?? 0,
        isSelf: selves.has(user),
      };
    })
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.cpu - a.cpu);
}

// ── Small presentational bits ─────────────────────────────────────────────────

function Meter({
  label,
  pct,
  caption,
  title,
}: {
  label: string;
  pct: number;
  caption?: string;
  /** Hover detail — the GPU meters use it to name the adapter and split its pools. */
  title?: string;
}) {
  return (
    <div className="sysmon-meter" title={title}>
      <span className="sysmon-meter-label">{label}</span>
      <span className="sysmon-meter-bar">
        <span
          className="sysmon-meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: toneFor(pct) }}
        />
      </span>
      <span className="sysmon-meter-caption">{caption ?? `${pct.toFixed(0)}%`}</span>
    </div>
  );
}

/** One GPU's detail card: identity, memory + utilization meters, live sensors. */
function GpuSection({ gpu }: { gpu: GpuSample }) {
  const { used, total } = gpuTotals([gpu]);
  const link = gpuLinkLabel(gpu);
  const tip = gpuAdapterTooltip(gpu);

  // A fixed set of sensor slots in a fixed order, always rendered from the first
  // frame on. A driver that momentarily (or never) answers a sensor shows `n/a`
  // in its slot rather than dropping the chip — a disappearing chip reflows every
  // chip to its right, which is the flicker (an idle NVIDIA card blanks
  // `power.draw` as `[N/A]`). Keeping the slots stable trades a permanent `n/a`
  // for a sensor a card lacks against a strip that never jumps.
  const sensors = [
    { label: "temp", value: formatTempC(gpu.temp_c) },
    { label: "power", value: formatWatts(gpu.power_w, gpu.power_cap_w) },
    { label: "core", value: formatMhz(gpu.sclk_mhz) },
    { label: "mem", value: formatMhz(gpu.mclk_mhz) },
    { label: "fan", value: formatFan(gpu.fan_percent) },
  ].map((s) => ({ label: s.label, value: s.value ?? "n/a", present: s.value != null }));

  return (
    <div className="sysmon-gpu">
      <div className="sysmon-gpu-head">
        <span className="sysmon-gpu-name" title={tip}>
          {gpu.name}
        </span>
        <span className="sysmon-gpu-meta">
          {gpu.driver}
          {gpu.driver_version ? ` ${gpu.driver_version}` : ""}
          {link ? ` · ${link}` : ""}
        </span>
      </div>
      <div className="sysmon-gpu-meters">
        {/* Both memory pools summed — on an APU the dedicated carve-out alone is
            just the framebuffer (see lib/gpu). */}
        <Meter
          label="VRAM"
          pct={gpuPercent(used, total)}
          caption={`${formatBytes(used)} / ${formatBytes(total)}`}
          title={tip}
        />
        {/* `busy_percent` is null when the driver won't report it — omit the meter
            rather than show a misleading 0%. */}
        {gpu.busy_percent != null && <Meter label="Util" pct={gpu.busy_percent} />}
      </div>
      {sensors.length > 0 && (
        <div className="sysmon-stats sysmon-gpu-sensors">
          {sensors.map((s) => (
            <span key={s.label}>
              {s.label}{" "}
              <b className={s.present ? undefined : "sysmon-sensor-na"}>{s.value}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Top processes by GPU memory. Empty (renders nothing) when the driver reports
 *  no per-process data — best-effort, so its absence is silent, not an error. */
function GpuProcList({ procs }: { procs: GpuProc[] }) {
  const t = useT();
  const top = procs.filter((p) => p.mem_bytes > 0).slice(0, 8);
  if (top.length === 0) return null;
  return (
    <div className="sysmon-gpu-procs">
      <div className="sysmon-gpu-procs-head">{t("sysmon.gpuMemByProcess")}</div>
      {top.map((p) => (
        <div className="sysmon-gpu-proc" key={p.pid}>
          <span className="sysmon-gpu-proc-mem">{formatBytes(p.mem_bytes)}</span>
          <span className="sysmon-gpu-proc-pid">{p.pid}</span>
          <span className="sysmon-gpu-proc-name" title={p.name}>
            {p.name || "?"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SystemMonitorPane({ projectId, visible, globalMachine }: Props) {
  const t = useT();
  const [pair, setPair] = useState<{ snap: SystemSnapshot; prev: SystemSnapshot | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Per-process GPU memory, local machine only (the remote /proc script doesn't
  // sample it). Its own command, so the always-visible header never pays for it.
  const [gpuProcs, setGpuProcs] = useState<GpuProc[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState("");
  // The detailed process table is collapsible so the CPU/GPU vitals can own the
  // pane; expanded by default (the monitor's main content).
  const [procOpen, setProcOpen] = useState(true);
  // The per-user breakdown is collapsible too, expanded by default when present.
  const [usersOpen, setUsersOpen] = useState(true);
  // The logged-in-sessions panel (remote hosts only), likewise collapsible.
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const prevRef = useRef<SystemSnapshot | null>(null);
  // Whether this sample is being taken carefully. Seeded from the machine's
  // stored mode (below) and only ever raised by a snapshot that came back
  // careful anyway — a host is free to insist, nothing may talk it down. Kept in
  // a ref *and* state: the poll loop reads the ref (it must not restart to learn
  // the new cadence), the notice below renders off the state.
  const carefulRef = useRef(false);
  const [careful, setCareful] = useState(false);
  // The live loop's own `poll`, published for the Refresh button below. A tagged
  // host is sampled once on open and then only when asked, so the button needs to
  // reach INTO the running effect: re-running the effect to trigger a sample would
  // drop `prevRef`, the previous sample every CPU% is a delta against.
  const pollNowRef = useRef<(() => void) | null>(null);

  // A remote (SSH) project can sample its primary host, and — multi-host
  // (`docs/multi_host_remote_plan.md`) — any connected `compute_hosts` worker
  // too. Same store reads the Disk Usage pane uses to reach a host over the
  // shared pool.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHostAll = useRemoteStatusStore((s) => s.byHost);
  const isRemoteProject = !!project?.remote;

  const hosts = useMemo(() => hostsForProject(project), [project]);

  function connState(hostId: string) {
    if (!projectId) return "off" as const;
    return sshOf({ byProject, byHost: byHostAll }, projectId, hostId);
  }
  const primaryConnected = isRemoteProject && connState(PRIMARY_HOST) === "connected";

  const [source, setSource] = useState<Source>("local");
  // Auto-follow the primary host: point at it once it is connected, "local"
  // otherwise — until the user picks a side explicitly (any host or "local"),
  // which pins the choice.
  const pinnedRef = useRef(false);
  useEffect(() => {
    if (!pinnedRef.current) setSource(primaryConnected ? { hostId: PRIMARY_HOST } : "local");
  }, [primaryConnected]);
  function pickSource(next: Source) {
    pinnedRef.current = true;
    setSource(next);
  }

  // A global machine has no project/host machinery at all — it is always
  // treated as "on a remote host" (the sessions/by-user panels, the remote poll
  // cadence) but skips the source toggle and the pooled-connection gate: it
  // authenticates ad-hoc on every poll, same as the dialog's old small usage bar.
  const onHost = !!globalMachine || source !== "local";
  const selectedHostId = !globalMachine && onHost ? (source as { hostId: string }).hostId : null;
  // A global machine's lamp, from the machines store — not `true`. Every poll of
  // `global_machine_monitor_snapshot` is a FRESH SSH login (a global machine pools
  // nothing), so assuming "connected" kept a whole login sequence running per tick
  // against a machine whose lamp was off, red, or never lit.
  //
  // `status`, deliberately, and never `reachable`: the first means "a session this
  // app opened", the second only "a probe once got an answer"
  // (`stores/remote/globalMachines`). Sampling is a session's worth of work, so it is the
  // first that licenses it. The machine is matched by SSH target rather than by id
  // because this pane is handed a `{user, host, port}` and nothing else.
  const machines = useGlobalMachinesStore((s) => s.machines);
  const machineStatus = useGlobalMachinesStore((s) => s.status);
  const globalMachineConnected =
    !!globalMachine &&
    machineStatus[machines.find((m) => sameTarget(m, globalMachine))?.id ?? ""] === "connected";
  const hostConnected = globalMachine
    ? globalMachineConnected
    : onHost && selectedHostId != null && connState(selectedHostId) === "connected";
  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? null;
  const remoteHost = onHost
    ? (globalMachine ? t("sysmon.thisMachineLower") : (selectedHost?.label ?? t("sysmon.theHost")))
    : t("sysmon.theHost");
  // Whether the pane is actually sampling (and so the table/meters below apply).
  const sampling = visible && !(onHost && !hostConnected);

  // ── Careful vs. normal, per machine ────────────────────────────────────────
  // The SSH target of whatever this pane is pointed at — a global machine, the
  // project's primary, or a worker. That target (not the host id) is what the
  // careful flag is keyed by, so one physical login node reads the same here, in
  // the Machines menu and in the remote hub (`lib/remote/carefulHost.ts`).
  const carefulTarget = globalMachine ? targetOfSpec(globalMachine) : (selectedHost?.target ?? null);
  // The mode asked for: careful for every remote machine until the user says
  // this one is theirs. A local sample is never careful — Tabtivity is not a guest
  // on the machine it runs on.
  // The HPC tag (`lib/remote/hpc/hpcHost.ts`) outranks that answer in one direction: a
  // machine the user called a cluster login node is read lightly even if its
  // careful answer says "this one is mine". The two say different things — how
  // much may Tabtivity look at, and is this a shared cluster — and there is no
  // reading of the second that permits the first's full collection. The backend
  // enforces the same precedence, so this is the UI agreeing with it, not the
  // place it is decided.
  const hpcTagged = isHpcHost(settings, carefulTarget);
  const carefulMode = onHost && (hpcTagged || isCarefulHost(settings, carefulTarget));
  const carefulExplicit = carefulIsExplicit(settings, carefulTarget);
  // Named, not "this machine": the switch is per *machine*, and its answer is
  // shared with every other project and surface pointing at the same host.
  const carefulMachineName = globalMachine
    ? globalMachine.host
    : (selectedHost?.label ?? carefulTarget?.host ?? "");

  // Poll only while visible and (for the host) while it is connected; the pane
  // stays mounted across scope switches, so pausing here stops a hidden monitor
  // from sampling in the background (mirrors AppResourceDisplay /
  // NetworkTrafficPane). CPU/MEM percentages are diffs of successive samples, so
  // switching machine drops the stale previous sample — a delta across two
  // different machines is meaningless.
  useEffect(() => {
    prevRef.current = null;
    setPair(null);
    setError(null);
    setGpuProcs([]);
    carefulRef.current = carefulMode;
    setCareful(carefulMode);
    if (!sampling) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    // Self-rescheduling rather than a fixed `setInterval`: the cadence depends on
    // what the FIRST sample says the host is (careful ⇒ HPC ⇒ gentle), and
    // re-running this effect to change an interval would throw away `prevRef` —
    // the previous sample every CPU% is a delta against.
    function schedule() {
      if (cancelled) return;
      // A **tagged** host gets no timer at all. 12 s is gentler than 3 s, not
      // absent, and what the tag promises is that nothing reaches a shared login
      // node without a gesture — so it is sampled once when the pane opens (that
      // opening IS the gesture) and thereafter only when Refresh is pressed. The
      // backend enforces the same rule from its side via `background`.
      if (hpcTagged) return;
      const delay = carefulRef.current ? CAREFUL_POLL_MS : onHost ? REMOTE_POLL_MS : POLL_MS;
      timer = window.setTimeout(() => void poll(false), delay);
    }
    /** `gesture` = the user asked for this one (the pane opening, or Refresh).
     *  It is what the backend's `background: false` means, and it also excuses the
     *  unfocused pause below — a click is not a background poll. */
    async function poll(gesture: boolean) {
      // An HPC host is not polled while the user is looking at something else:
      // the sample costs a shared login node real work, and a pane nobody is
      // reading has nothing to show for it. Only careful hosts — a local read or
      // an ordinary remote box keeps sampling in the background as before.
      if (carefulRef.current && !gesture && !document.hasFocus()) {
        schedule();
        return;
      }
      // Two Refresh clicks must not become two logins in flight.
      if (inFlight) return;
      inFlight = true;
      try {
        // `careful` is the machine's stored mode, and it is authoritative in
        // BOTH directions — careful by default, normal only where the user said
        // this machine is theirs. Passing it on every poll (rather than letting
        // the host decide) is what makes the switch below take effect on the
        // very first sample instead of after a probe has classified the host.
        const next = globalMachine
          ? await invoke<SystemSnapshot>("global_machine_monitor_snapshot", {
              user: globalMachine.user,
              host: globalMachine.host,
              port: globalMachine.port,
              careful: carefulMode,
              // Omitted ⇒ background ⇒ refused on a tagged host. Only a sample the
              // user asked for says otherwise, so a timer can never spell itself
              // as a gesture: the flag is the *caller's* claim, and a claim that
              // defaults to "unattended" can only fail closed.
              background: !gesture,
            })
          : await invoke<SystemSnapshot>("system_monitor_snapshot", {
              projectId: onHost ? projectId : null,
              hostId: onHost ? selectedHostId : null,
              careful: onHost ? carefulMode : null,
            });
        if (cancelled) return;
        if (next.careful && !carefulRef.current) {
          carefulRef.current = true;
          setCareful(true);
        }
        const prev = prevRef.current;
        prevRef.current = next;
        setPair({ snap: next, prev });
        setError(null);
        // The host samples its own per-process GPU memory into the snapshot; the
        // local machine has a dedicated command for it (kept off the shared,
        // always-polled snapshot). Best-effort either way — an empty list means
        // "no per-process data", not an error.
        if (onHost) {
          if (!cancelled) setGpuProcs(next.gpu_procs ?? []);
        } else {
          try {
            const procs = await invoke<GpuProc[]>("gpu_process_snapshot");
            if (!cancelled) setGpuProcs(procs);
          } catch {
            if (!cancelled) setGpuProcs([]);
          }
        }
      } catch (e) {
        // A tagged host refusing an unattended read is the tag working, not a
        // failure — say so, rather than printing the raw sentinel.
        if (!cancelled) setError(hpcGuardRefusal(e) ? t("sysmon.hpcNotRead") : String(e));
      } finally {
        inFlight = false;
        schedule();
      }
    }
    // The pane opening is itself a request for one reading — the only sample a
    // tagged host takes until Refresh is pressed.
    pollNowRef.current = () => void poll(true);
    void poll(true);
    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    sampling,
    onHost,
    // A tag flip changes the whole loop shape (timer vs. on-demand), and it can
    // move without `carefulMode` doing so — untagging a machine the user had also
    // marked careful leaves it careful.
    hpcTagged,
    // Flipping the machine's mode restarts the loop on purpose: the two modes
    // collect different things, so a delta across the switch would be a delta
    // between two different readings of the machine.
    carefulMode,
    projectId,
    selectedHostId,
    globalMachine?.user,
    globalMachine?.host,
    globalMachine?.port,
  ]);

  // Every process, before the table's text filter — the per-user breakdown sums
  // over the whole machine, not just what the filter happens to show.
  const allRows = useMemo(() => (pair ? buildRows(pair.snap, pair.prev) : []), [pair]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? allRows.filter(
          (r) =>
            r.comm.toLowerCase().includes(q) ||
            r.cmdline.toLowerCase().includes(q) ||
            String(r.pid) === q,
        )
      : allRows;
    return sortRows(filtered, sortKey, asc);
  }, [allRows, filter, sortKey, asc]);

  const userRows = useMemo(() => groupByUser(allRows), [allRows]);
  const hasUserData = userRows.length > 0;

  // Logged-in sessions (from the host's `who`), attributed CPU/MEM from the
  // full-table per-user sums. Remote-only — a local snapshot carries no sessions.
  const sessionRows = useMemo(() => {
    const sessions = pair?.snap.sessions;
    if (!sessions || sessions.length === 0) return [];
    const byUser = new Map(userRows.map((u) => [u.user, u]));
    return groupLoginSessions(sessions, byUser);
  }, [pair, userRows]);
  const hasSessions = sessionRows.length > 0;

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAsc((a) => !a);
    } else {
      setSortKey(key);
      // Text sorts ascending by default; numeric metrics descending (biggest first).
      setAsc(key === "comm");
    }
  }

  const snap = pair?.snap;
  const coreUsages = useMemo(
    () => (snap ? snap.per_core.map((c, i) => coreUsagePercent(pair?.prev?.per_core[i], c)) : []),
    [snap, pair],
  );
  // Fallback when a backend can't enumerate per-core times (e.g. the Windows
  // ntdll per-core query fails, or any OS returning an empty `per_core`): the
  // aggregate `cpu` field is always populated, so show one machine-wide bar
  // rather than an empty CPU section.
  const aggregateUsage = useMemo(
    () => (snap ? coreUsagePercent(pair?.prev?.cpu, snap.cpu) : 0),
    [snap, pair],
  );

  const arrow = (key: SortKey) => (key === sortKey ? (asc ? " ▲" : " ▼") : "");
  /** Marks the active sort column's header AND its body cells (`.sysmon-table
   *  th.sorted` / `td.sorted`) so the whole column reads as one accent band. */
  const sortedCls = (key: SortKey) => (key === sortKey ? "sorted" : undefined);

  return (
    <div className="sysmon-root">
      <style>{SYSMON_CSS}</style>

      {/* One row: which machine on the left, how it is read on the right. The
          row survives on its own for a global machine (no source tabs — there is
          only the one machine), so the mode switch is in the same place in the
          tab and in the Machines-menu dialog. */}
      {(isRemoteProject || (onHost && carefulTarget)) && (
        <div className="sysmon-source">
          {isRemoteProject && (
            <div className="sysmon-source-tabs" role="tablist" aria-label={t("sysmon.monitorSourceAria")}>
              <button
                className={source === "local" ? "sysmon-source-btn active" : "sysmon-source-btn"}
                onClick={() => pickSource("local")}
                role="tab"
                aria-selected={source === "local"}
              >
                {t("sysmon.thisMachineCap")}
              </button>
              {/* One button per connected machine — the primary and every multi-host
                  `compute_hosts` worker — each carrying its own live SSH traffic light
                  (the same `ConnLamp` the Remote machines window shows per row), so a
                  worker's status is visible right where its usage would be sampled. */}
              {hosts.map((h) => {
                const state = connState(h.id);
                const connected = state === "connected";
                const active = onHost && selectedHostId === h.id;
                return (
                  <button
                    key={h.id}
                    className={active ? "sysmon-source-btn active" : "sysmon-source-btn"}
                    onClick={() => pickSource({ hostId: h.id })}
                    role="tab"
                    aria-selected={active}
                    title={connected ? t("sysmon.systemMonitorOn", { host: h.label }) : `${h.label}: ${state}`}
                  >
                    <ConnLamp status={state} label={h.label} />
                    {h.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* How the selected machine is read. Light is the default for every
              remote machine — Tabtivity has no way to tell whose machine it is, and
              the wrong guess in the other direction is a policy violation on
              someone else's cluster rather than a thinner table. Switching to
              Detailed is a statement about that machine ("this one is mine"),
              so it is stored per SSH target and holds for every surface that
              reads the flag, not just this pane. Local sampling has no switch:
              it is always the full reading.

              Compact by design: it sits beside the machine tabs, and the question
              it answers ("how much of this host am I reading?") is one you ask
              rarely — an always-visible pair of word buttons would compete with
              the machine you are actually picking. So the *selected* mode is
              named and lit, and the alternative is a greyed icon that gives up
              its label on hover. */}
          {onHost && carefulTarget && (
            <>
              <div
                className="sysmon-mode"
                role="radiogroup"
                aria-label={
                  carefulMachineName
                    ? t("sysmon.readingForAria", { machine: carefulMachineName })
                    : t("sysmon.readingAria")
                }
              >
                <button
                  className={carefulMode ? "sysmon-mode-btn active" : "sysmon-mode-btn"}
                  onClick={() => void updateSettings(setCarefulPatch(settings, carefulTarget, true))}
                  role="radio"
                  aria-checked={carefulMode}
                  title={t("sysmon.lightTitle", {
                    machine: carefulMachineName || t("sysmon.thisMachineLower"),
                    suffix:
                      carefulMode && !carefulExplicit ? t("sysmon.lightDefaultSuffix") : "",
                  })}
                >
                  <span className="sysmon-mode-icon" aria-hidden="true">
                    <FeatherIcon />
                  </span>
                  <span className="sysmon-mode-txt">{t("sysmon.light")}</span>
                </button>
                <button
                  className={
                    !carefulMode
                      ? "sysmon-mode-btn active"
                      : hpcTagged
                        ? "sysmon-mode-btn sysmon-mode-btn-locked"
                        : "sysmon-mode-btn"
                  }
                  onClick={() =>
                    void updateSettings(setCarefulPatch(settings, carefulTarget, false))
                  }
                  // Not merely styled as unavailable — actually unavailable. A tag
                  // the user could click past on the machine it protects would
                  // only ever be clicked past on the machine that needed it.
                  disabled={hpcTagged}
                  role="radio"
                  aria-checked={!carefulMode}
                  title={
                    hpcTagged
                      ? t("sysmon.detailedTaggedTitle", {
                          machine: carefulMachineName || t("sysmon.thisMachineCap"),
                        })
                      : t("sysmon.detailedTitle", {
                          machine: carefulMachineName || t("sysmon.thisMachineLower"),
                        })
                  }
                >
                  <span className="sysmon-mode-icon" aria-hidden="true">
                    <MicroscopeIcon />
                  </span>
                  <span className="sysmon-mode-txt">{t("sysmon.detailed")}</span>
                </button>
              </div>
              {/* The only thing that reads a tagged machine after the pane's first
                  sample. It is a plain button rather than a cadence control on
                  purpose: the choice the tag takes away is "how often", and what
                  is left is "now". Borrows the machine tabs' style — it belongs to
                  the same row and needs no look of its own. */}
              {hpcTagged && (
                <button
                  type="button"
                  className="sysmon-source-btn"
                  onClick={() => pollNowRef.current?.()}
                  disabled={!sampling}
                  title={t("sysmon.refreshOnceTitle", {
                    machine: carefulMachineName || t("sysmon.thisMachineLower"),
                  })}
                >
                  ↻ {t("common.refresh")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {onHost && !hostConnected ? (
        <div className="sysmon-placeholder">
          {/* A global machine has no project to connect — it is connected from the
              Machines menu the pane was opened out of, so the placeholder points
              there rather than at a project that doesn't exist. */}
          {globalMachine
            ? t("sysmon.connectGlobalMachine", {
                machine: carefulMachineName || t("sysmon.thisMachineLower"),
              })
            : t("sysmon.connectProject", { host: remoteHost })}
        </div>
      ) : snap && !snap.supported ? (
        <div className="sysmon-placeholder">{t("sysmon.linuxOnly")}</div>
      ) : !snap ? (
        <div className="sysmon-placeholder">{error ?? t("sysmon.sampling")}</div>
      ) : (
        // One scroll region for the whole body (a single scrollbar): the vitals and
        // the process table scroll together, the table's sticky thead pinning to this
        // scroller.
        <div className="sysmon-scroll">
          {/* Why this host's table looks thinner than a normal one. Said plainly,
              because a silently reduced reading is worse than no reading: a login
              node full of unnamed rows would otherwise read as a bug. */}
          {careful && (
            <div className="sysmon-careful-note">
              <b>{t("sysmon.carefulLightReadingBold")}</b>
              {t("sysmon.carefulPre")}
              <i>{t("sysmon.carefulOtherUsersItalic")}</i>
              {t("sysmon.carefulMid")}
              {hpcTagged ? (
                <>
                  {t("sysmon.carefulTaggedPre")}
                  <b>{t("sysmon.carefulOnceBold")}</b>
                  {t("sysmon.carefulTaggedMid")}
                  <b>{t("common.refresh")}</b>
                  {t("sysmon.carefulTaggedPost")}
                </>
              ) : (
                t("sysmon.carefulUntaggedFull", { secs: Math.round(CAREFUL_POLL_MS / 1000) })
              )}
              {t("sysmon.carefulPost")}
              <b>{t("sysmon.detailed")}</b>
              {t("sysmon.carefulEnd")}
            </div>
          )}
          {/* Hardware vitals as two columns: CPU over Memory on the left, the GPU
              cards on the right (when the machine has one) — separated by a divider —
              so the GPU's VRAM + Util meters and sensor strip sit beside the CPU. */}
          <div className="sysmon-vitals">
            <div className="sysmon-vitals-left">
              <div className="sysmon-cpu-group">
                <div className="sysmon-group-title">
                  CPU
                  <span className="sysmon-group-sub">
                    {t(snap.num_cores === 1 ? "sysmon.coreCountOne" : "sysmon.coreCountMany", {
                      count: snap.num_cores,
                    })}
                  </span>
                </div>
                <div className="sysmon-cores">
                  {coreUsages.length > 0 ? (
                    coreUsages.map((pct, i) => <Meter key={i} label={`${i}`} pct={pct} />)
                  ) : (
                    <Meter label={t("sysmon.allLabel")} pct={aggregateUsage} />
                  )}
                </div>
                {/* System-load stats belong with the CPU: load average, task count,
                    uptime, and CPU package temperature (when a hwmon sensor exposes
                    one — omitted rather than shown as a fake zero). */}
                <div className="sysmon-stats">
                  <span>
                    {t("sysmon.loadLabel")} <b>{snap.load_avg.map((n) => n.toFixed(2)).join(" ")}</b>
                  </span>
                  <span>
                    {t("sysmon.tasksLabel")} <b>{snap.processes.length}</b>
                  </span>
                  <span>
                    {t("sysmon.upLabel")} <b>{formatUptime(snap.uptime_secs)}</b>
                  </span>
                  {snap.cpu_temp_c != null && (
                    <span>
                      {t("sysmon.cpuTempLabel")} <b>{formatTempC(snap.cpu_temp_c)}</b>
                    </span>
                  )}
                </div>
              </div>
              <div className="sysmon-mem-group">
                <div className="sysmon-group-title">{t("usage.memory")}</div>
                <Meter
                  label={t("usage.memCol")}
                  pct={memPercent(snap.mem_total_kib - snap.mem_available_kib, snap.mem_total_kib)}
                  caption={`${formatKib(snap.mem_total_kib - snap.mem_available_kib)} / ${formatKib(
                    snap.mem_total_kib,
                  )}`}
                />
                <Meter
                  label={t("sysmon.swpLabel")}
                  pct={
                    snap.swap_total_kib > 0
                      ? memPercent(snap.swap_total_kib - snap.swap_free_kib, snap.swap_total_kib)
                      : 0
                  }
                  caption={
                    snap.swap_total_kib > 0
                      ? `${formatKib(snap.swap_total_kib - snap.swap_free_kib)} / ${formatKib(
                          snap.swap_total_kib,
                        )}`
                      : t("sysmon.noneLabel")
                  }
                />
                <div className="sysmon-stats">
                  <span>
                    {t("sysmon.availLabel")} <b>{formatKib(snap.mem_available_kib)}</b>
                  </span>
                  <span>
                    {t("sysmon.usedLabel")}{" "}
                    <b>
                      {memPercent(
                        snap.mem_total_kib - snap.mem_available_kib,
                        snap.mem_total_kib,
                      ).toFixed(0)}
                      %
                    </b>
                  </span>
                  {snap.swap_total_kib > 0 && (
                    <span>
                      {t("sysmon.swapFreeLabel")} <b>{formatKib(snap.swap_free_kib)}</b>
                    </span>
                  )}
                  {/* Hottest DIMM temperature, when the board wires an on-module
                      sensor (jc42/spd5118); omitted otherwise — most desktops have none. */}
                  {snap.mem_temp_c != null && (
                    <span>
                      {t("sysmon.memTempLabel")} <b>{formatTempC(snap.mem_temp_c)}</b>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* The GPU detail column: one card per adapter — VRAM + utilization
                meters and its live sensors — then (local only) the processes using
                GPU memory, listed once since the sources don't attribute them per
                card. Rendered only when the machine reports a GPU. */}
            {(snap.gpus ?? []).length > 0 && (
              <div className="sysmon-vitals-right">
                <div className="sysmon-group-title">
                  GPU
                  <span className="sysmon-group-sub">
                    {t(
                      (snap.gpus ?? []).length === 1 ? "sysmon.adapterOne" : "sysmon.adapterMany",
                      { count: (snap.gpus ?? []).length },
                    )}
                  </span>
                </div>
                {(snap.gpus ?? []).map((gpu, i) => (
                  <GpuSection key={`${gpu.name}-${i}`} gpu={gpu} />
                ))}
                <GpuProcList procs={gpuProcs} />
              </div>
            )}
          </div>

          {/* Logged-in sessions: who is actually logged in on this shared host
              right now (from `who`), grouped by user with a session count — the
              same "Logged in" panel the connect-time remote-usage dialog shows,
              rendered in its exact look. Remote-host only (a local snapshot carries
              no sessions), and distinct from "By user" below: this lists only users
              with an interactive login, that one every process owner. **You are
              always in it** — `who` reads utmp, which records a session only when
              sshd allocated a pty, and the monitor's own probe rides the pooled
              (non-PTY) master, so a host with no terminal tab open on it used to
              list every logged-in person *except* the reader; the backend now
              synthesizes that row (`LoginSession.is_self`) and it is pinned to the
              top with a "you" chip. The section is still shown when the list is
              empty — a host that couldn't even name the account has nothing to
              synthesize from — rather than silently dropped (which read as "only
              the primary has this panel"). */}
          {onHost && (
            <>
              <div className="sysmon-proc-head">
                <button
                  type="button"
                  className="sysmon-proc-toggle"
                  onClick={() => setSessionsOpen((v) => !v)}
                  aria-expanded={sessionsOpen}
                  title={sessionsOpen ? t("sysmon.collapseLoggedIn") : t("sysmon.expandLoggedIn")}
                >
                  <span className="sysmon-proc-caret">{sessionsOpen ? "▾" : "▸"}</span>
                  <span className="sysmon-group-title">{t("usage.loggedIn")}</span>
                  <UntestedTag id="systemMonitorPane.1" />
                </button>
                <span className="sysmon-count">
                  {t(
                    sessionRows.length === 1 ? "sysmon.userCountOne" : "sysmon.userCountMany",
                    { count: sessionRows.length },
                  )}
                </span>
              </div>
              {sessionsOpen &&
                (hasSessions ? (
                  <div className="sysmon-users">
                    <ul className="remote-usage-users">
                      <li className="remote-usage-users-head" aria-hidden="true">
                        <span>{t("usage.userCol")}</span>
                        <span>{t("usage.cpu")}</span>
                        <span>{t("usage.sessionsCol")}</span>
                        <span>{t("usage.memCol")}</span>
                      </li>
                      {sessionRows.map((s) => (
                        <li key={s.user}>
                          <span className="remote-usage-user">
                            {s.user}
                            {s.isSelf && (
                              <span
                                className="remote-usage-user-you"
                                title={t("sysmon.youChipTitle")}
                              >
                                {t("sysmon.youChip")}
                              </span>
                            )}
                          </span>
                          <span className="remote-usage-user-cpu">
                            <UsageLight pct={s.cpu} />
                            {s.cpu.toFixed(0)}%
                          </span>
                          <span className="remote-usage-user-sessions">{s.sessions}</span>
                          <span className="remote-usage-user-mem">{s.mem.toFixed(0)}%</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="sysmon-users sysmon-users-empty">
                    {t("usage.noInteractiveLogins")}
                  </div>
                ))}
            </>
          )}

          {/* Per-user breakdown: who is loading the machine, summed over the whole
              process table. Shown for a **remote host only** — it exists to answer
              "who else is on this shared machine?", the same question the
              connect-time usage dialog's session stats answer, and it is rendered
              in that dialog's exact look (the `.remote-usage-users` grid + its
              traffic-light dot). Local sampling is always just this user, so the
              panel would be a single trivial row — hidden there. Still gated on the
              host resolving process owners (Linux only; never Windows/macOS). */}
          {onHost && hasUserData && (
            <>
              <div className="sysmon-proc-head">
                <button
                  type="button"
                  className="sysmon-proc-toggle"
                  onClick={() => setUsersOpen((v) => !v)}
                  aria-expanded={usersOpen}
                  title={usersOpen ? t("sysmon.collapseByUser") : t("sysmon.expandByUser")}
                >
                  <span className="sysmon-proc-caret">{usersOpen ? "▾" : "▸"}</span>
                  <span className="sysmon-group-title">{t("sysmon.byUser")}</span>
                  <UntestedTag id="systemMonitorPane.2" />
                </button>
                <span className="sysmon-count">
                  {t(userRows.length === 1 ? "sysmon.userCountOne" : "sysmon.userCountMany", {
                    count: userRows.length,
                  })}
                </span>
              </div>
              {usersOpen && (
                <div className="sysmon-users">
                  <ul className="remote-usage-users">
                    <li className="remote-usage-users-head" aria-hidden="true">
                      <span>{t("usage.userCol")}</span>
                      <span>{t("usage.cpu")}</span>
                      <span>{t("sysmon.procsCol")}</span>
                      <span>{t("usage.memCol")}</span>
                    </li>
                    {userRows.map((u) => (
                      <li key={u.user}>
                        <span className="remote-usage-user">{u.user}</span>
                        <span className="remote-usage-user-cpu">
                          <UsageLight pct={u.cpu} />
                          {u.cpu.toFixed(0)}%
                        </span>
                        <span className="remote-usage-user-sessions">{u.count}</span>
                        <span className="remote-usage-user-mem">{u.mem.toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* The Processes group: its own titled header, collapsible via the caret
              so the vitals above can own the pane when the table isn't needed. */}
          <div className="sysmon-proc-head">
            <button
              type="button"
              className="sysmon-proc-toggle"
              onClick={() => setProcOpen((v) => !v)}
              aria-expanded={procOpen}
              title={procOpen ? t("sysmon.collapseProcesses") : t("sysmon.expandProcesses")}
            >
              <span className="sysmon-proc-caret">{procOpen ? "▾" : "▸"}</span>
              <span className="sysmon-group-title">{t("sysmon.processes")}</span>
            </button>
            <span className="sysmon-count">
              {t(rows.length === 1 ? "sysmon.processCountOne" : "sysmon.processCountMany", {
                count: rows.length,
              })}
            </span>
          </div>

          {procOpen && (
            <>
          <div className="sysmon-toolbar">
            <input
              className="sysmon-filter"
              placeholder={t("sysmon.filterPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="sysmon-table-wrap">
            <table className="sysmon-table">
              <thead>
                <tr>
                  <th className={`num ${sortedCls("pid") ?? ""}`} onClick={() => toggleSort("pid")}>
                    PID{arrow("pid")}
                  </th>
                  <th className={`num ${sortedCls("cpu") ?? ""}`} onClick={() => toggleSort("cpu")}>
                    CPU%{arrow("cpu")}
                  </th>
                  <th className={`num ${sortedCls("mem") ?? ""}`} onClick={() => toggleSort("mem")}>
                    MEM%{arrow("mem")}
                  </th>
                  <th
                    className={`num ${sortedCls("rss_kib") ?? ""}`}
                    onClick={() => toggleSort("rss_kib")}
                  >
                    RSS{arrow("rss_kib")}
                  </th>
                  <th
                    className={`num ${sortedCls("threads") ?? ""}`}
                    onClick={() => toggleSort("threads")}
                  >
                    THR{arrow("threads")}
                  </th>
                  <th className="st">S</th>
                  <th className={`cmd ${sortedCls("comm") ?? ""}`} onClick={() => toggleSort("comm")}>
                    {t("sysmon.commandCol")}{arrow("comm")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pid}>
                    <td className={`num ${sortedCls("pid") ?? ""}`}>{r.pid}</td>
                    <td
                      className={`num ${sortedCls("cpu") ?? ""}`}
                      style={{ color: toneFor(Math.min(100, r.cpu)) }}
                    >
                      {r.cpu.toFixed(1)}
                    </td>
                    <td
                      className={`num ${sortedCls("mem") ?? ""}`}
                      style={{ color: toneFor(r.mem) }}
                    >
                      {r.mem.toFixed(1)}
                    </td>
                    <td className={`num ${sortedCls("rss_kib") ?? ""}`}>{formatKib(r.rss_kib)}</td>
                    <td className={`num ${sortedCls("threads") ?? ""}`}>{r.threads}</td>
                    <td className="st">{r.state}</td>
                    <td className={`cmd ${sortedCls("comm") ?? ""}`} title={r.cmdline}>
                      {r.cmdline}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SYSMON_CSS = `
.sysmon-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  color: var(--text-primary);
  font-size: 12px;
  overflow: hidden;
}
.sysmon-placeholder {
  margin: auto;
  color: var(--text-muted);
  padding: 24px;
  text-align: center;
}
.sysmon-source {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  flex: 0 0 auto;
}
/* The machine tabs wrap among themselves; the mode switch stays pinned to the
   right edge of the row rather than wrapping into the middle of them. */
.sysmon-source-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.sysmon-source-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--radius, 4px);
  color: var(--text-secondary);
  padding: 3px 12px;
  font-size: 12px;
  cursor: var(--cur-pointer, pointer);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sysmon-source-btn:hover {
  background: var(--control-hover-bg);
}
.sysmon-source-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast, #fff);
}
/* The light/detailed switch, at the right end of the machine row.
   Deliberately NOT the machine buttons' style: those are square, accent-filled
   tabs answering "which machine am I looking at", and a second set of the same
   thing beside them would read as three more machines. This is one recessed pill
   track with the live half raised out of it — a switch, not a tab strip — and it
   carries no accent fill at all, so the accent in this row always means "the
   machine you are looking at". */
.sysmon-mode {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--bg-subtle);
  border: 1px solid var(--control-border);
}
.sysmon-mode-btn {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 999px;
  color: var(--text-muted);
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.4;
  cursor: var(--cur-pointer, pointer);
  white-space: nowrap;
}
.sysmon-mode-btn:hover {
  color: var(--text-primary);
}
/* The selected half, marked three ways at once because the icons are small and
   the labels are hidden until hover: it is raised out of the track, ringed in
   the accent, and its icon is the only one in colour. */
.sysmon-mode-btn.active {
  background: var(--bg-panel);
  color: var(--text-primary);
  box-shadow:
    0 0 0 1px var(--accent),
    0 1px 2px rgba(0, 0, 0, 0.25);
}
/* An unselected icon is greyed and dimmed, so at a glance exactly one of the two
   is lit — the "which of these am I in?" question answered without reading. */
.sysmon-mode-icon {
  filter: grayscale(1);
  opacity: 0.45;
  transition:
    filter 0.14s ease,
    opacity 0.14s ease;
}
.sysmon-mode-btn:hover .sysmon-mode-icon {
  opacity: 0.8;
}
.sysmon-mode-btn.active .sysmon-mode-icon {
  filter: none;
  opacity: 1;
}
/* The selected half keeps its label; the other reveals one on hover (or while it
   holds focus, so the keyboard path can read what it is about to choose).
   Width, not display: the row must not jump between two layouts as the pointer
   crosses it — the hidden label grows in place. */
.sysmon-mode-txt {
  display: inline-block;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  white-space: nowrap;
  transition:
    max-width 0.14s ease,
    opacity 0.14s ease,
    margin-left 0.14s ease;
}
.sysmon-mode-btn.active .sysmon-mode-txt,
.sysmon-mode:hover .sysmon-mode-txt,
.sysmon-mode:focus-within .sysmon-mode-txt {
  max-width: 80px;
  opacity: 1;
  margin-left: 5px;
}
/* The single scroll region: the vitals and the process table scroll together under
   ONE scrollbar. The table's sticky thead pins to this scroller. */
.sysmon-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
/* The HPC-host notice, above the vitals: an explanation, not a warning — the
   pane is working exactly as it should, it is simply collecting less. Toned like
   the app's other informational strips (accent-tinted left edge, muted text). */
.sysmon-careful-note {
  margin: 10px 12px 0;
  padding: 8px 10px;
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text-secondary, inherit);
  font-size: 11px;
  line-height: 1.5;
}
.sysmon-careful-note b {
  color: var(--text-primary, inherit);
}
/* The vitals region: a left column (CPU over Memory) and a right column (GPU),
   sitting above the process table. */
.sysmon-vitals {
  display: flex;
  gap: 18px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
  align-items: flex-start;
}
.sysmon-vitals-left {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 340px;
  min-width: 240px;
}
/* The GPU column, divided from the CPU/Memory column. The border reads as a
   horizontal rule between them when the pane is narrow enough to wrap the GPU
   below, and as a leading edge beside them when they sit side by side. */
.sysmon-vitals-right {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 300px;
  min-width: 260px;
  border-top: 1px solid var(--border-color);
  padding-top: 10px;
}
/* CPU, Memory, and GPU each read as a titled block so the domains are never
   mistaken for one undifferentiated wall of meters. */
.sysmon-group-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sysmon-group-sub {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-muted);
}
/* CPU + Memory stack vertically inside the left column, so neither carries a
   horizontal flex basis — they take the column's full width. */
.sysmon-cpu-group,
.sysmon-mem-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sysmon-cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 2px 12px;
}
.sysmon-meter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.sysmon-meter-label {
  color: var(--text-muted);
  min-width: 28px;
  text-align: right;
}
.sysmon-meter-bar {
  flex: 1;
  height: 8px;
  background: var(--control-bg);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  overflow: hidden;
}
.sysmon-meter-fill {
  display: block;
  height: 100%;
  transition: width 0.3s linear;
}
.sysmon-meter-caption {
  color: var(--text-secondary);
  min-width: 44px;
  text-align: right;
}
.sysmon-stats {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 2px;
  color: var(--text-muted);
}
.sysmon-stats b {
  color: var(--text-primary);
  font-weight: 600;
}
/* One card per adapter, stacked full-width down the right column. */
.sysmon-gpu {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius, 4px);
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
}
.sysmon-gpu-head {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sysmon-gpu-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sysmon-gpu-meta {
  color: var(--text-muted);
  font-size: 11px;
}
.sysmon-gpu-meters {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sysmon-gpu-sensors {
  margin-top: 0;
  gap: 12px;
}
.sysmon-sensor-na {
  color: var(--text-muted);
  font-weight: 400;
}
.sysmon-gpu-procs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  padding: 8px 10px;
}
.sysmon-gpu-procs-head {
  color: var(--text-secondary);
  font-weight: 600;
  margin-bottom: 3px;
}
.sysmon-gpu-proc {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}
.sysmon-gpu-proc-mem {
  min-width: 62px;
  text-align: right;
  color: var(--text-primary);
  font-weight: 600;
}
.sysmon-gpu-proc-pid {
  min-width: 52px;
  text-align: right;
  color: var(--text-muted);
}
.sysmon-gpu-proc-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The Processes group header: caret toggle + title on the left, count on the right. */
.sysmon-proc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
}
.sysmon-proc-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  padding: 0;
  cursor: var(--cur-pointer, pointer);
  color: inherit;
}
.sysmon-proc-caret {
  color: var(--text-muted);
  font-size: 10px;
  width: 12px;
  text-align: center;
}
.sysmon-proc-toggle:hover .sysmon-group-title,
.sysmon-proc-toggle:hover .sysmon-proc-caret {
  color: var(--text-primary);
}
.sysmon-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px 6px;
  flex: 0 0 auto;
}
.sysmon-filter {
  flex: 1;
  max-width: 340px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--radius, 4px);
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}
.sysmon-filter:focus {
  border-color: var(--accent);
}
.sysmon-count {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.sysmon-table-wrap {
  /* Natural height — the whole body scrolls in the shared .sysmon-scroll region,
     and the table's sticky thead pins to that scroller. */
}
.sysmon-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.sysmon-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  /* The SOLID header tone, not --bg-header: that is a gradient in the fancy
     themes, so each th would repaint the whole ramp and the .sorted color-mix
     below would be invalid — i.e. a transparent sticky header. */
  background: var(--bg-header-solid, var(--bg-panel));
  color: var(--text-secondary);
  text-align: left;
  font-weight: 600;
  padding: 5px 10px;
  cursor: var(--cur-pointer, pointer);
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
  user-select: none;
}
/* The active sort column reads as a distinct vertical band, not just a tinted
   header: a strong accent header and an accent-tinted column body, both bracketed
   by 2px accent edge-lines drawn with an inset box-shadow (so the band gains no
   width and the columns stay aligned). */
.sysmon-table th.sorted {
  background: color-mix(in srgb, var(--accent) 30%, var(--bg-header-solid));
  color: var(--text-primary);
  font-weight: 700;
  box-shadow: inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent);
}
.sysmon-table td.sorted {
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-panel));
  box-shadow: inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent);
}
.sysmon-table th.num,
.sysmon-table td.num {
  text-align: right;
}
.sysmon-table th.st,
.sysmon-table td.st {
  text-align: center;
  color: var(--text-muted);
}
.sysmon-table td {
  padding: 3px 10px;
  white-space: nowrap;
}
.sysmon-table td.cmd {
  max-width: 640px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}
.sysmon-table tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
.sysmon-table tbody tr:hover {
  background: var(--control-hover-bg);
}
/* The per-user breakdown borrows the remote-usage dialog's .remote-usage-users
   grid wholesale (defined in themes.css), so this only positions that panel —
   an indented block below the vitals, not the full-width process scroller. */
.sysmon-users {
  padding: 0 12px 8px;
}
.sysmon-users-empty {
  color: var(--text-muted);
  font-style: italic;
}
`;

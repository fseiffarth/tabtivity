//! Lightweight per-process CPU/memory sampling for the project resource readout.
//!
//! Used to surface a project's live CPU/RSS usage in the project-switcher pill
//! popup. A project's "processes" are the PTY child shells plus every descendant
//! they have spawned (an agent CLI, its subprocesses, etc.), so usage reflects
//! the whole working tree rooted at the project's terminals.
//!
//! The platform-neutral layer (process-tree cache + BFS, sum helpers) is shared;
//! the actual sampling is delegated to a per-OS [`platform`] backend:
//! - **Linux** reads `/proc` (`stat`/`status`/`cmdline`).
//! - **Windows** uses ToolHelp snapshots + `GetProcessTimes`/`GetProcessMemoryInfo`.
//! - **Any other OS** falls back to empty/zero results, so callers degrade to a
//!   `0` readout instead of failing to build.
//!
//! CPU time is reported in opaque "ticks": [`sum_jiffies`] returns a tick count
//! and [`clk_tck`] the ticks-per-second, so the caller's
//! `busy_secs = ticks / clk_tck()` formula is correct on every backend (Linux
//! jiffies + USER_HZ; Windows 100-ns units + 10_000_000).

use crate::brand::UPPER;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cumulative CPU jiffies for one core (or the machine aggregate), as read from
/// `/proc/stat`. `busy = total − idle − iowait`. CPU **percentages** are derived
/// on the frontend from the delta of two successive snapshots
/// (`(busy_now − busy_prev) / (total_now − total_prev)`), so these counters carry
/// no timestamp of their own — the ratio is wall-clock-independent.
#[derive(Serialize, Clone, Copy, Default)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

/// One process in a [`SystemSnapshot`]. `cpu_jiffies` is the cumulative
/// utime+stime; the frontend turns successive samples into a live CPU%.
#[derive(Serialize, Clone, Default)]
pub struct ProcSample {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String,
    pub cmdline: String,
    pub state: String,
    pub rss_kib: u64,
    pub cpu_jiffies: u64,
    pub threads: u32,
    /// Owning user's name, resolved from the machine's own passwd database
    /// (`/etc/passwd` locally, `getent passwd` on a remote host) so the pane can
    /// group the process table by user — the same per-user "who's loading the
    /// host" statistic the connect-time usage dialog shows. Empty when the
    /// backend can't resolve an owner (Windows/macOS, an unmapped uid), which the
    /// frontend reads as "no per-user data" and hides the section. An unmapped
    /// uid falls back to `#<uid>` rather than an empty string.
    #[serde(default)]
    pub user: String,
}

/// One interactive login session on the sampled host, from `who`. Mirrors the
/// connect-time remote-usage dialog's `UserSession`: `user` is the login name,
/// `tty` the terminal, `detail` the rest of the `who` line verbatim (login time,
/// origin `(host)`). Populated **only on the remote path** — the local pane never
/// shows the "Logged in" panel, since local sampling is always just this user.
#[derive(Serialize, Clone, Default)]
pub struct LoginSession {
    pub user: String,
    pub tty: String,
    pub detail: String,
    /// Whether this session belongs to the account Tabtivity is sampling *as* (the
    /// host's `ME` line — see [`parse_who`]). The pane marks the row "you"; it is
    /// also what lets the sampling account appear at all on a host where `who`
    /// has no record of it (the synthesized row below).
    #[serde(default)]
    pub is_self: bool,
}

/// A single whole-system sample backing the htop-like monitor pane. Everything
/// here is a *cumulative* counter or an instantaneous gauge; the pane computes
/// per-core and per-process CPU% by diffing two of these (see the module notes on
/// [`CpuTimes`]). `supported` is `false` on platforms without a `/proc`-style
/// enumeration, letting the UI show a graceful "Linux only" placeholder.
#[derive(Serialize, Clone, Default)]
pub struct SystemSnapshot {
    pub supported: bool,
    pub clk_tck: u64,
    pub num_cores: u32,
    pub cpu: CpuTimes,
    pub per_core: Vec<CpuTimes>,
    pub mem_total_kib: u64,
    pub mem_available_kib: u64,
    pub swap_total_kib: u64,
    pub swap_free_kib: u64,
    pub load_avg: [f64; 3],
    pub uptime_secs: f64,
    pub processes: Vec<ProcSample>,
    /// Every GPU the machine will report memory for; empty when none can be read
    /// (macOS, an Intel-only box, no `nvidia-smi`). See [`crate::gpustat`].
    pub gpus: Vec<crate::gpustat::GpuSample>,
    /// Per-process GPU memory. Populated only on the **remote** path (sampled on
    /// the host alongside the snapshot); the local pane fills it from the dedicated
    /// `gpu_process_snapshot` command instead, so this stays empty locally.
    #[serde(default)]
    pub gpu_procs: Vec<crate::gpustat::GpuProc>,
    /// Whole-package CPU temperature in °C, when a CPU hwmon sensor exposes one
    /// (`coretemp` on Intel, `k10temp`/`zenpower` on AMD Zen). `None` when no such
    /// sensor is present, or on a backend that can't read one (Windows/macOS/other)
    /// — never a fake zero, matching the GPU sensors.
    #[serde(default)]
    pub cpu_temp_c: Option<f64>,
    /// Hottest DIMM temperature in °C, when the board exposes an on-module thermal
    /// sensor (`jc42` on DDR3/DDR4, `spd5118` on DDR5). The *max* across modules, so
    /// it reads as "how hot is memory". `None` when no such sensor is present (most
    /// desktops don't wire one) or the backend can't read one — never a fake zero.
    #[serde(default)]
    pub mem_temp_c: Option<f64>,
    /// Interactive login sessions on the host (from `who`), backing the pane's
    /// "Logged in" panel — the same per-user session view the connect-time
    /// remote-usage dialog shows. Populated only on the **remote** path; empty
    /// locally (the panel is remote-only, since local sampling is always just this
    /// user, so it would be a single trivial row).
    #[serde(default)]
    pub sessions: Vec<LoginSession>,
    /// Whether the sample was taken in **careful mode** — the reduced collection
    /// an HPC login node's usage rules require (see [`REMOTE_SNAPSHOT_SCRIPT`]
    /// and `docs/context/hpc_careful_mode.md`). Decided by the *host* (SLURM on
    /// `PATH`), so the pane learns it from the first sample rather than being
    /// told; it then polls more gently and says what it is (and isn't) showing.
    /// Always `false` for a local sample — this machine is the user's own.
    #[serde(default)]
    pub careful: bool,
}

/// The machine's aggregate load **without** the process table: what a readout
/// that only asks "how loaded is this box, and what is left" needs (the 🧠
/// local-model menu's headroom block). A [`SystemSnapshot`] answers that too, but
/// it costs one `/proc/<pid>/{stat,status,cmdline}` read per process plus a JSON
/// payload of the whole table — a price a hover menu polling every two seconds
/// must not pay, and which is why this is a separate sampler rather than a
/// filtered snapshot.
///
/// `cpu` is cumulative, exactly like [`SystemSnapshot::cpu`]: a percentage is the
/// ratio of two samples' deltas. Unlike the monitor pane, the caller here doesn't
/// diff — `commands::monitor::machine_load_snapshot` takes both samples itself,
/// since a hover menu is often closed again before a second poll would land.
#[derive(Serialize, Clone, Copy, Default)]
pub struct MachineLoad {
    /// `false` on a target with no aggregate CPU/memory backend, so the UI can
    /// omit the block rather than print zeros as if they were measurements.
    pub supported: bool,
    pub num_cores: u32,
    pub cpu: CpuTimes,
    pub mem_total_kib: u64,
    pub mem_available_kib: u64,
    pub swap_total_kib: u64,
    pub swap_free_kib: u64,
    pub load_avg: [f64; 3],
    /// Whole-package CPU temperature; `None` where no sensor is readable — never
    /// a fake zero, matching [`SystemSnapshot::cpu_temp_c`].
    pub cpu_temp_c: Option<f64>,
    /// Hottest DIMM temperature; `None` where no on-module sensor is readable —
    /// most boards wire none, so absent is the ordinary case, not a failure.
    /// Same rule as [`SystemSnapshot::mem_temp_c`]: never a fake zero.
    pub mem_temp_c: Option<f64>,
}

/// One aggregate-only sample of this machine (see [`MachineLoad`]). Local only —
/// a remote host's load rides `system_monitor_snapshot`'s one SSH round trip.
pub fn machine_load() -> MachineLoad {
    platform::machine_load()
}

/// Generation counter bumped whenever a PTY is spawned or dies (see
/// [`invalidate_descendant_cache`]). A change forces [`descendant_pids`] to
/// rebuild its cached process tree instead of reusing the previous walk.
static PROC_TREE_GEN: AtomicU64 = AtomicU64::new(0);

/// One cache entry for [`descendant_pids`], keyed by the (sorted) root pid set.
/// Holds the generation it was built at and a freshness deadline; reused only
/// while both the generation is unchanged *and* the entry is younger than
/// [`CACHE_TTL`].
struct DescendantCache {
    roots: Vec<u32>,
    pids: Vec<u32>,
    generation: u64,
    computed_at: Instant,
}

/// A **small keyed set**, not a single slot: several callers sample with
/// different root sets on overlapping timers (a hovered project pill and the
/// renderer watchdog are the concrete pair), and a single entry meant each one
/// evicted the other every sample — every hit became a full process-table walk.
/// A handful of entries under the same TTL/generation rules keeps concurrent
/// samplers all warm.
static DESCENDANT_CACHE: Mutex<Vec<DescendantCache>> = Mutex::new(Vec::new());

/// How many distinct root sets keep a live entry at once. Two is the observed
/// concurrent floor (pill hover + watchdog); four adds headroom for another
/// hover or monitor pane without letting the lookup scan grow.
const CACHE_ENTRIES: usize = 4;

/// Upper bound on cache reuse even if no spawn/death bumped the generation: a
/// process tree can grow/shrink without Tabtivity spawning the PTY directly (an
/// agent forking children), so a short TTL keeps the readout from going stale.
const CACHE_TTL: Duration = Duration::from_millis(1500);

/// Invalidate the cached descendant-pid set. Called by the PTY layer on every
/// spawn and death so the next CPU sample reflects the new process tree without
/// waiting for the TTL. Cheap: a single atomic increment.
pub fn invalidate_descendant_cache() {
    PROC_TREE_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Ticks per second for the current backend (Linux USER_HZ, Windows 100-ns
/// units). Used to convert [`sum_jiffies`] ticks → seconds.
pub fn clk_tck() -> u64 {
    platform::clk_tck()
}

/// All pids that are `roots` or descendants of a root, deduplicated.
///
/// Resolving the tree means enumerating every process, which is the per-sample
/// hot path. To avoid repeating that on every CPU sample (e.g. each pill hover),
/// the result is cached keyed by the (sorted) root set. The cache is reused while
/// (a) the spawn/death generation counter is unchanged — the PTY layer calls
/// [`invalidate_descendant_cache`] on every spawn/death — and (b) the entry is
/// younger than [`CACHE_TTL`], a backstop for tree changes Tabtivity didn't trigger
/// directly (an agent forking its own children).
pub fn descendant_pids(roots: &[u32]) -> Vec<u32> {
    if roots.is_empty() {
        return Vec::new();
    }
    let mut key = roots.to_vec();
    key.sort_unstable();
    key.dedup();

    let generation = PROC_TREE_GEN.load(Ordering::Relaxed);
    {
        let cache = DESCENDANT_CACHE.lock().unwrap();
        if let Some(entry) = cache.iter().find(|e| {
            e.generation == generation && e.roots == key && e.computed_at.elapsed() < CACHE_TTL
        }) {
            return entry.pids.clone();
        }
    }

    let pids = compute_descendant_pids(&key);

    let mut cache = DESCENDANT_CACHE.lock().unwrap();
    // A spawn/death or the TTL stales every entry at once (they all describe
    // the one process table), so dead entries are pruned wholesale — along
    // with any previous entry for this key, which the push below replaces.
    cache.retain(|e| {
        e.generation == generation && e.computed_at.elapsed() < CACHE_TTL && e.roots != key
    });
    while cache.len() >= CACHE_ENTRIES {
        let oldest = cache
            .iter()
            .enumerate()
            .min_by_key(|(_, e)| e.computed_at)
            .map(|(i, _)| i)
            .unwrap_or(0);
        cache.remove(oldest);
    }
    cache.push(DescendantCache {
        roots: key,
        pids: pids.clone(),
        generation,
        computed_at: Instant::now(),
    });
    pids
}

/// Build a pid → ppid map from the backend, then collect every pid whose ancestor
/// chain reaches one of the roots. The uncached core of [`descendant_pids`].
fn compute_descendant_pids(roots: &[u32]) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};

    let parent = platform::parent_map();

    // children adjacency for a single BFS pass.
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in &parent {
        children.entry(ppid).or_default().push(pid);
    }

    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &root in roots {
        if seen.insert(root) {
            queue.push_back(root);
        }
    }
    while let Some(pid) = queue.pop_front() {
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                if seen.insert(kid) {
                    queue.push_back(kid);
                }
            }
        }
    }
    seen.into_iter().collect()
}

/// Sum of busy CPU ticks across `pids` (Linux utime+stime jiffies; Windows
/// kernel+user 100-ns units). Dead pids are skipped.
pub fn sum_jiffies(pids: &[u32]) -> u64 {
    pids.iter()
        .filter_map(|&pid| platform::proc_ticks(pid))
        .sum()
}

/// Sum resident memory across `pids`, in KiB. Dead pids are skipped.
pub fn sum_rss_kib(pids: &[u32]) -> u64 {
    pids.iter().filter_map(|&pid| platform::rss_kib(pid)).sum()
}

/// One process's resident memory split by what backs it, as `/proc/<pid>/status`
/// reports it. The split is what a "this renderer is at 4 GB" line needs to be
/// actionable: `anon` is heap (JS objects, decoded images, canvas backing
/// stores), `file` is mapped libraries and caches, `shmem` is shared memory
/// (compositor buffers, IPC). A watchdog that only knows the total cannot tell
/// a JS-heap leak from a graphics one, and the two are fixed in different places.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RssBreakdown {
    pub rss_kib: u64,
    pub anon_kib: u64,
    pub file_kib: u64,
    pub shmem_kib: u64,
}

/// Parse the `Rss*` fields out of a `/proc/<pid>/status` body. Fields a kernel
/// does not report (pre-4.5 has no `RssAnon`) stay zero.
pub fn parse_rss_breakdown(status: &str) -> RssBreakdown {
    let mut out = RssBreakdown::default();
    for line in status.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let slot = match key.trim() {
            "VmRSS" => &mut out.rss_kib,
            "RssAnon" => &mut out.anon_kib,
            "RssFile" => &mut out.file_kib,
            "RssShmem" => &mut out.shmem_kib,
            _ => continue,
        };
        if let Some(v) = rest.split_whitespace().next().and_then(|v| v.parse().ok()) {
            *slot = v;
        }
    }
    out
}

/// The `Threads:` count out of a `/proc/<pid>/status` body.
pub fn parse_threads(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .and_then(|rest| rest.trim().parse().ok())
}

/// The thread count of one live process. `/proc`-only, like [`process_memory`].
#[cfg(target_os = "linux")]
pub fn process_threads(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    parse_threads(&status)
}

#[cfg(not(target_os = "linux"))]
pub fn process_threads(_pid: u32) -> Option<u32> {
    None
}

/// Resident size per mapping *name* from a `/proc/<pid>/smaps` body, largest
/// first, at most `top` entries. Anonymous mappings (no name) are pooled under
/// `[anon]`; everything else keeps the kernel's name (`[heap]`, a library path,
/// `memfd:…`), so the answer names the kind of memory rather than a region.
pub fn aggregate_smaps_rss(smaps: &str, top: usize) -> Vec<(String, u64)> {
    let mut by_name: HashMap<String, u64> = HashMap::new();
    let mut current = String::from("[anon]");
    for line in smaps.lines() {
        // A mapping header starts with its hex address range; every other line is
        // a `Key: value kB` field. `Rss:` is the one we sum.
        let is_header = line
            .split_once('-')
            .is_some_and(|(lo, _)| !lo.is_empty() && lo.bytes().all(|b| b.is_ascii_hexdigit()));
        if is_header {
            // `addr perms offset dev inode [name…]` — the name may contain spaces.
            let mut fields = line.splitn(6, char::is_whitespace);
            let name = fields.nth(5).map(str::trim).unwrap_or("");
            current = if name.is_empty() { "[anon]".to_string() } else { name.to_string() };
            continue;
        }
        if let Some(rest) = line.strip_prefix("Rss:") {
            if let Some(kib) = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()) {
                *by_name.entry(current.clone()).or_insert(0) += kib;
            }
        }
    }
    let mut rows: Vec<(String, u64)> = by_name.into_iter().filter(|(_, kib)| *kib > 0).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.truncate(top);
    rows
}

/// The breakdown and the largest mappings of one live process. `/proc`-only:
/// elsewhere there is nothing comparable to read, and `None` says so.
#[cfg(target_os = "linux")]
pub fn process_memory(pid: u32, top: usize) -> Option<(RssBreakdown, Vec<(String, u64)>)> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let breakdown = parse_rss_breakdown(&status);
    // smaps is large for a browser process (thousands of mappings) and is read
    // only on the watchdog's own schedule, never per poll.
    let smaps = std::fs::read_to_string(format!("/proc/{pid}/smaps")).unwrap_or_default();
    Some((breakdown, aggregate_smaps_rss(&smaps, top)))
}

/// Windows: the working set and its private share, via `GetProcessMemoryInfo`.
///
/// `anon` here is the **private working set** (`PROCESS_MEMORY_COUNTERS_EX2`,
/// Windows 10 20H1+): resident pages no other process shares — the heap, in the
/// sense the watchdog cares about. `file` is the rest of the working set (mapped
/// images and shareable pages), `shmem` the shared commit charge. On an older
/// Windows the EX2 layout is refused, and the split falls back to the commit
/// charge (`PrivateUsage`) clipped to the working set — an upper bound on the
/// private share rather than a measurement, so the two are labelled apart in the
/// mapping list. There is no per-mapping resident size short of walking
/// `VirtualQueryEx` over the whole address space, so `top` is the one-line
/// summary of which figure was used instead.
#[cfg(target_os = "windows")]
pub fn process_memory(pid: u32, top: usize) -> Option<(RssBreakdown, Vec<(String, u64)>)> {
    let (breakdown, source) = platform::memory_breakdown(pid)?;
    let mut rows = vec![
        (source.to_string(), breakdown.anon_kib),
        ("[working set: shared/mapped]".to_string(), breakdown.file_kib),
    ];
    rows.retain(|(_, kib)| *kib > 0);
    rows.truncate(top);
    Some((breakdown, rows))
}

/// macOS: the resident set and the physical footprint, via `proc_pid_rusage`.
///
/// `anon` is the process's **physical footprint** (its own dirty + compressed
/// pages, the figure Activity Monitor's "Memory" column shows) clipped to the
/// resident size; `file` is the remainder of the resident set (clean mapped
/// pages). The kernel exposes no per-mapping resident sizes for another
/// process without `task_for_pid`, so `top` carries the same two-line summary as
/// the Windows arm.
#[cfg(target_os = "macos")]
pub fn process_memory(pid: u32, top: usize) -> Option<(RssBreakdown, Vec<(String, u64)>)> {
    let breakdown = platform::memory_breakdown(pid)?;
    let mut rows = vec![
        ("[physical footprint]".to_string(), breakdown.anon_kib),
        ("[resident: clean/mapped]".to_string(), breakdown.file_kib),
    ];
    rows.retain(|(_, kib)| *kib > 0);
    rows.truncate(top);
    Some((breakdown, rows))
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn process_memory(_pid: u32, _top: usize) -> Option<(RssBreakdown, Vec<(String, u64)>)> {
    None
}

/// Parent pid for a live process, if resolvable on this backend.
pub fn ppid(pid: u32) -> Option<u32> {
    platform::ppid(pid)
}

/// Command line for a live process, if resolvable on this backend.
pub fn cmdline(pid: u32) -> Option<String> {
    platform::cmdline(pid)
}

/// Every live process's parent, one uncached walk of the process table. For a
/// caller that needs many subtrees at once and would otherwise pay
/// [`descendant_pids`]'s full enumeration per root.
pub fn parent_map() -> HashMap<u32, u32> {
    platform::parent_map()
}

/// A whole-system sample (all processes + per-core CPU + memory/load) for the
/// htop-like monitor pane. Delegates to the per-OS backend; non-`/proc` targets
/// return `SystemSnapshot { supported: false, .. }`.
///
/// The GPUs are stapled on here rather than inside each backend: they are read
/// from a different place entirely ([`crate::gpustat`] — DRM sysfs or
/// `nvidia-smi`, both of which have their own per-OS story) and an empty list is
/// a legitimate answer on every platform, including a supported one.
pub fn system_snapshot() -> SystemSnapshot {
    let mut snapshot = platform::system_snapshot();
    snapshot.gpus = crate::gpustat::snapshot();
    snapshot
}

// ── Pure `/proc` parsers ─────────────────────────────────────────────────────
// Factored out of the Linux backend so they can be unit-tested from string
// fixtures without a live `/proc`. Compiled on *every* host OS (not just Linux)
// because `parse_remote_snapshot` reuses them to parse a remote Linux host's
// `/proc` fetched over SSH — the host is Linux even when this machine is not.

/// Parse one `cpu`/`cpuN` line of `/proc/stat` into cumulative busy/total ticks.
/// `total` is the sum of every column; `busy = total − idle − iowait`.
fn parse_cpu_line(line: &str) -> Option<CpuTimes> {
    let mut it = line.split_whitespace();
    it.next()?; // "cpu" / "cpuN" label
    let nums: Vec<u64> = it.filter_map(|t| t.parse::<u64>().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3];
    let iowait = nums.get(4).copied().unwrap_or(0);
    Some(CpuTimes {
        busy: total.saturating_sub(idle).saturating_sub(iowait),
        total,
    })
}

/// Parse `/proc/stat` into (aggregate, per-core) cumulative CPU times. The
/// aggregate is the `cpu ` line; each `cpuN` line is one core, in order.
fn parse_cpu_stat(content: &str) -> (CpuTimes, Vec<CpuTimes>) {
    let mut agg = CpuTimes::default();
    let mut per_core = Vec::new();
    for line in content.lines() {
        let Some(rest) = line.strip_prefix("cpu") else {
            continue;
        };
        match rest.chars().next() {
            Some(' ') => {
                if let Some(ct) = parse_cpu_line(line) {
                    agg = ct;
                }
            }
            Some(c) if c.is_ascii_digit() => {
                if let Some(ct) = parse_cpu_line(line) {
                    per_core.push(ct);
                }
            }
            _ => {}
        }
    }
    (agg, per_core)
}

/// Extract (MemTotal, MemAvailable, SwapTotal, SwapFree) from `/proc/meminfo`,
/// all in KiB. Missing keys default to 0.
fn parse_meminfo(content: &str) -> (u64, u64, u64, u64) {
    let get = |key: &str| -> u64 {
        content
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|r| r.split_whitespace().next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    (
        get("MemTotal:"),
        get("MemAvailable:"),
        get("SwapTotal:"),
        get("SwapFree:"),
    )
}

/// First three floats of `/proc/loadavg` (1/5/15-minute load averages).
fn parse_loadavg(content: &str) -> [f64; 3] {
    let mut it = content.split_whitespace();
    let mut next = || it.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    [next(), next(), next()]
}

/// Parse a `/proc/<pid>/stat` line into (comm, state, ppid, cpu_jiffies,
/// threads). `comm` sits between the first `(` and last `)` and may itself
/// contain spaces/parens, so fields are indexed *after* the last `)`:
/// index 0 = state (field 3), 1 = ppid (field 4), 11 = utime (14),
/// 12 = stime (15), 17 = num_threads (20).
fn parse_pid_stat(content: &str) -> Option<(String, String, u32, u64, u32)> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    let comm = content.get(open + 1..close)?.to_string();
    let fields: Vec<&str> = content.get(close + 1..)?.split_whitespace().collect();
    let state = (*fields.first()?).to_string();
    let ppid: u32 = fields.get(1)?.parse().ok()?;
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    let threads: u32 = fields.get(17)?.parse().ok()?;
    Some((comm, state, ppid, utime + stime, threads))
}

/// Parse `getent passwd` / `/etc/passwd` content into a uid → username map. Each
/// line is `name:passwd:uid:gid:gecos:home:shell`; only `name` (field 0) and
/// `uid` (field 2) are read, malformed lines skipped. The *first* name wins when
/// two entries share a uid (a deliberate alias), so the mapping is stable.
fn parse_passwd(content: &str) -> HashMap<u32, String> {
    let mut map: HashMap<u32, String> = HashMap::new();
    for line in content.lines() {
        let mut it = line.split(':');
        let name = it.next().unwrap_or("");
        let _passwd = it.next();
        let Some(uid) = it.next().and_then(|s| s.trim().parse::<u32>().ok()) else {
            continue;
        };
        if !name.is_empty() {
            map.entry(uid).or_insert_with(|| name.to_string());
        }
    }
    map
}

/// Resolve a numeric uid to a display name via a passwd map, falling back to
/// `#<uid>` for a uid the map doesn't cover (an NSS-only account the file walk
/// missed, or a process whose owner was removed) rather than an empty string.
/// The one label every foreign process carries in careful mode. Not a user name
/// and deliberately not a uid: the point is that a careful sample can say how
/// loaded the machine is without attributing any of that load to a person.
pub const OTHER_USERS: &str = "other users";

fn username_for(uid: u32, map: &HashMap<u32, String>) -> String {
    map.get(&uid).cloned().unwrap_or_else(|| format!("#{uid}"))
}

/// The `tty`/`detail` a synthesized self-session carries — the row that says "you
/// are on this host" when `who` has no record of the sampling account (see
/// [`parse_who`]). Not a terminal name, because there is no terminal: it is the
/// pooled SSH connection this very sample arrived over.
const SELF_SESSION_TTY: &str = "ssh";
const SELF_SESSION_DETAIL: &str = concat!("(this ", crate::app_name!(), " connection — no tty)");

/// Parse `who` output into one [`LoginSession`] per non-blank line. Each line is
/// `user  tty  <login-time> (<origin>)`; the first two whitespace fields are the
/// user and tty, everything after is kept verbatim as `detail`. Matches
/// `services::remote_usage::parse_who` so the pane's "Logged in" panel reads
/// identically to the connect-time dialog's.
///
/// `me` is the sampling account's login name **on that host** (the script's `ME`
/// line), and it is what fixes the panel's oldest oddity: it listed everyone
/// *except* the person reading it. `who` reports utmp, and utmp only gets an entry
/// when sshd allocates a **pty** — the monitor's own probe (and the pooled
/// ControlMaster behind it) runs without one, so unless the user happens to have an
/// interactive terminal tab open on that host, their own presence is invisible while
/// every other logged-in person shows. So a matching row is flagged `is_self`, and
/// when there is no matching row at all one is **synthesized**: the connection this
/// snapshot arrived over is a real session on that machine, it simply is not one
/// utmp records. On a careful (HPC) host, where `who` is pre-filtered to this
/// account, that synthesized row is also what turns a panel reading "no interactive
/// logins" into the truthful "you, and nothing collected about anyone else".
fn parse_who(content: &str, me: &str) -> Vec<LoginSession> {
    let mut sessions: Vec<LoginSession> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let user = parts.next()?.to_string();
            let tty = parts.next().unwrap_or("").to_string();
            let detail = parts.collect::<Vec<_>>().join(" ");
            let is_self = !me.is_empty() && user == me;
            Some(LoginSession {
                user,
                tty,
                detail,
                is_self,
            })
        })
        .collect();
    if !me.is_empty() && !sessions.iter().any(|s| s.is_self) {
        sessions.insert(
            0,
            LoginSession {
                user: me.to_string(),
                tty: SELF_SESSION_TTY.to_string(),
                detail: SELF_SESSION_DETAIL.to_string(),
                is_self: true,
            },
        );
    }
    sessions
}

/// hwmon `name` values that identify a CPU **package** temperature sensor: Intel
/// exposes `coretemp`, AMD Zen `k10temp` (or the out-of-tree `zenpower`), some
/// ARM/embedded boards `cpu_thermal`. Anything else (a GPU's `amdgpu`, a
/// mainboard SuperIO chip, an NVMe drive) is deliberately excluded — a wrong
/// sensor reported as "CPU" is worse than reporting none.
#[cfg(any(target_os = "linux", test))]
fn is_cpu_hwmon(name: &str) -> bool {
    matches!(
        name.trim(),
        "coretemp" | "k10temp" | "zenpower" | "cpu_thermal"
    )
}

/// hwmon `name` values that identify an on-DIMM **memory** temperature sensor:
/// `jc42` (the JEDEC JC42.4 sensor on DDR3/DDR4 modules) and `spd5118` (the DDR5
/// SPD-hub temperature sensor). One hwmon appears per populated module that has
/// one, so the reader takes the *hottest*. Anything else is excluded — a
/// mainboard/SuperIO channel mislabelled as memory would be worse than none.
#[cfg(any(target_os = "linux", test))]
fn is_mem_hwmon(name: &str) -> bool {
    matches!(name.trim(), "jc42" | "spd5118")
}

/// Choose the reading that best represents the whole CPU package from one hwmon's
/// temperature channels, each a `(label, milli_celsius)` pair. Prefers an explicit
/// package/control label — `Package id 0` (Intel `coretemp`), `Tctl`/`Tdie` (AMD
/// `k10temp`) — over a per-core channel; failing that, the first channel
/// (`temp1_input`), which is the package on a single-channel sensor. Returns °C
/// (millidegrees ÷ 1000), or `None` when there are no channels.
fn pick_cpu_temp(channels: &[(Option<String>, f64)]) -> Option<f64> {
    let preferred = channels.iter().find(|(label, _)| {
        label.as_deref().is_some_and(|l| {
            let l = l.trim();
            l.starts_with("Package") || l == "Tctl" || l == "Tdie"
        })
    });
    preferred
        .or_else(|| channels.first())
        .map(|(_, milli)| milli / 1000.0)
}

// ── Remote (`ssh`) whole-system snapshot ────────────────────────────────────
// A remote project's System Monitor reads the *host's* `/proc` over the shared
// ControlMaster, exactly as the Disk Usage pane reads the host's `du`. The
// snapshot shape is identical to the local one, so the frontend pane needs no
// per-source branch — only the pure parsers above, fed the host's `/proc` bytes.

/// POSIX-`sh` script run on the host (via `services::ssh_exec::run_remote_script`)
/// to capture one whole-system sample from its `/proc`.
///
/// **Constant** — `run_remote_script` embeds it verbatim (no quoting), so nothing
/// may be interpolated in; the only variable in that call is the `cd`-target
/// `remote_path`, which it quotes and which this script ignores. Output is
/// line-oriented and consumed by [`parse_remote_snapshot`]: a `CLK` line, then the
/// `@SECTION@` blocks carrying the raw kernel files verbatim. `@GPU@` carries the
/// host's GPUs — `NVSMI`/`NVPROC` lines are the `nvidia-smi` CSV verbatim (reusing
/// the same parsers as the local read), and `AMD\t<card>\t<key>\t<value>` lines
/// ship one DRM sysfs file each so `parse_drm_card` runs unchanged on them. The
/// `@WHO@` block carries the host's `who` output verbatim for the pane's "Logged
/// in" panel ([`parse_who`]), preceded by an `ME` line naming the account the
/// script is running as — `who` reports utmp, which has no entry for a session
/// without a pty, so without it the one person the panel could never list was the
/// user reading it. The
/// `@PASSWD@` block ships the host's `getent passwd` (or `/etc/passwd`) verbatim so
/// [`parse_passwd`] can map each process's owner uid to a name on the *host's*
/// account database, not this machine's.
///
/// **The process walk is fork-bounded, and that is the whole point.** Under
/// `@PROCS@` comes one `S`/`U`/`R` line per process, each *keyed by pid*
/// (`<tag>\t<pid>\t<value>`): the raw `/proc/<pid>/stat` line, the owner uid from
/// `/proc/<pid>/status`, and `VmRSS` in KiB. All three come from a **single**
/// `awk` that walks every `/proc/<pid>` itself via `getline`. The earlier shape —
/// a `sh` loop forking `cat` + `awk` + `tr` *per process* — cost ~3 execs per pid,
/// which on a busy multi-user host (an HPC login node) is thousands of process
/// spawns every poll: measured at **2.3 s of host CPU for 544 processes**, i.e.
/// ~78% of a core sustained against this pane's 3 s cadence. The same capture as
/// one `awk` pass measures ~0.02 s. A poll must cost the host less than the host
/// is worth watching for.
///
/// Cmdlines therefore ride their own `@CMDLINE@` block, captured by **one**
/// `grep -aH '' /proc/[0-9]*/cmdline` piped through **one** `tr '\0' ' '` (NULs
/// become spaces so each process stays on one line, as before). They are keyed by
/// the `/proc/<pid>/cmdline:` prefix grep emits rather than zipped positionally
/// with `@PROCS@`, because a kernel thread's cmdline is empty and so contributes
/// no line at all — the two blocks genuinely do not line up. A host with no
/// `grep` degrades to every process showing its `[comm]`, never to a wrong name.
///
/// `@PASSWD2@`, shipped *after* `@PROCS@`, resolves each uid the walk actually saw
/// via a **targeted** `getent passwd <uid>` lookup — the supplement that makes the
/// "Logged in" panel's per-user CPU/MEM match `who`'s names on an NSS setup that
/// serves point lookups but not enumeration (SSSD's default `enumerate = false`,
/// common on LDAP-backed and HPC/institutional hosts): a bare `getent
/// passwd`/`/etc/passwd` dump then lists only local accounts, so a directory-backed
/// user's processes fall back to `#<uid>` and never match their `who` session name,
/// reading as a permanently 0% row. It is **one** `getent` for every uid at once
/// (it takes many keys), not one per uid — the same fork-per-item trap, and on a
/// directory-backed host each of those forks was also an LDAP round trip.
/// `parse_remote_snapshot` defers owner resolution until both blocks have arrived,
/// merging `@PASSWD2@` into whatever `@PASSWD@` left unmapped.
///
/// A process whose `status` withheld `Uid:` ships **no** `U` line rather than a
/// `0`, which would silently read as root; the parser leaves such an owner blank.
/// The `/proc/[0-9]*` globs are now `exec` **arguments** rather than shell-loop
/// iterations, so they are bounded by `ARG_MAX` where the old loop was not — at
/// ~21 bytes per pid against a typical 2 MB limit that is ~100k processes, some
/// 20× beyond any host this pane is pointed at, but it is the reason the walk is
/// two awk invocations over one glob each and not one over several.
/// The script also ends in a `:` so its exit status is always 0 — the
/// global-machine path (`run_ssh_auth` → `capture`) treats a non-zero remote exit
/// as a failed probe, and a trailing `getent` that simply found no match must not
/// discard an otherwise complete snapshot.
///
/// ## Careful mode (HPC hosts)
///
/// A shared cluster login node is not an ordinary dev box: its usage rules forbid
/// determining other users' account names and using information about them that
/// happens to be readable, and its operators expect a login node not to carry a
/// sustained background load (`docs/context/hpc_careful_mode.md`). So on a host
/// that looks like a cluster — SLURM on `PATH` — this script **collects less**:
///
/// * `@PASSWD@` ships only the *sampling* user's own entry, never the directory
///   dump, and `@PASSWD2@` (the per-uid supplement) is skipped entirely, so no
///   foreign account name is ever read;
/// * `@CMDLINE@` covers only the sampling user's own processes — a foreign
///   process ships no argv, and its `comm` is redacted to `(other)` inside the
///   `@PROCS@` walk, so what other people run never leaves the cluster;
/// * a foreign process ships **no** `U` line, so it cannot be attributed to a
///   person; the parser buckets all of them into one `other users` row, which is
///   the only figure the pane actually needs from them ("how much of this machine
///   isn't mine");
/// * `@WHO@` is filtered to the sampling user's own sessions, and `nvidia-smi`'s
///   per-process query (`NVPROC`) is not run at all.
///
/// The mode is reported back on the leading `CAREFUL` line so the pane can also
/// poll more gently (`SystemMonitorPane`'s `CAREFUL_POLL_MS`) and say what it is
/// doing.
///
/// **Who decides.** The `sbatch` probe below is now only a fallback: the monitor
/// passes the machine's stored mode on every poll ([`remote_snapshot_script`]),
/// and careful is the default for every remote machine — so the probe matters
/// only for a caller with no answer to pass. That is why the script reads
/// `TABTIVITY_CAREFUL` *before* probing, and why an explicit `0` has to be honoured
/// as well as an explicit `1`: without it, a machine the user owns and told
/// Tabtivity to read fully would still be redacted the moment it happened to have a
/// scheduler installed.
pub const REMOTE_SNAPSHOT_SCRIPT: &str = concat!(r#"
_careful="${"#, crate::app_upper!(), r#"_CAREFUL:-}"
if [ -z "$_careful" ]; then
  if command -v sbatch >/dev/null 2>&1 || command -v sinfo >/dev/null 2>&1 \
     || command -v squeue >/dev/null 2>&1; then _careful=1; else _careful=0; fi
fi
_myuid=$(id -u 2>/dev/null || echo -1)
_myname=$(id -un 2>/dev/null || echo '')
printf 'CAREFUL\t%s\n' "$_careful"
printf 'ME\t%s\n' "$_myname"
printf 'CLK\t%s\n' "$(getconf CLK_TCK 2>/dev/null || echo 100)"
printf '@STAT@\n'; cat /proc/stat 2>/dev/null
printf '@MEM@\n'; cat /proc/meminfo 2>/dev/null
printf '@LOAD@\n'; cat /proc/loadavg 2>/dev/null
printf '@UP@\n'; cat /proc/uptime 2>/dev/null
printf '@WHO@\n'
if [ "$_careful" = 1 ]; then
  who 2>/dev/null | awk -v me="$_myname" '$1 == me'
else
  who 2>/dev/null
fi
printf '@GPU@\n'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,fan.speed,driver_version,pcie.link.gen.current,pcie.link.width.current --format=csv,noheader,nounits 2>/dev/null | sed 's/^/NVSMI\t/'
  if [ "$_careful" != 1 ]; then
    nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | sed 's/^/NVPROC\t/'
  fi
fi
for c in /sys/class/drm/card[0-9]*; do
  d="$c/device"
  [ -r "$d/mem_info_vram_total" ] || continue
  i=${c##*/}; i=${i#card}
  h=$(ls -d "$d"/hwmon/hwmon* 2>/dev/null | head -n1)
  printf 'AMD\t%s\tdriver\t%s\n' "$i" "$(sed -n 's/^DRIVER=//p' "$d/uevent" 2>/dev/null)"
  printf 'AMD\t%s\tvendor\t%s\n' "$i" "$(cat "$d/vendor" 2>/dev/null)"
  printf 'AMD\t%s\tdevice\t%s\n' "$i" "$(cat "$d/device" 2>/dev/null)"
  printf 'AMD\t%s\tvram_used\t%s\n' "$i" "$(cat "$d/mem_info_vram_used" 2>/dev/null)"
  printf 'AMD\t%s\tvram_total\t%s\n' "$i" "$(cat "$d/mem_info_vram_total" 2>/dev/null)"
  printf 'AMD\t%s\tgtt_used\t%s\n' "$i" "$(cat "$d/mem_info_gtt_used" 2>/dev/null)"
  printf 'AMD\t%s\tgtt_total\t%s\n' "$i" "$(cat "$d/mem_info_gtt_total" 2>/dev/null)"
  printf 'AMD\t%s\tbusy\t%s\n' "$i" "$(cat "$d/gpu_busy_percent" 2>/dev/null)"
  printf 'AMD\t%s\tsclk\t%s\n' "$i" "$(grep '\*' "$d/pp_dpm_sclk" 2>/dev/null | head -n1)"
  printf 'AMD\t%s\tmclk\t%s\n' "$i" "$(grep '\*' "$d/pp_dpm_mclk" 2>/dev/null | head -n1)"
  printf 'AMD\t%s\tlink_speed\t%s\n' "$i" "$(cat "$d/current_link_speed" 2>/dev/null)"
  printf 'AMD\t%s\tlink_width\t%s\n' "$i" "$(cat "$d/current_link_width" 2>/dev/null)"
  printf 'AMD\t%s\ttemp\t%s\n' "$i" "$(cat "$h/temp1_input" 2>/dev/null)"
  printf 'AMD\t%s\tpower\t%s\n' "$i" "$(cat "$h/power1_average" 2>/dev/null || cat "$h/power1_input" 2>/dev/null)"
  printf 'AMD\t%s\tpower_cap\t%s\n' "$i" "$(cat "$h/power1_cap" 2>/dev/null)"
  printf 'AMD\t%s\tpwm\t%s\n' "$i" "$(cat "$h/pwm1" 2>/dev/null)"
  printf 'AMD\t%s\tpwm_max\t%s\n' "$i" "$(cat "$h/pwm1_max" 2>/dev/null)"
done
printf '@CPUTEMP@\n'
for h in /sys/class/hwmon/hwmon*; do
  n=$(cat "$h/name" 2>/dev/null)
  case "$n" in coretemp|k10temp|zenpower|cpu_thermal) ;; *) continue ;; esac
  for t in "$h"/temp*_input; do
    [ -r "$t" ] || continue
    printf 'T\t%s\t%s\n' "$(cat "${t%_input}_label" 2>/dev/null)" "$(cat "$t" 2>/dev/null)"
  done
done
printf '@MEMTEMP@\n'
for h in /sys/class/hwmon/hwmon*; do
  n=$(cat "$h/name" 2>/dev/null)
  case "$n" in jc42|spd5118) ;; *) continue ;; esac
  printf 'M\t%s\n' "$(cat "$h/temp1_input" 2>/dev/null)"
done
printf '@PASSWD@\n'
if [ "$_careful" = 1 ]; then
  getent passwd "$_myuid" 2>/dev/null
else
  getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null
fi
printf '@PROCS@\n'
awk -v careful="$_careful" -v me="$_myuid" '
BEGIN {
  careful = careful + 0; me = me + 0
  for (i = 1; i < ARGC; i++) {
    d = ARGV[i]
    if ((getline s < (d "/stat")) <= 0) { close(d "/stat"); continue }
    close(d "/stat")
    if (s == "") continue
    p = substr(d, 7)
    u = -1; r = 0
    while ((getline l < (d "/status")) > 0) {
      if (l ~ /^Uid:/) { split(l, f, "[ \t]+"); u = f[2] + 0 }
      else if (l ~ /^VmRSS:/) { split(l, f, "[ \t]+"); r = f[2] + 0 }
    }
    close(d "/status")
    mine = (u == me)
    if (careful == 1 && !mine) { sub(/\(.*\)/, "(other)", s) }
    printf "S\t%s\t%s\n", p, s
    if (u >= 0 && (careful != 1 || mine)) printf "U\t%s\t%s\n", p, u
    printf "R\t%s\t%s\n", p, r
  }
  exit
}' /proc/[0-9]*
printf '@CMDLINE@\n'
if [ "$_careful" = 1 ]; then
  _mypids=$(ps -u "$_myuid" -o pid= 2>/dev/null)
  if [ -z "$_mypids" ]; then
    _mypids=$(awk -v me="$_myuid" '
BEGIN {
  me = me + 0
  for (i = 1; i < ARGC; i++) {
    d = ARGV[i]; u = -1
    while ((getline l < (d "/status")) > 0) {
      if (l ~ /^Uid:/) { split(l, f, "[ \t]+"); u = f[2] + 0; break }
    }
    close(d "/status")
    if (u == me) print substr(d, 7)
  }
  exit
}' /proc/[0-9]*)
  fi
  for p in $_mypids; do
    [ -r "/proc/$p/cmdline" ] || continue
    printf '/proc/%s/cmdline:' "$p"
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null
    printf '\n'
  done
else
  grep -aH '' /proc/[0-9]*/cmdline 2>/dev/null | tr '\0' ' '
fi
printf '@PASSWD2@\n'
if [ "$_careful" = 1 ]; then
  :
else
_uids=$(awk '
BEGIN {
  for (i = 1; i < ARGC; i++) {
    f = ARGV[i] "/status"
    while ((getline l < f) > 0) {
      if (l ~ /^Uid:/) {
        split(l, a, "[ \t]+")
        if (!(a[2] in seen)) { seen[a[2]] = 1; printf "%s ", a[2] }
        break
      }
    }
    close(f)
  }
  exit
}' /proc/[0-9]*)
if [ -n "$_uids" ]; then getent passwd $_uids 2>/dev/null; fi
fi
:
"#);

/// [`REMOTE_SNAPSHOT_SCRIPT`] with careful mode pinned by the caller, or left to
/// the host to decide.
///
/// `Some(true)`/`Some(false)` pin `TABTIVITY_CAREFUL`, so the script skips its own
/// `sbatch` probe entirely; `None` leaves the probe in place. **Both** directions
/// are pinnable, which is the change the per-machine switch needed: careful is
/// now the default for every remote machine (`src/lib/remote/carefulHost.ts`), so the
/// only way to get a full reading of a machine the user owns is for their answer
/// to outrank host-side detection. That answer is the *user's*, recorded per SSH
/// target and deliberate — the asymmetry the old force-on-only signature encoded
/// (a probe must never talk a cluster down) applies to a guess, not to a person
/// telling Tabtivity whose machine it is.
///
/// `None` is now only for a caller with no stored answer to pass on, where the
/// host's own SLURM check is still the best available signal.
pub fn remote_snapshot_script(careful: Option<bool>) -> String {
    match careful {
        Some(true) => format!("{UPPER}_CAREFUL=1\n{REMOTE_SNAPSHOT_SCRIPT}"),
        Some(false) => format!("{UPPER}_CAREFUL=0\n{REMOTE_SNAPSHOT_SCRIPT}"),
        None => REMOTE_SNAPSHOT_SCRIPT.to_string(),
    }
}

/// Assemble a [`SystemSnapshot`] from the output of [`REMOTE_SNAPSHOT_SCRIPT`],
/// reusing the same pure `/proc` parsers the local Linux backend uses. `supported`
/// is always `true` (the host is assumed Linux; a host with no `/proc` simply
/// yields zeroed CPU/memory and an empty process table). The `@GPU@` block is fed
/// through the very same `gpustat` parsers as the local read, so a host GPU shows
/// with the same memory/sensor detail; `gpu_procs` carries the host's per-process
/// GPU memory (NVIDIA only — the AMD `fdinfo` walk is local-only, too heavy to run
/// per remote poll).
pub fn parse_remote_snapshot(raw: &str) -> SystemSnapshot {
    use std::collections::BTreeMap;
    enum Sec {
        None,
        Stat,
        Mem,
        Load,
        Up,
        Who,
        Gpu,
        CpuTemp,
        MemTemp,
        Passwd,
        Passwd2,
        Procs,
        Cmdline,
    }
    let mut sec = Sec::None;
    let mut clk: u64 = 100;
    // Set by the host's leading `CAREFUL` line: this sample deliberately carries
    // no third-party account name, argv or session (see `REMOTE_SNAPSHOT_SCRIPT`).
    let mut careful = false;
    // The sampling account's login name on the host, from the leading `ME` line;
    // empty when the host couldn't say (`id -un` failed), which simply leaves the
    // session rows unflagged rather than inventing an owner.
    let mut me = String::new();
    let mut stat_buf = String::new();
    let mut mem_buf = String::new();
    let mut load_buf = String::new();
    let mut up_buf = String::new();
    let mut who_buf = String::new();
    // The host's bulk passwd db (shipped under @PASSWD@) and, after @PROCS@, the
    // targeted per-uid supplement (@PASSWD2@ — see `REMOTE_SNAPSHOT_SCRIPT`'s doc
    // for why enumeration alone can miss an NSS/LDAP-backed account). Owner
    // resolution is deferred until both have fully arrived, so `processes` is
    // built with each entry's raw uid alongside it (`proc_uid`, 1:1 by index) and
    // resolved to a name in one final pass below.
    let mut passwd_buf = String::new();
    let mut passwd2_buf = String::new();
    let mut processes: Vec<ProcSample> = Vec::new();
    let mut proc_uid: Vec<Option<u32>> = Vec::new();
    // GPU accumulators: the `nvidia-smi` CSV rebuilt line-by-line for its parsers,
    // and one `DrmFiles` per AMD card index assembled from its shipped sysfs files.
    let mut nvsmi = String::new();
    let mut nvproc = String::new();
    let mut amd_cards: BTreeMap<u32, crate::gpustat::DrmFiles> = BTreeMap::new();
    // CPU hwmon channels shipped as `T\t<label>\t<milli_celsius>` under @CPUTEMP@.
    let mut cpu_temp_channels: Vec<(Option<String>, f64)> = Vec::new();
    // Hottest DIMM temp in °C, from `M\t<milli>` lines under @MEMTEMP@ (one per module).
    let mut mem_temp_c: Option<f64> = None;

    // One accumulator per pid, filled from the pid-keyed `@PROCS@` lines and then
    // the separate `@CMDLINE@` block. Keyed rather than positional because those
    // two blocks are captured by two independent passes over `/proc` (see
    // `REMOTE_SNAPSHOT_SCRIPT`) and a kernel thread appears in only the first, so
    // there is no position to zip them by.
    #[derive(Default)]
    struct ProcAccum {
        stat: String,
        uid: Option<u32>,
        rss_kib: u64,
        cmdline: Option<String>,
    }
    let mut proc_acc: BTreeMap<u32, ProcAccum> = BTreeMap::new();

    for line in raw.lines() {
        match line {
            "@STAT@" => {
                sec = Sec::Stat;
                continue;
            }
            "@MEM@" => {
                sec = Sec::Mem;
                continue;
            }
            "@LOAD@" => {
                sec = Sec::Load;
                continue;
            }
            "@UP@" => {
                sec = Sec::Up;
                continue;
            }
            "@WHO@" => {
                sec = Sec::Who;
                continue;
            }
            "@GPU@" => {
                sec = Sec::Gpu;
                continue;
            }
            "@CPUTEMP@" => {
                sec = Sec::CpuTemp;
                continue;
            }
            "@MEMTEMP@" => {
                sec = Sec::MemTemp;
                continue;
            }
            "@PASSWD@" => {
                sec = Sec::Passwd;
                continue;
            }
            "@PASSWD2@" => {
                sec = Sec::Passwd2;
                continue;
            }
            "@PROCS@" => {
                sec = Sec::Procs;
                continue;
            }
            "@CMDLINE@" => {
                sec = Sec::Cmdline;
                continue;
            }
            _ => {}
        }
        if let Some(rest) = line.strip_prefix("CAREFUL\t") {
            careful = rest.trim() == "1";
            continue;
        }
        // Who Tabtivity is on this host — the account the "Logged in" panel would
        // otherwise be the only one never to mention (see `parse_who`).
        if let Some(rest) = line.strip_prefix("ME\t") {
            me = rest.trim().to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("CLK\t") {
            if let Ok(v) = rest.trim().parse::<u64>() {
                if v > 0 {
                    clk = v;
                }
            }
            continue;
        }
        match sec {
            Sec::Stat => {
                stat_buf.push_str(line);
                stat_buf.push('\n');
            }
            Sec::Mem => {
                mem_buf.push_str(line);
                mem_buf.push('\n');
            }
            Sec::Load => {
                load_buf.push_str(line);
                load_buf.push('\n');
            }
            Sec::Up => {
                up_buf.push_str(line);
                up_buf.push('\n');
            }
            Sec::Who => {
                who_buf.push_str(line);
                who_buf.push('\n');
            }
            Sec::Gpu => {
                if let Some(rest) = line.strip_prefix("NVSMI\t") {
                    nvsmi.push_str(rest);
                    nvsmi.push('\n');
                } else if let Some(rest) = line.strip_prefix("NVPROC\t") {
                    nvproc.push_str(rest);
                    nvproc.push('\n');
                } else if let Some(rest) = line.strip_prefix("AMD\t") {
                    // `<index>\t<key>\t<value>`; an empty value = a file the host
                    // didn't expose, so skip it rather than store a blank.
                    let mut it = rest.splitn(3, '\t');
                    if let (Some(idx), Some(key), Some(val)) = (it.next(), it.next(), it.next()) {
                        if !val.is_empty() {
                            if let Ok(idx) = idx.parse::<u32>() {
                                crate::gpustat::set_drm_field(
                                    amd_cards.entry(idx).or_default(),
                                    key,
                                    val,
                                );
                            }
                        }
                    }
                }
            }
            Sec::CpuTemp => {
                // `T\t<label>\t<milli>`; an empty label ⇒ no `tempN_label` file,
                // an empty/garbage value ⇒ a channel the host couldn't read (skip).
                if let Some(rest) = line.strip_prefix("T\t") {
                    let mut it = rest.splitn(2, '\t');
                    let label = it.next().unwrap_or("").trim();
                    if let Some(milli) = it.next().and_then(|v| v.trim().parse::<f64>().ok()) {
                        let label = (!label.is_empty()).then(|| label.to_string());
                        cpu_temp_channels.push((label, milli));
                    }
                }
            }
            Sec::MemTemp => {
                // `M\t<milli>`; keep the hottest module, skipping blanks/garbage.
                if let Some(rest) = line.strip_prefix("M\t") {
                    if let Ok(milli) = rest.trim().parse::<f64>() {
                        let c = milli / 1000.0;
                        mem_temp_c = Some(mem_temp_c.map_or(c, |h| h.max(c)));
                    }
                }
            }
            Sec::Passwd => {
                passwd_buf.push_str(line);
                passwd_buf.push('\n');
            }
            Sec::Passwd2 => {
                passwd2_buf.push_str(line);
                passwd2_buf.push('\n');
            }
            Sec::Procs => {
                // `<tag>\t<pid>\t<value>` — `S` the raw `/proc/<pid>/stat` line,
                // `U` the owner uid, `R` `VmRSS` in KiB. `S` is what declares a
                // process exists, so `U`/`R` only ever fill an entry it opened.
                let mut it = line.splitn(3, '\t');
                let (Some(tag), Some(pid), Some(val)) = (it.next(), it.next(), it.next()) else {
                    continue;
                };
                let Ok(pid) = pid.trim().parse::<u32>() else {
                    continue;
                };
                match tag {
                    "S" => proc_acc.entry(pid).or_default().stat = val.to_string(),
                    "U" => {
                        if let Some(acc) = proc_acc.get_mut(&pid) {
                            acc.uid = val.trim().parse().ok();
                        }
                    }
                    "R" => {
                        if let Some(acc) = proc_acc.get_mut(&pid) {
                            acc.rss_kib = val.trim().parse().unwrap_or(0);
                        }
                    }
                    _ => {}
                }
            }
            Sec::Cmdline => {
                // `/proc/<pid>/cmdline:<args>` — `grep -aH` over the whole glob,
                // NULs already spaces. A pid with no `@PROCS@` entry (a process
                // that started between the two passes) is dropped rather than
                // invented, and an arg containing a literal newline splits into a
                // prefix-less continuation line that is dropped, as before.
                let Some(rest) = line.strip_prefix("/proc/") else {
                    continue;
                };
                let Some((pid, tail)) = rest.split_once('/') else {
                    continue;
                };
                let Some(args) = tail.strip_prefix("cmdline:") else {
                    continue;
                };
                let Ok(pid) = pid.parse::<u32>() else {
                    continue;
                };
                if let Some(acc) = proc_acc.get_mut(&pid) {
                    acc.cmdline = Some(args.to_string());
                }
            }
            Sec::None => {}
        }
    }

    // Build the process table now that both blocks are in. Owner resolution is
    // deferred one step further (until @PASSWD2@'s targeted lookups below), so
    // `user` starts empty and the raw uid rides alongside in `proc_uid`, 1:1 by
    // index.
    for (pid, acc) in proc_acc {
        let Some((comm, state, ppid, cpu_jiffies, threads)) = parse_pid_stat(&acc.stat) else {
            continue;
        };
        let cmdline = acc
            .cmdline
            .filter(|c| !c.trim().is_empty())
            .unwrap_or_else(|| format!("[{comm}]"));
        processes.push(ProcSample {
            pid,
            ppid,
            comm,
            cmdline,
            state,
            rss_kib: acc.rss_kib,
            cpu_jiffies,
            threads,
            user: String::new(),
        });
        proc_uid.push(acc.uid);
    }

    // Resolve every process's owner now that both passwd blocks are in: the bulk
    // `@PASSWD@` dump first, then `@PASSWD2@`'s per-uid lookups filling whatever
    // uid it left unmapped (an enumeration-only gap, not a real unmapped uid, so
    // the bulk name wins on a conflict rather than being overwritten).
    let mut uid_to_name = parse_passwd(&passwd_buf);
    for (uid, name) in parse_passwd(&passwd2_buf) {
        uid_to_name.entry(uid).or_insert(name);
    }
    for (proc, uid) in processes.iter_mut().zip(proc_uid.iter()) {
        // An owner uid the host didn't report (unreadable status) leaves the user
        // empty rather than mislabelling it `#0` (root).
        if let Some(uid) = uid {
            proc.user = username_for(*uid, &uid_to_name);
        } else if careful {
            // Careful mode ships no `U` line for a process that isn't ours, so
            // every one of them lands here — bucketed under a single label rather
            // than a uid each, which would be a per-person breakdown by another
            // name. "How much of this machine isn't mine" is the whole figure the
            // pane needs from them.
            proc.user = OTHER_USERS.to_string();
        }
    }

    let (cpu, per_core) = parse_cpu_stat(&stat_buf);
    let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = parse_meminfo(&mem_buf);
    let load_avg = parse_loadavg(&load_buf);
    let uptime_secs = up_buf
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);

    // AMD cards (via the shared `parse_drm_card`) then NVIDIA (via the shared
    // `parse_nvidia_smi`), so the host reading matches the local one field-for-field.
    let mut gpus: Vec<crate::gpustat::GpuSample> = amd_cards
        .into_iter()
        .filter_map(|(idx, files)| crate::gpustat::parse_drm_card(idx, &files))
        .collect();
    gpus.extend(crate::gpustat::parse_nvidia_smi(&nvsmi));
    let gpu_procs = crate::gpustat::parse_nvidia_apps(&nvproc);
    let cpu_temp_c = pick_cpu_temp(&cpu_temp_channels);
    let sessions = parse_who(&who_buf, &me);

    SystemSnapshot {
        supported: true,
        clk_tck: clk,
        num_cores: per_core.len() as u32,
        cpu,
        per_core,
        mem_total_kib,
        mem_available_kib,
        swap_total_kib,
        swap_free_kib,
        load_avg,
        uptime_secs,
        processes,
        gpus,
        gpu_procs,
        cpu_temp_c,
        mem_temp_c,
        sessions,
        careful,
    }
}

// ── Pure Windows decoders (compiled under test on any OS) ───────────────────
// Factored out of the Windows backend so they can be unit-tested from byte
// fixtures without a live Win32 (pattern: the `/proc` parsers above).

/// Byte size of one `SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION` entry as
/// returned by `NtQuerySystemInformation` class 8: five LARGE_INTEGER times
/// (Idle, Kernel, User, Dpc, Interrupt) + ULONG InterruptCount + padding.
#[cfg(any(target_os = "windows", test))]
const PROCESSOR_PERF_ENTRY_BYTES: usize = 48;

/// Parse the raw buffer written by `NtQuerySystemInformation(8, …)` into one
/// [`CpuTimes`] per processor. KernelTime INCLUDES IdleTime (same convention as
/// `GetSystemTimes`), so `total = kernel + user` and `busy = total − idle`. A
/// trailing partial entry is ignored; negative times (never expected) clamp to 0.
#[cfg(any(target_os = "windows", test))]
fn parse_processor_perf_buffer(buf: &[u8]) -> Vec<CpuTimes> {
    buf.as_chunks::<PROCESSOR_PERF_ENTRY_BYTES>()
        .0
        .iter()
        .map(|chunk| {
            let time = |off: usize| {
                i64::from_le_bytes(chunk[off..off + 8].try_into().unwrap()).max(0) as u64
            };
            let (idle, kernel, user) = (time(0), time(8), time(16));
            let total = kernel + user;
            CpuTimes {
                busy: total.saturating_sub(idle),
                total,
            }
        })
        .collect()
}

/// Decode a NUL-terminated ANSI `CHAR` buffer (a `PROCESSENTRY32.szExeFile`,
/// or a macOS `proc_bsdinfo.pbi_comm`) into a `String`, lossily for non-UTF-8
/// bytes.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn decode_ansi_nul(raw: &[i8]) -> String {
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

// ── Pure macOS decoders (compiled under test on any OS) ─────────────────────

/// Convert the flat tick array written by `host_processor_info`
/// (`PROCESSOR_CPU_LOAD_INFO`: 4 cumulative `u32` tick counters per core, in
/// CPU_STATE order user/system/idle/nice) into one [`CpuTimes`] per core, with
/// ticks scaled to nanoseconds (`ns_per_tick = 1e9 / clk_tck`). The macOS
/// "tick" unit for per-PROCESS times is already nanoseconds (`clk_tck()` is
/// 1e9), so machine times MUST be converted to ns too — the frontend divides
/// per-process by machine deltas and the units have to match. `busy` is
/// user+system+nice; `total` adds idle. A trailing partial chunk is ignored.
#[cfg(any(target_os = "macos", test))]
fn parse_host_processor_ticks(ticks: &[u32], ns_per_tick: u64) -> Vec<CpuTimes> {
    const CPU_STATE_USER: usize = 0;
    const CPU_STATE_SYSTEM: usize = 1;
    const CPU_STATE_IDLE: usize = 2;
    const CPU_STATE_NICE: usize = 3;
    ticks
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| {
            let busy =
                (c[CPU_STATE_USER] as u64 + c[CPU_STATE_SYSTEM] as u64 + c[CPU_STATE_NICE] as u64)
                    * ns_per_tick;
            CpuTimes {
                busy,
                total: busy + c[CPU_STATE_IDLE] as u64 * ns_per_tick,
            }
        })
        .collect()
}

/// Split a `KERN_PROCARGS2` buffer into `argc` and the bytes from `argv[0]` on.
///
/// Layout: a native-endian `u32` argc, the executable path (NUL-terminated,
/// then padded with further NULs up to an alignment the kernel chooses), then
/// `argc` NUL-terminated argv strings, then the environment.
#[cfg(any(target_os = "macos", test))]
fn procargs2_args(buf: &[u8]) -> Option<(usize, &[u8])> {
    let argc = u32::from_ne_bytes(buf.get(0..4)?.try_into().ok()?) as usize;
    let rest = &buf[4..];
    // Skip the exec path and its NUL padding.
    let path_end = rest.iter().position(|&b| b == 0)?;
    let mut cursor = path_end;
    while cursor < rest.len() && rest[cursor] == 0 {
        cursor += 1;
    }
    Some((argc, &rest[cursor..]))
}

/// Decode a `KERN_PROCARGS2` buffer into a space-joined argv.
///
/// Only the argv strings are taken — the environment is exactly the part a
/// monitor must not read (it is where tokens live) — and the exec path is not
/// repeated, since `argv[0]` already names the program. The one reader of the
/// environment part is [`procargs2_env`], for a single named variable.
#[cfg(any(target_os = "macos", test))]
fn parse_procargs2(buf: &[u8]) -> Option<String> {
    let (argc, rest) = procargs2_args(buf)?;
    let mut args: Vec<String> = Vec::with_capacity(argc);
    for part in rest.split(|&b| b == 0) {
        if args.len() == argc {
            break;
        }
        args.push(String::from_utf8_lossy(part).into_owned());
    }
    let joined = args.join(" ");
    (!joined.is_empty()).then_some(joined)
}

/// The environment part of a `KERN_PROCARGS2` buffer: the NUL-separated bytes
/// after the `argc` argv strings (the kernel's trailing `apple[]` strings
/// follow it; a caller matching one `NAME=` prefix need not care). Empty for a
/// short or malformed buffer.
///
/// This is the part [`parse_procargs2`] refuses to read, and it stays out of
/// the monitor: its only caller is `agent_turn`'s background-job scan, which
/// looks for the tab-id variable alone and never keeps or surfaces anything
/// else (the macOS twin of its `/proc/<pid>/environ` read).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn procargs2_env(buf: &[u8]) -> &[u8] {
    let Some((argc, mut rest)) = procargs2_args(buf) else { return &[] };
    for _ in 0..argc {
        match rest.iter().position(|&b| b == 0) {
            Some(end) => rest = &rest[end + 1..],
            None => return &[],
        }
    }
    rest
}

/// The raw `KERN_PROCARGS2` buffer of one of the user's own processes (argv
/// **and** environment). Only for [`procargs2_env`]'s one named lookup; every
/// argv reader goes through [`cmdline`].
#[cfg(target_os = "macos")]
pub(crate) fn procargs2_raw(pid: u32) -> Option<Vec<u8>> {
    platform::procargs2_raw(pid)
}

/// The kernel's short name of a process (`pbi_comm`, the executable's name cut
/// to 16 bytes — what Linux's `/proc/<pid>/stat` calls `comm`).
#[cfg(target_os = "macos")]
pub(crate) fn comm(pid: u32) -> Option<String> {
    platform::comm(pid)
}

/// Map a BSD `pbi_status` process state to the Linux-style single letter the
/// monitor pane already renders: SRUN→R, SSLEEP→S, SSTOP→T, SZOMB→Z (SIDL→I;
/// anything unknown → empty).
#[cfg(any(target_os = "macos", test))]
fn bsd_process_state(status: u32) -> String {
    match status {
        1 => "I", // SIDL — process being created
        2 => "R", // SRUN
        3 => "S", // SSLEEP
        4 => "T", // SSTOP
        5 => "Z", // SZOMB
        _ => "",
    }
    .to_string()
}

// ── Linux backend (`/proc`) ─────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;
    use std::fs;

    /// Kernel clock ticks per second (USER_HZ). Used to convert jiffies → seconds.
    pub fn clk_tck() -> u64 {
        // SAFETY: sysconf is async-signal-safe and takes no pointers.
        let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if v > 0 {
            v as u64
        } else {
            100
        }
    }

    /// pid → ppid for every live process, from a single `/proc` walk.
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut parent: HashMap<u32, u32> = HashMap::new();
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                    continue;
                };
                if let Some(ppid) = ppid(pid) {
                    parent.insert(pid, ppid);
                }
            }
        }
        parent
    }

    /// utime + stime (jiffies) from `/proc/<pid>/stat` (fields 14 and 15).
    pub fn proc_ticks(pid: u32) -> Option<u64> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let rest = stat.rsplit_once(')')?.1;
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // After ')' fields are 1-indexed as in proc(5): [0]=state(field 3).
        // utime=field 14 → index 11, stime=field 15 → index 12.
        let utime: u64 = fields.get(11)?.parse().ok()?;
        let stime: u64 = fields.get(12)?.parse().ok()?;
        Some(utime + stime)
    }

    /// Resident set size from `/proc/<pid>/status`, in KiB.
    pub fn rss_kib(pid: u32) -> Option<u64> {
        let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        for line in status.lines() {
            let Some(rest) = line.strip_prefix("VmRSS:") else {
                continue;
            };
            return rest.split_whitespace().next()?.parse().ok();
        }
        None
    }

    /// Parent pid from `/proc/<pid>/stat` (field 4, after the comm field).
    pub fn ppid(pid: u32) -> Option<u32> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm (field 2) may contain spaces/parens, so split after the last ')'.
        let rest = stat.rsplit_once(')')?.1;
        // rest = " S <ppid> ..." → fields[0]="" , [1]=state, [2]=ppid
        rest.split_whitespace().nth(1)?.parse().ok()
    }

    /// Command line for a live process, with NUL separators normalized to spaces.
    pub fn cmdline(pid: u32) -> Option<String> {
        let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        if bytes.is_empty() {
            return None;
        }
        let cmd = bytes
            .split(|b| *b == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part))
            .collect::<Vec<_>>()
            .join(" ");
        if cmd.is_empty() {
            None
        } else {
            Some(cmd)
        }
    }

    /// Whole-package CPU temperature in °C from the first CPU hwmon that exposes
    /// one, or `None`. Scans `/sys/class/hwmon/hwmon*`, matches the sensor by its
    /// `name` ([`super::is_cpu_hwmon`]), reads every `tempN_input` with its optional
    /// `tempN_label`, and lets [`super::pick_cpu_temp`] choose the package channel.
    /// No tool spawn and no root — the same cheap sysfs read the GPU sensors use.
    pub fn cpu_temp_c() -> Option<f64> {
        for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
            let base = entry.path();
            let name = fs::read_to_string(base.join("name")).unwrap_or_default();
            if !super::is_cpu_hwmon(&name) {
                continue;
            }
            let mut channels: Vec<(Option<String>, f64)> = Vec::new();
            for i in 1..=32u32 {
                let Ok(raw) = fs::read_to_string(base.join(format!("temp{i}_input"))) else {
                    continue;
                };
                let Ok(milli) = raw.trim().parse::<f64>() else {
                    continue;
                };
                let label = fs::read_to_string(base.join(format!("temp{i}_label")))
                    .ok()
                    .map(|s| s.trim().to_string());
                channels.push((label, milli));
            }
            if let Some(t) = super::pick_cpu_temp(&channels) {
                return Some(t);
            }
        }
        None
    }

    /// Hottest DIMM temperature in °C across every on-module memory sensor
    /// (`jc42`/`spd5118`, one hwmon per populated module), or `None` when the board
    /// exposes none. `temp1_input` is the module's only channel. Same cheap sysfs
    /// read the CPU/GPU sensors use — no tool spawn, no root.
    pub fn mem_temp_c() -> Option<f64> {
        let mut hottest: Option<f64> = None;
        for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
            let base = entry.path();
            let name = fs::read_to_string(base.join("name")).unwrap_or_default();
            if !super::is_mem_hwmon(&name) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(base.join("temp1_input")) else {
                continue;
            };
            let Ok(milli) = raw.trim().parse::<f64>() else {
                continue;
            };
            let c = milli / 1000.0;
            hottest = Some(hottest.map_or(c, |h| h.max(c)));
        }
        hottest
    }

    /// Aggregate-only sample: three small `/proc` reads and the CPU hwmon, with
    /// no process walk at all (see [`super::MachineLoad`]).
    pub fn machine_load() -> super::MachineLoad {
        let (cpu, per_core) =
            super::parse_cpu_stat(&fs::read_to_string("/proc/stat").unwrap_or_default());
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) =
            super::parse_meminfo(&fs::read_to_string("/proc/meminfo").unwrap_or_default());
        super::MachineLoad {
            supported: true,
            num_cores: per_core.len() as u32,
            cpu,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg: super::parse_loadavg(
                &fs::read_to_string("/proc/loadavg").unwrap_or_default(),
            ),
            cpu_temp_c: cpu_temp_c(),
            mem_temp_c: mem_temp_c(),
        }
    }

    /// Whole-system sample from `/proc`: aggregate + per-core CPU, memory/swap,
    /// load, uptime, and every process (one `/proc/<pid>/{stat,status,cmdline}`
    /// read each). Kernel threads (empty `cmdline`) fall back to `[comm]`.
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};
        use std::os::unix::fs::MetadataExt;

        // Resolve each process's owner uid to a name via the machine's own
        // `/etc/passwd`, read once. NSS-only accounts (LDAP/SSSD) the file walk
        // misses fall back to `#<uid>` in `username_for` — the remote path uses
        // `getent`, which is NSS-aware, so this file read is the local-only gap.
        let passwd = super::parse_passwd(&fs::read_to_string("/etc/passwd").unwrap_or_default());

        let (cpu, per_core) =
            super::parse_cpu_stat(&fs::read_to_string("/proc/stat").unwrap_or_default());
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) =
            super::parse_meminfo(&fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let load_avg =
            super::parse_loadavg(&fs::read_to_string("/proc/loadavg").unwrap_or_default());
        let uptime_secs = fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|c| c.split_whitespace().next()?.parse::<f64>().ok())
            .unwrap_or(0.0);

        let mut processes = Vec::new();
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                    continue;
                };
                let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
                    continue;
                };
                let Some((comm, state, ppid, cpu_jiffies, threads)) = super::parse_pid_stat(&stat)
                else {
                    continue;
                };
                let cmdline = cmdline(pid).unwrap_or_else(|| format!("[{comm}]"));
                // The process's owner is the uid owning its `/proc/<pid>` dir.
                let user = fs::metadata(format!("/proc/{pid}"))
                    .map(|m| super::username_for(m.uid(), &passwd))
                    .unwrap_or_default();
                processes.push(ProcSample {
                    pid,
                    ppid,
                    comm,
                    cmdline,
                    state,
                    rss_kib: rss_kib(pid).unwrap_or(0),
                    cpu_jiffies,
                    threads,
                    user,
                });
            }
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(),
            num_cores: per_core.len() as u32,
            cpu,
            per_core,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg,
            uptime_secs,
            processes,
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: cpu_temp_c(),
            mem_temp_c: mem_temp_c(),
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
            careful: false,       // a local sample: this machine is the user's own
        }
    }
}

// ── Windows backend (ToolHelp + Win32) ──────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Windows has no USER_HZ; `GetProcessTimes` reports in 100-ns units, so the
    /// ticks-per-second the caller divides by is 10_000_000.
    pub fn clk_tck() -> u64 {
        10_000_000
    }

    /// pid → ppid for every live process, from a single ToolHelp snapshot.
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut map = HashMap::new();
        // SAFETY: snapshot is closed before returning; the entry is fully
        // initialized (dwSize set) before Process32First reads it.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return map;
            };
            let mut entry = PROCESSENTRY32 {
                dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
                ..Default::default()
            };
            if Process32First(snapshot, &mut entry).is_ok() {
                loop {
                    map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32Next(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        map
    }

    /// Open a process for query, run `f` with the handle, and always close it.
    fn with_process<T>(pid: u32, f: impl FnOnce(HANDLE) -> Option<T>) -> Option<T> {
        // SAFETY: the handle is closed before returning regardless of `f`'s result.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let out = f(handle);
        unsafe {
            let _ = CloseHandle(handle);
        }
        out
    }

    /// kernel + user CPU time in 100-ns units, via `GetProcessTimes`.
    pub fn proc_ticks(pid: u32) -> Option<u64> {
        with_process(pid, |handle| {
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            // SAFETY: all four FILETIME out-params are valid for the call.
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
                .ok()?;
            Some(filetime_units(kernel) + filetime_units(user))
        })
    }

    /// Working-set size in KiB, via `GetProcessMemoryInfo`.
    pub fn rss_kib(pid: u32) -> Option<u64> {
        with_process(pid, |handle| {
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            // SAFETY: `counters` is valid and `cb` matches its size.
            unsafe {
                GetProcessMemoryInfo(
                    handle,
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                )
            }
            .ok()?;
            Some(counters.WorkingSetSize as u64 / 1024)
        })
    }

    pub fn ppid(pid: u32) -> Option<u32> {
        parent_map().get(&pid).copied()
    }

    /// The process's **image path** (`QueryFullProcessImageNameW`), standing in
    /// for its command line. The real argv lives in the target's PEB and needs
    /// `NtQueryInformationProcess` + `ReadProcessMemory`, which is more access
    /// than a monitor should take; every caller only matches on the program
    /// name (the renderer watchdog looks for `msedgewebview2`, the dev-root
    /// heuristic for `tauri dev`, which simply never matches here), and the
    /// image path answers that.
    pub fn cmdline(pid: u32) -> Option<String> {
        use windows::core::PWSTR;
        use windows::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};
        with_process(pid, |handle| {
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            // SAFETY: the buffer is sized by `len`, which the call updates to the
            // number of characters written (excluding the terminator).
            unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }
                .ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            (!path.is_empty()).then_some(path)
        })
    }

    /// The working-set breakdown for [`super::process_memory`]: `(breakdown,
    /// label of the figure used for the private share)`. Tries the EX2 layout
    /// (private working set) first and falls back to EX (commit charge) on a
    /// Windows that refuses the larger struct.
    pub fn memory_breakdown(pid: u32) -> Option<(super::RssBreakdown, &'static str)> {
        use windows::Win32::System::ProcessStatus::{
            PROCESS_MEMORY_COUNTERS_EX, PROCESS_MEMORY_COUNTERS_EX2,
        };
        with_process(pid, |handle| {
            let mut ex2 = PROCESS_MEMORY_COUNTERS_EX2::default();
            // SAFETY: `ex2` is a valid, correctly sized out-param; the call
            // writes at most `cb` bytes into it. `GetProcessMemoryInfo` takes the
            // base `PROCESS_MEMORY_COUNTERS` pointer for every layout and reads
            // `cb` to know which one it was handed.
            let ok = unsafe {
                GetProcessMemoryInfo(
                    handle,
                    &mut ex2 as *mut PROCESS_MEMORY_COUNTERS_EX2 as *mut PROCESS_MEMORY_COUNTERS,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
                )
            }
            .is_ok();
            if ok && ex2.PrivateWorkingSetSize > 0 {
                let rss = ex2.WorkingSetSize as u64 / 1024;
                let anon = (ex2.PrivateWorkingSetSize as u64 / 1024).min(rss);
                return Some((
                    super::RssBreakdown {
                        rss_kib: rss,
                        anon_kib: anon,
                        file_kib: rss - anon,
                        shmem_kib: ex2.SharedCommitUsage / 1024,
                    },
                    "[private working set]",
                ));
            }
            let mut ex = PROCESS_MEMORY_COUNTERS_EX::default();
            // SAFETY: as above, for the EX layout.
            unsafe {
                GetProcessMemoryInfo(
                    handle,
                    &mut ex as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                )
            }
            .ok()?;
            let rss = ex.WorkingSetSize as u64 / 1024;
            let anon = (ex.PrivateUsage as u64 / 1024).min(rss);
            Some((
                super::RssBreakdown {
                    rss_kib: rss,
                    anon_kib: anon,
                    file_kib: rss - anon,
                    shmem_kib: 0,
                },
                "[private commit, clipped to working set]",
            ))
        })
    }

    fn filetime_units(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
    }

    /// Per-core cumulative CPU times via `NtQuerySystemInformation` class 8
    /// (`SystemProcessorPerformanceInformation`). The windows crate does not
    /// bind this ntdll call, so it is declared manually; a failed query
    /// degrades to an empty per-core list (the pane then shows only the
    /// aggregate bar). The raw buffer decode is the pure, unit-tested
    /// [`super::parse_processor_perf_buffer`].
    fn query_per_core_times() -> Vec<super::CpuTimes> {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtQuerySystemInformation(
                class: u32,
                info: *mut core::ffi::c_void,
                len: u32,
                return_len: *mut u32,
            ) -> i32;
        }
        const SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: u32 = 8;
        // 64 KiB holds > 1300 processors at 48 bytes each.
        let mut buf = vec![0u8; 64 * 1024];
        let mut ret_len: u32 = 0;
        // SAFETY: the buffer length is passed exactly; ntdll writes at most
        // that many bytes and reports how many in `ret_len`, which bounds the
        // parse below. A non-zero NTSTATUS means nothing was written.
        let status = unsafe {
            NtQuerySystemInformation(
                SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut ret_len,
            )
        };
        if status != 0 {
            return Vec::new();
        }
        buf.truncate((ret_len as usize).min(buf.len()));
        super::parse_processor_perf_buffer(&buf)
    }

    /// Machine-aggregate CPU times. `GetSystemTimes`' kernel time INCLUDES idle,
    /// so `total = kernel + user` and `busy = total − idle`. 100-ns units, to
    /// match `proc_ticks`/`clk_tck`.
    fn aggregate_cpu() -> super::CpuTimes {
        use super::CpuTimes;
        use windows::Win32::System::Threading::GetSystemTimes;

        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: three valid FILETIME out-params, written on success only.
        if unsafe {
            GetSystemTimes(
                Some(&mut idle as *mut _),
                Some(&mut kernel as *mut _),
                Some(&mut user as *mut _),
            )
        }
        .is_ok()
        {
            let total = filetime_units(kernel) + filetime_units(user);
            CpuTimes {
                busy: total.saturating_sub(filetime_units(idle)),
                total,
            }
        } else {
            CpuTimes::default()
        }
    }

    /// `(mem_total, mem_available, swap_total, swap_free)` in KiB from
    /// `GlobalMemoryStatusEx`; swap ≈ pagefile − physical, since both counters
    /// include RAM.
    fn memory_kib() -> (u64, u64, u64, u64) {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: `mem` is valid and its dwLength is set as the API requires.
        if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
            (
                mem.ullTotalPhys / 1024,
                mem.ullAvailPhys / 1024,
                mem.ullTotalPageFile.saturating_sub(mem.ullTotalPhys) / 1024,
                mem.ullAvailPageFile.saturating_sub(mem.ullAvailPhys) / 1024,
            )
        } else {
            (0, 0, 0, 0)
        }
    }

    fn num_cores() -> u32 {
        use windows::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};

        let mut info = SYSTEM_INFO::default();
        // SAFETY: plain out-param write into a valid SYSTEM_INFO.
        unsafe { GetSystemInfo(&mut info) };
        info.dwNumberOfProcessors
    }

    /// Aggregate-only sample (see [`super::MachineLoad`]): the same three Win32
    /// calls the whole snapshot opens with, and none of its ToolHelp walk.
    /// Windows has no load average, so `load_avg` stays zeroed as it does there.
    pub fn machine_load() -> super::MachineLoad {
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = memory_kib();
        super::MachineLoad {
            supported: true,
            num_cores: num_cores(),
            cpu: aggregate_cpu(),
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg: [0.0; 3],
            cpu_temp_c: None, // no cheap CPU thermal read on this backend
            mem_temp_c: None, // nor a DIMM one
        }
    }

    /// Whole-system sample via Win32: `GetSystemTimes` (aggregate CPU; kernel
    /// time INCLUDES idle, so total = kernel+user and busy = total−idle),
    /// ntdll per-core times, `GlobalMemoryStatusEx` (swap ≈ pagefile −
    /// physical, both counters include RAM), `GetTickCount64` uptime, and one
    /// ToolHelp walk for the process table. Windows has no load average, so
    /// `load_avg` stays `[0.0; 3]` and the pane hides it. All CPU counters are
    /// 100-ns units to match `proc_ticks`/`clk_tck` — the frontend divides
    /// per-process ticks by machine ticks, so the units MUST agree.
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};
        use windows::Win32::System::SystemInformation::GetTickCount64;

        let cpu = aggregate_cpu();
        let per_core = query_per_core_times();
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = memory_kib();
        let num_cores = num_cores();

        // SAFETY: no arguments; returns milliseconds since boot.
        let uptime_secs = unsafe { GetTickCount64() } as f64 / 1000.0;

        // One ToolHelp walk for identity fields (pid/ppid/name/threads), then
        // per-pid CPU/RSS queries. A pid we cannot open (system/elevated)
        // keeps its identity row with zeroed usage, matching the Linux
        // behavior of unreadable /proc entries as closely as possible.
        let mut processes = Vec::new();
        // SAFETY: snapshot is closed before returning; the entry is fully
        // initialized (dwSize set) before Process32First reads it.
        unsafe {
            if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32 {
                    dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
                    ..Default::default()
                };
                if Process32First(snapshot, &mut entry).is_ok() {
                    loop {
                        let pid = entry.th32ProcessID;
                        let comm = super::decode_ansi_nul(&entry.szExeFile);
                        processes.push(ProcSample {
                            pid,
                            ppid: entry.th32ParentProcessID,
                            cmdline: format!("[{comm}]"),
                            comm,
                            state: String::new(),
                            rss_kib: rss_kib(pid).unwrap_or(0),
                            cpu_jiffies: proc_ticks(pid).unwrap_or(0),
                            threads: entry.cntThreads,
                            // No cheap per-process owner lookup here; the pane hides
                            // the per-user section when no process reports one.
                            user: String::new(),
                        });
                        if Process32Next(snapshot, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snapshot);
            }
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(),
            num_cores,
            cpu,
            per_core,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg: [0.0; 3],
            uptime_secs,
            processes,
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: None,     // no cheap CPU thermal read on this backend
            mem_temp_c: None,     // nor a memory thermal read
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
            careful: false,       // a local sample: this machine is the user's own
        }
    }
}

// ── macOS backend (libproc) ─────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;

    /// Ticks per second for [`proc_ticks`]: macOS task CPU times are nanoseconds,
    /// so one "tick" is one nanosecond and there are 1e9 per second.
    pub fn clk_tck() -> u64 {
        1_000_000_000
    }

    /// Fill a `proc_taskinfo` for `pid` (CPU time + RSS). `None` if the process is
    /// gone or the call did not write a full struct.
    fn task_info(pid: u32) -> Option<libc::proc_taskinfo> {
        // SAFETY: `proc_pidinfo` writes at most `size` bytes into `info`, which is
        // a zero-initialized, correctly-sized `proc_taskinfo`. We pass its real
        // size and accept the result only when the kernel wrote the whole struct,
        // so we never read uninitialized fields.
        unsafe {
            let mut info: libc::proc_taskinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
            let ret = libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTASKINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );
            if ret == size {
                Some(info)
            } else {
                None
            }
        }
    }

    /// Fill a `proc_bsdinfo` for `pid` (used for the parent pid). Same contract as
    /// [`task_info`].
    fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
        // SAFETY: identical contract to `task_info` but for the BSD-info flavor:
        // `info` is zero-initialized and correctly sized, and a short/failed write
        // (ret != size) is rejected before any field is read.
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let ret = libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );
            if ret == size {
                Some(info)
            } else {
                None
            }
        }
    }

    /// Total user + system CPU time for `pid`, in nanoseconds (the macOS "tick").
    pub fn proc_ticks(pid: u32) -> Option<u64> {
        let info = task_info(pid)?;
        Some(info.pti_total_user.wrapping_add(info.pti_total_system))
    }

    /// Resident set size for `pid`, in KiB (`pti_resident_size` is bytes).
    pub fn rss_kib(pid: u32) -> Option<u64> {
        let info = task_info(pid)?;
        Some(info.pti_resident_size / 1024)
    }

    /// Parent pid for `pid` via the BSD-info flavor.
    pub fn ppid(pid: u32) -> Option<u32> {
        Some(bsd_info(pid)?.pbi_ppid)
    }

    /// The kernel's short process name via the BSD-info flavor (`pbi_comm`).
    pub fn comm(pid: u32) -> Option<String> {
        Some(super::decode_ansi_nul(&bsd_info(pid)?.pbi_comm))
    }

    /// Command line via `sysctl KERN_PROCARGS2`, the one documented read of
    /// another process's argv on macOS. Readable for the caller's own processes
    /// (which is all the process-tree walk ever asks about); a foreign pid
    /// answers `EPERM` and so `None`.
    pub fn cmdline(pid: u32) -> Option<String> {
        super::parse_procargs2(&procargs2_raw(pid)?)
    }

    /// The whole `KERN_PROCARGS2` buffer (argv and environment) for `pid`.
    pub fn procargs2_raw(pid: u32) -> Option<Vec<u8>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        // SAFETY: a null buffer with `size` 0 asks only for the required length;
        // the second call is bounded by the buffer we sized to that answer, and
        // `size` is updated to what was actually written.
        unsafe {
            if libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            ) != 0
                || size == 0
            {
                return None;
            }
            let mut buf = vec![0u8; size];
            if libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                buf.as_mut_ptr() as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            ) != 0
            {
                return None;
            }
            buf.truncate(size);
            Some(buf)
        }
    }

    /// Resident set + physical footprint via `proc_pid_rusage(RUSAGE_INFO_V0)`,
    /// for [`super::process_memory`].
    pub fn memory_breakdown(pid: u32) -> Option<super::RssBreakdown> {
        // SAFETY: `info` is a zero-initialized `rusage_info_v0`, the layout the
        // `RUSAGE_INFO_V0` flavor writes; a non-zero return means nothing was
        // written and the value is discarded.
        unsafe {
            let mut info: libc::rusage_info_v0 = std::mem::zeroed();
            let ret = libc::proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V0,
                &mut info as *mut libc::rusage_info_v0 as *mut libc::rusage_info_t,
            );
            if ret != 0 {
                return None;
            }
            let rss = info.ri_resident_size / 1024;
            let anon = (info.ri_phys_footprint / 1024).min(rss);
            Some(super::RssBreakdown {
                rss_kib: rss,
                anon_kib: anon,
                file_kib: rss - anon,
                shmem_kib: 0,
            })
        }
    }

    /// pid → ppid for every live process: enumerate all pids with
    /// `proc_listallpids`, then resolve each parent via [`ppid`].
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut parent: HashMap<u32, u32> = HashMap::new();
        for pid in all_pids() {
            if let Some(pp) = ppid(pid) {
                parent.insert(pid, pp);
            }
        }
        parent
    }

    /// All live pids via `proc_listallpids`. Empty vec on failure.
    ///
    /// `proc_listallpids` returns a *count* of pids (it divides the kernel's
    /// byte count by `sizeof(pid_t)`): with a null buffer it reports how many
    /// pids exist, and with a real buffer it reports how many it filled in.
    fn all_pids() -> Vec<u32> {
        // SAFETY: the first call passes a null buffer / zero size, so the kernel
        // only reports the pid count and writes nothing. We then size a buffer to
        // that count plus slack (covering processes spawned between the two
        // calls), pass its length in *bytes*, and use the returned pid count to
        // bound how many entries we read back — never more than we allocated.
        unsafe {
            let count = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if count <= 0 {
                return Vec::new();
            }
            let cap = count as usize + 64;
            let mut pids = vec![0i32; cap];
            let filled = libc::proc_listallpids(
                pids.as_mut_ptr() as *mut libc::c_void,
                (cap * std::mem::size_of::<i32>()) as libc::c_int,
            );
            if filled <= 0 {
                return Vec::new();
            }
            pids.truncate(filled as usize);
            pids.into_iter()
                .filter(|&p| p > 0)
                .map(|p| p as u32)
                .collect()
        }
    }

    // ── whole-system snapshot (mach host FFI) ───────────────────────────────
    //
    // The mach host calls below are not in the `libc` crate, so they are
    // declared manually (same raw-FFI pattern as the libproc calls above; all
    // live in the always-linked libSystem).

    extern "C" {
        fn mach_host_self() -> u32;
        fn host_processor_info(
            host: u32,
            flavor: i32,
            out_processor_count: *mut u32,
            out_processor_info: *mut *mut u32,
            out_processor_info_count: *mut u32,
        ) -> i32;
        fn host_statistics64(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
        fn vm_deallocate(task: u32, address: usize, size: usize) -> i32;
        static mach_task_self_: u32;
    }

    /// `PROCESSOR_CPU_LOAD_INFO`.
    const CPU_LOAD_INFO: i32 = 2;
    /// `HOST_VM_INFO64`.
    const HOST_VM_INFO64: i32 = 4;
    /// sysctl MIB names (numeric so no reliance on libc exposing each const).
    const CTL_KERN: i32 = 1;
    const KERN_BOOTTIME: i32 = 21;
    const CTL_VM: i32 = 2;
    const VM_SWAPUSAGE: i32 = 5;
    const CTL_HW: i32 = 6;
    const HW_MEMSIZE: i32 = 24;

    /// The head of `struct vm_statistics64` — only the leading fixed-width
    /// counters this module reads. `host_statistics64` copies out at most the
    /// count we pass, so declaring a prefix is sound (the kernel truncates to
    /// the caller's count; it never writes past it).
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct VmStatistics64Head {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
    }

    /// Generic fixed-size sysctl read. `None` when the kernel rejects the MIB
    /// or writes a different size than expected.
    fn sysctl_read<T>(mib: &mut [i32]) -> Option<T> {
        // SAFETY: every T used here is a plain-old-data sysctl out-struct
        // (u64 / libc::timeval / libc::xsw_usage), for which an all-zero bit
        // pattern is a valid value; sysctl writes at most `len` bytes into it
        // and updates `len`, and the result is used only when the kernel
        // reported writing the full struct.
        unsafe {
            let mut out: T = std::mem::zeroed();
            let mut len = std::mem::size_of::<T>();
            let rc = libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                &mut out as *mut T as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            );
            (rc == 0 && len == std::mem::size_of::<T>()).then_some(out)
        }
    }

    /// Per-core cumulative CPU times in nanoseconds, via `host_processor_info`.
    /// Failure degrades to an empty per-core list. The raw tick decode is the
    /// pure, unit-tested [`super::parse_host_processor_ticks`].
    fn per_core_times(ns_per_tick: u64) -> Vec<super::CpuTimes> {
        let mut cpu_count: u32 = 0;
        let mut info: *mut u32 = std::ptr::null_mut();
        let mut info_count: u32 = 0;
        // SAFETY: all three out-params are valid; on KERN_SUCCESS the kernel
        // vm_allocates `info` (info_count u32s), which we copy out of and then
        // vm_deallocate exactly once with the byte size it reported.
        unsafe {
            let rc = host_processor_info(
                mach_host_self(),
                CPU_LOAD_INFO,
                &mut cpu_count,
                &mut info,
                &mut info_count,
            );
            if rc != 0 || info.is_null() {
                return Vec::new();
            }
            let ticks = std::slice::from_raw_parts(info, info_count as usize).to_vec();
            let _ = vm_deallocate(
                mach_task_self_,
                info as usize,
                info_count as usize * std::mem::size_of::<u32>(),
            );
            super::parse_host_processor_ticks(&ticks, ns_per_tick)
        }
    }

    /// `(mem_total, mem_available, swap_total, swap_free)` in KiB, from
    /// `sysctl hw.memsize` + the mach VM statistics + `sysctl vm.swapusage`.
    fn memory_kib() -> (u64, u64, u64, u64) {
        let mem_total_kib = sysctl_read::<u64>(&mut [CTL_HW, HW_MEMSIZE])
            .map(|bytes| bytes / 1024)
            .unwrap_or(0);
        // SAFETY: sysconf takes no pointers.
        let page_kib = {
            let ps = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
            if ps > 0 {
                ps as u64 / 1024
            } else {
                4
            }
        };
        let mem_available_kib = {
            let mut head = VmStatistics64Head::default();
            let mut count =
                (std::mem::size_of::<VmStatistics64Head>() / std::mem::size_of::<i32>()) as u32;
            // SAFETY: `head` is a valid prefix buffer and `count` is its exact
            // size in integer_t units; the kernel copies out at most `count`.
            let rc = unsafe {
                host_statistics64(
                    mach_host_self(),
                    HOST_VM_INFO64,
                    &mut head as *mut VmStatistics64Head as *mut i32,
                    &mut count,
                )
            };
            if rc == 0 {
                // free + inactive ≈ reclaimable, the usual "available" proxy.
                (head.free_count as u64 + head.inactive_count as u64) * page_kib
            } else {
                0
            }
        };

        let (swap_total_kib, swap_free_kib) =
            sysctl_read::<libc::xsw_usage>(&mut [CTL_VM, VM_SWAPUSAGE])
                .map(|xsw| (xsw.xsu_total / 1024, xsw.xsu_avail / 1024))
                .unwrap_or((0, 0));

        (
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
        )
    }

    fn load_avg() -> [f64; 3] {
        let mut load_avg = [0.0f64; 3];
        // SAFETY: getloadavg writes at most 3 doubles into the array.
        unsafe {
            let _ = libc::getloadavg(load_avg.as_mut_ptr(), 3);
        }
        load_avg
    }

    /// Aggregate-only sample (see [`super::MachineLoad`]): the host CPU tick
    /// counters, memory and load average, and none of the libproc walk. CPU
    /// counters are nanoseconds, exactly as in the whole snapshot.
    pub fn machine_load() -> super::MachineLoad {
        // SAFETY: sysconf takes no pointers.
        let clk = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let ns_per_tick = if clk > 0 {
            1_000_000_000 / clk as u64
        } else {
            10_000_000
        };
        let per_core = per_core_times(ns_per_tick);
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = memory_kib();

        super::MachineLoad {
            supported: true,
            num_cores: per_core.len() as u32,
            cpu: super::CpuTimes {
                busy: per_core.iter().map(|c| c.busy).sum(),
                total: per_core.iter().map(|c| c.total).sum(),
            },
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg: load_avg(),
            cpu_temp_c: None, // no cheap CPU thermal read on this backend
            mem_temp_c: None, // nor a DIMM one
        }
    }

    /// Whole-system sample via mach/sysctl/libproc. All CPU counters are in
    /// nanoseconds to match `proc_ticks`/`clk_tck` (1e9) — the frontend
    /// divides per-process by machine deltas, so the units MUST agree; the
    /// host tick counters are converted via `1e9 / _SC_CLK_TCK`.
    ///
    /// Visibility caveat: unprivileged `proc_pidinfo` only inspects the
    /// calling user's processes, so other users' (and most system) processes
    /// appear without CPU/RSS detail — they are skipped entirely rather than
    /// listed as zero rows (TODO 31c).
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};

        // SAFETY: sysconf takes no pointers.
        let clk = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let ns_per_tick = if clk > 0 {
            1_000_000_000 / clk as u64
        } else {
            10_000_000
        };

        let per_core = per_core_times(ns_per_tick);
        let cpu = super::CpuTimes {
            busy: per_core.iter().map(|c| c.busy).sum(),
            total: per_core.iter().map(|c| c.total).sum(),
        };

        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = memory_kib();
        let load_avg = load_avg();

        let uptime_secs = sysctl_read::<libc::timeval>(&mut [CTL_KERN, KERN_BOOTTIME])
            .map(|boot| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                (now - boot.tv_sec).max(0) as f64
            })
            .unwrap_or(0.0);

        // Process table: pids we can't inspect (other users, most system
        // daemons — see the visibility caveat above) are skipped.
        let mut processes = Vec::new();
        for pid in all_pids() {
            let Some(task) = task_info(pid) else {
                continue;
            };
            let Some(bsd) = bsd_info(pid) else {
                continue;
            };
            let comm = super::decode_ansi_nul(&bsd.pbi_comm);
            processes.push(ProcSample {
                pid,
                ppid: bsd.pbi_ppid,
                cmdline: format!("[{comm}]"),
                comm,
                state: super::bsd_process_state(bsd.pbi_status),
                rss_kib: task.pti_resident_size / 1024,
                cpu_jiffies: task.pti_total_user.wrapping_add(task.pti_total_system),
                threads: task.pti_threadnum.max(0) as u32,
                // Owner name isn't resolved here (only the calling user's processes
                // are visible anyway); the pane hides the per-user section when no
                // process reports one.
                user: String::new(),
            });
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(), // 1e9 — everything above is in ns
            num_cores: per_core.len() as u32,
            cpu,
            per_core,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg,
            uptime_secs,
            processes,
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: None,     // no cheap CPU thermal read on this backend
            mem_temp_c: None,     // nor a memory thermal read
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
            careful: false,       // a local sample: this machine is the user's own
        }
    }
}

// ── Fallback backend (other OSes) ───────────────────────────────────────────
// Targets with no `/proc`, no ToolHelp, and no libproc; the readout degrades to
// zero rather than failing to compile.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use std::collections::HashMap;

    pub fn clk_tck() -> u64 {
        // Arbitrary positive value; `sum_jiffies` is always 0 here so the derived
        // CPU percentage is 0 regardless, and callers never divide by zero.
        100
    }

    pub fn parent_map() -> HashMap<u32, u32> {
        HashMap::new()
    }

    pub fn proc_ticks(_pid: u32) -> Option<u64> {
        None
    }

    pub fn rss_kib(_pid: u32) -> Option<u64> {
        None
    }

    pub fn ppid(_pid: u32) -> Option<u32> {
        None
    }

    pub fn cmdline(_pid: u32) -> Option<String> {
        None
    }

    /// No `/proc`-style enumeration here: return an unsupported snapshot so the
    /// monitor pane degrades to a placeholder rather than failing to build.
    pub fn system_snapshot() -> super::SystemSnapshot {
        super::SystemSnapshot::default()
    }

    /// Nothing to read: `supported: false`, so the readout omits the block
    /// instead of printing zeros that look like measurements.
    pub fn machine_load() -> super::MachineLoad {
        super::MachineLoad::default()
    }
}

/// Serializes every test that touches the process-tree cache globals. They all
/// mutate `DESCENDANT_CACHE` or bump `PROC_TREE_GEN`, so running them
/// concurrently races on that shared state: a seeded synthetic entry is either
/// overwritten or invalidated out from under the test that seeded it. Lives at
/// module level rather than inside `mod tests` because the racing callers are in
/// *other* modules' test code (`terminal::tests` spawns a PTY and invalidates the
/// cache in a poll loop), and they must take the same lock.
#[cfg(test)]
pub(crate) static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Take [`CACHE_TEST_LOCK`] for the duration of a test, tolerating poisoning.
/// A test that trips an assertion while holding the lock poisons it; without
/// this, every later cache test fails on the poison rather than on its own
/// behaviour, turning one real failure into a cascade of phantom ones.
#[cfg(test)]
pub(crate) fn lock_cache_for_test() -> std::sync::MutexGuard<'static, ()> {
    CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    #[test]
    fn procargs2_yields_argv_without_the_environment() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&3u32.to_ne_bytes());
        buf.extend_from_slice(b"/Applications/X.app/Contents/MacOS/x\0\0\0");
        buf.extend_from_slice(b"x\0--type=renderer\0--flag\0");
        buf.extend_from_slice(b"SECRET=placeholder\0HOME=/Users/a\0");
        assert_eq!(
            super::parse_procargs2(&buf).as_deref(),
            Some("x --type=renderer --flag")
        );
        // Short / malformed buffers answer nothing rather than panic.
        assert_eq!(super::parse_procargs2(b"\x01\x00"), None);
        assert_eq!(super::parse_procargs2(&0u32.to_ne_bytes()), None);
    }

    #[test]
    fn procargs2_env_starts_after_the_argv_strings() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&3u32.to_ne_bytes());
        buf.extend_from_slice(b"/Applications/X.app/Contents/MacOS/x\0\0\0");
        // An empty argument still ends at its own NUL.
        buf.extend_from_slice(b"x\0\0--flag\0");
        buf.extend_from_slice(b"SECRET=placeholder\0HOME=/Users/a\0\0executable_path=/x\0");
        assert_eq!(
            super::procargs2_env(&buf),
            &b"SECRET=placeholder\0HOME=/Users/a\0\0executable_path=/x\0"[..]
        );
        // The argv reader is unchanged by the split.
        assert_eq!(super::parse_procargs2(&buf).as_deref(), Some("x  --flag"));
        // No environment, a truncated argv and junk all answer empty.
        let mut bare = 1u32.to_ne_bytes().to_vec();
        bare.extend_from_slice(b"/bin/sh\0sh\0");
        assert!(super::procargs2_env(&bare).is_empty());
        let mut cut = 2u32.to_ne_bytes().to_vec();
        cut.extend_from_slice(b"/bin/sh\0sh\0-c");
        assert!(super::procargs2_env(&cut).is_empty());
        assert!(super::procargs2_env(b"\x01\x00").is_empty());
        assert!(super::procargs2_env(&0u32.to_ne_bytes()).is_empty());
    }

    use super::*;

    #[test]
    fn rss_breakdown_reads_the_four_fields() {
        let status = "Name:\tWebKitWebProcess\nVmRSS:\t 4744000 kB\nRssAnon:\t 4600000 kB\nRssFile:\t  100000 kB\nRssShmem:\t   44000 kB\nThreads:\t37\n";
        assert_eq!(
            parse_rss_breakdown(status),
            RssBreakdown { rss_kib: 4_744_000, anon_kib: 4_600_000, file_kib: 100_000, shmem_kib: 44_000 }
        );
        // A kernel without the split still yields the total.
        assert_eq!(parse_rss_breakdown("VmRSS:\t 12 kB\n").rss_kib, 12);
    }

    #[test]
    fn smaps_aggregates_by_mapping_name_largest_first() {
        let smaps = "\
7f00-7f10 rw-p 00000000 00:00 0 \n\
Rss:                 300 kB\n\
7f10-7f20 rw-p 00000000 00:00 0                          [heap]\n\
Rss:                 100 kB\n\
7f20-7f30 r-xp 00000000 08:01 1234 /usr/lib/lib with space.so\n\
Rss:                  50 kB\n\
7f30-7f40 rw-p 00000000 00:00 0 \n\
Rss:                 200 kB\n\
7f40-7f50 rw-s 00000000 00:01 5 /memfd:WebKit (deleted)\n\
Rss:                   0 kB\n";
        let rows = aggregate_smaps_rss(smaps, 8);
        assert_eq!(
            rows,
            vec![
                ("[anon]".to_string(), 500),
                ("[heap]".to_string(), 100),
                ("/usr/lib/lib with space.so".to_string(), 50),
            ]
        );
        assert_eq!(aggregate_smaps_rss(smaps, 1).len(), 1);
    }

    #[test]
    fn clk_tck_is_positive() {
        assert!(clk_tck() > 0, "ticks-per-second must be positive");
    }

    #[test]
    fn is_cpu_hwmon_matches_only_cpu_sensors() {
        assert!(is_cpu_hwmon("coretemp"));
        assert!(is_cpu_hwmon("k10temp"));
        assert!(is_cpu_hwmon("zenpower"));
        assert!(is_cpu_hwmon("cpu_thermal\n"), "trailing newline is trimmed");
        assert!(!is_cpu_hwmon("amdgpu"), "a GPU sensor is not the CPU");
        assert!(!is_cpu_hwmon("nvme"));
        assert!(!is_cpu_hwmon(""));
    }

    #[test]
    fn pick_cpu_temp_prefers_package_channel() {
        // Intel coretemp: `Package id 0` wins over the per-core channels.
        let intel = vec![
            (Some("Core 0".to_string()), 45000.0),
            (Some("Package id 0".to_string()), 52000.0),
            (Some("Core 1".to_string()), 47000.0),
        ];
        assert_eq!(pick_cpu_temp(&intel), Some(52.0));

        // AMD k10temp: `Tctl` wins over `Tccd1`.
        let amd = vec![
            (Some("Tccd1".to_string()), 58000.0),
            (Some("Tctl".to_string()), 61000.0),
        ];
        assert_eq!(pick_cpu_temp(&amd), Some(61.0));

        // No labels at all: fall back to the first channel (temp1_input).
        let bare = vec![(None, 40000.0), (None, 99000.0)];
        assert_eq!(pick_cpu_temp(&bare), Some(40.0));

        // No channels: unknown, never a fake zero.
        assert_eq!(pick_cpu_temp(&[]), None);
    }

    #[test]
    fn remote_snapshot_reads_cpu_temp() {
        let raw = "\
CLK\t100
@STAT@
cpu  1 2 3 4 5 6 7 8
@CPUTEMP@
T\tCore 0\t45000
T\tPackage id 0\t53000
@PROCS@
";
        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.cpu_temp_c, Some(53.0), "host package temp is surfaced");
    }

    #[test]
    fn is_mem_hwmon_matches_only_dimm_sensors() {
        assert!(is_mem_hwmon("jc42"), "DDR3/DDR4 on-module sensor");
        assert!(is_mem_hwmon("spd5118\n"), "DDR5 SPD hub, newline trimmed");
        assert!(!is_mem_hwmon("coretemp"), "a CPU sensor is not memory");
        assert!(!is_mem_hwmon("amdgpu"));
        assert!(!is_mem_hwmon(""));
    }

    #[test]
    fn remote_snapshot_reads_hottest_dimm_temp() {
        let raw = "\
CLK\t100
@STAT@
cpu  1 2 3 4 5 6 7 8
@MEMTEMP@
M\t41000
M\t46500
M\t44000
@PROCS@
";
        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.mem_temp_c, Some(46.5), "hottest module wins");
    }

    #[test]
    fn remote_snapshot_has_no_mem_temp_when_section_empty() {
        let raw = "CLK\t100\n@STAT@\ncpu  1 2 3 4 5 6 7 8\n@MEMTEMP@\n@PROCS@\n";
        assert_eq!(parse_remote_snapshot(raw).mem_temp_c, None);
    }

    #[test]
    fn descendant_pids_includes_its_own_root() {
        let _guard = lock_cache_for_test();
        let me = std::process::id();
        let pids = descendant_pids(&[me]);
        assert!(
            pids.contains(&me),
            "descendant set must contain the root pid itself"
        );
    }

    #[test]
    fn descendant_pids_empty_for_no_roots() {
        assert!(descendant_pids(&[]).is_empty());
    }

    #[test]
    fn descendant_pids_serves_cache_hit_for_unchanged_generation() {
        let _guard = lock_cache_for_test();
        // Directly exercise the cache mechanics independent of the live process
        // tree (other parallel tests fork children, so the *real* tree is not a
        // stable fixture). Seed the cache with a synthetic entry, then confirm a
        // matching query returns it verbatim, and that bumping the generation or
        // changing the root set forces a real recompute.
        let fake_roots = vec![424242u32];
        let fake_pids = vec![424242u32, 999999u32];
        let gen = PROC_TREE_GEN.load(Ordering::Relaxed);
        {
            let mut cache = DESCENDANT_CACHE.lock().unwrap();
            *cache = vec![DescendantCache {
                roots: fake_roots.clone(),
                pids: fake_pids.clone(),
                generation: gen,
                computed_at: Instant::now(),
            }];
        }
        // Same roots + same generation + fresh → cache hit returns the seeded set
        // (which could never come from a real process walk for pid 424242).
        assert_eq!(descendant_pids(&[424242]), fake_pids);

        // Invalidation bumps the generation, so the stale synthetic entry is no
        // longer reused — the rebuild walks the real tree and 999999 is gone.
        invalidate_descendant_cache();
        assert_ne!(descendant_pids(&[424242]), fake_pids);
    }

    #[test]
    fn descendant_pids_cache_keys_on_root_set() {
        let _guard = lock_cache_for_test();
        // A seeded entry for one root set must not satisfy a query for another.
        let gen = PROC_TREE_GEN.load(Ordering::Relaxed);
        {
            let mut cache = DESCENDANT_CACHE.lock().unwrap();
            *cache = vec![DescendantCache {
                roots: vec![111111u32],
                pids: vec![111111u32, 222222u32],
                generation: gen,
                computed_at: Instant::now(),
            }];
        }
        // Different roots → cache miss → recompute (no 222222 from a real walk).
        let other = descendant_pids(&[333333]);
        assert!(!other.contains(&222222));
    }

    #[test]
    fn descendant_pids_cache_holds_multiple_root_sets() {
        let _guard = lock_cache_for_test();
        // The concrete regression the keyed cache fixes: two callers alternating
        // different root sets (a hovered pill and the renderer watchdog) must
        // BOTH stay warm instead of evicting each other every sample. Seed two
        // synthetic entries; both queries must be served from the cache (the
        // seeded pids could never come from a real process walk).
        let gen = PROC_TREE_GEN.load(Ordering::Relaxed);
        let a = DescendantCache {
            roots: vec![424242u32],
            pids: vec![424242u32, 555555u32],
            generation: gen,
            computed_at: Instant::now(),
        };
        let b = DescendantCache {
            roots: vec![434343u32],
            pids: vec![434343u32, 666666u32],
            generation: gen,
            computed_at: Instant::now(),
        };
        {
            let mut cache = DESCENDANT_CACHE.lock().unwrap();
            *cache = vec![a, b];
        }
        assert_eq!(descendant_pids(&[424242]), vec![424242, 555555]);
        assert_eq!(descendant_pids(&[434343]), vec![434343, 666666]);
        // And reading one must not have evicted the other: both still hit.
        assert_eq!(descendant_pids(&[424242]), vec![424242, 555555]);
    }

    // The sampling assertions below rely on a real process backend (Linux `/proc`
    // or Windows ToolHelp). On the zero fallback they would trivially fail, so
    // they are scoped to the two backends that actually sample.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn sum_jiffies_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        // Burn a little CPU so this process has measurable user time.
        let mut acc: u64 = 0;
        for i in 0..2_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        assert!(acc > 0);
        assert!(
            sum_jiffies(&[me]) > 0,
            "the running test process should report ticks"
        );
        // A pid that cannot exist contributes nothing rather than panicking.
        assert_eq!(sum_jiffies(&[u32::MAX]), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn sum_rss_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        assert!(
            sum_rss_kib(&[me]) > 0,
            "the running test process should report RSS"
        );
        assert_eq!(sum_rss_kib(&[u32::MAX]), 0);
    }

    // ── /proc string parsers (pure; run on any OS) ──────────────────────────

    #[test]
    fn parse_cpu_stat_splits_aggregate_and_cores() {
        let stat = "\
cpu  100 20 30 1000 40 5 5 0 0 0
cpu0 60 10 15 500 20 3 2 0 0 0
cpu1 40 10 15 500 20 2 3 0 0 0
intr 12345
ctxt 67890
";
        let (agg, cores) = parse_cpu_stat(stat);
        // total = sum of all columns; busy = total - idle - iowait.
        assert_eq!(agg.total, 100 + 20 + 30 + 1000 + 40 + 5 + 5);
        assert_eq!(agg.busy, agg.total - 1000 - 40);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].total, 60 + 10 + 15 + 500 + 20 + 3 + 2);
        assert_eq!(cores[0].busy, cores[0].total - 500 - 20);
    }

    #[test]
    fn parse_meminfo_reads_selected_keys() {
        let mem = "\
MemTotal:       16308668 kB
MemFree:         1234567 kB
MemAvailable:    9876543 kB
Buffers:          123456 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
";
        let (total, avail, swap_total, swap_free) = parse_meminfo(mem);
        assert_eq!(total, 16_308_668);
        assert_eq!(avail, 9_876_543);
        assert_eq!(swap_total, 2_097_148);
        assert_eq!(swap_free, 2_000_000);
        // A missing key defaults to 0 rather than panicking.
        assert_eq!(parse_meminfo("MemTotal: 42 kB").1, 0);
    }

    #[test]
    fn parse_loadavg_reads_three_floats() {
        assert_eq!(
            parse_loadavg("0.52 0.58 0.59 1/1234 56789"),
            [0.52, 0.58, 0.59]
        );
        // Short/garbage input degrades to zeros.
        assert_eq!(parse_loadavg(""), [0.0, 0.0, 0.0]);
    }

    // ── Windows byte decoders (pure; run on any OS) ─────────────────────────

    /// Build one 48-byte SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION entry.
    fn perf_entry(idle: i64, kernel: i64, user: i64) -> Vec<u8> {
        let mut out = Vec::with_capacity(PROCESSOR_PERF_ENTRY_BYTES);
        for v in [idle, kernel, user, 0i64, 0i64] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 8]); // InterruptCount + padding
        out
    }

    #[test]
    fn parse_processor_perf_buffer_derives_busy_and_total() {
        let mut buf = perf_entry(1_000, 1_500, 300); // kernel includes idle
        buf.extend(perf_entry(0, 200, 100));
        let cores = parse_processor_perf_buffer(&buf);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].total, 1_800);
        assert_eq!(cores[0].busy, 800); // (kernel − idle) + user
        assert_eq!(cores[1].total, 300);
        assert_eq!(cores[1].busy, 300);
    }

    #[test]
    fn parse_processor_perf_buffer_ignores_partial_tail_and_clamps() {
        // A short trailing chunk (returned length mid-entry) is dropped, and a
        // negative time (corrupt input) clamps to 0 instead of wrapping.
        let mut buf = perf_entry(-5, -10, 40);
        buf.extend_from_slice(&[0u8; 20]);
        let cores = parse_processor_perf_buffer(&buf);
        assert_eq!(cores.len(), 1);
        assert_eq!(cores[0].total, 40);
        assert_eq!(cores[0].busy, 40);
        assert!(parse_processor_perf_buffer(&[]).is_empty());
    }

    #[test]
    fn decode_ansi_nul_stops_at_nul_and_is_lossy() {
        let mut raw = [0i8; 16];
        for (i, b) in b"explorer.exe".iter().enumerate() {
            raw[i] = *b as i8;
        }
        raw[13] = b'x' as i8; // garbage after the NUL must be ignored
        assert_eq!(decode_ansi_nul(&raw), "explorer.exe");
        assert_eq!(decode_ansi_nul(&[-28, 0]), "\u{fffd}"); // lone 0xE4 byte
        assert_eq!(decode_ansi_nul(&[]), "");
    }

    // ── macOS decoders (pure; run on any OS) ────────────────────────────────

    #[test]
    fn parse_host_processor_ticks_scales_to_ns_and_sums_busy() {
        // Two cores, CPU_STATE order user/system/idle/nice, clk_tck=100 →
        // ns_per_tick = 10_000_000.
        let ticks = [100u32, 50, 800, 10, 0, 0, 1000, 0];
        let cores = parse_host_processor_ticks(&ticks, 10_000_000);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].busy, (100 + 50 + 10) * 10_000_000);
        assert_eq!(cores[0].total, (100 + 50 + 10 + 800) * 10_000_000);
        assert_eq!(cores[1].busy, 0);
        assert_eq!(cores[1].total, 1000 * 10_000_000);
    }

    #[test]
    fn parse_host_processor_ticks_ignores_partial_tail() {
        // A truncated final chunk (interrupted copy-out) is dropped, and huge
        // cumulative counters don't overflow at ns scale within u64.
        let cores = parse_host_processor_ticks(&[u32::MAX, 0, u32::MAX, 0, 7, 7], 10_000_000);
        assert_eq!(cores.len(), 1);
        assert_eq!(cores[0].busy, u32::MAX as u64 * 10_000_000);
        assert!(parse_host_processor_ticks(&[1, 2, 3], 1).is_empty());
    }

    #[test]
    fn bsd_process_state_maps_to_linux_letters() {
        assert_eq!(bsd_process_state(2), "R"); // SRUN
        assert_eq!(bsd_process_state(3), "S"); // SSLEEP
        assert_eq!(bsd_process_state(4), "T"); // SSTOP
        assert_eq!(bsd_process_state(5), "Z"); // SZOMB
        assert_eq!(bsd_process_state(1), "I"); // SIDL
        assert_eq!(bsd_process_state(0), "");
        assert_eq!(bsd_process_state(99), "");
    }

    #[test]
    fn parse_pid_stat_handles_comm_with_spaces_and_parens() {
        // comm = "Web Content" (spaces); a naive whitespace split would misalign
        // every field — parsing must key off the last ')'.
        let line = "1234 (Web (Content)) S 1000 1234 1000 0 -1 4194560 \
100 0 0 0 4200 1300 0 0 20 0 27 0 999 0 0";
        let (comm, state, ppid, cpu, threads) = parse_pid_stat(line).unwrap();
        assert_eq!(comm, "Web (Content)");
        assert_eq!(state, "S");
        assert_eq!(ppid, 1000);
        assert_eq!(cpu, 4200 + 1300); // utime + stime
        assert_eq!(threads, 27);
    }

    #[test]
    fn parse_remote_snapshot_assembles_from_script_output() {
        // A minimal but complete capture in the wire format REMOTE_SNAPSHOT_SCRIPT
        // emits: a CLK line, `@SECTION@` blocks of raw kernel files (incl. `who`),
        // pid-keyed S/R lines under `@PROCS@`, then the separate `@CMDLINE@` block.
        // One core, 8 GiB RAM, two processes — one with a real cmdline, one kernel
        // thread, which (having an empty cmdline) `grep` emits NO line for at all,
        // exercising the `[comm]` fallback on a genuinely absent entry.
        let raw = "CLK\t100\n\
@STAT@\n\
cpu  100 0 50 800 0 0 0 0 0 0\n\
cpu0 100 0 50 800 0 0 0 0 0 0\n\
intr 12345\n\
@MEM@\n\
MemTotal:        8192000 kB\n\
MemAvailable:    4096000 kB\n\
SwapTotal:       2048000 kB\n\
SwapFree:        2048000 kB\n\
@LOAD@\n\
0.50 0.40 0.30 1/234 5678\n\
@UP@\n\
123456.78 987654.32\n\
@WHO@\n\
alice    pts/0        2026-07-18 09:12 (203.0.113.5)\n\
alice    pts/1        2026-07-18 09:20 (203.0.113.5)\n\
bob      tty1         2026-07-17 22:03\n\
@PROCS@\n\
S\t42\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
R\t42\t2048\n\
S\t7\t7 (kworker/0:1) I 2 0 0 0 -1 69238880 0 0 0 0 5 2 0 0 20 0 1 0 50 0 0\n\
R\t7\t0\n\
@CMDLINE@\n\
/proc/42/cmdline:/usr/bin/bash -i\n";

        let snap = parse_remote_snapshot(raw);
        assert!(snap.supported);
        assert_eq!(snap.clk_tck, 100);
        assert_eq!(snap.num_cores, 1);
        assert_eq!(snap.per_core.len(), 1);
        // total = sum of all columns; busy = total − idle − iowait (800 idle here).
        assert_eq!(snap.cpu.total, 100 + 50 + 800);
        assert_eq!(snap.cpu.busy, 150);
        assert_eq!(snap.mem_total_kib, 8_192_000);
        assert_eq!(snap.mem_available_kib, 4_096_000);
        assert_eq!(snap.swap_total_kib, 2_048_000);
        assert_eq!(snap.load_avg, [0.50, 0.40, 0.30]);
        assert_eq!(snap.uptime_secs as u64, 123_456);
        assert!(snap.gpus.is_empty());

        // Looked up by pid, not by index: the blocks are joined on the pid key, so
        // the table's order is not what this is asserting.
        assert_eq!(snap.processes.len(), 2);
        let by_pid = |pid: u32| snap.processes.iter().find(|p| p.pid == pid).unwrap();
        let bash = by_pid(42);
        assert_eq!(bash.ppid, 1);
        assert_eq!(bash.comm, "bash");
        assert_eq!(bash.state, "S");
        assert_eq!(bash.rss_kib, 2048);
        assert_eq!(bash.cpu_jiffies, 12 + 8);
        assert_eq!(bash.threads, 3);
        assert_eq!(bash.cmdline, "/usr/bin/bash -i");
        // Kernel thread: no `@CMDLINE@` line at all falls back to `[comm]`.
        let kworker = by_pid(7);
        assert_eq!(kworker.rss_kib, 0);
        assert_eq!(kworker.cmdline, "[kworker/0:1]");

        // `who` → login sessions for the "Logged in" panel: three sessions across
        // two users, the tail of each line kept verbatim as `detail`.
        assert_eq!(snap.sessions.len(), 3);
        assert_eq!(snap.sessions[0].user, "alice");
        assert_eq!(snap.sessions[0].tty, "pts/0");
        assert!(snap.sessions[0].detail.contains("203.0.113.5"));
        assert_eq!(snap.sessions[2].user, "bob");
        assert_eq!(snap.sessions[2].tty, "tty1");
        // No `ME` line (a host whose `id -un` said nothing): no row is invented and
        // none is flagged, rather than an owner being guessed.
        assert!(!snap.sessions.iter().any(|s| s.is_self));
    }

    #[test]
    fn who_synthesizes_the_sampling_account_when_utmp_has_no_record() {
        // The bug this fixes: `who` reads utmp, which only gets an entry when sshd
        // allocated a pty. The monitor's own probe rides the pooled (non-pty)
        // master, so a user with no terminal tab open on the host saw everyone
        // logged in EXCEPT themselves.
        let who = "\
alice    pts/0        2026-07-18 09:12 (203.0.113.5)\n\
bob      tty1         2026-07-17 22:03\n";
        let sessions = parse_who(who, "carol");
        assert_eq!(sessions.len(), 3);
        // The synthesized row comes first and is flagged; the others are untouched.
        assert_eq!(sessions[0].user, "carol");
        assert!(sessions[0].is_self);
        assert_eq!(sessions[0].tty, SELF_SESSION_TTY);
        assert!(!sessions[1].is_self && !sessions[2].is_self);

        // An account that DOES hold a pty session is only flagged — never doubled.
        let sessions = parse_who(who, "alice");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].user, "alice");
        assert!(sessions[0].is_self);
        assert_eq!(sessions[0].tty, "pts/0");
        assert!(!sessions[1].is_self);

        // Careful mode ships only this account's own `who` lines — and an HPC login
        // node the user reached without a pty ships none at all, which is exactly
        // the case that used to read "no interactive logins on this host".
        let sessions = parse_who("", "carol");
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].is_self);

        // Unknown account: nothing invented.
        assert!(parse_who("", "").is_empty());
    }

    #[test]
    fn parse_passwd_maps_uid_to_name() {
        let content = "\
root:x:0:0:root:/root:/bin/bash
alice:x:1000:1000:Alice:/home/alice:/bin/bash
bob:x:1001:1001::/home/bob:/bin/zsh
# a comment line is skipped
malformed-no-uid
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
";
        let map = parse_passwd(content);
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
        assert_eq!(map.get(&1000).map(String::as_str), Some("alice"));
        assert_eq!(map.get(&1001).map(String::as_str), Some("bob"));
        assert_eq!(map.get(&1).map(String::as_str), Some("daemon"));
        // A known uid resolves to its name; an unknown one falls back to `#<uid>`.
        assert_eq!(username_for(1000, &map), "alice");
        assert_eq!(username_for(4242, &map), "#4242");
    }

    #[test]
    fn parse_remote_snapshot_joins_cmdline_by_pid() {
        // `@CMDLINE@` is captured by its own pass over `/proc` (one `grep`, not a
        // fork per process), so it neither lines up positionally with `@PROCS@`
        // nor is guaranteed to describe the same set of pids. The join is on the
        // pid grep puts in its `/proc/<pid>/cmdline:` prefix, and this pins the
        // four ways that block can disagree with the process table.
        let raw = "CLK\t100\n\
@PROCS@\n\
S\t42\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
R\t42\t2048\n\
S\t7\t7 (kworker/0:1) I 2 0 0 0 -1 69238880 0 0 0 0 5 2 0 0 20 0 1 0 50 0 0\n\
R\t7\t0\n\
@CMDLINE@\n\
/proc/999/cmdline:started-after-the-procs-pass\n\
/proc/42/cmdline:env PATH=/usr/bin:/bin prog --flag\n\
a continuation line from an arg containing a newline\n";

        let snap = parse_remote_snapshot(raw);
        let by_pid = |pid: u32| snap.processes.iter().find(|p| p.pid == pid).unwrap();
        // A cmdline is not split on its own colons — only the grep prefix is.
        assert_eq!(by_pid(42).cmdline, "env PATH=/usr/bin:/bin prog --flag");
        // No `@CMDLINE@` line at all (a kernel thread's is empty, so grep emits
        // nothing for it) → the `[comm]` fallback, not a blank name.
        assert_eq!(by_pid(7).cmdline, "[kworker/0:1]");
        // A cmdline for a pid the `@PROCS@` pass never saw invents no process:
        // `S` is what declares one exists.
        assert_eq!(snap.processes.len(), 2);
        assert!(snap.processes.iter().all(|p| p.pid != 999));
    }

    #[test]
    fn parse_remote_snapshot_resolves_process_owner() {
        // The @PASSWD@ block feeds the uid→name map; each process's `U` line names
        // its owner uid, resolved against that map (an unmapped uid → `#<uid>`).
        let raw = "CLK\t100\n\
@PASSWD@\n\
root:x:0:0:root:/root:/bin/bash\n\
alice:x:1000:1000:Alice:/home/alice:/bin/bash\n\
@PROCS@\n\
S\t42\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
U\t42\t1000\n\
R\t42\t2048\n\
S\t1\t1 (systemd) S 0 1 1 0 -1 4194560 200 0 0 0 5 5 0 0 20 0 1 0 5 0 0\n\
U\t1\t0\n\
R\t1\t4096\n\
S\t99\t99 (weird) S 1 99 99 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 100 0 0\n\
U\t99\t7777\n\
R\t99\t128\n\
S\t55\t55 (silent) S 1 55 55 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 100 0 0\n\
R\t55\t64\n\
@CMDLINE@\n\
/proc/42/cmdline:/usr/bin/bash -i\n\
/proc/1/cmdline:/sbin/init\n\
/proc/99/cmdline:weird\n";

        let snap = parse_remote_snapshot(raw);
        let by_pid = |pid: u32| snap.processes.iter().find(|p| p.pid == pid).unwrap();
        assert_eq!(snap.processes.len(), 4);
        assert_eq!(by_pid(42).user, "alice");
        assert_eq!(by_pid(1).user, "root");
        // An owner uid with no passwd entry falls back to `#<uid>`.
        assert_eq!(by_pid(99).user, "#7777");
        // pid 55 shipped no `U` line at all (its `status` withheld `Uid:`). That
        // must read as "owner unknown" — blank — and NOT as uid 0, which the old
        // `${u:-0}` default turned every unreadable process into root.
        assert_eq!(by_pid(55).user, "");
        // No `CAREFUL` line at all is an ordinary (non-HPC) host: full collection,
        // and an unknown owner stays unknown rather than being bucketed.
        assert!(!snap.careful);
    }

    #[test]
    fn a_careful_sample_keeps_own_processes_and_buckets_everyone_else() {
        // What an HPC login node ships (`docs/context/hpc_careful_mode.md`): the
        // leading `CAREFUL` flag, a `@PASSWD@` holding ONLY the sampling account,
        // `U` lines only for its own processes, every foreign `comm` redacted to
        // `(other)` in the stat line, and cmdlines only for its own pids.
        let raw = "CAREFUL\t1\n\
CLK\t100\n\
@WHO@\n\
alice    pts/0        2026-07-18 09:12\n\
@PASSWD@\n\
alice:x:1000:1000:Alice:/home/alice:/bin/bash\n\
@PROCS@\n\
S\t42\t42 (python3) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
U\t42\t1000\n\
R\t42\t2048\n\
S\t77\t77 (other) S 1 77 77 0 -1 4194304 100 0 0 0 90 10 0 0 20 0 8 0 400 0 0\n\
R\t77\t8192\n\
S\t78\t78 (other) S 1 78 78 0 -1 4194304 100 0 0 0 30 5 0 0 20 0 2 0 410 0 0\n\
R\t78\t4096\n\
@CMDLINE@\n\
/proc/42/cmdline:python3 train.py --epochs 3\n\
@PASSWD2@\n";

        let snap = parse_remote_snapshot(raw);
        assert!(snap.careful);
        let by_pid = |pid: u32| snap.processes.iter().find(|p| p.pid == pid).unwrap();
        // Own process: full detail, resolved against the one passwd entry shipped.
        assert_eq!(by_pid(42).user, "alice");
        assert_eq!(by_pid(42).cmdline, "python3 train.py --epochs 3");
        // Everyone else: still counted (that is the "how loaded is this node"
        // half), but under ONE label — not a uid each, which would be the same
        // per-person breakdown by another name — and with no command to read.
        assert_eq!(by_pid(77).user, OTHER_USERS);
        assert_eq!(by_pid(78).user, OTHER_USERS);
        assert_eq!(by_pid(77).cmdline, "[other]");
        assert_eq!(by_pid(77).rss_kib, 8192);
        assert_eq!(by_pid(77).cpu_jiffies, 90 + 10);
        // The bucket is one row in the pane's per-user breakdown, whatever the
        // number of foreign processes behind it.
        let labels: std::collections::BTreeSet<&str> =
            snap.processes.iter().map(|p| p.user.as_str()).collect();
        assert_eq!(labels.len(), 2);
    }

    #[test]
    fn careful_mode_is_pinned_by_prefix_or_left_to_the_host() {
        // A caller with an answer pins it in either direction; `None` leaves the
        // script's own SLURM probe to decide.
        let forced = remote_snapshot_script(Some(true));
        assert!(forced.starts_with(concat!(crate::app_upper!(), "_CAREFUL=1\n")));
        assert!(forced.ends_with(REMOTE_SNAPSHOT_SCRIPT));
        assert!(remote_snapshot_script(Some(false)).starts_with(concat!(crate::app_upper!(), "_CAREFUL=0\n")));
        assert_eq!(remote_snapshot_script(None), REMOTE_SNAPSHOT_SCRIPT);
        // The host-side detection and every collection branch it gates.
        assert!(REMOTE_SNAPSHOT_SCRIPT.contains("command -v sbatch"));
        assert!(REMOTE_SNAPSHOT_SCRIPT.contains("getent passwd \"$_myuid\""));
        assert!(REMOTE_SNAPSHOT_SCRIPT.contains("(other)"));
    }

    #[test]
    fn parse_remote_snapshot_falls_back_to_passwd2_for_a_missing_uid() {
        // Regression for the "Logged in" panel reading a permanent 0%: on an NSS
        // setup that serves point lookups but not enumeration (SSSD's default
        // `enumerate = false`), the bulk `@PASSWD@` dump lists only `root` — a
        // directory-backed user like `carol` (uid 2000) is missing from it — but
        // `@PASSWD2@`'s targeted per-uid lookup (which the script runs for every
        // uid actually seen under `@PROCS@`) still resolves it. Her `who` name and
        // her process owner must end up as the exact same string, or the "Logged
        // in" panel's username-keyed CPU/MEM lookup misses and reads 0.
        let raw = "CLK\t100\n\
@WHO@\n\
carol    pts/0        2026-07-18 09:12\n\
@PASSWD@\n\
root:x:0:0:root:/root:/bin/bash\n\
@PROCS@\n\
S\t42\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
U\t42\t2000\n\
R\t42\t2048\n\
@CMDLINE@\n\
/proc/42/cmdline:/usr/bin/bash -i\n\
@PASSWD2@\n\
carol:x:2000:2000:Carol:/home/carol:/bin/bash\n";

        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.processes.len(), 1);
        assert_eq!(
            snap.processes[0].user, "carol",
            "resolved via the @PASSWD2@ supplement"
        );
        assert_eq!(snap.sessions[0].user, "carol");
        assert_eq!(
            snap.processes[0].user, snap.sessions[0].user,
            "the process owner and the who-reported name must match for the \
             \"Logged in\" panel's username-keyed lookup to attribute her CPU/MEM"
        );
    }

    #[test]
    fn parse_remote_snapshot_prefers_bulk_passwd_over_passwd2_on_conflict() {
        // @PASSWD2@ only fills gaps the bulk dump left — it must never override an
        // already-resolved name (`or_insert`, not overwrite).
        let raw = "CLK\t100\n\
@PASSWD@\n\
alice:x:1000:1000:Alice:/home/alice:/bin/bash\n\
@PROCS@\n\
S\t42\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
U\t42\t1000\n\
R\t42\t2048\n\
@CMDLINE@\n\
/proc/42/cmdline:/usr/bin/bash -i\n\
@PASSWD2@\n\
someone-else:x:1000:1000:Someone Else:/home/x:/bin/bash\n";

        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.processes[0].user, "alice");
    }

    #[test]
    fn parse_remote_snapshot_reads_the_gpu_section() {
        // The `@GPU@` wire format: an AMD card shipped file-by-file, an NVIDIA card
        // as raw nvidia-smi CSV, and one NVIDIA compute process. A blank AMD value
        // (a file the host didn't expose) must be skipped, not stored.
        let raw = "CLK\t100\n\
@GPU@\n\
NVSMI\tNVIDIA RTX A4000, 2048, 16376, 55, 63, 90.0, 140, 1800, 7000, 44, 550.90.07, 4, 16\n\
NVPROC\t4321, python, 1536\n\
AMD\t1\tdriver\tamdgpu\n\
AMD\t1\tvendor\t0x1002\n\
AMD\t1\tvram_used\t440770560\n\
AMD\t1\tvram_total\t536870912\n\
AMD\t1\tgtt_used\t18052190208\n\
AMD\t1\tgtt_total\t65855619072\n\
AMD\t1\tbusy\t72\n\
AMD\t1\ttemp\t58000\n\
AMD\t1\tsclk\t2: 2900Mhz *\n\
AMD\t1\tlink_speed\t\n\
@PROCS@\n";

        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.gpus.len(), 2, "one AMD card + one NVIDIA card");

        // AMD card comes first (built from the shipped sysfs files).
        let amd = &snap.gpus[0];
        assert_eq!(amd.driver, "amdgpu");
        assert_eq!(amd.vram_total, 536_870_912);
        assert_eq!(amd.shared_total, 65_855_619_072);
        assert_eq!(amd.busy_percent, Some(72.0));
        assert_eq!(amd.temp_c, Some(58.0));
        assert_eq!(amd.sclk_mhz, Some(2900));
        assert_eq!(amd.pcie_gen, None, "a blank link_speed line was skipped");

        // NVIDIA card, parsed by the same CSV reader as the local path.
        let nv = &snap.gpus[1];
        assert_eq!(nv.driver, "nvidia");
        assert_eq!(nv.temp_c, Some(63.0));
        assert_eq!(nv.power_w, Some(90.0));
        assert_eq!(nv.driver_version.as_deref(), Some("550.90.07"));

        assert_eq!(snap.gpu_procs.len(), 1);
        assert_eq!(snap.gpu_procs[0].pid, 4321);
        assert_eq!(snap.gpu_procs[0].mem_bytes, 1536 * 1024 * 1024);
    }
}

#[cfg(test)]
mod thread_count_tests {
    use super::parse_threads;

    #[test]
    fn reads_the_threads_field_of_a_status_body() {
        let status = "Name:\tWebKitWebProces\nVmRSS:\t 8669544 kB\nThreads:\t575\nSigQ:\t0/514585\n";
        assert_eq!(parse_threads(status), Some(575));
    }

    #[test]
    fn absent_or_unparseable_is_none() {
        assert_eq!(parse_threads("Name:\tx\nVmRSS:\t1 kB\n"), None);
        assert_eq!(parse_threads("Threads:\tmany\n"), None);
    }
}

//! Remote-host resource check, run right after a project's pooled SSH
//! connection comes up.
//!
//! `check_usage` runs one constant, non-interactive probe script over the
//! shared ControlMaster (`ssh_exec::run_remote_shell`) and parses `who`,
//! `uptime`, `nproc`, `free -m`, a two-sample `/proc/stat` CPU reading, a
//! top-CPU `ps` snapshot, and (when `nvidia-smi` exists on the host) GPU
//! utilization + memory into a [`RemoteUsageReport`]. [`emit_usage_report`]
//! hands that to the frontend as a `remote-usage-report` event so
//! `remote_connect` (`commands::remote`) can fire it fire-and-forget after
//! every connect — manual or silent auto-connect alike — without delaying
//! activation on a failed probe.
//!
//! **CPU is measured, not estimated from load average.** `/proc/stat` is
//! read twice ~300ms apart (all inside the one remote script, so it costs no
//! extra SSH round trip) and the busy/total tick delta over that window gives
//! an instantaneous percentage — a load average conflates *this instant*
//! with the last 1/5/15 minutes, which is exactly wrong for "is someone using
//! it *right now*". A host without `/proc/stat` (non-Linux) falls back to
//! `load1 / cpu_count`.
//!
//! **GPU is opportunistic, NVIDIA-only.** `nvidia-smi` is the only portable
//! read across vendors/drivers without shelling into sysfs paths that differ
//! per card (see `gpustat.rs`'s doc comment for why the *local* reader needs
//! both DRM sysfs and `nvidia-smi` to cover AMD/Intel/NVIDIA) — replicating
//! that over SSH for an arbitrary unknown host isn't worth it here, so a host
//! with no `nvidia-smi` on `PATH` (or no GPU at all) simply reports an empty
//! GPU list rather than a guess.
//!
//! The report flags `busy` when the host looks like someone (or something)
//! else is already using it: high CPU, high memory, a busy GPU, or any other
//! logged-in session. That last signal is best-effort, not exact — a Tabtivity
//! terminal tab connected to the same host allocates a remote PTY (`ssh -tt`)
//! and shows up in `who` exactly like a human login, so a project with its
//! own open terminal to that host will also read as "in use". There's no
//! reliable way to tell the two apart from `who`'s output alone, so this is
//! accepted rather than chased.
//!
//! **Careful mode (HPC hosts).** When the host reports SLURM on its `PATH` the
//! probe collects only this account's own sessions and processes — a cluster's
//! usage rules do not permit gathering other users' names or commands
//! (`docs/context/hpc_careful_mode.md`) — and the verdict is remembered in
//! [`crate::services::hpc_mode`] so `remote_connect` stops firing this probe
//! automatically at that host from the next connect on. The aggregate figures
//! (CPU, memory, GPU) are unchanged, which is what the `busy` gate actually
//! reads; only the personal detail is dropped.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::schema::project::RemoteSpec;
use crate::services::ssh_exec::run_remote_shell;

/// A single line of `who` output.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    pub user: String,
    pub tty: String,
    /// Everything after the tty column, verbatim (login time, `(from-host)`).
    pub detail: String,
}

/// A single row of the top-CPU `ps` snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub user: String,
    pub pid: String,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub command: String,
}

/// One NVIDIA GPU's utilization + memory, from `nvidia-smi`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuUsage {
    pub name: String,
    pub util_pct: f64,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
}

/// A CPU / memory / GPU / login-session snapshot of a remote host, plus a
/// `busy` verdict a frontend warning dialog can gate on.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUsageReport {
    pub users: Vec<UserSession>,
    /// Instantaneous CPU usage (0-100), from a two-sample `/proc/stat` delta;
    /// falls back to a load-average estimate when `/proc/stat` is unreadable.
    pub cpu_pct: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cpu_count: u32,
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    /// NVIDIA GPUs only (see module doc) — empty on a GPU-less host, an
    /// AMD/Intel-only host, or one with no `nvidia-smi` on `PATH`.
    pub gpus: Vec<GpuUsage>,
    pub top_procs: Vec<ProcInfo>,
    /// Whether the host looks already in use — see the module doc for the
    /// heuristic and its one known false-positive.
    pub busy: bool,
    /// Human-readable reasons `busy` was set, for the warning dialog to list.
    pub reasons: Vec<String>,
    /// Whether the host reported itself an **HPC host** (SLURM on `PATH`), in
    /// which case this report was taken in careful mode: `users` holds only the
    /// connecting account's own sessions and `top_procs` only its own processes,
    /// because a cluster's usage rules don't allow collecting other people's
    /// (`docs/context/hpc_careful_mode.md`). The dialog says so rather than
    /// letting a short list read as a quiet machine.
    #[serde(default)]
    pub careful: bool,
}

/// CPU is "busy" once usage exceeds this percentage.
const CPU_BUSY_PCT: f64 = 80.0;
/// Memory is "busy" once used/total exceeds this percentage.
const MEM_BUSY_PCT: f64 = 85.0;
/// A GPU is "busy" once its utilization exceeds this percentage.
const GPU_BUSY_PCT: f64 = 50.0;
/// Gap between the two `/proc/stat` samples the CPU-percentage reading is
/// computed from. Long enough that tick-counter rounding doesn't dominate the
/// delta, short enough that one extra SSH round trip's latency budget covers
/// it comfortably.
const CPU_SAMPLE_GAP: &str = "0.3";

const MARK_CAREFUL: &str = "CAREFUL";
const MARK_WHO: &str = "WHO";
const MARK_UPTIME: &str = "UPTIME";
const MARK_NPROC: &str = "NPROC";
const MARK_FREE: &str = "FREE";
const MARK_CPU1: &str = "CPU1";
const MARK_CPU2: &str = "CPU2";
const MARK_PROCS: &str = "PROCS";
const MARK_GPU: &str = "GPU";

/// Constant probe script — no interpolation, so it needs no quoting (see
/// `ssh_exec::run_remote_shell`'s contract). Each section is bounded by a
/// `##NAME##` marker line so the output can be split back apart without
/// depending on any tool's exact formatting beyond what's parsed below.
///
/// `pub(crate)`: also used by `services::remote_usage::check_usage` for a
/// project's connect-time usage warning, the only other caller of
/// [`parse_report`] below.
pub(crate) fn probe_script() -> String {
    format!(
        "_careful=0\n\
         if command -v sbatch >/dev/null 2>&1 || command -v sinfo >/dev/null 2>&1 \
         || command -v squeue >/dev/null 2>&1; then _careful=1; fi\n\
         _myname=$(id -un 2>/dev/null || echo '')\n\
         echo '##{MARK_CAREFUL}##'\n\
         echo \"$_careful\"\n\
         echo '##{MARK_WHO}##'\n\
         if [ \"$_careful\" = 1 ]; then \
         who 2>/dev/null | awk -v me=\"$_myname\" '$1 == me'; \
         else who 2>/dev/null; fi\n\
         echo '##{MARK_UPTIME}##'\n\
         uptime 2>/dev/null\n\
         echo '##{MARK_NPROC}##'\n\
         nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1\n\
         echo '##{MARK_FREE}##'\n\
         free -m 2>/dev/null\n\
         echo '##{MARK_CPU1}##'\n\
         head -n1 /proc/stat 2>/dev/null\n\
         sleep {CPU_SAMPLE_GAP} 2>/dev/null\n\
         echo '##{MARK_CPU2}##'\n\
         head -n1 /proc/stat 2>/dev/null\n\
         echo '##{MARK_PROCS}##'\n\
         if [ \"$_careful\" = 1 ]; then \
         ps -u \"$_myname\" -o user,pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 9; \
         else ps -eo user,pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 9; fi\n\
         echo '##{MARK_GPU}##'\n\
         command -v nvidia-smi >/dev/null 2>&1 && \
         nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total \
         --format=csv,noheader,nounits 2>/dev/null\n"
    )
}

/// Run the probe script on `spec`'s host (riding the shared ControlMaster)
/// and parse it into a [`RemoteUsageReport`]. Synchronous (shells out via
/// `std::process`), so callers on an async runtime should run it inside
/// `spawn_blocking`.
pub fn check_usage(spec: &RemoteSpec) -> Result<RemoteUsageReport, String> {
    let out = run_remote_shell(spec, &probe_script())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        return Err(format!(
            "remote usage probe returned no output: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let report = parse_report(&stdout);
    // Remember an HPC verdict so the *automatic* connect-time probe can stop
    // firing at this host altogether (`commands::remote::remote_connect`) — the
    // probe is cheap, but on a cluster it is also unasked-for, and once we know
    // what the host is there is no reason to keep asking it who is logged in.
    crate::services::hpc_mode::remember(&crate::services::hpc_mode::key_for(spec), report.careful);
    Ok(report)
}

/// Emit `report` as a `remote-usage-report` event (`{ projectId, hostId, report }`,
/// camelCase) for the frontend's warning dialog. `host_id` names which of the
/// project's hosts (primary or a `compute_hosts` worker) this report is for, so
/// the dialog can show a section per connected host rather than only the
/// primary's. Best-effort — a closed window / no listener is not an error.
pub fn emit_usage_report(
    app: &AppHandle,
    project_id: &str,
    host_id: &str,
    report: &RemoteUsageReport,
) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Event<'a> {
        project_id: &'a str,
        host_id: &'a str,
        report: &'a RemoteUsageReport,
    }
    let _ = app.emit(
        "remote-usage-report",
        Event {
            project_id,
            host_id,
            report,
        },
    );
}

/// Split `output` into its `##MARK##`-delimited sections, keyed by marker
/// name with the `##` stripped. Lines before the first marker are dropped.
fn split_sections(output: &str) -> HashMap<&str, Vec<&str>> {
    let mut sections: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current: Option<&str> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed
            .strip_prefix("##")
            .and_then(|s| s.strip_suffix("##"))
            .filter(|s| !s.is_empty())
        {
            current = Some(name);
            sections.entry(name).or_default();
            continue;
        }
        if let Some(name) = current {
            sections.get_mut(name).unwrap().push(line);
        }
    }
    sections
}

fn parse_who(lines: &[&str]) -> Vec<UserSession> {
    lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let user = parts.next()?.to_string();
            let tty = parts.next().unwrap_or("").to_string();
            let detail = parts.collect::<Vec<_>>().join(" ");
            Some(UserSession { user, tty, detail })
        })
        .collect()
}

/// Parses the three comma-separated floats after `load average:` in
/// `uptime`'s output. `(0.0, 0.0, 0.0)` if the line is missing or malformed
/// (a host whose `uptime` doesn't support `-p`-less BSD-style output, say) —
/// the caller can't distinguish "idle" from "unreadable" here, and idle is
/// the safe default for a warning gate.
fn parse_load_average(lines: &[&str]) -> (f64, f64, f64) {
    let line = lines.iter().find(|l| l.contains("load average"));
    let Some(line) = line else {
        return (0.0, 0.0, 0.0);
    };
    let Some(tail) = line.split("load average").nth(1) else {
        return (0.0, 0.0, 0.0);
    };
    let tail = tail.trim_start_matches(':').trim_start_matches(',');
    let nums: Vec<f64> = tail
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();
    (
        nums.first().copied().unwrap_or(0.0),
        nums.get(1).copied().unwrap_or(0.0),
        nums.get(2).copied().unwrap_or(0.0),
    )
}

fn parse_cpu_count(lines: &[&str]) -> u32 {
    lines
        .iter()
        .find_map(|l| l.trim().parse::<u32>().ok())
        .unwrap_or(1)
        .max(1)
}

/// Reads the `Mem:` row of `free -m` (`total`, `used` are its 2nd/3rd
/// whitespace-separated fields). `(0, 0)` if the row is missing.
fn parse_mem(lines: &[&str]) -> (u64, u64) {
    let Some(line) = lines.iter().find(|l| l.trim_start().starts_with("Mem:")) else {
        return (0, 0);
    };
    let fields: Vec<&str> = line.split_whitespace().collect();
    let total = fields
        .get(1)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let used = fields
        .get(2)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    (total, used)
}

/// Reads `/proc/stat`'s `cpu ` summary line (the aggregate over all cores,
/// distinct from the per-core `cpu0`/`cpu1`/... lines) into `(idle, total)`
/// tick counts — `idle` = idle + iowait, `total` = the sum of every field.
/// `None` if the line is missing (a non-Linux host) or too short to trust.
fn parse_proc_stat(lines: &[&str]) -> Option<(u64, u64)> {
    let line = lines
        .iter()
        .find(|l| l.split_whitespace().next() == Some("cpu"))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    let total = nums.iter().sum();
    Some((idle, total))
}

/// Instantaneous CPU usage (0-100) from two `/proc/stat` samples taken
/// `CPU_SAMPLE_GAP` seconds apart. Falls back to `load1 / cpu_count` (still
/// clamped to 0-100) when either sample is missing, e.g. a non-Linux host.
fn compute_cpu_pct(
    sample1: Option<(u64, u64)>,
    sample2: Option<(u64, u64)>,
    load1: f64,
    cpu_count: u32,
) -> f64 {
    if let (Some((idle1, total1)), Some((idle2, total2))) = (sample1, sample2) {
        let dt = total2.saturating_sub(total1);
        if dt > 0 {
            let d_idle = idle2.saturating_sub(idle1);
            return ((1.0 - d_idle as f64 / dt as f64) * 100.0).clamp(0.0, 100.0);
        }
    }
    (load1 / cpu_count.max(1) as f64 * 100.0).clamp(0.0, 100.0)
}

/// Parses `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
/// --format=csv,noheader,nounits` rows (plain CSV, no header since
/// `noheader`). Empty when `nvidia-smi` isn't on the host's `PATH` at all —
/// the probe script's `command -v` guard then produces no output here rather
/// than an error.
fn parse_gpus(lines: &[&str]) -> Vec<GpuUsage> {
    lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let fields: Vec<&str> = l.split(',').map(str::trim).collect();
            if fields.len() < 4 {
                return None;
            }
            Some(GpuUsage {
                name: fields[0].to_string(),
                util_pct: fields[1].parse().unwrap_or(0.0),
                mem_used_mb: fields[2].parse().unwrap_or(0),
                mem_total_mb: fields[3].parse().unwrap_or(0),
            })
        })
        .collect()
}

/// Parses `ps -eo user,pid,pcpu,pmem,comm` rows, skipping the header line.
/// `comm` is a single token (unlike `args`), so five whitespace fields is
/// always right even for a command containing spaces in its full path.
fn parse_procs(lines: &[&str]) -> Vec<ProcInfo> {
    lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .skip(1) // header: "USER PID %CPU %MEM COMMAND"
        .filter_map(|l| {
            let fields: Vec<&str> = l.split_whitespace().collect();
            if fields.len() < 5 {
                return None;
            }
            Some(ProcInfo {
                user: fields[0].to_string(),
                pid: fields[1].to_string(),
                cpu_pct: fields[2].parse().unwrap_or(0.0),
                mem_pct: fields[3].parse().unwrap_or(0.0),
                command: fields[4..].join(" "),
            })
        })
        .collect()
}

pub(crate) fn parse_report(output: &str) -> RemoteUsageReport {
    let sections = split_sections(output);
    let empty: Vec<&str> = Vec::new();
    let careful = sections
        .get(MARK_CAREFUL)
        .and_then(|lines| lines.iter().find(|l| !l.trim().is_empty()))
        .is_some_and(|l| l.trim() == "1");
    let users = parse_who(sections.get(MARK_WHO).unwrap_or(&empty));
    let (load1, load5, load15) = parse_load_average(sections.get(MARK_UPTIME).unwrap_or(&empty));
    let cpu_count = parse_cpu_count(sections.get(MARK_NPROC).unwrap_or(&empty));
    let (mem_total_mb, mem_used_mb) = parse_mem(sections.get(MARK_FREE).unwrap_or(&empty));
    let cpu1 = parse_proc_stat(sections.get(MARK_CPU1).unwrap_or(&empty));
    let cpu2 = parse_proc_stat(sections.get(MARK_CPU2).unwrap_or(&empty));
    let cpu_pct = compute_cpu_pct(cpu1, cpu2, load1, cpu_count);
    let top_procs = parse_procs(sections.get(MARK_PROCS).unwrap_or(&empty));
    let gpus = parse_gpus(sections.get(MARK_GPU).unwrap_or(&empty));

    let mut reasons = Vec::new();
    if cpu_pct > CPU_BUSY_PCT {
        reasons.push(format!(
            "CPU usage is high ({cpu_pct:.0}% across {cpu_count} core(s))"
        ));
    }
    let mem_pct = if mem_total_mb > 0 {
        mem_used_mb as f64 / mem_total_mb as f64 * 100.0
    } else {
        0.0
    };
    if mem_pct > MEM_BUSY_PCT {
        reasons.push(format!(
            "Memory usage is high ({mem_pct:.0}% of {mem_total_mb} MB used)"
        ));
    }
    for gpu in &gpus {
        if gpu.util_pct > GPU_BUSY_PCT {
            reasons.push(format!(
                "GPU \"{}\" is busy ({:.0}%)",
                gpu.name, gpu.util_pct
            ));
        }
    }
    if !users.is_empty() {
        // On a careful (HPC) host the session list is only ever this account's
        // own, so the old wording would claim something the probe cannot see. A
        // login node always has other people on it; that is not the warning.
        reasons.push(if careful {
            format!(
                "{} session{} of your own already logged in",
                users.len(),
                if users.len() == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "{} other session{} logged in",
                users.len(),
                if users.len() == 1 { "" } else { "s" }
            )
        });
    }
    let busy = !reasons.is_empty();

    RemoteUsageReport {
        users,
        cpu_pct,
        load1,
        load5,
        load15,
        cpu_count,
        mem_total_mb,
        mem_used_mb,
        gpus,
        top_procs,
        busy,
        reasons,
        careful,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
##WHO##
alice    pts/0        2026-07-18 09:12 (203.0.113.5)
bob      tty1         2026-07-17 22:03
##UPTIME##
 14:32:01 up 10 days,  3:22,  2 users,  load average: 3.21, 2.98, 2.50
##NPROC##
4
##FREE##
              total        used        free      shared  buff/cache   available
Mem:          15974       14200         500         100        1274         900
Swap:          2047           0        2047
##CPU1##
cpu  1000 0 500 8000 0 0 0 0 0 0
##CPU2##
cpu  1085 0 500 8015 0 0 0 0 0 0
##PROCS##
USER       PID  %CPU %MEM COMMAND
bob      12345  88.0 40.1 python3
alice     6789  10.5  2.0 node
##GPU##
NVIDIA GeForce RTX 3090, 92, 20000, 24576
";

    #[test]
    fn parses_who_sessions() {
        let sections = split_sections(SAMPLE);
        let users = parse_who(sections.get(MARK_WHO).unwrap());
        assert_eq!(users.len(), 2);
        assert_eq!(users[0].user, "alice");
        assert_eq!(users[0].tty, "pts/0");
        assert!(users[0].detail.contains("203.0.113.5"));
        assert_eq!(users[1].user, "bob");
        assert_eq!(users[1].tty, "tty1");
    }

    #[test]
    fn parses_load_average() {
        let sections = split_sections(SAMPLE);
        let (l1, l5, l15) = parse_load_average(sections.get(MARK_UPTIME).unwrap());
        assert_eq!(l1, 3.21);
        assert_eq!(l5, 2.98);
        assert_eq!(l15, 2.50);
    }

    #[test]
    fn load_average_missing_defaults_to_zero() {
        let (l1, l5, l15) = parse_load_average(&["no load info here"]);
        assert_eq!((l1, l5, l15), (0.0, 0.0, 0.0));
    }

    #[test]
    fn parses_cpu_count() {
        let sections = split_sections(SAMPLE);
        assert_eq!(parse_cpu_count(sections.get(MARK_NPROC).unwrap()), 4);
    }

    #[test]
    fn parses_mem() {
        let sections = split_sections(SAMPLE);
        let (total, used) = parse_mem(sections.get(MARK_FREE).unwrap());
        assert_eq!(total, 15974);
        assert_eq!(used, 14200);
    }

    #[test]
    fn parses_top_procs_skipping_header() {
        let sections = split_sections(SAMPLE);
        let procs = parse_procs(sections.get(MARK_PROCS).unwrap());
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].user, "bob");
        assert_eq!(procs[0].command, "python3");
        assert_eq!(procs[0].cpu_pct, 88.0);
    }

    #[test]
    fn busy_host_flags_all_reasons() {
        let report = parse_report(SAMPLE);
        assert!(report.busy);
        // (100-15)/100... i.e. 1 - 15/100 = 85% > 80%
        assert_eq!(report.cpu_pct, 85.0);
        assert!(report.reasons.iter().any(|r| r.contains("CPU usage")));
        // 14200/15974 = 88.9% > 85%
        assert!(report.reasons.iter().any(|r| r.contains("Memory usage")));
        assert!(report
            .reasons
            .iter()
            .any(|r| r.contains("GPU") && r.contains("92")));
        assert!(report.reasons.iter().any(|r| r.contains("other session")));
        assert_eq!(report.gpus.len(), 1);
        assert_eq!(report.gpus[0].name, "NVIDIA GeForce RTX 3090");
        assert_eq!(report.gpus[0].mem_used_mb, 20000);
    }

    #[test]
    fn cpu_pct_falls_back_to_load_average_without_proc_stat() {
        // No CPU1/CPU2 sections at all — a non-Linux host.
        let no_proc_stat = "\
##UPTIME##
load average: 4.0, 4.0, 4.0
##NPROC##
8
";
        let report = parse_report(no_proc_stat);
        // 4.0 / 8 * 100 = 50%
        assert_eq!(report.cpu_pct, 50.0);
    }

    #[test]
    fn no_gpu_tool_reports_empty_gpu_list() {
        let no_gpu = "\
##WHO##
##UPTIME##
load average: 0.1, 0.1, 0.1
##NPROC##
4
##FREE##
Mem: 8000 1000 7000
##GPU##
";
        let report = parse_report(no_gpu);
        assert!(report.gpus.is_empty());
        assert!(!report.reasons.iter().any(|r| r.contains("GPU")));
    }

    #[test]
    fn idle_host_is_not_busy() {
        let idle = "\
##WHO##
##UPTIME##
 14:32:01 up 10 days,  3:22,  0 users,  load average: 0.05, 0.10, 0.08
##NPROC##
8
##FREE##
              total        used        free      shared  buff/cache   available
Mem:          32000        2000       28000         100        2000       29000
##PROCS##
USER       PID  %CPU %MEM COMMAND
root         1   0.0  0.1 systemd
";
        let report = parse_report(idle);
        assert!(!report.busy);
        assert!(report.reasons.is_empty());
        assert!(report.users.is_empty());
        // No `##CAREFUL##` section at all is an ordinary host (an older probe
        // script, or a plain dev box): full collection, as before.
        assert!(!report.careful);
    }

    #[test]
    fn a_careful_host_reports_itself_and_rewords_the_session_reason() {
        // On an HPC host the script ships only this account's own sessions and
        // processes, so "N other sessions logged in" would be a claim the probe
        // can no longer make — a login node always has other people on it, and
        // that is not what the warning is for.
        let careful = "\
##CAREFUL##
1
##WHO##
alice    pts/0        2026-07-18 09:12
##UPTIME##
 14:32:01 up 10 days,  3:22,  9 users,  load average: 0.10, 0.10, 0.10
##NPROC##
64
##FREE##
              total        used        free      shared  buff/cache   available
Mem:         256000       20000      200000         100       36000      230000
##PROCS##
USER       PID  %CPU %MEM COMMAND
alice     6789   1.5  0.2 python3
";
        let report = parse_report(careful);
        assert!(report.careful);
        assert_eq!(report.users.len(), 1);
        assert!(report
            .reasons
            .iter()
            .any(|r| r.contains("of your own already logged in")));
        assert!(!report.reasons.iter().any(|r| r.contains("other session")));
        // The aggregate figures — what `busy` actually gates on — are untouched.
        assert_eq!(report.cpu_count, 64);
        assert_eq!(report.mem_total_mb, 256_000);
    }

    #[test]
    fn the_probe_script_detects_and_censors_on_an_hpc_host() {
        let s = probe_script();
        assert!(s.contains("command -v sbatch"));
        assert!(s.contains("##CAREFUL##"));
        // Both branches present: own-sessions/own-processes when careful, the
        // whole-host reads otherwise.
        assert!(s.contains("ps -u \"$_myname\""));
        assert!(s.contains("ps -eo user,pid,pcpu,pmem,comm"));
    }

    #[test]
    fn singular_session_wording() {
        let one_user = "\
##WHO##
alice    pts/0        2026-07-18 09:12
##UPTIME##
load average: 0.1, 0.1, 0.1
##NPROC##
4
##FREE##
Mem: 8000 1000 7000
##PROCS##
USER PID %CPU %MEM COMMAND
";
        let report = parse_report(one_user);
        assert!(report.busy);
        assert!(report
            .reasons
            .iter()
            .any(|r| r == "1 other session logged in"));
    }
}

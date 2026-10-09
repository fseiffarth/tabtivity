//! Whole-system resource snapshot for the htop-like monitor pane.
//!
//! A single read-only command: it returns one cumulative [`SystemSnapshot`]
//! (every process + per-core CPU + memory/swap/load). Live CPU/MEM percentages
//! are derived on the frontend by diffing two successive snapshots, so — unlike
//! the per-project readout in `commands::debug` — there is no in-command sleep or
//! shared sampler state to race between panes. Sampling itself lives in
//! [`crate::sysstat`]; this is just the Tauri surface.

use crate::gpustat::{self, GpuProc, GpuSample};
use crate::sysstat::{self, SystemSnapshot};
use serde::Serialize;

/// One whole-system sample. `supported` is `false` on every non-Linux target
/// (`sysstat::system_snapshot` has no `/proc` to read there), where the pane
/// shows a "not available on this system" placeholder instead of an empty table.
///
/// `project_id` selects the machine, mirroring `disk_usage_scan`: when it names a
/// project with a `remote` spec, the sample is taken on the **host** — its `/proc`
/// read over the shared ControlMaster (`REMOTE_SNAPSHOT_SCRIPT`) and assembled by
/// the same pure parsers — inside `spawn_blocking` so the SSH round-trip never
/// runs on the UI thread. Any other value (a local project, `None`, or a project
/// with no remote) samples this machine. `host_id` picks which of the project's
/// hosts to sample (primary or a `compute_hosts` worker); defaults to the primary
/// (`remote::PRIMARY_HOST`), mirroring every other multi-host command. The pane
/// passes `project_id` only while its source toggle points at a host; a
/// disconnected host is gated out on the frontend, so a dead pool is never dialed
/// here.
///
/// `careful` selects the collection mode, and is authoritative in **both**
/// directions: `true` = the reduced careful collection (no foreign account
/// names, argv, GPU processes or sessions leave the host), `false` = the full
/// reading a local sample gets. It is the machine's stored mode — careful for
/// every remote machine until the user says that one is theirs, keyed by SSH
/// target in `settings.careful_hosts` (`src/lib/remote/carefulHost.ts`) — so the pane
/// passes it on every poll and the answer holds from the first sample.
///
/// `None` means the caller has no answer to pass, and only then does anything
/// guess: the host's own SLURM probe, plus this process's memory of what earlier
/// probes of the same target found ([`crate::services::hpc_mode`]). That memory
/// deliberately does **not** override an explicit `false` — it exists to stop a
/// flaky *probe* from talking a cluster down, not to overrule the user.
#[tauri::command]
pub async fn system_monitor_snapshot(
    project_id: Option<String>,
    host_id: Option<String>,
    careful: Option<bool>,
) -> Result<SystemSnapshot, String> {
    let host_id = host_id.unwrap_or_else(|| crate::services::remote::PRIMARY_HOST.to_string());
    if let Some(target) = project_id
        .as_deref()
        .and_then(|pid| crate::services::remote::remote_target_for_host(pid, &host_id))
    {
        let spec = target.spec.clone();
        let key = crate::services::hpc_mode::key_for(&spec);
        let mode =
            careful.or_else(|| crate::services::hpc_mode::is_known_careful(&key).then_some(true));
        return tokio::task::spawn_blocking(move || {
            let out = crate::services::ssh_exec::run_remote_script(
                &spec,
                &sysstat::remote_snapshot_script(mode),
            )?;
            let snap = sysstat::parse_remote_snapshot(&String::from_utf8_lossy(&out.stdout));
            crate::services::hpc_mode::remember(&key, snap.careful);
            Ok::<_, String>(snap)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(sysstat::system_snapshot())
}

/// The machine's CPU and memory load, ready to print. The counterpart of
/// [`gpu_memory_snapshot`] for the other two halves of the same question the
/// local-model menu asks — "what is this machine doing, and what is left for the
/// model I am about to load".
///
/// Unlike [`system_monitor_snapshot`] this carries **no process table**: the
/// caller is a hover menu polling every couple of seconds, and the whole table
/// (a `/proc` read per process, then the JSON for all of it) is a price only the
/// monitor pane's own view justifies.
///
/// It also resolves the CPU percentage **here**, which the pane deliberately does
/// not. The pane is long-lived, so diffing successive samples on the frontend is
/// free and keeps the command sleep-less; a menu is often closed again before a
/// second poll lands, so a diffing caller would show nothing at all for the usual
/// visit. The two samples are 300 ms apart around an `await` (never a blocking
/// sleep — the same shape as `debug_app_resource_usage`), and the reads between
/// them are three small files, so the sampler cannot race any other caller: it
/// holds no shared state.
#[derive(Serialize, Clone, Copy)]
pub struct MachineLoadSample {
    /// `false` where the platform has no aggregate backend — the UI hides the
    /// block rather than showing zeros.
    pub supported: bool,
    /// 0–100 across the whole machine (not per core), over the sample window.
    pub cpu_percent: f64,
    pub num_cores: u32,
    /// 1/5/15-minute load average; all zero on Windows, which has none.
    pub load_avg: [f64; 3],
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    /// Whole-package CPU temperature, or `None` where no sensor is readable.
    pub cpu_temp_c: Option<f64>,
    /// Hottest DIMM temperature, or `None` — which is the *usual* answer: an
    /// on-module sensor (`jc42`/`spd5118`) is only wired on some boards, so its
    /// absence is a fact about the hardware, not a failed read.
    pub mem_temp_c: Option<f64>,
}

#[tauri::command]
pub async fn machine_load_snapshot() -> Result<MachineLoadSample, String> {
    let first = sysstat::machine_load();
    if !first.supported {
        return Ok(MachineLoadSample {
            supported: false,
            cpu_percent: 0.0,
            num_cores: 0,
            load_avg: [0.0; 3],
            mem_total_bytes: 0,
            mem_used_bytes: 0,
            swap_total_bytes: 0,
            swap_used_bytes: 0,
            cpu_temp_c: None,
            mem_temp_c: None,
        });
    }

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let now = sysstat::machine_load();

    // Cumulative counters, so the percentage is the ratio of the two deltas —
    // wall-clock-independent, which is why the window length never enters it. A
    // zero (or backwards) total delta means the counters didn't move: report 0
    // rather than dividing by it.
    let busy = now.cpu.busy.saturating_sub(first.cpu.busy) as f64;
    let total = now.cpu.total.saturating_sub(first.cpu.total) as f64;
    let cpu_percent = if total > 0.0 {
        (busy / total * 1000.0).round() / 10.0
    } else {
        0.0
    };

    Ok(MachineLoadSample {
        supported: true,
        cpu_percent: cpu_percent.clamp(0.0, 100.0),
        num_cores: now.num_cores,
        load_avg: now.load_avg,
        mem_total_bytes: now.mem_total_kib * 1024,
        mem_used_bytes: now.mem_total_kib.saturating_sub(now.mem_available_kib) * 1024,
        swap_total_bytes: now.swap_total_kib * 1024,
        swap_used_bytes: now.swap_total_kib.saturating_sub(now.swap_free_kib) * 1024,
        cpu_temp_c: now.cpu_temp_c,
        mem_temp_c: now.mem_temp_c,
    })
}

/// GPU memory alone, for callers that want the device's memory without paying
/// for a whole process table (the local-model menu, which asks "what headroom is
/// left before I load this?"). Reads the same [`gpustat`] cache the snapshot
/// does. An empty list means no GPU could be read, not that there is no GPU.
#[tauri::command]
pub async fn gpu_memory_snapshot() -> Result<Vec<GpuSample>, String> {
    Ok(gpustat::snapshot())
}

/// Per-process GPU memory for the monitor pane's process breakdown. A separate,
/// heavier read (a `/proc` `fdinfo` walk for amdgpu, a `nvidia-smi` spawn for
/// compute clients) than the whole-device snapshot, so only the pane calls it —
/// the always-visible header readout never pays for it. Local-only and best-effort:
/// an empty list means "no per-process data available", not "no GPU processes".
#[tauri::command]
pub async fn gpu_process_snapshot() -> Result<Vec<GpuProc>, String> {
    Ok(gpustat::process_snapshot())
}

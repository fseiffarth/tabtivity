//! Where whisper runs (docs/voice_gpu_plan.md): the device a load really got,
//! which whisper only tells its log, and the guard that keeps a GPU that took
//! the app down from doing it twice.
//!
//! `voice-vulkan` / `voice-metal` build a GPU backend in; plain `voice` stays
//! on the CPU. Whisper runs inside the app, so a driver crash or a C++
//! exception out of the backend ends the process and nothing here can catch
//! it. What can be done is noticing afterwards: a marker written before the
//! risky steps and removed after them is only still there if they never came
//! back. The first crash still happens; the guard stops the second.
//!
//! The off switch and the guard stop whisper from using a device. They do not
//! stop ggml, which creates its Vulkan instance on any use of whisper, even a
//! CPU load, the voice detector's included.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use app_core::sync::LockExt;
use serde::Serialize;

/// Whether this build has a GPU backend at all.
pub const BUILT: bool = cfg!(any(feature = "voice-vulkan", feature = "voice-metal"));

/// The start of the one log line [`backend_from_log`] reads; the load log
/// keeps nothing else.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub const LOG_PREFIX: &str = "whisper_backend_init_gpu:";

/// Why whisper runs on the CPU. The renderer maps each to its own text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CpuReason {
    /// A build without a GPU backend.
    NotBuilt,
    /// No usable GPU, or it would not take the model.
    NoGpu,
    /// Settings → Voice turned the GPU off.
    Off,
    /// The last GPU attempt never came back ([`crashed`]).
    Crashed,
}

/// The device a load really got.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceDevice {
    Gpu { name: Option<String> },
    Cpu { reason: CpuReason },
}

/// What a load may try, in the order the reasons outrank each other.
fn choose(built: bool, wanted: bool, crashed: bool) -> Result<(), CpuReason> {
    if !built {
        Err(CpuReason::NotBuilt)
    } else if !wanted {
        Err(CpuReason::Off)
    } else if crashed {
        Err(CpuReason::Crashed)
    } else {
        Ok(())
    }
}

/// `Ok` when a load may try the GPU, or why it stays on the CPU.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn plan(wanted: bool) -> Result<(), CpuReason> {
    choose(BUILT, wanted, crashed())
}

/// The GPU backend whisper's load log says it took, `None` when it stayed on
/// the CPU. Whisper carries on without a word to its caller either way:
/// `no GPU found`, or `using X backend` followed by `failed to initialize X
/// backend`. The wording is pinned with the crate (`=0.16.0`); the tests hold
/// real lines.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn backend_from_log(lines: &[String]) -> Option<String> {
    let said = |line: &str| line.split_once(LOG_PREFIX).map(|(_, rest)| rest.trim().to_string());
    let lines: Vec<String> = lines.iter().filter_map(|l| said(l)).collect();
    if lines.iter().any(|l| l.starts_with("failed to initialize")) {
        return None;
    }
    lines.iter().find_map(|l| l.strip_prefix("using ")?.strip_suffix(" backend").map(str::to_string))
}

/// The marker, and whether this process wrote it: one found unarmed is from a
/// run that never came back.
struct Guard {
    marker: PathBuf,
    armed: AtomicBool,
}

impl Guard {
    fn new(marker: PathBuf) -> Self {
        Self { marker, armed: AtomicBool::new(false) }
    }

    fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
        if let Some(dir) = self.marker.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.marker, b"");
    }

    fn disarm(&self) {
        let _ = std::fs::remove_file(&self.marker);
        self.armed.store(false, Ordering::SeqCst);
    }

    /// Only this run's own step: an earlier run's crash outlives a clean quit.
    fn abandon(&self) {
        if self.armed.load(Ordering::SeqCst) {
            self.disarm();
        }
    }

    fn crashed(&self) -> bool {
        !self.armed.load(Ordering::SeqCst) && self.marker.exists()
    }
}

fn guard() -> &'static Guard {
    static GUARD: OnceLock<Guard> = OnceLock::new();
    GUARD.get_or_init(|| Guard::new(crate::storage::state_dir().join("voice").join("gpu-attempt")))
}

/// Before a step on the GPU that may not come back.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn arm() {
    guard().arm();
}

/// The step came back. Also "try the GPU again" after a crash.
pub fn disarm() {
    guard().disarm();
}

/// The exit teardown: quitting mid-step is not a crash.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn abandon() {
    guard().abandon();
}

/// A GPU step of an earlier run never came back.
pub fn crashed() -> bool {
    guard().crashed()
}

static LAST: Mutex<Option<VoiceDevice>> = Mutex::new(None);

#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn record(device: VoiceDevice) {
    *LAST.lock_ok() = Some(device);
}

/// The device of this run's last load, `None` before the first.
pub fn last() -> Option<VoiceDevice> {
    LAST.lock_ok().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|l| format!("{l}\n")).collect()
    }

    #[test]
    fn the_reasons_outrank_each_other() {
        assert_eq!(choose(true, true, false), Ok(()));
        assert_eq!(choose(false, true, true), Err(CpuReason::NotBuilt));
        assert_eq!(choose(true, false, true), Err(CpuReason::Off));
        assert_eq!(choose(true, true, true), Err(CpuReason::Crashed));
    }

    #[test]
    fn the_log_names_the_backend_taken() {
        let log = lines(&[
            "whisper_backend_init_gpu: device 0: Vulkan0 (type: 2)",
            "whisper_backend_init_gpu: found GPU device 0: Vulkan0 (type: 2, cnt: 0)",
            "whisper_backend_init_gpu: using Vulkan0 backend",
        ]);
        assert_eq!(backend_from_log(&log).as_deref(), Some("Vulkan0"));
    }

    #[test]
    fn a_load_that_stayed_on_the_cpu_names_none() {
        assert_eq!(backend_from_log(&lines(&["whisper_backend_init_gpu: no GPU found"])), None);
        assert_eq!(backend_from_log(&[]), None);
        let failed = lines(&[
            "whisper_backend_init_gpu: using Vulkan0 backend",
            "whisper_backend_init_gpu: failed to initialize Vulkan0 backend",
        ]);
        assert_eq!(backend_from_log(&failed), None);
    }

    #[test]
    fn only_a_marker_left_by_an_earlier_run_is_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("voice").join("gpu-attempt");
        let run = Guard::new(marker.clone());
        assert!(!run.crashed());
        run.arm();
        assert!(!run.crashed(), "a step in flight in this run has not crashed");
        run.disarm();
        assert!(!run.crashed());

        run.arm();
        let next_run = Guard::new(marker);
        assert!(next_run.crashed());
        next_run.disarm();
        assert!(!next_run.crashed());
    }

    #[test]
    fn a_clean_quit_clears_its_own_step_but_never_an_earlier_crash() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("gpu-attempt");
        let quitting = Guard::new(marker.clone());
        quitting.arm();
        quitting.abandon();
        assert!(!Guard::new(marker.clone()).crashed(), "quitting mid-step is not a crash");

        quitting.arm();
        let after_the_crash = Guard::new(marker.clone());
        after_the_crash.abandon();
        assert!(Guard::new(marker).crashed(), "the guard must hold past the next quit");
    }

    #[test]
    fn a_device_says_what_the_renderer_reads() {
        let gpu = VoiceDevice::Gpu { name: Some("Radeon".into()) };
        assert_eq!(serde_json::to_value(gpu).unwrap(), serde_json::json!({ "kind": "gpu", "name": "Radeon" }));
        let cpu = VoiceDevice::Cpu { reason: CpuReason::NoGpu };
        assert_eq!(serde_json::to_value(cpu).unwrap(), serde_json::json!({ "kind": "cpu", "reason": "no-gpu" }));
    }
}

//! Which WebKitGTK paint path the window starts on (`docs/done/gpu_compositing_plan.md`).
//!
//! Tabtivity forces `WEBKIT_DISABLE_DMABUF_RENDERER=1` by default, so pages paint
//! and composite on the CPU. The GPU path was ruled out by its artifacts, and those
//! were traced (2026-10-14, `docs/pdf_gpu_rendering_check_plan.md` Results) to
//! WebKit's GPU-accelerated 2D canvas: with DMA-BUF on it silently drops draw
//! operations (pdf.js text, whole plots), on radeonsi and llvmpipe, 2.52.6 and
//! 2.54.1. The compositor itself rendered correctly once the canvas was not
//! accelerated, at ~60 fps against ~20 fps (2.52) and 8–16 fps (2.54) for the
//! CPU path at near-fullscreen.
//!
//! So the experimental `gpu_compositing` setting stops forcing the variable, and
//! every webview gets [`CANVAS_ACCEL_PROPERTY`] set to false on Linux, whatever
//! the setting says. With DMA-BUF off that changes nothing measurable (0 px, same
//! speed), and it also covers a user who exports `WEBKIT_DISABLE_DMABUF_RENDERER=0`
//! themselves.
//!
//! The GPU path can still take the renderer down inside the driver: SIGBUS in
//! Mesa's `libgallium` on 2026-06-11 and again on 2026-11-24 (26.0.8), each a
//! window frozen on its last frame while the core was written. So `run()`
//! records the path it started on ([`record_start`]), the crash hook names it in
//! crash.log, and a crash on the path the *setting* chose turns the setting off
//! ([`fall_back_to_cpu_at`]): the next launch paints on the CPU, and the window
//! asks once whether to turn it back on (`gpu_compositing_fallback`). A path an
//! inherited variable chose is the user's and is only logged.

use std::ffi::OsStr;
use std::path::Path;
use std::sync::OnceLock;

use crate::schema::Settings;
use crate::storage;

/// `WebKitSettings:enable-2d-canvas-acceleration` (WebKitGTK ≥ 2.46). Not the
/// `webkit2gtk` crate's `enable_accelerated_2d_canvas`, which is the older,
/// deprecated property. Probed 2026-10-14 on 2.52.6: setting this one to false
/// on a loaded webview also flips the `CanvasUsesAcceleratedDrawing` feature,
/// and canvases created afterwards render pixel-identical to the CPU path.
pub const CANVAS_ACCEL_PROPERTY: &str = "enable-2d-canvas-acceleration";

/// Whether `run()` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`. The environment
/// wins: an inherited value, whatever it is, is someone's explicit choice and is
/// never touched. Otherwise the renderer stays off unless the user opted into
/// GPU compositing.
pub fn should_disable_dmabuf(inherited: Option<&OsStr>, gpu_compositing: bool) -> bool {
    inherited.is_none() && !gpu_compositing
}

/// The paint path this process started on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaintPath {
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` set (by `run()` or inherited): CPU.
    Cpu,
    /// The GPU path, because the `gpu_compositing` setting is on.
    GpuSetting,
    /// The GPU path, because the environment said `0`.
    GpuInherited,
}

impl PaintPath {
    /// How crash.log names it.
    pub fn label(self) -> &'static str {
        match self {
            PaintPath::Cpu => "cpu",
            PaintPath::GpuSetting => "gpu (gpu_compositing setting)",
            PaintPath::GpuInherited => "gpu (inherited WEBKIT_DISABLE_DMABUF_RENDERER=0)",
        }
    }
}

/// The path `run()` leaves the process on, from the same inputs as
/// [`should_disable_dmabuf`]. WebKit reads the variable as "renderer off unless
/// unset or `0`".
pub fn paint_path(inherited: Option<&OsStr>, gpu_compositing: bool) -> PaintPath {
    match inherited {
        Some(v) if v == "0" => PaintPath::GpuInherited,
        Some(_) => PaintPath::Cpu,
        None if gpu_compositing => PaintPath::GpuSetting,
        None => PaintPath::Cpu,
    }
}

static STARTED_ON: OnceLock<PaintPath> = OnceLock::new();

/// Called once by `run()`, before WebKit starts.
pub fn record_start(path: PaintPath) {
    let _ = STARTED_ON.set(path);
}

/// The path recorded at launch; `None` before `run()` recorded one.
pub fn started_on() -> Option<PaintPath> {
    STARTED_ON.get().copied()
}

/// Whether a renderer death turns GPU compositing off: a crash (not an
/// intentional restart, not the memory limit) on the path the setting chose.
pub fn crash_falls_back(started: Option<PaintPath>, crashed: bool) -> bool {
    crashed && started == Some(PaintPath::GpuSetting)
}

/// Turn `gpu_compositing` off in the settings file at `path` and note when
/// (`gpu_compositing_fallback`, the window's ask). True when it switched;
/// false when the setting was already off (a second crash, or the user turned
/// it off meanwhile), which leaves the file as it was.
pub fn fall_back_to_cpu_at(path: &Path, at: &str) -> Result<bool, String> {
    storage::patch_json(path, Settings::default(), |settings| {
        if !settings.gpu_compositing() {
            return Ok(false);
        }
        settings.gpu_compositing = Some(false);
        settings.gpu_compositing_fallback = Some(at.to_string());
        settings.rev += 1;
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paint_path_matches_what_webkit_reads() {
        assert_eq!(paint_path(None, false), PaintPath::Cpu);
        assert_eq!(paint_path(None, true), PaintPath::GpuSetting);
        assert_eq!(paint_path(Some(OsStr::new("0")), false), PaintPath::GpuInherited);
        for v in ["1", ""] {
            assert_eq!(paint_path(Some(OsStr::new(v)), true), PaintPath::Cpu, "inherited {v:?}");
        }
        // With nothing inherited, CPU exactly when `run()` sets the variable.
        for gpu in [false, true] {
            assert_eq!(paint_path(None, gpu) == PaintPath::Cpu, should_disable_dmabuf(None, gpu));
        }
    }

    #[test]
    fn only_a_crash_on_the_gpu_path_the_setting_chose_falls_back() {
        assert!(crash_falls_back(Some(PaintPath::GpuSetting), true));
        assert!(!crash_falls_back(Some(PaintPath::GpuSetting), false));
        assert!(!crash_falls_back(Some(PaintPath::GpuInherited), true));
        assert!(!crash_falls_back(Some(PaintPath::Cpu), true));
        assert!(!crash_falls_back(None, true));
    }

    #[test]
    fn falling_back_turns_the_setting_off_once_and_keeps_the_rest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"gpu_compositing":true,"terminal_webgl":true,"rev":4}"#).expect("write");
        assert!(fall_back_to_cpu_at(&path, "2026-11-24T09:00:38Z").expect("first"));
        let s: Settings = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parse");
        assert!(!s.gpu_compositing());
        assert_eq!(s.gpu_compositing_fallback.as_deref(), Some("2026-11-24T09:00:38Z"));
        assert_eq!(s.terminal_webgl, Some(true));
        assert_eq!(s.rev, 5);
        // A second crash in the same session changes nothing.
        assert!(!fall_back_to_cpu_at(&path, "2026-11-24T09:05:00Z").expect("second"));
        let again: Settings = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parse");
        assert_eq!(again.gpu_compositing_fallback.as_deref(), Some("2026-11-24T09:00:38Z"));
        assert_eq!(again.rev, 5);
    }

    #[test]
    fn unset_env_follows_the_setting() {
        assert!(should_disable_dmabuf(None, false));
        assert!(!should_disable_dmabuf(None, true));
    }

    #[test]
    fn an_inherited_value_is_never_touched() {
        for v in ["1", "0", ""] {
            for gpu in [false, true] {
                assert!(
                    !should_disable_dmabuf(Some(OsStr::new(v)), gpu),
                    "inherited {v:?}, gpu_compositing={gpu}"
                );
            }
        }
    }

    /// The name the 2026-10-14 probe verified. The deprecated property has a
    /// different spelling; a typo here would make `find_property` miss silently.
    #[test]
    fn the_canvas_property_is_the_current_one() {
        assert_eq!(CANVAS_ACCEL_PROPERTY, "enable-2d-canvas-acceleration");
        assert_ne!(CANVAS_ACCEL_PROPERTY, "enable-accelerated-2d-canvas");
    }
}

//! Decode the webview's video in software while the page paints in software.
//!
//! Tabtivity sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` (see `lib.rs::run`). With
//! that renderer off WebKitGTK reports no hardware acceleration, so the page is
//! painted on the CPU and the media player uses its fallback sink, which takes
//! plain system-memory frames and is drawn in the page's software paint.
//! GStreamer's autoplugging does not know that: on a host with a GPU video
//! decoder (the VA plugin, `libgstva.so` from `gstreamer1.0-plugins-extra`,
//! registers `vah264dec` one rank above `avdec_h264`) an `.mp4` still decodes
//! on the GPU, and every frame then has to come back to system memory to be
//! painted. That is the one difference found between the window and a probe
//! that played correctly, when the media viewer failed on a Radeon 890M host
//! (2026-10-08): the `<video>` loads, Play is accepted, and no picture appears.
//!
//! Measured the same day, WebKitGTK 2.52.6 / GStreamer 1.28.2, in an offscreen
//! WebView with no GPU device: the same blob-URL H.264 clip from a `tauri://`
//! page decodes on `avdec_h264`, plays, and reads back the right color bars
//! through `drawImage`. The viewer and the software path are fine. The GPU
//! path needs `/dev/dri`, so it could not be reproduced there; this module
//! moves the window onto the path that was measured to work.
//!
//! The switch is GStreamer's own `GST_PLUGIN_FEATURE_RANK`, inherited by
//! WebKit's web process: the GPU decoders below get rank `NONE`, so autoplugging
//! picks the software decoder for the same format. With the page painted on the
//! CPU the GPU decode bought nothing but a per-frame download. It is set only
//! while the DMA-BUF renderer is off, and never over a value the environment
//! already carries, since that is someone's explicit choice.
//!
//! Like `services::webkit_a11y`, the variable is process-wide. [`installed`]
//! says whether Tabtivity set it, so spawn sites drop it instead of taking GPU
//! decoding away from players launched from a tab.

use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, Ordering};

/// WebKitGTK's switch for the DMA-BUF renderer (read by WebKit, set by `run`).
pub const DMABUF_RENDERER_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// GStreamer's per-element rank override, read once at `gst_init`.
pub const RANK_VAR: &str = "GST_PLUGIN_FEATURE_RANK";

/// GPU video decoders that outrank their software counterparts. Names a host
/// does not have are skipped by GStreamer without a warning.
const GPU_DECODERS: &[&str] = &[
    // VA-API, current plugin (gst-plugins-bad `va`).
    "vah264dec",
    "vah265dec",
    "vah266dec",
    "vavp8dec",
    "vavp9dec",
    "vaav1dec",
    "vampeg2dec",
    // VA-API, the older gstreamer-vaapi plugin.
    "vaapih264dec",
    "vaapih265dec",
    "vaapivp8dec",
    "vaapivp9dec",
    "vaapiav1dec",
    "vaapimpeg2dec",
    "vaapivc1dec",
    "vaapidecodebin",
    // NVIDIA (gst-plugins-bad `nvcodec`).
    "nvh264dec",
    "nvh265dec",
    "nvvp8dec",
    "nvvp9dec",
    "nvav1dec",
    "nvh264sldec",
    "nvh265sldec",
    // V4L2 stateless decoders (ARM boards).
    "v4l2slh264dec",
    "v4l2slh265dec",
    "v4l2slvp8dec",
    "v4l2slvp9dec",
    "v4l2slav1dec",
    "v4l2slmpeg2dec",
];

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Whether WebKit reads this value of [`DMABUF_RENDERER_VAR`] as "renderer
/// off": WebKit's own check is "set, and not exactly `0`".
pub fn dmabuf_renderer_disabled(value: Option<&OsStr>) -> bool {
    value.is_some_and(|v| v != "0")
}

/// The [`RANK_VAR`] value that demotes every GPU decoder.
pub fn rank_override() -> String {
    GPU_DECODERS
        .iter()
        .map(|name| format!("{name}:NONE"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Whether to set [`RANK_VAR`], given the renderer switch and the inherited
/// rank override. Pure, so the precedence is testable without touching the
/// process environment.
pub fn should_install(renderer: Option<&OsStr>, inherited_rank: Option<&OsStr>) -> bool {
    dmabuf_renderer_disabled(renderer) && inherited_rank.is_none()
}

/// Demote the GPU decoders unless the environment already decided. Must run
/// after the DMA-BUF renderer decision and before the first webview is built:
/// the web process initializes GStreamer with the environment it inherits.
pub fn install() {
    let renderer = std::env::var_os(DMABUF_RENDERER_VAR);
    let inherited = std::env::var_os(RANK_VAR);
    if !should_install(renderer.as_deref(), inherited.as_deref()) {
        return;
    }
    std::env::set_var(RANK_VAR, rank_override());
    INSTALLED.store(true, Ordering::Relaxed);
}

/// True when [`install`] set [`RANK_VAR`] itself, i.e. when a child process
/// inheriting it would be inheriting Tabtivity's decision rather than the user's.
pub fn installed() -> bool {
    INSTALLED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn os(v: &str) -> OsString {
        OsString::from(v)
    }

    #[test]
    fn software_paint_demotes_the_gpu_decoders() {
        assert!(should_install(Some(&os("1")), None));
    }

    #[test]
    fn the_gpu_renderer_keeps_gpu_decoding() {
        assert!(!should_install(None, None));
        assert!(!should_install(Some(&os("0")), None));
    }

    #[test]
    fn webkit_reads_any_value_but_zero_as_renderer_off() {
        for value in ["1", "true", "", " 0"] {
            assert!(dmabuf_renderer_disabled(Some(&os(value))), "{value:?}");
        }
        assert!(!dmabuf_renderer_disabled(Some(&os("0"))));
        assert!(!dmabuf_renderer_disabled(None));
    }

    #[test]
    fn an_inherited_rank_override_wins() {
        assert!(!should_install(Some(&os("1")), Some(&os("vah264dec:PRIMARY"))));
        assert!(!should_install(Some(&os("1")), Some(&os(""))));
    }

    #[test]
    fn the_override_names_each_decoder_once_at_rank_none() {
        let value = rank_override();
        let entries: Vec<&str> = value.split(',').collect();
        assert_eq!(entries.len(), GPU_DECODERS.len());
        assert!(entries.iter().all(|e| e.ends_with(":NONE") && !e.contains(' ')));
        assert!(entries.contains(&"vah264dec:NONE"));
        let mut names: Vec<&str> = GPU_DECODERS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), GPU_DECODERS.len());
    }
}

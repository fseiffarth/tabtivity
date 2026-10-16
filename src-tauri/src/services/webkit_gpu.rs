//! Which WebKitGTK paint path the window starts on (`docs/gpu_compositing_plan.md`).
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

use std::ffi::OsStr;

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

#[cfg(test)]
mod tests {
    use super::*;

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

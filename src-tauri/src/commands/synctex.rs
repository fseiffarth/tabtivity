//! The `synctex_*` commands: reverse and forward search, the deck's page →
//! source-line anchors and the map's freshness, each off the main thread over
//! the native SyncTeX reader in `services::synctex` (S5).

use std::path::Path;

pub use crate::services::synctex::{MapStatus, PageLines, SyncRect, SyncSource};
use crate::services::synctex::{page_lines, resolve, status, view, MAX_MAP_BYTES};

/// Read the SyncTeX map beside `pdf` and report the source lines behind each page.
///
/// Returns an empty vector — never an error — when there is no map, or none
/// readable within the cap: a deck whose plate was imported, or compiled by
/// something that did not emit one, is an ordinary case that falls back to
/// content fingerprinting.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_page_lines(pdf: String) -> Result<Vec<PageLines>, String> {
    app_core::rt::blocking("synctex", move || page_lines(Path::new(&pdf), MAX_MAP_BYTES)).await
}

/// Reverse search: which source line produced the point `(x, y)` (big points
/// from the page top-left) on `page` of `pdf`. `Ok(None)` when there is no map
/// or it has no answer, so the UI can degrade silently. The column is always 0
/// (see {@link SyncSource}).
///
/// Async so the read + gunzip runs off the main thread: a sync `#[tauri::command]`
/// is called on it, and a large document's map is megabytes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_edit(pdf: String, page: u32, x: f64, y: f64) -> Result<Option<SyncSource>, String> {
    app_core::rt::blocking("synctex", move || {
        resolve(Path::new(&pdf), page, x, y).map(|(input, line)| SyncSource {
            input,
            line,
            column: 0,
        })
    })
    .await
}

/// Why a SyncTeX jump did nothing, or landed on the wrong line: whether a map
/// exists beside `pdf`, whether the PDF outgrew it, and which local sources were
/// saved after it ({@link MapStatus}). The viewer asks after a miss — and after
/// a hit, to warn that the line it just jumped to belongs to the build before
/// the edit — and words a "recompile" notice from the answer. Off the main
/// thread for the same reason as `synctex_edit`: the first call after a compile
/// inflates the map.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_status(pdf: String) -> Result<MapStatus, String> {
    app_core::rt::blocking("synctex", move || status(Path::new(&pdf))).await
}

/// Forward search: where in `pdf` the source line `input:line` landed, as every
/// box it produced ({@link view}); the frontend picks the one for the caret's
/// column. Empty when there is no map or no answer. Off the main thread like
/// `synctex_edit`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_view(pdf: String, input: String, line: u32) -> Result<Vec<SyncRect>, String> {
    app_core::rt::blocking("synctex", move || view(Path::new(&pdf), &input, line)).await
}

//! The `synctex_*` commands: reverse and forward search, the deck's page →
//! source-line anchors and the map's freshness, each off the main thread over
//! the native SyncTeX reader in `services::synctex` (S5).
//!
//! Every command first confines the PDF and the map beside it to the roots of
//! the viewer's project (`project_id`, as `read_file_bytes` does): the path
//! comes from the webview, and a map that is a link out of the project would
//! otherwise be read wherever it points.

use std::path::{Path, PathBuf};

pub use crate::services::synctex::{MapStatus, PageLines, SyncRect, SyncSource};
use crate::services::fs_confine::{allowed_roots, confine_abs_within};
use crate::services::synctex::{page_lines, resolve, status, view, MAX_MAP_BYTES};

/// Refuse `pdf` unless it, and each `.synctex(.gz)` beside it that exists, lies
/// inside `roots`.
fn confine_pdf(pdf: &Path, roots: &[PathBuf]) -> Result<(), String> {
    confine_abs_within(pdf, roots)?;
    for ext in ["synctex.gz", "synctex"] {
        let map = pdf.with_extension(ext);
        if std::fs::symlink_metadata(&map).is_ok() {
            confine_abs_within(&map, roots)?;
        }
    }
    Ok(())
}

/// [`confine_pdf`] against the roots of `project_id`'s scope.
fn confined(pdf: &str, project_id: Option<&str>) -> Result<PathBuf, String> {
    let path = PathBuf::from(pdf);
    confine_pdf(&path, &allowed_roots(project_id))?;
    Ok(path)
}

/// Read the SyncTeX map beside `pdf` and report the source lines behind each page.
///
/// Returns an empty vector — never an error — when there is no map, or none
/// readable within the cap: a deck whose plate was imported, or compiled by
/// something that did not emit one, is an ordinary case that falls back to
/// content fingerprinting. A path outside the project is refused.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_page_lines(pdf: String, project_id: Option<String>) -> Result<Vec<PageLines>, String> {
    app_core::rt::blocking("synctex", move || {
        let pdf = confined(&pdf, project_id.as_deref())?;
        Ok(page_lines(&pdf, MAX_MAP_BYTES))
    })
    .await?
}

/// Reverse search: which source line produced the point `(x, y)` (big points
/// from the page top-left) on `page` of `pdf`. `Ok(None)` when there is no map
/// or it has no answer, so the UI can degrade silently. The column is always 0
/// (see {@link SyncSource}).
///
/// Async so the read + gunzip runs off the main thread: a sync `#[tauri::command]`
/// is called on it, and a large document's map is megabytes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_edit(
    pdf: String,
    page: u32,
    x: f64,
    y: f64,
    project_id: Option<String>,
) -> Result<Option<SyncSource>, String> {
    app_core::rt::blocking("synctex", move || {
        let pdf = confined(&pdf, project_id.as_deref())?;
        Ok(resolve(&pdf, page, x, y).map(|(input, line)| SyncSource {
            input,
            line,
            column: 0,
        }))
    })
    .await?
}

/// Why a SyncTeX jump did nothing, or landed on the wrong line: whether a map
/// exists beside `pdf`, whether the PDF outgrew it, and which local sources were
/// saved after it ({@link MapStatus}). The viewer asks after a miss — and after
/// a hit, to warn that the line it just jumped to belongs to the build before
/// the edit — and words a "recompile" notice from the answer. Off the main
/// thread for the same reason as `synctex_edit`: the first call after a compile
/// inflates the map.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_status(pdf: String, project_id: Option<String>) -> Result<MapStatus, String> {
    app_core::rt::blocking("synctex", move || {
        let pdf = confined(&pdf, project_id.as_deref())?;
        Ok(status(&pdf))
    })
    .await?
}

/// Forward search: where in `pdf` the source line `input:line` landed, as every
/// box it produced ({@link view}); the frontend picks the one for the caret's
/// column. Empty when there is no map or no answer. Off the main thread like
/// `synctex_edit`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_view(
    pdf: String,
    input: String,
    line: u32,
    project_id: Option<String>,
) -> Result<Vec<SyncRect>, String> {
    app_core::rt::blocking("synctex", move || {
        let pdf = confined(&pdf, project_id.as_deref())?;
        Ok(view(&pdf, &input, line))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_and_its_map_are_read_only_inside_the_roots() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let roots = vec![root.clone()];
        let pdf = root.join("main.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        assert_eq!(confine_pdf(&pdf, &roots), Ok(()));
        // No project open: nothing is readable.
        assert!(confine_pdf(&pdf, &[]).is_err());
        // A PDF outside the project.
        let stray = outside.path().join("other.pdf");
        std::fs::write(&stray, b"%PDF").unwrap();
        assert!(confine_pdf(&stray, &roots).is_err());
        // A `..` walk out of it.
        assert!(confine_pdf(&root.join("sub").join("..").join("..").join("x.pdf"), &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_map_that_links_out_of_the_project_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let roots = vec![root.clone()];
        let pdf = root.join("main.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        let secret = outside.path().join("secret");
        std::fs::write(&secret, b"x").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("main.synctex.gz")).unwrap();
        assert!(confine_pdf(&pdf, &roots).is_err());
        // A map inside the project still reads.
        std::fs::remove_file(root.join("main.synctex.gz")).unwrap();
        std::fs::write(root.join("main.synctex"), b"SyncTeX Version:1\n").unwrap();
        assert_eq!(confine_pdf(&pdf, &roots), Ok(()));
    }
}

//! Spreadsheet reader backend (Dev G).
//!
//! Reads `.xlsx`/`.xls`/`.xlsm` workbooks and returns a single sheet as a
//! rectangular grid of stringified cells, so the existing CSV/TSV `TableView`
//! can render spreadsheets too. The parse itself runs in a limited child
//! process (`services::sheet_reader`): calamine can abort on a crafted file,
//! and an abort must end the reader, not the app.

use std::path::Path;

pub use crate::services::sheet_reader::SheetData;
use crate::services::sheet_reader;

/// Read one sheet of a spreadsheet workbook. When `sheet` is `None`, returns the
/// first sheet. `project_id` is the viewer's scope: the path must sit in that
/// project's roots, as for every `fs.rs` reader.
///
/// Async + `spawn_blocking`: the read waits on a child process, and a large
/// `.xlsx` (or one on a network mount) run synchronously froze the window (the
/// main-thread freeze class `commands::git`'s `run_off_thread` doc describes).
#[tauri::command]
pub async fn read_spreadsheet(
    path: String,
    sheet: Option<String>,
    project_id: Option<String>,
) -> Result<SheetData, String> {
    tokio::task::spawn_blocking(move || read_spreadsheet_blocking(path, sheet, project_id))
        .await
        .map_err(|e| format!("spreadsheet task failed: {e}"))?
}

pub fn read_spreadsheet_blocking(
    path: String,
    sheet: Option<String>,
    project_id: Option<String>,
) -> Result<SheetData, String> {
    let path = Path::new(&path);
    // The extension first: an unsupported file is refused the same way inside
    // or outside the project.
    sheet_reader::format_of(path)?;
    crate::commands::fs::confine_project_path(path, project_id.as_deref())?;
    sheet_reader::read_in_child(path, sheet.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_outside_the_scope_is_refused_before_any_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        std::fs::write(&path, b"not read").unwrap();
        // No project has this id, so its scope has no roots: fail closed.
        let err = read_spreadsheet_blocking(
            path.to_string_lossy().into_owned(),
            None,
            Some("no-such-project-0c1d".into()),
        )
        .unwrap_err();
        assert!(err.contains("not in the current project"), "got: {err}");
    }

    #[test]
    fn an_unsupported_extension_is_refused() {
        let err = read_spreadsheet_blocking("/no/such/book.ods".into(), None, None).unwrap_err();
        assert_eq!(err, sheet_reader::ERR_UNSUPPORTED);
    }
}

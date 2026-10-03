//! Spreadsheet reader backend (Dev G).
//!
//! Reads `.xlsx`/`.xls`/`.xlsm` workbooks via `calamine` and returns a single
//! sheet as a rectangular grid of stringified cells, so the existing CSV/TSV
//! `TableView` can render spreadsheets too (retires part of the deferred #51
//! office-format gap). Bounds the row count so a huge workbook can't exhaust
//! memory.

use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;

/// Hard cap on the number of rows returned so a huge workbook can't exhaust
/// memory. Rows beyond this are silently dropped for v1 (the UI already has its
/// own render window on top of this).
const MAX_ROWS: usize = 20_000;

/// A workbook read result: the names of all sheets (so the UI can offer a sheet
/// picker) plus the rows of the selected (or first) sheet.
#[derive(Debug, Clone, Serialize)]
pub struct SheetData {
    pub sheet_names: Vec<String>,
    /// The sheet actually returned in `rows`.
    pub active_sheet: String,
    /// Row-major grid of stringified cells (header row included, if any).
    pub rows: Vec<Vec<String>>,
}

/// Stringify a single spreadsheet cell. Pure so it can be unit-tested without a
/// workbook file. Empty cells become `""`; everything else renders to a plain,
/// CSV-like string the table viewer can display.
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            // Render whole floats without a trailing `.0` so a column of integers
            // stored as floats (the common xlsx case) reads cleanly.
            if f.fract() == 0.0 && f.is_finite() {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        // DateTime / DateTimeIso / DurationIso / Error all have a sensible Display.
        other => other.to_string(),
    }
}

/// Read one sheet of a spreadsheet workbook. When `sheet` is `None`, returns the
/// first sheet.
///
/// Async + `spawn_blocking`: calamine loads the whole workbook, so a large
/// `.xlsx` (or one on a network mount) run synchronously froze the window (the
/// main-thread freeze class `commands::git`'s `run_off_thread` doc describes).
/// The sync body stays directly unit-testable.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn read_spreadsheet(path: String, sheet: Option<String>) -> Result<SheetData, String> {
    tokio::task::spawn_blocking(move || read_spreadsheet_blocking(path, sheet))
        .await
        .map_err(|e| format!("spreadsheet task failed: {e}"))?
}

pub fn read_spreadsheet_blocking(path: String, sheet: Option<String>) -> Result<SheetData, String> {
    let mut workbook =
        open_workbook_auto(&path).map_err(|e| format!("Failed to open workbook: {e}"))?;

    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err("Workbook has no sheets".to_string());
    }

    // Pick the requested sheet if present, otherwise fall back to the first.
    let active_sheet = match sheet {
        Some(name) if sheet_names.iter().any(|n| n == &name) => name,
        _ => sheet_names[0].clone(),
    };

    let range = workbook
        .worksheet_range(&active_sheet)
        .map_err(|e| format!("Failed to read sheet '{active_sheet}': {e}"))?;

    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in range.rows() {
        if rows.len() >= MAX_ROWS {
            break; // Truncate huge workbooks (v1); the rest is dropped.
        }
        rows.push(row.iter().map(cell_to_string).collect());
    }

    Ok(SheetData {
        sheet_names,
        active_sheet,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonexistent_path_is_err() {
        let res = read_spreadsheet_blocking("/no/such/file/definitely-missing.xlsx".into(), None);
        assert!(res.is_err());
    }

    #[test]
    fn cell_to_string_maps_variants() {
        assert_eq!(cell_to_string(&Data::Empty), "");
        assert_eq!(cell_to_string(&Data::String("hi".into())), "hi");
        assert_eq!(cell_to_string(&Data::Int(42)), "42");
        // Whole floats lose the trailing `.0`.
        assert_eq!(cell_to_string(&Data::Float(7.0)), "7");
        // Fractional floats keep their decimals.
        assert_eq!(cell_to_string(&Data::Float(3.5)), "3.5");
        assert_eq!(cell_to_string(&Data::Bool(true)), "TRUE");
        assert_eq!(cell_to_string(&Data::Bool(false)), "FALSE");
    }
}

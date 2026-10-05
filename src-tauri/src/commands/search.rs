//! Project-wide literal content search (Group: new viewers / project search).
//!
//! `project_search` walks a project tree (reusing the safe-walk idiom from
//! `commands::fs::collect_project_paths`: recursive `read_dir`, skipped vendor
//! dirs, no symlink-following, a hard depth cap) and reports every line that
//! contains the query as a literal substring. There is no regex in v1.
//!
//! The walk is pure Rust — `rg` is intentionally NOT depended upon (it is not on
//! PATH in the build sandbox), so the literal walker below is the only
//! implementation and is exactly what the tests exercise.

use std::fs;
use std::path::{Path, PathBuf};

/// One matching line. `line`/`col` are 1-based; `col` is the char column of the
/// first occurrence of the query in `text`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchMatch {
    /// Absolute path to the file containing the match.
    pub path: String,
    /// Project-relative path (forward-slash separated) for display.
    pub rel: String,
    pub line: u32,
    pub col: u32,
    /// The full text of the matching line (trailing newline stripped).
    pub text: String,
}

/// Hard cap on recursive scan depth — mirrors `fs::MAX_SCAN_DEPTH`. Guards
/// against pathological trees even though symlinks are not followed.
const MAX_SCAN_DEPTH: usize = 64;

/// Largest file we will read into memory for scanning.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB

/// How many leading bytes to sniff for a NUL byte (binary detection).
const BINARY_SNIFF_BYTES: usize = 8 * 1024; // 8 KiB

/// Default result cap when the caller does not supply one.
const DEFAULT_MAX_RESULTS: usize = 500;

/// Vendor/build directories never worth searching. Mirrors
/// `fs::should_skip_ending_scan_dir`.
fn should_skip_dir(name: &str) -> bool {
    crate::brand::is_project_dir(name) || matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
            // Python vendor/artifact dirs, mirrored from fs.rs.
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".tox"
    )
}

/// True when `bytes` looks like binary content (contains a NUL byte).
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Per-char lower-casing, matching how `first_match_col` builds its lowered
/// haystack. `str::to_lowercase` is context-sensitive for Greek final sigma
/// (Σ → ς at a word end, σ elsewhere); the per-char form always yields σ, and
/// needle and haystack must agree or a trailing Σ in the query never matches.
fn lowercase_chars(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).collect()
}

/// Find the 1-based char column of the first occurrence of `needle` in `hay`.
/// For a case-insensitive search the caller passes the needle already
/// lower-cased via `lowercase_chars` in `needle_lower` (computed once per
/// file, not once per line); `None` there means a case-sensitive search.
/// Returns `None` when absent.
fn first_match_col(hay: &str, needle: &str, needle_lower: Option<&str>) -> Option<u32> {
    let byte_idx = if let Some(needle_l) = needle_lower {
        // Case-insensitive: lower-case the haystack per char, keeping a map
        // from each lowered char back to the byte index of the original char
        // that produced it. Counting chars is NOT enough — lower-casing can
        // expand one char into several ('İ' → "i\u{307}"), which would drift
        // the column right past every such char before the match.
        let mut hay_l = String::with_capacity(hay.len());
        let mut orig_byte_of_lowered_char: Vec<usize> = Vec::new();
        for (orig_byte, c) in hay.char_indices() {
            for lc in c.to_lowercase() {
                orig_byte_of_lowered_char.push(orig_byte);
                hay_l.push(lc);
            }
        }
        hay_l.find(needle_l).map(|lower_idx| {
            // A match starting inside an expansion still maps to the original
            // char that produced it, which is the honest column to report.
            let lowered_char_count = hay_l[..lower_idx].chars().count();
            orig_byte_of_lowered_char
                .get(lowered_char_count)
                .copied()
                .unwrap_or(hay.len())
        })
    } else {
        hay.find(needle)
    }?;
    // Convert a byte index in `hay` to a 1-based char column.
    let col = hay[..byte_idx].chars().count() as u32 + 1;
    Some(col)
}

/// Scan a single file's contents, appending matches. `out` is bounded by
/// `max_results`; returns once the cap is hit.
fn scan_file(
    path: &Path,
    rel: &str,
    query: &str,
    case_sensitive: bool,
    max_results: usize,
    out: &mut Vec<SearchMatch>,
) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() > MAX_FILE_BYTES {
        return;
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return,
    };
    if looks_binary(&bytes) {
        return;
    }
    let content = String::from_utf8_lossy(&bytes);
    let path_str = path.to_string_lossy().to_string();
    // Lower-case the needle once per file rather than once per line.
    let needle_lower = (!case_sensitive).then(|| lowercase_chars(query));
    for (i, raw_line) in content.lines().enumerate() {
        if out.len() >= max_results {
            return;
        }
        if let Some(col) = first_match_col(raw_line, query, needle_lower.as_deref()) {
            out.push(SearchMatch {
                path: path_str.clone(),
                rel: rel.to_string(),
                line: i as u32 + 1,
                col,
                text: raw_line.to_string(),
            });
        }
    }
}

/// Recursively walk `dir`, scanning files for `query`. Confined to `root`.
fn walk(
    root: &Path,
    dir: &Path,
    rel_dir: &str,
    depth: usize,
    query: &str,
    case_sensitive: bool,
    max_results: usize,
    out: &mut Vec<SearchMatch>,
) {
    if out.len() >= max_results || depth >= MAX_SCAN_DEPTH {
        return;
    }
    // Confinement: never escape the canonicalized root.
    if !dir.starts_with(root) {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= max_results {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        // `entry.file_type()` does NOT follow symlinks; a symlinked directory is
        // reported as a non-directory, so a symlinked dir never recurses (and a
        // self-referential symlink cannot loop).
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if is_dir {
            if should_skip_dir(&name) {
                continue;
            }
            walk(
                root,
                &path,
                &rel,
                depth + 1,
                query,
                case_sensitive,
                max_results,
                out,
            );
        } else {
            // Skip symlinks to files too (file_type reports symlink, not file).
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                scan_file(&path, &rel, query, case_sensitive, max_results, out);
            }
        }
    }
}

/// Literal, project-confined content search. Returns up to `max_results`
/// matching lines (default 500). Vendor/build dirs, binary files, and oversized
/// files are skipped; symlinks are not followed.
///
/// Async + `spawn_blocking` because the walk reads every file ≤ 8 MiB in the
/// tree — run synchronously that froze the whole window for the duration of
/// every search on a large project (the main-thread freeze class
/// `commands::git`'s `run_off_thread` doc describes). The sync body stays
/// directly unit-testable below.
#[tauri::command]
pub async fn project_search(
    project_dir: String,
    query: String,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    tokio::task::spawn_blocking(move || {
        project_search_blocking(project_dir, query, case_sensitive, max_results)
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

pub fn project_search_blocking(
    project_dir: String,
    query: String,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let cap = max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
    let root_raw = PathBuf::from(&project_dir);
    let root = root_raw
        .canonicalize()
        .map_err(|e| format!("invalid project_dir '{project_dir}': {e}"))?;
    if !root.is_dir() {
        return Err(format!("project_dir '{project_dir}' is not a directory"));
    }
    let mut out = Vec::new();
    walk(&root, &root, "", 0, &query, case_sensitive, cap, &mut out);
    Ok(out)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn rels(matches: &[SearchMatch]) -> Vec<&str> {
        matches.iter().map(|m| m.rel.as_str()).collect()
    }

    #[test]
    fn finds_matches_with_line_and_col() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("a.txt"),
            "hello world\nsecond NEEDLE here\nplain\n",
        )
        .unwrap();
        fs::write(root.join("b.rs"), "fn main() { let needle = 1; }\n").unwrap();

        let matches = project_search_blocking(
            root.to_string_lossy().to_string(),
            "NEEDLE".into(),
            true,
            None,
        )
        .unwrap();

        assert_eq!(matches.len(), 1, "only the case-sensitive line matches");
        let m = &matches[0];
        assert_eq!(m.rel, "a.txt");
        assert_eq!(m.line, 2);
        // "second " is 7 chars, so NEEDLE starts at char column 8.
        assert_eq!(m.col, 8);
        assert!(m.text.contains("NEEDLE"));
        assert!(m.path.ends_with("a.txt"));
    }

    #[test]
    fn case_insensitive_matches_both() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "second NEEDLE here\n").unwrap();
        fs::write(root.join("b.rs"), "let needle = 1;\n").unwrap();

        let matches = project_search_blocking(
            root.to_string_lossy().to_string(),
            "needle".into(),
            false,
            None,
        )
        .unwrap();

        assert_eq!(matches.len(), 2, "both files match case-insensitively");
        // b.rs: "let " = 4 chars, needle at column 5.
        let b = matches.iter().find(|m| m.rel == "b.rs").unwrap();
        assert_eq!(b.col, 5);
        assert_eq!(b.line, 1);
    }

    #[test]
    fn case_insensitive_col_survives_expanding_lowercase() {
        // 'İ' (U+0130) lower-cases to TWO chars ("i\u{307}"); a char-count
        // mapping drifts the column right past every such char (11.1).
        // "İİ NEEDLE": İ, İ, space = 3 chars, so NEEDLE is at char column 4.
        assert_eq!(first_match_col("İİ NEEDLE", "needle", Some("needle")), Some(4));
        // Sanity: no expanding chars before the match stays exact.
        assert_eq!(first_match_col("ab NEEDLE", "needle", Some("needle")), Some(4));
        // Expanding char INSIDE the needle: query "İx" must find "İX".
        let needle_l = lowercase_chars("İx");
        assert_eq!(first_match_col("zz İX", "İx", Some(&needle_l)), Some(4));
        // Greek capital sigma at a word end: per-char lowering on both sides
        // keeps needle and haystack in agreement (always σ, never ς).
        let sigma_l = lowercase_chars("ΑΣ");
        assert_eq!(first_match_col("x ΑΣ y", "ΑΣ", Some(&sigma_l)), Some(3));
        assert_eq!(first_match_col("nope", "needle", Some("needle")), None);
    }

    #[test]
    fn skips_node_modules_and_binary_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("keep.txt"), "find QUERYME here\n").unwrap();

        let nm = root.join("node_modules").join("pkg");
        fs::create_dir_all(&nm).unwrap();
        fs::write(nm.join("dep.js"), "QUERYME in vendored code\n").unwrap();

        // Binary file with a NUL byte that also contains the literal text.
        fs::write(root.join("blob.bin"), b"QUERYME\x00binary\n").unwrap();

        let matches = project_search_blocking(
            root.to_string_lossy().to_string(),
            "QUERYME".into(),
            true,
            None,
        )
        .unwrap();

        let found = rels(&matches);
        assert_eq!(found, vec!["keep.txt"], "node_modules + binary excluded");
    }

    #[test]
    fn honours_max_results() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // 10 lines, each containing the query.
        let body: String = (0..10).map(|i| format!("line {i} HIT\n")).collect();
        fs::write(root.join("many.txt"), body).unwrap();

        let matches = project_search_blocking(
            root.to_string_lossy().to_string(),
            "HIT".into(),
            true,
            Some(3),
        )
        .unwrap();

        assert_eq!(matches.len(), 3, "result cap honoured");
    }

    #[test]
    fn empty_query_returns_empty() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "anything\n").unwrap();
        let matches =
            project_search_blocking(root.to_string_lossy().to_string(), "".into(), true, None).unwrap();
        assert!(matches.is_empty());
    }
}

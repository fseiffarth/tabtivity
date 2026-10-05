//! Regression guard: Tabtivity must NEVER write into another application's config
//! to redirect its behavior — specifically, it must not edit a browser's
//! download directory (Firefox `prefs.js`, Chromium `Preferences`).
//!
//! An earlier version did exactly this (the removed
//! `commands/downloads.rs::configure_browser_downloads`, which set
//! `browser.download.dir` / `browser.download.folderList` and the Chromium
//! `default_directory`). It was ripped out on 2026-06-30; this test fails the
//! build if any such foreign-config write marker reappears in the source tree.
//!
//! Privacy: the scan reads only files under this crate's own `src/` tree, and on
//! failure reports only the repo-relative file path and the matched marker —
//! never file contents, absolute paths, or any user/home data. This test file
//! is excluded from its own scan so its marker literals don't self-match
//! (mirroring how `scripts/privacy-check.sh` excludes itself).

use std::fs;
use std::path::{Path, PathBuf};

/// Substrings that only make sense if we're editing a browser's config. None of
/// these legitimately appear in Tabtivity's own source; the read-only downloads
/// feature (`list_recent_downloads` / `download_sources`) uses none of them.
const FORBIDDEN_MARKERS: &[&str] = &[
    "browser.download.", // Firefox download-dir prefs (dir/folderList/useDownloadDir)
    "prefs.js",          // Firefox profile prefs file
    "default_directory", // Chromium `download.default_directory` pref key
    ".parentlock",       // Firefox profile lock the old editor checked
];

/// Recursively collect every `.rs` file under `dir`.
fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_source_writes_foreign_browser_config() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");

    let mut files = Vec::new();
    collect_rs_files(&src_dir, &mut files);
    assert!(
        !files.is_empty(),
        "guard scanned no source files — expected {}/**.rs to exist",
        src_dir.display()
    );

    // Report only repo-relative paths + the matched marker; never file contents.
    let mut violations: Vec<String> = Vec::new();
    for file in &files {
        let content = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rel = file
            .strip_prefix(&manifest_dir)
            .unwrap_or(file)
            .to_string_lossy()
            .to_string();
        for marker in FORBIDDEN_MARKERS {
            if content.contains(marker) {
                violations.push(format!("  {rel}: contains forbidden marker `{marker}`"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        concat!(app_lib::app_name!(), " must never write another app's config (browser download dir).\n\
         This is the removed commands/downloads.rs behavior — do not reintroduce it.\n\
         Offending source:\n{}"),
        violations.join("\n")
    );
}

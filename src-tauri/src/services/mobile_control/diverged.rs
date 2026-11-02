//! The phone's Diverged list: a remote project's files whose mirror and host
//! copies disagree, and the new files only the mirror holds — the desktop's
//! orange view at phone width.
//!
//! The sidecar holds no SSH session, so the facts and every transfer are the
//! window's (`lib/mobileDiverged.ts`, over the sync commands the orange view
//! itself calls); with no window the list answers `desktop_unavailable`. What
//! is here is what must not depend on a window: the two gates, and turning the
//! window's project-relative paths into what may cross.
//!
//! A row crosses with its path as display text, as a Diffs row does, and a
//! token sealed under a binding of its own ([`aad`]), so a file browser token
//! never names a file to transfer. Hidden names (`files::hidden`) cross as a
//! count only: the library does not show them, and this list must not be the
//! way round that.

use std::{fs, path::Path};

use serde::Serialize;
use serde_json::Value;

use super::files::{self, FilesError};
use super::protocol::DivergedFile;

/// Rows sent; the rest are counted in `total`, and one action takes at most
/// this many, so all of a shown list goes at once.
pub const MAX_ROWS: usize = 500;

/// Whether the phone may resolve (`project_sync`), which only counts while the
/// browser switch is on too. Both read from `settings.json` per call, so
/// turning either off closes the route at once. Reading the list asks only for
/// `files::files_open`: it shows no more than the library would.
pub fn sync_open(state_dir: &Path) -> bool {
    files::files_open(state_dir)
        && fs::read(state_dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|settings| {
                settings
                    .get(crate::brand::MOBILE_HOST_KEY)?
                    .get("project_sync")?
                    .as_bool()
            })
            .unwrap_or(false)
}

/// What a row's token is bound to: the project's raw id and this list.
fn aad(raw_id: &str) -> String {
    format!("{raw_id}\0diverged")
}

/// Seals a listed path for the phone.
pub fn seal(host_key: &[u8], raw_id: &str, rel: &str) -> Result<String, FilesError> {
    files::seal(host_key, &aad(raw_id), rel)
}

/// The path a row's token seals, if this host sealed it for this list of this
/// project. A hidden name is refused here too (`files::unseal`).
pub fn unseal(host_key: &[u8], raw_id: &str, token: &str) -> Option<String> {
    files::unseal(host_key, &aad(raw_id), token)
}

/// One row as the phone gets it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub id: String,
    pub path: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_mtime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_mtime: Option<u64>,
    pub host_diverged: bool,
    pub local_diverged: bool,
    pub host_checked: bool,
}

/// The list as the phone gets it. `total` counts what the phone may see,
/// `rows` or not; `hidden` what it may not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listing {
    pub rows: Vec<Row>,
    pub total: u32,
    pub hidden: u32,
}

/// The window's rows with hidden names taken out and the rest sealed, diverged
/// ones first so a cap never drops them for new files. `Err` only when the OS
/// has no randomness for a nonce.
pub fn listing(host_key: &[u8], raw_id: &str, mut files: Vec<DivergedFile>) -> Result<Listing, FilesError> {
    let before = files.len();
    files.retain(|file| files::valid_rel(&file.rel) && !file.rel.is_empty());
    let hidden = before - files.len();
    files.sort_by(|a, b| (a.state != "amber", &a.rel).cmp(&(b.state != "amber", &b.rel)));
    let total = files.len();
    let rows = files
        .into_iter()
        .take(MAX_ROWS)
        .map(|file| {
            Ok(Row {
                id: seal(host_key, raw_id, &file.rel)?,
                path: file.rel,
                state: file.state,
                host_mtime: file.host_mtime,
                local_mtime: file.local_mtime,
                host_diverged: file.host_diverged,
                local_diverged: file.local_diverged,
                host_checked: file.host_checked,
            })
        })
        .collect::<Result<Vec<_>, FilesError>>()?;
    Ok(Listing { rows, total: total as u32, hidden: hidden as u32 })
}

/// The paths a phone's tokens name: all of them, or `None` when any does not
/// open, so one stale token never turns into a smaller transfer than the one
/// that was confirmed.
pub fn open_all(host_key: &[u8], raw_id: &str, tokens: &[String]) -> Option<Vec<String>> {
    tokens.iter().map(|token| unseal(host_key, raw_id, token)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const KEY: &[u8] = &[7u8; 32];

    fn file(rel: &str, state: &str) -> DivergedFile {
        DivergedFile {
            rel: rel.into(),
            state: state.into(),
            host_mtime: Some(10),
            local_mtime: None,
            host_diverged: true,
            local_diverged: false,
            host_checked: true,
        }
    }

    fn write_settings(dir: &Path, host: Value) {
        let settings = serde_json::json!({ crate::brand::MOBILE_HOST_KEY: host });
        fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
    }

    #[test]
    fn the_switch_only_counts_with_the_browser_on() {
        let dir = tempdir().unwrap();
        assert!(!sync_open(dir.path()), "no settings is off");
        write_settings(dir.path(), serde_json::json!({ "project_sync": true }));
        assert!(!sync_open(dir.path()), "project_files is off");
        write_settings(dir.path(), serde_json::json!({ "project_files": true }));
        assert!(!sync_open(dir.path()), "project_sync defaults to off");
        write_settings(dir.path(), serde_json::json!({ "project_files": true, "project_sync": true }));
        assert!(sync_open(dir.path()));
    }

    #[test]
    fn a_hidden_name_crosses_as_a_count_only() {
        let files = vec![file("src/a.py", "amber"), file(".env.local", "amber"), file("deep/.git/config", "amber"), file(".github/ci.yml", "amber")];
        let listing = listing(KEY, "p", files).unwrap();
        let paths: Vec<&str> = listing.rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(paths, vec![".github/ci.yml", "src/a.py"]);
        assert_eq!((listing.total, listing.hidden), (2, 2));
    }

    #[test]
    fn diverged_rows_outrank_new_ones_at_the_cap() {
        let mut files: Vec<DivergedFile> = (0..MAX_ROWS).map(|n| file(&format!("a{n:04}.txt"), "localnew")).collect();
        files.push(file("z-diverged.txt", "amber"));
        let listing = listing(KEY, "p", files).unwrap();
        assert_eq!(listing.rows.len(), MAX_ROWS);
        assert_eq!(listing.total as usize, MAX_ROWS + 1);
        assert_eq!(listing.rows[0].path, "z-diverged.txt");
    }

    #[test]
    fn a_token_opens_only_for_its_project_and_this_list() {
        let token = seal(KEY, "p", "src/a.py").unwrap();
        assert_eq!(unseal(KEY, "p", &token).as_deref(), Some("src/a.py"));
        assert_eq!(unseal(KEY, "other", &token), None);
        assert_eq!(unseal(&[8u8; 32], "p", &token), None);
        let browser = files::seal(KEY, "p", "src/a.py").unwrap();
        assert_eq!(unseal(KEY, "p", &browser), None, "a browser token names no transfer");
        assert_eq!(files::unseal(KEY, "p", &token), None, "nor this one a browser read");
    }

    #[test]
    fn one_bad_token_refuses_the_whole_batch() {
        let good = seal(KEY, "p", "a.txt").unwrap();
        assert_eq!(open_all(KEY, "p", std::slice::from_ref(&good)), Some(vec!["a.txt".to_string()]));
        assert_eq!(open_all(KEY, "p", &[good, "nonsense".into()]), None);
    }
}

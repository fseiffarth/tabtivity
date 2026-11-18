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

use base64ct::{Base64UrlUnpadded, Encoding};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use super::files::{self, FilesError};
use super::protocol::{DivergedFile, SyncOp};

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

/// How long a preview token stays good: the phone's confirmation sheet is
/// open for a moment, not for the afternoon.
pub const PREVIEW_TTL_SECS: u64 = 600;

/// The longest fingerprint a token carries: a SHA-256 in hex.
const MAX_FINGERPRINT: usize = 64;

/// Why a resolve's preview token did not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewRefusal {
    /// The resolve named no token (an older phone, or one that skipped the
    /// preview).
    Required,
    /// Malformed, forged, past its expiry, or minted for another project, op
    /// or set of files.
    Stale,
}

impl PreviewRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Required => "preview_required",
            Self::Stale => "preview_stale",
        }
    }
}

/// The key preview tokens are authenticated with: derived from the host key
/// under its own label, so it is never the one path tokens are sealed with.
fn preview_key(host_key: &[u8]) -> [u8; 32] {
    let mut key: [u8; 32] = std::array::from_fn(|_| 0);
    Hkdf::<Sha256>::new(Some(b"diverged-preview"), host_key)
        .expand(b"preview-token v1", &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

/// What a token's MAC covers: the project, the op, the sorted paths, the
/// window's fingerprint and the expiry, each length-prefixed so no field runs
/// into the next.
fn preview_mac(host_key: &[u8], raw_id: &str, op: SyncOp, paths: &[String], fingerprint: &str, expiry: u64) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(&preview_key(host_key)).expect("HMAC accepts all key sizes");
    let mut field = |bytes: &[u8]| {
        mac.update(&(bytes.len() as u64).to_be_bytes());
        mac.update(bytes);
    };
    field(raw_id.as_bytes());
    field(op.as_str().as_bytes());
    let mut sorted: Vec<&String> = paths.iter().collect();
    sorted.sort();
    field(&(sorted.len() as u64).to_be_bytes());
    for path in sorted {
        field(path.as_bytes());
    }
    field(fingerprint.as_bytes());
    field(&expiry.to_be_bytes());
    mac
}

type HmacSha256 = Hmac<Sha256>;

/// The token a preview hands the phone: `v1.<expiry>.<fingerprint>.<mac>`. The
/// fingerprint is the window's hash of the state and mtimes of the rows it
/// showed; the MAC is the host key's over it, the project, the op and the
/// files, so a resolve can only be authorised by a preview of exactly what it
/// does. `None` for a fingerprint that is not hex (a window that is not ours).
pub fn preview_token(host_key: &[u8], raw_id: &str, op: SyncOp, paths: &[String], fingerprint: &str, now: u64) -> Option<String> {
    if !valid_fingerprint(fingerprint) {
        return None;
    }
    let expiry = now.saturating_add(PREVIEW_TTL_SECS);
    let mac = preview_mac(host_key, raw_id, op, paths, fingerprint, expiry).finalize().into_bytes();
    Some(format!("v1.{expiry}.{fingerprint}.{}", Base64UrlUnpadded::encode_string(&mac)))
}

fn valid_fingerprint(fingerprint: &str) -> bool {
    !fingerprint.is_empty() && fingerprint.len() <= MAX_FINGERPRINT && fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The fingerprint a token vouches for, if it was minted by this host for
/// exactly this project, op and set of paths and has not expired. The MAC is
/// compared in constant time.
pub fn open_preview_token(host_key: &[u8], raw_id: &str, op: SyncOp, paths: &[String], token: Option<&str>, now: u64) -> Result<String, PreviewRefusal> {
    let token = token.filter(|token| !token.is_empty()).ok_or(PreviewRefusal::Required)?;
    let mut parts = token.split('.');
    let (Some("v1"), Some(expiry), Some(fingerprint), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(PreviewRefusal::Stale);
    };
    let (Ok(expiry), true, Ok(mac)) = (expiry.parse::<u64>(), valid_fingerprint(fingerprint), Base64UrlUnpadded::decode_vec(mac)) else {
        return Err(PreviewRefusal::Stale);
    };
    if preview_mac(host_key, raw_id, op, paths, fingerprint, expiry).verify_slice(&mac).is_err() || now > expiry {
        return Err(PreviewRefusal::Stale);
    }
    Ok(fingerprint.to_string())
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

    const FP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn paths(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_preview_token_opens_for_the_op_and_files_it_was_minted_for() {
        let files = paths(&["b.txt", "a.txt"]);
        let token = preview_token(KEY, "p", SyncOp::DeleteHost, &files, FP, 1_000).unwrap();
        // Order does not matter: the phone may name the files in any order.
        let reordered = paths(&["a.txt", "b.txt"]);
        assert_eq!(open_preview_token(KEY, "p", SyncOp::DeleteHost, &reordered, Some(&token), 1_001), Ok(FP.to_string()));
        assert_eq!(open_preview_token(KEY, "p", SyncOp::DeleteHost, &files, Some(&token), 1_000 + PREVIEW_TTL_SECS), Ok(FP.to_string()), "good through its last second");
    }

    #[test]
    fn a_preview_token_is_refused_for_anything_else() {
        let files = paths(&["a.txt", "b.txt"]);
        let token = preview_token(KEY, "p", SyncOp::DeleteHost, &files, FP, 1_000).unwrap();
        let stale = |op, files: &[String], token: &str, now| open_preview_token(KEY, "p", op, files, Some(token), now);
        assert_eq!(stale(SyncOp::DeleteHost, &files, &token, 1_000 + PREVIEW_TTL_SECS + 1), Err(PreviewRefusal::Stale), "expired");
        assert_eq!(stale(SyncOp::DeleteLocal, &files, &token, 1_001), Err(PreviewRefusal::Stale), "another op");
        assert_eq!(stale(SyncOp::Pull, &files, &token, 1_001), Err(PreviewRefusal::Stale), "a take-a-side from a delete's receipt");
        assert_eq!(stale(SyncOp::DeleteHost, &paths(&["a.txt"]), &token, 1_001), Err(PreviewRefusal::Stale), "fewer files");
        assert_eq!(stale(SyncOp::DeleteHost, &paths(&["a.txt", "b.txt", "c.txt"]), &token, 1_001), Err(PreviewRefusal::Stale), "more files");
        assert_eq!(stale(SyncOp::DeleteHost, &paths(&["a.txt", "c.txt"]), &token, 1_001), Err(PreviewRefusal::Stale), "other files");
        assert_eq!(open_preview_token(KEY, "other", SyncOp::DeleteHost, &files, Some(&token), 1_001), Err(PreviewRefusal::Stale), "another project");
        assert_eq!(open_preview_token(&[8u8; 32], "p", SyncOp::DeleteHost, &files, Some(&token), 1_001), Err(PreviewRefusal::Stale), "another host key");
    }

    #[test]
    fn a_preview_token_cannot_be_edited_to_say_something_else() {
        let files = paths(&["a.txt"]);
        let token = preview_token(KEY, "p", SyncOp::DeleteHost, &files, FP, 1_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let other_fp = "f".repeat(64);
        let forged = [
            format!("{}.{}.{}.{}", parts[0], parts[1], other_fp, parts[3]),
            format!("{}.{}.{}.{}", parts[0], 9_999_999, parts[2], parts[3]),
            format!("v2.{}.{}.{}", parts[1], parts[2], parts[3]),
            format!("{}.{}.{}", parts[0], parts[1], parts[2]),
            format!("{token}.extra"),
            format!("v1.1600.{FP}.not base64!"),
            String::from("garbage"),
        ];
        for token in &forged {
            assert_eq!(open_preview_token(KEY, "p", SyncOp::DeleteHost, &files, Some(token), 1_001), Err(PreviewRefusal::Stale), "{token}");
        }
    }

    #[test]
    fn no_token_is_required_not_stale() {
        let files = paths(&["a.txt"]);
        assert_eq!(open_preview_token(KEY, "p", SyncOp::Pull, &files, None, 1), Err(PreviewRefusal::Required));
        assert_eq!(open_preview_token(KEY, "p", SyncOp::Pull, &files, Some(""), 1), Err(PreviewRefusal::Required));
        assert_eq!(PreviewRefusal::Required.code(), "preview_required");
        assert_eq!(PreviewRefusal::Stale.code(), "preview_stale");
    }

    #[test]
    fn only_a_hex_fingerprint_is_sealed() {
        let files = paths(&["a.txt"]);
        for bad in ["", "not hex", "ABC", &"a".repeat(65), "a.b"] {
            assert_eq!(preview_token(KEY, "p", SyncOp::Pull, &files, bad, 1), None, "{bad:?}");
        }
        assert!(preview_token(KEY, "p", SyncOp::Pull, &files, "abc123", 1).is_some());
    }

    #[test]
    fn only_forget_goes_without_a_preview() {
        for op in [SyncOp::Pull, SyncOp::Push, SyncOp::DeleteHost, SyncOp::DeleteLocal] {
            assert!(op.needs_preview(), "{op:?}");
        }
        assert!(!SyncOp::Forget.needs_preview());
        assert!(SyncOp::DeleteHost.deletes() && SyncOp::DeleteLocal.deletes() && !SyncOp::Pull.deletes());
    }
}

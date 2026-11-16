//! The host's on-disk bookkeeping, pure so it is tested on every OS: the
//! layout under `<control_dir>/session-host/`, which versioned copies a prune
//! may remove, when a running host of another version is retired, and the
//! `sessions.json` it leaves for desktop restore (plan §2, Process).
//!
//! ```text
//! <control_dir>/session-host/
//!   <version>+<build>/<slug>-session-host.exe   the copy a host runs from
//!   host.token                          the Hello secret, owner-only
//!   sessions.json                       name, cwd, created of each session
//! ```
//!
//! The copies live beside the sidecar's `bin/<version>/`, never inside it:
//! the sidecar's install prunes every other directory there and a phone
//! update would take the running host with it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::protocol::SessionInfo;

/// `<control_dir>/session-host`.
pub fn host_root(control_dir: &Path) -> PathBuf {
    control_dir.join("session-host")
}

/// The leaf name of the host's copy.
pub fn exe_name() -> String {
    format!("{}-session-host.exe", crate::brand::SLUG)
}

/// `<control_dir>/session-host/<version>/<exe>`.
pub fn copy_path(control_dir: &Path, version: &str) -> PathBuf {
    host_root(control_dir).join(version).join(exe_name())
}

pub fn token_path(control_dir: &Path) -> PathBuf {
    host_root(control_dir).join("host.token")
}

pub fn sessions_path(control_dir: &Path) -> PathBuf {
    host_root(control_dir).join("sessions.json")
}

/// A build's identity beside its version: the PE header's link timestamp
/// and the image's length, read from the first bytes of an `.exe`
/// (`head`, at least up to the COFF header) and its length. A byte-for-byte
/// copy has the identity of its source, so the desktop, the sidecar and a
/// host copy of one build agree; a rebuild of the same version does not.
/// `None` for anything that is not a PE image.
pub fn pe_build_id(head: &[u8], len: u64) -> Option<String> {
    if head.get(..2)? != b"MZ" {
        return None;
    }
    let off = u32::from_le_bytes(head.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if head.get(off..off.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let stamp = u32::from_le_bytes(head.get(off + 8..off + 12)?.try_into().ok()?);
    Some(format!("{stamp:08x}-{len:x}"))
}

/// [`pe_build_id`] of the file at `exe`.
pub fn read_build_id(exe: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(exe).ok()?;
    let len = file.metadata().ok()?.len();
    let mut head = Vec::with_capacity(4096);
    file.take(4096).read_to_end(&mut head).ok()?;
    pe_build_id(&head, len)
}

/// `<version>+<build>` (semver build metadata), or the bare version when the
/// build is unknown: what a host reports as its version and names its copy's
/// directory by.
pub fn identity(version: &str, build: Option<&str>) -> String {
    match build {
        Some(b) => format!("{version}+{b}"),
        None => version.to_string(),
    }
}

/// An identity's version and build parts.
fn split_identity(id: &str) -> (&str, Option<&str>) {
    match id.split_once('+') {
        Some((v, b)) => (v, Some(b)),
        None => (id, None),
    }
}

/// A dotted numeric version (`0.2.70`, build metadata ignored); `None` for
/// anything else.
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = split_identity(v).0.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

/// Whether `a` is a strictly older version than `b` (builds ignored).
/// Unparseable is never older: an unknown directory or answer is left alone.
pub fn version_older(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

/// Whether `a` and `b` are the same parseable version (builds ignored).
fn same_version(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Some(a), Some(b)) if a == b)
}

/// Whether a client of identity `ours` retires a running host of `host`
/// (asking `Shutdown{if_idle}`): an older version, or the same version of
/// another known build (a dev rebuild). A newer host is used as it is — the
/// protocol negotiation already picked a level both speak — so a desktop and
/// a sidecar of two versions never take turns restarting it.
pub fn should_retire(host: &str, ours: &str) -> bool {
    if version_older(host, ours) {
        return true;
    }
    let (Some(host_build), Some(our_build)) = (split_identity(host).1, split_identity(ours).1) else { return false };
    same_version(host, ours) && host_build != our_build
}

/// The copy directories a prune removes: those of an older version, or of
/// another build of our version, except `ours` and any in `running` (a host
/// still serving out of it). Newer or unparseable names stay: a newer client
/// may be about to start its copy.
pub fn prunable<'a>(dirs: impl IntoIterator<Item = &'a str>, ours: &str, running: &[&str]) -> Vec<String> {
    dirs.into_iter()
        .filter(|d| *d != ours && !running.contains(d))
        .filter(|d| version_older(d, ours) || same_version(d, ours))
        .map(str::to_string)
        .collect()
}

/// One entry of `sessions.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedSession {
    pub name: String,
    pub cwd: Option<String>,
    /// Unix milliseconds.
    pub created: u64,
}

/// The `sessions.json` bytes for `sessions`, sorted by name so an unchanged
/// set writes the same bytes.
pub fn sessions_json(sessions: &[SessionInfo]) -> Vec<u8> {
    let mut saved: Vec<SavedSession> = sessions
        .iter()
        .map(|s| SavedSession { name: s.name.clone(), cwd: s.cwd.clone(), created: s.created })
        .collect();
    saved.sort_by(|a, b| a.name.cmp(&b.name));
    serde_json::to_vec_pretty(&saved).unwrap_or_else(|_| b"[]".to_vec())
}

/// Reads a `sessions.json` back; a missing or unreadable file is no sessions.
pub fn read_sessions(path: &Path) -> Vec<SavedSession> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_and_unknown_is_never_older() {
        assert!(version_older("0.2.9", "0.2.10"));
        assert!(version_older("0.2", "0.2.1"));
        assert!(!version_older("0.2.10", "0.2.9"));
        assert!(!version_older("0.2.10", "0.2.10"));
        assert!(!version_older("dev", "0.2.10"));
        assert!(!version_older("0.2.10", "dev"));
        assert!(!version_older("", "1"));
    }

    #[test]
    fn only_an_older_host_is_retired() {
        assert!(should_retire("0.2.69", "0.2.70"));
        assert!(!should_retire("0.2.70", "0.2.70"));
        assert!(!should_retire("0.2.71", "0.2.70"));
    }

    #[test]
    fn a_build_is_the_pe_link_stamp_and_length() {
        let mut head = vec![0u8; 0x100];
        head[..2].copy_from_slice(b"MZ");
        head[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        head[0x80..0x84].copy_from_slice(b"PE\0\0");
        head[0x88..0x8c].copy_from_slice(&0x6543_21abu32.to_le_bytes());
        assert_eq!(pe_build_id(&head, 0x1000).as_deref(), Some("654321ab-1000"));
        assert_eq!(pe_build_id(&head[..0x8a], 1), None, "cut short");
        assert_eq!(pe_build_id(b"#!/bin/sh", 9), None);
        head[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(pe_build_id(&head, 1), None);
        assert_eq!(identity("1.2.3", Some("ab-1")), "1.2.3+ab-1");
        assert_eq!(identity("1.2.3", None), "1.2.3");
    }

    #[test]
    fn another_build_of_our_version_is_retired_and_pruned() {
        assert!(should_retire("0.2.70+aa-1", "0.2.70+bb-1"));
        assert!(!should_retire("0.2.70+aa-1", "0.2.70+aa-1"));
        assert!(!should_retire("0.2.70", "0.2.70+bb-1"), "an unknown build is left alone");
        assert!(!should_retire("0.2.71+aa-1", "0.2.70+bb-1"));
        assert!(should_retire("0.2.69+bb-1", "0.2.70+bb-1"));
        let dirs = ["0.2.70+aa-1", "0.2.70+bb-1", "0.2.70+cc-1", "0.2.70", "0.2.71+aa-1", "0.2.69+zz-1"];
        assert_eq!(
            prunable(dirs, "0.2.70+bb-1", &["0.2.70+cc-1"]),
            vec!["0.2.70+aa-1".to_string(), "0.2.70".to_string(), "0.2.69+zz-1".to_string()]
        );
    }

    #[test]
    fn this_test_binary_has_a_build_identity_on_windows() {
        let id = read_build_id(&std::env::current_exe().unwrap());
        assert_eq!(id.is_some(), cfg!(windows), "{id:?}");
    }

    #[test]
    fn a_prune_skips_ours_the_running_copy_newer_and_unknown_names() {
        let dirs = ["0.2.60", "0.2.68", "0.2.69", "0.2.70", "0.2.71", "notes"];
        assert_eq!(prunable(dirs, "0.2.70", &["0.2.68"]), vec!["0.2.60".to_string(), "0.2.69".to_string()]);
    }

    #[test]
    fn the_layout_sits_beside_the_sidecars_bin() {
        let control = Path::new("ctl");
        assert_eq!(copy_path(control, "1.2.3"), control.join("session-host").join("1.2.3").join(exe_name()));
        assert!(!copy_path(control, "1.2.3").starts_with(control.join("bin")));
        assert!(exe_name().ends_with("-session-host.exe"));
    }

    #[test]
    fn sessions_json_keeps_name_cwd_created_sorted() {
        let info = |name: &str, created| SessionInfo {
            name: name.into(),
            created,
            activity: 9,
            attached: 1,
            cwd: Some(format!("/{name}")),
            argv: vec!["x".into()],
            dead: false,
        };
        let bytes = sessions_json(&[info("b", 2), info("a", 1)]);
        let back: Vec<SavedSession> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            back,
            vec![
                SavedSession { name: "a".into(), cwd: Some("/a".into()), created: 1 },
                SavedSession { name: "b".into(), cwd: Some("/b".into()), created: 2 },
            ]
        );
        assert_eq!(bytes, sessions_json(&[info("a", 1), info("b", 2)]));
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("sessions.json");
        assert!(read_sessions(&path).is_empty());
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(read_sessions(&path), back);
    }
}

//! The API proxy's remembered port, when someone else holds it (gap 50b).
//!
//! The proxy binds the port of its last run again, so a keyed agent that
//! outlived a crash — in a tmux session, with the old base URL in its
//! environment — still reaches the proxy's refusal of its dead token. When the
//! port is *taken* at the next start, that agent's requests, conversation
//! included, go to whoever holds it: a fenced agent that survived the crash, or
//! another account. The proxy cannot take the port, so it binds another one —
//! and says so, instead of quietly moving on:
//!
//! * the holder is looked up (`loopback_owner::occupants`);
//! * unless it is another instance of this program, the app's tmux sessions
//!   whose environment names the old port are **ended**: each of those agents
//!   would send its next request to the holder;
//! * a [`PortNotice`] is written for the window to show once
//!   (`api_proxy_port_notice`, acknowledged with `api_proxy_port_notice_ack`).
//!
//! Where the holder cannot be told (macOS, Windows, or a listener that is
//! gone again) nothing is ended, but the notice is still written. `AppHandle`
//! free; the matching and classifying are pure.

use serde::{Deserialize, Serialize};

use crate::services::loopback_owner::Occupant;

/// Who holds the remembered port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Holder {
    /// This account's, in another pid namespace: a fenced agent.
    Fenced,
    /// Another account's.
    OtherAccount,
    /// This account's, outside any fence, and not this program.
    OtherProcess,
    /// Not told (not Linux, or the listener is gone again).
    Unknown,
}

/// What the window shows once, from `<state_dir>/api-proxy-port-notice.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortNotice {
    /// Unix seconds.
    pub ts: u64,
    /// The remembered port that was taken.
    pub port: u16,
    /// The port bound instead.
    pub new_port: u16,
    pub holder: Holder,
    /// The tmux sessions ended because they named the taken port.
    #[serde(default)]
    pub ended: Vec<String>,
    /// Those that could not be ended.
    #[serde(default)]
    pub failed: Vec<String>,
}

fn notice_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("api-proxy-port-notice.json")
}

/// The pending notice, if any.
pub fn read_notice() -> Option<PortNotice> {
    crate::storage::read_json(&notice_path()).ok()
}

/// The user saw it.
pub fn ack_notice() {
    let _ = std::fs::remove_file(notice_path());
}

/// Who holds the port, from what [`loopback_owner::occupants`] found. `None`
/// when the only holders are other instances of this program (nothing to end,
/// nothing to say). Pure.
pub fn classify(occupants: &[Occupant], own_uid: u32) -> Option<Holder> {
    if occupants.is_empty() {
        return Some(Holder::Unknown);
    }
    if occupants.iter().all(|o| o.uid == own_uid && o.same_program && !o.fenced) {
        return None;
    }
    Some(if occupants.iter().any(|o| o.fenced) {
        Holder::Fenced
    } else if occupants.iter().any(|o| o.uid != own_uid) {
        Holder::OtherAccount
    } else {
        Holder::OtherProcess
    })
}

/// Whether `text` — a tmux session environment or a launcher script — names a
/// proxy base URL on `port` in one of the CLIs' base-URL variables. Pure.
pub fn names_port(text: &str, port: u16) -> bool {
    use crate::services::agent_api_keys::{ANTHROPIC_BASE_ENV, GEMINI_BASE_ENV, OPENAI_BASE_ENV};
    let base = format!("http://127.0.0.1:{port}/");
    text.lines().any(|line| {
        let line = line.trim_start().trim_start_matches("export ");
        [ANTHROPIC_BASE_ENV, GEMINI_BASE_ENV, OPENAI_BASE_ENV]
            .iter()
            .any(|var| line.strip_prefix(var).and_then(|rest| rest.strip_prefix('=')).is_some_and(|v| v.trim_matches(['\'', '"']).starts_with(&base)))
    })
}

/// The app's local tmux sessions whose environment names `port`.
fn keyed_sessions(port: u16) -> Vec<String> {
    use crate::services::tmux_local;
    if !tmux_local::tmux_available() {
        return Vec::new();
    }
    let Ok(listed) = tmux_local::tmux_command().args(["ls", "-F", "#{session_name}"]).output() else { return Vec::new() };
    if !listed.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&listed.stdout)
        .lines()
        .filter(|name| tmux_local::is_app_local_tmux_session(name))
        .filter(|name| {
            let environment = tmux_local::tmux_command()
                .args(["show-environment", "-t", name])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            names_port(&environment, port) || tmux_local::launcher_text(name).is_some_and(|t| names_port(&t, port))
        })
        .map(str::to_string)
        .collect()
}

/// The remembered `port` could not be bound and `new_port` was. Ends the
/// sessions that name `port` unless its holder is only another instance of
/// this program, and writes the notice. Blocking (a `tmux` call per session):
/// the start path, once, and only in this rare case.
pub fn on_fallback(port: u16, new_port: u16) {
    let holder = {
        #[cfg(unix)]
        // SAFETY: getuid has no preconditions.
        let own = unsafe { libc::getuid() };
        #[cfg(not(unix))]
        let own = u32::MAX;
        classify(&crate::services::loopback_owner::occupants(port), own)
    };
    let Some(holder) = holder else { return };
    let (mut ended, mut failed) = (Vec::new(), Vec::new());
    if holder != Holder::Unknown {
        for name in keyed_sessions(port) {
            let killed = crate::services::tmux_local::tmux_command()
                .args(crate::services::tmux_local::local_tmux_kill_args(&name))
                .output()
                .is_ok_and(|o| o.status.success());
            crate::services::tmux_local::remove_launcher(&name);
            if killed {
                crate::services::api_proxy::on_tmux_session_gone(&name);
                ended.push(name);
            } else {
                failed.push(name);
            }
        }
    }
    eprintln!("[api-proxy] port {port} is held by {holder:?}; serving on {new_port}; ended {} agent session(s)", ended.len());
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = crate::storage::write_json_atomic(&notice_path(), &PortNotice { ts, port, new_port, holder, ended, failed });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occupant(uid: u32, fenced: bool, same_program: bool) -> Occupant {
        Occupant { uid, fenced, same_program, identified: true }
    }

    #[test]
    fn classifies_who_holds_the_port() {
        assert_eq!(classify(&[], 1000), Some(Holder::Unknown));
        assert_eq!(classify(&[occupant(1000, false, true)], 1000), None, "another instance of this program");
        assert_eq!(classify(&[occupant(1000, true, false)], 1000), Some(Holder::Fenced));
        assert_eq!(classify(&[occupant(1000, true, true)], 1000), Some(Holder::Fenced), "the program's name is no pass in a fence");
        assert_eq!(classify(&[occupant(1001, false, false)], 1000), Some(Holder::OtherAccount));
        assert_eq!(classify(&[occupant(1000, false, false)], 1000), Some(Holder::OtherProcess));
        assert_eq!(classify(&[occupant(1000, false, true), occupant(1001, false, false)], 1000), Some(Holder::OtherAccount));
    }

    #[test]
    fn finds_a_session_that_names_the_port() {
        assert!(names_port("ANTHROPIC_BASE_URL=http://127.0.0.1:41234/anthropic\nHOME=/h\n", 41234));
        assert!(names_port("export GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:41234/gemini'\nexec 'claude'\n", 41234));
        assert!(names_port("OPENAI_BASE_URL=http://127.0.0.1:41234/openai\n", 41234));
        assert!(!names_port("ANTHROPIC_BASE_URL=http://127.0.0.1:41235/anthropic\n", 41234));
        assert!(!names_port("ANTHROPIC_BASE_URL=http://127.0.0.1:412345/anthropic\n", 41234), "a longer port is another port");
        assert!(!names_port("NOTE=http://127.0.0.1:41234/anthropic\n", 41234), "only the base-URL variables count");
        assert!(!names_port("-ANTHROPIC_BASE_URL\n", 41234));
    }

    #[test]
    fn the_notice_round_trips_and_older_shapes_read() {
        let notice = PortNotice { ts: 7, port: 41234, new_port: 41300, holder: Holder::OtherAccount, ended: vec!["s-1".into()], failed: vec![] };
        let json = serde_json::to_string(&notice).unwrap();
        assert!(json.contains("\"newPort\":41300") && json.contains("\"holder\":\"otherAccount\""), "{json}");
        assert_eq!(serde_json::from_str::<PortNotice>(&json).unwrap(), notice);
        let bare: PortNotice = serde_json::from_str(r#"{"ts":1,"port":2,"newPort":3,"holder":"fenced"}"#).unwrap();
        assert!(bare.ended.is_empty() && bare.failed.is_empty());
    }
}

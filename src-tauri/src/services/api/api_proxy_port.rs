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
//!
//! A server daemon's agent-tools listener (`commands::root_mcp`, every MCP
//! lane) keeps its port the same way ([`Service::AgentTools`]): a server's
//! tabs live in the tmux unit across a daemon restart (an update restarts
//! every server service), each still naming the old port in its MCP URLs, and
//! every account on the box shares the loopback — a tenant who took the port
//! in the gap would get their tool calls and could answer them. Its notice has
//! a file of its own and the same dialog.

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

/// Whose remembered port was taken.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Service {
    /// The API proxy (`services::api_proxy`).
    #[default]
    ApiProxy,
    /// A server daemon's agent MCP listener (`commands::root_mcp`).
    AgentTools,
}

impl Service {
    fn notice_file(self) -> &'static str {
        match self {
            Service::ApiProxy => "api-proxy-port-notice.json",
            Service::AgentTools => "agent-tools-port-notice.json",
        }
    }

    /// Whether `text` (a tmux session environment or launcher script) points
    /// an agent at this service on `port`. Pure.
    pub fn named_in(self, text: &str, port: u16) -> bool {
        match self {
            Service::ApiProxy => names_port(text, port),
            Service::AgentTools => names_tools_port(text, port),
        }
    }
}

/// The order notices are shown (and acknowledged) in.
const SERVICES: [Service; 2] = [Service::ApiProxy, Service::AgentTools];

/// What the window shows once, from `<state_dir>/api-proxy-port-notice.json`
/// (or the agent tools' own file, [`Service::notice_file`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortNotice {
    /// Whose port it was; an older notice (no field) is the API proxy's.
    #[serde(default)]
    pub service: Service,
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

fn notice_path(service: Service) -> std::path::PathBuf {
    crate::storage::state_dir().join(service.notice_file())
}

/// The pending notice, if any: the API proxy's first.
pub fn read_notice() -> Option<PortNotice> {
    SERVICES.iter().find_map(|s| crate::storage::read_json(&notice_path(*s)).ok())
}

/// The user saw it: the one [`read_notice`] answers goes.
pub fn ack_notice() {
    if let Some(service) = SERVICES.into_iter().find(|s| notice_path(*s).is_file()) {
        let _ = std::fs::remove_file(notice_path(service));
    }
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

/// Whether `text` names an agent MCP URL on `port`
/// (`http://127.0.0.1:<port>/mcp…`, as every lane's `*_MCP_URL` variable and a
/// CLI's MCP config spell it). The `/mcp` right after the port keeps a longer
/// port from matching. Pure.
pub fn names_tools_port(text: &str, port: u16) -> bool {
    text.contains(&format!("//127.0.0.1:{port}/mcp"))
}

/// The app's local tmux sessions whose environment names `port` for `service`.
fn keyed_sessions(service: Service, port: u16) -> Vec<String> {
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
            service.named_in(&environment, port) || tmux_local::launcher_text(name).is_some_and(|t| service.named_in(&t, port))
        })
        .map(str::to_string)
        .collect()
}

/// The API proxy's remembered `port` could not be bound and `new_port` was.
/// Ends the sessions that name `port` unless its holder is only another
/// instance of this program, and writes the notice. Blocking (a `tmux` call
/// per session): the start path, once, and only in this rare case.
pub fn on_fallback(port: u16, new_port: u16) {
    on_fallback_for(Service::ApiProxy, port, new_port);
}

/// [`on_fallback`] for `service`.
pub fn on_fallback_for(service: Service, port: u16, new_port: u16) {
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
        for name in keyed_sessions(service, port) {
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
    let tag = match service {
        Service::ApiProxy => "api-proxy",
        Service::AgentTools => "root-mcp",
    };
    eprintln!("[{tag}] port {port} is held by {holder:?}; serving on {new_port}; ended {} agent session(s)", ended.len());
    let ts = crate::clock::now_secs();
    let notice = PortNotice { service, ts, port, new_port, holder, ended, failed };
    let _ = crate::storage::write_json_atomic(&notice_path(service), &notice);
}

/// A remembered port from the one-line file at `path`; `0`, junk or no file
/// is none.
pub fn remembered_in(path: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p != 0)
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
        let notice = PortNotice { service: Service::AgentTools, ts: 7, port: 41234, new_port: 41300, holder: Holder::OtherAccount, ended: vec!["s-1".into()], failed: vec![] };
        let json = serde_json::to_string(&notice).unwrap();
        assert!(json.contains("\"newPort\":41300") && json.contains("\"holder\":\"otherAccount\""), "{json}");
        assert!(json.contains("\"service\":\"agentTools\""), "{json}");
        assert_eq!(serde_json::from_str::<PortNotice>(&json).unwrap(), notice);
        let bare: PortNotice = serde_json::from_str(r#"{"ts":1,"port":2,"newPort":3,"holder":"fenced"}"#).unwrap();
        assert!(bare.ended.is_empty() && bare.failed.is_empty());
        assert_eq!(bare.service, Service::ApiProxy, "a notice an older build wrote is the API proxy's");
    }

    #[test]
    fn finds_a_session_whose_mcp_urls_name_the_tools_port() {
        let env = "X_ROOT_MCP_URL=http://127.0.0.1:41234/mcp\nHOME=/h\n";
        assert!(Service::AgentTools.named_in(env, 41234));
        assert!(Service::AgentTools.named_in("export X_HELP_MCP_URL='http://127.0.0.1:41234/mcp/help'\n", 41234));
        assert!(Service::AgentTools.named_in(r#"exec claude --mcp-config '{"mcpServers":{"t":{"type":"http","url":"http://127.0.0.1:41234/mcp/git"}}}'"#, 41234));
        assert!(!Service::AgentTools.named_in("X_ROOT_MCP_URL=http://127.0.0.1:412345/mcp\n", 41234), "a longer port is another port");
        assert!(!Service::AgentTools.named_in("X_ROOT_MCP_URL=http://127.0.0.1:41235/mcp\n", 41234));
        assert!(!Service::AgentTools.named_in("ANTHROPIC_BASE_URL=http://127.0.0.1:41234/anthropic\n", 41234), "the proxy's port is not the tools'");
        assert!(!Service::ApiProxy.named_in(env, 41234), "nor the other way round");
    }

    #[test]
    fn a_remembered_port_is_a_real_port_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("port");
        assert_eq!(remembered_in(&file), None);
        std::fs::write(&file, "41234\n").unwrap();
        assert_eq!(remembered_in(&file), Some(41234));
        for junk in ["0", "", "x", "70000"] {
            std::fs::write(&file, junk).unwrap();
            assert_eq!(remembered_in(&file), None, "{junk:?}");
        }
    }
}

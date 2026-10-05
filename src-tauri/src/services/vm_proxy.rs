//! The project-VM egress proxy (`docs/vm_projects_plan.md`, Phase 4): a small
//! allowlisting HTTP CONNECT proxy bound to localhost, reached from inside the
//! guest through a slirp `guestfwd` channel at a fixed guest-side address
//! ([`GUEST_PROXY_ADDR`]). Under the default `Proxy` egress mode the guest's
//! slirp is `restrict=on`, so this proxy is the **only** route out of the VM —
//! which is exactly what makes its deny log an exfiltration tripwire: an agent
//! probing anywhere unexpected shows up as blocked CONNECTs in the pill.
//!
//! Deliberately CONNECT-only: every allowlisted endpoint speaks TLS, so
//! tunneling is all the guest needs, and refusing plain-HTTP forwarding keeps
//! this from ever being a general web proxy. The honest limit (stated in the
//! UI, not hidden here): an agent can still exfiltrate *to the allowed
//! endpoints* — e.g. inside a model prompt. Proxy narrows the channel; it
//! cannot close it while a cloud agent runs.
//!
//! Threads, not tokio: VM egress is a handful of long-lived agent-API
//! connections, not a fan-out workload, and a thread per tunnel keeps the
//! module free of any runtime handle (bootable from `spawn_blocking`).

use crate::brand::SLUG;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Where the guest reaches the proxy: a fixed address on the slirp subnet that
/// `guestfwd` maps to the host-side listener's (ephemeral) port. Fixed so the
/// proxy env baked into the guest by cloud-init never changes across boots —
/// the *host* port moves, the guest-visible one does not.
// QEMU slirp's synthetic guest subnet: identical on every machine, reachable
// only from inside the emulator, and names no real host.
pub const GUEST_PROXY_ADDR: &str = "10.0.2.100:3128"; // privacy-check: ok — QEMU slirp, not a real host

/// The built-in allowlist: the cloud agents' own API/auth endpoints. Exact
/// hostnames, or `.suffix` entries matching any subdomain. Deliberately does
/// NOT include code-hosting sites — `github.com` is the separate per-project
/// opt-in ([`GITHUB_ALLOW`], `VmSpec::allow_github`).
pub const DEFAULT_ALLOW: &[&str] = &[
    // Anthropic (Claude Code)
    "api.anthropic.com",
    "console.anthropic.com",
    "statsig.anthropic.com",
    "claude.ai",
    // OpenAI (Codex)
    "api.openai.com",
    "auth.openai.com",
    "chatgpt.com",
    // Google (Gemini CLI)
    "generativelanguage.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
];

/// What `VmSpec::allow_github` adds: the hosts a `git clone`/`git push` against
/// GitHub actually touches.
pub const GITHUB_ALLOW: &[&str] = &[
    "github.com",
    "api.github.com",
    "codeload.github.com",
    ".githubusercontent.com",
];

/// One denied CONNECT, for the pill's blocked-connections log.
#[derive(Debug, Clone, Serialize)]
pub struct BlockedConnect {
    /// The `host:port` the guest asked for (or a short reason for a malformed
    /// request).
    pub target: String,
    /// Seconds since the proxy started when the denial happened (relative —
    /// the frontend renders "n min ago"; an absolute clock adds nothing).
    pub at_secs: u64,
}

/// Report for the pill / VM settings dialog: total denials plus the most
/// recent entries.
#[derive(Debug, Clone, Serialize, Default)]
pub struct BlockedReport {
    pub total: u64,
    pub recent: Vec<BlockedConnect>,
}

const BLOCKED_LOG_CAP: usize = 64;

struct ProxyShared {
    /// Standing allowlist (rebuilt from the spec on every boot / spec save).
    allow: Mutex<Vec<String>>,
    /// Temporary allows (`host`, expiry) — the clone-at-creation channel.
    temp_allow: Mutex<Vec<(String, Instant)>>,
    blocked: Mutex<VecDeque<BlockedConnect>>,
    blocked_total: AtomicU64,
    started: Instant,
    stop: AtomicBool,
}

struct ProxyHandle {
    port: u16,
    shared: Arc<ProxyShared>,
}

fn proxies() -> &'static Mutex<HashMap<String, ProxyHandle>> {
    static PROXIES: OnceLock<Mutex<HashMap<String, ProxyHandle>>> = OnceLock::new();
    PROXIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The standing allowlist for a spec: built-ins + the GitHub set (opt-in) +
/// the user's extra hosts. Pure, so the composition is testable.
pub fn allowlist_for(allow_hosts: &[String], allow_github: bool) -> Vec<String> {
    let mut list: Vec<String> = DEFAULT_ALLOW.iter().map(|s| s.to_string()).collect();
    if allow_github {
        list.extend(GITHUB_ALLOW.iter().map(|s| s.to_string()));
    }
    for host in allow_hosts {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if !host.is_empty() && !list.contains(&host) {
            list.push(host);
        }
    }
    list
}

/// Whether `host` matches the allowlist: an exact entry, or a `.suffix` entry
/// matching the host itself or any subdomain of it. Case-insensitive; a
/// trailing dot on the asked host (DNS root form) is normalized away.
pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    allow.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        if let Some(suffix) = entry.strip_prefix('.') {
            host == suffix || host.ends_with(&format!(".{suffix}"))
        } else {
            host == entry
        }
    })
}

/// Parse the request line of a CONNECT request: `CONNECT host:port HTTP/1.x`
/// → `(host, port)`. `None` for anything else (including plain-HTTP proxy
/// forms, which this proxy refuses by design).
pub fn parse_connect_line(line: &str) -> Option<(String, u16)> {
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let target = parts.next()?;
    // IPv6 literal form `[::1]:443` — not something the allowlist can ever
    // match (it holds names), but parse it so the denial names the target.
    let (host, port) = if let Some(rest) = target.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        (host.to_string(), port)
    } else {
        let (host, port) = target.rsplit_once(':')?;
        (host.to_string(), port)
    };
    let port: u16 = port.parse().ok()?;
    Some((host, port))
}

/// Start (or reuse) the egress proxy for a project, with the given standing
/// allowlist. Returns the localhost port the `guestfwd` should target.
/// Idempotent: a live proxy just has its allowlist replaced.
pub fn ensure_proxy(project_id: &str, allow: Vec<String>) -> Result<u16, String> {
    let mut map = proxies().lock().unwrap();
    if let Some(handle) = map.get(project_id) {
        if !handle.shared.stop.load(Ordering::SeqCst) {
            *handle.shared.allow.lock().unwrap() = allow;
            return Ok(handle.port);
        }
        map.remove(project_id);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("VM egress proxy: bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("VM egress proxy: local_addr: {e}"))?
        .port();
    let shared = Arc::new(ProxyShared {
        allow: Mutex::new(allow),
        temp_allow: Mutex::new(Vec::new()),
        blocked: Mutex::new(VecDeque::new()),
        blocked_total: AtomicU64::new(0),
        started: Instant::now(),
        stop: AtomicBool::new(false),
    });

    let accept_shared = Arc::clone(&shared);
    std::thread::Builder::new()
        .name(format!(
            "vm-proxy-{}",
            &project_id[..project_id.len().min(8)]
        ))
        .spawn(move || accept_loop(listener, accept_shared))
        .map_err(|e| format!("VM egress proxy: spawn failed: {e}"))?;

    map.insert(project_id.to_string(), ProxyHandle { port, shared });
    Ok(port)
}

/// Stop a project's proxy (VM shutdown). Live tunnels are left to drain — the
/// VM going down closes their guest side anyway.
pub fn stop_proxy(project_id: &str) {
    let mut map = proxies().lock().unwrap();
    if let Some(handle) = map.remove(project_id) {
        handle.shared.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept() so the loop observes the flag.
        let _ = TcpStream::connect(("127.0.0.1", handle.port));
    }
}

/// Replace a live proxy's standing allowlist (VM settings save). No-op when no
/// proxy is running — the next boot builds the list from the saved spec.
pub fn set_allowlist(project_id: &str, allow: Vec<String>) {
    let map = proxies().lock().unwrap();
    if let Some(handle) = map.get(project_id) {
        *handle.shared.allow.lock().unwrap() = allow;
    }
}

/// Temporarily allow one extra host (e.g. the git host of a clone URL during
/// project creation). Expires by wall-clock; never persisted.
pub fn allow_temporarily(project_id: &str, host: &str, duration: Duration) {
    let map = proxies().lock().unwrap();
    if let Some(handle) = map.get(project_id) {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return;
        }
        handle
            .shared
            .temp_allow
            .lock()
            .unwrap()
            .push((host, Instant::now() + duration));
    }
}

/// A live proxy's standing allowlist and how many temporary allows are still
/// in force — what `services::mail_reader` checks per mail call. `None` when no
/// proxy runs for the project.
pub fn live_state(project_id: &str) -> Option<(Vec<String>, usize)> {
    let map = proxies().lock().unwrap();
    let handle = map.get(project_id)?;
    let allow = handle.shared.allow.lock().unwrap().clone();
    let now = Instant::now();
    let temp = handle.shared.temp_allow.lock().unwrap().iter().filter(|(_, until)| *until > now).count();
    Some((allow, temp))
}

/// The blocked-connections report for the pill / settings dialog.
pub fn blocked_report(project_id: &str) -> BlockedReport {
    let map = proxies().lock().unwrap();
    match map.get(project_id) {
        Some(handle) => BlockedReport {
            total: handle.shared.blocked_total.load(Ordering::SeqCst),
            recent: handle
                .shared
                .blocked
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect(),
        },
        None => BlockedReport::default(),
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<ProxyShared>) {
    loop {
        let conn = listener.accept();
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok((stream, _)) = conn else {
            // A failing `accept()` (fd exhaustion, most plausibly) returns
            // immediately, so retrying it bare is a hot loop on a thread nobody
            // is watching. Back off a little and try again — the condition is
            // transient, and the listener is the VM's only route out.
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        let conn_shared = Arc::clone(&shared);
        let _ = std::thread::Builder::new()
            .name("vm-proxy-conn".to_string())
            .spawn(move || handle_conn(stream, conn_shared));
    }
}

fn record_blocked(shared: &ProxyShared, target: String) {
    shared.blocked_total.fetch_add(1, Ordering::SeqCst);
    let mut log = shared.blocked.lock().unwrap();
    if log.len() >= BLOCKED_LOG_CAP {
        log.pop_front();
    }
    log.push_back(BlockedConnect {
        target,
        at_secs: shared.started.elapsed().as_secs(),
    });
}

fn deny(mut stream: TcpStream, status: &str) {
    let _ = stream.write_all(
        format!("HTTP/1.1 {status}\r\nProxy-Agent: {SLUG}-vm\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    );
}

fn handle_conn(mut stream: TcpStream, shared: Arc<ProxyShared>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));

    // Read the request head (request line + headers) up to a small cap. The
    // headers are discarded — CONNECT carries everything in its request line.
    let mut head = Vec::with_capacity(512);
    let mut buf = [0u8; 512];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if head.len() > 8192 {
                    deny(stream, "431 Request Header Fields Too Large");
                    return;
                }
            }
            Err(_) => return,
        }
    }
    let line = head
        .split(|&b| b == b'\r' || b == b'\n')
        .next()
        .map(|l| String::from_utf8_lossy(l).into_owned())
        .unwrap_or_default();

    let Some((host, port)) = parse_connect_line(&line) else {
        // Plain-HTTP proxying is refused by design (see module doc): log the
        // method+target so the tripwire still names what was attempted.
        let target = line
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        record_blocked(
            &shared,
            if target.is_empty() {
                "(malformed request)".into()
            } else {
                target
            },
        );
        deny(stream, "405 Method Not Allowed");
        return;
    };

    // Every built-in and user-configured endpoint is a TLS service. Restricting
    // the tunnel to HTTPS prevents an allowlisted hostname from becoming an SSH
    // or arbitrary-service escape hatch (for example `allowed-host:22`).
    let allowed = port == 443 && {
        let standing = shared.allow.lock().unwrap();
        if host_allowed(&host, &standing) {
            true
        } else {
            drop(standing);
            let mut temp = shared.temp_allow.lock().unwrap();
            let now = Instant::now();
            temp.retain(|(_, deadline)| *deadline > now);
            temp.iter()
                .any(|(h, _)| host_allowed(&host, std::slice::from_ref(h)))
        }
    };
    if !allowed {
        record_blocked(&shared, format!("{host}:{port}"));
        deny(stream, "403 Forbidden");
        return;
    }

    // Resolve + dial the real endpoint. `connect_timeout` needs a single
    // resolved addr, so resolve first (bounded implicitly by the OS).
    let upstream = format!("{host}:{port}")
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(15)).ok());
    let Some(upstream) = upstream else {
        deny(stream, "502 Bad Gateway");
        return;
    };

    let _ = stream.set_read_timeout(None);
    if stream
        .write_all(concat!("HTTP/1.1 200 Connection Established\r\nProxy-Agent: ", crate::app_slug!(), "-vm\r\n\r\n").as_bytes())
        .is_err()
    {
        return;
    }

    // Bidirectional byte pump: one extra thread for guest→upstream, this
    // thread for upstream→guest. Shutdown of one direction propagates by the
    // copy ending and `shutdown(Both)` closing the peer.
    let (mut guest_r, mut upstream_w) = match (stream.try_clone(), upstream.try_clone()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return,
    };
    let pump = std::thread::Builder::new()
        .name("vm-proxy-pump".to_string())
        .spawn(move || {
            let _ = std::io::copy(&mut guest_r, &mut upstream_w);
            let _ = upstream_w.shutdown(std::net::Shutdown::Both);
        });
    let (mut upstream_r, mut guest_w) = (upstream, stream);
    let _ = std::io::copy(&mut upstream_r, &mut guest_w);
    let _ = guest_w.shutdown(std::net::Shutdown::Both);
    if let Ok(handle) = pump {
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|s| s.to_string()).collect()
    }

    // ── host_allowed ───────────────────────────────────────────────────────

    #[test]
    fn exact_host_matches_case_insensitively() {
        let list = allow(&["api.anthropic.com"]);
        assert!(host_allowed("api.anthropic.com", &list));
        assert!(host_allowed("API.Anthropic.COM", &list));
        assert!(host_allowed("api.anthropic.com.", &list)); // DNS root form
        assert!(!host_allowed("evil-api.anthropic.com.example.org", &list));
    }

    #[test]
    fn exact_entry_never_matches_subdomains() {
        // An exact entry is exact: `github.com` must not admit `evil.github.com`
        // — subdomain admission is the `.suffix` form's explicit job.
        let list = allow(&["github.com"]);
        assert!(host_allowed("github.com", &list));
        assert!(!host_allowed("evil.github.com", &list));
    }

    #[test]
    fn dot_prefix_matches_domain_and_subdomains() {
        let list = allow(&[".githubusercontent.com"]);
        assert!(host_allowed("githubusercontent.com", &list));
        assert!(host_allowed("raw.githubusercontent.com", &list));
        // A suffix must match on a label boundary, not as a substring:
        assert!(!host_allowed("evilgithubusercontent.com", &list));
    }

    #[test]
    fn empty_host_is_denied() {
        assert!(!host_allowed("", &allow(&["a.example"])));
        assert!(!host_allowed("  ", &allow(&["a.example"])));
    }

    // ── allowlist_for ──────────────────────────────────────────────────────

    #[test]
    fn allowlist_composes_defaults_github_and_extras() {
        let list = allowlist_for(&["My.Extra.Host".to_string()], true);
        assert!(list.contains(&"api.anthropic.com".to_string()));
        assert!(list.contains(&"github.com".to_string()));
        assert!(list.contains(&"my.extra.host".to_string()));
        // Without the opt-in, no GitHub hosts:
        let bare = allowlist_for(&[], false);
        assert!(!bare.iter().any(|h| h.contains("github")));
    }

    // ── parse_connect_line ─────────────────────────────────────────────────

    #[test]
    fn parses_connect_and_refuses_other_methods() {
        assert_eq!(
            parse_connect_line("CONNECT api.anthropic.com:443 HTTP/1.1"),
            Some(("api.anthropic.com".to_string(), 443))
        );
        assert_eq!(
            parse_connect_line("connect example.org:8443 HTTP/1.0"),
            Some(("example.org".to_string(), 8443))
        );
        assert_eq!(parse_connect_line("GET http://example.org/ HTTP/1.1"), None);
        assert_eq!(parse_connect_line("CONNECT noport HTTP/1.1"), None);
        assert_eq!(parse_connect_line(""), None);
    }

    #[test]
    fn parses_ipv6_literal_target() {
        assert_eq!(
            parse_connect_line("CONNECT [::1]:443 HTTP/1.1"),
            Some(("::1".to_string(), 443))
        );
    }

    // ── end-to-end over a real socket ──────────────────────────────────────

    /// The status code of a proxy reply. Compared as a number, so a failing
    /// assert never echoes raw socket bytes into the test log.
    fn status(response: &str) -> Option<u16> {
        response.strip_prefix("HTTP/1.1 ")?.get(..3)?.parse().ok()
    }

    #[test]
    fn denies_disallowed_connect_and_reports_it() {
        let port = ensure_proxy("test-proxy-deny", allow(&["allowed.example"])).unwrap();
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        conn.write_all(b"CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        assert_eq!(status(&response), Some(403));
        let report = blocked_report("test-proxy-deny");
        assert_eq!(report.total, 1);
        assert_eq!(report.recent[0].target, "evil.example:443");
        stop_proxy("test-proxy-deny");
    }

    #[test]
    fn temporary_allow_admits_then_can_expire() {
        let port = ensure_proxy("test-proxy-temp", Vec::new()).unwrap();
        allow_temporarily("test-proxy-temp", "clone.example", Duration::from_secs(60));
        // The tunnel target doesn't resolve, so an admitted CONNECT answers 502
        // (dial failed) rather than 403 (denied) — which is the distinction
        // under test.
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        conn.write_all(b"CONNECT clone.example:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        assert_eq!(status(&response), Some(502));
        assert_eq!(blocked_report("test-proxy-temp").total, 0);
        stop_proxy("test-proxy-temp");
    }

    #[test]
    fn allowed_host_on_non_https_port_is_denied_and_reported() {
        let port = ensure_proxy("test-proxy-port", allow(&["allowed.example"])).unwrap();
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        conn.write_all(b"CONNECT allowed.example:22 HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        assert_eq!(status(&response), Some(403));
        assert_eq!(
            blocked_report("test-proxy-port").recent[0].target,
            "allowed.example:22"
        );
        stop_proxy("test-proxy-port");
    }

    #[test]
    fn plain_http_forwarding_is_refused() {
        let port = ensure_proxy("test-proxy-http", allow(&["allowed.example"])).unwrap();
        let mut conn = TcpStream::connect(("127.0.0.1", port)).unwrap();
        conn.write_all(b"GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        assert_eq!(status(&response), Some(405));
        stop_proxy("test-proxy-http");
    }
}

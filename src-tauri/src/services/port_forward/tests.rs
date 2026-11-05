//! No `ssh` runs here: a [`FakeMux`] records the argv a real one would get.
#![cfg_attr(windows, allow(dead_code))]

use std::cell::RefCell;
use std::collections::HashMap;

use super::*;

fn spec(user: Option<&str>, port: Option<u16>) -> RemoteSpec {
    RemoteSpec {
        user: user.map(str::to_string),
        host: "login.example.com".to_string(),
        port,
        remote_path: "/srv/project".to_string(),
        openvpn: None,
        auto_connect: None,
        key_auth: None,
        persist_sessions: None,
        vm: None,
        remote_only: None,
        label: Some("cluster-a".to_string()),
        extra: HashMap::new(),
    }
}

/// An absolute, whitespace-free socket path on every OS.
fn socket(name: &str) -> PathBuf {
    std::env::temp_dir().join("pf-tests").join(name)
}

struct FakeMux {
    alive: bool,
    runs: RefCell<Vec<Vec<String>>>,
    /// Answers for the next `run`s, front first; empty means success.
    answers: RefCell<Vec<Result<(), String>>>,
}

impl FakeMux {
    fn new() -> Self {
        Self { alive: true, runs: RefCell::new(Vec::new()), answers: RefCell::new(Vec::new()) }
    }
    fn ops(&self) -> Vec<String> {
        self.runs
            .borrow()
            .iter()
            .map(|args| args[args.iter().position(|a| a == "-O").unwrap() + 1].clone())
            .collect()
    }
}

impl Mux for FakeMux {
    fn alive(&self, _control_path: &Path) -> bool {
        self.alive
    }
    fn run(&self, args: Vec<String>) -> Result<(), String> {
        self.runs.borrow_mut().push(args);
        let mut answers = self.answers.borrow_mut();
        if answers.is_empty() { Ok(()) } else { answers.remove(0) }
    }
}

fn request<'a>(spec: &'a RemoteSpec, path: &Path, owner: &'a str, host: &'a str, port: u16) -> OpenRequest<'a> {
    OpenRequest {
        spec,
        control_path: path.to_path_buf(),
        project_id: "p1",
        host_id: "primary",
        owner,
        remote_host: host,
        remote_port: port,
    }
}

/// A fixed picker: the preferred port, or 40000 for "any".
fn fixed(preferred: u16) -> Option<u16> {
    Some(if preferred == 0 { 40000 } else { preferred })
}

#[test]
fn forward_argv_names_the_loopback_bind_and_the_literal_socket() {
    let path = socket("cm-abc");
    let args = forward_args(&spec(Some("alice"), None), &path, 8888, "localhost", 8888).unwrap();
    let joined = args.join(" ");
    assert!(joined.starts_with("-F none -o BatchMode=yes -o ControlMaster=no"), "{joined}");
    assert!(args.contains(&format!("ControlPath={}", path.to_string_lossy())));
    assert!(args.contains(&"ProxyCommand=false".to_string()));
    let o = args.iter().position(|a| a == "-O").unwrap();
    assert_eq!(&args[o..o + 4], ["-O", "forward", "-L", "127.0.0.1:8888:localhost:8888"]);
    assert_eq!(args.last().unwrap(), "alice@login.example.com");
    assert!(!args.iter().any(|a| a == "-p"));
    // Never a remote or SOCKS forward, and nothing that would clear the -L.
    assert!(!args.iter().any(|a| a == "-R" || a == "-D" || a.contains("ClearAllForwardings")));
}

#[test]
fn forward_argv_carries_the_ssh_port_when_there_is_one() {
    let args = forward_args(&spec(None, Some(2222)), &socket("cm-abc"), 9000, "node042", 8888).unwrap();
    let p = args.iter().position(|a| a == "-p").unwrap();
    assert_eq!(args[p + 1], "2222");
    assert_eq!(args.last().unwrap(), "login.example.com");
    assert!(args.contains(&"127.0.0.1:9000:node042:8888".to_string()));
}

#[test]
fn an_ipv6_remote_host_is_bracketed_in_the_forward() {
    assert_eq!(forward_spec(8888, "::1", 8888), "127.0.0.1:8888:[::1]:8888");
    let args = forward_args(&spec(None, None), &socket("cm-abc"), 8888, "::1", 8888).unwrap();
    assert!(args.contains(&"127.0.0.1:8888:[::1]:8888".to_string()));
}

#[test]
fn cancel_argv_is_the_same_forward_with_cancel() {
    let f = forward_args(&spec(None, Some(22)), &socket("cm-abc"), 8888, "localhost", 1234).unwrap();
    let c = cancel_args(&spec(None, Some(22)), &socket("cm-abc"), 8888, "localhost", 1234).unwrap();
    assert_eq!(f.len(), c.len());
    let diff: Vec<_> = f.iter().zip(&c).filter(|(a, b)| a != b).collect();
    assert_eq!(diff, vec![(&"forward".to_string(), &"cancel".to_string())]);
}

#[test]
fn a_template_or_relative_socket_path_is_refused() {
    assert!(forward_args(&spec(None, None), Path::new("cm-%C"), 1, "localhost", 1).is_err());
    assert!(forward_args(&spec(None, None), &socket("cm-%C"), 1, "localhost", 1).is_err());
}

#[test]
fn remote_hosts_are_validated_and_normalised() {
    assert_eq!(normalize_remote_host("localhost").unwrap(), "localhost");
    assert_eq!(normalize_remote_host(" node042 ").unwrap(), "node042");
    assert_eq!(normalize_remote_host("0.0.0.0").unwrap(), "127.0.0.1");
    assert_eq!(normalize_remote_host("::").unwrap(), "127.0.0.1");
    assert_eq!(normalize_remote_host("[::1]").unwrap(), "::1");
    // A `-`-leading host would be read as an ssh option.
    assert!(normalize_remote_host("-oProxyCommand=x").is_err());
    assert!(normalize_remote_host("-L").is_err());
    for bad in ["", "a b", "a/b", "a:b", "ho\nst", "a;b", "a,b", "[::1", "1:2:3"] {
        assert!(normalize_remote_host(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_local_port_picked_is_free_and_prefers_the_remotes_number() {
    let any = pick_local_port(0).unwrap();
    assert!(any > 0);
    // A taken preferred port falls back to another one.
    let held = std::net::TcpListener::bind((BIND_ADDRESS, 0)).unwrap();
    let taken = held.local_addr().unwrap().port();
    let other = pick_local_port(taken).unwrap();
    assert_ne!(other, taken);
    drop(held);
}

#[test]
fn bind_address_is_the_loopback_constant() {
    assert_eq!(BIND_ADDRESS, "127.0.0.1");
    let src = include_str!("../port_forward.rs");
    // Every -L spec is built by `forward_spec`, which starts with it.
    assert_eq!(src.matches("format!(\"{BIND_ADDRESS}:").count(), 1);
}

#[cfg(not(windows))]
#[test]
fn open_forwards_once_and_the_same_key_joins_it() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    let s = spec(Some("alice"), None);
    let path = socket("cm-abc");
    let first = open_via(&reg, &mux, &request(&s, &path, "p1:tab-a", "localhost", 8888), &fixed).unwrap();
    assert_eq!((first.local_port, first.reused), (8888, false));
    let second = open_via(&reg, &mux, &request(&s, &path, "p1:tab-b", "localhost", 8888), &fixed).unwrap();
    assert_eq!((second.local_port, second.reused, &second.id), (8888, true, &first.id));
    assert_eq!(mux.ops(), vec!["forward"], "the second open runs no ssh");
    // Another port is another forward.
    let other = open_via(&reg, &mux, &request(&s, &path, "p1:tab-a", "localhost", 6006), &fixed).unwrap();
    assert!(!other.reused);
    assert_eq!(reg.lock().unwrap().rows().len(), 2);
}

#[cfg(not(windows))]
#[test]
fn a_forward_ends_with_its_last_owner_tab() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    let s = spec(None, None);
    let path = socket("cm-abc");
    open_via(&reg, &mux, &request(&s, &path, "p1:a", "localhost", 8888), &fixed).unwrap();
    open_via(&reg, &mux, &request(&s, &path, "p1:b", "localhost", 8888), &fixed).unwrap();
    close_for_tab_via(&reg, &mux, "p1:a");
    assert_eq!(reg.lock().unwrap().rows().len(), 1, "tab b still needs it");
    assert_eq!(mux.ops(), vec!["forward"]);
    close_for_tab_via(&reg, &mux, "p1:b");
    assert!(reg.lock().unwrap().rows().is_empty());
    assert_eq!(mux.ops(), vec!["forward", "cancel"]);
    // A tab that never forwarded changes nothing.
    close_for_tab_via(&reg, &mux, "p1:zzz");
    assert_eq!(mux.ops().len(), 2);
}

#[cfg(not(windows))]
#[test]
fn stop_a_master_teardown_and_quit_each_cancel_what_they_own() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    let s = spec(None, None);
    let (a, b) = (socket("cm-a"), socket("cm-b"));
    let one = open_via(&reg, &mux, &request(&s, &a, "p1:t", "localhost", 1111), &fixed).unwrap();
    open_via(&reg, &mux, &request(&s, &a, "p1:t", "localhost", 2222), &fixed).unwrap();
    // A second host on another master.
    let mut other_spec = spec(None, None);
    other_spec.host = "gpu.example.com".to_string();
    open_via(&reg, &mux, &request(&other_spec, &b, "p1:u", "localhost", 3333), &fixed).unwrap();

    assert!(close_id_via(&reg, &mux, &one.id));
    assert!(!close_id_via(&reg, &mux, &one.id), "already stopped");
    assert!(!close_id_via(&reg, &mux, "not-a-number"));
    assert_eq!(reg.lock().unwrap().rows().len(), 2);

    close_for_master_via(&reg, &mux, &a);
    let rows = reg.lock().unwrap().rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].remote_port, 3333);

    close_all_via(&reg, &mux);
    assert!(reg.lock().unwrap().rows().is_empty());
    let cancels = mux.ops().iter().filter(|o| *o == "cancel").count();
    assert_eq!(cancels, 3, "every forward was cancelled exactly once");
}

#[cfg(not(windows))]
#[test]
fn a_dead_master_refuses_and_never_dials() {
    let reg = Mutex::new(Registry::new());
    let mut mux = FakeMux::new();
    let s = spec(None, None);
    let path = socket("cm-abc");
    open_via(&reg, &mux, &request(&s, &path, "p1:a", "localhost", 8888), &fixed).unwrap();
    mux.alive = false;
    let err = open_via(&reg, &mux, &request(&s, &path, "p1:a", "localhost", 8888), &fixed).unwrap_err();
    assert_eq!(err, PortForwardError::NotConnected);
    assert_eq!(err.wire(), "port-forward:not-connected");
    assert!(reg.lock().unwrap().rows().is_empty(), "a forward on a dead master is dropped");
    assert_eq!(mux.ops(), vec!["forward"], "no ssh ran for the refused open");
}

#[cfg(not(windows))]
#[test]
fn a_failed_bind_retries_once_on_a_fresh_port() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    mux.answers.borrow_mut().push(Err("mux_client_forward: forwarding request failed".to_string()));
    let s = spec(None, None);
    let opened = open_via(&reg, &mux, &request(&s, &socket("cm-abc"), "p1:a", "localhost", 8888), &fixed).unwrap();
    assert_eq!(opened.local_port, 40000);
    let runs = mux.runs.borrow();
    assert_eq!(runs.len(), 2);
    assert!(runs[0].contains(&"127.0.0.1:8888:localhost:8888".to_string()));
    assert!(runs[1].contains(&"127.0.0.1:40000:localhost:8888".to_string()));
}

#[cfg(not(windows))]
#[test]
fn two_failures_surface_the_error_and_register_nothing() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    mux.answers.borrow_mut().extend([Err("first".to_string()), Err("second".to_string())]);
    let s = spec(None, None);
    let err = open_via(&reg, &mux, &request(&s, &socket("cm-abc"), "p1:a", "localhost", 8888), &fixed).unwrap_err();
    assert_eq!(err, PortForwardError::Failed("second".to_string()));
    assert!(reg.lock().unwrap().rows().is_empty());
}

#[cfg(not(windows))]
#[test]
fn a_bad_host_or_port_never_reaches_ssh() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    let s = spec(None, None);
    let path = socket("cm-abc");
    assert!(matches!(
        open_via(&reg, &mux, &request(&s, &path, "p1:a", "-oProxyCommand=x", 8888), &fixed),
        Err(PortForwardError::Invalid(_))
    ));
    assert!(matches!(
        open_via(&reg, &mux, &request(&s, &path, "p1:a", "localhost", 0), &fixed),
        Err(PortForwardError::Invalid(_))
    ));
    assert!(mux.runs.borrow().is_empty());
}

#[cfg(windows)]
#[test]
fn windows_refuses_with_a_structured_error() {
    let reg = Mutex::new(Registry::new());
    let mux = FakeMux::new();
    let s = spec(None, None);
    let err = open_via(&reg, &mux, &request(&s, &socket("cm-abc"), "p1:a", "localhost", 8888), &fixed).unwrap_err();
    assert_eq!(err.wire(), "port-forward:unsupported-os");
    assert!(mux.runs.borrow().is_empty());
}

#[test]
fn the_registry_rows_hold_no_url_path_or_token() {
    let src = include_str!("../port_forward.rs");
    let row = &src[src.find("pub struct ForwardRow").unwrap()..];
    let row = &row[..row.find("\n}\n").unwrap()];
    for forbidden in ["url", "token", "path", "query"] {
        assert!(!row.to_ascii_lowercase().contains(forbidden), "ForwardRow mentions {forbidden}");
    }
}

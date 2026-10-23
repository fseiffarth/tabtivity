//! Whether a remote project's host tabs can be reached from the phone
//! (`docs/mobile_remote_host_tabs_plan.md`).
//!
//! A tab that runs on a remote host keeps its tmux session there, and the
//! phone reaches it only through the desktop's ControlMaster for that host —
//! never a connection of its own, never a prompt. Whether that master is
//! there, and which sessions the host's tmux holds, is found out here, in the
//! background: a catalog load runs under the `CatalogCache` mutex on the path
//! of every route and must not touch a socket or the network. The refresher
//! builds a [`HostLive`] snapshot off-lock and swaps it into the shared slot
//! the catalog reads (`CatalogCache::with_host_live`).
//!
//! What a round may touch is gated:
//! - no phone signed in (`AuthStore::has_live_session`): nothing at all, and
//!   the snapshot is emptied;
//! - no window up (nobody holds the timer lease): the socket file alone. Every
//!   mux connection, `ssh -O check` included, resets the master's
//!   `ControlPersist` countdown, so a probe every few seconds would keep alive
//!   forever a master the quitting window left behind. A real check happens
//!   at the terminal upgrade, a foreground act;
//! - a window up: `ssh -O check` on the literal socket, then — unless the
//!   host is tagged HPC (`hpc_hosts`) — `tmux ls` over the master. A `tmux
//!   ls` that fails keeps the last answer for at most [`CARRY_FORWARD`].

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use app_core::sync::LockExt;
use serde_json::Value;

use super::auth::AuthStore;
use crate::schema::project::RemoteSpec;
use crate::services::ssh_exec;

/// One host the last round found reachable: the desktop's master answers (or,
/// with no window, its socket is there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostReach {
    /// The literal socket path of the desktop's master for this host
    /// (`ssh_exec::resolve_control_path`). Raw; never crosses the browser API.
    pub control_path: PathBuf,
    /// The tmux sessions the host's server listed; `None` where it was not
    /// asked (no window up, or an HPC host), and the master alone counts.
    pub sessions: Option<HashSet<String>>,
}

impl HostReach {
    /// Whether a tab whose session is `name` reads as available on this host.
    pub fn has_session(&self, name: &str) -> bool {
        self.sessions.as_ref().is_none_or(|sessions| sessions.contains(name))
    }
}

/// The hosts the last round found reachable, keyed by
/// `ssh_common::target_key` (`user@host:port`, the `hpc_hosts` key). A host
/// absent here is unreachable: no master, a dead one, or never probed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostLive {
    hosts: HashMap<String, HostReach>,
}

impl HostLive {
    /// `spec`'s host as the last round found it; `None` is unreachable.
    pub fn reach(&self, spec: &RemoteSpec) -> Option<&HostReach> {
        self.hosts.get(&key_of(spec))
    }

    /// Record `spec`'s host as reachable — a round's own write, and how a test
    /// builds a snapshot by hand.
    pub fn insert(&mut self, spec: &RemoteSpec, reach: HostReach) {
        self.hosts.insert(key_of(spec), reach);
    }
}

/// The slot the refresher writes and every catalog load reads.
pub type SharedHostLive = Arc<Mutex<HostLive>>;

/// What the phone's attach to a host tab rides on: the host and the literal
/// socket of its master. Raw, never serialized.
#[derive(Debug, Clone)]
pub struct HostSsh {
    pub spec: Box<RemoteSpec>,
    pub control_path: PathBuf,
}

/// A host's identity here: the `hpc_hosts` key, so a tag and a probe can
/// never name two different machines.
fn key_of(spec: &RemoteSpec) -> String {
    crate::services::ssh_common::target_key(spec.user.as_deref(), &spec.host, spec.port)
}

/// How often the gates are looked at; a round runs at most every [`ROUND`].
/// Short, so a phone that just signed in sees its host tabs within seconds.
const GATE_TICK: Duration = Duration::from_secs(2);
/// How often a round probes, while a phone is signed in.
const ROUND: Duration = Duration::from_secs(10);
/// How long one probe (`-O check`, `tmux ls`) may take.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a host whose `tmux ls` keeps failing is still read by its last
/// answer. Past this it counts as unreachable.
const CARRY_FORWARD: Duration = Duration::from_secs(60);

/// The probes a round runs, behind a seam so the round's rules are tested
/// without ssh.
pub(super) trait Probe {
    /// The literal socket of the desktop's master for `spec`, when one is
    /// there as a file.
    fn control_socket(&self, spec: &RemoteSpec) -> Option<PathBuf>;
    /// `ssh -O check` on it.
    fn master_alive(&self, control_path: &Path) -> bool;
    /// `tmux ls` on the host over the master; `Err` when it could not be asked.
    fn tmux_sessions(&self, spec: &RemoteSpec, control_path: &Path) -> Result<HashSet<String>, String>;
}

/// The real probes: `ssh -G`, `ssh -O check` and the no-dial `tmux ls`.
struct SshProbe;

impl Probe for SshProbe {
    fn control_socket(&self, spec: &RemoteSpec) -> Option<PathBuf> {
        ssh_exec::resolve_control_path(spec).filter(|path| path.exists())
    }

    fn master_alive(&self, control_path: &Path) -> bool {
        ssh_exec::master_alive(control_path, PROBE_TIMEOUT)
    }

    fn tmux_sessions(&self, spec: &RemoteSpec, control_path: &Path) -> Result<HashSet<String>, String> {
        let args = ssh_exec::host_mux_args(spec, control_path, false, ssh_exec::tmux_ls_script())?;
        let mut command = crate::paths::command_no_window("ssh");
        command.args(args);
        let out = crate::paths::output_within(command, PROBE_TIMEOUT).map_err(|e| e.to_string())?;
        // 255 is the transport failing; the script ends in `|| true`, so any
        // answer from the host's tmux — none running included — exits 0.
        if !out.status.success() {
            return Err(format!("tmux ls over the master exited {:?}", out.status.code()));
        }
        Ok(ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&out.stdout))
            .into_iter()
            .map(|session| session.name)
            .collect())
    }
}

/// The hosts `settings.json` tags HPC, by `target_key`. `None` when the file
/// is there but cannot be read: not known, so every host is treated as one
/// (no background `tmux ls`). Read from the sidecar's own state dir, never
/// through `hpc_mode`'s global settings path.
fn hpc_hosts(state_dir: &Path) -> Option<HashSet<String>> {
    match std::fs::read(state_dir.join("settings.json")) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().map(|settings| hpc_tagged(&settings)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(HashSet::new()),
        Err(_) => None,
    }
}

/// The `hpc_hosts` keys set to `true` in a parsed `settings.json`.
fn hpc_tagged(settings: &Value) -> HashSet<String> {
    settings
        .get("hpc_hosts")
        .and_then(Value::as_object)
        .map(|tags| {
            tags.iter()
                .filter(|(_, tagged)| tagged.as_bool() == Some(true))
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// The last `tmux ls` answer per host, for [`CARRY_FORWARD`].
type Answers = HashMap<String, (Instant, HashSet<String>)>;

/// One round over `targets`. `window_up`: a window holds the timer lease.
fn round(
    targets: &[RemoteSpec],
    window_up: bool,
    hpc: Option<&HashSet<String>>,
    answers: &mut Answers,
    probe: &dyn Probe,
    now: Instant,
) -> HostLive {
    let mut live = HostLive::default();
    for spec in targets {
        let key = key_of(spec);
        let Some(control_path) = probe.control_socket(spec) else {
            answers.remove(&key);
            continue;
        };
        if !window_up {
            live.insert(spec, HostReach { control_path, sessions: None });
            continue;
        }
        if !probe.master_alive(&control_path) {
            answers.remove(&key);
            continue;
        }
        if hpc.is_none_or(|tagged| tagged.contains(&key)) {
            live.insert(spec, HostReach { control_path, sessions: None });
            continue;
        }
        match probe.tmux_sessions(spec, &control_path) {
            Ok(sessions) => {
                answers.insert(key, (now, sessions.clone()));
                live.insert(spec, HostReach { control_path, sessions: Some(sessions) });
            }
            Err(_) => match answers.get(&key) {
                Some((at, sessions)) if now.duration_since(*at) <= CARRY_FORWARD => {
                    let sessions = Some(sessions.clone());
                    live.insert(spec, HostReach { control_path, sessions });
                }
                _ => {
                    answers.remove(&key);
                }
            },
        }
    }
    live
}

/// Seconds since the epoch, the timer lease's clock.
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One round against the real state dir and ssh.
fn round_now(state_dir: &Path, answers: &mut Answers) -> HostLive {
    let targets = super::discovery::host_probe_targets(state_dir);
    if targets.is_empty() {
        answers.clear();
        return HostLive::default();
    }
    let lease = crate::services::timer_lease::lease_file(state_dir);
    let window_up = crate::services::timer_lease::holder_in(&lease, unix_now()).is_some();
    let hpc = hpc_hosts(state_dir);
    round(&targets, window_up, hpc.as_ref(), answers, &SshProbe, Instant::now())
}

/// The refresher, for the host's whole life: a round every [`ROUND`] while a
/// phone is signed in, the snapshot emptied while none is. Never holds the
/// catalog mutex; its probes run on the blocking pool.
pub async fn run(
    state_dir: PathBuf,
    auth: Arc<Mutex<AuthStore>>,
    live: SharedHostLive,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut answers = Answers::new();
    let mut last_round: Option<Instant> = None;
    let mut tick = tokio::time::interval(GATE_TICK);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            changed = shutdown.changed() => if changed.is_err() { break },
        }
        if *shutdown.borrow() {
            break;
        }
        if !auth.lock_ok().has_live_session(unix_now()) {
            *live.lock_ok() = HostLive::default();
            answers.clear();
            last_round = None;
            continue;
        }
        if last_round.is_some_and(|at| at.elapsed() < ROUND) {
            continue;
        }
        last_round = Some(Instant::now());
        let dir = state_dir.clone();
        let mut carried = std::mem::take(&mut answers);
        let Ok((next, carried)) = tokio::task::spawn_blocking(move || {
            let next = round_now(&dir, &mut carried);
            (next, carried)
        })
        .await
        else {
            continue;
        };
        answers = carried;
        *live.lock_ok() = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn spec(host: &str) -> RemoteSpec {
        serde_json::from_value(serde_json::json!({ "user": "alice", "host": host, "remote_path": "/srv/p" })).unwrap()
    }

    /// A scripted host: what each probe answers, and what was asked.
    #[derive(Default)]
    struct Script {
        sockets: HashMap<String, PathBuf>,
        alive: HashSet<PathBuf>,
        tmux: HashMap<String, Result<HashSet<String>, String>>,
        asked: RefCell<Vec<String>>,
    }

    impl Probe for Script {
        fn control_socket(&self, spec: &RemoteSpec) -> Option<PathBuf> {
            self.sockets.get(&spec.host).cloned()
        }
        fn master_alive(&self, control_path: &Path) -> bool {
            self.asked.borrow_mut().push(format!("check {}", control_path.display()));
            self.alive.contains(control_path)
        }
        fn tmux_sessions(&self, spec: &RemoteSpec, _: &Path) -> Result<HashSet<String>, String> {
            self.asked.borrow_mut().push(format!("tmux {}", spec.host));
            self.tmux.get(&spec.host).cloned().unwrap_or_else(|| Err("down".into()))
        }
    }

    fn socket(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    fn names(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn with_no_window_the_socket_file_alone_counts_and_nothing_is_asked() {
        let mut script = Script::default();
        script.sockets.insert("a.example".into(), socket("cm-a"));
        let targets = [spec("a.example"), spec("b.example")];
        let live = round(&targets, false, Some(&HashSet::new()), &mut Answers::new(), &script, Instant::now());
        let a = live.reach(&spec("a.example")).expect("socket present");
        assert_eq!(a.sessions, None);
        assert!(a.has_session("anything"));
        assert!(live.reach(&spec("b.example")).is_none(), "no socket, unreachable");
        assert!(script.asked.borrow().is_empty(), "no -O check, no tmux ls: {:?}", script.asked.borrow());
    }

    #[test]
    fn with_a_window_a_dead_master_is_unreachable_and_a_live_one_lists_its_sessions() {
        let mut script = Script::default();
        script.sockets.insert("dead.example".into(), socket("cm-dead"));
        script.sockets.insert("up.example".into(), socket("cm-up"));
        script.alive.insert(socket("cm-up"));
        script.tmux.insert("up.example".into(), Ok(names(&["s1"])));
        let targets = [spec("dead.example"), spec("up.example")];
        let live = round(&targets, true, Some(&HashSet::new()), &mut Answers::new(), &script, Instant::now());
        assert!(live.reach(&spec("dead.example")).is_none());
        let up = live.reach(&spec("up.example")).expect("alive");
        assert!(up.has_session("s1") && !up.has_session("s2"));
        assert_eq!(up.control_path, socket("cm-up"));
        assert!(!script.asked.borrow().contains(&"tmux dead.example".to_string()));
    }

    #[test]
    fn an_hpc_host_is_checked_but_never_listed_and_unreadable_tags_count_as_hpc() {
        let mut script = Script::default();
        script.sockets.insert("hpc.example".into(), socket("cm-hpc"));
        script.alive.insert(socket("cm-hpc"));
        let tagged = names(&[&key_of(&spec("hpc.example"))]);
        let live = round(&[spec("hpc.example")], true, Some(&tagged), &mut Answers::new(), &script, Instant::now());
        assert_eq!(live.reach(&spec("hpc.example")).expect("alive").sessions, None);
        let live = round(&[spec("hpc.example")], true, None, &mut Answers::new(), &script, Instant::now());
        assert_eq!(live.reach(&spec("hpc.example")).expect("alive").sessions, None);
        assert!(script.asked.borrow().iter().all(|asked| !asked.starts_with("tmux")), "{:?}", script.asked.borrow());
    }

    #[test]
    fn a_failed_tmux_ls_keeps_the_last_answer_for_a_minute_then_counts_as_dead() {
        let mut script = Script::default();
        script.sockets.insert("h.example".into(), socket("cm-h"));
        script.alive.insert(socket("cm-h"));
        script.tmux.insert("h.example".into(), Ok(names(&["s1"])));
        let targets = [spec("h.example")];
        let mut answers = Answers::new();
        let t0 = Instant::now();
        round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0);
        script.tmux.insert("h.example".into(), Err("hung".into()));
        let carried = round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0 + Duration::from_secs(50));
        assert!(carried.reach(&spec("h.example")).expect("carried").has_session("s1"));
        let gone = round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0 + Duration::from_secs(61));
        assert!(gone.reach(&spec("h.example")).is_none());
        // With no earlier answer a failure is unreachable at once.
        let fresh = round(&targets, true, Some(&HashSet::new()), &mut Answers::new(), &script, t0);
        assert!(fresh.reach(&spec("h.example")).is_none());
    }

    #[test]
    fn hosts_are_keyed_like_the_hpc_tags() {
        let mut live = HostLive::default();
        let reach = HostReach { control_path: socket("cm-k"), sessions: None };
        live.insert(&spec("Gpu.Example"), reach.clone());
        assert_eq!(live.reach(&spec("gpu.example")), Some(&reach), "host names fold case like target_key");
        let mut other_port = spec("gpu.example");
        other_port.port = Some(2222);
        assert!(live.reach(&other_port).is_none());
        let settings = serde_json::json!({ "hpc_hosts": { "alice@gpu.example:22": true, "bob@x:22": false, "odd": "yes" } });
        assert_eq!(hpc_tagged(&settings), names(&["alice@gpu.example:22"]));
        assert!(hpc_tagged(&serde_json::json!({ "hpc_hosts": [] })).is_empty());
    }

    #[test]
    fn the_hpc_tags_are_read_from_the_given_state_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(hpc_hosts(dir.path()), Some(HashSet::new()), "no settings, no tags");
        std::fs::write(dir.path().join("settings.json"), r#"{"hpc_hosts":{"alice@h:22":true}}"#).unwrap();
        assert_eq!(hpc_hosts(dir.path()), Some(names(&["alice@h:22"])));
        std::fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        assert_eq!(hpc_hosts(dir.path()), None, "unreadable: every host is treated as HPC");
    }
}

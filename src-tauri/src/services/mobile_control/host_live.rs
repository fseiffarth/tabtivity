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
//!
//! Every round needs each host's literal socket path, which only `ssh -G` can
//! tell, and `ssh -G` evaluates the user's ssh_config — `Match exec` commands
//! included. So it runs under a deadline (`ssh_exec::RESOLVE_TIMEOUT`) and its
//! answer is kept per host: [`RESOLVE_KEEP`] while the path finds a master,
//! [`RESOLVE_RETRY`] while it does not.

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
/// How long a resolved socket path that found a master is used before
/// `ssh -G` is asked again. Only an edit to the user's ssh_config changes it.
const RESOLVE_KEEP: Duration = Duration::from_secs(5 * 60);
/// How long a resolution that found no master (no answer, no socket file, a
/// dead master) is used before `ssh -G` is asked again: rarely enough that a
/// host nobody connected to does not run the user's `Match exec` every round.
const RESOLVE_RETRY: Duration = Duration::from_secs(60);

/// The probes a round runs, behind a seam so the round's rules are tested
/// without ssh.
pub(super) trait Probe {
    /// The literal socket path of the desktop's master for `spec` (`ssh -G`).
    fn resolve_control_path(&self, spec: &RemoteSpec) -> Option<PathBuf>;
    /// Whether that socket is there as a file.
    fn socket_exists(&self, control_path: &Path) -> bool;
    /// `ssh -O check` on it.
    fn master_alive(&self, control_path: &Path) -> bool;
    /// `tmux ls` on the host over the master; `Err` when it could not be asked.
    fn tmux_sessions(&self, spec: &RemoteSpec, control_path: &Path) -> Result<HashSet<String>, String>;
}

/// The real probes: `ssh -G`, `ssh -O check` and the no-dial `tmux ls`.
struct SshProbe;

impl Probe for SshProbe {
    fn resolve_control_path(&self, spec: &RemoteSpec) -> Option<PathBuf> {
        ssh_exec::resolve_control_path(spec)
    }

    fn socket_exists(&self, control_path: &Path) -> bool {
        control_path.exists()
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

/// One host's `ssh -G` answer, and whether the last round found a master on it.
#[derive(Debug, Clone)]
struct Resolution {
    at: Instant,
    path: Option<PathBuf>,
    works: bool,
}

/// What rounds carry over to the next one, per host key.
#[derive(Debug, Default)]
struct Memory {
    answers: Answers,
    resolved: HashMap<String, Resolution>,
}

/// `spec`'s socket path when it is there as a file: the kept resolution while
/// it is fresh ([`RESOLVE_KEEP`] / [`RESOLVE_RETRY`]), else a new `ssh -G`.
/// A missing socket marks the resolution as not working.
fn control_socket(
    spec: &RemoteSpec,
    key: &str,
    resolved: &mut HashMap<String, Resolution>,
    probe: &dyn Probe,
    now: Instant,
) -> Option<PathBuf> {
    let fresh = resolved.get(key).is_some_and(|kept| {
        now.saturating_duration_since(kept.at) < if kept.works { RESOLVE_KEEP } else { RESOLVE_RETRY }
    });
    if !fresh {
        let path = probe.resolve_control_path(spec);
        resolved.insert(key.to_string(), Resolution { at: now, path, works: false });
    }
    let kept = resolved.get_mut(key)?;
    let path = kept.path.clone().filter(|path| probe.socket_exists(path));
    kept.works = path.is_some();
    path
}

/// One round over `targets`. `window_up`: a window holds the timer lease.
fn round(
    targets: &[RemoteSpec],
    window_up: bool,
    hpc: Option<&HashSet<String>>,
    memory: &mut Memory,
    probe: &dyn Probe,
    now: Instant,
) -> HostLive {
    let keys: HashSet<String> = targets.iter().map(key_of).collect();
    memory.resolved.retain(|key, _| keys.contains(key));
    memory.answers.retain(|key, _| keys.contains(key));
    let Memory { answers, resolved } = memory;
    let mut live = HostLive::default();
    for spec in targets {
        let key = key_of(spec);
        let Some(control_path) = control_socket(spec, &key, resolved, probe, now) else {
            answers.remove(&key);
            continue;
        };
        if !window_up {
            live.insert(spec, HostReach { control_path, sessions: None });
            continue;
        }
        if !probe.master_alive(&control_path) {
            if let Some(kept) = resolved.get_mut(&key) {
                kept.works = false;
            }
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
fn round_now(state_dir: &Path, memory: &mut Memory) -> HostLive {
    let targets = super::discovery::host_probe_targets(state_dir);
    if targets.is_empty() {
        *memory = Memory::default();
        return HostLive::default();
    }
    let lease = crate::services::timer_lease::lease_file(state_dir);
    let window_up = crate::services::timer_lease::holder_in(&lease, unix_now()).is_some();
    let hpc = hpc_hosts(state_dir);
    round(&targets, window_up, hpc.as_ref(), memory, &SshProbe, Instant::now())
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
    let mut memory = Memory::default();
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
        if !auth.lock_ok().has_live_session() {
            *live.lock_ok() = HostLive::default();
            memory = Memory::default();
            last_round = None;
            continue;
        }
        if last_round.is_some_and(|at| at.elapsed() < ROUND) {
            continue;
        }
        last_round = Some(Instant::now());
        let dir = state_dir.clone();
        let mut carried = std::mem::take(&mut memory);
        let Ok((next, carried)) = tokio::task::spawn_blocking(move || {
            let next = round_now(&dir, &mut carried);
            (next, carried)
        })
        .await
        else {
            continue;
        };
        memory = carried;
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
        /// Resolved paths whose socket file is not there.
        missing: HashSet<PathBuf>,
        tmux: HashMap<String, Result<HashSet<String>, String>>,
        asked: RefCell<Vec<String>>,
    }

    impl Probe for Script {
        fn resolve_control_path(&self, spec: &RemoteSpec) -> Option<PathBuf> {
            self.asked.borrow_mut().push(format!("resolve {}", spec.host));
            self.sockets.get(&spec.host).cloned()
        }
        fn socket_exists(&self, control_path: &Path) -> bool {
            !self.missing.contains(control_path)
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
        let live = round(&targets, false, Some(&HashSet::new()), &mut Memory::default(), &script, Instant::now());
        let a = live.reach(&spec("a.example")).expect("socket present");
        assert_eq!(a.sessions, None);
        assert!(a.has_session("anything"));
        assert!(live.reach(&spec("b.example")).is_none(), "no socket, unreachable");
        assert!(
            script.asked.borrow().iter().all(|asked| asked.starts_with("resolve")),
            "no -O check, no tmux ls: {:?}",
            script.asked.borrow()
        );
    }

    #[test]
    fn with_a_window_a_dead_master_is_unreachable_and_a_live_one_lists_its_sessions() {
        let mut script = Script::default();
        script.sockets.insert("dead.example".into(), socket("cm-dead"));
        script.sockets.insert("up.example".into(), socket("cm-up"));
        script.alive.insert(socket("cm-up"));
        script.tmux.insert("up.example".into(), Ok(names(&["s1"])));
        let targets = [spec("dead.example"), spec("up.example")];
        let live = round(&targets, true, Some(&HashSet::new()), &mut Memory::default(), &script, Instant::now());
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
        let live = round(&[spec("hpc.example")], true, Some(&tagged), &mut Memory::default(), &script, Instant::now());
        assert_eq!(live.reach(&spec("hpc.example")).expect("alive").sessions, None);
        let live = round(&[spec("hpc.example")], true, None, &mut Memory::default(), &script, Instant::now());
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
        let mut answers = Memory::default();
        let t0 = Instant::now();
        round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0);
        script.tmux.insert("h.example".into(), Err("hung".into()));
        let carried = round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0 + Duration::from_secs(50));
        assert!(carried.reach(&spec("h.example")).expect("carried").has_session("s1"));
        let gone = round(&targets, true, Some(&HashSet::new()), &mut answers, &script, t0 + Duration::from_secs(61));
        assert!(gone.reach(&spec("h.example")).is_none());
        // With no earlier answer a failure is unreachable at once.
        let fresh = round(&targets, true, Some(&HashSet::new()), &mut Memory::default(), &script, t0);
        assert!(fresh.reach(&spec("h.example")).is_none());
    }

    fn resolves(script: &Script) -> usize {
        script.asked.borrow().iter().filter(|asked| asked.starts_with("resolve")).count()
    }

    /// `ssh -G` runs the user's `Match exec`: a path that finds a master is
    /// asked for again only after [`RESOLVE_KEEP`], not every round.
    #[test]
    fn a_working_socket_path_is_resolved_once_per_keep_window_not_every_round() {
        let mut script = Script::default();
        script.sockets.insert("up.example".into(), socket("cm-keep"));
        script.alive.insert(socket("cm-keep"));
        script.tmux.insert("up.example".into(), Ok(names(&["s1"])));
        let targets = [spec("up.example")];
        let mut memory = Memory::default();
        let t0 = Instant::now();
        for round_no in 0..30u64 {
            let at = t0 + ROUND * round_no as u32;
            let live = round(&targets, true, Some(&HashSet::new()), &mut memory, &script, at);
            assert!(live.reach(&spec("up.example")).is_some(), "round {round_no}");
        }
        assert_eq!(resolves(&script), 1, "{:?}", script.asked.borrow());
        // With no window, the socket file alone: kept just the same.
        round(&targets, false, Some(&HashSet::new()), &mut memory, &script, t0 + Duration::from_secs(299));
        assert_eq!(resolves(&script), 1);
        round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + RESOLVE_KEEP);
        assert_eq!(resolves(&script), 2, "asked again once the keep window is over");
    }

    #[test]
    fn a_host_without_a_master_is_resolved_at_most_once_a_minute() {
        let mut script = Script::default();
        // No answer from `ssh -G` (a deadline, or nothing printed) …
        let targets = [spec("none.example"), spec("nofile.example"), spec("dead.example")];
        // … a path whose socket file is not there …
        script.sockets.insert("nofile.example".into(), socket("cm-nofile"));
        script.missing.insert(socket("cm-nofile"));
        // … and a socket with a dead master.
        script.sockets.insert("dead.example".into(), socket("cm-deadm"));
        let mut memory = Memory::default();
        let t0 = Instant::now();
        for round_no in 0..6u64 {
            let at = t0 + ROUND * round_no as u32;
            let live = round(&targets, true, Some(&HashSet::new()), &mut memory, &script, at);
            assert!(targets.iter().all(|t| live.reach(t).is_none()), "round {round_no}");
        }
        assert_eq!(resolves(&script), 3, "one each in the first minute: {:?}", script.asked.borrow());
        round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + RESOLVE_RETRY);
        assert_eq!(resolves(&script), 6);

        // A master that comes up is found at the next retry, then kept.
        script.missing.clear();
        script.alive.insert(socket("cm-nofile"));
        script.tmux.insert("nofile.example".into(), Ok(names(&["s1"])));
        let found = round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + RESOLVE_RETRY * 2);
        assert!(found.reach(&spec("nofile.example")).is_some());
        let after = resolves(&script);
        round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + RESOLVE_RETRY * 3);
        let asked_again: Vec<_> = script.asked.borrow()[..].iter().filter(|a| *a == "resolve nofile.example").cloned().collect();
        assert_eq!(asked_again.len(), 3, "kept while it works");
        assert_eq!(resolves(&script), after + 2, "the two without a master retried");
    }

    #[test]
    fn a_master_that_dies_has_its_path_resolved_again_after_the_retry_window() {
        let mut script = Script::default();
        script.sockets.insert("h.example".into(), socket("cm-dies"));
        script.alive.insert(socket("cm-dies"));
        script.tmux.insert("h.example".into(), Ok(names(&["s1"])));
        let targets = [spec("h.example")];
        let mut memory = Memory::default();
        let t0 = Instant::now();
        round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0);
        script.alive.clear();
        let dead = round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + ROUND);
        assert!(dead.reach(&spec("h.example")).is_none());
        assert_eq!(resolves(&script), 1);
        round(&targets, true, Some(&HashSet::new()), &mut memory, &script, t0 + RESOLVE_RETRY);
        assert_eq!(resolves(&script), 2, "a failing path is re-asked after a minute, not five");
    }

    #[test]
    fn a_host_no_longer_probed_is_forgotten() {
        let mut script = Script::default();
        script.sockets.insert("a.example".into(), socket("cm-fa"));
        let mut memory = Memory::default();
        let t0 = Instant::now();
        round(&[spec("a.example")], false, Some(&HashSet::new()), &mut memory, &script, t0);
        assert_eq!(memory.resolved.len(), 1);
        round(&[spec("b.example")], false, Some(&HashSet::new()), &mut memory, &script, t0 + ROUND);
        assert!(!memory.resolved.contains_key(&key_of(&spec("a.example"))));
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

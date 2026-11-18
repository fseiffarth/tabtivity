//! Revival without restart (`docs/mcp_reattach_plan.md`, Phase 2): a local
//! agent that outlived a crash in its tmux session keeps the MCP tokens it was
//! started with, and this module lets the restarted listener honour some of
//! them again instead of flagging the tab stale.
//!
//! **The record.** Each listener keeps one private file of its own
//! ([`Role::record`]: `<state_dir>/root_mcp/reattach.json` for the window,
//! `reattach-host.json` for the Mobile host), written only through
//! `storage::patch_private_json` (0600, atomic, unknown fields kept) and hidden
//! from every fence (`agent_fence::private_state_paths` covers `root_mcp`). It
//! holds, per tmux / session-host session, the SHA-256 of each lane token the
//! session's agent was handed and the identity that token was bound to —
//! **never a token**. A hash cannot be presented as a bearer: the store hashes
//! whatever it is handed ([`super::TokenStore::authenticate`]).
//!
//! **Revival.** A reattach whose stamp no live listener confirms
//! (`root_mcp_mark::Reattach::Stale`) is revived when every guard holds
//! ([`Listener::judge`]), failing closed on each:
//!
//! - this listener bound its remembered port on the first try (any fallback
//!   purged the file at start, so nothing of the earlier run survives it);
//! - the stamp's port and the row's port are this listener's;
//! - the stamp's nonce is the row's, and that nonce is this run's or the run
//!   just before it of the same listener (the file's own nonce at start);
//! - the downtime (`now - last_alive` of that previous run) is under [`CAP`];
//! - the stamp's grant is the row's;
//! - the agent's CLI was seen to reconnect to a server that came back
//!   ([`cli_revives`], `docs/context/agent_mcp_wiring.md` §4).
//!
//! The launch then grants as a create would, against the *current* settings
//! and trusted entries, and [`revive`] swaps each fresh session for the
//! recorded hash when the recomputed identity matches the recorded one
//! ([`LaneRow::matches`]) — or revokes it. Only [`revivable`] lanes come back:
//! git, cockpit, help, markup, print and tabs. Never schedule (a
//! cross-project prompt injection if intercepted), root, reader, local model
//! or web. A recorded lane that does not come back leaves the tab stale.
//!
//! `AppHandle`-free; the listener wiring is in `commands::root_mcp`, the
//! launch's in `launch_prep`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use app_core::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Caller, Identity, TokenStore};

/// The longest downtime a revival bridges (fixed decision 5): past it, the
/// tab goes the Phase 1 way (stale, Reconnect).
pub const CAP: Duration = Duration::from_secs(30 * 60);
/// How often a listener refreshes its `last_alive`. The downtime a revival
/// measures is too long by up to this much, never too short.
pub const HEARTBEAT: Duration = Duration::from_secs(5 * 60);
/// Copilot dropped a server for good after an outage somewhere between 50 s
/// and 100 s (`agent_mcp_wiring.md` §4): revived only under the lower bound.
pub const COPILOT_CAP: Duration = Duration::from_secs(50);

/// Which listener a record belongs to (fixed decision 7): each reads and
/// writes only its own file, so the two never race on one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The desktop window's listener.
    Window,
    /// The Mobile host's (or a server daemon's) headless listener.
    Host,
}

impl Role {
    /// `<state>/root_mcp/reattach.json` or `reattach-host.json`.
    pub fn record(self, state: &Path) -> PathBuf {
        state.join("root_mcp").join(match self {
            Role::Window => "reattach.json",
            Role::Host => "reattach-host.json",
        })
    }
}

/// The lanes a revival may bring back (fixed decision 6).
pub fn revivable(caller: Caller) -> bool {
    matches!(caller, Caller::Pusher | Caller::Cockpit | Caller::Helper | Caller::Marker | Caller::Printer | Caller::Tabs)
}

/// The revivable lanes' token variables, in the order a stamp's grant is
/// chosen from ([`stamp_grant`]).
const REVIVABLE_TOKEN_ENVS: &[&str] = &[
    super::GIT_TOKEN_ENV,
    super::COCKPIT_TOKEN_ENV,
    super::HELP_TOKEN_ENV,
    super::MARKUP_TOKEN_ENV,
    super::PRINT_TOKEN_ENV,
    super::TABS_TOKEN_ENV,
];

/// The grant a new session's stamp names: the hash of its first revivable
/// lane's token, else of its first lane's at all, `None` with no lane. A
/// revivable one first, so a revived session's stamp still names a session
/// the store holds.
pub fn stamp_grant(env: &std::collections::HashMap<String, String>) -> Option<String> {
    REVIVABLE_TOKEN_ENVS
        .iter()
        .chain(super::LANE_TOKEN_ENVS)
        .find_map(|var| env.get(*var))
        .map(|token| super::token_hash(token))
}

/// Whether the agent CLI `stem` (with `local_model` for a local Vibe model)
/// is known to call a lane again after `downtime` of refused connections
/// (`docs/context/agent_mcp_wiring.md` §4). Claude, Codex and OpenCode retry
/// after any outage seen; Copilot only under [`COPILOT_CAP`]. A CLI the
/// registry wires no server for reaches the lanes only through the
/// `<slug>-mcp` command, one stateless call per run, so it retries by
/// construction. A local Vibe model's client and any other wired CLI were
/// never checked: not revived.
pub fn cli_revives(stem: &str, local_model: bool, downtime: Duration) -> bool {
    use crate::services::agent_registry::{mcp_wiring, McpWiring};
    if local_model {
        return false;
    }
    match stem {
        "claude" | "codex" | "opencode" => true,
        "copilot" => downtime < COPILOT_CAP,
        "" => false,
        other => mcp_wiring(other) == McpWiring::None,
    }
}

/// One listener's record file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// The nonce of the run that wrote it last (`Runtime::generation`).
    #[serde(default)]
    pub nonce: String,
    /// That run's listener port.
    #[serde(default)]
    pub port: u16,
    /// When that run was last seen alive, Unix seconds ([`HEARTBEAT`]).
    #[serde(default)]
    pub last_alive: u64,
    /// One row per session name.
    #[serde(default)]
    pub sessions: BTreeMap<String, Row>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What one session's agent was handed at creation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Row {
    /// The listener port its URLs name.
    #[serde(default)]
    pub port: u16,
    /// The nonce its stamp carries (renewed when a revival re-stamps it).
    #[serde(default)]
    pub nonce: String,
    /// The grant its stamp names ([`stamp_grant`]).
    #[serde(default)]
    pub grant: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The agent CLI's program name, before any wrap ([`cli_revives`]).
    #[serde(default)]
    pub cmd_stem: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_model: bool,
    /// Unix seconds.
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub lanes: Vec<LaneRow>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One lane of a [`Row`]: the token's hash and the identity it was bound to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LaneRow {
    /// The [`Caller`] in its wire spelling (`pusher`, `helper`, …).
    #[serde(default)]
    pub caller: String,
    /// The token's SHA-256; `None` for a lane that is never revived (or whose
    /// hash a revoke dropped), kept so that its loss still reads as stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_dir: Option<PathBuf>,
    /// The push lane's `git_at_spawn`, `<dev>:<id>`: restored, never
    /// recomputed (gap 19).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_at_spawn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fence_scope: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unfenced_host: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn caller_name(caller: Caller) -> String {
    serde_json::to_value(caller).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn caller_of(name: &str) -> Option<Caller> {
    serde_json::from_value(Value::String(name.to_string())).ok()
}

impl LaneRow {
    /// The lane `identity` holds under the token hash `hash`.
    pub fn of(identity: &Identity, hash: &str) -> LaneRow {
        let push = identity.push.as_ref();
        LaneRow {
            caller: caller_name(identity.caller),
            hash: revivable(identity.caller).then(|| hash.to_string()),
            project: identity.project.clone(),
            schedule_target: identity.schedule_target.as_ref().map(|b| b.target.clone()),
            schedule_agent: identity.schedule_target.as_ref().map(|b| b.agent.clone()),
            push_dir: push.map(|p| p.dir.clone()),
            git_at_spawn: push.and_then(|p| p.git_at_spawn).map(|(dev, id)| format!("{dev}:{id}")),
            fence_scope: push.and_then(|p| p.fence_scope.clone()),
            unfenced_host: push.is_some_and(|p| p.unfenced_host),
            extra: Map::new(),
        }
    }

    /// The recorded `.git` entry, `None` when there was none or it does not parse.
    pub fn git_at_spawn(&self) -> Option<(u64, u128)> {
        let (dev, id) = self.git_at_spawn.as_deref()?.split_once(':')?;
        Some((dev.parse().ok()?, id.parse().ok()?))
    }

    /// Whether `fresh` — what this launch's grant bound for the lane, against
    /// the current settings, `projects.json` and fence — is the identity the
    /// recorded token was bound to: same lane class (a revivable one), project,
    /// schedule target, push directory, fence scope and unfenced-host flag.
    /// `git_at_spawn` is not compared: it is the record's, by design.
    pub fn matches(&self, fresh: &Identity) -> bool {
        let push_matches = match fresh.push.as_ref() {
            None => self.push_dir.is_none() && self.fence_scope.is_none() && !self.unfenced_host,
            Some(p) => self.push_dir.as_ref() == Some(&p.dir) && self.fence_scope == p.fence_scope && self.unfenced_host == p.unfenced_host,
        };
        let target = fresh.schedule_target.as_ref().map(|b| (b.target.clone(), b.agent.clone()));
        caller_of(&self.caller) == Some(fresh.caller)
            && revivable(fresh.caller)
            && self.project == fresh.project
            && target == self.schedule_target.clone().zip(self.schedule_agent.clone())
            && (self.schedule_target.is_some() == self.schedule_agent.is_some())
            && push_matches
            && fresh.endpoint.is_none()
            && fresh.model.is_none()
    }
}

/// Why a reattach was not revived; it then goes the Phase 1 way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// This listener did not bind its remembered port on the first try.
    PortFallback,
    /// No row for the session.
    NoRecord,
    /// The stamp or the row names another port.
    PortMismatch,
    /// The stamp's nonce is not the row's, or not this run's or the previous one's.
    NonceMismatch,
    /// The downtime reached [`CAP`].
    Expired,
    /// The stamp names another grant than the row.
    GrantMismatch,
    /// The agent's CLI is not known to reconnect after this downtime.
    CliUnverified,
}

/// Unix seconds now.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// This process's listener as the record sees it: installed once, when the
/// listener is bound ([`install`]).
pub struct Listener {
    file: PathBuf,
    port: u16,
    nonce: String,
    /// The remembered port was bound on the first try: revival is possible at all.
    first_try: bool,
    /// The previous run of this listener — its nonce and `last_alive` — when
    /// its record passed the guards at start.
    previous: Option<(String, u64)>,
    /// The port this listener remembered and could not bind: a stamp naming
    /// it is never probed, since whoever took it would answer.
    lost_port: Option<u16>,
    /// The hashes of the previous run's rows not yet revived or refused: a
    /// bearer that presents one is told to come back (`503`) rather than
    /// refused (`401`), while within the cap.
    pending: std::sync::Mutex<HashSet<String>>,
    /// Set by a clean quit: nothing is written any more.
    stopped: AtomicBool,
}

static LISTENER: OnceLock<Listener> = OnceLock::new();

/// Publish this process's [`Listener`]. First caller wins, as `set_runtime`.
pub fn install(listener: Listener) {
    let _ = LISTENER.set(listener);
}

/// This process's listener's record, when one is installed.
pub fn listener() -> Option<&'static Listener> {
    LISTENER.get()
}

fn read_record(file: &Path) -> Result<Record, ()> {
    match std::fs::metadata(file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Record::default()),
        Err(_) => Err(()),
        Ok(_) => crate::storage::read_json::<Record>(file).map_err(|_| ()),
    }
}

fn purge(file: &Path) {
    match std::fs::remove_file(file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("[root-mcp] could not remove the reattach record: {error}"),
    }
}

fn row_hashes(row: &Row) -> impl Iterator<Item = String> + '_ {
    row.lanes.iter().filter_map(|lane| lane.hash.clone())
}

impl Listener {
    /// Open the record `file` for a listener bound on `port` with the nonce
    /// `nonce`, at `now` (Unix seconds). `first_try`: the remembered port was
    /// bound on the first try; anything else purges the file (and so
    /// does an unreadable one). The previous run's rows are kept only when its
    /// record names this port, a nonce, and a `last_alive` under [`CAP`] ago;
    /// rows of any older run go. The file is then rewritten as this run's.
    pub fn open(file: PathBuf, port: u16, nonce: String, first_try: bool, lost_port: Option<u16>, now: u64) -> Listener {
        let mut previous = None;
        let mut pending = HashSet::new();
        if !first_try {
            purge(&file);
        } else {
            match read_record(&file) {
                Err(()) => purge(&file),
                Ok(record) => {
                    let recent = record.last_alive <= now && now - record.last_alive < CAP.as_secs();
                    if record.port == port && !record.nonce.is_empty() && recent {
                        previous = Some((record.nonce.clone(), record.last_alive));
                    }
                }
            }
            let kept_nonce = previous.as_ref().map(|(n, _)| n.clone());
            let written = crate::storage::patch_private_json(&file, Record::default(), |record: &mut Record| {
                record.sessions.retain(|_, row| kept_nonce.as_ref() == Some(&row.nonce) && row.port == port);
                record.nonce = nonce.clone();
                record.port = port;
                record.last_alive = now;
                Ok(record.sessions.values().flat_map(row_hashes).collect::<HashSet<_>>())
            });
            match written {
                Ok(hashes) => pending = hashes,
                Err(error) => {
                    eprintln!("[root-mcp] reattach record: {error}");
                    purge(&file);
                    previous = None;
                }
            }
        }
        Listener {
            file,
            port,
            nonce,
            first_try,
            previous,
            lost_port,
            pending: std::sync::Mutex::new(pending),
            stopped: AtomicBool::new(false),
        }
    }

    /// The port a stamp must not be probed on ([`Listener::lost_port`]).
    pub fn lost_port(&self) -> Option<u16> {
        self.lost_port
    }

    /// Whether a stamp of the previous run may still be honoured at `now`:
    /// that run passed the guards at start and its downtime is under [`CAP`].
    pub fn within_cap(&self, nonce: &str, now: u64) -> bool {
        self.first_try && self.previous.as_ref().is_some_and(|(n, alive)| n == nonce && now.saturating_sub(*alive) < CAP.as_secs())
    }

    /// The guards of a revival of the session stamped `mark`, whose row is
    /// `row`, at `now`: the downtime it bridges, or why not. Pure.
    pub fn judge(&self, row: Option<&Row>, mark: &super::root_mcp_mark::Mark, now: u64) -> Result<Duration, Refusal> {
        if !self.first_try {
            return Err(Refusal::PortFallback);
        }
        let row = row.ok_or(Refusal::NoRecord)?;
        if mark.port != self.port || row.port != self.port {
            return Err(Refusal::PortMismatch);
        }
        if mark.nonce != row.nonce {
            return Err(Refusal::NonceMismatch);
        }
        let downtime = if row.nonce == self.nonce {
            0
        } else {
            match self.previous.as_ref() {
                Some((nonce, alive)) if *nonce == row.nonce => now.saturating_sub(*alive),
                _ => return Err(Refusal::NonceMismatch),
            }
        };
        if downtime >= CAP.as_secs() {
            return Err(Refusal::Expired);
        }
        if mark.grant.as_deref() != Some(row.grant.as_str()) {
            return Err(Refusal::GrantMismatch);
        }
        let downtime = Duration::from_secs(downtime);
        if !cli_revives(&row.cmd_stem, row.local_model, downtime) {
            return Err(Refusal::CliUnverified);
        }
        Ok(downtime)
    }

    /// The row to revive `session` (stamped `mark`) from at `now`, when every
    /// guard holds ([`Listener::judge`]). A row refused for any reason but a
    /// missing one is dropped: it cannot pass later.
    pub fn candidate(&self, session: &str, mark: &super::root_mcp_mark::Mark, now: u64) -> Option<Row> {
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        let row = read_record(&self.file).ok()?.sessions.remove(session);
        match self.judge(row.as_ref(), mark, now) {
            Ok(_) => row,
            Err(Refusal::NoRecord) => None,
            Err(_) => {
                self.drop_session(session);
                None
            }
        }
    }

    /// A bearer whose hash is `hash` belongs to a previous run's session not
    /// yet revived, while the cap still allows it.
    pub fn pending(&self, hash: &str, now: u64) -> bool {
        let Some((nonce, _)) = self.previous.as_ref() else { return false };
        self.within_cap(nonce, now) && self.pending.lock_ok().contains(hash)
    }

    fn patch<R>(&self, f: impl FnOnce(&mut Record) -> R) -> Option<R> {
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        crate::storage::patch_private_json(&self.file, Record::default(), |record: &mut Record| {
            // A file purged under a run (a crash of the patch, a hand edit)
            // starts again as this run's.
            if record.nonce.is_empty() {
                record.nonce = self.nonce.clone();
                record.port = self.port;
                record.last_alive = now_secs();
            }
            Ok(f(record))
        })
        .map_err(|error| eprintln!("[root-mcp] reattach record: {error}"))
        .ok()
    }

    /// Record the row of a session this run created (or revived).
    pub fn write_row(&self, session: &str, row: Row) {
        self.patch(|record| {
            record.sessions.insert(session.to_string(), row);
        });
    }

    /// The session ended (killed, Reconnected): its row goes.
    pub fn drop_session(&self, session: &str) {
        if let Some(Some(row)) = self.patch(|record| record.sessions.remove(session)) {
            let mut pending = self.pending.lock_ok();
            for hash in row_hashes(&row) {
                pending.remove(&hash);
            }
        }
    }

    /// The session was renamed: its row follows.
    pub fn rename(&self, old: &str, new: &str) {
        self.patch(|record| {
            if let Some(row) = record.sessions.remove(old) {
                record.sessions.insert(new.to_string(), row);
            }
        });
    }

    /// The user revoked these sessions, or their lane was switched off: no
    /// restart revives them. Each lane stays listed without its hash, so the
    /// loss still reads as stale.
    pub fn forget_hashes(&self, hashes: &[String]) {
        if hashes.is_empty() {
            return;
        }
        {
            let mut pending = self.pending.lock_ok();
            for hash in hashes {
                pending.remove(hash);
            }
        }
        // A file that names none of them is not rewritten.
        let named = read_record(&self.file).is_ok_and(|record| {
            record.sessions.values().flat_map(row_hashes).any(|h| hashes.contains(&h))
        });
        if named {
            self.patch(|record| {
                for lane in record.sessions.values_mut().flat_map(|row| row.lanes.iter_mut()) {
                    if lane.hash.as_ref().is_some_and(|h| hashes.contains(h)) {
                        lane.hash = None;
                    }
                }
            });
        }
    }

    /// Refresh `last_alive` to `now`; with `live` (every session the backend
    /// lists), drop the rows of sessions that are gone.
    pub fn heartbeat(&self, now: u64, live: Option<&HashSet<String>>) {
        let gone = self.patch(|record| {
            record.nonce = self.nonce.clone();
            record.port = self.port;
            record.last_alive = now;
            let mut gone = Vec::new();
            if let Some(live) = live {
                record.sessions.retain(|name, row| {
                    let keep = live.contains(name);
                    if !keep {
                        gone.extend(row_hashes(row));
                    }
                    keep
                });
            }
            gone
        });
        let mut pending = self.pending.lock_ok();
        for hash in gone.unwrap_or_default() {
            pending.remove(&hash);
        }
    }

    /// Every app session was ended (the Sessions view's end-all): every row
    /// goes, the listener's own fields stay.
    pub fn clear(&self) {
        self.pending.lock_ok().clear();
        self.patch(|record| record.sessions.clear());
    }

    /// A clean quit: the file goes and nothing is written after.
    pub fn delete(&self) {
        self.stopped.store(true, Ordering::Release);
        self.pending.lock_ok().clear();
        purge(&self.file);
    }

    /// This run's nonce and port, for a re-stamp.
    pub fn nonce(&self) -> &str {
        &self.nonce
    }
    pub fn port(&self) -> u16 {
        self.port
    }

    fn settled(&self, row: &Row) {
        let mut pending = self.pending.lock_ok();
        for hash in row_hashes(row) {
            pending.remove(&hash);
        }
    }
}

/// [`Listener::forget_hashes`] on this process's listener, when one is installed.
pub fn forget_hashes(hashes: &[String]) {
    if let Some(listener) = listener() {
        listener.forget_hashes(hashes);
    }
}

/// [`Listener::drop_session`] on this process's listener.
pub fn on_session_gone(session: &str) {
    if let Some(listener) = listener() {
        listener.drop_session(session);
    }
}

/// [`Listener::rename`] on this process's listener.
pub fn on_session_renamed(old: &str, new: &str) {
    if let Some(listener) = listener() {
        listener.rename(old, new);
    }
}

/// [`Listener::delete`] on this process's listener: the clean quit ended
/// every session the app made.
pub fn on_clean_quit() {
    if let Some(listener) = listener() {
        listener.delete();
    }
}

/// [`Listener::clear`] on this process's listener: every app session was
/// ended while the app runs on.
pub fn on_all_sessions_gone() {
    if let Some(listener) = listener() {
        listener.clear();
    }
}

/// Refresh this process's listener's `last_alive`, and drop the rows of
/// sessions the session backend no longer lists. Blocking (one listing).
pub fn heartbeat_now() {
    let Some(listener) = listener() else { return };
    let mux = crate::services::session_mux::mux();
    let live = mux
        .holds_sessions()
        .then(|| mux.list().ok())
        .flatten()
        .map(|sessions| sessions.into_iter().map(|s| s.name).collect::<HashSet<_>>());
    listener.heartbeat(now_secs(), live.as_ref());
}

/// A bearer `header` presents a token of a previous run's session that a
/// reattach may still revive ([`Listener::pending`]).
pub fn pending_bearer(header: Option<&str>) -> bool {
    let (Some(listener), Some(hash)) = (listener(), super::bearer_hash(header)) else { return false };
    listener.pending(&hash, now_secs())
}

/// The row of a session this launch creates: the lanes `store` holds under
/// the tokens in `env`, each with the identity it was bound to (a lane that is
/// never revived is listed without its hash).
pub fn created_row(
    store: &TokenStore,
    env: &std::collections::HashMap<String, String>,
    listener: &Listener,
    project: Option<String>,
    cmd_stem: &str,
    local_model: bool,
) -> Option<Row> {
    let grant = stamp_grant(env)?;
    let lanes: Vec<LaneRow> = {
        let map = store.map();
        super::LANE_TOKEN_ENVS
            .iter()
            .filter_map(|var| env.get(*var))
            .map(|token| super::token_hash(token))
            .filter_map(|hash| map.get(&hash).map(|s| LaneRow::of(&s.identity, &hash)))
            .collect()
    };
    if lanes.is_empty() {
        return None;
    }
    Some(Row {
        port: listener.port,
        nonce: listener.nonce.clone(),
        grant,
        project,
        cmd_stem: cmd_stem.to_string(),
        local_model,
        created: now_secs(),
        lanes,
        extra: Map::new(),
    })
}

/// What [`revive`] did.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Outcome {
    /// The recorded lanes that are live again, under their recorded hash.
    pub revived: Vec<LaneRow>,
    /// A recorded lane did not come back: the tab is stale.
    pub lost: bool,
    /// `(fresh hash, recorded hash)` of each swap, for the spawn's rollback.
    pub retarget: Vec<(String, String)>,
}

/// Swap the fresh sessions this launch was granted (`fresh`: their hashes,
/// all bound to `tab`, a launch into `project`) for the recorded ones of `row`
/// where the identities match; revoke every other fresh session. Fails
/// closed: when the launch's project is not the row's, or any recorded hash
/// is held in `store` already, nothing is revived.
pub fn revive(store: &TokenStore, tab: &str, project: Option<&str>, row: &Row, fresh: &[String]) -> Outcome {
    let mut out = Outcome::default();
    let held = row.project.as_deref() != project
        || row.lanes.iter().filter_map(|l| l.hash.as_deref()).any(|h| store.holds_session(h));
    for fresh_hash in fresh {
        let identity = store.map().get(fresh_hash).filter(|s| s.identity.tab == tab).map(|s| s.identity.clone());
        let Some(identity) = identity else { continue };
        let lane = row
            .lanes
            .iter()
            .filter(|lane| !held && lane.hash.is_some() && !out.revived.contains(*lane))
            .find(|lane| lane.matches(&identity));
        let swapped = lane.and_then(|lane| {
            let recorded = lane.hash.clone()?;
            rekey(store, fresh_hash, &recorded, lane.git_at_spawn()).map(|()| (lane.clone(), recorded))
        });
        match swapped {
            Some((lane, recorded)) => {
                out.retarget.push((fresh_hash.clone(), recorded));
                out.revived.push(lane);
            }
            None => {
                if let Some(session) = store.map().remove(fresh_hash) {
                    session.revoked.store(true, Ordering::Release);
                }
            }
        }
    }
    out.lost = row.lanes.iter().any(|lane| !out.revived.contains(lane));
    if let Some(listener) = listener() {
        listener.settled(row);
    }
    out
}

/// Move the session `fresh` to the key `recorded`, as a revived session: its
/// id becomes the recorded hash, its push binding takes the recorded
/// `git_at_spawn`, and a tab messaging seat is enrolled under the new id.
fn rekey(store: &TokenStore, fresh: &str, recorded: &str, git_at_spawn: Option<(u64, u128)>) -> Option<()> {
    let session = {
        let mut map = store.map();
        if map.contains_key(recorded) {
            return None;
        }
        let mut session = map.remove(fresh)?;
        session.id = recorded.to_string();
        session.revived = true;
        if let Some(push) = session.identity.push.as_mut() {
            push.git_at_spawn = git_at_spawn;
        }
        map.insert(recorded.to_string(), session.clone());
        session
    };
    if let Some(binding) = session.tabs.clone() {
        crate::services::tabs_mcp::enrol(binding, &session.identity.tab, recorded);
    }
    Some(())
}

/// The row after a revival of `outcome`: this run's nonce when the session
/// was re-stamped with it (`restamped`, naming `grant`), each recorded lane
/// that did not come back kept without its hash (so the loss still reads as
/// stale), the rest as before.
pub fn revived_row(mut row: Row, outcome: &Outcome, restamped: Option<(&str, &str)>) -> Row {
    for lane in row.lanes.iter_mut() {
        if !outcome.revived.contains(lane) {
            lane.hash = None;
        }
    }
    if let Some((nonce, grant)) = restamped {
        row.nonce = nonce.to_string();
        row.grant = grant.to_string();
    }
    row
}

#[cfg(test)]
mod tests;

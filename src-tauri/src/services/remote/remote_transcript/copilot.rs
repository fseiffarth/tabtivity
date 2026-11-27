//! The stored conversation of a Copilot tab that runs on a remote project's host
//! (see the parent module for the Claude case this mirrors).
//!
//! Copilot keeps a session as a folder, `<home>/.copilot/session-state/<uuid>/`,
//! whose `events.jsonl` is the whole conversation (one event per line, written
//! from the first prompt on). This module copies that one file into the
//! project's session folder over the project's pooled SFTP session and reads
//! the copy with the parser a local Copilot tab goes through
//! (`agent_transcript::read_transcript`, `TranscriptKind::Copilot`). The other
//! files of the folder (`workspace.yaml`, `session.db`, checkpoints) are not
//! needed and not copied. The log is append-only through prompts, `/compact`
//! and `/new` (1.0.114 to 1.0.117, `scripts/verify-cli/copilot/remote_store.py`), so
//! [`super::grow`] adds only the bytes appended since the last read.
//!
//! Bounds are the parent's: only a connected pool is used and a read while the
//! host is down answers `disconnected` (nothing is dialed); the host is asked
//! at most every [`super::check_every`], the folder lookup that follows the
//! tab to another session at most every [`super::SEARCH_EVERY`] and over at
//! most [`MAX_CANDIDATES`] session folders; a log past [`super::MAX_BYTES`] is
//! not copied. Every id taken from the host's files is `is_uuid_shaped` before
//! it becomes a path component, and the log is read by the parser as any
//! agent-written file.
//!
//! Which session: no hook runs on the host, and a launch is not always
//! pinned, so the host is asked. Copilot marks a running CLI in its session's
//! folder with `inuse.<pid>.lock` (the pid as its text; removed on a clean
//! exit), and the CLI's environment carries the tab's launch id (`TAB_UID`,
//! exported by `ssh_exec::remote_command`). The sessions a running Copilot has
//! open are listed in `~/.copilot/open-sessions-state.json` (emptied on a clean
//! exit; a CLI that does not write it is covered by the newest folders). A
//! session is the tab's when one of its lock files names a process whose
//! `/proc/<pid>/environ` carries the launch id ([`super::runs_tab`]) and is not
//! a nested run: a `copilot -p` started by the session's own shell tool inherits
//! the id, holds a folder and lock of its own, and is told apart by
//! `COPILOT_AGENT_SESSION_ID` in its environment. Of the tab's sessions the one
//! refreshed last is shown, which follows a `/new` on the host. With no running
//! CLI to ask (it exited, the host's `/proc` is unreadable) the session the
//! last ask found, else the locally recorded live id (a tab moved onto the host)
//! or the launch id (a launch pinned with `--session-id <launch id>`, as a local
//! tab's is) is read. A tab that was never pinned and no longer runs has no name
//! the app can know: it reads as a fresh chat, never as another tab's.
//!
//! The store is taken at `~/.copilot` of the host's agent home
//! (`RemoteSpec::agent_home`, else the login's home); a host whose login sets
//! `COPILOT_HOME` is not followed. Subagents ride in the same log, tagged with
//! their call, and have no conversation of their own: a subagent read answers
//! `no_subagent`, as a local Copilot tab's does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use openssh_sftp_client::Sftp;

use super::HostTab;
use crate::services::agent_session::{is_uuid_shaped, TranscriptKind};
use crate::services::agent_transcript::AgentTranscript;
use crate::services::sftp::{RawEntry, SyncKind};

#[cfg(test)]
mod tests;

/// Copilot's folder, relative to the home it runs with.
const COPILOT_DIR: &str = ".copilot";
/// The sessions' folder below it, and the file listing the open ones.
const STORE: &str = "session-state";
const OPEN_SESSIONS: &str = "open-sessions-state.json";
/// A session's conversation, inside its folder.
const EVENTS: &str = "events.jsonl";
/// The most session folders one ask looks into for a running CLI of the tab.
const MAX_CANDIDATES: usize = 40;
/// The largest `open-sessions-state.json` read: a few hundred bytes per open session.
const MAX_STATE_BYTES: u64 = 256 * 1024;
/// A lock file holds the pid and a newline.
const MAX_LOCK_BYTES: u64 = 64;
/// Set in the environment of a Copilot started by another Copilot's tools.
const NESTED_ENV: &[u8] = b"COPILOT_AGENT_SESSION_ID=";

/// What is known about one host tab's session between reads.
#[derive(Default)]
struct Mirror {
    /// The session the tab is on, once the host (or a fallback name) gave one.
    session: Option<String>,
    /// The log's path on the host, relative to the login's home, once found.
    remote: Option<String>,
    /// How many of its bytes the local copy holds.
    copied: u64,
    /// When the host was last asked whether the log grew.
    checked: Option<Instant>,
    /// When the host's running CLIs were last asked which session is the tab's.
    asked: Option<Instant>,
}

/// One entry per `(project, host, launch id)`, behind one lock so two Readers
/// of the same tab (the desktop's and the phone's) never copy at once.
static MIRRORS: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Mirror>>> =
    std::sync::LazyLock::new(Default::default);

/// What a read of the host tab's copy found.
enum Copy {
    /// Nothing can be read, for the reason a read answers with.
    Unavailable(&'static str),
    /// The session has written nothing on the host yet: a fresh, empty chat
    /// (carrying the session it will be, or the launch id).
    NotYet(String),
    /// The local copy, grown to what the host holds.
    At(PathBuf),
}

/// [`super::host_tab_transcript`] of a Copilot tab.
pub(super) async fn host_transcript(
    tab: &HostTab<'_>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    if subagent.is_some() {
        return AgentTranscript::unavailable("no_subagent");
    }
    let local = match host_copy(tab).await {
        Copy::Unavailable(reason) => return AgentTranscript::unavailable(reason),
        Copy::NotYet(id) => return AgentTranscript { available: true, version: Some(format!("new:{id}")), ..Default::default() },
        Copy::At(local) => local,
    };
    let version = version.map(str::to_string);
    app_core::rt::spawn_blocking(move || crate::services::agent_transcript::read_transcript(&local, TranscriptKind::Copilot, version.as_deref(), limit))
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| AgentTranscript::unavailable("read_failed"))
}

/// The local copy of the tab's `events.jsonl`, first grown by what the host
/// appended.
async fn host_copy(tab: &HostTab<'_>) -> Copy {
    let Some(target) = crate::services::remote::remote_target_for_host(tab.project_id, tab.host_id) else {
        return Copy::Unavailable("disconnected");
    };
    if !is_uuid_shaped(tab.launch_id) {
        return Copy::Unavailable("no_session");
    }
    let local = local_copy(tab.project_id, tab.host_id, tab.launch_id);
    let every = super::check_every(&target.spec);
    let mut mirrors = MIRRORS.lock().await;
    let mirror = mirrors.entry(super::mirror_key(tab.project_id, tab.host_id, tab.launch_id)).or_default();
    let fresh = mirror.checked.is_some_and(|at| at.elapsed() < every);
    // While the host cannot be asked (the session dropped, a stat failed), a
    // conversation copied before is still the one shown.
    let copy_held = |mirror: &Mirror| mirror.remote.is_some() && local.is_file();
    if !fresh {
        match crate::services::remote::pooled_sftp_host(tab.pool, tab.project_id, tab.host_id).await {
            Some(sftp) => {
                mirror.checked = Some(Instant::now());
                let home = target.spec.agent_home();
                if let Err(reason) = sync(&sftp, mirror, home.as_deref(), tab.project_id, tab.launch_id, &local).await {
                    if !copy_held(mirror) {
                        return Copy::Unavailable(reason);
                    }
                }
            }
            None if copy_held(mirror) => {}
            None => return Copy::Unavailable("disconnected"),
        }
    }
    if mirror.remote.is_some() {
        Copy::At(local)
    } else {
        Copy::NotYet(mirror.session.clone().unwrap_or_else(|| tab.launch_id.to_string()))
    }
}

/// Find the tab's session if it is not known yet (or, every [`super::SEARCH_EVERY`],
/// follow it to another), and copy what its log gained into `local`. `Err`
/// carries the reason a read answers with.
async fn sync(
    sftp: &Arc<Sftp>,
    mirror: &mut Mirror,
    home: Option<&str>,
    project_id: &str,
    launch_id: &str,
    local: &std::path::Path,
) -> Result<(), &'static str> {
    if mirror.asked.is_none_or(|at| at.elapsed() >= super::SEARCH_EVERY) {
        mirror.asked = Some(Instant::now());
        if let Some(session) = running_session(sftp, home, launch_id).await {
            switch_session(mirror, &session);
        }
    }
    if mirror.remote.is_none() {
        let live = crate::services::agent_session::read_live_session_for(Some(project_id), launch_id);
        for session in candidates(mirror.session.as_deref(), live.as_deref(), launch_id) {
            let Some(path) = events_path(home, &session) else { continue };
            match crate::services::sftp::metadata_opt_on(sftp, &path).await {
                Ok(Some(_)) => {
                    switch_session(mirror, &session);
                    mirror.remote = Some(path);
                    break;
                }
                Ok(None) => {}
                Err(_) => return Err("read_failed"),
            }
        }
    }
    let Some(remote) = mirror.remote.clone() else {
        return Ok(());
    };
    let size = match crate::services::sftp::metadata_opt_on(sftp, &remote).await {
        Ok(Some((size, _))) => size,
        // Moved or deleted on the host: look for it again next time.
        Ok(None) => {
            mirror.remote = None;
            mirror.copied = 0;
            return Ok(());
        }
        Err(_) => return Err("read_failed"),
    };
    if size > super::MAX_BYTES {
        return Err("read_failed");
    }
    mirror.copied = super::grow(sftp, &remote, local, size, mirror.copied).await.map_err(|_| "read_failed")?;
    Ok(())
}

/// The tab is on `session` now: another one than the copy holds starts over.
fn switch_session(mirror: &mut Mirror, session: &str) {
    if mirror.session.as_deref() != Some(session) {
        mirror.session = Some(session.to_string());
        mirror.remote = None;
        mirror.copied = 0;
    }
}

/// The session the tab's running Copilot is on, read over SFTP only: the open
/// sessions, each one's lock files, and the environment of the pids they name.
/// `None` when no running CLI of the tab is found.
async fn running_session(sftp: &Sftp, home: Option<&str>, launch_id: &str) -> Option<String> {
    let copilot = super::under(home, COPILOT_DIR);
    let store = format!("{copilot}/{STORE}");
    let state = crate::services::sftp::read_file_up_to(sftp, &format!("{copilot}/{OPEN_SESSIONS}"), MAX_STATE_BYTES).await;
    let mut open = match state {
        Ok(Some(bytes)) => open_sessions(&bytes),
        _ => None,
    };
    if open.is_none() {
        // A Copilot that does not list its open sessions: the newest folders.
        let entries = crate::services::sftp::list_dir_raw_on(sftp, &store).await.ok()?;
        open = Some(newest_sessions(&entries));
    }
    let mut verdict: HashMap<u32, bool> = HashMap::new();
    let mut mine: Vec<OpenSession> = Vec::new();
    for session in open?.into_iter().take(MAX_CANDIDATES) {
        let Ok(entries) = crate::services::sftp::list_dir_raw_on(sftp, &format!("{store}/{}", session.id)).await else {
            continue;
        };
        for pid in lock_pids(&entries) {
            let ours = match verdict.get(&pid) {
                Some(known) => *known,
                None => {
                    // `/proc` files list as size 0, so only the read can bound them.
                    let environ = crate::services::sftp::read_file_up_to(sftp, &format!("/proc/{pid}/environ"), super::MAX_ENVIRON_BYTES).await;
                    let ours = matches!(environ, Ok(Some(ref environ)) if is_tab_cli(environ, launch_id));
                    verdict.insert(pid, ours);
                    ours
                }
            };
            if ours {
                mine.push(session);
                break;
            }
        }
    }
    latest(mine)
}

/// A session a running Copilot has open, with when it last did something.
#[derive(Debug, PartialEq)]
struct OpenSession {
    id: String,
    /// `refreshedAt` (else `openedAt`) as the file spells it, an ISO time, or
    /// the folder's modified seconds, zero-padded: compared as text.
    stamp: String,
}

/// The sessions `open-sessions-state.json` lists: an object keyed by session
/// id (the host's file: only uuid-shaped keys become folder names), each with
/// `openedAt` and `refreshedAt`. `None` when `bytes` is not such an object;
/// `Some(empty)` is a host with no Copilot open.
fn open_sessions(bytes: &[u8]) -> Option<Vec<OpenSession>> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    Some(
        object
            .iter()
            .filter(|(id, _)| is_uuid_shaped(id))
            .map(|(id, record)| {
                let at = |key: &str| record.get(key).and_then(serde_json::Value::as_str);
                OpenSession { id: id.clone(), stamp: at("refreshedAt").or_else(|| at("openedAt")).unwrap_or_default().to_string() }
            })
            .collect(),
    )
}

/// The folders of a `session-state` listing, newest first, for a host whose
/// Copilot does not list its open sessions.
fn newest_sessions(entries: &[RawEntry]) -> Vec<OpenSession> {
    let mut found: Vec<OpenSession> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, SyncKind::Dir) && is_uuid_shaped(&entry.name))
        .map(|entry| OpenSession { id: entry.name.clone(), stamp: format!("{:020}", entry.modified_secs.unwrap_or(0)) })
        .collect();
    found.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    found.truncate(MAX_CANDIDATES);
    found
}

/// The pids a session folder's `inuse.<pid>.lock` files name. (The `.hold`
/// files beside them are open handles, not records.)
fn lock_pids(entries: &[RawEntry]) -> Vec<u32> {
    entries
        .iter()
        .filter(|entry| matches!(entry.kind, SyncKind::File) && entry.size <= MAX_LOCK_BYTES)
        .filter_map(|entry| {
            let pid = entry.name.strip_prefix("inuse.")?.strip_suffix(".lock")?;
            if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            pid.parse().ok()
        })
        .collect()
}

/// Whether the NUL-separated environment `environ` is the one of the Copilot
/// the tab launched as `launch_id` started: carrying the id, and not a nested
/// run (a `copilot -p` from the session's own shell tool inherits the id).
fn is_tab_cli(environ: &[u8], launch_id: &str) -> bool {
    super::runs_tab(environ, launch_id) && !environ.split(|b| *b == 0).any(|var| var.starts_with(NESTED_ENV))
}

/// The id of the session refreshed last. Equal stamps keep the first.
fn latest(sessions: Vec<OpenSession>) -> Option<String> {
    let mut best: Option<OpenSession> = None;
    for session in sessions {
        if best.as_ref().is_none_or(|known| session.stamp > known.stamp) {
            best = Some(session);
        }
    }
    best.map(|session| session.id)
}

/// The session ids to look for a log under, in order: the one the host's CLI
/// gave, the live id recorded here (a tab moved onto the host runs on its
/// local run's id) and the launch id (the pin of the tab's launch).
fn candidates(known: Option<&str>, live: Option<&str>, launch_id: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for id in known.into_iter().chain(live).chain([launch_id]) {
        if is_uuid_shaped(id) && !found.iter().any(|f| f == id) {
            found.push(id.to_string());
        }
    }
    found
}

/// A session's log on the host, relative to the login's home (or below the
/// agent home): `None` unless `session` is uuid-shaped.
fn events_path(home: Option<&str>, session: &str) -> Option<String> {
    is_uuid_shaped(session).then(|| format!("{}/{STORE}/{session}/{EVENTS}", super::under(home, COPILOT_DIR)))
}

/// Where the local copy of the tab's log lives, in the folder every host copy
/// of the project goes to.
fn local_copy(project_id: &str, host_id: &str, launch_id: &str) -> PathBuf {
    super::host_dir(project_id, host_id).join(format!("copilot-{launch_id}.jsonl"))
}

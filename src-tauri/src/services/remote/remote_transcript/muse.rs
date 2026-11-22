//! The stored conversation of a Muse tab that runs on a remote project's
//! host (see the parent module for the Claude case this mirrors), for the
//! desktop Reader. Probed against 1.4.25
//! (`scripts/verify-cli/muse/remote.py`).
//!
//! Muse files each session as an append-only log of JSON records,
//! `~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<id>/session.jsonl`
//! (`<id>` a UUIDv7, so it sorts by start time), which
//! [`crate::services::muse_session`] parses. Like a Claude transcript it is
//! copied over the project's pooled SFTP session by the bytes the host
//! appended ([`super::grow`]) and the local reader parses the copy.
//!
//! Which session: there is no hook on the host, so the host is asked. The
//! tab's `muse` process holds `session.jsonl` of its session open (and
//! flocks `.session.lock` beside it; `/clear` and `resume <id>` move both to
//! the new session) and carries the tab's launch id in its environment
//! ([`holders::tab_open_files`]): the link of that descriptor is the log's
//! path. A subagent's log (`<id>/subagent/<n>/session.jsonl`) does not have
//! the shape and is not taken. With no such process (it exited, or the host
//! has no `/proc`) the session found before stays; with none found yet, the
//! newest session of the tab's folder (its `metadata` record's
//! `workspace_root`), for a fresh tab only one begun after the tab was
//! opened — a sibling tab in the same folder can still be the one found, the
//! same ambiguity the local reader has for a tab from before its hook.
//!
//! Bounds: connected pool only, never dials (`disconnected` at once); the
//! host is asked at most every [`super::CHECK_EVERY`]
//! ([`super::CAREFUL_CHECK_EVERY`] on a careful or HPC host), its processes
//! every [`super::SEARCH_EVERY`] (a third of a check period more while no
//! session is known), a log past [`MAX_LOG_BYTES`] (the local reader's own
//! limit) is not copied; the folder search lists at most [`MAX_LISTINGS`]
//! folders and reads the first [`HEAD_BYTES`] of at most [`MAX_HEADS`] logs. A
//! torn last line (a record being written) is skipped by the parser until
//! the rest arrives. Subagents' logs are not read (`no_subagent`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use openssh_sftp_client::Sftp;

use super::holders;
use super::{check_every, grow, host_dir, mirror_key, under, HostTab, SEARCH_EVERY};
use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::AgentTranscript;
use crate::services::sftp::SyncKind;

#[cfg(test)]
mod tests;

/// Muse's sessions, relative to the login's home (no `XDG_DATA_HOME`).
const SESSIONS: &str = ".local/share/muse/sessions";
/// The largest log copied: what the local reader reads at most.
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
/// How much of a log's head is read for its folder: the `metadata` record is among the first lines.
const HEAD_BYTES: usize = 32 * 1024;
/// The most folders one search lists, and the most logs it opens.
const MAX_LISTINGS: usize = 40;
const MAX_HEADS: usize = 16;
/// The host's clock against this machine's: a session found by folder counts
/// as begun after the tab opened when it is not older by more than this.
const SKEW_MS: i64 = 120_000;

/// What is known about one tab's session between reads.
#[derive(Default)]
struct State {
    /// The tab's session and its log's path on the host.
    session: Option<Found>,
    /// A process of the tab was found: its session is the answer, and the
    /// folder's is not looked at.
    pinned: bool,
    /// When the host's processes, the folder, and the log were last asked.
    asked: Option<Instant>,
    searched: Option<Instant>,
    checked: Option<Instant>,
    /// How many bytes of the log the local copy holds.
    copied: u64,
    /// The local copy holds at least the log's file (a first copy was made).
    copy_made: bool,
}

/// A session of the host: its id and the absolute path of its log there.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    id: String,
    log: String,
}

/// One entry per `(project, host, launch id)`.
static STATES: LazyLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<State>>>>> = LazyLock::new(Default::default);

fn state_for(key: String) -> Arc<tokio::sync::Mutex<State>> {
    STATES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(key).or_default().clone()
}

/// Forget what is known of the host tab's session (it was just taken to or
/// from the host): the next read finds it afresh.
pub(super) fn forget(project_id: &str, host_id: &str, launch_id: &str) {
    STATES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&mirror_key(project_id, host_id, launch_id));
}

fn numeric(name: &str, len: usize) -> bool {
    name.len() == len && name.bytes().all(|b| b.is_ascii_digit())
}

/// The session a descriptor link names, when it is a session's own log:
/// `…/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl`. Only the last six
/// components are looked at (the host's own spelling of the data folder).
fn session_log(target: &str) -> Option<Found> {
    let parts: Vec<&str> = target.rsplitn(6, '/').collect();
    // Reversed: file, id, day, month, year, rest-ending-in-"sessions".
    let [file, id, day, month, year, rest] = parts[..] else {
        return None;
    };
    let in_sessions = rest.rsplit('/').next() == Some("sessions");
    (file == "session.jsonl" && is_uuid_shaped(id) && numeric(day, 2) && numeric(month, 2) && numeric(year, 4) && in_sessions)
        .then(|| Found { id: id.to_string(), log: target.to_string() })
}

/// Which of the process's `found` sessions is the tab's: the one known
/// already when it is still held, else the last descriptor's.
fn choose(found: Vec<Found>, known: Option<&Found>) -> Option<Found> {
    known.filter(|known| found.contains(known)).cloned().or_else(|| found.into_iter().next_back())
}

/// When the session began (epoch ms): a UUIDv7's leading 48 bits.
fn started_ms(id: &str) -> Option<i64> {
    let hex: String = id.chars().filter(|c| *c != '-').take(12).collect();
    i64::from_str_radix(&hex, 16).ok()
}

/// The folder a session began in: the `workspace_root` of the `metadata`
/// record in the head of its log. A last line cut by the head's end is not parsed.
fn workspace_in(head: &[u8]) -> Option<String> {
    for line in head.split(|b| *b == b'\n') {
        if !line.windows(16).any(|window| window == b"\"workspace_root\"") {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let payload = value.get("payload")?;
        if payload.get("kind").and_then(|kind| kind.as_str()) == Some("metadata") {
            return payload.get("record")?.get("workspace_root")?.as_str().map(str::to_string);
        }
    }
    None
}

/// Whether a session begun at `id`'s time may be the tab's: a tab opened
/// fresh (`since`) has no session older than itself, the host's clock allowed for.
fn begun_since(id: &str, since: Option<i64>) -> bool {
    since.is_none_or(|since| started_ms(id).is_some_and(|start| start + SKEW_MS >= since))
}

/// [`super::host_tab_transcript`] of a Muse tab.
pub(super) async fn host_transcript(
    tab: &HostTab<'_>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    if subagent.is_some() {
        return AgentTranscript::unavailable("no_subagent");
    }
    if !is_uuid_shaped(tab.launch_id) {
        return AgentTranscript::unavailable("no_session");
    }
    let Some(target) = crate::services::remote::remote_target_for_host(tab.project_id, tab.host_id) else {
        return AgentTranscript::unavailable("unsupported");
    };
    let root = copy_root(tab);
    let cell = state_for(mirror_key(tab.project_id, tab.host_id, tab.launch_id));
    // Held across the copy and the read of it: a second Reader of the tab
    // (the phone's) must not grow the file under the first's read.
    let mut state = cell.lock().await;
    if let Err(reason) = refresh(tab, &target.spec, &root, &mut state).await {
        return AgentTranscript::unavailable(reason);
    }
    let Some(id) = state.session.as_ref().filter(|_| state.copy_made).map(|found| found.id.clone()) else {
        // Nothing written on the host yet: a fresh, empty chat.
        let new = format!("muse:new:{}", tab.launch_id);
        return AgentTranscript { available: true, unchanged: version == Some(new.as_str()), version: Some(new), ..Default::default() };
    };
    let (dir, version) = (root.join(&id), version.map(str::to_string));
    app_core::rt::spawn_blocking(move || crate::services::muse_session::copy_transcript(&dir, &id, version.as_deref(), limit))
        .await
        .unwrap_or_else(|_| AgentTranscript::unavailable("read_failed"))
}

/// The folder the tab's local copies live in: one folder per session below it.
fn copy_root(tab: &HostTab<'_>) -> PathBuf {
    host_dir(tab.project_id, tab.host_id).join(format!("muse-{}", tab.launch_id))
}

/// Ask the host, at most as often as the periods above, and bring the local
/// copy up to what it has. `Err` carries the reason a read answers with, only
/// while there is no copy to show.
async fn refresh(tab: &HostTab<'_>, spec: &crate::schema::project::RemoteSpec, root: &Path, state: &mut State) -> Result<(), &'static str> {
    let every = check_every(spec);
    if state.checked.is_some_and(|at| at.elapsed() < every) {
        return Ok(());
    }
    let held = state.copy_made;
    let Some(sftp) = crate::services::remote::pooled_sftp_host(tab.pool, tab.project_id, tab.host_id).await else {
        // A copy made before is still the conversation shown.
        return if held { Ok(()) } else { Err("disconnected") };
    };
    state.checked = Some(Instant::now());
    match sync(&sftp, tab, spec, every, root, state).await {
        Err(reason) if !state.copy_made => Err(reason),
        _ => Ok(()),
    }
}

async fn sync(sftp: &Sftp, tab: &HostTab<'_>, spec: &crate::schema::project::RemoteSpec, every: Duration, root: &Path, state: &mut State) -> Result<(), &'static str> {
    let home = spec.agent_home();
    find_session(sftp, tab, &under(home.as_deref(), SESSIONS), every, root, state).await;
    let Some(found) = state.session.clone() else {
        return Ok(());
    };
    let size = match crate::services::sftp::metadata_opt_on(sftp, &found.log).await {
        Ok(Some((size, _))) => size,
        // Moved or deleted on the host: look for it again next time.
        Ok(None) => {
            state.session = None;
            state.pinned = false;
            reset(state, root).await;
            return Ok(());
        }
        Err(_) => return Err("read_failed"),
    };
    if size > MAX_LOG_BYTES {
        return Err("read_failed");
    }
    let local = root.join(&found.id).join("session.jsonl");
    state.copied = grow(sftp, &found.log, &local, size, state.copied).await.map_err(|_| "read_failed")?;
    state.copy_made = true;
    Ok(())
}

/// Learn which session the tab is on: its process's, else (while none is
/// known) the newest of the folder's.
async fn find_session(sftp: &Sftp, tab: &HostTab<'_>, sessions: &str, every: Duration, root: &Path, state: &mut State) {
    let ask_every = if state.pinned { SEARCH_EVERY } else { (every * 3).min(SEARCH_EVERY) };
    if state.asked.is_none_or(|at| at.elapsed() >= ask_every) {
        state.asked = Some(Instant::now());
        if let Some(targets) = holders::tab_open_files(sftp, tab.launch_id).await {
            state.pinned = true;
            let found: Vec<Found> = targets.iter().filter_map(|target| session_log(target)).collect();
            if let Some(found) = choose(found, state.session.as_ref()) {
                set_session(state, found, root).await;
            }
        }
    }
    if state.pinned || state.session.is_some() {
        return;
    }
    let Some(folder) = tab.tab_dir else {
        return;
    };
    if state.searched.is_some_and(|at| at.elapsed() < (every * 3).min(SEARCH_EVERY)) {
        return;
    }
    state.searched = Some(Instant::now());
    if let Some(found) = newest_in_folder(sftp, sessions, folder, tab.since).await {
        set_session(state, found, root).await;
    }
}

/// The tab is on `found`: another session than the copy's empties the copy.
async fn set_session(state: &mut State, found: Found, root: &Path) {
    if state.session.as_ref() != Some(&found) {
        reset(state, root).await;
        state.session = Some(found);
    }
}

/// Empty the local copy.
async fn reset(state: &mut State, root: &Path) {
    state.copied = 0;
    state.copy_made = false;
    // Absent is fine: nothing was copied yet.
    let _ = tokio::fs::remove_dir_all(root).await;
}

/// The newest session of the host whose log began in `folder` (and since `since`),
/// without a process to ask: the date folders walked newest first, the head of each log read.
async fn newest_in_folder(sftp: &Sftp, sessions: &str, folder: &str, since: Option<i64>) -> Option<Found> {
    let mut listings = MAX_LISTINGS;
    let mut heads = MAX_HEADS;
    let wanted = folder.trim_end_matches('/');
    for year in list_dirs(sftp, sessions, Some(4), &mut listings).await? {
        for month in list_dirs(sftp, &format!("{sessions}/{year}"), Some(2), &mut listings).await? {
            for day in list_dirs(sftp, &format!("{sessions}/{year}/{month}"), Some(2), &mut listings).await? {
                let day_path = format!("{sessions}/{year}/{month}/{day}");
                for id in list_dirs(sftp, &day_path, None, &mut listings).await? {
                    if !begun_since(&id, since) {
                        // Newest first: every later one is older still.
                        return None;
                    }
                    heads = heads.checked_sub(1)?;
                    let log = format!("{day_path}/{id}/session.jsonl");
                    let Ok(head) = crate::services::sftp::read_range_on(sftp, &log, 0, HEAD_BYTES).await else {
                        continue;
                    };
                    if workspace_in(&head).is_some_and(|root| root.trim_end_matches('/') == wanted) {
                        return Some(Found { id, log });
                    }
                }
            }
        }
    }
    None
}

/// The subfolders of `path`, newest (largest name) first: of `len` digits, or
/// uuid-shaped for `None`. `None` once `budget` listings are spent or the
/// folder cannot be listed.
async fn list_dirs(sftp: &Sftp, path: &str, len: Option<usize>, budget: &mut usize) -> Option<Vec<String>> {
    *budget = budget.checked_sub(1)?;
    let mut names: Vec<String> = crate::services::sftp::list_dir_raw_on(sftp, path)
        .await
        .ok()?
        .into_iter()
        .filter(|entry| matches!(entry.kind, SyncKind::Dir))
        .map(|entry| entry.name)
        .filter(|name| match len {
            Some(len) => numeric(name, len),
            None => is_uuid_shaped(name),
        })
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    Some(names)
}

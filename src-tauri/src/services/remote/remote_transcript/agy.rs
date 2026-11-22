//! The stored conversation of an Antigravity tab that runs on a remote
//! project's host (see the parent module for the Claude case this mirrors),
//! for the desktop Reader. Probed against 1.5.14
//! (`scripts/verify-cli/antigravity/remote.py`).
//!
//! Antigravity keeps one SQLite database per conversation,
//! `~/.gemini/antigravity-cli/conversations/<id>.db`, in WAL mode: new turns
//! sit in `<id>.db-wal` until a checkpoint folds them into the database. The
//! local reader ([`crate::services::google_chat`]) parses it; this module
//! keeps a local copy of the two files, over the project's pooled SFTP
//! session, and has that reader parse the copy.
//!
//! Which conversation: there is no hook on the host, so the host is asked.
//! The tab's `agy` process holds an `flock` on
//! `presence/<conversation id>.lock` for the conversation it is on (a
//! subagent's conversation has none; `/clear` moves it to the new one), shows
//! in `/proc/locks`, and carries the tab's launch id in its environment
//! ([`holders::tab_open_files`]). With no such process (it exited, or the host
//! has no `/proc`) the conversation found before stays; with none found yet,
//! the folder's last conversation (`cache/last_conversations.json`, one entry
//! per folder) is taken, for a fresh tab only when it began after the tab was
//! opened — a sibling tab in the same folder can still be the one named, the
//! same ambiguity the local reader has for a tab from before its hook.
//!
//! The copy: a database cannot be copied like an append-only log, so the copy
//! is taken so that a torn one is never read.
//! * The database file is copied whole only when the WAL was *restarted* (its
//!   header salts, bytes 16..24, changed — what a finished checkpoint
//!   followed by a write does) or first. Between restarts the WAL only
//!   grows, so it is grown like a transcript ([`super::grow`]).
//! * A copy whole is taken database first, WAL second, so the WAL covers every
//!   frame a checkpoint running meanwhile could have folded into the database
//!   (the WAL still holds them, and SQLite reads a page from there first). It
//!   is made in a staging folder and installed only if the WAL's salts, and a
//!   WAL-less database's size and time, are the same after as before; else it
//!   is made again (a few times, then `read_failed`).
//! * A growth that sees the salts change meanwhile is cut back to where it
//!   started: frames of another run carry other salts, SQLite ignores them,
//!   and the next check copies afresh.
//! * The `-shm` is never copied (SQLite rebuilds the wal-index from the WAL)
//!   and a local one is deleted before each read.
//!
//! Bounds: connected pool only, never dials (`disconnected` at once); the
//! host is asked at most every [`super::CHECK_EVERY`]
//! ([`super::CAREFUL_CHECK_EVERY`] on a careful or HPC host), its processes
//! every [`super::SEARCH_EVERY`] (a third of a check period more while no
//! conversation is known), a database past [`MAX_DB_BYTES`] or a WAL past
//! [`MAX_WAL_BYTES`] is not copied, and a database over [`BIG_DB_BYTES`] is
//! copied afresh at most every [`super::SEARCH_EVERY`]. Subagents' conversations
//! and the artifacts dialog are not read (`no_subagent`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use openssh_sftp_client::Sftp;

use super::{check_every, copy_range, grow, host_dir, mirror_key, under, HostTab, SEARCH_EVERY};
use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::AgentTranscript;

use super::holders;

#[cfg(test)]
mod tests;

/// Antigravity's store, relative to the login's home.
const STORE: &str = ".gemini/antigravity-cli";
/// The largest database copied, and the largest WAL.
const MAX_DB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_WAL_BYTES: u64 = 64 * 1024 * 1024;
/// A database larger than this is copied afresh only every [`SEARCH_EVERY`].
const BIG_DB_BYTES: u64 = 8 * 1024 * 1024;
/// `cache/last_conversations.json` is read up to this.
const MAX_INDEX_BYTES: u64 = 256 * 1024;
/// A WAL's header: magic, version, page size, checkpoint count, two salts, checksum.
const WAL_HEADER: u64 = 32;
/// How often a whole copy is tried before the host's changing store is given up on.
const FULL_TRIES: usize = 3;
/// The host's clock against this machine's: a conversation found by folder
/// counts as begun after the tab opened when it is not older by more than this.
const SKEW_MS: i64 = 120_000;
/// The local copy's folder below the host's: the staging folder, inside it.
const STAGE: &str = "stage";

/// What is known about one tab's conversation between reads.
#[derive(Default)]
struct State {
    /// The tab's conversation (uuid-shaped, it names files).
    conversation: Option<String>,
    /// A process of the tab was found: its conversation is the answer, and
    /// the folder's is not looked at.
    pinned: bool,
    /// The conversation came from the folder's index, not from a process.
    by_folder: bool,
    /// A folder's conversation older than the tab, not read again.
    rejected: Option<String>,
    /// When the host's processes, the folder's index and the files were last asked.
    asked: Option<Instant>,
    searched: Option<Instant>,
    checked: Option<Instant>,
    /// When the local copy was last made whole.
    resynced: Option<Instant>,
    /// What the local copy holds.
    held: Option<Held>,
}

/// What the local copy of a conversation holds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Held {
    id: String,
    /// The database as the host had it when it was copied.
    db: DbStamp,
    /// The WAL's salts the copy goes with, none for no WAL.
    salts: Option<(u32, u32)>,
    /// How many bytes of the WAL the copy holds.
    wal: u64,
}

/// A host file's size and modification second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DbStamp {
    size: u64,
    mtime: Option<u64>,
}

/// What a check does to the local copy.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// It is what the host has.
    Keep,
    /// The WAL grew: append.
    Grow,
    /// Database and WAL afresh.
    Full,
}

/// One entry per `(project, host, launch id)`.
static STATES: LazyLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<State>>>>> = LazyLock::new(Default::default);

fn state_for(key: String) -> Arc<tokio::sync::Mutex<State>> {
    STATES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(key).or_default().clone()
}

/// Forget what is known of the host tab's conversation (it was just taken to
/// or from the host): the next read finds it afresh.
pub(super) fn forget(project_id: &str, host_id: &str, launch_id: &str) {
    STATES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&mirror_key(project_id, host_id, launch_id));
}

/// The WAL's salts out of its first 32 bytes, `None` when they are not a
/// WAL header (SQLite then treats the WAL as empty).
fn wal_salts(head: &[u8]) -> Option<(u32, u32)> {
    let head = head.get(..WAL_HEADER as usize)?;
    let word = |at: usize| u32::from_be_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]);
    matches!(word(0), 0x377f_0682 | 0x377f_0683).then(|| (word(16), word(20)))
}

/// The conversation a `presence/<id>.lock` link names (in the host's own
/// spelling of the store's path: only its last components are looked at).
fn presence_id(target: &str) -> Option<String> {
    let (dir, file) = target.rsplit_once('/')?;
    let id = file.strip_suffix(".lock").filter(|id| is_uuid_shaped(id))?;
    let (store, presence) = dir.rsplit_once('/')?;
    let store = store.rsplit('/').next()?;
    (presence == "presence" && store == "antigravity-cli").then(|| id.to_string())
}

/// Which of the process's `ids` is the tab's: the one known already when it
/// still is held, else the newest descriptor's.
fn choose(ids: &[String], known: Option<&str>) -> Option<String> {
    known.filter(|known| ids.iter().any(|id| id == known)).map(str::to_string).or_else(|| ids.last().cloned())
}

/// The conversation `cache/last_conversations.json` (`{"<folder>": "<id>"}`)
/// names for `dir`.
fn folder_conversation(index: &[u8], dir: &str) -> Option<String> {
    let map: HashMap<String, serde_json::Value> = serde_json::from_slice(index).ok()?;
    let id = map.get(dir).or_else(|| map.get(dir.trim_end_matches('/')))?.as_str()?;
    is_uuid_shaped(id).then(|| id.to_string())
}

/// What a check does, from what the local copy holds (`held`) and what the host has now.
fn plan(held: Option<&Held>, id: &str, db: DbStamp, salts: Option<(u32, u32)>, wal_size: u64) -> Plan {
    let Some(held) = held.filter(|held| held.id == id) else {
        return Plan::Full;
    };
    if salts != held.salts {
        // The WAL restarted after a checkpoint, appeared or went away.
        return Plan::Full;
    }
    match salts {
        // No WAL: the database is all there is.
        None if db == held.db => Plan::Keep,
        None => Plan::Full,
        Some(_) => match wal_size.cmp(&held.wal) {
            std::cmp::Ordering::Equal => Plan::Keep,
            std::cmp::Ordering::Greater => Plan::Grow,
            // Truncated.
            std::cmp::Ordering::Less => Plan::Full,
        },
    }
}

/// How often a whole copy of a database of `size` bytes is made again.
fn resync_every(size: u64, every: Duration) -> Duration {
    if size > BIG_DB_BYTES { every.max(SEARCH_EVERY) } else { every }
}

/// [`super::host_tab_transcript`] of an Antigravity tab.
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
    let dir = copy_dir(tab);
    let cell = state_for(mirror_key(tab.project_id, tab.host_id, tab.launch_id));
    // Held across the copy and the read of it: a second Reader of the tab
    // (the phone's) must not replace the files under the first's query.
    let mut state = cell.lock().await;
    if let Err(reason) = refresh(tab, &target.spec, &dir, &mut state).await {
        return AgentTranscript::unavailable(reason);
    }
    let Some(id) = state.held.as_ref().map(|held| held.id.clone()) else {
        // Nothing written on the host yet: a fresh, empty chat.
        let new = format!("agy:new:{}", tab.launch_id);
        return AgentTranscript { available: true, unchanged: version == Some(new.as_str()), version: Some(new), ..Default::default() };
    };
    let version = version.map(str::to_string);
    app_core::rt::spawn_blocking(move || {
        // A wal-index left by an earlier read is not this WAL's.
        let _ = std::fs::remove_file(dir.join(format!("{id}.db-shm")));
        crate::services::google_chat::antigravity_copy(&dir, &id, version.as_deref(), limit)
    })
    .await
    .unwrap_or_else(|_| AgentTranscript::unavailable("read_failed"))
}

/// The folder the tab's local copy lives in.
fn copy_dir(tab: &HostTab<'_>) -> PathBuf {
    host_dir(tab.project_id, tab.host_id).join(format!("agy-{}", tab.launch_id))
}

/// Ask the host, at most as often as the periods above, and bring the local
/// copy up to what it has. `Err` carries the reason a read answers with, only
/// while there is no copy to show.
async fn refresh(tab: &HostTab<'_>, spec: &crate::schema::project::RemoteSpec, dir: &Path, state: &mut State) -> Result<(), &'static str> {
    let every = check_every(spec);
    if state.checked.is_some_and(|at| at.elapsed() < every) {
        return Ok(());
    }
    let held = state.held.is_some();
    let Some(sftp) = crate::services::remote::pooled_sftp_host(tab.pool, tab.project_id, tab.host_id).await else {
        // A copy made before is still the conversation shown.
        return if held { Ok(()) } else { Err("disconnected") };
    };
    state.checked = Some(Instant::now());
    match sync(&sftp, tab, spec, every, dir, state).await {
        Err(reason) if !held && state.held.is_none() => Err(reason),
        _ => Ok(()),
    }
}

async fn sync(sftp: &Sftp, tab: &HostTab<'_>, spec: &crate::schema::project::RemoteSpec, every: Duration, dir: &Path, state: &mut State) -> Result<(), &'static str> {
    let home = spec.agent_home();
    let store = under(home.as_deref(), STORE);
    find_conversation(sftp, tab, &store, every, dir, state).await;
    let Some(id) = state.conversation.clone() else {
        return Ok(());
    };
    copy_conversation(sftp, state, &store, &id, dir, every).await?;
    if state.by_folder {
        reject_older(tab, dir, &id, state).await;
    }
    Ok(())
}

/// Learn which conversation the tab is on: its process's, else (while none is
/// known) the folder's last.
async fn find_conversation(sftp: &Sftp, tab: &HostTab<'_>, store: &str, every: Duration, dir: &Path, state: &mut State) {
    let ask_every = if state.pinned { SEARCH_EVERY } else { (every * 3).min(SEARCH_EVERY) };
    if state.asked.is_none_or(|at| at.elapsed() >= ask_every) {
        state.asked = Some(Instant::now());
        if let Some(targets) = holders::tab_open_files(sftp, tab.launch_id).await {
            state.pinned = true;
            let ids: Vec<String> = targets.iter().filter_map(|target| presence_id(target)).collect();
            if let Some(id) = choose(&ids, state.conversation.as_deref()) {
                state.by_folder = false;
                set_conversation(state, id, dir).await;
            }
        }
    }
    if state.pinned || state.conversation.is_some() {
        return;
    }
    let Some(folder) = tab.tab_dir else {
        return;
    };
    if state.searched.is_some_and(|at| at.elapsed() < (every * 3).min(SEARCH_EVERY)) {
        return;
    }
    state.searched = Some(Instant::now());
    let Ok(Some(index)) = crate::services::sftp::read_file_up_to(sftp, &format!("{store}/cache/last_conversations.json"), MAX_INDEX_BYTES).await else {
        return;
    };
    if let Some(id) = folder_conversation(&index, folder).filter(|id| state.rejected.as_deref() != Some(id.as_str())) {
        state.by_folder = true;
        set_conversation(state, id, dir).await;
    }
}

/// The tab is on `id`: another conversation than the copy's empties the copy.
async fn set_conversation(state: &mut State, id: String, dir: &Path) {
    if state.conversation.as_deref() != Some(id.as_str()) {
        state.held = None;
        state.resynced = None;
        // Absent is fine: nothing was copied yet.
        let _ = tokio::fs::remove_dir_all(dir).await;
        state.conversation = Some(id);
    }
}

/// A conversation found by the folder for a tab opened since `tab.since` must
/// have begun after that (the host's clock allowed for): an older one is a
/// sibling's, and not the tab's.
async fn reject_older(tab: &HostTab<'_>, dir: &Path, id: &str, state: &mut State) {
    let (Some(since), true) = (tab.since, state.held.is_some()) else {
        return;
    };
    let (copy, copy_id) = (dir.to_path_buf(), id.to_string());
    let started = app_core::rt::spawn_blocking(move || crate::services::google_chat::antigravity_copy_started(&copy, &copy_id))
        .await
        .ok()
        .flatten();
    // A conversation with no prompt yet has no start: it is not judged yet.
    if started.is_some_and(|started| started + SKEW_MS >= since) {
        // Judged once; a process found later still overrides it.
        state.by_folder = false;
    }
    if started.is_some_and(|started| started + SKEW_MS < since) {
        state.rejected = Some(id.to_string());
        state.conversation = None;
        state.held = None;
        state.by_folder = false;
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

/// The WAL of `wal`: its salts and size. No file, a short one or one that is
/// not a WAL header is none (SQLite reads the database alone then).
async fn wal_state(sftp: &Sftp, wal: &str) -> Result<(Option<(u32, u32)>, u64), &'static str> {
    match crate::services::sftp::metadata_opt_on(sftp, wal).await {
        Ok(None) => Ok((None, 0)),
        Ok(Some((size, _))) if size < WAL_HEADER => Ok((None, 0)),
        Ok(Some((size, _))) => {
            let head = crate::services::sftp::read_range_on(sftp, wal, 0, WAL_HEADER as usize).await.map_err(|_| "read_failed")?;
            Ok(wal_salts(&head).map_or((None, 0), |salts| (Some(salts), size)))
        }
        Err(_) => Err("read_failed"),
    }
}

async fn db_stamp(sftp: &Sftp, db: &str) -> Result<Option<DbStamp>, &'static str> {
    match crate::services::sftp::metadata_opt_on(sftp, db).await {
        Ok(found) => Ok(found.map(|(size, mtime)| DbStamp { size, mtime })),
        Err(_) => Err("read_failed"),
    }
}

/// Bring the local copy of conversation `id` to what the host has.
async fn copy_conversation(sftp: &Sftp, state: &mut State, store: &str, id: &str, dir: &Path, every: Duration) -> Result<(), &'static str> {
    let db = format!("{store}/conversations/{id}.db");
    let wal = format!("{db}-wal");
    let Some(stamp) = db_stamp(sftp, &db).await? else {
        // The conversation has no database yet (nothing was asked of it).
        if state.held.take().is_some() {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        return Ok(());
    };
    if stamp.size > MAX_DB_BYTES {
        return Err("read_failed");
    }
    let (salts, wal_size) = wal_state(sftp, &wal).await?;
    if wal_size > MAX_WAL_BYTES {
        return Err("read_failed");
    }
    match plan(state.held.as_ref(), id, stamp, salts, wal_size) {
        Plan::Keep => Ok(()),
        Plan::Grow => grow_wal(sftp, state, &wal, id, dir).await,
        Plan::Full => {
            let waits = state.held.is_some() && state.resynced.is_some_and(|at| at.elapsed() < resync_every(stamp.size, every));
            if waits {
                // The copy shown is a consistent, older one.
                return Ok(());
            }
            full_copy(sftp, state, &db, &wal, id, dir).await
        }
    }
}

/// Append what the WAL gained to the local copy.
async fn grow_wal(sftp: &Sftp, state: &mut State, wal: &str, id: &str, dir: &Path) -> Result<(), &'static str> {
    let Some(held) = state.held.as_mut() else {
        return Ok(());
    };
    let live = dir.join(format!("{id}.db-wal"));
    let appending = tokio::fs::metadata(&live).await.is_ok_and(|meta| meta.len() == held.wal);
    if !appending {
        // Not what this process wrote (trimmed since): start over next time.
        state.held = None;
        return Ok(());
    }
    // The size is read again here: the frames the host wrote since the check came after it.
    let (salts, size) = wal_state(sftp, wal).await?;
    if salts != held.salts || size < held.wal {
        return Ok(());
    }
    if size > MAX_WAL_BYTES {
        return Err("read_failed");
    }
    let before = held.wal;
    let copied = grow(sftp, wal, &live, size, before).await.map_err(|_| "read_failed")?;
    let (after, _) = wal_state(sftp, wal).await?;
    if after != held.salts {
        // Restarted meanwhile: what came past `before` is another run's
        // frames (other salts, which SQLite ignores); cut it, the next check copies afresh.
        let file = tokio::fs::OpenOptions::new().write(true).open(&live).await.map_err(|_| "read_failed")?;
        file.set_len(before).await.map_err(|_| "read_failed")?;
        return Ok(());
    }
    held.wal = copied;
    Ok(())
}

/// Copy database and WAL afresh into the staging folder and install them if
/// the host's store did not move meanwhile (see the module doc).
async fn full_copy(sftp: &Sftp, state: &mut State, db: &str, wal: &str, id: &str, dir: &Path) -> Result<(), &'static str> {
    let stage = dir.join(STAGE);
    let (db_name, wal_name) = (format!("{id}.db"), format!("{id}.db-wal"));
    for _ in 0..FULL_TRIES {
        let _ = tokio::fs::remove_dir_all(&stage).await;
        let Some(before) = db_stamp(sftp, db).await? else {
            return Ok(());
        };
        if before.size > MAX_DB_BYTES {
            return Err("read_failed");
        }
        let (salts, _) = wal_state(sftp, wal).await?;
        let got = copy_range(sftp, db, &stage.join(&db_name), 0, before.size).await.map_err(|_| "read_failed")?;
        // The WAL is sized after the database was copied: it holds every frame a checkpoint could have folded in.
        let (salts_now, wal_size) = wal_state(sftp, wal).await?;
        if got != before.size || salts_now != salts || wal_size > MAX_WAL_BYTES {
            continue;
        }
        if salts.is_some() {
            let got = copy_range(sftp, wal, &stage.join(&wal_name), 0, wal_size).await.map_err(|_| "read_failed")?;
            if got != wal_size {
                continue;
            }
        }
        let (salts_after, _) = wal_state(sftp, wal).await?;
        let after = db_stamp(sftp, db).await?;
        if salts_after != salts || (salts.is_none() && after != Some(before)) {
            continue;
        }
        install(&stage, dir, &db_name, &wal_name, salts.is_some()).await.map_err(|_| "read_failed")?;
        state.held = Some(Held { id: id.to_string(), db: before, salts, wal: if salts.is_some() { wal_size } else { 0 } });
        state.resynced = Some(Instant::now());
        return Ok(());
    }
    let _ = tokio::fs::remove_dir_all(&stage).await;
    Err("read_failed")
}

/// Move the staged copy over the live one: the database, and the WAL or none.
async fn install(stage: &Path, dir: &Path, db_name: &str, wal_name: &str, wal: bool) -> std::io::Result<()> {
    for name in [db_name, wal_name] {
        match tokio::fs::remove_file(dir.join(name)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    tokio::fs::rename(stage.join(db_name), dir.join(db_name)).await?;
    if wal {
        tokio::fs::rename(stage.join(wal_name), dir.join(wal_name)).await?;
    }
    let _ = tokio::fs::remove_dir_all(stage).await;
    Ok(())
}

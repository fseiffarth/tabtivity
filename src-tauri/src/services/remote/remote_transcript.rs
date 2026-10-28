//! The stored conversation of an agent tab that runs on a remote project's
//! host (a tab whose locality is the primary or a worker), for the desktop
//! Reader and the phone's Focus chat.
//!
//! Such a tab's CLI writes its transcript on the host, under the login's own
//! home — Claude's `~/.claude/projects/<cwd slug>/<launch id>.jsonl` — where
//! [`crate::services::agent_transcript`], which reads the scope's local agent
//! home, never finds it. This module keeps a local copy of that one file in
//! the project's session folder, grown over the project's pooled SFTP session
//! by the bytes the host appended since the last read (a transcript is
//! append-only; a shorter file is copied afresh), and reads the copy with the
//! same parser a local tab's goes through.
//!
//! Bounds: it only ever rides a connected pool and never dials (a read while
//! the host is down answers `disconnected` at once — a Reader polling a dead
//! session must not freeze anything); the host is asked at most every
//! [`CHECK_EVERY`] ([`CAREFUL_CHECK_EVERY`] on a careful or HPC host), the
//! folder scan that finds a transcript outside the project's own slug folder
//! at most every [`SEARCH_EVERY`]; a transcript past [`MAX_BYTES`] is not
//! copied.
//!
//! Which conversation: no hook records on the host, so the host itself is
//! asked — Claude keeps a `~/.claude/sessions/<pid>.json` per running CLI
//! naming the session it is on now, and the CLI's environment carries the
//! tab's launch id ([`running_session`]). That follows a `/clear` there, a
//! relaunch under a fresh id, and a tab moved onto the host, which runs on
//! the id of its local run. With no running CLI to ask (it exited, or the host
//! has no readable `/proc`), the file named after the locally recorded live id
//! or the launch id is read. A Claude subagent's own conversation is not
//! copied. Other CLIs keep stores Tabtivity cannot name without a hook (Codex
//! mints its thread id itself) and answer `unsupported`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use openssh_sftp_client::Sftp;

use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::AgentTranscript;
use crate::services::remote::RemotePoolState;
use crate::services::sftp::SyncKind;

/// How often a Reader's read asks the host whether the transcript grew.
const CHECK_EVERY: Duration = Duration::from_millis(1500);
/// [`CHECK_EVERY`] on a host the user called careful or tagged HPC.
const CAREFUL_CHECK_EVERY: Duration = Duration::from_secs(12);
/// How often the host's `~/.claude/projects` is scanned for a transcript that
/// is not in the project folder's own slug folder (the agent `cd`'d first),
/// and how often its running sessions are asked which one the tab is on.
const SEARCH_EVERY: Duration = Duration::from_secs(30);
/// Where Claude keeps its transcripts and its running sessions' records,
/// relative to the login's home.
const PROJECTS: &str = ".claude/projects";
const SESSIONS: &str = ".claude/sessions";
/// The most session records one ask reads, and the largest one it reads.
const MAX_SESSION_RECORDS: usize = 200;
const MAX_SESSION_RECORD_BYTES: u64 = 64 * 1024;
/// The most slug folders one scan looks into.
const MAX_SEARCHED_DIRS: usize = 400;
/// The largest transcript copied. A longer one answers `read_failed`.
const MAX_BYTES: u64 = 512 * 1024 * 1024;
/// One SFTP read of the copy loop.
const CHUNK: u32 = 256 * 1024;

/// What is known about one host transcript between reads.
#[derive(Default)]
struct Mirror {
    /// The transcript's path on the host, relative to the login's home, once found.
    remote: Option<String>,
    /// How many of its bytes the local copy holds.
    copied: u64,
    /// When the host was last asked.
    checked: Option<Instant>,
    /// When `~/.claude/projects` was last scanned without finding it.
    searched: Option<Instant>,
    /// The session the host's running CLI said the tab is on, once one did.
    session: Option<String>,
    /// When the host's running sessions were last asked.
    asked: Option<Instant>,
}

/// One entry per `(project, host, launch id)`, behind one lock so two Readers
/// of the same tab (the desktop's and the phone's) never copy at once.
static MIRRORS: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Mirror>>> =
    std::sync::LazyLock::new(Default::default);

/// The folder name Claude stores a session started in `cwd` under: every
/// character but an ASCII letter or digit becomes `-`.
pub fn claude_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Where the local copy of the host transcript `launch_id` lives.
fn mirror_file(project_id: &str, host_id: &str, launch_id: &str) -> PathBuf {
    crate::storage::project_session_dir(project_id)
        .join("host-transcripts")
        .join(crate::storage::project_key(host_id))
        .join(format!("{launch_id}.jsonl"))
}

/// What [`host_tab_copy`] holds of a host tab's conversation.
pub enum HostCopy {
    /// Nothing can be read, for the reason a read answers with.
    Unavailable(&'static str),
    /// The session has written nothing on the host yet: a fresh, empty chat.
    NotYet,
    /// The local copy, grown to what the host holds.
    At(PathBuf),
}

/// The conversation of the `agent` tab with launch id `launch_id` that runs on
/// `host_id` of the remote project `project_id`, read as
/// [`crate::services::agent_transcript::agent_session_transcript`] reads a
/// local tab's. `None` when `project_id` names no remote project (or no such
/// host): the tab then runs here after all, and the local read answers.
#[allow(clippy::too_many_arguments)]
pub async fn host_tab_transcript(
    pool: &RemotePoolState,
    agent: &str,
    project_id: &str,
    host_id: &str,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    crate::services::remote::remote_target_for_host(project_id, host_id)?;
    if agent == "claude" && subagent.is_some() {
        return Some(AgentTranscript::unavailable("no_subagent"));
    }
    let local = match host_tab_copy(pool, agent, project_id, host_id, launch_id).await? {
        HostCopy::Unavailable(reason) => return Some(AgentTranscript::unavailable(reason)),
        // Claude writes its file with the first turn: a session started under
        // the launch id has nothing on the host yet — a fresh, empty chat.
        HostCopy::NotYet => {
            return Some(AgentTranscript { available: true, version: Some(format!("new:{launch_id}")), ..Default::default() })
        }
        HostCopy::At(local) => local,
    };
    let version = version.map(str::to_string);
    let read = app_core::rt::spawn_blocking(move || {
        crate::services::agent_transcript::claude_transcript_at(&local, None, version.as_deref(), limit)
    })
    .await
    .ok()
    .flatten();
    Some(read.unwrap_or_else(|| AgentTranscript::unavailable("read_failed")))
}

/// The local copy of the conversation of the `agent` tab with launch id
/// `launch_id` that runs on `host_id` of the remote project `project_id`,
/// first grown by what the host appended — what the Reader, the phone's Focus
/// chat and the tab cards' prompt lines and model tag all read. `None` when
/// `project_id` names no remote project (or no such host).
pub async fn host_tab_copy(
    pool: &RemotePoolState,
    agent: &str,
    project_id: &str,
    host_id: &str,
    launch_id: &str,
) -> Option<HostCopy> {
    let target = crate::services::remote::remote_target_for_host(project_id, host_id)?;
    if agent != "claude" {
        return Some(HostCopy::Unavailable("unsupported"));
    }
    if !is_uuid_shaped(launch_id) {
        return Some(HostCopy::Unavailable("no_session"));
    }
    let local = mirror_file(project_id, host_id, launch_id);
    let every = if crate::services::hpc_mode::is_careful_host(&target.spec) { CAREFUL_CHECK_EVERY } else { CHECK_EVERY };
    let mut mirrors = MIRRORS.lock().await;
    let mirror = mirrors.entry(mirror_key(project_id, host_id, launch_id)).or_default();
    let fresh = mirror.checked.is_some_and(|at| at.elapsed() < every);
    // While the host cannot be asked (the session dropped, a stat failed), a
    // conversation copied before is still the one shown.
    let copy_held = |mirror: &Mirror| mirror.remote.is_some() && local.is_file();
    if !fresh {
        match crate::services::remote::pooled_sftp_host(pool, project_id, host_id).await {
            Some(sftp) => {
                mirror.checked = Some(Instant::now());
                if let Err(reason) = sync(&sftp, mirror, &target.spec.remote_path, project_id, launch_id, &local).await {
                    if !copy_held(mirror) {
                        return Some(HostCopy::Unavailable(reason));
                    }
                }
            }
            None if copy_held(mirror) => {}
            None => return Some(HostCopy::Unavailable("disconnected")),
        }
    }
    Some(if mirror.remote.is_none() { HostCopy::NotYet } else { HostCopy::At(local) })
}

/// The [`MIRRORS`] entry of one host tab.
fn mirror_key(project_id: &str, host_id: &str, launch_id: &str) -> String {
    format!("{}\n{}\n{launch_id}", crate::storage::project_key(project_id), crate::storage::project_key(host_id))
}

/// Forget what is known of the host tab's conversation: the tab's
/// conversation was just taken to or from that host
/// (`services::agent_host_move`), so the next read finds it afresh.
pub async fn forget(project_id: &str, host_id: &str, launch_id: &str) {
    MIRRORS.lock().await.remove(&mirror_key(project_id, host_id, launch_id));
}

/// The session the tab launched as `launch_id` runs on the host now, and the
/// folder it runs in. Claude keeps a `~/.claude/sessions/<pid>.json` per
/// running CLI naming the session it is on, and the tab's CLI carries the
/// launch id in its environment (`TAB_UID`, which `ssh_exec::remote_command`
/// exports). Both are read over SFTP — the environment from
/// `/proc/<pid>/environ` — so nothing runs on the host. `None` when no running
/// CLI of the tab is found: it exited, or the host has no readable `/proc`.
pub(crate) async fn running_session(sftp: &Sftp, launch_id: &str) -> Option<(String, String)> {
    let entries = crate::services::sftp::list_dir_raw_on(sftp, SESSIONS).await.ok()?;
    let pids = entries.iter().filter_map(|entry| {
        let pid = entry.name.strip_suffix(".json")?;
        let record = matches!(entry.kind, SyncKind::File) && entry.size <= MAX_SESSION_RECORD_BYTES;
        (record && !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())).then_some(pid)
    });
    let mut best: Option<SessionRecord> = None;
    for pid in pids.take(MAX_SESSION_RECORDS) {
        let Ok(environ) = crate::services::sftp::read_file_on(sftp, &format!("/proc/{pid}/environ")).await else {
            continue;
        };
        if !runs_tab(&environ, launch_id) {
            continue;
        }
        let Ok(bytes) = crate::services::sftp::read_file_on(sftp, &format!("{SESSIONS}/{pid}.json")).await else {
            continue;
        };
        let Some(record) = session_record(&bytes) else {
            continue;
        };
        // A relaunch leaves the old CLI's record behind it for a moment.
        if best.as_ref().is_none_or(|known| record.updated_at > known.updated_at) {
            best = Some(record);
        }
    }
    best.map(|record| (record.session_id, record.cwd))
}

/// What a `~/.claude/sessions/<pid>.json` says of its CLI.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    updated_at: u64,
}

/// `bytes` as a session record, when it names a uuid-shaped session (it is
/// the host's file: its id becomes a path component).
fn session_record(bytes: &[u8]) -> Option<SessionRecord> {
    serde_json::from_slice::<SessionRecord>(bytes).ok().filter(|record| is_uuid_shaped(&record.session_id))
}

/// Whether the NUL-separated environment `environ` is the one of a CLI the tab
/// launched as `launch_id` started.
fn runs_tab(environ: &[u8], launch_id: &str) -> bool {
    let marker = format!("{}={launch_id}", crate::app_env!("TAB_UID"));
    environ.split(|b| *b == 0).any(|var| var == marker.as_bytes())
}

/// The transcript names to look for: the session the host's CLI said it is
/// on, else the live id recorded here — a tab moved onto the host runs on the
/// id of its local run — and the launch id.
fn candidates(mirror: &Mirror, project_id: &str, launch_id: &str) -> Vec<String> {
    if let Some(session) = &mirror.session {
        return vec![format!("{session}.jsonl")];
    }
    let live = crate::services::agent_session::read_live_session_for(Some(project_id), launch_id)
        .filter(|id| is_uuid_shaped(id) && id != launch_id);
    live.into_iter().chain([launch_id.to_string()]).map(|id| format!("{id}.jsonl")).collect()
}

/// Find the host transcript if it is not known yet, and copy what it gained
/// into `local`. `Err` carries the reason a read answers with.
async fn sync(
    sftp: &Arc<Sftp>,
    mirror: &mut Mirror,
    project_path: &str,
    project_id: &str,
    launch_id: &str,
    local: &std::path::Path,
) -> Result<(), &'static str> {
    if mirror.asked.is_none_or(|at| at.elapsed() >= SEARCH_EVERY) {
        mirror.asked = Some(Instant::now());
        if let Some((session, cwd)) = running_session(sftp, launch_id).await {
            if mirror.session.as_deref() != Some(session.as_str()) {
                // Another conversation than the one copied: start over.
                mirror.remote = None;
                mirror.copied = 0;
                mirror.searched = None;
                mirror.session = Some(session.clone());
            }
            if mirror.remote.is_none() && !cwd.is_empty() {
                let own = format!("{PROJECTS}/{}/{session}.jsonl", claude_slug(cwd.trim_end_matches('/')));
                if let Ok(Some(_)) = crate::services::sftp::metadata_opt_on(sftp, &own).await {
                    mirror.remote = Some(own);
                }
            }
        }
    }
    if mirror.remote.is_none() {
        let files = candidates(mirror, project_id, launch_id);
        mirror.remote = locate(sftp, mirror, project_path, &files).await?;
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
    if size > MAX_BYTES {
        return Err("read_failed");
    }
    let held = std::fs::metadata(local).map(|m| m.len()).ok();
    // A copy that is not what this process last wrote (another run's, or
    // trimmed since) is started over, as is a host file that shrank.
    let from = if held == Some(mirror.copied) && size >= mirror.copied { mirror.copied } else { 0 };
    if held.is_some() && from == size {
        return Ok(());
    }
    mirror.copied = copy_range(sftp, &remote, local, from, size).await.map_err(|_| "read_failed")?;
    Ok(())
}

/// The host path (relative to the login's home) of the first transcript of
/// `files` found: in the project folder's own slug folder, else — at most
/// every [`SEARCH_EVERY`] — in any folder of `~/.claude/projects`.
async fn locate(sftp: &Sftp, mirror: &mut Mirror, project_path: &str, files: &[String]) -> Result<Option<String>, &'static str> {
    let slug = claude_slug(project_path.trim_end_matches('/'));
    for file in files {
        let own = format!("{PROJECTS}/{slug}/{file}");
        match crate::services::sftp::metadata_opt_on(sftp, &own).await {
            Ok(Some(_)) => return Ok(Some(own)),
            Ok(None) => {}
            Err(_) => return Err("read_failed"),
        }
    }
    if mirror.searched.is_some_and(|at| at.elapsed() < SEARCH_EVERY) {
        return Ok(None);
    }
    mirror.searched = Some(Instant::now());
    let dirs = match crate::services::sftp::list_dir_raw_on(sftp, PROJECTS).await {
        Ok(entries) => entries,
        // No `~/.claude/projects` yet: Claude has stored nothing on this host.
        Err(_) => return Ok(None),
    };
    let dirs = dirs.iter().filter(|e| matches!(e.kind, SyncKind::Dir));
    for dir in dirs.take(MAX_SEARCHED_DIRS) {
        for file in files {
            let path = format!("{PROJECTS}/{}/{file}", dir.name);
            if let Ok(Some(_)) = crate::services::sftp::metadata_opt_on(sftp, &path).await {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

/// Copy bytes `from..size` of the host file `remote` into `local` — appended,
/// or the whole file afresh when `from` is 0 — answering how many bytes the
/// copy holds afterwards.
async fn copy_range(sftp: &Sftp, remote: &str, local: &std::path::Path, from: u64, size: u64) -> Result<u64, String> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let mut source = sftp.open(remote).await.map_err(|e| format!("sftp open failed: {e}"))?;
    source.seek(std::io::SeekFrom::Start(from)).await.map_err(|e| e.to_string())?;
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true);
    if from == 0 {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    let mut sink = options.open(local).await.map_err(|e| e.to_string())?;
    let mut copied = from;
    while copied < size {
        let want = CHUNK.min(u32::try_from(size - copied).unwrap_or(CHUNK));
        let Some(chunk) = source.read(want, bytes::BytesMut::with_capacity(want as usize)).await.map_err(|e| e.to_string())? else {
            break;
        };
        if chunk.is_empty() {
            break;
        }
        sink.write_all(&chunk).await.map_err(|e| e.to_string())?;
        copied += chunk.len() as u64;
    }
    sink.flush().await.map_err(|e| e.to_string())?;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slug_is_claudes_folder_name_for_a_cwd() {
        assert_eq!(claude_slug("/home/me/work/my.proj"), "-home-me-work-my-proj");
        assert_eq!(claude_slug("/srv/p_1"), "-srv-p-1");
    }

    #[test]
    fn a_cli_is_the_tabs_by_its_launch_id_in_its_environment() {
        let id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
        let var = format!("{}={id}", crate::app_env!("TAB_UID"));
        let environ = format!("HOME=/home/me\0{var}\0TERM=xterm\0");
        assert!(runs_tab(environ.as_bytes(), id));
        assert!(runs_tab(var.as_bytes(), id), "the last variable has no trailing NUL");
        assert!(!runs_tab(format!("{var}0\0").as_bytes(), id), "a longer value is another tab's");
        assert!(!runs_tab(format!("X{var}\0").as_bytes(), id), "another variable's value");
        assert!(!runs_tab(b"", id));
    }

    #[test]
    fn a_session_record_names_a_uuid_session() {
        let id = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
        let record = session_record(format!(r#"{{"pid":7,"sessionId":"{id}","cwd":"/srv/p","updatedAt":5,"status":"idle"}}"#).as_bytes()).unwrap();
        assert_eq!((record.session_id.as_str(), record.cwd.as_str(), record.updated_at), (id, "/srv/p", 5));
        assert!(session_record(br#"{"sessionId":"../../etc/passwd"}"#).is_none());
        assert!(session_record(br#"{"cwd":"/srv/p"}"#).is_none());
        assert!(session_record(b"not json").is_none());
    }

    #[test]
    fn the_copy_lives_in_the_projects_session_folder() {
        let id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
        let file = mirror_file("p1", "gpu/2", id);
        assert!(file.starts_with(crate::storage::project_session_dir("p1")));
        assert_eq!(file.file_name().and_then(|n| n.to_str()), Some(format!("{id}.jsonl").as_str()));
        // A host id never names a folder outside its own.
        assert_eq!(file.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()), Some("gpu_2"));
    }
}

//! The stored conversation of a Codex tab that runs on a remote project's
//! host: the thread's rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread
//! id>.jsonl`), copied here as the parent module copies Claude's transcript
//! and read with the parser a local Codex tab's goes through.
//!
//! Which rollout: Codex mints the thread id itself and nothing records it on
//! the host (a local tab's id comes from the app's session hook), so the
//! host's `/proc` is asked, over SFTP only — nothing runs there. The login's
//! own processes (the `/proc` listing's owner, [`login_uid_on`]) whose `comm`
//! is `codex` and whose environment carries the tab's launch id
//! ([`super::runs_tab`]) are the tab's CLI; the rollouts it holds open
//! (`/proc/<pid>/fd`) are its threads. Codex 0.171.0 (`scripts/verify-cli/
//! codex/rollout_fd.py`) creates a thread's rollout with its first turn and
//! keeps it open while the TUI runs — after `/new` the old one too — so the
//! one written last ([`current_rollout`]) is the thread on screen. That holds
//! only for an in-process TUI: a shared `app-server` daemon holds every tab's
//! rollouts with the environment of the tab that started it, so a remote
//! launch turns the daemon off (`launch_prep::keep_remote_codex_in_process`).
//!
//! Bounds: rides the connected pool only (`disconnected` otherwise, a copy
//! held before is still shown); the known process is re-asked at most every
//! [`RECHECK_EVERY`] (or the host's check interval, if longer), a full `/proc`
//! scan runs at most every [`super::SEARCH_EVERY`], reads go out
//! [`PARALLEL`] at a time, and every count and read is capped. With no
//! running CLI found (it exited, or the host has no Linux `/proc`) the rollout
//! found before is still read; one never found leaves a fresh, empty chat.
//! Spawned threads are listed in the host's state store, which is not copied:
//! no subagent cards.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use openssh_sftp_client::Sftp;

use super::{HostCopy, HostTab};
use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::AgentTranscript;
use crate::services::remote::RemotePoolState;
use crate::services::sftp::{list_owned_names_on, login_uid_on, read_file_up_to, read_link_on};

/// How often the process found before is asked again which rollouts it holds
/// (a `/new`, the first turn's rollout appearing).
const RECHECK_EVERY: Duration = Duration::from_secs(6);
/// The most of the login's processes one scan looks at, the most `codex`
/// ones whose environment it reads, and the most open files it reads per CLI.
const MAX_OWN_PROCS: usize = 4096;
const MAX_CODEX_PROCS: usize = 64;
const MAX_FDS: usize = 512;
/// How many SFTP reads one scan keeps in flight.
const PARALLEL: usize = 32;
/// A `/proc/<pid>/comm` is at most 16 bytes.
const MAX_COMM_BYTES: u64 = 64;

/// What is known about one host Codex tab between reads.
#[derive(Default)]
struct Mirror {
    /// The rollout's path on the host, once found.
    remote: Option<String>,
    /// How many of its bytes the local copy holds.
    copied: u64,
    /// When the host was last asked whether it grew.
    checked: Option<Instant>,
    /// The tab's CLI on the host, once found.
    pid: Option<String>,
    /// When its rollouts were last asked for, and when `/proc` was last scanned.
    asked: Option<Instant>,
    scanned: Option<Instant>,
}

static MIRRORS: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Mirror>>> =
    std::sync::LazyLock::new(Default::default);

/// [`super::host_tab_transcript`] of a Codex tab.
pub(super) async fn host_transcript(
    tab: &HostTab<'_>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    if subagent.is_some() {
        return AgentTranscript::unavailable("no_subagent");
    }
    let local = match host_copy(tab.pool, tab.project_id, tab.host_id, tab.launch_id).await {
        HostCopy::Unavailable(reason) => return AgentTranscript::unavailable(reason),
        // No rollout yet: Codex writes it with the first turn.
        HostCopy::NotYet => {
            return AgentTranscript { available: true, version: Some(format!("new:{}", tab.launch_id)), ..Default::default() }
        }
        HostCopy::At(local) => local,
    };
    let version = version.map(str::to_string);
    app_core::rt::spawn_blocking(move || {
        crate::services::agent_transcript::codex_host_transcript_at(&local, version.as_deref(), limit)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| AgentTranscript::unavailable("read_failed"))
}

/// Where the local copy of the host Codex tab `launch_id`'s rollout lives.
fn mirror_file(project_id: &str, host_id: &str, launch_id: &str) -> PathBuf {
    super::host_dir(project_id, host_id).join(format!("codex-{launch_id}.jsonl"))
}

/// The local copy of the host Codex tab's rollout, grown first — what the
/// Chat and the tab cards read ([`super::host_tab_copy`]).
pub(super) async fn host_copy(pool: &RemotePoolState, project_id: &str, host_id: &str, launch_id: &str) -> HostCopy {
    let Some(target) = crate::services::remote::remote_target_for_host(project_id, host_id) else {
        return HostCopy::Unavailable("disconnected");
    };
    if !is_uuid_shaped(launch_id) {
        return HostCopy::Unavailable("no_session");
    }
    let local = mirror_file(project_id, host_id, launch_id);
    let every = super::check_every(&target.spec);
    let mut mirrors = MIRRORS.lock().await;
    let mirror = mirrors.entry(super::mirror_key(project_id, host_id, launch_id)).or_default();
    let held = |mirror: &Mirror| mirror.remote.is_some() && local.is_file();
    if !mirror.checked.is_some_and(|at| at.elapsed() < every) {
        match crate::services::remote::pooled_sftp_host(pool, project_id, host_id).await {
            Some(sftp) => {
                mirror.checked = Some(Instant::now());
                if let Err(reason) = sync(&sftp, mirror, launch_id, &local, every.max(RECHECK_EVERY)).await {
                    if !held(mirror) {
                        return HostCopy::Unavailable(reason);
                    }
                }
            }
            None if held(mirror) => {}
            None => return HostCopy::Unavailable("disconnected"),
        }
    }
    if mirror.remote.is_none() { HostCopy::NotYet } else { HostCopy::At(local) }
}

/// Learn which rollout the tab is on (at most every `recheck`), and copy what
/// it gained into `local`. `Err` carries the reason a read answers with.
async fn sync(sftp: &Sftp, mirror: &mut Mirror, launch_id: &str, local: &std::path::Path, recheck: Duration) -> Result<(), &'static str> {
    if mirror.asked.is_none_or(|at| at.elapsed() >= recheck) {
        mirror.asked = Some(Instant::now());
        let mut found = match mirror.pid.clone() {
            Some(pid) => tab_rollouts(sftp, &pid, launch_id).await.map(|rollouts| (pid, rollouts)),
            None => None,
        };
        if found.is_none() && mirror.scanned.is_none_or(|at| at.elapsed() >= super::SEARCH_EVERY) {
            mirror.scanned = Some(Instant::now());
            found = scan(sftp, launch_id).await;
        }
        mirror.pid = found.as_ref().map(|(pid, _)| pid.clone());
        if let Some(current) = found.and_then(|(_, rollouts)| rollouts) {
            if mirror.remote.as_deref() != Some(current.as_str()) {
                // Another thread than the one copied (a `/new`): start over.
                mirror.remote = Some(current);
                mirror.copied = 0;
            }
        }
    }
    let Some(remote) = mirror.remote.clone() else {
        return Ok(());
    };
    let size = match crate::services::sftp::metadata_opt_on(sftp, &remote).await {
        Ok(Some((size, _))) => size,
        // Deleted on the host: nothing to grow; the copy stays what it was.
        Ok(None) => return Ok(()),
        Err(_) => return Err("read_failed"),
    };
    if size > super::MAX_BYTES {
        return Err("read_failed");
    }
    mirror.copied = super::grow(sftp, &remote, local, size, mirror.copied).await.map_err(|_| "read_failed")?;
    Ok(())
}

/// The tab's CLI among the login's processes, with the rollout it is on
/// ([`tab_rollouts`]). `None` when none is found.
async fn scan(sftp: &Sftp, launch_id: &str) -> Option<(String, Option<String>)> {
    let uid = login_uid_on(sftp).await?;
    let pids = list_owned_names_on(sftp, "/proc", uid, MAX_OWN_PROCS).await.ok()?;
    let pids = pids.into_iter().filter(|name| is_pid(name));
    let codex: Vec<String> = futures_util::stream::iter(pids)
        .map(|pid| async move {
            let comm = read_file_up_to(sftp, &format!("/proc/{pid}/comm"), MAX_COMM_BYTES).await.ok().flatten()?;
            is_codex_comm(&comm).then_some(pid)
        })
        .buffer_unordered(PARALLEL)
        .filter_map(std::future::ready)
        .take(MAX_CODEX_PROCS)
        .collect()
        .await;
    for pid in codex {
        if let Some(rollouts) = tab_rollouts(sftp, &pid, launch_id).await {
            return Some((pid, rollouts));
        }
    }
    None
}

/// Whether `/proc` entry `name` is a process.
fn is_pid(name: &str) -> bool {
    !name.is_empty() && name.len() <= 10 && name.bytes().all(|b| b.is_ascii_digit())
}

/// Whether a `/proc/<pid>/comm` names Codex's native binary: `codex`, or a
/// release asset run under its own name (`codex-x86_64-unknown-linux-musl`,
/// which `comm` cuts to 15 bytes).
fn is_codex_comm(comm: &[u8]) -> bool {
    let comm = comm.strip_suffix(b"\n").unwrap_or(comm);
    comm == b"codex" || comm.starts_with(b"codex-x86_64") || comm.starts_with(b"codex-aarch64")
}

/// For the process `pid`, when it is the tab's CLI (its environment carries
/// `launch_id`): the host path of the rollout it is on — the one of its open
/// rollouts written last — or `Some(None)` before its first turn wrote one.
/// `None` when it is not the tab's, or no longer runs.
async fn tab_rollouts(sftp: &Sftp, pid: &str, launch_id: &str) -> Option<Option<String>> {
    let environ = read_file_up_to(sftp, &format!("/proc/{pid}/environ"), super::MAX_ENVIRON_BYTES).await.ok().flatten()?;
    if !super::runs_tab(&environ, launch_id) {
        return None;
    }
    let fd_dir = format!("/proc/{pid}/fd");
    let fds = crate::services::sftp::list_dir_raw_on(sftp, &fd_dir).await.ok()?;
    let links: Vec<String> = futures_util::stream::iter(fds.into_iter().take(MAX_FDS))
        .map(|fd| {
            let path = format!("{fd_dir}/{}", fd.name);
            async move { read_link_on(sftp, &path).await.ok() }
        })
        .buffer_unordered(PARALLEL)
        .filter_map(|link| std::future::ready(link.filter(|link| rollout_thread(link).is_some())))
        .collect()
        .await;
    let mut written = Vec::new();
    for link in links {
        if let Ok(Some((_, modified))) = crate::services::sftp::metadata_opt_on(sftp, &link).await {
            written.push((link, modified));
        }
    }
    Some(current_rollout(written))
}

/// The thread id of a rollout path an open file of the CLI names: an
/// absolute `…/sessions/YYYY/MM/DD/rollout-<stamp>-<thread id>.jsonl` with no
/// `..`, whose id is uuid-shaped. `None` for any other file (its log, a
/// socket, a `(deleted)` one).
fn rollout_thread(link: &str) -> Option<&str> {
    if !link.starts_with('/') || link.split('/').any(|part| part == ".." || part == ".") {
        return None;
    }
    let mut parts = link.rsplit('/');
    let name = parts.next()?;
    let (day, month, year, sessions) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let digits = |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
    if sessions != "sessions" || !digits(year, 4) || !digits(month, 2) || !digits(day, 2) {
        return None;
    }
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    // The id is the last 36 characters; the stamp before it ends in `-`.
    let at = stem.len().checked_sub(36)?;
    let (stamp, id) = (stem.get(..at)?, stem.get(at..)?);
    (stamp.ends_with('-') && is_uuid_shaped(id)).then_some(id)
}

/// Of the rollouts a CLI holds open, with when each was last written, the
/// thread it is on: the one written last, the newer name (its stamp) on a tie.
fn current_rollout(mut rollouts: Vec<(String, Option<u64>)>) -> Option<String> {
    rollouts.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    rollouts.pop().map(|(path, _)| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "019a1f8f-dc2e-7c43-9d1e-3b5e2f1c0a11";

    #[test]
    fn a_rollout_link_names_its_thread() {
        let link = format!("/home/me/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-{ID}.jsonl");
        assert_eq!(rollout_thread(&link), Some(ID));
        let swapped = format!("/scratch/me/agent/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-{ID}.jsonl");
        assert_eq!(rollout_thread(&swapped), Some(ID), "a host agent home elsewhere");
        for other in [
            format!("/home/me/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-{ID}.jsonl (deleted)"),
            format!("/home/me/.codex/sessions/2026/11/../rollout-2026-11-20T13-50-01-{ID}.jsonl"),
            format!("home/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-{ID}.jsonl"),
            format!("/home/me/.codex/log/2026/11/20/rollout-2026-11-20T13-50-01-{ID}.jsonl"),
            format!("/home/me/.codex/sessions/2026/11/20/rollout-{ID}.jsonl"),
            "/home/me/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-../../../../etc/passwd.jsonl".to_string(),
            "/home/me/.codex/log/codex-tui.log".to_string(),
            "socket:[12345]".to_string(),
        ] {
            assert_eq!(rollout_thread(&other), None, "{other}");
        }
    }

    #[test]
    fn the_thread_on_screen_is_the_rollout_written_last() {
        let older = "/h/.codex/sessions/2026/11/20/rollout-2026-11-20T13-50-01-a.jsonl".to_string();
        let newer = "/h/.codex/sessions/2026/11/20/rollout-2026-11-20T13-55-09-b.jsonl".to_string();
        // After `/new` both stay open; the new thread's is written to.
        assert_eq!(current_rollout(vec![(older.clone(), Some(100)), (newer.clone(), Some(200))]), Some(newer.clone()));
        // Resumed into the older one: it is the one written last.
        assert_eq!(current_rollout(vec![(older.clone(), Some(300)), (newer.clone(), Some(200))]), Some(older.clone()));
        assert_eq!(current_rollout(vec![(newer.clone(), Some(5)), (older.clone(), Some(5))]), Some(newer.clone()), "a tie: the newer stamp");
        assert_eq!(current_rollout(vec![(older, None), (newer.clone(), Some(1))]), Some(newer));
        assert_eq!(current_rollout(Vec::new()), None, "before the first turn");
    }

    #[test]
    fn only_codex_processes_are_asked() {
        assert!(is_codex_comm(b"codex\n"));
        assert!(is_codex_comm(b"codex"));
        assert!(!is_codex_comm(b"codex-exec-serv\n"));
        assert!(!is_codex_comm(b"node\n"));
        assert!(is_codex_comm(b"codex-x86_64-un\n"), "a release asset under its own name");
        assert!(is_pid("4711") && !is_pid("self") && !is_pid("") && !is_pid("12345678901"));
    }

    #[test]
    fn the_copy_lives_beside_claudes_under_its_own_prefix() {
        let file = mirror_file("p1", "primary", ID);
        assert!(file.starts_with(crate::storage::project_session_dir("p1")));
        assert_eq!(file.file_name().and_then(|n| n.to_str()), Some(format!("codex-{ID}.jsonl").as_str()));
    }
}

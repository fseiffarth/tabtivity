//! What a tab's running CLI holds open on a remote host, asked over SFTP
//! only: nothing runs there. Used by the CLIs that keep no record naming
//! their conversation (Antigravity, Muse), where the open files name it.
//!
//! A CLI that locks a file of its conversation while it runs (Antigravity's
//! `presence/<id>.lock`, Muse's `.session.lock`) shows up in `/proc/locks`
//! with its pid. Of those pids, the ones whose `/proc/<pid>/environ` carries
//! the tab's launch id (`TAB_UID`, which `ssh_exec::remote_command` exports)
//! are the tab's CLI, and `/proc/<pid>/fd/<n>` links name what it has open.
//! `/proc` is Linux's: a host without it answers "no process found" and the
//! caller falls back to the conversation store itself.
//!
//! Bounds: `/proc/locks` is read up to [`MAX_LOCKS_BYTES`], at most
//! [`MAX_HOLDERS`] pids are looked at, at most [`MAX_FDS`] links of one pid
//! are read (together, not one after the other). A host's files are
//! untrusted: the targets are returned as text for the caller to match by
//! shape, never followed here.

use openssh_sftp_client::Sftp;

use crate::services::remote::remote_transcript::{runs_tab, MAX_ENVIRON_BYTES};

const MAX_LOCKS_BYTES: u64 = 1024 * 1024;
const MAX_HOLDERS: usize = 128;
const MAX_FDS: usize = 256;

/// The pids that hold a `flock` (or an open-file-description lock) in the
/// text of `/proc/locks`, first-seen order, without repeats. Lines read
/// `37: FLOCK  ADVISORY  WRITE 33354 fc:00:190338121 0 EOF`; a waiter has `->`
/// after the number. POSIX locks are left out: every process with a SQLite
/// database open holds some.
pub(super) fn flock_pids(locks: &str) -> Vec<u32> {
    let mut pids: Vec<u32> = Vec::new();
    for line in locks.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(at) = fields.iter().position(|field| matches!(*field, "FLOCK" | "OFDLCK")) else {
            continue;
        };
        // class, ADVISORY|MANDATORY, READ|WRITE, pid
        let Some(pid) = fields.get(at + 3).and_then(|pid| pid.parse::<u32>().ok()).filter(|pid| *pid > 0) else {
            continue;
        };
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

/// The link targets of the open files of every lock-holding process of the
/// tab launched as `launch_id`, in descriptor order. `None` when no such
/// process is found: it exited, or the host has no readable `/proc`.
pub(super) async fn tab_open_files(sftp: &Sftp, launch_id: &str) -> Option<Vec<String>> {
    let locks = crate::services::sftp::read_file_up_to(sftp, "/proc/locks", MAX_LOCKS_BYTES).await.ok()??;
    let mut found = false;
    let mut targets = Vec::new();
    for pid in flock_pids(&String::from_utf8_lossy(&locks)).into_iter().take(MAX_HOLDERS) {
        // `/proc` files list as size 0, so only the read can bound them.
        let Ok(Some(environ)) = crate::services::sftp::read_file_up_to(sftp, &format!("/proc/{pid}/environ"), MAX_ENVIRON_BYTES).await
        else {
            continue;
        };
        if runs_tab(&environ, launch_id) {
            found = true;
            targets.extend(fd_targets(sftp, pid).await);
        }
    }
    found.then_some(targets)
}

/// Where the open descriptors of `pid` point, in descriptor order. The links
/// are read together: one round trip each would be a second on a slow link.
async fn fd_targets(sftp: &Sftp, pid: u32) -> Vec<String> {
    let Ok(entries) = crate::services::sftp::list_dir_raw_on(sftp, &format!("/proc/{pid}/fd")).await else {
        return Vec::new();
    };
    let mut fds: Vec<u32> = entries.iter().filter_map(|entry| entry.name.parse().ok()).collect();
    fds.sort_unstable();
    let reads = fds.into_iter().take(MAX_FDS).map(|fd| {
        let mut fs = sftp.fs();
        async move { fs.read_link(format!("/proc/{pid}/fd/{fd}")).await.ok() }
    });
    futures_util::future::join_all(reads)
        .await
        .into_iter()
        .flatten()
        .filter_map(|target| target.to_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flock_holders_are_the_pids_of_flock_lines() {
        let locks = "\
12: POSIX  ADVISORY  READ 20484 fc:00:189693139 128 128
77: FLOCK  ADVISORY  WRITE 20484 fc:00:189932960 0 EOF
78: -> FLOCK  ADVISORY  WRITE 31 fc:00:189932960 0 EOF
80: FLOCK  ADVISORY  WRITE 20484 00:43:830 0 EOF
81: OFDLCK ADVISORY  READ 77 fc:00:1 0 EOF
82: FLOCK  ADVISORY  WRITE 0 fc:00:2 0 EOF
83: FLOCK  ADVISORY  WRITE nonsense fc:00:2 0 EOF
84: FLOCK
";
        assert_eq!(flock_pids(locks), [20484, 31, 77], "POSIX locks, pid 0 and torn lines are left out");
        assert!(flock_pids("").is_empty());
    }
}

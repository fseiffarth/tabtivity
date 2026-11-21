//! The stored conversation of an OpenCode tab that runs on a remote project's
//! host (see the parent module for the Claude case this mirrors).
//!
//! OpenCode keeps no transcript file: every session, message and part is a row
//! of one SQLite database, `<data home>/opencode/opencode.db` (WAL mode),
//! shared by every OpenCode of the login. The app never runs a command on the
//! host and SFTP takes no SQLite lock, so this keeps a *snapshot* of the
//! database in the project's session folder, laid out like an agent home
//! (`.local/share/opencode/opencode.db` + `-wal`, which is what
//! [`crate::services::opencode_store`] opens), and reads that with the reader a
//! local tab uses. Every session of the host's database is in the snapshot, so
//! a subagent's conversation is read from it exactly as locally.
//!
//! A consistent snapshot. In WAL mode the database file is only ever changed by
//! a checkpoint, which copies pages that are *also* in the WAL; a reader sees
//! each page's newest frame, else the file's. So the database copied first and
//! the WAL's committed frames copied after it are one consistent state, as long
//! as the WAL did not *restart* in between (a restart is a new generation: its
//! header salts and sequence change, and the file below it holds pages the old
//! frames no longer cover). The *base* ([`fetch_base`]) is therefore: the WAL
//! header and the database's size and stamp, the database whole, the WAL, then
//! both observed again — kept only when nothing moved, else tried again. After
//! it the WAL is followed incrementally ([`extend`]): a WAL is append-only
//! within a generation, but its *file* is not its content — a restarted WAL is
//! rewritten in place over the old, longer one, so its size and mtime say
//! nothing. What counts is the frames whose salts match the header and whose
//! checksum chain holds ([`scan_frames`], SQLite's own rule), up to the last
//! commit frame; those are appended to the local WAL, and a poll that finds
//! nothing new costs two stats and two small reads (the header, one frame).
//!
//! The host restarts its WAL after every full checkpoint (OpenCode checkpoints
//! often: a few turns apart), and a new generation is no continuation of the old
//! one. When it is the very next one (sequence and first salt one up), the
//! snapshot is carried across without the database ([`bridge`]): the host's
//! checkpoint copied exactly the old generation's frames into its database, those
//! the snapshot lacks are still in the file below the new generation's progress
//! (read while the chain they form is intact and ends at another generation's
//! stale frame — a slot that could hide more is refused), and writing them into
//! the snapshot's own database copy is that checkpoint ([`checkpoint_local`]).
//! Anything the bridge cannot prove (two restarts, the host's new frames already
//! over the slot, the WAL gone, the database moved) needs a new base, which is a
//! whole database again: fetched in the background at most every [`BASE_EVERY`]
//! ([`CAREFUL_BASE_EVERY`] on a careful or HPC host), the Reader keeping the last
//! snapshot meanwhile (stale, never torn). A snapshot kept up by following is
//! also made afresh every [`HEAL_EVERY`]. The database is bounded by
//! [`MAX_DB_BYTES`], a poll's WAL intake by [`WAL_PER_POLL`], a WAL's frames by
//! [`MAX_WAL_BYTES`]; over any of those a read answers `read_failed` (or keeps
//! what it held).
//!
//! Which session: no hook records on the host, and the sessions of a login are
//! all in the one database, so the tab's own is chosen as a local tab without a
//! plugin record is: the newest top-level session of the tab's folder, created
//! since the tab was opened when it was opened fresh. `since` is the local
//! clock, the session's stamp the host's, so the tab's CLI is looked for in the
//! host's `/proc` (its environment carries the tab's launch id, as for Claude)
//! and its start moment on the *host's* clock — `/proc/<pid>/stat` against
//! `/proc/stat`'s `btime` — replaces `since`; with no process to ask, `since`
//! is used less [`SKEW_SLACK_MS`]. The same process says where the store is
//! (`XDG_DATA_HOME`, `HOME`, `OPENCODE_DB` of its environment; else below the
//! host's agent home, else the login's home) and the folder it really runs in
//! (`/proc/<pid>/cwd`, for a project folder reached through a link).
//! Two OpenCode tabs in one folder cannot be told apart (nothing on the host
//! names a tab's session), so each shows the folder's newest session created
//! since *its* start.
//!
//! Bounds as in the parent: only over a connected pool, never dialing; the host
//! is asked at most every `check_every`, the process list at most every
//! [`SEARCH_EVERY`] (a gone process's tab every four of them). The host's files
//! are untrusted: the launch id is uuid-shaped before it names a local folder,
//! the local database is opened by the guarded opener of `agent_sqlite`, and
//! the snapshot folder is the app's own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use openssh_sftp_client::Sftp;

use super::{check_every, copy_range, host_dir, mirror_key, runs_tab, under, HostTab, MAX_BYTES, MAX_ENVIRON_BYTES, SEARCH_EVERY};
use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::AgentTranscript;

/// The store below the data home (`$XDG_DATA_HOME`, else `$HOME/.local/share`).
const STORE_REL: &str = "opencode/opencode.db";
/// The store below a login's home, where the CLI puts it with no `XDG_DATA_HOME`.
const HOME_STORE_REL: &str = ".local/share/opencode/opencode.db";
/// The largest database copied: a base past it answers `read_failed`.
const MAX_DB_BYTES: u64 = MAX_BYTES;
/// The most bytes of committed WAL frames one snapshot holds, and one poll takes in.
const MAX_WAL_BYTES: u64 = 256 * 1024 * 1024;
const WAL_PER_POLL: u64 = 64 * 1024 * 1024;
/// One read of the WAL while it is followed (rounded down to whole frames).
const WAL_READ: usize = 1024 * 1024;
/// How often a changed WAL generation may cost a whole database again.
const BASE_EVERY: Duration = Duration::from_secs(60);
const CAREFUL_BASE_EVERY: Duration = Duration::from_secs(600);
/// How soon a first base that failed is tried again.
const FIRST_RETRY: Duration = Duration::from_secs(15);
/// A snapshot followed by bridging and extending is copied whole again at least this often.
const HEAL_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Tries at one base before it is given up for this poll.
const BASE_TRIES: usize = 3;
/// The most `/proc` entries one scan reads, and how many at once.
const MAX_PROCS: usize = 2000;
const PROC_PARALLEL: usize = 16;
/// The CLI started before it created its session; a clock reading of it is
/// only seconds exact.
const START_SLACK_MS: i64 = 5_000;
/// The host's clock against this machine's, when no process gives the start.
const SKEW_SLACK_MS: i64 = 120_000;
/// Linux's `USER_HZ`: `/proc/<pid>/stat` counts start time in 1/100 s.
const CLOCK_TICKS: u64 = 100;

// ---- the WAL: SQLite's file format, read ------------------------------------

const WAL_HEADER: usize = 32;
const FRAME_HEADER: usize = 24;
/// A WAL's magic is this, its low bit set when its checksums read big-endian words.
const WAL_MAGIC: u32 = 0x377f_0682;
const WAL_VERSION: u32 = 3_007_000;

/// The 32 bytes a WAL opens with. Two WALs with the same bytes are one
/// generation: a restart draws new salts and counts the sequence up.
#[derive(Clone, Debug, PartialEq, Eq)]
struct WalHeader {
    raw: [u8; WAL_HEADER],
    big_endian: bool,
    page: usize,
    seq: u32,
    salt: [u32; 2],
    sum: [u32; 2],
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// SQLite's WAL checksum of `data` (a whole number of 8-byte pairs), chained from `seed`.
fn wal_sum(big_endian: bool, data: &[u8], seed: [u32; 2]) -> [u32; 2] {
    let word = |b: &[u8]| {
        let b = [b[0], b[1], b[2], b[3]];
        if big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
    };
    let [mut s0, mut s1] = seed;
    let (pairs, _) = data.as_chunks::<8>();
    for pair in pairs {
        s0 = s0.wrapping_add(word(&pair[..4])).wrapping_add(s1);
        s1 = s1.wrapping_add(word(&pair[4..])).wrapping_add(s0);
    }
    [s0, s1]
}

/// `bytes` as a WAL header, when it is one: the magic and version, a power-of-two
/// page size, and its own checksum.
fn parse_wal_header(bytes: &[u8]) -> Option<WalHeader> {
    let raw: [u8; WAL_HEADER] = bytes.get(..WAL_HEADER)?.try_into().ok()?;
    let magic = be32(&raw[0..]);
    let page = be32(&raw[8..]) as usize;
    if magic & !1 != WAL_MAGIC || be32(&raw[4..]) != WAL_VERSION || !(512..=65536).contains(&page) || !page.is_power_of_two() {
        return None;
    }
    let big_endian = magic & 1 == 1;
    let sum = [be32(&raw[24..]), be32(&raw[28..])];
    (wal_sum(big_endian, &raw[..24], [0, 0]) == sum).then_some(WalHeader {
        raw,
        big_endian,
        page,
        seq: be32(&raw[12..]),
        salt: [be32(&raw[16..]), be32(&raw[20..])],
        sum,
    })
}

/// Why [`scan_frames`] stopped.
#[derive(Debug, PartialEq, Eq)]
enum End {
    /// No whole frame left in the bytes.
    Bytes,
    /// The next frame carries other salts than the header's (the stale tail of
    /// an earlier generation, or a later one's frames), these.
    Salt([u32; 2]),
    /// The salts fit and the checksum does not: a frame being written, or damage.
    Sum,
}

/// What [`scan_frames`] found at the front of a run of frames.
#[derive(Debug, PartialEq, Eq)]
struct Scan {
    end: End,
    /// Bytes of valid frames, whole frames only.
    frames_end: usize,
    /// Of those, up to the last commit frame.
    commit_end: usize,
    /// The checksum after the valid frames, and after the committed ones.
    sum: [u32; 2],
    commit_sum: [u32; 2],
}

/// The frames of `bytes`, which starts at a frame boundary whose checksum is
/// `seed`, that SQLite would take: salts equal the header's, the checksum
/// chain holds. It stops at the first frame that fails either — the stale
/// tail of an earlier generation, a frame being written — and at a short frame.
fn scan_frames(header: &WalHeader, bytes: &[u8], seed: [u32; 2]) -> Scan {
    let size = FRAME_HEADER + header.page;
    let (mut off, mut commit_end) = (0, 0);
    let (mut sum, mut commit_sum) = (seed, seed);
    let mut end = End::Bytes;
    while off + size <= bytes.len() {
        let frame = &bytes[off..off + size];
        let salt = [be32(&frame[8..]), be32(&frame[12..])];
        if salt != header.salt {
            end = End::Salt(salt);
            break;
        }
        let next = wal_sum(header.big_endian, &frame[FRAME_HEADER..], wal_sum(header.big_endian, &frame[..8], sum));
        if next != [be32(&frame[16..]), be32(&frame[20..])] {
            end = End::Sum;
            break;
        }
        (sum, off) = (next, off + size);
        // A commit frame names the database's size after it.
        if be32(&frame[4..]) != 0 {
            (commit_end, commit_sum) = (off, sum);
        }
    }
    Scan { end, frames_end: off, commit_end, sum, commit_sum }
}

// ---- the host, as far as the snapshot needs it -------------------------------

/// The three things the snapshot asks of a host's files; the SFTP session
/// answers them, and the tests answer them from a local folder.
trait Host {
    /// Size and mtime (whole seconds) of `path`; `None` when it is not there.
    async fn stat(&self, path: &str) -> Result<Option<(u64, Option<u64>)>, String>;
    /// Up to `max` bytes of `path` from `offset`; short only at its end.
    async fn read(&self, path: &str, offset: u64, max: usize) -> Result<Vec<u8>, String>;
    /// The first `size` bytes of `path`, into the file `local`.
    async fn fetch(&self, path: &str, local: &Path, size: u64) -> Result<(), String>;
}

impl Host for Sftp {
    async fn stat(&self, path: &str) -> Result<Option<(u64, Option<u64>)>, String> {
        crate::services::sftp::metadata_opt_on(self, path).await
    }

    async fn read(&self, path: &str, offset: u64, max: usize) -> Result<Vec<u8>, String> {
        crate::services::sftp::read_range_on(self, path, offset, max).await
    }

    async fn fetch(&self, path: &str, local: &Path, size: u64) -> Result<(), String> {
        match copy_range(self, path, local, 0, size).await? {
            copied if copied == size => Ok(()),
            copied => Err(format!("{path} ended at {copied} of {size} bytes")),
        }
    }
}

/// What the host's database and WAL looked like at one moment.
#[derive(Debug, PartialEq, Eq)]
struct Observed {
    wal: Option<WalHeader>,
    db: (u64, Option<u64>),
}

/// Look at the host's database and WAL. `Err` carries the reason a read
/// answers with: no database (`no_transcript`), one past the bound, a WAL
/// whose header is not a header (being written — try again).
async fn observe<H: Host>(host: &H, db: &str, wal: &str) -> Result<Observed, &'static str> {
    let db_stat = match host.stat(db).await {
        Ok(Some((size, mtime))) if size > 0 => (size, mtime),
        Ok(_) => return Err("no_transcript"),
        Err(_) => return Err("read_failed"),
    };
    if db_stat.0 > MAX_DB_BYTES {
        return Err("read_failed");
    }
    // A WAL with no header (absent, or truncated to nothing) is no WAL.
    let wal = match host.stat(wal).await {
        Ok(Some((size, _))) if size >= WAL_HEADER as u64 => {
            let head = host.read(wal, 0, WAL_HEADER).await.map_err(|_| "read_failed")?;
            Some(parse_wal_header(&head).ok_or("read_failed")?)
        }
        Ok(_) => None,
        Err(_) => return Err("read_failed"),
    };
    Ok(Observed { wal, db: db_stat })
}

/// What [`read_frames`] took in.
struct Frames {
    /// The valid frames up to the last commit.
    committed: Vec<u8>,
    /// The checksum after them.
    sum: [u32; 2],
    /// Why the chain of valid frames ended; `Bytes` also when the budget did.
    end: End,
}

/// The frames of the host WAL from byte `from` (a frame boundary, `seed` the
/// checksum there) on that are valid under `header`, at most about `budget`
/// bytes of them. They are read a window at a time and kept only up to the last
/// commit: a transaction in the middle of being written is read again next time.
async fn read_frames<H: Host>(host: &H, wal: &str, header: &WalHeader, from: u64, seed: [u32; 2], budget: u64) -> Result<Frames, String> {
    let size = FRAME_HEADER + header.page;
    let window = (WAL_READ / size).max(1) * size;
    let (mut frames, mut sum) = (Vec::new(), seed);
    let (mut committed, mut commit_sum) = (0, seed);
    let mut end = End::Bytes;
    // One frame first: a poll that finds nothing new (the stale tail of an
    // earlier generation, or the end of the file) reads no more than that.
    let mut want = size;
    while (frames.len() as u64) < budget {
        let chunk = host.read(wal, from + frames.len() as u64, want).await?;
        let scan = scan_frames(header, &chunk, sum);
        if scan.commit_end > 0 {
            committed = frames.len() + scan.commit_end;
            commit_sum = scan.commit_sum;
        }
        frames.extend_from_slice(&chunk[..scan.frames_end]);
        sum = scan.sum;
        // Short of what was asked: the end of the valid frames, or of the file.
        if scan.frames_end < want {
            end = scan.end;
            break;
        }
        want = window;
    }
    frames.truncate(committed);
    Ok(Frames { committed: frames, sum: commit_sum, end })
}

/// [`read_frames`] of what a generation still on the host's disk holds after
/// `from`, once the host has *restarted* the WAL (`new` is the header now): the
/// frames the host checkpointed into its database that were never copied here.
/// `None` unless that is provably all of them — the first slot the chain does not
/// cover must hold the stale frames of some other, earlier generation. A slot
/// with `old`'s salts that fails its checksum is a frame being overwritten, one
/// with `new`'s salts is already overwritten, and the end of the file may be a
/// truncated WAL: each could hide frames, so each is `None`.
async fn read_tail<H: Host>(host: &H, wal: &str, old: &WalHeader, new: &WalHeader, from: u64, seed: [u32; 2]) -> Result<Option<Frames>, String> {
    let frames = read_frames(host, wal, old, from, seed, WAL_PER_POLL).await?;
    Ok(match frames.end {
        End::Salt(salt) if salt != old.salt && salt != new.salt => Some(frames),
        _ => None,
    })
}

// ---- the local snapshot -------------------------------------------------------

/// What the local copy of the host's WAL holds.
#[derive(Clone, Debug)]
struct WalCopy {
    header: WalHeader,
    /// Bytes of the local file: the header and the committed frames after it.
    committed: u64,
    /// The checksum after the last of them.
    sum: [u32; 2],
}

/// A consistent copy of the host's database, laid out like an agent home below `dir`.
#[derive(Clone, Debug)]
struct Snapshot {
    dir: PathBuf,
    /// The host database's size and mtime when it was copied, or last seen.
    db: (u64, Option<u64>),
    wal: Option<WalCopy>,
    /// When the database was last copied whole.
    based: Instant,
}

fn db_file(dir: &Path) -> PathBuf {
    HOME_STORE_REL.split('/').fold(dir.to_path_buf(), |path, part| path.join(part))
}

fn wal_file(dir: &Path) -> PathBuf {
    db_file(dir).with_file_name("opencode.db-wal")
}

fn io_err(error: std::io::Error) -> &'static str {
    // The reason is all a read says; the folder is the app's own.
    let _ = error;
    "read_failed"
}

/// Copy the host's database and WAL into a snapshot in `stage` (emptied first).
async fn fetch_base<H: Host>(host: &H, db: &str, wal: &str, stage: &Path) -> Result<Snapshot, &'static str> {
    for _ in 0..BASE_TRIES {
        let before = observe(host, db, wal).await?;
        let _ = tokio::fs::remove_dir_all(stage).await;
        let local = db_file(stage);
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(io_err)?;
        }
        host.fetch(db, &local, before.db.0).await.map_err(|_| "read_failed")?;
        let copy = match &before.wal {
            Some(header) => {
                let frames = read_frames(host, wal, header, WAL_HEADER as u64, header.sum, WAL_PER_POLL.min(MAX_WAL_BYTES))
                    .await
                    .map_err(|_| "read_failed")?;
                let mut bytes = header.raw.to_vec();
                bytes.extend_from_slice(&frames.committed);
                tokio::fs::write(wal_file(stage), &bytes).await.map_err(io_err)?;
                Some(WalCopy { header: header.clone(), committed: bytes.len() as u64, sum: frames.sum })
            }
            None => None,
        };
        // Nothing moved while the files were copied: they are one state.
        if observe(host, db, wal).await.is_ok_and(|after| after == before) {
            return Ok(Snapshot { dir: stage.to_path_buf(), db: before.db, wal: copy, based: Instant::now() });
        }
    }
    Err("read_failed")
}

/// What a poll does about the host's current state.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// The snapshot is the host's state.
    Hold,
    /// The same WAL generation: append its new committed frames.
    Extend,
    /// A WAL began since a snapshot with none, on an unchanged database: it
    /// holds everything written since, so follow it.
    Adopt,
    /// The host checkpointed the generation the snapshot follows and restarted
    /// the WAL once: if the frames the snapshot lacks are still on its disk
    /// ([`bridge`]), the snapshot can be brought up to date without the database.
    Bridge,
    /// The WAL restarted or went, or the database moved: copy a new base.
    Rebase,
}

/// Whether `new` is the header SQLite writes at the one restart after `old`: the
/// checkpoint sequence up by one, the first salt up by one (the second is random).
fn restarted_once(old: &WalHeader, new: &WalHeader) -> bool {
    new.seq == old.seq.wrapping_add(1) && new.salt[0] == old.salt[0].wrapping_add(1) && new.page == old.page
}

fn plan(snapshot: Option<&Snapshot>, seen: &Observed) -> Plan {
    let Some(snapshot) = snapshot else {
        return Plan::Rebase;
    };
    // A snapshot kept up by bridging and extending is the app's own work; a base is the host's.
    if snapshot.wal.is_some() && snapshot.based.elapsed() >= HEAL_EVERY {
        return Plan::Rebase;
    }
    match (&snapshot.wal, &seen.wal) {
        (Some(copy), Some(head)) if copy.header == *head => Plan::Extend,
        (Some(copy), Some(head)) if restarted_once(&copy.header, head) => Plan::Bridge,
        (None, None) if snapshot.db == seen.db => Plan::Hold,
        // A fresh WAL (sequence 0) on the database as copied: no checkpoint ran in between.
        (None, Some(head)) if head.seq == 0 && snapshot.db == seen.db => Plan::Adopt,
        _ => Plan::Rebase,
    }
}

/// Append the host WAL's new committed frames to the snapshot's local WAL.
/// `Err` when the local file is not what the snapshot recorded (the snapshot is
/// then no use); a host that cannot be read leaves it as it was.
async fn extend<H: Host>(host: &H, wal: &str, snapshot: &mut Snapshot) -> Result<(), ()> {
    use tokio::io::AsyncWriteExt;
    let Some(copy) = snapshot.wal.as_mut() else {
        return Ok(());
    };
    let local = wal_file(&snapshot.dir);
    if tokio::fs::metadata(&local).await.map(|m| m.len()).ok() != Some(copy.committed) || copy.committed >= MAX_WAL_BYTES {
        return Err(());
    }
    let Ok(frames) = read_frames(host, wal, &copy.header, copy.committed, copy.sum, WAL_PER_POLL).await else {
        return Ok(());
    };
    if frames.committed.is_empty() {
        return Ok(());
    }
    let mut file = tokio::fs::OpenOptions::new().append(true).open(&local).await.map_err(|_| ())?;
    file.write_all(&frames.committed).await.map_err(|_| ())?;
    file.flush().await.map_err(|_| ())?;
    copy.committed += frames.committed.len() as u64;
    copy.sum = frames.sum;
    Ok(())
}

/// Start following a fresh WAL (see [`Plan::Adopt`]): its header, no frames yet.
async fn adopt(snapshot: &mut Snapshot, head: &WalHeader) -> Result<(), ()> {
    tokio::fs::write(wal_file(&snapshot.dir), head.raw).await.map_err(|_| ())?;
    snapshot.wal = Some(WalCopy { header: head.clone(), committed: WAL_HEADER as u64, sum: head.sum });
    Ok(())
}

/// How [`bridge`] ended.
#[derive(Debug, PartialEq, Eq)]
enum Crossed {
    /// The snapshot follows the new generation.
    Done,
    /// It cannot be shown sound: copy a base.
    Rebase,
    /// The host could not be read: the snapshot is as it was, try again.
    Later,
}

/// Bring the snapshot across a WAL restart (see [`Plan::Bridge`]): the host
/// checkpointed its WAL into its database and began a new one, `new`. What the
/// database gained is exactly the frames of the old generation, so those the
/// snapshot lacks ([`read_tail`]) are applied to the snapshot's own database copy
/// the way a checkpoint does, and the snapshot then follows `new`.
async fn bridge<H: Host>(host: &H, wal: &str, snapshot: &mut Snapshot, new: &WalHeader, db_now: (u64, Option<u64>)) -> Crossed {
    let Some(copy) = snapshot.wal.clone() else {
        return Crossed::Rebase;
    };
    let local_wal = wal_file(&snapshot.dir);
    if tokio::fs::metadata(&local_wal).await.map(|m| m.len()).ok() != Some(copy.committed) {
        return Crossed::Rebase;
    }
    let tail = match read_tail(host, wal, &copy.header, new, copy.committed, copy.sum).await {
        Ok(Some(tail)) => tail,
        Ok(None) => return Crossed::Rebase,
        Err(_) => return Crossed::Later,
    };
    // The host restarted again while the tail was read: its slots were not safe to judge.
    match host.read(wal, 0, WAL_HEADER).await {
        Ok(head) if parse_wal_header(&head).as_ref() == Some(new) => {}
        Ok(_) => return Crossed::Rebase,
        Err(_) => return Crossed::Later,
    }
    let (db, new_raw) = (db_file(&snapshot.dir), new.raw);
    let (local, page) = (local_wal.clone(), copy.header.page);
    let applied =
        app_core::rt::try_blocking("opencode snapshot checkpoint", move || checkpoint_local(&db, &local, &tail.committed, page, &new_raw)).await;
    if applied.is_err() {
        // Half applied: the snapshot is no use.
        return Crossed::Rebase;
    }
    snapshot.wal = Some(WalCopy { header: new.clone(), committed: WAL_HEADER as u64, sum: new.sum });
    snapshot.db = db_now;
    Crossed::Done
}

/// What a checkpoint does, on the snapshot's files: write the newest frame of
/// every page of the local WAL (`header` + frames) and `tail` (more frames of the
/// same generation, committed) into the database file, cut it to the size the
/// last commit names, and leave the WAL as the bare header `new_header`.
fn checkpoint_local(db: &Path, wal: &Path, tail: &[u8], page: usize, new_header: &[u8; WAL_HEADER]) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut frames = std::fs::read(wal).map_err(|e| e.to_string())?;
    if frames.len() < WAL_HEADER {
        return Err("the local WAL has no header".into());
    }
    frames.drain(..WAL_HEADER);
    frames.extend_from_slice(tail);
    let size = FRAME_HEADER + page;
    if frames.len() % size != 0 {
        return Err("a WAL ends inside a frame".into());
    }
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(db).map_err(|e| e.to_string())?;
    let mut head = [0u8; 18];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;
    let db_page = match u16::from_be_bytes([head[16], head[17]]) {
        1 => 65536,
        n => usize::from(n),
    };
    if db_page != page {
        return Err("the database's page size is not the WAL's".into());
    }
    let mut newest: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    let mut pages = None;
    for (n, frame) in frames.chunks_exact(size).enumerate() {
        newest.insert(be32(frame), n * size + FRAME_HEADER);
        pages = Some(be32(&frame[4..]));
    }
    if let Some(pages) = pages {
        // The last frame of committed bytes is a commit frame: it names the size.
        let length = u64::from(pages) * page as u64;
        if pages == 0 || length > MAX_DB_BYTES {
            return Err("the WAL names no usable database size".into());
        }
        for (pgno, at) in newest {
            if pgno == 0 || u64::from(pgno) > u64::from(pages).max(1) * 2 + 1024 {
                return Err("a frame names a page that cannot be".into());
            }
            file.seek(SeekFrom::Start(u64::from(pgno - 1) * page as u64)).map_err(|e| e.to_string())?;
            file.write_all(&frames[at..at + page]).map_err(|e| e.to_string())?;
        }
        file.set_len(length).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    std::fs::write(wal, new_header).map_err(|e| e.to_string())
}

/// Make `stage` the snapshot at `cur`.
async fn install(stage: &Path, cur: &Path) -> Result<(), &'static str> {
    let old = cur.with_extension("old");
    let _ = tokio::fs::remove_dir_all(&old).await;
    if tokio::fs::metadata(cur).await.is_ok() {
        tokio::fs::rename(cur, &old).await.map_err(io_err)?;
    }
    tokio::fs::rename(stage, cur).await.map_err(io_err)?;
    let _ = tokio::fs::remove_dir_all(&old).await;
    Ok(())
}

// ---- the tab's CLI on the host ------------------------------------------------

/// What the host's process list says of the tab's OpenCode.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Proc {
    pid: u32,
    /// When it started, in epoch ms on the host's clock.
    started_ms: Option<i64>,
    /// The folder it really runs in (`/proc/<pid>/cwd`).
    cwd: Option<String>,
    env: ProcEnv,
}

/// The variables of its environment that say where its store is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProcEnv {
    xdg_data_home: Option<String>,
    home: Option<String>,
    opencode_db: Option<String>,
}

fn env_var(environ: &[u8], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let var = environ.split(|b| *b == 0).find_map(|var| var.strip_prefix(prefix.as_bytes()))?;
    String::from_utf8(var.to_vec()).ok().filter(|value| !value.is_empty() && !value.contains('\0'))
}

fn parse_environ(environ: &[u8]) -> ProcEnv {
    ProcEnv { xdg_data_home: env_var(environ, "XDG_DATA_HOME"), home: env_var(environ, "HOME"), opencode_db: env_var(environ, "OPENCODE_DB") }
}

/// A path on a POSIX host (the only kind with a `/proc`) or a Windows one.
fn is_host_absolute(path: &str) -> bool {
    path.starts_with('/') || path.as_bytes().get(1) == Some(&b':')
}

/// Where the host's database is: the CLI's own `OPENCODE_DB` when set, else
/// below its data home, else below the host's agent home (`under`).
fn store_path(env: Option<&ProcEnv>, agent_home: Option<&str>) -> String {
    let data = env.and_then(|env| {
        let xdg = env.xdg_data_home.as_deref().filter(|dir| dir.starts_with('/'));
        let home = env.home.as_deref().filter(|dir| dir.starts_with('/'));
        xdg.map(str::to_string).or_else(|| home.map(|home| format!("{}/.local/share", home.trim_end_matches('/'))))
    });
    let data = data.map(|dir| format!("{}/", dir.trim_end_matches('/')));
    if let Some(db) = env.and_then(|env| env.opencode_db.as_deref()).filter(|db| *db != ":memory:" && !db.contains("/../")) {
        return match (db.starts_with('/'), &data) {
            (true, _) => db.to_string(),
            (false, Some(data)) => format!("{data}opencode/{db}"),
            (false, None) => under(agent_home, &format!(".local/share/opencode/{db}")),
        };
    }
    match data {
        Some(data) => format!("{data}{STORE_REL}"),
        None => under(agent_home, HOME_STORE_REL),
    }
}

/// The start tick of a process out of its `/proc/<pid>/stat` line (field 22; the
/// command, field 2, may hold spaces and parentheses, so count from its last `)`).
fn stat_start_ticks(stat: &str) -> Option<u64> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}

/// The host's boot moment (epoch seconds) out of `/proc/stat`.
fn btime_of(proc_stat: &str) -> Option<i64> {
    proc_stat.lines().find_map(|line| line.strip_prefix("btime ")?.trim().parse().ok())
}

/// The `since` the local reader is given: the host-clock start of the tab's CLI
/// when a process told it, else the local launch moment less the clock slack.
fn host_since(since: Option<i64>, started_ms: Option<i64>) -> Option<i64> {
    let since = since?;
    Some(match started_ms {
        Some(started) => started - START_SLACK_MS,
        None => since - SKEW_SLACK_MS,
    })
}

/// The tab's OpenCode among the host's processes. Reads `/proc/<pid>/environ` of
/// every process (a few at once; another account's is refused at once) for the
/// tab's launch id, then the earliest match's start time, folder and variables.
async fn find_process(sftp: &Sftp, launch_id: &str) -> Option<Proc> {
    use crate::services::sftp::{list_dir_raw_on, read_file_up_to, read_link_on, read_range_on, SyncKind};
    let entries = list_dir_raw_on(sftp, "/proc").await.ok()?;
    // Plain loop, not an iterator chain: this future crosses a Tauri command's
    // `Send` bound, which closures over the listing's borrows do not meet.
    let mut pids: Vec<u32> = Vec::new();
    for entry in &entries {
        if pids.len() >= MAX_PROCS {
            break;
        }
        if matches!(entry.kind, SyncKind::Dir) {
            if let Ok(pid) = entry.name.parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    let found: Vec<(u32, Vec<u8>)> = stream::iter(pids)
        .map(|pid| async move {
            match read_file_up_to(sftp, &format!("/proc/{pid}/environ"), MAX_ENVIRON_BYTES).await {
                Ok(Some(environ)) if runs_tab(&environ, launch_id) => Some((pid, environ)),
                _ => None,
            }
        })
        .buffer_unordered(PROC_PARALLEL)
        .filter_map(|found| async move { found })
        .collect()
        .await;
    let boot = read_range_on(sftp, "/proc/stat", 0, 1024 * 1024).await.ok().and_then(|bytes| btime_of(&String::from_utf8_lossy(&bytes)));
    let mut best: Option<(u64, Proc)> = None;
    for (pid, environ) in found {
        let ticks = match read_range_on(sftp, &format!("/proc/{pid}/stat"), 0, 4096).await {
            Ok(bytes) => stat_start_ticks(&String::from_utf8_lossy(&bytes)),
            Err(_) => None,
        };
        // The TUI starts before the server it spawns; the earliest is the tab's start.
        if best.as_ref().is_some_and(|(known, _)| ticks.unwrap_or(u64::MAX) >= *known) {
            continue;
        }
        let started_ms = boot.zip(ticks).map(|(boot, ticks)| boot * 1000 + (ticks * 1000 / CLOCK_TICKS) as i64);
        let cwd = read_link_on(sftp, &format!("/proc/{pid}/cwd")).await.ok().filter(|cwd| is_host_absolute(cwd));
        best = Some((ticks.unwrap_or(u64::MAX), Proc { pid, started_ms, cwd, env: parse_environ(&environ) }));
    }
    best.map(|(_, process)| process)
}

// ---- one tab ---------------------------------------------------------------

/// What is known of one tab between reads.
#[derive(Default)]
struct Store {
    snapshot: Option<Snapshot>,
    /// When the host was last asked.
    checked: Option<Instant>,
    /// A base is being copied in the background.
    fetching: bool,
    /// When the last base was begun.
    based: Option<Instant>,
    /// Why the last base failed, while there is no snapshot.
    failed: Option<&'static str>,
    process: Option<Proc>,
    /// The process was seen and is gone since.
    gone: bool,
    /// When the process list was last scanned, and the known process last checked.
    scanned: Option<Instant>,
    verified: Option<Instant>,
}

type Cell = Arc<tokio::sync::Mutex<Store>>;

/// One entry per `(project, host, launch id)`: its lock serializes the copying
/// and the local reads (a read opens files the next copy appends to).
static STORES: LazyLock<std::sync::Mutex<HashMap<String, Cell>>> = LazyLock::new(Default::default);

fn cell(project_id: &str, host_id: &str, launch_id: &str) -> Cell {
    let mut stores = STORES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(stores.entry(mirror_key(project_id, host_id, launch_id)).or_default())
}

fn tab_root(project_id: &str, host_id: &str, launch_id: &str) -> PathBuf {
    host_dir(project_id, host_id).join(format!("opencode-{launch_id}"))
}

/// Look for the tab's CLI in the host's process list when that is due.
async fn locate(store: &mut Store, sftp: &Sftp, launch_id: &str) {
    if let (Some(process), false) = (&store.process, store.gone) {
        if store.verified.is_some_and(|at| at.elapsed() < SEARCH_EVERY) {
            return;
        }
        store.verified = Some(Instant::now());
        // One read: is the process still the tab's?
        let alive = matches!(
            crate::services::sftp::read_file_up_to(sftp, &format!("/proc/{}/environ", process.pid), MAX_ENVIRON_BYTES).await,
            Ok(Some(environ)) if runs_tab(&environ, launch_id)
        );
        store.gone = !alive;
        return;
    }
    let every = if store.process.is_some() { SEARCH_EVERY * 4 } else { SEARCH_EVERY };
    if store.scanned.is_some_and(|at| at.elapsed() < every) {
        return;
    }
    store.scanned = Some(Instant::now());
    if let Some(process) = find_process(sftp, launch_id).await {
        store.process = Some(process);
        store.gone = false;
        store.verified = Some(Instant::now());
    }
}

/// [`super::host_tab_transcript`] of an OpenCode tab.
pub(super) async fn host_transcript(
    tab: &HostTab<'_>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    if !is_uuid_shaped(tab.launch_id) {
        return AgentTranscript::unavailable("no_session");
    }
    let Some(dir) = tab.tab_dir.filter(|dir| is_host_absolute(dir)) else {
        return AgentTranscript::unavailable("no_session");
    };
    let Some(target) = crate::services::remote::remote_target_for_host(tab.project_id, tab.host_id) else {
        return AgentTranscript::unavailable("unsupported");
    };
    let cell = cell(tab.project_id, tab.host_id, tab.launch_id);
    let mut store = cell.lock().await;
    let every = check_every(&target.spec);
    if !store.checked.is_some_and(|at| at.elapsed() < every) {
        match crate::services::remote::pooled_sftp_host(tab.pool, tab.project_id, tab.host_id).await {
            Some(sftp) => {
                store.checked = Some(Instant::now());
                let base_every = if every > super::CHECK_EVERY { CAREFUL_BASE_EVERY } else { BASE_EVERY };
                let agent_home = target.spec.agent_home();
                let root = tab_root(tab.project_id, tab.host_id, tab.launch_id);
                sync(&cell, &mut store, &sftp, &root, agent_home.as_deref(), tab.launch_id, base_every).await;
            }
            // The host cannot be asked: a snapshot held is still what is shown.
            None if store.snapshot.is_some() => {}
            None => return AgentTranscript::unavailable("disconnected"),
        }
    }
    let Some(snapshot) = store.snapshot.clone() else {
        return AgentTranscript::unavailable(if store.fetching { "syncing" } else { store.failed.unwrap_or("no_transcript") });
    };
    let process = store.process.clone();
    let started = process.as_ref().and_then(|p| p.started_ms);
    let (dir, since) = (dir.to_string(), host_since(tab.since, started));
    let cwd = process.and_then(|p| p.cwd).filter(|cwd| *cwd != dir);
    let (token, version) = (subagent.map(str::to_string), version.map(str::to_string));
    let read = app_core::rt::spawn_blocking(move || {
        read_snapshot(&snapshot, &dir, cwd.as_deref(), since, token.as_deref(), version.as_deref(), limit)
    })
    .await
    .ok()
    .flatten();
    read.unwrap_or_else(|| AgentTranscript::unavailable(if subagent.is_some() { "no_subagent" } else { "read_failed" }))
}

/// The local reader over a snapshot. A folder reached through a link on the
/// host is stored under its real path: when the tab's own path finds no
/// session yet, the process's real folder is tried.
fn read_snapshot(
    snapshot: &Snapshot,
    dir: &str,
    cwd: Option<&str>,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let db = db_file(&snapshot.dir);
    // The index of a WAL that has grown since is stale: SQLite builds a new one.
    let _ = std::fs::remove_file(db.with_file_name("opencode.db-shm"));
    let read = |dir: &str| crate::services::opencode_store::session_transcript(&db, dir, since, None, subagent, version, limit);
    let first = read(dir)?;
    let nothing_yet = first.available && first.entries.is_empty() && !first.unchanged;
    match cwd {
        Some(cwd) if nothing_yet => read(cwd).filter(|other| !other.entries.is_empty()).or(Some(first)),
        _ => Some(first),
    }
}

/// Bring the tab's snapshot up to what the host holds, or start a new base.
async fn sync(cell: &Cell, store: &mut Store, sftp: &Arc<Sftp>, root: &Path, agent_home: Option<&str>, launch_id: &str, base_every: Duration) {
    locate(store, sftp, launch_id).await;
    let db = store_path(store.process.as_ref().map(|p| &p.env), agent_home);
    let wal = format!("{db}-wal");
    let seen = match observe(&**sftp, &db, &wal).await {
        Ok(seen) => seen,
        Err(reason) => {
            if store.snapshot.is_none() {
                store.failed = Some(reason);
            }
            return;
        }
    };
    let mut next = plan(store.snapshot.as_ref(), &seen);
    if next == Plan::Bridge {
        let crossed = match (store.snapshot.as_mut(), seen.wal.as_ref()) {
            (Some(snapshot), Some(head)) => bridge(&**sftp, &wal, snapshot, head, seen.db).await,
            _ => Crossed::Rebase,
        };
        next = match crossed {
            Crossed::Done => Plan::Extend,
            Crossed::Rebase => Plan::Rebase,
            Crossed::Later => Plan::Hold,
        };
    }
    match next {
        Plan::Hold | Plan::Bridge => {}
        Plan::Extend => {
            if let Some(snapshot) = store.snapshot.as_mut() {
                if extend(&**sftp, &wal, snapshot).await.is_err() {
                    store.snapshot = None;
                }
            }
        }
        Plan::Adopt => {
            let adopted = match (store.snapshot.as_mut(), seen.wal.as_ref()) {
                (Some(snapshot), Some(head)) => adopt(snapshot, head).await.is_ok(),
                _ => false,
            };
            if !adopted {
                store.snapshot = None;
            }
        }
        Plan::Rebase => {
            let wait = if store.snapshot.is_some() { base_every } else { FIRST_RETRY };
            if store.fetching || store.based.is_some_and(|at| at.elapsed() < wait) {
                return;
            }
            store.fetching = true;
            store.based = Some(Instant::now());
            let (sftp, cell) = (Arc::clone(sftp), Arc::clone(cell));
            let (stage, cur) = (root.join("new"), root.join("cur"));
            app_core::rt::spawn(async move {
                let made = fetch_base(&*sftp, &db, &wal, &stage).await;
                let mut store = cell.lock().await;
                store.fetching = false;
                let made = match made {
                    Ok(mut snapshot) => install(&stage, &cur).await.map(|()| {
                        snapshot.dir = cur;
                        snapshot
                    }),
                    Err(reason) => Err(reason),
                };
                match made {
                    Ok(snapshot) => (store.snapshot, store.failed) = (Some(snapshot), None),
                    Err(reason) => {
                        let _ = tokio::fs::remove_dir_all(&stage).await;
                        store.failed = Some(reason);
                    }
                }
            });
        }
    }
    if store.snapshot.is_none() && !store.fetching {
        store.failed.get_or_insert("read_failed");
    }
}

#[cfg(test)]
mod tests;

//! The remote side of a remote project's 📁 library: the project's tree on its
//! primary host, under the record's `remote_path`, read-only.
//!
//! The phone reaches the host only through the desktop's ControlMaster for it,
//! as its host tabs do (`docs/mobile_remote_host_tabs_plan.md`): an SFTP
//! subsystem over `ssh_exec::host_mux_sftp_args`, which cannot dial, resolve or
//! prompt. No master — the desktop is not connected to that host — is
//! `host_offline`, never a connection of the phone's own.
//!
//! The rules are the local browser's (`files.rs`): sealed tokens — under a
//! binding of their own ([`host_aad`]), so a token of one side never opens on
//! the other — the same hidden names, no links listed or crossed. Over SFTP a
//! path cannot be walked one held folder at a time, so each request proves its
//! path instead: the host's `realpath` of root + rel must be exactly root +
//! rel, which no link anywhere on the way (the leaf included) survives. A swap
//! between that proof and the read is not caught; what is read is still never
//! written, and the switch is the boundary, as on the local side.
//!
//! One SFTP session per host is kept while the phone browses — a page of
//! thumbnails asks for many files at once, and sshd's `MaxSessions` (10 by
//! default) would refuse that many mux sessions — and dropped after
//! [`IDLE`], so the master's `ControlPersist` runs out as it would have.

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use app_core::sync::LockExt;
use futures_util::{stream, StreamExt};
use openssh_sftp_client::{error::Error as SftpError, fs::Fs, Sftp};
use tokio::process::Child;

use super::files::{self, Crumb, Entry, FilesError, Found, Hit, Listing, MAX_ENTRIES, MAX_HITS};
use super::outbox::{self, MAX_OUTBOX_FILE, SNIFF_BYTES};
use crate::schema::project::RemoteSpec;

/// How long a session nobody used is kept.
const IDLE: Duration = Duration::from_secs(60);
/// How long opening a session over the master may take. The mux client fails
/// at once without a master; this bounds a master that stopped answering.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one request's SFTP work may take, a whole read included.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How many files a listing opens at once to read their heads.
const SNIFF_AT_ONCE: usize = 16;
/// How many names a search weighs before it stops and says `truncated`: each
/// folder is a round trip to the host, so far fewer than the local walk's.
const MAX_SCANNED: usize = 10_000;
/// How many folders a search reads.
const MAX_FOLDERS: usize = 500;
/// How long a search walks before it answers what it found.
const SEARCH_DEADLINE: Duration = Duration::from_secs(10);
/// Folders a search does not walk into: what a project's `.gitignore` keeps
/// out of the local search, which cannot run git on the host.
const SEARCH_SKIP: &[&str] = &["node_modules", "target", "__pycache__", ".venv", "venv", ".cache", ".tox", ".mypy_cache", ".pytest_cache"];
/// How long a `ssh -G` answer is used: one that found a socket, one that did not.
const RESOLVE_KEEP: Duration = Duration::from_secs(5 * 60);
const RESOLVE_RETRY: Duration = Duration::from_secs(30);
/// One read of a file, in bytes.
const READ_CHUNK: u32 = 256 * 1024;

/// What a host-side token is bound to: the project's raw id and the side, so
/// a local token never opens here, nor a host token on the local side.
fn host_aad(raw_id: &str) -> String {
    format!("{raw_id}\0host")
}

/// Seals a path below the remote root for the phone.
pub fn seal(host_key: &[u8], raw_id: &str, rel: &str) -> Result<String, FilesError> {
    files::seal(host_key, &host_aad(raw_id), rel)
}

/// The path a host-side token seals, if this host sealed it for this project.
pub fn unseal(host_key: &[u8], raw_id: &str, token: &str) -> Option<String> {
    files::unseal(host_key, &host_aad(raw_id), token)
}

/// The remote root the phone may read under: absolute, one plain path.
pub fn root_of(spec: &RemoteSpec) -> Option<&str> {
    let root = spec.remote_path.trim();
    (root.starts_with('/') && !root.chars().any(char::is_control)).then_some(root)
}

/// One live session and the mux client it runs over (killed on drop).
struct Session {
    sftp: Sftp,
    child: Mutex<Child>,
}

impl Session {
    fn alive(&self) -> bool {
        matches!(self.child.lock_ok().try_wait(), Ok(None))
    }
}

struct Held {
    session: Arc<Session>,
    used: Instant,
    generation: u64,
}

/// The sessions kept per host, and each host's resolved socket path.
#[derive(Default)]
pub struct HostFiles {
    held: tokio::sync::Mutex<HashMap<String, Held>>,
    resolved: Mutex<HashMap<String, (Instant, Option<PathBuf>)>>,
    generation: std::sync::atomic::AtomicU64,
}

fn key_of(spec: &RemoteSpec) -> String {
    crate::services::ssh_common::target_key(spec.user.as_deref(), &spec.host, spec.port)
}

impl HostFiles {
    /// The literal socket of the desktop's master for `spec`: `known` (the
    /// host refresher's, `CatalogCache::host_control_path`), else `ssh -G`'s
    /// answer, kept a while. `None` when there is no socket file there.
    pub(super) async fn control_path(&self, spec: &RemoteSpec, known: Option<PathBuf>) -> Option<PathBuf> {
        let path = match known {
            Some(path) => Some(path),
            None => {
                let key = key_of(spec);
                let kept = self.resolved.lock_ok().get(&key).cloned().filter(|(at, path)| {
                    at.elapsed() < if path.is_some() { RESOLVE_KEEP } else { RESOLVE_RETRY }
                });
                match kept {
                    Some((_, path)) => path,
                    None => {
                        let asked = spec.clone();
                        // `ssh -G` reads the user's ssh_config, under its own deadline.
                        let path = tokio::task::spawn_blocking(move || crate::services::ssh_exec::resolve_control_path(&asked))
                            .await
                            .ok()
                            .flatten();
                        self.resolved.lock_ok().insert(key, (Instant::now(), path.clone()));
                        path
                    }
                }
            }
        };
        path.filter(|path| path.exists())
    }

    /// The kept session for `spec`'s host, or a new one over its master.
    async fn session(self: &Arc<Self>, spec: &RemoteSpec, known: Option<PathBuf>) -> Result<Arc<Session>, FilesError> {
        let key = key_of(spec);
        let mut held = self.held.lock().await;
        if let Some(kept) = held.get_mut(&key) {
            if kept.session.alive() {
                kept.used = Instant::now();
                return Ok(kept.session.clone());
            }
            held.remove(&key);
        }
        let control_path = self.control_path(spec, known).await.ok_or(FilesError::HostOffline)?;
        let args = crate::services::ssh_exec::host_mux_sftp_args(spec, &control_path).map_err(|_| FilesError::HostOffline)?;
        let (sftp, child) = match tokio::time::timeout(OPEN_TIMEOUT, crate::services::sftp::open_mux_session(args)).await {
            Ok(Ok(opened)) => opened,
            _ => {
                // The socket may be a dead master's: ask `ssh -G` again next time.
                self.resolved.lock_ok().remove(&key);
                return Err(FilesError::HostOffline);
            }
        };
        let session = Arc::new(Session { sftp, child: Mutex::new(child) });
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        held.insert(key.clone(), Held { session: session.clone(), used: Instant::now(), generation });
        tokio::spawn(reap_when_idle(Arc::downgrade(self), key, generation));
        Ok(session)
    }

    /// Runs `work` on `spec`'s host session; a session that failed on the
    /// way is dropped, so the next request opens a fresh one.
    async fn with_session<T, F, Fut>(self: &Arc<Self>, spec: &RemoteSpec, known: Option<PathBuf>, work: F) -> Result<T, FilesError>
    where
        F: FnOnce(Arc<Session>) -> Fut,
        Fut: std::future::Future<Output = Result<T, FilesError>>,
    {
        let session = self.session(spec, known).await?;
        let answer = match tokio::time::timeout(REQUEST_TIMEOUT, work(session.clone())).await {
            Ok(answer) => answer,
            Err(_) => Err(FilesError::Io("the host took too long".into())),
        };
        if matches!(answer, Err(FilesError::Io(_))) || !session.alive() {
            let key = key_of(spec);
            let mut held = self.held.lock().await;
            if held.get(&key).is_some_and(|kept| Arc::ptr_eq(&kept.session, &session)) {
                held.remove(&key);
            }
            if !session.alive() {
                return Err(FilesError::HostOffline);
            }
        }
        answer
    }

    /// One folder below the remote root ([`list_on`]).
    pub async fn list(self: &Arc<Self>, spec: &RemoteSpec, known: Option<PathBuf>, rel: String, key: Vec<u8>, raw_id: String) -> Result<Listing, FilesError> {
        let root = root_of(spec).ok_or(FilesError::Unavailable)?.to_string();
        self.with_session(spec, known, |session| async move { list_on(&session.sftp, &root, &rel, &key, &raw_id).await }).await
    }

    /// Names below the remote root that hold every word ([`search_on`]).
    pub async fn search(self: &Arc<Self>, spec: &RemoteSpec, known: Option<PathBuf>, query: String, key: Vec<u8>, raw_id: String) -> Result<Found, FilesError> {
        let root = root_of(spec).ok_or(FilesError::Unavailable)?.to_string();
        self.with_session(spec, known, |session| async move { search_on(&session.sftp, &root, &query, &key, &raw_id).await }).await
    }

    /// One file's bytes and media type ([`read_on`]).
    pub async fn read(self: &Arc<Self>, spec: &RemoteSpec, known: Option<PathBuf>, rel: String) -> Result<(Vec<u8>, &'static str), FilesError> {
        let root = root_of(spec).ok_or(FilesError::Unavailable)?.to_string();
        self.with_session(spec, known, |session| async move { read_on(&session.sftp, &root, &rel).await }).await
    }
}

/// Drops `key`'s session once nobody used it for [`IDLE`]; ends when the
/// session it was started for is gone or replaced.
async fn reap_when_idle(files: Weak<HostFiles>, key: String, generation: u64) {
    loop {
        tokio::time::sleep(IDLE).await;
        let Some(files) = files.upgrade() else { return };
        let mut held = files.held.lock().await;
        match held.get(&key) {
            Some(kept) if kept.generation == generation => {
                if kept.used.elapsed() >= IDLE {
                    held.remove(&key);
                    return;
                }
            }
            _ => return,
        }
    }
}

fn sftp_error(error: SftpError) -> FilesError {
    match error {
        SftpError::SftpError(..) => FilesError::NotFound,
        other => FilesError::Io(other.to_string()),
    }
}

/// `rel` below `root`, as the host would write the path.
fn join(root: &str, rel: &str) -> String {
    let root = root.trim_end_matches('/');
    if rel.is_empty() {
        if root.is_empty() { "/".to_string() } else { root.to_string() }
    } else {
        format!("{root}/{rel}")
    }
}

/// The remote root as the host resolves it, or `Unavailable`.
async fn canonical_root(fs: &mut Fs, root: &str) -> Result<String, FilesError> {
    let real = fs.canonicalize(root).await.map_err(|_| FilesError::Unavailable)?;
    real.to_str().filter(|real| real.starts_with('/')).map(str::to_owned).ok_or(FilesError::Unavailable)
}

/// The host path of `rel` below `root`, proven: a valid rel whose `realpath`
/// is itself — no link on the way down, the leaf included.
async fn proven(fs: &mut Fs, root: &str, rel: &str) -> Result<String, FilesError> {
    if !files::valid_rel(rel) {
        return Err(FilesError::NotFound);
    }
    let root = canonical_root(fs, root).await?;
    let full = join(&root, rel);
    if rel.is_empty() {
        return Ok(full);
    }
    let real = fs.canonicalize(&full).await.map_err(sftp_error)?;
    if real.to_str() != Some(full.as_str()) {
        return Err(FilesError::NotFound);
    }
    Ok(full)
}

/// One name a folder read gave: kept only as a folder or a regular file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

/// A folder's names as the listing rows them: folders and regular files under
/// a name the browser resolves again (never a link), folders first, then by
/// name; the `bool` is whether it was cut at `MAX_ENTRIES`.
fn kept_rows(mut rows: Vec<Row>) -> (Vec<Row>, bool) {
    rows.retain(|row| files::valid_segment(&row.name));
    rows.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
    let truncated = rows.len() > MAX_ENTRIES;
    rows.truncate(MAX_ENTRIES);
    (rows, truncated)
}

/// The folder at host path `dir`, read with its entries' own (lstat) types: a
/// link, a socket or a name that is not UTF-8 is no row.
async fn read_rows(fs: &mut Fs, dir: &str) -> Result<Vec<Row>, FilesError> {
    let opened = fs.open_dir(dir).await.map_err(sftp_error)?;
    let mut entries = Box::pin(opened.read_dir());
    let mut rows = Vec::new();
    while let Some(entry) = entries.next().await {
        let entry = entry.map_err(sftp_error)?;
        let Some(name) = entry.filename().to_str() else { continue };
        let Some(kind) = entry.file_type() else { continue };
        if !(kind.is_dir() || kind.is_file()) || kind.is_symlink() {
            continue;
        }
        let meta = entry.metadata();
        rows.push(Row {
            name: name.to_string(),
            is_dir: kind.is_dir(),
            size: if kind.is_dir() { 0 } else { meta.len().unwrap_or(0) },
            modified: meta.modified().map(|t| t.as_duration().as_secs()).unwrap_or(0),
        });
    }
    Ok(rows)
}

/// Up to `limit` bytes of an open file, from where it stands.
async fn read_up_to(file: &mut openssh_sftp_client::file::File, limit: u64) -> Result<Vec<u8>, FilesError> {
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < limit {
        let want = READ_CHUNK.min(u32::try_from(limit - bytes.len() as u64).unwrap_or(READ_CHUNK));
        match file.read(want, bytes::BytesMut::with_capacity(want as usize)).await.map_err(sftp_error)? {
            Some(chunk) if !chunk.is_empty() => bytes.extend_from_slice(&chunk),
            _ => break,
        }
    }
    Ok(bytes)
}

/// The media type a file's first bytes announce, as the outbox types them;
/// `None` when it is not a regular file once open or cannot be read.
async fn sniff(sftp: &Sftp, path: &str) -> Option<&'static str> {
    let mut file = sftp.open(path).await.ok()?;
    if !file.metadata().await.ok()?.file_type()?.is_file() {
        return None;
    }
    let head = read_up_to(&mut file, SNIFF_BYTES as u64).await.ok()?;
    Some(outbox::classify(&head))
}

/// Each path's kind: `"dir"` for a folder, else its head's ([`sniff`]), a few
/// files at a time, in order. The futures are built in a loop rather than an
/// iterator's closure, which a handler's `Send` future could not name.
async fn kinds_of(sftp: &Sftp, paths: Vec<(String, bool)>) -> Vec<Option<&'static str>> {
    let mut asks = Vec::with_capacity(paths.len());
    for (path, is_dir) in paths {
        asks.push(Box::pin(async move { if is_dir { Some("dir") } else { sniff(sftp, &path).await } }));
    }
    stream::iter(asks).buffered(SNIFF_AT_ONCE).collect().await
}

/// Rows of the folder at host path `dir` (below `rel`) as listing entries, each
/// file typed by its head; a file that cannot be opened is left out, as the
/// local listing leaves it out.
async fn entries_of(sftp: &Sftp, dir: &str, rel: &str, rows: Vec<Row>, host_key: &[u8], raw_id: &str) -> Result<Vec<Entry>, FilesError> {
    let kinds = kinds_of(sftp, rows.iter().map(|row| (join(dir, &row.name), row.is_dir)).collect()).await;
    let mut entries = Vec::with_capacity(rows.len());
    for (row, kind) in rows.into_iter().zip(kinds) {
        let Some(kind) = kind else { continue };
        entries.push(Entry {
            token: seal(host_key, raw_id, &files::child(rel, &row.name))?,
            name: row.name,
            kind,
            size: row.size,
            modified: row.modified,
            created: None,
            ignored: false,
            items: None,
        });
    }
    Ok(entries)
}

/// One folder below the remote root. No item counts and no "gitignored"
/// section: either would cost the host a walk per row.
pub async fn list_on(sftp: &Sftp, root: &str, rel: &str, host_key: &[u8], raw_id: &str) -> Result<Listing, FilesError> {
    let mut fs = sftp.fs();
    let dir = proven(&mut fs, root, rel).await?;
    let (rows, truncated) = kept_rows(read_rows(&mut fs, &dir).await?);
    let entries = entries_of(sftp, &dir, rel, rows, host_key, raw_id).await?;
    Ok(Listing { entries, truncated })
}

/// One file's bytes and media type, bounded as the local [`files::read`].
pub async fn read_on(sftp: &Sftp, root: &str, rel: &str) -> Result<(Vec<u8>, &'static str), FilesError> {
    if rel.is_empty() {
        return Err(FilesError::NotFound);
    }
    let mut fs = sftp.fs();
    let path = proven(&mut fs, root, rel).await?;
    let mut file = sftp.open(&path).await.map_err(sftp_error)?;
    let meta = file.metadata().await.map_err(sftp_error)?;
    if !meta.file_type().is_some_and(|kind| kind.is_file()) {
        return Err(FilesError::NotFound);
    }
    let mut bytes = read_up_to(&mut file, SNIFF_BYTES as u64).await?;
    let kind = outbox::classify(&bytes);
    // A host that sends no size is read to the cap and judged by that.
    if meta.len().is_some_and(|len| len > MAX_OUTBOX_FILE) && !kind.starts_with("text/") {
        return Err(FilesError::TooLarge);
    }
    let rest = read_up_to(&mut file, MAX_OUTBOX_FILE - bytes.len() as u64).await?;
    bytes.extend_from_slice(&rest);
    if meta.len().is_none() && bytes.len() as u64 == MAX_OUTBOX_FILE && !kind.starts_with("text/") {
        return Err(FilesError::TooLarge);
    }
    Ok((bytes, kind))
}

/// A name the walk found: its path below the root and its row.
struct Candidate {
    rel: String,
    row: Row,
}

/// The candidates whose leaf holds every word, best first — the local
/// search's order (`files::rank`, then the shallower, then by path) — and
/// whether more than `MAX_HITS` matched.
fn ranked(candidates: Vec<Candidate>, words: &[String]) -> (Vec<Candidate>, bool) {
    let mut matched: Vec<(u8, usize, Candidate)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let score = files::rank(&candidate.row.name, words)?;
            Some((score, candidate.rel.matches('/').count(), candidate))
        })
        .collect();
    matched.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then_with(|| a.2.rel.to_lowercase().cmp(&b.2.rel.to_lowercase())));
    let truncated = matched.len() > MAX_HITS;
    (matched.into_iter().take(MAX_HITS).map(|(_, _, candidate)| candidate).collect(), truncated)
}

/// The sealed folders from the root down to `rel`'s own.
fn trail_of(rel: &str, host_key: &[u8], raw_id: &str) -> Result<Vec<Crumb>, FilesError> {
    let mut trail = Vec::new();
    let mut end = 0;
    while let Some(slash) = rel[end..].find('/') {
        let start = end;
        end += slash;
        trail.push(Crumb { token: seal(host_key, raw_id, &rel[..end])?, name: rel[start..end].to_string() });
        end += 1;
    }
    Ok(trail)
}

/// Names below the remote root that hold every word of `query`, by a bounded
/// breadth-first walk (no links, no hidden names, not into [`SEARCH_SKIP`]).
pub async fn search_on(sftp: &Sftp, root: &str, query: &str, host_key: &[u8], raw_id: &str) -> Result<Found, FilesError> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Found { hits: Vec::new(), truncated: false });
    }
    let mut fs = sftp.fs();
    let root = canonical_root(&mut fs, root).await?;
    let started = Instant::now();
    let mut candidates = Vec::new();
    let mut folders = VecDeque::from([String::new()]);
    let mut read = 0usize;
    let mut cut = false;
    while let Some(rel) = folders.pop_front() {
        if read == MAX_FOLDERS || candidates.len() >= MAX_SCANNED || started.elapsed() > SEARCH_DEADLINE {
            cut = true;
            break;
        }
        read += 1;
        // Gone, or unreadable, since its parent was read: left out.
        let Ok(rows) = read_rows(&mut fs, &join(&root, &rel)).await else { continue };
        for row in rows {
            if !files::valid_segment(&row.name) {
                continue;
            }
            let path = files::child(&rel, &row.name);
            if row.is_dir && !SEARCH_SKIP.contains(&row.name.as_str()) {
                folders.push_back(path.clone());
            }
            candidates.push(Candidate { rel: path, row });
        }
    }
    let (best, more) = ranked(candidates, &words);
    let mut hits = Vec::with_capacity(best.len());
    let kinds = kinds_of(sftp, best.iter().map(|candidate| (join(&root, &candidate.rel), candidate.row.is_dir)).collect()).await;
    for (candidate, kind) in best.into_iter().zip(kinds) {
        let Some(kind) = kind else { continue };
        let entry = Entry {
            token: seal(host_key, raw_id, &candidate.rel)?,
            name: candidate.row.name,
            kind,
            size: candidate.row.size,
            modified: candidate.row.modified,
            created: None,
            ignored: false,
            items: None,
        };
        hits.push(Hit { entry, trail: trail_of(&candidate.rel, host_key, raw_id)? });
    }
    Ok(Found { hits, truncated: cut || more })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"host-key-for-tests-0123456789abcdef";

    fn row(name: &str, is_dir: bool) -> Row {
        Row { name: name.into(), is_dir, size: 1, modified: 2 }
    }

    /// A host token and a local token for the same path never open on the
    /// other side, nor for another project.
    #[test]
    fn host_tokens_and_local_tokens_do_not_cross() {
        let host = seal(KEY, "p1", "docs/a.pdf").unwrap();
        let local = files::seal(KEY, "p1", "docs/a.pdf").unwrap();
        assert_eq!(unseal(KEY, "p1", &host).as_deref(), Some("docs/a.pdf"));
        assert_eq!(unseal(KEY, "p1", &local), None);
        assert_eq!(files::unseal(KEY, "p1", &host), None);
        assert_eq!(unseal(KEY, "p2", &host), None);
    }

    #[test]
    fn only_an_absolute_plain_remote_path_is_a_root() {
        let spec = |path: &str| RemoteSpec { remote_path: path.into(), ..serde_json::from_value(serde_json::json!({ "host": "h", "remote_path": "/" })).unwrap() };
        assert_eq!(root_of(&spec("/srv/p")), Some("/srv/p"));
        assert_eq!(root_of(&spec(" /srv/p ")), Some("/srv/p"));
        assert_eq!(root_of(&spec("~/p")), None);
        assert_eq!(root_of(&spec("p")), None);
        assert_eq!(root_of(&spec("/srv/p\n")), Some("/srv/p"));
        assert_eq!(root_of(&spec("/srv/\u{7}p")), None);
    }

    #[test]
    fn joins_like_the_host_writes_a_path() {
        assert_eq!(join("/srv/p", ""), "/srv/p");
        assert_eq!(join("/srv/p/", "a/b.txt"), "/srv/p/a/b.txt");
        assert_eq!(join("/", ""), "/");
        assert_eq!(join("/", "etc"), "/etc");
    }

    /// Hidden names go, folders come first, then names in any case, and a
    /// folder past the cap says so.
    #[test]
    fn a_folder_is_rowed_as_the_local_listing_rows_it() {
        let (rows, truncated) = kept_rows(vec![row("b.txt", false), row(".git", true), row("A.md", false), row("src", true), row(".env", false), row("..", true)]);
        assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["src", "A.md", "b.txt"]);
        assert!(!truncated);
        let many: Vec<Row> = (0..=MAX_ENTRIES).map(|i| row(&format!("f{i:04}"), false)).collect();
        let (rows, truncated) = kept_rows(many);
        assert_eq!(rows.len(), MAX_ENTRIES);
        assert!(truncated);
    }

    /// The local search's order: the whole name, then a name starting with
    /// the first word, then anywhere; shallower first among equals.
    #[test]
    fn hits_rank_as_the_local_search_ranks_them() {
        let candidate = |rel: &str| Candidate { rel: rel.into(), row: row(rel.rsplit('/').next().unwrap(), false) };
        let words = vec!["notes".to_string()];
        let (best, more) = ranked(vec![candidate("a/b/my-notes.txt"), candidate("deep/notes.md"), candidate("notes.md"), candidate("other.txt"), candidate("notes-old.md")], &words);
        assert_eq!(best.iter().map(|c| c.rel.as_str()).collect::<Vec<_>>(), ["notes.md", "deep/notes.md", "notes-old.md", "a/b/my-notes.txt"]);
        assert!(!more);
    }

    #[test]
    fn a_hits_trail_is_its_folders_sealed_for_the_host_side() {
        let trail = trail_of("a/b/c.txt", KEY, "p1").unwrap();
        assert_eq!(trail.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(unseal(KEY, "p1", &trail[1].token).as_deref(), Some("a/b"));
        assert!(trail_of("c.txt", KEY, "p1").unwrap().is_empty());
    }
}

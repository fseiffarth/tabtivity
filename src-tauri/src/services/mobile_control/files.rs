//! Read-only browsing of a mobile project's tree (#31bo,
//! `docs/tabtivity_mobile_future_plan.md` §D): the "what did the agent just
//! write" glance, without a shell.
//!
//! Paths never cross the browser API. Every folder and file the phone may ask
//! for again is named by a sealed token — its project-relative path under
//! XChaCha20-Poly1305, keyed from `host.key` and bound to the project's raw id
//! — so a token is opaque to the phone and useless against another project.
//! Tokens are not a permission: every request re-proves the path below the
//! project root, with no link anywhere on the way, and the host-wide switch
//! (`tabtivity_mobile_host.project_files`, default off) is read per request.
//!
//! Nothing here writes. A file is served exactly as the outbox serves one —
//! typed by its bytes (`outbox::classify`), opened without following a link.

use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use hkdf::Hkdf;
use serde_json::Value;
use sha2::Sha256;

use super::outbox::{self, MAX_OUTBOX_FILE};

/// How many entries one folder listing returns; `truncated` says there were more.
pub const MAX_ENTRIES: usize = 500;
/// The longest leaf that is listed or resolved.
const MAX_NAME: usize = 255;
/// The longest project-relative path a token may seal.
const MAX_REL: usize = 4096;
const NONCE_LEN: usize = 24;

/// Whether the host-wide switch is on. Read from `settings.json` per request,
/// like `discovery::root_open`, so turning it off on the desktop closes the
/// routes at once without restarting the sidecar.
pub fn files_open(state_dir: &Path) -> bool {
    fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|settings| {
            settings
                .get(crate::brand::MOBILE_HOST_KEY)?
                .get("project_files")?
                .as_bool()
        })
        .unwrap_or(false)
}

#[derive(Debug, PartialEq, Eq)]
pub enum FilesError {
    /// The project root is gone.
    Unavailable,
    /// No such path, a path that crosses a link, a hidden name, or a token
    /// that does not open for this project — one answer for all of them.
    NotFound,
    /// A file that is not text and is larger than the phone is handed.
    TooLarge,
    Io(String),
}

impl FilesError {
    /// The wire code the phone maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            FilesError::Unavailable => "project_unavailable",
            FilesError::NotFound => "file_not_found",
            FilesError::TooLarge => "file_too_large",
            FilesError::Io(_) => "read_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Entry {
    /// The sealed path the phone asks for this entry by.
    pub token: String,
    pub name: String,
    /// `"dir"`, or the media type the file's first bytes announce.
    pub kind: &'static str,
    /// Bytes; 0 for a folder.
    pub size: u64,
    /// Unix seconds of the mtime.
    pub modified: u64,
    /// Unix seconds of the birth time; left out where the filesystem keeps none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<u64>,
    /// Git ignores it — the desktop tree's collapsed "gitignored" section.
    /// Left out when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

/// Names the listing leaves out and no token may cross: git's internals, the
/// project's own `.tabtivity/` (its outbox has its own door), and `.env*`. A
/// courtesy against a glance over a shoulder, not the boundary — that is the
/// switch, since a phone with a shell can read anything anyway.
pub fn hidden(name: &str) -> bool {
    name == ".git" || crate::brand::is_project_dir(name) || name.starts_with(".env")
}

/// A leaf the browser lists and resolves. The same test both ways, so nothing
/// is listed that could not be opened again.
fn valid_segment(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name != "."
        && name != ".."
        && !name.contains(['/', '\0'])
        // A Windows name holding `\` is a path, and one holding `:` names an
        // alternate data stream of another file.
        && !(cfg!(windows) && name.contains(['\\', ':']))
        && !hidden(name)
}

fn valid_rel(rel: &str) -> bool {
    rel.len() <= MAX_REL && (rel.is_empty() || rel.split('/').all(valid_segment))
}

/// The token key under a given salt: the current one, or the one an older
/// build's host sealed with.
fn token_key_with(salt: &str, host_key: &[u8]) -> [u8; 32] {
    // Not `[0u8; 32]`: CodeQL reads that literal as the key itself, since it
    // doesn't see `expand` overwrite the buffer.
    let mut key: [u8; 32] = std::array::from_fn(|_| 0);
    Hkdf::<Sha256>::new(Some(salt.as_bytes()), host_key)
        .expand(b"path-token v1", &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

/// Seals a project-relative path for the phone.
pub fn seal(host_key: &[u8], raw_id: &str, rel: &str) -> String {
    seal_with(crate::brand::MOBILE_FILES_SALT, host_key, raw_id, rel)
}

fn seal_with(salt: &str, host_key: &[u8], raw_id: &str, rel: &str) -> String {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).expect("the OS RNG must be available to seal a path");
    let cipher = XChaCha20Poly1305::new((&token_key_with(salt, host_key)).into());
    let sealed = cipher
        .encrypt((&nonce).into(), Payload { msg: rel.as_bytes(), aad: raw_id.as_bytes() })
        .expect("XChaCha20-Poly1305 only fails on an impossibly long message");
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Base64UrlUnpadded::encode_string(&out)
}

/// The relative path a token seals, if it was sealed for this project by this
/// host and names a path the browser would list.
pub fn unseal(host_key: &[u8], raw_id: &str, token: &str) -> Option<String> {
    unseal_for(&crate::brand::PAIR, host_key, raw_id, token)
}

/// [`unseal`] for a brand pair: a token that does not open under the current
/// salt is tried under the one an older build's host sealed with (counted as
/// a legacy hit). A phone that kept a page open across the update still holds
/// such tokens; new ones are only ever sealed under the current salt.
pub(crate) fn unseal_for(pair: &crate::brand::Pair, host_key: &[u8], raw_id: &str, token: &str) -> Option<String> {
    let salt = pair.cur(crate::brand::Name::MOBILE_FILES_SALT);
    if let Some(rel) = unseal_with(&salt, host_key, raw_id, token) {
        return Some(rel);
    }
    let old_salt = pair.legacy(crate::brand::Name::MOBILE_FILES_SALT)?;
    let rel = unseal_with(&old_salt, host_key, raw_id, token)?;
    crate::brand::legacy_hit("mobile-files-salt");
    Some(rel)
}

fn unseal_with(salt: &str, host_key: &[u8], raw_id: &str, token: &str) -> Option<String> {
    if token.len() > 2 * MAX_REL {
        return None;
    }
    let bytes = Base64UrlUnpadded::decode_vec(token).ok()?;
    if bytes.len() < NONCE_LEN {
        return None;
    }
    let (nonce, sealed) = bytes.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
    let cipher = XChaCha20Poly1305::new((&token_key_with(salt, host_key)).into());
    let plain = cipher
        .decrypt((&nonce).into(), Payload { msg: sealed, aad: raw_id.as_bytes() })
        .ok()?;
    let rel = String::from_utf8(plain).ok()?;
    valid_rel(&rel).then_some(rel)
}

fn canonical_root(root: &Path) -> Result<PathBuf, FilesError> {
    let canonical = root.canonicalize().map_err(|_| FilesError::Unavailable)?;
    if !canonical.is_dir() {
        return Err(FilesError::Unavailable);
    }
    Ok(canonical)
}

/// A folder of the project, reached from the root one checked name at a time
/// and never through a link.
///
/// On Unix it is held open: each step is an `openat(…, O_NOFOLLOW)` relative
/// to the folder before it, and listing and opening a file start from this
/// descriptor too. Nothing is resolved by path after a check, so a folder on
/// the way swapped for a link mid-request changes nothing — the walk already
/// holds the real one. Windows uses the same boundary through native
/// handle-relative opens and handle-based directory enumeration.
#[cfg(unix)]
struct ProjectDir(fs::File);

#[cfg(unix)]
impl ProjectDir {
    fn open(root: &Path, rel: &str) -> Result<Self, FilesError> {
        let root = canonical_root(root)?;
        if !valid_rel(rel) {
            return Err(FilesError::NotFound);
        }
        let mut dir = fs::File::open(&root)
            .ok()
            .filter(|dir| dir.metadata().is_ok_and(|meta| meta.is_dir()))
            .map(Self)
            .ok_or(FilesError::Unavailable)?;
        if !rel.is_empty() {
            for name in rel.split('/') {
                dir = dir.child_dir(name).ok_or(FilesError::NotFound)?;
            }
        }
        Ok(dir)
    }

    /// `name` in this folder, opened without following a link at it.
    fn open_at(&self, name: &str, directory: bool) -> Option<fs::File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = std::ffi::CString::new(name).ok()?;
        // Non-blocking, so a FIFO swapped in is refused below, not waited on.
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        if directory {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), flags) };
        // SAFETY: `fd` was just opened and nothing else owns it.
        (fd >= 0).then(|| unsafe { fs::File::from_raw_fd(fd) })
    }

    fn child_dir(&self, name: &str) -> Option<Self> {
        self.open_at(name, true).map(Self)
    }

    fn child_dir_meta(&self, name: &str) -> Option<fs::Metadata> {
        self.child_dir(name)?.0.metadata().ok()
    }

    fn open_file(&self, name: &str) -> Option<(fs::File, fs::Metadata)> {
        let file = self.open_at(name, false)?;
        let meta = file.metadata().ok()?;
        meta.is_file().then_some((file, meta))
    }

    /// The folders and regular files in this folder, named, `true` for a
    /// folder. Links and anything else are left out without being followed.
    fn entries(&self) -> Result<Vec<(String, bool)>, FilesError> {
        use std::os::fd::AsRawFd;
        let os_error = || FilesError::Io(std::io::Error::last_os_error().to_string());
        // SAFETY: `fdopendir` takes ownership of a descriptor of its own.
        let fd = unsafe { libc::dup(self.0.as_raw_fd()) };
        if fd < 0 {
            return Err(os_error());
        }
        // SAFETY: `fd` is a directory descriptor this function owns.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = os_error();
            // SAFETY: `fdopendir` failed, so `fd` is still ours to close.
            unsafe { libc::close(fd) };
            return Err(error);
        }
        // SAFETY: `stream` is open; the duplicate shares this folder's offset.
        unsafe { libc::rewinddir(stream) };
        let mut out = Vec::new();
        loop {
            // SAFETY: `stream` is open, and each entry is read before the next call.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            // SAFETY: `readdir` returned a live entry with a NUL-terminated name.
            let (name, kind) = unsafe { (std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()), (*entry).d_type) };
            let Ok(name) = name.to_str() else { continue };
            let is_dir = match kind {
                libc::DT_DIR => true,
                libc::DT_REG => false,
                // A filesystem that does not say: ask, still without following.
                libc::DT_UNKNOWN => match self.kind_of(name) {
                    Some(is_dir) => is_dir,
                    None => continue,
                },
                _ => continue,
            };
            out.push((name.to_owned(), is_dir));
        }
        // SAFETY: `stream` is open and is not used again.
        unsafe { libc::closedir(stream) };
        Ok(out)
    }

    /// Whether `name` is a folder (`Some(true)`) or a regular file, by
    /// `fstatat` without following a link; `None` for anything else.
    fn kind_of(&self, name: &str) -> Option<bool> {
        use std::os::fd::AsRawFd;
        let c_name = std::ffi::CString::new(name).ok()?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: a live directory descriptor, a NUL-terminated name, and room for the result.
        let found = unsafe {
            libc::fstatat(self.0.as_raw_fd(), c_name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
        };
        if found != 0 {
            return None;
        }
        // SAFETY: `fstatat` succeeded and filled it.
        let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
        match mode {
            libc::S_IFDIR => Some(true),
            libc::S_IFREG => Some(false),
            _ => None,
        }
    }
}

#[cfg(windows)]
#[path = "files_windows.rs"]
mod windows;
#[cfg(windows)]
use windows::ProjectDir;

fn child(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") }
}

/// Which of a folder's kept names git ignores, by one hardened `git
/// check-ignore` over all of them — what puts a row in the phone's collapsed
/// "gitignored" section, as on the desktop tree. A tracked file is never
/// ignored (check-ignore reads the index), and a folder counts only when it is
/// ignored itself, not when something inside it is. No repo, no git, or any
/// other failure is no names: a display hint, never a gate.
fn ignored_names(root: &Path, rel: &str, found: &[(bool, String)]) -> HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;
    if found.is_empty() {
        return HashSet::new();
    }
    let mut input = Vec::new();
    for (_, name) in found {
        // `./` first, so a leaf like `:(top)x` is a name, not pathspec magic
        // (which check-ignore refuses outright, failing the whole folder).
        input.extend_from_slice(b"./");
        input.extend_from_slice(child(rel, name).as_bytes());
        input.push(0);
    }
    let Ok(mut git) = crate::commands::git::hardened_git_command_in(root, &["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashSet::new();
    };
    // Fed from a thread: git answers while it reads, so a full pipe either
    // way would stall both ends.
    let feeder = git.stdin.take().map(|mut stdin| std::thread::spawn(move || stdin.write_all(&input)));
    let out = git.wait_with_output();
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    // Exit 0: some are ignored; 1: none; 128: not a repo, or git refused.
    let Ok(out) = out.map_err(drop).and_then(|out| if out.status.success() { Ok(out) } else { Err(()) }) else {
        return HashSet::new();
    };
    let prefix = if rel.is_empty() { "./".to_string() } else { format!("./{rel}/") };
    out.stdout
        .split(|&byte| byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter_map(|path| path.trim_end_matches('/').strip_prefix(prefix.as_str()))
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .map(str::to_owned)
        .collect()
}

/// One folder of the project, folders first, then by name. Links, sockets and
/// the like are not listed; neither are hidden names or names the browser
/// could not resolve again. Only the kept entries are opened to sniff a type.
pub fn list(root: &Path, rel: &str, host_key: &[u8], raw_id: &str) -> Result<Listing, FilesError> {
    let dir = ProjectDir::open(root, rel)?;
    let mut found: Vec<(bool, String)> = dir
        .entries()?
        .into_iter()
        .filter(|(name, _)| valid_segment(name))
        .map(|(name, is_dir)| (is_dir, name))
        .collect();
    found.sort_by(|(a_dir, a), (b_dir, b)| {
        b_dir.cmp(a_dir).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())).then_with(|| a.cmp(b))
    });
    let truncated = found.len() > MAX_ENTRIES;
    found.truncate(MAX_ENTRIES);
    let ignored = ignored_names(root, rel, &found);
    let mut entries = Vec::with_capacity(found.len());
    for (is_dir, name) in found {
        // Swapped for a link or removed since the listing: not listed.
        let (kind, size, meta) = if is_dir {
            let Some(meta) = dir.child_dir_meta(&name) else { continue };
            ("dir", 0, meta)
        } else {
            let Some((file, meta)) = dir.open_file(&name) else { continue };
            let Some((_file, meta, kind)) = outbox::sniff_opened(file, meta) else { continue };
            (kind, meta.len(), meta)
        };
        let modified = meta.modified().map(outbox::unix_secs).unwrap_or(0);
        let created = meta.created().ok().map(outbox::unix_secs).filter(|&secs| secs > 0);
        let ignored = ignored.contains(&name);
        entries.push(Entry { token: seal(host_key, raw_id, &child(rel, &name)), name, kind, size, modified, created, ignored });
    }
    Ok(Listing { entries, truncated })
}

/// One file of the project as its folder's listing would row it, or `None`
/// when it is not a regular file reached with no link on the way (or names
/// something the browser hides). What the phone needs to open a file it was
/// not browsing to — the Focus banner of an agent's markup question.
pub fn entry(root: &Path, rel: &str, host_key: &[u8], raw_id: &str) -> Option<Entry> {
    if rel.is_empty() || !valid_rel(rel) {
        return None;
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let dir = ProjectDir::open(root, parent).ok()?;
    let (file, meta) = dir.open_file(name)?;
    let (_file, meta, kind) = outbox::sniff_opened(file, meta)?;
    let modified = meta.modified().map(outbox::unix_secs).unwrap_or(0);
    let created = meta.created().ok().map(outbox::unix_secs).filter(|&secs| secs > 0);
    Some(Entry { token: seal(host_key, raw_id, rel), name: name.to_string(), kind, size: meta.len(), modified, created, ignored: false })
}

/// One file's bytes and media type. Text longer than `MAX_OUTBOX_FILE` is
/// answered with its head — a long log is still worth its first pages; any
/// other kind that large is `TooLarge`.
pub fn read(root: &Path, rel: &str) -> Result<(Vec<u8>, &'static str), FilesError> {
    if rel.is_empty() || !valid_rel(rel) {
        return Err(FilesError::NotFound);
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let dir = ProjectDir::open(root, parent)?;
    let Some((mut file, meta, kind)) = dir.open_file(name).and_then(|(file, meta)| outbox::sniff_opened(file, meta)) else {
        return Err(FilesError::NotFound);
    };
    if meta.len() > MAX_OUTBOX_FILE && !kind.starts_with("text/") {
        return Err(FilesError::TooLarge);
    }
    // Keep the descriptor just proven: never reopen a replaceable leaf.
    file.rewind().map_err(|e| FilesError::Io(e.to_string()))?;
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_OUTBOX_FILE) as usize);
    file.take(MAX_OUTBOX_FILE)
        .read_to_end(&mut bytes)
        .map_err(|e| FilesError::Io(e.to_string()))?;
    Ok((bytes, kind))
}

/// Whether `rel` names a regular file of the project, reached from the root
/// one checked name at a time with no link on the way — what [`read`] would
/// open, without reading it.
pub fn exists(root: &Path, rel: &str) -> bool {
    if rel.is_empty() || !valid_rel(rel) {
        return false;
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    ProjectDir::open(root, parent).ok().and_then(|dir| dir.open_file(name)).is_some()
}

/// The most hits one search answers; `truncated` says there were more.
pub const MAX_HITS: usize = 200;
/// The longest query a search takes, in bytes — the project list's bound.
pub const MAX_QUERY: usize = 80;
/// How many paths a search weighs before it stops and says `truncated`: a
/// walk of a tree git does not list has to end somewhere.
const MAX_SCANNED: usize = 50_000;
/// How much of `git ls-files` a search reads.
const MAX_LISTING_BYTES: u64 = 16 * 1024 * 1024;

/// One folder on a hit's way down from the project root, as the drawer's
/// trail holds it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Crumb {
    pub token: String,
    pub name: String,
}

/// A file or folder whose name matched: its row as its folder's listing would
/// give it, and the folders above it, so the drawer can stand where it is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Hit {
    #[serde(flatten)]
    pub entry: Entry,
    /// From the root's first folder down to the hit's own; empty at the root.
    pub trail: Vec<Crumb>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Found {
    pub hits: Vec<Hit>,
    pub truncated: bool,
}

/// How well a leaf matches the query's words, lower is better, or `None`
/// when some word is not in it: the whole name (or the name before its
/// extension), then a name starting with the first word, then anywhere.
fn rank(name: &str, words: &[String]) -> Option<u8> {
    let lower = name.to_lowercase();
    if !words.iter().all(|word| lower.contains(word.as_str())) {
        return None;
    }
    let whole = words.join(" ");
    let stem = lower.rsplit_once('.').map_or(lower.as_str(), |(stem, _)| stem);
    Some(if lower == whole || stem == whole {
        0
    } else if lower.starts_with(words[0].as_str()) {
        1
    } else {
        2
    })
}

/// What git lists under the root — tracked files and untracked ones it does
/// not ignore — as project-relative paths, or `None` when the root is not in
/// a repo, git fails, or lists nothing. The `bool` is whether the listing
/// was cut at [`MAX_LISTING_BYTES`].
fn git_paths(root: &Path) -> Option<(Vec<String>, bool)> {
    use std::process::Stdio;
    let mut git = crate::commands::git::hardened_git_command_in(
        root,
        &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    )
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
    let mut out = Vec::new();
    let read = git.stdout.take()?.take(MAX_LISTING_BYTES).read_to_end(&mut out);
    let cut = out.len() as u64 >= MAX_LISTING_BYTES;
    if cut {
        let _ = git.kill();
    }
    let status = git.wait().ok()?;
    if read.is_err() || (!cut && !status.success()) {
        return None;
    }
    let mut paths: Vec<String> = out
        .split(|&byte| byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    // A cut listing ends mid-path.
    if cut {
        paths.pop();
    }
    (!paths.is_empty()).then_some((paths, cut))
}

/// Every folder and file below the root, breadth first, the way the drawer
/// would list them (no links, no hidden names), until [`MAX_SCANNED`]. The
/// `bool` is whether it stopped there.
fn walked_paths(root: &Path) -> Result<(Vec<(String, bool)>, bool), FilesError> {
    let mut found = Vec::new();
    let mut folders = std::collections::VecDeque::from([String::new()]);
    while let Some(rel) = folders.pop_front() {
        // Gone or swapped for a link since its parent was read: left out.
        let Ok(dir) = ProjectDir::open(root, &rel) else { continue };
        for (name, is_dir) in dir.entries()? {
            if !valid_segment(&name) {
                continue;
            }
            if found.len() >= MAX_SCANNED {
                return Ok((found, true));
            }
            let path = child(&rel, &name);
            if is_dir {
                folders.push_back(path.clone());
            }
            found.push((path, is_dir));
        }
    }
    Ok((found, false))
}

/// A folder of the project as its parent's listing would row it.
fn dir_entry(root: &Path, rel: &str, host_key: &[u8], raw_id: &str) -> Option<Entry> {
    if rel.is_empty() || !valid_rel(rel) {
        return None;
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let meta = ProjectDir::open(root, parent).ok()?.child_dir_meta(name)?;
    let modified = meta.modified().map(outbox::unix_secs).unwrap_or(0);
    let created = meta.created().ok().map(outbox::unix_secs).filter(|&secs| secs > 0);
    Some(Entry { token: seal(host_key, raw_id, rel), name: name.to_string(), kind: "dir", size: 0, modified, created, ignored: false })
}

/// The project's files and folders whose names hold every word of `query`
/// (any case), best match first, then the shallower, then by path. In a git
/// repo the names come from git — what it ignores (`target/`,
/// `node_modules/`) is not searched — and anywhere else from a bounded walk.
/// Each hit is proven again as [`entry`] proves a file, so a path git names
/// through a link, or one that is hidden, is never answered.
pub fn search(root: &Path, query: &str, host_key: &[u8], raw_id: &str) -> Result<Found, FilesError> {
    canonical_root(root)?;
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Found { hits: Vec::new(), truncated: false });
    }
    let (candidates, mut truncated) = match git_paths(root) {
        Some((paths, cut)) => {
            let mut seen = HashSet::new();
            let mut candidates = Vec::new();
            for path in paths {
                if !valid_rel(&path) {
                    continue;
                }
                // The folders on the way are candidates too, each once.
                let mut end = 0;
                while let Some(slash) = path[end..].find('/') {
                    end += slash;
                    if seen.insert(path[..end].to_string()) {
                        candidates.push((path[..end].to_string(), true));
                    }
                    end += 1;
                }
                candidates.push((path, false));
            }
            (candidates, cut)
        }
        None => walked_paths(root)?,
    };
    let mut matched: Vec<(u8, usize, String, bool)> = candidates
        .into_iter()
        .filter_map(|(rel, is_dir)| {
            let leaf = rel.rsplit('/').next().unwrap_or(&rel);
            let score = rank(leaf, &words)?;
            Some((score, rel.matches('/').count(), rel, is_dir))
        })
        .collect();
    matched.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then_with(|| a.2.to_lowercase().cmp(&b.2.to_lowercase())));
    let mut hits = Vec::new();
    for (_, _, rel, is_dir) in matched {
        if hits.len() == MAX_HITS {
            truncated = true;
            break;
        }
        let proven = if is_dir { dir_entry(root, &rel, host_key, raw_id) } else { entry(root, &rel, host_key, raw_id) };
        let Some(entry) = proven else { continue };
        let mut trail = Vec::new();
        let mut end = 0;
        while let Some(slash) = rel[end..].find('/') {
            let start = end;
            end += slash;
            trail.push(Crumb { token: seal(host_key, raw_id, &rel[..end]), name: rel[start..end].to_string() });
            end += 1;
        }
        hits.push(Hit { entry, trail });
    }
    Ok(Found { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"host-key-for-tests-0123456789abcdef";

    /// A token sealed by an older build's host still opens after a rename
    /// (and is counted); one sealed now opens without a second try; a token
    /// for another project opens under neither salt.
    #[test]
    fn a_token_sealed_under_the_old_salt_still_opens() {
        use crate::brand::Name;
        use crate::services::brand_migration::{hits, testing::RENAMED};
        let _ = hits::taken();
        let old = seal_with(&crate::brand::LEGACY.name(Name::MOBILE_FILES_SALT), KEY, "p1", "docs/a.pdf");
        assert_eq!(unseal_for(&RENAMED, KEY, "p1", &old).as_deref(), Some("docs/a.pdf"));
        assert_eq!(hits::taken(), ["mobile-files-salt"]);
        let new = seal_with(&RENAMED.cur(Name::MOBILE_FILES_SALT), KEY, "p1", "docs/a.pdf");
        assert_eq!(unseal_for(&RENAMED, KEY, "p1", &new).as_deref(), Some("docs/a.pdf"));
        assert_eq!(unseal_for(&RENAMED, KEY, "p2", &old), None);
        assert!(hits::taken().is_empty());
        // The production pair: what `seal` writes, `unseal` reads.
        assert_eq!(unseal(KEY, "p1", &seal(KEY, "p1", "x/y.txt")).as_deref(), Some("x/y.txt"));
    }
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body";

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join(concat!(".", crate::app_slug!(), "/outbox"))).unwrap();
        fs::write(root.join("README.md"), "# Hello\n").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("plot.png"), PNG).unwrap();
        fs::write(root.join(".env.local"), "HIDDEN=1").unwrap();
        fs::write(root.join(".gitignore"), "target\n").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("src/deep/notes.txt"), "deep").unwrap();
        dir
    }

    fn names(listing: &Listing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn rel_of(entry: &Entry, raw_id: &str) -> String {
        unseal(KEY, raw_id, &entry.token).expect("a listed token opens")
    }

    #[test]
    fn a_token_opens_only_for_its_own_project_and_host() {
        let token = seal(KEY, "p1", "src/main.rs");
        assert_eq!(unseal(KEY, "p1", &token).as_deref(), Some("src/main.rs"));
        assert_eq!(unseal(KEY, "p2", &token), None, "replayed against another project");
        assert_eq!(unseal(b"another-host-key", "p1", &token), None);
        assert!(!token.contains("main"), "the path is not readable in the token");
        assert_ne!(seal(KEY, "p1", "src/main.rs"), token, "a fresh nonce per seal");
        let mut forged = Base64UrlUnpadded::decode_vec(&token).unwrap();
        *forged.last_mut().unwrap() ^= 1;
        assert_eq!(unseal(KEY, "p1", &Base64UrlUnpadded::encode_string(&forged)), None);
        assert_eq!(unseal(KEY, "p1", "not a token"), None);
        assert_eq!(unseal(KEY, "p1", ""), None);
        // A sealed path the browser would not resolve does not open either.
        for bad in ["../etc", "a/../b", "/abs", ".git/config", "src/.env", "a//b"] {
            assert_eq!(unseal(KEY, "p1", &seal(KEY, "p1", bad)), None, "{bad}");
        }
        assert_eq!(unseal(KEY, "p1", &seal(KEY, "p1", "")).as_deref(), Some(""));
    }

    #[test]
    fn the_root_lists_folders_first_and_hides_the_courtesy_names() {
        let dir = tree();
        let listing = list(dir.path(), "", KEY, "p1").unwrap();
        assert_eq!(names(&listing), ["src", ".gitignore", "b.txt", "plot.png", "README.md"]);
        assert!(!listing.truncated);
        let src = &listing.entries[0];
        assert_eq!((src.kind, src.size), ("dir", 0));
        assert_eq!(rel_of(src, "p1"), "src");
        let png = listing.entries.iter().find(|e| e.name == "plot.png").unwrap();
        assert_eq!((png.kind, png.size), ("image/png", PNG.len() as u64));
        let readme = listing.entries.iter().find(|e| e.name == "README.md").unwrap();
        assert_eq!(readme.kind, "text/plain; charset=utf-8");

        let nested = list(dir.path(), "src", KEY, "p1").unwrap();
        assert_eq!(names(&nested), ["deep", "main.rs"]);
        assert_eq!(rel_of(&nested.entries[1], "p1"), "src/main.rs");
        assert_eq!(names(&list(dir.path(), "src/deep", KEY, "p1").unwrap()), ["notes.txt"]);
    }

    #[test]
    fn reads_answer_listed_files_and_nothing_else() {
        let dir = tree();
        assert_eq!(read(dir.path(), "src/main.rs").unwrap(), (b"fn main() {}\n".to_vec(), "text/plain; charset=utf-8"));
        assert_eq!(read(dir.path(), "plot.png").unwrap().1, "image/png");
        for refused in ["", "src", "missing.txt", ".env.local", ".git", concat!(".", crate::app_slug!(), "/outbox"), "../x", "src/../b.txt"] {
            assert!(read(dir.path(), refused).is_err(), "{refused}");
        }
        assert_eq!(list(dir.path(), "README.md", KEY, "p1"), Err(FilesError::NotFound));
        assert_eq!(list(dir.path(), ".git", KEY, "p1"), Err(FilesError::NotFound));
        assert_eq!(list(&dir.path().join("gone"), "", KEY, "p1"), Err(FilesError::Unavailable));
    }

    #[test]
    fn rows_git_ignores_are_marked_and_tracked_ones_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git").args(args).current_dir(root).output().unwrap().status;
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("run.log"), "x").unwrap();
        fs::write(root.join("kept.log"), "x").unwrap();
        fs::write(root.join(":(top)odd.log"), "x").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("src/trace.log"), "x").unwrap();
        git(&["add", "-f", "kept.log"]);
        let ignored = |listing: &Listing| -> Vec<String> {
            listing.entries.iter().filter(|e| e.ignored).map(|e| e.name.clone()).collect()
        };
        let top = list(root, "", KEY, "p1").unwrap();
        assert_eq!(ignored(&top), ["target", ":(top)odd.log", "run.log"], "a tracked match is not ignored");
        // `src` holds an ignored file but is not ignored itself.
        assert!(!top.entries.iter().find(|e| e.name == "src").unwrap().ignored);
        assert_eq!(ignored(&list(root, "src", KEY, "p1").unwrap()), ["trace.log"]);
        let json = serde_json::to_value(top.entries.iter().find(|e| e.name == "target").unwrap()).unwrap();
        assert_eq!(json["ignored"], true);
        let plain = top.entries.iter().find(|e| e.name == "src").unwrap();
        assert!(serde_json::to_value(plain).unwrap().get("ignored").is_none(), "false is left out");
    }

    #[test]
    fn outside_a_repo_nothing_is_ignored() {
        let dir = tree();
        assert!(list(dir.path(), "", KEY, "p1").unwrap().entries.iter().all(|e| !e.ignored));
    }

    #[test]
    fn a_long_folder_is_capped_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_ENTRIES + 3) {
            fs::write(dir.path().join(format!("f{i:04}.txt")), "x").unwrap();
        }
        let listing = list(dir.path(), "", KEY, "p1").unwrap();
        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert!(listing.truncated);
        assert_eq!(listing.entries[0].name, "f0000.txt");
    }

    #[test]
    fn a_huge_text_answers_its_head_and_a_huge_binary_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("big.log");
        fs::write(&text, "line\n".repeat(2_000)).unwrap();
        fs::File::options().write(true).open(&text).unwrap().set_len(MAX_OUTBOX_FILE + 10).unwrap();
        // The sparse tail is NULs, but the kind is read from the (text) head.
        let (bytes, kind) = read(dir.path(), "big.log").unwrap();
        assert_eq!((bytes.len() as u64, kind), (MAX_OUTBOX_FILE, "text/plain; charset=utf-8"));

        let png = dir.path().join("huge.png");
        fs::write(&png, PNG).unwrap();
        fs::File::options().write(true).open(&png).unwrap().set_len(MAX_OUTBOX_FILE + 1).unwrap();
        assert_eq!(read(dir.path(), "huge.png"), Err(FilesError::TooLarge));
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_listed_and_a_path_through_one_does_not_resolve() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("leak.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("away")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("src"), dir.path().join("alias")).unwrap();

        let listing = list(dir.path(), "", KEY, "p1").unwrap();
        for link in ["leak.txt", "away", "alias"] {
            assert!(!names(&listing).contains(&link), "{link} listed");
        }
        assert_eq!(read(dir.path(), "leak.txt"), Err(FilesError::NotFound));
        assert_eq!(read(dir.path(), "away/secret.txt"), Err(FilesError::NotFound));
        // Inside the project is no better: the path must be the real one.
        assert_eq!(read(dir.path(), "alias/main.rs"), Err(FilesError::NotFound));
        assert_eq!(list(dir.path(), "away", KEY, "p1"), Err(FilesError::NotFound));

        // A folder the phone listed, swapped for a link afterwards.
        let src_token = listing.entries.iter().find(|e| e.name == "src").unwrap();
        let rel = rel_of(src_token, "p1");
        fs::rename(dir.path().join("src"), dir.path().join("src-moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("src")).unwrap();
        assert_eq!(list(dir.path(), &rel, KEY, "p1"), Err(FilesError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_mid_walk_never_hands_out_the_links_target() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("main.rs"), "private").unwrap();
        fs::write(outside.path().join("leak.txt"), "private").unwrap();

        // The walk has reached `src` when it is swapped for a link: the rest of
        // the request goes on from the folder it holds, not from the path.
        let held = ProjectDir::open(dir.path(), "src").unwrap();
        fs::rename(dir.path().join("src"), dir.path().join("src-moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("src")).unwrap();

        let (mut file, _) = held.open_file("main.rs").unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "fn main() {}\n");
        let names: Vec<String> = held.entries().unwrap().into_iter().map(|(name, _)| name).collect();
        assert!(names.contains(&"deep".to_string()) && !names.contains(&"leak.txt".to_string()));
        assert!(held.child_dir_meta("deep").is_some());
        // And a fresh request stops at the link.
        assert_eq!(read(dir.path(), "src/main.rs"), Err(FilesError::NotFound));
    }

    // Junctions need neither Administrator rights nor Developer Mode. These
    // tests run on Windows CI and must fail if creating the fixture fails.
    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .arg("/D")
            .raw_arg(format!("/C mklink /J \"{}\" \"{}\"", link.display(), target.display()))
            .output()
            .unwrap();
        assert!(output.status.success(), "mklink: {}", String::from_utf8_lossy(&output.stderr));
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_not_listed_or_traversed_even_when_they_point_inside() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "private").unwrap();
        junction(outside.path(), &dir.path().join("away"));
        junction(&dir.path().join("src"), &dir.path().join("alias"));
        junction(outside.path(), &dir.path().join("src/deep/escape"));

        let listing = list(dir.path(), "", KEY, "p1").unwrap();
        assert!(!names(&listing).contains(&"away"));
        assert!(!names(&listing).contains(&"alias"));
        assert!(!names(&list(dir.path(), "src/deep", KEY, "p1").unwrap()).contains(&"escape"));
        for path in ["away/secret.txt", "alias/main.rs", "src/deep/escape/secret.txt", "away"] {
            assert_eq!(read(dir.path(), path), Err(FilesError::NotFound), "{path}");
        }
        assert_eq!(list(dir.path(), "away", KEY, "p1"), Err(FilesError::NotFound));
        assert_eq!(list(dir.path(), "alias", KEY, "p1"), Err(FilesError::NotFound));
    }

    #[cfg(windows)]
    #[test]
    fn handle_enumeration_continues_across_batches_and_restarts() {
        let dir = tempfile::tempdir().unwrap();
        // These native directory records total more than the 64 KiB buffer.
        let count = 800;
        for i in 0..count {
            fs::write(dir.path().join(format!("entry-{i:04}-{}", "x".repeat(100))), "ok").unwrap();
        }
        let held = ProjectDir::open(dir.path(), "").unwrap();
        for _ in 0..2 {
            let entries = held.entries().unwrap();
            assert_eq!(entries.len(), count);
            assert_eq!(entries.iter().map(|(name, _)| name).collect::<std::collections::HashSet<_>>().len(), count);
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_concurrent_parent_junction_replacement_cannot_redirect_a_held_walk() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("deep")).unwrap();
        fs::write(outside.path().join("main.rs"), "private").unwrap();
        fs::write(outside.path().join("leak.txt"), "private").unwrap();
        fs::write(outside.path().join("deep/notes.txt"), "private").unwrap();

        // Precisely schedule the attacker between acquiring the parent and
        // opening/listing its children: the original path implementation
        // would leak both the file bytes and the outside listing here.
        let held = ProjectDir::open(dir.path(), "src").unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                fs::rename(dir.path().join("src"), dir.path().join("src-moved")).unwrap();
                junction(outside.path(), &dir.path().join("src"));
            }).join().unwrap();

            let (mut file, _) = held.open_file("main.rs").unwrap();
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            assert_eq!(text, "fn main() {}\n");
            let entries = held.entries().unwrap();
            assert!(entries.iter().any(|(name, _)| name == "deep"));
            assert!(!entries.iter().any(|(name, _)| name == "leak.txt"));
            assert!(held.child_dir_meta("deep").is_some());
            // A second step of a walk also uses the held parent handle.
            let deep = held.child_dir("deep").unwrap();
            let (mut file, _) = deep.open_file("notes.txt").unwrap();
            text.clear();
            file.read_to_string(&mut text).unwrap();
            assert_eq!(text, "deep");
        });
        assert_eq!(read(dir.path(), "src/main.rs"), Err(FilesError::NotFound));
        assert_eq!(list(dir.path(), "src", KEY, "p1"), Err(FilesError::NotFound));
    }

    fn hit_paths(found: &Found) -> Vec<String> {
        found.hits.iter().map(|hit| rel_of(&hit.entry, "p1")).collect()
    }

    #[test]
    fn a_search_outside_a_repo_walks_and_ranks_the_closest_names_first() {
        let dir = tree();
        fs::write(dir.path().join("src/deep/main_notes.md"), "x").unwrap();
        let found = search(dir.path(), "MAIN", KEY, "p1").unwrap();
        assert_eq!(hit_paths(&found), ["src/main.rs", "src/deep/main_notes.md"], "the stem match first");
        assert!(!found.truncated);
        let main = &found.hits[0];
        assert_eq!((main.entry.name.as_str(), main.entry.kind), ("main.rs", "text/plain; charset=utf-8"));
        let trail: Vec<(&str, String)> = main.trail.iter().map(|crumb| (crumb.name.as_str(), unseal(KEY, "p1", &crumb.token).unwrap())).collect();
        assert_eq!(trail, [("src", "src".to_string())]);
        let deep = search(dir.path(), "notes deep", KEY, "p1").unwrap();
        assert!(deep.hits.is_empty(), "every word must be in the name itself");
        let folder = search(dir.path(), "dee", KEY, "p1").unwrap();
        assert_eq!(hit_paths(&folder), ["src/deep"]);
        assert_eq!(folder.hits[0].entry.kind, "dir");
        assert_eq!(folder.hits[0].trail.iter().map(|crumb| crumb.name.as_str()).collect::<Vec<_>>(), ["src"]);
        for hidden in ["env", "outbox", "config"] {
            assert!(search(dir.path(), hidden, KEY, "p1").unwrap().hits.is_empty(), "{hidden}");
        }
        assert!(search(dir.path(), "  ", KEY, "p1").unwrap().hits.is_empty());
        assert_eq!(search(&dir.path().join("gone"), "x", KEY, "p1"), Err(FilesError::Unavailable));
    }

    #[test]
    fn a_search_in_a_repo_skips_what_git_ignores_and_finds_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git").args(args).current_dir(root).output().unwrap().status;
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::create_dir_all(root.join("target/report")).unwrap();
        fs::create_dir_all(root.join("docs/report")).unwrap();
        fs::write(root.join("target/report/report.txt"), "x").unwrap();
        fs::write(root.join("docs/report/report.txt"), "x").unwrap();
        fs::write(root.join("report.md"), "x").unwrap();
        git(&["add", "report.md"]);
        let found = search(root, "report", KEY, "p1").unwrap();
        assert_eq!(hit_paths(&found), ["report.md", "docs/report", "docs/report/report.txt"], "target/ is ignored");
        // A project folder below the repo's top searches only itself.
        let docs = search(&root.join("docs"), "report", KEY, "p1").unwrap();
        assert_eq!(hit_paths(&docs), ["report", "report/report.txt"]);
    }

    #[test]
    fn a_search_answers_at_most_max_hits_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_HITS + 2) {
            fs::write(dir.path().join(format!("hit{i:04}.txt")), "x").unwrap();
        }
        let found = search(dir.path(), "hit", KEY, "p1").unwrap();
        assert_eq!(found.hits.len(), MAX_HITS);
        assert!(found.truncated);
        assert_eq!(found.hits[0].entry.name, "hit0000.txt");
    }

    #[cfg(unix)]
    #[test]
    fn a_search_never_answers_through_a_link() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("away")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("secret-link.txt")).unwrap();
        assert!(search(dir.path(), "secret", KEY, "p1").unwrap().hits.is_empty());
        assert!(search(dir.path(), "away", KEY, "p1").unwrap().hits.is_empty());
        // Nor when git names the link: it tracks a link as a path of its own.
        let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        assert!(search(dir.path(), "secret", KEY, "p1").unwrap().hits.is_empty());
        assert!(search(dir.path(), "away", KEY, "p1").unwrap().hits.is_empty());
    }

    #[test]
    fn the_switch_is_off_unless_the_settings_turn_it_on() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!files_open(dir.path()));
        let write = |value: Value| fs::write(dir.path().join("settings.json"), value.to_string()).unwrap();
        write(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true } }));
        assert!(!files_open(dir.path()));
        write(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }));
        assert!(files_open(dir.path()));
        fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        assert!(!files_open(dir.path()));
    }
}
